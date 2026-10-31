// E2E (ROADMAP M6 acceptance): check while typing with the real idris2, on a fresh copy of
// simple-ipkg with no build directory at all (its check session's first load creates
// build/.vscode-idris2/ttc/…): a type error typed without saving shows with source
// `idris2 (unsaved)`; a save shows the saved file's again; `?arg` typed without saving loads
// (`Foo.A` from the isolated TTC directory, F32) and its hole is in the Holes view; ten checks of
// unsaved text leave every file of the check session's build directory as it was; the shadow
// directory holds no package file but the one the extension wrote (E9: the deviation from the
// ROADMAP's "no .ipkg", docs/as-built/M6.md); with VS Code's auto-save after a short delay no
// unsaved text is checked and the save's check reports; turning idris2.checkOnType.enabled off, and
// Stop Backend, stop every shadow session. The timings of E22 are printed.
//
// One compiler process at a time (CLAUDE.md): the root's sessions are stopped between the check
// session's loads and the shadow session's, and each step waits for the processes to end. Before a
// shadow phase they are released (`SessionPool.release`, as when the root's last document closes):
// after Stop Backend nothing would check the unsaved text (`features/shadow`, the passive rule).
// The suite turns VS Code's inlay hints off: one asked between an edit and its check would make the
// check session load the document beside the shadow session (the passive rule).
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { Classification } from '../../src/project/types';
import { runEditing } from '../integration/support';
import { copyWorkspace, ideProcesses } from './ideDriver';
import { extensionApi, probedIdris2, quiesce, waitFor } from './helpers';

/** Answers the consent question for `dir` with Allow (this window) whenever it is asked, until `stop()`. */
function allowWhenAsked(api: TestApi, dir: string): { stop(): void } {
  const timer = setInterval(() => {
    if (api.consent.openQuestions().includes(dir)) {
      api.consent.respond(dir, 'allow');
    }
  }, 50);
  return { stop: () => clearInterval(timer) };
}

/** Every file below `dir`, with its modification time in nanoseconds. */
function mtimes(dir: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else {
        out.set(p, fs.statSync(p, { bigint: true }).mtimeNs);
      }
    }
  };
  walk(dir);
  return out;
}

/** Every file below `dir`, relative to it. */
function filesOf(dir: string): string[] {
  return fs.existsSync(dir) ? [...mtimes(dir).keys()].map((p) => path.relative(dir, p)).sort() : [];
}

suite('E2E: check while typing (ROADMAP M6) on a fresh copy of simple-ipkg', function () {
  this.timeout(180000);
  let api: TestApi;
  let copy: { dir: string; root: string };
  let allow: { stop(): void };
  let bFile: string;
  let isolated: string;
  let root: Classification;
  let doc: vscode.TextDocument;
  let editor: vscode.TextEditor;
  /** `idris2.checkOnType.enabled` in the profile's user settings, restored at the end. */
  let profileValue: boolean | undefined;
  /** `editor.inlayHints.enabled` in the profile's user settings, restored at the end. */
  let inlayHints: string | undefined;

  /** Stops every session (Stop Backend) and waits until no compiler process is left. */
  async function stopAll(): Promise<void> {
    api.sessions.stop();
    await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
  }

  /** Stops the sessions of `of` as the release of a root does (its state reads `none`, not `stopped`), and waits until no compiler process is left. */
  async function release(of: Classification): Promise<void> {
    api.sessions.release(of);
    await waitFor('no IDE-mode process', () => (ideProcesses().length === 0 ? true : undefined));
  }

  /** Replaces the text of line `line` with `text` (unsaved); the document's version after it. */
  async function setLine(line: number, text: string): Promise<number> {
    const ok = await editor.edit((e) => e.replace(doc.lineAt(line).range, text));
    assert.ok(ok, 'the edit was applied');
    assert.ok(doc.isDirty);
    return doc.version;
  }

  /** Waits until the check of `version`'s unsaved text is shown; the milliseconds since `since`. */
  async function shownAt(version: number, since: number): Promise<number> {
    await waitFor(`the check of version ${version}'s unsaved text`, () => (api.unsavedChecks.shownVersion(doc.uri) === version ? true : undefined), 60000);
    return Date.now() - since;
  }

  const shadowSessions = () => api.sessions.sessions().filter((s) => s.role === 'shadow' && s.state !== 'stopped' && s.state !== 'failed');

  suiteSetup(async function () {
    this.timeout(90000);
    api = await extensionApi();
    await quiesce(api);
    copy = copyWorkspace('simple-ipkg');
    assert.ok(!fs.existsSync(path.join(copy.root, 'build')), 'a fresh copy: no build directory');
    allow = allowWhenAsked(api, copy.root);
    // The profile turns check while typing off for the other suites (.vscode-test.mjs).
    profileValue = vscode.workspace.getConfiguration('idris2').inspect<boolean>('checkOnType.enabled')?.globalValue;
    await vscode.workspace.getConfiguration('idris2').update('checkOnType.enabled', true, vscode.ConfigurationTarget.Global);
    // An inlay hint asked between an edit and its check goes to the check session, which loads the
    // active document when it is not running (the passive rule): a second compiler beside the
    // shadow session's. In use that is the M6 footprint; here one process at a time (CLAUDE.md).
    inlayHints = vscode.workspace.getConfiguration('editor').inspect<string>('inlayHints.enabled')?.globalValue;
    await vscode.workspace.getConfiguration('editor').update('inlayHints.enabled', 'off', vscode.ConfigurationTarget.Global);
    bFile = path.join(copy.root, 'src', 'Foo', 'B.idr');
    isolated = path.join(copy.root, 'build', '.vscode-idris2');
    root = await api.projects.classify(bFile);
    assert.strictEqual(root.kind, 'project');
  });

  suiteTeardown(async function () {
    this.timeout(60000);
    allow.stop();
    await vscode.workspace.getConfiguration('idris2').update('checkOnType.enabled', profileValue, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('editor').update('inlayHints.enabled', inlayHints, vscode.ConfigurationTarget.Global);
    if (doc !== undefined && doc.isDirty) {
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await stopAll();
    fs.rmSync(copy.dir, { recursive: true, force: true });
  });

  test('a type error typed without saving shows with source idris2 (unsaved); the saved file\'s diagnostics are hidden meanwhile', async () => {
    doc = await vscode.workspace.openTextDocument(bFile);
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('idris2.checkFile');
    const check = api.sessions.sessionFor(root, 'check');
    await waitFor('the check session to load B.idr', () => (check.state === 'ready' && check.loadedFile !== undefined ? true : undefined), 90000);
    assert.ok(fs.existsSync(path.join(isolated, 'ttc')), 'the check session\'s first load made build/.vscode-idris2/ttc');
    assert.ok(!fs.existsSync(path.join(copy.root, 'build', 'ttc')), 'and no build/ttc (F32)');
    assert.deepStrictEqual(vscode.languages.getDiagnostics(doc.uri), []);
    await release(root);

    // Cold: the shadow session is started by this check.
    const started = Date.now();
    const version = await setLine(6, 'greeting = shout 5');
    const ms = await shownAt(version, started);
    const shown = api.unsavedChecks.shownFor(doc.uri) ?? [];
    assert.ok(shown.length > 0 && shown.every((d) => d.source === 'idris2 (unsaved)'), JSON.stringify(shown.map((d) => [d.source, d.message])));
    assert.ok(shown.some((d) => d.severity === vscode.DiagnosticSeverity.Error && d.range.start.line === 6), JSON.stringify(shown.map((d) => d.range)));
    await waitFor('VS Code to show the unsaved diagnostics', () =>
      vscode.languages.getDiagnostics(doc.uri).some((d) => d.source === 'idris2 (unsaved)') ? true : undefined,
    );
    assert.ok(vscode.languages.getDiagnostics(doc.uri).every((d) => d.source === 'idris2 (unsaved)'));
    assert.strictEqual(ideProcesses().length, 1, 'the shadow session alone');
    assert.strictEqual(shadowSessions().length, 1);
    // E22: what a check of unsaved text takes (a measurement; docs/as-built/M6.md).
    console.log(`      E22 cold (the check starts the shadow session): ${ms} ms from the edit (the 500 ms delay included)`);

    // Warm: the session runs.
    for (const [i, value] of ['6', '7', '8'].entries()) {
      const at = Date.now();
      const warm = await setLine(6, `greeting = shout ${value}`);
      console.log(`      E22 warm #${i + 1}: ${await shownAt(warm, at)} ms from the edit (delay 500 ms included)`);
    }
  });

  test('a save shows the saved file\'s diagnostics, source idris2, and removes the unsaved ones', async () => {
    await stopAll();
    assert.ok(await doc.save());
    await waitFor('the check after the save', () =>
      vscode.languages.getDiagnostics(doc.uri).some((d) => d.source === 'idris2' && d.severity === vscode.DiagnosticSeverity.Error) ? true : undefined,
    90000);
    assert.deepStrictEqual(api.unsavedChecks.shownFor(doc.uri) ?? [], [], 'no entry in idris2 (unsaved)');
    assert.ok(vscode.languages.getDiagnostics(doc.uri).every((d) => d.source === 'idris2'));
  });

  test('?arg typed without saving: no error, the load answers :ok (Foo.A from the isolated TTC directory, F32), and its hole is in the Holes view', async () => {
    await release(root);
    const version = await setLine(6, 'greeting = shout ?arg');
    await shownAt(version, Date.now());
    assert.deepStrictEqual(api.unsavedChecks.shownFor(doc.uri) ?? [], []);
    await waitFor('the hole arg in the Holes view', () => (api.holes.holesIn(bFile).some((h) => h.name === 'arg') ? true : undefined));
    const shadow = shadowSessions()[0];
    assert.ok(shadow !== undefined && shadow.launch !== undefined);
    assert.strictEqual(shadow.launch.env.IDRIS2_PATH?.split(path.delimiter)[0], path.join(isolated, 'ttc'));
    assert.strictEqual(ideProcesses().length, 1);
  });

  test('a command on unsaved text after the compiler stopped checks that text first, and saves nothing (review 1, M20)', async () => {
    const version = doc.version;
    const onDisk = fs.readFileSync(bFile, 'utf8');
    await release(root);
    assert.strictEqual(shadowSessions().length, 0, 'as after an idle stop');
    assert.strictEqual(api.unsavedChecks.shownVersion(doc.uri), version, 'what it showed stays');
    editor.selection = new vscode.Selection(6, 18, 6, 18);
    const outcome = await runEditing(api, 'idris2.proofSearch');
    assert.ok(outcome.kind === 'applied' || outcome.kind === 'message', JSON.stringify(outcome));
    assert.ok(doc.isDirty, 'not saved');
    assert.strictEqual(fs.readFileSync(bFile, 'utf8'), onDisk);
    assert.strictEqual(shadowSessions().length, 1, 'the command started the check');
    await setLine(6, 'greeting = shout ?arg');
  });

  test('ten checks of unsaved text leave every file of the check session\'s build directory as it was', async () => {
    const before = mtimes(isolated);
    assert.ok(before.size > 0);
    for (let i = 0; i < 10; i++) {
      const version = await setLine(7, `-- check ${i}`);
      await shownAt(version, Date.now());
    }
    assert.deepStrictEqual(mtimes(isolated), before);
    assert.ok(!fs.existsSync(path.join(copy.root, 'build', 'ttc')));
  });

  test('the shadow directory: the package file the extension wrote, the copy, the build directory; no other .ipkg', async () => {
    const files = filesOf(api.shadowBase);
    const ipkgs = files.filter((f) => f.endsWith('.ipkg'));
    assert.strictEqual(ipkgs.length, 1, files.join('\n'));
    const [hash] = ipkgs[0].split(path.sep);
    assert.strictEqual(ipkgs[0], path.join(hash, 'shadow.ipkg'));
    const sources = files.filter((f) => f.startsWith(path.join(hash, 'src')));
    assert.deepStrictEqual(sources, [path.join(hash, 'src', 'Foo', 'B.idr')]);
    assert.strictEqual(fs.readFileSync(path.join(api.shadowBase, hash, 'src', 'Foo', 'B.idr'), 'utf8'), doc.getText());
    const pkg = fs.readFileSync(path.join(api.shadowBase, hash, 'shadow.ipkg'), 'utf8');
    assert.match(pkg, /\npackage simple\nsourcedir = "src"\ndepends = contrib\n$/);
    assert.ok(files.every((f) => f.startsWith(hash)), 'one root, one shadow directory');
  });

  test('E22 on a 2,000-line module (a loose file): the cold and the warm check of unsaved text, printed', async function () {
    this.timeout(300000);
    await release(root);
    const loose = copyWorkspace('loose-file');
    const allowLoose = allowWhenAsked(api, loose.root);
    try {
      const lines = ['module Big', ''];
      for (let i = 0; lines.length < 2000; i++) {
        lines.push(`f${i} : Nat -> List Nat -> List Nat`, `f${i} x xs = map (+ x) (x :: ${i} :: xs)`, '');
      }
      const file = path.join(loose.root, 'Big.idr');
      fs.writeFileSync(file, lines.slice(0, 2000).join('\n') + '\n');
      const big = await vscode.workspace.openTextDocument(file);
      const bigEditor = await vscode.window.showTextDocument(big);
      const bigRoot = await api.projects.classify(file);
      const check = api.sessions.sessionFor(bigRoot, 'check');
      await vscode.commands.executeCommand('idris2.checkFile');
      await waitFor('the check session to load Big.idr', () => (check.state === 'ready' && check.loadedFile !== undefined ? true : undefined), 180000);
      await release(bigRoot);
      const edit = async (text: string): Promise<number> => {
        const at = Date.now();
        assert.ok(await bigEditor.edit((e) => e.replace(big.lineAt(1998).range, text)));
        const version = big.version;
        await waitFor(`the check of version ${version}`, () => (api.unsavedChecks.shownVersion(big.uri) === version ? true : undefined), 180000);
        return Date.now() - at;
      };
      console.log(`      E22 2,000 lines, cold: ${await edit('-- cold')} ms from the edit (the 500 ms delay included)`);
      for (let i = 1; i <= 3; i++) {
        console.log(`      E22 2,000 lines, warm #${i}: ${await edit(`-- warm ${i}`)} ms from the edit (the 500 ms delay included)`);
      }
      assert.deepStrictEqual(api.unsavedChecks.shownFor(big.uri) ?? [], []);
      assert.strictEqual(ideProcesses().length, 1, 'the shadow session alone');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.window.showTextDocument(doc);
      editor = vscode.window.activeTextEditor ?? editor;
    } finally {
      allowLoose.stop();
      await release(await api.projects.classify(path.join(loose.root, 'Big.idr')));
      fs.rmSync(loose.dir, { recursive: true, force: true });
    }
  });

  test('a package in the project\'s depends/ folder is found from the shadow directory (review 1, M2)', async function () {
    this.timeout(180000);
    await release(root);
    const local = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vi2-depends-'));
    const allowLocal = allowWhenAsked(api, local);
    try {
      // The package, built here and put where `idris2 --install` would, under its TTC version.
      const source = path.join(local, '.dep');
      fs.mkdirSync(path.join(source, 'src'), { recursive: true });
      fs.writeFileSync(path.join(source, 'dep.ipkg'), 'package dep\nversion = 0.1.0\nsourcedir = "src"\nmodules = Dep\n');
      fs.writeFileSync(path.join(source, 'src', 'Dep.idr'), 'module Dep\n\npublic export\nanswer : Nat\nanswer = 42\n');
      execFileSync(probedIdris2(api), ['--build', 'dep.ipkg'], { cwd: source, stdio: 'ignore' });
      const [ttc] = fs.readdirSync(path.join(source, 'build', 'ttc'));
      fs.cpSync(path.join(source, 'build', 'ttc', ttc), path.join(local, 'depends', 'dep-0.1.0', ttc), { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
      fs.mkdirSync(path.join(local, 'src'));
      fs.writeFileSync(path.join(local, 'p.ipkg'), 'package p\ndepends = dep\nsourcedir = "src"\nmodules = Main\n');
      const file = path.join(local, 'src', 'Main.idr');
      fs.writeFileSync(file, 'module Main\n\nimport Dep\n\nvalue : Nat\nvalue = answer\n');
      const main = await vscode.workspace.openTextDocument(file);
      const mainEditor = await vscode.window.showTextDocument(main);
      const mainRoot = await api.projects.classify(file);
      assert.strictEqual(mainRoot.kind, 'project');
      const check = api.sessions.sessionFor(mainRoot, 'check');
      await vscode.commands.executeCommand('idris2.checkFile');
      await waitFor('the check session to load Main.idr', () => (check.state === 'ready' && check.loadedFile !== undefined ? true : undefined), 120000);
      await release(mainRoot);
      assert.ok(await mainEditor.edit((e) => e.replace(main.lineAt(5).range, 'value = "text"')));
      const version = main.version;
      await waitFor(`the check of version ${version}`, () => (api.unsavedChecks.shownVersion(main.uri) === version ? true : undefined), 120000);
      assert.match((api.unsavedChecks.shownFor(main.uri) ?? [])[0]?.message ?? '', /FromString Nat/);
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await release(mainRoot);
      assert.ok(fs.existsSync(path.join(local, 'depends', 'dep-0.1.0', ttc, 'Dep.ttc')));
      await vscode.window.showTextDocument(doc);
      editor = vscode.window.activeTextEditor ?? editor;
    } finally {
      allowLocal.stop();
      await release(await api.projects.classify(path.join(local, 'src', 'Main.idr')));
      fs.rmSync(local, { recursive: true, force: true });
    }
  });

  test('VS Code saving after a short delay (files.autoSave afterDelay, 1000 ms): typing checks no unsaved text; the save\'s check reports, source idris2', async () => {
    const files = vscode.workspace.getConfiguration('files');
    const autoSave = files.inspect<string>('autoSave')?.globalValue;
    await files.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
    try {
      editor = await vscode.window.showTextDocument(doc);
      // The last test came back to this document, whose check its session had lost: under this
      // setting the delay that started ends with no check (review 1, M20).
      await waitFor('the delay to end', () => (api.unsavedChecks.pending(doc.uri) ? undefined : true));
      await release(root);
      assert.strictEqual(ideProcesses().length, 0);
      await setLine(6, 'greeting = shout 9');
      // Decided at the edit. Had a check been scheduled, the revert ends it before it starts a
      // compiler beside the one of the save's check (one at a time, CLAUDE.md).
      if (api.unsavedChecks.pending(doc.uri)) {
        await vscode.commands.executeCommand('workbench.action.files.revert');
        assert.fail('a check of the unsaved text was scheduled');
      }
      await waitFor('VS Code to save the file', () => (!doc.isDirty ? true : undefined), 10000);
      await waitFor('the check after the save', () =>
        vscode.languages.getDiagnostics(doc.uri).some((d) => d.source === 'idris2' && d.severity === vscode.DiagnosticSeverity.Error && d.range.start.line === 6) ? true : undefined,
      90000);
      assert.strictEqual(shadowSessions().length, 0, 'no shadow session');
      assert.deepStrictEqual(api.unsavedChecks.shownFor(doc.uri) ?? [], []);
      assert.ok(ideProcesses().length <= 1, 'the check session alone');
    } finally {
      await files.update('autoSave', autoSave, vscode.ConfigurationTarget.Global);
      await release(root);
    }
  });

  test('turning idris2.checkOnType.enabled off stops every shadow session and deletes the copies; Stop Backend stops them too', async () => {
    editor = await vscode.window.showTextDocument(doc);
    const before = await setLine(7, '-- before the setting changes');
    await shownAt(before, Date.now());
    assert.strictEqual(shadowSessions().length, 1);
    await vscode.workspace.getConfiguration('idris2').update('checkOnType.enabled', false, vscode.ConfigurationTarget.Global);
    await waitFor('the shadow session to stop', () => (shadowSessions().length === 0 && ideProcesses().length === 0 ? true : undefined));
    await waitFor('the copies to be deleted', () => (!fs.existsSync(api.shadowBase) ? true : undefined));
    assert.deepStrictEqual(api.unsavedChecks.shownFor(doc.uri) ?? [], [], 'no entry in idris2 (unsaved)');
    await setLine(7, '-- off');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.strictEqual(ideProcesses().length, 0, 'nothing checks the unsaved text while it is off');
    await vscode.workspace.getConfiguration('idris2').update('checkOnType.enabled', true, vscode.ConfigurationTarget.Global);
    const version = await setLine(7, '-- on again');
    await shownAt(version, Date.now());
    assert.strictEqual(shadowSessions().length, 1);
    await vscode.commands.executeCommand('idris2.stopBackend', 'current');
    await waitFor('Stop Backend to stop the shadow session', () => (shadowSessions().length === 0 && ideProcesses().length === 0 ? true : undefined));
    // After Stop Backend typing starts no compiler (as for the passive queries): a save or Check File does.
    await setLine(7, '-- after Stop Backend');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.strictEqual(ideProcesses().length, 0, 'nothing started by typing');
    assert.deepStrictEqual(api.unsavedChecks.shownFor(doc.uri) ?? [], [], 'the saved file\'s diagnostics are shown');
  });
});
