/**
 * Shared helpers of the e2e suite (test/README.md): the extension's test API, polling, running
 * the real tools, and (M2) quieting the extension's IDE-mode sessions before a test starts a
 * compiler of its own.
 * The suite runs in the Extension Host on test/fixtures/workspaces/simple-ipkg with the real
 * toolchain (.vscode-test.mjs, label `e2e`).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
// Type-only: the tests talk to the running extension, not to a second copy of its modules.
import type { TestApi } from '../../src/extension';
import { ideProcesses } from './ideDriver';

const EXTENSION_ID = 'etairi.vscode-idris2';

/** Activates the extension (a no-op if the workspace's ipkg already did) and returns its test API. */
export async function extensionApi(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test instance`);
  const api = await extension.activate();
  assert.ok(api, 'activate() returned no test API (is the extension running in ExtensionMode.Test?)');
  return api;
}

/** The workspace folder: test/fixtures/workspaces/simple-ipkg. */
export function workspaceDir(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the e2e workspace folder (test/fixtures/workspaces/simple-ipkg) is missing');
  return folder.uri.fsPath;
}

/**
 * Polls `probe` every 100 ms until it returns something other than `undefined`, and fails with
 * `what` after `deadlineMs`. Used for asynchronous extension state (scans, documents, files).
 */
export async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, deadlineMs = 30000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > deadlineMs) {
      assert.fail(`timed out after ${deadlineMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The first `name` on `PATH` that is an executable file, as a shell would find it (macOS/Linux). */
export function firstOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // not there, or not executable
    }
  }
  return undefined;
}

/**
 * Waits until the extension has nothing left to run: no toolchain scan is running, and the
 * model of simple-ipkg has been read with `--dump-ipkg-json` for the current toolchain snapshot
 * (the project index re-reads it after every snapshot, through the extension's one-at-a-time
 * process runner). Called before a test runs the real compiler itself (`runReal`), so that two
 * `idris2` processes never run at once (CLAUDE.md).
 */
export async function extensionIdle(api: TestApi): Promise<void> {
  const file = path.join(workspaceDir(), 'src', 'Foo', 'B.idr');
  await waitFor('the extension to finish its scan and its --dump-ipkg-json run', async () => {
    const generation = api.toolchain.current?.generation;
    if (api.toolchain.scanning || generation === undefined) {
      return undefined;
    }
    const root = await api.projects.classify(file);
    const settled = !api.toolchain.scanning && api.toolchain.current?.generation === generation;
    return settled && root.kind === 'project' && root.model.source === 'dump-json' ? true : undefined;
  });
}

/**
 * Runs the real `executable` once, directly (no shell), with a 60 s limit, and returns its
 * standard output after checking that it exited 0 with nothing on standard error. The tests run
 * these one at a time, after `extensionIdle` (CLAUDE.md: one compiler process at a time).
 */
export function runReal(executable: string, args: readonly string[], cwd?: string): string {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, `${executable} ${args.join(' ')}: exit ${result.status}, stderr ${result.stderr}`);
  assert.strictEqual(result.stderr, '', `${executable} ${args.join(' ')} wrote to stderr`);
  return result.stdout;
}

/** The probed `idris2` of the current toolchain snapshot (absolute path). */
export function probedIdris2(api: TestApi): string {
  const idris2 = api.toolchain.current?.idris2;
  assert.ok(idris2?.status === 'probed', `idris2 was not probed: ${JSON.stringify(idris2)}`);
  return idris2.location.path;
}

/** The version text of the probed `idris2` (`0.8.0`, or with a tag), for choosing transcripts. */
export function probedVersion(api: TestApi): string {
  const idris2 = api.toolchain.current?.idris2;
  assert.ok(idris2?.status === 'probed' && idris2.info.version, `idris2 has no parsed version: ${JSON.stringify(idris2)}`);
  return idris2.info.version.text;
}

/**
 * Stops every IDE-mode session of the extension and waits until none of its compiler processes
 * is left, then until it is idle (`extensionIdle`). Called before a test starts a compiler of its
 * own, so that at most one runs at a time (CLAUDE.md). A session starts again on its next request.
 */
export async function quiesce(api: TestApi): Promise<void> {
  api.sessions.stop();
  await waitFor('the extension\'s IDE-mode processes to end', () => (ideProcesses().length === 0 ? true : undefined), 30000);
  await extensionIdle(api);
}
