import * as assert from 'assert';
import { execFileSync } from 'child_process';
import {
  BREW_INSTALL_IDRIS2,
  IDRIS2_INSTALL_DOCS_URL,
  PACK_INSTALL_COMMAND,
  PACK_INSTALL_DOCS_URL,
  commandWord,
  idris2InstallAction,
  lspInstallAction,
  packInstallAction,
  registerInstallCommands,
  type InstallApi,
} from '../../src/toolchain/install';
import { FakeToolchain, PACK_MISSING, SETTINGS, packFound, snapshot } from './support/toolchainFixtures';

suite('toolchain/install', () => {
  test('the pre-typed commands are the documented ones (Idris 2 INSTALL.md; pack README line 26, F36)', () => {
    assert.strictEqual(BREW_INSTALL_IDRIS2, 'brew install idris2');
    assert.strictEqual(
      PACK_INSTALL_COMMAND,
      'bash -c "$(curl -fsSL https://raw.githubusercontent.com/stefan-hoeck/idris2-pack/main/install.bash)"',
    );
  });

  test('Install Idris 2…: Homebrew in a terminal on macOS, the installation instructions elsewhere', () => {
    assert.deepStrictEqual(idris2InstallAction('darwin'), {
      kind: 'terminal',
      name: 'Install Idris 2',
      text: 'brew install idris2',
      withToolchainEnv: false,
    });
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      assert.deepStrictEqual(idris2InstallAction(platform), { kind: 'openUrl', url: IDRIS2_INSTALL_DOCS_URL });
    }
  });

  test('Install pack…: the install script in a terminal, except on Windows (no documented route)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      assert.deepStrictEqual(packInstallAction(platform), {
        kind: 'terminal',
        name: 'Install pack',
        text: PACK_INSTALL_COMMAND,
        withToolchainEnv: true,
      });
    }
    assert.deepStrictEqual(packInstallAction('win32'), { kind: 'openUrl', url: PACK_INSTALL_DOCS_URL });
  });

  test('Install or Update idris2-lsp: the found pack by absolute path, nothing without pack', () => {
    assert.strictEqual(lspInstallAction(undefined, 'linux'), undefined);
    assert.strictEqual(lspInstallAction(PACK_MISSING, 'linux'), undefined);
    assert.deepStrictEqual(lspInstallAction(packFound('/home/u/.local/bin/pack'), 'linux'), {
      kind: 'terminal',
      name: 'Install idris2-lsp',
      text: '/home/u/.local/bin/pack install-app idris2-lsp',
      withToolchainEnv: true,
    });
    const spaced = lspInstallAction(packFound('/home/a b/pack'), 'darwin');
    assert.ok(spaced?.kind === 'terminal');
    assert.strictEqual(spaced.text, "'/home/a b/pack' install-app idris2-lsp");
    const windows = lspInstallAction(packFound('C:\\Users\\a b\\pack.cmd'), 'win32');
    assert.ok(windows?.kind === 'terminal');
    assert.strictEqual(windows.text, "& 'C:\\Users\\a b\\pack.cmd' install-app idris2-lsp");
  });

  test('commandWord leaves plain paths bare and quotes the rest', () => {
    assert.strictEqual(commandWord('/home/u/.local/bin/pack', 'linux'), '/home/u/.local/bin/pack');
    assert.strictEqual(commandWord('/home/a b/pack', 'linux'), "'/home/a b/pack'");
    assert.strictEqual(commandWord("/it's/pack", 'darwin'), "'/it'\\''s/pack'");
    assert.strictEqual(commandWord('C:\\tools\\pack.exe', 'win32'), 'C:\\tools\\pack.exe');
    assert.strictEqual(commandWord("C:\\it's\\pack.cmd", 'win32'), "& 'C:\\it''s\\pack.cmd'");
  });

  test("PowerShell: every quote character it ends a single-quoted string at is doubled (' and U+2018–U+201B)", () => {
    assert.strictEqual(commandWord('C:\\Users\\O\u2019Brien\\pack.exe', 'win32'), "& 'C:\\Users\\O\u2019\u2019Brien\\pack.exe'");
    assert.strictEqual(commandWord("C:\\a'\u2018\u2019\u201A\u201B\u201Cb\\pack.exe", 'win32'), "& 'C:\\a''\u2018\u2018\u2019\u2019\u201A\u201A\u201B\u201B\u201Cb\\pack.exe'");
  });

  test("POSIX: a pack path with a backslash is not typed (fish reads \\' and \\\\ inside single quotes as escapes)", () => {
    // Quoted for sh this is '/tmp/x\'\''; touch /tmp/PWNED #/pack', which fish would read as
    // the word /tmp/x'' followed by the command `touch /tmp/PWNED`.
    const action = lspInstallAction(packFound("/tmp/x\\'; touch /tmp/PWNED #/pack"), 'darwin');
    assert.ok(action?.kind === 'refused' && action.reason.includes('backslash'), JSON.stringify(action));
    assert.ok(lspInstallAction(packFound('/tmp/a\\b/pack'), 'linux')?.kind === 'refused');
    // Windows paths are made of backslashes, and PowerShell's single quotes take them literally.
    assert.strictEqual(lspInstallAction(packFound('C:\\tools\\pack.exe'), 'win32')?.kind, 'terminal');
  });

  test('a pack path with a control character is not typed: a line break, a tab, Ctrl-O, DEL', () => {
    for (const path of ['/tmp/a\nb/pack', '/tmp/a\rb/pack', '/tmp/a\tb/pack', '/tmp/a\u000Fb/pack', '/tmp/a\u007Fb/pack', '/tmp/a\u009Bb/pack']) {
      const action = lspInstallAction(packFound(path), 'linux');
      assert.ok(action?.kind === 'refused' && action.reason.includes('control character'), JSON.stringify(action));
    }
  });

  test('a POSIX shell reads each quoted word back as the original path', function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    for (const path of ['/a b/pack', "/it's/pack", '/$HOME/`x`/pack', '/a"b\\c/pack', '/semi;colon|pipe&/pack', '/tab\there/pack', '/*?[x]/pack']) {
      const echoed = execFileSync('/bin/sh', ['-c', `printf '%s' ${commandWord(path, 'linux')}`], { encoding: 'utf8' });
      assert.strictEqual(echoed, path);
    }
  });

  suite('registerInstallCommands (against a fake VS Code API)', () => {
    interface FakeTerminal {
      options: { name: string; cwd?: string; env?: Record<string, string> };
      shown: boolean;
      sent: [string, boolean | undefined][];
    }

    const HOME = '/home/u';

    /** `home.dir` is `usableHomeDirectory(os.homedir())`; `{ dir: undefined }` is an unknown home. */
    function setup(platform: NodeJS.Platform, initial = snapshot(), env: Record<string, string> = {}, home: { dir: string | undefined } = { dir: HOME }) {
      const commands = new Map<string, () => Promise<void>>();
      const terminals: FakeTerminal[] = [];
      const opened: string[] = [];
      const messages: { message: string; items: string[] }[] = [];
      const executed: string[] = [];
      let answer: string | undefined;
      const api = {
        window: {
          createTerminal: (options: FakeTerminal['options']) => {
            const terminal: FakeTerminal = { options, shown: false, sent: [] };
            terminals.push(terminal);
            return {
              show: () => (terminal.shown = true),
              sendText: (text: string, addNewLine?: boolean) => terminal.sent.push([text, addNewLine]),
            };
          },
          showInformationMessage: (message: string, ...items: string[]) => {
            messages.push({ message, items });
            return Promise.resolve(answer);
          },
          showWarningMessage: (message: string, ...items: string[]) => {
            messages.push({ message, items });
            return Promise.resolve(undefined);
          },
        },
        env: { openExternal: (uri: { value: string }) => Promise.resolve(opened.push(uri.value) > 0) },
        Uri: { parse: (value: string) => ({ value }) },
        commands: {
          registerCommand: (id: string, run: () => Promise<void>) => {
            commands.set(id, run);
            return { dispose: () => commands.delete(id) };
          },
          executeCommand: (id: string) => Promise.resolve(void executed.push(id)),
        },
      } as unknown as InstallApi;
      const toolchain = new FakeToolchain(initial);
      const disposable = registerInstallCommands(api, {
        toolchain,
        config: { toolchain: () => ({ ...SETTINGS, env }) },
        platform,
        homeDir: home.dir,
      });
      return { commands, terminals, opened, messages, executed, toolchain, disposable, answer: (a: string) => (answer = a) };
    }

    test('macOS Install Idris 2…: a shown terminal in the home directory, the command typed with no line break, no env', async () => {
      const t = setup('darwin', snapshot(), { IDRIS2_PREFIX: '/opt/i' });
      await t.commands.get('idris2.installIdris2')?.();
      assert.deepStrictEqual(t.terminals, [
        { options: { name: 'Idris 2: Install Idris 2', cwd: HOME }, shown: true, sent: [['brew install idris2', false]] },
      ]);
    });

    test('Linux Install Idris 2… opens the instructions and creates no terminal', async () => {
      const t = setup('linux');
      await t.commands.get('idris2.installIdris2')?.();
      assert.deepStrictEqual(t.opened, [IDRIS2_INSTALL_DOCS_URL]);
      assert.deepStrictEqual(t.terminals, []);
    });

    test('Install pack… passes idris2.toolchain.env to the terminal (pack reads XDG_* from it)', async () => {
      const t = setup('linux', snapshot(), { XDG_STATE_HOME: '/s' });
      await t.commands.get('idris2.installPack')?.();
      assert.deepStrictEqual(t.terminals[0].options, { name: 'Idris 2: Install pack', cwd: HOME, env: { XDG_STATE_HOME: '/s' } });
      assert.deepStrictEqual(t.terminals[0].sent, [[PACK_INSTALL_COMMAND, false]]);
    });

    test('Install or Update idris2-lsp with pack types `<pack> install-app idris2-lsp` in the home directory', async () => {
      // Not the workspace folder (VS Code's default cwd): pack would read the pack.toml of the
      // directory it runs in and of each parent (findInAllParentDirs [src]).
      const t = setup('linux', snapshot({ pack: packFound() }));
      await t.commands.get('idris2.installIdris2Lsp')?.();
      assert.strictEqual(t.terminals[0].options.cwd, HOME);
      assert.deepStrictEqual(t.terminals[0].sent, [['/home/u/.local/bin/pack install-app idris2-lsp', false]]);
    });

    test('without a home directory no install terminal is opened; a warning shows the command', async () => {
      for (const command of ['idris2.installIdris2', 'idris2.installPack', 'idris2.installIdris2Lsp']) {
        const t = setup('darwin', snapshot({ pack: packFound() }), {}, { dir: undefined });
        await t.commands.get(command)?.();
        assert.deepStrictEqual(t.terminals, [], command);
        assert.strictEqual(t.messages.length, 1, command);
        assert.match(t.messages[0].message, /home directory is unknown/);
      }
      const t = setup('darwin', snapshot({ pack: packFound() }), {}, { dir: undefined });
      await t.commands.get('idris2.installIdris2Lsp')?.();
      assert.ok(t.messages[0].message.includes('"/home/u/.local/bin/pack install-app idris2-lsp"'), t.messages[0].message);
    });

    test('Install or Update idris2-lsp with a pack path it cannot type warns and opens no terminal', async () => {
      const t = setup('linux', snapshot({ pack: packFound('/tmp/evil\n/pack') }));
      await t.commands.get('idris2.installIdris2Lsp')?.();
      assert.deepStrictEqual(t.terminals, []);
      assert.match(t.messages[0].message, /control character/);
    });

    test('Install or Update idris2-lsp without pack explains, offers Install pack…, and opens no terminal', async () => {
      const t = setup('linux', snapshot());
      t.answer('Install pack…');
      await t.commands.get('idris2.installIdris2Lsp')?.();
      assert.deepStrictEqual(t.terminals, []);
      assert.deepStrictEqual(t.messages[0].items, ['Install pack…']);
      assert.match(t.messages[0].message, /pack was not found/);
      assert.deepStrictEqual(t.executed, ['idris2.installPack']);
    });

    test('before the first scan finishes, Install or Update idris2-lsp waits for a scan', async () => {
      const t = setup('linux');
      t.toolchain.current = undefined;
      await t.commands.get('idris2.installIdris2Lsp')?.();
      assert.deepStrictEqual(t.toolchain.rescans, ['command']);
    });

    test('dispose unregisters the three commands', () => {
      const t = setup('darwin');
      assert.deepStrictEqual([...t.commands.keys()].sort(), ['idris2.installIdris2', 'idris2.installIdris2Lsp', 'idris2.installPack']);
      t.disposable.dispose();
      assert.strictEqual(t.commands.size, 0);
    });
  });
});
