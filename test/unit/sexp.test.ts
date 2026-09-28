import * as assert from 'assert';
import { int, list, parseSexp, serializeSexp, SexpSyntaxError, str, sym } from '../../src/backend/ide/sexp';
import type { Sexp, SexpBool } from '../../src/backend/ide/types';

const bool = (value: boolean): SexpBool => ({ kind: 'bool', value });

/** A small deterministic PRNG (mulberry32), so that the property tests are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Code points worth mixing: quote, backslash, controls, digits, DEL, U+00A0, BMP and astral. */
const INTERESTING = [0x22, 0x5c, 0x0a, 0x0d, 0x09, 0x07, 0x1b, 0x30, 0x39, 0x26, 0x7f, 0x80, 0xa0, 0xe9,
  0x3b1, 0x2192, 0x2028, 0xfeff, 0xfffd, 0x1d55f, 0x10ffff];

function randomString(next: () => number, maxLength: number): string {
  let s = '';
  const length = Math.floor(next() * maxLength);
  for (let i = 0; i < length; i++) {
    const r = next();
    s += String.fromCodePoint(r < 0.5
      ? 0x20 + Math.floor(next() * 0x5f)
      : INTERESTING[Math.floor(next() * INTERESTING.length)]);
  }
  return s;
}

function roundTrip(value: Sexp): Sexp {
  return parseSexp(serializeSexp(value));
}

suite('backend/ide/sexp', () => {
  suite('writing', () => {
    test('lists, symbols, integers and booleans are written as Show SExp writes them', () => {
      assert.strictEqual(serializeSexp(list(sym('version'), int(1))), '(:version 1)');
      assert.strictEqual(serializeSexp(sym('proof-search-next')), ':proof-search-next');
      assert.strictEqual(serializeSexp(list()), '()');
      assert.strictEqual(serializeSexp(list(sym('enable-syntax'), bool(false))), '(:enable-syntax :False)');
      assert.strictEqual(serializeSexp(bool(true)), ':True');
      assert.strictEqual(serializeSexp(list(list(int(0), int(8), int(0)), list(str('')))), '((0 8 0) (""))');
    });

    test('integers are arbitrary-precision (the compiler echoes 99999999999999999999 unchanged)', () => {
      assert.strictEqual(serializeSexp(int(99999999999999999999n)), '99999999999999999999');
    });

    test('" and \\ are escaped; printable ASCII is written as itself', () => {
      assert.strictEqual(serializeSexp(str('a"b\\c')), '"a\\"b\\\\c"');
      let ascii = '';
      for (let c = 0x20; c <= 0x7e; c++) {
        ascii += String.fromCharCode(c);
      }
      assert.strictEqual(serializeSexp(str(ascii)), `"${ascii.replace('\\', '\\\\').replace('"', '\\"')}"`);
    });

    test('every other character is a decimal escape, so a request is printable ASCII (F1 addendum)', () => {
      assert.strictEqual(serializeSexp(str('é')), '"\\233"');
      assert.strictEqual(serializeSexp(str('→')), '"\\8594"');
      assert.strictEqual(serializeSexp(str('𝕟')), '"\\120159"');
      assert.strictEqual(serializeSexp(str('a\nb\r\tc')), '"a\\10b\\13\\9c"');
      assert.strictEqual(serializeSexp(str('\x7f\xa0')), '"\\127\\160"');
    });

    test('a digit after a decimal escape is separated by \\& (live: (:type-of "\\945\\&1") found α1)', () => {
      assert.strictEqual(serializeSexp(str('α1')), '"\\945\\&1"');
      assert.strictEqual(serializeSexp(str('é12é')), '"\\233\\&12\\233"');
      assert.strictEqual(serializeSexp(str('éa')), '"\\233a"');
    });

    test('a lone surrogate is written as U+FFFD, as a UTF-8 encoder would', () => {
      assert.strictEqual(serializeSexp(str('a\ud800b')), '"a\\65533b"');
      assert.strictEqual(serializeSexp(str('\udc00')), '"\\65533"');
    });

    test('values the compiler would not read back as written are refused', () => {
      assert.throws(() => serializeSexp(int(-1)), RangeError);
      assert.throws(() => serializeSexp(str('a\0b')), RangeError);
      for (const name of ['', '1a', 'a b', '-a', 'a:b', 'a(b', 'True', 'False']) {
        assert.throws(() => serializeSexp(sym(name)), RangeError, name);
      }
      // Nested values are checked too.
      assert.throws(() => serializeSexp(list(sym('x'), list(int(-5)))), RangeError);
    });

    test('names follow identAllowDashes: _, letters, above U+00A0, then also digits, - and \'', () => {
      for (const name of ['a', '_', 'load-file', "a'", 'x1-2', 'α', 'éa', 'True-x', 'Falsey']) {
        assert.strictEqual(serializeSexp(sym(name)), `:${name}`);
        assert.deepStrictEqual(roundTrip(sym(name)), sym(name));
      }
    });
  });

  suite('round trips (ROADMAP M2 acceptance: ", \\, newlines, →)', () => {
    for (const value of ['', '"', '\\', '\\"', '"\\', '\n', 'a\nb\n', '→', 'x → y', '𝕟', '\r\n', '\t',
      'α1', 'é12', '\\233', '\\&', '\x01\x7f\x80\xa0', '﻿', '12345', 'end\\']) {
      test(`string ${JSON.stringify(value)}`, () => {
        assert.deepStrictEqual(roundTrip(str(value)), str(value));
      });
    }

    test('property: 2000 random strings round-trip and serialize to printable ASCII (seed 1)', () => {
      const next = prng(1);
      for (let i = 0; i < 2000; i++) {
        const value = randomString(next, 40);
        const text = serializeSexp(str(value));
        assert.ok(/^[\x20-\x7e]*$/.test(text), JSON.stringify(text));
        assert.deepStrictEqual(parseSexp(text), str(value), JSON.stringify(value));
      }
    });

    test('nested values round-trip', () => {
      const value = list(sym('warning'), list(str('Bad.idr'), list(int(3), int(6)), list(int(3), int(11)),
        str('While processing\n"x"'), list(list(int(36), int(1), list(list(sym('decor'), sym('bound')))))), int(1));
      assert.deepStrictEqual(roundTrip(value), value);
    });
  });

  suite('reading: the compiler grammar (Protocol/SExp/Parser.idr)', () => {
    test(':True and :False are booleans; longer names are symbols', () => {
      assert.deepStrictEqual(parseSexp(':True'), bool(true));
      assert.deepStrictEqual(parseSexp(':False'), bool(false));
      assert.deepStrictEqual(parseSexp(':True-x'), sym('True-x'));
      assert.deepStrictEqual(parseSexp(':Truex'), sym('Truex'));
    });

    test('":" and the name are separate tokens, so whitespace may come between them', () => {
      assert.deepStrictEqual(parseSexp(': version'), sym('version'));
      assert.deepStrictEqual(parseSexp('(: True)'), list(bool(true)));
    });

    test('integers are digit runs, arbitrary precision, leading zeros allowed', () => {
      assert.deepStrictEqual(parseSexp('0012'), int(12));
      assert.deepStrictEqual(parseSexp('99999999999999999999'), int(99999999999999999999n));
    });

    test('whitespace is isSpace: space, \\t, \\n, \\v, \\f, \\r and U+00A0', () => {
      assert.deepStrictEqual(parseSexp(' \t\n\v\f\r (:a :b\n1)\n'), list(sym('a'), sym('b'), int(1)));
    });

    test('a character above U+00A0 is a name character, so U+2028 continues a name', () => {
      assert.deepStrictEqual(parseSexp('(:a :b)'), list(sym('a '), sym('b')));
      assert.deepStrictEqual(parseSexp('(:α𝕟)'), list(sym('α𝕟')));
    });

    test('values need no space between them where tokens are distinct', () => {
      assert.deepStrictEqual(parseSexp('(:a"b"1(:c))'), list(sym('a'), str('b'), int(1), list(sym('c'))));
    });

    test('strings keep raw newlines and non-ASCII text (as the compiler writes its replies)', () => {
      assert.deepStrictEqual(parseSexp('"a\nb → 𝕟"'), str('a\nb → 𝕟'));
    });

    test('a deeply nested list is read without exhausting the call stack', () => {
      const depth = 100000;
      let value = parseSexp('('.repeat(depth) + ')'.repeat(depth));
      let levels = 1;
      while (value.kind === 'list' && value.items.length === 1) {
        value = value.items[0];
        levels++;
      }
      assert.deepStrictEqual(value, list());
      assert.strictEqual(levels, depth);
    });

    for (const [text, why] of [
      ['', 'empty'],
      ['   ', 'only whitespace'],
      ['(', 'unclosed list'],
      ['(:a (:b)', 'unclosed outer list'],
      [')', 'stray ")"'],
      ['(:a))', 'trailing ")"'],
      ['(:a) (:b)', 'two values'],
      ['"abc', 'unterminated string'],
      ['"abc\\"', 'the closing quote is escaped'],
      ['foo', 'a name without ":"'],
      ['(:a foo)', 'a bare name in a list'],
      [':', '":" at the end'],
      [':1', 'a name cannot start with a digit'],
      [':"x"', 'a string after ":"'],
      ['-1', 'no sign'],
      ['1a', 'a name right after digits'],
      ['#', 'an unknown character'],
      ['(:a\u0085)', 'U+0085 is neither space nor name'],
    ] as const) {
      test(`rejects ${JSON.stringify(text)} (${why})`, () => {
        assert.throws(() => parseSexp(text), SexpSyntaxError);
      });
    }

    test('the error names the offset where reading stopped', () => {
      try {
        parseSexp('(:a #)');
        assert.fail('no error');
      } catch (e) {
        assert.ok(e instanceof SexpSyntaxError);
        assert.strictEqual(e.offset, 4);
        assert.match(e.message, /offset 4/);
      }
    });
  });

  suite('reading: string escapes (Parser/Support/Escaping.idr unescape)', () => {
    const cases: [string, string][] = [
      ['\\\\', '\\'],
      ['\\"', '"'],
      ["\\'", "'"],
      ['\\a\\b\\f\\n\\r\\t\\v', '\x07\b\f\n\r\t\v'],
      ['a\\&b', 'ab'],
      ['a\\\nb', 'ab'], // backslash-newline stands for nothing
      ['\\65\\&6', 'A6'],
      ['\\0', '\0'],
      ['\\120159', '𝕟'],
      ['\\x41\\x3b1', 'Aα'],
      ['\\x4a\\x4A', 'JJ'],
      ['\\o101', 'A'],
      ['\\NUL\\SOH\\DEL\\SP\\ESC', '\0\x01\x7f \x1b'],
      ['\\SOH', '\x01'], // three letters before two
      ['\\SOx', '\x0ex'],
      ['\\SO', '\x0e'],
      ['\\BS\\HT', '\b\t'],
      ['\\q', 'q'], // not an escape: the backslash is dropped
      ['\\Q12', 'Q12'],
      ['\\xg', 'g'], // \x without digits is dropped
      ['\\o9', '9'],
      ['\\X41', 'X41'],
      ['\\55296', '\0'], // a surrogate is not a scalar value: NUL (Chez cast-int-char)
      ['\\1114112', '\0'], // above U+10FFFF: NUL
      ['\\x110000', '\0'],
      ['\\𝕟', '𝕟'], // a backslash before a character outside the BMP is dropped
    ];
    for (const [inner, value] of cases) {
      test(`"${inner}" reads as ${JSON.stringify(value)}`, () => {
        assert.deepStrictEqual(parseSexp(`"${inner}"`), str(value));
      });
    }

    test('an Idris show of a string reads back as the string (the :metavariables names)', () => {
      assert.deepStrictEqual(parseSexp('"\\"Clean.vlen_rhs\\""'), str('"Clean.vlen_rhs"'));
      // Prelude.Show showLitChar: \SO before H is protected by \&, non-ASCII is decimal.
      assert.deepStrictEqual(parseSexp('"\\SO\\&H\\945\\&1\\DEL\\n"'), str('\x0eHα1\x7f\n'));
    });
  });
});
