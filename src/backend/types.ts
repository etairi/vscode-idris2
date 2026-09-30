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

/** One hypothesis in a hole's context. */
export interface Premise {
  readonly name: string;
  readonly type: RichText;
  /** Reported by idris2-lsp's `metavars` (F26); absent when the backend does not report it. */
  readonly multiplicity?: Multiplicity;
  /** Reported by idris2-lsp's `metavars` (F26); absent when the backend does not report it. */
  readonly implicit?: boolean;
}

export interface Hole {
  readonly name: string;
  readonly type: RichText;
  readonly premises: readonly Premise[];
  /** Absent when the backend cannot locate the hole (`holeLocations` false). */
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

/** §3.3 */
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

/** §3.3 */
export interface EditRequest {
  readonly kind: EditKind;
  readonly doc: vscode.TextDocument;
  readonly pos: vscode.Position;
  readonly name: string;
  readonly hints?: readonly string[];
  readonly hint?: string;
}

/** §3.3 */
export type EditResult =
  /** Lines 0-based, inclusive. */
  | { readonly type: 'replaceLines'; readonly startLine: number; readonly endLine: number; readonly text: string }
  | { readonly type: 'replaceRange'; readonly range: vscode.Range; readonly text: string }
  /** make-lemma */
  | { readonly type: 'lemma'; readonly declaration: string; readonly replacement: string }
  /** intro */
  | { readonly type: 'choices'; readonly items: readonly string[] }
  /** LSP codeAction */
  | { readonly type: 'workspaceEdit'; readonly edit: vscode.WorkspaceEdit }
  /** "No more results" */
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
   * the target's open document changed since it was saved — when none is left, `Unsupported` says
   * why. The ranges are in the target file's own columns, in the text its open document shows. A
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
  holes(doc: vscode.TextDocument): Promise<Hole[]>;
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
   * Rejects with `LoadFailed` when the file does not load (its first error in the message). The load
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
