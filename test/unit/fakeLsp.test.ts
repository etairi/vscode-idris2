// test/fake-lsp, the fake idris2-lsp language server of the lsp suite (M5): every recording of
// test/fixtures/lsp-transcripts (the real server's sessions, scripts/record-lsp-transcripts.mjs)
// replayed against it in a copy of its workspace, the matching rules, the logs, the fault, and the
// launcher. test/fake-lsp/README.md describes what is tested here.
import * as assert from 'assert';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { fakeEnvironment } from '../fake-idris2/client';
import { fakeScript, repoRoot } from '../fake-tools/paths';

const LSP_DIR = path.join(repoRoot(), 'test', 'fake-lsp');
const SERVER = path.join(LSP_DIR, 'server.mjs');
const LAUNCHER = path.join(LSP_DIR, 'bin', 'idris2-lsp');
const TRANSCRIPTS_DIR = path.join(repoRoot(), 'test', 'fixtures', 'lsp-transcripts', '0.1.0-9a2f0ad6a');
const WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// The recordings, read here without the module under test
// ---------------------------------------------------------------------------------------------

interface Meta {
  readonly scenario: string;
  readonly facts: readonly string[];
  readonly workspace: string;
  readonly extra?: Readonly<Record<string, string>>;
  readonly fixtures: Readonly<Record<string, string>>;
}

interface Event {
  readonly kind: string;
  readonly text?: string;
  readonly file?: string;
  readonly action?: string;
  readonly sha256?: string;
  readonly code?: number | null;
}

interface Transcript {
  readonly meta: Meta;
  readonly events: readonly Event[];
}

interface Message {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TRANSCRIPTS: readonly Transcript[] = fs
  .readdirSync(TRANSCRIPTS_DIR)
  .filter((name) => name.endsWith('.jsonl'))
  .sort()
  .map((name) => {
    const [meta, ...events] = fs
      .readFileSync(path.join(TRANSCRIPTS_DIR, name), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
    return { meta: meta as Meta, events: events as Event[] };
  });

const transcript = (scenario: string): Transcript => {
  const found = TRANSCRIPTS.find((t) => t.meta.scenario === scenario);
  assert.ok(found, `no transcript ${scenario}`);
  return found;
};

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The file of the repository a fixture path of `t`'s workspace copy came from. */
const fixtureSource = (t: Transcript, rel: string): string =>
  path.join(repoRoot(), t.meta.extra?.[rel] ?? path.join(t.meta.workspace, rel));

/** A body as the server writes it: non-ASCII characters as `\uXXXX` in capitals (the README's "Format"). */
const serverJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);

const frame = (body: string): string => `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;

/** `text` with the placeholders of the recordings written as `root` and the home directory. */
function substitute(text: string, root: string, json: boolean): string {
  const lit = (s: string): string => (json ? JSON.stringify(s).slice(1, -1) : s);
  const home = os.homedir();
  return text
    .replaceAll('file://${ROOT}', lit(pathToFileURL(root).href))
    .replaceAll('${ROOT}', lit(root))
    .replaceAll('file://${HOME}', lit(pathToFileURL(home).href))
    .replaceAll('${HOME}', lit(home));
}

/** A fresh copy of `t`'s workspace (no `build/`), with its extra files, as a real path. */
function copyWorkspace(t: Transcript): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-fakelsp-')));
  fs.cpSync(path.join(repoRoot(), t.meta.workspace), root, { recursive: true, filter: (p) => path.basename(p) !== 'build' });
  for (const [rel, source] of Object.entries(t.meta.extra ?? {})) {
    fs.copyFileSync(path.join(repoRoot(), source), path.join(root, rel));
  }
  copies.push(root);
  return root;
}

// ---------------------------------------------------------------------------------------------
// A client of the fake
// ---------------------------------------------------------------------------------------------

let running: ChildProcessWithoutNullStreams[] = [];
let copies: string[] = [];

teardown(() => {
  running.forEach((child) => child.kill());
  running = [];
  copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  copies = [];
});

class FakeServer {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = Buffer.alloc(0);
  stderr = '';
  readonly exit: Promise<number | null>;
  private exited = false;

  constructor(cwd: string, env: Readonly<Record<string, string>> = {}) {
    this.child = spawn(process.execPath, [SERVER], {
      cwd,
      env: fakeEnvironment({ FAKE_IDRIS2_LSP_TRANSCRIPTS: TRANSCRIPTS_DIR, ...env }),
    });
    running.push(this.child);
    this.child.stdout.on('data', (chunk: Buffer) => (this.stdout = Buffer.concat([this.stdout, chunk])));
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk));
    this.exit = new Promise((resolve) =>
      this.child.on('exit', (code) => {
        this.exited = true;
        resolve(code);
      }),
    );
  }

  send(message: Message): void {
    this.child.stdin.write(frame(JSON.stringify(message)));
  }

  /** Waits until stdout holds at least `bytes` bytes (or the process ended, or 5 s passed). */
  async until(bytes: number): Promise<void> {
    const start = Date.now();
    while (this.stdout.length < bytes && !this.exited && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** The framed messages of stdout, in order. */
  messages(): Message[] {
    const out: Message[] = [];
    let rest = this.stdout;
    for (;;) {
      const end = rest.indexOf('\r\n\r\n');
      if (end < 0) {
        return out;
      }
      const length = Number(/Content-Length: (\d+)/.exec(rest.subarray(0, end).toString('ascii'))?.[1]);
      out.push(JSON.parse(rest.subarray(end + 4, end + 4 + length).toString('utf8')) as Message);
      rest = rest.subarray(end + 4 + length);
    }
  }

  /** Sends `message` and returns the messages written in answer (it waits until `count` of them came). */
  async exchange(message: Message, count = 1): Promise<Message[]> {
    const before = this.messages().length;
    this.send(message);
    const start = Date.now();
    while (this.messages().length < before + count && !this.exited && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.messages().slice(before);
  }
}

interface LoggedMessage {
  readonly pid: number;
  readonly message: Message;
  readonly replay: string | null;
}

const readLog = <T>(file: string): T[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as T)
    : [];

/** The `initialize` request, with the extension's default options (`backend/lsp/types.ts` `LspServerOptions`). */
const initialize = (root: string, id = 1, options: Record<string, unknown> = {}): Message => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    processId: null,
    rootUri: pathToFileURL(root).href,
    capabilities: {},
    initializationOptions: {
      logSeverity: 'debug',
      longActionTimeout: 1000,
      maxCodeActionResults: 5,
      showImplicits: false,
      showMachineNames: false,
      fullNamespace: false,
      briefCompletions: false,
      ...options,
    },
  },
});

const uriOf = (root: string, rel: string): string => pathToFileURL(path.join(root, rel)).href;

const didOpen = (root: string, rel: string): Message => ({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: {
    textDocument: { uri: uriOf(root, rel), languageId: 'idris2', version: 1, text: fs.readFileSync(path.join(root, rel), 'utf8') },
  },
});

const at = (root: string, rel: string, method: string, id: number, line: number, character: number): Message => ({
  jsonrpc: '2.0',
  id,
  method,
  params: { textDocument: { uri: uriOf(root, rel) }, position: { line, character } },
});

// ---------------------------------------------------------------------------------------------
// The recordings
// ---------------------------------------------------------------------------------------------

suite('test/fake-lsp: the recordings it replays', () => {
  test('there are recordings, of format 1, each naming the facts it pins', () => {
    assert.ok(TRANSCRIPTS.length >= 19, `${TRANSCRIPTS.length} transcripts in ${TRANSCRIPTS_DIR}`);
    for (const t of TRANSCRIPTS) {
      assert.strictEqual((t.meta as unknown as { format: number }).format, 1, t.meta.scenario);
      assert.ok(t.meta.facts.length > 0, t.meta.scenario);
    }
  });

  test('every fixture file a recording read still has its recorded SHA-256 (else record it again)', () => {
    for (const t of TRANSCRIPTS) {
      for (const [rel, recorded] of Object.entries(t.meta.fixtures)) {
        const file = fixtureSource(t, rel);
        assert.strictEqual(sha256(file), recorded, `${t.meta.scenario}: ${file} changed; run \`npm run record:lsp-transcripts\``);
      }
    }
  });

  test('every body the server wrote is what the fake writes for it (JSON with \\uXXXX escapes in capitals)', () => {
    for (const t of TRANSCRIPTS) {
      for (const event of t.events.filter((e) => e.kind === 'recv')) {
        assert.strictEqual(serverJson(JSON.parse(event.text ?? '')), event.text, t.meta.scenario);
      }
    }
  });

  test('every recording answers initialize alike, so one answer serves every session', () => {
    const answers = new Set(
      TRANSCRIPTS.map((t) => {
        const response = t.events.find((e) => e.kind === 'recv' && (JSON.parse(e.text ?? '') as Message).id === 1);
        return JSON.stringify((JSON.parse(response?.text ?? '') as Message).result);
      }),
    );
    assert.strictEqual(answers.size, 1);
  });

  test('two recorded messages with the same key and conditions have the same recorded answer (the replay is a function)', async () => {
    interface Step {
      readonly scenario: string;
      readonly line: number;
      readonly key: string;
      readonly conditions: string;
      readonly reload: boolean;
      readonly files: ReadonlyMap<string, string | null>;
      readonly group: readonly { readonly kind: string; readonly message?: Message }[];
    }
    interface ReplayModule {
      readTranscripts(dir: string): unknown;
      Replayer: new (transcripts: unknown, places: { root: string; home: string }) => { readonly steps: readonly Step[] };
    }
    const replay = (await import(pathToFileURL(path.join(LSP_DIR, 'replay.mjs')).href)) as ReplayModule;
    const root = path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'lsp-ipkg');
    const { steps } = new replay.Replayer(replay.readTranscripts(TRANSCRIPTS_DIR), { root, home: os.homedir() });
    assert.ok(steps.length > 200, `${steps.length} steps`);
    // The answer as a client sees it: the messages, with the request's own id and the server's request ids left out.
    const answer = (step: Step): string =>
      JSON.stringify(
        step.group
          .filter((item) => item.kind === 'message')
          .map(({ message }) => ({ ...message, id: message?.method === undefined ? 'response' : message.id === undefined ? undefined : 'request' })),
      );
    const byCondition = new Map<string, Step[]>();
    for (const step of steps) {
      const key = `${step.key} | ${step.conditions} | ${step.reload} | ${JSON.stringify([...step.files].sort())}`;
      byCondition.set(key, [...(byCondition.get(key) ?? []), step]);
    }
    for (const [key, same] of byCondition) {
      const answers = new Set(same.map(answer));
      assert.strictEqual(answers.size, 1, `${key}: ${same.map((s) => `${s.scenario}:${s.line}`).join(', ')} answer differently`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

/**
 * Replays `t` against the fake in a fresh copy of its workspace: every recorded client message is
 * sent in order, with request ids shifted by 1000 (so ids are matched after normalisation) and the
 * paths of the copy, once the fake has written everything recorded before it; the recorder's file
 * changes are made at the same points (a save writes the text of its `didSave`). The fake's stdout
 * must then equal the recorded stdout byte for byte — messages re-framed for this run's paths and
 * ids, and unframed bytes — and it must exit with the recorded code. stderr (the server's log) is
 * not compared: where its lines fall among the messages is not reproducible (README).
 */
async function replayTranscript(t: Transcript): Promise<void> {
  const root = copyWorkspace(t);
  const messageLog = path.join(root, 'messages.jsonl');
  const server = new FakeServer(root, { FAKE_IDRIS2_LSP_MESSAGE_LOG: messageLog });
  const shift = (id: Message['id']): Message['id'] => (typeof id === 'number' ? id + 1000 : id);
  let expected = '';
  for (const [i, event] of t.events.entries()) {
    switch (event.kind) {
      case 'send': {
        await server.until(Buffer.byteLength(expected));
        const message = JSON.parse(substitute(event.text ?? '', root, true)) as Message;
        // The recorder's answers to the server's requests keep their ids: the fake numbers its requests from 0, as the server does.
        server.send(message.method === undefined ? message : { ...message, id: shift(message.id) });
        break;
      }
      case 'recv': {
        const message = JSON.parse(substitute(event.text ?? '', root, true)) as Message;
        expected += frame(serverJson(message.method === undefined ? { ...message, id: shift(message.id) } : message));
        break;
      }
      case 'unframed':
        expected += substitute(event.text ?? '', root, false);
        break;
      case 'fs': {
        await server.until(Buffer.byteLength(expected));
        const file = path.join(root, event.file ?? '');
        if (event.action === 'delete') {
          fs.rmSync(file);
          break;
        }
        // The text of the didSave that follows.
        const save = t.events
          .slice(i + 1)
          .map((e) => (e.kind === 'send' ? (JSON.parse(substitute(e.text ?? '', root, true)) as Message) : undefined))
          .find((m) => m?.method === 'textDocument/didSave' && (m.params as { textDocument: { uri: string } }).textDocument.uri === pathToFileURL(file).href);
        const text = (save?.params as { text?: string } | undefined)?.text;
        assert.ok(text !== undefined, `${t.meta.scenario}: no didSave with the text of ${event.file}`);
        fs.writeFileSync(file, text);
        assert.strictEqual(sha256(file), event.sha256, `${t.meta.scenario}: ${event.file}`);
        break;
      }
      case 'exit':
        assert.strictEqual(await server.exit, event.code, `${t.meta.scenario}: exit code; stderr: ${server.stderr.slice(-2000)}`);
        break;
    }
  }
  assert.strictEqual(server.stdout.toString('utf8'), expected, `${t.meta.scenario}: stdout`);
  const unrecorded = readLog<LoggedMessage>(messageLog).filter((m) => m.replay === 'unrecorded');
  assert.deepStrictEqual(unrecorded, [], `${t.meta.scenario}: messages without a recording`);
}

suite('test/fake-lsp: replay of every recording in a copy of its workspace', function () {
  this.timeout(20000);
  for (const t of TRANSCRIPTS) {
    test(t.meta.scenario, async () => {
      await replayTranscript(t);
    });
  }
});

suite('test/fake-lsp: matching', function () {
  this.timeout(20000);

  test('an unsaved change is not compared, only that the document is dirty: semantic tokens get RequestCancelled, hover null', async () => {
    const root = copyWorkspace(transcript('dirty'));
    const messageLog = path.join(root, 'messages.jsonl');
    const server = new FakeServer(root, { FAKE_IDRIS2_LSP_MESSAGE_LOG: messageLog });
    await server.exchange(initialize(root, 7));
    assert.deepStrictEqual(await server.exchange(didOpen(root, 'src/Clean.idr')), [
      { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriOf(root, 'src/Clean.idr'), version: 1, diagnostics: [] } },
    ]);
    const [clean] = await server.exchange(at(root, 'src/Clean.idr', 'textDocument/hover', 8, 7, 5));
    assert.deepStrictEqual(clean, { jsonrpc: '2.0', id: 8, result: { contents: { kind: 'markdown', value: '```idris\nxs : Vect ?_ ?_\n```' } } });
    // Not the recorder's change: a VS Code-like full replacement of the first line.
    server.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: { uri: uriOf(root, 'src/Clean.idr'), version: 2 }, contentChanges: [{ text: 'module Clean -- x\n' }] },
    });
    const [tokens] = await server.exchange({
      jsonrpc: '2.0',
      id: 9,
      method: 'textDocument/semanticTokens/full',
      params: { textDocument: { uri: uriOf(root, 'src/Clean.idr') } },
    });
    assert.deepStrictEqual(tokens, { jsonrpc: '2.0', id: 9, error: { code: -32800, message: 'Document Dirty', data: null } });
    const [dirtyHover] = await server.exchange(at(root, 'src/Clean.idr', 'textDocument/hover', 10, 7, 5));
    assert.deepStrictEqual(dirtyHover, { jsonrpc: '2.0', id: 10, result: null });
    const replays = readLog<LoggedMessage>(messageLog).map((m) => m.replay);
    assert.match(replays[0] ?? '', /^initialize$/);
    for (const replay of replays.slice(1).filter((r) => r !== null)) {
      assert.match(replay, /^[a-z0-9-]+:\d+$/, `${replay} is not a recording`);
    }
  });

  test('a changed fixture file gets no stale answer: no diagnostics, null hover, logged as unrecorded and named on stderr', async () => {
    const root = copyWorkspace(transcript('dirty'));
    fs.appendFileSync(path.join(root, 'src', 'Clean.idr'), '-- changed on disk\n');
    const messageLog = path.join(root, 'messages.jsonl');
    const server = new FakeServer(root, { FAKE_IDRIS2_LSP_MESSAGE_LOG: messageLog });
    await server.exchange(initialize(root));
    server.send(didOpen(root, 'src/Clean.idr'));
    const answers = await server.exchange(at(root, 'src/Clean.idr', 'textDocument/hover', 2, 7, 5));
    assert.deepStrictEqual(answers, [{ jsonrpc: '2.0', id: 2, result: null }]);
    assert.deepStrictEqual(
      readLog<LoggedMessage>(messageLog).map((m) => [m.message.method, m.replay]),
      [
        ['initialize', 'initialize'],
        ['textDocument/didOpen', 'unrecorded'],
        ['textDocument/hover', 'unrecorded'],
      ],
    );
    assert.match(server.stderr, /no recorded reply for textDocument\/hover/);
  });

  test('without a recording: a command gets an error naming it, another method -32601 as from the server', async () => {
    const root = copyWorkspace(transcript('commands-clean'));
    const server = new FakeServer(root);
    await server.exchange(initialize(root));
    // Nothing is loaded, and every metavars recording was made with a file loaded.
    const [metavars] = await server.exchange({ jsonrpc: '2.0', id: 2, method: 'workspace/executeCommand', params: { command: 'metavars', arguments: [] } });
    assert.strictEqual(metavars.error?.code, -32603);
    assert.match(metavars.error?.message ?? '', /^fake-idris2-lsp: no recorded reply for workspace\/executeCommand metavars/);
    const [folding] = await server.exchange({
      jsonrpc: '2.0',
      id: 3,
      method: 'textDocument/foldingRange',
      params: { textDocument: { uri: uriOf(root, 'src/Clean.idr') } },
    });
    assert.deepStrictEqual(folding, { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not implemented yet', data: null } });
  });

  test('the options decide which recording answers: showImplicits from initializationOptions and from didChangeConfiguration', async () => {
    const root = copyWorkspace(transcript('options'));
    const server = new FakeServer(root);
    await server.exchange(initialize(root, 1, { showImplicits: true }));
    await server.exchange(didOpen(root, 'src/Clean.idr'));
    const hover = async (id: number): Promise<unknown> => (await server.exchange(at(root, 'src/Clean.idr', 'textDocument/hover', id, 6, 0)))[0].result;
    assert.deepStrictEqual(await hover(2), { contents: { kind: 'markdown', value: '```idris\nvlen : {0 a : Type} -> {0 n : Nat} -> Vect n a -> Nat\n```' } });
    // Nested settings are not read (F20), so this changes nothing.
    server.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { idris2: { lsp: { showImplicits: false } } } } });
    assert.deepStrictEqual(await hover(3), { contents: { kind: 'markdown', value: '```idris\nvlen : {0 a : Type} -> {0 n : Nat} -> Vect n a -> Nat\n```' } });
    server.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { showImplicits: false } } });
    assert.deepStrictEqual(await hover(4), { contents: { kind: 'markdown', value: '```idris\nvlen : Vect n a -> Nat\n```' } });
  });
});

suite('test/fake-lsp: process, logs and faults', function () {
  this.timeout(20000);

  test('FAKE_IDRIS2_LSP_LOG records the start with the working directory; exit after shutdown is 0', async () => {
    const root = copyWorkspace(transcript('initialize'));
    const startLog = path.join(root, 'starts.jsonl');
    const server = new FakeServer(root, { FAKE_IDRIS2_LSP_LOG: startLog });
    await server.exchange(initialize(root));
    assert.deepStrictEqual(await server.exchange({ jsonrpc: '2.0', id: 2, method: 'shutdown' }), [{ jsonrpc: '2.0', id: 2, result: null }]);
    server.send({ jsonrpc: '2.0', method: 'exit' });
    assert.strictEqual(await server.exit, 0);
    assert.deepStrictEqual(readLog(startLog), [{ pid: server.child.pid, args: [], cwd: root }]);
  });

  test('a log that cannot be written is named on stderr, and the server goes on answering', async () => {
    const root = copyWorkspace(transcript('initialize'));
    const server = new FakeServer(root, { FAKE_IDRIS2_LSP_MESSAGE_LOG: path.join(root, 'gone', 'messages.jsonl') });
    assert.deepStrictEqual((await server.exchange(initialize(root, 4)))[0].id, 4);
    assert.match(server.stderr, /^fake-idris2-lsp: cannot append to .*messages\.jsonl/m);
  });

  test('exit without shutdown ends with 1, and so does the end of input', async () => {
    const root = copyWorkspace(transcript('initialize'));
    const first = new FakeServer(root);
    await first.exchange(initialize(root));
    first.send({ jsonrpc: '2.0', method: 'exit' });
    assert.strictEqual(await first.exit, 1);
    const second = new FakeServer(root);
    await second.exchange(initialize(root));
    second.child.stdin.end();
    assert.strictEqual(await second.exit, 1);
  });

  test('missing-ipkg: requests about a document get the code-3 error of withURI, didOpen publishes nothing', async () => {
    const root = copyWorkspace(transcript('dirty'));
    const messageLog = path.join(root, 'messages.jsonl');
    const server = new FakeServer(root, { FAKE_IDRIS2_LSP_FAULT: 'missing-ipkg', FAKE_IDRIS2_LSP_MESSAGE_LOG: messageLog });
    await server.exchange(initialize(root));
    server.send(didOpen(root, 'src/Clean.idr'));
    const [hover] = await server.exchange(at(root, 'src/Clean.idr', 'textDocument/hover', 2, 7, 5));
    assert.deepStrictEqual(hover, {
      jsonrpc: '2.0',
      id: 2,
      error: { code: 3, message: `Cannot load ipkg file for ${uriOf(root, 'src/Clean.idr')}: "Cannot find the ipkg file"`, data: null },
    });
    assert.deepStrictEqual(
      readLog<LoggedMessage>(messageLog).map((m) => m.replay),
      ['initialize', 'fault', 'fault'],
    );
  });

  test('a mistake in the setup exits with 2 before serving: no recordings, an unknown fault', () => {
    const root = copyWorkspace(transcript('initialize'));
    const run = (env: Record<string, string>): { status: number | null; stderr: string } =>
      spawnSync(process.execPath, [SERVER], { cwd: root, env: fakeEnvironment(env), encoding: 'utf8', input: '', timeout: 10000 });
    const unset = run({});
    assert.strictEqual(unset.status, 2);
    assert.match(unset.stderr, /FAKE_IDRIS2_LSP_TRANSCRIPTS is not set/);
    const empty = run({ FAKE_IDRIS2_LSP_TRANSCRIPTS: root });
    assert.strictEqual(empty.status, 2);
    assert.match(empty.stderr, /no transcript/);
    const fault = run({ FAKE_IDRIS2_LSP_TRANSCRIPTS: TRANSCRIPTS_DIR, FAKE_IDRIS2_LSP_FAULT: 'nope' });
    assert.strictEqual(fault.status, 2);
    assert.match(fault.stderr, /FAKE_IDRIS2_LSP_FAULT must be one of missing-ipkg/);
  });

  test('bin/idris2-lsp: --version as test/fake-tools answers it; no arguments starts the server', function () {
    if (WINDOWS) {
      this.skip(); // a sh launcher; the lsp suite does not run on Windows (no Windows CI, CLAUDE.md)
    }
    const env = fakeEnvironment({ FAKE_IDRIS2_LSP_API_VERSION: '0.7.0' });
    const launcher = spawnSync(LAUNCHER, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
    const direct = spawnSync(process.execPath, [fakeScript('idris2-lsp'), '--version'], { env, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(launcher.status, 0);
    assert.strictEqual(launcher.stdout, 'Idris2 LSP: 0.1.0-9a2f0ad6a\nIdris2 API: 0.7.0\n');
    assert.strictEqual(launcher.stdout, direct.stdout);
    const server = spawnSync(LAUNCHER, [], { env: fakeEnvironment({}), encoding: 'utf8', input: '', timeout: 10000 });
    assert.strictEqual(server.status, 2);
    assert.match(server.stderr, /^fake-idris2-lsp: FAKE_IDRIS2_LSP_TRANSCRIPTS is not set/);
    assert.strictEqual(fs.statSync(LAUNCHER).mode & 0o111, 0o111, 'the launcher is executable');
  });
});
