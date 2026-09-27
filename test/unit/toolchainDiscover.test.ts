// toolchain/discover.ts against simulated file systems: every step and branch of the search
// order in ToolSource (toolchain/types.ts) and the idris2.toolchain.*Path descriptions, on POSIX
// and Windows layouts, without touching the machine.
import * as assert from 'assert';
import type { ToolchainSettings } from '../../src/core/config';
import { discoverTool, pathEntries, type Discovery } from '../../src/toolchain/discover';
import type { FileSystemProbe, PathInfo } from '../../src/toolchain/fileSystem';
import type { PackLayout } from '../../src/toolchain/pack';
import type { DiscoveryEnvironment, ToolKind } from '../../src/toolchain/types';

const HOME = '/home/u';

/**
 * Executable files, plain files, directories; paths not listed do not exist. Records every stat.
 * `links` maps a directory to what `realpath` resolves it to; any other path resolves to itself.
 */
function fakeFs(entries: {
  executables?: string[];
  files?: string[];
  dirs?: string[];
  links?: Record<string, string>;
}): FileSystemProbe & { statted: string[] } {
  const table = new Map<string, PathInfo>();
  entries.executables?.forEach((p) => table.set(p, { kind: 'file', executable: true }));
  entries.files?.forEach((p) => table.set(p, { kind: 'file', executable: false }));
  entries.dirs?.forEach((p) => table.set(p, { kind: 'directory', executable: false }));
  const statted: string[] = [];
  return {
    statted,
    stat: (p) => {
      statted.push(p);
      return Promise.resolve(table.get(p));
    },
    readTextFile: () => Promise.resolve(undefined),
    realpath: (p) => Promise.resolve(entries.links?.[p] ?? p),
  };
}

function settings(overrides: Partial<ToolchainSettings> = {}): ToolchainSettings {
  return { idris2Path: '', lspPath: '', packPath: '', preferPack: false, env: {}, ignoredEnvEntries: [], ...overrides };
}

const POSIX_PACK: PackLayout = {
  configDir: `${HOME}/.config/pack`,
  stateDir: `${HOME}/.local/state/pack`,
  binDir: `${HOME}/.local/bin`,
  collection: undefined,
  collectionBinDir: undefined,
};

function posix(env: Record<string, string>, overrides: Partial<ToolchainSettings> = {}): DiscoveryEnvironment {
  return { platform: 'linux', homeDir: HOME, env, settings: settings(overrides) };
}

async function find(
  tool: ToolKind,
  environment: DiscoveryEnvironment,
  fs: FileSystemProbe,
  pack: PackLayout = POSIX_PACK,
): Promise<Discovery> {
  return discoverTool(tool, environment, pack, fs);
}

function assertFound(result: Discovery, path: string, source: string): void {
  assert.ok(result.found, `expected ${path}, got: ${result.found ? '' : result.reason}`);
  assert.strictEqual(result.location.path, path);
  assert.strictEqual(result.location.source, source);
}

function assertMissing(result: Discovery, reasonFragment: string): readonly string[] {
  assert.ok(!result.found, `expected missing, found ${result.found ? result.location.path : ''}`);
  assert.ok(result.reason.includes(reasonFragment), `"${result.reason}" should contain "${reasonFragment}"`);
  return result.searched;
}

suite('toolchain/discover', () => {
  suite('the setting', () => {
    test('an absolute path is used as is', async () => {
      const fs = fakeFs({ executables: ['/opt/idris2/bin/idris2', '/usr/bin/idris2'] });
      const result = await find('idris2', posix({ PATH: '/usr/bin' }, { idris2Path: '/opt/idris2/bin/idris2' }), fs);
      assertFound(result, '/opt/idris2/bin/idris2', 'setting');
      assert.ok(result.found && result.location.detail.includes('idris2.toolchain.idris2Path'));
    });

    test('a configured path that does not exist is missing, with no fallback to PATH', async () => {
      const fs = fakeFs({ executables: ['/usr/bin/idris2'] });
      const result = await find('idris2', posix({ PATH: '/usr/bin' }, { idris2Path: '/nope/idris2' }), fs);
      assert.deepStrictEqual(assertMissing(result, 'idris2.toolchain.idris2Path is set to /nope/idris2, which does not exist'), [
        '/nope/idris2',
      ]);
      assert.deepStrictEqual(fs.statted, ['/nope/idris2']);
    });

    test('a directory or a file without execute permission is missing, with the reason', async () => {
      const fs = fakeFs({ dirs: ['/opt/idris2'], files: ['/opt/idris2.txt'] });
      assertMissing(await find('idris2-lsp', posix({}, { lspPath: '/opt/idris2' }), fs), 'is a directory');
      assertMissing(await find('pack', posix({}, { packPath: '/opt/idris2.txt' }), fs), 'is not executable');
    });

    test('a bare command name is looked up on PATH only', async () => {
      const fs = fakeFs({ executables: ['/b/idris2-dev', `${HOME}/.local/bin/idris2-dev`] });
      const result = await find('idris2', posix({ PATH: '/a:/b' }, { idris2Path: 'idris2-dev' }), fs);
      assertFound(result, '/b/idris2-dev', 'setting');
      assert.ok(result.found && result.location.detail.includes('"idris2-dev" in PATH entry /b'));
      const missing = await find('idris2', posix({ PATH: '/a' }, { idris2Path: 'idris2-dev', preferPack: true }), fs);
      assert.deepStrictEqual(assertMissing(missing, 'command name "idris2-dev", which is in no PATH directory'), ['/a']);
    });

    test('a relative path with a separator is neither: missing', async () => {
      const fs = fakeFs({ executables: ['/a/bin/idris2'] });
      const result = await find('idris2', posix({ PATH: '/a' }, { idris2Path: 'bin/idris2' }), fs);
      assertMissing(result, 'neither an absolute path nor a bare command name');
      assert.deepStrictEqual(fs.statted, []);
    });
  });

  suite('the search without a setting', () => {
    test('PATH in order, before pack and the well-known directories', async () => {
      const fs = fakeFs({ executables: ['/b/idris2', '/c/idris2', `${HOME}/.local/bin/idris2`, '/opt/homebrew/bin/idris2'] });
      const result = await find('idris2', posix({ PATH: '/a:/b:/c' }), fs);
      assertFound(result, '/b/idris2', 'PATH');
      assert.ok(result.found && result.location.detail === 'PATH entry /b');
    });

    test('then pack: its bin directory, then the collection bin directory', async () => {
      const pack: PackLayout = {
        ...POSIX_PACK,
        collection: 'nightly-260924',
        collectionBinDir: `${HOME}/.local/state/pack/install/nightly-260924/bin`,
      };
      const inCollection = `${HOME}/.local/state/pack/install/nightly-260924/bin/idris2-lsp`;
      let result = await find('idris2-lsp', posix({ PATH: '/a' }), fakeFs({ executables: [inCollection] }), pack);
      assertFound(result, inCollection, 'pack');
      assert.ok(result.found && result.location.packCollection === 'nightly-260924');
      result = await find(
        'idris2-lsp',
        posix({ PATH: '/a' }),
        fakeFs({ executables: [inCollection, `${HOME}/.local/bin/idris2-lsp`] }),
        pack,
      );
      assertFound(result, `${HOME}/.local/bin/idris2-lsp`, 'pack');
      assert.ok(result.found && result.location.packCollection === undefined);
    });

    test('then /opt/homebrew/bin, /usr/local/bin, ~/.idris2/bin', async () => {
      const all = ['/opt/homebrew/bin/idris2', '/usr/local/bin/idris2', `${HOME}/.idris2/bin/idris2`];
      for (let i = 0; i < all.length; i++) {
        const result = await find('idris2', posix({ PATH: '/a' }), fakeFs({ executables: all.slice(i) }));
        assertFound(result, all[i], 'wellKnown');
      }
    });

    test('nothing found: every directory searched, in order, once', async () => {
      const result = await find('idris2', posix({ PATH: `/a::relative:/opt/homebrew/bin:/a/` }), fakeFs({}));
      assert.deepStrictEqual(assertMissing(result, 'idris2 is not on PATH'), [
        '/a',
        '/opt/homebrew/bin',
        `${HOME}/.local/bin`,
        '/usr/local/bin',
        `${HOME}/.idris2/bin`,
      ]);
    });

    test('a directory met on PATH keeps the PATH source', async () => {
      const result = await find('idris2', posix({ PATH: '/opt/homebrew/bin' }), fakeFs({ executables: ['/opt/homebrew/bin/idris2'] }));
      assertFound(result, '/opt/homebrew/bin/idris2', 'PATH');
      assert.ok(result.found && !result.location.inPackDirectory);
    });

    test("pack's directories are recognised whichever step finds a tool in them", async () => {
      // pack's README has users put ~/.local/bin on PATH: the search meets it there first.
      const pack: PackLayout = {
        ...POSIX_PACK,
        collection: 'nightly-260924',
        collectionBinDir: `${HOME}/.local/state/pack/install/nightly-260924/bin`,
      };
      const fs = fakeFs({ executables: [`${HOME}/.local/bin/idris2-lsp`, `${pack.collectionBinDir}/idris2`, '/opt/homebrew/bin/idris2'] });
      const onPath = await find('idris2-lsp', posix({ PATH: `/opt/homebrew/bin:${HOME}/.local/bin/` }), fs, pack);
      assertFound(onPath, `${HOME}/.local/bin/idris2-lsp`, 'PATH');
      assert.ok(onPath.found && onPath.location.inPackDirectory && onPath.location.packCollection === undefined);
      const configured = await find('idris2', posix({}, { idris2Path: `${pack.collectionBinDir}/idris2` }), fs, pack);
      assertFound(configured, `${pack.collectionBinDir}/idris2`, 'setting');
      assert.ok(configured.found && configured.location.inPackDirectory && configured.location.packCollection === 'nightly-260924');
      const byName = await find('idris2', posix({ PATH: `${HOME}/.local/state/pack/install/nightly-260924/bin` }, { idris2Path: 'idris2' }), fs, pack);
      assert.ok(byName.found && byName.location.source === 'setting' && byName.location.packCollection === 'nightly-260924');
      const homebrew = await find('idris2', posix({ PATH: '/opt/homebrew/bin' }), fs, pack);
      assert.ok(homebrew.found && !homebrew.location.inPackDirectory);
    });

    test("a PATH entry that is a symbolic link to pack's bin directory is recognised as pack's", async () => {
      const fs = fakeFs({ executables: [`${HOME}/bin/idris2-lsp`], links: { [`${HOME}/bin`]: `${HOME}/.local/bin` } });
      const result = await find('idris2-lsp', posix({ PATH: `${HOME}/bin` }), fs);
      assertFound(result, `${HOME}/bin/idris2-lsp`, 'PATH');
      assert.ok(result.found && result.location.inPackDirectory);
      // pack's directory itself behind a link (HOME spelled through one, as /tmp on macOS).
      const linkedPack: PackLayout = { ...POSIX_PACK, binDir: `/link${HOME}/.local/bin` };
      const behind = fakeFs({ executables: [`${HOME}/.local/bin/pack`], links: { [`/link${HOME}/.local/bin`]: `${HOME}/.local/bin` } });
      const pack = await find('pack', posix({ PATH: `${HOME}/.local/bin` }), behind, linkedPack);
      assert.ok(pack.found && pack.location.source === 'PATH' && pack.location.inPackDirectory);
      // No link: a different directory stays different.
      const unrelated = await find('idris2-lsp', posix({ PATH: '/opt/bin' }), fakeFs({ executables: ['/opt/bin/idris2-lsp'] }));
      assert.ok(unrelated.found && !unrelated.location.inPackDirectory);
    });

    test('the location carries exactly the fields of ToolLocation', async () => {
      const result = await find('idris2', posix({ PATH: '/b' }), fakeFs({ executables: ['/b/idris2'] }));
      assert.ok(result.found);
      assert.deepStrictEqual(result.location, {
        kind: 'idris2',
        path: '/b/idris2',
        source: 'PATH',
        detail: 'PATH entry /b',
        inPackDirectory: false,
      });
    });

    test('without a home directory, only absolute directories are searched: no ~/.idris2/bin, no default pack bin', async () => {
      const noPack: PackLayout = { configDir: undefined, stateDir: undefined, binDir: undefined, collection: undefined, collectionBinDir: undefined };
      const environment: DiscoveryEnvironment = { platform: 'linux', homeDir: undefined, env: { PATH: '/a' }, settings: settings() };
      const result = await find('idris2', environment, fakeFs({}), noPack);
      assert.deepStrictEqual(assertMissing(result, 'idris2 is not on PATH'), ['/a', '/opt/homebrew/bin', '/usr/local/bin']);
    });

    test('preferPack searches pack before PATH', async () => {
      const fs = fakeFs({ executables: ['/usr/bin/idris2', `${HOME}/.local/bin/idris2`] });
      assertFound(await find('idris2', posix({ PATH: '/usr/bin' }), fs), '/usr/bin/idris2', 'PATH');
      assertFound(await find('idris2', posix({ PATH: '/usr/bin' }, { preferPack: true }), fs), `${HOME}/.local/bin/idris2`, 'pack');
    });

    test('files without execute permission and directories are skipped', async () => {
      const fs = fakeFs({ files: ['/a/idris2'], dirs: ['/b/idris2'], executables: ['/c/idris2'] });
      assertFound(await find('idris2', posix({ PATH: '/a:/b:/c' }), fs), '/c/idris2', 'PATH');
    });

    test('when nothing is found, the candidates skipped as not runnable are named (a copy that lost its x bit)', async () => {
      const fs = fakeFs({ files: ['/a/idris2'], dirs: ['/b/idris2'] });
      assertMissing(
        await find('idris2', posix({ PATH: '/a:/b' }), fs),
        'idris2 is not on PATH, in pack\'s directories or in the usual installation directories. ' +
          'Found but not usable: /a/idris2 (is not executable), /b/idris2 (is a directory).',
      );
      assertMissing(
        await find('idris2', posix({ PATH: '/a' }, { idris2Path: 'idris2' }), fs),
        'which is in no PATH directory. Found but not usable: /a/idris2 (is not executable).',
      );
      const plain = await find('idris2', posix({ PATH: '/x' }), fs);
      assert.ok(!plain.found && !plain.reason.includes('Found but not usable'), plain.found ? '' : plain.reason);
    });

    test('no PATH variable at all', async () => {
      const result = await find('pack', posix({}), fakeFs({ executables: [`${HOME}/.local/bin/pack`] }));
      assertFound(result, `${HOME}/.local/bin/pack`, 'pack');
    });
  });

  suite('Windows', () => {
    const WIN_HOME = 'C:\\Users\\u';
    const WIN_PACK: PackLayout = {
      configDir: `${WIN_HOME}\\.config\\pack`,
      stateDir: `${WIN_HOME}\\.local\\state\\pack`,
      binDir: `${WIN_HOME}\\.local\\bin`,
      collection: undefined,
      collectionBinDir: undefined,
    };

    function windows(env: Record<string, string>, overrides: Partial<ToolchainSettings> = {}): DiscoveryEnvironment {
      return { platform: 'win32', homeDir: WIN_HOME, env, settings: settings(overrides) };
    }

    test('PATHEXT order, case-insensitive variable names, quoted entries', async () => {
      const fs = fakeFs({ executables: ['C:\\Program Files\\Idris2\\bin\\idris2.cmd', 'C:\\Program Files\\Idris2\\bin\\idris2.exe'] });
      const env = { Path: 'C:\\Windows;"C:\\Program Files\\Idris2\\bin"', PathExt: '.EXE;.CMD' };
      assertFound(await find('idris2', windows(env), fs, WIN_PACK), 'C:\\Program Files\\Idris2\\bin\\idris2.exe', 'PATH');
      const cmdFirst = { ...env, PathExt: '.CMD;.EXE' };
      assertFound(await find('idris2', windows(cmdFirst), fs, WIN_PACK), 'C:\\Program Files\\Idris2\\bin\\idris2.cmd', 'PATH');
    });

    test('extensions the runner cannot start are not tried; the default PATHEXT applies when unset', async () => {
      const fs = fakeFs({ executables: ['C:\\t\\idris2.js', 'C:\\t\\idris2.bat'] });
      assertFound(await find('idris2', windows({ PATH: 'C:\\t', PATHEXT: '.JS;.BAT' }), fs, WIN_PACK), 'C:\\t\\idris2.bat', 'PATH');
      assertFound(await find('idris2', windows({ PATH: 'C:\\t' }), fs, WIN_PACK), 'C:\\t\\idris2.bat', 'PATH');
      const stats = fakeFs({});
      await find('pack', windows({ PATH: 'C:\\t' }), stats, WIN_PACK);
      assert.deepStrictEqual(
        stats.statted.slice(0, 4),
        ['C:\\t\\pack.com', 'C:\\t\\pack.exe', 'C:\\t\\pack.bat', 'C:\\t\\pack.cmd'],
      );
    });

    test('directories are compared case-insensitively', async () => {
      const result = await find('idris2', windows({ PATH: 'C:\\A;c:\\a\\;C:\\B' }), fakeFs({}), WIN_PACK);
      const searched = assertMissing(result, 'not on PATH');
      assert.deepStrictEqual(searched.slice(0, 2), ['C:\\A', 'C:\\B']);
    });

    test('only drive and UNC directories are searched: no /opt/homebrew/bin or /usr/local/bin, no \\tools', async () => {
      // path.win32 would turn /usr/local/bin into \usr\local\bin on the current drive.
      const planted = ['\\opt\\homebrew\\bin\\idris2-lsp.exe', '\\usr\\local\\bin\\idris2-lsp.exe', '\\tools\\idris2-lsp.exe'];
      const fs = fakeFs({ executables: planted });
      const env = { Path: 'C:\\Windows;\\tools;\\\\server\\share\\bin', PATHEXT: '.EXE' };
      const searched = assertMissing(await find('idris2-lsp', windows(env), fs, WIN_PACK), 'not on PATH');
      assert.deepStrictEqual(searched, [
        'C:\\Windows',
        '\\\\server\\share\\bin',
        `${WIN_HOME}\\.local\\bin`,
        `${WIN_HOME}\\.idris2\\bin`,
      ]);
      assert.ok(fs.statted.every((p) => /^([A-Za-z]:\\|\\\\)/.test(p)), fs.statted.join(', '));
      // A pack directory or home that is only a root on the current drive is not searched either.
      const rooted: PackLayout = { ...WIN_PACK, binDir: '\\pack\\bin' };
      const environment: DiscoveryEnvironment = { platform: 'win32', homeDir: '\\Users\\u', env: { Path: 'C:\\a' }, settings: settings() };
      assert.deepStrictEqual(assertMissing(await find('idris2', environment, fakeFs({}), rooted), 'not on PATH'), ['C:\\a']);
    });

    test('a setting that is a root on the current drive (\\tools\\idris2) is neither absolute nor a bare name', async () => {
      const fs = fakeFs({ executables: ['\\tools\\idris2.exe'] });
      const result = await find('idris2', windows({ PATH: 'C:\\a' }, { idris2Path: '\\tools\\idris2' }), fs, WIN_PACK);
      assertMissing(result, 'neither an absolute path (on Windows a full path starts with a drive');
      assert.deepStrictEqual(fs.statted, []);
      const unc = fakeFs({ executables: ['\\\\srv\\tools\\idris2.exe'] });
      assertFound(await find('idris2', windows({}, { idris2Path: '\\\\srv\\tools\\idris2' }), unc, WIN_PACK), '\\\\srv\\tools\\idris2.exe', 'setting');
    });

    test('settings: an absolute path as is or with PATHEXT, a bare name with PATHEXT, a name with its extension, a drive-relative name', async () => {
      const fs = fakeFs({ executables: ['D:\\tools\\idris2.exe'] });
      const env = { PATH: 'D:\\tools' };
      assertFound(await find('idris2', windows(env, { idris2Path: 'D:\\tools\\idris2.exe' }), fs, WIN_PACK), 'D:\\tools\\idris2.exe', 'setting');
      // As cmd.exe resolves a typed path: C:\tools\idris2 runs C:\tools\idris2.exe.
      assertFound(await find('idris2', windows(env, { idris2Path: 'D:\\tools\\idris2' }), fs, WIN_PACK), 'D:\\tools\\idris2.exe', 'setting');
      const missingPath = await find('idris2', windows(env, { idris2Path: 'D:\\nope\\idris2' }), fs, WIN_PACK);
      assert.deepStrictEqual(
        assertMissing(missingPath, 'is set to D:\\nope\\idris2, and no file D:\\nope\\idris2 with one of the extensions .com, .exe, .bat, .cmd (PATHEXT) exists.'),
        ['D:\\nope\\idris2.com', 'D:\\nope\\idris2.exe', 'D:\\nope\\idris2.bat', 'D:\\nope\\idris2.cmd'],
      );
      assertFound(await find('idris2', windows(env, { idris2Path: 'idris2' }), fs, WIN_PACK), 'D:\\tools\\idris2.exe', 'setting');
      assertFound(await find('idris2', windows(env, { idris2Path: 'idris2.exe' }), fs, WIN_PACK), 'D:\\tools\\idris2.exe', 'setting');
      assertMissing(await find('idris2', windows(env, { idris2Path: 'D:idris2' }), fs, WIN_PACK), 'neither');
    });
  });

  test('pathEntries keeps only fully qualified entries', () => {
    assert.deepStrictEqual(pathEntries({ PATH: '/a::b:./c:/d' }, 'darwin'), ['/a', '/d']);
    assert.deepStrictEqual(pathEntries({ Path: 'C:\\a;;rel;"C:\\b c";\\tools;D:x;D:/y;//srv/share' }, 'win32'), [
      'C:\\a',
      'C:\\b c',
      'D:/y',
      '//srv/share',
    ]);
    assert.deepStrictEqual(pathEntries({}, 'linux'), []);
  });
});
