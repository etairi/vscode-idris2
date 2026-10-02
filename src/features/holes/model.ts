/**
 * `HoleModel` (`types.ts`): the holes of the files the compiler has checked in this window, asked
 * for after each load. No `vscode` import at run time (documents come through `HoleStoreDeps`), so
 * it is unit-tested on Node.
 *
 * **Always, not only while the view is visible.** The view's badge (the number of holes) is an
 * activity of its container, drawn on the "Idris 2" activity-bar icon also while the view itself is
 * not visible (`showViewActivity` in VS Code 1.139.1's workbench bundle [src, not run]), so the
 * model follows every load. The cost per load is what `IdrisBackend.holes` sends: in IDE mode
 * `(:metavariables W)` and one `(:name-at …)` per hole name, asked by the backend right after each
 * `check` load (`backend/ide/backend.ts`, *Holes*), which `holes` then returns.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import { rootKey, type BackendRegistry } from '../../backend/registry';
import type { Hole } from '../../backend/types';
import type { IDisposable } from '../../core/disposable';
import { codeLineOf, holeTokenNames, isOpen, NOTHING_OPEN, openAfter } from '../../core/idrisSyntax';
import { errorText, IdrisException, isCancelled } from '../../core/errors';
import { editorLabel } from '../../core/untrustedText';
import { Emitter, type Event } from '../../core/event';
import type { Log } from '../../core/log';
import type { LoadedFileEvent, LoadNotifications } from '../intelligence/types';
import { compilerLiterateStyleOf, type LiterateStyle } from '../../project/literate';
import type { Classification } from '../../project/types';
import type { HoleModel, RootReleases } from './types';

/** The longest file name the warning quotes, in UTF-16 code units. */
const MAX_NAME = 100;

/** What `HoleStore` needs; `register.ts` supplies them. */
export interface HoleStoreDeps {
  readonly loads: LoadNotifications;
  readonly releases: RootReleases;
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  /** The open document of the file `fileName` (a `file` document), if there is one. */
  openDocument(fileName: string): vscode.TextDocument | undefined;
  /** Shows `text` as a warning notification (`register.ts`: one `plainText(…)` call). */
  warn(text: string): void;
  readonly log: Log;
}

/**
 * Where a hole is listed: under its location's file; a hole without a location under the file whose
 * load reported it (`loaded`) when it is of that file's module (`declaredModule`) and that file's text
 * (`inLoaded`: its `holeTokenNames`) has a `?name` of it, else under its module (the namespace of its
 * qualified name): a module whose source the
 * compiler did not find (`:name-at` answers the file `(File-Not-Found)` for a hole of a package built
 * without its sources [live, UX review of M4]), or a hole whose name was not located
 * (`MAX_LOCATED_NAMES`: the backend keeps those only when the loaded text has the `?name`) and whose
 * `?name` the document no longer shows. A namespace that extends the module's name is read as one
 * inside it, so a submodule's hole (`Data.Foo.Bar.h` reported by loading `Data/Foo.idr`) whose
 * `?name` the loaded text also has goes under the file too.
 */
export type HoleGroup = { readonly kind: 'file'; readonly file: string } | { readonly kind: 'module'; readonly module: string };

/** A `module` header's name: identifiers (non-ASCII letters too, as `isHoleName` reads them) joined by dots; the header may be indented (`  module A` loads as `A` [live, last verification of M4]). */
const MODULE_HEADER = /^[ \t]*module[ \t]+([A-Za-z_\u{A1}-\u{10FFFF}][\w'\u{A1}-\u{10FFFF}]*(?:\.[A-Za-z_\u{A1}-\u{10FFFF}][\w'\u{A1}-\u{10FFFF}]*)*)/u;

/**
 * The code blocks of each literate style: its `deliminators` (`styleBird`, `styleOrg`, `styleCMark`,
 * `styleTeX`, `styleTypst`, `src/Parser/Unlit.idr` 18–50 on v0.8.0 [src]), opening and closing.
 */
const CODE_BLOCKS: Readonly<Record<LiterateStyle, readonly (readonly [string, string])[]>> = {
  bird: [],
  org: [
    ['#+BEGIN_SRC idris', '#+END_SRC'],
    ['#+begin_src idris', '#+end_src'],
    ['#+BEGIN_COMMENT idris', '#+END_COMMENT'],
    ['#+begin_comment idris', '#+end_comment'],
  ],
  cmark: [
    ['```idris', '```'],
    ['~~~idris', '~~~'],
    ['<!-- idris', '-->'],
  ],
  tex: [
    ['\\begin{code}', '\\end{code}'],
    ['\\begin{hidden}', '\\end{hidden}'],
  ],
  typst: [
    ['```idris', '```'],
    ['/* idris', '*/'],
  ],
};

/**
 * The code of each line of `text` as the compiler's unlit reads it, `undefined` for a line that is
 * not code (`src/Libraries/Text/Literate.idr` on v0.8.0, 34–89: `block`, `rawTokens`, `reduce`;
 * 166–175: `lexLiterate` [src]): without a style every line; in bird style a line with a marker (`codeLineOf`); in a fenced style
 * the lines inside its blocks — a block opens on a line that starts with an opening delimiter and
 * closes on the first later line that has the closing one anywhere (both lines are dropped whole; an
 * opening never closed opens nothing) — and in Org style a `#+IDRIS:` line outside them too. Read
 * here for `declaredModule` only: the line reader of the other features does not see the blocks
 * (M12). Linear in the length of `text`.
 */
function codeLines(text: string, style: LiterateStyle | undefined): readonly (string | undefined)[] {
  const lines = text.split(/\r?\n/u);
  const blocks = style === undefined ? [] : CODE_BLOCKS[style];
  if (blocks.length === 0) {
    return lines.map((line) => codeLineOf(style, line)?.code);
  }
  /** Per closing delimiter, the first line at or after each line that has it (-1: none); made when first needed. */
  const nextWith = new Map<string, Int32Array>();
  const closingLine = (close: string, from: number): number => {
    let next = nextWith.get(close);
    if (next === undefined) {
      next = new Int32Array(lines.length + 1).fill(-1);
      for (let i = lines.length - 1; i >= 0; i--) {
        next[i] = lines[i].includes(close) ? i : next[i + 1];
      }
      nextWith.set(close, next);
    }
    return next[from];
  };
  const code: (string | undefined)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const end = blocks.map(([opening, close]) => (lines[i].startsWith(opening) ? closingLine(close, i + 1) : -1)).find((e) => e >= 0) ?? -1;
    if (end < 0) {
      code.push(style === 'org' ? codeLineOf(style, lines[i])?.code : undefined);
      continue;
    }
    code.push(undefined);
    for (let j = i + 1; j < end; j++) {
      code.push(lines[j]);
    }
    code.push(undefined);
    i = end;
  }
  return code;
}

/**
 * The module the text `text` declares (`module A.B`; `Main` without a header), read from the first
 * code line (`codeLines`: in a literate file never prose) whose first word is `module`, lines that
 * start inside a block comment or a string skipped; the comments and strings are followed over
 * the code lines only, as the compiler reads them (prose is an empty line to it).
 */
export function declaredModule(text: string, style: LiterateStyle | undefined): string {
  let open = NOTHING_OPEN;
  for (const code of codeLines(text, style)) {
    if (code === undefined) {
      continue;
    }
    const inside = isOpen(open);
    open = openAfter(code, open);
    const name = inside ? undefined : MODULE_HEADER.exec(code)?.[1];
    if (name !== undefined) {
      return name;
    }
  }
  return 'Main';
}

/**
 * The `HoleGroup` of `hole`, reported by the load of `loaded`, whose text declares the module
 * `module` and has the `?name`s `inLoaded`.
 */
export function holeGroup(hole: Hole, loaded: string, inLoaded: ReadonlySet<string>, module: string): HoleGroup {
  if (hole.location !== undefined) {
    return { kind: 'file', file: hole.location.uri.fsPath };
  }
  const dot = hole.qualifiedName.lastIndexOf('.');
  const namespace = hole.qualifiedName.slice(0, Math.max(dot, 0));
  const ofLoaded = namespace === module || namespace.startsWith(`${module}.`);
  return (ofLoaded && inLoaded.has(hole.name)) || dot <= 0 ? { kind: 'file', file: loaded } : { kind: 'module', module: namespace };
}

/** Document order of the holes' locations; holes without one after the others. */
export function compareHoles(a: Hole, b: Hole): number {
  const ra = a.location?.range;
  const rb = b.location?.range;
  if (ra === undefined || rb === undefined) {
    return ra === undefined ? (rb === undefined ? 0 : 1) : -1;
  }
  return ra.start.line - rb.start.line || ra.start.character - rb.start.character;
}

/**
 * The model (`HoleModel`'s contract: *Refresh*, *What it describes*). An answer to a load that
 * returned no error replaces the holes of the loaded file and of every file and module it lists a
 * hole under (`holeGroup`), and drops those of the files and modules whose holes this loaded file's
 * earlier answer was the last to report and this one does not list (`reporter`). An answer to a load
 * that returned an error replaces only the groups it lists holes under; when it lists none of the
 * loaded file's, that file keeps those of its holes whose `?name` its text still has. After a parse
 * error the compiler lists none of the file's holes, after an error in an import only the import's,
 * after a type or coverage error in the file its holes and its imports' [live, M4's ninth and final
 * reviews]; the holes kept so keep the ranges of an earlier load, so their text is not known
 * (`rangesText`). A hole of a qualified name the answer repeats is kept once
 * (the tree's items are identified by it). Answers are applied in the order the loads of a file were
 * reported: an answer to an earlier load of the same file that arrives after a later one's asking is
 * dropped, and so is one that arrives after its root was released.
 */
export class HoleStore implements HoleModel, IDisposable {
  private readonly byFile = new Map<string, readonly Hole[]>();
  /** Per file of `byFile`, the key (`rootKey`) of the root whose load gave its holes. */
  private readonly rootOf = new Map<string, string>();
  /** The holes listed under a module (`holeGroup`), and the key of the root whose load gave them. */
  private readonly byModule = new Map<string, { readonly holes: readonly Hole[]; readonly root: string }>();
  /**
   * Per file of `byFile` and module of `byModule` (`groupKey`), the loaded file whose answer reported
   * its holes last: when that file's next clean answer does not list it, its holes went away (or that
   * file no longer imports it), and it is dropped (`apply`); another file's answer without it leaves
   * it as it is.
   */
  private readonly reporter = new Map<string, string>();
  /** Per loaded file, its latest refresh (`refresh`): its number and root key. */
  private readonly latest = new Map<string, { readonly sequence: number; readonly root: string }>();
  private sequence = 0;
  /**
   * Per file of `byFile`, the text of its document that its holes' ranges were read from
   * (`rangesText`); absent when that is not known.
   */
  private readonly readFrom = new Map<string, string>();
  /** The files whose last load returned an error (`LoadedFileEvent.failed`). */
  private readonly failedLoads = new Set<string>();
  /** The loaded files whose holes took too long to list, since their last listing that did not (`refresh`): warned about once. */
  private readonly tooSlow = new Set<string>();
  private disposed = false;
  private readonly changed = new Emitter<void>();
  private readonly subscriptions: IDisposable[];
  readonly onDidChange: Event<void> = this.changed.event;

  constructor(private readonly deps: HoleStoreDeps) {
    this.subscriptions = [
      deps.loads.onDidLoad((loaded) => {
        if (loaded.failed === true) {
          this.failedLoads.add(loaded.file);
        } else {
          this.failedLoads.delete(loaded.file);
        }
        void this.refresh(loaded);
      }),
      deps.releases.onDidRelease((root) => this.released(root)),
    ];
  }

  lastLoadFailed(fileName: string): boolean {
    return this.failedLoads.has(fileName);
  }

  rangesText(fileName: string): string | undefined {
    return this.readFrom.get(fileName);
  }

  files(): readonly string[] {
    return [...this.byFile.keys()].sort();
  }

  holesIn(fileName: string): readonly Hole[] {
    return this.byFile.get(fileName) ?? [];
  }

  modules(): readonly string[] {
    return [...this.byModule.keys()].sort();
  }

  holesOfModule(module: string): readonly Hole[] {
    return this.byModule.get(module)?.holes ?? [];
  }

  /**
   * Forgets the holes of `paths` and of every file under them (deleted, or renamed in the editor),
   * and the answers still to come for them: no load of theirs will come to replace them.
   */
  forget(paths: readonly string[]): void {
    const under = (file: string): boolean => paths.some((p) => isWithin(p, file));
    // An answer still to come for such a file is dropped too (`refresh` finds no `latest`).
    for (const file of [...this.latest.keys()].filter(under)) {
      this.latest.delete(file);
    }
    this.drop([...this.byFile.keys()].filter(under));
  }

  /** Forgets the holes the loads of `root` gave, and drops the answers still to come for it. */
  private released(root: Classification): void {
    const key = rootKey(root);
    for (const [file, latest] of this.latest) {
      if (latest.root === key) {
        this.latest.delete(file);
      }
    }
    const modules = [...this.byModule].filter(([, entry]) => entry.root === key).map(([module]) => module);
    for (const module of modules) {
      this.byModule.delete(module);
      this.reporter.delete(groupKey({ kind: 'module', module }));
    }
    this.drop([...this.rootOf].filter(([, by]) => by === key).map(([file]) => file), modules.length > 0);
  }

  private drop(files: readonly string[], changed = false): void {
    for (const file of files) {
      this.byFile.delete(file);
      this.rootOf.delete(file);
      this.readFrom.delete(file);
      this.reporter.delete(groupKey({ kind: 'file', file }));
    }
    if (files.length > 0 || changed) {
      this.changed.fire();
    }
  }

  private async refresh(loaded: LoadedFileEvent): Promise<void> {
    const doc = this.deps.openDocument(loaded.file);
    const backend = this.deps.registry.backendFor(loaded.root);
    if (this.disposed || doc === undefined || !backend.caps.holes) {
      return;
    }
    const sequence = ++this.sequence;
    const root = rootKey(loaded.root);
    this.latest.set(loaded.file, { sequence, root });
    // The text the load read, as near as the model can see it: the document's, if it has no unsaved changes.
    const text = doc.getText();
    const loadedText = doc.isDirty ? undefined : text;
    const inLoaded = holeTokenNames(text);
    const module = declaredModule(text, compilerLiterateStyleOf(doc));
    let holes: readonly Hole[];
    try {
      holes = await backend.holes(doc, { kept: true });
    } catch (error) {
      if (error instanceof IdrisException && error.error.kind === 'RequestTimeout') {
        // IDE mode: the holes' requests ran past `idris2.ideMode.longActionTimeout`, and the compiler
        // was restarted (not counted as a crash, so no other warning says it), or they are not asked
        // again for this text (`backend.ts`, *Holes*). Said once until a listing succeeds.
        this.deps.log.warn(`Holes: listing the holes of ${loaded.file} took too long: ${errorText(error.error)}`);
        if (!this.tooSlow.has(loaded.file)) {
          this.tooSlow.add(loaded.file);
          this.deps.warn(
            `Idris 2: listing the holes of ${editorLabel(path.basename(loaded.file), MAX_NAME)} took longer than idris2.ideMode.longActionTimeout, so the compiler was ` +
              'restarted. The Holes view asks for them again once the file changes. List Holes asks at once, which can take as long; it offers Cancel.',
          );
        }
      } else if (error instanceof IdrisException) {
        // `NotLoaded`: the backend has no holes of this load (IDE mode: an urgent load went before
        // its holes); they come with the file's next load.
        this.deps.log.debug(`Holes: ${loaded.file}: ${errorText(error.error)}`);
      } else if (isCancelled(error)) {
        this.deps.log.debug(`Holes: ${loaded.file}: ${(error as Error).message}`);
      } else {
        this.deps.log.error(`Holes: asking for the holes of ${loaded.file} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    this.tooSlow.delete(loaded.file);
    if (this.disposed || this.latest.get(loaded.file)?.sequence !== sequence) {
      return;
    }
    this.apply(loaded.file, root, holes, { inLoaded, module, text: loadedText }, loaded.failed === true);
  }

  private apply(
    loaded: string,
    root: string,
    holes: readonly Hole[],
    read: { readonly inLoaded: ReadonlySet<string>; readonly module: string; readonly text: string | undefined },
    failed: boolean,
  ): void {
    const { inLoaded } = read;
    const groups = new Map<string, Hole[]>(failed ? [] : [[loaded, []]]);
    const modules = new Map<string, Hole[]>();
    const seen = new Set<string>();
    for (const hole of holes) {
      if (seen.has(hole.qualifiedName)) {
        continue;
      }
      seen.add(hole.qualifiedName);
      const group = holeGroup(hole, loaded, inLoaded, read.module);
      const [into, key] = group.kind === 'file' ? [groups, group.file] : [modules, group.module];
      const listed = into.get(key);
      if (listed === undefined) {
        into.set(key, [hole]);
      } else {
        listed.push(hole);
      }
    }
    // A failed load's answer without the loaded file's holes (a parse error, an error in an import):
    // those whose `?name` the text no longer has went away. The others keep the ranges of an earlier
    // load, so the text they were read from is not known.
    const before = this.byFile.get(loaded);
    const kept = failed && !groups.has(loaded) && before !== undefined;
    if (kept) {
      groups.set(loaded, before.filter((hole) => inLoaded.has(hole.name)));
    }
    // The groups this loaded file's earlier answer reported last that this one does not list: their
    // holes went away. Not after a failed load, whose answer lists only some.
    for (const [key, by] of failed ? [] : this.reporter) {
      const group = parseGroupKey(key);
      if (by === loaded && !(group.kind === 'file' ? groups.get(group.file)?.length : modules.has(group.module))) {
        if (group.kind === 'file') {
          groups.set(group.file, []);
        } else {
          this.byModule.delete(group.module);
          this.reporter.delete(key);
        }
      }
    }
    for (const [file, group] of groups) {
      const key = groupKey({ kind: 'file', file });
      const doc = file === loaded ? undefined : this.deps.openDocument(file);
      const text = file === loaded ? (kept ? undefined : read.text) : doc === undefined || doc.isDirty ? undefined : doc.getText();
      if (group.length === 0 || text === undefined) {
        this.readFrom.delete(file);
      } else {
        this.readFrom.set(file, text);
      }
      if (group.length === 0) {
        this.byFile.delete(file);
        this.rootOf.delete(file);
        this.reporter.delete(key);
      } else {
        this.byFile.set(file, group.sort(compareHoles));
        this.rootOf.set(file, root);
        this.reporter.set(key, loaded);
      }
    }
    for (const [module, group] of modules) {
      this.byModule.set(module, { holes: group, root });
      this.reporter.set(groupKey({ kind: 'module', module }), loaded);
    }
    this.changed.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

/** The key of a `HoleGroup` in `HoleStore.reporter`. */
const groupKey = (group: HoleGroup): string => (group.kind === 'file' ? `file:${group.file}` : `module:${group.module}`);

/** The `HoleGroup` of a `groupKey`. */
const parseGroupKey = (key: string): HoleGroup =>
  key.startsWith('file:') ? { kind: 'file', file: key.slice('file:'.length) } : { kind: 'module', module: key.slice('module:'.length) };

/** Whether `file` is `dir` or lies under it. */
function isWithin(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
