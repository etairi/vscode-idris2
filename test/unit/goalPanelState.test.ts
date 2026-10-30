// features/goalPanel/state.ts: what the panel shows at a place of a document, on the text of the
// `broken` fixtures with the lexer the commands use and a model answering by hand: which hole is
// shown (at the cursor, on the line, pinned, among several of one name), its premises and what can be
// done with them, the declaration, the lists and their limits, the text made visible.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { Hole } from '../../src/backend/types';
import { buildPanel, goalMarkdown, MAX_HOLE_ROWS, MAX_MESSAGE_ROWS, type PanelDiagnostic, type PanelDocument, type PanelInput } from '../../src/features/goalPanel/state';
import { repoRoot } from '../fake-tools/paths';
import { FakeTextDoc } from './support/editingFakes';

const FILE = '/w/broken/Clean.idr';
const fixture = (name: string): string => fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'broken', name), 'utf8');
const docOf = (text: string, fileName = FILE): PanelDocument => new FakeTextDoc({ fileName, text }) as unknown as PanelDocument;
const at = (line: number, character: number) => ({ line, character });

/** `?name`, located where the text has it when `line` is given. */
function hole(name: string, options: { line?: number; character?: number; qualified?: string; file?: string; premises?: Hole['premises']; type?: string } = {}): Hole {
  const { line, character = 0, file = FILE, qualified = `Clean.${name}`, premises = [], type = 'Nat' } = options;
  return {
    name,
    qualifiedName: qualified,
    type: { text: type, spans: [] },
    premises,
    ...(line === undefined
      ? {}
      : { location: { uri: { fsPath: file }, range: { start: at(line, character), end: at(line, character + name.length + 1) } } as unknown as NonNullable<Hole['location']> }),
  };
}

const VLEN = hole('vlen_rhs', {
  line: 7,
  character: 10,
  premises: [
    { name: 'a', type: { text: 'Type', spans: [] }, multiplicity: 0 },
    { name: 'n', type: { text: 'Nat', spans: [] }, multiplicity: 0 },
    { name: 'xs', type: { text: 'Vect n a', spans: [] } },
  ],
});

function input(doc: PanelDocument | undefined, cursor: { line: number; character: number }, holes: readonly Hole[], more: Partial<PanelInput> = {}): PanelInput {
  const byFile = new Map<string, Hole[]>();
  for (const h of holes) {
    const file = (h.location?.uri as { fsPath?: string } | undefined)?.fsPath ?? FILE;
    byFile.set(file, [...(byFile.get(file) ?? []), h]);
  }
  return {
    ...(doc === undefined ? {} : { place: { doc, cursor } }),
    documentOf: (file) => (file === doc?.fileName ? doc : undefined),
    relativePath: (file) => path.basename(file),
    model: {
      files: () => [...byFile.keys()].sort(),
      holesIn: (file) => byFile.get(file) ?? [],
      rangesText: () => doc?.getText(),
    },
    stale: false,
    diagnostics: [],
    options: { showImplicits: false, showMachineNames: false, fullNamespace: false },
    follow: true,
    hasCycle: () => false,
    caps: { editing: true, editingNext: true, intro: true, refine: true },
    ...more,
  };
}

suite('features/goalPanel: what the panel shows (state.ts)', () => {
  const clean = docOf(fixture('Clean.idr'));

  test('the cursor on ?vlen_rhs: its goal, and the target of the buttons, at the hole\'s token', () => {
    const { state, targets } = buildPanel(input(clean, at(7, 13), [VLEN]));
    assert.deepStrictEqual(state.goal, {
      label: '?vlen_rhs',
      qualifiedName: 'Clean.vlen_rhs',
      premises: [
        { name: 'a', text: '0 a : Type', canSplit: false, canJump: false },
        { name: 'n', text: '0 n : Nat', canSplit: false, canJump: false },
        { name: 'xs', text: 'xs : Vect n a', canSplit: true, canJump: true },
      ],
      type: 'Nat',
    });
    assert.deepStrictEqual(targets.hole, { position: at(7, 10), name: 'vlen_rhs' });
    assert.deepStrictEqual(targets.shown, { file: FILE, qualifiedName: 'Clean.vlen_rhs' });
    assert.deepStrictEqual([...targets.binders.keys()], ['xs']);
    assert.deepStrictEqual(targets.binders.get('xs')?.position, at(7, 5));
    assert.strictEqual(state.file, 'Clean.idr');
    assert.strictEqual(state.pinned, false);
  });

  test('the cursor elsewhere on the only hole\'s line shows it; on another line, nothing', () => {
    assert.strictEqual(buildPanel(input(clean, at(7, 0), [VLEN])).state.goal?.label, '?vlen_rhs');
    const { state } = buildPanel(input(clean, at(0, 0), [VLEN]));
    assert.strictEqual(state.goal, undefined);
    assert.strictEqual(state.unknownHole, undefined);
    const two = docOf('f : Nat\nf = g ?a ?b\n');
    assert.strictEqual(buildPanel(input(two, at(1, 0), [])).state.unknownHole, undefined, 'two holes on the line: none is meant');
  });

  test('a ?name the model does not list has not been checked yet', () => {
    const { state, targets } = buildPanel(input(clean, at(7, 13), []));
    assert.strictEqual(state.goal, undefined);
    assert.strictEqual(state.unknownHole, '?vlen_rhs');
    assert.strictEqual(targets.hole, undefined);
  });

  test('of several holes of one name in a file (one per namespace), the one at the cursor', () => {
    const doc = docOf('namespace A\n  f : Nat\n  f = ?todo\nnamespace B\n  g : Nat\n  g = ?todo\n');
    const a = hole('todo', { line: 2, character: 6, qualified: 'A.todo', type: 'Bool' });
    const b = hole('todo', { line: 5, character: 6, qualified: 'B.todo', type: 'Nat' });
    assert.strictEqual(buildPanel(input(doc, at(2, 7), [a, b])).state.goal?.type, 'Bool');
    assert.strictEqual(buildPanel(input(doc, at(5, 7), [a, b])).state.goal?.type, 'Nat');
  });

  test('premises: the binders around the hole; a clause the compiler does not split can still be jumped from; implicits in braces', () => {
    const doc = docOf('f : Nat -> Nat\nf x = case x of\n  y => ?h\n');
    const h = hole('h', { line: 2, character: 7, premises: [{ name: 'x', type: { text: 'Nat', spans: [] } }, { name: 'y', type: { text: 'Nat', spans: [] } }, { name: 'k', type: { text: 'Nat', spans: [] }, implicit: true }] });
    const { state, targets } = buildPanel(input(doc, at(2, 8), [h]));
    assert.deepStrictEqual(state.goal?.premises.map((p) => [p.text, p.canSplit, p.canJump]), [
      ['x : Nat', false, true],
      ['y : Nat', true, true],
      ['{k : Nat}', false, false],
    ]);
    assert.deepStrictEqual(targets.binders.get('x')?.range, { start: at(1, 2), end: at(1, 3) });
  });

  test('a pin keeps the hole wherever the cursor is, with its binders and target; a hole gone from the model ends it', () => {
    const pinned = { file: FILE, qualifiedName: 'Clean.vlen_rhs' };
    const { state, targets } = buildPanel(input(clean, at(0, 0), [VLEN], { pinned }));
    assert.strictEqual(state.goal?.label, '?vlen_rhs');
    assert.strictEqual(state.pinned, true);
    assert.deepStrictEqual(targets.hole, { position: at(7, 10), name: 'vlen_rhs' });
    assert.strictEqual(targets.binders.size, 1);
    const gone = buildPanel(input(clean, at(0, 0), [], { pinned }));
    assert.strictEqual(gone.state.goal, undefined);
    assert.strictEqual(gone.state.pinned, false);
    assert.strictEqual(gone.targets.pinLost, true);
  });

  test('Next is offered for the file the buttons act on: a pinned hole\'s, else the one followed', () => {
    const other = docOf('module Other\n');
    const cycleIn = (doc: PanelDocument) => (asked: PanelDocument) => asked === doc;
    const pinned = { file: FILE, qualifiedName: 'Clean.vlen_rhs' };
    const pinnedIn = (hasCycle: (doc: PanelDocument) => boolean) =>
      buildPanel(input(other, at(0, 0), [VLEN], { pinned, documentOf: () => clean, model: { files: () => [FILE], holesIn: () => [VLEN], rangesText: () => clean.getText() }, hasCycle })).state.cycle;
    assert.strictEqual(pinnedIn(cycleIn(clean)), true);
    assert.strictEqual(pinnedIn(cycleIn(other)), false);
    assert.strictEqual(buildPanel(input(clean, at(0, 0), [VLEN], { hasCycle: cycleIn(clean) })).state.cycle, true);
    assert.strictEqual(buildPanel(input(undefined, at(0, 0), [], { hasCycle: () => assert.fail('no document') })).state.cycle, false);
  });

  test('a pinned hole of a file that is not open is shown, and its buttons are off', () => {
    const elsewhere = hole('other', { line: 1, file: '/w/Other.idr', qualified: 'Other.other' });
    const { state, targets } = buildPanel(input(clean, at(0, 0), [VLEN, elsewhere], { pinned: { file: '/w/Other.idr', qualifiedName: 'Other.other' } }));
    assert.strictEqual(state.goal?.label, '?other');
    assert.strictEqual(targets.hole, undefined);
    assert.deepStrictEqual(state.caps, { editing: false, editingNext: false, intro: false, refine: false });
  });

  test('a declaration without clauses at the cursor offers Generate Definition; with clauses, or several names, or foreign, it does not', () => {
    const { state, targets } = buildPanel(input(clean, at(4, 2), [VLEN]));
    assert.deepStrictEqual(state.declaration, { label: 'append', canGenerate: true });
    assert.deepStrictEqual(targets.declaration, { position: at(4, 0), name: 'append' });
    assert.strictEqual(buildPanel(input(clean, at(6, 2), [VLEN])).state.declaration, undefined, 'vlen has a clause');
    const several = docOf('a, b : Nat\n');
    assert.deepStrictEqual(buildPanel(input(several, at(0, 0), [])).state.declaration, { label: 'a', canGenerate: false });
  });

  test('the lists: the followed file\'s holes first, the current one marked, with their places; rows refer to the holes', () => {
    const other = hole('first', { line: 0, file: '/w/Aaa.idr', qualified: 'Aaa.first' });
    const { state, targets } = buildPanel(input(clean, at(7, 13), [other, VLEN]));
    assert.deepStrictEqual(state.holes, [
      { label: '?vlen_rhs', type: 'Nat', place: 'Clean.idr:8', current: true },
      { label: '?first', type: 'Nat', place: 'Aaa.idr:1', current: false },
    ]);
    assert.deepStrictEqual(targets.rows.map((r) => [r.file, r.name]), [[FILE, 'vlen_rhs'], ['/w/Aaa.idr', 'first']]);
  });

  test('the lists stop at their limits and say how many are left; messages come by line', () => {
    const many = Array.from({ length: MAX_HOLE_ROWS + 5 }, (_, i) => hole(`h${i}`, { line: i }));
    const { state } = buildPanel(input(clean, at(0, 0), many));
    assert.strictEqual(state.holes.length, MAX_HOLE_ROWS);
    assert.strictEqual(state.moreHoles, 5);
    const diagnostic = (line: number): PanelDiagnostic => ({ severity: 'error', message: `at ${line}`, range: { start: at(line, 0), end: at(line, 1) } });
    const diagnostics = Array.from({ length: MAX_MESSAGE_ROWS + 3 }, (_, i) => diagnostic(MAX_MESSAGE_ROWS + 2 - i));
    const panel = buildPanel(input(clean, at(0, 0), [], { diagnostics }));
    assert.strictEqual(panel.state.messages.length, MAX_MESSAGE_ROWS);
    assert.strictEqual(panel.state.moreMessages, 3);
    assert.deepStrictEqual(panel.state.messages[0], { severity: 'error', line: 1, text: 'at 0' });
    assert.deepStrictEqual(panel.targets.messages[0], { start: at(0, 0), end: at(0, 1) });
  });

  test('compiler text is made visible: invisible characters are written out, and a long type is cut', () => {
    const h = hole('h', { line: 7, character: 10, type: `Na‮t${'x'.repeat(20_000)}`, premises: [{ name: 'a​b', type: { text: 'T', spans: [] } }] });
    const doc = docOf('module M\n\n\n\n\n\n\nf = 1 + ?h\n');
    const { state } = buildPanel(input(doc, at(7, 9), [h], { diagnostics: [{ severity: 'warning', message: 'w‮x', range: { start: at(0, 0), end: at(0, 1) } }] }));
    assert.ok(state.goal?.type.startsWith('Na\\u{202E}t'), state.goal?.type.slice(0, 20));
    assert.ok((state.goal?.type.length ?? 0) <= 10_000);
    assert.strictEqual(state.goal?.premises[0].text, 'a\\u{200B}b : T');
    assert.strictEqual(state.messages[0].text, 'w\\u{202E}x');
  });

  test('without a document: no file, no goal, and the lists of what the model has', () => {
    const { state, targets } = buildPanel(input(undefined, at(0, 0), [VLEN]));
    assert.strictEqual(state.file, undefined);
    assert.strictEqual(state.goal, undefined);
    assert.strictEqual(state.holes.length, 1);
    assert.strictEqual(targets.doc, undefined);
  });

  test('goalMarkdown: the name and the qualified name, then the premises, a rule and the type in a fence no line closes', () => {
    const { state } = buildPanel(input(clean, at(7, 13), [VLEN]));
    const goal = state.goal;
    assert.ok(goal !== undefined);
    assert.strictEqual(goalMarkdown(goal), `**?vlen_rhs** (Clean.vlen_rhs)\n\n\`\`\`idris2\n0 a : Type\n0 n : Nat\nxs : Vect n a\n${'-'.repeat(30)}\nNat\n\`\`\`\n`);
    assert.match(goalMarkdown({ ...goal, type: '```' }), /````idris2/);
  });
});
