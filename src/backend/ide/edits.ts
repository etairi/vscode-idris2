/**
 * The interactive edits of IDE mode (`backend/ide/edits.ts`, ROADMAP §5 M4, ARCHITECTURE §3.3,
 * §10): for each `EditKind`, the request, the refusals made before anything is sent, and where the
 * reply goes in the document (ROADMAP E15). Pure: `backend.ts` checks that the document shows the
 * text the compiler loaded, sends the request and hands the reply to `EditPlan.decode`. What the
 * compiler answers was recorded from idris2 0.8.0 (transcripts `clean-editing`, `edits-shapes`,
 * `edits-searches`, `edits-names`, `lit2-editing`, `hole-errors`, `part-editing`,
 * `holes-ipkg-main`) unless it says `[src]` (references are to v0.8.0); where the answers go, and
 * what is refused, is this module's choice, built on it and pinned by `test/unit/edits.test.ts`.
 *
 * **Names.** A name taken from the document is untrusted: a hole's name must be `isHoleName`, a
 * pattern variable's `isIdentifierName`, a function's that or `isOperatorInParentheses`, and a
 * proof-search hint one of those two (`protocol.ts`); anything else is refused before anything is
 * classified or sent. Make Lemma also refuses a keyword (`?proof`): the compiler names the lemma
 * after the hole, and `proof : …` does not parse [live, M4 edit review]. Only `:missing` parses its
 * name (`protocol.ts` `missingCases`); the other commands take theirs as a string. Refine Hole's
 * expression goes only into its string slot; the compiler reads it only as far as it parses, so one
 * that closes a bracket it did not open is refused (`closesUnopened`).
 *
 * **Where the replies go** (E15). Ranges are editor coordinates of the text the load read, which
 * the document shows (`backend.ts`); a reply's lines are joined with `\n`. A line's indentation is
 * read as the layout reads it, from its first token's column, past white space and block comments
 * (`entryAt`; a line inside a block comment or string opened above has none of its own); "more
 * indented" below means a first token further right.
 * - `:case-split L C x` finds the clause by position but answers line L alone, rewritten, or
 *   `impossible` clauses (`updateCase`, `IDEMode/CaseSplit.idr` 319–363 [src]; their marker and
 *   indentation repaired by `splitLines`): it replaces line L, and is asked only
 *   when line L holds a hole — the clause's right-hand side, which must be a hole for the compiler
 *   to split (`TTImp/ProcessDef.idr` 516–521 [src]). A clause continued on the next line (`count xs
 *   =` / `?count_rhs`) would lose its hole, and one whose left-hand side is split over lines is
 *   rewritten on one of them only (`     n` twice on `step`'s second line; `  0 = ?above_rhs_0` for
 *   `above x` / `  y = ?above_rhs` [live, `edits-layout`]). The editing commands refuse a
 *   left-hand side that starts above the variable's line before they ask (`features/editing`). A
 *   line holding a `;` is refused: on `g m = case m of Just y => ?h ; Nothing => 0` the answer
 *   repeats the whole line per constructor [live, M4 edit review]. So is a line with more indented
 *   lines after it (`entryEnd`, and a first token below right of the clause's, `nextTokenColumn`,
 *   which a comment may come before): a `where` block below would belong to the last new clause only
 *   (`Undefined name x` in its `z = x` [live, M4 edit review]). So are the lines whose answer the
 *   compiler reshapes as for a one-line `case` or garbles otherwise: the word `of` in a comment or
 *   string, a hole in parentheses, a string holding a name of the clause, a braced named argument
 *   matched with a variable of its own name (`caseLineProblem`).
 * - `:add-clause L f` and `:generate-def L f` answer for any line of the type declaration and
 *   ignore `f` except in messages — on a declaration of several names they answer for the last
 *   (`severalNames`, refused); their clauses are inserted after the declaration's last line
 *   (idris2-lsp's `AddClause.idr` and `GenerateDef.idr` convention, `endLine loc + 1` [src]), the
 *   declaration being the nearest line at or above the cursor that declares `f`, modifiers and
 *   function-option pragmas before the name included (`signatureNames`), and the more indented
 *   lines after it (over blank lines, as the compiler's layout; `entryEnd`). Add Clause's clause,
 *   which binds a variable for every explicit argument (`getClause` [src]), goes after the
 *   function's clauses instead when it has some (`clausesEnd`; above them it would make them
 *   unreachable, `Unreachable clause: f 0` [live, M4 edit review]), after a literate marker with the
 *   declaration's indentation (`addedClause`). `:add-clause` names the hole `<f>_rhs` even when that
 *   hole exists (a duplicate the next load reports). An answer that binds a variable named like the
 *   function is not applied (`shadowProblem`).
 * - `:make-lemma L h` looks the hole up by name; `L` only picks the literate marker of the lemma's
 *   type. The application replaces the `?h` token, in parentheses when it is more than one token
 *   (`inPlace`; the compiler brackets it itself only for a prefix argument, `(under_rhs n)`); the
 *   type, which the compiler writes unindented, is inserted with a
 *   blank line after it above the declaration that holds the hole (`lemmaPlace`): the top-level one,
 *   or in a `namespace` or `mutual` block the one in that block, indented as it; refused in an
 *   `interface` and when the hole's name is a name of the code from that place to the end of the
 *   entry (a local would take the call, `namesIn`), and not applied when the application passes a
 *   name the compiler made (`passesUnnamed`) or one name twice (a shadowed local), or when the type
 *   holds a `_` (a value bound by `_` that other locals' types use: `Unsolved holes` [live]). The
 *   compiler's REPL and idris2-lsp put it at the nearest blank line above the hole instead
 *   (`addMadeLemma`, `Idris/REPL.idr` 289–305; `MakeLemma.idr` [src]), which lands inside a `where`
 *   block or between two clauses of a function when a blank line is there.
 * - `:make-case L h` rewrites line L: its first text `?h` becomes `case _ of`, and `case_val => ?h`,
 *   then the rest of the line, follows on a new line; the compiler brackets the two (`(case _ of` …
 *   `?h)`) for a prefix argument only (`madeCase`). Unbracketed, the case would take in the rest of
 *   the line and the lines below it indented past `case_val`, so the bracketed form is always applied:
 *   the unbracketed answer is rewritten into it, and any other answer is refused. That form moves
 *   the rest of the line 19 columns to the right (`layoutProblem`). `:make-with L h`
 *   answers `<LHS>with (_)` / `  <LHS>| with_pat = ?<h>_rhs`, `LHS` being line L up to its first `=`
 *   outside `(…)` and `{…}` (`makeWith`, `Idris/IDEMode/MakeClause.idr` [src]; a space is put before
 *   `with` and `|` when `LHS` ends without one, `spacedWith`). Both are text functions of line L that
 *   do not check that `h` is a hole there: make-case is asked only when the first `?h` of the hole's
 *   line is the hole, and replaces that line; make-with only when the clause's right-hand side is the
 *   hole alone and its `=` is the first such `=` of its line (the hole's line, or the line before when
 *   the hole starts its line), and replaces the clause's lines, a comment after the hole put back at
 *   the end of the first line (the answer drops it). Elsewhere its answer is garbage (`  ?count_rhswith
 *   (_)`, `step mwith (_)`, and a case alternative's `=>` is cut at its `=`). Make With is refused
 *   when the code already has a hole `?<h>_rhs`, the name of its new hole (`MW.h_rhs is already
 *   defined` [live, M4 edit review]), and when the left-hand side it copies holds a NUL.
 * - `:intro`, `:refine` and `:proof-search` (and its `-next`) answer expressions that replace the
 *   `?h` token; their line is used only by the REPL's file-updating variants [src]. An Intro
 *   candidate that is a lambda over a qualified name is dropped (`bindsQualifiedName`). Refine's
 *   ambiguity alternatives (F29) are offered only when the expression is one name (`isOneName`) and
 *   each alternative is that name, qualified, followed by its arguments (`isNameApplied`: not the infix
 *   form printed for a binary operator with a fixity), and applied as printed, qualified: refined with a
 *   qualified name the compiler drops the qualification (`A.foo` → `foo ?g_rhs_0`; `A.(+++)` →
 *   `?g_rhs_0 +++ ?g_rhs_1` [live, M4's convergence pass]; ambiguous again). An answer of more than one token is put in parentheses,
 *   wherever the hole is, and so is a token that would join the text next to it: a name before the
 *   hole, a `.` after it, a string literal next to a `"` (`inPlace`); after a backtick, a space goes
 *   before a bracket. The compiler brackets its answers for a prefix argument only, not for an operand
 *   of an infix operator. At the head of an idiom bracket on the hole's line only a name, a hole or a
 *   lambda is put (`idiomHeadProblem`). These, Make Lemma and Make Case are refused when the rest of
 *   the hole's line starts an entry of a layout block, or the hole is in a `parameters`, `using` or
 *   `with` header (read from the nearest line above whose first token is left of the hole line's, `entryStart`), and
 *   the first token below is right of the hole (`layoutProblem`).
 * - `:generate-def-next` and `:proof-search-next` replace the previous result (a proof search's with
 *   the parentheses added to it).
 * - `:missing f` (Add Missing Cases) answers each missing clause's left-hand side, one per line;
 *   they become `<clause> = ?<f>_missing_case_<k>` (k from 1; `op` for an operator, as `makeWith`
 *   names holes) lines, indented as the declaration, inserted after the function's clauses — the
 *   one run of entries of the declaration's layout block that are its clauses, with their more
 *   indented lines, right after the declaration or elsewhere in the block (`clausesEnd`; two runs
 *   are refused) — else after the declaration; a line that opens a block comment or a string that
 *   goes on below (a `"""` one, or one whose interpolation does) takes the lines up to its end
 *   along (`EditText.continued`); one still open at the end of the file (the lexer lets EOF end a
 *   block comment [src]) would take the new lines in, so Add Missing
 *   Cases, Add Clause and Generate Definition are refused there (`openAtEndProblem`). idris2-lsp
 *   inserts at the first blank line after the declaration (`QuickFix.idr` 98–108 [src]), which is
 *   inside the definition when a blank line is. The answer reports every function of the name in scope; only the report of the
 *   declaration's module and namespace is applied (`qualifiedName`), and a function local to a
 *   definition, which `:missing` does not find, is refused (`isLocal`).
 *
 * **Lines the compiler numbers otherwise.** `:case-split`, `:add-clause` and `:generate-def` find
 * their place at a line of the compiler's lexer, but read a source line by that number from the raw
 * text (`updateCase` from the file on disk, `getClause` and `GenerateDef` with `getSourceLine`,
 * `Idris/REPL/Opts.idr` 129–133 [src]). Below a bird-track line of a marker and white space only
 * (F11 addendum) the two differ: `:case-split` then rewrites the wrong line (`">\n>"`) and is refused;
 * `:add-clause` and `:generate-def` read that line only for its marker and are refused only when the
 * line they read has another marker or none. Also refused: those three in a literate file with a
 * `\r` (the unlit step drops CRLF breaks, F11) and in any file with a lone `\r` (the lexer does not
 * break a line there, the editor and `lines` do). `:make-lemma`, `:make-case` and `:make-with` find
 * the hole by name and read only the source line, so they are sent the line's number in the raw text
 * (`core/positions.ts` `toIdeSourceLineRequest`) and work below such lines too: at the file line of
 * `half`'s clause below the `> ` line of `Lit2.lidr` they answered as above it.
 *
 * **Literate markers.** The compiler's literate style is unset in IDE mode — `process (Load f)` sets
 * `mainfile` only, not `literateStyle` (`Idris/REPL.idr` 960–963 [src]) — so `:make-case` and
 * `:make-with` rewrite the raw line with its marker, and IDE mode then puts the marker of `isLitLine`,
 * followed by a space, before each of their lines again (`IDEMode/REPL.idr` 387–392 [src]); make-with
 * adds one more in its indentation (`pref`): `> > vlen xs = case _ of`, `> > > vlen xs with (_)`.
 * Make Case and `literateRepair` (make-with) remove what was added and put the marker where the raw
 * rewrite has none. The
 * answers of `:add-clause`, `:generate-def` and make-lemma's type carry one marker, as the file
 * needs, except that `:add-clause` indents an indented declaration's clause one column too little
 * (`addedClause`); `:case-split` keeps the marker only on the lines that rewrite line L
 * (`splitLines` puts it back on the others); `:missing` carries none (the clauses get the
 * declaration's).
 *
 * **Tabs.** The compiler counts a tab as one column and writes a space for it in the answers of
 * `:add-clause`, `:generate-def` and its `-next`, `:make-with` and `:make-case`; `retabbed` puts the
 * line's tabs back (`splitLines` for `:case-split`).
 */
import { unsupported } from '../../core/errors';
import { displayLine, toIdeCaseSplitRequest, toIdeLineRequest, toIdeSourceLineRequest, type EditorPosition, type EditorRange, type PositionDocument } from '../../core/positions';
import {
  caseSplitLineProblem,
  clauseName,
  closesUnopened,
  codeLineOf,
  doubledLinesText,
  firstTokenColumn,
  GROUP_SYMBOLS,
  holdsBlockHeader,
  isIdentTrailing,
  isKeyword,
  isOneToken,
  isOpen,
  isOptionLine,
  levelTokens,
  markerOf,
  misreadBelow,
  MODIFIER_KEYWORDS,
  namesAsPattern,
  NOTHING_OPEN,
  openAfter,
  OPERATOR_CHARACTERS,
  opensBlockOnLine,
  shadowsItsName,
  signatureNames,
  withClauseStart,
  withoutLineComment,
  type CodeLine,
  type OpenBlock,
} from '../../core/idrisSyntax';
import { compilerLiterateStyleOf, isIdrisSpace, type LiterateStyle } from '../../project/literate';
import type { EditAtRequest, EditChoice, EditResult, ExprSearchRequest, Hole, RefineRequest, TextReplacement } from '../types';
import {
  addClause,
  caseSplit,
  decodeAmbiguity,
  decodeIntro,
  decodeLemma,
  decodeMissingCases,
  decodeText,
  generateDef,
  generateDefNext,
  intro,
  isHoleName,
  isIdentifierName,
  isOperatorInParentheses,
  makeCase,
  makeLemma,
  makeWith,
  missingCases,
  proofSearch,
  proofSearchNext,
  refine,
  type MissingCases,
} from './protocol';
import type { ReplyPayload, Sexp } from './types';

// -------------------------------------------------------------------------------------------
// The document's text
// -------------------------------------------------------------------------------------------

/**
 * The document's text as the edit is planned for it: its lines as the editor has them (the text
 * the compiler loaded, `backend.ts` checks), the compiler's literate style, and the carriage returns
 * of the text the compiler read (which the editor's lines do not show).
 */
export interface EditText extends PositionDocument {
  readonly lines: readonly string[];
  readonly style: LiterateStyle | undefined;
  /** `lone`: a `\r` not followed by `\n`; `crlf`: only `\r\n`; `none`. */
  readonly carriageReturns: 'none' | 'crlf' | 'lone';
  /**
   * The lines that start inside a block comment or a string (`openAfter`), each with the line
   * that opened it: no entry of its own (`entryAt`), but part of an entry that line belongs to
   * (`entryEnd`).
   */
  readonly continued: ReadonlyMap<number, number>;
  /**
   * The line that opened a block comment or string still open at the end of the text (the
   * compiler's lexer accepts a block comment that EOF ends, `Parser/Lexer/Common.idr` [src]), or
   * `undefined`: no line after it is code.
   */
  readonly openAtEnd: number | undefined;
}

/** `EditText` of `doc`'s lines; `loadedText` is the text the compiler read. */
export function editText(
  doc: Pick<PositionDocument, 'fileName' | 'languageId' | 'isUntitled' | 'lineCount' | 'lineAt'>,
  loadedText: string,
): EditText {
  const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
  const style = compilerLiterateStyleOf(doc);
  const continued = new Map<number, number>();
  let open: OpenBlock = NOTHING_OPEN;
  let opener = 0;
  lines.forEach((lineText, line) => {
    const cl = codeLineOf(style, lineText);
    if (cl !== undefined) {
      const isContinued = isOpen(open);
      if (isContinued) {
        continued.set(line, opener);
      }
      open = openAfter(cl.code, open);
      if (!isContinued) {
        opener = line;
      }
    }
  });
  return {
    fileName: doc.fileName,
    languageId: doc.languageId,
    isUntitled: doc.isUntitled,
    lines,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
    style,
    carriageReturns: /\r(?!\n)/.test(loadedText) ? 'lone' : loadedText.includes('\r') ? 'crlf' : 'none',
    continued,
    openAtEnd: isOpen(open) ? opener : undefined,
  };
}

/** The code of `line`, or `undefined` for a line that is not code (bird-track prose) or not in the text. */
function codeLine(text: EditText, line: number): CodeLine | undefined {
  const lineText = text.lines[line];
  return lineText === undefined ? undefined : codeLineOf(text.style, lineText);
}

/** The length of a line's leading spaces and tabs (the text the compiler copies, `indentationOf`). */
function indentOf(code: string): number {
  return /^[ \t]*/.exec(code)?.[0].length ?? 0;
}

/**
 * The UTF-16 offset of the first token of the code line `code`, which starts inside nothing, as the
 * compiler's layout reads it (`firstTokenColumn`: past white space, U+00A0, `\f` and `\v` included,
 * and block comments); on a line that holds no token (blank, or comments only), of its first
 * character that is not white space (`isIdrisSpace`).
 */
function firstTokenOffset(code: string): number {
  const column = firstTokenColumn(code, NOTHING_OPEN);
  let at = 0;
  if (typeof column === 'number') {
    for (let k = 0; k < column; k++) {
      at += (code.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
    }
    return at;
  }
  while (at < code.length && isIdrisSpace(code[at])) {
    at++;
  }
  return at;
}

const isBlank = (code: string): boolean => code.trim() === '';

/** A range of whole lines, `first` to `last` included, their line breaks excluded. */
function linesRange(text: EditText, first: number, last: number): EditorRange {
  return { start: { line: first, character: 0 }, end: { line: last, character: text.lines[last].length } };
}

/** An insertion of whole lines after line `line` (at the end of the text when it is the last). */
function insertAfter(text: EditText, line: number, lines: readonly string[]): TextReplacement {
  if (line + 1 < text.lines.length) {
    const at: EditorPosition = { line: line + 1, character: 0 };
    return { range: { start: at, end: at }, text: `${lines.join('\n')}\n` };
  }
  const at: EditorPosition = { line, character: text.lines[line].length };
  return { range: { start: at, end: at }, text: `\n${lines.join('\n')}` };
}

/**
 * The refusal of an insertion after line `line` (`insertAfter`) that would land in a block comment
 * or string the text ends in (`EditText.openAtEnd`), or `undefined`.
 */
function openAtEndProblem(text: EditText, line: number, title: string): string | undefined {
  return text.openAtEnd !== undefined && line >= text.openAtEnd
    ? `${title}: the file ends inside a block comment or string that starts on line ${displayLine(text.openAtEnd)}, and the new text would go into it. Close it first.`
    : undefined;
}

/** The text of `range` in `text`, its lines joined with `\n`. */
function textIn(text: EditText, range: EditorRange): string {
  const parts: string[] = [];
  for (let line = range.start.line; line <= range.end.line; line++) {
    const lineText = text.lines[line] ?? '';
    const from = line === range.start.line ? range.start.character : 0;
    parts.push(line === range.end.line ? lineText.slice(from, range.end.character) : lineText.slice(from));
  }
  return parts.join('\n');
}

// -------------------------------------------------------------------------------------------
// Tokens
// -------------------------------------------------------------------------------------------

/**
 * Whether the `?` at offset `at` of `s` starts a token of its own, as the compiler's lexer reads it:
 * it is not inside a run of operator characters (`+?h` is the operator `+?`, then `h`), except for
 * the end of a group symbol, which the lexer matches before an operator (`[<?x]`, `[|?k|]`:
 * `GROUP_SYMBOLS`, `Parser/Lexer/Source.idr` [src]; both holes to idris2 0.8.0 [live, M4's ninth
 * review]).
 */
function startsToken(s: string, at: number): boolean {
  let run = at;
  while (run > 0 && OPERATOR_CHARACTERS.includes(s[run - 1])) {
    run--;
  }
  // A group symbol starts with a character that ends any operator run (`[`, `(`, `{`, `` ` ``, or the
  // `.`/`@` the lexer tries as a group first), so one that ends right before the `?` is read as one.
  return run === at || GROUP_SYMBOLS.some(([open]) => s.startsWith(open, at - open.length));
}

/**
 * Whether `s` has the hole token `?` + an identifier at `start`, ending at `end`: the `?` starts a
 * token (`startsToken`) and the character after the name does not continue it.
 */
function isHoleToken(s: string, start: number, end: number): boolean {
  return startsToken(s, start) && !isIdentTrailing(s.codePointAt(end));
}

/** A hole token's columns on its line, end exclusive, `?` included. */
export interface TokenColumns {
  readonly start: number;
  readonly end: number;
}

/** The token `?name` on `lineText` that holds `character` (its end included), if any. */
export function holeTokenAt(lineText: string, character: number, name: string): TokenColumns | undefined {
  const needle = `?${name}`;
  for (let at = lineText.indexOf(needle); at >= 0; at = lineText.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (isHoleToken(lineText, at, end) && at <= character && character <= end) {
      return { start: at, end };
    }
  }
  return undefined;
}

/** Whether `code` holds a hole token (a `?` that starts a token, `startsToken`, followed by an identifier's first character). */
function hasHoleToken(code: string): boolean {
  for (let at = code.indexOf('?'); at >= 0; at = code.indexOf('?', at + 1)) {
    const next = code.codePointAt(at + 1);
    if (next !== undefined && (/[A-Za-z_]/.test(String.fromCodePoint(next)) || next > 0xa0) && startsToken(code, at)) {
      return true;
    }
  }
  return false;
}

/**
 * Why `:case-split` on the line `lineText` (its code `code`, without a literate marker) would answer
 * with text that is not the line rewritten (`core/idrisSyntax.ts` `caseSplitLineProblem`, which the
 * light bulb reads too), as the refusal says it, or `undefined`.
 */
function caseLineProblem(lineText: string, code: string, title: string): string | undefined {
  switch (caseSplitLineProblem(lineText, code)) {
    case 'of':
      return (
        `${title}: this line holds the word of (in a one-line case, a comment or a string), and the compiler then rewrites its answer as ` +
        'for a one-line case, which breaks it. Move the comment or string to a line of its own, or put the case alternatives on lines of their own.'
      );
    case 'paren':
      return `${title}: the hole on this line is followed by a closing parenthesis, and the compiler would remove one from each new line but the last. Remove the parentheses around the hole first.`;
    case 'string':
      return `${title}: a string on this line holds a name of the clause or a hole, which the compiler would rewrite inside the string too. Rename that variable, or move the string off this line, first.`;
    case 'namedArgument':
      return (
        `${title}: a named argument on this line is matched with a variable of its own name ({n = n}), and the compiler would write the new ` +
        'pattern before that variable instead of in its place ({n = 0 = 0}). Write {n}, or name the variable otherwise ({n = m}), first.'
      );
    case undefined:
      return undefined;
  }
}

// -------------------------------------------------------------------------------------------
// Declarations and definitions
// -------------------------------------------------------------------------------------------

/**
 * A code line's layout column (`indent`) and its code from its first token on; `undefined` for a line
 * that is not code, not in the text, or starts inside a block comment or a string
 * (`EditText.continued`). The column is the one the compiler's layout reads, in code points after
 * the marker (`firstTokenOffset`): below `g 0 = 1`, a line `{- c -}  + 2` continues that clause (`g 0`
 * is 3), and so does one of U+00A0 and ` + 4` below `h 0 = 1` (`h 0` is 5) [live, M4's convergence
 * pass], so text put right after the clause would take that line in. On a line that holds no token,
 * the column of its first character that is not white space.
 */
function entryAt(text: EditText, line: number): { readonly indent: number; readonly code: string } | undefined {
  const cl = codeLine(text, line);
  if (cl === undefined || text.continued.has(line)) {
    return undefined;
  }
  const at = firstTokenOffset(cl.code);
  return { indent: [...cl.code.slice(0, at)].length, code: cl.code.slice(at) };
}

/**
 * Text that puts a new line's first token in the layout column of line `line`'s (`entryAt`): the
 * line's code before its first token with each character but a tab written as a space (each is one
 * column to the compiler, a tab too), so that no comment or U+00A0 is copied.
 */
function layoutIndentation(text: EditText, line: number): string {
  const code = codeLine(text, line)?.code ?? '';
  return [...code.slice(0, firstTokenOffset(code))].map((c) => (c === '\t' ? c : ' ')).join('');
}

/**
 * Whether line `line` holds no token for the layout: blank, a comment only (also a line of a block
 * comment), or (bird tracks) prose, which the compiler's unlit text holds as a blank line (F11).
 */
function isEmptyLine(text: EditText, line: number): boolean {
  const entry = entryAt(text, line);
  return entry === undefined || levelTokens(entry.code).length === 0;
}

/** What is open at the start of line `line` (a block comment, a string, `EditText.continued`). */
function openAt(text: EditText, line: number): OpenBlock {
  let open = NOTHING_OPEN;
  for (let at = text.continued.get(line) ?? line; at < line; at++) {
    const cl = codeLine(text, at);
    if (cl !== undefined) {
      open = openAfter(cl.code, open);
    }
  }
  return open;
}

/**
 * The column of the first token below line `line`, on the first line below that holds one, as the
 * compiler's layout reads it (`firstTokenColumn`: code points after the marker, past white space and
 * comments); `'string'` when that line starts in a `"""` string's text, `undefined` when no line below
 * holds a token.
 */
function nextTokenColumn(text: EditText, line: number): number | 'string' | undefined {
  let open = openAfter(codeLine(text, line)?.code ?? '', openAt(text, line));
  for (let at = line + 1; at < text.lines.length; at++) {
    const cl = codeLine(text, at);
    if (cl === undefined) {
      continue;
    }
    const column = firstTokenColumn(cl.code, open);
    if (column !== undefined) {
      return column;
    }
    open = openAfter(cl.code, open);
  }
  return undefined;
}

/** Whether `code` (unindented) is a type declaration of `name`, alone or among other names. */
const declares = (code: string, name: string): boolean => signatureNames(code)?.includes(name) === true;

/** A type declaration's lines (`start` to `end`) and the number of names it declares. */
interface Declaration {
  readonly start: number;
  readonly end: number;
  readonly names: number;
}

/**
 * The type declaration of `name` that holds `line`: the innermost of the entries that enclose it
 * (`enclosing`) that declares `name` (`signatureNames` of its lines, `entryCode`, after modifiers and
 * function-option pragmas), with its lines up to `entryEnd`; `undefined` when there is none or it
 * ends above `line`.
 */
function declarationAt(text: EditText, line: number, name: string): Declaration | undefined {
  for (const start of enclosing(text, line)) {
    const entry = entryAt(text, start);
    if (entry === undefined) {
      continue;
    }
    const end = entryEnd(text, start, entry.indent);
    const names = signatureNames(entryCode(text, start, end));
    if (names?.includes(name) === true) {
      return end >= line ? { start, end, names: names.length } : undefined;
    }
  }
  return undefined;
}

/**
 * The code of the entry on lines `start` to `end` (`entryEnd`), its lines joined with a space, their
 * line comments dropped: a signature whose `:` starts the next line (`f` / `  : Nat -> Nat`, which
 * idris2 accepts and answers `:add-clause` for [live, M4's ninth review]) reads as one, as the light
 * bulb's block model reads it (`features/editing/targets.ts`).
 */
function entryCode(text: EditText, start: number, end: number): string {
  const parts: string[] = [];
  for (let at = start; at <= end; at++) {
    const entry = isEmptyLine(text, at) ? undefined : entryAt(text, at);
    if (entry !== undefined) {
      parts.push(withoutLineComment(entry.code));
    }
  }
  return parts.join(' ');
}

/**
 * The entries of the layout block that holds line `line` at layout column `indent` (`entryAt`): the
 * code lines whose first token is in exactly that column between the nearest lines above and below
 * whose first token is left of it (the whole text for column 0). Empty lines (`isEmptyLine`) are not
 * entries.
 */
function siblingLines(text: EditText, line: number, indent: number): number[] {
  const inBlock = (at: number): boolean => isEmptyLine(text, at) || (entryAt(text, at)?.indent ?? 0) >= indent;
  let first = line;
  while (first > 0 && inBlock(first - 1)) {
    first--;
  }
  let last = line;
  while (last + 1 < text.lines.length && inBlock(last + 1)) {
    last++;
  }
  const lines: number[] = [];
  for (let at = first; at <= last; at++) {
    if (!isEmptyLine(text, at) && entryAt(text, at)?.indent === indent) {
      lines.push(at);
    }
  }
  return lines;
}

/**
 * The last line of the entry that starts at `line`, whose first token is in layout column `indent`:
 * the code lines after it whose first token is right of that column (`entryAt`, as the compiler's
 * layout reads them, over empty lines), and the lines of a block comment or string opened by one of
 * its code lines or by a line whose first token is right of that column (`EditText.continued`); not
 * the empty lines after them, nor a comment that starts in that column or left of it. (While the
 * loop runs, every code line from `line` on is the entry's, the first that is not ends it, and a run
 * reached from it opened at or after `line`, which, an entry, starts inside none.)
 */
function entryEnd(text: EditText, line: number, indent: number): number {
  let end = line;
  for (let at = line + 1; at < text.lines.length; at++) {
    const opener = text.continued.get(at);
    if (opener !== undefined && (!isEmptyLine(text, opener) || (entryAt(text, opener)?.indent ?? 0) > indent)) {
      end = at;
      continue;
    }
    if (isEmptyLine(text, at)) {
      continue;
    }
    if ((entryAt(text, at)?.indent ?? 0) <= indent) {
      break;
    }
    end = at;
  }
  return end;
}

/**
 * The last line of the clauses of `name`, declared at `declaration`, among the entries of its layout
 * block (`siblingLines`): of the one run of entries whose clause defines `name` (`clauseName`), right
 * after the declaration or elsewhere in the block (signatures first, clauses later, as in a `mutual`
 * block), with the more indented lines of its last entry (`entryEnd`); `undefined` when there is
 * none. Throws `Unsupported` when there are two runs: the compiler rejects such a definition, and a
 * clause added to either would be misplaced.
 */
function clausesEnd(text: EditText, declaration: Declaration, name: string, title: string): number | undefined {
  const indent = entryAt(text, declaration.start)?.indent ?? 0;
  const siblings = siblingLines(text, declaration.start, indent);
  let last: number | undefined;
  for (let i = 0; i < siblings.length; i++) {
    const at = siblings[i];
    if (clauseName(entryAt(text, at)?.code ?? '') !== name) {
      continue;
    }
    if (last !== undefined && siblings[i - 1] !== last) {
      throw unsupported(`${title}: the clauses of ${name} are not all together, so there is no one place for the new text. Put them one after another.`);
    }
    last = at;
  }
  return last === undefined ? undefined : entryEnd(text, last, indent);
}

/**
 * The lines of the entries that enclose line `line`, innermost first: `line`'s own entry (the
 * line itself), then the nearest code line above whose first token is left of its (`entryAt`), and
 * so on out to one in column 0. Empty lines (`isEmptyLine`) are skipped.
 */
function enclosing(text: EditText, line: number): number[] {
  const chain: number[] = [];
  let indent = Infinity;
  for (let at = line; at >= 0 && indent > 0; at--) {
    const entry = isEmptyLine(text, at) ? undefined : entryAt(text, at);
    if (entry !== undefined && entry.indent < indent) {
      chain.push(at);
      indent = entry.indent;
    }
  }
  return chain;
}

/** The first keyword of `code` (after modifiers such as `public export`), when its first token is one. */
function leadingKeyword(code: string): string | undefined {
  const first = levelTokens(code).find((t) => t.kind !== 'keyword' || !MODIFIER_KEYWORDS.has(t.text));
  return first?.kind === 'keyword' ? first.text : undefined;
}

/**
 * Lines whose block make-lemma's type goes into, not above (`lemmaPlace`): `namespace` and `mutual`
 * blocks, whose declarations may use each other, and the `module` and `import` lines (and `%`
 * directives) above a file whose top-level declarations are indented.
 */
const PASSED_THROUGH: ReadonlySet<string> = new Set(['namespace', 'mutual', 'module', 'import']);

/**
 * Where make-lemma's type goes (`lemmaPlace`): the line it is inserted at, the indentation of the
 * declaration there, and the last line of the entry that holds the hole in that block (`entryEnd`:
 * its `where` block included).
 */
interface LemmaPlace {
  readonly line: number;
  readonly indent: string;
  readonly end: number;
}

/**
 * Where make-lemma's type goes (module comment), or a refusal: above the declaration that holds line
 * `line` in the outermost block that is not passed through (`PASSED_THROUGH`: in a `namespace` or
 * `mutual` block the type goes above the declaration in that block, with its indentation), found
 * with `enclosing`; refused in an `interface` (a default method's lemma takes the interface's
 * dictionary, `default_rhs x __con` [live, M4 edit review]). When that declaration is a clause: the
 * clauses of the name it defines above it (`clauseName`: an infix operator or a backticked name
 * too) and that name's type declaration, over blank and more indented lines; and above those, the
 * doc comments, comments and lines of modifiers and function-option pragmas (`isOptionLine`) right
 * above, at the same indentation. A `parameters` block and a `where` or `let` block are not passed
 * through: the type goes above the block's own line (checked live for `parameters`).
 */
function lemmaPlace(text: EditText, line: number, title: string): LemmaPlace | string {
  const chain = enclosing(text, line);
  let top = line;
  for (let k = chain.length - 1; k >= 0; k--) {
    const code = entryAt(text, chain[k])?.code ?? '';
    const keyword = leadingKeyword(code);
    if (keyword === 'interface') {
      return `${title} is not available in an interface: the lemma of a default method would take the interface's own dictionary, which no code can name.`;
    }
    if (k > 0 && ((keyword !== undefined && PASSED_THROUGH.has(keyword)) || code.startsWith('%'))) {
      continue;
    }
    top = chain[k];
    break;
  }
  const own = entryAt(text, top);
  const indent = own?.indent ?? 0;
  let start = top;
  const name = clauseName(own?.code ?? '');
  if (name !== undefined) {
    for (let at = top - 1; at >= 0; at--) {
      const entry = isEmptyLine(text, at) ? undefined : entryAt(text, at);
      if (entry === undefined || entry.indent > indent) {
        continue;
      }
      if (entry.indent < indent) {
        break;
      }
      if (declares(entry.code, name)) {
        start = at;
        break;
      }
      if (clauseName(entry.code) !== name) {
        break;
      }
      start = at;
    }
  }
  for (let above = entryAt(text, start - 1); above !== undefined && start > 0; above = entryAt(text, start - 1)) {
    const { indent: at, code } = above;
    if (at !== indent || isBlank(code) || !(code.startsWith('|||') || levelTokens(code).length === 0 || isOptionLine(code))) {
      break;
    }
    start--;
  }
  return { line: start, indent: layoutIndentation(text, top), end: entryEnd(text, top, indent) };
}

/** The name tokens of the code of lines `first` to `last` (`levelTokens`, inside brackets too). */
function namesIn(text: EditText, first: number, last: number): Set<string> {
  const names = new Set<string>();
  for (let at = first; at <= last; at++) {
    for (const t of levelTokens(entryAt(text, at)?.code ?? '', true)) {
      if (t.kind === 'name') {
        names.add(t.text);
      }
    }
  }
  return names;
}

/**
 * Whether make-lemma's application (`f_rhs x y`, or `(f_rhs x y)`) passes an argument that is not a
 * name token of the code of lines `first` to `last` (from the lemma's place to the hole): a name the
 * compiler made — `conArg` for an unnamed constraint (`genVarName "conArg"`, `TTImp/Elab/Term.idr`
 * 135 [src]), `lcase` for `\case` (`Idris/Parser.idr` 793 [src]), `__con` for an interface's
 * dictionary — which the file cannot name: `f_rhs conArg x` gives `Undefined name conArg` [live,
 * M4 edit review]. The application's arguments are the hole's explicit locals (`mkApp`,
 * `TTImp/Interactive/MakeLemma.idr` [src]), each bound by that code when the user named it.
 */
function passesUnnamed(text: EditText, first: number, last: number, application: string): boolean {
  const names = namesIn(text, first, last);
  return lemmaArguments(application).some((argument) => !names.has(argument));
}

/** The arguments of make-lemma's application (`f_rhs x y`, or `(f_rhs x y)`). */
function lemmaArguments(application: string): string[] {
  const unbracketed = application.startsWith('(') && application.endsWith(')') ? application.slice(1, -1) : application;
  return unbracketed.trim().split(/\s+/).slice(1);
}

/**
 * Make Lemma's type `lemma` (the compiler writes it unindented, with the marker of the hole's line
 * in a literate file), indented as the declaration at `place`: after the marker `marker` when there
 * is one. `undefined` when a line of it has not the marker it should.
 */
function indentedLemma(lemma: string, place: LemmaPlace, marker: string | undefined): string | undefined {
  if (place.indent === '') {
    return lemma;
  }
  const relit = marker === undefined ? '' : `${marker} `;
  const lines = lemma.split('\n');
  return lines.every((l) => l.startsWith(relit)) ? lines.map((l) => relit + place.indent + l.slice(relit.length)).join('\n') : undefined;
}

/**
 * Whether the declaration at line `line` is in a `parameters` block: `:missing` then answers the
 * block's parameters as patterns of each missing clause too (`f4 _ B` for `f4 : T -> Nat` in
 * `parameters (k : Nat)` [live, M4 edit review]).
 */
function inParameters(text: EditText, line: number): boolean {
  return enclosing(text, line).slice(1).some((at) => leadingKeyword(entryAt(text, at)?.code ?? '') === 'parameters');
}

/**
 * Whether the declaration at line `line` is local to a definition: an entry around it holds a `=` or
 * `=>` (a `where` or `let` block; the light bulb's `DeclarationTarget.local`). `:missing` never
 * reports such a function: it answers `Undefined name go`, or for a top-level function of the name
 * (`W.go:` / `go B` for a where-local `go` [live, M4 edit review]).
 */
function isLocal(text: EditText, line: number): boolean {
  return enclosing(text, line)
    .slice(1)
    .some((at) => levelTokens(entryAt(text, at)?.code ?? '').some((t) => t.kind === 'symbol' && (t.text === '=' || t.text === '=>')));
}

/**
 * The name `:missing` reports the function `name` declared at line `line` under: the module's name
 * (its `module` line, after a doc comment at most; `Main` without one: `progHdr`, `Idris/Parser.idr`
 * 1994–2004, `mainNS` [src]), the names of the `namespace` blocks around it, outermost first, then
 * `name` (`NsMiss.A.f`, `Edits.(<&&>)` [live, transcript `edits-names` and M4 edit review]).
 */
function qualifiedName(text: EditText, line: number, name: string): string {
  let module = 'Main';
  for (let at = 0; at < text.lines.length; at++) {
    const code = isEmptyLine(text, at) ? undefined : entryAt(text, at)?.code;
    if (code !== undefined && !code.startsWith('|||')) {
      const [keyword, moduleName] = levelTokens(code);
      if (keyword?.kind === 'keyword' && keyword.text === 'module' && moduleName?.kind === 'name') {
        module = moduleName.text;
      }
      break;
    }
  }
  const namespaces = enclosing(text, line)
    .slice(1)
    .reverse()
    .flatMap((at) => {
      const tokens = levelTokens(entryAt(text, at)?.code ?? '').filter((t) => t.kind !== 'keyword' || !MODIFIER_KEYWORDS.has(t.text));
      return tokens[0]?.kind === 'keyword' && tokens[0].text === 'namespace' && tokens[1]?.kind === 'name' ? [tokens[1].text] : [];
    });
  return [module, ...namespaces, name].join('.');
}

/** Whether the code of `text` (not its comments or strings) holds the hole `?name`. */
function hasHole(text: EditText, name: string): boolean {
  return text.lines.some((_, at) => levelTokens(entryAt(text, at)?.code ?? '', true).some((t) => t.kind === 'other' && t.text === `?${name}`));
}

/**
 * The first `k` of make-missing-cases' holes `?<hole>_missing_case_<k>` that is past every such
 * hole already in the text, so that no new hole repeats an open one's name.
 */
function firstMissingCase(text: EditText, hole: string): number {
  const needle = `?${hole}_missing_case_`;
  let last = 0;
  for (const lineText of text.lines) {
    for (let at = lineText.indexOf(needle); at >= 0; at = lineText.indexOf(needle, at + 1)) {
      const digits = /^[0-9]+/.exec(lineText.slice(at + needle.length))?.[0];
      if (digits !== undefined && isHoleToken(lineText, at, at + needle.length + digits.length)) {
        last = Math.max(last, Number(digits));
      }
    }
  }
  return last + 1;
}

// -------------------------------------------------------------------------------------------
// Refusals
// -------------------------------------------------------------------------------------------

/** What an edit is called in the messages. */
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

/**
 * Why `req`'s names cannot be sent, or `undefined` (module comment, *Names*): the name, the hints of
 * a proof search, and the NUL that no string sent to the compiler may hold (`sexp.ts`).
 */
export function nameProblem(req: EditAtRequest | ExprSearchRequest | RefineRequest): string | undefined {
  const title = TITLES[req.kind];
  switch (req.kind) {
    case 'caseSplit':
      return isIdentifierName(req.name) ? undefined : `${title} needs a pattern variable, and the name given is not an Idris variable name.`;
    case 'addClause':
    case 'generateDef':
    case 'addMissingCases':
      return isIdentifierName(req.name) || isOperatorInParentheses(req.name)
        ? undefined
        : `${title} needs a function's name or an operator in parentheses, and the name given is neither.`;
    case 'exprSearch': {
      const hint = req.hints.find((h) => !isIdentifierName(h) && !isOperatorInParentheses(h));
      if (hint !== undefined) {
        return `${title}: a hint is not a name or an operator in parentheses.`;
      }
      break;
    }
    case 'makeLemma':
      if (isHoleName(req.name) && isKeyword(req.name)) {
        return `${title} names the lemma after the hole, and this hole's name is a keyword, which cannot name a function. Rename the hole first.`;
      }
      break;
    case 'refine':
      if (req.hint.includes('\u0000')) {
        return `${title}: the expression contains a NUL character, which cannot be sent to the compiler.`;
      }
      // The compiler reads the expression as far as it parses and drops the rest unread (`IDEMode/REPL.idr`
      // 179–181 [src]; `S Z) junk` refined the hole with `1` [live, M4's ninth review]): a bracket closed
      // that nothing opened would end it early.
      if (closesUnopened(req.hint)) {
        return `${title}: the expression closes a bracket it does not open, and the compiler would ignore everything after it.`;
      }
      break;
    default:
      break;
  }
  return isHoleName(req.name) ? undefined : `${title} needs a hole ?name, and the name given is not an Idris hole name.`;
}

/**
 * The refusal on a type declaration of several names (`a, b : Nat -> Nat`): the compiler's
 * `:add-clause` and `:generate-def` answer for the last of them whatever the name sent (`:add-clause
 * 5 "a"` answered `b k = ?b_rhs` [live]), and a coverage error there does not say which one it is.
 */
function severalNames(declaration: Declaration, title: string): string | undefined {
  return declaration.names > 1 ? `${title} is not available on a type declaration of several names. Declare the function on a line of its own.` : undefined;
}

/**
 * The refusal of an Add Clause or Generate Definition answer (`answer`, its lines marked as the
 * literate style `style` marks code) of which a clause binds a variable named like its function
 * (`shadowsItsName`), or `undefined`. The compiler's argument names (`x`, `f` for a function, `k`, `j`
 * for a `Nat`; `getArgName`, `TTImp/Utils.idr` 557–600 [src]) do not avoid the function's name: `f
 * f = ?f_rhs` for `f : (Nat -> Nat) -> Nat`, `j k j = j` for `j : Nat -> Nat -> Nat`, which Idris 2
 * rejects [live, M4's eighth review]. Every next definition keeps the left-hand side.
 */
function shadowProblem(answer: string, style: LiterateStyle | undefined, title: string): string | undefined {
  const shadowing = answer.split('\n').some((l) => {
    const cl = codeLineOf(style, l);
    return cl !== undefined && shadowsItsName(cl.code.trimStart());
  });
  return shadowing
    ? `${title}: the compiler named an argument like the function, which Idris 2 rejects (a declaration name shadowed by a pattern variable), so nothing was applied. ` +
        'Name that argument in the type first, e.g. (g : Nat -> Nat) -> Nat.'
    : undefined;
}

/**
 * Why the compiler would read another line than the one it finds its place at, for the three
 * commands that do both (module comment, *Lines the compiler numbers otherwise*; `misreadBelow`), or
 * `undefined`. `markerOnly`: the line read is used only for its literate marker (`:add-clause`,
 * `:generate-def`), so a line read below a doubled line with the same marker is right.
 */
function numberingProblem(text: EditText, line: number, title: string, markerOnly: boolean): string | undefined {
  if (text.carriageReturns === 'lone') {
    return `${title} is not available in a file with a carriage return that ends no line (a \\r without \\n): the compiler numbers its lines otherwise than the editor. Convert the line breaks to LF.`;
  }
  if (text.style !== undefined && text.carriageReturns === 'crlf') {
    return `${title} is not available in a literate file with CRLF line breaks: the compiler numbers its lines otherwise than the editor. Convert the line breaks to LF.`;
  }
  const doubled = misreadBelow(text, line, markerOnly);
  if (doubled.length === 0) {
    return undefined;
  }
  return (
    `${title} is not available below ${doubledLinesText(doubled)} a literate marker followed only by spaces: ` +
    'the compiler counts such a line twice and would read the wrong line. Delete the spaces after the marker.'
  );
}

// -------------------------------------------------------------------------------------------
// Make Case's answer; literate markers in make-with replies
// -------------------------------------------------------------------------------------------

/**
 * Make Case's answer for the hole at columns `hole` of the raw line `lineText`, as the compiler writes
 * it (`makeCase`, `Idris/IDEMode/MakeClause.idr` 57–81 [src]): its first `?name` (the plan checked
 * that it is the hole) replaced by `case _ of` and, on a new line indented by the number of
 * characters before the hole plus 5 (code points: a tab counts 1), `case_val => ?name`, the rest of
 * the line after it; with `brack` (the compiler's `bracketholes`, set for a prefix application's
 * argument) by `(case _ of` and `case_val => ?name)`, indented by that number plus 6. Its two lines,
 * without IDE mode's literate markers (module comment, *Literate markers*).
 */
function madeCase(lineText: string, hole: TokenColumns, name: string, brack: boolean): [string, string] {
  const before = lineText.slice(0, hole.start);
  const [open, close] = brack ? ['(', ')'] : ['', ''];
  const indent = ' '.repeat([...before].length + 5 + open.length);
  return [`${before}${open}case _ of`, `${indent}case_val => ?${name}${close}${lineText.slice(hole.end)}`];
}

/**
 * `lines` (make-with's answer for line `line`) as the file needs them (module comment, *Literate
 * markers*); unchanged without a marker on that line. `undefined` when the answer does not have the
 * shape recorded for a marked line.
 */
function literateRepair(text: EditText, line: number, lines: readonly string[]): readonly string[] | undefined {
  const own = codeLine(text, line);
  const marker = markerOf(own);
  if (own === undefined || marker === undefined) {
    return lines;
  }
  const relit = `${marker} `;
  const withArg = relit + relit;
  const withPat = `${relit + relit}  `;
  if (lines.length !== 2 || !lines[0].startsWith(withArg + own.prefix) || !lines[1].startsWith(withPat + own.prefix)) {
    return undefined;
  }
  const pattern = lines[1].slice(withPat.length);
  return [lines[0].slice(withArg.length), `${pattern.slice(0, own.prefix.length)}  ${pattern.slice(own.prefix.length)}`];
}

/**
 * Add Clause's answer (one line) as the file needs it: after the marker of a marked declaration
 * line, the declaration's own indentation (`layoutIndentation`). The compiler writes one space less there (`getClause`
 * indents a marked line by the declaration's column less one, `Idris/IDEMode/CaseSplit.idr` 392–394
 * [src]), which only an unindented declaration survives (`max 0`); an indented one's clause then
 * leaves its block (`>    go k ks = ?go_rhs` below `>     go : …` [live, transcript `lit-indent-editing`]).
 */
function addedClause(text: EditText, declarationLine: number, answer: string, title: string): string {
  const own = codeLine(text, declarationLine);
  const marker = markerOf(own);
  if (own === undefined || marker === undefined) {
    return answer;
  }
  if (!answer.startsWith(marker) || answer.includes('\n')) {
    throw unsupported(`${title}: the compiler's answer for this literate line has a form that was not expected, so it was not applied.`);
  }
  return own.prefix + layoutIndentation(text, declarationLine) + answer.slice(marker.length).trimStart();
}

/**
 * A `:case-split` answer for line `line` as the file needs it. The compiler answers in one of two
 * shapes here (`updateCase`, `IDEMode/CaseSplit.idr` 181–183, 319–363 [src]; each seen live, M4 edit
 * review): line `line` rewritten once per constructor, which keeps its marker and indentation (a
 * one-line `case` is refused before the request, `caseLineProblem`); and when every constructor is
 * impossible, `<clause> impossible` lines indented by the line's leading spaces only (`getIndent`,
 * which stops at a tab or a marker), which get the line's own marker and indentation back in place
 * of those spaces. Throws `Unsupported` for any other shape, and for copies of the line that differ
 * in their holes' names only.
 */
function splitLines(text: EditText, line: number, answer: string, title: string): string {
  const own = codeLine(text, line) ?? { prefix: '', code: '' };
  const head = own.prefix + indentationOf(text, line);
  const lines = answer.split('\n');
  let repaired: (string | undefined)[];
  if (lines[0].startsWith(head)) {
    repaired = lines.map((l) => (l.startsWith(head) ? l : undefined));
  } else {
    const leading = /^ */u.exec(text.lines[line])?.[0].length ?? 0;
    repaired = lines.map((l) => (l.startsWith(' '.repeat(leading)) && /^\S.* impossible$/u.test(l.slice(leading)) ? head + l.slice(leading) : undefined));
  }
  if (repaired.some((l) => l === undefined)) {
    throw unsupported(`${title}: the compiler's answer for this line has a form that was not expected, so it was not applied.`);
  }
  // Clauses that differ only in their holes' names: the compiler split nothing (an as-pattern's name,
  // `namesAsPattern`), and the copies would be unreachable.
  const unnamed = new Set(lines.map((l) => l.replace(/\?[^\s()[\]{},;`"]+/gu, '?')));
  if (lines.length > 1 && unnamed.size === 1) {
    throw unsupported(`${title}: the compiler repeated the clause unchanged instead of splitting it, so nothing was applied.`);
  }
  return repaired.join('\n');
}

/**
 * `answer`'s lines with the indentation `indent` of the line they were made for put back: the
 * compiler counts a tab as one column and writes a space for each column (`getClause`, `makeWith`,
 * `makeCase` [src]; `\tgo : …` gave ` go k = ?go_rhs` [live, M4 edit review]), so where `indent`
 * holds a tab the first `indent.length` code points of each line, when they are spaces, become
 * `indent` again (to the compiler the same columns; to the editor the same as the
 * line's). Unchanged without a tab; a line that starts with a literate marker is left as it is
 * (`addedClause`, `literateRepair`).
 */
function retabbed(answer: string, indent: string): string {
  if (!indent.includes('\t')) {
    return answer;
  }
  const spaces = ' '.repeat([...indent].length);
  return answer
    .split('\n')
    .map((l) => (l.startsWith(spaces) ? indent + l.slice(spaces.length) : l))
    .join('\n');
}

/**
 * The leading spaces and tabs of line `line`'s code, as the compiler's answers copy them (`splitLines`)
 * or count them (`retabbed`); the line's layout column is `entryAt`'s.
 */
function indentationOf(text: EditText, line: number): string {
  const code = codeLine(text, line)?.code ?? '';
  return code.slice(0, indentOf(code));
}

// -------------------------------------------------------------------------------------------
// Plans
// -------------------------------------------------------------------------------------------

/** What `backend.ts` needs to send one edit request and read its answer. */
export interface EditPlan {
  readonly command: Sexp;
  /**
   * `exprSearch`, `generateDef` and their `-Next`, `refine` (it elaborates the expression the user
   * typed, which can take seconds: `(\p : f (f 400000) = 400000 => 0) Refl` took 6.6 s [live, the UX
   * review of M4]), `intro` and `makeLemma` (they normalise the hole's type: 2.6 s and 1.7 s on holes
   * of type `Vect 65536 Bits8` [live, the UX review of M4]), `addMissingCases` (for a name the compiler
   * does not know, it looks for similar names in its whole context before it answers `Undefined name`,
   * `getSimilarNames`, `Core/Context.idr` 1143–1164 [src]: 0.94 s for 100 characters, 3.5 s with 14
   * imports [live, M4's eighth review]): `idris2.ideMode.longActionTimeout`.
   */
  readonly long: boolean;
  /**
   * The refusal when the load returned an error: the request finds its place by line, which fails
   * after such a load (F16: `No clause to split here` on a clause with a hole, `g not defined here`,
   * `Can't find declaration for g on line 3`, also after a coverage error alone [live, transcripts
   * `hole-errors`, `part-editing`; `:case-split` after a coverage error alone checked live in M4's
   * ninth review]); `undefined` for the requests that still answer then.
   */
  readonly afterFailedLoad?: string;
  /** `:case-split` reads its line from the file on disk when it is asked (`updateCase` [src]). */
  readonly readsDisk: boolean;
  /** The search the request starts, whose next results `-Next` asks for. */
  readonly starts?: 'exprSearch' | 'generateDef';
  /**
   * The hole token at the cursor, for the requests that find the hole by its name alone in the
   * compiler's whole context (`:intro`, `:refine`, `:proof-search`, `:make-lemma`): `backend.ts`
   * sends them only while the load's holes say that the compiler would answer for this one
   * (`holeRefusal`).
   */
  readonly hole?: TokenColumns;
  /** The answer as an `EditResult`; throws `Unsupported` for an answer that cannot be applied, `ProtocolError` for one of another shape. */
  decode(payload: ReplyPayload): EditResult;
}

const failed = (message: string): EditResult => ({ type: 'failed', message });

/** One replacement of the hole token at `hole` on `line` by `replacement`. */
const atHole = (line: number, hole: TokenColumns, replacement: string): TextReplacement => ({
  range: { start: { line, character: hole.start }, end: { line, character: hole.end } },
  text: replacement,
});

// -------------------------------------------------------------------------------------------
// Answers in place: in parentheses unless one token
// -------------------------------------------------------------------------------------------

/**
 * `answer` (an expression the compiler printed for a hole: Intro's, Refine Hole's and its ambiguity
 * alternatives, Proof Search's and its next results', Make Lemma's call) as it goes in place of the
 * text between `before` and `after` on its line (the hole, or a previous result): as it is when it
 * is one token (`isOneToken`: a name, a literal, a hole, an operator in parentheses, or one bracketed
 * group; not a postfix projection `.x`, which attaches to the expression before it), else in
 * parentheses, wherever the hole is. The compiler brackets its answer only for a hole
 * that is an argument of a prefix application (`bracketholes` is set in `argExpr` only,
 * `Idris/Parser.idr` 263 [src]): next to an operator a lambda took the rest of the expression in
 * (`\arg => ?f_0 <$> xs`) and an operator application re-associated (`?h_0 + ?h_1 * 2` [live, M4's
 * ninth review]). Deciding from the code around the hole where the parentheses could be left out kept
 * missing cases, each a silently changed program, so there is no such reading (user decision,
 * 2026-10-01); parentheses only cost looks. A token goes in parentheses too where it would join the
 * text next to it: one that starts with a name's character (`isIdentTrailing`) after such a character
 * (`g?h` is `g ?h` to the lexer, and `x` there gave `g x = gx`, which checks when a `gx` exists), one
 * that ends with one before a `.` (`Rr.foo` is a qualified name) [live, M4's review of the decisions],
 * and a string literal right after or before a `"`: a string ends at a `"` (and its `#`s) not
 * followed by another `"` (`Parser/Lexer/Source.idr` 336 [src]), so `g "x""a"` does not lex
 * (`Bracket is not properly closed` [live, M4's second review of the fixes]). (A hole right after a
 * raw string's `"#` is not found at all: `startsToken` reads `#?` as an operator.) After a backtick (`` x
 * `div`?h ``), a space goes before an answer that starts with a bracket: `` `( ``, `` `[ `` and
 * `` `{ `` open a quotation (`groupSymbols`, `Parser/Lexer/Source.idr` [src]; `` x `div`(id 1) ``
 * gave `Not the end of a block entry` [live, M4's convergence pass]). Refused: an answer that holds
 * no token (`()` would be the unit value), and at the head of an idiom bracket on the hole's line
 * (`idiomHeadProblem`) one that is not a name, a hole or a lambda.
 */
function inPlace(answer: string, title: string, before: string, after: string): string {
  if (levelTokens(answer, true).length === 0) {
    throw unsupported(`${title}: the compiler's answer holds no expression; nothing was applied.`);
  }
  const idiomHead = idiomHeadProblem(answer, before, title);
  if (idiomHead !== undefined) {
    throw unsupported(idiomHead);
  }
  // A surrogate is above U+00A0, as is the code point it is part of: a name's character either way.
  const nameChar = (s: string, at: number): boolean => s !== '' && isIdentTrailing(s.charCodeAt(at));
  const joins =
    (nameChar(before, before.length - 1) && nameChar(answer, 0)) ||
    (after.startsWith('.') && nameChar(answer, answer.length - 1)) ||
    (before.endsWith('"') && answer.startsWith('"')) ||
    (after.startsWith('"') && /"#*$/u.test(answer));
  const put = isOneToken(answer) && !joins ? answer : `(${answer})`;
  return before.endsWith('`') && /^[([{]/u.test(put) ? ` ${put}` : put;
}

/**
 * The refusal of `answer` in place of a hole (`inPlace`) at the head of an idiom bracket — the code
 * `before` it on the line ends with `[|` (or `.[|`) and only white space and `(` after it, as in
 * `[| ?h |]` and `[| ?h x |]` —, or `undefined`. The compiler drops the parentheses (`PBracketed`)
 * before `idiomise`, which reads every application at the head of the bracket's spine as applicative
 * (`Idris/Desugar.idr` 279–291, 417, 526–531 [src]): Intro's `S ?h_0` there gave `[| (S ?h_0) |]`, which
 * loads with `?h_0 : Maybe Nat`, `S <$> ?h_0`, not `pure (S ?h_0)` [live, M4's third review of the
 * fixes]. An integer literal is an application too (`fromInteger`, `Desugar.idr` 443–451 [src]: `[| 0
 * |]` does not check [live, M4's convergence pass]), and so are a tuple and a non-empty list; a name, a
 * hole and a lambda are not (`IVar`, `IHole`, `ILam`, 303–308, 346–368, 487–489 [src]), and are put
 * there. Only the bracket on the hole's line is seen (not one on the line above, nor one a comment
 * separates from the hole); the hole is code (`holeRefusal`), so the text between it and the `[|` is
 * too.
 */
function idiomHeadProblem(answer: string, before: string, title: string): string | undefined {
  if (!/\[\|[\s(]*$/u.test(before)) {
    return undefined;
  }
  const tokens = levelTokens(answer, true);
  const kept = answer.startsWith('\\') || (tokens.length === 1 && (tokens[0].kind === 'name' || (tokens[0].kind === 'other' && tokens[0].text.startsWith('?'))));
  return kept
    ? undefined
    : `${title}: the hole is at the head of an idiom bracket [| … |], which reads an application there as applicative, parentheses or not (an integer ` +
        'literal, a tuple and a non-empty list are applications too), so this answer would change the program; nothing was applied. Only a name, a hole or a ' +
        'lambda is put there. Write that part with pure and <*> instead.';
}

/**
 * The first line of the entry that line `line` starts or continues: the nearest line above it, not
 * `continued`, whose first token (`firstTokenColumn`) is left of `line`'s; else `line` (a line with
 * no token of its own, or none such above). It may take in earlier entries of a block that `line`
 * is in; `holdsBlockHeader` reads past them.
 */
function entryStart(text: EditText, line: number): number {
  const column = (at: number): number | undefined => {
    const cl = codeLine(text, at);
    const c = cl === undefined || text.continued.has(at) ? undefined : firstTokenColumn(cl.code, NOTHING_OPEN);
    return typeof c === 'number' ? c : undefined;
  };
  const own = column(line);
  if (own === undefined) {
    return line;
  }
  for (let at = line - 1; at >= 0; at--) {
    const c = column(at);
    if (c !== undefined && c < own) {
      return at;
    }
  }
  return line;
}

/**
 * Whether the hole whose line `line` holds `before` before it is in a `parameters`, `using` or
 * `with` header (`holdsBlockHeader`), read from the first line of its entry (`entryStart`).
 */
function holdsHeader(text: EditText, line: number, before: string): boolean {
  const first = entryStart(text, line);
  const lines = Array.from({ length: line - first }, (_, k) => codeLine(text, first + k)?.code ?? '');
  return holdsBlockHeader([...lines, before].join('\n'), openAt(text, first));
}

/**
 * The refusal of an edit that puts text of another width than the hole's in its place (Make Case's
 * case, which moves the rest of the line 19 columns to the right; an answer in place, `inPlace`), at
 * the hole token `hole` of line `line`, or `undefined`. When the rest of the line starts an entry of a
 * layout block (`opensBlockOnLine`, the rest read from what is open at the hole: inside a string's
 * interpolation, the string's text is not code), that entry's column moves, and the lines below are
 * read against the new one: on `f x = ?h * case x of _ => 1` / `+ 2` in column 23 (in the
 * alternative, so `f 0` is 30 with `10` for the hole), Make Case's text and Intro's `(S ?h_0)` both
 * make it `(…) + 2`, 12; an aligned next entry of a `where` or `\case` after the hole stops parsing
 * [live, M4's review of the decisions]. So does the first entry of a `parameters` or `using` block
 * after a header that holds the hole (`holdsBlockHeader`; `parameters (n : ?h) g : Nat` with
 * an aligned `g = 1` below stops parsing after Intro's text [live, M4's second review of the fixes]),
 * read over the hole's entry from its first line (`entryStart`), so a header continued over lines is
 * seen too unless a line between starts left of the hole's line (`parameters (n : Nat)` / `(m : ?h) g : Nat` with an aligned `g = 1` below stops parsing
 * after `(Maybe Nat)` in the hole's place, `Expected end of input` [live, M4's third review of the fixes]). Refused
 * unless the first token below (`nextTokenColumn`; none below, too) is at the hole's column or left
 * of it: it ends every entry the rest starts, in either text, since those start right of the hole; a
 * token right of it continues the hole's entry. A line below that starts in a `"""` string's text
 * refuses.
 */
function layoutProblem(text: EditText, line: number, hole: TokenColumns, title: string): string | undefined {
  const lineText = text.lines[line];
  const open = openAt(text, line);
  const before = lineText.slice(codeLine(text, line)?.prefix.length ?? 0, hole.start);
  if (!opensBlockOnLine(lineText.slice(hole.end), openAfter(before, open)) && !holdsHeader(text, line, before)) {
    return undefined;
  }
  // The hole's column as the compiler counts it: code points, after the marker (`Literate.idr` `reduce` [src]).
  const column = [...before].length;
  const below = nextTokenColumn(text, line);
  if (below === undefined || (below !== 'string' && below <= column)) {
    return undefined;
  }
  return (
    `${title}: the text put in place of the hole moves the rest of this line, and with it the column of a block that starts there ` +
    "(after of, do, let, where, \\case, | or ; for example, also inside a string's \\{…}, or after a parameters or using header), " +
    "which the lines below are read against. Put that block's entry on a line of its own first."
  );
}

/**
 * `candidate`'s lines joined with one space, the spaces around each line break dropped. Index loops,
 * linear: the regular expression it replaces (spaces, a line break, spaces) scanned each long run of
 * spaces without a break again from every start, quadratic (a candidate `MkT "<40,000 spaces>"` took
 * 0.9 s, 100,000 spaces 5.9 s [unit-level, security review of M4]).
 */
function joinedLines(candidate: string): string {
  const pieces = candidate.split('\n');
  return pieces
    .map((piece, i) => {
      let start = 0;
      let end = piece.length;
      while (i > 0 && start < end && piece[start] === ' ') {
        start++;
      }
      while (i < pieces.length - 1 && end > start && piece[end - 1] === ' ') {
        end--;
      }
      return piece.slice(start, end);
    })
    .join(' ');
}

/**
 * Make With's answer (two lines, `<LHS>with (_)` and `<LHS>| with_pat = ?<h>_rhs`) with a space before
 * `with` and `|` where the left-hand side ends without one: the compiler copies the text before the
 * clause's `=` as it is (`makeWith` [src]), so `f x= ?h` gave `f xwith (_)` / `  f x| with_pat =
 * ?h_rhs`, which does not parse (`Expected end of input` [live, M4's eighth review]).
 */
function spacedWith(answer: string): string {
  const lines = answer.split('\n');
  if (lines.length !== 2) {
    return answer;
  }
  const spaced = (line: string, at: number): string => (at > 0 && !/[ \t]/u.test(line[at - 1]) ? `${line.slice(0, at)} ${line.slice(at)}` : line);
  const withArg = 'with (_)';
  return [spaced(lines[0], lines[0].endsWith(withArg) ? lines[0].length - withArg.length : -1), spaced(lines[1], lines[1].lastIndexOf('| with_pat = ?'))].join('\n');
}

/**
 * Whether the Intro candidate `candidate` is a lambda whose argument has a qualified name (`\FP.argTy
 * => ?g_0`): the compiler's only candidate for a hole applied to arguments (`foo x = ?g (S x)`),
 * whose type it infers, and one that does not check (`Mismatch between: (lamc : ?_) -> ?delayTy and
 * Nat`; in parentheses `Undefined name` [live, M4's eighth review]).
 */
const bindsQualifiedName = (candidate: string): boolean => /^\\\s*[^\s=,()]*\./u.test(candidate);

/**
 * Whether Refine Hole's expression `hint` is one name — an identifier, a qualified name or an
 * operator in parentheses — the only expression whose ambiguity alternatives are the whole answer
 * (`Ambig.A.foo ?g_rhs_0` for `foo`, F29). For any other, the compiler lists the alternatives of the
 * ambiguous subterm alone (`AmbigApp.A.foo 1` for `S (foo 1)` and for `foo 1 + 2`; `?postpone
 * [locals in scope: x]` in a `case` [live, M4 edit review]), which would replace the whole hole.
 */
function isOneName(hint: string): boolean {
  const name = hint.trim();
  return isOperatorInParentheses(name) || name.split('.').every(isIdentifierName);
}

/**
 * Whether the ambiguity alternative `alternative` of Refine Hole's one-name expression `hint`
 * (`isOneName`) is that name, qualified, followed by its arguments: its first word is the name or
 * ends with `.` and the name, after names and dots only (`Ambig.A.foo ?g_rhs_0` for `foo`;
 * `AmbMany.A.(***) ?g2_rhs_0 ?g2_rhs_1 ?g2_rhs_2` for `(***)` and `AmbMany.A.(<<>>) ?g3_rhs_0
 * ?g3_rhs_1` for an operator without a fixity [live, M4's convergence pass]). A binary operator with a
 * fixity, and a backticked name with one, are printed infix: `?g_rhs_0 AmbOp.A.(+++) ?g_rhs_1`, which
 * as source applies the hole `?g_rhs_0` to two arguments and still loads (its holes typed `(Nat -> Nat
 * -> Nat) -> ?argTy -> Nat` and `?argTy` [live, M4's third review of the fixes; the answer re-checked in
 * M4's convergence pass]), and
 * ``?g1_rhs_0 `AmbMany.A.foo` ?g1_rhs_1`` [live, M4's convergence pass]; neither is offered.
 */
function isNameApplied(alternative: string, hint: string): boolean {
  const name = hint.trim();
  const head = alternative.trimStart().split(/\s/u, 1)[0];
  return head === name || (head.endsWith(`.${name}`) && head.slice(0, -name.length - 1).split('.').every(isIdentifierName));
}

/**
 * The plan of an edit at a place (`EditAtRequest`, `ExprSearchRequest`, `RefineRequest`) in `text`,
 * which the compiler loaded; throws `Unsupported` for a request that is refused before anything is
 * sent (module comment). The names must have passed `nameProblem`.
 */
export function planEdit(req: EditAtRequest | ExprSearchRequest | RefineRequest, text: EditText): EditPlan {
  const title = TITLES[req.kind];
  const line = req.pos.line;
  const lineText = text.lines[line];
  if (lineText === undefined) {
    throw unsupported(`${title}: the position is outside the file.`);
  }
  const lineRequest = toIdeLineRequest(text, line);
  const plain = { long: false, readsDisk: false } as const;
  const afterFailedLoad =
    `${title}: the file did not load cleanly — fix the first error and save. After a load with an error the compiler no ` +
    'longer finds declarations and clauses by their lines.';
  const hole = (): TokenColumns => {
    const found = holeTokenAt(lineText, req.pos.character, req.name);
    if (found === undefined) {
      throw unsupported(`${title} needs the cursor on the hole ?${req.name}.`);
    }
    return found;
  };
  const edit = (...replacements: TextReplacement[]): EditResult => ({ type: 'edit', replacements });
  const text1 = (payload: ReplyPayload, apply: (answer: string) => EditResult): EditResult => {
    const answer = decodeText(payload);
    return answer.kind === 'ok' ? apply(answer.value.text) : failed(answer.message);
  };
  const refuse = (problem: string | undefined): void => {
    if (problem !== undefined) {
      throw unsupported(problem);
    }
  };
  // The compiler reads a raw line only up to a NUL (`f n = ?h -- a<NUL>b` split into `… -- a` lines
  // [live, M4 security review]): Case Split and Make Case, which replace that line, would drop the rest.
  const nulProblem = (): string | undefined =>
    lineText.includes('\u0000') ? `${title}: this line holds a NUL character, which the compiler drops together with the text after it. Remove it first.` : undefined;
  switch (req.kind) {
    case 'caseSplit': {
      refuse(numberingProblem(text, line, title, false));
      refuse(nulProblem());
      const code = codeLine(text, line);
      if (code === undefined || !hasHoleToken(code.code)) {
        throw unsupported(
          `${title}: this line has no hole to split on. The compiler rewrites the cursor's line only, so the clause must be on it, ` +
            'its right-hand side a hole ?name.',
        );
      }
      if (levelTokens(code.code, true).some((t) => t.kind === 'symbol' && t.text === ';')) {
        throw unsupported(
          `${title}: this line holds clauses or case alternatives separated by ;, and the compiler would repeat the whole line for each constructor. ` +
            'Put each alternative on a line of its own.',
        );
      }
      refuse(caseLineProblem(lineText, code.code, title));
      if (namesAsPattern(lineText, req.pos.character)) {
        throw unsupported(
          `${title}: ${req.name} names an as-pattern, and the compiler does not rewrite the name before an @, so it would repeat the clause unchanged. ` +
            'Split a variable of the pattern after the @ instead.',
        );
      }
      // Its more indented lines: by their first token's column and the comments and strings the clause opens (`entryEnd`),
      // and by the column of the next token below, also one after a block comment opened above (`{- c` / `-} * 2`).
      const entry = entryAt(text, line);
      const clauseColumn = firstTokenColumn(code.code, openAt(text, line));
      const below = nextTokenColumn(text, line);
      const continued = typeof clauseColumn === 'number' && below !== undefined && (below === 'string' || below > clauseColumn);
      if ((entry !== undefined && entryEnd(text, line, entry.indent) > line) || continued) {
        throw unsupported(
          `${title} is not available on a clause with more indented lines below it (a where block): the compiler rewrites this line only, ` +
            'so those lines would belong to the last new clause alone.',
        );
      }
      const at = toIdeCaseSplitRequest(text, req.pos);
      if (at === undefined) {
        throw unsupported(`${title} needs the cursor on a pattern variable in Idris code.`);
      }
      return {
        ...plain,
        command: caseSplit(at, req.name),
        afterFailedLoad,
        readsDisk: true,
        decode: (payload) => text1(payload, (answer) => edit({ range: linesRange(text, line, line), text: splitLines(text, line, answer, title) })),
      };
    }
    case 'addClause':
    case 'generateDef': {
      const declaration = declarationAt(text, line, req.name);
      if (declaration === undefined) {
        throw unsupported(`${title} needs the cursor on the type declaration of ${req.name} (a line ${req.name} : …).`);
      }
      refuse(severalNames(declaration, title));
      refuse(numberingProblem(text, declaration.start, title, true));
      if (req.kind === 'generateDef') {
        refuse(openAtEndProblem(text, declaration.end, title));
        return {
          ...plain,
          command: generateDef(toIdeLineRequest(text, declaration.start), req.name),
          afterFailedLoad,
          long: true,
          starts: 'generateDef',
          decode: (payload) =>
            text1(payload, (answer) => {
              refuse(shadowProblem(answer, text.style, title));
              return edit(insertAfter(text, declaration.end, retabbed(answer, indentationOf(text, declaration.start)).split('\n')));
            }),
        };
      }
      // After the function's clauses: the compiler's clause binds a variable for every explicit
      // argument, so above them it would make them unreachable.
      const after = clausesEnd(text, declaration, req.name, title) ?? declaration.end;
      refuse(openAtEndProblem(text, after, title));
      return {
        ...plain,
        command: addClause(toIdeLineRequest(text, declaration.start), req.name),
        afterFailedLoad,
        decode: (payload) =>
          text1(payload, (answer) => {
            refuse(shadowProblem(answer, text.style, title));
            return edit(insertAfter(text, after, [addedClause(text, declaration.start, retabbed(answer, indentationOf(text, declaration.start)), title)]));
          }),
      };
    }
    case 'makeLemma': {
      const at = hole();
      refuse(layoutProblem(text, line, at, title));
      if (text.style !== undefined && text.style !== 'bird') {
        throw unsupported(`${title} is not available in a literate file with code blocks: where its lemma goes depends on the blocks, which are not read here.`);
      }
      const place = lemmaPlace(text, line, title);
      if (typeof place === 'string') {
        throw unsupported(place);
      }
      // The application calls the lemma by the hole's name: a local of that name in scope at the hole
      // (a where function, a pattern or let variable) would take the call [live, M4 edit review:
      // `S (go x)` called the where-local `go`; `f k y = k y k` did not check].
      if (namesIn(text, place.line, place.end).has(req.name)) {
        throw unsupported(
          `${title} names the lemma after the hole, and ${req.name} is also a name in this definition: a local function or variable ` +
            'of that name would take the call. Rename the hole or that name first.',
        );
      }
      return {
        ...plain,
        long: true,
        hole: at,
        command: makeLemma(toIdeSourceLineRequest(line), req.name),
        decode: (payload) => {
          const answer = decodeLemma(payload);
          if (answer.kind === 'error') {
            return failed(answer.message);
          }
          const lemma = indentedLemma(answer.value.lemma, place, markerOf(codeLine(text, line)));
          if (lemma === undefined) {
            throw unsupported(`${title}: the compiler's answer has a form that was not expected here, so it was not applied.`);
          }
          if (passesUnnamed(text, place.line, line, answer.value.application)) {
            throw unsupported(
              `${title}: the lemma would take a value that the compiler named itself and no code can name — an unnamed constraint ` +
                '(Show a =>) or the argument of \\case —, so nothing was applied. Give it a name first: {auto s : Show a} ->, or \\x => case x of.',
            );
          }
          // A `_` in the type is a value bound by `_` that other locals' types use (`{_ : Nat} -> Vect _
          // Nat -> Nat`): nothing ties the two, and the call does not check (`Unsolved holes` [live]).
          if (levelTokens(answer.value.lemma, true).some((t) => t.kind === 'name' && t.text === '_')) {
            throw unsupported(
              `${title}: the lemma's type would depend on a value bound by _, which it cannot name, so nothing was applied. ` +
                'Name that value first, e.g. (n ** v) or g n xs.',
            );
          }
          const args = lemmaArguments(answer.value.application);
          if (new Set(args).size !== args.length) {
            throw unsupported(
              `${title}: the lemma would take two locals of one name, one shadowing the other, and the call would pass the inner one twice, ` +
                'so nothing was applied. Rename one of them first.',
            );
          }
          const start: EditorPosition = { line: place.line, character: 0 };
          return edit({ range: { start, end: start }, text: `${lemma}\n\n` }, atHole(line, at, inPlace(answer.value.application, title, lineText.slice(0, at.start), lineText.slice(at.end))));
        },
      };
    }
    case 'makeCase': {
      const at = hole();
      refuse(nulProblem());
      if (lineText.indexOf(`?${req.name}`) !== at.start) {
        throw unsupported(`${title} rewrites the first ?${req.name} of the line, and this line has that text before the hole at the cursor.`);
      }
      refuse(layoutProblem(text, line, at, title));
      // The compiler's answer, as IDE mode sends it: each line after the marker of a marked line and a
      // space (`relit`, `IDEMode/REPL.idr` 389–391 [src]).
      const marker = markerOf(codeLine(text, line));
      const sent = (lines: readonly string[]): string => lines.map((l) => (marker === undefined ? l : `${marker} ${l}`)).join('\n');
      const [first, second] = madeCase(lineText, at, req.name, true);
      return {
        ...plain,
        command: makeCase(toIdeSourceLineRequest(line), req.name),
        decode: (payload) =>
          text1(payload, (answer) => {
            if (answer !== sent([first, second]) && answer !== sent(madeCase(lineText, at, req.name, false))) {
              throw unsupported(`${title}: the compiler's answer has an unexpected form; nothing was applied.`);
            }
            // The new line gets the marker in place of its first spaces, and the tabs of the code before
            // the hole back (`retabbed`); the first line is the raw line, rewritten.
            const marked = marker === undefined ? second : marker + second.slice(marker.length);
            return edit({ range: linesRange(text, line, line), text: retabbed(`${first}\n${marked}`, lineText.slice(0, at.start).replace(/[^\t]/gu, ' ')) });
          }),
      };
    }
    case 'makeWith': {
      const at = hole();
      const first = withClauseStart((l) => codeLine(text, l), line, at);
      if (first === undefined) {
        throw unsupported(
          `${title} needs a function clause whose right-hand side is the hole alone, after an = that is the first = of its line outside brackets.`,
        );
      }
      // The compiler copies line `first` up to its `=`, read only up to a NUL (`f x {- a<NUL>b -} = ?h` gave
      // `f x {- awith (_)`, its `{-` left open [live, M4's review of the decisions]); the text after the
      // hole is put back from the editor's line.
      if ((first === line ? lineText.slice(0, at.start) : text.lines[first]).includes('\u0000')) {
        throw unsupported(`${title}: the clause's left-hand side holds a NUL character, which the compiler drops together with the text after it. Remove it first.`);
      }
      if (hasHole(text, `${req.name}_rhs`)) {
        throw unsupported(`${title} names its new hole ?${req.name}_rhs, and the file already has a hole of that name, which the next check would report twice. Rename that hole first.`);
      }
      return {
        ...plain,
        command: makeWith(toIdeSourceLineRequest(first), req.name),
        // The compiler's answer keeps line `first` up to its `=` only: a comment after the hole is
        // put back at the end of the answer's first line.
        decode: (payload) =>
          text1(payload, (answer) => withLines(text, first, line, retabbed(spacedWith(answer), indentationOf(text, first)), title, lineText.slice(at.end).trim())),
      };
    }
    case 'exprSearch': {
      const at = hole();
      refuse(layoutProblem(text, line, at, title));
      return {
        ...plain,
        hole: at,
        command: proofSearch(lineRequest, req.name, req.hints.map((h) => (isOperatorInParentheses(h) ? h.slice(1, -1) : h))),
        long: true,
        starts: 'exprSearch',
        decode: (payload) => text1(payload, (answer) => edit(atHole(line, at, inPlace(answer, title, lineText.slice(0, at.start), lineText.slice(at.end))))),
      };
    }
    case 'intro': {
      const at = hole();
      refuse(layoutProblem(text, line, at, title));
      return {
        ...plain,
        long: true,
        hole: at,
        command: intro(lineRequest, req.name),
        decode: (payload) => {
          const answer = decodeIntro(payload);
          if (answer.kind === 'error') {
            return failed(answer.message);
          }
          // A candidate wider than 80 columns comes laid out over lines (`show . pretty`,
          // `Idris/REPL.idr` 518, at `defaultLayoutOptions`; the `line` and `softline` of a pair or a
          // lambda, `Idris/Pretty.idr` [src]; `\arg =>` / `?h_0` [live, M4 edit review]): the next
          // lines start at column 0, without a literate marker. One expression, so one line again.
          const usable = answer.value.filter((candidate) => !bindsQualifiedName(candidate));
          if (usable.length === 0 && answer.value.length > 0) {
            throw unsupported(
              `${title}: the compiler offered only a lambda whose argument has a qualified name, which does not check (it answers so for a hole ` +
                'applied to arguments), so nothing was applied.',
            );
          }
          const choices: EditChoice[] = usable.map((candidate) => {
            const c = joinedLines(candidate);
            return { label: c, replacements: [atHole(line, at, inPlace(c, title, lineText.slice(0, at.start), lineText.slice(at.end)))] };
          });
          return { type: 'choices', reason: 'intro', choices };
        },
      };
    }
    case 'refine': {
      const at = hole();
      refuse(layoutProblem(text, line, at, title));
      return {
        ...plain,
        hole: at,
        command: refine(lineRequest, req.name, req.hint),
        long: true,
        decode: (payload) => {
          const answer = decodeText(payload);
          if (answer.kind === 'ok') {
            return edit(atHole(line, at, inPlace(answer.value.text, title, lineText.slice(0, at.start), lineText.slice(at.end))));
          }
          const alternatives = isOneName(req.hint) ? decodeAmbiguity(answer.message) : undefined;
          if (alternatives === undefined) {
            return failed(answer.message);
          }
          if (!alternatives.every((a) => isNameApplied(a, req.hint))) {
            throw unsupported(
              `${title}: the name is ambiguous, and the compiler printed alternatives that are not the qualified name followed by its arguments ` +
                `(a binary operator with a fixity is printed between its arguments, as ?h_0 A.(+++) ?h_1, which as source would apply the hole ?h_0), so none is offered: ${alternatives.join('; ')}. ` +
                'Write the application yourself, the qualified name first, e.g. A.(+++) x y.',
            );
          }
          const choices = alternatives.map((a) => ({ label: a, replacements: [atHole(line, at, inPlace(a, title, lineText.slice(0, at.start), lineText.slice(at.end)))] }));
          return { type: 'choices', reason: 'ambiguous', choices };
        },
      };
    }
    case 'addMissingCases': {
      const declaration = declarationAt(text, line, req.name);
      if (declaration === undefined) {
        throw unsupported(`${title} needs the type declaration of ${req.name} (a line ${req.name} : …) at the coverage error.`);
      }
      refuse(severalNames(declaration, title));
      if (inParameters(text, declaration.start)) {
        throw unsupported(`${title} is not available in a parameters block: the compiler's missing cases there also list the block's parameters as patterns.`);
      }
      if (isLocal(text, declaration.start)) {
        throw unsupported(`${title} is not available for a function local to a definition (in a where or let block): the compiler reports on top-level functions only.`);
      }
      const end = clausesEnd(text, declaration, req.name, title) ?? declaration.end;
      refuse(openAtEndProblem(text, end, title));
      const qualified = qualifiedName(text, declaration.start, req.name);
      return {
        ...plain,
        long: true,
        command: missingCases(req.name),
        decode: (payload) => {
          const answer = decodeMissingCases(payload);
          if (answer.kind === 'error') {
            return failed(answer.message);
          }
          const clauses = missingClauses(answer.value, qualified, title);
          if (typeof clauses === 'string') {
            return failed(clauses);
          }
          const own = codeLine(text, declaration.start) ?? { prefix: '', code: '' };
          const indent = layoutIndentation(text, declaration.start);
          const hole = isOperatorInParentheses(req.name) ? 'op' : req.name;
          const k0 = firstMissingCase(text, hole);
          const lines = clauses.map((c, k) => `${own.prefix}${indent}${c} = ?${hole}_missing_case_${k0 + k}`);
          return edit(insertAfter(text, end, lines));
        },
      };
    }
  }
}

/**
 * Why the request `req`, whose plan has the hole token `hole` (`EditPlan.hole`), would not be
 * answered for that hole, from `holes`, the holes of the load it is asked after (`backend.ts`), or
 * `undefined`. The compiler finds such a hole by its name in its whole context, so it answers for
 * the hole it registered under that name: when a load returned an error, possibly another one than
 * the cursor's — the first of two `?h` of a module (`h is already defined`: the second is never
 * registered [live, transcript `dup-holes`]), or an imported module's `?todo` when the loaded
 * module's clause failed [live, M4 edit review]. So the request is sent only when the holes hold
 * exactly one hole of that name and it is located at `hole` in `req`'s document (`clean`: the load
 * returned no error).
 */
export function holeRefusal(req: EditAtRequest | ExprSearchRequest | RefineRequest, hole: TokenColumns, holes: readonly Hole[], clean: boolean): string | undefined {
  const title = TITLES[req.kind];
  const named = holes.filter((h) => h.name === req.name);
  const start = named.length === 1 ? named[0].location : undefined;
  if (start?.uri.fsPath === req.doc.fileName && start.range.start.line === req.pos.line && start.range.start.character === hole.start) {
    return undefined;
  }
  if (named.length > 1) {
    return (
      `${title}: the compiler knows ${named.length} holes named ?${req.name} (in this file and the modules it imports) and finds a hole by its ` +
      'name, so it would not answer for this one. Give this hole a name of its own.'
    );
  }
  return clean
    ? `${title}: the compiler did not report the hole ?${req.name} at this place, so it was not asked. Check the file again and retry.`
    : `${title}: the compiler has not registered this ?${req.name}: the file did not load cleanly. Fix the first error and save.`;
}

/**
 * The missing clauses in a `:missing` answer of the function reported as `qualified`
 * (`qualifiedName`), among the reports of every function of its name in scope (`Prelude.Types.count:
 * All cases covered` / `Edits.count: …` [live]); that report's text when it lists none (all covered,
 * or calls a function that is not covering). Throws `Unsupported` when the answer has no report of
 * it: the others' clauses would be another function's.
 */
function missingClauses(reports: readonly MissingCases[], qualified: string, title: string): readonly string[] | string {
  const own = reports.find((r) => r.name === qualified);
  if (own === undefined) {
    throw unsupported(`${title}: the compiler reported only other functions of this name (in other modules or namespaces), not the one declared here, so nothing was applied.`);
  }
  if (own.kind === 'missing' && own.clauses.length > 0) {
    return own.clauses;
  }
  return own.kind === 'covered'
    ? `${own.name}: All cases covered`
    : own.kind === 'callsNonCovering'
      ? `${own.name}: Calls non covering function ${own.functions.join(', ')}`
      : `${own.name}: no missing clauses`;
}

/**
 * The edit that replaces lines `first` to `last` with a make-with answer for line `first`, repaired
 * for literate markers (`literateRepair`), with `comment` (a line comment, or `''`) at the end of its
 * first line. Throws `Unsupported` when the answer has an unexpected shape or leaves the lines as they
 * are.
 */
function withLines(text: EditText, first: number, last: number, answer: string, title: string, comment = ''): EditResult {
  const lines = literateRepair(text, first, answer.split('\n'));
  if (lines === undefined) {
    throw unsupported(`${title}: the compiler's answer for this literate line has a form that was not expected, so it was not applied.`);
  }
  const replacement = (comment === '' ? lines : [`${lines[0]} ${comment}`, ...lines.slice(1)]).join('\n');
  if (replacement === textIn(text, linesRange(text, first, last))) {
    throw unsupported(`${title}: the compiler left the line as it was.`);
  }
  return { type: 'edit', replacements: [{ range: linesRange(text, first, last), text: replacement }] };
}

/**
 * The plan of `-Next` (`NextRequest`): the next result replaces `previous`, with the line breaks
 * the previous result had at its start and end (a definition inserted at the end of a file starts
 * with one, elsewhere it ends with one), so that it takes the same lines; the compiler's `No more
 * results` is `exhausted`. A next definition gets the tabs of the previous one's first line back
 * (`retabbed`: that line starts with the declaration's indentation); a next proof search result
 * replaces the previous one with the parentheses put around it, and gets its own by the same rule
 * (`inPlace`).
 */
export function planNext(kind: 'exprSearchNext' | 'generateDefNext', text: EditText, previous: EditorRange): EditPlan {
  const before = textIn(text, previous);
  const indent = kind === 'generateDefNext' ? (/^\n?([ \t]*)/u.exec(before)?.[1] ?? '') : '';
  return {
    command: kind === 'exprSearchNext' ? proofSearchNext() : generateDefNext(),
    long: true,
    readsDisk: false,
    decode: (payload) => {
      const answer = decodeText(payload);
      if (answer.kind === 'error') {
        return answer.message === 'No more results' ? { type: 'exhausted' } : failed(answer.message);
      }
      const shadowing = kind === 'generateDefNext' ? shadowProblem(answer.value.text, text.style, 'Next Definition') : undefined;
      if (shadowing !== undefined) {
        throw unsupported(shadowing);
      }
      const result = kind === 'exprSearchNext' ? inPlace(answer.value.text, 'Next Result', (text.lines[previous.start.line] ?? '').slice(0, previous.start.character), (text.lines[previous.end.line] ?? '').slice(previous.end.character)) : retabbed(answer.value.text, indent);
      const framed = `${before.startsWith('\n') ? '\n' : ''}${result}${before.endsWith('\n') && before !== '\n' ? '\n' : ''}`;
      return { type: 'edit', replacements: [{ range: previous, text: framed }] };
    },
  };
}
