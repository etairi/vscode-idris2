// Suite `intelligence` (.vscode-test.mjs), M6: check while typing on simple-ipkg's B.idr over the
// fake compiler, which replays the shadow-type-error and shadow-hole recordings (the real
// compiler's `shadow` session in a shadow directory holding the package file the extension writes
// and the copy, scripts/record-transcripts.mjs): the shadow session's directory, build directory,
// IDRIS2_PATH and first request; the unsaved text's diagnostics with source `idris2 (unsaved)`
// instead of the saved file's; the hole of the unsaved text in the Holes view; a revert shows the
// saved file's diagnostics again. The profile turns check while typing off (.vscode-test.mjs); this
// suite turns it on and restores it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { repoRoot } from '../../fake-tools/paths';
import { extensionApi, FakeLogs, loadedIn, setToolchainSetting, setUserSetting, settledScan, showFile, waitFor, workspaceFile } from '../support';

const root = (): string => workspaceFile().fsPath;
const shadowFixture = (workspace: string, file: string): string => fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', workspace, file), 'utf8');

suite('M6 check while typing on simple-ipkg (fake compiler replaying the 0.8.0 shadow transcripts)', () => {
  let api: TestApi;
  let logs: FakeLogs;
  let profileValue: unknown;
  let doc: vscode.TextDocument;

  const unsavedOf = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'idris2 (unsaved)');
  const shadow = () => api.sessions.sessions().find((s) => s.role === 'shadow' && s.state !== 'stopped' && s.state !== 'failed');

  /** Replaces line 6 (`greeting = …`) with `text`, unsaved, and waits for its check to be shown. */
  async function typeLine(text: string): Promise<void> {
    const editor = await vscode.window.showTextDocument(doc);
    assert.ok(await editor.edit((e) => e.replace(doc.lineAt(6).range, text)));
    const version = doc.version;
    await waitFor(`the check of the unsaved "${text}"`, () => (api.unsavedChecks.shownVersion(doc.uri) === version ? true : undefined), 20000);
  }

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
    profileValue = vscode.workspace.getConfiguration('idris2.checkOnType').inspect('enabled')?.globalValue;
    await setUserSetting('checkOnType', 'enabled', true);
  });

  suiteTeardown(async () => {
    if (doc?.isDirty === true) {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setUserSetting('checkOnType', 'enabled', profileValue);
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('a type error typed without saving: the shadow session (its own directory and build directory, the check session\'s TTCs, (:enable-syntax :False) first) reports it as idris2 (unsaved), and the saved diagnostics are hidden meanwhile', async () => {
    doc = await showFile('src', 'Foo', 'B.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    await typeLine('greeting = shout 5');
    assert.strictEqual(doc.getText(), shadowFixture('shadow-simple-error', 'src/Foo/B.idr'), 'the text the recording checked');
    const [d, ...more] = vscode.languages.getDiagnostics(doc.uri);
    assert.strictEqual(more.length, 0, 'only the unsaved check\'s');
    assert.deepStrictEqual([d.source, d.severity, d.range.start.line, d.range.start.character, d.range.end.character], ['idris2 (unsaved)', vscode.DiagnosticSeverity.Error, 6, 17, 18]);
    assert.match(d.message, /^While processing right hand side of greeting\. Can't find an implementation for Num String\./);
    const session = shadow();
    assert.ok(session?.launch !== undefined, 'a shadow session runs');
    const dir = session.launch.cwd;
    assert.strictEqual(path.dirname(dir), api.shadowBase);
    assert.deepStrictEqual(session.launch.args.slice(-2), ['--build-dir', path.join(dir, 'build')]);
    assert.strictEqual(session.launch.env.IDRIS2_PATH?.split(path.delimiter)[0], path.join(root(), 'build', '.vscode-idris2', 'ttc'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'shadow.ipkg'), 'utf8'), shadowFixture('shadow-simple-error', 'shadow.ipkg'));
    const requests = logs.requestsOf('shadow').map((r) => r.request);
    assert.match(requests[0] ?? '', /^\(\(:enable-syntax :False\) \d+\)\n$/);
    assert.ok(requests.some((r) => r.includes(`(:load-file "${fs.realpathSync(dir)}/src/Foo/B.idr")`)), requests.join(''));
  });

  test('?arg typed without saving: no error, and the hole arg is in the Holes view from the unsaved text', async () => {
    await typeLine('greeting = shout ?arg');
    assert.strictEqual(doc.getText(), shadowFixture('shadow-simple-hole', 'src/Foo/B.idr'));
    assert.deepStrictEqual(unsavedOf(doc.uri), []);
    const hole = await waitFor('the hole arg in the Holes view', () => api.holes.holesIn(doc.uri.fsPath).find((h) => h.name === 'arg'));
    assert.deepStrictEqual([hole.location?.range.start.line, hole.location?.range.start.character], [6, 17]);
  });

  test('a revert: the unsaved check\'s entry goes, and the saved file\'s diagnostics are shown again', async () => {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await waitFor('the unsaved entry to go', () => (unsavedOf(doc.uri).length === 0 && !doc.isDirty ? true : undefined));
    assert.deepStrictEqual(api.unsavedChecks.shownFor(doc.uri) ?? [], []);
    assert.deepStrictEqual(vscode.languages.getDiagnostics(doc.uri), [], 'the saved file is clean');
  });
});
