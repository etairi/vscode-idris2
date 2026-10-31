/**
 * `registerRepl` (`types.ts`): the commands of the REPL terminal, **Query…**, the `-- >>>` lenses and
 * `:r` on save. Registering starts nothing. Only type imports from `vscode`: `extension.ts` passes the
 * namespace as `api`.
 */
import type * as vscode from 'vscode';
import type { Evaluation } from '../../backend/types';
import { DisposableStore } from '../../core/disposable';
import { errorText, IdrisException } from '../../core/errors';
import { Emitter } from '../../core/event';
import { plainText } from '../../core/notificationText';
import { editorLabel, visible } from '../../core/untrustedText';
import { idrisDocumentSelector, isIdrisDocument } from '../../project/literate';
import { applyReplacements, type ApplyApi } from '../editing/apply';
import { saveBeforeAction, type SaveApi } from '../editing/saveBeforeAction';
import { resultLabel, selectedExpression } from '../eval/evaluation';
import { occurrenceAt } from '../intelligence/occurrence';
import { answerReplacement, docEvalLines, type DocEvalLine } from './docEval';
import { replLine } from './launch';
import { askQuery, type QueryApi } from './query';
import { ReplTerminals, type ReplTerminalsApi } from './terminals';
import type { ReplDeps, ReplRegistration } from './types';

export const OPEN_REPL_COMMAND = 'idris2.openRepl';
export const SEND_TO_REPL_COMMAND = 'idris2.sendToRepl';
export const REPL_TYPE_COMMAND = 'idris2.replType';
export const REPL_DOCS_COMMAND = 'idris2.replDocs';
export const QUERY_COMMAND = 'idris2.query';
export const RUN_ALL_DOC_EVAL_COMMAND = 'idris2.runAllDocEval';
/** A lens's: it names its line, and is in no menu. */
export const RUN_DOC_EVAL_COMMAND = 'idris2.runDocEval';

export type ReplApi = ReplTerminalsApi &
  QueryApi &
  ApplyApi &
  SaveApi &
  Pick<typeof vscode, 'CodeLens' | 'Range'> & {
    readonly window: ReplTerminalsApi['window'] &
      QueryApi['window'] &
      Pick<typeof vscode.window, 'activeTextEditor' | 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage' | 'createOutputChannel'>;
    readonly workspace: ApplyApi['workspace'] & Pick<typeof vscode.workspace, 'textDocuments' | 'onDidSaveTextDocument'>;
    readonly commands: Pick<typeof vscode.commands, 'registerCommand'>;
    readonly languages: Pick<typeof vscode.languages, 'registerCodeLensProvider'>;
  };

const answerText = (evaluation: Evaluation): string => (evaluation.kind === 'value' ? evaluation.value.text : evaluation.message.text);

/** Of `lines`, the one with `asked`'s text nearest to where `asked` was. */
function nearestLine(lines: readonly DocEvalLine[], asked: DocEvalLine): DocEvalLine | undefined {
  const distance = (line: DocEvalLine): number => Math.abs(line.line - asked.line);
  return lines.filter((line) => line.text === asked.text).sort((a, b) => distance(a) - distance(b))[0];
}

export function registerRepl(api: ReplApi, deps: ReplDeps): ReplRegistration {
  const store = new DisposableStore();
  const terminals = store.add(new ReplTerminals(api, deps));
  const lensesChanged = store.add(new Emitter<void>());
  store.add(deps.trust.onDidGrant(() => lensesChanged.fire()));

  const say = (text: string): void => void api.window.showInformationMessage(plainText(editorLabel(text)));
  const warn = (text: string): void => void api.window.showWarningMessage(plainText(editorLabel(text)));

  /** The active editor's Idris file on disk; otherwise says what is needed. */
  const activeFile = (what: string): vscode.TextEditor | undefined => {
    const editor = api.window.activeTextEditor;
    if (editor === undefined || !isIdrisDocument(editor.document)) {
      say(`Idris 2: ${what} needs an Idris file.`);
      return undefined;
    }
    if (!deps.trust.isTrusted) {
      say('Idris 2: nothing is run in Restricted Mode. Trust the workspace first.');
      return undefined;
    }
    if (editor.document.uri.scheme !== 'file') {
      say(`Idris 2: ${what} needs a file saved on disk.`);
      return undefined;
    }
    return editor;
  };

  /** `run`, with a failure shown as plain text instead of rejecting (the M2 rule). */
  const guarded = (what: string, run: (...args: unknown[]) => Promise<void>) => async (...args: unknown[]): Promise<void> => {
    try {
      await run(...args);
    } catch (error) {
      if (error instanceof IdrisException) {
        warn(`Idris 2: ${errorText(error.error)}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      deps.log.error(`${what} failed: ${message}`);
      void api.window.showErrorMessage(plainText(editorLabel(`Idris 2: ${what} failed: ${message}`)));
    }
  };

  // --- the terminal --------------------------------------------------------------------------

  const openRepl = async (): Promise<void> => {
    const editor = activeFile('Open REPL');
    if (editor !== undefined) {
      (await terminals.ensure(editor.document.fileName)).show();
    }
  };

  /** Types `line` into the REPL of `doc`'s root, opening it if it has none, and leaves the focus in the editor. */
  const type = async (doc: vscode.TextDocument, line: string): Promise<void> => {
    const terminal = await terminals.ensure(doc.fileName);
    terminal.show(true);
    terminals.type(terminal, line);
  };

  /** The selection, without literate markers (`selectedExpression`), or the empty range's `whole`, as one line. */
  const selectionLine = (editor: vscode.TextEditor, what: string, whole: () => vscode.Range | undefined): string | undefined => {
    const { document: doc, selection } = editor;
    const range = selection.isEmpty ? whole() : selection;
    const selected = range === undefined ? undefined : selectedExpression(doc, range);
    if (selected?.kind !== 'expression') {
      say(`Idris 2: ${what} needs code: select it, or put the cursor on it.`);
      return undefined;
    }
    const line = replLine(selected.text);
    if (line.kind === 'control') {
      warn(`Idris 2: ${what}: the text has a control character, which is not typed into a terminal.`);
      return undefined;
    }
    if (line.kind === 'long') {
      warn(`Idris 2: ${what}: the text is longer than a terminal takes on one line, so it is not typed.`);
      return undefined;
    }
    return line.kind === 'line' ? line.text : undefined;
  };

  const sendToRepl = async (): Promise<void> => {
    const editor = activeFile('Send to REPL');
    if (editor === undefined) {
      return;
    }
    const { document: doc, selection } = editor;
    const lineNumber = selection.active.line;
    const line = selectionLine(editor, 'Send to REPL', () => new api.Range(lineNumber, 0, lineNumber, doc.lineAt(lineNumber).text.length));
    if (line !== undefined) {
      await type(doc, line);
    }
  };

  /** `:t` or `:doc` of the selection, or of the name at the cursor. */
  const askRepl = async (command: ':t' | ':doc', what: string): Promise<void> => {
    const editor = activeFile(what);
    if (editor === undefined) {
      return;
    }
    const { document: doc, selection } = editor;
    const line = selectionLine(editor, what, () => {
      const at = occurrenceAt(doc, undefined, selection.active)?.range;
      return at === undefined ? undefined : new api.Range(at.start.line, at.start.character, at.end.line, at.end.character);
    });
    if (line !== undefined) {
      await type(doc, `${command} ${line}`);
    }
  };

  store.add(
    api.workspace.onDidSaveTextDocument((doc) => {
      if (!deps.config.repl().reloadOnSave || !isIdrisDocument(doc) || doc.uri.scheme !== 'file') {
        return;
      }
      void deps.projects.classify(doc.fileName).then((root) => {
        const terminal = terminals.of(root);
        if (terminal !== undefined) {
          terminals.type(terminal, ':r');
        }
      });
    }),
  );

  // --- Query… ---------------------------------------------------------------------------------

  let channel: vscode.OutputChannel | undefined;
  const queryChannel = (): vscode.OutputChannel => {
    channel ??= store.add(api.window.createOutputChannel('Idris 2 Query'));
    return channel;
  };

  /** Shows why `outcome` has no answer; the answer itself, when it has one. */
  const answerOf = (outcome: Awaited<ReturnType<ReplDeps['evaluation']['run']>>): Evaluation | undefined => {
    if (outcome.kind === 'answer') {
      return outcome.evaluation;
    }
    if (outcome.kind === 'failed') {
      warn(`Idris 2: not evaluated: ${outcome.reason}`);
    } else if (outcome.kind === 'refused') {
      say(`Idris 2: ${outcome.reason}`);
    }
    return undefined;
  };

  const query = async (): Promise<void> => {
    const editor = activeFile('Query');
    if (editor === undefined) {
      return;
    }
    const { document: doc } = editor;
    const text = await askQuery(api, deps.queries, doc);
    if (text === undefined) {
      return;
    }
    const evaluation = answerOf(await deps.evaluation.run(doc, text, { queryCommands: true }));
    if (evaluation !== undefined) {
      const output = queryChannel();
      output.appendLine(`> ${visible(text)}`);
      output.appendLine(visible(answerText(evaluation)).trimEnd());
      output.show(true);
    }
  };

  // --- the -- >>> lenses --------------------------------------------------------------------------

  const notWritten = (doc: vscode.TextDocument, text: string, evaluation: Evaluation): void =>
    say(`Idris 2: ${text} ${resultLabel(evaluation)} (not written: ${doc.isClosed ? 'the file closed' : 'the file changed meanwhile'})`);

  /** Writes `answers` beneath their lines, one undo step, while the document is at `version`, which their lines were read at. */
  const write = async (doc: vscode.TextDocument, version: number, answers: readonly { line: DocEvalLine; evaluation: Evaluation }[]): Promise<void> => {
    if (doc.isClosed || doc.version !== version) {
      answers.forEach(({ line, evaluation }) => notWritten(doc, line.text, evaluation));
      return;
    }
    const replacements = answers.map(({ line, evaluation }) => answerReplacement(doc, line, answerText(evaluation)));
    const applied = await applyReplacements(api, doc, version, replacements);
    if (applied.kind === 'changed' || applied.kind === 'closed') {
      answers.forEach(({ line, evaluation }) => notWritten(doc, line.text, evaluation));
    } else if (applied.kind === 'invalid' || applied.kind === 'refused') {
      warn('Idris 2: the answer could not be written into the file.');
    }
  };

  /**
   * Whether `doc` is as saved, under `idris2.checking.saveBeforeAction`: the compiler answers for the
   * file on disk, and the answer goes into the text in the editor, as for the editing commands.
   */
  const savedFirst = async (doc: vscode.TextDocument, what: string): Promise<boolean> => {
    const saved = await saveBeforeAction(api, doc, deps.config.saveBeforeAction(doc.uri), what);
    if (saved.kind === 'refused') {
      say(saved.message);
    }
    return saved.kind === 'ready';
  };

  const runLine = async (arg: unknown): Promise<void> => {
    const { uri, line } = (arg ?? {}) as { uri?: unknown; line?: unknown };
    const doc = api.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    const asked = doc === undefined ? undefined : docEvalLines(doc).find((candidate) => candidate.line === line);
    const gone = (): void => say('Idris 2: that -- >>> line is no longer there.');
    if (doc === undefined || asked === undefined) {
      gone();
      return;
    }
    if (!(await savedFirst(doc, 'Run'))) {
      return;
    }
    // The save can move the line (a formatter): the version and the line are read together.
    const { version } = doc;
    const found = nearestLine(docEvalLines(doc), asked);
    if (found === undefined) {
      gone();
      return;
    }
    const evaluation = answerOf(await deps.evaluation.run(doc, found.text, { queryCommands: true }));
    if (evaluation?.kind === 'value') {
      await write(doc, version, [{ line: found, evaluation }]);
    } else if (evaluation !== undefined) {
      warn(`Idris 2: ${found.text} ${resultLabel(evaluation)}`);
    }
  };

  const runAll = async (): Promise<void> => {
    const editor = activeFile('Run All');
    if (editor === undefined) {
      return;
    }
    const { document: doc } = editor;
    const asked = docEvalLines(doc);
    if (asked.length === 0) {
      say('Idris 2: this file has no -- >>> lines.');
      return;
    }
    const run = `Run ${asked.length}`;
    const choice = await api.window.showWarningMessage(
      plainText(
        `Idris 2: run the ${asked.length} -- >>> ${asked.length === 1 ? 'line' : 'lines'} of this file? Each is evaluated, and the compile-time code it reaches runs: read them first in a project you did not write.`,
      ),
      run,
    );
    if (choice !== run || !(await savedFirst(doc, 'Run All'))) {
      return;
    }
    // The question stays open while the user works, and the save can move lines (a formatter): the
    // version and the lines are read together, and what runs is what the user agreed to.
    const { version } = doc;
    const lines = docEvalLines(doc);
    if (lines.map((line) => line.text).join('\n') !== asked.map((line) => line.text).join('\n')) {
      say('Idris 2: the -- >>> lines changed while you were asked, so nothing was run. Run All again.');
      return;
    }
    const answers: { line: DocEvalLine; evaluation: Evaluation }[] = [];
    const failures: string[] = [];
    for (const line of lines) {
      const outcome = await deps.evaluation.run(doc, line.text, { queryCommands: true });
      if (outcome.kind === 'cancelled') {
        break;
      }
      if (outcome.kind === 'answer' && outcome.evaluation.kind === 'value') {
        answers.push({ line, evaluation: outcome.evaluation });
      } else {
        failures.push(`${line.text}: ${outcome.kind === 'answer' ? resultLabel(outcome.evaluation) : outcome.reason}`);
      }
    }
    if (answers.length > 0) {
      await write(doc, version, answers);
    }
    if (failures.length > 0) {
      warn(`Idris 2: ${failures.length} of ${lines.length} -- >>> lines gave no value. The first: ${failures[0]}`);
    }
  };

  store.add(
    api.languages.registerCodeLensProvider(idrisDocumentSelector(), {
      onDidChangeCodeLenses: lensesChanged.event,
      provideCodeLenses: (doc) => {
        if (!deps.trust.isTrusted || doc.uri.scheme !== 'file') {
          return [];
        }
        const lines = docEvalLines(doc);
        const range = (line: DocEvalLine): vscode.Range => new api.Range(line.line, line.range.start.character, line.line, line.range.end.character);
        return lines.flatMap((line, index) => [
          new api.CodeLens(range(line), { title: 'Run', command: RUN_DOC_EVAL_COMMAND, arguments: [{ uri: doc.uri.toString(), line: line.line }] }),
          ...(index === 0 && lines.length > 1 ? [new api.CodeLens(range(line), { title: `Run all (${lines.length})`, command: RUN_ALL_DOC_EVAL_COMMAND })] : []),
        ]);
      },
    }),
  );

  store.add(api.commands.registerCommand(OPEN_REPL_COMMAND, guarded('Open REPL', openRepl)));
  store.add(api.commands.registerCommand(SEND_TO_REPL_COMMAND, guarded('Send to REPL', sendToRepl)));
  store.add(api.commands.registerCommand(REPL_TYPE_COMMAND, guarded('Type in REPL', () => askRepl(':t', 'Type in REPL'))));
  store.add(api.commands.registerCommand(REPL_DOCS_COMMAND, guarded('Docs in REPL', () => askRepl(':doc', 'Docs in REPL'))));
  store.add(api.commands.registerCommand(QUERY_COMMAND, guarded('Query', query)));
  store.add(api.commands.registerCommand(RUN_DOC_EVAL_COMMAND, guarded('Run', runLine)));
  store.add(api.commands.registerCommand(RUN_ALL_DOC_EVAL_COMMAND, guarded('Run All', runAll)));

  return {
    view: {
      launches: terminals.launches,
      typed: terminals.typed,
      terminalOf: async (doc) => terminals.of(await deps.projects.classify(doc.fileName)),
    },
    dispose: () => store.dispose(),
  };
}
