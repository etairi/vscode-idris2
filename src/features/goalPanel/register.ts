/**
 * `registerGoalPanel` (`types.ts`): the panel's host, its command and the restoring of a panel after a
 * window reload. Registering starts nothing: no panel, no subscription, until the command runs or VS
 * Code restores one. Only type imports from `vscode`: `extension.ts` passes the namespace as `api`.
 */
import type * as vscode from 'vscode';
import { DisposableStore } from '../../core/disposable';
import { GOAL_PANEL_VIEW_TYPE, GoalPanelHost, type GoalPanelApi } from './host';
import type { GoalPanelDeps, GoalPanelRegistration } from './types';

export const TOGGLE_GOAL_PANEL_COMMAND = 'idris2.toggleGoalPanel';

export type GoalPanelRegisterApi = GoalPanelApi & {
  readonly commands: Pick<typeof vscode.commands, 'registerCommand'>;
  readonly window: GoalPanelApi['window'] & Pick<typeof vscode.window, 'registerWebviewPanelSerializer'>;
};

export function registerGoalPanel(api: GoalPanelRegisterApi, deps: GoalPanelDeps): GoalPanelRegistration {
  const store = new DisposableStore();
  const host = store.add(new GoalPanelHost(api, deps));
  store.add(api.commands.registerCommand(TOGGLE_GOAL_PANEL_COMMAND, () => host.toggle()));
  store.add(
    api.window.registerWebviewPanelSerializer(GOAL_PANEL_VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => {
        host.restore(panel);
        return Promise.resolve();
      },
    }),
  );
  return { panel: host, dispose: () => store.dispose() };
}
