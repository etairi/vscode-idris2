// backend/ide/session.ts: the IdeSession state machine against FakeTransport and a fake clock
// (test/unit/support/fakeTransport.ts). Every protocol rule of ARCHITECTURE §5.1 is exercised by
// injecting frames, output, exits and time: the handshake, one request in flight, cancellation,
// time limits, F4 attribution, protocol errors, crashes, backoff and give-up, load
// de-duplication, loaded-file tracking, idle, stop, restart and dispose. No process is started
// and no test waits for wall-clock time.
import * as assert from 'assert';
import { IdrisException, unsupported } from '../../src/core/errors';
import {
  createSession,
  DEFAULT_SESSION_TIMING,
  type ManagedSession,
  type SessionLimits,
  type SessionTiming,
  type SpawnPlan,
} from '../../src/backend/ide/session';
import type { Reply, SessionLaunch, SessionStateChange } from '../../src/backend/ide/types';
import { LOOSE } from './support/toolchainFixtures';
import {
  error,
  FakeClock,
  FakeTransports,
  flush,
  jsonCodec,
  list,
  loadFile,
  ok,
  recordingLog,
  RecordingTrace,
  ret,
  str,
  sym,
  TestToken,
  typeOf,
  unknownText,
  writeString,
  type FakeTransportBehaviour,
} from './support/fakeTransport';

/** F5: what the compiler prints unframed when its input ends. */
const END_OF_INPUT = 'Alas the file is done, aborting\n';

const LAUNCH: SessionLaunch = {
  executable: '/opt/homebrew/bin/idris2',
  args: ['--ide-mode-socket', '--no-color', '--build-dir', '/w/loose-file/build/.vscode-idris2'],
  cwd: '/w/loose-file',
  env: {},
  transport: 'socket',
};

const STDIO_LAUNCH: SessionLaunch = { ...LAUNCH, args: ['--ide-mode', ...LAUNCH.args.slice(1)], transport: 'stdio' };

/** What 0.8.0 printed unframed over stdio while loading the `%logging` fixture (transcript load-logging). */
const LOG_LINES = ['LOG declare.def.lhs:3: LHS term: Logging.f\n', 'LOG declare.def:3: Initially missing in Logging.f:\n', '\n'];

interface Tracked<T> {
  readonly promise: Promise<T>;
  state: 'pending' | 'resolved' | 'rejected';
  value?: T;
  error?: unknown;
}

/** Observes a promise without awaiting it (and so that a rejection is never unhandled). */
function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { promise, state: 'pending' };
  promise.then(
    (value) => {
      tracked.state = 'resolved';
      tracked.value = value;
    },
    (e: unknown) => {
      tracked.state = 'rejected';
      tracked.error = e;
    },
  );
  return tracked;
}

function kindOf(tracked: Tracked<unknown>): string | undefined {
  return tracked.error instanceof IdrisException ? tracked.error.error.kind : undefined;
}

/** Whether the request was abandoned (a token, a stop or a restart): an `Error` named `Cancelled`. */
function cancelled(tracked: Tracked<unknown>): boolean {
  return tracked.state === 'rejected' && tracked.error instanceof Error && tracked.error.name === 'Cancelled';
}

function messageOf(tracked: Tracked<unknown>): string {
  return tracked.error instanceof Error ? tracked.error.message : '';
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(
  options: { timing?: Partial<SessionTiming>; limits?: Partial<SessionLimits>; behaviour?: FakeTransportBehaviour; launch?: SessionLaunch } = {},
) {
  const clock = new FakeClock();
  const transports = new FakeTransports();
  transports.behaviour = options.behaviour ?? {};
  const log = recordingLog();
  const trace = new RecordingTrace();
  const limits: SessionLimits = { requestTimeoutMs: 5_000, longActionTimeoutMs: 60_000, idleTimeoutMs: 0, ...options.limits };
  const warnings: string[] = [];
  const launch = options.launch ?? LAUNCH;
  const control = { plan: (): Promise<SpawnPlan> => Promise.resolve({ launch }), prepares: 0, limits };
  const session: ManagedSession = createSession({
    role: 'check',
    root: LOOSE,
    cwd: LAUNCH.cwd,
    prepare: () => {
      control.prepares++;
      return control.plan();
    },
    createTransport: transports.create,
    codec: jsonCodec,
    trace,
    log,
    clock,
    timing: { ...DEFAULT_SESSION_TIMING, ...options.timing },
    limits: () => control.limits,
    onNewerProtocol: (warning) => warnings.push(warning),
  });
  const changes: SessionStateChange[] = [];
  session.onDidChangeState((change) => changes.push(change));
  const lookup = (name = 'x', token?: TestToken) => track(session.request(typeOf(name), { kind: 'lookup', ...(token ? { token } : {}) }));
  return { session, clock, transports, log, trace, warnings, changes, control, lookup };
}

/** A session that has answered one request, so that it is `ready` with its first process. */
async function readySession(options: Parameters<typeof setup>[0] = {}) {
  const h = setup(options);
  const first = h.lookup('warm-up');
  await flush();
  const t = h.transports.last();
  t.message(ret(t.lastSent().id, ok()));
  await flush();
  assert.strictEqual(first.state, 'resolved');
  assert.strictEqual(h.session.state, 'ready');
  h.changes.length = 0;
  return { ...h, t };
}

const causes = (changes: readonly SessionStateChange[]) => changes.map((c) => `${c.previous}→${c.state}:${c.cause}`);

suite('backend/ide/session', () => {
  suite('start and handshake', () => {
    test('the first request starts a process; after the handshake it is sent, and its return resolves it with the messages before it', async () => {
      const h = setup();
      assert.strictEqual(h.session.state, 'stopped');
      assert.strictEqual(h.session.launch, undefined);
      const request = h.lookup('xs');
      await flush();
      assert.strictEqual(h.control.prepares, 1);
      const t = h.transports.last();
      assert.deepStrictEqual(t.launch, LAUNCH);
      assert.deepStrictEqual(h.session.launch, LAUNCH);
      assert.deepStrictEqual(h.session.protocolVersion, { major: 2, minor: 1 });
      assert.strictEqual(h.session.state, 'busy');
      assert.deepStrictEqual(t.sent, [{ command: typeOf('xs'), id: 1n }]);

      t.message(writeString(1n, '1/1: Building Main (Main.idr)'));
      t.message({ kind: 'output', id: 1n, payload: { kind: 'highlight-source', highlights: list() } });
      t.message(ret(1n, ok(str('xs : Vect ?_ ?_'))));
      await flush();
      assert.strictEqual(request.state, 'resolved');
      assert.deepStrictEqual(request.value, {
        id: 1n,
        payload: ok(str('xs : Vect ?_ ?_')),
        messages: [writeString(1n, '1/1: Building Main (Main.idr)'), { kind: 'output', id: 1n, payload: { kind: 'highlight-source', highlights: list() } }],
      } satisfies Reply);
      assert.strictEqual(h.session.state, 'ready');
      assert.deepStrictEqual(causes(h.changes), ['stopped→starting:start', 'starting→ready:handshake', 'ready→busy:dispatch', 'busy→ready:reply']);
      assert.ok(h.log.lines.some((l) => l.startsWith('info: ') && l.includes('starting /opt/homebrew/bin/idris2 --ide-mode-socket')));
    });

    test('requests are sent one at a time, in call order, with increasing ids', async () => {
      const h = setup();
      const requests = ['a', 'b', 'c'].map((name) => h.lookup(name));
      await flush();
      const t = h.transports.last();
      for (const [i, name] of ['a', 'b', 'c'].entries()) {
        assert.strictEqual(t.sent.length, i + 1, 'exactly one request is in flight');
        assert.deepStrictEqual(t.lastSent(), { command: typeOf(name), id: BigInt(i + 1) });
        t.message(ret(BigInt(i + 1)));
        await flush();
      }
      assert.deepStrictEqual(
        requests.map((r) => r.state),
        ['resolved', 'resolved', 'resolved'],
      );
      assert.strictEqual(h.transports.all.length, 1);
    });

    test('protocol version 1 (Idris 1) is refused with a clear message; the session fails and does not restart', async () => {
      const h = setup({ behaviour: { handshake: [1, 0] } });
      const request = h.lookup();
      await flush();
      assert.strictEqual(request.state, 'rejected');
      assert.strictEqual(kindOf(request), 'BackendCrashed');
      assert.match(messageOf(request), /speaks version 1\.0 of the IDE protocol; this extension needs version 2.*Idris 1/);
      assert.strictEqual(h.session.state, 'failed');
      assert.deepStrictEqual(causes(h.changes), ['stopped→starting:start', 'starting→failed:handshake']);
      assert.strictEqual(h.transports.last().stopCalls, 1);
      h.clock.advance(15 * 60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 1, 'no restart');
      const later = h.lookup();
      await flush();
      assert.strictEqual(kindOf(later), 'BackendCrashed');
      assert.match(messageOf(later), /has failed: .*version 1\.0/);
    });

    test('a new major version (3.0) is refused like 1: the session fails and does not restart (ROADMAP §7.4: must be 2.x)', async () => {
      const h = setup({ behaviour: { handshake: [3, 0] } });
      const request = h.lookup();
      await flush();
      assert.strictEqual(kindOf(request), 'BackendCrashed');
      assert.match(messageOf(request), /speaks version 3\.0 of the IDE protocol; this extension needs version 2, and a new major version/);
      assert.deepStrictEqual(causes(h.changes), ['stopped→starting:start', 'starting→failed:handshake']);
      assert.strictEqual(h.transports.all[0].sent.length, 0, 'nothing was sent to it');
      h.clock.advance(15 * 60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 1, 'no restart');
      assert.deepStrictEqual(h.warnings, []);
    });

    test('a newer protocol version is accepted; the change to ready carries the warning', async () => {
      const h = setup({ behaviour: { handshake: [2, 2] } });
      h.lookup();
      await flush();
      assert.strictEqual(h.session.state, 'busy');
      assert.deepStrictEqual(h.session.protocolVersion, { major: 2, minor: 2 });
      const ready = h.changes.find((c) => c.cause === 'handshake');
      assert.match(ready?.detail ?? '', /version 2\.2 of the IDE protocol, newer than 2\.1/);
      assert.deepStrictEqual(h.warnings, [ready?.detail]);
    });

    for (const [transport, launch, behaviour] of [
      ['stdio', STDIO_LAUNCH, { handshake: null }],
      ['a socket not connected yet (the port line is late)', LAUNCH, { handshake: null, start: 'manual' }],
    ] as const) {
      test(`no handshake within 10 s over ${transport}: the process is stopped and restarted, and the waiting request is sent to the new one`, async () => {
        const h = setup({ behaviour, launch });
        const request = h.lookup();
        await flush();
        const first = h.transports.last();
        assert.strictEqual(h.session.state, 'starting');
        h.clock.advance(9_999);
        assert.strictEqual(h.session.state, 'starting');
        h.transports.behaviour = {};
        h.clock.advance(1);
        assert.strictEqual(h.session.state, 'restarting');
        assert.strictEqual(h.changes[h.changes.length - 1].cause, 'timeout');
        // The limit includes the start: a slow wrapper (pack's idris2) is named as a cause.
        assert.match(h.changes[h.changes.length - 1].detail ?? '', /no \(:protocol-version …\) within 10 s of starting \(.*pack's idris2/);
        assert.strictEqual(first.stopCalls, 1);
        first.exit({ code: null, signal: 'SIGTERM' });
        await flush();
        const second = h.transports.last();
        assert.notStrictEqual(second, first);
        assert.strictEqual(request.state, 'pending');
        assert.deepStrictEqual(second.sent.map((s) => s.command), [typeOf('x')]);
      });
    }

    test('Q20: connected to the socket but no handshake within 10 s: another program may have the session; failed, not restarted', async () => {
      const h = setup({ behaviour: { handshake: null } });
      const request = h.lookup();
      await flush();
      h.clock.advance(10_000);
      await flush();
      assert.strictEqual(h.session.state, 'failed');
      assert.deepStrictEqual(causes(h.changes), ['stopped→starting:start', 'starting→failed:handshake']);
      assert.strictEqual(h.transports.last().stopCalls, 1, 'the process is stopped, which ends the other program\'s session too');
      assert.strictEqual(kindOf(request), 'BackendCrashed');
      assert.match(messageOf(request), /no \(:protocol-version …\) arrived on this extension's connection in the 10 s it was open, within 10 s of starting\. The compiler serves only the first connection/);
      assert.match(messageOf(request), /not restarted automatically.*idris2\.ideMode\.transport = "stdio"/);
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('possible use of the IDE-mode port by another program')));
      h.clock.advance(15 * 60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 1, 'no further start (no further chance for the other program)');
    });

    test('Q20: a connection made in the last 2 s before the handshake limit is a slow start (a pack wrapper): restarted as usual', async () => {
      const h = setup({ behaviour: { handshake: null, start: 'manual' } });
      h.lookup();
      await flush();
      h.clock.advance(8_500);
      h.transports.last().resolveStart(); // the port line came late: connected 1.5 s before the limit
      await flush();
      h.clock.advance(1_500);
      await flush();
      assert.ok(causes(h.changes).includes('starting→restarting:timeout'), causes(h.changes).join(', '));
      assert.ok(!causes(h.changes).some((c) => c.endsWith(':handshake')), 'not suspected');
      assert.strictEqual(h.transports.all.length, 2, 'a new process');
      // Connected 2 s before the limit: suspected.
      const g = setup({ behaviour: { handshake: null, start: 'manual' } });
      g.lookup();
      await flush();
      g.clock.advance(8_000);
      g.transports.last().resolveStart();
      await flush();
      g.clock.advance(2_000);
      await flush();
      assert.strictEqual(g.session.state, 'failed');
      assert.match(g.changes[g.changes.length - 1].detail ?? '', /in the 2 s it was open, within 10 s of starting/);
    });

    test('Q20: connected to the socket, and the process ends 2 s later before the handshake: failed, not restarted', async () => {
      const h = setup({ behaviour: { handshake: null } });
      const request = h.lookup();
      await flush();
      h.clock.advance(2_000);
      h.transports.last().exit({ code: 1, signal: null });
      await flush();
      assert.strictEqual(h.session.state, 'failed');
      assert.match(messageOf(request), /exited with code 1, 2 s after this extension had connected to its port and before \(:protocol-version …\) arrived/);
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('possible use of the IDE-mode port by another program')));
      h.clock.advance(60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 1);
      // Over stdio the same end is an ordinary crash: restarted.
      const g = setup({ behaviour: { handshake: null }, launch: STDIO_LAUNCH });
      g.lookup();
      await flush();
      g.transports.behaviour = {};
      g.clock.advance(2_000);
      g.transports.last().exit({ code: 1, signal: null });
      await flush();
      assert.strictEqual(g.transports.all.length, 2);
      assert.deepStrictEqual(causes(g.changes).slice(0, 2), ['stopped→starting:start', 'starting→restarting:exit']);
    });

    test('Q20: the process prints the end-of-input line (the client it served disconnected) and ends at once: failed', async () => {
      const h = setup({ behaviour: { handshake: null } });
      const request = h.lookup();
      await flush();
      h.clock.advance(300);
      h.transports.last().stdout(END_OF_INPUT);
      h.transports.last().exit({ code: 1, signal: null });
      await flush();
      assert.strictEqual(h.session.state, 'failed');
      assert.match(messageOf(request), /exited with code 1; its last output: Alas the file is done, aborting, 0\.3 s after this extension had connected/);
      h.clock.advance(60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 1);
    });

    test('an exit right after the connection, without the end-of-input line, is an ordinary crash (e.g. fdopen failed): restarted, with its output', async () => {
      // An honest compiler that cannot wrap the accepted socket prints this and exits with code 1
      // (`socketToFile`, REPL.idr 40–46 on v0.8.0 [src]); before, the race with the connection
      // decided whether it counted as a takeover.
      const h = setup({ behaviour: { handshake: null } });
      h.lookup();
      await flush();
      h.transports.behaviour = {};
      h.transports.last().stdout('Failed to fdopen socket file descriptor\n');
      h.transports.last().exit({ code: 1, signal: null });
      await flush();
      assert.deepStrictEqual(causes(h.changes).slice(0, 2), ['stopped→starting:start', 'starting→restarting:exit']);
      assert.strictEqual(
        h.changes[1].detail,
        'the Idris 2 process exited with code 1; its last output: Failed to fdopen socket file descriptor',
      );
      assert.ok(!h.log.lines.some((l) => l.includes('possible use of the IDE-mode port')));
      assert.strictEqual(h.transports.all.length, 2, 'restarted as a crash');
    });

    test('a handshake this extension cannot read fails the session at once over either transport, quoting it; no takeover warning', async () => {
      for (const launch of [LAUNCH, STDIO_LAUNCH]) {
        const h = setup({ behaviour: { handshake: null }, launch });
        const request = h.lookup();
        await flush();
        const version = { kind: 'integer', value: 3n } as const;
        h.transports.last().framed(unknownText(list(sym('protocol-version'), version, { kind: 'integer', value: 0n }, { kind: 'integer', value: 1n }), undefined, true));
        await flush();
        assert.strictEqual(h.session.state, 'failed', launch.transport);
        assert.deepStrictEqual(causes(h.changes), ['stopped→starting:start', 'starting→failed:handshake']);
        assert.strictEqual(kindOf(request), 'BackendCrashed');
        assert.match(messageOf(request), /^\/opt\/homebrew\/bin\/idris2 sent an IDE protocol handshake this extension cannot read: /);
        assert.ok(!h.log.lines.some((l) => l.includes('possible use of the IDE-mode port')), launch.transport);
        h.clock.advance(60_000);
        await flush();
        assert.strictEqual(h.transports.all.length, 1, 'not restarted');
      }
    });

    test('Q20: anything received on the connection shows that the compiler serves it: no takeover suspected', async () => {
      // A message of an unknown shape before any handshake, then the handshake limit: an ordinary time-out.
      const h = setup({ behaviour: { handshake: null } });
      h.lookup();
      await flush();
      h.transports.last().framed(unknownText(list(sym('new-message'))));
      h.transports.behaviour = {};
      h.clock.advance(10_000);
      await flush();
      assert.ok(causes(h.changes).includes('starting→restarting:timeout'), causes(h.changes).join(', '));
      assert.ok(!h.log.lines.some((l) => l.includes('possible use of the IDE-mode port')));
      assert.strictEqual(h.transports.all.length, 2, 'restarted');
      // A frame cut short, then the exit 2 s after the connection: an ordinary crash.
      const g = setup({ behaviour: { handshake: null } });
      g.lookup();
      await flush();
      g.transports.behaviour = {};
      g.clock.advance(2_000);
      g.transports.last().truncated('000018(:protocol-version 2');
      g.transports.last().exit({ code: 1, signal: null });
      await flush();
      assert.deepStrictEqual(causes(g.changes).slice(0, 2), ['stopped→starting:start', 'starting→restarting:exit']);
      assert.ok(!g.log.lines.some((l) => l.includes('possible use of the IDE-mode port')));
      // Bytes that do not complete an item yet count too (M2 verification of the third review: a
      // handshake cut short, or header digits alone, were taken for a takeover): the handshake
      // limit is an ordinary time-out, and an exit 2 s later an ordinary crash.
      for (const partial of ['000018(:protocol-ver', '00001']) {
        const p = setup({ behaviour: { handshake: null } });
        p.lookup();
        await flush();
        p.transports.behaviour = {};
        p.transports.last().partial(partial);
        p.clock.advance(10_000);
        await flush();
        assert.ok(causes(p.changes).includes('starting→restarting:timeout'), `${partial}: ${causes(p.changes).join(', ')}`);
        // M2 second verification of the third review: what had arrived was in neither the trace nor the message.
        const timedOut = p.changes.find((c) => c.cause === 'timeout');
        assert.ok(timedOut?.detail?.endsWith(`; ${Buffer.byteLength(partial)} bytes arrived without completing a message`), timedOut?.detail);
        assert.ok(!p.log.lines.some((l) => l.includes('possible use of the IDE-mode port')), partial);
        const e = setup({ behaviour: { handshake: null } });
        e.lookup();
        await flush();
        e.transports.behaviour = {};
        e.transports.last().partial(partial);
        e.clock.advance(2_000);
        e.transports.last().exit({ code: 1, signal: null });
        await flush();
        assert.deepStrictEqual(causes(e.changes).slice(0, 2), ['stopped→starting:start', 'starting→restarting:exit'], partial);
      }
    });

    test('a message before the handshake is a protocol error', async () => {
      const h = setup({ behaviour: { handshake: null } });
      h.lookup();
      await flush();
      h.transports.last().message(writeString(0n, 'early'));
      assert.strictEqual(h.session.state, 'restarting');
      assert.strictEqual(h.changes[h.changes.length - 1].cause, 'protocolError');
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('before (:protocol-version …)') && l.includes('early')));
    });

    test('a process that cannot be started makes the session fail at once, without a restart', async () => {
      const h = setup({ behaviour: { start: 'manual' } });
      const request = h.lookup();
      await flush();
      const t = h.transports.last();
      t.rejectStart('idris2 could not be started (ENOENT: spawn /opt/homebrew/bin/idris2 ENOENT)');
      t.exit({ code: null, signal: null, spawnError: 'ENOENT: spawn /opt/homebrew/bin/idris2 ENOENT' });
      await flush();
      assert.strictEqual(h.session.state, 'failed');
      assert.strictEqual(h.changes[h.changes.length - 1].cause, 'spawnError');
      assert.strictEqual(kindOf(request), 'BackendCrashed');
      assert.match(messageOf(request), /\/opt\/homebrew\/bin\/idris2 could not be started: ENOENT/);
      h.clock.advance(60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 1);
    });

    test('a start that fails (e.g. no port line) stops the transport; the end that follows carries the reason', async () => {
      const h = setup({ behaviour: { start: 'manual', onStop: 'manual' } });
      h.lookup();
      await flush();
      const t = h.transports.last();
      t.rejectStart('the first line idris2 printed is not the port of its socket: "Failed to open socket"');
      await flush();
      assert.strictEqual(t.stopCalls, 1);
      assert.strictEqual(h.session.state, 'starting');
      t.stderr('some error\n');
      t.exit({ code: 1, signal: null });
      assert.strictEqual(h.session.state, 'restarting');
      const change = h.changes[h.changes.length - 1];
      assert.strictEqual(change.cause, 'exit');
      assert.strictEqual(
        change.detail,
        'the Idris 2 process exited with code 1 (the first line idris2 printed is not the port of its socket: "Failed to open socket"); its last error output: some error',
      );
    });
  });

  suite('ids and protocol errors', () => {
    test('F4: "Unrecognised command" and "Parse error" with the previous id are attributed to the request in flight', async () => {
      const h = await readySession();
      const t = h.t; // request 1 (warm-up) was recognised
      const unrecognised = track(h.session.request({ kind: 'raw', text: '(:version)' }, { kind: 'lookup' }));
      await flush();
      assert.deepStrictEqual(t.lastSent(), { command: { kind: 'raw', text: '(:version)' }, id: 2n });
      t.message(ret(1n, error('Unrecognised command: ((:version) 2)')));
      await flush();
      assert.deepStrictEqual(unrecognised.value, { id: 2n, payload: error('Unrecognised command: ((:version) 2)'), messages: [], returnedId: 1n });

      // The previous *recognised* id is still 1: request 2 was not recognised.
      const parse = track(h.session.request({ kind: 'raw', text: '((:version 4' }, { kind: 'lookup' }));
      await flush();
      t.message(ret(1n, error("Parse error: Couldn't parse any alternatives:")));
      await flush();
      assert.strictEqual(parse.value?.returnedId, 1n);
      assert.strictEqual(parse.value?.id, 3n);
      assert.strictEqual(h.transports.all.length, 1, 'no restart');
      assert.strictEqual(h.session.state, 'ready');
    });

    test('F4: before any request was recognised the compiler uses id 0', async () => {
      const h = setup();
      const request = track(h.session.request(list(sym('version')), { kind: 'lookup' }));
      await flush();
      h.transports.last().message(ret(0n, error('Unrecognised command: ((:version) 1)')));
      await flush();
      assert.strictEqual(request.value?.returnedId, 0n);
      assert.strictEqual(request.value?.id, 1n);
    });

    test('only those two errors are attributed: another id, an :ok or another error with the previous id are protocol errors', async () => {
      for (const stray of [ret(7n, error('Unrecognised command: x')), ret(1n, ok()), ret(1n, error('Undefined name xs.'))]) {
        const h = await readySession();
        const request = h.lookup();
        await flush();
        h.t.message(stray);
        await flush();
        assert.strictEqual(kindOf(request), 'ProtocolError', JSON.stringify(stray, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
        assert.ok(h.changes.some((c) => c.cause === 'protocolError'));
      }
    });

    test('any other id mismatch is a protocol error: the request rejects, the frame is logged, the session restarts and serves the queue', async () => {
      const h = await readySession();
      const first = h.lookup('a');
      const second = h.lookup('b');
      await flush();
      h.t.message(ret(99n, ok(str('stray'))));
      assert.strictEqual(first.state, 'pending', 'rejections settle asynchronously');
      await flush();
      assert.strictEqual(kindOf(first), 'ProtocolError');
      assert.match(messageOf(first), /an answer with id 99 while request 2 \(:type-of\) was waiting/);
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('protocol error') && l.includes('stray')));
      assert.strictEqual(h.t.stopCalls, 1);
      const next = h.transports.last();
      assert.notStrictEqual(next, h.t);
      assert.deepStrictEqual(next.sent, [{ command: typeOf('b'), id: 3n }]);
      next.message(ret(3n));
      await flush();
      assert.strictEqual(second.state, 'resolved');
      assert.deepStrictEqual(causes(h.changes).slice(0, 3), ['ready→busy:dispatch', 'busy→restarting:protocolError', 'restarting→starting:backoff']);
    });

    test('a :write-string with another id, and a message while nothing is in flight, are protocol errors', async () => {
      const h = await readySession();
      const request = h.lookup();
      await flush();
      h.t.message(writeString(1n, 'late'));
      await flush();
      assert.strictEqual(kindOf(request), 'ProtocolError');

      const g = await readySession();
      g.t.message(writeString(1n, 'unsolicited'));
      assert.strictEqual(g.session.state, 'restarting');
      assert.match(g.changes[0].detail ?? '', /while no request was waiting/);
    });

    test('over stdio, unframed lines are the process\'s output (log lines, program output, noise, the end-of-input line): logged, traced, no error', async () => {
      const h = await readySession({ launch: STDIO_LAUNCH });
      const load = track(h.session.request(loadFile('/w/loose-file/Logging.idr'), { kind: 'load', file: { path: '/w/loose-file/Logging.idr' } }));
      await flush();
      const id = h.t.lastSent().id;
      h.t.message(writeString(id, '1/1: Building Logging (/w/loose-file/Logging.idr)'));
      for (const line of [...LOG_LINES, 'fake-idris2: injected noise\n', END_OF_INPUT]) {
        h.t.unframed(line);
      }
      h.t.message(ret(id));
      await flush();
      assert.strictEqual(load.state, 'resolved');
      assert.strictEqual(h.transports.all.length, 1, 'no restart');
      assert.ok(!h.changes.some((c) => c.cause === 'protocolError'));
      for (const expected of [
        'debug: Idris 2 (/w/loose-file) output: LOG declare.def.lhs:3: LHS term: Logging.f',
        'debug: Idris 2 (/w/loose-file) output: ',
        'debug: Idris 2 (/w/loose-file) output: fake-idris2: injected noise',
        'debug: Idris 2 (/w/loose-file) end of input: Alas the file is done, aborting',
      ]) {
        assert.ok(h.log.lines.includes(expected), expected);
      }
      assert.deepStrictEqual(
        h.trace.entries.filter((e) => e.direction === 'unframed').map((e) => e.text),
        [...LOG_LINES, 'fake-idris2: injected noise\n', END_OF_INPUT],
      );
    });

    test('on the socket, where the compiler writes only frames, an unframed line is a protocol error, logged with its text', async () => {
      const h = await readySession();
      const request = h.lookup();
      await flush();
      h.t.unframed('hi\n');
      await flush();
      assert.strictEqual(kindOf(request), 'ProtocolError');
      assert.match(messageOf(request), /output on the socket that is not a frame: "hi\\n"/);
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('protocol error') && l.includes('"hi\\n"')), 'the noise is logged');
    });

    test('a stream that ends inside a frame (truncated) is reported with the exit that follows: code, stderr and the frame', async () => {
      for (const launch of [LAUNCH, STDIO_LAUNCH]) {
        const h = await readySession({ launch });
        const request = h.lookup();
        await flush();
        h.t.stderr('Exception in fGetChar: heap exhausted\n');
        h.t.truncated('00002a(:return (:ok');
        await flush();
        assert.strictEqual(request.state, 'pending', `${launch.transport}: the exit, which follows, decides`);
        assert.strictEqual(h.session.state, 'busy');
        h.t.exit({ code: 3, signal: null });
        await flush();
        assert.strictEqual(kindOf(request), 'BackendCrashed', launch.transport);
        assert.strictEqual(
          messageOf(request),
          'The Idris 2 process ended while answering :type-of: the Idris 2 process exited with code 3; its last error output: ' +
            'Exception in fGetChar: heap exhausted; its output ended inside a frame: "00002a(:return (:ok".',
        );
        assert.ok(causes(h.changes).includes('busy→restarting:exit'), causes(h.changes).join(', '));
        assert.ok(!h.changes.some((c) => c.cause === 'protocolError'));
      }
    });

    test('more output than the transport holds without a complete frame (overflow) is a protocol error at once', async () => {
      for (const launch of [LAUNCH, STDIO_LAUNCH]) {
        const h = await readySession({ launch });
        const request = h.lookup();
        await flush();
        h.t.overflow('xxxx');
        await flush();
        assert.strictEqual(kindOf(request), 'ProtocolError', launch.transport);
        assert.match(messageOf(request), /more output than the transport holds without a complete frame: "xxxx"/);
        assert.ok(causes(h.changes).includes('busy→restarting:protocolError'), causes(h.changes).join(', '));
      }
    });

    test('a :return with the id in flight whose payload cannot be read answers that request at once; the process is kept', async () => {
      const h = await readySession({ limits: { requestTimeoutMs: 60_000 } });
      const request = h.lookup();
      const next = h.lookup('next');
      await flush();
      // (:return (:ok "x" () :extra) 2): a newer compiler's extra field.
      h.t.framed(unknownText(list(sym('return'), list(sym('ok'), str('x'), list(), sym('extra')), { kind: 'integer', value: 2n }), 2n));
      await flush();
      assert.strictEqual(kindOf(request), 'ProtocolError', 'at once, not after its 60 s limit');
      assert.match(messageOf(request), /answered :type-of in a form this extension cannot read/);
      assert.deepStrictEqual(h.clock.pending(), [60_000], 'only the next request\'s limit');
      assert.strictEqual(h.transports.all.length, 1, 'the stream is in step: no restart');
      assert.deepStrictEqual(h.t.lastSent(), { command: typeOf('next'), id: 3n });
      h.t.message(ret(3n));
      await flush();
      assert.strictEqual(next.state, 'resolved');
      assert.ok(!h.changes.some((c) => c.cause === 'protocolError'));
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('cannot read')));
      // Another id, or no request in flight: logged and ignored, as before.
      h.t.framed(unknownText(list(sym('return'), list(sym('maybe')), { kind: 'integer', value: 9n }), 9n));
      await flush();
      assert.strictEqual(h.session.state, 'ready');
      assert.strictEqual(h.transports.all.length, 1);
    });

    test('a frame that is not an s-expression is a protocol error; a message of an unknown shape is logged and ignored', async () => {
      const h = await readySession();
      const request = h.lookup();
      await flush();
      h.t.framed(JSON.stringify({ unknown: list(sym('new-message'), str('x')) }));
      assert.strictEqual(h.session.state, 'busy');
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('unknown shape')));
      h.t.message(ret(2n));
      await flush();
      assert.strictEqual(request.state, 'resolved');

      const broken = h.lookup();
      await flush();
      h.t.framed('(:return (:ok ()) 3');
      await flush();
      assert.strictEqual(kindOf(broken), 'ProtocolError');
      assert.match(messageOf(broken), /a frame that is not an s-expression/);
    });

    test('a request that cannot be written is a protocol error', async () => {
      const h = await readySession();
      h.t.sendError = new Error('write EPIPE');
      const request = h.lookup();
      await flush();
      assert.strictEqual(kindOf(request), 'ProtocolError');
      assert.match(messageOf(request), /could not be written \(write EPIPE\)/);
    });
  });

  suite('time limits and cancellation', () => {
    test('a request over its limit stops the process, rejects the queue with RequestTimeout, and the session restarts', async () => {
      const h = await readySession();
      const slow = h.lookup('slow');
      const queued = track(h.session.request(loadFile('/w/loose-file/A.idr'), { kind: 'load', file: { path: '/w/loose-file/A.idr' } }));
      await flush();
      h.clock.advance(4_999);
      assert.strictEqual(slow.state, 'pending');
      h.clock.advance(1);
      await flush();
      assert.strictEqual(kindOf(slow), 'RequestTimeout');
      assert.strictEqual(messageOf(slow), ':type-of did not answer within 5 s; the Idris 2 process was stopped.');
      assert.strictEqual(kindOf(queued), 'RequestTimeout');
      assert.match(messageOf(queued), /Dropped: an earlier request \(:type-of\) did not answer within 5 s/);
      assert.strictEqual(h.t.stopCalls, 1);
      assert.deepStrictEqual(causes(h.changes).slice(1, 3), ['busy→restarting:timeout', 'restarting→starting:backoff']);
      assert.strictEqual(h.session.state, 'ready');
      assert.deepStrictEqual(h.transports.last().sent, [], 'nothing is resent');
    });

    test('a request over its limit while part of a reply had arrived: the message says how many bytes', async () => {
      const h = await readySession();
      const slow = h.lookup('slow');
      await flush();
      h.t.message(writeString(2n, 'Building'));
      h.t.partial('000040(:return (:ok');
      h.clock.advance(5_000);
      await flush();
      assert.strictEqual(messageOf(slow), ':type-of did not answer within 5 s; 19 bytes arrived without completing a message; the Idris 2 process was stopped.');
      assert.match(h.changes.find((c) => c.cause === 'timeout')?.detail ?? '', /; 19 bytes arrived without completing a message$/);
    });

    test('limits by kind — lookup: requestTimeout; load and longAction: longActionTimeout; timeoutMs overrides — read per request, counted from sending', async () => {
      const h = await readySession();
      const pendingLimit = () => h.clock.pending();
      const load = track(h.session.request(loadFile('/w/A.idr'), { kind: 'load', file: { path: '/w/A.idr' } }));
      const lookup = h.lookup();
      await flush();
      assert.deepStrictEqual(pendingLimit(), [60_000]);
      h.clock.advance(30_000);
      h.control.limits = { ...h.control.limits, requestTimeoutMs: 7_000 };
      h.t.message(ret(2n));
      await flush();
      assert.strictEqual(load.state, 'resolved');
      assert.deepStrictEqual(pendingLimit(), [7_000], 'the lookup queued for 30 s gets its full limit, read when it is sent');
      h.t.message(ret(3n));
      await flush();
      assert.strictEqual(lookup.state, 'resolved');
      track(h.session.request(list(sym('proof-search')), { kind: 'longAction' }));
      await flush();
      assert.deepStrictEqual(pendingLimit(), [60_000]);
      h.t.message(ret(4n));
      track(h.session.request(typeOf('y'), { kind: 'lookup', timeoutMs: 1_234 }));
      await flush();
      assert.deepStrictEqual(pendingLimit(), [1_234]);
    });

    test('cancelling a waiting request removes it from the queue', async () => {
      const h = await readySession();
      const first = h.lookup('a');
      const token = new TestToken();
      const second = h.lookup('b', token);
      await flush();
      token.cancel();
      await flush();
      assert.strictEqual(second.state, 'rejected');
      assert.strictEqual((second.error as Error).name, 'Cancelled');
      h.t.message(ret(2n));
      await flush();
      assert.strictEqual(first.state, 'resolved');
      assert.deepStrictEqual(h.t.sent.map((s) => s.command), [typeOf('warm-up'), typeOf('a')]);
      assert.strictEqual(h.session.state, 'ready');
    });

    test('cancelling the request in flight rejects it at once; its reply is awaited and dropped, and its limit still applies', async () => {
      const h = await readySession();
      const token = new TestToken();
      const first = h.lookup('a', token);
      const second = h.lookup('b');
      await flush();
      token.cancel();
      await flush();
      assert.strictEqual((first.error as Error).name, 'Cancelled');
      assert.strictEqual(h.t.sent.length, 2, 'the next request waits for the reply');
      h.t.message(ret(2n));
      await flush();
      assert.deepStrictEqual(h.t.lastSent(), { command: typeOf('b'), id: 3n });
      h.t.message(ret(3n));
      await flush();
      assert.strictEqual(second.state, 'resolved');

      const other = new TestToken();
      h.lookup('c', other);
      await flush();
      other.cancel();
      h.clock.advance(5_000);
      assert.strictEqual(h.session.state, 'restarting');
      assert.strictEqual(h.changes[h.changes.length - 1].cause, 'timeout');
    });

    test('a token that is already cancelled rejects without queueing anything', async () => {
      const h = setup();
      const token = new TestToken();
      token.cancel();
      const request = h.lookup('a', token);
      await flush();
      assert.strictEqual((request.error as Error).name, 'Cancelled');
      assert.strictEqual(h.transports.all.length, 0);
    });
  });

  suite('loads', () => {
    test('loads of one file waiting in the queue are merged: one :load-file for the newer version, every caller gets the reply', async () => {
      const h = await readySession();
      const busy = h.lookup('busy');
      const path = '/w/loose-file/A.idr';
      const v1 = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 1 } }));
      const between = h.lookup('between');
      const v2 = track(h.session.request(list(sym('load-file'), str(path), str('v2')), { kind: 'load', file: { path, version: 2 } }));
      await flush();
      h.t.message(ret(2n));
      await flush();
      assert.deepStrictEqual(h.t.lastSent(), { command: list(sym('load-file'), str(path), str('v2')), id: 3n }, "the newer command, at the older entry's place");
      h.t.message(ret(3n, ok()));
      await flush();
      assert.strictEqual(busy.state, 'resolved');
      assert.deepStrictEqual(v1.value, v2.value);
      assert.strictEqual(v1.value?.id, 3n);
      assert.deepStrictEqual(h.session.loadedFile, { path, version: 2 });
      assert.deepStrictEqual(h.t.lastSent(), { command: typeOf('between'), id: 4n });
      assert.strictEqual(between.state, 'pending');
    });

    test('a load of the file in flight is queued, not merged; cancelling one of two merged callers keeps the other', async () => {
      const h = await readySession();
      const path = '/w/A.idr';
      track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 1 } }));
      await flush();
      const token = new TestToken();
      const second = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 2 }, token }));
      const third = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 3 } }));
      token.cancel();
      h.t.message(ret(2n));
      await flush();
      assert.deepStrictEqual(h.t.sent.slice(1).map((s) => s.id), [2n, 3n], 'sent twice: once in flight, once for the merged queue entry');
      h.t.message(ret(3n));
      await flush();
      assert.strictEqual((second.error as Error).name, 'Cancelled');
      assert.strictEqual(third.value?.id, 3n);
      assert.deepStrictEqual(h.session.loadedFile, { path, version: 3 });

      h.lookup('busy');
      await flush();
      const lonely = new TestToken();
      track(h.session.request(loadFile('/w/B.idr'), { kind: 'load', file: { path: '/w/B.idr' }, token: lonely }));
      lonely.cancel();
      h.t.message(ret(4n));
      await flush();
      assert.strictEqual(h.t.sent.length, 4, 'a queued load whose only caller cancelled is not sent');
      assert.strictEqual(h.session.state, 'ready');
    });

    test('loadedFile: set by the return of a load (also an :error), cleared by a raw request and when the process ends', async () => {
      const h = await readySession();
      assert.strictEqual(h.session.loadedFile, undefined);
      track(h.session.request(loadFile('/w/Bad.idr'), { kind: 'load', file: { path: '/w/Bad.idr', version: 4 } }));
      await flush();
      h.t.message(ret(2n, error('Error(s) building file /w/Bad.idr')));
      await flush();
      assert.deepStrictEqual(h.session.loadedFile, { path: '/w/Bad.idr', version: 4 });
      h.lookup();
      await flush();
      h.t.message(ret(3n));
      await flush();
      assert.deepStrictEqual(h.session.loadedFile, { path: '/w/Bad.idr', version: 4 }, 'a lookup keeps it');
      track(h.session.request({ kind: 'raw', text: '(:load-file "/w/Other.idr")' }, { kind: 'lookup' }));
      await flush();
      assert.strictEqual(h.session.loadedFile, undefined, 'a raw request may have loaded anything');
      h.t.message(ret(4n));
      track(h.session.request(loadFile('/w/Bad.idr'), { kind: 'load', file: { path: '/w/Bad.idr', version: 5 } }));
      await flush();
      h.t.message(ret(5n));
      await flush();
      assert.ok(h.session.loadedFile !== undefined);
      h.t.exit({ code: 1, signal: null });
      assert.strictEqual(h.session.loadedFile, undefined);
    });
  });

  // M2 second verification of the third review: backend.ts walked for the package when a load was
  // queued, and a first load then waited for the consent question and the start before it was sent.
  suite('beforeSend (the check right before a request is written)', () => {
    test('a first request: it runs after the process has answered the handshake, and the request waits for it', async () => {
      const h = setup();
      const check = deferred<void>();
      const calls: string[] = [];
      const path = '/w/loose-file/A.idr';
      const load = track(
        h.session.request(loadFile(path), {
          kind: 'load',
          file: { path },
          beforeSend: () => {
            calls.push(`${h.session.state} ${h.session.launch === undefined ? 'no process' : 'process'}`);
            return check.promise;
          },
        }),
      );
      const behind = h.lookup('behind');
      await flush();
      assert.deepStrictEqual(calls, ['ready process']);
      assert.deepStrictEqual(h.transports.last().sent, [], 'nothing is written while it runs, not the requests behind it either');
      check.resolve();
      await flush();
      assert.deepStrictEqual(h.transports.last().sent, [{ command: loadFile(path), id: 1n }]);
      h.transports.last().message(ret(1n, ok()));
      await flush();
      assert.strictEqual(load.state, 'resolved');
      assert.deepStrictEqual(h.transports.last().lastSent(), { command: typeOf('behind'), id: 2n });
      assert.strictEqual(behind.state, 'pending');
      assert.deepStrictEqual(calls, ['ready process'], 'once per process');
    });

    test('a rejection: nothing is written, the request rejects with its error, and the next request is sent', async () => {
      const h = await readySession();
      const refusal = new IdrisException({ kind: 'LoadFailed', message: 'Not checked: another package.' });
      const load = track(h.session.request(loadFile('/w/A.idr'), { kind: 'load', file: { path: '/w/A.idr' }, beforeSend: () => Promise.reject(refusal) }));
      const next = h.lookup('next');
      await flush();
      assert.strictEqual(load.error, refusal);
      assert.deepStrictEqual(h.t.sent.slice(1), [{ command: typeOf('next'), id: 2n }]);
      assert.strictEqual(next.state, 'pending');
      assert.strictEqual(h.session.state, 'busy');
    });

    test('a new process runs it again, also when it passed for the process that ended; a stop meanwhile leaves nothing to send', async () => {
      const h = await readySession();
      const first = deferred<void>();
      const runs: SessionLaunch[] = [];
      let wait = first.promise;
      const load = track(
        h.session.request(loadFile('/w/A.idr'), {
          kind: 'load',
          file: { path: '/w/A.idr' },
          beforeSend: () => {
            runs.push(h.session.launch as SessionLaunch);
            return wait;
          },
        }),
      );
      await flush();
      assert.strictEqual(runs.length, 1);
      wait = Promise.resolve();
      h.t.exit({ code: 1, signal: null });
      first.resolve(); // passes, but for the process that has ended
      await flush();
      const second = h.transports.last();
      assert.notStrictEqual(second, h.t);
      assert.strictEqual(runs.length, 2, 'run again for the new process');
      assert.deepStrictEqual(second.sent, [{ command: loadFile('/w/A.idr'), id: 2n }]);
      second.message(ret(2n, ok()));
      await flush();
      assert.strictEqual(load.state, 'resolved');

      const held = deferred<void>();
      const stopped = track(h.session.request(loadFile('/w/B.idr'), { kind: 'load', file: { path: '/w/B.idr' }, beforeSend: () => held.promise }));
      await flush();
      h.session.stop('stop', 'Stop Backend');
      await flush();
      held.resolve();
      await flush();
      assert.ok(cancelled(stopped));
      assert.strictEqual(second.sent.length, 1);
    });

    test('a check that does not settle within the request\'s time limit rejects that request (LoadFailed); nothing is sent, the process is kept, the requests behind it go', async () => {
      // Verification after Q20–Q22: a check that never settled (a realpath on a hung network mount)
      // held the queue with no timer, the session never idle, until Stop Backend.
      const h = await readySession({ limits: { longActionTimeoutMs: 60_000 } });
      const hung = track(h.session.request(loadFile('/w/A.idr'), { kind: 'load', file: { path: '/w/A.idr' }, beforeSend: () => new Promise<void>(() => undefined) }));
      const behind = h.lookup('behind');
      await flush();
      assert.deepStrictEqual(h.clock.pending(), [60_000], 'the load\'s own limit, from the start of its check');
      h.clock.advance(59_999);
      await flush();
      assert.strictEqual(hung.state, 'pending');
      assert.strictEqual(h.t.sent.length, 1, 'nothing sent while it runs');
      h.clock.advance(1);
      await flush();
      assert.strictEqual(kindOf(hung), 'LoadFailed');
      assert.match(messageOf(hung), /did not finish within 1 min; nothing was sent to the compiler/);
      assert.deepStrictEqual(h.t.sent.slice(1), [{ command: typeOf('behind'), id: 2n }], 'the request behind it is sent');
      assert.strictEqual(h.transports.all.length, 1, 'the process is kept');
      h.t.message(ret(2n, ok()));
      await flush();
      assert.strictEqual(behind.state, 'resolved');
      assert.strictEqual(h.session.idle, true);
      // A request's own timeoutMs applies; a check that settles in time leaves no timer behind.
      const quick = track(h.session.request(loadFile('/w/B.idr'), { kind: 'load', file: { path: '/w/B.idr' }, timeoutMs: 3_000, beforeSend: () => Promise.resolve() }));
      await flush();
      assert.deepStrictEqual(h.clock.pending(), [3_000], 'only the request\'s own limit, now that it is sent');
      h.t.message(ret(3n, ok()));
      await flush();
      assert.strictEqual(quick.state, 'resolved');
      // A stop while a check runs clears its limit with the queue.
      const stopped = track(h.session.request(loadFile('/w/C.idr'), { kind: 'load', file: { path: '/w/C.idr' }, beforeSend: () => new Promise<void>(() => undefined) }));
      await flush();
      assert.deepStrictEqual(h.clock.pending(), [60_000]);
      h.session.stop('stop', 'Stop Backend');
      await flush();
      assert.ok(cancelled(stopped));
      assert.deepStrictEqual(h.clock.pending(), []);
    });

    test('a request cancelled while its check runs rejects at once, its check is abandoned, and the requests behind it go at once', async () => {
      // The fix of the time limit first forgot the run of a cancelled request, so its end moved
      // nothing on and the request behind it waited for good (the verifier's probe, verification
      // after Q20–Q22). Then the requests behind it waited for that run to settle, or for its time
      // limit, although nothing would be sent for it, and the session read idle meanwhile
      // (M2 verification of the Q20–Q22 fixes, the verifier's probe S2).
      const h = await readySession({ limits: { longActionTimeoutMs: 60_000 } });
      const check = deferred<void>();
      const token = new TestToken();
      const load = track(h.session.request(loadFile('/w/A.idr'), { kind: 'load', file: { path: '/w/A.idr' }, token, beforeSend: () => check.promise }));
      const next = h.lookup('next');
      await flush();
      assert.strictEqual(h.t.sent.length, 1, 'nothing sent while the check runs');
      token.cancel();
      await flush();
      assert.ok(cancelled(load));
      assert.deepStrictEqual(h.t.sent.slice(1), [{ command: typeOf('next'), id: 2n }], 'the next request goes at once');
      check.resolve(); // the abandoned check passes: nothing is sent for it
      await flush();
      assert.strictEqual(h.t.sent.length, 2);
      h.t.message(ret(2n, ok()));
      await flush();
      assert.strictEqual(next.state, 'resolved');
      // A check that never settles, and nothing behind it: idle at once, and the next request is not held.
      const hung = new TestToken();
      const second = track(h.session.request(loadFile('/w/B.idr'), { kind: 'load', file: { path: '/w/B.idr' }, token: hung, beforeSend: () => new Promise<void>(() => undefined) }));
      await flush();
      assert.strictEqual(h.session.idle, false, 'a check runs');
      hung.cancel();
      await flush();
      assert.ok(cancelled(second));
      assert.strictEqual(h.session.idle, true, 'nothing left to abandon');
      assert.deepStrictEqual(h.clock.pending(), [], 'the abandoned check\'s time limit is cleared');
      const after = h.lookup('after');
      await flush();
      assert.deepStrictEqual(h.t.lastSent(), { command: typeOf('after'), id: 3n });
      h.t.message(ret(3n, ok()));
      await flush();
      assert.strictEqual(after.state, 'resolved');
      assert.deepStrictEqual(h.clock.pending(), []);
    });

    test('urgent: a request goes before the others waiting, never before the one in flight or one whose check runs or has passed; false is first-in, first-out', async () => {
      // M2 verification of the Q20–Q22 fixes (ROADMAP §9 Q21): the active document's load waited
      // behind every load of its root handed to the session before it.
      const h = await readySession();
      const load = (path: string, options: { urgent?: () => boolean; beforeSend?: () => Promise<void> } = {}) =>
        track(h.session.request(loadFile(path), { kind: 'load', file: { path }, ...options }));
      const sentCommands = () => h.t.sent.slice(1).map((frame) => frame.command);
      let urgent = true;
      const x = h.lookup('x'); // in flight
      await flush();
      const bCheck = deferred<void>();
      const b = load('/w/B.idr', { beforeSend: () => bCheck.promise });
      const c = h.lookup('c');
      const u = load('/w/U.idr', { urgent: () => urgent, beforeSend: () => Promise.resolve() });
      await flush();
      assert.deepStrictEqual(sentCommands(), [typeOf('x')], 'not before the request in flight');
      h.t.message(ret(2n, ok()));
      await flush();
      assert.strictEqual(x.state, 'resolved');
      assert.deepStrictEqual(sentCommands(), [typeOf('x'), loadFile('/w/U.idr')], 'before b and c, which waited longer');
      h.t.message(ret(3n, ok()));
      await flush();
      assert.strictEqual(u.state, 'resolved');
      // b is first now; its check runs. An urgent load that comes meanwhile waits for it.
      const u2 = load('/w/U2.idr', { urgent: () => urgent });
      await flush();
      assert.strictEqual(h.t.sent.length, 3, 'nothing sent while b\'s check runs, u2 included');
      bCheck.resolve();
      await flush();
      assert.deepStrictEqual(sentCommands().slice(2), [loadFile('/w/B.idr')], 'b, whose check passed, goes first');
      h.t.message(ret(4n, ok()));
      await flush();
      assert.strictEqual(b.state, 'resolved');
      assert.deepStrictEqual(sentCommands().slice(3), [loadFile('/w/U2.idr')], 'u2 before c');
      h.t.message(ret(5n, ok()));
      await flush();
      assert.strictEqual(u2.state, 'resolved');
      assert.deepStrictEqual(sentCommands().slice(4), [typeOf('c')]);
      h.t.message(ret(6n, ok()));
      await flush();
      assert.strictEqual(c.state, 'resolved');
      // Not urgent (any more), or a function that throws: the order they came in.
      urgent = false;
      const y = h.lookup('y');
      await flush();
      const d = h.lookup('d');
      const e = load('/w/E.idr', { urgent: () => urgent });
      const f = load('/w/F.idr', {
        urgent: () => {
          throw new Error('broken');
        },
      });
      await flush();
      for (const [done, id] of [
        [y, 7n],
        [d, 8n],
        [e, 9n],
        [f, 10n],
      ] as const) {
        h.t.message(ret(id, ok()));
        await flush();
        assert.strictEqual(done.state, 'resolved');
      }
      assert.deepStrictEqual(sentCommands().slice(5), [typeOf('y'), typeOf('d'), loadFile('/w/E.idr'), loadFile('/w/F.idr')]);
    });

    test('merged loads: the newer caller\'s check decides, also over one of the older caller\'s that was running', async () => {
      const h = await readySession();
      const path = '/w/A.idr';
      const older = deferred<void>();
      const first = track(
        h.session.request(loadFile(path), {
          kind: 'load',
          file: { path, version: 1 },
          beforeSend: () => older.promise.then(() => Promise.reject(new Error('the older check'))),
        }),
      );
      await flush(); // the older check runs
      const second = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 2 }, beforeSend: () => Promise.resolve() }));
      await flush();
      assert.deepStrictEqual(h.t.lastSent(), { command: loadFile(path), id: 2n }, 'sent after the newer check');
      older.resolve(); // rejects now: ignored
      await flush();
      h.t.message(ret(2n, ok()));
      await flush();
      assert.strictEqual(first.state, 'resolved');
      assert.strictEqual(second.state, 'resolved');
      assert.deepStrictEqual(h.session.loadedFile, { path, version: 2 });

      // Merged before its check ran: only the newer one runs.
      const busy = h.lookup('busy');
      const ran: string[] = [];
      track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 3 }, beforeSend: () => (ran.push('v3'), Promise.reject(new Error('v3'))) }));
      const v4 = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 4 }, beforeSend: () => (ran.push('v4'), Promise.resolve()) }));
      await flush();
      h.t.message(ret(3n));
      await flush();
      assert.strictEqual(busy.state, 'resolved');
      assert.deepStrictEqual(ran, ['v4']);
      h.t.message(ret(4n, ok()));
      await flush();
      assert.strictEqual(v4.state, 'resolved');
    });

    // M2 integration after the second verification: a check of the older caller that settled
    // while the newer caller's was still running was taken for the newer one's (both ran for the
    // same process), so the load was sent before the newer check had passed, or rejected for both
    // callers by the older reading.
    test('merged loads: an older caller\'s check that settles first, passing or failing, decides nothing', async () => {
      const h = await readySession();
      const path = '/w/A.idr';
      const older = deferred<void>();
      const newer = deferred<void>();
      const first = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 1 }, beforeSend: () => older.promise }));
      await flush(); // the older check runs
      const second = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 2 }, beforeSend: () => newer.promise }));
      await flush();
      older.resolve(); // passes first: ignored
      await flush();
      assert.deepStrictEqual(h.t.sent.slice(1), [], 'nothing is sent before the newer check passes');
      newer.resolve();
      await flush();
      assert.deepStrictEqual(h.t.sent.slice(1), [{ command: loadFile(path), id: 2n }]);
      h.t.message(ret(2n, ok()));
      await flush();
      assert.strictEqual(first.state, 'resolved');
      assert.strictEqual(second.state, 'resolved');

      const olderRefusal = deferred<void>();
      const newerPass = deferred<void>();
      const third = track(
        h.session.request(loadFile(path), {
          kind: 'load',
          file: { path, version: 3 },
          beforeSend: () => olderRefusal.promise.then(() => Promise.reject(new Error('the older check'))),
        }),
      );
      await flush();
      const fourth = track(h.session.request(loadFile(path), { kind: 'load', file: { path, version: 4 }, beforeSend: () => newerPass.promise }));
      await flush();
      olderRefusal.resolve(); // fails first: ignored
      await flush();
      assert.strictEqual(third.state, 'pending');
      assert.strictEqual(fourth.state, 'pending');
      newerPass.resolve();
      await flush();
      assert.deepStrictEqual(h.t.lastSent(), { command: loadFile(path), id: 3n });
      h.t.message(ret(3n, ok()));
      await flush();
      assert.strictEqual(third.state, 'resolved');
      assert.strictEqual(fourth.state, 'resolved');
    });
  });

  suite('crashes, backoff and give-up', () => {
    test('the process ends during a request: it rejects with BackendCrashed naming the exit; the queue waits for the new process', async () => {
      const h = await readySession();
      const first = h.lookup('a');
      const second = h.lookup('b');
      await flush();
      h.t.stderr('Exception: out of memory\n');
      h.t.exit({ code: 3, signal: null });
      await flush();
      assert.strictEqual(kindOf(first), 'BackendCrashed');
      assert.strictEqual(
        messageOf(first),
        'The Idris 2 process ended while answering :type-of: the Idris 2 process exited with code 3; its last error output: Exception: out of memory.',
      );
      const next = h.transports.last();
      assert.notStrictEqual(next, h.t);
      assert.deepStrictEqual(next.sent.map((s) => s.command), [typeOf('b')]);
      next.message(ret(next.lastSent().id));
      await flush();
      assert.strictEqual(second.state, 'resolved');
    });

    test('restarts after 0 s, 2 s and 10 s; the fourth unexpected end within five minutes gives up', async () => {
      const h = await readySession();
      const crash = () => h.transports.last().exit({ code: 1, signal: null });
      crash();
      await flush();
      assert.strictEqual(h.transports.all.length, 2, 'first restart: at once');
      crash();
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      assert.deepStrictEqual(h.clock.pending(), [2_000]);
      h.clock.advance(1_999);
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      h.clock.advance(1);
      await flush();
      assert.strictEqual(h.transports.all.length, 3, 'second restart: after 2 s');
      crash();
      await flush();
      assert.deepStrictEqual(h.clock.pending(), [10_000]);
      h.clock.advance(10_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 4, 'third restart: after 10 s');
      const waiting = h.lookup();
      await flush();
      crash();
      await flush();
      assert.strictEqual(h.session.state, 'failed');
      const last = h.changes[h.changes.length - 1];
      assert.strictEqual(last.cause, 'gaveUp');
      assert.match(last.detail ?? '', /4 unexpected ends within 5 min, and the session restarts itself at most 3 times/);
      assert.strictEqual(kindOf(waiting), 'BackendCrashed');
      h.clock.advance(60 * 60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 4, 'no restart after giving up');
      const later = h.lookup();
      await flush();
      assert.match(messageOf(later), /^The Idris 2 session has failed: /);
      assert.ok(h.log.lines.some((l) => l.startsWith('warn: ') && l.includes('failed (gaveUp)')));
    });

    test('unexpected ends more than five minutes apart never give up and restart at once', async () => {
      const h = await readySession();
      for (let i = 0; i < 6; i++) {
        h.clock.advance(5 * 60_000);
        h.transports.last().exit({ code: 1, signal: null });
        await flush();
        assert.strictEqual(h.session.state, 'ready', `crash ${i + 1}`);
      }
      assert.strictEqual(h.transports.all.length, 7);
    });

    test('never two processes: a restart waits until the old process has ended', async () => {
      const h = await readySession({ behaviour: { onStop: 'manual' } });
      const load = track(h.session.request(loadFile('/w/A.idr'), { kind: 'load', file: { path: '/w/A.idr' } }));
      const queued = h.lookup('after');
      await flush();
      h.session.restart('the idris2.ideMode settings changed: arguments');
      await flush();
      assert.ok(cancelled(load), 'abandoned by the restart, not failed');
      assert.match(messageOf(load), /restarted \(the idris2.ideMode settings changed: arguments\) while answering :load-file/);
      assert.strictEqual(h.session.state, 'restarting');
      assert.strictEqual(h.transports.all.length, 1, 'not before the old process has ended');
      h.t.exit({ code: null, signal: 'SIGTERM' });
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      assert.strictEqual(h.transports.maxAlivePerCwd, 1);
      assert.deepStrictEqual(h.transports.last().sent.map((s) => s.command), [typeOf('after')]);
      assert.strictEqual(queued.state, 'pending');
      assert.deepStrictEqual(causes(h.changes), [
        'ready→busy:dispatch',
        'busy→restarting:restart',
        'restarting→starting:backoff',
        'starting→ready:handshake',
        'ready→busy:dispatch',
      ]);
    });
  });

  suite('prepare: consent and toolchain', () => {
    test('a refusal rejects the waiting requests with its error; the session stays stopped and nothing is started', async () => {
      const h = setup();
      h.control.plan = () => Promise.resolve({ refused: unsupported('Idris 2 is not started in /w/loose-file: "Don\'t Allow" was chosen') });
      const a = h.lookup('a');
      const b = h.lookup('b');
      await flush();
      assert.strictEqual(kindOf(a), 'Unsupported');
      assert.strictEqual(kindOf(b), 'Unsupported');
      assert.strictEqual(h.control.prepares, 1, 'one question for both');
      assert.strictEqual(h.session.state, 'stopped');
      assert.deepStrictEqual(h.changes, []);
      assert.strictEqual(h.transports.all.length, 0);
      h.control.plan = () => Promise.resolve({ refused: new IdrisException({ kind: 'ToolchainMissing', message: 'No Idris 2 compiler to start' }) });
      const c = h.lookup();
      await flush();
      assert.strictEqual(kindOf(c), 'ToolchainMissing');
    });

    test('while prepare waits (the consent question is open) the session stays stopped; a stop then starts nothing', async () => {
      const h = setup();
      const answer = deferred<SpawnPlan>();
      h.control.plan = () => answer.promise;
      const request = h.lookup();
      await flush();
      assert.strictEqual(h.session.state, 'stopped');
      h.lookup('second');
      await flush();
      assert.strictEqual(h.control.prepares, 1);
      h.session.stop('stop', 'Stop Backend');
      await flush();
      assert.ok(cancelled(request));
      // Announced although the state stays stopped, so that the status reads "stopped".
      assert.deepStrictEqual(causes(h.changes), ['stopped→stopped:stop']);
      answer.resolve({ launch: LAUNCH });
      await flush();
      assert.strictEqual(h.transports.all.length, 0);
      assert.strictEqual(h.session.state, 'stopped');
      // A second Stop Backend, or a release of a stopped session with nothing waiting, announces nothing.
      h.session.stop('stop', 'Stop Backend');
      h.session.stop('closed', 'the last open document of its root was closed');
      assert.deepStrictEqual(causes(h.changes), ['stopped→stopped:stop']);
    });

    test('a stop while the old process is still ending cancels the next start before anyone is asked', async () => {
      const h = await readySession({ behaviour: { onStop: 'manual' } });
      h.session.stop('stop', 'Stop Backend');
      const request = h.lookup();
      await flush();
      assert.strictEqual(h.control.prepares, 1, 'the new start waits for the old process to end');
      h.session.stop('stop', 'Stop Backend');
      h.t.exit({ code: null, signal: 'SIGTERM' });
      await flush();
      assert.ok(cancelled(request));
      assert.strictEqual(h.control.prepares, 1, 'prepare (the consent question) is not reached');
      assert.strictEqual(h.transports.all.length, 1);
    });

    test('at a restart, a refused consent stops the session and a missing compiler makes it fail', async () => {
      const h = await readySession();
      h.control.plan = () => Promise.resolve({ refused: unsupported('running Idris 2 in /w/loose-file is no longer allowed') });
      const waiting = h.lookup();
      await flush();
      h.t.exit({ code: 1, signal: null });
      await flush();
      assert.strictEqual(h.session.state, 'stopped');
      assert.strictEqual(h.changes[h.changes.length - 1].cause, 'consentRevoked');
      assert.strictEqual(kindOf(waiting), 'BackendCrashed', 'the request in flight ended with the process');

      const g = await readySession();
      g.control.plan = () => Promise.resolve({ refused: new IdrisException({ kind: 'ToolchainMissing', message: 'No Idris 2 compiler to start: gone' }) });
      g.t.exit({ code: 1, signal: null });
      await flush();
      assert.strictEqual(g.session.state, 'failed');
      assert.strictEqual(g.changes[g.changes.length - 1].cause, 'spawnError');
      assert.strictEqual(g.changes[g.changes.length - 1].detail, 'No Idris 2 compiler to start: gone');

      // A directory that is gone is no revocation (M2 verification of the third review: the status
      // said the permission was revoked and promised a question): stopped, cause spawnError.
      const u = await readySession();
      u.control.plan = () => Promise.resolve({ refused: unsupported('Idris 2 is not started in “/w/loose-file”: its real path could not be read (ENOENT)'), unresolved: true });
      u.t.exit({ code: 1, signal: null });
      await flush();
      assert.strictEqual(u.session.state, 'stopped');
      assert.strictEqual(u.changes[u.changes.length - 1].cause, 'spawnError');
    });
  });

  suite('stop, restart, idle, dispose', () => {
    test('stop rejects every request as cancelled, leaves no process, and the next request starts one again', async () => {
      const h = await readySession();
      const first = h.lookup('a');
      const second = h.lookup('b');
      await flush();
      h.session.stop('stop', 'Stop Backend');
      await flush();
      // Abandoned on purpose, not failed: an Error named Cancelled (the checks keep what they showed).
      assert.ok(cancelled(first));
      assert.strictEqual(messageOf(first), 'The Idris 2 session was stopped (Stop Backend).');
      assert.ok(cancelled(second));
      assert.strictEqual(h.session.state, 'stopped');
      assert.strictEqual(h.session.launch, undefined);
      assert.strictEqual(h.t.stopCalls, 1);
      assert.strictEqual(h.transports.alive().length, 0);
      h.clock.advance(60_000);
      await flush();
      assert.strictEqual(h.transports.all.length, 1);
      h.lookup('again');
      await flush();
      assert.strictEqual(h.transports.all.length, 2);
      assert.deepStrictEqual(causes(h.changes).slice(0, 3), ['ready→busy:dispatch', 'busy→stopped:stop', 'stopped→starting:start']);
    });

    test('consent revoked: requests reject with Unsupported', async () => {
      const h = await readySession();
      const request = h.lookup();
      await flush();
      h.session.stop('consentRevoked', 'running Idris 2 in /w/loose-file is no longer allowed');
      await flush();
      assert.strictEqual(kindOf(request), 'Unsupported');
      assert.strictEqual(h.changes[h.changes.length - 1].cause, 'consentRevoked');
    });

    test('restart from any state clears failed; reset returns failed to stopped', async () => {
      const h = await readySession();
      h.session.restart('Restart Backend');
      await flush();
      assert.strictEqual(h.session.state, 'ready');
      assert.strictEqual(h.transports.all.length, 2);
      assert.deepStrictEqual(causes(h.changes), ['ready→restarting:restart', 'restarting→starting:backoff', 'starting→ready:handshake']);

      const f = setup({ behaviour: { handshake: [1, 0] } });
      f.lookup();
      await flush();
      assert.strictEqual(f.session.state, 'failed');
      f.session.reset('the idris2.ideMode settings changed');
      assert.strictEqual(f.session.state, 'stopped');
      assert.strictEqual(causes(f.changes).at(-1), 'failed→stopped:reconfigure');
      f.transports.behaviour = {};
      f.session.restart('Restart Backend');
      await flush();
      assert.strictEqual(f.session.state, 'ready');

      const s = setup();
      s.session.restart('Restart Backend');
      await flush();
      assert.strictEqual(s.session.state, 'ready', 'a stopped session starts at once');
      assert.deepStrictEqual(causes(s.changes), ['stopped→starting:restart', 'starting→ready:handshake']);

      // The pool's restarts for a changed command line carry their own cause.
      s.session.restart('the idris2.ideMode settings changed: arguments', 'reconfigure');
      await flush();
      assert.deepStrictEqual(causes(s.changes).slice(2), ['ready→restarting:reconfigure', 'restarting→starting:backoff', 'starting→ready:handshake']);
    });

    test('a listener that stops the session while it announces a restart cancels the new start', async () => {
      const h = await readySession();
      h.session.onDidChangeState((change) => {
        if (change.state === 'restarting') {
          h.session.stop('stop', 'Stop Backend');
        }
      });
      h.session.restart('Restart Backend');
      await flush();
      assert.strictEqual(h.session.state, 'stopped');
      assert.strictEqual(h.transports.all.length, 1);
    });

    test('idle: a ready session with nothing to do stops after idleTimeout; a request in between restarts the count; 0 never stops', async () => {
      const h = await readySession({ limits: { idleTimeoutMs: 600_000 } });
      assert.deepStrictEqual(h.clock.pending(), [600_000]);
      h.clock.advance(599_999);
      h.lookup();
      await flush();
      assert.deepStrictEqual(h.clock.pending(), [5_000], 'no idle timer while busy');
      h.t.message(ret(2n));
      await flush();
      h.clock.advance(599_999);
      assert.strictEqual(h.session.state, 'ready');
      h.clock.advance(1);
      assert.strictEqual(h.session.state, 'stopped');
      assert.strictEqual(h.changes[h.changes.length - 1].cause, 'idle');
      assert.strictEqual(h.t.stopCalls, 1);

      const never = await readySession({ limits: { idleTimeoutMs: 0 } });
      assert.deepStrictEqual(never.clock.pending(), []);
    });

    test('dispose kills the process at once and rejects everything; later requests reject', async () => {
      const h = await readySession();
      const request = h.lookup();
      await flush();
      h.session.dispose();
      await flush();
      assert.strictEqual(h.t.disposed, true);
      assert.strictEqual(kindOf(request), 'BackendCrashed');
      assert.strictEqual(h.changes[h.changes.length - 1].cause, 'dispose');
      const later = h.lookup();
      await flush();
      assert.strictEqual(kindOf(later), 'BackendCrashed');
      assert.strictEqual(h.transports.all.length, 1);
    });
  });

  suite('dispose while a process is still ending', () => {
    test('a stopped process that has not ended yet is killed at once too', async () => {
      const h = await readySession({ behaviour: { onStop: 'manual' } });
      h.session.restart('Restart Backend');
      await flush();
      assert.strictEqual(h.t.stopCalls, 1);
      assert.strictEqual(h.t.disposed, false, 'still in its grace period');
      h.session.dispose();
      assert.strictEqual(h.t.disposed, true);
      assert.strictEqual(h.transports.all.length, 1);
    });
  });

  suite('trace', () => {
    test('frames, unframed bytes, output and state changes go to the trace while it is enabled, under "check <cwd>"', async () => {
      const h = await readySession();
      h.lookup();
      await flush();
      h.t.stdout('hi\n');
      h.t.stderr('warning\n');
      h.t.unframed(END_OF_INPUT);
      h.t.message(ret(2n));
      await flush();
      const directions = h.trace.entries.map((e) => e.direction);
      for (const direction of ['event', 'send', 'receive', 'stdout', 'stderr', 'unframed'] as const) {
        assert.ok(directions.includes(direction), direction);
      }
      assert.ok(h.trace.entries.every((e) => e.session === 'check /w/loose-file'));
      assert.ok(h.trace.entries.some((e) => e.direction === 'event' && e.text.startsWith('start /opt/homebrew/bin/idris2 --ide-mode-socket')));
      assert.ok(h.trace.entries.some((e) => e.direction === 'event' && e.text === 'ready → busy (dispatch)'));
      assert.strictEqual(h.session.state, 'ready', 'program output on stdout is not a protocol error');

      const count = h.trace.entries.length;
      h.trace.enabled = false;
      h.lookup();
      await flush();
      h.t.message(ret(3n));
      await flush();
      assert.strictEqual(h.trace.entries.length, count);
    });
  });
});
