/**
 * One-time toolchain notifications (ROADMAP M1): a warning when the compiler is missing, with
 * the actions **Install Idris 2…**, **Set Path** and **Show Output**, and a warning when the
 * pair verdict says idris2-lsp and idris2 likely do not match.
 *
 * "One time" means: once per window (Extension Host session) for each distinct condition. The
 * condition of the missing-compiler warning is the value of `idris2.toolchain.idris2Path`, so
 * a rescan that finds the same thing stays silent, while setting a path that also names nothing
 * warns again — that is the feedback the user needs at that moment. The condition of the
 * mismatch warning is the pair (both paths and the verdict's reason). Nothing is remembered
 * across windows: a problem that persists is announced again after a reload, when the user can
 * act on it, whereas a "shown once ever" flag in global state would hide it for good after the
 * context was forgotten. The status item keeps showing the state in between. No warning is
 * shown for a scan in Restricted Mode: VS Code then ignores workspace values of the path
 * settings and nothing is run, so "not found" could be wrong once the workspace is trusted.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`, so the
 * decisions (`noticesFor`, `NoticeGate`) are unit-tested on plain Node.
 */
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../core/disposable';
import type { Log } from '../core/log';
import type { ToolchainService, ToolchainSnapshot } from './types';

export interface NoticeAction {
  /** The button label. */
  readonly label: string;
  readonly command: string;
  readonly args: readonly unknown[];
}

export interface Notice {
  readonly kind: 'idris2Missing' | 'pairMismatch';
  /** The condition this notice reports; a notice is shown once per key and window. */
  readonly key: string;
  readonly message: string;
  readonly actions: readonly NoticeAction[];
}

const OPEN_SETTINGS = 'workbench.action.openSettings';

/** The notices a finished scan calls for, before the once-per-condition rule. */
export function noticesFor(snapshot: ToolchainSnapshot): Notice[] {
  if (!snapshot.trusted) {
    return [];
  }
  const notices: Notice[] = [];
  if (snapshot.idris2.status === 'missing') {
    notices.push({
      kind: 'idris2Missing',
      key: JSON.stringify(['idris2Missing', snapshot.settings.idris2Path]),
      message: `Idris 2: the compiler (idris2) was not found. ${snapshot.idris2.reason}`,
      actions: [
        { label: 'Install Idris 2…', command: 'idris2.installIdris2', args: [] },
        { label: 'Set Path', command: OPEN_SETTINGS, args: ['idris2.toolchain.idris2Path'] },
        { label: 'Show Output', command: 'idris2.showOutput', args: [] },
      ],
    });
  }
  const verdict = snapshot.verdict;
  if (verdict?.kind === 'likelyMismatch') {
    const pathOf = (state: ToolchainSnapshot['idris2'] | ToolchainSnapshot['lsp']): string =>
      state.status === 'missing' ? '' : state.location.path;
    notices.push({
      kind: 'pairMismatch',
      key: JSON.stringify(['pairMismatch', pathOf(snapshot.idris2), pathOf(snapshot.lsp), verdict.reason]),
      message: `Idris 2: idris2-lsp and idris2 likely do not match. ${verdict.reason}`,
      actions: [
        { label: 'Show Setup Information', command: 'idris2.showSetupInformation', args: [] },
        { label: 'Open Settings', command: OPEN_SETTINGS, args: ['idris2.toolchain'] },
      ],
    });
  }
  return notices;
}

/** Remembers which conditions were announced in this window. */
export class NoticeGate {
  private readonly keys = new Set<string>();

  /** True the first time a notice with this key is offered, false afterwards. */
  admit(notice: Notice): boolean {
    if (this.keys.has(notice.key)) {
      return false;
    }
    this.keys.add(notice.key);
    return true;
  }
}

// -------------------------------------------------------------------------------------------
// The VS Code side
// -------------------------------------------------------------------------------------------

export type NotificationApi = Pick<typeof vscode, 'window' | 'commands'>;

export interface ToolchainNotifications extends IDisposable {
  /** Every notice shown in this window, in order (read by the integration tests). */
  readonly shown: readonly Notice[];
}

/** Shows each notice of the current snapshot that was not shown before in this window. */
export function registerToolchainNotifications(
  api: NotificationApi,
  toolchain: ToolchainService,
  log: Log,
): ToolchainNotifications {
  const store = new DisposableStore();
  const gate = new NoticeGate();
  const shown: Notice[] = [];

  const show = (notice: Notice): void => {
    shown.push(notice);
    log.warn(notice.message);
    // Not awaited: the promise settles only when the user clicks or dismisses the warning.
    void api.window.showWarningMessage(notice.message, ...notice.actions.map((a) => a.label)).then((label) => {
      const action = notice.actions.find((a) => a.label === label);
      if (action !== undefined && !store.isDisposed) {
        void api.commands.executeCommand(action.command, ...action.args);
      }
    });
  };

  // Called for every change, scanning flips included; the gate makes repeats of a snapshot silent.
  const onChange = (): void => {
    const snapshot = toolchain.current;
    if (snapshot === undefined) {
      return;
    }
    for (const notice of noticesFor(snapshot)) {
      if (gate.admit(notice)) {
        show(notice);
      }
    }
  };
  store.add(toolchain.onDidChange(onChange));
  onChange();
  return { shown, dispose: () => store.dispose() };
}
