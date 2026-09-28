/**
 * The transports of an IDE-mode session (docs/ARCHITECTURE.md §5.1 "Transport", D1; ROADMAP M2):
 * one compiler process and its protocol stream, cut into frames by the codec's `FrameDecoder`.
 * The contract is `Transport` in `types.ts`; the process is started through
 * `core/process.ts` `startLongRunningProcess` (trust, fully qualified paths, no shell but a
 * quoted batch file, process-group termination).
 *
 * - **stdio** (`idris2 --ide-mode …`): the protocol stream is the process's stdout, requests go
 *   to its stdin. Program output (`:exec`), the compiler's log lines (`LOG …`, e.g. from a
 *   `%logging` pragma) and the end-of-input line arrive unframed in the stream (F5), as
 *   `unframed` items; `onStdout` never fires.
 * - **socket** (`idris2 --ide-mode-socket …`): the compiler binds an IPv4 (`AF_INET`) socket to
 *   `localhost` on a free port, prints the port and a newline on stdout (`putStrLn (show p)`,
 *   `initIDESocketFile`, `src/Idris/IDEMode/REPL.idr` 50–76 on v0.8.0 [src]; `${PORT}\n` as the
 *   first stdout line of the `handshake-socket` transcript [live]), accepts one connection and
 *   sends the handshake on it. The transport reads stdout line by line up to the first line that
 *   is a port (1–65535, at most five digits), connects to `127.0.0.1:<port>`, and forwards
 *   every other line, before and after it, as `onStdout` (program output and the end-of-input
 *   line go there, F5). Lines can come before the port: the compiler's log lines while the
 *   prelude loads, with `--log <n>` in `idris2.ideMode.extraArgs` (`LOG ttc.read:10: …` before
 *   any port: 411 lines, 41,168 bytes, then the port [live, 0.8.0, 2026-09-27, `timeout 10 idris2
 *   --ide-mode-socket --no-color --log 10`]). A compiler
 *   that cannot open its socket prints why on stdout and exits with code 1 (`Failed to open
 *   socket`, `Failed to bind socket with error: …`; `REPL.idr` 50–76, `Driver.idr` 216–221
 *   [src]), which ends the start; so does more than `MAX_BEFORE_PORT_BYTES` (1 MiB) of stdout
 *   without a port line, and the process is then stopped. Its stdin is the null device. When the
 *   compiler closes the socket while the process runs, the transport stops the process, so that
 *   `onExit` always ends a transport's life, and `TransportExit.connectionClosed` says so;
 *   `onExit` fires once both the process has ended and the socket has closed (the socket is
 *   dropped if it has not closed one grace period after the process ended).
 *
 * **Buffer bound.** The protocol stream is streamed into the decoder, which holds an incomplete
 * item until it is complete. `MAX_PENDING_PROTOCOL_BYTES` is the size of the largest reply a
 * six-digit prefix can name: `0xFFFFFF` code points of at most four UTF-8 bytes each, after the
 * prefix (a longer reply would carry a seven- or eight-digit prefix, `wire.ts`; the largest reply
 * in the 0.8.0 transcripts has 682 bytes [live]). When more bytes than that are held without a
 * complete item — output without a line break, from a program that prints without end over
 * stdio or a misconfigured executable — what the decoder holds is emitted as one `overflow`
 * item (which the session treats as a protocol error), the rest of the stream is dropped and the
 * process is stopped, so that such a process cannot exhaust the Extension Host's memory (the M1
 * runner's output limit plays this role for probes). At the end of the stream (the process
 * ended, or the compiler closed the socket) the decoder's rest comes first — a `truncated` item
 * when the stream ended inside a frame — and `onExit` follows it.
 *
 * stdout and stderr outside the protocol stream are decoded as UTF-8 incrementally (a character
 * split across two reads decodes correctly) and forwarded as they arrive.
 */
import * as net from 'net';
import type { TransportKind } from '../../core/config';
import { Emitter, type Event } from '../../core/event';
import type { Log } from '../../core/log';
import {
  GRACE_MS,
  startLongRunningProcess,
  type Environment,
  type LongRunningExit,
  type LongRunningProcess,
} from '../../core/process';
import type { WorkspaceTrust } from '../../core/trust';
import type { FrameDecoder, IdeCodec, IncomingFrame, SessionLaunch, Transport, TransportExit } from './types';

/** The most bytes of the protocol stream held without a complete item (see the module comment). */
export const MAX_PENDING_PROTOCOL_BYTES = 6 + 4 * 0xffffff;

/** The most stdout bytes read before the port line (see the module comment). */
export const MAX_BEFORE_PORT_BYTES = 1 << 20;

/** What `createTransport` needs; the session pool passes its own dependencies. */
export interface TransportDeps {
  /** Only `createFrameDecoder` is used: one decoder per transport. */
  readonly codec: Pick<IdeCodec, 'createFrameDecoder'>;
  readonly trust: WorkspaceTrust;
  readonly log: Log;
  readonly platform: NodeJS.Platform;
  /** The Extension Host's environment; `SessionLaunch.env` is overlaid on it. */
  readonly processEnv: Environment;
  /** `GRACE_MS` of `core/process.ts` unless a test shortens it; also how long the socket may outlive the process. */
  readonly graceMs?: number;
  /** `MAX_PENDING_PROTOCOL_BYTES` unless a test lowers it. */
  readonly maxPendingBytes?: number;
}

/** The transport `launch.transport` names, for `launch`; nothing starts until `start`. */
export function createTransport(launch: SessionLaunch, deps: TransportDeps): Transport {
  return launch.transport === 'socket' ? new SocketTransport(launch, deps) : new StdioTransport(launch, deps);
}

/** `exited with code 1`, `was ended by SIGTERM`, the spawn error, and a closed connection first, for messages. */
export function describeExit(exit: TransportExit): string {
  if (exit.spawnError !== undefined) {
    return `could not be started (${exit.spawnError})`;
  }
  if (exit.connectionClosed === true) {
    return exit.signal !== null
      ? `closed its IDE-mode connection while it still ran, and was then stopped (${exit.signal})`
      : `closed its IDE-mode connection, then exited with code ${exit.code}`;
  }
  return exit.signal !== null ? `was ended by ${exit.signal}` : `exited with code ${exit.code}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

abstract class ProcessTransport implements Transport {
  abstract readonly kind: TransportKind;

  private readonly frameEmitter = new Emitter<IncomingFrame>();
  private readonly stdoutEmitter = new Emitter<string>();
  private readonly stderrEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<TransportExit>();
  readonly onFrame: Event<IncomingFrame> = this.frameEmitter.event;
  readonly onStdout: Event<string> = this.stdoutEmitter.event;
  readonly onStderr: Event<string> = this.stderrEmitter.event;
  readonly onExit: Event<TransportExit> = this.exitEmitter.event;

  protected child: LongRunningProcess | undefined;
  protected readonly graceMs: number;
  private readonly decoder: FrameDecoder;
  private readonly maxPendingBytes: number;
  private pendingBytes = 0;
  private received = 0;
  private protocolEnded = false;
  private readonly stdoutText = new TextDecoder();
  private readonly stderrText = new TextDecoder();
  private startPromise: Promise<void> | undefined;
  private exitFired = false;
  protected disposed = false;

  constructor(
    readonly launch: SessionLaunch,
    protected readonly deps: TransportDeps,
  ) {
    // The socket carries nothing but frames (F5; `FrameDecoderOptions.framesOnly`).
    this.decoder = launch.transport === 'socket' ? deps.codec.createFrameDecoder({ framesOnly: true }) : deps.codec.createFrameDecoder();
    this.maxPendingBytes = deps.maxPendingBytes ?? MAX_PENDING_PROTOCOL_BYTES;
    this.graceMs = deps.graceMs ?? GRACE_MS;
  }

  start(): Promise<void> {
    this.startPromise ??= this.begin();
    return this.startPromise;
  }

  abstract send(bytes: Uint8Array): void;

  get receivedBytes(): number {
    return this.received;
  }

  stop(): void {
    this.child?.stop();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.child?.kill();
    this.frameEmitter.dispose();
    this.stdoutEmitter.dispose();
    this.stderrEmitter.dispose();
    this.exitEmitter.dispose();
  }

  /** Starts the process and settles when `send` may be called. */
  protected abstract begin(): Promise<void>;

  /**
   * Starts the process through `core/process.ts`. A refusal thrown there (Restricted Mode, an
   * invalid path) becomes an exit with `spawnError`, reported asynchronously like every other
   * failed start; the returned text is then the reason.
   */
  protected spawnProcess(
    stdin: 'pipe' | 'ignore',
    handlers: { onSpawn(): void; onStdout(chunk: Uint8Array): void; onExit(exit: LongRunningExit): void },
  ): string | undefined {
    try {
      this.child = startLongRunningProcess(
        { executable: this.launch.executable, args: this.launch.args, cwd: this.launch.realCwd ?? this.launch.cwd, env: this.launch.env, stdin },
        { ...handlers, onStderr: (chunk) => this.emitStderr(chunk) },
        { trust: this.deps.trust, log: this.deps.log, platform: this.deps.platform, baseEnv: this.deps.processEnv, graceMs: this.graceMs },
      );
      return undefined;
    } catch (error) {
      const spawnError = errorMessage(error);
      queueMicrotask(() => handlers.onExit({ code: null, signal: null, spawnError }));
      return spawnError;
    }
  }

  /** Feeds bytes of the protocol stream to the decoder and emits the items it completes. */
  protected pushProtocol(chunk: Uint8Array): void {
    if (this.protocolEnded) {
      return;
    }
    this.received += chunk.length;
    this.pendingBytes += chunk.length;
    for (const item of this.decoder.push(chunk)) {
      this.pendingBytes -= item.byteLength;
      this.fire(this.frameEmitter, item);
    }
    if (this.pendingBytes > this.maxPendingBytes && !this.protocolEnded) {
      this.deps.log.warn(
        `${this.launch.executable}: more than ${this.maxPendingBytes} bytes of its protocol stream are not a frame; the process is stopped.`,
      );
      this.endProtocol(true);
      this.stop();
    }
  }

  /**
   * At the end of the protocol stream: the decoder's rest. When `overBound`, the transport gives
   * up on the stream while the process runs: what the decoder held is one `overflow` item,
   * whatever it was.
   */
  protected endProtocol(overBound = false): void {
    if (this.protocolEnded) {
      return;
    }
    this.protocolEnded = true;
    for (const item of this.decoder.end()) {
      const given: IncomingFrame = overBound ? { kind: 'overflow', text: item.text, byteLength: item.byteLength } : item;
      this.fire(this.frameEmitter, given);
    }
  }

  protected emitStdout(chunk: Uint8Array): void {
    const text = this.stdoutText.decode(chunk, { stream: true });
    if (text !== '') {
      this.fire(this.stdoutEmitter, text);
    }
  }

  private emitStderr(chunk: Uint8Array): void {
    const text = this.stderrText.decode(chunk, { stream: true });
    if (text !== '') {
      this.fire(this.stderrEmitter, text);
    }
  }

  /**
   * Fires `onExit` once, after the protocol stream's tail and the rest of stdout and stderr;
   * `connectionClosed`: the socket transport's connection closed first (`TransportExit`).
   */
  protected fireExit(exit: LongRunningExit, connectionClosed = false): void {
    if (this.exitFired) {
      return;
    }
    this.exitFired = true;
    this.endProtocol();
    const stdout = this.stdoutText.decode();
    if (stdout !== '') {
      this.fire(this.stdoutEmitter, stdout);
    }
    const stderr = this.stderrText.decode();
    if (stderr !== '') {
      this.fire(this.stderrEmitter, stderr);
    }
    this.fire(
      this.exitEmitter,
      exit.spawnError !== undefined ? exit : { code: exit.code, signal: exit.signal, ...(connectionClosed ? { connectionClosed } : {}) },
    );
  }

  /** A listener that throws must not break the stream handling: it is logged instead. */
  private fire<T>(emitter: Emitter<T>, value: T): void {
    try {
      emitter.fire(value);
    } catch (error) {
      this.deps.log.error(`A listener of the IDE-mode transport failed: ${errorMessage(error)}`);
    }
  }
}

/** `idris2 --ide-mode`: the protocol on stdin and stdout. */
class StdioTransport extends ProcessTransport {
  readonly kind = 'stdio' as const;

  protected begin(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.spawnProcess('pipe', {
        onSpawn: () => resolve(),
        onStdout: (chunk) => this.pushProtocol(chunk),
        onExit: (exit) => {
          // Settles nothing once `onSpawn` has resolved the start.
          reject(new Error(`idris2 ${describeExit(exit)}`));
          this.fireExit(exit);
        },
      });
    });
  }

  send(bytes: Uint8Array): void {
    this.child?.write(bytes);
  }
}

/** `idris2 --ide-mode-socket`: the port on stdout, the protocol on a TCP connection to it. */
class SocketTransport extends ProcessTransport {
  readonly kind = 'socket' as const;

  private socket: net.Socket | undefined;
  private connected = false;
  private stopped = false;
  private socketClosed = false;
  /** The compiler closed the connection while its process ran (not after `stop`). */
  private connectionClosed = false;
  private processExit: LongRunningExit | undefined;
  /** stdout after the last complete line before the port line; `undefined` once the port was read (or the start failed). */
  private head: Buffer | undefined = Buffer.alloc(0);
  /** Bytes of stdout forwarded before the port line. */
  private beforePort = 0;
  private port: number | undefined;
  private settleStart: { resolve(): void; reject(error: Error): void } | undefined;
  private socketTimer: NodeJS.Timeout | undefined;

  protected begin(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settleStart = { resolve, reject };
      this.spawnProcess('ignore', {
        onSpawn: () => undefined,
        onStdout: (chunk) => this.processStdout(chunk),
        onExit: (exit) => {
          const phase = this.port === undefined ? 'printing the port of its socket' : 'accepting the connection';
          this.failStart(`idris2 ${describeExit(exit)} before ${phase}`);
          this.processExit = exit;
          this.maybeFinish();
        },
      });
    });
  }

  send(bytes: Uint8Array): void {
    if (this.socket === undefined || !this.connected) {
      throw new Error('The IDE-mode socket is not connected.');
    }
    this.socket.write(bytes);
  }

  override stop(): void {
    this.stopped = true;
    super.stop();
    this.socket?.destroy();
  }

  override dispose(): void {
    super.dispose();
    this.socket?.destroy();
    if (this.socketTimer !== undefined) {
      clearTimeout(this.socketTimer);
    }
  }

  private failStart(reason: string): void {
    const settle = this.settleStart;
    this.settleStart = undefined;
    settle?.reject(new Error(reason));
  }

  private processStdout(chunk: Uint8Array): void {
    if (this.disposed) {
      return;
    }
    if (this.head === undefined) {
      this.emitStdout(chunk);
      return;
    }
    let head = Buffer.concat([this.head, chunk]);
    for (let newline = head.indexOf(0x0a); newline >= 0; newline = head.indexOf(0x0a)) {
      const line = head.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      const port = /^[0-9]{1,5}$/.test(line) ? Number(line) : 0;
      if (port >= 1 && port <= 65535) {
        this.head = undefined;
        this.port = port;
        this.deps.log.debug(`${this.launch.executable} listens on 127.0.0.1:${port}`);
        this.emitStdout(head.subarray(newline + 1));
        if (this.stopped) {
          this.failStart('the process was stopped before the connection was made');
          return;
        }
        this.connect(port);
        return;
      }
      // A line before the port (a log line, or why the socket could not be opened).
      this.emitStdout(head.subarray(0, newline + 1));
      this.beforePort += newline + 1;
      head = head.subarray(newline + 1);
    }
    this.head = Buffer.from(head);
    if (this.beforePort + head.length > MAX_BEFORE_PORT_BYTES) {
      this.head = undefined;
      this.emitStdout(head);
      this.failStart(`idris2 printed more than ${MAX_BEFORE_PORT_BYTES} bytes on stdout without the port of its socket`);
      this.stop();
    }
  }

  private connect(port: number): void {
    const socket = net.connect({ host: '127.0.0.1', port });
    this.socket = socket;
    // Requests are small and one at a time: send each at once.
    socket.setNoDelay(true);
    socket.on('connect', () => {
      this.connected = true;
      const settle = this.settleStart;
      this.settleStart = undefined;
      settle?.resolve();
    });
    socket.on('data', (chunk: Buffer) => this.pushProtocol(chunk));
    socket.on('error', (error: Error) => {
      // 'close' follows and stops the process.
      this.deps.log.debug(`IDE-mode socket 127.0.0.1:${port}: ${error.message}`);
      this.failStart(`could not connect to 127.0.0.1:${port} (${error.message})`);
    });
    socket.on('close', () => {
      this.socketClosed = true;
      this.endProtocol();
      if (this.processExit === undefined) {
        this.connectionClosed = this.connected && !this.stopped;
        this.child?.stop();
      }
      this.maybeFinish();
    });
  }

  private maybeFinish(): void {
    const exit = this.processExit;
    if (exit === undefined) {
      return;
    }
    if (this.socket === undefined || this.socketClosed) {
      this.fireExit(exit, this.connectionClosed);
    } else if (this.socketTimer === undefined) {
      // The process has ended; a descendant that inherited the socket may keep it open.
      this.socketTimer = setTimeout(() => this.socket?.destroy(), this.graceMs);
    }
  }
}
