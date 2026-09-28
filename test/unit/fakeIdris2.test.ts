// test/fake-idris2 against the replies the real compiler gave. Every expected string below was
// recorded from Homebrew idris2 0.8.0 (macOS arm64) on 2026-09-26 by sending the same bytes to
// `idris2 --ide-mode` and `idris2 --ide-mode-socket`; see test/fake-idris2/README.md.
import * as assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as net from 'net';
import { FrameReader, fakeEnvironment, requestFrame, tolerateReset } from '../fake-idris2/client';
import { fakeScript } from '../fake-tools/paths';

const FAKE = fakeScript('idris2');

/** A request frame for the s-expression `sexp` (F1: the prefix counts UTF-8 bytes). */
const request = (sexp: string): Buffer => requestFrame(sexp + '\n');

const exitOf = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise((resolve) => child.on('exit', (code) => resolve(code)));

const HANDSHAKE = '(:protocol-version 2 1)\n';
const VERSION_OK = (id: string) => `(:return (:ok ((0 8 0) (""))) ${id})\n`;
const ALAS = 'Alas the file is done, aborting\n';
// "é→𝕟" is 2 + 3 + 4 UTF-8 bytes. The compiler reads one Char per byte, so it echoes each byte
// as the Latin-1 character with that code, which it then writes out as UTF-8.
const NON_ASCII = 'é→𝕟';
const NON_ASCII_ECHO = Buffer.from(NON_ASCII, 'utf8').toString('latin1');

suite('test/fake-idris2 (M0 skeleton)', function () {
  // Spawning Node is slow on Windows runners; nothing here waits on a timer.
  this.timeout(20000);

  let children: ChildProcessWithoutNullStreams[] = [];
  const start = (...args: string[]): ChildProcessWithoutNullStreams => {
    const child = spawn(process.execPath, [FAKE, ...args], { env: fakeEnvironment({}) });
    children.push(child);
    return child;
  };
  teardown(() => {
    children.forEach((c) => c.kill());
    children = [];
  });

  test('--version prints the 0.8.0 version line', () => {
    const r = spawnSync(process.execPath, [FAKE, '--version'], { encoding: 'utf8', env: fakeEnvironment({}) });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, 'Idris 2, version 0.8.0\n');
  });

  test('stdio: handshake, then (:version ID) with a bare-symbol command', async () => {
    const child = start('--ide-mode');
    const reader = new FrameReader(child.stdout);
    assert.deepStrictEqual(await reader.next(), { prefix: 0x18, text: HANDSHAKE });
    child.stdin.write(request('(:version 1)'));
    assert.deepStrictEqual(await reader.next(), { prefix: 0x21, text: VERSION_OK('1') });
  });

  test('stdio: an unrecognised command is answered with the previous id (F4)', async () => {
    const child = start('--ide-mode');
    const reader = new FrameReader(child.stdout);
    await reader.next();
    child.stdin.write(request('(:bogus 5)'));
    assert.strictEqual((await reader.next()).text, '(:return (:error "Unrecognised command: (:bogus 5)") 0)\n');
    child.stdin.write(request('(:version 7)'));
    await reader.next();
    child.stdin.write(request('((:version) 8)'));
    assert.strictEqual((await reader.next()).text, '(:return (:error "Unrecognised command: ((:version) 8)") 7)\n');
  });

  test('stdio: requests are framed by UTF-8 bytes, replies by code points', async () => {
    const child = start('--ide-mode');
    const reader = new FrameReader(child.stdout);
    await reader.next();
    // Both requests in one write: the second is answered only if the first was cut by bytes.
    child.stdin.write(Buffer.concat([request(`((:frobnicate "${NON_ASCII}") 2)`), request('(:version 3)')]));
    const echo = await reader.next();
    const expected = `(:return (:error "Unrecognised command: ((:frobnicate \\"${NON_ASCII_ECHO}\\") 2)") 0)\n`;
    assert.strictEqual(echo.text, expected);
    assert.strictEqual(echo.prefix, Array.from(expected).length);
    assert.notStrictEqual(echo.prefix, Buffer.byteLength(expected, 'utf8'));
    assert.deepStrictEqual(await reader.next(), { prefix: 0x21, text: VERSION_OK('3') });
  });

  test('stdio: a request framed by code points desynchronises the stream (F1)', async () => {
    const child = start('--ide-mode');
    const reader = new FrameReader(child.stdout);
    await reader.next();
    const text = `((:frobnicate "${NON_ASCII}") 2)\n`;
    const byChars = Array.from(text).length.toString(16).padStart(6, '0');
    child.stdin.write(Buffer.concat([Buffer.from(byChars + text, 'utf8'), request('(:version 3)')]));
    // The request is cut 6 bytes short (a parse error). Its last 6 bytes are then read as a
    // header, which is not hex, so the rest of the line — the whole (:version 3) request — is
    // appended to them (a second parse error), and that request is never answered. The real
    // compiler does the same; only the text after "Parse error: " differs.
    assert.match((await reader.next()).text, /^\(:return \(:error "Parse error: .*\) 0\)\n$/s);
    assert.match((await reader.next()).text, /^\(:return \(:error "Parse error: .*\) 0\)\n$/s);
    child.stdin.end();
    assert.deepStrictEqual(await reader.next(), { prefix: -1, text: ALAS });
  });

  test('stdio: end of input prints the unframed tail and exits 1 (F5)', async () => {
    const child = start('--ide-mode');
    const reader = new FrameReader(child.stdout);
    const exit = exitOf(child);
    await reader.next();
    child.stdin.end();
    assert.deepStrictEqual(await reader.next(), { prefix: -1, text: ALAS });
    assert.strictEqual(await exit, 1);
  });

  // Recorded 2026-09-27 with `printf '<input>' | idris2 --ide-mode` (0.8.0, macOS arm64). One
  // read past the end succeeds in C stdio, so a request read that stops exactly at the end is
  // dropped and the session ends silently with exit 0; a second read past the end prints the
  // end-of-input line (see `endsSilently` in fake-idris2.mjs).
  const endOfInputCases: [input: string, replies: string, exit: number][] = [
    ['', '', 1],
    ['(:ve', '', 1],
    ['00000', '', 0],
    ['(:version 1)', '', 0],
    ['(:vers', '', 0],
    ['ab\ncdefg', '', 0],
    ['00000d(:version 1)', '', 0],
    ['00000e(:version 1)', '', 1],
    ['00000c(:version 1)00000c(:version 2', `000021${VERSION_OK('1')}`, 0],
    ['(:version 1)\n', `000021${VERSION_OK('1')}`, 1],
  ];
  for (const [input, replies, code] of endOfInputCases) {
    test(`stdio: end of input after ${JSON.stringify(input)} → exit ${code}`, async () => {
      const child = start('--ide-mode');
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      const exit = exitOf(child);
      child.stdin.end(input, 'latin1');
      assert.strictEqual(await exit, code);
      assert.strictEqual(stdout, `000018${HANDSHAKE}${replies}${code === 1 ? ALAS : ''}`);
    });
  }

  test('stdio: requests split across many reads (one byte per write) are reassembled', async () => {
    const child = start('--ide-mode');
    const stdout = new FrameReader(child.stdout);
    const exit = exitOf(child);
    assert.deepStrictEqual(await stdout.next(), { prefix: 0x18, text: HANDSHAKE });
    // Written after the handshake, so the fake is already reading; yielding to the event loop
    // after each byte makes the fake see (almost always) one- or two-byte chunks, splitting
    // headers, payloads and the UTF-8 sequences of the non-ASCII text.
    const input = Buffer.concat([
      request('(:version 1)'),
      request(`((:frobnicate "${NON_ASCII}") 2)`),
      Buffer.from('(:version 3)\n', 'ascii'),
    ]);
    for (const byte of input) {
      await new Promise<void>((resolve) => child.stdin.write(Buffer.from([byte]), () => resolve()));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    child.stdin.end();
    assert.strictEqual((await stdout.next()).text, VERSION_OK('1'));
    assert.strictEqual(
      (await stdout.next()).text,
      `(:return (:error "Unrecognised command: ((:frobnicate \\"${NON_ASCII_ECHO}\\") 2)") 1)\n`,
    );
    assert.strictEqual((await stdout.next()).text, VERSION_OK('3'));
    assert.deepStrictEqual(await stdout.next(), { prefix: -1, text: ALAS });
    assert.strictEqual(await exit, 1);
  });

  test('socket: a connection reset prints "Failed to read a character" and exits 1', async () => {
    // Recorded from idris2 0.8.0 for a reset while idle, after a partial header, inside an
    // unframed line and inside a frame's payload (test/fake-idris2/README.md); this is the idle case.
    const child = start('--ide-mode-socket');
    const stdout = new FrameReader(child.stdout);
    const exit = exitOf(child);
    const portLine = await stdout.next();
    const socket = net.connect(Number(portLine.text), '127.0.0.1');
    socket.on('error', () => undefined);
    const reader = new FrameReader(socket);
    assert.deepStrictEqual(await reader.next(), { prefix: 0x18, text: HANDSHAKE });
    socket.resetAndDestroy();
    assert.deepStrictEqual(await stdout.next(), { prefix: -1, text: 'Failed to read a character\n' });
    assert.strictEqual(await exit, 1);
  });

  test('socket: an unframed request cut off by the client closing ends silently with exit 0', async () => {
    const child = start('--ide-mode-socket');
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    const exit = exitOf(child);
    while (!stdout.includes('\n')) {
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    }
    const socket = net.connect(Number(stdout.trim()), '127.0.0.1');
    const checkSocket = tolerateReset(socket);
    const reader = new FrameReader(socket);
    assert.deepStrictEqual(await reader.next(), { prefix: 0x18, text: HANDSHAKE });
    socket.end('(:version 1)');
    assert.strictEqual(await exit, 0);
    assert.match(stdout, /^[0-9]+\n$/);
    checkSocket();
  });

  test('socket: prints the port, serves the protocol, exits 1 when the client leaves', async () => {
    const child = start('--ide-mode-socket');
    const stdout = new FrameReader(child.stdout);
    const exit = exitOf(child);
    const portLine = await stdout.next();
    assert.match(portLine.text, /^[0-9]+\n$/);
    assert.strictEqual(portLine.prefix, -1);

    const socket = net.connect(Number(portLine.text), '127.0.0.1');
    const checkSocket = tolerateReset(socket);
    const reader = new FrameReader(socket);
    assert.deepStrictEqual(await reader.next(), { prefix: 0x18, text: HANDSHAKE });
    socket.write(request('(:version 99999999999999999999)'));
    assert.strictEqual((await reader.next()).text, VERSION_OK('99999999999999999999'));
    socket.write(request(`((:frobnicate "${NON_ASCII}") 9)`));
    assert.strictEqual(
      (await reader.next()).text,
      `(:return (:error "Unrecognised command: ((:frobnicate \\"${NON_ASCII_ECHO}\\") 9)") 99999999999999999999)\n`,
    );

    socket.end();
    assert.deepStrictEqual(await stdout.next(), { prefix: -1, text: ALAS });
    assert.strictEqual(await exit, 1);
    checkSocket();
  });
});
