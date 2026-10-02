/**
 * Applying an `edit` result (`backend/types.ts` `EditResult`) to the document the request came from
 * (`types.ts`, *One edit*, step 4): one `WorkspaceEdit` of that document's URI — so one undo step —,
 * only while the document is open and still at the version the request was made for, the
 * replacements' line breaks written as the document's. The ranges are checked first: inside the
 * document, in order, not overlapping; a result that fails is not applied (VS Code would clamp a
 * position outside the text and apply the edit elsewhere).
 *
 * **The version check is exact.** `workspace.applyEdit` sends each text edit with the version the
 * extension host knows of its document, and the workbench refuses the whole edit ("… has changed in
 * the meantime") when the document's model has another one [src, VS Code 1.139.1: the extension
 * host's `applyWorkspaceEdit` converts with `getTextDocumentVersion`, the workbench's bulk text edit
 * validates `getVersionId()` against it]. So a result is applied only to the text it was computed
 * for: the version is compared right before `applyEdit`, and a change that comes in between makes
 * `applyEdit` resolve false. An edit of one document is one element on its undo stack [src, the
 * same bundle: a bulk edit of one model is one `SingleModelEditStackElement`].
 *
 * Only type imports from `vscode`.
 */
import type * as vscode from 'vscode';
import type { TextReplacement } from '../../backend/types';
import type { EditorPosition, EditorRange } from '../../core/positions';

/** The part of the `vscode` namespace this module uses. */
export type ApplyApi = Pick<typeof vscode, 'workspace' | 'WorkspaceEdit' | 'Range' | 'EndOfLine'>;

/** The part of a document this module reads; `vscode.TextDocument` satisfies it. */
export interface ApplyDocument {
  readonly uri: vscode.Uri;
  readonly version: number;
  readonly isClosed: boolean;
  readonly eol: vscode.EndOfLine;
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
  getText(range?: vscode.Range): string;
}

/**
 * What became of an application: `applied`, with the range each replacement's text covers in the
 * new text (in the order of their positions); `changed` — the document is no longer at the version
 * (also when `applyEdit` refused it for that reason); `closed`; `invalid` — the ranges do not fit
 * the document (`reason` for the log); `unchanged` — every replacement repeats the text it
 * replaces, so applying it would do nothing; `refused` — `applyEdit` resolved false with the
 * document open and at the version.
 */
export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly ranges: readonly EditorRange[] }
  | { readonly kind: 'changed' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused' };

const LINE_BREAK = /\r\n|\r|\n/g;

const compare = (a: EditorPosition, b: EditorPosition): number => a.line - b.line || a.character - b.character;

/** `replacements` in the order of their positions (insertions at one point keep their order). */
export function inOrder(replacements: readonly TextReplacement[]): TextReplacement[] {
  return replacements
    .map((r, i) => ({ r, i }))
    .sort((a, b) => compare(a.r.range.start, b.r.range.start) || compare(a.r.range.end, b.r.range.end) || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * Why `replacements` (in order, `inOrder`) do not fit `doc`, or `undefined` when they do: every
 * position on a line of the document and within its text, every range forward, and none starting
 * before the one before it ends.
 */
export function misfit(doc: Pick<ApplyDocument, 'lineCount' | 'lineAt'>, replacements: readonly TextReplacement[]): string | undefined {
  const inside = (p: EditorPosition): boolean =>
    Number.isInteger(p.line) && Number.isInteger(p.character) && p.line >= 0 && p.line < doc.lineCount && p.character >= 0 && p.character <= doc.lineAt(p.line).text.length;
  let previous: EditorRange | undefined;
  for (const { range } of replacements) {
    if (!inside(range.start) || !inside(range.end)) {
      return `the range ${show(range)} is not in the document`;
    }
    if (compare(range.start, range.end) > 0) {
      return `the range ${show(range)} ends before it starts`;
    }
    if (previous !== undefined && compare(previous.end, range.start) > 0) {
      return `the ranges ${show(previous)} and ${show(range)} overlap`;
    }
    previous = range;
  }
  return undefined;
}

/** A range for the log, 0-based. */
const show = (r: EditorRange): string => `${r.start.line}:${r.start.character}–${r.end.line}:${r.end.character}`;

/** `text` with each line break (`\r\n`, `\r`, `\n`) written as `eol`. */
export function withLineBreaks(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(LINE_BREAK, eol);
}

/**
 * The range each replacement's text covers once all of them are applied (`replacements` in order,
 * not overlapping). A replacement moves what follows it: the lines below its range by the number of
 * lines it adds or removes, and the rest of its last line to where its text ends. Lines break as
 * the editor breaks them (`\r\n`, `\r`, `\n`); columns count UTF-16 units, as the editor's do.
 */
export function rangesAfter(replacements: readonly TextReplacement[]): EditorRange[] {
  const ranges: EditorRange[] = [];
  /** How many lines the replacements so far added (negative: removed). */
  let lineShift = 0;
  /** The end of the previous replacement, before and after it was applied. */
  let previousEnd: { readonly before: EditorPosition; readonly after: EditorPosition } | undefined;
  for (const { range, text } of replacements) {
    const start: EditorPosition =
      previousEnd !== undefined && range.start.line === previousEnd.before.line
        ? { line: previousEnd.after.line, character: previousEnd.after.character + range.start.character - previousEnd.before.character }
        : { line: range.start.line + lineShift, character: range.start.character };
    const lines = text.split(LINE_BREAK);
    const breaks = lines.length - 1;
    const last = lines[breaks];
    const end: EditorPosition = breaks === 0 ? { line: start.line, character: start.character + last.length } : { line: start.line + breaks, character: last.length };
    ranges.push({ start, end });
    lineShift += breaks - (range.end.line - range.start.line);
    previousEnd = { before: range.end, after: end };
  }
  return ranges;
}

/**
 * Applies `replacements` to `doc` as one `WorkspaceEdit` of `doc.uri` if `doc` is open and at
 * `version` (module comment). Nothing else is touched: every replacement goes to `doc.uri`.
 */
export async function applyReplacements(
  api: ApplyApi,
  doc: ApplyDocument,
  version: number,
  replacements: readonly TextReplacement[],
): Promise<ApplyOutcome> {
  if (doc.isClosed) {
    return { kind: 'closed' };
  }
  if (doc.version !== version) {
    return { kind: 'changed' };
  }
  const ordered = inOrder(replacements);
  const reason = misfit(doc, ordered);
  if (reason !== undefined) {
    return { kind: 'invalid', reason };
  }
  const eol = doc.eol === api.EndOfLine.CRLF ? '\r\n' : '\n';
  const toRange = (r: EditorRange): vscode.Range => new api.Range(r.start.line, r.start.character, r.end.line, r.end.character);
  const texts = ordered.map((r) => withLineBreaks(r.text, eol));
  if (ordered.every((r, i) => doc.getText(toRange(r.range)) === texts[i])) {
    return { kind: 'unchanged' };
  }
  const edit = new api.WorkspaceEdit();
  ordered.forEach((r, i) => edit.replace(doc.uri, toRange(r.range), texts[i]));
  if (await api.workspace.applyEdit(edit)) {
    return { kind: 'applied', ranges: rangesAfter(ordered) };
  }
  return doc.isClosed ? { kind: 'closed' } : doc.version !== version ? { kind: 'changed' } : { kind: 'refused' };
}
