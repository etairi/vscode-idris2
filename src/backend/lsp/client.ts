/**
 * The language client of idris2-lsp (`backend/lsp/client.ts`; ARCHITECTURE §4, §5.3; ROADMAP M5):
 * `LspClient` implements `LspClientHandle` (`types.ts`) over one `LanguageClient` of
 * vscode-languageclient 10.1.2 per server process.
 *
 * **Lifecycle.** Nothing starts before a document the routing admits (`LspOwnership`) is open, or a
 * request about one is made (`notStarted`). Then `starting` → `running`. Each start creates a new
 * `LanguageClient`, so that no state of the library's own state machine (a start that failed
 * cannot be started again) outlives its process. An unexpected end of the process restarts it with
 * M2's reading of the backoff (ROADMAP §9 Q22; `backend/ide/session.ts`, *Backoff and give-up*): at
 * most three restarts within any five minutes, after 0 s, 2 s and 10 s, counted from the end, and an
 * end that would need a fourth gives up (`failed`, with a warning that offers the output and a
 * restart). A process that could not be started at all (the executable missing, say), and a server
 * that refuses `initialize`, fail at once. **Stop Language Server** stops it (`stopped`); then
 * nothing starts it again, neither a document nor a request (which answers `Unsupported` saying
 * so), until **Restart Language Server** — the documented choice the contract leaves to this module.
 * Restart also leaves `failed`, and so does a new toolchain scan. The process keeps running while no
 * admitted document is open (one process per window; its resident memory peaked at about 215 MiB in
 * the recorder's runs [live]).
 *
 * **The process** is started by `core/process.ts` `startLongRunningProcess` — so nothing in
 * Restricted Mode, fully qualified paths, no shell, its own process group — from the `ServerOptions`
 * function, so that its standard output and error are streams this module owns. Executable: the
 * `probed` `idris2-lsp` of the current toolchain scan (a running scan is waited for), with no
 * arguments; environment: the scan's `idris2.toolchain.env` over the Extension Host's (pack's wrapper
 * sets pack's own, F22); working directory: the trusted workspace folder that holds the root of the
 * document that started it, else that root's own folder (a root the consent gate allowed, M2;
 * the server adds its working directory to the library path, `addLibDir cwd`, and pack's wrapper
 * reads the `pack.toml` of it and its parents [src]). Right before the spawn the consent gate judges
 * that directory again (`SessionGate.recheck`) and the process starts in the real path it judged,
 * as IDE-mode sessions do; a refusal starts nothing and leaves the client `notStarted`. Stopping
 * sends `shutdown` and `exit`, then stops the process group if it has not ended within
 * `GRACE_MS`; `dispose` kills the group at once.
 *
 * **Reading the server.** `FramedMessageReader` frames the JSON-RPC messages itself rather than
 * vscode-jsonrpc's reader: a file with a `%logging` pragma makes the compiler print its `LOG` lines
 * on the server's standard output between messages, and vscode-jsonrpc 9.0.3's reader then reports
 * `Header must provide a Content-Length property` and loses the messages after them [live, recorder,
 * recording `logging`]. Bytes that are not a message are written to the output channel and skipped.
 * The server's standard error (its log, `LOG <SEVERITY>:<topic>: …`, the severity in capitals
 * [live]) goes to the output channel line by line, at the channel level its severity names (`DEBUG`
 * lines show once the channel's level is Debug), its control and format characters written out
 * (`visible`). That channel, "Idris 2 Language Server" (`LSP_CLIENT_NAME`), is this module's, kept
 * across restarts; the library writes its own messages and its trace there too.
 *
 * **What the library may do.** Only the features of `CLIENT_FEATURES` are registered (others of the
 * library's built-in features would, e.g., register the server's `executeCommandProvider` commands `repl`,
 * `metavars`, … as global VS Code commands that any command link could run, or answer the server's
 * `workspace/configuration` with any setting). Of the server's requests and notifications, only
 * `publishDiagnostics` and `workspace/semanticTokens/refresh` are acted on — the only two the server
 * sends (`Server/Response.idr`, `ProcessMessage.idr` 592 [src]): `window/showMessage`,
 * `window/logMessage` and `window/showMessageRequest` are written to the output channel, never shown
 * as notifications (the library would put the server's text into one, where VS Code makes links of
 * it); `workspace/applyEdit` is refused (edits are applied by the extension, under M4's rules),
 * `window/showDocument` too, and so are dynamic registrations. The library never shows a
 * notification itself (its `error`, `warn`, `info` and `debug` only write to the channel): the
 * extension's own state, status and warnings say what happened. These hold from the end of
 * `initialize` on; a request the server makes before answering `initialize` is the library's (the
 * server makes none).
 *
 * **Settings.** `initializationOptions` is the flat object of the eight `idris2.lsp.*` server options
 * (`lspServerOptions`), read at each start; a change of one is sent at once as
 * `workspace/didChangeConfiguration` with the same flat object (F20: the server reads the top level;
 * not `synchronize.configurationSection`, which nests by section) and restarts nothing.
 * `idris2.lsp.trace.server` is read by the library itself (`types.ts` `LSP_CLIENT_ID`) and applies
 * at once. What needs a new process — a toolchain scan that finds another `idris2-lsp`
 * (`idris2.toolchain.lspPath`, …) or gives it another environment (`idris2.toolchain.env`) while one
 * runs — asks once "Restart the language server?".
 *
 * **Requests** (`request`, `executeCommand`) are the extension's one way to the server, under the
 * contract of `LspClientHandle`: nothing is sent unless the workspace is trusted and `admits(about)`
 * holds, and the middleware's last check (`middleware.ts`) sees the document opened. `repl` text is
 * refused with M3's `replCommandRefusal` here as well as in the backend (ROADMAP M5, security: the
 * server hands it to the REPL, which runs colon commands [live, E10]); only the developer command
 * sends raw text (`rawExecuteCommand`, `commands.ts`). There is no time limit of the client's own: a
 * request ends with the server's answer, the server's end, or the caller's token. The server's error
 * responses keep the server's message (untrusted text, for `plainText`); the missing-`.ipkg` errors
 * of every request, the library's and the extension's (`middleware.ts` `isMissingIpkgError`, seen in
 * its request hook), and such log lines (`missingIpkgInLog`) fire `onDidReportMissingIpkg`.
 *
 * Only type imports from `vscode` and `vscode-languageclient`: `nodeLanguageClients` loads the library
 * when the first client is made, so unit tests run on plain Node with a fake factory.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type {
  DataCallback,
  Disposable,
  DocumentFilter,
  DynamicFeature,
  Message,
  MessageReader,
  MessageTransports,
  MessageWriter,
  Middleware,
  StaticFeature,
} from 'vscode-languageclient/node';
import type { Config, LspSettings } from '../../core/config';
import { LSP_SERVER_OPTION_KEYS } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { cancelled, IdrisException, isCancelled, unsupported, type IdrisError } from '../../core/errors';
import { Emitter, type Event } from '../../core/event';
import type { Log } from '../../core/log';
import { plainText, shownPath } from '../../core/notificationText';
import { GRACE_MS, RESTRICTED_MODE_REASON, startLongRunningProcess, type Environment, type LongRunningExit, type LongRunningProcess } from '../../core/process';
import type { SessionGate, WorkspaceTrust } from '../../core/trust';
import { visible } from '../../core/untrustedText';
import { idrisDocumentSelector, isIdrisDocument } from '../../project/literate';
import type { ProjectIndex } from '../../project/types';
import type { ToolchainService, ToolchainSnapshot } from '../../toolchain/types';
import { replCommandRefusal } from '../ide/replCommand';
import { createMiddleware, DocumentSync, isMissingIpkgError, ServerPaths, type MiddlewareApi } from './middleware';
import {
  LSP_CLIENT_ID,
  LSP_CLIENT_NAME,
  type LspClientHandle,
  type LspClientState,
  type LspCommandArguments,
  type LspCommandName,
  type LspCommandResults,
  type LspOwnership,
  type LspServerOptions,
} from './types';

// -------------------------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------------------------

/**
 * The library features registered (module comment, *What the library may do*), by the method of
 * their registration type: the text sync and the providers of `middleware.ts`.
 */
export const CLIENT_FEATURES: ReadonlySet<string> = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didSave',
  'textDocument/didClose',
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/signatureHelp',
  'textDocument/definition',
  'textDocument/documentHighlight',
  'textDocument/documentSymbol',
  'textDocument/codeAction',
  'textDocument/semanticTokens',
]);

/** Whether a library feature is registered: a dynamic feature whose registration method is in `CLIENT_FEATURES`. */
export function keepsFeature(feature: object): boolean {
  const method = (feature as { registrationType?: { method?: unknown } }).registrationType?.method;
  return typeof method === 'string' && CLIENT_FEATURES.has(method);
}

/** The backoff of M2 (module comment, *Lifecycle*). */
export const RESTART_DELAYS_MS: readonly number[] = [0, 2_000, 10_000];
export const CRASH_WINDOW_MS = 5 * 60_000;

/** How long `stop` gives the server to answer `shutdown` (the library's own default). */
const SHUTDOWN_TIMEOUT_MS = 2_000;

/** The button of the restart question and of the give-up warning. */
export const RESTART_ACTION = 'Restart Language Server';
const SHOW_OUTPUT_ACTION = 'Show Language Server Output';

const RESTART_HINT = 'Idris 2: Restart Language Server starts it again.';
export const STOPPED_REASON = `The language server is stopped (Idris 2: Stop Language Server). ${RESTART_HINT}`;
export const NOT_SERVED_REASON = 'This file is not served by idris2-lsp: its project is checked by IDE mode, has no .ipkg file, or its folder is not allowed.';

/** The refusal of the server's `workspace/applyEdit` (module comment). */
export const APPLY_EDIT_REFUSED = 'vscode-idris2 applies only the edits it asks for, under its own checks.';

// -------------------------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------------------------

/** The flat object of server options (`types.ts` `LspServerOptions`): `logFile` only when set. */
export function lspServerOptions(settings: LspSettings): LspServerOptions {
  return {
    ...(settings.logFile === '' ? {} : { logFile: settings.logFile }),
    logSeverity: settings.logSeverity,
    longActionTimeout: settings.longActionTimeoutMs,
    maxCodeActionResults: settings.maxCodeActionResults,
    showImplicits: settings.showImplicits,
    showMachineNames: settings.showMachineNames,
    fullNamespace: settings.fullNamespace,
    briefCompletions: settings.briefCompletions,
  };
}

// -------------------------------------------------------------------------------------------
// F35: the server's reports of a missing .ipkg
// -------------------------------------------------------------------------------------------

/**
 * The file a log line of the server reports as having no `.ipkg` (the same two cases as
 * `middleware.ts` `isMissingIpkgError`, as `loadURI` logs them: `LOG ERROR:Server: Cannot load ipkg file for <uri>:
 * "Cannot find the ipkg file"` [src], `LOG ERROR:Server: Caught error which shouldn't be leaked while
 * loading file: Error: Source file "<abs>" is not in the source directory ""` [live]): `{ path }` or
 * `{ uri }` when the line names it plainly, `{}` when it names it in a form not read here (a path
 * the compiler's `show` escaped), `undefined` for any other line.
 */
export function missingIpkgInLog(line: string): { readonly path?: string; readonly uri?: string } | undefined {
  if (!line.startsWith('LOG ERROR:Server: ')) {
    return undefined;
  }
  const source = /^LOG ERROR:Server: Caught error which shouldn't be leaked while loading file: Error: Source file "(.*)" is not in the source directory ""$/.exec(line);
  if (source !== null) {
    return /^[^"\\]+$/.test(source[1]) ? { path: source[1] } : {};
  }
  const ipkg = /^LOG ERROR:Server: Cannot load ipkg file for (\S+): "Cannot find the ipkg file"$/.exec(line);
  return ipkg === null ? undefined : { uri: ipkg[1] };
}

// -------------------------------------------------------------------------------------------
// The server's output
// -------------------------------------------------------------------------------------------

/** The channel levels a line can be written at. */
export type ChannelLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY_LEVELS: Readonly<Record<string, ChannelLevel>> = { DEBUG: 'debug', INFO: 'info', WARNING: 'warn', ERROR: 'error', CRITICAL: 'error' };

/** The channel level of a line of the server's standard error: its `LOG <SEVERITY>:` (module comment), `info` for any other line. */
export function serverLogLevel(line: string): ChannelLevel {
  const severity = /^LOG ([A-Z]+):/.exec(line)?.[1];
  return (severity === undefined ? undefined : SEVERITY_LEVELS[severity]) ?? 'info';
}

/** The channel level of an LSP `MessageType` (1 Error, 2 Warning, 3 Info, 4 Log, 5 Debug). */
export function messageTypeLevel(type: unknown): ChannelLevel {
  return type === 1 ? 'error' : type === 2 ? 'warn' : type === 3 ? 'info' : 'debug';
}

/** Splits bytes into lines (LF, a CR before it dropped), decoding UTF-8 across chunk boundaries. */
export class LineSplitter {
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    lines.forEach((line) => this.onLine(line.replace(/\r$/, '')));
  }

  end(): void {
    this.pending += this.decoder.decode();
    if (this.pending !== '') {
      this.onLine(this.pending.replace(/\r$/, ''));
    }
    this.pending = '';
  }
}

const HEADER_START = Buffer.from('Content-Length:', 'ascii');
const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');
/** A header block longer than this is not one. */
const MAX_HEADER_BYTES = 4096;
/** Bytes without a line break and no header in them are reported once there are this many. */
const MAX_PENDING_UNFRAMED = 65_536;

/**
 * The JSON-RPC messages of a byte stream framed as `Content-Length: N\r\n[other headers\r\n]\r\n`
 * and N bytes of UTF-8 JSON (the server writes `Content-Length` only [live]); bytes outside a frame
 * (module comment, *Reading the server*) go to `onUnframed` — whole lines, or the text before a
 * header — and are skipped. A body that is not a JSON object is reported as an error (`onError`), and
 * reading goes on after it. Messages and the end of the stream are delivered only once `listen` has
 * been called. `onPartialMessage` never fires.
 */
export class FramedMessageReader implements MessageReader {
  private readonly errors = new Emitter<Error>();
  private readonly closes = new Emitter<void>();
  readonly onError = this.errors.event;
  readonly onClose = this.closes.event;
  readonly onPartialMessage = (): Disposable => ({ dispose: () => undefined });
  private buffer: Buffer = Buffer.alloc(0);
  private bodyLength: number | undefined;
  private callback: DataCallback | undefined;
  private readonly waiting: Message[] = [];
  private ended = false;
  private closed = false;

  constructor(private readonly onUnframed: (text: string) => void) {}

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    this.waiting.splice(0).forEach((message) => callback(message));
    if (this.ended) {
      this.close();
    }
    return { dispose: () => (this.callback = undefined) };
  }

  push(chunk: Uint8Array): void {
    if (this.ended) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parse();
  }

  /** The stream ended: what is left is reported as unframed, and `onClose` fires (once listening). */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.buffer.length > 0) {
      this.unframed(this.buffer.length);
    }
    if (this.callback !== undefined) {
      this.close();
    }
  }

  dispose(): void {
    this.callback = undefined;
    this.errors.dispose();
    this.closes.dispose();
  }

  private close(): void {
    if (!this.closed) {
      this.closed = true;
      this.closes.fire();
    }
  }

  private unframed(length: number): void {
    const text = this.buffer.subarray(0, length).toString('utf8');
    this.buffer = this.buffer.subarray(length);
    this.onUnframed(text);
  }

  private deliver(message: Message): void {
    if (this.callback === undefined) {
      this.waiting.push(message);
    } else {
      this.callback(message);
    }
  }

  private parse(): void {
    for (;;) {
      if (this.bodyLength === undefined) {
        const start = this.buffer.indexOf(HEADER_START);
        if (start > 0) {
          this.unframed(start);
          continue;
        }
        if (start < 0) {
          const lineEnd = this.buffer.lastIndexOf(0x0a);
          if (lineEnd >= 0) {
            this.unframed(lineEnd + 1);
          } else if (this.buffer.length > MAX_PENDING_UNFRAMED) {
            this.unframed(this.buffer.length - HEADER_START.length);
          }
          return;
        }
        const end = this.buffer.indexOf(HEADER_END);
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) {
            this.skipLine();
            continue;
          }
          return;
        }
        const length = contentLength(this.buffer.subarray(0, end).toString('ascii'));
        if (length === undefined) {
          this.skipLine();
          continue;
        }
        this.buffer = this.buffer.subarray(end + HEADER_END.length);
        this.bodyLength = length;
      }
      if (this.buffer.length < this.bodyLength) {
        return;
      }
      const body = this.buffer.subarray(0, this.bodyLength).toString('utf8');
      this.buffer = this.buffer.subarray(this.bodyLength);
      this.bodyLength = undefined;
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        message = undefined;
      }
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
        this.deliver(message as Message);
      } else {
        this.errors.fire(new Error(`idris2-lsp wrote a message that is not a JSON object (${body.length} characters).`));
      }
    }
  }

  /** Reports the first line of the buffer (or all of it) as unframed: a `Content-Length:` there began no frame. */
  private skipLine(): void {
    const lineEnd = this.buffer.indexOf(0x0a);
    this.unframed(lineEnd < 0 ? this.buffer.length : lineEnd + 1);
  }
}

/** The `Content-Length` of a header block (without the blank line), or `undefined` when it is not a valid one. */
export function contentLength(header: string): number | undefined {
  let length: number | undefined;
  for (const line of header.split('\r\n')) {
    const field = /^([A-Za-z-]+): *(.*)$/.exec(line);
    if (field === null) {
      return undefined;
    }
    if (field[1].toLowerCase() === 'content-length') {
      if (!/^\d{1,9}$/.test(field[2]) || length !== undefined) {
        return undefined;
      }
      length = Number(field[2]);
    }
  }
  return length;
}

/** Writes each message framed as the reader expects (`Content-Length` only), in order. */
export class FramedMessageWriter implements MessageWriter {
  private readonly errors = new Emitter<[Error, Message | undefined, number | undefined]>();
  private readonly closes = new Emitter<void>();
  readonly onError = this.errors.event;
  readonly onClose = this.closes.event;
  private ended = false;

  constructor(private readonly sink: (bytes: Uint8Array) => void) {}

  write(message: Message): Promise<void> {
    if (this.ended) {
      return Promise.reject(new Error('idris2-lsp has ended.'));
    }
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.sink(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
    return Promise.resolve();
  }

  end(): void {
    // The process's input stays open until the process ends: `exit` ends the server.
  }

  /** The process ended: later writes fail, and `onClose` fires. */
  closed(): void {
    if (!this.ended) {
      this.ended = true;
      this.closes.fire();
    }
  }

  dispose(): void {
    this.errors.dispose();
    this.closes.dispose();
  }
}

// -------------------------------------------------------------------------------------------
// The language client as this module uses it
// -------------------------------------------------------------------------------------------

/** What `LspClient` uses of a `LanguageClient` (vscode-languageclient's satisfies it). */
export interface LspLanguageClient {
  start(): Promise<void>;
  stop(timeout?: number): Promise<void>;
  dispose(timeout?: number): Promise<void>;
  sendRequest<R>(method: string, param: unknown, token?: vscode.CancellationToken): Promise<R>;
  sendNotification(method: string, params?: unknown): Promise<void>;
  readonly code2ProtocolConverter: {
    asOpenTextDocumentParams(doc: vscode.TextDocument): unknown;
    asCloseTextDocumentParams(doc: vscode.TextDocument): unknown;
    asChangeTextDocumentParams(doc: vscode.TextDocument): unknown;
    asSaveTextDocumentParams(doc: vscode.TextDocument, includeContent?: boolean): unknown;
  };
  readonly diagnostics: Pick<vscode.DiagnosticCollection, 'delete'> | undefined;
}

/** What `LspClient` gives the factory for one client. */
export interface LanguageClientSpec {
  /** The `ServerOptions` function: spawns the process and returns its transports. */
  readonly serverOptions: () => Promise<MessageTransports>;
  readonly outputChannel: vscode.LogOutputChannel;
  readonly initializationOptions: () => LspServerOptions;
  readonly middleware: Middleware;
  /** The library's `ErrorHandler.closed`: the message it logs (restarts are this module's). */
  readonly closedMessage: () => string;
  /** The library's `initializationFailedHandler` (which then gives up the start). */
  readonly initializationFailed: (error: unknown) => void;
  /** The library's `uriConverters`: the document URIs as the server is sent them, and back (`middleware.ts` `ServerPaths`). */
  readonly uriConverters: { code2Protocol(uri: vscode.Uri): string; protocol2Code(value: string): vscode.Uri };
}

export type LanguageClientFactory = (spec: LanguageClientSpec) => Promise<LspLanguageClient>;

/**
 * The client's `documentSelector`: the extension's one selector (`project/literate.ts`), `file:`
 * documents only. ARCHITECTURE §3.2 left the literate rows out until E1, which the recorder settled:
 * the server loads `.lidr`, `.md` and `.idr.md` files of a project [live, recordings `lit2`,
 * `literate-md`]. Ownership is the middleware's either way.
 */
export function serverDocumentSelector(): DocumentFilter[] {
  return idrisDocumentSelector().map((filter) =>
    filter.language !== undefined ? { scheme: 'file', language: filter.language } : { scheme: 'file', pattern: String(filter.pattern) },
  );
}

/** Writes a `window/showMessage`, `window/logMessage` or `window/showMessageRequest` of the server to `channel` (module comment). */
export function logServerMessage(channel: Pick<vscode.LogOutputChannel, ChannelLevel>, params: unknown): void {
  const { type, message } = (typeof params === 'object' && params !== null ? params : {}) as { type?: unknown; message?: unknown };
  channel[messageTypeLevel(type)](`idris2-lsp: ${visible(String(message))}`);
}

/**
 * The factory of real clients: a subclass of vscode-languageclient's `LanguageClient` (loaded when
 * first needed) that registers only `CLIENT_FEATURES` and shows no notification, with the server's
 * requests and notifications handled as the module comment says.
 */
export function nodeLanguageClients(): LanguageClientFactory {
  return async (spec) => {
    const lc = await import('vscode-languageclient/node');
    class IdrisLanguageClient extends lc.LanguageClient {
      override registerFeature(feature: StaticFeature | DynamicFeature<unknown>): void {
        if (keepsFeature(feature)) {
          super.registerFeature(feature);
        }
      }
      override error(message: string, data?: unknown): void {
        super.error(message, data, false);
      }
      override warn(message: string, data?: unknown): void {
        super.warn(message, data, false);
      }
      override info(message: string, data?: unknown): void {
        super.info(message, data, false);
      }
      override debug(message: string, data?: unknown): void {
        super.debug(message, data, false);
      }
    }
    const client = new IdrisLanguageClient(LSP_CLIENT_ID, LSP_CLIENT_NAME, spec.serverOptions, {
      documentSelector: serverDocumentSelector(),
      outputChannel: spec.outputChannel,
      revealOutputChannelOn: lc.RevealOutputChannelOn.Never,
      diagnosticCollectionName: 'idris2-lsp',
      initializationOptions: spec.initializationOptions,
      uriConverters: spec.uriConverters,
      initializationFailedHandler: (error) => {
        spec.initializationFailed(error);
        return false;
      },
      errorHandler: {
        error: (_error, _message, count) => ({ action: count !== undefined && count <= 3 ? lc.ErrorAction.Continue : lc.ErrorAction.Shutdown, handled: true }),
        closed: () => ({ action: lc.CloseAction.DoNotRestart, message: spec.closedMessage(), handled: true }),
      },
      middleware: spec.middleware,
    });
    const log = (params: unknown): void => logServerMessage(spec.outputChannel, params);
    client.onNotification('window/showMessage', log);
    client.onNotification('window/logMessage', log);
    client.onRequest('window/showMessageRequest', (params: unknown) => {
      log(params);
      return null;
    });
    client.onRequest('window/showDocument', () => ({ success: false }));
    client.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: APPLY_EDIT_REFUSED }));
    for (const method of ['client/registerCapability', 'client/registerFeature']) {
      client.onRequest(method, () => {
        throw new Error('vscode-idris2 registers no capability on request.');
      });
    }
    return client;
  };
}

/**
 * A channel that does nothing once disposed: the library may still write to it after `dispose`
 * (a stop that finishes late), and VS Code's channel throws then (`core/log.ts` `createLog`).
 */
function guardedChannel(channel: vscode.LogOutputChannel): vscode.LogOutputChannel & IDisposable {
  let open = true;
  const ifOpen =
    <A extends unknown[]>(f: (...args: A) => void) =>
    (...args: A): void => {
      if (open) {
        f(...args);
      }
    };
  return {
    get name() {
      return channel.name;
    },
    get logLevel() {
      return channel.logLevel;
    },
    onDidChangeLogLevel: channel.onDidChangeLogLevel,
    trace: ifOpen((message: string, ...args: unknown[]) => channel.trace(message, ...args)),
    debug: ifOpen((message: string, ...args: unknown[]) => channel.debug(message, ...args)),
    info: ifOpen((message: string, ...args: unknown[]) => channel.info(message, ...args)),
    warn: ifOpen((message: string, ...args: unknown[]) => channel.warn(message, ...args)),
    error: ifOpen((error: string | Error, ...args: unknown[]) => channel.error(error, ...args)),
    append: ifOpen((value: string) => channel.append(value)),
    appendLine: ifOpen((value: string) => channel.appendLine(value)),
    replace: ifOpen((value: string) => channel.replace(value)),
    clear: ifOpen(() => channel.clear()),
    show: ifOpen((a?: vscode.ViewColumn | boolean, b?: boolean) => (typeof a === 'boolean' ? channel.show(a) : channel.show(a, b))),
    hide: ifOpen(() => channel.hide()),
    dispose: () => {
      if (open) {
        open = false;
        channel.dispose();
      }
    },
  };
}

// -------------------------------------------------------------------------------------------
// LspClient
// -------------------------------------------------------------------------------------------

/** Timers, so that tests can drive the backoff. */
export interface LspClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What `LspClient` uses of the `vscode` namespace. */
export type LspClientApi = MiddlewareApi & {
  readonly window: Pick<typeof vscode.window, 'createOutputChannel' | 'showInformationMessage' | 'showWarningMessage'>;
  readonly workspace: Pick<typeof vscode.workspace, 'textDocuments' | 'onDidOpenTextDocument' | 'onDidChangeTextDocument' | 'onWillSaveTextDocument'>;
  readonly Uri: Pick<typeof vscode.Uri, 'file' | 'parse'>;
};

export interface LspClientDeps {
  readonly api: LspClientApi;
  readonly languageClients: LanguageClientFactory;
  readonly ownership: LspOwnership;
  readonly gate: Pick<SessionGate, 'recheck'>;
  readonly toolchain: Pick<ToolchainService, 'current' | 'scanning' | 'onDidChange'>;
  readonly config: Pick<Config, 'lsp' | 'onDidChange'>;
  readonly trust: WorkspaceTrust;
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd'>;
  /** The paths of the workspace folders (`file:` ones), in order. */
  readonly folders: () => readonly string[];
  /** The text of a file on disk (`middleware.ts` `MiddlewareDeps.readText`). */
  readonly readText: (fileName: string) => Promise<string | undefined>;
  readonly log: Log;
  readonly platform: NodeJS.Platform;
  /** The Extension Host's environment, under `idris2.toolchain.env`. */
  readonly processEnv: Environment;
  readonly clock: LspClock;
  /** Starts the process: `core/process.ts` `startLongRunningProcess` unless a unit test passes a fake. */
  readonly startProcess?: typeof startLongRunningProcess;
  /** Keep the warnings shown (`notices`), for the test API. */
  readonly keepNotices?: boolean;
  /** The real path of a folder (`fs.realpathSync.native`, `undefined` when it cannot be resolved), unless a unit test passes a fake. */
  readonly realpath?: (dir: string) => string | undefined;
}

/** `fs.realpathSync.native`, `undefined` when the folder cannot be resolved. */
function realFolder(dir: string): string | undefined {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return undefined;
  }
}

/** What one process is started with. */
interface Launch {
  readonly executable: string;
  /** The directory as chosen; the process starts in the real path the gate judged. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** One `LanguageClient` and its process. */
interface Instance {
  readonly generation: number;
  readonly launch: Launch;
  client: LspLanguageClient | undefined;
  proc: LongRunningProcess | undefined;
  writer: FramedMessageWriter | undefined;
  /** Set when the process ended; `exited` resolves then. */
  exit: LongRunningExit | undefined;
  readonly exited: Promise<void>;
  markExited(): void;
  /** This module (or the library, giving up the start) is stopping it: its end is no crash. */
  stopping: boolean;
  /** The launch identity the restart question was asked for, so that it is asked once. */
  asked: string | undefined;
  /** A server option changed while it was starting: sent once it runs. */
  optionsChanged: boolean;
}

/** A refusal before the spawn (Restricted Mode, the gate): nothing failed, the client stays `notStarted`. */
class Refusal extends Error {}

const describeExit = (exit: LongRunningExit): string =>
  exit.spawnError !== undefined ? `could not be started (${exit.spawnError})` : exit.signal !== null ? `ended (${exit.signal})` : `ended (exit code ${exit.code})`;

const sameEnvironment = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

/** Whether `dir` is `folder` or lies below it (paths as given). */
function within(folder: string, dir: string): boolean {
  const relative = path.relative(folder, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class LspClient implements LspClientHandle {
  private readonly store = new DisposableStore();
  private readonly stateChanged = this.store.add(new Emitter<void>());
  private readonly missingIpkg = this.store.add(new Emitter<{ readonly uri?: vscode.Uri }>());
  private readonly loads = this.store.add(new Emitter<{ readonly uri: vscode.Uri; readonly failed: boolean }>());
  readonly onDidChangeState: Event<void> = this.stateChanged.event;
  readonly onDidReportMissingIpkg: Event<{ readonly uri?: vscode.Uri }> = this.missingIpkg.event;
  /**
   * The server loaded the file of `uri`, a document it has open (it published its diagnostics,
   * `middleware.ts` `MiddlewareDeps.published`); `failed`: they hold an error. The holes model
   * refreshes on it (`extension.ts`), as on IDE mode's loads.
   */
  readonly onDidLoad: Event<{ readonly uri: vscode.Uri; readonly failed: boolean }> = this.loads.event;
  private current: LspClientState = { kind: 'notStarted' };
  private readonly sync: DocumentSync;
  private readonly paths: ServerPaths;
  private readonly middleware: Middleware;
  private channel: (vscode.LogOutputChannel & IDisposable) | undefined;
  private instance: Instance | undefined;
  private generation = 0;
  /** The directory of the last start, for restarts. */
  private lastCwd: string | undefined;
  private crashTimes: number[] = [];
  private backoffTimer: unknown;
  private startCheck: Promise<void> | undefined;
  private disposed = false;
  /** The warnings shown, when `keepNotices`. */
  readonly notices: string[] = [];

  constructor(private readonly deps: LspClientDeps) {
    this.sync = new DocumentSync(deps.ownership, deps.log);
    this.paths = new ServerPaths(deps.realpath ?? realFolder, deps.api.Uri, deps.platform);
    this.middleware = createMiddleware({
      api: deps.api,
      sync: this.sync,
      readText: deps.readText,
      log: deps.log,
      published: (uri, failed) => this.loads.fire({ uri, failed }),
      missingIpkg: (uri) => this.missingIpkg.fire({ uri: deps.api.Uri.parse(uri) }),
      documentKey: (uri) => this.paths.documentKey(uri),
    });
    this.store.add(deps.ownership.onDidChange(() => this.ownershipChanged()));
    this.store.add(deps.api.workspace.onDidOpenTextDocument(() => this.startIfNeeded()));
    // `middleware.ts` `DocumentSync`, *Clean again*.
    this.store.add(deps.api.workspace.onDidChangeTextDocument((e) => this.sync.stateChanged(e.document)));
    this.store.add(deps.api.workspace.onWillSaveTextDocument((e) => this.sync.willSave(e.document)));
    this.store.add(deps.trust.onDidGrant(() => this.startIfNeeded()));
    this.store.add(deps.toolchain.onDidChange(() => this.toolchainChanged()));
    this.store.add(
      deps.config.onDidChange('lsp', (change) => {
        if (LSP_SERVER_OPTION_KEYS.some((key) => change.affects(key))) {
          this.optionsChanged();
        }
      }),
    );
    this.startIfNeeded();
  }

  get state(): LspClientState {
    return this.current;
  }

  serverUri(uri: vscode.Uri): string {
    return this.paths.toServer(uri);
  }

  documentUri(value: string): vscode.Uri {
    return this.paths.fromServer(value);
  }

  private setState(next: LspClientState): void {
    const same = next.kind === this.current.kind && (next.kind !== 'failed' || (this.current.kind === 'failed' && next.reason === this.current.reason));
    this.current = next;
    if (!same) {
      this.stateChanged.fire();
    }
  }

  /** The output channel, created on first use and kept until `dispose`. */
  private output(): vscode.LogOutputChannel & IDisposable {
    this.channel ??= guardedChannel(this.deps.api.window.createOutputChannel(LSP_CLIENT_NAME, { log: true }));
    return this.channel;
  }

  /** **Idris 2: Show Language Server Output**. */
  showOutput(): void {
    this.output().show(true);
  }

  /** Writes a line of the developer command's to the output channel. */
  writeOutput(line: string): void {
    this.output().info(line);
  }

  // --- starting --------------------------------------------------------------------------------

  /** The open Idris documents of `file:` URIs. */
  private candidates(): vscode.TextDocument[] {
    return this.deps.api.workspace.textDocuments.filter((d) => d.uri.scheme === 'file' && isIdrisDocument(d));
  }

  /** Starts the client for the first open document that is admitted, when it has not started (module comment, *Lifecycle*). */
  private startIfNeeded(): void {
    if (this.current.kind !== 'notStarted' || this.startCheck !== undefined || this.disposed || !this.deps.trust.isTrusted) {
      return;
    }
    this.startCheck = (async () => {
      for (const doc of this.candidates()) {
        if (this.current.kind !== 'notStarted') {
          return;
        }
        if (await this.deps.ownership.admits(doc.uri)) {
          await this.startFor(doc.uri);
          return;
        }
      }
    })()
      .catch((error: unknown) => this.deps.log.warn(`Language server: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => (this.startCheck = undefined));
  }

  /** Starts for the root of `about`, in the workspace folder that holds it, else in its own folder. */
  private async startFor(about: vscode.Uri): Promise<void> {
    if (this.current.kind !== 'notStarted') {
      return;
    }
    const root = await this.deps.projects.classify(about.fsPath);
    const dir = this.deps.projects.sessionCwd(root);
    const cwd = this.deps.folders().find((folder) => within(folder, dir)) ?? dir;
    if (this.current.kind === 'notStarted' && !this.disposed) {
      await this.start(cwd);
    }
  }

  /** The current scan once no scan runs; `undefined` once disposed. */
  private async settledSnapshot(): Promise<ToolchainSnapshot | undefined> {
    const toolchain = this.deps.toolchain;
    while (!this.disposed && (toolchain.scanning || toolchain.current === undefined)) {
      await new Promise<void>((resolve) => {
        const subscription = toolchain.onDidChange(() => {
          subscription.dispose();
          resolve();
        });
      });
    }
    return this.disposed ? undefined : toolchain.current;
  }

  /** The executable and environment a start would use now, or why there is none. */
  private launchFrom(snapshot: ToolchainSnapshot, cwd: string): Launch | { readonly problem: string } {
    const lsp = snapshot.lsp;
    switch (lsp.status) {
      case 'probed':
        return { executable: lsp.location.path, cwd, env: snapshot.settings.env };
      case 'located':
        return { problem: RESTRICTED_MODE_REASON };
      case 'missing':
      case 'failed':
        return { problem: `No usable idris2-lsp: ${lsp.reason}` };
    }
  }

  private async start(cwd: string): Promise<void> {
    const generation = ++this.generation;
    this.lastCwd = cwd;
    this.setState({ kind: 'starting' });
    const previous = this.instance;
    if (previous !== undefined) {
      await this.stopInstance(previous);
    }
    const snapshot = await this.settledSnapshot();
    if (snapshot === undefined || generation !== this.generation) {
      return;
    }
    const launch = this.launchFrom(snapshot, cwd);
    if ('problem' in launch) {
      this.fail(generation, launch.problem);
      return;
    }
    let markExited = (): void => undefined;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    const instance: Instance = {
      generation,
      launch,
      client: undefined,
      proc: undefined,
      writer: undefined,
      exit: undefined,
      exited,
      markExited,
      stopping: false,
      asked: undefined,
      optionsChanged: false,
    };
    this.instance = instance;
    const client = await this.deps.languageClients({
      serverOptions: () => this.spawn(instance),
      outputChannel: this.output(),
      initializationOptions: () => lspServerOptions(this.deps.config.lsp()),
      middleware: this.middleware,
      uriConverters: { code2Protocol: (uri) => this.paths.toServer(uri), protocol2Code: (value) => this.paths.fromServer(value) },
      closedMessage: () => `idris2-lsp ${instance.exit === undefined ? 'closed its connection' : describeExit(instance.exit)}.`,
      initializationFailed: (error) => {
        // The library gives the start up and stops the process: that end is not a crash.
        instance.stopping = true;
        this.fail(generation, `idris2-lsp did not initialize: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    if (this.instance !== instance) {
      void client.dispose(0).catch(() => undefined);
      return;
    }
    instance.client = client;
    this.sync.attach({
      open: (doc) => client.sendNotification('textDocument/didOpen', client.code2ProtocolConverter.asOpenTextDocumentParams(doc)),
      change: (doc) => client.sendNotification('textDocument/didChange', client.code2ProtocolConverter.asChangeTextDocumentParams(doc)),
      // With the text, as the library sends a save: the server asks for it (`save.includeText`, F20 [live]).
      save: (doc) => client.sendNotification('textDocument/didSave', client.code2ProtocolConverter.asSaveTextDocumentParams(doc, true)),
      close: (doc) => client.sendNotification('textDocument/didClose', client.code2ProtocolConverter.asCloseTextDocumentParams(doc)),
      clearDiagnostics: (uri) => client.diagnostics?.delete(uri),
    });
    try {
      await client.start();
    } catch (error) {
      if (this.instance === instance && instance.exit === undefined && this.current.kind === 'starting') {
        if (error instanceof Refusal) {
          this.deps.log.info(`Language server not started: ${error.message}`);
          this.release(instance);
          this.setState({ kind: 'notStarted' });
        } else {
          this.fail(generation, `idris2-lsp could not be started: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }
    if (this.instance === instance && this.current.kind === 'starting') {
      this.setState({ kind: 'running' });
      if (instance.optionsChanged) {
        this.optionsChanged();
      }
      void this.sync.reconcile(this.candidates());
    }
  }

  /** The `ServerOptions` function (module comment, *The process*). */
  private async spawn(instance: Instance): Promise<MessageTransports> {
    const { launch } = instance;
    if (!this.deps.trust.isTrusted) {
      throw new Refusal(RESTRICTED_MODE_REASON);
    }
    const verdict = await this.deps.gate.recheck(launch.cwd);
    if (verdict === undefined || !verdict.allowed) {
      throw new Refusal(`the folder ${launch.cwd} is not allowed to run the compiler.`);
    }
    if (this.instance !== instance || this.disposed) {
      throw new Refusal('a newer start replaced this one.');
    }
    const channel = this.output();
    const reader = new FramedMessageReader((text) => {
      for (const line of text.split('\n')) {
        if (line.trim() !== '') {
          channel.info(`(stdout, not a message) ${visible(line.replace(/\r$/, ''))}`);
        }
      }
    });
    const writer = new FramedMessageWriter((bytes) => instance.proc?.write(bytes));
    const stderr = new LineSplitter((line) => this.serverLine(line));
    instance.writer = writer;
    instance.proc = (this.deps.startProcess ?? startLongRunningProcess)(
      { executable: launch.executable, args: [], cwd: this.deps.platform === 'win32' ? launch.cwd : (verdict.realDir ?? launch.cwd), env: launch.env, stdin: 'pipe' },
      {
        onSpawn: () => undefined,
        onStdout: (chunk) => reader.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
        onExit: (exit) => {
          stderr.end();
          instance.exit = exit;
          instance.markExited();
          writer.closed();
          reader.end();
          this.ended(instance, exit);
        },
      },
      { trust: this.deps.trust, log: this.deps.log, platform: this.deps.platform, baseEnv: this.deps.processEnv },
    );
    return { reader, writer, detached: false };
  }

  /** A line of the server's standard error (module comment, *Reading the server*; F35). */
  private serverLine(line: string): void {
    this.output()[serverLogLevel(line)](visible(line));
    const missing = missingIpkgInLog(line);
    if (missing !== undefined) {
      const uri = missing.path !== undefined ? this.deps.api.Uri.file(missing.path) : missing.uri !== undefined ? this.deps.api.Uri.parse(missing.uri) : undefined;
      this.missingIpkg.fire(uri === undefined ? {} : { uri });
    }
  }

  /** The process of `instance` ended: a crash unless it was being stopped. */
  private ended(instance: Instance, exit: LongRunningExit): void {
    if (this.instance !== instance || instance.stopping || this.disposed) {
      return;
    }
    this.release(instance);
    if (exit.spawnError !== undefined) {
      this.setState({ kind: 'failed', reason: `idris2-lsp ${describeExit(exit)}.` });
      return;
    }
    const now = this.deps.clock.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    const count = this.crashTimes.length;
    if (count > RESTART_DELAYS_MS.length) {
      const reason =
        `idris2-lsp ${describeExit(exit)}, ${count} unexpected ends within ${CRASH_WINDOW_MS / 60_000} minutes, ` +
        `and it is restarted at most ${RESTART_DELAYS_MS.length} times in that period.`;
      this.setState({ kind: 'failed', reason });
      this.warnGaveUp(reason);
      return;
    }
    this.deps.log.warn(`idris2-lsp ${describeExit(exit)}; restart ${count} of ${RESTART_DELAYS_MS.length} within ${CRASH_WINDOW_MS / 60_000} minutes.`);
    this.setState({ kind: 'starting' });
    const cwd = instance.launch.cwd;
    const generation = this.generation;
    this.backoffTimer = this.deps.clock.setTimeout(() => {
      this.backoffTimer = undefined;
      if (generation === this.generation && this.current.kind === 'starting' && this.instance === undefined) {
        void this.start(cwd);
      }
    }, RESTART_DELAYS_MS[count - 1]);
  }

  private warnGaveUp(reason: string): void {
    const text = `Idris 2: the language server stopped restarting: ${reason} ${SHOW_OUTPUT_ACTION} has its messages.`;
    if (this.deps.keepNotices === true) {
      this.notices.push(text);
    }
    void this.deps.api.window.showWarningMessage(plainText(text), SHOW_OUTPUT_ACTION, RESTART_ACTION).then((action) => {
      if (action === SHOW_OUTPUT_ACTION) {
        this.showOutput();
      } else if (action === RESTART_ACTION) {
        void this.restart();
      }
    });
  }

  /** `failed` with `reason`, if `generation` is still the current start; its process is stopped. */
  private fail(generation: number, reason: string): void {
    if (generation !== this.generation || this.disposed) {
      return;
    }
    const instance = this.instance;
    if (instance !== undefined) {
      void this.stopInstance(instance);
    }
    this.setState({ kind: 'failed', reason });
  }

  /**
   * Forgets `instance` (its process has ended or is being stopped) and detaches the sync from it.
   * Its client is not disposed here: after its connection closed the library has cleaned it up
   * already (`CloseAction.DoNotRestart`), and a stop disposes it (`stopInstance`).
   */
  private release(instance: Instance): void {
    if (this.instance === instance) {
      this.instance = undefined;
      this.sync.detach();
    }
  }

  /** Stops `instance`: `shutdown` and `exit` while it runs, then its process group if it has not ended within `GRACE_MS`. */
  private async stopInstance(instance: Instance): Promise<void> {
    instance.stopping = true;
    this.release(instance);
    // No process yet: a start still in progress finds itself released and spawns nothing (`spawn`).
    if (instance.exit !== undefined || instance.proc === undefined) {
      return;
    }
    try {
      await instance.client?.stop(SHUTDOWN_TIMEOUT_MS);
    } catch {
      // Not running (still starting), or it did not answer: the process is stopped below.
    }
    const ended = await Promise.race([
      instance.exited.then(() => true),
      new Promise<boolean>((resolve) => this.deps.clock.setTimeout(() => resolve(false), GRACE_MS)),
    ]);
    if (!ended) {
      instance.proc?.stop();
    }
  }

  // --- changes -----------------------------------------------------------------------------------

  private ownershipChanged(): void {
    if (this.current.kind === 'running') {
      void this.sync.reconcile(this.candidates());
    } else {
      this.startIfNeeded();
    }
  }

  /** A server option changed: sent to a running server (module comment, *Settings*). */
  private optionsChanged(): void {
    const instance = this.instance;
    if (instance === undefined) {
      return;
    }
    if (this.current.kind !== 'running' || instance.client === undefined) {
      instance.optionsChanged = true;
      return;
    }
    instance.optionsChanged = false;
    const settings = lspServerOptions(this.deps.config.lsp());
    instance.client.sendNotification('workspace/didChangeConfiguration', { settings }).catch((error: unknown) => {
      this.deps.log.warn(`Language server: the changed settings were not sent: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** A new toolchain scan (module comment, *Lifecycle*, *Settings*). */
  private toolchainChanged(): void {
    const snapshot = this.deps.toolchain.current;
    if (snapshot === undefined || this.deps.toolchain.scanning) {
      return;
    }
    if (this.current.kind === 'failed') {
      this.crashTimes = [];
      this.setState({ kind: 'notStarted' });
      this.startIfNeeded();
      return;
    }
    const instance = this.instance;
    if (instance === undefined || this.current.kind !== 'running') {
      return;
    }
    const next = this.launchFrom(snapshot, instance.launch.cwd);
    const changes: string[] = [];
    if ('problem' in next || next.executable !== instance.launch.executable) {
      changes.push('problem' in next ? 'no usable idris2-lsp is found any more' : `idris2-lsp is now ${shownPath(next.executable)}`);
    } else if (!sameEnvironment(next.env, instance.launch.env)) {
      changes.push('the environment of idris2-lsp changed (idris2.toolchain.env)');
    }
    const key = changes.join();
    if (changes.length === 0 || instance.asked === key) {
      return;
    }
    instance.asked = key;
    void this.deps.api.window
      .showInformationMessage(plainText(`Idris 2: since the language server started, ${key}. Restart the language server?`), RESTART_ACTION)
      .then((action) => {
        if (action === RESTART_ACTION && this.instance === instance) {
          void this.restart();
        }
      });
  }

  // --- the commands ------------------------------------------------------------------------------

  async stop(): Promise<void> {
    this.generation++;
    this.deps.clock.clearTimeout(this.backoffTimer);
    this.backoffTimer = undefined;
    this.crashTimes = [];
    const instance = this.instance;
    this.setState({ kind: 'stopped' });
    if (instance !== undefined) {
      await this.stopInstance(instance);
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    if (this.disposed) {
      return;
    }
    this.setState({ kind: 'notStarted' });
    if (this.lastCwd !== undefined && this.deps.trust.isTrusted) {
      await this.start(this.lastCwd);
    } else {
      this.startIfNeeded();
    }
  }

  // --- requests ----------------------------------------------------------------------------------

  /** Waits until the client runs, starting it for `about` when it has not started; rejects when it cannot. */
  private async running(about: vscode.Uri, token: vscode.CancellationToken | undefined): Promise<LspLanguageClient> {
    for (;;) {
      if (token?.isCancellationRequested) {
        throw cancelled();
      }
      const state = this.current;
      switch (state.kind) {
        case 'running':
          if (this.instance?.client !== undefined) {
            return this.instance.client;
          }
          break;
        case 'stopped':
          throw unsupported(STOPPED_REASON);
        case 'failed':
          throw unsupported(`${state.reason} ${RESTART_HINT}`);
        case 'notStarted':
          await this.startFor(about);
          if (this.current.kind === 'notStarted') {
            throw unsupported('The language server was not started: its folder is not allowed to run the compiler now.');
          }
          continue;
        case 'starting':
          break;
      }
      await new Promise<void>((resolve) => {
        const subscriptions = new DisposableStore();
        const done = (): void => {
          subscriptions.dispose();
          resolve();
        };
        subscriptions.add(this.onDidChangeState(done));
        if (token !== undefined) {
          subscriptions.add(token.onCancellationRequested(done));
        }
      });
    }
  }

  async request<R>(about: vscode.Uri, method: string, params: object, token?: vscode.CancellationToken): Promise<R> {
    if (token?.isCancellationRequested) {
      throw cancelled();
    }
    if (!this.deps.trust.isTrusted) {
      throw unsupported(RESTRICTED_MODE_REASON);
    }
    if (this.disposed || !(await this.deps.ownership.admits(about))) {
      throw unsupported(NOT_SERVED_REASON);
    }
    const client = await this.running(about, token);
    return this.send<R>(client, about, method, params, token);
  }

  private async send<R>(client: LspLanguageClient, about: vscode.Uri, method: string, params: object, token: vscode.CancellationToken | undefined): Promise<R> {
    const answer = client.sendRequest<R>(method, params, token);
    const cancel =
      token === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            const subscription = token.onCancellationRequested(() => {
              subscription.dispose();
              reject(cancelled());
            });
            void answer.then(
              () => subscription.dispose(),
              () => subscription.dispose(),
            );
          });
    try {
      return await (cancel === undefined ? answer : Promise.race([answer, cancel]));
    } catch (error) {
      throw this.requestError(error, about, method);
    }
  }

  /** The rejection of a failed request (`LspClientHandle`). */
  private requestError(error: unknown, about: vscode.Uri, method: string): Error {
    if (error instanceof IdrisException || (error instanceof Error && isCancelled(error))) {
      return error;
    }
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const failure = (kind: Exclude<IdrisError['kind'], 'Unsupported' | 'NotLoaded'>, text: string): IdrisException =>
      new IdrisException({ kind, message: text });
    if (typeof code !== 'number') {
      return failure('ProtocolError', `${method} failed: ${message}`);
    }
    // vscode-jsonrpc's PendingResponseRejected and ConnectionInactive: the connection is gone.
    if (code === -32097 || code === -32096) {
      return failure('BackendCrashed', `The language server ended before answering ${method}.`);
    }
    // Reported by the middleware's request hook, which every request passes (`MiddlewareDeps.missingIpkg`).
    if (isMissingIpkgError(code, message)) {
      return failure('LoadFailed', message);
    }
    return failure('ProtocolError', `idris2-lsp answered ${method} with an error (code ${code}): ${message}`);
  }

  executeCommand<C extends LspCommandName>(
    about: vscode.Uri,
    command: C,
    args: LspCommandArguments[C],
    token?: vscode.CancellationToken,
  ): Promise<LspCommandResults[C]> {
    if (command === 'repl') {
      const refusal = replCommandRefusal((args as LspCommandArguments['repl'])[0]);
      if (refusal !== undefined) {
        return Promise.reject(unsupported(refusal));
      }
    }
    return this.request<LspCommandResults[C]>(about, 'workspace/executeCommand', { command, arguments: args }, token);
  }

  /**
   * **Idris 2 (Developer): Send Raw LSP executeCommand…**: `command` with `args` as typed, about
   * `about`, without the `repl` refusal — what a raw request can do is `commands.ts`'s comment.
   */
  rawExecuteCommand(about: vscode.Uri, command: string, args: readonly unknown[]): Promise<unknown> {
    return this.request<unknown>(about, 'workspace/executeCommand', { command, arguments: args });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation++;
    this.deps.clock.clearTimeout(this.backoffTimer);
    const instance = this.instance;
    if (instance !== undefined) {
      instance.stopping = true;
      instance.proc?.kill();
      this.release(instance);
      void instance.client?.dispose(0).catch(() => undefined);
    }
    this.store.dispose();
    this.channel?.dispose();
  }
}
