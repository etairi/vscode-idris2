/**
 * Shared helpers of the integration suites (`integration`, `simple-ipkg`, `toolchain-path` in
 * .vscode-test.mjs): the running extension's test API, polling, and toolchain settings that
 * tests change and restore. Not a test file itself (the suites load `*.test.js` only).
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
// Type-only: the tests talk to the running extension (dist/extension.js), not to a second copy
// of its modules.
import type { TestApi } from '../../src/extension';
import type { ToolchainSnapshot } from '../../src/toolchain/types';

export const EXTENSION_ID = 'etairi.vscode-idris2';

/** Activates the extension (a no-op when a document already did) and returns its test API. */
export async function extensionApi(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test instance`);
  const api = await extension.activate();
  assert.ok(api, 'activate() returned no test API (is the extension running in ExtensionMode.Test?)');
  return api;
}

/**
 * Polls `probe` every 50 ms until it returns something other than `undefined`, and fails with
 * `what` after `deadlineMs` (10 s by default; no test relies on a deadline below 1 s,
 * ARCHITECTURE §12).
 */
export async function waitFor<T>(what: string, probe: () => T | undefined, deadlineMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > deadlineMs) {
      assert.fail(`timed out after ${deadlineMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The last snapshot, once no scan is running and `accept` holds for it. */
export function settledScan(
  api: TestApi,
  what: string,
  accept: (snapshot: ToolchainSnapshot) => boolean = () => true,
): Promise<ToolchainSnapshot> {
  return waitFor(what, () => {
    const current = api.toolchain.current;
    return !api.toolchain.scanning && current !== undefined && accept(current) ? current : undefined;
  });
}

type ToolchainKey = 'idris2Path' | 'lspPath' | 'packPath' | 'env';

/**
 * Sets `idris2.toolchain.<key>` in the user settings (`undefined` removes the user value) and
 * waits for the rescan the change triggers: a settled snapshot whose settings show the value.
 */
export async function setToolchainSetting(
  api: TestApi,
  key: ToolchainKey,
  value: string | Record<string, string> | undefined,
): Promise<ToolchainSnapshot> {
  const config = vscode.workspace.getConfiguration('idris2.toolchain');
  await config.update(key, value, vscode.ConfigurationTarget.Global);
  const expected = JSON.stringify(vscode.workspace.getConfiguration('idris2.toolchain').get(key));
  return settledScan(api, `a scan with idris2.toolchain.${key} = ${expected}`, (s) => JSON.stringify(s.settings[key]) === expected);
}

/** The fixture file `name` of the first workspace folder. */
export function workspaceFile(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder is missing');
  return vscode.Uri.joinPath(folder.uri, ...segments);
}
