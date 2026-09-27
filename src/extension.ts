/**
 * Extension entry point (`src/extension.ts` in docs/ARCHITECTURE.md §2).
 *
 * M0 scope: the "Idris 2" log channel, the Help commands, the `idris2.isIdrisDocument` context
 * key and syntactic selection ranges. Activation is cheap by construction: no process is
 * spawned and no file is read here. The Config → Toolchain → ProjectIndex → BackendRegistry →
 * features chain that ARCHITECTURE §2 describes for activate() is added milestone by milestone
 * (docs/ROADMAP.md).
 */
import * as vscode from 'vscode';
import { DisposableStore } from './core/disposable';
import { createLog } from './core/log';
import { registerHelpCommands } from './features/help/commands';
import { registerSelectionRanges } from './features/syntax/selectionRanges';
import { trackIsIdrisDocumentContext } from './project/literate';

let store: DisposableStore | undefined;

export function activate(context: vscode.ExtensionContext): void {
  store = new DisposableStore();
  context.subscriptions.push(store);

  const log = store.add(createLog());
  store.add(registerHelpCommands(log, context.extension.id));
  store.add(
    trackIsIdrisDocumentContext({
      activeDocument: () => vscode.window.activeTextEditor?.document,
      onDidChangeActiveDocument: (listener) => {
        const events = new DisposableStore();
        events.add(vscode.window.onDidChangeActiveTextEditor(listener));
        events.add(vscode.workspace.onDidOpenTextDocument(listener));
        return events;
      },
      setContext: (key, value) => {
        void vscode.commands.executeCommand('setContext', key, value);
      },
    }),
  );
  store.add(registerSelectionRanges());

  const { version } = context.extension.packageJSON as { version?: string };
  log.info(`vscode-idris2 ${version ?? '(unknown version)'} activated`);
}

export function deactivate(): void {
  store?.dispose();
  store = undefined;
}
