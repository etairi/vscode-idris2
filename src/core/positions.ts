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
 * `fileColumn − prefixWidth`. This holds for IDE requests and replies (F11 [live]) and for CLI
 * text as well — `idris2 --check` reports an error under `> g = "x"` (file columns 6–9, 0-based)
 * as `Err:6:5--6:8` [live, idris2 0.8.0; the source excerpt it prints places the carets 2 columns
 * too far left, i.e. at unlit columns on the raw line]. Org's `#+IDRIS:` lines are line markers
 * too (`styleOrg`), with an offset of 9 [live, second review of M3]; the lines of its
 * `#+BEGIN_SRC` blocks, like the fenced styles' (M12), have none (E19).
 *
 * Literate lines (F11 addendum, second review of M3). The unlit text has one line per file line,
 * except that a marker followed only by white space (`> `, `>   `, `#+IDRIS: `) becomes **two**
 * lines (`project/literate.ts` `isDoubledLine`; the cause is in `reduce` of
 * `src/Libraries/Text/Literate.idr`) — a marker alone (`>`) does not. So the compiler's line of a
 * file line is the file line plus the number of such lines above it (`compilerLine`), in requests,
 * replies and CLI text alike [live, idris2 0.8.0: after `> ` on file line 6 and `>   ` on file
 * line 12 (0-based), `(:name-at "g")` answered line 8 for `g` on file line 7 and `(:name-at "k")`
 * line 15 for file line 13, and `:highlight-source` the same; `idris2 --check` gave `E:8:5--8:8`
 * for an error on file line 7 (1-based) below a `> ` line]. The extra line of the unlit text is
 * empty; a reply position on it is mapped to the end of the file line it comes from
 * (`fileLine`). VS Code's Enter rule of `.lidr` files (M0) makes such lines: a new line after a
 * code line starts with `> `. Whether a document has line markers is decided as the compiler
 * decides it, by the file name (`compilerLiterateStyleOf`), not by the language mode. The mapping
 * assumes LF line breaks. `reduce` keeps a line break only when it is exactly `"\n"`, so in every
 * literate style it drops each CRLF break outside code (F11): in a `.lidr` that joins a line to the
 * next one, and a CRLF `.lidr` does not compile; in a fenced file (`.idr.md`) the prose lines' and
 * the closing fence's breaks are lost, so a CRLF file still compiles, with every compiler line
 * after prose smaller than its file line by the breaks dropped above it [live, third review of
 * M3: `idris2 --check` on a CRLF `X.md` with four lines of prose and blank lines before its block
 * reported an error on file line 9 as `X:5:5--5:8`, the LF file as `X:9:5--9:8`]. Neither is
 * mapped here: the fenced styles are M12's (E19). `[lidr]` defaults `files.eol` to LF, but that
 * applies only to text without line breaks (a new file), and markdown has no such default; the
 * README's *Known limitations* asks for LF.
 *
 * Column unit (ROADMAP E14, settled in M3). VS Code columns count UTF-16 code units; the
 * compiler's columns count **code points**, in requests and in replies [live, 2026-09-29,
 * transcript `unicode-columns`: on `α x₁ y = x₁ + y` the local `y` answers `(:type-of "y" 12 C)`
 * at C = 5–6 and 14–15, and on `astral s = ("𝕟𝕟", s)` the local `s` at C = 18–19, where UTF-8
 * bytes would give 8–9, 19–20 and 24–25 and UTF-16 units 20–21; a combining mark counts as a code
 * point of its own, not with its base (C = 21–22 on `combining t = ("é", t)`); `:highlight-source`
 * and `:name-at` replies count the same way]. The reason [src, v0.8.0]: the lexer counts the
 * elements of `fastUnpack str`, a `List Char` whose `Char`s are code points
 * (`Libraries/Text/Lexer/Tokenizer.idr` 84–90, 140), and every file context — of a `:warning`, of
 * `:highlight-source`, of `:name-at`, of the CLI text — is made of those counts; the `:warning`
 * and CLI rows were not recorded on a line with a character outside the BMP [reasoned from that
 * source]. So every column is converted with the text of its line (`codePointsBefore`,
 * `utf16Length`): only characters outside the Basic Multilingual Plane, two UTF-16 units and one
 * code point each, make the two counts differ, and on a line without them the column passes
 * through unchanged. A reply column beyond the end of the line (a stale reply) counts one unit
 * per code point there. A document without text (`lineCount` 0: the caller has none) is taken as
 * having no such characters. The highlighting offsets inside a reply's text count code points
 * too [live, transcript `plain`: `Visibility` at 94 in a `:docs-for` answer where it is at UTF-16
 * offset 96, after two U+1D55F]; `backend/ide/protocol.ts` converts them with the same functions.
 *
 * Everything here is plain arithmetic on numbers plus the text of one line, except the line
 * correspondence of two texts (`lineCorrespondence`, a line diff); `vscode` types are
 * satisfied structurally (`vscode.TextDocument` is a `PositionDocument`, `vscode.Position` an
 * `EditorPosition`), so the module is unit-tested on Node.
 */
import { compilerLiterateStyleOf, hasLineMarkers, isDoubledLine, isIdrisSpace, linePrefixWidth, type CompiledDocument, type LiterateStyle } from '../project/literate';

/** The part of a document the conversions read; `vscode.TextDocument` satisfies it. */
export interface PositionDocument extends CompiledDocument {
  /**
   * `vscode.TextDocument.version`, which changes with every change of the text. A document without
   * one is a snapshot whose text never changes (the text a load read, `backend/ide/backend.ts`):
   * the literate line map (`doubledLines`) is kept per document object and version.
   */
  readonly version?: number;
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

/** Whether `unit` is the first (high) or second (low) half of a UTF-16 surrogate pair. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Whether `text` holds a character outside the BMP (a surrogate pair): the only case in which the counts differ. */
const hasSurrogates = (text: string): boolean => /[\ud800-\udfff]/.test(text);

/** The number of UTF-16 units of the character starting at `index` of `text`: 2 for a surrogate pair, else 1. */
function unitsAt(text: string, index: number): number {
  return isHighSurrogate(text.charCodeAt(index)) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1)) ? 2 : 1;
}

/**
 * The number of code points before UTF-16 offset `units` of `text` (E14, module comment): a
 * compiler column from an editor column. An offset between the two halves of a surrogate pair
 * counts as the start of that character; one beyond the end of `text` adds one per unit there.
 */
export function codePointsBefore(text: string, units: number): number {
  if (!hasSurrogates(text)) {
    return units;
  }
  let at = 0;
  let codePoints = 0;
  while (at < text.length) {
    const next = at + unitsAt(text, at);
    if (next > units) {
      break;
    }
    at = next;
    codePoints++;
  }
  return codePoints + Math.max(0, units - Math.max(at, text.length));
}

/**
 * The number of UTF-16 units of the first `codePoints` code points of `text` (E14, module
 * comment): an editor column from a compiler column, or a string offset from a highlighting
 * offset. Beyond the end of `text`, one unit per code point.
 */
export function utf16Length(text: string, codePoints: number): number {
  if (!hasSurrogates(text)) {
    return codePoints;
  }
  let at = 0;
  let counted = 0;
  while (counted < codePoints && at < text.length) {
    at += unitsAt(text, at);
    counted++;
  }
  return at + (codePoints - counted);
}

/** The text of `line`, or `""` for a line outside the document. */
function lineText(doc: PositionDocument, line: number): string {
  return line >= 0 && line < doc.lineCount ? doc.lineAt(line).text : '';
}

/**
 * Whether file line `line` of `doc` is Idris code as the compiler sees it, and how many columns
 * the compiler strips from its start. Lines outside the document count as code with offset 0,
 * so a stale reply still maps to a position (VS Code clamps it when it is used). In an Org file a
 * line without the marker counts as code with offset 0 too: a block's line is, and a prose line
 * holds nothing the compiler reports on (the blocks are M12's, E19).
 */
function lineKind(doc: PositionDocument, line: number): LineKind {
  const style = compilerLiterateStyleOf(doc);
  if (!hasLineMarkers(style) || line < 0 || line >= doc.lineCount) {
    return { code: true, offset: 0 };
  }
  const width = linePrefixWidth(style, doc.lineAt(line).text);
  if (width !== undefined) {
    return { code: true, offset: width };
  }
  return style === 'bird' ? { code: false } : { code: true, offset: 0 };
}

/** The literate line map of each document (`doubledLines`), with the style and version it was made for. */
const lineMaps = new WeakMap<PositionDocument, { readonly style: LiterateStyle; readonly version: number | undefined; readonly doubled: readonly number[] }>();

/**
 * The file lines of `doc`, ascending, that the compiler's unlit text holds twice (module comment,
 * *Literate lines*; `isDoubledLine`, followed by a line break: not the last line); `[]` for a
 * document without line markers. Kept per document object until its version changes.
 */
function doubledLines(doc: PositionDocument): readonly number[] {
  const style = compilerLiterateStyleOf(doc);
  if (!hasLineMarkers(style)) {
    return [];
  }
  const kept = lineMaps.get(doc);
  if (kept !== undefined && kept.style === style && kept.version === doc.version) {
    return kept.doubled;
  }
  const doubled: number[] = [];
  for (let line = 0; line + 1 < doc.lineCount; line++) {
    if (isDoubledLine(style, doc.lineAt(line).text)) {
      doubled.push(line);
    }
  }
  lineMaps.set(doc, { style, version: doc.version, doubled });
  return doubled;
}

/** The number of the doubled lines `doubled` (ascending) for which `below(i)` holds, when it holds for a prefix of them. */
function countWhile(doubled: readonly number[], below: (i: number) => boolean): number {
  let lo = 0;
  let hi = doubled.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (below(mid)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** The compiler's 0-based line of file line `line` (module comment, *Literate lines*): `line` plus the doubled lines above it. */
function compilerLine(doc: PositionDocument, line: number): number {
  const doubled = doubledLines(doc);
  return line + countWhile(doubled, (i) => doubled[i] < line);
}

/**
 * The file line of the compiler's 0-based line `line` (the inverse of `compilerLine`), and whether
 * `line` is the second line the unlit text has for a doubled file line (`extra`): the i-th doubled
 * line `d` is the compiler's line `d + i`, its extra line `d + i + 1`.
 */
function fileLine(doc: PositionDocument, line: number): { readonly line: number; readonly extra: boolean } {
  const doubled = doubledLines(doc);
  const above = countWhile(doubled, (i) => doubled[i] + i < line);
  if (above > 0 && doubled[above - 1] + above === line) {
    return { line: doubled[above - 1], extra: true };
  }
  return { line: line - above, extra: false };
}

/** The offset to add to a compiler column on `line`; 0 on prose lines, which have no columns. */
function replyOffset(doc: PositionDocument, line: number): number {
  const kind = lineKind(doc, line);
  return kind.code ? kind.offset : 0;
}

/**
 * The editor column of compiler column `column` (0-based, code points of the unlit text) on
 * `line`: the bird-track offset plus the UTF-16 length of that many code points after it.
 */
function editorColumn(doc: PositionDocument, line: number, column: number): number {
  const offset = replyOffset(doc, line);
  return offset + utf16Length(lineText(doc, line).slice(offset), column);
}

/**
 * The code points of the unlit text of `line` before editor column `character`; a column inside
 * the bird-track marker counts as 0.
 */
function compilerColumn(doc: PositionDocument, line: number, offset: number, character: number): number {
  return codePointsBefore(lineText(doc, line).slice(offset), Math.max(0, character - offset));
}

/**
 * The compiler's 0-based column of `pos`: the code points of the unlit text of its line before it
 * (E14; a tab is one column too, `getCols`, `Libraries/Text/Lexer/Tokenizer.idr` 86–90 on v0.8.0
 * [src]), 0 inside the bird-track marker; `undefined` on a prose line of a bird-track document.
 * Evaluate Selection indents a selection's first line by this many spaces, so that every line of
 * the text it sends keeps the column the compiler's layout rule gives it (`features/eval`).
 */
export function toCompilerColumn(doc: PositionDocument, pos: EditorPosition): number | undefined {
  const kind = lineKind(doc, pos.line);
  return kind.code ? compilerColumn(doc, pos.line, kind.offset, pos.character) : undefined;
}

/**
 * `:type-of NAME L C` at `pos`, or `undefined` when `pos` is on a prose line of a literate
 * document (there is no Idris code there to ask about). A position inside the bird-track marker
 * is sent as unlit column 0. `C` counts code points (E14).
 */
export function toIdeTypeOfRequest(doc: PositionDocument, pos: EditorPosition): IdeRequestPoint | undefined {
  const column = toCompilerColumn(doc, pos);
  return column === undefined ? undefined : { line: compilerLine(doc, pos.line) + 1, column };
}

/**
 * `:type-of NAME L C` one code point after `pos`, when the character before `pos` on its line is
 * not white space (`isSpace`); `undefined` otherwise, and on a prose line. For an occurrence that
 * starts at `pos`, this column is inside it when it has two or more code points, and its end when
 * it has one. Why (second review of M3): the compiler answers a positional `:type-of` for any
 * local whose span holds `(L-1, C)`, and a span holds its end (`within`, module comment); so at
 * the start of a name that directly follows a local — `++` in `xs++ys`, `::` in `x::xs`, `+` in
 * `n+1`, `.px` in `p.px` — it answered for that local: `(:type-of "++" 4 12)` → `xs : List Nat`,
 * `(:type-of "++" 4 13)` → `Prelude.List.(++) : List a -> List a -> List a` [live, idris2
 * 0.8.0]. Only a name that ends right at `pos` can do that, hence the test of the character
 * before it. `IdeBackend.typeAt` asks here when the answer at `pos` described another local.
 */
export function toIdeTypeOfRequestPastStart(doc: PositionDocument, pos: EditorPosition): IdeRequestPoint | undefined {
  const kind = lineKind(doc, pos.line);
  if (!kind.code || pos.character <= kind.offset) {
    return undefined;
  }
  const text = lineText(doc, pos.line);
  const before = text.charAt(pos.character - 1);
  if (before === '' || isIdrisSpace(before)) {
    return undefined;
  }
  const column = compilerColumn(doc, pos.line, kind.offset, pos.character);
  return { line: compilerLine(doc, pos.line) + 1, column: column + 1 };
}

/**
 * `:case-split L C NAME` at `pos` (1-based column), or `undefined` on a prose line. A position
 * inside the bird-track marker is sent as column 1, never 0, because the compiler reads column 0
 * as "anywhere on the line". `C` counts code points: `processEdit (CaseSplit …)` compares it with
 * the same file contexts as `:type-of` (`within (line-1, col-1)`, module comment) [src; not
 * recorded on a line with a character outside the BMP].
 */
export function toIdeCaseSplitRequest(doc: PositionDocument, pos: EditorPosition): IdeRequestPoint | undefined {
  const kind = lineKind(doc, pos.line);
  if (!kind.code) {
    return undefined;
  }
  return { line: compilerLine(doc, pos.line) + 1, column: Math.max(1, compilerColumn(doc, pos.line, kind.offset, pos.character) + 1) };
}

/**
 * The number VS Code shows for the 0-based editor line `line` (the gutter's, 1-based), for texts that
 * name a line of the file to the user; not a compiler line (`toIdeLineRequest`).
 */
export function displayLine(line: number): number {
  return line + 1;
}

/** The 1-based line of the commands that take a line only (`:add-clause L NAME`, …), for file line `line` (0-based) of `doc`. */
export function toIdeLineRequest(doc: PositionDocument, line: number): number {
  return compilerLine(doc, line) + 1;
}

/**
 * The editor position of a reply position of the compiler's 0-based `line`: its file line
 * (`fileLine`), or the end of the file line an extra line of the unlit text comes from.
 */
function fromCompiler(doc: PositionDocument, line: number, column: number): EditorPosition {
  const file = fileLine(doc, line);
  return file.extra
    ? { line: file.line, character: lineText(doc, file.line).length }
    : { line: file.line, character: editorColumn(doc, file.line, column) };
}

export function fromIdeReply(doc: PositionDocument, point: IdeReplyPoint): EditorPosition {
  return fromCompiler(doc, point.line, point.column);
}

export function fromIdeReplySpan(doc: PositionDocument, span: IdeReplySpan): EditorRange {
  return { start: fromIdeReply(doc, span.start), end: fromIdeReply(doc, span.end) };
}

/** The part of one line an editor range covers (`codeLineSpans`): 0-based line, UTF-16 columns, end exclusive. */
export interface LineSpan {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/**
 * The parts of `range` (editor columns, as `fromIdeReplySpan` gives them, possibly over several
 * lines) on each line of `doc` that is code as the compiler reads it, within the line's text:
 * the compiler's span covers the unlit text, so on a bird-track document a continuation line
 * starts after its marker, and a prose line — an empty line of the unlit text (F11) — has no part.
 * Empty parts, and lines past the end of the document, are left out.
 */
export function codeLineSpans(doc: PositionDocument, range: EditorRange): LineSpan[] {
  const spans: LineSpan[] = [];
  for (let line = range.start.line; line <= range.end.line && line < doc.lineCount; line++) {
    const kind = lineKind(doc, line);
    if (!kind.code) {
      continue;
    }
    const length = lineText(doc, line).length;
    const start = line === range.start.line ? range.start.character : kind.offset;
    const end = Math.min(line === range.end.line ? range.end.character : length, length);
    if (end > start) {
      spans.push({ line, start, end });
    }
  }
  return spans;
}

/**
 * How the lines of `after` (a document as the editor shows it) correspond to those of `before` (the
 * file as a load read it), both split into lines. Used where an answer about `before` is shown on
 * `after` (`occurrence.ts` `currentTokens`, `IdeBackend.definition` for a target file open with
 * unsaved changes) or a position of `after` is asked about in `before` (`IdeBackend.typeAt`). Two
 * kinds of pairs (fourth review of M3):
 *
 * - **Equal lines**: those a line diff pairs — a longest common subsequence of the two texts' lines
 *   (`diagonalPairs`, Myers' O(ND) algorithm, run on the lines between those both texts begin and
 *   end with) —, so the unchanged lines between several separate edits are paired each with the
 *   line it was. Where the edit leaves that ambiguous (one of two equal lines deleted), a line is
 *   paired with one of the equal lines, the diff's choice.
 * - **Counterparts**: between two consecutive equal pairs (or the texts' start or end), the
 *   changed lines of `before` and those of `after` — a replaced hunk — are paired in order when
 *   both have the same number of lines (lines edited in place); a hunk that inserts or deletes lines
 *   pairs none of its lines, since which line became which is not known.
 *
 * More than `MAX_LINE_EDITS` lines inserted and deleted in all leaves every line between the first
 * and the last changed one unpaired (a bound on the diff's time and memory, which grow with the
 * number of edits). Until the fourth review of M3 only the lines both texts begin and end with
 * were paired, and every line between two separate edits was compared with the line of the same
 * number, which is another line once lines were inserted or deleted above it: a hover asked about
 * the neighbouring line's `x` (`x : String` for a `Nat`), and a kept inlay hint was drawn one line
 * off [unit-level, the reviewer's probes on live answers].
 */
export interface LineCorrespondence {
  /** Per line of `after`, the line of `before` paired with it, or -1. */
  readonly toBefore: Int32Array;
  /** Per line of `before`, the line of `after` paired with it, or -1. */
  readonly toAfter: Int32Array;
}

/** `LineCorrespondence`: the most lines inserted and deleted for which the lines between the changes are diffed. */
export const MAX_LINE_EDITS = 1000;

export function lineCorrespondence(before: readonly string[], after: readonly string[]): LineCorrespondence {
  const toBefore = new Int32Array(after.length).fill(-1);
  const toAfter = new Int32Array(before.length).fill(-1);
  const pair = (b: number, a: number): void => {
    toAfter[b] = a;
    toBefore[a] = b;
  };
  const most = Math.min(before.length, after.length);
  let head = 0;
  while (head < most && before[head] === after[head]) {
    pair(head, head);
    head++;
  }
  let tail = 0;
  while (tail < most - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    pair(before.length - 1 - tail, after.length - 1 - tail);
    tail++;
  }
  const beforeEnd = before.length - tail;
  const afterEnd = after.length - tail;
  const equal = diagonalPairs(before.slice(head, beforeEnd), after.slice(head, afterEnd));
  if (equal === undefined) {
    return { toBefore, toAfter };
  }
  let b = head;
  let a = head;
  for (const [pb, pa] of [...equal.map(([x, y]): [number, number] => [x + head, y + head]), [beforeEnd, afterEnd] as [number, number]]) {
    if (pb - b === pa - a) {
      for (let k = 0; k < pb - b; k++) {
        pair(b + k, a + k);
      }
    }
    if (pb < beforeEnd) {
      pair(pb, pa);
    }
    b = pb + 1;
    a = pa + 1;
  }
  return { toBefore, toAfter };
}

/** An unreachable diagonal in `diagonalPairs`. */
const UNREACHED = -1;

/**
 * The pairs `[i, j]` (increasing) of a longest common subsequence of `xs` and `ys`, by Myers'
 * greedy algorithm ("An O(ND) Difference Algorithm and Its Variations", Algorithmica 1(2), 1986),
 * with every path kept inside the edit graph; `undefined` when more than `MAX_LINE_EDITS`
 * insertions and deletions are needed. The lines are compared as numbers (one per distinct text).
 */
function diagonalPairs(xs: readonly string[], ys: readonly string[]): Array<[number, number]> | undefined {
  const n = xs.length;
  const m = ys.length;
  if (n === 0 || m === 0) {
    return [];
  }
  const ids = new Map<string, number>();
  const id = (text: string): number => {
    let known = ids.get(text);
    if (known === undefined) {
      known = ids.size;
      ids.set(text, known);
    }
    return known;
  };
  const x = Int32Array.from(xs, id);
  const y = Int32Array.from(ys, id);
  const most = Math.min(n + m, MAX_LINE_EDITS);
  const offset = most + 1;
  // `v[offset + k]`: the furthest `i` reached on diagonal `k = i - j`; diagonal 1 starts at 0.
  const v = new Int32Array(2 * most + 3).fill(UNREACHED);
  v[offset + 1] = 0;
  /** The `i` a path of one more edit starts diagonal `k` at, from `at` (the values of the previous round), or `UNREACHED`. */
  const startOf = (at: (k: number) => number, k: number): { readonly i: number; readonly down: boolean } => {
    const fromAbove = at(k + 1);
    const fromLeft = at(k - 1);
    const down = fromAbove !== UNREACHED && fromAbove - (k + 1) < m;
    const right = fromLeft !== UNREACHED && fromLeft < n;
    if (down && (!right || fromAbove > fromLeft)) {
      return { i: fromAbove, down: true };
    }
    return right ? { i: fromLeft + 1, down: false } : { i: UNREACHED, down: false };
  };
  const rounds: Int32Array[] = [];
  for (let d = 0; d <= most; d++) {
    for (let k = -d; k <= d; k += 2) {
      let { i } = startOf((kk) => v[offset + kk], k);
      if (i === UNREACHED) {
        v[offset + k] = UNREACHED;
        continue;
      }
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[offset + k] = i;
      if (i === n && j === m) {
        return backtrack(rounds, startOf, n, m, d);
      }
    }
    rounds.push(v.slice(offset - d, offset + d + 1));
  }
  return undefined;
}

/** The diagonal moves of the path `diagonalPairs` found to `(n, m)` with `d` edits, from the values of each round. */
function backtrack(
  rounds: readonly Int32Array[],
  startOf: (at: (k: number) => number, k: number) => { readonly i: number; readonly down: boolean },
  n: number,
  m: number,
  d: number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  for (let round = d; round > 0; round--) {
    const previous = rounds[round - 1];
    const at = (k: number): number => (k >= -(round - 1) && k <= round - 1 ? previous[k + round - 1] : UNREACHED);
    const k = i - j;
    const start = startOf(at, k);
    while (i > start.i) {
      i--;
      j--;
      pairs.push([i, j]);
    }
    const from = start.down ? k + 1 : k - 1;
    i = at(from);
    j = i - from;
  }
  while (i > 0 && j > 0) {
    i--;
    j--;
    pairs.push([i, j]);
  }
  return pairs.reverse();
}

/**
 * `pos`, a position on line `pos.line` of `from`, on the line of `to` that `map` pairs it with
 * (`LineCorrespondence`), or `undefined`: the same column on an equal line; on a counterpart
 * (a line edited in place), the same column only when both lines have the same text before it (so
 * a name before the place being typed at keeps its place); none on an unpaired line.
 */
function carriedPosition(from: readonly string[], to: readonly string[], map: Int32Array, pos: EditorPosition): EditorPosition | undefined {
  const line = pos.line >= 0 && pos.line < map.length ? map[pos.line] : -1;
  if (line < 0) {
    return undefined;
  }
  const source = from[pos.line];
  const target = to[line];
  return source === target || source.slice(0, pos.character) === target.slice(0, pos.character) ? { line, character: pos.character } : undefined;
}

/**
 * The position in `before` (the file as a load read it, split into lines) of `pos` in `after` (the
 * document as the editor shows it, likewise), or `undefined` when none can be trusted
 * (`carriedPosition` over `lineCorrespondence`). Columns are UTF-16 units, as `pos` has them.
 * `correspondence`: `lineCorrespondence(before, after)`, when the caller keeps it.
 */
export function toLoadedPosition(
  before: readonly string[],
  after: readonly string[],
  pos: EditorPosition,
  correspondence: LineCorrespondence = lineCorrespondence(before, after),
): EditorPosition | undefined {
  return carriedPosition(after, before, correspondence.toBefore, pos);
}

/** The converse of `toLoadedPosition`: the position in `after` of `pos` in `before`, or `undefined`. */
export function toShownPosition(
  before: readonly string[],
  after: readonly string[],
  pos: EditorPosition,
  correspondence: LineCorrespondence = lineCorrespondence(before, after),
): EditorPosition | undefined {
  return carriedPosition(before, after, correspondence.toAfter, pos);
}

export function fromCli(doc: PositionDocument, point: CliPoint): EditorPosition {
  return fromCompiler(doc, point.line - 1, point.column - 1);
}

export function fromCliSpan(doc: PositionDocument, span: CliSpan): EditorRange {
  return { start: fromCli(doc, span.start), end: fromCli(doc, span.end) };
}
