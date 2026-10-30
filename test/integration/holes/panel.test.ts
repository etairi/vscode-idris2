// Suite `holes` (.vscode-test.mjs): the goal panel (ROADMAP M7) over the fake
// compiler, in the VS Code of every CI platform. Its script runs under the panel's
// Content-Security-Policy (its `rendered` message comes back with the page's text), and it draws the
// holes of holes-loose-main at the cursor. The real compiler's run is test/e2e/goalPanel.test.ts.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { extensionApi, FakeLogs, loadedIn, setToolchainSetting, settledScan, showFile, waitFor, workspaceFile } from '../support';

suite('M7 goal panel (fake compiler)', () => {
  let api: TestApi;
  let logs: FakeLogs;
  let editor: vscode.TextEditor;

  const cursorAt = (line: number, character: number): void => {
    editor.selection = new vscode.Selection(line, character, line, character);
  };
  const shown = (what: string, wanted: (text: string) => boolean): Promise<true> =>
    waitFor(
      () => `the page to show ${what}; it shows: ${api.goalPanel.rendered()?.text}`,
      () => (wanted(api.goalPanel.rendered()?.text ?? '') ? true : undefined),
    );

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
    const doc = await showFile('Main.idr');
    editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await loadedIn(api, workspaceFile().fsPath, doc.uri.fsPath);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('the toggle opens it beside the editor, which keeps the focus; its script runs under its Content-Security-Policy', async () => {
    await vscode.commands.executeCommand('idris2.toggleGoalPanel');
    assert.strictEqual(api.goalPanel.isOpen, true);
    await shown('the holes', (text) => /All holes \(3\)/.test(text));
    assert.strictEqual(vscode.window.activeTextEditor, editor);
  });

  test('it draws the hole at the cursor, and the holes of both modules', async () => {
    cursorAt(5, 12);
    await shown('?todo', (text) => /\?todo/.test(text) && /ns : List Nat/.test(text));
    assert.deepStrictEqual(
      [api.goalPanel.state()?.goal?.label, api.goalPanel.state()?.goal?.type, api.goalPanel.state()?.goal?.premises.map((p) => p.text)],
      ['?todo', 'Nat', ['ns : List Nat']],
    );
    assert.deepStrictEqual(api.goalPanel.state()?.holes.map((row) => row.label).sort(), ['?size_rhs', '?todo', '?todo']);
    cursorAt(8, 9);
    await shown('?size_rhs', (text) => /\?size_rhs/.test(text) && !/ns : List Nat/.test(text));
    assert.strictEqual(api.goalPanel.state()?.goal?.label, '?size_rhs');
  });

  test('the row of the other file\'s hole opens it in the editor\'s group', async () => {
    const state = api.goalPanel.state();
    const index = state?.holes.findIndex((row) => row.place.startsWith('Base.idr')) ?? -1;
    assert.ok(state !== undefined && index >= 0, JSON.stringify(state?.holes));
    await api.goalPanel.receive({ type: 'hole', version: state.version, index });
    await waitFor(
      () => `Base.idr to open; active: ${vscode.window.activeTextEditor?.document.fileName}`,
      () => (vscode.window.activeTextEditor?.document.fileName.endsWith('Base.idr') ? true : undefined),
    );
    assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
  });

  test('the toggle closes it', async () => {
    await vscode.commands.executeCommand('idris2.toggleGoalPanel');
    await waitFor(
      () => 'the panel to close',
      () => (api.goalPanel.isOpen ? undefined : true),
    );
  });
});
