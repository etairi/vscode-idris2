// Suite `lsp` (.vscode-test.mjs; ROADMAP §5 M5, acceptance): when the language client starts the
// server, with which options, and Stop / Restart Language Server — against the fake idris2-lsp of
// test/fake-lsp, which replays the real server's recordings and logs what it reads (its starts and
// messages, test/integration/lsp/support.ts). The workspace folder is the package
// test/fixtures/workspaces/lsp-ipkg, so its files need no consent; `idris2.backend.mode` is `lsp` in
// the profile. This file must run first in the suite (.vscode-test.mjs lists it first): its first
// test needs a window in which no server has started yet.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { extensionApi, hoverWith, settledScan, setToolchainSetting, setUserSetting, statusText, waitFor } from '../support';
import { FakeLspLogs, fakeServers, opened, serverOptionsFromSettings, showDocument, source, statusMatches, useLogs, workspaceRealPath } from './support';

suite('M5 language client: when the server starts, with which options, Stop and Restart (fake idris2-lsp)', () => {
  let api: TestApi;
  let logs: FakeLspLogs;
  const clean = source('Clean.idr');

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    assert.deepStrictEqual(fakeServers(), [], 'a server runs before any document was shown: does this file run first (.vscode-test.mjs)?');
    logs = new FakeLspLogs();
    // No server runs yet, so the first one started writes the logs.
    await useLogs(api, logs, {}, false);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setUserSetting('backend', 'mode', 'lsp');
    await setUserSetting('lsp', 'showImplicits', undefined);
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('backend.mode = auto with a usable idris2: the package goes to IDE mode and no server starts (ROADMAP §9 Q7)', async () => {
    await setUserSetting('backend', 'mode', 'auto');
    const a = source('Foo', 'A.idr');
    const root = await api.projects.classify(a.fsPath);
    assert.strictEqual(root.kind, 'project');
    await waitFor('auto to route the package to IDE mode', () => (api.registry.routeFor(root).kind === 'ideMode' ? true : undefined));
    await showDocument(a);
    // The fake compiler checks it (simple-ipkg's recordings: the same bytes in a package of the same name).
    await statusMatches(api, /^Idris 2 0\.8\.0 · IDE mode · /);
    assert.deepStrictEqual(logs.starts(), [], 'no idris2-lsp was started');
    assert.deepStrictEqual(fakeServers(), []);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('backend.mode = lsp: a document of the package starts the server once, in the workspace folder, and reaches it', async () => {
    await setUserSetting('backend', 'mode', 'lsp');
    const root = await api.projects.classify(clean.fsPath);
    await waitFor('lsp to route the package to idris2-lsp', () => (api.registry.routeFor(root).kind === 'lsp' ? true : undefined));
    await showDocument(clean);
    await opened(logs, clean);
    const starts = logs.starts();
    assert.strictEqual(starts.length, 1, JSON.stringify(starts));
    // No arguments (the server, F20), started in the workspace folder (ROADMAP M5, security).
    assert.deepStrictEqual(starts[0].args, []);
    assert.strictEqual(starts[0].cwd, workspaceRealPath());
    assert.deepStrictEqual(fakeServers(), [starts[0].pid]);
    await statusMatches(api, /^Idris 2 0\.8\.0 · idris2-lsp/);
  });

  test('initializationOptions are the idris2.lsp settings, as one flat object (F20)', () => {
    const [init] = logs.withMethod('initialize');
    assert.ok(init, 'no initialize was read');
    assert.deepStrictEqual(init.message.params?.initializationOptions, serverOptionsFromSettings());
    // The defaults (package.json): logFile empty, so left out.
    assert.ok(!('logFile' in (init.message.params?.initializationOptions ?? {})));
  });

  test('changing idris2.lsp.showImplicits sends didChangeConfiguration with the options at the top level, and restarts nothing', async () => {
    const from = logs.messages().length;
    await setUserSetting('lsp', 'showImplicits', true);
    const change = await waitFor('a didChangeConfiguration with showImplicits true', () =>
      logs.withMethod('workspace/didChangeConfiguration', from).find((m) => m.message.params?.settings?.showImplicits === true),
    );
    // Top level, as processSettings reads it — not nested under idris2.lsp, which it ignores [live, recording `options`].
    assert.deepStrictEqual(change.message.params?.settings, serverOptionsFromSettings());
    assert.strictEqual(logs.starts().length, 1, 'the server was restarted');
    // The server now prints implicits: the hover recorded with showImplicits on (recording `options`).
    await hoverWith(clean, new vscode.Position(6, 0), 'vlen : {0 a : Type} -> {0 n : Nat} -> Vect n a -> Nat');
    const back = logs.messages().length;
    await setUserSetting('lsp', 'showImplicits', undefined);
    await waitFor('a didChangeConfiguration with showImplicits false', () =>
      logs.withMethod('workspace/didChangeConfiguration', back).find((m) => m.message.params?.settings?.showImplicits === false),
    );
  });

  test('Stop Language Server shuts the server down, and the status reads stopped', async () => {
    await showDocument(clean);
    const [pid] = fakeServers();
    await vscode.commands.executeCommand('idris2.stopLanguageServer');
    await waitFor(() => `the server to end (pids ${JSON.stringify(fakeServers())})`, () => (fakeServers().length === 0 ? true : undefined));
    const methods = logs.messages().filter((m) => m.pid === pid).map((m) => m.message.method);
    assert.deepStrictEqual(methods.slice(-2), ['shutdown', 'exit'], JSON.stringify(methods));
    await statusText(api, 'Idris 2 0.8.0 · idris2-lsp · stopped');
  });

  test('Restart Language Server starts a new server, which is sent the open document again', async () => {
    const from = logs.messages().length;
    await vscode.commands.executeCommand('idris2.restartLanguageServer');
    await waitFor('a second start', () => (logs.starts().length === 2 ? true : undefined));
    const second = logs.starts()[1];
    const reopened = await opened(logs, clean, from);
    assert.strictEqual(reopened.pid, second.pid);
    assert.deepStrictEqual(fakeServers(), [second.pid]);
    await statusMatches(api, /^Idris 2 0\.8\.0 · idris2-lsp(?! · stopped)/);
  });
});
