import * as assert from 'assert';
import type { IDisposable } from '../../src/core/disposable';
import {
  IS_IDRIS_DOCUMENT_CONTEXT_KEY,
  LITERATE_EXTENSIONS,
  MODULE_SOURCE_EXTENSIONS,
  birdPrefixWidth,
  compilerLiterateStyleOf,
  idrisDocumentSelector,
  isIdrisDocument,
  isIdrisSourceFileName,
  isIdrisSpace,
  literateStyleOf,
  literateStyleOfFileName,
  splitFileExtensions,
  trackIsIdrisDocumentContext,
  type ActiveDocumentHost,
  type IdrisDocumentCandidate,
} from '../../src/project/literate';

/** A saved document named `fileName` in the language mode `languageId`. */
function doc(fileName: string, languageId: string): IdrisDocumentCandidate {
  return { fileName, languageId };
}

/** The double extensions of the M1 suffix rows, in table order (`.idr.<ext>`, then `.lidr.<ext>`). */
const DOUBLE_EXTENSIONS = ['.idr', '.lidr'].flatMap((prefix) =>
  ['.lidr', '.org', '.md', '.markdown', '.dj', '.tex', '.ltx', '.typ'].map((ext) => prefix + ext),
);

suite('project/literate', () => {
  suite('the compiler\'s literate table (src/Parser/Unlit.idr, src/Core/Directory.idr)', () => {
    test('the literate extensions, in the order of supportedStyles', () => {
      assert.deepStrictEqual(LITERATE_EXTENSIONS, ['.lidr', '.org', '.md', '.markdown', '.dj', '.tex', '.ltx', '.typ']);
    });

    test('nsToSource tries the literate extensions after "", .idr and .lidr, then .yaff, then .idr', () => {
      assert.deepStrictEqual(MODULE_SOURCE_EXTENSIONS, [
        '.lidr', '.org', '.md', '.markdown', '.dj', '.tex', '.ltx', '.typ',
        '.idr.lidr', '.idr.org', '.idr.md', '.idr.markdown', '.idr.dj', '.idr.tex', '.idr.ltx', '.idr.typ',
        '.lidr.lidr', '.lidr.org', '.lidr.md', '.lidr.markdown', '.lidr.dj', '.lidr.tex', '.lidr.ltx', '.lidr.typ',
        '.yaff',
        '.idr',
      ]);
    });

    test('isLitFile: the style whose extension ends the name, case-sensitively', () => {
      const cases: [string, string | undefined][] = [
        ['/w/A.lidr', 'bird'],
        ['/w/A.org', 'org'],
        ['/w/A.md', 'cmark'],
        ['/w/A.markdown', 'cmark'],
        ['/w/A.dj', 'cmark'],
        ['/w/A.tex', 'tex'],
        ['/w/A.ltx', 'tex'],
        ['/w/A.typ', 'typst'],
        ['/w/A.idr.md', 'cmark'],
        ['/w/A.lidr.md', 'cmark'],
        ['/w/A.md.lidr', 'bird'],
        ['/w/A.idr', undefined],
        ['/w/A.LIDR', undefined],
        ['/w/A.MD', undefined],
        ['/w/A.txt', undefined],
      ];
      for (const [name, style] of cases) {
        assert.strictEqual(literateStyleOfFileName(name), style, name);
      }
    });

    test('splitExtensions: a leading dot belongs to the stem', () => {
      assert.deepStrictEqual(splitFileExtensions('Foo.idr.md'), { stem: 'Foo', extensions: ['idr', 'md'] });
      assert.deepStrictEqual(splitFileExtensions('Path.idr'), { stem: 'Path', extensions: ['idr'] });
      assert.deepStrictEqual(splitFileExtensions('.hidden.latex.lidr'), { stem: '.hidden', extensions: ['latex', 'lidr'] });
      assert.deepStrictEqual(splitFileExtensions('.md'), { stem: '.md', extensions: [] });
      assert.deepStrictEqual(splitFileExtensions('Makefile'), { stem: 'Makefile', extensions: [] });
    });

    test('splitIdrisFileName: .idr or a literate last extension, not a dot-file, case-sensitive', () => {
      for (const name of ['Foo.idr', 'Foo.lidr', 'Foo.md', 'Foo.idr.md', 'Foo.lidr.tex', 'Foo.notes.org', 'Foo.typ', '..idr']) {
        assert.strictEqual(isIdrisSourceFileName(name), true, name);
      }
      for (const name of ['Foo.IDR', 'Foo.yaff', 'Foo.ipkg', 'Foo.idr.bak', '.idr', '.md', 'idr', 'Foo.']) {
        assert.strictEqual(isIdrisSourceFileName(name), false, name);
      }
    });

    test('isSpace: the seven characters of the prelude', () => {
      for (const c of [' ', '\t', '\r', '\n', '\f', '\v', '\u00a0']) {
        assert.strictEqual(isIdrisSpace(c), true, JSON.stringify(c));
      }
      for (const c of ['x', '\u2003', '\u0085', '']) {
        assert.strictEqual(isIdrisSpace(c), false, JSON.stringify(c));
      }
    });
  });

  suite('the document selector rule', () => {
    test('idrisDocumentSelector(): the language ids idris2 and lidr, then one pattern per double extension', () => {
      assert.deepStrictEqual(idrisDocumentSelector(), [
        { language: 'idris2' },
        { language: 'lidr' },
        ...DOUBLE_EXTENSIONS.map((suffix) => ({ pattern: `**/*${suffix}` })),
      ]);
    });

    test('isIdrisDocument is true for idris2 and lidr, false for markdown, ipkg and plaintext', () => {
      assert.strictEqual(isIdrisDocument(doc('/w/A.idr', 'idris2')), true);
      assert.strictEqual(isIdrisDocument(doc('/w/A.lidr', 'lidr')), true);
      assert.strictEqual(isIdrisDocument(doc('/w/Notes.md', 'markdown')), false);
      assert.strictEqual(isIdrisDocument(doc('/w/a.ipkg', 'ipkg')), false);
      assert.strictEqual(isIdrisDocument(doc('/w/a.txt', 'plaintext')), false);
    });

    test('a double extension selects the document whatever its language mode', () => {
      for (const suffix of DOUBLE_EXTENSIONS) {
        assert.strictEqual(isIdrisDocument(doc(`/w/Foo${suffix}`, 'plaintext')), true, suffix);
      }
      assert.strictEqual(isIdrisDocument(doc('/w/Foo.idr.md', 'markdown')), true);
      assert.strictEqual(isIdrisDocument(doc('/w/Foo.lidr.tex', 'latex')), true);
    });

    test('bare literate hosts, other suffixes and other cases are not selected (M12 opt-in)', () => {
      for (const name of ['/w/Foo.md', '/w/Foo.tex', '/w/Foo.org', '/w/Foo.typ', '/w/Foo.idr.md.bak', '/w/Foo.IDR.MD', '/w/Fooidr.md']) {
        assert.strictEqual(isIdrisDocument(doc(name, 'plaintext')), false, name);
      }
    });

    test('an untitled document matches by its language mode, or by a double extension in its path', () => {
      assert.strictEqual(isIdrisDocument(doc('Untitled-1', 'markdown')), false);
      assert.strictEqual(isIdrisDocument(doc('Untitled-1', 'idris2')), true);
      assert.strictEqual(isIdrisDocument(doc('/w/New.idr.md', 'markdown')), true);
    });

    test('literateStyleOf: the language mode for idris2/lidr documents, the double extension otherwise', () => {
      assert.strictEqual(literateStyleOf(doc('/w/A.lidr', 'lidr')), 'bird');
      assert.strictEqual(literateStyleOf(doc('/w/A.idr', 'idris2')), undefined);
      assert.strictEqual(literateStyleOf(doc('/w/A.lidr', 'idris2')), undefined);
      assert.strictEqual(literateStyleOf(doc('/w/Notes.md', 'markdown')), undefined);
      assert.strictEqual(literateStyleOf(doc('/w/A.idr.md', 'markdown')), 'cmark');
      assert.strictEqual(literateStyleOf(doc('/w/A.lidr.tex', 'latex')), 'tex');
      assert.strictEqual(literateStyleOf(doc('/w/A.idr.lidr', 'plaintext')), 'bird');
      assert.strictEqual(literateStyleOf(doc('/w/A.idr.md', 'idris2')), undefined);
    });

    test('for the compiler, the file name decides (`isLitFile`), the editor\'s view only when untitled', () => {
      const saved = (fileName: string, languageId: string) => ({ fileName, languageId, isUntitled: false });
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.lidr', 'lidr')), 'bird');
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.lidr', 'idris2')), 'bird');
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.idr', 'lidr')), undefined);
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.LIDR', 'lidr')), undefined);
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.md', 'lidr')), 'cmark');
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.idr.tex', 'latex')), 'tex');
      assert.strictEqual(compilerLiterateStyleOf({ fileName: 'Untitled-1', languageId: 'lidr', isUntitled: true }), 'bird');
      assert.strictEqual(compilerLiterateStyleOf({ fileName: 'Untitled-2', languageId: 'idris2', isUntitled: true }), undefined);
      assert.strictEqual(compilerLiterateStyleOf({ fileName: '/w/New.idr.md', languageId: 'markdown', isUntitled: true }), 'cmark');
    });
  });

  suite('birdPrefixWidth (Libraries/Text/Literate.idr `line`, `reduce`)', () => {
    test('a marker and one space or tab is stripped: width 2', () => {
      assert.strictEqual(birdPrefixWidth('> x = 1'), 2);
      assert.strictEqual(birdPrefixWidth('< x = 1'), 2);
      assert.strictEqual(birdPrefixWidth('>\tx = 1'), 2);
      assert.strictEqual(birdPrefixWidth('> '), 2);
    });

    test('only one of several spaces is stripped: the rest is code indentation', () => {
      assert.strictEqual(birdPrefixWidth('>   where'), 2);
    });

    test('every isSpace character counts, including U+00A0, \\f and \\v', () => {
      assert.strictEqual(birdPrefixWidth('>\u00a0x'), 2);
      assert.strictEqual(birdPrefixWidth('>\fx'), 2);
      assert.strictEqual(birdPrefixWidth('>\vx'), 2);
    });

    test('a marker alone is an empty code line: width 1', () => {
      assert.strictEqual(birdPrefixWidth('>'), 1);
      assert.strictEqual(birdPrefixWidth('<'), 1);
    });

    test('a marker directly followed by code is prose (verified: `>x : Nat` declares nothing)', () => {
      assert.strictEqual(birdPrefixWidth('>x : Nat'), undefined);
    });

    test('prose, blank lines and indented markers are not code lines', () => {
      assert.strictEqual(birdPrefixWidth('Some prose.'), undefined);
      assert.strictEqual(birdPrefixWidth(''), undefined);
      assert.strictEqual(birdPrefixWidth(' > x'), undefined);
    });
  });

  suite('trackIsIdrisDocumentContext', () => {
    class FakeHost implements ActiveDocumentHost {
      active: IdrisDocumentCandidate | undefined;
      listeners = new Set<() => void>();
      writes: [string, boolean][] = [];

      activeDocument(): IdrisDocumentCandidate | undefined {
        return this.active;
      }

      onDidChangeActiveDocument(listener: () => void): IDisposable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      }

      setContext(key: string, value: boolean): void {
        this.writes.push([key, value]);
      }

      change(active: IdrisDocumentCandidate | undefined): void {
        this.active = active;
        for (const listener of [...this.listeners]) {
          listener();
        }
      }
    }

    test('sets the key at once, from the active editor (none → false)', () => {
      const host = new FakeHost();
      trackIsIdrisDocumentContext(host);
      assert.deepStrictEqual(host.writes, [[IS_IDRIS_DOCUMENT_CONTEXT_KEY, false]]);
      assert.strictEqual(IS_IDRIS_DOCUMENT_CONTEXT_KEY, 'idris2.isIdrisDocument');
    });

    test('follows the active document: .idr → true, .md → false, .lidr → true, no editor → false', () => {
      const host = new FakeHost();
      host.active = doc('/w/A.idr', 'idris2');
      trackIsIdrisDocumentContext(host);
      host.change(doc('/w/Notes.md', 'markdown'));
      host.change(doc('/w/A.lidr', 'lidr'));
      host.change(undefined);
      assert.deepStrictEqual(
        host.writes.map(([, value]) => value),
        [true, false, true, false],
      );
    });

    test('a Markdown document named .idr.md sets the key, a plain .md does not', () => {
      const host = new FakeHost();
      host.active = doc('/w/Notes.md', 'markdown');
      trackIsIdrisDocumentContext(host);
      host.change(doc('/w/Lit.idr.md', 'markdown'));
      assert.deepStrictEqual(host.writes.map(([, value]) => value), [false, true]);
    });

    test('does not rewrite an unchanged value', () => {
      const host = new FakeHost();
      host.active = doc('/w/A.idr', 'idris2');
      trackIsIdrisDocumentContext(host);
      host.change(doc('/w/A.lidr', 'lidr'));
      host.change(doc('/w/A.idr', 'idris2'));
      assert.deepStrictEqual(host.writes, [[IS_IDRIS_DOCUMENT_CONTEXT_KEY, true]]);
    });

    test('a language-mode change of the active document is picked up', () => {
      const host = new FakeHost();
      const d = { fileName: '/w/A.idr', languageId: 'plaintext' };
      host.active = d;
      trackIsIdrisDocumentContext(host);
      d.languageId = 'idris2';
      host.change(d);
      assert.deepStrictEqual(host.writes.map(([, value]) => value), [false, true]);
    });

    test('dispose() stops following the editor', () => {
      const host = new FakeHost();
      const tracker = trackIsIdrisDocumentContext(host);
      tracker.dispose();
      assert.strictEqual(host.listeners.size, 0);
      host.change(doc('/w/A.idr', 'idris2'));
      assert.deepStrictEqual(host.writes, [[IS_IDRIS_DOCUMENT_CONTEXT_KEY, false]]);
    });

    test('dispose() resets a true key to false, once', () => {
      const host = new FakeHost();
      host.active = doc('/w/A.idr', 'idris2');
      const tracker = trackIsIdrisDocumentContext(host);
      tracker.dispose();
      tracker.dispose();
      assert.strictEqual(host.listeners.size, 0);
      assert.deepStrictEqual(host.writes, [
        [IS_IDRIS_DOCUMENT_CONTEXT_KEY, true],
        [IS_IDRIS_DOCUMENT_CONTEXT_KEY, false],
      ]);
    });
  });
});
