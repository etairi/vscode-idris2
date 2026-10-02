// The line reader of `src/core/idrisSyntax.ts` compared with M0's `lex` (`src/features/syntax/lexer.ts`)
// on one text (test/unit/idrisSyntaxLines.test.ts: the fixtures and generated text; test/grammar/corpus.test.ts:
// the corpora). `lex` reads the whole text at once; the reader reads it a line at a time, each line from what is
// open after the line before (`openAfter`), as the edits do. For every line they must agree on:
// - every token's piece on the line (its kind, start and end: comments, a string's text and delimiters, character
//   literals and every token of code, so the class of every character and the code token boundaries too), the
//   piece of the reader's run of the line (`lexText`, which `levelTokens` and the other readers run) against the
//   piece of `lex`'s token cut to the line;
// - what is open at the line break after it (`openAfter`): the groups open (brackets, interpolations, `"""` and
//   `"` strings), a block comment or character literal across the break, and whether a `"` string was cut by a
//   break before (`unsure`); a comment's depth shows through where it ends;
// - `firstTokenColumn` of the line;
// - on a line that starts with nothing open: `levelTokens(line, true)` against the same tokens made from `lex`'s
//   (kinds, texts, depths, closers), and `withoutLineComment`.
// The one difference allowed is the module comment's of `core/idrisLexer.ts`: a character literal a line break
// cuts (`'` or `'\` ends the line) is taken for one by the reader, and when the next line does not start with
// `'`, `lex` reads `'` (and `\`) instead (code the compiler rejects); such lines are counted (`cutChars`).
import { delimiterKind, lexText, START, type GroupKind, type LexemeSink, type LexerState, type TokenKind } from '../../../src/core/idrisLexer';
import { firstTokenColumn, levelTokens, NOTHING_OPEN, openAfter, RESERVED_INFIX_SYMBOLS, withoutLineComment, type OpenBlock } from '../../../src/core/idrisSyntax';
import { lex, type Group, type Token } from '../../../src/features/syntax/lexer';

export interface LineDifferences {
  /** One line per disagreement (at most `limit`). */
  readonly problems: readonly string[];
  /** The lines whose cut character literal the next line did not close (module comment). */
  readonly cutChars: number;
  /** The lines compared. */
  readonly lines: number;
}

type FrameKind = 'bracket' | 'interpolation' | 'string"""' | 'string"';

/** A group as `lexText` reports it, with what tells a `"""` string from a `"` one. */
const frameKind = (kind: GroupKind, openText: string): FrameKind => (kind === 'string' ? (openText.includes('"""') ? 'string"""' : 'string"') : kind);

/** The frames of `state`, outermost first. */
function framesOf(state: LexerState): FrameKind[] {
  const kinds: FrameKind[] = [];
  for (let f = state.frames; f !== undefined; f = f.below) {
    kinds.unshift(f.frame.type === 'string' ? (f.frame.multiline ? 'string"""' : 'string"') : f.frame.kind);
  }
  return kinds;
}

/** What `lex`'s reading has open right after the line break at offset `b`. */
interface WholeState {
  readonly frames: readonly FrameKind[];
  readonly comment: boolean;
  readonly char: boolean;
  readonly unsure: boolean;
}

/**
 * `lex`'s tokens of `text` and, at each of `breaks`, what is open after it: the groups from the same whole-text
 * run (`lexText` with `end: 'text'`, which `lex` makes its tokens from; checked token for token against `lex`), a
 * comment or character literal token that holds the break.
 */
function wholeReading(text: string, breaks: readonly number[], problems: string[]): { readonly tokens: readonly Token[]; readonly states: readonly WholeState[] } {
  const tokens = lex(text).tokens;
  // The run's events: a drop of a string happens at the line break that ends it (where its last event ended), a drop
  // of a bracket at the closing bracket that follows it.
  type Event = { readonly type: 'open' | 'close'; readonly kind: GroupKind; readonly at: number; readonly text: string } | { readonly type: 'drop'; at: number };
  const events: Event[] = [];
  const seen: [TokenKind, number, number][] = [];
  let lastEnd = 0;
  const pendingDrops: Event[] = [];
  const settle = (at: number): void => {
    for (const e of pendingDrops.splice(0)) {
      (e as { at: number }).at = at;
    }
  };
  const sink: LexemeSink = {
    token(kind, start, end) {
      seen.push([kind, start, end]);
      lastEnd = end;
    },
    open(kind, start, end) {
      settle(start);
      seen.push([delimiterKind(kind, true), start, end]);
      events.push({ type: 'open', kind, at: start, text: text.slice(start, end) });
      lastEnd = end;
    },
    close(kind, start, end) {
      settle(start);
      seen.push([delimiterKind(kind, false), start, end]);
      events.push({ type: 'close', kind, at: start, text: '' });
      lastEnd = end;
    },
    drop(kind) {
      const e: Event = { type: 'drop', at: lastEnd };
      events.push(e);
      if (kind !== 'string') {
        pendingDrops.push(e);
      }
    },
  };
  lexText(text, START, 'text', sink);
  if (seen.length !== tokens.length || seen.some(([k, s, e], i) => tokens[i].kind !== k || tokens[i].start !== s || tokens[i].end !== e)) {
    problems.push('lex and its lexText run differ');
  }
  const states: WholeState[] = [];
  const stack: FrameKind[] = [];
  let unsure = false;
  let e = 0;
  let t = 0;
  const holders: Token[] = [];
  for (const b of breaks) {
    for (; e < events.length && events[e].at <= b; e++) {
      const ev = events[e];
      if (ev.type === 'open') {
        stack.push(frameKind(ev.kind, ev.text));
      } else {
        unsure ||= ev.type === 'drop' && stack[stack.length - 1]?.startsWith('string') === true;
        stack.pop();
      }
    }
    // The comment and character tokens that hold the break.
    for (; t < tokens.length && tokens[t].start < b; t++) {
      if (tokens[t].kind === 'comment' || tokens[t].kind === 'char') {
        holders.push(tokens[t]);
      }
    }
    const holding = holders.filter((h) => h.end > b);
    holders.length = 0;
    holders.push(...holding);
    states.push({
      frames: [...stack],
      comment: holding.some((h) => h.kind === 'comment'),
      char: holding.some((h) => h.kind === 'char'),
      unsure,
    });
  }
  return { tokens, states };
}

/** The reader's pieces of one line: `kind:start-end`. */
function readerPieces(line: string, open: OpenBlock): string[] {
  const pieces: string[] = [];
  const add = (kind: TokenKind, start: number, end: number): void => {
    if (end > start) {
      pieces.push(`${kind}:${start}-${end}`);
    }
  };
  lexText(line, open, 'line', {
    token: add,
    open: (kind, start, end) => add(delimiterKind(kind, true), start, end),
    close: (kind, start, end) => add(delimiterKind(kind, false), start, end),
    drop() {},
  });
  return pieces;
}

/** The depth of `lex`'s token `t`: the bracket groups and interpolations around it. */
function depthOf(t: Token): number {
  let n = 0;
  for (let g: Group | undefined = t.outer; g !== undefined; g = g.parent) {
    n += g.kind === 'string' ? 0 : 1;
  }
  return n;
}

/** `levelTokens(line, true)` made from `lex`'s tokens of `text` that start on the line `from`–`to` (which starts with nothing open). */
function levelTokensFromLex(tokens: readonly Token[], text: string, from: number, to: number): string[] {
  const onLine = tokens.filter((t) => t.start >= from && t.start < to);
  // An operator in parentheses at level 0: `(`, one operator, `)` — one token, where its `)` is.
  const operators = new Map<Token, Token>();
  for (const t of onLine) {
    const open = t.delimits?.open;
    if (t.kind === 'groupClose' && t.text === ')' && open?.text === '(' && depthOf(t) === 0) {
      const inside = onLine.filter((u) => u.start >= open.end && u.end <= t.start);
      const op = inside[0];
      if (inside.length === 1 && op.kind === 'symbol' && !',;_`'.includes(op.text) && !RESERVED_INFIX_SYMBOLS.has(op.text)) {
        operators.set(t, op);
      }
    }
  }
  const inOperator = new Set(operators.values());
  const out: string[] = [];
  for (const t of onLine) {
    const piece = t.text.slice(0, to - t.start);
    const d = depthOf(t);
    const op = operators.get(t);
    if (op !== undefined) {
      out.push(`group|(${op.text})|${d}|`);
      continue;
    }
    if (inOperator.has(t)) {
      continue;
    }
    switch (t.kind) {
      case 'comment':
      case 'stringOpen':
      case 'stringText':
      case 'interpOpen':
      case 'groupOpen':
        break;
      case 'stringClose':
        out.push(`string|${text.slice(t.delimits?.open.start ?? t.start, t.end)}|${d}|`);
        break;
      case 'interpClose':
        out.push(`group||${d}|}`);
        break;
      case 'groupClose':
        out.push(`group||${d}|${t.text.slice(-1)}`);
        break;
      case 'ident':
        out.push(`name|${piece}|${d}|`);
        break;
      case 'keyword':
      case 'pragma':
      case 'number':
        out.push(`${t.kind}|${piece}|${d}|`);
        break;
      case 'symbol':
        out.push(`${t.text === '`' ? 'tick' : t.text === '_' ? 'name' : 'symbol'}|${piece}|${d}|`);
        break;
      default:
        out.push(`other|${piece}|${d}|`);
    }
  }
  return out;
}

const pieceOf = (s: string): { kind: string; start: number; end: number } => {
  const [kind, range] = s.split(':');
  const [start, end] = range.split('-').map(Number);
  return { kind, start, end };
};

/** Compares the line reader with `lex` on `text` (module comment); `label` names it in the problems. */
export function lineDifferences(text: string, label: string, limit = 5): LineDifferences {
  let normal = text.replace(/\r\n?/gu, '\n');
  if (!normal.endsWith('\n')) {
    normal += '\n';
  }
  const lines = normal.split('\n').slice(0, -1);
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const breaks = lines.map((l, i) => starts[i] + l.length);
  const problems: string[] = [];
  const note = (line: number, what: string): void => {
    if (problems.length < limit) {
      problems.push(`${label}:${line + 1}: ${what} — ${JSON.stringify(lines[line].slice(0, 120))}`);
    }
  };
  const whole = wholeReading(normal, breaks, problems);
  // `lex`'s pieces per line.
  const lexPieces: string[][] = lines.map(() => []);
  for (const t of whole.tokens) {
    let l = lineOf(t.start);
    for (; l < lines.length && starts[l] < t.end; l++) {
      const a = Math.max(t.start, starts[l]) - starts[l];
      const b = Math.min(t.end, breaks[l]) - starts[l];
      if (b > a) {
        lexPieces[l].push(`${t.kind}:${a}-${b}`);
      }
    }
  }
  let cutChars = 0;
  let open: OpenBlock = NOTHING_OPEN;
  let previous: WholeState = { frames: [], comment: false, char: false, unsure: false };
  lines.forEach((line, l) => {
    const pieces = readerPieces(line, open);
    const after = openAfter(line, open);
    const expected = whole.states[l];
    // A character literal the break cut, which the next line does not close.
    let charCut = after.cut?.type === 'char' && !expected.char;
    if (charCut) {
      const cut = pieces.findIndex((p) => p.startsWith('char:') && pieceOf(p).end === line.length);
      const k = cut < 0 ? -1 : pieceOf(pieces[cut]).start;
      const instead = line.slice(k) === "'\\" ? [`unrecognised:${k}-${k + 1}`, `symbol:${k + 1}-${k + 2}`] : [`unrecognised:${k}-${k + 1}`];
      if (k >= 0 && lexPieces[l].includes(instead[0])) {
        pieces.splice(cut, 1, ...instead);
        cutChars++;
      } else {
        charCut = false;
      }
    }
    const sorted = (a: readonly string[]): string => [...a].sort((x, y) => pieceOf(x).start - pieceOf(y).start || x.localeCompare(y)).join(' ');
    if (sorted(pieces) !== sorted(lexPieces[l])) {
      note(l, `pieces: reader [${sorted(pieces)}], lex [${sorted(lexPieces[l])}]`);
    }
    const state = { frames: framesOf(after), comment: after.cut?.type === 'comment', char: after.cut?.type === 'char' && !charCut, unsure: after.unsure };
    if (JSON.stringify(state) !== JSON.stringify({ ...expected, frames: [...expected.frames] })) {
      note(l, `open at its end: reader ${JSON.stringify(state)}, lex ${JSON.stringify(expected)}`);
    }
    // The first token that starts on the line.
    const inText = previous.frames[previous.frames.length - 1]?.startsWith('string') === true && !previous.comment && !previous.char;
    const first = whole.tokens.find((t) => t.start >= starts[l] && t.start < breaks[l] && t.kind !== 'comment');
    const column = inText ? 'string' : first === undefined ? undefined : [...line.slice(0, first.start - starts[l])].length;
    const readColumn = firstTokenColumn(line, open);
    if (readColumn !== column) {
      note(l, `first token column: reader ${String(readColumn)}, lex ${String(column)}`);
    }
    if (open.frames === undefined && open.cut === undefined && !charCut) {
      const read = levelTokens(line, true).map((t) => `${t.kind}|${t.text}|${t.depth}|${t.closer ?? ''}`);
      const made = levelTokensFromLex(whole.tokens, normal, starts[l], breaks[l]);
      if (read.join(' ') !== made.join(' ')) {
        note(l, `levelTokens: reader [${read.join(' ')}], lex [${made.join(' ')}]`);
      }
      const comment = whole.tokens.find((t) => t.start >= starts[l] && t.start < breaks[l] && (t.kind === 'docComment' || (t.kind === 'comment' && t.text.startsWith('--'))));
      const code = comment === undefined ? line : line.slice(0, comment.start - starts[l]);
      if (withoutLineComment(line) !== code) {
        note(l, `withoutLineComment: reader ${JSON.stringify(withoutLineComment(line))}, lex ${JSON.stringify(code)}`);
      }
    }
    open = after;
    previous = expected;
  });
  return { problems, cutChars, lines: lines.length };

  function lineOf(at: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }
}
