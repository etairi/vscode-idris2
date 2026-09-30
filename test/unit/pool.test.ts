// backend/ide/pool.ts: the session pool against FakeTransport, a fake clock, a fake toolchain,
// fake settings and a fake consent gate. Covers the command line of ARCHITECTURE §5.2 (every
// flag and its condition, D5/F12 build directories on POSIX and Windows, stdio by default on
// every platform, ROADMAP §9 Q20), what runs before a spawn (trust, toolchain scan, consent,
// re-reading the snapshot), restarts on settings, toolchain and package changes (only when the
// command line changes), consent withdrawn, the Stop/Restart commands, idris2.ideMode.maxSessions
// (ROADMAP §9 Q21), events and dispose. No process is started.
import * as assert from 'assert';
import type { IdeModeSettings, SettingsChange } from '../../src/core/config';
import type { IDisposable } from '../../src/core/disposable';
import { IdrisException } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { GateVerdict, PermitReason, SessionGate } from '../../src/core/trust';
import { checkBuildDir, createTunedSessionPool, EVAL_IDLE_TIMEOUT_MS, evalBuildDir, extraArgsProblem, launchDifferences, sessionLaunch } from '../../src/backend/ide/pool';
import { DEFAULT_SESSION_TIMING } from '../../src/backend/ide/session';
import type { IdeSession, Reply, SessionLaunch, SessionPool, SessionPoolChange } from '../../src/backend/ide/types';
import type { Classification, IpkgModel, ProjectRoot } from '../../src/project/types';
import type { Idris2Info, ToolState } from '../../src/toolchain/types';
import { FakeToolchain, IDRIS2_PATH, idris2Probed, location, LOOSE, missing, projectRoot, snapshot, SETTINGS } from './support/toolchainFixtures';
import { FakeClock, FakeTransports, flush, jsonCodec, recordingLog, RecordingTrace, ret, typeOf } from './support/fakeTransport';

const DEFAULTS: IdeModeSettings = {
  transport: 'stdio',
  isolateBuildDir: true,
  loosePackages: [],
  extraArgs: [],
  requestTimeoutMs: 5_000,
  longActionTimeoutMs: 60_000,
  idleTimeoutMs: 600_000,
  maxSessions: 0,
  maxBackgroundChecks: 0,
};

/** The setting (relative to `idris2.`) behind each field of `IdeModeSettings`. */
const SETTING_KEYS: Record<keyof IdeModeSettings, string> = {
  transport: 'ideMode.transport',
  isolateBuildDir: 'ideMode.isolateBuildDir',
  loosePackages: 'ideMode.loosePackages',
  extraArgs: 'ideMode.extraArgs',
  requestTimeoutMs: 'ideMode.requestTimeout',
  longActionTimeoutMs: 'ideMode.longActionTimeout',
  idleTimeoutMs: 'ideMode.idleTimeout',
  maxSessions: 'ideMode.maxSessions',
  maxBackgroundChecks: 'ideMode.maxBackgroundChecks',
};

class FakeConfig {
  settings: IdeModeSettings = DEFAULTS;
  private readonly changed = new Emitter<SettingsChange>();

  ideMode(): IdeModeSettings {
    return this.settings;
  }

  onDidChange(group: string, listener: (change: SettingsChange) => void): IDisposable {
    return group === 'ideMode' ? this.changed.event(listener) : { dispose: () => undefined };
  }

  /** Changes `settings` and tells the listeners which keys changed, as VS Code does. */
  set(settings: Partial<IdeModeSettings>): void {
    this.settings = { ...this.settings, ...settings };
    const keys = Object.keys(settings).map((field) => SETTING_KEYS[field as keyof IdeModeSettings]);
    this.changed.fire({ affects: (key) => keys.some((changed) => changed === key || changed.startsWith(`${key}.`)) });
  }
}

const ALLOWED: GateVerdict = { allowed: true, basis: 'workspaceFolder' };

/** A gate whose answers the test sets; `manual` keeps each question open until `answer`. */
class FakeGate implements SessionGate {
  readonly asked: string[] = [];
  readonly reasons: (PermitReason | undefined)[] = [];
  readonly verdicts = new Map<string, GateVerdict | undefined>();
  manual = false;
  private readonly open: Array<{ dir: string; resolve(verdict: GateVerdict): void }> = [];
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  permit(dir: string, why?: PermitReason): Promise<GateVerdict> {
    this.asked.push(dir);
    this.reasons.push(why);
    if (this.manual) {
      return new Promise((resolve) => this.open.push({ dir, resolve }));
    }
    return Promise.resolve(this.current(dir) ?? ALLOWED);
  }

  current(dir: string): GateVerdict | undefined {
    return this.verdicts.has(dir) ? this.verdicts.get(dir) : ALLOWED;
  }

  /** The directories rechecked; a verdict in `rechecked` stands for what `recheck` finds now. */
  readonly rechecks: string[] = [];
  readonly rechecked = new Map<string, GateVerdict | undefined>();

  recheck(dir: string): Promise<GateVerdict | undefined> {
    this.rechecks.push(dir);
    return Promise.resolve(this.rechecked.has(dir) ? this.rechecked.get(dir) : this.current(dir));
  }

  answer(verdict: GateVerdict): void {
    for (const question of this.open.splice(0)) {
      question.resolve(verdict);
    }
  }

  fire(): void {
    this.changed.fire();
  }
}

function setup(options: { platform?: NodeJS.Platform; trusted?: boolean; toolchain?: FakeToolchain } = {}) {
  const toolchain = options.toolchain ?? new FakeToolchain(snapshot());
  const config = new FakeConfig();
  const gate = new FakeGate();
  const trust = { isTrusted: options.trusted ?? true, onDidGrant: new Emitter<void>().event };
  const clock = new FakeClock();
  const transports = new FakeTransports();
  const log = recordingLog();
  const trace = new RecordingTrace();
  const pool: SessionPool = createTunedSessionPool(
    {
      toolchain,
      projects: { sessionCwd: (root: Classification) => root.dir },
      config,
      trust,
      gate,
      codec: jsonCodec,
      trace,
      log,
      platform: options.platform ?? 'darwin',
      processEnv: {},
    },
    { timing: DEFAULT_SESSION_TIMING, clock, createTransport: transports.create },
  );
  const changes: SessionPoolChange[] = [];
  pool.onDidChange((change) => changes.push(change));
  return { pool, toolchain, config, gate, trust, clock, transports, log, changes };
}

/** Sends a lookup and answers it; resolves with the reply and the transport that carried it. */
async function answered(h: ReturnType<typeof setup>, session: IdeSession): Promise<Reply> {
  const reply = session.request(typeOf('x'), { kind: 'lookup' });
  await flush();
  const t = h.transports.last();
  t.message(ret(t.lastSent().id));
  return reply;
}

/** The fixtures' probed 0.8.0 compiler, found at `path`. */
function probedAt(path: string): ToolState<Idris2Info> {
  const probed = idris2Probed();
  if (probed.status !== 'probed') {
    throw new Error('fixture');
  }
  return { ...probed, location: location('idris2', path) };
}

function withModel(fields: Partial<IpkgModel>, dir = '/w/simple-ipkg'): ProjectRoot {
  const root = projectRoot({ dir, ipkgPath: `${dir}/simple-ipkg.ipkg` });
  if (root.model.status !== 'ok') {
    throw new Error('fixture');
  }
  return { ...root, model: { ...root.model, model: { ...root.model.model, ...fields } } };
}

const withBuilddir = (builddir: string, dir = '/w/simple-ipkg'): ProjectRoot => withModel({ builddir }, dir);

const BROKEN_IPKG: ProjectRoot = projectRoot({
  model: { status: 'error', source: 'dump-json', error: { message: 'Error: Unrecognised property "pkgs".' } },
});

suite('backend/ide/pool', () => {
  suite('the command line (ARCHITECTURE §5.2)', () => {
    const base = { cwd: '/w/simple-ipkg', idris2: IDRIS2_PATH, env: { IDRIS2_PREFIX: '/p' }, platform: 'darwin' as const };

    test('a project: stdio by default, --no-color, --build-dir <root>/build/.vscode-idris2 when there is no builddir, extraArgs last; no -p', () => {
      const launch = sessionLaunch({ ...base, root: projectRoot(), settings: { ...DEFAULTS, loosePackages: ['contrib'], extraArgs: ['--log', '1'] } });
      assert.deepStrictEqual(launch, {
        executable: IDRIS2_PATH,
        args: ['--ide-mode', '--no-color', '--build-dir', '/w/simple-ipkg/build/.vscode-idris2', '--log', '1'],
        cwd: '/w/simple-ipkg',
        env: { IDRIS2_PREFIX: '/p' },
        transport: 'stdio',
      } satisfies SessionLaunch);
    });

    test('Q20: the default settings give stdio (--ide-mode) on every platform; the socket only when chosen, then on every platform', () => {
      // Decided by the user on 2026-09-28 (ROADMAP §9 Q20). Before, the default `auto` gave
      // --ide-mode-socket on macOS and Linux.
      const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'];
      for (const platform of platforms) {
        const dir = platform === 'win32' ? 'C:\\w\\simple-ipkg' : '/w/simple-ipkg';
        const chosen = sessionLaunch({ ...base, cwd: dir, root: projectRoot({ dir, ipkgPath: `${dir}/simple-ipkg.ipkg` }), settings: DEFAULTS, platform });
        assert.strictEqual(chosen.transport, 'stdio', platform);
        assert.deepStrictEqual(chosen.args.slice(0, 2), ['--ide-mode', '--no-color'], platform);
        assert.ok(!chosen.args.includes('--ide-mode-socket'), platform);
        const socket = sessionLaunch({ ...base, cwd: dir, root: projectRoot({ dir, ipkgPath: `${dir}/simple-ipkg.ipkg` }), settings: { ...DEFAULTS, transport: 'socket' }, platform });
        assert.strictEqual(socket.transport, 'socket', platform);
        assert.deepStrictEqual(socket.args.slice(0, 2), ['--ide-mode-socket', '--no-color'], platform);
      }
    });

    test('a loose file: -p for each loose package; stdio by default, on Windows too; never --find-ipkg', () => {
      const loose = sessionLaunch({ ...base, cwd: LOOSE.dir, root: LOOSE, settings: { ...DEFAULTS, loosePackages: ['contrib', 'network'] } });
      assert.deepStrictEqual(loose.args, ['--ide-mode', '--no-color', '-p', 'contrib', '-p', 'network', '--build-dir', '/w/loose-file/build/.vscode-idris2']);
      assert.strictEqual(loose.transport, 'stdio');
      const windows = sessionLaunch({ ...base, cwd: 'C:\\w\\loose', root: { kind: 'loose', dir: 'C:\\w\\loose' }, settings: DEFAULTS, platform: 'win32' });
      assert.deepStrictEqual(windows.args, ['--ide-mode', '--no-color', '--build-dir', 'C:\\w\\loose\\build\\.vscode-idris2']);
      assert.strictEqual(windows.transport, 'stdio');
      const explicit = sessionLaunch({ ...base, root: projectRoot(), settings: { ...DEFAULTS, transport: 'socket' }, platform: 'win32' });
      assert.strictEqual(explicit.transport, 'socket');
      for (const launch of [loose, windows, explicit]) {
        assert.ok(!launch.args.includes('--find-ipkg'));
      }
    });

    test('F12/D5: with a builddir no --build-dir is passed; with isolation off none either', () => {
      const withOut = sessionLaunch({ ...base, root: withBuilddir('out'), settings: DEFAULTS });
      assert.deepStrictEqual(withOut.args, ['--ide-mode', '--no-color']);
      const off = sessionLaunch({ ...base, root: projectRoot(), settings: { ...DEFAULTS, isolateBuildDir: false } });
      assert.deepStrictEqual(off.args, ['--ide-mode', '--no-color']);
      const broken = sessionLaunch({ ...base, root: BROKEN_IPKG, settings: DEFAULTS });
      assert.deepStrictEqual(broken.args.slice(2), ['--build-dir', '/w/simple-ipkg/build/.vscode-idris2'], 'an unreadable .ipkg counts as one without builddir');
    });

    test('effectiveCheckBuildDir: isolated, builddir relative or absolute, isolation off; POSIX and Windows', () => {
      const on = { isolateBuildDir: true, extraArgs: [] };
      const offSettings = { isolateBuildDir: false, extraArgs: [] };
      assert.deepStrictEqual(checkBuildDir(projectRoot(), '/w/simple-ipkg', on, 'linux'), { dir: '/w/simple-ipkg/build/.vscode-idris2', isolated: true });
      assert.deepStrictEqual(checkBuildDir(projectRoot(), '/w/simple-ipkg', offSettings, 'linux'), { dir: '/w/simple-ipkg/build', isolated: false });
      assert.deepStrictEqual(checkBuildDir(withBuilddir('out'), '/w/simple-ipkg', on, 'linux'), { dir: '/w/simple-ipkg/out', isolated: false });
      assert.deepStrictEqual(checkBuildDir(withBuilddir('../shared/b'), '/w/simple-ipkg', on, 'linux'), { dir: '/w/shared/b', isolated: false });
      assert.deepStrictEqual(checkBuildDir(withBuilddir('/abs/b'), '/w/simple-ipkg', on, 'linux'), { dir: '/abs/b', isolated: false });
      assert.deepStrictEqual(checkBuildDir(LOOSE, LOOSE.dir, on, 'linux'), { dir: '/w/loose-file/build/.vscode-idris2', isolated: true });
      assert.deepStrictEqual(checkBuildDir(withBuilddir('out', 'C:\\w\\p'), 'C:\\w\\p', on, 'win32'), { dir: 'C:\\w\\p\\out', isolated: false });
      assert.deepStrictEqual(checkBuildDir(LOOSE, 'C:\\w\\p', on, 'win32'), { dir: 'C:\\w\\p\\build\\.vscode-idris2', isolated: true });

      const h = setup();
      assert.strictEqual(h.pool.effectiveCheckBuildDir(projectRoot()), '/w/simple-ipkg/build/.vscode-idris2');
      assert.strictEqual(h.pool.effectiveCheckBuildDir(withBuilddir('out')), '/w/simple-ipkg/out');
      h.config.set({ isolateBuildDir: false });
      assert.strictEqual(h.pool.effectiveCheckBuildDir(projectRoot()), '/w/simple-ipkg/build');
    });

    test('F12 addendum: a --build-dir in the .ipkg\'s opts wins over builddir and the command line; one in extraArgs over isolation', () => {
      const on = { isolateBuildDir: true, extraArgs: [] };
      // The compiler applies opts after builddir at every load (Idris/Package.idr 1093–1110 [src]),
      // and opts over the command line's --build-dir [live, M2 second review].
      assert.deepStrictEqual(checkBuildDir(withModel({ opts: '--build-dir build' }), '/w/simple-ipkg', on, 'linux'), { dir: '/w/simple-ipkg/build', isolated: false });
      assert.deepStrictEqual(checkBuildDir(withModel({ builddir: 'out', opts: '--total\t--build-dir  ../b --build-dir\u00a0c' }), '/w/simple-ipkg', on, 'linux'), {
        dir: '/w/simple-ipkg/c',
        isolated: false,
      }, 'the last one, words split as the compiler\'s words splits them');
      assert.deepStrictEqual(checkBuildDir(withModel({ builddir: 'out', opts: '--total' }), '/w/simple-ipkg', on, 'linux'), { dir: '/w/simple-ipkg/out', isolated: false });
      // A --build-dir without its directory fails the whole parse: none of the options applies.
      assert.deepStrictEqual(checkBuildDir(withModel({ opts: '--build-dir x --build-dir' }), '/w/simple-ipkg', on, 'linux'), { dir: '/w/simple-ipkg/build/.vscode-idris2', isolated: true });
      // extraArgs come after the extension's --build-dir on the command line; an ipkg setting still wins.
      const args = { isolateBuildDir: true, extraArgs: ['--build-dir', 'mine', '--log', '1'] };
      assert.deepStrictEqual(checkBuildDir(projectRoot(), '/w/simple-ipkg', args, 'linux'), { dir: '/w/simple-ipkg/mine', isolated: false });
      assert.deepStrictEqual(checkBuildDir(LOOSE, LOOSE.dir, args, 'linux'), { dir: '/w/loose-file/mine', isolated: false });
      assert.deepStrictEqual(checkBuildDir(withBuilddir('out'), '/w/simple-ipkg', args, 'linux'), { dir: '/w/simple-ipkg/out', isolated: false });
      // No --build-dir of the extension's own then, and effectiveCheckBuildDir names the directory used.
      const launch = sessionLaunch({ ...base, root: withModel({ opts: '--build-dir build' }), settings: DEFAULTS });
      assert.deepStrictEqual(launch.args, ['--ide-mode', '--no-color']);
      assert.deepStrictEqual(sessionLaunch({ ...base, root: projectRoot(), settings: { ...DEFAULTS, ...args } }).args, ['--ide-mode', '--no-color', '--build-dir', 'mine', '--log', '1']);
      const h = setup();
      assert.strictEqual(h.pool.effectiveCheckBuildDir(withModel({ opts: '--build-dir build' })), '/w/simple-ipkg/build');
      h.config.set({ extraArgs: ['--build-dir', '/tmp/b'] });
      assert.strictEqual(h.pool.effectiveCheckBuildDir(projectRoot()), '/tmp/b');
    });

    test('launchDifferences names what changed', () => {
      const a = sessionLaunch({ ...base, root: projectRoot(), settings: DEFAULTS });
      assert.deepStrictEqual(launchDifferences(a, a), []);
      assert.deepStrictEqual(launchDifferences(a, { ...a, executable: '/b/idris2', env: {}, args: ['--ide-mode-socket'], transport: 'socket' }), [
        `idris2 ${IDRIS2_PATH} → /b/idris2`,
        'transport stdio → socket',
        'arguments',
        'environment (idris2.toolchain.env)',
      ]);
    });

    test('a request starts the process with that command line and the snapshot environment', async () => {
      const h = setup({ toolchain: new FakeToolchain(snapshot({ settings: { ...SETTINGS, env: { IDRIS2_PACKAGE_PATH: '/pkgs' } } })) });
      const session = h.pool.sessionFor(projectRoot(), 'check');
      await answered(h, session);
      assert.deepStrictEqual(h.transports.last().launch, {
        executable: IDRIS2_PATH,
        args: ['--ide-mode', '--no-color', '--build-dir', '/w/simple-ipkg/build/.vscode-idris2'],
        cwd: '/w/simple-ipkg',
        env: { IDRIS2_PACKAGE_PATH: '/pkgs' },
        transport: 'stdio',
      } satisfies SessionLaunch);
    });

    test('Q20: opting into the socket in the settings restarts the running session with --ide-mode-socket; going back restarts it with --ide-mode', async () => {
      const h = setup();
      const session = h.pool.sessionFor(projectRoot(), 'check');
      await answered(h, session);
      assert.strictEqual(h.transports.last().launch.transport, 'stdio');
      h.config.set({ transport: 'socket' });
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      assert.strictEqual(h.transports.all[0].stopCalls, 1);
      assert.deepStrictEqual(h.transports.last().launch.args.slice(0, 2), ['--ide-mode-socket', '--no-color']);
      assert.strictEqual(h.changes.find((c) => c.change.cause === 'reconfigure')?.change.detail, 'the idris2.ideMode settings changed: transport stdio → socket, arguments');
      h.config.set({ transport: 'stdio' });
      await flush();
      assert.strictEqual(h.transports.all.length, 3);
      assert.strictEqual(h.transports.last().launch.transport, 'stdio');
    });
  });

  suite('sessions', () => {
    test('one session per root and role, created stopped; sessionFor starts nothing', () => {
      const h = setup();
      const a = h.pool.sessionFor(LOOSE, 'check');
      assert.strictEqual(h.pool.sessionFor({ kind: 'loose', dir: LOOSE.dir }, 'check'), a);
      const project = h.pool.sessionFor(projectRoot({ dir: LOOSE.dir, ipkgPath: `${LOOSE.dir}/x.ipkg` }), 'check');
      assert.notStrictEqual(project, a, 'a project root and a loose directory are different roots');
      assert.strictEqual(a.state, 'stopped');
      assert.strictEqual(a.cwd, LOOSE.dir);
      assert.strictEqual(a.role, 'check');
      assert.deepStrictEqual(h.pool.sessions(), [a, project]);
      assert.strictEqual(h.transports.all.length, 0);
      assert.deepStrictEqual(h.gate.asked, []);
    });

    test('state changes are forwarded with their session', async () => {
      const h = setup();
      const session = h.pool.sessionFor(LOOSE, 'check');
      await answered(h, session);
      assert.ok(h.changes.length >= 4);
      assert.ok(h.changes.every((c) => c.session === session));
      assert.deepStrictEqual(h.changes.map((c) => c.change.cause).slice(0, 2), ['start', 'handshake']);
    });

    test('a protocol version above 2.1 is logged once for the pool', async () => {
      const h = setup();
      h.transports.behaviour = { handshake: [2, 2] };
      await answered(h, h.pool.sessionFor(LOOSE, 'check'));
      await answered(h, h.pool.sessionFor(projectRoot(), 'check'));
      assert.strictEqual(h.log.lines.filter((l) => l.startsWith('warn: ') && l.endsWith('some answers may be misread')).length, 1);
    });
  });

  suite('before a spawn: trust, toolchain, consent', () => {
    test('startProblem: what prepare refuses before the question — Restricted Mode, no idris2 (after a running scan), extraArgs — asking and starting nothing', async () => {
      // What the checks learn before they ask the consent question themselves (M2 verification of the
      // Q20–Q22 fixes, the verifier's probe L4).
      const untrusted = setup({ trusted: false });
      assert.strictEqual((await untrusted.pool.startProblem())?.error.kind, 'Unsupported');
      const none = setup({ toolchain: new FakeToolchain(snapshot({ idris2: missing('idris2 was not found on PATH or in the usual places.') })) });
      assert.strictEqual((await none.pool.startProblem())?.message, 'No Idris 2 compiler to start: idris2 was not found on PATH or in the usual places.');
      const scanning = setup({ toolchain: new FakeToolchain(undefined) });
      scanning.toolchain.setScanning(true);
      let result: IdrisException | undefined | 'pending' = 'pending';
      void scanning.pool.startProblem().then((problem) => (result = problem));
      await flush();
      assert.strictEqual(result, 'pending', 'waits for the scan');
      scanning.toolchain.publish();
      await flush();
      assert.strictEqual(result, undefined);
      const h = setup();
      h.config.set({ extraArgs: ['--ide-mode-socket'] });
      assert.match((await h.pool.startProblem())?.message ?? '', /idris2\.ideMode\.extraArgs contains "--ide-mode-socket"/);
      h.config.set({ extraArgs: [] });
      assert.strictEqual(await h.pool.startProblem(), undefined);
      for (const each of [untrusted, none, scanning, h]) {
        assert.deepStrictEqual(each.gate.asked, [], 'nobody is asked');
        assert.strictEqual(each.transports.all.length, 0, 'nothing is started');
      }
    });

    test('Restricted Mode: Unsupported, nobody is asked, nothing is started', async () => {
      const h = setup({ trusted: false });
      await assert.rejects(
        h.pool.sessionFor(LOOSE, 'check').request(typeOf('x'), { kind: 'lookup' }),
        (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported' && /Restricted Mode/.test(e.message),
      );
      assert.deepStrictEqual(h.gate.asked, []);
      assert.strictEqual(h.transports.all.length, 0);
    });

    test('a running scan (or the first) is waited for before the gate is asked; the new idris2 is started', async () => {
      const h = setup({ toolchain: new FakeToolchain(undefined) });
      h.toolchain.setScanning(true);
      const session = h.pool.sessionFor(LOOSE, 'check');
      const reply = session.request(typeOf('x'), { kind: 'lookup' });
      await flush();
      assert.deepStrictEqual(h.gate.asked, []);
      h.toolchain.publish({ idris2: probedAt('/opt/new/bin/idris2') });
      await flush();
      assert.deepStrictEqual(h.gate.asked, [LOOSE.dir]);
      const t = h.transports.last();
      assert.strictEqual(t.launch.executable, '/opt/new/bin/idris2');
      t.message(ret(t.lastSent().id));
      await reply;
    });

    test('the gate is told why: the root\'s .ipkg, or none for a loose file', async () => {
      const h = setup();
      await answered(h, h.pool.sessionFor(projectRoot(), 'check'));
      await answered(h, h.pool.sessionFor(LOOSE, 'check'));
      assert.deepStrictEqual(h.gate.reasons, [{ ipkg: projectRoot().ipkgPath }, { ipkg: undefined }]);
    });

    test('after its last wait the pool has the gate judge the directory again, as it is now: a changed or unresolvable directory is not started in', async () => {
      const h = setup();
      await answered(h, h.pool.sessionFor(LOOSE, 'check'));
      assert.deepStrictEqual(h.gate.rechecks, [LOOSE.dir], 'the last step before the spawn');
      const session = h.pool.sessionFor(projectRoot(), 'check');
      // Replaced by a symbolic link to a folder that would need a question since permit said yes.
      h.gate.rechecked.set(projectRoot().dir, undefined);
      await assert.rejects(session.request(typeOf('x'), { kind: 'lookup' }), /running Idris 2 in “\/w\/simple-ipkg” is no longer allowed/);
      h.gate.rechecked.set(projectRoot().dir, { allowed: false, reason: 'unresolved' });
      await assert.rejects(
        session.request(typeOf('x'), { kind: 'lookup' }),
        (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported' && /its real path could not be read/.test(e.message),
      );
      assert.strictEqual(h.transports.all.length, 1, 'only the loose session\'s process');
    });

    test('the process is started in the real path the last verdict judged, not through the spelled one; that is no change of the command line', async () => {
      // M2 second verification of the third review: spawned in the spelled path, whose symbolic links
      // the child resolves when it changes into it, a link re-pointed after the verdict moved it.
      const h = setup();
      h.gate.rechecked.set(LOOSE.dir, { allowed: true, basis: 'workspaceFolder', realDir: '/private/w/loose-file' });
      const session = h.pool.sessionFor(LOOSE, 'check');
      await answered(h, session);
      const t = h.transports.last();
      assert.strictEqual(t.launch.realCwd, '/private/w/loose-file');
      assert.strictEqual(t.launch.cwd, LOOSE.dir, 'the session directory as spelled, for the command line and the messages');
      h.config.set({ requestTimeoutMs: 9_000 });
      await flush();
      assert.strictEqual(h.transports.all.length, 1, 'not restarted: the real path is not part of the command line');
      // The isolated build directory is placed in the real path too (verification after Q20–Q22:
      // built from the spelled one, a link on it re-pointed during a load redirected the TTCs).
      assert.deepStrictEqual(t.launch.args.slice(-2), ['--build-dir', '/private/w/loose-file/build/.vscode-idris2']);
      assert.strictEqual(h.pool.effectiveCheckBuildDir(LOOSE), '/private/w/loose-file/build/.vscode-idris2');
      // A load compares the command line built on that same real path: no restart at every load.
      assert.strictEqual(h.pool.sessionFor(LOOSE, 'check'), session);
      await answered(h, session);
      assert.strictEqual(h.transports.all.length, 1, 'not restarted by a load');
      // A change that alters the command line restarts it once, in the real path judged again.
      h.config.set({ loosePackages: ['contrib'] });
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      assert.deepStrictEqual(h.transports.last().launch.args.slice(-4), ['-p', 'contrib', '--build-dir', '/private/w/loose-file/build/.vscode-idris2']);
      await answered(h, session);
      assert.strictEqual(h.transports.all.length, 2);
      // Windows: the spelled path (a mapped drive's real path is a UNC path, which cmd.exe may refuse, pool.ts).
      const w = setup({ platform: 'win32' });
      w.gate.rechecked.set(LOOSE.dir, { allowed: true, basis: 'workspaceFolder', realDir: '\\\\server\\share\\loose-file' });
      await answered(w, w.pool.sessionFor(LOOSE, 'check'));
      assert.strictEqual(w.transports.last().launch.realCwd, undefined);
    });

    test('an extraArgs with --ide-mode-socket or --ide-mode starts nothing and says why; also when it is set while the question is open', async () => {
      // Verification after Q20–Q22: the compiler takes --ide-mode-socket from anywhere on its command
      // line (socket mode wins), so a workspace's extraArgs opened the port past the transport's
      // user-settings-only rule, and past the takeover detection (the launch said stdio).
      const socketArgs = /idris2\.ideMode\.extraArgs contains "--ide-mode-socket"\. The transport is chosen by idris2\.ideMode\.transport/;
      const h = setup();
      h.config.set({ extraArgs: ['--ide-mode-socket'] });
      await assert.rejects(h.pool.sessionFor(LOOSE, 'check').request(typeOf('x'), { kind: 'lookup' }), socketArgs);
      assert.deepStrictEqual(h.gate.asked, [], 'nobody is asked: nothing would start');
      h.config.set({ extraArgs: ['-p', 'contrib', '--ide-mode', 'localhost:1'] });
      await assert.rejects(h.pool.sessionFor(LOOSE, 'check').request(typeOf('x'), { kind: 'lookup' }), /contains "--ide-mode"\./);
      assert.strictEqual(h.transports.all.length, 0);
      // Set while the question waits: judged again right before the command line is built.
      h.config.set({ extraArgs: [] });
      h.gate.manual = true;
      const reply = h.pool.sessionFor(LOOSE, 'check').request(typeOf('x'), { kind: 'lookup' });
      await flush();
      h.config.set({ extraArgs: ['--log', '1', '--ide-mode-socket'] });
      h.gate.answer(ALLOWED);
      await assert.rejects(reply, socketArgs);
      assert.strictEqual(h.transports.all.length, 0);
      // Other arguments start as before.
      h.gate.manual = false;
      h.config.set({ extraArgs: ['--log', '1'] });
      await answered(h, h.pool.sessionFor(LOOSE, 'check'));
      assert.deepStrictEqual(h.transports.last().launch.args.slice(-2), ['--log', '1']);
      assert.strictEqual(extraArgsProblem(['--ide-mode-socket=x']), undefined, 'the parser knows no "=" form: an unknown flag, not the socket');
    });

    test('a folder revoked while the start waits for a scan after the question: nothing is started in it', async () => {
      const h = setup();
      h.gate.manual = true;
      const session = h.pool.sessionFor(LOOSE, 'check');
      const outcome = session.request(typeOf('x'), { kind: 'lookup' }).then(
        () => 'resolved',
        (e: unknown) => (e instanceof IdrisException ? `${e.error.kind}: ${e.message}` : 'other'),
      );
      await flush();
      h.toolchain.setScanning(true); // a scan starts while the question is open
      h.gate.answer({ allowed: true, basis: 'always' });
      await flush();
      assert.strictEqual(h.transports.all.length, 0, 'the start waits for the scan');
      // Revoked (Manage Allowed Folders…) meanwhile: the gate forgets the folder. Its change event
      // does not reach the session, which is still stopped.
      h.gate.verdicts.set(LOOSE.dir, undefined);
      h.gate.fire();
      assert.strictEqual(session.state, 'stopped');
      h.toolchain.publish({});
      assert.strictEqual(await outcome, 'Unsupported: running Idris 2 in “/w/loose-file” is no longer allowed');
      await flush();
      assert.strictEqual(h.transports.all.length, 0, 'no process in the revoked folder');
      assert.strictEqual(session.state, 'stopped');
      // Denied meanwhile: the refusal names it.
      h.gate.verdicts.delete(LOOSE.dir);
      const denied = session.request(typeOf('x'), { kind: 'lookup' }).then(
        () => 'resolved',
        (e: unknown) => (e instanceof IdrisException ? e.message : 'other'),
      );
      await flush();
      h.toolchain.setScanning(true);
      h.gate.answer({ allowed: true, basis: 'window' });
      await flush();
      h.gate.verdicts.set(LOOSE.dir, { allowed: false, reason: 'denied' });
      h.toolchain.publish({});
      assert.match(await denied, /not started in “\/w\/loose-file”: "Don't Allow" was chosen/);
      assert.strictEqual(h.transports.all.length, 0);
    });

    test('no probed idris2: ToolchainMissing with the reason, and nobody is asked', async () => {
      const h = setup({ toolchain: new FakeToolchain(snapshot({ idris2: missing('idris2 was not found on PATH or in the usual places.') })) });
      await assert.rejects(
        h.pool.sessionFor(LOOSE, 'check').request(typeOf('x'), { kind: 'lookup' }),
        (e: unknown) =>
          e instanceof IdrisException && e.error.kind === 'ToolchainMissing' && e.message === 'No Idris 2 compiler to start: idris2 was not found on PATH or in the usual places.',
      );
      assert.deepStrictEqual(h.gate.asked, []);
    });

    test('the gate refuses: Unsupported with the reason and how to allow; asked again at the next start', async () => {
      const h = setup();
      h.gate.verdicts.set(LOOSE.dir, { allowed: false, reason: 'denied' });
      const session = h.pool.sessionFor(LOOSE, 'check');
      await assert.rejects(
        session.request(typeOf('x'), { kind: 'lookup' }),
        (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported' && /not started in “\/w\/loose-file”: "Don't Allow" was chosen.*status item offers to allow it/.test(e.message),
      );
      h.gate.verdicts.set(LOOSE.dir, { allowed: false, reason: 'unanswered' });
      await assert.rejects(session.request(typeOf('x'), { kind: 'lookup' }), /closed without an answer\. The Idris 2 status item offers to ask again/);
      assert.deepStrictEqual(h.gate.asked, [LOOSE.dir, LOOSE.dir]);
      assert.strictEqual(session.state, 'stopped');
      assert.strictEqual(h.transports.all.length, 0);
    });

    test('while the question is open nothing starts; the snapshot is read again after the answer', async () => {
      const h = setup();
      h.gate.manual = true;
      const session = h.pool.sessionFor(LOOSE, 'check');
      const reply = session.request(typeOf('x'), { kind: 'lookup' });
      await flush();
      assert.strictEqual(session.state, 'stopped');
      assert.strictEqual(h.transports.all.length, 0);
      h.toolchain.publish({ idris2: probedAt('/opt/other/idris2') });
      h.gate.answer({ allowed: true, basis: 'window' });
      await flush();
      const t = h.transports.last();
      assert.strictEqual(t.launch.executable, '/opt/other/idris2');
      t.message(ret(t.lastSent().id));
      await reply;
    });
  });

  suite('restarts on changes', () => {
    test('a snapshot naming another idris2 restarts the running session with the new command line; an equal one does not', async () => {
      const h = setup();
      const session = h.pool.sessionFor(projectRoot(), 'check');
      await answered(h, session);
      h.toolchain.publish({});
      await flush();
      assert.strictEqual(h.transports.all.length, 1, 'same idris2 and environment: kept');
      h.toolchain.publish({ idris2: probedAt('/w/fake-tools/bin/idris2-second') });
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      assert.strictEqual(h.transports.all[0].stopCalls, 1);
      assert.strictEqual(h.transports.last().launch.executable, '/w/fake-tools/bin/idris2-second');
      assert.strictEqual(session.state, 'ready');
      const restart = h.changes.find((c) => c.change.cause === 'reconfigure');
      assert.strictEqual(restart?.change.detail, `a new toolchain scan: idris2 ${IDRIS2_PATH} → /w/fake-tools/bin/idris2-second`);
    });

    test('a settings change during a load restarts only when the command line changes; time limits apply to the next request', async () => {
      const h = setup();
      const session = h.pool.sessionFor(LOOSE, 'check');
      await answered(h, session);
      const first = h.transports.last();
      h.config.set({ requestTimeoutMs: 9_000, idleTimeoutMs: 0 });
      await flush();
      assert.strictEqual(h.transports.all.length, 1, 'no restart for time limits');
      const load = session.request(typeOf('load'), { kind: 'load', file: { path: '/w/loose-file/A.idr' } });
      const lookup = session.request(typeOf('later'), { kind: 'lookup' });
      const loadOutcome = load.then(
        () => 'resolved',
        (e: unknown) => (e instanceof IdrisException ? e.error.kind : e instanceof Error ? e.name : 'other'),
      );
      await flush();
      h.config.set({ extraArgs: ['--quiet'] });
      assert.strictEqual(await loadOutcome, 'Cancelled', 'abandoned by the restart, not failed');
      await flush();
      assert.strictEqual(first.stopCalls, 1);
      const second = h.transports.last();
      assert.notStrictEqual(second, first);
      assert.deepStrictEqual(second.launch.args.slice(-1), ['--quiet']);
      assert.deepStrictEqual(h.clock.pending(), [9_000], 'the queued lookup, sent to the new process with the new limit');
      second.message(ret(second.lastSent().id));
      await lookup;
    });

    test('failed sessions return to stopped on a settings change and on a new snapshot', async () => {
      const h = setup();
      h.transports.behaviour = { handshake: [1, 0] };
      const session = h.pool.sessionFor(LOOSE, 'check');
      await assert.rejects(session.request(typeOf('x'), { kind: 'lookup' }), /speaks version 1\.0/);
      assert.strictEqual(session.state, 'failed');
      h.config.set({ extraArgs: [] });
      assert.strictEqual(session.state, 'stopped');
      await assert.rejects(session.request(typeOf('x'), { kind: 'lookup' }), /speaks version 1\.0/);
      h.toolchain.publish({});
      assert.strictEqual(session.state, 'stopped');
      assert.strictEqual(h.transports.all.length, 2, 'nothing is started until a request');
    });

    test('sessionFor with a changed classification restarts a running session whose command line changes (a builddir appears)', async () => {
      const h = setup();
      const session = h.pool.sessionFor(projectRoot(), 'check');
      await answered(h, session);
      assert.ok(h.transports.last().launch.args.includes('--build-dir'));
      assert.strictEqual(h.pool.sessionFor(projectRoot(), 'check'), session);
      assert.strictEqual(h.transports.all.length, 1);
      const changed = withBuilddir('out');
      assert.strictEqual(h.pool.sessionFor(changed, 'check'), session);
      assert.strictEqual(session.root, changed);
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      assert.ok(!h.transports.last().launch.args.includes('--build-dir'));
      assert.strictEqual(session.state, 'ready');
    });
  });

  suite('consent withdrawn, stop, restart, dispose', () => {
    test('when the gate changes, sessions it no longer allows (refused or unknown) are stopped; others keep running', async () => {
      const h = setup();
      const a = h.pool.sessionFor(LOOSE, 'check');
      const b = h.pool.sessionFor(projectRoot(), 'check');
      const c = h.pool.sessionFor({ kind: 'loose', dir: '/tmp/elsewhere' }, 'check');
      await answered(h, a);
      await answered(h, b);
      await answered(h, c);
      h.gate.verdicts.set(LOOSE.dir, { allowed: false, reason: 'denied' });
      h.gate.verdicts.set('/tmp/elsewhere', undefined);
      h.gate.fire();
      assert.strictEqual(a.state, 'stopped');
      assert.strictEqual(c.state, 'stopped');
      assert.strictEqual(b.state, 'ready');
      const causes = h.changes.filter((ch) => ch.change.cause === 'consentRevoked');
      assert.deepStrictEqual(causes.map((ch) => ch.session), [a, c]);
      assert.strictEqual(causes[1].change.detail, 'running Idris 2 in “/tmp/elsewhere” is no longer allowed');
    });

    test('a restart after a crash, refused because the session directory is gone, stops the session without calling it a revocation', async () => {
      // M2 verification of the third review: every refusal at a restart was cause `consentRevoked`,
      // which the status shows as a revoked permission and a question to come.
      for (const where of ['permit', 'recheck'] as const) {
        const h = setup();
        const session = h.pool.sessionFor(LOOSE, 'check');
        await answered(h, session);
        const unresolved: GateVerdict = { allowed: false, reason: 'unresolved', error: 'ENOENT' };
        if (where === 'permit') {
          h.gate.verdicts.set(LOOSE.dir, unresolved);
        } else {
          h.gate.rechecked.set(LOOSE.dir, unresolved);
        }
        h.transports.last().exit({ code: 1, signal: null });
        await flush();
        assert.strictEqual(session.state, 'stopped', where);
        const last = h.changes[h.changes.length - 1].change;
        assert.strictEqual(last.cause, 'spawnError', where);
        assert.match(last.detail ?? '', /its real path could not be read \(ENOENT\)/);
      }
    });

    test('stop(root) stops that root; stop() all; the next request starts again', async () => {
      const h = setup();
      const a = h.pool.sessionFor(LOOSE, 'check');
      const b = h.pool.sessionFor(projectRoot(), 'check');
      await answered(h, a);
      await answered(h, b);
      h.pool.stop(LOOSE);
      assert.strictEqual(a.state, 'stopped');
      assert.strictEqual(b.state, 'ready');
      h.pool.stop();
      assert.strictEqual(b.state, 'stopped');
      await flush();
      assert.strictEqual(h.transports.alive().length, 0);
      await answered(h, a);
      assert.strictEqual(a.state, 'ready');
      assert.strictEqual(h.changes.filter((c) => c.change.cause === 'stop').length, 2);
    });

    test('packageChanged(root): that root stops with cause packageChanged and the detail; the next request starts a process again', async () => {
      const h = setup();
      const a = h.pool.sessionFor(projectRoot(), 'check');
      const b = h.pool.sessionFor(LOOSE, 'check');
      await answered(h, a);
      await answered(h, b);
      h.pool.packageChanged(projectRoot(), 'the compiler would find /w/evil.ipkg');
      assert.strictEqual(a.state, 'stopped');
      assert.strictEqual(b.state, 'ready');
      assert.deepStrictEqual(
        h.changes.filter((c) => c.change.cause === 'packageChanged').map((c) => [c.session, c.change.detail]),
        [[a, 'the compiler would find /w/evil.ipkg']],
      );
      await flush();
      assert.strictEqual(h.transports.alive().length, 1, 'its process was stopped');
      await answered(h, a);
      assert.strictEqual(a.state, 'ready');
    });

    test('release(root) (the last document closed): that root stops with cause closed, a waiting request is dropped; failed returns to stopped', async () => {
      const h = setup();
      const a = h.pool.sessionFor(LOOSE, 'check');
      const b = h.pool.sessionFor(projectRoot(), 'check');
      await answered(h, a);
      await answered(h, b);
      h.pool.release(LOOSE);
      assert.strictEqual(a.state, 'stopped');
      assert.strictEqual(b.state, 'ready');
      assert.deepStrictEqual(
        h.changes.filter((c) => c.change.cause === 'closed').map((c) => [c.session, c.change.detail]),
        [[a, 'the last open document of its root was closed']],
      );
      await flush();
      assert.strictEqual(h.transports.alive().length, 1);

      // A request waiting for the consent question is dropped, so the answer starts nothing.
      h.gate.manual = true;
      const waiting = a.request(typeOf('x'), { kind: 'lookup' });
      const outcome = waiting.then(
        () => 'resolved',
        (e: unknown) => (e instanceof IdrisException ? e.error.kind : e instanceof Error ? e.name : 'other'),
      );
      await flush();
      h.pool.release(LOOSE);
      assert.strictEqual(await outcome, 'Cancelled');
      h.gate.answer(ALLOWED);
      await flush();
      assert.strictEqual(a.state, 'stopped');
      assert.strictEqual(h.transports.alive().length, 1);
      h.gate.manual = false;

      // The next request starts a process again.
      await answered(h, a);
      assert.strictEqual(a.state, 'ready');

      // From failed: stopped, so that the next document of the root tries again.
      const c = h.pool.sessionFor({ kind: 'loose', dir: '/w/other' }, 'check');
      h.transports.behaviour = { handshake: [1, 0] };
      await assert.rejects(c.request(typeOf('x'), { kind: 'lookup' }));
      assert.strictEqual(c.state, 'failed');
      h.transports.behaviour = {};
      h.pool.release({ kind: 'loose', dir: '/w/other' });
      assert.strictEqual(c.state, 'stopped');
      await answered(h, c);
      assert.strictEqual(c.state, 'ready');
    });

    test('restart(root) starts the check session at once, even when stopped or never used; restartAll restarts every session that is not stopped', async () => {
      const h = setup();
      h.pool.restart(LOOSE);
      await flush();
      const a = h.pool.sessionFor(LOOSE, 'check');
      assert.strictEqual(a.state, 'ready', 'created and started without a request');
      const b = h.pool.sessionFor(projectRoot(), 'check');
      const stopped = h.pool.sessionFor({ kind: 'loose', dir: '/w/idle' }, 'check');
      h.transports.behaviour = { handshake: [1, 0] };
      await assert.rejects(b.request(typeOf('x'), { kind: 'lookup' }));
      assert.strictEqual(b.state, 'failed');
      h.transports.behaviour = {};
      const before = h.transports.all.length;
      h.pool.restartAll();
      await flush();
      assert.strictEqual(a.state, 'ready');
      assert.strictEqual(b.state, 'ready', 'failed is cleared');
      assert.strictEqual(stopped.state, 'stopped');
      assert.strictEqual(h.transports.all.length, before + 2);
    });

    test('dispose kills every process at once, ends pending waits and refuses new sessions', async () => {
      const h = setup();
      const a = h.pool.sessionFor(LOOSE, 'check');
      await answered(h, a);
      h.toolchain.setScanning(true);
      const waiting = h.pool.sessionFor(projectRoot(), 'check').request(typeOf('x'), { kind: 'lookup' });
      const outcome = waiting.then(
        () => 'resolved',
        (e: unknown) => (e instanceof IdrisException ? e.error.kind : 'other'),
      );
      await flush();
      h.pool.dispose();
      assert.strictEqual(await outcome, 'BackendCrashed');
      assert.strictEqual(h.transports.all[0].disposed, true);
      assert.strictEqual(a.state, 'stopped');
      assert.throws(() => h.pool.sessionFor(LOOSE, 'check'), /disposed/);
      h.toolchain.publish({});
      await flush();
      assert.strictEqual(h.transports.all.length, 1);
    });
  });

  suite('idris2.ideMode.maxSessions (ROADMAP §9 Q21)', () => {
    const A = LOOSE;
    const B = projectRoot();
    const C: Classification = { kind: 'loose', dir: '/w/third' };

    /** The newest transport started in `dir`. */
    const transportIn = (h: ReturnType<typeof setup>, dir: string) => {
      const found = h.transports.all.filter((t) => t.launch.cwd === dir).at(-1);
      assert.ok(found, `no process in ${dir}`);
      return found;
    };

    /** Sends a lookup that stays unanswered (the session is `busy`); `answer` answers it. */
    async function busy(h: ReturnType<typeof setup>, session: IdeSession) {
      const reply = session.request(typeOf('x'), { kind: 'lookup' });
      await flush();
      const t = transportIn(h, session.cwd);
      const id = t.lastSent().id;
      return { reply, answer: () => t.message(ret(id)) };
    }

    const evictions = (h: ReturnType<typeof setup>) => h.changes.filter((c) => c.change.cause === 'evicted').map((c) => c.session.cwd);

    test('0 (the default): three roots keep their three sessions, as before', async () => {
      const h = setup();
      const sessions = [A, B, C].map((root) => h.pool.sessionFor(root, 'check'));
      for (const session of sessions) {
        await answered(h, session);
      }
      await flush();
      assert.deepStrictEqual(sessions.map((s) => s.state), ['ready', 'ready', 'ready']);
      assert.strictEqual(h.transports.alive().length, 3);
      assert.deepStrictEqual(evictions(h), []);
    });

    test('2 with three roots: the least recently used idle session is stopped (evicted) when the third starts; the others keep running', async () => {
      const h = setup();
      h.config.set({ maxSessions: 2 });
      const [a, b, c] = [A, B, C].map((root) => h.pool.sessionFor(root, 'check'));
      await answered(h, a);
      await answered(h, b);
      await flush();
      assert.deepStrictEqual(evictions(h), [], 'two are within the limit');
      await answered(h, c);
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['stopped', 'ready', 'ready']);
      assert.deepStrictEqual(evictions(h), [A.dir]);
      assert.strictEqual(transportIn(h, A.dir).stopCalls, 1);
      assert.strictEqual(h.transports.alive().length, 2);
      const change = h.changes.find((ch) => ch.change.cause === 'evicted')?.change;
      assert.match(change?.detail ?? '', /^idris2\.ideMode\.maxSessions is 2 and 3 IDE-mode sessions were running; this was the least recently used idle one/);
      // Used after b: b is the least recently used now, and nothing is over the limit.
      await answered(h, c);
      await flush();
      assert.deepStrictEqual(evictions(h), [A.dir]);
    });

    test('an eval session counts only while idle: starting an evaluation stops no other root\'s check session; once it answered it is the one stopped (fourth review of M3)', async () => {
      // Before the fix, with a limit of 2, Evaluate in A stopped B's idle check session, whose next
      // check then started a process again (and stopped the evaluation session in turn).
      const h = setup();
      h.config.set({ maxSessions: 2 });
      h.pool.setActiveRoot(A);
      const other = h.pool.sessionFor(B, 'check');
      await answered(h, other);
      const check = h.pool.sessionFor(A, 'check');
      await answered(h, check);
      await flush();
      const evaluation = h.pool.sessionFor(A, 'eval');
      const inFlight = await busy(h, evaluation);
      await flush();
      assert.deepStrictEqual([other.state, check.state, evaluation.state], ['ready', 'ready', 'busy'], 'B keeps its process while A evaluates');
      assert.strictEqual(h.transports.alive().length, 3, 'above the limit while the evaluation runs');
      inFlight.answer();
      await inFlight.reply;
      await flush();
      assert.deepStrictEqual([other.state, check.state, evaluation.state], ['ready', 'ready', 'stopped']);
      assert.deepStrictEqual(
        h.changes.filter((c) => c.change.cause === 'evicted').map((c) => c.session),
        [evaluation],
      );
      assert.strictEqual(h.transports.alive().length, 2);
    });

    test('a busy session is never stopped for the limit, even when it is the least recently used', async () => {
      const h = setup();
      h.config.set({ maxSessions: 2 });
      const [a, b, c] = [A, B, C].map((root) => h.pool.sessionFor(root, 'check'));
      const inFlight = await busy(h, a); // a's request is sent first: a was used least recently
      await answered(h, b);
      await answered(h, c);
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['busy', 'stopped', 'ready']);
      assert.deepStrictEqual(evictions(h), [B.dir]);
      inFlight.answer();
      await inFlight.reply;
      await flush();
      assert.strictEqual(a.state, 'ready', 'two run: within the limit');
    });

    test('the active document\'s session is never stopped for the limit; a change of the active root applies the limit again', async () => {
      const h = setup();
      h.config.set({ maxSessions: 2 });
      const [a, b, c] = [A, B, C].map((root) => h.pool.sessionFor(root, 'check'));
      h.pool.setActiveRoot(A);
      await answered(h, a);
      await answered(h, b);
      await answered(h, c);
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['ready', 'stopped', 'ready'], 'b, not the active a');
      // Limit 1: c is idle and not active, a is active; nothing else may go.
      h.config.set({ maxSessions: 1 });
      await flush();
      assert.deepStrictEqual([a.state, c.state], ['ready', 'stopped']);
      // a busy, c started again: two run, neither may be stopped (a busy, c active).
      h.pool.setActiveRoot(C);
      const inFlight = await busy(h, a);
      await answered(h, c);
      await flush();
      assert.deepStrictEqual([a.state, c.state], ['busy', 'ready']);
      // The active root changes to a: c (idle) goes at once.
      h.pool.setActiveRoot(A);
      await flush();
      assert.deepStrictEqual([a.state, c.state], ['busy', 'stopped']);
      inFlight.answer();
      await inFlight.reply;
      assert.deepStrictEqual(evictions(h), [B.dir, C.dir, C.dir]);
    });

    test('while the active root is pending (a file just opened is being classified) nothing is stopped for the limit', async () => {
      // Verification after Q20–Q22: the checks said "no active root" while the new active file of
      // root A was classified, and A's idle session was stopped just before that file's first load.
      const h = setup();
      h.config.set({ maxSessions: 1 });
      const [a, b] = [A, B].map((root) => h.pool.sessionFor(root, 'check'));
      h.pool.setActiveRoot(A);
      await answered(h, a);
      const inFlight = await busy(h, b);
      await flush();
      assert.deepStrictEqual([a.state, b.state], ['ready', 'busy'], 'a active, b busy: neither goes');
      h.pool.setActiveRoot('pending');
      await flush();
      assert.deepStrictEqual([a.state, evictions(h)], ['ready', []], 'pending: nothing is stopped');
      h.pool.setActiveRoot(A);
      await flush();
      assert.deepStrictEqual([a.state, evictions(h)], ['ready', []]);
      // Pending, then another root: a (idle, not active any more) goes.
      h.pool.setActiveRoot('pending');
      h.pool.setActiveRoot(C);
      await flush();
      assert.deepStrictEqual([a.state, b.state, evictions(h)], ['stopped', 'busy', [A.dir]]);
      inFlight.answer();
      await inFlight.reply;
    });

    test('while no session is idle nothing is stopped; the first to become idle is stopped then', async () => {
      const h = setup();
      h.config.set({ maxSessions: 2 });
      const [a, b, c] = [A, B, C].map((root) => h.pool.sessionFor(root, 'check'));
      const inA = await busy(h, a);
      const inB = await busy(h, b);
      const inC = await busy(h, c);
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['busy', 'busy', 'busy']);
      assert.deepStrictEqual(evictions(h), []);
      inB.answer();
      await inB.reply;
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['busy', 'stopped', 'busy']);
      inA.answer();
      inC.answer();
      await Promise.all([inA.reply, inC.reply]);
      await flush();
      assert.deepStrictEqual([a.state, c.state], ['ready', 'ready']);
      assert.deepStrictEqual(evictions(h), [B.dir]);
    });

    test('an evicted root starts again at its next request (after the gate), and the limit then stops the least recently used other one', async () => {
      const h = setup();
      h.config.set({ maxSessions: 2 });
      const [a, b, c] = [A, B, C].map((root) => h.pool.sessionFor(root, 'check'));
      await answered(h, a);
      await answered(h, b);
      await answered(h, c);
      await flush();
      assert.strictEqual(a.state, 'stopped');
      const asked = h.gate.asked.length;
      const before = h.transports.all.length;
      const reply = await answered(h, a);
      assert.strictEqual(reply.payload.kind, 'ok');
      await flush();
      assert.strictEqual(h.gate.asked.length, asked + 1, 'the gate is asked before the new process');
      assert.strictEqual(h.transports.all.length, before + 1);
      assert.strictEqual(transportIn(h, A.dir).launch.cwd, A.dir);
      assert.deepStrictEqual([a.state, b.state, c.state], ['ready', 'stopped', 'ready']);
      assert.deepStrictEqual(evictions(h), [A.dir, B.dir]);
    });

    test('settings: a lower maxSessions stops what exceeds it at once and restarts nothing; a higher one or 0 stops nothing; neither resets a failed session', async () => {
      const h = setup();
      const [a, b, c] = [A, B, C].map((root) => h.pool.sessionFor(root, 'check'));
      await answered(h, a);
      await answered(h, b);
      await answered(h, c);
      const failing = h.pool.sessionFor({ kind: 'loose', dir: '/w/failing' }, 'check');
      h.transports.behaviour = { handshake: [1, 0] };
      await assert.rejects(failing.request(typeOf('x'), { kind: 'lookup' }), /speaks version 1\.0/);
      h.transports.behaviour = {};
      assert.strictEqual(failing.state, 'failed');
      const started = h.transports.all.length;
      h.config.set({ maxSessions: 5 });
      h.config.set({ maxBackgroundChecks: 1 });
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['ready', 'ready', 'ready']);
      assert.strictEqual(failing.state, 'failed', 'a change of the limits only does not return a failed session to stopped');
      assert.deepStrictEqual(h.changes.filter((ch) => ch.change.cause === 'reconfigure'), []);
      h.config.set({ maxSessions: 1 });
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['stopped', 'stopped', 'ready'], 'the two least recently used');
      assert.strictEqual(h.transports.all.length, started, 'no process was started or restarted');
      assert.strictEqual(failing.state, 'failed');
      h.config.set({ maxSessions: 0 });
      await answered(h, a);
      await answered(h, b);
      await flush();
      assert.deepStrictEqual([a.state, b.state, c.state], ['ready', 'ready', 'ready']);
      // A setting that shapes sessions still returns failed sessions to stopped (as before).
      h.config.set({ requestTimeoutMs: 7_000 });
      assert.strictEqual(failing.state, 'stopped');
    });
  });

  // M3: the eval session of a root (types.ts SessionRole; ROADMAP §9, 2026-09-28).
  suite('the eval role (M3)', () => {
    const base = { cwd: '/w/simple-ipkg', idris2: IDRIS2_PATH, env: {}, platform: 'darwin' as const };
    const buildDirArgs = (launch: SessionLaunch) => launch.args.filter((_, i, a) => a[i - 1] === '--build-dir');

    test('its own build directory wherever the extension chooses one, isolation on or off; none where the package or extraArgs set it', () => {
      const evalOf = (root: Classification, settings: IdeModeSettings) => sessionLaunch({ ...base, role: 'eval', root, settings });
      assert.deepStrictEqual(buildDirArgs(evalOf(projectRoot(), DEFAULTS)), ['/w/simple-ipkg/build/.vscode-idris2-eval']);
      assert.deepStrictEqual(buildDirArgs(evalOf(projectRoot(), { ...DEFAULTS, isolateBuildDir: false })), ['/w/simple-ipkg/build/.vscode-idris2-eval']);
      assert.deepStrictEqual(buildDirArgs(sessionLaunch({ ...base, cwd: LOOSE.dir, role: 'eval', root: LOOSE, settings: DEFAULTS })), [`${LOOSE.dir}/build/.vscode-idris2-eval`]);
      // The compiler takes the package's directory for both sessions (F12): nothing the extension could change.
      assert.deepStrictEqual(buildDirArgs(evalOf(withBuilddir('out'), DEFAULTS)), []);
      assert.deepStrictEqual(buildDirArgs(evalOf(withModel({ opts: '--build-dir tmp' }), DEFAULTS)), []);
      assert.deepStrictEqual(evalOf(projectRoot(), { ...DEFAULTS, extraArgs: ['--build-dir', 'mine'] }).args.slice(2), ['--build-dir', 'mine']);
      assert.strictEqual(evalBuildDir(withBuilddir('out'), '/w/simple-ipkg', DEFAULTS, 'darwin'), undefined);
      // Otherwise the check session's command line: transport, -p for loose files, extraArgs last.
      const loose = sessionLaunch({ ...base, cwd: LOOSE.dir, role: 'eval', root: LOOSE, settings: { ...DEFAULTS, transport: 'socket', loosePackages: ['contrib'], extraArgs: ['--log', '1'] } });
      assert.deepStrictEqual(loose.args, ['--ide-mode-socket', '--no-color', '-p', 'contrib', '--build-dir', `${LOOSE.dir}/build/.vscode-idris2-eval`, '--log', '1']);
      // The build directory is placed in the real path the process starts in.
      assert.deepStrictEqual(buildDirArgs(sessionLaunch({ ...base, role: 'eval', root: projectRoot(), buildBase: '/private/w/simple-ipkg', settings: DEFAULTS })), ['/private/w/simple-ipkg/build/.vscode-idris2-eval']);
    });

    test('a separate session, started by its first request through the same gate, in the same directory, with its own build directory', async () => {
      const h = setup();
      const check = h.pool.sessionFor(LOOSE, 'check');
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      assert.notStrictEqual(check, evaluation);
      assert.strictEqual(evaluation.role, 'eval');
      assert.strictEqual(h.pool.sessionFor(LOOSE, 'eval'), evaluation);
      assert.strictEqual(h.transports.all.length, 0, 'nothing started by sessionFor');
      await answered(h, evaluation);
      assert.strictEqual(check.state, 'stopped');
      assert.deepStrictEqual(h.gate.asked, [LOOSE.dir]);
      const launch = h.transports.last().launch;
      assert.strictEqual(launch.cwd, LOOSE.dir);
      assert.deepStrictEqual(buildDirArgs(launch), [`${LOOSE.dir}/build/.vscode-idris2-eval`]);
      // The gate refuses the directory: the eval session is not started either.
      const refused = setup();
      refused.gate.verdicts.set(LOOSE.dir, { allowed: false, reason: 'denied' });
      await assert.rejects(refused.pool.sessionFor(LOOSE, 'eval').request(typeOf('x'), { kind: 'lookup' }), (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported');
      assert.strictEqual(refused.transports.all.length, 0);
      // Restricted Mode: nothing.
      const untrusted = setup({ trusted: false });
      await assert.rejects(untrusted.pool.sessionFor(LOOSE, 'eval').request(typeOf('x'), { kind: 'lookup' }), /Restricted Mode/);
      assert.deepStrictEqual(untrusted.gate.asked, []);
    });

    test('consent revoked: a running eval session is stopped like a check session (refused, then unknown), with cause consentRevoked', async () => {
      // Second review of M3: the gate's onDidChange loop did not look at the role, and no test ran it with an eval session.
      for (const verdict of [{ allowed: false, reason: 'denied' } as GateVerdict, undefined]) {
        const h = setup();
        const check = h.pool.sessionFor(LOOSE, 'check');
        const evaluation = h.pool.sessionFor(LOOSE, 'eval');
        await answered(h, check);
        await answered(h, evaluation);
        assert.strictEqual(evaluation.state, 'ready');
        h.gate.verdicts.set(LOOSE.dir, verdict);
        h.gate.fire();
        assert.strictEqual(evaluation.state, 'stopped', String(verdict?.allowed));
        assert.strictEqual(check.state, 'stopped');
        const causes = h.changes.filter((ch) => ch.change.cause === 'consentRevoked');
        assert.ok(causes.some((ch) => ch.session === evaluation), 'the eval session\'s stop is a revocation');
        assert.strictEqual(h.transports.all.length, 2);
      }
    });

    test('the eval session\'s start judges the directory again right before the spawn: revoked or re-pointed while it waits for a scan', async () => {
      // Second review of M3: the eval variants of the check session's tests above (the recheck after
      // the last wait, and the real path it judged).
      const h = setup();
      h.gate.manual = true;
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      const outcome = evaluation.request(typeOf('x'), { kind: 'lookup' }).then(
        () => 'resolved',
        (e: unknown) => (e instanceof IdrisException ? `${e.error.kind}: ${e.message}` : 'other'),
      );
      await flush();
      h.toolchain.setScanning(true);
      h.gate.answer({ allowed: true, basis: 'always' });
      await flush();
      assert.strictEqual(h.transports.all.length, 0, 'the start waits for the scan');
      h.gate.verdicts.set(LOOSE.dir, undefined);
      h.gate.fire();
      h.toolchain.publish({});
      assert.strictEqual(await outcome, 'Unsupported: running Idris 2 in “/w/loose-file” is no longer allowed');
      await flush();
      assert.strictEqual(h.transports.all.length, 0, 'no eval process in the revoked folder');
      assert.deepStrictEqual(h.gate.rechecks, [LOOSE.dir]);
      // Re-pointed: started in the real path the recheck found, its build directory there too.
      const r = setup();
      r.gate.rechecked.set(LOOSE.dir, { allowed: true, basis: 'workspaceFolder', realDir: '/private/w/loose-file' });
      await answered(r, r.pool.sessionFor(LOOSE, 'eval'));
      const launch = r.transports.last().launch;
      assert.strictEqual(launch.realCwd, '/private/w/loose-file');
      assert.deepStrictEqual(buildDirArgs(launch), ['/private/w/loose-file/build/.vscode-idris2-eval']);
      // Unresolvable at the recheck: nothing started.
      const u = setup();
      u.gate.rechecked.set(LOOSE.dir, { allowed: false, reason: 'unresolved' });
      await assert.rejects(u.pool.sessionFor(LOOSE, 'eval').request(typeOf('x'), { kind: 'lookup' }), /its real path could not be read/);
      assert.strictEqual(u.transports.all.length, 0);
    });

    test('a settings change stops it (it starts at the next evaluation) only when its own command line changes (isolation does not change it)', async () => {
      const h = setup();
      const check = h.pool.sessionFor(LOOSE, 'check');
      await answered(h, check);
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      await answered(h, evaluation);
      h.config.set({ isolateBuildDir: false });
      await flush();
      const restarted = h.changes.filter((c) => c.change.cause === 'reconfigure').map((c) => c.session.role);
      assert.deepStrictEqual([...new Set(restarted)], ['check']);
      assert.strictEqual(evaluation.state, 'ready');
      const before = h.transports.all.length;
      h.config.set({ loosePackages: ['contrib'] });
      await flush();
      const stopped = h.changes.filter((c) => c.session === evaluation && c.change.cause === 'reconfigure').map((c) => c.change.state);
      assert.deepStrictEqual(stopped, ['stopped'], 'stopped, not restarted');
      assert.strictEqual(evaluation.state, 'stopped');
      assert.strictEqual(h.transports.all.length, before + 1, 'only the check session got a new process');
      await answered(h, evaluation);
      assert.ok(h.transports.last().launch.args.includes('contrib'), 'the next evaluation starts it with the new command line');
    });

    test('Stop Backend and the root\'s release stop it too; Restart Backend stops it (it starts at the next evaluation) and restarts the check session', async () => {
      const h = setup();
      const check = h.pool.sessionFor(LOOSE, 'check');
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      await answered(h, check);
      await answered(h, evaluation);
      h.pool.restart(LOOSE);
      await flush();
      assert.deepStrictEqual([check.state, evaluation.state], ['ready', 'stopped']);
      assert.strictEqual(h.changes.find((c) => c.session === evaluation && c.change.state === 'stopped')?.change.cause, 'stop');
      await answered(h, evaluation);
      h.pool.stop(LOOSE);
      assert.deepStrictEqual([check.state, evaluation.state], ['stopped', 'stopped']);
      await answered(h, evaluation);
      h.pool.release(LOOSE);
      assert.strictEqual(evaluation.state, 'stopped');
    });

    test('Restart Backend for all projects restarts the check sessions and stops the eval sessions; nothing starts an eval process by itself', async () => {
      const h = setup();
      const check = h.pool.sessionFor(LOOSE, 'check');
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      const otherEval = h.pool.sessionFor(projectRoot(), 'eval');
      await answered(h, check);
      await answered(h, evaluation);
      await answered(h, otherEval);
      const before = h.transports.all.length;
      h.pool.restartAll();
      await flush();
      assert.deepStrictEqual([check.state, evaluation.state, otherEval.state], ['ready', 'stopped', 'stopped']);
      assert.strictEqual(h.transports.all.length, before + 1, 'one new process: the check session\'s');
      assert.deepStrictEqual(
        h.changes.filter((c) => c.session.role === 'eval' && c.change.state === 'stopped').map((c) => c.change.cause),
        ['stop', 'stop'],
      );
    });

    test('releaseEvaluation stops the root\'s eval session only, with the detail given; the next evaluation starts it again', async () => {
      const h = setup();
      const check = h.pool.sessionFor(LOOSE, 'check');
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      await answered(h, check);
      await answered(h, evaluation);
      h.pool.releaseEvaluation(LOOSE, 'the evaluation took 5 s');
      assert.strictEqual(evaluation.state, 'stopped');
      assert.strictEqual(check.state, 'ready');
      const last = h.changes.filter((ch) => ch.session === evaluation).at(-1)?.change;
      assert.deepStrictEqual([last?.cause, last?.detail], ['stop', 'the evaluation took 5 s']);
      h.pool.releaseEvaluation(projectRoot(), 'x'); // no eval session there: nothing
      await answered(h, evaluation);
      assert.strictEqual(h.transports.all.length, 3, 'started again by its next request');
    });

    test('cancelEvaluation stops the root\'s eval session only (its evaluation was cancelled); the next evaluation starts it again', async () => {
      const h = setup();
      const check = h.pool.sessionFor(LOOSE, 'check');
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      await answered(h, check);
      await answered(h, evaluation);
      const running = evaluation.request(typeOf('loop'), { kind: 'longAction' });
      await flush();
      h.pool.cancelEvaluation(LOOSE);
      await assert.rejects(running, (e: unknown) => e instanceof Error && e.name === 'Cancelled' && /Evaluate Selection was cancelled/.test(e.message));
      assert.deepStrictEqual([check.state, evaluation.state], ['ready', 'stopped']);
      h.pool.cancelEvaluation(projectRoot()); // no eval session there: nothing
      await answered(h, evaluation);
      assert.strictEqual(evaluation.state, 'ready');
    });

    test('its idle limit is idris2.ideMode.idleTimeout, at most 2 min (EVAL_IDLE_TIMEOUT_MS); 0 still means never', async () => {
      const h = setup();
      const check = h.pool.sessionFor(LOOSE, 'check');
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      await answered(h, check);
      await answered(h, evaluation);
      assert.strictEqual(EVAL_IDLE_TIMEOUT_MS, 120_000);
      h.clock.advance(EVAL_IDLE_TIMEOUT_MS);
      await flush();
      assert.deepStrictEqual([check.state, evaluation.state], ['ready', 'stopped']);
      assert.strictEqual(h.changes.find((c) => c.session === evaluation && c.change.state === 'stopped')?.change.cause, 'idle');
      // A shorter setting applies to both.
      h.config.set({ idleTimeoutMs: 30_000 });
      await answered(h, evaluation);
      h.clock.advance(30_000);
      await flush();
      assert.deepStrictEqual([check.state, evaluation.state], ['ready', 'stopped']);
      // 0: never, the eval session included.
      h.config.set({ idleTimeoutMs: 0 });
      await answered(h, evaluation);
      h.clock.advance(24 * 60 * 60_000);
      await flush();
      assert.strictEqual(evaluation.state, 'ready');
    });

    test('maxSessions counts it; idle eval sessions go first, the active root\'s included, before any check session', async () => {
      const B = projectRoot();
      const h = setup();
      h.config.set({ maxSessions: 1 });
      h.pool.setActiveRoot(LOOSE);
      const check = h.pool.sessionFor(LOOSE, 'check');
      await answered(h, check);
      const evaluation = h.pool.sessionFor(LOOSE, 'eval');
      await answered(h, evaluation);
      await flush();
      // Two run for a limit of 1: the active root's eval session goes once idle, its check session
      // stays. (An evaluation keeps its session busy from its load to its answer, the :interpret
      // queued behind the load: backendIde.test.ts, "evaluation with the real session pool".)
      assert.deepStrictEqual([check.state, evaluation.state], ['ready', 'stopped']);
      const evicted = h.changes.find((c) => c.change.cause === 'evicted');
      assert.strictEqual(evicted?.session, evaluation);
      assert.match(evicted.change.detail ?? '', /this was an idle evaluation session, which starts again at the next evaluation$/);

      // Three idle sessions, then a limit of 2: the eval session goes, although another root's check
      // session is the least recently used.
      const h2 = setup();
      h2.pool.setActiveRoot(LOOSE);
      const other = h2.pool.sessionFor(B, 'check');
      await answered(h2, other);
      const check2 = h2.pool.sessionFor(LOOSE, 'check');
      await answered(h2, check2);
      const evaluation2 = h2.pool.sessionFor(LOOSE, 'eval');
      await answered(h2, evaluation2);
      h2.config.set({ maxSessions: 2 });
      await flush();
      assert.deepStrictEqual([other.state, check2.state, evaluation2.state], ['ready', 'ready', 'stopped']);
      // Limit 1: then the other root's check session, never the active root's.
      h2.config.set({ maxSessions: 1 });
      await flush();
      assert.deepStrictEqual([other.state, check2.state], ['stopped', 'ready']);
    });
  });
});
