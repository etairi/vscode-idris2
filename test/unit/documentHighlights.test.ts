// features/intelligence/highlights.ts and the highlight provider of register.ts, on the recorded
// tokens of Foo/Shapes.idr: a bound name within its clause (two clauses' `r` are different
// variables), a global name in the whole file, grouped by name and decoration; no answer (VS Code's
// word highlighting) where the index has no name.
import * as assert from 'assert';
import { Emitter } from '../../src/core/event';
import { documentHighlights } from '../../src/features/intelligence/highlights';
import { occurrenceAt, syntaxModelOf } from '../../src/features/intelligence/occurrence';
import { registerIntelligence } from '../../src/features/intelligence/register';
import type { LoadedFileEvent } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import { asDoc, FakeBackend, FakePosition, fakeApi, fixtureDocument, indexOf, quietLog, recordedTokens } from './support/intelligence';

function shapes() {
  const doc = fixtureDocument('test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr');
  const tokens = recordedTokens('shapes-lookups', 'Foo/Shapes.idr', doc);
  const highlight = (line: number, character: number): string[] | undefined => {
    const occurrence = occurrenceAt(doc, tokens, { line, character });
    assert.ok(occurrence !== undefined);
    return documentHighlights(tokens, occurrence, syntaxModelOf(doc))?.map((r) => `${r.start.line}:${r.start.character}-${r.end.character}`);
  };
  return { doc, tokens, highlight };
}

suite('features/intelligence/highlights', () => {
  test('a bound name: its occurrences in its own clause only [live tokens]', () => {
    const { highlight } = shapes();
    assert.deepStrictEqual(highlight(12, 13), ['12:13-14', '12:23-24', '12:27-28'], 'r of the Circle clause of area');
    assert.deepStrictEqual(highlight(28, 16), ['28:16-17', '28:34-35'], "r of scale's Circle clause, not r'");
    assert.deepStrictEqual(highlight(28, 25), ['28:25-27', '28:46-48'], "r'");
    assert.deepStrictEqual(highlight(33, 6), ['33:6-7', '33:16-17', '33:19-20'], 'f of twice, also inside the lambda');
  });

  test('a global name: every occurrence in the file with its decoration, each range once', () => {
    const { highlight } = shapes();
    assert.deepStrictEqual(highlight(11, 1), ['11:0-4', '12:0-4', '13:0-4', '40:10-14', '40:19-23']);
    assert.deepStrictEqual(highlight(19, 3), ['19:2-11', '23:2-11', '24:2-11'], 'the method sent twice is one range');
    const shape = highlight(4, 6) ?? [];
    assert.ok(shape.includes('4:5-10') && shape.includes('39:17-22') && shape.length > 8);
  });

  test('without a decoration (a name the lexer found) there is no answer', () => {
    const { doc, tokens } = shapes();
    assert.strictEqual(documentHighlights(tokens, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, name: 'x' }, syntaxModelOf(doc)), undefined);
    const bound = occurrenceAt(doc, tokens, { line: 12, character: 13 });
    assert.ok(bound !== undefined);
    assert.strictEqual(documentHighlights(tokens, bound, undefined), undefined, 'a bound name needs the layout');
  });

  test('the provider: highlights from the index, nothing without it or the capability', async () => {
    const { doc, tokens } = shapes();
    const backend = new FakeBackend();
    backend.index = indexOf(doc, tokens);
    const fake = fakeApi();
    registerIntelligence(fake.api as never, {
      queries: { run: () => Promise.reject(new Error('not asked')) },
      loads: { onDidLoad: new Emitter<LoadedFileEvent>().event },
      registry: { backendFor: () => backend },
      projects: { classify: () => Promise.resolve<Classification>({ kind: 'loose', dir: '/w' }) },
      checks: { statusOf: () => undefined, onDidChange: new Emitter<void>().event },
      config: { inlayHints: () => ({ variableTypes: true }), onDidChange: () => ({ dispose: () => undefined }) },
      log: quietLog,
    });
    const provide = (line: number, character: number) =>
      fake.providers.highlights?.provideDocumentHighlights(asDoc(doc), new FakePosition(line, character) as never, fake.cancel) as Promise<
        { range: { start: FakePosition; end: FakePosition } }[] | undefined
      >;
    assert.deepStrictEqual((await provide(12, 13))?.map((h) => h.range.start.character), [13, 23, 27]);
    assert.strictEqual(await provide(4, 1), undefined, 'a keyword');
    backend.caps = { ...backend.caps, documentHighlights: false };
    assert.strictEqual(await provide(12, 13), undefined);
    backend.caps = { ...backend.caps, documentHighlights: true };
    backend.index = undefined;
    assert.strictEqual(await provide(12, 13), undefined);
  });
});
