/**
 * A tolerant port of the Idris 2 source lexer, for syntactic features that must know where
 * tokens, comments, strings and bracket groups are (M0: selection ranges).
 *
 * Every rule and its order come from the compiler — `rawTokens` and `stringTokens` in
 * `src/Parser/Lexer/Source.idr`, `comment`/`blockComment`/identifier rules in
 * `src/Parser/Lexer/Common.idr`, `charLit`/`stringLit`/`newline` and the numeric lexers in
 * `src/Libraries/Text/Lexer.idr`, `isOpChar` in `src/Core/Name.idr`, character classes in
 * `libs/prelude/Prelude/Types.idr` — identical between master 1c630e6 and v0.8.0 apart from
 * imports. As in the compiler's `Tokenizer`, the first rule that matches wins (not the longest),
 * and inside a group or string interpolation the group's closing delimiter is tried before any
 * rule. Behaviour that surprises and was confirmed with `idris2 --check` (0.8.0):
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
 * - errors do not stop the scan: an unclosed group or string simply stays open (its `close` is
 *   `undefined`), a single-line string ends at the line break, a closing bracket that matches an
 *   enclosing group closes it (dropping the groups in between as unclosed), and any other stray
 *   closing bracket becomes an `unrecognised` token;
 * - line comments stop before `\r` as well as `\n`, so a CRLF line's comment excludes the CR;
 * - an unterminated string literal inside a block comment makes the compiler reject the whole
 *   comment (it then lexes `{` as a bracket); here the comment runs to the end of the text.
 *
 * Offsets are UTF-16 code units, as in VS Code; every character above U+00A0 is an identifier
 * character for the compiler, so surrogate pairs need no special handling.
 */

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

export interface Group {
  readonly kind: GroupKind;
  readonly open: Token;
  /** `undefined` while (or if never) closed. */
  close: Token | undefined;
  /** The group this one is nested in, if any. */
  readonly parent: Group | undefined;
}

export interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /**
   * The group the token sits in, not counting a group it delimits: for an opening or closing
   * delimiter this is the delimited group's parent.
   */
  readonly outer: Group | undefined;
  /** For delimiter tokens: the group they open or close. */
  readonly delimits: Group | undefined;
}

export interface LexResult {
  /** In source order; whitespace produces no tokens. */
  readonly tokens: readonly Token[];
  /** In order of their opening delimiters. */
  readonly groups: readonly Group[];
}

/**
 * `keywords` and `fixityKeywords` in `src/Parser/Lexer/Source.idr`, in its order (M3's completion
 * offers them, `features/intelligence/completion.ts`).
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'data', 'module', 'where', 'let', 'in', 'do', 'record', 'auto', 'default', 'implicit',
  'failing', 'mutual', 'namespace', 'parameters', 'with', 'proof', 'impossible', 'case', 'of',
  'if', 'then', 'else', 'forall', 'rewrite', 'typebind', 'autobind', 'using', 'interface',
  'implementation', 'open', 'import', 'public', 'export', 'private',
  'infixl', 'infixr', 'infix', 'prefix',
  'total', 'partial', 'covering',
]);

/** `groupSymbols` with `groupClose`, in the compiler's order (first match wins). */
const GROUP_SYMBOLS: readonly (readonly [string, string])[] = [
  ['.(', ')'], ['.[|', '|]'], ['@{', '}'], ['[|', '|]'], ['(', ')'], ['{', '}'],
  ['[<', ']'], ['[>', ']'], ['[', ']'], ['`(', ')'], ['`{', '}'], ['`[', ']'],
];

const DEBUG_INFO: readonly string[] = ['__LOC__', '__FILE__', '__LINE__', '__COL__'];

/** `symbols` in Source.idr. */
const SINGLE_SYMBOLS = ',;_`';

/** `isOpChar` in `src/Core/Name.idr`. */
const OP_CHARS = ':!#$%&*+./<=>?@\\^|-~';

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

/** `isSpace` in the prelude. */
function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v' || c === '\u00a0';
}

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

/** `isIdentStart Normal`. */
function isIdentStart(c: string): boolean {
  return c === '_' || isAsciiAlpha(c) || isAbove160(c);
}

/** `isIdentStart Capitalised`. */
function isCapitalisedStart(c: string): boolean {
  return c === '_' || isAsciiUpper(c) || isAbove160(c);
}

/** `isIdentTrailing Normal`. */
function isIdentTrailing(c: string): boolean {
  return c === "'" || c === '_' || isAsciiAlpha(c) || isAsciiDigit(c) || isAbove160(c);
}

function isOpChar(c: string): boolean {
  return c !== '' && OP_CHARS.includes(c);
}

/** End of `ident flavour` at `i`, or `i` when there is none. */
function identEnd(text: string, i: number, start: (c: string) => boolean): number {
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

/** `stringLit` as used inside block comments: `"` (`\` any | any)*? `"`. */
function plainStringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text.charAt(j);
    if (c === '\\') {
      j += 2;
    } else if (c === '"') {
      return j + 1;
    } else {
      j++;
    }
  }
  return i;
}

/**
 * End of a block comment whose `{-` starts at `i`: `blockComment` and the `toEndComment`
 * automaton of Common.idr (nesting depth, line comments, character and string literals).
 * An unterminated comment runs to the end of the text, as `eof` is accepted there.
 */
function blockCommentEnd(text: string, i: number): number {
  let j = i + 2;
  while (text.charAt(j) === '-') {
    j++;
  }
  let depth = 1;
  // `true` right after an opener's dashes: `singleBrace` continues in `singleDash (S k)`, so a
  // directly following `}` closes that nested comment at once.
  let afterNestedOpen = false;
  while (j < text.length) {
    const c = text.charAt(j);
    if (afterNestedOpen) {
      afterNestedOpen = false;
      if (c === '}') {
        depth--;
        j++;
        if (depth === 0) {
          return j;
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
        return j;
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
          return j;
        }
      } else {
        while (j < text.length && text.charAt(j) !== '\n') {
          j++;
        }
      }
    } else if (c === "'") {
      const k = charLitEnd(text, j);
      j = k > j ? k : j + 1;
    } else if (c === '"') {
      const k = plainStringEnd(text, j);
      j = k > j ? k : text.length;
    } else {
      j++;
    }
  }
  return text.length;
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

/** `multilineBegin`: `#*"""`, then non-newline spaces, then a newline; `i` when no match. */
function multilineBeginEnd(text: string, i: number): number {
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
  return isNewline(text.charAt(j)) ? j + 1 : i;
}

interface CodeFrame {
  readonly type: 'code';
  /** `undefined` for the top level. */
  readonly closer: string | undefined;
  readonly group: Group | undefined;
}

interface StringFrame {
  readonly type: 'string';
  readonly hashes: number;
  readonly multiline: boolean;
  readonly group: Group;
}

type Frame = CodeFrame | StringFrame;

type MutableToken = { -readonly [K in keyof Token]: Token[K] };

/** Tokenises Idris 2 source text (already unlit, for literate files). */
export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  const groups: Group[] = [];
  const stack: Frame[] = [{ type: 'code', closer: undefined, group: undefined }];

  const makeToken = (kind: TokenKind, start: number, end: number, outer: Group | undefined): MutableToken => ({
    kind,
    start,
    end,
    text: text.slice(start, end),
    outer,
    delimits: undefined,
  });

  const emit = (kind: TokenKind, start: number, end: number): void => {
    tokens.push(makeToken(kind, start, end, stack[stack.length - 1].group));
  };

  const openGroup = (kind: GroupKind, tokenKind: TokenKind, start: number, end: number): Group => {
    const parent = stack[stack.length - 1].group;
    const open = makeToken(tokenKind, start, end, parent);
    const group: Group = { kind, open, close: undefined, parent };
    open.delimits = group;
    tokens.push(open);
    groups.push(group);
    return group;
  };

  /** Pops the innermost frame and closes its group with the token `start`–`end`. */
  const closeTop = (start: number, end: number): void => {
    const group = (stack.pop() as Frame).group as Group;
    const kind: TokenKind = group.kind === 'string' ? 'stringClose' : group.kind === 'interpolation' ? 'interpClose' : 'groupClose';
    const close = makeToken(kind, start, end, group.parent);
    close.delimits = group;
    group.close = close;
    tokens.push(close);
  };

  let i = 0;
  while (i < text.length) {
    const frame = stack[stack.length - 1];
    if (frame.type === 'string') {
      i = lexStringPart(frame, i);
      continue;
    }
    // The enclosing group's closing delimiter is tried before any rule.
    if (frame.closer !== undefined && text.startsWith(frame.closer, i)) {
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
  return { tokens, groups };

  /**
   * A closing bracket that does not close the innermost group: if it closes an enclosing
   * bracket group (without leaving a string), close that one and leave the groups in between
   * unclosed. Returns false when nothing matches.
   */
  function recoverClose(c: string, i: number): boolean {
    for (let k = stack.length - 1; k > 0; k--) {
      const f = stack[k];
      if (f.type === 'string') {
        return false;
      }
      if (f.closer === c) {
        stack.length = k + 1;
        closeTop(i, i + 1);
        return true;
      }
    }
    return false;
  }

  function lexCodeToken(i: number): number {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);

    // comment: `--`, more dashes, not followed by `}`; to the end of the line.
    if (c === '-' && next === '-') {
      let j = i + 2;
      while (text.charAt(j) === '-') {
        j++;
      }
      if (text.charAt(j) !== '}') {
        const end = lineEnd(text, j);
        emit('comment', i, end);
        return end;
      }
    }
    // blockComment
    if (c === '{' && next === '-') {
      const end = blockCommentEnd(text, i);
      emit('comment', i, end);
      return end;
    }
    // docComment
    if (text.startsWith('|||', i)) {
      const end = lineEnd(text, i);
      emit('docComment', i, end);
      return end;
    }
    // cgDirective
    if (text.startsWith('%cg', i)) {
      const end = cgDirectiveEnd(text, i);
      emit('cgDirective', i, end);
      return end;
    }
    // holeIdent
    if (c === '?') {
      const end = identEnd(text, i + 1, isIdentStart);
      if (end > i + 1) {
        emit('hole', i, end);
        return end;
      }
    }
    // groupSymbols
    for (const [open, closer] of GROUP_SYMBOLS) {
      if (text.startsWith(open, i)) {
        const group = openGroup('bracket', 'groupOpen', i, i + open.length);
        stack.push({ type: 'code', closer, group });
        return i + open.length;
      }
    }
    // debugInfo
    for (const name of DEBUG_INFO) {
      if (text.startsWith(name, i)) {
        emit('ident', i, i + name.length);
        return i + name.length;
      }
    }
    // symbols
    if (SINGLE_SYMBOLS.includes(c)) {
      emit('symbol', i, i + 1);
      return i + 1;
    }
    // doubleLit, binary, hexadecimal, octal, decimal literals
    for (const rule of NUMBER_RULES) {
      const end = stickyMatch(rule, text, i);
      if (end > i) {
        emit('number', i, end);
        return end;
      }
    }
    // multilineBegin, then stringBegin
    let h = i;
    while (text.charAt(h) === '#') {
      h++;
    }
    const multiEnd = multilineBeginEnd(text, i);
    if (multiEnd > i) {
      const group = openGroup('string', 'stringOpen', i, multiEnd);
      stack.push({ type: 'string', hashes: h - i, multiline: true, group });
      return multiEnd;
    }
    if (text.charAt(h) === '"') {
      const group = openGroup('string', 'stringOpen', i, h + 1);
      stack.push({ type: 'string', hashes: h - i, multiline: false, group });
      return h + 1;
    }
    // charLit
    const charEnd = charLitEnd(text, i);
    if (charEnd > i) {
      emit('char', i, charEnd);
      return charEnd;
    }
    // dotIdent
    if (c === '.') {
      const end = identEnd(text, i + 1, isIdentStart);
      if (end > i + 1) {
        emit('ident', i, end);
        return end;
      }
    }
    // namespacedIdent, then identNormal (keywords are identifiers in the keyword list)
    let end = namespacedIdentEnd(text, i);
    if (end === i) {
      end = identEnd(text, i, isIdentStart);
    }
    if (end > i) {
      emit(KEYWORDS.has(text.slice(i, end)) ? 'keyword' : 'ident', i, end);
      return end;
    }
    // pragma
    if (c === '%') {
      const pragmaEnd = identEnd(text, i + 1, isIdentStart);
      if (pragmaEnd > i + 1) {
        emit('pragma', i, pragmaEnd);
        return pragmaEnd;
      }
    }
    // space
    if (isSpace(c)) {
      return i + 1;
    }
    // validSymbol
    if (isOpChar(c)) {
      let j = i + 1;
      while (isOpChar(text.charAt(j))) {
        j++;
      }
      emit('symbol', i, j);
      return j;
    }
    // symbol (Unrecognised)
    emit('unrecognised', i, i + 1);
    return i + 1;
  }

  /** One step inside a string literal (`stringTokens` in Source.idr). */
  function lexStringPart(frame: StringFrame, i: number): number {
    const hashes = '#'.repeat(frame.hashes);
    const end = frame.multiline ? `"""${hashes}` : `"${hashes}`;
    const escape = `\\${hashes}`;
    const interp = `${escape}{`;

    if (text.startsWith(end, i) && (frame.multiline || text.charAt(i + end.length) !== '"')) {
      closeTop(i, i + end.length);
      return i + end.length;
    }
    if (text.startsWith(interp, i)) {
      const group = openGroup('interpolation', 'interpOpen', i, i + interp.length);
      stack.push({ type: 'code', closer: '}', group });
      return i + interp.length;
    }
    let j = i;
    while (j < text.length && !text.startsWith(interp, j)) {
      if (text.startsWith(escape, j) && j + escape.length < text.length) {
        j += escape.length + 1;
      } else if (text.startsWith(end, j) || (!frame.multiline && isNewline(text.charAt(j)))) {
        break;
      } else {
        j++;
      }
    }
    if (j > i) {
      emit('stringText', i, j);
      return j;
    }
    // Only a single-line string gets here: at a quote the end rule rejects (`""` followed by
    // `"`), which is closed anyway, or at a line break, where the string stays unclosed.
    if (text.startsWith(end, i)) {
      closeTop(i, i + end.length);
      return i + end.length;
    }
    stack.pop();
    return i;
  }
}
