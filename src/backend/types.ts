/**
 * The backend abstraction (`backend/types.ts`, docs/ARCHITECTURE.md §3.1 and §3.3).
 *
 * Every feature is written against `IdrisBackend`; the IDE-mode backend (M2), the idris2-lsp
 * backend (M5) and `NullBackend` (M0, `backend/null.ts`) implement it. Every method either
 * returns a typed result or throws an `IdrisException` (`core/errors.ts`); `Unsupported` is an
 * ordinary outcome that the UI turns into a sentence.
 *
 * The domain types carry only what the protocol facts in docs/ROADMAP.md §0 establish; fields
 * a backend cannot always supply are optional. The milestone that first produces a type is
 * expected to refine it with what its protocol really returns.
 *
 * Only type imports from `vscode`, so the module has no runtime dependency on it.
 *
 * M3 (ROADMAP §5 M3) refines the query methods with what the IDE protocol returns and adds
 * `completions`, `tokens` and the document argument of `docsFor`, `evaluate` and
 * `browseNamespace`: in IDE mode every answer comes from a session of the document's root, in
 * the context of the file that session loaded (`IdrisBackend`, *Queries*).
 *
 * M4 (ROADMAP §5 M4) refines `Hole`, `holes` and the edit contract of ARCHITECTURE §3.3
 * (`EditRequest`, `EditResult`, `IdrisBackend.edit`; the departures from §3.3 and their reasons are
 * in the comments of the two types). The contract is backend-neutral: M4 implements it for IDE
 * mode; `LspBackend.edit()` and `LspBackend.holes()` and the contract suite are owned by M5, which
 * ships second (ROADMAP M4 *Scope*, ownership rule).
 */
import type * as vscode from 'vscode';
import type { EditorRange } from '../core/positions';

export type BackendKind = 'ideMode' | 'lsp' | 'null';

export interface Capabilities {
  /** load + errors */
  diagnostics: boolean;
  hover: boolean;
  definition: boolean;
  completion: boolean;
  signatureHelp: boolean;
  semanticTokens: boolean;
  documentSymbols: boolean;
  documentHighlights: boolean;
  holes: boolean;
  /** LSP `metavars` has locations; IDE mode resolves them via `:name-at` (F2). */
  holeLocations: boolean;
  editing: boolean;
  /** `-next` cycling: native in IDE mode; partial over LSP. */
  editingNext: boolean;
  intro: boolean;
  refine: boolean;
  missingCases: boolean;
  evaluate: boolean;
  docs: boolean;
  browseNamespace: boolean;
  /** true only for the shadow backend (M6) */
  checksUnsaved: boolean;
}

/**
 * The compiler's decoration kinds (`Protocol/IDE/Decoration.idr`, identical on master 1c630e6
 * and v0.8.0): `(:decor :type)` etc. in IDE replies (F30, F33).
 */
export type Decor =
  | 'comment'
  | 'type'
  | 'function'
  | 'data'
  | 'keyword'
  | 'bound'
  | 'namespace'
  | 'postulate'
  | 'module';

/**
 * Text with highlighted spans, as IDE replies carry it: `(:ok "xs : Vect ?_ ?_" ((5 4
 * ((:decor :type)))))` is `xs : Vect ?_ ?_` with a `type` span at offset 5, length 4 (F30).
 */
export interface RichText {
  readonly text: string;
  readonly spans: readonly RichTextSpan[];
}

export interface RichTextSpan {
  /** Offset into `RichText.text`. */
  readonly start: number;
  readonly length: number;
  readonly decor?: Decor;
}

/** The result of `load`: whether the load succeeded, and the diagnostics per file (F6, F7, F10). */
export interface LoadResult {
  /** The compiler accepted the file (`(:return (:ok …))` in IDE mode). */
  readonly ok: boolean;
  /**
   * Entries in the shape `DiagnosticCollection.set` takes, for every file whose diagnostics this
   * load determined — an empty list for a file it checked and found clean — and none for a file
   * it did not check again: a reload whose TTC is fresh sends neither a `Building` line nor
   * `:warning` frames (F7), so the diagnostics shown for that file still apply and are kept. A
   * load reports problems in any file (an imported module, or the `.ipkg` for a package-file
   * error, F10).
   */
  readonly diagnostics: ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]>;
  /**
   * Set when the load stopped at the package file: the compiler could not read the root's
   * `.ipkg` (F10), and `message` is its error. The document's `loadState` is then `ipkgError`
   * (ARCHITECTURE §6.1).
   */
  readonly packageError?: { readonly uri: vscode.Uri; readonly message: string };
  /**
   * Set when the loaded document was not checked because the compiler reported errors in other
   * files it imports (its only diagnostic then says so): those files. Fixing them does not change
   * the document's own diagnostics, so the checks check it again once they are clean.
   */
  readonly blockedBy?: readonly vscode.Uri[];
}

/**
 * The compiler's rendering `name : type` of a name (`:type-of`, F30): `xs : Vect ?_ ?_` for the
 * pattern variable `xs` of `vlen xs = ?vlen_rhs`, with the reply's highlighting.
 */
export interface TypeInfo extends RichText {
  /**
   * How the name was looked up: `position` — `(:type-of "NAME" L C)` (F2), which answers for the
   * occurrence at that position, local variables included; `name` — `(:type-of "NAME")`, the
   * fallback when the positional request found nothing there (an operator section, a name the
   * compiler recorded no position for), which answers for a global name and so may describe
   * another name than a local one that shadows it. The UI says which (ARCHITECTURE §1 goal 4).
   */
  readonly lookup: 'position' | 'name';
}

/** 0 or 1, or unrestricted (no annotation). */
export type Multiplicity = 0 | 1 | 'unrestricted';

/** One hypothesis in a hole's context: a local variable in scope at the hole. */
export interface Premise {
  readonly name: string;
  readonly type: RichText;
  /**
   * IDE mode: the prefix of the premise in `:metavariables` — `" 0  n"`, `" 1  x"`, `"  xs"`
   * (unrestricted) [live, prep of M4: `consume x xs = ?todo` of `consume : (1 x : a) -> Vect n a ->
   * Vect (S n) a`]; idris2-lsp's `metavars` reports it too (F26). Absent when the backend does not
   * report it.
   */
  readonly multiplicity?: Multiplicity;
  /** Reported by idris2-lsp's `metavars` (F26); IDE mode does not say (the implicit `n` and `a` above look like `x`). */
  readonly implicit?: boolean;
}

/** How `IdrisBackend.holes` answers. */
export interface HolesOptions {
  /**
   * Also the holes the backend kept from the file's last answered load when the session has loaded
   * another file since, instead of `NotLoaded`: for the holes view, which refreshes after each load
   * and must not lose a file's holes because another file of a batch of visible documents was loaded
   * before it asked (IDE mode: kept while the file has an open document). A caller that shows the
   * holes of the text on disk now (List Holes) leaves it out, loads the file and asks again.
   */
  readonly kept?: boolean;
  /**
   * List Holes' Cancel: a cancellation rejects with the `Cancelled` error at once and, while the
   * listing has not answered, restarts the `check` session of the file's root (IDE mode cannot stop a
   * request in flight; `backend/ide/backend.ts`, *Holes*).
   */
  readonly token?: vscode.CancellationToken;
}

/** A hole (`?name`) the compiler knows, with its goal and context (ARCHITECTURE §9). */
export interface Hole {
  /** The name after `?`, unqualified: `vlen_rhs`. */
  readonly name: string;
  /**
   * The name as the compiler qualifies it: `Clean.vlen_rhs` (IDE mode: the quoted name of a
   * `:metavariables` entry, ARCHITECTURE §9). Holes of one name in two modules differ here (E16).
   */
  readonly qualifiedName: string;
  /** The goal: the type the hole must have. */
  readonly type: RichText;
  /** The local variables in scope at the hole, in the compiler's order. */
  readonly premises: readonly Premise[];
  /**
   * Where the hole is: the file, and the range of its `?name` token in that file's editor
   * coordinates as the load that reported it read the file (IDE mode: the `:name-at` span, which
   * covers the `?` [live, F2 and prep of M4]). It is not moved to the text an editor shows now: a
   * consumer that shows it in a document changed since finds the `?name` there itself
   * (`features/holes/types.ts`). Absent when the backend cannot locate the hole (`holeLocations`
   * false, or IDE mode's `:name-at` has no entry of this `qualifiedName`).
   */
  readonly location?: vscode.Location;
}

/**
 * An entry of a namespace listing (`browseNamespace`, M3; M14's namespace browser may show more).
 * In IDE mode `(:browse-namespace "NS")` answers one text listing the names of `NS` visible from
 * the loaded file as `[multiplicity ]NAME : TYPE` (`getContents`/`summarise`,
 * `src/Idris/Doc/String.idr` 671–707 on v0.8.0 [src]), recorded [live, transcript
 * `clean-queries`]: one entry per line, sorted by name (`(|+|)` last), without continuation lines
 * even at 196 characters (`Data.Vect`, 84 entries); a hole listed with its multiplicity
 * (`1 vlen_rhs : …`), which `name` drops; private names not listed; `""` for a namespace that is
 * unknown or not imported. The backend still joins a line that starts with white space to the
 * previous entry, since the listing is laid out by the pretty-printer (`hang 0 ty` [src]).
 */
export interface NamespaceEntry {
  /** The name as the listing shows it. */
  readonly name: string;
  /** The whole entry, `NAME : TYPE` with its highlighting (offsets into this entry's text). */
  readonly signature: RichText;
}

/**
 * One entry of the compiler's `:highlight-source` output for a file (F33), in editor
 * coordinates. The compiler supplies name, decoration and span only: `:type` and
 * `:doc-overview` are always `""` on 0.8.0 and master (F33), so types and docs come from
 * `typeAt` and `docsFor`.
 */
export interface Token {
  /**
   * 0-based, end exclusive, in the file's own columns: the bird-track offset of a `.lidr` is
   * applied (`core/positions.ts` `fromIdeReplySpan`, F11). May span lines (a block comment).
   */
  readonly range: EditorRange;
  readonly decor: Decor;
  /** Present on names (the compiler's `Highlight`); absent on keywords, comments and the like. */
  readonly name?: string;
  /**
   * The name's namespace as sent: `""` for bound names and for the occurrence in a type
   * declaration, the module on a definition's left-hand side (F33) — not a way to tell names apart.
   */
  readonly namespace?: string;
  /** Whether the compiler marked the occurrence implicit. */
  readonly implicit?: boolean;
}

/**
 * The tokens of one file from the last load of it that sent highlighting (`IdrisBackend.tokens`).
 * In IDE mode the frames of a load cover the loaded file only (an imported module that was built
 * by the same load sends none [live, transcript `load-simple-ipkg`]), and a load that returns an
 * error sends none [live, 0.8.0: every recorded load that returned `:error`, e.g. `load-bad`,
 * `load-part`, `load-mixed`], so an index can be older than the file's last load.
 */
export interface TokenIndex {
  /** The file, as the document's `fileName`. */
  readonly file: string;
  /**
   * The text the tokens describe: the file as the load read it — in IDE mode read from disk right
   * before the load was written and again when its reply arrived, and given only when both reads
   * agree —; absent when that is not known (the file could not be read, or changed during the
   * load). A document that shows exactly this text, with no unsaved changes, is described by the
   * tokens; for another text their ranges may be off (a consumer maps or drops them). (*Review of
   * M3*: the index carried the document version the load was requested for, which a document
   * closed and opened again has anew, so an old index was taken to describe a changed file.)
   */
  readonly text?: string;
  /**
   * Sorted by start, then end; an entry the compiler sent twice appears once. Tokens may overlap.
   * Decorations this version does not know are left out.
   */
  readonly tokens: readonly Token[];
}

/**
 * The answer of `evaluate`: the value as the compiler prints it (an IO action normalised, not
 * run; ROADMAP §9, 2026-09-28), or the compiler's error about the expression (a type error, an
 * undefined name) — an answer, not a failure.
 */
export type Evaluation =
  | { readonly kind: 'value'; readonly value: RichText }
  | { readonly kind: 'error'; readonly message: RichText };

/**
 * §3.3: what an interactive editing command asks the compiler for (ROADMAP §5 M4). In IDE mode
 * each kind is one request (F2, F29, F30; ARCHITECTURE §7 for the line and column conventions):
 *
 * | Kind | `pos` / `name` | IDE-mode request (1-based compiler lines, `core/positions.ts`) |
 * |---|---|---|
 * | `caseSplit` | on the pattern variable / it | `(:case-split L C "name")`, C 1-based (F2) |
 * | `addClause` | on the type declaration / the function | `(:add-clause L "fn")`, L the declaration's line |
 * | `makeLemma`, `makeWith`, `makeCase` | on the hole / its name without `?` | `(:make-lemma L "hole")`, `(:make-with …)`, `(:make-case …)` (the hole's name, as recorded in `clean-editing`) |
 * | `exprSearch` | on the hole / its name | `(:proof-search L "hole" (HINTS…))` — the plain form: the `:all` flag is ignored (F31) |
 * | `exprSearchNext` | — | the bare symbol `:proof-search-next` (F4) |
 * | `generateDef` | on the type declaration / the function | `(:generate-def L "fn")`, L the declaration's line (F2) |
 * | `generateDefNext` | — | the bare symbol `:generate-def-next` |
 * | `intro` | on the hole / its name | `(:intro L "hole")` → the candidates (F29) |
 * | `refine` | on the hole / its name | `(:refine L "hole" "EXPR")` → one string, or the ambiguity error (F29) |
 * | `addMissingCases` | on the declaration of the function a coverage error names / it | `(:interpret ":missing fn")` (F15; `:add-missing` is a stub, F3) |
 */
export type EditKind =
  | 'caseSplit'
  | 'addClause'
  | 'makeLemma'
  | 'makeCase'
  | 'makeWith'
  | 'exprSearch'
  | 'exprSearchNext'
  | 'generateDef'
  | 'generateDefNext'
  | 'intro'
  | 'refine'
  | 'addMissingCases';

/** What every `EditRequest` has. */
interface EditRequestBase {
  readonly doc: vscode.TextDocument;
  /**
   * `doc.version` when the command asked (an addition to §3.3). The result is computed for the text
   * of that version, and the caller applies it only while `doc.version` is still `version` — else
   * it is discarded and the user told so (`features/editing/types.ts`). IDE mode answers a request
   * that names a place (`EditAtRequest`, `ExprSearchRequest`, `RefineRequest`) only while its
   * `check` session's last load of `doc`'s file is known to have read `doc`'s text at `version`
   * (the text `TokenIndex.text` describes), since the compiler reads the lines it edits from the
   * text it loaded (`core/config.ts` `SaveBeforeAction`); otherwise it rejects with `NotLoaded`,
   * having sent nothing, like a query.
   */
  readonly version: number;
  /**
   * Cancels the request. Before it is sent it is dropped; once sent, IDE mode stops the root's
   * `check` session and starts it again (ARCHITECTURE §5.1: the protocol has no cancel; ROADMAP M4
   * *Risks*: "cancel kills/respawns"). Either way the promise rejects with the `Cancelled` error
   * (`core/errors.ts`). The commands pass one for the long kinds (`exprSearch`, `generateDef`, their
   * `-Next`, `refine`, `intro`, `makeLemma` and `addMissingCases`), whose progress notification offers
   * Cancel.
   */
  readonly token?: vscode.CancellationToken;
}

/**
 * A request about something at `pos` in `doc` (table above). `name` is taken from `doc`'s text (or
 * from a code action's argument) and is untrusted: the backend refuses, with `Unsupported` and
 * before anything is sent, a name that is not an Idris name as the compiler's lexer reads one —
 * an identifier (Unicode letters included, F18) for a hole or a pattern variable, an identifier
 * or an operator in parentheses for a function —, so that nothing typed in a file can turn
 * `(:interpret ":missing NAME")` into another REPL command (hard requirement of M4; `:missing` is
 * the one request whose name the compiler parses, `process (Interpret …)`; the others make a name
 * of the string as it is, `IDEMode/REPL.idr` 143–199 on v0.8.0 [src]).
 */
export interface EditAtRequest extends EditRequestBase {
  readonly kind: 'caseSplit' | 'addClause' | 'makeLemma' | 'makeCase' | 'makeWith' | 'generateDef' | 'intro' | 'addMissingCases';
  readonly pos: vscode.Position;
  readonly name: string;
}

/** `exprSearch`: as `EditAtRequest`, with the names the search may use. */
export interface ExprSearchRequest extends EditRequestBase {
  readonly kind: 'exprSearch';
  readonly pos: vscode.Position;
  readonly name: string;
  /** `(:proof-search L "hole" (HINTS…))`: each a name, checked as `name` is; `[]` for none. */
  readonly hints: readonly string[];
}

/** `refine`: as `EditAtRequest`, with the expression to refine the hole with. */
export interface RefineRequest extends EditRequestBase {
  readonly kind: 'refine';
  readonly pos: vscode.Position;
  readonly name: string;
  /**
   * The expression the user typed (**Refine Hole…**'s input box). It goes only into the string
   * argument of `(:refine L "hole" "EXPR")`, through the s-expression encoder, never into a
   * command's text. The compiler parses it as an expression (`aPTerm`, `IDEMode/REPL.idr` 179) and
   * checks it, applied to new holes, against the hole's type (`checkTerm`, `processEdit (Refine …)`,
   * `Idris/REPL.idr` 525–607 on v0.8.0 [src]); so, like Evaluate, it can run the elaborator scripts
   * the expression reaches [live, idris2 0.8.0: a macro application and a `%runElab` each wrote a
   * file] — accepted, documented and not refused (ROADMAP §9 Q24, decided 2026-09-30 under Q23).
   */
  readonly hint: string;
}

/**
 * `exprSearchNext`, `generateDefNext`: the next result of the search that the backend's last
 * `exprSearch` (or `generateDef`) request in `doc`'s root started for `doc`. Nothing names a place:
 * the compiler keeps one search of each kind (`psResult`, `gdResult` in `Idris/REPL/Opts.idr`
 * [src]); every load resets both (`loadMainFile` → `resetProofState`, `Idris/REPL.idr` 833–845 on
 * v0.8.0 [src]), and a new search of the same kind replaces it. So the backend rejects with
 * `Unsupported` ("… has ended …"), sending nothing, when that session has loaded a file, run a search
 * of its kind or a raw request, or stopped since, or when the search was not started for `doc`;
 * `version` is the text as the caller's last applied result left it.
 */
export interface NextRequest extends EditRequestBase {
  readonly kind: 'exprSearchNext' | 'generateDefNext';
  /**
   * Where the previous result of the search is in `doc`'s text at `version` (the cycling
   * controller follows it, ARCHITECTURE §10); the next result replaces it.
   */
  readonly previous: EditorRange;
}

/**
 * §3.3, refined by M4: a union by kind (§3.3 has one interface whose `name`, `hints` and `hint`
 * every kind carries), so that each kind carries exactly the arguments it needs, and `version`
 * and `token` added (above).
 */
export type EditRequest = EditAtRequest | ExprSearchRequest | RefineRequest | NextRequest;

/**
 * A change of the request's document: `range` — editor coordinates (0-based, UTF-16 columns) in
 * the text of `EditRequest.version`, empty for an insertion — replaced by `text`, whose lines are
 * separated by `\n` (the caller writes the document's own line breaks).
 */
export interface TextReplacement {
  readonly range: EditorRange;
  readonly text: string;
}

/** One candidate of a `choices` result. */
export interface EditChoice {
  /**
   * The candidate as the compiler printed it (`S ?vlen_rhs_0`, `Ambig.A.foo ?g_rhs_0`): untrusted
   * text (`core/untrustedText.ts` `quickPickText` in a QuickPick).
   */
  readonly label: string;
  /**
   * The edit that choosing it makes, as an `edit` result's (IDE mode puts a candidate of more than one
   * token in parentheses there, `backend/ide/edits.ts` `inPlace`).
   */
  readonly replacements: readonly TextReplacement[];
}

/**
 * §3.3, refined by M4. §3.3's `replaceLines`, `replaceRange`, `lemma` and `workspaceEdit` are one
 * `edit` result, a list of replacements of the request's document, for two reasons: every result
 * then changes only the document the request came from, by construction (a hard requirement of M4 —
 * the idris2-lsp backend of M5 converts the server's `WorkspaceEdit` and refuses one that changes
 * another document), and the ranges, whose rules are protocol facts (E15; a make-lemma's two
 * places, a clause's lines, a literate prefix, F11), are computed once, in the backend, not in each
 * feature that applies a result. Two variants are added: `choices` also carries Refine's ambiguity
 * (F29), and `failed` the compiler's error answers.
 */
export type EditResult =
  /**
   * The edit to make, in the text of `EditRequest.version`: replacements that do not overlap, to be
   * applied together as one undo step. For `exprSearch`, `exprSearchNext`, `generateDef` and
   * `generateDefNext` exactly one — the result, whose range the cycling controller then follows.
   */
  | { readonly type: 'edit'; readonly replacements: readonly TextReplacement[] }
  /**
   * Candidates for the user to pick one of: `intro`, one per candidate the compiler offers (F29; a
   * single one is applied without asking); `ambiguous`, the qualified alternatives of the
   * compiler's `Ambiguous elaboration` answer to `refine` (F29; IDE mode only, F34).
   */
  | { readonly type: 'choices'; readonly reason: 'intro' | 'ambiguous'; readonly choices: readonly EditChoice[] }
  /**
   * The compiler answered without an edit: an error (`No clause to split here`, F15; `No search
   * results`; …), or `:missing`'s text when there is nothing to add (`Edits.count: All cases
   * covered`, `Part.main: Calls non covering function Part.g`). Its message as sent, untrusted
   * text. An answer, not a failure: the caller rephrases the ones it knows (ROADMAP M4) and shows
   * the others as they are.
   */
  | { readonly type: 'failed'; readonly message: string }
  /** A `-Next` request found no further result (the compiler's `No more results`). */
  | { readonly type: 'exhausted' };

/**
 * How `IdrisBackend.load` queues a load (ROADMAP §9 Q21, docs/as-built/M2.md, *Resource limits*;
 * an addition to ARCHITECTURE §3.1, recorded there).
 */
export interface LoadOptions {
  /**
   * Asked each time the backend chooses the next request for the root's compiler: while it returns
   * true, this load goes before the root's other requests that wait and are not being sent yet.
   * The IDE-mode backend hands it to the session (`RequestOptions.urgent`); a backend without a
   * queue of its own ignores it. The checks set it for the active document's load.
   */
  readonly urgent?: () => boolean;
}

/**
 * §3.1, as refined by M3.
 *
 * **Queries** (`typeAt`, `docsFor`, `definition`, `completions`, `browseNamespace`; M3). In IDE
 * mode each is answered by the `check` session of `doc`'s root, in the context of the file that
 * session loaded last: the compiler keeps one loaded file, a positional request refers to that
 * file's text (F2), and the names in scope are those of that file and its imports. When the file
 * loaded last is not `doc`'s — another document of the root was checked after it, or the session
 * has no process (never started, stopped for being idle, by **Stop Backend**, after a crash) —
 * the method rejects with `NotLoaded` (`core/errors.ts`) at once, having sent and started
 * nothing; when it is, the request is sent with a check, right before it is written, that it
 * still is (a load queued before it may change it), and rejects with `NotLoaded` otherwise. A
 * query never loads a file itself: a load may compile and write build files, and its diagnostics
 * must reach the checks, since a later load of a file whose build files are up to date reports
 * nothing (F7). The caller loads the document the way the checks do and asks again
 * (`features/intelligence/types.ts` `DocumentQueries`). An answer refers to the file as it was
 * saved when it was loaded, not to unsaved text. Queries are `lookup` requests
 * (`idris2.ideMode.requestTimeout`).
 *
 * **Evaluation** (`evaluate`; M3, ROADMAP §9 2026-09-28) runs in the root's `eval` session, never
 * in the `check` session (F27), and needs no load by the caller: see the method.
 */
export interface IdrisBackend {
  readonly kind: BackendKind;
  readonly caps: Readonly<Capabilities>;
  /** diagnostics */
  load(doc: vscode.TextDocument, options?: LoadOptions): Promise<LoadResult>;
  /**
   * The type of `name` at `pos` (the editor position of the occurrence in the text `doc` shows: its
   * token's start, or the cursor on it): the positional `:type-of` first (in IDE mode once more one
   * code point further when a local that ends right at `pos` answered, `IdeBackend.typeAt`), then by
   * name (`TypeInfo.lookup`) — but not by name when `decor` is `bound` (the caller's token index
   * says the occurrence is a local variable: by name the compiler would describe a global the local
   * shadows); `undefined` when the compiler knows neither, or when `pos` is on a prose line of a
   * literate document (`core/positions.ts` `toIdeTypeOfRequest`). The compiler answers a positional
   * request for whichever local is at the position, whatever name is asked [live, transcript
   * `unicode-columns`]: an answer that describes another local than `name` is not taken, and the
   * lookup by name is used instead. While `doc` shows other text than the file its answers refer to
   * (unsaved changes), `pos` is asked about where it is in that file, as far as that is known (IDE
   * mode: `IdeBackend.typeAt`). A query (above).
   */
  typeAt(doc: vscode.TextDocument, pos: vscode.Position, name: string, decor?: Decor): Promise<TypeInfo | undefined>;
  /**
   * The documentation of `name` as the compiler prints it (`:docs-for`), `undefined` when it has
   * none. The compiler parses and ignores the mode on 0.8.0 and master (F31), so in IDE mode both
   * modes give the full text and the caller takes the overview (the first paragraph) itself. A
   * query (above).
   */
  docsFor(doc: vscode.TextDocument, name: string, mode: 'overview' | 'full'): Promise<RichText | undefined>;
  /**
   * Where `name` (the occurrence at `pos`) is defined: in IDE mode by name (`:name-at`; the
   * positional form is a stub, F2, F3), so a shadowed name would find the global definitions. An
   * occurrence whose `decor` is `bound` (a local variable, by the caller's token index) is refused
   * with `Unsupported`; a qualified `name` is asked unqualified and only its own entries are kept;
   * `namespace` (the occurrence's `Token.namespace`) keeps only the definitions in that namespace
   * when there are any. Absolute paths only: an entry whose file is `(Interactive)` or
   * `(File-Not-Found)` is left out, and so is one whose file cannot be read (an installed package
   * without its sources, or a path that is not a regular file), or whose range starts on a line of
   * the target's open document changed since the file was read (the loaded file: since its load
   * read it; another file: since it was saved) — when none is left, `Unsupported` says why. A change
   * of another file on disk that no load has built since goes unseen: a save under the `manual`
   * trigger, and under any trigger a change made outside VS Code (a checkout, a formatter, a code
   * generator); its range is converted with the newer text and may be off, and with an open
   * document of it the result depends on whether Go to Definition read the file before the change
   * (the first read is kept per load; ARCHITECTURE §3.1). The ranges are in the target file's own
   * columns, in the text its open document shows; in a file that is not literate, a text that
   * differs from the one read only in its line breaks is mapped exactly (a lone `\r`,
   * `core/positions.ts` `textMap`). In a literate file the unlit step reads a lone `\r` otherwise,
   * which is not modelled (such files need LF line breaks, `core/positions.ts` *Literate lines*). A
   * query (above).
   */
  definition(doc: vscode.TextDocument, pos: vscode.Position, name: string, decor?: Decor, namespace?: string): Promise<vscode.Location[]>;
  /**
   * (M3) The names in scope that start with `prefix` (the identifier being typed), as the compiler
   * shows them — unqualified — without duplicates. In IDE mode `(:repl-completions "…")` completes
   * a run of letters and digits (`parseTask`, `src/TTImp/Interactive/Completion.idr` 25–42 on
   * v0.8.0 [src]) and ignores namespaces [live: `Data.V` gives `Vect`, `Void`, `View`], so the
   * backend reduces a qualified `prefix` to its root, sends the leading run of the root that the
   * compiler completes as a whole (`vlen_r` sends `vlen`), and filters the answer by the root —
   * which also drops machine names such as `{a:7607}` [live]; `[]` without a request when the root
   * starts with `_` or an operator. The first completion after a load took 0.1–1.0 s, the later
   * ones about 1–3 ms (docs/measurements/first-load.md [live]). Keywords and `%`-directives are not
   * included. A query (above).
   */
  completions(doc: vscode.TextDocument, prefix: string): Promise<readonly string[]>;
  /**
   * (M4) The holes the compiler knows after its last load of `doc`'s file: those of `doc`'s module
   * and of the modules it imports [live, prep of M4: after `(:load-file "Main.idr")` of a module
   * importing `Base`, `(:metavariables 80)` listed the holes of both; after one of `Base.idr`, only
   * `Base`'s]. Never loads (a query, above); `NotLoaded` when the backend has no answer for that
   * load and it is not the session's last. In IDE mode `(:metavariables W)`, then `(:name-at "NAME")`
   * per unqualified name (F2: the qualified form answers `()`), at most `MAX_LOCATED_NAMES`
   * (`backend/ide/holes.ts`) names per load, whose answer lists every hole of that name —
   * `Base.todo` and `Main.todo` for `todo` [live, the same probe] — and the entry of the hole's
   * `qualifiedName` is its location (E16); asked right after each load and kept per load
   * (`backend/ide/backend.ts`, *Holes*). `:metavariables` also
   * lists declarations without clauses and definitions that failed; they are left out (their
   * `:name-at` span is the declaration, not a `?name`). `[]` when there are none. With
   * `HolesOptions.kept`, the holes of the file's last answered load also after the session has
   * loaded another file.
   */
  holes(doc: vscode.TextDocument, options?: HolesOptions): Promise<Hole[]>;
  /**
   * (M4) The edit `req` asks for (`EditRequest`, `EditResult`; ARCHITECTURE §3.3, §10). Like a query
   * it is answered by the `check` session of `doc`'s root in the context of the file it loaded last
   * and never loads: it rejects with `NotLoaded`, having sent and started nothing, when that load is
   * not of `doc`'s file or did not read `doc`'s text at `req.version` — the lines the document shows
   * are those the load read, line breaks aside (`EditRequestBase.version`; the continuing kinds
   * excepted, `NextRequest`); the caller saves — `idris2.checking.saveBeforeAction`
   * —, loads and asks again (`features/editing/types.ts`). A compiler error is an answer (`failed`).
   * It rejects with `Unsupported`, sending nothing: for a name that is not an Idris name
   * (`EditAtRequest`); for a search that ended (`NextRequest`); after a load that returned an error,
   * for `caseSplit`, `addClause` and `generateDef`, which find their place by line (F16 does not hold
   * for them [live, transcripts `hole-errors`, `part-editing`]); and where the compiler would read
   * another line than the one it finds its place at — the compiler's lines of a bird-track file are
   * its unlit lines, where a line of a marker and white space only counts twice (F11 addendum), but
   * `getSourceLine` takes line L of the raw text (`Idris/REPL/Opts.idr` 129–133 on v0.8.0 [src]):
   * `caseSplit` below such a line; `addClause` and `generateDef` there when the line read has another
   * marker; the three in a literate file with a `\r` or any file with a lone `\r`. `makeLemma`,
   * `makeCase` and `makeWith` are sent the raw source line and work there (`backend/ide/edits.ts`).
   * `intro`, `refine`, `exprSearch` and `addMissingCases` are not affected: their replies are
   * expressions or printed clauses. Time limits:
   * `idris2.ideMode.longActionTimeout` for `exprSearch`, `generateDef`, their `-Next`, `refine`,
   * `intro`, `makeLemma` and `addMissingCases` (`longAction`), `idris2.ideMode.requestTimeout` for the
   * others; a time-out rejects with
   * `RequestTimeout` and restarts the session, as for any request (ARCHITECTURE §5.1) — for a
   * `longAction` without counting towards giving up (`backend/ide/session.ts`).
   */
  edit(req: EditRequest): Promise<EditResult>;
  /**
   * (M3) Evaluates `expr` in the context of `doc`'s saved file, in the root's `eval` session
   * (started at the first evaluation, through the same trust, toolchain and consent checks as the
   * `check` session; `backend/ide/types.ts` `SessionRole`), which loads `doc`'s file before every
   * evaluation (so that it sees the file and its imports as saved now); evaluations run one at a
   * time per `eval` session. **Expressions only** (ROADMAP §9, 2026-09-28): text
   * the compiler's REPL parser would read as a command (`:exec`, `:sh`, `:set …`, `:q`, …, however
   * it is spelled or preceded) is refused before anything is sent or started, with `Unsupported`
   * whose reason says so; nothing that sends to the `eval` session changes its evaluation mode.
   * Elaborator scripts the expression reaches (a `%macro` applied by name, `%runElab` where
   * `ElabReflection` is on) are not refused: they run (ROADMAP §9 Q23, accepted 2026-09-29; the
   * README's *Privacy and security* says so). Rejects with `LoadFailed` when the file does not load (its first error in the message). The load
   * runs under `idris2.ideMode.longActionTimeout`, the evaluation under `idris2.eval.timeout`
   * (`RequestTimeout`; the `eval` session's process is stopped). Cancelling `token` stops the
   * evaluation — in IDE mode by stopping the `eval` session's process — and rejects with the
   * `Cancelled` error (`core/errors.ts`).
   */
  evaluate(doc: vscode.TextDocument, expr: string, token?: vscode.CancellationToken): Promise<Evaluation>;
  /**
   * (M3) The names `ns` exports that are visible from `doc`'s file (`:browse-namespace`); `[]`
   * when there are none. A query (above).
   */
  browseNamespace(doc: vscode.TextDocument, ns: string): Promise<NamespaceEntry[]>;
  /**
   * (M3) The token index of `doc`'s file (`TokenIndex`), or `undefined` when no load of it sent
   * highlighting yet. Synchronous: it reads what the loads left; nothing is sent.
   */
  tokens(doc: vscode.TextDocument): TokenIndex | undefined;
  dispose(): void;
}
