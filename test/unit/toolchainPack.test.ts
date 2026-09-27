// toolchain/pack.ts over simulated pack layouts in a temporary directory (pack is not installed
// on the development machine; the layout comes from idris2-pack 6baee7d, see the module comment).
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nodeFileSystem } from '../../src/toolchain/fileSystem';
import { packDirectories, parseCollection, readPackLayout } from '../../src/toolchain/pack';

/** pack writes this on `pack switch` (collectionTomlContent, Environment.idr 449–457). */
function switchedToml(collection: string): string {
  return (
    '# Warning: This file was auto-generated and is maintained by pack.\n' +
    '#          Any changes could be overwritten by pack at any time.\n' +
    '#          Custom settings should go to the global `pack.toml` file\n' +
    '#          or any `pack.toml` file local to a project.\n' +
    `collection = "${collection}"`
  );
}

suite('toolchain/pack', () => {
  suite('packDirectories', () => {
    const HOME = '/home/u';

    test('defaults: ~/.config/pack, ~/.local/state/pack, ~/.local/bin, where ~ is $HOME', () => {
      assert.deepStrictEqual(packDirectories({ HOME }, 'linux'), {
        configDir: '/home/u/.config/pack',
        stateDir: '/home/u/.local/state/pack',
        binDir: '/home/u/.local/bin',
      });
    });

    test('XDG_CONFIG_HOME and XDG_STATE_HOME get a pack subdirectory', () => {
      const dirs = packDirectories({ HOME, XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/st' }, 'darwin');
      assert.strictEqual(dirs.configDir, '/cfg/pack');
      assert.strictEqual(dirs.stateDir, '/st/pack');
      assert.strictEqual(dirs.binDir, '/home/u/.local/bin');
    });

    test('PACK_USER_DIR, PACK_STATE_DIR and PACK_BIN_DIR are used as they are and win over XDG', () => {
      const dirs = packDirectories(
        { HOME, PACK_USER_DIR: '/pu', PACK_STATE_DIR: '/ps', PACK_BIN_DIR: '/pb', XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/st' },
        'linux',
      );
      assert.deepStrictEqual(dirs, { configDir: '/pu', stateDir: '/ps', binDir: '/pb' });
    });

    test('empty and relative values are ignored', () => {
      const dirs = packDirectories({ HOME, XDG_CONFIG_HOME: '', XDG_STATE_HOME: 'state', PACK_BIN_DIR: 'bin', PACK_USER_DIR: '' }, 'linux');
      assert.deepStrictEqual(dirs, {
        configDir: '/home/u/.config/pack',
        stateDir: '/home/u/.local/state/pack',
        binDir: '/home/u/.local/bin',
      });
    });

    test('without an absolute $HOME pack has no directories at all (NoPackDir), whatever the other variables say', () => {
      const none = { configDir: undefined, stateDir: undefined, binDir: undefined };
      assert.deepStrictEqual(packDirectories({}, 'linux'), none);
      assert.deepStrictEqual(packDirectories({ HOME: '', XDG_STATE_HOME: '/st', PACK_BIN_DIR: '/b' }, 'linux'), none);
      assert.deepStrictEqual(packDirectories({ HOME: 'relative/home', PACK_USER_DIR: '/pu' }, 'darwin'), none);
    });

    test('Windows: names are case-insensitive, paths use backslashes, and only drive or UNC paths count', () => {
      const dirs = packDirectories({ home: 'C:\\Users\\u', xdg_state_home: 'D:\\st', PACK_BIN_DIR: '\\bin' }, 'win32');
      assert.deepStrictEqual(dirs, {
        configDir: 'C:\\Users\\u\\.config\\pack',
        stateDir: 'D:\\st\\pack',
        binDir: 'C:\\Users\\u\\.local\\bin',
      });
      // Windows itself sets USERPROFILE, not HOME; without HOME pack has no directories.
      assert.deepStrictEqual(packDirectories({ USERPROFILE: 'C:\\Users\\u' }, 'win32'), {
        configDir: undefined,
        stateDir: undefined,
        binDir: undefined,
      });
      assert.strictEqual(packDirectories({ HOME: '\\Users\\u' }, 'win32').binDir, undefined, 'a root on the current drive');
    });
  });

  suite('parseCollection', () => {
    test("the file pack switch writes", () => {
      assert.strictEqual(parseCollection(switchedToml('nightly-260924')), 'nightly-260924');
    });

    test('literal strings, spacing, a trailing comment, CRLF and a BOM', () => {
      assert.strictEqual(parseCollection("collection='nightly-1'"), 'nightly-1');
      assert.strictEqual(parseCollection('\uFEFF  collection   =   "n2"   # mine\r\n'), 'n2');
    });

    test('only the top level counts', () => {
      assert.strictEqual(parseCollection('[install]\ncollection = "no"\n'), undefined);
      assert.strictEqual(parseCollection('# collection = "commented"\n[idris2]\n'), undefined);
    });

    test('values that could not name a directory are rejected', () => {
      for (const value of ['', '.', '..', 'a/b', 'a\\\\b', '../x']) {
        assert.strictEqual(parseCollection(`collection = "${value}"`), undefined, value);
      }
      assert.strictEqual(parseCollection('collection = "esc\\"aped"'), undefined);
      assert.strictEqual(parseCollection('collection = 42'), undefined);
    });
  });

  suite('readPackLayout (temporary directory)', () => {
    let root: string;
    let home: string;

    setup(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-pack-'));
      home = path.join(root, 'home');
      fs.mkdirSync(home);
    });

    teardown(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function write(relative: string, text: string): void {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }

    test('nothing installed: the default directories, no collection', async () => {
      const layout = await readPackLayout({ HOME: home }, process.platform, nodeFileSystem);
      assert.strictEqual(layout.stateDir, path.join(home, '.local', 'state', 'pack'));
      assert.strictEqual(layout.collection, undefined);
      assert.strictEqual(layout.collectionBinDir, undefined);
    });

    test('the collection pack switch wrote to the state directory wins over the global pack.toml', async () => {
      write('home/.local/state/pack/pack.toml', switchedToml('nightly-260924'));
      write('home/.config/pack/pack.toml', 'collection = "nightly-250101"\n[install]\nwith-src = true\n');
      const layout = await readPackLayout({ HOME: home }, process.platform, nodeFileSystem);
      assert.strictEqual(layout.collection, 'nightly-260924');
    });

    test('without the state file, the global pack.toml names the collection', async () => {
      write('home/.config/pack/pack.toml', 'collection = "nightly-250101"\n');
      const layout = await readPackLayout({ HOME: home }, process.platform, nodeFileSystem);
      assert.strictEqual(layout.collection, 'nightly-250101');
    });

    test('a state file without a collection falls through to the global pack.toml', async () => {
      write('home/.local/state/pack/pack.toml', '# empty\n');
      write('home/.config/pack/pack.toml', 'collection = "from-config"\n');
      assert.strictEqual((await readPackLayout({ HOME: home }, process.platform, nodeFileSystem)).collection, 'from-config');
    });

    test('the collection bin directory (README layout) is reported only when it exists', async () => {
      write('home/.local/state/pack/pack.toml', switchedToml('nightly-260924'));
      let layout = await readPackLayout({ HOME: home }, process.platform, nodeFileSystem);
      assert.strictEqual(layout.collectionBinDir, undefined);
      fs.mkdirSync(path.join(home, '.local', 'state', 'pack', 'install', 'nightly-260924', 'bin'), { recursive: true });
      layout = await readPackLayout({ HOME: home }, process.platform, nodeFileSystem);
      assert.strictEqual(layout.collectionBinDir, path.join(home, '.local', 'state', 'pack', 'install', 'nightly-260924', 'bin'));
    });

    test('XDG variables move both files', async () => {
      write('xdg-state/pack/pack.toml', switchedToml('via-xdg'));
      fs.mkdirSync(path.join(root, 'xdg-state', 'pack', 'install', 'via-xdg', 'bin'), { recursive: true });
      const env = { HOME: home, XDG_STATE_HOME: path.join(root, 'xdg-state'), XDG_CONFIG_HOME: path.join(root, 'xdg-config') };
      const layout = await readPackLayout(env, process.platform, nodeFileSystem);
      assert.strictEqual(layout.configDir, path.join(root, 'xdg-config', 'pack'));
      assert.strictEqual(layout.collection, 'via-xdg');
      assert.strictEqual(layout.collectionBinDir, path.join(root, 'xdg-state', 'pack', 'install', 'via-xdg', 'bin'));
    });

    test('an unreadable pack.toml (a directory) counts as absent', async () => {
      fs.mkdirSync(path.join(home, '.local', 'state', 'pack', 'pack.toml'), { recursive: true });
      write('home/.config/pack/pack.toml', 'collection = "fallback"\n');
      assert.strictEqual((await readPackLayout({ HOME: home }, process.platform, nodeFileSystem)).collection, 'fallback');
    });

    test('POSIX: a FIFO named pack.toml is not read (it would wait for a writer) and counts as absent', async function () {
      if (process.platform === 'win32') {
        this.skip();
      }
      fs.mkdirSync(path.join(home, '.local', 'state', 'pack'), { recursive: true });
      execFileSync('mkfifo', [path.join(home, '.local', 'state', 'pack', 'pack.toml')]);
      write('home/.config/pack/pack.toml', 'collection = "fallback"\n');
      assert.strictEqual((await readPackLayout({ HOME: home }, process.platform, nodeFileSystem)).collection, 'fallback');
    });

    test('without $HOME nothing is read, as pack reads nothing (NoPackDir)', async () => {
      write('xdg-state/pack/pack.toml', switchedToml('via-xdg'));
      const layout = await readPackLayout({ XDG_STATE_HOME: path.join(root, 'xdg-state') }, process.platform, nodeFileSystem);
      assert.deepStrictEqual(layout, { configDir: undefined, stateDir: undefined, binDir: undefined, collection: undefined, collectionBinDir: undefined });
    });

    test('$HOME of the environment, not the home directory of the process, places the layout', async () => {
      const other = path.join(root, 'other-home');
      write('other-home/.local/state/pack/pack.toml', switchedToml('from-env-home'));
      const layout = await readPackLayout({ HOME: other }, process.platform, nodeFileSystem);
      assert.strictEqual(layout.binDir, path.join(other, '.local', 'bin'));
      assert.strictEqual(layout.collection, 'from-env-home');
    });
  });
});
