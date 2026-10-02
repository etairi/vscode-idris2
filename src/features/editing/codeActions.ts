/**
 * The light bulbs of the editing commands (`types.ts`, *Code actions*; ROADMAP M4, F34): computed
 * from the text alone (`targets.ts`), sending nothing to the compiler, each action carrying its
 * command with `EditingCommandArgs` and no edit, under the idris2-lsp filter key of its kind
 * (`EditCodeActionKind`), so that one `context.only` means the same on both backends:
 * - at a hole: Proof Search, Intro, Refine Hole…, Make Lemma (not on a hole named by a keyword,
 *   after which the lemma could not be named, nor in an `interface`: `inBlockOf`), Make With (only
 *   where the IDE backend sends it: the hole alone after a function clause's `=`,
 *   `core/idrisSyntax.ts` `withClauseStart`, in a clause whose left-hand side does not start on an
 *   earlier line, `lhsStartsAbove`), Make Case;
 * - at a pattern variable that Case Split applies to as offered (`PatternVariableTarget.offered`):
 *   Case Split;
 * - at a type declaration of one name that no clause follows, not `%foreign` or `%extern`
 *   (`DeclarationTarget.foreign`): Add Clause and Generate Definition
 *   (where the function has clauses, Add Clause adds a catch-all after them, often with its hole
 *   `<f>_rhs` named again; the command still does it);
 * - the quick fix Add Missing Cases on each coverage error that lists missing cases
 *   (`isMissingCasesDiagnostic`) among the diagnostics VS Code passes, for the function whose type
 *   declaration (of one name, not local to a definition: `DeclarationTarget.local`, not in a
 *   `parameters` block: `inBlockOf`) the error is on.
 * An action is offered only while the backend of the document's root has its capability
 * (`editing`; `intro`; `refine`; `missingCases`), for a file on disk, in a trusted workspace, not in
 * a folder answered Don't Allow; while the root's compiler has failed all are disabled
 * (`register.ts`, `BACKEND_FAILED`). After a
 * check that reported errors (`loadFailed`) Case Split, Add Clause and Generate Definition are
 * disabled (`AFTER_FAILED_LOAD`): after such a load the compiler no longer finds declarations and
 * clauses by their lines (F16), and the IDE backend refuses them unasked. So are the other actions
 * that backend refuses unsent for their line: those three below a bird-track line of a marker and
 * spaces only that makes the compiler read another line (`misreadBelow`) and in a literate file with
 * a `\r` (`CRLF_LITERATE`), Case Split on a line whose answer the compiler would garble
 * (`core/idrisSyntax.ts` `caseSplitLineProblem`, `CASE_SPLIT_LINE`), Make Case on a hole that the
 * same `?name` text precedes on its line (`MAKE_CASE_NOT_FIRST`), and both on a line with a NUL
 * (`NUL_LINE`). Other refusals of the backend show only when the command runs: a lone `\r` in a file
 * that is not literate, a file that ends inside a block comment or string, Make With on a clause
 * with a NUL, and those that depend on the lines below or the rest of the definition (every action
 * at a hole but Make With when the rest of the hole's line starts a block entry, or the hole is in
 * a `parameters`, `using` or `with` header, and the first token below is right of
 * the hole, Make Lemma on a hole named like a local, Make With when `?<h>_rhs` exists, Add
 * Missing Cases on clauses in two places). VS Code leaves a disabled action out of the automatic light bulb and shows it
 * faded, with its reason, in the Refactor menu (`CodeAction.disabled`, vscode.d.ts 1.138 [doc]).
 *
 * The titles quote names from the document: one line each, control and format characters written
 * out (`editorLabel`; an identifier may hold them, `core/untrustedText.ts`), cut at `MAX_SHOWN`.
 *
 * No `vscode` import: `register.ts` makes the `vscode.CodeAction`s.
 */
import type { Capabilities } from '../../backend/types';
import type { EditorPosition } from '../../core/positions';
import { caseSplitLineProblem, codeLineOf, doubledLinesText, isKeyword, misreadBelow, withClauseStart } from '../../core/idrisSyntax';
import { editorLabel } from '../../core/untrustedText';
import { compilerLiterateStyleOf, hasLineMarkers } from '../../project/literate';
import type { TextDoc } from '../intelligence/occurrence';
import { MAX_SHOWN } from './messages';
import { coverageFunctionOf, declarationAt, holeAt, inBlockOf, lhsStartsAbove, patternVariableAt, type DiagnosticLike } from './targets';
import type { EditCodeActionKind, EditingCommandArgs, EditingCommandId } from './types';

/** An action before it is made a `vscode.CodeAction`. */
export interface EditingAction<D extends DiagnosticLike = DiagnosticLike> {
  readonly title: string;
  readonly kind: EditCodeActionKind;
  readonly command: EditingCommandId;
  readonly args: EditingCommandArgs;
  /** The coverage error a quick fix resolves. */
  readonly diagnostic?: D;
  /** Why it cannot run now (`vscode.CodeAction.disabled`). */
  readonly disabled?: string;
}

/** The reason of the actions disabled after a check with errors (module comment). */
export const AFTER_FAILED_LOAD = 'The file did not check cleanly: fix the first error and save.';

/** The reason Case Split, Add Clause and Generate Definition are disabled in a literate file with a `\r` (module comment). */
export const CRLF_LITERATE = 'Not available in a literate file with CRLF line breaks: convert them to LF.';

/** The reasons Case Split is disabled on a line whose answer the compiler would garble (`caseSplitLineProblem`, module comment). */
export const CASE_SPLIT_LINE: Readonly<Record<NonNullable<ReturnType<typeof caseSplitLineProblem>>, string>> = {
  of: 'The word of on this line (in a case, a comment or a string) makes the compiler garble its answer.',
  paren: 'The compiler would drop a closing parenthesis from the new lines: remove the parentheses around the hole.',
  string: 'A string on this line holds a name of the clause or a hole, which the compiler would rewrite too.',
  namedArgument: 'A named argument here is matched with a variable of its own name ({n = n}): write {n}, or rename the variable.',
};

/** The reason Case Split and Make Case are disabled on a line with a NUL (module comment). */
export const NUL_LINE = 'This line holds a NUL character, which the compiler drops with the text after it.';

/** The reason Make Case is disabled on a hole that is not the first `?name` text of its line (module comment). */
export const MAKE_CASE_NOT_FIRST = 'Make Case rewrites the first ?name of the line, and this line has that text before this hole.';

/** Every kind the provider can return (its `providedCodeActionKinds`). */
export const EDITING_ACTION_KINDS: readonly EditCodeActionKind[] = [
  'refactor.rewrite.ExprSearch',
  'refactor.rewrite.Intro',
  'refactor.rewrite.RefineHole',
  'refactor.extract.MakeLemma',
  'refactor.rewrite.MakeWith',
  'refactor.rewrite.MakeCase',
  'refactor.rewrite.CaseSplit',
  'refactor.rewrite.AddClause',
  'refactor.rewrite.GenerateDef',
  'quickfix',
];

/** The capabilities the actions depend on. */
export type EditingCapabilities = Pick<Capabilities, 'editing' | 'intro' | 'refine' | 'missingCases'>;

/**
 * The actions at `pos` of `doc` (module comment), with `diagnostics` the ones VS Code passes for
 * the range asked about; `loadFailed`: the document's last check reported errors and it has not
 * changed since. `uri` is `doc.uri.toString()`.
 */
export function editingActionsAt<D extends DiagnosticLike>(
  doc: TextDoc,
  pos: EditorPosition,
  caps: EditingCapabilities,
  diagnostics: readonly D[],
  loadFailed = false,
): EditingAction<D>[] {
  const uri = doc.uri.toString();
  const style = compilerLiterateStyleOf(doc);
  const actions: EditingAction<D>[] = [];
  /** `disabled`: why the backend would refuse it unsent (module comment). */
  const add = (title: string, kind: EditCodeActionKind, command: EditingCommandId, position: EditorPosition, name: string, disabled?: string, diagnostic?: D): void => {
    const args: EditingCommandArgs = { uri, position: { line: position.line, character: position.character }, name };
    const byLine = command === 'idris2.caseSplit' || command === 'idris2.addClause' || command === 'idris2.generateDefinition';
    const action: EditingAction<D> = diagnostic === undefined ? { title, kind, command, args } : { title, kind, command, args, diagnostic };
    const reason = loadFailed && byLine ? AFTER_FAILED_LOAD : disabled;
    actions.push(reason === undefined ? action : { ...action, disabled: reason });
  };
  /** Why the compiler would read another line than `line` for Case Split, Add Clause or Generate Definition (`misreadBelow`). */
  const misread = (line: number, markerOnly: boolean): string | undefined => {
    if (hasLineMarkers(style) && doc.getText().includes('\r')) {
      return CRLF_LITERATE;
    }
    const doubled = misreadBelow(doc, line, markerOnly);
    return doubled.length === 0 ? undefined : `Not available below ${doubledLinesText(doubled)} a literate marker followed only by spaces: delete those spaces.`;
  };
  const hole = holeAt(doc, pos);
  if (hole !== undefined) {
    const shown = `?${editorLabel(hole.name, MAX_SHOWN)}`;
    const at = hole.range.start;
    if (caps.editing) {
      add(`Proof Search for ${shown}`, 'refactor.rewrite.ExprSearch', 'idris2.proofSearch', at, hole.name);
    }
    if (caps.intro) {
      add(`Intro for ${shown}`, 'refactor.rewrite.Intro', 'idris2.intro', at, hole.name);
    }
    if (caps.refine) {
      add(`Refine ${shown}…`, 'refactor.rewrite.RefineHole', 'idris2.refineHole', at, hole.name);
    }
    if (caps.editing) {
      if (!isKeyword(hole.name) && !inBlockOf(doc, at.line, 'interface')) {
        add(`Make Lemma for ${shown}`, 'refactor.extract.MakeLemma', 'idris2.makeLemma', at, hole.name);
      }
      const codeLine = (line: number) => (line >= 0 && line < doc.lineCount ? codeLineOf(style, doc.lineAt(line).text) : undefined);
      const onOneLine = hole.range.end.line === at.line;
      if (onOneLine && withClauseStart(codeLine, at.line, { start: at.character, end: hole.range.end.character }) !== undefined && !lhsStartsAbove(doc, at)) {
        add(`Make With for ${shown}`, 'refactor.rewrite.MakeWith', 'idris2.makeWith', at, hole.name);
      }
      const lineText = doc.lineAt(at.line).text;
      const first = lineText.indexOf(`?${hole.name}`) === at.character;
      add(`Make Case for ${shown}`, 'refactor.rewrite.MakeCase', 'idris2.makeCase', at, hole.name, lineText.includes('\u0000') ? NUL_LINE : first ? undefined : MAKE_CASE_NOT_FIRST);
    }
  }
  const variable = caps.editing && hole === undefined ? patternVariableAt(doc, pos) : undefined;
  if (variable?.offered === true) {
    const line = variable.range.start.line;
    const lineText = doc.lineAt(line).text;
    const problem = caseSplitLineProblem(lineText, codeLineOf(style, lineText)?.code ?? '');
    const disabled = misread(line, false) ?? (lineText.includes('\u0000') ? NUL_LINE : problem === undefined ? undefined : CASE_SPLIT_LINE[problem]);
    add(`Case Split on ${editorLabel(variable.name, MAX_SHOWN)}`, 'refactor.rewrite.CaseSplit', 'idris2.caseSplit', variable.range.start, variable.name, disabled);
  }
  const declaration = caps.editing && hole === undefined ? declarationAt(doc, pos) : undefined;
  if (declaration !== undefined && !declaration.several && !declaration.hasClauses && !declaration.foreign) {
    const shown = editorLabel(declaration.name, MAX_SHOWN);
    const disabled = misread(declaration.range.start.line, true);
    add(`Add Clause for ${shown}`, 'refactor.rewrite.AddClause', 'idris2.addClause', declaration.nameRange.start, declaration.name, disabled);
    add(`Generate Definition of ${shown}`, 'refactor.rewrite.GenerateDef', 'idris2.generateDefinition', declaration.nameRange.start, declaration.name, disabled);
  }
  if (caps.missingCases) {
    for (const diagnostic of diagnostics) {
      const fn = coverageFunctionOf(doc, diagnostic);
      if (fn !== undefined && !fn.several && !fn.local && !inBlockOf(doc, fn.nameRange.start.line, 'parameters')) {
        add(`Add Missing Cases of ${editorLabel(fn.name, MAX_SHOWN)}`, 'quickfix', 'idris2.addMissingCases', fn.nameRange.start, fn.name, undefined, diagnostic);
      }
    }
  }
  return actions;
}
