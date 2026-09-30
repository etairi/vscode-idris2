// Suite `diagnostics` (socket transport in the user settings, ROADMAP §9 Q20), M3: the `eval`
// session follows the `check` session's transport rule (ROADMAP §9, 2026-09-28), so here it speaks
// the socket too. Through the fake compiler replaying the eval recordings (eval-socket, eval-values);
// the expression is typed as an unsaved comment line (the recordings are keyed by the saved file).
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { evaluateSelection, extensionApi, loadedIn, settledScan, showFile, workspaceFile } from '../support';

suite('M3 Evaluate Selection over the socket', () => {
  let api: TestApi;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('idris2.clearEvaluationResults');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('the (IO ()) (putStrLn "hi") shows MkIO (prim__putStr "hi\\n") from an eval session started with --ide-mode-socket', async () => {
    const root = workspaceFile().fsPath;
    const doc = await showFile('Clean.idr');
    await loadedIn(api, root, doc.uri.fsPath);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor?.document === doc);
    const expr = 'the (IO ()) (putStrLn "hi")';
    const line = doc.lineCount;
    assert.ok(await editor.edit((e) => e.insert(doc.lineAt(line - 1).range.end, `\n-- ${expr}`)));
    const shown = await evaluateSelection(api, editor, new vscode.Range(line, 3, line, 3 + expr.length));
    assert.deepStrictEqual([shown.kind, shown.text], ['value', 'MkIO (prim__putStr "hi\\n")']);
    const session = api.sessions.sessions().find((s) => s.role === 'eval' && s.cwd === root);
    assert.strictEqual(session?.launch?.transport, 'socket');
    assert.strictEqual(session.launch.args[0], '--ide-mode-socket');
  });
});
