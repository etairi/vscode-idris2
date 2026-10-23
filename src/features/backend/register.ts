/**
 * The routing's user interface (`features/backend`, ROADMAP M5): **Idris 2: Switch Backend…**
 * (`switchBackend.ts`), the effects of a change of route and the consent question and one-time
 * notification of documents served by idris2-lsp or by nothing (`follow.ts`), the copy of bamboo's
 * settings (`migration.ts`) and, while the language client is wired, the prompts to restart it
 * (`restart.ts`). Registering starts nothing: the questions and notifications follow the documents
 * shown, the prompts follow setting changes.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import type { BackendChoices, BackendRegistry } from '../../backend/registry';
import type { BackendMode, Config } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import type { SessionGate, WorkspaceTrust } from '../../core/trust';
import type { Classification, ProjectIndex } from '../../project/types';
import type { ToolchainService } from '../../toolchain/types';
import { followRoutes, type FollowDeps } from './follow';
import { registerBambooMigration } from './migration';
import { registerRestartPrompts } from './restart';
import { registerSwitchBackend } from './switchBackend';
import type { LanguageServerControl, RoutingNotice } from './types';

export type BackendFeaturesApi = Pick<typeof vscode, 'window' | 'workspace' | 'commands' | 'ConfigurationTarget'>;

export interface BackendFeaturesDeps {
  readonly trust: WorkspaceTrust;
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd' | 'onDidChange'>;
  readonly registry: Pick<BackendRegistry, 'routeFor' | 'onDidChangeRoutes'>;
  readonly choices: Pick<BackendChoices, 'get' | 'set'>;
  readonly gate: Pick<SessionGate, 'current' | 'permit'>;
  readonly toolchain: Pick<ToolchainService, 'current'>;
  readonly config: Pick<Config, 'onDidChange' | 'lsp'>;
  /** `idris2.backend.mode` for a root's folder. */
  modeFor(root: Classification): BackendMode;
  readonly ideMode: FollowDeps['ideMode'];
  readonly checks: FollowDeps['checks'];
  /** The language client, when it is wired: the restart prompts and the server's missing-`.ipkg` reports. */
  readonly client?: LanguageServerControl;
  /** `context.globalState` (the migration's **Don't Ask Again**). */
  readonly globalState: Pick<vscode.Memento, 'get' | 'update'>;
  readonly log: Log;
}

export interface BackendFeatures extends IDisposable {
  /** The notifications shown, in order (the test API). */
  readonly notices: readonly RoutingNotice[];
}

export function registerBackendFeatures(api: BackendFeaturesApi, deps: BackendFeaturesDeps): BackendFeatures {
  const store = new DisposableStore();
  const notices: RoutingNotice[] = [];
  store.add(registerSwitchBackend(api, deps));
  store.add(
    followRoutes(api, {
      ...deps,
      ...(deps.client === undefined ? {} : { onDidReportMissingIpkg: deps.client.onDidReportMissingIpkg }),
      notices,
    }),
  );
  store.add(registerBambooMigration(api, { trust: deps.trust, globalState: deps.globalState, log: deps.log, notices }));
  if (deps.client !== undefined) {
    store.add(registerRestartPrompts(api, { config: deps.config, client: deps.client, log: deps.log, notices }));
  }
  return { notices, dispose: () => store.dispose() };
}
