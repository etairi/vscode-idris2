// E2E (ROADMAP M2 acceptance): the protocol facts of ROADMAP §0 that M2 pins — F1–F7, F10,
// F12–F14, F29–F33 — against the real idris2, one row (or one part of a row) per test; and (M3)
// the facts M3's features rest on: E14 (columns count code points), how `:interpret` renders an IO
// action (normalised, not run), and which texts the REPL parser inside `:interpret` reads as a
// command (the ground truth of the evaluation's refusal, src/backend/ide/replCommand.ts). Each
// test runs the requests of a recorded scenario (test/fixtures/transcripts/0.8.0; the requests
// do not depend on the compiler version) or requests of its own in a fresh temporary copy of the
// scenario's fixture workspace, and reads the replies with the extension's codec and decoders
// (src/backend/ide/protocol.ts). A last test compares every scenario with its recording when the
// compiler is the recorded version, so a change of the protocol or of a reply shows up as a diff.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  answersWithPreviousId,
  decodeAmbiguity,
  decodeBuildingLine,
  decodeIntro,
  decodeNameAt,
  decodeSourceHighlights,
  decodeText,
  ideCodec,
  interpret,
  isEndOfInputLine,
  loadFile,
  typeOf,
} from '../../src/backend/ide/protocol';
import { checkBuildDir } from '../../src/backend/ide/pool';
import type { IdeMessage, ReplyPayload, WarningReport } from '../../src/backend/ide/types';
import { readIpkgText } from '../../src/project/ipkg';
import type { ProjectRoot } from '../../src/project/types';
import { exchanges, mapTrailingId, readTranscripts, requestFrame, substitute, transcriptsDir } from '../fake-idris2/client';
import { repoRoot } from '../fake-tools/paths';
import { copyWorkspace, filesBelow, runIdeSession, runScenario, sessionArgs, type LiveExchange, type LiveRun } from './ideDriver';
import { extensionApi, probedIdris2, probedVersion, quiesce } from './helpers';

/** The version whose transcripts are in the repository. */
const RECORDED_VERSION = '0.8.0';

let idris2: string;
let version: string;
/** Scenario runs, shared by the tests that read the same scenario (each runs once). */
const runs = new Map<string, Promise<{ run: LiveRun; root: string }>>();

/** The run of the recorded scenario `name` and the root of the (deleted) workspace copy. */
function scenario(name: string): Promise<{ run: LiveRun; root: string }> {
  let result = runs.get(name);
  if (result === undefined) {
    result = runScenario(idris2, name);
    runs.set(name, result);
  }
  return result;
}

const live = async (name: string): Promise<LiveRun> => (await scenario(name)).run;

/** `JSON.stringify` that also writes the `bigint`s of s-expressions (as `123n`). */
const json = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

/** The messages of an exchange, each decoded (fails on a frame the codec cannot decode). */
function messages(exchange: LiveExchange): IdeMessage[] {
  return exchange.messages.map((m, i) => {
    assert.strictEqual(m.kind, 'message', `frame ${i} of the reply to ${exchange.request}: ${exchange.frames[i]}`);
    return m.message;
  });
}

/** The `:return` of an exchange: its payload and id. */
function returned(exchange: LiveExchange): { payload: ReplyPayload; id: bigint } {
  const ret = messages(exchange).find((m) => m.kind === 'return');
  assert.ok(ret, `no :return for ${exchange.request}`);
  return { payload: ret.payload, id: ret.id };
}

const warnings = (exchange: LiveExchange): WarningReport[] =>
  messages(exchange).flatMap((m) => (m.kind === 'warning' ? [m.warning] : []));
const writeStrings = (exchange: LiveExchange): string[] =>
  messages(exchange).flatMap((m) => (m.kind === 'write-string' ? [m.text] : []));
const highlightFrames = (exchange: LiveExchange): IdeMessage[] =>
  messages(exchange).filter((m) => m.kind === 'output' && m.payload.kind === 'highlight-source');

/** The exchange whose request contains `fragment` (exactly one must). */
function reply(run: LiveRun, fragment: string): LiveExchange {
  const found = run.exchanges.filter((e) => e.request.includes(fragment));
  assert.strictEqual(found.length, 1, `${found.length} requests contain ${fragment}`);
  return found[0];
}

/** The text of a `(:ok "TEXT" …)` return. */
function okText(exchange: LiveExchange): string {
  const result = decodeText(returned(exchange).payload);
  assert.strictEqual(result.kind, 'ok', `${exchange.request}: ${json(result)}`);
  return result.value.text;
}

/** The message of a `(:error …)` return. */
function errorMessage(exchange: LiveExchange): string {
  const { payload } = returned(exchange);
  assert.strictEqual(payload.kind, 'error', `${exchange.request}: ${json(payload)}`);
  return payload.message;
}

/** A request's text with its id: `((:cmd …) ID)\n` → `(:cmd …)`. */
const withoutId = (request: string): string => request.replace(/^\((.*) [0-9]+\)\n$/s, '$1');

/** Frame texts with the request id of `(… ID)\n` removed, for comparing replies of two requests. */
const withoutIds = (exchange: LiveExchange): string[] => exchange.frames.map((f) => mapTrailingId(f, () => 0n));

suite('E2E: IDE-mode protocol facts (ROADMAP §0) against the real idris2', function () {
  this.timeout(120000);

  suiteSetup(async function () {
    this.timeout(90000);
    const api = await extensionApi();
    await quiesce(api);
    idris2 = probedIdris2(api);
    version = probedVersion(api);
  });

  // F1 -------------------------------------------------------------------------------------

  test('F1: a request framed by UTF-8 bytes is read; non-ASCII request text arrives as Latin-1', async () => {
    const run = await live('plain');
    // ((:interpret "\"→\"") 5): the three bytes of → arrive as three Latin-1 characters.
    assert.strictEqual(okText(reply(run, ':interpret "\\"→')), '"\\226\\134\\146"');
    const bogus = reply(run, ':bogus');
    assert.strictEqual(errorMessage(bogus), 'Unrecognised command: ((:bogus "Ã©") 6)');
  });

  test('F1: a reply is prefixed with its length in code points, not bytes', async () => {
    const docs = reply(await live('plain'), ':docs-for "f"');
    const [frame] = docs.items.filter((i) => i.kind === 'framed');
    // The codec cuts frames by code points; the frame's bytes on the wire are more.
    assert.ok(Buffer.byteLength(frame.text) > Array.from(frame.text).length, 'the reply is not ASCII');
    assert.strictEqual(frame.byteLength, 6 + Buffer.byteLength(frame.text));
    assert.match(okText(docs), /The identity on 𝕟 → 𝕟;/);
  });

  test('F1: the same request framed by code points is misread, and so is the request after it', async () => {
    const { dir, root } = copyWorkspace('loose-file');
    try {
      const text = '((:interpret "\\"→\\"") 1)\n';
      const byCodePoints = Buffer.from(Array.from(text).length.toString(16).padStart(6, '0') + text, 'utf8');
      const run = await runIdeSession({
        executable: idris2,
        cwd: root,
        transport: 'stdio',
        args: sessionArgs(root),
        requests: [{ bytes: Buffer.concat([byCodePoints, requestFrame('(:version 2)\n')]), returns: 2 }],
      });
      const returns = messages(run.exchanges[0]).filter((m) => m.kind === 'return');
      assert.strictEqual(returns.length, 2);
      for (const r of returns) {
        assert.ok(r.kind === 'return' && r.payload.kind === 'error' && r.payload.message.startsWith('Parse error:'), json(r));
        assert.strictEqual(r.id, 0n); // F4: no request was recognised yet
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F1: the extension\'s encoder sends non-ASCII text as escapes the compiler reads as the characters', async () => {
    // Not a §0 row: the [open] question of src/backend/ide/types.ts, whether the string escapes
    // carry non-ASCII paths and expressions intact. A directory named é→𝕟 and an expression.
    const { dir, root } = copyWorkspace('broken');
    try {
      const odd = path.join(dir, 'é→𝕟');
      fs.mkdirSync(odd);
      fs.copyFileSync(path.join(root, 'Clean.idr'), path.join(odd, 'Clean.idr'));
      const encode = (command: Parameters<typeof ideCodec.encodeRequest>[0], id: bigint): string => {
        const frame = ideCodec.encodeRequest(command, id);
        assert.strictEqual(parseInt(frame.text.slice(0, 6), 16), frame.bytes.length - 6); // F1
        return frame.text.slice(6);
      };
      const run = await runIdeSession({
        executable: idris2,
        cwd: odd,
        transport: 'stdio',
        args: sessionArgs(odd),
        requests: [encode(loadFile(path.join(odd, 'Clean.idr')), 1n), encode(interpret('"→"'), 2n), encode(typeOf('vlen'), 3n)],
      });
      const [load, expr, type] = run.exchanges;
      assert.deepStrictEqual(returned(load).payload, { kind: 'ok', result: { kind: 'list', items: [] }, highlighting: [] });
      assert.deepStrictEqual(decodeBuildingLine(writeStrings(load)[0]), {
        index: 1,
        total: 1,
        module: 'Clean',
        file: path.join(odd, 'Clean.idr'),
      });
      assert.strictEqual(okText(expr), '"\\8594"'); // one character, shown with Idris's escape
      assert.strictEqual(okText(type), 'Clean.vlen : Vect n a -> Nat');
      assert.ok(filesBelow(path.join(odd, 'build', '.vscode-idris2')).some((f) => f.endsWith('/Clean.ttc')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // F2 -------------------------------------------------------------------------------------

  test('F2: :type-of NAME L C takes a 1-based line and a 0-based column, inclusive end', async () => {
    const run = await live('clean-lookups');
    assert.match(errorMessage(reply(run, '(:type-of "xs" 8 4)')), /^Undefined name xs\./);
    assert.strictEqual(okText(reply(run, '(:type-of "xs" 8 5)')), 'xs : Vect ?_ ?_');
    assert.strictEqual(okText(reply(run, '(:type-of "xs" 8 7)')), 'xs : Vect ?_ ?_');
    assert.match(errorMessage(reply(run, '(:type-of "xs" 8 8)')), /^Undefined name xs\./);
  });

  test('F2: :case-split L C NAME takes a 1-based column; C = 0 means anywhere on the line', async () => {
    const run = await live('clean-editing');
    const split = 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1';
    for (const c of [0, 1, 8]) {
      assert.strictEqual(okText(reply(run, `(:case-split 8 ${c} "xs")`)), split, `column ${c}`);
    }
    assert.strictEqual(errorMessage(reply(run, '(:case-split 8 9 "xs")')), 'No clause to split here');
  });

  test('F2: :name-at answers 0-based end-exclusive spans for an unqualified name, () for a qualified one', async () => {
    const { run, root } = await scenario('clean-lookups');
    const found = decodeNameAt(returned(reply(run, '(:name-at "vlen_rhs")')).payload);
    assert.deepStrictEqual(found, {
      kind: 'ok',
      value: [{ name: 'Clean.vlen_rhs', file: path.join(root, 'Clean.idr'), span: { start: { line: 7, column: 10 }, end: { line: 7, column: 19 } } }],
    });
    assert.deepStrictEqual(decodeNameAt(returned(reply(run, '(:name-at "Clean.vlen_rhs")')).payload), { kind: 'ok', value: [] });
  });

  // F3 -------------------------------------------------------------------------------------

  test('F3: eleven commands are stubs: a "not yet implemented" write-string, then :ok', async () => {
    const run = await live('stubs');
    assert.strictEqual(run.exchanges.length, 11);
    for (const exchange of run.exchanges) {
      const notices = writeStrings(exchange);
      assert.strictEqual(notices.length, 1, exchange.request);
      assert.match(notices[0], /: command not yet implemented\. Hopefully soon!$/, exchange.request);
      assert.strictEqual(returned(exchange).payload.kind, 'ok', exchange.request);
    }
    assert.strictEqual(writeStrings(run.exchanges[0])[0], 'name-at <name> <line> <column>: command not yet implemented. Hopefully soon!');
  });

  // F4 -------------------------------------------------------------------------------------

  test('F4: unrecognised and unparsable requests are answered with the previous id; version is a bare symbol', async () => {
    const run = await live('handshake');
    const [version1, parenthesised, cd, unparsable, version5] = run.exchanges;
    assert.strictEqual(returned(version1).id, 1n);
    assert.strictEqual(returned(version1).payload.kind, 'ok');
    for (const [exchange, message] of [
      [parenthesised, 'Unrecognised command: ((:version) 2)'],
      [cd, 'Unrecognised command: ((:cd "/tmp") 3)'],
    ] as const) {
      assert.strictEqual(errorMessage(exchange), message);
      assert.strictEqual(returned(exchange).id, 1n);
      assert.ok(answersWithPreviousId(returned(exchange).payload));
    }
    assert.match(errorMessage(unparsable), /^Parse error: /);
    assert.strictEqual(returned(unparsable).id, 1n);
    assert.ok(answersWithPreviousId(returned(unparsable).payload));
    assert.strictEqual(returned(version5).id, 5n);
  });

  // F5 -------------------------------------------------------------------------------------

  test('F5: over stdio, program output arrives unframed in the protocol stream; end of input: the tail, exit 1', async () => {
    const run = await live('exec-stdio');
    const items = run.exchanges[0].items;
    assert.deepStrictEqual(items.map((i) => [i.kind, i.text]), [
      ['unframed', 'hi\n'],
      ['framed', '(:return (:ok "") 1)\n'],
    ]);
    assert.ok(isEndOfInputLine(run.tailStream), run.tailStream);
    assert.strictEqual(run.exitCode, 1);
  });

  test('F5: over the socket, a port line, program output on the process stdout, a framed stream', async () => {
    const run = await live('exec-socket');
    assert.deepStrictEqual(run.exchanges[0].items.map((i) => [i.kind, i.text]), [['framed', '(:return (:ok "") 1)\n']]);
    // The process stdout and the socket are two streams, so "hi" may come after the :return.
    assert.strictEqual(run.exchanges[0].stdout + run.tailStdout, 'hi\nAlas the file is done, aborting\n');
    assert.strictEqual(run.tailStream, '');
    assert.strictEqual(run.exitCode, 1);
  });

  test('F5 addendum: two requests in one socket write are answered once — the second is dropped', async () => {
    const { dir, root } = copyWorkspace('loose-file');
    try {
      const run = await runIdeSession({
        executable: idris2,
        cwd: root,
        transport: 'socket',
        args: sessionArgs(root),
        requests: [{ bytes: Buffer.concat([requestFrame('(:version 1)\n'), requestFrame('(:version 2)\n')]), returns: 1 }],
      });
      assert.deepStrictEqual(messages(run.exchanges[0]).map((m) => (m.kind === 'return' ? m.id : m.kind)), [1n]);
      // Had request 2 been read, its reply would have come before the end of input.
      assert.strictEqual(run.tailStream, '', 'no reply to the second request');
      assert.ok(isEndOfInputLine(run.tailStdout), run.tailStdout);
      assert.strictEqual(run.exitCode, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F5 addendum: input that ends five bytes into a request: exit 0, silently (no end-of-input line)', async () => {
    const { dir, root } = copyWorkspace('loose-file');
    try {
      const run = await runIdeSession({
        executable: idris2,
        cwd: root,
        transport: 'stdio',
        args: sessionArgs(root),
        requests: [{ bytes: Buffer.from('00001', 'latin1'), returns: 0 }],
      });
      assert.strictEqual(run.tailStream, '');
      assert.strictEqual(run.stderr, '');
      assert.strictEqual(run.exitCode, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F5: the compiler\'s log lines (%logging) are unframed over stdio, between the frames of a load', async () => {
    const [load] = (await live('load-logging')).exchanges;
    const unframed = load.items.filter((i) => i.kind === 'unframed').map((i) => i.text);
    assert.ok(unframed.length >= 2 && unframed.every((line) => line === '\n' || line.startsWith('LOG declare.def')), json(unframed));
    assert.ok(load.items[0].kind === 'framed' && load.items.at(-1)?.kind === 'framed', 'inside the load, not after it');
    assert.strictEqual(returned(load).payload.kind, 'ok');
  });

  test('F5: over the socket the same log lines go to the process stdout (block-buffered: they may come at exit); the socket stays framed', async () => {
    const { run } = await runScenario(idris2, 'load-logging', { transport: 'socket' });
    const [load] = run.exchanges;
    assert.ok(load.items.every((i) => i.kind === 'framed'), json(load.items.map((i) => i.kind)));
    assert.strictEqual(returned(load).payload.kind, 'ok');
    const stdout = load.stdout + run.tailStdout;
    assert.match(stdout, /^LOG declare\.def[^\n]*\n(?:(?:LOG [^\n]*)?\n)*Alas the file is done, aborting\n$/);
    assert.strictEqual(run.tailStream, '');
  });

  // F6, F7 ---------------------------------------------------------------------------------

  test('F6: a load error: :warning frames (file relative to the cwd, 0-based end-exclusive), then :error', async () => {
    const bad = (await live('load-bad')).exchanges[0];
    const [w] = warnings(bad);
    assert.strictEqual(warnings(bad).length, 1);
    assert.strictEqual(w.file, 'Bad.idr');
    assert.deepStrictEqual(w.span, { start: { line: 3, column: 6 }, end: { line: 3, column: 11 } });
    assert.match(w.message, /^While processing right hand side of f\./);
    assert.match(w.message, /\n\nBad:4:7--4:12\n/);
    assert.match(errorMessage(bad), /^Error\(s\) building file .*Bad\.idr$/);

    const part = (await live('load-part')).exchanges[0];
    const [g] = warnings(part);
    assert.strictEqual(g.file, 'Part.idr');
    assert.deepStrictEqual(g.span, { start: { line: 2, column: 0 }, end: { line: 2, column: 14 } });
    assert.match(g.message, /\n\nPart:3:1--3:15\n/);
    assert.match(g.message, /\n\nMissing cases:\n {4}g \(S _\)\n$/);
  });

  test('F7: a warning-only load: one :warning and :ok; a reload of a fresh file: no Building, no :warning, highlighting', async () => {
    const [first, reload] = (await live('load-warn')).exchanges;
    assert.strictEqual(warnings(first).length, 1);
    assert.match(warnings(first)[0].message, /^Unreachable clause: f n\n/);
    assert.deepStrictEqual(returned(first).payload, { kind: 'ok', result: { kind: 'list', items: [] }, highlighting: [] });
    assert.strictEqual(writeStrings(first).filter((t) => decodeBuildingLine(t) !== undefined).length, 1);
    assert.deepStrictEqual(writeStrings(reload), []);
    assert.deepStrictEqual(warnings(reload), []);
    assert.ok(highlightFrames(reload).length > 0);
    assert.strictEqual(returned(reload).payload.kind, 'ok');
  });

  test('F7: no severity field: a warning and an error both arrive as :warning, then :error', async () => {
    const mixed = (await live('load-mixed')).exchanges[0];
    assert.strictEqual(warnings(mixed).length, 2);
    assert.ok(warnings(mixed).some((w) => w.message.startsWith('Unreachable clause:')));
    assert.strictEqual(returned(mixed).payload.kind, 'error');
  });

  // F10 ------------------------------------------------------------------------------------

  test('F10: a malformed .ipkg in the cwd turns :load-file into an :error with its location, no :warning', async () => {
    const load = (await live('load-bad-ipkg')).exchanges[0];
    assert.deepStrictEqual(warnings(load), []);
    const message = errorMessage(load);
    assert.match(message, /Unrecognised property "pkgs"\./);
    assert.match(message, /"bad\.ipkg":3:1--3:5/);
  });

  // F12, F13 -------------------------------------------------------------------------------

  test('F12: --build-dir build/.vscode-idris2 holds the TTCs of a package without builddir', async () => {
    const { run, root, dir } = await runScenario(idris2, 'load-simple-ipkg', { keep: true });
    try {
      assert.strictEqual(returned(run.exchanges[0]).payload.kind, 'ok');
      const built = filesBelow(path.join(root, 'build'));
      assert.ok(built.length > 0);
      for (const f of built) {
        assert.match(f, /^\.vscode-idris2\/ttc\/\d+\/Foo\/[AB]\.tt[cm]$/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F12: an ipkg builddir overrides --build-dir', async () => {
    const { run, root, dir } = await runScenario(idris2, 'load-builddir-ipkg', { keep: true });
    try {
      assert.strictEqual(returned(run.exchanges[0]).payload.kind, 'ok');
      assert.deepStrictEqual(filesBelow(path.join(root, 'build')), []);
      assert.ok(filesBelow(path.join(root, 'out')).some((f) => /^ttc\/\d+\/Hello\.ttc$/.test(f)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F12 addendum: a --build-dir in the ipkg\'s opts wins over the command line and over builddir, where checkBuildDir says', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-e2e-')));
    try {
      for (const [name, ipkgText, expected] of [
        ['opts', 'package opts\nopts = "--build-dir build"\nmodules = Foo\n', 'build'],
        ['both', 'package both\nbuilddir = "bd"\nopts = "--total --build-dir od"\nmodules = Foo\n', 'od'],
      ] as const) {
        const root = path.join(dir, name);
        fs.mkdirSync(root);
        const ipkgPath = path.join(root, `${name}.ipkg`);
        fs.writeFileSync(ipkgPath, ipkgText);
        fs.writeFileSync(path.join(root, 'Foo.idr'), 'module Foo\n\nx : Nat\nx = 1\n');
        const model = readIpkgText(ipkgText);
        const project: ProjectRoot = { kind: 'project', ipkgPath, dir: root, otherIpkgs: [], insideWorkspace: false, model };
        const build = checkBuildDir(project, root, { isolateBuildDir: true, extraArgs: [] }, process.platform);
        assert.deepStrictEqual(build, { dir: path.join(root, expected), isolated: false }, name);
        // Started as the extension started such a session before the second review, with the
        // isolated --build-dir: the compiler applies the .ipkg's opts over it at the load.
        const run = await runIdeSession({
          executable: idris2,
          cwd: root,
          transport: 'stdio',
          args: sessionArgs(root),
          requests: [`((:load-file "${path.join(root, 'Foo.idr')}") 1)\n`],
        });
        assert.strictEqual(returned(run.exchanges[0]).payload.kind, 'ok', name);
        assert.ok(filesBelow(build.dir).some((f) => /^ttc\/\d+\/Foo\.ttc$/.test(f)), `${name}: ${filesBelow(root).join(', ')}`);
        assert.deepStrictEqual(filesBelow(path.join(root, 'build', '.vscode-idris2')), [], name);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F13: from the ipkg directory a relative and an absolute path load; from a subdirectory too, without --find-ipkg', async () => {
    assert.strictEqual(returned((await live('load-simple-ipkg')).exchanges[0]).payload.kind, 'ok');
    const { dir, root } = copyWorkspace('simple-ipkg');
    try {
      const fromRoot = await runIdeSession({
        executable: idris2,
        cwd: root,
        transport: 'stdio',
        args: sessionArgs(root),
        requests: ['((:load-file "src/Foo/B.idr") 1)\n'],
      });
      assert.strictEqual(returned(fromRoot.exchanges[0]).payload.kind, 'ok');
      const sub = path.join(root, 'src', 'Foo');
      const fromSub = await runIdeSession({ executable: idris2, cwd: sub, transport: 'stdio', args: sessionArgs(sub), requests: ['((:load-file "B.idr") 1)\n'] });
      assert.strictEqual(returned(fromSub.exchanges[0]).payload.kind, 'ok');
      assert.deepStrictEqual(writeStrings(fromSub.exchanges[0]).map((t) => decodeBuildingLine(t)?.module), ['Foo.A', 'Foo.B']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F13: from a foreign working directory the absolute path does not load', async () => {
    // ROADMAP §0 F13 quotes `Module Foo.A not found` here; on 0.8.0 (2026-09-27, this test) the
    // reply is that the file is not in the source directory, which is the working directory.
    const { dir, root } = copyWorkspace('simple-ipkg');
    try {
      const foreign = path.join(dir, 'foreign');
      fs.mkdirSync(foreign);
      const b = path.join(root, 'src', 'Foo', 'B.idr');
      const run = await runIdeSession({
        executable: idris2,
        cwd: foreign,
        transport: 'stdio',
        args: sessionArgs(foreign),
        requests: [ideCodec.encodeRequest(loadFile(b), 1n).text.slice(6)],
      });
      assert.strictEqual(errorMessage(run.exchanges[0]), `Source file "${b}" is not in the source directory "${foreign}"`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('F13: a session started through a symbolic link refuses the path spelled through the link', async () => {
    const [throughLink, realPath, relative] = (await live('load-symlink')).exchanges;
    assert.match(errorMessage(throughLink), /^Source file ".*\/link\/Clean\.idr" is not in the source directory ".*\/broken"$/);
    assert.strictEqual(returned(realPath).payload.kind, 'ok');
    assert.strictEqual(returned(relative).payload.kind, 'ok');
  });

  // F14 ------------------------------------------------------------------------------------

  test('F14: after (:enable-syntax :False) a load sends no :highlight-source frame', async () => {
    const [enable, load] = (await live('enable-syntax')).exchanges;
    assert.strictEqual(okText(enable), 'Syntax highlight option changed to False');
    assert.strictEqual(returned(load).payload.kind, 'ok');
    assert.deepStrictEqual(highlightFrames(load), []);
    assert.ok(highlightFrames((await live('clean-lookups')).exchanges[0]).length > 0, 'the same load with highlighting on');
  });

  // F29, F30, F31 --------------------------------------------------------------------------

  test('F29: :intro answers a list of candidates, :refine one string, an ambiguous :refine the alternatives', async () => {
    const run = await live('clean-editing');
    assert.deepStrictEqual(decodeIntro(returned(reply(run, '(:intro 8 "vlen_rhs")')).payload), { kind: 'ok', value: ['0', 'S ?vlen_rhs_0'] });
    assert.strictEqual(okText(reply(run, '(:refine 8 "vlen_rhs" "S")')), 'S ?vlen_rhs_0');
    const ambiguous = (await live('ambig-refine')).exchanges[1];
    assert.deepStrictEqual(decodeAmbiguity(errorMessage(ambiguous)), ['Ambig.A.foo ?g_rhs_0', 'Ambig.B.foo ?g_rhs_0']);
  });

  test('F30: :generate-def(-next) answer one multi-line string; :proof-search(-next) a string with highlighting', async () => {
    const run = await live('clean-editing');
    assert.strictEqual(okText(reply(run, '(:generate-def 5 "append")')), 'append [] ys = ys\nappend (x :: xs) ys = x :: append xs ys');
    const [next1, next2] = run.exchanges.filter((e) => e.request.startsWith('(:generate-def-next '));
    assert.strictEqual(okText(next1).split('\n').length, 3);
    assert.strictEqual(okText(next2).split('\n').length, 3);
    assert.notStrictEqual(okText(next1), okText(next2));
    const search = decodeText(returned(reply(run, '(:proof-search 8 "vlen_rhs" ())')).payload);
    assert.ok(search.kind === 'ok');
    assert.strictEqual(search.value.text, '0');
    assert.deepStrictEqual(
      search.value.highlighting.map((h) => [h.start, h.length]),
      [[0, 1]],
    );
    const nexts = run.exchanges.filter((e) => e.request.startsWith('(:proof-search-next ')).map(okText);
    assert.deepStrictEqual(nexts, ['1', '2']);
    const typed = decodeText(returned(reply(await live('clean-lookups'), '(:type-of "xs" 8 5)')).payload);
    assert.ok(typed.kind === 'ok');
    assert.deepStrictEqual(typed.value.highlighting.map((h) => [h.start, h.length]), [[5, 4]]);
  });

  test('F31: mode flags and the load line are parsed and ignored', async () => {
    const editing = await live('clean-editing');
    assert.deepStrictEqual(withoutIds(reply(editing, '(:proof-search 8 "vlen_rhs" () :all)')), withoutIds(reply(editing, '(:proof-search 8 "vlen_rhs" ())')));
    const lookups = await live('clean-lookups');
    const plain = withoutIds(reply(lookups, '(:docs-for "id")'));
    assert.deepStrictEqual(withoutIds(reply(lookups, '(:docs-for "id" :full)')), plain);
    assert.deepStrictEqual(withoutIds(reply(lookups, '(:docs-for "id" :overview)')), plain);
    const withLine = reply(lookups, 'Clean.idr" 3)');
    assert.strictEqual(returned(withLine).payload.kind, 'ok');
    assert.deepStrictEqual(writeStrings(withLine), []); // the reload of a fresh file (F7), line or not
  });

  // F32 ------------------------------------------------------------------------------------

  test('F32: a shadow check imports from the isolated build directory, not from build/ttc', () => {
    const { dir, root } = copyWorkspace('simple-ipkg');
    const run = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const r = spawnSync(idris2, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
      assert.ifError(r.error);
      return r;
    };
    try {
      const typecheck = run(root, ['--build-dir', 'build/.vscode-idris2', '--typecheck', 'simple.ipkg']);
      assert.strictEqual(typecheck.status, 0, typecheck.stdout + typecheck.stderr);
      const built = filesBelow(path.join(root, 'build'));
      assert.ok(built.length > 0 && built.every((f) => /^\.vscode-idris2\/ttc\/\d+\/Foo\/[AB]\.tt[cm]$/.test(f)), built.join(', '));
      assert.ok(!fs.existsSync(path.join(root, 'build', 'ttc')));

      const shadow = path.join(dir, 'shadow');
      fs.mkdirSync(path.join(shadow, 'Foo'), { recursive: true });
      fs.copyFileSync(path.join(root, 'src', 'Foo', 'B.idr'), path.join(shadow, 'Foo', 'B.idr'));
      const check = (ttc: string) =>
        run(shadow, ['--build-dir', path.join(shadow, 'build'), '--check', 'Foo/B.idr'], { IDRIS2_PATH: ttc });
      const fromBuildTtc = check(path.join(root, 'build', 'ttc'));
      assert.strictEqual(fromBuildTtc.status, 0); // F9: a failed --check exits 0
      assert.match(fromBuildTtc.stdout, /^Error: Module Foo\.A not found\n/);
      const fromIsolated = check(path.join(root, 'build', '.vscode-idris2', 'ttc'));
      assert.strictEqual(fromIsolated.status, 0);
      assert.strictEqual(fromIsolated.stdout, '1/1: Building Foo.B (Foo/B.idr)\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // F33 ------------------------------------------------------------------------------------

  test('F33: :highlight-source carries no types or docs', async () => {
    let names = 0;
    for (const scenario of ['clean-lookups', 'load-warn', 'load-simple-ipkg', 'load-lit']) {
      for (const exchange of (await live(scenario)).exchanges) {
        for (const m of highlightFrames(exchange)) {
          assert.ok(m.kind === 'output' && m.payload.kind === 'highlight-source');
          for (const h of decodeSourceHighlights(m.payload.highlights)) {
            if (h.name !== undefined) {
              names += 1;
              assert.strictEqual(h.docOverview, '', `${scenario}: ${json(h)}`);
              assert.strictEqual(h.type, '', `${scenario}: ${json(h)}`);
            }
          }
        }
      }
    }
    assert.ok(names > 10, `only ${names} names highlighted`);
  });

  // M3: E14 ---------------------------------------------------------------------------------

  test('E14: :type-of columns count code points — not UTF-8 bytes, UTF-16 units or graphemes', async () => {
    const run = await live('unicode-columns');
    const at = (name: string, line: number, column: number): string => {
      const { payload } = returned(reply(run, `(:type-of "${name}" ${line} ${column})`));
      return payload.kind === 'error' ? 'error' : okText(reply(run, `(:type-of "${name}" ${line} ${column})`));
    };
    // A column answers for a name from its start to its end inclusive (F2), so only a count that
    // puts the start past the name's end tells the counts apart.
    // Line 15, `astral s = ("𝕟𝕟", s)`: the last s starts at code point 18, UTF-16 unit 20, byte 24.
    assert.deepStrictEqual([at('s', 15, 18), at('s', 15, 19), at('s', 15, 20), at('s', 15, 24)], ['s : String', 's : String', 'error', 'error']);
    // Line 18, `combining t = ("é", t)` with e + U+0301: t starts at code point 21 and grapheme 20
    // (its byte column, 22, falls on t's inclusive end and tells nothing).
    assert.deepStrictEqual([at('t', 18, 21), at('t', 18, 20)], ['t : String', 'error']);
    // Line 21, `commented {- 𝕟 α -} m = m`: the m start at code points 20 and 24; the second at byte 28.
    assert.deepStrictEqual([at('m', 21, 20), at('m', 21, 24), at('m', 21, 28)], ['m : Nat', 'm : Nat', 'error']);
    // Line 12, `α x₁ y = x₁ + y`: a positional :type-of answers for the local at the column, whatever NAME asks (F2).
    assert.strictEqual(at('y', 12, 2), 'x₁ : ℕ');
  });

  test('E14: :highlight-source columns count code points too', async () => {
    const run = await live('unicode-columns');
    const spans = highlightFrames(run.exchanges[0]).flatMap((m) =>
      m.kind === 'output' && m.payload.kind === 'highlight-source' ? decodeSourceHighlights(m.payload.highlights) : [],
    );
    const span = (name: string, line: number): number[][] =>
      spans.filter((h) => h.name === name && h.span.start.line === line).map((h) => [h.span.start.column, h.span.end.column]);
    assert.deepStrictEqual(span('s', 14), [[7, 8], [18, 19]]);
    assert.deepStrictEqual(span('x₁', 11), [[2, 4], [9, 11]]);
    assert.deepStrictEqual(span('m', 20), [[20, 21], [24, 25]]);
  });

  // M3: evaluation (ROADMAP §9, 2026-09-28) -----------------------------------------------------

  test('an IO action given to :interpret is normalised, not run: MkIO (prim__putStr "hi\\n"), nothing printed (stdio)', async () => {
    const run = await live('eval-values');
    const io = reply(run, '(:interpret "the (IO ()) (putStrLn \\"hi\\")")');
    assert.strictEqual(okText(io), 'MkIO (prim__putStr "hi\\n")');
    assert.ok(io.items.every((i) => i.kind === 'framed'), json(io.items)); // no program output (F5)
    assert.match(errorMessage(reply(run, '(:interpret "putStrLn \\"hi\\"")')), /^Error: Can't find an implementation for HasIO \?io\./);
    assert.strictEqual(okText(reply(run, '(:interpret "the (Vect 2 Nat) [1, 2]")')), '[1, 2]');
  });

  test('an IO action given to :interpret prints nothing on the socket transport\'s process stdout either', async () => {
    const run = await live('eval-socket');
    const [, io] = run.exchanges;
    assert.strictEqual(okText(io), 'MkIO (prim__putStr "hi\\n")');
    assert.strictEqual(io.stdout, '');
  });

  test(':interpret runs REPL commands: which spellings of `:t id` the REPL parser reads as a command', async () => {
    const run = await live('eval-command-forms');
    const outcome = (e: LiveExchange): string => {
      const { payload } = returned(e);
      if (payload.kind === 'error') {
        return 'not a command';
      }
      const text = okText(e);
      return text === 'Prelude.id : a -> a' ? 'runs' : text === '' ? 'nothing' : `? ${text}`;
    };
    // In the order of the recording (scripts/record-transcripts.mjs, eval-command-forms): what
    // `:interpret` was given, and what the compiler did with it.
    const expected: [string, string][] = [
      [' :t id', 'runs'],
      ['\t:t id', 'runs'],
      ['\r:t id', 'runs'],
      ['\n:t id', 'runs'],
      ['\v:t id', 'runs'],
      ['\f:t id', 'runs'],
      ['\u00a0:t id', 'runs'],
      ['\u3000:t id', 'not a command'],
      ['\u200b:t id', 'not a command'],
      ['\ufeff:t id', 'not a command'],
      ['{- c -} :t id', 'runs'],
      ['-- c\n:t id', 'runs'],
      ['||| d\n:t id', 'not a command'],
      [': t id', 'runs'],
      ['\uff1at id', 'not a command'],
      [':T id', 'not a command'],
      ['', 'nothing'],
      ['   ', 'nothing'],
      ['-- c', 'nothing'],
    ];
    // The request as the extension's encoder writes it (non-ASCII and control characters as decimal escapes, F1).
    const request = (text: string): string => withoutId(ideCodec.encodeRequest(interpret(text), 0n).text.slice(6));
    const interprets = run.exchanges.slice(1);
    assert.deepStrictEqual(
      interprets.map((e) => [withoutId(e.request), outcome(e)]),
      expected.map(([text, result]) => [request(text), result]),
    );
  });

  // The recordings ----------------------------------------------------------------------------

  // M2 risk: big files ---------------------------------------------------------------------

  test('M2 risk (big files): a generated 1,202-line module loads; its ~10,000 :highlight-source frames are cut and decoded', async () => {
    const { dir, root } = copyWorkspace('loose-file');
    try {
      const lines = ['module Big', ''];
      for (let i = 0; i < 400; i++) {
        lines.push(`f${i} : Nat -> List Nat -> List Nat`, `f${i} x xs = map (+ x) (x :: ${i} :: xs)`, '');
      }
      fs.writeFileSync(path.join(root, 'Big.idr'), lines.join('\n'));
      const started = Date.now();
      const run = await runIdeSession({
        executable: idris2,
        cwd: root,
        transport: 'stdio',
        args: sessionArgs(root),
        requests: [`((:load-file "${path.join(root, 'Big.idr').replace(/[\\"]/g, (c) => `\\${c}`)}") 1)\n`],
      });
      const [load] = run.exchanges;
      assert.strictEqual(returned(load).payload.kind, 'ok');
      assert.ok(load.items.every((i) => i.kind === 'framed'), 'nothing unframed');
      const highlights = highlightFrames(load).length; // every frame decodes (messages() asserts it)
      assert.ok(highlights >= 400, `${highlights} :highlight-source frames for 400 definitions`);
      const bytes = load.items.reduce((n, i) => n + i.byteLength, 0);
      // A measurement, not a bound: the number is recorded in docs/as-built/M2.md, *Measured*.
      console.log(`      big file: ${lines.length} lines, ${highlights} :highlight-source frames, ${bytes} bytes, ${Date.now() - started} ms (start, load, exit)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`every transcript of ${RECORDED_VERSION} is what this compiler sends now (frames, program output, files written)`, async function () {
    if (version !== RECORDED_VERSION) {
      // A newer compiler needs its own recordings (npm run record:transcripts); the facts above
      // still run against it.
      this.skip();
    }
    this.timeout(600000);
    const isGenerated = (f: string): boolean => f.split('/').some((segment) => segment === 'build' || segment === 'out');
    for (const transcript of readTranscripts(transcriptsDir(RECORDED_VERSION))) {
      const name = transcript.meta.scenario;
      const socket = transcript.meta.transport === 'socket';
      const { run, root, dir } = await runScenario(idris2, name, { keep: true });
      try {
        const values: Record<string, string> = { '${ROOT}': root, '${LINK}': path.join(dir, 'link') };
        const recorded = exchanges(transcript);
        assert.strictEqual(run.exchanges.length, recorded.exchanges.length, name);
        let recordedOutput = '';
        recorded.exchanges.forEach((expected, i) => {
          // The protocol stream: the frames, and over stdio the program output between them (F5).
          const stream = expected.replies.filter((r) => r.kind === 'frame' || !socket);
          assert.deepStrictEqual(
            run.exchanges[i].items.map((item) => item.text),
            stream.map((r) => (r.kind === 'frame' ? substitute(r.text, values) : r.text)),
            `${name}: reply to ${expected.request}`,
          );
          recordedOutput += expected.replies.filter((r) => r.kind === 'output' && socket).map((r) => r.text).join('');
        });
        // What is left: program output on the process stdout (socket), and the end of input.
        const output = run.exchanges.map((e) => e.stdout).join('') + run.tailStdout + run.tailStream;
        assert.strictEqual(output, recordedOutput + recorded.tailOutput, `${name}: program output and end of input`);
        assert.strictEqual(run.exitCode, recorded.exitCode, name);
        const sources = new Set(filesBelow(path.join(repoRoot(), transcript.meta.cwd)).filter((f) => !isGenerated(f)));
        const written = filesBelow(root).filter((f) => !sources.has(f));
        const filesEvent = transcript.events.find((e) => e.kind === 'files');
        assert.deepStrictEqual(written, filesEvent?.kind === 'files' ? [...filesEvent.written] : [], `${name}: files written`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
