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
  // Doc.idr.md opens in the Markdown mode and is selected by the `**/*.idr.md` pattern row (M1),
  // a row matched against the file path; Notes.md is plain Markdown.
  const cases: [string, boolean][] = [
    ['Hello.idr', true],
    ['Lit.lidr', true],
    ['Doc.idr.md', true],
    ['Notes.md', false],
  ];
  for (const [file, expected] of cases) {
    test(`${file}: isIdrisDocument and idrisDocumentSelector() both say ${expected}`, async () => {
      const doc = await vscode.workspace.openTextDocument(fixture(file));
      if (file.endsWith('.md')) {
        assert.strictEqual(doc.languageId, 'markdown');
      }
      assert.strictEqual(isIdrisDocument(doc), expected);
      assert.strictEqual(vscode.languages.match(idrisDocumentSelector(), doc) > 0, expected);
    });
  }
});
