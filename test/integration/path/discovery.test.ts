// Suite `toolchain-path` (.vscode-test.mjs): no idris2.toolchain.* settings; test/fake-tools/bin
// is prepended to PATH, so the search finds the fake tools through PATH (the first step after
// the settings) before any installed toolchain.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { ToolLocation } from '../../../src/toolchain/types';
import { fakeLauncher, type FakeTool } from '../../fake-tools/paths';
import { extensionApi, settledScan, statusText, waitFor, workspaceFile } from '../support';

/** Windows file names are case-insensitive, and the search appends a PATHEXT extension. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertFoundOnPath(tool: FakeTool, location: ToolLocation | undefined): void {
  assert.ok(location, `${tool} was not found`);
  assert.strictEqual(location.source, 'PATH', JSON.stringify(location));
  assert.ok(samePath(location.path, fakeLauncher(tool)), `${tool}: ${location.path} is not ${fakeLauncher(tool)}`);
}

suite('toolchain found through PATH (no settings)', () => {
  let api: TestApi;

  suiteSetup(async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(workspaceFile('Hello.idr')));
    api = await extensionApi();
    await settledScan(api, 'the first scan');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('no toolchain setting is set in this suite', () => {
    const settings = api.toolchain.current?.settings;
    assert.deepStrictEqual(
      settings && [settings.idris2Path, settings.lspPath, settings.packPath],
      ['', '', ''],
    );
  });

  test('idris2, idris2-lsp and pack are the fakes, found on PATH', () => {
    const snapshot = api.toolchain.current;
    assert.ok(snapshot);
    assert.ok(snapshot.idris2.status === 'probed', JSON.stringify(snapshot.idris2));
    assertFoundOnPath('idris2', snapshot.idris2.location);
    assert.ok(snapshot.lsp.status === 'probed', JSON.stringify(snapshot.lsp));
    assertFoundOnPath('idris2-lsp', snapshot.lsp.location);
    assert.ok(snapshot.pack.status === 'found', JSON.stringify(snapshot.pack));
    assertFoundOnPath('pack', snapshot.pack.info.location);
    assert.strictEqual(snapshot.verdict?.kind, 'compatible');
  });

  test('the status item and Setup Information report it; the fake found on PATH checks Hello.idr (M2)', async () => {
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · ✓');
    await vscode.commands.executeCommand('idris2.showSetupInformation');
    const editor = await waitFor('the Setup Information editor', () =>
      vscode.window.activeTextEditor?.document.uri.scheme === 'idris2-setup' ? vscode.window.activeTextEditor : undefined,
    );
    const text = editor.document.getText();
    assert.ok(text.includes('- idris2Path: (empty: discover)'), text);
    assert.ok(text.includes('- Found by: PATH'), text);
  });
});
