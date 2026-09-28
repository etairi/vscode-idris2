// E2E (ROADMAP M2 acceptance): the extension's own IDE-mode sessions with the real idris2, driven
// through VS Code (opening and saving documents) and the extension's session pool (the test
// API's `sessions`): the ipkg workspace loads over stdio (the default, ROADMAP §9 Q20), a loose
// file loads once its folder is allowed, a killed compiler is replaced within 2 s, 100 saves leave
// one process, the TTC files go only to the isolated build directory that `effectiveCheckBuildDir`
// names (F32), and the socket transport, opted into in the user settings, restarts the session
// with --ide-mode-socket and loads as well.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadFile } from '../../src/backend/ide/protocol';
import type { IdeSession, Reply, SessionStateChange } from '../../src/backend/ide/types';
import type { TestApi } from '../../src/extension';
import type { Classification } from '../../src/project/types';
import { copyWorkspace, filesBelow, ideProcesses } from './ideDriver';
import { extensionApi, quiesce, waitFor, workspaceDir } from './helpers';

/** A `:load-file` of `file` through `session`, as the extension sends it. */
const load = (session: IdeSession, file: string): Promise<Reply> =>
  session.request(loadFile(file), { kind: 'load', file: { path: file } });

/** Resolves with the first state change of `session` that `pred` accepts. */
function stateChange(session: IdeSession, pred: (change: SessionStateChange) => boolean): Promise<SessionStateChange> {
  return new Promise((resolve) => {
    const listener = session.onDidChangeState((change) => {
      if (pred(change)) {
        listener.dispose();
        resolve(change);
      }
    });
  });
}

/** Waits until `session` has loaded `file` and has nothing in flight. */
async function loaded(session: IdeSession, file: string): Promise<void> {
  await waitFor(`${file} to be loaded`, () => (session.state === 'ready' && session.loadedFile?.path === file ? true : undefined));
}

/** No warning in a load's reply, and an `:ok` return. */
function assertClean(reply: Reply): void {
  assert.strictEqual(reply.payload.kind, 'ok', JSON.stringify(reply.payload));
  assert.deepStrictEqual(reply.messages.filter((m) => m.kind === 'warning'), []);
}

suite('E2E: the extension\'s IDE-mode sessions with the real idris2', function () {
  this.timeout(120000);
  let api: TestApi;
  let ws: string;
  let bFile: string;
  let isolated: string;
  let before: Set<string>;
  let root: Classification;
  let session: IdeSession;

  suiteSetup(async function () {
    this.timeout(90000);
    api = await extensionApi();
    await quiesce(api);
    ws = workspaceDir();
    bFile = path.join(ws, 'src', 'Foo', 'B.idr');
    isolated = path.join(ws, 'build', '.vscode-idris2');
    // Generated output of earlier runs (git-ignored); anything else under build/ is left alone.
    fs.rmSync(isolated, { recursive: true, force: true });
    before = new Set(filesBelow(ws));
    root = await api.projects.classify(bFile);
    assert.strictEqual(root.kind, 'project');
    session = api.sessions.sessionFor(root, 'check');
  });

  suiteTeardown(async function () {
    this.timeout(60000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    api.sessions.stop();
    await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
    fs.rmSync(isolated, { recursive: true, force: true });
    const build = path.join(ws, 'build');
    if (fs.existsSync(build) && fs.readdirSync(build).length === 0) {
      fs.rmdirSync(build);
    }
  });

  test('simple-ipkg/src/Foo/B.idr (depends = contrib) loads cleanly on open, in one stdio session in the ipkg directory', async () => {
    const doc = await vscode.workspace.openTextDocument(bFile);
    await vscode.window.showTextDocument(doc);
    await loaded(session, bFile); // the load on open (idris2.checking.trigger = onSave)
    assertClean(await load(session, bFile));
    assert.deepStrictEqual(vscode.languages.getDiagnostics(doc.uri), []);

    const launch = session.launch;
    assert.ok(launch);
    assert.strictEqual(launch.cwd, ws);
    assert.strictEqual(launch.transport, 'stdio'); // the default on every platform (ROADMAP §9 Q20)
    assert.deepStrictEqual(launch.args, ['--ide-mode', '--no-color', '--build-dir', isolated]);
    const processes = ideProcesses();
    assert.strictEqual(processes.length, 1, JSON.stringify(processes));
    assert.match(processes[0].command, /\s--ide-mode\s--no-color\s--build-dir\s/);
  });

  test('TTC files appear only under build/.vscode-idris2, which effectiveCheckBuildDir names (F32)', async () => {
    await loaded(session, bFile);
    assert.strictEqual(api.sessions.effectiveCheckBuildDir(root), isolated);
    const written = filesBelow(ws).filter((f) => !before.has(f));
    assert.ok(written.length > 0, 'nothing was written');
    for (const f of written) {
      assert.match(f, /^build\/\.vscode-idris2\/ttc\/\d+\/Foo\/[AB]\.tt[cm]$/);
    }
    assert.ok(written.some((f) => f.endsWith('/Foo/A.ttc')) && written.some((f) => f.endsWith('/Foo/B.ttc')), written.join(', '));
  });

  test('killing the compiler restores service within 2 s', async () => {
    await loaded(session, bFile);
    const [victim, ...others] = ideProcesses();
    assert.ok(victim && others.length === 0);
    const ended = stateChange(session, (c) => c.cause === 'exit');
    const killed = Date.now();
    process.kill(victim.compilerPid, 'SIGKILL');
    await ended;
    assertClean(await load(session, bFile));
    const elapsed = Date.now() - killed;
    assert.ok(elapsed <= 2000, `service came back after ${elapsed} ms`);
    const [replacement, ...more] = ideProcesses();
    assert.ok(replacement && more.length === 0);
    assert.notStrictEqual(replacement.pid, victim.pid);
  });

  test('100 consecutive saves leave exactly one idris2 process for the root', async function () {
    this.timeout(300000);
    const original = fs.readFileSync(bFile);
    const doc = await vscode.workspace.openTextDocument(bFile);
    const editor = await vscode.window.showTextDocument(doc);
    let most = 0;
    try {
      for (let i = 0; i < 100; i++) {
        // Alternately add and remove a trailing space line, so every save changes the file.
        const end = doc.lineAt(doc.lineCount - 1).range.end;
        const ok = await editor.edit((edit) =>
          i % 2 === 0 ? edit.insert(end, ' ') : edit.delete(new vscode.Range(end.translate(0, -1), end)),
        );
        assert.ok(ok, `edit ${i}`);
        assert.ok(await doc.save(), `save ${i}`);
        most = Math.max(most, ideProcesses().length);
      }
      await loaded(session, bFile);
      assert.strictEqual(ideProcesses().length, 1);
      assert.ok(most <= 1, `${most} IDE-mode processes at once during the saves`);
      assertClean(await load(session, bFile));
      // What the extension shows after the overlapping checks of the saves: every result applied
      // in order, the newest setting the state (checks.ts, "Results").
      await waitFor('the checks of B.idr to settle', () => (api.checks.loadStateOf(doc) !== 'loading' ? true : undefined));
      assert.deepStrictEqual(vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'idris2'), []);
      assert.deepStrictEqual(api.checks.statusOf(doc, root), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
    } finally {
      if (!fs.readFileSync(bFile).equals(original)) {
        fs.writeFileSync(bFile, original);
      }
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    assert.strictEqual(doc.getText(), original.toString('utf8'));
  });

  test('the socket transport, opted into in the user settings (ROADMAP §9 Q20): the session restarts with --ide-mode-socket and loads cleanly', async () => {
    await loaded(session, bFile);
    const idris2 = vscode.workspace.getConfiguration('idris2');
    const restarted = stateChange(session, (c) => c.cause === 'reconfigure');
    await idris2.update('ideMode.transport', 'socket', vscode.ConfigurationTarget.Global);
    try {
      await restarted;
      await waitFor('the socket session to answer', () => (session.state === 'ready' && session.launch?.transport === 'socket' ? true : undefined));
      assertClean(await load(session, bFile));
      assert.deepStrictEqual(session.launch?.args, ['--ide-mode-socket', '--no-color', '--build-dir', isolated]);
      const processes = ideProcesses();
      assert.strictEqual(processes.length, 1, JSON.stringify(processes));
      assert.match(processes[0].command, /\s--ide-mode-socket\s--no-color\s--build-dir\s/);
    } finally {
      await idris2.update('ideMode.transport', undefined, vscode.ConfigurationTarget.Global);
      // Back to stdio: the running session restarts once more (one process at a time, the old one
      // ends first); a session that is not running has no launch.
      await waitFor('the session to leave the socket', () => (session.launch?.transport !== 'socket' ? true : undefined));
    }
    assertClean(await load(session, bFile));
    assert.strictEqual(session.launch?.transport, 'stdio');
    assert.strictEqual(ideProcesses().length, 1);
  });

  test('a loose file outside the workspace loads once its folder is allowed; F4 replies are attributed', async () => {
    // One compiler at a time: the package's session goes first.
    api.sessions.stop(root);
    await waitFor('the package session to end', () => (ideProcesses().length === 0 ? true : undefined));
    const { dir, root: looseDir } = copyWorkspace('loose-file');
    const hello = path.join(looseDir, 'Hello.idr');
    try {
      const looseRoot = await api.projects.classify(hello);
      assert.strictEqual(looseRoot.kind, 'loose');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(hello));
      // The session's directory is outside every workspace folder: the user is asked first
      // (ROADMAP §9, decided 2026-09-27), and nothing runs until then.
      const [question] = await waitFor('the consent question', () => {
        const open = api.consent.openQuestions();
        return open.length > 0 ? open : undefined;
      });
      assert.strictEqual(question, looseDir);
      assert.deepStrictEqual(ideProcesses(), []);
      assert.ok(api.consent.respond(question, 'allow'));

      const loose = api.sessions.sessionFor(looseRoot, 'check');
      await loaded(loose, hello);
      const reply = await load(loose, hello);
      assertClean(reply);
      assert.strictEqual(loose.launch?.cwd, looseDir);
      assert.deepStrictEqual(loose.launch?.args.slice(1), ['--no-color', '--build-dir', path.join(looseDir, 'build', '.vscode-idris2')]);
      assert.strictEqual(api.sessions.effectiveCheckBuildDir(looseRoot), path.join(looseDir, 'build', '.vscode-idris2'));

      // F4 through the real session: `cd` is not a command, and the compiler answers with the
      // previous request's id, which the session attributes to the request in flight.
      const cd = await loose.request({ kind: 'raw', text: '(:cd "/tmp")' }, { kind: 'lookup' });
      assert.ok(cd.payload.kind === 'error' && cd.payload.message === `Unrecognised command: ((:cd "/tmp") ${cd.id})`, JSON.stringify(cd.payload));
      assert.strictEqual(cd.returnedId, reply.id);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      api.sessions.stop();
      await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
