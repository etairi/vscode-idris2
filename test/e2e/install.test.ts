// E2E (ROADMAP M1 acceptance, D22): the install commands open a terminal with the expected
// command typed in, and execute nothing. The default terminal profile is replaced by the
// terminal recorder (test/integration/terminalRecorder.ts), which records what the terminal
// receives instead of running a shell, so a regression that executes the command runs nothing on
// the machine and fails the exact-text check (it would add a line break).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fakeLauncher } from '../fake-tools/paths';
import { closeTerminals, commandWordFor, resetTerminalProfile, typedBy, useTerminalRecorder } from '../integration/terminalRecorder';
import { extensionApi, waitFor } from './helpers';

/** pack's README line 26 (F36) [doc]. */
const PACK_INSTALL =
  'bash -c "$(curl -fsSL https://raw.githubusercontent.com/stefan-hoeck/idris2-pack/main/install.bash)"';

suite('E2E: install commands type into a terminal and run nothing', function () {
  let dir: string;
  let file: string;

  suiteSetup(async function () {
    if (process.platform === 'win32') {
      this.skip(); // the e2e suite runs on macOS (CI) and Linux; the integration suite covers Windows
    }
    await extensionApi();
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-e2e-')));
    file = path.join(dir, 'typed.txt');
    await useTerminalRecorder(file);
  });

  suiteTeardown(async () => {
    await closeTerminals();
    await resetTerminalProfile();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Install Idris 2… types `brew install idris2` on macOS', async function () {
    this.timeout(60000);
    if (process.platform !== 'darwin') {
      this.skip(); // elsewhere it opens the installation instructions in the browser
    }
    const { text, terminal } = await typedBy('idris2.installIdris2', file);
    assert.strictEqual(terminal.name, 'Idris 2: Install Idris 2');
    assert.strictEqual(text, 'brew install idris2');
  });

  test("Install pack… types pack's install command", async function () {
    this.timeout(60000);
    const { text } = await typedBy('idris2.installPack', file);
    assert.strictEqual(text, PACK_INSTALL);
  });

  test('Install or Update idris2-lsp with pack types `<pack> install-app idris2-lsp`', async function () {
    this.timeout(90000);
    const api = await extensionApi();
    const pack = fakeLauncher('pack');
    const toolchain = vscode.workspace.getConfiguration('idris2.toolchain');
    await toolchain.update('packPath', pack, vscode.ConfigurationTarget.Global);
    try {
      await waitFor('a scan that finds the configured pack', () => {
        const state = api.toolchain.current?.pack;
        return !api.toolchain.scanning && state?.status === 'found' && state.info.location.path === pack ? true : undefined;
      });
      const { text, terminal } = await typedBy('idris2.installIdris2Lsp', file);
      // The absolute path of the pack found, quoted if a shell would read it differently, in a
      // terminal that starts in the home directory (no project pack.toml applies there).
      assert.strictEqual(text, `${commandWordFor(pack)} install-app idris2-lsp`);
      assert.strictEqual((terminal.creationOptions as vscode.TerminalOptions).cwd, os.homedir());
    } finally {
      await toolchain.update('packPath', undefined, vscode.ConfigurationTarget.Global);
      await waitFor('a scan without the configured pack', () =>
        !api.toolchain.scanning && api.toolchain.current?.settings.packPath === '' ? true : undefined,
      );
    }
  });
});
