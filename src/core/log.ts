/**
 * The extension's log channel (`core/log.ts` in docs/ARCHITECTURE.md §2).
 *
 * `activate()` creates one `LogOutputChannel` named "Idris 2" and hands it to everything that
 * needs to log; no other module creates an output channel. The optional "Idris 2: Protocol
 * Trace" channel described in ARCHITECTURE §2 arrives with the IDE-mode backend (M2).
 */
import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Idris 2';

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
