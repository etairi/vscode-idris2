/**
 * The extension's log channel (`core/log.ts` in docs/ARCHITECTURE.md §2).
 *
 * `activate()` creates one `LogOutputChannel` named "Idris 2" and hands it to everything that
 * needs to log. The second channel of ARCHITECTURE §2, "Idris 2: Protocol Trace", is written
 * through the `ProtocolTrace` interface below (M2); its implementation, **Idris 2: Show Protocol
 * Trace** and the `idris2.trace.protocol` switch belong to the IDE-mode UI.
 */
import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Idris 2';

/**
 * What an entry of the protocol trace records:
 * - `send` — a request frame as written (prefix included);
 * - `receive` — a reply frame's text (the payload after the prefix);
 * - `unframed` — bytes of the protocol stream that are not a frame (F5: program output and the
 *   end-of-input line over stdio; any other non-hex header);
 * - `stdout` — the process's stdout outside the protocol stream (socket transport: every stdout
 *   line except the port line — log lines before it, program output after it; F5);
 * - `stderr` — the process's stderr;
 * - `event` — a lifecycle event of the session in words (spawned with its command line, handshake,
 *   exit, time-out, restart).
 */
export type TraceDirection = 'send' | 'receive' | 'unframed' | 'stdout' | 'stderr' | 'event';

export interface TraceEntry {
  /** Which session, e.g. `check /path/to/root` (the role and the session's working directory). */
  readonly session: string;
  readonly direction: TraceDirection;
  readonly text: string;
}

/**
 * The sink of the IDE-mode protocol trace (M2). The sessions call `append` for every frame and
 * lifecycle event while `enabled` is true (`idris2.trace.protocol`), and do not build entries
 * otherwise. The trace stays on this machine, like the log; it contains source text and paths.
 */
export interface ProtocolTrace {
  /** Read at every use: follows `idris2.trace.protocol`. */
  readonly enabled: boolean;
  append(entry: TraceEntry): void;
}

/**
 * The logging surface modules receive. `vscode.LogOutputChannel` satisfies it; modules that are
 * unit-tested import it with `import type`, so they do not load `vscode` at run time, and their
 * tests pass a fake.
 */
export type Log = Pick<vscode.LogOutputChannel, 'trace' | 'debug' | 'info' | 'warn' | 'error'>;

/** The "Idris 2" channel as `activate()` hands it out: the `Log` methods, `show`, `dispose`. */
export interface LogChannel extends Log, vscode.Disposable {
  show(): void;
}

/**
 * Creates the "Idris 2" channel. Once it is disposed, its methods do nothing: VS Code's channel
 * throws `Channel has been closed` from every method after `dispose()` [src: VS Code 1.139.1
 * extension host bundle, `createExtHostLogOutputChannel`], and work that outlives
 * `deactivate()` — a process the runner stopped then, a read it refused — still reports.
 */
export function createLog(): LogChannel {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  let open = true;
  return {
    trace: (message, ...args: unknown[]) => open && channel.trace(message, ...args),
    debug: (message, ...args: unknown[]) => open && channel.debug(message, ...args),
    info: (message, ...args: unknown[]) => open && channel.info(message, ...args),
    warn: (message, ...args: unknown[]) => open && channel.warn(message, ...args),
    error: (error, ...args: unknown[]) => open && channel.error(error, ...args),
    show: () => open && channel.show(),
    dispose: () => {
      open = false;
      channel.dispose();
    },
  };
}
