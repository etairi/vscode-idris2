// Suite `diagnostics` (.vscode-test.mjs): workspace test/fixtures/workspaces/broken, the fake
// tools, idris2.ideMode.transport = socket in the user settings (the opt-in of ROADMAP §9 Q20;
// the default is stdio, suite loose-stdio). The fake compiler replays the replies recorded from
// Idris 2 0.8.0 (test/fixtures/transcripts/0.8.0) for the requests the extension sends, so the
// diagnostics here are what the real compiler's replies turn into (ROADMAP M2 acceptance,
// integration part). Tests that change a setting restore it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { fakeScript } from '../../fake-tools/paths';
import {
  checkSession,
  diagnosticsWhen,
  extensionApi,
  fakeIdeProcesses,
  idrisDiagnostics,
  saveUnchanged,
  setToolchainSetting,
  setUserSetting,
  settledScan,
  showFile,
  statusText,
  waitFor,
  workspaceFile,
} from '../support';

const root = () => workspaceFile().fsPath;

function plainRange(d: vscode.Diagnostic): [number, number, number, number] {
  return [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character];
}

suite('M2 diagnostics (fake compiler replaying the 0.8.0 transcripts, socket transport)', () => {
  let api: TestApi;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Bad.idr: one Error at 0-based (3,6)–(3,11), message starting "While processing right hand side of f"; status "1 error"', async () => {
    const doc = await showFile('Bad.idr');
    const [error] = await diagnosticsWhen(doc.uri, 'one diagnostic', (list) => list.length === 1);
    assert.strictEqual(error.severity, vscode.DiagnosticSeverity.Error);
    assert.deepStrictEqual(plainRange(error), [3, 6, 3, 11]);
    assert.ok(error.message.startsWith('While processing right hand side of f'), error.message);
    assert.ok(!error.message.includes('Bad:4:7--4:12'), 'the source excerpt is off by default');
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · 1 error');
    const session = checkSession(api, root());
    assert.ok(session?.launch, 'the loose-file session of the workspace folder runs');
    assert.strictEqual(session.launch.transport, 'socket');
    assert.deepStrictEqual(session.launch.args.slice(0, 2), ['--ide-mode-socket', '--no-color']);
    assert.deepStrictEqual(session.launch.args.slice(2), ['--build-dir', path.join(root(), 'build', '.vscode-idris2')]);
    assert.strictEqual(api.sessions.effectiveCheckBuildDir(await api.projects.classify(doc.uri.fsPath)), path.join(root(), 'build', '.vscode-idris2'));
  });

  test('Warn.idr: one Warning "Unreachable clause: f n", zero errors; status "1 warning"', async () => {
    const doc = await showFile('Warn.idr');
    const list = await diagnosticsWhen(doc.uri, 'one diagnostic', (l) => l.length === 1);
    assert.deepStrictEqual(
      list.map((d) => [d.severity, d.message, plainRange(d)]),
      [[vscode.DiagnosticSeverity.Warning, 'Unreachable clause: f n', [4, 0, 4, 3]]],
    );
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · 1 warning');
  });

  test('Mixed.idr: the known warning stays a warning after the failed load, the type error is an error', async () => {
    const doc = await showFile('Mixed.idr');
    const list = await diagnosticsWhen(doc.uri, 'two diagnostics', (l) => l.length === 2);
    assert.deepStrictEqual(
      list.map((d) => [d.severity, d.message.split('\n', 1)[0]]),
      [
        [vscode.DiagnosticSeverity.Warning, 'Unreachable clause: f n'],
        [vscode.DiagnosticSeverity.Error, 'While processing right hand side of g. When unifying:'],
      ],
    );
  });

  test('UsesBad.idr: the imported Bad.idr gets its error; UsesBad.idr says it was not checked, pointing there', async () => {
    const doc = await showFile('UsesBad.idr');
    const [notChecked] = await diagnosticsWhen(doc.uri, 'one diagnostic', (l) => l.length === 1);
    assert.strictEqual(notChecked.message, 'Not checked: the compiler reported errors in Bad.idr.');
    assert.strictEqual(notChecked.relatedInformation?.[0].location.uri.fsPath, workspaceFile('Bad.idr').fsPath);
    assert.deepStrictEqual(idrisDiagnostics(workspaceFile('Bad.idr')).map(plainRange), [[3, 6, 3, 11]]);
  });

  test('Err.lidr (bird tracks): the range is in file columns, 2 to the right of the compiler\'s unlit columns (F11)', async () => {
    const doc = await showFile('Err.lidr');
    const [error] = await diagnosticsWhen(doc.uri, 'one diagnostic', (l) => l.length === 1);
    assert.deepStrictEqual(plainRange(error), [8, 6, 8, 9]);
    assert.strictEqual(doc.getText(error.range), '"x"');
  });

  test('ErrMd.idr.md (literate Markdown, an Idris document by its double extension): exact columns', async () => {
    const doc = await showFile('ErrMd.idr.md');
    assert.strictEqual(doc.languageId, 'markdown');
    const [error] = await diagnosticsWhen(doc.uri, 'one diagnostic', (l) => l.length === 1);
    assert.deepStrictEqual(plainRange(error), [8, 4, 8, 7]);
    assert.strictEqual(doc.getText(error.range), '"x"');
  });

  test('bad-ipkg/Main.idr: the malformed .ipkg gets one error at 1-based 3:1; status "package file error"', async () => {
    const doc = await showFile('bad-ipkg', 'Main.idr');
    const ipkg = workspaceFile('bad-ipkg', 'bad.ipkg');
    const [error] = await diagnosticsWhen(ipkg, 'one diagnostic', (l) => l.length === 1);
    assert.strictEqual(error.severity, vscode.DiagnosticSeverity.Error);
    assert.strictEqual(error.range.start.line + 1, 3);
    assert.strictEqual(error.range.start.character + 1, 1);
    assert.strictEqual(error.message, 'Unrecognised property "pkgs".');
    const [notChecked] = idrisDiagnostics(doc.uri);
    assert.strictEqual(notChecked.message, 'Not checked: the package file bad.ipkg could not be read.');
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · package file error');
    assert.strictEqual(api.checks.loadStateOf(doc), 'ipkgError');
  });

  suite('Stop Backend and restarts', () => {
    test('Stop Backend (this project) stops its process and the status reads "stopped"; the next save starts it again', async () => {
      const doc = await showFile('Bad.idr');
      await diagnosticsWhen(doc.uri, 'shown', (l) => l.length === 1);
      const session = checkSession(api, root());
      assert.ok(session);
      await waitFor('the session to be ready', () => (session.state === 'ready' ? true : undefined));
      await vscode.commands.executeCommand('idris2.stopBackend', 'current');
      await waitFor('the session to stop', () => (session.state === 'stopped' ? true : undefined));
      assert.strictEqual(session.launch, undefined);
      await statusText(api, 'Idris 2 0.8.0 · IDE mode · stopped');
      await saveUnchanged(doc);
      await waitFor('the session to run again', () => (session.state === 'ready' && session.launch !== undefined ? true : undefined));
      await statusText(api, 'Idris 2 0.8.0 · IDE mode · 1 error');
    });

    test('Stop Backend (all projects) leaves no compiler process', async () => {
      const running = fakeIdeProcesses(root());
      if (running !== undefined) {
        assert.ok(running.length >= 1, 'the check of the process list sees the running session');
      }
      await vscode.commands.executeCommand('idris2.stopBackend', 'all');
      await waitFor('every session to stop', () => (api.sessions.sessions().every((s) => s.state === 'stopped') ? true : undefined));
      if (fakeIdeProcesses(root()) !== undefined) {
        await waitFor('no fake compiler process in IDE mode for this workspace', () => (fakeIdeProcesses(root())?.length === 0 ? true : undefined));
      }
    });

    test('Check File starts the session again and checks the active file', async () => {
      const doc = await showFile('Bad.idr');
      await vscode.commands.executeCommand('idris2.checkFile');
      assert.strictEqual(api.checks.loadStateOf(doc), 'errors');
      assert.strictEqual(checkSession(api, root())?.state, 'ready');
    });

    test('changing idris2.toolchain.idris2Path to a second fake compiler restarts the running session with it', async () => {
      const original = vscode.workspace.getConfiguration('idris2.toolchain').inspect<string>('idris2Path')?.globalValue;
      assert.ok(original);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-second-'));
      const second = path.join(dir, process.platform === 'win32' ? 'idris2.cmd' : 'idris2');
      // The second compiler logs its command lines to a file of its own: the evidence that it ran,
      // not just that the extension recorded its path.
      const invocations = path.join(dir, 'second.jsonl');
      if (process.platform === 'win32') {
        fs.writeFileSync(second, `@set "FAKE_IDRIS2_LOG=${invocations}"\r\n@node "${fakeScript('idris2')}" %*\r\n`);
      } else {
        fs.writeFileSync(second, `#!/bin/sh\nFAKE_IDRIS2_LOG='${invocations}'\nexport FAKE_IDRIS2_LOG\nexec node "${fakeScript('idris2')}" "$@"\n`, { mode: 0o755 });
      }
      const ideModeRuns = (): { args: string[]; cwd: string }[] =>
        fs.existsSync(invocations)
          ? fs
              .readFileSync(invocations, 'utf8')
              .split('\n')
              .filter((line) => line !== '')
              .map((line) => JSON.parse(line) as { args: string[]; cwd: string })
              .filter((run) => run.args[0] === '--ide-mode-socket')
          : [];
      try {
        const doc = await showFile('Bad.idr');
        await diagnosticsWhen(doc.uri, 'shown', (l) => l.length === 1);
        const session = checkSession(api, root());
        assert.ok(session);
        await waitFor('the session to run', () => (session.state === 'ready' ? true : undefined));
        assert.strictEqual(session.launch?.executable, original);
        await setToolchainSetting(api, 'idris2Path', second);
        await waitFor(`the session to run ${second}`, () =>
          session.state === 'ready' && session.launch?.executable === second ? true : undefined,
        );
        assert.deepStrictEqual(session.launch?.args.slice(0, 2), ['--ide-mode-socket', '--no-color']);
        // The second binary itself ran in IDE mode, in the session directory.
        const [run] = ideModeRuns();
        assert.ok(run, `no --ide-mode-socket run in ${invocations}`);
        assert.deepStrictEqual(run.args.slice(0, 2), ['--ide-mode-socket', '--no-color']);
        assert.strictEqual(fs.realpathSync(run.cwd), fs.realpathSync(root()));
        // It still answers: Check File's :load-file goes to that process and is answered (the load
        // state alone would not show it: a cancelled or refused load keeps the previous one).
        const changes: string[] = [];
        const subscription = session.onDidChangeState((change) => changes.push(`${change.state} (${change.cause})`));
        try {
          await vscode.commands.executeCommand('idris2.checkFile');
        } finally {
          subscription.dispose();
        }
        const sent = changes.indexOf('busy (dispatch)');
        assert.ok(sent >= 0 && changes.indexOf('ready (reply)', sent) > sent, changes.join(', '));
        assert.ok(!changes.some((c) => c.startsWith('restarting') || c.startsWith('stopped')), changes.join(', '));
        assert.strictEqual(session.launch?.executable, second);
        assert.strictEqual(api.checks.loadStateOf(doc), 'errors');
        assert.strictEqual(ideModeRuns().length, 1, 'the same process answered');
      } finally {
        await setToolchainSetting(api, 'idris2Path', original);
        await waitFor('the session to run the first fake again', () => {
          const session = checkSession(api, root());
          return session?.launch === undefined || session.launch.executable === original ? true : undefined;
        });
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('Restart Backend (this project) starts a new process and checks the visible file again', async () => {
      const doc = await showFile('Bad.idr');
      await diagnosticsWhen(doc.uri, 'shown', (l) => l.length === 1);
      const session = checkSession(api, root());
      assert.ok(session);
      await waitFor('the session to run', () => (session.state === 'ready' ? true : undefined));
      const changes: string[] = [];
      const subscription = session.onDidChangeState((change) => changes.push(`${change.state} (${change.cause})`));
      try {
        // The command resolves once the visible file has been checked again.
        await vscode.commands.executeCommand('idris2.restartBackend', 'current');
        const restarted = changes.indexOf('restarting (restart)');
        const answered = changes.indexOf('ready (handshake)', restarted);
        // A request (the :load-file of the visible file) was sent to the new process.
        const sent = changes.indexOf('busy (dispatch)', answered);
        assert.ok(restarted >= 0 && answered > restarted && sent > answered, changes.join(', '));
        assert.strictEqual(api.checks.loadStateOf(doc), 'errors');
      } finally {
        subscription.dispose();
      }
    });

    // M2 second verification of the third review: VS Code sends a file's text change with the dirty
    // state from before it and the new state in a second event [src]; the checks took the first
    // keystroke after a check for a reload from disk, loaded the saved file again (restarting a
    // stopped compiler), and an undo back to the saved text read `stale`. This pins the order
    // (ROADMAP M2 As built, *Documents and triggers*) and what the checks make of it.
    test('a keystroke loads nothing and reads "stale", an undo reads the result again, and after Stop Backend a keystroke starts nothing', async () => {
      const doc = await showFile('Bad.idr');
      await diagnosticsWhen(doc.uri, 'shown', (l) => l.length === 1);
      await statusText(api, 'Idris 2 0.8.0 · IDE mode · 1 error');
      const session = checkSession(api, root());
      assert.ok(session);
      await waitFor('the session to be ready', () => (session.state === 'ready' ? true : undefined));
      const events: string[] = [];
      const changes: string[] = [];
      const subscriptions = [
        vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document === doc) {
            events.push(`${e.contentChanges.length} ${e.document.isDirty ? 'dirty' : 'clean'}`);
          }
        }),
        session.onDidChangeState((change) => changes.push(`${change.state} (${change.cause})`)),
      ];
      const keystroke = async (): Promise<void> => {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, ' ');
        assert.ok(await vscode.workspace.applyEdit(edit));
      };
      // Long enough for a check to have started: the old code dispatched its load within milliseconds.
      const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await keystroke();
        await statusText(api, 'Idris 2 0.8.0 · IDE mode · stale');
        await quiet();
        assert.deepStrictEqual(events, ['1 clean', '0 dirty'], 'the text change carries the dirty state from before it');
        assert.ok(!changes.includes('busy (dispatch)'), `a keystroke sent a request: ${changes.join(', ')}`);
        assert.strictEqual(api.checks.loadStateOf(doc), 'errors');
        events.length = 0;
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('undo');
        await waitFor('the undo', () => (doc.isDirty ? undefined : true));
        await statusText(api, 'Idris 2 0.8.0 · IDE mode · 1 error');
        await quiet();
        assert.deepStrictEqual(events, ['1 dirty', '0 clean'], 'the undo: text change, then clean');
        assert.ok(!changes.includes('busy (dispatch)'), `the undo sent a request: ${changes.join(', ')}`);
        await vscode.commands.executeCommand('idris2.stopBackend', 'current');
        await waitFor('the session to stop', () => (session.state === 'stopped' ? true : undefined));
        await statusText(api, 'Idris 2 0.8.0 · IDE mode · stopped');
        changes.length = 0;
        await keystroke();
        await quiet();
        assert.deepStrictEqual(changes, [], 'the stopped compiler was started again');
        assert.strictEqual(session.launch, undefined);
        await statusText(api, 'Idris 2 0.8.0 · IDE mode · stopped');
      } finally {
        subscriptions.forEach((s) => s.dispose());
        if (doc.isDirty) {
          await vscode.window.showTextDocument(doc);
          await vscode.commands.executeCommand('workbench.action.files.revert');
        }
      }
      assert.ok(!doc.isDirty);
      await vscode.commands.executeCommand('idris2.checkFile');
      assert.strictEqual(checkSession(api, root())?.state, 'ready');
    });
  });

  test('every contributed command is registered, and the status QuickPick lists the submenu as registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const manifest = vscode.extensions.getExtension('etairi.vscode-idris2')?.packageJSON as {
      contributes: { commands: { command: string }[]; menus: Record<string, { command?: string }[]> };
    };
    for (const { command } of manifest.contributes.commands) {
      assert.ok(registered.has(command), `${command} is contributed but not registered`);
    }
    // Every registered idris2.* command is contributed, except the status item's Allow… (it
    // needs a directory argument, so it is not offered in the Command Palette).
    const internal = [...registered].filter((c) => c.startsWith('idris2.') && !manifest.contributes.commands.some((m) => m.command === c));
    assert.deepStrictEqual(internal, ['idris2.allowFolder']);
    const menu = api.statusMenuEntries().map((e) => e.command);
    for (const command of ['idris2.checkFile', 'idris2.restartBackend', 'idris2.stopBackend', 'idris2.manageAllowedFolders', 'idris2.showProtocolTrace']) {
      assert.ok(menu.includes(command), `${command} is not in the status QuickPick`);
      assert.ok(registered.has(command));
    }
  });

  // ROADMAP §9 Q21 in a running VS Code (verification after Q20–Q22: only unit tests with fakes had
  // set either limit). The workspace has two roots: the loose files of broken/ (session directory
  // root()) and the project broken/bad-ipkg/.
  suite('the resource limits (ROADMAP §9 Q21)', () => {
    /** Stops every session and waits until none has a process. */
    async function stopAll(): Promise<void> {
      await vscode.commands.executeCommand('idris2.stopBackend', 'all');
      await waitFor('every session to stop', () =>
        api.sessions.sessions().every((s) => s.state === 'stopped' || s.state === 'failed') ? true : undefined,
      );
    }

    /** Opens `segments` in editor group `column` (it becomes the active editor) and checks it. */
    async function checkIn(column: vscode.ViewColumn, ...segments: string[]): Promise<vscode.TextDocument> {
      const doc = await vscode.workspace.openTextDocument(workspaceFile(...segments));
      await vscode.window.showTextDocument(doc, { viewColumn: column });
      // Shown before in this suite, a document is not checked again by being shown: Check File.
      await vscode.commands.executeCommand('idris2.checkFile');
      return doc;
    }

    test('maxSessions 1: the idle session of the root that is not the active file\'s is stopped (evicted), its file keeps its result, and its next check starts it again and evicts the other', async function () {
      this.timeout(60000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await stopAll();
      await setUserSetting('ideMode', 'maxSessions', 1);
      const subscriptions: vscode.Disposable[] = [];
      try {
        const bad = await checkIn(vscode.ViewColumn.One, 'Bad.idr');
        assert.strictEqual(idrisDiagnostics(bad.uri).length, 1);
        const loose = checkSession(api, root());
        assert.ok(loose);
        await waitFor('the loose session to be ready', () => (loose.state === 'ready' ? true : undefined));
        const looseChanges: string[] = [];
        subscriptions.push(loose.onDidChangeState((change) => looseChanges.push(`${change.state} (${change.cause})`)));

        // A second root's file, active in a second group: its session starts, the loose one is idle
        // and not the active file's, so it goes.
        const main = await checkIn(vscode.ViewColumn.Two, 'bad-ipkg', 'Main.idr');
        await diagnosticsWhen(workspaceFile('bad-ipkg', 'bad.ipkg'), 'the package file error', (l) => l.length === 1);
        const project = checkSession(api, workspaceFile('bad-ipkg').fsPath);
        assert.ok(project);
        await waitFor(
          () => `the loose session to be evicted (its changes: ${looseChanges.join(', ')})`,
          () => (looseChanges.includes('stopped (evicted)') ? true : undefined),
        );
        assert.strictEqual(loose.state, 'stopped');
        assert.strictEqual(loose.launch, undefined);
        assert.strictEqual(project.state, 'ready', 'the active file\'s session runs');
        assert.strictEqual(api.checks.activeDocument()?.uri.fsPath, main.uri.fsPath);
        assert.strictEqual(idrisDiagnostics(bad.uri).length, 1, 'Bad.idr keeps its error');
        if (fakeIdeProcesses(root()) !== undefined) {
          await waitFor('one fake compiler process in IDE mode', () => (fakeIdeProcesses(root())?.length === 1 ? true : undefined));
        }

        // Back to Bad.idr: an eviction is not shown as "stopped", and nothing is started by looking.
        // Shown in the second group, where Main.idr's editor is: when the test window has no OS
        // focus, showing it in the first group made that group active but left
        // `window.activeTextEditor` on Main.idr, whose code editor kept the focus (observed
        // 2026-09-28, VS Code 1.139.1); the active editor of the focused group follows its document.
        await vscode.window.showTextDocument(bad, { viewColumn: vscode.ViewColumn.Two });
        await waitFor('Bad.idr to be the active editor', () =>
          vscode.window.activeTextEditor?.document.uri.fsPath === bad.uri.fsPath ? true : undefined,
        );
        await statusText(api, 'Idris 2 0.8.0 · IDE mode · 1 error');
        assert.strictEqual(loose.state, 'stopped');
        // Its next check starts its compiler again; the project's, idle now and not the active
        // file's, goes in turn.
        const projectChanges: string[] = [];
        subscriptions.push(project.onDidChangeState((change) => projectChanges.push(`${change.state} (${change.cause})`)));
        await saveUnchanged(bad);
        await waitFor('the loose session to run again', () => (loose.state === 'ready' && loose.launch !== undefined ? true : undefined));
        await waitFor(
          () => `the project session to be evicted (its changes: ${projectChanges.join(', ')})`,
          () => (projectChanges.includes('stopped (evicted)') ? true : undefined),
        );
        await statusText(api, 'Idris 2 0.8.0 · IDE mode · 1 error');
        assert.strictEqual(idrisDiagnostics(bad.uri).length, 1);
        assert.strictEqual(idrisDiagnostics(workspaceFile('bad-ipkg', 'bad.ipkg')).length, 1, 'the package file error stays too');
      } finally {
        subscriptions.forEach((s) => s.dispose());
        await setUserSetting('ideMode', 'maxSessions', undefined);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    });

    test('maxBackgroundChecks 1 with the Output panel focused: the last Idris file stays the active one, two background files of other roots are compiled one after the other, and the active file\'s check runs', async function () {
      // M2 verification of the Q20–Q22 fixes: the earlier form of this test swallowed a time-out
      // waiting for the Output panel, had one background file only (so the limit never held one
      // back), and read a state that a cancelled check leaves too. The workspace's third root is the
      // loose folder broken/warnings/.
      this.timeout(60000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await stopAll();
      await setUserSetting('ideMode', 'maxBackgroundChecks', 1);
      /** The state changes of the `check` sessions, as `<session directory relative to broken/> <state> (<cause>)`. */
      const events: string[] = [];
      const subscription = api.sessions.onDidChange(({ session, change }) => {
        if (session.role === 'check') {
          events.push(`${path.relative(root(), session.cwd) || '.'} ${change.state} (${change.cause})`);
        }
      });
      try {
        await checkIn(vscode.ViewColumn.One, 'Bad.idr');
        await checkIn(vscode.ViewColumn.Two, 'warnings', 'Deprecated.idr');
        const main = await checkIn(vscode.ViewColumn.Three, 'bad-ipkg', 'Main.idr');
        assert.strictEqual(api.checks.activeDocument()?.uri.fsPath, main.uri.fsPath);
        await vscode.commands.executeCommand('idris2.showOutput');
        // VS Code 1.139.1 reports the focused Output panel as the active text editor, a document of
        // scheme `output` [live, this suite's earlier form, 2026-09-28].
        const output = await waitFor('the Output panel to be the active editor', () =>
          vscode.window.activeTextEditor?.document.uri.scheme === 'output' ? vscode.window.activeTextEditor : undefined,
        );
        console.log(`      [Q21] with the Output panel focused, window.activeTextEditor is output:${path.basename(output.document.uri.path)}`);
        assert.strictEqual(api.checks.activeDocument()?.uri.fsPath, main.uri.fsPath, 'looking at the log keeps Main.idr the active file');
        // From stopped sessions, Restart Backend (all) checks the three visible files again and
        // resolves when the checks have ended.
        await stopAll();
        events.length = 0;
        await vscode.commands.executeCommand('idris2.restartBackend', 'all');
        const trace = () => events.join(', ');
        const index = (event: string, from = 0) => events.findIndex((e, i) => i >= from && e === event);
        const dispatched = (dir: string) => index(`${dir} busy (dispatch)`);
        const answered = (dir: string) => index(`${dir} ready (reply)`, dispatched(dir));
        for (const dir of ['.', 'warnings', 'bad-ipkg']) {
          assert.ok(dispatched(dir) >= 0 && answered(dir) > dispatched(dir), `${dir} was checked: ${trace()}`);
        }
        // The two background files: one slot, so the second is not sent before the first is answered.
        const [first, second] = ['.', 'warnings'].sort((a, b) => dispatched(a) - dispatched(b));
        assert.ok(dispatched(second) > answered(first), `one background check at a time: ${trace()}`);
        assert.strictEqual(api.checks.loadStateOf(main), 'ipkgError', 'Main.idr\'s check completed');
        // Whether Main.idr's load went before the second background one is a matter of timing here
        // (it starts at once, the second after the first's answer and its own process start); the
        // unit tests pin it (diagnosticsChecks.test.ts, session.test.ts).
        console.log(`      [Q21] the check sessions after Restart Backend: ${trace()}`);
      } finally {
        subscription.dispose();
        await setUserSetting('ideMode', 'maxBackgroundChecks', undefined);
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
    });
  });
});
