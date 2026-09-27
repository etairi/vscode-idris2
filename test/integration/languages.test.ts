import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

function fixture(name: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder (test/fixtures/workspaces/loose-file) is missing');
  return path.join(folder.uri.fsPath, name);
}

suite('languages', () => {
  test('.idr opens as idris2, .lidr as lidr, .md stays markdown', async () => {
    assert.strictEqual((await vscode.workspace.openTextDocument(fixture('Hello.idr'))).languageId, 'idris2');
    assert.strictEqual((await vscode.workspace.openTextDocument(fixture('Lit.lidr'))).languageId, 'lidr');
    assert.strictEqual((await vscode.workspace.openTextDocument(fixture('Notes.md'))).languageId, 'markdown');
  });

  test('.ipkg opens as ipkg', async () => {
    // Written outside the workspace: an .ipkg inside it would activate the extension through
    // workspaceContains:**/*.ipkg before the activation measurement, and loose-file has none.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-ipkg-'));
    try {
      const file = path.join(dir, 'Probe.ipkg');
      fs.writeFileSync(file, 'package probe\n');
      assert.strictEqual((await vscode.workspace.openTextDocument(file)).languageId, 'ipkg');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const languageId of ['idris2', 'lidr']) {
    test(`configurationDefaults for [${languageId}] are applied`, () => {
      const editor = vscode.workspace.getConfiguration('editor', { languageId });
      const expected: [string, unknown][] = [
        ['semanticHighlighting.enabled', true],
        ['unicodeHighlight.ambiguousCharacters', false],
        ['insertSpaces', true],
        ['tabSize', 2],
        // VS Code's default separators without `'` (primes: x') and `?` (holes: ?rhs).
        ['wordSeparators', '`~!@#$%^&*()-=+[{]}\\|;:",.<>/'],
      ];
      for (const [key, value] of expected) {
        assert.strictEqual(editor.inspect(key)?.defaultLanguageValue, value, `default of editor.${key}`);
        assert.strictEqual(editor.get(key), value, `effective editor.${key}`);
      }
    });
  }

  test('configurationDefaults: [lidr] defaults files.eol to LF for new files (idris2 joins the lines of a CRLF .lidr, F11)', () => {
    const files = vscode.workspace.getConfiguration('files', { languageId: 'lidr' });
    assert.strictEqual(files.inspect('eol')?.defaultLanguageValue, '\n');
    assert.strictEqual(files.get('eol'), '\n');
    // Plain .idr files are unaffected: the compiler accepts CRLF there.
    assert.strictEqual(vscode.workspace.getConfiguration('files', { languageId: 'idris2' }).inspect('eol')?.defaultLanguageValue, undefined);
  });
});
