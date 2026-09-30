// Test doubles for the IDE-mode session layer (src/backend/ide/{session,pool}.ts): a clock the
// test advances, a codec that carries requests and messages as JSON (so that the state machine is
// tested without the s-expression codec, which has its own tests), and a transport whose frames,
// output and exit the test injects. No process is started.
import type { IDisposable } from '../../../src/core/disposable';
import { Emitter, type Event } from '../../../src/core/event';
import type { Log, ProtocolTrace, TraceEntry } from '../../../src/core/log';
import type { Clock } from '../../../src/backend/ide/session';
import type {
  CancellationToken,
  DecodedMessage,
  FrameDecoder,
  IdeCodec,
  IdeCommand,
  IdeMessage,
  IncomingFrame,
  OutgoingFrame,
  ReplyPayload,
  Sexp,
  SessionLaunch,
  Transport,
  TransportExit,
} from '../../../src/backend/ide/types';

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

/** A clock whose timers run only when the test calls `advance`, in due order. */
export class FakeClock implements Clock {
  private time = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, { due: this.time + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves the time forward by `ms`, running every timer that falls due, earliest first. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { due: number; callback: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].due <= end && (next === undefined || entry[1].due < next[1].due)) {
          next = entry;
        }
      }
      if (next === undefined) {
        break;
      }
      this.timers.delete(next[0]);
      this.time = next[1].due;
      next[1].callback();
    }
    this.time = end;
  }

  /** The delays of the pending timers from now, sorted. */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.due - this.time).sort((a, b) => a - b);
  }
}

/** Lets every pending promise callback run (the session layer awaits only promises, never real timers). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------------------------

const replacer = (_key: string, value: unknown): unknown => (typeof value === 'bigint' ? { $bigint: value.toString() } : value);
const reviver = (_key: string, value: unknown): unknown =>
  typeof value === 'object' && value !== null && '$bigint' in value ? BigInt((value as { $bigint: string }).$bigint) : value;

/** A request as the fake transport records it. */
export interface SentRequest {
  readonly command: IdeCommand;
  readonly id: bigint;
}

/**
 * Requests and messages as JSON lines: `encodeRequest` writes `{command, id}`, and a framed text
 * decodes to the message it holds, to `unknown` for `{"unknown": …, "returnId"?: …, "handshake"?:
 * true}` (`unknownText`), and to `invalid` when it is not JSON. Frames come from `FakeTransport`, never
 * from a decoder.
 */
export const jsonCodec: IdeCodec = {
  encodeRequest(command: IdeCommand, id: bigint): OutgoingFrame {
    const text = `${JSON.stringify({ command, id }, replacer)}\n`;
    return { text, bytes: Buffer.from(text, 'utf8') };
  },
  createFrameDecoder(): FrameDecoder {
    throw new Error('jsonCodec has no frame decoder: FakeTransport emits frames itself');
  },
  decodeMessage(text: string): DecodedMessage {
    let value: unknown;
    try {
      value = JSON.parse(text, reviver);
    } catch (error) {
      return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    if (typeof value === 'object' && value !== null && 'unknown' in value) {
      const { unknown, returnId, handshake } = value as { unknown: Sexp; returnId?: bigint; handshake?: true };
      return { kind: 'unknown', sexp: unknown, ...(returnId === undefined ? {} : { returnId }), ...(handshake === true ? { handshake } : {}) };
    }
    return { kind: 'message', message: value as IdeMessage };
  },
  /** The id of a frame holding an `:output` message whose payload is `highlight-source` (parsed: a fake need not be fast). */
  highlightSourceId(text: string): bigint | undefined {
    const decoded = jsonCodec.decodeMessage(text);
    return decoded.kind === 'message' && decoded.message.kind === 'output' && decoded.message.payload.kind === 'highlight-source'
      ? decoded.message.id
      : undefined;
  },
};

/** The text of a frame carrying `message` for `jsonCodec`. */
export function messageText(message: IdeMessage): string {
  return JSON.stringify(message, replacer);
}

/**
 * The text of a frame `jsonCodec` decodes as an unknown message: a `:return` for `returnId`, if
 * given; a handshake of an unreadable shape for `handshake` (as `protocol.ts` marks one).
 */
export function unknownText(sexp: Sexp, returnId?: bigint, handshake?: true): string {
  return JSON.stringify({ unknown: sexp, ...(returnId === undefined ? {} : { returnId }), ...(handshake === true ? { handshake } : {}) }, replacer);
}

// Builders of the messages and commands the tests use (shapes of `types.ts`).
export const sym = (name: string): Sexp => ({ kind: 'symbol', name });
export const str = (value: string): Sexp => ({ kind: 'string', value });
export const list = (...items: Sexp[]): Sexp => ({ kind: 'list', items });
export const loadFile = (path: string): IdeCommand => list(sym('load-file'), str(path));
export const typeOf = (name: string): IdeCommand => list(sym('type-of'), str(name));
export const ok = (result: Sexp = list()): ReplyPayload => ({ kind: 'ok', result, highlighting: [] });
export const error = (message: string): ReplyPayload => ({ kind: 'error', message, highlighting: [] });
export const ret = (id: bigint, payload: ReplyPayload = ok()): IdeMessage => ({ kind: 'return', id, payload });
export const writeString = (id: bigint, text: string): IdeMessage => ({ kind: 'write-string', id, text });

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

export interface FakeTransportBehaviour {
  /** `resolve` (default): `start` resolves at once; `manual`: it waits for `resolveStart`/`rejectStart`. */
  readonly start?: 'resolve' | 'manual';
  /** The `(:protocol-version …)` sent after a resolved start (default `[2, 1]`); `null` for none. */
  readonly handshake?: readonly [number, number] | null;
  /** `exit` (default): `stop` ends the process in a microtask; `manual`: it ends on `exit`. */
  readonly onStop?: 'exit' | 'manual';
}

/** A transport the test drives: it records what the session sends and injects what it receives. */
export class FakeTransport implements Transport {
  readonly kind: SessionLaunch['transport'];
  readonly sent: SentRequest[] = [];
  stopCalls = 0;
  disposed = false;
  ended = false;
  /** Thrown by the next `send`, to simulate a failed write. */
  sendError: Error | undefined;
  /** `Transport.receivedBytes`: the items fired so far, and `partial` bytes. */
  receivedBytes = 0;

  private readonly frames = new Emitter<IncomingFrame>();
  private readonly stdoutEmitter = new Emitter<string>();
  private readonly stderrEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<TransportExit>();
  readonly onFrame: Event<IncomingFrame> = this.frames.event;
  readonly onStdout: Event<string> = this.stdoutEmitter.event;
  readonly onStderr: Event<string> = this.stderrEmitter.event;
  readonly onExit: Event<TransportExit> = this.exitEmitter.event;
  private settleStart: { resolve(): void; reject(error: Error): void } | undefined;

  constructor(
    readonly launch: SessionLaunch,
    private readonly behaviour: FakeTransportBehaviour,
  ) {
    this.kind = launch.transport;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.behaviour.start === 'manual') {
        this.settleStart = { resolve, reject };
        return;
      }
      resolve();
      this.sendHandshake();
    });
  }

  resolveStart(): void {
    this.settleStart?.resolve();
    this.settleStart = undefined;
    this.sendHandshake();
  }

  rejectStart(reason: string): void {
    this.settleStart?.reject(new Error(reason));
    this.settleStart = undefined;
  }

  private sendHandshake(): void {
    const handshake = this.behaviour.handshake === undefined ? ([2, 1] as const) : this.behaviour.handshake;
    if (handshake !== null) {
      queueMicrotask(() => this.message({ kind: 'protocol-version', major: handshake[0], minor: handshake[1] }));
    }
  }

  send(bytes: Uint8Array): void {
    if (this.sendError !== undefined) {
      const failure = this.sendError;
      this.sendError = undefined;
      throw failure;
    }
    this.sent.push(JSON.parse(Buffer.from(bytes).toString('utf8'), reviver) as SentRequest);
  }

  stop(): void {
    this.stopCalls++;
    if (this.behaviour.onStop !== 'manual') {
      queueMicrotask(() => this.exit({ code: null, signal: 'SIGTERM' }));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.ended = true;
  }

  /** The last request sent. */
  lastSent(): SentRequest {
    const last = this.sent[this.sent.length - 1];
    if (last === undefined) {
      throw new Error('nothing was sent');
    }
    return last;
  }

  message(message: IdeMessage): void {
    this.framed(messageText(message));
  }

  framed(text: string): void {
    this.item({ kind: 'framed', text, byteLength: Buffer.byteLength(text) + 6 });
  }

  unframed(text: string): void {
    this.item({ kind: 'unframed', text, byteLength: Buffer.byteLength(text) });
  }

  /** The stream ended inside a frame (a real transport fires `onExit` next; the test calls `exit`). */
  truncated(text: string): void {
    this.item({ kind: 'truncated', text, byteLength: Buffer.byteLength(text) });
  }

  /** The transport gave up on the stream (more than its bound without a complete item). */
  overflow(text: string): void {
    this.item({ kind: 'overflow', text, byteLength: Buffer.byteLength(text) });
  }

  /** Bytes of the protocol stream that do not complete an item yet (e.g. a handshake cut short). */
  partial(text: string): void {
    if (!this.ended) {
      this.receivedBytes += Buffer.byteLength(text);
    }
  }

  private item(item: IncomingFrame): void {
    if (!this.ended) {
      this.receivedBytes += item.byteLength;
      this.frames.fire(item);
    }
  }

  stdout(text: string): void {
    this.stdoutEmitter.fire(text);
  }

  stderr(text: string): void {
    this.stderrEmitter.fire(text);
  }

  /** The process ends (once). */
  exit(exit: TransportExit): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.exitEmitter.fire(exit);
  }
}

/** The transport factory of a session or pool under test; it remembers every transport it made. */
export class FakeTransports {
  readonly all: FakeTransport[] = [];
  behaviour: FakeTransportBehaviour = {};
  /** The largest number of transports alive at once for one working directory. */
  maxAlivePerCwd = 0;

  readonly create = (launch: SessionLaunch): FakeTransport => {
    const transport = new FakeTransport(launch, this.behaviour);
    this.all.push(transport);
    const alive = this.all.filter((t) => !t.ended && t.launch.cwd === launch.cwd).length;
    this.maxAlivePerCwd = Math.max(this.maxAlivePerCwd, alive);
    return transport;
  };

  last(): FakeTransport {
    const last = this.all[this.all.length - 1];
    if (last === undefined) {
      throw new Error('no transport was created');
    }
    return last;
  }

  alive(): FakeTransport[] {
    return this.all.filter((t) => !t.ended);
  }
}

// ---------------------------------------------------------------------------------------------
// Log, trace, cancellation
// ---------------------------------------------------------------------------------------------

export interface RecordingLog extends Log {
  readonly lines: string[];
}

export function recordingLog(): RecordingLog {
  const lines: string[] = [];
  const record = (level: string) => (message: string | Error) => {
    lines.push(`${level}: ${message instanceof Error ? message.message : message}`);
  };
  return { lines, trace: record('trace'), debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

export class RecordingTrace implements ProtocolTrace {
  enabled = true;
  readonly entries: TraceEntry[] = [];

  append(entry: TraceEntry): void {
    this.entries.push(entry);
  }
}

/** A cancellation token the test cancels. */
export class TestToken implements CancellationToken, IDisposable {
  isCancellationRequested = false;
  private readonly emitter = new Emitter<unknown>();
  readonly onCancellationRequested: Event<unknown> = this.emitter.event;

  cancel(): void {
    if (!this.isCancellationRequested) {
      this.isCancellationRequested = true;
      this.emitter.fire(undefined);
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
