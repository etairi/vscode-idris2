/**
 * S-expressions of the IDE protocol (`backend/ide/sexp.ts`, docs/ARCHITECTURE.md §2; the `Sexp`
 * type is in `types.ts`): the compiler's reader, ported, and a writer whose output that reader
 * reads back as the value written.
 *
 * **Reading** (`parseSexp`) ports the reader the compiler applies to requests: `parseSExp`
 * (`src/Protocol/SExp/Parser.idr`) and `unescape 0` (`src/Parser/Support/Escaping.idr`) of
 * v0.8.0, identical on master 1c630e6 apart from imports [src]. `(`, `)` and `:` are tokens; an
 * integer is a run of ASCII digits (no sign); a string ends at the first `"` that is not the
 * second character of a `\` pair (the lexer reads `\` and the character after it as one unit)
 * and has the escapes of `unescape` (below); whitespace between tokens is `isSpace` (space,
 * `\t`, `\n`, `\v`, `\f`, `\r`, U+00A0); a name is `identAllowDashes`
 * (`src/Parser/Lexer/Common.idr`: `_`, an ASCII letter or a character above U+00A0, then also
 * digits, `-` and `'`). A value is `:True`, `:False`, an integer, a string, `:` followed by a
 * name, or `(` values `)`; anything else is an error. The port works on UTF-16 code units: the
 * compiler decides every character by an ASCII test or by "above U+00A0", which a surrogate unit
 * passes exactly when its code point does. The port is meant to accept the texts the compiler
 * accepts and to yield the same values. Checked [live, 2026-09-27, 0.8.0; the comparison script
 * is not kept in the repository] on 45 ASCII requests `((:bogus X) N)`: 29 strings covering each
 * escape form of `unescape` except those yielding NUL, 7 accepted grammar cases (`: True`,
 * `:True-x`, `0012`, `(:a"b"1(:c))`, `\t\f\v\r` between tokens, names with `'` `_` `-`, `()`) and
 * 9 texts to reject; the port read each exactly as the compiler did (the compiler's
 * `Unrecognised command: …` echo shows the value it read, except that its pretty-printer turns
 * CR into LF, so CR was compared as LF; `Parse error` shows a rejection). The rules for
 * characters above U+007F are [src] only. So one parser reads the compiler's replies (whose
 * strings `Show SExp` writes with only `\` and `"` escaped), the texts `serializeSexp` writes,
 * and the Idris `show` of a `String` that `:metavariables` nests inside its strings
 * (`showLitChar`, `libs/prelude/Prelude/Show.idr`, writes only escapes that `unescape` reads).
 *
 * **Writing** (`serializeSexp`) writes lists, `:True`/`:False`, decimal integers and `:name` as
 * `Show SExp` does. Strings differ: `Show SExp` escapes only `\` and `"`, whereas here every
 * character outside printable ASCII (U+0020–U+007E) is written as a decimal escape
 * `\<code point>`, followed by `\&` (`unescape`'s empty escape) when a digit comes next, so that
 * a serialized s-expression is printable ASCII. Reason: the compiler reads a request one byte
 * per character (ROADMAP F1 addendum), so raw UTF-8 reaches it as Latin-1, whereas the escapes
 * reach it as the intended characters [live, 2026-09-27, Homebrew idris2 0.8.0, macOS arm64,
 * one stdio session started in a directory named `dé`]:
 * - `((:type-of "α") 5)` → `Undefined name Î±`; `(:type-of "\945")` → `Main.α : Nat`;
 *   `(:type-of "\945\&1")` → `Main.α1 : Nat`; `(:type-of "\120159")` → `Undefined name 𝕟`
 *   (U+1D55F, outside the BMP); `(:interpret "\"\8594\"")` → `"\8594"` (U+2192 arrived);
 * - `:load-file` of the absolute path with a raw `é` → `Source file ".../d\195\169/Main.idr" is
 *   not in the source directory ".../d\233"`; the same path written `d\233` built the file
 *   (`1/1: Building Main (.../dé/Main.idr)`), so file names containing non-ASCII characters load
 *   only in the escaped form.
 * Two characters are not written as themselves: a lone surrogate (which a UTF-8 encoder would
 * also replace) is written as U+FFFD, because the compiler turns an escape that is not a code
 * point into NUL; and NUL is refused, because the compiler's `fPutStr` stops at a NUL that a
 * reply echoes while the reply's prefix counts past it, which desynchronises the stream
 * (`test/fake-idris2/README.md`, *Framing*).
 */
import type { Sexp, SexpInteger, SexpList, SexpString, SexpSymbol } from './types';

/** A text that is not one s-expression; `offset` is the UTF-16 offset where reading stopped. */
export class SexpSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'SexpSyntaxError';
  }
}

export function list(...items: Sexp[]): SexpList {
  return { kind: 'list', items };
}

export function str(value: string): SexpString {
  return { kind: 'string', value };
}

export function sym(name: string): SexpSymbol {
  return { kind: 'symbol', name };
}

/** `value` must be an integer (`BigInt` throws a `RangeError` otherwise). */
export function int(value: number | bigint): SexpInteger {
  return { kind: 'integer', value: BigInt(value) };
}

// -------------------------------------------------------------------------------------------
// Character classes (Prelude.Types and Parser.Lexer.Common of v0.8.0)
// -------------------------------------------------------------------------------------------

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN = 0x28;
const CLOSE = 0x29;
const COLON = 0x3a;

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** `isSpace`: space, `\t`, `\n`, `\v`, `\f`, `\r`, U+00A0. */
function isSpace(c: number): boolean {
  return c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0;
}

/** `isIdentStart AllowDashes`: `_`, an ASCII letter (`isAlpha`), or above U+00A0. */
function isIdentStart(c: number): boolean {
  return c === 0x5f || isAsciiAlpha(c) || c > 0xa0;
}

/** `isIdentTrailing AllowDashes`: `-`, `'`, `_`, an ASCII letter or digit, or above U+00A0. */
function isIdentTrailing(c: number): boolean {
  return c === 0x2d || c === 0x27 || c === 0x5f || isAsciiAlpha(c) || isDigit(c) || c > 0xa0;
}

function isName(name: string): boolean {
  if (name.length === 0 || !isIdentStart(name.charCodeAt(0))) {
    return false;
  }
  for (let i = 1; i < name.length; i++) {
    if (!isIdentTrailing(name.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// Reading
// -------------------------------------------------------------------------------------------

/**
 * Parses one s-expression; whitespace around it is allowed (a frame's text ends with `\n`).
 * Throws `SexpSyntaxError` for any text the compiler's reader rejects. Lists are read with an
 * explicit stack, so deep nesting cannot overflow the call stack.
 */
export function parseSexp(text: string): Sexp {
  const stack: Sexp[][] = [];
  let result: Sexp | undefined;
  let i = skipSpace(text, 0);
  for (;;) {
    if (result !== undefined && stack.length === 0) {
      if (i < text.length) {
        throw new SexpSyntaxError('expected the end of the input', i);
      }
      return result;
    }
    if (i >= text.length) {
      throw new SexpSyntaxError(stack.length > 0 ? "expected ')'" : 'expected an s-expression', i);
    }
    const c = text.charCodeAt(i);
    let value: Sexp;
    if (c === OPEN) {
      stack.push([]);
      i = skipSpace(text, i + 1);
      continue;
    } else if (c === CLOSE) {
      const items = stack.pop();
      if (items === undefined) {
        throw new SexpSyntaxError("unexpected ')'", i);
      }
      value = { kind: 'list', items };
      i++;
    } else if (isDigit(c)) {
      const start = i;
      while (i < text.length && isDigit(text.charCodeAt(i))) {
        i++;
      }
      value = { kind: 'integer', value: BigInt(text.slice(start, i)) };
    } else if (c === QUOTE) {
      const start = i + 1;
      let end = start;
      let escaped = false;
      while (end < text.length && text.charCodeAt(end) !== QUOTE) {
        if (text.charCodeAt(end) === BACKSLASH && end + 1 < text.length) {
          escaped = true;
          end += 2;
        } else {
          end++;
        }
      }
      if (end >= text.length) {
        throw new SexpSyntaxError('unterminated string', i);
      }
      const raw = text.slice(start, end);
      value = { kind: 'string', value: escaped ? unescape(raw) : raw };
      i = end + 1;
    } else if (c === COLON) {
      // `symbol ":"` and the name are separate tokens, so whitespace may come between them.
      const start = skipSpace(text, i + 1);
      let end = start;
      if (end < text.length && isIdentStart(text.charCodeAt(end))) {
        end++;
        while (end < text.length && isIdentTrailing(text.charCodeAt(end))) {
          end++;
        }
      }
      if (end === start) {
        throw new SexpSyntaxError("expected a name after ':'", start);
      }
      const name = text.slice(start, end);
      value = name === 'True' || name === 'False' ? { kind: 'bool', value: name === 'True' } : { kind: 'symbol', name };
      i = end;
    } else {
      throw new SexpSyntaxError(`unexpected character ${JSON.stringify(text[i])}`, i);
    }
    i = skipSpace(text, i);
    const open = stack[stack.length - 1];
    if (open === undefined) {
      result = value;
    } else {
      open.push(value);
    }
  }
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text.charCodeAt(i))) {
    i++;
  }
  return i;
}

/** `getEsc`: the ASCII control-character names, and `SP`, `DEL`. */
const NAMED_ESCAPES = new Map<string, string>([
  ...['NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'HT', 'LF', 'VT', 'FF', 'CR', 'SO',
    'SI', 'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS',
    'RS', 'US'].map((name, code): [string, string] => [name, String.fromCharCode(code)]),
  ['SP', ' '],
  ['DEL', '\x7f'],
]);

/** The single-character escapes of `unescape'`. */
const SIMPLE_ESCAPES = new Map<string, string>([
  ['\\', '\\'],
  ['a', '\x07'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ["'", "'"],
  ['"', '"'],
]);

/**
 * `cast` from `Int` to `Char` on the Chez backend (`cast-int-char`, `support/chez/support.ss`):
 * a value that is not a Unicode scalar value becomes NUL (compared with the real compiler in M0,
 * `test/fake-idris2/README.md`). How the compiler's `Int` conversion treats more than 64 bits
 * was not investigated; such values also become NUL here.
 */
function charOf(code: bigint): string {
  const valid = (code >= 0n && code <= 0xd7ffn) || (code >= 0xe000n && code <= 0x10ffffn);
  return valid ? String.fromCodePoint(Number(code)) : '\0';
}

/**
 * `unescape 0` (`Parser/Support/Escaping.idr`), case by case, on the text between the quotes:
 * `\\`, `\"`, `\'`, `\a` `\b` `\f` `\n` `\r` `\t` `\v`; `\` before a newline and `\&` stand for
 * nothing; `\x<hex>`, `\o<octal>`, `\<decimal>` for a code point; `\NUL`…`\US`, `\SP`, `\DEL`
 * (a three-letter name is tried before a two-letter one). A backslash starting none of these is
 * dropped and the text after it read again, as are `\x` and `\o` without digits.
 */
function unescape(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const backslash = raw.indexOf('\\', i);
    if (backslash < 0) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, backslash);
    i = backslash + 1;
    const c = raw[i]; // the lexer leaves a character after every backslash
    const simple = SIMPLE_ESCAPES.get(c);
    if (simple !== undefined) {
      out += simple;
      i++;
    } else if (c === '\n' || c === '&') {
      i++;
    } else if (c === 'x' || c === 'o') {
      const digits = c === 'x' ? /^[0-9a-fA-F]*/ : /^[0-7]*/;
      const run = digits.exec(raw.slice(i + 1))?.[0] ?? '';
      if (run.length > 0) {
        out += charOf(BigInt((c === 'x' ? '0x' : '0o') + run));
      }
      i += 1 + run.length;
    } else if (isDigit(raw.charCodeAt(i))) {
      const run = /^[0-9]+/.exec(raw.slice(i))?.[0] ?? '';
      out += charOf(BigInt(run));
      i += run.length;
    } else {
      // Three characters are tried only when three remain, two when at least two remain.
      const three = raw.length - i >= 3 ? NAMED_ESCAPES.get(raw.slice(i, i + 3)) : undefined;
      const two = raw.length - i >= 2 ? NAMED_ESCAPES.get(raw.slice(i, i + 2)) : undefined;
      if (three !== undefined) {
        out += three;
        i += 3;
      } else if (two !== undefined) {
        out += two;
        i += 2;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Writing
// -------------------------------------------------------------------------------------------

/**
 * Writes `sexp` in the compiler's syntax, as printable ASCII (see the module comment). Throws a
 * `RangeError` for a value the compiler would not read back as written: a negative integer (its
 * reader has no sign), a symbol that is not a name or is `True`/`False` (which read back as
 * booleans), and a string containing NUL.
 */
export function serializeSexp(sexp: Sexp): string {
  switch (sexp.kind) {
    case 'list':
      return `(${sexp.items.map(serializeSexp).join(' ')})`;
    case 'string':
      return serializeString(sexp.value);
    case 'bool':
      return sexp.value ? ':True' : ':False';
    case 'integer':
      if (sexp.value < 0n) {
        throw new RangeError(`the IDE protocol has no negative integers: ${sexp.value}`);
      }
      return sexp.value.toString();
    case 'symbol':
      if (!isName(sexp.name) || sexp.name === 'True' || sexp.name === 'False') {
        throw new RangeError(`not a symbol name the compiler reads back: ${JSON.stringify(sexp.name)}`);
      }
      return `:${sexp.name}`;
  }
}

function serializeString(value: string): string {
  let out = '"';
  let pendingEscape = false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (pendingEscape && isDigit(code)) {
      out += '\\&';
    }
    pendingEscape = false;
    if (code === QUOTE || code === BACKSLASH) {
      out += `\\${ch}`;
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else if (code === 0) {
      throw new RangeError('a string sent to the compiler must not contain NUL');
    } else {
      out += `\\${code >= 0xd800 && code <= 0xdfff ? 0xfffd : code}`;
      pendingEscape = true;
    }
  }
  return `${out}"`;
}
