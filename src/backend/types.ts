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
 */
import type * as vscode from 'vscode';

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

/** The result of `load`: whether the load succeeded, and the diagnostics per file (F6, F7). */
export interface LoadResult {
  readonly ok: boolean;
  /** Entries in the shape `DiagnosticCollection.set` takes; a load reports errors in any file. */
  readonly diagnostics: ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]>;
}

/** The compiler's rendering `name : type` of a name at a position (`:type-of`, F30). */
export type TypeInfo = RichText;

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

/** An entry of a namespace listing (`browseNamespace`); M14 decides what else it shows. */
export interface NamespaceEntry {
  readonly name: string;
}

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

/** §3.1 */
export interface IdrisBackend {
  readonly kind: BackendKind;
  readonly caps: Readonly<Capabilities>;
  /** diagnostics */
  load(doc: vscode.TextDocument): Promise<LoadResult>;
  typeAt(doc: vscode.TextDocument, pos: vscode.Position, name: string): Promise<TypeInfo | undefined>;
  /** The compiler parses and ignores the mode on 0.8.0 and master (F31). */
  docsFor(name: string, mode: 'overview' | 'full'): Promise<RichText | undefined>;
  definition(doc: vscode.TextDocument, pos: vscode.Position, name: string): Promise<vscode.Location[]>;
  holes(doc: vscode.TextDocument): Promise<Hole[]>;
  edit(req: EditRequest): Promise<EditResult>;
  evaluate(expr: string): Promise<RichText>;
  browseNamespace(ns: string): Promise<NamespaceEntry[]>;
  dispose(): void;
}
