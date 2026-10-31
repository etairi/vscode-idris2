/**
 * Contracts of M7's goal panel (`features/goalPanel`, docs/ARCHITECTURE.md §9; ROADMAP §5 M7). Types
 * only; no runtime code.
 *
 * **Command.** `idris2.toggleGoalPanel` (**Toggle Goal Panel**, letter `,`, and `cmd+shift+enter` /
 * `ctrl+shift+enter`, Lean's key for its InfoView): opens the panel beside the editor without taking
 * the focus, closes it while it is visible, shows it again while it is hidden. The panel never opens
 * by itself (ROADMAP §9 Q9), and it reopens after a window reload (`deserializeWebviewPanel`).
 *
 * **What it shows** (`state.ts`, `src/webview/protocol.ts`): the hole at the cursor, with its premises
 * and goal, from the `HoleModel`; the holes of every checked file; the file's messages; whether the
 * text changed since the compiler read it, with Save.
 *
 * **What it follows.** The active editor's Idris document and cursor, `idris2.goalPanel.debounce` ms
 * after the cursor stops. While a webview has the focus `window.activeTextEditor` is `undefined`, so the
 * panel keeps the last Idris editor and goes on following its document and cursor (`host.ts`).
 * `idris2.goalPanel.followCursor` off keeps the panel on that place; **Pin** keeps the hole shown,
 * wherever the cursor goes, for as long as the model has it.
 *
 * **Actions.** Every button runs an M4 command through `EditingRegistration.run` with explicit
 * arguments, so that the panel never edits by itself and the commands' rules hold (the name at the
 * place must still be the one offered, a save before, one command at a time per document); only the
 * webview's choices of Intro and Refine and its expression of Refine replace their QuickPick and input
 * box (`ChoiceAsker`, `EditingCommandArgs.hint`). The toggles write the settings of the backend
 * serving the file: IDE mode's `idris2.ideMode.showImplicits`, `showMachineNames`, `fullNamespace`
 * (`core/config.ts` `DisplayOptions`), idris2-lsp's `idris2.lsp.*`.
 *
 * **Messages from the webview are not trusted**: they are checked (`host.ts` `isFromWebview`) and name
 * rows and premises of the state, never a document or a position.
 */
import type { BackendRegistry } from '../../backend/registry';
import type { Config } from '../../core/config';
import type { IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import type { WorkspaceTrust } from '../../core/trust';
import type { ProjectIndex } from '../../project/types';
import type { FromWebview, PanelState } from '../../webview/protocol';
import type { CheckStatusSource, Timers } from '../diagnostics/checks';
import type { EditingRegistration } from '../editing/types';
import type { Holes } from '../holes/register';
import type { HoleModel } from '../holes/types';

/** What `registerGoalPanel` needs; `extension.ts` supplies the real ones. */
export interface GoalPanelDeps {
  /** `context.extensionUri`: the script and the stylesheet are below it. */
  readonly extensionUri: import('vscode').Uri;
  readonly model: HoleModel;
  readonly holes: Pick<Holes, 'reveal'>;
  readonly editing: Pick<EditingRegistration, 'run' | 'cycleOf' | 'onDidChangeCycle' | 'pickChoice'>;
  /** `statusOf`: whether the text is stale. */
  readonly checks: CheckStatusSource;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  /** `backendFor`: its kind and capabilities. */
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  readonly config: Pick<Config, 'goalPanel' | 'ideMode' | 'lsp' | 'onDidChange'>;
  readonly trust: WorkspaceTrust;
  readonly log: Log;
  readonly timers: Timers;
}

/** What `registerGoalPanel` returns. */
export interface GoalPanelRegistration extends IDisposable {
  readonly panel: GoalPanelView;
}

/** The panel as the tests see it: a webview's page cannot be read from the extension. */
export interface GoalPanelView {
  /** Whether a panel exists, visible or not. */
  readonly isOpen: boolean;
  /** The last state sent. */
  state(): PanelState | undefined;
  /** The last `rendered` message: the version drawn and the text it shows. */
  rendered(): Extract<FromWebview, { type: 'rendered' }> | undefined;
  /** Handles `message` as the webview's. */
  receive(message: unknown): Promise<void>;
}
