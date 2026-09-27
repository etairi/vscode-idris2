import * as assert from 'assert';
import {
  fromCli,
  fromCliSpan,
  fromIdeReply,
  fromIdeReplySpan,
  toIdeCaseSplitRequest,
  toIdeLineRequest,
  toIdeTypeOfRequest,
  type PositionDocument,
} from '../../src/core/positions';

/** A saved document; its language mode follows the file name unless `languageId` is given. */
function doc(fileName: string, lines: string[], languageId?: string, isUntitled = false): PositionDocument {
  return {
    fileName,
    isUntitled,
    languageId: languageId ?? (fileName.endsWith('.lidr') ? 'lidr' : 'idris2'),
    lineCount: lines.length,
    lineAt: (line) => ({ text: lines[line] }),
  };
}

// F2 / F30 fixture `Clean.idr`: `vlen xs = ?vlen_rhs` is line 8 (1-based); `xs` sits at 0-based
// columns 5–6 and `?vlen_rhs` at 10–18.
const clean = doc('/w/Clean.idr', [
  'module Clean',
  '',
  'import Data.Vect',
  '',
  'append : Vect n a -> Vect m a -> Vect (n + m) a',
  '',
  'vlen : Vect n a -> Nat',
  'vlen xs = ?vlen_rhs',
]);

// F11 fixture: bird tracks with prose in between; `n` of `> f n = ?f_rhs` is at file column 4.
const lit = doc('/w/Lit.lidr', ['> module Lit', '', 'Prose line.', '', '> f : Nat -> Nat', '> f n = ?f_rhs']);

suite('core/positions', () => {
  suite('IDE request :type-of (1-based line, 0-based column, inclusive end)', () => {
    test('F2: xs at 0-based columns 5–6 of line 8 is requested at column 5 (accepted)', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(clean, { line: 7, character: 5 }), { line: 8, column: 5 });
    });

    test('F2: the exclusive end of xs (column 7) is sent as 7, which the compiler accepts (inclusive end)', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(clean, { line: 7, character: 7 }), { line: 8, column: 7 });
    });

    test('F2: the cursor just before xs is sent as column 4, which the compiler rejects', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(clean, { line: 7, character: 4 }), { line: 8, column: 4 });
    });

    test('F2: the line above (0-based 6) is sent as line 7, which the compiler rejects for xs', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(clean, { line: 6, character: 5 }), { line: 7, column: 5 });
    });

    test('F11: in .lidr the column is unlit — n at file column 4 of file line 6 is (:type-of "n" 6 2)', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(lit, { line: 5, character: 4 }), { line: 6, column: 2 });
    });

    test('.lidr: a position inside the bird-track marker is sent as unlit column 0', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(lit, { line: 5, character: 0 }), { line: 6, column: 0 });
      assert.deepStrictEqual(toIdeTypeOfRequest(lit, { line: 5, character: 1 }), { line: 6, column: 0 });
    });

    test('.lidr: a prose line has no Idris code to ask about', () => {
      assert.strictEqual(toIdeTypeOfRequest(lit, { line: 2, character: 3 }), undefined);
    });
  });

  suite('IDE request :case-split (1-based line, 1-based column, inclusive end)', () => {
    // Live on idris2 0.8.0 (see src/core/positions.ts): `:case-split 8 C "xs"` on Clean.idr
    // succeeds for C = 8 and fails for C = 9, i.e. C − 1 is the 0-based column.
    test('xs at 0-based column 5 of line 8 is (:case-split 8 6 "xs")', () => {
      assert.deepStrictEqual(toIdeCaseSplitRequest(clean, { line: 7, character: 5 }), { line: 8, column: 6 });
    });

    test('the exclusive end of `vlen xs` (0-based column 7) is sent as 8, the last accepted column', () => {
      assert.deepStrictEqual(toIdeCaseSplitRequest(clean, { line: 7, character: 7 }), { line: 8, column: 8 });
    });

    test('.lidr: n at file column 4 is unlit column 2, sent as 3; the end of `f n` is sent as 4 (accepted live)', () => {
      assert.deepStrictEqual(toIdeCaseSplitRequest(lit, { line: 5, character: 4 }), { line: 6, column: 3 });
      assert.deepStrictEqual(toIdeCaseSplitRequest(lit, { line: 5, character: 5 }), { line: 6, column: 4 });
    });

    test('.lidr: inside the marker the column is 1, never 0 (0 means "anywhere on the line")', () => {
      assert.deepStrictEqual(toIdeCaseSplitRequest(lit, { line: 5, character: 0 }), { line: 6, column: 1 });
    });

    test('.lidr: a prose line has no Idris code to split', () => {
      assert.strictEqual(toIdeCaseSplitRequest(lit, { line: 2, character: 0 }), undefined);
    });
  });

  suite('IDE requests that take a line only', () => {
    test('F30: `append` declared on line 5 (0-based 4) is (:generate-def 5 "append")', () => {
      assert.strictEqual(toIdeLineRequest(4), 5);
    });

    test('F11: lines stay file lines in .lidr — `> f n = ?f_rhs` is line 6', () => {
      assert.strictEqual(toIdeLineRequest(5), 6);
    });
  });

  suite('IDE replies (0-based, end exclusive)', () => {
    test('F2: (:name-at "vlen_rhs") → (:start 7 10) (:end 7 19) is ?vlen_rhs on line 7, columns 10–19', () => {
      assert.deepStrictEqual(
        fromIdeReplySpan(clean, { start: { line: 7, column: 10 }, end: { line: 7, column: 19 } }),
        { start: { line: 7, character: 10 }, end: { line: 7, character: 19 } },
      );
      assert.strictEqual(clean.lineAt(7).text.slice(10, 19), '?vlen_rhs');
    });

    test('F6: the :warning span (2 0) (2 14) is line 2, columns 0–14', () => {
      assert.deepStrictEqual(
        fromIdeReplySpan(doc('/w/Part.idr', ['', '', 'x'.repeat(20)]), { start: { line: 2, column: 0 }, end: { line: 2, column: 14 } }),
        { start: { line: 2, character: 0 }, end: { line: 2, character: 14 } },
      );
    });

    test('F11: `> module Lit` reports `module` at (0 0)–(0 6), file columns 2–8', () => {
      const range = fromIdeReplySpan(lit, { start: { line: 0, column: 0 }, end: { line: 0, column: 6 } });
      assert.deepStrictEqual(range, { start: { line: 0, character: 2 }, end: { line: 0, character: 8 } });
      assert.strictEqual(lit.lineAt(0).text.slice(2, 8), 'module');
    });

    test('F11: an error under `> g = "x"` reported at (5 4)–(5 7) is file columns 6–9 of line 5', () => {
      const errLit = doc('/w/Err.lidr', ['> module Err', '', 'Some prose.', '', '> g : Nat', '> g = "x"']);
      const range = fromIdeReplySpan(errLit, { start: { line: 5, column: 4 }, end: { line: 5, column: 7 } });
      assert.deepStrictEqual(range, { start: { line: 5, character: 6 }, end: { line: 5, character: 9 } });
      assert.strictEqual(errLit.lineAt(5).text.slice(6, 9), '"x"');
    });

    test('.idr replies are not shifted, whatever the line starts with', () => {
      const plain = doc('/w/Plain.idr', ['> not a bird track in .idr']);
      assert.deepStrictEqual(fromIdeReply(plain, { line: 0, column: 3 }), { line: 0, character: 3 });
    });

    test('the file name decides, as `isLitFile` does, not the language mode', () => {
      const lines = ['> module Err', '', 'Some prose.', '', '> g : Nat', '> g = "x"'];
      // A saved .lidr switched to the idris2 mode is still unlit by the compiler: column 4 is file column 6.
      assert.deepStrictEqual(fromIdeReply(doc('/w/Err.lidr', lines, 'idris2'), { line: 5, column: 4 }), { line: 5, character: 6 });
      // A .idr in the lidr mode is compiled as plain source: no offset.
      assert.deepStrictEqual(fromIdeReply(doc('/w/Err.idr', lines, 'lidr'), { line: 5, column: 4 }), { line: 5, character: 4 });
      // The suffix test is case-sensitive (`isSuffixOf`).
      assert.deepStrictEqual(fromIdeReply(doc('/w/Err.LIDR', lines, 'lidr'), { line: 5, column: 4 }), { line: 5, character: 4 });
      // A document never saved has no file name for the compiler: its language mode decides.
      assert.deepStrictEqual(fromIdeReply(doc('Untitled-1', lines, 'lidr', true), { line: 5, column: 4 }), { line: 5, character: 6 });
      assert.deepStrictEqual(fromIdeReply(doc('Untitled-2', lines, 'idris2', true), { line: 5, column: 4 }), { line: 5, character: 4 });
    });

    test('a reply beyond the end of a (stale) document keeps its numbers', () => {
      assert.deepStrictEqual(fromIdeReply(lit, { line: 40, column: 3 }), { line: 40, character: 3 });
    });
  });

  suite('CLI text Mod:L:C--L:C (1-based, end exclusive)', () => {
    test('F6: Part:3:1--3:15 is the same range as the :warning span (2 0) (2 14)', () => {
      const part = doc('/w/Part.idr', ['', '', 'x'.repeat(20)]);
      assert.deepStrictEqual(fromCliSpan(part, { start: { line: 3, column: 1 }, end: { line: 3, column: 15 } }), {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 14 },
      });
    });

    // idris2 0.8.0 --check, this repository's M0 session: CLI columns in .lidr are unlit too.
    test('.lidr: Err:6:5--6:8 under `> g = "x"` is file columns 6–9 of line 5', () => {
      const errLit = doc('/w/Err.lidr', ['> module Err', '', 'Some prose.', '', '> g : Nat', '> g = "x"']);
      assert.deepStrictEqual(fromCliSpan(errLit, { start: { line: 6, column: 5 }, end: { line: 6, column: 8 } }), {
        start: { line: 5, character: 6 },
        end: { line: 5, character: 9 },
      });
    });

    test('.lidr: a tab after the marker is stripped like a space — Tab2:4:5--4:8 under `>\\tg = "x"`', () => {
      const tab = doc('/w/Tab2.lidr', ['> module Tab2', '', '>\tg : Nat', '>\tg = "x"']);
      const range = fromCliSpan(tab, { start: { line: 4, column: 5 }, end: { line: 4, column: 8 } });
      assert.deepStrictEqual(range, { start: { line: 3, character: 6 }, end: { line: 3, character: 9 } });
      assert.strictEqual(tab.lineAt(3).text.slice(6, 9), '"x"');
    });

    test('.lidr: only one space after the marker is stripped — Sp3:4:7--4:10 under `>   g = "x"`', () => {
      const spaces = doc('/w/Sp3.lidr', ['> module Sp3', '', '>   g : Nat', '>   g = "x"']);
      const range = fromCliSpan(spaces, { start: { line: 4, column: 7 }, end: { line: 4, column: 10 } });
      assert.deepStrictEqual(range, { start: { line: 3, character: 8 }, end: { line: 3, character: 11 } });
      assert.strictEqual(spaces.lineAt(3).text.slice(8, 11), '"x"');
    });

    test('a single CLI point', () => {
      assert.deepStrictEqual(fromCli(clean, { line: 8, column: 11 }), { line: 7, character: 10 });
    });
  });
});
