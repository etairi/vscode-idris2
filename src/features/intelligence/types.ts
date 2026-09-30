/**
 * Contracts of M3's read-only intelligence (`features/intelligence`, docs/ARCHITECTURE.md §2;
 * ROADMAP §5 M3). Types only; no runtime code.
 *
 * **What lives here.** The providers of M3 that answer from the IDE-mode backend: hover and
 * **Idris 2: Type at Cursor** / **Docs at Cursor**, Go to Definition, **Show Documentation** (a
 * read-only `idris2-doc:` document), **Browse Namespace…**, semantic tokens, document symbols and
 * highlights, completion, and inlay hints for pattern-variable types. Evaluation is
 * `features/eval`. Every provider registers with `idrisDocumentSelector()` (D21). The domain
 * types the backend produces — `Token`, `TokenIndex`, `TypeInfo`, `Evaluation`, `Decor` — are in
 * `backend/types.ts`, since the backend must not import features (ARCHITECTURE §2 naming rules);
 * this module holds what the features agree on among themselves and with `extension.ts`.
 *
 * **Modules and entry points** (each exports a `register…` function returning a disposable, the
 * ARCHITECTURE §2 rule, taking the `vscode` namespace and `IntelligenceDeps`):
 * - `register.ts` — `registerIntelligence(vscode, deps)`: every provider and command of this
 *   folder except the two below; `queries.ts` — `createDocumentQueries(deps: DocumentQueriesDeps):
 *   DocumentQueries`, which `extension.ts` builds once and passes in `IntelligenceDeps.queries`,
 *   and `AnswerCache`. The helpers `register.ts` uses: `hover.ts`, `occurrence.ts`, `text.ts`,
 *   `docs.ts`, `semanticTokens.ts`, `symbols.ts`, `highlights.ts`.
 * - `completion.ts` — `registerCompletion(vscode, deps: CompletionDeps, options?)`, where
 *   `CompletionDeps` is `IntelligenceDeps` plus `warmUp: CompletionWarmUp` (`extension.ts` passes
 *   `IdeMode`, whose `warmUpCompletions` it is) and `options.waitMs` is for tests; `inlayHints.ts` —
 *   `registerInlayHints(vscode, deps)`.
 * - How compiler text is shown (the fence, invisible characters, QuickPick texts, one-line labels)
 *   is `core/untrustedText.ts`, which `features/eval` shares.
 *
 * **Untrusted text** (hard requirements). Everything the compiler sends — types, docs, error
 * messages, namespace listings, evaluation results — quotes the user's source and that of
 * installed packages (their docstrings), so it is shown as text, never interpreted:
 * - A `MarkdownString` built from it is never `isTrusted` (so a `command:` link in it cannot
 *   run), has `supportHtml` and `supportThemeIcons` off, and gets compiler text only inside a
 *   fenced code block written by this extension with `appendMarkdown` (`core/untrustedText.ts`
 *   `codeBlock`), whose fence is a run of backticks longer than every run of backticks anywhere
 *   in the text, and at least three. Not `appendCodeblock`: 1.139.1 sizes its fence by the runs at
 *   the very start of a line only (`$6` [src]), while CommonMark also closes a fence indented by up
 *   to three spaces, so a docstring line of two spaces and three backticks would end the block and
 *   the rest would be rendered as markdown (links, images, emphasis). Not `appendText` either
 *   (M3 used it for the doc overview until its review): 1.139.1's escaper (`B6` in the extension
 *   host bundle [src]) leaves `&`, `<` and `:` alone, so named character references and autolinks
 *   of the text were rendered (`hover.ts` `renderHover`).
 * - Decoration texts (`contentText`) are plain text. A notification's message, an input box's or
 *   QuickPick's prompt and a progress title are one `plainText(…)` call (CLAUDE.md, M2 rule).
 *   A QuickPick item's `label`, `description` and `detail` render `$(<name>)` as a theme icon
 *   [doc: `QuickPickItem` in `@types/vscode` 1.138.0], so compiler text there has that sequence
 *   broken up.
 * - A completion item's `label` is drawn with theme icons on and bidirectional controls acting
 *   [src: the 1.139.1 suggest widget], so a compiler name there is `editorLabel` and
 *   `quickPickText` of it, while its `insertText` and `filterText` are the name
 *   (`completion.ts`, *Names as labels*; third review of M3).
 * - The `idris2-doc:` document is plain text (its language is not Markdown).
 */
import type * as vscode from 'vscode';
import type { BackendRegistry } from '../../backend/registry';
import type { Decor, IdrisBackend, TypeInfo } from '../../backend/types';
import type { Config } from '../../core/config';
import type { Event } from '../../core/event';
import type { Log } from '../../core/log';
import type { EditorRange } from '../../core/positions';
import type { WorkspaceTrust } from '../../core/trust';
import type { Classification, ProjectIndex } from '../../project/types';
import type { CheckStatusSource, DocumentChecks } from '../diagnostics/checks';

// -------------------------------------------------------------------------------------------
// Semantic tokens
// -------------------------------------------------------------------------------------------

/**
 * The token types of the semantic-tokens legend, in idris2-lsp's order, so that themes colour
 * both backends alike (ROADMAP M3): `decor` in `src/Server/Capabilities.idr` 13–25 of idris2-lsp
 * `9a2f0ad` [src], which has no token modifiers. `module` and `postulate` are not standard VS
 * Code types; `package.json` declares them (`semanticTokenTypes`, M0) with the super-types
 * `namespace` and `type`. The legend constant is typed with this tuple, so a different order or
 * set does not compile.
 */
export type SemanticTokenLegend = readonly [
  'type',
  'function',
  'enumMember',
  'variable',
  'keyword',
  'namespace',
  'postulate',
  'module',
  'comment',
];

export type SemanticTokenType = SemanticTokenLegend[number];

/**
 * The token type of each decoration, as idris2-lsp's `encodeDecorAsString` maps them
 * (`Capabilities.idr` 16–25 [src]): a data constructor is an `enumMember`, a bound variable a
 * `variable`. The mapping constant is typed with this interface, which fixes each value; its
 * `Record` base makes every `Decor` required.
 */
export interface DecorTokenTypes extends Record<Decor, SemanticTokenType> {
  readonly type: 'type';
  readonly function: 'function';
  readonly data: 'enumMember';
  readonly bound: 'variable';
  readonly keyword: 'keyword';
  readonly namespace: 'namespace';
  readonly postulate: 'postulate';
  readonly module: 'module';
  readonly comment: 'comment';
}

// -------------------------------------------------------------------------------------------
// Hover
// -------------------------------------------------------------------------------------------

/**
 * What a hover over a name shows (ROADMAP M3: its type, local pattern variables included, and
 * its doc overview), before it is rendered under the rules of the module comment. **Type at
 * Cursor** and **Docs at Cursor** show the same answers for the name at the cursor.
 */
export interface HoverModel {
  /** The occurrence: its token's range (`TokenIndex`), or the name the lexer finds there. */
  readonly range: EditorRange;
  /**
   * `IdrisBackend.typeAt`'s answer, shown in an `idris2` code block; with `lookup: 'name'` a note
   * says it was looked up by name (it may describe a global that a local name shadows).
   */
  readonly type?: TypeInfo;
  /**
   * The first paragraph of `IdrisBackend.docsFor`'s text (the compiler ignores the overview mode,
   * F31, so the extension takes it), shown in a plain-text code block (`codeBlock` with `text`,
   * its invisible characters written out by `visible`).
   */
  readonly docOverview?: string;
  /**
   * The answers describe the file as saved while the editor shows other text (unsaved changes, or
   * a text not checked since it changed; `CheckStatusSource`): an italic first line says that the
   * results refer to the saved file (ARCHITECTURE §6.1).
   */
  readonly stale: boolean;
}

// -------------------------------------------------------------------------------------------
// Asking the backend about a document
// -------------------------------------------------------------------------------------------

/**
 * Who asks: `passive` — a provider VS Code calls by itself (hover, inlay hints, completion,
 * definition); `command` — a command the user ran (Type at Cursor, Docs at Cursor, Show
 * Documentation, Browse Namespace…).
 */
export type QueryMode = 'passive' | 'command';

/** A query's outcome: the backend's answer, or why there is none, as one sentence of plain text. */
export type QueryOutcome<T> =
  | { readonly kind: 'answer'; readonly value: T }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Asks `doc`'s backend a question that needs `doc`'s file loaded (`IdrisBackend`, *Queries*, in
 * `backend/types.ts`). `run` resolves; it never rejects for an Idris error or a cancellation:
 *
 * 1. Restricted Mode, or a document that is not a file on disk: `unavailable`, nothing asked.
 * 2. `query` runs with `registry.backendFor(await projects.classify(doc.fileName))`. Its answer is
 *    the outcome; an `IdrisException` other than `NotLoaded`, or a cancellation, is `unavailable`
 *    with its text; any other rejection is a programming error and is rethrown.
 * 3. On `NotLoaded`, `doc` is loaded the way **Check File** loads it — `checks.check(doc)`, so
 *    that the load's diagnostics are shown and the consent question is asked where it must be —,
 *    or, when a check of `doc` is already running (`checks.runningCheck(doc)`, e.g. the one its
 *    opening started), that check is waited for instead of starting another; then `query` runs
 *    once more; `NotLoaded` again (another file of the root was loaded in between) is
 *    `unavailable`. A refusal of the load (`CheckRefusal`), of either check, is `unavailable` with
 *    its message. A `command` always loads. A `passive` query loads only when all of these hold,
 *    otherwise it is `unavailable` without loading: `doc` is the active document
 *    (`checks.activeDocument()`) — so that two visible documents of one root cannot load each
 *    other in turn, each load refreshing the other's providers —; the root's backend state is
 *    `none` (no process yet, or stopped for being idle) or `active` (`BackendRegistry.stateFor`),
 *    never after **Stop Backend**, a give-up or a refusal of its folder; and the document's
 *    `idris2.checking.trigger` is not `manual` (only Check File loads then).
 *
 * The providers keep answers per file (`queries.ts` `AnswerCache`, `StaleAnswers`): until a load
 * of any file of the root that may have changed what the compiler answers
 * (`LoadNotifications`, `rebuilt`) — an answer about a file depends on the modules it imports, so
 * a load of an edited dependency makes it stale too —, and until the document closes. A load that
 * built nothing keeps them: the compiler answers from the same build files as before.
 */
export interface DocumentQueries {
  run<T>(doc: vscode.TextDocument, mode: QueryMode, query: (backend: IdrisBackend) => Promise<T>): Promise<QueryOutcome<T>>;
}

/** What `createDocumentQueries` (`queries.ts`) needs; `extension.ts` supplies the real ones. */
export interface DocumentQueriesDeps {
  readonly registry: Pick<BackendRegistry, 'backendFor' | 'stateFor'>;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  /**
   * `check` loads a document as Check File does (never rejects), `runningCheck` is the document's
   * check already running (waited for instead of a second load); `activeDocument` for the passive rule.
   */
  readonly checks: Pick<DocumentChecks, 'check' | 'runningCheck' | 'activeDocument'>;
  /** `checking(doc.uri).trigger`, for the passive rule. */
  readonly config: Pick<Config, 'checking'>;
  readonly trust: WorkspaceTrust;
  readonly log: Log;
}

/**
 * Loads of the `check` sessions, as `IdeMode.onDidLoad` reports them (`extension.ts` passes
 * `IdeMode`, whose event has this shape; the M2 pattern of `RootRestarts`): fired once for every
 * `:load-file` of a `check` session that was answered, whatever its outcome, after the token
 * index of `file` was updated (or kept, when the load sent no highlighting). `file` is the loaded
 * document's `fileName`; `rebuilt`: the load may have changed what the compiler answers about any
 * file of `root` (`backend/ide/backend.ts` `LoadedDocument`: a module was built, the load failed,
 * or it was the process's first). The providers refresh from it: semantic tokens and inlay hints
 * fire their change events, and when `rebuilt` the answers kept for every file of `root` are
 * dropped (`queries.ts` `StaleAnswers`). Loads of the `eval` session are not reported.
 */
export interface LoadNotifications {
  readonly onDidLoad: Event<LoadedFileEvent>;
}

/** One answered load (`LoadNotifications`). */
export interface LoadedFileEvent {
  readonly root: Classification;
  readonly file: string;
  readonly rebuilt: boolean;
  /**
   * The load returned an error (`backend/ide/backend.ts` `LoadedDocument.failed`; absent: it did
   * not). The inlay hints keep no answer that shows nothing while it is the file's last load
   * (`inlayHints.ts`, *Answers a load made stale*).
   */
  readonly failed?: boolean;
}

/** What `registerIntelligence`, `registerCompletion` and `registerInlayHints` need. */
export interface IntelligenceDeps {
  readonly queries: DocumentQueries;
  readonly loads: LoadNotifications;
  /**
   * `backendFor(root)` for `tokens` and `caps`. Not `onDidChange`: IDE mode fires it at every
   * state change of a `check` session — twice per request —, so the providers refresh on
   * `loads` instead (`queries.ts` `AnswerCache`).
   */
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  /** `statusOf(doc, root)`: whether the answers are `stale` (`HoverModel.stale`). */
  readonly checks: CheckStatusSource;
  /**
   * `inlayHints()` (`idris2.inlayHints.variableTypes`) and its change event; `checking(uri).trigger`
   * for what checks a stale document again (`hover.ts` `HoverDeps.manual`).
   */
  readonly config: Pick<Config, 'inlayHints' | 'onDidChange' | 'checking'>;
  readonly log: Log;
}
