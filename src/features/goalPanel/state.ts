/**
 * What the goal panel shows at a place of a document (`buildPanel`): the state it sends to the webview
 * (`src/webview/protocol.ts`), and the targets it keeps, since the webview's messages name only what
 * the state shows. Pure and without `vscode`: it reads the text with the editing commands' readings
 * (`features/editing/targets.ts`) and the holes the model has, and unit-tests on plain Node.
 *
 * **The hole shown.** The pinned one, for as long as the model has it; else the `?name` at the cursor,
 * or the only one on the cursor's line, as the text shows it now; its goal comes from the model, by
 * name, and of several holes of one name in the file (one per namespace) from the one found at that
 * place (`features/holes/navigation.ts` `locateHole`, as revealing a hole does). A `?name` the model
 * does not list is one no check has read yet.
 *
 * **Untrusted text.** All of it is the compiler's or the file's: written out with `visible` or
 * `editorLabel` (`core/untrustedText.ts`), and cut at a length a panel can show.
 */
import type { Hole, Premise } from '../../backend/types';
import type { DisplayOptions } from '../../core/config';
import type { EditorPosition, EditorRange } from '../../core/positions';
import { codeBlock, editorLabel, visible } from '../../core/untrustedText';
import type { ChoicesView, DeclarationView, GoalView, HoleRow, MessageRow, MessageSeverity, PanelCapabilities, PanelState } from '../../webview/protocol';
import { declarationAt, holeAt, patternVariablesAround, type HoleTarget } from '../editing/targets';
import { editorRange, holeTokens, locateHole } from '../holes/navigation';
import { holeDescription, holeLabel, holeRef, premiseText, tooltipText, type HoleRef } from '../holes/tree';
import type { HoleModel } from '../holes/types';
import { syntaxModelOf, type TextDoc } from '../intelligence/occurrence';

/** The longest list of **All holes**: a package's holes can be many, and the Holes view has them all. */
export const MAX_HOLE_ROWS = 200;

/** The longest list of **Messages**. */
export const MAX_MESSAGE_ROWS = 100;

/** The longest type or name of a line of **All holes**, in UTF-16 code units. */
const MAX_ROW_TEXT = 200;

/** A document as the panel reads it. */
export interface PanelDocument extends TextDoc {
  readonly fileName: string;
}

/** A diagnostic of the document, as the panel lists it. */
export interface PanelDiagnostic {
  readonly severity: MessageSeverity;
  readonly message: string;
  readonly range: EditorRange;
}

/** Everything the state is made of; the host reads it from the editor, the model and the backend. */
export interface PanelInput {
  /** The document the panel follows and the cursor there, if there is one. */
  readonly place?: { readonly doc: PanelDocument; readonly cursor: EditorPosition };
  /** The open document of a file, for a pinned hole in another file than the one followed. */
  documentOf(fileName: string): PanelDocument | undefined;
  /** `workspace.asRelativePath`. */
  relativePath(fileName: string): string;
  readonly model: Pick<HoleModel, 'files' | 'holesIn' | 'rangesText'>;
  /** The pinned hole. */
  readonly pinned?: PinnedHole;
  readonly stale: boolean;
  readonly diagnostics: readonly PanelDiagnostic[];
  readonly choices?: ChoicesView;
  readonly options: DisplayOptions;
  readonly follow: boolean;
  /** Whether a Proof Search or Generate Definition cycle runs in `doc`. */
  hasCycle(doc: PanelDocument): boolean;
  readonly caps: PanelCapabilities;
}

export interface PinnedHole {
  readonly file: string;
  readonly qualifiedName: string;
}

/** Where a button acts: the place and the name the editing commands check (`EditingCommandArgs`). */
export interface PanelTarget {
  readonly position: EditorPosition;
  readonly name: string;
}

/** What the webview's messages refer to, for the state they came from. */
export interface PanelTargets {
  /** The document the buttons act on. */
  readonly doc?: PanelDocument;
  /** The hole shown, when its document is open and has it. */
  readonly hole?: PanelTarget;
  /** The identity of the hole shown, what a pin keeps. */
  readonly shown?: PinnedHole;
  readonly declaration?: PanelTarget;
  /** The binder of each premise a left-hand side binds, by `PremiseView.name`. */
  readonly binders: ReadonlyMap<string, PanelTarget & { readonly range: EditorRange }>;
  /** Of each row of `PanelState.holes`. */
  readonly rows: readonly HoleRef[];
  /** Of each row of `PanelState.messages`. */
  readonly messages: readonly EditorRange[];
  /** The pinned hole is gone from the model. */
  readonly pinLost: boolean;
}

/** Text the panel shows: control and format characters written out, cut at a length it can show. */
const shown = (text: string): string => tooltipText(visible(text));

function locatedIn(doc: PanelDocument, hole: Hole, listed: readonly Hole[], unchanged: boolean): EditorRange | undefined {
  const { range, ordinal } = holeRef(hole, doc.fileName, listed);
  const lineText = (line: number): string | undefined => (line >= 0 && line < doc.lineCount ? doc.lineAt(line).text : undefined);
  return locateHole(syntaxModelOf(doc), lineText, hole.name, range, ordinal, unchanged);
}

/** The `?name` the cursor is on, else the only one on its line (a cursor at the end of `f x = ?h`, past `  -- todo`). */
function cursorHole(doc: PanelDocument, cursor: EditorPosition): HoleTarget | undefined {
  const at = holeAt(doc, cursor);
  const model = syntaxModelOf(doc);
  if (at !== undefined || model === undefined) {
    return at;
  }
  const onLine = holeTokens(model)
    .map((token) => editorRange(model, token))
    .filter((range) => range.start.line === cursor.line);
  return onLine.length === 1 ? holeAt(doc, onLine[0].start) : undefined;
}

const samePlace = (a: EditorPosition, b: EditorPosition): boolean => a.line === b.line && a.character === b.character;

/** The hole of `listed` that the `?name` token `token` of `doc` is. */
function holeOf(token: HoleTarget, doc: PanelDocument, listed: readonly Hole[], unchanged: boolean): Hole | undefined {
  const named = listed.filter((hole) => hole.name === token.name);
  if (named.length <= 1) {
    return named[0];
  }
  return named.find((hole) => {
    const found = locatedIn(doc, hole, listed, unchanged);
    return found !== undefined && samePlace(found.start, token.range.start);
  });
}

function premiseView(premise: Premise, binders: PanelTargets['binders'], offered: ReadonlySet<string>): GoalView['premises'][number] {
  const name = visible(premise.name);
  const text = premiseText(premise);
  return {
    name,
    text: tooltipText(premise.implicit === true ? `{${text}}` : text),
    canSplit: offered.has(name),
    canJump: binders.has(name),
  };
}

/** The `GoalView` of `hole`, and the binders of its premises at `at` in `doc`. */
function goalOf(hole: Hole, doc: PanelDocument | undefined, at: EditorPosition | undefined): { readonly view: GoalView; readonly binders: PanelTargets['binders'] } {
  const binders = new Map<string, PanelTarget & { readonly range: EditorRange }>();
  const offered = new Set<string>();
  for (const variable of doc === undefined || at === undefined ? [] : patternVariablesAround(doc, at)) {
    const key = visible(variable.name);
    binders.set(key, { position: variable.range.start, name: variable.name, range: variable.range });
    if (variable.offered) {
      offered.add(key);
    }
  }
  return {
    view: {
      label: holeLabel(hole),
      qualifiedName: editorLabel(hole.qualifiedName, MAX_ROW_TEXT),
      premises: hole.premises.map((premise) => premiseView(premise, binders, offered)),
      type: shown(hole.type.text),
    },
    binders,
  };
}

/** The hole shown (module comment), its document, and the target of the buttons. */
interface Shown {
  readonly hole?: Hole;
  readonly file?: string;
  readonly doc?: PanelDocument;
  readonly target?: PanelTarget;
  readonly unknown?: string;
  readonly pinLost: boolean;
}

function shownHole(input: PanelInput): Shown {
  const { place, pinned, model } = input;
  const unchangedIn = (doc: PanelDocument): boolean => model.rangesText(doc.fileName) === doc.getText();
  const pinnedHole = pinned === undefined ? undefined : model.holesIn(pinned.file).find((hole) => hole.qualifiedName === pinned.qualifiedName);
  if (pinned !== undefined && pinnedHole !== undefined) {
    const doc = input.documentOf(pinned.file);
    const found = doc === undefined ? undefined : locatedIn(doc, pinnedHole, model.holesIn(pinned.file), unchangedIn(doc));
    return {
      hole: pinnedHole,
      file: pinned.file,
      doc,
      target: found === undefined ? undefined : { position: found.start, name: pinnedHole.name },
      pinLost: false,
    };
  }
  const pinLost = pinned !== undefined;
  const token = place === undefined ? undefined : cursorHole(place.doc, place.cursor);
  if (place === undefined || token === undefined) {
    return { pinLost };
  }
  const listed = model.holesIn(place.doc.fileName);
  const hole = holeOf(token, place.doc, listed, unchangedIn(place.doc));
  return hole === undefined
    ? { doc: place.doc, unknown: editorLabel(`?${token.name}`, MAX_ROW_TEXT), pinLost }
    : { hole, file: place.doc.fileName, doc: place.doc, target: { position: token.range.start, name: token.name }, pinLost };
}

/** The declaration at the cursor, when it has no clauses: Generate Definition's place. */
function declarationOf(input: PanelInput): { readonly view: DeclarationView; readonly target: PanelTarget } | undefined {
  const { place } = input;
  const found = place === undefined ? undefined : declarationAt(place.doc, place.cursor);
  if (found === undefined || found.hasClauses) {
    return undefined;
  }
  return {
    view: { label: editorLabel(found.name, MAX_ROW_TEXT), canGenerate: !found.foreign && !found.several },
    target: { position: found.nameRange.start, name: found.name },
  };
}

/** The rows of **All holes**: the followed file's holes, then the other files'. */
function holeRows(input: PanelInput, current: Hole | undefined): { readonly rows: HoleRow[]; readonly refs: HoleRef[]; readonly more: number } {
  const first = input.place?.doc.fileName;
  const files = [...(first === undefined ? [] : [first]), ...input.model.files().filter((file) => file !== first)];
  const rows: HoleRow[] = [];
  const refs: HoleRef[] = [];
  let more = 0;
  for (const file of files) {
    const listed = input.model.holesIn(file);
    const take = Math.max(0, Math.min(listed.length, MAX_HOLE_ROWS - rows.length));
    more += listed.length - take;
    for (const hole of listed.slice(0, take)) {
      const line = hole.location?.range.start.line;
      rows.push({
        label: holeLabel(hole),
        type: editorLabel(holeDescription(hole), MAX_ROW_TEXT),
        place: `${editorLabel(input.relativePath(file), MAX_ROW_TEXT)}${line === undefined ? '' : `:${line + 1}`}`,
        current: hole.qualifiedName === current?.qualifiedName,
      });
      refs.push(holeRef(hole, file, listed));
    }
  }
  return { rows, refs, more };
}

/** The panel at `input`: what to show, without its version, and the targets of that. */
export function buildPanel(input: PanelInput): { readonly state: Omit<PanelState, 'version'>; readonly targets: PanelTargets } {
  const shownNow = shownHole(input);
  const { hole, doc, target } = shownNow;
  const goal = hole === undefined ? undefined : goalOf(hole, doc, target?.position);
  const declaration = hole === undefined && shownNow.unknown === undefined ? declarationOf(input) : undefined;
  const holes = holeRows(input, hole);
  const diagnostics = [...input.diagnostics].sort((a, b) => a.range.start.line - b.range.start.line).slice(0, MAX_MESSAGE_ROWS);
  const messages: MessageRow[] = diagnostics.map((d) => ({ severity: d.severity, line: d.range.start.line + 1, text: shown(d.message) }));
  // A pinned hole whose file is not open, or no longer has it, has nothing the buttons can act on.
  const caps = goal !== undefined && target === undefined ? { editing: false, editingNext: false, intro: false, refine: false } : input.caps;
  const file = input.place?.doc.fileName;
  const buttonsDoc = doc ?? input.place?.doc;
  return {
    state: {
      ...(file === undefined ? {} : { file: editorLabel(input.relativePath(file), MAX_ROW_TEXT) }),
      stale: input.stale,
      ...(goal === undefined ? {} : { goal: goal.view }),
      ...(shownNow.unknown === undefined ? {} : { unknownHole: shownNow.unknown }),
      ...(declaration === undefined ? {} : { declaration: declaration.view }),
      ...(input.choices === undefined ? {} : { choices: input.choices }),
      holes: holes.rows,
      moreHoles: holes.more,
      messages,
      moreMessages: input.diagnostics.length - messages.length,
      options: input.options,
      pinned: hole !== undefined && input.pinned !== undefined && !shownNow.pinLost,
      follow: input.follow,
      cycle: buttonsDoc !== undefined && input.hasCycle(buttonsDoc),
      caps,
    },
    targets: {
      doc: buttonsDoc,
      ...(target === undefined ? {} : { hole: target }),
      ...(hole === undefined || shownNow.file === undefined ? {} : { shown: { file: shownNow.file, qualifiedName: hole.qualifiedName } }),
      ...(declaration === undefined ? {} : { declaration: declaration.target }),
      binders: goal?.binders ?? new Map(),
      rows: holes.refs,
      messages: diagnostics.map((d) => d.range),
      pinLost: shownNow.pinLost,
    },
  };
}

/** A goal as Markdown (**Copy**): the hole's name, then its premises, a rule and its type in a code block. */
export function goalMarkdown(goal: GoalView): string {
  const lines = [...goal.premises.map((premise) => premise.text), '-'.repeat(30), goal.type];
  return `**${goal.label}** (${goal.qualifiedName})\n${codeBlock(lines.join('\n'), 'idris2')}`;
}
