/**
 * Syntactic selection ranges for Idris 2 (ROADMAP M0, landscape §5 gap 5): the model behind
 * the `SelectionRangeProvider` in `selectionRanges.ts`, free of `vscode` so it is unit-tested.
 *
 * For an offset, the ranges grow, innermost first:
 * 1. the token under the cursor (or ending at it): a name, hole, operator, literal, comment,
 *    or the text part of a string literal;
 * 2. every enclosing group — `(…)`, `[…]`, `{…}` and the compiler's other group symbols, string
 *    literals and `\{…}` interpolations — first its contents, then the group with delimiters;
 * 3. every enclosing layout block, innermost first. A block is a line that starts a new layout
 *    item plus the following lines indented deeper, up to the next line at the same or a lower
 *    indentation; after each block comes its declaration group, if any;
 * 4. the whole document.
 * A candidate that does not contain the previous range is skipped, so the chain always nests.
 * The chain is never empty: its last range is the whole document, which for an empty text is
 * the empty range at offset 0 (VS Code's extension-host adapter dereferences the first range
 * of every result without a null check, so an empty chain would throw there).
 *
 * Syntactic, not semantic: nothing here is checked by the compiler. What the layout reading
 * does, and why:
 * - A line starts a layout item when its first token (comments do not count) is not inside a
 *   bracket group or string that is closed later, and no other multi-line token (a string,
 *   a `%cg` directive) reaches into it. Lines inside a closed group are continuations whatever
 *   their indentation — `foo = (1,\n2)` passes `idris2 --check` 0.8.0 with `2)` in column 0.
 *   An unclosed opening bracket is ignored, so a half-typed line does not swallow the file.
 * - The declaration group is a type signature (`name : …`, also `a, b : …` and `(op) : …`, after
 *   optional visibility/totality keywords, function-option pragmas and a 0/1 multiplicity —
 *   `localClaim`/`tyDecls` in `src/Idris/Parser.idr`) followed by the sibling clauses whose
 *   defined name is one of the declared names; or two or more consecutive sibling clauses of
 *   one name without a signature. It extends upward over sibling lines that hold only such
 *   modifiers (`%inline` / `export` on their own line above `name : …` pass `--check`) and
 *   over the `|||` documentation lines directly above them. The defined name of a clause is
 *   read from its left-hand side (the tokens before `=`, `with` or `impossible`): a backticked
 *   infix name, else the first operator, else the first token or `(op)`.
 */
import { FUNCTION_PRAGMAS, MODIFIER_KEYWORDS, RESERVED_INFIX_SYMBOLS } from '../../core/idrisSyntax';
import { birdPrefixWidth, type LiterateStyle } from '../../project/literate';
import { lex, type Group, type Token } from './lexer';

/**
 * The literate styles the model reads: plain source (`undefined`) and bird tracks, the ones M0
 * handles (F11). The fenced styles (`cmark`, `org`, `tex`, `typst`), which the double-extension
 * rows M1 added to the document selector reach (`Foo.idr.md` in its host language), need a
 * fence-aware reading, which belongs to M12 (ROADMAP E19); read as plain source, their prose
 * would be lexed as Idris.
 */
export type ModelledStyle = Extract<LiterateStyle, 'bird'> | undefined;

/** Whether `buildSyntaxModel` can read a document of this literate style (see `ModelledStyle`). */
export function isModelledStyle(style: LiterateStyle | undefined): style is ModelledStyle {
  return style === undefined || style === 'bird';
}

export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

interface Block {
  readonly headerLine: number;
  readonly indent: number;
  readonly firstToken: Token;
  readonly parent: Block | undefined;
  readonly children: Block[];
  lastLine: number;
  range: OffsetRange;
  declarationGroup: OffsetRange | undefined;
}

export interface SyntaxModel {
  readonly text: string;
  readonly tokens: readonly Token[];
  readonly groups: readonly Group[];
  /** Block of the last layout-item line at or before each line, if any. */
  readonly blockAtLine: readonly (Block | undefined)[];
  readonly lineStarts: readonly number[];
  /**
   * Bird-track documents only: per line, the first offset that belongs to the compiler's text —
   * after the marker on a code line, at the line break on a prose line (which the compiler reads
   * as an empty line).
   */
  readonly unlitLineStarts: readonly number[] | undefined;
}

const DELIMITER_KINDS: ReadonlySet<Token['kind']> = new Set([
  'groupOpen', 'groupClose', 'stringOpen', 'stringClose', 'interpOpen', 'interpClose',
]);

/**
 * The text the compiler parses, with every offset kept: for bird-track documents, prose lines
 * and the stripped markers are replaced by spaces (`birdPrefixWidth`, F11).
 */
function unlitPreservingOffsets(text: string, style: ModelledStyle): string {
  if (style !== 'bird') {
    return text;
  }
  return text.replace(/[^\r\n]*/g, (line) => {
    const width = birdPrefixWidth(line);
    return width === undefined ? ' '.repeat(line.length) : ' '.repeat(width) + line.slice(width);
  });
}

/** `unlitLineStarts` of the model (see `SyntaxModel`) for a bird-track `text`. */
function computeUnlitLineStarts(text: string, lineStarts: readonly number[]): number[] {
  return lineStarts.map((start, line) => {
    const next = line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length;
    const lineText = text.slice(start, next).replace(/\r?\n$|\r$/, '');
    return start + (birdPrefixWidth(lineText) ?? lineText.length);
  });
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '\r' && text.charAt(i + 1) === '\n') {
      i++;
      starts.push(i + 1);
    } else if (c === '\n' || c === '\r') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineOf(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Index of the first token starting at or after `offset` (tokens are in source order). */
function firstTokenFrom(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start < offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function isClosedGroupChain(group: Group | undefined): boolean {
  for (let g = group; g !== undefined; g = g.parent) {
    if (g.close !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * The group a token is inside for layout purposes: an opening delimiter starts its group, so it
 * sits in the enclosing one; a closing delimiter is still inside the group it closes.
 */
function layoutGroup(token: Token): Group | undefined {
  const opens = token.kind === 'groupOpen' || token.kind === 'stringOpen' || token.kind === 'interpOpen';
  return opens ? token.outer : (token.delimits ?? token.outer);
}

export function buildSyntaxModel(text: string, literate: ModelledStyle): SyntaxModel {
  const code = unlitPreservingOffsets(text, literate);
  const { tokens, groups } = lex(code);
  const lineStarts = computeLineStarts(code);
  const lineCount = lineStarts.length;

  // Per line: first non-comment token starting on it, and the furthest end of any token that
  // starts on it; lines reached by a multi-line non-comment token cannot start a layout item.
  const firstToken: (Token | undefined)[] = new Array<Token | undefined>(lineCount).fill(undefined);
  const lastEnd: number[] = new Array<number>(lineCount).fill(-1);
  const continued: boolean[] = new Array<boolean>(lineCount).fill(false);
  for (const token of tokens) {
    const line = lineOf(lineStarts, token.start);
    lastEnd[line] = Math.max(lastEnd[line], token.end);
    const isComment = token.kind === 'comment' || token.kind === 'docComment';
    if (!isComment && firstToken[line] === undefined) {
      firstToken[line] = token;
    }
    if (!isComment && token.end > token.start) {
      const endLine = lineOf(lineStarts, token.end - 1);
      for (let l = line + 1; l <= endLine; l++) {
        continued[l] = true;
      }
    }
  }

  const codeLines: boolean[] = firstToken.map((t) => t !== undefined);
  const isHeader = (line: number): boolean => {
    const token = firstToken[line];
    return token !== undefined && !continued[line] && !isClosedGroupChain(layoutGroup(token));
  };

  // Layout blocks.
  const roots: Block[] = [];
  const stack: Block[] = [];
  const blockAtLine: (Block | undefined)[] = new Array<Block | undefined>(lineCount).fill(undefined);
  let lastCodeLine = -1;
  const closeBlock = (block: Block, lastLine: number): void => {
    block.lastLine = lastLine;
    let end = block.firstToken.end;
    for (let l = block.headerLine; l <= lastLine; l++) {
      if (codeLines[l]) {
        end = Math.max(end, lastEnd[l]);
      }
    }
    block.range = { start: block.firstToken.start, end };
  };
  let current: Block | undefined;
  for (let line = 0; line < lineCount; line++) {
    if (isHeader(line)) {
      const token = firstToken[line] as Token;
      const indent = token.start - lineStarts[line];
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        closeBlock(stack.pop() as Block, lastCodeLine);
      }
      const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
      const block: Block = {
        headerLine: line,
        indent,
        firstToken: token,
        parent,
        children: [],
        lastLine: line,
        range: { start: token.start, end: token.end },
        declarationGroup: undefined,
      };
      (parent?.children ?? roots).push(block);
      stack.push(block);
      current = block;
    }
    if (codeLines[line]) {
      lastCodeLine = line;
    }
    blockAtLine[line] = current;
  }
  while (stack.length > 0) {
    closeBlock(stack.pop() as Block, lastCodeLine);
  }

  const siblingLists: Block[][] = [roots];
  for (let k = 0; k < siblingLists.length; k++) {
    for (const block of siblingLists[k]) {
      if (block.children.length > 0) {
        siblingLists.push(block.children);
      }
    }
  }
  for (const siblings of siblingLists) {
    assignDeclarationGroups(siblings, tokens, lineStarts, firstToken);
  }

  const unlitLineStarts = literate === 'bird' ? computeUnlitLineStarts(text, lineStarts) : undefined;
  return { text, tokens, groups, blockAtLine, lineStarts, unlitLineStarts };
}

/**
 * The tokens of `block` at its own bracket level (the level of its first token), comments
 * excluded, in order.
 */
function blockTokens(tokens: readonly Token[], block: Block): Token[] {
  const result: Token[] = [];
  const level = block.firstToken.outer;
  for (let i = firstTokenFrom(tokens, block.firstToken.start); i < tokens.length && tokens[i].start < block.range.end; i++) {
    const token = tokens[i];
    if (token.kind !== 'comment' && token.kind !== 'docComment' && token.outer === level) {
      result.push(token);
    }
  }
  return result;
}

/** The names a type signature declares, or `undefined` when `level` is not a signature. */
function signatureNames(level: readonly Token[], all: readonly Token[]): string[] | undefined {
  let i = 0;
  while (
    i < level.length &&
    ((level[i].kind === 'keyword' && MODIFIER_KEYWORDS.has(level[i].text)) ||
      (level[i].kind === 'pragma' && FUNCTION_PRAGMAS.has(level[i].text)))
  ) {
    i++;
  }
  if (i < level.length && level[i].kind === 'number' && (level[i].text === '0' || level[i].text === '1')) {
    i++;
  }
  const names: string[] = [];
  for (;;) {
    const name = nameAt(level, i, all);
    if (name === undefined) {
      return undefined;
    }
    names.push(name.name);
    i = name.next;
    const sep = level[i];
    if (sep?.kind === 'symbol' && sep.text === ',') {
      i++;
      continue;
    }
    return sep?.kind === 'symbol' && sep.text === ':' ? names : undefined;
  }
}

/**
 * A declarable name at `level[i]`: an unqualified identifier, or `(op)`. `next` is the index in
 * `level` after it (a parenthesised operator is three tokens of `all` but two of `level`: the
 * operator itself sits one level deeper).
 */
function nameAt(level: readonly Token[], i: number, all: readonly Token[]): { name: string; next: number } | undefined {
  const token = level[i];
  if (token === undefined) {
    return undefined;
  }
  if (token.kind === 'ident' && !token.text.includes('.')) {
    return { name: token.text, next: i + 1 };
  }
  const op = operatorInParentheses(token, all);
  return op === undefined ? undefined : { name: op, next: i + 2 };
}

/** The operator of `(op)` when `open` is the `(` of such a group. */
function operatorInParentheses(open: Token, all: readonly Token[]): string | undefined {
  const group = open.delimits;
  if (open.kind !== 'groupOpen' || open.text !== '(' || group?.close === undefined) {
    return undefined;
  }
  const k = firstTokenFrom(all, open.start);
  const op = all[k + 1];
  const close = all[k + 2];
  if (op?.kind === 'symbol' && isOperator(op.text) && close === group.close) {
    return op.text;
  }
  return undefined;
}

function isOperator(text: string): boolean {
  return text !== ',' && text !== ';' && text !== '_' && text !== '`' && !RESERVED_INFIX_SYMBOLS.has(text);
}

/**
 * The name a clause defines, or `undefined` when `level` is not a clause: a clause's left-hand
 * side ends at `=`, `with` or `impossible` and contains no other keyword (which rules out
 * `let x = …`, `data … = …`, and a named implementation `Show Foo where` whose `=` belongs to
 * the methods below it).
 */
function clauseName(level: readonly Token[], all: readonly Token[]): string | undefined {
  const lhsEnd = level.findIndex((t) => t.kind === 'keyword' || (t.kind === 'symbol' && t.text === '='));
  const end = level[lhsEnd];
  if (lhsEnd <= 0 || (end.kind === 'keyword' && end.text !== 'with' && end.text !== 'impossible')) {
    return undefined;
  }
  const lhs = level.slice(0, lhsEnd);
  for (let i = 0; i + 2 < lhs.length; i++) {
    if (lhs[i].text === '`' && lhs[i + 1].kind === 'ident' && lhs[i + 2].text === '`') {
      return lhs[i + 1].text;
    }
  }
  const op = lhs.find((t) => t.kind === 'symbol' && isOperator(t.text));
  if (op !== undefined) {
    return op.text;
  }
  return nameAt(lhs, 0, all)?.name;
}

function isPrefixBlock(level: readonly Token[]): boolean {
  const first = level[0];
  if (first === undefined) {
    return false;
  }
  const isModifier =
    (first.kind === 'keyword' && MODIFIER_KEYWORDS.has(first.text)) ||
    (first.kind === 'pragma' && FUNCTION_PRAGMAS.has(first.text));
  return isModifier && !level.some((t) => t.kind === 'symbol' && (t.text === ':' || t.text === '='));
}

function assignDeclarationGroups(
  siblings: readonly Block[],
  all: readonly Token[],
  lineStarts: readonly number[],
  firstToken: readonly (Token | undefined)[],
): void {
  const levels = siblings.map((block) => blockTokens(all, block));
  const names = levels.map((level) => clauseName(level, all));
  let i = 0;
  while (i < siblings.length) {
    const sig = signatureNames(levels[i], all);
    let j = i + 1;
    if (sig !== undefined) {
      while (j < siblings.length && names[j] !== undefined && sig.includes(names[j] as string)) {
        j++;
      }
    } else if (names[i] !== undefined) {
      while (j < siblings.length && names[j] === names[i]) {
        j++;
      }
      if (j - i < 2) {
        i = j;
        continue;
      }
    } else {
      i++;
      continue;
    }
    let k = i;
    if (sig !== undefined) {
      while (
        k > 0 &&
        siblings[k - 1].declarationGroup === undefined &&
        isPrefixBlock(levels[k - 1]) &&
        siblings[k - 1].lastLine === siblings[k].headerLine - 1
      ) {
        k--;
      }
    }
    const start = docCommentStart(siblings[k], lineStarts, firstToken, all) ?? siblings[k].range.start;
    const range = { start, end: siblings[j - 1].range.end };
    // A group of one block without documentation would only repeat the block's range.
    if (j - k > 1 || start < siblings[i].range.start) {
      for (let b = k; b < j; b++) {
        siblings[b].declarationGroup = range;
      }
    }
    i = j;
  }
}

/** Start of the `|||` lines directly above `block` at its indentation, if there are any. */
function docCommentStart(
  block: Block,
  lineStarts: readonly number[],
  firstToken: readonly (Token | undefined)[],
  all: readonly Token[],
): number | undefined {
  let start: number | undefined;
  for (let line = block.headerLine - 1; line >= 0; line--) {
    if (firstToken[line] !== undefined) {
      break;
    }
    const lineStart = lineStarts[line];
    const doc: Token | undefined = all[firstTokenFrom(all, lineStart)];
    const onLine = doc !== undefined && (line + 1 >= lineStarts.length || doc.start < lineStarts[line + 1]);
    if (!onLine || doc.kind !== 'docComment' || doc.start - lineStart !== block.indent) {
      break;
    }
    start = doc.start;
  }
  return start;
}

/**
 * Selection ranges at `offset`, innermost first; every range contains the previous one and the
 * last is the whole document. For a non-empty text every range differs from the one before it
 * (the first from the empty range at `offset`); for the empty text the only range is {0, 0}.
 */
export function selectionRangesAt(model: SyntaxModel, offset: number): OffsetRange[] {
  const candidates: OffsetRange[] = [];

  const leaf = leafTokenAt(model.tokens, offset);
  if (leaf !== undefined) {
    candidates.push({ start: skipBirdMarker(model, leaf.start), end: leaf.end });
  }

  const enclosing = model.groups
    .filter((g) => g.close !== undefined && g.open.start <= offset && offset <= g.close.end)
    .sort((a, b) => b.open.start - a.open.start);
  for (const g of enclosing) {
    const close = g.close as Token;
    candidates.push({ start: skipBirdMarker(model, g.open.end), end: close.start }, { start: g.open.start, end: close.end });
  }

  const line = lineOf(model.lineStarts, offset);
  for (let block = model.blockAtLine[line]; block !== undefined; block = block.parent) {
    candidates.push(block.range);
    if (block.declarationGroup !== undefined) {
      candidates.push(block.declarationGroup);
    }
  }

  candidates.push({ start: 0, end: model.text.length });

  const result: OffsetRange[] = [];
  let last: OffsetRange = { start: offset, end: offset };
  for (const c of candidates) {
    const containsLast = c.start <= last.start && last.end <= c.end;
    const same = c.start === last.start && c.end === last.end;
    if (containsLast && !same) {
      result.push(c);
      last = c;
    }
  }
  if (result.length === 0) {
    // Only the empty text gets here: its whole-document range {0, 0} equals the cursor's.
    result.push({ start: 0, end: model.text.length });
  }
  return result;
}

/**
 * `offset`, moved past the bird-track marker (or to the end of the prose line) when it lies
 * before the compiler's text of its line. Only a range that starts where a multi-line string's
 * opening delimiter ends — the delimiter takes its line break (`multilineBegin` in
 * `src/Parser/Lexer/Source.idr`), so its contents start at the next line's first column — can
 * start there; without the move, such a range would include the marker, which the same text
 * in a `.idr` file has no counterpart of.
 */
function skipBirdMarker(model: SyntaxModel, offset: number): number {
  if (model.unlitLineStarts === undefined) {
    return offset;
  }
  return Math.max(offset, model.unlitLineStarts[lineOf(model.lineStarts, offset)]);
}

/** The non-delimiter token containing `offset`, else the one ending exactly at it. */
function leafTokenAt(tokens: readonly Token[], offset: number): Token | undefined {
  let ending: Token | undefined;
  for (const token of tokens) {
    if (DELIMITER_KINDS.has(token.kind)) {
      continue;
    }
    if (token.start <= offset && offset < token.end) {
      return token;
    }
    if (token.end === offset) {
      ending = token;
    }
    if (token.start > offset) {
      break;
    }
  }
  return ending;
}
