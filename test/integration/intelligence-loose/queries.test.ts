// Suite `intelligence-loose` (.vscode-test.mjs): workspace test/fixtures/workspaces/broken (loose
// files; the session directory is the workspace folder, so no consent question), the fake tools,
// the default transport (stdio). ROADMAP §5 M3 acceptance, integration part, on Clean.idr (the F30
// fixture, transcripts clean-lookups and clean-queries): the type of the pattern variable xs as a
// hover and as an inlay hint, completion of `vl`; and E14 on Unicode.idr (transcript
// unicode-columns): the compiler counts columns in code points, VS Code in UTF-16 units, so a
// position after an astral character must be converted both ways. Positions are 0-based.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import {
  assertUntrustedMarkdown,
  completionLabels,
  extensionApi,
  FakeLogs,
  hintLabel,
  hoverWith,
  inlayHints,
  loadedIn,
  semanticTokensWhen,
  setToolchainSetting,
  setUserSetting,
  settledScan,
  showFile,
  tokenAt,
  waitForAsync,
  workspaceFile,
} from '../support';

const root = (): string => workspaceFile().fsPath;

suite('M3 queries on loose files (fake compiler replaying the 0.8.0 transcripts)', () => {
  let api: TestApi;
  let logs: FakeLogs;

  /** The requests (texts without the id) the check session read. */
  const checkRequests = (): string[] =>
    logs.requestsOf('check').map((r) => /^\((.*) [0-9]+\)\n$/s.exec(r.request)?.[1] ?? r.request);

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('hover on xs in `vlen xs = ?vlen_rhs`: "xs : Vect ?_ ?_" (F30), from (:type-of "xs" 8 5)', async () => {
    const doc = await showFile('Clean.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    assertUntrustedMarkdown(await hoverWith(doc.uri, new vscode.Position(7, 5), 'xs : Vect ?_ ?_'));
    assert.ok(checkRequests().includes('(:type-of "xs" 8 5)'), JSON.stringify(checkRequests()));
  });

  test('inlay hint ": Vect ?_ ?_" right after xs (a type hint); with unsaved changes it stays with its token', async () => {
    const doc = await showFile('Clean.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    const xsHint = (hints: vscode.InlayHint[]): vscode.InlayHint | undefined =>
      hints.find((h) => h.position.line === 7 && h.position.character === 7);
    const hint = await waitForAsync('the inlay hint after xs', async () => xsHint(await inlayHints(doc)));
    assert.strictEqual(hintLabel(hint), ': Vect ?_ ?_');
    assert.strictEqual(hint.kind, vscode.InlayHintKind.Type);
    // Unsaved text: the hint kept from the saved file moves with its token, one line down under an
    // inserted line (third review of M3; until then none was shown while the document had unsaved
    // changes, so every hinted line shifted at the first keystroke).
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor?.document === doc);
    try {
      assert.ok(await editor.edit((e) => e.insert(new vscode.Position(6, 0), '-- unsaved\n')));
      const moved = (await inlayHints(doc)).find((h) => h.position.line === 8 && h.position.character === 7);
      assert.strictEqual(moved === undefined ? undefined : hintLabel(moved), ': Vect ?_ ?_');
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    assert.ok(!doc.isDirty);
    await waitForAsync('the hint after the revert', async () => xsHint(await inlayHints(doc)));
  });

  test('idris2.inlayHints.variableTypes = false: no hints', async () => {
    const doc = await showFile('Clean.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    await waitForAsync('a hint first', async () => ((await inlayHints(doc)).length > 0 ? true : undefined));
    await setUserSetting('inlayHints', 'variableTypes', false);
    try {
      await waitForAsync('no hints', async () => ((await inlayHints(doc)).length === 0 ? true : undefined));
    } finally {
      await setUserSetting('inlayHints', 'variableTypes', undefined);
    }
  });

  test('completion after `vl` offers vlen and vlen_rhs, from (:repl-completions "vl")', async () => {
    const doc = await showFile('Clean.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    // `vlen xs = ?vlen_rhs`, the cursor after `vl`.
    const labels = await completionLabels(doc.uri, new vscode.Position(7, 2));
    assert.ok(labels.includes('vlen') && labels.includes('vlen_rhs'), JSON.stringify(labels));
    assert.strictEqual(new Set(labels).size, labels.length, `duplicates in ${JSON.stringify(labels)}`);
    assert.ok(checkRequests().includes('(:repl-completions "vl")'), JSON.stringify(checkRequests()));
  });

  test('E14: after two astral characters (UTF-16 column 20 = code point 18) hover and token find s', async () => {
    // Line 15: `astral s = ("𝕟𝕟", s)`; each U+1D55F is 2 UTF-16 units, 1 code point.
    const doc = await showFile('Unicode.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    assert.strictEqual(doc.lineAt(14).text.indexOf(', s)') + 2, 20);
    const tokens = await semanticTokensWhen(doc.uri, 's after the string', (t) => tokenAt(t, 14, 20) !== undefined);
    assert.deepStrictEqual(tokenAt(tokens, 14, 20), { line: 14, character: 20, length: 1, type: 'variable', modifiers: 0 });
    // The string literal: code points 12–16 of the reply are UTF-16 units 12–18.
    assert.strictEqual(tokenAt(tokens, 14, 12)?.length, 6);
    await hoverWith(doc.uri, new vscode.Position(14, 20), 's : String');
    // The request counts code points: 18, not the UTF-16 column 20 nor the UTF-8 byte column 24.
    assert.ok(checkRequests().includes('(:type-of "s" 15 18)'), JSON.stringify(checkRequests()));
    // Line 12, `α x₁ y = x₁ + y`: BMP characters only, so both counts agree; y is at 5 and 14.
    await hoverWith(doc.uri, new vscode.Position(11, 14), 'y : ℕ');
  });
});
