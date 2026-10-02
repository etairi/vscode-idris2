// Suite `editing`: cycling through results (ARCHITECTURE §10 `CyclingController`, ROADMAP §5 M4:
// Proof Search → Next Result, Generate Definition → Next Definition (Next Result continues either
// kind: nextResult.test.ts, ROADMAP §9 Q26), the status-bar `↻ next (n)`,
// "no more results"). The results are the recorded ones: clean-editing (Proof Search on ?vlen_rhs:
// 0, 1, 2; Generate Definition on append: two clauses, then the three-clause alternatives, F30) and
// edits-searches (Proof Search on ?pair_rhs: `(x, y)`, then No more results). A cycle's results
// are each their own undo step; a change the controller did not make ends the cycle. Positions
// are 0-based.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { extensionApi, FakeLogs, runEditing, setToolchainSetting, settledScan, waitFor } from '../support';
import { assertApplied, assertMessage, editRequests, revertAll, showAt, showLoaded, spliceLines, undoOnce } from './fixture';

const APPEND = new vscode.Position(4, 2);
const VLEN_RHS = new vscode.Position(7, 12);
const APPEND_1 = ['append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys'];
const APPEND_2 = ['append [] ys = ys', 'append (x :: xs) [] = x :: append xs []', 'append (x :: xs) (y :: ys) = x :: append xs (y :: ys)'];
const APPEND_3 = ['append [] ys = ys', 'append (x :: xs) [] = x :: append xs []', 'append (x :: xs) (y :: ys) = y :: append xs (x :: ys)'];

suite('M4 cycling: Next Result, Next Definition, the status bar (fake compiler)', () => {
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

  test('Proof Search on ?vlen_rhs gives 0; Next Result 1, then 2, each replacing the last; the status bar counts; each is one undo step, and the undo ends the cycle', async () => {
    const editor = await showAt('Clean.idr', VLEN_RHS);
    const doc = editor.document;
    const line = (value: string): string => spliceLines(clean, 7, 1, `vlen xs = ${value}`);
    assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', doc);
    assert.strictEqual(doc.getText(), line('0'));
    assert.deepStrictEqual(cycle(doc), { kind: 'exprSearch', shown: 1, status: '↻ next (1)' });
    assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', doc);
    assert.strictEqual(doc.getText(), line('1'));
    assert.deepStrictEqual(cycle(doc), { kind: 'exprSearch', shown: 2, status: '↻ next (2)' });
    assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', doc);
    assert.strictEqual(doc.getText(), line('2'));
    assert.deepStrictEqual(cycle(doc), { kind: 'exprSearch', shown: 3, status: '↻ next (3)' });

    // One undo step back to the previous result; the undo is not the controller's edit.
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo to restore the previous result', () => (doc.getText() === line('1') ? true : undefined));
    await cycleEnded(doc);
    const from = logs.requests().length;
    assertMessage(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', /./);
    assert.deepStrictEqual(editRequests(logs, from), [], 'Next Result without a cycle sent a request');
    assert.strictEqual(doc.getText(), line('1'));
  });

  test('Proof Search on ?pair_rhs (Edits.idr) gives (x, y); Next Result: "no more results", nothing changes, and the cycle ends', async () => {
    const editor = await showAt('Edits.idr', new vscode.Position(77, 13));
    const doc = editor.document;
    const saved = doc.getText();
    const found = spliceLines(saved, 77, 1, 'pair x y = (x, y)');
    assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', doc);
    assert.strictEqual(doc.getText(), found);
    assertMessage(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', /no more results/i);
    assert.strictEqual(doc.getText(), found);
    await cycleEnded(doc);
    await undoOnce(editor, saved);
  });

  test('Generate Definition on append (F30): two clauses after the declaration; Generate Definition again on it runs Next Definition (the three-clause alternative); Next Definition the next one', async () => {
    const editor = await showAt('Clean.idr', APPEND);
    const doc = editor.document;
    const defined = (clauses: string[]): string => spliceLines(clean, 5, 0, ...clauses);
    assertApplied(await runEditing(api, 'idris2.generateDefinition'), 'idris2.generateDefinition', doc);
    assert.strictEqual(doc.getText(), defined(APPEND_1));
    assert.deepStrictEqual(cycle(doc), { kind: 'generateDef', shown: 1, status: '↻ next (1)' });

    // `g` again with the cursor still on the declaration: the next definition, not a new search.
    const from = logs.requests().length;
    editor.selection = new vscode.Selection(APPEND, APPEND);
    assertApplied(await runEditing(api, 'idris2.generateDefinition'), 'idris2.generateDefinition', doc);
    assert.deepStrictEqual(editRequests(logs, from), [':generate-def-next']);
    assert.strictEqual(doc.getText(), defined(APPEND_2));
    assert.deepStrictEqual(cycle(doc), { kind: 'generateDef', shown: 2, status: '↻ next (2)' });

    assertApplied(await runEditing(api, 'idris2.nextDefinition'), 'idris2.nextDefinition', doc);
    assert.strictEqual(doc.getText(), defined(APPEND_3));
    assert.deepStrictEqual(cycle(doc), { kind: 'generateDef', shown: 3, status: '↻ next (3)' });
  });

  test('an edit outside the result ends the cycle: Next Result then says so and sends nothing', async () => {
    const editor = await showAt('Clean.idr', VLEN_RHS);
    const doc = editor.document;
    assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', doc);
    assert.strictEqual(cycle(doc).shown, 1);
    assert.ok(await editor.edit((e) => e.insert(new vscode.Position(0, 12), ' ')));
    await cycleEnded(doc);
    const from = logs.requests().length;
    assertMessage(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', /./);
    assert.deepStrictEqual(editRequests(logs, from), []);
    assert.strictEqual(doc.getText(), spliceLines(spliceLines(clean, 7, 1, 'vlen xs = 0'), 0, 1, 'module Clean '));
  });
});
