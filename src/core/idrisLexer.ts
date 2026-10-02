/**
 * The Idris 2 source lexer (`core/idrisLexer.ts`; M0's, moved out of `features/syntax/lexer.ts` in
 * M4): a tolerant port of the compiler's lexer that M0's `lex` (a whole text at once) and the line
 * reader of the edits (`core/idrisSyntax.ts`, one line at a time) both run, so that the two read every
 * lexeme alike: the rules, their order and the stack of what is open are this module's alone. Pure;
 * no `vscode` import.
 *
 * Every rule and its order come from the compiler — `rawTokens` and `stringTokens` in
 * `src/Parser/Lexer/Source.idr`, `comment`/`blockComment`/identifier rules in
 * `src/Parser/Lexer/Common.idr`, `charLit`/`stringLit`/`newline` and the numeric lexers in
 * `src/Libraries/Text/Lexer.idr`, `isOpChar` in `src/Core/Name.idr`, character classes in
 * `libs/prelude/Prelude/Types.idr` — identical between master 1c630e6 and v0.8.0 apart from
 * imports. As in the compiler's `Tokenizer` (`src/Libraries/Text/Lexer/Tokenizer.idr`), the first
 * rule that matches wins (not the longest), and inside a group or string interpolation the group's
 * closing delimiter is tried before any rule. Behaviour that surprises and was confirmed with
 * `idris2 --check` (0.8.0):
 * - `_foo` is the symbol `_` followed by `foo` (the `symbols` rule precedes identifiers):
 *   `_foo : Nat` fails with "Couldn't parse declaration" at the `_`;
 * - `--` starts a line comment wherever a token starts, unless the dashes are followed by `}`
 *   (then they are an operator): both `(-->) : …` and `foo = 1 --}` are rejected;
 * - inside a block comment, `--` starts a line comment that hides `-}` until the end of the
 *   line, and string and character literals are skipped, so `"-}"` does not close it; nested
 *   `{- -}` pairs are counted;
 * - a top-level `{-}`, `{--}` or `{----}` does not close itself (the opener absorbs all its
 *   dashes and the automaton then reads `}` as text): the rest of the file is a comment.
 *
 * Deviations, all of which only matter for input the compiler rejects or never sees:
 * - errors do not stop the scan: an unclosed group or string simply stays open, a `"` string ends
 *   at the line break, a closing bracket that matches an enclosing group closes it (dropping the
 *   groups in between as unclosed), and any other stray closing bracket is an `unrecognised` token;
 * - line comments stop before `\r` as well as `\n`, so a CRLF line's comment excludes the CR;
 * - an unterminated string literal inside a block comment makes the compiler reject the whole
 *   comment (it then lexes `{` as a bracket); here the comment runs to the end of the text.
 *
 * **Line by line.** `lexText` reads a text from what is open at its start (`LexerState`) and
 * returns what is open at its end. With `end: 'text'` the text ends there (`lex`); with
 * `end: 'line'` a line break follows it, and the state carries over the break what the compiler's
 * lexer carries over one: a block comment (its depth, a string literal open in it), a `"""` string, a
 * `"` string whose escape `\` (with its `#`s) ends the line (the escape takes the break as its
 * character: `escape … any`), the code of an interpolation, the brackets open in code, and a
 * character literal whose `'` or `'\` ends the line (`'`⏎`'` and `'\`⏎`'` are character literals:
 * `charLit` takes any character but `'` after `'`, any after `'\`). A `"` string otherwise open at
 * the break cannot go on (`charLexer` refuses a newline): it is left unclosed, as `lex` leaves it, and
 * the state is `unsure` from there on (the compiler rejects the file). Read so, line by line, a text
 * that ends with a line break is read as `end: 'text'` reads it at once (compared over the fixtures
 * and generated text by `test/unit/idrisSyntaxLines.test.ts`, over the corpora by
 * `test/grammar/corpus.test.ts`), but for three cases: line breaks are `\n` (a `\r` before one is
 * not seen, so `"a\` before a CRLF break goes on); a `%cg` directive is read within its line (its
 * `{…}` and the spaces before it can span lines; nothing in the corpora uses one); and a character
 * literal cut by a break is taken for one (a `char` token to the line's end) before the next line
 * decides, which in code reads `'` and `\` otherwise when that line does not start with `'`. A last
 * line without a line break is read as if one followed it.
 *
 * Offsets are UTF-16 code units, as in VS Code; every character above U+00A0 is an identifier
 * character for the compiler, so surrogate pairs need no special handling.
 */
import { isIdrisSpace } from '../project/literate';

// -------------------------------------------------------------------------------------------
// Tables
// -------------------------------------------------------------------------------------------

/**
 * The lexer's keywords (`keywords` and `fixityKeywords`, `src/Parser/Lexer/Source.idr` 186–198
 * [src]), in its order: it reads these as keywords, never as names. The one table of them (M3's
 * completion and the edits read it through `core/idrisSyntax.ts`).
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'data', 'module', 'where', 'let', 'in', 'do', 'record', 'auto', 'default', 'implicit', 'failing', 'mutual', 'namespace',
  'parameters', 'with', 'proof', 'impossible', 'case', 'of', 'if', 'then', 'else', 'forall', 'rewrite', 'typebind', 'autobind',
  'using', 'interface', 'implementation', 'open', 'import', 'public', 'export', 'private', 'infixl', 'infixr', 'infix', 'prefix',
  'total', 'partial', 'covering',
]);

/** Whether `word` is one of the lexer's keywords (`KEYWORDS`). */
export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word);
}

/** `isOpChar` (`src/Core/Name.idr` 87–88 [src]): the characters of an operator. */
export const OPERATOR_CHARACTERS = ':!#$%&*+./<=>?@\\^|-~';

/**
 * `groupSymbols` with `groupClose` (`src/Parser/Lexer/Source.idr` 219–236 [src]), in the lexer's
 * order (the first that matches wins; it tries them before names and operators, so `.(` opens a
 * group — a dot pattern, `Foo.Bar.(+)` — and is never the operator `.`).
 */
export const GROUP_SYMBOLS: readonly (readonly [string, string])[] = [
  ['.(', ')'], ['.[|', '|]'], ['@{', '}'], ['[|', '|]'], ['(', ')'], ['{', '}'],
  ['[<', ']'], ['[>', ']'], ['[', ']'], ['`(', ')'], ['`{', '}'], ['`[', ']'],
];

const DEBUG_INFO: readonly string[] = ['__LOC__', '__FILE__', '__LINE__', '__COL__'];

/** `symbols` in Source.idr. */
const SINGLE_SYMBOLS = ',;_`';

/** Control-character names accepted after `\` in a character literal (`charLit`). */
const CHAR_ESCAPE =
  /(?:NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC1|DC2|DC3|DC4|NAK|SYN|ETB|CAN|EM|SUB|ESC|FS|GS|RS|US|SP|DEL|x[0-9A-Fa-f]+|o[0-7]+|[0-9]+|[\s\S])/uy;

const NUMBER_RULES: readonly RegExp[] = [
  /[0-9]+\.[0-9]+(?:e[-+]?[0-9]+)?/y, // doubleLit
  /0b[01]+(?:_[01]+)*/y, // binUnderscoredLit
  /0[xX][0-9A-Fa-f]+(?:_[0-9A-Fa-f]+)*/y, // hexUnderscoredLit (`approx "0x"`)
  /0o[0-7]+(?:_[0-7]+)*/y, // octUnderscoredLit
  /[0-9]+(?:_[0-9]+)*/y, // digitsUnderscoredLit
];

// -------------------------------------------------------------------------------------------
// Characters and lexemes
// -------------------------------------------------------------------------------------------

/** `isSpace` in the prelude. */
const isSpace = isIdrisSpace;

function isNewline(c: string): boolean {
  return c === '\n' || c === '\r';
}

function isAsciiUpper(c: string): boolean {
  return c >= 'A' && c <= 'Z';
}

function isAsciiAlpha(c: string): boolean {
  return isAsciiUpper(c) || (c >= 'a' && c <= 'z');
}

function isAsciiDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isAbove160(c: string): boolean {
  return c.charCodeAt(0) > 160;
}

/** `isIdentStart Normal` (`src/Parser/Lexer/Common.idr` 73–76 [src]) of the character (or UTF-16 unit) `c`. */
export function isIdentStart(c: string): boolean {
  return c === '_' || isAsciiAlpha(c) || isAbove160(c);
}

/** `isIdentStart Capitalised`. */
function isCapitalisedStart(c: string): boolean {
  return c === '_' || isAsciiUpper(c) || isAbove160(c);
}

/** `isIdentTrailing Normal` (`src/Parser/Lexer/Common.idr` 78–82 [src]) of the character (or UTF-16 unit) `c`. */
export function isIdentTrailing(c: string): boolean {
  return c === "'" || c === '_' || isAsciiAlpha(c) || isAsciiDigit(c) || isAbove160(c);
}

function isOpChar(c: string): boolean {
  return c !== '' && OPERATOR_CHARACTERS.includes(c);
}

/** End of `ident flavour` at `i` (`identNormal` by default), or `i` when there is none. */
export function identEnd(text: string, i: number, start: (c: string) => boolean = isIdentStart): number {
  if (i >= text.length || !start(text.charAt(i))) {
    return i;
  }
  let j = i + 1;
  while (j < text.length && isIdentTrailing(text.charAt(j))) {
    j++;
  }
  return j;
}

/**
 * End of `namespacedIdent` at `i`:
 * `ident Capitalised <+> many (is '.' <+> ident Capitalised <+> expect (is '.'))
 *  <+> opt (is '.' <+> identNormal)`.
 */
function namespacedIdentEnd(text: string, i: number): number {
  let j = identEnd(text, i, isCapitalisedStart);
  if (j === i) {
    return i;
  }
  for (;;) {
    if (text.charAt(j) !== '.') {
      break;
    }
    const k = identEnd(text, j + 1, isCapitalisedStart);
    if (k === j + 1 || text.charAt(k) !== '.') {
      break;
    }
    j = k;
  }
  if (text.charAt(j) === '.') {
    const k = identEnd(text, j + 1, isIdentStart);
    if (k > j + 1) {
      j = k;
    }
  }
  return j;
}

function lineEnd(text: string, i: number): number {
  let j = i;
  while (j < text.length && !isNewline(text.charAt(j))) {
    j++;
  }
  return j;
}

function stickyMatch(re: RegExp, text: string, i: number): number {
  re.lastIndex = i;
  const m = re.exec(text);
  return m === null ? i : i + m[0].length;
}

/**
 * Whether a line comment (`comment`, Common.idr 10–15: `--`, more dashes, not followed by `}`)
 * starts at `i`; it runs to the end of the line.
 */
export function isLineCommentAt(text: string, i: number): boolean {
  if (!text.startsWith('--', i)) {
    return false;
  }
  let j = i + 2;
  while (text.charAt(j) === '-') {
    j++;
  }
  return text.charAt(j) !== '}';
}

/** `charLit`: `'` (`\` (control | any) | not `'`) `'`; returns `i` when it does not match. */
function charLitEnd(text: string, i: number): number {
  if (text.charAt(i) !== "'") {
    return i;
  }
  let j = i + 1;
  if (j >= text.length) {
    return i;
  }
  if (text.charAt(j) === '\\') {
    const k = stickyMatch(CHAR_ESCAPE, text, j + 1);
    if (k === j + 1) {
      return i;
    }
    j = k;
  } else if (text.charAt(j) === "'") {
    return i;
  } else {
    // One character, which may be a surrogate pair.
    j += (text.codePointAt(j) as number) > 0xffff ? 2 : 1;
  }
  return text.charAt(j) === "'" ? j + 1 : i;
}

/**
 * Whether the `'` at `i` starts a character literal that the end of `text` cuts, when a line break
 * follows it: `'` or `'\` ends the text (the break is then the literal's character, and the next
 * line's first character decides).
 */
function cutCharLit(text: string, i: number): boolean {
  return i + 1 === text.length || (i + 2 === text.length && text.charAt(i + 1) === '\\');
}

/**
 * End of `cgDirective` at `i` (which starts with `%cg`): `%cg` then either
 * `some space, some alnum, many space, '{', many (not '}'), '}'` or the rest of the line.
 */
function cgDirectiveEnd(text: string, i: number): number {
  let j = i + 3;
  const firstAlt = ((): number | undefined => {
    let k = j;
    if (!isSpace(text.charAt(k))) {
      return undefined;
    }
    while (isSpace(text.charAt(k))) {
      k++;
    }
    const alnumStart = k;
    while (isAsciiAlpha(text.charAt(k)) || isAsciiDigit(text.charAt(k))) {
      k++;
    }
    if (k === alnumStart) {
      return undefined;
    }
    while (isSpace(text.charAt(k))) {
      k++;
    }
    if (text.charAt(k) !== '{') {
      return undefined;
    }
    const close = text.indexOf('}', k + 1);
    return close < 0 ? undefined : close + 1;
  })();
  if (firstAlt !== undefined) {
    return firstAlt;
  }
  while (j < text.length && text.charAt(j) !== '\n') {
    j++;
  }
  return j;
}

/**
 * `multilineBegin`: `#*"""`, then non-newline spaces, then a newline (`lineBreak`: the end of `text`
 * counts as one); `i` when no match.
 */
function multilineBeginEnd(text: string, i: number, lineBreak: boolean): number {
  let j = i;
  while (text.charAt(j) === '#') {
    j++;
  }
  if (!text.startsWith('"""', j)) {
    return i;
  }
  j += 3;
  while (j < text.length && isSpace(text.charAt(j)) && !isNewline(text.charAt(j))) {
    j++;
  }
  if (text.startsWith('\r\n', j)) {
    return j + 2;
  }
  return isNewline(text.charAt(j)) ? j + 1 : lineBreak && j === text.length ? j : i;
}

/** What is open in a block comment: its nesting depth, a string literal in it, a character literal a line break cut. */
interface CommentOpen {
  readonly depth: number;
  readonly quoted: boolean;
  readonly char: boolean;
}

/**
 * Reads a block comment from `j`, with `open` open, as `blockComment` and the `toEndComment`
 * automaton of Common.idr do (nesting depth, line comments, character and string literals), until it
 * closes (`open` is then `undefined`) or the text ends (`lineBreak`: a line break follows, and what is
 * open there is returned). An unterminated comment runs to the end of the text, as `eof` is accepted
 * there.
 */
function commentRun(text: string, from: number, open: CommentOpen, lineBreak: boolean): { readonly end: number; readonly open: CommentOpen | undefined } {
  let j = from;
  let depth = open.depth;
  let quoted = open.quoted;
  if (open.char && text.charAt(j) === "'") {
    j++;
  }
  // `true` right after an opener's dashes: `singleBrace` continues in `singleDash (S k)`, so a
  // directly following `}` closes that nested comment at once.
  let afterNestedOpen = false;
  while (j < text.length) {
    const c = text.charAt(j);
    if (quoted) {
      // `stringLit`: `"` (`\` any | any)*? `"`.
      if (c === '\\') {
        j += 2;
      } else {
        quoted = c !== '"';
        j++;
      }
      continue;
    }
    if (afterNestedOpen) {
      afterNestedOpen = false;
      if (c === '}') {
        depth--;
        j++;
        if (depth === 0) {
          return { end: j, open: undefined };
        }
        continue;
      }
    }
    if (c === '{' && text.charAt(j + 1) === '-') {
      depth++;
      j += 2;
      while (text.charAt(j) === '-') {
        j++;
      }
      afterNestedOpen = true;
    } else if (c === '-' && text.charAt(j + 1) === '}') {
      depth--;
      j += 2;
      if (depth === 0) {
        return { end: j, open: undefined };
      }
    } else if (c === '-' && text.charAt(j + 1) === '-') {
      j += 2;
      while (text.charAt(j) === '-') {
        j++;
      }
      if (text.charAt(j) === '}') {
        depth--;
        j++;
        if (depth === 0) {
          return { end: j, open: undefined };
        }
      } else {
        while (j < text.length && text.charAt(j) !== '\n') {
          j++;
        }
      }
    } else if (c === "'") {
      if (lineBreak && cutCharLit(text, j)) {
        return { end: text.length, open: { depth, quoted: false, char: true } };
      }
      const k = charLitEnd(text, j);
      j = k > j ? k : j + 1;
    } else if (c === '"') {
      quoted = true;
      j++;
    } else {
      j++;
    }
  }
  return { end: text.length, open: { depth, quoted, char: false } };
}

// -------------------------------------------------------------------------------------------
// What is open, and the lexer
// -------------------------------------------------------------------------------------------

export type TokenKind =
  | 'comment'
  | 'docComment'
  | 'cgDirective'
  | 'hole'
  | 'ident'
  | 'keyword'
  | 'pragma'
  | 'symbol'
  | 'number'
  | 'char'
  | 'groupOpen'
  | 'groupClose'
  | 'stringOpen'
  | 'stringText'
  | 'stringClose'
  | 'interpOpen'
  | 'interpClose'
  | 'unrecognised';

export type GroupKind = 'bracket' | 'string' | 'interpolation';

/** A group open in code: a bracket group or the code of a string's interpolation, with its closing delimiter. */
interface CodeFrame {
  readonly type: 'code';
  readonly kind: 'bracket' | 'interpolation';
  readonly closer: string;
}

/** A string literal: `"""` or `"`, with the `#`s of a raw one. */
interface StringFrame {
  readonly type: 'string';
  readonly hashes: number;
  readonly multiline: boolean;
}

type Frame = CodeFrame | StringFrame;

/** The groups open, innermost first; shared, never changed. */
interface Frames {
  readonly frame: Frame;
  readonly below: Frames | undefined;
  /** The code frames among this one and those below. */
  readonly code: number;
  /** The string frames among this one and those below. */
  readonly strings: number;
}

/**
 * What is open at a point of a text: the groups (brackets, strings, interpolations), and a lexeme a
 * line break cut (a block comment, or a character literal). Shared by the texts read from it, never
 * changed: reading a line costs its own length, whatever is open.
 */
export interface LexerState {
  readonly frames: Frames | undefined;
  readonly cut: { readonly type: 'comment'; readonly open: CommentOpen } | { readonly type: 'char' } | undefined;
  /** A `"` string was left open at a line break (or before): the compiler rejects the text, and what follows may be misread. */
  readonly unsure: boolean;
}

/** Nothing open. */
export const START: LexerState = { frames: undefined, cut: undefined, unsure: false };

/** Whether a line that starts with `state` starts inside a block comment, a string literal's text or code, or a character literal. */
export function startsInside(state: LexerState): boolean {
  return state.cut !== undefined || (state.frames?.strings ?? 0) > 0;
}

/** Whether a line that starts with `state` starts in the text of a string literal (not in a comment or an interpolation's code). */
export function startsInStringText(state: LexerState): boolean {
  return state.cut === undefined && state.frames?.frame.type === 'string';
}

/** The number of bracket groups and interpolations open in `state`. */
export function codeDepth(state: LexerState): number {
  return state.frames?.code ?? 0;
}

/**
 * What `lexText` reports, in source order. `depth` is the number of bracket groups and
 * interpolations open around the token (for a group's delimiters, around the group).
 */
export interface LexemeSink {
  /** A token, or the part of one on this text when a line break cuts it (a block comment, a string's text, a character literal). */
  token(kind: TokenKind, start: number, end: number, depth: number): void;
  /** A group opens with the token `start`–`end`. */
  open(kind: GroupKind, start: number, end: number, depth: number): void;
  /** The innermost open group closes with the token `start`–`end`. */
  close(kind: GroupKind, start: number, end: number, depth: number): void;
  /** The innermost open group is left unclosed (a stray closing bracket closed one around it, or a line break ended a `"` string). */
  drop(kind: GroupKind): void;
}

const OPEN_KINDS: Readonly<Record<GroupKind, TokenKind>> = { bracket: 'groupOpen', string: 'stringOpen', interpolation: 'interpOpen' };
const CLOSE_KINDS: Readonly<Record<GroupKind, TokenKind>> = { bracket: 'groupClose', string: 'stringClose', interpolation: 'interpClose' };

/** The token kind that opens (`OPEN_KINDS`) or closes (`CLOSE_KINDS`) a group of a kind. */
export const delimiterKind = (kind: GroupKind, opens: boolean): TokenKind => (opens ? OPEN_KINDS : CLOSE_KINDS)[kind];

const groupKindOf = (frame: Frame): GroupKind => (frame.type === 'string' ? 'string' : frame.kind);

/**
 * Tokenises `text` (Idris 2 source, already unlit for literate files) from `state`, reporting to
 * `sink`, and returns what is open at its end: `end: 'text'` reads a whole text, `end: 'line'` a line
 * that a line break follows (module comment).
 */
export function lexText(text: string, state: LexerState, end: 'text' | 'line', sink: LexemeSink): LexerState {
  const lineBreak = end === 'line';
  let frames = state.frames;
  let cut: LexerState['cut'] = undefined;
  let unsure = state.unsure;
  // A `"` string's escape took the line break after the text as its character.
  let escapedBreak = false;

  const depth = (): number => frames?.code ?? 0;
  const push = (frame: Frame, start: number, endAt: number): void => {
    sink.open(groupKindOf(frame), start, endAt, depth());
    frames = {
      frame,
      below: frames,
      code: depth() + (frame.type === 'code' ? 1 : 0),
      strings: (frames?.strings ?? 0) + (frame.type === 'string' ? 1 : 0),
    };
  };
  const pop = (): Frame => {
    const top = frames as Frames;
    frames = top.below;
    return top.frame;
  };
  /** Pops the innermost frame and closes its group with the token `start`–`endAt`. */
  const closeTop = (start: number, endAt: number): void => {
    const frame = pop();
    sink.close(groupKindOf(frame), start, endAt, depth());
  };
  const emit = (kind: TokenKind, start: number, endAt: number): void => {
    sink.token(kind, start, endAt, depth());
  };

  let i = 0;
  if (state.cut?.type === 'comment') {
    i = blockComment(0, 0, state.cut.open);
  } else if (state.cut?.type === 'char' && text.charAt(0) === "'") {
    emit('char', 0, 1);
    i = 1;
  }
  while (i < text.length && cut === undefined) {
    const frame = frames?.frame;
    if (frame?.type === 'string') {
      i = lexStringPart(frame, i);
      continue;
    }
    // The enclosing group's closing delimiter is tried before any rule.
    if (frame !== undefined && text.startsWith(frame.closer, i)) {
      closeTop(i, i + frame.closer.length);
      i += frame.closer.length;
      continue;
    }
    const c = text.charAt(i);
    if ((c === ')' || c === ']' || c === '}') && recoverClose(c, i)) {
      i++;
      continue;
    }
    i = lexCodeToken(i);
  }
  const top = frames?.frame;
  if (lineBreak && cut === undefined && top?.type === 'string' && !top.multiline && !escapedBreak) {
    // `charLexer` refuses the line break: the string cannot go on, and the compiler rejects the text.
    pop();
    sink.drop('string');
    unsure = true;
  }
  return { frames, cut, unsure };

  /**
   * A block comment whose token starts at `start`, read from `j` with `open` open; returns where it
   * ends (the text's end when it does not close there, and what is open then is `cut`).
   */
  function blockComment(start: number, j: number, open: CommentOpen): number {
    const read = commentRun(text, j, open, lineBreak);
    if (read.end > start) {
      emit('comment', start, read.end);
    }
    if (read.open !== undefined) {
      cut = { type: 'comment', open: read.open };
    }
    return read.end;
  }

  /**
   * A closing bracket that does not close the innermost group: if it closes an enclosing
   * bracket group (without leaving a string), close that one and leave the groups in between
   * unclosed. Returns false when nothing matches.
   */
  function recoverClose(c: string, at: number): boolean {
    let above = 0;
    for (let f = frames; f !== undefined; f = f.below) {
      if (f.frame.type === 'string') {
        return false;
      }
      if (f.frame.closer === c) {
        for (; above > 0; above--) {
          sink.drop(groupKindOf(pop()));
        }
        closeTop(at, at + 1);
        return true;
      }
      above++;
    }
    return false;
  }

  function lexCodeToken(at: number): number {
    const c = text.charAt(at);
    const next = text.charAt(at + 1);

    // comment: `--`, more dashes, not followed by `}`; to the end of the line.
    if (c === '-' && next === '-' && isLineCommentAt(text, at)) {
      const endAt = lineEnd(text, at);
      emit('comment', at, endAt);
      return endAt;
    }
    // blockComment
    if (c === '{' && next === '-') {
      let j = at + 2;
      while (text.charAt(j) === '-') {
        j++;
      }
      return blockComment(at, j, { depth: 1, quoted: false, char: false });
    }
    // docComment
    if (text.startsWith('|||', at)) {
      const endAt = lineEnd(text, at);
      emit('docComment', at, endAt);
      return endAt;
    }
    // cgDirective
    if (text.startsWith('%cg', at)) {
      const endAt = cgDirectiveEnd(text, at);
      emit('cgDirective', at, endAt);
      return endAt;
    }
    // holeIdent
    if (c === '?') {
      const endAt = identEnd(text, at + 1);
      if (endAt > at + 1) {
        emit('hole', at, endAt);
        return endAt;
      }
    }
    // groupSymbols
    for (const [open, closer] of GROUP_SYMBOLS) {
      if (text.startsWith(open, at)) {
        push({ type: 'code', kind: 'bracket', closer }, at, at + open.length);
        return at + open.length;
      }
    }
    // debugInfo
    for (const name of DEBUG_INFO) {
      if (text.startsWith(name, at)) {
        emit('ident', at, at + name.length);
        return at + name.length;
      }
    }
    // symbols
    if (SINGLE_SYMBOLS.includes(c)) {
      emit('symbol', at, at + 1);
      return at + 1;
    }
    // doubleLit, binary, hexadecimal, octal, decimal literals
    for (const rule of NUMBER_RULES) {
      const endAt = stickyMatch(rule, text, at);
      if (endAt > at) {
        emit('number', at, endAt);
        return endAt;
      }
    }
    // multilineBegin, then stringBegin
    let h = at;
    while (text.charAt(h) === '#') {
      h++;
    }
    const multiEnd = multilineBeginEnd(text, at, lineBreak);
    if (multiEnd > at) {
      push({ type: 'string', hashes: h - at, multiline: true }, at, multiEnd);
      return multiEnd;
    }
    if (text.charAt(h) === '"') {
      push({ type: 'string', hashes: h - at, multiline: false }, at, h + 1);
      return h + 1;
    }
    // charLit
    if (c === "'" && lineBreak && cutCharLit(text, at)) {
      emit('char', at, text.length);
      cut = { type: 'char' };
      return text.length;
    }
    const charEnd = charLitEnd(text, at);
    if (charEnd > at) {
      emit('char', at, charEnd);
      return charEnd;
    }
    // dotIdent
    if (c === '.') {
      const endAt = identEnd(text, at + 1);
      if (endAt > at + 1) {
        emit('ident', at, endAt);
        return endAt;
      }
    }
    // namespacedIdent, then identNormal (keywords are identifiers in the keyword list)
    let endAt = namespacedIdentEnd(text, at);
    if (endAt === at) {
      endAt = identEnd(text, at);
    }
    if (endAt > at) {
      emit(KEYWORDS.has(text.slice(at, endAt)) ? 'keyword' : 'ident', at, endAt);
      return endAt;
    }
    // pragma
    if (c === '%') {
      const pragmaEnd = identEnd(text, at + 1);
      if (pragmaEnd > at + 1) {
        emit('pragma', at, pragmaEnd);
        return pragmaEnd;
      }
    }
    // space
    if (isSpace(c)) {
      return at + 1;
    }
    // validSymbol
    if (isOpChar(c)) {
      let j = at + 1;
      while (isOpChar(text.charAt(j))) {
        j++;
      }
      emit('symbol', at, j);
      return j;
    }
    // symbol (Unrecognised)
    emit('unrecognised', at, at + 1);
    return at + 1;
  }

  /** One step inside a string literal (`stringTokens` in Source.idr). */
  function lexStringPart(frame: StringFrame, at: number): number {
    const hashes = '#'.repeat(frame.hashes);
    const close = frame.multiline ? `"""${hashes}` : `"${hashes}`;
    const escape = `\\${hashes}`;
    const interp = `${escape}{`;

    if (text.startsWith(close, at) && (frame.multiline || text.charAt(at + close.length) !== '"')) {
      closeTop(at, at + close.length);
      return at + close.length;
    }
    if (text.startsWith(interp, at)) {
      push({ type: 'code', kind: 'interpolation', closer: '}' }, at, at + interp.length);
      return at + interp.length;
    }
    let j = at;
    while (j < text.length && !text.startsWith(interp, j)) {
      if (text.startsWith(escape, j) && j + escape.length < text.length) {
        j += escape.length + 1;
      } else if (lineBreak && text.startsWith(escape, j) && j + escape.length === text.length) {
        // The escape's character is the line break after the text.
        j = text.length;
        escapedBreak = true;
      } else if (text.startsWith(close, j) || (!frame.multiline && isNewline(text.charAt(j)))) {
        break;
      } else {
        j++;
      }
    }
    if (j > at) {
      emit('stringText', at, j);
      return j;
    }
    // Only a single-line string gets here: at a quote the end rule rejects (`""` followed by
    // `"`), which is closed anyway, or at a line break, where the string stays unclosed.
    if (text.startsWith(close, at)) {
      closeTop(at, at + close.length);
      return at + close.length;
    }
    pop();
    sink.drop('string');
    return at;
  }
}
