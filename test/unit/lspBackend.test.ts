// backend/lsp/backend.ts: what LspBackend answers and what it refuses, saying why (ARCHITECTURE §3.1;
// ROADMAP §9 Q7, decided 2026-10-01: one backend per root, a feature it lacks unavailable with a
// message), and the namespace listing over the recording `features-cross`.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { LSP_CAPABILITIES } from '../../src/backend/lsp/backend';
import type { IdrisBackend } from '../../src/backend/types';
import { IdrisException } from '../../src/core/errors';
import { FakeDocument, FakeUri } from './support/intelligence';
import { backendOver, LSP_ROOT, lspDocument, lspExchanges, ReplayClient, ScriptedClient } from './support/lspReplies';

const asDoc = (doc: FakeDocument): vscode.TextDocument => doc as unknown as vscode.TextDocument;

/** The `Unsupported` reason `promise` rejects with. */
async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof IdrisException && error.error.kind === 'Unsupported', String(error));
    return error.message;
  }
  assert.fail('not refused');
}

suite('backend/lsp/backend: LspBackend', () => {
  test('capabilities: holes, edits, next results and namespaces; the providers\' answers and Evaluate are not the backend\'s', () => {
    assert.deepStrictEqual(
      Object.entries(LSP_CAPABILITIES)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .sort(),
      ['browseNamespace', 'editing', 'editingNext', 'holeLocations', 'holes', 'intro', 'missingCases', 'refine'],
    );
    assert.ok(Object.isFrozen(LSP_CAPABILITIES));
  });

  test('every method it does not answer rejects with Unsupported, saying why, and sends nothing', async () => {
    const client = new ScriptedClient(() => assert.fail('nothing may be sent'));
    const backend: IdrisBackend = backendOver(client, 'actions-clean');
    const doc = asDoc(lspDocument('actions-clean', 'src/Clean.idr'));
    const p = { line: 7, character: 10 } as vscode.Position;
    assert.match(await reason(backend.load(doc)), /idris2-lsp's own here: it checks a file when it is opened or saved/u);
    assert.match(await reason(backend.typeAt(doc, p, 'xs')), /^Showing a type is answered by idris2-lsp itself/u);
    assert.match(await reason(backend.definition(doc, p, 'vlen')), /^Go to Definition is answered by idris2-lsp itself/u);
    assert.match(await reason(backend.completions(doc, 'vl')), /^Completion is answered by idris2-lsp itself/u);
    assert.match(await reason(backend.docsFor(doc, 'vlen', 'full')), /^idris2-lsp has no documentation lookup/u);
    // Evaluate, also a text the REPL would read as a command: nothing reaches the server's `repl`.
    for (const text of ['1 + 1', ':exec main', ' :sh ls']) {
      assert.match(await reason(backend.evaluate(doc, text)), /^Evaluate Selection needs IDE mode \(Idris 2: Switch Backend…\): idris2-lsp evaluates in the file it loaded last/u);
    }
    assert.strictEqual(backend.tokens(doc), undefined);
    assert.deepStrictEqual(client.sent, []);
  });

  test('browseNamespace: the names of the namespace visible from the file, after loading it; "name : type" split at its first " : "', async () => {
    const client = new ReplayClient(lspExchanges('features-cross'), []);
    const backend = backendOver(client, 'features-cross');
    const doc = asDoc(lspDocument('features-cross', 'src/Foo/B.idr'));
    assert.deepStrictEqual(await backend.browseNamespace(doc, 'Foo.A'), [{ name: 'shout', signature: { text: 'shout : String -> String', spans: [] } }]);
    assert.deepStrictEqual(await backend.browseNamespace(doc, 'Data.Vect'), []);
    assert.deepStrictEqual(
      client.sent.map((s) => s.method),
      ['textDocument/documentSymbol', 'workspace/executeCommand', 'textDocument/documentSymbol', 'workspace/executeCommand'],
    );
  });

  test('browseNamespace: an answer of another shape is a ProtocolError; a document not on disk is refused unsent', async () => {
    const client = new ScriptedClient((method) => (method === 'textDocument/documentSymbol' ? [] : [{ kind: 12 }]));
    const backend = backendOver(client, 'features-cross');
    await assert.rejects(backend.browseNamespace(asDoc(lspDocument('features-cross', 'src/Foo/B.idr')), 'Foo.A'), (e: unknown) => e instanceof IdrisException && e.error.kind === 'ProtocolError');
    const untitled = new FakeDocument(`${LSP_ROOT}/Untitled-1`, 'x = 1', 'idris2', 'untitled');
    const quiet = new ScriptedClient(() => assert.fail('nothing may be sent'));
    assert.match(await reason(backendOver(quiet, 'features-cross').browseNamespace(asDoc(untitled), 'Foo.A')), /a file saved on disk only/u);
    assert.match(await reason(backendOver(quiet, 'features-cross').holes(asDoc(untitled))), /a file saved on disk only/u);
  });

  test('requests name the document as the server is sent it (serverUri: the real path of its folder), not as VS Code names it', async () => {
    const client = new ScriptedClient((method) => (method === 'textDocument/documentSymbol' ? [] : method === 'textDocument/codeAction' ? [] : []));
    Object.assign(client, {
      serverUri: (uri: vscode.Uri) => `file:///real${uri.fsPath}`,
      documentUri: (value: string) => FakeUri.parse(value.replace('file:///real/', 'file:///')),
    });
    const backend = backendOver(client, 'actions-clean');
    const doc = lspDocument('actions-clean', 'src/Clean.idr');
    await backend.browseNamespace(asDoc(doc), 'Clean');
    await assert.rejects(backend.edit({ kind: 'caseSplit', doc: asDoc(doc), version: doc.version, pos: { line: 7, character: 5 } as vscode.Position, name: 'xs' }));
    const named = client.sent.map((m) => (m.params as { textDocument?: { uri?: string } }).textDocument?.uri).filter((u) => u !== undefined);
    assert.ok(named.length >= 2, JSON.stringify(client.sent));
    assert.deepStrictEqual([...new Set(named)], [`file:///real${doc.fileName}`]);
  });

  test('the holes\' locations the server gives under its URIs are the document\'s', async () => {
    const doc = lspDocument('actions-clean', 'src/Clean.idr');
    const server = `file:///real${doc.fileName}`;
    const metavar = { name: 'Clean.vlen_rhs', location: { uri: server, range: { start: { line: 7, character: 10 }, end: { line: 7, character: 19 } } }, type: 'Nat', premises: [] };
    const client = new ScriptedClient((method) => (method === 'textDocument/documentSymbol' ? [] : [metavar]));
    Object.assign(client, {
      serverUri: (uri: vscode.Uri) => `file:///real${uri.fsPath}`,
      documentUri: (value: string) => FakeUri.parse(value.replace('file:///real/', 'file:///')),
    });
    const holes = await backendOver(client, 'actions-clean').holes(asDoc(doc));
    assert.deepStrictEqual(holes.map((h) => [h.name, h.location?.uri.toString()]), [['vlen_rhs', doc.uri.toString()]]);
  });

  test('dispose forgets the searches: a Next after it is refused', async () => {
    const client = new ReplayClient(lspExchanges('actions-clean'));
    const backend = backendOver(client, 'actions-clean');
    const doc = lspDocument('actions-clean', 'src/Clean.idr');
    const first = await backend.edit({ kind: 'exprSearch', doc: asDoc(doc), version: doc.version, pos: { line: 7, character: 10 } as vscode.Position, name: 'vlen_rhs', hints: [] });
    assert.strictEqual(first.type, 'edit');
    backend.dispose();
    assert.match(
      await reason(backend.edit({ kind: 'exprSearchNext', doc: asDoc(doc), version: doc.version, previous: { start: { line: 7, character: 10 }, end: { line: 7, character: 11 } } })),
      /^Next Result: the search it would continue has ended/u,
    );
  });
});
