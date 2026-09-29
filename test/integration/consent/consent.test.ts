// Suite `consent` (.vscode-test.mjs): the workspace folder is test/fixtures/workspaces/
// simple-ipkg/src, inside the package, so the session directory of Foo/B.idr (the .ipkg's
// directory) lies outside every workspace folder and the compiler may start there only with the
// user's consent (ROADMAP §9, decided 2026-09-27). The question is a notification the test
// cannot click; it answers through the test API (`ConsentGate.respond`), which resolves the
// question exactly as the notification's buttons do. Extension state is in memory in extension
// tests, so the folder allowed for good here is gone in the next run; the last test revokes it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import {
  checkSession,
  diagnosticsWhen,
  extensionApi,
  idrisDiagnostics,
  saveUnchanged,
  settledScan,
  showFile,
  statusText,
  waitFor,
  workspaceFile,
} from '../support';

/** Resolves once a check of `doc` has started and ended, as the checks' change events show it. */
function checkEnded(api: TestApi, doc: vscode.TextDocument): Promise<void> {
  return new Promise((resolve) => {
    let started = false;
    const subscription = api.checks.onDidChange(() => {
      if (api.checks.loadStateOf(doc) === 'loading') {
        started = true;
      } else if (started) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

suite('M2 consent for a session outside the workspace folders', () => {
  let api: TestApi;
  let packageDir: string;
  let doc: vscode.TextDocument;

  suiteSetup(async () => {
    doc = await showFile('Foo', 'B.idr');
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    packageDir = path.dirname(workspaceFile().fsPath);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  /** The directory of the open question, once one is open (its real path, as the question names it). */
  const openQuestion = () => waitFor('a question to be open', () => api.consent.openQuestions()[0]);

  test('opening Foo/B.idr asks once whether the compiler may start in the package directory; no process meanwhile', async () => {
    const dir = await openQuestion();
    assert.strictEqual(dir, fs.realpathSync.native(packageDir), 'the question names the real path');
    assert.deepStrictEqual(api.consent.openQuestions(), [dir], 'one question for the directory');
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · checking…');
    assert.match(api.statusItem.detail ?? '', /waiting for your permission to start the compiler in /);
    const session = checkSession(api, packageDir);
    assert.ok(session);
    assert.strictEqual(session.state, 'stopped');
    assert.strictEqual(session.launch, undefined);
  });

  test("Don't Allow: highlighting only — no process, no diagnostics — and the status says why, with Allow…", async () => {
    const dir = await openQuestion();
    assert.ok(api.consent.respond(dir, 'deny'));
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · not allowed here');
    assert.deepStrictEqual(api.statusItem.command, { command: 'idris2.allowFolder', title: 'Allow…', tooltip: api.statusItem.detail, arguments: [packageDir] });
    assert.strictEqual(api.statusItem.severity, vscode.LanguageStatusSeverity.Warning);
    assert.strictEqual(checkSession(api, packageDir)?.launch, undefined);
    assert.deepStrictEqual(idrisDiagnostics(doc.uri), []);
    assert.deepStrictEqual(api.consent.openQuestions(), [], 'not asked again by itself');
    // A save does not ask again either.
    const ended = checkEnded(api, doc);
    await saveUnchanged(doc);
    await ended;
    assert.deepStrictEqual(api.consent.openQuestions(), []);
    assert.strictEqual(checkSession(api, packageDir)?.launch, undefined);
    // Nor does Check File, which says why nothing ran (a notification, closed again here).
    await vscode.commands.executeCommand('idris2.checkFile');
    assert.deepStrictEqual(api.consent.openQuestions(), []);
    assert.strictEqual(checkSession(api, packageDir)?.launch, undefined);
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  test('Allow… asks again; Always Allow for This Folder starts the compiler, checks the file and remembers the folder', async () => {
    const command = api.statusItem.command;
    assert.ok(command);
    void vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const dir = await openQuestion();
    // While the question waits (no check is loading), the status waits too and Allow… shows it again.
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · checking…');
    assert.strictEqual(api.statusItem.command?.command, 'idris2.allowFolder');
    assert.match(api.statusItem.detail ?? '', /waiting for your permission to start the compiler in /);
    assert.ok(api.consent.respond(dir, 'always'));
    await waitFor('the session to run', () => (checkSession(api, packageDir)?.state === 'ready' ? true : undefined));
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · ✓');
    assert.deepStrictEqual(api.consent.allowedFolders(), [dir]);
    assert.deepStrictEqual(idrisDiagnostics(doc.uri), []);
    // The package's .ipkg is determined by every load: clean.
    await diagnosticsWhen(vscode.Uri.file(path.join(packageDir, 'simple.ipkg')), 'none', (l) => l.length === 0);
  });

  test('Manage Allowed Folders revokes it: the session stops, and the next check asks again', async () => {
    const [dir] = api.consent.allowedFolders();
    await vscode.commands.executeCommand('idris2.manageAllowedFolders', [dir]);
    assert.deepStrictEqual(api.consent.allowedFolders(), []);
    await waitFor('the session to stop', () => (checkSession(api, packageDir)?.state === 'stopped' ? true : undefined));
    await statusText(api, 'Idris 2 0.8.0 · IDE mode · stopped');
    assert.match(api.statusItem.detail ?? '', /the permission for .* was revoked; the next check asks again/);
    void vscode.commands.executeCommand('idris2.checkFile');
    const again = await openQuestion();
    assert.strictEqual(again, dir);
    assert.ok(api.consent.respond(again, 'deny'));
    // This step failed once (2026-09-27, the integration run after the second review: the status
    // read `stopped`) and passed in the 10 runs after it. A stale read of the global state after
    // the revocation fits that run's log and can no longer decide a verdict (gate.ts), but the
    // cause is not established (docs/as-built/M2.md, *Status*). Until the status reads
    // `not allowed here`, no process may have started and the gate must say `denied` at every
    // poll, not only the status.
    await waitFor('the gate to record the answer', () => (api.consent.current(packageDir) !== undefined ? true : undefined));
    await waitFor(
      () =>
        `the status item to read "Idris 2 0.8.0 · IDE mode · not allowed here" (it reads ${JSON.stringify(api.statusItem.text)}; ` +
        `gate verdict ${JSON.stringify(api.consent.current(packageDir))}, backend state ` +
        `${JSON.stringify(api.registry.stateFor(checkSession(api, packageDir)?.root))}, ` +
        `allowed folders ${JSON.stringify(api.consent.allowedFolders())}, load state ${api.checks.loadStateOf(doc)})`,
      () => {
        assert.strictEqual(checkSession(api, packageDir)?.launch, undefined, 'no process after Don\'t Allow');
        assert.deepStrictEqual(api.consent.current(packageDir), { allowed: false, reason: 'denied' });
        return api.statusItem.text === 'Idris 2 0.8.0 · IDE mode · not allowed here' ? true : undefined;
      },
    );
  });
});
