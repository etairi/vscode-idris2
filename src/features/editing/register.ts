/**
 * `registerEditing` (`types.ts`, *Modules and entry points*): the editing commands
 * (`commands.ts`), the code-action provider (`codeActions.ts`) and the cycling controller
 * (`cycling.ts`) with its status-bar item. Registering sends nothing: the commands ask the backend
 * when they run, and the code actions never do.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import { DisposableStore } from '../../core/disposable';
import { idrisDocumentSelector } from '../../project/literate';
import { EDITING_ACTION_KINDS, editingActionsAt } from './codeActions';
import { EditingCommands, type EditingCommandsApi, type EditingCommandsOptions } from './commands';
import { CyclingController } from './cycling';
import { EDITING_COMMAND_KINDS } from './messages';
import type { EditCodeActionKind, EditingCommandId, EditingDeps, EditingRegistration } from './types';

/**
 * The reason every action is disabled while the project's compiler has failed (it could not start,
 * or was given up after repeated unexpected ends; Restart Backend tries again).
 */
export const BACKEND_FAILED = 'The compiler of this project has failed: run Idris 2: Restart Backend.';

/** The part of the `vscode` namespace the editing features use. */
export type EditingApi = EditingCommandsApi & Pick<typeof vscode, 'commands' | 'CodeAction' | 'CodeActionKind' | 'StatusBarAlignment'>;

export function registerEditing(api: EditingApi, deps: EditingDeps, options: EditingCommandsOptions = {}): EditingRegistration {
  const store = new DisposableStore();
  const cycles = store.add(new CyclingController(api, deps.loads, deps.checks));
  const commands = new EditingCommands(api, deps, cycles, options);
  for (const id of Object.keys(EDITING_COMMAND_KINDS) as EditingCommandId[]) {
    store.add(api.commands.registerCommand(id, (args: unknown) => commands.run(id, args)));
  }

  const kindOf = (kind: EditCodeActionKind): vscode.CodeActionKind => api.CodeActionKind.Empty.append(kind);
  store.add(
    api.languages.registerCodeActionsProvider(
      idrisDocumentSelector(),
      {
        provideCodeActions: async (doc, range, context) => {
          if (!deps.trust.isTrusted || doc.uri.scheme !== 'file') {
            return [];
          }
          const root = await deps.projects.classify(doc.fileName);
          const caps = deps.registry.backendFor(root).caps;
          const status = deps.checks.statusOf(doc, root);
          // "Don't Allow" for the folder: no compiler runs there, the file gets highlighting only.
          if (status?.kind === 'notAllowed' && status.reason === 'denied') {
            return [];
          }
          // The last check reported errors and the text is still the one it read (codeActions.ts).
          const loadFailed = (status?.kind === 'checked' || status?.kind === 'packageError') && !status.stale && (status.kind === 'packageError' || status.errors > 0);
          // The project's compiler has failed: every action is refused until Restart Backend.
          const failed = status?.kind === 'backendFailed' ? BACKEND_FAILED : undefined;
          return editingActionsAt(doc, range.start, caps, context.diagnostics, loadFailed)
            .filter((a) => context.only === undefined || context.only.contains(kindOf(a.kind)))
            .map((a) => {
              const action = new api.CodeAction(a.title, kindOf(a.kind));
              action.command = { command: a.command, title: a.title, arguments: [a.args] };
              if (a.diagnostic !== undefined) {
                action.diagnostics = [a.diagnostic];
                action.isPreferred = true;
              }
              const disabled = failed ?? a.disabled;
              if (disabled !== undefined) {
                action.disabled = { reason: disabled };
              }
              return action;
            });
        },
      },
      { providedCodeActionKinds: EDITING_ACTION_KINDS.map(kindOf) },
    ),
  );

  return {
    outcomes: commands.outcomes,
    cycleOf: (uri) => cycles.cycleOf(uri),
    statusText: () => cycles.statusText(),
    dispose: () => store.dispose(),
  };
}
