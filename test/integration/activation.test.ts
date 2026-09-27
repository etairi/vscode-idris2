import * as assert from 'assert';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';

const EXTENSION_ID = 'etairi.vscode-idris2';

/**
 * Bound on the time from `openTextDocument(Hello.idr)` until the extension reports active (this
 * interval contains activation plus the document round trip to the renderer). ROADMAP M0
 * targets < 100 ms; six runs on the development machine (macOS arm64, VS Code 1.139.1,
 * 2026-09-26) measured 19–37 ms, median about 25 ms. There the bound is 250 ms, about 7× the
 * slowest of those runs, which still fails an activate() that awaits toolchain probes: one
 * `idris2 --version` spawn alone takes 180–220 ms on that machine, so two exceed it.
 *
 * CI runners are slower and noisier. The first two M0 CI runs (36327101720 and 36327327811,
 * 2026-09-27) measured this interval at 51.7 and 44.9 ms on ubuntu-latest, 138.1 and 327.0 ms
 * on macos-latest (a virtualised Apple M1) and 120.3 ms on windows-latest (second run only;
 * the first stopped before the integration tests). 327 ms would fail the 250 ms bound, so the
 * CI bound is 1,000 ms, about 3× the slowest observed run; that the second run passed also
 * shows the Extension Host sees GitHub's `CI` variable. The measured number is printed on
 * every run, so the < 100 ms target is read from the log (and from Show Running Extensions,
 * ROADMAP M0 "As built"), not asserted.
 */
const ACTIVATION_BOUND_MS = process.env.CI ? 1_000 : 250;

function fixture(name: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder (test/fixtures/workspaces/loose-file) is missing');
  return path.join(folder.uri.fsPath, name);
}

async function until(condition: () => boolean, deadlineMs: number): Promise<boolean> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > deadlineMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

interface ActivationMeasurement {
  readonly activeBeforeOpen: boolean;
  readonly activated: boolean;
  readonly openToActiveMs: number;
}

let measurement: ActivationMeasurement | undefined;

// Root-level hooks: mocha runs them before (after) every suite of the run, whatever order the
// test files were loaded in, so the extension is measured before any test touches it.
suiteSetup(async () => {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} not found`);
  const activeBeforeOpen = ext.isActive;
  const start = performance.now();
  await vscode.workspace.openTextDocument(fixture('Hello.idr'));
  const activated = await until(() => ext.isActive, 10_000);
  measurement = { activeBeforeOpen, activated, openToActiveMs: performance.now() - start };
  console.log(`      [activation] openTextDocument(Hello.idr) → extension active: ${measurement.openToActiveMs.toFixed(1)} ms`);
});

// Leave no editor open, so the next run does not start with a restored Idris editor (which
// would activate the extension before the measurement above).
suiteTeardown(async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

suite('activation', () => {
  test('the extension is inactive until an Idris document is opened, then activates (onLanguage:idris2)', () => {
    assert.ok(measurement);
    assert.strictEqual(
      measurement.activeBeforeOpen,
      false,
      'already active before the tests opened an Idris document (an editor restored from .vscode-test/user-data?)',
    );
    assert.strictEqual(measurement.activated, true, 'not active 10 s after Hello.idr was opened');
  });

  test(`opening Hello.idr until the extension is active takes < ${ACTIVATION_BOUND_MS} ms`, () => {
    assert.ok(measurement);
    assert.ok(
      measurement.openToActiveMs < ACTIVATION_BOUND_MS,
      `took ${measurement.openToActiveMs.toFixed(1)} ms`,
    );
  });

  test('the extension id is etairi.vscode-idris2 and activate() resolves', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});

suite('Help commands', () => {
  test('Show Output, Open Settings and Open Idris 2 Documentation are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['idris2.showOutput', 'idris2.openSettings', 'idris2.openDocumentation']) {
      assert.ok(commands.includes(id), `${id} missing from getCommands()`);
    }
  });

  test('idris2.showOutput runs', async () => {
    await vscode.commands.executeCommand('idris2.showOutput');
  });

  test('idris2.openSettings opens the Settings editor', async () => {
    await vscode.commands.executeCommand('idris2.openSettings');
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'Settings');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  // idris2.openDocumentation is not executed: it would open the system browser.
});
