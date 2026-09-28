// The session layer end to end against the fake compiler (test/fake-idris2) started through its
// launcher (test/fake-tools/bin): the pool, real transports over stdio and the socket, the real
// codec (protocol.ts), the fake's M0 behaviour (handshake, :version, F4 errors), a recorded
// load replayed from test/fixtures/transcripts, and the fake's injected protocol faults
// (FAKE_IDRIS2_IDE_FAULT: crash, noise, id-mismatch, hang). FAKE_IDRIS2_LOG records every
// process the pool starts, so that the tests can check the command lines and that no process
// is left. The time limits are deadlines for things that must happen, never races.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSessionPool, createTunedSessionPool } from '../../src/backend/ide/pool';
import { decodeVersion, ideCodec, loadFile, version } from '../../src/backend/ide/protocol';
import { systemClock } from '../../src/backend/ide/session';
import { createTransport } from '../../src/backend/ide/transport';
import type { SessionPool, SessionPoolDeps } from '../../src/backend/ide/types';
import type { IdeModeSettings } from '../../src/core/config';
import { IdrisException } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { LooseFile } from '../../src/project/types';
import { fakeLauncher, repoRoot } from '../fake-tools/paths';
import { recordingLog, RecordingTrace } from './support/fakeTransport';
import { FakeToolchain, idris2Probed, location, snapshot, SETTINGS } from './support/toolchainFixtures';

const SETTINGS_M2: IdeModeSettings = {
  transport: 'stdio',
  isolateBuildDir: true,
  loosePackages: [],
  extraArgs: [],
  requestTimeoutMs: 20_000,
  longActionTimeoutMs: 20_000,
  idleTimeoutMs: 0,
  maxSessions: 0,
  maxBackgroundChecks: 0,
};

interface Invocation {
  readonly pid: number;
  readonly args: string[];
  readonly cwd: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A pool whose toolchain names the fake compiler's launcher, with `env` for the fake. */
function fakePool(options: { env?: Record<string, string>; settings?: Partial<IdeModeSettings>; tuned?: boolean }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-fake-'));
  const logFile = path.join(scratch, 'invocations.jsonl');
  const probed = idris2Probed();
  if (probed.status !== 'probed') {
    throw new Error('fixture');
  }
  const env = { FAKE_IDRIS2_TRANSCRIPTS: '', FAKE_IDRIS2_LOG: logFile, ...options.env };
  const toolchain = new FakeToolchain(snapshot({ idris2: { ...probed, location: location('idris2', fakeLauncher('idris2')) }, settings: { ...SETTINGS, env } }));
  const settings = { ...SETTINGS_M2, ...options.settings };
  const log = recordingLog();
  const deps: SessionPoolDeps = {
    toolchain,
    projects: { sessionCwd: (root) => root.dir },
    config: { ideMode: () => settings, onDidChange: () => ({ dispose: () => undefined }) },
    trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
    gate: {
      permit: () => Promise.resolve({ allowed: true, basis: 'workspaceFolder' }),
      current: () => ({ allowed: true, basis: 'workspaceFolder' }),
      recheck: () => Promise.resolve({ allowed: true, basis: 'workspaceFolder' }),
      onDidChange: new Emitter<void>().event,
    },
    codec: ideCodec,
    trace: new RecordingTrace(),
    log,
    platform: process.platform,
    processEnv: process.env,
  };
  // The tuned pool restarts at once, so that a crash loop takes no backoff time.
  const pool: SessionPool = options.tuned
    ? createTunedSessionPool(deps, {
        timing: { handshakeTimeoutMs: 20_000, restartDelaysMs: [0, 0, 0], crashWindowMs: 300_000 },
        clock: systemClock,
        createTransport: (launch) =>
          createTransport(launch, { codec: ideCodec, trust: deps.trust, log, platform: process.platform, processEnv: process.env }),
      })
    : createSessionPool(deps);
  const invocations = (): Invocation[] =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as Invocation)
      : [];
  return {
    pool,
    log,
    invocations,
    /** Disposes the pool, waits until every process it started is gone, removes the scratch directory. */
    async close(): Promise<void> {
      pool.dispose();
      for (const { pid } of invocations()) {
        await eventually(() => !alive(pid), `fake compiler ${pid} is still running`);
      }
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

function kindOf(error: unknown): string | undefined {
  return error instanceof IdrisException ? error.error.kind : undefined;
}

suite('backend/ide: sessions over the fake compiler', function () {
  // Process start-up is slow on some CI machines; no assertion depends on it.
  this.timeout(60_000);
  const loose: LooseFile = { kind: 'loose', dir: fs.realpathSync(os.tmpdir()) };

  for (const transport of ['stdio', 'socket'] as const) {
    test(`${transport}: the default pool starts the launcher with the session's command line; :version, F4, stop`, async () => {
      const fake = fakePool({ settings: { transport } });
      try {
        const session = fake.pool.sessionFor(loose, 'check');
        const reply = await session.request(version(), { kind: 'lookup' });
        assert.deepStrictEqual(decodeVersion(reply.payload), { kind: 'ok', value: { major: 0, minor: 8, patch: 0 } });
        assert.deepStrictEqual(session.protocolVersion, { major: 2, minor: 1 });

        const unrecognised = await session.request({ kind: 'raw', text: '(:version)' }, { kind: 'lookup' });
        assert.strictEqual(unrecognised.returnedId, reply.id, 'F4: tagged with the previous id');
        assert.deepStrictEqual(unrecognised.payload, { kind: 'error', message: `Unrecognised command: ((:version) ${unrecognised.id})`, highlighting: [] });

        const [invocation] = fake.invocations();
        assert.deepStrictEqual(invocation.args, [
          transport === 'socket' ? '--ide-mode-socket' : '--ide-mode',
          '--no-color',
          '--build-dir',
          path.join(loose.dir, 'build', '.vscode-idris2'),
        ]);
        assert.strictEqual(fs.realpathSync(invocation.cwd), loose.dir);

        fake.pool.stop();
        assert.strictEqual(session.state, 'stopped');
        await eventually(() => !alive(invocation.pid), 'Stop Backend leaves no process');
        assert.strictEqual(fake.invocations().length, 1);
      } finally {
        await fake.close();
      }
    });
  }

  test('a recorded load replayed by the fake (load-bad): the reply carries the Building line and the warning before the :error return', async () => {
    const root = repoRoot();
    const broken: LooseFile = { kind: 'loose', dir: path.join(root, 'test', 'fixtures', 'workspaces', 'broken') };
    const fake = fakePool({ env: { FAKE_IDRIS2_TRANSCRIPTS: path.join(root, 'test', 'fixtures', 'transcripts', '0.8.0') } });
    try {
      const session = fake.pool.sessionFor(broken, 'check');
      const file = path.join(broken.dir, 'Bad.idr');
      const reply = await session.request(loadFile(file), { kind: 'load', file: { path: file, version: 1 } });
      assert.deepStrictEqual(reply.payload, { kind: 'error', message: `Error(s) building file ${file}`, highlighting: [] });
      assert.deepStrictEqual(
        reply.messages.map((m) => m.kind),
        ['write-string', 'warning'],
      );
      const [building, warning] = reply.messages;
      assert.ok(building.kind === 'write-string' && building.text === `1/1: Building Bad (${file})`);
      assert.ok(warning.kind === 'warning' && warning.warning.file === 'Bad.idr' && warning.warning.message.startsWith('While processing right hand side of f'));
      assert.deepStrictEqual(session.loadedFile, { path: file, version: 1 });
    } finally {
      await fake.close();
    }
  });

  test('crash@1 in every process: three automatic restarts, then the session gives up', async () => {
    const fake = fakePool({ env: { FAKE_IDRIS2_IDE_FAULT: 'crash@1' }, tuned: true });
    try {
      const session = fake.pool.sessionFor(loose, 'check');
      for (let i = 1; i <= 4; i++) {
        const error = await session.request(version(), { kind: 'lookup' }).then(
          () => undefined,
          (e: unknown) => e,
        );
        assert.strictEqual(kindOf(error), 'BackendCrashed', `request ${i}`);
        assert.match((error as Error).message, /exited with code 3; its last error output: fake-idris2: simulated crash at request 1/);
        if (i < 4) {
          await eventually(() => session.state === 'ready', `restart ${i}`);
        }
      }
      assert.strictEqual(session.state, 'failed');
      assert.strictEqual(fake.invocations().length, 4);
      await assert.rejects(session.request(version(), { kind: 'lookup' }), /has failed: .*4 unexpected ends within 5 min/);
      assert.strictEqual(fake.invocations().length, 4, 'no process after giving up');
    } finally {
      await fake.close();
    }
  });

  for (const transport of ['stdio', 'socket'] as const) {
    test(`${transport}: a process that dies inside a reply: the request rejects with the exit code, the last stderr line and the incomplete frame`, async () => {
      const fake = fakePool({ env: { FAKE_IDRIS2_IDE_FAULT: 'crash-in-reply@1' }, settings: { transport } });
      try {
        const session = fake.pool.sessionFor(loose, 'check');
        const error = await session.request(version(), { kind: 'lookup' }).then(
          () => undefined,
          (e: unknown) => e,
        );
        assert.strictEqual(kindOf(error), 'BackendCrashed');
        assert.match(
          (error as Error).message,
          /^The Idris 2 process ended while answering :version: the Idris 2 process (closed its IDE-mode connection, then )?exited with code 3; its last error output: fake-idris2: simulated crash inside a reply at request 1 \(FAKE_IDRIS2_IDE_FAULT\); its output ended inside a frame: "000040\(:write-string \\"partial"\.$/,
        );
        await eventually(() => session.state === 'ready', 'the restart');
      } finally {
        await fake.close();
      }
    });
  }

  for (const transport of ['stdio', 'socket'] as const) {
    test(`${transport}: a load that makes the compiler log (%logging, transcript load-logging) is answered; no protocol error, one process`, async () => {
      const root = repoRoot();
      const broken: LooseFile = { kind: 'loose', dir: path.join(root, 'test', 'fixtures', 'workspaces', 'broken') };
      const fake = fakePool({ env: { FAKE_IDRIS2_TRANSCRIPTS: path.join(root, 'test', 'fixtures', 'transcripts', '0.8.0') }, settings: { transport } });
      try {
        const session = fake.pool.sessionFor(broken, 'check');
        const changes: string[] = [];
        session.onDidChangeState((change) => changes.push(change.cause));
        const file = path.join(broken.dir, 'Logging.idr');
        const reply = await session.request(loadFile(file), { kind: 'load', file: { path: file } });
        assert.deepStrictEqual(reply.payload, { kind: 'ok', result: { kind: 'list', items: [] }, highlighting: [] });
        assert.strictEqual(reply.messages[0].kind, 'write-string');
        assert.ok(!changes.includes('protocolError'), changes.join(', '));
        assert.strictEqual(session.state, 'ready');
        assert.strictEqual(fake.invocations().length, 1);
        if (transport === 'stdio') {
          // The log lines were in the protocol stream: the session logged them as the process's output.
          assert.ok(fake.log.lines.includes(`debug: Idris 2 (${broken.dir}) output: LOG declare.def.lhs:3: LHS term: Logging.f`), fake.log.lines.join('\n'));
        }
      } finally {
        await fake.close();
      }
    });
  }

  test('over stdio, injected noise is the process\'s output: logged, the request answered, no restart', async () => {
    const fake = fakePool({ env: { FAKE_IDRIS2_IDE_FAULT: 'noise@2' }, tuned: true });
    try {
      const session = fake.pool.sessionFor(loose, 'check');
      await session.request(version(), { kind: 'lookup' });
      const reply = await session.request(version(), { kind: 'lookup' });
      assert.strictEqual(reply.payload.kind, 'ok');
      assert.ok(fake.log.lines.includes(`debug: Idris 2 (${loose.dir}) output: fake-idris2: injected noise (FAKE_IDRIS2_IDE_FAULT)`));
      assert.strictEqual(fake.invocations().length, 1);
    } finally {
      await fake.close();
    }
  });

  test('noise on the socket and an id mismatch are protocol errors: the request rejects, the next process answers', async () => {
    for (const [fault, transport] of [['noise@2', 'socket'], ['id-mismatch@2', 'stdio']] as const) {
      const fake = fakePool({ env: { FAKE_IDRIS2_IDE_FAULT: fault }, settings: { transport }, tuned: true });
      try {
        const session = fake.pool.sessionFor(loose, 'check');
        await session.request(version(), { kind: 'lookup' });
        const error = await session.request(version(), { kind: 'lookup' }).then(
          () => undefined,
          (e: unknown) => e,
        );
        assert.strictEqual(kindOf(error), 'ProtocolError', fault);
        assert.ok(fake.log.lines.some((l) => l.startsWith('warn: ') && l.includes('protocol error')), fault);
        const reply = await session.request(version(), { kind: 'lookup' });
        assert.strictEqual(reply.payload.kind, 'ok');
        assert.strictEqual(fake.invocations().length, 2, fault);
        await eventually(() => !alive(fake.invocations()[0].pid), `${fault}: the first process is gone`);
      } finally {
        await fake.close();
      }
    }
  });

  test('hang: the request times out, the process is killed, and the session serves the next request with a new one', async () => {
    const fake = fakePool({ env: { FAKE_IDRIS2_IDE_FAULT: 'hang@2' }, tuned: true });
    try {
      const session = fake.pool.sessionFor(loose, 'check');
      await session.request(version(), { kind: 'lookup' });
      // The hung request never answers, so its 1 s limit always expires.
      await assert.rejects(session.request(version(), { kind: 'lookup', timeoutMs: 1_000 }), (e: unknown) => kindOf(e) === 'RequestTimeout');
      await eventually(() => !alive(fake.invocations()[0].pid), 'the hung process is killed');
      const reply = await session.request(version(), { kind: 'lookup' });
      assert.strictEqual(reply.payload.kind, 'ok');
      assert.strictEqual(fake.invocations().length, 2);
    } finally {
      await fake.close();
    }
  });
});
