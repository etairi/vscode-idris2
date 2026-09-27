import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * No publisher is set yet (docs/ROADMAP.md Q1), so the extension's id is not stable
 * (VS Code reports `undefined_publisher.vscode-idris2`). Look it up by package name instead.
 */
function findExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find(
    (e) => (e.packageJSON as { name?: string }).name === 'vscode-idris2',
  );
  assert.ok(ext, 'extension "vscode-idris2" not found in vscode.extensions.all');
  return ext;
}

suite('activation', () => {
  test('the extension is present and activates', async () => {
    const ext = findExtension();
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('idris2.showOutput is registered and runs', async () => {
    await findExtension().activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('idris2.showOutput'), 'idris2.showOutput missing from getCommands()');
    await vscode.commands.executeCommand('idris2.showOutput');
  });

  test('the fixture Hello.idr opens with language id idris2', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the test workspace folder (test/fixtures/workspaces/loose-file) is missing');
    const doc = await vscode.workspace.openTextDocument(path.join(folder.uri.fsPath, 'Hello.idr'));
    assert.strictEqual(doc.languageId, 'idris2');
  });
});
