// E2E (ROADMAP M8 acceptance): the REPL in a real terminal with the real idris2, and the `-- >>>`
// lenses. Nothing can read a terminal's screen, so the REPL shows what it did by a file: the module
// below writes one when `:exec main` runs it, which proves that the compiler started in the project,
// on the file, read what was typed, and reloaded after a save. With `rlwrap` on PATH (macOS CI) the
// terminal runs through it, and this is what tests it.
//
// One compiler process at a time (CLAUDE.md): `idris2.checking.trigger` is manual and inlay hints are
// off, so that no check session starts; the lenses' `eval` session starts after the REPL ended.
// So ROADMAP's "the check session answers while the REPL runs" is not here: docs/checklists/M8.md.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import { copyWorkspace, ideProcesses } from './ideDriver';
import { extensionApi, quiesce, waitFor } from './helpers';

const MODULE = `module Foo.Run

import Foo.B
import System.File

value : String
value = greeting

main : IO ()
main = do
  Right () <- writeFile "repl-out.txt" value
    | Left err => putStrLn (show err)
  pure ()

-- :exec main

-- >>> 1 + 1
-- >>> value
-- >>> :t value
`;

/** Answers the consent question for `dir` with Allow (this window) whenever it is asked, until `stop()`. */
function allowWhenAsked(api: TestApi, dir: string): { stop(): void } {
  const timer = setInterval(() => {
    if (api.consent.openQuestions().includes(dir)) {
      api.consent.respond(dir, 'allow');
    }
  }, 50);
  return { stop: () => clearInterval(timer) };
}

/** The compiler processes of this machine, from `ps`: Chez running the compiler, whatever started it (not a shell whose text names it). */
function compilers(): number {
  return execFileSync('/bin/ps', ['-A', '-o', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => /^\S*(chez|scheme)\S*\s.*idris2_app\/idris2\.so/.test(line)).length;
}

suite('E2E: the REPL terminal and the -- >>> lenses (ROADMAP M8)', function () {
  this.timeout(180000);
  let api: TestApi;
  let copy: { dir: string; root: string };
  let allow: { stop(): void };
  let file: string;
  let doc: vscode.TextDocument;
  let editor: vscode.TextEditor;
  let inlayHints: string | undefined;
  let trigger: string | undefined;

  const marker = (): string => path.join(copy.root, 'repl-out.txt');
  const written = (text: string): Promise<true> =>
    waitFor(`repl-out.txt to read ${text}`, () => (fs.existsSync(marker()) && fs.readFileSync(marker(), 'utf8') === text ? true : undefined), 120000);
  const lineOf = (text: string): number => doc.getText().split('\n').findIndex((line) => line === text);
  const terminal = (): Promise<vscode.Terminal> => waitFor('the REPL terminal', () => vscode.window.terminals.find((t) => t.name.startsWith('Idris 2 REPL')));

  suiteSetup(async function () {
    this.timeout(90000);
    api = await extensionApi();
    await quiesce(api);
    copy = copyWorkspace('simple-ipkg');
    allow = allowWhenAsked(api, copy.root);
    const settings = vscode.workspace.getConfiguration();
    inlayHints = settings.inspect<string>('editor.inlayHints.enabled')?.globalValue;
    trigger = settings.inspect<string>('idris2.checking.trigger')?.globalValue;
    await settings.update('editor.inlayHints.enabled', 'off', vscode.ConfigurationTarget.Global);
    await settings.update('idris2.checking.trigger', 'manual', vscode.ConfigurationTarget.Global);
    file = path.join(copy.root, 'src', 'Foo', 'Run.idr');
    fs.writeFileSync(file, MODULE);
    doc = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  });

  suiteTeardown(async function () {
    this.timeout(60000);
    allow.stop();
    vscode.window.terminals.filter((t) => t.name.startsWith('Idris 2 REPL')).forEach((t) => t.dispose());
    const settings = vscode.workspace.getConfiguration();
    await settings.update('editor.inlayHints.enabled', inlayHints, vscode.ConfigurationTarget.Global);
    await settings.update('idris2.checking.trigger', trigger, vscode.ConfigurationTarget.Global);
    await settings.update('idris2.repl.reloadOnSave', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    api.sessions.stop();
    await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
    fs.rmSync(copy.dir, { recursive: true, force: true });
  });

  test('Open REPL: the compiler starts on the file, with its package, and runs what is typed', async () => {
    // The package's model is read once, by a short --dump-ipkg-json; a check session would stay.
    await waitFor('no compiler before the REPL', () => (compilers() === 0 ? true : undefined));
    await vscode.commands.executeCommand('idris2.openRepl');
    const repl = await terminal();
    const launch = api.repl.launches.at(-1);
    assert.deepStrictEqual(launch?.args.slice(-2), ['--find-ipkg', 'src/Foo/Run.idr']);
    console.log(`      started: ${launch?.executable} ${launch?.args.join(' ')}`);
    repl.sendText(':exec main', true);
    await written('hello!');
    assert.strictEqual(compilers(), 1);
    assert.strictEqual(await api.repl.terminalOf(doc), repl);
  });

  test('with reload on save, a save is reloaded before what is typed next', async () => {
    await vscode.workspace.getConfiguration('idris2').update('repl.reloadOnSave', true, vscode.ConfigurationTarget.Global);
    const line = lineOf('value = greeting');
    await editor.edit((builder) => builder.replace(doc.lineAt(line).range, 'value = "changed"'));
    await doc.save();
    (await terminal()).sendText(':exec main', true);
    await written('changed');
    assert.deepStrictEqual(api.repl.typed.at(-1), ':r');
  });

  test('Send to REPL types the selection: here, a command from a comment', async () => {
    fs.rmSync(marker());
    const line = lineOf('-- :exec main');
    editor.selection = new vscode.Selection(line, 3, line, 13);
    await vscode.commands.executeCommand('idris2.sendToRepl');
    assert.deepStrictEqual(api.repl.typed.at(-1), ':exec main');
    await written('changed');
  });

  test(':q ends it, and the terminal closes', async () => {
    const repl = await terminal();
    const closed = new Promise<void>((resolve) => {
      const listener = vscode.window.onDidCloseTerminal((t) => {
        if (t === repl) {
          listener.dispose();
          resolve();
        }
      });
    });
    repl.sendText(':q', true);
    await closed;
    await waitFor('the compiler to end', () => (compilers() === 0 ? true : undefined));
    assert.strictEqual(await api.repl.terminalOf(doc), undefined);
  });

  test('a lens writes the answer beneath its line; Run all, once accepted, the others in one edit', async () => {
    await vscode.commands.executeCommand('idris2.runDocEval', { uri: doc.uri.toString(), line: lineOf('-- >>> 1 + 1') });
    assert.strictEqual(doc.lineAt(lineOf('-- >>> 1 + 1') + 1).text, '-- 1 + 1 = 2');
    const original = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (_text: string, ...items: string[]) => Promise.resolve(items[0]);
    try {
      await vscode.commands.executeCommand('idris2.runAllDocEval');
    } finally {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
    }
    assert.strictEqual(doc.lineAt(lineOf('-- >>> value') + 1).text, '-- value = "changed"');
    assert.strictEqual(doc.lineAt(lineOf('-- >>> :t value') + 1).text, '-- :t value = Foo.Run.value : String');
    assert.strictEqual(doc.lineAt(lineOf('-- >>> 1 + 1') + 2).text, '-- >>> value', 'its answer replaced, not doubled');
    assert.ok(compilers() <= 1);
  });
});
