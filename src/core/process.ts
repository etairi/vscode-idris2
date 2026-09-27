/**
 * The process runner (`core/process.ts`): every short-lived command the extension starts —
 * the toolchain probes of `toolchain/service.ts` and `idris2 --dump-ipkg-json` of the project
 * index — goes through the one `ProcessRunner` that `extension.ts` creates with
 * `createProcessRunner`. The contract and its rules are in `toolchain/types.ts`
 * (`ProcessRunner`); how they are kept:
 *
 * - **Trust.** `run` rejects with `IdrisException` `Unsupported` while the workspace is not
 *   trusted, before anything is queued or started (Restricted Mode, `core/trust.ts`).
 * - **One at a time.** Requests wait in a FIFO queue; the next starts when the previous one has
 *   been resolved. (On Windows a timed-out process is stopped with `taskkill.exe`, which runs
 *   while that process's result is still pending.)
 * - **No shell.** Executables are spawned directly with an argument vector (`spawn` without
 *   `shell`). The one exception is a Windows `.cmd`/`.bat` file, which Node refuses to spawn
 *   without a shell (`EINVAL`, the CVE-2024-27980 fix [doc: Node.js security release, April
 *   2024]); see `batchFileCommand` for how it is quoted and what is refused.
 * - **Every outcome resolves.** Non-zero exit, signal, timeout, output limit and spawn failure
 *   all resolve with a `ProcessResult`; only the trust refusal, invalid requests and requests
 *   made or still queued after `dispose()` reject.
 * - **Termination.** On POSIX the child leads its own process group and a timeout signals the
 *   whole group (`SIGTERM`, then `SIGKILL` after a grace period) until the result is settled,
 *   also after the child itself has ended, so the grandchildren of a wrapper script — pack's
 *   `idris2` wrapper runs the real compiler as a child of `sh` (`appLink`, idris2-pack
 *   `src/Pack/Runner/Install.idr` 150–186 [src]), and so does the `#!/bin/sh` launcher the
 *   Chez backend writes for every Idris program, Homebrew's `idris2` included (it runs
 *   `idris2_app/idris2.so` without `exec` [live, `/opt/homebrew/Cellar/idris2/0.8.0_2/libexec/
 *   bin/idris2`]) — are stopped too, as long as they are still in the child's process group,
 *   even one that ignores SIGTERM while it holds the output pipes. `dispose()` sends `SIGKILL`
 *   to the group at once: `deactivate()` is synchronous, and the Extension Host may exit before
 *   a grace timer fires. What is not reached: a descendant that left the group (`setsid`,
 *   `setpgid`); a grandchild that ignores SIGTERM and has closed the pipes, once they have
 *   closed; and a background grandchild of a child that exited normally, which is never
 *   signalled (the result is settled without it after `GRACE_MS` if it holds the pipes). On
 *   Windows `taskkill /T /F` ends the child and its descendants while the child lives (see
 *   `signalChild`). A descendant that survives and keeps the output pipes open delays the
 *   result only by the grace period (`GRACE_MS`), but it keeps running until it ends by
 *   itself.
 * - **Output.** stdout and stderr are decoded as UTF-8 once the process has ended (so a
 *   character split across two reads decodes correctly). Each stream is limited to
 *   `OUTPUT_LIMIT_BYTES`; a process that writes more is stopped like a timed-out one, so that a
 *   misconfigured path (a program that prints without end) cannot exhaust the Extension Host's
 *   memory. The result then has `exitCode: null`, the signal that stopped it, and the output up
 *   to the limit; the log says why.
 * - The child's stdin is `/dev/null` (`'ignore'`): a tool that reads its input sees end of file
 *   at once instead of waiting until the timeout.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { ProcessRequest, ProcessResult, ProcessRunner, ProcessRunnerOptions } from '../toolchain/types';
import type { IDisposable } from './disposable';
import { unsupported } from './errors';
import type { Log } from './log';

/** The time limit of every toolchain probe (ROADMAP M1, "execFile with a 5 s timeout"). */
export const PROBE_TIMEOUT_MS = 5_000;

/** The largest stdout or stderr kept per process: 1 MiB, the default `maxBuffer` of `execFile`. */
const OUTPUT_LIMIT_BYTES = 1024 * 1024;

/**
 * After `SIGTERM` (timeout or output limit), how long a process group has to end before it is
 * sent `SIGKILL`; also how long the result waits for the output pipes to close after the
 * child has exited (a grandchild that inherited them may keep them open).
 */
const GRACE_MS = 2_000;

/** An environment as `process.env` has it: names to values, `undefined` for unset ones. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Whether `p` is a path that names the same file whatever the current directory and drive of
 * the Extension Host. On POSIX: it starts with `/`. On Windows: a drive letter followed by a
 * separator (`C:\x`, `C:/x`) or a UNC path (`\\server\share\…`, also `\\?\…` and `\\.\…`).
 * `path.win32.isAbsolute` also accepts `\x`, which Microsoft calls an absolute path but which
 * names a directory on the *current* drive (Node's `path.win32.resolve('C:\\w', '\\x')` is
 * `C:\x`), so a `\usr\local\bin` could lie on a drive another local user can write to the root
 * of; and `C:x` is relative to drive C's current directory (Microsoft, "Naming Files, Paths,
 * and Namespaces", *Fully qualified vs. relative paths*, read 2026-09-27 [doc]).
 */
export function isFullyQualifiedPath(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p) : p.startsWith('/');
}

/** The value of the variable `name`; on Windows names are compared case-insensitively, as the OS does. */
export function environmentValue(env: Environment, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') {
    return env[name];
  }
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * `base` with every variable of `overlay` replacing the one of the same name (on Windows
 * compared case-insensitively, so `{ "PATH": … }` replaces an inherited `Path`). Unset
 * (`undefined`) entries of `base` are dropped.
 */
export function overlayEnvironment(
  base: Environment,
  overlay: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (platform === 'win32') {
      const upper = key.toUpperCase();
      for (const existing of Object.keys(result)) {
        if (existing.toUpperCase() === upper) {
          delete result[existing];
        }
      }
    }
    result[key] = value;
  }
  return result;
}

/**
 * Why `text` cannot be put into the `cmd.exe` command line below, or `undefined` if it can.
 *
 * Inside double quotes `cmd.exe` takes `& | < > ( ) ^` and spaces literally, but it still
 * expands `%VAR%` (with or without quotes), `!VAR!` when delayed expansion is on (in `cmd.exe`
 * with `/v:on` or in a batch file after `setlocal EnableDelayedExpansion`), and a `"` inside
 * the text would end the quoted part. A line break ends the command. A trailing backslash
 * would escape the closing quote for a program that parses its command line by the Microsoft
 * C runtime rules, to which a batch file forwarding `%*` passes it. Such text is refused
 * rather than escaped, because `%` cannot be escaped reliably on a `cmd /c` command line: the
 * extension passes only flags and file paths, and a path containing one of these characters
 * makes the run fail with this reason instead of running something else.
 */
function cmdQuotingProblem(text: string, role: 'path' | 'argument'): string | undefined {
  const bad = /["%!\r\n\0]/.exec(text);
  if (bad !== null) {
    const shown = bad[0] === '\r' ? 'a carriage return' : bad[0] === '\n' ? 'a line break' : bad[0] === '\0' ? 'a NUL' : bad[0];
    return `the ${role} ${JSON.stringify(text)} contains ${shown}, which cmd.exe would interpret`;
  }
  if (role === 'argument' && text.endsWith('\\')) {
    return `the argument ${JSON.stringify(text)} ends with a backslash, which would escape its closing quote`;
  }
  return undefined;
}

/**
 * How a Windows batch file (`.cmd`, `.bat`) is started without passing untrusted text through
 * a shell unquoted: `<comspec> /d /s /v:off /c ""<file>" "<arg1>" …"`, spawned with
 * `windowsVerbatimArguments` so that Node adds no quoting of its own.
 *
 * - `/d` skips the `AutoRun` commands of the registry, `/v:off` turns delayed expansion off.
 * - `/s` makes `cmd.exe` remove exactly the first and the last quote of what follows `/c` and
 *   parse the rest as an ordinary command line, in which the batch file path and every
 *   argument are each quoted, so that only `%` (and `!` with delayed expansion) would still
 *   be interpreted inside them — which `cmdQuotingProblem` excludes.
 * - A path or argument that `cmdQuotingProblem` rejects is refused: the result is
 *   `{ refused }` and nothing is started.
 *
 * `comspec` is the `cmd.exe` to use (`commandInterpreter`); without one, the batch file is
 * refused.
 */
export function batchFileCommand(
  file: string,
  args: readonly string[],
  comspec: string | undefined,
): { readonly file: string; readonly args: readonly string[] } | { readonly refused: string } {
  if (comspec === undefined) {
    // A bare `cmd.exe` would be looked up in the working directory first.
    return { refused: 'refused to run a batch file: neither ComSpec nor SystemRoot names cmd.exe by a fully qualified path' };
  }
  const problem =
    cmdQuotingProblem(file, 'path') ??
    args.map((arg) => cmdQuotingProblem(arg, 'argument')).find((p) => p !== undefined);
  if (problem !== undefined) {
    return { refused: `refused to run a batch file through cmd.exe: ${problem}` };
  }
  const quoted = [file, ...args].map((part) => `"${part}"`).join(' ');
  return { file: comspec, args: ['/d', '/s', '/v:off', '/c', `"${quoted}"`] };
}

/**
 * The `cmd.exe` batch files are run with: `%ComSpec%` when it is a fully qualified path
 * (`isFullyQualifiedPath`), else `%SystemRoot%\System32\cmd.exe`, else none. Read from the
 * Extension Host's environment, never from `idris2.toolchain.env`.
 */
export function commandInterpreter(env: Environment): string | undefined {
  const comspec = environmentValue(env, 'ComSpec', 'win32');
  if (comspec !== undefined && isFullyQualifiedPath(comspec, 'win32')) {
    return comspec;
  }
  return system32Program(env, 'cmd.exe');
}

/**
 * Why a finished process counts as failed, as the end of a sentence ("… exited with code 1"),
 * or `undefined` when it exited with code 0.
 */
export function describeFailure(result: ProcessResult, timeoutMs: number): string | undefined {
  if (result.spawnError !== undefined) {
    return `could not be started (${result.spawnError})`;
  }
  if (result.timedOut) {
    return `did not finish within ${timeoutMs / 1000} s and was stopped`;
  }
  if (result.exitCode === null) {
    return result.signal === null ? 'ended abnormally' : `was ended by ${result.signal}`;
  }
  return result.exitCode === 0 ? undefined : `exited with code ${result.exitCode}`;
}

function displayCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map((part) => (/^[\w./:=@+,-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

function requestProblem(request: ProcessRequest, platform: NodeJS.Platform): string | undefined {
  if (!isFullyQualifiedPath(request.executable, platform)) {
    return `the executable ${JSON.stringify(request.executable)} is not an absolute path (with a drive or UNC root on Windows)`;
  }
  if (request.cwd !== undefined && !isFullyQualifiedPath(request.cwd, platform)) {
    return `the working directory ${JSON.stringify(request.cwd)} is not an absolute path (with a drive or UNC root on Windows)`;
  }
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    return `the time limit ${request.timeoutMs} is not a positive number of milliseconds`;
  }
  const strings = [request.executable, ...request.args, request.cwd ?? ''];
  for (const [key, value] of Object.entries(request.env ?? {})) {
    strings.push(key, value);
  }
  if (strings.some((s) => s.includes('\0'))) {
    return 'a NUL character in the executable, an argument, the working directory or the environment';
  }
  return undefined;
}

/** Knobs of the runner that tests change; `createProcessRunner` uses the defaults. */
export interface ProcessRunnerTuning {
  readonly platform: NodeJS.Platform;
  /** The environment children inherit before `ProcessRequest.env` is overlaid. */
  readonly baseEnv: Environment;
  readonly graceMs: number;
  readonly outputLimitBytes: number;
}

/** The runner and its owner's handle: `dispose` is called at deactivation (`extension.ts`). */
export type OwnedProcessRunner = ProcessRunner & IDisposable;

/** The runner of the contract in `toolchain/types.ts`, for this process (`process.platform`, `process.env`). */
export function createProcessRunner(options: ProcessRunnerOptions): OwnedProcessRunner {
  return createTunedProcessRunner(options, {
    platform: process.platform,
    baseEnv: process.env,
    graceMs: GRACE_MS,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
  });
}

/**
 * `createProcessRunner` with explicit tuning; exported for the unit tests.
 *
 * `dispose()` makes every later `run` and every request still waiting in the queue reject,
 * and kills the running process at once (`SIGKILL` to its group on POSIX, `taskkill /T /F` on
 * Windows), without logging it: the log may be gone.
 */
export function createTunedProcessRunner(options: ProcessRunnerOptions, tuning: ProcessRunnerTuning): OwnedProcessRunner {
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let running: Execution | undefined;
  return {
    run(request: ProcessRequest): Promise<ProcessResult> {
      if (disposed) {
        return Promise.reject(new Error('The process runner has been disposed.'));
      }
      if (!options.trust.isTrusted) {
        return Promise.reject(
          unsupported('Restricted Mode: the extension starts no program until the workspace is trusted.'),
        );
      }
      const problem = requestProblem(request, tuning.platform);
      if (problem !== undefined) {
        return Promise.reject(new Error(`Invalid process request: ${problem}.`));
      }
      const result = tail.then(() => {
        if (disposed) {
          throw new Error('The process runner was disposed before the process started.');
        }
        const execution = execute(request, options.log, tuning);
        running = execution;
        return execution.result.finally(() => {
          running = undefined;
        });
      });
      tail = result.catch(() => undefined);
      return result;
    },
    dispose(): void {
      disposed = true;
      running?.cancel();
    },
  };
}

/** One process: its result, and `cancel`, which kills it without logging (dispose). */
interface Execution {
  readonly result: Promise<ProcessResult>;
  cancel(): void;
}

/**
 * The absolute path of `name` in `%SystemRoot%\System32`, or `undefined` when `SystemRoot` is not
 * a fully qualified path (`isFullyQualifiedPath`). Read from the Extension Host's environment,
 * never from `idris2.toolchain.env`.
 */
function system32Program(env: Environment, name: string): string | undefined {
  const systemRoot = environmentValue(env, 'SystemRoot', 'win32');
  return systemRoot !== undefined && isFullyQualifiedPath(systemRoot, 'win32')
    ? path.win32.join(systemRoot, 'System32', name)
    : undefined;
}

/**
 * Whether Windows runs `file` as a batch file. The extension is tested on the file name with
 * trailing dots and spaces removed, because Windows removes them when it resolves the name
 * (`C:\x\idris2.cmd.` opens `C:\x\idris2.cmd`) [doc: Microsoft, "Naming Files, Paths, and
 * Namespaces"].
 */
export function isBatchFile(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file.replace(/[. ]+$/, ''));
}

function execute(request: ProcessRequest, log: Log, tuning: ProcessRunnerTuning): Execution {
  const { platform } = tuning;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const cwd = request.cwd ?? pathApi.dirname(request.executable);
  const env = overlayEnvironment(tuning.baseEnv, request.env ?? {}, platform);
  const shown = displayCommand(request.executable, request.args);
  const started = performance.now();

  let file = request.executable;
  let args: readonly string[] = request.args;
  let verbatim = false;
  if (platform === 'win32' && isBatchFile(file)) {
    const command = batchFileCommand(file, args, commandInterpreter(tuning.baseEnv));
    if ('refused' in command) {
      log.warn(`${shown}: ${command.refused}`);
      const result: ProcessResult = {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: command.refused,
        durationMs: performance.now() - started,
      };
      return { result: Promise.resolve(result), cancel: () => undefined };
    }
    ({ file, args } = command);
    verbatim = true;
  }
  log.debug(`Running ${shown} (cwd ${cwd})`);

  let cancel: () => void = () => undefined;
  const result = new Promise<ProcessResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const size = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let overLimit = false;
    let cancelled = false;
    let stopping = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        // A new process group on POSIX, so that `stop` reaches the grandchildren too.
        detached: platform !== 'win32',
      });
    } catch (error) {
      // `ChildProcess.spawn` throws, instead of emitting 'error', for every spawn error other
      // than EACCES, EAGAIN, EMFILE, ENFILE and ENOENT (Node 24.13 `internal/child_process`,
      // read with --expose-internals). None was reproduced here; this keeps the rule that
      // every attempted process resolves.
      finish({ spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    function finish(outcome: { spawnError?: string; code?: number | null; signal?: NodeJS.Signals | null }): void {
      if (settled) {
        return;
      }
      settled = true;
      timers.forEach(clearTimeout);
      const result: ProcessResult = {
        exitCode: timedOut || overLimit || cancelled || outcome.spawnError !== undefined ? null : (outcome.code ?? null),
        signal: outcome.signal ?? null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        ...(outcome.spawnError === undefined ? {} : { spawnError: outcome.spawnError }),
        durationMs: performance.now() - started,
      };
      const failure = describeFailure(result, request.timeoutMs);
      if (cancelled) {
        // Stopped by dispose(): nobody reads the result, and the log may be closed.
      } else if (overLimit) {
        log.warn(`${shown}: stopped after writing more than ${tuning.outputLimitBytes} bytes to one output stream`);
      } else if (failure !== undefined) {
        log.warn(`${shown} ${failure}`);
      }
      resolve(result);
    }

    /**
     * Sends `signal` to the child's process group (POSIX), or stops the child and what it
     * started (Windows), until the result is settled.
     *
     * POSIX: the group is signalled even after the child has ended, because a wrapper script
     * (pack's, or Homebrew's `idris2`, both `sh` scripts that run the real program as their
     * child) dies on SIGTERM at once while the program may ignore it. While the result is not
     * settled some process still holds the output pipes; as long as it is in the group, the
     * group's ID cannot be reused, since POSIX does not hand out a process group ID while the
     * group has a member. `ESRCH` (the group is gone) is ignored.
     *
     * Windows: while the child lives, `taskkill /T /F` ends it and its descendants (for a batch
     * file, `cmd.exe` and the program it runs), and `child.kill` when taskkill cannot be
     * started. Once the child has ended, its descendants cannot be found any more (`/T` walks
     * down from a live process), so they keep running.
     */
    function signalChild(signal: NodeJS.Signals): void {
      if (settled) {
        return;
      }
      if (platform !== 'win32') {
        try {
          if (child.pid !== undefined) {
            process.kill(-child.pid, signal);
          }
        } catch {
          // ESRCH: the group is gone.
        }
        return;
      }
      if (exited !== undefined) {
        return;
      }
      const taskkill = child.pid === undefined ? undefined : system32Program(tuning.baseEnv, 'taskkill.exe');
      if (taskkill === undefined) {
        child.kill(signal);
        return;
      }
      try {
        const killer = spawn(taskkill, ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill(signal));
      } catch {
        child.kill(signal);
      }
    }

    function stop(): void {
      if (stopping) {
        return;
      }
      stopping = true;
      signalChild('SIGTERM');
      timers.push(
        setTimeout(() => {
          signalChild('SIGKILL');
          timers.push(setTimeout(abandonPipes, tuning.graceMs));
        }, tuning.graceMs),
      );
    }

    // dispose(): no grace period, since the Extension Host may exit before a timer fires. The
    // group is signalled even when a time-out has already sent SIGTERM.
    cancel = (): void => {
      if (settled) {
        return;
      }
      cancelled = true;
      signalChild('SIGKILL');
      if (!stopping) {
        stopping = true;
        timers.push(setTimeout(abandonPipes, tuning.graceMs));
      }
    };

    /** Resolves without waiting for pipes that a surviving grandchild still holds open. */
    function abandonPipes(): void {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code: exited?.code ?? null, signal: exited?.signal ?? null });
    }

    function collect(stream: 'stdout' | 'stderr', chunks: Buffer[]) {
      return (chunk: Buffer): void => {
        const room = tuning.outputLimitBytes - size[stream];
        if (chunk.length <= room) {
          chunks.push(chunk);
          size[stream] += chunk.length;
          return;
        }
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          size[stream] += room;
        }
        if (!stopping) {
          overLimit = true;
          stop();
        }
      };
    }

    child.stdout?.on('data', collect('stdout', stdout));
    child.stderr?.on('data', collect('stderr', stderr));
    // A spawn failure (ENOENT, EACCES, …) leaves `pid` unset and is reported by 'error'; the
    // 'close' that follows carries the negative errno as its code (Node 24.13 on macOS,
    // 2026-09-27: `error` then `close:-2` for a missing file, `close:-13` for a directory) and
    // is ignored because the result is already settled.
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (child.pid === undefined) {
        finish({ spawnError: error.code === undefined ? error.message : `${error.code}: ${error.message}` });
      } else if (!cancelled) {
        log.warn(`${shown}: ${error.message}`);
      }
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      // After a stop, the SIGKILL that follows the grace period comes first (see `stop`).
      if (!stopping) {
        timers.push(setTimeout(abandonPipes, tuning.graceMs));
      }
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => finish({ code, signal }));
    timers.push(
      setTimeout(() => {
        if (exited === undefined && !stopping) {
          timedOut = true;
          stop();
        }
      }, request.timeoutMs),
    );
  });
  return { result, cancel: () => cancel() };
}
