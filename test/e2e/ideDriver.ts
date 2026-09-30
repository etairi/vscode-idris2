/**
 * IDE-mode sessions of the real compiler for the e2e suite (ROADMAP M2 acceptance: every §0 row
 * as a test). The driver starts `idris2 --ide-mode` or `--ide-mode-socket` itself, writes the
 * requests it is given one at a time, each after the `:return` of the previous one (ARCHITECTURE
 * §5.1), and cuts and decodes the replies with the extension's own codec (`protocol.ts`
 * `ideCodec`), so the codec is checked against the real compiler too. No `vscode` import.
 *
 * Resource rules (CLAUDE.md): one compiler process at a time. Every run waits for its process to
 * end before it returns, and kills the process group after `RUN_LIMIT_MS` or when a reply is
 * overdue; callers make sure the extension runs no session meanwhile (`quiesce` in helpers.ts).
 */
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ideCodec } from '../../src/backend/ide/protocol';
import type { DecodedMessage, IncomingFrame } from '../../src/backend/ide/types';
import { exchanges, readTranscripts, recordedArgs, requestFrame, substitute, transcriptsDir, type Transcript } from '../fake-idris2/client';
import { repoRoot } from '../fake-tools/paths';

/** No single reply may take longer (the longest recorded load takes about 2 s). */
export const REPLY_LIMIT_MS = 60000;
/** No run may take longer; the process group is killed then. */
export const RUN_LIMIT_MS = 120000;

/** What the compiler sent in reply to one request. */
export interface LiveExchange {
  /** The request as written (a frame's text, or raw bytes as Latin-1 for misframed input). */
  readonly request: string;
  /** Protocol-stream items in order: `framed` (a reply frame) or `unframed` (F5). */
  readonly items: readonly IncomingFrame[];
  /** The texts of the reply frames. */
  readonly frames: readonly string[];
  /** Each reply frame decoded by `ideCodec.decodeMessage`. */
  readonly messages: readonly DecodedMessage[];
  /** Process stdout during this exchange (socket transport: program output, F5). */
  readonly stdout: string;
}

export interface LiveRun {
  /** The first frame's text. */
  readonly handshake: string;
  readonly exchanges: readonly LiveExchange[];
  /** Protocol-stream text after the input ended (stdio: the end-of-input line, F5). */
  readonly tailStream: string;
  /** Process stdout after the input ended (socket: the end-of-input line, F5). */
  readonly tailStdout: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** One request: a frame text (framed by its UTF-8 byte length, F1), or raw bytes. */
export type LiveRequest = string | { readonly bytes: Buffer; readonly returns: number };

export interface RunOptions {
  readonly executable: string;
  readonly cwd: string;
  readonly transport: 'stdio' | 'socket';
  /** The arguments after `--ide-mode` / `--ide-mode-socket`. */
  readonly args: readonly string[];
  readonly requests: readonly LiveRequest[];
  /** Merged over this process's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Awaited before request `index` is written (E21 starts a concurrent build there). */
  readonly beforeRequest?: (index: number) => Promise<void>;
}

/** Kills a detached child's process group (the Homebrew `idris2` is a `sh` wrapper, not `exec`). */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** Runs one IDE-mode session of `executable` and returns everything it sent. */
export async function runIdeSession(options: RunOptions): Promise<LiveRun> {
  const mode = options.transport === 'stdio' ? '--ide-mode' : '--ide-mode-socket';
  const child = spawn(options.executable, [mode, ...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true, // its own process group, so that the compiler behind the wrapper is killed too
  });
  const runTimer = setTimeout(() => killGroup(child.pid), RUN_LIMIT_MS);
  // The decoder the extension's transport uses for this transport (`transport.ts`): on the socket
  // only frames travel (`framesOnly`).
  const decoder = ideCodec.createFrameDecoder(options.transport === 'socket' ? { framesOnly: true } : {});
  const stream: IncomingFrame[] = [];
  let stdout = '';
  let stderr = '';
  let streamEnded = false;
  const wakers: (() => void)[] = [];
  const wake = (): void => wakers.splice(0).forEach((w) => w());
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
      wake();
    }),
  );
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  void exited.then((e) => (exit = e));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const onStream = (chunk: Buffer): void => {
    stream.push(...decoder.push(chunk));
    wake();
  };
  const onStreamEnd = (): void => {
    stream.push(...decoder.end());
    streamEnded = true;
    wake();
  };
  /** Waits until `ready()` holds; fails after `limitMs` or when the process has ended first. */
  const until = async (what: string, ready: () => boolean, limitMs = REPLY_LIMIT_MS): Promise<void> => {
    const deadline = Date.now() + limitMs;
    while (!ready()) {
      if (exit !== undefined && streamEnded) {
        throw new Error(`idris2 ended (${JSON.stringify(exit)}) while waiting for ${what}; stderr: ${stderr}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`no ${what} within ${limitMs} ms`);
      }
      await new Promise<void>((resolve) => {
        wakers.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  };

  try {
    let write: (bytes: Buffer) => void;
    let endInput: () => void;
    if (options.transport === 'stdio') {
      child.stdout.on('data', onStream).on('end', onStreamEnd);
      write = (bytes) => child.stdin.write(bytes);
      endInput = () => child.stdin.end();
    } else {
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        wake();
      });
      await until('the port line', () => stdout.includes('\n'), 30000);
      const portLine = stdout.slice(0, stdout.indexOf('\n') + 1);
      stdout = stdout.slice(portLine.length);
      if (!/^[0-9]+\n$/.test(portLine)) {
        throw new Error(`not a port line: ${JSON.stringify(portLine)}`);
      }
      const socket = net.connect(Number(portLine), '127.0.0.1');
      socket.on('data', onStream).on('end', onStreamEnd).on('close', onStreamEnd);
      socket.on('error', () => undefined); // the exit and the stream end tell the story
      write = (bytes) => socket.write(bytes);
      endInput = () => socket.end();
    }
    await until('the handshake', () => stream.length > 0, 30000);
    const first = stream.shift();
    if (first?.kind !== 'framed') {
      throw new Error(`the first item is not a frame: ${JSON.stringify(first)}`);
    }
    const handshake = first.text;

    const results: LiveExchange[] = [];
    for (const [index, request] of options.requests.entries()) {
      await options.beforeRequest?.(index);
      const bytes = typeof request === 'string' ? requestFrame(request) : request.bytes;
      const returns = typeof request === 'string' ? 1 : request.returns;
      const stdoutBefore = stdout.length;
      write(bytes);
      const items: IncomingFrame[] = [];
      let seen = 0;
      const text = typeof request === 'string' ? request : request.bytes.toString('latin1');
      while (seen < returns) {
        await until(`the :return of ${JSON.stringify(text)}`, () => stream.length > 0);
        const item = stream.shift();
        if (item === undefined) {
          continue;
        }
        items.push(item);
        if (item.kind === 'framed') {
          const decoded = ideCodec.decodeMessage(item.text);
          if (decoded.kind === 'message' && decoded.message.kind === 'return') {
            seen += 1;
          }
        }
      }
      const frames = items.flatMap((i) => (i.kind === 'framed' ? [i.text] : []));
      results.push({
        request: text,
        items,
        frames,
        messages: frames.map((f) => ideCodec.decodeMessage(f)),
        stdout: stdout.slice(stdoutBefore),
      });
    }
    const stdoutBeforeEnd = stdout.length;
    endInput();
    await until('the end of the process', () => exit !== undefined && streamEnded, 30000);
    const status = await exited;
    const tail = stream.splice(0);
    return {
      handshake,
      exchanges: results,
      tailStream: tail.map((i) => i.text).join(''),
      tailStdout: stdout.slice(stdoutBeforeEnd),
      exitCode: status.code,
      signal: status.signal,
      stderr,
    };
  } finally {
    clearTimeout(runTimer);
    if (exit === undefined) {
      killGroup(child.pid);
      await exited;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture workspaces and recorded scenarios
// ---------------------------------------------------------------------------------------------

/**
 * Copies `test/fixtures/workspaces/<relative>` (without `build/` or `out/` directories) to a new
 * temporary directory and returns the copy's real path (the recorder did the same, so replies
 * name a path without symbolic links, as `${ROOT}` stands for). The caller deletes `dir`.
 */
export function copyWorkspace(relative: string): { dir: string; root: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-e2e-')));
  const root = path.join(dir, path.basename(relative));
  fs.cpSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', relative), root, {
    recursive: true,
    filter: (source) => !['build', 'out'].includes(path.basename(source)) || fs.statSync(source).isFile(),
  });
  return { dir, root };
}

/** The recorded scenario `name` (its requests are version-independent; the replies are 0.8.0's). */
export function recordedScenario(name: string): Transcript {
  const transcript = readTranscripts(transcriptsDir('0.8.0')).find((t) => t.meta.scenario === name);
  if (transcript === undefined) {
    throw new Error(`no transcript ${name} in ${transcriptsDir('0.8.0')}`);
  }
  return transcript;
}

/** The workspace directory of a transcript, relative to test/fixtures/workspaces. */
export function scenarioWorkspace(transcript: Transcript): string {
  return path.relative(path.join('test', 'fixtures', 'workspaces'), transcript.meta.cwd);
}

/** A recorded scenario's requests with `${ROOT}` (and `${LINK}`) spelled as `values` give. */
export function scenarioRequests(transcript: Transcript, values: Readonly<Record<string, string>>): string[] {
  return exchanges(transcript).exchanges.map((e) => substitute(e.request, values));
}

/** The arguments the recorder (and the extension) passes after the mode flag to a `check` session. */
export function sessionArgs(root: string): string[] {
  return ['--no-color', '--build-dir', path.join(root, 'build', '.vscode-idris2')];
}

/**
 * Runs the requests of the recorded scenario `name` against `executable` over the recorded
 * transport (or `transport`), with the recorded arguments (so in the recorded session role), in
 * `workspace` (a `copyWorkspace` result the caller owns) or in a fresh copy of the scenario's
 * workspace, which is deleted unless `keep` is set (the caller then deletes `dir`).
 */
export async function runScenario(
  executable: string,
  name: string,
  options: {
    transport?: 'stdio' | 'socket';
    keep?: boolean;
    workspace?: { dir: string; root: string };
    env?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ run: LiveRun; root: string; dir: string; transcript: Transcript }> {
  const transcript = recordedScenario(name);
  const { dir, root } = options.workspace ?? copyWorkspace(scenarioWorkspace(transcript));
  try {
    const values: Record<string, string> = { '${ROOT}': root };
    let cwd = root;
    if (transcript.meta.processCwd === '${LINK}') {
      cwd = path.join(dir, 'link');
      if (!fs.existsSync(cwd)) {
        fs.symlinkSync(root, cwd, 'dir');
      }
      values['${LINK}'] = cwd;
    }
    const run = await runIdeSession({
      executable,
      cwd,
      transport: options.transport ?? transcript.meta.transport,
      args: recordedArgs(transcript, values),
      requests: scenarioRequests(transcript, values),
      env: options.env,
    });
    return { run, root, dir, transcript };
  } finally {
    if (options.keep !== true && options.workspace === undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Every file below `dir`, relative to it, sorted (`/`-separated). */
export function filesBelow(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

// ---------------------------------------------------------------------------------------------
// The extension's IDE-mode processes
// ---------------------------------------------------------------------------------------------

export interface IdeProcess {
  /** The outermost process with `--ide-mode` in its command line (the wrapper, if any). */
  readonly pid: number;
  /** The innermost one (the compiler itself behind a wrapper script). */
  readonly compilerPid: number;
  readonly command: string;
}

/**
 * The IDE-mode process trees below `ancestor` (by default this process, the Extension Host the
 * e2e tests run in), from `ps` (macOS and Linux, where the e2e suite runs). A tree is counted once
 * although the Homebrew `idris2` is a `sh` script that runs the compiler as its child.
 */
export function ideProcesses(ancestor = process.pid): IdeProcess[] {
  const table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .flatMap((m) => (m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }]));
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const below = (p: { ppid: number }): boolean => {
    for (let q = byPid.get(p.ppid); q !== undefined; q = byPid.get(q.ppid)) {
      if (q.pid === ancestor) {
        return true;
      }
      if (q.ppid === q.pid) {
        return false;
      }
    }
    return p.ppid === ancestor;
  };
  const isIde = (p: { command: string }): boolean => /\s--ide-mode(-socket)?(\s|$)/.test(p.command);
  const ide = table.filter((p) => isIde(p) && below(p));
  return ide
    .filter((p) => !isIde(byPid.get(p.ppid) ?? { command: '' }))
    .map((top) => {
      let compiler = top;
      for (let child = ide.find((p) => p.ppid === compiler.pid); child !== undefined; child = ide.find((p) => p.ppid === compiler.pid)) {
        compiler = child;
      }
      return { pid: top.pid, compilerPid: compiler.pid, command: top.command };
    });
}
