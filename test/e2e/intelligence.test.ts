// E2E (ROADMAP §5 M3 acceptance): the read-only intelligence and evaluation of M3 with the real
// idris2, driven through VS Code's commands for hovers, definitions, semantic tokens, inlay hints,
// completion and Evaluate Selection. The workspace is simple-ipkg (B.idr, A.idr, Shapes.idr); the
// loose files of the acceptance (Clean.idr, Unicode.idr from broken/, Lit.lidr from loose-file/)
// are used in temporary copies, whose folders need the user's consent, which the tests give
// (ROADMAP §9, 2026-09-27). Acceptance texts that differ from the fixtures, as recorded
// (docs/as-built/M3.md): `greet` is `greeting` in B.idr; Lit.lidr is loose-file's; `putStrLn "hi"`
// alone does not type-check (no HasIO implementation is chosen), so the IO action evaluated is
// `the (IO ()) (putStrLn "hi")`, and the bare one shows the compiler's error.
//
// One compiler process at a time (CLAUDE.md): the sessions of one root are stopped before
// another root's start, and the evaluation runs while the `check` session of its root is stopped,
// which is then started again by Check File — so the `check` and `eval` sessions never run at
// once here. That the `check` session is untouched while both run is the integration test
// test/integration/intelligence-loose/evaluation.test.ts (the fake's request log).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { Classification } from '../../src/project/types';
import {
  evaluateSelection,
  hintLabel,
  hoverWith,
  inlayHints,
  semanticTokens,
  semanticTokensWhen,
  tokenAt,
  waitForAsync,
} from '../integration/support';
import { copyWorkspace, filesBelow, ideProcesses } from './ideDriver';
import { extensionApi, quiesce, waitFor, workspaceDir } from './helpers';

/** Stops every session and waits until no compiler process of the extension is left. */
async function stopAll(api: TestApi): Promise<void> {
  api.sessions.stop();
  await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
}

/** Answers the consent question for `dir` with Allow (this window) whenever it is asked, until `stop()`. */
function allowWhenAsked(api: TestApi, dir: string): { stop(): void } {
  const timer = setInterval(() => {
    if (api.consent.openQuestions().includes(dir)) {
      api.consent.respond(dir, 'allow');
    }
  }, 50);
  return { stop: () => clearInterval(timer) };
}

/** Waits until the `check` session of `root` is ready with `file` loaded. */
async function loaded(api: TestApi, root: Classification, file: string, deadlineMs = 60000): Promise<void> {
  const session = api.sessions.sessionFor(root, 'check');
  await waitFor(`${file} to be loaded`, () => (session.state === 'ready' && session.loadedFile?.path === file ? true : undefined), deadlineMs);
}

/**
 * Opens `file` in an editor, checks it with **Check File** and waits for the load. The check on
 * open runs only when a document is first shown: a document an earlier test (or suite) opened is
 * not checked again by showing it, and after **Stop Backend** nothing but a save or Check File
 * starts its compiler again (M2), nor does a hover (a passive query loads nothing then, M3).
 */
async function open(api: TestApi, file: string): Promise<{ doc: vscode.TextDocument; editor: vscode.TextEditor; root: Classification }> {
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  const root = await api.projects.classify(file);
  await vscode.commands.executeCommand('idris2.checkFile');
  await loaded(api, root, file);
  return { doc, editor, root };
}

suite('E2E: M3 intelligence and evaluation with the real idris2', function () {
  this.timeout(180000);
  let api: TestApi;
  let ws: string;
  const copies: string[] = [];

  suiteSetup(async function () {
    this.timeout(90000);
    api = await extensionApi();
    await quiesce(api);
    ws = workspaceDir();
  });

  suiteTeardown(async function () {
    this.timeout(60000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await stopAll(api);
    for (const dir of copies) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Generated output of this suite in the workspace (git-ignored); anything else is left alone.
    fs.rmSync(path.join(ws, 'build', '.vscode-idris2'), { recursive: true, force: true });
    const build = path.join(ws, 'build');
    if (fs.existsSync(build) && fs.readdirSync(build).length === 0) {
      fs.rmdirSync(build);
    }
  });

  suite('simple-ipkg', () => {
    suiteTeardown(async function () {
      this.timeout(60000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await stopAll(api);
    });

    test('hover on greeting (B.idr) shows Foo.B.greeting : String', async () => {
      const { doc } = await open(api, path.join(ws, 'src', 'Foo', 'B.idr'));
      await hoverWith(doc.uri, new vscode.Position(6, 0), 'Foo.B.greeting : String');
    });

    test('F12 on shout (B.idr) opens src/Foo/A.idr at the span :name-at returns for its declaration', async () => {
      const { doc } = await open(api, path.join(ws, 'src', 'Foo', 'B.idr'));
      const [location, ...more] = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        new vscode.Position(6, 11),
      );
      assert.ok(location && more.length === 0, JSON.stringify([location, ...more]));
      const uri = 'targetUri' in location ? location.targetUri : location.uri;
      const range = 'targetRange' in location ? location.targetRange : location.range;
      assert.strictEqual(uri.fsPath, path.join(ws, 'src', 'Foo', 'A.idr'));
      assert.deepStrictEqual([range.start.line, range.start.character, range.end.line, range.end.character], [2, 0, 3, 24]);
    });

    test('semantic tokens of Shapes.idr: Circle (enumMember) and area (function) are told apart', async () => {
      const { doc } = await open(api, path.join(ws, 'src', 'Foo', 'Shapes.idr'));
      const tokens = await semanticTokensWhen(doc.uri, 'Circle and area', (t) => tokenAt(t, 6, 2) !== undefined && tokenAt(t, 11, 0) !== undefined);
      assert.strictEqual(tokenAt(tokens, 6, 2)?.type, 'enumMember');
      assert.strictEqual(tokenAt(tokens, 11, 0)?.type, 'function');
    });
  });

  suite('loose files (copies of broken/ and loose-file/, allowed when asked)', () => {
    let broken: string;
    let consent: { stop(): void };

    suiteSetup(async function () {
      this.timeout(60000);
      await stopAll(api);
      const copy = copyWorkspace('broken');
      copies.push(copy.dir);
      broken = copy.root;
      // The expressions Evaluate Selection is given, as comment lines after Clean.idr's last line.
      fs.appendFileSync(
        path.join(broken, 'Clean.idr'),
        ['', '-- :exec putStrLn "hi"', '-- the (Vect 2 Nat) [1,2]', '-- the (IO ()) (putStrLn "hi")', '-- putStrLn "hi"', ''].join('\n'),
      );
      consent = allowWhenAsked(api, broken);
    });

    suiteTeardown(async function () {
      this.timeout(60000);
      consent.stop();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await stopAll(api);
    });

    test('hover on xs in `vlen xs = ?vlen_rhs` shows xs : Vect ?_ ?_, and the inlay hint ": Vect ?_ ?_" follows xs', async () => {
      const { doc } = await open(api, path.join(broken, 'Clean.idr'));
      await hoverWith(doc.uri, new vscode.Position(7, 5), 'xs : Vect ?_ ?_');
      const hint = await waitForAsync('the inlay hint after xs', async () =>
        (await inlayHints(doc)).find((h) => h.position.line === 7 && h.position.character === 7),
      );
      assert.strictEqual(hintLabel(hint), ': Vect ?_ ?_');
    });

    test('`vl` completes to vlen and vlen_rhs (asked again while the list is incomplete, as VS Code does at the next keystroke)', async () => {
      const { doc } = await open(api, path.join(broken, 'Clean.idr'));
      // The first :repl-completions after a load is slow (docs/measurements/first-load.md) and the
      // warm-up waits for 150 ms of quiet, so a request right after the load may get the keywords
      // alone within COMPILER_WAIT_MS; that list must then be marked incomplete.
      await waitForAsync(
        'vlen and vlen_rhs among the completions',
        async () => {
          const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(7, 2));
          const labels = list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
          if (labels.includes('vlen') && labels.includes('vlen_rhs')) {
            return true;
          }
          assert.ok(list.isIncomplete === true, `a complete list without vlen and vlen_rhs: ${JSON.stringify(labels)}`);
          return undefined;
        },
      );
    });

    test('E14: in Unicode.idr the hover and the token after two astral characters (UTF-16 column 20) find s', async () => {
      const { doc } = await open(api, path.join(broken, 'Unicode.idr'));
      const tokens = await semanticTokensWhen(doc.uri, 's', (t) => tokenAt(t, 14, 20) !== undefined);
      assert.deepStrictEqual(tokenAt(tokens, 14, 20), { line: 14, character: 20, length: 1, type: 'variable', modifiers: 0 });
      await hoverWith(doc.uri, new vscode.Position(14, 20), 's : String');
    });

    test('Evaluate Selection: :exec is refused before anything starts; [1,2] and IO actions are values, in the eval session; the hover answers afterwards', async () => {
      const file = path.join(broken, 'Clean.idr');
      const { doc, editor, root } = await open(api, file);
      // One compiler at a time: the check session stops, so that only the eval session runs.
      api.sessions.stop(root);
      await waitFor('the check session to stop', () => (ideProcesses().length === 0 ? true : undefined));
      const range = (line: number, text: string): vscode.Range => {
        assert.strictEqual(doc.lineAt(line).text, `-- ${text}`);
        return new vscode.Range(line, 3, line, 3 + text.length);
      };

      const refused = await evaluateSelection(api, editor, range(9, ':exec putStrLn "hi"'));
      assert.strictEqual(refused.kind, 'refused', JSON.stringify(refused));
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepStrictEqual(ideProcesses(), [], 'a refused evaluation started a compiler');

      const vect = await evaluateSelection(api, editor, range(10, 'the (Vect 2 Nat) [1,2]'));
      assert.deepStrictEqual([vect.kind, vect.text], ['value', '[1, 2]']);
      const [evalProcess, ...others] = ideProcesses();
      assert.ok(evalProcess && others.length === 0, JSON.stringify(ideProcesses()));
      assert.match(evalProcess.command, /\s--ide-mode\s--no-color\s--build-dir\s\S*\/build\/\.vscode-idris2-eval(\s|$)/);

      const io = await evaluateSelection(api, editor, range(11, 'the (IO ()) (putStrLn "hi")'));
      assert.deepStrictEqual([io.kind, io.text], ['value', 'MkIO (prim__putStr "hi\\n")']);
      const bare = await evaluateSelection(api, editor, range(12, 'putStrLn "hi"'));
      assert.strictEqual(bare.kind, 'error');
      assert.ok(bare.text.includes("Can't find an implementation for HasIO ?io."), bare.text);
      // The eval session built into its own directory, not the check session's.
      assert.ok(filesBelow(path.join(broken, 'build', '.vscode-idris2-eval')).some((f) => f.endsWith('/Clean.ttc')));

      // Then the check session again, alone: Check File starts it, and the hover answers.
      api.sessions.stop(root);
      await waitFor('the eval session to stop', () => (ideProcesses().length === 0 ? true : undefined));
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('idris2.checkFile');
      await loaded(api, root, file);
      await hoverWith(doc.uri, new vscode.Position(7, 5), 'xs : Vect ?_ ?_');
      assert.strictEqual(ideProcesses().length, 1);
    });

    test('Lit.lidr: the module keyword token starts at column 2 (F11), and the hover on n answers', async () => {
      await stopAll(api);
      const copy = copyWorkspace('loose-file');
      copies.push(copy.dir);
      const allow = allowWhenAsked(api, copy.root);
      try {
        const { doc } = await open(api, path.join(copy.root, 'Lit.lidr'));
        const tokens = await semanticTokensWhen(doc.uri, 'the module keyword', (t) => tokenAt(t, 0, 2) !== undefined);
        assert.deepStrictEqual(tokenAt(tokens, 0, 2), { line: 0, character: 2, length: 6, type: 'keyword', modifiers: 0 });
        await hoverWith(doc.uri, new vscode.Position(5, 9), 'n : Nat');
      } finally {
        allow.stop();
      }
    });

    test('performance: the semantic tokens of a 2,000-line module take < 200 ms once it is loaded', async function () {
      this.timeout(240000);
      await stopAll(api);
      const copy = copyWorkspace('loose-file');
      copies.push(copy.dir);
      const lines = ['module Big', ''];
      for (let i = 0; lines.length < 2000; i++) {
        lines.push(`f${i} : Nat -> List Nat -> List Nat`, `f${i} x xs = map (+ x) (x :: ${i} :: xs)`, '');
      }
      const file = path.join(copy.root, 'Big.idr');
      fs.writeFileSync(file, lines.slice(0, 2000).join('\n') + '\n');
      const allow = allowWhenAsked(api, copy.root);
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        const started = Date.now();
        await loaded(api, await api.projects.classify(file), file, 180000);
        const loadMs = Date.now() - started;
        await semanticTokensWhen(doc.uri, 'the index of the load', (t) => t.length > 0);
        const t0 = performance.now();
        const tokens = await semanticTokens(doc.uri);
        const ms = performance.now() - t0;
        // A measurement (E6's sense): recorded in docs/as-built/M3.md.
        console.log(`      2,000 lines: load ${loadMs} ms (open to loaded), ${tokens.length} semantic tokens in ${ms.toFixed(1)} ms`);
        assert.ok(tokens.length > 6000, `${tokens.length} tokens`);
        assert.ok(ms < 200, `${ms.toFixed(1)} ms for the semantic tokens`);
      } finally {
        allow.stop();
      }
    });
  });
});
