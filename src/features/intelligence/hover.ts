/**
 * The hover (ROADMAP M3: the type of the name under the cursor, local pattern variables included,
 * and its doc overview) and what **Type at Cursor** shows: `HoverModel` (`types.ts`) and its
 * rendering under the untrusted-text rules. Only type imports from `vscode`: the adapter
 * (`register.ts`) makes the `MarkdownString` and the `vscode.Position`s.
 *
 * **Where the answers come from.** The type: `IdrisBackend.typeAt` at the occurrence's start,
 * with the occurrence's decoration — positional `:type-of` first (in IDE mode once more one code
 * point further when a local right before the name answered, and asked where the position lies in
 * the file as loaded while the document has unsaved changes, `IdeBackend.typeAt`), by name when that
 * gives no type for the name (`TypeInfo.lookup`), but not for a variable.
 * The overview: `IdrisBackend.docsFor` by name, of which the block that documents the declaration
 * the type answer names is taken (`text.ts` `docBlocks`, `docOverview`): an overloaded name is
 * answered with one block per definition, and a local variable must not get a global's docs. Both
 * are kept per file until a load makes them stale (`AnswerCache`) — the type only while the
 * document is not stale (`isStale`): it is kept by the editor position, which while the document
 * shows other text than the file as loaded may stand for another place of the file at each version
 * (third review of M3: an answer found while a `.lidr` had an unsaved `> ` line changed was shown
 * again, with no stale note, after an undo back to the saved text [unit-level]). The backend keeps
 * its answers per load and the point it sent, so asking it again is cheap.
 *
 * **Answers that are dropped** rather than shown for the wrong name:
 * - for a token the compiler decorated as bound (a local variable), an answer looked up by name:
 *   it describes a global of the same name, which the local shadows (the IDE-mode backend does not
 *   ask by name for such a token at all, `IdeBackend.typeAt`);
 * - while the document is stale (it shows other text than the file as last checked), a positional
 *   answer that declares another name: the position was taken in the text shown, the compiler
 *   reads the file as it loaded it, and `:type-of NAME L C` answers for whatever is at (L, C),
 *   whatever NAME asks for [live, transcript `unicode-columns`: `(:type-of "y" 12 3)` → `x₁ : ℕ`].
 *   The IDE-mode backend passes on no positional answer about another unqualified name, stale or
 *   not (`describesAnotherLocal`): it asks by name instead. So on the method `perimeter` of
 *   `Measured Shape where`, whose positional answer is its implementation's machine name
 *   `perimeter_Measured_Shape : Shape -> Double` [live, transcript `shapes-lookups`], the hover
 *   shows the method's declared type found by name, `Foo.Shapes.perimeter : Measured a => a ->
 *   Double`, with the name-lookup note. This rule still drops a positional answer about another
 *   qualified name (a global) while the document is stale.
 */
import type * as vscode from 'vscode';
import type { BackendRegistry } from '../../backend/registry';
import type { IdrisBackend, RichText, Token, TypeInfo } from '../../backend/types';
import type { EditorPosition } from '../../core/positions';
import { codeBlock, visible, type MarkdownSink } from '../../core/untrustedText';
import type { Classification, ProjectIndex } from '../../project/types';
import { isCheckable, type CheckStatus, type CheckStatusSource } from '../diagnostics/checks';
import { currentTokens, occurrenceAt, type Occurrence } from './occurrence';
import type { AnswerCache } from './queries';
import { declaredNames, docBlocks, docOverview, nameRoot } from './text';
import type { DocumentQueries, HoverModel, QueryMode, QueryOutcome } from './types';

/** What the hover needs; `register.ts` passes the real ones. */
export interface HoverDeps {
  readonly queries: DocumentQueries;
  readonly answers: AnswerCache;
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  readonly checks: CheckStatusSource;
  /** `new vscode.Position(line, character)`. */
  readonly position: (p: EditorPosition) => vscode.Position;
}

/** A hover model, or why the compiler was not asked or did not answer (for the commands). */
export type HoverResult =
  | { readonly kind: 'model'; readonly model: HoverModel; readonly occurrence: Occurrence }
  | { readonly kind: 'noName' }
  /** `stale`: the document shows other text than the file as last checked (`isStale`). */
  | { readonly kind: 'noType'; readonly occurrence: Occurrence; readonly stale: boolean }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly occurrence: Occurrence };

/**
 * Whether answers about `doc` may describe other text than it shows: unsaved changes, or a text
 * the checks found changed since the load (ARCHITECTURE §6.1, `CheckStatusSource`).
 */
export function isStale(doc: vscode.TextDocument, status: CheckStatus | undefined): boolean {
  if (doc.isDirty) {
    return true;
  }
  return (status?.kind === 'checked' || status?.kind === 'packageError') && status.stale;
}

/** `doc`'s root, its backend, and the backend's index tokens of `doc` that still apply (`currentTokens`). */
export interface DocumentTokens {
  readonly root: Classification;
  readonly backend: IdrisBackend;
  /** `undefined` without an index (no load of the file sent highlighting yet). */
  readonly tokens: readonly Token[] | undefined;
}

export async function documentTokens(deps: Pick<HoverDeps, 'registry' | 'projects'>, doc: vscode.TextDocument): Promise<DocumentTokens> {
  const root = await deps.projects.classify(doc.fileName);
  const backend = deps.registry.backendFor(root);
  const index = backend.tokens(doc);
  return { root, backend, tokens: index === undefined ? undefined : currentTokens(doc, index) };
}

/** The name at `pos` of `doc` as the hover, the commands and the other providers read it (`occurrence.ts`). */
export async function nameAt(
  deps: Pick<HoverDeps, 'registry' | 'projects'>,
  doc: vscode.TextDocument,
  pos: EditorPosition,
): Promise<DocumentTokens & { readonly occurrence: Occurrence | undefined }> {
  const found = await documentTokens(deps, doc);
  return { ...found, occurrence: occurrenceAt(doc, found.tokens, pos) };
}

/** The cache key of `IdrisBackend.docsFor` in `mode` for `name` (shared with **Show Documentation**). */
export function docsKey(name: string, mode: 'overview' | 'full'): string {
  return `docsFor ${mode} ${name}`;
}

/**
 * The hover at `pos`: `passive` for the provider (nothing when the backend has no `hover`
 * capability, and `DocumentQueries` loads nothing but the active document), `command` for **Type
 * at Cursor** (which loads the file when it must, and reports why there is nothing).
 */
export async function hoverAt(deps: HoverDeps, doc: vscode.TextDocument, pos: EditorPosition, mode: QueryMode): Promise<HoverResult> {
  if (!isCheckable(doc)) {
    return { kind: 'noName' };
  }
  const { occurrence, root, backend } = await nameAt(deps, doc, pos);
  if (occurrence === undefined || (mode === 'passive' && !backend.caps.hover)) {
    return { kind: 'noName' };
  }
  const status = deps.checks.statusOf(doc, root);
  const stale = isStale(doc, status);
  const fresh = status?.kind === 'checking';
  const { name } = occurrence;
  const start = occurrence.range.start;
  const askType = (): Promise<QueryOutcome<TypeInfo | undefined>> =>
    deps.queries.run(doc, mode, (b) => b.typeAt(doc, deps.position(start), name, occurrence.decor));
  const typeOutcome = stale ? await askType() : await deps.answers.get(doc.fileName, `typeAt ${start.line}:${start.character} ${name}`, askType, fresh);
  if (typeOutcome.kind === 'unavailable') {
    return { kind: 'unavailable', reason: typeOutcome.reason, occurrence };
  }
  const type = acceptedType(typeOutcome.value, occurrence, stale);
  if (type === undefined) {
    return { kind: 'noType', occurrence, stale };
  }
  // A local variable has no docs of its own: `:docs-for` would answer for a global of its name.
  const docs: QueryOutcome<RichText | undefined> =
    occurrence.decor === 'bound'
      ? { kind: 'answer', value: undefined }
      : await deps.answers.get(
          doc.fileName,
          docsKey(name, 'overview'),
          () => deps.queries.run(doc, mode, (b) => b.docsFor(doc, name, 'overview')),
          fresh,
        );
  const docOverview = docs.kind === 'answer' && docs.value !== undefined ? overviewFor(docs.value.text, type) : undefined;
  return { kind: 'model', occurrence, model: { range: occurrence.range, type, docOverview, stale } };
}

/** `answer` unless the rules of the module comment (*Answers that are dropped*) drop it. */
function acceptedType(answer: TypeInfo | undefined, occurrence: Occurrence, stale: boolean): TypeInfo | undefined {
  if (answer === undefined) {
    return undefined;
  }
  if (occurrence.decor === 'bound' && answer.lookup === 'name') {
    return undefined;
  }
  if (stale && answer.lookup === 'position' && !declaredNames(answer.text).some((n) => nameRoot(n) === occurrence.name)) {
    return undefined;
  }
  return answer;
}

/**
 * The overview of the one `:docs-for` block that documents what `type` declares, or `undefined`
 * when no block, or more than one, does (an overloaded name looked up by name: which one the
 * cursor is on is not known).
 */
function overviewFor(docs: string, type: TypeInfo): string | undefined {
  const names = new Set(declaredNames(type.text));
  const blocks = docBlocks(docs).filter((b) => names.has(b.name));
  return blocks.length === 1 ? docOverview(docs, blocks[0]) : undefined;
}

/** Our own texts of the hover; markdown, never compiler text. */
const STALE_NOTE = '*Results refer to the saved file as it was last checked.*\n\n';
const NAME_LOOKUP_NOTE =
  "\n*Name-based lookup:* at this position the compiler gave no type of this name (none, or another name's), so it was looked up by name, which may find another definition of it.\n";

/**
 * Renders `model` under the rules of `types.ts` (*Untrusted text*): compiler text only in a fenced
 * block (`codeBlock`), its invisible characters written out (`visible`) — the type in an `idris2`
 * block, the doc overview in a `text` one (`CodeBlockLanguage`: without an info string VS Code
 * colours the block as Idris); the notes are this extension's markdown. Not the overview
 * through `appendText`: VS Code 1.139.1's escaper leaves `&`, `<` and `:` alone, so a docstring's
 * named character reference (`&rlm;`, `&ZeroWidthSpace;`) became the invisible character itself after
 * `visible` had run, and `<https://…>` a link (*review of M3* [src, and unit-level: the escaper of
 * `appendText` in VS Code 1.139.1's extension host bundle, run with marked 18.0.14 on Node; not
 * observed in VS Code]). In a code block marked writes `&` as `&amp;` and makes no links
 * [unit-level, the same marked].
 */
export function renderHover(md: MarkdownSink, model: HoverModel): void {
  if (model.stale) {
    md.appendMarkdown(STALE_NOTE);
  }
  if (model.type !== undefined) {
    md.appendMarkdown(codeBlock(visible(model.type.text), 'idris2'));
    if (model.type.lookup === 'name') {
      md.appendMarkdown(NAME_LOOKUP_NOTE);
    }
  }
  if (model.docOverview !== undefined) {
    md.appendMarkdown(codeBlock(visible(model.docOverview), 'text'));
  }
}
