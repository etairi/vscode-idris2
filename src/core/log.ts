/**
 * The extension's log channel (`core/log.ts` in docs/ARCHITECTURE.md §2).
 *
 * `activate()` creates one `LogOutputChannel` named "Idris 2" and hands it to everything that
 * needs to log; no other module creates an output channel. The optional "Idris 2: Protocol
 * Trace" channel described in ARCHITECTURE §2 arrives with the IDE-mode backend (M2).
 */
import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Idris 2';

export function createLog(): vscode.LogOutputChannel {
  return vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
}
