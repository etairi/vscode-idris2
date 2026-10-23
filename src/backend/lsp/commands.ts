/**
 * The language server's commands (`backend/lsp/commands.ts`; ARCHITECTURE §5.3; ROADMAP M5):
 * **Idris 2: Restart Language Server**, **Idris 2: Stop Language Server**, **Idris 2: Show Language
 * Server Output** and the developer command **Idris 2 (Developer): Send Raw LSP executeCommand…**,
 * over `LspClient` (`client.ts`).
 *
 * Restart and Stop act on the window's one client (one server serves every root routed to it,
 * ARCHITECTURE §3.2): Stop leaves it `stopped` until Restart (`client.ts`, *Lifecycle*); Restart
 * stops a running server and starts one in the folder of the last start, or, if none has started
 * yet, for the first open document the routing gives idris2-lsp. In Restricted Mode they say that
 * nothing runs. Show Output opens the channel "Idris 2 Language Server" (the server's log, the
 * library's messages and trace).
 *
 * **What a raw command can do.** Anything the server's `workspace/executeCommand` offers, as the
 * user, in the context of the file the server loaded last: `repl` hands its text to the compiler's
 * REPL, which runs colon commands [live, E10] — `:sh` runs a shell command in the server's working
 * directory, `:cd` moves it (`src/Idris/REPL.idr`, as for IDE mode's raw request,
 * `features/diagnostics/trace.ts`). So, like Send Raw Protocol Request, it is offered only while
 * `idris2.trace.protocol` is on (a user setting only; `enablement` in package.json, and checked
 * again here) in a trusted workspace, it is about the active document, which the routing must give
 * idris2-lsp (`LspClientHandle`'s check), and its text is only ever typed by the user into the input
 * box: an argument is taken only under the test runner (`acceptArgument`), so that no command link
 * and no other extension can send one unseen. The answer is written to the output channel as JSON,
 * its control and format characters written out (`visible`).
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import type { Config } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import { plainText } from '../../core/notificationText';
import type { WorkspaceTrust } from '../../core/trust';
import { visible } from '../../core/untrustedText';
import { isIdrisDocument } from '../../project/literate';
import type { LspClient } from './client';

export const RESTART_LANGUAGE_SERVER_COMMAND = 'idris2.restartLanguageServer';
export const STOP_LANGUAGE_SERVER_COMMAND = 'idris2.stopLanguageServer';
export const SHOW_LANGUAGE_SERVER_OUTPUT_COMMAND = 'idris2.showLanguageServerOutput';
export const SEND_RAW_LSP_COMMAND = 'idris2.sendRawLspCommand';

export type LanguageServerCommandsApi = Pick<typeof vscode, 'window' | 'commands'>;

export interface LanguageServerCommandsDeps {
  readonly client: Pick<LspClient, 'restart' | 'stop' | 'showOutput' | 'writeOutput' | 'rawExecuteCommand'>;
  readonly config: Pick<Config, 'trace'>;
  readonly trust: WorkspaceTrust;
  /** Whether Send Raw LSP executeCommand takes its text from the command's argument (module comment): only under the test runner. */
  readonly acceptArgument: boolean;
  readonly log: Log;
}

/** A raw command as typed: `<command> [<JSON array of arguments>]`, or why it cannot be read. */
export function parseRawCommand(text: string): { readonly command: string; readonly args: readonly unknown[] } | { readonly problem: string } {
  const trimmed = text.trim();
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (match === null) {
    return { problem: 'Type a command, e.g. metavars.' };
  }
  if (match[2] === '') {
    return { command: match[1], args: [] };
  }
  let args: unknown;
  try {
    args = JSON.parse(match[2]);
  } catch {
    return { problem: 'The arguments are not JSON: write them as a JSON array, e.g. ["1 + 1"].' };
  }
  return Array.isArray(args) ? { command: match[1], args } : { problem: 'The arguments must be a JSON array, e.g. ["1 + 1"].' };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function registerLanguageServerCommands(api: LanguageServerCommandsApi, deps: LanguageServerCommandsDeps): IDisposable {
  const store = new DisposableStore();
  const { client, log } = deps;

  store.add(
    api.commands.registerCommand(RESTART_LANGUAGE_SERVER_COMMAND, async () => {
      if (!deps.trust.isTrusted) {
        await api.window.showInformationMessage(plainText('Idris 2: in Restricted Mode no program runs, the language server neither. Trust the workspace to start it.'));
        return;
      }
      try {
        await client.restart();
      } catch (error) {
        log.warn(`Restart Language Server failed: ${messageOf(error)}`);
        await api.window.showWarningMessage(plainText(`Idris 2: the language server could not be restarted: ${messageOf(error)}`));
      }
    }),
  );

  store.add(
    api.commands.registerCommand(STOP_LANGUAGE_SERVER_COMMAND, async () => {
      try {
        await client.stop();
      } catch (error) {
        log.warn(`Stop Language Server failed: ${messageOf(error)}`);
        await api.window.showWarningMessage(plainText(`Idris 2: the language server could not be stopped: ${messageOf(error)}`));
      }
    }),
  );

  store.add(api.commands.registerCommand(SHOW_LANGUAGE_SERVER_OUTPUT_COMMAND, () => client.showOutput()));

  store.add(
    api.commands.registerCommand(SEND_RAW_LSP_COMMAND, async (argument: unknown) => {
      if (!deps.config.trace().protocol || !deps.trust.isTrusted) {
        await api.window.showInformationMessage(plainText('Idris 2: Send Raw LSP executeCommand needs idris2.trace.protocol on, in a trusted workspace.'));
        return;
      }
      const doc = api.window.activeTextEditor?.document;
      if (doc === undefined || doc.uri.scheme !== 'file' || !isIdrisDocument(doc)) {
        await api.window.showInformationMessage(plainText('Idris 2: open an Idris file of a project idris2-lsp serves; the command goes to the language server about it.'));
        return;
      }
      const text =
        deps.acceptArgument && typeof argument === 'string'
          ? argument
          : await api.window.showInputBox({
              title: 'Idris 2 (Developer): Send Raw LSP executeCommand',
              prompt: 'A command of idris2-lsp, then its arguments as a JSON array; the answer appears in the language server output.',
              placeHolder: 'metavars   or   repl ["1 + 1"]',
              validateInput: (value) => {
                const parsed = parseRawCommand(value);
                return 'problem' in parsed ? plainText(parsed.problem) : undefined;
              },
            });
      if (text === undefined) {
        return;
      }
      const parsed = parseRawCommand(text);
      if ('problem' in parsed) {
        await api.window.showWarningMessage(plainText(`Idris 2: ${parsed.problem}`));
        return;
      }
      client.showOutput();
      try {
        const answer = await client.rawExecuteCommand(doc.uri, parsed.command, parsed.args);
        client.writeOutput(`Send Raw LSP executeCommand ${visible(parsed.command)}: ${visible(JSON.stringify(answer, undefined, 2) ?? 'undefined')}`);
      } catch (error) {
        client.writeOutput(`Send Raw LSP executeCommand ${visible(parsed.command)} failed: ${visible(messageOf(error))}`);
        log.warn(`Send Raw LSP executeCommand failed: ${messageOf(error)}`);
        await api.window.showWarningMessage(plainText(`Idris 2: the raw command failed: ${messageOf(error)}`));
      }
    }),
  );

  return store;
}
