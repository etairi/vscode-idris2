/**
 * The protocol modules against the IDE-mode sessions recorded from Idris 2 0.8.0
 * (`test/fixtures/transcripts/0.8.0`, format in its README): every frame the compiler sent is cut
 * and decoded, every request is rebuilt byte for byte by the builders, every reply decodes with
 * the decoder of its command, and the facts each scenario pins (ROADMAP §0) hold of the decoded
 * values. No compiler is run.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fromIdeReplySpan, toIdeTypeOfRequest, type PositionDocument } from '../../src/core/positions';
import {
  addClause,
  answersWithPreviousId,
  caseSplit,
  decodeAmbiguity,
  decodeBuildingLine,
  decodeIntro,
  decodeLemma,
  decodeMetavariables,
  decodeMissingCases,
  decodeNameAt,
  decodeSourceHighlights,
  decodeText,
  decodeVersion,
  docsFor,
  generateDef,
  generateDefNext,
  ideCodec,
  interpret,
  intro,
  isEndOfInputLine,
  loadFile,
  makeCase,
  makeLemma,
  makeWith,
  metavariables,
  missingCases,
  nameAt,
  proofSearch,
  proofSearchNext,
  refine,
  typeOf,
  version,
  type CommandResult,
} from '../../src/backend/ide/protocol';
import { int, list, str, sym } from '../../src/backend/ide/sexp';
import type { IdeCommand, IdeMessage, IncomingFrame, ReplyPayload } from '../../src/backend/ide/types';
import { encodeFrame } from '../../src/backend/ide/wire';
import { repoRoot } from '../fake-tools/paths';

// -------------------------------------------------------------------------------------------
// Loading
// -------------------------------------------------------------------------------------------

interface Meta {
  readonly kind: 'meta';
  readonly format: number;
  readonly scenario: string;
  readonly idris2: { readonly version: string };
  readonly transport: 'stdio' | 'socket';
  readonly placeholders: Readonly<Record<string, number>>;
}

type Event =
  | { readonly kind: 'send'; readonly prefix: string; readonly text: string }
  | { readonly kind: 'recv'; readonly prefix: string; readonly text: string }
  | { readonly kind: 'unframed'; readonly text: string }
  | { readonly kind: 'stdout'; readonly text: string }
  | { readonly kind: 'stderr'; readonly text: string }
  | { readonly kind: 'close' | 'socket-end' | 'exit' | 'files' };

interface Transcript {
  readonly meta: Meta;
  readonly events: readonly Event[];
}

const DIRECTORY = path.join(repoRoot(), 'test', 'fixtures', 'transcripts', '0.8.0');

/**
 * A path placeholder is replaced by an ASCII string of the recorded path's length, so that the
 * recorded prefixes stay valid (README, *Prefixes*).
 */
const SUBSTITUTES: Readonly<Record<string, string>> = { '${ROOT}': 'r', '${LINK}': 'l' };

function load(scenario: string): Transcript {
  const [meta, ...events] = fs.readFileSync(path.join(DIRECTORY, `${scenario}.jsonl`), 'utf8')
    .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Meta | Event);
  const m = meta as Meta;
  const substitute = (text: string): string => Object.entries(m.placeholders)
    .reduce((t, [placeholder, length]) => t.split(placeholder).join(`/${SUBSTITUTES[placeholder].repeat(length - 1)}`), text);
  return {
    meta: m,
    events: (events as Event[]).map((e) => ('text' in e ? { ...e, text: substitute(e.text) } : e)),
  };
}

const ROOT = `/${'r'.repeat(127)}`;
const LINK = `/${'l'.repeat(125)}`;

const SCENARIOS = fs.readdirSync(DIRECTORY).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)).sort();
const TRANSCRIPTS = new Map(SCENARIOS.map((s) => [s, load(s)]));

function transcript(scenario: string): Transcript {
  const t = TRANSCRIPTS.get(scenario);
  assert.ok(t !== undefined, `no transcript ${scenario}`);
  return t;
}

/** The events of `scenario` of the given kinds, in recorded order. */
function eventsOf<K extends Event['kind']>(scenario: string, ...kinds: K[]): Extract<Event, { kind: K }>[] {
  return transcript(scenario).events.filter((e): e is Extract<Event, { kind: K }> => (kinds as string[]).includes(e.kind));
}

function decoded(text: string): IdeMessage {
  const d = ideCodec.decodeMessage(text);
  assert.strictEqual(d.kind, 'message', text);
  return (d as Extract<typeof d, { kind: 'message' }>).message;
}

// -------------------------------------------------------------------------------------------
// The requests of every scenario, in order, with the decoder of each answer
// -------------------------------------------------------------------------------------------

type Decoder = (payload: ReplyPayload) => CommandResult<unknown>;

/** A request: the command (or, for the unparseable F4 probe, the frame's text) and its decoder. */
type Request = { readonly command: IdeCommand; readonly decode?: Decoder } | { readonly frame: string };

const raw = (text: string): IdeCommand => ({ kind: 'raw', text });
const load1 = (file: string): Request => ({ command: loadFile(`${ROOT}/${file}`) });
const text = (command: IdeCommand): Request => ({ command, decode: decodeText });

/** A stub command (F3): its answer is `(:ok "…")`, or `(:ok ())` for the name lists. */
const stub = (name: string, ...args: (string | number)[]): IdeCommand =>
  list(sym(name), ...args.map((a) => (typeof a === 'number' ? int(a) : str(a))));

const REQUESTS: Readonly<Record<string, readonly Request[]>> = {
  'ambig-refine': [load1('Ambig.idr'), text(refine(14, 'g_rhs', 'foo'))],
  'clean-editing': [
    load1('Clean.idr'),
    text(caseSplit({ line: 8, column: 0 }, 'xs')),
    text(caseSplit({ line: 8, column: 1 }, 'xs')),
    text(caseSplit({ line: 8, column: 8 }, 'xs')),
    text(caseSplit({ line: 8, column: 9 }, 'xs')),
    text(addClause(5, 'append')),
    { command: makeLemma(8, 'vlen_rhs'), decode: decodeLemma },
    text(makeWith(8, 'vlen_rhs')),
    text(makeCase(8, 'vlen_rhs')),
    text(proofSearch(8, 'vlen_rhs')),
    text(proofSearchNext()),
    text(proofSearchNext()),
    // F31: the mode after the hints is parsed and ignored; the builder has none.
    text(list(sym('proof-search'), int(8), str('vlen_rhs'), list(), sym('all'))),
    text(generateDef(5, 'append')),
    text(generateDefNext()),
    text(generateDefNext()),
    { command: intro(8, 'vlen_rhs'), decode: decodeIntro },
    text(refine(8, 'vlen_rhs', 'S')),
  ],
  'clean-lookups': [
    load1('Clean.idr'),
    text(typeOf('xs', { line: 8, column: 4 })),
    text(typeOf('xs', { line: 8, column: 5 })),
    text(typeOf('xs', { line: 8, column: 7 })),
    text(typeOf('xs', { line: 8, column: 8 })),
    text(typeOf('vlen')),
    text(docsFor('id')),
    // F31: the documentation modes are parsed and ignored; the builder has none.
    text(list(sym('docs-for'), str('id'), sym('full'))),
    text(list(sym('docs-for'), str('id'), sym('overview'))),
    { command: nameAt('vlen_rhs'), decode: decodeNameAt },
    { command: nameAt('Clean.vlen_rhs'), decode: decodeNameAt },
    { command: metavariables(), decode: decodeMetavariables },
    // F31: the line after the path is dropped; the builder has none.
    { command: list(sym('load-file'), str(`${ROOT}/Clean.idr`), int(3)) },
  ],
  'enable-syntax': [text(list(sym('enable-syntax'), { kind: 'bool', value: false })), load1('Clean.idr')],
  'exec-socket': [text(interpret(':exec putStrLn "hi"'))],
  'exec-stdio': [text(interpret(':exec putStrLn "hi"'))],
  'exec-stdio-putstr': [text(interpret(':exec putStr "hi"'))],
  'exec-stdio-putstr-digit': [text(interpret(':exec putStr "7"')), text(interpret(':exec putStr "ab"'))],
  'handshake': [
    { command: version(), decode: decodeVersion },
    { command: raw('(:version)') },
    { command: raw('(:cd "/tmp")') },
    { frame: '((:version 4' },
    { command: version(), decode: decodeVersion },
  ],
  'handshake-socket': [{ command: version(), decode: decodeVersion }],
  'load-bad': [load1('Bad.idr')],
  'load-bad-ipkg': [load1('Main.idr')],
  'load-builddir-ipkg': [load1('src/Hello.idr')],
  'load-lidr': [load1('Err.lidr'), text(typeOf('n', { line: 4, column: 2 })), text(typeOf('n', { line: 4, column: 4 }))],
  'load-lit': [load1('Lit.lidr'), text(typeOf('n', { line: 6, column: 7 })), text(typeOf('n', { line: 6, column: 9 }))],
  'load-logging': [load1('Logging.idr')],
  'load-loose': [load1('Hello.idr')],
  'load-md': [load1('ErrMd.idr.md')],
  'load-mixed': [load1('Mixed.idr')],
  'load-part': [
    load1('Part.idr'),
    { command: missingCases('g'), decode: decodeMissingCases },
    text(typeOf('main', { line: 7, column: 0 })),
    text(typeOf('main')),
  ],
  'load-simple-ipkg': [load1('src/Foo/B.idr'), load1('src/Foo/B.idr')],
  'load-switch': [load1('Bad.idr'), load1('Warn.idr'), load1('Bad.idr'), load1('Warn.idr')],
  'load-symlink': [{ command: loadFile(`${LINK}/Clean.idr`) }, load1('Clean.idr'), { command: loadFile('Clean.idr') }],
  'load-uses-bad': [load1('UsesBad.idr')],
  'load-warn': [load1('Warn.idr'), load1('Warn.idr')],
  'plain': [
    load1('Plain.idr'),
    text(caseSplit({ line: 5, column: 0 }, 'n')),
    text(interpret(':printdef f')),
    text(docsFor('f')),
    // F1 probes, sent raw on purpose: the builders would escape the non-ASCII characters.
    text(raw('(:interpret "\\"→\\"")')),
    { command: raw('(:bogus "é")') },
  ],
  'stubs': [
    text(stub('name-at', 'vlen_rhs', 8, 10)),
    text(stub('add-missing', 5, 'f')),
    text(stub('apropos', 'id')),
    text(stub('directive', 'lazy')),
    { command: stub('who-calls', 'f') },
    { command: stub('calls-who', 'f') },
    text(stub('normalise-term', '1 + 1')),
    text(stub('show-term-implicits', 'id')),
    text(stub('hide-term-implicits', 'id')),
    text(stub('elaborate-term', 'id')),
    text(stub('print-definition', 'id')),
  ],
  'warning-deprecated': [load1('Deprecated.idr')],
  'warning-generic': [load1('GenericWarn.idr')],
  'warning-ipkg-deprecated': [load1('Main.idr'), load1('Main.idr')],
  'warning-parser': [load1('ParserWarn.idr')],
  'warning-shadow-global': [load1('ShadowGlobal.idr')],
  'warning-shadow-local': [load1('ShadowLocal.idr')],
  'warning-visibility': [load1('Visibility.idr')],
};

/** One request of a transcript, the messages that answered it, and its `:return`. */
interface Exchange {
  readonly request: Request;
  readonly sent: string;
  readonly messages: readonly IdeMessage[];
  readonly payload: ReplyPayload;
  readonly id: bigint;
}

function exchanges(scenario: string): Exchange[] {
  const requests = REQUESTS[scenario];
  const out: Exchange[] = [];
  let pending: { request: Request; sent: string; messages: IdeMessage[] } | undefined;
  for (const event of transcript(scenario).events) {
    if (event.kind === 'send') {
      assert.strictEqual(pending, undefined, `${scenario}: a request was sent before the previous one returned`);
      pending = { request: requests[out.length], sent: event.prefix + event.text, messages: [] };
    } else if (event.kind === 'recv' && pending !== undefined) {
      const message = decoded(event.text);
      if (message.kind === 'return') {
        out.push({ ...pending, payload: message.payload, id: message.id });
        pending = undefined;
      } else {
        pending.messages.push(message);
      }
    }
  }
  assert.strictEqual(pending, undefined, `${scenario}: the last request did not return`);
  return out;
}

function exchange(scenario: string, index: number): Exchange {
  return exchanges(scenario)[index];
}

function ok<T>(result: CommandResult<T>): T {
  assert.strictEqual(result.kind, 'ok', JSON.stringify(result));
  return (result as Extract<CommandResult<T>, { kind: 'ok' }>).value;
}

function errorMessage(payload: ReplyPayload): string {
  assert.strictEqual(payload.kind, 'error');
  return (payload as Extract<ReplyPayload, { kind: 'error' }>).message;
}

function ofKind<K extends IdeMessage['kind']>(messages: readonly IdeMessage[], kind: K): Extract<IdeMessage, { kind: K }>[] {
  return messages.filter((m): m is Extract<IdeMessage, { kind: K }> => m.kind === kind);
}

/** A document for `core/positions.ts`, read from a fixture workspace. */
function fixtureDocument(relative: string): PositionDocument {
  const fileName = path.join(repoRoot(), 'test', 'fixtures', 'workspaces', ...relative.split('/'));
  const lines = fs.readFileSync(fileName, 'utf8').split('\n');
  return {
    fileName,
    isUntitled: false,
    languageId: fileName.endsWith('.lidr') ? 'lidr' : 'idris2',
    lineCount: lines.length,
    lineAt: (line) => ({ text: lines[line] }),
  };
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------------

suite('backend/ide protocol against the 0.8.0 transcripts', () => {
  test('the recordings are the 34 scenarios of format 1 from idris2 0.8.0, and each has a request table', () => {
    assert.strictEqual(SCENARIOS.length, 34);
    for (const [scenario, t] of TRANSCRIPTS) {
      assert.strictEqual(t.meta.format, 1, scenario);
      assert.strictEqual(t.meta.idris2.version, '0.8.0', scenario);
      assert.strictEqual(t.meta.scenario, scenario);
      assert.ok(REQUESTS[scenario] !== undefined, `no request table for ${scenario}`);
    }
    assert.deepStrictEqual(Object.keys(REQUESTS).sort(), SCENARIOS);
  });

  for (const scenario of SCENARIOS) {
    suite(scenario, () => {
      test('request prefixes count UTF-8 bytes, reply prefixes count code points (F1 and its addendum)', () => {
        for (const event of transcript(scenario).events) {
          if (event.kind === 'send') {
            assert.strictEqual(parseInt(event.prefix, 16), Buffer.byteLength(event.text, 'utf8'), event.text);
          } else if (event.kind === 'recv') {
            assert.strictEqual(parseInt(event.prefix, 16), Array.from(event.text).length, event.text);
          }
        }
      });

      test('the builders rebuild every request byte for byte', () => {
        const sends = eventsOf(scenario, 'send');
        const requests = REQUESTS[scenario];
        assert.strictEqual(requests.length, sends.length);
        sends.forEach((send, i) => {
          const request = requests[i];
          const id = BigInt(/ (\d+)\)\n$/.exec(send.text)?.[1] ?? '-1');
          const frame = 'frame' in request ? encodeFrame(request.frame) : ideCodec.encodeRequest(request.command, id);
          assert.strictEqual(frame.text, send.prefix + send.text);
          assert.deepStrictEqual(Buffer.from(frame.bytes), Buffer.from(send.prefix + send.text, 'utf8'));
        });
      });

      test('the protocol stream, chunked at random, is cut into the recorded frames and unframed lines, by the decoder of its transport', () => {
        const stream = eventsOf(scenario, 'recv', 'unframed');
        // The extension reads the socket with `framesOnly` (transport.ts); M2 second verification of
        // the third review: these tests read every recording with the stdio rules.
        const options = transcript(scenario).meta.transport === 'socket' ? { framesOnly: true } : {};
        const bytes = Buffer.from(stream.map((e) => (e.kind === 'recv' ? e.prefix + e.text : e.text)).join(''), 'utf8');
        const expected = stream.map((e): IncomingFrame => ({
          kind: e.kind === 'recv' ? 'framed' : 'unframed',
          text: e.text,
          byteLength: Buffer.byteLength(e.kind === 'recv' ? e.prefix + e.text : e.text, 'utf8'),
        }));
        const next = prng(SCENARIOS.indexOf(scenario) + 1);
        for (let run = 0; run < 20; run++) {
          const decoder = ideCodec.createFrameDecoder(options);
          const items: IncomingFrame[] = [];
          for (let at = 0; at < bytes.length;) {
            const to = Math.min(bytes.length, at + 1 + Math.floor(next() * (run % 2 === 0 ? 16 : 4096)));
            items.push(...decoder.push(bytes.subarray(at, to)));
            at = to;
          }
          items.push(...decoder.end());
          assert.deepStrictEqual(items, expected, `run ${run}`);
        }
      });

      test('with every \\n written as \\r\\n (a Windows text-mode stdout, E13 [open]) the frames decode to the same texts', () => {
        // A stdio stream (the socket carries the bytes as written), so the stdio decoder, for every recording.
        const stream = eventsOf(scenario, 'recv', 'unframed');
        const crlf = (text: string): string => text.replace(/\n/g, '\r\n');
        const bytes = Buffer.from(stream.map((e) => (e.kind === 'recv' ? e.prefix + crlf(e.text) : crlf(e.text))).join(''), 'utf8');
        const expected = stream.map((e) => ({ kind: e.kind === 'recv' ? 'framed' : 'unframed', text: e.kind === 'recv' ? e.text : crlf(e.text) }));
        const next = prng(SCENARIOS.indexOf(scenario) + 101);
        for (let run = 0; run < 4; run++) {
          const decoder = ideCodec.createFrameDecoder();
          const items: IncomingFrame[] = [];
          for (let at = 0; at < bytes.length;) {
            const to = Math.min(bytes.length, at + 1 + Math.floor(next() * (run % 2 === 0 ? 16 : 4096)));
            items.push(...decoder.push(bytes.subarray(at, to)));
            at = to;
          }
          items.push(...decoder.end());
          assert.deepStrictEqual(items.map(({ kind, text }) => ({ kind, text })), expected, `run ${run}`);
          assert.strictEqual(items.reduce((n, i) => n + i.byteLength, 0), bytes.length);
        }
      });

      test('every frame decodes to a message, every answer with its command\'s decoder', () => {
        for (const event of transcript(scenario).events) {
          if (event.kind === 'recv') {
            const message = decoded(event.text);
            if (message.kind === 'output' && message.payload.kind === 'highlight-source') {
              decodeSourceHighlights(message.payload.highlights);
            }
          }
        }
        for (const { request, payload } of exchanges(scenario)) {
          if ('command' in request && request.decode !== undefined) {
            request.decode(payload);
          }
        }
      });
    });
  }

  suite('facts', () => {
    test('F1: a reply with 𝕟 and → has a code-point prefix; a raw é in a request reaches the compiler as Latin-1', () => {
      const docs = eventsOf('plain', 'recv').find((e) => e.text.includes('𝕟'));
      assert.ok(docs !== undefined);
      assert.strictEqual(docs.prefix, '000132');
      assert.notStrictEqual(Buffer.byteLength(docs.text, 'utf8'), 0x132);
      assert.match(ok(decodeText(exchange('plain', 3).payload)).text, /The identity on 𝕟 → 𝕟;/);
      assert.strictEqual(ok(decodeText(exchange('plain', 4).payload)).text, '"\\226\\134\\146"');
      assert.strictEqual(errorMessage(exchange('plain', 5).payload), 'Unrecognised command: ((:bogus "Ã©") 6)');
    });

    test('F2: :type-of takes a 0-based column with inclusive end; replies are 0-based', () => {
      const answers = [1, 2, 3, 4].map((i) => exchange('clean-lookups', i).payload.kind);
      assert.deepStrictEqual(answers, ['error', 'ok', 'ok', 'error']);
      assert.strictEqual(ok(decodeText(exchange('clean-lookups', 2).payload)).text, 'xs : Vect ?_ ?_');
      assert.deepStrictEqual(ok(decodeNameAt(exchange('clean-lookups', 9).payload)), [{
        name: 'Clean.vlen_rhs', file: `${ROOT}/Clean.idr`, span: { start: { line: 7, column: 10 }, end: { line: 7, column: 19 } },
      }]);
      assert.deepStrictEqual(ok(decodeNameAt(exchange('clean-lookups', 10).payload)), []);
    });

    test('F2, ARCHITECTURE §7: editor positions reach the recorded requests only through core/positions.ts', () => {
      const clean = fixtureDocument('broken/Clean.idr');
      const at = toIdeTypeOfRequest(clean, { line: 7, character: 5 });
      assert.ok(at !== undefined);
      assert.strictEqual(ideCodec.encodeRequest(typeOf('xs', at), 3n).text, exchange('clean-lookups', 2).sent);
      const location = ok(decodeNameAt(exchange('clean-lookups', 9).payload))[0];
      assert.deepStrictEqual(fromIdeReplySpan(clean, location.span),
        { start: { line: 7, character: 10 }, end: { line: 7, character: 19 } });
      assert.strictEqual(clean.lineAt(7).text.slice(10, 19), '?vlen_rhs');
    });

    test('F11: .lidr requests and replies use unlit columns', () => {
      const lit = fixtureDocument('loose-file/Lit.lidr');
      const at = toIdeTypeOfRequest(lit, { line: 5, character: 9 });
      assert.ok(at !== undefined);
      assert.strictEqual(ideCodec.encodeRequest(typeOf('n', at), 2n).text, exchange('load-lit', 1).sent);
      assert.strictEqual(ok(decodeText(exchange('load-lit', 1).payload)).text, 'n : Nat');
      const [warning] = ofKind(exchange('load-lidr', 0).messages, 'warning');
      assert.deepStrictEqual(warning.warning.span, { start: { line: 8, column: 4 }, end: { line: 8, column: 7 } });
      const err = fixtureDocument('broken/Err.lidr');
      const range = fromIdeReplySpan(err, warning.warning.span);
      assert.strictEqual(err.lineAt(8).text.slice(range.start.character, range.end.character), '"x"');
    });

    test('F3: the eleven stubs print a notice and answer an empty or echoed result', () => {
      const notices = exchanges('stubs').map((x) => ofKind(x.messages, 'write-string').map((w) => w.text));
      assert.deepStrictEqual(notices, ['name-at <name> <line> <column>', 'add-missing', 'apropros', 'directive', 'who-calls',
        'calls-who', 'normalise-term', 'show-term-implicits', 'hide-term-implicits', 'elaborate-term', 'print-definition']
        .map((cmd) => [`${cmd}: command not yet implemented. Hopefully soon!`]));
      assert.deepStrictEqual(exchanges('stubs').map((x) => x.payload.kind), Array(11).fill('ok'));
      assert.strictEqual(ok(decodeText(exchange('stubs', 6).payload)).text, '1 + 1');
    });

    test('F4: unrecognised commands and parse errors answer with the previous id; :version is bare', () => {
      const answers = exchanges('handshake');
      assert.deepStrictEqual(answers.map((x) => x.id), [1n, 1n, 1n, 1n, 5n]);
      assert.deepStrictEqual(answers.map((x) => answersWithPreviousId(x.payload)), [false, true, true, true, false]);
      assert.strictEqual(errorMessage(answers[1].payload), 'Unrecognised command: ((:version) 2)');
      assert.match(errorMessage(answers[3].payload), /^Parse error: /);
      assert.deepStrictEqual(ok(decodeVersion(answers[4].payload)), { major: 0, minor: 8, patch: 0 });
    });

    test('F5: over stdio, program output and the end-of-input line are unframed; over the socket they are not', () => {
      const stdio = eventsOf('exec-stdio', 'unframed').map((e) => e.text);
      assert.deepStrictEqual(stdio, ['hi\n', 'Alas the file is done, aborting\n']);
      assert.deepStrictEqual(stdio.map(isEndOfInputLine), [false, true]);
      // Output without a final newline: the :return follows on the same line (wire.ts, "A reply
      // glued to output"); the recorded stream is `hi000015(:return (:ok "") 1)\n`.
      assert.deepStrictEqual(
        transcript('exec-stdio-putstr').events.filter((e) => e.kind === 'unframed' || e.kind === 'recv').map((e) => ('prefix' in e ? e.prefix : '') + ('text' in e ? e.text : '')),
        ['000018(:protocol-version 2 1)\n', 'hi', '000015(:return (:ok "") 1)\n', 'Alas the file is done, aborting\n'],
      );
      // Hex digits run into the header: the recorded streams are `7000015(:return …` and
      // `ab000015(:return …`, which the decoder must not read as headers of 7 or 8 digits (the
      // generic test above decodes them).
      assert.deepStrictEqual(
        transcript('exec-stdio-putstr-digit').events.filter((e) => e.kind === 'unframed' || e.kind === 'recv').map((e) => ('prefix' in e ? e.prefix : '') + ('text' in e ? e.text : '')),
        ['000018(:protocol-version 2 1)\n', '7', '000015(:return (:ok "") 1)\n', 'ab', '000015(:return (:ok "") 2)\n', 'Alas the file is done, aborting\n'],
      );
      // The compiler's own log lines too (a %logging pragma), in the middle of a load's frames.
      const logging = transcript('load-logging').events.map((e) => (e.kind === 'unframed' ? `unframed ${e.text}` : e.kind));
      const from = logging.findIndex((e) => e.startsWith('unframed'));
      assert.deepStrictEqual(logging.slice(from - 1, from + 8), [
        'recv',
        'unframed LOG declare.def.lhs:3: LHS term: Logging.f\n',
        'unframed LOG declare.def.clause:3: RHS term: (Prelude.Types.S Prelude.Types.Z)\n',
        'unframed LOG declare.def:2: Case tree for Logging.f: [0] (Prelude.Types.S Prelude.Types.Z)\n',
        'unframed LOG declare.def:3: Working from [0] (Prelude.Types.S Prelude.Types.Z)\n',
        'unframed LOG declare.def:3: Catch all case in Logging.f\n',
        'unframed LOG declare.def:3: Initially missing in Logging.f:\n',
        'unframed \n',
        'recv',
      ]);
      for (const scenario of SCENARIOS.filter((s) => transcript(s).meta.transport === 'socket')) {
        assert.deepStrictEqual(eventsOf(scenario, 'unframed'), [], scenario);
        const out = eventsOf(scenario, 'stdout').map((e) => e.text);
        assert.ok(isEndOfInputLine(out[out.length - 1]), scenario);
      }
      for (const scenario of SCENARIOS.filter((s) => transcript(s).meta.transport === 'stdio')) {
        const unframed = eventsOf(scenario, 'unframed').map((e) => e.text);
        assert.ok(isEndOfInputLine(unframed[unframed.length - 1]), scenario);
      }
    });

    test('F6: a load error is a :warning with a path relative to the session directory, then :error', () => {
      const { messages, payload } = exchange('load-bad', 0);
      const [warning] = ofKind(messages, 'warning');
      assert.strictEqual(warning.warning.file, 'Bad.idr');
      assert.deepStrictEqual(warning.warning.span, { start: { line: 3, column: 6 }, end: { line: 3, column: 11 } });
      assert.match(warning.warning.message, /^While processing right hand side of f\. /);
      assert.match(warning.warning.message, /\n\nBad:4:7--4:12\n/);
      assert.strictEqual(errorMessage(payload), `Error(s) building file ${ROOT}/Bad.idr`);
      const coverage = ofKind(exchange('load-part', 0).messages, 'warning');
      assert.deepStrictEqual(coverage.map((w) => w.warning.span.start), [{ line: 2, column: 0 }, { line: 5, column: 0 }]);
      assert.match(coverage[0].warning.message, /\n\nMissing cases:\n {4}g \(S _\)\n$/);
      assert.deepStrictEqual(ofKind(exchange('load-uses-bad', 0).messages, 'warning').map((w) => w.warning.file), ['Bad.idr']);
    });

    test('F7: a warning-only load returns :ok; a fresh reload sends no Building line and no :warning', () => {
      const [first, reload] = exchanges('load-warn');
      assert.deepStrictEqual(ofKind(first.messages, 'warning').map((w) => w.warning.message.split('\n')[0]), ['Unreachable clause: f n']);
      assert.strictEqual(ofKind(first.messages, 'write-string').filter((w) => decodeBuildingLine(w.text) !== undefined).length, 1);
      assert.deepStrictEqual([first.payload, reload.payload].map((p) => p.kind), ['ok', 'ok']);
      assert.deepStrictEqual(ofKind(reload.messages, 'warning'), []);
      assert.deepStrictEqual(ofKind(reload.messages, 'write-string'), []);
      assert.ok(ofKind(reload.messages, 'output').length > 0);
      const mixed = exchange('load-mixed', 0);
      assert.strictEqual(ofKind(mixed.messages, 'warning').length, 2);
      assert.strictEqual(mixed.payload.kind, 'error');
    });

    test('Building lines: relative for imported modules, as sent for the loaded file', () => {
      const lines = ofKind(exchange('load-simple-ipkg', 0).messages, 'write-string').map((w) => decodeBuildingLine(w.text));
      assert.deepStrictEqual(lines, [
        { index: 1, total: 2, module: 'Foo.A', file: 'src/Foo/A.idr' },
        { index: 2, total: 2, module: 'Foo.B', file: `${ROOT}/src/Foo/B.idr` },
      ]);
      for (const scenario of SCENARIOS.filter((s) => s !== 'stubs')) {
        for (const x of exchanges(scenario)) {
          for (const w of ofKind(x.messages, 'write-string')) {
            assert.ok(decodeBuildingLine(w.text) !== undefined, `${scenario}: ${w.text}`);
          }
        }
      }
    });

    test('F10: a malformed .ipkg makes :load-file an :error without :warning, naming the ipkg position', () => {
      const { messages, payload } = exchange('load-bad-ipkg', 0);
      assert.deepStrictEqual(messages, []);
      assert.match(errorMessage(payload), /^Unrecognised property "pkgs"\.\n\n"bad\.ipkg":3:1--3:5\n/);
    });

    test('F14: after (:enable-syntax :False) a load sends no :highlight-source', () => {
      assert.strictEqual(ok(decodeText(exchange('enable-syntax', 0).payload)).text, 'Syntax highlight option changed to False');
      assert.deepStrictEqual(ofKind(exchange('enable-syntax', 1).messages, 'output'), []);
      assert.ok(ofKind(exchange('clean-lookups', 0).messages, 'output').length > 0);
    });

    test('F15, F16: :missing lists the missing clauses; :type-of still answers after a failed load', () => {
      assert.deepStrictEqual(ok(decodeMissingCases(exchange('load-part', 1).payload)),
        [{ kind: 'missing', name: 'Part.g', clauses: ['g (S _)'] }]);
      assert.strictEqual(ok(decodeText(exchange('load-part', 2).payload)).text, 'Part.main : IO ()');
      assert.strictEqual(ok(decodeText(exchange('load-part', 3).payload)).text, 'Part.main : IO ()');
      assert.strictEqual(errorMessage(exchange('plain', 1).payload), 'No clause to split here');
    });

    test('F29: :intro lists candidates, :refine answers one string or the ambiguity with its alternatives', () => {
      assert.deepStrictEqual(ok(decodeIntro(exchange('clean-editing', 16).payload)), ['0', 'S ?vlen_rhs_0']);
      assert.strictEqual(ok(decodeText(exchange('clean-editing', 17).payload)).text, 'S ?vlen_rhs_0');
      const ambiguity = decodeText(exchange('ambig-refine', 1).payload);
      assert.strictEqual(ambiguity.kind, 'error');
      assert.deepStrictEqual(decodeAmbiguity((ambiguity as Extract<typeof ambiguity, { kind: 'error' }>).message),
        ['Ambig.A.foo ?g_rhs_0', 'Ambig.B.foo ?g_rhs_0']);
    });

    test('F30: :generate-def answers one multi-line string; :proof-search a string followed by highlighting', () => {
      const texts = [13, 14, 15].map((i) => ok(decodeText(exchange('clean-editing', i).payload)).text);
      assert.deepStrictEqual(texts.map((t) => t.split('\n').length), [2, 3, 3]);
      assert.strictEqual(texts[0], 'append [] ys = ys\nappend (x :: xs) ys = x :: append xs ys');
      assert.match(texts[2], /y :: append xs \(x :: ys\)$/);
      const search = [9, 10, 11].map((i) => ok(decodeText(exchange('clean-editing', i).payload)));
      assert.deepStrictEqual(search.map((s) => s.text), ['0', '1', '2']);
      assert.deepStrictEqual(search.map((s) => s.highlighting.map((h) => [h.start, h.length])), [[[0, 1]], [[0, 1]], [[0, 1]]]);
      const xs = ok(decodeText(exchange('clean-lookups', 2).payload));
      assert.deepStrictEqual(xs.highlighting.map((h) => [h.start, h.length]), [[5, 4]]);
    });

    test('F31: the :full/:overview modes, the :all mode and the load line are ignored', () => {
      const docs = [6, 7, 8].map((i) => exchange('clean-lookups', i).payload);
      assert.deepStrictEqual(docs[1], docs[0]);
      assert.deepStrictEqual(docs[2], docs[0]);
      assert.deepStrictEqual(exchange('clean-editing', 12).payload, exchange('clean-editing', 9).payload);
      assert.strictEqual(exchange('clean-lookups', 12).payload.kind, 'ok');
    });

    test('F33: :highlight-source carries no types or docs', () => {
      let names = 0;
      for (const scenario of SCENARIOS) {
        for (const event of eventsOf(scenario, 'recv')) {
          const message = decoded(event.text);
          if (message.kind === 'output' && message.payload.kind === 'highlight-source') {
            for (const h of decodeSourceHighlights(message.payload.highlights)) {
              if (h.name !== undefined) {
                names++;
                assert.strictEqual(h.docOverview, '');
                assert.strictEqual(h.type, '');
              }
            }
          }
        }
      }
      assert.ok(names > 0);
    });

    test('editing replies: case split, add clause, make lemma/with/case', () => {
      const editing = (i: number): string => ok(decodeText(exchange('clean-editing', i).payload)).text;
      for (const i of [1, 2, 3]) {
        assert.strictEqual(editing(i), 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1');
      }
      assert.strictEqual(errorMessage(exchange('clean-editing', 4).payload), 'No clause to split here');
      assert.strictEqual(editing(5), 'append xs ys = ?append_rhs');
      assert.deepStrictEqual(ok(decodeLemma(exchange('clean-editing', 6).payload)),
        { application: 'vlen_rhs xs', lemma: 'vlen_rhs : Vect n a -> Nat' });
      assert.strictEqual(editing(7), 'vlen xs with (_)\n  vlen xs | with_pat = ?vlen_rhs_rhs');
      assert.strictEqual(editing(8), 'vlen xs = case _ of\n               case_val => ?vlen_rhs');
    });

    test(':metavariables: names read back from their show; premises with multiplicities', () => {
      assert.deepStrictEqual(ok(decodeMetavariables(exchange('clean-lookups', 11).payload)), [
        { name: 'Clean.append', type: 'Vect n a -> Vect m a -> Vect (plus n m) a', premises: [] },
        {
          name: 'Clean.vlen_rhs',
          type: 'Nat',
          premises: [
            { name: 'a', type: 'Type', multiplicity: 0, implicit: false },
            { name: 'n', type: 'Nat', multiplicity: 0, implicit: false },
            { name: 'xs', type: 'Vect n a', multiplicity: 'unrestricted', implicit: false },
          ],
        },
      ]);
    });

    test('a path through a symbolic link to the session directory is refused; the real path loads', () => {
      const [viaLink, real, relative] = exchanges('load-symlink');
      assert.strictEqual(errorMessage(viaLink.payload), `Source file "${LINK}/Clean.idr" is not in the source directory "${ROOT}"`);
      assert.deepStrictEqual([real.payload.kind, relative.payload.kind], ['ok', 'ok']);
    });

    test('E5: each warning kind arrives as :warning of a load that returns :ok', () => {
      for (const scenario of SCENARIOS.filter((s) => s.startsWith('warning-'))) {
        for (const x of exchanges(scenario)) {
          assert.strictEqual(x.payload.kind, 'ok', scenario);
          assert.ok(ofKind(x.messages, 'warning').length > 0, scenario);
        }
      }
      const [ipkg] = ofKind(exchange('warning-ipkg-deprecated', 1).messages, 'warning');
      assert.strictEqual(ipkg.warning.file, 'old.ipkg');
      assert.deepStrictEqual(ipkg.warning.highlighting, []);
    });
  });
});
