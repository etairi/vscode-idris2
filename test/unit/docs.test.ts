// features/intelligence/docs.ts and the documentation commands of register.ts: the `idris2-doc`
// document (a path with the extension of plain text, the request in its query), the blocks of a
// qualified name, Docs at Cursor and Show Documentation… (the document beside the editor, its text
// the compiler's verbatim, coloured by the reply's spans, refreshed when its file is loaded again),
// and the plain-text notices when there is nothing to show.
import * as assert from 'assert';
import * as path from 'path';
import { unsupported } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import { DOC_SCHEME, docPath, docQuery, parseDocQuery, selectDocs } from '../../src/features/intelligence/docs';
import { createDocumentQueries } from '../../src/features/intelligence/queries';
import { DOCS_AT_CURSOR_COMMAND, registerIntelligence, SHOW_DOCUMENTATION_COMMAND } from '../../src/features/intelligence/register';
import { SEMANTIC_TOKEN_LEGEND } from '../../src/features/intelligence/semanticTokens';
import type { LoadedFileEvent } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import { asDoc, FakeBackend, FakeDocument, FakePosition, FakeUri, fakeApi, fixtureDocument, indexOf, quietLog, recordedReply, recordedTokens, settle } from './support/intelligence';

suite('features/intelligence/docs', () => {
  test('the path is the name with the extension of plain text, which VS Code prefers to the first line; the query carries the request', () => {
    assert.strictEqual(docPath('Foo.Shapes.area'), '/Foo.Shapes.area (Idris 2 docs).txt');
    assert.strictEqual(docPath('</>'), '/<\u2215> (Idris 2 docs).txt');
    // Names whose first line of docs matches a built-in first-line pattern (Raku's) or that end in
    // another language's extension: the path still ends in .txt, one path segment.
    for (const name of ['area', 'Data.Vect.index', '<.>', 'x.md', '</>', 'Main.rakuFoo', 'Tsuraku', 'a.pl']) {
      assert.strictEqual(path.posix.extname(docPath(name)), '.txt', name);
      assert.ok(docPath(name).endsWith(' (Idris 2 docs).txt'), name);
      assert.strictEqual(path.posix.dirname(docPath(name)), '/', `${name}: one path segment`);
    }
    // The path's last segment is the tab's title: invisible characters written out (second review
    // of M3: `f‮eulav` drew as `fvalue`), the name itself in the query.
    assert.strictEqual(docPath('f\u202Eeulav'), '/f\\u{202E}eulav (Idris 2 docs).txt');
    assert.strictEqual(docPath('a\u200Bb\u034F'), '/a\\u{200B}b\\u{34F} (Idris 2 docs).txt');
    assert.deepStrictEqual(parseDocQuery(docQuery({ source: 'file:///w/A.idr', name: 'f\u202Eeulav' }))?.name, 'f\u202Eeulav');
    const request = { source: 'file:///w/My%20Dir/A.idr', name: 'Data.Vect.(::)' };
    assert.deepStrictEqual(parseDocQuery(docQuery(request)), request);
    assert.strictEqual(parseDocQuery('source=file%3A%2F%2F%2Fw'), undefined);
    assert.strictEqual(parseDocQuery(''), undefined);
  });

  test('a qualified name keeps the blocks of its namespace; otherwise the whole reply [live, :docs-for "::"]', () => {
    const reply = recordedReply('clean-queries', '(:docs-for "::")');
    const first = (name: string) => selectDocs(reply, name).text.split('\n')[0];
    assert.strictEqual(first('Data.Vect.(::)'), 'Data.Vect.(::) : elem -> Vect len elem -> Vect (S len) elem');
    assert.strictEqual(selectDocs(reply, 'Data.Vect.(::)').text.split('\n').length, 4);
    assert.strictEqual(first('Vect.(::)'), 'Data.Vect.(::) : elem -> Vect len elem -> Vect (S len) elem');
    assert.strictEqual(first('Prelude.Basics.(::)'), 'Prelude.(::) : a -> List a -> List a', "the compiler's shortened name");
    assert.strictEqual(selectDocs(reply, 'Prelude.Basics.(::)').text.split('\n').length, 3);
    assert.strictEqual(selectDocs(reply, '::'), reply);
    assert.strictEqual(selectDocs(reply, 'Nope.(::)'), reply);
    const vect = selectDocs(reply, 'Data.Vect.(::)');
    const offset = reply.text.indexOf('Data.Vect.(::)');
    assert.deepStrictEqual(
      vect.spans[0],
      { ...reply.spans.find((s) => s.start === offset), start: 0 },
      'the spans move with the text',
    );
    const both = selectDocs({ text: 'A.f : Nat\n  one\nB.f : Nat\nA.B.f : Nat\n  two', spans: [{ start: 22, length: 5, decor: 'function' }] }, 'A.f');
    assert.deepStrictEqual(both, { text: 'A.f : Nat\n  one', spans: [] });
  });

  suite('the commands and the document (register.ts)', () => {
    function setup() {
      const doc = fixtureDocument('test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr');
      const backend = new FakeBackend();
      backend.index = indexOf(doc, recordedTokens('shapes-lookups', 'Foo/Shapes.idr', doc));
      backend.docsAnswer = (name) =>
        Promise.resolve(
          name === 'area'
            ? recordedReply('shapes-lookups', '(:docs-for "area")')
            : name === '::'
              ? recordedReply('clean-queries', '(:docs-for "::")')
              : name === 'hostile'
                ? { text: 'M.hostile : Nat\n  [x](command:workbench.action.terminal.sendSequence) $(alert) <b>b</b>', spans: [] }
                : undefined,
        );
      const loads = new Emitter<LoadedFileEvent>();
      const root: Classification = { kind: 'loose', dir: '/w' };
      const registry = { backendFor: () => backend, stateFor: () => ({ kind: 'active' }) as const, onDidChange: new Emitter<void>().event };
      const projects = { classify: () => Promise.resolve(root) };
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
      const intelligence = registerIntelligence(fake.api as never, {
        queries,
        loads: { onDidLoad: loads.event },
        registry,
        projects,
        checks: { statusOf: () => undefined, onDidChange: new Emitter<void>().event },
        config: { inlayHints: () => ({ variableTypes: true }), onDidChange: () => ({ dispose: () => undefined }), checking: () => ({ trigger: 'onSave', delayMs: 700 }) },
        log: quietLog,
      }, { keepNotices: true });
      const cursor = (line: number, character: number) => (fake.state.editor = { document: doc, selection: { active: new FakePosition(line, character) } });
      return { doc, backend, loads, root, fake, intelligence, cursor };
    }

    test('Docs at Cursor opens the whole reply beside the editor, as the compiler wrote it', async () => {
      const t = setup();
      t.cursor(12, 1);
      await t.fake.run(DOCS_AT_CURSOR_COMMAND);
      assert.strictEqual(t.fake.shownDocuments.length, 1);
      const [{ doc, options }] = t.fake.shownDocuments;
      assert.deepStrictEqual(options, { viewColumn: -2, preview: true, preserveFocus: true });
      assert.strictEqual(doc.uri.scheme, DOC_SCHEME);
      assert.strictEqual(doc.uri.path, '/area (Idris 2 docs).txt');
      assert.strictEqual(doc.getText(), recordedReply('shapes-lookups', '(:docs-for "area")').text);
      assert.deepStrictEqual(t.backend.calls, ['docsFor area full']);
      const tokens = (await t.fake.providers.semanticTokens.get('docs')?.provider.provideDocumentSemanticTokens(asDoc(doc), t.fake.cancel)) as { data: Uint32Array };
      assert.deepStrictEqual([...tokens.data.slice(0, 5)], [0, 0, 15, SEMANTIC_TOKEN_LEGEND.indexOf('function'), 0], "coloured by the reply's spans");
    });

    test('Show Documentation… asks for a name (the one at the cursor suggested); a qualified name keeps its blocks', async () => {
      const t = setup();
      t.cursor(40, 3);
      t.fake.state.input = 'Data.Vect.(::)';
      await t.fake.run(SHOW_DOCUMENTATION_COMMAND);
      assert.deepStrictEqual(t.fake.inputBoxes, [
        {
          title: 'Idris 2: Show Documentation',
          prompt: 'The name to show the documentation of, as this file sees it (e.g. map, or Data.Vect.index)',
          value: '|+|',
        },
      ]);
      assert.deepStrictEqual(t.backend.calls, ['docsFor :: full']);
      const [{ doc }] = t.fake.shownDocuments;
      assert.strictEqual(doc.uri.path, '/Data.Vect.(::) (Idris 2 docs).txt');
      assert.ok(doc.getText().startsWith('Data.Vect.(::) : elem'));
      t.fake.state.input = undefined;
      await t.fake.run(SHOW_DOCUMENTATION_COMMAND);
      t.fake.state.input = '   ';
      await t.fake.run(SHOW_DOCUMENTATION_COMMAND);
      assert.strictEqual(t.fake.shownDocuments.length, 1, 'dismissed or empty: nothing');
    });

    test('a docstring is shown as text: nothing in it is a link or an icon', async () => {
      const t = setup();
      t.fake.state.input = 'hostile';
      t.cursor(0, 0);
      await t.fake.run(SHOW_DOCUMENTATION_COMMAND);
      const [{ doc }] = t.fake.shownDocuments;
      assert.strictEqual(doc.getText(), 'M.hostile : Nat\n  [x](command:workbench.action.terminal.sendSequence) $(alert) <b>b</b>');
    });

    test('without docs, or when the compiler cannot answer, a plain-text notice and no document', async () => {
      const t = setup();
      t.fake.state.input = 'nothing](command:x)';
      t.cursor(0, 0);
      await t.fake.run(SHOW_DOCUMENTATION_COMMAND);
      t.backend.docsAnswer = () => Promise.reject(unsupported('Docs need a backend.'));
      t.fake.state.input = 'area2';
      await t.fake.run(SHOW_DOCUMENTATION_COMMAND);
      t.cursor(4, 1);
      await t.fake.run(DOCS_AT_CURSOR_COMMAND);
      t.cursor(12, 13);
      await t.fake.run(DOCS_AT_CURSOR_COMMAND);
      t.fake.state.input = undefined;
      await t.fake.run(SHOW_DOCUMENTATION_COMMAND);
      assert.strictEqual(t.fake.inputBoxes[t.fake.inputBoxes.length - 1].value, '', 'a local variable is not suggested');
      assert.deepStrictEqual(t.intelligence.notices, [
        'Idris 2: the compiler has no documentation for "nothing](command:x)".',
        'Idris 2: Docs need a backend.',
        'Idris 2: there is no name at the cursor.',
        'Idris 2: "r" is a local variable, which has no documentation.',
      ]);
      assert.deepStrictEqual(t.backend.calls, ['docsFor nothing](command:x) full', 'docsFor area2 full'], 'a local is not asked about');
      assert.ok(t.fake.messages[0].includes(']\u200b('));
      assert.deepStrictEqual(t.fake.shownDocuments, []);
    });

    test('an open document is refreshed when its file is loaded again, and asks again then', async () => {
      const t = setup();
      t.cursor(12, 1);
      await t.fake.run(DOCS_AT_CURSOR_COMMAND);
      const [{ doc }] = t.fake.shownDocuments;
      const changed: string[] = [];
      t.fake.providers.content?.onDidChange?.((uri) => changed.push(uri.toString()));
      t.loads.fire({ root: t.root, file: '/elsewhere/B.idr', rebuilt: true });
      t.loads.fire({ root: t.root, file: t.doc.fileName, rebuilt: true });
      assert.deepStrictEqual(changed, [doc.uri.toString()]);
      const text = await t.fake.providers.content?.provideTextDocumentContent(FakeUri.parse(doc.uri.toString()) as never, t.fake.cancel);
      assert.strictEqual(text, doc.getText());
      assert.deepStrictEqual(t.backend.calls, ['docsFor area full', 'docsFor area full']);
      t.fake.closed.fire(doc);
      assert.strictEqual(await t.fake.providers.semanticTokens.get('docs')?.provider.provideDocumentSemanticTokens(asDoc(doc), t.fake.cancel), undefined);
      t.loads.fire({ root: t.root, file: t.doc.fileName, rebuilt: true });
      assert.strictEqual(changed.length, 1, 'a closed document is forgotten');
      await settle();
    });

    test('a document restored without its source open asks for the source; a missing file says so', async () => {
      const t = setup();
      const uri = FakeUri.from({ scheme: DOC_SCHEME, path: docPath('area'), query: docQuery({ source: 'file:///gone/X.idr', name: 'area' }) });
      const text = await t.fake.providers.content?.provideTextDocumentContent(uri as never, t.fake.cancel);
      assert.strictEqual(text, 'No documentation for area: its file cannot be opened.');
      const other = new FakeDocument('/w/Other.idr', 'module Other');
      t.fake.state.textDocuments.push(other);
      const passive = await t.fake.providers.content?.provideTextDocumentContent(
        FakeUri.from({ scheme: DOC_SCHEME, path: docPath('area'), query: docQuery({ source: other.uri.toString(), name: 'area' }) }) as never,
        t.fake.cancel,
      );
      assert.strictEqual(passive, recordedReply('shapes-lookups', '(:docs-for "area")').text);
    });
  });
});
