// Suite `intelligence-loose`: **Idris 2: Evaluate Selection** on Clean.idr through the fake
// compiler, which answers an `eval` session (its build directory build/.vscode-idris2-eval) only
// from the recordings made in that role (transcripts eval-values, eval-command-forms; see
// test/fake-idris2/README.md "Which recording"). ROADMAP §5 M3 acceptance and §9 (2026-09-28):
// expressions only, in a separate `eval` session over the `check` session's transport; an IO
// action is shown as a value, not run; text the REPL parser reads as a command is refused before
// anything is sent. The fake's logs show what reached which session. The expressions are typed
// into the document as comment lines and not saved: the recordings are keyed by the saved file's
// SHA-256, and an evaluation evaluates the selected text in the context of the saved file. So the
// document has unsaved changes throughout. The backend loads the file before every evaluation
// (`backend.ts`, *Evaluation*: an imported module may have changed on disk since).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import {
  evaluateSelection,
  extensionApi,
  FakeLogs,
  hoverWith,
  loadedIn,
  setToolchainSetting,
  settledScan,
  showFile,
  workspaceFile,
} from '../support';

const root = (): string => workspaceFile().fsPath;
const clean = (): string => workspaceFile('Clean.idr').fsPath;

/** The expressions typed into Clean.idr, one per comment line after its last line. */
const EXPRESSIONS = [
  ':exec putStrLn "hi"',
  '{- c -} :t id',
  'the (Vect 2 Nat) [1, 2]',
  'the (IO ()) (putStrLn "hi")',
  'putStrLn "hi"',
] as const;

/** The request text (without the id) of an `:interpret` of `expr`, as the compiler reads it. */
const interpret = (expr: string): string => `(:interpret ${JSON.stringify(expr)})`;
const withoutId = (request: string): string => /^\((.*) [0-9]+\)\n$/s.exec(request)?.[1] ?? request;

suite('M3 Evaluate Selection: the eval session (fake compiler)', () => {
  let api: TestApi;
  let logs: FakeLogs;
  let editor: vscode.TextEditor;
  /** The first line of the typed expressions. */
  let first: number;
  /** The check processes started, and the requests they had read, before the first evaluation. */
  let checkStartsBefore: number;
  let checkRequestsBefore: number;

  /** The range of `expr` in its comment line. */
  const rangeOf = (expr: (typeof EXPRESSIONS)[number]): vscode.Range => {
    const line = first + EXPRESSIONS.indexOf(expr);
    return new vscode.Range(line, 3, line, 3 + expr.length);
  };

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
    const doc = await showFile('Clean.idr');
    await loadedIn(api, root(), clean());
    checkStartsBefore = logs.started('check').length;
    checkRequestsBefore = logs.requestsOf('check').length;
    const active = vscode.window.activeTextEditor;
    assert.ok(active?.document === doc);
    editor = active;
    first = doc.lineCount;
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    assert.ok(await editor.edit((e) => e.insert(end, EXPRESSIONS.map((x) => `\n-- ${x}`).join(''))));
    for (const expr of EXPRESSIONS) {
      assert.strictEqual(doc.getText(rangeOf(expr)), expr);
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('idris2.clearEvaluationResults');
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test(':exec putStrLn "hi" and `{- c -} :t id` are refused: no session receives them, and no eval session starts', async () => {
    const requests = logs.requests().length;
    for (const expr of [':exec putStrLn "hi"', '{- c -} :t id'] as const) {
      const shown = await evaluateSelection(api, editor, rangeOf(expr));
      assert.strictEqual(shown.kind, 'refused', JSON.stringify(shown));
      assert.strictEqual(shown.expression, expr);
    }
    // The check session may still answer VS Code's own requests (passive providers) meanwhile;
    // none of those is an evaluation, a load or anything with the refused text in it.
    const sent = logs.requests().slice(requests).map((r) => withoutId(r.request));
    assert.deepStrictEqual(sent.filter((t) => /^\(:(interpret|load-file) |exec|:t id/.test(t)), [], JSON.stringify(sent));
    assert.deepStrictEqual(logs.started('eval'), []);
    assert.ok(!api.sessions.sessions().some((s) => s.role === 'eval' && s.launch !== undefined));
  });

  test('the (Vect 2 Nat) [1, 2] shows [1, 2], from a new eval session: same directory and transport as the check session, its own build directory', async () => {
    const shown = await evaluateSelection(api, editor, rangeOf('the (Vect 2 Nat) [1, 2]'));
    assert.deepStrictEqual([shown.kind, shown.text, shown.file], ['value', '[1, 2]', clean()]);
    const [started, ...more] = logs.started('eval');
    assert.ok(started, JSON.stringify(logs.invocations()));
    assert.deepStrictEqual(more, []);
    assert.strictEqual(fs.realpathSync(started.cwd), fs.realpathSync(root()));
    assert.deepStrictEqual(started.args, ['--ide-mode', '--no-color', '--build-dir', path.join(root(), 'build', '.vscode-idris2-eval')]);
    // It loads the file itself, then evaluates.
    assert.deepStrictEqual(
      logs.requestsOf('eval').map((r) => withoutId(r.request)),
      [`(:load-file ${JSON.stringify(clean())})`, interpret('the (Vect 2 Nat) [1, 2]')],
    );
    const session = api.sessions.sessions().find((s) => s.role === 'eval' && s.cwd === root());
    assert.strictEqual(session?.launch?.transport, 'stdio');
    // Drawn after the line (the after-line decoration of ROADMAP M3), with the answer in its hover.
    const line = rangeOf('the (Vect 2 Nat) [1, 2]').start.line;
    const drawn = api.evaluationResults(editor.document.uri).filter((r) => r.range.end.line === line);
    assert.deepStrictEqual(
      drawn.map((r) => [r.kind, r.label, r.range.end.character === editor.document.lineAt(line).text.length]),
      [['value', '= [1, 2]', true]],
    );
    assert.ok(drawn[0].hover.includes('```idris2\n[1, 2]\n```'), drawn[0].hover);
  });

  test('an IO action is shown as its value, not run: the (IO ()) (putStrLn "hi") → MkIO (prim__putStr "hi\\n"); putStrLn "hi" alone → the compiler\'s HasIO error', async () => {
    const io = await evaluateSelection(api, editor, rangeOf('the (IO ()) (putStrLn "hi")'));
    assert.deepStrictEqual([io.kind, io.text], ['value', 'MkIO (prim__putStr "hi\\n")']);
    const bare = await evaluateSelection(api, editor, rangeOf('putStrLn "hi"'));
    assert.strictEqual(bare.kind, 'error');
    assert.ok(bare.text.includes("Can't find an implementation for HasIO ?io."), bare.text);
    // Only loads and expressions reached the eval session: no :exec, no :set, no REPL command;
    // each evaluation loaded the file first.
    const texts = logs.requestsOf('eval').map((r) => withoutId(r.request));
    const load = `(:load-file ${JSON.stringify(clean())})`;
    assert.deepStrictEqual(texts, EXPRESSIONS.slice(2).flatMap((expr) => [load, interpret(expr)]));
  });

  test('the check session is untouched: not restarted, Clean.idr still loaded, no load or :interpret since, and the following hover answers', async () => {
    const check = api.sessions.sessions().find((s) => s.role === 'check' && s.cwd === root());
    assert.ok(check);
    assert.strictEqual(logs.started('check').length, checkStartsBefore); // not restarted
    assert.strictEqual(check.loadedFile?.path, clean());
    const since = logs.requestsOf('check').slice(checkRequestsBefore).map((r) => withoutId(r.request));
    assert.ok(!since.some((t) => t.startsWith('(:load-file ') || t.startsWith('(:interpret ')), JSON.stringify(since));
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.ok(!editor.document.isDirty);
    await hoverWith(editor.document.uri, new vscode.Position(7, 5), 'xs : Vect ?_ ?_');
  });
});
