// toolchain/service.ts with fakes for the runner, the settings and workspace trust. The search
// runs on the real file system, in a temporary directory holding empty executable files that
// are never run: every "process" is answered by the fake runner.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolchainSettings } from '../../src/core/config';
import { Emitter } from '../../src/core/event';
import type { Log } from '../../src/core/log';
import { createToolchainService } from '../../src/toolchain/service';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  RescanReason,
  ToolchainService,
  ToolchainSnapshot,
} from '../../src/toolchain/types';

const WINDOWS = process.platform === 'win32';

function ok(stdout: string): ProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1 };
}

const RESPONSES: Record<string, ProcessResult> = {
  'idris2 --version': ok('Idris 2, version 0.8.0\n'),
  'idris2 --ttc-version': ok('2025081600\n'),
  'idris2 --paths': ok('+ Working Directory      :: "/x"\n+ Source Directory       :: Nothing\n'),
  'idris2 --list-packages': ok('Idris2 TTC Version: 2025081600\n─────\nbase (0.8.0)\n  ├ TTC Versions: 2025081600\n  └ /lib\n'),
  'idris2-lsp --version': ok('Idris2 LSP: 0.1.0-9a2f0ad12\nIdris2 API: 0.8.0\n'),
};

/** `idris2 --version` for a request, from the executable's base name. */
function key(request: ProcessRequest): string {
  const tool = path.basename(request.executable).replace(/\.(exe|cmd)$/i, '');
  return [tool, ...request.args].join(' ');
}

class FakeRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];
  responses: Record<string, ProcessResult | Error> = { ...RESPONSES };
  /** While set, every run waits for it. */
  gate: Promise<void> | undefined;

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    await this.gate;
    const response = this.responses[key(request)];
    if (response instanceof Error) {
      throw response;
    }
    return response ?? { ...ok(''), exitCode: 1, stderr: `no response for ${key(request)}` };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const silentLog: Log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface Harness {
  readonly service: ToolchainService;
  readonly runner: FakeRunner;
  readonly trust: { isTrusted: boolean; readonly granted: Emitter<void> };
  readonly settings: { value: ToolchainSettings };
  readonly changeSettings: (next: Partial<ToolchainSettings>) => void;
  /** The number of `onDidChange` events so far. */
  readonly events: () => number;
}

suite('toolchain/service', () => {
  let root: string;
  let home: string;
  let bin: string;
  let empty: string;
  const harnesses: Harness[] = [];

  /** An empty executable file `name` in `dir` (`name.exe` on Windows). */
  function executable(dir: string, name: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, WINDOWS ? `${name}.exe` : name);
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o755);
    return file;
  }

  /** The Extension Host's environment: the search path, and HOME, which places pack's directories. */
  function environment(pathDirs: string[]): Record<string, string> {
    return WINDOWS ? { Path: pathDirs.join(';'), PATHEXT: '.EXE', HOME: home } : { PATH: pathDirs.join(':'), HOME: home };
  }

  function start(options: { trusted?: boolean; settings?: Partial<ToolchainSettings>; pathDirs?: string[] } = {}): Harness {
    const runner = new FakeRunner();
    const trust = { isTrusted: options.trusted ?? true, granted: new Emitter<void>() };
    const changed = new Emitter<void>();
    const settings = {
      value: {
        idris2Path: '',
        lspPath: '',
        packPath: '',
        preferPack: false,
        env: {},
        ignoredEnvEntries: [],
        ...options.settings,
      } as ToolchainSettings,
    };
    const service = createToolchainService({
      config: {
        toolchain: () => settings.value,
        onDidChange: (_group, listener) => changed.event(listener),
      },
      trust: {
        get isTrusted() {
          return trust.isTrusted;
        },
        onDidGrant: trust.granted.event,
      },
      runner,
      log: silentLog,
      platform: process.platform,
      homeDir: home,
      processEnv: environment(options.pathDirs ?? [bin]),
    });
    let count = 0;
    service.onDidChange(() => count++);
    const harness: Harness = {
      service,
      runner,
      trust,
      settings,
      changeSettings: (next) => {
        settings.value = { ...settings.value, ...next };
        changed.fire();
      },
      events: () => count,
    };
    harnesses.push(harness);
    return harness;
  }

  /** Resolves with `current` once no scan runs and `current` has at least `generation`. */
  function settled(service: ToolchainService, generation = 1): Promise<ToolchainSnapshot> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        const current = service.current;
        if (!service.scanning && current !== undefined && current.generation >= generation) {
          resolve(current);
          return true;
        }
        return false;
      };
      if (!check()) {
        const subscription = service.onDidChange(() => {
          if (check()) {
            subscription.dispose();
          }
        });
      }
    });
  }

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-service-'));
    home = path.join(root, 'home');
    bin = path.join(root, 'bin');
    empty = path.join(root, 'empty');
    fs.mkdirSync(home);
    fs.mkdirSync(empty);
    executable(bin, 'idris2');
    executable(bin, 'idris2-lsp');
  });

  teardown(() => {
    harnesses.splice(0).forEach((h) => h.service.dispose());
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a trusted scan probes idris2 and idris2-lsp in order and judges the pair', async () => {
    const { service, runner } = start({ settings: { env: { IDRIS2_PREFIX: '/p' } } });
    const snapshot = await settled(service);
    assert.deepStrictEqual(runner.calls.map(key), [
      'idris2 --version',
      'idris2 --ttc-version',
      'idris2 --paths',
      'idris2 --list-packages',
      'idris2-lsp --version',
    ]);
    for (const call of runner.calls) {
      assert.deepStrictEqual(call.env, { IDRIS2_PREFIX: '/p' });
      assert.strictEqual(call.timeoutMs, 5_000);
      assert.strictEqual(call.cwd, undefined, "the runner's default: the executable's directory");
    }
    assert.strictEqual(snapshot.generation, 1);
    assert.strictEqual(snapshot.reason, 'activation');
    assert.strictEqual(snapshot.trusted, true);
    assert.strictEqual(snapshot.idris2.status, 'probed');
    if (snapshot.idris2.status === 'probed') {
      assert.strictEqual(snapshot.idris2.location.path, path.join(bin, WINDOWS ? 'idris2.exe' : 'idris2'));
      assert.strictEqual(snapshot.idris2.location.source, 'PATH');
      assert.strictEqual(snapshot.idris2.info.version?.text, '0.8.0');
      assert.strictEqual(snapshot.idris2.info.ttcVersion, '2025081600');
      assert.ok(snapshot.idris2.info.pathsText?.startsWith('+ Working Directory'));
      assert.deepStrictEqual(snapshot.idris2.info.packages?.map((p) => p.name), ['base']);
      assert.strictEqual(snapshot.idris2.info.probes.length, 4);
    }
    assert.strictEqual(snapshot.lsp.status, 'probed');
    assert.strictEqual(snapshot.verdict?.kind, 'compatible');
    assert.strictEqual(snapshot.pack.status, 'missing');
    assert.deepStrictEqual(snapshot.errors, []);
  });

  test('Restricted Mode: tools are located, nothing is run, the verdict is unknown', async () => {
    const { service, runner } = start({ trusted: false });
    const snapshot = await settled(service);
    assert.deepStrictEqual(runner.calls, []);
    assert.strictEqual(snapshot.trusted, false);
    assert.strictEqual(snapshot.idris2.status, 'located');
    assert.strictEqual(snapshot.lsp.status, 'located');
    assert.strictEqual(snapshot.verdict?.kind, 'unknown');
    assert.ok(snapshot.verdict?.reason.includes('Restricted Mode'));
  });

  test('granting trust rescans and probes', async () => {
    const { service, runner, trust } = start({ trusted: false });
    await settled(service);
    trust.isTrusted = true;
    trust.granted.fire();
    const snapshot = await settled(service, 2);
    assert.strictEqual(snapshot.reason, 'trustGranted');
    assert.strictEqual(snapshot.idris2.status, 'probed');
    assert.strictEqual(runner.calls.length, 5);
  });

  test('idris2 --version failing: failed with the reason, no further idris2 probe', async () => {
    const { service, runner } = start();
    runner.responses['idris2 --version'] = { ...ok(''), exitCode: 2, stderr: '\nApplication idris2 is not installed.\nmore\n' };
    const snapshot = await settled(service);
    assert.deepStrictEqual(runner.calls.map(key), ['idris2 --version', 'idris2-lsp --version']);
    assert.strictEqual(snapshot.idris2.status, 'failed');
    if (snapshot.idris2.status === 'failed') {
      assert.strictEqual(snapshot.idris2.reason, 'idris2 --version exited with code 2: Application idris2 is not installed.');
      assert.strictEqual(snapshot.idris2.probes.length, 1);
    }
    assert.strictEqual(snapshot.verdict?.kind, 'unknown');
  });

  test('a --version without the version line, and a timed-out server probe, are failures', async () => {
    const { service, runner } = start();
    runner.responses['idris2 --version'] = ok('Usage: idris2 [options]\n');
    runner.responses['idris2-lsp --version'] = { ...ok(''), exitCode: null, signal: 'SIGTERM', timedOut: true };
    const snapshot = await settled(service);
    assert.ok(snapshot.idris2.status === 'failed' && snapshot.idris2.reason.includes('no line starting "Idris 2, version "'));
    assert.ok(snapshot.lsp.status === 'failed' && snapshot.lsp.reason === 'idris2-lsp --version did not finish within 5 s and was stopped.');
  });

  test('failed secondary probes leave their fields undefined and the tool probed', async () => {
    const { service, runner } = start();
    runner.responses['idris2 --ttc-version'] = { ...ok('2025081600\n'), exitCode: 1 };
    runner.responses['idris2 --paths'] = ok('something else\n');
    runner.responses['idris2 --list-packages'] = ok('Idris2 TTC Version: 2025081600\n');
    const snapshot = await settled(service);
    assert.strictEqual(snapshot.idris2.status, 'probed');
    if (snapshot.idris2.status === 'probed') {
      assert.strictEqual(snapshot.idris2.info.ttcVersion, undefined);
      assert.strictEqual(snapshot.idris2.info.pathsText, undefined);
      assert.strictEqual(snapshot.idris2.info.packages, undefined);
      assert.strictEqual(snapshot.idris2.info.probes.length, 4);
    }
  });

  test('a configured path that does not exist is missing even though idris2 is on PATH', async () => {
    const configured = path.join(root, 'nowhere', 'idris2');
    const { service, runner } = start({ settings: { idris2Path: configured } });
    const snapshot = await settled(service);
    assert.strictEqual(snapshot.idris2.status, 'missing');
    if (snapshot.idris2.status === 'missing') {
      // On Windows a configured path is tried with each runnable PATHEXT extension, as cmd.exe
      // resolves a typed path (discover.ts module comment); this suite's PATHEXT is `.EXE`.
      assert.deepStrictEqual(snapshot.idris2.searched, [WINDOWS ? `${configured}.exe` : configured]);
      assert.ok(snapshot.idris2.reason.includes('does not exist'));
    }
    assert.deepStrictEqual(runner.calls.map(key), ['idris2-lsp --version']);
    assert.ok(snapshot.verdict?.reason.includes('idris2 was not found'));
  });

  test('idris2.toolchain.env PATH is the PATH the search reads', async () => {
    const { service } = start({ pathDirs: [empty], settings: { env: environment([bin]) } });
    const snapshot = await settled(service);
    assert.ok(snapshot.idris2.status === 'probed' && snapshot.idris2.location.detail === `PATH entry ${bin}`);
  });

  test('pack: found with its layout; its idris2-lsp pairs by version', async () => {
    const packBin = path.join(home, '.local', 'bin');
    executable(packBin, 'pack');
    const lsp = executable(packBin, 'idris2-lsp');
    fs.mkdirSync(path.join(home, '.local', 'state', 'pack'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'state', 'pack', 'pack.toml'), 'collection = "nightly-260924"\n');
    const { service, runner } = start({ pathDirs: [empty], settings: { idris2Path: path.join(bin, WINDOWS ? 'idris2.exe' : 'idris2') } });
    runner.responses['idris2-lsp --version'] = ok('Idris2 LSP: 0.1.0\nIdris2 API: 0.8.0-1c630e6a2\n');
    const snapshot = await settled(service);
    assert.strictEqual(snapshot.pack.status, 'found');
    if (snapshot.pack.status === 'found') {
      assert.strictEqual(snapshot.pack.info.location.source, 'pack');
      assert.strictEqual(snapshot.pack.info.collection, 'nightly-260924');
      assert.strictEqual(snapshot.pack.info.stateDir, path.join(home, '.local', 'state', 'pack'));
      assert.strictEqual(snapshot.pack.info.collectionBinDir, undefined);
    }
    assert.ok(snapshot.lsp.status === 'probed' && snapshot.lsp.location.path === lsp);
    assert.strictEqual(snapshot.verdict?.kind, 'likelyMismatch');
    assert.ok(snapshot.verdict?.reason.includes("idris2-lsp was found in pack's directories"));
    assert.ok(!runner.calls.some((c) => key(c).startsWith('pack')), 'pack is never run');
  });

  test("pack's directories follow HOME of the effective environment (idris2.toolchain.env), as pack's do", async () => {
    const other = path.join(root, 'other-home');
    const pack = executable(path.join(other, '.local', 'bin'), 'pack');
    executable(path.join(home, '.local', 'bin'), 'pack');
    const { service } = start({ pathDirs: [empty], settings: { env: { HOME: other } } });
    const snapshot = await settled(service);
    assert.ok(snapshot.pack.status === 'found', JSON.stringify(snapshot.pack));
    assert.strictEqual(snapshot.pack.info.location.path, pack);
    assert.strictEqual(snapshot.pack.info.stateDir, path.join(other, '.local', 'state', 'pack'));
  });

  test('after a follow-up probe times out, the remaining ones are not run and are recorded as such', async () => {
    const { service, runner } = start();
    runner.responses['idris2 --ttc-version'] = { ...ok(''), exitCode: null, signal: 'SIGKILL', timedOut: true, durationMs: 7_000 };
    const snapshot = await settled(service);
    assert.deepStrictEqual(runner.calls.map(key), ['idris2 --version', 'idris2 --ttc-version', 'idris2-lsp --version']);
    assert.ok(snapshot.idris2.status === 'probed', JSON.stringify(snapshot.idris2));
    const info = snapshot.idris2.info;
    assert.deepStrictEqual(info.notRun, { after: ['--ttc-version'], probes: [['--paths'], ['--list-packages']] });
    assert.strictEqual(info.ttcVersion, undefined);
    assert.strictEqual(info.pathsText, undefined);
    assert.strictEqual(info.packages, undefined);
    assert.deepStrictEqual(
      info.probes.map((probe) => probe.args),
      [['--version'], ['--ttc-version']],
    );
    // A failure that is not a time-out does not stop the others.
    runner.responses['idris2 --ttc-version'] = { ...ok(''), exitCode: 1 };
    runner.calls.length = 0;
    const next = await service.rescan('command');
    assert.strictEqual(runner.calls.length, 5);
    assert.ok(next.idris2.status === 'probed' && next.idris2.info.notRun === undefined);
  });

  test('an unexpected runner rejection is a failed tool and a scan error, not a lost scan', async () => {
    const { service, runner } = start();
    runner.responses['idris2-lsp --version'] = new Error('boom');
    const snapshot = await settled(service);
    assert.ok(snapshot.lsp.status === 'failed' && snapshot.lsp.reason.includes('boom'));
    assert.strictEqual(snapshot.errors.length, 1);
    assert.strictEqual(snapshot.idris2.status, 'probed');
  });

  suite('scheduling', () => {
    test('a settings change rescans with the new settings', async () => {
      const { service, changeSettings } = start();
      await settled(service);
      changeSettings({ idris2Path: path.join(root, 'nowhere') });
      const snapshot = await settled(service, 2);
      assert.strictEqual(snapshot.reason, 'settingsChanged');
      assert.strictEqual(snapshot.idris2.status, 'missing');
      assert.strictEqual(snapshot.settings.idris2Path, path.join(root, 'nowhere'));
    });

    test('requests during a scan share one queued scan, which starts after it and sees later settings', async () => {
      const { service, runner, settings, events } = start();
      const gate = deferred();
      runner.gate = gate.promise;
      // Scan 1 (activation) is waiting in its first probe.
      assert.strictEqual(service.scanning, true);
      assert.strictEqual(service.current, undefined);
      assert.strictEqual(events(), 0, 'the first event fired before anyone could subscribe');
      settings.value = { ...settings.value, preferPack: true };
      const reasons: RescanReason[] = ['command', 'command'];
      const requests = reasons.map((reason) => service.rescan(reason));
      runner.gate = undefined;
      gate.resolve();
      const [a, b] = await Promise.all(requests);
      assert.strictEqual(a, b, 'both requests get the same snapshot');
      assert.strictEqual(a.generation, 2);
      assert.strictEqual(a.reason, 'command');
      assert.strictEqual(a.settings.preferPack, true);
      assert.strictEqual(service.current, a);
      assert.strictEqual(service.scanning, false);
      // Scan 1 finished with scan 2 queued (one event: current changed), scan 2 finished and
      // scanning stopped (one event).
      assert.strictEqual(events(), 2);
    });

    test('a request when idle starts a scan at once; scanning and current each fire onDidChange', async () => {
      const { service, events } = start();
      await settled(service);
      const before = events();
      const request = service.rescan('command');
      assert.strictEqual(service.scanning, true);
      assert.strictEqual(events(), before + 1);
      const snapshot = await request;
      assert.strictEqual(snapshot.generation, 2);
      assert.strictEqual(events(), before + 2);
    });

    test('a listener that rescans from onDidChange gets a new scan', async () => {
      const { service } = start();
      await settled(service);
      let requested: Promise<ToolchainSnapshot> | undefined;
      const subscription = service.onDidChange(() => {
        if (requested === undefined && !service.scanning) {
          requested = service.rescan('command');
        }
      });
      await service.rescan('command');
      subscription.dispose();
      assert.ok(requested !== undefined);
      const snapshot = await requested;
      assert.strictEqual(snapshot.generation, 3);
      assert.strictEqual(service.scanning, false);
    });

    test('dispose: no probe starts after it, a queued scan is rejected, events stop, later requests reject', async () => {
      const { service, runner, changeSettings, events } = start();
      const gate = deferred();
      runner.gate = gate.promise;
      // Scan 1 (activation) searches the file system first; dispose while its first probe runs.
      while (runner.calls.length === 0) {
        await new Promise((r) => setImmediate(r));
      }
      const queued = service.rescan('command');
      service.dispose();
      await assert.rejects(queued, /disposed/);
      const before = events();
      gate.resolve();
      // The fake runner answers at once, so a scan that went on would have made its four other
      // probes by the time a timer fires.
      await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(runner.calls.map(key), ['idris2 --version'], 'no probe started after dispose');
      changeSettings({ preferPack: true });
      assert.strictEqual(events(), before);
      assert.strictEqual(service.current, undefined, 'the scan that was running when disposed is not published');
      await assert.rejects(service.rescan('command'), /disposed/);
    });
  });
});
