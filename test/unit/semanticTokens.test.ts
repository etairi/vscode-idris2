// features/intelligence/semanticTokens.ts and the providers of register.ts: the legend is
// idris2-lsp's; the compiler's recorded decorations of Foo/Shapes.idr and Lit.lidr become VS
// Code's encoding (Circle an enumMember, area a function, the lidr keyword at column 2); tokens
// over several lines are cut per line (after the bird-track marker, not on prose lines), and of
// overlapping ones the inner wins and the outer is cut around it; the documentation document is
// coloured by the reply's spans; and the time for a 2,000-line file is measured against ROADMAP
// M3's budget.
import * as assert from 'assert';
import { performance } from 'perf_hooks';
import type { Token } from '../../src/backend/types';
import { Emitter } from '../../src/core/event';
import { DECOR_TOKEN_TYPES, encodeRichText, encodeTokens, SEMANTIC_TOKEN_LEGEND } from '../../src/features/intelligence/semanticTokens';
import { currentTokens } from '../../src/features/intelligence/occurrence';
import { registerIntelligence } from '../../src/features/intelligence/register';
import type { LoadedFileEvent } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import { asDoc, FakeBackend, FakeDocument, fakeApi, fixtureDocument, indexOf, quietLog, recordedReply, recordedTokens } from './support/intelligence';

interface Decoded {
  readonly line: number;
  readonly character: number;
  readonly length: number;
  readonly type: string;
}

/** VS Code's reading of the five-integer encoding. */
function decode(data: readonly number[] | Uint32Array): Decoded[] {
  const result: Decoded[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    assert.strictEqual(data[i + 4], 0, 'no modifiers');
    result.push({ line, character, length: data[i + 2], type: SEMANTIC_TOKEN_LEGEND[data[i + 3]] });
  }
  return result;
}

suite('features/intelligence/semanticTokens', () => {
  test("the legend is idris2-lsp's (Capabilities.idr 13–25 at 9a2f0ad), and each decoration maps as it does", () => {
    assert.deepStrictEqual([...SEMANTIC_TOKEN_LEGEND], ['type', 'function', 'enumMember', 'variable', 'keyword', 'namespace', 'postulate', 'module', 'comment']);
    assert.deepStrictEqual(DECOR_TOKEN_TYPES, {
      type: 'type',
      function: 'function',
      data: 'enumMember',
      bound: 'variable',
      keyword: 'keyword',
      namespace: 'namespace',
      postulate: 'postulate',
      module: 'module',
      comment: 'comment',
    });
  });

  test('Foo/Shapes.idr as recorded: Circle is an enumMember, area a function, Shape a type, r a variable [live]', () => {
    const doc = fixtureDocument('test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr');
    const tokens = decode(encodeTokens(recordedTokens('shapes-lookups', 'Foo/Shapes.idr', doc), doc));
    const find = (line: number, character: number) => tokens.find((t) => t.line === line && t.character === character);
    assert.deepStrictEqual(find(6, 2), { line: 6, character: 2, length: 6, type: 'enumMember' });
    assert.deepStrictEqual(find(11, 0), { line: 11, character: 0, length: 4, type: 'function' });
    assert.deepStrictEqual(find(4, 5), { line: 4, character: 5, length: 5, type: 'type' });
    assert.deepStrictEqual(find(12, 13), { line: 12, character: 13, length: 1, type: 'variable' });
    assert.deepStrictEqual(find(2, 0), { line: 2, character: 0, length: 19, type: 'comment' });
    assert.deepStrictEqual(find(0, 7), { line: 0, character: 7, length: 10, type: 'module' });
    // The method name the compiler sent twice (with and without its namespace) is one token.
    assert.strictEqual(tokens.filter((t) => t.line === 19 && t.character === 2).length, 1);
    // Literals are decorated :data by the compiler, so the `2` of `2 * pi * r` is an enumMember too.
    assert.deepStrictEqual(find(23, 25), { line: 23, character: 25, length: 1, type: 'enumMember' });
    for (let i = 1; i < tokens.length; i++) {
      const [a, b] = [tokens[i - 1], tokens[i]];
      assert.ok(a.line < b.line || a.character + a.length <= b.character, `sorted, no overlap at ${b.line}:${b.character}`);
    }
  });

  test('Lit.lidr as recorded: the tokens are in file columns, the module keyword at column 2 (F11) [live]', () => {
    const doc = fixtureDocument('test/fixtures/workspaces/loose-file/Lit.lidr');
    const tokens = decode(encodeTokens(recordedTokens('lit-lookups', 'Lit.lidr', doc), doc));
    assert.deepStrictEqual(tokens[0], { line: 0, character: 2, length: 6, type: 'keyword' });
    assert.deepStrictEqual(tokens[1], { line: 0, character: 9, length: 3, type: 'module' });
  });

  const t = (sl: number, sc: number, el: number, ec: number, decor: Token['decor']): Token => ({ range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, decor });

  test('a token over several lines is cut at the line ends; empty pieces and lines past the end are dropped', () => {
    const doc = new FakeDocument('/w/C.idr', '{- one\ntwo -} f\nx');
    const encoded = decode(encodeTokens([t(0, 0, 1, 6, 'comment'), t(1, 7, 1, 8, 'function'), t(1, 7, 1, 7, 'bound'), t(2, 0, 2, 9, 'bound'), t(5, 0, 5, 1, 'bound')], doc));
    assert.deepStrictEqual(encoded, [
      { line: 0, character: 0, length: 6, type: 'comment' },
      { line: 1, character: 0, length: 6, type: 'comment' },
      { line: 1, character: 7, length: 1, type: 'function' },
      { line: 2, character: 0, length: 1, type: 'variable' },
    ]);
  });

  test('overlaps: the inner token wins and the outer is cut around it (idris2-lsp removeOverlap); crossing, the later start; the same range, the later', () => {
    // `greet name = "hello \{name}!"`: the literal :data over (0,13)–(0,29), the bound `name` at (0,22)–(0,26) [live].
    const doc = new FakeDocument('/w/I.idr', 'greet name = "hello \\{name}!"\nab cd');
    assert.deepStrictEqual(decode(encodeTokens([t(0, 13, 0, 29, 'data'), t(0, 22, 0, 26, 'bound')], doc)), [
      { line: 0, character: 13, length: 9, type: 'enumMember' },
      { line: 0, character: 22, length: 4, type: 'variable' },
      { line: 0, character: 26, length: 3, type: 'enumMember' },
    ]);
    // Order of the index does not matter; two inner tokens and one starting with the outer.
    assert.deepStrictEqual(decode(encodeTokens([t(0, 22, 0, 26, 'bound'), t(0, 13, 0, 14, 'keyword'), t(0, 13, 0, 29, 'data'), t(0, 27, 0, 28, 'function')], doc)), [
      { line: 0, character: 13, length: 1, type: 'keyword' },
      { line: 0, character: 14, length: 8, type: 'enumMember' },
      { line: 0, character: 22, length: 4, type: 'variable' },
      { line: 0, character: 26, length: 1, type: 'enumMember' },
      { line: 0, character: 27, length: 1, type: 'function' },
      { line: 0, character: 28, length: 1, type: 'enumMember' },
    ]);
    // Crossing: the one that starts later wins where they overlap; the same range: the later one.
    assert.deepStrictEqual(decode(encodeTokens([t(1, 0, 1, 4, 'type'), t(1, 2, 1, 5, 'bound')], doc)), [
      { line: 1, character: 0, length: 2, type: 'type' },
      { line: 1, character: 2, length: 3, type: 'variable' },
    ]);
    assert.deepStrictEqual(decode(encodeTokens([t(1, 0, 1, 2, 'type'), t(1, 0, 1, 2, 'function')], doc)), [{ line: 1, character: 0, length: 2, type: 'function' }]);
    // A multi-line token under a single-line one: cut on its first line only where the inner one is.
    assert.deepStrictEqual(decode(encodeTokens([t(0, 13, 1, 2, 'comment'), t(0, 20, 0, 22, 'keyword')], doc)), [
      { line: 0, character: 13, length: 7, type: 'comment' },
      { line: 0, character: 20, length: 2, type: 'keyword' },
      { line: 0, character: 22, length: 7, type: 'comment' },
      { line: 1, character: 0, length: 2, type: 'comment' },
    ]);
  });

  test('bird tracks: a token over several lines starts each continuation line after its marker and skips prose lines (F11)', () => {
    // As recorded for such a file [live, review of M3]: a block comment `{- start` … `end -}` sent as
    // one :comment span of the unlit text, over a prose line; a multi-line string as :data.
    const doc = new FakeDocument('/w/L.lidr', '> module L\n\n> {- start\nprose here\n>    end -}\n> s : String\n> s = """\n>   a\n>   """');
    const encoded = decode(encodeTokens([t(2, 2, 4, 8, 'comment'), t(6, 6, 8, 5, 'data')], doc));
    assert.deepStrictEqual(encoded, [
      { line: 2, character: 2, length: 8, type: 'comment' },
      { line: 4, character: 2, length: 6, type: 'comment' },
      { line: 6, character: 6, length: 3, type: 'enumMember' },
      { line: 7, character: 2, length: 3, type: 'enumMember' },
      { line: 8, character: 2, length: 3, type: 'enumMember' },
    ]);
    // A .idr file is not bird-track, whatever its lines start with: from column 0.
    const idr = new FakeDocument('/w/L.idr', '{- a\n> b -}');
    assert.deepStrictEqual(decode(encodeTokens([t(0, 0, 1, 6, 'comment')], idr)), [
      { line: 0, character: 0, length: 4, type: 'comment' },
      { line: 1, character: 0, length: 6, type: 'comment' },
    ]);
  });

  test('a line with many tokens, and many nested ones, is encoded (no argument-count limit)', () => {
    const doc = new FakeDocument('/w/M.idr', 'x'.repeat(400_000));
    const many: Token[] = Array.from({ length: 200_000 }, (_, i) => t(0, 2 * i, 0, 2 * i + 1, 'bound'));
    many.push(t(0, 0, 0, 400_000, 'comment'));
    const encoded = encodeTokens(many, doc);
    assert.strictEqual(encoded.length, 400_000 * 5);
  });

  test("the documentation document is coloured by the reply's decorations [live, :docs-for area]", () => {
    const reply = recordedReply('shapes-lookups', '(:docs-for "area")');
    const tokens = decode(encodeRichText(reply));
    assert.deepStrictEqual(tokens, [
      { line: 0, character: 0, length: 15, type: 'function' },
      { line: 0, character: 18, length: 5, type: 'type' },
      { line: 0, character: 24, length: 2, type: 'keyword' },
      { line: 0, character: 27, length: 6, type: 'type' },
      { line: 2, character: 14, length: 6, type: 'keyword' },
    ]);
    assert.strictEqual(reply.text.split('\n')[2].slice(14, 20), 'export');
  });

  test('the budget: tokens of a 2,000-line file in under 200 ms (ROADMAP M3; measured, see the log line)', function () {
    const lines: string[] = [];
    const tokens: Token[] = [];
    for (let line = 0; line < 2000; line++) {
      const words = Array.from({ length: 12 }, (_, k) => `name${k}`);
      lines.push(words.join(' '));
      let character = 0;
      for (const word of words) {
        tokens.push({ range: { start: { line, character }, end: { line, character: character + word.length } }, decor: 'bound', name: word });
        character += word.length + 1;
      }
    }
    const doc = new FakeDocument('/w/Big.idr', lines.join('\n'));
    const index = indexOf(doc, tokens);
    const start = performance.now();
    const current = encodeTokens(currentTokens(doc, index), doc);
    const currentMs = performance.now() - start;
    doc.edit(doc.getText());
    const staleStart = performance.now();
    const stale = encodeTokens(currentTokens(doc, index), doc);
    const staleMs = performance.now() - staleStart;
    assert.strictEqual(current.length, 24000 * 5);
    assert.strictEqual(stale.length, 24000 * 5);
    console.log(`      semantic tokens of 2,000 lines / 24,000 tokens: ${currentMs.toFixed(1)} ms current, ${staleMs.toFixed(1)} ms with every token checked against the text`);
    assert.ok(currentMs < 200 && staleMs < 200);
  });

  suite('the providers (register.ts)', () => {
    function registered() {
      const doc = fixtureDocument('test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr');
      const backend = new FakeBackend();
      backend.index = indexOf(doc, recordedTokens('shapes-lookups', 'Foo/Shapes.idr', doc));
      const loads = new Emitter<LoadedFileEvent>();
      const fake = fakeApi();
      registerIntelligence(fake.api as never, {
        queries: { run: () => Promise.reject(new Error('not asked')) },
        loads: { onDidLoad: loads.event },
        registry: { backendFor: () => backend },
        projects: { classify: () => Promise.resolve<Classification>({ kind: 'loose', dir: '/w' }) },
        checks: { statusOf: () => undefined, onDidChange: new Emitter<void>().event },
        config: { inlayHints: () => ({ variableTypes: true }), onDidChange: () => ({ dispose: () => undefined }), checking: () => ({ trigger: 'onSave', delayMs: 700 }) },
        log: quietLog,
      });
      const entry = fake.providers.semanticTokens.get('idris');
      assert.ok(entry !== undefined);
      const provide = async (d = doc) => {
        const result = (await entry.provider.provideDocumentSemanticTokens(asDoc(d), fake.cancel)) as { data: Uint32Array } | undefined;
        return result === undefined ? undefined : decode(result.data);
      };
      return { doc, backend, loads, fake, entry, provide };
    }

    test('the Idris provider uses the legend, answers from the index, and tells VS Code when a load changes it', async () => {
      const t = registered();
      assert.deepStrictEqual(t.entry.legend.tokenTypes, [...SEMANTIC_TOKEN_LEGEND]);
      assert.deepStrictEqual(t.entry.legend.tokenModifiers, []);
      assert.ok(((await t.provide()) ?? []).length > 100);
      let fired = 0;
      t.entry.provider.onDidChangeSemanticTokens?.(() => fired++);
      t.loads.fire({ root: { kind: 'loose', dir: '/w' }, file: t.doc.fileName, rebuilt: false });
      assert.strictEqual(fired, 1);
      assert.deepStrictEqual(t.fake.providers.semanticTokens.get('docs')?.legend.tokenTypes, [...SEMANTIC_TOKEN_LEGEND]);
    });

    test('with unsaved changes the tokens the text still holds (all on unchanged lines); nothing without an index, the capability or a file', async () => {
      const t = registered();
      const lines = t.doc.getText().split('\n');
      lines[12] = 'area (Circle radius) = pi * radius * radius';
      t.doc.edit(lines.join('\n'));
      const stale = (await t.provide()) ?? [];
      assert.ok(stale.some((x) => x.line !== 12 && x.type === 'keyword'), 'keywords of unchanged lines kept (second review of M3)');
      assert.deepStrictEqual(stale.filter((x) => x.line === 12 && x.type === 'keyword').map((x) => x.character), [5], 'the changed line\'s `)` and `=` moved: dropped; `(` stayed');
      assert.ok(stale.some((x) => x.line === 12 && x.character === 0 && x.type === 'function'), 'area kept');
      assert.ok(!stale.some((x) => x.line === 12 && x.type === 'variable'), 'r dropped (radius is not r)');
      t.backend.caps = { ...t.backend.caps, semanticTokens: false };
      assert.strictEqual(await t.provide(), undefined);
      t.backend.caps = { ...t.backend.caps, semanticTokens: true };
      assert.strictEqual(await t.provide(new FakeDocument('Untitled-1', 'x', 'idris2', 'untitled')), undefined);
      t.backend.index = undefined;
      assert.strictEqual(await t.provide(), undefined);
    });
  });
});
