import * as assert from 'assert';
import type { IDisposable } from '../../src/core/disposable';
import {
  IS_IDRIS_DOCUMENT_CONTEXT_KEY,
  birdPrefixWidth,
  compilerLiterateStyleOf,
  idrisDocumentSelector,
  isIdrisDocument,
  literateStyleOf,
  trackIsIdrisDocumentContext,
  type ActiveDocumentHost,
  type IdrisDocumentCandidate,
} from '../../src/project/literate';

suite('project/literate', () => {
  suite('the document selector rule (M0 table)', () => {
    test('idrisDocumentSelector() selects the language ids idris2 and lidr', () => {
      assert.deepStrictEqual(idrisDocumentSelector(), [{ language: 'idris2' }, { language: 'lidr' }]);
    });

    test('isIdrisDocument is true for idris2 and lidr, false for markdown, ipkg and plaintext', () => {
      assert.strictEqual(isIdrisDocument({ languageId: 'idris2' }), true);
      assert.strictEqual(isIdrisDocument({ languageId: 'lidr' }), true);
      assert.strictEqual(isIdrisDocument({ languageId: 'markdown' }), false);
      assert.strictEqual(isIdrisDocument({ languageId: 'ipkg' }), false);
      assert.strictEqual(isIdrisDocument({ languageId: 'plaintext' }), false);
    });

    test('only lidr documents are bird-style literate', () => {
      assert.strictEqual(literateStyleOf({ languageId: 'lidr' }), 'bird');
      assert.strictEqual(literateStyleOf({ languageId: 'idris2' }), undefined);
      assert.strictEqual(literateStyleOf({ languageId: 'markdown' }), undefined);
    });

    test('for the compiler, the file name decides (`isLitFile`), the language mode only when untitled', () => {
      const saved = (fileName: string, languageId: string) => ({ fileName, languageId, isUntitled: false });
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.lidr', 'lidr')), 'bird');
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.lidr', 'idris2')), 'bird');
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.idr', 'lidr')), undefined);
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.LIDR', 'lidr')), undefined);
      assert.strictEqual(compilerLiterateStyleOf(saved('/w/A.md', 'lidr')), undefined);
      assert.strictEqual(compilerLiterateStyleOf({ fileName: 'Untitled-1', languageId: 'lidr', isUntitled: true }), 'bird');
      assert.strictEqual(compilerLiterateStyleOf({ fileName: 'Untitled-2', languageId: 'idris2', isUntitled: true }), undefined);
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
      host.active = { languageId: 'idris2' };
      trackIsIdrisDocumentContext(host);
      host.change({ languageId: 'markdown' });
      host.change({ languageId: 'lidr' });
      host.change(undefined);
      assert.deepStrictEqual(
        host.writes.map(([, value]) => value),
        [true, false, true, false],
      );
    });

    test('does not rewrite an unchanged value', () => {
      const host = new FakeHost();
      host.active = { languageId: 'idris2' };
      trackIsIdrisDocumentContext(host);
      host.change({ languageId: 'lidr' });
      host.change({ languageId: 'idris2' });
      assert.deepStrictEqual(host.writes, [[IS_IDRIS_DOCUMENT_CONTEXT_KEY, true]]);
    });

    test('a language-mode change of the active document is picked up', () => {
      const host = new FakeHost();
      const doc = { languageId: 'plaintext' };
      host.active = doc;
      trackIsIdrisDocumentContext(host);
      doc.languageId = 'idris2';
      host.change(doc);
      assert.deepStrictEqual(host.writes.map(([, value]) => value), [false, true]);
    });

    test('dispose() stops following the editor', () => {
      const host = new FakeHost();
      const tracker = trackIsIdrisDocumentContext(host);
      tracker.dispose();
      assert.strictEqual(host.listeners.size, 0);
      host.change({ languageId: 'idris2' });
      assert.deepStrictEqual(host.writes, [[IS_IDRIS_DOCUMENT_CONTEXT_KEY, false]]);
    });

    test('dispose() resets a true key to false, once', () => {
      const host = new FakeHost();
      host.active = { languageId: 'idris2' };
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
