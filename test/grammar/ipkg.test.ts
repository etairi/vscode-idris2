/**
 * Grammar tests for Idris 2 package descriptions (`syntaxes/ipkg.tmLanguage.json`, scope
 * `source.ipkg`).
 *
 * Token rules follow the compiler's package lexer and parser (src/Parser/Lexer/Package.idr,
 * src/Parser/Lexer/Common.idr, src/Parser/Rule/Package.idr, src/Idris/Package.idr). The
 * fixtures pass `idris2 --dump-ipkg-json` 0.8.0; inline cases that 0.8.0 rejects say so.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  hasScope,
  matchSnapshot,
  repoRoot,
  scopeForFile,
  tokenAt,
  tokenizeFile,
  tokenizeText,
  type Token,
  type TokenizeResult,
} from './harness';

const SCOPE = 'source.ipkg';
const FIXTURES = path.join(repoRoot, 'test', 'fixtures', 'grammar');
const KNOWN_KEY = 'support.type.property-name.ipkg';
const UNKNOWN_KEY = 'variable.other.property.ipkg';
const LINE_COMMENT = 'comment.line.double-dash.ipkg';
const BLOCK_COMMENT = 'comment.block.ipkg';
const STRING = 'string.quoted.double.ipkg';

/**
 * Every field the parser accepts (`field` in src/Idris/Package.idr on master 1c630e6; ROADMAP
 * F23). `datadir` is master-only: 0.8.0 answers `Unrecognised property "datadir"`.
 */
const FIELDS = [
  'version', 'langversion', 'authors', 'maintainers', 'license', 'brief', 'readme', 'homepage',
  'sourceloc', 'bugtracker', 'depends', 'modules', 'main', 'executable', 'opts', 'options',
  'sourcedir', 'datadir', 'builddir', 'outputdir', 'prebuild', 'postbuild', 'preinstall',
  'postinstall', 'preclean', 'postclean',
];

/** The token covering the first occurrence of `needle` on 0-based `line`. */
function tokenOf(result: TokenizeResult, line: number, needle: string): Token {
  const text = result.lines[line].text;
  const col = text.indexOf(needle);
  assert.ok(col >= 0, `${JSON.stringify(needle)} is not on line ${line} ${JSON.stringify(text)}`);
  return tokenAt(result, line, col);
}

function scopesOf(result: TokenizeResult, line: number, needle: string): readonly string[] {
  return tokenOf(result, line, needle).scopes;
}

/** Asserts that the first `needle` on `line` is one whole token carrying `scope`. */
function assertToken(result: TokenizeResult, line: number, needle: string, scope: string): void {
  const t = tokenOf(result, line, needle);
  assert.strictEqual(t.text, needle, `line ${line}: token ${JSON.stringify(t.text)} instead of ${JSON.stringify(needle)}`);
  assert.ok(hasScope(t.scopes, scope), `line ${line} ${JSON.stringify(needle)}: ${t.scopes.join(' ')}`);
}

function assertNoScope(scopes: readonly string[], prefix: string, what: string): void {
  assert.ok(!hasScope(scopes, prefix), `${what}: unexpected ${prefix} in ${scopes.join(' ')}`);
}

const ipkg = (text: string): Promise<TokenizeResult> => tokenizeText(SCOPE, text);

suite('Grammar: ipkg', () => {
  test('.ipkg files select source.ipkg', async () => {
    assert.strictEqual(await scopeForFile(path.join(FIXTURES, 'Lexical.ipkg')), SCOPE);
  });

  suite('snapshots', () => {
    const fixtures = fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.ipkg'))
      .sort();

    test('fixtures exist', () => {
      assert.deepStrictEqual(fixtures, ['Handwritten.ipkg', 'InitTemplate.ipkg', 'Lexical.ipkg']);
    });

    for (const name of fixtures) {
      test(name, async () => {
        matchSnapshot(path.join(FIXTURES, name), await tokenizeFile(path.join(FIXTURES, name)));
      });
    }
  });

  suite('header and fields', () => {
    test('package header', async () => {
      const r = await ipkg('package my-pkg_2\n');
      assertToken(r, 0, 'package', 'keyword.other.package.ipkg');
      assertToken(r, 0, 'my-pkg_2', 'entity.name.type.package.ipkg');
    });

    test('identifiers may use code points above U+00A0 (Common.isIdentStart: x > chr 160)', async () => {
      const r = await ipkg('package αβ\ndepends = ℕat, x-ℕ\n');
      assertToken(r, 0, 'αβ', 'entity.name.type.package.ipkg');
      assertToken(r, 1, 'ℕat', 'entity.name.type.package.ipkg');
      assertToken(r, 1, 'x-ℕ', 'entity.name.type.package.ipkg');
    });

    test('a capitalised name with a dash is one token (master lexer; 0.8.0 stops at the dash)', async () => {
      // Master tries `identAllowDashes <+> reject dot` before `namespacedIdent`; 0.8.0 tries
      // `namespacedIdent` first, so `depends = Ab-c` fails there with "Can't recognise token".
      const r = await ipkg('package p\ndepends = Ab-c\n');
      assertToken(r, 1, 'Ab-c', 'entity.name.type.package.ipkg');
    });

    test('a name starting with an upper-case letter, "_" or a character above U+00A0 ends before a "--" comment (0.8.0)', async () => {
      // idris2 --dump-ipkg-json 0.8.0 (with stub modules Foo, Bar.Baz and Main) reads this as
      // package "Foo", depends "Base", "_base" and "ℕat", modules "Foo" and "Bar.Baz", main
      // "Main", executable "Run": namespacedIdent is tried first and takes no dash. Master would
      // read "Foo--note" etc. as one name.
      const r = await ipkg(
        'package Foo--note\ndepends = Base--x\n  , _base--y\n  , ℕat--z\n' +
          'modules = Foo--c\n  , Bar.Baz--d\nmain = Main--e\nexecutable = Run--f\n',
      );
      const names: [number, string, string][] = [
        [0, 'Foo', 'entity.name.type.package.ipkg'],
        [1, 'Base', 'entity.name.type.package.ipkg'],
        [2, '_base', 'entity.name.type.package.ipkg'],
        [3, 'ℕat', 'entity.name.type.package.ipkg'],
        [4, 'Foo', 'entity.name.namespace.ipkg'],
        [5, 'Bar.Baz', 'entity.name.namespace.ipkg'],
        [6, 'Main', 'entity.name.namespace.ipkg'],
        [7, 'Run', 'string.unquoted.executable.ipkg'],
      ];
      for (const [line, name, scope] of names) {
        assertToken(r, line, name, scope);
        assert.ok(hasScope(scopesOf(r, line, '--'), LINE_COMMENT), `line ${line}: ${scopesOf(r, line, '--').join(' ')}`);
      }
    });

    test('a lower-case name keeps its dashes, "--" included (identAllowDashes on both compilers)', async () => {
      // idris2 --dump-ipkg-json 0.8.0: package "my-pkg--weird", depends "my-dep--x".
      const r = await ipkg('package my-pkg--weird\ndepends = base, my-dep--x\n');
      assertToken(r, 0, 'my-pkg--weird', 'entity.name.type.package.ipkg');
      assertToken(r, 1, 'my-dep--x', 'entity.name.type.package.ipkg');
      assertNoScope(scopesOf(r, 1, 'my-dep--x'), 'comment', 'my-dep--x');
    });

    test('the package name may follow on a later line, after a comment', async () => {
      const r = await ipkg('package -- the name:\n  tally\nversion = 1.0\n');
      assertToken(r, 1, 'tally', 'entity.name.type.package.ipkg');
      assertToken(r, 2, 'version', KNOWN_KEY);
    });

    for (const field of FIELDS) {
      test(`field ${field}`, async () => {
        // langversion takes bounds with no '=' (`langversion = 0.5` is "Expected end of file").
        const value = field === 'langversion' ? '>= 0.5' : '= "x"';
        const r = await ipkg(`package p\n${field} ${value}\n`);
        assertToken(r, 1, field, KNOWN_KEY);
        assert.ok(hasScope(scopesOf(r, 1, field), 'meta.field.ipkg'));
      });
    }

    test('a field name is a whole identifier (dashes and primes continue it)', async () => {
      const r = await ipkg('package p\nversion-x = "a"\nmain\' = "b"\n');
      assertToken(r, 1, 'version-x', UNKNOWN_KEY);
      assertToken(r, 2, "main'", UNKNOWN_KEY);
    });

    test('an unknown field is a key, not an error (the compiler says "Unrecognised property")', async () => {
      const r = await ipkg('package p\npkgs = base, contrib\nversion = 1.0\n');
      assertToken(r, 1, 'pkgs', UNKNOWN_KEY);
      assertToken(r, 1, '=', 'punctuation.separator.key-value.ipkg');
      assertToken(r, 1, ',', 'punctuation.separator.comma.ipkg');
      for (const t of r.lines[1].tokens) {
        assertNoScope(t.scopes, 'invalid', JSON.stringify(t.text));
      }
      assertToken(r, 2, 'version', KNOWN_KEY);
    });

    test('several fields on one line (the lexer ignores layout)', async () => {
      const r = await ipkg('package q version = 1.0 modules = A, B.C main = D\n');
      assertToken(r, 0, 'q', 'entity.name.type.package.ipkg');
      assertToken(r, 0, 'version', KNOWN_KEY);
      assertToken(r, 0, '1.0', 'constant.numeric.version.ipkg');
      assertToken(r, 0, 'modules', KNOWN_KEY);
      assertToken(r, 0, 'B.C', 'entity.name.namespace.ipkg');
      assertToken(r, 0, 'main', KNOWN_KEY);
      assertToken(r, 0, 'D', 'entity.name.namespace.ipkg');
    });

    test('a field name used as a value does not start a field', async () => {
      const r = await ipkg('package p\nexecutable = main\nmain = Main\n');
      assertToken(r, 1, 'main', 'string.unquoted.executable.ipkg');
      assertToken(r, 2, 'main', KNOWN_KEY);
    });

    test('a key alone on its line, with "=" and the values on the following lines', async () => {
      const r = await ipkg('package p\nmodules\n  =\n    -- note\n    A.B,\n    C\nbrief\n  = "x"\n');
      assertToken(r, 1, 'modules', KNOWN_KEY);
      assertToken(r, 2, '=', 'punctuation.separator.key-value.ipkg');
      assert.ok(hasScope(scopesOf(r, 3, 'note'), LINE_COMMENT));
      assertToken(r, 4, 'A.B', 'entity.name.namespace.ipkg');
      assertToken(r, 5, 'C', 'entity.name.namespace.ipkg');
      assertToken(r, 6, 'brief', KNOWN_KEY);
      assertToken(r, 7, '"', 'punctuation.definition.string.begin.ipkg');
    });

    test('after a comma that ends its line, a value spelled like a field name is a value', async () => {
      // sepBy needs a value after the separator: idris2 --dump-ipkg-json 0.8.0 (next to stub
      // modules Foo, main and version) reads this file's modules as Foo, main and version, and
      // its depends as base and contrib.
      const r = await ipkg(
        'package p1\nmodules = Foo,\n          main, -- note\n\n          version\ndepends = base,\n          contrib\nexecutable = p1\n',
      );
      assertToken(r, 2, 'main', 'entity.name.namespace.ipkg');
      assertToken(r, 2, ',', 'punctuation.separator.comma.ipkg');
      assert.ok(hasScope(scopesOf(r, 2, 'note'), LINE_COMMENT));
      assertToken(r, 4, 'version', 'entity.name.namespace.ipkg');
      assertNoScope(scopesOf(r, 4, 'version'), KNOWN_KEY, 'version');
      assertToken(r, 5, 'depends', KNOWN_KEY);
      assertToken(r, 6, 'contrib', 'entity.name.type.package.ipkg');
      assertToken(r, 7, 'executable', KNOWN_KEY);
      // A name followed by "=" after a trailing comma (a new field typed after it) stays a key.
      const typing = await ipkg('package p\nmodules = A,\nmain = A\n');
      assertToken(typing, 2, 'main', KNOWN_KEY);
      assertToken(typing, 2, 'A', 'entity.name.namespace.ipkg');
    });
  });

  suite('values', () => {
    test('version numbers and the deprecated string form', async () => {
      const r = await ipkg('package p\nversion = 0.12.3\nversion = "0.1"\n');
      assertToken(r, 1, '0.12.3', 'constant.numeric.version.ipkg');
      assert.ok(hasScope(scopesOf(r, 2, '0.1'), STRING));
    });

    test('langversion and depends bounds', async () => {
      const r = await ipkg(
        'package p\nlangversion >= 0.5.1 && < 1.0\ndepends = base >= 0.5 && <= 1.0, contrib == 0.8.0\n  , network > 1\n',
      );
      assertToken(r, 1, '>=', 'keyword.operator.comparison.ipkg');
      assertToken(r, 1, '&&', 'keyword.operator.logical.ipkg');
      assertToken(r, 1, '<', 'keyword.operator.comparison.ipkg');
      assertToken(r, 1, '0.5.1', 'constant.numeric.version.ipkg');
      assertToken(r, 1, '1.0', 'constant.numeric.version.ipkg');
      assertToken(r, 2, 'base', 'entity.name.type.package.ipkg');
      assertToken(r, 2, '<=', 'keyword.operator.comparison.ipkg');
      assertToken(r, 2, 'contrib', 'entity.name.type.package.ipkg');
      assertToken(r, 2, '==', 'keyword.operator.comparison.ipkg');
      assertToken(r, 2, ',', 'punctuation.separator.comma.ipkg');
      assertToken(r, 3, ',', 'punctuation.separator.comma.ipkg');
      assertToken(r, 3, 'network', 'entity.name.type.package.ipkg');
      assertToken(r, 3, '>', 'keyword.operator.comparison.ipkg');
    });

    test('module names: namespaced, lower-case last component, dashed single identifier', async () => {
      const r = await ipkg('package p\nmodules = Data.List.Extra, Data.List.lower, Main,foo-bar\n');
      for (const name of ['Data.List.Extra', 'Data.List.lower', 'Main', 'foo-bar']) {
        assertToken(r, 1, name, 'entity.name.namespace.ipkg');
      }
    });

    test('executable as a string or as a bare name', async () => {
      const r = await ipkg('package p\nexecutable = "my exe"\nexecutable = my-exe\n');
      assert.ok(hasScope(scopesOf(r, 1, 'my exe'), STRING));
      assertToken(r, 2, 'my-exe', 'string.unquoted.executable.ipkg');
    });

    test('strings: a backslash keeps the next character in the string and is not an escape', async () => {
      // stripQuotes only drops the quotes: `brief = "p\\q"` dumps as `p\\q` (two backslashes).
      const r = await ipkg('package p\nbrief = "a \\" -- b" -- c\n');
      const inside = scopesOf(r, 1, '-- b');
      assert.ok(hasScope(inside, STRING), inside.join(' '));
      assertNoScope(inside, 'comment', '-- b');
      assertNoScope(scopesOf(r, 1, '\\'), 'constant.character.escape', 'backslash');
      assert.ok(hasScope(scopesOf(r, 1, '-- c'), LINE_COMMENT));
    });

    test('strings may span lines', async () => {
      const r = await ipkg('package p\nbrief = "one\ntwo"\nversion = 1.0\n');
      assert.ok(hasScope(scopesOf(r, 2, 'two'), STRING));
      assertToken(r, 3, 'version', KNOWN_KEY);
    });
  });

  suite('comments (Parser/Lexer/Common.idr, checked with idris2 --dump-ipkg-json)', () => {
    test('line comments: two or more dashes, but not "--}"', async () => {
      const r = await ipkg('package p -- a\n--- b\n--}\n');
      assertToken(r, 0, '--', 'punctuation.definition.comment.ipkg');
      assert.ok(hasScope(scopesOf(r, 1, 'b'), LINE_COMMENT));
      // "--}" is not a comment; the compiler stops with "Can't recognise token".
      assertNoScope(scopesOf(r, 2, '--}'), 'comment', '--}');
    });

    test('block comments nest', async () => {
      const r = await ipkg('{- a {- b -} c -}\npackage p\n');
      assert.ok(hasScope(scopesOf(r, 0, 'c'), BLOCK_COMMENT));
      assertToken(r, 1, 'package', 'keyword.other.package.ipkg');
    });

    test('inside a block comment a string, a character literal or a line comment hides "-}"', async () => {
      const r = await ipkg('{- "-}" x -}\n{- \'"\' y -}\n{- -- -} z\n w -}\npackage p\n');
      assert.ok(hasScope(scopesOf(r, 0, 'x'), BLOCK_COMMENT));
      assert.ok(hasScope(scopesOf(r, 1, 'y'), BLOCK_COMMENT));
      assert.ok(hasScope(scopesOf(r, 2, 'z'), BLOCK_COMMENT));
      assert.ok(hasScope(scopesOf(r, 3, 'w'), BLOCK_COMMENT));
      assertToken(r, 4, 'package', 'keyword.other.package.ipkg');
    });

    test('a top-level "{--}" or "{-}" opens a comment without closing it', async () => {
      const r = await ipkg('{--}\npackage p\n-}\n{-}\nversion = 1.0\n');
      assert.ok(hasScope(scopesOf(r, 1, 'package'), BLOCK_COMMENT));
      assert.ok(hasScope(scopesOf(r, 4, 'version'), BLOCK_COMMENT));
    });

    test('a nested "{--}" opens and closes at once', async () => {
      const r = await ipkg('{- a {--} b -}\npackage p\n');
      assertToken(r, 1, 'package', 'keyword.other.package.ipkg');
    });

    test('comments inside field values', async () => {
      const r = await ipkg('package p\ndepends = base {- pinned -} >= 0.8 -- why\n  , contrib\n');
      assert.ok(hasScope(scopesOf(r, 1, 'pinned'), BLOCK_COMMENT));
      assertToken(r, 1, '>=', 'keyword.operator.comparison.ipkg');
      assert.ok(hasScope(scopesOf(r, 1, 'why'), LINE_COMMENT));
      assertToken(r, 2, 'contrib', 'entity.name.type.package.ipkg');
    });
  });
});
