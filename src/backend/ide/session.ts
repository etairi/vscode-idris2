/**
 * The `IdeSession` state machine (docs/ARCHITECTURE.md §5.1; ROADMAP M2): one IDE-mode process
 * role for one root. `pool.ts` creates the sessions and gives each what it needs: `prepare`
 * (trust, toolchain, consent, then the command line), the transport factory, the codec and the
 * time limits. The contract is `IdeSession` in `types.ts`; the rules as built:
 *
 * - **States.** `stopped` → (a request, or a restart) → `starting` → handshake → `ready` ⇄ `busy`;
 *   an unexpected end → `restarting` → (backoff) → `starting`; gave up → `failed`. Before every
 *   spawn — the first, after a stop, after a crash — `prepare` runs; while it waits (for a
 *   running toolchain scan, or for the user's answer to the consent question) the state stays
 *   what it was (`stopped` or `restarting`). A refusal rejects the waiting requests with its
 *   error (`Unsupported`, `ToolchainMissing`); at a restart, an `Unsupported` refusal stops the
 *   session — with cause `consentRevoked`, or `spawnError` when the gate could not read the
 *   directory's real path (`SpawnPlan.unresolved`: it is gone, which is no revocation) — and a
 *   missing compiler makes it `failed` (`spawnError`). A new
 *   process is spawned only after the previous one has ended (`onExit`), so a root never has two.
 * - **Handshake.** The first message must be `(:protocol-version MAJOR MINOR)` within
 *   `handshakeTimeoutMs` (10 s) of `Transport.start` (the limit covers the process start too; a
 *   wrapper such as pack's `idris2`, which runs pack before the compiler, F22, spends part of
 *   it). Major 2 is accepted, and a minor above 1 with a warning on the change to `ready` (the
 *   pool logs it once per version); any other major fails the session: 1 is Idris 1's protocol
 *   (landscape §2.2), and a new major means an incompatible protocol (ROADMAP §7.4: "must be
 *   `2.x`"). So does a first message headed `:protocol-version` of another shape (e.g.
 *   `(:protocol-version 3 0 1)`, `DecodedMessage.handshake`), at once: a handshake arrived that
 *   this extension cannot read, and waiting for the time limit would only misreport it.
 * - **One request in flight** (F5: a request pipelined on the socket is dropped), the others in
 *   one first-in, first-out queue, with one exception: a request that is `urgent`
 *   (`RequestOptions.urgent`, asked each time the next request is chosen) goes before the others
 *   waiting, queries included (`IdeBackend.ask` refuses a query whose answer is kept per load —
 *   `typeAt`, `docsFor`, `definition` — when an urgent reload replaced that load; completions and
 *   namespace listings are answered from the newer load), but never before the one in flight, nor
 *   before one whose `beforeSend` check runs or
 *   has passed for the process (that check and the write stay one step, *Consent* in docs/as-built/M2.md).
 *   The checks mark the active document's load so while `idris2.ideMode.maxBackgroundChecks` is
 *   above 0 (ROADMAP §9 Q21); without it the queue is first-in, first-out. A cancellation token
 *   removes a waiting request from the queue (a `beforeSend` check of it that runs is abandoned,
 *   its result ignored, and the next request goes on at once); after the
 *   request was sent the compiler cannot be interrupted, so its reply is awaited and dropped
 *   (the next request waits for it, and its time limit still applies). Either way the caller's
 *   promise rejects at once with an `Error` named `Cancelled` (`core/errors.ts` `cancelled`), as
 *   do the requests a stop or a restart abandons (below).
 * - **`:load-file` de-duplication.** A `load` of a file that is already waiting in the queue is
 *   merged into that entry: one `:load-file` is sent, with the newer command, version and time
 *   limit, at the older entry's place in the queue, and every caller gets its reply. A load of a
 *   file that is in flight is queued (the file changed after it was sent).
 * - **Time limits** count from the moment a request is sent: `requestTimeoutMs` for `lookup`,
 *   `longActionTimeoutMs` for `longAction` and `load` (read from the settings for each request),
 *   or the request's own `timeoutMs`. The protocol has no cancel, so a request that exceeds its
 *   limit stops the process: it rejects with `RequestTimeout`, and so does every request waiting
 *   behind it (ARCHITECTURE §5.1: "rejects the queue"); the session restarts. The same limit
 *   bounds the request's `beforeSend` check, from the moment it starts (`checkBeforeSend`): a
 *   check still running then rejects that request only, with `LoadFailed`; nothing was sent, so
 *   the process is kept and the requests behind it go on.
 * - **Messages** are attributed by id. `:write-string`, `:warning`, `:output` and `:set-prompt`
 *   with the in-flight id are collected into the `Reply`; `:return` with it completes the
 *   request. A `:return` with another id is attributed to the in-flight request only when it is
 *   `(:error "Unrecognised command: …")` or `(:error "Parse error: …")` (`protocol.ts`
 *   `answersWithPreviousId`) and its id is the id of the last request this process recognised
 *   (0 before the first): the compiler tags a request it cannot read with that id (F4;
 *   `printIDEError outf idx …` with the id `updateOutput` last set, `src/Idris/IDEMode/REPL.idr`
 *   on v0.8.0 [src], and `handshake.jsonl` [live]). Any other mismatch, a message while nothing
 *   is in flight, a frame that is not an s-expression, more output than the transport holds
 *   without a complete frame (`overflow`), and — on the socket, where the compiler writes nothing
 *   but frames — unframed bytes are a protocol error: the raw text is logged, the in-flight
 *   request rejects with `ProtocolError`, and the session restarts. A stream that ends inside a
 *   frame (`truncated`) is no protocol error of its own: the process has ended (or is being
 *   stopped because the compiler closed its socket), and `onExit`, which follows, reports the
 *   end with its exit code, its last stderr line and the incomplete frame. A well-formed message
 *   of an unknown shape (a newer compiler) is logged and ignored, except a `:return` with the
 *   in-flight id whose payload cannot be read (`DecodedMessage.returnId`): it ends that request
 *   at once with a `ProtocolError`, and the process, still in step, is kept.
 * - **Unread highlighting** (`eval` sessions; third review of M3). An `eval` session's load
 *   serves only its evaluation, which reads the load's `:return` and `:warning` frames, never its
 *   highlighting, so a `:highlight-source` frame with the in-flight id (`IdeCodec.highlightSourceId`,
 *   read from the frame's start and end) is dropped without being parsed: parsing the 16,654 frames
 *   of one load of the e2e suite's 2,000-line module took 77 ms of the extension host's thread at
 *   every evaluation [unit-level, the reviewer's offline run on the recorded frames]. Such a frame is
 *   not checked for being an s-expression. `check` sessions parse every frame.
 * - **Program output.** Over stdio every unframed item — a complete line, or the text before a
 *   reply glued to it (`wire.ts`) — is the process's own output in the protocol stream (F5): the
 *   compiler's log lines (`LOG <topic>:<level>: …`, which `logString` writes with `putStrLn` to
 *   stdout, `src/Core/Context/Log.idr` 16–20 on v0.8.0 [src]; a `%logging` pragma in a loaded
 *   file prints them in the middle of a `:load-file` [live, transcript `load-logging`]), program
 *   output (`:exec`), and the end-of-input line `Alas the file is done, aborting` (`protocol.ts`
 *   `isEndOfInputLine`). Each goes to the trace and to the log at debug level, like the socket
 *   transport's stdout, and the last lines are kept for the message when the process ends.
 * - **Unexpected ends** — the process exits, a time limit expires (handshake or request), or a
 *   protocol error — reject the in-flight request (`BackendCrashed`, `RequestTimeout`,
 *   `ProtocolError`) and restart the process; the other waiting requests stay queued for the new
 *   one, except after a request time-out (above). An `eval` session (M3) is not restarted: it is
 *   `stopped` with the cause of the end, every waiting request rejects (`BackendCrashed`), and the
 *   next evaluation starts a process — so that no evaluation process runs, for up to its idle limit,
 *   that no evaluation asked for, and a runaway evaluation's time-out does not start one at once
 *   (*review of M3*). A process that cannot be started at all (`spawnError`) makes the session
 *   `failed` at once.
 * - **A socket taken by another program** (ROADMAP §9 Q20; the socket is an opt-in in user settings
 *   since 2026-09-28, stdio the default). `--ide-mode-socket` serves the first
 *   connection to its port and never checks who made it (`initIDESocketFile`,
 *   `src/Idris/IDEMode/REPL.idr` 50–76 on v0.8.0 [src]); a later connection still completes, in
 *   the listen backlog, and receives nothing [live, 2026-09-27]. So when this extension has
 *   connected (`Transport.start` resolved), nothing at all has arrived on its connection (any
 *   byte, even of an item it cannot read or one not complete yet, proves the compiler serves this
 *   connection, `Transport.receivedBytes`), and either
 *   the handshake time limit expires with the connection unanswered for at least
 *   `UNANSWERED_CONNECTION_MS` (2 s), or the process ends after the connection had been
 *   unanswered that long or after printing the end-of-input line (the compiler prints it when the
 *   client it serves closes its connection, `getChar`, `REPL.idr` 78–83 [src]), another program on
 *   this computer may have had the session: the process is stopped, the session is `failed`
 *   (cause `handshake`) with a warning that says so, and it is **not** restarted automatically, so
 *   such a program gets no further tries until the user restarts it. The compiler sends the
 *   handshake right after `accept` (`replIDE`, `REPL.idr` 499–511 [src]), so an honest process
 *   gives no cause for this. A process that ends sooner, without that line, is an ordinary crash
 *   and is restarted: a compiler that cannot wrap the accepted socket prints `Failed to fdopen
 *   socket file descriptor` and exits with code 1 right after `accept` (`socketToFile`,
 *   `REPL.idr` 40–46; `Driver.idr` 216–221 [src]), which would otherwise be taken for a takeover
 *   whenever the connection completed before the exit. Likewise a connection made in the last 2 s
 *   before the handshake limit is a slow start and is restarted as usual.
 * - **Backoff and give-up** (`check` sessions). ARCHITECTURE §5.1 gives a backoff of 0 s, 2 s, 10 s and a give-up
 *   after three crashes in five minutes without saying how the two relate. The reading
 *   implemented here, which the user confirmed on 2026-09-28 (ROADMAP §9 Q22), uses all three
 *   steps: the session restarts itself **at most three times
 *   within any five minutes**, after 0 s, 2 s and 10 s (the delay chosen by how many unexpected
 *   ends fall within the last five minutes, this one included, and counted from the old
 *   process's exit); an unexpected end that would need a fourth restart within five minutes
 *   gives up: `failed` with cause `gaveUp`, and every waiting request rejects with
 *   `BackendCrashed`. A stop, a restart (command, settings, toolchain) and leaving `failed`
 *   clear the count.
 * - **Loaded-file tracking.** `loadedFile` is the `file` of the last `load` whose `:return`
 *   arrived in the current process (also an `:error` return: the compiler still answers
 *   position requests for the file after a failed load, F16); it is cleared when the process
 *   ends, and by a `RawCommand` request, which may have loaded anything.
 * - **Idle.** A `ready` session with an empty queue stops after `idleTimeoutMs` (0 = never).
 * - **Stop** (Stop Backend, idle, the root's last document closed, `idris2.ideMode.maxSessions`
 *   exceeded (the pool evicts only an `idle` session), consent revoked, the root's package file
 *   changed; also from `failed`) and **dispose** reject every request, in flight or waiting, and leave no process;
 *   the next request starts one again (not after dispose). The rejection says why: an `Error`
 *   named `Cancelled` for a stop the user or the extension chose (the request was abandoned, not
 *   failed), `Unsupported` when consent was revoked, `BackendCrashed` at dispose. A stop of a session that is already `stopped` is announced too
 *   when requests were waiting (e.g. for the consent question), or when its cause is `stop` and
 *   the last change announced was not, so that the status reads `stopped` after Stop Backend. A **restart** (cause `restart`: the command;
 *   `reconfigure`: a change of the settings, the toolchain or the package that changes the
 *   command line) rejects only the in-flight request (`Cancelled`), keeps the queue and starts a
 *   new process as soon as the old one has ended.
 *
 * The protocol trace (`core/log.ts` `ProtocolTrace`) gets every frame sent and received, the
 * unframed bytes, the process's stdout and stderr, and every state change with its cause, while
 * it is enabled.
 */
import { IdrisException, cancelled as cancelledError, errorText, unsupported, type IdrisError } from '../../core/errors';
import { Emitter, type Event } from '../../core/event';
import type { IDisposable } from '../../core/disposable';
import type { Log, ProtocolTrace, TraceDirection } from '../../core/log';
import { displayCommand } from '../../core/process';
import type { Classification } from '../../project/types';
import { answersWithPreviousId, isEndOfInputLine } from './protocol';
import { describeExit } from './transport';
import type {
  IdeCodec,
  IdeCommand,
  IdeMessage,
  IdeSession,
  IncomingFrame,
  LoadedFile,
  Reply,
  ReplyPayload,
  RequestKind,
  RequestOptions,
  SessionCause,
  SessionLaunch,
  SessionRole,
  SessionState,
  SessionStateChange,
  Transport,
  TransportExit,
} from './types';

/** The protocol version this extension was written against (`(:protocol-version 2 1)` on 0.8.0 [live]). */
const PROTOCOL = { major: 2, minor: 1 } as const;

/**
 * How long this extension's socket connection must have gone unanswered, when the handshake limit
 * expires, for the session to suspect another program (module comment). The compiler sends the
 * handshake right after `accept`; a connection made just before the limit is a slow start (e.g. a
 * pack wrapper), which is restarted as usual.
 */
const UNANSWERED_CONNECTION_MS = 2_000;

/** Timers, so that tests can drive time. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The fixed timing of ARCHITECTURE §5.1. */
export interface SessionTiming {
  /** From `Transport.start` to `(:protocol-version …)`. */
  readonly handshakeTimeoutMs: number;
  /** The delay before the 1st, 2nd, 3rd … restart within `crashWindowMs`; one more unexpected end gives up. */
  readonly restartDelaysMs: readonly number[];
  readonly crashWindowMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = {
  handshakeTimeoutMs: 10_000,
  restartDelaysMs: [0, 2_000, 10_000],
  crashWindowMs: 5 * 60_000,
};

/** The settings a session reads for each request (`idris2.ideMode.*`, ms). */
export interface SessionLimits {
  readonly requestTimeoutMs: number;
  readonly longActionTimeoutMs: number;
  /** 0 = never. */
  readonly idleTimeoutMs: number;
}

/**
 * What `prepare` decided: the command line to start, or why nothing may start. `unresolved`: the
 * gate refused because the session directory's real path could not be read (it is gone), which is
 * not a question of consent.
 */
export type SpawnPlan = { readonly launch: SessionLaunch } | { readonly refused: IdrisException; readonly unresolved?: true };

export interface SessionDeps {
  readonly role: SessionRole;
  readonly root: Classification;
  readonly cwd: string;
  /** Runs before every spawn (see the module comment); never rejects. */
  prepare(session: IdeSession): Promise<SpawnPlan>;
  createTransport(launch: SessionLaunch): Transport;
  readonly codec: IdeCodec;
  readonly trace: ProtocolTrace;
  readonly log: Log;
  readonly clock: Clock;
  readonly timing: SessionTiming;
  limits(): SessionLimits;
  /** Called when a process reports a protocol version above 2.1, with the warning text. */
  onNewerProtocol(warning: string): void;
}

/** An `IdeSession` with the controls the pool uses. */
export interface ManagedSession extends IdeSession, IDisposable {
  /** Records the root as last given to `sessionFor` (its model may have changed). */
  setRoot(root: Classification): void;
  /**
   * Stops the process, if any, and starts a new one now (after the old one has ended), from any
   * state; clears `failed` and the crash count. `detail` says why; `cause` is `restart` for
   * Restart Backend, `reconfigure` when the command line changed (the pool).
   */
  restart(detail: string, cause?: 'restart' | 'reconfigure'): void;
  /**
   * Stops the process and rejects every request; `stopped` with `cause` (`reconfigure`: the pool
   * stopped an `eval` session whose command line changed).
   */
  stop(cause: 'stop' | 'idle' | 'closed' | 'evicted' | 'consentRevoked' | 'packageChanged' | 'reconfigure', detail: string): void;
  /**
   * `failed` → `stopped` with cause `reconfigure` (the next request starts a process again): the
   * command line may have changed; otherwise nothing.
   */
  reset(detail: string): void;
}

export function createSession(deps: SessionDeps): ManagedSession {
  return new Session(deps);
}

/** A caller of a request; merged loads have several. */
interface Waiter {
  resolve(reply: Reply): void;
  reject(error: Error): void;
  subscription?: IDisposable;
}

interface Entry {
  command: IdeCommand;
  readonly kind: RequestKind;
  timeoutMs: number | undefined;
  /** The file of a `load`. */
  file: LoadedFile | undefined;
  readonly waiters: Waiter[];
  /** Set when the request is sent. */
  id?: bigint;
  readonly messages: IdeMessage[];
  /** `RequestOptions.beforeSend` of the newest caller. */
  beforeSend: (() => Promise<void>) | undefined;
  /** `RequestOptions.urgent` of the newest caller. */
  urgent: (() => boolean) | undefined;
  /** The process `beforeSend` has passed for. */
  passedFor: Proc | undefined;
  /**
   * The run of `beforeSend` whose result counts, and the process it runs for: one object per run,
   * so that the result of a run a merge or a new process superseded is ignored, also when it ran
   * for the same process.
   */
  running: BeforeSendRun | undefined;
}

/** One run of an entry's `beforeSend` (`Entry.running`), with the timer of its time limit. */
interface BeforeSendRun {
  readonly proc: Proc;
  timer: unknown;
}

/** One process of the session and what is known about it. */
interface Proc {
  readonly transport: Transport;
  readonly launch: SessionLaunch;
  readonly subscriptions: IDisposable[];
  readonly exited: Promise<void>;
  markExited(): void;
  /** Set once the session has decided that this process ends; its events are ignored from then on. */
  ending: boolean;
  lastRecognisedId: bigint;
  /** When `Transport.start` resolved (the process runs and, on the socket, this extension is connected). */
  connectedAt: number | undefined;
  protocolVersion: { readonly major: number; readonly minor: number } | undefined;
  loadedFile: LoadedFile | undefined;
  inFlight: Entry | undefined;
  handshakeTimer: unknown;
  requestTimer: unknown;
  startFailure: string | undefined;
  /** The end of what the process wrote to stderr, for the message when it ends. */
  stderrTail: string;
  /** The end of its own output (stdout outside the protocol, or unframed over stdio), likewise. */
  outputTail: string;
  /** An item arrived on the protocol stream (see also `Transport.receivedBytes`). */
  received: boolean;
  /** The bytes of the items that arrived: `Transport.receivedBytes` less these are an item not complete yet. */
  deliveredBytes: number;
  /** The incomplete frame the stream ended in (`truncated`), for the message when the process ends. */
  truncated: string | undefined;
}

function idrisError(kind: Exclude<IdrisError['kind'], 'Unsupported'>, message: string): IdrisException {
  return new IdrisException({ kind, message } as IdrisError);
}

/** `:load-file`, `:version`, … for messages; `a raw request` for a `RawCommand`. */
export function commandName(command: IdeCommand): string {
  if (command.kind === 'symbol') {
    return `:${command.name}`;
  }
  if (command.kind === 'list' && command.items[0]?.kind === 'symbol') {
    return `:${command.items[0].name}`;
  }
  return command.kind === 'raw' ? 'a raw request' : 'a request';
}

/** At most 200 characters of `text`, JSON-quoted, for log lines and messages. */
function excerpt(text: string): string {
  return JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
}

/** `5 s`, `2.5 s`, `10 min`: a duration for messages. */
export function duration(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 100) / 10} s`;
}

function lastLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines[lines.length - 1];
}

/**
 * `; N bytes arrived without completing a message` when the transport holds bytes of an item not
 * complete yet, for the message of a time-out: the process is stopped before they could arrive as
 * the `truncated` item at the end of the stream (*M2 second verification of the third review*:
 * neither the trace nor the message showed that anything had arrived).
 */
function pendingBytes(proc: Proc): string {
  const pending = proc.transport.receivedBytes - proc.deliveredBytes;
  return pending > 0 ? `; ${pending} byte${pending === 1 ? '' : 's'} arrived without completing a message` : '';
}

/** `RequestOptions.urgent` of `entry` now; false when it has none, or when it throws. */
function isUrgent(entry: Entry): boolean {
  try {
    return entry.urgent?.() === true;
  } catch {
    return false;
  }
}

/** Whether `text` has a whole line that is the end-of-input line (F5). */
function hasEndOfInputLine(text: string): boolean {
  return text.split('\n').some((line, i, lines) => i < lines.length - 1 && isEndOfInputLine(`${line}\n`));
}

class Session implements ManagedSession {
  readonly role: SessionRole;
  readonly cwd: string;
  private currentRoot: Classification;
  private currentState: SessionState = 'stopped';
  private readonly changes = new Emitter<SessionStateChange>();
  readonly onDidChangeState: Event<SessionStateChange> = this.changes.event;

  private readonly queue: Entry[] = [];
  private proc: Proc | undefined;
  /** Processes that were stopped and have not ended yet; `dispose` kills them at once. */
  private readonly ending = new Set<Proc>();
  /** The command line of the current process, kept while `restarting`. */
  private lastLaunch: SessionLaunch | undefined;
  /** Resolves when the last process started has ended. */
  private retiring: Promise<void> = Promise.resolve();
  /** Incremented by every stop, restart, reset and dispose: pending opens and respawns of an older epoch give up. */
  private epoch = 0;
  /** The epoch of the `open` that is running, if any. */
  private openingEpoch: number | undefined;
  /** The cause of the last change announced. */
  private lastCause: SessionCause | undefined;
  private crashTimes: number[] = [];
  private failure: string | undefined;
  private backoffTimer: unknown;
  private idleTimer: unknown;
  private nextId = 1n;
  private disposed = false;
  private readonly traceName: string;

  constructor(private readonly deps: SessionDeps) {
    this.role = deps.role;
    this.cwd = deps.cwd;
    this.currentRoot = deps.root;
    this.traceName = `${deps.role} ${deps.cwd}`;
  }

  get root(): Classification {
    return this.currentRoot;
  }

  get state(): SessionState {
    return this.currentState;
  }

  get launch(): SessionLaunch | undefined {
    return this.currentState === 'stopped' || this.currentState === 'failed' ? undefined : this.lastLaunch;
  }

  get protocolVersion(): { readonly major: number; readonly minor: number } | undefined {
    return this.proc?.protocolVersion;
  }

  get loadedFile(): LoadedFile | undefined {
    return this.proc?.loadedFile;
  }

  get idle(): boolean {
    return this.currentState === 'ready' && this.queue.length === 0 && this.proc?.inFlight === undefined;
  }

  setRoot(root: Classification): void {
    this.currentRoot = root;
  }

  // -----------------------------------------------------------------------------------------
  // Requests
  // -----------------------------------------------------------------------------------------

  request(command: IdeCommand, options: RequestOptions): Promise<Reply> {
    if (this.disposed) {
      return Promise.reject(idrisError('BackendCrashed', 'The Idris 2 session has been shut down.'));
    }
    if (options.token?.isCancellationRequested) {
      return Promise.reject(cancelledError());
    }
    if (this.currentState === 'failed') {
      return Promise.reject(idrisError('BackendCrashed', `The Idris 2 session has failed: ${this.failure ?? ''}`));
    }
    return new Promise<Reply>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const file = options.kind === 'load' ? options.file : undefined;
      let entry = file === undefined ? undefined : this.queue.find((e) => e.file !== undefined && e.file.path === file.path);
      if (entry !== undefined) {
        entry.command = command;
        entry.file = file;
        entry.timeoutMs = options.timeoutMs;
        // The newer caller's check decides (a check still running for the older one is ignored).
        entry.beforeSend = options.beforeSend;
        entry.urgent = options.urgent;
        entry.passedFor = undefined;
        this.endRun(entry);
      } else {
        entry = {
          command,
          kind: options.kind,
          timeoutMs: options.timeoutMs,
          file,
          waiters: [],
          messages: [],
          beforeSend: options.beforeSend,
          urgent: options.urgent,
          passedFor: undefined,
          running: undefined,
        };
        this.queue.push(entry);
      }
      entry.waiters.push(waiter);
      const target = entry;
      if (options.token !== undefined) {
        waiter.subscription = options.token.onCancellationRequested(() => this.cancel(target, waiter));
      }
      this.clearIdle();
      this.pump();
    });
  }

  private cancel(entry: Entry, waiter: Waiter): void {
    const index = entry.waiters.indexOf(waiter);
    if (index < 0) {
      return;
    }
    entry.waiters.splice(index, 1);
    waiter.subscription?.dispose();
    waiter.reject(cancelledError());
    if (entry.waiters.length === 0 && entry.id === undefined) {
      const queued = this.queue.indexOf(entry);
      if (queued >= 0) {
        this.queue.splice(queued, 1);
        if (entry.running !== undefined) {
          // Its `beforeSend` run is abandoned (its result ignored), and the next request goes on
          // at once (*M2 verification of the Q20–Q22 fixes*: the requests behind it waited for
          // that run to settle, or for its time limit, up to `longActionTimeout`, for nothing, and
          // the session read `idle` meanwhile, a run still going [unit-level, fake clock]).
          this.endRun(entry);
          this.pump();
        }
      }
    }
  }

  private rejectWaiters(entry: Entry, error: Error): void {
    for (const waiter of entry.waiters.splice(0)) {
      waiter.subscription?.dispose();
      waiter.reject(error);
    }
  }

  private rejectQueue(error: Error): void {
    for (const entry of this.queue.splice(0)) {
      this.endRun(entry);
      this.rejectWaiters(entry, error);
    }
  }

  /** Forgets the `beforeSend` run of `entry` (its result is ignored) and clears its time limit. */
  private endRun(entry: Entry): void {
    if (entry.running !== undefined) {
      this.deps.clock.clearTimeout(entry.running.timer);
      entry.running = undefined;
    }
  }

  /** The time limit of `entry` (module comment, *Time limits*), read from the settings now. */
  private limitOf(entry: Entry): number {
    const limits = this.deps.limits();
    return entry.timeoutMs ?? (entry.kind === 'lookup' ? limits.requestTimeoutMs : limits.longActionTimeoutMs);
  }

  /** Moves the queue on: starts a process for it when `stopped`, sends the next request when `ready`. */
  private pump(): void {
    if (this.disposed) {
      return;
    }
    if (this.currentState === 'stopped') {
      if (this.queue.length > 0 && this.openingEpoch !== this.epoch) {
        void this.open('start');
      }
      return;
    }
    const proc = this.proc;
    if (this.currentState === 'ready' && proc !== undefined && !proc.ending) {
      this.dispatch(proc);
    }
  }

  /**
   * The request to send to `proc` next (module comment, *One request in flight*): the one whose
   * `beforeSend` runs or has passed for `proc` — there is at most one, since a check is started
   * only for the request chosen here, and sent as soon as it passes —, else the first that is
   * `urgent`, else the first.
   */
  private next(proc: Proc): Entry | undefined {
    return (
      this.queue.find((entry) => entry.passedFor === proc || entry.running?.proc === proc) ??
      this.queue.find((entry) => isUrgent(entry)) ??
      this.queue[0]
    );
  }

  private dispatch(proc: Proc): void {
    // Every entry has a waiter: `cancel` removes an entry whose last waiter cancelled.
    const entry = this.next(proc);
    if (entry === undefined) {
      this.armIdle();
      return;
    }
    if (entry.beforeSend !== undefined && entry.passedFor !== proc) {
      if (entry.running?.proc !== proc) {
        this.checkBeforeSend(proc, entry, entry.beforeSend);
      }
      return; // sent (or refused) when the check settles; the other requests wait
    }
    this.queue.splice(this.queue.indexOf(entry), 1);
    const id = this.nextId++;
    let frame;
    try {
      frame = this.deps.codec.encodeRequest(entry.command, id);
    } catch (error) {
      this.rejectWaiters(entry, error instanceof Error ? error : new Error(String(error)));
      this.dispatch(proc);
      return;
    }
    entry.id = id;
    proc.inFlight = entry;
    if (entry.command.kind === 'raw') {
      proc.loadedFile = undefined;
    }
    const limit = this.limitOf(entry);
    proc.requestTimer = this.deps.clock.setTimeout(() => this.requestTimedOut(proc, entry, limit), limit);
    this.setState('busy', 'dispatch');
    if (this.proc !== proc || proc.ending) {
      return; // a listener stopped the session
    }
    this.trace('send', frame.text);
    try {
      proc.transport.send(frame.bytes);
    } catch (error) {
      this.protocolError(proc, `the request could not be written (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /**
   * Runs `beforeSend` of the next request for `proc` (`RequestOptions.beforeSend`), within the
   * request's own time limit: a check that has not settled by then rejects the request with
   * `LoadFailed`, nothing is sent, and the requests behind it go on; the process is kept, since it
   * was sent nothing (*verification after Q20–Q22*: a check that never settled, e.g. a `realpath`
   * on a hung network mount, held the queue with no timer — the documents read `checking…`, the
   * session was never idle, and only Stop Backend freed it [unit-level, fake clock]).
   */
  private checkBeforeSend(proc: Proc, entry: Entry, beforeSend: () => Promise<void>): void {
    this.endRun(entry); // a run for an earlier process
    const limit = this.limitOf(entry);
    const run: BeforeSendRun = { proc, timer: undefined };
    entry.running = run;
    const settled = (error: Error | undefined): void => {
      if (entry.running !== run) {
        return; // merged with a newer caller's request meanwhile, whose own check decides, or run again for a new process
      }
      this.endRun(entry);
      if (error === undefined) {
        entry.passedFor = proc;
      } else {
        const queued = this.queue.indexOf(entry);
        if (queued >= 0) {
          this.queue.splice(queued, 1);
        }
        this.rejectWaiters(entry, error);
      }
      this.pump(); // (a stop or an exit meanwhile has taken it out of the queue, or left it for the next process)
    };
    run.timer = this.deps.clock.setTimeout(
      () =>
        settled(
          idrisError(
            'LoadFailed',
            `Not sent: the check before ${commandName(entry.command)} (for a load, the search for its package) did not finish within ` +
              `${duration(limit)}; nothing was sent to the compiler.`,
          ),
        ),
      limit,
    );
    let running: Promise<void>;
    try {
      running = beforeSend();
    } catch (error) {
      running = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    running.then(
      () => settled(undefined),
      (error: unknown) => settled(error instanceof Error ? error : new Error(String(error))),
    );
  }

  // -----------------------------------------------------------------------------------------
  // Processes
  // -----------------------------------------------------------------------------------------

  /** Prepares and spawns a process; `cause` is that of the change to `starting`. */
  private async open(cause: 'start' | 'restart' | 'reconfigure' | 'backoff'): Promise<void> {
    const epoch = this.epoch;
    this.openingEpoch = epoch;
    try {
      await this.retiring;
      if (epoch !== this.epoch) {
        return;
      }
      let plan: SpawnPlan;
      try {
        plan = await this.deps.prepare(this);
      } catch (error) {
        plan = { refused: idrisError('BackendCrashed', `The Idris 2 session could not be prepared: ${error instanceof Error ? error.message : String(error)}`) };
      }
      if (epoch !== this.epoch) {
        return;
      }
      if ('refused' in plan) {
        this.refuse(plan.refused, plan.unresolved === true);
      } else {
        this.spawn(plan.launch, cause);
      }
    } finally {
      if (this.openingEpoch === epoch) {
        this.openingEpoch = undefined;
      }
      if (epoch !== this.epoch) {
        this.pump();
      }
    }
  }

  private refuse(error: IdrisException, unresolved: boolean): void {
    this.rejectQueue(error);
    if (this.currentState !== 'restarting') {
      return; // a start for waiting requests: they have their answer, and the session stays stopped
    }
    const detail = errorText(error.error);
    if (error.error.kind === 'Unsupported') {
      // Not allowed there (any more), or the directory is gone: the next request asks the gate again.
      this.setState('stopped', unresolved ? 'spawnError' : 'consentRevoked', detail);
    } else {
      this.failure = detail;
      this.setState('failed', 'spawnError', detail);
    }
  }

  private spawn(launch: SessionLaunch, cause: 'start' | 'restart' | 'reconfigure' | 'backoff'): void {
    const transport = this.deps.createTransport(launch);
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const proc: Proc = {
      transport,
      launch,
      subscriptions: [],
      exited,
      markExited,
      ending: false,
      lastRecognisedId: 0n,
      connectedAt: undefined,
      protocolVersion: undefined,
      loadedFile: undefined,
      inFlight: undefined,
      handshakeTimer: undefined,
      requestTimer: undefined,
      startFailure: undefined,
      stderrTail: '',
      outputTail: '',
      received: false,
      deliveredBytes: 0,
      truncated: undefined,
    };
    this.proc = proc;
    this.lastLaunch = launch;
    this.retiring = exited;
    proc.subscriptions.push(
      transport.onFrame((item) => this.onFrame(proc, item)),
      transport.onStdout((text) => this.onOutput(proc, 'stdout', text)),
      transport.onStderr((text) => this.onStderr(proc, text)),
      transport.onExit((exit) => this.onExit(proc, exit)),
    );
    const shown = displayCommand(launch.executable, launch.args);
    this.deps.log.info(`Idris 2 ${this.role} session in ${this.cwd}: starting ${shown} (${launch.transport})`);
    this.trace('event', `start ${shown} (cwd ${launch.realCwd ?? launch.cwd}, ${launch.transport})`);
    proc.handshakeTimer = this.deps.clock.setTimeout(() => this.handshakeTimedOut(proc), this.deps.timing.handshakeTimeoutMs);
    transport.start().then(
      () => {
        proc.connectedAt = this.deps.clock.now();
      },
      (error: unknown) => {
        // `onExit` follows (the transport stops a process it could not connect to); it reports this.
        proc.startFailure = error instanceof Error ? error.message : String(error);
        if (!proc.ending) {
          transport.stop();
        }
      },
    );
    this.setState('starting', cause);
  }

  private handshakeTimedOut(proc: Proc): void {
    if (proc !== this.proc || proc.ending) {
      return;
    }
    const limit = duration(this.deps.timing.handshakeTimeoutMs);
    const unanswered = proc.connectedAt === undefined ? 0 : this.deps.clock.now() - proc.connectedAt;
    if (this.takenOver(proc) && unanswered >= UNANSWERED_CONNECTION_MS) {
      this.failTakenOver(
        proc,
        `no (:protocol-version …) arrived on this extension's connection in the ${duration(unanswered)} it was open, within ${limit} of starting`,
      );
      return;
    }
    this.crash(
      proc,
      'timeout',
      `no (:protocol-version …) within ${limit} of starting (the limit includes the start of the process: ` +
        `a wrapper such as pack's idris2, which runs pack before the compiler, can take longer)${pendingBytes(proc)}`,
    );
  }

  /**
   * Whether `proc` may have served another program (module comment, "A socket taken by another
   * program"): this extension connected to its socket, and not a byte arrived on the connection
   * (a partial item counts: *M2 verification of the third review*, a handshake cut short was
   * taken for a takeover because only complete items were counted).
   */
  private takenOver(proc: Proc): boolean {
    return proc.launch.transport === 'socket' && proc.connectedAt !== undefined && !proc.received && proc.transport.receivedBytes === 0;
  }

  private failTakenOver(proc: Proc, what: string): void {
    const detail =
      `${what}. The compiler serves only the first connection to its port and does not check who made it, ` +
      'so another program on this computer may have connected first and used the session. The process was stopped ' +
      'and is not restarted automatically; Restart Backend tries again, and idris2.ideMode.transport = "stdio" (the default) ' +
      'avoids the port';
    this.deps.log.warn(`Idris 2 (${this.cwd}): possible use of the IDE-mode port by another program: ${what}`);
    this.fail(proc, 'handshake', detail);
  }

  /**
   * Marks `proc` as ending and stops it; its later events are ignored. `this.retiring` resolves
   * when it has exited, which every later `open` waits for.
   */
  private retire(proc: Proc): void {
    proc.ending = true;
    this.ending.add(proc);
    this.deps.clock.clearTimeout(proc.handshakeTimer);
    this.deps.clock.clearTimeout(proc.requestTimer);
    proc.inFlight = undefined;
    if (this.proc === proc) {
      this.proc = undefined;
    }
    this.clearIdle();
    proc.transport.stop();
  }

  private onExit(proc: Proc, exit: TransportExit): void {
    proc.subscriptions.forEach((s) => s.dispose());
    proc.markExited();
    this.ending.delete(proc);
    if (proc !== this.proc || proc.ending) {
      return;
    }
    if (exit.spawnError !== undefined) {
      this.fail(proc, 'spawnError', `${proc.launch.executable} could not be started: ${exit.spawnError}`);
      return;
    }
    const stderr = lastLine(proc.stderrTail);
    const output = lastLine(proc.outputTail);
    const detail =
      `the Idris 2 process ${describeExit(exit)}` +
      (proc.startFailure === undefined ? '' : ` (${proc.startFailure})`) +
      (stderr === undefined ? '' : `; its last error output: ${stderr}`) +
      (output === undefined ? '' : `; its last output: ${output}`) +
      (proc.truncated === undefined ? '' : `; its output ended inside a frame: ${excerpt(proc.truncated)}`);
    if (this.takenOver(proc)) {
      const open = this.deps.clock.now() - (proc.connectedAt ?? 0);
      if (open >= UNANSWERED_CONNECTION_MS || hasEndOfInputLine(proc.outputTail)) {
        this.failTakenOver(
          proc,
          `${detail}, ${duration(open)} after this extension had connected to its port and before (:protocol-version …) arrived`,
        );
        return;
      }
    }
    this.crash(proc, 'exit', detail);
  }

  /** An unexpected end of `proc`: restart after the backoff, or give up (module comment). */
  private crash(proc: Proc, cause: 'exit' | 'timeout' | 'protocolError', detail: string, inFlightError?: Error): void {
    if (proc !== this.proc || proc.ending) {
      return;
    }
    const inFlight = proc.inFlight;
    this.retire(proc);
    if (inFlight !== undefined) {
      const name = commandName(inFlight.command);
      this.rejectWaiters(
        inFlight,
        inFlightError ??
          (cause === 'protocolError'
            ? idrisError('ProtocolError', `The Idris 2 process broke the protocol while answering ${name}: ${detail}.`)
            : idrisError('BackendCrashed', `The Idris 2 process ended while answering ${name}: ${detail}.`)),
      );
    }
    if (this.role === 'eval') {
      // Not restarted (module comment, *Unexpected ends*): the next evaluation starts a process.
      this.rejectQueue(idrisError('BackendCrashed', `The Idris 2 evaluation process ended (${detail}); it starts again at the next evaluation.`));
      this.setState('stopped', cause, detail);
      return;
    }
    const now = this.deps.clock.now();
    const { restartDelaysMs, crashWindowMs } = this.deps.timing;
    this.crashTimes = this.crashTimes.filter((t) => now - t < crashWindowMs);
    this.crashTimes.push(now);
    const count = this.crashTimes.length;
    if (count > restartDelaysMs.length) {
      this.failure =
        `${detail}; ${count} unexpected ends within ${duration(crashWindowMs)}, ` +
        `and the session restarts itself at most ${restartDelaysMs.length} times in that period`;
      this.rejectQueue(idrisError('BackendCrashed', `The Idris 2 session stopped restarting: ${this.failure}.`));
      this.setState('failed', 'gaveUp', this.failure);
      return;
    }
    this.setState('restarting', cause, detail);
    this.scheduleRespawn(restartDelaysMs[count - 1]);
  }

  /** The process cannot serve at all (it could not be started, or speaks protocol 1): `failed` at once. */
  private fail(proc: Proc, cause: 'spawnError' | 'handshake', detail: string): void {
    const inFlight = proc.inFlight;
    this.retire(proc);
    this.failure = detail;
    const error = idrisError('BackendCrashed', detail);
    if (inFlight !== undefined) {
      this.rejectWaiters(inFlight, error);
    }
    this.rejectQueue(error);
    this.setState('failed', cause, detail);
  }

  /** Once the old process has ended and `delayMs` have passed, starts a new one (`restarting` → `starting`). */
  private scheduleRespawn(delayMs: number): void {
    const epoch = this.epoch;
    void this.retiring.then(() => {
      if (epoch !== this.epoch || this.currentState !== 'restarting') {
        return;
      }
      if (delayMs <= 0) {
        void this.open('backoff');
        return;
      }
      this.backoffTimer = this.deps.clock.setTimeout(() => {
        this.backoffTimer = undefined;
        if (epoch === this.epoch && this.currentState === 'restarting') {
          void this.open('backoff');
        }
      }, delayMs);
    });
  }

  private requestTimedOut(proc: Proc, entry: Entry, limitMs: number): void {
    if (proc !== this.proc || proc.ending || proc.inFlight !== entry) {
      return;
    }
    const name = commandName(entry.command);
    const detail = `${name} did not answer within ${duration(limitMs)}${pendingBytes(proc)}`;
    const timeout = idrisError('RequestTimeout', `${detail}; the Idris 2 process was stopped.`);
    this.rejectQueue(
      idrisError('RequestTimeout', `Dropped: an earlier request (${name}) did not answer within ${duration(limitMs)}, and the Idris 2 process was stopped.`),
    );
    this.crash(proc, 'timeout', detail, timeout);
  }

  // -----------------------------------------------------------------------------------------
  // The protocol stream
  // -----------------------------------------------------------------------------------------

  private onFrame(proc: Proc, item: IncomingFrame): void {
    proc.deliveredBytes += item.byteLength;
    if (proc !== this.proc || proc.ending) {
      return;
    }
    proc.received = true;
    switch (item.kind) {
      case 'truncated':
        // The stream has ended; `onExit` follows and reports it with the exit (module comment).
        this.trace('unframed', item.text);
        proc.truncated = item.text;
        return;
      case 'overflow':
        this.trace('unframed', item.text);
        this.protocolError(proc, `more output than the transport holds without a complete frame: ${excerpt(item.text)}`);
        return;
      case 'unframed':
        if (proc.launch.transport === 'socket') {
          this.trace('unframed', item.text);
          this.protocolError(proc, `output on the socket that is not a frame: ${excerpt(item.text)}`);
        } else {
          this.onOutput(proc, 'unframed', item.text);
        }
        return;
      case 'framed':
        break;
    }
    this.trace('receive', item.text);
    if (this.role === 'eval' && proc.protocolVersion !== undefined && proc.inFlight?.id !== undefined) {
      // Module comment, *Unread highlighting*.
      const id = this.deps.codec.highlightSourceId(item.text);
      if (id === proc.inFlight.id) {
        proc.lastRecognisedId = id;
        return;
      }
    }
    const decoded = this.deps.codec.decodeMessage(item.text);
    switch (decoded.kind) {
      case 'invalid':
        this.protocolError(proc, `a frame that is not an s-expression (${decoded.reason}): ${excerpt(item.text)}`);
        return;
      case 'unknown': {
        if (decoded.handshake === true && proc.protocolVersion === undefined) {
          this.fail(proc, 'handshake', `${proc.launch.executable} sent an IDE protocol handshake this extension cannot read: ${excerpt(item.text)}`);
          return;
        }
        const entry = proc.inFlight;
        if (decoded.returnId !== undefined && entry?.id === decoded.returnId && proc.protocolVersion !== undefined) {
          this.unreadableReturn(proc, entry, item.text);
        } else {
          this.deps.log.warn(`Idris 2 (${this.cwd}): ignored a message of an unknown shape: ${excerpt(item.text)}`);
        }
        return;
      }
      case 'message':
        this.onMessage(proc, decoded.message, item.text);
        return;
    }
  }

  private onMessage(proc: Proc, message: IdeMessage, text: string): void {
    if (message.kind === 'protocol-version') {
      if (proc.protocolVersion === undefined && this.currentState === 'starting') {
        this.handshake(proc, message.major, message.minor);
      } else {
        this.protocolError(proc, `an unexpected ${excerpt(text)}`);
      }
      return;
    }
    if (proc.protocolVersion === undefined) {
      this.protocolError(proc, `a message before (:protocol-version …): ${excerpt(text)}`);
      return;
    }
    const entry = proc.inFlight;
    if (entry === undefined || entry.id === undefined) {
      this.protocolError(proc, `a message while no request was waiting for an answer: ${excerpt(text)}`);
      return;
    }
    if (message.id === entry.id) {
      proc.lastRecognisedId = entry.id;
      if (message.kind === 'return') {
        this.complete(proc, entry, message.payload, undefined);
      } else {
        entry.messages.push(message);
      }
      return;
    }
    if (message.kind === 'return' && message.id === proc.lastRecognisedId && answersWithPreviousId(message.payload)) {
      this.complete(proc, entry, message.payload, message.id);
      return;
    }
    this.protocolError(
      proc,
      `an answer with id ${message.id} while request ${entry.id} (${commandName(entry.command)}) was waiting: ${excerpt(text)}`,
    );
  }

  private handshake(proc: Proc, major: number, minor: number): void {
    this.deps.clock.clearTimeout(proc.handshakeTimer);
    proc.handshakeTimer = undefined;
    if (major !== PROTOCOL.major) {
      this.fail(
        proc,
        'handshake',
        `${proc.launch.executable} speaks version ${major}.${minor} of the IDE protocol; this extension needs version 2, ` +
          (major < PROTOCOL.major
            ? "Idris 2's (version 1 is Idris 1's, which is not supported)"
            : 'and a new major version means a protocol it cannot rely on'),
      );
      return;
    }
    proc.protocolVersion = { major, minor };
    let warning: string | undefined;
    if (minor > PROTOCOL.minor) {
      warning =
        `${proc.launch.executable} speaks version ${major}.${minor} of the IDE protocol, newer than ` +
        `${PROTOCOL.major}.${PROTOCOL.minor}, which this extension was written for; some answers may be misread`;
      this.deps.onNewerProtocol(warning);
    }
    this.setState('ready', 'handshake', warning);
    this.pump();
  }

  private complete(proc: Proc, entry: Entry, payload: ReplyPayload, returnedId: bigint | undefined): void {
    this.deps.clock.clearTimeout(proc.requestTimer);
    proc.requestTimer = undefined;
    proc.inFlight = undefined;
    if (entry.file !== undefined) {
      proc.loadedFile = entry.file;
    }
    const id = entry.id ?? 0n;
    const reply: Reply =
      returnedId === undefined
        ? { id, payload, messages: entry.messages }
        : { id, payload, messages: entry.messages, returnedId };
    for (const waiter of entry.waiters.splice(0)) {
      waiter.subscription?.dispose();
      waiter.resolve(reply);
    }
    this.setState('ready', 'reply');
    this.pump();
  }

  /**
   * A `:return` with the in-flight id whose payload cannot be read (module comment): the request
   * ends with a `ProtocolError` at once; the stream is in step, so the process is kept.
   */
  private unreadableReturn(proc: Proc, entry: Entry, text: string): void {
    this.deps.clock.clearTimeout(proc.requestTimer);
    proc.requestTimer = undefined;
    proc.inFlight = undefined;
    proc.lastRecognisedId = entry.id ?? proc.lastRecognisedId;
    if (entry.file !== undefined) {
      proc.loadedFile = entry.file;
    }
    const name = commandName(entry.command);
    this.deps.log.warn(`Idris 2 (${this.cwd}): an answer to ${name} in a form this extension cannot read: ${excerpt(text)}`);
    this.rejectWaiters(
      entry,
      idrisError('ProtocolError', `The Idris 2 process answered ${name} in a form this extension cannot read: ${excerpt(text)}.`),
    );
    this.setState('ready', 'reply');
    this.pump();
  }

  private protocolError(proc: Proc, detail: string): void {
    this.deps.log.warn(`Idris 2 (${this.cwd}): protocol error: ${detail}`);
    this.crash(proc, 'protocolError', detail);
  }

  /** The process's own output: over stdio an unframed item, on the socket its stdout. */
  private onOutput(proc: Proc, direction: 'stdout' | 'unframed', text: string): void {
    proc.outputTail = (proc.outputTail + text).slice(-2_000);
    this.trace(direction, text);
    const what = isEndOfInputLine(text) ? 'end of input' : 'output';
    this.deps.log.debug(`Idris 2 (${this.cwd}) ${what}: ${text.replace(/\r?\n$/, '')}`);
  }

  private onStderr(proc: Proc, text: string): void {
    proc.stderrTail = (proc.stderrTail + text).slice(-2_000);
    this.trace('stderr', text);
    this.deps.log.debug(`Idris 2 (${this.cwd}) stderr: ${text.trimEnd()}`);
  }

  // -----------------------------------------------------------------------------------------
  // Controls (pool)
  // -----------------------------------------------------------------------------------------

  restart(detail: string, cause: 'restart' | 'reconfigure' = 'restart'): void {
    if (this.disposed) {
      return;
    }
    this.newEpoch();
    // `open` is called before the state change is announced: it captures the epoch at once, so
    // that a listener that stops the session in response cancels it.
    const proc = this.proc;
    if (proc !== undefined) {
      const inFlight = proc.inFlight;
      this.retire(proc);
      if (inFlight !== undefined) {
        this.rejectWaiters(inFlight, cancelledError(`The Idris 2 process was restarted (${detail}) while answering ${commandName(inFlight.command)}.`));
      }
      void this.open('backoff');
      this.setState('restarting', cause, detail);
    } else if (this.currentState === 'restarting') {
      void this.open('backoff');
    } else {
      void this.open(cause);
      if (this.currentState === 'failed') {
        this.setState('stopped', cause, detail);
      }
    }
  }

  stop(cause: 'stop' | 'idle' | 'closed' | 'evicted' | 'consentRevoked' | 'packageChanged' | 'reconfigure', detail: string): void {
    if (this.disposed) {
      return;
    }
    // Requests waiting while `stopped` (for `prepare`: the consent question, a toolchain scan).
    const waiting = this.queue.length > 0 || this.openingEpoch !== undefined;
    this.newEpoch();
    const error = cause === 'consentRevoked' ? unsupported(detail) : cancelledError(`The Idris 2 session was stopped (${detail}).`);
    const proc = this.proc;
    if (proc !== undefined) {
      const inFlight = proc.inFlight;
      this.retire(proc);
      if (inFlight !== undefined) {
        this.rejectWaiters(inFlight, error);
      }
    }
    this.rejectQueue(error);
    this.setState('stopped', cause, detail, waiting || (cause === 'stop' && this.lastCause !== 'stop'));
  }

  reset(detail: string): void {
    if (this.disposed || this.currentState !== 'failed') {
      return;
    }
    this.newEpoch();
    this.setState('stopped', 'reconfigure', detail);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.newEpoch();
    this.disposed = true;
    const error = idrisError('BackendCrashed', 'The Idris 2 session was stopped because the extension is shutting down.');
    const proc = this.proc;
    const inFlight = proc?.inFlight;
    if (proc !== undefined) {
      this.retire(proc);
    }
    // Killed at once, also a process that is still ending: `deactivate()` is synchronous, and
    // the Extension Host may exit before the grace period of a stop has passed
    // (docs/as-built/M1.md, *Processes*).
    for (const ending of this.ending) {
      ending.subscriptions.forEach((s) => s.dispose());
      ending.transport.dispose();
    }
    this.ending.clear();
    if (inFlight !== undefined) {
      this.rejectWaiters(inFlight, error);
    }
    this.rejectQueue(error);
    this.setState('stopped', 'dispose');
    this.changes.dispose();
  }

  /** Cancels every pending open, respawn and idle stop, and forgets the crash count and a failure. */
  private newEpoch(): void {
    this.epoch++;
    this.deps.clock.clearTimeout(this.backoffTimer);
    this.backoffTimer = undefined;
    this.clearIdle();
    this.crashTimes = [];
    this.failure = undefined;
  }

  private armIdle(): void {
    this.clearIdle();
    const { idleTimeoutMs } = this.deps.limits();
    if (idleTimeoutMs <= 0) {
      return;
    }
    const epoch = this.epoch;
    this.idleTimer = this.deps.clock.setTimeout(() => {
      this.idleTimer = undefined;
      if (epoch === this.epoch && this.currentState === 'ready' && this.queue.length === 0) {
        this.stop('idle', `no request for ${duration(idleTimeoutMs)}`);
      }
    }, idleTimeoutMs);
  }

  private clearIdle(): void {
    this.deps.clock.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  // -----------------------------------------------------------------------------------------
  // Events, log, trace
  // -----------------------------------------------------------------------------------------

  /** Announces a change of state; a change to the same state only when `repeat` is set. */
  private setState(state: SessionState, cause: SessionCause, detail?: string, repeat = false): void {
    const previous = this.currentState;
    if (previous === state && !repeat) {
      return;
    }
    this.currentState = state;
    this.lastCause = cause;
    const suffix = detail === undefined ? '' : `: ${detail}`;
    this.trace('event', `${previous} → ${state} (${cause})${suffix}`);
    const line = `Idris 2 ${this.role} session in ${this.cwd}: ${state} (${cause})${suffix}`;
    switch (cause) {
      case 'dispatch':
      case 'reply':
      case 'backoff':
        break;
      case 'exit':
      case 'timeout':
      case 'protocolError':
      case 'spawnError':
      case 'gaveUp':
        this.deps.log.warn(line);
        break;
      case 'handshake':
        // A newer protocol is warned about once for the pool (`onNewerProtocol`), not per start.
        if (state === 'failed') {
          this.deps.log.warn(line);
        } else {
          this.deps.log.info(line);
        }
        break;
      default:
        this.deps.log.info(line);
    }
    try {
      this.changes.fire(detail === undefined ? { previous, state, cause } : { previous, state, cause, detail });
    } catch (error) {
      this.deps.log.error(`A listener of the Idris 2 session failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private trace(direction: TraceDirection, text: string): void {
    if (this.deps.trace.enabled) {
      this.deps.trace.append({ session: this.traceName, direction, text });
    }
  }
}
