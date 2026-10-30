// Suite `intelligence-loose`, workspace `broken` (.vscode-test.mjs): M8's REPL and `-- >>>` lenses over
// the fake compiler, in a real VS Code. The REPL is a real terminal running the fake's REPL
// (test/fake-idris2), which logs its command line and each line typed. The lenses go through the `eval`
// session, which replays `eval-query`. The real compiler's run is test/e2e/repl.test.ts.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { answerMessages, extensionApi, FakeLogs, setToolchainSetting, settledScan, setUserSetting, showFile, waitFor, waitForAsync, workspaceFile } from '../support';

suite('M8 the REPL terminal and the -- >>> lenses (fake compiler)', () => {
  let api: TestApi;
  let logs: FakeLogs;
  let doc: vscode.TextDocument;

  const lineOf = (text: string): number => doc.getText().split('\n').findIndex((line) => line === text);
  const repls = (): vscode.Terminal[] => vscode.window.terminals.filter((t) => t.name.startsWith('Idris 2 REPL'));
  const typed = async (text: string): Promise<void> => {
    await waitForAsync(
      () => `the REPL to read ${text}`,
      () => Promise.resolve(logs.requests().some((r) => r.request === text) ? true : undefined),
    );
  };

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
    doc = await showFile('DocEval.idr');
  });

  teardown(async () => {
    if (doc.isDirty) {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  suiteTeardown(async () => {
    repls().forEach((terminal) => terminal.dispose());
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('VS Code gets the lenses: Run per line, Run all once', async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
    assert.deepStrictEqual(lenses.map((lens) => lens.command?.title).filter((title) => title?.startsWith('Run')), ['Run', 'Run all (6)', 'Run', 'Run', 'Run', 'Run', 'Run']);
    assert.strictEqual(lenses[0].range.start.line, lineOf('-- >>> double 2'));
  });

  test('Run writes the value beneath the line, and :t its answer, with the allow-list applied', async () => {
    // The next run would save the answer into the fixture: each is reverted first.
    const answerOf = async (line: string, lines: number): Promise<string[]> => {
      await vscode.commands.executeCommand('idris2.runDocEval', { uri: doc.uri.toString(), line: lineOf(line) });
      const written = Array.from({ length: lines }, (_, n) => doc.lineAt(lineOf(line) + n + 1).text);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      return written;
    };
    assert.deepStrictEqual(await answerOf('-- >>> double 2', 1), ['-- double 2 = 4']);
    assert.deepStrictEqual(await answerOf('-- >>> :t double', 1), ['-- :t double = DocEval.double : Nat -> Nat']);
    assert.deepStrictEqual(await answerOf('-- >>> :doc double', 3), ['-- :doc double = DocEval.double : Nat -> Nat', '--     Twice a number.', '--     Visibility: private']);
  });

  test('a command not on the list is refused before anything is sent: :exec main', async () => {
    const before = logs.requests().length;
    const shown = answerMessages(() => undefined);
    try {
      await vscode.commands.executeCommand('idris2.runDocEval', { uri: doc.uri.toString(), line: lineOf('-- >>> :exec main') });
    } finally {
      shown.restore();
    }
    assert.match(shown.asked[0], /of the REPL commands only :t and :doc run here/);
    assert.deepStrictEqual(logs.requests().slice(before).filter((r) => r.request.includes(':exec')), []);
    assert.strictEqual(doc.isDirty, false);
  });

  test('Run All asks first, and runs nothing when declined', async () => {
    const shown = answerMessages(() => undefined);
    const version = doc.version;
    try {
      await vscode.commands.executeCommand('idris2.runAllDocEval');
    } finally {
      shown.restore();
    }
    assert.match(shown.asked[0], /run the 6 -- >>> lines of this file\?/);
    assert.strictEqual(doc.version, version);
  });

  test('Open REPL: a terminal runs the compiler on the file, in the file\'s directory', async () => {
    await vscode.commands.executeCommand('idris2.openRepl');
    const terminal = await waitFor(
      () => 'the REPL terminal',
      () => repls()[0],
    );
    assert.strictEqual(terminal.name, 'Idris 2 REPL: broken');
    const started = await waitForAsync(
      () => 'the fake to log its command line',
      () => Promise.resolve(logs.invocations().find((i) => i.args.at(-1) === 'DocEval.idr')),
    );
    assert.strictEqual(started.cwd, workspaceFile().fsPath);
    assert.deepStrictEqual(api.repl.launches.at(-1)?.args, ['DocEval.idr']);
    assert.strictEqual(await api.repl.terminalOf(doc), terminal);
  });

  test('Send to REPL types the selection into it as one line, and :t and :doc the name at the cursor', async () => {
    const editor = await vscode.window.showTextDocument(doc);
    const line = lineOf('double n = n + n');
    editor.selection = new vscode.Selection(line, 0, line + 3, 0);
    await vscode.commands.executeCommand('idris2.sendToRepl');
    await typed('double n = n + n main : IO ()');
    editor.selection = new vscode.Selection(line, 2, line, 2);
    await vscode.commands.executeCommand('idris2.replType');
    await typed(':t double');
    await vscode.commands.executeCommand('idris2.replDocs');
    await typed(':doc double');
    assert.strictEqual(repls().length, 1);
  });

  test('reload on save types :r, only with the setting on', async () => {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!logs.requests().some((r) => r.request === ':r'));
    await setUserSetting('repl', 'reloadOnSave', true);
    try {
      await vscode.commands.executeCommand('workbench.action.files.save');
      await typed(':r');
    } finally {
      await setUserSetting('repl', 'reloadOnSave', undefined);
    }
  });

  test(':q ends the REPL, and Open REPL starts another', async () => {
    const terminal = repls()[0];
    const closed = new Promise<void>((resolve) => {
      const listener = vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) {
          listener.dispose();
          resolve();
        }
      });
    });
    terminal.sendText(':q', true);
    await closed;
    assert.strictEqual(await api.repl.terminalOf(doc), undefined);
    await vscode.commands.executeCommand('idris2.openRepl');
    await waitFor(
      () => 'a new terminal',
      () => repls()[0],
    );
    assert.strictEqual(api.repl.launches.length, 2);
  });
});
