// backend/lsp/holes.ts and LspBackend.holes over the recordings of idris2-lsp 0.1.0-9a2f0ad6a: the
// `metavars` answer turned into Holes by IDE mode's rules (declarations and the holes of unapplied
// refinements left out), located in the files' editor coordinates (code points, bird-track lines and
// columns), and asked once more when it is another file's context.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { decodeMetavars, holeSymbolCount } from '../../src/backend/lsp/holes';
import type { Hole } from '../../src/backend/types';
import { IdrisException } from '../../src/core/errors';
import { backendOver, LSP_ROOT, lspDocument, lspExchanges, recordedResult, ReplayClient, ScriptedClient } from './support/lspReplies';

const asDoc = (doc: unknown): vscode.TextDocument => doc as vscode.TextDocument;

/** A hole as the tests compare it: its names, type, premises and location as plain data. */
function shown(h: Hole): unknown {
  const l = h.location as unknown as { uri: { fsPath: string }; range: { start: { line: number; character: number }; end: { line: number; character: number } } } | undefined;
  return {
    name: h.name,
    qualifiedName: h.qualifiedName,
    type: h.type.text,
    premises: h.premises.map((p) => [p.name, p.type.text, p.multiplicity, p.implicit]),
    location: l === undefined ? undefined : [l.uri.fsPath, l.range.start.line, l.range.start.character, l.range.end.line, l.range.end.character],
  };
}

/** The non-null documentSymbol answer recorded in `scenario`. */
const symbolsOf = (scenario: string): unknown => lspExchanges(scenario).find((x) => x.method === 'textDocument/documentSymbol' && x.result !== null)?.result;

suite('backend/lsp/holes: metavars → Hole[] (F26, E16 over LSP)', () => {
  test('Clean.idr: the hole with its premises (multiplicity Rig0 and RigW, the compiler\'s isImplicit); the declaration without clauses left out', async () => {
    const client = new ReplayClient(lspExchanges('commands-clean'), symbolsOf('dirty'));
    const doc = lspDocument('commands-clean', 'src/Clean.idr');
    const holes = await backendOver(client, 'commands-clean').holes(asDoc(doc));
    assert.deepStrictEqual(holes.map(shown), [
      {
        name: 'vlen_rhs',
        qualifiedName: 'Clean.vlen_rhs',
        type: 'Nat',
        premises: [
          ['a', 'Type', 0, false],
          ['n', 'Nat', 0, false],
          ['xs', 'Vect n a', 'unrestricted', false],
        ],
        location: [`${LSP_ROOT}/src/Clean.idr`, 7, 10, 7, 19],
      },
    ]);
    assert.deepStrictEqual(client.sent.map((s) => s.method), ['textDocument/documentSymbol', 'workspace/executeCommand']);
  });

  test('holes-ipkg: the holes of the module and of every module it imports, each in its own file; two holes todo told apart by module (E16)', async () => {
    const client = new ReplayClient(lspExchanges('holes-ipkg'), []);
    const doc = lspDocument('holes-ipkg', 'src/Holes/Main.idr');
    const holes = await backendOver(client, 'holes-ipkg').holes(asDoc(doc));
    assert.deepStrictEqual(
      holes.map((h) => [h.qualifiedName, (shown(h) as { location: unknown }).location]),
      [
        ['Holes.Base.secret_rhs', [`${LSP_ROOT}/src/Holes/Base.idr`, 9, 9, 9, 20]],
        ['Holes.Main.size_rhs', [`${LSP_ROOT}/src/Holes/Main.idr`, 10, 14, 10, 23]],
        ['Holes.Base.todo', [`${LSP_ROOT}/src/Holes/Base.idr`, 6, 10, 6, 15]],
        ['Holes.Main.todo', [`${LSP_ROOT}/src/Holes/Main.idr`, 7, 11, 7, 16]],
        ['Holes.Util.util_rhs', [`${LSP_ROOT}/src/Holes/Util.idr`, 6, 21, 6, 30]],
      ],
    );
  });

  test('Lit2.lidr: a location below `> ` (two lines of the unlit text) and after the marker is moved to the file\'s line and column', async () => {
    const client = new ReplayClient(lspExchanges('lit2'));
    const doc = lspDocument('lit2', 'src/Lit2.lidr');
    const holes = await backendOver(client, 'lit2').holes(asDoc(doc));
    assert.deepStrictEqual(
      holes.map((h) => [h.name, (shown(h) as { location: unknown }).location]),
      [
        // The server's `18:9-18:18` and `8:10-8:19`: `?half_rhs` is on file line 17 at columns 11–20.
        ['half_rhs', [`${LSP_ROOT}/src/Lit2.lidr`, 17, 11, 17, 20]],
        ['vlen_rhs', [`${LSP_ROOT}/src/Lit2.lidr`, 8, 12, 8, 21]],
      ],
    );
  });

  test('Ambig.idr: the holes a refinement made and that were never applied (no location, no ?name in the text) are left out', async () => {
    const client = new ReplayClient(lspExchanges('ambig').filter((x) => x.method === 'workspace/executeCommand' && (x.params as { command: string }).command === 'metavars'), []);
    const doc = lspDocument('ambig', 'src/Ambig.idr');
    const metavars = recordedResult('ambig', 'workspace/executeCommand', (p) => (p as { command: string }).command === 'metavars') as { name: string }[];
    assert.deepStrictEqual(metavars.map((m) => m.name), ['Ambig.g_rhs', 'Ambig.g_rhs_0', 'Ambig.g_rhs_1']);
    const holes = await backendOver(client, 'ambig').holes(asDoc(doc));
    assert.deepStrictEqual(holes.map((h) => h.qualifiedName), ['Ambig.g_rhs']);
  });

  test('a refresh makes the server load a document at most once per version: two open documents do not reload each other for ever (review 1, H5)', async () => {
    const symbols = symbolsOf('dirty');
    const own = recordedResult('commands-clean', 'workspace/executeCommand', (p) => (p as { command: string }).command === 'metavars');
    const client = new ScriptedClient((method) => (method === 'textDocument/documentSymbol' ? symbols : own));
    const doc = lspDocument('commands-clean', 'src/Clean.idr');
    const backend = backendOver(client, 'commands-clean');
    const loads = (): number => client.sent.filter((m) => m.method === 'textDocument/documentSymbol').length;
    await backend.holes(asDoc(doc), { kept: true });
    assert.strictEqual(loads(), 1, 'the first refresh of this text');
    const holes = await backend.holes(asDoc(doc), { kept: true });
    assert.strictEqual(loads(), 1, 'not again: its load would publish, and refresh, for ever');
    assert.deepStrictEqual(holes.map((h) => h.qualifiedName), ['Clean.vlen_rhs']);
    await backend.holes(asDoc(doc));
    assert.strictEqual(loads(), 2, 'List Holes asks for this document, and loads it');
    doc.version++;
    await backend.holes(asDoc(doc), { kept: true });
    assert.strictEqual(loads(), 3, 'another text');
    client.fireState();
    await backend.holes(asDoc(doc), { kept: true });
    assert.strictEqual(loads(), 4, 'a server started again has loaded nothing');
  });

  test('a refresh that may not load, whose answer is another file\'s: the document has holes and it locates none, so it keeps what it had (review 1, H5)', async () => {
    const symbols = symbolsOf('dirty');
    const own = recordedResult('commands-clean', 'workspace/executeCommand', (p) => (p as { command: string }).command === 'metavars');
    const other = [{ name: 'Holes.Other.todo', location: { uri: `file://${LSP_ROOT}/src/Other.idr`, range: { start: { line: 5, character: 11 }, end: { line: 5, character: 16 } } }, type: 'Nat', premises: [] }];
    const answers: unknown[] = [own, other];
    const client = new ScriptedClient((method) => (method === 'textDocument/documentSymbol' ? symbols : answers.shift()));
    const doc = lspDocument('commands-clean', 'src/Clean.idr');
    const backend = backendOver(client, 'commands-clean');
    await backend.holes(asDoc(doc), { kept: true });
    await assert.rejects(backend.holes(asDoc(doc), { kept: true }), (e: unknown) => e instanceof IdrisException && e.error.kind === 'NotLoaded');
  });

  test('asked once more when the document\'s symbols show holes and the answer locates none in it (another file\'s context), and the second answer is taken', async () => {
    const symbols = symbolsOf('dirty');
    const own = recordedResult('commands-clean', 'workspace/executeCommand', (p) => (p as { command: string }).command === 'metavars');
    const other = [{ name: 'Holes.Other.todo', location: { uri: `file://${LSP_ROOT}/src/Other.idr`, range: { start: { line: 5, character: 8 }, end: { line: 5, character: 13 } } }, type: 'Nat', premises: [] }];
    for (const [answers, expected, asked] of [
      [[other, own], ['Clean.vlen_rhs'], 2],
      [[other, other], ['Holes.Other.todo'], 2],
      [[own], ['Clean.vlen_rhs'], 1],
    ] as const) {
      const queue: unknown[] = [...answers];
      const client = new ScriptedClient((method) => (method === 'textDocument/documentSymbol' ? symbols : queue.shift()));
      const doc = lspDocument('commands-clean', 'src/Clean.idr');
      const holes = await backendOver(client, 'commands-clean', 5, (p) => (p.endsWith('Other.idr') ? Promise.resolve('module Holes.Other\n\n\n\n\nfoo = ?todo\n') : Promise.resolve(doc.getText()))).holes(asDoc(doc));
      assert.deepStrictEqual(holes.map((h) => h.qualifiedName), expected);
      assert.strictEqual(client.sent.filter((s) => s.method === 'workspace/executeCommand').length, asked);
    }
    // No hole among the document's symbols: the answer is taken at once.
    const client = new ScriptedClient((method) => (method === 'textDocument/documentSymbol' ? [] : other));
    const doc = lspDocument('commands-clean', 'src/Clean.idr');
    await backendOver(client, 'commands-clean', 5, () => Promise.resolve(doc.getText())).holes(asDoc(doc));
    assert.strictEqual(client.sent.length, 2);
  });

  test('the server\'s null for the document (unsaved changes) is DirtyDocument, before metavars is sent', async () => {
    const client = new ScriptedClient(() => null);
    const doc = lspDocument('commands-clean', 'src/Clean.idr');
    await assert.rejects(backendOver(client, 'commands-clean').holes(asDoc(doc)), (e: unknown) => e instanceof IdrisException && e.error.kind === 'DirtyDocument');
    assert.deepStrictEqual(client.sent.map((s) => s.method), ['textDocument/documentSymbol']);
  });

  test('decodeMetavars: an answer of another shape is a ProtocolError; the recorded answers are read', () => {
    for (const bad of [null, {}, [{ name: 'x' }], [{ name: 'x', type: 'Nat', premises: [{ name: 'p', type: 'T', multiplicity: 'RigW' }] }], [{ name: 'x', type: 'Nat', premises: [], location: { uri: 1 } }]]) {
      assert.throws(() => decodeMetavars(bad), (e: unknown) => e instanceof IdrisException && e.error.kind === 'ProtocolError', JSON.stringify(bad));
    }
    for (const scenario of ['commands-clean', 'holes-ipkg', 'lit2', 'ambig', 'edits-searches', 'plain']) {
      for (const x of lspExchanges(scenario).filter((e) => e.method === 'workspace/executeCommand' && (e.params as { command: string }).command === 'metavars')) {
        assert.strictEqual(decodeMetavars(x.result), x.result);
      }
    }
  });

  test('holeSymbolCount: the symbols located at a ?name of their name in the document (half_rhs, vlen_rhs of Lit2.lidr), not declarations or locals', () => {
    const isLit2 = (uri: string): boolean => uri === `file://${LSP_ROOT}/src/Lit2.lidr`;
    assert.strictEqual(holeSymbolCount(symbolsOf('lit2'), isLit2), 2);
    assert.strictEqual(holeSymbolCount(symbolsOf('lit2'), () => false), 0);
    assert.strictEqual(holeSymbolCount(null, isLit2), 0);
    assert.strictEqual(holeSymbolCount(symbolsOf('plain'), () => true), 0);
  });
});
