// Suite `editing`: Next Result (`n`) continues the document's cycle whatever its kind (ROADMAP §9
// Q26, decided by the user on 2026-10-01): after Generate Definition it asks for the next definition
// (`:generate-def-next`), as Next Definition does, never for a next proof search result. The results
// are the recorded ones: clean-editing (Generate Definition on append: two clauses, then the
// three-clause alternatives, F30) and edits-searches (Generate Definition on swap:
// `swap x = (snd x, fst x)`, then `swap (x, y) = (y, x)`, then No more results). Positions are
// 0-based.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { extensionApi, FakeLogs, runEditing, setToolchainSetting, settledScan, waitFor } from '../support';
import { assertApplied, assertMessage, editRequests, revertAll, showAt, showLoaded, spliceLines } from './fixture';

/** Clean.idr: `append : …` (line 4, no clauses). */
const APPEND = new vscode.Position(4, 2);
/** Edits.idr: `swap : (a, b) -> (b, a)` (line 74, no clauses). */
const SWAP = new vscode.Position(74, 2);
const APPEND_1 = ['append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys'];
const APPEND_2 = ['append [] ys = ys', 'append (x :: xs) [] = x :: append xs []', 'append (x :: xs) (y :: ys) = x :: append xs (y :: ys)'];
const APPEND_3 = ['append [] ys = ys', 'append (x :: xs) [] = x :: append xs []', 'append (x :: xs) (y :: ys) = y :: append xs (x :: ys)'];

suite('M4 cycling: Next Result continues a Generate Definition cycle (fake compiler)', () => {
  let api: TestApi;
  let logs: FakeLogs;
  let clean: string;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
    const doc = await showLoaded(api, 'Clean.idr');
    clean = doc.getText();
  });

  teardown(revertAll);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  /** The cycle of `doc` and the status bar's text, as the user would see them. */
  const cycle = (doc: vscode.TextDocument): { kind?: string; shown?: number; status?: string } => {
    const state = api.editing.cycleOf(doc.uri.toString());
    return { kind: state?.kind, shown: state?.shown, status: api.editing.statusText() };
  };

  /** Waits until `doc` has no cycle and the status bar item is gone (the controller follows document changes as VS Code reports them). */
  const cycleEnded = (doc: vscode.TextDocument): Promise<true> =>
    waitFor(
      () => `the cycle of ${doc.fileName} to end (${JSON.stringify(cycle(doc))})`,
      () => (JSON.stringify(cycle(doc)) === '{}' ? true : undefined),
    );

  test('Generate Definition on append, then Next Result twice with the cursor elsewhere: :generate-def-next each time, the three-clause alternatives in place of the result, the status bar counting; each one undo step', async () => {
    const editor = await showAt('Clean.idr', APPEND);
    const doc = editor.document;
    const defined = (clauses: string[]): string => spliceLines(clean, 5, 0, ...clauses);
    assertApplied(await runEditing(api, 'idris2.generateDefinition'), 'idris2.generateDefinition', doc);
    assert.strictEqual(doc.getText(), defined(APPEND_1));
    assert.deepStrictEqual(cycle(doc), { kind: 'generateDef', shown: 1, status: '↻ next (1)' });

    // Away from the declaration and its result (where `g` continues the cycle): `n` follows the file's cycle.
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const from = logs.requests().length;
    assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', doc);
    assert.strictEqual(doc.getText(), defined(APPEND_2));
    assert.deepStrictEqual(cycle(doc), { kind: 'generateDef', shown: 2, status: '↻ next (2)' });
    assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', doc);
    assert.strictEqual(doc.getText(), defined(APPEND_3));
    assert.deepStrictEqual(cycle(doc), { kind: 'generateDef', shown: 3, status: '↻ next (3)' });
    assert.deepStrictEqual(editRequests(logs, from), [':generate-def-next', ':generate-def-next']);

    // One undo step back to the previous definition, and one more to the first; the undo is not the controller's edit.
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo to restore the previous definition', () => (doc.getText() === defined(APPEND_2) ? true : undefined));
    await cycleEnded(doc);
    await vscode.commands.executeCommand('undo');
    await waitFor('a second undo to restore the first definition', () => (doc.getText() === defined(APPEND_1) ? true : undefined));
  });

  test('Generate Definition on swap (Edits.idr), Next Result: the next definition; again: no more results, nothing changes, the cycle ends; Next Result then says why and sends nothing', async () => {
    const editor = await showAt('Edits.idr', SWAP);
    const doc = editor.document;
    const saved = doc.getText();
    const defined = (clause: string): string => spliceLines(saved, 75, 0, clause);
    assertApplied(await runEditing(api, 'idris2.generateDefinition'), 'idris2.generateDefinition', doc);
    assert.strictEqual(doc.getText(), defined('swap x = (snd x, fst x)'));
    assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', doc);
    assert.strictEqual(doc.getText(), defined('swap (x, y) = (y, x)'));
    assert.deepStrictEqual(cycle(doc), { kind: 'generateDef', shown: 2, status: '↻ next (2)' });
    assertMessage(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', /^Idris 2: Generate Definition has no more results\.$/);
    assert.strictEqual(doc.getText(), defined('swap (x, y) = (y, x)'));
    await cycleEnded(doc);
    const from = logs.requests().length;
    assertMessage(
      await runEditing(api, 'idris2.nextResult'),
      'idris2.nextResult',
      /^Idris 2: the Generate Definition ended: there were no more results\. Run Generate Definition again\.$/,
    );
    assert.deepStrictEqual(editRequests(logs, from), []);
  });
});
