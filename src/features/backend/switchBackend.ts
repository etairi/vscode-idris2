/**
 * **Idris 2: Switch Backend…** (ROADMAP M5; the user's decision of 2026-10-01 on ROADMAP §9 Q7):
 * chooses which backend serves the project of the active Idris file, IDE mode or idris2-lsp, and
 * remembers the choice for the workspace (`backend/registry.ts` `BackendChoices`); the choice comes
 * before `idris2.backend.mode`. The QuickPick lists the backends usable for the root
 * (`switchOptions`): IDE mode when the last scan ran `idris2 --version`; idris2-lsp when it ran
 * `idris2-lsp --version` and the root has an `.ipkg` (the server loads nothing else, F20), with the
 * pair verdict's warning when it is `likelyMismatch` (an explicit choice does not need a matching
 * pair, `registry.ts` *Routing*); and **Follow the Setting** while a choice is remembered. When
 * nothing else can be chosen, a notification says why instead (no silent no-op, ARCHITECTURE
 * §3.1). What a switch does to the processes (IDE mode's sessions of the root stopped, its visible
 * documents checked again, the language client's documents) follows from the routing's change
 * (`follow.ts`, `backend/lsp/`).
 *
 * The item texts quote paths and versions and go through `quickPickText`; the notifications are
 * `plainText` (M2, M3 rules).
 *
 * Only type imports from `vscode`: the options (`switchOptions`) are unit-tested on plain Node.
 */
import type * as vscode from 'vscode';
import { NO_IPKG_REASON, type BackendChoice, type BackendChoices, type BackendRegistry, type Route } from '../../backend/registry';
import type { BackendMode } from '../../core/config';
import type { IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import { plainText } from '../../core/notificationText';
import type { WorkspaceTrust } from '../../core/trust';
import { quickPickText } from '../../core/untrustedText';
import { isIdrisDocument } from '../../project/literate';
import type { Classification, ProjectIndex } from '../../project/types';
import type { ToolchainService, ToolchainSnapshot } from '../../toolchain/types';

export const SWITCH_BACKEND_COMMAND = 'idris2.switchBackend';

/** One QuickPick item: a backend to choose, or `undefined` to follow the setting again. */
export interface SwitchOption {
  readonly label: string;
  readonly description: string;
  readonly choice: BackendChoice | undefined;
}

export interface SwitchOptions {
  /** What can be chosen, the backend serving the root now marked in its description. */
  readonly options: readonly SwitchOption[];
  /** Why a backend is not offered, one sentence each. */
  readonly notOffered: readonly string[];
  /** Whether choosing could change anything: some option is not the root's current state. */
  readonly anyChange: boolean;
}

const BACKEND_NAMES: Readonly<Record<BackendChoice, string>> = { ideMode: 'IDE mode', lsp: 'idris2-lsp' };

/** The QuickPick of the module comment, for `root` routed to `route`, with its remembered `choice`. */
export function switchOptions(
  root: Classification,
  route: Route,
  choice: BackendChoice | undefined,
  mode: BackendMode,
  snapshot: ToolchainSnapshot | undefined,
): SwitchOptions {
  const options: SwitchOption[] = [];
  const notOffered: string[] = [];
  const current = (kind: BackendChoice): string => (route.kind === kind ? 'serves this project now; ' : '');
  const idris2 = snapshot?.idris2;
  if (idris2?.status === 'probed') {
    options.push({
      label: BACKEND_NAMES.ideMode,
      description: `${current('ideMode')}idris2 ${idris2.info.version?.text ?? idris2.info.versionLine} at ${idris2.location.path}`,
      choice: 'ideMode',
    });
  } else {
    notOffered.push(`IDE mode needs idris2, ${idris2 === undefined ? 'which the toolchain scan has not found yet' : idris2.status === 'missing' || idris2.status === 'failed' ? `which is not usable: ${idris2.reason}` : 'which was not run (Restricted Mode)'}`);
  }
  const lsp = snapshot?.lsp;
  if (root.kind !== 'project') {
    notOffered.push(`idris2-lsp is not offered: ${NO_IPKG_REASON}`);
  } else if (lsp?.status === 'probed') {
    const mismatch = snapshot?.verdict?.kind === 'likelyMismatch' ? ` — likely mismatch: ${snapshot.verdict.reason}` : '';
    options.push({
      label: BACKEND_NAMES.lsp,
      description: `${current('lsp')}Idris 2 API ${lsp.info.apiVersion?.text ?? lsp.info.apiVersionLine} at ${lsp.location.path}${mismatch}`,
      choice: 'lsp',
    });
  } else {
    notOffered.push(`idris2-lsp needs a server, ${lsp === undefined ? 'which the toolchain scan has not found yet' : lsp.status === 'missing' || lsp.status === 'failed' ? `which is not usable: ${lsp.reason}` : 'which was not run (Restricted Mode)'}`);
  }
  if (choice !== undefined) {
    options.push({ label: 'Follow the Setting', description: `forget this project's choice; idris2.backend.mode is "${mode}"`, choice: undefined });
  }
  const anyChange = choice !== undefined || options.some((o) => o.choice !== undefined && o.choice !== route.kind);
  return { options, notOffered, anyChange };
}

// -------------------------------------------------------------------------------------------
// The VS Code side
// -------------------------------------------------------------------------------------------

export type SwitchApi = Pick<typeof vscode, 'window' | 'commands'>;

export interface SwitchDeps {
  readonly trust: WorkspaceTrust;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  readonly registry: Pick<BackendRegistry, 'routeFor'>;
  readonly choices: Pick<BackendChoices, 'get' | 'set'>;
  /** `idris2.backend.mode` for the root's folder. */
  modeFor(root: Classification): BackendMode;
  readonly toolchain: Pick<ToolchainService, 'current'>;
  readonly log: Log;
}

export function registerSwitchBackend(api: SwitchApi, deps: SwitchDeps): IDisposable {
  const run = async (): Promise<void> => {
    if (!deps.trust.isTrusted) {
      await api.window.showInformationMessage(plainText('Idris 2: no backend runs in Restricted Mode. Trust the workspace to choose one.'));
      return;
    }
    const doc = api.window.activeTextEditor?.document;
    if (doc === undefined || doc.uri.scheme !== 'file' || !isIdrisDocument(doc)) {
      await api.window.showInformationMessage(plainText('Idris 2: Switch Backend needs an active Idris file: it chooses for the project of that file.'));
      return;
    }
    const root = await deps.projects.classify(doc.fileName);
    const route = deps.registry.routeFor(root);
    const choice = deps.choices.get(root);
    const { options, notOffered, anyChange } = switchOptions(root, route, choice, deps.modeFor(root), deps.toolchain.current);
    if (!anyChange) {
      const serving = route.kind === 'none' ? 'nothing can serve this file' : `${BACKEND_NAMES[route.kind]} serves this project`;
      await api.window.showInformationMessage(plainText(`Idris 2: ${serving}, and there is no other backend to choose: ${notOffered.join('; ')}.`));
      return;
    }
    const picked = await api.window.showQuickPick(
      options.map((o) => ({ label: o.label, description: quickPickText(o.description), option: o })),
      { title: 'Idris 2: Switch Backend', placeHolder: 'The backend for the project of the active file, remembered for this workspace' },
    );
    if (picked === undefined) {
      return;
    }
    await deps.choices.set(root, picked.option.choice);
    deps.log.info(
      `Switch Backend: ${root.kind === 'project' ? root.ipkgPath : root.dir} → ${picked.option.choice === undefined ? 'the setting' : BACKEND_NAMES[picked.option.choice]}`,
    );
  };
  return api.commands.registerCommand(SWITCH_BACKEND_COMMAND, async () => {
    try {
      await run();
    } catch (error) {
      // A rejected command's message would be shown with its links working (M2 rule).
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn(`Switch Backend failed: ${message}`);
      await api.window.showWarningMessage(plainText(`Idris 2: Switch Backend failed: ${message}`));
    }
  });
}
