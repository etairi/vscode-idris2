/**
 * The VS Code side of the consent gate (`gate.ts`): the question as a warning notification, the
 * status item's **Allow…** (`ALLOW_FOLDER_COMMAND`, not contributed: it needs a directory) and
 * **Idris 2: Manage Allowed Folders…**, which lists the folders allowed for good and revokes the
 * ones picked.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Event } from '../../core/event';
import type { Log } from '../../core/log';
import { plainText, shownPath } from '../../core/notificationText';
import type { PermitReason, WorkspaceTrust } from '../../core/trust';
import { ALLOW_FOLDER_COMMAND, ConsentGate, type ConsentChoice, type ConsentRecord } from './gate';

export const MANAGE_ALLOWED_FOLDERS_COMMAND = 'idris2.manageAllowedFolders';
/** The global-state key of the folders allowed for good (real paths). */
export const ALLOWED_FOLDERS_KEY = 'idris2.allowedFolders';
/** The global-state key of when each folder was last allowed for good or revoked (`ConsentRecord.decided`). */
export const FOLDER_DECISIONS_KEY = 'idris2.allowedFolderDecisions';

const ALLOW = 'Allow';
const ALWAYS = 'Always Allow for This Folder';
const DENY = "Don't Allow";

export type ConsentApi = Pick<typeof vscode, 'window' | 'commands'>;

export interface ConsentDeps {
  readonly trust: WorkspaceTrust;
  folders(): readonly string[];
  readonly onDidChangeFolders: Event<void>;
  realpath(p: string): Promise<string>;
  readonly platform: NodeJS.Platform;
  /** `context.globalState`. */
  readonly globalState: vscode.Memento;
  readonly log: Log;
}

export interface Consent extends IDisposable {
  readonly gate: ConsentGate;
}

/**
 * The question's text: what is at stake first, then why the compiler would start in that folder
 * (the package file that chose it, or the loose file's own folder), then the folder. Naming the
 * `.ipkg` matters: a file with no package of its own belongs to the first `.ipkg` found above it
 * (F13), which may be one somebody else placed there. The folder's and the package file's names
 * come last and in quotes (`shownPath`): anybody who can name a folder chooses them, and a name may
 * hold `?`, line breaks and whole sentences; before the M2 verification of the third review the
 * path came first, so a folder name could add a false sentence after the question and, being long,
 * push the warning past VS Code's cut at 1,000 characters. The gate logs the whole path.
 */
export function consentQuestion(dir: string, why: PermitReason | undefined): string {
  const where =
    why === undefined
      ? 'It would start in'
      : why.ipkg === undefined
        ? 'It would start in the folder of the Idris file you opened, which belongs to no package'
        : `It would start in the folder of the package file ${shownPath(path.basename(why.ipkg))}, the first .ipkg found in the folder of the file you opened or above it`;
  return (
    'Idris 2: start the compiler in a folder outside the trusted workspace folders? Starting the compiler in a folder can run ' +
    `code placed in it; until you allow it, Idris files there get highlighting only. ${where}: ${shownPath(dir)}`
  );
}

/** The stored record; values of another shape count as none. */
function storedRecord(globalState: vscode.Memento): ConsentRecord {
  const folders: unknown = globalState.get(ALLOWED_FOLDERS_KEY);
  const decided: unknown = globalState.get(FOLDER_DECISIONS_KEY);
  return {
    folders: Array.isArray(folders) ? folders.filter((v): v is string => typeof v === 'string') : [],
    decided:
      typeof decided === 'object' && decided !== null && !Array.isArray(decided)
        ? Object.fromEntries(Object.entries(decided).filter((entry): entry is [string, number] => Number.isFinite(entry[1])))
        : {},
  };
}

export function registerConsent(api: ConsentApi, deps: ConsentDeps): Consent {
  const store = new DisposableStore();
  const gate = store.add(
    new ConsentGate({
      trust: deps.trust,
      folders: deps.folders,
      onDidChangeFolders: deps.onDidChangeFolders,
      realpath: deps.realpath,
      platform: deps.platform,
      store: {
        get: () => storedRecord(deps.globalState),
        // Both keys are written in one save of the extension's global state (`ExtensionMemento`
        // saves all its keys together), so every window reads them together.
        set: async (record) => {
          await Promise.all([
            deps.globalState.update(ALLOWED_FOLDERS_KEY, [...record.folders]),
            deps.globalState.update(FOLDER_DECISIONS_KEY, { ...record.decided }),
          ]);
        },
      },
      ask: (dir, why) =>
        api.window.showWarningMessage(plainText(consentQuestion(dir, why)), ALLOW, ALWAYS, DENY).then(
          (picked): ConsentChoice | undefined =>
            picked === ALLOW ? 'allow' : picked === ALWAYS ? 'always' : picked === DENY ? 'deny' : undefined,
        ),
      log: deps.log,
    }),
  );

  // A command that rejects has its error shown by VS Code as a notification whose `[label](command:…)`
  // text becomes a link (`core/notificationText.ts`): a failure (a write of the global state) is
  // logged and shown as text instead.
  const guarded =
    <A extends unknown[]>(what: string, run: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await run(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.warn(`Consent: ${what} failed: ${message}`);
        await api.window.showWarningMessage(plainText(`Idris 2: ${what} failed: ${message}`));
      }
    };

  store.add(
    api.commands.registerCommand(
      ALLOW_FOLDER_COMMAND,
      guarded('Allow…', async (dir: unknown) => {
        if (typeof dir === 'string') {
          await gate.askAgain(dir);
        }
      }),
    ),
  );

  // With an array of folders (real paths, as `allowedFolders` lists them) the command revokes
  // those without asking, for scripted use and the integration tests; otherwise it asks.
  store.add(
    api.commands.registerCommand(MANAGE_ALLOWED_FOLDERS_COMMAND, guarded('Manage Allowed Folders', async (revoke: unknown) => {
      if (Array.isArray(revoke)) {
        await gate.revoke(revoke.filter((f): f is string => typeof f === 'string'));
        return;
      }
      const folders = gate.allowedFolders();
      if (folders.length === 0) {
        await api.window.showInformationMessage(
          plainText('Idris 2: no folder outside the workspace is always allowed. Folders are added with "Always Allow for This Folder" when the compiler would start in one.'),
        );
        return;
      }
      const picked = await api.window.showQuickPick(
        folders.map((folder) => ({ label: folder })),
        {
          title: 'Idris 2: Folders Always Allowed',
          placeHolder: 'Select the folders to revoke; the compiler asks again before it starts in them',
          canPickMany: true,
        },
      );
      if (picked !== undefined && picked.length > 0) {
        await gate.revoke(picked.map((p) => p.label));
      }
    })),
  );

  return { gate, dispose: () => store.dispose() };
}
