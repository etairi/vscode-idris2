// The line reader of src/core/idrisSyntax.ts: the layout blocks it finds (`opensBlockOnLine`, `holdsBlockHeader`,
// one test per opener of `Idris/Parser.idr`), what is open after a line (`openAfter`), one-token answers
// (`isOneToken`), and Case Split's string check. That it reads every lexeme as M0's `lex` does is
// test/unit/idrisSyntaxLines.test.ts; the edits that use it are test/unit/edits.test.ts.
import * as assert from 'assert';
import {
  caseSplitLineProblem,
  firstTokenColumn,
  holdsBlockHeader,
  holeTokenNames,
  isOneToken,
  isOpen,
  levelTokens,
  NOTHING_OPEN,
  openAfter,
  opensBlockOnLine,
  withoutLineComment,
  type OpenBlock,
} from '../../src/core/idrisSyntax';

/** What is open after `lines`, read one after the other from nothing open. */
const after = (...lines: string[]): OpenBlock => lines.reduce((open, line) => openAfter(line, open), NOTHING_OPEN);

suite('core/idrisSyntax', () => {
  suite('opensBlockOnLine: the layout blocks of Idris/Parser.idr, the rest of a hole\'s line read after the hole', () => {
    const opens = (rest: string, open: OpenBlock = NOTHING_OPEN): boolean => opensBlockOnLine(rest, open);

    test('where: a clause\'s, a data declaration\'s, an interface\'s, an implementation\'s and a record\'s block (151–155, 1387, 1775, 1796, 1850)', () => {
      assert.ok(opens(' + y where y : Nat'));
      assert.ok(opens(' where MkR'));
      assert.ok(!opens(' + y where'), 'no entry on the line');
      assert.ok(!opens(' + y -- where y = 1'), 'in a comment');
      assert.ok(!opens(' ++ "where y"'), 'in a string');
    });

    test('of: a case\'s alternatives (852); an empty group is an entry, a bracket that closes the case is not', () => {
      assert.ok(opens(' * case x of _ => 1'));
      assert.ok(opens(' * case u of () => 1'));
      assert.ok(opens(' * case xs of [] => 1'));
      assert.ok(!opens(' * case x of'));
      assert.ok(!opens(' * (case x of)'));
    });

    test('do and a namespaced do (950, 954–961); not a record projection `.do`', () => {
      assert.ok(opens(' ++ do [1]'));
      assert.ok(opens(' * M.do 1'));
      assert.ok(opens(' * Prelude.Interfaces.do x'));
      assert.ok(!opens(' * (do)'));
      assert.ok(!opens(' * [do]'));
      assert.ok(!opens(' * a.do 1'), '`a` and `.do`: not a namespace');
    });

    test('let: an expression\'s and a do block\'s (841, 987), whose entries can be declarations (835)', () => {
      assert.ok(opens(' + let y = 1'));
      assert.ok(opens(' + let f : Nat'));
      assert.ok(!opens(' + let'));
    });

    test('\\case (776–780, 813), with or without a space; not after `\\\\`', () => {
      assert.ok(opens(' . \\case Z => 1'));
      assert.ok(opens(' . \\ case Z => 1'));
      assert.ok(!opens(' . \\case'));
      assert.ok(!opens(' . \\\\case Z => 1'), '`\\\\` is an operator');
    });

    test('`[ (quoted declarations, 627), with a token inside it', () => {
      assert.ok(opens(' `[ g : Nat'));
      assert.ok(!opens(' `[ ]'));
    });

    test('%foreign, %export and %nomangle (1154, 1159), a block of expressions; %foreign_impl after its name (1463)', () => {
      assert.ok(opens(' %foreign "C:puts"'));
      assert.ok(opens(' %export "f"'));
      assert.ok(opens(' %nomangle "f"'));
      assert.ok(opens(' %foreign_impl f "javascript:x"'));
      assert.ok(!opens(' %foreign_impl f'));
      assert.ok(!opens(' %inline f'), 'no block');
    });

    test('mutual (1623), failing after its optional message (1613), namespace after its name (1586)', () => {
      assert.ok(opens(' mutual f : Nat'));
      assert.ok(!opens(' mutual'));
      assert.ok(opens(' failing "msg" f : Nat'));
      assert.ok(opens(' failing f : Nat'));
      assert.ok(!opens(' failing "msg"'));
      assert.ok(opens(' namespace M f : Nat'));
      assert.ok(!opens(' namespace M'));
    });

    test('using after its (…) (1637); parameters after its binders, (…) or {…} (1815–1827, 1877)', () => {
      assert.ok(opens(' using (x : Nat) f : Nat'));
      assert.ok(!opens(' using (x : Nat)'));
      assert.ok(!opens(' using (x : Nat'), 'the header goes on below');
      assert.ok(opens(' parameters (n : Nat) {auto p : Show a} g : Nat'));
      assert.ok(!opens(' parameters (n : Nat) {m : Nat}'));
      assert.ok(!opens(' parameters (n : Nat) (m :'));
    });

    test('with after its header: flags, problems separated by |, each a quantity, (…), proof and a name (1231, 1263)', () => {
      assert.ok(opens(' with (x) g y = 1'));
      assert.ok(opens(' with %syntactic 0 (x) proof p | (y) g z | _ | _ = 1'));
      assert.ok(!opens(' with (x) proof p'));
      assert.ok(!opens(' with (x'));
      assert.ok(opens(' with (x) | (y)'), 'the | between problems counts as any | does');
    });

    test('|: the first token of an alternative after a let\'s or a <-\'s value (831, 999), read conservatively; not the | of |]', () => {
      assert.ok(opens(' | Nothing => 0'));
      assert.ok(opens(' |'), 'an alternative that goes on below');
      assert.ok(opens(' | x <- xs]'), 'a list comprehension\'s | counts too');
      assert.ok(!opens(' <|> [| S m |]'));
      assert.ok(!opens(' |)', after('f = (x')), 'a | before a bracket that closes a group opened before it');
    });

    test('; ends an entry and starts the next (terminator, Rule/Source.idr 561–569)', () => {
      assert.ok(opens('; _ => 1'));
      assert.ok(!opens(';'));
    });

    test('inside a string\'s interpolation; not in its text; the rest read from what is open at the hole', () => {
      assert.ok(opens(' ++ "\\{case x of _ => 1}"'));
      assert.ok(!opens(' ++ "\\{case x of}"'), 'the interpolation closes the case');
      assert.ok(!opens('} of x"', after('f x = "\\{')), 'after the hole\'s interpolation, the string\'s text');
      assert.ok(opens(' * case x of _ => 1}"', after('f x = "\\{')));
    });

    test('a reading the compiler would reject (a " string a line break ends) is unsure: it counts', () => {
      assert.ok(opens(' ++ "abc'));
      assert.ok(opens(' + 1', after('s = "abc')), 'unsure from there on');
    });
  });

  suite('holdsBlockHeader: the code up to a hole ends inside a parameters, using or with header', () => {
    test('on the hole\'s line', () => {
      assert.ok(holdsBlockHeader('parameters (n : ', NOTHING_OPEN));
      assert.ok(holdsBlockHeader('parameters (n : Nat) {auto p : ', NOTHING_OPEN));
      assert.ok(holdsBlockHeader('using (x : Nat, y : ', NOTHING_OPEN));
      assert.ok(holdsBlockHeader('f x with (', NOTHING_OPEN));
      assert.ok(holdsBlockHeader('f x with (x) proof p | (', NOTHING_OPEN));
    });

    test('a header continued over lines: the entry\'s code from its first line (M4\'s third review of the fixes, P1)', () => {
      assert.ok(holdsBlockHeader('parameters (n : Nat)\n           (m : ', NOTHING_OPEN));
      assert.ok(holdsBlockHeader('parameters (n : Nat,\n            m : ', NOTHING_OPEN));
      assert.ok(holdsBlockHeader('using (x : Nat,\n       y : ', NOTHING_OPEN));
    });

    test('not after the header, nor in the block\'s entries, nor elsewhere', () => {
      assert.ok(!holdsBlockHeader('parameters (n : Nat) ', NOTHING_OPEN));
      assert.ok(!holdsBlockHeader('parameters (n : Nat) g : ', NOTHING_OPEN));
      assert.ok(!holdsBlockHeader('parameters (n : Nat)\n  g : Nat\n  g = (', NOTHING_OPEN));
      assert.ok(!holdsBlockHeader('using (x : Nat) f : (', NOTHING_OPEN));
      assert.ok(!holdsBlockHeader('f = case (', NOTHING_OPEN));
      assert.ok(!holdsBlockHeader('f = g (', NOTHING_OPEN));
      assert.ok(!holdsBlockHeader('-- parameters (n : ', NOTHING_OPEN));
    });
  });

  suite('what is open after a line', () => {
    test('\'\\\'\' is a character literal: the quotes after it open no string (M4\'s third review of the fixes)', () => {
      assert.ok(!isOpen(after("quotes '\\'' '\"' = True")));
      assert.ok(!isOpen(after("q = ['\\'','\"']")));
      assert.ok(isOneToken("'\\''"));
      assert.deepStrictEqual(
        levelTokens("quotes '\\'' '\"' = True").map((t) => t.text),
        ['quotes', "'\\''", "'\"'", '=', 'True'],
      );
    });

    test('a " string open at a line break ends there, unclosed (the compiler rejects it), unless an escape takes the break', () => {
      const open = after('s = "abc');
      assert.ok(!isOpen(open));
      assert.ok(open.unsure);
      assert.strictEqual(firstTokenColumn('t = 1', open), 0);
      assert.ok(isOpen(after('s = "abc\\')));
      assert.strictEqual(firstTokenColumn('def"', after('s = "abc\\')), 'string');
      assert.ok(isOpen(after('s = """')), 'a multiline string');
    });

    test('block comments, strings in them, and a character literal a line break cuts', () => {
      assert.ok(isOpen(after('{- a {- b -}')));
      assert.ok(!isOpen(after('{- a {- b -}', ' -}')));
      assert.ok(isOpen(after('{- " -}')), 'a string in a comment hides -}');
      assert.ok(isOpen(after("x = '")));
      assert.strictEqual(firstTokenColumn("' + y", after("x = '")), 2, 'the literal\'s closing quote starts no token');
    });
  });

  suite('isOneToken', () => {
    test('one token, read as the lexer reads it', () => {
      for (const one of ['x', 'Prelude.id', '_', '12', '0x1F', '1.5e3', "'a'", "'\\''", '"a"', '"a\\{b}c"', '#"a"b"#', '?h', '(+)', '( <$> )', '(S n)', '[1, 2]', '[| f x |]', '(.x)']) {
        assert.ok(isOneToken(one), one);
      }
    });

    test('not one token', () => {
      // A postfix projection is one token to the lexer (`dotIdent`), but the parser applies it to the expression before
      // it (`simpleExpr`, `Idris/Parser.idr` 572–581 [src]): `g .x` is `(.x) g` (final review of the convergence pass).
      for (const more of ['x.field', '.x', '.do', '.Foo', '12abc', '-1', '(a) + (b)', '(a]', '([a)', 'a)', '"abc', "'", '"a\\', '(--)', 'x -- c', '%search']) {
        assert.ok(!isOneToken(more), more);
      }
    });
  });

  test('caseSplitLineProblem: a raw string holding a name of the clause is a string too (M4\'s third review of the fixes, R1)', () => {
    assert.strictEqual(caseSplitLineProblem('f xs #"xs"# = ?f_rhs', 'f xs #"xs"# = ?f_rhs'), 'string');
    assert.strictEqual(caseSplitLineProblem('f xs ##"a"#xs"## = ?f_rhs', 'f xs ##"a"#xs"## = ?f_rhs'), 'string');
    assert.strictEqual(caseSplitLineProblem('f xs "xs" = ?f_rhs', 'f xs "xs" = ?f_rhs'), 'string');
    assert.strictEqual(caseSplitLineProblem('f xs #"ys"# = ?f_rhs', 'f xs #"ys"# = ?f_rhs'), undefined);
  });

  test('withoutLineComment and holeTokenNames read the lexer\'s comments and names', () => {
    assert.strictEqual(withoutLineComment('f = "--" -- c'), 'f = "--" ');
    assert.strictEqual(withoutLineComment("f = '-' --> c"), "f = '-' ");
    assert.strictEqual(withoutLineComment('f = a --} b'), 'f = a --} b');
    assert.deepStrictEqual([...holeTokenNames('f = ?a + ??b ?c\' ?α₁ "?d" ?')], ['a', 'b', "c'", 'α₁', 'd']);
  });
});
