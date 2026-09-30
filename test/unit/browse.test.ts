// Browse Namespace… (features/intelligence/docs.ts helpers and register.ts): the namespace
// suggested from the cursor or the module header, the QuickPick of the compiler's listing (names
// and types as plain text, no theme icons), the documentation of the name picked, and the notices
// for an empty listing or a backend that cannot answer.
import * as assert from 'assert';
import { unsupported } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { NamespaceEntry } from '../../src/backend/types';
import { namespaceItem, namespaceSuggestion } from '../../src/features/intelligence/docs';
import { offsetOf, syntaxModelOf } from '../../src/features/intelligence/occurrence';
import { createDocumentQueries } from '../../src/features/intelligence/queries';
import { BROWSE_NAMESPACE_COMMAND, registerIntelligence } from '../../src/features/intelligence/register';
import type { LoadedFileEvent } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import { asDoc, FakeBackend, FakeDocument, FakePosition, fakeApi, quietLog, recordedReply } from './support/intelligence';

/** The listing of `(:browse-namespace "Foo.Shapes")` as entries, one per line [live]. */
function shapesListing(): NamespaceEntry[] {
  const { text } = recordedReply('shapes-lookups', '(:browse-namespace "Foo.Shapes")');
  return text.split('\n').map((line) => ({ name: line.slice(0, line.indexOf(' : ')).replace(/^[01] /, ''), signature: { text: line, spans: [] } }));
}

suite('features/intelligence: Browse Namespace', () => {
  test('an item is the name with its type as the description; a hole keeps its name; no theme icons', () => {
    const [circle] = shapesListing();
    assert.deepStrictEqual(namespaceItem(circle), { label: 'Circle', description: 'Double -> Shape', entry: circle });
    const hole: NamespaceEntry = { name: 'vlen_rhs', signature: { text: '1 vlen_rhs : (0 a : Type) -> Nat', spans: [] } };
    assert.strictEqual(namespaceItem(hole).description, '(0 a : Type) -> Nat');
    const icon: NamespaceEntry = { name: '$(alert)', signature: { text: '$(alert) : $(x) Nat', spans: [] } };
    assert.deepStrictEqual([namespaceItem(icon).label, namespaceItem(icon).description], ['$\u200b(alert)', '$\u200b(x) Nat']);
    const bidi: NamespaceEntry = { name: 'f\u202E', signature: { text: 'f\u202E : Vect\n    n a', spans: [] } };
    assert.deepStrictEqual([namespaceItem(bidi).label, namespaceItem(bidi).description], ['f\\u{202E}', 'Vect n a'], 'one line, invisible characters written out');
  });

  test('the suggestion: the module imported or named at the cursor, a qualified name\'s namespace, else the module header', () => {
    const doc = new FakeDocument('/w/M.idr', 'module Foo.Main\n\nimport Data.Vect\nimport public Data.List\n\nf : Nat\nf = Data.Vect.length [1]');
    const model = syntaxModelOf(doc);
    const at = (line: number, character: number) => namespaceSuggestion(model, offsetOf(model as never, { line, character }));
    assert.strictEqual(at(2, 10), 'Data.Vect');
    assert.strictEqual(at(3, 16), 'Data.List');
    assert.strictEqual(at(6, 8), 'Data.Vect');
    assert.strictEqual(at(5, 0), 'Foo.Main');
    assert.strictEqual(namespaceSuggestion(syntaxModelOf(new FakeDocument('/w/N.idr', 'f : Nat')), 0), '');
    assert.strictEqual(namespaceSuggestion(undefined, 0), '');
  });

  suite('the command (register.ts)', () => {
    function setup() {
      const doc = new FakeDocument('/w/Foo/Shapes.idr', 'module Foo.Shapes\n\narea : Nat');
      const backend = new FakeBackend();
      backend.browseAnswer = (ns) => Promise.resolve(ns === 'Foo.Shapes' ? shapesListing() : []);
      backend.docsAnswer = (name) => Promise.resolve(name === 'area' ? recordedReply('shapes-lookups', '(:docs-for "area")') : undefined);
      const registry = { backendFor: () => backend, stateFor: () => ({ kind: 'active' }) as const, onDidChange: new Emitter<void>().event };
      const projects = { classify: () => Promise.resolve<Classification>({ kind: 'loose', dir: '/w' }) };
      const queries = createDocumentQueries({
        registry,
        projects,
        checks: { check: () => Promise.resolve(undefined), runningCheck: () => undefined, activeDocument: () => asDoc(doc) },
        config: { checking: () => ({ trigger: 'onSave', delayMs: 700 }) },
        trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
        log: quietLog,
      });
      const fake = fakeApi();
      fake.state.textDocuments.push(doc);
      fake.state.editor = { document: doc, selection: { active: new FakePosition(2, 0) } };
      const intelligence = registerIntelligence(fake.api as never, {
        queries,
        loads: { onDidLoad: new Emitter<LoadedFileEvent>().event },
        registry,
        projects,
        checks: { statusOf: () => undefined, onDidChange: new Emitter<void>().event },
        config: { inlayHints: () => ({ variableTypes: true }), onDidChange: () => ({ dispose: () => undefined }), checking: () => ({ trigger: 'onSave', delayMs: 700 }) },
        log: quietLog,
      }, { keepNotices: true });
      return { doc, backend, fake, intelligence };
    }

    test('asks for a namespace, lists its names, and opens the documentation of the one picked', async () => {
      const t = setup();
      t.fake.state.input = ' Foo.Shapes ';
      t.fake.state.pick = (items) => (items as { label: string }[]).find((i) => i.label === 'area');
      await t.fake.run(BROWSE_NAMESPACE_COMMAND);
      assert.deepStrictEqual(t.fake.inputBoxes, [
        {
          title: 'Idris 2: Browse Namespace',
          prompt: 'A namespace, e.g. Data.Vect: its names visible from this file are listed (its module must be imported here, or be this file)',
          value: 'Foo.Shapes',
        },
      ]);
      const [{ items, options }] = t.fake.quickPicks;
      assert.deepStrictEqual(
        (items as { label: string; description: string }[]).map((i) => `${i.label} : ${i.description}`),
        recordedReply('shapes-lookups', '(:browse-namespace "Foo.Shapes")').text.split('\n'),
      );
      assert.deepStrictEqual(options, { title: 'Idris 2: Browse Namespace', placeHolder: 'Pick a name to show its documentation', matchOnDescription: true });
      assert.deepStrictEqual(t.backend.calls, ['browseNamespace Foo.Shapes', 'docsFor area full']);
      assert.strictEqual(t.fake.shownDocuments[0].doc.uri.path, '/Foo.Shapes.area (Idris 2 docs).txt');
    });

    test('an empty listing, a backend that cannot answer, or no input: a notice or nothing', async () => {
      const t = setup();
      t.fake.state.input = 'Data.Vect';
      await t.fake.run(BROWSE_NAMESPACE_COMMAND);
      t.backend.browseAnswer = () => Promise.reject(unsupported('Browsing a namespace needs a backend.'));
      await t.fake.run(BROWSE_NAMESPACE_COMMAND);
      t.fake.state.input = undefined;
      await t.fake.run(BROWSE_NAMESPACE_COMMAND);
      assert.deepStrictEqual(t.intelligence.notices, [
        'Idris 2: no names of "Data.Vect" are visible from this file: the namespace is unknown, not imported here, or exports nothing visible.',
        'Idris 2: Browsing a namespace needs a backend.',
      ]);
      assert.deepStrictEqual(t.fake.quickPicks, []);
    });
  });
});
