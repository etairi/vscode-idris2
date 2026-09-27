// The fake toolchain of the integration suites (test/fake-tools/README.md): the launchers that
// .vscode-test.mjs names, the M1 probes of test/fake-idris2 (replayed from the real compiler's
// recorded output), the fake idris2-lsp and pack, the fault modes, and the simulated pack layout.
import * as assert from 'assert';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPackLayout, type PackLayout } from '../fake-tools/packLayout';
import { fakeBinDir, fakeLauncher, fakeScript, repoRoot, type FakeTool } from '../fake-tools/paths';

interface Recording {
  readonly stdout: string;
  readonly exitCode: number;
}

interface Recorded {
  readonly cwdPlaceholder: string;
  readonly flags: Readonly<Record<string, Recording>>;
  readonly dumpIpkgJson: readonly (Recording & { readonly ipkg: string; readonly sha256: string })[];
}

const RECORDED: Recorded = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), 'test', 'fake-idris2', 'recorded-cli-0.8.0.json'), 'utf8'),
);

const TOOLS: readonly FakeTool[] = ['idris2', 'idris2-lsp', 'pack'];
const WINDOWS = process.platform === 'win32';

/** A `cmd.exe` word; the tests pass only paths and flags without `"` or `%`. */
function cmdWord(text: string): string {
  assert.ok(!/["%]/.test(text), `cannot quote ${text} for cmd.exe`);
  return `"${text}"`;
}

/**
 * Runs `executable` with `args` and no shell on macOS/Linux. A Windows `.cmd` launcher needs
 * cmd.exe (Node refuses to spawn it directly), so there it goes through `cmd.exe /d /s /c`.
 */
interface RunOptions {
  /** Merged over this process's environment; `undefined` removes a variable. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly input?: string;
}

function run(executable: string, args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  const common = {
    env,
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8' as const,
    timeout: 30000,
  };
  if (executable.endsWith('.cmd')) {
    const line = [executable, ...args].map(cmdWord).join(' ');
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...common,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(executable, args, common);
}

function runTool(tool: FakeTool, args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
  return run(fakeLauncher(tool), args, options);
}

function assertExit(result: SpawnSyncReturns<string>, code: number): void {
  assert.ifError(result.error);
  assert.strictEqual(result.status, code, `exit ${result.status}; stdout ${result.stdout}; stderr ${result.stderr}`);
}

/** A new temporary directory, as its real path (on macOS /var is a link to /private/var). */
function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-fake-')));
}

/** An IDE-mode request frame (6 hex digits of the UTF-8 length, F1). */
function frame(sexp: string): string {
  const body = sexp + '\n';
  return Buffer.byteLength(body).toString(16).padStart(6, '0') + body;
}

suite('fake tools: launchers', () => {
  for (const tool of TOOLS) {
    test(`${tool}: bin/${tool} (sh) and bin/${tool}.cmd run the tool's script`, () => {
      const script = fakeScript(tool);
      assert.ok(fs.existsSync(script), script);

      const sh = fs.readFileSync(fakeLauncher(tool, 'linux'), 'utf8');
      assert.ok(sh.startsWith('#!/bin/sh\n'), sh);
      // `exec` replaces the shell, so killing the launcher's pid kills the tool (timeouts).
      const shTarget = /^exec node "\$\(dirname "\$0"\)\/(.+)" "\$@"$/m.exec(sh);
      assert.ok(shTarget, sh);
      assert.strictEqual(path.resolve(fakeBinDir(), shTarget[1]), script);
      if (!WINDOWS) {
        assert.ok((fs.statSync(fakeLauncher(tool, 'linux')).mode & 0o111) !== 0, 'not executable');
      }

      const cmd = fs.readFileSync(fakeLauncher(tool, 'win32'), 'utf8');
      const cmdTarget = /^@node "%~dp0([^"]+)" %\*\r?$/m.exec(cmd);
      assert.ok(cmdTarget, cmd);
      assert.strictEqual(path.resolve(fakeBinDir(), cmdTarget[1].replace(/\\/g, '/')), script);
    });
  }
});

suite('fake tools: idris2 probes', () => {
  // Any directory with no `.ipkg` works as the working directory; this one has no symbolic
  // links or short names in its path on any runner, so process.cwd() in the child is exactly it.
  const cwd = path.join(repoRoot(), 'test', 'fake-tools');

  test('the recordings have the shapes the version parsers rely on', () => {
    assert.match(RECORDED.flags['--version'].stdout, /^Idris 2, version \d+\.\d+\.\d+\n$/);
    assert.match(RECORDED.flags['--ttc-version'].stdout, /^\d+\n$/);
    assert.ok(RECORDED.flags['--paths'].stdout.includes(RECORDED.cwdPlaceholder));
    assert.match(RECORDED.flags['--list-packages'].stdout, /^Idris2 TTC Version: \d+\n/);
  });

  for (const flag of ['--version', '--ttc-version', '--paths', '--list-packages']) {
    test(`${flag} prints the recorded output`, () => {
      const result = runTool('idris2', [flag], { cwd });
      assertExit(result, RECORDED.flags[flag].exitCode);
      assert.strictEqual(result.stdout, RECORDED.flags[flag].stdout.split(RECORDED.cwdPlaceholder).join(cwd));
      assert.strictEqual(result.stderr, '');
    });
  }

  test('every --dump-ipkg-json recording matches its fixture byte for byte', () => {
    assert.ok(RECORDED.dumpIpkgJson.length > 0);
    for (const recording of RECORDED.dumpIpkgJson) {
      const ipkg = path.join(repoRoot(), recording.ipkg);
      const sha256 = createHash('sha256').update(fs.readFileSync(ipkg)).digest('hex');
      assert.strictEqual(sha256, recording.sha256, `${recording.ipkg} changed: record its output again (test/fake-idris2/README.md)`);
    }
  });

  test('--dump-ipkg-json answers for the file given absolutely, relatively, or found in the cwd', () => {
    for (const recording of RECORDED.dumpIpkgJson) {
      const ipkg = path.join(repoRoot(), recording.ipkg);
      const dir = path.dirname(ipkg);
      const calls: string[][] = [[ipkg], [path.basename(ipkg)]];
      if (fs.readdirSync(dir).filter((name) => name.endsWith('.ipkg')).length === 1) {
        calls.push([]);
      }
      for (const extra of calls) {
        const result = runTool('idris2', ['--dump-ipkg-json', ...extra], { cwd: dir });
        assertExit(result, recording.exitCode);
        assert.strictEqual(result.stdout, recording.stdout, extra.join(' '));
      }
    }
  });

  test('the simple-ipkg recording has sourcedir "src" and depends on contrib', () => {
    const recording = RECORDED.dumpIpkgJson.find((r) => r.ipkg.startsWith('test/fixtures/workspaces/simple-ipkg/'));
    assert.ok(recording);
    const json = JSON.parse(recording.stdout) as { sourcedir?: string; depends: Record<string, unknown>[] };
    assert.strictEqual(json.sourcedir, 'src');
    assert.ok(json.depends.some((d) => Object.keys(d).includes('contrib')), recording.stdout);
  });

  test('--dump-ipkg-json refuses an ipkg without a recording and a file without .ipkg', () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'other.ipkg'), 'package other\n');
      const unknown = runTool('idris2', ['--dump-ipkg-json', 'other.ipkg'], { cwd: dir });
      assertExit(unknown, 2);
      assert.match(unknown.stderr, /no recorded --dump-ipkg-json output/);
      // processPackage: putStrLn ("Packages must have an '.ipkg' extension: " ++ show file ++ "."), exit 1.
      const notIpkg = runTool('idris2', ['--dump-ipkg-json', 'other.txt'], { cwd: dir });
      assertExit(notIpkg, 1);
      assert.strictEqual(notIpkg.stdout, `Packages must have an '.ipkg' extension: "other.txt".\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FAKE_IDRIS2_VERSION simulates a development build on the command line and in IDE mode', () => {
    const env = { FAKE_IDRIS2_VERSION: '0.8.0-1c630e67c' };
    const version = runTool('idris2', ['--version'], { env });
    assertExit(version, 0);
    assert.strictEqual(version.stdout, 'Idris 2, version 0.8.0-1c630e67c\n');
    // Protocol/IDE/Result.idr: the tag is the one string of the second list.
    const ide = runTool('idris2', ['--ide-mode'], { env, input: frame('(:version 7)') });
    assertExit(ide, 1); // end of input after a complete request: `Alas…`, exit 1 (F5)
    assert.strictEqual(
      ide.stdout,
      '000018(:protocol-version 2 1)\n' +
        '00002a(:return (:ok ((0 8 0) ("1c630e67c"))) 7)\n' +
        'Alas the file is done, aborting\n',
    );
  });

  test('a FAKE_IDRIS2_VERSION without the version shape is printed as is, and refused in IDE mode', () => {
    const env = { FAKE_IDRIS2_VERSION: 'unknown' };
    const version = runTool('idris2', ['--version'], { env });
    assertExit(version, 0);
    assert.strictEqual(version.stdout, 'Idris 2, version unknown\n');
    assertExit(runTool('idris2', ['--ide-mode'], { env, input: '' }), 2);
  });
});

suite('fake tools: faults', () => {
  test('fail: a line on stderr, nothing on stdout, exit 1', () => {
    for (const [tool, prefix] of [['idris2', 'FAKE_IDRIS2'], ['idris2-lsp', 'FAKE_IDRIS2_LSP'], ['pack', 'FAKE_PACK']] as const) {
      const result = runTool(tool, ['--version'], { env: { [`${prefix}_MODE`]: 'fail' } });
      assertExit(result, 1);
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, /simulated failure/);
    }
  });

  test('garbage: idris2 --version does not print a version line', () => {
    const result = runTool('idris2', ['--version'], { env: { FAKE_IDRIS2_MODE: 'garbage' } });
    assertExit(result, 0);
    assert.ok(!result.stdout.startsWith('Idris 2, version '), result.stdout);
  });

  test('hang: no output until FAKE_TOOL_HANG_LIMIT_MS, then exit 1', () => {
    const started = Date.now();
    const result = runTool('idris2', ['--version'], {
      env: { FAKE_IDRIS2_MODE: 'hang', FAKE_TOOL_HANG_LIMIT_MS: '300' },
    });
    assertExit(result, 1);
    assert.ok(Date.now() - started >= 300, `${Date.now() - started} ms`);
    assert.strictEqual(result.stdout, '');
  });

  test('delay: the normal answer after FAKE_IDRIS2_DELAY_MS', () => {
    const started = Date.now();
    const result = runTool('idris2', ['--ttc-version'], { env: { FAKE_IDRIS2_DELAY_MS: '300' } });
    assertExit(result, 0);
    assert.ok(Date.now() - started >= 300, `${Date.now() - started} ms`);
    assert.strictEqual(result.stdout, RECORDED.flags['--ttc-version'].stdout);
  });

  test('a mode the fakes do not know is a test error (exit 2)', () => {
    const result = runTool('idris2', ['--version'], { env: { FAKE_IDRIS2_MODE: 'crash' } });
    assertExit(result, 2);
    assert.match(result.stderr, /FAKE_IDRIS2_MODE must be one of/);
  });
});

suite('fake tools: idris2-lsp and pack', () => {
  test('idris2-lsp --version prints the two lines of printVersion', () => {
    const result = runTool('idris2-lsp', ['--version']);
    assertExit(result, 0);
    assert.strictEqual(result.stdout, 'Idris2 LSP: 0.1.0-9a2f0ad6a\nIdris2 API: 0.8.0\n');
  });

  test('idris2-lsp: FAKE_IDRIS2_LSP_VERSION and FAKE_IDRIS2_LSP_API_VERSION set the two versions', () => {
    const result = runTool('idris2-lsp', ['--version'], {
      env: { FAKE_IDRIS2_LSP_VERSION: '0.1.0', FAKE_IDRIS2_LSP_API_VERSION: '0.7.0-abcdef012' },
    });
    assertExit(result, 0);
    assert.strictEqual(result.stdout, 'Idris2 LSP: 0.1.0\nIdris2 API: 0.7.0-abcdef012\n');
  });

  test('idris2-lsp answers other arguments, and garbage mode, with "Invalid Arguments" (exit 0)', () => {
    for (const [args, env] of [[['--help'], {}], [['--version'], { FAKE_IDRIS2_LSP_MODE: 'garbage' }]] as const) {
      const result = runTool('idris2-lsp', args, { env });
      assertExit(result, 0);
      assert.strictEqual(result.stdout, 'Invalid Arguments\n');
    }
  });

  test('idris2-lsp without arguments (the server, M5) is not implemented: exit 2', () => {
    assertExit(runTool('idris2-lsp', []), 2);
  });

  test('pack rejects commands other than its wrapper queries, and FAKE_PACK_LOG records every call', () => {
    const dir = tempDir();
    try {
      const log = path.join(dir, 'pack.log');
      const result = runTool('pack', ['install-app', 'idris2-lsp'], { env: { FAKE_PACK_LOG: log }, cwd: dir });
      assertExit(result, 2);
      const lines = fs.readFileSync(log, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
      assert.strictEqual(lines.length, 1);
      assert.deepStrictEqual(lines[0].args, ['install-app', 'idris2-lsp']);
      // .native resolves Windows short (8.3) names, which a temporary path may contain.
      assert.strictEqual(fs.realpathSync.native(lines[0].cwd), fs.realpathSync.native(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The environment of a process that should see only `layout`: pack's own location variables
 * are removed, so a runner that sets them (e.g. XDG_STATE_HOME) does not redirect fake-pack.
 */
function layoutEnv(layout: PackLayout, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const cleared = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'PACK_USER_DIR', 'PACK_STATE_DIR', 'PACK_BIN_DIR'];
  return { ...Object.fromEntries(cleared.map((key) => [key, undefined])), ...layout.env, ...extra };
}

suite('fake tools: simulated pack layout', function () {
  let home: string;

  setup(function () {
    if (WINDOWS) {
      this.skip(); // pack's wrappers are sh scripts (packLayout.ts)
    }
    home = tempDir();
  });

  teardown(() => {
    if (home !== undefined) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("default layout: pack's directories under $HOME, the collection in <state>/pack.toml", () => {
    const layout = buildPackLayout({ home });
    assert.deepStrictEqual(layout.env, { HOME: home });
    assert.strictEqual(layout.configDir, path.join(home, '.config', 'pack'));
    assert.strictEqual(layout.stateDir, path.join(home, '.local', 'state', 'pack'));
    assert.strictEqual(layout.binDir, path.join(home, '.local', 'bin'));
    assert.match(fs.readFileSync(path.join(layout.stateDir, 'pack.toml'), 'utf8'), /^collection = "nightly-260924"$/m);
    assert.ok(!fs.existsSync(path.join(layout.configDir, 'pack.toml')));
    assert.ok(!fs.existsSync(layout.collectionBinDir));
    assert.strictEqual(fs.readlinkSync(path.join(layout.binDir, 'pack')), layout.installed.pack);
    for (const tool of TOOLS) {
      assert.ok((fs.statSync(layout.bin[tool] as string).mode & 0o111) !== 0, tool);
      assert.ok((fs.statSync(layout.installed[tool] as string).mode & 0o111) !== 0, tool);
    }
  });

  test("running pack's idris2 wrapper runs pack (app-path and the path queries), then the compiler", () => {
    const layout = buildPackLayout({ home });
    const log = path.join(home, 'pack.log');
    const result = run(layout.bin.idris2 as string, ['--version'], { env: layoutEnv(layout, { FAKE_PACK_LOG: log }) });
    assertExit(result, 0);
    assert.strictEqual(result.stdout, RECORDED.flags['--version'].stdout);
    const calls = fs.readFileSync(log, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line).args.join(' '));
    assert.deepStrictEqual(calls, ['app-path idris2', 'package-path', 'libs-path', 'data-path']);
  });

  test('XDG layout: the variables in env, and the wrappers find their binaries through them', () => {
    const layout = buildPackLayout({ home, xdg: true, collection: 'nightly-251231', globalCollection: 'nightly-250101' });
    assert.deepStrictEqual(layout.env, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
      XDG_STATE_HOME: path.join(home, 'xdg', 'state'),
    });
    assert.strictEqual(layout.stateDir, path.join(home, 'xdg', 'state', 'pack'));
    assert.match(fs.readFileSync(path.join(layout.stateDir, 'pack.toml'), 'utf8'), /^collection = "nightly-251231"$/m);
    assert.strictEqual(fs.readFileSync(path.join(layout.configDir, 'pack.toml'), 'utf8'), 'collection = "nightly-250101"\n');
    const result = run(layout.bin['idris2-lsp'] as string, ['--version'], { env: layoutEnv(layout) });
    assertExit(result, 0);
    assert.strictEqual(result.stdout, 'Idris2 LSP: 0.1.0-9a2f0ad6a\nIdris2 API: 0.8.0\n');
  });

  test("a wrapper whose application is gone prints pack's fatal message and exits 2", () => {
    const layout = buildPackLayout({ home });
    fs.rmSync(layout.installed['idris2-lsp'] as string);
    const result = run(layout.bin['idris2-lsp'] as string, ['--version'], { env: layoutEnv(layout) });
    assertExit(result, 2);
    assert.match(result.stderr, /^\[ fatal \] Package `idris2-lsp` is not built or not installed/m);
  });

  test("only the tools asked for; the README's install/<collection>/bin on request", () => {
    const layout = buildPackLayout({ home, tools: ['idris2'], collectionBinTools: ['idris2-lsp'], stateToml: false });
    assert.deepStrictEqual(Object.keys(layout.bin), ['idris2']);
    assert.ok(!fs.existsSync(path.join(layout.binDir, 'pack')));
    assert.ok(!fs.existsSync(path.join(layout.stateDir, 'pack.toml')));
    assert.strictEqual(layout.collectionBinDir, path.join(layout.stateDir, 'install', 'nightly-260924', 'bin'));
    assert.deepStrictEqual(fs.readdirSync(layout.collectionBinDir), ['idris2-lsp']);
  });
});
