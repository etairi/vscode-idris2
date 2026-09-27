/**
 * The Help command group (ROADMAP M0), which needs no backend: **Idris 2: Show Output**,
 * **Idris 2: Open Settings** and **Idris 2: Open Idris 2 Documentation**. Opening the
 * documentation is user-initiated and only hands a static URL to the system browser
 * (principle 8, D19).
 */
import * as vscode from 'vscode';
import { DisposableStore } from '../../core/disposable';

/** Verified to answer HTTP 200 on 2026-09-26. */
const DOCUMENTATION_URL = 'https://idris2.readthedocs.io/en/latest/';

export function registerHelpCommands(log: { show(): void }, extensionId: string): vscode.Disposable {
  const store = new DisposableStore();
  store.add(vscode.commands.registerCommand('idris2.showOutput', () => log.show()));
  store.add(
    vscode.commands.registerCommand('idris2.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`),
    ),
  );
  store.add(
    vscode.commands.registerCommand('idris2.openDocumentation', () =>
      vscode.env.openExternal(vscode.Uri.parse(DOCUMENTATION_URL)),
    ),
  );
  return store;
}
