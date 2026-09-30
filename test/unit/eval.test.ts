// features/eval: Evaluate Selection and Clear Evaluation Results (ROADMAP M3; §9, 2026-09-28:
// expressions only). Which text is evaluated, how the compiler's answer is shown (after the line and
// in a hover, as untrusted text), that the command hands the text to the backend and nothing else
// — the backend refuses REPL commands before anything is sent — and when the results go away.
// The answers are those of the recorded transcripts `eval-values` and `eval-command-forms`.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { IdeMode, type IdeModeDeps } from '../../src/backend/ide/backend';
import type { SessionPool } from '../../src/backend/ide/types';
import type { Evaluation, IdrisBackend } from '../../src/backend/types';
import { cancelled, IdrisException } from '../../src/core/errors';
import { appendResultHover, MAX_LABEL_LENGTH, resultLabel, selectedExpression } from '../../src/features/eval/evaluation';
import {
  CLEAR_EVALUATION_RESULTS_COMMAND,
  EVALUATE_SELECTION_COMMAND,
  registerEvaluation,
  type EvaluationApi,
} from '../../src/features/eval/register';
import { Emitter } from '../../src/core/event';
import {
  FakeBackend,
  FakeConfig,
  fakeDoc,
  FakeMarkdownString,
  FakeRange,
  looseRoot,
  quietLog,
  type FakeDoc,
} from './support/interactiveFakes';

const value = (text: string): Evaluation => ({ kind: 'value', value: { text, spans: [] } });
const error = (text: string): Evaluation => ({ kind: 'error', message: { text, spans: [] } });

/** Recorded answers (transcript eval-values). */
const VECT = value('[1, 2]');
const IO_ACTION = value('MkIO (prim__putStr "hi\\n")');
const HAS_IO = error('Error: Can\'t find an implementation for HasIO ?io.\n\n(Interactive):1:1--1:14\n 1 | putStrLn "hi"\n     ^^^^^^^^^^^^^\n');
const UNDEFINED = error('Error: Undefined name nope. \n\n(Interactive):1:1--1:5\n 1 | nope\n     ^^^^\n');

const range = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

class FakeThemeColor {
  constructor(readonly id: string) {}
}

/** `vscode.CancellationToken`'s part the command and the backend use. */
class FakeToken {
  isCancellationRequested = false;
  private readonly emitter = new Emitter<void>();
  readonly onCancellationRequested = this.emitter.event;
  cancel(): void {
    if (!this.isCancellationRequested) {
      this.isCancellationRequested = true;
      this.emitter.fire();
    }
  }
}

class FakeTokenSource {
  readonly token = new FakeToken();
  disposed = false;
  cancel(): void {
    this.token.cancel();
  }
  dispose(): void {
    this.disposed = true;
  }
}

interface DecorationCall {
  readonly editor: number;
  readonly options: { range: FakeRange; hoverMessage: FakeMarkdownString; renderOptions: { after: { contentText: string; color: FakeThemeColor } } }[];
}

function setup(options: { trusted?: boolean; keepOutcomes?: boolean; cancelOfferMs?: number } = {}) {
  const backend = new FakeBackend();
  const config = new FakeConfig();
  const commands = new Map<string, () => Promise<void>>();
  const messages: string[] = [];
  const decorations: DecorationCall[] = [];
  const visibleChanged = new Emitter<void>();
  const textChanged = new Emitter<{ document: FakeDoc; contentChanges: unknown[] }>();
  const closed = new Emitter<FakeDoc>();
  const logged: string[] = [];
  const state = {
    active: undefined as { document: FakeDoc; selection: FakeRange } | undefined,
    visible: [] as { document: FakeDoc }[],
    progress: [] as { location: number; title: string; cancellable?: boolean }[],
    progressTokens: [] as FakeToken[],
    decorationTypes: [] as { options: unknown; disposed: boolean }[],
  };
  // A notification's promise settles when the user dismisses it, which no test does: a command
  // that awaited one would never finish (and `executeCommand` in the integration suite would hang).
  const message = (level: string) => (text: string) => {
    messages.push(`${level}: ${text}`);
    return new Promise<undefined>(() => undefined);
  };
  const api = {
    window: {
      get activeTextEditor() {
        return state.active;
      },
      get visibleTextEditors() {
        return state.visible.map((editor, index) => ({
          document: editor.document,
          setDecorations: (_type: unknown, opts: DecorationCall['options']) => decorations.push({ editor: index, options: opts }),
        }));
      },
      onDidChangeVisibleTextEditors: visibleChanged.event,
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      withProgress: (opts: { location: number; title: string; cancellable?: boolean }, task: (progress: unknown, token: FakeToken) => Promise<unknown>) => {
        state.progress.push(opts);
        const token = new FakeToken();
        state.progressTokens.push(token);
        return task({ report: () => undefined }, token);
      },
      createTextEditorDecorationType: (opts: unknown) => {
        const type = { options: opts, disposed: false, dispose: () => (type.disposed = true) };
        state.decorationTypes.push(type);
        return type;
      },
    },
    workspace: { onDidChangeTextDocument: textChanged.event, onDidCloseTextDocument: closed.event },
    commands: {
      registerCommand: (id: string, run: () => Promise<void>) => {
        commands.set(id, run);
        return { dispose: () => commands.delete(id) };
      },
    },
    MarkdownString: FakeMarkdownString,
    Range: FakeRange,
    ThemeColor: FakeThemeColor,
    ProgressLocation: { Window: 10, Notification: 15 },
    CancellationTokenSource: FakeTokenSource,
    DecorationRangeBehavior: { ClosedClosed: 1 },
  } as unknown as EvaluationApi;
  const results = registerEvaluation(api, {
    registry: { backendFor: () => backend.asBackend() },
    projects: { classify: (file: string) => Promise.resolve(looseRoot(file.slice(0, file.lastIndexOf('/')))) },
    config,
    trust: { isTrusted: options.trusted ?? true, onDidGrant: new Emitter<void>().event },
    log: { ...quietLog, info: (m: string) => logged.push(m), error: (m: string) => logged.push(`error ${m}`) },
  }, { keepOutcomes: options.keepOutcomes ?? true, cancelOfferMs: options.cancelOfferMs ?? 60_000 });
  const run = async (id: string): Promise<void> => {
    const command = commands.get(id);
    assert.ok(command !== undefined, `${id} is registered`);
    await command();
  };
  const open = (doc: FakeDoc, selection: FakeRange): void => {
    state.active = { document: doc, selection };
    state.visible = [{ document: doc }];
  };
  const evaluate = (doc: FakeDoc, selection: FakeRange): Promise<void> => {
    open(doc, selection);
    return run(EVALUATE_SELECTION_COMMAND);
  };
  const lastDrawn = () => decorations[decorations.length - 1]?.options ?? [];
  return { backend, config, commands, messages, decorations, state, results, run, open, evaluate, lastDrawn, logged, visibleChanged, textChanged, closed };
}

const CLEAN = (): FakeDoc => fakeDoc({ fileName: '/w/Clean.idr', text: 'module Clean\n\nx = the (Vect 2 Nat) [1, 2]\ny = 1\n' });

suite('features/eval', () => {
  suite('selectedExpression: the text evaluated', () => {
    const doc = fakeDoc({ fileName: '/w/A.idr', text: 'x = the (Vect 2 Nat)\n      [1, 2]\n   \n' });

    test('the selected text; over lines, its first line indented to its column, so that every line keeps its column', () => {
      assert.deepStrictEqual(selectedExpression(doc, range(0, 4, 1, 12)), { kind: 'expression', text: '    the (Vect 2 Nat)\n      [1, 2]' });
      assert.deepStrictEqual(selectedExpression(doc, range(0, 9, 0, 13)), { kind: 'expression', text: 'Vect' }, 'one line: as it is');
    });

    test('layout blocks opened on the first line still line up: let, case … of (the texts answered 3 and 20, unindented errors [live])', () => {
      const blocks = fakeDoc({
        fileName: '/w/Ev2.idr',
        text: 'module Ev2\n\nr : Nat\nr = let a = 1\n        b = 2\n    in a + b\n\ns : Nat\ns = case the Nat 3 of 0 => 10\n                      _ => 20',
      });
      assert.deepStrictEqual(selectedExpression(blocks, range(3, 4, 5, 12)), { kind: 'expression', text: '    let a = 1\n        b = 2\n    in a + b' });
      assert.deepStrictEqual(selectedExpression(blocks, range(8, 4, 9, 29)), {
        kind: 'expression',
        text: '    case the Nat 3 of 0 => 10\n                      _ => 20',
      });
      // The column counts code points, as the compiler does (E14): 𝕟 is two UTF-16 units, one column.
      // `a` is at UTF-16 column 15 but the compiler's 14, where the second line's `b` is.
      const astral = fakeDoc({ fileName: '/w/A.idr', text: 'x = ("𝕟", let a = 1\n              b = 2 in a + b)' });
      assert.deepStrictEqual(selectedExpression(astral, range(0, 11, 1, 28)), { kind: 'expression', text: '          let a = 1\n              b = 2 in a + b' });
    });

    test('white space alone is not evaluated', () => {
      assert.deepStrictEqual(selectedExpression(doc, range(0, 4, 0, 4)), { kind: 'empty' });
      assert.deepStrictEqual(selectedExpression(doc, range(2, 0, 3, 0)), { kind: 'empty' });
    });

    test('bird tracks: the markers are left out; prose in the selection is refused, a blank line kept', () => {
      const lidr = fakeDoc({ fileName: '/w/Lit.lidr', languageId: 'lidr', text: '> x = the Nat\n>   (1 + 2)\n\nProse here.\n> y = 1' });
      assert.deepStrictEqual(selectedExpression(lidr, range(0, 6, 1, 11)), { kind: 'expression', text: '    the Nat\n  (1 + 2)' }, 'indented to its unlit column');
      // A selection starting inside the marker starts after it.
      assert.deepStrictEqual(selectedExpression(lidr, range(1, 1, 1, 11)), { kind: 'expression', text: '  (1 + 2)' });
      assert.deepStrictEqual(selectedExpression(lidr, range(1, 0, 2, 0)), { kind: 'expression', text: '  (1 + 2)\n' });
      assert.deepStrictEqual(selectedExpression(lidr, range(1, 0, 4, 7)), { kind: 'prose', line: 3 }, 'the line of the document');
      // The compiler decides by the file name (F11): a .idr in the lidr mode is not bird-track.
      const idr = fakeDoc({ fileName: '/w/B.idr', languageId: 'lidr', text: '> 1' });
      assert.deepStrictEqual(selectedExpression(idr, range(0, 0, 0, 3)), { kind: 'expression', text: '> 1' });
    });

    test('Org: the #+IDRIS: markers are left out as bird tracks are; a line without one only within a one-line selection (third review of M3)', () => {
      const text = '#+IDRIS: foo : Nat\n#+IDRIS: foo = let a = 1\n#+IDRIS:           b = 2\n#+IDRIS:       in a + b\nSome prose.\n#+BEGIN_SRC idris\nbar = 1 + 2\n#+END_SRC';
      for (const fileName of ['/w/o/Foo.idr.org', '/w/o/Foo.lidr.org']) {
        const org = fakeDoc({ fileName, languageId: 'idris2', text });
        // From `let` (file column 15, the compiler's 6) to the end: every line keeps its column.
        assert.deepStrictEqual(selectedExpression(org, range(1, 15, 3, 23)), { kind: 'expression', text: '      let a = 1\n          b = 2\n      in a + b' }, fileName);
        // A whole line, as a triple click selects it (to the start of the next line).
        assert.deepStrictEqual(selectedExpression(org, range(0, 0, 1, 0)), { kind: 'expression', text: 'foo : Nat\n' }, fileName);
        // Prose, or a block's line, in a selection over several lines: refused, naming the line.
        assert.deepStrictEqual(selectedExpression(org, range(3, 15, 4, 4)), { kind: 'unmarked', line: 4 }, fileName);
        assert.deepStrictEqual(selectedExpression(org, range(5, 0, 6, 11)), { kind: 'unmarked', line: 5 }, fileName);
        // Within one line of a block: sent as it is.
        assert.deepStrictEqual(selectedExpression(org, range(6, 6, 6, 11)), { kind: 'expression', text: '1 + 2' }, fileName);
      }
    });
  });

  suite('how an answer is shown', () => {
    test('the label: `= <value>` or `✗ <first line of the error>`, one line', () => {
      assert.strictEqual(resultLabel(VECT), '= [1, 2]');
      assert.strictEqual(resultLabel(IO_ACTION), '= MkIO (prim__putStr "hi\\n")');
      assert.strictEqual(resultLabel(value('')), '= (no value)');
      assert.strictEqual(resultLabel(UNDEFINED), '✗ Undefined name nope.');
      assert.strictEqual(resultLabel(error("Couldn't parse any alternatives:\n1: Expected end of input.")), "✗ Couldn't parse any alternatives:");
      assert.strictEqual(resultLabel(value('\\x =>\n    plus x 1')), '= \\x => plus x 1');
    });

    test('the label cannot reorder or break the line: format and control characters are written out, a long value cut', () => {
      assert.strictEqual(resultLabel(value('"\u202Eevil\u2066"')), '= "\\u{202E}evil\\u{2066}"');
      assert.strictEqual(resultLabel(value('"a\u0000b\u200Bc"')), '= "a\\u{0}b\\u{200B}c"');
      const long = resultLabel(value('x'.repeat(500)));
      assert.strictEqual(long.length, 2 + MAX_LABEL_LENGTH);
      assert.ok(long.endsWith('…'));
      // Cut at a character boundary, never inside a surrogate pair.
      const astral = resultLabel(value('𝕟'.repeat(200)));
      assert.ok(!/[\ud800-\udbff]…$/.test(astral), astral.slice(-3));
    });

    test('the hover: the answer in a code block no line of it can close; notes for IO actions and unsaved changes', () => {
      const md = new FakeMarkdownString();
      appendResultHover(md, VECT, false);
      assert.strictEqual(md.value, '**Idris 2: value**\n\n```idris2\n[1, 2]\n```\n');
      const io = new FakeMarkdownString();
      appendResultHover(io, IO_ACTION, true);
      assert.ok(io.value.includes('```idris2\nMkIO (prim__putStr "hi\\n")\n```\n'), io.value);
      assert.ok(io.value.includes('An `IO` action is shown as the compiler normalises it, not run'), io.value);
      assert.ok(io.value.includes('_The file had unsaved changes'), io.value);
      const hasIo = new FakeMarkdownString();
      appendResultHover(hasIo, HAS_IO, false);
      // The error in a `text` block: without an info string VS Code 1.139.1 colours it as Idris.
      assert.ok(hasIo.value.startsWith('**Idris 2: not evaluated**\n\n```text\nError: Can\'t find'), hasIo.value);
      assert.ok(hasIo.value.includes('give its type, as in `the (IO ()) (putStrLn "hi")`'), hasIo.value);
      assert.ok(!hasIo.value.includes('unsaved'));
      // A string value holding a fence (indented, as CommonMark still closes it) gets a longer fence.
      const fenced = new FakeMarkdownString();
      appendResultHover(fenced, value('"a\n  ```\n[x](command:evil)\n"'), false);
      assert.ok(fenced.value.includes('````idris2\n"a\n  ```\n[x](command:evil)\n"\n````\n'), fenced.value);
      // Control and format characters (a bidi override in a name, a zero-width space) are written
      // out in the hover too, values and errors alike.
      const bidi = new FakeMarkdownString();
      appendResultHover(bidi, value('MkT a‮b​c'), false);
      assert.ok(bidi.value.includes('```idris2\nMkT a\\u{202E}b\\u{200B}c\n```\n'), bidi.value);
      const bidiError = new FakeMarkdownString();
      appendResultHover(bidiError, { kind: 'error', message: { text: 'Undefined name x⁦y.', spans: [] } }, false);
      assert.ok(bidiError.value.includes('```text\nUndefined name x\\u{2066}y.\n```\n'), bidiError.value);
    });
  });

  suite('Evaluate Selection', () => {
    test('hands the selected text to the backend and nothing else, and draws the answer after the last line', async () => {
      const t = setup();
      t.backend.answerEvaluation = () => Promise.resolve(VECT);
      await t.evaluate(CLEAN(), new FakeRange(2, 4, 2, 27));
      assert.deepStrictEqual(t.backend.calls, ['evaluate the (Vect 2 Nat) [1, 2]']);
      assert.deepStrictEqual(t.messages, []);
      assert.deepStrictEqual(t.state.progress, [{ location: 10, title: 'Idris 2: evaluating…' }]);
      const [drawn] = t.lastDrawn();
      assert.deepStrictEqual(drawn.range, new FakeRange(2, 4, 2, 27));
      assert.strictEqual(drawn.renderOptions.after.contentText, '= [1, 2]');
      assert.strictEqual(drawn.renderOptions.after.color.id, 'editor.inlineValuesForeground');
      assert.strictEqual(drawn.hoverMessage.isTrusted, false);
      assert.strictEqual(drawn.hoverMessage.supportHtml, false);
      assert.strictEqual(drawn.hoverMessage.supportThemeIcons, false);
      assert.deepStrictEqual(
        t.results.drawn('file:///w/Clean.idr').map((r) => [r.kind, r.label]),
        [['value', '= [1, 2]']],
      );
    });

    test('the label goes after the last selected line: to its end, also for a selection of whole lines', async () => {
      const t = setup();
      t.backend.answerEvaluation = () => Promise.resolve(value('1'));
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 4, 0));
      assert.deepStrictEqual(t.lastDrawn()[0].range, new FakeRange(3, 4, 3, 5));
      await t.evaluate(CLEAN(), new FakeRange(2, 4, 3, 2));
      assert.deepStrictEqual(t.lastDrawn().map((d) => d.range), [new FakeRange(2, 4, 3, 5)]);
    });

    test('an error is an answer: drawn in the error colour', async () => {
      const t = setup();
      t.backend.answerEvaluation = () => Promise.resolve(HAS_IO);
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      const [drawn] = t.lastDrawn();
      assert.strictEqual(drawn.renderOptions.after.contentText, "✗ Can't find an implementation for HasIO ?io.");
      assert.strictEqual(drawn.renderOptions.after.color.id, 'editorError.foreground');
    });

    test('a refusal by the backend (a REPL command) is a plain-text notification, and nothing is drawn', async () => {
      const t = setup();
      const reason = 'Evaluate Selection evaluates expressions only; ":exec putStrLn \\"hi\\"" is a REPL command. [x](command:evil)';
      t.backend.answerEvaluation = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason }));
      const doc = fakeDoc({ fileName: '/w/A.idr', text: ':exec putStrLn "hi"' });
      await t.evaluate(doc, new FakeRange(0, 0, 0, 19));
      assert.deepStrictEqual(t.backend.calls, ['evaluate :exec putStrLn "hi"']);
      assert.strictEqual(t.messages.length, 1);
      assert.ok(t.messages[0].startsWith('info: Idris 2: Evaluate Selection evaluates expressions only'), t.messages[0]);
      assert.ok(!t.messages[0].includes('](command:'), 'no link can form');
      assert.deepStrictEqual(t.decorations, []);
    });

    test('other failures: a warning; a cancellation: nothing; an unexpected error: shown, not thrown', async () => {
      const t = setup();
      t.backend.answerEvaluation = () => Promise.reject(new IdrisException({ kind: 'LoadFailed', message: 'Clean.idr:3:5: Undefined name Vect.' }));
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      t.backend.answerEvaluation = () => Promise.reject(cancelled('Stopped'));
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      t.backend.answerEvaluation = () => Promise.reject(new TypeError('boom'));
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      assert.deepStrictEqual(t.messages, [
        'warning: Idris 2: Evaluate Selection failed: Clean.idr:3:5: Undefined name Vect.',
        'error: Idris 2: Evaluate Selection failed: boom',
      ]);
      assert.deepStrictEqual(t.decorations, []);
    });

    test('asks the backend nothing in Restricted Mode, outside an Idris file on disk, or without an expression', async () => {
      const restricted = setup({ trusted: false });
      await restricted.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      const t = setup();
      await t.run(EVALUATE_SELECTION_COMMAND);
      await t.evaluate(fakeDoc({ fileName: '/w/notes.md', languageId: 'markdown', text: 'x' }), new FakeRange(0, 0, 0, 1));
      await t.evaluate(fakeDoc({ fileName: 'Untitled-1', scheme: 'untitled', text: '1 + 1' }), new FakeRange(0, 0, 0, 5));
      await t.evaluate(CLEAN(), new FakeRange(1, 0, 1, 0));
      await t.evaluate(fakeDoc({ fileName: '/w/L.lidr', languageId: 'lidr', text: 'Prose.\n> x = 1' }), new FakeRange(0, 0, 1, 7));
      assert.deepStrictEqual(restricted.messages, ['info: Idris 2: nothing is run in Restricted Mode. Trust the workspace to evaluate expressions.']);
      assert.deepStrictEqual(t.messages, [
        'info: Idris 2: select an expression in an Idris file to evaluate it.',
        'info: Idris 2: select an expression in an Idris file to evaluate it.',
        'info: Idris 2: save the file first; the compiler evaluates in the context of the file on disk.',
        'info: Idris 2: select the expression to evaluate.',
        'info: Idris 2: line 1 of the file is prose, not Idris code; select code only.',
      ]);
      assert.deepStrictEqual([...restricted.backend.calls, ...t.backend.calls], []);
    });

    test('prose in a selection that starts further down names the line of the file', async () => {
      const t = setup();
      await t.evaluate(fakeDoc({ fileName: '/w/L.lidr', languageId: 'lidr', text: '> x = 1\n> y = 2\nProse.\n> z = 3' }), new FakeRange(1, 2, 3, 7));
      assert.deepStrictEqual(t.messages, ['info: Idris 2: line 3 of the file is prose, not Idris code; select code only.']);
    });

    test('an Org selection over several lines that reaches a line without #+IDRIS: is refused, naming the line; nothing is asked', async () => {
      const t = setup();
      await t.evaluate(fakeDoc({ fileName: '/w/O.idr.org', text: '#+IDRIS: x = 1\n#+IDRIS: y = 2\nProse.' }), new FakeRange(0, 9, 2, 3));
      assert.deepStrictEqual(t.messages, ['info: Idris 2: line 3 of the file has no #+IDRIS: marker; in an Org file a selection over several lines is evaluated only on #+IDRIS: lines.']);
      assert.deepStrictEqual(t.backend.calls, []);
    });

    test('an evaluation still running after CANCEL_OFFER_MS offers Cancel in a notification; Cancel cancels the backend\'s token', async () => {
      const t = setup({ cancelOfferMs: 0 });
      let token: { isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => unknown } | undefined;
      let answer: (evaluation: Evaluation) => void = () => undefined;
      t.backend.answerEvaluation = (_expr, given) => {
        token = given as unknown as typeof token;
        return new Promise<Evaluation>((resolve) => (answer = resolve));
      };
      const running = t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepStrictEqual(
        t.state.progress.map((p) => [p.location, p.title, p.cancellable ?? false]),
        [
          [10, 'Idris 2: evaluating…', false],
          [15, 'Idris 2: still loading the file or evaluating. Cancel stops the evaluation and its compiler process.', true],
        ],
      );
      assert.strictEqual(token?.isCancellationRequested, false);
      t.state.progressTokens[1].cancel();
      assert.strictEqual(token?.isCancellationRequested, true);
      answer(VECT);
      await running;
      // A quick one gets no notification (the timer is cleared).
      const quick = setup({ cancelOfferMs: 0 });
      quick.backend.answerEvaluation = () => Promise.resolve(VECT);
      await quick.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepStrictEqual(quick.state.progress.map((p) => p.location), [10]);
    });

    test('an evaluation waiting behind another of its root gets its Cancel offer only once it runs (fourth review of M3)', async () => {
      // The backend runs a root's evaluations one at a time: timed from the command, a second one
      // asked for during a slow first load showed a second offer, whose Cancel stopped nothing that ran.
      const t = setup({ cancelOfferMs: 0 });
      const answers: ((evaluation: Evaluation) => void)[] = [];
      t.backend.answerEvaluation = () => new Promise<Evaluation>((resolve) => answers.push(resolve));
      const offers = () => t.state.progress.filter((p) => p.location === 15).length;
      const first = t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = t.run(EVALUATE_SELECTION_COMMAND);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.strictEqual(answers.length, 2, 'both asked of the backend');
      assert.strictEqual(offers(), 1, 'the running one only');
      answers[0](VECT);
      await first;
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.strictEqual(offers(), 2, 'the second runs now');
      answers[1](VECT);
      await second;
      // Another root's evaluation does not wait for this root's.
      const other = setup({ cancelOfferMs: 0 });
      const pending: ((evaluation: Evaluation) => void)[] = [];
      other.backend.answerEvaluation = () => new Promise<Evaluation>((resolve) => pending.push(resolve));
      const inA = other.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      const inB = other.evaluate(fakeDoc({ fileName: '/v/B.idr', text: 'module B\n\ny = 1\n' }), new FakeRange(2, 4, 2, 5));
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.strictEqual(other.state.progress.filter((p) => p.location === 15).length, 2);
      pending.forEach((answer) => answer(VECT));
      await Promise.all([inA, inB]);
    });

    test('notifications write out control and format characters of what they quote (a name, a compiler line)', async () => {
      const t = setup();
      t.backend.answerEvaluation = () => Promise.reject(new IdrisException({ kind: 'LoadFailed', message: 'Not evaluated: A.idr does not compile (A.idr: Undefined name x\u202Ey\u2066.).' }));
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      t.backend.answerEvaluation = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'Not evaluated: \u200Bthe\ntext.' }));
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      assert.deepStrictEqual(t.messages, [
        'warning: Idris 2: Evaluate Selection failed: Not evaluated: A.idr does not compile (A.idr: Undefined name x\\u{202E}y\\u{2066}.).',
        'info: Idris 2: Not evaluated: \\u{200B}the text.',
      ]);
    });

    test('with unsaved changes the hover says the names refer to the saved file', async () => {
      const t = setup();
      t.backend.answerEvaluation = () => Promise.resolve(VECT);
      const doc = CLEAN();
      doc.isDirty = true;
      await t.evaluate(doc, new FakeRange(2, 4, 2, 27));
      assert.ok(t.results.drawn(doc.uri.toString())[0].hover.includes('unsaved changes'));
    });

    test('idris2.eval.inlineResults off, or the document changed meanwhile: a notification of plain text instead', async () => {
      const t = setup();
      t.config.inlineResults = false;
      t.backend.answerEvaluation = () => Promise.resolve(value('"[x](command:evil)"'));
      await t.evaluate(CLEAN(), new FakeRange(3, 4, 3, 5));
      t.config.inlineResults = true;
      const doc = CLEAN();
      t.backend.answerEvaluation = () => {
        doc.version++;
        return Promise.resolve(UNDEFINED);
      };
      await t.evaluate(doc, new FakeRange(3, 4, 3, 5));
      assert.deepStrictEqual(t.messages, ['info: Idris 2: = "[x]\u200B(command:evil)"', 'warning: Idris 2: not evaluated: ✗ Undefined name nope.']);
      assert.deepStrictEqual(t.decorations, []);
    });
  });

  suite('with the IDE-mode backend: a REPL command is refused before any session is asked for', () => {
    /**
     * `IdeMode` over dependencies that record every use: a pool whose `sessionFor` throws (nothing
     * may be sent or started), and projects, file system and gate that note being asked.
     */
    function tripwire() {
      const touched: string[] = [];
      const note =
        (what: string) =>
        (..._args: unknown[]): never => {
          touched.push(what);
          throw new Error(`${what} was used`);
        };
      const pool = new Proxy(
        {
          onDidChange: new Emitter<never>().event,
          sessionFor: (_root: unknown, role: string) => note(`sessionFor ${role}`)(),
          sessions: () => [],
          dispose: () => undefined,
        } as Record<string | symbol, unknown>,
        { get: (target, prop) => (prop in target ? target[prop] : note(`pool.${String(prop)}`)) },
      ) as unknown as SessionPool;
      const deps = {
        pool,
        projects: {
          classify: (file: string) => {
            touched.push('classify');
            return Promise.resolve(looseRoot(file.slice(0, file.lastIndexOf('/'))));
          },
          sessionCwd: note('sessionCwd'),
        },
        config: { diagnostics: note('config.diagnostics'), ideMode: note('config.ideMode') },
        clock: { setTimeout: note('setTimeout'), clearTimeout: note('clearTimeout'), now: note('now') },
        gate: { current: note('gate.current'), onDidChange: new Emitter<void>().event },
        api: {},
        readFile: note('readFile'),
        realpath: note('realpath'),
        findPackage: note('findPackage'),
        directoryId: note('directoryId'),
        platform: 'darwin',
        isOpen: note('isOpen'),
        openText: note('openText'),
      } as unknown as IdeModeDeps;
      const ide = new IdeMode(deps);
      return { ide, touched, backend: ide.backendFor() };
    }

    function setupIde() {
      const t = setup();
      const { ide, touched, backend } = tripwire();
      // The feature under test, with the real backend in place of the fake one.
      (t.backend as unknown as { asBackend: () => IdrisBackend }).asBackend = () => backend;
      return { ...t, ide, touched };
    }

    /** The forms under which `:t id` ran as a REPL command [live, transcript eval-command-forms], and more commands. */
    const COMMANDS = [
      ':t id',
      ' :t id',
      '\t:t id',
      '\u000B:t id',
      '\u000C:t id',
      ' :t id',
      '{- c -} :t id',
      '-- c\n:t id',
      ': t id',
      ':exec putStrLn "hi"',
      ':set eval execute',
      ':sh ls',
      ':cd /tmp',
      ':q',
      ':?',
    ];

    test('every form the compiler read as a command is refused: no session, no file, no question — and it is shown, not drawn', async () => {
      for (const form of COMMANDS) {
        const t = setupIde();
        const doc = fakeDoc({ fileName: '/w/Clean.idr', text: form });
        const last = form.split('\n').length - 1;
        await t.evaluate(doc, new FakeRange(0, 0, last, form.split('\n')[last].length));
        assert.deepStrictEqual(t.touched, [], JSON.stringify(form));
        assert.deepStrictEqual(t.results.outcomes.map((o) => [o.kind, o.expression]), [['refused', form]], JSON.stringify(form));
        assert.strictEqual(t.messages.length, 1, JSON.stringify(form));
        assert.match(t.messages[0], /^info: Idris 2: Not evaluated: /, JSON.stringify(form));
        assert.deepStrictEqual(t.decorations, [], JSON.stringify(form));
        t.results.dispose();
        t.ide.dispose();
      }
    });

    test('a bird-track line: the marker is not part of the text, so `> :exec …` is refused as `:exec …`', async () => {
      const t = setupIde();
      const doc = fakeDoc({ fileName: '/w/Lit.lidr', languageId: 'lidr', text: '> :exec putStrLn "hi"' });
      await t.evaluate(doc, new FakeRange(0, 0, 0, 21));
      assert.deepStrictEqual(t.touched, []);
      assert.deepStrictEqual(t.results.outcomes.map((o) => [o.kind, o.expression]), [['refused', ':exec putStrLn "hi"']]);
    });

    test('an expression goes on to the eval session (so the harness would see a request path)', async () => {
      const t = setupIde();
      await t.evaluate(fakeDoc({ fileName: '/w/Clean.idr', text: 'the Nat 1' }), new FakeRange(0, 0, 0, 9));
      assert.deepStrictEqual(t.touched, ['classify', 'sessionFor eval']);
    });
  });

  suite('the outcomes kept for the test API', () => {
    test('every run in order: the compiler\'s answer, a refusal (nothing asked), a failure', async () => {
      const t = setup();
      const doc = CLEAN();
      t.backend.answerEvaluation = (expr) =>
        expr === 'x' ? Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'Not evaluated: a REPL command.' })) : Promise.resolve(expr === '1' ? value('1') : HAS_IO);
      await t.evaluate(doc, new FakeRange(3, 4, 3, 5));
      await t.evaluate(doc, new FakeRange(2, 0, 2, 1));
      await t.evaluate(doc, new FakeRange(3, 0, 3, 1));
      await t.evaluate(doc, new FakeRange(1, 0, 1, 0));
      t.backend.answerEvaluation = () => Promise.reject(new IdrisException({ kind: 'RequestTimeout', message: 'no answer in 60 s' }));
      await t.evaluate(doc, new FakeRange(3, 4, 3, 5));
      assert.deepStrictEqual(t.results.outcomes, [
        { file: '/w/Clean.idr', expression: '1', kind: 'value', text: '1' },
        { file: '/w/Clean.idr', expression: 'x', kind: 'refused', text: 'Idris 2: Not evaluated: a REPL command.' },
        { file: '/w/Clean.idr', expression: 'y', kind: 'error', text: HAS_IO.kind === 'error' ? HAS_IO.message.text : '' },
        { file: '/w/Clean.idr', expression: '', kind: 'refused', text: 'Idris 2: select the expression to evaluate.' },
        { file: '/w/Clean.idr', expression: '1', kind: 'unavailable', text: 'Idris 2: Evaluate Selection failed: no answer in 60 s' },
      ]);
    });

    test('kept only when asked (the test runner): none otherwise', async () => {
      const t = setup({ keepOutcomes: false });
      t.backend.answerEvaluation = () => Promise.resolve(VECT);
      await t.evaluate(CLEAN(), new FakeRange(2, 4, 2, 27));
      assert.deepStrictEqual(t.results.outcomes, []);
      assert.strictEqual(t.results.drawn('file:///w/Clean.idr').length, 1);
    });
  });

  suite('the results drawn', () => {
    const evaluated = async (lines: [number, number][]) => {
      const t = setup();
      const doc = CLEAN();
      t.backend.answerEvaluation = (expr) => Promise.resolve(value(expr));
      for (const [start, end] of lines) {
        await t.evaluate(doc, new FakeRange(start, 0, end, 1));
      }
      return { t, doc, shown: () => t.results.drawn(doc.uri.toString()).map((r) => r.label) };
    };

    test('a new result replaces those on the lines it covers, and keeps the others', async () => {
      const { shown } = await evaluated([[2, 2], [3, 3], [2, 3], [0, 0]]);
      assert.deepStrictEqual(shown(), ['= x = the (Vect 2 Nat) [1, 2] y', '= m']);
    });

    test('an edit of the document removes its results; a change of its dirty state alone does not', async () => {
      const { t, doc, shown } = await evaluated([[2, 2]]);
      t.textChanged.fire({ document: doc, contentChanges: [] });
      assert.deepStrictEqual(shown(), ['= x']);
      t.textChanged.fire({ document: doc, contentChanges: [{}] });
      assert.deepStrictEqual(shown(), []);
      assert.deepStrictEqual(t.lastDrawn(), [], 'the decorations are removed from its editors');
    });

    test('closing the document forgets its results', async () => {
      const { t, doc, shown } = await evaluated([[2, 2]]);
      t.closed.fire(doc);
      assert.deepStrictEqual(shown(), []);
    });

    test('Clear Evaluation Results: the active document\'s, or every document\'s without an active Idris editor', async () => {
      const { t, doc, shown } = await evaluated([[2, 2]]);
      const other = fakeDoc({ fileName: '/w/Other.idr', text: 'z = 2' });
      await t.evaluate(other, new FakeRange(0, 4, 0, 5));
      t.open(doc, new FakeRange(0, 0, 0, 0));
      await t.run(CLEAR_EVALUATION_RESULTS_COMMAND);
      assert.deepStrictEqual(shown(), []);
      assert.deepStrictEqual(t.results.drawn(other.uri.toString()).length, 1);
      t.state.active = undefined;
      await t.run(CLEAR_EVALUATION_RESULTS_COMMAND);
      assert.deepStrictEqual(t.results.drawn(other.uri.toString()).length, 0);
    });

    test('turning idris2.eval.inlineResults off removes every result; other settings do not', async () => {
      const { t, shown } = await evaluated([[2, 2]]);
      t.config.change('eval');
      assert.deepStrictEqual(shown(), ['= x']);
      t.config.inlineResults = false;
      t.config.change('inlayHints');
      assert.deepStrictEqual(shown(), ['= x']);
      t.config.change('eval');
      assert.deepStrictEqual(shown(), []);
    });

    test('drawn again in an editor that shows the document later; the decoration type goes at dispose', async () => {
      const { t, doc } = await evaluated([[2, 2]]);
      const before = t.decorations.length;
      t.state.visible = [{ document: fakeDoc({ fileName: '/w/Other.idr', text: '' }) }, { document: doc }];
      t.visibleChanged.fire();
      assert.strictEqual(t.decorations.length, before + 1);
      assert.strictEqual(t.decorations[before].editor, 1);
      assert.strictEqual(t.decorations[before].options[0].renderOptions.after.contentText, '= x');
      t.results.dispose();
      assert.ok(t.state.decorationTypes.every((d) => d.disposed));
      assert.strictEqual(t.commands.size, 0);
    });
  });
});
