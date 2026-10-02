// backend/ide/edits.ts on the fixtures and the replies recorded from idris2 0.8.0: a planned request
// with a recording must be one the recorder sent (byte for byte, so the lines and columns are the
// compiler's), and the recorded answer, decoded and applied to the fixture's text, must give the text
// below. The refusals are tested on the shapes whose answers the recordings show to be wrong. Some
// tests (from the reviews) decode answers typed in here (`lemmaReply`, `textReply`), seen live and
// not recorded; each says where from.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { editText, holeRefusal, holeTokenAt, nameProblem, planEdit, planNext, type EditPlan, type EditText } from '../../src/backend/ide/edits';
import { serializeSexp } from '../../src/backend/ide/sexp';
import type { ReplyPayload } from '../../src/backend/ide/types';
import type { EditAtRequest, EditResult, ExprSearchRequest, Hole, RefineRequest, TextReplacement } from '../../src/backend/types';
import type { EditorPosition, EditorRange } from '../../src/core/positions';
import { IdrisException } from '../../src/core/errors';
import { repoRoot } from '../fake-tools/paths';
import { recordedExchanges } from './support/loadReplies';

const WORKSPACES = path.join(repoRoot(), 'test', 'fixtures', 'workspaces');

/** A fixture's text, and the document the plans see (the compiler read the same text). */
function fixture(relative: string, text?: string): EditText {
  const content = text ?? fs.readFileSync(path.join(WORKSPACES, relative), 'utf8');
  const lines = content.split(/\r\n|\r|\n/);
  const fileName = `/fx/${relative}`;
  return editText(
    { fileName, languageId: fileName.endsWith('.lidr') ? 'lidr' : 'idris2', isUntitled: false, lineCount: lines.length, lineAt: (line) => ({ text: lines[line] }) },
    content,
  );
}

const joined = (text: EditText): string => text.lines.join('\n');

type Place = Omit<EditAtRequest, 'doc' | 'version' | 'token' | 'pos'>;

const pos = (line: number, character: number): vscode.Position => ({ line, character }) as vscode.Position;

/** An `EditAtRequest` (with a fake document: the plans do not read it). */
function at(kind: Place['kind'], line: number, character: number, name: string): EditAtRequest {
  return { kind, doc: {} as vscode.TextDocument, version: 1, pos: pos(line, character), name };
}
function search(line: number, character: number, name: string, hints: string[] = []): ExprSearchRequest {
  return { kind: 'exprSearch', doc: {} as vscode.TextDocument, version: 1, pos: pos(line, character), name, hints };
}
function refineAt(line: number, character: number, name: string, hint: string): RefineRequest {
  return { kind: 'refine', doc: {} as vscode.TextDocument, version: 1, pos: pos(line, character), name, hint };
}

/**
 * The recorded answer to `plan`'s request in `scenario` (its `nth` sending): the plan's request must
 * be byte for byte one the recorder sent.
 */
function answer(scenario: string, plan: EditPlan, nth = 0): ReplyPayload {
  const command = serializeSexp(plan.command);
  const matching = recordedExchanges(scenario, '/fx/broken').filter((x) => /^\((.*) \d+\)\n$/s.exec(x.request)?.[1] === command);
  assert.ok(matching.length > nth, `${scenario}: no recorded request ${command}`);
  return matching[nth].reply.payload;
}

/** The plan of `req` on `text`, and its recorded answer, decoded. */
function result(scenario: string, text: EditText, req: EditAtRequest | ExprSearchRequest | RefineRequest, nth = 0): EditResult {
  const plan = planEdit(req, text);
  return plan.decode(answer(scenario, plan, nth));
}

/** Offset of `p` in `lines` joined with `\n`. */
function offset(lines: readonly string[], p: EditorPosition): number {
  return lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
}

/** `text` after `replacements` (non-overlapping, in the text's coordinates). */
function applied(text: EditText, replacements: readonly TextReplacement[]): string {
  let out = joined(text);
  for (const r of [...replacements].sort((a, b) => offset(text.lines, b.range.start) - offset(text.lines, a.range.start))) {
    out = out.slice(0, offset(text.lines, r.range.start)) + r.text + out.slice(offset(text.lines, r.range.end));
  }
  return out;
}

function edited(r: EditResult): readonly TextReplacement[] {
  assert.strictEqual(r.type, 'edit', JSON.stringify(r));
  return (r as Extract<EditResult, { type: 'edit' }>).replacements;
}

/** The lines `from`–`to` (1-based, as the fixtures' comments count) of a text. */
const linesOf = (s: string, from: number, to: number): string[] => s.split('\n').slice(from - 1, to);

/** The range the text of `r` takes once applied (what the cycling controller follows). */
function followed(r: TextReplacement): EditorRange {
  const parts = r.text.split('\n');
  const end = parts.length === 1
    ? { line: r.range.start.line, character: r.range.start.character + parts[0].length }
    : { line: r.range.start.line + parts.length - 1, character: parts[parts.length - 1].length };
  return { start: r.range.start, end };
}

/** A `:make-lemma` answer (for answers seen live but not recorded; each test says where from). */
function lemmaReply(application: string, type: string): ReplyPayload {
  return {
    kind: 'ok',
    result: {
      kind: 'list',
      items: [
        { kind: 'symbol', name: 'metavariable-lemma' },
        { kind: 'list', items: [{ kind: 'symbol', name: 'replace-metavariable' }, { kind: 'string', value: application }] },
        { kind: 'list', items: [{ kind: 'symbol', name: 'definition-type' }, { kind: 'string', value: type }] },
      ],
    },
    highlighting: [],
  };
}

/** An answer of the string `text` (`:missing`, `:add-clause`, …). */
const textReply = (text: string): ReplyPayload => ({ kind: 'ok', result: { kind: 'string', value: text }, highlighting: [] });

function refusal(f: () => unknown, pattern: RegExp): void {
  assert.throws(f, (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported' && pattern.test(e.message));
}

suite('backend/ide/edits: plans and replacement ranges against the 0.8.0 recordings', () => {
  suite('names (hard requirement: nothing typed in a file reaches the compiler as more than a name)', () => {
    test('holes, variables and functions are checked as the lexer reads names; hints too; refine text only for NUL', () => {
      for (const [req, ok] of [
        [at('caseSplit', 0, 0, "x'"), true],
        [at('caseSplit', 0, 0, 'x₁'), true],
        [at('caseSplit', 0, 0, 'case'), false],
        [at('caseSplit', 0, 0, '_'), false],
        [at('caseSplit', 0, 0, 'x y'), false],
        [at('addMissingCases', 0, 0, '(<&&>)'), true],
        [at('addMissingCases', 0, 0, '<&&>'), false],
        [at('addMissingCases', 0, 0, 'both :exec main'), false],
        [at('addMissingCases', 0, 0, 'both\n:t id'), false],
        [at('addMissingCases', 0, 0, 'Edits.both'), false],
        [at('addMissingCases', 0, 0, '(a b)'), false],
        [at('addMissingCases', 0, 0, 'both"'), false],
        [at('addClause', 0, 0, 'δ'), true],
        [at('generateDef', 0, 0, '(<||>)'), true],
        [at('makeLemma', 0, 0, 'ε'), true],
        [at('makeLemma', 0, 0, 'h\u200b'), false],
        [at('makeLemma', 0, 0, '?h'), false],
        // A lemma is named after its hole, so a keyword hole (`?proof`) would give `proof : …`, which
        // does not parse [live, M4 edit review]; the other commands name theirs `proof_rhs`, `proof_0`.
        [at('makeLemma', 0, 0, 'proof'), false],
        [at('makeCase', 0, 0, 'proof'), true],
        [at('intro', 0, 0, 'case'), true],
        [at('intro', 0, 0, ''), false],
        [search(0, 0, 'h', ['isBig', '(<&&>)']), true],
        [search(0, 0, 'h', ['"; :t id']), false],
        [refineAt(0, 0, 'h', 'describe 1\n:t id'), true],
        [refineAt(0, 0, 'h', 'S\u0000'), false],
        [refineAt(0, 0, 'h h', 'S'), false],
      ] as const) {
        assert.strictEqual(nameProblem(req) === undefined, ok, `${req.kind} ${JSON.stringify(req.name)} ${JSON.stringify(req)}`);
      }
    });

    test('Case Split and Make Case are refused on a line with a NUL, which the compiler cuts its raw line at, Make With on one in the left-hand side it copies; the commands that keep the text are not', () => {
      // `(:case-split 4 3 "n")` answered `f 0 = ?h_0 -- a` / `f (S k) = ?h_1 -- a`, and make-case
      // `g n = case _ of` / `           case_val => ?h -- a` [live, M4 security review]: `b` was lost.
      const text = fixture('broken/Nul.idr', 'module Nul\nf : Nat -> Nat\nf n = ?h -- a\u0000b\n');
      refusal(() => planEdit(at('caseSplit', 2, 2, 'n'), text), /this line holds a NUL character/);
      refusal(() => planEdit(at('makeCase', 2, 7, 'h'), text), /this line holds a NUL character/);
      assert.ok(planEdit(at('makeWith', 2, 7, 'h'), text));
      assert.ok(planEdit(at('makeCase', 2, 7, 'h'), fixture('broken/Nul.idr', 'module Nul\nf : Nat -> Nat\nf n = ?h -- ab\n')));
      // Make With copies the text before the clause's `=`: `f x {- a<NUL>b -} = ?h` gave `f x {- awith (_)` [live, M4's review of the decisions].
      const lhs = fixture('broken/Nul.idr', 'module Nul\nf : Nat -> Nat\nf x {- a\u0000b -} = ?h\n');
      refusal(() => planEdit(at('makeWith', 2, 18, 'h'), lhs), /^Make With: the clause's left-hand side holds a NUL character/);
      const above = fixture('broken/Nul.idr', 'module Nul\nf : Nat -> Nat\nf x {- a\u0000b -} =\n  ?h\n');
      refusal(() => planEdit(at('makeWith', 3, 2, 'h'), above), /^Make With: the clause's left-hand side holds a NUL character/);
      assert.ok(planEdit(at('makeWith', 3, 2, 'h'), fixture('broken/Nul.idr', 'module Nul\nf : Nat -> Nat\nf x {- ab -} =\n  ?h -- a\u0000b\n')));
    });

    test('the hole token at the cursor: whole ?name, not after an operator character, not a longer name', () => {
      assert.deepStrictEqual(holeTokenAt('vlen xs = ?vlen_rhs', 10, 'vlen_rhs'), { start: 10, end: 19 });
      assert.deepStrictEqual(holeTokenAt('vlen xs = ?vlen_rhs', 19, 'vlen_rhs'), { start: 10, end: 19 });
      assert.strictEqual(holeTokenAt('vlen xs = ?vlen_rhs', 9, 'vlen_rhs'), undefined);
      assert.strictEqual(holeTokenAt('f = ?hx ?h', 5, 'h'), undefined);
      assert.deepStrictEqual(holeTokenAt('f = ?hx ?h', 9, 'h'), { start: 8, end: 10 });
      assert.strictEqual(holeTokenAt('f = x+?h', 7, 'h'), undefined);
      assert.deepStrictEqual(holeTokenAt('δ x₁ = ?ε', 8, 'ε'), { start: 7, end: 9 });
    });
  });

  suite('Clean.idr (the acceptance fixture, F29, F30)', () => {
    const clean = fixture('broken/Clean.idr');

    test('Case Split on xs rewrites line 8 into the two clauses', () => {
      for (const [scenario, character] of [['clean-split-columns', 5], ['clean-editing', 0], ['clean-editing', 7]] as const) {
        const r = result(scenario, clean, at('caseSplit', 7, character, 'xs'));
        assert.deepStrictEqual(linesOf(applied(clean, edited(r)), 8, 9), ['vlen [] = ?vlen_rhs_0', 'vlen (x :: xs) = ?vlen_rhs_1']);
      }
    });

    test('Add Clause and Generate Definition insert after the declaration; Next Definition replaces the result', () => {
      const clause = applied(clean, edited(result('clean-editing', clean, at('addClause', 4, 0, 'append'))));
      assert.deepStrictEqual(linesOf(clause, 5, 7), ['append : Vect n a -> Vect m a -> Vect (n + m) a', 'append xs ys = ?append_rhs', '']);
      const first = edited(result('clean-editing', clean, at('generateDef', 4, 3, 'append')));
      const after = applied(clean, first);
      assert.deepStrictEqual(linesOf(after, 6, 8), ['append [] ys = ys', 'append (x :: xs) ys = x :: append xs ys', '']);
      const next = planNext('generateDefNext', fixture('broken/Clean.idr', after), followed(first[0]));
      const second = applied(fixture('broken/Clean.idr', after), edited(next.decode(answer('clean-editing', next))));
      assert.deepStrictEqual(linesOf(second, 5, 10), [
        'append : Vect n a -> Vect m a -> Vect (n + m) a',
        'append [] ys = ys',
        'append (x :: xs) [] = x :: append xs []',
        'append (x :: xs) (y :: ys) = x :: append xs (y :: ys)',
        '',
        'vlen : Vect n a -> Nat',
      ]);
    });

    test('Make Lemma: the type above the declaration, a blank line after it; the hole becomes the application', () => {
      const out = applied(clean, edited(result('clean-editing', clean, at('makeLemma', 7, 12, 'vlen_rhs'))));
      assert.deepStrictEqual(linesOf(out, 6, 10), ['', 'vlen_rhs : Vect n a -> Nat', '', 'vlen : Vect n a -> Nat', 'vlen xs = (vlen_rhs xs)']);
    });

    test('Make Case and Make With replace the clause\'s line (Make Case\'s answer in the bracketed form)', () => {
      assert.deepStrictEqual(linesOf(applied(clean, edited(result('clean-editing', clean, at('makeCase', 7, 10, 'vlen_rhs')))), 8, 9),
        ['vlen xs = (case _ of', '                case_val => ?vlen_rhs)']);
      assert.deepStrictEqual(linesOf(applied(clean, edited(result('clean-editing', clean, at('makeWith', 7, 10, 'vlen_rhs')))), 8, 9),
        ['vlen xs with (_)', '  vlen xs | with_pat = ?vlen_rhs_rhs']);
    });

    test('Intro offers 0 and S ?vlen_rhs_0 (applied in parentheses); Proof Search gives 0, Next 1 then 2, each replacing the previous', () => {
      const intro = result('clean-editing', clean, at('intro', 7, 10, 'vlen_rhs'));
      assert.strictEqual(intro.type, 'choices');
      const choices = (intro as Extract<EditResult, { type: 'choices' }>).choices;
      assert.deepStrictEqual(choices.map((c) => [c.label, linesOf(applied(clean, c.replacements), 8, 8)[0]]), [
        ['0', 'vlen xs = 0'],
        ['S ?vlen_rhs_0', 'vlen xs = (S ?vlen_rhs_0)'],
      ]);
      const plan = planEdit(search(7, 10, 'vlen_rhs'), clean);
      assert.strictEqual(plan.long, true);
      assert.strictEqual(plan.starts, 'exprSearch');
      let replacement = edited(plan.decode(answer('clean-editing', plan)))[0];
      let text = fixture('broken/Clean.idr', applied(clean, [replacement]));
      const shown = [linesOf(joined(text), 8, 8)[0]];
      for (const nth of [0, 1]) {
        const next = planNext('exprSearchNext', text, followed(replacement));
        replacement = edited(next.decode(answer('clean-editing', next, nth)))[0];
        text = fixture('broken/Clean.idr', applied(text, [replacement]));
        shown.push(linesOf(joined(text), 8, 8)[0]);
      }
      assert.deepStrictEqual(shown, ['vlen xs = 0', 'vlen xs = 1', 'vlen xs = 2']);
    });

    test('Refine Hole, Intro and Make Lemma run under longActionTimeout, as the searches do (they can take seconds); Make Case does not', () => {
      assert.strictEqual(planEdit(refineAt(7, 12, 'vlen_rhs', 'S'), clean).long, true);
      assert.strictEqual(planEdit(search(7, 12, 'vlen_rhs'), clean).long, true);
      assert.strictEqual(planEdit(at('intro', 7, 12, 'vlen_rhs'), clean).long, true);
      assert.strictEqual(planEdit(at('makeLemma', 7, 12, 'vlen_rhs'), clean).long, true);
      assert.strictEqual(planEdit(at('makeCase', 7, 12, 'vlen_rhs'), clean).long, false);
      // Add Missing Cases: an unknown name costs the compiler a search for similar names (eighth review of M4).
      assert.strictEqual(planEdit(at('addMissingCases', 2, 0, 'g'), fixture('broken/Part.idr')).long, true);
    });

    test('Refine with S; an ambiguous name offers its qualified alternatives (F29), applied as printed (in parentheses)', () => {
      assert.strictEqual(linesOf(applied(clean, edited(result('clean-editing', clean, refineAt(7, 10, 'vlen_rhs', 'S')))), 8, 8)[0], 'vlen xs = (S ?vlen_rhs_0)');
      const ambig = fixture('broken/Ambig.idr');
      const r = result('ambig-refine', ambig, refineAt(13, 5, 'g_rhs', 'foo'));
      assert.strictEqual(r.type, 'choices');
      const choices = (r as Extract<EditResult, { type: 'choices' }>);
      assert.strictEqual(choices.reason, 'ambiguous');
      assert.deepStrictEqual(choices.choices.map((c) => linesOf(applied(ambig, c.replacements), 14, 14)[0]), ['g = (Ambig.A.foo ?g_rhs_0)', 'g = (Ambig.B.foo ?g_rhs_0)']);
    });

    test('Refine Hole: ambiguity alternatives only for an expression that is one name; else the compiler\'s text', () => {
      // The answers [live, idris2 0.8.0, fifth review of M4, rerun by the fixer]: the alternatives are
      // those of the ambiguous subterm, which would replace the whole hole (`S` or `+ 2` dropped,
      // `Undefined name w`, `Not the end of a block entry`).
      const text = fixture('broken/AmbigApp.idr', 'module AmbigApp\n\ng : Nat\ng = ?goal\n\nh : Nat -> Nat\nh = ?hh\n');
      const ambiguity = (alternatives: readonly string[], location: string): ReplyPayload => ({
        kind: 'error',
        message: `Ambiguous elaboration. Possible results:\n${alternatives.map((a) => `    ${a}\n`).join('')}\n(Interactive):${location}\n 1 | module AmbigApp\n     ^^^\n`,
        highlighting: [],
      });
      for (const [line, hole, hint, reply] of [
        [3, 'goal', 'S (foo 1)', ambiguity(['AmbigApp.A.foo 1', 'AmbigApp.B.foo 1'], '1:4--1:7')],
        [3, 'goal', 'foo 1 + 2', ambiguity(['AmbigApp.A.foo 1', 'AmbigApp.B.foo 1'], '1:1--1:4')],
        [6, 'hh', '\\x => let y = foo x in let z = foo y in let w = foo z in foo w', ambiguity(['AmbigApp.A.foo w', 'AmbigApp.B.foo w'], '1:58--1:61')],
        [6, 'hh', '\\x => case x of { Z => foo 1; S k => foo k }', ambiguity(['?postpone [locals in scope: x]', '?postpone [locals in scope: x]'], '1:24--1:27')],
      ] as const) {
        assert.deepStrictEqual(planEdit(refineAt(line, 5, hole, hint), text).decode(reply), { type: 'failed', message: (reply as { message: string }).message }, hint);
      }
      for (const [hint, alternatives] of [
        ['foo', ['AmbigApp.A.foo ?goal_0', 'AmbigApp.B.foo ?goal_0']],
        [' foo ', ['AmbigApp.A.foo ?goal_0', 'AmbigApp.B.foo ?goal_0']],
        ['A.foo', ['AmbigApp.A.foo ?goal_0', 'Other.A.foo ?goal_0']],
        ['AmbigApp.A.foo', ['AmbigApp.A.foo ?goal_0', 'X.AmbigApp.A.foo ?goal_0']],
      ] as const) {
        const r = planEdit(refineAt(3, 5, 'goal', hint), text).decode(ambiguity(alternatives, '1:1--1:4'));
        assert.strictEqual(r.type, 'choices', hint);
      }
    });

    test('Refine Hole: ambiguity alternatives only when each is the qualified name followed by its arguments; an operator\'s infix form is refused (third review of the fixes)', () => {
      // Answers typed in, copied from live runs [idris2 0.8.0, M4's convergence pass, one --ide-mode process:
      // /tmp/vi2-m4/edits-cv/live/AmbOp.idr, `infixl 5 +++` and an `(+++) : Nat -> Nat -> Nat` in namespaces A and B,
      // and AmbMany.idr, `infixl 6 \`foo\``, `infixl 7 ***` with a three-argument (***), and (<<>>) without a fixity];
      // no recording has them. The infix form as source applies the hole ?g_rhs_0 to two arguments, and loads
      // (`g_rhs_0 : (Nat -> Nat -> Nat) -> ?argTy -> Nat` [live, M4's third review of the fixes]).
      const text = fixture('broken/AmbOp.idr', 'module AmbOp\n\ng : Nat\ng = ?g_rhs\n');
      const ambiguity = (...alternatives: string[]): ReplyPayload => ({
        kind: 'error',
        message: `Ambiguous elaboration. Possible results:\n${alternatives.map((a) => `    ${a}\n`).join('')}\n(Interactive):1:1--1:8\n 1 | module AmbOp\n     ^^^^^^^\n`,
        highlighting: [],
      });
      const decoded = (hint: string, reply: ReplyPayload): EditResult => planEdit(refineAt(3, 4, 'g_rhs', hint), text).decode(reply);
      const infix = ambiguity('?g_rhs_0 AmbOp.A.(+++) ?g_rhs_1', '?g_rhs_0 AmbOp.B.(+++) ?g_rhs_1');
      refusal(
        () => decoded('(+++)', infix),
        /^Refine Hole: the name is ambiguous, and the compiler printed alternatives that are not the qualified name followed by its arguments .*so none is offered: \?g_rhs_0 AmbOp\.A\.\(\+\+\+\) \?g_rhs_1; \?g_rhs_0 AmbOp\.B\.\(\+\+\+\) \?g_rhs_1\. Write the application yourself, the qualified name first, e\.g\. A\.\(\+\+\+\) x y\.$/,
      );
      // An expression that is not one name gets no alternatives at all, as before: the compiler's message.
      for (const hint of ['( +++ )', 'AmbOp.A.(+++)']) {
        assert.deepStrictEqual(decoded(hint, infix), { type: 'failed', message: (infix as { message: string }).message }, hint);
      }
      // A backticked name with a fixity is printed infix too (that form would be right; it is not read here).
      refusal(() => decoded('foo', ambiguity('?g_rhs_0 `AmbOp.A.foo` ?g_rhs_1', '?g_rhs_0 `AmbOp.B.foo` ?g_rhs_1')), /so none is offered/);
      // One alternative of another form is enough; a first word that only ends like the name is not the name.
      refusal(() => decoded('foo', ambiguity('AmbOp.A.foo ?g_rhs_0', '?g_rhs_0 `AmbOp.B.foo` ?g_rhs_1')), /so none is offered/);
      refusal(() => decoded('foo', ambiguity('AmbOp.A.xfoo ?g_rhs_0', 'AmbOp.B.foo ?g_rhs_0')), /so none is offered/);
      refusal(() => decoded('foo', ambiguity('AmbOp.Axfoo ?g_rhs_0', 'AmbOp.B.foo ?g_rhs_0')), /so none is offered/);
      refusal(() => decoded('(+++)', ambiguity('AmbOp.A.(++++) ?g_rhs_0 ?g_rhs_1', 'AmbOp.B.(+++) ?g_rhs_0 ?g_rhs_1')), /so none is offered/);
      refusal(() => decoded('foo', ambiguity('?x.foo ?g_rhs_0', 'AmbOp.B.foo ?g_rhs_0')), /so none is offered/);
      // The prefix form: offered, in parentheses (a three-argument operator with a fixity, an operator without one).
      for (const [hint, alternatives] of [
        ['(***)', ['AmbOp.A.(***) ?g_rhs_0 ?g_rhs_1 ?g_rhs_2', 'AmbOp.B.(***) ?g_rhs_0 ?g_rhs_1 ?g_rhs_2']],
        [' (<<>>) ', ['AmbOp.A.(<<>>) ?g_rhs_0 ?g_rhs_1', 'AmbOp.B.(<<>>) ?g_rhs_0 ?g_rhs_1']],
        ['AmbOp.A.foo', ['AmbOp.A.foo', 'X.AmbOp.A.foo']],
      ] as const) {
        const r = decoded(hint, ambiguity(...alternatives));
        assert.deepStrictEqual(r.type === 'choices' && r.choices.map((c) => c.replacements[0].text), alternatives.map((a) => (a.includes(' ') ? `(${a})` : a)), hint);
      }
    });
  });

  suite('E15 shapes (Edits.idr)', () => {
    const edits = fixture('broken/Edits.idr');
    const out = (scenario: string, req: EditAtRequest | ExprSearchRequest | RefineRequest, from: number, to: number, nth = 0): string[] =>
      linesOf(applied(edits, edited(result(scenario, edits, req, nth))), from, to);

    test('a type declaration continued after a blank line: its clauses go after its last line, from either part', () => {
      const text = fixture('broken/Clean.idr', joined(fixture('broken/Clean.idr')).replace('append : Vect n a -> ', 'append : Vect n a ->\n\n         '));
      for (const line of [4, 6]) {
        assert.deepStrictEqual(linesOf(applied(text, edited(result('clean-editing', text, at('generateDef', line, 0, 'append')))), 5, 9), [
          'append : Vect n a ->',
          '',
          '         Vect m a -> Vect (n + m) a',
          'append [] ys = ys',
          'append (x :: xs) ys = x :: append xs ys',
        ]);
      }
      assert.deepStrictEqual(linesOf(applied(text, edited(result('clean-editing', text, at('addClause', 4, 0, 'append')))), 7, 8), [
        '         Vect m a -> Vect (n + m) a',
        'append xs ys = ?append_rhs',
      ]);
      // A block comment on lines of its own inside the continuation, with code after its end.
      const commented = fixture('broken/Clean.idr', joined(fixture('broken/Clean.idr')).replace('append : Vect n a -> ', 'append : Vect n a ->\n         {- the\n  second\n         -} '));
      assert.deepStrictEqual(linesOf(applied(commented, edited(result('clean-editing', commented, at('generateDef', 4, 0, 'append')))), 8, 9), [
        '         -} Vect m a -> Vect (n + m) a',
        'append [] ys = ys',
      ]);
    });

    test('Add Clause and Generate Definition from any line of a three-line declaration, inserted after its last line', () => {
      for (const line of [7, 8, 9]) {
        assert.deepStrictEqual(out('edits-shapes', at('addClause', line, 8, 'zip3'), 10, 11), ['       Vect n (a, b, c)', 'zip3 xs ys zs = ?zip3_rhs']);
      }
      assert.deepStrictEqual(out('edits-shapes', at('generateDef', 8, 8, 'zip3'), 11, 12), [
        'zip3 [] [] [] = []',
        'zip3 (x :: xs) (y :: ys) (z :: zs) = (x, (y, z)) :: zip3 xs ys zs',
      ]);
      refusal(() => planEdit(at('addClause', 10, 0, 'zip3'), edits), /type declaration of zip3/);
    });

    test('Case Split is refused on a line without the hole (the compiler would drop it or rewrite one line of the clause)', () => {
      refusal(() => planEdit(at('caseSplit', 13, 6, 'xs'), edits), /no hole to split on/);
      refusal(() => planEdit(at('caseSplit', 17, 5, 'm'), edits), /no hole to split on/);
      refusal(() => planEdit(at('caseSplit', 18, 5, 'n'), edits), /no hole to split on/);
      refusal(() => planEdit(at('caseSplit', 30, 9, 'n'), edits), /no hole to split on/);
      refusal(() => planEdit(at('caseSplit', 47, 9, 'mn'), edits), /no hole to split on/);
    });

    test('Case Split in a where block, a with block, an operator, a case alternative; a one-line case is refused (its answer is reshaped)', () => {
      assert.deepStrictEqual(out('edits-shapes', at('caseSplit', 26, 11, 'ys'), 27, 28), ['    go acc [] = ?go_rhs_0', '    go acc (x :: ys) = ?go_rhs_1']);
      assert.deepStrictEqual(out('edits-shapes', at('caseSplit', 31, 11, 'n'), 32, 33), ['  classify 0 | True = ?classify_big_0', '  classify (S k) | True = ?classify_big_1']);
      assert.deepStrictEqual(out('edits-shapes', at('caseSplit', 38, 0, 'x'), 39, 40), ['False <&&> y = ?op_rhs_0', 'True <&&> y = ?op_rhs_1']);
      assert.deepStrictEqual(out('edits-shapes', at('caseSplit', 49, 7, 'k'), 50, 51), ['  Just 0 => ?case_just_0', '  Just (S k) => ?case_just_1']);
      // Recorded: `inline n = case n of 0 => ?inline_rhs_0` / `<21 spaces>(S k) => ?inline_rhs_1`, right
      // here, but the compiler reshapes every line with an `of` this way (CaseWords.idr).
      refusal(() => planEdit(at('caseSplit', 52, 21, 'm'), edits), /holds the word of/);
    });

    test('Add Clause on a function with clauses: after them (above them its catch-all would make them unreachable)', () => {
      assert.deepStrictEqual(out('edits-shapes', at('addClause', 37, 0, '(<&&>)'), 38, 41), ['(<&&>) : Bool -> Bool -> Bool', 'x <&&> y = ?op_rhs', '(<&&>) x y = ?op_rhs', '']);
      // After a line that continues the last clause, led by a block comment: its first token is right of the clause's.
      const text = fixture('broken/Edits.idr', joined(edits).replace('x <&&> y = ?op_rhs\n\n', 'x <&&> y = ?op_rhs\n{- c -}   && True\n'));
      assert.deepStrictEqual(linesOf(applied(text, edited(result('edits-shapes', text, at('addClause', 37, 0, '(<&&>)')))), 39, 41), ['x <&&> y = ?op_rhs', '{- c -}   && True', '(<&&>) x y = ?op_rhs']);
    });

    test('Case Split is refused on a line of alternatives separated by ; (the compiler repeats the whole line per constructor)', () => {
      for (const clause of ['g m = case m of Just y => ?h2 ; Nothing => 0', 'g m = case m of { Just y => ?h2 ; Nothing => 0 }']) {
        const text = fixture('broken/Part.idr', `module Part\n\ng : Maybe Nat -> Nat\n${clause}\n`);
        refusal(() => planEdit(at('caseSplit', 3, clause.indexOf('y =>'), 'y'), text), /separated by ;/);
      }
      for (const alternative of ['  Just y => ?h2 ; Nothing => 0', '  Just y => ?h2 ; _ => 0']) {
        const text = fixture('broken/Part.idr', `module Part\n\ng : Maybe Nat -> Nat\ng m = case m of\n${alternative}\n`);
        refusal(() => planEdit(at('caseSplit', 4, 7, 'y'), text), /separated by ;/);
      }
      assert.ok(planEdit(at('caseSplit', 3, 2, 'x'), fixture('broken/Part.idr', 'module Part\n\ng : Nat -> Nat\ng x = ?h2 -- a; b\n')));
    });

    test('Case Split is refused on a clause with more indented lines below it: its where block would belong to the last new clause only', () => {
      // [live, M4 edit review] split, WS.idr's g gave `g 0 = ?g_rhs_0` / `g (S k) = ?g_rhs_1` and then `Undefined name x` in `z = x`.
      // A line whose first token follows a block comment continues the clause by that token's column: `g x = 10` /
      // `{- c -} * 2` gives `g 0 = 20` [live, M4's review of the fixes].
      for (const clause of [
        'g x = ?g_rhs\n  where\n    z : Nat\n    z = x',
        'g x = ?g_rhs where\n  z : Nat\n  z = x',
        'g x = ?g_rhs {- a comment\n  -}',
        'g x = ?g_rhs\n{- c -} * 2',
        'g x = ?g_rhs\n{- a\n -} * 2',
        'g x = ?g_rhs\n\u00a0* 2',
      ]) {
        const text = fixture('broken/Part.idr', `module Part\n\ng : Nat -> Nat\n${clause}\n\nmain : IO ()\n`);
        refusal(() => planEdit(at('caseSplit', 3, 2, 'x'), text), /more indented lines below it/);
      }
      for (const after of ['\n  -- a comment\nh : Nat', '\n\nh : Nat', '', '\n{- c -}\nh : Nat', '\n{- a\n  b -}\nh : Nat']) {
        assert.ok(planEdit(at('caseSplit', 3, 2, 'x'), fixture('broken/Part.idr', `module Part\n\ng : Nat -> Nat\ng x = ?g_rhs${after}\n`)));
      }
      // Below character literals holding a quote ('\'' then '"'), which open no string (M4's third review of the fixes):
      // Case Split above the where block is refused, Add Clause is sent.
      const quotes = fixture('broken/Part.idr', "module Part\n\nquotes : Char -> Char -> Bool\nquotes '\\'' '\"' = True\nquotes _ _ = False\n\ng : Nat -> Nat\ng x = ?g_rhs\n  where\n    z : Nat\n    z = x\n");
      assert.strictEqual(quotes.continued.size, 0);
      refusal(() => planEdit(at('caseSplit', 7, 2, 'x'), quotes), /more indented lines below it/);
      assert.ok(planEdit(at('addClause', 6, 0, 'g'), quotes));
    });

    test('Case Split where the right-hand side is not a hole alone: the compiler\'s answer is the failure', () => {
      assert.deepStrictEqual(result('edits-shapes', edits, at('caseSplit', 44, 8, 'n')), { type: 'failed', message: 'No clause to split here' });
      assert.deepStrictEqual(result('edits-shapes', edits, at('caseSplit', 56, 6, 'n')), { type: 'failed', message: 'No clause to split here' });
    });

    test('Make Case on the hole\'s line, always in the bracketed form: a continued clause, a case alternative, a where and a with block, after a let\'s in; under an application as recorded', () => {
      // The compiler's unbracketed answers (recorded), rewritten as it writes them for a prefix argument:
      // `(` before `case`, `case_val` one column further, `)` after the hole.
      assert.deepStrictEqual(out('edits-shapes', at('makeCase', 14, 3, 'count_rhs'), 14, 16), ['count xs =', '  (case _ of', '        case_val => ?count_rhs)']);
      assert.deepStrictEqual(out('edits-shapes', at('makeCase', 19, 5, 'step_rhs'), 20, 21), ['  = (case _ of', '          case_val => ?step_rhs)']);
      assert.deepStrictEqual(out('edits-shapes', at('makeCase', 49, 12, 'case_just'), 50, 51), ['  Just k => (case _ of', '                  case_val => ?case_just)']);
      assert.deepStrictEqual(out('edits-shapes', at('makeCase', 26, 16, 'go_rhs'), 27, 28), ['    go acc ys = (case _ of', '                      case_val => ?go_rhs)']);
      assert.deepStrictEqual(out('edits-shapes', at('makeCase', 31, 22, 'classify_big'), 32, 33), ['  classify n | True = (case _ of', '                            case_val => ?classify_big)']);
      assert.deepStrictEqual(out('edits-shapes', at('makeCase', 44, 28, 'let_rhs'), 45, 46), ['withLet n = let m = S n in (case _ of', `${' '.repeat(33)}case_val => ?let_rhs)`]);
      // The compiler's own bracketed answer (a prefix argument), recorded: applied as it is.
      assert.deepStrictEqual(out('edits-shapes', at('makeCase', 56, 13, 'under_rhs'), 57, 58), ['under n = S (case _ of', '                  case_val => ?under_rhs)']);
    });

    test('Make With replaces the clause\'s lines, also when the hole is on the line after the =', () => {
      assert.deepStrictEqual(out('edits-shapes', at('makeWith', 14, 3, 'count_rhs'), 13, 16), ['count : List a -> Nat', 'count xs with (_)', '  count xs | with_pat = ?count_rhs_rhs', '']);
      assert.deepStrictEqual(out('edits-shapes', at('makeWith', 26, 17, 'go_rhs'), 27, 28), ['    go acc ys with (_)', '      go acc ys | with_pat = ?go_rhs_rhs']);
      assert.deepStrictEqual(out('edits-shapes', at('makeWith', 31, 23, 'classify_big'), 32, 33), [
        '  classify n | True with (_)',
        '    classify n | True | with_pat = ?classify_big_rhs',
      ]);
      assert.deepStrictEqual(out('edits-shapes', at('makeWith', 38, 12, 'op_rhs'), 39, 40), ['x <&&> y with (_)', '  x <&&> y | with_pat = ?op_rhs_rhs']);
    });

    test('Make With is refused when the code already has the hole ?<h>_rhs it would add (not in a comment or a string)', () => {
      // [live, idris2 0.8.0, fifth review of M4, rerun by the fixer]: applied, `MW.h_rhs is already defined`.
      const text = fixture('broken/MW.idr', 'module MW\n\ng : Nat\ng = ?h_rhs\n\nf : Nat -> Nat\nf n = ?h\n');
      refusal(() => planEdit(at('makeWith', 6, 7, 'h'), text), /already has a hole of that name/);
      const commented = fixture('broken/MW.idr', 'module MW\n\n-- ?h_rhs\ng : String\ng = "?h_rhs"\n\nf : Nat -> Nat\nf n = ?h\n');
      assert.ok(planEdit(at('makeWith', 7, 7, 'h'), commented));
    });

    test('Make With is refused where its answer is garbage or would drop code: no = before the hole, =>, a let, an application', () => {
      for (const [line, character, hole] of [[19, 5, 'step_rhs'], [49, 12, 'case_just'], [44, 28, 'let_rhs'], [56, 13, 'under_rhs'], [52, 27, 'inline_rhs']] as const) {
        refusal(() => planEdit(at('makeWith', line, character, hole), edits), /right-hand side is the hole alone/);
      }
    });

    test('Make Lemma: above the declaration and its comment, past a where block; an operator\'s signature stays with its clause', () => {
      const where = applied(edits, edited(result('edits-shapes', edits, at('makeLemma', 26, 17, 'go_rhs'))));
      assert.deepStrictEqual(linesOf(where, 21, 29), [
        '',
        'go_rhs : List Nat -> List Nat -> Nat -> Nat',
        '',
        '-- A clause in a where block.',
        'sumAll : List Nat -> Nat',
        'sumAll xs = go 0 xs',
        '  where',
        '    go : Nat -> List Nat -> Nat',
        '    go acc ys = (go_rhs xs ys acc)',
      ]);
      const op = applied(edits, edited(result('edits-shapes', edits, at('makeLemma', 38, 12, 'op_rhs'))));
      assert.deepStrictEqual(linesOf(op, 36, 41), ['private infixr 5 <&&>, <||>', '', 'op_rhs : Bool -> Bool -> Bool', '', '(<&&>) : Bool -> Bool -> Bool', 'x <&&> y = (op_rhs y x)']);
      const under = applied(edits, edited(result('edits-shapes', edits, at('makeLemma', 56, 13, 'under_rhs'))));
      assert.strictEqual(linesOf(under, 59, 59)[0], 'under n = S (under_rhs n)');
    });

    test('proof search and definitions until no more results; intro and refine answers (edits-searches)', () => {
      const plan = planEdit(search(60, 14, 'choose_rhs'), edits);
      let replacement = edited(plan.decode(answer('edits-searches', plan)))[0];
      let text = fixture('broken/Edits.idr', applied(edits, [replacement]));
      const shown = [linesOf(joined(text), 61, 61)[0]];
      for (let nth = 0; ; nth++) {
        const next = planNext('exprSearchNext', text, followed(replacement));
        const r = next.decode(answer('edits-searches', next, nth));
        if (r.type === 'exhausted') {
          break;
        }
        replacement = edited(r)[0];
        text = fixture('broken/Edits.idr', applied(text, [replacement]));
        shown.push(linesOf(joined(text), 61, 61)[0]);
      }
      assert.deepStrictEqual(shown, ['choose x y = y', 'choose x y = x', 'choose x y = False', 'choose x y = True']);
      assert.deepStrictEqual(result('edits-searches', edits, search(72, 11, 'label_rhs')), { type: 'failed', message: 'No search results' });
      assert.deepStrictEqual(serializeSexp(planEdit(search(69, 11, 'check_rhs', ['isBig']), edits).command), '(:proof-search 70 "check_rhs" ("isBig"))');
      const swap = edited(result('edits-searches', edits, at('generateDef', 74, 0, 'swap')));
      assert.deepStrictEqual(linesOf(applied(edits, swap), 75, 77), ['swap : (a, b) -> (b, a)', 'swap x = (snd x, fst x)', '']);
      const intros = result('edits-searches', edits, at('intro', 77, 12, 'pair_rhs'));
      assert.deepStrictEqual(intros.type === 'choices' && intros.choices.map((c) => c.label), ['(?pair_rhs_0, ?pair_rhs_1)']);
      assert.deepStrictEqual(result('edits-searches', edits, at('intro', 72, 11, 'label_rhs')), { type: 'failed', message: "Don't know what to do." });
      const length = result('edits-searches', edits, refineAt(26, 17, 'go_rhs', 'length'));
      assert.deepStrictEqual(length.type === 'choices' && length.choices.map((c) => c.replacements[0].text), [
        '(Prelude.List.length ?go_rhs_2)', '(Prelude.SnocList.length ?go_rhs_2)', '(Prelude.String.length ?go_rhs_2)', '(Data.Vect.length ?go_rhs_2)',
      ]);
      assert.deepStrictEqual(edited(result('edits-searches', edits, refineAt(72, 11, 'label_rhs', 'describe 1\n:t id')))[0].text, '(describe 1)');
      assert.match((result('edits-searches', edits, refineAt(72, 11, 'label_rhs', ':t id')) as { message: string }).message, /^Parse errors/);
    });

    test('an Intro candidate the compiler laid out over lines (wider than 80 columns) is applied on one line', () => {
      // Answers seen live (idris2 0.8.0, M4 edit review): `g = ?<long>` with `g : Nat -> Nat`, and a
      // pair in a .lidr; as sent, the next line lost the expression's context and its marker.
      const long = 'a_hole_whose_name_is_long_enough_to_push_the_lambda_past_eighty_columns';
      const g = fixture('broken/IntroLong.idr', `module IntroLong\n\ng : Nat -> Nat\ng = ?${long}\n`);
      const reply = (...candidates: string[]): ReplyPayload => ({ kind: 'ok', result: { kind: 'list', items: candidates.map((value) => ({ kind: 'string', value })) }, highlighting: [] });
      const lambda = planEdit(at('intro', 3, 5, long), g).decode(reply(`\\arg =>\n?${long}_0`));
      assert.deepStrictEqual(lambda.type === 'choices' && lambda.choices.map((c) => [c.label, c.replacements[0].text]), [[`\\arg => ?${long}_0`, `(\\arg => ?${long}_0)`]]);
      const p = 'proof_that_the_list_is_sorted_after_insertion';
      const lit = fixture('broken/IntroLong.lidr', `> f : (Nat, Nat)\n> f = ?${p}\n`);
      const pair = planEdit(at('intro', 1, 7, p), lit).decode(reply(`(?${p}_0,\n?${p}_1)`));
      assert.deepStrictEqual(linesOf(applied(lit, pair.type === 'choices' ? pair.choices[0].replacements : []), 2, 3), [`> f = (?${p}_0, ?${p}_1)`, '']);
    });

    test('an Intro candidate with a long run of spaces and no line break decodes in linear time (security review of M4)', () => {
      // `MkT : (s : String) -> T s`, Intro on a hole of type `T "<n spaces>"` answers `MkT "<n spaces>"` [live].
      const reply: ReplyPayload = { kind: 'ok', result: { kind: 'list', items: [{ kind: 'string', value: `MkT "${' '.repeat(200_000)}"` }] }, highlighting: [] };
      const plan = planEdit(at('intro', 7, 12, 'vlen_rhs'), fixture('broken/Clean.idr'));
      const started = process.hrtime.bigint();
      const decoded = plan.decode(reply);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(decoded.type === 'choices' && decoded.choices[0].label.length === 200_006);
      assert.ok(ms < 500, `${ms} ms`);
      const split = plan.decode({ ...reply, result: { kind: 'list', items: [{ kind: 'string', value: 'a  \n   \n b \nc' }] } });
      assert.deepStrictEqual(split.type === 'choices' && split.choices[0].label, 'a  b c');
    });

    test('an ambiguity alternative that is an application is bracketed when the hole is an argument', () => {
      const text = fixture('broken/Edits.idr', joined(edits).replace('under n = S ?under_rhs', 'under n = S ?g_rhs'));
      const plan = planEdit(refineAt(56, 13, 'g_rhs', 'foo'), text);
      const r = plan.decode(answer('ambig-refine', { ...plan, command: planEdit(refineAt(13, 5, 'g_rhs', 'foo'), fixture('broken/Ambig.idr')).command }));
      assert.deepStrictEqual(r.type === 'choices' && r.choices.map((c) => c.replacements[0].text), ['(Ambig.A.foo ?g_rhs_0)', '(Ambig.B.foo ?g_rhs_0)']);
    });

    test('names from the file: a prime, non-ASCII letters (sent as decimal escapes, F1)', () => {
      assert.deepStrictEqual(out('edits-names', at('caseSplit', 84, 7, "x'"), 85, 86), ["primed 0 = ?h'_0", "primed (S k) = ?h'_1"]);
      assert.deepStrictEqual(out('edits-names', at('caseSplit', 87, 2, 'x₁'), 88, 89), ['δ 0 = ?ε_0', 'δ (S k) = ?ε_1']);
      assert.strictEqual(serializeSexp(planEdit(at('makeLemma', 87, 8, 'ε'), edits).command), '(:make-lemma 88 "\\949")');
      assert.deepStrictEqual(out('edits-names', at('addClause', 86, 0, 'δ'), 88, 89), ['δ x₁ = ?ε', 'δ k = ?δ_rhs']);
    });

    test('a hole name that is not at the cursor, or a declaration that is not there, is refused before anything is sent', () => {
      refusal(() => planEdit(at('makeCase', 26, 17, 'nope'), edits), /cursor on the hole \?nope/);
      refusal(() => planEdit(at('generateDef', 26, 5, 'go'), edits), /type declaration of go/);
      refusal(() => planEdit(at('generateDef', 11, 0, 'count'), edits), /type declaration of count/);
      assert.deepStrictEqual(result('edits-names', edits, at('generateDef', 12, 0, 'count')), { type: 'failed', message: 'Already defined' });
    });

    test('Make Case is refused when an earlier ?name text on the line would be rewritten instead', () => {
      const text = fixture('broken/Edits.idr', joined(edits).replace('primed x\' = ?h\'', "primed x' = ?h'' ?h'"));
      refusal(() => planEdit(at('makeCase', 84, 18, "h'"), text), /first \?h' of the line/);
    });
  });

  suite('Add Missing Cases (F15, F28)', () => {
    test('Part.idr: the clause after g\'s definition, before the blank line (the ROADMAP acceptance)', () => {
      const part = fixture('broken/Part.idr');
      const out = applied(part, edited(result('load-part', part, at('addMissingCases', 2, 0, 'g'))));
      assert.deepStrictEqual(linesOf(out, 3, 6), ['g : Nat -> Nat', 'g 0 = 0', 'g (S _) = ?g_missing_case_1', '']);
    });

    test('several clauses, numbered; the reports of other functions of the name are skipped; all covered is the answer', () => {
      const holeErr = fixture('broken/HoleErr.idr');
      const out = applied(holeErr, edited(result('hole-errors', holeErr, at('addMissingCases', 13, 0, 'cover'))));
      assert.deepStrictEqual(linesOf(out, 14, 17), ['cover : Bool -> Bool -> Nat', 'cover True True = 1', 'cover True False = ?cover_missing_case_1', 'cover False _ = ?cover_missing_case_2']);
      const edits = fixture('broken/Edits.idr');
      assert.deepStrictEqual(result('edits-names', edits, at('addMissingCases', 12, 0, 'count')), { type: 'failed', message: 'Edits.count: All cases covered' });
      const both = applied(edits, edited(result('edits-names', edits, at('addMissingCases', 91, 0, 'both'))));
      assert.deepStrictEqual(linesOf(both, 92, 95), ['both : Bool -> Bool -> Nat', 'both True True = 1', 'both True False = ?both_missing_case_1', 'both False _ = ?both_missing_case_2']);
      assert.deepStrictEqual(result('part-editing', fixture('broken/Part.idr'), at('addMissingCases', 5, 0, 'main')), {
        type: 'failed',
        message: 'Part.main: Calls non covering function Part.g',
      });
    });

    test('the report of the declaration\'s own module and namespace is taken, never another function\'s of the name (edits-same-name)', () => {
      const same = fixture('broken/SameName.idr');
      // `SameBase.g` has a missing case, the `g` declared here none.
      assert.deepStrictEqual(result('edits-same-name', same, at('addMissingCases', 8, 0, 'g')), { type: 'failed', message: 'SameName.g: All cases covered' });
      // `A.f` is covered, `B.f` is not.
      assert.deepStrictEqual(result('edits-same-name', same, at('addMissingCases', 14, 2, 'f')), { type: 'failed', message: 'SameName.A.f: All cases covered' });
      const b = applied(same, edited(result('edits-same-name', same, at('addMissingCases', 20, 2, 'f'))));
      assert.deepStrictEqual(linesOf(b, 22, 24), ['  f True = 1', '  f False = ?f_missing_case_1', '']);
      const top = applied(same, edited(result('edits-same-name', same, at('addMissingCases', 26, 0, 'go'))));
      assert.deepStrictEqual(linesOf(top, 28, 30), ['go X = 0', 'go Y = ?go_missing_case_1', '']);
      // In another module, or another namespace, the answer has no report of the declaration.
      for (const text of [
        fixture('broken/SameName.idr', joined(same).replace('module SameName', 'module Elsewhere')),
        fixture('broken/SameName.idr', joined(same).replace('namespace B', 'namespace C')),
      ]) {
        const plan = planEdit(at('addMissingCases', 20, 2, 'f'), text);
        refusal(() => plan.decode(answer('edits-same-name', plan)), /reported only other functions of this name/);
      }
    });

    test('a function local to a definition is refused unsent: :missing answers for the top-level one (edits-same-name)', () => {
      const same = fixture('broken/SameName.idr');
      assert.match(JSON.stringify(recordedExchanges('edits-same-name', '/fx/broken').find((x) => x.request.includes(':missing go'))?.reply.payload), /SameName\.go:\\ngo Y/);
      refusal(() => planEdit(at('addMissingCases', 34, 4, 'go'), same), /local to a definition/);
      const letLocal = fixture('broken/Part.idr', 'module Part\n\nf : Nat -> Nat\nf n =\n  let g : Nat -> Nat\n      g 0 = 0\n   in g n\n');
      refusal(() => planEdit(at('addMissingCases', 4, 6, 'g'), letLocal), /type declaration of g/);
    });

    test('a clause that opens a block comment or a """ string: the missing clauses go after the line that closes it', () => {
      for (const [opening, rest] of [
        ['g 0 = length """', ['a long', 'text', '"""']],
        ['g 0 = length """', ['  a long', '  """']],
        ['g 0 = 0 {- a comment', ['  that goes on -}']],
        ['g 0 = 0 {- a {- nested -}', ['  comment -} -- and more']],
      ] as const) {
        const text = fixture('broken/Part.idr', `module Part\n\ng : Nat -> Nat\n${opening}\n${rest.join('\n')}\n\nmain : IO ()\n`);
        const plan = planEdit(at('addMissingCases', 2, 0, 'g'), text);
        const out = applied(text, edited(plan.decode(answer('load-part', plan))));
        assert.deepStrictEqual(linesOf(out, 4, 6 + rest.length), [opening, ...rest, 'g (S _) = ?g_missing_case_1', ''], opening);
      }
    });

    test('a block comment still open at the end of the file (it loads): the commands that would insert into it are refused', () => {
      // `f Z = 0 {- TODO:` / `   the other case` [live, M4 edit review: Add Missing Cases inserted
      // the clause into the comment, and the coverage error stayed].
      const text = fixture('broken/Unterm.idr', 'module Unterm\n\nf : Nat -> Nat\nf Z = 0 {- TODO:\n   the other case\n');
      for (const kind of ['addMissingCases', 'addClause'] as const) {
        refusal(() => planEdit(at(kind, 2, 0, 'f'), text), /ends inside a block comment or string that starts on line 4, and the new text would go into it/);
      }
      const typed = fixture('broken/Unterm.idr', 'module Unterm\n\nf : Nat -> Nat {- the\n   definition comes later\n');
      refusal(() => planEdit(at('generateDef', 2, 0, 'f'), typed), /starts on line 3/);
      refusal(() => planEdit(at('generateDef', 2, 0, 'f'), fixture('broken/Unterm.idr', 'module Unterm\n\nf : Nat -> Nat {- later')), /starts on line 3/);
      // Closed, or opened on a line of its own below the insertion: sent.
      assert.ok(planEdit(at('addMissingCases', 2, 0, 'f'), fixture('broken/Unterm.idr', 'module Unterm\n\nf : Nat -> Nat\nf Z = 0 {- TODO:\n   the other case -}\n')));
      assert.ok(planEdit(at('generateDef', 2, 0, 'f'), fixture('broken/Unterm.idr', 'module Unterm\n\nf : Nat -> Nat\n{- notes\n')));
    });

    test('a clause continued by a line led by a block comment or U+00A0, \\f, \\v: the missing clauses go after that line (the layout reads its first token)', () => {
      // `g 0 = 1` / `{- c -}  + 2` and `h 0 = 1` / U+00A0 ` + 4` load with `g 0` 3 and `h 0` 5 (by Refl); a clause put between
      // takes the line in: `g 0 = 1` / `g (S k) = ?g_missing` / `{- c -}  + 2` loads with `g 0` 1 [live, M4's convergence pass,
      // LC.idr, LC2.idr]. Read by the leading spaces and tabs alone, the line ended the clause.
      for (const continued of ['{- c -}  + 2', '\u00a0 + 2', '\f + 2', '\v + 2', '{- a -} {- 𝑥 -}+ 2']) {
        const text = fixture('broken/Part.idr', `module Part\n\ng : Nat -> Nat\ng 0 = 0\n${continued}\n\nmain : IO ()\n`);
        const plan = planEdit(at('addMissingCases', 2, 0, 'g'), text);
        const out = applied(text, edited(plan.decode(answer('load-part', plan))));
        assert.deepStrictEqual(linesOf(out, 4, 7), ['g 0 = 0', continued, 'g (S _) = ?g_missing_case_1', ''], continued);
      }
    });

    test('the definition ends before a blank line followed by another declaration, not inside a where block', () => {
      const text = fixture('broken/Part.idr', 'module Part\n\ng : Nat -> Nat\ng 0 = h\n  where\n\n    h : Nat\n    h = 0\n\nmain : IO ()\n');
      const plan = planEdit(at('addMissingCases', 2, 0, 'g'), text);
      const out = applied(text, edited(plan.decode(answer('load-part', plan))));
      assert.deepStrictEqual(linesOf(out, 8, 10), ['    h = 0', 'g (S _) = ?g_missing_case_1', '']);
    });
  });

  suite('layout (Layout.idr, LitIndent.lidr): where the text goes, and the declarations taken', () => {
    const layout = fixture('broken/Layout.idr');
    const out = (req: EditAtRequest, from: number, to: number, text = layout): string[] => linesOf(applied(text, edited(result('edits-layout', text, req))), from, to);

    test('a tab-indented line: the compiler\'s spaces (one per tab) become the line\'s own indentation again', () => {
      // The answers [live, idris2 0.8.0, fifth review of M4, rerun by the fixer]; each result passes `--check`
      // (Add Clause, Generate Definition) or fails only on the `_` the command writes (Make With, Make Case).
      const where = fixture('broken/Tab1.idr', 'module Tab1\n\nf : Nat -> Nat\nf x = go x\n  where\n\tgo : Nat -> Nat\n');
      const decoded = (text: EditText, req: EditAtRequest, answer: string): string[] => applied(text, edited(planEdit(req, text).decode(textReply(answer)))).split('\n');
      assert.deepStrictEqual(decoded(where, at('addClause', 5, 2, 'go'), ' go k = ?go_rhs').slice(5, 7), ['\tgo : Nat -> Nat', '\tgo k = ?go_rhs']);
      assert.deepStrictEqual(decoded(where, at('generateDef', 5, 2, 'go'), ' go k = k').slice(5, 7), ['\tgo : Nat -> Nat', '\tgo k = k']);
      // … and Next Definition's (' go k = S k' [live, M4 edit review]), at the end of the file and above other code.
      for (const below of ['', '\nh : Nat\n']) {
        const text = fixture('broken/Tab1.idr', `module Tab1\n\nf : Nat -> Nat\nf x = go x\n  where\n\tgo : Nat -> Nat${below}`);
        const first = edited(planEdit(at('generateDef', 5, 2, 'go'), text).decode(textReply(' go k = k')));
        const after = fixture('broken/Tab1.idr', applied(text, first));
        const next = planNext('generateDefNext', after, followed(first[0]));
        assert.deepStrictEqual(applied(after, edited(next.decode(textReply(' go k = S k')))).split('\n').slice(5, 7), ['\tgo : Nat -> Nat', '\tgo k = S k']);
      }
      const ns = fixture('broken/Tab2.idr', 'module Tab2\n\nnamespace A\n\tf : Nat -> Nat\n\tf x = ?h\n');
      assert.deepStrictEqual(decoded(ns, at('makeWith', 4, 8, 'h'), ' f x with (_)\n   f x | with_pat = ?h_rhs').slice(4, 6), ['\tf x with (_)', '\t  f x | with_pat = ?h_rhs']);
      // Make Case: the compiler's unbracketed answer, in the bracketed form, the tab of the code before the hole kept.
      assert.deepStrictEqual(decoded(ns, at('makeCase', 4, 8, 'h'), '\tf x = case _ of\n            case_val => ?h').slice(4, 6), ['\tf x = (case _ of', '\t            case_val => ?h)']);
      // Spaces stay spaces.
      const spaced = fixture('broken/Tab2.idr', 'module Tab2\n\nnamespace A\n  f : Nat -> Nat\n  f x = ?h\n');
      assert.deepStrictEqual(decoded(spaced, at('makeWith', 4, 8, 'h'), '  f x with (_)\n    f x | with_pat = ?h_rhs').slice(4, 6), ['  f x with (_)', '    f x | with_pat = ?h_rhs']);
    });

    test('Make Lemma above the declaration of an infix operator, of an operator in prefix form, of a backticked name, from any clause', () => {
      assert.deepStrictEqual(out(at('makeLemma', 10, 14, 'and_true'), 8, 13), ['', 'and_true : Bool -> Bool', '', '(<&&>) : Bool -> Bool -> Bool', 'False <&&> y = ?and_false', 'True <&&> y = (and_true y)']);
      assert.deepStrictEqual(out(at('makeLemma', 9, 15, 'and_false'), 8, 12), ['', 'and_false : Bool -> Bool', '', '(<&&>) : Bool -> Bool -> Bool', 'False <&&> y = (and_false y)']);
      assert.deepStrictEqual(out(at('makeLemma', 14, 16, 'or_true'), 12, 17), ['', 'or_true : Bool -> Bool', '', '(<||>) : Bool -> Bool -> Bool', '(<||>) False y = y', '(<||>) True y = (or_true y)']);
      assert.deepStrictEqual(out(at('makeLemma', 18, 16, 'plus2_rhs'), 16, 21), ['', 'plus2_rhs : Nat -> Nat -> Nat', '', 'plus2 : Nat -> Nat -> Nat', 'Z `plus2` y = y', 'S k `plus2` y = (plus2_rhs k y)']);
    });

    test('Make Lemma above the modifier and pragma lines of the declaration, in either order', () => {
      assert.deepStrictEqual(out(at('makeLemma', 23, 10, 'twice_rhs'), 20, 26), ['', 'twice_rhs : Nat -> Nat', '', 'public export', '%inline', 'twice : Nat -> Nat', 'twice x = (twice_rhs x)']);
      const swapped = fixture('broken/Layout.idr', joined(layout).replace('public export\n%inline\n', '%inline\npublic export\n'));
      assert.deepStrictEqual(out(at('makeLemma', 23, 10, 'twice_rhs'), 20, 25, swapped), ['', 'twice_rhs : Nat -> Nat', '', '%inline', 'public export', 'twice : Nat -> Nat']);
    });

    test('a function declared first in a mutual block: Add Missing Cases and Add Clause after its clauses', () => {
      assert.deepStrictEqual(out(at('addMissingCases', 29, 2, 'isOdd'), 34, 37), ['', '  isOdd (S k) = isEven k', '  isOdd 0 = ?isOdd_missing_case_1', '']);
      assert.deepStrictEqual(out(at('addClause', 29, 2, 'isOdd'), 33, 37), ['  isEven (S k) = isOdd k', '', '  isOdd (S k) = isEven k', '  isOdd k = ?isOdd_rhs', '']);
    });

    test('clauses of the function in two places are refused before anything is sent', () => {
      const split = fixture('broken/Layout.idr', joined(layout).replace('  isOdd (S k) = isEven k\n', '  isOdd (S k) = isEven k\n  isEven 5 = True\n  isOdd Z = False\n'));
      refusal(() => planEdit(at('addMissingCases', 29, 2, 'isOdd'), split), /clauses of isOdd are not all together/);
      refusal(() => planEdit(at('addClause', 29, 2, 'isOdd'), split), /clauses of isOdd are not all together/);
    });

    test('a pragma before the name and an operator with - are declarations; one of two names is refused', () => {
      assert.deepStrictEqual(out(at('addClause', 36, 8, 'inl'), 37, 38), ['%inline inl : Nat -> Nat', 'inl k = ?inl_rhs']);
      assert.deepStrictEqual(out(at('generateDef', 36, 8, 'inl'), 37, 38), ['%inline inl : Nat -> Nat', 'inl k = k']);
      assert.deepStrictEqual(out(at('addClause', 38, 1, '(<->)'), 39, 40), ['(<->) : Nat -> Nat -> Nat', '(<->) k j = ?op_rhs']);
      assert.deepStrictEqual(out(at('generateDef', 38, 1, '(<->)'), 39, 40), ['(<->) : Nat -> Nat -> Nat', 'k <-> j = j']);
      assert.ok(planEdit(at('addMissingCases', 38, 1, '(<->)'), layout));
      // The compiler answers for the last name, whatever the name sent [live, edits-layout].
      const pair = recordedExchanges('edits-layout', '/fx/broken').find((x) => x.request.startsWith('((:add-clause 41 "pair") '));
      assert.match(JSON.stringify(pair?.reply.payload), /"other k = \?other_rhs"/);
      for (const kind of ['addClause', 'generateDef', 'addMissingCases'] as const) {
        refusal(() => planEdit(at(kind, 40, 0, 'pair'), layout), /type declaration of several names/);
      }
    });

    test('Make With puts a comment after the hole back at the end of its first line', () => {
      assert.deepStrictEqual(out(at('makeWith', 43, 10, 'note_rhs'), 44, 45), ['note xs with (_) -- keep this note', '  note xs | with_pat = ?note_rhs_rhs']);
    });

    test('bird tracks: Add Clause on an indented declaration keeps its indentation after the marker; Generate Definition is as answered', () => {
      const lit = fixture('broken/LitIndent.lidr');
      const litOut = (req: EditAtRequest, from: number, to: number): string[] => linesOf(applied(lit, edited(result('lit-indent-editing', lit, req))), from, to);
      assert.deepStrictEqual(litOut(at('addClause', 8, 6, 'go'), 9, 10), ['>     go : Nat -> List Nat -> Nat', '>     go k ks = ?go_rhs']);
      assert.deepStrictEqual(litOut(at('addClause', 11, 4, 'isEven'), 12, 13), ['>   isEven : Nat -> Bool', '>   isEven k = ?isEven_rhs']);
      assert.deepStrictEqual(litOut(at('generateDef', 11, 4, 'isEven'), 13, 14), ['>   isEven 0 = False', '>   isEven (S k) = isEven k']);
    });
  });

  suite('blocks (Blocks.idr, Indented.idr): namespace, mutual, interface and parameters blocks, block comments, indented top level', () => {
    const blocks = fixture('broken/Blocks.idr');
    const out = (req: EditAtRequest, from: number, to: number, text = blocks): string[] => linesOf(applied(text, edited(result('edits-blocks', text, req))), from, to);
    const recorded = (request: string): ReplyPayload | undefined => recordedExchanges('edits-blocks', '/fx/broken').find((x) => x.request.startsWith(request))?.reply.payload;

    test('Make Lemma in a namespace or a mutual block: above the declaration in that block, indented as it (a type of the block stays in scope)', () => {
      assert.deepStrictEqual(out(at('makeLemma', 13, 8, 'ns_rhs'), 12, 16), ['', '  ns_rhs : U -> Nat', '', '  g : U -> Nat', '  g u = (ns_rhs u)']);
      assert.deepStrictEqual(out(at('makeLemma', 19, 8, 'mut_rhs'), 18, 22), ['', '  mut_rhs : V -> Nat', '', '  f : V -> Nat', '  f v = (mut_rhs v)']);
    });

    test('entries led by a block comment or U+00A0: their column is their first token\'s, and new text gets that column in spaces (convergence pass)', () => {
      // These texts, with the new lines, load: their holes are listed [live, M4's convergence pass, NB.idr].
      const same = fixture('broken/SameName.idr');
      for (const [entries, clause] of [
        [['{- a -} export', '        partial', '{- d -} f : Bool -> Nat', '{- t -} f True = 1'], '        f False = ?f_missing_case_1'],
        [['  export', '  partial', '\u00a0\u00a0f : Bool -> Nat', '\u00a0 f True = 1'], '  f False = ?f_missing_case_1'],
        [['{- 𝑎 -} export', '        partial', '{- 𝑑 -} f : Bool -> Nat', '{-𝑡-}\u00a0\u00a0 f True = 1'], '        f False = ?f_missing_case_1'],
      ] as const) {
        const text = fixture('broken/SameName.idr', joined(same).replace('  export\n  partial\n  f : Bool -> Nat\n  f True = 1', entries.join('\n')));
        const character = text.lines[20].indexOf('f :');
        const b = applied(text, edited(result('edits-same-name', text, at('addMissingCases', 20, character, 'f'))));
        assert.deepStrictEqual(linesOf(b, 22, 24), [entries[3], clause, ''], entries[2]);
      }
      const nbsp = fixture('broken/Blocks.idr', joined(blocks).replace('  g : U -> Nat\n  g u = ?ns_rhs', '\u00a0 g : U -> Nat\n\u00a0 g u = ?ns_rhs'));
      assert.deepStrictEqual(out(at('makeLemma', 13, 8, 'ns_rhs'), 12, 16, nbsp), ['', '  ns_rhs : U -> Nat', '', '\u00a0 g : U -> Nat', '\u00a0 g u = (ns_rhs u)']);
    });

    test('Make Lemma in a parameters block: above the block (the lemma takes the parameters); where the top level is indented: indented, below the module line', () => {
      const lemma = applied(blocks, edited(result('edits-blocks', blocks, at('makeLemma', 30, 9, 'pw_rhs'))));
      assert.deepStrictEqual(linesOf(lemma, 25, 28), ['', 'pw_rhs : Nat -> Nat -> Nat', '', 'parameters (k : Nat)']);
      assert.deepStrictEqual(linesOf(lemma, 33, 33), ['  pw x = (pw_rhs k x)']);
      const indented = fixture('broken/Indented.idr');
      assert.deepStrictEqual(out(at('makeLemma', 5, 8, 'f_rhs'), 1, 8, indented), ['module Indented', '', '  -- M4: top-level declarations indented below the module header.', '', '  f_rhs : Nat -> Nat', '', '  f : Nat -> Nat', '  f x = (f_rhs x)']);
    });

    test('Make Lemma in an interface is refused unsent; an application that names the dictionary (__con) is not applied', () => {
      assert.match(JSON.stringify(recorded('((:make-lemma 24 "default_rhs") ')), /default_rhs x __con/);
      refusal(() => planEdit(at('makeLemma', 23, 10, 'default_rhs'), blocks), /not available in an interface/);
      const nested = fixture('broken/Blocks.idr', joined(blocks).replace('interface Foo a where\n', 'namespace M\n  public export\n  interface Foo a where\n').replace('  foo : a -> Nat\n  foo x', '    foo : a -> Nat\n    foo x'));
      refusal(() => planEdit(at('makeLemma', 25, 12, 'default_rhs'), nested), /not available in an interface/);
      const plan = planEdit(at('makeLemma', 30, 9, 'pw_rhs'), blocks);
      const payload = recorded('((:make-lemma 24 "default_rhs") ');
      assert.ok(payload !== undefined);
      refusal(() => plan.decode(payload), /the compiler named itself/);
    });

    test('Make Lemma is not applied when the application passes a name the compiler made (conArg, lcase); a named constraint is applied', () => {
      // The answers [live, idris2 0.8.0, M4 edit review, rerun by the fixer]; applied, each gave `Undefined name`.
      const con = fixture('broken/Con.idr', 'module Con\n\nf : Show a => a -> String\nf x = ?f_rhs\n\ng : {auto p : Show a} -> a -> String\ng x = ?g_rhs\n');
      refusal(() => planEdit(at('makeLemma', 3, 6, 'f_rhs'), con).decode(lemmaReply('f_rhs conArg x', 'f_rhs : Show a -> a -> String')), /the compiler named itself/);
      refusal(() => planEdit(at('makeLemma', 3, 6, 'f_rhs'), con).decode(lemmaReply('(f_rhs conArg x)', 'f_rhs : Show a -> a -> String')), /the compiler named itself/);
      const named = applied(con, edited(planEdit(at('makeLemma', 6, 6, 'g_rhs'), con).decode(lemmaReply('g_rhs x p', 'g_rhs : a -> Show a -> String'))));
      assert.deepStrictEqual(linesOf(named, 6, 9), ['g_rhs : a -> Show a -> String', '', 'g : {auto p : Show a} -> a -> String', 'g x = (g_rhs x p)']);
      const lcase = fixture('broken/LC.idr', 'module LC\n\nf : Nat -> Nat\nf = \\case\n  Z => ?h1\n  S k => 0\n');
      refusal(() => planEdit(at('makeLemma', 4, 8, 'h1'), lcase).decode(lemmaReply('h1 lcase', 'h1 : Nat -> Nat')), /the compiler named itself/);
      // A name in a comment is not code.
      const commented = fixture('broken/Con.idr', 'module Con\n\n-- conArg\nf : Show a => a -> String\nf x = ?f_rhs\n');
      refusal(() => planEdit(at('makeLemma', 4, 6, 'f_rhs'), commented).decode(lemmaReply('f_rhs conArg x', 'f_rhs : Show a -> a -> String')), /the compiler named itself/);
    });

    test('Make Lemma is not applied when its type holds a _ (a value bound by _ that other locals\' types use)', () => {
      // The answers [live, idris2 0.8.0, fifth review of M4, rerun by the fixer]; applied, `Unsolved holes` at the call.
      const dp = fixture('broken/DP.idr', 'module DP\n\nimport Data.Vect\n\nf : (n ** Vect n Nat) -> Nat\nf (_ ** v) = ?h\n\ng : (n : Nat) -> Vect n Nat -> Nat\ng _ xs = ?k\n');
      refusal(() => planEdit(at('makeLemma', 5, 14, 'h'), dp).decode(lemmaReply('h v', 'h : {_ : Nat} -> Vect _ Nat -> Nat')), /depend on a value bound by _/);
      refusal(() => planEdit(at('makeLemma', 8, 10, 'k'), dp).decode(lemmaReply('k xs', 'k : {_ : Nat} -> Vect _ Nat -> Nat')), /depend on a value bound by _/);
      // Inside brackets too (`f : (n ** List (Vect n Nat)) -> Nat`, `f (_ ** vs) = ?h` [live]).
      const list = fixture('broken/DP2.idr', 'module DP2\n\nimport Data.Vect\n\nf : (n ** List (Vect n Nat)) -> Nat\nf (_ ** vs) = ?h\n');
      refusal(() => planEdit(at('makeLemma', 5, 15, 'h'), list).decode(lemmaReply('h vs', 'h : {_ : Nat} -> List (Vect _ Nat) -> Nat')), /depend on a value bound by _/);
      // Named, the lemma is applied, and the file checks [live].
      const named = fixture('broken/DP.idr', joined(dp).replace('g _ xs', 'g n xs'));
      assert.deepStrictEqual(linesOf(applied(named, edited(planEdit(at('makeLemma', 8, 10, 'k'), named).decode(lemmaReply('k xs', 'k : Vect n Nat -> Nat')))), 8, 11),
        ['k : Vect n Nat -> Nat', '', 'g : (n : Nat) -> Vect n Nat -> Nat', 'g n xs = (k xs)']);
    });

    test('Make Lemma is refused when a local of the hole\'s name would take the call, and not applied when the call repeats a shadowed name', () => {
      // [live, idris2 0.8.0, fifth review of M4, rerun by the fixer]: `f x = S (go x)` called the where-local
      // `go`; `f k y = k y k` did not check; `let x = S x in h x x` passed the inner `x` twice.
      const where = fixture('broken/Sh1.idr', 'module Sh1\n\nf : Nat -> Nat\nf x = S ?go\n  where\n    go : Nat -> Nat\n    go y = y\n\nh : Nat\nh = ?go2\n');
      refusal(() => planEdit(at('makeLemma', 3, 9, 'go'), where), /go is also a name in this definition/);
      assert.ok(planEdit(at('makeLemma', 9, 5, 'go2'), where));
      const pattern = fixture('broken/Sh2.idr', 'module Sh2\n\nf : Nat -> Nat -> Nat\nf k y = ?k\n');
      refusal(() => planEdit(at('makeLemma', 3, 9, 'k'), pattern), /k is also a name in this definition/);
      const shadowed = fixture('broken/Sh3.idr', 'module Sh3\n\nf : Nat -> Nat\nf x = let x = S x in ?h\n');
      refusal(() => planEdit(at('makeLemma', 3, 22, 'h'), shadowed).decode(lemmaReply('h x x', 'h : Nat -> Nat -> Nat')), /two locals of one name/);
    });

    test('a dot pattern .( is a group, not the operator .: the clause is the function\'s, for Make Lemma, Add Missing Cases and Add Clause', () => {
      // The answers [live, idris2 0.8.0, M4 edit review, rerun by the fixer]; read as `(.)`'s clause, the lemma
      // went between g's clauses and Add Missing Cases and Add Clause were refused (two runs of clauses).
      const dot2 = fixture('broken/Dot2.idr', 'module Dot2\n\ng : (n : Nat) -> (m : Nat) -> n = m -> Nat\ng Z Z Refl = 0\ng (S k) .(S k) Refl = ?g_rhs\n');
      const lemma = applied(dot2, edited(planEdit(at('makeLemma', 4, 22, 'g_rhs'), dot2).decode(lemmaReply('g_rhs k', 'g_rhs : Nat -> Nat'))));
      assert.deepStrictEqual(linesOf(lemma, 3, 7), ['g_rhs : Nat -> Nat', '', 'g : (n : Nat) -> (m : Nat) -> n = m -> Nat', 'g Z Z Refl = 0', 'g (S k) .(S k) Refl = (g_rhs k)']);
      const dot4 = fixture(
        'broken/Dot4.idr',
        'module Dot4\n\npartial\nh : (n : Nat) -> (m : Nat) -> n = m -> Bool -> Nat\nh Z Z Refl True = 0\nh (S k) .(S k) Refl True = 1\nh Z Z Refl False = 2\n',
      );
      const missing = applied(dot4, edited(planEdit(at('addMissingCases', 3, 0, 'h'), dot4).decode(textReply('Dot4.h:\nh (S _) (S _) Refl False'))));
      assert.deepStrictEqual(linesOf(missing, 7, 8), ['h Z Z Refl False = 2', 'h (S _) (S _) Refl False = ?h_missing_case_1']);
      const clause = applied(dot4, edited(planEdit(at('addClause', 3, 0, 'h'), dot4).decode(textReply('h n m prf x = ?h_rhs'))));
      assert.deepStrictEqual(linesOf(clause, 7, 8), ['h Z Z Refl False = 2', 'h n m prf x = ?h_rhs']);
    });

    test('Add Missing Cases in a parameters block is refused unsent (the compiler lists the parameters as patterns)', () => {
      assert.match(JSON.stringify(recorded('((:interpret ":missing f4") ')), /f4 _ B/);
      refusal(() => planEdit(at('addMissingCases', 26, 2, 'f4'), blocks), /not available in a parameters block/);
    });

    test('lines of a block comment are not code: the missing clauses go after the live ones, and a commented clause does not split the run', () => {
      assert.deepStrictEqual(out(at('addMissingCases', 32, 0, 'bc'), 34, 38), ['bc A = 0', 'bc B = ?bc_missing_case_1', 'bc C = ?bc_missing_case_2', '{-', 'bc B = 1']);
      const between = fixture('broken/Blocks.idr', joined(blocks).replace('-}\n', '-}\nbc C = 2\n'));
      assert.strictEqual(planEdit(at('addClause', 32, 0, 'bc'), between).afterFailedLoad !== undefined, true);
      const nested = fixture('broken/Blocks.idr', joined(blocks).replace('{-\nbc B = 1\n-}', '{- {- -}\nbc B = 1\n"-}"\n-}'));
      assert.deepStrictEqual(out(at('addMissingCases', 32, 0, 'bc'), 34, 36, nested), ['bc A = 0', 'bc B = ?bc_missing_case_1', 'bc C = ?bc_missing_case_2']);
      const string = fixture('broken/Blocks.idr', joined(blocks).replace('{-\nbc B = 1\n-}', 's : String\ns = """\nbc B = 1\n"""'));
      assert.deepStrictEqual(out(at('addMissingCases', 32, 0, 'bc'), 34, 36, string), ['bc A = 0', 'bc B = ?bc_missing_case_1', 'bc C = ?bc_missing_case_2']);
    });

    test('comments as the lexer reads them: a doc comment runs to the end of its line; in a block comment, strings, characters and -- hide {- and -}', () => {
      // Each file checks [live, idris2 0.8.0, fifth review of M4 and the fixer]; read otherwise, every line below was taken
      // for a comment and the lemma went to line 0, above `module` (`--check`: Couldn't parse declaration).
      // The lemma goes above `f : Nat` (line `line`), and above a comment on the lines right above it.
      for (const [source, line, lemmaLine] of [
        ['||| Module doc: the lexer skips {- nested comments\nmodule DocC\n\nf : Nat\nf = ?h\n', 3, 3],
        ['module BlkS\n\n{- The opener is "{-" -}\nf : Nat\nf = ?h\n', 3, 2],
        ['module BlkQ\n\n{- The opener is \'{\' then \'-\', "a string\nover {- lines" -}\nf : Nat\nf = ?h\n', 4, 4],
        ['module BlkL\n\n{- old code -- {- nested?\n-}\nf : Nat\nf = ?h\n', 4, 4],
        ['module BlkD\n\n{- a {--} b {---} c --}\nf : Nat\nf = ?h\n', 3, 2],
        ['module BlkC\n\n{- a \'"\' b -}\nf : Nat\nf = ?h\n', 3, 2],
      ] as const) {
        const text = fixture('broken/Doc.idr', source);
        const lemma = applied(text, edited(planEdit(at('makeLemma', line + 1, 5, 'h'), text).decode(lemmaReply('h', 'h : Nat'))));
        const lines = source.replace('?h', 'h').split('\n');
        assert.strictEqual(lemma, [...lines.slice(0, lemmaLine), 'h : Nat', '', ...lines.slice(lemmaLine)].join('\n'), source);
        assert.ok(planEdit(at('addClause', line, 0, 'f'), text), source);
      }
      // A name in a doc comment is not code: `h` there is no local that would take the call.
      const doc = fixture('broken/Doc.idr', 'module DocH\n\n||| Calls h, the helper.\nf : Nat\nf = ?h\n');
      assert.deepStrictEqual(linesOf(applied(doc, edited(planEdit(at('makeLemma', 4, 5, 'h'), doc).decode(lemmaReply('h', 'h : Nat')))), 3, 7),
        ['h : Nat', '', '||| Calls h, the helper.', 'f : Nat', 'f = h']);
      // `{--}` does not close itself (the opener takes all the dashes): `--check` passes on this file [live].
      const open = fixture('broken/Doc.idr', 'module BlkO\n\n{--}\nf : Nat\nf = "not a Nat"\n-}\ng : Nat\ng = 1\n');
      assert.deepStrictEqual([...open.continued.keys()], [3, 4, 5]);
    });

    test('Add Missing Cases numbers its holes after the missing-case holes of the function already open', () => {
      const open = fixture('broken/Blocks.idr', joined(blocks).replace('bc A = 0\n', 'bc A = 0\nbc D = ?bc_missing_case_2 + ?bc_missing_case_7\'\n'));
      assert.deepStrictEqual(out(at('addMissingCases', 32, 0, 'bc'), 36, 37, open), ['bc B = ?bc_missing_case_3', 'bc C = ?bc_missing_case_4']);
    });

    test('Make With is refused on a let binding and on a one-line where definition (the compiler rewrites the text before the = as a clause)', () => {
      assert.match(JSON.stringify(recorded('((:make-with 41 "let_rhs") ')), /let y with \(_\)/);
      refusal(() => planEdit(at('makeWith', 40, 10, 'let_rhs'), blocks), /needs a function clause/);
      const where = fixture('broken/Blocks.idr', 'module Blocks\n\nwh : Nat -> Nat\nwh x = go x\n  where go y = ?where_rhs\n\nlw : Nat -> Nat\nlw n =\n  let y =\n    ?lw_rhs\n  in y\n');
      refusal(() => planEdit(at('makeWith', 4, 15, 'where_rhs'), where), /needs a function clause/);
      refusal(() => planEdit(at('makeWith', 9, 4, 'lw_rhs'), where), /needs a function clause/);
    });
  });

  test('holeRefusal: sent only when the load\'s holes hold one hole of the name, in the request\'s file, at the cursor\'s ?name', () => {
    const file = '/w/Main.idr';
    const hole = (name: string, fsPath: string, line: number, character: number): Hole =>
      ({ name, qualifiedName: `M.${name}`, type: { text: 'Nat', spans: [] }, premises: [], location: { uri: { fsPath }, range: { start: { line, character } } } }) as unknown as Hole;
    const req = { ...search(8, 9, 'h'), doc: { fileName: file } as vscode.TextDocument };
    const token = { start: 8, end: 10 };
    assert.strictEqual(holeRefusal(req, token, [hole('h', file, 8, 8), hole('k', file, 5, 6)], true), undefined);
    for (const [holes, clean, pattern] of [
      [[hole('h', file, 8, 8), hole('h', '/w/Base.idr', 8, 8)], true, /knows 2 holes named \?h/],
      [[hole('h', file, 5, 8)], false, /has not registered this \?h: the file did not load cleanly/],
      [[hole('h', file, 8, 6)], false, /has not registered/],
      [[hole('h', '/w/Base.idr', 8, 8)], false, /has not registered/],
      [[], true, /did not report the hole \?h at this place/],
      [[{ ...hole('h', file, 8, 8), location: undefined }], true, /did not report/],
    ] as const) {
      assert.match(holeRefusal(req, token, holes, clean) ?? 'sent', pattern);
    }
  });

  suite('bird tracks (F11): one marker per line, repaired where the compiler doubles it', () => {
    const lit = fixture('broken/Lit2.lidr');
    const out = (req: EditAtRequest | ExprSearchRequest | RefineRequest, from: number, to: number): string[] =>
      linesOf(applied(lit, edited(result('lit2-editing', lit, req))), from, to);

    test('Case Split keeps a single > (the ROADMAP acceptance); Add Clause and Generate Definition carry one', () => {
      assert.deepStrictEqual(out(at('caseSplit', 8, 7, 'xs'), 9, 10), ['> vlen [] = ?vlen_rhs_0', '> vlen (x :: xs) = ?vlen_rhs_1']);
      assert.deepStrictEqual(out(at('addClause', 10, 3, 'vapp'), 11, 12), ['> vapp : Vect n a -> Vect m a -> Vect (n + m) a', '> vapp xs ys = ?vapp_rhs']);
      assert.deepStrictEqual(out(at('generateDef', 10, 3, 'vapp'), 12, 13), ['> vapp [] ys = ys', '> vapp (x :: xs) ys = x :: vapp xs ys']);
    });

    test('Make Case and Make With: the compiler\'s extra markers removed, the marker put on the new lines (Make Case bracketed)', () => {
      assert.deepStrictEqual(out(at('makeCase', 8, 12, 'vlen_rhs'), 9, 10), ['> vlen xs = (case _ of', '>                 case_val => ?vlen_rhs)']);
      assert.deepStrictEqual(out(at('makeWith', 8, 12, 'vlen_rhs'), 9, 10), ['> vlen xs with (_)', '>   vlen xs | with_pat = ?vlen_rhs_rhs']);
    });

    test('Make Lemma: the type carries the marker; Add Missing Cases gives the clauses the declaration\'s marker', () => {
      assert.deepStrictEqual(out(at('makeLemma', 8, 12, 'vlen_rhs'), 7, 11), ['', '> vlen_rhs : Vect n a -> Nat', '', '> vlen : Vect n a -> Nat', '> vlen xs = (vlen_rhs xs)']);
      assert.deepStrictEqual(out(at('addMissingCases', 13, 3, 'both'), 15, 18), ['> both True True = 1', '> both True False = ?both_missing_case_1', '> both False _ = ?both_missing_case_2', '> ']);
    });

    test('below the line of > and a space (two lines to the compiler): Case Split is refused, naming that line', () => {
      refusal(() => planEdit(at('caseSplit', 17, 7, 'n'), lit), /below line 16, which holds a literate marker followed only by spaces/);
      const two = fixture('broken/Lit2.lidr', joined(lit).replace('> vlen xs = ?vlen_rhs\n>\n', '> vlen xs = ?vlen_rhs\n>  \n'));
      refusal(() => planEdit(at('caseSplit', 17, 7, 'n'), two), /below lines 10 and 16, which hold a literate marker followed only by spaces/);
      const many = fixture('broken/Lit2.lidr', `${'> \n'.repeat(12)}> f : Nat -> Nat\n> f n = ?f_rhs\n`);
      refusal(() => planEdit(at('caseSplit', 13, 2, 'n'), many), /below lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 2 more, which hold/);
    });

    test('below it Add Clause reads a line with the same marker and is sent; the hole commands are sent the file line', () => {
      assert.deepStrictEqual(out(at('addClause', 16, 3, 'half'), 17, 20), ['> half : Nat -> Nat', '> half n = ?half_rhs', '> half k = ?half_rhs', '>']);
      assert.strictEqual(serializeSexp(planEdit(at('makeCase', 17, 11, 'half_rhs'), lit).command), '(:make-case 18 "half_rhs")');
      assert.deepStrictEqual(out(at('makeCase', 17, 11, 'half_rhs'), 18, 19), ['> half n = (case _ of', '>                case_val => ?half_rhs)']);
      assert.deepStrictEqual(out(at('makeWith', 17, 11, 'half_rhs'), 18, 19), ['> half n with (_)', '>   half n | with_pat = ?half_rhs_rhs']);
      assert.deepStrictEqual(out(at('makeLemma', 17, 11, 'half_rhs'), 16, 19), ['> ', '> half_rhs : Nat -> Nat', '', '> half : Nat -> Nat']);
      assert.strictEqual(serializeSexp(planEdit(at('intro', 17, 11, 'half_rhs'), lit).command), '(:intro 19 "half_rhs")');
    });

    test('Add Clause below it is refused when the line the compiler reads for the marker has none', () => {
      const text = fixture('broken/Lit2.lidr', joined(lit).replace('> half n = ?half_rhs', 'Prose.\n\n> half n = ?half_rhs'));
      refusal(() => planEdit(at('addClause', 16, 3, 'half'), text), /below line 16/);
    });

    test('a literate file with a carriage return: the three line-reading commands are refused, the hole commands are not', () => {
      const lines = joined(lit).split('\n');
      const crlf = editText({ fileName: '/fx/broken/Lit2.lidr', languageId: 'lidr', isUntitled: false, lineCount: lines.length, lineAt: (l) => ({ text: lines[l] }) }, lines.join('\r\n'));
      refusal(() => planEdit(at('caseSplit', 8, 7, 'xs'), crlf), /CRLF/);
      refusal(() => planEdit(at('addClause', 10, 3, 'vapp'), crlf), /CRLF/);
      assert.ok(planEdit(at('makeCase', 8, 12, 'vlen_rhs'), crlf));
    });

    test('a make-case answer of another shape is not applied: without the extra markers, or with a case_val line that lost its marker', () => {
      const plan = planEdit(at('makeCase', 8, 12, 'vlen_rhs'), lit);
      refusal(() => plan.decode(textReply('> vlen xs = case _ of\n  case_val => ?vlen_rhs')), /unexpected form; nothing was applied/);
      refusal(() => plan.decode(textReply(`vlen xs = case _ of\n${' '.repeat(17)}case_val => ?vlen_rhs`)), /unexpected form/);
      refusal(() => plan.decode(textReply(`> > vlen xs = case _ of\n${' '.repeat(17)}case_val => ?vlen_rhs`)), /unexpected form/);
      // The recorded shape, as typed: applied.
      assert.strictEqual(plan.decode(textReply(`> > vlen xs = case _ of\n> ${' '.repeat(17)}case_val => ?vlen_rhs`)).type, 'edit');
    });
  });

  suite('Case Split\'s other answer shapes (Absurd.lidr, ImposTab.idr): every constructor impossible, a one-line case', () => {
    const absurd = fixture('broken/Absurd.lidr');
    const tab = fixture('broken/ImposTab.idr');
    const out = (text: EditText, req: EditAtRequest, from: number, to: number): string[] =>
      linesOf(applied(text, edited(result('edits-impossible', text, req))), from, to);

    test('every constructor impossible: each clause gets the line\'s marker and its tab (the compiler indents by leading spaces only)', () => {
      assert.deepStrictEqual(out(absurd, at('caseSplit', 8, 11, 'p'), 8, 11), [
        '> notInNil : Elem x [] -> Void',
        '> notInNil Here impossible',
        '> notInNil (There y) impossible',
        '',
      ]);
      assert.deepStrictEqual(out(tab, at('caseSplit', 13, 3, 'x'), 13, 15), ['\tv : Fin 0 -> Void', '\tv FZ impossible', '\tv (FS x) impossible']);
    });

    test('a one-line case is refused before it is sent (its answer is reshaped from the column after the of on)', () => {
      refusal(() => planEdit(at('caseSplit', 11, 21, 'x'), absurd), /holds the word of/);
      refusal(() => planEdit(at('caseSplit', 11, 17, 'x'), tab), /holds the word of/);
    });

    test('indented with spaces, the impossible clauses keep their indentation', () => {
      const spaced = fixture('broken/ImposTab.idr', joined(tab).replaceAll('\t', '    '));
      const plan = planEdit(at('caseSplit', 13, 6, 'x'), spaced);
      assert.strictEqual(applied(spaced, edited(plan.decode(textReply('    v FZ impossible\n    v (FS x) impossible')))).split('\n')[13], '    v FZ impossible');
      refusal(() => plan.decode(textReply('v (FS x) impossible')), /form that was not expected/);
    });

    test('an answer of another shape is not applied', () => {
      const plan = planEdit(at('caseSplit', 8, 11, 'p'), absurd);
      refusal(() => plan.decode(textReply('notInNil Here impossible\nnotInNil (There y) = ?h')), /form that was not expected/);
      refusal(() => plan.decode(textReply('> notInNil Here = ?h_0\nnotInNil (There y) = ?h_1')), /form that was not expected/);
      refusal(() => plan.decode(textReply('  notInNil Here impossible')), /form that was not expected/);
      // A new line without the line's indentation (as a one-line case's answer has it) is not the line rewritten.
      const tabbed = planEdit(at('caseSplit', 13, 3, 'x'), tab);
      refusal(() => tabbed.decode(textReply('\tv FZ = ?v_rhs_0\n        (FS y) = ?v_rhs_1')), /form that was not expected/);
    });
  });

  suite('Case Split on lines whose answer the compiler reshapes (CaseWords.idr, edits-case-words; edit review of M4)', () => {
    const words = fixture('broken/CaseWords.idr');
    const sent = (line: number, character: number, name: string): string => serializeSexp(planEdit(at('caseSplit', line, character, name), words).command);

    test('the word of in a comment or a string, on a clause or a case alternative: refused (the recorded answers are cut at that column)', () => {
      // Recorded: `vlen [] = ?vlen_rhs_0 -- the length of the vector` / `<spaces>length of the vector`.
      refusal(() => planEdit(at('caseSplit', 9, 5, 'xs'), words), /holds the word of/);
      refusal(() => planEdit(at('caseSplit', 12, 5, 'xs'), words), /holds the word of/);
      refusal(() => planEdit(at('caseSplit', 24, 7, 'y'), words), /holds the word of/);
      // A word that only contains it is another name to the compiler's line reader.
      const proofs = fixture('broken/CaseWords.idr', joined(words).replace('-- the length of the vector', '-- proofs of\'s offset'));
      assert.ok(planEdit(at('caseSplit', 9, 5, 'xs'), proofs));
      refusal(() => planEdit(at('caseSplit', 9, 5, 'xs'), fixture('broken/CaseWords.idr', joined(words).replace('-- the length of the vector', '-- 1of'))), /word of/);
    });

    test('a hole in parentheses: refused (recorded: the first new line loses its )); a ) that closes an earlier line\'s bracket is the compiler\'s case', () => {
      refusal(() => planEdit(at('caseSplit', 16, 6, 'xs'), words), /followed by a closing parenthesis/);
      const commented = fixture('broken/CaseWords.idr', joined(words).replace('paren xs = (?paren_rhs)', 'paren xs = (?paren_rhs) -- see (1)'));
      refusal(() => planEdit(at('caseSplit', 16, 6, 'xs'), commented), /followed by a closing parenthesis/);
      assert.strictEqual(sent(33, 15, 'case_val'), '(:case-split 34 16 "case_val")');
      assert.deepStrictEqual(linesOf(applied(words, edited(result('edits-case-words', words, at('caseSplit', 33, 15, 'case_val')))), 33, 35), [
        'closing n = (case n of',
        '               0 => ?closing_rhs_0',
        '               (S k) => ?closing_rhs_1)',
      ]);
      // A ) after it on the line would be the one the compiler drops.
      const after = fixture('broken/CaseWords.idr', joined(words).replace('case_val => ?closing_rhs)', 'case_val => ?closing_rhs) -- (x)'));
      refusal(() => planEdit(at('caseSplit', 33, 15, 'case_val'), after), /followed by a closing parenthesis/);
    });

    test('a string holding a name of the clause, or a hole: refused (recorded: rewritten inside the string)', () => {
      refusal(() => planEdit(at('caseSplit', 19, 6, 'xs'), words), /a string on this line holds a name of the clause or a hole/);
      const hole = fixture('broken/CaseWords.idr', joined(words).replace('named xs "xs" = ?named_rhs', 'named xs "?h" = ?named_rhs'));
      refusal(() => planEdit(at('caseSplit', 19, 6, 'xs'), hole), /a string on this line/);
      const other = fixture('broken/CaseWords.idr', joined(words).replace('named xs "xs" = ?named_rhs', 'named xs "ys" = ?named_rhs'));
      assert.strictEqual(serializeSexp(planEdit(at('caseSplit', 19, 6, 'xs'), other).command), '(:case-split 20 7 "xs")');
      // A raw string too (recorded live: `f [] #"[]"# = ?f_rhs_0`; M4's third review of the fixes).
      const raw = fixture('broken/R.idr', 'module R\n\nf : List Nat -> String -> Nat\nf xs #"xs"# = ?f_rhs\n');
      refusal(() => planEdit(at('caseSplit', 3, 2, 'xs'), raw), /a string on this line holds a name of the clause or a hole/);
    });

    test('Make Case\'s case_val is split as the compiler answers', () => {
      assert.deepStrictEqual(linesOf(applied(words, edited(result('edits-case-words', words, at('caseSplit', 29, 15, 'case_val')))), 29, 31), [
        'made xs = case xs of',
        '               [] => ?made_rhs_0',
        '               (x :: ys) => ?made_rhs_1',
      ]);
    });
  });

  suite('names a clause or a type reuses (Shadow.idr, edits-shadowing; eighth review of M4)', () => {
    const shadow = fixture('broken/Shadow.idr');
    const sent = (req: EditAtRequest): string => serializeSexp(planEdit(req, shadow).command);

    test('Case Split where a braced named argument is matched with a variable of its own name: refused (recorded: {n = 0 = 0}); {n} is split', () => {
      for (const req of [at('caseSplit', 10, 13, 'xs'), at('caseSplit', 10, 10, 'n'), at('caseSplit', 21, 24, 'y'), at('caseSplit', 21, 17, 'x')]) {
        refusal(() => planEdit(req, shadow), /named argument on this line is matched with a variable of its own name/);
      }
      // The recorded answer the refusal spares the file (to the request a plan sends at that place).
      assert.match(JSON.stringify(answer('edits-shadowing', planEdit(at('caseSplit', 10, 13, 'xs'), fixture('broken/Shadow.idr', joined(shadow).replace('{n = n}', '{n = m}'))))), /vlen \{n = 0 = 0\} \[\]/);
      assert.deepStrictEqual(linesOf(applied(shadow, edited(result('edits-shadowing', shadow, at('caseSplit', 13, 10, 'xs')))), 14, 15), [
        'vlen2 {n = 0} [] = ?vlen2_rhs_0',
        'vlen2 {n = (S len)} (x :: xs) = ?vlen2_rhs_1',
      ]);
      // Another name (a field matched with another variable, a swap, two fields of one name, one in a string or comment).
      const variant = (from: string, to: string): EditText => fixture('broken/Shadow.idr', joined(shadow).replace(from, to));
      assert.ok(planEdit(at('caseSplit', 10, 13, 'xs'), variant('{n = n}', '{n = m}')));
      refusal(() => planEdit(at('caseSplit', 21, 24, 'x'), variant('{x = x, y = y}', '{x = y, y = x}')), /named argument/);
      assert.ok(planEdit(at('caseSplit', 21, 24, 'b'), variant('fields (MkP {x = x, y = y})', 'fields (MkP {x = a, y = b})')));
      assert.ok(planEdit(at('caseSplit', 10, 13, 'xs'), variant('vlen {n = n} xs = ?vlen_rhs', 'vlen {n = m} xs = ?vlen_rhs -- {n = n}')));
      assert.ok(planEdit(at('caseSplit', 10, 15, 'xs'), variant('vlen {n = n} xs', 'vlen @{n = n} xs')), 'an auto-implicit is not a named argument to the compiler');
      refusal(() => planEdit(at('caseSplit', 21, 24, 'y'), variant('{x = x, y = y}', '{x = (a, b), y = y}')), /named argument/);
      assert.ok(planEdit(at('caseSplit', 21, 24, 'y'), variant('{x = x, y = y}', '{x = (y, b), z = c}')), 'a comma inside parentheses separates no named arguments');
    });

    test('Add Clause and Generate Definition whose clause names an argument like the function: refused (recorded: f f = ?f_rhs, j k j = j)', () => {
      assert.strictEqual(sent(at('addClause', 23, 0, 'f')), '(:add-clause 24 "f")');
      refusal(() => result('edits-shadowing', shadow, at('addClause', 23, 0, 'f')), /named an argument like the function/);
      refusal(() => result('edits-shadowing', shadow, at('addClause', 25, 0, 'j')), /named an argument like the function/);
      refusal(() => result('edits-shadowing', shadow, at('generateDef', 25, 0, 'j')), /named an argument like the function/);
      // Next Definition too; a name only on the right-hand side, a qualified one or another function's is no shadow.
      const next = planNext('generateDefNext', shadow, { start: { line: 26, character: 0 }, end: { line: 26, character: 0 } });
      refusal(() => next.decode(textReply('j k j = k')), /named an argument like the function/);
      assert.strictEqual(next.decode(textReply('j k i = j k i')).type, 'edit');
      const plan = planEdit(at('addClause', 25, 0, 'j'), shadow);
      assert.strictEqual(plan.decode(textReply('j (S Prelude.j) k = ?j_rhs')).type, 'edit');
      refusal(() => plan.decode(textReply('j (S j) k = ?j_rhs')), /named an argument like the function/);
      assert.strictEqual(plan.decode(textReply('j k i = ?j_rhs')).type, 'edit');
    });

    test('Make With on a clause without a space before its =: the answer gets one before with and | (recorded: mw xwith (_))', () => {
      assert.deepStrictEqual(linesOf(applied(shadow, edited(result('edits-shadowing', shadow, at('makeWith', 28, 7, 'mw_h')))), 29, 30), [
        'mw x with (_)',
        '  mw x | with_pat = ?mw_h_rhs',
      ]);
      // With the space, nothing is added.
      const spaced = planEdit(at('makeWith', 28, 7, 'mw_h'), fixture('broken/Shadow.idr', joined(shadow).replace('mw x= ?mw_h', 'mw x = ?mw_h')));
      assert.deepStrictEqual(edited(spaced.decode(textReply('mw x with (_)\n  mw x | with_pat = ?mw_h_rhs')))[0].text, 'mw x with (_)\n  mw x | with_pat = ?mw_h_rhs');
    });

    test('Intro on a hole applied to an argument: the compiler\'s lambda over a qualified name is not applied (recorded: \\Shadow.argTy => ?g_0)', () => {
      refusal(() => result('edits-shadowing', shadow, at('intro', 31, 9, 'g')), /lambda whose argument has a qualified name/);
      const plan = planEdit(at('intro', 31, 9, 'g'), shadow);
      const both: ReplyPayload = { kind: 'ok', result: { kind: 'list', items: [{ kind: 'string', value: '\\A.x => ?g_0' }, { kind: 'string', value: '\\x => ?g_0' }] }, highlighting: [] };
      const decoded = plan.decode(both);
      assert.deepStrictEqual(decoded.type === 'choices' ? decoded.choices.map((c) => c.label) : decoded, ['\\x => ?g_0']);
    });
  });

  suite('answers in place: in parentheses unless one token, wherever the hole is; Make Case in the bracketed form (user decision, 2026-10-01)', () => {
    const op = (body: string): EditText => fixture('broken/Op.idr', `module Op\n\n${body}\n`);
    const introReply = (...candidates: string[]): ReplyPayload => ({ kind: 'ok', result: { kind: 'list', items: candidates.map((value) => ({ kind: 'string', value })) }, highlighting: [] });
    /** The text that replaces `?name` on line 3 when `reply` answers `req` there. */
    const put = (text: EditText, req: (character: number) => EditAtRequest | ExprSearchRequest | RefineRequest, reply: ReplyPayload): string[] => {
      const r = planEdit(req(text.lines[3].indexOf('?')), text).decode(reply);
      return r.type === 'choices' ? r.choices.map((c) => c.replacements[0].text) : edited(r).map((x) => x.text);
    };
    /** The line and column of the hole `?h` in `text`. */
    const holeOf = (text: EditText): EditorPosition => {
      const line = text.lines.findIndex((l) => /\?h(?![\w'])/u.test(l));
      return { line, character: /\?h(?![\w'])/u.exec(text.lines[line])?.index ?? -1 };
    };
    /** The text Refine Hole puts in place of `?h` in `text` when the compiler answers `answer`. */
    const refinedIn = (text: EditText, answer: string): string => {
      const h = holeOf(text);
      return edited(planEdit(refineAt(h.line, h.character, 'h', 'x'), text).decode(textReply(answer)))[0].text;
    };
    const refined = (body: string, answer = '\\y => ?h_0 + y'): string => refinedIn(op(body), answer);
    /** Make Case's plan at `?h` in `body`. */
    const mc = (body: string): EditPlan => {
      const text = op(body);
      const h = holeOf(text);
      return planEdit(at('makeCase', h.line, h.character, 'h'), text);
    };

    test('the live repros: an answer next to an operator, an argument or a projection is put in parentheses (ninth to twelfth reviews of M4)', () => {
      // (1) inc xs = ?f <$> xs, Intro: the one candidate.
      assert.deepStrictEqual(put(op('inc : List Nat -> List Nat\ninc xs = ?f <$> xs'), (c) => at('intro', 3, c, 'f'), introReply('\\arg => ?f_0')), ['(\\arg => ?f_0)']);
      // (2) g = ?k . S, Proof Search, then Next where the first result went.
      const g = op('g : Nat -> Nat\ng = ?k . S');
      const first = planEdit(search(3, 4, 'k'), g).decode(textReply('\\k => k'));
      assert.deepStrictEqual(edited(first).map((x) => x.text), ['(\\k => k)']);
      const after = fixture('broken/Op.idr', applied(g, edited(first)));
      assert.strictEqual(after.lines[3], 'g = (\\k => k) . S');
      const next = planNext('exprSearchNext', after, followed(edited(first)[0])).decode(textReply('\\k => 0'));
      assert.strictEqual(applied(after, edited(next)).split('\n')[3], 'g = (\\k => 0) . S');
      // (3) f x = ?h * 2, Refine Hole with (+).
      assert.deepStrictEqual(put(op('f : Nat -> Nat\nf x = ?h * 2'), (c) => refineAt(3, c, 'h', '(+)'), textReply('?h_0 + ?h_1')), ['(?h_0 + ?h_1)']);
      // (4) app xs ys = ?h ++ ys, Intro: only the candidate of more than one token.
      assert.deepStrictEqual(put(op('app : List a -> List a -> List a\napp xs ys = ?h ++ ys'), (c) => at('intro', 3, c, 'h'), introReply('[]', '?h_0 :: ?h_1')), ['[]', '(?h_0 :: ?h_1)']);
      // `f r = ?h .foo` and `?h` / `  .foo`: `MkR ?h_0 .foo` fails to check, `(MkR ?h_0) .foo` checks [live, twelfth review];
      // a `.foo` that starts the next line at column 0 projects too, also after a comment and a blank line (bare, the
      // check fails unifying `R` with `Nat`; the bracketed form checks [live, round 15]).
      for (const rest of ['.foo', ' .foo', '\n  .foo', '\n.foo', '\n-- c\n\n.foo', '\n{- c -}\n.foo']) {
        const pj = op(`record R where\n  constructor MkR\n  foo : Nat\n\nf : R -> Nat\nf r = ?h${rest}`);
        assert.deepStrictEqual(put(pj, () => at('intro', 7, 6, 'h'), introReply('MkR ?h_0')), ['(MkR ?h_0)'], rest);
      }
      // `\arg => ?h_0 = f` fails to check, `(\arg => ?h_0) = f` checks; `t = \arg => ?h_0` / `  \x => x` fails [live, twelfth review].
      assert.deepStrictEqual(put(op('-- c\nprf : (f : Nat -> Nat) -> ?h = f'), (c) => at('intro', 3, c, 'h'), introReply('\\arg => ?h_0')), ['(\\arg => ?h_0)']);
      assert.deepStrictEqual(put(op('t : Nat\nt = ?h\n  \\x => x'), (c) => at('intro', 3, c, 'h'), introReply('\\arg => ?h_0')), ['(\\arg => ?h_0)']);
    });

    test('one token, as it is: a name, a qualified name, a literal, a hole, an operator in parentheses, one bracketed group', () => {
      for (const answer of [
        'x', "x'", 'Prelude.Types.Nat', 'Z', '42', '0x1F', '"a string with spaces"', '"a \\"quoted\\" (b"', "'c'", "' '", '?h_0',
        '(+)', '( <&&> )', '(::)', '(S ?h_0)', '[1, 2]', '[]', '()', '(a, (b, c))', '[<1, 2]', '[| f x |]', '(f (g [x]))',
        // Strings with interpolations and raw strings (second review of the fixes).
        '"a \\{x + y} b"', '"\\{f "}"}"', '#"a"b"#', '##"a"#b"##', '#"\\#{x}"#',
      ]) {
        assert.strictEqual(refined('f : Nat -> Nat\nf x = ?h * 2', answer), answer, answer);
      }
    });

    test('anything else in parentheses: more than one token or none, brackets that do not match or are left open or closed unopened, text not read to its end, a symbol or keyword', () => {
      for (const answer of [
        'S Z', '(a) + (b)', '(a) (b)', '-1', 'f x', '\\x => x', '?h_0 :: ?h_1', 'x.y z', '[1] ++ [2]', '"a" ++ "b"', 'x {- c -} y', '`div`',
        '(a]', '([a)]', '([a)])', 'x (a', '(a', 'a)', '(a))', 'x -- c', 'x "open', 'x {- open', '||| doc', '+', 'do', '%inline',
      ]) {
        assert.strictEqual(refined('f : Nat -> Nat\nf x = ?h * 2', answer), `(${answer})`, answer);
      }
      // No token at all: refused (`()` would be the unit value), by every route.
      const text = op('f : Nat -> Nat\nf x = ?h * 2');
      for (const answer of ['', '   ', '{- no token -}', '-- c']) {
        refusal(() => refined('f : Nat -> Nat\nf x = ?h * 2', answer), /^Refine Hole: the compiler's answer holds no expression; nothing was applied\.$/);
        refusal(() => planEdit(search(3, 6, 'h'), text).decode(textReply(answer)), /^Proof Search: the compiler's answer holds no expression/);
        refusal(() => planEdit(at('intro', 3, 6, 'h'), text).decode(introReply('0', answer)), /^Intro: the compiler's answer holds no expression/);
      }
      // (A call with words in a comment is refused earlier, as passing names the code does not have.)
      for (const answer of ['', '   ']) {
        refusal(() => planEdit(at('makeLemma', 3, 6, 'h'), text).decode(lemmaReply(answer, 'h : Nat -> Nat')), /^Make Lemma: the compiler's answer holds no expression/);
      }
    });

    test('a token that would join the text next to it is put in parentheses too: after a name\'s character, before a . (review of the decisions of 2026-10-01)', () => {
      // `f x = g?h` (`g ?h` to the lexer) with Proof Search's `x` gave `f x = gx`, which checks when a `gx` exists;
      // `g(x)` and `(Rr).foo` check [live, M4's review of the decisions].
      for (const [body, answer, put] of [
        ['f : Nat -> Nat\nf x = g?h', 'x', '(x)'],
        ['f : Nat -> Nat\nf x = S?h', '0', '(0)'],
        ["f : Nat -> Nat\nf x = g'?h", "'c'", "('c')"],
        ['f : Nat -> Nat\nf x = g_?h', '_', '(_)'],
        ['f : Nat -> Nat\nf 𝑥 = 𝑥?h', 'x', '(x)'],
        ['f : Nat -> Nat\nf x = é?h', 'x', '(x)'],
        ['f : Nat -> Nat\nf x = g?h', '𝑥', '(𝑥)'],
        ['f : R -> Nat\nf r = ?h.foo', 'Rr', '(Rr)'],
        ['f : R -> Nat\nf r = ?h.foo', 'r', '(r)'],
        ['f : R -> Nat\nf r = ?h.foo', 'r𝑥', '(r𝑥)'],
        // A postfix projection is one token to the lexer, but the parser applies it to the expression before it, space or
        // not (`simpleExpr`, `Idris/Parser.idr` 572–581 [src]): with `(.x) f = f . f`, `h = three .x S 0` checks as `h =
        // 9` and `h = three (.x) S 0` as `h = 8`; with a record field `x`, `h = g .x` and `h = g.x` fail (`Mismatch
        // between: (R -> Nat) -> Nat and R`), `g (.x)` and `g(.x)` check [live, idris2 0.8.0, final review of the
        // convergence pass]. In parentheses wherever the hole is; the compiler's `(.x)` as it is.
        ['h : Nat\nh = three ?h S 0', '.x', '(.x)'],
        ['h : Nat\nh = g ?h', '.x', '(.x)'],
        ['h : Nat\nh = g?h', '.x', '(.x)'],
        ['h : Nat\nh = ?h', '.x', '(.x)'],
        ['h : Nat\nh = g ?h', '(.x)', '(.x)'],
        // A token that cannot join the name or the `.`: as it is (no second pair around the compiler's own).
        ['f : Nat -> Nat\nf x = g1?h', '"s"', '"s"'],
        ['f : Nat -> Nat\nf x = g?h', '?h_0', '?h_0'],
        ['f : Nat -> Nat\nf x = g?h', '(S ?h_0)', '(S ?h_0)'],
        ['f : R -> Nat\nf r = ?h.foo', '(MkR 1)', '(MkR 1)'],
        ['f : R -> Nat\nf r = ?h.foo', '"s"', '"s"'],
        ['f : Nat -> Nat\nf x = g ?h', 'x', 'x'],
        ['f : Nat -> Nat\nf x = g(?h)', 'x', 'x'],
        ['f : Nat -> Nat\nf x = [<?h]', 'x', 'x'],
        ['f : Nat -> Nat\nf x = ?h .foo', 'x', 'x'],
        ['f : Nat -> Nat\nf x = ?h', 'x', 'x'],
        ['f : Nat\n?h', 'x', 'x'],
        // A string next to a ": the first string would not end there (`g "a""x"`: Bracket is not properly closed [live,
        // second review of the fixes]); also a raw string's end; not with white space between, nor a name, nor a raw
        // string after a " (`g "x"#"a"#` checks, `f = "xa"` by Refl [live, same review]).
        ['f : String\nf = g ?h"x"', '"a"', '("a")'],
        ['f : String\nf = g "x"?h', '"a"', '("a")'],
        ['f : String\nf = g ?h"x"', '#"a"#', '(#"a"#)'],
        ['f : String\nf = g ?h "x"', '"a"', '"a"'],
        ['f : String\nf = g "x" ?h', '"a"', '"a"'],
        ['f : String\nf = g ?h"x"', 'x', 'x'],
        ['f : String\nf = g "x"?h', '#"a"#', '#"a"#'],
        // After a backtick, a space before a bracket, which would open a quotation (`` `( ``, `` `[ ``, `` `{ ``):
        // `` f x = x `div`?h `` loads, `` x `div`(id 1) `` gives `Not the end of a block entry`, `` x `div` (id 1) `` loads
        // [live, M4's convergence pass, BT1–BT3.idr]. Not after a space, and not before a token that is no bracket.
        ['f : Integer -> Integer\nf x = x `div`?h', 'id 1', ' (id 1)'],
        ['f : Integer -> Integer\nf x = x `div`?h', '(id 1)', ' (id 1)'],
        ['f : Integer -> Integer\nf x = x `div`?h', '[1]', ' [1]'],
        ['f : Integer -> Integer\nf x = x `div`?h', '{x = 1}', ' {x = 1}'],
        ['f : Integer -> Integer\nf x = x `div` ?h', 'id 1', '(id 1)'],
        ['f : Integer -> Integer\nf x = x `div`?h', 'y', 'y'],
        ['f : Integer -> Integer\nf x = x `div`?h', '?h_0', '?h_0'],
      ] as const) {
        const text = op(body);
        const h = holeOf(text);
        assert.deepStrictEqual(edited(planEdit(search(h.line, h.character, 'h'), text).decode(textReply(answer))).map((r) => r.text), [put], body);
      }
      // Next Result after a backtick: the previous result, its space included, is replaced the same way.
      const tick = op('f : Integer -> Integer\nf x = x `div`?h');
      const firstTick = edited(planEdit(search(3, 13, 'h'), tick).decode(textReply('id 1')));
      const afterTick = fixture('broken/Op.idr', applied(tick, firstTick));
      assert.strictEqual(afterTick.lines[3], 'f x = x `div` (id 1)');
      assert.strictEqual(applied(afterTick, edited(planNext('exprSearchNext', afterTick, followed(firstTick[0])).decode(textReply('id 2')))).split('\n')[3], 'f x = x `div` (id 2)');
      // A hole right after a raw string's "# is not found (`#?` read as an operator), though the compiler reads one there
      // (`f = g #"x"#?h` loads [live, M4's convergence pass, RS1.idr]): refused as off a hole, so no string joins its end.
      refusal(() => planEdit(search(3, 11, 'h'), op('f : String\nf = g #"x"#?h')), /^Proof Search needs the cursor on the hole \?h\.$/);
      // Every route: Intro, Refine Hole's text and alternatives, Make Lemma's call, Next Result.
      const g = op('f : Nat -> Nat\nf x = g?h');
      const intro = planEdit(at('intro', 3, 7, 'h'), g).decode(introReply('0', 'S ?h_0'));
      assert.deepStrictEqual(intro.type === 'choices' && intro.choices.map((c) => [c.label, c.replacements[0].text]), [['0', '(0)'], ['S ?h_0', '(S ?h_0)']]);
      assert.deepStrictEqual(edited(planEdit(refineAt(3, 7, 'h', 'x'), g).decode(textReply('x'))).map((r) => r.text), ['(x)']);
      const ambiguity: ReplyPayload = { kind: 'error', message: 'Ambiguous elaboration. Possible results:\n    Op.A.foo\n    Op.B.foo\n\n', highlighting: [] };
      const alternatives = planEdit(refineAt(3, 7, 'h', 'foo'), g).decode(ambiguity);
      assert.deepStrictEqual(alternatives.type === 'choices' && alternatives.choices.map((c) => c.replacements[0].text), ['(Op.A.foo)', '(Op.B.foo)']);
      assert.deepStrictEqual(edited(planEdit(at('makeLemma', 3, 7, 'h'), g).decode(lemmaReply('h', 'h : Nat'))).map((r) => r.text).slice(-1), ['(h)']);
      const first = edited(planEdit(search(3, 7, 'h'), g).decode(textReply('x')));
      const after = fixture('broken/Op.idr', applied(g, first));
      assert.strictEqual(after.lines[3], 'f x = g(x)');
      const next = planNext('exprSearchNext', after, followed(first[0]));
      assert.strictEqual(applied(after, edited(next.decode(textReply('Z')))).split('\n')[3], 'f x = g(Z)');
      const dot = fixture('broken/Op.idr', 'module Op\n\nf : R -> Nat\nf r = (r).foo\n');
      assert.strictEqual(applied(dot, edited(planNext('exprSearchNext', dot, { start: { line: 3, character: 6 }, end: { line: 3, character: 9 } }).decode(textReply('Rr')))).split('\n')[3], 'f r = (Rr).foo');
    });

    test('at the head of an idiom bracket only a name, a hole or a lambda is put: the bracket reads an application there as applicative, parentheses or not (third review of the fixes)', () => {
      // `i = [| ?h |]`: Intro's `S ?h_0` gave `[| (S ?h_0) |]`, which loads with `?h_0 : Maybe Nat` [live, M4's third review of
      // the fixes]; `[| 0 |]` does not check (`Integer` and `Maybe Integer`), `[| Z |]` is `Just Z`, and Intro on the `?h` of
      // `[| ?h x |]` offers `\arg => ?h_0` [live, M4's convergence pass, ID4.idr, ID5.idr].
      const at3 = (text: EditText, answer: string): string[] => {
        const h = holeOf(text);
        return edited(planEdit(search(h.line, h.character, 'h'), text).decode(textReply(answer))).map((r) => r.text);
      };
      const heads = [
        'i : Maybe Nat\ni = [| ?h |]',
        'i : Maybe Nat\ni = [|?h|]',
        'j : Maybe Nat\nj = [| ?h x |]',
        'j : Maybe Nat\nj = [| ( (?h x) y) |]',
        'j : Maybe Nat\nj = M.[| ?h |]',
        'j : Maybe Nat\nj = [| f x |] <|> [| ?h |]',
      ];
      for (const body of heads) {
        for (const answer of ['S ?h_0', '0', '(?h_0, ?h_1)', '[1]', '"s"', '?h_0 + 1', '(+)', 'f $ x']) {
          refusal(() => at3(op(body), answer), /^Proof Search: the hole is at the head of an idiom bracket \[\| … \|\], which reads an application there as applicative, parentheses or not .*nothing was applied\. Only a name, a hole or a lambda is put there\./);
        }
        for (const [answer, put] of [['x', 'x'], ['Prelude.Types.Z', 'Prelude.Types.Z'], ['?h_0', '?h_0'], ['\\arg => ?h_0', '(\\arg => ?h_0)'], ['\\case _ => 1', '(\\case _ => 1)']]) {
          assert.deepStrictEqual(at3(op(body), answer), [put], `${body} ${answer}`);
        }
      }
      // Every route: Intro (the whole answer), Refine Hole's text and alternatives, Make Lemma's call, Next Result.
      const text = op(heads[0]);
      refusal(() => planEdit(at('intro', 3, 7, 'h'), text).decode(introReply('0', 'S ?h_0')), /^Intro: the hole is at the head of an idiom bracket/);
      refusal(() => planEdit(refineAt(3, 7, 'h', 'S'), text).decode(textReply('S ?h_0')), /^Refine Hole: the hole is at the head of an idiom bracket/);
      const ambiguous: ReplyPayload = { kind: 'error', message: 'Ambiguous elaboration. Possible results:\n    Op.A.foo ?h_0\n    Op.B.foo ?h_0\n\n', highlighting: [] };
      refusal(() => planEdit(refineAt(3, 7, 'h', 'foo'), text).decode(ambiguous), /^Refine Hole: the hole is at the head of an idiom bracket/);
      const bound = op('i : Nat -> Maybe Nat\ni x = [| ?h |]');
      refusal(() => planEdit(at('makeLemma', 3, 9, 'h'), bound).decode(lemmaReply('h x', 'h : Nat -> Nat')), /^Make Lemma: the hole is at the head of an idiom bracket/);
      assert.deepStrictEqual(edited(planEdit(at('makeLemma', 3, 9, 'h'), bound).decode(lemmaReply('h', 'h : Nat'))).map((r) => r.text).slice(-1), ['h']);
      const first = edited(planEdit(search(3, 7, 'h'), text).decode(textReply('x')));
      const after = fixture('broken/Op.idr', applied(text, first));
      refusal(() => planNext('exprSearchNext', after, followed(first[0])).decode(textReply('S x')), /^Next Result: the hole is at the head of an idiom bracket/);
      assert.strictEqual(applied(after, edited(planNext('exprSearchNext', after, followed(first[0])).decode(textReply('y')))).split('\n')[3], 'i = [| y |]');
      // Not at the head: an argument, an operand, a bracket closed before the hole: in parentheses, as anywhere. The
      // bracket on the line above, or one a comment separates from the hole, is not seen (a limitation, documented).
      for (const body of [
        'j : Maybe Nat\nj = [| f ?h |]',
        'j : Maybe Nat\nj = [| x + ?h |]',
        'j : Maybe Nat\nj = [| f x |] <|> ?h',
        'j : Maybe Nat\nj = [| f (g ?h) |]',
        'j : Maybe Nat\nj = [|\n  ?h x |]',
        'j : Maybe Nat\nj = [| {- c -} ?h x |]',
      ]) {
        assert.deepStrictEqual(at3(op(body), 'S ?h_0'), ['(S ?h_0)'], body);
      }
    });

    test('a block that the rest of the hole\'s line opens, which the lines below are read against: Make Case and the answers in place are refused unsent (review of the decisions of 2026-10-01)', () => {
      const kinds = [
        (l: number, c: number) => at('makeCase', l, c, 'h'),
        (l: number, c: number) => at('intro', l, c, 'h'),
        (l: number, c: number) => refineAt(l, c, 'h', 'S'),
        (l: number, c: number) => search(l, c, 'h'),
        (l: number, c: number) => at('makeLemma', l, c, 'h'),
      ];
      const planned = (text: EditText): (() => EditPlan)[] => {
        const h = holeOf(text);
        return kinds.map((k) => () => planEdit(k(h.line, h.character), text));
      };
      const refused = /the text put in place of the hole moves the rest of this line, and with it the column of a block that starts there/;
      const sp = (n: number): string => ' '.repeat(n);
      // [live, M4's review of the decisions] `+ 2` in column 23 is in the alternative (`f 0` is 30 with `10` for the hole);
      // after Make Case's text or Intro's `(S ?h_0)` it is outside it (12), from `(?h)` too; an aligned next entry of a
      // `where` or a `\case` stops parsing (`Not the end of a block entry`).
      for (const body of [
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n                       + 2',
        'f : Nat -> Nat\nf x = (?h) * case x of _ => 1\n                         + 2',
        'f : Nat -> Nat\nf x = ?h + y where y : Nat\n                   y = 1',
        'f : Nat -> Nat\nf = ?h . \\case Z => 1\n               S k => k',
        // The other openers; a comment after the entry; a line below after a blank and a comment line; one more indented
        // than the hole; a line that ends a block comment the hole's line opened.
        'f : List Nat\nf = ?h ++ do [1]\n             ++ [2]',
        'f : Nat -> Nat\nf x = ?h + let y = 1\n               z = 2 in y + z',
        'f : Maybe Nat -> Maybe Nat\nf m = do Just x <- ?h | Nothing => Nothing\n                         | Just _ => Nothing\n         pure x',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1 -- c\n                       + 2',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n\n  -- c\n                       + 2',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n       + 2',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1 {- c\n -}                    + 2',
        // Columns count code points: 𝑥 is one column, two UTF-16 units.
        'f : Nat -> Nat\nf 𝑥 = ?h * case 𝑥 of _ => 1\n       + 2',
        // A first entry that is an empty bracket group: `f ()` is 30 in the original, 12 after Intro's or Make Case's
        // text [live, M4's review of the fixes; also with `[]`].
        `f : () -> Nat\nf u = ?h * case u of () => 1\n${sp(24)}+ 2`,
        `f : List Nat -> Nat\nf xs = ?h * case xs of [] => 1\n${sp(26)}+ 2`,
        `f : List Nat -> Nat\nf = ?h . \\case [] => 0\n${sp(18)}+ 1`,
        `f : SnocList Nat -> Nat\nf = ?h . \\case [<] => 0\n${sp(19)}+ 1`,
        `f : List Nat -> Nat\nf xs = ?h + let [] = xs | [] => 0\n${sp(30)}+ 1`,
        // A qualified do, one name to the lexer (`f 0` 20 → 2, and 30 → 12 with `M.do` [live]).
        `f : Nat -> Nat\nf x = ?h * Prelude.do x\n${sp(23)}+ 2`,
        `namespace M\n  export\n  z : Nat\n  z = 0\n\nf : Nat -> Nat\nf x = ?h * M.do 1\n${sp(18)}+ 2`,
        // An entry after `;` in a block opened before the hole (`(f 0, f 1)` is (10, 3), after Intro's text (12, 3) [live]).
        `f : Nat -> Nat\nf x = case x of Z => ?h; _ => 1\n${sp(27)}+ 2`,
        // An opener in a string's `\{…}` that goes on below (`"30"` → `"012"` [live]); a declaration quote; a `|` that
        // ends the line.
        `f : Nat -> String\nf x = ?h ++ "\\{show $ 10 * case x of _ => 1\n${sp(39)}+ 2}"`,
        `f : Nat\nf = ?h \`[ g : Nat\n${sp(12)}g = 1 ]`,
        `f : Maybe Nat -> Nat\nf m = let Just y = ?h |\n${sp(24)}Nothing => 0 in y`,
        // The first token below after a block comment or another Idris space (`f 0` 30 → 12 with the comment [live]),
        // also after a comment that starts above it.
        `f : Nat -> Nat\nf x = ?h * case x of _ => 1\n  {- c -}${sp(15)}+ 2`,
        `f : Nat -> Nat\nf x = ?h * case x of _ => 1\n{- c -}${sp(16)}+ 2`,
        `f : Nat -> Nat\nf x = ?h * case x of _ => 1\n\u00a0${sp(22)}+ 2`,
        `f : Nat -> Nat\nf x = ?h * case x of _ => 1\n{- note\n   -}${sp(20)}+ 2`,
        `f : Nat -> Nat\nf x = ?h * case x of _ => 1\n{- note\n   more\n   -}${sp(20)}+ 2`,
        // The hole's line read from what is open at its start: here a multi-line string, in which `{-` opens no comment.
        `f : Nat -> String\nf x = \"\"\"\n  {- \\{show $ ?h * case x of _ => 1\n${sp(34)}+ 2}\n  \"\"\"`,
        // A line below that starts inside a multi-line string: what follows its end is not read here.
        `f : Nat -> String\nf x = ?h ++ case x of _ => \"\"\"\n  text\n  \"\"\"${sp(20)}++ "a"`,
        // Interpolations read as the lexer reads them, as code (second review of the fixes): a character literal or a
        // comment holding a " ("10360" → "1235342" with Intro's width [live]), and a block comment going on below
        // ("1030" → "123512" [live]), do not end the string.
        `f : Nat -> String\nf x = g ?h ++ "\\{show (10 * case x of _ => ord '"'\n${sp(40)}+ 2)}"`,
        `f : Nat -> String\nf x = g ?h ++ "\\{show (10 * case x of _ => 34 -- "\n${sp(40)}+ 2)}"`,
        `f : Nat -> String\nf x = g ?h ++ "\\{show (10 * case x of _ => 1 {- c\n-}${sp(38)}+ 2)}"`,
        `f : Nat -> String\nf x = ?h ++ #"\\#{show $ 10 * case x of _ => 1\n${sp(39)}+ 2}"#`,
        // A hole inside an interpolation: the rest of its line is read from there, the string's text not as code
        // ("10--30" → "10--12" [live]; the comment's " alike, the elaborator printing another term [live]).
        `f : Nat -> String\nf x = "\\{natStr ?h}--\\{natStr $ 10 * case x of _ => 1\n${sp(50)}+ 2}"`,
        `f : Nat -> String\nf x = "\\{natStr ?h}{-\\{natStr $ 10 * case x of _ => 1\n${sp(50)}+ 2}"`,
        `f : Nat -> String\nf x = \"\"\"\n  \\{natStr ?h} -- \\{natStr $ 10 * case x of _ => 1\n${sp(46)}+ 2}\n  \"\"\"`,
        `f : Nat -> Nat\nf x = length "\\{show ?h}" * case x of _ => 1 -- 5" wide\n${sp(40)}+ 2`,
        // ...and with an escaped quote in a later string (f () = 6 → 4 [live]).
        `f : () -> Nat\nf u = length "xy\\{the String ?h}" * case u of () => length "\\""\n${sp(48)}+ 2`,
        // Raw strings, whose " is text (150 → 92 [live]).
        `f : Nat -> Nat\nf x = ?h * length #"a"b"# * case x of _ => length #"c"d"#\n${sp(41)}+ 2`,
        // A parameters or using block whose first entry follows its header on the hole's line (with an aligned next
        // entry, Intro's width stops parsing [live]).
        `parameters (n : ?h) g : Nat\n${sp(20)}g = 1`,
        `using (x : ?h) g : Nat\n${sp(15)}g = 1`,
        // ...and a header continued over lines, read from `entryStart`'s line (`(Maybe Nat)` in the hole's place
        // gives `Expected end of input` [live, M4's third review of the fixes]); the old comma syntax too.
        `parameters (n : Nat)\n${sp(11)}(m : ?h) g : Nat\n${sp(20)}g = 1`,
        `parameters (n : Nat)\n${sp(11)}(k : Nat)\n${sp(11)}(m : ?h) g : Nat\n${sp(20)}g = 1`,
        `parameters (n : Nat,\n${sp(12)}m : ?h) g : Nat\n${sp(20)}g = 1`,
        `using (x : Nat,\n${sp(7)}y : ?h) g : Nat\n${sp(15)}g = 1`,
        // Character literals holding a quote, read as the compiler's lexer reads them ('\'' then '"'): no string is
        // opened, so the hole's line is code (M4's third review of the fixes).
        `quotes : Char -> Char -> Bool\nquotes '\\'' '"' = True\nquotes _ _ = False\n\nf : Nat -> Nat\nf x = ?h * case x of _ => 1\n${sp(23)}+ 2`,
        `q : List Char\nq = ['\\'','"']\n\nf : Nat -> Nat\nf x = ?h * case x of _ => 1\n${sp(23)}+ 2`,
        // A multi-line string closed before the hole: the " in its text is text.
        `f : Nat -> String\nf x = \"\"\"\n  a "\n  \"\"\" ++ ?h ++ case x of _ => "b"\n${sp(27)}++ "c"`,
      ]) {
        for (const plan of planned(op(body))) {
          refusal(plan, refused);
        }
      }
      // Bird tracks: the column after the marker, as the compiler's unlit leaves the line.
      const lit = (below: string): EditText => fixture('broken/Op.lidr', `> module Op\n\n> f : Nat -> Nat\n> f x = ?h * case x of _ => 1\n>${below}+ 2\n`);
      planned(lit(' '.repeat(8))).forEach((plan) => refusal(plan, refused));
      planned(lit(' '.repeat(7))).forEach((plan) => assert.ok(plan()));
      // Sent: the first line below with code starts at the hole's column or left of it, which ends every block the rest
      // opens in either text (`+ 2` in the hole's column: `f 0` is 12 before and after Make Case [live]); no block keyword
      // with an entry on the line; the keyword in a comment; nothing below in the entry.
      for (const body of [
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n      + 2',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n      + 2\n        + 3',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n\ng : Nat',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n{- a comment\n   below -}\ng : Nat',
        'f : IO ()\nf = do Just x <- ?h | Nothing => pure ()\n       printLn x',
        'f : Nat -> Nat\nf x = ?h * 2\n             + 3',
        'f : Nat -> Nat\nf x = ?h * case x of\n                 _ => 1',
        'f : Nat -> Nat\nf x = ?h -- where y = 1\n             + 3',
        'f : Nat -> Nat\nf x = ?h * (case x of)\n             + 3',
        'f : Nat -> Nat\nf x = ?h * (do)\n             + 3',
        'f : Nat -> Nat\nf x = ?h * [do]\n             + 3',
        // The `|` of an idiom bracket's `|]`.
        'f : Maybe Nat -> Maybe Nat\nf m = ?h <|> [| S m |]\n             <|> m',
        'f : Nat -> Nat\nf 𝑥 = ?h * case 𝑥 of _ => 1\n      + 2',
        'f : Nat -> Nat\nf x = ?h * M.do 1\n      + 2',
        // The first token below at the hole's column or left of it, after a comment (`f 0` is 12 before and after [live]).
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n{-c-} + 2',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1\n{-𝑥-} + 2',
        'f : Nat -> Nat\nf x = ?h * case x of _ => 1 {- c\n-} + 2',
        // A multi-line string holds nothing on its first line.
        `f : Nat -> String\nf x = ?h ++ \"\"\"\n${sp(10)}text\n  \"\"\"`,
        // An interpolation that ends on the line; the next declaration below (second review of the fixes).
        'f : Nat -> String\nf x = g ?h ++ "\\{show x}"\ng : Nat -> String',
        'f : Nat -> String\nf x = g ?h ++ "\\{show x}" ++\n          "b"',
        // A character literal and a nested string in an interpolation; a line comment in one that goes on below, which
        // the next line is read in, as code.
        'f : Nat -> String\nf x = ?h ++ "\\{show \'"\'}"\n           ++ "b"',
        'f : Nat -> String\nf x = ?h ++ "\\{"}" ++ "of x"}"\n           ++ "b"',
        'f : Nat -> String\nf x = ?h ++ "\\{show x -- "\n  }"',
        // A { group in an interpolation, whose } does not close it; an interpolation that goes on below without an opener
        // (no block: its next line is read against the same columns in either text).
        'f : Nat -> String\nf x = ?h ++ "\\{g {n = 1} "of x"}"\n           ++ "b"',
        `f : Nat -> String\nf x = ?h ++ "\\{show $ 10 *\n${sp(20)}2}"`,
        // The code before the hole read from what is open at the line's start: here string text, not a using header.
        `f : Nat -> String\nf x = \"\"\"\n  using \\{show ?h}\n${sp(12)}b\n  \"\"\"`,
        // A hole in an interpolation, with nothing below, or with the first token below at or left of its column; in a
        // multi-line string, whose closing line is the string's text, not a token.
        'f : Nat -> String\nf x = "a \\{show ?h} b"',
        'f : Nat -> String\nf x = "a \\{show ?h} b" ++\n      "c"',
        `f : Nat -> String\nf x = \"\"\"\n  a \\{show ?h} b\n  \"\"\"`,
        // A line below that starts in an interpolation's code is read as code: + 2 left of the hole.
        `f : Nat -> String\nf x = ?h ++ "\\{show $ 10 * case x of _ => 1\n  + 2}"`,
        // Strings that open no block, a token below right of the hole: a raw string holding ", a \{ that a raw string
        // or an escaped \ makes text, the | of an idiom bracket's |] that closes one opened before the hole.
        'f : Nat -> Nat\nf x = ?h * length #"a"b"#\n           + 2',
        'f : Nat -> String\nf x = ?h ++ #"\\{ of x"#\n           ++ "b"',
        'f : Nat -> String\nf x = ?h ++ "\\\\{ of x"\n           ++ "b"',
        'f : Maybe Nat -> Maybe Nat\nf m = [| S ?h |]\n             <|> m',
        // A parameters block whose first entry starts the next line, left of the hole.
        'parameters (n : ?h)\n  g : Nat\n  g = 1',
        // A hole in an entry of a parameters block, judged by the rest of its line only (the header ended above).
        'parameters (n : Nat)\n  g : Nat\n  g = ?h * 2\n        + 3',
      ]) {
        for (const plan of planned(op(body))) {
          assert.ok(plan(), body);
        }
      }
    });

    test('wherever the hole is, with no reading of the code around it: the whole right-hand side, alone between brackets, an argument, every literate style', () => {
      for (const body of [
        'f : Nat -> Nat\nf x = ?h', 'f : Nat -> Nat\nf x =\n  ?h', 'f : Nat -> Nat\nf x = ?h\n  where\n    y : Nat\n    y = 1', 'f : Nat -> Nat\nf x = case x of\n  0 => ?h\n  _ => 1',
        'f : Nat -> Bool\nf x with (x)\n  f x | 0 = ?h\n  f x | _ = True', 'f : Nat -> Nat\nf x = (?h)', 'f : Nat -> List Nat\nf x = [?h, 1]', 'f : Nat -> Nat\nf x = g ?h 2',
      ]) {
        assert.strictEqual(refined(body), '(\\y => ?h_0 + y)', body);
      }
      assert.strictEqual(refinedIn(fixture('broken/Op.lidr', '> module Op\n\n> f : Nat -> Nat\n> f x = ?h\n'), '\\y => ?h_0 + y'), '(\\y => ?h_0 + y)');
      assert.strictEqual(refinedIn(fixture('broken/Op.md', '```idris\nmodule Op\n\nf : Nat -> Nat\nf x = (?h) * 2\n```\n'), '\\y => y'), '(\\y => y)');
    });

    test('Intro (every candidate; the label as printed), Refine Hole\'s alternatives, Proof Search and Next Result, which replaces the previous result with its parentheses', () => {
      const intro = planEdit(at('intro', 3, 12, 'h'), op('app : List a -> List a -> List a\napp xs ys = ?h')).decode(introReply('[]', '?h_0 :: ?h_1'));
      assert.deepStrictEqual(intro.type === 'choices' && intro.choices.map((c) => [c.label, c.replacements[0].text]), [['[]', '[]'], ['?h_0 :: ?h_1', '(?h_0 :: ?h_1)']]);
      const ambiguity: ReplyPayload = { kind: 'error', message: 'Ambiguous elaboration. Possible results:\n    Op.A.foo ?h_0\n    Op.B.foo\n\n', highlighting: [] };
      const alternatives = planEdit(refineAt(3, 6, 'h', 'foo'), op('f : Nat -> Nat\nf x = ?h')).decode(ambiguity);
      assert.deepStrictEqual(alternatives.type === 'choices' && alternatives.choices.map((c) => [c.label, c.replacements[0].text]), [['Op.A.foo ?h_0', '(Op.A.foo ?h_0)'], ['Op.B.foo', 'Op.B.foo']]);
      const g = op('g : Nat -> Nat\ng = ?k');
      const first = edited(planEdit(search(3, 4, 'k'), g).decode(textReply('\\k => k')));
      assert.deepStrictEqual(first.map((x) => x.text), ['(\\k => k)']);
      const after = fixture('broken/Op.idr', applied(g, first));
      assert.strictEqual(after.lines[3], 'g = (\\k => k)');
      const next = planNext('exprSearchNext', after, followed(first[0]));
      assert.strictEqual(applied(after, edited(next.decode(textReply('\\k => 0')))).split('\n')[3], 'g = (\\k => 0)');
      assert.strictEqual(applied(after, edited(next.decode(textReply('Z')))).split('\n')[3], 'g = Z');
    });

    test('Make Lemma\'s call: in parentheses when more than one token; as it is when one (a lemma without arguments) or bracketed by the compiler', () => {
      const text = op('f : Nat -> Nat\nf x = ?h + 1\n\nk : Nat\nk = ?c');
      const call = (line: number, character: number, name: string, application: string, type: string): string | undefined =>
        edited(planEdit(at('makeLemma', line, character, name), text).decode(lemmaReply(application, type))).find((r) => r.range.start.line === line)?.text;
      assert.strictEqual(call(3, 6, 'h', 'h x', 'h : Nat -> Nat'), '(h x)');
      assert.strictEqual(call(3, 6, 'h', '(h x)', 'h : Nat -> Nat'), '(h x)');
      assert.strictEqual(call(6, 4, 'c', 'c', 'c : Nat'), 'c');
    });

    test('Make Case: the compiler\'s bracketed answer applied as it is, its unbracketed one rewritten into the bracketed form, anything else refused', () => {
      const lines = (text: EditText, reply: string): string[] => {
        const h = holeOf(text);
        return applied(text, edited(planEdit(at('makeCase', h.line, h.character, 'h'), text).decode(textReply(reply)))).split('\n').slice(h.line, h.line + 2);
      };
      // Unbracketed (`brack = False`): `case_val` at the hole's column + 5, the rest of the line after its hole.
      assert.deepStrictEqual(lines(op('f : Nat -> Nat\nf x = ?h * 2 -- c'), `f x = case _ of\n${' '.repeat(11)}case_val => ?h * 2 -- c`), ['f x = (case _ of', `${' '.repeat(12)}case_val => ?h) * 2 -- c`]);
      // Bracketed (`brack = True`, a prefix argument): as it is; the same answer unbracketed gives the same text.
      const arg = op('f : Nat -> Nat\nf x = g ?h 2');
      const bracketed = ['f x = g (case _ of', `${' '.repeat(14)}case_val => ?h) 2`];
      assert.deepStrictEqual(lines(arg, bracketed.join('\n')), bracketed);
      assert.deepStrictEqual(lines(arg, `f x = g case _ of\n${' '.repeat(13)}case_val => ?h 2`), bracketed);
      // A hole already in parentheses: twice; in Markdown, as in an .idr file.
      assert.deepStrictEqual(lines(op('f : Nat -> Nat\nf x = (?h) * 2'), `f x = (case _ of\n${' '.repeat(12)}case_val => ?h) * 2`), ['f x = ((case _ of', `${' '.repeat(13)}case_val => ?h)) * 2`]);
      const md = fixture('broken/Op.md', '```idris\nmodule Op\n\nf : Nat -> Nat\nf x = ?h\n```\n');
      assert.deepStrictEqual(lines(md, `f x = case _ of\n${' '.repeat(11)}case_val => ?h`), ['f x = (case _ of', `${' '.repeat(12)}case_val => ?h)`]);
      // Columns count code points (𝑥 is two UTF-16 units).
      assert.deepStrictEqual(lines(op('f : Nat -> Nat\nf 𝑥 = ?h'), `f 𝑥 = case _ of\n${' '.repeat(11)}case_val => ?h`), ['f 𝑥 = (case _ of', `${' '.repeat(12)}case_val => ?h)`]);
      // Bird tracks: the compiler's bracketed answer, its extra markers removed, the marker on the new line.
      const lit = fixture('broken/Op.lidr', '> module Op\n\n> f : Nat -> Nat\n> f x = g ?h 2\n');
      assert.deepStrictEqual(lines(lit, `> > f x = g (case _ of\n> ${' '.repeat(16)}case_val => ?h) 2`), ['> f x = g (case _ of', `>${' '.repeat(15)}case_val => ?h) 2`]);
      // A tab before the hole: the compiler counts it 1 and writes spaces; the new line gets it back.
      const tab = op('namespace N\n\tf : Nat -> Nat\n\tf x = ?h');
      assert.deepStrictEqual(lines(tab, `\tf x = case _ of\n${' '.repeat(12)}case_val => ?h`), ['\tf x = (case _ of', `\t${' '.repeat(12)}case_val => ?h)`]);
      // Anything else: refused, nothing applied.
      const plan = mc('f : Nat -> Nat\nf x = ?h * 2');
      for (const reply of [
        `f x = case _ of\n${' '.repeat(10)}case_val => ?h * 2`,
        `f x = case _ of\n${' '.repeat(12)}case_val => ?h * 2`,
        `f x = (case _ of\n${' '.repeat(11)}case_val => ?h) * 2`,
        `f x = (case _ of\n${' '.repeat(13)}case_val => ?h) * 2`,
        `f x = case _ of\n${' '.repeat(11)}case_val => ?h`,
        `f x = case _ of\n${' '.repeat(11)}case_val => ?h * 2\n`,
        `f x = case y of\n${' '.repeat(11)}case_val => ?h * 2`,
        `f x = case _ of\n${' '.repeat(11)}case_val => ?k * 2`,
        `> f x = case _ of\n> ${' '.repeat(11)}case_val => ?h * 2`,
        'f x = case _ of',
        '',
      ]) {
        refusal(() => plan.decode(textReply(reply)), /^Make Case: the compiler's answer has an unexpected form; nothing was applied\.$/);
      }
    });
  });

  suite('small files from the reviews: Case Split\'s answers and lines, hole tokens, signatures, Refine Hole\'s expression (ninth review of M4 onwards)', () => {
    const op = (body: string): EditText => fixture('broken/Op.idr', `module Op\n\n${body}\n`);

    test('a Case Split answer of one line (one constructor) is applied [live: f (x, y) = ?h_0, final review of M4]', () => {
      const pair = op('f : (Nat, Nat) -> Nat\nf p = ?h');
      assert.strictEqual(applied(pair, edited(planEdit(at('caseSplit', 3, 2, 'p'), pair).decode(textReply('f (x, y) = ?h_0')))).split('\n')[3], 'f (x, y) = ?h_0');
    });

    test('a hole right after a group symbol that ends in an operator character ([<?x], [|?k|]) is a hole; after an operator (x+?h) it is not', () => {
      assert.deepStrictEqual(holeTokenAt('f = [<?x]', 6, 'x'), { start: 6, end: 8 });
      assert.deepStrictEqual(holeTokenAt('g = [|?k|]', 6, 'k'), { start: 6, end: 8 });
      assert.deepStrictEqual(holeTokenAt('g = .[|?k|]', 7, 'k'), { start: 7, end: 9 });
      assert.deepStrictEqual(holeTokenAt('g = [>?k]', 6, 'k'), { start: 6, end: 8 });
      for (const [line, at] of [['f x = x+?h', 8], ['g = [|+?k|]', 7], ['g = [||?k|]', 7], ['g = <?k', 5]] as const) {
        assert.strictEqual(holeTokenAt(line, at, line.endsWith('?h') ? 'h' : 'k'), undefined, line);
      }
      // Case Split reads the line's holes with the same rule.
      assert.ok(planEdit(at('caseSplit', 3, 2, 'x'), op('f : Maybe Nat -> SnocList Nat\nf x = [<?h]')));
    });

    test('Case Split on the name of an as-pattern: refused unsent; an answer that only repeats the clause is not applied (ninth review of M4)', () => {
      const as = op('f : List Nat -> Nat\nf xs@(y :: ys) = ?h\nf [] = 0');
      refusal(() => planEdit(at('caseSplit', 3, 2, 'xs'), as), /names an as-pattern/);
      refusal(() => planEdit(at('caseSplit', 3, 4, 'xs'), as), /names an as-pattern/);
      const m = op('g : Maybe Nat -> Nat\ng m@n = ?k');
      refusal(() => planEdit(at('caseSplit', 3, 2, 'm'), m), /names an as-pattern/);
      // White space before the @ changes nothing: the compiler answers the clause repeated [live, final review of M4] …
      refusal(() => planEdit(at('caseSplit', 3, 2, 'xs'), op('f : List Nat -> Nat\nf xs @(y :: ys) = ?h')), /names an as-pattern/);
      refusal(() => planEdit(at('caseSplit', 3, 2, 'xs'), op('q : List Nat -> Nat\nq xs  @  (y :: ys) = ?m')), /names an as-pattern/);
      refusal(() => planEdit(at('caseSplit', 3, 2, 'x'), op('g : Nat -> {auto p : Eq Nat} -> Nat\ng x@{p} = ?k')), /names an as-pattern/);
      // … but ` @{` is an auto-implicit argument, which it splits [live].
      assert.ok(planEdit(at('caseSplit', 3, 2, 'x'), op('f : Nat -> {auto p : Eq Nat} -> Nat\nf x @{p} = ?h')));
      const y = planEdit(at('caseSplit', 3, 7, 'y'), as);
      assert.deepStrictEqual(edited(y.decode(textReply('f xs@(0 :: ys) = ?h_0\nf xs@((S k) :: ys) = ?h_1'))).map((r) => r.text), ['f xs@(0 :: ys) = ?h_0\nf xs@((S k) :: ys) = ?h_1']);
      // The answer recorded live for xs: the clause twice, its hole renamed.
      refusal(() => y.decode(textReply('f xs@(y :: ys) = ?h_0\nf xs@(y :: ys) = ?h_1')), /repeated the clause unchanged/);
    });

    test('a signature whose : starts the next line is a declaration, as the light bulb reads it (ninth review of M4)', () => {
      const sig = fixture('broken/Sig.idr', 'module Sig\n\nf\n  : Nat -> Nat\n');
      for (const [line, character] of [[2, 0], [3, 4]] as const) {
        assert.strictEqual(serializeSexp(planEdit(at('addClause', line, character, 'f'), sig).command), '(:add-clause 3 "f")');
        assert.strictEqual(serializeSexp(planEdit(at('generateDef', line, character, 'f'), sig).command), '(:generate-def 3 "f")');
      }
      // The answers recorded live there, inserted after the declaration's last line.
      assert.strictEqual(applied(sig, edited(planEdit(at('addClause', 2, 0, 'f'), sig).decode(textReply('f k = ?f_rhs')))), 'module Sig\n\nf\n  : Nat -> Nat\nf k = ?f_rhs\n');
      assert.strictEqual(applied(sig, edited(planEdit(at('generateDef', 2, 0, 'f'), sig).decode(textReply('f k = k')))), 'module Sig\n\nf\n  : Nat -> Nat\nf k = k\n');
      // A clause continued on the next line is still no declaration.
      refusal(() => planEdit(at('addClause', 3, 0, 'f'), fixture('broken/Sig.idr', 'module Sig\n\nf : Nat\nf\n  = 0\n')), /type declaration of f/);
    });

    test('Refine Hole: an expression that closes a bracket it did not open is refused unsent (the compiler drops the rest; ninth review of M4)', () => {
      for (const hint of ['S Z) junk here', 'S Z)', '(S Z)) :exec main', 'f ] x', '}', '([a)]) junk', '{(]]] x']) {
        assert.match(nameProblem(refineAt(3, 6, 'h', hint)) ?? 'sent', /closes a bracket it does not open/, hint);
      }
      for (const hint of ['S (S Z)', '"a)b"', "f ')'", 'S Z -- )', '[1, (2)]', '(+)', 'S (S']) {
        assert.strictEqual(nameProblem(refineAt(3, 6, 'h', hint)), undefined, hint);
      }
    });
  });

  test('a file with a lone carriage return: the line-reading commands are refused', () => {
    const lines = fs.readFileSync(path.join(WORKSPACES, 'broken/Clean.idr'), 'utf8').split('\n');
    const lone = editText({ fileName: '/fx/broken/Clean.idr', languageId: 'idris2', isUntitled: false, lineCount: lines.length, lineAt: (l) => ({ text: lines[l] }) }, `-- a\r${lines.join('\n')}`);
    refusal(() => planEdit(at('caseSplit', 7, 5, 'xs'), lone), /carriage return/);
    assert.ok(planEdit(at('intro', 7, 12, 'vlen_rhs'), lone));
  });

  test('F16: the three commands that find their place by line say so for a load that returned an error; the others do not', () => {
    const holeErr = fixture('broken/HoleErr.idr');
    assert.match(planEdit(at('caseSplit', 5, 7, 'n'), holeErr).afterFailedLoad ?? '', /did not load cleanly/);
    assert.match(planEdit(at('addClause', 4, 0, 'before'), holeErr).afterFailedLoad ?? '', /did not load cleanly/);
    assert.match(planEdit(at('generateDef', 4, 0, 'before'), holeErr).afterFailedLoad ?? '', /did not load cleanly/);
    for (const req of [at('makeLemma', 11, 11, 'after_rhs'), at('makeCase', 11, 11, 'after_rhs'), at('intro', 5, 11, 'before_rhs'), at('addMissingCases', 13, 0, 'cover')]) {
      assert.strictEqual(planEdit(req, holeErr).afterFailedLoad, undefined, req.kind);
    }
    // … and those answer after the failed load [live].
    assert.deepStrictEqual(linesOf(applied(holeErr, edited(result('hole-errors', holeErr, at('makeCase', 11, 11, 'after_rhs')))), 12, 13), [
      'after xs = (case _ of',
      '                 case_val => ?after_rhs)',
    ]);
  });

  test('E16: holes of one name in two modules of the context: the compiler\'s answer decodes as failed (the backend refuses the request before sending it, holeRefusal)', () => {
    const main = fixture('holes-ipkg/src/Holes/Main.idr');
    const plan = planEdit(at('intro', 7, 11, 'todo'), main);
    const payload = recordedExchanges('holes-ipkg-main', '/fx').find((x) => x.request.startsWith(`(${serializeSexp(plan.command)} `))?.reply.payload;
    assert.ok(payload !== undefined);
    assert.deepStrictEqual(plan.decode(payload), { type: 'failed', message: 'Could not find hole named todo' });
  });
});
