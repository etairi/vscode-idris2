// Suite `integration` (workspace test/fixtures/workspaces/loose-file), M3: semantic tokens and hover
// on the bird-track file Lit.lidr through the fake compiler (transcripts load-lit, lit-lookups).
// The compiler's columns are those of the unlit text, 2 left of the file's (F11): the reply
// (0 0)–(0 6) for `module` is the file's column 2, and a hover at file column 9 asks for column 7;
// its lines are the file's plus one per `> `/`>   ` line above (F11 addendum).
// ROADMAP §5 M3 acceptance: "on Lit.lidr the module token starts at column 2" (the acceptance
// names literate/Lit.lidr; the fixture is loose-file/Lit.lidr).
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import {
  extensionApi,
  FakeLogs,
  hoverWith,
  loadedIn,
  semanticTokensWhen,
  setToolchainSetting,
  settledScan,
  showFile,
  tokenAt,
  workspaceFile,
} from './support';

suite('M3 on Lit.lidr: tokens and hover in file columns (F11)', () => {
  let api: TestApi;
  let logs: FakeLogs;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('`> module Lit`: the module keyword token starts at column 2, the module name at 9; no token on the prose line', async () => {
    const doc = await showFile('Lit.lidr');
    const tokens = await semanticTokensWhen(doc.uri, 'the module keyword', (t) => tokenAt(t, 0, 2) !== undefined);
    assert.deepStrictEqual(tokenAt(tokens, 0, 2), { line: 0, character: 2, length: 6, type: 'keyword', modifiers: 0 });
    assert.deepStrictEqual(tokenAt(tokens, 0, 9), { line: 0, character: 9, length: 3, type: 'module', modifiers: 0 });
    assert.ok(!tokens.some((t) => t.line === 2), 'a token on the prose line');
    assert.ok(tokens.every((t) => t.character >= 2), JSON.stringify(tokens));
  });

  test('hover on n in `> double n = n + n` (file column 9) asks (:type-of "n" 6 7) and shows "n : Nat"', async () => {
    const doc = await showFile('Lit.lidr');
    await loadedIn(api, workspaceFile().fsPath, doc.uri.fsPath);
    await hoverWith(doc.uri, new vscode.Position(5, 9), 'n : Nat');
    assert.ok(
      logs.requestsOf('check').some((r) => /^\(\(:type-of "n" 6 7\) [0-9]+\)\n$/.test(r.request)),
      JSON.stringify(logs.requestsOf('check')),
    );
  });

  test('below `> ` and `>   ` (two lines each of the unlit text, F11 addendum): hover on glue asks line 9; on `++` right after `xs`, one column further', async () => {
    const doc = await showFile('Lit.lidr');
    await loadedIn(api, workspaceFile().fsPath, doc.uri.fsPath);
    assert.strictEqual(doc.lineAt(8).text, '> glue xs ys = xs++ys');
    await hoverWith(doc.uri, new vscode.Position(7, 3), 'Lit.glue : List Nat -> List Nat -> List Nat');
    // (:type-of "++" 10 15) answers the local `xs` [live, lit-lookups]; 10 16 the operator.
    const plus = await hoverWith(doc.uri, new vscode.Position(8, 17), 'Prelude.List.(++) : List a -> List a -> List a');
    assert.ok(!plus.value.includes('Name-based lookup'), plus.value);
    const sent = logs.requestsOf('check').map((r) => r.request);
    for (const request of ['(:type-of "glue" 9 0)', '(:type-of "++" 10 15)', '(:type-of "++" 10 16)']) {
      assert.ok(sent.some((r) => r.startsWith(`(${request} `)), `${request} not sent: ${JSON.stringify(sent)}`);
    }
  });
});
