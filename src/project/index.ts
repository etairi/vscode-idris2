/**
 * The project index (`project/index.ts` in docs/ARCHITECTURE.md §2, §3.2; ROADMAP M1): which
 * `.ipkg` governs a file, what the compiler makes of that `.ipkg`, and how module names map to
 * paths. The contract is `ProjectIndex` in `project/types.ts`; this module has no runtime
 * dependency on `vscode` (`extension.ts` adapts the workspace to `ProjectWorkspace`).
 *
 * - `classify` walks up from the file's directory to the file-system root (`findIpkg`, F13), not
 *   stopping at the workspace folder: the compiler finds a package file above the folder too.
 * - Models are read with `idris2 --dump-ipkg-json` when the workspace is trusted, the current
 *   toolchain snapshot has a probed `idris2` and the `.ipkg` lies inside a workspace folder,
 *   otherwise with the fallback reader (`readIpkgModel`). A model is read when `classify` or
 *   `roots` needs it, not when the workspace is scanned.
 * - Walks and models are cached, keyed by directory (lower-cased on Windows, whose file
 *   systems compare names case-insensitively, so that `c:\p` and `C:\P` share one root). A
 *   created or deleted `.ipkg` in a workspace folder drops the models of its directory and every
 *   walk; a changed one only the models of its directory (a walk looks at names only); a change
 *   of the workspace folders drops every model (which ones lie inside changes); a new toolchain
 *   snapshot (a rescan, a settings change, trust being granted) drops everything, which is also
 *   when a package file above the workspace folders is read again.
 * - Any other path created or deleted in a workspace folder is gathered for a short pause, so
 *   that a burst is one change (`pathsChanged`). A folder that is deleted, moved or restored is
 *   often reported alone, without the files it holds (`ProjectWorkspace.onDidCreateOrDeletePath`),
 *   so the index decides from the paths and from what is there now, not from events per file.
 * Each of these fires `onDidChange`, and so does a change of the package files `roots()` lists.
 */
import * as path from 'path';
import { DisposableStore } from '../core/disposable';
import { Emitter } from '../core/event';
import {
  findIpkg,
  ipkgCandidates,
  listDirectoryInOsOrder,
  readIpkgModel,
  type DirectoryLister,
  type IpkgCandidates,
  type IpkgCompiler,
} from './ipkg';
import { MODULE_SOURCE_EXTENSIONS, isIdrisSourceFileName, isIdrisSpace, splitFileExtensions } from './literate';
import type { Classification, IpkgModel, ProjectIndex, ProjectIndexDeps, ProjectRoot } from './types';

/**
 * Creates the index; `extension.ts` passes the real dependencies. `listDirectory` is the
 * directory listing the walk uses; tests replace it to simulate a file system up to its root.
 */
export function createProjectIndex(
  deps: ProjectIndexDeps,
  listDirectory: DirectoryLister = listDirectoryInOsOrder,
): ProjectIndex {
  return new CachingProjectIndex(deps, listDirectory);
}

/**
 * How many times `classify` recomputes a result that an invalidation overtook before it returns
 * the last one anyway; `onDidChange` has fired for the invalidation, so callers ask again.
 */
const CLASSIFY_ATTEMPTS = 3;

/** How long created and deleted paths are gathered before the caches are updated. */
const PATH_PAUSE_MS = 250;

/** The key a directory is cached under: lower-cased on Windows (see the module comment). */
function cacheKey(dir: string): string {
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}

/** Whether `file` lies below `folder` (both absolute). */
function isInside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Whether `file` is `dir` or lies below it (both absolute), compared as `cacheKey` compares. */
function isAtOrBelow(dir: string, file: string): boolean {
  const [d, f] = [cacheKey(dir), cacheKey(file)];
  return d === f || isInside(d, f);
}

/** Whether a file of this name can be a module's source: it ends with a `MODULE_SOURCE_EXTENSIONS` entry. */
function isModuleSourceName(baseName: string): boolean {
  return MODULE_SOURCE_EXTENSIONS.some((ext) => baseName.length > ext.length && baseName.endsWith(ext));
}

/**
 * Whether deleting `removed` can take away the source of a module the compiler resolved for
 * `model` (every listed module and `main`: `addFields` runs `nsToSource` on both,
 * `src/Idris/Package.idr` 268–281 on v0.8.0 [src]): `removed` is the source directory or lies
 * above it, or it lies below it on the way to a module's candidate — a directory `Foo` or
 * `Foo/A`, or a file `Foo/A.idr`, `Foo/A.md`, … for `Foo.A`.
 */
function mayRemoveModuleSource(model: IpkgModel, sourceDir: string, removed: string): boolean {
  if (isAtOrBelow(removed, sourceDir)) {
    return true;
  }
  if (!isInside(cacheKey(sourceDir), cacheKey(removed))) {
    return false;
  }
  const segments = path.relative(cacheKey(sourceDir), cacheKey(removed)).split(path.sep);
  const last = segments.length - 1;
  return [...model.modules, ...(model.main === undefined ? [] : [model.main])].some((module) => {
    const parts = cacheKey(module).split('.');
    if (segments.length > parts.length || segments.slice(0, last).some((segment, i) => segment !== parts[i])) {
      return false;
    }
    const part = parts[last];
    return segments[last] === part || (last === parts.length - 1 && MODULE_SOURCE_EXTENSIONS.some((ext) => segments[last] === part + ext));
  });
}

/** A cached root: its read, and its value once the read has finished. */
interface RootEntry {
  readonly read: Promise<ProjectRoot>;
  value?: ProjectRoot;
}

class CachingProjectIndex implements ProjectIndex {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions = new DisposableStore();
  /** Walk results by start directory (`cacheKey`). */
  private readonly walks = new Map<string, Promise<IpkgCandidates | undefined>>();
  /** Project roots by the directory of their package file (`cacheKey`). */
  private readonly rootsByDir = new Map<string, RootEntry>();
  /** Incremented by every invalidation, so that a result computed across one is recomputed. */
  private epoch = 0;
  /** The package files inside the workspace folders, one entry per directory, by path. */
  private listed: readonly IpkgCandidates[] = [];
  /** The latest `refreshListing`, which `roots()` waits for. */
  private listing: Promise<void> = Promise.resolve();
  /** Incremented by every `refreshListing`; only the latest one sets `listed`. */
  private refreshes = 0;
  /** The toolchain snapshot the cached models were read with. */
  private generation: number | undefined;
  /** Paths created or deleted since the last `pathsChanged`. */
  private readonly changedPaths = new Set<string>();
  private pathTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly deps: ProjectIndexDeps,
    private readonly listDirectory: DirectoryLister,
  ) {
    this.generation = deps.toolchain.current?.generation;
    this.subscriptions.add(deps.workspace.onDidCreateOrDeleteIpkgFile((file) => this.ipkgFileCreatedOrDeleted(file)));
    this.subscriptions.add(deps.workspace.onDidChangeIpkgFile((file) => this.ipkgFileChanged(file)));
    this.subscriptions.add(deps.workspace.onDidChangeFolders(() => this.foldersChanged()));
    this.subscriptions.add(deps.toolchain.onDidChange(() => this.toolchainChanged()));
    this.subscriptions.add(deps.workspace.onDidCreateOrDeletePath((file) => this.pathCreatedOrDeleted(file)));
    this.refreshListing();
  }

  async classify(filePath: string): Promise<Classification> {
    const startDir = path.dirname(path.resolve(filePath));
    let result: Classification = { kind: 'loose', dir: startDir };
    for (let attempt = 0; attempt < CLASSIFY_ATTEMPTS; attempt++) {
      const epoch = this.epoch;
      const found = await this.walk(startDir);
      result = found === undefined ? { kind: 'loose', dir: startDir } : await this.root(found);
      if (epoch === this.epoch) {
        break;
      }
    }
    return result;
  }

  async roots(): Promise<readonly ProjectRoot[]> {
    await this.listing;
    return Promise.all(this.listed.map((candidates) => this.root(candidates)));
  }

  pathToModule(classification: Classification, filePath: string): string | undefined {
    const sourceDir = sourceDirOf(classification);
    if (sourceDir === undefined || !isIdrisSourceFileName(path.basename(filePath))) {
      return undefined;
    }
    const relative = path.relative(sourceDir, path.resolve(filePath));
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    // `mbPathToNS` (src/Core/Directory.idr 225–234 on v0.8.0): the path relative to the source
    // directory with *all* extensions of the file name dropped (`dropExtensions`), its
    // components joined by `.` — `Foo/B.idr.md` is module `Foo.B`. The compiler splits the path
    // with its own parser, for which `\`, `:` and `?` are punctuation on every platform and
    // components of white space are dropped (`project/ipkg.ts`, *The compiler's path parser*); a
    // POSIX name that has one (`A\B.idr`, which it reads as `A.B`) is not modelled and gets none.
    const parts = relative.split(path.sep);
    if (parts.some((part) => /[\\:?]/.test(part) || Array.from(part).every(isIdrisSpace))) {
      return undefined;
    }
    parts[parts.length - 1] = splitFileExtensions(parts[parts.length - 1]).stem;
    return parts.join('.');
  }

  moduleToPaths(classification: Classification, moduleName: string): readonly string[] {
    const sourceDir = sourceDirOf(classification);
    const parts = moduleName.split('.');
    if (sourceDir === undefined || parts.some((part) => part === '')) {
      return [];
    }
    // `nsToSource`: `<sourcedir>/<A/B>` followed by each suffix in the order the compiler tries them.
    const base = path.join(sourceDir, ...parts);
    return MODULE_SOURCE_EXTENSIONS.map((ext) => base + ext);
  }

  sessionCwd(classification: Classification): string {
    return classification.dir;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.pathTimer);
    this.subscriptions.dispose();
    this.changed.dispose();
  }

  private walk(startDir: string): Promise<IpkgCandidates | undefined> {
    const key = cacheKey(startDir);
    let walk = this.walks.get(key);
    if (walk === undefined) {
      walk = findIpkg(startDir, this.listDirectory);
      this.walks.set(key, walk);
    }
    return walk;
  }

  private root(candidates: IpkgCandidates): Promise<ProjectRoot> {
    const key = cacheKey(candidates.dir);
    let entry = this.rootsByDir.get(key);
    if (entry === undefined) {
      // The read starts after the entry is stored, so an invalidation that happens during any
      // part of it removes this entry.
      const read = Promise.resolve().then(() => this.readRoot(candidates));
      const stored: RootEntry = { read };
      read.then(
        (root) => {
          stored.value = root;
        },
        () => undefined, // `readRoot` does not reject; the caller of `root` sees it if it does
      );
      entry = stored;
      this.rootsByDir.set(key, entry);
    }
    return entry.read;
  }

  private async readRoot({ dir, ipkgPath, otherIpkgs }: IpkgCandidates): Promise<ProjectRoot> {
    if (otherIpkgs.length > 0) {
      this.deps.log.warn(
        `${dir} holds several .ipkg files; idris2 reads ${path.basename(ipkgPath)}, the first one the ` +
          `file system lists, and ignores ${otherIpkgs.map((p) => path.basename(p)).join(', ')} (F10).`,
      );
    }
    const insideWorkspace = this.deps.workspace.folders().some((folder) => isInside(folder, ipkgPath));
    const model = await readIpkgModel(ipkgPath, insideWorkspace ? this.compiler() : undefined, this.deps.log);
    this.deps.log.debug(
      `${ipkgPath}: ${model.status === 'ok' ? 'read' : 'not readable'} (${model.source}` +
        `${insideWorkspace ? '' : '; outside the workspace folders, so not by the compiler'})`,
    );
    return { kind: 'project', ipkgPath, dir, otherIpkgs, insideWorkspace, model };
  }

  /**
   * The compiler to read models with: only a probed `idris2`, only in a trusted workspace, and
   * with the environment it was probed with (the snapshot's settings, not the current ones: a
   * changed `idris2.toolchain.env` reaches the models with the snapshot of the rescan it causes,
   * which drops them).
   */
  private compiler(): IpkgCompiler | undefined {
    const snapshot = this.deps.toolchain.current;
    const idris2 = snapshot?.idris2;
    if (this.disposed || !this.deps.trust.isTrusted || snapshot === undefined || idris2?.status !== 'probed') {
      return undefined;
    }
    return { runner: this.deps.runner, executable: idris2.location.path, env: snapshot.settings.env };
  }

  /** Lists the package files in the workspace folders again (no model is read). */
  private refreshListing(): void {
    this.listing = this.list();
  }

  private async list(): Promise<void> {
    const refresh = ++this.refreshes;
    let listed: IpkgCandidates[];
    try {
      const files = await this.deps.workspace.findIpkgFiles();
      const dirs = [...new Set(files.map((file) => path.dirname(file)))];
      const found = await Promise.all(
        dirs.map(async (dir) => {
          const names = await this.listDirectory(dir);
          return names === undefined ? undefined : ipkgCandidates(dir, names);
        }),
      );
      listed = found.filter((candidates): candidates is IpkgCandidates => candidates !== undefined);
    } catch (error) {
      this.deps.log.warn(`Could not list the .ipkg files of the workspace: ${String(error)}`);
      return;
    }
    if (refresh !== this.refreshes || this.disposed) {
      return;
    }
    listed.sort((a, b) => (a.ipkgPath < b.ipkgPath ? -1 : a.ipkgPath > b.ipkgPath ? 1 : 0));
    const describe = (all: readonly IpkgCandidates[]): string => JSON.stringify(all.map((c) => [c.ipkgPath, ...c.otherIpkgs]));
    if (describe(listed) !== describe(this.listed)) {
      this.listed = listed;
      this.fireChange();
    }
  }

  private ipkgFileCreatedOrDeleted(file: string): void {
    this.rootsByDir.delete(cacheKey(path.dirname(file)));
    this.walks.clear();
    this.invalidated();
    this.refreshListing();
  }

  /** A changed `.ipkg`: its directory's model only; walks and the listing depend on names alone. */
  private ipkgFileChanged(file: string): void {
    this.rootsByDir.delete(cacheKey(path.dirname(file)));
    this.invalidated();
  }

  private foldersChanged(): void {
    this.rootsByDir.clear();
    this.invalidated();
    this.refreshListing();
  }

  private toolchainChanged(): void {
    const generation = this.deps.toolchain.current?.generation;
    if (generation === this.generation) {
      return;
    }
    this.generation = generation;
    this.rootsByDir.clear();
    this.walks.clear();
    this.invalidated();
  }

  private pathCreatedOrDeleted(file: string): void {
    this.changedPaths.add(path.resolve(file));
    if (this.pathTimer === undefined) {
      this.pathTimer = setTimeout(() => {
        this.pathsChanged().catch((error: unknown) => this.deps.log.error(`Could not update the project index: ${String(error)}`));
      }, PATH_PAUSE_MS);
    }
  }

  /**
   * Updates the caches for the paths created or deleted since the last call. Which paths are
   * directories now is read from the file system (a rename reports a deletion and a creation,
   * and a folder moved in comes without its files); a path that is not a directory now was a
   * file, or was deleted. For each path `p`:
   * - walks that start at or below `p`, and roots whose directory is at or below it, are dropped
   *   (their directories appeared or vanished);
   * - a model `--dump-ipkg-json` read without error is dropped when `p` can have held one of the
   *   module sources the compiler found (`mayRemoveModuleSource`); adding files cannot break it;
   * - when `p` is a directory now or has a module source name, every compiler error (`Module
   *   <M> not found` may now be resolved; its source directory is unknown) and every read still
   *   running is dropped. A folder deleted while a read runs is the one case left: that read
   *   keeps what it saw until the next change or snapshot;
   * - the workspace's package files are listed again when `p` is a directory now or a listed
   *   package directory lies at or below it.
   * The fallback reader's models depend on the `.ipkg` alone.
   */
  private async pathsChanged(): Promise<void> {
    this.pathTimer = undefined;
    const paths = [...this.changedPaths];
    this.changedPaths.clear();
    const directories: string[] = [];
    for (const p of paths) {
      if ((await this.listDirectory(p)) !== undefined) {
        directories.push(p);
      }
    }
    if (this.disposed) {
      return;
    }
    const mayAddModuleSource = directories.length > 0 || paths.some((p) => isModuleSourceName(path.basename(p)));
    let dropped = false;
    for (const key of [...this.walks.keys()]) {
      if (paths.some((p) => isAtOrBelow(p, key))) {
        this.walks.delete(key);
        dropped = true;
      }
    }
    for (const [key, entry] of this.rootsByDir) {
      const root = entry.value;
      let affected: boolean;
      if (paths.some((p) => isAtOrBelow(p, key))) {
        affected = true;
      } else if (root === undefined) {
        affected = mayAddModuleSource;
      } else if (root.model.source !== 'dump-json') {
        affected = false;
      } else if (root.model.status === 'error') {
        affected = mayAddModuleSource;
      } else {
        const { model } = root.model;
        const sourceDir = sourceDirOf(root) ?? root.dir;
        affected = paths.some((p) => mayRemoveModuleSource(model, sourceDir, p));
      }
      if (affected) {
        this.rootsByDir.delete(key);
        dropped = true;
      }
    }
    if (dropped) {
      this.invalidated();
    }
    if (directories.length > 0 || this.listed.some((listed) => paths.some((p) => isAtOrBelow(p, listed.dir)))) {
      this.refreshListing();
    }
  }

  private invalidated(): void {
    this.epoch++;
    this.fireChange();
  }

  private fireChange(): void {
    try {
      this.changed.fire();
    } catch (error) {
      this.deps.log.error(`A listener of the project index failed: ${String(error)}`);
    }
  }
}

/**
 * The directory module paths are relative to: the package's `sourcedir` (the package directory
 * when it has none) or a loose file's directory; `undefined` for a package file that could not
 * be read, since the compiler then loads nothing (F10). `sourcedir` is resolved as the
 * compiler's `Libraries.Utils.Path.parse` reads a path, with both `/` and `\` as separators on
 * every platform (so `src\\main` names `src/main` on macOS too) [live: idris2 0.8.0 resolved the
 * modules of an ipkg with `sourcedir = "src\\main"` in `src/main`].
 */
function sourceDirOf(classification: Classification): string | undefined {
  if (classification.kind === 'loose') {
    return classification.dir;
  }
  if (classification.model.status !== 'ok') {
    return undefined;
  }
  const sourcedir = classification.model.model.sourcedir;
  if (sourcedir === undefined) {
    return classification.dir;
  }
  return path.resolve(classification.dir, path.sep === '/' ? sourcedir.replace(/\\/g, '/') : sourcedir);
}
