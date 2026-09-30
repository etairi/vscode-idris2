/**
 * Semantic tokens (ROADMAP M3): the compiler's decorations of a file's last load (`TokenIndex`),
 * encoded in idris2-lsp's legend so that themes colour both backends alike; and the decorations
 * of a `:docs-for` reply, which colour the **Show Documentation** document the same way ("rendered
 * with the reply's spans", ROADMAP M3 technical approach). No `vscode` import: the encoders return
 * the `data` array of `vscode.SemanticTokens`.
 *
 * VS Code's encoding [doc: `DocumentSemanticTokensProvider`]: five integers per token — line
 * delta, start delta (from the previous token's start on the same line, else from 0), length,
 * token type index, modifier bits — sorted, each token on one line, none overlapping. So:
 * - A token over several lines (a block comment, a multi-line string) is cut into one piece per
 *   line (`core/positions.ts` `codeLineSpans`): in a bird-track file a continuation line starts after
 *   its marker, and a prose line the compiler's span crosses gets none (F11).
 * - **Nested and overlapping tokens: the inner one wins**, and the outer one is cut around it, as
 *   idris2-lsp's `removeOverlap` does (`src/Server/SemanticTokens.idr` at `9a2f0ad` [src]): in
 *   `"hello \{name}!"` the compiler sends the string as `:data` over the whole literal and the
 *   interpolated `name` as `:bound` inside it [live, review of M3], and both are coloured. Of two
 *   pieces the one that starts later wins where they overlap; of two that start together the
 *   shorter; of two with the same range the later in the index (the compiler sent both).
 *
 * The compiler decorates literals too: numbers and strings are `:data` [live, transcript
 * `shapes-lookups`: the `2` of `2 * pi * r` at (23,25)–(23,26)], so they are coloured as
 * `enumMember` over the grammar's string and number colours, as they are with idris2-lsp, which maps
 * the same decoration the same way.
 */
import type { Decor, RichText, Token } from '../../backend/types';
import { codeLineSpans, type EditorRange, type PositionDocument } from '../../core/positions';
import type { DecorTokenTypes, SemanticTokenLegend, SemanticTokenType } from './types';

/** The legend: idris2-lsp's token types in its order, no modifiers (`types.ts` `SemanticTokenLegend`). */
export const SEMANTIC_TOKEN_LEGEND: SemanticTokenLegend = [
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

/** `encodeDecorAsString` of idris2-lsp (`types.ts` `DecorTokenTypes`). */
export const DECOR_TOKEN_TYPES: DecorTokenTypes = {
  type: 'type',
  function: 'function',
  data: 'enumMember',
  bound: 'variable',
  keyword: 'keyword',
  namespace: 'namespace',
  postulate: 'postulate',
  module: 'module',
  comment: 'comment',
};

const TYPE_INDEX: ReadonlyMap<SemanticTokenType, number> = new Map(SEMANTIC_TOKEN_LEGEND.map((type, i) => [type, i]));

function typeIndex(decor: Decor): number {
  return TYPE_INDEX.get(DECOR_TOKEN_TYPES[decor]) as number;
}

/** A token cut to one line: 0-based line, start and end character (end exclusive), type index. */
interface Piece {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly type: number;
}

/** The pieces of `range` in `doc`, one per line it covers (module comment). */
function pieces(doc: PositionDocument, range: EditorRange, type: number): Piece[] {
  return codeLineSpans(doc, range).map((span) => ({ ...span, type }));
}

/**
 * The pieces of one line without overlaps (module comment, *Nested and overlapping tokens*): in
 * the order start, then end descending, then as given, a later piece wins where it overlaps an
 * earlier one, which is cut around it. A sweep with a stack of the pieces that have started, the
 * one on top winning: those below it started earlier, or together and longer.
 */
function withoutOverlaps(line: readonly Piece[]): Piece[] {
  const ordered = line.map((piece, index) => ({ piece, index }));
  ordered.sort((a, b) => a.piece.start - b.piece.start || b.piece.end - a.piece.end || a.index - b.index);
  const out: Piece[] = [];
  const stack: Piece[] = [];
  /** The output reaches this character; `last` is the piece whose part was written last. */
  let at = 0;
  let last: Piece | undefined;
  /** Writes what the stack's top covers from `at` to `until`, popping pieces that have ended. */
  const writeUntil = (until: number): void => {
    while (at < until) {
      while (stack.length > 0 && stack[stack.length - 1].end <= at) {
        stack.pop();
      }
      const top = stack[stack.length - 1];
      if (top === undefined) {
        at = until;
        return;
      }
      const end = Math.min(top.end, until);
      const previous = out[out.length - 1];
      if (last === top && previous !== undefined && previous.end === at) {
        out[out.length - 1] = { ...previous, end };
      } else {
        out.push({ ...top, start: at, end });
      }
      last = top;
      at = end;
    }
  };
  for (const { piece } of ordered) {
    writeUntil(piece.start);
    at = Math.max(at, piece.start);
    stack.push(piece);
  }
  writeUntil(stack.reduce((end, piece) => Math.max(end, piece.end), at));
  return out;
}

/** The five-integer encoding of `all`, which may overlap: per line without overlaps, sorted. */
function encode(all: readonly Piece[]): number[] {
  const byLine = new Map<number, Piece[]>();
  for (const piece of all) {
    const line = byLine.get(piece.line);
    if (line === undefined) {
      byLine.set(piece.line, [piece]);
    } else {
      line.push(piece);
    }
  }
  const data: number[] = [];
  let previousLine = 0;
  let previousStart = 0;
  for (const lineNumber of [...byLine.keys()].sort((a, b) => a - b)) {
    for (const p of withoutOverlaps(byLine.get(lineNumber) as Piece[])) {
      data.push(p.line - previousLine, p.line === previousLine ? p.start - previousStart : p.start, p.end - p.start, p.type, 0);
      previousLine = p.line;
      previousStart = p.start;
    }
  }
  return data;
}

/**
 * The semantic tokens of `tokens` (a file's index, `occurrence.ts` `currentTokens`) in `doc`, the
 * document they describe (module comment: one piece per line, the inner token winning). The
 * compiler sends some occurrences twice (e.g. a method's name with and without its namespace
 * [live, transcript `shapes-lookups`]); the index keeps identical entries once.
 */
export function encodeTokens(tokens: readonly Token[], doc: PositionDocument): number[] {
  return encode(tokens.flatMap((t) => pieces(doc, t.range, typeIndex(t.decor))));
}

/** `text` as the lines of a document that is not bird-track, for `codeLineSpans`. */
function plainLines(text: string): PositionDocument {
  const lines = text.split('\n');
  return { languageId: '', fileName: '', isUntitled: false, lineCount: lines.length, lineAt: (line) => ({ text: lines[line] ?? '' }) };
}

/**
 * The semantic tokens of a `:docs-for` reply shown as a document of `rich.text` (lines split at
 * `\n`): each span with a decoration, by its offsets.
 */
export function encodeRichText(rich: RichText): number[] {
  const lineStarts = [0];
  for (let i = rich.text.indexOf('\n'); i >= 0; i = rich.text.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1);
  }
  const positionOf = (offset: number): { line: number; character: number } => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
      line++;
    }
    return { line, character: offset - lineStarts[line] };
  };
  const doc = plainLines(rich.text);
  return encode(
    rich.spans.flatMap((span) =>
      span.decor === undefined ? [] : pieces(doc, { start: positionOf(span.start), end: positionOf(span.start + span.length) }, typeIndex(span.decor)),
    ),
  );
}
