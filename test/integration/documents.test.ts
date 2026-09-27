import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { idrisDocumentSelector, isIdrisDocument } from '../../src/project/literate';

function fixture(name: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder (test/fixtures/workspaces/loose-file) is missing');
  return path.join(folder.uri.fsPath, name);
}

// The `idris2.isIdrisDocument` context key cannot be read back through the extension API; its
// update logic is unit-tested in test/unit/literate.test.ts against a fake editor surface.
suite('Idris documents (one selector rule)', () => {
  const cases: [string, boolean][] = [
    ['Hello.idr', true],
    ['Lit.lidr', true],
    ['Notes.md', false],
  ];
  for (const [file, expected] of cases) {
    test(`${file}: isIdrisDocument and idrisDocumentSelector() both say ${expected}`, async () => {
      const doc = await vscode.workspace.openTextDocument(fixture(file));
      assert.strictEqual(isIdrisDocument(doc), expected);
      assert.strictEqual(vscode.languages.match(idrisDocumentSelector(), doc) > 0, expected);
    });
  }
});
