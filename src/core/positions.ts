/**
 * Coordinate conversions (`core/positions.ts`, docs/ARCHITECTURE.md §7) — the only module that
 * adds or subtracts 1 from a line or column, or applies the literate column offset.
 *
 * | Surface                                   | Line    | Column  | End       | Here                    |
 * |-------------------------------------------|---------|---------|-----------|-------------------------|
 * | VS Code / LSP                             | 0-based | 0-based | exclusive | `EditorPosition`        |
 * | IDE request `:type-of NAME L C`           | 1-based | 0-based | inclusive | `toIdeTypeOfRequest`    |
 * | IDE request `:case-split L C NAME`        | 1-based | 1-based | inclusive | `toIdeCaseSplitRequest` |
 * | IDE request with a line only (`:add-clause`, `:generate-def`, `:make-lemma`, `:intro`, …) | 1-based | — | — | `toIdeLineRequest` |
 * | IDE reply (`:warning`, `:name-at`, `:highlight-source`) | 0-based | 0-based | exclusive | `fromIdeReply…` |
 * | CLI text `Mod:L:C--L:C`                   | 1-based | 1-based | exclusive | `fromCli…`              |
 *
 * Sources for the request rows. `:type-of`: F2 [live], and `processEdit (TypeAt line col _)`
 * tests `within (line-1, col)` (`src/Idris/REPL.idr` 450 on master 1c630e6, 466 on v0.8.0),
 * where `within` is `start <= p && p <= end` on an end-exclusive span (`src/Core/FC.idr`) — hence
 * "inclusive": a cursor just after a name still hits it. `:case-split` uses a different
 * convention (F2, corrected in M0; §7): `processEdit (CaseSplit …)` tests
 * `within (line-1, col-1)`, and `col = 0` means "anywhere on the line" (`onLine`; REPL.idr
 * 472–478 master, 488–494 v0.8.0). Re-verified live on 0.8.0 with `vlen xs = ?vlen_rhs` on line
 * 8: `:case-split 8 C "xs"` succeeds for C = 8 (0-based column 7, the inclusive end of the
 * left-hand side `vlen xs`) and fails for C = 9 (`No clause to split here`), whereas
 * `:type-of "xs" 8 C` succeeds for C = 5, 7 and fails for C = 4 (F2) and C = 8.
 *
 * Literate offset (F11, D12). In bird-track documents (`> ` / `< ` lines, `project/literate.ts`)
 * the compiler works on the *unlit* text: every column it sends or expects on a code line is
 * `fileColumn − prefixWidth`; lines stay file lines. This holds for IDE requests and replies
 * (F11 [live]) and for CLI text as well — `idris2 --check` reports an error under
 * `> g = "x"` (file columns 6–9, 0-based) as `Err:6:5--6:8` [live, idris2 0.8.0; the source
 * excerpt it prints places the carets 2 columns too far left, i.e. at unlit columns on the raw
 * line]. Fenced literate styles (M12) have no offset; they are not in the M0 table. Whether a
 * document is bird-track is decided as the compiler decides it, by the file name
 * (`compilerLiterateStyleOf`), not by the language mode. The mapping assumes LF line breaks:
 * the compiler drops a CRLF break in a `.lidr`, joining the line to the next one (F11), so its
 * lines and columns no longer match the file's. `[lidr]` defaults `files.eol` to LF, but that
 * applies only to text without line breaks (a new file): an existing CRLF `.lidr` keeps CRLF,
 * does not compile, and is mapped wrongly here until the user converts it (README, *Editor
 * defaults*).
 *
 * Column unit. VS Code columns are UTF-16 code units; whether the compiler counts code points
 * or bytes on lines with non-ASCII characters is ROADMAP E14 (M3), not settled here: this module
 * passes column numbers through unchanged apart from the ±1 and the literate offset.
 *
 * Everything here is plain arithmetic on numbers plus the text of one line; `vscode` types are
 * satisfied structurally (`vscode.TextDocument` is a `PositionDocument`, `vscode.Position` an
 * `EditorPosition`), so the module is unit-tested on Node.
 */
import { birdPrefixWidth, compilerLiterateStyleOf, type CompiledDocument } from '../project/literate';

/** The part of a document the conversions read; `vscode.TextDocument` satisfies it. */
export interface PositionDocument extends CompiledDocument {
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
}

/** VS Code / LSP: 0-based line, 0-based column. */
export interface EditorPosition {
  readonly line: number;
  readonly character: number;
}

/** VS Code / LSP range, end exclusive. */
export interface EditorRange {
  readonly start: EditorPosition;
  readonly end: EditorPosition;
}

/** An IDE-mode request position: 1-based line; the column base depends on the command. */
export interface IdeRequestPoint {
  readonly line: number;
  readonly column: number;
}

/** An IDE-mode reply position: 0-based line, 0-based (unlit) column. */
export interface IdeReplyPoint {
  readonly line: number;
  readonly column: number;
}

/** An IDE-mode reply span, end exclusive: `(:start L C) (:end L C)`, `(L C) (L C)`. */
export interface IdeReplySpan {
  readonly start: IdeReplyPoint;
  readonly end: IdeReplyPoint;
}

/** A position in the compiler's text output `Mod:L:C--L:C`: 1-based line, 1-based column. */
export interface CliPoint {
  readonly line: number;
  readonly column: number;
}

/** A span in the compiler's text output, end exclusive. */
export interface CliSpan {
  readonly start: CliPoint;
  readonly end: CliPoint;
}

type LineKind = { code: true; offset: number } | { code: false };

/**
 * Whether file line `line` of `doc` is Idris code as the compiler sees it, and how many columns
 * the compiler strips from its start. Lines outside the document count as code with offset 0,
 * so a stale reply still maps to a position (VS Code clamps it when it is used).
 */
function lineKind(doc: PositionDocument, line: number): LineKind {
  if (compilerLiterateStyleOf(doc) !== 'bird' || line < 0 || line >= doc.lineCount) {
    return { code: true, offset: 0 };
  }
  const width = birdPrefixWidth(doc.lineAt(line).text);
  return width === undefined ? { code: false } : { code: true, offset: width };
}

/** The offset to add to a compiler column on `line`; 0 on prose lines, which have no columns. */
function replyOffset(doc: PositionDocument, line: number): number {
  const kind = lineKind(doc, line);
  return kind.code ? kind.offset : 0;
}

/**
 * `:type-of NAME L C` at `pos`, or `undefined` when `pos` is on a prose line of a literate
 * document (there is no Idris code there to ask about). A position inside the bird-track marker
 * is sent as unlit column 0.
 */
export function toIdeTypeOfRequest(doc: PositionDocument, pos: EditorPosition): IdeRequestPoint | undefined {
  const kind = lineKind(doc, pos.line);
  if (!kind.code) {
    return undefined;
  }
  return { line: pos.line + 1, column: Math.max(0, pos.character - kind.offset) };
}

/**
 * `:case-split L C NAME` at `pos` (1-based column), or `undefined` on a prose line. A position
 * inside the bird-track marker is sent as column 1, never 0, because the compiler reads column 0
 * as "anywhere on the line".
 */
export function toIdeCaseSplitRequest(doc: PositionDocument, pos: EditorPosition): IdeRequestPoint | undefined {
  const kind = lineKind(doc, pos.line);
  if (!kind.code) {
    return undefined;
  }
  return { line: pos.line + 1, column: Math.max(1, pos.character - kind.offset + 1) };
}

/** The 1-based line of the commands that take a line only (`:add-clause L NAME`, …). */
export function toIdeLineRequest(line: number): number {
  return line + 1;
}

export function fromIdeReply(doc: PositionDocument, point: IdeReplyPoint): EditorPosition {
  return { line: point.line, character: point.column + replyOffset(doc, point.line) };
}

export function fromIdeReplySpan(doc: PositionDocument, span: IdeReplySpan): EditorRange {
  return { start: fromIdeReply(doc, span.start), end: fromIdeReply(doc, span.end) };
}

export function fromCli(doc: PositionDocument, point: CliPoint): EditorPosition {
  const line = point.line - 1;
  return { line, character: point.column - 1 + replyOffset(doc, line) };
}

export function fromCliSpan(doc: PositionDocument, span: CliSpan): EditorRange {
  return { start: fromCli(doc, span.start), end: fromCli(doc, span.end) };
}
