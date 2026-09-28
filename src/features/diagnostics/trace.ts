/**
 * The protocol trace (ARCHITECTURE §2 `core/log.ts`; ROADMAP M2): the `ProtocolTrace` sink the
 * IDE-mode sessions write to, the `LogOutputChannel` "Idris 2: Protocol Trace", **Idris 2: Show
 * Protocol Trace**, and the developer command **Idris 2 (Developer): Send Raw Protocol
 * Request…**, which sends one request, verbatim, to the `check` session of the active document's
 * root — the ad-hoc driver that produced ROADMAP §0's facts, inside the editor.
 *
 * Entries are written only while `idris2.trace.protocol` is on (the sessions do not even build
 * them otherwise); the channel is created on first use, so a window that never traces has none.
 * The trace holds what the sessions give it — frames, which contain source text and paths, and
 * lifecycle events — and nothing else. Like the log it is a `LogOutputChannel`, which VS Code
 * also writes to a file in its logs folder (**Developer: Open Extension Logs Folder**) and keeps
 * for several sessions (observed for the "Idris 2" channel in the test profiles' logs folders);
 * nothing is sent anywhere. The raw request is offered only while the trace is on (`enablement`
 * in package.json, and checked again here): its reply is read in the trace. The setting can be
 * set in user settings only (`application` scope; M2 verification of the third review, when it
 * became `machine`, and of the Q20–Q22 fixes, since `machine` is also read from a remote machine's
 * settings, which a dev container's configuration fills): a trusted workspace's settings could
 * otherwise offer the command and write the source text and paths of every checked file, also of
 * consented folders outside the workspace, to the log.
 *
 * **What a raw request can do.** Anything the protocol offers, as the user: `(:interpret …)`
 * reaches the compiler's REPL, whose `:sh "…"` runs a shell command (`system`,
 * `src/Idris/REPL.idr` 1078–1079 on v0.8.0 [src]; `((:interpret ":sh \"touch X\"") 1)` created `X` in
 * the session directory [live, M2 second review]) and whose `:cd` moves the compiler's working
 * directory, after which the extension's own loads search for a package from there (F13) until
 * the session is restarted; a raw `:load-file` is sent as typed, without the check that the
 * compiler would use the package the session was started for (`backend/ide/backend.ts`), so it can
 * move the compiler into another package's folder too. A request the compiler never answers with a `:return` holds the
 * session until `idris2.ideMode.longActionTimeout` (60 s by default), after which the process is
 * stopped, the requests queued behind it are rejected and the session restarts: `(:interpret ":q")`
 * (also `:quit`, `:exit`) is answered only with `(:write-string "Bye for now!" …)` while the
 * compiler serves on (F4 addendum [live]), and an `:exec` of a program that does not end never
 * returns. So the request text is only ever typed by the user into the input
 * box: a text passed as the command's argument is taken only under the test runner
 * (`ExtensionMode.Test`, `acceptArgument`), so that no command link — e.g. in a hover's markdown
 * that shows compiler text, M3 — and no other extension can send one without the user seeing it.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import type { Config } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Log, ProtocolTrace, TraceEntry } from '../../core/log';
import { plainText } from '../../core/notificationText';
import type { Classification, ProjectIndex } from '../../project/types';
import { isCheckable } from './checks';

export const PROTOCOL_TRACE_CHANNEL_NAME = 'Idris 2: Protocol Trace';
export const SHOW_PROTOCOL_TRACE_COMMAND = 'idris2.showProtocolTrace';
export const SEND_RAW_REQUEST_COMMAND = 'idris2.sendRawRequest';

export type TraceApi = Pick<typeof vscode, 'window' | 'commands'>;

/** One line of the channel (the channel adds the time): `<direction> <session>: <text>`. */
export function traceLine(entry: TraceEntry): string {
  return `${entry.direction} ${entry.session}: ${entry.text.replace(/\n$/, '')}`;
}

export class ProtocolTraceChannel implements ProtocolTrace, IDisposable {
  private channel: vscode.LogOutputChannel | undefined;
  private on: boolean;
  private readonly store = new DisposableStore();

  constructor(
    private readonly api: TraceApi,
    config: Pick<Config, 'trace' | 'onDidChange'>,
  ) {
    this.on = config.trace().protocol;
    this.store.add(config.onDidChange('trace', () => (this.on = config.trace().protocol)));
  }

  get enabled(): boolean {
    return this.on && !this.store.isDisposed;
  }

  private open(): vscode.LogOutputChannel {
    this.channel ??= this.store.add(this.api.window.createOutputChannel(PROTOCOL_TRACE_CHANNEL_NAME, { log: true }));
    return this.channel;
  }

  append(entry: TraceEntry): void {
    if (this.enabled) {
      this.open().info(traceLine(entry));
    }
  }

  show(): void {
    this.open().show(true);
  }

  dispose(): void {
    this.store.dispose();
    this.channel = undefined;
  }
}

/** What Send Raw Protocol Request needs of the backend (`IdeMode.sendRaw`). */
export interface RawRequests {
  sendRaw(root: Classification, text: string): Promise<string>;
}

export interface TraceCommandsDeps {
  /**
   * Whether Send Raw Protocol Request takes its text from the command's argument instead of the
   * input box: only under the test runner (module comment, *What a raw request can do*).
   */
  readonly acceptArgument: boolean;
  readonly trace: ProtocolTraceChannel;
  readonly raw: RawRequests;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  readonly log: Log;
}

export function registerTraceCommands(api: TraceApi, deps: TraceCommandsDeps): IDisposable {
  const store = new DisposableStore();
  store.add(
    api.commands.registerCommand(SHOW_PROTOCOL_TRACE_COMMAND, async () => {
      deps.trace.show();
      if (!deps.trace.enabled) {
        const action = await api.window.showInformationMessage(
          plainText('Idris 2: the protocol trace is off. Turn on idris2.trace.protocol to record the messages exchanged with the compiler.'),
          'Open Setting',
        );
        if (action === 'Open Setting') {
          await api.commands.executeCommand('workbench.action.openSettings', 'idris2.trace.protocol');
        }
      }
    }),
  );

  store.add(
    api.commands.registerCommand(SEND_RAW_REQUEST_COMMAND, async (argument: unknown) => {
      if (!deps.trace.enabled) {
        await api.window.showInformationMessage(plainText('Idris 2: Send Raw Protocol Request needs idris2.trace.protocol, where its reply appears.'));
        return;
      }
      const doc = api.window.activeTextEditor?.document;
      if (doc === undefined || !isCheckable(doc)) {
        await api.window.showInformationMessage(plainText("Idris 2: open an Idris file; the request goes to its project's compiler."));
        return;
      }
      const text =
        deps.acceptArgument && typeof argument === 'string'
          ? argument
          : await api.window.showInputBox({
              title: 'Idris 2 (Developer): Send Raw Protocol Request',
              prompt: 'The command part of a request, sent verbatim as (<command> <id>); the reply appears in the protocol trace.',
              placeHolder: '(:type-of "main")   or   :version',
              validateInput: (value) => (value.trim() === '' ? 'Type a command.' : undefined),
            });
      if (text === undefined) {
        return;
      }
      deps.trace.show();
      try {
        const answer = await deps.raw.sendRaw(await deps.projects.classify(doc.fileName), text);
        deps.trace.append({ session: 'Send Raw Protocol Request', direction: 'event', text: `answered: ${answer}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.trace.append({ session: 'Send Raw Protocol Request', direction: 'event', text: `failed: ${message}` });
        deps.log.warn(`Send Raw Protocol Request failed: ${message}`);
        await api.window.showWarningMessage(plainText(`Idris 2: the raw request failed: ${message}`));
      }
    }),
  );
  return store;
}
