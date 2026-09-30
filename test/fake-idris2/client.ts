/**
 * A minimal IDE-mode client for the tests that talk to an IDE-mode process byte by byte — the
 * fake compiler's unit tests and the e2e parity test that gives the real compiler and the fake
 * the same bytes: request frames, a reader of reply frames, and the recorded transcripts
 * (test/fixtures/transcripts/README.md). It is independent of `src/backend/ide` on purpose, so
 * that the fake is not tested with the code it is meant to test.
 */
import * as fs from 'fs';
import type * as net from 'net';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { repoRoot } from '../fake-tools/paths';

/** A request frame: 6 hex digits of the UTF-8 byte length of `text` (F1), then `text`. */
export function requestFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(6, '0'), 'ascii'), body]);
}

export interface Frame {
  /** The 6-hex prefix as sent; -1 for an unframed line. */
  readonly prefix: number;
  /** The frame text, decoded as UTF-8, including the trailing newline. */
  readonly text: string;
}

/**
 * A reply header: six hex digits, `(` and the head of a reply (`Reply` in `Protocol/IDE.idr`). The
 * head is required, so that output such as `00000a(hello)` is not read as a frame.
 */
const REPLY_HEADER = /[0-9a-f]{6}\(:(?:return|output|write-string|warning|set-prompt|protocol-version) /;

/**
 * Reads reply frames. The compiler's prefix counts the Unicode code points of the reply (F1
 * addendum), so frames are cut by code points, not bytes. Anything that does not start with a
 * reply header is returned as an unframed line (prefix -1), ended by its newline or by a reply
 * header after it — also one that follows output of one or two hex digits at once (`7000015(`
 * after `:exec putStr "7"`, `exec-stdio-putstr-digit`). Only six-digit headers are read: the
 * replies these tests see are far below 0x1000000 code points.
 */
export class FrameReader {
  private pending = '';
  private ended = false;
  private readonly decoder = new StringDecoder('utf8');
  private readonly waiters: (() => void)[] = [];

  constructor(stream: NodeJS.ReadableStream) {
    const wake = (): void => this.waiters.splice(0).forEach((w) => w());
    stream.on('data', (chunk: Buffer) => {
      this.pending += this.decoder.write(chunk);
      wake();
    });
    stream.on('end', () => {
      this.ended = true;
      wake();
    });
  }

  private take(): Frame | undefined {
    const header = REPLY_HEADER.exec(this.pending);
    if (header?.index === 0) {
      const prefix = parseInt(this.pending.slice(0, 6), 16);
      const rest = Array.from(this.pending.slice(6));
      if (rest.length < prefix) {
        return undefined;
      }
      this.pending = rest.slice(prefix).join('');
      return { prefix, text: rest.slice(0, prefix).join('') };
    }
    const nl = this.pending.indexOf('\n');
    const end = header !== null && (nl < 0 || header.index < nl) ? header.index : nl < 0 ? -1 : nl + 1;
    if (end < 0) {
      return undefined;
    }
    const line = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    return { prefix: -1, text: line };
  }

  /** The next frame; rejects when the stream ends first (with what was left unread). */
  async next(): Promise<Frame> {
    for (;;) {
      const frame = this.take();
      if (frame !== undefined) {
        return frame;
      }
      if (this.ended) {
        throw new Error(`the stream ended before a complete frame; unread: ${JSON.stringify(this.pending)}`);
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Everything after the frames read so far, once the stream has ended. */
  async rest(): Promise<string> {
    while (!this.ended) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.pending;
  }
}

/**
 * This process's environment without the variables that change the fake compiler's behaviour
 * (test/fake-tools/README.md, test/fake-idris2/README.md), with `overrides` on top: a developer
 * shell that sets one of them does not change what a test sees.
 */
export function fakeEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^FAKE_(IDRIS2|TOOL)_/.test(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

/**
 * These tests check the fake's replies and exit code, not how its side of the connection goes
 * away. On the GitHub windows-latest runner the client socket receives ECONNRESET when the fake
 * exits (observed in CI, 2026-09-27; macOS and Linux see an orderly close), and without a
 * handler that error is uncaught and fails the test. Ignore exactly that error; the returned
 * function rethrows any other socket error, so call it at the end of the test.
 */
export function tolerateReset(socket: net.Socket): () => void {
  let unexpected: Error | undefined;
  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ECONNRESET') {
      unexpected ??= error;
    }
  });
  return () => {
    if (unexpected) {
      throw unexpected;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Transcripts (test/fixtures/transcripts/README.md "Format")
// ---------------------------------------------------------------------------------------------

export interface TranscriptMeta {
  readonly kind: 'meta';
  readonly format: 1;
  readonly scenario: string;
  readonly facts: readonly string[];
  readonly idris2: { readonly version: string };
  readonly transport: 'stdio' | 'socket';
  readonly args: readonly string[];
  /** The session directory, relative to the repository root. */
  readonly cwd: string;
  /** `${ROOT}` or `${LINK}`. */
  readonly processCwd: string;
  readonly placeholders: Readonly<Record<string, number>>;
  readonly fixtures: Readonly<Record<string, string>>;
}

export type TranscriptEvent =
  | { readonly kind: 'send' | 'recv'; readonly prefix: string; readonly text: string }
  | { readonly kind: 'unframed' | 'stdout' | 'stderr'; readonly text: string }
  | { readonly kind: 'close' | 'socket-end' }
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'files'; readonly written: readonly string[] };

export interface Transcript {
  readonly meta: TranscriptMeta;
  readonly events: readonly TranscriptEvent[];
}

/** `test/fixtures/transcripts/<version>`. */
export function transcriptsDir(version: string): string {
  return path.join(repoRoot(), 'test', 'fixtures', 'transcripts', version);
}

/** Every transcript of `dir`, sorted by scenario name. */
export function readTranscripts(dir: string): Transcript[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => {
      const [meta, ...events] = fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as unknown);
      return { meta: meta as TranscriptMeta, events: events as TranscriptEvent[] };
    });
}

/** What the compiler sent in reply to a request: a frame, or program output (F5). */
export type ReplyItem = { readonly kind: 'frame' | 'output'; readonly text: string };

/** One recorded request and what the compiler sent for it, up to the next request or `close`. */
export interface Exchange {
  /** The request frame's text (without the prefix). */
  readonly request: string;
  /**
   * The reply frames' texts and the program output (`unframed` over stdio, `stdout` over the
   * socket), in the order the recorder saw them.
   */
  readonly replies: readonly ReplyItem[];
}

/**
 * The exchanges of a transcript, and the program output after the recorder ended the input (the
 * end-of-input line, F5) with the recorded exit code.
 */
export function exchanges(transcript: Transcript): { exchanges: Exchange[]; tailOutput: string; exitCode: number | null } {
  const result: { request: string; replies: ReplyItem[] }[] = [];
  let tailOutput = '';
  let exitCode: number | null = null;
  let closed = false;
  for (const event of transcript.events) {
    if (event.kind === 'close') {
      closed = true;
    } else if (event.kind === 'exit') {
      exitCode = event.code;
    } else if (event.kind === 'send' && !closed) {
      result.push({ request: event.text, replies: [] });
    } else if (result.length === 0) {
      continue; // the port line and the handshake
    } else if (event.kind === 'recv' && !closed) {
      result[result.length - 1].replies.push({ kind: 'frame', text: event.text });
    } else if (event.kind === 'unframed' || event.kind === 'stdout') {
      if (closed) {
        tailOutput += event.text;
      } else {
        result[result.length - 1].replies.push({ kind: 'output', text: event.text });
      }
    }
  }
  return { exchanges: result, tailOutput, exitCode };
}

/**
 * `text` (a recorded frame's text) with each placeholder replaced by its value. The recorded
 * placeholders stand inside s-expression strings, so a value is escaped as the compiler's
 * `show` escapes a string (`\` and `"`).
 */
export function substitute(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\$\{(ROOT|LINK)\}/g, (whole, name: string) => {
    const value = values[`\${${name}}`];
    return value === undefined ? whole : value.replace(/[\\"]/g, (c) => `\\${c}`);
  });
}

/**
 * A recorded scenario's arguments after the mode flag, with the placeholders spelled as `values`
 * give (unescaped: these are command-line arguments, not s-expression strings): the `check`
 * session's (`load-symlink`'s names its directory through the link), or (M3) the
 * `eval` session's, whose build directory is `build/.vscode-idris2-eval`
 * (`src/backend/ide/types.ts` `SessionRole`).
 */
export function recordedArgs(transcript: Transcript, values: Readonly<Record<string, string>>): string[] {
  return transcript.meta.args
    .slice(1)
    .map((arg) => arg.replace(/\$\{(ROOT|LINK)\}/g, (whole, name: string) => values[`\${${name}}`] ?? whole));
}

/** The same text with every trailing request id `n` of `(… n)\n` replaced by `map(n)`. */
export function mapTrailingId(text: string, map: (id: bigint) => bigint): string {
  return text.replace(/ ([0-9]+)\)\n$/, (_, id: string) => ` ${map(BigInt(id))})\n`);
}
