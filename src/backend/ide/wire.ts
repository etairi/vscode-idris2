/**
 * Framing of the IDE protocol (`backend/ide/wire.ts`, docs/ARCHITECTURE.md §2, §5.1, D2). The
 * two directions count differently:
 *
 * - **Requests** (`encodeFrame`): six lower-case hex digits giving the **UTF-8 byte** length of
 *   the rest, then the text and `\n` (F1 [live]). The compiler reads exactly six characters and,
 *   if they are hex digits, that many more, one byte per character (`getInput`, `getNChars`,
 *   `src/Idris/IDEMode/REPL.idr` 98–115 on v0.8.0 [src]); a request can therefore have at most
 *   0xffffff bytes.
 * - **Replies** (`createFrameDecoder`): the prefix counts **code points** (F1 addendum [live]:
 *   `send` writes `leftPad '0' 6 (asHex (length r))`, where `length` counts the characters of an
 *   Idris `String`, then `r` as UTF-8; `src/Idris/IDEMode/Commands.idr` 41–47). `leftPad` does not
 *   truncate (`src/Protocol/Hex.idr`), so a reply of 0x1000000 code points or more has a longer
 *   prefix, and `asHex` writes lower-case digits. Every reply is a list (`toSExp` of each `Reply`
 *   constructor, `src/Protocol/IDE.idr`), so its text starts with `(`.
 *
 * **Headers.** The decoder recognises a reply frame by a header of **6 to 8 lower-case hex digits,
 * `(` and one of the six reply heads** the compiler writes (`(:return `, `(:output `,
 * `(:write-string `, `(:warning `, `(:set-prompt `, `(:protocol-version `: the constructors of
 * `Reply`, `src/Protocol/IDE.idr` 100–110 on v0.8.0 and master [src]; 8 digits cover 2^32 − 1
 * code points, beyond any reply), and cuts that many code points of UTF-8 text from the `(` on.
 * Anything else at the start of an item is `unframed` up to and including the next `\n`: over
 * stdio, program output, the compiler's log lines (`LOG <topic>:<level>: …`, written with
 * `putStrLn` to stdout, `src/Core/Context/Log.idr` 16–20 on v0.8.0 [src]; a `%logging` pragma in
 * a loaded file prints them [live]) and the end-of-input line `Alas the file is done, aborting`
 * (F5), and any other noise. Requiring `(` and a head keeps output such as `abcdef\n` or
 * `00000a(hello)\n` from being taken for a frame, which would swallow the next reply's bytes. The
 * heads are also required because log lines can quote protocol text: `ide-mode.recv` logs each
 * request with its header (`Received: 00000d(:version 1)`, `REPL.idr` 474), and `ide-mode.send`
 * logs each reply without one (`Commands.idr` 44) [src]. What remains at the end of the stream
 * (`end`) is one item: `truncated` when it is a frame shorter than its prefix says (or a header
 * whose head is still incomplete), else `unframed` (a last line without its `\n`).
 *
 * **A reply glued to output.** Program output without a final newline is followed at once by the
 * next reply: `:exec putStr "hi"` over stdio gave `hi000015(:return (:ok "") 1)\n`, and
 * `:exec putStr "7"` gave `7000015(:return (:ok "") 1)\n` [live, 0.8.0, transcripts
 * `exec-stdio-putstr` and `exec-stdio-putstr-digit`]. So an unframed line is also ended **before** a six-digit header
 * with a reply head in its middle; the text before it is one `unframed` item without a `\n`, and
 * the frame is read from the header on. At the start of an item the output and the header run
 * together when the output is one or two hex digits (`7000015(`, `ab000015(`): the digits could be
 * a header of 7 or 8 digits, or output followed by a six-digit one. `asHex` writes no leading
 * zero, and `leftPad` pads to six digits only (`src/Protocol/Hex.idr` [src]), so a header of 7 or
 * 8 digits never starts with `0`; the other readings are told apart by where the frame ends: every
 * reply ends with `\n` (`send` appends it, `Commands.idr` 41–47 [src]). The decoder tries the
 * shortest reading first — output followed by a six-digit header — and takes it when the frame it
 * gives ends with `\n` (the output is then emitted as one `unframed` item before the frame), else
 * the next longer one; the longest is taken as it is. Only a reply of 0x1000000 code points or
 * more whose code point at the position a shorter reading names happens to be a `\n` is misread
 * (the decoder then desynchronises). In the middle of a line only six-digit headers are
 * recognised, and at the start of an item at most eight digits, so such a reply (a seven-digit
 * header) glued to any output other than a single hex digit — non-hex text, two or more hex
 * digits, several characters — is misread as well: its last six digits are taken for its header
 * (M2 verification of the third review, with real 0x1000015-code-point frames: correct after
 * `7` or `0`, misread after `x`, `ab` or `hi`). A reply with an eight-digit header (0x10000000
 * code points or more) glued to any output is misread too, but no such reply passes the
 * transport's bound (`MAX_PENDING_PROTOCOL_BYTES`).
 *
 * **Log lines that quote a header** (stdio only; a known limitation). The glued-header rule applies
 * inside every unframed line, so a compiler log line that quotes text containing a six-digit
 * header and a reply head — a string literal `"000015(:return x"` in a term that `%logging
 * "declare.def" 3` prints — is cut there, and the "frame" read from it is garbage: the check fails
 * with a protocol error and the session restarts, at every check of that file [live, 0.8.0, stdio,
 * run by the verifying reviewer of the M2 third review]. The heads keep the compiler's own protocol logging
 * (`ide-mode.recv`, `ide-mode.send`) safe, not user text in logged terms. Not reading the rule in
 * lines that start with `LOG <topic>:<level>: ` would narrow this but not close it (a logged term
 * can span lines, and `ide-mode.send` echoes raw line breaks), at the cost of program output
 * starting with `LOG ` and lacking a newline swallowing the next reply; it is left as it is. On
 * the socket (an opt-in in user settings since ROADMAP §9 Q20; stdio, where this limitation
 * applies, is the default on every platform) log lines go to stdout, not into the protocol stream.
 *
 * **Streams of frames only** (`FrameDecoderOptions.framesOnly`, the socket, F5). No output can
 * precede a header there, so at the start of an item 6 to 8 hex digits and `(` are a header — all
 * of the digits, whatever the head: a well-formed reply of a newer compiler with a head this
 * extension does not know is decoded as a frame and ignored as a message of an unknown shape
 * (before, the head was required on the socket too, and such a frame became `unframed`, which the
 * session treats as a protocol error there). At the end of such a stream whatever is left is
 * `truncated` — also a header cut before its `(` — so that the session reports the process's exit
 * with it rather than a protocol error. What is not a header there is `unframed` up to its `\n`
 * (no reply can be glued into it), which the session treats as a protocol error.
 *
 * **Line ends.** Every reply ends with `\n` (`send` appends it, `Commands.idr` 41–47), counted in
 * the prefix. Whether the compiler's stdout on Windows is in text mode is not known (ROADMAP E13
 * [open]); a C runtime in text mode writes every `\n` as `\r\n` — also the raw line breaks
 * inside a reply's strings, which `Show SExp` does not escape (`src/Protocol/SExp.idr` 16–27
 * [src]; every multi-line error message has them) — without changing the prefix. The decoder
 * undoes exactly that translation. It decides the stream's line ends at the first frame, the
 * handshake `(:protocol-version 2 1)`, which has no line break inside: when the code point that
 * would complete it is a `\r` followed by `\n`, the stream is **CRLF**, else **LF**. In a CRLF
 * stream every `\r` immediately followed by `\n` counts as no code point and is dropped from
 * the frame's text (the runtime inserted it; an original `\r\n` arrives as `\r\r\n` and counts
 * as two), so a frame's text is what the compiler wrote. In an LF stream every byte counts as
 * the compiler counted it. Unframed items are kept as they arrived.
 *
 * Code points are counted as the WHATWG UTF-8 decoder (`TextDecoder`, which then decodes the
 * frame's bytes) produces them, including one U+FFFD per malformed sequence, so a frame's text
 * always has exactly the code points its prefix names. The compiler writes valid UTF-8; the
 * error rule matters only for corrupted streams, which then yield an `invalid` or `unknown`
 * message rather than a desynchronised decoder. Chunks may split the stream anywhere, including
 * inside the header and inside a UTF-8 sequence; the buffer grows geometrically, so the work per
 * byte is constant however a large reply is chunked.
 */
import type { FrameDecoder, FrameDecoderOptions, IncomingFrame, OutgoingFrame } from './types';

/** The largest request the compiler's six-digit reader can take, in bytes. */
export const MAX_REQUEST_BYTES = 0xffffff;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Frames `text` as one request: the prefix, `text`, `\n`. Throws a `RangeError` when `text` and
 * the newline exceed `MAX_REQUEST_BYTES`.
 */
export function encodeFrame(text: string): OutgoingFrame {
  const payload = encoder.encode(`${text}\n`);
  if (payload.length > MAX_REQUEST_BYTES) {
    throw new RangeError(`a request of ${payload.length} bytes exceeds the protocol's ${MAX_REQUEST_BYTES}`);
  }
  const prefix = payload.length.toString(16).padStart(6, '0');
  const bytes = new Uint8Array(prefix.length + payload.length);
  bytes.set(encoder.encode(prefix), 0);
  bytes.set(payload, prefix.length);
  return { text: `${prefix}${text}\n`, bytes };
}

export function createFrameDecoder(options: FrameDecoderOptions = {}): FrameDecoder {
  return new ReplyDecoder(options.framesOnly === true);
}

const LF = 0x0a;
const CR = 0x0d;
const OPEN = 0x28;
const ZERO = 0x30;
const MIN_HEADER_DIGITS = 6;
const MAX_HEADER_DIGITS = 8;
/** The digits of a header recognised in the middle of a line (see "A reply glued to output"). */
const GLUED_HEADER_DIGITS = 6;
/** What follows the `(` of each reply the compiler writes (`Reply`, `src/Protocol/IDE.idr`). */
const REPLY_HEADS: readonly Uint8Array[] = ['return', 'output', 'write-string', 'warning', 'set-prompt', 'protocol-version'].map(
  (head) => new TextEncoder().encode(`:${head} `),
);

function isLowerHex(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
}

/**
 * One reading of the hex digits before a frame's `(` (see "A reply glued to output"): the header
 * starts at `start` (the digits before it are output) and names `codePoints`.
 */
interface Reading {
  readonly start: number;
  readonly codePoints: number;
}

/** Where the decoder is in the current item; offsets are relative to the item's first byte. */
type State =
  | { readonly kind: 'start' }
  | { readonly kind: 'line'; scanned: number }
  | {
      readonly kind: 'frame';
      /** The offset of the frame's `(`, where its text starts. */
      readonly headerLength: number;
      /** The readings of the digits, shortest header first; `reading` is the one being counted. */
      readonly readings: readonly Reading[];
      reading: number;
      /** Offset of the next byte to count, the code points counted, the UTF-8 decoder's state. */
      scanned: number;
      counted: number;
      needed: number;
      seen: number;
      lower: number;
      upper: number;
    };

/** The stream's line ends (see "Line ends" above): unknown until the first frame is complete. */
type LineEnds = 'unknown' | 'lf' | 'crlf';

class ReplyDecoder implements FrameDecoder {
  private readonly buffer = new ByteQueue();
  private state: State = { kind: 'start' };
  private lineEnds: LineEnds = 'unknown';

  /** `framesOnly`: see *Streams of frames only* above. */
  constructor(private readonly framesOnly: boolean) {}

  push(chunk: Uint8Array): IncomingFrame[] {
    this.buffer.append(chunk);
    const items: IncomingFrame[] = [];
    for (let item = this.next(); item !== undefined; item = this.next()) {
      items.push(item);
    }
    return items;
  }

  end(): IncomingFrame[] {
    const length = this.buffer.length;
    // A header whose reply head is still incomplete is most likely a frame cut short; on a stream
    // of frames only, anything left is.
    const kind =
      this.framesOnly || this.state.kind === 'frame' || (this.state.kind === 'start' && this.header() === 'partialHead') ? 'truncated' : 'unframed';
    const items = length === 0 ? [] : [this.take(kind, 0, length)];
    this.lineEnds = 'unknown';
    return items;
  }

  /** The next complete item, or `undefined` when more bytes are needed. */
  private next(): IncomingFrame | undefined {
    if (this.state.kind === 'start') {
      const header = this.header();
      if (header === 'more' || header === 'partialHead') {
        return undefined;
      }
      this.state = header === 'line' ? { kind: 'line', scanned: 0 } : header;
    }
    if (this.state.kind === 'line') {
      return this.scanLine(this.state);
    }
    return this.countFrame(this.state);
  }

  /**
   * What the item at the start of the buffer is ("Headers", "A reply glued to output"): a frame
   * (with the readings of its digits), a `line`, or not known yet — `more` while every byte is a
   * hex digit, `partialHead` while the bytes after the digits' `(` could still become a reply head.
   */
  private header(): Extract<State, { kind: 'frame' }> | 'line' | 'more' | 'partialHead' {
    const buffer = this.buffer;
    let digits = 0;
    while (digits < buffer.length && digits <= MAX_HEADER_DIGITS && isLowerHex(buffer.at(digits))) {
      digits++;
    }
    if (digits === buffer.length && digits <= MAX_HEADER_DIGITS) {
      return 'more';
    }
    if (digits < MIN_HEADER_DIGITS || digits > MAX_HEADER_DIGITS || buffer.at(digits) !== OPEN) {
      return 'line';
    }
    if (this.framesOnly) {
      // Nothing but frames: the digits are the header, whatever the head.
      const codePoints = parseInt(buffer.ascii(0, digits), 16);
      return codePoints > 0 ? this.frame(digits, [{ start: 0, codePoints }]) : 'line';
    }
    const head = this.replyHead(digits);
    if (head !== 'head') {
      return head === 'more' ? 'partialHead' : 'line';
    }
    const readings: Reading[] = [];
    for (let length = MIN_HEADER_DIGITS; length <= digits; length++) {
      const start = digits - length;
      // `asHex` writes no leading zero: only the padding of a six-digit header is `0`.
      if (length === MIN_HEADER_DIGITS || buffer.at(start) !== ZERO) {
        const codePoints = parseInt(buffer.ascii(start, digits), 16);
        if (codePoints > 0) {
          readings.push({ start, codePoints });
        }
      }
    }
    return readings.length === 0 ? 'line' : this.frame(digits, readings);
  }

  /** The state of a frame whose text starts after `headerLength` bytes. */
  private frame(headerLength: number, readings: readonly Reading[]): Extract<State, { kind: 'frame' }> {
    return { kind: 'frame', headerLength, readings, reading: 0, scanned: headerLength, counted: 0, needed: 0, seen: 0, lower: 0x80, upper: 0xbf };
  }

  /**
   * An unframed line: up to and including its `\n`, or up to a reply header glued into it (see
   * "A reply glued to output"), which becomes the next item.
   */
  private scanLine(line: Extract<State, { kind: 'line' }>): IncomingFrame | undefined {
    const buffer = this.buffer;
    for (let i = line.scanned; i < buffer.length; i++) {
      const byte = buffer.at(i);
      if (byte === LF) {
        return this.take('unframed', 0, i + 1);
      }
      if (byte === OPEN && i > GLUED_HEADER_DIGITS && !this.framesOnly) {
        const glued = this.gluedHeader(i);
        if (glued === 'more') {
          line.scanned = i;
          return undefined;
        }
        if (glued === 'header') {
          return this.take('unframed', 0, i - GLUED_HEADER_DIGITS);
        }
      }
    }
    line.scanned = buffer.length;
    return undefined;
  }

  /**
   * Whether the `(` at `open` (inside a line) ends a six-digit reply header: `more` when the
   * bytes after it could still turn out to be a reply head.
   */
  private gluedHeader(open: number): 'header' | 'none' | 'more' {
    const buffer = this.buffer;
    let count = 0;
    for (let i = open - GLUED_HEADER_DIGITS; i < open; i++) {
      const byte = buffer.at(i);
      if (!isLowerHex(byte)) {
        return 'none';
      }
      count = count * 16 + (byte <= 0x39 ? byte - 0x30 : byte - 0x57);
    }
    if (count === 0) {
      return 'none';
    }
    const head = this.replyHead(open);
    return head === 'head' ? 'header' : head;
  }

  /** Whether the `(` at `open` is followed by a reply head: `more` while the bytes after it could still become one. */
  private replyHead(open: number): 'head' | 'none' | 'more' {
    const buffer = this.buffer;
    let more = false;
    for (const head of REPLY_HEADS) {
      let matched = 0;
      while (matched < head.length && open + 1 + matched < buffer.length && buffer.at(open + 1 + matched) === head[matched]) {
        matched++;
      }
      if (matched === head.length) {
        return 'head';
      }
      more ||= open + 1 + matched === buffer.length;
    }
    return more ? 'more' : 'none';
  }

  /**
   * Advances the WHATWG UTF-8 decoder (Encoding Standard, "UTF-8 decoder") over the payload. When
   * the current reading's code points are counted and the last one is not a `\n`, the next longer
   * reading is counted on from there ("A reply glued to output"): its text starts at the same `(`.
   */
  private countFrame(frame: Extract<State, { kind: 'frame' }>): IncomingFrame | undefined {
    const buffer = this.buffer;
    let { scanned: i, counted, needed, seen, lower, upper } = frame;
    let codePoints = frame.readings[frame.reading].codePoints;
    for (;;) {
      while (counted < codePoints && i < buffer.length) {
        const byte = buffer.at(i);
        if (needed === 0) {
          if (byte === CR && (this.lineEnds === 'crlf' || (this.lineEnds === 'unknown' && counted + 1 === codePoints))) {
            // A `\r` the C runtime may have inserted before a `\n` ("Line ends" above).
            if (i + 1 === buffer.length) {
              break; // the next byte decides
            }
            if (buffer.at(i + 1) === LF) {
              this.lineEnds = 'crlf';
              i++;
              continue;
            }
          }
          i++;
          if (byte < 0x80) {
            counted++;
          } else if (byte >= 0xc2 && byte <= 0xdf) {
            needed = 1;
          } else if (byte >= 0xe0 && byte <= 0xef) {
            lower = byte === 0xe0 ? 0xa0 : 0x80;
            upper = byte === 0xed ? 0x9f : 0xbf;
            needed = 2;
          } else if (byte >= 0xf0 && byte <= 0xf4) {
            lower = byte === 0xf0 ? 0x90 : 0x80;
            upper = byte === 0xf4 ? 0x8f : 0xbf;
            needed = 3;
          } else {
            counted++; // not a lead byte: one U+FFFD
          }
        } else if (byte < lower || byte > upper) {
          // An incomplete sequence: one U+FFFD, and this byte is read again as a lead byte.
          needed = 0;
          seen = 0;
          lower = 0x80;
          upper = 0xbf;
          counted++;
        } else {
          i++;
          lower = 0x80;
          upper = 0xbf;
          seen++;
          if (seen === needed) {
            needed = 0;
            seen = 0;
            counted++;
          }
        }
      }
      if (counted < codePoints) {
        frame.scanned = i;
        frame.counted = counted;
        frame.needed = needed;
        frame.seen = seen;
        frame.lower = lower;
        frame.upper = upper;
        return undefined;
      }
      // Complete. The last code point is a `\n` exactly when the last byte read is one: a `\n`
      // is one byte, and a U+FFFD for an incomplete sequence leaves its lead byte last.
      if (frame.reading + 1 === frame.readings.length || buffer.at(i - 1) === LF) {
        break;
      }
      frame.reading++;
      codePoints = frame.readings[frame.reading].codePoints;
    }
    if (this.lineEnds === 'unknown') {
      this.lineEnds = 'lf';
    }
    const output = frame.readings[frame.reading].start;
    if (output === 0) {
      return this.take('framed', frame.headerLength, i);
    }
    // Output ran into the header: it is an item of its own, followed by the frame, now complete.
    const item = this.take('unframed', 0, output);
    this.state = {
      kind: 'frame',
      headerLength: frame.headerLength - output,
      readings: [{ start: 0, codePoints }],
      reading: 0,
      scanned: i - output,
      counted,
      needed,
      seen,
      lower,
      upper,
    };
    return item;
  }

  /** Removes the item's `length` bytes from the buffer; its text starts at `textStart`. */
  private take(kind: IncomingFrame['kind'], textStart: number, length: number): IncomingFrame {
    const decoded = decoder.decode(this.buffer.view(textStart, length));
    // In a CRLF stream the `\r` before each `\n` of a frame counted as nothing: it is dropped.
    const text = kind === 'framed' && this.lineEnds === 'crlf' ? decoded.replace(/\r\n/g, '\n') : decoded;
    this.buffer.consume(length);
    this.state = { kind: 'start' };
    return { kind, text, byteLength: length };
  }
}

/** A byte buffer that is appended at the end and consumed from the front. */
class ByteQueue {
  private static readonly initialCapacity = 4096;
  /** Above this capacity an empty buffer is given back, so one huge reply does not pin memory. */
  private static readonly retainedCapacity = 1 << 20;
  private data = new Uint8Array(ByteQueue.initialCapacity);
  private head = 0;
  private tail = 0;

  get length(): number {
    return this.tail - this.head;
  }

  at(offset: number): number {
    return this.data[this.head + offset];
  }

  /** The bytes from `start` to `end` (offsets); valid until the next `append`. */
  view(start: number, end: number): Uint8Array {
    return this.data.subarray(this.head + start, this.head + end);
  }

  ascii(start: number, end: number): string {
    return String.fromCharCode(...this.view(start, end));
  }

  indexOf(byte: number, from: number): number {
    const index = this.data.subarray(this.head + from, this.tail).indexOf(byte);
    return index < 0 ? -1 : from + index;
  }

  append(chunk: Uint8Array): void {
    if (this.tail + chunk.length > this.data.length) {
      const live = this.length;
      const needed = live + chunk.length;
      if (needed <= this.data.length / 2) {
        this.data.copyWithin(0, this.head, this.tail);
      } else {
        let capacity = this.data.length * 2;
        while (capacity < needed) {
          capacity *= 2;
        }
        const grown = new Uint8Array(capacity);
        grown.set(this.data.subarray(this.head, this.tail));
        this.data = grown;
      }
      this.head = 0;
      this.tail = live;
    }
    this.data.set(chunk, this.tail);
    this.tail += chunk.length;
  }

  consume(count: number): void {
    this.head += count;
    if (this.head === this.tail) {
      this.head = 0;
      this.tail = 0;
      if (this.data.length > ByteQueue.retainedCapacity) {
        this.data = new Uint8Array(ByteQueue.initialCapacity);
      }
    }
  }
}
