// Suite `editing` (.vscode-test.mjs): the interactive editing commands of M4 (ROADMAP §5 M4, the
// integration part of its IDE-mode acceptance) on the loose files of test/fixtures/workspaces/broken,
// through the fake compiler replaying the replies recorded from Idris 2 0.8.0 (transcripts
// clean-editing, clean-split-columns, ambig-refine, load-part, plain, plain-split-columns,
// hole-errors, lit2-editing, edits-searches). Each command on Clean.idr (the F30 fixture) runs
// twice: as a key or the Command Palette runs it (no argument, the cursor's place) and as its
// light bulb does (`vscode.executeCodeActionProvider` at the cursor, then the action's command
// with its argument); each result is one undo step. Positions are 0-based (VS Code).
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { EditCodeActionKind, EditingCommandId } from '../../../src/features/editing/types';
import {
  acceptQuickPick,
  answerInputBox,
  closeQuickPick,
  codeActionFor,
  codeActionsAt,
  diagnosticsWhen,
  extensionApi,
  FakeLogs,
  runEditing,
  setToolchainSetting,
  settledScan,
  showFile,
} from '../support';
import { assertApplied, assertMessage, editRequests, revertAll, showAt, showLoaded, spliceLines, undoOnce } from './fixture';

/** Clean.idr: `append : …` (line 4, no clauses), `vlen xs = ?vlen_rhs` (line 7). */
const APPEND = new vscode.Position(4, 2);
const XS = new vscode.Position(7, 5);
const VLEN_RHS = new vscode.Position(7, 12);

interface CleanCase {
  readonly command: EditingCommandId;
  readonly kind: EditCodeActionKind;
  readonly at: vscode.Position;
  /** What the input box is answered with (Refine Hole…). */
  readonly input?: string;
  /** Whether a QuickPick opens, whose first item is taken (Intro: two candidates). */
  readonly picks?: boolean;
  /** The file after the command, from the file before it. */
  readonly after: (saved: string) => string;
}

/** The results recorded in clean-editing and clean-split-columns (ROADMAP §5 M4 acceptance, F29, F30). */
const CLEAN_CASES: readonly CleanCase[] = [
  {
    command: 'idris2.caseSplit',
    kind: 'refactor.rewrite.CaseSplit',
    at: XS,
    after: (s) => spliceLines(s, 7, 1, 'vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1'),
  },
  {
    command: 'idris2.addClause',
    kind: 'refactor.rewrite.AddClause',
    at: APPEND,
    after: (s) => spliceLines(s, 5, 0, 'append xs ys = ?append_rhs'),
  },
  {
    command: 'idris2.makeWith',
    kind: 'refactor.rewrite.MakeWith',
    at: VLEN_RHS,
    after: (s) => spliceLines(s, 7, 1, 'vlen xs with (_)', '  vlen xs | with_pat = ?vlen_rhs_rhs'),
  },
  {
    command: 'idris2.makeCase',
    kind: 'refactor.rewrite.MakeCase',
    at: VLEN_RHS,
    after: (s) => spliceLines(s, 7, 1, 'vlen xs = (case _ of', '                case_val => ?vlen_rhs)'),
  },
  {
    command: 'idris2.proofSearch',
    kind: 'refactor.rewrite.ExprSearch',
    at: VLEN_RHS,
    after: (s) => spliceLines(s, 7, 1, 'vlen xs = 0'),
  },
  {
    command: 'idris2.generateDefinition',
    kind: 'refactor.rewrite.GenerateDef',
    at: APPEND,
    after: (s) => spliceLines(s, 5, 0, 'append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys'),
  },
  {
    command: 'idris2.intro',
    kind: 'refactor.rewrite.Intro',
    at: VLEN_RHS,
    picks: true, // 0 and S ?vlen_rhs_0; the first is taken
    after: (s) => spliceLines(s, 7, 1, 'vlen xs = 0'),
  },
  {
    command: 'idris2.refineHole',
    kind: 'refactor.rewrite.RefineHole',
    at: VLEN_RHS,
    input: 'S',
    after: (s) => spliceLines(s, 7, 1, 'vlen xs = (S ?vlen_rhs_0)'),
  },
];

suite('M4 editing commands on broken/ (fake compiler replaying the 0.8.0 transcripts)', () => {
  let api: TestApi;
  let logs: FakeLogs;
  /** Clean.idr as saved. */
  let clean: string;

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
    const doc = await showLoaded(api, 'Clean.idr');
    clean = doc.getText();
  });

  teardown(revertAll);

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  /** Runs `c` on Clean.idr, through `args` (a light bulb's) or none, and checks the result and its one undo step. */
  async function runCleanCase(c: CleanCase, args: readonly unknown[]): Promise<void> {
    const editor = await showAt('Clean.idr', c.at);
    const input = c.input === undefined ? undefined : answerInputBox(c.input);
    try {
      const outcome = await runEditing(api, c.command, args, c.picks === true ? acceptQuickPick : undefined);
      assertApplied(outcome, c.command, editor.document);
      assert.strictEqual(editor.document.getText(), c.after(clean));
      if (input !== undefined) {
        assert.strictEqual(input.asked.length, 1, `the input box was asked ${input.asked.length} times`);
      }
    } finally {
      input?.restore();
    }
    await undoOnce(editor, clean);
  }

  for (const c of CLEAN_CASES) {
    test(`${c.command} on Clean.idr at ${c.at.line}:${c.at.character}, from the Command Palette: the recorded result, one undo step`, async () => {
      await runCleanCase(c, []);
    });

    test(`${c.command} on Clean.idr at ${c.at.line}:${c.at.character}, from its light bulb (${c.kind}): the same`, async () => {
      const editor = await showAt('Clean.idr', c.at);
      const command = await codeActionFor(editor.document.uri, new vscode.Range(c.at, c.at), c.kind, c.command);
      await runCleanCase(c, command.arguments ?? []);
    });
  }

  test('Make Lemma on ?vlen_rhs: `vlen_rhs : Vect n a -> Nat` above vlen\'s declaration, the hole replaced by `(vlen_rhs xs)`; one undo step (also from the light bulb)', async () => {
    for (const fromLightBulb of [false, true]) {
      const editor = await showAt('Clean.idr', VLEN_RHS);
      const args = fromLightBulb
        ? ((await codeActionFor(editor.document.uri, new vscode.Range(VLEN_RHS, VLEN_RHS), 'refactor.extract.MakeLemma', 'idris2.makeLemma')).arguments ?? [])
        : [];
      assertApplied(await runEditing(api, 'idris2.makeLemma', args), 'idris2.makeLemma', editor.document);
      const lines = editor.document.getText().split('\n');
      const lemma = lines.indexOf('vlen_rhs : Vect n a -> Nat');
      assert.ok(lemma > lines.indexOf('append : Vect n a -> Vect m a -> Vect (n + m) a'), lines.join('\n'));
      assert.ok(lemma < lines.indexOf('vlen : Vect n a -> Nat'), lines.join('\n'));
      // Apart from the new declaration and blank lines, only the hole changed. Where between the
      // two declarations the lemma goes is the backend's rule (E15), not this test's.
      const withoutBlanks = (text: string): string[] => text.split('\n').filter((l) => l !== '' && l !== 'vlen_rhs : Vect n a -> Nat');
      assert.deepStrictEqual(withoutBlanks(editor.document.getText()), withoutBlanks(spliceLines(clean, 7, 1, 'vlen xs = (vlen_rhs xs)')));
      await undoOnce(editor, clean);
    }
  });

  test('the light bulb offers, from the text alone, the hole actions at ?vlen_rhs, Case Split at xs, Add Clause and Generate Definition at append — and sends nothing', async () => {
    const editor = await showAt('Clean.idr', VLEN_RHS);
    const from = logs.requests().length;
    const kindsAt = async (at: vscode.Position): Promise<string[]> =>
      (await codeActionsAt(editor.document.uri, new vscode.Range(at, at)))
        .filter((a) => a.command?.command.startsWith('idris2.') === true)
        .map((a) => a.kind?.value ?? '(no kind)')
        .sort();
    assert.deepStrictEqual(
      await kindsAt(VLEN_RHS),
      [
        'refactor.extract.MakeLemma',
        'refactor.rewrite.ExprSearch',
        'refactor.rewrite.Intro',
        'refactor.rewrite.MakeCase',
        'refactor.rewrite.MakeWith',
        'refactor.rewrite.RefineHole',
      ],
    );
    assert.deepStrictEqual(await kindsAt(XS), ['refactor.rewrite.CaseSplit']);
    assert.deepStrictEqual(await kindsAt(APPEND), ['refactor.rewrite.AddClause', 'refactor.rewrite.GenerateDef']);
    assert.deepStrictEqual(await kindsAt(new vscode.Position(0, 2)), []); // `module Clean`
    assert.deepStrictEqual(editRequests(logs, from), []);
  });

  test('Intro: closing its QuickPick changes nothing and is reported as cancelled', async () => {
    const editor = await showAt('Clean.idr', VLEN_RHS);
    const outcome = await runEditing(api, 'idris2.intro', [], closeQuickPick);
    assert.deepStrictEqual(outcome, { command: 'idris2.intro', kind: 'cancelled' });
    assert.strictEqual(editor.document.getText(), clean);
  });

  test('Refine Hole…: Escape in the input box sends nothing and changes nothing', async () => {
    const editor = await showAt('Clean.idr', VLEN_RHS);
    const from = logs.requests().length;
    const input = answerInputBox(undefined);
    try {
      assert.deepStrictEqual(await runEditing(api, 'idris2.refineHole'), { command: 'idris2.refineHole', kind: 'cancelled' });
    } finally {
      input.restore();
    }
    assert.strictEqual(editor.document.getText(), clean);
    assert.deepStrictEqual(editRequests(logs, from), []);
  });

  test('Refine Hole… with `foo` on Ambig.idr (F29): a QuickPick of Ambig.A.foo ?g_rhs_0 and Ambig.B.foo ?g_rhs_0; the first chosen is written qualified, in parentheses', async () => {
    const editor = await showAt('Ambig.idr', new vscode.Position(13, 6));
    const saved = editor.document.getText();
    const input = answerInputBox('foo');
    try {
      const outcome = await runEditing(api, 'idris2.refineHole', [], acceptQuickPick);
      assertApplied(outcome, 'idris2.refineHole', editor.document);
    } finally {
      input.restore();
    }
    assert.strictEqual(editor.document.getText(), spliceLines(saved, 13, 1, 'g = (Ambig.A.foo ?g_rhs_0)'));
    await undoOnce(editor, saved);
  });

  test('Refine Hole…: the typed text goes only into the string slot of :refine, escaped — a string literal survives, a second line is not a command (edits-searches)', async () => {
    // label n = ?label_rhs (line 72 of Edits.idr); the replies are the compiler's.
    const at = new vscode.Position(72, 13);
    const cases = [
      { typed: '"a\\"b\\\\c"', request: '(:refine 73 "label_rhs" "\\"a\\\\\\"b\\\\\\\\c\\"")', line: 'label n = "a\\"b\\\\c"' },
      { typed: 'describe 1\n:t id', request: '(:refine 73 "label_rhs" "describe 1\\10:t id")', line: 'label n = (describe 1)' },
    ];
    for (const { typed, request, line } of cases) {
      const editor = await showAt('Edits.idr', at);
      const saved = editor.document.getText();
      const from = logs.requests().length;
      const input = answerInputBox(typed);
      try {
        assertApplied(await runEditing(api, 'idris2.refineHole'), 'idris2.refineHole', editor.document);
      } finally {
        input.restore();
      }
      assert.deepStrictEqual(editRequests(logs, from), [request]);
      assert.strictEqual(editor.document.lineAt(72).text, line);
      await undoOnce(editor, saved);
    }
  });

  test('Intro with a single candidate applies it without asking: pair x y = (?pair_rhs_0, ?pair_rhs_1)', async () => {
    const editor = await showAt('Edits.idr', new vscode.Position(77, 13));
    const saved = editor.document.getText();
    // No interaction: a QuickPick would leave the command waiting, and the outcome would not come.
    assertApplied(await runEditing(api, 'idris2.intro'), 'idris2.intro', editor.document);
    assert.strictEqual(editor.document.getText(), spliceLines(saved, 77, 1, 'pair x y = (?pair_rhs_0, ?pair_rhs_1)'));
    await undoOnce(editor, saved);
  });

  test('Add Missing Cases on Part.idr (F15): the quick fix on the coverage error inserts `g (S _) = ?g_missing_case_1` at the first blank line after g', async () => {
    const doc = await showFile('Part.idr');
    const saved = doc.getText();
    const coverage = (await diagnosticsWhen(doc.uri, 'the coverage error of g', (ds) => ds.some((d) => /Missing cases/.test(d.message)))).find((d) =>
      /Missing cases/.test(d.message),
    );
    assert.ok(coverage);
    const expected = spliceLines(saved, 4, 0, 'g (S _) = ?g_missing_case_1');
    // The quick fix, as the light bulb on the diagnostic offers it.
    const fixes = (await codeActionsAt(doc.uri, coverage.range, 'quickfix')).filter((a) => a.command?.command === 'idris2.addMissingCases');
    assert.strictEqual(fixes.length, 1, JSON.stringify(fixes.map((a) => a.title)));
    assert.strictEqual(fixes[0].kind?.value, 'quickfix');
    const editor = await showAt('Part.idr', coverage.range.start);
    assertApplied(await runEditing(api, 'idris2.addMissingCases', fixes[0].command?.arguments ?? []), 'idris2.addMissingCases', doc);
    assert.strictEqual(doc.getText(), expected);
    await undoOnce(editor, saved);
    // The command at the diagnostic, without an argument.
    assertApplied(await runEditing(api, 'idris2.addMissingCases'), 'idris2.addMissingCases', doc);
    assert.strictEqual(doc.getText(), expected);
    await undoOnce(editor, saved);
  });

  test('Case Split on `f n = n` (Plain.idr, F15): refused before anything is sent, since the line has no hole to split on (the compiler would answer "No clause to split here"); nothing changes', async () => {
    const editor = await showAt('Plain.idr', new vscode.Position(4, 2));
    const saved = editor.document.getText();
    const from = logs.requests().length;
    assertMessage(await runEditing(api, 'idris2.caseSplit'), 'idris2.caseSplit', /^Idris 2: Case Split: this line has no hole to split on/);
    assert.deepStrictEqual(editRequests(logs, from), []);
    assert.strictEqual(editor.document.getText(), saved);
  });

  test('Add Clause after a load with errors (HoleErr.idr, F16): refused before anything is sent — "the file did not load cleanly — fix the first error and save"', async () => {
    const editor = await showAt('HoleErr.idr', new vscode.Position(4, 2));
    const saved = editor.document.getText();
    const from = logs.requests().length;
    assertMessage(await runEditing(api, 'idris2.addClause'), 'idris2.addClause', /^Idris 2: Add Clause: the file did not load cleanly — fix the first error and save/);
    assert.deepStrictEqual(editRequests(logs, from), []);
    assert.strictEqual(editor.document.getText(), saved);
  });

  test('Lit2.lidr (F11): Case Split keeps a single `> ` on each clause; below a `> ` line (two compiler lines) it is refused before anything is sent', async () => {
    const editor = await showAt('Lit2.lidr', new vscode.Position(8, 7));
    const saved = editor.document.getText();
    assertApplied(await runEditing(api, 'idris2.caseSplit'), 'idris2.caseSplit', editor.document);
    assert.strictEqual(editor.document.getText(), spliceLines(saved, 8, 1, '> vlen [] = ?vlen_rhs_0', '> vlen (x :: xs) = ?vlen_rhs_1'));
    await undoOnce(editor, saved);

    // `> half n = ?half_rhs` (line 17) lies below the line `> ` (line 15): the compiler would
    // answer from the wrong line (backend/types.ts, IdrisBackend.edit).
    editor.selection = new vscode.Selection(17, 7, 17, 7);
    const from = logs.requests().length;
    const outcome = await runEditing(api, 'idris2.caseSplit');
    assert.strictEqual(outcome.kind, 'message', JSON.stringify(outcome));
    assert.deepStrictEqual(editRequests(logs, from), []);
    assert.strictEqual(editor.document.getText(), saved);
  });

  test('a command with nothing to act on says what it needs (no silent no-op): Make Lemma on `module Clean`', async () => {
    const editor = await showAt('Clean.idr', new vscode.Position(0, 2));
    const from = logs.requests().length;
    const outcome = await runEditing(api, 'idris2.makeLemma');
    assert.strictEqual(outcome.kind, 'message', JSON.stringify(outcome));
    assert.strictEqual(editor.document.getText(), clean);
    assert.deepStrictEqual(editRequests(logs, from), []);
  });

});
