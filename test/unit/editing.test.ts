// features/editing (ROADMAP §5 M4): what the commands act on, read from the text (targets.ts);
// how an answer is applied (apply.ts: one WorkspaceEdit of the request's document, only at the
// request's version, ranges checked, the new ranges, line breaks); how compiler errors are shown
// (messages.ts); and the command flow from the cursor to the applied edit (commands.ts) against a
// fake backend and a fake VS Code whose workspace applies edits as VS Code does. The texts are the
// fixtures of the `broken` workspace, whose replies the transcripts recorded.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { EditRequest, EditResult, TextReplacement } from '../../src/backend/types';
import { cancelled, IdrisException } from '../../src/core/errors';
import { editorLabel } from '../../src/core/untrustedText';
import { applyReplacements, inOrder, misfit, rangesAfter, withLineBreaks } from '../../src/features/editing/apply';
import { commandName, compilerText, EDITING_COMMAND_KINDS, EDITING_COMMAND_TITLES, failureText, MAX_COMPILER_TEXT, MAX_SHOWN, refusalText } from '../../src/features/editing/messages';
import { registerEditing } from '../../src/features/editing/register';
import { coverageFunctionOf, declarationAt, holeAt, isReadable, lhsStartsAbove, patternVariableAt } from '../../src/features/editing/targets';
import type { EditingCommandId } from '../../src/features/editing/types';
import { repoRoot } from '../fake-tools/paths';
import {
  editingDeps,
  FakeEditBackend,
  FakeEditingApi,
  FakeRange,
  FakeTextDoc,
  FakeWorkspaceEdit,
  range,
} from './support/editingFakes';

const fixture = (name: string): string => fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'broken', name), 'utf8');
const docOf = (name: string, options: { text?: string; languageId?: string; version?: number } = {}): FakeTextDoc =>
  new FakeTextDoc({ fileName: `/w/broken/${name}`, text: options.text ?? fixture(name), ...options });
const at = (line: number, character: number) => ({ line, character });

suite('features/editing: targets (what a command acts on, from the text)', () => {
  const clean = docOf('Clean.idr');
  const edits = docOf('Edits.idr');
  const lit = docOf('Lit2.lidr');

  test('holeAt: the ?name token containing the cursor or ending at it; its name without `?`', () => {
    for (const c of [10, 12, 19]) {
      assert.deepStrictEqual(holeAt(clean, at(7, c)), { name: 'vlen_rhs', range: range(7, 10, 7, 19) }, `column ${c}`);
    }
    assert.strictEqual(holeAt(clean, at(7, 9)), undefined); // the space before it
    assert.strictEqual(holeAt(clean, at(7, 5)), undefined); // xs
    assert.deepStrictEqual(holeAt(edits, at(84, 13)), { name: "h'", range: range(84, 12, 84, 15) });
    assert.deepStrictEqual(holeAt(edits, at(87, 8)), { name: 'ε', range: range(87, 7, 87, 9) });
    // `S ?under_rhs`: the hole under an application.
    assert.deepStrictEqual(holeAt(edits, at(56, 14)), { name: 'under_rhs', range: range(56, 12, 56, 22) });
  });

  test('holeAt: the cursor between a hole and a bracket is on the hole; a `?name` in a comment, a string or prose is no hole', () => {
    const doc = new FakeTextDoc({ fileName: '/w/A.idr', text: 'f : Nat\nf = (?h)\n-- ?c\ng : String\ng = "?s"' });
    assert.deepStrictEqual(holeAt(doc, at(1, 7)), { name: 'h', range: range(1, 5, 1, 7) });
    assert.strictEqual(holeAt(doc, at(2, 4)), undefined);
    assert.strictEqual(holeAt(doc, at(4, 6)), undefined);
    // Lit2.lidr: line 4 is prose ("…keep a single `> `…" has no hole, but a `?x` there would be prose too).
    const prose = new FakeTextDoc({ fileName: '/w/P.lidr', text: '> module P\n\nSee ?x here.\n\n> f : Nat\n> f = ?y' });
    assert.strictEqual(holeAt(prose, at(2, 5)), undefined);
    assert.deepStrictEqual(holeAt(prose, at(5, 7)), { name: 'y', range: range(5, 6, 5, 8) });
    assert.deepStrictEqual(holeAt(lit, at(8, 12)), { name: 'vlen_rhs', range: range(8, 12, 8, 21) });
  });

  test('patternVariableAt: a variable of a one-line clause whose right-hand side is a hole is offered (Case Split\'s light bulb)', () => {
    const offered: [FakeTextDoc, number, number, string][] = [
      [clean, 7, 5, 'xs'],
      [clean, 7, 7, 'xs'], // the cursor right after it
      [edits, 26, 13, 'ys'], // go acc ys = ?go_rhs, in a where block
      [edits, 31, 11, 'n'], // classify n | True = ?classify_big, a with alternative
      [edits, 38, 0, 'x'], // x <&&> y = ?op_rhs: the operator is the defined name
      [edits, 38, 7, 'y'],
      [edits, 49, 7, 'k'], // Just k => ?case_just, a case alternative
      [edits, 84, 7, "x'"],
      [edits, 87, 3, 'x₁'],
      [lit, 8, 7, 'xs'],
    ];
    for (const [doc, line, character, name] of offered) {
      const found = patternVariableAt(doc, at(line, character));
      assert.strictEqual(found?.name, name, `${doc.fileName} ${line}:${character}`);
      assert.strictEqual(found?.offered, true, `${doc.fileName} ${line}:${character}`);
    }
    assert.deepStrictEqual(patternVariableAt(clean, at(7, 5))?.range, range(7, 5, 7, 7));
  });

  test('patternVariableAt: found but not offered where the compiler does not split or its reply is not the clause (E15)', () => {
    const notOffered: [FakeTextDoc, number, number, string][] = [
      [edits, 13, 6, 'xs'], // count xs = / ?count_rhs: over two lines
      [edits, 17, 5, 'm'], // step m / n / = ?step_rhs
      [edits, 18, 5, 'n'], // the second line of that left-hand side
      [edits, 44, 8, 'n'], // withLet n = let … in ?let_rhs: not a bare hole
      [edits, 56, 6, 'n'], // under n = S ?under_rhs
      [docOf('Plain.idr'), 4, 2, 'n'], // f n = n (F15)
      [new FakeTextDoc({ fileName: '/w/U.idr', text: 'f : Nat -> Nat\nf X = ?h' }), 1, 2, 'X'], // a capital: by convention a constructor
      // A left-hand side continued inside brackets: one layout block over two lines.
      [new FakeTextDoc({ fileName: '/w/V.idr', text: 'f : (Nat, Nat) -> Nat\nf (x,\n   y) = ?h' }), 1, 3, 'x'],
    ];
    for (const [doc, line, character, name] of notOffered) {
      const found = patternVariableAt(doc, at(line, character));
      assert.strictEqual(found?.name, name, `${doc.fileName} ${line}:${character}`);
      assert.strictEqual(found?.offered, false, `${doc.fileName} ${line}:${character}`);
    }
  });

  test('lhsStartsAbove: a clause whose left-hand side goes over lines, also as a deeper-indented block; not a where, case, with or let block', () => {
    const layout = docOf('Layout.idr');
    // above x / y = ?above_rhs: the second line is a block of its own in the model.
    assert.strictEqual(lhsStartsAbove(layout, at(47, 2)), true);
    assert.strictEqual(lhsStartsAbove(layout, at(47, 8)), true);
    for (const line of [17, 18, 19]) {
      assert.strictEqual(lhsStartsAbove(edits, at(line, 5)), true, `step, line ${line}`); // step m / n / = ?step_rhs
    }
    const one: [number, number][] = [[13, 6], [14, 4], [26, 16], [31, 26], [48, 18], [49, 14], [52, 30], [44, 30], [7, 12]];
    for (const [line, character] of one) {
      assert.strictEqual(lhsStartsAbove(line === 7 ? clean : edits, at(line, character)), false, `${line}:${character}`);
    }
    const blocks = new FakeTextDoc({ fileName: '/w/X.idr', text: 'h : Nat -> Nat\nh x = g x\n  where\n    g : Nat -> Nat\n    g y = ?h\nm : IO ()\nm = do\n  let y = ?q\n  pure ()\n' });
    assert.strictEqual(lhsStartsAbove(blocks, at(4, 11)), false);
    assert.strictEqual(lhsStartsAbove(blocks, at(7, 11)), false);
  });

  test('patternVariableAt: a case alternative defines nothing, so its lone variable (Make Case\'s case_val) is one; the head of a constructor application is not (edit review of M4)', () => {
    const words = docOf('CaseWords.idr');
    // `made xs = case xs of` / `case_val => ?made_rhs`.
    const found = patternVariableAt(words, at(29, 15));
    assert.deepStrictEqual([found?.name, found?.offered], ['case_val', true]);
    // Inside `(case n of` … `)` the model makes no block of the alternative: after the clause's `=`.
    assert.strictEqual(patternVariableAt(words, at(33, 15)), undefined);
    assert.strictEqual(patternVariableAt(words, at(24, 3)), undefined, 'Just of Just y');
    assert.strictEqual(patternVariableAt(words, at(24, 7))?.name, 'y');
    const lambda = new FakeTextDoc({ fileName: '/w/L.idr', text: 'f : Maybe Nat -> Nat\nf = \\case\n  y => ?h\n' });
    assert.deepStrictEqual([patternVariableAt(lambda, at(2, 2))?.name, patternVariableAt(lambda, at(2, 2))?.offered], ['y', true]);
    const ops = new FakeTextDoc({ fileName: '/w/O.idr', text: 'f : List Nat -> Nat\nf xs = case xs of\n  y :: ys => ?h\n  Nothing => ?g\n' });
    assert.strictEqual(patternVariableAt(ops, at(2, 2))?.name, 'y', 'not the head of an application: y :: ys');
    assert.deepStrictEqual([patternVariableAt(ops, at(3, 2))?.name, patternVariableAt(ops, at(3, 2))?.offered], ['Nothing', false], 'a capital: not offered');
    // A function clause still defines its first name.
    assert.strictEqual(patternVariableAt(words, at(28, 1)), undefined);
  });

  test('patternVariableAt: nothing on the defined name, a signature, a right-hand side, a let, a qualified name or a keyword', () => {
    const none: [FakeTextDoc, number, number][] = [
      [clean, 7, 1], // vlen, the defined name
      [clean, 6, 12], // n in `vlen : Vect n a -> Nat`
      [clean, 7, 12], // the hole itself
      [edits, 44, 16], // m of `let m = S n`
      [edits, 52, 21], // m of `case n of m => ?inline_rhs`: after the clause's `=`
      [edits, 49, 3], // Just, the defined name of the alternative
      [edits, 30, 9], // n of `classify n with (n > 10)`: no `=` in its block
      [edits, 0, 8], // Edits, after `module`
      [new FakeTextDoc({ fileName: '/w/Q.idr', text: 'f : Show a => a -> String\nf x = Prelude.show ?h' }), 0, 9],
      [new FakeTextDoc({ fileName: '/w/Q.idr', text: 'f : Nat -> Nat\nf Data.x = ?h' }), 1, 8],
    ];
    for (const [doc, line, character] of none) {
      assert.strictEqual(patternVariableAt(doc, at(line, character)), undefined, `${doc.fileName} ${line}:${character}`);
    }
  });

  test('declarationAt: any line of a type declaration; its name as the requests take it; whether clauses follow it', () => {
    for (const line of [7, 8, 9]) {
      assert.deepStrictEqual(
        declarationAt(edits, at(line, 3)),
        { name: 'zip3', nameRange: range(7, 0, 7, 4), range: range(7, 0, 9, 23), hasClauses: false, foreign: false, several: false, local: false },
        `line ${line}`,
      );
    }
    assert.strictEqual(declarationAt(edits, at(10, 0)), undefined); // the blank line after it
    assert.strictEqual(declarationAt(edits, at(12, 3))?.hasClauses, true); // count
    assert.deepStrictEqual(declarationAt(edits, at(37, 2)), { name: '(<&&>)', nameRange: range(37, 0, 37, 6), range: range(37, 0, 37, 29), hasClauses: true, foreign: false, several: false, local: false });
    assert.deepStrictEqual(declarationAt(edits, at(40, 20))?.name, '(<||>)');
    assert.strictEqual(declarationAt(edits, at(40, 20))?.hasClauses, false);
    assert.deepStrictEqual(declarationAt(edits, at(25, 6)), { name: 'go', nameRange: range(25, 4, 25, 6), range: range(25, 4, 25, 31), hasClauses: true, foreign: false, several: false, local: true }); // in a where block
    assert.deepStrictEqual(declarationAt(edits, at(91, 1))?.name, 'both'); // below `partial`
    assert.strictEqual(declarationAt(edits, at(90, 1)), undefined); // `partial` alone
    assert.strictEqual(declarationAt(edits, at(74, 3))?.hasClauses, false); // swap
    assert.strictEqual(declarationAt(edits, at(86, 0))?.name, 'δ');
    assert.deepStrictEqual(declarationAt(clean, at(4, 2)), { name: 'append', nameRange: range(4, 0, 4, 6), range: range(4, 0, 4, 47), hasClauses: false, foreign: false, several: false, local: false });
    assert.strictEqual(declarationAt(clean, at(6, 20))?.hasClauses, true); // vlen
    assert.deepStrictEqual(declarationAt(lit, at(10, 4)), { name: 'vapp', nameRange: range(10, 2, 10, 6), range: range(10, 2, 10, 47), hasClauses: false, foreign: false, several: false, local: false });
  });

  test('declarationAt: nothing on a clause, a fixity declaration, or a constructor, field or method', () => {
    assert.strictEqual(declarationAt(clean, at(7, 1)), undefined);
    assert.strictEqual(declarationAt(edits, at(35, 20)), undefined); // private infixr 5 <&&>, <||>
    const types = new FakeTextDoc({
      fileName: '/w/T.idr',
      text: 'data T : Type where\n  MkT : Nat -> T\n\nrecord R where\n  constructor MkR\n  field : Nat\n\ninterface C a where\n  meth : a -> Nat\n\nmutual\n  f : Nat\n  f = 1\n\na, b : Nat',
    });
    for (const line of [1, 5, 8]) {
      assert.strictEqual(declarationAt(types, at(line, 3)), undefined, `line ${line}`);
    }
    assert.strictEqual(declarationAt(types, at(11, 2))?.name, 'f'); // in a mutual block
    assert.strictEqual(declarationAt(types, at(11, 2))?.local, false);
    assert.strictEqual(declarationAt(types, at(14, 3))?.name, 'b'); // the name at the cursor
    assert.strictEqual(declarationAt(types, at(14, 6))?.name, 'a'); // else the first
  });

  test('coverageFunctionOf: the declaration at a coverage error that lists missing cases (the idris2 collection only), not a name from the message', () => {
    const part = docOf('Part.idr');
    const coverage = { range: range(2, 0, 2, 14), message: 'g is not covering.\n\nMissing cases:\n    g (S _)', source: 'idris2' };
    assert.strictEqual(coverageFunctionOf(part, coverage)?.name, 'g');
    assert.strictEqual(coverageFunctionOf(part, { ...coverage, message: 'main is not covering.\n\nMissing cases:\n    g (S _)' })?.name, 'g');
    assert.strictEqual(coverageFunctionOf(part, { ...coverage, source: 'other' }), undefined);
    assert.strictEqual(coverageFunctionOf(part, { range: range(5, 0, 5, 12), message: 'main is not covering.\n\nCalls non covering function Part.g', source: 'idris2' }), undefined);
  });

  test('isReadable: plain source and bird tracks; not a fenced literate file (M12)', () => {
    assert.ok(isReadable(clean) && isReadable(lit));
    const md = new FakeTextDoc({ fileName: '/w/F.idr.md', text: '# F\n\n```idris\nf : Nat\nf = ?h\n```', languageId: 'markdown' });
    assert.ok(!isReadable(md));
    assert.strictEqual(holeAt(md, at(4, 5)), undefined);
  });
});

suite('features/editing: applying an answer (apply.ts)', () => {
  const r = (sl: number, sc: number, el: number, ec: number, text: string): TextReplacement => ({ range: range(sl, sc, el, ec), text });

  test('rangesAfter: each text\'s range after all are applied, lines and columns shifted by the ones before', () => {
    // make-lemma: a declaration inserted above, the hole replaced below (Clean.idr).
    assert.deepStrictEqual(rangesAfter([r(6, 0, 6, 0, 'vlen_rhs : Vect n a -> Nat\n\n'), r(7, 10, 7, 19, 'vlen_rhs xs')]), [
      range(6, 0, 8, 0),
      range(9, 10, 9, 21),
    ]);
    // Two on one line: the second moves by the first's change of length.
    assert.deepStrictEqual(rangesAfter([r(0, 2, 0, 4, 'abcd'), r(0, 6, 0, 7, 'x')]), [range(0, 2, 0, 6), range(0, 8, 0, 9)]);
    // A replacement over three lines by one line moves the lines below up by two.
    assert.deepStrictEqual(rangesAfter([r(1, 3, 3, 1, 'z'), r(5, 0, 5, 2, 'q')]), [range(1, 3, 1, 4), range(3, 0, 3, 1)]);
    // Line breaks as the editor counts them, and the rest of a line after a multi-line text.
    assert.deepStrictEqual(rangesAfter([r(0, 5, 0, 6, 'a\r\nbc\rdef'), r(0, 8, 0, 8, '!')]), [range(0, 5, 2, 3), range(2, 5, 2, 6)]);
    assert.deepStrictEqual(rangesAfter([r(2, 0, 2, 0, '')]), [range(2, 0, 2, 0)]);
  });

  test('misfit: ranges outside the text, backwards or overlapping are refused; touching ones are not', () => {
    const doc = new FakeTextDoc({ fileName: '/w/A.idr', text: 'abc\nde' });
    assert.strictEqual(misfit(doc, [r(0, 0, 1, 2, 'x')]), undefined);
    assert.strictEqual(misfit(doc, inOrder([r(0, 1, 0, 2, 'x'), r(0, 0, 0, 1, 'y')])), undefined);
    assert.strictEqual(misfit(doc, [r(0, 1, 0, 1, 'x'), r(0, 1, 0, 1, 'y')]), undefined);
    assert.match(misfit(doc, [r(0, 0, 0, 4, 'x')]) ?? '', /not in the document/);
    assert.match(misfit(doc, [r(2, 0, 2, 0, 'x')]) ?? '', /not in the document/);
    assert.match(misfit(doc, [r(-1, 0, 0, 0, 'x')]) ?? '', /not in the document/);
    assert.match(misfit(doc, [r(0, 0.5, 0, 1, 'x')]) ?? '', /not in the document/);
    assert.match(misfit(doc, [r(1, 1, 0, 2, 'x')]) ?? '', /ends before it starts/);
    assert.match(misfit(doc, [r(0, 0, 0, 2, 'x'), r(0, 1, 0, 3, 'y')]) ?? '', /overlap/);
  });

  test('inOrder: by position, insertions at one point in their order', () => {
    const a = r(1, 0, 1, 0, 'a');
    const b = r(0, 3, 0, 4, 'b');
    const c = r(1, 0, 1, 0, 'c');
    assert.deepStrictEqual(inOrder([a, b, c]), [b, a, c]);
  });

  test('withLineBreaks: every break as the document\'s', () => {
    assert.strictEqual(withLineBreaks('a\nb\r\nc\rd', '\r\n'), 'a\r\nb\r\nc\r\nd');
    assert.strictEqual(withLineBreaks('a\r\nb', '\n'), 'a\nb');
  });

  test('golden: Case Split on Clean.idr replaces line 8 by the two clauses (clean-editing), one WorkspaceEdit of the document, its new range', async () => {
    const api = new FakeEditingApi();
    const doc = api.workspace.open(docOf('Clean.idr'));
    const before = doc.text;
    const outcome = await applyReplacements(api.asApi(), doc as never, 1, [r(7, 0, 7, 19, 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1')]);
    assert.deepStrictEqual(outcome, { kind: 'applied', ranges: [range(7, 0, 8, 28)] });
    assert.strictEqual(doc.text, before.replace('vlen xs = ?vlen_rhs', 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1'));
    assert.strictEqual(api.workspace.edits.length, 1);
    assert.deepStrictEqual(
      api.workspace.edits[0].entries.map((e) => e.uri),
      [doc.uri.toString()],
    );
    assert.strictEqual(doc.version, 2);
  });

  test('golden: a bird-track reply is applied as it is, its `> ` not doubled (lit2-editing)', async () => {
    const api = new FakeEditingApi();
    const doc = api.workspace.open(docOf('Lit2.lidr'));
    await applyReplacements(api.asApi(), doc as never, 1, [r(8, 0, 8, 21, '> vlen [] = ?vlen_rhs_0\n> vlen (x :: xs) = ?vlen_rhs_1')]);
    assert.deepStrictEqual(doc.lines.slice(8, 10), ['> vlen [] = ?vlen_rhs_0', '> vlen (x :: xs) = ?vlen_rhs_1']);
  });

  test('golden: Make Lemma — the declaration inserted above, the hole replaced — is one edit (clean-editing, as ROADMAP M4 accepts it)', async () => {
    const api = new FakeEditingApi();
    const doc = api.workspace.open(docOf('Clean.idr'));
    const outcome = await applyReplacements(api.asApi(), doc as never, 1, [r(7, 10, 7, 19, 'vlen_rhs xs'), r(6, 0, 6, 0, 'vlen_rhs : Vect n a -> Nat\n\n')]);
    assert.deepStrictEqual(outcome, { kind: 'applied', ranges: [range(6, 0, 8, 0), range(9, 10, 9, 21)] });
    assert.deepStrictEqual(doc.lines.slice(4, 10), [
      'append : Vect n a -> Vect m a -> Vect (n + m) a',
      '',
      'vlen_rhs : Vect n a -> Nat',
      '',
      'vlen : Vect n a -> Nat',
      'vlen xs = vlen_rhs xs',
    ]);
    assert.strictEqual(api.workspace.edits.length, 1);
    assert.strictEqual(doc.version, 2);
  });

  test('golden: Add Missing Cases inserts the clause at the first blank line after g (F15)', async () => {
    const api = new FakeEditingApi();
    const doc = api.workspace.open(docOf('Part.idr'));
    await applyReplacements(api.asApi(), doc as never, 1, [r(4, 0, 4, 0, 'g (S _) = ?g_missing_case_1\n')]);
    assert.strictEqual(doc.text, fixture('Part.idr').replace('g 0 = 0\n', 'g 0 = 0\ng (S _) = ?g_missing_case_1\n'));
  });

  test('a CRLF document gets CRLF line breaks', async () => {
    const api = new FakeEditingApi();
    const doc = api.workspace.open(new FakeTextDoc({ fileName: '/w/C.idr', text: 'f : Nat -> Nat\r\nf n = ?h', eol: 'CRLF' }));
    await applyReplacements(api.asApi(), doc as never, 1, [r(1, 0, 1, 8, 'f 0 = ?h_0\nf (S k) = ?h_1')]);
    assert.strictEqual(api.workspace.edits[0].entries[0].text, 'f 0 = ?h_0\r\nf (S k) = ?h_1');
  });

  test('the version check: a document changed since the request is not edited; a change while applyEdit runs is refused by it', async () => {
    const api = new FakeEditingApi();
    const doc = api.workspace.open(docOf('Clean.idr', { version: 5 }));
    const before = doc.text;
    const replacement = r(7, 10, 7, 19, '0');
    assert.deepStrictEqual(await applyReplacements(api.asApi(), doc as never, 4, [replacement]), { kind: 'changed' });
    assert.strictEqual(api.workspace.edits.length, 0);
    api.workspace.beforeApply = () => api.workspace.type(doc, new FakeRange(0, 12, 0, 12), ' ');
    assert.deepStrictEqual(await applyReplacements(api.asApi(), doc as never, 5, [replacement]), { kind: 'changed' });
    assert.strictEqual(doc.text, before.replace('module Clean', 'module Clean '));
  });

  test('closed, not fitting, or changing nothing: not applied, and said so', async () => {
    const api = new FakeEditingApi();
    const doc = api.workspace.open(docOf('Clean.idr'));
    assert.deepStrictEqual(await applyReplacements(api.asApi(), doc as never, 1, [r(7, 10, 7, 30, '0')]), {
      kind: 'invalid',
      reason: 'the range 7:10–7:30 is not in the document',
    });
    assert.deepStrictEqual(await applyReplacements(api.asApi(), doc as never, 1, [r(7, 10, 7, 19, '?vlen_rhs')]), { kind: 'unchanged' });
    assert.strictEqual(api.workspace.edits.length, 0);
    api.workspace.close(doc);
    assert.deepStrictEqual(await applyReplacements(api.asApi(), doc as never, 1, [r(7, 10, 7, 19, '0')]), { kind: 'closed' });
  });
});

suite('features/editing: messages', () => {
  test('the titles are package.json\'s, every editing command is contributed, and each asks for its EditKind', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string; title: string }[] };
    };
    for (const [id, title] of Object.entries(EDITING_COMMAND_TITLES)) {
      assert.strictEqual(manifest.contributes.commands.find((c) => c.command === id)?.title, title, id);
    }
    assert.deepStrictEqual(Object.keys(EDITING_COMMAND_TITLES).sort(), Object.keys(EDITING_COMMAND_KINDS).sort());
    assert.strictEqual(commandName('idris2.refineHole'), 'Refine Hole');
  });

  test('failureText: the known errors rephrased (F15), the others as the compiler sent them', () => {
    assert.strictEqual(
      failureText('idris2.caseSplit', 'No clause to split here', false),
      'Idris 2: Case Split: this clause has no hole to split on. Case Split needs a clause whose right-hand side is a hole, such as "f xs = ?rhs", with the cursor on a variable of its left-hand side.',
    );
    assert.match(failureText('idris2.generateDefinition', 'Already defined', false), /already has clauses/);
    assert.match(failureText('idris2.proofSearch', 'No search results', false), /found no expression/);
    // A hole named as another definition in scope (`?length`) [live].
    for (const [command, message] of [
      ['idris2.intro', 'Could not find hole named length'],
      ['idris2.refineHole', 'Could not find hole named length'],
      ['idris2.proofSearch', 'Not a searchable hole'],
      ['idris2.makeLemma', 'Can\'t make lifted definition'],
    ] as const) {
      assert.match(failureText(command, message, false), /another definition in scope has this hole's name/, command);
    }
    assert.strictEqual(failureText('idris2.makeCase', 'Not a searchable hole', false), 'Idris 2: Make Case: Not a searchable hole');
    // Only for its command, and only the whole message.
    assert.strictEqual(failureText('idris2.addClause', 'No clause to split here', false), 'Idris 2: Add Clause: No clause to split here');
    assert.strictEqual(failureText('idris2.caseSplit', 'Can\'t split on nope (Can\'t find type of nope in LHS)', false), 'Idris 2: Case Split: Can\'t split on nope (Can\'t find type of nope in LHS)');
  });

  test('failureText: an unknown compiler error, in both forms, is one line without its (Interactive) block, invisible characters written out, cut', () => {
    const message = `x‮${'y'.repeat(400)}\n\n(Interactive):1:1--1:4\n 1 | foo`;
    for (const loadFailed of [false, true]) {
      const text = failureText('idris2.refineHole', message, loadFailed);
      assert.ok(text.endsWith('…'), text);
      assert.ok(text.includes('x\\u{202E}y'), text);
      assert.ok(!text.includes('(Interactive)') && !text.includes('\n'), text);
    }
  });

  test('failureText after a load with errors: the advice first, never a rephrasing that blames the clause (F16 contradicted)', () => {
    assert.strictEqual(
      failureText('idris2.caseSplit', 'No clause to split here', true),
      'Idris 2: Case Split: the file did not load cleanly — fix the first error and save, then run Case Split again. The compiler answered: No clause to split here',
    );
    assert.match(failureText('idris2.addClause', 'before not defined here', true), /did not load cleanly.*before not defined here$/);
  });

  test('refusalText: the command name once, whether or not the reason starts with it', () => {
    assert.strictEqual(refusalText('Case Split', 'Case Split: this line has no hole to split on.'), 'Idris 2: Case Split: this line has no hole to split on.');
    assert.strictEqual(refusalText('Add Clause', 'Add Clause needs the cursor on …'), 'Idris 2: Add Clause needs the cursor on …');
    assert.strictEqual(refusalText('Intro', 'Only a file saved on disk can be edited.'), 'Idris 2: Intro: Only a file saved on disk can be edited.');
    // A name that merely starts the reason's first word is not the command's name.
    assert.strictEqual(refusalText('Intro', 'Introduction failed.'), 'Idris 2: Intro: Introduction failed.');
  });

  test('compilerText: without the (Interactive) location block, one line, invisible characters written out, cut', () => {
    const ambiguous = 'When unifying:\n    Bool\nand:\n    Nat\nMismatch between: Bool and Nat.\n\n(Interactive):1:1--1:5\n 1 | module Edits\n     ^^^^\n';
    assert.strictEqual(compilerText(ambiguous), 'When unifying: Bool and: Nat Mismatch between: Bool and Nat.');
    assert.strictEqual(compilerText('Undefined name \u202Enope. \n\n(Interactive):1:1--1:5\n 1 | x'), 'Undefined name \\u{202E}nope.');
    assert.strictEqual(compilerText('x'.repeat(1000)).length, MAX_COMPILER_TEXT);
  });

  test('compilerText cuts where the regular expression it replaced did, in linear time', () => {
    const before = (message: string): number => message.search(/\n\s*\n\(Interactive\):/u);
    const block = '(Interactive):1:1--1:5';
    for (const message of ['a\n\n' + block, 'a\n \n\t\n' + block, 'a\n' + block, 'a \n' + block + '\n\n' + block, 'a\n\nb\n' + block, block, '\n\n' + block, 'a\n\n(Interactive)']) {
      const cut = before(message);
      assert.strictEqual(compilerText(message), editorLabel(cut < 0 ? message : message.slice(0, cut), MAX_COMPILER_TEXT), JSON.stringify(message));
    }
    const started = process.hrtime.bigint();
    compilerText(`x${'\n'.repeat(200_000)}y`);
    assert.ok(process.hrtime.bigint() - started < 200_000_000n, 'more than 200 ms');
  });
});

// -------------------------------------------------------------------------------------------
// The command flow
// -------------------------------------------------------------------------------------------

/** A registered editing feature over one fake backend, with Clean.idr open at `line:character`. */
function setUp(file = 'Clean.idr', line = 7, character = 12) {
  const api = new FakeEditingApi();
  const backend = new FakeEditBackend();
  const env = editingDeps(backend);
  const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true, cancelOfferMs: 60_000 });
  const doc = api.workspace.open(docOf(file));
  api.window.showAt(doc, line, character);
  const run = async (id: EditingCommandId, args?: unknown) => {
    const before = registration.outcomes.length;
    await api.run(id, args);
    return registration.outcomes.slice(before);
  };
  return { api, backend, env, registration, doc, run };
}

const edit = (...replacements: TextReplacement[]): Promise<EditResult> => Promise.resolve({ type: 'edit', replacements });
const rep = (sl: number, sc: number, el: number, ec: number, text: string): TextReplacement => ({ range: range(sl, sc, el, ec), text });

suite('features/editing: the commands (commands.ts)', () => {
  test('Case Split at `xs`: asks for the variable at its token\'s start with the document\'s version, applies the answer as one edit of that document', async () => {
    const t = setUp('Clean.idr', 7, 6);
    t.backend.answer = () => edit(rep(7, 0, 7, 19, 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1'));
    assert.deepStrictEqual(await t.run('idris2.caseSplit'), [{ command: 'idris2.caseSplit', kind: 'applied', uri: t.doc.uri.toString() }]);
    const [req] = t.backend.requests;
    assert.strictEqual(req.kind, 'caseSplit');
    assert.deepStrictEqual({ doc: req.doc, version: req.version, name: 'name' in req ? req.name : '', pos: 'pos' in req ? { ...req.pos } : undefined }, {
      doc: t.doc,
      version: 1,
      name: 'xs',
      pos: { line: 7, character: 5 },
    });
    assert.strictEqual(req.token, undefined); // a short request
    assert.deepStrictEqual(t.doc.lines.slice(7), ['vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1', '']);
    assert.strictEqual(t.api.workspace.edits.length, 1);
    assert.deepStrictEqual(t.api.window.windowProgress, ['Idris 2: Case Split…']);
    assert.deepStrictEqual(t.env.queries.runs, ['command']);
  });

  test('each command sends its kind, name and place (the table of types.ts)', async () => {
    const cases: [EditingCommandId, number, number, Partial<EditRequest> & Record<string, unknown>][] = [
      ['idris2.addClause', 4, 3, { kind: 'addClause', name: 'append' }],
      ['idris2.generateDefinition', 4, 3, { kind: 'generateDef', name: 'append' }],
      ['idris2.makeLemma', 7, 12, { kind: 'makeLemma', name: 'vlen_rhs' }],
      ['idris2.makeWith', 7, 12, { kind: 'makeWith', name: 'vlen_rhs' }],
      ['idris2.makeCase', 7, 12, { kind: 'makeCase', name: 'vlen_rhs' }],
      ['idris2.proofSearch', 7, 12, { kind: 'exprSearch', name: 'vlen_rhs', hints: [] }],
      ['idris2.intro', 7, 12, { kind: 'intro', name: 'vlen_rhs' }],
    ];
    for (const [id, line, character, expected] of cases) {
      const t = setUp('Clean.idr', line, character);
      t.backend.answer = () => Promise.resolve({ type: 'failed', message: 'x' });
      await t.run(id);
      const req = t.backend.requests[0] as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(expected)) {
        assert.deepStrictEqual(req[key], value, `${id}: ${key}`);
      }
      const pos = req.pos as { line: number; character: number };
      assert.deepStrictEqual({ line: pos.line, character: pos.character }, line === 4 ? { line: 4, character: 0 } : { line: 7, character: 10 }, id);
    }
  });

  test('Case Split and Make With in a clause whose left-hand side starts on an earlier line: a message, and nothing asked', async () => {
    for (const [id, line, character] of [['idris2.caseSplit', 47, 2], ['idris2.makeWith', 47, 8], ['idris2.caseSplit', 17, 5]] as const) {
      const t = setUp(line === 17 ? 'Edits.idr' : 'Layout.idr', line, character);
      await t.run(id);
      assert.match(t.api.window.messages[0]?.text ?? '', /left-hand side starts on the line of its =/, id);
      assert.strictEqual(t.backend.requests.length, 0, id);
    }
    // Make Case rewrites the hole alone: it is asked.
    const t = setUp('Layout.idr', 47, 8);
    t.backend.answer = () => Promise.resolve({ type: 'failed', message: 'x' });
    await t.run('idris2.makeCase');
    assert.strictEqual(t.backend.requests.length, 1);
  });

  test('Add Clause and Generate Definition on a %foreign or %extern function: a message, and nothing asked', async () => {
    for (const id of ['idris2.addClause', 'idris2.generateDefinition'] as const) {
      const t = setUp('Clean.idr', 1, 2);
      const doc = t.api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Ffi.idr', text: 'module Ffi\n\n%foreign "C:puts,libc"\nprim__puts : String -> PrimIO Int\n' }));
      t.api.window.showAt(doc, 3, 2);
      await t.run(id);
      assert.match(t.api.window.messages[0]?.text ?? '', /not available on a %foreign or %extern function/, id);
      assert.strictEqual(t.backend.requests.length, 0, id);
    }
  });

  test('nothing to act on, no Idris editor, Restricted Mode, a file not on disk, a fenced literate file: a message, and nothing asked', async () => {
    const t = setUp('Clean.idr', 0, 2);
    assert.match((await t.run('idris2.makeLemma'))[0].kind === 'message' ? t.api.window.messages[0].text : '', /put the cursor on a hole/);
    t.api.window.activeTextEditor = undefined;
    assert.strictEqual((await t.run('idris2.caseSplit'))[0].kind, 'message');
    t.api.window.showAt(t.doc, 7, 12);
    t.env.settings.trusted = false;
    assert.match(JSON.stringify(await t.run('idris2.proofSearch')), /Restricted Mode/);
    t.env.settings.trusted = true;
    const untitled = t.api.workspace.open(new FakeTextDoc({ fileName: 'Untitled-1', text: 'f = ?h', scheme: 'untitled' }));
    t.api.window.showAt(untitled, 0, 5);
    assert.match(JSON.stringify(await t.run('idris2.intro')), /saved on disk/);
    const md = t.api.workspace.open(new FakeTextDoc({ fileName: '/w/F.idr.md', text: '```idris\nf = ?h\n```', languageId: 'markdown' }));
    t.api.window.showAt(md, 1, 5);
    assert.match(JSON.stringify(await t.run('idris2.intro')), /\.idr files and bird-track \.lidr files only/);
    assert.strictEqual(t.backend.requests.length, 0);
    assert.strictEqual(t.env.queries.runs.length, 0);
  });

  test('a code action\'s argument: acts only on the open document it names, at its position, and only while the name there is the one offered', async () => {
    const t = setUp('Clean.idr', 0, 0);
    t.backend.answer = () => edit(rep(7, 10, 7, 19, '0'));
    const uri = t.doc.uri.toString();
    // Not open: nothing opened, nothing asked.
    const other = await t.run('idris2.proofSearch', { uri: 'file:///w/broken/Mixed.idr', position: { line: 0, character: 0 }, name: 'x' });
    assert.match(JSON.stringify(other), /not open any more/);
    // Names that are not what the text holds there — a hostile argument — are refused before anything is sent.
    for (const [id, line, character, name] of [
      ['idris2.addMissingCases', 6, 0, 'vlen\n:exec main'],
      ['idris2.caseSplit', 7, 5, 'xs" 1 "") 2) ((:interpret ":exec main'],
      ['idris2.makeLemma', 7, 12, ':exec main'],
      ['idris2.intro', 7, 12, 'vlen_rhs ?x'],
      ['idris2.generateDefinition', 4, 0, 'append\n:exec main'],
    ] as const) {
      const outcomes = await t.run(id, { uri, position: { line, character }, name });
      assert.match(JSON.stringify(outcomes), /changed since/, `${id} ${name}`);
    }
    assert.strictEqual(t.backend.requests.length, 0);
    // The offered name: applied at that position, whatever the cursor.
    assert.deepStrictEqual(await t.run('idris2.proofSearch', { uri, position: { line: 7, character: 10 }, name: 'vlen_rhs' }), [
      { command: 'idris2.proofSearch', kind: 'applied', uri },
    ]);
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 0');
  });

  test('an argument that is not a code action\'s (the URI the editor title\'s menu passes) is ignored: the active editor\'s cursor', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = () => edit(rep(7, 10, 7, 19, '0'));
    assert.strictEqual((await t.run('idris2.proofSearch', t.doc.uri))[0].kind, 'applied');
    for (const bad of [{ uri: 'x', position: { line: -1, character: 0 }, name: 'h' }, { uri: 'x', position: { line: 0.5, character: 0 }, name: 'h' }, null, 7]) {
      const t2 = setUp('Clean.idr', 0, 2);
      assert.match(JSON.stringify(await t2.run('idris2.makeCase', bad)), /put the cursor on a hole/);
    }
  });

  test('the version check: the document changed while the compiler worked — the answer is discarded with a message, the user\'s change kept', async () => {
    const t = setUp('Clean.idr', 7, 5);
    t.backend.answer = () => {
      t.api.workspace.type(t.doc, new FakeRange(0, 12, 0, 12), ' ');
      return edit(rep(7, 0, 7, 19, 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1'));
    };
    const outcomes = await t.run('idris2.caseSplit');
    assert.match(JSON.stringify(outcomes), /the file changed while the compiler worked/);
    assert.strictEqual(t.doc.text, fixture('Clean.idr').replace('module Clean', 'module Clean '));
    assert.strictEqual(t.api.workspace.edits.length, 0);
  });

  test('closed while the compiler worked: nothing changed, said so', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = () => {
      t.api.workspace.close(t.doc);
      return edit(rep(7, 10, 7, 19, '0'));
    };
    assert.match(JSON.stringify(await t.run('idris2.proofSearch')), /closed/);
    assert.strictEqual(t.api.workspace.edits.length, 0);
  });

  test('failed: rephrased, with the advice when the file\'s last load reported errors (CheckStatusSource); unavailable: the reason', async () => {
    const t = setUp('Clean.idr', 7, 6);
    t.backend.answer = () => Promise.resolve({ type: 'failed', message: 'No clause to split here' });
    assert.match(JSON.stringify(await t.run('idris2.caseSplit')), /this clause has no hole to split on/);
    t.env.settings.status = { kind: 'checked', errors: 1, warnings: 0, stale: false, known: true };
    assert.match(JSON.stringify(await t.run('idris2.caseSplit')), /did not load cleanly/);
    t.env.settings.status = { kind: 'packageError', ipkg: '/w/a.ipkg', message: 'x', stale: false };
    assert.match(JSON.stringify(await t.run('idris2.caseSplit')), /did not load cleanly/);
    t.env.settings.status = { kind: 'checked', errors: 0, warnings: 2, stale: false, known: true };
    assert.match(JSON.stringify(await t.run('idris2.caseSplit')), /no hole to split on/);
    t.backend.answer = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'Below a line of a marker and a space the compiler numbers lines otherwise.' }));
    assert.match(JSON.stringify(await t.run('idris2.caseSplit')), /Case Split: Below a line/);
    assert.strictEqual(t.api.window.messages.at(-1)?.severity, 'warning');
  });

  test('a refusal that quotes a file name is shown as one line: control and bidi characters written out, no link', async () => {
    const t = setUp('Clean.idr', 7, 6);
    t.backend.answer = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'a\u202Eb.idr\nis not the file [x](command:y)' }));
    await t.run('idris2.caseSplit');
    assert.strictEqual(t.api.window.messages.at(-1)?.text, 'Idris 2: Case Split: a\\u{202E}b.idr is not the file [x]\u200b(command:y)');
  });

  test('NotLoaded: the file is loaded and asked again, with the same version', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = (_req, n) =>
      n === 0 ? Promise.reject(new IdrisException({ kind: 'NotLoaded', message: 'not loaded', file: t.doc.fileName })) : edit(rep(7, 10, 7, 19, '0'));
    assert.strictEqual((await t.run('idris2.makeCase'))[0].kind, 'applied');
    assert.strictEqual(t.env.queries.loads, 1);
    assert.deepStrictEqual(t.backend.requests.map((r) => r.version), [1, 1]);
  });

  test('NotLoaded after the document changed since its version (typed into while its check ran): not loaded and asked again in vain, but said (UX review of M4\'s eighth round)', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = () => {
      t.doc.version += 1;
      return Promise.reject(new IdrisException({ kind: 'NotLoaded', message: 'does not show the text the compiler loaded', file: t.doc.fileName }));
    };
    await t.run('idris2.makeCase');
    assert.strictEqual(t.backend.requests.length, 1, 'not asked again');
    assert.strictEqual(t.api.window.messages.at(-1)?.text, 'Idris 2: the file changed while it was being checked for Make Case, so the compiler was not asked. Run Make Case again.');
  });

  test('Add Missing Cases runs as a long request (a token, the Cancel offer): for a name it does not know, the compiler looks for similar ones first', async () => {
    const t = setUp('Part.idr', 2, 0);
    t.backend.answer = () => Promise.resolve({ type: 'failed', message: 'Part.g: All cases covered' });
    await t.run('idris2.addMissingCases');
    assert.strictEqual(t.backend.requests[0]?.kind, 'addMissingCases');
    assert.ok(t.backend.requests[0]?.token !== undefined);
  });

  test('Intro: a single candidate is applied without asking; two go to a QuickPick of their labels (untrusted text), the chosen one applied; closing it cancels', async () => {
    const t = setUp('Clean.idr', 7, 12);
    const choice = (label: string) => ({ label, replacements: [rep(7, 10, 7, 19, label)] });
    t.backend.answer = () => Promise.resolve({ type: 'choices', reason: 'intro', choices: [choice('(?a, ?b)')] });
    assert.strictEqual((await t.run('idris2.intro'))[0].kind, 'applied');
    assert.strictEqual(t.api.window.quickPicks.length, 0);
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = (?a, ?b)');

    const t2 = setUp('Clean.idr', 7, 12);
    t2.backend.answer = () => Promise.resolve({ type: 'choices', reason: 'intro', choices: [choice('0'), choice('S $(x) ?vlen_rhs_0\u202E')] });
    t2.api.window.pick = 1;
    assert.strictEqual((await t2.run('idris2.intro'))[0].kind, 'applied');
    assert.deepStrictEqual(t2.api.window.quickPicks[0].labels, ['0', 'S $\u200B(x) ?vlen_rhs_0\\u{202E}']);
    assert.strictEqual(t2.doc.lineAt(7).text, 'vlen xs = S $(x) ?vlen_rhs_0\u202E');
    t2.api.window.pick = undefined;
    t2.api.window.showAt(t2.doc, 7, 18); // on the hole ?vlen_rhs_0, which U+202E, an identifier character, continues
    t2.backend.answer = () => Promise.resolve({ type: 'choices', reason: 'intro', choices: [choice('0'), choice('1')] });
    const edited = t2.doc.text;
    assert.deepStrictEqual(await t2.run('idris2.intro'), [{ command: 'idris2.intro', kind: 'cancelled' }]);
    assert.strictEqual(t2.doc.text, edited);
  });

  test('Refine Hole…: the expression from the input box goes into the request\'s hint only; Escape cancels; blank text is refused; ambiguity → QuickPick', async () => {
    const t = setUp('Ambig.idr', 13, 6);
    t.api.window.inputAnswer = undefined;
    assert.deepStrictEqual(await t.run('idris2.refineHole'), [{ command: 'idris2.refineHole', kind: 'cancelled' }]);
    assert.match(t.api.window.inputBoxes[0].prompt ?? '', /^Idris 2: refine \?g_rhs with an expression/);
    assert.strictEqual(t.api.window.inputBoxes[0].ignoreFocusOut, true, 'kept open while the user reads the hole elsewhere');
    t.api.window.inputAnswer = '  ';
    assert.match(JSON.stringify(await t.run('idris2.refineHole')), /needs an expression/);
    assert.strictEqual(t.backend.requests.length, 0);
    t.api.window.inputAnswer = 'foo") 1) ((:interpret ":exec main';
    t.backend.answer = () =>
      Promise.resolve({
        type: 'choices',
        reason: 'ambiguous',
        choices: [
          { label: 'Ambig.A.foo ?g_rhs_0', replacements: [rep(13, 4, 13, 10, 'Ambig.A.foo ?g_rhs_0')] },
          { label: 'Ambig.B.foo ?g_rhs_0', replacements: [rep(13, 4, 13, 10, 'Ambig.B.foo ?g_rhs_0')] },
        ],
      });
    t.api.window.pick = 0;
    assert.strictEqual((await t.run('idris2.refineHole'))[0].kind, 'applied');
    const req = t.backend.requests[0];
    assert.ok(req.kind === 'refine');
    assert.strictEqual(req.hint, 'foo") 1) ((:interpret ":exec main');
    assert.strictEqual(req.name, 'g_rhs');
    assert.deepStrictEqual(t.api.window.quickPicks[0].labels, ['Ambig.A.foo ?g_rhs_0', 'Ambig.B.foo ?g_rhs_0']);
    assert.strictEqual(t.doc.lineAt(13).text, 'g = Ambig.A.foo ?g_rhs_0');
  });

  test('the input box\'s prompt and the QuickPick\'s labels quote at most MAX_SHOWN characters of a name or a choice', async () => {
    const t = setUp('Clean.idr', 7, 12);
    const long = `?vlen_rhs${'x'.repeat(100_000)}`;
    const lengthen = new FakeWorkspaceEdit();
    lengthen.replace(t.doc.uri, new FakeRange(7, 10, 7, 19), long);
    assert.ok(await t.api.workspace.applyEdit(lengthen));
    t.api.window.inputAnswer = undefined;
    await t.run('idris2.refineHole');
    const prompt = t.api.window.inputBoxes[0].prompt ?? '';
    assert.ok(prompt.length < MAX_SHOWN + 100 && prompt.includes('…'), `${prompt.length}`);
    const t2 = setUp('Clean.idr', 7, 12);
    t2.backend.answer = () => Promise.resolve({ type: 'choices', reason: 'intro', choices: ['0', `S ${'y'.repeat(100_000)}`].map((label) => ({ label, replacements: [rep(7, 10, 7, 19, label)] })) });
    t2.api.window.pick = undefined;
    await t2.run('idris2.intro');
    assert.deepStrictEqual(t2.api.window.quickPicks[0].labels.map((l) => l.length <= MAX_SHOWN), [true, true]);
  });

  test('Add Missing Cases: the function of a coverage error on the cursor\'s lines, else the declaration at the cursor; nothing elsewhere', async () => {
    const t = setUp('Part.idr', 2, 9);
    t.api.diagnostics = [{ range: new FakeRange(2, 0, 2, 14), message: 'g is not covering.\n\nMissing cases:\n    g (S _)', source: 'idris2' }];
    t.backend.answer = () => edit(rep(4, 0, 4, 0, 'g (S _) = ?g_missing_case_1\n'));
    assert.strictEqual((await t.run('idris2.addMissingCases'))[0].kind, 'applied');
    assert.deepStrictEqual(t.doc.lines.slice(2, 6), ['g : Nat -> Nat', 'g 0 = 0', 'g (S _) = ?g_missing_case_1', '']);
    const req = t.backend.requests[0];
    assert.ok(req.kind === 'addMissingCases' && req.name === 'g' && req.pos.line === 2 && req.pos.character === 0);
    // Without a coverage error: the declaration at the cursor (a partial function).
    const e = setUp('Edits.idr', 91, 2);
    e.backend.answer = () => Promise.resolve({ type: 'failed', message: 'x' });
    await e.run('idris2.addMissingCases');
    assert.strictEqual(e.backend.requests[0].kind === 'addMissingCases' ? e.backend.requests[0].name : '', 'both');
    // On a clause, without a coverage error there: nothing.
    const c = setUp('Clean.idr', 7, 2);
    assert.match(JSON.stringify(await c.run('idris2.addMissingCases')), /is not covering/);
    assert.strictEqual(c.backend.requests.length, 0);
  });

  test('answers that change nothing or do not fit are not applied, and said so (no silent no-op)', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = () => edit();
    assert.match(JSON.stringify(await t.run('idris2.makeCase')), /changes nothing/);
    t.backend.answer = () => edit(rep(7, 0, 7, 19, 'vlen xs = ?vlen_rhs'));
    assert.match(JSON.stringify(await t.run('idris2.makeCase')), /leaves the file as it is/);
    t.backend.answer = () => edit(rep(7, 0, 9, 0, 'x'));
    assert.match(JSON.stringify(await t.run('idris2.makeCase')), /does not fit the file \(the range 7:0–9:0 is not in the document\)/);
    assert.ok(t.env.logged.some((l) => l.startsWith('warn Make Case in /w/broken/Clean.idr: the answer does not fit')));
    t.backend.answer = () => Promise.resolve({ type: 'choices', reason: 'intro', choices: [] });
    assert.match(JSON.stringify(await t.run('idris2.intro')), /offered nothing/);
    assert.strictEqual(t.api.workspace.edits.length, 0);
    assert.strictEqual(t.doc.text, fixture('Clean.idr'));
  });

  test('a handler never rejects: an unexpected error is logged and shown as plain text', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = () => Promise.reject(new Error('boom [x](command:y)'));
    await t.run('idris2.makeCase');
    const shown = t.api.window.messages.at(-1);
    assert.strictEqual(shown?.severity, 'error');
    assert.strictEqual(shown?.text, 'Idris 2: Make Case failed: boom [x]\u200B(command:y)');
    assert.ok(t.env.logged.includes('error Make Case failed: boom [x](command:y)'));
  });

  test('a long request (Proof Search) runs with a token; Cancel in the notification cancels it, and the command is cancelled', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true, cancelOfferMs: 0 });
    const doc = api.workspace.open(docOf('Clean.idr'));
    api.window.showAt(doc, 7, 12);
    backend.answer = (req) =>
      new Promise((_resolve, reject) => {
        req.token?.onCancellationRequested(() => reject(cancelled('Cancelled')));
      });
    const running = api.run('idris2.proofSearch');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(api.window.notifications.map((n) => [n.title, n.cancellable]), [['Idris 2: Proof Search is still running. Cancel stops it; a check of the file already running finishes first.', true]]);
    api.window.notifications[0].cancel();
    await running;
    assert.deepStrictEqual(registration.outcomes, [{ command: 'idris2.proofSearch', kind: 'cancelled' }]);
    assert.strictEqual(doc.text, fixture('Clean.idr'));
  });

  test('Refine Hole runs as a long request: a token and the Cancel offer; Cancel ends the command at once even while the request goes on (UX review of M4)', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true, cancelOfferMs: 0 });
    const doc = api.workspace.open(docOf('Clean.idr'));
    api.window.showAt(doc, 7, 12);
    api.window.inputAnswer = 'S';
    // A request that ignores the token, as a load made before it does (DocumentQueries.run).
    let finish: (result: EditResult) => void = () => undefined;
    backend.answer = () => new Promise((resolve) => (finish = resolve));
    const running = api.run('idris2.refineHole');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(backend.requests[0]?.token !== undefined);
    assert.deepStrictEqual(api.window.notifications.map((n) => [n.title, n.cancellable, n.closed]), [
      ['Idris 2: Refine Hole is still running. Cancel stops it; a check of the file already running finishes first.', true, false],
    ]);
    api.window.notifications[0].cancel();
    // The command ends at Cancel, not when the request does: the file is free for the next command.
    await running;
    assert.strictEqual(api.window.notifications[0].closed, true);
    assert.deepStrictEqual(registration.outcomes, [{ command: 'idris2.refineHole', kind: 'cancelled' }]);
    backend.answer = () => Promise.resolve({ type: 'edit', replacements: [{ range: range(7, 10, 7, 19), text: '0' }] });
    await api.run('idris2.makeCase');
    assert.ok(!api.window.messages.some((m) => /still running/.test(m.text)), JSON.stringify(api.window.messages));
    assert.deepStrictEqual(registration.outcomes.at(-1), { command: 'idris2.makeCase', kind: 'applied', uri: doc.uri.toString() });
    // The cancelled request's late answer is dropped.
    finish({ type: 'edit', replacements: [{ range: range(7, 10, 7, 11), text: 'S ?vlen_rhs_0' }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(doc.lineAt(7).text, 'vlen xs = 0');
  });

  test('Intro and Make Lemma run as long requests (a token and the Cancel offer); Make Case does not', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = () => Promise.resolve({ type: 'failed', message: 'no' });
    for (const command of ['idris2.intro', 'idris2.makeLemma', 'idris2.makeCase'] as const) {
      await t.run(command);
    }
    assert.deepStrictEqual(t.backend.requests.map((r) => r.token !== undefined), [true, true, false]);
  });

  test('a code action\'s argument naming an open document that is not an Idris file: "not open any more", nothing saved or asked', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true });
    const notes = api.workspace.open(new FakeTextDoc({ fileName: '/w/notes.txt', text: 'f = ?h\n', languageId: 'plaintext', isDirty: true }));
    await api.run('idris2.makeLemma', { uri: notes.uri.toString(), position: { line: 0, character: 4 }, name: 'h' });
    assert.deepStrictEqual(registration.outcomes, [{ command: 'idris2.makeLemma', kind: 'message', message: 'Idris 2: the file Make Lemma was offered for is not open any more.' }]);
    assert.strictEqual(notes.saves, 0);
    assert.strictEqual(backend.requests.length, 0);
  });

  test('messages are plain text: a name with a link is not a link, invisible characters written out', async () => {
    const t = setUp('Clean.idr', 7, 12);
    t.backend.answer = () => Promise.resolve({ type: 'failed', message: 'Unknown name [x](command:workbench.action.terminal.sendSequence)\u202E' });
    await t.run('idris2.intro');
    assert.strictEqual(t.api.window.messages[0].text, 'Idris 2: Intro: Unknown name [x]\u200B(command:workbench.action.terminal.sendSequence)\\u{202E}');
  });
});
