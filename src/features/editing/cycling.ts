/**
 * The `CyclingController` (ARCHITECTURE §10; `types.ts`, *Cycling*): the cycles of results of
 * **Proof Search** and **Generate Definition**, one per document at most, and the status-bar item
 * `↻ next (n)` of the active editor's cycle, which runs the next.
 *
 * A cycle starts when the first result of a search was applied (`start`) and follows the range of
 * the result applied last; **Next Result** (a cycle of either kind, ROADMAP §9 Q26) and **Next
 * Definition** (a Generate Definition's) replace that range with the next result (`advance`). It
 * ends — and `lastEnd` keeps the reason for the next command — when:
 * - its document changes other than by the result the command applies (`applyOwn`), or closes;
 * - a file of its root is loaded (`LoadNotifications`): every load resets the compiler's search
 *   (`loadMainFile` → `resetProofState`, `Idris/REPL.idr` 833–845 on v0.8.0 [src]);
 * - another search starts in its root (`searchStarted`); a search's first result starts no cycle
 *   when another search started in its root after it, even before its answer came. The compiler keeps the last Proof Search
 *   and the last Generate Definition apart (`psResult`, `gdResult`, `Idris/REPL/Opts.idr` 49–50
 *   [src]), so ending both is more than the compiler needs; it is the rule the backend applies too
 *   (`backend/types.ts` `NextRequest`);
 * - the next request finds no more results, fails or is cancelled (`end`, by the command).
 *
 * **Saves.** While a document has a cycle its saves check nothing (`SaveCheckHolds`): with VS
 * Code's `files.autoSave` or `idris2.checking.trigger` = `afterDelay`, the save that follows an
 * applied result would load the file about a second later and end the cycle (UX review of M4). The
 * hold ends with the cycle, and the document is then checked if it was saved meanwhile.
 *
 * **Its own change.** The command applies a result through `applyOwn`, which counts the document's
 * text changes while `workspace.applyEdit` runs: exactly one is the result's own. The workbench
 * forwards a model's change to the extension host as it happens (`onDidChangeContent` →
 * `$acceptModelChanged`, VS Code 1.139.1's workbench bundle [src]), so while applying the edit,
 * before it answers `$tryApplyWorkspaceEdit` [reasoned from that source; the order of the two
 * messages was not observed]. None, or more than one, and the cycle does not go on: another change
 * came in, or the result's came late (`applyOwn`'s callers end or do not start the cycle).
 *
 * Only type imports from `vscode`.
 */
import type * as vscode from 'vscode';
import { rootKey } from '../../backend/registry';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { EditorPosition, EditorRange } from '../../core/positions';
import type { SaveCheckHolds } from '../diagnostics/checks';
import type { LoadNotifications } from '../intelligence/types';
import type { CycleState } from './types';

/** The part of the `vscode` namespace the controller uses. */
export interface CyclingApi {
  readonly window: Pick<typeof vscode.window, 'activeTextEditor' | 'onDidChangeActiveTextEditor' | 'createStatusBarItem'>;
  readonly workspace: Pick<typeof vscode.workspace, 'onDidChangeTextDocument' | 'onDidCloseTextDocument'>;
  readonly StatusBarAlignment: typeof vscode.StatusBarAlignment;
}

export type CycleKind = CycleState['kind'];

/** Why a cycle ended (module comment); `CYCLE_ENDED` has the sentences. */
export type CycleEnd = 'changed' | 'loaded' | 'anotherSearch' | 'exhausted' | 'failed' | 'cancelled';

/** How the next command explains an end: "the Proof Search ended: <this>." */
export const CYCLE_ENDED: Readonly<Record<CycleEnd, string>> = {
  changed: 'the file was changed after its last result',
  loaded: 'a file of its project was loaded again, which ends the compiler\'s search',
  anotherSearch: 'another search started in its project',
  exhausted: 'there were no more results',
  failed: 'its last request failed',
  cancelled: 'its last request was cancelled',
};

/**
 * The command of each kind of cycle: the status-bar item's, and the title the backend's refusals of
 * that kind's `-Next` start with (`commands.ts`). Next Result continues either kind.
 */
export const NEXT_COMMAND: Readonly<Record<CycleKind, 'idris2.nextResult' | 'idris2.nextDefinition'>> = {
  exprSearch: 'idris2.nextResult',
  generateDef: 'idris2.nextDefinition',
};

/** A cycle as the controller keeps it. */
interface Cycle extends CycleState {
  /** `rootKey` of the document's root. */
  readonly root: string;
  /** Generate Definition: the declaration's range, where `g` continues the cycle (`continuesDefinition`). */
  readonly declaration: EditorRange | undefined;
  /** The hold of the document's save checks while the cycle runs (module comment). */
  readonly hold: IDisposable;
}

/**
 * Whether `pos` is in `range`, its end included unless it is the start of a line: a range ending
 * there covers a text that ends with a line break (a definition inserted above other code), and the
 * position is the next line's, whose code is not the range's.
 */
const within = (pos: EditorPosition, range: EditorRange): boolean =>
  (pos.line > range.start.line || (pos.line === range.start.line && pos.character >= range.start.character)) &&
  (pos.line < range.end.line || (pos.line === range.end.line && pos.character <= range.end.character && range.end.character > 0));

export class CyclingController implements IDisposable {
  private readonly store = new DisposableStore();
  private readonly cycles = new Map<string, Cycle>();
  private readonly ended = new Map<string, { readonly kind: CycleKind; readonly why: CycleEnd }>();
  /**
   * Per root (`rootKey`), how many loads and searches it has seen, and why the last one counted:
   * a cycle starts only if none came between its search's answer and its start (`start`).
   */
  private readonly epochs = new Map<string, { readonly count: number; readonly why: CycleEnd }>();
  /** Per root (`rootKey`), the search started there last (`searchStarted`). */
  private readonly lastSearch = new Map<string, number>();
  private searches = 0;
  /** Per document (`uri.toString()`) whose result is being applied, the text changes seen meanwhile. */
  private readonly applying = new Map<string, number>();
  private readonly item: vscode.StatusBarItem;
  /** Whether `item` is shown. */
  private shown = false;

  constructor(
    private readonly api: CyclingApi,
    loads: LoadNotifications,
    private readonly holds: SaveCheckHolds,
  ) {
    this.item = this.store.add(api.window.createStatusBarItem('idris2.cycling', api.StatusBarAlignment.Left, 0));
    this.item.name = 'Idris 2: Next Result / Next Definition';
    this.store.add(loads.onDidLoad((loaded) => this.endRoot(rootKey(loaded.root), 'loaded')));
    this.store.add(
      api.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) {
          return; // the dirty state alone
        }
        const uri = e.document.uri.toString();
        const seen = this.applying.get(uri);
        if (seen !== undefined) {
          this.applying.set(uri, seen + 1);
        } else {
          this.end(uri, 'changed');
        }
      }),
    );
    this.store.add(
      api.workspace.onDidCloseTextDocument((doc) => {
        const uri = doc.uri.toString();
        this.cycles.get(uri)?.hold.dispose();
        this.cycles.delete(uri);
        this.ended.delete(uri);
        this.refresh();
      }),
    );
    this.store.add(api.window.onDidChangeActiveTextEditor(() => this.refresh()));
  }

  /** How many loads and searches `root` (`rootKey`) has seen so far: read when a search's answer arrives. */
  epoch(root: string): number {
    return this.epochs.get(root)?.count ?? 0;
  }

  /**
   * Runs `apply`, which applies a result to the document `uri`, and says whether exactly one text
   * change of it came meanwhile (`alone`: the result's own; module comment). Changes of a document
   * whose result is being applied never end its cycle by themselves: the caller decides.
   */
  async applyOwn<T>(uri: string, apply: () => Promise<T>): Promise<{ readonly outcome: T; readonly alone: boolean }> {
    if (this.applying.has(uri)) {
      return { outcome: await apply(), alone: false };
    }
    this.applying.set(uri, 0);
    try {
      const outcome = await apply();
      return { outcome, alone: this.applying.get(uri) === 1 };
    } finally {
      this.applying.delete(uri);
    }
  }

  /**
   * A search starts in `root` (`rootKey`): the cycles of its documents end. Returns the search's
   * number, which `start` takes: a cycle starts only for the root's last search.
   */
  searchStarted(root: string): number {
    this.endRoot(root, 'anotherSearch');
    this.lastSearch.set(root, ++this.searches);
    return this.searches;
  }

  /**
   * Starts the cycle of the document `uri` after the first result of the search `search`
   * (`searchStarted`), which now covers `range` at `version` — unless another search started in
   * `root` after it (also one started before its answer came, which the compiler's search is then
   * that of), or a load or another search came there since the answer (`epoch` then, `answeredAt`):
   * the compiler's search is gone, and the cycle ends at once for that reason. Whether it started.
   */
  start(
    cycle: { readonly uri: string; readonly kind: CycleKind; readonly root: string; readonly range: EditorRange; readonly version: number; readonly declaration?: EditorRange },
    search: number,
    answeredAt: number,
  ): boolean {
    const epoch = this.epochs.get(cycle.root);
    const later = this.lastSearch.get(cycle.root) !== search;
    if (later || (epoch?.count ?? 0) !== answeredAt) {
      this.ended.set(cycle.uri, { kind: cycle.kind, why: later ? 'anotherSearch' : (epoch?.why ?? 'loaded') });
      return false;
    }
    this.cycles.get(cycle.uri)?.hold.dispose();
    this.cycles.set(cycle.uri, { ...cycle, declaration: cycle.declaration, shown: 1, hold: this.holds.holdSaveChecks(cycle.uri) });
    this.ended.delete(cycle.uri);
    this.refresh();
    return true;
  }

  /**
   * The first result of a search of `kind` was applied to `uri`, but no cycle starts (another change
   * of the document came with it, `applyOwn`): the next command says `why`.
   */
  notStarted(uri: string, kind: CycleKind, why: CycleEnd): void {
    this.ended.set(uri, { kind, why });
  }

  /** The next result of the cycle of `uri` was applied: it covers `range` at `version`. */
  advance(uri: string, range: EditorRange, version: number): void {
    const cycle = this.cycles.get(uri);
    if (cycle !== undefined) {
      this.cycles.set(uri, { ...cycle, range, version, shown: cycle.shown + 1 });
      this.refresh();
    }
  }

  /** Ends the cycle of `uri`, if it has one, for `why`. */
  end(uri: string, why: CycleEnd): void {
    const cycle = this.cycles.get(uri);
    if (cycle !== undefined) {
      this.cycles.delete(uri);
      this.ended.set(uri, { kind: cycle.kind, why });
      cycle.hold.dispose();
      this.refresh();
    }
  }

  /** The cycle of `uri`, if it has one. */
  cycleOf(uri: string): CycleState | undefined {
    const cycle = this.cycles.get(uri);
    return cycle === undefined ? undefined : { uri: cycle.uri, kind: cycle.kind, range: cycle.range, version: cycle.version, shown: cycle.shown };
  }

  /** The kind of the last cycle of `uri` and why it ended, while no other has started there. */
  lastEnd(uri: string): { readonly kind: CycleKind; readonly why: CycleEnd } | undefined {
    return this.ended.get(uri);
  }

  /**
   * Whether **Generate Definition** at `pos` of `uri` continues that document's Generate Definition
   * cycle: `pos` is on the cycle's declaration or in its result (`types.ts`, *Cycling*; the `g` of
   * ARCHITECTURE §10, "generate def (also next)").
   */
  continuesDefinition(uri: string, pos: EditorPosition): boolean {
    const cycle = this.cycles.get(uri);
    return cycle?.kind === 'generateDef' && (within(pos, cycle.range) || (cycle.declaration !== undefined && within(pos, cycle.declaration)));
  }

  private endRoot(root: string, why: CycleEnd): void {
    this.epochs.set(root, { count: this.epoch(root) + 1, why });
    for (const cycle of [...this.cycles.values()]) {
      if (cycle.root === root) {
        this.end(cycle.uri, why);
      }
    }
  }

  /** The status-bar item's text while it is shown (for the tests: VS Code's API cannot read it). */
  statusText(): string | undefined {
    return this.shown ? this.item.text : undefined;
  }

  /** Shows `↻ next (n)` while the active editor's document has a cycle. */
  private refresh(): void {
    const doc = this.api.window.activeTextEditor?.document;
    const cycle = doc === undefined ? undefined : this.cycles.get(doc.uri.toString());
    this.shown = cycle !== undefined;
    if (cycle === undefined) {
      this.item.hide();
      return;
    }
    this.item.text = `↻ next (${cycle.shown})`;
    this.item.tooltip = cycle.kind === 'exprSearch' ? 'Idris 2: Next Result (Proof Search)' : 'Idris 2: Next Definition (Generate Definition)';
    this.item.command = NEXT_COMMAND[cycle.kind];
    this.item.show();
  }

  dispose(): void {
    for (const cycle of this.cycles.values()) {
      cycle.hold.dispose();
    }
    this.cycles.clear();
    this.store.dispose();
  }
}
