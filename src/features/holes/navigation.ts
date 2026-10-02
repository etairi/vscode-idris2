/**
 * Where the holes of a document's text are, read with M0's lexer: **Next Hole**, **Previous Hole**
 * and the revealing of a hole the compiler reported (`types.ts`). No `vscode` import.
 *
 * **Why the text, not the compiler's locations.** Next and Previous Hole move through the `hole`
 * tokens (`?name`) of the text the editor shows, as the syntax model reads it
 * (`features/intelligence/occurrence.ts` `syntaxModelOf`: `features/syntax/lexer.ts`, a port of the
 * compiler's lexer, whose `holeIdent` rule makes them). The compiler's locations (`IdrisBackend.holes`,
 * `:metavariables` then `:name-at`) describe the file as its last load read it: after an unsaved
 * edit above a hole they are off, and a hole typed since is missing. They also need a running
 * compiler, one request per hole name, and a trusted workspace; and `:metavariables` lists a
 * declaration without clauses as a hole too [live, recorder of M4]. The lexer sees the text as it
 * is, in Restricted Mode too, and never lands in a comment, a string or (bird tracks) a prose line:
 * those are other tokens, or blanked before lexing (`selectionRangeModel.ts`
 * `unlitPreservingOffsets`). What it cannot see: a `?name` of code the compiler would reject is still
 * a hole token. The fenced literate styles are not modelled (`syntaxModelOf` answers `undefined`,
 * M12), and the commands say so.
 */
import type { EditorPosition, EditorRange } from '../../core/positions';
import { positionOf } from '../intelligence/occurrence';
import type { OffsetRange, SyntaxModel } from '../syntax/selectionRangeModel';

/** The `?name` tokens of `model`, in document order (the lexer's token order). */
export function holeTokens(model: SyntaxModel): readonly OffsetRange[] {
  return model.tokens.filter((t) => t.kind === 'hole').map((t) => ({ start: t.start, end: t.end }));
}

/** A hole to move to, and whether the search went around the end (or the start) of the text. */
export interface HoleStep {
  readonly hole: OffsetRange;
  readonly wrapped: boolean;
}

/**
 * **Next Hole** from the offset `from` (the start of the selection): the first hole that starts
 * after it — so from a hole's start, or from inside it, the one after —, else the first hole of the
 * text (`wrapped`); `undefined` when there is none.
 */
export function nextHole(holes: readonly OffsetRange[], from: number): HoleStep | undefined {
  const after = holes.find((h) => h.start > from);
  return after !== undefined ? { hole: after, wrapped: false } : holes.length > 0 ? { hole: holes[0], wrapped: true } : undefined;
}

/**
 * **Previous Hole** from the offset `from` (the start of the selection): the last hole that starts
 * before it — from a selected hole, the one before; from inside a hole, its own start —, else the
 * last hole of the text (`wrapped`); `undefined` when there is none.
 */
export function previousHole(holes: readonly OffsetRange[], from: number): HoleStep | undefined {
  let before: OffsetRange | undefined;
  for (const h of holes) {
    if (h.start >= from) {
      break;
    }
    before = h;
  }
  return before !== undefined ? { hole: before, wrapped: false } : holes.length > 0 ? { hole: holes[holes.length - 1], wrapped: true } : undefined;
}

/** `range` (offsets of `model.text`) in editor coordinates. */
export function editorRange(model: SyntaxModel, range: OffsetRange): EditorRange {
  return { start: positionOf(model, range.start), end: positionOf(model, range.end) };
}

/** The text of the single-line `range` of `lines`, `undefined` when it is out of bounds or spans lines. */
function textAt(lineText: (line: number) => string | undefined, range: EditorRange): string | undefined {
  if (range.start.line !== range.end.line || range.end.character < range.start.character) {
    return undefined;
  }
  const line = lineText(range.start.line);
  return line === undefined || range.end.character > line.length ? undefined : line.slice(range.start.character, range.end.character);
}

const same = (a: EditorPosition, b: EditorPosition): boolean => a.line === b.line && a.character === b.character;

/** The ranges of the `?name` tokens of `model`, in document order. */
export function namedHoles(model: SyntaxModel, name: string): EditorRange[] {
  const holeText = `?${name}`;
  return model.tokens.filter((t) => t.kind === 'hole' && t.text === holeText).map((t) => editorRange(model, t));
}

/**
 * Where the hole `name` (unqualified, without `?`) is in the text `model` was built from, given the
 * range the compiler reported for it (`recorded`: `Hole.location`'s, in the file as a load read it;
 * absent when it has none), whether the text is still the one `recorded` was read from (`unchanged`:
 * `HoleModel.rangesText`) and, when the file has more than one hole of the name (in
 * different namespaces of one module, which load cleanly [live, M4's ninth review]; one namespace
 * cannot hold two, `Dup.h is already defined` [live, prep of M4]), its place among them (`ordinal`,
 * `tree.ts` `HoleRef`):
 * 1. with `ordinal`, the `?name` token of that index when the text has exactly `count` of them; else,
 *    `unchanged`, the token at `recorded` (the text holds a `?name` the compiler does not list, one
 *    in a `failing` block [live, M4's eleventh review]); else `undefined` (an edit changed their number,
 *    and the nearest one, or the one now at `recorded`, may be the other hole);
 * 2. `recorded`, when the text still has there the token `?name` (a `Hole.location` is always a
 *    `?name` token's: `backend/ide/holes.ts` leaves out the declarations `:metavariables` lists);
 * 3. else the `?name` token nearest to `recorded`'s line (the first of two as near; the first of the
 *    text without `recorded`) — an edit made since moved it, or a second one was typed;
 * 4. else `undefined`: the text no longer has it.
 * With `model` undefined (a literate style the lexer does not read, M12), only step 2 is tried, on
 * the text alone (`lineText`).
 */
export function locateHole(
  model: SyntaxModel | undefined,
  lineText: (line: number) => string | undefined,
  name: string,
  recorded: EditorRange | undefined,
  ordinal?: { readonly index: number; readonly count: number },
  unchanged = false,
): EditorRange | undefined {
  if (model === undefined) {
    const text = recorded === undefined ? undefined : textAt(lineText, recorded);
    return text === `?${name}` ? recorded : undefined;
  }
  const holes = namedHoles(model, name);
  const exact = recorded === undefined ? undefined : holes.find((r) => same(r.start, recorded.start) && same(r.end, recorded.end));
  if (ordinal !== undefined) {
    return holes.length === ordinal.count ? holes[ordinal.index] : unchanged ? exact : undefined;
  }
  if (exact !== undefined) {
    return exact;
  }
  const line = recorded?.start.line;
  let best: EditorRange | undefined;
  for (const hole of holes) {
    if (best === undefined || (line !== undefined && Math.abs(hole.start.line - line) < Math.abs(best.start.line - line))) {
      best = hole;
    }
  }
  return best;
}
