import * as assert from 'assert';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';

/**
 * Editor behaviour that only VS Code itself can show: which language configuration governs
 * Enter on a `.lidr` code line, and which characters Ctrl+D (the same word boundaries as
 * double-click) treats as part of a word. The regexes themselves are unit-tested in
 * test/unit/languageConfiguration.test.ts; these tests pin the manifest wiring around them.
 */

/** Opens an untitled document of `language` in an editor; nothing is written to disk. */
async function editorWith(language: string, content: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument({ language, content });
  return vscode.window.showTextDocument(doc);
}

/**
 * Puts the cursor at the end of line `line` and presses Enter there, through the same routine
 * a typed Enter runs. In VS Code 1.139.1 a typed `\n` becomes `_enter(config, model, false,
 * selection)` and `editor.action.insertLineAfter` becomes `_enter(config, model, false,
 * <empty range at the end of the cursor's line>)` [src: the `getEdits` and `lineInsertAfter`
 * methods of the same class in its workbench bundle], so for a cursor at the end of a line the
 * two are the same edit, onEnterRules included. The `type` command is not used: it acts only
 * on the *focused* code editor (`getFocusedCodeEditor()`, same bundle), and when the test
 * window starts behind another application (`vscode.window.state.focused` false) that is
 * sometimes no editor at all: with `type`, 2 of the Enter tests failed in 1 of 2 runs even
 * with the chat setting of .vscode-test.mjs. The action goes to the focused code editor too,
 * but falls back to the active editor when no code editor has focus; the chat setting keeps
 * the chat input from holding the focus, and the tests need both.
 */
async function enterAtEndOf(editor: vscode.TextEditor, line: number): Promise<void> {
  const end = editor.document.lineAt(line).range.end;
  editor.selection = new vscode.Selection(end, end);
  await vscode.commands.executeCommand('editor.action.insertLineAfter');
}

/**
 * VS Code reads a language's configuration file asynchronously when the language is first
 * shown in an editor, and Enter typed before that gets no rules: without this wait the first
 * `.lidr` test failed in 2 of 3 runs (the new line was empty), and after one warm-up editor it
 * passed in 3 of 3. This waits until Enter after the one-line `probe` yields `expected`,
 * undoing each attempt, and fails if that does not happen within 10 s.
 */
async function waitForEnterRules(language: string, probe: string, expected: string): Promise<void> {
  const editor = await editorWith(language, probe);
  const start = performance.now();
  try {
    for (;;) {
      await enterAtEndOf(editor, 0);
      const got = editor.document.lineAt(1).text;
      if (got === expected) {
        return;
      }
      await vscode.commands.executeCommand('undo');
      assert.ok(
        performance.now() - start < 10_000,
        `the ${language} Enter rules did not apply within 10 s: Enter after ${JSON.stringify(probe)} gave ${JSON.stringify(got)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

/** Places the cursor inside the first occurrence of `needle` (at `offset`) and runs Ctrl+D. */
async function ctrlDAt(editor: vscode.TextEditor, needle: string, offset: number): Promise<string> {
  const index = editor.document.getText().indexOf(needle);
  assert.ok(index >= 0, `${JSON.stringify(needle)} not in the document`);
  const position = editor.document.positionAt(index + offset);
  editor.selection = new vscode.Selection(position, position);
  await vscode.commands.executeCommand('editor.action.addSelectionToNextFindMatch');
  return editor.document.getText(editor.selection);
}

suite('editor behaviour in VS Code', () => {
  suiteSetup(async () => {
    await waitForEnterRules('idris2', 'x = do', '  ');
    await waitForEnterRules('lidr', '> x = do', '>   ');
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('.idr: Enter after a line ending in `where` indents the next line', async () => {
    const editor = await editorWith('idris2', 'f : Nat\nf = g where');
    await enterAtEndOf(editor, 1);
    assert.strictEqual(editor.document.lineAt(2).text, '  ');
  });

  // Needs the lidr grammar NOT to map its code lines to the language idris2
  // (contributes.grammars[].embeddedLanguages): VS Code picks the Enter rules by the language
  // of the token at the cursor, so with that mapping the idris2 rules ran on code lines and the
  // bird-track marker was never continued (observed in VS Code 1.139.1).
  test('.lidr: Enter on a bird-track code line continues the marker', async () => {
    const editor = await editorWith('lidr', 'Prose.\n\n> f : Nat');
    await enterAtEndOf(editor, 2);
    assert.strictEqual(editor.document.lineAt(3).text, '> ');
  });

  test('.lidr: Enter after `where` on a code line continues the marker and indents', async () => {
    const editor = await editorWith('lidr', '> f : Nat\n> f = g where');
    await enterAtEndOf(editor, 1);
    assert.strictEqual(editor.document.lineAt(2).text, '>   ');
  });

  test('.lidr: Enter on a prose line adds no marker', async () => {
    const editor = await editorWith('lidr', 'Some prose.');
    await enterAtEndOf(editor, 0);
    assert.strictEqual(editor.document.lineAt(1).text, '');
  });

  // folding.offSide in language-configuration/idris2.json: the blank line after a block belongs
  // to the next block, so folding `f = g` hides the where block but not the blank line.
  test('.idr: indentation folding folds a `where` block, leaving the blank line after it', async () => {
    const editor = await editorWith('idris2', 'f : Nat\nf = g\n  where\n    g : Nat\n    g = 1\n\nh : Nat\nh = 2');
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    // The folding model is computed asynchronously after the document opens; retry until the
    // fold takes effect (deadline 10 s).
    const start = performance.now();
    while (editor.visibleRanges.length < 2 && performance.now() - start < 10_000) {
      await vscode.commands.executeCommand('editor.fold');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const visible = editor.visibleRanges.map((r) => [r.start.line, r.end.line]);
    assert.deepStrictEqual(visible, [
      [0, 1],
      [5, 7],
    ]);
  });

  // editor.wordSeparators from contributes.configurationDefaults: double-click and Ctrl+D use
  // it, not the language configuration's wordPattern.
  for (const language of ['idris2', 'lidr']) {
    const prefix = language === 'lidr' ? '> ' : '';
    test(`${language}: Ctrl+D inside \`?hole\` selects \`?hole\`, inside \`x'\` selects \`x'\``, async () => {
      const editor = await editorWith(language, `${prefix}f x' = ?hole x'`);
      assert.strictEqual(await ctrlDAt(editor, '?hole', 2), '?hole');
      assert.strictEqual(await ctrlDAt(editor, "x'", 1), "x'");
    });
  }
});
