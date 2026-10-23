/**
 * What the routing (`backend/registry.ts`) needs done as documents are shown and routes change
 * (ROADMAP M5; the user's decision of 2026-10-01: one backend per project):
 *
 * - **A route changes** (the setting, **Switch Backend…**, a scan under `auto`, an `.ipkg` created
 *   or deleted): for each root of an open Idris document whose route was known and is now another,
 *   a root that leaves IDE mode has its waiting checks dropped, its IDE-mode sessions stopped and the
 *   problems IDE mode found in it removed (`DocumentChecks.cancelWaiting`, `IdeMode.stop`,
 *   `DocumentChecks.forgetRoot`: no second compiler for the project, and no stale or doubled problems
 *   beside the language server's); a root that
 *   comes to IDE mode has its visible documents checked again (`recheckVisible`). The language
 *   client follows `LspOwnership.onDidChange` itself (`backend/lsp/`).
 * - **A document of a root routed to idris2-lsp is shown** (in a visible editor, as IDE mode checks a
 *   document when it is first shown, M2): when its root's folder has no verdict of the consent gate
 *   yet, the gate is asked (`SessionGate.permit`): at once allowed inside a trusted workspace folder,
 *   a question otherwise. `LspOwnership.admits` never asks (`backend/lsp/types.ts`).
 * - **A document routed nowhere is shown** (idris2-lsp and no `.ipkg`): the one-time notification
 *   "idris2-lsp cannot load it", decided here and not by the server, which never reports it to the
 *   client (F35; ARCHITECTURE §5.3), offering **Use IDE Mode for This Folder** when a usable
 *   `idris2` was found (the root's choice, `BackendChoices`; M11's scaffold does not exist yet).
 *   Once per root and window, as M1's notifications.
 * - **The server reports a missing `.ipkg`** (`LanguageServerControl.onDidReportMissingIpkg`, the safety
 *   net for a root whose `.ipkg` went away): the same notification for that document's root, once.
 *
 * Nothing here runs in Restricted Mode, where nothing starts and no question is asked.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import { NO_IPKG_REASON, rootKey, type BackendChoices, type BackendRegistry, type Route } from '../../backend/registry';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Event } from '../../core/event';
import type { Log } from '../../core/log';
import { plainText, shownPath } from '../../core/notificationText';
import type { SessionGate, WorkspaceTrust } from '../../core/trust';
import { isIdrisDocument } from '../../project/literate';
import type { Classification, ProjectIndex } from '../../project/types';
import type { ToolchainService } from '../../toolchain/types';
import type { RoutingNotice } from './types';

export type FollowApi = Pick<typeof vscode, 'window' | 'workspace'>;

export interface FollowDeps {
  readonly trust: WorkspaceTrust;
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd' | 'onDidChange'>;
  readonly registry: Pick<BackendRegistry, 'routeFor' | 'onDidChangeRoutes'>;
  readonly gate: Pick<SessionGate, 'current' | 'permit'>;
  readonly choices: Pick<BackendChoices, 'set'>;
  readonly toolchain: Pick<ToolchainService, 'current'>;
  /** IDE mode's sessions (`IdeMode.stop`). */
  readonly ideMode: { stop(root: Classification): void };
  /** The checks (`DocumentChecks`). */
  readonly checks: {
    cancelWaiting(root: Classification): void;
    forgetRoot(root: Classification): void;
    recheckVisible(root: Classification): Promise<void>;
  };
  /** The language client's reports of a missing `.ipkg` (`LanguageServerControl`), when it is wired. */
  readonly onDidReportMissingIpkg?: Event<{ readonly uri?: vscode.Uri }>;
  readonly log: Log;
  readonly notices: RoutingNotice[];
}

const USE_IDE_MODE = 'Use IDE Mode for This Folder';

function isFileIdrisDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && isIdrisDocument(doc);
}

export function followRoutes(api: FollowApi, deps: FollowDeps): IDisposable {
  const store = new DisposableStore();
  /** The route of each root of an open document, when it was last looked at. */
  const routes = new Map<string, Route['kind']>();
  /** The roots this window announced as served by nothing. */
  const announced = new Set<string>();
  let running = false;
  let again = false;

  const notifyUnserved = (root: Classification, reported?: string): void => {
    if (!deps.trust.isTrusted || announced.has(rootKey(root))) {
      return;
    }
    announced.add(rootKey(root));
    const where = root.dir;
    const message =
      reported === undefined
        ? `Idris 2: idris2-lsp cannot load the Idris files of ${shownPath(where)}: ${NO_IPKG_REASON}.`
        : `Idris 2: idris2-lsp found no .ipkg file for ${shownPath(reported)}; ${NO_IPKG_REASON}.`;
    const actions = deps.toolchain.current?.idris2.status === 'probed' ? [USE_IDE_MODE] : [];
    deps.notices.push({ kind: reported === undefined ? 'noIpkg' : 'missingIpkg', message, actions });
    deps.log.info(message);
    void api.window.showWarningMessage(plainText(message), ...actions).then(async (picked) => {
      if (picked === USE_IDE_MODE && !store.isDisposed) {
        await deps.choices.set(root, 'ideMode');
        deps.log.info(`IDE mode chosen for ${where}`);
      }
    });
  };

  /** A route seen for `root`: the effects of a change (module comment). */
  const routed = (root: Classification, route: Route['kind']): void => {
    const key = rootKey(root);
    const before = routes.get(key);
    routes.set(key, route);
    if (before === undefined || before === route) {
      return;
    }
    deps.log.info(`Backend of ${root.kind === 'project' ? root.ipkgPath : root.dir}: ${before} → ${route}`);
    if (before === 'ideMode') {
      deps.checks.cancelWaiting(root);
      deps.ideMode.stop(root);
      deps.checks.forgetRoot(root);
    } else if (route === 'ideMode') {
      void deps.checks.recheckVisible(root);
    }
  };

  const look = async (): Promise<void> => {
    for (const doc of api.workspace.textDocuments.filter(isFileIdrisDocument)) {
      const root = await deps.projects.classify(doc.fileName);
      if (store.isDisposed) {
        return;
      }
      const route = deps.registry.routeFor(root);
      routed(root, route.kind);
      // Shown now (after the wait), in a trusted workspace.
      const shown = api.window.visibleTextEditors.some((e) => e.document.uri.toString() === doc.uri.toString());
      if (!shown || !deps.trust.isTrusted) {
        continue;
      }
      if (route.kind === 'lsp') {
        const dir = deps.projects.sessionCwd(root);
        if (deps.gate.current(dir) === undefined) {
          // Not awaited: the question waits for the user; the gate's change reaches the client.
          void deps.gate.permit(dir, { ipkg: root.kind === 'project' ? root.ipkgPath : undefined });
        }
      } else if (route.kind === 'none') {
        notifyUnserved(root);
      }
    }
  };

  /** Runs `look`, once more after it when asked meanwhile. */
  const refresh = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          await look();
        } while (again && !store.isDisposed);
      } catch (error) {
        deps.log.warn(`Following the backends of the open documents failed: ${String(error)}`);
      } finally {
        running = false;
      }
    })();
  };

  store.add(api.window.onDidChangeVisibleTextEditors(refresh));
  store.add(api.workspace.onDidOpenTextDocument(refresh));
  store.add(deps.registry.onDidChangeRoutes(refresh));
  store.add(deps.projects.onDidChange(refresh));
  store.add(deps.trust.onDidGrant(refresh));
  if (deps.onDidReportMissingIpkg !== undefined) {
    store.add(
      deps.onDidReportMissingIpkg(({ uri }) => {
        if (uri === undefined || uri.scheme !== 'file') {
          deps.log.warn('idris2-lsp reported a missing .ipkg file for a document it did not name.');
          return;
        }
        deps.projects.classify(uri.fsPath).then(
          (root) => notifyUnserved(root, uri.fsPath),
          (error: unknown) => deps.log.warn(`Could not classify ${uri.fsPath}: ${String(error)}`),
        );
      }),
    );
  }
  refresh();
  return store;
}
