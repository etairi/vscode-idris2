// features/intelligence/symbols.ts and the symbol provider of register.ts: the top-level
// declarations of Foo/Shapes.idr (data with constructors, signatures with their clauses and docs,
// an interface with its method; not the implementation), the other declaration shapes (data with
// alternatives, records, interfaces with constraints, namespaces, mutual and parameters blocks,
// several names in one signature, operators), bird-track files, and the capability gate.
import * as assert from 'assert';
import { performance } from 'perf_hooks';
import { Emitter } from '../../src/core/event';
import { positionOf, syntaxModelOf } from '../../src/features/intelligence/occurrence';
import { registerIntelligence } from '../../src/features/intelligence/register';
import { documentSymbols, type DocumentSymbolModel } from '../../src/features/intelligence/symbols';
import type { LoadedFileEvent } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import { asDoc, FakeBackend, FakeDocument, fakeApi, fixtureDocument, quietLog } from './support/intelligence';

interface Shown {
  readonly name: string;
  readonly kind: string;
  readonly detail?: string;
  /** `line:character-line:character` of the range, then of the selection. */
  readonly at: string;
  readonly children?: Shown[];
}

/** The symbols of `doc` with positions, children only where there are some. */
function symbolsOf(doc: FakeDocument): Shown[] {
  const model = syntaxModelOf(doc);
  assert.ok(model !== undefined);
  const pos = (offset: number) => {
    const p = positionOf(model, offset);
    return `${p.line}:${p.character}`;
  };
  const show = (s: DocumentSymbolModel): Shown => ({
    name: s.name,
    kind: s.kind,
    ...(s.detail === '' ? {} : { detail: s.detail }),
    at: `${pos(s.range.start)}-${pos(s.range.end)} ${pos(s.selection.start)}-${pos(s.selection.end)}`,
    ...(s.children.length === 0 ? {} : { children: s.children.map(show) }),
  });
  return documentSymbols(model).map(show);
}

suite('features/intelligence/symbols', () => {
  test('Foo/Shapes.idr: the data type, the functions with their clauses and docs, the interface, the operator', () => {
    const doc = fixtureDocument('test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr');
    assert.deepStrictEqual(symbolsOf(doc), [
      {
        name: 'Shape',
        kind: 'Struct',
        at: '4:0-7:39 4:5-4:10',
        children: [
          { name: 'Circle', kind: 'Constructor', detail: 'Double -> Shape', at: '5:2-6:26 6:2-6:8' },
          { name: 'Rectangle', kind: 'Constructor', detail: 'Double -> Double -> Shape', at: '7:2-7:39 7:2-7:11' },
        ],
      },
      { name: 'area', kind: 'Function', detail: 'Shape -> Double', at: '9:0-13:28 11:0-11:4' },
      {
        name: 'Measured',
        kind: 'Interface',
        at: '17:0-19:25 17:10-17:18',
        children: [{ name: 'perimeter', kind: 'Method', detail: 'a -> Double', at: '18:2-19:25 19:2-19:11' }],
      },
      { name: 'scale', kind: 'Function', detail: 'Double -> Shape -> Shape', at: '26:0-29:51 27:0-27:5' },
      { name: 'twice', kind: 'Function', detail: '(Shape -> Shape) -> Shape -> Shape', at: '31:0-33:23 32:0-32:5' },
      { name: '|+|', kind: 'Function', detail: 'Shape -> Shape -> Double', at: '37:0-40:25 39:0-39:5' },
    ]);
  });

  test('data with alternatives, records, constrained interfaces, namespaces, mutual and parameters blocks', () => {
    const text = [
      'module M',
      'data Colour = Red | Green Nat',
      '  | Blue',
      'record Point where',
      '  constructor MkPoint',
      '  x, y : Double',
      'interface Eq a => Ord a where',
      '  compare : a -> a -> Ordering',
      '  compare x y = EQ',
      'namespace Inner',
      '  total',
      '  f : Nat',
      '  f = 0',
      'mutual',
      '  even : Nat -> Bool',
      '  odd : Nat -> Bool',
      'parameters (n : Nat)',
      '  g : Nat -> Nat -- the argument',
      '  g k = n + k',
      'Show Point where',
      '  show p = "p"',
      'infixl 6 <+>',
      '0 h, (<+>) : Type',
    ].join('\n');
    const names = (list: Shown[]): unknown[] => list.map((s) => [s.name, s.kind, ...(s.detail === undefined ? [] : [s.detail]), ...(s.children === undefined ? [] : [names(s.children)])]);
    assert.deepStrictEqual(names(symbolsOf(new FakeDocument('/w/M.idr', text))), [
      ['Colour', 'Struct', [['Red', 'Constructor'], ['Green', 'Constructor'], ['Blue', 'Constructor']]],
      ['Point', 'Struct', [['MkPoint', 'Constructor'], ['x', 'Field', 'Double'], ['y', 'Field', 'Double']]],
      ['Ord', 'Interface', [['compare', 'Method', 'a -> a -> Ordering']]],
      ['Inner', 'Namespace', [['f', 'Function', 'Nat']]],
      ['even', 'Function', 'Nat -> Bool'],
      ['odd', 'Function', 'Nat -> Bool'],
      ['g', 'Function', 'Nat -> Nat'],
      ['h', 'Function', 'Type'],
      ['<+>', 'Function', 'Type'],
    ]);
    const colour = symbolsOf(new FakeDocument('/w/M.idr', text))[0];
    assert.deepStrictEqual(
      colour.children?.map((c) => c.at),
      ['1:14-1:17 1:14-1:17', '1:20-1:29 1:20-1:25', '2:4-2:8 2:4-2:8'],
      'a constructor runs to the next |',
    );
  });

  test('a bird-track file: declarations on code lines, details without the markers', () => {
    const doc = new FakeDocument('/w/L.lidr', '> module L\n\nProse: f : Nat.\n\n> f : Nat ->\n>     Nat\n> f n = n');
    assert.deepStrictEqual(symbolsOf(doc), [{ name: 'f', kind: 'Function', detail: 'Nat -> Nat', at: '4:2-6:9 4:2-4:3' }]);
  });

  test('the syntax of 2,000 lines is read in well under the budget (measured, see the log line)', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `f${i} : Nat -> Nat\nf${i} n = n + ${i}`).join('\n');
    const start = performance.now();
    const symbols = documentSymbols(syntaxModelOf(new FakeDocument('/w/Big.idr', text)) as never);
    const ms = performance.now() - start;
    console.log(`      document symbols of 2,000 lines: ${ms.toFixed(1)} ms`);
    assert.strictEqual(symbols.length, 1000);
    assert.ok(ms < 1000);
  });

  test('the provider answers for files whose backend has the capability, with VS Code symbol kinds', async () => {
    const backend = new FakeBackend();
    const fake = fakeApi();
    registerIntelligence(fake.api as never, {
      queries: { run: () => Promise.reject(new Error('not asked')) },
      loads: { onDidLoad: new Emitter<LoadedFileEvent>().event },
      registry: { backendFor: () => backend },
      projects: { classify: () => Promise.resolve<Classification>({ kind: 'loose', dir: '/w' }) },
      checks: { statusOf: () => undefined, onDidChange: new Emitter<void>().event },
      config: { inlayHints: () => ({ variableTypes: true }), onDidChange: () => ({ dispose: () => undefined }), checking: () => ({ trigger: 'onSave', delayMs: 700 }) },
      log: quietLog,
    });
    const provide = (doc: FakeDocument) => fake.providers.symbols?.provideDocumentSymbols(asDoc(doc), fake.cancel) as Promise<{ name: string; kind: number; children: { kind: number }[] }[] | undefined>;
    const doc = fixtureDocument('test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr');
    const symbols = await provide(doc);
    assert.deepStrictEqual(
      symbols?.map((s) => [s.name, s.kind, s.children.map((c) => c.kind)]),
      [
        ['Shape', 22, [8, 8]],
        ['area', 11, []],
        ['Measured', 10, [5]],
        ['scale', 11, []],
        ['twice', 11, []],
        ['|+|', 11, []],
      ],
    );
    assert.strictEqual(await provide(new FakeDocument('Untitled-1', 'f : Nat', 'idris2', 'untitled')), undefined);
    assert.strictEqual(await provide(new FakeDocument('/w/D.idr.md', '# D', 'markdown')), undefined, 'a fenced literate file waits for M12');
    backend.caps = { ...backend.caps, documentSymbols: false };
    assert.strictEqual(await provide(doc), undefined);
  });
});
