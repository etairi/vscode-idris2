// Suite `editing`: the safety rules of M4's edits (the task's hard requirements; features/editing/
// types.ts, *One edit, from asking to applying*; backend/types.ts `EditAtRequest`) and the policy
// `idris2.checking.saveBeforeAction`, through the fake compiler:
//   - an edit lands only while its document is unchanged since the request: the fake holds the
//     answer back (FAKE_IDRIS2_IDE_DELAY, test/fake-idris2/README.md) while the test types, and the
//     answer is discarded with a message;
//   - a name that is not an Idris name — from a code action's argument, which a file's text or
//     another extension can shape — is refused before anything is sent, so nothing typed can turn
//     `(:interpret ":missing NAME")` or any other request into a REPL command (the fake's request
//     log shows what reached the compiler);
//   - saveBeforeAction: `always` saves first, `prompt` asks (saving, or stopping), `never` stops
//     and says to save. The saves write the same text (two edits that cancel out make the document
//     dirty), because the recordings are keyed by the files' SHA-256.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { EditingCommandId } from '../../../src/features/editing/types';
import {
  answerMessages,
  extensionApi,
  FakeLogs,
  runEditing,
  setToolchainSetting,
  settledScan,
  setUserSetting,
  waitFor,
} from '../support';
import { assertApplied, assertMessage, editRequests, revertAll, showAt, showLoaded, spliceLines, undoOnce } from './fixture';

const XS = new vscode.Position(7, 5);
const VLEN_RHS = new vscode.Position(7, 12);
/** How long the fake holds back the answer to `:case-split` in the version test. */
const DELAY_MS = 1500;

suite('M4 editing safety and saveBeforeAction (fake compiler)', () => {
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
    await setUserSetting('checking', 'saveBeforeAction', undefined);
    logs.dispose();
  });

  test('a change while the compiler works: the answer is discarded with a message, and the document keeps only the user\'s change', async () => {
    await setToolchainSetting(api, 'env', { ...logs.env, FAKE_IDRIS2_IDE_DELAY: `case-split=${DELAY_MS}` });
    try {
      const editor = await showAt('Clean.idr', XS);
      const from = logs.requests().length;
      const outcome = runEditing(api, 'idris2.caseSplit');
      await waitFor('the case split to reach the compiler', () => (editRequests(logs, from).some((t) => t.startsWith('(:case-split ')) ? true : undefined));
      // The answer is held back for DELAY_MS: type while it is on its way.
      assert.ok(await editor.edit((e) => e.insert(new vscode.Position(0, 12), ' ')));
      assertMessage(await outcome, 'idris2.caseSplit', /changed/i);
      assert.strictEqual(editor.document.getText(), spliceLines(clean, 0, 1, 'module Clean '));
    } finally {
      await revertAll();
      await setToolchainSetting(api, 'env', logs.env);
    }
  });

  // A code action's name that is not an Idris name is never the name at its position, so the command
  // refuses it there; the backend's own name check is pinned by the unit tests (backendIde, protocol).
  test('a code action\'s name that is not the one at its position is refused before anything is sent: no :interpret, no edit request, nothing with `exec` reaches the compiler', async () => {
    const editor = await showAt('Clean.idr', VLEN_RHS);
    const uri = editor.document.uri.toString();
    const from = logs.requests().length;
    const attempts: [EditingCommandId, vscode.Position, string][] = [
      ['idris2.addMissingCases', new vscode.Position(6, 0), 'vlen\n:exec main'],
      ['idris2.addMissingCases', new vscode.Position(6, 0), 'vlen") 1) ((:interpret ":exec main'],
      ['idris2.caseSplit', XS, 'xs" 1 "") 2) ((:interpret ":exec main'],
      ['idris2.makeLemma', VLEN_RHS, ':exec main'],
      ['idris2.intro', VLEN_RHS, 'vlen_rhs ?x'],
      ['idris2.generateDefinition', new vscode.Position(4, 0), 'append\n:exec main'],
    ];
    for (const [command, position, name] of attempts) {
      const outcome = await runEditing(api, command, [{ uri, position: { line: position.line, character: position.character }, name }]);
      assertMessage(outcome, command, /changed since .* was offered/);
    }
    const sent = logs.requests().slice(from).map((r) => r.request);
    assert.deepStrictEqual(editRequests(logs, from), [], JSON.stringify(sent));
    assert.ok(!sent.some((r) => r.includes('exec')), JSON.stringify(sent));
    assert.strictEqual(editor.document.getText(), clean);
  });

  test('a code action\'s argument never makes an edit in another document than the one it names, nor opens one', async () => {
    const editor = await showAt('Clean.idr', VLEN_RHS);
    const notOpen = vscode.Uri.joinPath(editor.document.uri, '..', 'Mixed.idr').toString();
    assert.ok(!vscode.workspace.textDocuments.some((d) => d.uri.toString() === notOpen), 'Mixed.idr is open already');
    const from = logs.requests().length;
    const outcome = await runEditing(api, 'idris2.proofSearch', [{ uri: notOpen, position: { line: 0, character: 0 }, name: 'x' }]);
    assert.strictEqual(outcome.kind, 'message', JSON.stringify(outcome));
    assert.ok(!vscode.workspace.textDocuments.some((d) => d.uri.toString() === notOpen), 'the command opened the document');
    assert.deepStrictEqual(editRequests(logs, from), []);
    assert.strictEqual(editor.document.getText(), clean);
  });

  suite('idris2.checking.saveBeforeAction', () => {
    /** Makes Clean.idr dirty with its text unchanged (two edits that cancel out), cursor on ?vlen_rhs. */
    async function dirtyClean(): Promise<vscode.TextEditor> {
      const editor = await showAt('Clean.idr', VLEN_RHS);
      const end = editor.document.lineAt(0).range.end;
      assert.ok(await editor.edit((e) => e.insert(end, ' ')));
      assert.ok(await editor.edit((e) => e.delete(new vscode.Range(end, end.translate(0, 1)))));
      assert.ok(editor.document.isDirty && editor.document.getText() === clean);
      editor.selection = new vscode.Selection(VLEN_RHS, VLEN_RHS);
      return editor;
    }

    /** Counts the saves of `doc` from now on. */
    function countSaves(doc: vscode.TextDocument): { readonly count: number; dispose(): void } {
      let count = 0;
      const subscription = vscode.workspace.onDidSaveTextDocument((d) => {
        if (d === doc) {
          count += 1;
        }
      });
      return {
        get count() {
          return count;
        },
        dispose: () => subscription.dispose(),
      };
    }

    const found = (): string => spliceLines(clean, 7, 1, 'vlen xs = 0');

    test('the default, always: the file is saved, then Proof Search runs on it', async () => {
      assert.strictEqual(vscode.workspace.getConfiguration('idris2.checking').inspect('saveBeforeAction')?.defaultValue, 'always');
      await setUserSetting('checking', 'saveBeforeAction', undefined);
      const editor = await dirtyClean();
      const saves = countSaves(editor.document);
      try {
        assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', editor.document);
        assert.strictEqual(saves.count, 1);
        assert.strictEqual(editor.document.getText(), found());
      } finally {
        saves.dispose();
      }
      await undoOnce(editor, clean);
    });

    test('prompt: the question is asked; saving runs the command, dismissing it stops the command (nothing sent, still unsaved)', async () => {
      await setUserSetting('checking', 'saveBeforeAction', 'prompt');
      const editor = await dirtyClean();
      const saves = countSaves(editor.document);
      const save = answerMessages((_message, titles) => titles.find((t) => /save/i.test(t)));
      try {
        assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', editor.document);
        assert.strictEqual(save.asked.length, 1, JSON.stringify(save.asked));
        assert.strictEqual(saves.count, 1);
        assert.strictEqual(editor.document.getText(), found());
      } finally {
        save.restore();
      }
      await undoOnce(editor, clean);

      await dirtyClean();
      const from = logs.requests().length;
      const dismiss = answerMessages(() => undefined);
      try {
        assert.deepStrictEqual(await runEditing(api, 'idris2.proofSearch'), { command: 'idris2.proofSearch', kind: 'cancelled' });
        assert.strictEqual(dismiss.asked.length, 1, JSON.stringify(dismiss.asked));
      } finally {
        dismiss.restore();
        saves.dispose();
      }
      assert.strictEqual(saves.count, 1, 'saved although the question was dismissed');
      assert.ok(editor.document.isDirty);
      assert.deepStrictEqual(editRequests(logs, from), []);
    });

    test('never: the command does not save, says to save first, and sends nothing', async () => {
      await setUserSetting('checking', 'saveBeforeAction', 'never');
      const editor = await dirtyClean();
      const saves = countSaves(editor.document);
      const from = logs.requests().length;
      try {
        assertMessage(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', /save/i);
      } finally {
        saves.dispose();
      }
      assert.strictEqual(saves.count, 0);
      assert.ok(editor.document.isDirty);
      assert.deepStrictEqual(editRequests(logs, from), []);
      assert.strictEqual(editor.document.getText(), clean);
    });

    test('Next Result never saves, whatever the setting', async () => {
      await setUserSetting('checking', 'saveBeforeAction', 'always');
      const editor = await showAt('Clean.idr', VLEN_RHS);
      assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', editor.document);
      const saves = countSaves(editor.document);
      try {
        assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', editor.document);
        assert.strictEqual(saves.count, 0);
        assert.ok(editor.document.isDirty);
        assert.strictEqual(editor.document.getText(), spliceLines(clean, 7, 1, 'vlen xs = 1'));
      } finally {
        saves.dispose();
      }
    });
  });
});
