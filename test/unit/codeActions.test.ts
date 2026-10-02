// features/editing/codeActions.ts and its provider (register.ts): the light bulbs of the editing
// commands, from the text alone (nothing is sent), under idris2-lsp's filter keys (F34), each
// carrying its command and argument and no edit; the quick fix Add Missing Cases on a coverage error
// (F15, F28); nothing in Restricted Mode, for a file not on disk, or without the capability.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AFTER_FAILED_LOAD, CASE_SPLIT_LINE, CRLF_LITERATE, EDITING_ACTION_KINDS, editingActionsAt, MAKE_CASE_NOT_FIRST, NUL_LINE, type EditingAction } from '../../src/features/editing/codeActions';
import { MAX_SHOWN } from '../../src/features/editing/messages';
import { BACKEND_FAILED, registerEditing } from '../../src/features/editing/register';
import { repoRoot } from '../fake-tools/paths';
import { editingDeps, FakeCodeActionKind, FakeEditBackend, FakeEditingApi, FakePosition, FakeRange, FakeTextDoc, range } from './support/editingFakes';

const fixture = (name: string): string => fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'broken', name), 'utf8');
const docOf = (name: string): FakeTextDoc => new FakeTextDoc({ fileName: `/w/broken/${name}`, text: fixture(name) });
const ALL = { editing: true, intro: true, refine: true, missingCases: true };
const COVERAGE = { range: range(2, 0, 2, 14), message: 'g is not covering.\n\nMissing cases:\n    g (S _)', source: 'idris2' };

suite('features/editing: code actions', () => {
  const clean = docOf('Clean.idr');
  const uri = clean.uri.toString();

  test('at a hole: Proof Search, Intro, Refine Hole…, Make Lemma, Make With, Make Case, each with its command, its argument and its kind', () => {
    const actions = editingActionsAt(clean, { line: 7, character: 14 }, ALL, []);
    const args = { uri, position: { line: 7, character: 10 }, name: 'vlen_rhs' };
    assert.deepStrictEqual(actions, [
      { title: 'Proof Search for ?vlen_rhs', kind: 'refactor.rewrite.ExprSearch', command: 'idris2.proofSearch', args },
      { title: 'Intro for ?vlen_rhs', kind: 'refactor.rewrite.Intro', command: 'idris2.intro', args },
      { title: 'Refine ?vlen_rhs…', kind: 'refactor.rewrite.RefineHole', command: 'idris2.refineHole', args },
      { title: 'Make Lemma for ?vlen_rhs', kind: 'refactor.extract.MakeLemma', command: 'idris2.makeLemma', args },
      { title: 'Make With for ?vlen_rhs', kind: 'refactor.rewrite.MakeWith', command: 'idris2.makeWith', args },
      { title: 'Make Case for ?vlen_rhs', kind: 'refactor.rewrite.MakeCase', command: 'idris2.makeCase', args },
    ]);
    // Without a capability, its actions are not offered.
    assert.deepStrictEqual(
      editingActionsAt(clean, { line: 7, character: 14 }, { ...ALL, intro: false, refine: false }, []).map((a) => a.kind),
      ['refactor.rewrite.ExprSearch', 'refactor.extract.MakeLemma', 'refactor.rewrite.MakeWith', 'refactor.rewrite.MakeCase'],
    );
    assert.deepStrictEqual(editingActionsAt(clean, { line: 7, character: 14 }, { ...ALL, editing: false }, []).map((a) => a.kind), [
      'refactor.rewrite.Intro',
      'refactor.rewrite.RefineHole',
    ]);
  });

  test('at a pattern variable: Case Split where it is offered; at a type declaration that no clause follows: Add Clause and Generate Definition', () => {
    assert.deepStrictEqual(editingActionsAt(clean, { line: 7, character: 6 }, ALL, []), [
      { title: 'Case Split on xs', kind: 'refactor.rewrite.CaseSplit', command: 'idris2.caseSplit', args: { uri, position: { line: 7, character: 5 }, name: 'xs' } },
    ]);
    const edits = docOf('Edits.idr');
    assert.deepStrictEqual(editingActionsAt(edits, { line: 13, character: 6 }, ALL, []), []); // count xs = / ?count_rhs
    assert.deepStrictEqual(editingActionsAt(clean, { line: 4, character: 3 }, ALL, []), [
      { title: 'Add Clause for append', kind: 'refactor.rewrite.AddClause', command: 'idris2.addClause', args: { uri, position: { line: 4, character: 0 }, name: 'append' } },
      { title: 'Generate Definition of append', kind: 'refactor.rewrite.GenerateDef', command: 'idris2.generateDefinition', args: { uri, position: { line: 4, character: 0 }, name: 'append' } },
    ]);
    assert.deepStrictEqual(editingActionsAt(clean, { line: 6, character: 3 }, ALL, []), []); // vlen has a clause: its hole would be vlen_rhs again
    assert.deepStrictEqual(editingActionsAt(clean, { line: 0, character: 2 }, ALL, []), []); // module Clean
    assert.deepStrictEqual(editingActionsAt(clean, { line: 4, character: 3 }, { ...ALL, editing: false }, []), []);
  });

  test('the quick fix Add Missing Cases on each coverage error that lists missing cases, for the declaration it is on', () => {
    const part = docOf('Part.idr');
    const other = { range: range(5, 0, 5, 12), message: 'main is not covering.\n\nCalls non covering function Part.g', source: 'idris2' };
    const actions = editingActionsAt(part, { line: 2, character: 0 }, ALL, [COVERAGE, other]);
    assert.deepStrictEqual(actions.at(-1), {
      title: 'Add Missing Cases of g',
      kind: 'quickfix',
      command: 'idris2.addMissingCases',
      args: { uri: part.uri.toString(), position: { line: 2, character: 0 }, name: 'g' },
      diagnostic: COVERAGE,
    });
    assert.strictEqual(actions.filter((a) => a.kind === 'quickfix').length, 1);
    assert.deepStrictEqual(editingActionsAt(part, { line: 2, character: 0 }, { ...ALL, missingCases: false }, [COVERAGE]).filter((a) => a.kind === 'quickfix'), []);
  });

  test('none on a declaration of several names; no Make With in a clause whose left-hand side starts on an earlier line (edits-layout)', () => {
    const layout = docOf('Layout.idr');
    assert.deepStrictEqual(editingActionsAt(layout, { line: 40, character: 1 }, ALL, []), []); // pair, other : Nat -> Nat
    const several = { range: range(40, 0, 40, 24), message: 'pair is not covering.\n\nMissing cases:\n    pair (S _)', source: 'idris2' };
    assert.deepStrictEqual(editingActionsAt(layout, { line: 40, character: 1 }, ALL, [several]), []);
    // A pragma before the name: offered, as the backend sends it.
    assert.deepStrictEqual(editingActionsAt(layout, { line: 36, character: 9 }, ALL, []).map((a) => a.title), ['Add Clause for inl', 'Generate Definition of inl']);
    const kinds = (line: number, character: number): string[] => editingActionsAt(layout, { line, character }, ALL, []).map((a) => a.kind);
    assert.ok(!kinds(47, 8).includes('refactor.rewrite.MakeWith')); // above x / y = ?above_rhs
    assert.ok(kinds(43, 12).includes('refactor.rewrite.MakeWith')); // note xs = ?note_rhs -- …
  });

  test('Make With only where the backend sends it (core/idrisSyntax.ts withClauseStart); no quick fix for a function local to a definition', () => {
    const doc = new FakeTextDoc({
      fileName: '/w/M.idr',
      text: [
        'f : Nat -> IO Nat', // 0
        'f n = do', // 1
        '  let y = ?let_rhs', // 2
        '  pure y', // 3
        'g : Nat -> Nat', // 4
        'g x = S ?under_rhs', // 5
        'h : Nat -> Nat', // 6
        'h x = case x of', // 7
        '  Z => ?z_rhs', // 8
        'k : Nat -> Nat', // 9
        'k x =', // 10
        '  ?k_rhs', // 11
        'w : Nat -> Nat', // 12
        'w x = go x', // 13
        '  where', // 14
        '    go : Nat -> Nat', // 15
        '    go 0 = ?go_rhs', // 16
      ].join('\n'),
    });
    const makeWith = (line: number, character: number): boolean => editingActionsAt(doc, { line, character }, ALL, []).some((a) => a.kind === 'refactor.rewrite.MakeWith');
    assert.deepStrictEqual([makeWith(2, 11), makeWith(5, 10), makeWith(8, 8)], [false, false, false]); // let, an argument, a case alternative
    assert.deepStrictEqual([makeWith(11, 3), makeWith(16, 13)], [true, true]); // the hole on the line after the =; a where clause
    const coverage = { range: range(15, 4, 15, 19), message: 'w,go is not covering.\n\nMissing cases:\n    go (S _)', source: 'idris2' };
    assert.deepStrictEqual(editingActionsAt(doc, { line: 15, character: 4 }, ALL, [coverage]).filter((a) => a.kind === 'quickfix'), []);
    const bird = new FakeTextDoc({ fileName: '/w/L.lidr', text: '> f : Nat -> Nat\n> f x = ?f_rhs\n\n> g : Nat -> IO Nat\n> g n = do\n>   let y = ?g_rhs\n>   pure y' });
    assert.ok(editingActionsAt(bird, { line: 1, character: 9 }, ALL, []).some((a) => a.kind === 'refactor.rewrite.MakeWith'));
    assert.ok(!editingActionsAt(bird, { line: 5, character: 13 }, ALL, []).some((a) => a.kind === 'refactor.rewrite.MakeWith'));
  });

  test('after a check with errors, Case Split, Add Clause and Generate Definition are disabled with the reason; the others are not', async () => {
    const edits = docOf('Edits.idr');
    const disabled = (line: number, character: number): [string, string | undefined][] =>
      editingActionsAt(edits, { line, character }, ALL, [], true).map((a) => [a.command, a.disabled]);
    assert.deepStrictEqual(disabled(7, 1), [['idris2.addClause', AFTER_FAILED_LOAD], ['idris2.generateDefinition', AFTER_FAILED_LOAD]]); // zip3
    assert.deepStrictEqual(disabled(84, 7), [['idris2.caseSplit', AFTER_FAILED_LOAD]]); // primed x' = ?h'
    assert.ok(disabled(84, 13).every(([, reason]) => reason === undefined)); // the hole
    const part = docOf('Part.idr');
    assert.strictEqual(editingActionsAt(part, { line: 2, character: 0 }, ALL, [COVERAGE], true).find((a) => a.kind === 'quickfix')?.disabled, undefined);
    // The provider reads the check's status: errors in the text it read disable them; unsaved changes do not.
    const api = new FakeEditingApi();
    const env = editingDeps(new FakeEditBackend());
    registerEditing(api.asApi(), env.deps);
    const provide = async (): Promise<(string | undefined)[]> =>
      (await (api.provider as NonNullable<typeof api.provider>).provideCodeActions(edits, new FakeRange(7, 1, 7, 1), { diagnostics: [] })).map((a) => a.disabled?.reason);
    env.settings.status = { kind: 'checked', errors: 1, warnings: 0, stale: false, known: true };
    assert.deepStrictEqual(await provide(), [AFTER_FAILED_LOAD, AFTER_FAILED_LOAD]);
    env.settings.status = { kind: 'checked', errors: 1, warnings: 0, stale: true, known: true };
    assert.deepStrictEqual(await provide(), [undefined, undefined]);
    env.settings.status = { kind: 'checked', errors: 0, warnings: 2, stale: false, known: true };
    assert.deepStrictEqual(await provide(), [undefined, undefined]);
  });

  test('"Don\'t Allow" for the folder: no action (highlighting only); the compiler failed: every action disabled, Restart Backend named (UX review of M4)', async () => {
    const api = new FakeEditingApi();
    const env = editingDeps(new FakeEditBackend());
    registerEditing(api.asApi(), env.deps);
    const provider = api.provider as NonNullable<typeof api.provider>;
    const atHole = async () => (await provider.provideCodeActions(clean, new FakeRange(7, 12, 7, 12), { diagnostics: [] })).map((a) => a.disabled?.reason);
    assert.strictEqual((await atHole()).length, 6);
    env.settings.status = { kind: 'notAllowed', dir: '/w/broken', reason: 'denied' };
    assert.deepStrictEqual(await atHole(), []);
    // Not yet answered: running an action asks the question, so they stay.
    env.settings.status = { kind: 'notAllowed', dir: '/w/broken', reason: 'unanswered' };
    assert.deepStrictEqual(await atHole(), Array(6).fill(undefined));
    env.settings.status = { kind: 'backendFailed', reason: '4 unexpected ends within 5 min' };
    assert.deepStrictEqual(await atHole(), Array(6).fill(BACKEND_FAILED));
  });

  test('no action the backend would refuse unsent: Make Lemma in an interface or on a keyword hole, Add Missing Cases in a parameters block (Blocks.idr)', () => {
    const blocks = docOf('Blocks.idr');
    const titles = (line: number, character: number, diagnostics: typeof COVERAGE[] = []): string[] => editingActionsAt(blocks, { line, character }, ALL, diagnostics).map((a) => a.title);
    assert.ok(!titles(23, 12).some((t) => t.startsWith('Make Lemma'))); // interface Foo a where / foo x = ?default_rhs
    assert.ok(titles(13, 10).includes('Make Lemma for ?ns_rhs')); // namespace N
    assert.ok(titles(30, 10).includes('Make Lemma for ?pw_rhs')); // parameters (k : Nat)
    const f4 = { range: range(26, 2, 26, 15), message: 'f4 is not covering.\n\nMissing cases:\n    f4 _ B\n    f4 _ C', source: 'idris2' };
    assert.deepStrictEqual(titles(26, 2, [f4]).filter((t) => t.startsWith('Add Missing Cases')), []);
    const bc = { range: range(32, 0, 32, 13), message: 'bc is not covering.\n\nMissing cases:\n    bc B\n    bc C', source: 'idris2' };
    assert.deepStrictEqual(titles(32, 0, [bc]).filter((t) => t.startsWith('Add Missing Cases')), ['Add Missing Cases of bc']);
    const keyword = new FakeTextDoc({ fileName: '/w/K.idr', text: 'p : (n : Nat) -> plus n 0 = n\np n = ?proof' });
    const kinds = editingActionsAt(keyword, { line: 1, character: 8 }, ALL, []).map((a) => a.kind);
    assert.ok(!kinds.includes('refactor.extract.MakeLemma') && kinds.includes('refactor.rewrite.MakeCase'), kinds.join());
  });

  /**
   * The actions of every kind whose title quotes a name of the document, on a text whose names are
   * `name`: a hole's six, Case Split, Add Clause and Generate Definition, Add Missing Cases.
   */
  const everyTitle = (name: string): EditingAction[] => {
    const doc = new FakeTextDoc({ fileName: '/w/T.idr', text: `${name} : Nat -> Nat\n${name} ${name} = ?${name}\n\npartial\ng${name} : Nat -> Nat` });
    const coverage = { range: range(4, 0, 4, 1), message: 'g is not covering.\n\nMissing cases:\n    g 0', source: 'idris2' };
    const holeAt = { line: 1, character: 2 * name.length + 5 };
    return [
      ...editingActionsAt(doc, holeAt, ALL, []),
      ...editingActionsAt(doc, { line: 1, character: name.length + 1 }, ALL, []),
      ...editingActionsAt(doc, { line: 4, character: 0 }, ALL, [coverage]),
    ];
  };
  const KINDS = [
    'refactor.rewrite.ExprSearch', 'refactor.rewrite.Intro', 'refactor.rewrite.RefineHole', 'refactor.extract.MakeLemma',
    'refactor.rewrite.MakeWith', 'refactor.rewrite.MakeCase', 'refactor.rewrite.CaseSplit',
    'refactor.rewrite.AddClause', 'refactor.rewrite.GenerateDef', 'quickfix',
  ];

  test('titles quote at most MAX_SHOWN characters of a name, in every kind of action', () => {
    const actions = everyTitle(`f${'x'.repeat(100_000)}`);
    assert.deepStrictEqual(actions.map((a) => a.kind), KINDS);
    for (const action of actions) {
      assert.ok(action.title.length <= MAX_SHOWN + 25 && action.title.includes('…'), `${action.kind}: ${action.title.length}`);
    }
  });

  test('titles quote names as one line, their control and format characters written out, in every kind of action', () => {
    const actions = everyTitle('a\u202Eb\u200Bc');
    assert.deepStrictEqual(actions.map((a) => a.kind), KINDS);
    for (const action of actions) {
      assert.ok(action.title.includes('a\\u{202E}b\\u{200B}c') && !/[\u202E\u200B]/u.test(action.title), `${action.kind}: ${action.title}`);
    }
    assert.strictEqual(actions[0].title, 'Proof Search for ?a\\u{202E}b\\u{200B}c');
    assert.strictEqual(actions[0].args.name, 'a\u202Eb\u200Bc');
  });

  test('no Add Clause or Generate Definition on a %foreign or %extern function; Case Split not on a clause with a where block below', () => {
    const doc = new FakeTextDoc({
      fileName: '/w/F.idr',
      text: [
        '%foreign "C:puts,libc"', // 0
        'prim__puts : String -> PrimIO Int', // 1
        '%extern', // 2
        'prim__ext : Int -> Int', // 3
        'public export', // 4
        '%foreign "C:a,liba"', // 5
        '         "scheme:b"', // 6
        'prim__two : Int -> Int', // 7
        '%extern prim__one : Int -> Int', // 8
        'plain : Int -> Int', // 9
        'g : Nat -> Nat', // 10
        'g x = ?g_rhs', // 11
        '  where', // 12
        '    z : Nat', // 13
        '    z = x', // 14
      ].join('\n'),
    });
    const titles = (line: number, character: number): string[] => editingActionsAt(doc, { line, character }, ALL, []).map((a) => a.title);
    for (const line of [1, 3, 7, 8]) {
      assert.deepStrictEqual(titles(line, line === 8 ? 9 : 1), [], `line ${line}`);
    }
    assert.deepStrictEqual(titles(9, 1), ['Add Clause for plain', 'Generate Definition of plain']);
    assert.deepStrictEqual(titles(11, 2), []);
    const without = new FakeTextDoc({ fileName: '/w/G.idr', text: 'g : Nat -> Nat\ng x = ?g_rhs\n  -- a comment\nh : Nat' });
    assert.deepStrictEqual(editingActionsAt(without, { line: 1, character: 2 }, ALL, []).map((a) => a.title), ['Case Split on x']);
    // A lambda on a line of its own is no clause (`No clause to split here` [live]), nor on the clause's line.
    for (const [text, line, character] of [['f : Nat -> Nat\nf =\n  \\x => ?h', 2, 3], ['f : Nat -> Nat\nf = \\x => ?h', 1, 5]] as const) {
      assert.deepStrictEqual(editingActionsAt(new FakeTextDoc({ fileName: '/w/Lam.idr', text }), { line, character }, ALL, []).map((a) => a.title), [], text);
    }
  });

  test('disabled with the backend\'s reason: Case Split, Add Clause and Generate Definition below a > line of spaces or in a CRLF literate file, Make Case after the same ?name', () => {
    const lit2 = docOf('Lit2.lidr');
    const split = editingActionsAt(lit2, { line: 17, character: 7 }, ALL, []).find((a) => a.kind === 'refactor.rewrite.CaseSplit');
    assert.match(split?.disabled ?? '', /below line 16, which holds a literate marker followed only by spaces/);
    assert.strictEqual(editingActionsAt(lit2, { line: 8, character: 7 }, ALL, []).find((a) => a.kind === 'refactor.rewrite.CaseSplit')?.disabled, undefined);
    const two = new FakeTextDoc({ fileName: '/w/D.lidr', text: '> f : Nat\n> \n> f = 0\n>   \n> g : Nat -> Nat\n\nProse.' });
    const declared = editingActionsAt(two, { line: 4, character: 3 }, ALL, []);
    assert.deepStrictEqual(declared.map((a) => [a.kind, a.disabled?.replace(/:.*/, '')]), [
      ['refactor.rewrite.AddClause', 'Not available below lines 2 and 4, which hold a literate marker followed only by spaces'],
      ['refactor.rewrite.GenerateDef', 'Not available below lines 2 and 4, which hold a literate marker followed only by spaces'],
    ]);
    // Read for its marker only: below a doubled line, the line read has the same marker.
    const same = new FakeTextDoc({ fileName: '/w/S.lidr', text: '> f : Nat\n> \n> f = 0\n> g : Nat -> Nat\n> h : Nat' });
    assert.deepStrictEqual(editingActionsAt(same, { line: 3, character: 3 }, ALL, []).map((a) => a.disabled), [undefined, undefined]);
    const crlf = new FakeTextDoc({ fileName: '/w/C.lidr', text: '> f : Nat -> Nat\n> f x = ?f_rhs', eol: 'CRLF' });
    assert.strictEqual(editingActionsAt(crlf, { line: 1, character: 5 }, ALL, [])[0].disabled, CRLF_LITERATE);
    const makeCase = (text: string, character: number): string | undefined =>
      editingActionsAt(new FakeTextDoc({ fileName: '/w/M.idr', text: `f : Nat -> (Nat, Nat)\n${text}` }), { line: 1, character }, ALL, []).find((a) => a.kind === 'refactor.rewrite.MakeCase')?.disabled;
    assert.strictEqual(makeCase('f x = (?hx, ?h)', 13), MAKE_CASE_NOT_FIRST);
    assert.strictEqual(makeCase('f x = (?h, ?hx)', 8), undefined);
  });

  test('Case Split disabled where the compiler would garble its answer, with the reason (CaseWords.idr, Shadow.idr; eighth review of M4); Case Split and Make Case on a line with a NUL', () => {
    const splitAt = (doc: FakeTextDoc, line: number, character: number): EditingAction | undefined =>
      editingActionsAt(doc, { line, character }, ALL, []).find((a) => a.kind === 'refactor.rewrite.CaseSplit');
    const words = docOf('CaseWords.idr');
    assert.strictEqual(splitAt(words, 9, 5)?.disabled, CASE_SPLIT_LINE.of); // vlen xs = ?vlen_rhs -- the length of the vector
    assert.strictEqual(splitAt(words, 24, 7)?.disabled, CASE_SPLIT_LINE.of); //   Just y => ?alt_rhs -- the rest of it
    assert.strictEqual(splitAt(words, 19, 6)?.disabled, CASE_SPLIT_LINE.string); // named xs "xs" = ?named_rhs
    const raw = new FakeTextDoc({ fileName: '/w/R.idr', text: 'module R\n\nf : List Nat -> String -> Nat\nf xs #"xs"# = ?f_rhs' });
    assert.strictEqual(splitAt(raw, 3, 2)?.disabled, CASE_SPLIT_LINE.string); // a raw string, M4's third review of the fixes
    const shadow = docOf('Shadow.idr');
    assert.strictEqual(splitAt(shadow, 10, 13)?.disabled, CASE_SPLIT_LINE.namedArgument); // vlen {n = n} xs = ?vlen_rhs
    assert.strictEqual(splitAt(shadow, 21, 24)?.disabled, CASE_SPLIT_LINE.namedArgument); // fields (MkP {x = x, y = y}) = ?fields_rhs
    const control = splitAt(shadow, 13, 10); // vlen2 {n} xs = ?vlen2_rhs
    assert.strictEqual(control?.title, 'Case Split on xs');
    assert.strictEqual(control?.disabled, undefined);
    const nul = new FakeTextDoc({ fileName: '/w/N.idr', text: 'f : Nat -> Nat\nf x = ?h -- a\u0000b' });
    assert.strictEqual(splitAt(nul, 1, 2)?.disabled, NUL_LINE);
    assert.strictEqual(editingActionsAt(nul, { line: 1, character: 7 }, ALL, []).find((a) => a.kind === 'refactor.rewrite.MakeCase')?.disabled, NUL_LINE);
  });

  test('Case Split is not offered on the name of an as-pattern (the compiler never rewrites it; ninth review of M4), but on a variable after the @', () => {
    const doc = new FakeTextDoc({ fileName: '/w/As.idr', text: 'f : List Nat -> Nat\nf xs@(y :: ys) = ?h\ng : Maybe Nat -> Nat\ng m@n = ?k' });
    const titles = (line: number, character: number): string[] => editingActionsAt(doc, { line, character }, ALL, []).map((a) => a.title);
    assert.deepStrictEqual(titles(1, 2), []);
    assert.deepStrictEqual(titles(1, 4), []);
    assert.deepStrictEqual(titles(3, 2), []);
    assert.deepStrictEqual(titles(1, 7), ['Case Split on y']);
    assert.deepStrictEqual(titles(3, 4), ['Case Split on n']);
    // With white space before the @ too [live, final review of M4]; ` @{` is an auto-implicit argument, which splits.
    const spaced = new FakeTextDoc({ fileName: '/w/As.idr', text: 'q : List Nat -> Nat\nq xs  @  (y :: ys) = ?m\nf : Nat -> {auto p : Eq Nat} -> Nat\nf x @{p} = ?h' });
    assert.deepStrictEqual(editingActionsAt(spaced, { line: 1, character: 2 }, ALL, []).map((a) => a.title), []);
    assert.deepStrictEqual(editingActionsAt(spaced, { line: 3, character: 2 }, ALL, []).map((a) => a.title), ['Case Split on x']);
  });

  test('a signature whose : starts the next line: Add Clause and Generate Definition, which the backend sends (ninth review of M4)', () => {
    const doc = new FakeTextDoc({ fileName: '/w/Sig.idr', text: 'module Sig\n\nf\n  : Nat -> Nat\n' });
    assert.deepStrictEqual(
      editingActionsAt(doc, { line: 2, character: 0 }, ALL, []).map((a) => [a.title, a.disabled]),
      [
        ['Add Clause for f', undefined],
        ['Generate Definition of f', undefined],
      ],
    );
  });

  test('the provider: kinds as filter keys, a command and no edit, the diagnostic on the quick fix; context.only honoured', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    registerEditing(api.asApi(), env.deps);
    assert.deepStrictEqual(api.providedKinds, [...EDITING_ACTION_KINDS]);
    const provider = api.provider;
    assert.ok(provider !== undefined);
    const part = docOf('Part.idr');
    const at = new FakeRange(2, 0, 2, 0);
    const actions = await provider.provideCodeActions(part, at, { diagnostics: [COVERAGE] });
    assert.deepStrictEqual(
      actions.map((a) => [a.title, a.kind.value, a.command?.command, a.command?.arguments, 'edit' in a, a.isPreferred, a.diagnostics]),
      [
        ['Add Missing Cases of g', 'quickfix', 'idris2.addMissingCases', [{ uri: part.uri.toString(), position: { line: 2, character: 0 }, name: 'g' }], false, true, [COVERAGE]],
      ],
    );
    const only = await provider.provideCodeActions(part, at, { diagnostics: [COVERAGE], only: FakeCodeActionKind.Empty.append('quickfix') });
    assert.deepStrictEqual(only.map((a) => a.kind.value), ['quickfix']);
    const refactors = await provider.provideCodeActions(clean, new FakeRange(7, 12, 7, 12), { diagnostics: [], only: FakeCodeActionKind.Empty.append('refactor.extract') });
    assert.deepStrictEqual(refactors.map((a) => a.kind.value), ['refactor.extract.MakeLemma']);
    assert.strictEqual(backend.requests.length, 0, 'a code action sends nothing');
  });

  test('the provider offers nothing in Restricted Mode, for a document not on disk, or on a backend without the capabilities', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    registerEditing(api.asApi(), env.deps);
    const provider = api.provider;
    assert.ok(provider !== undefined);
    const at = new FakeRange(7, 12, 7, 12);
    assert.strictEqual((await provider.provideCodeActions(clean, at, { diagnostics: [] })).length, 6);
    env.settings.trusted = false;
    assert.deepStrictEqual(await provider.provideCodeActions(clean, at, { diagnostics: [] }), []);
    env.settings.trusted = true;
    const untitled = new FakeTextDoc({ fileName: 'Untitled-1', text: fixture('Clean.idr'), scheme: 'untitled' });
    assert.deepStrictEqual(await provider.provideCodeActions(untitled, at, { diagnostics: [] }), []);
    backend.caps = {};
    assert.deepStrictEqual(await provider.provideCodeActions(clean, at, { diagnostics: [] }), []);
  });

  test('running an action\'s command with its argument acts where the action was offered', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true });
    const doc = api.workspace.open(docOf('Clean.idr'));
    api.window.showAt(doc, 0, 0); // the cursor elsewhere
    const [action] = await (api.provider as NonNullable<typeof api.provider>).provideCodeActions(doc, new FakeRange(7, 6, 7, 6), { diagnostics: [] });
    backend.answer = () => Promise.resolve({ type: 'edit', replacements: [{ range: range(7, 0, 7, 19), text: 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1' }] });
    await api.run(action.command?.command ?? '', action.command?.arguments?.[0]);
    assert.deepStrictEqual(registration.outcomes, [{ command: 'idris2.caseSplit', kind: 'applied', uri: doc.uri.toString() }]);
    const req = backend.requests[0];
    assert.ok(req.kind === 'caseSplit');
    assert.deepStrictEqual([req.name, req.pos instanceof FakePosition, req.pos.line, req.pos.character], ['xs', true, 7, 5]);
  });
});
