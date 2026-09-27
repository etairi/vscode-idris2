import * as assert from 'assert';
import { lex, type TokenKind } from '../../src/features/syntax/lexer';

/** `[kind, text]` for every token. */
function tokens(text: string): [TokenKind, string][] {
  return lex(text).tokens.map((t) => [t.kind, t.text]);
}

suite('features/syntax/lexer', () => {
  suite('identifiers, keywords, holes, pragmas', () => {
    test('a signature', () => {
      assert.deepStrictEqual(tokens('vlen : Vect n a -> Nat'), [
        ['ident', 'vlen'],
        ['symbol', ':'],
        ['ident', 'Vect'],
        ['ident', 'n'],
        ['ident', 'a'],
        ['symbol', '->'],
        ['ident', 'Nat'],
      ]);
    });

    test('keywords are identifiers from the keyword list; Idris 1 words are not keywords', () => {
      assert.deepStrictEqual(tokens('public export covering failing class instance codata'), [
        ['keyword', 'public'],
        ['keyword', 'export'],
        ['keyword', 'covering'],
        ['keyword', 'failing'],
        ['ident', 'class'],
        ['ident', 'instance'],
        ['ident', 'codata'],
      ]);
    });

    test('namespaced names, record projections, primes', () => {
      assert.deepStrictEqual(tokens("Data.Vect.fromList x.field x' Prelude.Nat"), [
        ['ident', 'Data.Vect.fromList'],
        ['ident', 'x'],
        ['ident', '.field'],
        ['ident', "x'"],
        ['ident', 'Prelude.Nat'],
      ]);
    });

    test('holes and pragmas', () => {
      assert.deepStrictEqual(tokens('?vlen_rhs %default total %runElab'), [
        ['hole', '?vlen_rhs'],
        ['pragma', '%default'],
        ['keyword', 'total'],
        ['pragma', '%runElab'],
      ]);
    });

    test('`_foo` is `_` then `foo` (the symbols rule precedes identifiers; `_foo : Nat` does not parse)', () => {
      assert.deepStrictEqual(tokens('_foo'), [
        ['symbol', '_'],
        ['ident', 'foo'],
      ]);
    });

    test('characters above U+00A0 are identifier characters (F18: α, x₁, ℕ, and also →)', () => {
      assert.deepStrictEqual(tokens('α x₁ ℕ → 𝔸'), [
        ['ident', 'α'],
        ['ident', 'x₁'],
        ['ident', 'ℕ'],
        ['ident', '→'],
        ['ident', '𝔸'],
      ]);
    });
  });

  suite('literals', () => {
    test('numbers', () => {
      assert.deepStrictEqual(tokens('3.14e-2 0x1F 0XfF 0b1_01 0o17 1_000 1.5e'), [
        ['number', '3.14e-2'],
        ['number', '0x1F'],
        ['number', '0XfF'],
        ['number', '0b1_01'],
        ['number', '0o17'],
        ['number', '1_000'],
        ['number', '1.5'],
        ['ident', 'e'],
      ]);
    });

    test('character literals, including escapes and a surrogate pair', () => {
      assert.deepStrictEqual(tokens("'a' '\\n' '\\x41' '\\NUL' '\\'' '𝔸'"), [
        ['char', "'a'"],
        ['char', "'\\n'"],
        ['char', "'\\x41'"],
        ['char', "'\\NUL'"],
        ['char', "'\\''"],
        ['char', "'𝔸'"],
      ]);
    });

    test('a string with an interpolation, and the groups it opens', () => {
      const result = lex('"a\\{show (n + 1)}b"');
      assert.deepStrictEqual(
        result.tokens.map((t) => [t.kind, t.text]),
        [
          ['stringOpen', '"'],
          ['stringText', 'a'],
          ['interpOpen', '\\{'],
          ['ident', 'show'],
          ['groupOpen', '('],
          ['ident', 'n'],
          ['symbol', '+'],
          ['number', '1'],
          ['groupClose', ')'],
          ['interpClose', '}'],
          ['stringText', 'b'],
          ['stringClose', '"'],
        ],
      );
      const [str, interp, paren] = result.groups;
      assert.deepStrictEqual([str.kind, interp.kind, paren.kind], ['string', 'interpolation', 'bracket']);
      assert.strictEqual(interp.parent, str);
      assert.strictEqual(paren.parent, interp);
      assert.ok(result.groups.every((g) => g.close !== undefined));
    });

    test('escapes: `\\"` does not end a string; `\\\\{` is an escaped backslash then text', () => {
      assert.deepStrictEqual(tokens('"a\\"b" "c\\\\{d"'), [
        ['stringOpen', '"'],
        ['stringText', 'a\\"b'],
        ['stringClose', '"'],
        ['stringOpen', '"'],
        ['stringText', 'c\\\\{d'],
        ['stringClose', '"'],
      ]);
    });

    test('raw strings end at `"#` and interpolate with `\\#{`', () => {
      assert.deepStrictEqual(tokens('#"a"b\\{x}\\#{y}"#'), [
        ['stringOpen', '#"'],
        ['stringText', 'a"b\\{x}'],
        ['interpOpen', '\\#{'],
        ['ident', 'y'],
        ['interpClose', '}'],
        ['stringClose', '"#'],
      ]);
    });

    test('multi-line strings open with `"""` and a line break, and may contain quotes', () => {
      assert.deepStrictEqual(tokens('s = """\n  a "q"\n  """'), [
        ['ident', 's'],
        ['symbol', '='],
        ['stringOpen', '"""\n'],
        ['stringText', '  a "q"\n  '],
        ['stringClose', '"""'],
      ]);
    });

    test('a single-line string left open ends at the line break, unclosed', () => {
      const result = lex('s = "abc\nt = 1');
      assert.deepStrictEqual(
        result.tokens.map((t) => [t.kind, t.text]),
        [
          ['ident', 's'],
          ['symbol', '='],
          ['stringOpen', '"'],
          ['stringText', 'abc'],
          ['ident', 't'],
          ['symbol', '='],
          ['number', '1'],
        ],
      );
      assert.strictEqual(result.groups[0].close, undefined);
    });
  });

  suite('comments', () => {
    test('line, doc and block comments', () => {
      assert.deepStrictEqual(tokens('x -- c (\n||| doc )\n{- b { -} y'), [
        ['ident', 'x'],
        ['comment', '-- c ('],
        ['docComment', '||| doc )'],
        ['comment', '{- b { -}'],
        ['ident', 'y'],
      ]);
    });

    test('`--` starts a comment wherever a token starts: `(-->)` is `(` and a comment', () => {
      assert.deepStrictEqual(tokens('(-->) a'), [
        ['groupOpen', '('],
        ['comment', '-->) a'],
      ]);
    });

    test('dashes followed by `}` are not a comment: `1 --}` is 1, --, and a stray }', () => {
      assert.deepStrictEqual(tokens('1 --}'), [
        ['number', '1'],
        ['symbol', '--'],
        ['unrecognised', '}'],
      ]);
    });

    test('an operator that contains dashes is one symbol', () => {
      assert.deepStrictEqual(tokens('a <-- b'), [
        ['ident', 'a'],
        ['symbol', '<--'],
        ['ident', 'b'],
      ]);
    });

    test('in a block comment, `--` hides `-}` until the end of the line', () => {
      assert.deepStrictEqual(tokens('{- a -- b -}\nfoo\n-}\nbar'), [
        ['comment', '{- a -- b -}\nfoo\n-}'],
        ['ident', 'bar'],
      ]);
    });

    test('in a block comment, strings and character literals are skipped; nesting is counted', () => {
      assert.deepStrictEqual(tokens('{- a "-}" -} x'), [
        ['comment', '{- a "-}" -}'],
        ['ident', 'x'],
      ]);
      assert.deepStrictEqual(tokens("{- a '\"' -} x"), [
        ['comment', "{- a '\"' -}"],
        ['ident', 'x'],
      ]);
      assert.deepStrictEqual(tokens('{- a {- b -} c -} x'), [
        ['comment', '{- a {- b -} c -}'],
        ['ident', 'x'],
      ]);
    });

    test('`--}` closes a block comment', () => {
      assert.deepStrictEqual(tokens('{- a --} x'), [
        ['comment', '{- a --}'],
        ['ident', 'x'],
      ]);
    });

    test('a top-level `{-}`, `{--}` or `{----}` does not close itself: the rest is comment', () => {
      for (const opener of ['{-}', '{--}', '{----}']) {
        assert.deepStrictEqual(tokens(`${opener}\nfoo = 1`), [['comment', `${opener}\nfoo = 1`]], opener);
      }
    });

    test('a nested `{-}` opens and closes at once', () => {
      assert.deepStrictEqual(tokens('{- {-} -} x'), [
        ['comment', '{- {-} -}'],
        ['ident', 'x'],
      ]);
    });

    test('%cg directives are one token', () => {
      assert.deepStrictEqual(tokens('%cg chez {(x)\n y}\nz'), [
        ['cgDirective', '%cg chez {(x)\n y}'],
        ['ident', 'z'],
      ]);
    });
  });

  suite('groups', () => {
    test('the compiler group symbols and their closers', () => {
      const result = lex('[| f x |] @{p} .(+) [< a ] `(q)');
      assert.deepStrictEqual(
        result.groups.map((g) => [g.open.text, g.close?.text]),
        [
          ['[|', '|]'],
          ['@{', '}'],
          ['.(', ')'],
          ['[<', ']'],
          ['`(', ')'],
        ],
      );
    });

    test('a closer is tried before any rule inside its group', () => {
      assert.deepStrictEqual(tokens('[| a || b |]'), [
        ['groupOpen', '[|'],
        ['ident', 'a'],
        ['symbol', '||'],
        ['ident', 'b'],
        ['groupClose', '|]'],
      ]);
    });

    test('an unclosed group stays open; a closer of an enclosing group closes it', () => {
      const unclosed = lex('f (x');
      assert.strictEqual(unclosed.groups[0].close, undefined);

      const mismatched = lex('( [ )');
      assert.deepStrictEqual(
        mismatched.groups.map((g) => [g.open.text, g.close?.text]),
        [
          ['(', ')'],
          ['[', undefined],
        ],
      );
    });

    test('a stray closer is unrecognised', () => {
      assert.deepStrictEqual(tokens('a ) b'), [
        ['ident', 'a'],
        ['unrecognised', ')'],
        ['ident', 'b'],
      ]);
    });

    test('backticked names', () => {
      assert.deepStrictEqual(tokens('x `plus` y'), [
        ['ident', 'x'],
        ['symbol', '`'],
        ['ident', 'plus'],
        ['symbol', '`'],
        ['ident', 'y'],
      ]);
    });

    test('delimiters record the group they delimit; other tokens the group they sit in', () => {
      const result = lex('(a)');
      const [open, a, close] = result.tokens;
      const [group] = result.groups;
      assert.strictEqual(open.delimits, group);
      assert.strictEqual(close.delimits, group);
      assert.strictEqual(open.outer, undefined);
      assert.strictEqual(a.outer, group);
      assert.strictEqual(a.delimits, undefined);
    });
  });
});
