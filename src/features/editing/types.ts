/**
 * Contracts of M4's interactive editing (`features/editing`, docs/ARCHITECTURE.md §2, §10;
 * ROADMAP §5 M4). Types only; no runtime code.
 *
 * **Commands** (contributed in package.json; the letter is the second key of each
 * `idris2.keybindings.scheme`, ARCHITECTURE §10):
 *
 * | Command | Title | Asks for (`EditKind`) | Letter |
 * |---|---|---|---|
 * | `idris2.caseSplit` | Case Split | `caseSplit` on the pattern variable at the cursor | `c` |
 * | `idris2.addClause` | Add Clause | `addClause` for the type declaration at the cursor | `a` |
 * | `idris2.makeLemma` | Make Lemma | `makeLemma` for the hole at the cursor | `l` |
 * | `idris2.makeWith` | Make With | `makeWith` for the hole at the cursor | `w` |
 * | `idris2.makeCase` | Make Case | `makeCase` for the hole at the cursor | `m` |
 * | `idris2.proofSearch` | Proof Search | `exprSearch` for the hole at the cursor | `s` |
 * | `idris2.nextResult` | Next Result | the `-Next` of the document's cycle, whichever its kind (ROADMAP §9 Q26): `exprSearchNext` of a Proof Search cycle, `generateDefNext` of a Generate Definition cycle | `n` |
 * | `idris2.generateDefinition` | Generate Definition | `generateDef` for the type declaration at the cursor; `generateDefNext` when that declaration's definition is being cycled (below) | `g` |
 * | `idris2.nextDefinition` | Next Definition | `generateDefNext` of the document's Generate Definition cycle | — |
 * | `idris2.intro` | Intro | `intro` for the hole at the cursor | `i` |
 * | `idris2.refineHole` | Refine Hole… | `refine` for the hole at the cursor, with an expression asked in an input box | `r` |
 * | `idris2.addMissingCases` | Add Missing Cases | `addMissingCases` for the function of a coverage error on the cursor's lines, else of the type declaration at the cursor (a `partial` function has no coverage error) | — (a quick fix) |
 *
 * The hole commands (Next Hole, Previous Hole, List Holes) are `features/holes`, Show Keybindings is
 * `features/help`. No command here asks the compiler whether it applies before it is run: what is at
 * the cursor is read from the text with M0's lexer (`features/syntax/lexer.ts`: a `hole` token, an
 * identifier, a line `name :` that declares a type), and a command with nothing to act on says what
 * it needs ("put the cursor on a hole `?name`") — never a silent no-op (ARCHITECTURE §3.1).
 *
 * **Modules and entry points.** `register.ts` — `registerEditing(api, deps: EditingDeps, options?:
 * { keepOutcomes?: boolean; cancelOfferMs?: number }): EditingRegistration` (`commands.ts`
 * `EditingCommandsOptions`), called once by `extension.ts`; it registers the commands above
 * (`commands.ts`, what each is at the cursor: `targets.ts`, applying: `apply.ts`, texts:
 * `messages.ts`), the code-action provider (`codeActions.ts`), the cycling controller
 * (`cycling.ts`) and the save-before-action policy (`saveBeforeAction.ts`).
 *
 * **One edit, from asking to applying** (every command but the two that continue a cycle):
 * 1. The document is the active editor's — or, from a code action, the argument's
 *    (`EditingCommandArgs`), which must name an open document — and must be an Idris document on
 *    disk (`project/literate.ts` `isIdrisDocument`, `file` scheme); nothing runs in Restricted Mode
 *    (a keybinding reaches the command there too; the Command Palette hides it).
 * 2. **Save before** (`Config.saveBeforeAction(doc.uri)`, `core/config.ts` `SaveBeforeAction`): a
 *    document with unsaved changes is saved (`always`), saved after the user agreed (`prompt`), or
 *    not saved, the command saying that the file must be saved first (`never`). A save that fails is
 *    reported and ends the command.
 * 3. **Ask**: `version` is `doc.version` right before the request, which goes through M3's
 *    `DocumentQueries.run(doc, 'command', backend => backend.edit(req))`
 *    (`features/intelligence/types.ts`): when the backend answers `NotLoaded`, the document is loaded
 *    the way **Check File** loads it (so that the load's diagnostics are shown), or the check that a
 *    save started is waited for, and it is asked once more; an `unavailable` outcome is shown as its
 *    reason. The long kinds (`exprSearch`, `generateDef`, their `-Next`, `refine`, `intro`, `makeLemma` and
 *    `addMissingCases`) run under the window's
 *    progress, and a notification with Cancel, which cancels the request (`EditRequest.token`),
 *    appears once the request has run `CANCEL_OFFER_MS` (1 s, Evaluate Selection's); the others run
 *    under the window's progress only.
 * 4. **Apply** (`EditResult`): an `edit` only to `doc` (never another document), only while
 *    `doc` is open and `doc.version === version` — otherwise the result is discarded with a message
 *    that the file changed while the compiler worked —, as one `WorkspaceEdit` of `doc`'s URI, one undo
 *    step, the replacements' `\n` written as the document's line breaks; `choices` through a
 *    QuickPick (the labels through `core/untrustedText.ts` `quickPickText`), a single `intro`
 *    candidate applied without asking, the chosen one applied as an `edit`; `failed` rephrased by
 *    the command's table of known compiler messages (ROADMAP M4: "this clause has no hole to split
 *    on"), the others shown as they are — except after a load of the file that reported errors, or a
 *    package error (`CheckStatusSource`): then "the file did not load cleanly — fix the first error
 *    and save" comes first and the compiler's text after it, never rephrased (F16 does not hold,
 *    `messages.ts`); `exhausted` as "no more results". An `Unsupported` refusal is shown as its
 *    reason, the command's name once (`messages.ts` `refusalText`).
 * The replacements are the final text: in a `.lidr` document the compiler's replies carry `> `
 * where it is needed (F11), and so do the backend's replacements; they are applied as they are,
 * never with a second prefix.
 *
 * **Cycling** (ARCHITECTURE §10 `CyclingController`). An applied `exprSearch` or `generateDef`
 * result starts a cycle of its document (`CycleState`): **Next Result** (a cycle of either kind,
 * ROADMAP §9 Q26) or **Next Definition** (a Generate Definition cycle) asks for the next result
 * (`NextRequest`, of the cycle's kind, with the range the controller follows as `previous`) and
 * applies it as a fresh replacement with its own undo step; they never save (`SaveBeforeAction`) nor
 * load, and say why when the active editor's document has no cycle they continue (Next Definition in
 * a Proof Search cycle: that Next Result continues it).
 * Like every editing command they run one at a time per document (`commands.ts`). A result the same as the one
 * shown (the compiler repeats some, transcript `edits-searches`) changes nothing and keeps the cycle. **Generate Definition**, run with the cursor on the declaration of the
 * document's Generate Definition cycle or in its result, runs Next Definition — the `g` of
 * ARCHITECTURE §10's table, "generate def (also next)". While the active editor's document has a
 * cycle, a status-bar item reads `↻ next (n)`, `n` the number of results shown, and
 * runs the next. A cycle ends — and the next command says why — on `exhausted`, on a failure or a
 * cancel, when its document is changed other than by the controller, closed or loaded again (any
 * load of the root resets the compiler's search: `LoadNotifications`, `NextRequest`), and when
 * another search starts in its root — conservative, since the compiler keeps a proof search and a
 * definition search apart (`psResult`, `gdResult` [src]). A cycle does not start when a load or a
 * search came in its root between the answer and its application. While a document has a cycle, its
 * saves (VS Code's `files.autoSave`, `idris2.checking.trigger` = `afterDelay`) check nothing: the
 * controller holds them (`SaveCheckHolds`), and the document is checked when the cycle ends.
 *
 * **Code actions** (ROADMAP M4, F34; D16). A `CodeActionProvider` on `idrisDocumentSelector()`
 * offers, from the text alone and sending nothing to the compiler: at a hole, Proof Search, Intro,
 * Refine Hole…, Make Lemma (not in an `interface`, not on a hole named by a keyword), Make With (not
 * in a clause whose left-hand side starts on an earlier line) and Make Case; at a variable not
 * starting with a capital letter of a one-line clause whose right-hand side is a bare hole and that
 * has no `where` block below, Case Split; at a type declaration of one name that no clause of the
 * name follows, not `%foreign` or `%extern`, Add Clause and Generate Definition — the three
 * disabled, with the reason, after a check that reported errors and where the backend refuses them
 * unsent for their line, as Make Case after the same `?name` (`codeActions.ts`); and the quick fix Add Missing Cases on a diagnostic of the `idris2`
 * collection whose message has a `Missing cases:` block (ARCHITECTURE §8), the function's name taken
 * from the declaration at the diagnostic's range, not from the message (not for a function local to
 * a definition, nor in a `parameters` block). Each action carries its
 * command with `EditingCommandArgs` and no edit (computing edits in advance would send requests at
 * every move of the cursor), honoured only while the name at its position is still the one offered;
 * its kind is the server's filter key (`EditCodeActionKind`). The
 * keyboard surface is the commands themselves, never `editor.action.codeAction` with a kind (D16).
 *
 * **Untrusted text** (the M2 and M3 rules, CLAUDE.md). A notification's message, an input box's
 * prompt and a progress title are one `plainText(…)` call (`core/notificationText.ts`); compiler
 * text in them has its control and format characters written out (`core/untrustedText.ts`
 * `editorLabel`); QuickPick item texts go through `quickPickText`. Names from the document go to the
 * backend, which checks them (`backend/types.ts` `EditAtRequest`); Refine's expression goes only
 * into the request's string slot (`RefineRequest.hint`).
 */
import type { BackendRegistry } from '../../backend/registry';
import type { Config } from '../../core/config';
import type { IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import type { EditorPosition, EditorRange } from '../../core/positions';
import type { WorkspaceTrust } from '../../core/trust';
import type { ProjectIndex } from '../../project/types';
import type { CheckStatusSource, SaveCheckHolds } from '../diagnostics/checks';
import type { DocumentQueries, LoadNotifications } from '../intelligence/types';

/**
 * The editing commands' ids and the edit each asks for (table above); `registerEditing`'s constant
 * of this type fixes each value, so an id or kind that differs does not compile. Next Result's is
 * the one it asks for in a Proof Search cycle; in a Generate Definition cycle it asks for
 * `generateDefNext` (`commands.ts` `next`). The hole commands and Show Keybindings are not here
 * (module comment).
 */
export interface EditingCommandKinds {
  readonly 'idris2.caseSplit': 'caseSplit';
  readonly 'idris2.addClause': 'addClause';
  readonly 'idris2.makeLemma': 'makeLemma';
  readonly 'idris2.makeWith': 'makeWith';
  readonly 'idris2.makeCase': 'makeCase';
  readonly 'idris2.proofSearch': 'exprSearch';
  readonly 'idris2.nextResult': 'exprSearchNext';
  readonly 'idris2.generateDefinition': 'generateDef';
  readonly 'idris2.nextDefinition': 'generateDefNext';
  readonly 'idris2.intro': 'intro';
  readonly 'idris2.refineHole': 'refine';
  readonly 'idris2.addMissingCases': 'addMissingCases';
}

export type EditingCommandId = keyof EditingCommandKinds;

/**
 * The code-action kinds of the editing actions: idris2-lsp's filter keys (F34; `MakeClause` does
 * not exist), so that one `context.only` means the same on both backends, and `quickfix` for Add
 * Missing Cases (F28). idris2-lsp's `GenerateDefNext` has no action here (Next Definition is a
 * command and a status-bar item, not a code action).
 */
export type EditCodeActionKind =
  | 'refactor.rewrite.AddClause'
  | 'refactor.rewrite.CaseSplit'
  | 'refactor.rewrite.ExprSearch'
  | 'refactor.rewrite.GenerateDef'
  | 'refactor.rewrite.Intro'
  | 'refactor.rewrite.MakeCase'
  | 'refactor.rewrite.MakeWith'
  | 'refactor.rewrite.RefineHole'
  | 'refactor.extract.MakeLemma'
  | 'quickfix';

/**
 * The argument a code action passes to its command. The keyboard and the Command Palette pass
 * none: the command acts at the active editor's cursor. A command given an argument acts only on
 * an open Idris document of that URI (never opening one), at that position, and treats `name` as
 * it treats a name read at the cursor: untrusted (the backend checks it).
 */
export interface EditingCommandArgs {
  /** `vscode.Uri.toString()` of the document. */
  readonly uri: string;
  readonly position: EditorPosition;
  readonly name: string;
}

/**
 * A cycle of results (module comment, *Cycling*): one per document at most, kept by the cycling
 * controller.
 */
export interface CycleState {
  /** `vscode.Uri.toString()` of the document. */
  readonly uri: string;
  readonly kind: 'exprSearch' | 'generateDef';
  /** The range of the result applied last, in the document's text at `version`. */
  readonly range: EditorRange;
  /** `doc.version` after the result applied last; any other version means someone else changed it. */
  readonly version: number;
  /** How many results were shown (1 after the first): the `n` of `↻ next (n)`. */
  readonly shown: number;
}

/**
 * What one run of an editing command did, for the integration tests (`EditingRegistration.outcomes`,
 * kept only with `keepOutcomes`, in `ExtensionMode.Test`): `applied` — an edit was made (one undo
 * step); `message` — nothing was changed and `message` (plain text, as shown) says why: a refusal, a
 * compiler error, a discarded result, no more results; `cancelled` — the user cancelled (a
 * QuickPick, the input box, the save question, a long request) and nothing more was shown.
 */
export type EditingOutcome =
  | { readonly command: EditingCommandId; readonly kind: 'applied'; readonly uri: string }
  | { readonly command: EditingCommandId; readonly kind: 'message'; readonly message: string }
  | { readonly command: EditingCommandId; readonly kind: 'cancelled' };

/** What `registerEditing` needs; `extension.ts` supplies the real ones. */
export interface EditingDeps {
  /** Asks the backend with M3's rules (load on `NotLoaded`, module comment). */
  readonly queries: DocumentQueries;
  /** A load of a cycle's root ends the cycle (the compiler's search is reset). */
  readonly loads: LoadNotifications;
  /** `backendFor(root).caps` (`editing`, `intro`, `refine`, `missingCases`): what the code actions offer. */
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  /**
   * Whether the file's last load reported errors, for the rephrasing (module comment, *Apply*) and
   * the code actions; the holds of the save checks while a cycle runs (*Cycling*).
   */
  readonly checks: CheckStatusSource & SaveCheckHolds;
  readonly config: Pick<Config, 'saveBeforeAction'>;
  readonly trust: WorkspaceTrust;
  readonly log: Log;
}

/** What `registerEditing` returns. */
export interface EditingRegistration extends IDisposable {
  /** Every run of an editing command in this window, in order; empty unless `keepOutcomes`. */
  readonly outcomes: readonly EditingOutcome[];
  /** The cycle of the document `uri` (`vscode.Uri.toString()`), if it has one; for the tests. */
  cycleOf(uri: string): CycleState | undefined;
  /** The text of the `↻ next (n)` status-bar item while it is shown, else `undefined`; for the tests. */
  statusText(): string | undefined;
}
