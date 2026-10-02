// core/untrustedText.ts: how compiler text is shown — the fenced code block no line of the text
// can close (hovers, tooltips), invisible characters written out, QuickPick texts without theme
// icons, and labels drawn inside a line of the editor (inlay hints, evaluation results): one line,
// its control and format characters written out.
import * as assert from 'assert';
import { codeBlock, editorLabel, quickPickText, visible } from '../../src/core/untrustedText';
import { resultLabel } from '../../src/features/eval/evaluation';

/**
 * Whether `line` closes a backtick fence of `length` (CommonMark 0.31.2, 4.5 "Fenced code blocks":
 * up to three spaces of indentation, at least as many backticks as the opening fence, then only
 * spaces or tabs).
 */
function closes(line: string, length: number): boolean {
  const m = /^ {0,3}(`+)[ \t]*$/.exec(line);
  return m !== null && m[1].length >= length;
}

/** The lines CommonMark reads (line endings `\n`, `\r\n`, `\r`). */
const lines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/**
 * The fence of VS Code 1.139.1's `appendCodeblock` (`$6` in the extension host bundle): one longer
 * than the longest run of backticks at the start of a line, at least three.
 */
function vscodeFence(text: string): number {
  const runs = text.match(/^`+/gm) ?? [];
  const longest = runs.reduce((a, r) => Math.max(a, r.length), 0);
  return longest >= 3 ? longest + 1 : 3;
}

const HOSTILE = [
  'x : Nat\n```\n[click](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22pwned%22%7D)',
  '  ```\n# heading **bold** <img src=x onerror=alert(1)>',
  '   ````````\n![image](https://example.org/x.png)',
  'a ` b `` c ``` d ```` e',
  'one\r```\rtwo',
  '```',
  '',
];

suite('core/untrustedText', () => {
  suite('codeBlock', () => {
    test('no line of the text closes the fence, whatever backticks it holds', () => {
      for (const text of HOSTILE) {
        const block = codeBlock(text, 'idris2');
        const [first, ...rest] = lines(block.replace(/^\n/, ''));
        const fence = /^(`+)idris2$/.exec(first);
        assert.ok(fence !== null, `opening fence of ${JSON.stringify(text)}`);
        const length = fence[1].length;
        const inner = rest.slice(0, -2);
        assert.strictEqual(inner.join('\n'), lines(text).join('\n'), 'the text is inside, verbatim');
        assert.ok(!inner.some((l) => closes(l, length)), `a line of ${JSON.stringify(text)} closes the fence`);
        assert.ok(closes(rest[rest.length - 2], length), 'the block is closed by its own fence');
        assert.strictEqual(rest[rest.length - 1], '', 'and ends with a line break');
      }
    });

    test('the fence is one longer than the longest run of backticks anywhere, at least three', () => {
      assert.ok(codeBlock('x', 'idris2').startsWith('\n```idris2\n'));
      assert.ok(codeBlock('a ```` b', 'idris2').startsWith('\n`````idris2\n'));
      assert.ok(codeBlock('`', 'idris2').startsWith('\n```idris2\n'));
    });

    test('any number of runs: 200,000 separate runs (a 400 KB value) get a fence longer than the longest', () => {
      // One argument per run spread into Math.max threw RangeError from about 125,000 runs (Node 24.13).
      const text = `${'`a'.repeat(200_000)}\`\`\`\`b`;
      const block = codeBlock(text, 'idris2');
      assert.ok(block.startsWith('\n`````idris2\n'), block.slice(0, 20));
      assert.ok(block.endsWith('\n`````\n'));
    });

    test("VS Code's own appendCodeblock would let an indented fence out (why it is not used)", () => {
      const text = 'x : Nat\n  ```\n[link](command:x)';
      assert.ok(lines(text).some((l) => closes(l, vscodeFence(text))), 'appendCodeblock sizes its fence by runs at the start of a line only');
      const block = codeBlock(text, 'idris2');
      const length = (/^\n(`+)/.exec(block) as RegExpExecArray)[1].length;
      assert.ok(!lines(text).some((l) => closes(l, length)));
    });
  });

  test('visible writes out control and format characters (bidi controls, zero-width), keeping line feeds', () => {
    assert.strictEqual(visible('a\u202Eb\u200Bc\td\ne\u0000'), 'a\\u{202E}b\\u{200B}c\\u{9}d\ne\\u{0}');
    assert.strictEqual(visible('x₁ : ℕ -> 𝕟'), 'x₁ : ℕ -> 𝕟', 'other characters are kept');
  });

  test('quickPickText breaks every $( so that no theme icon is drawn, and keeps other text', () => {
    assert.strictEqual(quickPickText('$(alert) x $(y)'), '$\u200b(alert) x $\u200b(y)');
    assert.strictEqual(quickPickText('a $ (b) $$( c'), 'a $ (b) $$\u200b( c');
    assert.strictEqual(quickPickText('Vect n a -> Nat'), 'Vect n a -> Nat');
    assert.ok(!/\$\(/.test(quickPickText('$($($(')));
  });

  suite('editor labels', () => {
    test('one line: a line break with the indentation around it is one space; other spaces are kept (they may be a string\'s)', () => {
      assert.strictEqual(editorLabel('Vect n a ->\n    Vect m a'), 'Vect n a -> Vect m a');
      assert.strictEqual(editorLabel('a \r\n\tb\rc\u2028d\u0085e'), 'a b c d e');
      assert.strictEqual(editorLabel('"a   b"'), '"a   b"');
      assert.strictEqual(editorLabel('  x  \n'), 'x');
    });

    test('control and format characters are written out, so that they cannot reorder or hide text', () => {
      assert.strictEqual(editorLabel('"\u202Eabc\u202C"'), '"\\u{202E}abc\\u{202C}"');
      assert.strictEqual(editorLabel('a\u2066b\u2069c\u200Ed\u061C'), 'a\\u{2066}b\\u{2069}c\\u{200E}d\\u{61C}');
      assert.strictEqual(editorLabel('a\u200Bb\uFEFFc\u00ADd'), 'a\\u{200B}b\\u{FEFF}c\\u{AD}d');
      assert.strictEqual(editorLabel('a\u0000b\tc\u001Bd\u007Fe\u0080'), 'a\\u{0}b\\u{9}c\\u{1B}d\\u{7F}e\\u{80}');
      assert.strictEqual(editorLabel('tag\u{E0041}'), 'tag\\u{E0041}');
      // Letters, marks and symbols of any script are shown as they are.
      assert.strictEqual(editorLabel('x₁ : ℕ → 𝕟 é'), 'x₁ : ℕ → 𝕟 é');
    });

    test('the other default-ignorable characters and U+2800 are written out too (drawn as nothing or a blank; second review of M3)', () => {
      // `: N͏a️t` (U+034F, U+FE0F) was drawn as `: Nat`.
      assert.strictEqual(editorLabel('n : N\u034Fa\uFE0Ft'), 'n : N\\u{34F}a\\u{FE0F}t');
      assert.strictEqual(editorLabel('a\u3164b\u115Fc\u1160d\uFFA0e'), 'a\\u{3164}b\\u{115F}c\\u{1160}d\\u{FFA0}e');
      assert.strictEqual(editorLabel('a\u{E0100}b\u180Bc\u17B4d\u2800e'), 'a\\u{E0100}b\\u{180B}c\\u{17B4}d\\u{2800}e');
      assert.strictEqual(visible('N\u034Fa\u{E01EF}t\n\u3164'), 'N\\u{34F}a\\u{E01EF}t\n\\u{3164}');
      // Every assigned character M2's shownPath writes out as invisible is written out here.
      for (let c = 0; c <= 0x10ffff; c++) {
        if ((c >= 0xd800 && c <= 0xdfff) || c === 0x0a) {
          continue;
        }
        const ch = String.fromCodePoint(c);
        if (/\p{Default_Ignorable_Code_Point}/u.test(ch) && !/\p{Cn}/u.test(ch)) {
          assert.notStrictEqual(visible(ch), ch, `U+${c.toString(16)}`);
          assert.notStrictEqual(editorLabel(`a${ch}b`), `a${ch}b`, `U+${c.toString(16)}`);
        }
      }
    });

    test('the format characters that are not default-ignorable are written out too: U+0600–U+0605, U+FFF9–U+FFFB, U+13430… (third review of M3)', () => {
      // Written out only because the class names \p{Cf}: in Node 24.13's Unicode data 32 format
      // characters are not \p{Default_Ignorable_Code_Point}, among them the interlinear annotation
      // characters, which many fonts draw as nothing.
      assert.strictEqual(editorLabel('a\uFFF9b\uFFFBc'), 'a\\u{FFF9}b\\u{FFFB}c');
      assert.strictEqual(visible('\u0600 \u{13430}'), '\\u{600} \\u{13430}');
      let seen = 0;
      for (let c = 0; c <= 0x10ffff; c++) {
        const ch = String.fromCodePoint(c);
        if (/\p{Cf}/u.test(ch) && !/\p{Default_Ignorable_Code_Point}/u.test(ch)) {
          seen++;
          assert.notStrictEqual(visible(ch), ch, `U+${c.toString(16)}`);
          assert.notStrictEqual(editorLabel(`a${ch}b`), `a${ch}b`, `U+${c.toString(16)}`);
        }
      }
      assert.ok(seen >= 32, `${seen} such characters`);
    });

    test('no line terminator and no U+000C reaches a label raw (a decoration\'s contentText becomes a CSS string)', () => {
      // VS Code 1.139.1 writes `content:'<text up to the first line terminator>';`, escaping only
      // ' and \; U+000C is no JavaScript line terminator but ends a CSS string (module comment).
      const hostile = "= a\u000C;}body{display:none}\r\n\u2028\u2029\u0085\v x";
      for (const label of [editorLabel(hostile), resultLabel({ kind: 'value', value: { text: hostile, spans: [] } }), resultLabel({ kind: 'error', message: { text: `x${hostile}`, spans: [] } })]) {
        assert.ok(!/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(label), JSON.stringify(label));
      }
      assert.strictEqual(editorLabel('= a\u000C;}b'), '= a\\u{C};}b');
    });

    test('the same lines as the regular expression it replaced, on every string of up to 6 characters of spaces, tabs, breaks and a letter', () => {
      const before = (text: string): string => text.trim().replace(/[ \t]*(?:\r\n|[\n\r\u0085\u2028\u2029])[ \t]*/g, ' ');
      const alphabet = [' ', '\t', '\n', '\r', '\u2028', 'a'];
      let strings = [''];
      for (let length = 1; length <= 6; length++) {
        strings = strings.flatMap((s) => alphabet.map((c) => s + c));
        for (const text of strings) {
          // `before` leaves no line break, so `editorLabel` only writes out its invisible characters.
          assert.strictEqual(editorLabel(text), editorLabel(before(text)), JSON.stringify(text));
        }
      }
    });

    test('linear: a type holding a string of 200,000 spaces (security review of M4: quadratic, seconds per label)', () => {
      for (const text of [`p : "a${' '.repeat(200_000)}b"`, `x${' \t'.repeat(100_000)}\n y`]) {
        const started = process.hrtime.bigint();
        editorLabel(text, 500);
        editorLabel(text);
        assert.ok(process.hrtime.bigint() - started < 200_000_000n, 'more than 200 ms');
      }
    });

    test('cut at a character boundary with an ellipsis', () => {
      assert.strictEqual(editorLabel('abcdef', 4), 'abc…');
      assert.strictEqual(editorLabel('abcd', 4), 'abcd');
      assert.strictEqual(editorLabel('a𝕟b', 3), 'a…');
      assert.strictEqual(editorLabel('a𝕟b', 4), 'a𝕟b');
    });
  });
});
