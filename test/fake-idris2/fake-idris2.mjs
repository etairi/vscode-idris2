#!/usr/bin/env node
// fake-idris2: a stand-in for the `idris2` binary that tests run instead of the real compiler
// (docs/ARCHITECTURE.md §12). M0: `--version`, and the IDE protocol's start-up handshake plus the
// `version` command over stdio (`--ide-mode`) and TCP (`--ide-mode-socket`). M1: the toolchain
// probes `--ttc-version`, `--paths`, `--list-packages` and `--dump-ipkg-json`, answered from
// output recorded from the real compiler (recorded-cli-0.8.0.json), and the fault modes of
// test/fake-tools/faults.mjs. M2: the session command line (`--no-color`, `-p`, `--build-dir`),
// replay of the IDE-mode transcripts recorded from the real compiler (FAKE_IDRIS2_TRANSCRIPTS),
// injected protocol faults (FAKE_IDRIS2_IDE_FAULT) and an invocation log (FAKE_IDRIS2_LOG). M3:
// replay by session role (the build directory tells a `check` session from an `eval` one) and a
// log of the requests received (FAKE_IDRIS2_REQUEST_LOG). M4: replies held back per command
// (FAKE_IDRIS2_IDE_DELAY), a compiler busy with a long request. The
// behaviour mirrors Idris 2 0.8.0 (15a3e4e); each rule cites the compiler source it follows.
// README.md says what was compared byte for byte with the real binary and what is not mirrored.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { applyFaults, notImplemented } from '../fake-tools/faults.mjs';

const TOOL = 'fake-idris2';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
/** Output of the real compiler, one run per flag; README.md "Recorded command-line output". */
const RECORDED = JSON.parse(fs.readFileSync(path.join(here, 'recorded-cli-0.8.0.json'), 'utf8'));

const VERSION_PREFIX = 'Idris 2, version ';
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
  // `AVersion`: ((major minor patch) (tag)), the tag "" when the build has none
  // (Protocol/IDE/Result.idr 84–88).
  [':version', () => {
    const v = ideVersion();
    return list(sym('ok'), list(list(int(v.major), int(v.minor), int(v.patch)), list(str(v.tag))));
  }],
]);

/** The unframed line the `noise` fault writes into the protocol stream. */
const NOISE = 'fake-idris2: injected noise (FAKE_IDRIS2_IDE_FAULT)\n';
/** What the `crash-in-reply` fault writes before it exits: a reply frame's header and the first 23 of its 64 code points. */
const PARTIAL_FRAME = '000040(:write-string "partial';
/** What the `id-mismatch` fault adds to the id of a `:return`. */
const ID_MISMATCH_OFFSET = 1000000n;

/** `(CMD ID)` with an integer ID: the shape `getMsg` accepts (IDEMode/Commands.idr). */
const isMessage = (sexp) => sexp !== undefined && sexp.t === 'list' && sexp.items.length === 2
  && sexp.items[1].t === 'int';

/**
 * One IDE-mode conversation. `io.frame(text)` writes one reply frame; `io.raw(text, done?)` writes
 * bytes into the protocol stream without a frame (then calls `done`, once they are written); `io.output(text)` writes program output to the
 * process stdout, which over stdio is the protocol stream itself (F5). `replayer` (transcript
 * replay, or undefined) answers every request the built-in commands do not; `faults` maps a
 * request's 1-based number in this process to an injected fault (FAKE_IDRIS2_IDE_FAULT); `delays`
 * maps a command's name to the milliseconds its answer is held back (FAKE_IDRIS2_IDE_DELAY).
 *
 * The compiler answers one request at a time (`loop`, IDEMode/REPL.idr): while an answer is held
 * back, what arrives is not read — it is kept, and read in order once the answer is out.
 *
 * The id of an error that is not attributable to a request is the id of the last *recognised*
 * request, 0 before the first (`printIDEError outf idx …`; `updateOutput i` runs only when
 * `getMsg` succeeds; the output is created as `IDEMode 0 …` in Idris/Driver.idr).
 */
function createSession(io, replayer, faults, delays) {
  let lastId = 0n;
  let received = 0;
  let hung = false;
  let fault;
  /** Requests that arrived while an answer was held back, oldest first. */
  const unread = [];
  let busy = false;
  /** Called once nothing is held back or unread (`whenIdle`). */
  let onIdle;
  const reply = (sexp) => {
    let out = sexp;
    if (fault === 'id-mismatch' && out.items[0].t === 'sym' && out.items[0].name === 'return') {
      out = list(...out.items.slice(0, -1), int(out.items.at(-1).value + ID_MISMATCH_OFFSET));
    }
    io.frame(show(out) + '\n');
  };
  const error = (message, id = lastId) => reply(list(sym('return'), list(sym('error'), str(message)), int(id)));
  return {
    start() { reply(list(sym('protocol-version'), int(2), int(1))); },
    /** A `hang` fault fired: the compiler is busy for good and no longer reads its input. */
    get hung() { return hung; },
    /**
     * Runs `callback` once no answer is held back and nothing is unread (at once when that is
     * so already): the end of input is noticed only after the requests before it are answered.
     */
    whenIdle(callback) {
      if (busy) { onIdle = callback; } else { callback(); }
    },
    /** `input` is the frame payload as the compiler sees it: one character per byte. */
    receive(input) {
      if (busy) { unread.push(input); return; }
      handle(input);
    },
  };

  /** Reads the next unread request, if any, now that no answer is held back. */
  function readUnread() {
    while (!busy && !hung && unread.length > 0) { handle(unread.shift()); }
    if (!busy && onIdle !== undefined) {
      const callback = onIdle;
      onIdle = undefined;
      callback();
    }
  }

  function handle(input) {
    if (hung) { return; }
    logRequest(input);
    received += 1;
    fault = faults.get(received);
    if (fault === 'crash') {
      process.stderr.write(`${TOOL}: simulated crash at request ${received} (FAKE_IDRIS2_IDE_FAULT)\n`);
      process.exit(3);
    }
    if (fault === 'crash-in-reply') {
      // Exits only once both writes are done, so that neither is lost at the exit.
      io.raw(PARTIAL_FRAME, () => process.stderr.write(
        `${TOOL}: simulated crash inside a reply at request ${received} (FAKE_IDRIS2_IDE_FAULT)\n`, () => process.exit(3)));
      hung = true; // reads nothing more
      return;
    }
    if (fault === 'hang') {
      hung = true;
      exitAfterHangLimit();
      return;
    }
    if (fault === 'noise') { io.raw(NOISE); }
    let sexp;
    let parseError;
    try {
      sexp = parseSExp(input);
    } catch (e) {
      if (!(e instanceof SExpError)) { throw e; }
      parseError = e;
    }
    const delay = delays.get(commandName(sexp));
    if (delay !== undefined) {
      busy = true;
      setTimeout(() => {
        busy = false;
        answer(input, sexp, parseError);
        readUnread();
      }, delay);
      return;
    }
    answer(input, sexp, parseError);
  }

  function answer(input, sexp, parseError) {
    const handler = isMessage(sexp) ? COMMANDS.get(show(sexp.items[0])) : undefined;
    if (handler !== undefined) {
      replayer?.remember(input, sexp);
      lastId = sexp.items[1].value;
      reply(list(sym('return'), handler(), int(lastId)));
      return;
    }
    if (replayer !== undefined) {
      const recorded = replayer.answer(input, sexp);
      if (recorded === undefined) {
        // Not a compiler behaviour: the request has no recording, so the test cannot know
        // what the compiler would say. Answered with the request's own id when it has one,
        // so that the client's pending request ends with this error instead of hanging.
        const id = isMessage(sexp) ? sexp.items[1].value : lastId;
        const what = replayer.describe(input, sexp);
        process.stderr.write(`${TOOL}: no recorded reply for ${what}\n`);
        error(`${TOOL}: no recorded reply for ${what}`, id);
        lastId = id;
        return;
      }
      // Recorded replies carry the recorded request's id or, for a request the compiler did
      // not recognise, the previous recognised one (F4); both are mapped to this session's.
      const liveId = isMessage(sexp) ? sexp.items[1].value : undefined;
      const previous = lastId;
      for (const item of recorded.replies) {
        if (item.output !== undefined) {
          io.output(item.output);
          continue;
        }
        const recordedId = item.sexp.items.at(-1).value;
        const id = recordedId === recorded.recordedId && liveId !== undefined ? liveId : previous;
        reply(list(...item.sexp.items.slice(0, -1), int(id)));
      }
      if (recorded.recognised && liveId !== undefined) { lastId = liveId; }
      return;
    }
    if (parseError !== undefined) {
      // The real message is the compiler's rendered parse error; only its prefix is mirrored.
      error(`Parse error: ${parseError.message} (fake-idris2)`);
      return;
    }
    // `reflow "Unrecognised command:" <++> pretty0 (show sexp)`: `Pretty String` splits
    // with Data.String.lines (\r\n, \r, \n) and rejoins with newlines, so a CR from a
    // `\r` escape comes back as LF.
    error(`Unrecognised command: ${show(sexp).replace(/\r\n|\r|\n/g, '\n')}`);
  }
}

/** The `hang` fault: like FAKE_IDRIS2_MODE=hang, exit 1 after FAKE_TOOL_HANG_LIMIT_MS. */
function exitAfterHangLimit() {
  const text = process.env.FAKE_TOOL_HANG_LIMIT_MS;
  const limit = text === undefined || text === '' ? 60000 : Number(text);
  if (!Number.isInteger(limit) || limit < 0) {
    misconfigured(`FAKE_TOOL_HANG_LIMIT_MS must be a non-negative integer, not ${JSON.stringify(text)}`);
  }
  setTimeout(() => process.exit(1), limit);
}

function misconfigured(message) {
  process.stderr.write(`${TOOL}: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Injected faults (FAKE_IDRIS2_IDE_FAULT; README.md "Injected protocol faults")
// ---------------------------------------------------------------------------------------------

const IDE_FAULTS = new Set(['crash', 'crash-in-reply', 'hang', 'noise', 'id-mismatch']);

/**
 * FAKE_IDRIS2_IDE_FAULT = comma-separated `<fault>@<n>`: the n-th request this process receives
 * (1-based, every request counts) triggers the fault. `crash`: a line on stderr, exit 3, no
 * reply. `crash-in-reply`: the first bytes of a reply frame in the protocol stream, a line on
 * stderr, exit 3. `hang`: no reply, no further reading, exit 1 after FAKE_TOOL_HANG_LIMIT_MS. `noise`: an
 * unframed line in the protocol stream before the replies. `id-mismatch`: the `:return` carries
 * its id plus 1000000.
 */
function ideFaults() {
  const text = process.env.FAKE_IDRIS2_IDE_FAULT ?? '';
  const faults = new Map();
  for (const item of text === '' ? [] : text.split(',')) {
    const m = /^([a-z-]+)@([1-9][0-9]*)$/.exec(item.trim());
    if (m === null || !IDE_FAULTS.has(m[1]) || faults.has(Number(m[2]))) {
      misconfigured(`FAKE_IDRIS2_IDE_FAULT must be a comma-separated list of <fault>@<n> with distinct n `
        + `and <fault> one of ${[...IDE_FAULTS].join(', ')}, not ${JSON.stringify(text)}`);
    }
    faults.set(Number(m[2]), m[1]);
  }
  return faults;
}

/**
 * The name of a request's command, for FAKE_IDRIS2_IDE_DELAY: `case-split` for `((:case-split …)
 * ID)`, `proof-search-next` for the bare symbol of `(:proof-search-next ID)` (F4); undefined for
 * anything else.
 */
function commandName(sexp) {
  if (!isMessage(sexp)) { return undefined; }
  const command = sexp.items[0];
  const head = command.t === 'list' ? command.items[0] : command;
  return head?.t === 'sym' ? head.name : undefined;
}

/**
 * FAKE_IDRIS2_IDE_DELAY = comma-separated `<command>=<ms>`: the answer to every request of that
 * command (`commandName`) is written only after `ms` milliseconds, and nothing after it is read
 * before then (`createSession`) — a compiler busy with a long request. Not a compiler behaviour to
 * mirror, only its timing: the answer itself is unchanged. With or without transcripts.
 */
function ideDelays() {
  const text = process.env.FAKE_IDRIS2_IDE_DELAY ?? '';
  const delays = new Map();
  for (const item of text === '' ? [] : text.split(',')) {
    const m = /^([a-z][a-z-]*)=([0-9]+)$/.exec(item.trim());
    if (m === null || delays.has(m[1])) {
      misconfigured(`FAKE_IDRIS2_IDE_DELAY must be a comma-separated list of <command>=<ms> with distinct `
        + `commands (e.g. case-split=2000), not ${JSON.stringify(text)}`);
    }
    delays.set(m[1], Number(m[2]));
  }
  return delays;
}

// ---------------------------------------------------------------------------------------------
// Transcript replay (FAKE_IDRIS2_TRANSCRIPTS; README.md "Transcript replay"; the format is in
// test/fixtures/transcripts/README.md)
// ---------------------------------------------------------------------------------------------

/** The events a reply group may contain; anything else in a transcript is refused at start. */
const PROGRAM_OUTPUT = new Set(['unframed', 'stdout']);

/** The compiler's view of a JS string: one character per UTF-8 byte (F1 addendum). */
const latin1View = (text) => Buffer.from(text, 'utf8').toString('latin1');

/** A request's matching key: its command without the id, or the whole text when unparsable. */
function requestKey(input, sexp) {
  if (sexp === undefined) { return `raw ${input}`; }
  return isMessage(sexp) ? `command ${show(sexp.items[0])}` : `sexp ${show(sexp)}`;
}

/**
 * The commands that ask about the loaded code (`process` in IDEMode/REPL.idr on v0.8.0: names,
 * types, documentation, holes, completions): the matching treats them as changing nothing that
 * later answers depend on — an approximation, like the rest of the matching, not checked for each
 * command. Every other request — a load, an edit, a search and its `-next`, `:interpret`,
 * `:enable-syntax`, one that is not a command — counts.
 */
const QUERIES = new Set(['type-of', 'name-at', 'docs-for', 'metavariables', 'repl-completions', 'browse-namespace',
  'who-calls', 'calls-who', 'apropos', 'print-definition', 'version']);

/**
 * Whether a request key (`requestKey`) is a query: a command of `QUERIES`, or `:missing` through
 * `:interpret` (M4's Add Missing Cases), which only reads the context (`process (Missing n)` in
 * Idris/REPL.idr on v0.8.0 [src]) — so a second `:missing g` after the first still follows the
 * load it answers for.
 */
const isQuery = (key) => QUERIES.has(/^command \(?:([a-z-]+)/.exec(key)?.[1]) || key.startsWith('command (:interpret ":missing ');

/** Applies `f` to every string atom of `sexp`. */
function mapStrings(sexp, f) {
  if (sexp.t === 'str') { return str(f(sexp.value)); }
  if (sexp.t === 'list') { return list(...sexp.items.map((item) => mapStrings(item, f))); }
  return sexp;
}

/**
 * The session role a command line's `--build-dir` names: the extension gives the `check` session
 * `<session directory>/build/.vscode-idris2` and the `eval` session (M3)
 * `<session directory>/build/.vscode-idris2-eval` (`src/backend/ide/types.ts` `SessionRole`), and
 * the recorder does the same. Undefined when the command line has no `--build-dir` (the `.ipkg`
 * chose the directory) or another one: such a session, or recording, is not told apart by role.
 */
function roleOf(args) {
  const i = args.lastIndexOf('--build-dir');
  const dir = i < 0 ? undefined : args[i + 1];
  if (dir === undefined) { return undefined; }
  const base = dir.split(/[\\/]/).pop();
  return base === '.vscode-idris2' ? 'check' : base === '.vscode-idris2-eval' ? 'eval' : undefined;
}

/**
 * Reads every `*.jsonl` transcript of `dir` into scenarios, sorted by name: for each recorded
 * request its key, id and reply group (the frames and program output up to the next request or
 * the recorder's `close`). Everything before the first request (the port line, the handshake)
 * and after `close` (the end-of-input tail, the exit) is the fake's own behaviour and is not
 * replayed.
 */
function loadScenarios(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  } catch (e) {
    misconfigured(`FAKE_IDRIS2_TRANSCRIPTS=${JSON.stringify(dir)} cannot be read: ${e.message}`);
  }
  if (names.length === 0) { misconfigured(`FAKE_IDRIS2_TRANSCRIPTS=${JSON.stringify(dir)} has no .jsonl transcript`); }
  return names.map((name) => {
    const file = path.join(dir, name);
    const refuse = (why) => misconfigured(`${file}: ${why}`);
    let events;
    try {
      events = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
    } catch (e) {
      refuse(`not a transcript: ${e.message}`);
    }
    const [meta, ...rest] = events;
    if (meta?.kind !== 'meta' || meta.format !== 1) { refuse('the first line is not a format-1 meta object'); }
    const steps = [];
    for (const event of rest) {
      if (event.kind === 'close') { break; }
      if (event.kind === 'send') {
        const input = latin1View(event.text);
        let sexp;
        try { sexp = parseSExp(input); } catch (e) { if (!(e instanceof SExpError)) { throw e; } }
        steps.push({ key: requestKey(input, sexp), id: isMessage(sexp) ? sexp.items[1].value : undefined, replies: [] });
      } else if (steps.length === 0) {
        continue; // the port line and the handshake
      } else if (event.kind === 'recv') {
        const sexp = parseSExp(event.text);
        if (!(sexp.t === 'list' && sexp.items.length >= 2 && sexp.items.at(-1).t === 'int')) {
          refuse(`a reply without a trailing id: ${event.text}`);
        }
        steps.at(-1).replies.push({ sexp });
      } else if (PROGRAM_OUTPUT.has(event.kind) && event.text !== undefined) {
        steps.at(-1).replies.push({ output: event.text });
      } else {
        refuse(`cannot replay a ${JSON.stringify(event.kind)} event before the end of input`);
      }
    }
    const stateful = [];
    for (const step of steps) {
      step.recognised = step.id !== undefined && step.replies.some((r) => r.sexp !== undefined
        && r.sexp.items[0].name === 'return' && r.sexp.items.at(-1).value === step.id);
      // What `createReplayer` compares (M4): the requests before this one that are not queries.
      step.before = [...stateful];
      if (!isQuery(step.key)) { stateful.push(step.key); }
    }
    return { name: name.slice(0, -'.jsonl'.length), role: roleOf(meta.args ?? []), fixtures: meta.fixtures ?? {}, steps };
  });
}

/**
 * The replayer of one session. A request is normalised — its id set aside, and every string that
 * names a path in the working directory written with `${ROOT}` (or `${LINK}` when spelled through
 * a symbolic link to it) — and matched against the recorded requests of the scenarios whose
 * fixture files (`meta.fixtures`, relative to the working directory) have the recorded SHA-256
 * now. Among the recorded requests that match, the one whose recorded predecessors match the
 * longest run of this session's latest requests wins, so that the compiler state the replies
 * depend on (a file already built, F7; `:enable-syntax`, F14) is the recorded one as far as
 * the transcripts allow. Queries (`isQuery`) are left out on both sides (M4): the holes model
 * sends `:metavariables` and `:name-at` after every load, which would otherwise hide a reload's
 * recorded predecessor, and a query's answer depends on the file loaded (`:name-at "todo"` after a
 * load of `Main.idr` lists `Main.todo` too, after one of `Base.idr` not), which the load before it
 * decides. Ties go to a request whose whole recorded prefix matched (a session replayed from its
 * start), then to the first scenario by name, then to the earlier request.
 * The replies are the recorded group with the paths spelled as this session spells them.
 * `role` (`roleOf` this process's command line) restricts the scenarios to those recorded in the
 * same role, when both are known: an `eval` session is answered from `eval` recordings and a
 * `check` session from `check` ones, so a request sent to the wrong session (an `:interpret` of
 * the evaluation on the `check` session) gets the "no recorded reply" error, as a test needs.
 */
function createReplayer(dir, role) {
  const scenarios = loadScenarios(dir);
  const cwd = process.cwd();
  const realRoot = fs.realpathSync(cwd);
  const win = process.platform === 'win32';
  const canonical = (p) => (win ? p.replace(/\\/g, '/').toLowerCase() : p);
  const isSep = (c) => c === '/' || (win && c === '\\');
  // How this session spells the placeholders (learnt from its requests; Latin-1 views, F1).
  const spelling = { ROOT: latin1View(cwd), LINK: undefined };
  let sep = path.sep;
  /** The keys of this session's requests that are not queries (`isQuery`), oldest first. */
  const history = [];
  const remember = (key) => {
    if (!isQuery(key)) { history.push(key); }
  };

  /** `v` (a string of a request) with a leading path to the working directory replaced. */
  const normalise = (v) => {
    for (const root of new Set([latin1View(cwd), latin1View(realRoot)])) {
      if (canonical(v.slice(0, root.length)) === canonical(root) && (v.length === root.length || isSep(v[root.length]))) {
        spelling.ROOT = v.slice(0, root.length);
        sep = v[root.length] ?? sep;
        const rest = v.slice(root.length);
        return `\${ROOT}${win ? rest.replace(/\\/g, '/') : rest}`;
      }
    }
    const text = Buffer.from(v, 'latin1').toString('utf8');
    if (!path.isAbsolute(text)) { return v; }
    for (let p = text; ; p = path.dirname(p)) {
      let real;
      try { real = fs.realpathSync(p); } catch { real = undefined; }
      if (real === realRoot) {
        spelling.LINK = latin1View(p);
        return `\${LINK}${latin1View(text.slice(p.length))}`;
      }
      if (path.dirname(p) === p) { return v; }
    }
  };

  /** A recorded string with the placeholders spelled as this session spells them. */
  const substitute = (v) => v.replace(/\$\{(ROOT|LINK)\}([^\s"'()]*)/g, (whole, name, rest) =>
    (spelling[name] === undefined ? whole : spelling[name] + (sep === '/' ? rest : rest.replace(/\//g, sep))));

  const hashes = new Map();
  const sameRole = (scenario) => role === undefined || scenario.role === undefined || scenario.role === role;
  const eligible = (scenario) => sameRole(scenario) && Object.entries(scenario.fixtures).every(([rel, sha256]) => {
    if (!hashes.has(rel)) {
      let hash;
      try { hash = createHash('sha256').update(fs.readFileSync(path.join(realRoot, rel))).digest('hex'); } catch { hash = undefined; }
      hashes.set(rel, hash);
    }
    return hashes.get(rel) === sha256;
  });

  return {
    /** Records a request answered without the transcripts (`:version`), for the matching above. */
    remember(input, sexp) {
      remember(requestKey(input, sexp));
    },
    /** The request as matched, for messages: its normalised command, or its text. */
    describe(input, sexp) {
      return sexp === undefined ? JSON.stringify(input) : show(isMessage(sexp) ? mapStrings(sexp.items[0], normalise) : mapStrings(sexp, normalise));
    },
    /** `{ replies, recordedId, recognised }` for the request, or undefined when nothing matches. */
    answer(input, sexp) {
      const key = requestKey(input, sexp === undefined ? undefined : mapStrings(sexp, normalise));
      hashes.clear(); // files may have changed since the last request
      let best;
      for (const scenario of scenarios.filter(eligible)) {
        for (const step of scenario.steps) {
          if (step.key !== key) { continue; }
          const { before } = step;
          let run = 0; // recorded predecessors that equal this session's latest requests, queries left out
          while (run < before.length && run < history.length && before[before.length - 1 - run] === history[history.length - 1 - run]) {
            run += 1;
          }
          const whole = run === before.length;
          if (best === undefined || run > best.run || (run === best.run && whole && !best.whole)) {
            best = { step, run, whole };
          }
        }
      }
      remember(key);
      if (best === undefined) { return undefined; }
      const { step } = best;
      return {
        recordedId: step.id,
        recognised: step.recognised,
        replies: step.replies.map((r) => (r.output !== undefined
          ? { output: substitute(r.output) }
          : { sexp: mapStrings(r.sexp, substitute) })),
      };
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

function serveStdio(replayer, faults, delays) {
  const toStdout = (text, done) => process.stdout.write(text, done);
  const session = createSession({ frame: (text) => process.stdout.write(encodeFrame(text)), raw: toStdout, output: toStdout },
    replayer, faults, delays);
  const reader = createReader((input) => session.receive(input));
  session.start();
  process.stdin.on('data', (chunk) => reader.push(chunk));
  // A hung compiler is not reading, so it does not see the end of its input either; a busy one
  // sees it once it has answered what came before it.
  process.stdin.on('end', () => session.whenIdle(() => { if (!session.hung) { inputEnded(reader); } }));
}

/**
 * `--ide-mode-socket [host:port]` (Idris/CommandLine.idr ideSocketModeAddress; IDEMode/REPL.idr
 * initIDESocketFile): bind an AF_INET socket (default localhost, port 0 = any), print the port
 * in decimal plus a newline on stdout, accept one connection and speak the protocol on it.
 * Program output would go to the process stdout (F5); the handshake is sent after `accept`.
 */
function serveSocket(address, replayer, faults, delays) {
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
    const session = createSession({
      frame: (text) => conn.write(encodeFrame(text)),
      raw: (text, done) => conn.write(text, done),
      output: (text) => process.stdout.write(text), // F5: program output goes to the process stdout
    }, replayer, faults, delays);
    const reader = createReader((input) => session.receive(input));
    session.start();
    conn.on('data', (chunk) => reader.push(chunk));
    conn.on('end', () => session.whenIdle(() => { if (!session.hung) { inputEnded(reader); } }));
    conn.on('error', () => { if (!session.hung) { connectionFailed(); } });
  });
  server.listen({ host, port }, () => {
    process.stdout.write(`${server.address().port}\n`);
  });
}

// ---------------------------------------------------------------------------------------------
// Version (Libraries/Data/Version.idr `showVersion True`: <major>.<minor>.<patch>[-<tag>])
// ---------------------------------------------------------------------------------------------

/**
 * The text after `Idris 2, version `: FAKE_IDRIS2_VERSION when set (any text, so that tests can
 * simulate a development build such as `0.8.0-1c630e67c` or an unparsable version), otherwise
 * the recorded one.
 */
function versionText() {
  const configured = process.env.FAKE_IDRIS2_VERSION;
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  const line = RECORDED.flags['--version'].stdout.trimEnd();
  return line.slice(VERSION_PREFIX.length);
}

/** The version the IDE-mode `version` command reports; only defined for `showVersion`'s shape. */
function ideVersion() {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/.exec(versionText());
  if (m === null) {
    process.stderr.write(`${TOOL}: FAKE_IDRIS2_VERSION=${JSON.stringify(versionText())} has no `
      + '<major>.<minor>.<patch>[-<tag>] form, so the IDE-mode version reply is undefined\n');
    process.exit(2);
  }
  return { major: m[1], minor: m[2], patch: m[3], tag: m[4] ?? '' };
}

// ---------------------------------------------------------------------------------------------
// Command-line probes, answered from recorded output
// ---------------------------------------------------------------------------------------------

/** Prints `recording.stdout` (with the working directory substituted) and exits with its code. */
function replay(recording) {
  const text = recording.stdout.split(RECORDED.cwdPlaceholder).join(process.cwd());
  process.stdout.write(text, () => process.exit(recording.exitCode));
}

/**
 * `--dump-ipkg-json [file]` (processPackage and localPackageFile, src/Idris/Package.idr 937–1000
 * on v0.8.0): without a file, the only `.ipkg` of the working directory. The fake answers only
 * for an ipkg whose bytes hash to a recording, so a changed fixture is noticed instead of being
 * answered with stale output.
 */
function dumpIpkgJson(file) {
  let target = file;
  if (target === undefined) {
    const candidates = fs.readdirSync(process.cwd()).filter((name) => name.endsWith('.ipkg'));
    if (candidates.length !== 1) {
      // The real texts are UserErrors rendered by the compiler; only their substance is mirrored.
      process.stderr.write(`${TOOL}: ${candidates.length} .ipkg files in the working directory `
        + '(the compiler needs exactly one when no file is given)\n');
      process.exit(1);
    }
    target = candidates[0];
  }
  if (!target.endsWith('.ipkg')) {
    // `putStrLn ("Packages must have an '.ipkg' extension: " ++ show file ++ ".")`, exit 1.
    process.stdout.write(`Packages must have an '.ipkg' extension: ${JSON.stringify(target)}.\n`,
      () => process.exit(1));
    return;
  }
  const absolute = path.resolve(process.cwd(), target);
  const sha256 = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  const recording = RECORDED.dumpIpkgJson.find((r) => r.sha256 === sha256);
  if (recording === undefined) {
    const known = RECORDED.dumpIpkgJson.map((r) => r.ipkg).join(', ');
    process.stderr.write(`${TOOL}: no recorded --dump-ipkg-json output for ${absolute} (sha256 `
      + `${sha256}); recordings exist for ${known} (see ${path.relative(repoRoot, path.join(here, 'README.md'))})\n`);
    process.exit(2);
  }
  replay(recording);
}

/**
 * An IDE-mode command line as the extension builds it (ARCHITECTURE §5.2): `--ide-mode`, or
 * `--ide-mode-socket` with an optional `host:port` (the next argument unless it starts with '-',
 * `[Optional "host:port"]`), in any order with `--no-color`, `-p`/`--package <pkg>` and
 * `--build-dir <dir>`. These three are accepted and ignored: the replies come from the
 * transcripts, whatever packages or build directory the recording used — except that the build
 * directory names the session's role (`roleOf`), which picks the recordings. Returns `{ socket,
 * role }` (`socket` undefined for stdio), or undefined for any other command line — so
 * `--find-ipkg`, which the extension must never pass (F13), is refused like every argument the
 * fake does not implement.
 */
function ideModeArgs(argv) {
  let mode;
  let socket;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--ide-mode' || arg === '--ide-mode-socket') && mode === undefined) {
      mode = arg;
      if (arg === '--ide-mode-socket') {
        socket = argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : 'localhost:0';
      }
    } else if (arg === '--no-color') {
      continue;
    } else if ((arg === '-p' || arg === '--package' || arg === '--build-dir') && argv[i + 1] !== undefined) {
      i++;
    } else {
      return undefined;
    }
  }
  return mode === undefined ? undefined : { socket, role: roleOf(argv) };
}

/** FAKE_IDRIS2_LOG: one JSON line per invocation, `{"pid", "args", "cwd"}` (as FAKE_PACK_LOG). */
function logInvocation(argv) {
  const file = process.env.FAKE_IDRIS2_LOG;
  if (file !== undefined && file !== '') {
    fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, args: argv, cwd: process.cwd() })}\n`);
  }
}

/**
 * FAKE_IDRIS2_REQUEST_LOG: every request an IDE-mode process reads, as one JSON line `{"pid",
 * "request"}` — the frame's payload (or unframed line) as UTF-8 text — appended before it is
 * answered, faults included (a `hang` stops the reading, so nothing after it is logged). With
 * FAKE_IDRIS2_LOG's `pid` a test sees which session received what, and that nothing was sent.
 */
function logRequest(input) {
  const file = process.env.FAKE_IDRIS2_REQUEST_LOG;
  if (file !== undefined && file !== '') {
    fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, request: Buffer.from(input, 'latin1').toString('utf8') })}\n`);
  }
}

async function main(argv) {
  logInvocation(argv);
  const mode = await applyFaults(TOOL, 'FAKE_IDRIS2');
  if (argv.length === 1 && argv[0] === '--version') {
    // `garbage`: a first line that does not start with `Idris 2, version `.
    const line = mode === 'garbage' ? `${TOOL}: garbage instead of a version line` : VERSION_PREFIX + versionText();
    process.stdout.write(line + '\n');
    return;
  }
  if (argv.length === 1 && Object.hasOwn(RECORDED.flags, argv[0])) {
    replay(RECORDED.flags[argv[0]]);
    return;
  }
  // [Optional "package file"] (src/Idris/CommandLine.idr 291, 483–486 on v0.8.0): an argument
  // that starts with '-' is not the file. The compiler then reads it as another option (for
  // `-x.ipkg` it printed its list of options that may override package options, exit 0); the
  // fake does not mirror that and answers as for any argument list it does not implement.
  if (argv[0] === '--dump-ipkg-json' && argv.length <= 2 && !(argv[1] ?? '').startsWith('-')) {
    dumpIpkgJson(argv[1]);
    return;
  }
  const ide = ideModeArgs(argv);
  if (ide !== undefined) {
    ideVersion(); // reject an unusable FAKE_IDRIS2_VERSION before the handshake
    const faults = ideFaults();
    const delays = ideDelays();
    const dir = process.env.FAKE_IDRIS2_TRANSCRIPTS;
    const replayer = dir === undefined || dir === '' ? undefined : createReplayer(dir, ide.role);
    if (ide.socket === undefined) {
      serveStdio(replayer, faults, delays);
    } else {
      serveSocket(ide.socket, replayer, faults, delays);
    }
    return;
  }
  notImplemented(TOOL, argv);
}

await main(process.argv.slice(2));
