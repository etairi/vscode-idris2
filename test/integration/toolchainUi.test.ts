// M1 toolchain UI in the Extension Host (suite `integration`, workspace loose-file). The user
// settings of this suite name the fake tools of test/fake-tools/bin (.vscode-test.mjs), so the
// scans find a fake idris2 printing `Idris 2, version 0.8.0`, a fake idris2-lsp whose API
// version is 0.8.0 too, and a fake pack. Tests that change a setting restore it.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import { fakeLauncher } from '../fake-tools/paths';
import { EXTENSION_ID, extensionApi, setToolchainSetting, settledScan, waitFor, workspaceFile } from './support';
import { closeTerminals, commandWordFor, resetTerminalProfile, typedBy, useTerminalRecorder } from './terminalRecorder';

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command?: string; when?: string; group?: string }[]>;
  };
}

function manifest(): Manifest {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension);
  return extension.packageJSON as Manifest;
}

async function closeEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function setupInformationText(api: TestApi): Promise<string> {
  await vscode.commands.executeCommand('idris2.showSetupInformation');
  const editor = await waitFor('the Setup Information editor', () =>
    vscode.window.activeTextEditor?.document.uri.toString() === api.setupInformationUri.toString()
      ? vscode.window.activeTextEditor
      : undefined,
  );
  return editor.document.getText();
}

suite('M1 toolchain UI (fake tools)', () => {
  let api: TestApi;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
  });

  suiteTeardown(closeEditors);

  test('the fake tools named in the user settings are found and probed', () => {
    const snapshot = api.toolchain.current;
    assert.ok(snapshot);
    assert.strictEqual(snapshot.trusted, true);
    assert.ok(snapshot.idris2.status === 'probed', JSON.stringify(snapshot.idris2));
    assert.strictEqual(snapshot.idris2.location.path, fakeLauncher('idris2'));
    assert.strictEqual(snapshot.idris2.location.source, 'setting');
    assert.strictEqual(snapshot.idris2.info.version?.text, '0.8.0');
    assert.ok(snapshot.lsp.status === 'probed', JSON.stringify(snapshot.lsp));
    assert.strictEqual(snapshot.pack.status, 'found');
    assert.strictEqual(snapshot.verdict?.kind, 'compatible');
  });

  test('the status item reads "Idris 2 0.8.0 · syntax only" (no backend in M1) and names the loose file', async () => {
    const doc = await vscode.workspace.openTextDocument(workspaceFile('Hello.idr'));
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(api.statusItem.text, 'Idris 2 0.8.0 · syntax only');
    assert.strictEqual(api.statusItem.severity, vscode.LanguageStatusSeverity.Information);
    assert.strictEqual(api.statusItem.busy, false);
    assert.deepStrictEqual(api.statusItem.command, { command: 'idris2.showStatusMenu', title: 'Show Commands…' });
    await waitFor('the status detail to name the loose file', () =>
      api.statusItem.detail?.includes(`loose file (no .ipkg above ${path.dirname(doc.uri.fsPath)})`) ? true : undefined,
    );
    assert.strictEqual(vscode.languages.match(api.statusItem.selector, doc) > 0, true);
    assert.strictEqual(api.registry.labelFor(await api.projects.classify(doc.uri.fsPath)), 'syntax only');
  });

  test('Show Setup Information opens a read-only document with the paths, raw and parsed versions, verdict and trust', async () => {
    const doc = await vscode.workspace.openTextDocument(workspaceFile('Hello.idr'));
    await vscode.window.showTextDocument(doc);
    const text = await setupInformationText(api);
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.scheme, 'idris2-setup');
    for (const expected of [
      '# Idris 2: Setup Information',
      '- Workspace trust: trusted',
      `- Path: \`${fakeLauncher('idris2')}\``,
      '- Version line: `Idris 2, version 0.8.0`',
      '### `idris2 --version`',
      '### `idris2 --ttc-version`',
      '### `idris2 --paths`',
      '### `idris2 --list-packages`',
      `- Path: \`${fakeLauncher('idris2-lsp')}\``,
      '- API line: `Idris2 API: 0.8.0`',
      `- Path: \`${fakeLauncher('pack')}\``,
      '**compatible**',
      `- \`${doc.uri.fsPath}\``,
      `- ${vscode.env.appName} ${vscode.version}`,
    ]) {
      assert.ok(text.includes(expected), `missing ${JSON.stringify(expected)} in:\n${text}`);
    }
    await closeEditors();
  });

  test('every contributed command is registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const contributed = manifest().contributes.commands.map((c) => c.command);
    for (const id of contributed) {
      assert.ok(registered.has(id), `${id} is contributed but not registered`);
    }
  });

  test('the status QuickPick lists exactly the "Idris 2" submenu entries that are visible, in the same order', () => {
    const packFound = api.toolchain.current?.pack.status === 'found';
    assert.strictEqual(packFound, true);
    const visible = manifest()
      .contributes.menus['idris2.editorTitle'].filter((e) => e.when === undefined || e.when === (packFound ? 'idris2.packFound' : '!idris2.packFound'))
      .map((e) => e.command);
    // The manifest lists the submenu in display order (group, then @order); the unit test of
    // statusMenuEntries checks the sorting itself.
    assert.deepStrictEqual(
      api.statusMenuEntries().map((e) => e.command),
      visible,
    );
    assert.ok(visible.includes('idris2.installIdris2Lsp') && !visible.includes('idris2.installPack'));
  });

  suite('a missing compiler', () => {
    let original: unknown;
    const missingPath = path.join(os.tmpdir(), 'vi2-no-such-dir', process.platform === 'win32' ? 'idris2.cmd' : 'idris2');

    suiteSetup(() => {
      original = vscode.workspace.getConfiguration('idris2.toolchain').inspect('idris2Path')?.globalValue;
      assert.ok(!fs.existsSync(missingPath));
    });

    suiteTeardown(async () => {
      await setToolchainSetting(api, 'idris2Path', original as string | undefined);
    });

    test('one warning with Install Idris 2…, Set Path and Show Output; the status says Setup…; nothing else breaks', async () => {
      const before = api.notices.length;
      const snapshot = await setToolchainSetting(api, 'idris2Path', missingPath);
      assert.strictEqual(snapshot.idris2.status, 'missing');
      assert.strictEqual(api.statusItem.text, 'idris2 not found — Setup…');
      assert.strictEqual(api.statusItem.severity, vscode.LanguageStatusSeverity.Warning);

      const shown = api.notices.slice(before);
      assert.deepStrictEqual(shown.map((n) => n.kind), ['idris2Missing']);
      assert.deepStrictEqual(shown[0].actions.map((a) => a.label), ['Install Idris 2…', 'Set Path', 'Show Output']);

      // A rescan with the same result does not repeat it.
      await vscode.commands.executeCommand('idris2.rescanToolchain');
      await settledScan(api, 'the rescan', (s) => s.reason === 'command');
      assert.strictEqual(api.notices.length, before + 1);

      // The rest still works: the idris2-lsp probe, Setup Information, the QuickPick.
      assert.strictEqual(api.toolchain.current?.lsp.status, 'probed');
      const text = await setupInformationText(api);
      assert.ok(text.includes('## idris2\n\n- Not found.'), text);
      await closeEditors();
      assert.ok(api.statusMenuEntries().some((e) => e.command === 'idris2.installIdris2'));
    });
  });

  suite('a server that likely does not match the compiler', () => {
    let original: unknown;

    suiteSetup(() => {
      original = vscode.workspace.getConfiguration('idris2.toolchain').inspect('env')?.globalValue;
    });

    suiteTeardown(async () => {
      await setToolchainSetting(api, 'env', original as Record<string, string> | undefined);
    });

    test('is announced once, with the verdict\'s reason', async () => {
      const before = api.notices.length;
      // test/fake-tools/README.md: the fake server's `Idris2 API:` text.
      const snapshot = await setToolchainSetting(api, 'env', { FAKE_IDRIS2_LSP_API_VERSION: '0.7.0' });
      assert.strictEqual(snapshot.verdict?.kind, 'likelyMismatch');
      const shown = api.notices.slice(before);
      assert.deepStrictEqual(shown.map((n) => n.kind), ['pairMismatch']);
      assert.ok(shown[0].message.includes(snapshot.verdict.reason));
      await vscode.commands.executeCommand('idris2.rescanToolchain');
      await settledScan(api, 'the rescan', (s) => s.reason === 'command' && s.verdict?.kind === 'likelyMismatch');
      assert.strictEqual(api.notices.length, before + 1);
      assert.match(api.statusItem.detail ?? '', /idris2-lsp: /);
    });
  });

  suite('install commands type into a terminal and run nothing', () => {
    // The default terminal profile is the recorder (terminalRecorder.ts) on every platform: it
    // records what a terminal receives and runs nothing, so the exact text shows that no line
    // break was sent.
    let dir: string;
    let file: string;
    let originalEnv: unknown;

    suiteSetup(async () => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-install-')));
      file = path.join(dir, 'typed.txt');
      originalEnv = vscode.workspace.getConfiguration('idris2.toolchain').inspect('env')?.globalValue;
      await useTerminalRecorder(file);
    });

    suiteTeardown(async () => {
      await closeTerminals();
      await resetTerminalProfile();
      await setToolchainSetting(api, 'env', originalEnv as Record<string, string> | undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('Install or Update idris2-lsp: exactly `<pack> install-app idris2-lsp`, in the home directory, with the toolchain environment', async function () {
      this.timeout(90000);
      await setToolchainSetting(api, 'env', { VI2_INSTALL_TEST: '1' });
      const { text, terminal } = await typedBy('idris2.installIdris2Lsp', file);
      assert.strictEqual(terminal.name, 'Idris 2: Install idris2-lsp');
      const options = terminal.creationOptions as vscode.TerminalOptions;
      assert.deepStrictEqual(options.env, { VI2_INSTALL_TEST: '1' });
      // Not the workspace folder: pack reads the pack.toml of its directory and every parent.
      assert.strictEqual(options.cwd, os.homedir());
      assert.strictEqual(text, `${commandWordFor(fakeLauncher('pack'))} install-app idris2-lsp`);
    });

    test('Install pack… types its command (macOS, Linux), and Install Idris 2… too on macOS', async function () {
      this.timeout(90000);
      if (process.platform === 'win32') {
        this.skip(); // both open the installation instructions in the browser there
      }
      const pack = await typedBy('idris2.installPack', file);
      assert.strictEqual(pack.terminal.name, 'Idris 2: Install pack');
      assert.strictEqual(
        pack.text,
        'bash -c "$(curl -fsSL https://raw.githubusercontent.com/stefan-hoeck/idris2-pack/main/install.bash)"',
      );
      if (process.platform === 'darwin') {
        const idris2 = await typedBy('idris2.installIdris2', file);
        assert.strictEqual(idris2.terminal.name, 'Idris 2: Install Idris 2');
        assert.strictEqual((idris2.terminal.creationOptions as vscode.TerminalOptions).env, undefined);
        assert.strictEqual(idris2.text, 'brew install idris2');
      }
    });
  });
});
