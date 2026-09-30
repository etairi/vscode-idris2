// backend/ide/highlight.ts: the token index of a load, from the :highlight-source frames recorded
// from idris2 0.8.0 (test/fixtures/transcripts/0.8.0) and the fixture files they describe — every
// named token's range must hold its name in the file's own (UTF-16, bird-track) columns — plus the
// rules the recordings do not exercise (other files, unknown decorations) and the cost of a large
// file (ROADMAP M3: 200 ms for 2,000 lines).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { tokenIndexOf, type LoadedSource } from '../../src/backend/ide/highlight';
import { ideCodec } from '../../src/backend/ide/protocol';
import type { IdeMessage, Reply } from '../../src/backend/ide/types';
import type { PositionDocument } from '../../src/core/positions';
import type { Token } from '../../src/backend/types';
import { repoRoot } from '../fake-tools/paths';
import { recordedExchanges, transcriptCwd } from './support/loadReplies';

const ROOT = '/r';

/** A document of `text` named `fileName`, as `backend.ts` builds one from the file on disk. */
function textDocument(fileName: string, text: string): PositionDocument {
  const lines = text.split('\n');
  return { fileName, languageId: '', isUntitled: false, lineCount: lines.length, lineAt: (line) => ({ text: lines[line] ?? '' }) };
}

/** The reply of request `index` of `scenario` and the fixture text of `file` (relative to the transcript's directory). */
function recorded(scenario: string, index: number, file: string): { reply: Reply; source: LoadedSource; text: string } {
  const reply = recordedExchanges(scenario, ROOT)[index].reply;
  const text = fs.readFileSync(path.join(repoRoot(), transcriptCwd(scenario), file), 'utf8');
  const fileName = `/w/${file}`;
  return {
    reply,
    text,
    source: {
      file: fileName,
      isLoadedFile: (name) => name === `${ROOT}/${file}`,
      document: textDocument(fileName, text),
      text,
      ok: reply.payload.kind === 'ok',
    },
  };
}

/** The text of `range` in `text`. */
function slice(text: string, token: Token): string {
  const lines = text.split('\n');
  const { start, end } = token.range;
  return start.line === end.line ? lines[start.line].slice(start.character, end.character) : `${lines[start.line].slice(start.character)}…`;
}

const frames = (messages: readonly IdeMessage[]): number =>
  messages.filter((m) => m.kind === 'output' && m.payload.kind === 'highlight-source').length;

suite('backend/ide/highlight (the token index of a load)', () => {
  test('shapes-lookups: the decorations of the acceptance (Circle data, area function) at their spans; sorted; the file and text given', () => {
    const { reply, source } = recorded('shapes-lookups', 0, 'src/Foo/Shapes.idr');
    const index = tokenIndexOf(reply.messages, source);
    assert.ok(index !== undefined);
    assert.strictEqual(index.file, '/w/src/Foo/Shapes.idr');
    assert.strictEqual(index.text, recorded('shapes-lookups', 0, 'src/Foo/Shapes.idr').text);
    const named = (name: string) => index.tokens.filter((t) => t.name === name);
    assert.deepStrictEqual(named('Circle').map((t) => [t.range.start.line, t.range.start.character, t.range.end.character, t.decor]), [
      [6, 2, 8, 'data'],
      [12, 6, 12, 'data'],
      [23, 13, 19, 'data'],
      [28, 9, 15, 'data'],
      [28, 39, 45, 'data'],
    ]);
    assert.ok(named('area').every((t) => t.decor === 'function') && named('area').length > 0);
    const keys = index.tokens.map((t) => [t.range.start.line, t.range.start.character, t.range.end.line, t.range.end.character]);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
    assert.deepStrictEqual(keys, sorted);
    // No field of F33's empty ones is kept; keywords and comments carry no name.
    assert.ok(index.tokens.every((t) => Object.keys(t).every((k) => ['range', 'decor', 'name', 'namespace', 'implicit'].includes(k))));
    assert.ok(index.tokens.filter((t) => t.decor === 'keyword' || t.decor === 'comment').every((t) => t.name === undefined));
  });

  test('shapes-lookups: entries sent twice are one token; the method\'s declaration keeps its namespace', () => {
    const { reply, source } = recorded('shapes-lookups', 0, 'src/Foo/Shapes.idr');
    const index = tokenIndexOf(reply.messages, source);
    assert.ok(index !== undefined);
    assert.strictEqual(frames(reply.messages), 183);
    assert.strictEqual(index.tokens.length, 180);
    const at = (line: number, character: number) => index.tokens.filter((t) => t.range.start.line === line && t.range.start.character === character);
    assert.deepStrictEqual(at(19, 2), [{ range: { start: { line: 19, character: 2 }, end: { line: 19, character: 11 } }, decor: 'function', name: 'perimeter', namespace: 'Foo.Shapes', implicit: false }]);
    assert.strictEqual(at(19, 14).length, 1);
    assert.strictEqual(at(22, 9).length, 1);
    const keys = index.tokens.map((t) => JSON.stringify([t.range, t.decor, t.name, t.implicit]));
    assert.strictEqual(new Set(keys).size, keys.length);
  });

  test('every named token of the recorded loads holds its name in the file\'s own columns (bird tracks, code points, E14)', () => {
    const loads: [string, number, string][] = [
      ['shapes-lookups', 0, 'src/Foo/Shapes.idr'],
      ['simple-ipkg-lookups', 0, 'src/Foo/B.idr'],
      ['simple-ipkg-lookups', 11, 'src/Foo/A.idr'],
      ['clean-queries', 0, 'Clean.idr'],
      ['unicode-columns', 0, 'Unicode.idr'],
      ['lit-lookups', 0, 'Lit.lidr'],
      ['load-lit', 0, 'Lit.lidr'],
      ['load-loose', 0, 'Hello.idr'],
    ];
    let checked = 0;
    for (const [scenario, index, file] of loads) {
      const { reply, source, text } = recorded(scenario, index, file);
      const tokens = tokenIndexOf(reply.messages, source)?.tokens ?? assert.fail(scenario);
      assert.ok(tokens.length > 0, scenario);
      for (const token of tokens.filter((t) => t.name !== undefined)) {
        const shown = slice(text, token);
        // An operator's token spans its parentheses (`(|+|)`); syntactic sugar is named after what it
        // stands for: a tuple's comma MkPair or Pair (in Builtin), a list literal's `[` and `,` the
        // constructor `::`, its `]` `Nil` [live].
        const sugar: Record<string, string[]> = { MkPair: [','], Pair: [','], '::': ['[', ','], Nil: [']'] };
        const expected = [token.name, `(${token.name})`, ...(sugar[token.name ?? ''] ?? [])];
        assert.ok(expected.includes(shown), `${scenario}: ${JSON.stringify(token)} holds ${JSON.stringify(shown)}`);
        checked++;
      }
    }
    assert.ok(checked > 150, `${checked}`);
  });

  test('E14: after two characters outside the BMP a token is two UTF-16 units further right than the compiler\'s column', () => {
    const { reply, source } = recorded('unicode-columns', 0, 'Unicode.idr');
    const index = tokenIndexOf(reply.messages, source);
    // `astral s = ("𝕟𝕟", s)`: the compiler says (14 18)–(14 19) for the second `s`.
    const s = index?.tokens.filter((t) => t.name === 's').map((t) => [t.range.start.line, t.range.start.character, t.range.end.character]);
    assert.deepStrictEqual(s, [[14, 7, 8], [14, 20, 21]]);
  });

  test('literate/Lit.lidr: the module keyword starts at file column 2 (F11, the acceptance)', () => {
    const { reply, source } = recorded('lit-lookups', 0, 'Lit.lidr');
    const first = tokenIndexOf(reply.messages, source)?.tokens[0];
    assert.deepStrictEqual(first, { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 8 } }, decor: 'keyword' });
  });

  test('a failed load sends no highlighting: no index (the previous one stays); a successful one without any gives an empty index', () => {
    const bad = recorded('load-bad', 0, 'Bad.idr');
    assert.strictEqual(frames(bad.reply.messages), 0);
    assert.strictEqual(tokenIndexOf(bad.reply.messages, bad.source), undefined);
    // F14: after (:enable-syntax :False) a load sends none.
    const quiet = recorded('enable-syntax', 1, 'Clean.idr');
    assert.strictEqual(frames(quiet.reply.messages), 0);
    assert.deepStrictEqual(tokenIndexOf(quiet.reply.messages, quiet.source), { file: '/w/Clean.idr', text: quiet.text, tokens: [] });
  });

  test('frames naming another file are ignored; a decoration this version does not know is left out, a frame of another shape skipped', () => {
    const frame = (file: string, decor: string, name?: string): IdeMessage => {
      const properties = name === undefined ? `((:decor :${decor}))` : `((:name "${name}") (:namespace "") (:decor :${decor}) (:implicit :False) (:key "") (:doc-overview "") (:type ""))`;
      const decoded = ideCodec.decodeMessage(`(:output (:ok (:highlight-source ((((:filename "${file}") (:start 0 0) (:end 0 1)) ${properties})))) 1)`);
      assert.ok(decoded.kind === 'message');
      return decoded.message;
    };
    const malformed = ideCodec.decodeMessage('(:output (:ok (:highlight-source (((:filename "/r/A.idr") :oops)))) 1)');
    assert.ok(malformed.kind === 'message');
    const source: LoadedSource = { file: '/w/A.idr', isLoadedFile: (n) => n === '/r/A.idr', document: textDocument('/w/A.idr', 'x'), text: 'x', ok: true };
    const index = tokenIndexOf([frame('/r/B.idr', 'function', 'f'), frame('/r/A.idr', 'sparkle', 'g'), malformed.message, frame('/r/A.idr', 'bound', 'x')], source);
    assert.deepStrictEqual(index, {
      file: '/w/A.idr',
      text: 'x',
      tokens: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, decor: 'bound', name: 'x', namespace: '', implicit: false }],
    });
    // A failed load with frames of another file only: nothing for this one.
    assert.strictEqual(tokenIndexOf([frame('/r/B.idr', 'function', 'f')], { ...source, ok: false }), undefined);
  });

  test('cost: the index of 2,000 lines with 12 tokens each (24,000 frames) is built and reported; the decoding, done as the frames arrive during the load, is reported too', () => {
    const line = 'f : (xs : List Nat) -> Nat -- 𝕟 ok';
    const text = Array(2000).fill(line).join('\n');
    const texts: string[] = [];
    for (let l = 0; l < 2000; l++) {
      for (let t = 0; t < 12; t++) {
        const c = t * 2;
        texts.push(`(:output (:ok (:highlight-source ((((:filename "/r/Big.idr") (:start ${l} ${c}) (:end ${l} ${c + 1})) ((:name "n${t}") (:namespace "") (:decor :bound) (:implicit :False) (:key "") (:doc-overview "") (:type "")))))) 1)`);
      }
    }
    const started = process.hrtime.bigint();
    const messages = texts.map((t) => {
      const decoded = ideCodec.decodeMessage(t);
      assert.ok(decoded.kind === 'message');
      return decoded.message;
    });
    const decodedAt = process.hrtime.bigint();
    const index = tokenIndexOf(messages, { file: '/w/Big.idr', isLoadedFile: (n) => n === '/r/Big.idr', document: textDocument('/w/Big.idr', text), text, ok: true });
    const indexedAt = process.hrtime.bigint();
    assert.strictEqual(index?.tokens.length, 24_000);
    const decodeMs = Number(decodedAt - started) / 1e6;
    const indexMs = Number(indexedAt - decodedAt) / 1e6;
    // Reported, so that a run on another machine shows its numbers (the budget is a target to measure, ROADMAP M3).
    console.log(`      [highlight cost] decode ${decodeMs.toFixed(1)} ms, index ${indexMs.toFixed(1)} ms for 24,000 frames`);
    // A guard against a regression in kind (a quadratic step), not the 200 ms budget: a wall-clock
    // bound that tight failed this unit test under load, 102–150 ms at a 1-minute load of about 6
    // (fifth review of M3). The index is built during the load, so the e2e suite's 200 ms
    // (test/e2e/intelligence.test.ts), timed after it, bounds the provider's answer only.
    assert.ok(indexMs < 1000, `the index took ${indexMs} ms`);
  });
});
