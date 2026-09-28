// backend/ide/transport.ts against real processes: the fake compiler (test/fake-idris2, M0
// behaviour: handshake and :version) over stdio and the socket, and small Node scripts for what
// the fake does not do (output after the port line, a bad port line, a closed connection, output
// without a line break). Frames are cut by the real decoder (`ideCodec`, wire.ts). The time
// limits are deadlines for things that must happen, never races.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ideCodec, version } from '../../src/backend/ide/protocol';
import { createTransport, describeExit, MAX_BEFORE_PORT_BYTES, type TransportDeps } from '../../src/backend/ide/transport';
import type { IncomingFrame, SessionLaunch, Transport, TransportExit } from '../../src/backend/ide/types';
import { Emitter } from '../../src/core/event';
import { fakeScript } from '../fake-tools/paths';
import { recordingLog } from './support/fakeTransport';

const NODE = process.execPath;
const POSIX = process.platform !== 'win32';
/** The M0 behaviour of the fake: no transcripts. */
const ENV = { ...process.env, FAKE_IDRIS2_TRANSCRIPTS: '' };

function deps(overrides: Partial<TransportDeps> = {}): TransportDeps {
  return {
    codec: ideCodec,
    trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
    log: recordingLog(),
    platform: process.platform,
    processEnv: ENV,
    ...overrides,
  };
}

function launch(transport: SessionLaunch['transport'], args: string[]): SessionLaunch {
  return { executable: NODE, args, cwd: os.tmpdir(), env: {}, transport };
}

/** A transport with everything it emits recorded; `next()` waits for the next protocol item. */
function observe(transport: Transport) {
  const frames: IncomingFrame[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const order: string[] = [];
  const waiters: Array<() => void> = [];
  let taken = 0;
  let resolveExit: (exit: TransportExit) => void = () => undefined;
  const exit = new Promise<TransportExit>((resolve) => {
    resolveExit = resolve;
  });
  let exits = 0;
  transport.onFrame((item) => {
    frames.push(item);
    order.push(item.kind);
    waiters.splice(0).forEach((w) => w());
  });
  transport.onStdout((text) => {
    stdout.push(text);
    waiters.splice(0).forEach((w) => w());
  });
  transport.onStderr((text) => {
    stderr.push(text);
    waiters.splice(0).forEach((w) => w());
  });
  transport.onExit((e) => {
    exits++;
    order.push('exit');
    resolveExit(e);
  });
  const until = (done: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = () => (done() ? resolve() : waiters.push(check));
      check();
    });
  return {
    frames,
    stdout,
    stderr,
    order,
    exit,
    exits: () => exits,
    until,
    async next(): Promise<IncomingFrame> {
      await until(() => frames.length > taken);
      return frames[taken++];
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sendVersion(transport: Transport, id: bigint): void {
  transport.send(ideCodec.encodeRequest(version(), id).bytes);
}

const HANDSHAKE = { kind: 'framed', text: '(:protocol-version 2 1)\n', byteLength: 30 } as const;
const VERSION_REPLY = (id: number) => `(:return (:ok ((0 8 0) (""))) ${id})\n`;

/** A socket server in a Node script: prints the port (and `after`) on stdout, sends the handshake to its one client, then runs `onClient`. */
function socketScript(after: string, onClient = ''): string {
  return (
    "const net = require('net');" +
    'const server = net.createServer((c) => { server.close(); c.write(\'000018(:protocol-version 2 1)\\n\');' +
    onClient +
    '});' +
    "server.listen(0, '127.0.0.1', () => { process.stdout.write(server.address().port + '\\n'); " +
    after +
    ' });' +
    'setInterval(() => {}, 1000);'
  );
}

suite('backend/ide/transport', function () {
  // Process start-up is slow on some CI machines; no assertion depends on it.
  this.timeout(30_000);

  test('stdio: the fake compiler answers the handshake and :version; stop ends the process', async () => {
    const transport = createTransport(launch('stdio', [fakeScript('idris2'), '--ide-mode', '--no-color']), deps());
    const seen = observe(transport);
    assert.strictEqual(transport.kind, 'stdio');
    await transport.start();
    assert.deepStrictEqual(await seen.next(), HANDSHAKE);
    sendVersion(transport, 1n);
    assert.deepStrictEqual(await seen.next(), { kind: 'framed', text: VERSION_REPLY(1), byteLength: 39 });
    transport.stop();
    await seen.exit;
    assert.deepStrictEqual(seen.stdout, [], 'over stdio nothing goes to onStdout');
    assert.strictEqual(seen.exits(), 1);
  });

  test('socket: the port is read from stdout, the protocol runs over 127.0.0.1; exit fires once, after the socket closed', async () => {
    const transport = createTransport(launch('socket', [fakeScript('idris2'), '--ide-mode-socket', '--no-color']), deps());
    const seen = observe(transport);
    assert.strictEqual(transport.kind, 'socket');
    await transport.start();
    assert.deepStrictEqual(await seen.next(), HANDSHAKE);
    sendVersion(transport, 2n);
    assert.deepStrictEqual(await seen.next(), { kind: 'framed', text: VERSION_REPLY(2), byteLength: 39 });
    assert.deepStrictEqual(seen.stdout, [], 'the port line is not program output');
    transport.stop();
    await seen.exit;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(seen.exits(), 1);
  });

  test('socket: stdout after the port line is forwarded, decoded as UTF-8 across reads', async () => {
    const after = "const b = Buffer.from('hello →'); process.stdout.write(b.subarray(0, 7)); setTimeout(() => process.stdout.write(b.subarray(7)), 50);";
    const transport = createTransport(launch('socket', ['-e', socketScript(after)]), deps());
    const seen = observe(transport);
    await transport.start();
    assert.deepStrictEqual(await seen.next(), HANDSHAKE);
    await seen.until(() => seen.stdout.join('') === 'hello →');
    transport.stop();
    await seen.exit;
  });

  test('socket: lines before the port line (--log output) go to stdout, and the start goes on to the port', async () => {
    // As `idris2 --ide-mode-socket --log 10` prints them while the prelude loads [live, 0.8.0].
    const before = "process.stdout.write('LOG ttc.read:10: Prelude.Uninhabited\\n0\\n99999\\nLOG x:1: 123'); setTimeout(() => process.stdout.write('\\n'), 30);";
    const script = socketScript('').replace("server.listen(0, '127.0.0.1', () => {", `${before} setTimeout(() => server.listen(0, '127.0.0.1', () => {`)
      .replace(' });setInterval', ' }), 60);setInterval');
    const transport = createTransport(launch('socket', ['-e', script]), deps());
    const seen = observe(transport);
    await transport.start();
    assert.deepStrictEqual(await seen.next(), HANDSHAKE);
    assert.strictEqual(seen.stdout.join(''), 'LOG ttc.read:10: Prelude.Uninhabited\n0\n99999\nLOG x:1: 123\n');
    transport.stop();
    await seen.exit;
  });

  test('socket: a compiler that cannot open its socket prints why and exits: the start fails with the exit, the line goes to stdout', async () => {
    const transport = createTransport(launch('socket', ['-e', "console.log('Failed to open socket'); process.exit(1);"]), deps());
    const seen = observe(transport);
    await assert.rejects(transport.start(), /^Error: idris2 exited with code 1 before printing the port of its socket$/);
    assert.deepStrictEqual(await seen.exit, { code: 1, signal: null });
    assert.strictEqual(seen.stdout.join(''), 'Failed to open socket\n');
  });

  test('socket: more than 1 MiB of stdout without a port line fails the start and stops the process', async () => {
    const transport = createTransport(
      launch('socket', ['-e', "const l = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 1100; i++) process.stdout.write(l); setInterval(() => {}, 1000);"]),
      deps(),
    );
    const seen = observe(transport);
    await assert.rejects(transport.start(), new RegExp(`printed more than ${MAX_BEFORE_PORT_BYTES} bytes on stdout without the port of its socket`));
    await seen.exit;
    assert.ok(seen.stdout.join('').length > MAX_BEFORE_PORT_BYTES);
  });

  test('socket: a process that ends before printing its port fails start and reports its exit', async () => {
    const transport = createTransport(launch('socket', ['-e', "process.stderr.write('boom\\n'); process.exit(3);"]), deps());
    const seen = observe(transport);
    await assert.rejects(transport.start(), /^Error: idris2 exited with code 3 before printing the port of its socket$/);
    assert.deepStrictEqual(await seen.exit, { code: 3, signal: null });
    assert.strictEqual(seen.stderr.join(''), 'boom\n');
  });

  test('socket: when the compiler closes the connection the process is stopped, so that exit always follows', async () => {
    const transport = createTransport(launch('socket', ['-e', socketScript('', 'setTimeout(() => c.destroy(), 100);')]), deps());
    const seen = observe(transport);
    await transport.start();
    assert.deepStrictEqual(await seen.next(), HANDSHAKE);
    const exit = await seen.exit;
    assert.strictEqual(exit.connectionClosed, true, 'the exit says that the compiler closed the connection first');
    if (POSIX) {
      assert.strictEqual(exit.signal, 'SIGTERM');
      assert.strictEqual(describeExit(exit), 'closed its IDE-mode connection while it still ran, and was then stopped (SIGTERM)');
    }
  });

  test('socket: only frames travel there — a reply with an unknown head is a frame, and a stream cut before a header\'s "(" is truncated, before the exit', async () => {
    // M2 verification of the third review: requiring one of the six reply heads on the socket made a
    // newer compiler's reply a protocol error there, and a stream that ended inside a header lost the exit.
    const transport = createTransport(
      launch('socket', ['-e', socketScript('', "c.write('000012(:progress \"x\" 1)\\n'); setTimeout(() => { c.write('00004'); setTimeout(() => process.exit(3), 50); }, 50);")]),
      deps(),
    );
    const seen = observe(transport);
    await transport.start();
    const exit = await seen.exit;
    assert.deepStrictEqual(seen.frames, [
      HANDSHAKE,
      { kind: 'framed', text: '(:progress "x" 1)\n', byteLength: 24 },
      { kind: 'truncated', text: '00004', byteLength: 5 },
    ]);
    assert.deepStrictEqual(seen.order, ['framed', 'framed', 'truncated', 'exit']);
    assert.strictEqual(exit.code, 3);
    assert.strictEqual(transport.receivedBytes, 59);
  });

  test('socket: bytes that do not complete an item yet count as received (the connection is served)', async () => {
    const script =
      "const net = require('net'); const server = net.createServer((c) => { server.close(); c.write('000018(:protocol-ver'); });" +
      " server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n')); setInterval(() => {}, 1000);";
    const transport = createTransport(launch('socket', ['-e', script]), deps());
    const seen = observe(transport);
    try {
      await transport.start();
      const deadline = Date.now() + 20_000;
      while (transport.receivedBytes === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.strictEqual(transport.receivedBytes, 20);
      assert.deepStrictEqual(seen.frames, []);
      transport.stop();
      await seen.exit;
      assert.deepStrictEqual(seen.frames, [{ kind: 'truncated', text: '000018(:protocol-ver', byteLength: 20 }]);
    } finally {
      transport.dispose(); // also when an assertion failed: the script never ends by itself
    }
  });

  test('socket: a stop by the session is not a connection closed by the compiler', async () => {
    const transport = createTransport(launch('socket', ['-e', socketScript('')]), deps());
    const seen = observe(transport);
    await transport.start();
    assert.deepStrictEqual(await seen.next(), HANDSHAKE);
    transport.stop();
    assert.strictEqual((await seen.exit).connectionClosed, undefined);
  });

  test('stdio: unframed program output and, at the end, an incomplete tail arrive as unframed items before the exit', async () => {
    const script = "process.stdout.write('000018(:protocol-version 2 1)\\nhi\\nabc'); process.exitCode = 1;";
    const transport = createTransport(launch('stdio', ['-e', script]), deps());
    const seen = observe(transport);
    await transport.start();
    await seen.exit;
    assert.deepStrictEqual(seen.frames, [
      HANDSHAKE,
      { kind: 'unframed', text: 'hi\n', byteLength: 3 },
      { kind: 'unframed', text: 'abc', byteLength: 3 },
    ]);
    assert.deepStrictEqual(seen.order, ['framed', 'unframed', 'unframed', 'exit']);
  });

  test('stdio: frames split across reads, also inside the prefix and inside a UTF-8 sequence, arrive whole', async () => {
    // The reply's prefix counts code points (F1 addendum): `→` is one code point and three bytes.
    // Cuts: inside the first prefix, at the frame boundary (30), inside the second prefix, and at
    // 52 and 53, inside the three bytes of `→` (51–53).
    const reply = '(:return (:ok "→") 1)\n';
    const script =
      `const t = ${JSON.stringify(reply)};` +
      "const f = Buffer.concat([Buffer.from('000018(:protocol-version 2 1)\\n'), Buffer.from([...t].length.toString(16).padStart(6, '0') + t)]);" +
      'const cuts = [3, 10, 30, 33, 45, 52, 53];' +
      'let from = 0; const next = () => { if (cuts.length === 0) { process.stdout.write(f.subarray(from)); return; }' +
      ' const to = cuts.shift(); process.stdout.write(f.subarray(from, to)); from = to; setTimeout(next, 20); }; next();';
    const transport = createTransport(launch('stdio', ['-e', script]), deps());
    const seen = observe(transport);
    await transport.start();
    await seen.exit;
    assert.deepStrictEqual(seen.frames, [HANDSHAKE, { kind: 'framed', text: reply, byteLength: 6 + Buffer.byteLength(reply) }]);
  });

  test('the process starts in the real path the gate judged (realCwd), not through the spelled path', async () => {
    // M2 second verification of the third review: spawned with the spelled path, the child resolved
    // its symbolic links again when it changed into it, after the gate's verdict.
    const real = fs.realpathSync(os.tmpdir());
    const spelled = path.join(real, `vi2-no-such-dir-${process.pid}`);
    const transport = createTransport({ ...launch('stdio', ['-e', 'process.stderr.write(process.cwd())']), cwd: spelled, realCwd: real }, deps());
    const seen = observe(transport);
    await transport.start();
    await seen.exit;
    assert.strictEqual(fs.realpathSync(seen.stderr.join('')), real);
  });

  test('stderr is decoded as UTF-8 across reads', async () => {
    const script = "const b = Buffer.from('→'); process.stderr.write(b.subarray(0, 1)); setTimeout(() => { process.stderr.write(b.subarray(1)); }, 50);";
    const transport = createTransport(launch('stdio', ['-e', script]), deps());
    const seen = observe(transport);
    await transport.start();
    await seen.exit;
    assert.strictEqual(seen.stderr.join(''), '→');
  });

  test('stdio: a process that ends inside a frame: its rest is one truncated item, then its stderr and exit', async () => {
    const script =
      "process.stdout.write('000018(:protocol-version 2 1)\\n000040(:write-string \\\"partial', () =>" +
      " process.stderr.write('Exception in fGetChar: heap exhausted\\n', () => process.exit(3)));";
    const transport = createTransport(launch('stdio', ['-e', script]), deps());
    const seen = observe(transport);
    await transport.start();
    const exit = await seen.exit;
    assert.deepStrictEqual(seen.frames, [HANDSHAKE, { kind: 'truncated', text: '000040(:write-string "partial', byteLength: 29 }]);
    assert.deepStrictEqual(seen.order, ['framed', 'truncated', 'exit']);
    assert.strictEqual(exit.code, 3);
    assert.strictEqual(seen.stderr.join(''), 'Exception in fGetChar: heap exhausted\n');
  });

  test('more bytes than the bound without a complete item: one overflow item with them, the rest dropped, the process stopped', async () => {
    const log = recordingLog();
    const script = "process.stdout.write('x'.repeat(5000)); setInterval(() => process.stdout.write('y'), 10);";
    const transport = createTransport(launch('stdio', ['-e', script]), deps({ log, maxPendingBytes: 1000 }));
    const seen = observe(transport);
    await transport.start();
    await seen.exit;
    assert.strictEqual(seen.frames.length, 1);
    assert.strictEqual(seen.frames[0].kind, 'overflow', 'the session treats it as a protocol error, not as program output');
    assert.ok(seen.frames[0].text.length > 1000 && /^x+$/.test(seen.frames[0].text), `${seen.frames[0].text.length} characters`);
    assert.ok(log.lines.some((l) => l.startsWith('warn: ') && l.includes('more than 1000 bytes of its protocol stream are not a frame')));
  });

  test('a start that cannot happen rejects, and exit reports the spawn error: a missing executable, Restricted Mode', async () => {
    const missing = createTransport({ ...launch('stdio', []), executable: `${os.tmpdir()}/vi2-no-such-dir/idris2` }, deps());
    const seenMissing = observe(missing);
    await assert.rejects(missing.start(), /could not be started \(ENOENT/);
    assert.match((await seenMissing.exit).spawnError ?? '', /^ENOENT/);

    const restricted = createTransport(
      launch('socket', [fakeScript('idris2'), '--ide-mode-socket']),
      deps({ trust: { isTrusted: false, onDidGrant: new Emitter<void>().event } }),
    );
    const seenRestricted = observe(restricted);
    await assert.rejects(restricted.start(), /Restricted Mode/);
    assert.match((await seenRestricted.exit).spawnError ?? '', /Restricted Mode/);
    assert.strictEqual(seenRestricted.exits(), 1);
  });

  test('dispose kills the process at once, also one that ignores SIGTERM; nothing is emitted afterwards', async () => {
    const script = "process.on('SIGTERM', () => {}); process.stderr.write(String(process.pid)); setInterval(() => {}, 1000);";
    const transport = createTransport(launch('stdio', ['-e', script]), deps({ graceMs: 60_000 }));
    const seen = observe(transport);
    await transport.start();
    await seen.until(() => /^\d+$/.test(seen.stderr.join('')));
    const pid = Number(seen.stderr.join(''));
    transport.dispose();
    transport.dispose();
    const deadline = Date.now() + 10_000;
    while (alive(pid)) {
      assert.ok(Date.now() < deadline, `process ${pid} is still running`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(seen.exits(), 0);
  });
});
