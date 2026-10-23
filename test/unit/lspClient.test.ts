// backend/lsp/client.ts: the language client's lifecycle (lazy start, the process through the
// consent gate's real path, the backoff of M2, Stop and Restart, the restart question), the request
// choke point (ownership, Restricted Mode, the repl refusal, the error mapping), the settings sent,
// and the reading of the server's output (framing past compiler output on stdout, the log on stderr,
// F35), checked against the recordings of test/fixtures/lsp-transcripts. No process and no `vscode`:
// the language client, the process and the API are fakes.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { Message, MessageTransports } from 'vscode-languageclient/node';
import {
  APPLY_EDIT_REFUSED,
  CLIENT_FEATURES,
  contentLength,
  CRASH_WINDOW_MS,
  FramedMessageReader,
  FramedMessageWriter,
  keepsFeature,
  LineSplitter,
  logServerMessage,
  LspClient,
  lspServerOptions,
  missingIpkgInLog,
  NOT_SERVED_REASON,
  RESTART_ACTION,
  RESTART_DELAYS_MS,
  serverDocumentSelector,
  serverLogLevel,
  STOPPED_REASON,
  type LanguageClientSpec,
  type LspClientApi,
  type LspClientDeps,
  type LspLanguageClient,
} from '../../src/backend/lsp/client';
import type { LspOwnership } from '../../src/backend/lsp/types';
import type { LspSettings, SettingsChange } from '../../src/core/config';
import { IdrisException, isCancelled, unsupported } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { LongRunningExit, LongRunningHandlers, LongRunningOptions, LongRunningRequest } from '../../src/core/process';
import type { GateVerdict } from '../../src/core/trust';
import type { Classification } from '../../src/project/types';
import type { ToolchainSnapshot } from '../../src/toolchain/types';
import { repoRoot } from '../fake-tools/paths';
import { isMissingIpkgError } from '../../src/backend/lsp/middleware';
import { FakeDocument, FakeUri, quietLog, settle } from './support/intelligence';

// -------------------------------------------------------------------------------------------
// Recordings
// -------------------------------------------------------------------------------------------

interface Recorded {
  readonly kind: string;
  readonly text?: string;
  readonly placeholders?: Readonly<Record<string, number>>;
}

function recorded(scenario: string): Recorded[] {
  return fs
    .readFileSync(path.join(repoRoot(), 'test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a', `${scenario}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Recorded);
}

/** `text` with each placeholder of `meta` replaced by an ASCII path of the byte length it stood for, as the README says to check lengths. */
function substituted(meta: Recorded, text: string): string {
  let out = text;
  for (const [placeholder, length] of Object.entries(meta.placeholders ?? {})) {
    out = out.split(placeholder).join(`/${'r'.repeat(length - 1)}`);
  }
  return out;
}

const stderrLines = (scenario: string): string[] =>
  recorded(scenario)
    .filter((e) => e.kind === 'stderr' && e.text !== undefined)
    .map((e) => (e.text as string).replace(/\n$/, ''));

// -------------------------------------------------------------------------------------------
// Pure parts
// -------------------------------------------------------------------------------------------

const SETTINGS: LspSettings = {
  logFile: '',
  logSeverity: 'debug',
  longActionTimeoutMs: 1000,
  maxCodeActionResults: 5,
  showImplicits: false,
  showMachineNames: false,
  fullNamespace: false,
  briefCompletions: false,
};

suite('backend/lsp/client: settings, F35, the server\'s output', () => {
  test('the server options are the flat object of the eight settings, logFile only when set (F20)', () => {
    assert.deepStrictEqual(lspServerOptions(SETTINGS), {
      logSeverity: 'debug',
      longActionTimeout: 1000,
      maxCodeActionResults: 5,
      showImplicits: false,
      showMachineNames: false,
      fullNamespace: false,
      briefCompletions: false,
    });
    assert.deepStrictEqual(Object.keys(lspServerOptions({ ...SETTINGS, logFile: '/tmp/lsp.log', showImplicits: true })).sort(), [
      'briefCompletions',
      'fullNamespace',
      'logFile',
      'logSeverity',
      'longActionTimeout',
      'maxCodeActionResults',
      'showImplicits',
      'showMachineNames',
    ]);
    // The recorder sent the same object (but logSeverity) as initializationOptions.
    const init = recorded('options').find((e) => e.kind === 'send' && e.text?.includes('"initialize"'));
    const sent = (JSON.parse(init?.text ?? '{}') as { params: { initializationOptions: Record<string, unknown> } }).params.initializationOptions;
    assert.deepStrictEqual(Object.keys(sent).sort(), Object.keys(lspServerOptions(SETTINGS)).sort());
  });

  test('the missing-.ipkg error of a request (recording loose-file: code 4) and the code-3 form of the source', () => {
    const answer = recorded('loose-file').find((e) => e.kind === 'recv' && e.text?.includes('"error"'));
    const { code, message } = (JSON.parse(answer?.text ?? '{}') as { error: { code: number; message: string } }).error;
    assert.strictEqual(code, 4);
    assert.strictEqual(isMissingIpkgError(code, message), true);
    assert.strictEqual(isMissingIpkgError(3, 'Cannot load ipkg file for file:///x/A.idr: "Cannot find the ipkg file"'), true);
    assert.strictEqual(isMissingIpkgError(4, 'Error: Source file "/p/x/A.idr" is not in the source directory "/p/src"'), false);
    assert.strictEqual(isMissingIpkgError(-32800, 'Document Dirty'), false);
  });

  test('the missing-.ipkg log line (recording loose-file) names the file; no other recorded line counts (ipkg-deleted: none is logged)', () => {
    const lines = stderrLines('loose-file');
    const found = lines.map(missingIpkgInLog).filter((m) => m !== undefined);
    // didOpen of Vlen.idr, the hover about Hello.idr (never opened), didSave of Vlen.idr.
    assert.deepStrictEqual(found, [{ path: '${ROOT}/Vlen.idr' }, { path: '${ROOT}/Hello.idr' }, { path: '${ROOT}/Vlen.idr' }]);
    for (const scenario of ['ipkg-deleted', 'diagnostics', 'features-shapes', 'logging', 'initialize']) {
      assert.deepStrictEqual(stderrLines(scenario).filter((l) => missingIpkgInLog(l) !== undefined), [], scenario);
    }
    assert.deepStrictEqual(missingIpkgInLog('LOG ERROR:Server: Cannot load ipkg file for file:///p/A.idr: "Cannot find the ipkg file"'), { uri: 'file:///p/A.idr' });
    assert.deepStrictEqual(
      missingIpkgInLog('LOG ERROR:Server: Caught error which shouldn\'t be leaked while loading file: Error: Source file "/p/a\\"b.idr" is not in the source directory ""'),
      {},
    );
  });

  test('log lines go to the channel level of their severity, in capitals as recorded; other lines at info', () => {
    const levels = new Set(['debug', 'info', 'warn', 'error']);
    const lines = [...stderrLines('initialize'), ...stderrLines('loose-file'), ...stderrLines('options')];
    assert.ok(lines.length > 10);
    for (const line of lines) {
      assert.ok(levels.has(serverLogLevel(line)));
    }
    assert.ok(lines.some((l) => l.startsWith('LOG DEBUG:')) && lines.some((l) => l.startsWith('LOG WARNING:')) && lines.some((l) => l.startsWith('LOG ERROR:')));
    assert.strictEqual(serverLogLevel('LOG DEBUG:Server: x'), 'debug');
    assert.strictEqual(serverLogLevel('LOG WARNING:Server: x'), 'warn');
    assert.strictEqual(serverLogLevel('LOG CRITICAL:Server: x'), 'error');
    assert.strictEqual(serverLogLevel('LOG Error:Server: x'), 'info');
    assert.strictEqual(serverLogLevel('[ fatal ] Package `idris2-lsp` is not built'), 'info');
  });

  test('the server\'s window messages go to the channel, controls written out; never a notification', () => {
    const lines: string[] = [];
    const channel = {
      debug: (m: string) => lines.push(`debug ${m}`),
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    };
    logServerMessage(channel, { type: 1, message: '[x](command:evil)‮' });
    logServerMessage(channel, { type: 4, message: 'log' });
    logServerMessage(channel, undefined);
    assert.deepStrictEqual(lines, ['error idris2-lsp: [x](command:evil)\\u{202E}', 'debug idris2-lsp: log', 'debug idris2-lsp: undefined']);
    assert.match(APPLY_EDIT_REFUSED, /applies only the edits it asks for/);
  });

  test('the library features kept are the text sync and the providers of middleware.ts, by their registration methods', () => {
    // The methods as vscode-languageserver-protocol (the version vscode-languageclient 10.1.2 uses) names them.
    const protocol = require('vscode-languageserver-protocol') as Record<string, { method: string }>;
    const expected = [
      'DidOpenTextDocumentNotification',
      'DidChangeTextDocumentNotification',
      'DidSaveTextDocumentNotification',
      'DidCloseTextDocumentNotification',
      'CompletionRequest',
      'HoverRequest',
      'SignatureHelpRequest',
      'DefinitionRequest',
      'DocumentHighlightRequest',
      'DocumentSymbolRequest',
      'CodeActionRequest',
      'SemanticTokensRegistrationType',
    ].map((name) => protocol[name].method);
    assert.deepStrictEqual([...CLIENT_FEATURES].sort(), expected.sort());
    assert.strictEqual(keepsFeature({ registrationType: { method: 'textDocument/hover' } }), true);
    for (const dropped of ['workspace/executeCommand', 'textDocument/codeLens', 'textDocument/documentLink', 'workspace/didChangeWatchedFiles', 'textDocument/willSave']) {
      assert.strictEqual(keepsFeature({ registrationType: { method: dropped } }), false, dropped);
    }
    assert.strictEqual(keepsFeature({ fillClientCapabilities: () => undefined }), false);
  });

  test('the document selector is the extension\'s, file: documents only', () => {
    const selector = serverDocumentSelector();
    assert.ok(selector.length >= 2);
    assert.ok(selector.every((f) => 'scheme' in f && f.scheme === 'file'));
    assert.ok(selector.some((f) => 'language' in f && f.language === 'idris2'));
    assert.ok(selector.some((f) => 'language' in f && f.language === 'lidr'));
  });
});

// -------------------------------------------------------------------------------------------
// Framing
// -------------------------------------------------------------------------------------------

suite('backend/lsp/client: framing', () => {
  /** The server's standard output of `scenario` as bytes, and the messages in it. */
  function stdoutOf(scenario: string): { bytes: Buffer; messages: unknown[]; unframed: string } {
    const events = recorded(scenario);
    const meta = events[0];
    const parts: Buffer[] = [];
    const messages: unknown[] = [];
    let unframed = '';
    for (const e of events) {
      if (e.kind === 'recv' && e.text !== undefined) {
        const body = Buffer.from(substituted(meta, e.text), 'utf8');
        assert.strictEqual(body.length, (e as { length?: number }).length);
        parts.push(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body);
        messages.push(JSON.parse(substituted(meta, e.text)));
      } else if (e.kind === 'unframed' && e.text !== undefined) {
        parts.push(Buffer.from(substituted(meta, e.text), 'utf8'));
        unframed += substituted(meta, e.text);
      }
    }
    return { bytes: Buffer.concat(parts), messages, unframed };
  }

  const read = (bytes: Buffer, chunk: number): { messages: Message[]; unframed: string; errors: Error[]; closed: number } => {
    const out = { messages: [] as Message[], unframed: '', errors: [] as Error[], closed: 0 };
    const reader = new FramedMessageReader((text) => (out.unframed += text));
    reader.onError((e) => out.errors.push(e));
    reader.onClose(() => out.closed++);
    reader.listen((m) => out.messages.push(m));
    for (let at = 0; at < bytes.length; at += chunk) {
      reader.push(bytes.subarray(at, at + chunk));
    }
    reader.end();
    return out;
  };

  test("the compiler's LOG lines between messages (recording logging) are skipped, and every message is read, in any chunking", () => {
    const { bytes, messages, unframed } = stdoutOf('logging');
    assert.ok(unframed.includes('LOG declare.def'));
    for (const chunk of [1, 3, 7, 64, 4096, bytes.length]) {
      const out = read(bytes, chunk);
      assert.deepStrictEqual(out.messages, messages, `chunk ${chunk}`);
      assert.strictEqual(out.unframed, unframed, `chunk ${chunk}`);
      assert.deepStrictEqual(out.errors, []);
      assert.strictEqual(out.closed, 1);
    }
  });

  test('a recording with non-ASCII text in a body (plain) reads byte for byte', () => {
    const { bytes, messages } = stdoutOf('plain');
    assert.deepStrictEqual(read(bytes, 5).messages, messages);
  });

  test('a header that is not one is skipped as text; a body that is not a JSON object is an error, and reading goes on', () => {
    const frame = (body: string): string => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const text = `Content-Length: x\nnoise ${frame('[1]')}${frame('{"jsonrpc":"2.0","id":1,"result":null}')}tail without newline`;
    const out = read(Buffer.from(text, 'utf8'), 2);
    assert.deepStrictEqual(out.messages, [{ jsonrpc: '2.0', id: 1, result: null }]);
    assert.strictEqual(out.unframed, 'Content-Length: x\nnoise tail without newline');
    assert.strictEqual(out.errors.length, 1);
    assert.strictEqual(contentLength('Content-Length: 12\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8'), 12);
    assert.strictEqual(contentLength('Content-Length: 12\r\nContent-Length: 12'), undefined);
    assert.strictEqual(contentLength('Content-Type: x'), undefined);
  });

  test('messages and the end that come before listen are delivered once it listens', () => {
    const reader = new FramedMessageReader(() => undefined);
    const events: string[] = [];
    reader.onClose(() => events.push('close'));
    reader.push(Buffer.from('Content-Length: 2\r\n\r\n{}', 'ascii'));
    reader.end();
    assert.strictEqual(events.length, 0);
    reader.listen(() => events.push('message'));
    assert.deepStrictEqual(events, ['message', 'close']);
  });

  test('the writer frames with Content-Length in UTF-8 bytes, and fails after the process ended', async () => {
    const written: Buffer[] = [];
    const writer = new FramedMessageWriter((bytes) => written.push(Buffer.from(bytes)));
    await writer.write({ jsonrpc: '2.0', method: 'x', params: { text: '\u{1D55F}' } } as Message);
    const all = Buffer.concat(written).toString('utf8');
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { text: '\u{1D55F}' } });
    assert.strictEqual(all, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    let closed = 0;
    writer.onClose(() => closed++);
    writer.closed();
    writer.closed();
    assert.strictEqual(closed, 1);
    await assert.rejects(writer.write({ jsonrpc: '2.0' }));
  });

  test('stderr lines are split at LF, a CR before it dropped, a character split between chunks decoded once', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('LOG INFO:Server: \u{1D55F}\r\nsecond\nlast', 'utf8');
    for (let at = 0; at < bytes.length; at += 3) {
      splitter.push(bytes.subarray(at, at + 3));
    }
    splitter.end();
    assert.deepStrictEqual(lines, ['LOG INFO:Server: \u{1D55F}', 'second', 'last']);
  });
});

// -------------------------------------------------------------------------------------------
// LspClient with fakes
// -------------------------------------------------------------------------------------------

class FakeClock {
  time = 0;
  private timers: { due: number; callback: () => void; handle: number }[] = [];
  private next = 1;
  now = (): number => this.time;
  setTimeout = (callback: () => void, ms: number): unknown => {
    const handle = this.next++;
    this.timers.push({ due: this.time + ms, callback, handle });
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.handle !== handle);
  };
  /** Runs the timers due within `ms`, in order. */
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (due === undefined) {
        break;
      }
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.due;
      due.callback();
      await settle();
    }
    this.time = until;
    await settle();
  }
  get pending(): number[] {
    return this.timers.map((t) => t.due - this.time);
  }
}

class FakeProcess {
  readonly written: Buffer[] = [];
  stopped = false;
  killed = false;
  ended = false;
  constructor(
    readonly request: LongRunningRequest,
    readonly handlers: LongRunningHandlers,
  ) {}
  write(bytes: Uint8Array): void {
    this.written.push(Buffer.from(bytes));
  }
  exit(exit: LongRunningExit): void {
    if (!this.ended) {
      this.ended = true;
      this.handlers.onExit(exit);
    }
  }
  stop(): void {
    this.stopped = true;
    queueMicrotask(() => this.exit({ code: null, signal: 'SIGTERM' }));
  }
  kill(): void {
    this.killed = true;
  }
}

class FakeLanguageClient implements LspLanguageClient {
  transports: MessageTransports | undefined;
  stopped = 0;
  disposed = false;
  readonly requests: { method: string; param: unknown }[] = [];
  readonly notifications: { method: string; params: unknown }[] = [];
  readonly deleted: string[] = [];
  readonly code2ProtocolConverter = {
    asOpenTextDocumentParams: (d: vscode.TextDocument) => ({ textDocument: { uri: d.uri.toString() } }),
    asCloseTextDocumentParams: (d: vscode.TextDocument) => ({ textDocument: { uri: d.uri.toString() } }),
    asChangeTextDocumentParams: (d: vscode.TextDocument) => ({ textDocument: { uri: d.uri.toString() }, contentChanges: [{ text: d.getText() }] }),
    asSaveTextDocumentParams: (d: vscode.TextDocument, includeContent?: boolean) => ({ textDocument: { uri: d.uri.toString() }, ...(includeContent === true ? { text: d.getText() } : {}) }),
  };
  readonly diagnostics = { delete: (uri: vscode.Uri) => void this.deleted.push(uri.toString()) };
  constructor(
    readonly spec: LanguageClientSpec,
    private readonly world: World,
  ) {}
  async start(): Promise<void> {
    this.transports = await this.spec.serverOptions();
    if (this.world.initializeError !== undefined) {
      this.spec.initializationFailed(this.world.initializeError);
      throw this.world.initializeError;
    }
  }
  async stop(): Promise<void> {
    this.stopped++;
    this.world.processes.at(-1)?.exit({ code: 0, signal: null });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  sendRequest<R>(method: string, param: unknown): Promise<R> {
    this.requests.push({ method, param });
    return this.world.answer(method, param) as Promise<R>;
  }
  async sendNotification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }
}

class FakeChannel {
  readonly lines: string[] = [];
  shown = 0;
  disposed = false;
  readonly name = 'Idris 2 Language Server';
  readonly logLevel = 2;
  readonly onDidChangeLogLevel = new Emitter<number>().event;
  trace = (m: string): void => void this.lines.push(`trace ${m}`);
  debug = (m: string): void => void this.lines.push(`debug ${m}`);
  info = (m: string): void => void this.lines.push(`info ${m}`);
  warn = (m: string): void => void this.lines.push(`warn ${m}`);
  error = (m: string | Error): void => void this.lines.push(`error ${String(m)}`);
  append = (): void => undefined;
  appendLine = (): void => undefined;
  replace = (): void => undefined;
  clear = (): void => undefined;
  show = (): void => void this.shown++;
  hide = (): void => undefined;
  dispose = (): void => void (this.disposed = true);
}

const ROOT_DIR = '/w/proj';
const OUTSIDE_DIR = '/outside/proj';
const LSP_PATH = '/opt/pack/bin/idris2-lsp';

class World {
  trusted = true;
  readonly trustGranted = new Emitter<void>();
  readonly admitted = new Set<string>();
  readonly ownershipChanged = new Emitter<void>();
  readonly docs: FakeDocument[] = [];
  readonly opened = new Emitter<vscode.TextDocument>();
  readonly changed = new Emitter<{ document: vscode.TextDocument }>();
  readonly willSave = new Emitter<{ document: vscode.TextDocument }>();
  gate: (dir: string) => GateVerdict | undefined = (dir) => ({ allowed: true, basis: 'workspaceFolder', realDir: `/real${dir}` });
  snapshot: ToolchainSnapshot = World.snapshot(LSP_PATH, { PACK_BIN_DIR: '/opt/pack/bin' });
  scanning = false;
  readonly toolchainChanged = new Emitter<void>();
  settings: LspSettings = SETTINGS;
  readonly settingsListeners: ((change: SettingsChange) => void)[] = [];
  readonly clients: FakeLanguageClient[] = [];
  readonly processes: FakeProcess[] = [];
  initializeError: Error | undefined;
  answer: (method: string, param: unknown) => Promise<unknown> = async () => null;
  readonly messages: { level: string; text: string; items: string[] }[] = [];
  reply: string | undefined;
  readonly channel = new FakeChannel();
  readonly clock = new FakeClock();

  static snapshot(lspPath: string | undefined, env: Record<string, string>): ToolchainSnapshot {
    return {
      settings: { env },
      lsp:
        lspPath === undefined
          ? { status: 'missing', searched: [], reason: 'idris2-lsp was not found on PATH.' }
          : { status: 'probed', location: { kind: 'idris2-lsp', path: lspPath, source: 'setting', detail: '', inPackDirectory: true }, info: {} },
    } as unknown as ToolchainSnapshot;
  }

  doc(file: string): FakeDocument {
    const doc = new FakeDocument(file, 'module A\n');
    this.docs.push(doc);
    return doc;
  }

  admit(doc: FakeDocument): void {
    this.admitted.add(doc.uri.toString());
  }

  deps(): LspClientDeps {
    const world = this;
    const ownership: LspOwnership = {
      admits: async (uri) => world.admitted.has(uri.toString()),
      onDidChange: world.ownershipChanged.event,
    };
    const message =
      (level: string) =>
      (text: string, ...items: string[]): Promise<string | undefined> => {
        world.messages.push({ level, text, items });
        return Promise.resolve(world.reply);
      };
    const api = {
      window: {
        createOutputChannel: () => world.channel,
        showInformationMessage: message('info'),
        showWarningMessage: message('warning'),
      },
      workspace: {
        textDocuments: world.docs,
        onDidOpenTextDocument: world.opened.event,
        onDidChangeTextDocument: world.changed.event,
        onWillSaveTextDocument: world.willSave.event,
      },
      Uri: { file: (p: string) => new FakeUri('file', p, ''), parse: (s: string) => FakeUri.parse(s) },
    } as unknown as LspClientApi;
    return {
      api,
      languageClients: async (spec) => {
        const client = new FakeLanguageClient(spec, world);
        world.clients.push(client);
        return client;
      },
      ownership,
      gate: { recheck: async (dir) => world.gate(dir) },
      toolchain: {
        get current() {
          return world.snapshot;
        },
        get scanning() {
          return world.scanning;
        },
        onDidChange: world.toolchainChanged.event,
      },
      config: {
        lsp: () => world.settings,
        onDidChange: (group, listener) => {
          assert.strictEqual(group, 'lsp');
          world.settingsListeners.push(listener);
          return { dispose: () => undefined };
        },
      },
      trust: {
        get isTrusted() {
          return world.trusted;
        },
        onDidGrant: world.trustGranted.event,
      },
      projects: {
        classify: async (file: string) => ({ kind: 'project', dir: file.startsWith(ROOT_DIR) ? ROOT_DIR : OUTSIDE_DIR, ipkgPath: '', otherIpkgs: [] }) as unknown as Classification,
        sessionCwd: (root: Classification) => root.dir,
      },
      folders: () => ['/w'],
      readText: async () => undefined,
      log: quietLog,
      platform: 'darwin',
      processEnv: { PATH: '/usr/bin' },
      clock: world.clock,
      startProcess: (request: LongRunningRequest, handlers: LongRunningHandlers, options: LongRunningOptions) => {
        if (!options.trust.isTrusted) {
          throw unsupported('Restricted Mode');
        }
        const proc = new FakeProcess(request, handlers);
        world.processes.push(proc);
        return proc;
      },
      keepNotices: true,
    };
  }

  changeSetting(key: string): void {
    this.settingsListeners.forEach((l) => l({ affects: (k) => k === key }));
  }
}

/** Settles enough for a start (the fakes answer at once) to finish. */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await settle();
  }
}

/** A world with one admitted document of the root inside the workspace folder, and a client that has started for it. */
async function running(): Promise<{ world: World; client: LspClient; doc: FakeDocument }> {
  const world = new World();
  const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
  world.admit(doc);
  const client = new LspClient(world.deps());
  await settled();
  assert.strictEqual(kind(client), 'running');
  return { world, client, doc };
}

const uriOf = (doc: FakeDocument): vscode.Uri => doc.uri as unknown as vscode.Uri;
/** The state's kind, read without the narrowing an assertion on it would cause. */
const kind = (client: LspClient): string => client.state.kind;
const kindOf = (e: unknown): string | undefined => (e instanceof IdrisException ? e.error.kind : isCancelled(e) ? 'Cancelled' : undefined);

suite('backend/lsp/client: lifecycle', () => {
  test('nothing starts before an admitted document is open; then it starts in the workspace folder of its root, in the real path the gate judged', async () => {
    const world = new World();
    world.doc(`${ROOT_DIR}/src/Other.idr`);
    const client = new LspClient(world.deps());
    await settled();
    assert.strictEqual(kind(client), 'notStarted');
    assert.strictEqual(world.clients.length, 0);

    const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
    world.admit(doc);
    world.opened.fire(doc as unknown as vscode.TextDocument);
    await settled();
    assert.strictEqual(kind(client), 'running');
    assert.strictEqual(world.processes.length, 1);
    assert.deepStrictEqual(world.processes[0].request, { executable: LSP_PATH, args: [], cwd: '/real/w', env: { PACK_BIN_DIR: '/opt/pack/bin' }, stdin: 'pipe' });
    // The client's documents: the one admitted is opened.
    assert.deepStrictEqual(world.clients[0].notifications.map((n) => n.method), ['textDocument/didOpen']);
    client.dispose();
  });

  test('a root outside the workspace folders that the gate allowed: the server starts in its own folder', async () => {
    const world = new World();
    const doc = world.doc(`${OUTSIDE_DIR}/src/A.idr`);
    world.admit(doc);
    const client = new LspClient(world.deps());
    await settled();
    assert.strictEqual(world.processes[0].request.cwd, `/real${OUTSIDE_DIR}`);
    client.dispose();
  });

  test('a refusal of the gate right before the spawn starts nothing, and the client stays notStarted', async () => {
    const world = new World();
    world.gate = () => ({ allowed: false, reason: 'denied' });
    const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
    world.admit(doc);
    const client = new LspClient(world.deps());
    await settled();
    assert.strictEqual(kind(client), 'notStarted');
    assert.strictEqual(world.processes.length, 0);
    client.dispose();
  });

  test('Restricted Mode: nothing starts, and a request is refused before anything else', async () => {
    const world = new World();
    world.trusted = false;
    const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
    world.admit(doc);
    const client = new LspClient(world.deps());
    await settled();
    assert.strictEqual(world.clients.length, 0);
    await assert.rejects(client.request(uriOf(doc), 'textDocument/hover', {}), (e: unknown) => kindOf(e) === 'Unsupported');
    assert.strictEqual(world.clients.length, 0);
    client.dispose();
  });

  test('no usable idris2-lsp in the scan: failed with its reason; a new scan returns to notStarted and starts', async () => {
    const world = new World();
    world.snapshot = World.snapshot(undefined, {});
    const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
    world.admit(doc);
    const client = new LspClient(world.deps());
    await settled();
    assert.deepStrictEqual(client.state, { kind: 'failed', reason: 'No usable idris2-lsp: idris2-lsp was not found on PATH.' });
    world.snapshot = World.snapshot(LSP_PATH, {});
    world.toolchainChanged.fire();
    await settled();
    assert.strictEqual(kind(client), 'running');
    client.dispose();
  });

  test('unexpected ends restart it after 0 s, 2 s and 10 s; a fourth within five minutes gives up with a warning', async () => {
    const { world, client } = await running();
    const crash = async (): Promise<void> => {
      world.processes.at(-1)?.exit({ code: 1, signal: null });
      await settled();
      await world.clock.advance(0);
      await settled();
    };
    await crash();
    assert.strictEqual(kind(client), 'running');
    assert.strictEqual(world.processes.length, 2);
    await crash();
    assert.strictEqual(kind(client), 'starting');
    assert.deepStrictEqual(world.clock.pending, [RESTART_DELAYS_MS[1]]);
    await world.clock.advance(RESTART_DELAYS_MS[1]);
    await settled();
    assert.strictEqual(world.processes.length, 3);
    await crash();
    assert.deepStrictEqual(world.clock.pending, [RESTART_DELAYS_MS[2]]);
    await world.clock.advance(RESTART_DELAYS_MS[2]);
    await settled();
    assert.strictEqual(world.processes.length, 4);
    await crash();
    assert.strictEqual(kind(client), 'failed');
    assert.match((client.state as { reason: string }).reason, /exit code 1\), 4 unexpected ends within 5 minutes/);
    assert.strictEqual(world.processes.length, 4);
    assert.strictEqual(client.notices.length, 1);
    assert.deepStrictEqual(world.messages.at(-1)?.items, ['Show Language Server Output', RESTART_ACTION]);
    // Restart leaves failed and clears the count.
    await client.restart();
    await settled();
    assert.strictEqual(kind(client), 'running');
    client.dispose();
  });

  test('ends spread over more than five minutes do not add up', async () => {
    const { world, client } = await running();
    for (let i = 0; i < 6; i++) {
      await world.clock.advance(CRASH_WINDOW_MS);
      world.processes.at(-1)?.exit({ code: 1, signal: null });
      await settled();
      await world.clock.advance(0);
      await settled();
      assert.strictEqual(kind(client), 'running', `end ${i + 1}`);
    }
    client.dispose();
  });

  test('a process that cannot be started fails at once; a server that refuses initialize too', async () => {
    const { world, client } = await running();
    world.processes.at(-1)?.exit({ code: null, signal: null, spawnError: 'ENOENT: no such file' });
    await settled();
    assert.deepStrictEqual(client.state, { kind: 'failed', reason: 'idris2-lsp could not be started (ENOENT: no such file).' });
    client.dispose();

    const second = new World();
    second.initializeError = new Error('bad options');
    second.admit(second.doc(`${ROOT_DIR}/src/A.idr`));
    const other = new LspClient(second.deps());
    await settled();
    assert.deepStrictEqual(other.state, { kind: 'failed', reason: 'idris2-lsp did not initialize: bad options' });
    other.dispose();
  });

  test('Stop: stopped, the server is shut down, nothing starts it again and requests are refused; Restart starts it in the same folder', async () => {
    const { world, client, doc } = await running();
    await client.stop();
    assert.strictEqual(kind(client), 'stopped');
    assert.strictEqual(world.clients[0].stopped, 1);
    world.opened.fire(doc as unknown as vscode.TextDocument);
    world.ownershipChanged.fire();
    await settled();
    assert.strictEqual(world.clients.length, 1);
    await assert.rejects(client.request(uriOf(doc), 'textDocument/hover', {}), (e: unknown) => e instanceof IdrisException && e.message === STOPPED_REASON);
    await client.restart();
    await settled();
    assert.strictEqual(kind(client), 'running');
    assert.strictEqual(world.processes.length, 2);
    assert.strictEqual(world.processes[1].request.cwd, '/real/w');
    client.dispose();
  });

  test('a server that does not end after shutdown is stopped after the grace period', async () => {
    const { world, client } = await running();
    world.clients[0].stop = async () => undefined;
    const stopping = client.stop();
    await settled();
    assert.strictEqual(world.processes[0].stopped, false);
    await world.clock.advance(2_000);
    await stopping;
    assert.strictEqual(world.processes[0].stopped, true);
    client.dispose();
  });

  test('dispose kills the process group at once', async () => {
    const { world, client } = await running();
    client.dispose();
    assert.strictEqual(world.processes[0].killed, true);
    assert.strictEqual(world.channel.disposed, true);
  });

  test('a new scan that gives idris2-lsp another environment or executable while it runs asks once to restart; the answer restarts it', async () => {
    const { world, client } = await running();
    world.snapshot = World.snapshot(LSP_PATH, {});
    world.toolchainChanged.fire();
    world.toolchainChanged.fire();
    await settled();
    assert.strictEqual(world.messages.length, 1);
    assert.match(world.messages[0].text, /the environment of idris2-lsp changed \(idris2\.toolchain\.env\)\. Restart the language server\?$/);
    assert.deepStrictEqual(world.messages[0].items, [RESTART_ACTION]);
    assert.strictEqual(world.processes.length, 1);
    world.reply = RESTART_ACTION;
    world.snapshot = World.snapshot('/elsewhere/idris2-lsp', {});
    world.toolchainChanged.fire();
    await settled();
    assert.match(world.messages[1].text, /idris2-lsp is now “\/elsewhere\/idris2-lsp”\. Restart the language server\?$/);
    await settled();
    assert.strictEqual(world.processes.length, 2);
    assert.strictEqual(world.processes[1].request.executable, '/elsewhere/idris2-lsp');
    client.dispose();
  });
});

suite('backend/lsp/client: the server\'s loads', () => {
  test('diagnostics the server publishes for a document it has open are reported as a load of it (the holes model follows them)', async () => {
    const { world, client, doc } = await running();
    const loads: string[] = [];
    client.onDidLoad(({ uri, failed }) => void loads.push(`${uri.toString()} ${failed}`));
    const middleware = world.clients[0].spec.middleware;
    middleware.handleDiagnostics?.(uriOf(doc), [], () => undefined);
    middleware.handleDiagnostics?.(new FakeUri('file', '/w/proj/src/Closed.idr', '') as unknown as vscode.Uri, [], () => undefined);
    assert.deepStrictEqual(loads, [`${doc.uri.toString()} false`]);
    client.dispose();
  });
});

suite('backend/lsp/client: paths', () => {
  test('the documents are sent as the real paths of their folders, to the library and to the backend, and mapped back (ServerPaths)', async () => {
    const world = new World();
    const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
    world.admit(doc);
    const client = new LspClient({ ...world.deps(), realpath: (dir: string) => `/real${dir}` });
    await settled();
    const converters = world.clients[0].spec.uriConverters;
    const real = `file:///real${ROOT_DIR}/src/A.idr`;
    assert.strictEqual(converters.code2Protocol(uriOf(doc)), real);
    assert.strictEqual(client.serverUri(uriOf(doc)), real);
    assert.strictEqual(converters.protocol2Code(real).toString(), doc.uri.toString());
    assert.strictEqual(client.documentUri(real).toString(), doc.uri.toString());
    // The last check reads the converted parameter as the document it names.
    const hook = world.clients[0].spec.middleware.sendRequest;
    assert.ok(hook);
    const answer = await (hook('textDocument/hover', { textDocument: { uri: real } }, undefined, (async () => 'answered') as never) as Promise<unknown>);
    assert.strictEqual(answer, 'answered');
    client.dispose();
  });
});

suite('backend/lsp/client: requests', () => {
  test('a request about a document the routing does not admit is refused, and nothing is started or sent', async () => {
    const world = new World();
    const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
    const client = new LspClient(world.deps());
    await settled();
    await assert.rejects(client.request(uriOf(doc), 'textDocument/codeAction', {}), (e: unknown) => e instanceof IdrisException && e.message === NOT_SERVED_REASON);
    assert.strictEqual(world.clients.length, 0);
    world.admit(doc);
    world.answer = async () => [];
    assert.deepStrictEqual(await client.request(uriOf(doc), 'textDocument/codeAction', { textDocument: { uri: doc.uri.toString() } }), []);
    assert.deepStrictEqual(world.clients[0].requests.map((r) => r.method), ['textDocument/codeAction']);
    client.dispose();
  });

  test('a request made while the client starts waits for it, then is sent', async () => {
    const world = new World();
    const doc = world.doc(`${ROOT_DIR}/src/A.idr`);
    world.admit(doc);
    world.scanning = true;
    const client = new LspClient(world.deps());
    await settled();
    assert.strictEqual(kind(client), 'starting');
    world.answer = async () => 'answer';
    const answer = client.request(uriOf(doc), 'textDocument/hover', {});
    world.scanning = false;
    world.toolchainChanged.fire();
    assert.strictEqual(await answer, 'answer');
    client.dispose();
  });

  test('repl: text the REPL would read as a command is refused before anything is sent (E10); an expression is sent as workspace/executeCommand', async () => {
    const { world, client, doc } = await running();
    for (const text of [':sh touch x', '  :exec main', '-- :x\n:t id']) {
      await assert.rejects(client.executeCommand(uriOf(doc), 'repl', [text]), (e: unknown) => kindOf(e) === 'Unsupported', text);
    }
    assert.deepStrictEqual(world.clients[0].requests, []);
    world.answer = async () => '2';
    assert.strictEqual(await client.executeCommand(uriOf(doc), 'repl', ['1 + 1']), '2');
    assert.deepStrictEqual(world.clients[0].requests, [{ method: 'workspace/executeCommand', param: { command: 'repl', arguments: ['1 + 1'] } }]);
    // The developer command sends what the user typed.
    world.answer = async () => 'Idris 2, version 0.8.0';
    assert.strictEqual(await client.rawExecuteCommand(uriOf(doc), 'repl', [':version']), 'Idris 2, version 0.8.0');
    client.dispose();
  });

  test('error responses: the missing-.ipkg ones are LoadFailed; the connection gone is BackendCrashed; others keep the server\'s message', async () => {
    const { world, client, doc } = await running();
    const fail = (code: number, message: string): void => {
      world.answer = () => Promise.reject(Object.assign(new Error(message), { code }));
    };
    const loose = recorded('loose-file').find((e) => e.kind === 'recv' && e.text?.includes('"error"'));
    const error = (JSON.parse(loose?.text ?? '{}') as { error: { code: number; message: string } }).error;
    fail(error.code, error.message);
    await assert.rejects(client.request(uriOf(doc), 'textDocument/hover', {}), (e: unknown) => kindOf(e) === 'LoadFailed');
    fail(3, 'Cannot load ipkg file for file:///w/proj/src/A.idr: "Cannot find the ipkg file"');
    await assert.rejects(client.request(uriOf(doc), 'textDocument/hover', {}), (e: unknown) => kindOf(e) === 'LoadFailed');
    fail(-32097, 'Pending response rejected since connection got disposed');
    await assert.rejects(client.request(uriOf(doc), 'textDocument/hover', {}), (e: unknown) => kindOf(e) === 'BackendCrashed');
    fail(-32601, 'Method not implemented yet');
    await assert.rejects(
      client.executeCommand(uriOf(doc), 'browseNamespace', ['Data.Vect']),
      (e: unknown) => kindOf(e) === 'ProtocolError' && (e as Error).message.endsWith('(code -32601): Method not implemented yet'),
    );
    client.dispose();
  });

  test('a request (the library\'s or the extension\'s) answered with a missing-.ipkg error is reported, through the request hook; others not', async () => {
    const { world, client, doc } = await running();
    const reported: (string | undefined)[] = [];
    client.onDidReportMissingIpkg((e) => reported.push(e.uri?.toString()));
    const hook = world.clients[0].spec.middleware.sendRequest;
    assert.ok(hook);
    const params = { textDocument: { uri: doc.uri.toString() }, position: { line: 0, character: 0 } };
    const failing = (code: number, message: string) => () => Promise.reject(Object.assign(new Error(message), { code }));
    const loose = recorded('loose-file').find((e) => e.kind === 'recv' && e.text?.includes('"error"'));
    const error = (JSON.parse(loose?.text ?? '{}') as { error: { code: number; message: string } }).error;
    const send = (next: () => Promise<unknown>): Promise<unknown> =>
      Promise.resolve(hook('textDocument/hover', params, undefined, next as never) as Promise<unknown>);
    await assert.rejects(send(failing(error.code, error.message)));
    await assert.rejects(send(failing(3, 'Cannot load ipkg file for file:///w/proj/src/A.idr: "Cannot find the ipkg file"')));
    await assert.rejects(send(failing(-32601, 'Method not implemented yet')));
    assert.strictEqual(await send(() => Promise.resolve('answer')), 'answer');
    assert.deepStrictEqual(reported, [doc.uri.toString(), doc.uri.toString()]);
    client.dispose();
  });

  test('a cancelled token rejects with Cancelled at once', async () => {
    const { world, client, doc } = await running();
    world.answer = () => new Promise(() => undefined);
    const cancel = new Emitter<void>();
    const token = { isCancellationRequested: false, onCancellationRequested: cancel.event } as unknown as vscode.CancellationToken;
    const answer = client.request(uriOf(doc), 'textDocument/codeAction', {}, token);
    await settled();
    (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    cancel.fire();
    await assert.rejects(answer, (e: unknown) => kindOf(e) === 'Cancelled');
    client.dispose();
  });
});

suite('backend/lsp/client: settings and output', () => {
  test('initializationOptions is the flat object; a change of a server option sends didChangeConfiguration with it at the top level', async () => {
    const { world, client } = await running();
    assert.deepStrictEqual(world.clients[0].spec.initializationOptions(), lspServerOptions(SETTINGS));
    world.settings = { ...SETTINGS, showImplicits: true };
    world.changeSetting('lsp.showImplicits');
    await settled();
    assert.deepStrictEqual(world.clients[0].notifications.at(-1), {
      method: 'workspace/didChangeConfiguration',
      params: { settings: { ...lspServerOptions(SETTINGS), showImplicits: true } },
    });
    const sent = world.clients[0].notifications.length;
    world.changeSetting('lsp.trace.server');
    await settled();
    assert.strictEqual(world.clients[0].notifications.length, sent);
    client.dispose();
  });

  test('the server\'s standard error: each line at its severity, controls written out; the missing-.ipkg line reports the file', async () => {
    const { world, client } = await running();
    const reported: (string | undefined)[] = [];
    client.onDidReportMissingIpkg((e) => reported.push(e.uri?.toString()));
    const proc = world.processes[0];
    proc.handlers.onStderr(Buffer.from('LOG DEBUG:Communication.Channel: Received message: {}\nLOG WARNING:Server: x‮\n', 'utf8'));
    proc.handlers.onStderr(Buffer.from('LOG ERROR:Server: Caught error which shouldn\'t be leaked while loading file: Error: Source file "/w/proj/B.idr" is not in the source directory ""\n', 'utf8'));
    assert.deepStrictEqual(world.channel.lines.slice(-3), [
      'debug LOG DEBUG:Communication.Channel: Received message: {}',
      'warn LOG WARNING:Server: x\\u{202E}',
      'error LOG ERROR:Server: Caught error which shouldn\'t be leaked while loading file: Error: Source file "/w/proj/B.idr" is not in the source directory ""',
    ]);
    assert.deepStrictEqual(reported, ['file:///w/proj/B.idr']);
    client.dispose();
  });

  test('compiler output on the server\'s stdout is written to the channel and skipped', async () => {
    const { world, client } = await running();
    world.processes[0].handlers.onStdout(Buffer.from('LOG declare.def:2: x\n', 'utf8'));
    assert.deepStrictEqual(world.channel.lines.slice(-1), ['info (stdout, not a message) LOG declare.def:2: x']);
    client.dispose();
  });

  test('a document that stops being admitted is closed on the server and its diagnostics cleared', async () => {
    const { world, client, doc } = await running();
    world.admitted.clear();
    world.ownershipChanged.fire();
    await settled();
    assert.deepStrictEqual(world.clients[0].notifications.map((n) => n.method), ['textDocument/didOpen', 'textDocument/didClose']);
    assert.deepStrictEqual(world.clients[0].deleted, [doc.uri.toString()]);
    client.dispose();
  });
});
