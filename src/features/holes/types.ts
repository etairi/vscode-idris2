/**
 * Contracts of M4's holes (`features/holes`, docs/ARCHITECTURE.md §2, §9; ROADMAP §5 M4). Types
 * only; no runtime code.
 *
 * **Commands** (contributed in package.json):
 *
 * | Command | Title | Letter | Needs the compiler |
 * |---|---|---|---|
 * | `idris2.nextHole` | Next Hole | `]` | no |
 * | `idris2.previousHole` | Previous Hole | `[` | no |
 * | `idris2.listHoles` | List Holes | — | yes |
 *
 * **Next / Previous Hole** move the cursor to the next (previous) hole of the active editor's text,
 * wrapping around at the end (start), and select its `?name`: the `hole` tokens of M0's lexer
 * (`features/syntax/lexer.ts`, a port of the compiler's `holeIdent`), in code only — in a literate
 * document a `?name` of prose is no hole. They ask the compiler nothing, so they see unsaved holes
 * and work in Restricted Mode too; without a hole they say so (no silent no-op, ARCHITECTURE §3.1).
 *
 * **List Holes** asks the compiler for the holes of the active editor's document — `IdrisBackend.holes`
 * through M3's `DocumentQueries.run(doc, 'command', …)`, which loads the document the way **Check
 * File** does when it is not the file loaded last (`features/intelligence/types.ts`) — and shows
 * them in a QuickPick: its module's first, then those of the modules it imports (`holes` answers for
 * both), each with its type; picking one reveals it (below). It does not save: the answer describes
 * the file as saved. Like the editing commands' long requests it offers Cancel after a second
 * (`features/editing/longRunning.ts`; `HolesOptions.token`).
 *
 * **The Holes view** (`idris2.holes`, in the activity-bar container "Idris 2"; shown while
 * `idris2.holes.showInSideBar` is on and `idris2.isIdrisWorkspace` is set). A tree: file → hole
 * (`?name`, its type) → premises (`0 a : Type`, `1 x : a`, `xs : Vect n a`: the multiplicity
 * prefix only for 0 and 1, `Premise.multiplicity`), from the `HoleModel`; clicking a hole reveals
 * it; the view's badge is the number of holes (`TreeView.badge`). Its welcome content (package.json
 * `viewsWelcome`) says why it is empty.
 *
 * **Revealing a hole** opens its file (`Hole.location`) and selects its `?name`. The location is
 * where the load that reported it read the file; while the file's document shows other text, the
 * hole is looked for as a `hole` token of that name: by its order among the file's holes of that
 * name when the file has several (one per namespace: a second `?h` in one namespace is an error,
 * `Dup.h is already defined` [live, prep of M4]; `HoleRef.ordinal`), else near the recorded line
 * (`navigation.ts` `locateHole`); when there is none the command says the file changed. A hole without a
 * location is revealed the same way in the document whose load reported it, when it is of that
 * document's module and its text has its `?name`; otherwise it is listed under its module and cannot
 * be revealed (`model.ts` `holeGroup`). The tree's items run an internal command for this, registered and not contributed, so that it is not offered in the
 * Command Palette (as `idris2.allowFolder`, M2); `test/integration/diagnostics/diagnostics.test.ts`
 * lists the internal commands.
 *
 * **Untrusted text** (CLAUDE.md, M3). A hole's type and the premises are compiler text. Tree item
 * labels and descriptions go through `core/untrustedText.ts` `editorLabel` (one line, control and
 * format characters written out): VS Code 1.139.1 draws no theme icons in a tree item's plain-string
 * label or description (`processLabel` returns `{label}` without `supportIcons`, and the view's
 * resource labels are created without it [src, the workbench bundle]). QuickPick texts go through
 * `editorLabel` and `quickPickText` (`$(` broken up); a tooltip is a plain string (`visible`);
 * notifications are one `plainText(…)` call.
 */
import type { BackendRegistry } from '../../backend/registry';
import type { Hole } from '../../backend/types';
import type { Event } from '../../core/event';
import type { IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import type { Classification } from '../../project/types';
import type { DocumentQueries, LoadNotifications } from '../intelligence/types';

/**
 * The context key that shows the Holes view (package.json `views`): set to true, and never unset,
 * once a workspace folder of this window contains an `.ipkg` file, or an Idris document
 * (`project/literate.ts` `isIdrisDocument`) has been opened in this window — so that the "Idris 2"
 * container does not appear in windows without Idris.
 */
export type IsIdrisWorkspaceContextKey = 'idris2.isIdrisWorkspace';

/**
 * The holes of the files the compiler has checked in this window (ARCHITECTURE §9, the model of
 * the Holes view; M7's goal panel will be its second view).
 *
 * **Refresh.** After each answered load of a `check` session (`LoadNotifications.onDidLoad`, never
 * `BackendRegistry.onDidChange`, the M3 rule) of a document that is open, the model asks the backend
 * for its holes (`IdrisBackend.holes`) directly — never through a load of its own (the M3 rule for
 * passive providers): `NotLoaded` (another file of the root was loaded in between) leaves the model
 * as it was, and the next load refreshes it. The answer covers the loaded file and the files it
 * imports. After a load that returned no error it replaces the holes the model has for the loaded
 * file and for every file it locates a hole in, and drops those of a file (or module) whose holes
 * this loaded file reported last and this answer does not list (they went away, or the file no
 * longer imports it); a file whose holes another loaded file reported last keeps them until that
 * file, or itself, is loaded again. After a load that returned an error (`LoadedFileEvent.failed`)
 * it replaces only the files and modules it lists holes in, and, when it lists none of the loaded
 * file's, drops those whose `?name` the file's text no longer has: after a parse error the compiler
 * lists none of the file's holes, after an error in an import only the import's (`model.ts`). The entries of
 * a file deleted (in the editor or on disk) or renamed in the editor, or of the files under such a
 * folder, are dropped (`model.ts` `HoleStore.forget`), since no later load would replace them; so are
 * the entries a root's loads gave when the root is released (`RootReleases`: its last checked
 * document was closed).
 *
 * **What it describes.** Each file's holes as that file was when the compiler last read it; a
 * document with unsaved changes may have moved them (revealing looks for them, module comment).
 */
export interface HoleModel {
  /** The files with holes, in a stable order (by path). `fileName` is a document's `fileName`. */
  files(): readonly string[];
  /** The holes the model has for `fileName` (located there, or reported by its load without a location), in the order of their positions. */
  holesIn(fileName: string): readonly Hole[];
  /**
   * The modules with holes that have no location and are not the loaded file's (`model.ts`
   * `holeGroup`: a package's module whose source the compiler did not find), by name.
   */
  modules(): readonly string[];
  /** The holes the model lists under `module` (`modules`), in the answer's order. */
  holesOfModule(module: string): readonly Hole[];
  /** Whether the last load of `fileName` returned an error (List Holes says so). */
  lastLoadFailed(fileName: string): boolean;
  /**
   * The text of `fileName` that its holes' ranges describe: its document's text when the answer came,
   * if it had no unsaved changes; `undefined` when that is not known (it had some, it was not open, or
   * the holes were kept through a failed load). Revealing trusts a recorded range only while the
   * document still shows this text (`navigation.ts` `locateHole`, `unchanged`).
   */
  rangesText(fileName: string): string | undefined;
  /** Fires after the model changed. */
  readonly onDidChange: Event<void>;
}

/**
 * The roots the checks release (`features/diagnostics/checks.ts` `RootRelease`: no checked document of
 * the root is left), as `IdeMode.onDidRelease` reports them (`extension.ts` passes `IdeMode`).
 */
export interface RootReleases {
  readonly onDidRelease: Event<Classification>;
}

/** What `registerHoles` (`features/holes/register.ts`) needs; `extension.ts` supplies the real ones. */
export interface HolesDeps {
  /** List Holes asks with M3's rules (module comment). */
  readonly queries: DocumentQueries;
  /** The model's refresh (`HoleModel`). */
  readonly loads: LoadNotifications;
  readonly releases: RootReleases;
  /**
   * `backendFor(root)`, the root of the load event (`LoadedFileEvent.root`): the model asks `holes`
   * itself after a load; `caps.holes` says whether the backend lists them.
   */
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  readonly log: Log;
}

/** What `registerHoles` returns. */
export interface HolesRegistration extends IDisposable {
  readonly model: HoleModel;
}
