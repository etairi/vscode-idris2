/**
 * "Restart the language server?" for the one change that cannot reach a running server and that the
 * language client does not see itself (ROADMAP M5: changes that cannot be forwarded prompt a
 * restart): `idris2.lsp.logFile` cleared. The server cannot go back to its standard error
 * (`changeLogFile`, `Server/Log.idr` 106–117 [src]), so the empty value is not sent and takes effect
 * when it starts again. The others are forwarded or asked about elsewhere:
 * - the server's options are sent as `workspace/didChangeConfiguration` (`backend/lsp/types.ts`
 *   `LspServerOptions`);
 * - `idris2.lsp.trace.server` is read again by the language client at every configuration change and
 *   sent as `$/setTrace` (`hookConfigurationChanged`, `refreshTrace` [src: vscode-languageclient
 *   10.1.2, `lib/common/client.js` 1498–1534]), so, unlike ROADMAP M5's text, it prompts nothing;
 * - a change of `idris2.toolchain.lspPath`, `env` or `preferPack` starts a toolchain scan, and the
 *   language client asks once, when that scan finds another executable or environment than the
 *   running server's (`backend/lsp/client.ts`, *Settings*); asking here as well asked twice for one
 *   change (integration, 2026-10-02).
 * The prompt is shown only while the client runs or starts (`LanguageServerControl.state`), once per
 * change.
 *
 * Only type imports from `vscode`: `restartReason` is unit-tested on plain Node.
 */
import type * as vscode from 'vscode';
import type { Config } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import { plainText } from '../../core/notificationText';
import type { LanguageServerControl, RoutingNotice } from './types';

/**
 * Why the running server should be restarted after `idris2.lsp.logFile` changed from `logFileBefore`
 * to `logFileAfter` (module comment); `undefined` when nothing needs it.
 */
export function restartReason(logFileBefore: string, logFileAfter: string): string | undefined {
  return logFileBefore !== '' && logFileAfter === '' ? 'idris2-lsp writes its log to the earlier idris2.lsp.logFile until it starts again' : undefined;
}

export type RestartApi = Pick<typeof vscode, 'window'>;

export interface RestartDeps {
  readonly config: Pick<Config, 'onDidChange' | 'lsp'>;
  readonly client: Pick<LanguageServerControl, 'state' | 'restart'>;
  readonly log: Log;
  readonly notices: RoutingNotice[];
}

const RESTART = 'Restart Language Server';

export function registerRestartPrompts(api: RestartApi, deps: RestartDeps): IDisposable {
  const store = new DisposableStore();
  let logFile = deps.config.lsp().logFile;

  const offer = (reason: string): void => {
    const state = deps.client.state.kind;
    if (state !== 'running' && state !== 'starting') {
      return;
    }
    const message = `Idris 2: ${reason}. Restart it to apply the change?`;
    deps.notices.push({ kind: 'restart', message, actions: [RESTART] });
    void api.window.showInformationMessage(plainText(message), RESTART).then(async (picked) => {
      if (picked !== RESTART || store.isDisposed) {
        return;
      }
      try {
        await deps.client.restart();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        deps.log.warn(`Restarting the language server failed: ${text}`);
        await api.window.showWarningMessage(plainText(`Idris 2: restarting the language server failed: ${text}`));
      }
    });
  };

  store.add(
    deps.config.onDidChange('lsp', (change) => {
      if (!change.affects('lsp.logFile')) {
        return;
      }
      const before = logFile;
      logFile = deps.config.lsp().logFile;
      const reason = restartReason(before, logFile);
      if (reason !== undefined) {
        offer(reason);
      }
    }),
  );
  return store;
}
