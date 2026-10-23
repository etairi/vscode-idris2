// Suite `lsp` (.vscode-test.mjs; ROADMAP §5 M5, acceptance and security): which documents reach the
// server. A document of a root switched to IDE mode (**Switch Backend…**) stops reaching it; a loose
// file with `backend.mode = lsp` gets the one-time "no .ipkg" notification and never reaches it; a
// server's response error with code 3 `Cannot find the ipkg file` (F35's source path, the fake's
// `missing-ipkg` fault) gives that notification too; a document of a package outside the workspace
// folder does not reach the server while the consent gate (M2) has not allowed its folder. Against the
// fake idris2-lsp (test/fake-lsp), whose message log is what reached the server. The notifications are
// read from the test API (`routingNotices`) and, to see that nothing else is shown, through a stub of
// `window.show*Message` (the test files and the extension share one `vscode` API object,
// test/integration/support.ts).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { RoutingNotice } from '../../../src/features/backend/types';
import { acceptQuickPick, answerMessages, extensionApi, hovers, settledScan, setToolchainSetting, waitFor, waitForAsync, workspaceFile } from '../support';
import { FakeLspLogs, opened, showDocument, source, statusMatches, useLogs } from './support';

/** Another fixture workspace, beside the suite's. */
const fixture = (...segments: string[]): vscode.Uri => vscode.Uri.file(path.join(path.dirname(workspaceFile().fsPath), ...segments));

/** Waits 1 s (the suites' shortest wait, ARCHITECTURE §12) for something that must not happen. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1000));

/** The language client's question after a change of `idris2.toolchain.env` (`backend/lsp/client.ts`, *Settings*). */
const RESTART_PROMPT = /Restart the language server\?$/;

suite('M5 routing: which documents reach the server (fake idris2-lsp)', () => {
  let api: TestApi;
  let logs: FakeLspLogs;
  const notices = (kind: RoutingNotice['kind'], from = 0): RoutingNotice[] => api.routingNotices.slice(from).filter((n) => n.kind === kind);

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLspLogs();
    await useLogs(api, logs);
  });

  /** Set by a test that remembers a backend choice: forgets it. */
  let restoreChoice: (() => Promise<void>) | undefined;

  teardown(async () => {
    await restoreChoice?.();
    restoreChoice = undefined;
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('Switch Backend to IDE mode: the server is told the document is closed, nothing about it reaches the server, IDE mode serves it', async () => {
    const a = source('Foo', 'A.idr');
    await showDocument(a);
    await opened(logs, a);
    const root = await api.projects.classify(a.fsPath);
    // Whatever happens below, the package follows the setting again for the tests after this one.
    restoreChoice = () => api.backendChoices.set(root, undefined);
    const from = logs.messages().length;
    // The QuickPick's first item is IDE mode (`features/backend/switchBackend.ts` `switchOptions`).
    // A notification instead of the QuickPick (no active Idris file, nothing to choose) is recorded.
    const told = answerMessages(() => undefined);
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(a));
      const switching = vscode.commands.executeCommand('idris2.switchBackend');
      await waitForAsync(
        () => `Switch Backend to choose IDE mode (active: ${vscode.window.activeTextEditor?.document.fileName}; notifications: ${JSON.stringify(told.asked)})`,
        async () => {
          await acceptQuickPick();
          return api.backendChoices.get(root) === 'ideMode' ? true : undefined;
        },
      );
      await switching;
    } finally {
      told.restore();
    }
    assert.strictEqual(api.registry.routeFor(root).kind, 'ideMode');
    await waitFor('a didClose of Foo/A.idr', () => logs.about(a, from).find((m) => m.message.method === 'textDocument/didClose'));
    const mark = logs.messages().length;
    await statusMatches(api, /^Idris 2 0\.8\.0 · IDE mode · /);
    await hovers(a, new vscode.Position(3, 2));
    await quiet();
    assert.deepStrictEqual(logs.about(a, mark), [], 'the client sent something about a document of a root served by IDE mode');
    // Following the setting again (lsp) sends it again.
    await api.backendChoices.set(root, undefined);
    await opened(logs, a, mark);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a loose file with backend.mode = lsp: the "no .ipkg" notification, once, offering IDE mode; nothing about it reaches the server', async () => {
    const hello = fixture('loose-file', 'Hello.idr');
    const shown = answerMessages(() => undefined);
    try {
      const from = logs.messages().length;
      const before = api.routingNotices.length;
      await showDocument(hello);
      const [notice] = await waitFor(() => `the no-.ipkg notification (notices: ${JSON.stringify(api.routingNotices.slice(before))})`, () => {
        const found = notices('noIpkg', before);
        return found.length > 0 ? found : undefined;
      });
      assert.match(notice.message, /idris2-lsp cannot load/);
      assert.deepStrictEqual(notice.actions, ['Use IDE Mode for This Folder']);
      const root = await api.projects.classify(hello.fsPath);
      assert.strictEqual(api.registry.routeFor(root).kind, 'none');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await showDocument(hello);
      await quiet();
      assert.strictEqual(notices('noIpkg', before).length, 1, JSON.stringify(api.routingNotices.slice(before)));
      assert.deepStrictEqual(logs.about(hello, from), []);
    } finally {
      shown.restore();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('a response error with code 3 "Cannot find the ipkg file" (F35) gives the "no .ipkg" notification, once, and no other notification', async () => {
    await useLogs(api, logs, { FAKE_IDRIS2_LSP_FAULT: 'missing-ipkg' });
    const shown = answerMessages(() => undefined);
    try {
      const clean = source('Clean.idr');
      const from = logs.messages().length;
      const before = api.routingNotices.length;
      await showDocument(clean);
      await opened(logs, clean, from);
      // A request about the document, which the faulty server answers with the error.
      await hovers(clean, new vscode.Position(7, 5));
      await waitFor('a request answered with the fault', () => logs.about(clean, from).find((m) => m.replay === 'fault' && m.message.id !== undefined));
      await waitFor(() => `the no-.ipkg notification (notices: ${JSON.stringify(api.routingNotices.slice(before))})`, () =>
        notices('missingIpkg', before).length > 0 ? true : undefined,
      );
      await hovers(clean, new vscode.Position(7, 5));
      await quiet();
      assert.strictEqual(notices('missingIpkg', before).length, 1, JSON.stringify(api.routingNotices.slice(before)));
      assert.strictEqual(shown.asked.filter((m) => !RESTART_PROMPT.test(m)).length, 1, JSON.stringify(shown.asked));
    } finally {
      shown.restore();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await useLogs(api, logs);
    }
  });

  test('a package outside the workspace folder: nothing about its document reaches the server while its folder is not allowed', async () => {
    const pkg = fixture('simple-ipkg');
    const foreign = fixture('simple-ipkg', 'src', 'Foo', 'B.idr');
    const dir = fs.realpathSync.native(pkg.fsPath);
    const from = logs.messages().length;
    await showDocument(foreign);
    await waitFor(() => `the consent question for ${dir} (open: ${JSON.stringify(api.consent.openQuestions())})`, () =>
      api.consent.openQuestions().includes(dir) ? true : undefined,
    );
    await hovers(foreign, new vscode.Position(6, 12));
    assert.deepStrictEqual(logs.about(foreign, from), [], 'a document reached the server before its folder was allowed');
    assert.ok(api.consent.respond(dir, 'deny'));
    await statusMatches(api, /not allowed here$/);
    await hovers(foreign, new vscode.Position(6, 12));
    await quiet();
    assert.deepStrictEqual(logs.about(foreign, from), [], 'a document reached the server although its folder was not allowed');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
