#!/usr/bin/env node
// fake-idris2: a stand-in for the `idris2` binary that tests run instead of the real compiler
// (docs/ARCHITECTURE.md §12). M0 skeleton: `--version`, and the IDE protocol's start-up
// handshake plus the `version` command over stdio (`--ide-mode`) and TCP (`--ide-mode-socket`).
// The behaviour mirrors Idris 2 0.8.0 (15a3e4e); each rule cites the compiler source it follows.
// README.md says what was compared byte for byte with the real binary and what is not mirrored.
import net from 'node:net';
import process from 'node:process';

const VERSION_LINE = 'Idris 2, version 0.8.0';
const ALAS = 'Alas the file is done, aborting';
const READ_FAILED = 'Failed to read a character';

// ---------------------------------------------------------------------------------------------
// S-expressions (src/Protocol/SExp.idr, src/Protocol/SExp/Parser.idr — identical on master)
// Values: {t:'list', items} | {t:'sym', name} | {t:'str', value} | {t:'int', value: bigint}
//         | {t:'bool', value}
// ---------------------------------------------------------------------------------------------

class SExpError extends Error {}

// Prelude.Types isSpace; the lexer's whitespace rule is `some (pred isSpace)`.
const isSpace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f'
  || c === '\v' || c === '\xa0';
const isAsciiAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const isDigit = (c) => c >= '0' && c <= '9';
// Parser/Lexer/Common.idr isIdentStart / isIdentTrailing, flavour AllowDashes.
const isIdentStart = (c) => c === '_' || isAsciiAlpha(c) || c.codePointAt(0) > 160;
const isIdentTrailing = (c) => c === '-' || c === '\'' || c === '_' || isAsciiAlpha(c)
  || isDigit(c) || c.codePointAt(0) > 160;

/** `ideTokens`: ordered alternatives, whitespace dropped (`notWhitespace`). */
function lex(input) {
  const cs = Array.from(input);
  const toks = [];
  let i = 0;
  while (i < cs.length) {
    const c = cs[i];
    if (c === '(' || c === ':' || c === ')') {
      toks.push({ k: 'symbol', v: c });
      i++;
    } else if (isDigit(c)) {
      let j = i;
      while (j < cs.length && isDigit(cs[j])) { j++; }
      toks.push({ k: 'int', v: BigInt(cs.slice(i, j).join('')) });
      i = j;
    } else if (c === '"') {
      // stringTokens = someUntil (is '"') (escape (is '\\') any <|> any)
      let j = i + 1;
      while (j < cs.length && cs[j] !== '"') { j += cs[j] === '\\' && j + 1 < cs.length ? 2 : 1; }
      if (j >= cs.length) { throw new SExpError(`unterminated string starting at character ${i}`); }
      toks.push({ k: 'string', v: cs.slice(i + 1, j).join('') });
      i = j + 1;
    } else if (isSpace(c)) {
      i++;
    } else if (isIdentStart(c)) {
      let j = i + 1;
      while (j < cs.length && isIdentTrailing(cs[j])) { j++; }
      toks.push({ k: 'ident', v: cs.slice(i, j).join('') });
      i = j;
    } else {
      throw new SExpError(`cannot recognise a token at character ${i}`);
    }
  }
  return toks;
}

/** `parseSExp`: one `sexp` followed by end of input. */
function parseSExp(input) {
  const toks = lex(input);
  let p = 0;
  const sexp = () => {
    const t = toks[p];
    if (t === undefined) { throw new SExpError('unexpected end of input'); }
    if (t.k === 'int') { p++; return { t: 'int', value: t.v }; }
    if (t.k === 'string') { p++; return { t: 'str', value: unescape(t.v) }; }
    if (t.k === 'symbol' && t.v === ':') {
      const n = toks[p + 1];
      if (n === undefined || n.k !== 'ident') { throw new SExpError(`expected a name after ':' (token ${p})`); }
      p += 2;
      if (n.v === 'True' || n.v === 'False') { return { t: 'bool', value: n.v === 'True' }; }
      return { t: 'sym', name: n.v };
    }
    if (t.k === 'symbol' && t.v === '(') {
      p++;
      const items = [];
      while (toks[p] !== undefined && !(toks[p].k === 'symbol' && toks[p].v === ')')) { items.push(sexp()); }
      if (toks[p] === undefined) { throw new SExpError(`expected ')' (token ${p})`); }
      p++;
      return { t: 'list', items };
    }
    throw new SExpError(`unexpected ${t.k} (token ${p})`);
  };
  const result = sexp();
  if (p !== toks.length) { throw new SExpError(`expected end of input (token ${p})`); }
  return result;
}

// Parser/Support/Escaping.idr getEsc: ASCII control-character names.
const ESC_NAMES = new Map(['NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'HT',
  'LF', 'VT', 'FF', 'CR', 'SO', 'SI', 'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
  'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'].map((n, i) => [n, String.fromCharCode(i)])
  .concat([['SP', ' '], ['DEL', '\x7f']]));
const SIMPLE_ESC = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '\'': '\'', '"': '"' };

/** `cast` Int to Char on the Chez backend (support/chez/support.ss `cast-int-char`). */
const castIntChar = (n) => ((n >= 0 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0x10ffff)
  ? String.fromCodePoint(n) : '\0');

/**
 * Parser/Support/Escaping.idr `unescape 0`, transcribed case by case. Numeric escapes whose
 * value exceeds 2^53 are not guaranteed to match (Idris converts through a 64-bit Int; how the
 * Chez backend treats the overflow was not investigated).
 */
function unescape(raw) {
  const cs = Array.from(raw);
  let out = '';
  let i = 0;
  const span = (from, pred) => { let j = from; while (j < cs.length && pred(cs[j])) { j++; } return j; };
  while (i < cs.length) {
    if (cs[i] !== '\\') { out += cs[i++]; continue; }
    const c = cs[i + 1];
    if (Object.hasOwn(SIMPLE_ESC, c)) { out += SIMPLE_ESC[c]; i += 2; }
    else if (c === '\n' || c === '&') { i += 2; }
    else if (c === 'x' || c === 'o') {
      const radix = c === 'x' ? 16 : 8;
      const j = span(i + 2, radix === 16 ? (d) => /[0-9a-fA-F]/.test(d) : (d) => /[0-7]/.test(d));
      if (j > i + 2) { out += castIntChar(parseInt(cs.slice(i + 2, j).join(''), radix)); }
      i = j;
    } else if (isDigit(c)) {
      const j = span(i + 1, isDigit);
      out += castIntChar(parseInt(cs.slice(i + 1, j).join(''), 10));
      i = j;
    } else {
      const three = cs.slice(i + 1, i + 4).join('');
      const two = cs.slice(i + 1, i + 3).join('');
      if (three.length === 3 && ESC_NAMES.has(three)) { out += ESC_NAMES.get(three); i += 4; }
      else if (two.length === 2 && ESC_NAMES.has(two)) { out += ESC_NAMES.get(two); i += 3; }
      else { i += 1; } // no escape: the backslash is dropped, the rest is re-read
    }
  }
  return out;
}

/** `Show SExp`: strings escape only `\` and `"`. */
function show(s) {
  switch (s.t) {
    case 'list': return `(${s.items.map(show).join(' ')})`;
    case 'str': return `"${s.value.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
    case 'bool': return s.value ? ':True' : ':False';
    case 'int': return s.value.toString();
    case 'sym': return `:${s.name}`;
  }
  throw new Error(`not an s-expression: ${JSON.stringify(s)}`);
}

const list = (...items) => ({ t: 'list', items });
const sym = (name) => ({ t: 'sym', name });
const str = (value) => ({ t: 'str', value });
const int = (value) => ({ t: 'int', value: BigInt(value) });

// ---------------------------------------------------------------------------------------------
// IDE session (src/Idris/IDEMode/REPL.idr `loop`, `replIDE`; src/Idris/IDEMode/Commands.idr)
// ---------------------------------------------------------------------------------------------

/**
 * Commands the fake understands, keyed by the command's `show` form. `getMsg` accepts exactly
 * `(CMD ID)` with an integer ID; `version` is a bare symbol (`getIDECommand (SymbolAtom
 * "version")`), so `((:version) 1)` is not a command (F4).
 */
const COMMANDS = new Map([
  [':version', () => list(sym('ok'), list(list(int(0), int(8), int(0)), list(str(''))))],
]);

/**
 * One IDE-mode conversation. `send(text)` writes one reply frame. The id of an error that is
 * not attributable to a request is the id of the last *recognised* request, 0 before the first
 * (`printIDEError outf idx …`; `updateOutput i` runs only when `getMsg` succeeds; the output is
 * created as `IDEMode 0 …` in Idris/Driver.idr).
 */
function createSession(send) {
  let lastId = 0n;
  const reply = (sexp) => send(show(sexp) + '\n');
  const error = (message) => reply(list(sym('return'), list(sym('error'), str(message)), int(lastId)));
  return {
    start() { reply(list(sym('protocol-version'), int(2), int(1))); },
    /** `input` is the frame payload as the compiler sees it: one character per byte. */
    receive(input) {
      let sexp;
      try {
        sexp = parseSExp(input);
      } catch (e) {
        if (!(e instanceof SExpError)) { throw e; }
        // The real message is the compiler's rendered parse error; only its prefix is mirrored.
        error(`Parse error: ${e.message} (fake-idris2)`);
        return;
      }
      const isMsg = sexp.t === 'list' && sexp.items.length === 2 && sexp.items[1].t === 'int';
      const handler = isMsg ? COMMANDS.get(show(sexp.items[0])) : undefined;
      if (handler === undefined) {
        // `reflow "Unrecognised command:" <++> pretty0 (show sexp)`: `Pretty String` splits
        // with Data.String.lines (\r\n, \r, \n) and rejoins with newlines, so a CR from a
        // `\r` escape comes back as LF.
        error(`Unrecognised command: ${show(sexp).replace(/\r\n|\r|\n/g, '\n')}`);
        return;
      }
      lastId = sexp.items[1].value;
      reply(list(sym('return'), handler(), int(lastId)));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Framing (src/Idris/IDEMode/REPL.idr getInput/getChar; src/Idris/IDEMode/Commands.idr send)
// ---------------------------------------------------------------------------------------------

/**
 * Encodes one reply. The prefix is `length r` of the Idris String — its number of Unicode code
 * points, lower-case hex, left-padded to 6 — while the bytes on the wire are UTF-8. This differs
 * from the request direction for non-ASCII text; see README.md "Framing". `sendStr` (`fPutStr`)
 * stops at the first NUL although the prefix counted the whole string.
 */
function encodeFrame(text) {
  const prefix = Array.from(text).length.toString(16).padStart(6, '0');
  const nul = text.indexOf('\0');
  return Buffer.from(prefix + (nul < 0 ? text : text.slice(0, nul)), 'utf8');
}

const HEX6 = /^[0-9a-fA-F]{6}$/;

/**
 * Request reader. The compiler reads one *byte* per `Char` (so a request's prefix is its UTF-8
 * byte length, F1, and its text is seen byte-per-character, i.e. as Latin-1): six characters; if
 * they are hex, that many more, otherwise the rest of the line. `onInput` receives each payload.
 */
function createReader(onInput) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 6) { return; }
        const head = buf.subarray(0, 6).toString('latin1');
        let payload;
        if (HEX6.test(head)) {
          const n = parseInt(head, 16);
          if (buf.length < 6 + n) { return; }
          payload = buf.subarray(6, 6 + n);
          buf = buf.subarray(6 + n);
        } else {
          const nl = buf.indexOf(0x0a, 6);
          if (nl < 0) { return; }
          payload = buf.subarray(0, nl + 1);
          buf = buf.subarray(nl + 1);
        }
        onInput(payload.toString('latin1'));
      }
    },

    /**
     * Whether end of input, with the bytes in `buf` still unread, ends the session silently
     * (exit 0) rather than with the end-of-input line (exit 1). C stdio lets one read go past
     * the end: `fgetc` returns EOF, which `fGetChar` casts to a Char, and only then does `feof`
     * turn true (`idris2_eof` is `feof`, support/c/idris_file.c). `getChar` tests `fEOF` before
     * each read, so a second read past the end aborts; `loop` tests `fEOF` after `getInput` and
     * returns without handling the request, so a request whose reading stopped at the end is
     * dropped silently. The unread tail ends silently when it is 5 bytes (the EOF read completes
     * the header, which is then not hex), an unframed line without its newline (`getline` reads
     * to the end), or a framed request exactly one byte short; otherwise, including an empty
     * tail, the end-of-input line follows.
     */
    endsSilently() {
      if (buf.length < 6) { return buf.length === 5; }
      const head = buf.subarray(0, 6).toString('latin1');
      return !HEX6.test(head) || buf.length - 6 === parseInt(head, 16) - 1;
    },
  };
}

/** Input ended with `reader`'s tail unread (see `endsSilently`); the socket's client closed. */
function inputEnded(reader) {
  if (reader.endsSilently()) {
    process.stdout.write('', () => process.exit(0));
  } else {
    readFailed();
  }
}

/** `getChar` found EOF: the compiler prints this unframed on stdout and exits 1. */
function readFailed() {
  process.stdout.write(ALAS + '\n', () => process.exit(1));
}

/**
 * The socket client reset the connection: `fgetc` fails and sets the stream's error flag, so
 * `fGetChar` returns `Left` (it tests `fileError`, libs/base/System/File/ReadWrite.idr) and
 * `getChar` prints this unframed on stdout and exits 1 (IDEMode/REPL.idr 85–87 on v0.8.0).
 */
function connectionFailed() {
  process.stdout.write(READ_FAILED + '\n', () => process.exit(1));
}

// ---------------------------------------------------------------------------------------------
// Transports and command line
// ---------------------------------------------------------------------------------------------

function serveStdio() {
  const session = createSession((text) => process.stdout.write(encodeFrame(text)));
  const reader = createReader((input) => session.receive(input));
  session.start();
  process.stdin.on('data', (chunk) => reader.push(chunk));
  process.stdin.on('end', () => inputEnded(reader));
}

/**
 * `--ide-mode-socket [host:port]` (Idris/CommandLine.idr ideSocketModeAddress; IDEMode/REPL.idr
 * initIDESocketFile): bind an AF_INET socket (default localhost, port 0 = any), print the port
 * in decimal plus a newline on stdout, accept one connection and speak the protocol on it.
 * Program output would go to the process stdout (F5); the handshake is sent after `accept`.
 */
function serveSocket(address) {
  const colon = address.indexOf(':');
  const hostPart = colon < 0 ? address : address.slice(0, colon);
  const portPart = colon < 0 ? '' : address.slice(colon + 1);
  const host = hostPart === '' || hostPart === 'localhost' ? '127.0.0.1' : hostPart;
  // `fromMaybe 0 (… parsePositive)`: after trimming, an optional '+' and digits; else port 0.
  const port = /^\+?[0-9]+$/.test(portPart.trim()) ? Number(portPart.trim()) : 0;
  let accepted = false;
  const server = net.createServer((conn) => {
    if (accepted) { conn.pause(); return; } // `accept` runs once; later clients are never served
    accepted = true;
    const session = createSession((text) => conn.write(encodeFrame(text)));
    const reader = createReader((input) => session.receive(input));
    session.start();
    conn.on('data', (chunk) => reader.push(chunk));
    conn.on('end', () => inputEnded(reader));
    conn.on('error', connectionFailed);
  });
  server.listen({ host, port }, () => {
    process.stdout.write(`${server.address().port}\n`);
  });
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(VERSION_LINE + '\n');
    return;
  }
  if (argv.length === 1 && argv[0] === '--ide-mode') {
    serveStdio();
    return;
  }
  // [Optional "host:port"]: the next argument is taken unless it starts with '-'.
  if (argv[0] === '--ide-mode-socket' && argv.length <= 2 && !(argv[1] ?? '').startsWith('-')) {
    serveSocket(argv[1] ?? 'localhost:0');
    return;
  }
  process.stderr.write(`fake-idris2: arguments not implemented by the fake: ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

main(process.argv.slice(2));
