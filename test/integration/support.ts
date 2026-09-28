/**
 * Shared helpers of the integration suites (`integration`, `simple-ipkg`, `toolchain-path`,
 * `diagnostics`, `loose-stdio`, `consent` in .vscode-test.mjs): the running extension's test API,
 * polling, settings that tests change and restore, and (M2) sessions, diagnostics and the status
 * text. Not a test file itself (the suites load `*.test.js` only).
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
// Type-only: the tests talk to the running extension (dist/extension.js), not to a second copy
// of its modules.
import type { IdeSession } from '../../src/backend/ide/types';
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
 * ARCHITECTURE §12). A function `what` is called at the failure, so that the message describes
 * the state at the deadline, not at the start.
 */
export async function waitFor<T>(what: string | (() => string), probe: () => T | undefined, deadlineMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > deadlineMs) {
      assert.fail(`timed out after ${deadlineMs} ms waiting for ${typeof what === 'string' ? what : what()}`);
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

// -------------------------------------------------------------------------------------------
// M2: IDE-mode sessions and diagnostics
// -------------------------------------------------------------------------------------------

/** The `check` session whose working directory is `dir`, if the pool has one. */
export function checkSession(api: TestApi, dir: string): IdeSession | undefined {
  return api.sessions.sessions().find((s) => s.role === 'check' && s.cwd === dir);
}

/** The diagnostics the extension shows for `uri` (its collection's, source `idris2`). */
export function idrisDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'idris2');
}

/** Waits until the diagnostics of `uri` satisfy `accept`, and returns them. */
export function diagnosticsWhen(
  uri: vscode.Uri,
  what: string,
  accept: (diagnostics: vscode.Diagnostic[]) => boolean,
): Promise<vscode.Diagnostic[]> {
  return waitFor(`the diagnostics of ${uri.fsPath}: ${what}`, () => {
    const diagnostics = idrisDiagnostics(uri);
    return accept(diagnostics) ? diagnostics : undefined;
  });
}

/** Opens a workspace file in an editor (which, with the onSave trigger, checks it). */
export async function showFile(...segments: string[]): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(workspaceFile(...segments));
  await vscode.window.showTextDocument(doc);
  return doc;
}

/**
 * Waits until the status item reads `text`; the failure message gives what it read at the deadline,
 * with `context()` (more state the test wants reported) appended.
 */
export function statusText(api: TestApi, text: string, context?: () => string): Promise<true> {
  return waitFor(
    () =>
      `the status item to read ${JSON.stringify(text)} (it reads ${JSON.stringify(api.statusItem.text)}` +
      `${context === undefined ? '' : `; ${context()}`})`,
    () => (api.statusItem.text === text ? true : undefined),
  );
}

/**
 * Saves `doc` with its content unchanged, so that the fake compiler's recordings (keyed by the
 * fixtures' SHA-256) still apply: two edits that cancel out make it dirty (VS Code compares
 * version ids, not text), then it is saved.
 */
export async function saveUnchanged(doc: vscode.TextDocument): Promise<void> {
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  const insert = new vscode.WorkspaceEdit();
  insert.insert(doc.uri, end, ' ');
  assert.ok(await vscode.workspace.applyEdit(insert));
  const remove = new vscode.WorkspaceEdit();
  remove.delete(doc.uri, new vscode.Range(end, end.translate(0, 1)));
  assert.ok(await vscode.workspace.applyEdit(remove));
  assert.ok(doc.isDirty, 'the document should be dirty before the save');
  assert.ok(await doc.save(), 'the document was not saved');
}

/**
 * Sets `idris2.<section>.<key>` in the user settings (`undefined` removes the user value) and
 * waits until the configuration reads it back.
 */
export async function setUserSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(`idris2.${section}`).update(key, value, vscode.ConfigurationTarget.Global);
  await waitFor(`idris2.${section}.${key} to read ${JSON.stringify(value)}`, () => {
    const inspected = vscode.workspace.getConfiguration(`idris2.${section}`).inspect(key);
    return JSON.stringify(inspected?.globalValue) === JSON.stringify(value) ? true : undefined;
  });
}

/**
 * The command lines of the fake compiler's IDE-mode processes now running whose command line
 * names `dir` (their `--build-dir` lies below the session directory), from `ps` (POSIX; `-ww`: no
 * truncation), or `undefined` on Windows, where `ps` is not available.
 */
export function fakeIdeProcesses(dir: string): string[] | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  const out = execFileSync('/bin/ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes('fake-idris2.mjs') && line.includes('--ide-mode') && line.includes(dir));
}
