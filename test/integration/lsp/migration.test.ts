// Suite `lsp` (.vscode-test.mjs; ROADMAP §5 M5, acceptance; F36): the settings of bamboo's extension
// (`idris2-lsp.*`) trigger the offer to copy them, and **Copy Settings** puts `idris2-lsp.loglevel`
// into `idris2.lsp.logSeverity` — which the running server is then sent. VS Code writes no value of a
// setting that no installed extension contributes (`WorkspaceConfiguration.update` refuses it), so the
// test edits the user settings file itself, opened with **Preferences: Open User Settings (JSON)**.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { answerMessages, extensionApi, settledScan, setToolchainSetting, setUserSetting, waitFor } from '../support';
import { FakeLspLogs, opened, showDocument, source, useLogs } from './support';

/** Changes the user settings file (JSON, as .vscode-test.mjs and VS Code write it) through its editor, and saves it. */
async function editUserSettings(change: (settings: Record<string, unknown>) => void): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettingsJson');
  const editor = await waitFor('the user settings file in the active editor', () => {
    const active = vscode.window.activeTextEditor;
    const file = active?.document.fileName ?? '';
    return path.basename(file) === 'settings.json' && path.basename(path.dirname(file)) === 'User' ? active : undefined;
  });
  const doc = editor.document;
  const settings = JSON.parse(doc.getText()) as Record<string, unknown>;
  change(settings);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), `${JSON.stringify(settings, null, 2)}\n`);
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(await doc.save(), 'the user settings were not saved');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

const BAMBOO = ['idris2-lsp.loglevel', 'idris2-lsp.showImplicits', 'idris2-lsp.trace.server'];

suite('M5 migration of bamboo\'s idris2-lsp settings (fake idris2-lsp)', () => {
  let api: TestApi;
  let logs: FakeLspLogs;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLspLogs();
    await useLogs(api, logs);
    const clean = source('Clean.idr');
    await showDocument(clean);
    await opened(logs, clean);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('idris2-lsp.* settings: the offer to copy them; Copy Settings puts idris2-lsp.loglevel into idris2.lsp.logSeverity, and the server is sent it', async () => {
    const shown = answerMessages((_message, titles) => (titles.includes('Copy Settings') ? 'Copy Settings' : undefined));
    const lsp = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('idris2.lsp');
    try {
      const before = api.routingNotices.length;
      const from = logs.messages().length;
      await editUserSettings((settings) => {
        settings['idris2-lsp.loglevel'] = 'warning';
        settings['idris2-lsp.showImplicits'] = true;
        settings['idris2-lsp.trace.server'] = 'off';
      });
      const offer = await waitFor(() => `the offer (notices: ${JSON.stringify(api.routingNotices.slice(before))})`, () =>
        api.routingNotices.slice(before).find((n) => n.kind === 'migration' && n.actions.length > 0),
      );
      assert.match(offer.message, /idris2-lsp\.loglevel/);
      assert.deepStrictEqual(offer.actions, ['Copy Settings', 'Not Now', "Don't Ask Again"]);
      // The copy writes one setting after another, then says what it copied (a notice without actions).
      const copied = await waitFor(() => `the copy's report (notices: ${JSON.stringify(api.routingNotices.slice(before))})`, () =>
        api.routingNotices.slice(before).find((n) => n.kind === 'migration' && n.actions.length === 0),
      );
      assert.match(copied.message, /^Idris 2: copied 2 of the idris2-lsp extension's settings/);
      assert.strictEqual(lsp().inspect('logSeverity')?.globalValue, 'warning');
      assert.strictEqual(lsp().inspect('showImplicits')?.globalValue, true);
      // bamboo's `off` has no counterpart here (package.json: messages, verbose), so it is not copied.
      assert.strictEqual(lsp().inspect('trace.server')?.globalValue, undefined);
      // The running server gets the new options, flat (F20).
      await waitFor('a didChangeConfiguration with logSeverity warning', () =>
        logs.withMethod('workspace/didChangeConfiguration', from).find((m) => m.message.params?.settings?.logSeverity === 'warning'),
      );
    } finally {
      shown.restore();
      await editUserSettings((settings) => BAMBOO.forEach((key) => delete settings[key]));
      await setUserSetting('lsp', 'logSeverity', undefined);
      await setUserSetting('lsp', 'showImplicits', undefined);
    }
  });
});
