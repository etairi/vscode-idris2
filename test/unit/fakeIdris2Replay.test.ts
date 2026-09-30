// test/fake-idris2's transcript replay (M2) and injected protocol faults. The expected replies
// are the recorded ones of test/fixtures/transcripts/0.8.0 (the real compiler's, recorded by
// scripts/record-transcripts.mjs), with this run's paths and ids in them; see
// test/fake-idris2/README.md "Transcript replay".
import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  exchanges,
  fakeEnvironment,
  FrameReader,
  mapTrailingId,
  readTranscripts,
  recordedArgs,
  requestFrame,
  substitute,
  tolerateReset,
  transcriptsDir,
  type Frame,
  type Transcript,
} from '../fake-idris2/client';
import { fakeScript, repoRoot } from '../fake-tools/paths';

const FAKE = fakeScript('idris2');
const DIR = transcriptsDir('0.8.0');
const TRANSCRIPTS = readTranscripts(DIR);
const HANDSHAKE: Frame = { prefix: 0x18, text: '(:protocol-version 2 1)\n' };
const WINDOWS = process.platform === 'win32';

/** A frame as the compiler sends it: the prefix counts code points (F1 addendum). */
const frame = (text: string): Frame => ({ prefix: Array.from(text).length, text });

/** Unframed program output as the reader returns it, one item per line. */
const unframed = (text: string): Frame[] => (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => ({ prefix: -1, text: line }));

/** A running fake in IDE mode, over either transport, with its protocol stream and stdout. */
interface Fake {
  readonly child: ChildProcessWithoutNullStreams;
  readonly protocol: FrameReader;
  send(bytes: Buffer): void;
  /** Ends the input: stdin over stdio, the client's side of the socket otherwise. */
  end(): void;
  /** Program output on the process stdout after the port line (socket only; F5). */
  stdout(): string;
  stderr(): string;
  readonly exit: Promise<number | null>;
  /** Rethrows an unexpected socket error (see `tolerateReset`). */
  check(): void;
}

let running: ChildProcessWithoutNullStreams[] = [];

async function startFake(
  transport: 'stdio' | 'socket',
  cwd: string,
  env: Readonly<Record<string, string>> = { FAKE_IDRIS2_TRANSCRIPTS: DIR },
  extraArgs: readonly string[] = ['--no-color', '--build-dir', path.join(cwd, 'build', '.vscode-idris2')],
): Promise<Fake> {
  const mode = transport === 'stdio' ? '--ide-mode' : '--ide-mode-socket';
  const child = spawn(process.execPath, [FAKE, mode, ...extraArgs], { cwd, env: fakeEnvironment(env) });
  running.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  if (transport === 'stdio') {
    return {
      child,
      protocol: new FrameReader(child.stdout),
      send: (bytes) => child.stdin.write(bytes),
      end: () => child.stdin.end(),
      stdout: () => '',
      stderr: () => stderr,
      exit,
      check: () => undefined,
    };
  }
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  while (!stdout.includes('\n')) {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('exit', () => reject(new Error(`the fake exited before printing its port; stderr: ${stderr}`)));
    });
  }
  const portLine = stdout.slice(0, stdout.indexOf('\n') + 1);
  assert.match(portLine, /^[0-9]+\n$/);
  const socket = net.connect(Number(portLine), '127.0.0.1');
  const check = tolerateReset(socket);
  return {
    child,
    protocol: new FrameReader(socket),
    send: (bytes) => socket.write(bytes),
    end: () => socket.end(),
    stdout: () => stdout.slice(portLine.length),
    stderr: () => stderr,
    exit,
    check,
  };
}

/** Reads `count` items from the protocol stream. */
async function read(fake: Fake, count: number): Promise<Frame[]> {
  const items: Frame[] = [];
  while (items.length < count) {
    items.push(await fake.protocol.next());
  }
  return items;
}

/**
 * Reads items up to and including the next `:return` frame. Every request gets one, from the
 * recording or the fake's own "no recorded reply" error, so a wrong replay fails at once instead
 * of waiting for frames that never come.
 */
async function readToReturn(fake: Fake): Promise<Frame[]> {
  const items: Frame[] = [];
  for (;;) {
    const item = await fake.protocol.next();
    items.push(item);
    if (item.prefix >= 0 && item.text.startsWith('(:return ')) {
      return items;
    }
  }
}

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A temporary directory, as its real path (on macOS /var is a link to /private/var). */
function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-replay-')));
}

/** `session dir/<name>` of the broken workspace. */
const broken = (name = ''): string => path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'broken', name);

/** A `:load-file` request frame for `file` with `id`. */
const loadFile = (file: string, id: number): Buffer =>
  requestFrame(`((:load-file "${file.replace(/[\\"]/g, (c) => `\\${c}`)}") ${id})\n`);

teardown(() => {
  running.forEach((child) => child.kill());
  running = [];
});

suite('test/fake-idris2: the transcripts', () => {
  test('there are transcripts, and each names the facts it pins', () => {
    assert.ok(TRANSCRIPTS.length >= 31, `${TRANSCRIPTS.length} transcripts in ${DIR}`);
    for (const t of TRANSCRIPTS) {
      assert.strictEqual(t.meta.format, 1, t.meta.scenario);
      assert.ok(t.meta.facts.length > 0, t.meta.scenario);
    }
  });

  test('every fixture file a transcript read still has its recorded SHA-256 (else record it again)', () => {
    for (const t of TRANSCRIPTS) {
      for (const [rel, recorded] of Object.entries(t.meta.fixtures)) {
        const file = path.join(repoRoot(), t.meta.cwd, rel);
        assert.strictEqual(sha256(file), recorded, `${t.meta.scenario}: ${file} changed; run \`npm run record:transcripts\``);
      }
    }
  });
});

/**
 * Replays `transcript` against the fake over `transport` and compares every item of the protocol
 * stream, the program output and the exit code with the recording. The fake runs in the
 * scenario's fixture workspace in this checkout (through a symbolic link to it when the recording
 * did), with the recording's own arguments after the mode flag (so in its session role: the
 * `eval-*` scenarios were recorded with the `eval` session's build directory), and every request
 * id is shifted by 1000 to show that ids are matched after normalisation;
 * the ids in the expected replies are shifted the same way (0, the id before the first
 * recognised request, stays 0: F4).
 */
async function replayTranscript(transcript: Transcript, transport: 'stdio' | 'socket'): Promise<void> {
  const root = fs.realpathSync(path.join(repoRoot(), transcript.meta.cwd));
  const values: Record<string, string> = { '${ROOT}': root };
  let cwd = root;
  let linkDir: string | undefined;
  if (transcript.meta.processCwd === '${LINK}') {
    linkDir = tempDir();
    const link = path.join(linkDir, 'link');
    fs.symlinkSync(root, link, 'dir');
    values['${LINK}'] = link;
    cwd = link;
  }
  const shift = (id: bigint): bigint => (id === 0n ? 0n : id + 1000n);
  const args = recordedArgs(transcript, values);
  try {
    const fake = await startFake(transport, cwd, undefined, args);
    assert.deepStrictEqual(await fake.protocol.next(), HANDSHAKE);
    const recorded = exchanges(transcript);
    let expectedStdout = '';
    for (const exchange of recorded.exchanges) {
      fake.send(requestFrame(mapTrailingId(substitute(exchange.request, values), shift)));
      const expected: Frame[] = [];
      for (const item of exchange.replies) {
        if (item.kind === 'frame') {
          expected.push(frame(mapTrailingId(substitute(item.text, values), shift)));
        } else if (transport === 'stdio') {
          expected.push(...unframed(item.text));
        } else {
          expectedStdout += item.text;
        }
      }
      assert.deepStrictEqual(await readToReturn(fake), expected, `reply to ${exchange.request}`);
    }
    fake.end();
    assert.strictEqual(await fake.exit, recorded.exitCode);
    if (transport === 'stdio') {
      assert.strictEqual(await fake.protocol.rest(), recorded.tailOutput);
    } else {
      expectedStdout += recorded.tailOutput;
    }
    assert.strictEqual(fake.stdout(), expectedStdout);
    assert.strictEqual(fake.stderr(), '');
    fake.check();
  } finally {
    if (linkDir !== undefined) {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  }
}

for (const transport of ['stdio', 'socket'] as const) {
  suite(`test/fake-idris2: every transcript replayed over ${transport}`, function () {
    this.timeout(20000);
    for (const transcript of TRANSCRIPTS) {
      test(`${transcript.meta.scenario} (${transcript.meta.facts.join(', ')})`, async function () {
        if (WINDOWS && transcript.meta.processCwd === '${LINK}') {
          // Creating a directory symbolic link needs a privilege the Windows runners' user lacks.
          this.skip();
        }
        await replayTranscript(transcript, transport);
      });
    }
  });
}

suite('test/fake-idris2: replay rules', function () {
  this.timeout(20000);

  test('a reload is answered with the recorded reload, whatever came before (F7)', async () => {
    // Bad, Warn, Warn was never recorded as one session. The third load's recorded predecessor
    // in load-warn (Warn) matches, so it gets load-warn's reload: no Building line, no :warning.
    const fake = await startFake('stdio', broken());
    await fake.protocol.next();
    fake.send(loadFile(broken('Bad.idr'), 1));
    assert.match((await fake.protocol.next()).text, /^\(:write-string "1\/1: Building Bad /);
    const warn = async (id: number): Promise<string[]> => {
      fake.send(loadFile(broken('Warn.idr'), id));
      return (await readToReturn(fake)).map((item) => item.text);
    };
    await read(fake, 2); // Bad's :warning and :return
    const first = await warn(2);
    assert.ok(first.some((t) => t.startsWith('(:write-string "1/1: Building Warn ')), first.join(''));
    assert.ok(first.some((t) => t.startsWith('(:warning ("Warn.idr" (4 0) (4 3) "Unreachable clause: f n')), first.join(''));
    const second = await warn(3);
    assert.ok(!second.some((t) => t.startsWith('(:write-string') || t.startsWith('(:warning')), second.join(''));
    assert.ok(second.some((t) => t.startsWith('(:output (:ok (:highlight-source')));
    assert.strictEqual(second.at(-1), '(:return (:ok ()) 3)\n');
  });

  test('a copy of the workspace elsewhere is replayed with its own paths', async () => {
    const dir = tempDir();
    try {
      fs.copyFileSync(broken('Bad.idr'), path.join(dir, 'Bad.idr'));
      const fake = await startFake('stdio', dir);
      await fake.protocol.next();
      fake.send(loadFile(path.join(dir, 'Bad.idr'), 5));
      const [building, warning, ret] = await read(fake, 3);
      assert.strictEqual(building.text, `(:write-string "1/1: Building Bad (${path.join(dir, 'Bad.idr').replace(/\\/g, '\\\\')})" 5)\n`);
      assert.match(warning.text, /^\(:warning \("Bad\.idr" \(3 6\) \(3 11\) "While processing right hand side of f\./);
      assert.strictEqual(ret.text, `(:return (:error "Error(s) building file ${path.join(dir, 'Bad.idr').replace(/\\/g, '\\\\')}") 5)\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a changed fixture file is not answered from its stale recording', async () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'Bad.idr'), `${fs.readFileSync(broken('Bad.idr'), 'utf8')}\n-- changed\n`);
      const fake = await startFake('stdio', dir);
      await fake.protocol.next();
      fake.send(loadFile(path.join(dir, 'Bad.idr'), 5));
      const reply = await fake.protocol.next();
      assert.strictEqual(
        reply.text,
        '(:return (:error "fake-idris2: no recorded reply for (:load-file \\"${ROOT}/Bad.idr\\")") 5)\n',
      );
      assert.strictEqual(fake.stderr(), 'fake-idris2: no recorded reply for (:load-file "${ROOT}/Bad.idr")\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown request: an error with its own id and a line on stderr; the session goes on', async () => {
    const fake = await startFake('socket', broken());
    await fake.protocol.next();
    fake.send(requestFrame('((:frobnicate "x" 3) 41)\n'));
    assert.deepStrictEqual(
      await fake.protocol.next(),
      frame('(:return (:error "fake-idris2: no recorded reply for (:frobnicate \\"x\\" 3)") 41)\n'),
    );
    // Not an s-expression: the id of the last request (F4's rule for unattributable replies).
    fake.send(requestFrame('((:frobnicate 42\n'));
    assert.deepStrictEqual(
      await fake.protocol.next(),
      frame('(:return (:error "fake-idris2: no recorded reply for \\"((:frobnicate 42\\\\n\\"") 41)\n'),
    );
    fake.send(requestFrame('(:version 43)\n'));
    assert.deepStrictEqual(await fake.protocol.next(), frame('(:return (:ok ((0 8 0) (""))) 43)\n'));
    assert.strictEqual(
      fake.stderr(),
      'fake-idris2: no recorded reply for (:frobnicate "x" 3)\nfake-idris2: no recorded reply for "((:frobnicate 42\\n"\n',
    );
    fake.end();
    assert.strictEqual(await fake.exit, 1);
    fake.check();
  });

  test(':version is still answered by the fake itself (FAKE_IDRIS2_VERSION applies)', async () => {
    const fake = await startFake('stdio', broken(), { FAKE_IDRIS2_TRANSCRIPTS: DIR, FAKE_IDRIS2_VERSION: '0.8.0-1c630e67c' });
    await fake.protocol.next();
    fake.send(requestFrame('(:version 1)\n'));
    assert.deepStrictEqual(await fake.protocol.next(), frame('(:return (:ok ((0 8 0) ("1c630e67c"))) 1)\n'));
  });

  test('a transcript directory that cannot be read, or an event that cannot be replayed, is a test error (exit 2)', () => {
    const run = (dir: string) =>
      spawnSync(process.execPath, [FAKE, '--ide-mode'], {
        cwd: broken(),
        env: fakeEnvironment({ FAKE_IDRIS2_TRANSCRIPTS: dir }),
        input: '',
        encoding: 'utf8',
      });
    const dir = tempDir();
    try {
      const missing = run(path.join(dir, 'missing'));
      assert.strictEqual(missing.status, 2);
      assert.match(missing.stderr, /FAKE_IDRIS2_TRANSCRIPTS=.* cannot be read/);
      assert.strictEqual(missing.stdout, '');
      const empty = run(dir);
      assert.strictEqual(empty.status, 2);
      assert.match(empty.stderr, /has no \.jsonl transcript/);
      const meta = fs.readFileSync(path.join(DIR, 'load-bad.jsonl'), 'utf8').split('\n')[0];
      fs.writeFileSync(
        path.join(dir, 'crashed.jsonl'),
        [meta, '{"kind":"send","prefix":"00000d","text":"(:version 1)\\n"}', '{"kind":"exit","code":139,"signal":null}', ''].join('\n'),
      );
      const crashed = run(dir);
      assert.strictEqual(crashed.status, 2);
      assert.match(crashed.stderr, /crashed\.jsonl: cannot replay a "exit" event before the end of input/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('test/fake-idris2: session roles and the request log (M3)', function () {
  this.timeout(20000);
  const buildDir = (role: string): string[] => ['--no-color', '--build-dir', path.join(broken(), 'build', role)];
  const interpret = (text: string, id: number): Buffer => requestFrame(`((:interpret "${text}") ${id})\n`);

  test('an eval session (build/.vscode-idris2-eval) is answered from the eval recordings', async () => {
    const fake = await startFake('stdio', broken(), undefined, buildDir('.vscode-idris2-eval'));
    await fake.protocol.next();
    fake.send(loadFile(broken('Clean.idr'), 1));
    const load = await readToReturn(fake);
    assert.match(load[0].text, /^\(:write-string "1\/1: Building Clean /); // its own build directory: built
    assert.strictEqual(load.at(-1)?.text, '(:return (:ok ()) 1)\n');
    fake.send(interpret('the (Vect 2 Nat) [1, 2]', 2));
    assert.deepStrictEqual(
      await fake.protocol.next(),
      frame('(:return (:ok "[1, 2]" ((1 1 ((:decor :data))) (4 1 ((:decor :data))))) 2)\n'),
    );
    assert.strictEqual(fake.stderr(), '');
  });

  test('a check session (build/.vscode-idris2) gets no reply recorded in the eval role', async () => {
    const fake = await startFake('stdio', broken(), undefined, buildDir('.vscode-idris2'));
    await fake.protocol.next();
    fake.send(loadFile(broken('Clean.idr'), 1));
    await readToReturn(fake);
    fake.send(interpret('the (Vect 2 Nat) [1, 2]', 2));
    assert.deepStrictEqual(
      await fake.protocol.next(),
      frame('(:return (:error "fake-idris2: no recorded reply for (:interpret \\"the (Vect 2 Nat) [1, 2]\\")") 2)\n'),
    );
  });

  test('without a build directory the role is unknown, and the recordings of both roles are eligible', async () => {
    for (const args of [['--no-color'], buildDir('elsewhere')]) {
      const fake = await startFake('stdio', broken(), undefined, args);
      await fake.protocol.next();
      fake.send(interpret('the (Vect 2 Nat) [1, 2]', 1));
      assert.match((await fake.protocol.next()).text, /^\(:return \(:ok "\[1, 2\]" /, args.join(' '));
    }
  });

  test('FAKE_IDRIS2_REQUEST_LOG: every request read, with the pid, as UTF-8 text, answered or not', async () => {
    const dir = tempDir();
    try {
      const log = path.join(dir, 'requests.jsonl');
      const fake = await startFake('stdio', broken(), { FAKE_IDRIS2_TRANSCRIPTS: DIR, FAKE_IDRIS2_REQUEST_LOG: log });
      await fake.protocol.next();
      const requests = ['(:version 1)\n', '((:interpret "\\"→\\"") 2)\n', '((:frobnicate) 3)\n'];
      for (const request of requests) {
        fake.send(requestFrame(request));
        await readToReturn(fake);
      }
      fake.end();
      await fake.exit;
      const entries = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown);
      assert.deepStrictEqual(entries, requests.map((request) => ({ pid: fake.child.pid, request })));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FAKE_IDRIS2_REQUEST_LOG: a request that hangs the compiler is logged, nothing after it', async () => {
    const dir = tempDir();
    try {
      const log = path.join(dir, 'requests.jsonl');
      const fake = await startFake('stdio', broken(), { FAKE_IDRIS2_REQUEST_LOG: log, FAKE_IDRIS2_IDE_FAULT: 'hang@1', FAKE_TOOL_HANG_LIMIT_MS: '300' });
      await fake.protocol.next();
      fake.send(requestFrame('(:version 1)\n'));
      fake.send(requestFrame('(:version 2)\n'));
      assert.strictEqual(await fake.exit, 1);
      assert.deepStrictEqual(
        fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown),
        [{ pid: fake.child.pid, request: '(:version 1)\n' }],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('test/fake-idris2: command lines', function () {
  this.timeout(20000);

  test('the session command line of ARCHITECTURE §5.2 is accepted in any order; FAKE_IDRIS2_LOG records it', async () => {
    const dir = tempDir();
    try {
      const log = path.join(dir, 'log.jsonl');
      const args = ['--no-color', '-p', 'contrib', '--ide-mode-socket', '--build-dir', path.join(dir, 'b'), '--package', 'network'];
      const child = spawn(process.execPath, [FAKE, ...args], { cwd: dir, env: fakeEnvironment({ FAKE_IDRIS2_LOG: log }) });
      running.push(child);
      const stdout = new FrameReader(child.stdout);
      const port = await stdout.next();
      assert.match(port.text, /^[0-9]+\n$/);
      const socket = net.connect(Number(port.text), '127.0.0.1');
      const check = tolerateReset(socket);
      assert.deepStrictEqual(await new FrameReader(socket).next(), HANDSHAKE);
      socket.end();
      await new Promise((resolve) => child.on('exit', resolve));
      check();
      const entries = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown);
      assert.deepStrictEqual(entries, [{ pid: child.pid, args, cwd: dir }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const args of [['--ide-mode', '--find-ipkg'], ['--ide-mode', '--ide-mode-socket'], ['--ide-mode', '-p'], ['--no-color']]) {
    test(`${args.join(' ')} is refused (exit 2): not a command line the extension sends`, () => {
      const r = spawnSync(process.execPath, [FAKE, ...args], { env: fakeEnvironment({}), input: '', encoding: 'utf8' });
      assert.strictEqual(r.status, 2);
      assert.match(r.stderr, /arguments not implemented by the fake/);
      assert.strictEqual(r.stdout, '');
    });
  }
});

suite('test/fake-idris2: injected protocol faults (FAKE_IDRIS2_IDE_FAULT)', function () {
  this.timeout(20000);
  const withFault = (fault: string): Record<string, string> => ({ FAKE_IDRIS2_TRANSCRIPTS: DIR, FAKE_IDRIS2_IDE_FAULT: fault });

  test('crash@2: the second request gets no reply; a line on stderr; exit 3', async () => {
    const fake = await startFake('stdio', broken(), withFault('crash@2'));
    await fake.protocol.next();
    fake.send(requestFrame('(:version 1)\n'));
    assert.deepStrictEqual(await fake.protocol.next(), frame('(:return (:ok ((0 8 0) (""))) 1)\n'));
    fake.send(requestFrame('(:version 2)\n'));
    assert.strictEqual(await fake.exit, 3);
    assert.strictEqual(await fake.protocol.rest(), '');
    assert.strictEqual(fake.stderr(), 'fake-idris2: simulated crash at request 2 (FAKE_IDRIS2_IDE_FAULT)\n');
  });

  test('crash-in-reply@1: the first bytes of a reply frame, then a line on stderr, then exit 3 (over the socket too)', async () => {
    for (const transport of ['stdio', 'socket'] as const) {
      const fake = await startFake(transport, broken(), withFault('crash-in-reply@1'));
      await fake.protocol.next();
      fake.send(requestFrame('(:version 1)\n'));
      assert.strictEqual(await fake.exit, 3, transport);
      assert.strictEqual(await fake.protocol.rest(), '000040(:write-string "partial', transport);
      assert.strictEqual(fake.stderr(), 'fake-idris2: simulated crash inside a reply at request 1 (FAKE_IDRIS2_IDE_FAULT)\n');
    }
  });

  test('hang@1: no reply, the end of input is not noticed, exit 1 after FAKE_TOOL_HANG_LIMIT_MS', async () => {
    const started = Date.now();
    const fake = await startFake('socket', broken(), { ...withFault('hang@1'), FAKE_TOOL_HANG_LIMIT_MS: '500' });
    await fake.protocol.next();
    fake.send(requestFrame('(:version 1)\n'));
    fake.end();
    assert.strictEqual(await fake.exit, 1);
    assert.ok(Date.now() - started >= 500, `${Date.now() - started} ms`);
    assert.strictEqual(fake.stdout(), ''); // no end-of-input line
    fake.check();
  });

  test('noise@1: an unframed line in the protocol stream before the reply (over the socket too)', async () => {
    for (const transport of ['stdio', 'socket'] as const) {
      const fake = await startFake(transport, broken(), withFault('noise@1'));
      await fake.protocol.next();
      fake.send(requestFrame('(:version 1)\n'));
      assert.deepStrictEqual(await read(fake, 2), [
        { prefix: -1, text: 'fake-idris2: injected noise (FAKE_IDRIS2_IDE_FAULT)\n' },
        frame('(:return (:ok ((0 8 0) (""))) 1)\n'),
      ]);
      fake.check();
    }
  });

  test('id-mismatch@2: only the :return of the second request carries another id', async () => {
    const fake = await startFake('stdio', broken(), withFault('id-mismatch@2'));
    await fake.protocol.next();
    fake.send(requestFrame('(:version 1)\n'));
    await fake.protocol.next();
    fake.send(loadFile(broken('Bad.idr'), 2));
    const [building, warning, ret] = await read(fake, 3);
    assert.match(building.text, / 2\)\n$/);
    assert.match(warning.text, / 2\)\n$/);
    assert.match(ret.text, /^\(:return \(:error "Error\(s\) building file .*"\) 1000002\)\n$/);
    fake.send(requestFrame('(:version 3)\n'));
    assert.deepStrictEqual(await fake.protocol.next(), frame('(:return (:ok ((0 8 0) (""))) 3)\n'));
  });

  test('faults also apply without transcripts', async () => {
    const fake = await startFake('stdio', broken(), { FAKE_IDRIS2_IDE_FAULT: 'id-mismatch@1' });
    await fake.protocol.next();
    fake.send(requestFrame('(:version 1)\n'));
    assert.deepStrictEqual(await fake.protocol.next(), frame('(:return (:ok ((0 8 0) (""))) 1000001)\n'));
  });

  for (const spec of ['explode@1', 'crash@0', 'crash', 'crash@1,hang@1']) {
    test(`FAKE_IDRIS2_IDE_FAULT=${spec} is a test error (exit 2)`, () => {
      const r = spawnSync(process.execPath, [FAKE, '--ide-mode'], {
        env: fakeEnvironment({ FAKE_IDRIS2_IDE_FAULT: spec }),
        input: '',
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 2);
      assert.match(r.stderr, /FAKE_IDRIS2_IDE_FAULT must be/);
      assert.strictEqual(r.stdout, '');
    });
  }
});
