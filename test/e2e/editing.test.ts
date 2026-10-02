// E2E (ROADMAP §5 M4, acceptance for IDE mode): the interactive editing commands and the holes with
// the real idris2, on a temporary copy of test/fixtures/workspaces/broken (loose files; its folder
// needs the user's consent, which the tests give). The acceptance names `literate/Lit2.lidr`; the
// fixture is `broken/Lit2.lidr` (docs/as-built/M4.md). Every applied edit is undone with one undo
// step, so the files stay as copied. What a QuickPick offers (Intro, Refine's ambiguity) is read
// from the backend's answer (`IdrisBackend.edit`, the choices the QuickPick shows), since no API
// reads an open QuickPick; the commands themselves take the first item.
//
// One compiler process at a time (CLAUDE.md): every file is a loose file of one directory, so the
// one `check` session of that directory serves them all; nothing here starts an `eval` session.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { EditResult } from '../../src/backend/types';
import type { TestApi } from '../../src/extension';
import type { EditingCommandId } from '../../src/features/editing/types';
import type { HoleNode } from '../../src/features/holes/tree';
import { acceptQuickPick, answerInputBox, runEditing } from '../integration/support';
import { copyWorkspace, ideProcesses } from './ideDriver';
import { extensionApi, quiesce, waitFor } from './helpers';

/** Answers the consent question for `dir` with Allow (this window) whenever it is asked, until `stop()`. */
function allowWhenAsked(api: TestApi, dir: string): { stop(): void } {
  const timer = setInterval(() => {
    if (api.consent.openQuestions().includes(dir)) {
      api.consent.respond(dir, 'allow');
    }
  }, 50);
  return { stop: () => clearInterval(timer) };
}

/** `text` with `deleteCount` lines from line `start` (0-based) replaced by `lines`. */
function spliceLines(text: string, start: number, deleteCount: number, ...lines: string[]): string {
  const all = text.split('\n');
  all.splice(start, deleteCount, ...lines);
  return all.join('\n');
}

suite('E2E: M4 interactive editing and holes with the real idris2', function () {
  this.timeout(180000);
  let api: TestApi;
  let copy: { dir: string; root: string };
  let consent: { stop(): void };

  suiteSetup(async function () {
    this.timeout(90000);
    api = await extensionApi();
    await quiesce(api);
    copy = copyWorkspace('broken');
    consent = allowWhenAsked(api, copy.root);
  });

  suiteTeardown(async function () {
    this.timeout(60000);
    consent.stop();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    api.sessions.stop();
    await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
    fs.rmSync(copy.dir, { recursive: true, force: true });
  });

  /** Opens `name` of the copy with the cursor at `line`:`character`, checked and loaded. */
  async function open(name: string, line: number, character: number): Promise<vscode.TextEditor> {
    const file = path.join(copy.root, name);
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(line, character, line, character);
    const root = await api.projects.classify(file);
    await vscode.commands.executeCommand('idris2.checkFile');
    const session = api.sessions.sessionFor(root, 'check');
    await waitFor(`${name} to be loaded`, () => (session.state === 'ready' && session.loadedFile?.path === file ? true : undefined), 120000);
    assert.ok(ideProcesses().length <= 1, JSON.stringify(ideProcesses()));
    return editor;
  }

  /** Runs `command` at the cursor, checks that it applied `after` and that one undo restores the file. */
  async function applies(editor: vscode.TextEditor, command: EditingCommandId, after: string, interact?: () => Thenable<unknown>): Promise<void> {
    const saved = editor.document.getText();
    const outcome = await runEditing(api, command, [], interact);
    assert.deepStrictEqual(outcome, { command, kind: 'applied', uri: editor.document.uri.toString() });
    assert.strictEqual(editor.document.getText(), after);
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo to restore the file', () => (editor.document.getText() === saved && !editor.document.isDirty ? true : undefined));
  }

  /** The labels of the choices the backend answers for an `intro` or `refine` at the cursor. */
  async function choices(editor: vscode.TextEditor, kind: 'intro' | 'refine', name: string, hint?: string): Promise<string[]> {
    const doc = editor.document;
    const backend = api.registry.backendFor(await api.projects.classify(doc.uri.fsPath));
    const base = { doc, version: doc.version, pos: editor.selection.active, name };
    const result: EditResult = await backend.edit(kind === 'intro' ? { ...base, kind } : { ...base, kind, hint: hint ?? '' });
    assert.strictEqual(result.type, 'choices', JSON.stringify(result));
    return result.type === 'choices' ? result.choices.map((c) => c.label) : [];
  }

  test('Clean.idr: Case Split on xs gives exactly `vlen [] = ?vlen_rhs_0` / `vlen (x :: xs) = ?vlen_rhs_1`', async () => {
    const editor = await open('Clean.idr', 7, 5);
    const saved = editor.document.getText();
    await applies(editor, 'idris2.caseSplit', spliceLines(saved, 7, 1, 'vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1'));
  });

  test('Clean.idr: Generate Definition on append gives the two-clause definition, Next Definition the three-clause one (F30)', async () => {
    const editor = await open('Clean.idr', 4, 2);
    const saved = editor.document.getText();
    const doc = editor.document;
    assert.deepStrictEqual(await runEditing(api, 'idris2.generateDefinition'), { command: 'idris2.generateDefinition', kind: 'applied', uri: doc.uri.toString() });
    assert.strictEqual(doc.getText(), spliceLines(saved, 5, 0, 'append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys'));
    assert.deepStrictEqual(await runEditing(api, 'idris2.nextDefinition'), { command: 'idris2.nextDefinition', kind: 'applied', uri: doc.uri.toString() });
    assert.strictEqual(
      doc.getText(),
      spliceLines(saved, 5, 0, 'append [] ys = ys', 'append (x :: xs) [] = x :: append xs []', 'append (x :: xs) (y :: ys) = x :: append xs (y :: ys)'),
    );
    // Each result is its own undo step.
    await vscode.commands.executeCommand('undo');
    await waitFor('the first definition back', () => (doc.getText() === spliceLines(saved, 5, 0, 'append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys') ? true : undefined));
    await vscode.commands.executeCommand('undo');
    await waitFor('the file as saved', () => (doc.getText() === saved && !doc.isDirty ? true : undefined));
  });

  test('Clean.idr: Intro on ?vlen_rhs offers 0 and S ?vlen_rhs_0 (F29, F30); Proof Search gives 0, Next Result 1', async () => {
    const editor = await open('Clean.idr', 7, 12);
    const saved = editor.document.getText();
    assert.deepStrictEqual(await choices(editor, 'intro', 'vlen_rhs'), ['0', 'S ?vlen_rhs_0']);
    await applies(editor, 'idris2.intro', spliceLines(saved, 7, 1, 'vlen xs = 0'), acceptQuickPick);
    editor.selection = new vscode.Selection(7, 12, 7, 12);
    const doc = editor.document;
    assert.deepStrictEqual(await runEditing(api, 'idris2.proofSearch'), { command: 'idris2.proofSearch', kind: 'applied', uri: doc.uri.toString() });
    assert.strictEqual(doc.getText(), spliceLines(saved, 7, 1, 'vlen xs = 0'));
    assert.deepStrictEqual(await runEditing(api, 'idris2.nextResult'), { command: 'idris2.nextResult', kind: 'applied', uri: doc.uri.toString() });
    assert.strictEqual(doc.getText(), spliceLines(saved, 7, 1, 'vlen xs = 1'));
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('Clean.idr: Make Lemma inserts `vlen_rhs : Vect n a -> Nat` and replaces the hole with `(vlen_rhs xs)`', async () => {
    const editor = await open('Clean.idr', 7, 12);
    const doc = editor.document;
    const saved = doc.getText();
    assert.deepStrictEqual(await runEditing(api, 'idris2.makeLemma'), { command: 'idris2.makeLemma', kind: 'applied', uri: doc.uri.toString() });
    const lines = doc.getText().split('\n');
    assert.ok(lines.includes('vlen_rhs : Vect n a -> Nat'), doc.getText());
    assert.ok(lines.indexOf('vlen_rhs : Vect n a -> Nat') < lines.indexOf('vlen : Vect n a -> Nat'), doc.getText());
    assert.ok(lines.includes('vlen xs = (vlen_rhs xs)'), doc.getText());
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo to restore the file', () => (doc.getText() === saved && !doc.isDirty ? true : undefined));
  });

  test('Clean.idr: the Holes view lists vlen_rhs with 0 a : Type, 0 n : Nat, xs : Vect n a; clicking it selects the hole at 7:10', async () => {
    const editor = await open('Clean.idr', 0, 0);
    const file = editor.document.uri.fsPath;
    await waitFor('vlen_rhs in the holes of Clean.idr', () => (api.holes.holesIn(file).some((h) => h.name === 'vlen_rhs') ? true : undefined));
    // The view shows the model's files in the model's order.
    const tree = api.holesTree;
    const fileItem = ((await tree.getChildren()) ?? [])[api.holes.files().indexOf(file)];
    assert.ok(fileItem, JSON.stringify(api.holes.files()));
    /** An item's text as drawn: its label, then its description. */
    const drawn = async (node: HoleNode): Promise<string> => {
      const item = await tree.getTreeItem(node);
      const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
      return [label, typeof item.description === 'string' ? item.description : ''].filter((t) => t !== '').join(' ');
    };
    const holes = (await tree.getChildren(fileItem)) ?? [];
    const texts = await Promise.all(holes.map(drawn));
    const index = texts.findIndex((t) => t.startsWith('?vlen_rhs '));
    assert.ok(index >= 0, JSON.stringify(texts));
    const premises = await Promise.all(((await tree.getChildren(holes[index])) ?? []).map(drawn));
    assert.deepStrictEqual(premises, ['0 a : Type', '0 n : Nat', 'xs : Vect n a']);
    const command = (await tree.getTreeItem(holes[index])).command;
    assert.ok(command);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await waitFor('the hole selected', () => {
      const s = vscode.window.activeTextEditor?.selection;
      return vscode.window.activeTextEditor?.document.uri.fsPath === file && s?.start.line === 7 && s.start.character === 10 ? true : undefined;
    });
  });

  test('Ambig.idr: Refine Hole… with foo offers Ambig.A.foo ?g_rhs_0 and Ambig.B.foo ?g_rhs_0 (F29); the first is applied, in parentheses', async () => {
    const editor = await open('Ambig.idr', 13, 6);
    const saved = editor.document.getText();
    assert.deepStrictEqual(await choices(editor, 'refine', 'g_rhs', 'foo'), ['Ambig.A.foo ?g_rhs_0', 'Ambig.B.foo ?g_rhs_0']);
    const input = answerInputBox('foo');
    try {
      await applies(editor, 'idris2.refineHole', spliceLines(saved, 13, 1, 'g = (Ambig.A.foo ?g_rhs_0)'), acceptQuickPick);
    } finally {
      input.restore();
    }
  });

  test('Part.idr: Add Missing Cases inserts `g (S _) = ?g_missing_case_1` at the first blank line after g (F15)', async () => {
    const editor = await open('Part.idr', 0, 0);
    const doc = editor.document;
    const coverage = await waitFor('the coverage error', () =>
      vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'idris2' && /Missing cases/.test(d.message)),
    );
    editor.selection = new vscode.Selection(coverage.range.start, coverage.range.start);
    await applies(editor, 'idris2.addMissingCases', spliceLines(doc.getText(), 4, 0, 'g (S _) = ?g_missing_case_1'));
  });

  test('Plain.idr: Case Split on `f n = n` says the line has no hole to split on (F15; refused before the compiler is asked)', async () => {
    const editor = await open('Plain.idr', 4, 2);
    const saved = editor.document.getText();
    const outcome = await runEditing(api, 'idris2.caseSplit');
    assert.ok(outcome.kind === 'message' && /^Idris 2: Case Split: this line has no hole to split on/.test(outcome.message), JSON.stringify(outcome));
    assert.strictEqual(editor.document.getText(), saved);
  });

  test('Lit2.lidr: the split clauses keep a single `> ` (F11)', async () => {
    const editor = await open('Lit2.lidr', 8, 7);
    const saved = editor.document.getText();
    await applies(editor, 'idris2.caseSplit', spliceLines(saved, 8, 1, '> vlen [] = ?vlen_rhs_0', '> vlen (x :: xs) = ?vlen_rhs_1'));
  });
});
