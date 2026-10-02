// backend/ide/holes.ts on the replies recorded from idris2 0.8.0: which metavariables are holes, the
// entry of `:name-at` that locates each (E16: holes of one name in two modules), the multiplicity
// prefixes of the premises, and the cap on the names located.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { holeName, holesOf, isHoleSpan, MAX_LOCATED_NAMES, namesToLocate } from '../../src/backend/ide/holes';
import { holeTokenNames } from '../../src/core/idrisSyntax';
import { decodeMetavariables, decodeNameAt, type Metavariable, type NameLocation } from '../../src/backend/ide/protocol';
import type { ReplyPayload } from '../../src/backend/ide/types';
import { recordedExchanges } from './support/loadReplies';

const ROOT = '/fx';

function ok<T>(r: { kind: 'ok'; value: T } | { kind: 'error' }): T {
  assert.strictEqual(r.kind, 'ok');
  return (r as { value: T }).value;
}

/** The answers of `scenario`'s requests, by the request's text without its id. */
function answers(scenario: string): Map<string, ReplyPayload[]> {
  const out = new Map<string, ReplyPayload[]>();
  for (const x of recordedExchanges(scenario, ROOT)) {
    const request = /^\((.*) \d+\)\n$/s.exec(x.request)?.[1] ?? x.request;
    out.set(request, [...(out.get(request) ?? []), x.reply.payload]);
  }
  return out;
}

/**
 * The holes of `scenario`'s `nth` `:metavariables` answer, with the `:name-at` answers it recorded
 * after it (the names `namesToLocate` asks for), located by a fake that names the file and span.
 */
function holes(scenario: string, nth = 0): { holes: ReturnType<typeof holesOf>; asked: string[] } {
  const all = answers(scenario);
  const metavariables: Metavariable[] = ok(decodeMetavariables((all.get('(:metavariables 80)') ?? [])[nth]));
  const asked = namesToLocate(metavariables, new Set());
  const entries = new Map<string, readonly NameLocation[] | undefined>();
  for (const name of asked) {
    const payload = (all.get(`(:name-at ${JSON.stringify(name).replace(/[^\x20-\x7e]/gu, (c) => `\\${c.codePointAt(0)}`)})`) ?? [])[nth];
    if (payload !== undefined) {
      entries.set(name, ok(decodeNameAt(payload)));
    }
  }
  const locate = (entry: NameLocation): vscode.Location =>
    ({ uri: entry.file, range: [entry.span.start.line, entry.span.start.column, entry.span.end.line, entry.span.end.column] }) as unknown as vscode.Location;
  return { holes: holesOf(metavariables, entries, new Set(), locate), asked };
}

suite('backend/ide/holes: :metavariables and :name-at of the 0.8.0 recordings', () => {
  test('E16: after Holes.Main, the holes of the modules it imports too; same-named holes told apart by qualified name and file', () => {
    const { holes: main } = holes('holes-ipkg-main');
    assert.deepStrictEqual(main.map((h) => [h.name, h.qualifiedName, h.location]), [
      ['secret_rhs', 'Holes.Base.secret_rhs', { uri: `${ROOT}/src/Holes/Base.idr`, range: [9, 9, 9, 20] }],
      ['size_rhs', 'Holes.Main.size_rhs', { uri: `${ROOT}/src/Holes/Main.idr`, range: [10, 14, 10, 23] }],
      ['todo', 'Holes.Base.todo', { uri: `${ROOT}/src/Holes/Base.idr`, range: [6, 10, 6, 15] }],
      ['todo', 'Holes.Main.todo', { uri: `${ROOT}/src/Holes/Main.idr`, range: [7, 11, 7, 16] }],
      ['util_rhs', 'Holes.Util.util_rhs', { uri: `${ROOT}/src/Holes/Util.idr`, range: [6, 21, 6, 30] }],
    ]);
    // After Holes.Other (which imports none of them), only its own.
    assert.deepStrictEqual(holes('holes-ipkg-main', 1).holes.map((h) => h.qualifiedName), ['Holes.Other.todo']);
    assert.deepStrictEqual(holes('holes-ipkg-util').holes.map((h) => h.qualifiedName), ['Holes.Base.secret_rhs', 'Holes.Base.todo', 'Holes.Util.util_rhs']);
  });

  test('premises: the multiplicity prefix 0, 1 or none (unrestricted); the goal; implicit is not reported', () => {
    const [todo] = holes('holes-loose-base').holes;
    assert.deepStrictEqual(todo, {
      name: 'todo',
      qualifiedName: 'Base.todo',
      type: { text: 'Vect (S n) a', spans: [] },
      premises: [
        { name: 'n', type: { text: 'Nat', spans: [] }, multiplicity: 0 },
        { name: 'a', type: { text: 'Type', spans: [] }, multiplicity: 0 },
        { name: 'x', type: { text: 'a', spans: [] }, multiplicity: 1 },
        { name: 'xs', type: { text: 'Vect n a', spans: [] }, multiplicity: 'unrestricted' },
      ],
      location: { uri: `${ROOT}/Base.idr`, range: [7, 15, 7, 20] },
    });
  });

  test('declarations without clauses and failed definitions are listed by the compiler but are not holes', () => {
    const { holes: edits, asked } = holes('edits-names');
    const names = edits.map((h) => h.name);
    for (const declaration of ['zip3', 'swap', '(<||>)']) {
      assert.ok(!names.includes(declaration), declaration);
    }
    assert.ok(!asked.includes('(<||>)'));
    assert.deepStrictEqual(names.filter((n) => ['ε', "h'", 'count_rhs'].includes(n)).sort(), ["count_rhs", "h'", 'ε']);
    assert.deepStrictEqual(holes('hole-errors').holes.map((h) => h.name), ['after_rhs', 'before_rhs']);
    assert.deepStrictEqual(holes('lit2-editing').holes.map((h) => h.name), ['half_rhs', 'vlen_rhs']);
    assert.deepStrictEqual(holes('plain-split-columns').holes, []);
  });

  test('a reported name with an invisible character is a hole the compiler registered: kept and located; an operator is not a hole', () => {
    // `f = ?a<U+202E>b`, `g = ?x<U+200B>y`: :metavariables answered `Zw.a\8238b`, `Zw.x\8203y` and
    // :name-at "a\8238b" a hole's span [live, security review of M4].
    const listed: Metavariable[] = ['Zw.a\u202Eb', 'Zw.plain', 'Zw.x\u200By', 'Zw.<||>'].map((name) => ({ name, type: 'Nat', premises: [] }));
    assert.deepStrictEqual(namesToLocate(listed, new Set()), ['a\u202Eb', 'plain', 'x\u200By']);
    const entries = new Map<string, readonly NameLocation[] | undefined>([
      ['a\u202Eb', [{ name: 'Zw.a\u202Eb', file: '/w/Zw.idr', span: { start: { line: 2, column: 4 }, end: { line: 2, column: 8 } } }]],
      ['plain', []],
      ['x\u200By', undefined],
    ]);
    const located = holesOf(listed, entries, new Set(), () => ({ uri: { fsPath: '/w/Zw.idr' } }) as vscode.Location);
    assert.deepStrictEqual(located.map((h) => [h.name, h.location !== undefined]), [['a\u202Eb', true], ['plain', false], ['x\u200By', false]]);
  });

  test('a hole whose entry is missing keeps no location; one whose file cannot be located neither', () => {
    const metavariables = ok(decodeMetavariables((answers('holes-loose-main').get('(:metavariables 80)') ?? [])[0]));
    // Both names asked, each answered with an error.
    const failed = new Map<string, readonly NameLocation[] | undefined>([
      ['size_rhs', undefined],
      ['todo', undefined],
    ]);
    const none = holesOf(metavariables, failed, new Set(), () => assert.fail('nothing to locate'));
    assert.deepStrictEqual(none.map((h) => [h.qualifiedName, h.location]), [['Main.size_rhs', undefined], ['Base.todo', undefined], ['Main.todo', undefined]]);
    const entries = new Map([...failed, ['todo', ok(decodeNameAt((answers('holes-loose-main').get('(:name-at "todo")') ?? [])[0]))]]);
    assert.deepStrictEqual(holesOf(metavariables, entries, new Set(), () => undefined).map((h) => h.location), [undefined, undefined, undefined]);
  });

  test(`past ${MAX_LOCATED_NAMES} names, a name not asked about is kept only as a ?name of the loaded file: a declaration without clauses is not a hole (acceptance review of M4)`, () => {
    const listed: Metavariable[] = [
      ...Array.from({ length: MAX_LOCATED_NAMES }, (_, i) => ({ name: `Big.h${String(i).padStart(4, '0')}`, type: 'Nat', premises: [] })),
      { name: 'Big.zzz_decl', type: 'Nat -> Nat', premises: [] },
      { name: 'Big.zzz_rhs', type: 'Nat', premises: [] },
    ];
    const inLoaded = holeTokenNames('zzz_decl : Nat -> Nat\nf : Nat\nf = ?zzz_rhs\n');
    const asked = namesToLocate(listed, new Set());
    assert.ok(!asked.includes('zzz_decl') && !asked.includes('zzz_rhs'));
    const entries = new Map<string, readonly NameLocation[] | undefined>(asked.map((name) => [name, undefined]));
    const kept = holesOf(listed, entries, inLoaded, () => undefined).map((h) => h.qualifiedName);
    assert.strictEqual(kept.length, MAX_LOCATED_NAMES + 1);
    assert.ok(kept.includes('Big.zzz_rhs') && !kept.includes('Big.zzz_decl'));
  });

  test('the span of a hole is its ?name token (code points); a declaration\'s is longer', () => {
    assert.ok(isHoleSpan({ start: { line: 87, column: 7 }, end: { line: 87, column: 9 } }, 'ε'));
    assert.ok(!isHoleSpan({ start: { line: 7, column: 0 }, end: { line: 9, column: 23 } }, 'zip3'));
    assert.ok(!isHoleSpan({ start: { line: 74, column: 0 }, end: { line: 74, column: 23 } }, 'swap'));
    assert.strictEqual(holeName('Holes.Main.todo'), 'todo');
    assert.strictEqual(holeName('Edits.ε'), 'ε');
  });

  test(`at most ${MAX_LOCATED_NAMES} names are located, each once, in the answer's order`, () => {
    const many: Metavariable[] = Array.from({ length: MAX_LOCATED_NAMES + 50 }, (_, i) => ({ name: `M.h${i % (MAX_LOCATED_NAMES + 10)}`, type: 'Nat', premises: [] }));
    const names = namesToLocate(many, new Set());
    assert.strictEqual(names.length, MAX_LOCATED_NAMES);
    assert.deepStrictEqual(names.slice(0, 3), ['h0', 'h1', 'h2']);
    assert.strictEqual(new Set(names).size, names.length);
  });

  test('the loaded file\'s names first: an import\'s names that sort before them do not crowd them out (UX review of M4)', () => {
    const imported: Metavariable[] = Array.from({ length: MAX_LOCATED_NAMES }, (_, i) => ({ name: `Base.a${String(i).padStart(4, '0')}`, type: 'Nat', premises: [] }));
    const listed = [...imported, { name: 'Main.zzz_rhs', type: 'Nat', premises: [] }];
    const names = namesToLocate(listed, holeTokenNames('module Main\n\nmain : Nat\nmain = ?zzz_rhs\n'));
    assert.strictEqual(names.length, MAX_LOCATED_NAMES);
    assert.deepStrictEqual(names.slice(0, 2), ['zzz_rhs', 'a0000']);
    assert.ok(!namesToLocate(listed, new Set()).includes('zzz_rhs'));
  });

  test('holeTokenNames: the name after each ? of the text, in one pass; linear in the text and the number of names', () => {
    assert.deepStrictEqual([...holeTokenNames("f x = ?a_rhs + (?b' x) -- ?c\ng = ?ε ? no ?1\n")], ['a_rhs', "b'", 'c', 'ε']);
    const text = Array.from({ length: 20_000 }, (_, i) => `h${i} = ?h${i}_rhs\n`).join('');
    const listed: Metavariable[] = Array.from({ length: 20_000 }, (_, i) => ({ name: `Main.h${i}_rhs`, type: 'Nat', premises: [] }));
    const started = process.hrtime.bigint();
    const names = namesToLocate(listed, holeTokenNames(text));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(names.length, MAX_LOCATED_NAMES);
    // 20,000 names in a 400 KB text took 3.3 s with a text scan per name (the security review of M4); one pass takes milliseconds.
    assert.ok(ms < 500, `${ms} ms`);
  });
});
