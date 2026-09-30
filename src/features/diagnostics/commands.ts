/**
 * The backend commands of M2 (ROADMAP M2 outcome): **Idris 2: Check File**, **Restart Backend**
 * and **Stop Backend** (the root of the active document, or every root, picked in a QuickPick),
 * and the notices of a crashed or given-up process, each offering **Show Output** and
 * **Restart** — except while the toolchain has no working `idris2`, which M1's one-time notice
 * reports (a session restarted then fails for that reason). A crash is noticed once per root
 * until its session answers a request again, so that a file that crashes the compiler at every
 * load gives one warning and, at the give-up, one error, not a notice per save; the later
 * crashes go to the log and the status item. **Check File** in a folder the
 * compiler may not start in says so, with **Allow…** (ARCHITECTURE §3.1: an `Unsupported` result
 * becomes a sentence, never a silent no-op).
 *
 * The commands act on a `BackendControl`, which `extension.ts` supplies from the IDE-mode backend
 * (`backend/ide/backend.ts` `IdeMode`): features see the backends only through the registry and
 * such interfaces (ARCHITECTURE §2 naming rules). Stop Backend is the escape hatch for a compiler
 * that pegs a CPU or before a `pack build` that must not share the build directory; it also drops
 * the checks still waiting for a background slot (`DocumentChecks.cancelWaiting`), and the next
 * check starts the process again (ARCHITECTURE §5.1).
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Event } from '../../core/event';
import type { Log } from '../../core/log';
import { plainText } from '../../core/notificationText';
import type { WorkspaceTrust } from '../../core/trust';
import { editorLabel } from '../../core/untrustedText';
import { isIdrisDocument } from '../../project/literate';
import type { Classification, ProjectIndex } from '../../project/types';
import type { ToolchainService } from '../../toolchain/types';
import { ALLOW_FOLDER_COMMAND } from '../consent/gate';
import { isCheckable, type DocumentChecks } from './checks';

export const CHECK_FILE_COMMAND = 'idris2.checkFile';
export const RESTART_BACKEND_COMMAND = 'idris2.restartBackend';
export const STOP_BACKEND_COMMAND = 'idris2.stopBackend';
const SHOW_OUTPUT_COMMAND = 'idris2.showOutput';

/** What the commands need of a backend (`IdeMode` provides it). */
export interface BackendControl {
  /** Roots with a process running or starting. */
  activeRoots(): readonly Classification[];
  stop(root?: Classification): void;
  restart(root?: Classification): void;
  /** `repeated`: a crash of a root that has not answered a request since its previous crash notice. */
  readonly onDidFail: Event<{ readonly root: Classification; readonly gaveUp: boolean; readonly detail: string; readonly repeated: boolean }>;
}

export type CommandsApi = Pick<typeof vscode, 'window' | 'commands'>;

export interface BackendCommandsDeps {
  readonly checks: Pick<DocumentChecks, 'check' | 'recheckVisible' | 'cancelWaiting'>;
  readonly control: BackendControl;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  /** A failure while no `idris2` is `probed` is the toolchain's, which M1's notices report. */
  readonly toolchain: Pick<ToolchainService, 'current'>;
  readonly trust: WorkspaceTrust;
  readonly log: Log;
}

/** A notice shown about a backend process, recorded for the test API. */
export interface BackendNotice {
  readonly kind: 'crashed' | 'gaveUp';
  readonly message: string;
  readonly actions: readonly string[];
}

export interface BackendCommands extends IDisposable {
  /** The notices shown in this window, in order. */
  readonly notices: readonly BackendNotice[];
}

/** `current`: the active document's root; `all`: every root. */
type Scope = 'current' | 'all';

const RESTRICTED = 'Idris 2: nothing is run in Restricted Mode. Trust the workspace to check files.';
const ALLOW = 'Allow…';

export function registerBackendCommands(api: CommandsApi, deps: BackendCommandsDeps): BackendCommands {
  const store = new DisposableStore();
  const notices: BackendNotice[] = [];

  const activeRoot = async (): Promise<Classification | undefined> => {
    const doc = api.window.activeTextEditor?.document;
    return doc !== undefined && isCheckable(doc) ? deps.projects.classify(doc.fileName) : undefined;
  };

  /**
   * What a command acts on: `{ root }` for the active document's root, `{ root: undefined }` for
   * every root, `undefined` for nothing (the QuickPick was dismissed, or `current` was asked for
   * without an active Idris file). Without a scope argument it asks.
   */
  const target = async (verb: string, scope: unknown): Promise<{ root: Classification | undefined } | undefined> => {
    const root = await activeRoot();
    if (scope === 'all') {
      return { root: undefined };
    }
    if (scope === 'current') {
      if (root === undefined) {
        await api.window.showInformationMessage(plainText(`Idris 2: ${verb} needs an active Idris file for "this project".`));
        return undefined;
      }
      return { root };
    }
    const items: (vscode.QuickPickItem & { scope: Scope })[] = [];
    if (root !== undefined) {
      items.push({ label: 'This project', description: root.kind === 'project' ? root.ipkgPath : root.dir, scope: 'current' });
    }
    items.push({ label: 'All projects', description: `${deps.control.activeRoots().length} running`, scope: 'all' });
    const picked = await api.window.showQuickPick(items, { title: `Idris 2: ${verb}` });
    return picked === undefined ? undefined : { root: picked.scope === 'current' ? root : undefined };
  };

  store.add(
    api.commands.registerCommand(CHECK_FILE_COMMAND, async () => {
      const doc = api.window.activeTextEditor?.document;
      if (!deps.trust.isTrusted) {
        await api.window.showInformationMessage(plainText(RESTRICTED));
        return;
      }
      if (doc === undefined || !isIdrisDocument(doc)) {
        await api.window.showInformationMessage(plainText('Idris 2: open an Idris file to check it.'));
        return;
      }
      if (!isCheckable(doc)) {
        await api.window.showInformationMessage(plainText('Idris 2: save the file first; the compiler checks the file on disk.'));
        return;
      }
      const refusal = await deps.checks.check(doc);
      if (refusal !== undefined) {
        // Not awaited: the command ends when the check does, not when the message is closed.
        const dir = refusal.dir;
        const shown =
          dir === undefined
            ? api.window.showInformationMessage(plainText(refusal.message))
            : api.window.showInformationMessage(plainText(refusal.message), ALLOW);
        void Promise.resolve(shown).then(async (action) => {
          if (action === ALLOW && dir !== undefined) {
            await api.commands.executeCommand(ALLOW_FOLDER_COMMAND, dir);
          }
        });
      }
    }),
  );

  store.add(
    api.commands.registerCommand(STOP_BACKEND_COMMAND, async (scope: unknown) => {
      const picked = await target('Stop Backend', scope);
      if (picked !== undefined) {
        // First the checks still waiting to load (idris2.ideMode.maxBackgroundChecks), so that none
        // takes the slot the stop frees and starts the compiler again (checks.ts `cancelWaiting`).
        deps.checks.cancelWaiting(picked.root);
        deps.control.stop(picked.root);
        deps.log.info(`Stop Backend: ${picked.root === undefined ? 'every root' : picked.root.dir}`);
      }
    }),
  );

  const restart = async (root: Classification | undefined): Promise<void> => {
    deps.control.restart(root);
    deps.log.info(`Restart Backend: ${root === undefined ? 'every root' : root.dir}`);
    await deps.checks.recheckVisible(root);
  };

  store.add(
    api.commands.registerCommand(RESTART_BACKEND_COMMAND, async (scope: unknown) => {
      if (!deps.trust.isTrusted) {
        await api.window.showInformationMessage(plainText(RESTRICTED));
        return;
      }
      const picked = await target('Restart Backend', scope);
      if (picked !== undefined) {
        await restart(picked.root);
      }
    }),
  );

  store.add(
    deps.control.onDidFail(({ root, gaveUp, detail, repeated }) => {
      if (deps.toolchain.current?.idris2.status !== 'probed') {
        // No compiler to start (a missing or broken idris2): the toolchain notice says so, once.
        deps.log.info(`Not shown as a notice (no working idris2): ${detail}`);
        return;
      }
      const where = root.kind === 'project' ? root.ipkgPath : root.dir;
      if (!gaveUp && repeated) {
        deps.log.info(`Not shown as a notice again (the compiler for ${where} has answered no request since the last one): ${detail}`);
        return;
      }
      // One line with its control and format characters written out (`editorLabel`): the detail
      // may quote what the process sent (a protocol error's excerpt, F5), and so the user's source
      // (fourth review of M3: a bidirectional control reached the notice raw).
      const notice: BackendNotice = gaveUp
        ? {
            kind: 'gaveUp',
            message: editorLabel(`Idris 2: the compiler for ${where} was given up: ${detail}. Restart it to try again.`),
            actions: ['Show Output', 'Restart'],
          }
        : {
            kind: 'crashed',
            message: editorLabel(`Idris 2: the compiler for ${where} stopped unexpectedly (${detail}); it is being restarted.`),
            actions: ['Show Output', 'Restart'],
          };
      notices.push(notice);
      const shown = gaveUp
        ? api.window.showErrorMessage(plainText(notice.message), ...notice.actions)
        : api.window.showWarningMessage(plainText(notice.message), ...notice.actions);
      void Promise.resolve(shown).then(async (action) => {
        if (action === 'Show Output') {
          await api.commands.executeCommand(SHOW_OUTPUT_COMMAND);
        } else if (action === 'Restart') {
          await restart(root);
        }
      });
    }),
  );

  return { notices, dispose: () => store.dispose() };
}
