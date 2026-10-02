/**
 * The editing commands (`types.ts`, the table and *One edit*): what each one runs, from finding its
 * target to applying the compiler's answer. `register.ts` registers them.
 *
 * **Every command but the two that continue a cycle** (`at`):
 * 1. The document and the position: the active editor's — or, from a code action, the
 *    `EditingCommandArgs`' open document and position (any other argument, such as a URI a menu
 *    passes, is ignored: the active editor's). An Idris file on disk (`file` scheme) in a style
 *    `targets.ts` reads, in a trusted workspace. Case Split and Make With refuse a clause whose
 *    left-hand side starts on an earlier line (`lhsStartsAbove`), Add Clause and Generate Definition a
 *    `%foreign` or `%extern` function (`DeclarationTarget.foreign`). The target at that position (`TARGET_OF`,
 *    `targets.ts`); from a code action it must still be the name the action offered, else the file
 *    changed since. **Add Missing Cases** takes the function of a coverage
 *    error on the cursor's lines, else the type declaration at the cursor (so that a `partial`
 *    function, which has no coverage error, can be completed too). **Refine Hole…** then asks for
 *    the expression in an input box.
 * 2. Save before (`saveBeforeAction.ts`); when the text changed since the target was read (a
 *    formatter that runs on save, an edit while the input box was open), the target's line must
 *    still have its text (but for white space at its end, which `files.trimTrailingWhitespace`
 *    removes), and the target read again at its position must be the same name.
 * 3. Ask: `DocumentQueries.run(doc, 'command', …)` with `version` = `doc.version` right after the
 *    save, so a document not loaded, or loaded at another text, is loaded the way **Check File**
 *    loads it and asked again (`IdrisBackend.edit`) — unless the document changed since that version
 *    (typed into while its check ran): then nothing is asked, and the command says so (`CHANGED`). A search (Proof Search, Generate Definition)
 *    first ends the cycles of its root (`CyclingController.searchStarted`), and runs, like both
 *    **Next** commands, Refine Hole (whose expression can take long to check), Intro, Make Lemma and
 *    Add Missing Cases (`LONG_KINDS`, the backend's long requests), under `longRunning.ts`: the window's progress, and
 *    after `CANCEL_OFFER_MS` (1 s, Evaluate Selection's) a notification whose Cancel cancels the
 *    request (`EditRequest.token`) and ends the command at once. The others run under the window's
 *    progress only.
 * 4. The answer: an `edit` is applied (`apply.ts`) — a search's first result starts a cycle
 *    (`cycling.ts`); `choices` go to a QuickPick of their labels (`quickPickText`), except a single
 *    Intro candidate, which is applied without asking, and the chosen one is applied as an `edit`;
 *    `failed` is shown through `messages.ts` `failureText`; `exhausted` says there are no more
 *    results.
 *
 * **Next Result / Next Definition** (`next`) continue the active editor's document's cycle (`continues`):
 * Next Result a cycle of either kind, asking for the `-Next` of the cycle's kind (ROADMAP §9 Q26),
 * Next Definition only a Generate Definition's. They never save and never load (they call the
 * backend directly, not through `DocumentQueries`, whose load would end the compiler's search), send
 * the range the cycle follows (`NextRequest.previous`) with the version its last result left, and
 * apply the answer as a fresh replacement with its own undo step. A result the same as the one shown
 * (the compiler may repeat one) changes nothing, and the cycle goes on. Without a cycle they continue,
 * they say why: Next Definition in a Proof Search cycle, that Next Result continues it (also while
 * Next Result runs for the document); else why the document's last cycle of a kind they continue
 * ended (`CyclingController.lastEnd`), or that a search must be run first.
 * **Generate Definition** with the cursor on the declaration or the result of the document's
 * Generate Definition cycle runs Next Definition (`CyclingController.continuesDefinition`).
 *
 * **One at a time per document** (`running`): from finding its target (Refine's input box and a
 * QuickPick included) to the answer applied, any other editing command on that document — the same
 * one again included — says which one is running and sends nothing. Otherwise the second answer
 * would be refused as a change of the file made by the first.
 *
 * **Texts.** Every message is one `plainText(…)` call of a text made one line with its control and
 * format characters written out (`editorLabel`: they quote names of the document and compiler
 * text); a handler never rejects (`run`). Nothing here sends a name or an expression anywhere but in
 * an `EditRequest`, whose backend checks names and puts the expression in its string slot.
 *
 * Only type imports from `vscode`.
 */
import type * as vscode from 'vscode';
import { rootKey } from '../../backend/registry';
import type { EditChoice, EditKind, EditRequest, EditResult, NextRequest, TextReplacement } from '../../backend/types';
import { errorText, IdrisException, isCancelled } from '../../core/errors';
import { plainText } from '../../core/notificationText';
import type { EditorPosition, EditorRange } from '../../core/positions';
import { editorLabel, quickPickText } from '../../core/untrustedText';
import { isIdrisDocument } from '../../project/literate';
import type { Classification } from '../../project/types';
import { CANCEL_OFFER_MS } from '../eval/register';
import type { QueryOutcome } from '../intelligence/types';
import { applyReplacements, type ApplyOutcome } from './apply';
import { CYCLE_ENDED, NEXT_COMMAND, type CycleKind, type CyclingController } from './cycling';
import { longRunning } from './longRunning';
import { commandName, EDITING_COMMAND_KINDS, failureText, MAX_SHOWN, NEEDS, refusalText, TARGET_OF } from './messages';
import { saveBeforeAction } from './saveBeforeAction';
import { coverageFunctionOf, declarationAt, holeAt, isReadable, lhsStartsAbove, patternVariableAt } from './targets';
import type { CycleState, EditingCommandArgs, EditingCommandId, EditingDeps, EditingOutcome } from './types';

/** The part of the `vscode` namespace the commands use. */
export type EditingCommandsApi = Pick<
  typeof vscode,
  'window' | 'workspace' | 'languages' | 'Position' | 'Range' | 'WorkspaceEdit' | 'EndOfLine' | 'ProgressLocation' | 'CancellationTokenSource'
>;

export interface EditingCommandsOptions {
  /** Keep the outcomes (`EditingRegistration.outcomes`; `extension.ts` sets it under the test runner). */
  readonly keepOutcomes?: boolean;
  /** `CANCEL_OFFER_MS` unless a test sets it. */
  readonly cancelOfferMs?: number;
}

/** The kinds that act at the cursor (every kind but the two `-Next`). */
type AtKind = Exclude<EditKind, 'exprSearchNext' | 'generateDefNext'>;
type NextKind = 'exprSearchNext' | 'generateDefNext';

/** What a command acts on: the name it sends, where, and for a declaration its lines. */
interface Target {
  readonly name: string;
  readonly pos: EditorPosition;
  readonly declaration?: EditorRange;
}

/** The kinds that run under `longRunning` (module comment, step 3): the backend's long requests. */
const LONG_KINDS: ReadonlySet<AtKind> = new Set(['exprSearch', 'generateDef', 'refine', 'intro', 'makeLemma', 'addMissingCases']);

/** What `ask`'s query answers when the document changed after the version it asks for (module comment, step 3). */
const CHANGED = Symbol('changed');

const SEARCHES: Readonly<Record<CycleKind, string>> = { exprSearch: 'Proof Search', generateDef: 'Generate Definition' };

/** The request that asks for the next result of each kind of cycle. */
const NEXT_KIND: Readonly<Record<CycleKind, NextKind>> = { exprSearch: 'exprSearchNext', generateDef: 'generateDefNext' };

/**
 * Whether `command` continues a cycle of `kind` (module comment, *Next Result / Next Definition*):
 * Next Result either kind (ROADMAP §9 Q26); Next Definition, and Generate Definition on the cycle's
 * declaration or result, a Generate Definition's.
 */
function continues(command: EditingCommandId, kind: CycleKind): boolean {
  return command === 'idris2.nextResult' || (kind === 'generateDef' && (command === 'idris2.nextDefinition' || command === 'idris2.generateDefinition'));
}

/** The kind of cycle each search command starts (`stillRunning`). */
const SEARCH_OF: Partial<Readonly<Record<EditingCommandId, CycleKind>>> = {
  'idris2.proofSearch': 'exprSearch',
  'idris2.generateDefinition': 'generateDef',
};

/**
 * What `command` says while `busy` runs for the same document (`EditingCommands.running`). While a
 * search runs, the search again or a Next command is told how to get the next result once the first
 * is shown: Next Definition, while a Generate Definition runs, for itself; else Next Result (Generate
 * Definition continues the cycle only on its declaration or result, wherever the cursor is then).
 */
function stillRunning(busy: EditingCommandId, command: EditingCommandId): string {
  const running = `Idris 2: ${commandName(busy)} is still running for this file`;
  const search = SEARCH_OF[busy];
  if (search !== undefined && (command === busy || command === 'idris2.nextResult' || command === 'idris2.nextDefinition')) {
    const next = continues(command, search) && command !== 'idris2.generateDefinition' ? command : 'idris2.nextResult';
    return `${running}; once its result is shown, run ${commandName(next)} for the next one.`;
  }
  return command === busy ? `${running}.` : `${running}; run ${commandName(command)} once it has finished.`;
}

/** Whether `value` is an `EditingCommandArgs` (a code action's argument). */
function isCommandArgs(value: unknown): value is EditingCommandArgs {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { uri, position, name } = value as Partial<Record<keyof EditingCommandArgs, unknown>>;
  if (typeof uri !== 'string' || typeof name !== 'string' || typeof position !== 'object' || position === null) {
    return false;
  }
  const { line, character } = position as Partial<Record<keyof EditorPosition, unknown>>;
  return Number.isInteger(line) && Number.isInteger(character) && (line as number) >= 0 && (character as number) >= 0;
}

export class EditingCommands {
  readonly outcomes: EditingOutcome[] = [];
  /** Per document (`uri.toString()`), the command running for it now: one at a time (`stillRunning`). */
  private readonly running = new Map<string, EditingCommandId>();

  constructor(
    private readonly api: EditingCommandsApi,
    private readonly deps: EditingDeps,
    private readonly cycles: CyclingController,
    private readonly options: EditingCommandsOptions = {},
  ) {}

  /** Runs `command` (with the argument VS Code passed); never rejects (module comment, *Texts*). */
  async run(command: EditingCommandId, args: unknown): Promise<void> {
    try {
      const kind = EDITING_COMMAND_KINDS[command];
      if (kind === 'exprSearchNext' || kind === 'generateDefNext') {
        await this.next(command);
      } else {
        await this.at(command, kind, isCommandArgs(args) ? args : undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.error(`${commandName(command)} failed: ${message}`);
      this.say(command, `Idris 2: ${commandName(command)} failed: ${message}`, 'error');
    }
  }

  // --- outcomes ------------------------------------------------------------------------------

  private record(outcome: EditingOutcome): void {
    if (this.options.keepOutcomes === true) {
      this.outcomes.push(outcome);
    }
  }

  /**
   * Shows `text` as one line with its control and format characters written out, and records it.
   * Not awaited: a notification's promise settles only when it is dismissed.
   */
  private say(command: EditingCommandId, text: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
    const shown = editorLabel(text);
    this.deps.log.info(shown);
    this.record({ command, kind: 'message', message: shown });
    if (severity === 'info') {
      void this.api.window.showInformationMessage(plainText(shown));
    } else if (severity === 'warning') {
      void this.api.window.showWarningMessage(plainText(shown));
    } else {
      void this.api.window.showErrorMessage(plainText(shown));
    }
  }

  // --- the commands at the cursor ------------------------------------------------------------

  private async at(command: EditingCommandId, kind: AtKind, args: EditingCommandArgs | undefined): Promise<void> {
    const name = commandName(command);
    const needs = NEEDS[TARGET_OF[kind]];
    const place = this.placeOf(args);
    if (place === undefined) {
      this.say(command, args === undefined ? `Idris 2: ${name} works in an Idris file: ${needs}` : `Idris 2: the file ${name} was offered for is not open any more.`);
      return;
    }
    const { doc, pos } = place;
    if (!this.deps.trust.isTrusted) {
      this.say(command, `Idris 2: nothing is run in Restricted Mode. Trust the workspace to use ${name}.`);
      return;
    }
    if (doc.uri.scheme !== 'file') {
      this.say(command, `Idris 2: ${name} needs the file saved on disk: the compiler reads it from there.`);
      return;
    }
    if (!isReadable(doc)) {
      this.say(command, `Idris 2: ${name} works in .idr files and bird-track .lidr files only.`);
      return;
    }
    if ((kind === 'caseSplit' || kind === 'makeWith') && lhsStartsAbove(doc, pos)) {
      this.say(command, `Idris 2: ${name} needs a clause whose left-hand side starts on the line of its =: the compiler rewrites that one line, and this clause starts on an earlier line.`);
      return;
    }
    if ((kind === 'addClause' || kind === 'generateDef') && declarationAt(doc, pos)?.foreign === true) {
      this.say(command, `Idris 2: ${name} is not available on a %foreign or %extern function: it is defined outside Idris and has no clauses.`);
      return;
    }
    const uri = doc.uri.toString();
    if (command === 'idris2.generateDefinition' && args === undefined && this.cycles.continuesDefinition(uri, pos)) {
      await this.next(command);
      return;
    }
    const busy = this.running.get(uri);
    if (busy !== undefined) {
      this.say(command, stillRunning(busy, command));
      return;
    }
    this.running.set(uri, command);
    try {
      await this.atTarget(command, kind, args, doc, pos);
    } finally {
      this.running.delete(uri);
    }
  }

  /** `at` from the target on, while `command` is the one running for `doc`. */
  private async atTarget(command: EditingCommandId, kind: AtKind, args: EditingCommandArgs | undefined, doc: vscode.TextDocument, pos: EditorPosition): Promise<void> {
    const name = commandName(command);
    const needs = NEEDS[TARGET_OF[kind]];
    const found = this.targetAt(kind, doc, pos);
    const foundAt = doc.version;
    if (found === undefined || (args !== undefined && found.name !== args.name)) {
      this.say(command, found === undefined ? `Idris 2: ${name}: ${needs}` : `Idris 2: the file changed since ${name} was offered; run it again.`);
      return;
    }
    const foundLine = doc.lineAt(found.pos.line).text;
    let hint: string | undefined;
    if (kind === 'refine') {
      hint = await this.api.window.showInputBox({
        prompt: plainText(`Idris 2: refine ?${editorLabel(found.name, MAX_SHOWN)} with an expression. The compiler checks it against the hole's type.`),
        placeHolder: 'An expression, such as S or plus',
        // Kept open while the user looks elsewhere (the hole's type in the Holes view): VS Code closes
        // it on a focus change otherwise, and the typed expression is lost (ninth review of M4).
        ignoreFocusOut: true,
      });
      if (hint === undefined) {
        this.record({ command, kind: 'cancelled' });
        return;
      }
      if (!/\S/u.test(hint)) {
        this.say(command, `Idris 2: ${name} needs an expression.`);
        return;
      }
    }
    const root = await this.deps.projects.classify(doc.fileName);
    const saved = await saveBeforeAction(this.api, doc, this.deps.config.saveBeforeAction(doc.uri), name);
    if (saved.kind !== 'ready') {
      if (saved.kind === 'cancelled') {
        this.record({ command, kind: 'cancelled' });
      } else {
        this.say(command, saved.message);
      }
      return;
    }
    if (doc.isClosed) {
      this.say(command, `Idris 2: the file was closed; ${name} did not run.`);
      return;
    }
    // Changed since the target was read (a formatter run by the save, for one): read it again there,
    // while its line still has its text (with a line added or removed above, another line is there,
    // which may have a name of the same text in that column) — but for white space at its end, which
    // files.trimTrailingWhitespace removes on an explicit save, the cursor's line included.
    const sameLine = found.pos.line < doc.lineCount && doc.lineAt(found.pos.line).text.trimEnd() === foundLine.trimEnd();
    const target = doc.version === foundAt ? found : sameLine ? this.targetAt(kind, doc, found.pos) : undefined;
    if (target === undefined || target.name !== found.name) {
      this.say(command, `Idris 2: the file changed at the cursor before ${name} could ask the compiler; run it again.`);
      return;
    }
    const search: CycleKind | undefined = kind === 'exprSearch' || kind === 'generateDef' ? kind : undefined;
    await this.ask(command, kind, doc, root, target, hint, search === undefined ? undefined : { kind: search, number: this.cycles.searchStarted(rootKey(root)) });
  }

  /**
   * Step 3 and 4 of the module comment for `target` of `doc`, whose file belongs to `root`; `search`:
   * the kind of cycle the request starts and its number (`CyclingController.searchStarted`).
   */
  private async ask(
    command: EditingCommandId,
    kind: AtKind,
    doc: vscode.TextDocument,
    root: Classification,
    target: Target,
    hint: string | undefined,
    search: { readonly kind: CycleKind; readonly number: number } | undefined,
  ): Promise<void> {
    const name = commandName(command);
    const key = rootKey(root);
    const version = doc.version;
    const at = new this.api.Position(target.pos.line, target.pos.character);
    const request = (token: vscode.CancellationToken | undefined): EditRequest => {
      const base = { doc, version, pos: at, name: target.name, ...(token === undefined ? {} : { token }) };
      return kind === 'exprSearch' ? { ...base, kind, hints: [] } : kind === 'refine' ? { ...base, kind, hint: hint ?? '' } : { ...base, kind };
    };
    /** The root's epoch when the answer arrived (`CyclingController.start`). */
    let answeredAt = 0;
    // A change after `version` makes the backend answer `NotLoaded` (the document no longer shows the
    // text it loaded), and `run` would load the file again and ask again in vain: stop instead.
    const ask = (token: vscode.CancellationToken | undefined): Promise<QueryOutcome<EditResult | typeof CHANGED>> =>
      this.deps.queries.run(doc, 'command', (backend) =>
        doc.version !== version
          ? Promise.resolve(CHANGED)
          : backend.edit(request(token)).then((result) => {
              answeredAt = this.cycles.epoch(key);
              return result;
            }),
      );
    const asked = LONG_KINDS.has(kind)
      ? await longRunning(this.api, name, ask, this.options.cancelOfferMs ?? CANCEL_OFFER_MS, true)
      : ({ value: await this.windowProgress(name, () => ask(undefined)), cancelled: false } as const);
    if (asked.cancelled) {
      this.record({ command, kind: 'cancelled' });
      return;
    }
    if (asked.value.kind === 'unavailable') {
      this.say(command, refusalText(name, asked.value.reason), 'warning');
      return;
    }
    const result = asked.value.value;
    if (result === CHANGED) {
      this.say(command, `Idris 2: the file changed while it was being checked for ${name}, so the compiler was not asked. Run ${name} again.`);
      return;
    }
    const onApplied =
      search === undefined
        ? undefined
        : (range: EditorRange | undefined): void => {
            const uri = doc.uri.toString();
            if (range === undefined) {
              this.cycles.notStarted(uri, search.kind, 'changed');
            } else {
              this.cycles.start({ uri, kind: search.kind, root: key, range, version: doc.version, declaration: target.declaration }, search.number, answeredAt);
            }
          };
    switch (result.type) {
      case 'edit':
        await this.applyEdit(command, doc, version, result.replacements, onApplied);
        return;
      case 'choices':
        await this.choose(command, doc, version, result.reason, result.choices);
        return;
      case 'failed': {
        // The file's last load reported errors, in it or in its package file (messages.ts).
        const status = this.deps.checks.statusOf(doc, root);
        const loadFailed = status?.kind === 'packageError' || (status?.kind === 'checked' && status.errors > 0);
        this.say(command, failureText(command, result.message, loadFailed), 'warning');
        return;
      }
      case 'exhausted':
        this.say(command, `Idris 2: ${name}: no more results.`);
        return;
    }
  }

  /** The document and position a command acts at (module comment, step 1), or `undefined` when there is none. */
  private placeOf(args: EditingCommandArgs | undefined): { readonly doc: vscode.TextDocument; readonly pos: EditorPosition } | undefined {
    if (args === undefined) {
      const editor = this.api.window.activeTextEditor;
      return editor !== undefined && isIdrisDocument(editor.document) ? { doc: editor.document, pos: editor.selection.active } : undefined;
    }
    const doc = this.api.workspace.textDocuments.find((d) => d.uri.toString() === args.uri);
    return doc !== undefined && !doc.isClosed && isIdrisDocument(doc) ? { doc, pos: args.position } : undefined;
  }

  /** The target of `kind` at `pos` of `doc` (`TARGET_OF`, `targets.ts`). */
  private targetAt(kind: AtKind, doc: vscode.TextDocument, pos: EditorPosition): Target | undefined {
    switch (TARGET_OF[kind]) {
      case 'hole': {
        const hole = holeAt(doc, pos);
        return hole === undefined ? undefined : { name: hole.name, pos: hole.range.start };
      }
      case 'patternVariable': {
        const variable = patternVariableAt(doc, pos);
        return variable === undefined ? undefined : { name: variable.name, pos: variable.range.start };
      }
      case 'declaration': {
        const declaration = declarationAt(doc, pos);
        return declaration === undefined ? undefined : { name: declaration.name, pos: declaration.nameRange.start, declaration: declaration.range };
      }
      case 'coverage': {
        const covered = this.api.languages
          .getDiagnostics(doc.uri)
          .filter((d) => d.range.start.line <= pos.line && pos.line <= d.range.end.line)
          .map((d) => coverageFunctionOf(doc, d))
          .find((fn) => fn !== undefined);
        const fn = covered ?? declarationAt(doc, pos);
        return fn === undefined ? undefined : { name: fn.name, pos: fn.nameRange.start };
      }
    }
  }

  // --- the answer ----------------------------------------------------------------------------

  /**
   * Applies `replacements` to `doc` at `version` (`apply.ts`) and says what went wrong, if anything.
   * `onApplied` (a search's first result) gets the range the single replacement's text covers now,
   * or `undefined` when another change of the document came while it was applied (the change is
   * counted as the result's own only when it came alone, `CyclingController.applyOwn`).
   */
  private async applyEdit(
    command: EditingCommandId,
    doc: vscode.TextDocument,
    version: number,
    replacements: readonly TextReplacement[],
    onApplied?: (range: EditorRange | undefined) => void,
  ): Promise<ApplyOutcome> {
    const name = commandName(command);
    if (replacements.length === 0) {
      this.say(command, `Idris 2: ${name}: the compiler's answer changes nothing.`);
      return { kind: 'unchanged' };
    }
    const uri = doc.uri.toString();
    const apply = (): Promise<ApplyOutcome> => applyReplacements(this.api, doc, version, replacements);
    const own = onApplied === undefined ? { outcome: await apply(), alone: false } : await this.cycles.applyOwn(uri, apply);
    const { outcome } = own;
    switch (outcome.kind) {
      case 'applied':
        this.record({ command, kind: 'applied', uri });
        onApplied?.(own.alone && outcome.ranges.length === 1 ? outcome.ranges[0] : undefined);
        break;
      case 'changed':
        this.say(command, `Idris 2: the file changed while the compiler worked, so its answer was not applied. Run ${name} again.`);
        break;
      case 'closed':
        this.say(command, `Idris 2: the file was closed before the compiler answered; nothing was changed.`);
        break;
      case 'invalid':
        this.deps.log.warn(`${name} in ${doc.fileName}: the answer does not fit the document: ${outcome.reason}`);
        this.say(command, `Idris 2: ${name}: the compiler's answer does not fit the file (${outcome.reason}); nothing was changed.`, 'warning');
        break;
      case 'unchanged':
        this.say(command, `Idris 2: ${name}: the compiler's answer leaves the file as it is.`);
        break;
      case 'refused':
        this.say(command, `Idris 2: VS Code did not apply the edit of ${name}; nothing was changed.`, 'warning');
        break;
    }
    return outcome;
  }

  /** `choices` (module comment, step 4): a single Intro candidate is applied without asking. */
  private async choose(
    command: EditingCommandId,
    doc: vscode.TextDocument,
    version: number,
    reason: 'intro' | 'ambiguous',
    choices: readonly EditChoice[],
  ): Promise<void> {
    if (choices.length === 0) {
      this.say(command, `Idris 2: ${commandName(command)}: the compiler offered nothing to choose from.`);
      return;
    }
    let chosen: EditChoice | undefined = reason === 'intro' && choices.length === 1 ? choices[0] : undefined;
    if (chosen === undefined) {
      const items = choices.map((choice) => ({ label: quickPickText(editorLabel(choice.label, MAX_SHOWN)), choice }));
      const picked = await this.api.window.showQuickPick(items, {
        placeHolder: reason === 'intro' ? 'Idris 2: what to put into the hole' : 'Idris 2: the name is ambiguous; choose the one to refine the hole with',
      });
      chosen = picked?.choice;
    }
    if (chosen === undefined) {
      this.record({ command, kind: 'cancelled' });
      return;
    }
    await this.applyEdit(command, doc, version, chosen.replacements);
  }

  // --- the two commands that continue a cycle ------------------------------------------------

  private async next(command: EditingCommandId): Promise<void> {
    const name = commandName(command);
    const searches = (['exprSearch', 'generateDef'] as const)
      .filter((kind) => continues(command, kind))
      .map((kind) => SEARCHES[kind])
      .join(' or ');
    const doc = this.api.window.activeTextEditor?.document;
    if (doc === undefined || !isIdrisDocument(doc)) {
      this.say(command, `Idris 2: ${name} continues ${searches} in the active Idris file.`);
      return;
    }
    if (!this.deps.trust.isTrusted) {
      this.say(command, `Idris 2: nothing is run in Restricted Mode. Trust the workspace to use ${name}.`);
      return;
    }
    const uri = doc.uri.toString();
    const busy = this.running.get(uri);
    const cycle = this.cycles.cycleOf(uri);
    if (busy !== undefined) {
      // Another command loads the file before it asks when the file changed since the last load (always once a result
      // was applied), which ends the cycle: no advice. Next Result running: not "run <command> once it has finished"
      // when the cycle is of a kind the command does not continue.
      const plain = SEARCH_OF[busy] === undefined && busy !== 'idris2.nextResult' && busy !== 'idris2.nextDefinition';
      const other = busy === 'idris2.nextResult' && cycle !== undefined && !continues(command, cycle.kind);
      this.say(
        command,
        plain
          ? `Idris 2: ${commandName(busy)} is still running for this file.`
          : other
            ? `Idris 2: ${commandName(busy)} is still running for this file, and this file's cycle is ${SEARCHES[cycle.kind]}'s: once it has finished, run ${commandName('idris2.nextResult')}.`
            : stillRunning(busy, command),
      );
      return;
    }
    if (cycle === undefined || !continues(command, cycle.kind)) {
      const last = this.cycles.lastEnd(uri);
      const ended = last !== undefined && continues(command, last.kind) ? last : undefined;
      this.say(
        command,
        cycle !== undefined
          ? `Idris 2: this file's cycle is ${SEARCHES[cycle.kind]}'s: run ${commandName('idris2.nextResult')}, or click ↻ next in the status bar.`
          : ended !== undefined
            ? `Idris 2: the ${SEARCHES[ended.kind]} ended: ${CYCLE_ENDED[ended.why]}. Run ${SEARCHES[ended.kind]} again.`
            : `Idris 2: ${name} continues a ${searches}: run ${searches} first.`,
      );
      return;
    }
    this.running.set(uri, command);
    try {
      await this.continueCycle(command, NEXT_KIND[cycle.kind], doc, cycle);
    } finally {
      this.running.delete(uri);
    }
  }

  /** Asks for the next result of `cycle` (`kind`: the `-Next` of its kind) and applies it (`next`). */
  private async continueCycle(command: EditingCommandId, kind: NextKind, doc: vscode.TextDocument, cycle: CycleState): Promise<void> {
    const name = commandName(command);
    const search = SEARCHES[cycle.kind];
    const uri = cycle.uri;
    const root = await this.deps.projects.classify(doc.fileName);
    const backend = this.deps.registry.backendFor(root);
    type Answer = { readonly kind: 'result'; readonly result: EditResult } | { readonly kind: 'error'; readonly error: IdrisException } | { readonly kind: 'cancelled' };
    const asked = await longRunning(this.api, name, async (token): Promise<Answer> => {
      const request: NextRequest = { kind, doc, version: cycle.version, previous: cycle.range, token };
      try {
        return { kind: 'result', result: await backend.edit(request) };
      } catch (error) {
        if (error instanceof IdrisException) {
          return { kind: 'error', error };
        }
        if (isCancelled(error)) {
          return { kind: 'cancelled' };
        }
        throw error;
      }
    }, this.options.cancelOfferMs ?? CANCEL_OFFER_MS);
    if (asked.cancelled || asked.value.kind === 'cancelled') {
      this.cycles.end(uri, 'cancelled');
      this.record({ command, kind: 'cancelled' });
      return;
    }
    if (asked.value.kind === 'error') {
      this.cycles.end(uri, 'failed');
      // The backend's refusals of a `-Next` start with the title of the command of its kind
      // (`Next Definition: …`); Next Result and Generate Definition say them as theirs.
      const own = commandName(NEXT_COMMAND[cycle.kind]);
      const reason = errorText(asked.value.error.error);
      this.say(command, refusalText(name, reason.startsWith(`${own}:`) ? reason.slice(own.length + 1).trimStart() : reason), 'warning');
      return;
    }
    const result = asked.value.result;
    if (result.type === 'exhausted') {
      this.cycles.end(uri, 'exhausted');
      this.say(command, `Idris 2: ${search} has no more results.`);
      return;
    }
    if (result.type !== 'edit' || result.replacements.length !== 1) {
      this.cycles.end(uri, 'failed');
      this.say(command, result.type === 'failed' ? failureText(command, result.message, false) : `Idris 2: ${name}: the answer is not a result to apply.`, 'warning');
      return;
    }
    const { outcome, alone } = await this.cycles.applyOwn(uri, () => applyReplacements(this.api, doc, cycle.version, result.replacements));
    if (outcome.kind === 'unchanged') {
      // The compiler may give the same result twice in a row (`zip3` in transcript edits-searches
      // [live]); the search goes on.
      this.cycles.advance(uri, cycle.range, cycle.version);
      this.say(command, `Idris 2: ${search} gave the result shown again. Run ${name} for the one after it.`);
      return;
    }
    if (outcome.kind === 'applied') {
      this.record({ command, kind: 'applied', uri });
      if (alone) {
        this.cycles.advance(uri, outcome.ranges[0], doc.version);
      } else {
        this.cycles.end(uri, 'changed');
      }
      return;
    }
    this.cycles.end(uri, outcome.kind === 'changed' ? 'changed' : 'failed');
    this.say(
      command,
      outcome.kind === 'changed'
        ? `Idris 2: the file changed while the compiler worked, so its answer was not applied. Run ${search} again.`
        : outcome.kind === 'invalid'
          ? `Idris 2: ${name}: the compiler's answer does not fit the file (${outcome.reason}); nothing was changed.`
          : outcome.kind === 'closed'
            ? `Idris 2: the file was closed before the compiler answered; nothing was changed.`
            : `Idris 2: VS Code did not apply the edit of ${name}; nothing was changed.`,
      outcome.kind === 'invalid' || outcome.kind === 'refused' ? 'warning' : 'info',
    );
  }

  // --- progress ------------------------------------------------------------------------------

  private windowProgress<T>(name: string, run: () => Promise<T>): Promise<T> {
    return Promise.resolve(this.api.window.withProgress({ location: this.api.ProgressLocation.Window, title: plainText(`Idris 2: ${name}…`) }, run));
  }
}
