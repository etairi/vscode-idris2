import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { LiterateStyle } from '../../src/project/literate';
import {
  buildSyntaxModel,
  isModelledStyle,
  selectionRangesAt,
  type ModelledStyle,
} from '../../src/features/syntax/selectionRangeModel';

function repositoryRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'vscode-idris2') {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no vscode-idris2 package.json above ${__dirname}`);
    }
  }
}

/** The selected texts, innermost first, at the `occurrence`-th occurrence of `at` in `text`. */
function chain(text: string, at: string, occurrence = 1, literate?: ModelledStyle): string[] {
  let offset = -1;
  for (let k = 0; k < occurrence; k++) {
    offset = text.indexOf(at, offset + 1);
  }
  assert.ok(offset >= 0, `"${at}" not found`);
  const model = buildSyntaxModel(text, literate);
  return selectionRangesAt(model, offset).map((r) => text.slice(r.start, r.end));
}

const vlen = ['module Vlen', '', 'import Data.Vect', '', 'vlen : Vect n a -> Nat', 'vlen [] = 0', 'vlen (x :: xs) = ?rhs', ''].join(
  '\n',
);

suite('features/syntax selection ranges', () => {
  test('ROADMAP M0 acceptance: on `vlen (x :: xs) = ?rhs` the ranges grow token → group → clause', () => {
    assert.deepStrictEqual(chain(vlen, 'x ::'), [
      'x',
      'x :: xs',
      '(x :: xs)',
      'vlen (x :: xs) = ?rhs',
      'vlen : Vect n a -> Nat\nvlen [] = 0\nvlen (x :: xs) = ?rhs',
      vlen,
    ]);
  });

  test('a hole is one token', () => {
    assert.deepStrictEqual(chain(vlen, 'rhs').slice(0, 2), ['?rhs', 'vlen (x :: xs) = ?rhs']);
  });

  test('the cursor right after a token selects that token', () => {
    const text = 'f = g xs\n';
    const model = buildSyntaxModel(text, undefined);
    const ranges = selectionRangesAt(model, text.indexOf('xs') + 2).map((r) => text.slice(r.start, r.end));
    assert.deepStrictEqual(ranges.slice(0, 2), ['xs', 'f = g xs']);
  });

  test('brackets inside strings, character literals and comments do not form groups', () => {
    const text = 'f = g ")" \'(\' (h x) -- (\n';
    assert.deepStrictEqual(chain(text, 'x)'), ['x', 'h x', '(h x)', 'f = g ")" \'(\' (h x) -- (', text]);
  });

  test('strings and interpolations are groups', () => {
    const text = 's = "a\\{show (n + 1)}b"\n';
    assert.deepStrictEqual(chain(text, 'n +'), [
      'n',
      'n + 1',
      '(n + 1)',
      'show (n + 1)',
      '\\{show (n + 1)}',
      'a\\{show (n + 1)}b',
      '"a\\{show (n + 1)}b"',
      's = "a\\{show (n + 1)}b"',
      text,
    ]);
  });

  test('where blocks nest: clause → group → where block → enclosing clause → its group', () => {
    const text = [
      'foo : Nat -> Nat',
      'foo x = go x',
      '  where',
      '    go : Nat -> Nat',
      '    go Z = Z',
      '    go (S k) = go k',
      '',
      'bar : Nat',
      'bar = 1',
      '',
    ].join('\n');
    assert.deepStrictEqual(chain(text, 'Z = Z'), [
      'Z',
      'go Z = Z',
      'go : Nat -> Nat\n    go Z = Z\n    go (S k) = go k',
      'where\n    go : Nat -> Nat\n    go Z = Z\n    go (S k) = go k',
      'foo x = go x\n  where\n    go : Nat -> Nat\n    go Z = Z\n    go (S k) = go k',
      'foo : Nat -> Nat\nfoo x = go x\n  where\n    go : Nat -> Nat\n    go Z = Z\n    go (S k) = go k',
      text,
    ]);
  });

  test('continuation lines are sub-blocks of their line; a trailing comment belongs to its line', () => {
    const text = ['main : IO ()', 'main = do', '  putStrLn "a" -- greet', '  putStrLn "b"', ''].join('\n');
    assert.deepStrictEqual(chain(text, 'a" --'), [
      'a',
      '"a"',
      'putStrLn "a" -- greet',
      'main = do\n  putStrLn "a" -- greet\n  putStrLn "b"',
      'main : IO ()\nmain = do\n  putStrLn "a" -- greet\n  putStrLn "b"',
      text,
    ]);
  });

  test('statements of a do block are not a declaration group', () => {
    const text = ['main = do', '  printLn 1', '  printLn 2', ''].join('\n');
    assert.deepStrictEqual(chain(text, '1'), ['1', 'printLn 1', 'main = do\n  printLn 1\n  printLn 2', text]);
  });

  test('named implementations (`Show Foo where`) are not clauses of one name', () => {
    const text = ['Show Foo where', '  show _ = "Foo"', 'Show Bar where', '  show _ = "Bar"', ''].join('\n');
    assert.deepStrictEqual(chain(text, 'Foo where'), ['Foo', 'Show Foo where\n  show _ = "Foo"', text]);
  });

  test('the group takes in modifier lines and the documentation above the signature', () => {
    const text = ['%default total', '', '||| Doubles.', '%inline', 'export', 'twice : Nat -> Nat', 'twice n = n + n', ''].join(
      '\n',
    );
    assert.deepStrictEqual(chain(text, 'n + n'), [
      'n',
      'twice n = n + n',
      '||| Doubles.\n%inline\nexport\ntwice : Nat -> Nat\ntwice n = n + n',
      text,
    ]);
  });

  test('a documented signature without clauses is grouped with its documentation', () => {
    const text = ['||| The answer.', 'answer : Nat', ''].join('\n');
    assert.deepStrictEqual(chain(text, 'Nat'), ['Nat', 'answer : Nat', '||| The answer.\nanswer : Nat', text]);
  });

  test('a signature for several names groups the clauses of all of them', () => {
    const text = ['a, b : Nat', 'a = 1', 'b = 2', 'c : Nat', 'c = 3', ''].join('\n');
    assert.deepStrictEqual(chain(text, '2').slice(0, 3), ['2', 'b = 2', 'a, b : Nat\na = 1\nb = 2']);
  });

  test('operators: `(op) : …` groups infix and prefix clauses of op', () => {
    const text = ['(++) : List a -> List a -> List a', '[] ++ ys = ys', '(x :: xs) ++ ys = x :: (xs ++ ys)', '(++) = id', ''].join(
      '\n',
    );
    assert.deepStrictEqual(chain(text, 'ys = ys').slice(0, 3), [
      'ys',
      '[] ++ ys = ys',
      '(++) : List a -> List a -> List a\n[] ++ ys = ys\n(x :: xs) ++ ys = x :: (xs ++ ys)\n(++) = id',
    ]);
  });

  test('backticked infix clauses', () => {
    const text = ['plus2 : Nat -> Nat -> Nat', 'x `plus2` y = x + y', ''].join('\n');
    assert.deepStrictEqual(chain(text, 'y = x').slice(0, 3), [
      'y',
      'x `plus2` y = x + y',
      'plus2 : Nat -> Nat -> Nat\nx `plus2` y = x + y',
    ]);
  });

  test('clauses of one name without a signature are grouped', () => {
    const text = ['go Z = 0', 'go (S k) = go k', 'main = go 3', ''].join('\n');
    assert.deepStrictEqual(chain(text, 'k)').slice(0, 5), ['k', 'S k', '(S k)', 'go (S k) = go k', 'go Z = 0\ngo (S k) = go k']);
  });

  test('lines inside a closed bracket continue the declaration even in column 0', () => {
    const text = ['foo : (Nat, Nat)', 'foo = (1,', '2)', 'bar : Nat', 'bar = 2', ''].join('\n');
    assert.deepStrictEqual(chain(text, '2)').slice(0, 5), ['2', '1,\n2', '(1,\n2)', 'foo = (1,\n2)', 'foo : (Nat, Nat)\nfoo = (1,\n2)']);
  });

  test('the lines of a multi-line string are not layout items, whatever they contain', () => {
    const text = ['s : String', 's = """', '  first (', 'x = 1', '  """', 't : Nat', 't = 1', ''].join('\n');
    const literal = '"""\n  first (\nx = 1\n  """';
    assert.deepStrictEqual(chain(text, 'first'), [
      '  first (\nx = 1\n  ',
      literal,
      `s = ${literal}`,
      `s : String\ns = ${literal}`,
      text,
    ]);
    assert.deepStrictEqual(chain(text, '1', 2), ['1', 't = 1', 't : Nat\nt = 1', text]);
  });

  test('an unclosed bracket does not swallow the following declarations', () => {
    const text = ['foo = (1', 'bar = 2', ''].join('\n');
    assert.deepStrictEqual(chain(text, '2'), ['2', 'bar = 2', text]);
  });

  test('inside a comment: the comment, then the enclosing blocks', () => {
    const text = ['f : Nat', 'f = 1 {- note -}', ''].join('\n');
    assert.deepStrictEqual(chain(text, 'note'), ['{- note -}', 'f = 1 {- note -}', 'f : Nat\nf = 1 {- note -}', text]);
  });

  test('on a blank line only the document is selected', () => {
    const model = buildSyntaxModel(vlen, undefined);
    const ranges = selectionRangesAt(model, vlen.indexOf('\n\nimport') + 1);
    assert.deepStrictEqual(ranges, [{ start: 0, end: vlen.length }]);
  });

  test('the model reads plain source and bird tracks only; the fenced styles wait for M12', () => {
    const styles: (LiterateStyle | undefined)[] = [undefined, 'bird', 'cmark', 'org', 'tex', 'typst'];
    assert.deepStrictEqual(
      styles.map((style) => isModelledStyle(style)),
      [true, true, false, false, false, false],
    );
  });

  test('an empty text yields the whole (empty) document, never an empty chain', () => {
    // VS Code 1.139.1's extension-host adapter reads `.range` of the first returned range
    // without a null check, so an empty chain would make Expand Selection throw.
    for (const literate of [undefined, 'bird'] as const) {
      assert.deepStrictEqual(selectionRangesAt(buildSyntaxModel('', literate), 0), [{ start: 0, end: 0 }]);
    }
  });

  test('in a whitespace-only text every offset selects the whole document', () => {
    const text = '  \n\t\n';
    const model = buildSyntaxModel(text, undefined);
    for (let offset = 0; offset <= text.length; offset++) {
      assert.deepStrictEqual(selectionRangesAt(model, offset), [{ start: 0, end: text.length }]);
    }
  });

  test('CRLF line breaks: clauses and groups end before the CR', () => {
    const text = 'f : Nat\r\nf x = 1\r\nf y = 2\r\n';
    assert.deepStrictEqual(chain(text, 'x ='), ['x', 'f x = 1', 'f : Nat\r\nf x = 1\r\nf y = 2', text]);
    const lidr = '> f : Nat\r\n> f x = (1 +\r\n>   2)\r\n';
    assert.deepStrictEqual(chain(lidr, '1 +', 1, 'bird'), [
      '1',
      '1 +\r\n>   2',
      '(1 +\r\n>   2)',
      'f x = (1 +\r\n>   2)',
      'f : Nat\r\n> f x = (1 +\r\n>   2)',
      lidr,
    ]);
  });

  test('bird-track .lidr: markers and prose are not code, columns keep their file offsets', () => {
    const text = ['> module Lit', '', 'Prose (with a bracket.', '', '> f : Nat -> Nat', '> f n = ?f_rhs', ''].join('\n');
    assert.deepStrictEqual(chain(text, 'n =', 1, 'bird'), [
      'n',
      'f n = ?f_rhs',
      'f : Nat -> Nat\n> f n = ?f_rhs',
      text,
    ]);
  });

  test('bird-track .lidr: the text of a multi-line string does not start at the marker', () => {
    const text = '> s : String\n> s = """\n>   abc\n>   """\n';
    assert.deepStrictEqual(chain(text, 'abc', 1, 'bird').slice(0, 2), ['  abc\n>   ', '"""\n>   abc\n>   """']);
  });

  test('bird-track .lidr gives the ranges of the same code in a .idr (grammar fixtures, every offset)', () => {
    // The .idr text with every line behind `> `, and every empty line replaced by a prose line
    // (the compiler reads a prose line as an empty one). Compared: every range but the last
    // (the whole document differs by construction), mapped from .idr to .lidr offsets, where
    // column c of a code line is column c + 2 and column 0 of an empty line is the end of its
    // prose line.
    const prose = 'Prose.';
    const dir = path.join(repositoryRoot(), 'test', 'fixtures', 'grammar');
    const texts = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.idr'))
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));
    texts.push('s : String\ns = """\n  abc\n\n  de \\{show 1}\n  """\n');
    let compared = 0;
    for (const idr of texts) {
      const lines = idr.split('\n');
      const bird = lines.map((l) => (l === '' ? prose : `> ${l}`)).join('\n');
      const toBird: number[] = [];
      let birdLineStart = 0;
      for (const line of lines) {
        if (line === '') {
          toBird.push(birdLineStart + prose.length);
          birdLineStart += prose.length + 1;
        } else {
          for (let c = 0; c <= line.length; c++) {
            toBird.push(birdLineStart + 2 + c);
          }
          birdLineStart += line.length + 3;
        }
      }
      const idrModel = buildSyntaxModel(idr, undefined);
      const birdModel = buildSyntaxModel(bird, 'bird');
      for (let offset = 0; offset <= idr.length; offset++) {
        const expected = selectionRangesAt(idrModel, offset)
          .slice(0, -1)
          .map((r) => ({ start: toBird[r.start], end: toBird[r.end] }));
        const actual = selectionRangesAt(birdModel, toBird[offset]).slice(0, -1);
        assert.deepStrictEqual(actual, expected, `.idr offset ${offset}: ${JSON.stringify(idr.slice(offset, offset + 20))}`);
        compared++;
      }
    }
    assert.ok(compared > 1000, `only ${compared} offsets compared`);
  });

  test('every range contains the previous one and the first contains the offset (all offsets)', () => {
    const texts = [
      vlen,
      'f (x :: xs) = "a\\{g [x, (y)]}b" -- (\n  where\n    g = {- ( -} id\n',
      'foo = (1\nbar = [2,\n3]\n  -- trailing\n',
      's = """\n  a (\nx = 1\n  """ ++ show [1,\n2]\n',
      '> f : Nat\n>x\n> f = (1 +\n>  2)\n',
      ' \n\t\n',
      'f : Nat\r\nf x = (1 +\r\n  2)\r\n  where\r\n    g = 1\r\n',
    ];
    for (const text of texts) {
      const literate = text.startsWith('>') ? 'bird' : undefined;
      const model = buildSyntaxModel(text, literate);
      for (let offset = 0; offset <= text.length; offset++) {
        let last = { start: offset, end: offset };
        const ranges = selectionRangesAt(model, offset);
        assert.ok(ranges.length > 0);
        for (const range of ranges) {
          assert.ok(range.start <= last.start && last.end <= range.end, `offset ${offset} in ${JSON.stringify(text)}`);
          assert.ok(range.start !== last.start || range.end !== last.end);
          last = range;
        }
        assert.deepStrictEqual(last, { start: 0, end: text.length });
      }
    }
  });
});
