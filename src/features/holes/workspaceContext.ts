/**
 * The context key `idris2.isIdrisWorkspace` (`types.ts` `IsIdrisWorkspaceContextKey`), which shows
 * the Holes view — and with it the "Idris 2" activity-bar container, which VS Code hides while it
 * has no view to show — only in windows where Idris is being written. No `vscode` import:
 * `extension.ts` adapts the workspace to `IdrisWorkspaceHost`.
 */
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Event } from '../../core/event';
import type { Log } from '../../core/log';
import { isIdrisDocument, type IdrisDocumentCandidate } from '../../project/literate';
import type { IsIdrisWorkspaceContextKey } from './types';

export const IS_IDRIS_WORKSPACE_CONTEXT_KEY: IsIdrisWorkspaceContextKey = 'idris2.isIdrisWorkspace';

/** What the tracker reads; `extension.ts` passes the project index's workspace surface and `vscode.workspace`. */
export interface IdrisWorkspaceHost {
  /** Whether a workspace folder holds an `.ipkg` file: a search that stops at the first. */
  hasIpkgFile(): Promise<boolean>;
  readonly onDidCreateOrDeleteIpkgFile: Event<string>;
  readonly onDidChangeFolders: Event<void>;
  /** The documents open now (`vscode.workspace.textDocuments`). */
  openDocuments(): readonly IdrisDocumentCandidate[];
  readonly onDidOpenDocument: Event<IdrisDocumentCandidate>;
  setContext(key: string, value: boolean): void;
  readonly log: Log;
}

/**
 * Sets `idris2.isIdrisWorkspace` to true once a workspace folder holds an `.ipkg` file (looked for
 * at the start, when the folders change, and when an `.ipkg` file is created or deleted) or an
 * Idris document (`isIdrisDocument`) is open or opened; it is never set back while the extension
 * runs. Disposing resets it to false, like `idris2.isIdrisDocument` (`project/literate.ts`
 * `trackIsIdrisDocumentContext`: nothing removes a context key when the extension is deactivated).
 */
export function trackIsIdrisWorkspace(host: IdrisWorkspaceHost): IDisposable {
  const listeners = new DisposableStore();
  let set = false;
  let disposed = false;
  const setTrue = (): void => {
    if (set || disposed) {
      return;
    }
    set = true;
    listeners.dispose();
    host.setContext(IS_IDRIS_WORKSPACE_CONTEXT_KEY, true);
  };
  const lookForPackages = (): void => {
    host.hasIpkgFile().then(
      (found) => {
        if (found) {
          setTrue();
        }
      },
      (error: unknown) => host.log.warn(`Looking for .ipkg files in the workspace failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  if (host.openDocuments().some(isIdrisDocument)) {
    setTrue();
  } else {
    listeners.add(host.onDidOpenDocument((doc) => isIdrisDocument(doc) && setTrue()));
    listeners.add(host.onDidCreateOrDeleteIpkgFile(lookForPackages));
    listeners.add(host.onDidChangeFolders(lookForPackages));
    lookForPackages();
  }
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      listeners.dispose();
      if (set) {
        host.setContext(IS_IDRIS_WORKSPACE_CONTEXT_KEY, false);
      }
    },
  };
}
