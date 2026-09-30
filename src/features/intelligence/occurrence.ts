/**
 * Which name the editor position is on, and which tokens of a file's `TokenIndex` still describe
 * the text the editor shows. Shared by the hover, **Type at Cursor**, **Docs at Cursor**, Go to
 * Definition, the semantic tokens and the document highlights. No `vscode` import (the document is
 * read through `TextDoc`, which `vscode.TextDocument` satisfies), so it is unit-tested on Node.
 *
 * **Stale tokens.** A token index describes the file as the load that produced it read it
 * (`TokenIndex.text`, `backend/types.ts`). While the document shows exactly that text with no
 * unsaved changes — also after an undo or a revert back to it, which VS Code counts as a new
 * version (`indexDescribes`) — every token applies. Otherwise — unsaved changes, a file changed on
 * disk and not checked since, one closed and opened again after it changed — the index's text is
 * compared with the document's by lines (`currentTokens`, `core/positions.ts`
 * `lineCorrespondence`: a line diff): the tokens on unchanged lines are kept, moved to where those
 * lines are now, and on a line edited in place a single-line token is kept where the document shows
 * exactly the text the index had at its range, not continued by a neighbouring character; the
 * tokens on lines of a change that inserted or deleted lines are dropped. So typing does not drop
 * the keywords, literals and comments of the whole file until the next save, nor the names below an
 * inserted line (second review of M3: after one keystroke every keyword, the module token and every
 * unnamed literal were dropped, their colours falling back to the grammar's until the save, and an
 * empty line inserted at line 1,000 of the 2,000-line module kept 333 of the 8,325 tokens below it),
 * nor those between two separate edits, which until the fourth review of M3 were compared with the
 * line of the same number — another line once lines were inserted or deleted above — so that 126 of
 * the 136 tokens of a probe were dropped and tokens that moved were kept at their old places, their
 * inlay hints drawn on a neighbouring line [unit-level, the reviewer's probes]. Carried over by text, a token keeps the meaning the last load
 * gave it: an edit that changes how the text around it reads (a `{-` typed above it) is seen at the
 * next load. When the index's text is not known, only the named tokens that the document still spells
 * at their range as a whole token are kept. What is dropped falls back to what VS Code shows without
 * this extension's answer (the grammar's colours, the word-based highlights).
 */
import type { Decor, Token, TokenIndex } from '../../backend/types';
import { lineCorrespondence, type EditorPosition, type EditorRange } from '../../core/positions';
import { literateStyleOf, type CompiledDocument } from '../../project/literate';
import { buildSyntaxModel, isModelledStyle, type SyntaxModel } from '../syntax/selectionRangeModel';
import type { Token as LexToken } from '../syntax/lexer';

/** The part of a document these functions read; `vscode.TextDocument` satisfies it. */
export interface TextDoc extends CompiledDocument {
  readonly uri: { readonly scheme: string; toString(): string };
  readonly version: number;
  readonly isDirty: boolean;
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
  getText(): string;
}

/** A name in the document: the range it covers there and the name to ask the compiler about. */
export interface Occurrence {
  readonly range: EditorRange;
  /** Unqualified (`index`, `::`), as the compiler's requests take it. */
  readonly name: string;
  /** The compiler's decoration, when the occurrence is a token of the index. */
  readonly decor?: Decor;
  /**
   * The token's namespace (`Token.namespace`) when the occurrence is a token of the index and it is
   * not empty: on a reference, the namespace of the name it refers to (F33); for Go to Definition.
   */
  readonly namespace?: string;
}

/**
 * `reservedInfixSymbols` in `src/Parser/Lexer/Source.idr` (v0.8.0 and master 1c630e6 [src]; the
 * same list as `features/syntax/selectionRangeModel.ts`): symbols that are syntax, never a name.
 */
const RESERVED_SYMBOLS: ReadonlySet<string> = new Set([
  '%', '\\', ':', '=', ':=', '$=', '|', '|||', '<-', '->', '=>', '?', '!', '&', '**', '..', '~', '@',
]);

/** `isOpChar` in `src/Core/Name.idr` [src], as `features/syntax/lexer.ts` has it. */
const OPERATOR = /^[:!#$%&*+./<=>?@\\^|\-~]+$/;

function compare(a: EditorPosition, b: EditorPosition): number {
  return a.line - b.line || a.character - b.character;
}

/** The text of a single-line `range` of `doc`; `undefined` for a range over several lines. */
export function textAt(doc: TextDoc, range: EditorRange): string | undefined {
  if (range.start.line !== range.end.line || range.start.line < 0 || range.start.line >= doc.lineCount) {
    return undefined;
  }
  return doc.lineAt(range.start.line).text.slice(range.start.character, range.end.character);
}

/**
 * Whether `text` is an occurrence of the unqualified `name`: the name itself, the name
 * parenthesised or backticked (an operator's token covers its parentheses: `(|+|)` [live,
 * transcript `shapes-lookups`]), or a qualified reference to it (`Data.Vect.index`).
 */
export function spells(text: string | undefined, name: string): boolean {
  if (text === undefined) {
    return false;
  }
  const bare = text.length > 2 && ((text.startsWith('(') && text.endsWith(')')) || (text.startsWith('`') && text.endsWith('`')))
    ? text.slice(1, -1)
    : text;
  return bare === name || (bare.endsWith(`.${name}`) && /^[\p{L}_]/u.test(bare));
}

/** An identifier character (`isIdentTrailing` in `src/Parser/Lexer/Common.idr`: letters, digits, `_`, `'`, and every character above U+00A0 [src]). */
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_']/.test(c) || c.charCodeAt(0) > 0xa0;

/**
 * Whether `c` would continue a token whose character next to it is `edge`: an identifier
 * character next to an identifier character (a number's digits too), an operator character next
 * to an operator (`isOpChar`); nothing continues a bracket, a quote or other punctuation.
 */
function continues(c: string, edge: string): boolean {
  if (c === '') {
    return false;
  }
  if (OPERATOR.test(edge)) {
    return OPERATOR.test(c);
  }
  return isIdentChar(edge) && isIdentChar(c);
}

/** Per index, the document version last compared with its text and whether they matched. */
const describedVersions = new WeakMap<TokenIndex, { readonly doc: TextDoc; readonly version: number; readonly describes: boolean }>();

/**
 * Whether `doc` shows the text `index` was made from (module comment, *Stale tokens*): no unsaved
 * changes, and exactly the index's text (compared once per document and version), but for a
 * byte order mark at its start, which the file read from disk has and VS Code 1.139.1 reads as the
 * encoding `utf8bom` ("UTF-8 with BOM" [src, the workbench bundle]) rather than as the document's
 * text [not run]. Not the version alone: VS Code numbers a
 * document opened again from 1, so an index of the file as it was before it was closed and changed
 * would match (*review of M3*).
 */
export function indexDescribes(doc: TextDoc, index: TokenIndex): boolean {
  if (doc.isDirty || index.text === undefined) {
    return false;
  }
  const known = describedVersions.get(index);
  if (known !== undefined && known.doc === doc && known.version === doc.version) {
    return known.describes;
  }
  const describes = doc.getText() === index.text.replace(/^\uFEFF/, '');
  describedVersions.set(index, { doc, version: doc.version, describes });
  return describes;
}

/** Per index, the tokens `currentTokens` gave for a document version other than the index's text. */
const carriedVersions = new WeakMap<TokenIndex, { readonly doc: TextDoc; readonly version: number; readonly tokens: readonly Token[] }>();

/** A line break as VS Code's text model reads one. */
const LINE_BREAK = /\r\n|\r|\n/;

/** The index token each token that `carriedOver` moved to another line stands for (`indexTokenOf`). */
const origins = new WeakMap<Token, Token>();

/**
 * The token of the index that `token`, one of `currentTokens`, stands for: itself, unless it was
 * moved to another line with the lines below a change (then a copy with the moved range). For
 * answers kept by the index's positions (the inlay hints' `line:character:name`).
 */
export function indexTokenOf(token: Token): Token {
  return origins.get(token) ?? token;
}

/**
 * The tokens of `index` that describe the text `doc` shows (module comment, *Stale tokens*): all
 * of them while `doc` shows the text the load read (`indexDescribes`); otherwise those carried over
 * by the index's text (`carriedOver`), or, when that text is not known, the named tokens whose range
 * still holds the name as a whole token (`spells`, and not the start or end of a longer one: `r` in
 * `radius` is not `r`). Computed once per document version.
 */
export function currentTokens(doc: TextDoc, index: TokenIndex): readonly Token[] {
  if (indexDescribes(doc, index)) {
    return index.tokens;
  }
  const known = carriedVersions.get(index);
  if (known !== undefined && known.doc === doc && known.version === doc.version) {
    return known.tokens;
  }
  const tokens =
    index.text === undefined
      ? index.tokens.filter((t) => {
          const text = textAt(doc, t.range);
          return t.name !== undefined && text !== undefined && text !== '' && spells(text, t.name) && wholeToken(doc.lineAt(t.range.start.line).text, t.range, text);
        })
      : carriedOver(index.tokens, index.text.replace(/^\uFEFF/, '').split(LINE_BREAK), doc.getText().split(LINE_BREAK));
  carriedVersions.set(index, { doc, version: doc.version, tokens });
  return tokens;
}

/** Whether `text`, at single-line `range` of `line`, is not continued by the characters next to it (`continues`). */
function wholeToken(line: string, range: EditorRange, text: string): boolean {
  return !continues(line.charAt(range.start.character - 1), text.charAt(0)) && !continues(line.charAt(range.end.character), text.charAt(text.length - 1));
}

/**
 * The tokens of an index of the text `before` (its lines) that describe the text `after` (module
 * comment, *Stale tokens*), by the lines' correspondence (`core/positions.ts`
 * `lineCorrespondence`): a token on a line paired with an equal line is kept, moved to that line; a
 * token over several lines only when each of its lines is paired with an equal line and they are
 * consecutive; a single-line token on a line edited in place (a counterpart) where `after` has the
 * same text at the same range, as a whole token; a token on an unpaired line (in a hunk that inserts
 * or deletes lines) is dropped.
 */
function carriedOver(tokens: readonly Token[], before: readonly string[], after: readonly string[]): Token[] {
  const { toAfter } = lineCorrespondence(before, after);
  const pairedLine = (line: number): number => (line >= 0 && line < toAfter.length ? toAfter[line] : -1);
  const kept: Token[] = [];
  for (const t of tokens) {
    const { start, end } = t.range;
    const line = pairedLine(start.line);
    if (line < 0) {
      continue;
    }
    if (start.line !== end.line) {
      let equal = true;
      for (let k = start.line; k <= end.line && equal; k++) {
        equal = pairedLine(k) === line + (k - start.line) && before[k] === after[line + (k - start.line)];
      }
      if (!equal) {
        continue;
      }
    } else if (before[start.line] !== after[line]) {
      const text = before[start.line].slice(start.character, end.character);
      const shown = after[line];
      if (end.character <= start.character || shown.slice(start.character, end.character) !== text || !wholeToken(shown, t.range, text)) {
        continue;
      }
    }
    if (line === start.line) {
      kept.push(t);
    } else {
      const shift = line - start.line;
      const moved = { ...t, range: { start: { line: start.line + shift, character: start.character }, end: { line: end.line + shift, character: end.character } } };
      origins.set(moved, t);
      kept.push(moved);
    }
  }
  return kept;
}

const syntaxModels = new WeakMap<object, { readonly version: number; readonly model: SyntaxModel }>();

/**
 * The syntactic model of `doc` (M0's `buildSyntaxModel`: lexer tokens, layout blocks, declaration
 * groups) for its current text, or `undefined` for a literate style M0 does not model (the fenced
 * styles wait for M12). Kept per document object until its version changes.
 */
export function syntaxModelOf(doc: TextDoc): SyntaxModel | undefined {
  const style = literateStyleOf(doc);
  if (!isModelledStyle(style)) {
    return undefined;
  }
  const cached = syntaxModels.get(doc);
  if (cached !== undefined && cached.version === doc.version) {
    return cached.model;
  }
  const model = buildSyntaxModel(doc.getText(), style);
  syntaxModels.set(doc, { version: doc.version, model });
  return model;
}

/** The offset in `model.text` of `pos` (lines as the model splits them: `\n`, `\r\n`, `\r`). */
export function offsetOf(model: SyntaxModel, pos: EditorPosition): number {
  const start = model.lineStarts[Math.min(pos.line, model.lineStarts.length - 1)] ?? 0;
  return start + pos.character;
}

/** The editor position of `offset` in `model.text`. */
export function positionOf(model: SyntaxModel, offset: number): EditorPosition {
  let lo = 0;
  let hi = model.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (model.lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo, character: offset - model.lineStarts[lo] };
}

/**
 * The name at `pos`: from `tokens` (the index's, `currentTokens`), else from the lexer.
 *
 * - A named single-line token that contains `pos` (the narrowest), else a named one that ends at
 *   `pos` (the cursor just after a name, as VS Code's word lookup counts it). A token without a
 *   name (a keyword, a comment, a literal) that contains `pos` and no named one ending there means
 *   there is no name: the lexer is not asked, so a word in a comment is never looked up.
 * - Otherwise the lexer's token there, by the same rule (`syntaxModelOf`; not for the fenced
 *   literate styles, which M0 does not model): an identifier (its namespace and a record
 *   projection's `.` removed) that does not name a module or namespace (`isModuleSyntax`), a hole
 *   (`?name`, whose goal the compiler answers for), or an operator that is not reserved syntax.
 *   Holes have no index token [live, transcript `shapes-lookups`], nor has anything in a file
 *   never loaded.
 */
export function occurrenceAt(doc: TextDoc, tokens: readonly Token[] | undefined, pos: EditorPosition): Occurrence | undefined {
  if (tokens !== undefined) {
    const found = fromTokens(tokens, pos);
    if (found !== 'none') {
      return found;
    }
  }
  const model = syntaxModelOf(doc);
  return model === undefined ? undefined : fromLexer(model, pos);
}

function fromTokens(tokens: readonly Token[], pos: EditorPosition): Occurrence | undefined | 'none' {
  let containing: Token | undefined;
  let named: Token | undefined;
  let ending: Token | undefined;
  for (const t of tokens) {
    if (t.range.start.line !== t.range.end.line || compare(t.range.start, pos) > 0) {
      continue;
    }
    const toEnd = compare(pos, t.range.end);
    if (toEnd < 0) {
      containing = containing === undefined || width(t) < width(containing) ? t : containing;
      if (t.name !== undefined && (named === undefined || width(t) < width(named))) {
        named = t;
      }
    } else if (toEnd === 0 && t.name !== undefined) {
      ending = t;
    }
  }
  const token = named ?? ending;
  if (token?.name !== undefined) {
    return { range: token.range, name: token.name, decor: token.decor, ...(token.namespace === undefined || token.namespace === '' ? {} : { namespace: token.namespace }) };
  }
  return containing === undefined ? 'none' : undefined;
}

function width(t: Token): number {
  return t.range.end.character - t.range.start.character;
}

function fromLexer(model: SyntaxModel, pos: EditorPosition): Occurrence | undefined {
  const offset = offsetOf(model, pos);
  let containing: number | undefined;
  let ending: number | undefined;
  for (let i = 0; i < model.tokens.length; i++) {
    const t = model.tokens[i];
    if (t.start > offset) {
      break;
    }
    if (offset < t.end) {
      containing = i;
    } else if (offset === t.end) {
      ending = i;
    }
  }
  for (const i of [containing, ending]) {
    const t = i === undefined ? undefined : model.tokens[i];
    const name = t === undefined || isModuleSyntax(model.tokens, i as number) ? undefined : nameOfLexToken(t);
    if (t !== undefined && name !== undefined) {
      return { range: { start: positionOf(model, t.start), end: positionOf(model, t.end) }, name };
    }
  }
  return undefined;
}

/** The index of the token before `index` that is not a comment, or -1. */
function previousToken(tokens: readonly LexToken[], index: number): number {
  let k = index - 1;
  while (k >= 0 && (tokens[k].kind === 'comment' || tokens[k].kind === 'docComment')) {
    k--;
  }
  return k;
}

/** The keyword right before `tokens[index]` that makes it a module's or namespace's name: `module`, `import` (also `import public`) or `namespace`. */
function keywordBefore(tokens: readonly LexToken[], index: number): 'module' | 'import' | 'namespace' | undefined {
  const k = previousToken(tokens, index);
  const before = tokens[k];
  if (before?.kind !== 'keyword') {
    return undefined;
  }
  if (before.text === 'module' || before.text === 'import' || before.text === 'namespace') {
    return before.text;
  }
  const beforePublic = tokens[previousToken(tokens, k)];
  return before.text === 'public' && beforePublic?.kind === 'keyword' && beforePublic.text === 'import' ? 'import' : undefined;
}

/** Whether `tokens[index]` is the `as` of an import (`import Data.Vect as V`). */
function isImportAs(tokens: readonly LexToken[], index: number): boolean {
  const t = tokens[index];
  const imported = previousToken(tokens, index);
  return t?.kind === 'ident' && t.text === 'as' && tokens[imported]?.kind === 'ident' && keywordBefore(tokens, imported) === 'import';
}

/**
 * What introduces the identifier `tokens[index]` as the name of a module or namespace: the keyword
 * `module`, `import` (also `import public`) or `namespace` right before it, or the `as` after an
 * import's module name (`import Data.Vect as V`); `undefined` when none does, or the token is no
 * identifier. Comments in between are skipped. `docs.ts` `namespaceSuggestion` takes the first
 * three.
 */
export function namespaceKeywordBefore(tokens: readonly LexToken[], index: number): 'module' | 'import' | 'namespace' | 'as' | undefined {
  if (tokens[index]?.kind !== 'ident') {
    return undefined;
  }
  return keywordBefore(tokens, index) ?? (isImportAs(tokens, previousToken(tokens, index)) ? 'as' : undefined);
}

/**
 * Whether `tokens[index]` names a module or namespace, or is an import's `as` (second review of M3):
 * the lexer reads `Data.Vect` in `import Data.Vect` as a qualified identifier, whose last segment
 * would be looked up as a name — `(:type-of "Vect" 3 7)` answered `Data.Vect.Vect : Nat -> Type ->
 * Type` [live, idris2 0.8.0], the type, not the module. The index has no named token there (a
 * nameless `:module` one), so only the lexer's fallback can find one.
 */
function isModuleSyntax(tokens: readonly LexToken[], index: number): boolean {
  return namespaceKeywordBefore(tokens, index) !== undefined || isImportAs(tokens, index);
}

/** The unqualified name a lexer token stands for, if it is a name (see `occurrenceAt`). */
function nameOfLexToken(t: LexToken): string | undefined {
  if (t.kind === 'hole') {
    return t.text.slice(1);
  }
  if (t.kind === 'ident') {
    const text = t.text.startsWith('.') ? t.text.slice(1) : t.text;
    const dot = text.lastIndexOf('.');
    return dot > 0 ? text.slice(dot + 1) : text;
  }
  if (t.kind === 'symbol' && OPERATOR.test(t.text) && !RESERVED_SYMBOLS.has(t.text)) {
    return t.text;
  }
  return undefined;
}
