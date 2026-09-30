// features/intelligence/{occurrence,hover}.ts and the hover and Type at Cursor of register.ts: the
// name at a position (the compiler's tokens of Foo/Shapes.idr as recorded, else the lexer), the
// tokens kept while the document shows other text, the answers the hover shows and those it drops,
// the doc overview of the right declaration, the cache, and the rendering of compiler text
// (MarkdownString never trusted; compiler text only escaped or in a fence).
import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { Token, TypeInfo } from '../../src/backend/types';
import type { CheckingTrigger } from '../../src/core/config';
import { IdrisException } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { CheckStatus } from '../../src/features/diagnostics/checks';
import { hoverAt, isStale, renderHover, type HoverDeps } from '../../src/features/intelligence/hover';
import { currentTokens, indexTokenOf, occurrenceAt, spells } from '../../src/features/intelligence/occurrence';
import { AnswerCache, createDocumentQueries } from '../../src/features/intelligence/queries';
import { registerIntelligence, TYPE_AT_CURSOR_COMMAND } from '../../src/features/intelligence/register';
import { codeBlock } from '../../src/core/untrustedText';
import type { HoverModel, IntelligenceDeps, LoadedFileEvent } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import {
  asDoc,
  FakeBackend,
  FakeDocument,
  FakeMarkdownString,
  FakePosition,
  fakeApi,
  fixtureDocument,
  indexOf,
  quietLog,
  recordedReply,
  recordedTokens,
  recordedType,
} from './support/intelligence';

const SHAPES = 'test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr';
const at = (line: number, character: number) => ({ line, character });

function shapes() {
  const doc = fixtureDocument(SHAPES);
  const tokens = recordedTokens('shapes-lookups', 'Foo/Shapes.idr', doc);
  return { doc, tokens };
}

/** Deps of `hoverAt` over a fake backend that answers every file. */
function hoverSetup() {
  const { doc, tokens } = shapes();
  const backend = new FakeBackend();
  backend.index = indexOf(doc, tokens);
  const loads = new Emitter<LoadedFileEvent>();
  const changed = new Emitter<void>();
  const status = { current: { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true } as CheckStatus | undefined };
  /** `idris2.checking.trigger`, for the queries' passive rule and what checks a stale document again. */
  const settings = { trigger: 'onSave' as CheckingTrigger };
  const root: Classification = { kind: 'loose', dir: '/w' };
  const trust = { isTrusted: true, onDidGrant: new Emitter<void>().event };
  const registry = { backendFor: () => backend, stateFor: () => ({ kind: 'active' }) as const, onDidChange: changed.event };
  const projects = { classify: () => Promise.resolve(root) };
  const checks = { statusOf: () => status.current, onDidChange: new Emitter<void>().event };
  const queries = createDocumentQueries({
    registry,
    projects,
    checks: { check: () => Promise.resolve(undefined), runningCheck: () => undefined, activeDocument: () => asDoc(doc) },
    config: { checking: () => ({ trigger: settings.trigger, delayMs: 700 }) },
    trust,
    log: quietLog,
  });
  const deps: HoverDeps = {
    queries,
    answers: new AnswerCache({ onDidLoad: loads.event }),
    registry,
    projects,
    checks,
    manual: () => settings.trigger === 'manual',
    position: (p) => new FakePosition(p.line, p.character) as unknown as vscode.Position,
  };
  const intelligence: IntelligenceDeps = {
    queries,
    loads: { onDidLoad: loads.event },
    registry,
    projects,
    checks,
    config: {
      inlayHints: () => ({ variableTypes: true }),
      onDidChange: () => ({ dispose: () => undefined }),
      checking: () => ({ trigger: settings.trigger, delayMs: 700 }),
    },
    log: quietLog,
  };
  return { doc, tokens, backend, loads, changed, status, settings, deps, intelligence, root };
}

/** `recordedType` answers by name, for the fake backend. */
function answering(answers: Record<string, TypeInfo | undefined>) {
  return (name: string): Promise<TypeInfo | undefined> => Promise.resolve(answers[name]);
}

suite('features/intelligence/occurrence', () => {
  test('the name at a position is the narrowest named token there, else one ending there', () => {
    const { doc, tokens } = shapes();
    const occ = (line: number, character: number) => occurrenceAt(doc, tokens, at(line, character));
    assert.deepStrictEqual(occ(12, 13), { range: { start: at(12, 13), end: at(12, 14) }, name: 'r', decor: 'bound' });
    assert.deepStrictEqual(occ(12, 14), { range: { start: at(12, 13), end: at(12, 14) }, name: 'r', decor: 'bound' }, 'just after r (before `)`)');
    assert.strictEqual(occ(6, 5)?.name, 'Circle');
    assert.strictEqual(occ(6, 5)?.decor, 'data');
    assert.deepStrictEqual(occ(39, 2), { range: { start: at(39, 0), end: at(39, 5) }, name: '|+|', decor: 'function' }, 'an operator token spans its parentheses');
    assert.strictEqual(occ(12, 19)?.name, 'pi');
  });

  test('keywords, comments and literals are no names, and the lexer is not asked there', () => {
    const { doc, tokens } = shapes();
    for (const [line, character, what] of [
      [4, 1, 'keyword data'],
      [2, 8, 'doc comment'],
      [11, 19, 'Double (a type without a name)'],
      [23, 25, 'the literal 2'],
      [12, 16, '='],
    ] as const) {
      assert.strictEqual(occurrenceAt(doc, tokens, at(line, character)), undefined, what);
    }
  });

  test('without a token, the lexer finds holes, qualified names and operators, but not reserved symbols', () => {
    const doc = new FakeDocument('/w/V.idr', 'vlen : Vect n a -> Nat\nvlen xs = ?vlen_rhs\ng = Data.Vect.index 0 xs <+> r.field');
    assert.deepStrictEqual(occurrenceAt(doc, [], at(1, 12)), { range: { start: at(1, 10), end: at(1, 19) }, name: 'vlen_rhs' });
    assert.strictEqual(occurrenceAt(doc, undefined, at(2, 12))?.name, 'index');
    assert.strictEqual(occurrenceAt(doc, undefined, at(2, 26))?.name, '<+>');
    assert.strictEqual(occurrenceAt(doc, undefined, at(2, 31))?.name, 'field');
    assert.strictEqual(occurrenceAt(doc, undefined, at(0, 16)), undefined, '->');
    assert.strictEqual(occurrenceAt(doc, undefined, at(0, 5)), undefined, ':');
    assert.strictEqual(occurrenceAt(doc, undefined, at(1, 8)), undefined, '=');
  });

  test('without a token, module and namespace names are no names: `import Data.Vect` is not `Vect` (second review of M3)', () => {
    // (:type-of "Vect" 3 7) on `import Data.Vect` answered the type `Data.Vect.Vect` [live, 0.8.0].
    const doc = new FakeDocument(
      '/w/Foo/Shapes.idr',
      'module Foo.Shapes\n\nimport Data.Vect\nimport public {- c -} Data.List\nimport Data.String as S\n\nnamespace Inner\n  f : Nat\n  f = S.length "ab"',
    );
    for (const [line, character, what] of [
      [0, 9, 'module Foo.Shapes'],
      [2, 12, 'import Data.Vect'],
      [3, 25, 'import public Data.List (a comment between)'],
      [4, 10, 'import Data.String'],
      [4, 19, 'as'],
      [4, 22, 'the alias S'],
      [6, 12, 'namespace Inner'],
    ] as const) {
      assert.strictEqual(occurrenceAt(doc, undefined, at(line, character)), undefined, what);
    }
    assert.strictEqual(occurrenceAt(doc, undefined, at(7, 2))?.name, 'f');
    assert.strictEqual(occurrenceAt(doc, undefined, at(8, 8))?.name, 'length', 'a name qualified by the alias is a name');
    // `as` and `public` elsewhere are what they are: an identifier `as` in an expression is a name.
    assert.strictEqual(occurrenceAt(new FakeDocument('/w/A.idr', 'g as = as'), undefined, at(0, 7))?.name, 'as');
  });

  test('bird-track lines are read without their marker; prose lines give nothing', () => {
    const doc = fixtureDocument('test/fixtures/workspaces/loose-file/Lit.lidr');
    const tokens = recordedTokens('lit-lookups', 'Lit.lidr', doc);
    assert.deepStrictEqual(occurrenceAt(doc, tokens, at(5, 9)), { range: { start: at(5, 9), end: at(5, 10) }, name: 'n', decor: 'bound' });
    assert.deepStrictEqual(tokens.find((t) => t.decor === 'keyword' && t.range.start.line === 0)?.range.start, at(0, 2), 'module at column 2 (F11)');
    assert.strictEqual(occurrenceAt(doc, undefined, at(4, 3))?.name, 'double');
    assert.strictEqual(occurrenceAt(doc, undefined, at(2, 3)), undefined, 'a prose line');
  });

  test('while the document shows other text: unchanged lines keep their tokens; on a changed line those whose text is still there', () => {
    const { doc, tokens } = shapes();
    const index = indexOf(doc, tokens);
    assert.strictEqual(currentTokens(doc, index), tokens, 'the same text: every token');
    const on = (ts: readonly Token[], line: number) => ts.filter((t) => t.range.start.line === line).map((t) => `${t.name ?? t.decor}@${t.range.start.character}`);
    assert.deepStrictEqual(on(tokens, 12), ['area@0', 'keyword@5', 'Circle@6', 'r@13', 'keyword@14', 'keyword@16', 'pi@18', '*@21', 'r@23', '*@25', 'r@27']);
    const lines = doc.getText().split('\n');
    lines[12] = 'area (Circle radius) = pi * radius * radius';
    doc.edit(lines.join('\n'));
    const kept = currentTokens(doc, index);
    // Line 12 changed: what is still there at its place, as a whole token (`r` is the start of
    // `radius`; the `)` and `=` moved; nothing continues the bracket `(`).
    assert.deepStrictEqual(on(kept, 12), ['area@0', 'keyword@5', 'Circle@6']);
    // Every other line is unchanged: its keywords, comments and literals too (second review of M3).
    assert.strictEqual(kept.length, tokens.length - (on(tokens, 12).length - 3));
    assert.ok(kept.some((t) => t.range.start.line === 39 && t.name === '|+|'), '(|+|) still there');
    assert.strictEqual(currentTokens(doc, index), kept, 'computed once per version');
    // An index whose text is not known: only the named tokens the document still spells.
    const unknown = currentTokens(doc, { file: index.file, tokens: index.tokens });
    assert.ok(unknown.every((t) => t.name !== undefined) && unknown.length < kept.length);
    assert.ok(!unknown.some((t) => t.range.start.line === 12 && t.name === 'r'), 'r is no longer there');
    // No unsaved changes, and the text the load read (an undo or a revert back to it gives a new
    // version): every token again; another text: those carried over.
    const edited = doc.getText();
    doc.isDirty = false;
    assert.strictEqual(currentTokens(doc, { ...index, text: edited }), index.tokens, 'the same text: every token');
    assert.strictEqual(currentTokens(doc, { ...index, text: `\uFEFF${edited}` }), index.tokens, 'read from disk with a byte order mark');
    assert.notStrictEqual(currentTokens(doc, { ...index, text: `${edited}\n` }), index.tokens, 'another text: carried over');
    doc.isDirty = true;
    assert.notStrictEqual(currentTokens(doc, { ...index, text: edited }), index.tokens, 'unsaved changes: carried over');
    // `r` at 12:13 now ends the identifier `Circlear`, and `Circle` at 12:6 starts it.
    lines[12] = 'area (Circlear) = pi * r * r';
    doc.edit(lines.join('\n'));
    assert.deepStrictEqual(on(currentTokens(doc, index), 12), ['area@0', 'keyword@5', 'keyword@14', 'keyword@16', 'pi@18', '*@21', 'r@23', '*@25', 'r@27']);
  });

  test('an inserted or deleted line moves the tokens below it; a space typed at the end keeps every token (second review of M3)', () => {
    const { doc, tokens } = shapes();
    const index = indexOf(doc, tokens);
    const original = doc.getText();
    const onLine = (ts: readonly Token[], line: number) => ts.filter((t) => t.range.start.line === line).map((t) => `${t.name ?? t.decor}@${t.range.start.character}`);
    doc.edit(`${original} `);
    assert.strictEqual(currentTokens(doc, index).length, tokens.length, 'nothing is dropped for a space at the end');
    const lines = original.split('\n');
    lines.splice(5, 0, '');
    doc.edit(lines.join('\n'));
    const moved = currentTokens(doc, index);
    assert.strictEqual(moved.length, tokens.length, 'an empty line inserted: every token kept');
    assert.deepStrictEqual(onLine(moved, 13), onLine(tokens, 12), 'line 12 is now line 13');
    assert.deepStrictEqual(onLine(moved, 40), onLine(tokens, 39));
    assert.deepStrictEqual(onLine(moved, 4), onLine(tokens, 4), 'above it: unchanged');
    lines.splice(5, 2);
    doc.edit(lines.join('\n'));
    assert.deepStrictEqual(onLine(currentTokens(doc, index), 11), onLine(tokens, 12), 'line 6 deleted: line 12 is now line 11');
    // A token over several lines (a block comment) is kept above and below an edit, dropped on it.
    const text = '{- a\n   b -}\nf : Nat\nf = 1\n{- c\n   d -}\n';
    const block = new FakeDocument('/w/B.idr', text);
    const comment = (line: number): Token => ({ range: { start: at(line, 0), end: at(line + 1, 7) }, decor: 'comment' });
    const blockIndex = { file: block.fileName, text, tokens: [comment(0), comment(4)] };
    block.edit(text.replace('f = 1', 'f = 12'));
    assert.deepStrictEqual(currentTokens(block, blockIndex), [comment(0), comment(4)]);
    block.edit(text.replace('   b -}', '   bb -}'));
    assert.deepStrictEqual(currentTokens(block, blockIndex), [comment(4)]);
    // Two edits apart (fourth review of M3): the lines between them keep their tokens, moved with
    // them; only the line edited in place is compared at the same place.
    const two = original.split('\n');
    two.splice(5, 0, '');
    two[13] = `${two[13]} `;
    doc.edit(two.join('\n'));
    const between = currentTokens(doc, index);
    assert.deepStrictEqual(onLine(between, 40), onLine(tokens, 39), 'below both: moved');
    assert.deepStrictEqual(onLine(between, 12), onLine(tokens, 11), 'between them: moved with its line');
    assert.deepStrictEqual(onLine(between, 13), onLine(tokens, 12), 'the line edited in place: every token, a space typed at its end');
    assert.strictEqual(between.length, tokens.length);
  });

  test('a lone \\r in the file the load read: the tokens below it are kept on their lines, as VS Code breaks them (fifth review of M3)', () => {
    // The compiler numbers lines at \n only [live, idris2 0.8.0]; VS Code breaks them at the \r too,
    // and its document is the file's lines joined by one line break. Split at the \r as well, the
    // index text paired every line below with the line above it.
    const disk = 'module M\n-- a\rb\narea : Nat -> Nat\narea x = x\n';
    const doc = new FakeDocument('/w/M.idr', 'module M\n-- a\nb\narea : Nat -> Nat\narea x = x\n');
    const area: Token = { range: { start: at(2, 0), end: at(2, 4) }, decor: 'function', name: 'area', namespace: '' };
    const x: Token = { range: { start: at(3, 5), end: at(3, 6) }, decor: 'bound', name: 'x', namespace: '' };
    const kept = currentTokens(doc, { file: doc.fileName, text: disk, tokens: [area, x] });
    assert.deepStrictEqual(kept.map((t) => [t.name, t.range.start.line, t.range.start.character]), [['area', 3, 0], ['x', 4, 5]]);
  });

  test('the line that holds a lone \\r: its tokens are kept, those after the \\r one line down, a comment across it over two lines (seventh review of M3)', () => {
    // Diffed with the editor's lines, the compiler's line holding the \r was never paired: its
    // tokens, and so its hover and inlay hints, were dropped.
    const disk = 'module M\n\nf : Nat -> Nat\nf x = x -- a\r-- b\ng y = y\n';
    const doc = new FakeDocument('/w/M.idr', 'module M\n\nf : Nat -> Nat\nf x = x -- a\n-- b\ng y = y\n');
    const x: Token = { range: { start: at(3, 2), end: at(3, 3) }, decor: 'bound', name: 'x', namespace: '' };
    const comment: Token = { range: { start: at(3, 8), end: at(3, 17) }, decor: 'comment' };
    const y: Token = { range: { start: at(4, 2), end: at(4, 3) }, decor: 'bound', name: 'y', namespace: '' };
    const kept = currentTokens(doc, { file: doc.fileName, text: disk, tokens: [x, comment, y] });
    assert.deepStrictEqual(
      kept.map((t) => [t.name ?? t.decor, t.range.start.line, t.range.start.character, t.range.end.line, t.range.end.character]),
      [['x', 3, 2, 3, 3], ['comment', 3, 8, 4, 4], ['y', 5, 2, 5, 3]],
    );
    assert.strictEqual(kept[0], x, 'a token that did not move is the index\'s own');
    assert.strictEqual(indexTokenOf(kept[1]), comment);
    assert.strictEqual(indexTokenOf(kept[2]), y);
  });

  test('two separate edits: the tokens between them are kept at the lines they moved to, none at a neighbouring line (fourth review of M3)', () => {
    // The reviewer's probe: an import inserted as line 1 and the last line of code edited kept 10 of
    // the 136 tokens, two of them on neighbouring lines.
    const { doc, tokens } = shapes();
    const index = indexOf(doc, tokens);
    const lines = doc.getText().split('\n');
    const last = lines.length - 2;
    const shown = [lines[0], 'import Data.List', ...lines.slice(1)];
    shown[last + 1] = `${shown[last + 1]} -- edited`;
    doc.edit(shown.join('\n'));
    const kept = currentTokens(doc, index);
    // Every token of the saved text, each on the line that now holds its text; the edited line's too
    // (only a comment was added after them).
    assert.strictEqual(kept.length, tokens.length);
    for (const t of kept) {
      const text = shown[t.range.start.line].slice(t.range.start.character, t.range.end.character);
      const saved = lines[indexTokenOf(t).range.start.line].slice(t.range.start.character, t.range.end.character);
      if (t.range.start.line === t.range.end.line) {
        assert.strictEqual(text, saved, `${t.name ?? t.decor} at ${t.range.start.line}:${t.range.start.character}`);
      }
      const from = indexTokenOf(t).range.start.line;
      assert.strictEqual(t.range.start.line - from, from === 0 ? 0 : 1, 'line 0 stays, the others moved one line down');
    }
  });

  test('spells: the name, parenthesised or backticked, or qualified', () => {
    assert.ok(spells('r', 'r'));
    assert.ok(spells('(|+|)', '|+|'));
    assert.ok(spells('`div`', 'div'));
    assert.ok(spells('Data.Vect.index', 'index'));
    assert.ok(!spells('radius', 'r'));
    assert.ok(!spells('x.index', 'dex'));
    assert.ok(!spells(undefined, 'r'));
    assert.ok(!spells('<.>', '>'), "an operator's dots are not a namespace");
  });
});

suite('features/intelligence/hover', () => {
  test('a pattern variable: its positional type, no docs asked (a local has none)', async () => {
    const t = hoverSetup();
    t.backend.typeAnswer = answering({ r: recordedType('shapes-lookups', '(:type-of "r" 13 13)') });
    const result = await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(result.kind, 'model');
    assert.deepStrictEqual(result.kind === 'model' && result.model, {
      range: { start: at(12, 13), end: at(12, 14) },
      type: { text: 'r : Double', spans: [{ start: 4, length: 6, decor: 'type' }], lookup: 'position' },
      docOverview: undefined,
      stale: false,
    });
    assert.deepStrictEqual(t.backend.calls, ['typeAt r 12:13']);
  });

  test("a global: its type and the overview of the docs block of the declaration the type names", async () => {
    const t = hoverSetup();
    t.backend.typeAnswer = answering({ area: recordedType('shapes-lookups', '(:type-of "area" 13 0)') });
    t.backend.docsAnswer = () => Promise.resolve(recordedReply('shapes-lookups', '(:docs-for "area")'));
    const result = await hoverAt(t.deps, asDoc(t.doc), at(12, 1), 'passive');
    assert.strictEqual(result.kind === 'model' && result.model.docOverview, 'The area of a shape.');
    assert.deepStrictEqual(t.backend.calls, ['typeAt area 12:0', 'docsFor area overview']);
  });

  test('an overloaded name looked up by name gets no overview (which definition is meant is unknown)', async () => {
    const t = hoverSetup();
    t.backend.index = undefined; // the lexer finds `index`
    const doc = new FakeDocument('/w/C.idr', 'g = index');
    t.backend.typeAnswer = () => Promise.resolve(recordedType('clean-queries', '(:type-of "index")', 'name'));
    t.backend.docsAnswer = () => Promise.resolve({ text: 'Data.List.index : Nat\n  In a list.\nData.Vect.index : Nat\n  In a vector.', spans: [] });
    const result = await hoverAt(t.deps, asDoc(doc), at(0, 5), 'passive');
    assert.strictEqual(result.kind, 'model');
    assert.strictEqual(result.kind === 'model' && result.model.docOverview, undefined);
    t.backend.docsAnswer = () => Promise.resolve(recordedReply('clean-queries', '(:docs-for "::")'));
    t.backend.typeAnswer = () => Promise.resolve({ text: 'Data.Vect.(::) : elem -> Vect len elem -> Vect (S len) elem', spans: [], lookup: 'position' });
    const cons = await hoverAt(t.deps, asDoc(new FakeDocument('/w/D.idr', 'g = x :: xs')), at(0, 7), 'passive');
    assert.strictEqual(
      cons.kind === 'model' && cons.model.docOverview,
      'A non-empty vector of length `S len`, consisting of a head element and the rest of the list, of length `len`.',
      'the positional answer names one definition: its block',
    );
  });

  test('a bound token answered by name is dropped (it would describe a global the local shadows)', async () => {
    const t = hoverSetup();
    t.backend.typeAnswer = () => Promise.resolve({ text: 'Main.r : Nat', spans: [], lookup: 'name' });
    const result = await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(result.kind, 'noType');
  });

  test('stale: a positional answer about another name is dropped; one about this name is shown, marked', async () => {
    const t = hoverSetup();
    t.status.current = { kind: 'checked', errors: 0, warnings: 0, stale: true, known: true };
    t.backend.typeAnswer = () => Promise.resolve(recordedType('unicode-columns', '(:type-of "y" 12 3)')); // x₁ : ℕ
    assert.strictEqual((await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive')).kind, 'noType');
    t.loads.fire({ root: t.root, file: t.doc.fileName, rebuilt: true });
    t.backend.typeAnswer = () => Promise.resolve({ text: 'r : Double', spans: [], lookup: 'position' });
    const result = await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(result.kind === 'model' && result.model.stale, true);
    // A global named in a positional answer about another name, while stale: dropped too (the
    // IDE-mode backend passes on no positional answer about another unqualified name at all,
    // backendIde.test.ts: `perimeter` of `Measured Shape where`).
    t.loads.fire({ root: t.root, file: t.doc.fileName, rebuilt: true });
    t.backend.typeAnswer = () => Promise.resolve({ text: 'Foo.Shapes.area : Shape -> Double', spans: [], lookup: 'position' });
    assert.strictEqual((await hoverAt(t.deps, asDoc(t.doc), at(23, 3), 'passive')).kind, 'noType');
  });

  test('the occurrence\'s decoration goes to typeAt: a variable\'s `bound`, so that the backend does not ask for it by name', async () => {
    const t = hoverSetup();
    t.backend.typeAnswer = answering({ r: { text: 'r : Double', spans: [], lookup: 'position' }, area: { text: 'Foo.Shapes.area : Shape -> Double', spans: [], lookup: 'position' } });
    await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    await hoverAt(t.deps, asDoc(t.doc), at(12, 1), 'passive');
    assert.deepStrictEqual(t.backend.decors, ['bound', 'function']);
  });

  test('while stale the type is not kept: an answer found with unsaved changes is not shown after an undo to the saved text (third review of M3)', async () => {
    const t = hoverSetup();
    const saved = t.doc.getText();
    // While the text differs, the backend finds no type at the position (another place of the file as loaded).
    t.backend.typeAnswer = () => Promise.resolve(t.doc.isDirty ? undefined : { text: 'r : Double', spans: [], lookup: 'position' });
    t.doc.edit(saved.replace('area (Circle r)', 'area (Circle r) '));
    assert.strictEqual((await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive')).kind, 'noType');
    t.doc.edit(saved, true); // undo back to the saved text: no load follows
    const result = await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.deepStrictEqual(result.kind === 'model' && [result.model.type?.text, result.model.stale], ['r : Double', false]);
    assert.strictEqual(t.backend.calls.length, 2);
    await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(t.backend.calls.length, 2, 'kept again once the document is not stale');
  });

  test('isStale: unsaved changes, or what the checks say', () => {
    const doc = new FakeDocument('/w/A.idr', 'x');
    assert.strictEqual(isStale(asDoc(doc), undefined), false);
    assert.strictEqual(isStale(asDoc(doc), { kind: 'checked', errors: 0, warnings: 0, stale: true, known: true }), true);
    assert.strictEqual(isStale(asDoc(doc), { kind: 'packageError', ipkg: '/w/a.ipkg', message: 'bad', stale: true }), true);
    assert.strictEqual(isStale(asDoc(doc), { kind: 'checking', waitingFor: undefined }), false);
    doc.edit('y');
    assert.strictEqual(isStale(asDoc(doc), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true }), true);
  });

  test('answers are cached per file until a load makes them stale; while its check runs they are asked again', async () => {
    const t = hoverSetup();
    t.backend.typeAnswer = answering({ r: { text: 'r : Double', spans: [], lookup: 'position' } });
    await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(t.backend.calls.length, 1);
    t.status.current = { kind: 'checking', waitingFor: undefined };
    await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(t.backend.calls.length, 2);
    t.status.current = undefined;
    t.loads.fire({ root: t.root, file: t.doc.fileName, rebuilt: false });
    await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(t.backend.calls.length, 2, 'a load that built nothing keeps them');
    t.loads.fire({ root: t.root, file: '/w/Other.idr', rebuilt: true });
    await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive');
    assert.strictEqual(t.backend.calls.length, 3, 'a load of another file of the root that built something drops them');
  });

  test('passive: nothing without the hover capability, for untitled documents, or where there is no name', async () => {
    const t = hoverSetup();
    t.backend.caps = { ...t.backend.caps, hover: false };
    assert.strictEqual((await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'passive')).kind, 'noName');
    assert.strictEqual((await hoverAt(t.deps, asDoc(t.doc), at(12, 13), 'command')).kind, 'noType', 'a command asks anyway');
    t.backend.caps = { ...t.backend.caps, hover: true };
    assert.strictEqual((await hoverAt(t.deps, asDoc(new FakeDocument('Untitled-1', 'x', 'idris2', 'untitled')), at(0, 0), 'passive')).kind, 'noName');
    assert.strictEqual((await hoverAt(t.deps, asDoc(t.doc), at(4, 1), 'passive')).kind, 'noName');
    assert.strictEqual(t.backend.calls.length, 1);
  });

  suite('rendering', () => {
    const HOSTILE = '```\n[x](command:workbench.action.terminal.sendSequence?%7B%7D) <b>$(alert)</b> # h';

    test('compiler text goes only into fenced blocks: the type in an idris2 one, the overview in a `text` one', () => {
      const md = new FakeMarkdownString();
      const model: HoverModel = { range: { start: at(0, 0), end: at(0, 1) }, type: { text: HOSTILE, spans: [], lookup: 'name' }, docOverview: HOSTILE, stale: true };
      renderHover(md, model);
      assert.deepStrictEqual(md.parts.filter((p) => p.kind === 'text'), [], 'nothing through appendText');
      const markdown = md.parts.map((p) => p.value);
      assert.ok(markdown.includes(codeBlock(HOSTILE, 'idris2')), 'the type in its fence');
      assert.ok(markdown.includes(codeBlock(HOSTILE, 'text')), 'the overview in its fence');
      const own = markdown.filter((m) => m !== codeBlock(HOSTILE, 'idris2') && m !== codeBlock(HOSTILE, 'text'));
      assert.ok(own.every((m) => !m.includes('command:') && !m.includes('```')), 'the rest is our own text');
      assert.ok(own[0].startsWith('*Results refer to the saved file'), 'stale: an italic first line');
      assert.ok(own.some((m) => m.includes('Name-based lookup')), 'name: the note');
      // VS Code 1.139.1 colours a block without an info string in the editor's language (Idris).
      assert.ok(markdown.some((m) => /^\n`{3,}text\n/.test(m)), 'the overview\'s fence names `text`');
    });

    test('an overview with named character references and autolinks stays in its fence (appendText let them through)', () => {
      // VS Code 1.139.1's appendText leaves & < : alone: &rlm; became U+200F, <https://x> a link.
      const overview = 'See &rlm;x&ZeroWidthSpace;y <https://example.org> and https://example.org &#x202E;.';
      const md = new FakeMarkdownString();
      renderHover(md, { range: { start: at(0, 0), end: at(0, 1) }, type: { text: 'f : Nat', spans: [], lookup: 'position' }, docOverview: overview, stale: false });
      assert.deepStrictEqual(md.parts, [
        { kind: 'markdown', value: codeBlock('f : Nat', 'idris2') },
        { kind: 'markdown', value: codeBlock(overview, 'text') },
      ]);
    });

    test('invisible characters of compiler text are written out, in the type and in the overview', () => {
      const md = new FakeMarkdownString();
      renderHover(md, { range: { start: at(0, 0), end: at(0, 1) }, type: { text: 'f\u202E : Nat', spans: [], lookup: 'position' }, docOverview: 'a\u2066b', stale: false });
      assert.deepStrictEqual(md.parts, [
        { kind: 'markdown', value: codeBlock('f\\u{202E} : Nat', 'idris2') },
        { kind: 'markdown', value: codeBlock('a\\u{2066}b', 'text') },
      ]);
    });

    test('no notes for a positional answer about the text shown', () => {
      const md = new FakeMarkdownString();
      renderHover(md, { range: { start: at(0, 0), end: at(0, 1) }, type: { text: 'xs : Vect ?_ ?_', spans: [], lookup: 'position' }, stale: false });
      assert.deepStrictEqual(md.parts, [{ kind: 'markdown', value: codeBlock('xs : Vect ?_ ?_', 'idris2') }]);
    });
  });

  suite('the provider and Type at Cursor (register.ts)', () => {
    function registered() {
      const t = hoverSetup();
      const fake = fakeApi();
      const intelligence = registerIntelligence(fake.api as never, t.intelligence, { keepNotices: true });
      return { ...t, fake, intelligence };
    }

    test('the hover is an untrusted MarkdownString without HTML or theme icons, over the token', async () => {
      const t = registered();
      t.backend.typeAnswer = answering({ r: { text: 'r : Double', spans: [], lookup: 'position' } });
      const hover = (await t.fake.providers.hover?.provideHover(asDoc(t.doc), new FakePosition(12, 13) as never, t.fake.cancel)) as unknown as {
        contents: FakeMarkdownString;
        range: { start: FakePosition; end: FakePosition };
      };
      assert.strictEqual(hover.contents.isTrusted, false);
      assert.strictEqual(hover.contents.supportHtml, false);
      assert.strictEqual(hover.contents.supportThemeIcons, false);
      assert.deepStrictEqual(hover.contents.parts, [{ kind: 'markdown', value: codeBlock('r : Double', 'idris2') }]);
      assert.deepStrictEqual([hover.range.start, hover.range.end], [new FakePosition(12, 13), new FakePosition(12, 14)]);
      assert.strictEqual(await t.fake.providers.hover?.provideHover(asDoc(t.doc), new FakePosition(4, 1) as never, t.fake.cancel), undefined);
      t.intelligence.dispose();
    });

    test('a name quoted in a notification is one line with its control and format characters written out', async () => {
      const t = registered();
      t.backend.index = undefined; // the lexer finds the name
      const doc = new FakeDocument('/w/B.idr', 'x = a\u202Eb\u2066c');
      t.fake.state.editor = { document: doc, selection: { active: new FakePosition(0, 5) } };
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      // A reason from the backend is written out too, and joined to one line.
      t.backend.typeAnswer = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'not \u202Ehere\nnow' }));
      t.fake.state.editor = { document: new FakeDocument('/w/C.idr', 'z = q'), selection: { active: new FakePosition(0, 4) } };
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      assert.deepStrictEqual(t.intelligence.notices, [
        'Idris 2: the compiler has no type for "a\\u{202E}b\\u{2066}c" here.',
        'Idris 2: not \\u{202E}here now',
      ]);
      assert.deepStrictEqual(t.fake.messages, t.intelligence.notices);
    });

    test('no type while the document is stale: the notification says the compiler answers about the file as last checked (fourth review of M3), and what checks it again (fifth)', async () => {
      // A new unsaved line: its position is not in the file as loaded, so no positional request is
      // made; before, the notification said only that the compiler had no type for the name.
      const t = registered();
      const lines = t.doc.getText().split('\n');
      lines.splice(13, 0, 'g y = y');
      t.doc.edit(lines.join('\n'));
      t.fake.state.editor = { document: t.doc, selection: { active: new FakePosition(13, 6) } };
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      assert.deepStrictEqual(t.intelligence.notices, [
        'Idris 2: no type for "y" here: the compiler answers about the file as it last checked it, and the editor shows changes made since. ' +
          'Save the file to check it again.',
      ]);
      // What checks it again depends on why it is stale (fifth review of M3: Check File, offered
      // with unsaved changes, checks the saved file and leaves the document stale).
      t.status.current = { kind: 'checked', errors: 0, warnings: 0, stale: true, known: true, staleness: { unsaved: true, manual: true } };
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      t.doc.edit(lines.join('\n'), true); // saved (the manual trigger: not checked since)
      t.status.current = { kind: 'checked', errors: 0, warnings: 0, stale: true, known: true, staleness: { unsaved: false, manual: true } };
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      // A package error, stale, under the manual trigger: its staleness too (seventh review of M3:
      // taken as not manual, the advice was a save, which checks nothing then).
      t.doc.edit(lines.join('\n'));
      t.status.current = { kind: 'packageError', ipkg: '/w/p.ipkg', message: 'bad', stale: true, staleness: { unsaved: true, manual: true } };
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      // While a check runs (Check File on the saved file), the checks say nothing about why the
      // document is stale: the trigger comes from the settings (eighth review of M3: taken as not
      // manual, the advice was a save, which checks nothing then).
      t.status.current = { kind: 'checking', waitingFor: undefined };
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      t.settings.trigger = 'manual';
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      assert.deepStrictEqual(
        t.intelligence.notices.slice(1).map((n) => n.slice(n.indexOf('since. ') + 7)),
        [
          'Save the file, then run Idris 2: Check File, to check it again.',
          'Run Idris 2: Check File to check it again.',
          'Save the file, then run Idris 2: Check File, to check it again.',
          'Save the file to check it again.',
          'Save the file, then run Idris 2: Check File, to check it again.',
        ],
      );
    });

    test('closing another document of the same path (a git: one) keeps the file\'s answers and its root; its own close drops them (sixth review of M3)', async () => {
      // VS Code gives a git: document the file's fileName (the Source Control view's Open Changes):
      // its close dropped the answers and the file's root, so answers cached afterwards were never
      // made stale by a load of its root, and the hover showed a type from before an import changed.
      const t = registered();
      t.backend.typeAnswer = answering({ r: { text: 'r : Double', spans: [], lookup: 'position' } });
      const hover = () => t.fake.providers.hover?.provideHover(asDoc(t.doc), new FakePosition(12, 13) as never, t.fake.cancel);
      t.loads.fire({ root: t.root, file: t.doc.fileName, rebuilt: false });
      await hover();
      const gitDoc: { uri: { scheme: string; toString(): string }; fileName: string } = new FakeDocument(t.doc.fileName, t.doc.getText(), 'idris2', 'git');
      t.fake.closed.fire(gitDoc);
      await hover();
      assert.strictEqual(t.backend.calls.length, 1, 'still kept');
      t.loads.fire({ root: t.root, file: '/w/Other.idr', rebuilt: true });
      await hover();
      assert.strictEqual(t.backend.calls.length, 2, 'made stale by a load of its root');
      t.fake.closed.fire(t.doc);
      await hover();
      assert.strictEqual(t.backend.calls.length, 3, 'its own close drops them');
      t.intelligence.dispose();
    });

    test('the file\'s own document closed and opened again with no load of its own: a load of its root still makes the answers asked since stale (tenth review of M3)', async () => {
      // Under the manual trigger a reopened document is not loaded, and the session still answers
      // about it while it is the file loaded last; the close forgot the file's root, so the hover kept
      // a type from before an import changed, with no stale note (the verifier's probe).
      const t = registered();
      t.backend.typeAnswer = answering({ r: { text: 'r : Double', spans: [], lookup: 'position' } });
      const hover = () => t.fake.providers.hover?.provideHover(asDoc(t.doc), new FakePosition(12, 13) as never, t.fake.cancel);
      t.loads.fire({ root: t.root, file: t.doc.fileName, rebuilt: true });
      await hover();
      t.fake.closed.fire(t.doc);
      await hover();
      await hover();
      assert.strictEqual(t.backend.calls.length, 2, 'asked again after the close, then kept');
      t.loads.fire({ root: t.root, file: '/w/Other.idr', rebuilt: true });
      await hover();
      assert.strictEqual(t.backend.calls.length, 3, 'made stale by a load of its root');
      t.intelligence.dispose();
    });

    test('notices are kept for the test API only when asked', async () => {
      const t = hoverSetup();
      const fake = fakeApi();
      const intelligence = registerIntelligence(fake.api as never, t.intelligence);
      await fake.run(TYPE_AT_CURSOR_COMMAND);
      assert.strictEqual(fake.messages.length, 1);
      assert.deepStrictEqual(intelligence.notices, []);
    });

    test('Type at Cursor asks, then shows the hover; otherwise it says why, as plain text', async () => {
      const t = registered();
      const editor = (line: number, character: number, doc = t.doc) => ({ document: doc, selection: { active: new FakePosition(line, character) } });
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      t.fake.state.editor = editor(12, 13, new FakeDocument('Untitled-1', 'x', 'idris2', 'untitled'));
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      t.fake.state.editor = editor(4, 1);
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      t.fake.state.editor = editor(12, 13);
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      t.backend.typeAnswer = () => Promise.reject(new Error('a [link](command:x) in a failure'));
      t.fake.state.editor = editor(12, 23);
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      t.backend.typeAnswer = answering({ r: { text: 'r : Double', spans: [], lookup: 'position' } });
      t.fake.state.editor = editor(12, 27);
      await t.fake.run(TYPE_AT_CURSOR_COMMAND);
      assert.deepStrictEqual(t.intelligence.notices, [
        'Idris 2: this command needs an Idris file saved on disk in the active editor.',
        'Idris 2: this command needs an Idris file saved on disk in the active editor.',
        'Idris 2: there is no name at the cursor.',
        'Idris 2: the compiler has no type for "r" here.',
        'Idris 2: Type at Cursor failed: a [link](command:x) in a failure',
      ]);
      assert.ok(t.fake.messages[4].includes(']\u200b('), 'shown through plainText');
      assert.deepStrictEqual(t.fake.executed, [['editor.action.showHover']]);
      assert.deepStrictEqual(t.backend.calls.slice(-1), ['typeAt r 12:27']);
      // The hover it shows answers from the cache: nothing is asked again.
      const calls = t.backend.calls.length;
      t.changed.fire(); // what IDE mode fires at every request must not empty the cache
      const shown = await t.fake.providers.hover?.provideHover(asDoc(t.doc), new FakePosition(12, 27) as never, t.fake.cancel);
      assert.ok(shown !== undefined);
      assert.strictEqual(t.backend.calls.length, calls);
    });
  });
});

