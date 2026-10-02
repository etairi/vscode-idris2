/**
 * `registerHoles` (`types.ts`): the `HoleModel`, the Holes view, **Idris 2: Next Hole**, **Previous
 * Hole** and **List Holes**, and the internal command that reveals a hole (`tree.ts`
 * `REVEAL_HOLE_COMMAND`). Only type imports from `vscode`: `extension.ts` passes the `vscode`
 * namespace as `api`.
 *
 * Every handler catches what it throws and shows it as one `plainText(…)` notification (CLAUDE.md,
 * M2 rule; `guarded`), and every command that finds nothing to do says why (ARCHITECTURE §3.1).
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import type { Hole } from '../../backend/types';
import { DisposableStore } from '../../core/disposable';
import { holeTokenNames } from '../../core/idrisSyntax';
import { plainText } from '../../core/notificationText';
import { editorLabel, quickPickText } from '../../core/untrustedText';
import { compilerLiterateStyleOf, isIdrisDocument, isIdrisSourceFileName } from '../../project/literate';
import { isCheckable } from '../diagnostics/checks';
import { longRunning } from '../editing/longRunning';
import { CANCEL_OFFER_MS } from '../eval/register';
import { offsetOf, syntaxModelOf } from '../intelligence/occurrence';
import { compareHoles, declaredModule, holeGroup, HoleStore } from './model';
import { editorRange, holeTokens, locateHole, namedHoles, nextHole, previousHole } from './navigation';
import { HolesTree, holeDescription, holeLabel, holeRef, holesBadge, REVEAL_HOLE_COMMAND, type HoleNode, type HoleRef, type HolesTreeApi } from './tree';
import type { HolesDeps, HolesRegistration } from './types';

export const NEXT_HOLE_COMMAND = 'idris2.nextHole';
export const PREVIOUS_HOLE_COMMAND = 'idris2.previousHole';
export const LIST_HOLES_COMMAND = 'idris2.listHoles';
const HOLES_VIEW = 'idris2.holes';

/** The parts of the `vscode` namespace this module uses. */
export type HolesApi = HolesTreeApi &
  Pick<typeof vscode, 'commands' | 'window' | 'Range' | 'Selection' | 'TextEditorRevealType' | 'QuickPickItemKind' | 'ProgressLocation' | 'CancellationTokenSource'> & {
    readonly workspace: Pick<
      typeof vscode.workspace,
      | 'asRelativePath'
      | 'textDocuments'
      | 'openTextDocument'
      | 'onDidChangeTextDocument'
      | 'onDidSaveTextDocument'
      | 'onDidOpenTextDocument'
      | 'onDidCloseTextDocument'
      | 'onDidDeleteFiles'
      | 'onDidRenameFiles'
      | 'createFileSystemWatcher'
    >;
  };

/** What `registerHoles` returns: the model, and for the test API the tree and its view. */
export interface Holes extends HolesRegistration {
  readonly tree: HolesTree;
  readonly view: vscode.TreeView<HoleNode>;
}

/** The longest name a notification quotes, in UTF-16 code units. */
const MAX_QUOTED = 100;

const NO_IDRIS_EDITOR = 'Idris 2: this command needs an Idris file in the active editor.';
const NO_FILE = 'Idris 2: List Holes needs an Idris file saved on disk in the active editor.';
const NOT_MODELLED =
  'Idris 2: Next Hole and Previous Hole read Idris source files (.idr) and bird-track literate files (.lidr); this literate style is not read yet.';

/**
 * A QuickPick item of List Holes: a hole (with where to reveal it, or, under a module, the hole with
 * no source location) or a file's or a module's separator.
 */
interface HoleItem extends vscode.QuickPickItem {
  readonly ref?: HoleRef;
  readonly unlocated?: Hole;
}

/** Whether `value` is a `HoleRef` (the reveal command's argument, which anything may pass). */
function isHoleRef(value: unknown): value is HoleRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { file, name, range, ordinal } = value as Record<string, unknown>;
  const position = (p: unknown): boolean =>
    typeof p === 'object' && p !== null && Number.isInteger((p as Record<string, unknown>).line) && Number.isInteger((p as Record<string, unknown>).character);
  const validRange = range === undefined || (typeof range === 'object' && range !== null && position((range as Record<string, unknown>).start) && position((range as Record<string, unknown>).end));
  const { index, count } = (typeof ordinal === 'object' && ordinal !== null ? ordinal : {}) as Record<string, unknown>;
  const validOrdinal = ordinal === undefined || (Number.isInteger(index) && Number.isInteger(count) && (index as number) >= 0 && (index as number) < (count as number));
  return typeof file === 'string' && path.isAbsolute(file) && typeof name === 'string' && name !== '' && validRange && validOrdinal;
}

/** What tests may set. */
export interface RegisterHolesOptions {
  /** `CANCEL_OFFER_MS` unless a test sets it. */
  readonly cancelOfferMs?: number;
}

export function registerHoles(api: HolesApi, deps: HolesDeps, options: RegisterHolesOptions = {}): Holes {
  const store = new DisposableStore();

  const openDocument = (fileName: string): vscode.TextDocument | undefined =>
    api.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.fileName === fileName);
  const dirty = (fileName: string): boolean => openDocument(fileName)?.isDirty ?? false;

  const model = store.add(
    new HoleStore({
      loads: deps.loads,
      releases: deps.releases,
      registry: deps.registry,
      openDocument,
      log: deps.log,
      warn: (text) => void api.window.showWarningMessage(plainText(text)),
    }),
  );
  const tree = store.add(new HolesTree(api, model, dirty));
  const view = store.add(api.window.createTreeView(HOLES_VIEW, { treeDataProvider: tree, showCollapseAll: true }));

  // What each file's item says about unsaved changes, so that a keystroke redraws nothing unless
  // the file's dirty state changed.
  const shownDirty = new Map<string, boolean>();
  const redraw = (): void => {
    shownDirty.clear();
    for (const file of model.files()) {
      shownDirty.set(file, dirty(file));
    }
    const count = model.files().reduce((n, file) => n + model.holesIn(file).length, 0) + model.modules().reduce((n, module) => n + model.holesOfModule(module).length, 0);
    view.badge = holesBadge(count);
    tree.refresh();
  };
  store.add(model.onDidChange(redraw));
  const dirtyChanged = (doc: vscode.TextDocument): void => {
    if (doc.uri.scheme === 'file' && shownDirty.has(doc.fileName) && shownDirty.get(doc.fileName) !== dirty(doc.fileName)) {
      redraw();
    }
  };
  store.add(api.workspace.onDidChangeTextDocument((e) => dirtyChanged(e.document)));
  store.add(api.workspace.onDidSaveTextDocument(dirtyChanged));
  store.add(api.workspace.onDidOpenTextDocument(dirtyChanged));
  store.add(api.workspace.onDidCloseTextDocument(dirtyChanged));
  const files = (uris: readonly vscode.Uri[]): string[] => uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
  store.add(api.workspace.onDidDeleteFiles((e) => model.forget(files(e.files))));
  // Deletions on disk (a checkout, `rm`), which `onDidDeleteFiles` does not report (vscode.d.ts 1.138 [doc]).
  const onDisk = store.add(api.workspace.createFileSystemWatcher('**/*', true, true, false));
  store.add(onDisk.onDidDelete((uri) => model.forget(files([uri]))));
  store.add(api.workspace.onDidRenameFiles((e) => model.forget(files(e.files.map((f) => f.oldUri)))));

  const notify = (text: string): void => {
    void api.window.showInformationMessage(plainText(text));
  };

  const guarded =
    (what: string, run: (...args: unknown[]) => Promise<void>) =>
    async (...args: unknown[]): Promise<void> => {
      try {
        await run(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.error(`Holes: ${what} failed: ${message}`);
        notify(editorLabel(`Idris 2: ${what} failed: ${message}`));
      }
    };

  // --- Next / Previous Hole ----------------------------------------------------------------------

  const move = async (direction: 'next' | 'previous'): Promise<void> => {
    const editor = api.window.activeTextEditor;
    if (editor === undefined || !isIdrisDocument(editor.document)) {
      notify(NO_IDRIS_EDITOR);
      return;
    }
    const syntax = syntaxModelOf(editor.document);
    if (syntax === undefined) {
      notify(NOT_MODELLED);
      return;
    }
    const holes = holeTokens(syntax);
    const from = offsetOf(syntax, editor.selection.start);
    const step = direction === 'next' ? nextHole(holes, from) : previousHole(holes, from);
    if (step === undefined) {
      notify('Idris 2: there is no hole (?name) in this file.');
      return;
    }
    const { start, end } = editorRange(syntax, step.hole);
    const range = new api.Range(start.line, start.character, end.line, end.character);
    if (editor.selection.isEqual(range)) {
      // Wrapped around to the hole already selected: the only one.
      notify('Idris 2: this is the only hole in this file.');
      return;
    }
    editor.selection = new api.Selection(range.start, range.end);
    editor.revealRange(range, api.TextEditorRevealType.InCenterIfOutsideViewport);
    if (step.wrapped) {
      // Hidden again after 3 s; nothing to dispose.
      api.window.setStatusBarMessage(direction === 'next' ? 'Idris 2: went around to the first hole' : 'Idris 2: went around to the last hole', 3000);
    }
  };
  store.add(api.commands.registerCommand(NEXT_HOLE_COMMAND, guarded('Next Hole', () => move('next'))));
  store.add(api.commands.registerCommand(PREVIOUS_HOLE_COMMAND, guarded('Previous Hole', () => move('previous'))));

  // --- revealing a hole ------------------------------------------------------------------------

  const reveal = async (ref: HoleRef): Promise<void> => {
    const shown = `?${editorLabel(ref.name, MAX_QUOTED)}`;
    const base = editorLabel(path.basename(ref.file), MAX_QUOTED);
    let doc = openDocument(ref.file);
    if (doc === undefined) {
      try {
        doc = await api.workspace.openTextDocument(api.Uri.file(ref.file));
      } catch (error) {
        deps.log.warn(`Holes: opening ${ref.file} failed: ${error instanceof Error ? error.message : String(error)}`);
        notify(`Idris 2: ${base}, the file of ${shown}, cannot be opened.`);
        return;
      }
    }
    const text = doc;
    const syntax = syntaxModelOf(text);
    const lineText = (line: number): string | undefined => (line >= 0 && line < text.lineCount ? text.lineAt(line).text : undefined);
    // A recorded range is trusted only while the document shows the text it was read from.
    const found = locateHole(syntax, lineText, ref.name, ref.range, ref.ordinal, model.rangesText(ref.file) === text.getText());
    if (found === undefined) {
      // With an ordinal, another number of them leaves the hole unknown, not gone.
      const now = ref.ordinal !== undefined && syntax !== undefined ? namedHoles(syntax, ref.name).length : 0;
      notify(
        ref.range === undefined
          ? `Idris 2: the compiler gave no place for ${shown}, and ${base} has no ${shown}.`
          : now > 0 && ref.ordinal !== undefined
            ? `Idris 2: ${base} now has ${now} ${shown} and the compiler listed ${ref.ordinal.count}, so which one this is is not known: ${text.isDirty ? 'save the file to check it again' : 'check the file again (it must load without errors)'}.`
            : `Idris 2: ${shown} is not in ${base} any more: the file changed since the compiler read it.`,
      );
      return;
    }
    await api.window.showTextDocument(text, { selection: new api.Range(found.start.line, found.start.character, found.end.line, found.end.character) });
  };
  store.add(
    api.commands.registerCommand(
      REVEAL_HOLE_COMMAND,
      guarded('Go to Hole', async (ref) => {
        if (!isHoleRef(ref) || !isIdrisSourceFileName(path.basename(ref.file))) {
          deps.log.warn(`Holes: ${REVEAL_HOLE_COMMAND} was run with an argument that names no hole of an Idris file.`);
          notify('Idris 2: Go to Hole needs a hole of an Idris file.');
          return;
        }
        await reveal(ref);
      }),
    ),
  );

  // --- List Holes -------------------------------------------------------------------------------

  const listItems = (holes: readonly Hole[], loaded: vscode.TextDocument): HoleItem[] => {
    const loadedText = loaded.getText();
    const inLoaded = holeTokenNames(loadedText);
    const module = declaredModule(loadedText, compilerLiterateStyleOf(loaded));
    const files = new Map<string, Hole[]>([[loaded.fileName, []]]);
    const modules = new Map<string, Hole[]>();
    for (const hole of holes) {
      const group = holeGroup(hole, loaded.fileName, inLoaded, module);
      const [into, key] = group.kind === 'file' ? [files, group.file] : [modules, group.module];
      const listed = into.get(key);
      if (listed === undefined) {
        into.set(key, [hole]);
      } else {
        listed.push(hole);
      }
    }
    const item = (hole: Hole, file: string | undefined): HoleItem => ({
      label: quickPickText(holeLabel(hole)),
      description: quickPickText(holeDescription(hole)),
      ...(file === undefined ? { unlocated: hole } : { ref: holeRef(hole, file, files.get(file) ?? []) }),
    });
    const separator = (label: string): HoleItem => ({ label: quickPickText(editorLabel(label, 200)), kind: api.QuickPickItemKind.Separator });
    const order = [loaded.fileName, ...[...files.keys()].filter((f) => f !== loaded.fileName).sort()];
    return [
      ...order.flatMap((file) => {
        const group = files.get(file) ?? [];
        return group.length === 0 ? [] : [separator(api.workspace.asRelativePath(file)), ...group.sort(compareHoles).map((hole) => item(hole, file))];
      }),
      ...[...modules.keys()].sort().flatMap((module) => [separator(`${module} (no source location)`), ...(modules.get(module) ?? []).map((hole) => item(hole, undefined))]),
    ];
  };

  store.add(
    api.commands.registerCommand(
      LIST_HOLES_COMMAND,
      guarded('List Holes', async () => {
        const editor = api.window.activeTextEditor;
        if (editor === undefined || !isCheckable(editor.document)) {
          notify(NO_FILE);
          return;
        }
        const doc = editor.document;
        // As the editing commands' long requests: when another file of the project was loaded last,
        // this file is checked first (a load, then its holes), and a listing can take up to
        // idris2.ideMode.longActionTimeout, so Cancel is offered (`longRunning`; a cancel restarts the
        // check session while the listing runs, `HolesOptions.token`).
        const asked = await longRunning(
          api,
          'List Holes',
          (token) => deps.queries.run(doc, 'command', (backend) => backend.holes(doc, { token })),
          options.cancelOfferMs ?? CANCEL_OFFER_MS,
          true,
        );
        if (asked.cancelled) {
          return;
        }
        const outcome = asked.value;
        if (outcome.kind === 'unavailable') {
          notify(editorLabel(`Idris 2: ${outcome.reason}`));
          return;
        }
        if (outcome.value.length === 0) {
          notify(
            model.lastLoadFailed(doc.fileName)
              ? 'Idris 2: the compiler lists no holes, but the file did not load cleanly, which can hide them. Fix the first error and save.'
              : 'Idris 2: the compiler reports no holes in this file and the modules it imports.',
          );
          return;
        }
        const picked = await api.window.showQuickPick(listItems(outcome.value, doc), {
          // After a failed load the compiler may list only the imports' holes [live, M4's ninth review].
          title: model.lastLoadFailed(doc.fileName)
            ? 'Idris 2: List Holes — the file did not load cleanly, so its own holes may be missing: fix the first error and save'
            : 'Idris 2: List Holes',
          placeHolder: doc.isDirty ? 'The holes as the file was saved (it has unsaved changes): pick one to go to it' : 'Pick a hole to go to it',
          matchOnDescription: true,
        });
        if (picked?.ref !== undefined) {
          await reveal(picked.ref);
        } else if (picked?.unlocated !== undefined) {
          notify(editorLabel(`Idris 2: the compiler gave no source location for ?${picked.unlocated.name} (${picked.unlocated.qualifiedName}).`, 300));
        }
      }),
    ),
  );

  return { model, tree, view, dispose: () => store.dispose() };
}
