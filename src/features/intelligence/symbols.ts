/**
 * Document symbols (ROADMAP M3): the top-level declarations of an Idris file, read from its
 * layout — M0's syntax model (`features/syntax/selectionRangeModel.ts`: lexer tokens, layout
 * blocks, declaration groups) of the text the editor shows. No `vscode` import: offsets in, a
 * tree of `DocumentSymbolModel`s out; `register.ts` converts them.
 *
 * **Why the layout and not the token index.** The index describes the file as last loaded, and
 * does not by itself tell a declaration from an implementation header (the interface name there
 * is sent with an empty `:namespace`, like a declaring occurrence [live, transcript
 * `shapes-lookups`]); the layout describes the text shown, unsaved changes included, which the
 * Outline and breadcrumbs follow as the user types. The provider still answers only for a file
 * whose backend has the `documentSymbols` capability (`register.ts`).
 *
 * **What is a symbol** (Idris 2's declaration forms, read from the tokens and the layout as M0's
 * selection ranges read signatures and clauses; nothing here is checked by the compiler):
 * - a type signature, `name : …` (also `a, b : …` and `(op) : …`, after visibility and totality
 *   keywords, pragmas and a `0`/`1` multiplicity): a `Function` per name, whose range is its
 *   declaration group (the signature with its clauses and the `|||` lines above, as selection
 *   ranges have it) and whose detail is the type as written;
 * - `data`: a `Struct` with its constructors (`Constructor`) — the signatures under `where`, or the
 *   names after `=` and each `|`;
 * - `record`: a `Struct` with its `constructor` (`Constructor`) and its fields (`Field`, the
 *   signatures in its body);
 * - `interface`: an `Interface` (its name is the one after the last `=>` of the header, if any)
 *   with its methods (`Method`) and `constructor`;
 * - `namespace`: a `Namespace` holding the symbols of its body; `mutual` and `parameters` blocks
 *   add their bodies' symbols where they stand.
 * Not symbols: clauses (they belong to their signature's group), implementations, fixity
 * declarations, pragmas, `import`s, `module`, `failing` blocks, `where` blocks inside definitions.
 * The kinds are this module's choice (VS Code has no kind for an algebraic data type; `Struct`
 * is the nearest); idris2-lsp reports every name as a `Function` (`DocumentSymbol.idr`, `9a2f0ad`
 * [src]), so the two backends' outlines differ.
 */
import type { SyntaxModel } from '../syntax/selectionRangeModel';
import type { Token as LexToken } from '../syntax/lexer';

export type SymbolKindName = 'Namespace' | 'Struct' | 'Interface' | 'Function' | 'Constructor' | 'Field' | 'Method';

/** Offsets into the document's text. */
export interface OffsetSpan {
  readonly start: number;
  readonly end: number;
}

export interface DocumentSymbolModel {
  readonly name: string;
  readonly kind: SymbolKindName;
  readonly detail: string;
  /** The whole declaration. */
  readonly range: OffsetSpan;
  /** The name, inside `range`. */
  readonly selection: OffsetSpan;
  readonly children: readonly DocumentSymbolModel[];
}

type Block = NonNullable<SyntaxModel['blockAtLine'][number]>;

/** Visibility and totality keywords (`visOption`, `totalityOpt` in Parser.idr [src]). */
const MODIFIERS: ReadonlySet<string> = new Set(['public', 'export', 'private', 'total', 'partial', 'covering']);

/** The top-level blocks of `model`, in order. */
function rootBlocks(model: SyntaxModel): Block[] {
  const roots: Block[] = [];
  for (const block of model.blockAtLine) {
    let root = block;
    while (root?.parent !== undefined) {
      root = root.parent;
    }
    if (root !== undefined && roots[roots.length - 1] !== root) {
      roots.push(root);
    }
  }
  return roots;
}

/** Index in `tokens` of the first token starting at or after `offset`. */
function firstFrom(tokens: readonly LexToken[], offset: number): number {
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

/** The tokens of `block` at its first token's bracket level, comments left out. */
function levelTokens(model: SyntaxModel, block: Block): LexToken[] {
  const level = block.firstToken.outer;
  const result: LexToken[] = [];
  for (let i = firstFrom(model.tokens, block.firstToken.start); i < model.tokens.length && model.tokens[i].start < block.range.end; i++) {
    const t = model.tokens[i];
    if (t.kind !== 'comment' && t.kind !== 'docComment' && t.outer === level) {
      result.push(t);
    }
  }
  return result;
}

/** A declarable name at `level[i]`: an unqualified identifier or `(op)`, with its span and the index after it. */
function nameAt(model: SyntaxModel, level: readonly LexToken[], i: number): { name: string; span: OffsetSpan; next: number } | undefined {
  const t = level[i];
  if (t === undefined) {
    return undefined;
  }
  if (t.kind === 'ident' && !t.text.includes('.')) {
    return { name: t.text, span: { start: t.start, end: t.end }, next: i + 1 };
  }
  const close = t.delimits?.close;
  if (t.kind === 'groupOpen' && t.text === '(' && close !== undefined) {
    const k = firstFrom(model.tokens, t.start);
    const op = model.tokens[k + 1];
    if (op?.kind === 'symbol' && model.tokens[k + 2] === close) {
      return { name: op.text, span: { start: t.start, end: close.end }, next: i + 2 };
    }
  }
  return undefined;
}

/** `i` past visibility and totality keywords and pragmas. */
function skipModifiers(level: readonly LexToken[], i: number): number {
  while (i < level.length && ((level[i].kind === 'keyword' && MODIFIERS.has(level[i].text)) || level[i].kind === 'pragma')) {
    i++;
  }
  return i;
}

/** The signature at `level[i]` (after modifiers): its names and the index of its `:`. */
function signature(model: SyntaxModel, level: readonly LexToken[]): { names: { name: string; span: OffsetSpan }[]; colon: LexToken } | undefined {
  let i = skipModifiers(level, 0);
  if (level[i]?.kind === 'number' && (level[i].text === '0' || level[i].text === '1')) {
    i++;
  }
  const names: { name: string; span: OffsetSpan }[] = [];
  for (;;) {
    const name = nameAt(model, level, i);
    if (name === undefined) {
      return undefined;
    }
    names.push({ name: name.name, span: name.span });
    const sep = level[name.next];
    if (sep?.kind === 'symbol' && sep.text === ',') {
      i = name.next + 1;
      continue;
    }
    return sep?.kind === 'symbol' && sep.text === ':' ? { names, colon: sep } : undefined;
  }
}

/** The line of `offset` in `model`. */
function lineOf(model: SyntaxModel, offset: number): number {
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
  return lo;
}

/**
 * The source text from `start` to `end` as one line: without comments and bird-track markers,
 * whitespace runs as one space.
 */
function sourceText(model: SyntaxModel, start: number, end: number): string {
  const chars = model.text.slice(start, end).split('');
  const blank = (from: number, to: number): void => {
    for (let k = Math.max(from, start); k < Math.min(to, end); k++) {
      chars[k - start] = ' ';
    }
  };
  for (let i = firstFrom(model.tokens, start); i < model.tokens.length && model.tokens[i].start < end; i++) {
    const t = model.tokens[i];
    if (t.kind === 'comment' || t.kind === 'docComment') {
      blank(t.start, t.end);
    }
  }
  const unlit = model.unlitLineStarts;
  if (unlit !== undefined) {
    for (let line = lineOf(model, start); line < model.lineStarts.length && model.lineStarts[line] < end; line++) {
      blank(model.lineStarts[line], unlit[line]);
    }
  }
  return chars.join('').replace(/\s+/g, ' ').trim();
}

function signatureSymbols(model: SyntaxModel, block: Block, level: readonly LexToken[], kind: SymbolKindName): DocumentSymbolModel[] {
  const sig = signature(model, level);
  if (sig === undefined) {
    return [];
  }
  const range = block.declarationGroup ?? block.range;
  const detail = sourceText(model, sig.colon.end, block.range.end);
  return sig.names.map(({ name, span }) => ({ name, kind, detail, range, selection: span, children: [] }));
}

/** The constructors of `data … = A … | B …`: the name after `=` and after each `|`. */
function alternatives(model: SyntaxModel, block: Block, level: readonly LexToken[], from: number): DocumentSymbolModel[] {
  const result: DocumentSymbolModel[] = [];
  for (let i = from; i < level.length; i++) {
    const t = level[i];
    if (t.kind !== 'symbol' || (t.text !== '=' && t.text !== '|')) {
      continue;
    }
    const name = nameAt(model, level, i + 1);
    if (name === undefined) {
      continue;
    }
    const bar = level.findIndex((u, k) => k >= name.next && u.kind === 'symbol' && u.text === '|');
    const end = bar < 0 ? block.range.end : level[bar - 1].end;
    result.push({ name: name.name, kind: 'Constructor', detail: '', range: { start: name.span.start, end }, selection: name.span, children: [] });
  }
  return result;
}

/** `constructor Name` in a record or interface body. */
function constructorSymbol(model: SyntaxModel, block: Block, level: readonly LexToken[]): DocumentSymbolModel | undefined {
  if (level[0]?.kind !== 'ident' || level[0].text !== 'constructor') {
    return undefined;
  }
  const name = nameAt(model, level, 1);
  return name === undefined ? undefined : { name: name.name, kind: 'Constructor', detail: '', range: block.range, selection: name.span, children: [] };
}

/** The symbols of a body's blocks: signatures as `kind`, and a `constructor` line. */
function bodySymbols(model: SyntaxModel, blocks: readonly Block[], kind: SymbolKindName): DocumentSymbolModel[] {
  return blocks.flatMap((child) => {
    const level = levelTokens(model, child);
    return constructorSymbol(model, child, level) ?? signatureSymbols(model, child, level, kind);
  });
}

/** The name of `interface … where`: after the last `=>` of the header, else the first. */
function interfaceName(model: SyntaxModel, level: readonly LexToken[], from: number): { name: string; span: OffsetSpan } | undefined {
  const where = level.findIndex((t, k) => k >= from && t.kind === 'keyword' && t.text === 'where');
  const header = where < 0 ? level.length : where;
  let start = from;
  for (let k = from; k < header; k++) {
    if (level[k].kind === 'symbol' && level[k].text === '=>') {
      start = k + 1;
    }
  }
  return nameAt(model, level, start);
}

function blockSymbols(model: SyntaxModel, block: Block): DocumentSymbolModel[] {
  const level = levelTokens(model, block);
  const i = skipModifiers(level, 0);
  const head = level[i];
  if (head?.kind !== 'keyword') {
    return signatureSymbols(model, block, level, 'Function');
  }
  const symbol = (
    name: { name: string; span: OffsetSpan } | undefined,
    kind: SymbolKindName,
    children: DocumentSymbolModel[],
  ): DocumentSymbolModel[] =>
    name === undefined ? [] : [{ name: name.name, kind, detail: '', range: block.range, selection: name.span, children }];
  switch (head.text) {
    case 'data': {
      const name = nameAt(model, level, i + 1);
      const gadt = level.some((t) => t.kind === 'keyword' && t.text === 'where');
      return symbol(name, 'Struct', gadt ? bodySymbols(model, block.children, 'Constructor') : alternatives(model, block, level, i + 1));
    }
    case 'record':
      return symbol(nameAt(model, level, i + 1), 'Struct', bodySymbols(model, block.children, 'Field'));
    case 'interface':
      return symbol(interfaceName(model, level, i + 1), 'Interface', bodySymbols(model, block.children, 'Method'));
    case 'namespace': {
      const t = level[i + 1];
      const name = t?.kind === 'ident' ? { name: t.text, span: { start: t.start, end: t.end } } : undefined;
      return symbol(name, 'Namespace', block.children.flatMap((child) => blockSymbols(model, child)));
    }
    case 'mutual':
    case 'parameters':
      return block.children.flatMap((child) => blockSymbols(model, child));
    default:
      return [];
  }
}

/** The document symbols of `model` (module comment). */
export function documentSymbols(model: SyntaxModel): DocumentSymbolModel[] {
  return rootBlocks(model).flatMap((block) => blockSymbols(model, block));
}
