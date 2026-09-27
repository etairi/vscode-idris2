import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

function fixture(name: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder (test/fixtures/workspaces/loose-file) is missing');
  return path.join(folder.uri.fsPath, name);
}

/**
 * Asserts that `expected` occurs in `actual` in order. VS Code merges the ranges of every
 * selection-range provider with its own (e.g. the whole line, which in a `.lidr` file includes
 * the bird-track marker), so the chain it reports can contain ranges between ours.
 */
function assertInOrder(actual: string[], expected: string[]): void {
  let k = 0;
  for (const text of actual) {
    if (text === expected[k]) {
      k++;
    }
  }
  assert.strictEqual(k, expected.length, `expected ${JSON.stringify(expected)} in order within ${JSON.stringify(actual)}`);
}

/** The selected texts for `position`, innermost first, as VS Code's Expand Selection sees them. */
async function selections(doc: vscode.TextDocument, position: vscode.Position): Promise<string[]> {
  const result = await vscode.commands.executeCommand<vscode.SelectionRange[]>(
    'vscode.executeSelectionRangeProvider',
    doc.uri,
    [position],
  );
  assert.strictEqual(result.length, 1);
  const texts: string[] = [];
  for (let s: vscode.SelectionRange | undefined = result[0]; s !== undefined; s = s.parent) {
    texts.push(doc.getText(s.range));
  }
  return texts;
}

suite('selection ranges', () => {
  test('ROADMAP M0: on `vlen (x :: xs) = ?rhs` the ranges grow token → parenthesised group → clause', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('Vlen.idr'));
    const line = 7;
    assert.strictEqual(doc.lineAt(line).text, 'vlen (x :: xs) = ?rhs');
    const texts = await selections(doc, new vscode.Position(line, doc.lineAt(line).text.indexOf('x')));
    assertInOrder(texts, [
      'x',
      'x :: xs',
      '(x :: xs)',
      'vlen (x :: xs) = ?rhs',
      [
        '||| The length of a vector, by recursion (the selection-range fixture of docs/ROADMAP.md M0).',
        'vlen : Vect n a -> Nat',
        'vlen [] = 0',
        'vlen (x :: xs) = ?rhs',
      ].join('\n'),
      doc.getText(),
    ]);
  });

  test('.lidr: the bird-track marker is not part of the clause', async () => {
    const doc = await vscode.workspace.openTextDocument(fixture('Lit.lidr'));
    const line = 5;
    assert.strictEqual(doc.lineAt(line).text, '> double n = n + n');
    const texts = await selections(doc, new vscode.Position(line, doc.lineAt(line).text.indexOf('n =')));
    // Only our provider can contribute `double n = n + n`: VS Code's own additions between two
    // ranges on different lines start at the line's first non-whitespace character (here the
    // `>`) or at column 0 (`provideSelectionRanges` with selectLeadingAndTrailingWhitespace,
    // VS Code 1.139.1 workbench bundle), so they add `> double n = n + n` after it.
    assertInOrder(texts, [
      'n',
      'double n = n + n',
      '> double n = n + n',
      'double : Nat -> Nat\n> double n = n + n',
      doc.getText(),
    ]);
  });
});
