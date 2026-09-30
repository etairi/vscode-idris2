import * as assert from 'assert';
import {
  codeLineSpans,
  codePointsBefore,
  displayLine,
  fromCli,
  fromCliSpan,
  fromIdeReply,
  fromIdeReplySpan,
  lineCorrespondence,
  MAX_LINE_EDITS,
  toCompilerColumn,
  toIdeCaseSplitRequest,
  toIdeLineRequest,
  toIdeTypeOfRequest,
  toIdeTypeOfRequestPastStart,
  toLoadedPosition,
  toShownPosition,
  utf16Length,
  type PositionDocument,
} from '../../src/core/positions';

/** A small deterministic PRNG (mulberry32), so that the property test is reproducible. */
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

// The second review of M3's live file L.lidr [live, idris2 0.8.0]: `> ` on file line 6 and `>   `
// on file line 12 (0-based) are two lines each in the compiler's unlit text, `>` alone on line 9
// is one. `(:name-at "g")` answered (8 0)–(8 7) for `g : Nat` on file line 7, `(:name-at "k")`
// (15 0) for file line 13, and `:highlight-source` put `h : Nat` (file line 10) on line 11.
const drift = doc('/w/L.lidr', [
  '> module L',
  '',
  'Some prose.',
  '',
  '> f : Nat',
  '> f = 1',
  '> ',
  '> g : Nat',
  '> g = 2',
  '>',
  '> h : Nat',
  '> h = 3',
  '>   ',
  '> k : Nat',
  '> k = 4',
]);
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
      assert.strictEqual(toIdeLineRequest(clean, 4), 5);
    });

    test('F11: prose lines keep the numbering in .lidr — `> f n = ?f_rhs` is line 6', () => {
      assert.strictEqual(toIdeLineRequest(lit, 5), 6);
    });

    test('F11 addendum: each `> ` or `>   ` line above adds one — `> k : Nat` (file line 13) is line 16', () => {
      assert.strictEqual(toIdeLineRequest(drift, 13), 16);
      assert.strictEqual(toIdeLineRequest(drift, 6), 7, 'the doubled line itself keeps its number');
    });
  });

  test('displayLine: the number VS Code shows for a line (1-based), a file line even below doubled lines', () => {
    assert.strictEqual(displayLine(0), 1);
    assert.strictEqual(displayLine(13), 14);
    assert.strictEqual(toIdeLineRequest(drift, 13), 16, 'not the compiler\'s line');
  });

  suite('F11 addendum: a marker followed only by white space is two lines of the unlit text [live]', () => {
    test('requests: `g` on file line 7 is the compiler\'s line 8 (1-based 9), `h` on 10 its 11, `k` on 13 its 15', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(drift, { line: 7, character: 2 }), { line: 9, column: 0 });
      assert.deepStrictEqual(toIdeTypeOfRequest(drift, { line: 10, character: 2 }), { line: 12, column: 0 });
      assert.deepStrictEqual(toIdeTypeOfRequest(drift, { line: 13, character: 2 }), { line: 16, column: 0 });
      assert.deepStrictEqual(toIdeCaseSplitRequest(drift, { line: 14, character: 2 }), { line: 17, column: 1 });
      assert.deepStrictEqual(toIdeTypeOfRequest(drift, { line: 5, character: 2 }), { line: 6, column: 0 }, 'above the first: unchanged');
    });

    test('replies: (:name-at "g") (8 0)–(8 7) is file line 7, (:name-at "k") (15 0) file line 13, columns after the marker', () => {
      assert.deepStrictEqual(fromIdeReplySpan(drift, { start: { line: 8, column: 0 }, end: { line: 8, column: 7 } }), {
        start: { line: 7, character: 2 },
        end: { line: 7, character: 9 },
      });
      assert.deepStrictEqual(fromIdeReply(drift, { line: 15, column: 0 }), { line: 13, character: 2 });
      assert.deepStrictEqual(fromIdeReply(drift, { line: 11, column: 0 }), { line: 10, character: 2 }, 'h: the `>` alone above adds nothing');
      assert.deepStrictEqual(fromIdeReply(drift, { line: 6, column: 0 }), { line: 6, character: 2 }, 'the doubled line itself');
    });

    test('the extra line of the unlit text maps to the end of the file line it comes from', () => {
      assert.deepStrictEqual(fromIdeReply(drift, { line: 7, column: 0 }), { line: 6, character: 2 });
      assert.deepStrictEqual(fromIdeReply(drift, { line: 14, column: 3 }), { line: 12, character: 4 });
    });

    test('CLI: E:8:5--8:8 under `> g = "x"` on file line 7 (1-based) below a `> ` line is file line 6 (0-based), columns 6–9', () => {
      const e = doc('/w/E.lidr', ['> module E', '', '> f : Nat', '> f = 1', '> ', '> g : Nat', '> g = "x"']);
      const range = fromCliSpan(e, { start: { line: 8, column: 5 }, end: { line: 8, column: 8 } });
      assert.deepStrictEqual(range, { start: { line: 6, character: 6 }, end: { line: 6, character: 9 } });
      assert.strictEqual(e.lineAt(6).text.slice(6, 9), '"x"');
    });

    test('every isSpace character counts, `<` too; a marker with code, a marker alone, and the last line without a break do not', () => {
      const d = doc('/w/S.lidr', ['<\t', '>\u00a0 ', '>\f', '> x', '>', 'y = 1', '> ']);
      // Doubled: lines 0, 1, 2; line 6 is the last (no line break follows it).
      assert.deepStrictEqual(toIdeTypeOfRequest(d, { line: 3, character: 2 }), { line: 7, column: 0 });
      assert.deepStrictEqual(toIdeTypeOfRequest(d, { line: 6, character: 2 }), { line: 10, column: 0 });
      assert.deepStrictEqual(fromIdeReply(d, { line: 9, column: 0 }), { line: 6, character: 2 });
    });

    test('a .idr file and a .md file are not literate-line mapped; a reply beyond the end moves by all doubled lines', () => {
      const lines = ['> ', 'x = 1'];
      assert.deepStrictEqual(toIdeTypeOfRequest(doc('/w/P.idr', lines), { line: 1, character: 0 }), { line: 2, column: 0 });
      assert.deepStrictEqual(toIdeTypeOfRequest(doc('/w/P.md', lines, 'markdown'), { line: 1, character: 0 }), { line: 2, column: 0 });
      assert.deepStrictEqual(fromIdeReply(drift, { line: 40, column: 3 }), { line: 38, character: 3 });
    });

    test('Org: `#+IDRIS:` is a line marker of width 9, and `#+IDRIS: ` a doubled line [live]', () => {
      // O.org of the second review: `f` on file line 4 reported at (4 0)–(4 1); after `#+IDRIS: ` on
      // file line 6, `g : Nat` (file line 7) at (8 0).
      const org = doc('/w/O.idr.org', ['#+IDRIS: module O', '', 'Some text.', '', '#+IDRIS: f : Nat', '#+IDRIS: f = 1', '#+IDRIS: ', '#+IDRIS: g : Nat', '#+IDRIS: g = 2'], 'org');
      assert.deepStrictEqual(fromIdeReplySpan(org, { start: { line: 4, column: 0 }, end: { line: 4, column: 1 } }), {
        start: { line: 4, character: 9 },
        end: { line: 4, character: 10 },
      });
      assert.deepStrictEqual(fromIdeReply(org, { line: 8, column: 0 }), { line: 7, character: 9 });
      assert.deepStrictEqual(toIdeTypeOfRequest(org, { line: 7, character: 9 }), { line: 9, column: 0 });
      // A line without the marker (a block's line, or prose) is taken as code with no offset.
      assert.deepStrictEqual(toIdeTypeOfRequest(org, { line: 2, character: 3 }), { line: 3, column: 3 });
    });

    test('the map is kept per document and version: made again when the version changes', () => {
      const lines = ['> module V', '> ', '> x : Nat'];
      const reads: number[] = [];
      const versioned = {
        fileName: '/w/V.lidr',
        isUntitled: false,
        languageId: 'lidr',
        version: 1,
        get lineCount() {
          return lines.length;
        },
        lineAt: (line: number) => {
          reads.push(line);
          return { text: lines[line] };
        },
      };
      assert.deepStrictEqual(toIdeTypeOfRequest(versioned, { line: 2, character: 2 }), { line: 4, column: 0 });
      reads.length = 0;
      toIdeTypeOfRequest(versioned, { line: 2, character: 2 });
      assert.deepStrictEqual([...new Set(reads)], [2], 'only the line of the position is read again');
      lines[1] = '> y = 1';
      versioned.version = 2;
      assert.deepStrictEqual(toIdeTypeOfRequest(versioned, { line: 2, character: 2 }), { line: 3, column: 0 });
    });
  });

  suite('toIdeTypeOfRequestPastStart (second review of M3: a name right after a local) [live]', () => {
    // Adj.idr of the review: `f xs ys = xs++ys` is line 4 (1-based); `(:type-of "++" 4 12)` answered
    // `xs : List Nat`, `(:type-of "++" 4 13)` `Prelude.List.(++) : …`.
    const adj = doc('/w/Adj.idr', ['module Adj', '', 'f : List Nat -> List Nat -> List Nat', 'f xs ys = xs++ys', 'h n = n+1', 'k = f  [] []']);

    test('one code point past the start: inside a name of two, the end of a name of one', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(adj, { line: 3, character: 12 }), { line: 4, column: 12 });
      assert.deepStrictEqual(toIdeTypeOfRequestPastStart(adj, { line: 3, character: 12 }), { line: 4, column: 13 });
      assert.deepStrictEqual(toIdeTypeOfRequestPastStart(adj, { line: 4, character: 7 }), { line: 5, column: 8 });
    });

    test('none when white space, or the start of the line, comes before the position: no name ends there', () => {
      assert.strictEqual(toIdeTypeOfRequestPastStart(adj, { line: 3, character: 10 }), undefined);
      assert.strictEqual(toIdeTypeOfRequestPastStart(adj, { line: 3, character: 0 }), undefined);
      assert.strictEqual(toIdeTypeOfRequestPastStart(adj, { line: 5, character: 7 }), undefined);
    });

    test('code points: after a character outside the BMP; bird tracks: unlit, none at the first code column, none on prose', () => {
      const astral = doc('/w/A.idr', ['h = a𝕟+𝕟b']);
      assert.deepStrictEqual(toIdeTypeOfRequestPastStart(astral, { line: 0, character: 7 }), { line: 1, column: 7 });
      assert.deepStrictEqual(toIdeTypeOfRequestPastStart(astral, { line: 0, character: 8 }), { line: 1, column: 8 });
      const lidr = doc('/w/B.lidr', ['> f xs ys = xs++ys', 'prose++x']);
      assert.deepStrictEqual(toIdeTypeOfRequestPastStart(lidr, { line: 0, character: 14 }), { line: 1, column: 13 });
      assert.strictEqual(toIdeTypeOfRequestPastStart(lidr, { line: 0, character: 2 }), undefined);
      assert.strictEqual(toIdeTypeOfRequestPastStart(lidr, { line: 1, character: 5 }), undefined);
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

    test('E14: CLI columns count code points too (the same file contexts, [src])', () => {
      const astral = doc('/w/Astral.idr', ['f = ("𝕟𝕟", zz)']);
      // `zz` is at code points 11–13 (1-based 12–14), UTF-16 units 13–15.
      assert.deepStrictEqual(fromCliSpan(astral, { start: { line: 1, column: 12 }, end: { line: 1, column: 14 } }), {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 15 },
      });
    });
  });

  // E14 (ROADMAP §9), settled in M3: the compiler's columns count code points [live, transcript
  // unicode-columns; the transcript-driven check is in protocolTranscripts.test.ts]. Only characters
  // outside the BMP — two UTF-16 units, one code point — make the counts differ.
  suite('E14: code points against UTF-16 units', () => {
    // Fixture broken/Unicode.idr, line 15 (0-based 14): the second `s` is at code points 18–19,
    // UTF-16 units 20–21.
    const unicode = doc('/w/Unicode.idr', [...Array(14).fill(''), 'astral s = ("𝕟𝕟", s)', '', '', 'combining t = ("é", t)']);

    test('a request after two characters outside the BMP: UTF-16 column 20 is the compiler\'s 18 (where s answered, 0.8.0)', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(unicode, { line: 14, character: 20 }), { line: 15, column: 18 });
      assert.deepStrictEqual(toIdeTypeOfRequest(unicode, { line: 14, character: 21 }), { line: 15, column: 19 });
      assert.deepStrictEqual(toIdeCaseSplitRequest(unicode, { line: 14, character: 20 }), { line: 15, column: 19 });
      // Before the astral characters nothing changes.
      assert.deepStrictEqual(toIdeTypeOfRequest(unicode, { line: 14, character: 7 }), { line: 15, column: 7 });
    });

    test('a reply after them: the compiler\'s (14 18)–(14 19) is UTF-16 20–21, which holds s', () => {
      const range = fromIdeReplySpan(unicode, { start: { line: 14, column: 18 }, end: { line: 14, column: 19 } });
      assert.deepStrictEqual(range, { start: { line: 14, character: 20 }, end: { line: 14, character: 21 } });
      assert.strictEqual(unicode.lineAt(14).text.slice(20, 21), 's');
    });

    test('a combining mark is a code point of its own and one UTF-16 unit: no shift (t at 21 in both)', () => {
      assert.deepStrictEqual(toIdeTypeOfRequest(unicode, { line: 17, character: 21 }), { line: 18, column: 21 });
      assert.deepStrictEqual(fromIdeReply(unicode, { line: 17, column: 21 }), { line: 17, character: 21 });
    });

    test('a position between the two halves of a surrogate pair counts as the start of its character', () => {
      // `𝕟𝕟` occupies UTF-16 units 13–16 of line 14; unit 14 is inside the first.
      assert.deepStrictEqual(toIdeTypeOfRequest(unicode, { line: 14, character: 14 }), { line: 15, column: 13 });
      assert.strictEqual(codePointsBefore('a𝕟b', 2), 1);
      assert.strictEqual(codePointsBefore('a𝕟b', 3), 2);
    });

    test('.lidr: the bird-track offset first, then the code points of the unlit text', () => {
      const lit2 = doc('/w/U.lidr', ['> f = ("𝕟", n)']);
      // `n` is at file UTF-16 column 13, unlit UTF-16 column 11, unlit code point 10.
      assert.deepStrictEqual(toIdeTypeOfRequest(lit2, { line: 0, character: 13 }), { line: 1, column: 10 });
      assert.deepStrictEqual(fromIdeReply(lit2, { line: 0, column: 10 }), { line: 0, character: 13 });
      assert.strictEqual(lit2.lineAt(0).text.charAt(13), 'n');
    });

    test('the two counts, beyond the end of the text one per unit, and without astral characters the identity', () => {
      assert.strictEqual(utf16Length('𝕟𝕟x', 2), 4);
      assert.strictEqual(utf16Length('𝕟𝕟x', 3), 5);
      assert.strictEqual(utf16Length('𝕟', 3), 4);
      assert.strictEqual(codePointsBefore('𝕟𝕟x', 5), 3);
      assert.strictEqual(codePointsBefore('𝕟', 4), 3);
      assert.strictEqual(utf16Length('αβγ', 2), 2);
      assert.strictEqual(codePointsBefore('αβγ', 2), 2);
      // A lone surrogate is one unit and one code point.
      assert.strictEqual(utf16Length('\ud835x', 2), 2);
      for (let cp = 0; cp <= 6; cp++) {
        assert.strictEqual(codePointsBefore('a𝕟b𝕟c', utf16Length('a𝕟b𝕟c', cp)), cp, `round trip ${cp}`);
      }
    });

    test('a document without text (the caller has none) passes columns through', () => {
      const none = doc('/w/None.idr', []);
      assert.deepStrictEqual(fromIdeReply(none, { line: 3, column: 18 }), { line: 3, character: 18 });
    });
  });

  suite('toCompilerColumn (the column a text sent to the compiler must keep)', () => {
    test('code points of the unlit text before the position; 0 inside the marker; none on prose', () => {
      assert.strictEqual(toCompilerColumn(clean, { line: 7, character: 10 }), 10);
      assert.strictEqual(toCompilerColumn(doc('/w/A.idr', ['r = ("𝕟𝕟", let a = 1']), { line: 0, character: 16 }), 14);
      assert.strictEqual(toCompilerColumn(lit, { line: 5, character: 4 }), 2);
      assert.strictEqual(toCompilerColumn(lit, { line: 5, character: 1 }), 0);
      assert.strictEqual(toCompilerColumn(lit, { line: 2, character: 3 }), undefined);
    });
  });

  suite('codeLineSpans (a range over several lines, per line)', () => {
    const span = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

    test('one part per line, to the line end, the last to the range end; empty parts and lines past the end left out', () => {
      const d = doc('/w/C.idr', ['{- one', 'two -} f', '']);
      assert.deepStrictEqual(codeLineSpans(d, span(0, 0, 1, 6)), [
        { line: 0, start: 0, end: 6 },
        { line: 1, start: 0, end: 6 },
      ]);
      assert.deepStrictEqual(codeLineSpans(d, span(0, 6, 2, 0)), [{ line: 1, start: 0, end: 8 }]);
      assert.deepStrictEqual(codeLineSpans(d, span(1, 7, 5, 1)), [{ line: 1, start: 7, end: 8 }]);
    });

    test('F11: in a bird-track file a continuation line starts after its marker, and a prose line has no part', () => {
      assert.deepStrictEqual(codeLineSpans(lit, span(0, 2, 4, 6)), [
        { line: 0, start: 2, end: 12 },
        { line: 4, start: 2, end: 6 },
      ]);
    });
  });

  suite('the text a load read and the text shown (third and fourth reviews of M3)', () => {
    const loaded = ['module M', '', 'f : Nat -> Nat', 'f n = n', '', 'g : String -> String', 'g n = n', ''];
    /** `lineCorrespondence`'s arrays as plain lists: per line of the shown text its loaded line, and the converse. */
    const pairs = (before: string[], after: string[]) => {
      const c = lineCorrespondence(before, after);
      return { toBefore: [...c.toBefore], toAfter: [...c.toAfter] };
    };

    test('lineCorrespondence: equal lines paired by a line diff, also between two separate edits; lines edited in place paired in order', () => {
      assert.deepStrictEqual(pairs(loaded, loaded).toBefore, [0, 1, 2, 3, 4, 5, 6, 7]);
      const deleted = ['module M', '', 'g : String -> String', 'g n = n', ''];
      assert.deepStrictEqual(pairs(loaded, deleted), { toBefore: [0, 1, 5, 6, 7], toAfter: [0, 1, -1, -1, -1, 2, 3, 4] });
      // A line inserted at the top and the last line of code edited (fourth review of M3): the lines
      // in between are paired with the lines they were, not with the lines of the same number.
      const two = ['module M', 'import Data.List', '', 'f : Nat -> Nat', 'f n = n', '', 'g : String -> String', 'g n = n ++ n', ''];
      assert.deepStrictEqual(pairs(loaded, two), { toBefore: [0, -1, 1, 2, 3, 4, 5, 6, 7], toAfter: [0, 2, 3, 4, 5, 6, 7, 8] });
      // Two lines replaced by two: paired in order; one line replaced by two: neither is paired.
      const replaced = ['module M', '', 'f : Nat -> Nat', 'f m = m', '', 'g : String -> String', 'g m = m', ''];
      assert.deepStrictEqual(pairs(loaded, replaced).toBefore, [0, 1, 2, 3, 4, 5, 6, 7]);
      const split = ['module M', '', 'f : Nat -> Nat', 'f n =', '  n', '', 'g : String -> String', 'g n = n', ''];
      assert.deepStrictEqual(pairs(loaded, split).toBefore, [0, 1, 2, -1, -1, 4, 5, 6, 7]);
      // A line inserted into a run of equal lines: all of the loaded ones are paired.
      assert.deepStrictEqual(pairs(['a', 'a'], ['a', 'a', 'a']).toAfter, [0, 1]);
      assert.deepStrictEqual(pairs([], ['a']), { toBefore: [-1], toAfter: [] });
      assert.deepStrictEqual(pairs(['a'], []), { toBefore: [], toAfter: [-1] });
    });

    test('lineCorrespondence: the equal pairs are a longest common subsequence, increasing, of equal lines (property, seed 23)', () => {
      const next = prng(23);
      const pick = (n: number) => Math.floor(next() * n);
      const lcsLength = (a: string[], b: string[]): number => {
        const row = new Array<number>(b.length + 1).fill(0);
        for (const x of a) {
          let diagonal = 0;
          for (let j = 1; j <= b.length; j++) {
            const up = row[j];
            row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
            diagonal = up;
          }
        }
        return row[b.length];
      };
      for (let round = 0; round < 400; round++) {
        const alphabet = 1 + pick(5);
        const before = Array.from({ length: pick(30) }, () => `l${pick(alphabet)}`);
        const after = Array.from({ length: pick(30) }, () => `l${pick(alphabet)}`);
        const { toBefore, toAfter } = lineCorrespondence(before, after);
        let last = -1;
        let equal = 0;
        for (let a = 0; a < after.length; a++) {
          const b = toBefore[a];
          if (b < 0) {
            continue;
          }
          assert.strictEqual(toAfter[b], a, `round ${round}: the arrays are converse`);
          assert.ok(b > last, `round ${round}: increasing`);
          last = b;
          equal += before[b] === after[a] ? 1 : 0;
        }
        assert.strictEqual(equal, lcsLength(before, after), `round ${round}: ${JSON.stringify(before)} / ${JSON.stringify(after)}`);
      }
    });

    test(`lineCorrespondence: more than MAX_LINE_EDITS (${MAX_LINE_EDITS}) lines inserted and deleted leave the lines between the changes unpaired`, () => {
      const before = Array.from({ length: 1200 }, (_, i) => `a${i}`);
      const after = ['head', ...Array.from({ length: 1200 }, (_, i) => (i % 2 === 0 ? `a${i}` : `b${i}`)), 'tail'];
      // 600 lines deleted and 602 inserted: the diff is not run.
      assert.ok([...lineCorrespondence(before, after).toBefore].every((b) => b === -1));
      // Within the bound: the unchanged lines are paired.
      const near = ['head', ...before.slice(0, 1199), 'tail'];
      assert.deepStrictEqual([...lineCorrespondence(before, near).toBefore].slice(0, 3), [-1, 0, 1]);
    });

    test('toLoadedPosition: a position on an equal line moves with it; on a line edited in place only after the same text; none on an unpaired line', () => {
      const deleted = ['module M', '', 'g : String -> String', 'g n = n', ''];
      assert.deepStrictEqual(toLoadedPosition(loaded, deleted, { line: 0, character: 3 }), { line: 0, character: 3 });
      assert.deepStrictEqual(toLoadedPosition(loaded, deleted, { line: 3, character: 2 }), { line: 6, character: 2 });
      const inserted = ['module M', '', '-- a', 'f : Nat -> Nat', 'f n = n', '', 'g : String -> String', 'g n = n', ''];
      assert.deepStrictEqual(toLoadedPosition(loaded, inserted, { line: 4, character: 2 }), { line: 3, character: 2 });
      assert.strictEqual(toLoadedPosition(loaded, inserted, { line: 2, character: 0 }), undefined, 'the inserted line');
      const typed = [...loaded.slice(0, 6), 'g n = n ++ "!"', ''];
      assert.deepStrictEqual(toLoadedPosition(loaded, typed, { line: 6, character: 2 }), { line: 6, character: 2 }, 'before the typing');
      assert.deepStrictEqual(toLoadedPosition(loaded, typed, { line: 6, character: 8 }), undefined, 'where the loaded line has other text before');
      const renamed = [...loaded.slice(0, 6), 'g m n = n', ''];
      assert.strictEqual(toLoadedPosition(loaded, renamed, { line: 6, character: 4 }), undefined);
      // A changed line the loaded text does not have (inserted at its end).
      assert.strictEqual(toLoadedPosition(['a'], ['a', 'b', 'c'], { line: 2, character: 0 }), undefined);
    });

    test('toLoadedPosition between two separate edits: the let-bound x of the line it is on, not of the next line (fourth review of M3)', () => {
      // The reviewer's case, answered live by idris2 0.8.0: (:type-of "x" 5 6) is x : Nat, (:type-of "x" 6 6) x : String.
      const saved = ['module M', '', 'main : IO ()', 'main = do', '  let x = the Nat 1', '  let x = show x', '  putStrLn x', '', 'g : Nat', 'g = 1'];
      const shown = ['module M', 'import Data.List', '', 'main : IO ()', 'main = do', '  let x = the Nat 1', '  let x = show x', '  putStrLn x', '', 'g : Nat', 'g = 2'];
      assert.deepStrictEqual(toLoadedPosition(saved, shown, { line: 5, character: 6 }), { line: 4, character: 6 });
      assert.deepStrictEqual(toLoadedPosition(saved, shown, { line: 6, character: 6 }), { line: 5, character: 6 });
      assert.deepStrictEqual(toLoadedPosition(saved, shown, { line: 10, character: 0 }), { line: 9, character: 0 }, 'g of the line edited in place');
      assert.strictEqual(toLoadedPosition(saved, shown, { line: 1, character: 0 }), undefined, 'the inserted import');
      // With the line count unchanged (a line inserted at the top, the last deleted).
      const same = ['module M', '-- note', '', 'main : IO ()', 'main = do', '  let x = the Nat 1', '  let x = show x', '  putStrLn x', '', 'g : Nat'];
      assert.deepStrictEqual(toLoadedPosition(saved, same, { line: 5, character: 6 }), { line: 4, character: 6 });
    });

    test('toShownPosition: the converse, for a range read from the file on disk shown in its open document', () => {
      const shown = ['-- new', ...loaded.slice(0, 6), 'g n = n ++ n', ''];
      assert.deepStrictEqual(toShownPosition(loaded, shown, { line: 5, character: 0 }), { line: 6, character: 0 });
      assert.deepStrictEqual(toShownPosition(loaded, shown, { line: 6, character: 7 }), { line: 7, character: 7 }, 'same text before it');
      assert.strictEqual(toShownPosition(loaded, shown, { line: 6, character: 8 }), undefined, 'other text before it');
      assert.strictEqual(toShownPosition(['a', 'b'], ['a', 'x', 'y'], { line: 1, character: 0 }), undefined, 'a line replaced by two');
    });
  });
});
