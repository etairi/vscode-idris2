// Suite `simple-ipkg` (.vscode-test.mjs): the workspace folder is test/fixtures/workspaces/
// simple-ipkg/src, *inside* the package, so its .ipkg lies above the folder. ROADMAP M1
// acceptance: Foo/B.idr still belongs to the simple-ipkg root, and the planned session cwd is
// the .ipkg directory — the compiler's findIpkg walks up to the file-system root (F13), and the
// workspace folder only limits which roots the UI lists. Because the .ipkg lies outside the
// workspace folder, which is all that workspace trust covers, the index reads it with the
// built-in reader and runs no --dump-ipkg-json there (ROADMAP M1 As built).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { extensionApi, settledScan, statusText, waitFor, workspaceFile } from '../support';

suite('simple-ipkg opened at its src folder', () => {
  let api: TestApi;
  let file: string;
  let packageDir: string;
  let ipkg: string;

  suiteSetup(async () => {
    const uri = workspaceFile('Foo', 'B.idr');
    file = uri.fsPath;
    // The workspace folder has no .ipkg, so opening an Idris document is what activates us.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    packageDir = path.dirname(workspaceFile().fsPath);
    const ipkgs = fs.readdirSync(packageDir).filter((name) => name.endsWith('.ipkg'));
    assert.strictEqual(ipkgs.length, 1, `expected one .ipkg in ${packageDir}: ${ipkgs.join(', ')}`);
    ipkg = path.join(packageDir, ipkgs[0]);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Foo/B.idr classifies to the .ipkg above the workspace folder; the session cwd is its directory', async () => {
    const root = await api.projects.classify(file);
    assert.ok(root.kind === 'project', JSON.stringify(root));
    assert.strictEqual(root.ipkgPath, ipkg);
    assert.strictEqual(root.dir, packageDir);
    assert.deepStrictEqual(root.otherIpkgs, []);
    assert.strictEqual(api.projects.sessionCwd(root), packageDir);
    assert.strictEqual(api.projects.pathToModule(root, file), 'Foo.B');
  });

  test('the .ipkg outside the folder is read by the built-in reader: sourcedir "src", depends contrib', async () => {
    const root = await api.projects.classify(file);
    assert.ok(root.kind === 'project');
    assert.strictEqual(root.insideWorkspace, false);
    assert.ok(root.model.status === 'ok', JSON.stringify(root.model));
    assert.strictEqual(root.model.source, 'fallback');
    assert.strictEqual(root.model.model.sourcedir, 'src');
    assert.deepStrictEqual(
      root.model.model.depends.map((d) => d.name),
      ['contrib'],
    );
  });

  test('the UI lists no project (the .ipkg is outside the workspace folder), but the status names the root', async () => {
    assert.deepStrictEqual(await api.projects.roots(), []);
    await waitFor('the status detail to name the project', () =>
      api.statusItem.detail?.includes(`project “${ipkg}” (outside the workspace folders: read without the compiler)`) ? true : undefined,
    );
    // M2: checking Foo/B.idr waits for the user's permission to start the compiler in the
    // package directory, which lies outside the folder (the consent suite answers it).
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · checking…');
    assert.match(api.statusItem.detail ?? '', /waiting for your permission to start the compiler in /);
  });

  test('Setup Information shows the active document\'s root and module', async () => {
    await vscode.commands.executeCommand('idris2.showSetupInformation');
    const text = vscode.window.activeTextEditor?.document.getText() ?? '';
    for (const expected of [
      'No .ipkg file inside the workspace folders.',
      `- \`${file}\``,
      `- Belongs to: project \`${ipkg}\`, outside the workspace folders`,
      '- Module name: `Foo.B`',
      `- Session working directory: \`${packageDir}\``,
    ]) {
      assert.ok(text.includes(expected), `missing ${JSON.stringify(expected)} in:\n${text}`);
    }
  });
});
