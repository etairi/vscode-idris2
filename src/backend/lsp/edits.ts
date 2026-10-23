/**
 * The interactive edits over idris2-lsp (`backend/lsp/edits.ts`, ROADMAP §5 M5, ARCHITECTURE §3.3;
 * the user's decision 3 of 2026-10-01, ROADMAP §9): for each `EditKind`, the request of the mapping
 * table of ARCHITECTURE §3.3, and how the server's answer becomes an `EditResult`. Pure:
 * `backend.ts` checks the document, sends the request through the language client and hands the
 * reply to `LspEditPlan.decode`.
 *
 * **M4's rules, not the server's edit.** The server's `WorkspaceEdit` is never applied as it is: it
 * puts a clause above the existing ones (Add Clause on `Part.idr` [live, recording `diagnostics`]), a
 * lemma's type on the line after the nearest blank line above the hole (`findBlankLine`,
 * `CodeAction/MakeLemma.idr` 44–46, 98 [src]), an answer of several tokens unbracketed (Intro's
 * `S ?vlen_rhs_0`), and Make With's range ends one character short of its line [live, recording
 * `actions-clean`]. So
 * each answer is checked to be for the place asked — the request's document only, the hole's range
 * or the line's, the name in the action's title (`decode`) — and only the answer is taken from it:
 * the expression, the rewritten line or lines, the clauses, the lemma's type and call. That answer is
 * what IDE mode's compiler answers for the same request (below), so it is handed, as IDE mode's
 * reply, to the plan of `backend/ide/edits.ts` (`planEdit`, `planNext`), which made every refusal
 * before anything was sent and now applies M4's rules: always bracket (`inPlace`, `isOneToken`), Make
 * Case's bracketed template (`madeCase`), the layout refusal (`layoutProblem`), the clause, lemma and
 * missing-case places (`clausesEnd`, `lemmaPlace`), the literate markers. Both backends therefore give
 * the same text for the same answer (the contract suite, `test/unit/contract.test.ts`). The version
 * check and the one undo step are the caller's (`features/editing/apply.ts`), as in IDE mode.
 *
 * **The answers** [src: idris2-lsp `9a2f0ad` `Language/LSP/CodeAction/*.idr`, `Server/QuickFix.idr`,
 * Idris2 `1c630e6` `Idris/REPL.idr`; live: the recordings `actions-clean`, `commands-clean`,
 * `edits-shapes`, `edits-searches`, `ambig`, `diagnostics`, `lit2`, `holes-ipkg` of
 * `test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a`, compared with the IDE-mode transcripts of the same
 * fixtures]. Every returned action has the generic kind (`refactor.rewrite`, Make Lemma
 * `refactor.extract`; F34), so an action is chosen by its title (and the kind, generic or the
 * specific key):
 * - Case Split, `Case split on ?<x>`: one edit of line L, from column 0 to the raw line's end, whose
 *   text is `updateCase`'s, as `:case-split`'s answer (both call `updateCase`; the literate marker
 *   kept on the rewritten lines, as in IDE mode [live, `lit2`, `lit2-editing`]).
 * - Add Clause, `Add clause`: an insertion of `getClause`'s line and a line break; IDE mode's
 *   `:add-clause` answers the line (both call `getClause`).
 * - Generate Definition, `Generate definition #<i> as ~ …`, i from 1: up to
 *   `idris2.lsp.maxCodeActionResults` actions, each an insertion of one definition's clauses and a
 *   line break each (the server's copy of `printClause`, `CodeAction/Utils.idr` 83–103, writes them
 *   as `:generate-def`'s, `Idris/REPL.idr` 206–225 [src]). They are the compiler's definitions, but
 *   not in IDE mode's order (E24): the first is IDE mode's first for `append` and `swap`, another for
 *   `zip3` and `(<||>)`, and #2 of `append` is IDE mode's third [live, the contract suite over the
 *   recordings]. The server's `Generate next definition` answers the first again at every
 *   request (cached per position [live, `actions-clean`]), so Next Definition takes the next of the
 *   numbered actions (`LspAnswer.more`).
 * - Make Lemma, `Make lemma for hole ?<qualified name>`: an insertion of `<marker >name : type` and
 *   two line breaks, and the call in place of the hole, bracketed by the compiler for a prefix
 *   argument (`(under_rhs n)`): IDE mode's `(:metavariable-lemma …)` holds the same two (`relit`, the
 *   same `addBracket`).
 * - Make Case, `Make case for hole ?<name>`: one edit of line L (to the raw line's end), whose text
 *   is `makeCase`'s; on a marked literate line each line `relit` and the whole followed by a line
 *   break (`unlines`), where IDE mode prefixes each line with the marker and a space (`relit` in
 *   `IDEMode/REPL.idr` 387–392) and adds no break — the same text once that break is dropped
 *   [live, `lit2`, `lit2-editing`].
 * - Make With, `Make with for hole ?<qualified name>`: one edit of line L from column 0 to the raw
 *   line's end less one, whose text is `makeWith`'s for the raw line L, the hole's own line
 *   (`CodeAction/MakeWith.idr`); on a marked line IDE mode prefixes each of its lines with the marker
 *   and a space, so that is done here [live, `lit2`: `> > vlen xs with (_)` / `>   > vlen xs | …`;
 *   `lit2-editing`: `> > > vlen xs with (_)` / `> >   > vlen xs | …`]. The server reads the hole's
 *   line, IDE mode the line of the clause's `=` (`withClauseStart`): with the hole on a line of its
 *   own below that `=` the server's answer is garbage (`  ?count_rhswith (_)` [live, `edits-shapes`]),
 *   so Make With is refused there before anything is sent.
 * - Proof Search, `Expression search on <name> as ~ …`: up to `idris2.lsp.maxCodeActionResults`
 *   actions, each replacing the hole's range by one result, bracketed by the compiler for a prefix
 *   argument as `:proof-search` brackets (both `addBracket` when the hole is in `bracketholes`); the
 *   first is IDE mode's first answer and the others its next results, in the same order, on every
 *   recorded hole (E24 [live]; the contract suite). With hints the request is `exprSearchWithHints`,
 *   whose server drops a hint it cannot parse as a name or find, without saying so
 *   (`exprSearchWithHints`, `CodeAction/ExprSearch.idr` 128–143 [src]); a hint is checked as a name
 *   before anything is sent (`nameProblem`), as in IDE mode.
 * - Intro, `Intro <candidate> over hole <name>`: one action per candidate, each replacing the hole's
 *   range by it, from the compiler's `Intro` edit as `:intro`'s (`process (Editing (Intro …))`); the
 *   candidates are IDE mode's list.
 * - Refine Hole: `executeCommand refineHole`, at most one action `Refine hole on <name>` replacing the
 *   hole's range by the compiler's `Refine` answer, as `:refine`'s. The server answers no action for an
 *   error, an ambiguity included, and logs the error only (F34; `Ambiguous elaboration` in its log
 *   [live, `ambig`]), so the alternatives IDE mode offers cannot be offered here: the refusal says so.
 * - Add Missing Cases: the quick fix `QuickFix: Add missing cases` (kind `quickfix`, F28) whose
 *   diagnostic, the coverage error, covers the declaration's line; the server keeps the quick fixes of
 *   the file's last load and answers all of them for any position (`quickfixes` [live,
 *   `diagnostics`]). Its text is one `<clause> = ?<f>_missing_case_<k>` line per missing clause, k
 *   from 1 (`addMissingCases`, `Server/QuickFix.idr` 41–46, the clause printed by `pshow`); the
 *   clauses are `:missing`'s, reported here under the name IDE mode's plan expects (`reportName`).
 *   There is a quick fix only for a coverage error (not for a `partial` function, which IDE mode
 *   completes too): the refusal says so.
 *
 * **Positions.** The server takes and sends the compiler's coordinates: the 0-based line of the
 * compiler's (unlit) text and the column in code points of that line (`findPointInTreeLoc (line, col)`;
 * `mkLocation'`) [src; live, `lit2`: `?vlen_rhs` on file line 8 of `Lit2.lidr` at `8:10-8:19`, its
 * unlit columns]. Its whole-line edits, though, end at the raw line's length in code points
 * (`length original` of `getSourceLine`), marker included (`8:0-8:21` [live]). `serverPosition` and the
 * ranges below compute both from the document's text. Below a bird-track line of a marker and white
 * space only, the compiler's line of a file line is one more (F11 addendum), and the server reads the
 * raw source line by that number (`getSourceLine (line + 1)`): Case Split, Add Clause and Generate
 * Definition are refused there by IDE mode's plan (`misreadBelow`), and Make Lemma, Make Case and Make
 * With, which IDE mode sends the raw line's number but the server cannot be sent it (it finds the hole
 * by the compiler's position), are refused here. A file with a carriage return that ends no line, and
 * a literate file with CRLF breaks, are refused for every kind: the compiler numbers their lines
 * otherwise than the editor (`core/positions.ts`, *Literate lines*).
 *
 * **Not the IDE-mode rules that need IDE mode.** The server finds a hole by its position, not by its
 * name, so IDE mode's `holeRefusal` (one hole of the name at the cursor among the load's holes) is not
 * applied: two holes `?todo` in two modules are told apart [live, `holes-ipkg`: `Holes.Main.todo`],
 * where IDE mode refuses. IDE mode's refusal after a load with errors (`EditPlan.afterFailedLoad`, F16)
 * is not applied either: the server processes a module with errors again to fill its metadata
 * (`loadURI`, `Server/ProcessMessage.idr` 242–252 [src]) and answered Add Clause on `Part.idr`, which
 * has two coverage errors [live, `diagnostics`]; the checks of the answer's place still apply.
 */
import type { CodeAction, CodeActionParams, Range, TextEdit } from 'vscode-languageclient';
import { IdrisException, unsupported } from '../../core/errors';
import { clauseName, codeLineOf, doubledLinesText, firstTokenColumn, levelTokens, markerOf, MODIFIER_KEYWORDS, NOTHING_OPEN, withClauseStart } from '../../core/idrisSyntax';
import { doubledLinesAbove, toCompilerColumn, type EditorPosition, type EditorRange } from '../../core/positions';
import { holeTokenAt, planEdit, planNext, type EditPlan, type EditText, type TokenColumns } from '../ide/edits';
import { holeName } from '../ide/holes';
import type { ReplyPayload } from '../ide/types';
import type { EditAtRequest, EditResult, ExprSearchRequest, NextRequest, RefineRequest } from '../types';
import type { ExprSearchWithHintsParams, RefineHoleParams } from './types';

// -------------------------------------------------------------------------------------------
// Plans
// -------------------------------------------------------------------------------------------

/** What `backend.ts` sends for an edit (ARCHITECTURE §3.3's mapping table). */
export type LspEditRequest =
  | { readonly method: 'codeAction'; readonly params: CodeActionParams }
  | { readonly method: 'exprSearchWithHints'; readonly args: readonly [ExprSearchWithHintsParams] }
  | { readonly method: 'refineHole'; readonly args: readonly [RefineHoleParams] };

/** The answer to an edit request. */
interface LspAnswer {
  readonly result: EditResult;
  /**
   * Proof Search and Generate Definition: the server's further results, in its order, which Next
   * Result and Next Definition apply one by one (`nextResult`). The server gives at most
   * `idris2.lsp.maxCodeActionResults` results in all.
   */
  readonly more?: readonly string[];
}

/** What `backend.ts` needs to send one edit request and read its answer. */
interface LspEditPlan {
  readonly request: LspEditRequest;
  /**
   * The answer: checked to be for the place asked and of the request's document only (`isDocument`:
   * whether a URI the server wrote names the request's document), then applied by IDE mode's plan.
   * Throws `Unsupported` for an answer that is not applied (none, for another place, refused by
   * M4's rules), `DirtyDocument` for the server's answer to a document with unsaved changes
   * (`null`), `ProtocolError` for an answer of another shape.
   */
  decode(reply: unknown, isDocument: (uri: string) => boolean): LspAnswer;
}

/**
 * `CodeActionTriggerKind.Invoked`: the user asked (a command), as vscode-languageclient also sends for
 * a request the user invokes; the server does not read it [src]. The value, not the protocol's
 * constant, so that the module needs nothing of vscode-languageclient at run time.
 */
const INVOKED = 1;

/** What an edit is called in the messages (as IDE mode's plans call it, `backend/ide/edits.ts`). */
const TITLES: Readonly<Record<EditAtRequest['kind'] | 'exprSearch' | 'refine', string>> = {
  caseSplit: 'Case Split',
  addClause: 'Add Clause',
  makeLemma: 'Make Lemma',
  makeCase: 'Make Case',
  makeWith: 'Make With',
  generateDef: 'Generate Definition',
  intro: 'Intro',
  addMissingCases: 'Add Missing Cases',
  exprSearch: 'Proof Search',
  refine: 'Refine Hole',
};

/** The code-action kinds the server's action modules accept as `context.only` (F34; ARCHITECTURE §3.3). */
const ONLY: Readonly<Record<Exclude<EditAtRequest['kind'], 'addMissingCases'> | 'exprSearch', string>> = {
  caseSplit: 'refactor.rewrite.CaseSplit',
  addClause: 'refactor.rewrite.AddClause',
  makeLemma: 'refactor.extract.MakeLemma',
  makeCase: 'refactor.rewrite.MakeCase',
  makeWith: 'refactor.rewrite.MakeWith',
  generateDef: 'refactor.rewrite.GenerateDef',
  intro: 'refactor.rewrite.Intro',
  exprSearch: 'refactor.rewrite.ExprSearch',
};

/**
 * The plan of an edit at a place over idris2-lsp, for `text`, the document's text as the server read
 * it, and `uri`, the document's URI as the request names it. Throws `Unsupported` for a request
 * refused before anything is sent: by IDE mode's plan (`planEdit`, every refusal of M4) and by the
 * server's own limits (module comment, *Positions*). The names must have passed `nameProblem`.
 */
export function planLspEdit(req: EditAtRequest | ExprSearchRequest | RefineRequest, text: EditText, uri: string): LspEditPlan {
  const title = TITLES[req.kind];
  refuse(numberingProblem(text, title));
  const ide = planEdit(req, text);
  const line = req.pos.line;
  const lineText = text.lines[line];
  const own = codeLineOf(text.style, lineText);
  const marker = markerOf(own);
  const codeAction = (only: string, at: EditorPosition): LspEditRequest => {
    const position = serverPosition(text, at, title);
    return { method: 'codeAction', params: { textDocument: { uri }, range: { start: position, end: position }, context: { diagnostics: [], only: [only], triggerKind: INVOKED } } };
  };
  switch (req.kind) {
    case 'caseSplit':
      return {
        request: codeAction(ONLY.caseSplit, req.pos),
        decode: (reply, isDocument) => {
          const action = theAction(reply, title, (a) => isKind(a, 'refactor.rewrite', ONLY.caseSplit) && a.title === `Case split on ?${req.name}`);
          const edit = theEdit(action, isDocument, title, (e) => sameRange(e.range, lineRange(text, line, 0)));
          return { result: ide.decode(textPayload(edit.newText)) };
        },
      };
    case 'addClause':
      return {
        request: codeAction(ONLY.addClause, req.pos),
        decode: (reply, isDocument) => {
          const action = theAction(reply, title, (a) => isKind(a, 'refactor.rewrite', ONLY.addClause) && a.title === 'Add clause');
          const edit = theEdit(action, isDocument, title, isLineInsertion);
          const answer = clausesOf(edit.newText, text, req.name, title);
          if (answer.includes('\n')) {
            throw notForHere(title);
          }
          return { result: ide.decode(textPayload(answer)) };
        },
      };
    case 'generateDef':
      return {
        request: codeAction(ONLY.generateDef, req.pos),
        decode: (reply, isDocument) => {
          const actions = numberedActions(actionsOf(reply, title), title);
          if (actions.length === 0) {
            throw unsupported(
              `${title}: idris2-lsp generated no definition and says no reason: the function may already have clauses, or the search may have found none ` +
                'within idris2.lsp.longActionTimeout (its log, Idris 2: Show Language Server Output, may say which).',
            );
          }
          const answers = actions.map((a) => clausesOf(theEdit(a, isDocument, title, isLineInsertion).newText, text, req.name, title));
          return { result: ide.decode(textPayload(answers[0])), more: answers.slice(1) };
        },
      };
    case 'makeLemma': {
      const hole = holeOf(ide, lineText, req);
      refuse(misreadProblem(text, line, title));
      return {
        request: codeAction(ONLY.makeLemma, { line, character: hole.start }),
        decode: (reply, isDocument) => {
          const action = theAction(reply, title, (a) => isKind(a, 'refactor.extract', ONLY.makeLemma) && holeTitled(a.title, 'Make lemma for hole ?', req.name));
          const edits = editsOf(action, isDocument, title);
          const declaration = edits.filter((e) => isLineInsertion(e) && e.newText.endsWith('\n\n'));
          const call = edits.filter((e) => sameRange(e.range, holeRange(text, line, hole, title)));
          if (edits.length !== 2 || declaration.length !== 1 || call.length !== 1) {
            throw notForHere(title);
          }
          const lemma = declaration[0].newText.slice(0, -2);
          // The server takes the lemma's marker from the raw line at the compiler's number (`relit`): on
          // a marked line every line of the lemma must carry that line's marker, as IDE mode's does.
          if (marker !== undefined && !lemma.split('\n').every((l) => l.startsWith(`${marker} `))) {
            throw notForHere(title);
          }
          return { result: ide.decode(lemmaPayload(call[0].newText, lemma)) };
        },
      };
    }
    case 'makeCase': {
      const hole = holeOf(ide, lineText, req);
      refuse(misreadProblem(text, line, title));
      return {
        request: codeAction(ONLY.makeCase, { line, character: hole.start }),
        decode: (reply, isDocument) => {
          const action = theAction(reply, title, (a) => isKind(a, 'refactor.rewrite', ONLY.makeCase) && a.title === `Make case for hole ?${req.name}`);
          const edit = theEdit(action, isDocument, title, (e) => sameRange(e.range, lineRange(text, line, 0)));
          if (marker !== undefined && !edit.newText.endsWith('\n')) {
            throw notForHere(title);
          }
          return { result: ide.decode(textPayload(marker === undefined ? edit.newText : edit.newText.slice(0, -1))) };
        },
      };
    }
    case 'makeWith': {
      const hole = holeOf(ide, lineText, req);
      refuse(misreadProblem(text, line, title));
      if (withClauseStart((l) => codeLineOf(text.style, text.lines[l] ?? ''), line, hole) !== line) {
        throw unsupported(
          `${title}: idris2-lsp rewrites the hole's own line, and this hole is on a line of its own below the clause's =, where its answer would be wrong. ` +
            'Put the hole on the line of the =, or use IDE mode (Idris 2: Switch Backend…).',
        );
      }
      return {
        request: codeAction(ONLY.makeWith, { line, character: hole.start }),
        decode: (reply, isDocument) => {
          const action = theAction(reply, title, (a) => isKind(a, 'refactor.rewrite', ONLY.makeWith) && holeTitled(a.title, 'Make with for hole ?', req.name));
          // The server's range ends one character short of the line (`length src - 1`, `CodeAction/MakeWith.idr`).
          const edit = theEdit(action, isDocument, title, (e) => sameRange(e.range, lineRange(text, line, 1)));
          const answer = marker === undefined ? edit.newText : edit.newText.split('\n').map((l) => `${marker} ${l}`).join('\n');
          return { result: ide.decode(textPayload(answer)) };
        },
      };
    }
    case 'exprSearch': {
      const hole = holeOf(ide, lineText, req);
      const at: EditorPosition = { line, character: hole.start };
      const request: LspEditRequest =
        req.hints.length === 0
          ? codeAction(ONLY.exprSearch, at)
          : {
              method: 'exprSearchWithHints',
              args: [{ codeAction: { textDocument: { uri }, range: { start: serverPosition(text, at, title), end: serverPosition(text, at, title) }, context: { diagnostics: [] } }, hints: req.hints }],
            };
      return {
        request,
        decode: (reply, isDocument) => {
          const actions = actionsOf(reply, title).filter((a) => isKind(a, 'refactor.rewrite', ONLY.exprSearch) && searchTitled(a.title, req.name));
          if (actions.length === 0) {
            throw unsupported(
              `${title}: idris2-lsp found no expression for this hole within idris2.lsp.longActionTimeout, and says no more (its log, Idris 2: Show Language Server Output, may).`,
            );
          }
          const range = holeRange(text, line, hole, title);
          const answers = actions.map((a) => theEdit(a, isDocument, title, (e) => sameRange(e.range, range)).newText);
          return { result: ide.decode(textPayload(answers[0])), more: answers.slice(1) };
        },
      };
    }
    case 'intro': {
      const hole = holeOf(ide, lineText, req);
      return {
        request: codeAction(ONLY.intro, { line, character: hole.start }),
        decode: (reply, isDocument) => {
          const actions = actionsOf(reply, title).filter((a) => isKind(a, 'refactor.rewrite', ONLY.intro) && a.title.startsWith('Intro ') && a.title.endsWith(` over hole ${req.name}`));
          if (actions.length === 0) {
            throw unsupported(`${title}: idris2-lsp offered no candidate for this hole and says no reason (its log, Idris 2: Show Language Server Output, may).`);
          }
          const range = holeRange(text, line, hole, title);
          const candidates = actions.map((a) => theEdit(a, isDocument, title, (e) => sameRange(e.range, range)).newText);
          return { result: ide.decode(listPayload(candidates)) };
        },
      };
    }
    case 'refine': {
      const hole = holeOf(ide, lineText, req);
      const position = serverPosition(text, { line, character: hole.start }, title);
      return {
        request: { method: 'refineHole', args: [{ codeAction: { textDocument: { uri }, range: { start: position, end: position }, context: { diagnostics: [] } }, hint: req.hint }] },
        decode: (reply, isDocument) => {
          const actions = actionsOf(reply, title).filter((a) => isKind(a, 'refactor.rewrite', 'refactor.rewrite.RefineHole') && a.title === `Refine hole on ${req.name}`);
          if (actions.length === 0) {
            throw unsupported(
              `${title}: idris2-lsp gave no refinement and reports no reason: the expression may be ambiguous (IDE mode then offers the alternatives), ` +
                "not fit the hole's type, or not parse. Its log (Idris 2: Show Language Server Output) has the compiler's error.",
            );
          }
          if (actions.length > 1) {
            throw notForHere(title);
          }
          const edit = theEdit(actions[0], isDocument, title, (e) => sameRange(e.range, holeRange(text, line, hole, title)));
          return { result: ide.decode(textPayload(edit.newText)) };
        },
      };
    }
    case 'addMissingCases': {
      const at = serverPosition(text, req.pos, title);
      return {
        request: { method: 'codeAction', params: { textDocument: { uri }, range: { start: at, end: at }, context: { diagnostics: [], only: ['quickfix'], triggerKind: INVOKED } } },
        decode: (reply, isDocument) => {
          const fixes = actionsOf(reply, title).filter(
            (a) => a.kind === 'quickfix' && a.title === 'QuickFix: Add missing cases' && (a.diagnostics ?? []).some((d) => isObject(d) && isRange(d.range) && d.range.start.line <= at.line && at.line <= d.range.end.line),
          );
          if (fixes.length === 0) {
            throw unsupported(
              `${title}: idris2-lsp offers missing cases only as the quick fix of a coverage error (… is not covering) on this declaration, and has none here ` +
                '(a partial function has none; IDE mode completes it too).',
            );
          }
          if (fixes.length > 1) {
            throw notForHere(title);
          }
          const edit = theEdit(fixes[0], isDocument, title, isLineInsertion);
          return { result: ide.decode(textPayload(`${reportName(text, line, req.name)}:\n${missingClauses(edit.newText, title).join('\n')}`)) };
        },
      };
    }
  }
}

/**
 * The next result of a search over idris2-lsp (`NextRequest`): `answer`, the next of the server's
 * results kept from the first request (`LspAnswer.more`), put in place of `previous` by IDE mode's
 * plan (`planNext`: a proof search result bracketed by M4's rule, a definition with the previous one's
 * tabs). The caller has checked the search and the version.
 */
export function nextResult(kind: NextRequest['kind'], text: EditText, previous: EditorRange, answer: string): EditResult {
  return planNext(kind, text, previous).decode(textPayload(answer));
}

// -------------------------------------------------------------------------------------------
// Refusals and checks
// -------------------------------------------------------------------------------------------

function refuse(problem: string | undefined): void {
  if (problem !== undefined) {
    throw unsupported(problem);
  }
}

/** The refusal of every kind in a text whose lines the compiler numbers otherwise than the editor (module comment, *Positions*). */
function numberingProblem(text: EditText, title: string): string | undefined {
  if (text.carriageReturns === 'lone') {
    return `${title} is not available over idris2-lsp in a file with a carriage return that ends no line (a \\r without \\n): the compiler numbers its lines otherwise than the editor. Convert the line breaks to LF.`;
  }
  return text.style !== undefined && text.carriageReturns === 'crlf'
    ? `${title} is not available over idris2-lsp in a literate file with CRLF line breaks: the compiler numbers its lines otherwise than the editor. Convert the line breaks to LF.`
    : undefined;
}

/**
 * The refusal of Make Lemma, Make Case and Make With below a bird-track line of a marker and white
 * space only (module comment, *Positions*), or `undefined`.
 */
function misreadProblem(text: EditText, line: number, title: string): string | undefined {
  const doubled = doubledLinesAbove(text, line);
  return doubled.length === 0
    ? undefined
    : `${title} is not available over idris2-lsp below ${doubledLinesText(doubled)} a literate marker followed only by spaces: the compiler counts such a line twice, ` +
        'and idris2-lsp would read the line below this one. Delete the spaces after the marker, or use IDE mode (Idris 2: Switch Backend…).';
}

/** The hole token at the cursor, as IDE mode's plan found it (`planEdit` refused the request otherwise). */
function holeOf(ide: EditPlan, lineText: string, req: EditAtRequest | ExprSearchRequest | RefineRequest): TokenColumns {
  const hole = ide.hole ?? holeTokenAt(lineText, req.pos.character, req.name);
  if (hole === undefined) {
    throw unsupported(`${TITLES[req.kind]} needs the cursor on the hole ?${req.name}.`);
  }
  return hole;
}

const notForHere = (title: string): IdrisException =>
  unsupported(`${title}: idris2-lsp's answer is not for the place asked (it may have read another text of the file: save it and run ${title} again); nothing was applied.`);

const protocolError = (title: string, what: string): IdrisException =>
  new IdrisException({ kind: 'ProtocolError', message: `${title}: idris2-lsp answered ${what}, which this extension does not read.` });

// -------------------------------------------------------------------------------------------
// Positions (module comment, *Positions*)
// -------------------------------------------------------------------------------------------

/** A position or range as the server takes and sends it. */
interface ServerPosition {
  readonly line: number;
  readonly character: number;
}

interface ServerRange {
  readonly start: ServerPosition;
  readonly end: ServerPosition;
}

/** The compiler's 0-based line of file line `line`: the line plus the doubled bird-track lines above it (F11 addendum). */
function serverLine(text: EditText, line: number): number {
  return line + doubledLinesAbove(text, line).length;
}

/** The server's position of `pos`: the compiler's line and column (code points of the unlit text, E14). */
function serverPosition(text: EditText, pos: EditorPosition, title: string): ServerPosition {
  const column = toCompilerColumn(text, pos);
  if (column === undefined) {
    throw unsupported(`${title} needs the cursor in Idris code, not on a line of prose.`);
  }
  return { line: serverLine(text, pos.line), character: column };
}

/** The server's range of the hole token at `hole` of line `line`. */
function holeRange(text: EditText, line: number, hole: TokenColumns, title: string): ServerRange {
  return { start: serverPosition(text, { line, character: hole.start }, title), end: serverPosition(text, { line, character: hole.end }, title) };
}

/** The server's range of a whole-line edit of line `line`: from column 0 to the raw line's length in code points, less `less`. */
function lineRange(text: EditText, line: number, less: number): ServerRange {
  const at = serverLine(text, line);
  return { start: { line: at, character: 0 }, end: { line: at, character: [...text.lines[line]].length - less } };
}

const sameRange = (a: Range, b: ServerRange): boolean =>
  a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line && a.end.character === b.end.character;

/** An insertion of whole lines: an empty range at a line's start, text ending with a line break. */
const isLineInsertion = (e: TextEdit): boolean => sameRange(e.range, { start: e.range.start, end: e.range.start }) && e.range.start.character === 0 && e.newText.endsWith('\n');

// -------------------------------------------------------------------------------------------
// The server's answer
// -------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isPosition = (v: unknown): boolean => isObject(v) && Number.isInteger(v.line) && Number.isInteger(v.character);
const isRange = (v: unknown): v is Range => isObject(v) && isPosition(v.start) && isPosition(v.end);

/**
 * The code actions of a `textDocument/codeAction` or `executeCommand` answer: `null` is the server's
 * answer for a document with unsaved changes (`isDirty`, `Server/ProcessMessage.idr` 426–430 [src];
 * [live, `dirty`]); `Command`s (whose `command` is a string) are left out.
 */
function actionsOf(reply: unknown, title: string): readonly CodeAction[] {
  if (reply === null) {
    throw new IdrisException({
      kind: 'DirtyDocument',
      message: `${title}: idris2-lsp has unsaved changes of this file and answers nothing for them (it has not seen its save yet). Save the file and run ${title} again.`,
    });
  }
  if (!Array.isArray(reply)) {
    throw protocolError(title, 'something other than a list of code actions');
  }
  return reply.filter((a): a is CodeAction => isObject(a) && typeof a.title === 'string' && typeof a.command !== 'string');
}

/** The one action of `reply` that `matches`; throws `Unsupported` when there is none or more than one. */
function theAction(reply: unknown, title: string, matches: (a: CodeAction) => boolean): CodeAction {
  const found = actionsOf(reply, title).filter(matches);
  if (found.length === 0) {
    throw unsupported(`${title}: idris2-lsp offered no ${title} here and says no reason (its log, Idris 2: Show Language Server Output, may).`);
  }
  if (found.length > 1) {
    throw notForHere(title);
  }
  return found[0];
}

/** Whether `a` has the generic kind the server gives every action (F34), or the specific `key`. */
const isKind = (a: CodeAction, generic: string, key: string): boolean => a.kind === generic || a.kind === key;

/** Whether `actionTitle` is `prefix` and a hole's name whose last part is `name` (`Make lemma for hole ?Clean.vlen_rhs`). */
const holeTitled = (actionTitle: string, prefix: string, name: string): boolean => actionTitle.startsWith(prefix) && holeName(actionTitle.slice(prefix.length)) === name;

/** Whether `actionTitle` is an expression search's on the hole `name` (`Expression search on vlen_rhs as ~ 0 ...`). */
const searchTitled = (actionTitle: string, name: string): boolean => actionTitle.startsWith(`Expression search on ${name} as ~ `);

/**
 * The text edits of `action`: of the request's document only (`isDocument`), else `Unsupported` (an
 * edit never changes another document, M4). `documentChanges`, which the server never writes, is not
 * read.
 */
function editsOf(action: CodeAction, isDocument: (uri: string) => boolean, title: string): readonly TextEdit[] {
  const changes = action.edit?.changes;
  if (!isObject(changes) || action.edit?.documentChanges !== undefined) {
    throw protocolError(title, 'an action without text changes');
  }
  const uris = Object.keys(changes);
  if (uris.length !== 1 || !isDocument(uris[0])) {
    throw unsupported(`${title}: idris2-lsp's answer changes another file than this one; nothing was applied.`);
  }
  const edits: unknown = changes[uris[0]];
  if (!Array.isArray(edits) || !edits.every((e) => isObject(e) && isRange(e.range) && typeof e.newText === 'string')) {
    throw protocolError(title, 'text changes of another shape');
  }
  return edits as TextEdit[];
}

/** The one edit of `action`, which must satisfy `where`; else `Unsupported` (`notForHere`). */
function theEdit(action: CodeAction, isDocument: (uri: string) => boolean, title: string, where: (e: TextEdit) => boolean): TextEdit {
  const edits = editsOf(action, isDocument, title);
  if (edits.length !== 1 || !where(edits[0])) {
    throw notForHere(title);
  }
  return edits[0];
}

/**
 * The actions `Generate definition #<i> …`, i = 1, 2, … in that order; throws when they are numbered
 * otherwise (the numbering is the server's order of the results, `number 1 solutions`).
 */
function numberedActions(actions: readonly CodeAction[], title: string): readonly CodeAction[] {
  const numbered = actions.filter((a) => isKind(a, 'refactor.rewrite', ONLY.generateDef) && /^Generate definition #[0-9]+ as ~ /u.test(a.title));
  if (!numbered.every((a, i) => a.title.startsWith(`Generate definition #${i + 1} as ~ `))) {
    throw notForHere(title);
  }
  return numbered;
}

/**
 * The clauses an insertion of Add Clause or Generate Definition holds, without the line break after
 * the last (module comment), the first a clause of `name` (`clauseName`), else `notForHere`: the
 * server found the declaration on the request's line (`findTyDeclAt (onLine line)`), as IDE mode's
 * plan did, and this checks that it was `name`'s.
 */
function clausesOf(newText: string, text: EditText, name: string, title: string): string {
  const answer = newText.slice(0, -1);
  const first = codeLineOf(text.style, answer.split('\n')[0])?.code.trimStart();
  if (first === undefined || clauseName(first) !== name) {
    throw notForHere(title);
  }
  return answer;
}

/**
 * The clauses of the quick fix's text `newText`: one `<clause> = ?<f>_missing_case_<k>` line each,
 * k = 1, 2, … in order (`addMissingCases`, `Server/QuickFix.idr` 41–46 [src]), else `notForHere`.
 */
function missingClauses(newText: string, title: string): readonly string[] {
  const lines = newText.slice(0, -1).split('\n');
  return lines.map((l, k) => {
    const suffix = `_missing_case_${k + 1}`;
    const at = l.lastIndexOf(' = ?');
    if (at <= 0 || !l.endsWith(suffix) || /\s/u.test(l.slice(at + 4))) {
      throw notForHere(title);
    }
    return l.slice(0, at);
  });
}

/**
 * The name `:missing` reports the function `name` declared at line `line` under, which IDE mode's
 * plan looks its report up by (`backend/ide/edits.ts` `qualifiedName`, read the same way): the
 * module's name (the first code line that is not a doc comment, when it is `module M`; `Main`
 * without one), the names of the `namespace` blocks around the line, outermost first, then `name`. A
 * block is the nearest code line above whose first token is left of the lines below it
 * (`firstTokenColumn`); lines inside a block comment or string are skipped. Should the two readings
 * ever differ, IDE mode's plan finds no report of the name and refuses: nothing wrong is applied.
 */
function reportName(text: EditText, line: number, name: string): string {
  const entry = (at: number): { readonly column: number; readonly code: string } | undefined => {
    const cl = codeLineOf(text.style, text.lines[at] ?? '');
    const column = cl === undefined || text.continued.has(at) ? undefined : firstTokenColumn(cl.code, NOTHING_OPEN);
    return cl !== undefined && typeof column === 'number' ? { column, code: cl.code.trimStart() } : undefined;
  };
  let module = 'Main';
  for (let at = 0; at < text.lines.length; at++) {
    const e = entry(at);
    if (e !== undefined && levelTokens(e.code).length > 0 && !e.code.startsWith('|||')) {
      const [keyword, moduleName] = levelTokens(e.code);
      if (keyword.kind === 'keyword' && keyword.text === 'module' && moduleName?.kind === 'name') {
        module = moduleName.text;
      }
      break;
    }
  }
  const namespaces: string[] = [];
  let column = entry(line)?.column ?? Infinity;
  for (let at = line - 1; at >= 0 && column > 0; at--) {
    const e = entry(at);
    if (e === undefined || e.column >= column || levelTokens(e.code).length === 0) {
      continue;
    }
    column = e.column;
    const [keyword, nsName] = levelTokens(e.code).filter((t) => t.kind !== 'keyword' || !MODIFIER_KEYWORDS.has(t.text));
    if (keyword?.kind === 'keyword' && keyword.text === 'namespace' && nsName?.kind === 'name') {
      namespaces.unshift(nsName.text);
    }
  }
  return [module, ...namespaces, name].join('.');
}

// -------------------------------------------------------------------------------------------
// IDE mode's replies of the same answers (module comment)
// -------------------------------------------------------------------------------------------

/** `(:ok "TEXT")`. */
const textPayload = (text: string): ReplyPayload => ({ kind: 'ok', result: { kind: 'string', value: text }, highlighting: [] });

/** `(:ok ("CANDIDATE" …))`, Intro's. */
const listPayload = (texts: readonly string[]): ReplyPayload => ({
  kind: 'ok',
  result: { kind: 'list', items: texts.map((value) => ({ kind: 'string', value })) },
  highlighting: [],
});

/** `(:ok (:metavariable-lemma (:replace-metavariable "APP") (:definition-type "LEMMA")))`. */
const lemmaPayload = (application: string, lemma: string): ReplyPayload => ({
  kind: 'ok',
  result: {
    kind: 'list',
    items: [
      { kind: 'symbol', name: 'metavariable-lemma' },
      { kind: 'list', items: [{ kind: 'symbol', name: 'replace-metavariable' }, { kind: 'string', value: application }] },
      { kind: 'list', items: [{ kind: 'symbol', name: 'definition-type' }, { kind: 'string', value: lemma }] },
    ],
  },
  highlighting: [],
});
