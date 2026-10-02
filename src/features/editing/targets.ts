/**
 * What an editing command acts on, read from the document's text with M0's lexer and layout model
 * (`features/syntax/selectionRangeModel.ts`, through M3's `syntaxModelOf`), sending nothing to the
 * compiler (`types.ts`, module comment): the hole at the cursor, the pattern variable at the cursor,
 * the type declaration at the cursor, and the function of a coverage error. The code actions use the
 * same readings (`codeActions.ts`). No `vscode` import: unit-tested on Node.
 *
 * Only the styles M0 models are read — plain source and bird tracks (`isModelledStyle`); in a
 * fenced literate document (`Foo.idr.md`, M12) `isReadable` is false and nothing is found.
 *
 * A token "at" the cursor contains it, or ends there (the cursor right after a name), as M3's
 * `occurrenceAt` counts it. Everything here is syntactic: the compiler has the last word, and its
 * answer says when a reading was wrong.
 */
import { FUNCTION_PRAGMAS, MODIFIER_KEYWORDS, namesAsPattern, RESERVED_INFIX_SYMBOLS } from '../../core/idrisSyntax';
import type { EditorPosition, EditorRange } from '../../core/positions';
import { offsetOf, positionOf, syntaxModelOf, type TextDoc } from '../intelligence/occurrence';
import type { Token } from '../syntax/lexer';
import type { SyntaxModel } from '../syntax/selectionRangeModel';

/** A layout block of the model (a line that starts a layout item and the lines indented deeper). */
type Block = NonNullable<SyntaxModel['blockAtLine'][number]>;

/** A hole at the cursor: its name without `?` and the range of its `?name` token. */
export interface HoleTarget {
  readonly name: string;
  readonly range: EditorRange;
}

/** A pattern variable at the cursor: its name and the range of its token. */
export interface PatternVariableTarget {
  readonly name: string;
  readonly range: EditorRange;
  /**
   * Whether the light bulb offers Case Split on it (`codeActions.ts`): its clause is written on one
   * line, with no more indented lines below it (a `where` block, which the backend refuses), and its
   * right-hand side is nothing but a hole — the clauses the compiler splits and whose reply replaces
   * exactly that line (E15 [live]: it answers `No clause to split here` when the right-hand side is
   * not a bare hole, and on a clause over several lines its reply is not the clause) — and the name
   * does not start with a capital letter: by convention, a capitalised name in a pattern is a
   * constructor; nor does it name an as-pattern (`xs@(…)`, `namesAsPattern`, which the backend
   * refuses). The command itself asks the compiler about any other variable of a left-hand side.
   */
  readonly offered: boolean;
}

/** A type declaration (`name : type`) at the cursor. */
export interface DeclarationTarget {
  /**
   * The declared name as the requests take it: an identifier, or an operator in parentheses,
   * `(<||>)` (`(:add-clause 38 "(<&&>)")` and `(:generate-def 41 "(<||>)")` answered for the
   * operator, and `:missing` parses only this form [live, transcripts `edits-shapes`,
   * `edits-searches`, `edits-names`]). Of a declaration of several names (`a, b : Nat`), the one at
   * the cursor, else the first.
   */
  readonly name: string;
  /** The range of that name (with the parentheses of an operator). */
  readonly nameRange: EditorRange;
  /** The declaration's lines, from its first character to the end of its last line's code. */
  readonly range: EditorRange;
  /**
   * Whether a clause of the name follows at the same layout level (below the declaration, in the
   * same block of declarations): Generate Definition is offered only without one (the compiler
   * answers `Already defined` [live, `edits-names`]).
   */
  readonly hasClauses: boolean;
  /**
   * Whether a `%foreign` or `%extern` pragma is among its options (on its line or the option lines
   * right above it): the function is defined elsewhere, so Add Clause and Generate Definition do not
   * apply (`:add-clause` answers a clause that breaks the next check, `:generate-def` `Already
   * defined` [live, M4 UX review]); the light bulb leaves them out and the commands refuse them.
   */
  readonly foreign: boolean;
  /**
   * Whether it declares several names (`a, b : Nat -> Nat`): there the compiler's `:add-clause` and
   * `:generate-def` answer for the last name whatever the name sent [live, `edits-layout`], so the
   * light bulb offers no action on it and the backend refuses them.
   */
  readonly several: boolean;
  /**
   * Whether it is local to a definition: a block around it holds a clause's `=` or `=>` on its own
   * lines (a `where` or `let` block). `:missing` does not find such a function (`Undefined name go`
   * [live, M4 edit review]), so the light bulb does not offer Add Missing Cases for it.
   */
  readonly local: boolean;
}

/** The part of a diagnostic `coverageFunctionOf` reads; `vscode.Diagnostic` satisfies it. */
export interface DiagnosticLike {
  readonly range: EditorRange;
  readonly message: string;
  readonly source?: string;
}

/** Whether the document is in a style this module reads (plain source or bird tracks). */
export function isReadable(doc: TextDoc): boolean {
  return syntaxModelOf(doc) !== undefined;
}

// -------------------------------------------------------------------------------------------
// Tokens and blocks
// -------------------------------------------------------------------------------------------

const isComment = (t: Token): boolean => t.kind === 'comment' || t.kind === 'docComment';

/** The keywords whose blocks declare constructors, fields or methods, not functions with clauses. */
const TYPE_DECLARATION_KEYWORDS: ReadonlySet<string> = new Set(['data', 'record', 'interface']);

/** An operator a declaration or clause can define: `isOpChar` symbols that are not reserved syntax. */
function isOperator(t: Token): boolean {
  return t.kind === 'symbol' && !',;_`'.includes(t.text) && !RESERVED_INFIX_SYMBOLS.has(t.text);
}

/** `=` or `=>`: what ends a clause's left-hand side (a function clause, a `with` or `case` alternative). */
const isSeparator = (t: Token): boolean => t.kind === 'symbol' && (t.text === '=' || t.text === '=>');

/** The index of the first token that starts at or after `offset`. */
function firstTokenFrom(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start < offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The token at `offset` that `accept` takes (module comment): the one that contains `offset`, else
 * the one that ends there — so that the cursor between `?h` and `)` is on the hole.
 */
function tokenAt(tokens: readonly Token[], offset: number, accept: (t: Token) => boolean): Token | undefined {
  const last = firstTokenFrom(tokens, offset + 1) - 1;
  const containing = last >= 0 && offset < tokens[last].end ? tokens[last] : undefined;
  if (containing !== undefined && accept(containing)) {
    return containing;
  }
  const ending = tokens[containing === undefined ? last : last - 1];
  return ending !== undefined && ending.end === offset && accept(ending) ? ending : undefined;
}

/**
 * The tokens of `block` from its first one up to `end`, comments excluded; with `sameLevel`, only
 * those at the block's own bracket level (not inside a group opened in it).
 */
function tokensOf(model: SyntaxModel, block: Block, end: number, sameLevel: boolean): Token[] {
  const tokens: Token[] = [];
  const level = block.firstToken.outer;
  for (let i = firstTokenFrom(model.tokens, block.firstToken.start); i < model.tokens.length && model.tokens[i].start < end; i++) {
    const t = model.tokens[i];
    if (!isComment(t) && (!sameLevel || t.outer === level)) {
      tokens.push(t);
    }
  }
  return tokens;
}

/** The tokens of the whole block, its deeper-indented lines included, at its bracket level. */
const levelTokens = (model: SyntaxModel, block: Block): Token[] => tokensOf(model, block, block.range.end, true);

/** Where the block's own lines end: at its first nested block, else at its end. */
const ownEnd = (block: Block): number => (block.children.length > 0 ? block.children[0].firstToken.start : block.range.end);

const rangeOf = (model: SyntaxModel, start: number, end: number): EditorRange => ({
  start: positionOf(model, start),
  end: positionOf(model, end),
});

/** The model and the block of `line`, when `line` belongs to one (not a blank line after it). */
function blockOfLine(doc: TextDoc, line: number): { readonly model: SyntaxModel; readonly block: Block } | undefined {
  const model = syntaxModelOf(doc);
  const block = model?.blockAtLine[line];
  return model === undefined || block === undefined || line > block.lastLine ? undefined : { model, block };
}

// -------------------------------------------------------------------------------------------
// Names a declaration or a clause defines (after `signatureNames`, `clauseName` in
// selectionRangeModel.ts, which reads the same `localClaim`/`tyDecls` shapes of Parser.idr)
// -------------------------------------------------------------------------------------------

/** A declared name: `text` as the clauses spell it (`<||>`), `sent` as the requests take it (`(<||>)`). */
interface DeclaredName {
  readonly text: string;
  readonly sent: string;
  readonly start: number;
  readonly end: number;
}

/**
 * A declarable name at `level[i]`: an unqualified identifier, or `(op)` — three tokens of `all`,
 * two of `level` (the operator sits one level deeper). `next` is the index in `level` after it.
 */
function declarableName(level: readonly Token[], i: number, all: readonly Token[]): { readonly name: DeclaredName; readonly next: number } | undefined {
  const token = level[i];
  if (token === undefined) {
    return undefined;
  }
  if (token.kind === 'ident' && !token.text.includes('.')) {
    return { name: { text: token.text, sent: token.text, start: token.start, end: token.end }, next: i + 1 };
  }
  const group = token.delimits;
  if (token.kind !== 'groupOpen' || token.text !== '(' || group?.close === undefined) {
    return undefined;
  }
  const k = firstTokenFrom(all, token.start);
  const op = all[k + 1];
  if (op === undefined || !isOperator(op) || all[k + 2] !== group.close) {
    return undefined;
  }
  return { name: { text: op.text, sent: `(${op.text})`, start: token.start, end: group.close.end }, next: i + 2 };
}

/** The names a type signature declares, or `undefined` when `level` is not one. */
function signatureNames(level: readonly Token[], all: readonly Token[]): DeclaredName[] | undefined {
  let i = 0;
  while (i < level.length && isOption(level[i])) {
    i++;
  }
  if (i < level.length && level[i].kind === 'number' && (level[i].text === '0' || level[i].text === '1')) {
    i++;
  }
  const names: DeclaredName[] = [];
  for (;;) {
    const found = declarableName(level, i, all);
    if (found === undefined) {
      return undefined;
    }
    names.push(found.name);
    const sep = level[found.next];
    if (sep?.kind === 'symbol' && sep.text === ',') {
      i = found.next + 1;
      continue;
    }
    return sep?.kind === 'symbol' && sep.text === ':' ? names : undefined;
  }
}

/**
 * The token a clause's left-hand side `lhs` (its tokens at the clause's level) defines: a
 * backticked infix name, else its first operator, else its first token.
 */
function definedToken(lhs: readonly Token[]): Token | undefined {
  for (let i = 0; i + 2 < lhs.length; i++) {
    if (lhs[i].text === '`' && lhs[i + 1].kind === 'ident' && lhs[i + 2].text === '`') {
      return lhs[i + 1];
    }
  }
  return lhs.find(isOperator) ?? lhs[0];
}

/** The name a clause at `level` defines (as a declaration's `text` spells it), or `undefined`. */
function clauseName(level: readonly Token[], all: readonly Token[]): string | undefined {
  const sep = level.findIndex((t) => t.kind === 'keyword' || isSeparator(t));
  const end = level[sep];
  if (sep <= 0 || (end.kind === 'keyword' && end.text !== 'with' && end.text !== 'impossible')) {
    return undefined;
  }
  const lhs = level.slice(0, sep);
  const defined = definedToken(lhs);
  if (defined === lhs[0]) {
    return declarableName(lhs, 0, all)?.name.text;
  }
  return defined?.text;
}

/** The blocks at the same layout level as `block` (its parent's children, or the top-level ones). */
function siblingsOf(model: SyntaxModel, block: Block): readonly Block[] {
  if (block.parent !== undefined) {
    return block.parent.children;
  }
  const roots: Block[] = [];
  for (const b of model.blockAtLine) {
    let top = b;
    while (top?.parent !== undefined) {
      top = top.parent;
    }
    if (top !== undefined && roots[roots.length - 1] !== top) {
      roots.push(top);
    }
  }
  return roots;
}

/** Whether a block around `block` holds a `=` or `=>` on its own lines: `block` is local to a definition. */
function inDefinition(model: SyntaxModel, block: Block): boolean {
  for (let p = block.parent; p !== undefined; p = p.parent) {
    if (tokensOf(model, p, ownEnd(p), true).some(isSeparator)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a block around `line` (its own included) starts with the keyword `keyword`, after
 * modifiers (`public export interface …`): the backend refuses Make Lemma in an `interface` and Add
 * Missing Cases in a `parameters` block (`backend/ide/edits.ts` `lemmaPlace`, `inParameters`), so
 * the light bulb does not offer them there.
 */
export function inBlockOf(doc: TextDoc, line: number, keyword: 'interface' | 'parameters'): boolean {
  const found = blockOfLine(doc, line);
  for (let block = found?.block; found !== undefined && block !== undefined; block = block.parent) {
    const first = levelTokens(found.model, block).find((t) => t.kind !== 'keyword' || !MODIFIER_KEYWORDS.has(t.text));
    if (first?.kind === 'keyword' && first.text === keyword) {
      return true;
    }
  }
  return false;
}

/** A modifier keyword or a function-option pragma (`isOptionLine` of `core/idrisSyntax.ts`). */
const isOption = (t: Token | undefined): boolean =>
  (t?.kind === 'keyword' && MODIFIER_KEYWORDS.has(t.text)) || (t?.kind === 'pragma' && FUNCTION_PRAGMAS.has(t.text));

/** The pragmas of a function defined outside Idris. */
const FOREIGN_PRAGMAS: ReadonlySet<string> = new Set(['%foreign', '%extern']);

/**
 * Whether the signature `sig` has a `%foreign` or `%extern` option (`DeclarationTarget.foreign`): on
 * its own line, or on the blocks right before it that start with an option and hold no `:` (`public
 * export`, `%foreign "C:puts,libc"`, continued on more indented lines or not).
 */
function isForeign(model: SyntaxModel, sig: Block): boolean {
  const siblings = siblingsOf(model, sig);
  const blocks = [sig];
  for (let i = siblings.indexOf(sig) - 1; i >= 0; i--) {
    const level = levelTokens(model, siblings[i]);
    if (!isOption(level[0]) || level.some((t) => t.kind === 'symbol' && t.text === ':')) {
      break;
    }
    blocks.push(siblings[i]);
  }
  return blocks.some((b) => levelTokens(model, b).some((t) => t.kind === 'pragma' && FOREIGN_PRAGMAS.has(t.text)));
}

/** Whether `block` lies in a `data`, `record` or `interface` declaration (constructors, fields, methods). */
function inTypeDeclaration(model: SyntaxModel, block: Block): boolean {
  for (let p = block.parent; p !== undefined; p = p.parent) {
    if (tokensOf(model, p, ownEnd(p), true).some((t) => t.kind === 'keyword' && TYPE_DECLARATION_KEYWORDS.has(t.text))) {
      return true;
    }
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// Targets
// -------------------------------------------------------------------------------------------

/** The hole at `pos`: a `hole` token of the lexer (`?name`), in code only. */
export function holeAt(doc: TextDoc, pos: EditorPosition): HoleTarget | undefined {
  const model = syntaxModelOf(doc);
  const token = model === undefined ? undefined : tokenAt(model.tokens, offsetOf(model, pos), (t) => t.kind === 'hole');
  if (model === undefined || token === undefined) {
    return undefined;
  }
  return { name: token.text.slice(1), range: rangeOf(model, token.start, token.end) };
}

/**
 * Whether `block` is an alternative of a `case … of` or `\case` whose alternatives start on the
 * lines below it: the tokens of its parent's own lines end with `of` or `\case`.
 */
function isCaseAlternative(model: SyntaxModel, block: Block): boolean {
  const own = block.parent === undefined ? [] : tokensOf(model, block.parent, ownEnd(block.parent), false);
  const [before, last] = own.slice(-2);
  return last?.kind === 'keyword' && (last.text === 'of' || (last.text === 'case' && before?.kind === 'symbol' && before.text === '\\'));
}

/**
 * The pattern variable at `pos`: an unqualified identifier in the left-hand side of a clause — the
 * tokens before the clause's first `=` or `=>` at its own bracket level, found in the innermost
 * enclosing block that has one — that is not the name the clause defines (in a case alternative
 * (`isCaseAlternative`), which defines none, not the head of a constructor application, `Just` of
 * `Just y`; Make Case's `case_val` is a variable), in a left-hand side with
 * no keyword (not a `let`, `data` or `record`) and no `:` (not a signature), not starting with `\`
 * (a lambda on a line of its own, `f =` / `  \x => ?h`: the compiler answers `No clause to split
 * here` [live, fifth review of M4]). A clause's left-hand side may go over several lines (`step m` /
 * `n` / `= ?step_rhs`): its continuation lines are blocks nested in the clause's.
 */
export function patternVariableAt(doc: TextDoc, pos: EditorPosition): PatternVariableTarget | undefined {
  const found = blockOfLine(doc, pos.line);
  if (found === undefined) {
    return undefined;
  }
  const { model } = found;
  const token = tokenAt(model.tokens, offsetOf(model, pos), (t) => t.kind === 'ident' && !t.text.includes('.'));
  if (token === undefined) {
    return undefined;
  }
  for (let block: Block | undefined = found.block; block !== undefined; block = block.parent) {
    const level = levelTokens(model, block);
    const sep = level.findIndex(isSeparator);
    if (sep < 0) {
      continue;
    }
    const separator = level[sep];
    const lhs = level.slice(0, sep);
    // A case alternative defines nothing: only the head of a constructor application is no variable.
    const defined = isCaseAlternative(model, block) ? (lhs.length > 1 && !isOperator(lhs[1]) ? lhs[0] : undefined) : definedToken(lhs);
    if (
      token.start >= separator.start ||
      lhs.some((t) => t.kind === 'keyword' || (t.kind === 'symbol' && t.text === ':')) ||
      (lhs[0]?.kind === 'symbol' && lhs[0].text === '\\') ||
      defined === token
    ) {
      return undefined;
    }
    const own = tokensOf(model, block, ownEnd(block), false);
    const rhs = own.slice(own.indexOf(separator) + 1);
    const line = positionOf(model, block.firstToken.start).line;
    const oneLine = own.every((t) => positionOf(model, t.end).line === line);
    const range = rangeOf(model, token.start, token.end);
    const offered =
      oneLine &&
      block.children.length === 0 &&
      own.includes(separator) &&
      rhs.length === 1 &&
      rhs[0].kind === 'hole' &&
      !/^[\p{Lu}\p{Lt}]/u.test(token.text) &&
      !namesAsPattern(doc.lineAt(range.start.line).text, range.start.character);
    return { name: token.text, range, offered };
  }
  return undefined;
}

/**
 * Whether the clause at `pos` — the innermost block around `pos`'s line with a `=` or `=>` at its
 * level, as `patternVariableAt` finds it — starts on a line above that `=` or `=>`: its left-hand
 * side goes over several lines. The model makes a deeper-indented line a block of its own, so the
 * clause also starts above when that block continues its parent's line: the parent's tokens before
 * it hold no `=`, `=>` or keyword (nothing that opens a layout block: `where`, `of`, `let`, `do`, …).
 * Case Split and Make With rewrite one line of such a clause and leave broken code (`  0 =
 * ?above_rhs_0`, `  y with (_)` for `above x` / `  y = ?above_rhs` [live, transcript
 * `edits-layout`]), so the commands refuse it.
 */
export function lhsStartsAbove(doc: TextDoc, pos: EditorPosition): boolean {
  const found = blockOfLine(doc, pos.line);
  if (found === undefined) {
    return false;
  }
  const { model } = found;
  for (let block: Block | undefined = found.block; block !== undefined; block = block.parent) {
    const separator = levelTokens(model, block).find(isSeparator);
    if (separator === undefined) {
      continue;
    }
    if (positionOf(model, separator.start).line > positionOf(model, block.firstToken.start).line) {
      return true;
    }
    const parent = block.parent;
    return parent !== undefined && !tokensOf(model, parent, block.firstToken.start, true).some((t) => isSeparator(t) || t.kind === 'keyword');
  }
  return false;
}

/**
 * The type declaration at `pos`: the innermost block around `pos`'s line whose tokens form a type
 * signature (optional visibility, totality and function-option pragmas, an optional 0 or 1, one or
 * more names separated by commas, `:`), going out through the deeper-indented lines a signature
 * continues on, but not out of a definition (a block with `=`); not the constructors, fields and
 * methods of a `data`, `record` or `interface`.
 */
export function declarationAt(doc: TextDoc, pos: EditorPosition): DeclarationTarget | undefined {
  const found = blockOfLine(doc, pos.line);
  if (found === undefined) {
    return undefined;
  }
  const { model } = found;
  for (let block: Block | undefined = found.block; block !== undefined; block = block.parent) {
    const level = levelTokens(model, block);
    const names = signatureNames(level, model.tokens);
    if (names === undefined) {
      if (level.some((t) => t.kind === 'symbol' && t.text === '=')) {
        return undefined;
      }
      continue;
    }
    if (inTypeDeclaration(model, block)) {
      return undefined;
    }
    const offset = offsetOf(model, pos);
    const name = names.find((n) => n.start <= offset && offset <= n.end) ?? names[0];
    const sig = block;
    const hasClauses = siblingsOf(model, sig).some(
      (b) => b.headerLine > sig.lastLine && clauseName(levelTokens(model, b), model.tokens) === name.text,
    );
    return {
      name: name.sent,
      nameRange: rangeOf(model, name.start, name.end),
      range: rangeOf(model, sig.firstToken.start, sig.range.end),
      hasClauses,
      foreign: isForeign(model, sig),
      several: names.length > 1,
      local: inDefinition(model, block),
    };
  }
  return undefined;
}

/**
 * Whether `diagnostic` is the compiler's coverage error that lists missing cases (`… is not
 * covering.` with a `Missing cases:` block, which the diagnostics keep, ARCHITECTURE §8 [live,
 * transcript `part-editing`]) in the `idris2` collection.
 */
export function isMissingCasesDiagnostic(diagnostic: DiagnosticLike): boolean {
  return diagnostic.source === 'idris2' && /^Missing cases:/mu.test(diagnostic.message);
}

/**
 * The function whose missing cases `diagnostic` lists: the declaration at the start of its range
 * (the compiler puts the error on the type declaration [live, `part-editing`: `g : Nat -> Nat` at
 * (2 0)–(2 14)]), not a name read from the message.
 */
export function coverageFunctionOf(doc: TextDoc, diagnostic: DiagnosticLike): DeclarationTarget | undefined {
  return isMissingCasesDiagnostic(diagnostic) ? declarationAt(doc, diagnostic.range.start) : undefined;
}
