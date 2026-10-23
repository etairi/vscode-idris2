/**
 * Helpers of the `lsp` suite (.vscode-test.mjs, ROADMAP M5): the workspace folder is
 * test/fixtures/workspaces/lsp-ipkg, an `.ipkg` root opened as its own folder (so it needs no
 * consent), `idris2.backend.mode` is `lsp` in the profile, and `idris2.toolchain.lspPath` names the
 * fake language server (test/fake-lsp), which replays the real server's recordings of
 * test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a (keyed by the fixtures' SHA-256, so every test leaves
 * each file as it is on disk). Its two logs, switched on through `idris2.toolchain.env` (which the
 * extension passes to the server it starts), show what reached the server. Not a test file itself.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { setToolchainSetting, waitFor, workspaceFile } from '../support';

/** A JSON-RPC message as the fake read it. */
export interface LspMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: Record<string, unknown> & {
    readonly textDocument?: { readonly uri?: string };
    readonly settings?: Record<string, unknown>;
    readonly initializationOptions?: Record<string, unknown>;
    readonly command?: string;
    readonly arguments?: readonly unknown[];
  };
}

/** A line of FAKE_IDRIS2_LSP_MESSAGE_LOG (test/fake-lsp/README.md). */
export interface LoggedMessage {
  readonly pid: number;
  readonly message: LspMessage;
  /** What answered it: `<scenario>:<line>`, `initialize`, `shutdown`, `unrecorded`, `fault`, or `null`. */
  readonly replay: string | null;
}

/** A line of FAKE_IDRIS2_LSP_LOG: a start of the fake server. */
export interface ServerStart {
  readonly pid: number;
  readonly args: readonly string[];
  readonly cwd: string;
}

function readJsonLines<T>(file: string): T[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as T)
    : [];
}

/** The URI a message is about: its `textDocument`, or the code action request of `exprSearchWithHints`/`refineHole`. */
export function aboutUri(message: LspMessage): string | undefined {
  const codeAction = (message.params?.arguments?.[0] as { codeAction?: { textDocument?: { uri?: string } } } | undefined)?.codeAction;
  return message.params?.textDocument?.uri ?? codeAction?.textDocument?.uri;
}

/**
 * The fake server's logs in a temporary directory: FAKE_IDRIS2_LSP_LOG (its starts) and
 * FAKE_IDRIS2_LSP_MESSAGE_LOG (every message it read). `use` puts them into `idris2.toolchain.env`
 * and restarts the server, so that the next process writes them.
 */
export class FakeLspLogs {
  readonly dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-lsplog-')));
  private readonly startFile = path.join(this.dir, 'starts.jsonl');
  private readonly messageFile = path.join(this.dir, 'messages.jsonl');

  /** The variables, with `extra` (a fault) added. */
  env(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return { FAKE_IDRIS2_LSP_LOG: this.startFile, FAKE_IDRIS2_LSP_MESSAGE_LOG: this.messageFile, ...extra };
  }

  starts(): ServerStart[] {
    return readJsonLines<ServerStart>(this.startFile);
  }

  /** Every message the fake read, from the `from`-th on. */
  messages(from = 0): LoggedMessage[] {
    return readJsonLines<LoggedMessage>(this.messageFile).slice(from);
  }

  /** The messages from the `from`-th on with method `method`. */
  withMethod(method: string, from = 0): LoggedMessage[] {
    return this.messages(from).filter((m) => m.message.method === method);
  }

  /** The messages from the `from`-th on about the document `uri`. */
  about(uri: vscode.Uri, from = 0): LoggedMessage[] {
    return this.messages(from).filter((m) => aboutUri(m.message) === uri.toString());
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * The pids of the fake servers now running below this process (the Extension Host, which starts
 * them), from `ps` (macOS and Linux: the suite does not run on Windows, CLAUDE.md).
 */
export function fakeServers(): number[] {
  const table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .flatMap((m) => (m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }]));
  const parent = new Map(table.map((p) => [p.pid, p.ppid]));
  const below = (pid: number): boolean => {
    for (let p = parent.get(pid); p !== undefined && p > 1; p = parent.get(p)) {
      if (p === process.pid) {
        return true;
      }
    }
    return false;
  };
  // The launcher (test/fake-lsp/bin/idris2-lsp) runs `node <its directory>/../server.mjs`.
  return table.filter((p) => /test[/\\]fake-lsp[/\\](?:bin[/\\]\.\.[/\\])?server\.mjs/.test(p.command) && below(p.pid)).map((p) => p.pid);
}

/**
 * Switches the logs on: `idris2.toolchain.env` (plus `extra`), then **Idris 2: Restart Language
 * Server**, and waits until a server started with them has answered `initialize` — unless
 * `restart` is false, when the next start writes them.
 */
export async function useLogs(api: TestApi, logs: FakeLspLogs, extra: Readonly<Record<string, string>> = {}, restart = true): Promise<void> {
  await setToolchainSetting(api, 'env', logs.env(extra));
  if (!restart) {
    return;
  }
  const before = logs.starts().length;
  await vscode.commands.executeCommand('idris2.restartLanguageServer');
  await waitFor(
    () => `a server started with the logs to answer initialize (starts: ${JSON.stringify(logs.starts().slice(before))})`,
    () => {
      const started = logs.starts().slice(before);
      const pid = started[started.length - 1]?.pid;
      return pid !== undefined && logs.messages().some((m) => m.pid === pid && m.message.method === 'initialized') ? true : undefined;
    },
  );
}

/** Stops the server (**Idris 2: Stop Language Server**) and waits until no fake server runs. */
export async function stopServer(): Promise<void> {
  await vscode.commands.executeCommand('idris2.stopLanguageServer');
  await waitFor(() => `no fake server to run (pids ${JSON.stringify(fakeServers())})`, () => (fakeServers().length === 0 ? true : undefined));
}

/** The source file `src/<segments>` of the workspace's package. */
export const source = (...segments: string[]): vscode.Uri => workspaceFile('src', ...segments);

/** Opens `uri` in the active editor with the cursor at `at` (0:0 by default). */
export async function showDocument(uri: vscode.Uri, at = new vscode.Position(0, 0)): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  editor.selection = new vscode.Selection(at, at);
  return editor;
}

/** Waits until the fake read a `didOpen` of `uri` (from the `from`-th message on), and returns it. */
export function opened(logs: FakeLspLogs, uri: vscode.Uri, from = 0): Promise<LoggedMessage> {
  return waitFor(
    () => `a didOpen of ${uri.fsPath} to reach the server (it read: ${JSON.stringify(logs.messages(from).map((m) => m.message.method))})`,
    () => logs.about(uri, from).find((m) => m.message.method === 'textDocument/didOpen'),
  );
}

/** Waits until the status item's text matches `pattern`, and returns it. */
export function statusMatches(api: TestApi, pattern: RegExp): Promise<string> {
  return waitFor(
    () => `the status item to match ${pattern} (it reads ${JSON.stringify(api.statusItem.text)})`,
    () => (pattern.test(api.statusItem.text) ? api.statusItem.text : undefined),
  );
}

/** What the client sends as the server's options (`backend/lsp/types.ts` `LspServerOptions`), from the settings as they read now: `logFile` only when set. */
export function serverOptionsFromSettings(): Record<string, unknown> {
  const lsp = vscode.workspace.getConfiguration('idris2.lsp');
  const options: Record<string, unknown> = {
    logSeverity: lsp.get('logSeverity'),
    longActionTimeout: lsp.get('longActionTimeout'),
    maxCodeActionResults: lsp.get('maxCodeActionResults'),
    showImplicits: lsp.get('showImplicits'),
    showMachineNames: lsp.get('showMachineNames'),
    fullNamespace: lsp.get('fullNamespace'),
    briefCompletions: lsp.get('briefCompletions'),
  };
  const logFile = lsp.get<string>('logFile') ?? '';
  return logFile === '' ? options : { logFile, ...options };
}

/** The workspace folder as its real path (the server's working directory, test/fake-lsp/README.md). */
export function workspaceRealPath(): string {
  return fs.realpathSync.native(workspaceFile().fsPath);
}
