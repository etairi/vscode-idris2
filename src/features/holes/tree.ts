/**
 * The Holes view's tree (`types.ts`, *The Holes view*): file → hole → premises, from the
 * `HoleModel`. Only type imports from `vscode`: `register.ts` passes the classes it needs
 * (`HolesTreeApi`).
 *
 * **Untrusted text.** A hole's name and type and its premises are compiler text. Labels and
 * descriptions are strings, one line each (`editorLabel`: control and format characters written
 * out, line breaks as spaces). VS Code 1.139.1 draws no theme icon in a tree item's string label or
 * description: its renderer passes `supportIcons` only for a `MarkdownString` label (`processLabel`
 * returns `{label}` alone for a string, and the view's resource labels are created without
 * `supportIcons` [src, the workbench bundle]); so `$(…)` in a type is shown as it is. The tooltip
 * is a plain string (`visible`: control and format characters written out, lines kept), cut at
 * `MAX_TOOLTIP`, and made only on hover (`resolveTreeItem`): VS Code sends every item's tooltip
 * with the item at each refresh otherwise (`tooltip` in the extension host's tree nodes; it asks
 * `resolveTreeItem` only for an item without one [src, VS Code 1.139.1]).
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import type { Hole, Premise } from '../../backend/types';
import type { EditorRange } from '../../core/positions';
import { editorLabel, visible } from '../../core/untrustedText';
import { compareHoles } from './model';
import type { HoleModel } from './types';

/** The internal command a hole's item runs (registered, not contributed: `register.ts`). */
export const REVEAL_HOLE_COMMAND = 'idris2.revealHole';

/** The longest label or description, in UTF-16 code units (a type can be very long). */
const MAX_LABEL = 500;

/** The longest tooltip, in UTF-16 code units. */
const MAX_TOOLTIP = 10_000;

/** `text` cut at `MAX_TOOLTIP` (at a code point's boundary), with `…` when cut. */
function tooltipText(text: string): string {
  if (text.length <= MAX_TOOLTIP) {
    return text;
  }
  const last = text.charCodeAt(MAX_TOOLTIP - 2);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_TOOLTIP - 2 : MAX_TOOLTIP - 1;
  return `${text.slice(0, end)}…`;
}

/** What the reveal command is given: which hole, where it was recorded. Plain data (a command argument). */
export interface HoleRef {
  /** The file to look in: the one it is listed under (`model.ts` `holeGroup`). */
  readonly file: string;
  /** Unqualified, without `?`. */
  readonly name: string;
  /** `Hole.location`'s range, when the hole has one in `file`. */
  readonly range?: EditorRange;
  /**
   * When `file` holds more than one hole of the name with a location (in different namespaces of one
   * module, `NS.A.todo` and `NS.B.todo`, which load cleanly [live, M4's ninth review]): this one's
   * `index` among them in document order, of `count` (`navigation.ts` `locateHole`).
   */
  readonly ordinal?: { readonly index: number; readonly count: number };
}

/** A hole's place among the located holes of its name in one file (`HoleRef.ordinal`). */
type Ordinal = NonNullable<HoleRef['ordinal']>;

/** `holeOrdinals` per list of holes: the model replaces a file's list, never changes it. */
const ordinalsOf = new WeakMap<readonly Hole[], ReadonlyMap<string, Ordinal>>();

/**
 * The ordinal of each located hole of `listed` whose name another located hole there has, by
 * qualified name: one pass over the list (each item's `holeRef` filtering it again made a refresh
 * quadratic, 10,000 holes 0.7 s [unit-level, M4's eleventh review]).
 */
function holeOrdinals(listed: readonly Hole[]): ReadonlyMap<string, Ordinal> {
  let ordinals = ordinalsOf.get(listed);
  if (ordinals === undefined) {
    const byName = new Map<string, Hole[]>();
    for (const h of listed) {
      if (h.location !== undefined) {
        const named = byName.get(h.name);
        if (named === undefined) {
          byName.set(h.name, [h]);
        } else {
          named.push(h);
        }
      }
    }
    const found = new Map<string, Ordinal>();
    for (const named of byName.values()) {
      if (named.length > 1) {
        named.sort(compareHoles).forEach((h, index) => found.set(h.qualifiedName, { index, count: named.length }));
      }
    }
    ordinals = found;
    ordinalsOf.set(listed, ordinals);
  }
  return ordinals;
}

/**
 * The `HoleRef` of `hole`, listed under the file `file` (its location's, or the loaded file's), among
 * `listed`, the holes listed under that file with it.
 */
export function holeRef(hole: Hole, file: string, listed: readonly Hole[]): HoleRef {
  const range = hole.location?.range;
  if (range === undefined) {
    return { file, name: hole.name };
  }
  const ordinal = holeOrdinals(listed).get(hole.qualifiedName);
  return {
    file,
    name: hole.name,
    range: { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } },
    ...(ordinal !== undefined ? { ordinal } : {}),
  };
}

/** `0 `, `1 ` or nothing (unrestricted, or not reported), before a premise's name. */
function multiplicityPrefix(premise: Premise): string {
  return premise.multiplicity === 0 ? '0 ' : premise.multiplicity === 1 ? '1 ' : '';
}

/** A premise as its item's label: `0 a : Type`, `1 x : a`, `xs : Vect n a`. */
export function premiseLabel(premise: Premise): string {
  return editorLabel(`${multiplicityPrefix(premise)}${premise.name} : ${premise.type.text}`, MAX_LABEL);
}

/** A hole's label: `?vlen_rhs`. */
export function holeLabel(hole: Hole): string {
  return editorLabel(`?${hole.name}`, MAX_LABEL);
}

/** A hole's description: its goal type, on one line. */
export function holeDescription(hole: Hole): string {
  return editorLabel(hole.type.text, MAX_LABEL);
}

/** A premise's line in a tooltip: its label's text, the compiler's line breaks kept. */
function premiseText(premise: Premise): string {
  return visible(`${multiplicityPrefix(premise)}${premise.name} : ${premise.type.text}`);
}

/**
 * A hole's tooltip, as the compiler's REPL shows a goal: the premises, a rule, the hole and its
 * type; plain text, the compiler's line breaks kept, cut at `MAX_TOOLTIP`.
 */
export function holeTooltip(hole: Hole): string {
  return tooltipText([...hole.premises.map(premiseText), '-'.repeat(30), visible(`${hole.name} : ${hole.type.text}`)].join('\n'));
}

/** A premise's tooltip: `premiseText`, cut at `MAX_TOOLTIP`. */
export function premiseTooltip(premise: Premise): string {
  return tooltipText(premiseText(premise));
}

/** The badge of the view: the number of holes, none when there is no hole. */
export function holesBadge(count: number): vscode.ViewBadge | undefined {
  return count === 0 ? undefined : { value: count, tooltip: count === 1 ? '1 hole' : `${count} holes` };
}

/**
 * An item of the tree: a file, a module whose holes have no location (`HoleModel.modules`), a hole
 * (`parent`: its parent's id; `file`: the file it is listed under, none under a module), a premise.
 */
export type HoleNode =
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'module'; readonly module: string }
  | { readonly kind: 'hole'; readonly parent: string; readonly file: string | undefined; readonly hole: Hole }
  | { readonly kind: 'premise'; readonly id: string; readonly premise: Premise };

/** The id of a module's item: not an absolute path, so no file's id. */
const moduleId = (module: string): string => `module ${module}`;

/** The parts of the `vscode` namespace the tree uses. */
export type HolesTreeApi = Pick<typeof vscode, 'TreeItem' | 'TreeItemCollapsibleState' | 'ThemeIcon' | 'Uri' | 'EventEmitter'> & {
  readonly workspace: Pick<typeof vscode.workspace, 'asRelativePath'>;
};

/**
 * The tree data of the view. `dirty(file)`: whether the editor shows the file with unsaved changes,
 * so that its holes are as the compiler last read the file (`HoleModel`, *What it describes*).
 */
export class HolesTree implements vscode.TreeDataProvider<HoleNode> {
  private readonly changed: vscode.EventEmitter<HoleNode | undefined>;
  readonly onDidChangeTreeData: vscode.Event<HoleNode | undefined>;

  constructor(
    private readonly api: HolesTreeApi,
    private readonly model: HoleModel,
    private readonly dirty: (file: string) => boolean,
  ) {
    this.changed = new api.EventEmitter<HoleNode | undefined>();
    this.onDidChangeTreeData = this.changed.event;
  }

  /** Redraws the whole tree (it is small: one item per file, hole and premise). */
  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: HoleNode): HoleNode[] {
    if (node === undefined) {
      return [...this.model.files().map((file): HoleNode => ({ kind: 'file', file })), ...this.model.modules().map((module): HoleNode => ({ kind: 'module', module }))];
    }
    if (node.kind === 'file') {
      return this.model.holesIn(node.file).map((hole) => ({ kind: 'hole', parent: node.file, file: node.file, hole }));
    }
    if (node.kind === 'module') {
      return this.model.holesOfModule(node.module).map((hole) => ({ kind: 'hole', parent: moduleId(node.module), file: undefined, hole }));
    }
    if (node.kind === 'hole') {
      return node.hole.premises.map((premise, i) => ({ kind: 'premise', id: `${node.parent}\n${node.hole.qualifiedName}\n${i}`, premise }));
    }
    return [];
  }

  getTreeItem(node: HoleNode): vscode.TreeItem {
    const { TreeItem, TreeItemCollapsibleState, ThemeIcon } = this.api;
    switch (node.kind) {
      case 'file': {
        const item = new TreeItem(editorLabel(path.basename(node.file), MAX_LABEL), TreeItemCollapsibleState.Expanded);
        const dirty = this.dirty(node.file);
        // The directory as `asRelativePath` writes the file's path (relative to its workspace folder,
        // else absolute); nothing for a file at the top of a folder.
        const dir = path.dirname(this.api.workspace.asRelativePath(node.file));
        const where = dir === '.' ? '' : editorLabel(dir, MAX_LABEL);
        item.id = node.file;
        item.resourceUri = this.api.Uri.file(node.file);
        item.iconPath = ThemeIcon.File;
        item.description = dirty ? (where === '' ? 'unsaved changes' : `${where} · unsaved changes`) : where;
        item.tooltip = dirty
          ? `${visible(node.file)}\nThe holes as the compiler last read the file; the editor shows unsaved changes.`
          : visible(node.file);
        return item;
      }
      case 'module': {
        const item = new TreeItem(editorLabel(node.module, MAX_LABEL), TreeItemCollapsibleState.Expanded);
        item.id = moduleId(node.module);
        item.iconPath = new ThemeIcon('symbol-namespace');
        item.description = 'no source location';
        item.tooltip = `${visible(node.module)}\nThe compiler gave no place in a source file for these holes (for example, the module's source was not found).`;
        return item;
      }
      case 'hole': {
        const { hole } = node;
        const item = new TreeItem(
          holeLabel(hole),
          hole.premises.length > 0 ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
        );
        item.id = `${node.parent}\n${hole.qualifiedName}`;
        item.description = holeDescription(hole);
        item.iconPath = new ThemeIcon('question');
        if (node.file !== undefined) {
          item.command = { command: REVEAL_HOLE_COMMAND, title: 'Go to Hole', arguments: [holeRef(hole, node.file, this.model.holesIn(node.file))] };
        }
        return item;
      }
      case 'premise': {
        const item = new TreeItem(premiseLabel(node.premise), TreeItemCollapsibleState.None);
        item.id = node.id;
        return item;
      }
    }
  }

  /** The tooltip of a hole's or a premise's item, on hover (module comment). */
  resolveTreeItem(item: vscode.TreeItem, node: HoleNode): vscode.TreeItem {
    if (node.kind === 'hole') {
      // Under a module, the qualified name first: the label has the name alone.
      item.tooltip = node.file === undefined ? tooltipText(`${visible(node.hole.qualifiedName)}\n${holeTooltip(node.hole)}`) : holeTooltip(node.hole);
    } else if (node.kind === 'premise') {
      item.tooltip = premiseTooltip(node.premise);
    }
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
