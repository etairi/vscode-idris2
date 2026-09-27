/**
 * Shared types of the M1 project layer (`project/ipkg.ts`, `project/index.ts` in
 * docs/ARCHITECTURE.md §2, §3.2; ROADMAP M1). Types only; no runtime code.
 *
 * A document belongs to the **project root** of the nearest `.ipkg` found walking up from its
 * directory to the file-system root — the walk the compiler's `findIpkg` does from the
 * process cwd (F13) — or, if there is none, it is a **loose file** whose session runs in its
 * own directory (D4). The workspace folders limit only which roots the UI lists (`roots()`),
 * never the classification: the compiler finds an ipkg above the workspace folder anyway.
 *
 * Facts the types rest on [src v0.8.0; the same on master 1c630e6 unless noted]:
 * - `findIpkgFile` (`src/Core/Directory.idr` 333–349) lists each directory with `listDir`,
 *   which returns the entries in the order the OS's `readdir` yields them (no sorting,
 *   `libs/base/System/Directory.idr` 141–146), takes the **first** entry whose extension is
 *   `ipkg`, stops at the first directory that has one, and also stops (finding nothing) at a
 *   directory it cannot list. Which of several `.ipkg` files in one directory wins therefore
 *   depends on the file system (F10: "the compiler picks one of them").
 * - `--dump-ipkg-json` prints `toJson pkg` (`src/Idris/Package/ToJson.idr`): always `name`,
 *   `depends` (a list of one-key objects `{"<pkg>": {"lowerInclusive": …, "lowerBound": …,
 *   "upperInclusive": …, "upperBound": …}}`, `"*"` for an absent bound) and `modules`;
 *   `version`, `main`, `executable`, `sourcedir`, `builddir`, `outputdir`, `opts` and the other
 *   optional fields only when set (master adds `datadir`). **Strings are printed raw**
 *   (`toJson str = "\"\{str}\""`): an ipkg string literal keeps its escapes verbatim
 *   (`stripQuotes`), so `\\` and `\"` give valid JSON that `JSON.parse` would decode to a
 *   different value, and a raw newline in a literal gives invalid JSON [live]; `project/ipkg.ts`
 *   reads the strings raw.
 * - `nsToSource` (`src/Core/Directory.idr` 212–220) looks for a module's source at
 *   `<sourcedir>/<A/B>` + each extension of `listOfExtensionsStr`, in that order: the literate
 *   extensions — for the prefix "", then `.idr`, then `.lidr`, each of `.lidr .org .md
 *   .markdown .dj .tex .ltx .typ` (`listOfExtensionsLiterate`, `src/Parser/Unlit.idr`, the
 *   same on master apart from imports) — then `.yaff`, then `.idr` (`Core/Directory.idr`
 *   105–106).
 */
import type { IDisposable } from '../core/disposable';
import type { Event } from '../core/event';
import type { Log } from '../core/log';
import type { WorkspaceTrust } from '../core/trust';
import type { ProcessRunner, ToolchainService } from '../toolchain/types';

/** A dependency as the ipkg declares it. */
export interface IpkgDependency {
  readonly name: string;
  /** The version bounds, as `--dump-ipkg-json` prints them (the fallback reader fills them too). */
  readonly bounds: IpkgVersionBounds;
}

/** `PkgVersionBounds` as `--dump-ipkg-json` prints it; an absent bound (`"*"`) is `undefined`. */
export interface IpkgVersionBounds {
  readonly lower: string | undefined;
  readonly lowerInclusive: boolean;
  readonly upper: string | undefined;
  readonly upperInclusive: boolean;
}

/**
 * The parts of an ipkg the extension uses. From `--dump-ipkg-json` every field the JSON has
 * is filled. The fallback reader (used when `idris2` is missing or was not probed, when the
 * workspace is not trusted, for an `.ipkg` outside the workspace folders, and when a compiler
 * run fails) fills the same fields from the same file; it differs in not checking that the
 * listed modules and `main` exist, and in the other ways `readIpkgText` lists
 * (`project/ipkg.ts`).
 */
export interface IpkgModel {
  /** The `package` name. */
  readonly name: string;
  readonly version?: string;
  readonly depends: readonly IpkgDependency[];
  /** Module names as written, e.g. `Foo.B`. */
  readonly modules: readonly string[];
  readonly main?: string;
  readonly executable?: string;
  /** As written in the ipkg (relative to the ipkg directory); `undefined` when absent. */
  readonly sourcedir?: string;
  /** As written; when set it overrides `--build-dir` (F12), which M2's isolation relies on. */
  readonly builddir?: string;
  readonly outputdir?: string;
}

export type IpkgModelSource = 'dump-json' | 'fallback';

/**
 * An ipkg that could not be read. For `dump-json` the message is the compiler's (F10:
 * `Error: Unrecognised property "pkgs".` followed by `"bad.ipkg":3:1--3:5` and a snippet).
 */
export interface IpkgError {
  readonly message: string;
  /** The range the compiler printed (`L:C--L:C`), **1-based as printed**; convert it with core/positions.ts. */
  readonly range?: {
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
  };
}

export type IpkgModelState =
  | { readonly status: 'ok'; readonly source: IpkgModelSource; readonly model: IpkgModel }
  | { readonly status: 'error'; readonly source: IpkgModelSource; readonly error: IpkgError };

/** A document governed by an `.ipkg` (ARCHITECTURE §3.2 "ProjectRoot"). */
export interface ProjectRoot {
  readonly kind: 'project';
  /** Absolute path of the `.ipkg` the compiler's `findIpkg` would pick. */
  readonly ipkgPath: string;
  /** Its directory: the cwd of every session for this root (F13, D4). */
  readonly dir: string;
  /** The other `.ipkg` files in `dir` (F10); when non-empty the UI warns. */
  readonly otherIpkgs: readonly string[];
  /**
   * Whether the `.ipkg` lies inside a workspace folder. Only such a file is read with the
   * compiler: `--dump-ipkg-json` runs in the `.ipkg`'s directory, and VS Code's workspace trust
   * covers the workspace folders, not the directories above them (ROADMAP M1 As built). The
   * UI says when a root lies outside.
   */
  readonly insideWorkspace: boolean;
  readonly model: IpkgModelState;
}

/** A document with no `.ipkg` above it; its sessions run in `dir`, the file's directory. */
export interface LooseFile {
  readonly kind: 'loose';
  readonly dir: string;
}

export type Classification = ProjectRoot | LooseFile;

/**
 * The project index. `src/project/index.ts` exports
 * `createProjectIndex(deps: ProjectIndexDeps): ProjectIndex`; `extension.ts` creates it.
 * Paths are absolute file-system paths (`Uri.fsPath`); documents that are not files
 * (untitled, virtual) are not classified.
 *
 * - The ipkg model is read with `idris2 --dump-ipkg-json` through the toolchain's process
 *   runner when the workspace is trusted, `idris2` is `probed` and the `.ipkg` lies inside a
 *   workspace folder; otherwise, and when the run fails (not started, killed, timed out) or
 *   prints neither the package JSON nor an `Error:` report, with the fallback reader.
 * - Models are read when asked for (`classify`, `roots`), then cached. It watches every `.ipkg`
 *   in the workspace folders; a created, changed or deleted ipkg, a change of the workspace
 *   folders, or a new toolchain snapshot invalidates the affected entries and fires
 *   `onDidChange`, and so does a file or folder created, deleted or moved in a workspace folder:
 *   for the walks and roots at or below it, for the models the compiler read (it checks that the
 *   listed modules and `main` exist) whose module sources it can add or remove, and for the list
 *   of package files. An ipkg above the workspace folders (a root only `classify` finds) is not
 *   watched: it is re-read after the next toolchain snapshot (e.g. Rescan Toolchain).
 */
export interface ProjectIndex extends IDisposable {
  /** The root of the nearest `.ipkg` above `filePath`, else a loose file. */
  classify(filePath: string): Promise<Classification>;
  /**
   * The roots whose `.ipkg` lies inside a workspace folder (what the UI lists), by path, as of
   * the latest scan of the workspace; their models are read now if they are not cached.
   */
  roots(): Promise<readonly ProjectRoot[]>;
  /**
   * The module name the compiler gives the file at `filePath`: its path relative to the
   * root's source directory (or to a loose file's directory), with every extension of the file
   * name dropped (`mbPathToNS`/`dropExtensions`: `Foo/B.idr.md` → `Foo.B`, `Foo/Bar.Baz.idr` →
   * `Foo.Bar`) and separators replaced by `.`; `undefined` when the file is outside that
   * directory, when the root's package file could not be read, or unless the name is an Idris
   * source name (`splitIdrisFileName`: `.idr` or a literate extension, `project/literate.ts`).
   * Names and paths are compared as written, case-sensitively, as the compiler compares them;
   * on a case-insensitive file system the compiler can still load a differently cased file
   * (`import Up` loads `Up.IDR`, F11 addendum), which then has no module name here. Also
   * `undefined` for a path component the compiler's path parser would split or drop (one with
   * `\`, `:` or `?`, possible on POSIX, or only white space; `project/index.ts`).
   */
  pathToModule(classification: Classification, filePath: string): string | undefined;
  /** The paths the compiler tries for `moduleName`, in `nsToSource` order (see above). */
  moduleToPaths(classification: Classification, moduleName: string): readonly string[];
  /** The working directory for sessions of this classification: `dir` in both cases. */
  sessionCwd(classification: Classification): string;
  readonly onDidChange: Event<void>;
}

/**
 * The workspace surface the index needs, so that `project/index.ts` does not load `vscode` at
 * run time. `extension.ts` implements it with `vscode.workspace.workspaceFolders`,
 * `onDidChangeWorkspaceFolders`, `findFiles` and `createFileSystemWatcher` (for `file:`
 * folders; others are ignored); unit tests pass a fake.
 */
export interface ProjectWorkspace {
  /** Absolute paths of the workspace folders, in workspace order. */
  folders(): readonly string[];
  readonly onDidChangeFolders: Event<void>;
  /** Absolute paths of every `.ipkg` file inside the workspace folders. */
  findIpkgFiles(): Promise<readonly string[]>;
  /** Fires with the absolute path of an `.ipkg` created or deleted in a workspace folder. */
  readonly onDidCreateOrDeleteIpkgFile: Event<string>;
  /** Fires with the absolute path of an `.ipkg` in a workspace folder whose content changed. */
  readonly onDidChangeIpkgFile: Event<string>;
  /**
   * Fires with the absolute path of anything created or deleted in a workspace folder, a file of
   * any name (an `.ipkg` too) or a folder. A folder that is deleted, moved or restored may be
   * reported alone, without the files it holds: "file events from deleting a folder may not
   * include events for the contained files" (`createFileSystemWatcher` in vscode.d.ts [doc]),
   * and VS Code 1.139.1's file watcher drops the deletions below a deleted folder (`coalesce` in
   * `watcherMain.js` [src]).
   */
  readonly onDidCreateOrDeletePath: Event<string>;
}

/** What `createProjectIndex` needs; `extension.ts` supplies the real ones. */
export interface ProjectIndexDeps {
  readonly workspace: ProjectWorkspace;
  /**
   * For the `idris2` to run `--dump-ipkg-json` with, and its environment (the snapshot's
   * `idris2.toolchain.env`), and to re-read models after a rescan.
   */
  readonly toolchain: ToolchainService;
  readonly runner: ProcessRunner;
  readonly trust: WorkspaceTrust;
  readonly log: Log;
}
