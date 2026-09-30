/**
 * **Idris 2: Evaluate Selection** and **Idris 2: Clear Evaluation Results** (ROADMAP M3; the `e`
 * keybinding letter, ARCHITECTURE §10).
 *
 * Evaluate Selection evaluates the selected expression (`evaluation.ts` `selectedExpression`) with
 * the backend of the document's root (`IdrisBackend.evaluate`: the IDE-mode backend's `eval`
 * session, in the context of the saved file). It sends nothing itself and loads nothing: it finds
 * the backend by classifying the file (`ProjectIndex.classify`, which may run `idris2
 * --dump-ipkg-json` when the package's model is not cached, M1), and the backend refuses text the
 * compiler's REPL parser would read as a command before it starts, asks for or sends anything
 * (ROADMAP §9, 2026-09-28). That refusal, like every other `IdrisException`, is shown as a
 * notification of plain text (`plainText`, the M2 rule; control and format characters written out
 * by `editorLabel`, since the texts quote names and compiler output) and never becomes a
 * decoration. Nothing runs in Restricted Mode (the keybinding reaches the command there too; the
 * Command Palette hides it).
 *
 * **Cancel.** The status bar shows that an evaluation runs; one still running `CANCEL_OFFER_MS`
 * after it started also gets a notification with Cancel, which stops the evaluation and with it
 * the `eval` session's process (IDE mode has no cancel; `IdrisBackend.evaluate`'s token). An
 * evaluation asked for while another of its root runs waits for it in the backend, which runs them
 * one at a time, so its time counts from the end of the one before (fourth review of M3: timed from
 * the command, two evaluations asked for quickly during a slow first load showed two offers, and
 * Cancel on the waiting one stopped nothing that ran). An evaluation that does not end is stopped
 * by the backend's time limit, `idris2.eval.timeout`.
 *
 * **The result** (`idris2.eval.inlineResults`, default on) is drawn after the last line of the
 * evaluated text (`evaluation.ts` `resultLabel`: `= <value>`, or `✗ <error>` in the error colour),
 * and a hover over the evaluated text, to the end of its last line, has the whole answer
 * (`appendResultHover`; one decoration carries both, its range ending where the label is drawn —
 * whether VS Code 1.139.1 also shows the hover over the label itself was not tried [open]). A new
 * result replaces those on the lines it covers. The results of a
 * document go when its text changes (an edit anywhere, an undo, a reload from disk: the answer
 * may no longer hold), when it closes, with Clear Evaluation Results (the active document's, or
 * every document's without one), and all of them when the setting is turned off. With the
 * setting off — or when the document changed or closed while the compiler was evaluating — the
 * result is a notification instead.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import { rootKey, type BackendRegistry } from '../../backend/registry';
import type { Evaluation } from '../../backend/types';
import type { Config } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { errorText, IdrisException, isCancelled } from '../../core/errors';
import type { Log } from '../../core/log';
import { plainText } from '../../core/notificationText';
import { displayLine } from '../../core/positions';
import type { WorkspaceTrust } from '../../core/trust';
import { editorLabel } from '../../core/untrustedText';
import { isIdrisDocument } from '../../project/literate';
import type { ProjectIndex } from '../../project/types';
import { appendResultHover, resultLabel, selectedExpression } from './evaluation';

export const EVALUATE_SELECTION_COMMAND = 'idris2.evaluateSelection';
export const CLEAR_EVALUATION_RESULTS_COMMAND = 'idris2.clearEvaluationResults';

/** The part of the `vscode` namespace the commands use. */
export type EvaluationApi = Pick<
  typeof vscode,
  | 'window'
  | 'workspace'
  | 'commands'
  | 'MarkdownString'
  | 'Range'
  | 'ThemeColor'
  | 'ProgressLocation'
  | 'DecorationRangeBehavior'
  | 'CancellationTokenSource'
>;

/**
 * How long an evaluation runs before a notification offers to cancel it (module comment, *Cancel*):
 * most take well under a second — 0.47 s with the start of the process (as-built M3), 0.32–0.38 s
 * for the load and the `:interpret` of each later one on the e2e suite's 2,000-line module [live,
 * second review of M3] —, and a notification shown for each of them would come and go at every
 * evaluation. The first evaluation in a root also compiles the file and its imports into the
 * evaluation's build directory: 1.48 s after a start of 0.2–0.3 s on that module [live, the same
 * review], 1.2–1.5 s for the first load of 11–18-module closures of `contrib`
 * (docs/measurements/first-load.md [live]); so the offer comes then too, while the compiler loads,
 * and its text names both.
 */
export const CANCEL_OFFER_MS = 1_000;

/** What `registerEvaluation` needs; `extension.ts` supplies the real ones. */
export interface EvaluationDeps {
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  /** `evaluation()` (`idris2.eval.inlineResults`) and its changes. */
  readonly config: Pick<Config, 'evaluation' | 'onDidChange'>;
  readonly trust: WorkspaceTrust;
  readonly log: Log;
}

/** A result drawn in a document, as the test API reports it. */
export interface DrawnEvaluation {
  /** The evaluated text, to the end of its last line (where the label is drawn). */
  readonly range: vscode.Range;
  readonly kind: Evaluation['kind'];
  /** The label after the line. */
  readonly label: string;
  /** The hover's markdown source. */
  readonly hover: string;
}

/**
 * One run of Evaluate Selection and what it showed, for the test API (`EvaluationResults.outcomes`):
 * `value` and `error` are the compiler's answer (`Evaluation`), `text` its text; `refused` means
 * nothing was asked of the compiler (the backend refused the text — a REPL command, no backend —
 * or there was no expression to evaluate, or nothing may run), `unavailable` that the backend
 * failed (the file does not load, a time limit, a crash, a cancellation); `text` is then the
 * notification's.
 */
export interface EvaluationOutcome {
  readonly file: string;
  readonly expression: string;
  readonly kind: Evaluation['kind'] | 'refused' | 'unavailable';
  readonly text: string;
}

export interface EvaluationResults extends IDisposable {
  /** The results drawn in the document of `uri` (`Uri.toString()`), in the order they were made. */
  drawn(uri: string): readonly DrawnEvaluation[];
  /** Every run of Evaluate Selection in this window, in order; kept only with `keepOutcomes`. */
  readonly outcomes: readonly EvaluationOutcome[];
}

export interface EvaluationOptions {
  /** Keep `EvaluationResults.outcomes` (the test API; `extension.ts` sets it under the test runner). */
  readonly keepOutcomes?: boolean;
  /** `CANCEL_OFFER_MS` unless a test sets it. */
  readonly cancelOfferMs?: number;
}

interface DrawnResult extends DrawnEvaluation {
  readonly hoverMessage: vscode.MarkdownString;
}

const RESTRICTED = 'Idris 2: nothing is run in Restricted Mode. Trust the workspace to evaluate expressions.';

export function registerEvaluation(api: EvaluationApi, deps: EvaluationDeps, options: EvaluationOptions = {}): EvaluationResults {
  const store = new DisposableStore();
  const outcomes: EvaluationOutcome[] = [];
  const record = (outcome: EvaluationOutcome): void => {
    if (options.keepOutcomes === true) {
      outcomes.push(outcome);
    }
  };
  /** Per document (`uri.toString()`), the results drawn in it. */
  const results = new Map<string, DrawnResult[]>();
  /**
   * Per root (`rootKey`), the evaluation this window asked for last, settled or not: the backend
   * runs a root's evaluations one at a time (`IdrisBackend.evaluate`), so the next one starts when it
   * ends (module comment, *Cancel*).
   */
  const lastAsked = new Map<string, Promise<void>>();
  const decoration = store.add(
    api.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 1.5em', fontStyle: 'italic' },
      rangeBehavior: api.DecorationRangeBehavior.ClosedClosed,
    }),
  );

  /** Draws the results of `uri` in every visible editor of it (none: removes them). */
  const draw = (uri: string): void => {
    const drawn = results.get(uri) ?? [];
    const options: vscode.DecorationOptions[] = drawn.map((result) => ({
      range: result.range,
      hoverMessage: result.hoverMessage,
      renderOptions: {
        after: {
          contentText: result.label,
          color: new api.ThemeColor(result.kind === 'value' ? 'editor.inlineValuesForeground' : 'editorError.foreground'),
        },
      },
    }));
    for (const editor of api.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) {
        editor.setDecorations(decoration, options);
      }
    }
  };

  const clear = (uri: string): void => {
    if (results.delete(uri)) {
      draw(uri);
    }
  };

  const clearAll = (): void => {
    for (const uri of [...results.keys()]) {
      clear(uri);
    }
  };

  store.add(api.window.onDidChangeVisibleTextEditors(() => [...results.keys()].forEach(draw)));
  store.add(
    api.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) {
        clear(e.document.uri.toString());
      }
    }),
  );
  store.add(api.workspace.onDidCloseTextDocument((doc) => results.delete(doc.uri.toString())));
  store.add(
    deps.config.onDidChange('eval', () => {
      if (!deps.config.evaluation().inlineResults) {
        clearAll();
      }
    }),
  );

  /** Draws `evaluation` after the last line of `selection` in `doc`, replacing the results on those lines. */
  const drawResult = (doc: vscode.TextDocument, selection: vscode.Range, evaluation: Evaluation, stale: boolean): void => {
    // A selection of whole lines ends at column 0 of the next line, which holds none of it.
    const lastLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line;
    const range = new api.Range(selection.start.line, selection.start.character, lastLine, doc.lineAt(lastLine).text.length);
    const hoverMessage = new api.MarkdownString();
    hoverMessage.isTrusted = false;
    hoverMessage.supportHtml = false;
    hoverMessage.supportThemeIcons = false;
    appendResultHover(hoverMessage, evaluation, stale);
    const uri = doc.uri.toString();
    const kept = (results.get(uri) ?? []).filter((r) => r.range.end.line < range.start.line || r.range.start.line > range.end.line);
    kept.push({ range, kind: evaluation.kind, label: resultLabel(evaluation), hover: hoverMessage.value, hoverMessage });
    results.set(uri, kept);
    draw(uri);
  };

  /**
   * Shows `message` (one sentence, `Idris 2: …`, as one line with its control and format characters
   * written out: it may quote compiler output) and records the run as `refused`. Notifications are
   * not awaited: the promise settles only when the user dismisses one, and the command is done
   * when it has been shown.
   */
  const refuse = (file: string, expression: string, message: string): void => {
    const shown = editorLabel(message);
    record({ file, expression, kind: 'refused', text: shown });
    void api.window.showInformationMessage(plainText(shown));
  };

  const evaluate = async (): Promise<void> => {
    const editor = api.window.activeTextEditor;
    const doc = editor?.document;
    if (editor === undefined || doc === undefined || !isIdrisDocument(doc)) {
      refuse(doc?.fileName ?? '', '', 'Idris 2: select an expression in an Idris file to evaluate it.');
      return;
    }
    if (!deps.trust.isTrusted) {
      refuse(doc.fileName, '', RESTRICTED);
      return;
    }
    if (doc.uri.scheme !== 'file') {
      refuse(doc.fileName, '', 'Idris 2: save the file first; the compiler evaluates in the context of the file on disk.');
      return;
    }
    const selection = editor.selection;
    const selected = selectedExpression(doc, selection);
    if (selected.kind === 'empty') {
      refuse(doc.fileName, '', 'Idris 2: select the expression to evaluate.');
      return;
    }
    if (selected.kind === 'prose') {
      refuse(doc.fileName, '', `Idris 2: line ${displayLine(selected.line)} of the file is prose, not Idris code; select code only.`);
      return;
    }
    if (selected.kind === 'unmarked') {
      refuse(
        doc.fileName,
        '',
        `Idris 2: line ${displayLine(selected.line)} of the file has no #+IDRIS: marker; in an Org file a selection over several lines is evaluated only on #+IDRIS: lines.`,
      );
      return;
    }
    const expression = selected.text;
    const version = doc.version;
    const stale = doc.isDirty;
    const root = await deps.projects.classify(doc.fileName);
    const backend = deps.registry.backendFor(root);
    const cancel = new api.CancellationTokenSource();
    const running = backend.evaluate(doc, expression, cancel.token);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    const key = rootKey(root);
    const ahead = lastAsked.get(key);
    lastAsked.set(key, settled);
    let finished = false;
    let offer: ReturnType<typeof setTimeout> | undefined;
    const offerCancel = (): void => {
      if (finished) {
        return;
      }
      offer = setTimeout(() => {
        void api.window.withProgress(
          {
            location: api.ProgressLocation.Notification,
            title: 'Idris 2: still loading the file or evaluating. Cancel stops the evaluation and its compiler process.',
            cancellable: true,
          },
          (_progress, token) => {
            token.onCancellationRequested(() => cancel.cancel());
            return settled;
          },
        );
      }, options.cancelOfferMs ?? CANCEL_OFFER_MS);
    };
    // Timed from the evaluation's start, not from the command: one waiting behind another of its
    // root is not running, and Cancel would stop nothing that runs (fourth review of M3).
    if (ahead === undefined) {
      offerCancel();
    } else {
      void ahead.then(offerCancel);
    }
    let evaluation: Evaluation;
    try {
      evaluation = await api.window.withProgress({ location: api.ProgressLocation.Window, title: 'Idris 2: evaluating…' }, () => running);
    } catch (error) {
      if (isCancelled(error)) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.info(`Evaluate Selection: ${message}`);
        record({ file: doc.fileName, expression, kind: 'unavailable', text: message });
        return;
      }
      if (!(error instanceof IdrisException)) {
        throw error;
      }
      const reason = errorText(error.error);
      deps.log.info(`Evaluate Selection in ${doc.fileName}: ${error.error.kind}: ${reason}`);
      if (error.error.kind === 'Unsupported') {
        refuse(doc.fileName, expression, `Idris 2: ${reason}`);
      } else {
        const message = editorLabel(`Idris 2: Evaluate Selection failed: ${reason}`);
        record({ file: doc.fileName, expression, kind: 'unavailable', text: message });
        void api.window.showWarningMessage(plainText(message));
      }
      return;
    } finally {
      finished = true;
      clearTimeout(offer);
      cancel.dispose();
      if (lastAsked.get(key) === settled) {
        lastAsked.delete(key);
      }
    }
    record({
      file: doc.fileName,
      expression,
      kind: evaluation.kind,
      text: evaluation.kind === 'value' ? evaluation.value.text : evaluation.message.text,
    });
    if (deps.config.evaluation().inlineResults && !doc.isClosed && doc.version === version) {
      drawResult(doc, selection, evaluation, stale);
      return;
    }
    const label = resultLabel(evaluation);
    if (evaluation.kind === 'value') {
      void api.window.showInformationMessage(plainText(`Idris 2: ${label}`));
    } else {
      void api.window.showWarningMessage(plainText(`Idris 2: not evaluated: ${label}`));
    }
  };

  /** A command handler that shows its failure as plain text instead of rejecting (the M2 rule). */
  const guarded = (what: string, run: () => Promise<void>) => async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log.error(`${what} failed: ${message}`);
      void api.window.showErrorMessage(plainText(editorLabel(`Idris 2: ${what} failed: ${message}`)));
    }
  };

  store.add(api.commands.registerCommand(EVALUATE_SELECTION_COMMAND, guarded('Evaluate Selection', evaluate)));
  store.add(
    api.commands.registerCommand(
      CLEAR_EVALUATION_RESULTS_COMMAND,
      guarded('Clear Evaluation Results', () => {
        const doc = api.window.activeTextEditor?.document;
        if (doc !== undefined && isIdrisDocument(doc)) {
          clear(doc.uri.toString());
        } else {
          clearAll();
        }
        return Promise.resolve();
      }),
    ),
  );

  return {
    drawn: (uri) => (results.get(uri) ?? []).map(({ range, kind, label, hover }) => ({ range, kind, label, hover })),
    outcomes,
    dispose: () => {
      results.clear();
      store.dispose();
    },
  };
}
