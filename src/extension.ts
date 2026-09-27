/**
 * Extension entry point (`src/extension.ts` in docs/ARCHITECTURE.md §2).
 *
 * Skeleton scope: create the "Idris 2" log channel, register `idris2.showOutput`, log the
 * activation. The Config → Toolchain → ProjectIndex → BackendRegistry → features chain that
 * ARCHITECTURE §2 describes for activate() is added milestone by milestone (docs/ROADMAP.md).
 */
import * as vscode from 'vscode';
import { DisposableStore } from './core/disposable';
import { createLog } from './core/log';

let store: DisposableStore | undefined;

export function activate(context: vscode.ExtensionContext): void {
  store = new DisposableStore();
  context.subscriptions.push(store);

  const log = store.add(createLog());
  store.add(vscode.commands.registerCommand('idris2.showOutput', () => log.show()));

  const { version } = context.extension.packageJSON as { version?: string };
  log.info(`vscode-idris2 ${version ?? '(unknown version)'} activated`);
}

export function deactivate(): void {
  store?.dispose();
  store = undefined;
}
