// Suite `lsp` (.vscode-test.mjs; ROADMAP §5 M5, acceptance): what the language client shows of the
// server's answers for a document of the package — a hover as untrusted text (the M3 rules), and a
// document with unsaved changes, for which the server cancels the semantic tokens (`RequestCancelled`,
// `Document Dirty` [live, recording `dirty`]) without anything being shown to the user. Against the
// fake idris2-lsp (test/fake-lsp), whose message log shows which recording answered.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import {
  answerMessages,
  assertUntrustedMarkdown,
  extensionApi,
  hovers,
  hoverWith,
  saveUnchanged,
  semanticTokensWhen,
  settledScan,
  setToolchainSetting,
  waitFor,
} from '../support';
import { FakeLspLogs, opened, showDocument, source, useLogs } from './support';

suite('M5 language client: the server\'s answers for a document (fake idris2-lsp)', () => {
  let api: TestApi;
  let logs: FakeLspLogs;
  const clean = source('Clean.idr');
  const XS = new vscode.Position(7, 5);

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLspLogs();
    await useLogs(api, logs);
    await showDocument(clean);
    await opened(logs, clean);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('a hover shows the server\'s type rebuilt as untrusted text: not trusted, no HTML, no theme icons', async () => {
    const hover = await hoverWith(clean, XS, 'xs : Vect ?_ ?_');
    assertUntrustedMarkdown(hover);
    // The server's own markdown (recording `dirty`) is not shown as it came.
    assert.notStrictEqual(hover.value, '```idris\nxs : Vect ?_ ?_\n```');
    for (const markdown of await hovers(clean, XS)) {
      assertUntrustedMarkdown(markdown);
    }
    const answered = logs.about(clean).filter((m) => m.message.method === 'textDocument/hover').map((m) => m.replay);
    assert.ok(answered.some((r) => r !== null && /^[a-z0-9-]+:\d+$/.test(r)), JSON.stringify(answered));
  });

  test('unsaved changes: the server cancels the semantic tokens (RequestCancelled), no notification is shown; after the save they come back', async () => {
    const editor = await showDocument(clean);
    const doc = editor.document;
    const shown = answerMessages(() => undefined);
    try {
      const from = logs.messages().length;
      // A change away from the positions the recordings ask about, not saved.
      const insert = new vscode.WorkspaceEdit();
      insert.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, '-- unsaved\n');
      assert.ok(await vscode.workspace.applyEdit(insert));
      await waitFor('the change to reach the server', () => logs.about(clean, from).find((m) => m.message.method === 'textDocument/didChange'));
      // VS Code asks for the tokens of a changed document itself; ask once more, so that one request follows the change.
      try {
        await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', clean);
      } catch {
        // A cancelled provider may reject the command; what counts is below.
      }
      const cancelled = await waitFor('a semantic-tokens request answered with the dirty recording', () =>
        logs.about(clean, from).find((m) => m.message.method === 'textDocument/semanticTokens/full' && m.replay?.startsWith('dirty:')),
      );
      assert.ok(cancelled);
      // The server answers null to a hover of a dirty document; once this round trip is over, any
      // notification the cancelled request caused would have been shown.
      assert.deepStrictEqual(
        (await hovers(clean, XS)).filter((m) => m.value.includes('Vect')),
        [],
        'a hover of the dirty document',
      );
      assert.deepStrictEqual(shown.asked, [], 'notifications were shown');
      // Back to the saved text, and saved: the server keeps a document dirty until it is told of a save (test/fake-lsp/README.md).
      await vscode.commands.executeCommand('workbench.action.files.revert');
      const beforeSave = logs.messages().length;
      await saveUnchanged(doc);
      await waitFor('the save to reach the server', () => logs.about(clean, beforeSave).find((m) => m.message.method === 'textDocument/didSave'));
      await semanticTokensWhen(clean, 'the server\'s tokens again', (tokens) => tokens.length > 0);
      assert.deepStrictEqual(shown.asked, [], 'notifications were shown');
    } finally {
      shown.restore();
    }
  });
});
