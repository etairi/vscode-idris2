/**
 * The terminal recorder of the install-command tests (`toolchainUi.test.ts` here, and
 * `test/e2e/install.test.ts`): it makes `terminalRecorder.mjs` the default terminal profile, so
 * that a command that opens a terminal types into a Node script that records the bytes instead
 * of into a shell. Nothing typed can run, even after a regression, and the recorded text shows
 * whether a line break followed it. Not a test file itself (the suites load `*.test.js` only).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { repoRoot } from '../fake-tools/paths';
import { waitFor } from './support';

const PROFILE = 'vscode-idris2 terminal recorder';
const RECORDER = path.join(repoRoot(), 'test', 'integration', 'terminalRecorder.mjs');

/** How long nothing more may arrive after the text: a line break would follow it immediately. */
const QUIET_MS = 1500;

/** The platform key of `terminal.integrated.profiles.*` and `defaultProfile.*`. */
function platformKey(): 'osx' | 'linux' | 'windows' {
  return process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
}

/**
 * The first Node executable on `PATH` (`node.exe` on Windows, whose entries may be quoted;
 * `process.env` looks names up case-insensitively there).
 */
function nodeOnPath(): string | undefined {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const dir = process.platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (dir === '' || !path.isAbsolute(dir)) {
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

/** A Node for the recorder: the one on `PATH`, else the Extension Host's Electron run as Node. */
function recorderProfile(file: string): Record<string, unknown> {
  const node = nodeOnPath();
  return node !== undefined
    ? { path: node, args: [RECORDER, file] }
    : { path: process.execPath, args: [RECORDER, file], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * Makes the recorder, writing to `file`, the default terminal profile. Set once per suite, not
 * per test: when each test gave the recorder its own file, the second of the three commands
 * timed out waiting for its file while the first and third passed [live, VS Code 1.139.1,
 * 2026-09-27]. The likely cause, not traced in VS Code's source, is that a terminal opened right
 * after `profiles.<os>` changes still gets the previously resolved profile, whose recorder
 * writes to the previous test's file.
 */
export async function useTerminalRecorder(file: string): Promise<void> {
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
  await terminalConfig.update(`profiles.${platformKey()}`, { [PROFILE]: recorderProfile(file) }, vscode.ConfigurationTarget.Global);
  await terminalConfig.update(`defaultProfile.${platformKey()}`, PROFILE, vscode.ConfigurationTarget.Global);
}

/** Removes the user settings `useTerminalRecorder` wrote. */
export async function resetTerminalProfile(): Promise<void> {
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
  await terminalConfig.update(`profiles.${platformKey()}`, undefined, vscode.ConfigurationTarget.Global);
  await terminalConfig.update(`defaultProfile.${platformKey()}`, undefined, vscode.ConfigurationTarget.Global);
}

export async function closeTerminals(): Promise<void> {
  for (const terminal of vscode.window.terminals) {
    terminal.dispose();
  }
  await waitFor('all terminals to close', () => (vscode.window.terminals.length === 0 ? true : undefined), 10000);
}

/**
 * Runs `command` and returns what it typed into the terminal it opened, as the recorder saved it
 * in `file` (deleted first; the recorder creates it when it starts), once nothing more has
 * arrived for `QUIET_MS`.
 */
export async function typedBy(command: string, file: string): Promise<{ text: string; terminal: vscode.Terminal }> {
  await closeTerminals();
  fs.rmSync(file, { force: true });

  const opened: vscode.Terminal[] = [];
  const subscription = vscode.window.onDidOpenTerminal((t) => opened.push(t));
  let terminal: vscode.Terminal;
  try {
    await vscode.commands.executeCommand(command);
    terminal = await waitFor(`${command} to open a terminal`, () => opened[0], 30000);
  } finally {
    subscription.dispose();
  }
  const options = terminal.creationOptions as vscode.TerminalOptions;
  assert.strictEqual(options.shellPath, undefined, `${command} chose its own shell, so the recorder did not run`);
  await waitFor(
    `${command}'s text in the recorder`,
    () => (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== '' ? true : undefined),
    30000,
  );
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  return { text: fs.readFileSync(file, 'utf8'), terminal };
}

/**
 * How the install command writes `file` as one word of a command line (`commandWord` in
 * src/toolchain/install.ts, whose quoting the unit tests check; restated here so that the test
 * does not compute its expectation with the code under test): bare when no shell treats any of
 * its characters specially, else single-quoted for a POSIX shell, or PowerShell's `& '…'` with
 * each quote character doubled on Windows.
 */
export function commandWordFor(file: string): string {
  if (process.platform === 'win32') {
    return /^[A-Za-z0-9_.:\\/-]+$/.test(file) ? file : `& '${file.replace(/['‘-‛]/g, (quote) => quote + quote)}'`;
  }
  return /^[A-Za-z0-9_.,:@%+=/-]+$/.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`;
}
