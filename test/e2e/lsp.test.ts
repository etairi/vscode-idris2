// E2E (ROADMAP §5 M5, acceptance with a server; M4 "Acceptance (LSP)"): the language client and the
// LSP backend against the real idris2-lsp that IDRIS2_LSP names — suite `e2e-lsp` of .vscode-test.mjs,
// run by `npm run test:e2e:lsp` only where a server exists (CI has none, so it skips the suite). With
// pack's wrapper, PACK_BIN_DIR must be set as pack's own scripts need it (the environment reaches the
// server the extension starts).
//
// The tests work on a temporary copy of test/fixtures/workspaces/lsp-ipkg outside the workspace folder,
// so the consent gate (M2) asks about its folder — the tests allow it — and the server, started in the
// allowed folder, writes its build/ there, not into the repository. `idris2.backend.mode` is `lsp`
// (the suite's profile), so no IDE-mode session starts: one compiler process at a time (CLAUDE.md),
// the server; it is stopped at the end, and before the toolchain is scanned again. Every applied edit
// is undone with one undo step: idris2-lsp keeps a document dirty after a change until it is told of a
// save (Server/ProcessMessage.idr 582–604 [src]), and the client tells it (`DocumentSync`, *Clean
// again*), so nothing is saved after an undo.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { EditingCommandId, EditingOutcome } from '../../src/features/editing/types';
import { acceptQuickPick, answerInputBox, answerMessages, hovers, runEditing } from '../integration/support';
import { extensionApi, slowModule, waitFor } from './helpers';
import { copyWorkspace } from './ideDriver';

const SERVER = process.env.IDRIS2_LSP ?? '';

/** The idris2-lsp process trees below this process (the Extension Host), from `ps`: the wrapper, if any, counted once. */
function serverProcesses(): number[] {
  const table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .flatMap((m) => (m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }]));
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const isServer = (p: { command: string } | undefined): boolean => p !== undefined && /idris2-lsp/.test(p.command) && !/\s--version(\s|$)/.test(p.command);
  const below = (pid: number): boolean => {
    for (let p = byPid.get(pid)?.ppid; p !== undefined && p > 1; p = byPid.get(p)?.ppid) {
      if (p === process.pid) {
        return true;
      }
    }
    return false;
  };
  return table.filter((p) => isServer(p) && below(p.pid) && !isServer(byPid.get(p.ppid))).map((p) => p.pid);
}

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

const XS = new vscode.Position(7, 5);
const APPEND_START = new vscode.Position(4, 0);
const VLEN_RHS = new vscode.Position(7, 12);

suite('E2E: M5 idris2-lsp, the real server', function () {
  this.timeout(180000);
  let api: TestApi;
  let copy: { dir: string; root: string };
  let consent: { stop(): void };

  suiteSetup(async function () {
    this.timeout(120000);
    assert.ok(path.isAbsolute(SERVER), 'IDRIS2_LSP names no server (.vscode-test.mjs runs this suite only when it does)');
    api = await extensionApi();
    await waitFor('the toolchain scan to probe the server', () => {
      const s = api.toolchain.current;
      return !api.toolchain.scanning && s?.lsp.status === 'probed' ? s : undefined;
    }, 60000);
    copy = copyWorkspace('lsp-ipkg');
    consent = allowWhenAsked(api, copy.root);
  });

  suiteTeardown(async function () {
    this.timeout(60000);
    consent.stop();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('idris2.stopLanguageServer');
    await waitFor('no idris2-lsp process', () => (serverProcesses().length === 0 ? true : undefined));
    fs.rmSync(copy.dir, { recursive: true, force: true });
  });

  const file = (name: string): vscode.Uri => vscode.Uri.file(path.join(copy.root, 'src', name));

  /** Opens `name` of the copy with the cursor at `at`, once the server answers a hover there (it has loaded it). */
  async function open(name: string, at: vscode.Position, loaded: { readonly at: vscode.Position; readonly text: string }): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file(name)));
    editor.selection = new vscode.Selection(at, at);
    await waitFor(`the server's hover in ${name}`, async () => ((await hovers(editor.document.uri, loaded.at)).some((h) => h.value.includes(loaded.text)) ? true : undefined), 120000);
    assert.ok(serverProcesses().length <= 1, JSON.stringify(serverProcesses()));
    return editor;
  }

  const openClean = (at: vscode.Position): Promise<vscode.TextEditor> => open('Clean.idr', at, { at: XS, text: 'xs : Vect ?_ ?_' });

  function assertApplied(outcome: EditingOutcome, command: EditingCommandId, doc: vscode.TextDocument): void {
    assert.deepStrictEqual(outcome, { command, kind: 'applied', uri: doc.uri.toString() });
  }

  /** Undoes once (the edit must take one undo step). */
  async function undoEdit(editor: vscode.TextEditor, saved: string): Promise<void> {
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo to restore the file', () => (editor.document.getText() === saved && !editor.document.isDirty ? true : undefined));
  }

  test('the server IDRIS2_LSP names is probed and paired with the compiler of its own installation (ROADMAP §9, decision 2 of M5)', () => {
    const snapshot = api.toolchain.current;
    assert.ok(snapshot?.lsp.status === 'probed', JSON.stringify(snapshot?.lsp));
    assert.strictEqual(snapshot.lsp.location.path, SERVER);
    assert.strictEqual(snapshot.verdict?.kind, 'compatible', JSON.stringify(snapshot.verdict));
  });

  test('hover: the type once the file is saved, nothing while it has unsaved changes, and no notification', async () => {
    const editor = await openClean(XS);
    const doc = editor.document;
    const shown = answerMessages(() => undefined);
    try {
      const insert = new vscode.WorkspaceEdit();
      insert.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, '-- unsaved\n');
      assert.ok(await vscode.workspace.applyEdit(insert));
      assert.deepStrictEqual((await hovers(doc.uri, XS)).filter((h) => h.value.includes('Vect')), [], 'a hover of the unsaved file');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await waitFor('the hover after the revert', async () => ((await hovers(doc.uri, XS)).some((h) => h.value.includes('xs : Vect ?_ ?_')) ? true : undefined), 60000);
      assert.deepStrictEqual(shown.asked, [], 'notifications were shown');
    } finally {
      shown.restore();
    }
  });

  test('metavars: the backend lists vlen_rhs with its location (7:10), type and premises (F26)', async () => {
    const editor = await openClean(VLEN_RHS);
    const backend = api.registry.backendFor(await api.projects.classify(editor.document.fileName));
    assert.strictEqual(backend.kind, 'lsp');
    const holes = await backend.holes(editor.document);
    const hole = holes.find((h) => h.name === 'vlen_rhs');
    assert.ok(hole, JSON.stringify(holes.map((h) => h.qualifiedName)));
    assert.strictEqual(hole.qualifiedName, 'Clean.vlen_rhs');
    assert.strictEqual(hole.location?.uri.fsPath, editor.document.uri.fsPath);
    assert.deepStrictEqual([hole.location.range.start.line, hole.location.range.start.character], [7, 10]);
    assert.strictEqual(hole.type.text, 'Nat');
    assert.deepStrictEqual(hole.premises.map((p) => `${p.name} : ${p.type.text}`), ['a : Type', 'n : Nat', 'xs : Vect n a']);
  });

  test('the Holes view follows the server: after it loads Clean.idr, the model lists vlen_rhs at (7,10)', async () => {
    const editor = await openClean(VLEN_RHS);
    const fileName = editor.document.fileName;
    const listed = await waitFor(`the holes model to list the holes of ${fileName} (it has ${JSON.stringify(api.holes.files())})`, () => {
      const hole = api.holes.holesIn(fileName).find((h) => h.name === 'vlen_rhs');
      return hole?.location === undefined ? undefined : hole;
    }, 60000);
    assert.deepStrictEqual([listed.location?.range.start.line, listed.location?.range.start.character], [7, 10]);
  });

  // IDE mode's results on the same text (test/integration/editing/commands.test.ts `CLEAN_CASES`, test/e2e/editing.test.ts).
  const CASES: readonly { command: EditingCommandId; at: vscode.Position; picks?: boolean; after: (s: string) => string }[] = [
    { command: 'idris2.caseSplit', at: XS, after: (s) => spliceLines(s, 7, 1, 'vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1') },
    { command: 'idris2.addClause', at: APPEND_START, after: (s) => spliceLines(s, 5, 0, 'append xs ys = ?append_rhs') },
    { command: 'idris2.makeWith', at: VLEN_RHS, after: (s) => spliceLines(s, 7, 1, 'vlen xs with (_)', '  vlen xs | with_pat = ?vlen_rhs_rhs') },
    { command: 'idris2.makeCase', at: VLEN_RHS, after: (s) => spliceLines(s, 7, 1, 'vlen xs = (case _ of', '                case_val => ?vlen_rhs)') },
    {
      command: 'idris2.generateDefinition',
      at: APPEND_START,
      after: (s) => spliceLines(s, 5, 0, 'append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys'),
    },
    { command: 'idris2.intro', at: VLEN_RHS, picks: true, after: (s) => spliceLines(s, 7, 1, 'vlen xs = 0') },
  ];

  for (const c of CASES) {
    test(`Clean.idr: ${c.command} gives IDE mode's text, in one undo step`, async () => {
      const editor = await openClean(c.at);
      const saved = editor.document.getText();
      assertApplied(await runEditing(api, c.command, [], c.picks === true ? acceptQuickPick : undefined), c.command, editor.document);
      assert.strictEqual(editor.document.getText(), c.after(saved));
      await undoEdit(editor, saved);
    });
  }

  test('the goal panel (M7): the goal at the cursor; a printing option reaches the server, and the holes are asked for again under it', async () => {
    await openClean(VLEN_RHS);
    await vscode.commands.executeCommand('idris2.toggleGoalPanel');
    const goal = await waitFor('the goal', () => api.goalPanel.state()?.goal);
    assert.strictEqual(goal.label, '?vlen_rhs');
    assert.strictEqual(goal.type, 'Nat');
    assert.deepStrictEqual(goal.premises.map((p) => [p.name, p.canSplit]), [['a', false], ['n', false], ['xs', true]]);
    await waitFor('the page to draw it', () => (api.goalPanel.rendered()?.version === api.goalPanel.state()?.version ? true : undefined));
    await api.goalPanel.receive({ type: 'toggle', option: 'fullNamespace' });
    assert.strictEqual(vscode.workspace.getConfiguration('idris2').get('lsp.fullNamespace'), true);
    await waitFor('the namespaces', () => (api.goalPanel.state()?.goal?.type === 'Prelude.Nat' ? true : undefined), 60000);
    await api.goalPanel.receive({ type: 'toggle', option: 'fullNamespace' });
    await waitFor('the plain names', () => (api.goalPanel.state()?.goal?.type === 'Nat' ? true : undefined), 60000);
    await vscode.workspace.getConfiguration('idris2').update('lsp.fullNamespace', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('idris2.toggleGoalPanel');
    assert.ok(serverProcesses().length <= 1, JSON.stringify(serverProcesses()));
  });

  test('a document with unsaved changes when the server starts counts as dirty there: no answer for the disk text at the editor\'s positions (review 1, H3)', async () => {
    const editor = await openClean(XS);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '-- one\n-- two\n'));
    assert.strictEqual(editor.document.isDirty, true);
    await vscode.commands.executeCommand('idris2.restartLanguageServer');
    await waitFor('the server to run again', () => (serverProcesses().length === 1 && api.lspClient.state.kind === 'running' ? true : undefined), 60000);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const answered = (await hovers(editor.document.uri, XS)).map((h) => h.value);
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.deepStrictEqual(answered.filter((text) => /Vect/.test(text)), [], 'XS is the disk\'s position of xs, and another line here');
    await waitFor('the hover after the revert', async () => ((await hovers(editor.document.uri, XS)).some((h) => h.value.includes('xs : Vect ?_ ?_')) ? true : undefined), 60000);
  });

  test('two documents open beside each other do not reload each other for ever (review 1, H5)', async () => {
    const clean = await openClean(XS);
    const other = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file('Plain.idr')), vscode.ViewColumn.Two);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    let changes = 0;
    const counting = api.holes.onDidChange(() => changes++);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    counting.dispose();
    console.log(`      the holes changed ${changes} times in 5 s, with nothing touched`);
    await vscode.window.showTextDocument(other.document, other.viewColumn);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.ok(changes <= 1, `${changes} refreshes in 5 s`);
    await vscode.window.showTextDocument(clean.document, vscode.ViewColumn.One);
  });

  test('edits are not printed under the server\'s printing options: Case Split with fullNamespace and showImplicits on (review 1, H1)', async () => {
    const editor = await openClean(XS);
    const saved = editor.document.getText();
    const settings = vscode.workspace.getConfiguration('idris2');
    await settings.update('lsp.fullNamespace', true, vscode.ConfigurationTarget.Global);
    await settings.update('lsp.showImplicits', true, vscode.ConfigurationTarget.Global);
    try {
      // The light bulb's request: the server caches what it prints here (its code actions), and a change of the options keeps that.
      await vscode.commands.executeCommand('vscode.executeCodeActionProvider', editor.document.uri, new vscode.Range(XS, XS));
      assertApplied(await runEditing(api, 'idris2.caseSplit'), 'idris2.caseSplit', editor.document);
      console.log(`      Case Split under the options wrote: ${JSON.stringify(editor.document.getText().split('\n').slice(7, 9))}`);
      assert.strictEqual(editor.document.getText(), spliceLines(saved, 7, 1, 'vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1'));
      await undoEdit(editor, saved);
    } finally {
      await settings.update('lsp.fullNamespace', undefined, vscode.ConfigurationTarget.Global);
      await settings.update('lsp.showImplicits', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('Clean.idr: Make Lemma inserts `vlen_rhs : Vect n a -> Nat` above vlen and replaces the hole with `(vlen_rhs xs)`', async () => {
    const editor = await openClean(VLEN_RHS);
    const saved = editor.document.getText();
    assertApplied(await runEditing(api, 'idris2.makeLemma'), 'idris2.makeLemma', editor.document);
    const lines = editor.document.getText().split('\n');
    assert.ok(lines.includes('vlen_rhs : Vect n a -> Nat'), lines.join('\n'));
    assert.ok(lines.indexOf('vlen_rhs : Vect n a -> Nat') < lines.indexOf('vlen : Vect n a -> Nat'), lines.join('\n'));
    assert.ok(lines.includes('vlen xs = (vlen_rhs xs)'), lines.join('\n'));
    await undoEdit(editor, saved);
  });

  test('Clean.idr: Refine Hole… with S gives `(S ?vlen_rhs_0)`', async () => {
    const editor = await openClean(VLEN_RHS);
    const saved = editor.document.getText();
    const input = answerInputBox('S');
    try {
      assertApplied(await runEditing(api, 'idris2.refineHole'), 'idris2.refineHole', editor.document);
    } finally {
      input.restore();
    }
    assert.strictEqual(editor.document.getText(), spliceLines(saved, 7, 1, 'vlen xs = (S ?vlen_rhs_0)'));
    await undoEdit(editor, saved);
  });

  test('Clean.idr: Proof Search and Next Result go through the server\'s results (0, 1, …), then say it gives no more than maxCodeActionResults', async () => {
    const editor = await openClean(VLEN_RHS);
    const doc = editor.document;
    const saved = doc.getText();
    assertApplied(await runEditing(api, 'idris2.proofSearch'), 'idris2.proofSearch', doc);
    assert.strictEqual(doc.getText(), spliceLines(saved, 7, 1, 'vlen xs = 0'));
    assertApplied(await runEditing(api, 'idris2.nextResult'), 'idris2.nextResult', doc);
    assert.strictEqual(doc.getText(), spliceLines(saved, 7, 1, 'vlen xs = 1'));
    let outcome = await runEditing(api, 'idris2.nextResult');
    while (outcome.kind === 'applied') {
      outcome = await runEditing(api, 'idris2.nextResult');
    }
    assert.ok(outcome.kind === 'message' && /maxCodeActionResults/.test(outcome.message), JSON.stringify(outcome));
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('Part.idr: Add Missing Cases applies the server\'s quick fix: `g (S _) = ?g_missing_case_1` where IDE mode puts it (F28)', async () => {
    const editor = await open('Part.idr', new vscode.Position(0, 0), { at: new vscode.Position(6, 7), text: 'printLn' });
    const doc = editor.document;
    const coverage = await waitFor('the coverage error of g', () => vscode.languages.getDiagnostics(doc.uri).find((d) => /Missing cases/.test(d.message)), 60000);
    editor.selection = new vscode.Selection(coverage.range.start, coverage.range.start);
    const saved = doc.getText();
    assertApplied(await runEditing(api, 'idris2.addMissingCases'), 'idris2.addMissingCases', doc);
    assert.strictEqual(doc.getText(), spliceLines(saved, 4, 0, 'g (S _) = ?g_missing_case_1'));
    await undoEdit(editor, saved);
  });

  test('Ambig.idr: Refine Hole… with an ambiguous name says so, and changes nothing (F34: the server reports no alternatives)', async () => {
    const editor = await open('Ambig.idr', new vscode.Position(13, 6), { at: new vscode.Position(12, 0), text: 'Nat' });
    const saved = editor.document.getText();
    const input = answerInputBox('foo');
    try {
      const outcome = await runEditing(api, 'idris2.refineHole');
      assert.ok(outcome.kind === 'message' && /ambiguous/.test(outcome.message), JSON.stringify(outcome));
    } finally {
      input.restore();
    }
    assert.strictEqual(editor.document.getText(), saved);
  });

  test('an edit undone back to the saved text leaves the server answering: the same command applies again without a save', async () => {
    const editor = await openClean(XS);
    const saved = editor.document.getText();
    const split = spliceLines(saved, 7, 1, 'vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1');
    assertApplied(await runEditing(api, 'idris2.caseSplit'), 'idris2.caseSplit', editor.document);
    await vscode.commands.executeCommand('undo');
    await waitFor('one undo to restore the file', () => (editor.document.getText() === saved && !editor.document.isDirty ? true : undefined));
    assertApplied(await runEditing(api, 'idris2.caseSplit'), 'idris2.caseSplit', editor.document);
    assert.strictEqual(editor.document.getText(), split);
    await undoEdit(editor, saved);
  });

  test('a clean document reloaded from disk leaves the server answering (review 1, M4)', async () => {
    const editor = await openClean(XS);
    const doc = editor.document;
    const saved = doc.getText();
    const answers = (what: string): Promise<boolean> =>
      waitFor(what, async () => ((await hovers(doc.uri, XS)).some((h) => h.value.includes('xs : Vect ?_ ?_')) ? true : undefined), 60000);
    for (const text of [`${saved}-- written by another program\n`, saved]) {
      fs.writeFileSync(doc.uri.fsPath, text);
      await waitFor('VS Code to reload the file', () => (doc.getText() === text && !doc.isDirty ? true : undefined), 30000);
      await answers('the hover of the reloaded file');
    }
  });

  test('a file saved while the server builds it is built again from the text saved (review 1, N1)', async () => {
    const uri = file('Slow.idr');
    fs.writeFileSync(uri.fsPath, slowModule('Slow'));
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const doc = editor.document;
    const value = new vscode.Position(doc.lineCount - 2, 0);
    const answers = (what: string): Promise<boolean> =>
      waitFor(what, async () => ((await hovers(uri, value)).some((h) => h.value.includes('value : Nat')) ? true : undefined), 60000);
    await answers('the server to load the module');
    const saveLine = async (text: string): Promise<void> => {
      assert.ok(await editor.edit((e) => e.replace(doc.lineAt(value.line).range, text)));
      assert.ok(await doc.save());
    };
    await saveLine('value = 2');
    // Inside the load of that save, which reads the file at its start and writes its TTC at its end.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await saveLine('value = "text"');
    await waitFor('the error of the text saved last', () => vscode.languages.getDiagnostics(uri).find((d) => /FromString Nat/.test(d.message)), 60000);
    await saveLine('value = 1');
    await answers('the module without the error');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a closed document keeps no problems of the server (review 1, M17)', async () => {
    // A file of its own, opened as a user does: VS Code holds what `openTextDocument` opened for minutes.
    const uri = file('Closed.idr');
    fs.writeFileSync(uri.fsPath, 'module Closed\n\nf : Nat\nf = "text"\n');
    await vscode.commands.executeCommand('vscode.open', uri);
    await waitFor('the error of f', () => (vscode.languages.getDiagnostics(uri).length > 0 ? true : undefined), 60000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor('the file to close', () => (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString()) ? undefined : true), 30000);
    await waitFor('its problems to go', () => (vscode.languages.getDiagnostics(uri).length === 0 ? true : undefined), 30000);
  });

  test('a stub server printing a mismatching "Idris2 API" gets the mismatch notification (M1)', async () => {
    // No server runs while the toolchain is scanned again (one compiler process at a time).
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('idris2.stopLanguageServer');
    await waitFor('no idris2-lsp process', () => (serverProcesses().length === 0 ? true : undefined));
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-stub-')));
    const stub = path.join(dir, 'idris2-lsp');
    // Only `--version`; started as a server it exits at once.
    fs.writeFileSync(stub, '#!/bin/sh\n[ "$1" = --version ] || exit 1\nprintf \'Idris2 LSP: 0.1.0-9a2f0ad6a\\nIdris2 API: 0.7.0\\n\'\n', { mode: 0o755 });
    const config = vscode.workspace.getConfiguration('idris2.toolchain');
    const before = api.notices.length;
    try {
      await config.update('lspPath', stub, vscode.ConfigurationTarget.Global);
      const snapshot = await waitFor('a scan with the stub', () => {
        const s = api.toolchain.current;
        return !api.toolchain.scanning && s?.lsp.status === 'probed' && s.lsp.location.path === stub ? s : undefined;
      }, 60000);
      assert.strictEqual(snapshot.verdict?.kind, 'likelyMismatch', JSON.stringify(snapshot.verdict));
      const shown = api.notices.slice(before);
      assert.deepStrictEqual(shown.map((n) => n.kind), ['pairMismatch']);
      assert.match(shown[0].message, /0\.7\.0/);
    } finally {
      await config.update('lspPath', SERVER, vscode.ConfigurationTarget.Global);
      await waitFor('a scan with the server again', () => (!api.toolchain.scanning && api.toolchain.current?.lsp.status === 'probed' && api.toolchain.current.lsp.location.path === SERVER ? true : undefined), 60000);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
