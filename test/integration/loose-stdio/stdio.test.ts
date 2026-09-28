// Suite `loose-stdio` (.vscode-test.mjs): workspace test/fixtures/workspaces/loose-file (no
// .ipkg), the fake tools, no idris2.ideMode.transport in the user settings: the default, stdio
// (ROADMAP §9 Q20, decided 2026-09-28). The workspace's .vscode/settings.json asks for the socket,
// which only user settings may choose (the setting's `application` scope), and sets
// idris2.checking.delay = 777, which shows that VS Code read the file. Loose files are checked in
// their directory with `idris2 --ide-mode` over standard input and output, and
// idris2.ideMode.loosePackages becomes `-p` arguments (F25). Tests that change a setting restore
// it.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import {
  checkSession,
  diagnosticsWhen,
  extensionApi,
  fakeIdeProcesses,
  setUserSetting,
  settledScan,
  showFile,
  statusText,
  waitFor,
  workspaceFile,
} from '../support';

suite('M2 loose files over stdio', () => {
  let api: TestApi;
  const dir = () => workspaceFile().fsPath;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Hello.idr is checked in its own directory with --ide-mode, and is clean', async () => {
    const doc = await showFile('Hello.idr');
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · ✓');
    await diagnosticsWhen(doc.uri, 'none', (l) => l.length === 0);
    const session = checkSession(api, dir());
    assert.ok(session?.launch);
    assert.strictEqual(session.launch.transport, 'stdio');
    assert.strictEqual(session.launch.cwd, dir());
    assert.deepStrictEqual(session.launch.args, ['--ide-mode', '--no-color', '--build-dir', path.join(dir(), 'build', '.vscode-idris2')]);
  });

  test('Q20: a workspace cannot choose the socket: its "socket" is ignored, the session runs over stdio and no fake compiler is started with --ide-mode-socket', async () => {
    const idris2 = vscode.workspace.getConfiguration('idris2');
    assert.strictEqual(idris2.get('checking.delay'), 777, 'VS Code read the workspace settings (a resource-scoped key applies)');
    assert.strictEqual(idris2.inspect('ideMode.transport')?.globalValue, undefined, 'the suite\'s profile sets no transport');
    assert.strictEqual(idris2.get('ideMode.transport'), 'stdio', 'the workspace value "socket" is not read');
    await showFile('Hello.idr');
    const launch = await waitFor('the check session to run', () => {
      const session = checkSession(api, dir());
      return session?.state === 'ready' ? session.launch : undefined;
    });
    assert.strictEqual(launch.transport, 'stdio');
    assert.deepStrictEqual(launch.args.slice(0, 2), ['--ide-mode', '--no-color']);
    const processes = fakeIdeProcesses(dir());
    if (processes !== undefined) {
      assert.ok(processes.length > 0, 'the fake compiler runs');
      assert.deepStrictEqual(processes.filter((line) => line.includes('--ide-mode-socket')), []);
    }
  });

  test('Lit.lidr (bird tracks, prose between the code) is checked by the same session', async () => {
    const doc = await showFile('Lit.lidr');
    await waitFor('Lit.lidr to be checked', () => (api.checks.loadStateOf(doc) === 'ok' ? true : undefined));
    assert.strictEqual(api.sessions.sessions().filter((s) => s.role === 'check').length, 1, 'one session per root');
  });

  test('idris2.ideMode.loosePackages restarts the running session with -p for each package', async () => {
    await showFile('Hello.idr');
    const session = checkSession(api, dir());
    assert.ok(session);
    await waitFor('the session to run', () => (session.state === 'ready' ? true : undefined));
    try {
      await setUserSetting('ideMode', 'loosePackages', ['contrib']);
      await waitFor('the session to run with -p contrib', () =>
        session.state === 'ready' && session.launch?.args.join(' ').includes('--no-color -p contrib --build-dir') === true ? true : undefined,
      );
    } finally {
      await setUserSetting('ideMode', 'loosePackages', undefined);
      await waitFor('the session to run without -p', () => (session.launch?.args.includes('-p') === false ? true : undefined));
    }
  });
});
