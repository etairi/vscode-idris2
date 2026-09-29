/**
 * Contracts of the IDE-mode backend (`backend/ide/*`, docs/ARCHITECTURE.md §2, §4, §5; ROADMAP
 * M2). Types only; no runtime code.
 *
 * Who implements what, and who may import whom:
 *
 * | Module | Exports | Imports from `backend/ide` |
 * |---|---|---|
 * | `sexp.ts` | the parser and serializer behind `IdeCodec` | `types.ts` |
 * | `wire.ts` | the framing behind `IdeCodec` (`FrameDecoder`, request frames) | `types.ts` |
 * | `protocol.ts` | `ideCodec: IdeCodec`; `loadFile(absolutePath): Sexp` and the other request builders and reply decoders (`:type-of`, `:docs-for`, `:name-at`, `:metavariables`, the editing commands; pinned by the F2, F29, F30 transcripts, first used in M3/M4); the F4/F5 predicates `answersWithPreviousId`, `isEndOfInputLine`; `decodeBuildingLine` | `types.ts`, `sexp.ts`, `wire.ts` |
 * | `transport.ts` | `Transport` implementations (socket, stdio) | `types.ts` |
 * | `session.ts` | the `IdeSession` state machine | `types.ts`, `transport.ts`, `protocol.ts` (the two F4/F5 predicates only) |
 * | `pool.ts` | `createSessionPool(deps: SessionPoolDeps): SessionPool` | `types.ts`, `session.ts`, `transport.ts` |
 * | `diagnostics.ts` | `Reply` of a `:load-file` → diagnostics (ARCHITECTURE §8) | `types.ts`, `protocol.ts` (`decodeBuildingLine`) |
 * | `backend.ts` | `IdeBackend implements IdrisBackend` over a `SessionPool`, and `IdeMode`, the registry's provider | `types.ts`, `protocol.ts`, `diagnostics.ts` (and `../registry` for `rootKey`, `BackendProvider`) |
 *
 * The session layer (`transport.ts`, `session.ts`, `pool.ts`) never imports `sexp.ts` or
 * `wire.ts`: it gets the codec as `SessionPoolDeps.codec`, and the composition root passes
 * `protocol.ts`'s `ideCodec`. The one exception is `session.ts`, which imports the two protocol
 * facts it applies itself, `answersWithPreviousId` (F4) and `isEndOfInputLine` (F5), from
 * `protocol.ts`, so that each fact is written once. Protocol facts therefore stay in `sexp.ts`,
 * `wire.ts`, `protocol.ts` (ARCHITECTURE §1 goal 2), and the state machine is tested with a fake
 * transport. `features/*` import none of this (ARCHITECTURE §2 naming rules); they see the backend
 * through `backend/types.ts`, `backend/registry.ts` and interfaces that `extension.ts` fills from
 * `IdeMode`. The two contracts a feature implements for this layer live in `core/`: `SessionGate`
 * (`core/trust.ts`) and `ProtocolTrace` (`core/log.ts`).
 *
 * Wire facts the types rest on (ROADMAP §0; ARCHITECTURE §5.1):
 * - A request frame is six hex digits giving the **UTF-8 byte** length of the rest, then the
 *   s-expression and `\n` (F1); `wire.ts` writes lower-case digits. The compiler reads the
 *   request one byte per `Char`, so raw non-ASCII text in a request reaches it as Latin-1 (F1
 *   addendum). Its string syntax's decimal escapes deliver the intended characters [live,
 *   2026-09-27, 0.8.0]: a `:load-file` of `…/dé/Main.idr` sent as raw UTF-8 was refused (`Source
 *   file ".../d\195\169/Main.idr" is not in the source directory ".../d\233"`), the same path
 *   written `d\233` loaded, and `\945`, `\945\&1` and `\120159` (outside the BMP) read as `α`,
 *   `α1` and `𝕟`. `sexp.ts` therefore writes every character outside U+0020–U+007E as
 *   `\<code point>` (with `\&` before a following digit), so every request is printable ASCII.
 * - A reply frame's prefix counts **code points** (F1 addendum), so the decoder counts code
 *   points of the UTF-8 text it receives; a NUL in a reply truncates it and desynchronises the
 *   stream (`test/fake-idris2/README.md`). The compiler pads the prefix to six digits but never
 *   truncates it (`leftPad`), so a reply of 16,777,216 code points or more has seven [src].
 * - Over stdio, program output, the compiler's log lines (`LOG …`, e.g. from a `%logging` pragma)
 *   and the end-of-input line `Alas the file is done, aborting` arrive unframed in the protocol
 *   stream (F5); over the socket they go to the process's stdout.
 * - Every message the compiler sends is one of `IdeMessage` (`Protocol/IDE.idr` `Reply`, the
 *   same on master 1c630e6 and v0.8.0 [src]).
 */
import type { Config, TransportKind } from '../../core/config';
import type { IDisposable } from '../../core/disposable';
import type { IdrisException } from '../../core/errors';
import type { Event } from '../../core/event';
import type { Log, ProtocolTrace } from '../../core/log';
import type { Environment } from '../../core/process';
import type { IdeReplySpan } from '../../core/positions';
import type { SessionGate, WorkspaceTrust } from '../../core/trust';
import type { Classification, ProjectIndex } from '../../project/types';
import type { ToolchainService } from '../../toolchain/types';

// -------------------------------------------------------------------------------------------
// S-expressions (`Protocol/SExp.idr`, `Protocol/SExp/Parser.idr` on v0.8.0, identical on master
// 1c630e6 apart from imports [src])
// -------------------------------------------------------------------------------------------

/**
 * The compiler's `SExp`: a list, a string, `:True`/`:False`, an integer (arbitrary precision,
 * digits only — the parser has no sign, and ids such as `99999999999999999999` are echoed
 * unchanged, `test/fake-idris2/README.md`), or a symbol `:name`.
 */
export type Sexp = SexpList | SexpString | SexpBool | SexpInteger | SexpSymbol;

export interface SexpList {
  readonly kind: 'list';
  readonly items: readonly Sexp[];
}

/** The decoded string: escapes removed on parsing, `"` and `\` escaped again on serializing. */
export interface SexpString {
  readonly kind: 'string';
  readonly value: string;
}

/** `:True` / `:False`, which the compiler's parser reads before any other symbol. */
export interface SexpBool {
  readonly kind: 'bool';
  readonly value: boolean;
}

export interface SexpInteger {
  readonly kind: 'integer';
  readonly value: bigint;
}

/** `:name`; `name` is written without the colon. */
export interface SexpSymbol {
  readonly kind: 'symbol';
  readonly name: string;
}

/**
 * Text put into a request verbatim: `(<text> <id>)` is framed and sent without being parsed
 * first. Only **Idris 2 (Developer): Send Raw Protocol Request…** uses it, so that malformed
 * requests (F4) can be sent too.
 */
export interface RawCommand {
  readonly kind: 'raw';
  readonly text: string;
}

/**
 * The command part of a request `(COMMAND ID)`: a list such as `(:load-file "…")`, or a bare
 * symbol for `:version`, `:proof-search-next` and `:generate-def-next` (F4: `((:version) 7)` is an
 * unrecognised command).
 */
export type IdeCommand = Sexp | RawCommand;

// -------------------------------------------------------------------------------------------
// Frames (`wire.ts`)
// -------------------------------------------------------------------------------------------

/** A request frame ready to be written. */
export interface OutgoingFrame {
  /** The frame as text: the six-digit prefix, the s-expression and `\n` (for the trace). */
  readonly text: string;
  /** The frame as UTF-8 bytes; the prefix is the byte length of everything after it (F1). */
  readonly bytes: Uint8Array;
}

/**
 * What the frame decoder cuts from the compiler's output stream:
 * - `framed` — a reply frame: `text` is its payload after the prefix (the s-expression and its
 *   `\n`), exactly as many code points as the prefix says (F1 addendum); in a stream whose line
 *   ends were written as `\r\n` without changing the prefix, the `\r` so inserted is not part of
 *   the text (`wire.ts`, "Line ends");
 * - `unframed` — bytes that are not a frame: a line that does not start with a header (six to
 *   eight lower-case hex digits, `(` and a reply head such as `:return `), read up to the end of
 *   that line or up to a reply header after it; output of one or two hex digits that ran into
 *   the next header (over stdio: program output, the compiler's log lines, the end-of-input
 *   line; F5); or, from `FrameDecoder.end`, a last line without its `\n`;
 * - `truncated` — the stream ended inside a frame (`FrameDecoder.end`: fewer code points than its
 *   prefix says, or a header whose reply head is incomplete; on a stream of frames only, whatever
 *   was left); `text` is what was held, header included. The process has ended or is ending:
 *   `Transport.onExit` follows.
 * - `overflow` — never from the decoder: the transport gave up on a stream that held more than
 *   its bound without a complete item, while the process still ran; `text` is what was held. The
 *   transport stops the process.
 * `byteLength` is the number of bytes of the stream the item took, prefix included.
 */
export type IncomingFrame =
  | { readonly kind: 'framed'; readonly text: string; readonly byteLength: number }
  | { readonly kind: 'unframed'; readonly text: string; readonly byteLength: number }
  | { readonly kind: 'truncated'; readonly text: string; readonly byteLength: number }
  | { readonly kind: 'overflow'; readonly text: string; readonly byteLength: number };

/** How a stream is to be read (`IdeCodec.createFrameDecoder`). */
export interface FrameDecoderOptions {
  /**
   * The stream carries nothing but frames — the socket (F5): at the start of an item, 6 to 8 hex
   * digits and `(` are a frame's header whatever its head (a reply of a newer compiler is still
   * read, and then ignored as a message of an unknown shape), and whatever is left at the end of
   * the stream is `truncated`. Without it (stdio) a header also needs one of the six reply heads,
   * and program output can precede it (`wire.ts`).
   */
  readonly framesOnly?: boolean;
}

/** A streaming decoder for one output stream (one per process); chunks may split anywhere. */
export interface FrameDecoder {
  /** The items completed by `chunk`, in stream order (`framed` or `unframed`). */
  push(chunk: Uint8Array): IncomingFrame[];
  /** At the end of the stream: what is left, as one `truncated` or `unframed` item, if anything (`FrameDecoderOptions`). */
  end(): IncomingFrame[];
}

// -------------------------------------------------------------------------------------------
// Messages (`protocol.ts`; `Protocol/IDE.idr` `Reply`, `ReplyPayload` [src])
// -------------------------------------------------------------------------------------------

/**
 * One span of highlighting metadata `(START LENGTH PROPERTIES)` after a reply's string, e.g.
 * `(5 4 ((:decor :type)))` in `(:ok "xs : Vect ?_ ?_" ((5 4 ((:decor :type)))))` (F30). The
 * properties are kept as sent; `protocol.ts` maps them to `backend/types.ts` `Decor` (M3).
 */
export interface HighlightSpan {
  /** Offset into the reply's string. */
  readonly start: number;
  readonly length: number;
  readonly properties: Sexp;
}

/** `ReplyPayload`: what a `:return` or `:output` carries. */
export type ReplyPayload =
  /** `(:ok RESULT [HL])`; `RESULT` is `()` for a load (F7), a string, a list, … by command. */
  | { readonly kind: 'ok'; readonly result: Sexp; readonly highlighting: readonly HighlightSpan[] }
  /** `(:ok (:highlight-source (…)))`: highlighting of a loaded file (F33; decoded in M3). */
  | { readonly kind: 'highlight-source'; readonly highlights: Sexp }
  /** `(:error MESSAGE [HL])` */
  | { readonly kind: 'error'; readonly message: string; readonly highlighting: readonly HighlightSpan[] };

/**
 * `(:warning (FILE (L C) (L C) MESSAGE [HL]) ID)` (F6): a problem found while loading. It has no
 * severity (F7); `diagnostics.ts` derives one (ARCHITECTURE §8, D9).
 */
export interface WarningReport {
  /** As sent: relative to the session's working directory (F6), or absolute. */
  readonly file: string;
  /** 0-based, end exclusive, unlit columns in bird-track files (F2, F11); convert with `core/positions.ts`. */
  readonly span: IdeReplySpan;
  /** The message, a blank line, `Mod:l:c--l:c`, the source excerpt, maybe `Missing cases:` (F6). */
  readonly message: string;
  readonly highlighting: readonly HighlightSpan[];
}

/** One message from the compiler, decoded. Ids are the request ids the compiler echoes. */
export type IdeMessage =
  /** `(:protocol-version MAJOR MINOR)`, the first message of a session (`2 1` on 0.8.0). */
  | { readonly kind: 'protocol-version'; readonly major: number; readonly minor: number }
  /** `(:return PAYLOAD ID)`: the end of the request `ID` (or, F4, of the one being processed). */
  | { readonly kind: 'return'; readonly id: bigint; readonly payload: ReplyPayload }
  /** `(:output PAYLOAD ID)`: intermediate output, in practice `:highlight-source`. */
  | { readonly kind: 'output'; readonly id: bigint; readonly payload: ReplyPayload }
  /** `(:write-string TEXT ID)`: e.g. `1/2: Building Foo.A (src/Foo/A.idr)`, or a stub's notice (F3). */
  | { readonly kind: 'write-string'; readonly id: bigint; readonly text: string }
  /** `(:set-prompt TEXT ID)` */
  | { readonly kind: 'set-prompt'; readonly id: bigint; readonly text: string }
  | { readonly kind: 'warning'; readonly id: bigint; readonly warning: WarningReport };

/**
 * A frame's text decoded: a known `message`; an `unknown` s-expression (well-formed, but not one
 * of the shapes above, e.g. from a newer compiler), with `returnId` set when it is a list headed
 * by `:return` whose last element is an integer — a `:return` whose payload this extension cannot
 * read, which still ends the request with that id — and `handshake` set when it is a list headed
 * by `:protocol-version` (a handshake of another shape, e.g. `(:protocol-version 3 0 1)`); or
 * `invalid` text that is not one s-expression (with the parser's reason).
 */
export type DecodedMessage =
  | { readonly kind: 'message'; readonly message: IdeMessage }
  | { readonly kind: 'unknown'; readonly sexp: Sexp; readonly returnId?: bigint; readonly handshake?: true }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Everything the session layer needs from `sexp.ts`, `wire.ts` and `protocol.ts`, injected so
 * that the layers are built and tested independently. `protocol.ts` exports the implementation
 * as `ideCodec`.
 */
export interface IdeCodec {
  /**
   * `(COMMAND ID)` serialized and framed (F1); a bare-symbol command stays bare (F4). Throws a
   * `RangeError` for what the compiler could not be sent: a request above 0xffffff bytes (six
   * digits), a string containing NUL, a negative integer, or a symbol that is not a name (or is
   * `True`/`False`). The session rejects that one request with the error.
   */
  encodeRequest(command: IdeCommand, id: bigint): OutgoingFrame;
  /** A fresh decoder for one process's output stream. */
  createFrameDecoder(options?: FrameDecoderOptions): FrameDecoder;
  /** Parses one frame's text (`IncomingFrame.text` of a `framed` item) and decodes it. */
  decodeMessage(text: string): DecodedMessage;
}

// -------------------------------------------------------------------------------------------
// Transport (`transport.ts`)
// -------------------------------------------------------------------------------------------

/**
 * The command line of a session process, as the pool computes it (ARCHITECTURE §5.2): the
 * compiler of the current toolchain snapshot, `--ide-mode-socket` or `--ide-mode`, `--no-color`,
 * `-p <pkg>` for each of `idris2.ideMode.loosePackages` (loose files only), `--build-dir
 * <effectiveCheckBuildDir>` when isolating (D5, F12), then `idris2.ideMode.extraArgs`. Never
 * `--find-ipkg` (F13).
 */
export interface SessionLaunch {
  /** Absolute path of `idris2` (the snapshot's `probed` location). */
  readonly executable: string;
  readonly args: readonly string[];
  /** `ProjectIndex.sessionCwd(root)`: the `.ipkg`'s directory, or a loose file's (D4). */
  readonly cwd: string;
  /**
   * The real path of `cwd` that the consent gate judged last before the spawn
   * (`SessionGate.recheck`, `GateVerdict.realDir`): the process is started there, so that a
   * symbolic link on `cwd` re-pointed after that verdict cannot move it (`pool.ts`; POSIX only). Unset: in `cwd`.
   * Not itself part of the command line (`launchDifferences`), but the isolated `--build-dir` is
   * placed in it (`sessionLaunch`'s `buildBase`), and the pool compares a running session's
   * command line with one built on the same real path.
   */
  readonly realCwd?: string;
  /** The variables overlaid on the Extension Host's environment: the snapshot's `idris2.toolchain.env`. */
  readonly env: Readonly<Record<string, string>>;
  readonly transport: TransportKind;
}

/** How a session process ended. */
export interface TransportExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process could not be started (e.g. `ENOENT`, a refused `.cmd` command line). */
  readonly spawnError?: string;
  /**
   * Set when the compiler closed the socket transport's connection while its process still ran
   * (not after `Transport.stop`); the transport then stopped the process, so `signal` is usually
   * the transport's own.
   */
  readonly connectionClosed?: boolean;
}

/**
 * One session process and its protocol stream. Every process is started through
 * `core/process.ts` (the M1 rule: fully qualified executable and working directory, no shell but
 * the documented `.cmd`/`.bat` path, nothing while the workspace is untrusted, and the process
 * group stopped on `stop`/`dispose`).
 *
 * - `socket`: spawns `idris2 --ide-mode-socket …`, reads the port from the first stdout line
 *   that is a port, connects to `127.0.0.1:<port>`; the protocol stream is the socket, and every
 *   other line the process prints on stdout, before or after the port line, is `onStdout` (F5).
 * - `stdio`: spawns `idris2 --ide-mode …`; the protocol stream is the process's stdout, so
 *   `onStdout` never fires and program output arrives as `unframed` items (F5).
 *
 * `start` has no time limit of its own: the session's handshake limit, counted from `start`,
 * covers the port line and the connection too. When the protocol stream ends while the process
 * still runs (the socket closed), the transport stops the process, so that `onExit` always ends
 * a transport's life.
 */
export interface Transport extends IDisposable {
  readonly kind: TransportKind;
  readonly launch: SessionLaunch;
  /** Starts the process (and connects); resolves once `send` may be called, rejects if it cannot. */
  start(): Promise<void>;
  /** Writes one request frame's bytes to the protocol stream. */
  send(bytes: Uint8Array): void;
  /**
   * How many bytes of the protocol stream have arrived, also those of an item not complete yet (on
   * the socket: proof that the compiler serves this connection, `session.ts`).
   */
  readonly receivedBytes: number;
  /** Stops the process group; `onExit` follows. `dispose` does the same without waiting. */
  stop(): void;
  readonly onFrame: Event<IncomingFrame>;
  /** Process stdout outside the protocol stream, decoded as UTF-8 (socket transport only). */
  readonly onStdout: Event<string>;
  readonly onStderr: Event<string>;
  /** Fires once, when the process has ended (or could not be started). */
  readonly onExit: Event<TransportExit>;
}

// -------------------------------------------------------------------------------------------
// Sessions (`session.ts`, ARCHITECTURE §5.1)
// -------------------------------------------------------------------------------------------

/**
 * The roles of ARCHITECTURE §4: `check` loads saved files and answers position requests (M2).
 * `eval` (M3) and `shadow` (M6) are added by the milestones that need them.
 */
export type SessionRole = 'check';

/**
 * ARCHITECTURE §5.1:
 * - `stopped` — no process: not started yet, or stopped (Stop Backend, idle, the root's last
 *   document closed, `idris2.ideMode.maxSessions` exceeded, consent revoked, dispose). The next
 *   request starts one, after
 *   `SessionGate.permit` allows it; while the gate's question is open the session stays
 *   `stopped`.
 * - `starting` — spawned, waiting for `(:protocol-version 2 x)`; at most 10 s from `start`.
 * - `ready` — no request in flight. `busy` — one request in flight (never more: F5 socket).
 * - `restarting` — the process died, timed out or broke the protocol; a new one starts after a
 *   backoff that grows with the crashes (0 s, 2 s, 10 s).
 * - `failed` — gave up: a fourth unexpected end (exit, time-out, protocol error) within five
 *   minutes, after three automatic restarts (0 s, 2 s, 10 s); a protocol version other than 2.x,
 *   or a handshake that cannot be read;
 *   a socket process that ended or ran out of time after this extension had connected but before
 *   anything arrived on its connection (another program may have taken it, ROADMAP Q20); or a
 *   process that could not be started. Requests are rejected until `restart`, a stop, or a change
 *   of the settings or of the toolchain. (`session.ts` explains this reading of ARCHITECTURE
 *   §5.1, which gives the backoff steps and the give-up count without relating them.)
 */
export type SessionState = 'stopped' | 'starting' | 'ready' | 'busy' | 'restarting' | 'failed';

/**
 * What caused a state change:
 * `start` (a request, or `restart`, needed a process), `handshake` (the protocol version was
 * accepted or refused, could not be read, or never arrived on a connected socket), `dispatch` / `reply` (`ready` ⇄
 * `busy`), `exit` (the process ended unexpectedly, also in the middle of a frame), `spawnError` (the
 * process could not be started; also, with `stopped`, a restart the gate refused because the session
 * directory's real path could not be read),
 * `timeout` (a request or the handshake exceeded its limit; the process was stopped),
 * `protocolError` (a frame that cannot be attributed or read, more output than the transport
 * holds without a complete frame, or unframed bytes on the socket, where the compiler writes only
 * frames), `backoff` (`restarting` → `starting`), `gaveUp`, `stop` (Stop
 * Backend; also announced when the session was already `stopped`, e.g. while its consent question
 * was open), `idle`, `closed` (the root's last open document was closed, `SessionPool.release`),
 * `evicted` (more sessions ran than `idris2.ideMode.maxSessions` allows, and this idle one was the
 * least recently used that is not the active document's, ROADMAP §9 Q21),
 * `restart` (Restart Backend), `reconfigure` (the pool restarted a running session because its
 * command line changed — a setting, a toolchain scan, the package — or returned a `failed` one to
 * `stopped` for that reason), `consentRevoked`, `packageChanged` (the root's package file is not
 * the one the compiler would find from the session directory any more, `SessionPool.packageChanged`),
 * `dispose`.
 */
export type SessionCause =
  | 'start'
  | 'handshake'
  | 'dispatch'
  | 'reply'
  | 'exit'
  | 'spawnError'
  | 'timeout'
  | 'protocolError'
  | 'backoff'
  | 'gaveUp'
  | 'stop'
  | 'idle'
  | 'closed'
  | 'evicted'
  | 'restart'
  | 'reconfigure'
  | 'consentRevoked'
  | 'packageChanged'
  | 'dispose';

export interface SessionStateChange {
  readonly previous: SessionState;
  readonly state: SessionState;
  readonly cause: SessionCause;
  /** One sentence for the log and notifications, e.g. the exit code and the last stderr line. */
  readonly detail?: string;
}

/**
 * The part of `vscode.CancellationToken` the session uses (a `vscode.CancellationToken` is one),
 * so that `session.ts` needs no runtime `vscode`.
 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<unknown>;
}

/**
 * Which time limit applies (ARCHITECTURE §5.1): `lookup` → `idris2.ideMode.requestTimeout`;
 * `longAction` (`:proof-search`, `:generate-def`) and `load` (`:load-file`) →
 * `idris2.ideMode.longActionTimeout`. The limit counts from the moment the request is sent.
 */
export type RequestKind = 'lookup' | 'longAction' | 'load';

/** The file of a `:load-file` request (ARCHITECTURE §5.1 "Loaded-file tracking"). */
export interface LoadedFile {
  /** Absolute file-system path, as sent in `:load-file`. */
  readonly path: string;
  /** The document version that was on disk when the load was requested, if known. */
  readonly version?: number;
}

interface RequestOptionsBase {
  /** Overrides the kind's time limit, in ms. */
  readonly timeoutMs?: number;
  /**
   * Cancelling before the request is sent removes it from the queue (a `beforeSend` of it that runs
   * is abandoned, and the next request goes on at once). After it has been sent the
   * compiler cannot be interrupted (the protocol has no cancel): the reply is awaited and
   * dropped. Either way the promise rejects at once with an `Error` whose `name` is `Cancelled`;
   * a caller that cancels checks its own token rather than the error.
   */
  readonly token?: CancellationToken;
  /**
   * Runs when the request is the next to be sent to a process that has answered the handshake,
   * before it is written — again for each new process it would go to. While it runs the requests
   * behind it wait; when it rejects, nothing is sent and the request rejects with its error. It
   * has the request's own time limit (`timeoutMs`, else the kind's): a check that has not settled
   * by then rejects the request with `LoadFailed`, nothing is sent, and the requests behind it go
   * on (its late result is ignored).
   * When loads are merged, only the newest caller's check decides: one of an older caller's that
   * is still running is ignored, whether it settles before or after the newer one.
   * `backend.ts` walks for the package here, because the compiler walks at the `:load-file` it is
   * about to receive (F13).
   */
  readonly beforeSend?: () => Promise<void>;
  /**
   * Asked each time the session chooses the next request to send: while it returns true, this
   * request goes before the others waiting, in queue order among such requests — never before the
   * one in flight, nor before one whose `beforeSend` runs or has passed for the process, so that no
   * walk is separated from its write. When loads are merged, the newest caller's decides. A function
   * that throws reads as false. The checks set it for the active document's load (ROADMAP §9 Q21,
   * `idris2.ideMode.maxBackgroundChecks`).
   */
  readonly urgent?: () => boolean;
}

/** A request that is not a `:load-file`. */
export interface LookupRequestOptions extends RequestOptionsBase {
  readonly kind: 'lookup' | 'longAction';
}

/**
 * A `:load-file` of `file`. A `load` of the same `file.path` still waiting in the queue is merged
 * with this one: one `:load-file` is sent (for the newer version) and every caller gets its
 * reply. When it returns, `IdeSession.loadedFile` is `file`.
 */
export interface LoadRequestOptions extends RequestOptionsBase {
  readonly kind: 'load';
  readonly file: LoadedFile;
}

export type RequestOptions = LookupRequestOptions | LoadRequestOptions;

/**
 * The end of one request: its `:return`, and every message the compiler sent for it before
 * that, in order (`:write-string`, `:warning`, `:output`/`:highlight-source`, `:set-prompt`). A
 * `(:return (:error …))` is a reply, not a failure of the request.
 */
export interface Reply {
  /** The id the request was sent with. */
  readonly id: bigint;
  readonly payload: ReplyPayload;
  readonly messages: readonly IdeMessage[];
  /**
   * Set when the `:return` carried another id and was attributed to this request, which the
   * session does only for an error starting `Unrecognised command` or `Parse error` (F4: the
   * compiler tags an unparseable request with the id of the last request it recognised).
   */
  readonly returnedId?: bigint;
}

/**
 * One IDE-mode process role for one root (ARCHITECTURE §5.1). Obtained from
 * `SessionPool.sessionFor`; the pool owns and disposes it.
 *
 * `request` resolves with the `Reply` and rejects with an `IdrisException` (`core/errors.ts`)
 * when the request cannot be answered: `RequestTimeout` (the process was stopped and every
 * queued request rejected too; the session restarts, unless that was the fourth unexpected end
 * within five minutes), `BackendCrashed` (the process ended, the session was stopped or
 * restarted, or it is `failed`), `ProtocolError`, `ToolchainMissing` (no `probed` idris2 in the
 * current snapshot), `Unsupported` (the gate refused: Restricted Mode, or the directory is not
 * allowed; the reason says which and how to allow it) — or with the `Cancelled` error above.
 * Requests wait in one FIFO queue and are sent one at a time; requests made while the session
 * is `starting` or `restarting` wait for it. Before it starts a process, a session waits for a
 * toolchain scan that is running (or for the first snapshot), so that it starts the `idris2` the
 * settings name now.
 */
export interface IdeSession {
  readonly role: SessionRole;
  /** The root it serves, as last given to `SessionPool.sessionFor`. */
  readonly root: Classification;
  /** `ProjectIndex.sessionCwd(root)`. */
  readonly cwd: string;
  readonly state: SessionState;
  readonly onDidChangeState: Event<SessionStateChange>;
  /** The command line of the current process; `undefined` while `stopped` or `failed` without one. */
  readonly launch: SessionLaunch | undefined;
  /** The `(:protocol-version …)` of the current process, once received. */
  readonly protocolVersion: { readonly major: number; readonly minor: number } | undefined;
  /** The file of the last `load` that returned in the current process; cleared when it ends. */
  readonly loadedFile: LoadedFile | undefined;
  request(command: IdeCommand, options: RequestOptions): Promise<Reply>;
}

// -------------------------------------------------------------------------------------------
// The pool (`pool.ts`, ARCHITECTURE §4, §5)
// -------------------------------------------------------------------------------------------

/** A state change of one of the pool's sessions. */
export interface SessionPoolChange {
  readonly session: IdeSession;
  readonly change: SessionStateChange;
}

/**
 * The sessions of every root, by role; one per root and role. Roots are told apart by
 * `rootKey` (`backend/registry.ts`), so all loose files of one directory share a session (D4).
 *
 * The pool itself restarts the running sessions (`starting`, `ready`, `busy`) whose command line
 * would change — when `idris2.ideMode.*` changes, when a toolchain snapshot names another
 * `idris2` or environment, and when `sessionFor` is given a classification of the same root
 * whose launch differs (e.g. the `.ipkg` gained a `builddir`) — and returns `failed` sessions to
 * `stopped` on the first two (ARCHITECTURE §5.1 "Configuration changes", as built:
 * docs/as-built/M2.md, *Configuration changes*, and `pool.ts`). Sessions stop themselves after `idris2.ideMode.idleTimeout`; the pool stops those
 * whose directory `SessionGate.current` no longer allows, and, while more run than
 * `idris2.ideMode.maxSessions` (when it is not 0) allows, the least recently used idle ones that
 * are not the active root's (cause `evicted`; ROADMAP §9 Q21). `dispose` stops every process at
 * once (deactivation).
 */
export interface SessionPool extends IDisposable {
  /**
   * The session of `role` for `root`, created (in `stopped`) if there is none. No process starts
   * here: the first request starts one, after the gate allows it.
   */
  sessionFor(root: Classification, role: SessionRole): IdeSession;
  /** Every session the pool holds, in no particular order. */
  sessions(): readonly IdeSession[];
  /**
   * D5, F32: `<root>/<build>/.vscode-idris2` when `idris2.ideMode.isolateBuildDir` is on and the
   * root has no `builddir` (a loose file never has one; nor has a root whose `.ipkg` could not be
   * read), else `<root>/<builddir or build>`; `<root>` is `sessionCwd(root)` — on POSIX, while the
   * root's `check` session has a process, the real path it was started in (`SessionLaunch.realCwd`),
   * where the compiler resolves a relative `builddir` and the isolated one is placed — and a
   * relative `builddir` is resolved against it. The one place this is computed (M6, M9 read it here).
   */
  effectiveCheckBuildDir(root: Classification): string;
  /** Stops the sessions of `root`, or of every root; each starts again on its next request. */
  stop(root?: Classification): void;
  /**
   * Stops the sessions of `root` because no open document needs them: its last one was closed
   * (ARCHITECTURE §5.1). Unlike `stop`, the cause is `closed`, which the status item does not
   * report as `stopped`; the next request starts a process again.
   */
  release(root: Classification): void;
  /**
   * Stops the sessions of `root` because the compiler, walking up from the session directory, would
   * no longer find the root's package file (it was removed or renamed, or another one comes first):
   * at its next load it would change into another package's folder and stay there (`backend.ts`).
   * The cause is `packageChanged`, which the status item does not report as `stopped`; `detail`
   * says what the walk found. The next request starts a process again, after the gate.
   */
  packageChanged(root: Classification, detail: string): void;
  /** Stops the sessions of `root` and starts its `check` session again now (clears `failed`). */
  restart(root: Classification): void;
  /** Restarts every session that is not `stopped` (clears `failed`). */
  restartAll(): void;
  /**
   * The root of the active document (`features/diagnostics/checks.ts` decides which that is), or
   * `undefined` for none: its sessions are never stopped to keep within
   * `idris2.ideMode.maxSessions`. `pending` while the active document's root is still being found:
   * no session is stopped for the limit then. A change applies that limit again at once.
   */
  setActiveRoot(root: Classification | 'pending' | undefined): void;
  /**
   * What would keep a session from starting before the consent question is asked, as it stands now
   * (after a running toolchain scan): Restricted Mode (`Unsupported`), no working `idris2`
   * (`ToolchainMissing`), an `idris2.ideMode.extraArgs` that names `--ide-mode` or
   * `--ide-mode-socket` (`BackendCrashed`); `undefined` when none does. The same checks, in the same
   * order, open every spawn's preparation (`pool.ts` `prepare`). Starts and asks nothing.
   */
  startProblem(): Promise<IdrisException | undefined>;
  readonly onDidChange: Event<SessionPoolChange>;
}

/** What `createSessionPool` needs; `extension.ts` supplies the real ones. */
export interface SessionPoolDeps {
  /** The `idris2` to start (a `probed` location) and `idris2.toolchain.env`, from the current snapshot. */
  readonly toolchain: Pick<ToolchainService, 'current' | 'scanning' | 'onDidChange'>;
  readonly projects: Pick<ProjectIndex, 'sessionCwd'>;
  readonly config: Pick<Config, 'ideMode' | 'onDidChange'>;
  /** Restricted Mode: nothing is started (also refused by `core/process.ts`). */
  readonly trust: WorkspaceTrust;
  /** Consulted before every spawn; see `core/trust.ts`. */
  readonly gate: SessionGate;
  /** `ideCodec` from `protocol.ts`. */
  readonly codec: IdeCodec;
  readonly trace: ProtocolTrace;
  readonly log: Log;
  /** `process.platform`: the path rules of the build directory and of the working directory (`pool.ts`). */
  readonly platform: NodeJS.Platform;
  /** `process.env` of the Extension Host; the launch's `env` is overlaid on it. */
  readonly processEnv: Environment;
}
