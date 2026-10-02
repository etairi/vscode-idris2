/**
 * Idris 2 source read without the compiler, shared by the modules that read it
 * (`core/idrisSyntax.ts`, as built M4): the tables of the lexer (from `core/idrisLexer.ts`) and of
 * the parser that M0's lexer and layout model (`features/syntax/selectionRangeModel.ts`), M3's
 * occurrences, outline and completion, the editing targets (`features/editing/targets.ts`) and the
 * IDE backend's edits (`backend/ide/edits.ts`) use, so that they cannot drift apart, and a reading of
 * code line by line — the line reader: its tokens at their bracket level, what is open at its end, the
 * layout blocks its rest opens, the name a clause defines, the names a type declaration declares —
 * that the backend's edits and the light bulb (Make With, through `withClauseStart`) share; whether an
 * answer the edits put in place of a hole is one token (`isOneToken`); and the `?name`s of a text
 * (`holeTokenNames`), which the backend's holes and the Holes view read. The line reader runs the
 * lexer of `core/idrisLexer.ts` — the one M0's `lex` runs — a line at a time, so that it reads every
 * lexeme as `lex` does (`test/unit/idrisSyntaxLines.test.ts` checks it). References are to v0.8.0
 * [src]. Pure; no `vscode` import.
 */
import { compilerLiterateStyleOf, hasLineMarkers, isIdrisSpace, linePrefixWidth, type LiterateStyle } from '../project/literate';
import {
  codeDepth,
  identEnd,
  isIdentStart as isIdentStartChar,
  isIdentTrailing as isIdentTrailingChar,
  isLineCommentAt,
  lexText,
  OPERATOR_CHARACTERS,
  START,
  startsInside,
  startsInStringText,
  type GroupKind,
  type LexemeSink,
  type LexerState,
  type TokenKind,
} from './idrisLexer';
import { displayLine, doubledLinesAbove, type PositionDocument } from './positions';

// -------------------------------------------------------------------------------------------
// Tables
// -------------------------------------------------------------------------------------------

/** The lexer's tables (`core/idrisLexer.ts`), which the modules above read from here. */
export { GROUP_SYMBOLS, isKeyword, KEYWORDS, OPERATOR_CHARACTERS } from './idrisLexer';

/** `reservedInfixSymbols` (`src/Parser/Lexer/Source.idr` 244–248 [src]): symbols that are syntax, never a declared operator. */
export const RESERVED_INFIX_SYMBOLS: ReadonlySet<string> = new Set([
  '%', '\\', ':', '=', ':=', '$=', '|', '|||', '<-', '->', '=>', '?', '!', '&', '**', '..', '~', '@',
]);

/** Visibility and totality keywords (`visOption`, `totalityOpt`, `src/Idris/Parser.idr` [src]). */
export const MODIFIER_KEYWORDS: ReadonlySet<string> = new Set(['public', 'export', 'private', 'total', 'partial', 'covering']);

/** The pragmas accepted before a type signature (`fnDirectOpt`, `src/Idris/Parser.idr` 1123–1160 [src]; master has the same). */
export const FUNCTION_PRAGMAS: ReadonlySet<string> = new Set([
  '%hint', '%globalhint', '%defaulthint', '%inline', '%unsafe', '%noinline', '%deprecate',
  '%tcinline', '%extern', '%macro', '%spec', '%foreign', '%export', '%nomangle',
]);

/** The function-option pragmas that take arguments: `%spec` names, `%foreign` and `%export` a block of expressions. */
const PRAGMAS_WITH_ARGUMENTS: ReadonlySet<string> = new Set(['%spec', '%foreign', '%export', '%nomangle']);

// -------------------------------------------------------------------------------------------
// The line reader
// -------------------------------------------------------------------------------------------

/**
 * A token of a code line at its bracket level (`levelTokens`), read from the lexer's tokens
 * (`core/idrisLexer.ts`): a name (an identifier, qualified or not, a `.field`, or `_`), a keyword, a
 * symbol (an operator, `,` or `;`), a pragma (`%inline`), a number, a string literal (where it ends;
 * raw and interpolated ones too), a bracketed group (where it closes), a backtick, or anything else (a
 * character literal, a hole `?name`, a doc comment, a `%cg` directive, a character the lexer does not
 * recognise).
 */
interface LevelToken {
  readonly kind: 'name' | 'keyword' | 'symbol' | 'pragma' | 'number' | 'string' | 'group' | 'tick' | 'other';
  /** The token's text; for a group, the operator in parentheses it is (`(<&&>)`), else `''`. */
  readonly text: string;
  /** For a group that is no operator in parentheses: the last character of the symbol that closed it (`)`, `]` or `}`). */
  readonly closer?: string;
  /** The number of brackets and interpolations open around it (a group's closing token: around the group). */
  readonly depth: number;
}

/**
 * What is open at the start of a line (`core/idrisLexer.ts` `LexerState`): the bracket groups,
 * strings and interpolations open there, and a block comment or character literal the line break
 * before it cut. Shared by the lines that start with it, never changed (a line's reading costs its
 * own length, whatever is open).
 */
export type OpenBlock = LexerState;

/** Nothing open. */
export const NOTHING_OPEN: OpenBlock = START;

/**
 * Whether a line that starts with `open` starts inside something (a block comment, a string's text or
 * an interpolation's code, a character literal): it is part of the line that opened it.
 */
export function isOpen(open: OpenBlock): boolean {
  return startsInside(open);
}

/** A sink that reads nothing (`openAfter`). */
const NO_SINK: LexemeSink = { token() {}, open() {}, close() {}, drop() {} };

/**
 * Reads the code line `code`, which starts with `open` open and is followed by a line break, as the
 * lexer reads it (`core/idrisLexer.ts` `lexText`), and returns what is open at its end. On a prefix of
 * a line that ends where a token of code starts (the code before a hole), that is what is open there.
 * Linear in the line's length.
 */
export function openAfter(code: string, open: OpenBlock): OpenBlock {
  return lexText(code, open, 'line', NO_SINK);
}

/**
 * `code` without its line comment, if it has one (`--` or `|||` outside strings and block comments,
 * as the lexer reads them). The line must not start inside a block comment or string (`openAfter`).
 */
export function withoutLineComment(code: string): string {
  return code.slice(0, scanned(code, false).end);
}

/**
 * The tokens of the code line `code` at its bracket level (with `allLevels`, inside brackets and
 * string interpolations too), up to a line comment (`LevelToken`). A string is one token once it ends
 * on the line. The line must not start inside a block comment or string (`openAfter`). Linear in its
 * length.
 */
export function levelTokens(code: string, allLevels = false): LevelToken[] {
  return scanned(code, allLevels).tokens;
}

/**
 * Whether the code `code` closes a bracket it did not open, read as `levelTokens` reads it (strings,
 * characters and comments skipped): the compiler's expression parser stops there and drops the rest
 * (Refine Hole's expression, `backend/ide/edits.ts` `nameProblem`).
 */
export function closesUnopened(code: string): boolean {
  return scanned(code, false).unopened;
}

/** The kinds of token that `isOneToken` accepts: a name, a number, a string, a literal or a hole, a bracketed group. */
const ONE_TOKEN_KINDS: ReadonlySet<LevelToken['kind']> = new Set(['name', 'number', 'string', 'other', 'group']);

/**
 * Whether the text `code` is one token as `levelTokens` reads it — a name (qualified or not), a
 * number, a string or character literal, a hole `?name`, an operator in parentheses — or one
 * bracketed group (`(S n)`, `[1, 2]`; not `(a) + (b)`) whose brackets the lexer pairs (not `(a]`),
 * with nothing else but white space and closed block comments: read to its end (no line comment, no
 * string, block comment or character literal left open, none that a line break would end), no
 * bracket left open or closed that it did not open. Not a postfix projection `.x` (`dotIdent`): one
 * token to the lexer, but the parser applies it to the expression before it, space or not
 * (`simpleExpr`, `src/Idris/Parser.idr` 572–581 [src]; `g .x` is `(.x) g`). The edits put an answer
 * that is not one token in parentheses (`backend/ide/edits.ts` `inPlace`).
 */
export function isOneToken(code: string): boolean {
  const { tokens, unopened, depth, complete, mismatched } = scanned(code, false);
  return (
    complete && depth === 0 && !unopened && !mismatched && tokens.length === 1 && ONE_TOKEN_KINDS.has(tokens[0].kind) &&
    !(tokens[0].kind === 'name' && tokens[0].text.startsWith('.'))
  );
}

/**
 * The column of the first token of the code line `code`, which starts with `open` open (`openAfter`),
 * as the compiler's layout reads it: in code points (a tab is one), past white space (`isIdrisSpace`)
 * and comments, also a block comment the line starts in, and past the `'` that ends a character
 * literal the line break before it cut (a token that starts above); `undefined` when the line holds
 * no token (blank, comments only), `'string'` when it starts in the text of a string (a `"""` one, or
 * a `"` one whose escape took the line break). A line that starts in the code of an interpolation is
 * read as code.
 */
export function firstTokenColumn(code: string, open: OpenBlock): number | 'string' | undefined {
  if (startsInStringText(open)) {
    return 'string';
  }
  const from = open.cut?.type === 'char' && code.startsWith("'") ? 1 : 0;
  let first: number | undefined;
  const see = (start: number): void => {
    if (first === undefined && start >= from) {
      first = start;
    }
  };
  lexText(code, open, 'line', {
    token: (kind, start) => {
      if (kind !== 'comment') {
        see(start);
      }
    },
    open: (_, start) => see(start),
    close: (_, start) => see(start),
    drop() {},
  });
  return first === undefined ? undefined : [...code.slice(0, first)].length;
}

/** What `scanned` read. */
interface Reading {
  /** `levelTokens`. */
  readonly tokens: LevelToken[];
  /** Whether a closing bracket came that nothing open closes (`closesUnopened`): the lexer reads it as a character it does not recognise. */
  readonly unopened: boolean;
  /** The brackets and interpolations left open (counting those `open` had). */
  readonly depth: number;
  /** Whether it read the code to its end: no line or doc comment, nothing left open but brackets, no `"` string a line break ends. */
  readonly complete: boolean;
  /** Whether a closing bracket closed a group around one it left unclosed (`([a)`). */
  readonly mismatched: boolean;
  /** Where each `` `[ `` opened: the index of the next token, the depth around it. */
  readonly quotes: readonly { readonly at: number; readonly depth: number }[];
  /** What is open at its end (`openAfter`). */
  readonly open: OpenBlock;
  /** Where its first line or doc comment starts, else the code's length (`withoutLineComment`). */
  readonly end: number;
}

/**
 * Reads the code `code`, which starts with `open` open and is followed by a line break, with the
 * lexer of `core/idrisLexer.ts`, and makes its `LevelToken`s (with `allLevels`, those inside brackets
 * and interpolations too): a string where it ends, a bracket group where it closes (as one operator in
 * parentheses, `(<&&>)`, when it holds one operator and nothing else and is at level 0), an
 * interpolation's `}` (with `allLevels`) where it closes. Linear in the code's length.
 */
function scanned(code: string, allLevels: boolean, open: OpenBlock = NOTHING_OPEN): Reading {
  const tokens: LevelToken[] = [];
  let unopened = false;
  let mismatched = false;
  let end = code.length;
  const quotes: { readonly at: number; readonly depth: number }[] = [];
  // The groups opened in `code` and still open, innermost last: where a string started; for a `(` at
  // level 0, the number of lexemes seen at it and of tokens then (an operator in parentheses).
  const opened: { readonly kind: GroupKind; readonly start: number; readonly paren?: { readonly lexemes: number; readonly tokens: number } }[] = [];
  let lexemes = 0;
  let last: { readonly kind: TokenKind; readonly text: string } | undefined;
  const add = (token: LevelToken): void => {
    if (token.depth === 0 || allLevels) {
      tokens.push(token);
    }
  };
  const sink: LexemeSink = {
    token(kind, start, endAt, depth) {
      lexemes++;
      const text = code.slice(start, endAt);
      last = { kind, text };
      switch (kind) {
        case 'comment': {
          // A line comment (not a piece of a block comment the line starts in, nor one that starts here).
          const block = (start === 0 && open.cut?.type === 'comment') || code.startsWith('{-', start);
          if (!block && end === code.length) {
            end = start;
          }
          return;
        }
        case 'docComment':
          if (end === code.length) {
            end = start;
          }
          add({ kind: 'other', text, depth });
          return;
        case 'keyword':
          add({ kind: 'keyword', text, depth });
          return;
        case 'symbol':
          add({ kind: text === '`' ? 'tick' : text === '_' ? 'name' : 'symbol', text, depth });
          return;
        case 'pragma':
          add({ kind: 'pragma', text, depth });
          return;
        case 'number':
          add({ kind: 'number', text, depth });
          return;
        case 'unrecognised':
          unopened ||= text === ')' || text === ']' || text === '}';
          add({ kind: 'other', text, depth });
          return;
        case 'stringText':
          return;
        default:
          add({ kind: kind === 'ident' ? 'name' : 'other', text, depth });
      }
    },
    open(kind, start, endAt, depth) {
      lexemes++;
      last = undefined;
      const symbol = code.slice(start, endAt);
      if (symbol === '`[') {
        quotes.push({ at: tokens.length, depth });
      }
      opened.push({ kind, start, paren: symbol === '(' && depth === 0 ? { lexemes, tokens: tokens.length } : undefined });
    },
    close(kind, start, endAt, depth) {
      const group = opened.pop();
      const paren = group?.paren;
      const operator = last;
      lexemes++;
      last = undefined;
      if (kind === 'string') {
        add({ kind: 'string', text: code.slice(group?.start ?? 0, endAt), depth });
      } else if (kind === 'interpolation') {
        if (allLevels) {
          add({ kind: 'group', text: '', closer: '}', depth });
        }
      } else if (
        paren !== undefined &&
        lexemes === paren.lexemes + 2 &&
        operator?.kind === 'symbol' &&
        operator.text !== ',' && operator.text !== ';' && operator.text !== '_' && operator.text !== '`' &&
        !RESERVED_INFIX_SYMBOLS.has(operator.text)
      ) {
        // `(`, one operator, `)`: the operator in parentheses, one token (the operator's own was added inside with `allLevels`).
        tokens.length = paren.tokens;
        add({ kind: 'group', text: `(${operator.text})`, depth });
      } else {
        add({ kind: 'group', text: '', closer: code.slice(endAt - 1, endAt), depth });
      }
    },
    drop(kind) {
      opened.pop();
      mismatched ||= kind !== 'string';
    },
  };
  const after = lexText(code, open, 'line', sink);
  const complete = end === code.length && !startsInside(after) && !after.unsure;
  return { tokens, unopened, depth: codeDepth(after), complete, mismatched, quotes, open: after, end };
}

// -------------------------------------------------------------------------------------------
// Layout blocks
// -------------------------------------------------------------------------------------------

/**
 * The layout blocks of `src/Idris/Parser.idr` (v0.8.0) [src] — every call of the block family of
 * `src/Parser/Rule/Source.idr` (`block` 618, `blockAfter` 634, `blockWithOptHeaderAfter` 647,
 * `nonEmptyBlock` 673, `nonEmptyBlockAfter` 691; each reads its first entry at the column of the next
 * token, 599–627) — with what opens each; the block's first entry starts at the token after the opener
 * and its header:
 * - `where`: a clause's (`whereBlock` 151–155), a `data` declaration's (1385–1387, after options
 *   `[…]`), an interface's (1773–1775, after an optional `constructor` name), an implementation's
 *   (1796) and a record's (1848–1852, `blockWithOptHeaderAfter`, after options) — read
 *   conservatively: the options and the constructor name count as the first entry;
 * - `of` (`case_` 852), `do` (950), a namespaced `M.do` (`namespacedIdent` with the name `do`,
 *   954–961), `let` (`let_` 841; in a `do` block 987; its entries can be local declarations,
 *   `letDecl` 835), `\case` (`lam` 775–781, 813), `` `[ `` (quoted declarations, 627);
 * - `%foreign` (1154), `%export` and the deprecated `%nomangle` (1159), each a block of expressions,
 *   and `%foreign_impl` with its name (1463);
 * - `mutual` (1623), `failing` with its optional message (a string, 1613), `namespace` with its
 *   name (1586), `using` with its `(…)` (1637), `parameters` with its binders, each `(…)` or `{…}`
 *   (`typedArg` 1815–1827; the old syntax one `(…)`, 1877), and `with` with its header — `%syntactic`
 *   flags, then problems separated by `|`, each an optional quantity, `(…)` and an optional `proof`
 *   and name (`withProblem` 1231, 1263);
 * - a `|`, the first token of an entry of the alternatives after a `let` binder's value (831) or a
 *   `<-` bind's value (999) (`patAlt` 1005), read conservatively: any `|` counts;
 * - and, within any block, `;`, after which the next entry starts (`terminator`, `Rule/Source.idr`
 *   561–569).
 * The imports and the top-level declarations of a module (`progHdr` 2000, `prog` 2010) are blocks
 * too, but their first entry starts the text, never after a hole. An interpolation is not a block
 * (`interpBlock`, 1073).
 */
const ENTRY_KEYWORDS: ReadonlySet<string> = new Set(['where', 'of', 'do', 'let', 'mutual']);

/** The pragmas whose block of expressions starts at the next token (`%foreign`, `%export`, `%nomangle`). */
const ENTRY_PRAGMAS: ReadonlySet<string> = new Set(['%foreign', '%export', '%nomangle']);

/** The keywords whose block starts after a header in brackets that can hold a hole: `parameters`, `using`, `with`. */
const HEADER_KEYWORDS: ReadonlySet<string> = new Set(['parameters', 'using', 'with']);

const isSymbol = (t: LevelToken | undefined, text: string): boolean => t?.kind === 'symbol' && t.text === text;

/**
 * The index of the group token that closes the group whose first token is `tokens[i]` (`allLevels`
 * tokens: its inner tokens are deeper than `depth`, the depth around it; an empty group is its
 * closing token alone), when it closes with one of `closers`; `'open'` when `tokens` end first (also
 * when `i` is past them); `undefined` when `tokens[i]` is not in such a group.
 */
function groupEnd(tokens: readonly LevelToken[], i: number, depth: number, closers: string): number | 'open' | undefined {
  for (let k = i; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.depth <= depth) {
      return t.depth === depth && t.kind === 'group' && t.closer !== undefined && closers.includes(t.closer) ? k : undefined;
    }
  }
  return 'open';
}

/**
 * Where the header of the block opener `tokens[i]` (at `allLevels`) ends: the index of its last
 * token, `i` itself for an opener without a header, or `undefined` when `tokens[i]` opens no block or
 * its header does not end in `tokens` (`ENTRY_KEYWORDS`). A header the parser would reject ends where
 * it stops being one.
 */
function headerEnd(tokens: readonly LevelToken[], i: number): number | undefined {
  const t = tokens[i];
  const d = t.depth;
  const at = (k: number): LevelToken | undefined => (tokens[k]?.depth === d ? tokens[k] : undefined);
  if (t.kind === 'keyword') {
    if (ENTRY_KEYWORDS.has(t.text) || (t.text === 'case' && isSymbol(tokens[i - 1], '\\') && tokens[i - 1].depth === d)) {
      return i;
    }
    switch (t.text) {
      case 'failing':
        return at(i + 1)?.kind === 'string' ? i + 1 : i;
      case 'namespace':
        return at(i + 1)?.kind === 'name' ? i + 1 : undefined;
      case 'using': {
        const close = groupEnd(tokens, i + 1, d, ')');
        return close === 'open' ? undefined : (close ?? i);
      }
      case 'parameters': {
        let end = i;
        for (;;) {
          const close = groupEnd(tokens, end + 1, d, ')}');
          if (close === 'open') {
            return undefined;
          }
          if (close === undefined) {
            return end;
          }
          end = close;
        }
      }
      case 'with':
        return withHeaderEnd(tokens, i, d);
      default:
        return undefined;
    }
  }
  if (t.kind === 'pragma') {
    return ENTRY_PRAGMAS.has(t.text) ? i : t.text === '%foreign_impl' && at(i + 1)?.kind === 'name' ? i + 1 : undefined;
  }
  if (t.kind === 'name' && t.text.endsWith('.do') && !t.text.startsWith('.')) {
    return i;
  }
  return isSymbol(t, ';') ? i : undefined;
}

/** `headerEnd` of the `with` at `tokens[i]`, at depth `d`: its flags, then its problems separated by `|` (`withProblem`). */
function withHeaderEnd(tokens: readonly LevelToken[], i: number, d: number): number | undefined {
  const at = (k: number): LevelToken | undefined => (tokens[k]?.depth === d ? tokens[k] : undefined);
  let k = i + 1;
  while (at(k)?.kind === 'pragma') {
    k++;
  }
  for (;;) {
    if (at(k)?.kind === 'number') {
      k++;
    }
    const close = groupEnd(tokens, k, d, ')');
    if (close === 'open') {
      return undefined;
    }
    if (close === undefined) {
      return k - 1;
    }
    k = close + 1;
    if (at(k)?.kind === 'keyword' && at(k)?.text === 'proof') {
      k += at(k + 1)?.kind === 'number' ? 2 : 1;
      if (at(k)?.kind === 'name') {
        k++;
      }
    }
    if (!isSymbol(at(k), '|')) {
      return k - 1;
    }
    k++;
  }
}

/**
 * Whether the code `rest` (the rest of a line after a hole, which starts with `open` open: the
 * `openAfter` of the code before the hole) starts an entry of a layout block on the line: a token of
 * it (inside brackets and string interpolations too) opens a block (`ENTRY_KEYWORDS`, with its header)
 * and the token after it is on the line and starts that block's first entry — it is not a bracket
 * that closes a group opened before the opener (`of ()` counts, `(case x of)` does not) — or it is a
 * `|` not followed by such a bracket, itself an entry's first token (read conservatively: the `|` of
 * any alternative, a list comprehension's included, but not the one of `|]`, part of the symbol that
 * closes an idiom bracket). Also true when the reading is `unsure` (`core/idrisLexer.ts`: a `"` string
 * a line break ends, which the compiler rejects). The parser takes an entry's column from its first
 * token, so text of another width written before it moves it, and the lines below are read against
 * the new column (`backend/ide/edits.ts` `layoutProblem`). Read conservatively: a block that also
 * closes on the line (`let … in`, `(do x)`) counts.
 */
export function opensBlockOnLine(rest: string, open: OpenBlock = NOTHING_OPEN): boolean {
  const { tokens, quotes, open: after } = scanned(rest, true, open);
  // The token after token `e` is on the line and is not a bracket that closes a group opened before token `opener`.
  const entryAfter = (opener: number, e: number): boolean => e + 1 < tokens.length && (tokens[e + 1].closer === undefined || tokens[e + 1].depth >= tokens[opener].depth);
  return (
    // Unsure from the code before the hole or from the rest (`unsure` stays once set).
    after.unsure ||
    // A `` `[ `` (no token of its own) with a token inside it.
    quotes.some((q) => (tokens[q.at]?.depth ?? -1) > q.depth) ||
    tokens.some((t, i) => {
      if (isSymbol(t, '|')) {
        return i + 1 >= tokens.length || tokens[i + 1].closer === undefined || tokens[i + 1].depth >= t.depth;
      }
      const e = headerEnd(tokens, i);
      return e !== undefined && entryAfter(i, e);
    })
  );
}

/**
 * Whether the code `code` — an entry's code from its start (which starts with `open` open) up to a
 * hole, its lines joined with `\n` — ends inside the header of a `parameters`, `using` or `with`
 * block (`HEADER_KEYWORDS`): after the keyword come only that header's tokens (`parameters`: binders
 * `(…)` and `{…}`; `using`: one `(…)`; `with`: flags, quantities, `(…)`, `proof`, a name, `|`), and
 * the code ends inside one of its brackets. The block's first entry can then follow on the hole's
 * line, right of the hole (`parameters (n : ?h) g : Nat`, also when the header started on a line
 * above: `parameters (n : Nat)` / `(m : ?h) g : Nat`). A hole in a `with` problem does not load in
 * 0.8.0 (`h is already defined` [live, M4's second review of the fixes]); it is read all the same.
 */
export function holdsBlockHeader(code: string, open: OpenBlock): boolean {
  const { tokens, depth } = scanned(code, true, open);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind !== 'keyword' || !HEADER_KEYWORDS.has(t.text)) {
      continue;
    }
    const d = t.depth;
    const after = tokens.slice(i + 1).filter((u) => u.depth === d);
    const allowed =
      t.text === 'using'
        ? after.length === 0
        : t.text === 'parameters'
          ? after.every((u) => u.kind === 'group' && (u.closer === ')' || u.closer === '}'))
          : after.every((u) => u.kind === 'pragma' || u.kind === 'number' || u.kind === 'name' || (u.kind === 'keyword' && u.text === 'proof') || isSymbol(u, '|') || (u.kind === 'group' && u.closer === ')'));
    return allowed && depth > d && tokens.slice(i + 1).every((u) => u.depth >= d);
  }
  return false;
}

/**
 * The names after each `?` of `text` (`?vlen_rhs` → `vlen_rhs`; `identNormal`, `core/idrisLexer.ts`
 * `identEnd`), read in one pass: the holes the text may hold (comments and strings included). The
 * backend's holes (`backend/ide/holes.ts`) and the Holes view (`features/holes/model.ts`) read the
 * loaded text with it.
 */
export function holeTokenNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (let at = text.indexOf('?'); at >= 0; at = text.indexOf('?', at + 1)) {
    const end = identEnd(text, at + 1);
    if (end > at + 1) {
      names.add(text.slice(at + 1, end));
    }
  }
  return names;
}

/** Whether `t` can be a declared operator: a symbol that is not reserved syntax. */
const isOperatorToken = (t: LevelToken | undefined): t is LevelToken => t?.kind === 'symbol' && t.text !== ',' && t.text !== ';' && !RESERVED_INFIX_SYMBOLS.has(t.text);

/** A modifier keyword or a function-option pragma. */
const isOption = (t: LevelToken | undefined): boolean => (t?.kind === 'keyword' && MODIFIER_KEYWORDS.has(t.text)) || (t?.kind === 'pragma' && FUNCTION_PRAGMAS.has(t.text));

/**
 * The names the type declaration `code` (unindented) declares, as the requests take them
 * (`(<&&>)` for an operator), or `undefined` when it is not one: modifiers and function-option
 * pragmas, an optional quantity `0` or `1`, names separated by commas, then `:` (the shape
 * `signatureNames` of `features/editing/targets.ts` reads).
 */
export function signatureNames(code: string): string[] | undefined {
  const tokens = levelTokens(code);
  let i = 0;
  while (isOption(tokens[i])) {
    i++;
  }
  if (tokens[i]?.kind === 'number' && (tokens[i].text === '0' || tokens[i].text === '1')) {
    i++;
  }
  const names: string[] = [];
  for (;;) {
    const t = tokens[i];
    if (t === undefined || !((t.kind === 'name' && !t.text.includes('.')) || (t.kind === 'group' && t.text !== ''))) {
      return undefined;
    }
    names.push(t.text);
    const sep = tokens[i + 1];
    if (sep?.kind === 'symbol' && sep.text === ',') {
      i += 2;
      continue;
    }
    return sep?.kind === 'symbol' && sep.text === ':' ? names : undefined;
  }
}

/**
 * The name the clause `code` (unindented) defines, as the requests take it, or `undefined` when
 * it is not a clause: of its left-hand side (the tokens before its first `=`, `=>`, `with` or
 * `impossible`, or the whole line when the clause goes on), the backticked name (`` S k `plus2`
 * y ``), else the first operator (`x <&&> y`), else the first token, a name or an operator in
 * parentheses (`(<&&>) True y`) — the name `clauseName` of `features/editing/targets.ts` reads. A
 * left-hand side that starts with a keyword (`let y`, `where go y`) is no clause.
 */
export function clauseName(code: string): string | undefined {
  const tokens = levelTokens(code);
  const sep = tokens.findIndex((t) => t.kind === 'keyword' || (t.kind === 'symbol' && (t.text === '=' || t.text === '=>')));
  const lhs = sep < 0 ? tokens : tokens.slice(0, sep);
  const end = tokens[sep];
  if (lhs.length === 0 || (end?.kind === 'keyword' && end.text !== 'with' && end.text !== 'impossible') || lhs.some((t) => t.kind === 'symbol' && t.text === ':')) {
    return undefined;
  }
  for (let i = 0; i + 2 < lhs.length; i++) {
    if (lhs[i].kind === 'tick' && lhs[i + 1].kind === 'name' && lhs[i + 2].kind === 'tick') {
      return lhs[i + 1].text;
    }
  }
  const op = lhs.find(isOperatorToken);
  if (op !== undefined) {
    return `(${op.text})`;
  }
  const first = lhs[0];
  return (first.kind === 'name' && !first.text.includes('.')) || (first.kind === 'group' && first.text !== '') ? first.text : undefined;
}

/**
 * Whether the clause `code` (unindented) binds a pattern variable named like the function it defines
 * (`clauseName`): a name token of its left-hand side, at any bracket level, repeats that name. Idris
 * 2 rejects such a clause (`Declaration name (f) shadowed by a pattern variable` [live, M4's eighth
 * review]).
 */
export function shadowsItsName(code: string): boolean {
  const name = clauseName(code);
  if (name === undefined || name.startsWith('(')) {
    return false;
  }
  const tokens = levelTokens(code, true);
  const sep = tokens.findIndex((t) => t.depth === 0 && (t.kind === 'keyword' || (t.kind === 'symbol' && (t.text === '=' || t.text === '=>'))));
  return (sep < 0 ? tokens : tokens.slice(0, sep)).filter((t) => t.kind === 'name' && t.text === name).length > 1;
}

/**
 * Whether `code` (unindented) holds only function options: modifiers and function-option pragmas
 * (`public export`, `%inline`), the arguments of those that take some (`%foreign "C:puts"`)
 * included, and no `:`.
 */
export function isOptionLine(code: string): boolean {
  const tokens = levelTokens(code);
  let argumentsOf = false;
  for (const t of tokens) {
    if (isOption(t)) {
      argumentsOf = PRAGMAS_WITH_ARGUMENTS.has(t.text);
    } else if (!argumentsOf || (t.kind === 'symbol' && t.text === ':')) {
      return false;
    }
  }
  return tokens.length > 0;
}

// -------------------------------------------------------------------------------------------
// Make With's clause
// -------------------------------------------------------------------------------------------

/** Whether `rest` is only white space (`isIdrisSpace`), or white space and a line comment (`core/idrisLexer.ts` `isLineCommentAt`). */
function isBlankOrComment(rest: string): boolean {
  let at = 0;
  while (at < rest.length && isIdrisSpace(rest[at])) {
    at++;
  }
  return at === rest.length || isLineCommentAt(rest, at);
}

/**
 * The offset of the first `=` of `s` outside `(…)` and `{…}`, counted as `makeWith`'s `readLHS`
 * counts (`src/Idris/IDEMode/MakeClause.idr` [src]: `[`, strings and comments are not special; a
 * `)` or `}` at depth 0 stays at 0), or -1.
 */
function firstLhsEquals(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && depth === 0) {
      return i;
    }
    if (c === '(' || c === '{') {
      depth++;
    } else if ((c === ')' || c === '}') && depth > 0) {
      depth--;
    }
  }
  return -1;
}

/** Whether the `=` at `i` of `s` is the symbol `=`, not part of an operator (`=>`, `==`, `<=`). */
const isEqualsSymbol = (s: string, i: number): boolean => !OPERATOR_CHARACTERS.includes(s.charAt(i - 1) || ' ') && !OPERATOR_CHARACTERS.includes(s.charAt(i + 1) || ' ');

/** A line's literate marker with the one space after it (`''` without markers), and its code. */
export interface CodeLine {
  readonly prefix: string;
  readonly code: string;
}

/** The code of `lineText` in a file of the literate style `style`, or `undefined` for a line that is not code (bird-track prose). */
export function codeLineOf(style: LiterateStyle | undefined, lineText: string): CodeLine | undefined {
  if (!hasLineMarkers(style)) {
    return { prefix: '', code: lineText };
  }
  const width = linePrefixWidth(style, lineText);
  return width === undefined ? undefined : { prefix: lineText.slice(0, width), code: lineText.slice(width) };
}

/**
 * The marker `isLitLine` finds on a code line — `linePrefixWidth`'s marker when a space follows it
 * (`> x`, `> `; alone, without its line break, a marker is not a code line to it, `Literate.idr`
 * `rawTokens` [src]) — or `undefined`.
 */
export function markerOf(line: CodeLine | undefined): string | undefined {
  return line !== undefined && line.prefix.length > 1 && isIdrisSpace(line.prefix.slice(-1)) ? line.prefix.slice(0, -1) : undefined;
}

/**
 * (M4) The lines above `line` that the compiler counts twice (`doubledLinesAbove`, F11 addendum)
 * when they make it read another line of the raw source than `line` for `:case-split`,
 * `:add-clause` or `:generate-def`, which find their place by the lexer's line and read the source
 * line of that number (`backend/ide/edits.ts`, *Lines the compiler numbers otherwise*); else `[]`.
 * With `markerOnly` (`:add-clause`, `:generate-def`, which read that line only for its literate
 * marker) `[]` also when the line read has `line`'s marker. The backend refuses those requests there,
 * and the light bulb shows them disabled.
 */
export function misreadBelow(doc: PositionDocument, line: number, markerOnly: boolean): readonly number[] {
  const doubled = doubledLinesAbove(doc, line);
  if (doubled.length === 0 || !markerOnly) {
    return doubled;
  }
  const style = compilerLiterateStyleOf(doc);
  const codeLine = (at: number): CodeLine | undefined => (at < doc.lineCount ? codeLineOf(style, doc.lineAt(at).text) : undefined);
  const own = markerOf(codeLine(line));
  return own !== undefined && own === markerOf(codeLine(line + doubled.length)) ? [] : doubled;
}

/** The longest list of lines `doubledLinesText` writes out. */
const MAX_LINES_NAMED = 10;

/**
 * `misreadBelow`'s lines as its messages name them (the gutter's numbers): `line 16, which holds`, or
 * `lines 16 and 20, which hold` (at most `MAX_LINES_NAMED`, then how many more).
 */
export function doubledLinesText(lines: readonly number[]): string {
  const shown = lines.slice(0, MAX_LINES_NAMED).map((l) => String(displayLine(l)));
  if (shown.length === 1) {
    return `line ${shown[0]}, which holds`;
  }
  const more = lines.length - shown.length;
  const listed = more > 0 ? `${shown.join(', ')} and ${more} more` : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return `lines ${listed}, which hold`;
}

/**
 * Make With's clause: the line of the `=` that `makeWith` cuts at, when the text before that `=` is
 * a function clause's left-hand side (`clauseName`: not `let y`, not `where go y`) and the `=` is
 * followed by the hole at columns `hole` of `line` alone (with a comment after it at most) — `line`
 * itself, or the line before when the hole starts its line and that line ends in the `=`; else
 * `undefined`. `codeLine` gives a line's code (`undefined`: not a code line, or not in the text).
 */
export function withClauseStart(codeLine: (line: number) => CodeLine | undefined, line: number, hole: { readonly start: number; readonly end: number }): number | undefined {
  const own = codeLine(line);
  if (own === undefined) {
    return undefined;
  }
  const lineText = own.prefix + own.code;
  if (!isBlankOrComment(lineText.slice(hole.end))) {
    return undefined;
  }
  const isClause = (cl: CodeLine, eq: number): boolean => clauseName((cl.prefix + cl.code).slice(cl.prefix.length, eq).trimStart()) !== undefined;
  const eq = firstLhsEquals(lineText);
  if (eq >= 0 && eq < hole.start) {
    return isEqualsSymbol(lineText, eq) && lineText.slice(eq + 1, hole.start).trim() === '' && isClause(own, eq) ? line : undefined;
  }
  const previous = line > 0 ? codeLine(line - 1) : undefined;
  if (previous === undefined || lineText.slice(own.prefix.length, hole.start).trim() !== '') {
    return undefined;
  }
  const previousText = previous.prefix + previous.code;
  const at = firstLhsEquals(previousText);
  return at >= 0 && isEqualsSymbol(previousText, at) && previousText.slice(at + 1).trim() === '' && isClause(previous, at) ? line - 1 : undefined;
}

// -------------------------------------------------------------------------------------------
// Case Split's line
// -------------------------------------------------------------------------------------------

/** `isIdentStart Normal` (`core/idrisLexer.ts`) of the code point `c`. */
function isIdentStart(c: number | undefined): c is number {
  return c !== undefined && isIdentStartChar(String.fromCodePoint(c));
}

/** `isIdentTrailing Normal` (`core/idrisLexer.ts`) of the code point `c`. */
export function isIdentTrailing(c: number | undefined): c is number {
  return c !== undefined && isIdentTrailingChar(String.fromCodePoint(c));
}

/**
 * The tokens `:case-split` reads its line as (`tokens`, `Idris/IDEMode/TokenLine.idr` [src]), white
 * space left out: an `identNormal` name, `?` + such a name, else one character. There are no
 * comment or string tokens: a word in a comment or a string is a `name` too.
 */
interface SourcePart {
  readonly kind: 'name' | 'hole' | 'other';
  readonly text: string;
  /** Its UTF-16 offset in the line. */
  readonly at: number;
}

/** `s`'s `SourcePart`s (`TokenLine.tokens`, its `Whitespace` left out). Linear in its length. */
function sourceParts(s: string): SourcePart[] {
  const parts: SourcePart[] = [];
  const nameEnd = (from: number): number => {
    let at = from;
    for (let c = s.codePointAt(at); isIdentTrailing(c); c = s.codePointAt(at)) {
      at += String.fromCodePoint(c).length;
    }
    return at;
  };
  let i = 0;
  while (i < s.length) {
    const c = s.codePointAt(i) ?? 0;
    const width = String.fromCodePoint(c).length;
    if (isIdentStart(c)) {
      const end = nameEnd(i + width);
      parts.push({ kind: 'name', text: s.slice(i, end), at: i });
      i = end;
    } else if (c === 0x3f && isIdentStart(s.codePointAt(i + 1))) {
      const end = nameEnd(i + 1 + String.fromCodePoint(s.codePointAt(i + 1) ?? 0).length);
      parts.push({ kind: 'hole', text: s.slice(i, end), at: i });
      i = end;
    } else {
      if (!isIdrisSpace(s.charAt(i))) {
        parts.push({ kind: 'other', text: s.slice(i, i + width), at: i });
      }
      i += width;
    }
  }
  return parts;
}

/**
 * Whether the name at UTF-16 offset `character` of the raw line `lineText` (its end included) names
 * an as-pattern (`xs@(y :: ys)`, `m@n`, `xs @(…)`): the next part is `@`, except after white space
 * when `{` follows the `@` (`x @{p}`, an auto-implicit argument). `:case-split` answers such a
 * clause unchanged once per constructor (`xs@(…)`, `xs @(…)`, `xs  @  (…)`, `x@{p}`), and splits
 * `x @{p}` [live, M4's ninth and final reviews]. The light bulb leaves Case Split out there and the
 * editing backend refuses it.
 */
export function namesAsPattern(lineText: string, character: number): boolean {
  const parts = sourceParts(lineText);
  const i = parts.findIndex((p) => p.kind === 'name' && p.at <= character && character <= p.at + p.text.length);
  const name = parts[i];
  const next = parts[i + 1];
  if (name === undefined || next?.text !== '@') {
    return false;
  }
  return next.at === name.at + name.text.length || parts[i + 2]?.text !== '{';
}

/**
 * What `getCaseStmtType` (`Idris/IDEMode/CaseSplit.idr` 196–240 [src]) makes of the raw line `s`:
 * when its tokens up to the first two `-` in a row end with a hole, or a hole and `)`, and a token
 * anywhere on the line is the name `of`, the compiler takes the line for a one-line `case` and
 * rewrites every line of its answer after the first as text from the column after that `of` on
 * (`oneline`); a hole and `)` without an `of` (`holeParen`, `at` that `)`) has the last `)` of each
 * line but the last removed (`parenTrim`). `undefined`: the answer is the line rewritten, nothing
 * more.
 */
function caseStatementType(parts: readonly SourcePart[]): { readonly kind: 'oneline' } | { readonly kind: 'holeParen'; readonly at: number } | undefined {
  const code = parts.slice(0, commentStart(parts));
  const last = code.at(-1);
  const paren = last?.kind === 'other' && last.text === ')' ? last : undefined;
  if (code.at(paren === undefined ? -1 : -2)?.kind !== 'hole') {
    return undefined;
  }
  if (parts.some((p) => p.kind === 'name' && p.text === 'of')) {
    return { kind: 'oneline' };
  }
  return paren === undefined ? undefined : { kind: 'holeParen', at: paren.at };
}

/** The index of the first of two `-` in a row in `parts` (where `doUpdates` stops), else `parts.length`. */
function commentStart(parts: readonly SourcePart[]): number {
  const at = parts.findIndex((p, i) => p.text === '-' && parts[i + 1]?.text === '-');
  return at < 0 ? parts.length : at;
}

/**
 * The names of `parts` (before `commentStart`) in the place of a braced named argument as
 * `doUpdates` reads it (`IDEMode/CaseSplit.idr` 100–137 [src]): a name followed by `=` right after
 * `{` (not `@{`), or after a `,` whose innermost open bracket is such a `{`. When `doUpdates`
 * updates that name — a pattern variable of the same name is split or refined — it writes `{n =
 * <new>` and keeps the text after the name, ` = n}`, whose `n` it updates too: `vlen {n = 0 = 0} []`
 * for `vlen {n = n} xs` [live, M4's eighth review].
 */
function namedArgumentNames(parts: readonly SourcePart[]): string[] {
  const end = commentStart(parts);
  const names: string[] = [];
  const open: string[] = [];
  const fieldAt = (i: number): void => {
    const name = parts[i];
    if (i < end && name?.kind === 'name' && parts[i + 1]?.text === '=' && parts[i + 2]?.text !== '=') {
      names.push(name.text);
    }
  };
  for (let i = 0; i < end; i++) {
    const p = parts[i];
    if (p.kind !== 'other') {
      continue;
    }
    if (p.text === '{') {
      const auto = parts[i - 1]?.text === '@' && parts[i - 1].at + 1 === p.at;
      open.push(auto ? '@{' : '{');
      if (!auto) {
        fieldAt(i + 1);
      }
    } else if (p.text === '(' || p.text === '[') {
      open.push(p.text);
    } else if (p.text === ')' || p.text === ']' || p.text === '}') {
      open.pop();
    } else if (p.text === ',' && open.at(-1) === '{') {
      fieldAt(i + 1);
    }
  }
  return names;
}

/**
 * Why `:case-split` on the line `lineText` (its code `code`, without a literate marker) would answer
 * with text that is not the line rewritten, or `undefined` (`caseStatementType`, `doUpdates` [src]):
 * - `of`: the word `of` anywhere on the line (a one-line `case`, whose variables the commands do not
 *   target, or a comment or a string): each new line but the first is cut at that column (`vlen [] =
 *   ?vlen_rhs_0 -- the length of the vector` / `length of the vector` [live, M4 edit review]);
 * - `paren`: a hole followed by `)`, unless that `)` closes a bracket of an earlier line (`g n = (case
 *   n of` / `  case_val => ?g_rhs)`, the compiler's case) and is the last `)` of the line: the
 *   compiler drops the last `)` of each new line but the last, which leaves `(?f_rhs_0` of `f xs =
 *   (?f_rhs)` unclosed (`Bracket is not properly closed` [live, M4 edit review]);
 * - `string`: a string holding a name of the line's code, or a hole: `doUpdates` rewrites names and
 *   holes inside strings too (`f [] "[]" = ?f_rhs_0` for `f xs "xs" = ?f_rhs` [live, M4 edit
 *   review]);
 * - `namedArgument`: a braced named argument (`namedArgumentNames`) whose name the code uses once
 *   more, as a variable (`{n = n}`, `MkP {x = x, y = y}`, `{x = y, y = x}`): the answer can repeat
 *   its `=` (`{n = 0 = 0}`, `MkP {x = x, y = False = False}` [live, M4's eighth review]).
 * The editing backend refuses Case Split there (`backend/ide/edits.ts`), and the light bulb shows it
 * disabled.
 */
export function caseSplitLineProblem(lineText: string, code: string): 'of' | 'paren' | 'string' | 'namedArgument' | undefined {
  const parts = sourceParts(lineText);
  const shape = caseStatementType(parts);
  if (shape?.kind === 'oneline') {
    return 'of';
  }
  const tokens = levelTokens(code, true);
  const last = tokens.at(-1);
  if (shape !== undefined && ((last?.kind === 'group' && last.text === '') || lineText.includes(')', shape.at + 1))) {
    return 'paren';
  }
  const names = tokens.filter((t) => t.kind === 'name').map((t) => t.text);
  const nameSet = new Set(names);
  if (tokens.some((t) => t.kind === 'string' && sourceParts(t.text).some((p) => p.kind === 'hole' || (p.kind === 'name' && nameSet.has(p.text))))) {
    return 'string';
  }
  const fields = namedArgumentNames(parts);
  const count = (list: readonly string[], name: string): number => list.filter((n) => n === name).length;
  return fields.some((field) => count(names, field) > count(fields, field)) ? 'namedArgument' : undefined;
}
