// E2E (ROADMAP M7 acceptance): the goal panel in a real VS Code with the real idris2. The webview's
// script really runs, under the panel's Content-Security-Policy: its `ready` and `rendered` messages
// come back, and `rendered` carries the text of the page. Buttons are the messages their handlers
// send (`src/webview/view.ts`, unit-tested), sent while the panel has the focus, when VS Code has no
// active text editor, as after a real click.
//
// One compiler process at a time (CLAUDE.md): the test profile turns check while typing off, and the
// suite turns VS Code's inlay hints off, which ask for a load of their own.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { Classification } from '../../src/project/types';
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

suite('E2E: the goal panel (ROADMAP M7)', function () {
  this.timeout(180000);
  let api: TestApi;
  let copy: { dir: string; root: string };
  let allow: { stop(): void };
  let file: string;
  let root: Classification;
  let doc: vscode.TextDocument;
  let editor: vscode.TextEditor;
  let inlayHints: string | undefined;

  /** The line of `text`, 0-based. */
  const lineOf = (text: string): number => doc.getText().split('\n').findIndex((line) => line.includes(text));

  /** The rows of **All holes** of this suite's file: the window has the other e2e files' too. */
  const ownHoles = (): string[] => (api.goalPanel.state()?.holes ?? []).filter((row) => row.place.startsWith(file)).map((row) => row.label);

  /** Puts the cursor in the first `text` of the document. */
  function cursorIn(text: string): void {
    const line = lineOf(text);
    const character = doc.lineAt(line).text.indexOf(text) + 1;
    editor.selection = new vscode.Selection(line, character, line, character);
  }

  /** Waits for the check of the document to answer, and for the holes it reports. */
  async function checked(): Promise<void> {
    const check = api.sessions.sessionFor(root, 'check');
    await waitFor('the check session to load Clean.idr', () => (check.state === 'ready' && check.loadedFile !== undefined ? true : undefined), 90000);
    await waitFor('the holes of Clean.idr', () => (api.holes.holesIn(file).length > 0 ? true : undefined), 30000);
  }

  /**
   * The panel's group is active with the panel on top, as after a click in the panel. VS Code then has
   * no active text editor, nearly always: it works that out only at some events, and prefers an editor
   * with the text focus (`_updateState` of MainThreadDocumentsAndEditors, 1.144.0 [src]), and some runs
   * kept the editor for 30 s (`docs/as-built/M7.md`, *Open issues*). The buttons pass their document
   * either way, and the unit tests run each with no active editor, so that is logged, not failed.
   */
  async function focusPanel(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.focusSideBar');
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    await waitFor('the panel\'s group to be active', () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview ? true : undefined));
    for (let i = 0; i < 10 && vscode.window.activeTextEditor !== undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (vscode.window.activeTextEditor !== undefined) {
      console.log(`      the panel's group is active, and VS Code still names ${vscode.window.activeTextEditor.document.fileName} as the active editor`);
    }
  }

  /** The text of the file again, checked. Not with the revert command, which acts on the active editor (*Open issues*, as above). */
  async function restoreFile(): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), fs.readFileSync(file, 'utf8'));
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await vscode.commands.executeCommand('idris2.checkFile');
    await checked();
  }

  suiteSetup(async function () {
    this.timeout(90000);
    api = await extensionApi();
    await quiesce(api);
    copy = copyWorkspace('broken');
    allow = allowWhenAsked(api, copy.root);
    inlayHints = vscode.workspace.getConfiguration('editor').inspect<string>('inlayHints.enabled')?.globalValue;
    await vscode.workspace.getConfiguration('editor').update('inlayHints.enabled', 'off', vscode.ConfigurationTarget.Global);
    file = path.join(copy.root, 'Clean.idr');
    root = await api.projects.classify(file);
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('idris2.checkFile');
    await checked();
  });

  suiteTeardown(async function () {
    this.timeout(60000);
    allow.stop();
    await vscode.workspace.getConfiguration('editor').update('inlayHints.enabled', inlayHints, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    api.sessions.stop();
    await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
    fs.rmSync(copy.dir, { recursive: true, force: true });
  });

  test('the toggle opens the panel beside the editor, keeping the focus there; its script runs under its Content-Security-Policy', async () => {
    assert.strictEqual(api.goalPanel.isOpen, false);
    await vscode.commands.executeCommand('idris2.toggleGoalPanel');
    assert.strictEqual(api.goalPanel.isOpen, true);
    await waitFor('the page to draw a state', () => api.goalPanel.rendered());
    assert.strictEqual(vscode.window.activeTextEditor?.document, doc, 'the editor keeps the focus');
    assert.strictEqual(api.goalPanel.rendered()?.version, api.goalPanel.state()?.version);
    assert.deepStrictEqual(ownHoles(), ['?vlen_rhs']);
    assert.match(api.goalPanel.rendered()?.text ?? '', /All holes \(\d+\)/);
    console.log(`      the status at the first state: ${JSON.stringify(api.checks.statusOf(doc, root))}, the panel's stale: ${api.goalPanel.state()?.stale}`);
    assert.strictEqual(api.goalPanel.state()?.stale, false, 'just checked');
  });

  test('the cursor in ?vlen_rhs shows its premises and goal soon after the debounce, in the page too', async () => {
    const at = Date.now();
    cursorIn('?vlen_rhs');
    const goal = await waitFor('the goal', () => api.goalPanel.state()?.goal);
    console.log(`      goal shown ${Date.now() - at} ms after the move (the debounce is 50 ms)`);
    assert.strictEqual(goal.label, '?vlen_rhs');
    assert.deepStrictEqual(goal.premises.map((p) => p.text), ['0 a : Type', '0 n : Nat', 'xs : Vect n a']);
    assert.strictEqual(goal.type, 'Nat');
    assert.deepStrictEqual(goal.premises.map((p) => [p.name, p.canSplit, p.canJump]), [['a', false, false], ['n', false, false], ['xs', true, true]]);
    await waitFor('the page to show it', () => (api.goalPanel.rendered()?.version === api.goalPanel.state()?.version ? true : undefined));
    assert.match(api.goalPanel.rendered()?.text ?? '', /\?vlen_rhs/);
    assert.match(api.goalPanel.rendered()?.text ?? '', /xs : Vect n a/);
  });

  test('Copy puts the goal on the clipboard as Markdown', async () => {
    await api.goalPanel.receive({ type: 'copy' });
    const text = await vscode.env.clipboard.readText();
    assert.match(text, /\*\*\?vlen_rhs\*\* \(Clean\.vlen_rhs\)/);
    assert.match(text, /```idris2\n0 a : Type\n0 n : Nat\nxs : Vect n a\n-+\nNat\n```/);
  });

  test('a printing option: the setting changes, and the page shows what the compiler then prints', async () => {
    await api.goalPanel.receive({ type: 'toggle', option: 'fullNamespace' });
    const goal = await waitFor('the namespaces', () => {
      const shown = api.goalPanel.state()?.goal;
      return shown?.type === 'Prelude.Nat' ? shown : undefined;
    }, 60000);
    assert.strictEqual(goal.premises[2].text, 'xs : Data.Vect.Vect n a');
    assert.strictEqual(vscode.workspace.getConfiguration('idris2').get('ideMode.fullNamespace'), true);
    assert.strictEqual(api.goalPanel.state()?.options.fullNamespace, true);
    await api.goalPanel.receive({ type: 'toggle', option: 'fullNamespace' });
    await waitFor('the plain names', () => (api.goalPanel.state()?.goal?.type === 'Nat' ? true : undefined), 60000);
    await vscode.workspace.getConfiguration('idris2').update('ideMode.fullNamespace', undefined, vscode.ConfigurationTarget.Global);
  });

  test('with the focus in the panel, a click on Proof Search replaces the hole, and Next goes on from it', async () => {
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    cursorIn('?vlen_rhs');
    await waitFor('the goal', () => api.goalPanel.state()?.goal);
    await focusPanel();
    const line = lineOf('?vlen_rhs');
    await api.goalPanel.receive({ type: 'action', action: 'proofSearch' });
    assert.ok(!doc.lineAt(line).text.includes('?vlen_rhs'), doc.lineAt(line).text);
    await waitFor('Next to be offered', () => (api.goalPanel.state()?.cycle === true ? true : undefined));
    const first = doc.lineAt(line).text;
    await api.goalPanel.receive({ type: 'action', action: 'nextResult' });
    assert.notStrictEqual(doc.lineAt(line).text, first);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await restoreFile();
  });

  test('with the focus in the panel, Case Split on xs writes the two clauses; a binder and a row jump in the editor\'s group', async () => {
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    cursorIn('?vlen_rhs');
    await waitFor('the goal', () => api.goalPanel.state()?.goal);
    await focusPanel();
    await api.goalPanel.receive({ type: 'premise', action: 'jump', name: 'xs' });
    await waitFor('the editor to have the focus', () => (vscode.window.activeTextEditor?.document === doc ? true : undefined));
    assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
    assert.strictEqual(doc.getText(vscode.window.activeTextEditor?.selection), 'xs');
    cursorIn('?vlen_rhs');
    await waitFor('the goal', () => api.goalPanel.state()?.goal);
    await focusPanel();
    await api.goalPanel.receive({ type: 'premise', action: 'caseSplit', name: 'xs' });
    const text = doc.getText();
    assert.match(text, /^vlen \[\] = \?vlen_rhs_0$/m);
    assert.match(text, /^vlen \(x :: xs\) = \?vlen_rhs_1$/m);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await doc.save();
    await waitFor('the two holes', () => (ownHoles().join() === '?vlen_rhs_0,?vlen_rhs_1' ? true : undefined), 60000);
    const state = api.goalPanel.state();
    assert.ok(state !== undefined);
    await focusPanel();
    await api.goalPanel.receive({ type: 'hole', version: state.version, index: state.holes.findIndex((row) => row.label === '?vlen_rhs_1' && row.place.startsWith(file)) });
    await waitFor('the hole selected', () => (vscode.window.activeTextEditor?.document === doc ? true : undefined));
    assert.strictEqual(vscode.window.activeTextEditor?.viewColumn, vscode.ViewColumn.One);
    assert.strictEqual(doc.getText(vscode.window.activeTextEditor?.selection), '?vlen_rhs_1');
  });

  test('hidden behind another tab it keeps its page; the toggle shows it again, and closes it', async () => {
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const drawn = api.goalPanel.rendered();
    const other = await vscode.workspace.openTextDocument({ content: 'another tab', language: 'plaintext' });
    await vscode.window.showTextDocument(other, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    assert.strictEqual(api.goalPanel.isOpen, true);
    await vscode.commands.executeCommand('idris2.toggleGoalPanel');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(api.goalPanel.isOpen, true, 'shown again, not closed');
    assert.ok((api.goalPanel.rendered()?.version ?? 0) >= (drawn?.version ?? 0));
    await vscode.commands.executeCommand('idris2.toggleGoalPanel');
    await waitFor('the panel to close', () => (api.goalPanel.isOpen ? undefined : true));
  });
});
