// Suite `lsp` (.vscode-test.mjs; ROADMAP §5 M4 "Acceptance (LSP)" and M5, the contract end to end):
// M4's editing commands on documents of the package, served by idris2-lsp — here the fake
// (test/fake-lsp) replaying the real server's code actions on Clean.idr (recording `actions-clean`)
// and Part.idr (`diagnostics`) — change the file exactly as IDE mode does on the same source (the
// texts of test/integration/editing/commands.test.ts `CLEAN_CASES`, which the fake compiler replays
// from Idris 2 0.8.0), each in one undo step. The cursor is put where the recordings ask: on `xs` for
// Case Split, at the start of `append`'s declaration for Add Clause and Generate Definition (the
// server's actions answer at the positions it was asked, and LspBackend asks at the cursor), on the
// hole for the hole commands (LspBackend asks at the hole's start).
//
// The server keeps a document dirty from a `didChange` until it is told of a save, whatever the text
// (`dirtyFiles`, Server/ProcessMessage.idr 582–604 [src]), and then answers nothing for it; so each
// case saves the file unchanged after its undo — except the last test, which checks that an undo back
// to the saved text leaves the next command answered.
//
// Refine Hole… is not here: LspBackend asks `textDocument/documentSymbol` before `refineHole`, and no
// recording has that request for Clean.idr as it is on disk (the e2e suite runs it on the real server).
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { EditingCommandId } from '../../../src/features/editing/types';
import { acceptQuickPick, diagnosticsWhen, extensionApi, runEditing, saveUnchanged, settledScan, setToolchainSetting } from '../support';
import { assertApplied, assertMessage, spliceLines, undoOnce } from '../editing/fixture';
import { FakeLspLogs, opened, showDocument, source, useLogs } from './support';

const XS = new vscode.Position(7, 5);
const APPEND_START = new vscode.Position(4, 0);
const VLEN_RHS = new vscode.Position(7, 12);

interface Case {
  readonly command: EditingCommandId;
  readonly at: vscode.Position;
  /** A QuickPick opens, whose first item is taken. */
  readonly picks?: boolean;
  readonly after: (saved: string) => string;
}

/** IDE mode's results on the same text (test/integration/editing/commands.test.ts `CLEAN_CASES`). */
const CASES: readonly Case[] = [
  { command: 'idris2.caseSplit', at: XS, after: (s) => spliceLines(s, 7, 1, 'vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1') },
  { command: 'idris2.addClause', at: APPEND_START, after: (s) => spliceLines(s, 5, 0, 'append xs ys = ?append_rhs') },
  { command: 'idris2.makeWith', at: VLEN_RHS, after: (s) => spliceLines(s, 7, 1, 'vlen xs with (_)', '  vlen xs | with_pat = ?vlen_rhs_rhs') },
  { command: 'idris2.makeCase', at: VLEN_RHS, after: (s) => spliceLines(s, 7, 1, 'vlen xs = (case _ of', '                case_val => ?vlen_rhs)') },
  { command: 'idris2.proofSearch', at: VLEN_RHS, after: (s) => spliceLines(s, 7, 1, 'vlen xs = 0') },
  {
    command: 'idris2.generateDefinition',
    at: APPEND_START,
    after: (s) => spliceLines(s, 5, 0, 'append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys'),
  },
  { command: 'idris2.intro', at: VLEN_RHS, picks: true, after: (s) => spliceLines(s, 7, 1, 'vlen xs = 0') },
];

suite('M4 editing over idris2-lsp: the same text as IDE mode (fake idris2-lsp)', () => {
  let api: TestApi;
  let logs: FakeLspLogs;
  const clean = source('Clean.idr');
  /** Clean.idr as saved. */
  let saved: string;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLspLogs();
    await useLogs(api, logs);
    const editor = await showDocument(clean);
    await opened(logs, clean);
    saved = editor.document.getText();
  });

  teardown(async () => {
    // A failed test's leftovers: back to the saved text, saved, so that the server sees the file clean.
    for (const doc of vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file')) {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await saveUnchanged(doc);
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  /** Undoes once (the edit must take exactly one undo step), then saves the unchanged file for the server. */
  async function undoAndSave(editor: vscode.TextEditor): Promise<void> {
    await undoOnce(editor, saved);
    await saveUnchanged(editor.document);
  }

  for (const c of CASES) {
    test(`${c.command} on Clean.idr gives IDE mode's text, in one undo step`, async () => {
      const editor = await showDocument(clean, c.at);
      assertApplied(await runEditing(api, c.command, [], c.picks === true ? acceptQuickPick : undefined), c.command, editor.document);
      assert.strictEqual(editor.document.getText(), c.after(saved));
      await undoAndSave(editor);
    });
  }

  test('Make Lemma: `vlen_rhs : Vect n a -> Nat` above vlen\'s declaration, the hole replaced by `(vlen_rhs xs)` (always bracket), one undo step', async () => {
    const editor = await showDocument(clean, VLEN_RHS);
    assertApplied(await runEditing(api, 'idris2.makeLemma'), 'idris2.makeLemma', editor.document);
    const lines = editor.document.getText().split('\n');
    const lemma = lines.indexOf('vlen_rhs : Vect n a -> Nat');
    assert.ok(lemma > lines.indexOf('append : Vect n a -> Vect m a -> Vect (n + m) a'), lines.join('\n'));
    assert.ok(lemma < lines.indexOf('vlen : Vect n a -> Nat'), lines.join('\n'));
    const withoutBlanks = (text: string): string[] => text.split('\n').filter((l) => l !== '' && l !== 'vlen_rhs : Vect n a -> Nat');
    assert.deepStrictEqual(withoutBlanks(editor.document.getText()), withoutBlanks(spliceLines(saved, 7, 1, 'vlen xs = (vlen_rhs xs)')));
    await undoAndSave(editor);
  });

  test('Proof Search, then Next Result through the server\'s five results; then it says the server gives no more than maxCodeActionResults', async () => {
    const editor = await showDocument(clean, VLEN_RHS);
    const doc = editor.document;
    assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', doc);
    assert.strictEqual(doc.getText(), spliceLines(saved, 7, 1, 'vlen xs = 0'));
    for (const n of ['1', '2', '3', '4']) {
      assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', doc);
      assert.strictEqual(doc.getText(), spliceLines(saved, 7, 1, `vlen xs = ${n}`));
    }
    assertMessage(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', /maxCodeActionResults/);
    assert.strictEqual(doc.getText(), spliceLines(saved, 7, 1, 'vlen xs = 4'), 'the refusal changed the file');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await saveUnchanged(doc);
  });

  test('Add Missing Cases on Part.idr applies the server\'s quick fix: `g (S _) = ?g_missing_case_1` where IDE mode puts it', async () => {
    const part = source('Part.idr');
    const editor = await showDocument(part);
    await opened(logs, part);
    const [coverage] = await diagnosticsWhen(part, 'the coverage error of g', (ds) => ds.some((d) => /Missing cases/.test(d.message)));
    editor.selection = new vscode.Selection(coverage.range.start, coverage.range.start);
    const before = editor.document.getText();
    assertApplied(await runEditing(api, 'idris2.addMissingCases'), 'idris2.addMissingCases', editor.document);
    assert.strictEqual(editor.document.getText(), spliceLines(before, 4, 0, 'g (S _) = ?g_missing_case_1'));
    await undoOnce(editor, before);
    await saveUnchanged(editor.document);
  });

  test('an edit undone back to the saved text leaves the server answering: the same command applies again without a save', async () => {
    const editor = await showDocument(clean, XS);
    const split = spliceLines(saved, 7, 1, 'vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1');
    assertApplied(await runEditing(api, 'idris2.caseSplit'), 'idris2.caseSplit', editor.document);
    assert.strictEqual(editor.document.getText(), split);
    await undoOnce(editor, saved);
    // VS Code shows the file as saved; the server must not be left thinking it has unsaved changes.
    assertApplied(await runEditing(api, 'idris2.caseSplit'), 'idris2.caseSplit', editor.document);
    assert.strictEqual(editor.document.getText(), split);
    await undoAndSave(editor);
  });
});
