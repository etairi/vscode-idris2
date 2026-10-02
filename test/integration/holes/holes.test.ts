// Suite `holes` (.vscode-test.mjs): workspace test/fixtures/workspaces/holes — loose files,
// Main.idr importing Base.idr, a hole `todo` in each (E16), `size_rhs` in Main and, in Base, a
// premise of each multiplicity. The fake compiler replays holes-loose-main and holes-loose-base
// (recorded from Idris 2 0.8.0). ROADMAP §5 M4: the Holes view (file → hole → premises, click to
// jump, count badge), Next / Previous Hole, List Holes, and Show Keybindings. Positions are 0-based.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Hole } from '../../../src/backend/types';
import type { TestApi } from '../../../src/extension';
import {
  acceptQuickPick,
  checkSession,
  extensionApi,
  FakeLogs,
  loadedIn,
  setToolchainSetting,
  settledScan,
  setUserSetting,
  settled,
  showFile,
  waitFor,
  waitForAsync,
  workspaceFile,
} from '../support';

const root = (): string => workspaceFile().fsPath;
const main = (): string => workspaceFile('Main.idr').fsPath;
const base = (): string => workspaceFile('Base.idr').fsPath;

/** A hole as the tests compare it: every field, the location as [file, start line, start column, end line, end column]. */
function summary(hole: Hole): unknown {
  const at = hole.location;
  return {
    name: hole.name,
    qualifiedName: hole.qualifiedName,
    type: hole.type.text,
    premises: hole.premises.map((p) => [p.multiplicity, p.name, p.type.text]),
    location: at && [at.uri.fsPath, at.range.start.line, at.range.start.character, at.range.end.line, at.range.end.character],
  };
}

/** The recorded holes (holes-loose-main: :metavariables and :name-at after loading Main.idr). */
const MAIN_HOLES = (): unknown[] => [
  { name: 'todo', qualifiedName: 'Main.todo', type: 'Nat', premises: [['unrestricted', 'ns', 'List Nat']], location: [main(), 5, 11, 5, 16] },
  { name: 'size_rhs', qualifiedName: 'Main.size_rhs', type: 'Nat', premises: [], location: [main(), 8, 7, 8, 16] },
];
const BASE_HOLES = (): unknown[] => [
  {
    name: 'todo',
    qualifiedName: 'Base.todo',
    type: 'Vect (S n) a',
    premises: [
      [0, 'n', 'Nat'],
      [0, 'a', 'Type'],
      [1, 'x', 'a'],
      ['unrestricted', 'xs', 'Vect n a'],
    ],
    location: [base(), 7, 15, 7, 20],
  },
];

/** A tree item's text as drawn: its label, then its description. */
function drawn(item: vscode.TreeItem): string {
  const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
  const description = typeof item.description === 'string' ? item.description : '';
  return [label, description].filter((t) => t !== '').join(' ');
}

/** Waits until the active editor shows `file` with `range` selected. */
function selected(file: string, range: [number, number, number, number]): Promise<true> {
  return waitFor(
    () => {
      const e = vscode.window.activeTextEditor;
      return `${path.basename(file)} with ${JSON.stringify(range)} selected (active: ${e?.document.fileName} ${JSON.stringify(e?.selection)})`;
    },
    () => {
      const e = vscode.window.activeTextEditor;
      const s = e?.selection;
      return e?.document.uri.fsPath === file && s !== undefined && [s.start.line, s.start.character, s.end.line, s.end.character].join() === range.join()
        ? true
        : undefined;
    },
  );
}

suite('M4 holes: the Holes view, Next / Previous Hole, List Holes (fake compiler)', () => {
  let api: TestApi;
  let logs: FakeLogs;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
    const doc = await showFile('Main.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
  });

  teardown(async () => {
    for (const doc of vscode.workspace.textDocuments.filter((d) => d.isDirty)) {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('after Main.idr loads, the model has the holes of Main and of Base, which it imports (E16): names, types, premises with multiplicities, the ?name spans', async () => {
    await waitFor(
      () => `the holes of Main.idr and Base.idr (the model has ${JSON.stringify(api.holes.files())})`,
      () => (api.holes.files().length === 2 ? true : undefined),
    );
    assert.deepStrictEqual(api.holes.files(), [base(), main()]);
    assert.deepStrictEqual(api.holes.holesIn(main()).map(summary), MAIN_HOLES());
    assert.deepStrictEqual(api.holes.holesIn(base()).map(summary), BASE_HOLES());
  });

  test('the Holes view: file → hole → premises (the prefix only for 0 and 1), a badge of 3; clicking a hole selects its ?name', async () => {
    const tree = api.holesTree;
    const files = (await tree.getChildren()) ?? [];
    assert.strictEqual(files.length, 2);
    const holesOf = async (index: number): Promise<vscode.TreeItem[]> =>
      Promise.all(((await tree.getChildren(files[index])) ?? []).map(async (h) => tree.getTreeItem(h)));
    // Files in the model's order: Base.idr, then Main.idr.
    const [baseHoles, mainHoles] = [await holesOf(0), await holesOf(1)];
    assert.deepStrictEqual(baseHoles.map(drawn).map((t) => /\?todo\b/.test(t) && t.includes('Vect (S n) a')), [true]);
    assert.deepStrictEqual(mainHoles.map((h) => /\?(todo|size_rhs)\b/.exec(drawn(h))?.[1]), ['todo', 'size_rhs']);
    const baseTodo = (await tree.getChildren(files[0])) ?? [];
    const premises = await Promise.all(((await tree.getChildren(baseTodo[0])) ?? []).map(async (p) => drawn(await tree.getTreeItem(p))));
    assert.deepStrictEqual(premises, ['0 n : Nat', '0 a : Type', '1 x : a', 'xs : Vect n a']);
    assert.strictEqual(api.holesView.badge?.value, 3);

    const command = mainHoles[1].command;
    assert.ok(command, 'the hole item has no command');
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await selected(main(), [8, 7, 8, 16]);
    const baseCommand = baseHoles[0].command;
    assert.ok(baseCommand);
    await vscode.commands.executeCommand(baseCommand.command, ...(baseCommand.arguments ?? []));
    await selected(base(), [7, 15, 7, 20]);
  });

  test('revealing a hole in a file changed since its load finds its ?name where it is now', async () => {
    const doc = await showFile('Main.idr');
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor?.document === doc);
    assert.ok(await editor.edit((e) => e.insert(new vscode.Position(4, 0), '\n\n')));
    const items = await Promise.all(((await api.holesTree.getChildren((await api.holesTree.getChildren())?.[1])) ?? []).map(async (h) => api.holesTree.getTreeItem(h)));
    const command = items[0].command; // ?todo, recorded on line 5
    assert.ok(command);
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await selected(main(), [7, 11, 7, 16]);
  });

  test('Next Hole and Previous Hole walk the ?names of the text, wrapping around, unsaved ones included, and ask the compiler nothing', async () => {
    const doc = await showFile('Main.idr');
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor?.document === doc);
    assert.ok(await editor.edit((e) => e.insert(doc.lineAt(doc.lineCount - 1).range.end, '\nextra : Nat\nextra = ?fresh\n')));
    const freshAt = doc.positionAt(doc.getText().indexOf('?fresh'));
    const fresh: [number, number, number, number] = [freshAt.line, freshAt.character, freshAt.line, freshAt.character + '?fresh'.length];
    // Whatever the edit made the extension ask has been answered; from here on only the commands run.
    const session = checkSession(api, root());
    assert.ok(session);
    await settled(session);
    const from = logs.requests().length;
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const next = async (range: [number, number, number, number]): Promise<void> => {
      await vscode.commands.executeCommand('idris2.nextHole');
      await selected(main(), range);
    };
    await next([5, 11, 5, 16]);
    await next([8, 7, 8, 16]);
    await next(fresh); // not saved
    await next([5, 11, 5, 16]); // wrapped
    await vscode.commands.executeCommand('idris2.previousHole');
    await selected(main(), fresh); // wrapped backwards
    await vscode.commands.executeCommand('idris2.previousHole');
    await selected(main(), [8, 7, 8, 16]);
    // What finding holes would need from the compiler: a load, :metavariables, :name-at.
    const asked = logs.requests().slice(from).map((r) => r.request);
    assert.deepStrictEqual(asked.filter((r) => /\(:(load-file|metavariables|name-at) /.test(r)), [], JSON.stringify(asked));
  });

  test('List Holes: a QuickPick of the holes, its module\'s first; picking one selects its ?name', async () => {
    await showFile('Main.idr');
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    let done = false;
    vscode.commands.executeCommand('idris2.listHoles').then(
      () => (done = true),
      () => (done = true),
    );
    await waitForAsync('List Holes to finish after its first item was accepted', async () => {
      if (!done) {
        await acceptQuickPick();
      }
      return done ? true : undefined;
    });
    await selected(main(), [5, 11, 5, 16]);
  });
});

suite('M4 Show Keybindings', () => {
  suiteTeardown(async () => {
    await setUserSetting('keybindings', 'scheme', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a read-only plain-text document of the active scheme\'s shortcuts, which follows the setting', async () => {
    const manifest = vscode.extensions.getExtension('etairi.vscode-idris2')?.packageJSON as {
      contributes: { commands: { command: string; title: string }[]; keybindings: { command: string }[] };
    };
    const titles = [...new Set(manifest.contributes.keybindings.map((k) => k.command))].map(
      (id) => manifest.contributes.commands.find((c) => c.command === id)?.title ?? id,
    );
    assert.ok(titles.includes('Case Split') && titles.includes('Type at Cursor'), JSON.stringify(titles));
    await setUserSetting('keybindings', 'scheme', 'chords');
    await vscode.commands.executeCommand('idris2.showKeybindings');
    const doc = await waitFor('the keybindings document', () => {
      const d = vscode.window.activeTextEditor?.document;
      return d !== undefined && d.uri.scheme !== 'file' && /Case Split/.test(d.getText()) ? d : undefined;
    });
    assert.strictEqual(doc.languageId, 'plaintext');
    for (const title of titles) {
      assert.ok(doc.getText().includes(title), `${title} is not listed:\n${doc.getText()}`);
    }
    const chords = doc.getText();
    await setUserSetting('keybindings', 'scheme', 'none');
    await waitFor('the document to follow the setting', () => (doc.getText() !== chords ? true : undefined));
    assert.ok(!doc.getText().includes('Case Split'), doc.getText());
    assert.match(doc.getText(), /idris2\.keybindings\.scheme/);
  });
});
