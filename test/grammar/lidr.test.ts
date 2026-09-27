/**
 * Grammar tests for bird-style literate Idris 2 (`syntaxes/lidr.tmLanguage.json`, scope
 * `source.idris2.literate`).
 *
 * The line classification follows the compiler's unlit step (src/Parser/Unlit.idr `styleBird`
 * and src/Libraries/Text/Literate.idr), and each case below was also run through
 * `idris2 --check` 0.8.0: a line is code when it starts with `>` or `<` in column 0 followed by
 * the end of the line or by one `isSpace` character; anything else is prose.
 *
 * The embedded Idris 2 tokens come from `source.idris2`, which is developed separately, so the
 * assertions about them only check scope *families* (`comment.block`, `string`, ...) that any
 * Idris 2 grammar assigns, never exact scope names. The snapshots record everything.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  birdTrackDifferences,
  endStateIsRoot,
  hasScope,
  literateEndStateIsBase,
  matchSnapshot,
  repoRoot,
  scopeForFile,
  tokenAt,
  tokenizeFile,
  tokenizeText,
  type Token,
  type TokenizeResult,
} from './harness';

const SCOPE = 'source.idris2.literate';
const EMBEDDED = 'meta.embedded.block.idris2';
const MARKER = 'punctuation.definition.bird-track.lidr';
const PROSE = 'meta.prose.lidr';
/**
 * The language VS Code assigns to the Idris 2 tokens of a code line. package.json maps no
 * embedded language for this grammar, so they stay `lidr`: VS Code picks the Enter rules,
 * snippets and comment settings by the language of the token at the cursor, and mapping
 * `meta.embedded.block.idris2` to `idris2` made the `.idr` Enter rules run on code lines, so
 * the bird-track marker was never continued (test/integration/editor.test.ts).
 */
const CODE_LANGUAGE = 'lidr';
const FIXTURES = path.join(repoRoot, 'test', 'fixtures', 'grammar');

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

/** The 0-based index of the one line of `result` equal to `text`; fails if not exactly one. */
function lineOf(result: TokenizeResult, text: string): number {
  const found = result.lines.flatMap((l, i) => (l.text === text ? [i] : []));
  assert.strictEqual(found.length, 1, `expected exactly one line ${JSON.stringify(text)}, found ${found.length}`);
  return found[0];
}

/** The token covering the first occurrence of `needle` on the line equal to `line`. */
function tokenOf(result: TokenizeResult, line: string, needle: string): Token {
  const n = lineOf(result, line);
  const col = line.indexOf(needle);
  assert.ok(col >= 0, `${JSON.stringify(needle)} is not on line ${JSON.stringify(line)}`);
  return tokenAt(result, n, col);
}

/** Asserts that line `n` is a code line: a marker token, then only embedded Idris 2 tokens. */
function assertCodeLine(result: TokenizeResult, n: number): void {
  const { text, tokens } = result.lines[n];
  assert.ok(tokens.length > 0, `line ${n} ${JSON.stringify(text)} has no tokens`);
  const marker = tokens[0];
  assert.strictEqual(marker.startIndex, 0);
  assert.strictEqual(marker.endIndex, 1, `line ${n}: the marker token is one character`);
  assert.ok(hasScope(marker.scopes, MARKER), `line ${n}: ${marker.scopes.join(' ')}`);
  assert.strictEqual(marker.language, 'lidr', `line ${n}: the marker belongs to the literate document`);
  assert.ok(!hasScope(marker.scopes, EMBEDDED), `line ${n}: the marker is not embedded code`);
  for (const t of tokens.slice(1)) {
    if (t.startIndex === 1 && t.endIndex === 2) {
      // The one whitespace character the compiler strips together with the marker.
      assert.strictEqual(t.language, 'lidr', `line ${n}: the stripped separator is not embedded code`);
      assert.ok(!hasScope(t.scopes, EMBEDDED), `line ${n}: ${t.scopes.join(' ')}`);
    } else {
      assert.ok(t.startIndex >= 2, `line ${n}: token ${JSON.stringify(t.text)} overlaps the prefix`);
      assert.ok(hasScope(t.scopes, EMBEDDED), `line ${n}: ${JSON.stringify(t.text)} ${t.scopes.join(' ')}`);
      assert.strictEqual(t.language, CODE_LANGUAGE, `line ${n}: ${JSON.stringify(t.text)}`);
    }
  }
}

const CODE_LINE = /^[><](?:[ \t\f\v ]|$)/;

/**
 * Asserts that line `n` is prose: one token for the whole line, whose innermost scope is
 * `meta.prose.lidr`. Before the first code line that is its only scope. From the first code line
 * on, the prose line lies inside the embedded Idris 2 block, whose rule stack it leaves as it
 * was (the compiler reads it as an empty line), so its scopes are the embedded block's, then the
 * Idris 2 scopes still open there (one of each family in `open`, outermost first), then
 * `meta.prose.lidr`.
 */
function assertProseLine(result: TokenizeResult, n: number, open: readonly string[] = []): void {
  const { text, tokens } = result.lines[n];
  assert.strictEqual(tokens.length, 1, `line ${n} ${JSON.stringify(text)}: ${JSON.stringify(tokens)}`);
  assert.strictEqual(tokens[0].text, text);
  const afterCode = result.lines.slice(0, n).some((l) => CODE_LINE.test(l.text));
  const scopes = tokens[0].scopes;
  const what = `line ${n} ${JSON.stringify(text)}: ${scopes.join(' ')}`;
  if (!afterCode) {
    assert.deepStrictEqual(scopes, [SCOPE, PROSE], what);
  } else {
    assert.strictEqual(scopes.length, open.length + 3, what);
    assert.deepStrictEqual([scopes[0], scopes[1], scopes[scopes.length - 1]], [SCOPE, EMBEDDED, PROSE], what);
    open.forEach((family, i) => assert.ok(hasScope([scopes[i + 2]], family), what));
  }
  assert.strictEqual(tokens[0].language, 'lidr');
}

suite('Grammar: lidr', () => {
  test('.lidr files select source.idris2.literate', async () => {
    assert.strictEqual(await scopeForFile(fixture('BirdTracks.lidr')), SCOPE);
  });

  suite('snapshots', () => {
    const fixtures = fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.lidr'))
      .sort();

    test('fixtures exist', () => {
      assert.deepStrictEqual(fixtures, ['BirdLayout.lidr', 'BirdMultiline.lidr', 'BirdTracks.lidr']);
    });

    for (const name of fixtures) {
      test(`${name}: snapshot, no invalid scope`, async () => {
        const result = await tokenizeFile(fixture(name));
        matchSnapshot(fixture(name), result);
        const invalid = result.lines.flatMap((l, n) =>
          l.tokens.filter((t) => hasScope(t.scopes, 'invalid')).map((t) => `${n}:${t.startIndex} ${t.text}`),
        );
        assert.deepStrictEqual(invalid, []);
      });
    }
  });

  suite('code on bird-track lines tokenises as in a .idr file', () => {
    // Every line of every .idr fixture, prefixed with "> " (an empty line becomes ">"), must get
    // the scopes it gets in the .idr file. In a .lidr file vscode-textmate's \G anchor is live at
    // the start of every code line, which once made rules anchored to the start of a bracket fire
    // on continuation lines; and a rule ending with zero width there loses that anchor.
    // test/grammar/corpus.test.ts runs the same comparison over the corpora.
    const idrFixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.idr')).sort();
    for (const name of idrFixtures) {
      test(name, async () => {
        assert.deepStrictEqual(await birdTrackDifferences(fs.readFileSync(fixture(name), 'utf8')), []);
      });
    }

    test('an unclosed bracket ends at a declaration keyword that starts the code, as at column 0 in a .idr file', async () => {
      const result = await tokenizeText(SCOPE, '> f = g (h\n>   x\n> export\n> sig : Nat\n');
      const x = tokenOf(result, '>   x', 'x');
      assert.ok(hasScope(x.scopes, 'meta.parens'), x.scopes.join(' '));
      const sig = tokenOf(result, '> sig : Nat', 'sig');
      assert.ok(hasScope(sig.scopes, 'entity.name.function'), sig.scopes.join(' '));
      assert.ok(!hasScope(sig.scopes, 'meta.parens'), sig.scopes.join(' '));
    });

    test('BirdLayout.lidr: a comment reaching the code column inside a data declaration, and what follows it', async () => {
      const result = await tokenizeFile(fixture('BirdLayout.lidr'));
      const comment = tokenOf(result, '> reaches the code column -}', 'reaches');
      assert.ok(hasScope(comment.scopes, 'comment.block'), comment.scopes.join(' '));
      const close = tokenOf(result, '> reaches the code column -}', '-}');
      assert.ok(hasScope(close.scopes, 'comment.block'), close.scopes.join(' '));
      const b = tokenOf(result, '>   | B', 'B');
      assert.ok(hasScope(b.scopes, 'entity.name.function.constructor'), b.scopes.join(' '));
      const u = tokenOf(result, '> data U = C | D', 'U');
      assert.ok(hasScope(u.scopes, 'entity.name.type.data'), u.scopes.join(' '));
      const t = tokenOf(result, '> t : T', 't');
      assert.ok(hasScope(t.scopes, 'entity.name.function'), t.scopes.join(' '));
      assert.ok(!hasScope(t.scopes, 'meta.declaration.data'), t.scopes.join(' '));
    });

    test('BirdLayout.lidr: a continuation line inside a bracket is not the start of the bracket', async () => {
      const result = await tokenizeFile(fixture('BirdLayout.lidr'));
      const y = tokenOf(result, '>             y <- Just 2', 'y');
      assert.ok(!hasScope(y.scopes, 'variable'), y.scopes.join(' '));
      const py = tokenOf(result, '>             py := 2', 'py');
      assert.ok(hasScope(py.scopes, 'variable.other.member'), py.scopes.join(' '));
    });
  });

  suite('line classification (Parser/Unlit.idr, checked with idris2 --check)', () => {
    test('every line of BirdTracks.lidr is code exactly when it starts with a marker and whitespace or nothing', async () => {
      const result = await tokenizeFile(fixture('BirdTracks.lidr'));
      result.lines.forEach((line, n) => {
        if (CODE_LINE.test(line.text)) {
          assertCodeLine(result, n);
        } else if (line.text !== '') {
          assertProseLine(result, n);
        }
      });
    });

    test('> and < both mark code', async () => {
      const result = await tokenizeText(SCOPE, '> a : Nat\n< b : Nat\n');
      assertCodeLine(result, 0);
      assertCodeLine(result, 1);
    });

    test('a marker followed by a non-space character, or not in column 0, is prose', async () => {
      const result = await tokenizeText(SCOPE, '>a : Nat\n  > b : Nat\n<b\n');
      assertProseLine(result, 0);
      assertProseLine(result, 1);
      assertProseLine(result, 2);
    });

    test('a marker alone is an empty code line', async () => {
      const result = await tokenizeText(SCOPE, '>\n');
      assert.strictEqual(result.lines[0].tokens.length, 1);
      assertCodeLine(result, 0);
    });

    // Prelude isSpace: ' ', '\t', '\r', '\n', '\f', '\v', '\xa0'. idris2 --check compiles a
    // '>' line followed by form feed, vertical tab and U+00A0 (a type error on such a line
    // is reported), but ignores the same line written '>x'.
    for (const [label, ch] of [
      ['a space', ' '],
      ['a tab', '\t'],
      ['a form feed', '\f'],
      ['a vertical tab', '\v'],
      ['a no-break space', ' '],
    ]) {
      test(`a marker followed by ${label} starts a code line`, async () => {
        const result = await tokenizeText(SCOPE, `>${ch}x : Nat\n`);
        assertCodeLine(result, 0);
        assert.strictEqual(tokenAt(result, 0, 2).language, CODE_LANGUAGE);
      });
    }

    test('prose may touch code on either side without a blank line', async () => {
      const result = await tokenizeText(SCOPE, 'Before.\n> x : Nat\nAfter.\n');
      assertProseLine(result, 0);
      assertCodeLine(result, 1);
      assertProseLine(result, 2);
      assert.ok(literateEndStateIsBase(result));
    });

    test('prose before the first code line leaves the rule stack at the root', async () => {
      const result = await tokenizeText(SCOPE, 'Only prose.\n\nMore prose.\n');
      assertProseLine(result, 0);
      assertProseLine(result, 2);
      assert.ok(endStateIsRoot(result));
    });

    test('a whitespace-only line is a blank line of the embedded code, not prose', async () => {
      const result = await tokenizeText(SCOPE, '> x : Nat\n\n   \n> x = 1\nProse.\n');
      assert.deepStrictEqual(tokenAt(result, 2, 0).scopes, [SCOPE, EMBEDDED], 'whitespace-only line');
      assertCodeLine(result, 3);
      assertProseLine(result, 4);
      assert.ok(literateEndStateIsBase(result));
    });
  });

  suite('a prose line is an empty line of the unlit text (Literate.idr reduce)', () => {
    // idris2 --check reads a prose line as an empty line, so a construct that is open before it
    // is still open after it. The fixture cases are in BirdMultiline.lidr, which checks.
    test('an open list continues after a prose line, and its "]" closes it', async () => {
      const result = await tokenizeFile(fixture('BirdMultiline.lidr'));
      assertProseLine(result, lineOf(result, 'The second element follows this line.'), ['meta.brackets']);
      const close = tokenOf(result, '>           , 2 ]', ']');
      assert.ok(hasScope(close.scopes, 'punctuation.section.brackets.end'), close.scopes.join(' '));
      assert.ok(!hasScope(close.scopes, 'invalid'), close.scopes.join(' '));
    });

    test('a data declaration continues after a prose line', async () => {
      const result = await tokenizeFile(fixture('BirdMultiline.lidr'));
      assertProseLine(result, lineOf(result, 'The second constructor:'), ['meta.declaration.data']);
      const second = tokenOf(result, '>                  | Second', 'Second');
      assert.ok(hasScope(second.scopes, 'entity.name.function.constructor'), second.scopes.join(' '));
    });

    test('a multi-line string continues after a prose line and ends at its own delimiter', async () => {
      const result = await tokenizeFile(fixture('BirdMultiline.lidr'));
      assertProseLine(result, lineOf(result, 'A remark in the middle of the string.'), ['string.quoted.triple']);
      const violets = tokenOf(result, '>   violets are blue', 'violets');
      assert.ok(hasScope(violets.scopes, 'string.quoted.triple'), violets.scopes.join(' '));
      const closers = result.lines.flatMap((l, i) => (l.text === '>   """' ? [i] : []));
      const end = tokenAt(result, closers[closers.length - 1], 4);
      assert.ok(hasScope(end.scopes, 'punctuation.definition.string.end'), end.scopes.join(' '));
      const after = tokenOf(result, '> afterVerse : Nat', 'afterVerse');
      assert.ok(hasScope(after.scopes, 'entity.name.function'), after.scopes.join(' '));
      assert.ok(!hasScope(after.scopes, 'string'), after.scopes.join(' '));
    });

    test('a block comment continues over a prose line', async () => {
      const result = await tokenizeText(SCOPE, '> {- open\nProse in the comment.\n> still -}\n> x : Nat\n');
      assertProseLine(result, 1, ['comment.block']);
      const still = tokenOf(result, '> still -}', 'still');
      assert.ok(hasScope(still.scopes, 'comment.block'), still.scopes.join(' '));
      const x = tokenOf(result, '> x : Nat', 'x');
      assert.ok(hasScope(x.scopes, 'entity.name.function'), x.scopes.join(' '));
      assert.ok(literateEndStateIsBase(result));
    });

    // Every .idr fixture with a prose line after each code line must tokenise as the same
    // fixture with an empty line in those places. The prose text holds characters that would
    // open, close or end Idris 2 constructs if an Idris 2 rule saw them.
    const PROSE_LINE = 'Prose: data x : where ] ) } -} """ {- -- | = ||| %default';
    const idrFixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.idr')).sort();
    for (const name of idrFixtures) {
      test(`${name} interleaved with prose lines`, async () => {
        assert.deepStrictEqual(await birdTrackDifferences(fs.readFileSync(fixture(name), 'utf8'), PROSE_LINE), []);
      });
    }
  });

  suite('embedded Idris 2 keeps its state across code lines', () => {
    test('a block comment over three code lines', async () => {
      const result = await tokenizeFile(fixture('BirdMultiline.lidr'));
      for (const [line, word] of [
        ['> {- first line of the comment', 'first'],
        ['>    second line', 'second'],
        ['>    third line -}', 'third'],
      ]) {
        const t = tokenOf(result, line, word);
        assert.ok(hasScope(t.scopes, 'comment.block'), `${word}: ${t.scopes.join(' ')}`);
        assert.ok(hasScope(t.scopes, EMBEDDED), `${word}: ${t.scopes.join(' ')}`);
        assert.strictEqual(t.language, CODE_LANGUAGE);
        assertCodeLine(result, lineOf(result, line));
      }
      const after = tokenOf(result, '> answer : Nat', 'answer');
      assert.ok(!hasScope(after.scopes, 'comment'), `after the comment: ${after.scopes.join(' ')}`);
    });

    test('a nested comment continues across an empty line', async () => {
      const result = await tokenizeFile(fixture('BirdMultiline.lidr'));
      const t = tokenOf(result, '>    still in the outer comment -}', 'still');
      assert.ok(hasScope(t.scopes, 'comment.block'), t.scopes.join(' '));
      const after = tokenOf(result, '> small : Nat', 'small');
      assert.ok(!hasScope(after.scopes, 'comment'), `after the comment: ${after.scopes.join(' ')}`);
    });

    test('a multi-line string hides comment syntax on its lines', async () => {
      const result = await tokenizeFile(fixture('BirdMultiline.lidr'));
      for (const [line, word] of [
        ['>   roses are red {- not a comment -}', 'not'],
        ['>   "quoted" -- not a comment either', 'either'],
      ]) {
        const t = tokenOf(result, line, word);
        assert.ok(hasScope(t.scopes, 'string'), `${word}: ${t.scopes.join(' ')}`);
        assert.ok(!hasScope(t.scopes, 'comment'), `${word}: ${t.scopes.join(' ')}`);
        assertCodeLine(result, lineOf(result, line));
      }
      const after = tokenOf(result, '> after : Nat', 'after');
      assert.ok(!hasScope(after.scopes, 'string'), `after the string: ${after.scopes.join(' ')}`);
    });

    test('code on a bird-track line is tokenised by source.idris2', async () => {
      const result = await tokenizeFile(fixture('BirdTracks.lidr'));
      const comment = tokenOf(result, '> double n = n + n -- a line comment', 'a line comment');
      assert.ok(hasScope(comment.scopes, 'comment.line'), comment.scopes.join(' '));
      const doc = tokenOf(result, '> ||| Doubles a number.', 'Doubles');
      assert.ok(hasScope(doc.scopes, 'comment'), doc.scopes.join(' '));
    });
  });
});
