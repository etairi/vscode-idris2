/**
 * Check-while-typing (`features/shadow`, ROADMAP M6; docs/ARCHITECTURE.md §6.3): the active
 * editor's Idris document is checked from its unsaved text, without writing its file, and the
 * result is shown in the collection `idris2 (unsaved)` instead of the saved file's diagnostics.
 * Only type imports from `vscode`: `register.ts` passes the `vscode` namespace as `api`.
 *
 * - **What is checked.** The document of the active editor, while it has unsaved changes, is an
 *   Idris file on disk (`isCheckable`, the M2 rule), its root's backend checks unsaved text
 *   (`caps.checksUnsaved`: IDE mode; idris2-lsp roots are not, U1.5/U3) and its state is `none` or
 *   `active` — not after Stop Backend, a give-up or a refusal of its folder, until a check starts
 *   the compiler again, as for the passive queries (`DocumentQueries`) —, the workspace is trusted
 *   and `idris2.checkOnType.enabled` is on for it. `idris2.checkOnType.delay` (500 ms) after the
 *   last change, with no newer change, it is checked (`IdrisBackend.checkUnsaved`); a newer change
 *   cancels the check that waits (the backend drops it before it is sent) and tells the backend
 *   (`unsavedTextChanged`: a check that has answered for more than 2 s is ended by restarting its
 *   session). A document that becomes active with text its last check did not read is checked
 *   after the delay too. While M4's cycling holds the document's save checks (`saveChecksHeld`), it
 *   is not checked — a check would end the compiler's search — and the delay starts again.
 * - **What is shown.** A check's answer replaces the document's entry in `idris2 (unsaved)`, and
 *   the saved file's diagnostics of the document are hidden meanwhile (`DocumentChecks.showSaved`,
 *   which gives the status item the answer's counts),
 *   as long as the document has unsaved changes: a save, an undo back to the saved text, a revert or
 *   a close removes the entry and shows the saved file's diagnostics again (on a save, those of the
 *   check after it once it ends). The answer of a check that a newer one replaced is not shown. When
 *   the text cannot be checked so (`Unsupported`: a file outside its package's source directory, a
 *   package whose options cannot be given to the copy, …) or its check fails (the compiler ended,
 *   a time limit, a refusal of the consent gate), the entry is removed and the saved diagnostics are
 *   shown again: what is shown is then the saved file's, as before M6, and the reason is logged
 *   (once per reason and document).
 * - **Modules not built yet.** When the text imports modules of its root that the compiler did not
 *   find (`UnsavedCheckResult.missing`: no check has built them), each such file is checked as saved,
 *   once per document while it has unsaved changes (`DocumentChecks.check`, which shows its
 *   diagnostics and writes its build files where the check of unsaved text reads them), and the
 *   text is checked again.
 * - **Turning it off.** When `idris2.checkOnType.enabled` changes, the entries of the documents for
 *   which it is now off are removed, every `shadow` session is stopped (`stopShadows`) and the
 *   copies are deleted (`ShadowStorage.clear`); the active document is checked again if it still may be.
 * - **Saved soon** (requested by the user on 2026-10-24, after M6). A document that an automatic save
 *   saves within a second of an edit, a save that is checked, is not checked so (`savedSoon`): the
 *   check after the save would compile the same text again. That is VS Code's auto-save after a
 *   short delay, or `idris2.checking.trigger` `afterDelay` with an `idris2.checking.delay` as short.
 *   The rules are read at each edit and when the delay ends; an entry shown before goes at the save.
 */
import type * as vscode from 'vscode';
import type { BackendRegistry } from '../../backend/registry';
import type { UnsavedCheckResult } from '../../backend/types';
import { DEFAULT_AUTO_SAVE_DELAY_MS, type AutoSaveSettings, type CheckingSettings, type Config } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { errorText, IdrisException, isCancelled } from '../../core/errors';
import type { Log } from '../../core/log';
import type { WorkspaceTrust } from '../../core/trust';
import type { ProjectIndex } from '../../project/types';
import { isCheckable, type DocumentChecks, type Timers } from '../diagnostics/checks';

/** The parts of the `vscode` namespace this module uses. */
export type UnsavedChecksApi = Pick<typeof vscode, 'CancellationTokenSource' | 'DiagnosticSeverity'> & {
  readonly languages: Pick<typeof vscode.languages, 'createDiagnosticCollection'>;
  readonly window: Pick<typeof vscode.window, 'activeTextEditor' | 'onDidChangeActiveTextEditor'>;
  readonly workspace: Pick<
    typeof vscode.workspace,
    'onDidChangeTextDocument' | 'onDidSaveTextDocument' | 'onDidCloseTextDocument' | 'openTextDocument' | 'getWorkspaceFolder'
  >;
};

/**
 * Whether an automatic save saves the document within `DEFAULT_AUTO_SAVE_DELAY_MS` of an edit and the
 * save is checked, so that its unsaved text is not checked (module comment, *Saved soon*). The save
 * is checked unless `checking.trigger` is `manual`. VS Code saves it after a short delay exactly when
 * its `isShortAutoSaveDelay` holds [src: `FilesConfigurationService.computeAutoSaveConfiguration`,
 * VS Code 1.143.1]: `files.autoSave` is `afterDelay`, `files.autoSaveDelay` at most 1000 ms, and
 * neither `files.autoSaveWhenNoErrors` nor, for a file outside the workspace folders
 * (`insideWorkspace` false), `files.autoSaveWorkspaceFilesOnly` is on. Not seen here: the files whose
 * auto-save VS Code turns off by itself (`autoSaveDisabledOverrides`), which have no API.
 */
export function savedSoon(files: AutoSaveSettings, checking: CheckingSettings, insideWorkspace: boolean): boolean {
  if (checking.trigger === 'manual') {
    return false;
  }
  const savedByVsCode =
    files.mode === 'afterDelay' && files.delayMs <= DEFAULT_AUTO_SAVE_DELAY_MS && !files.whenNoErrors && (insideWorkspace || !files.workspaceFilesOnly);
  return savedByVsCode || (checking.trigger === 'afterDelay' && checking.delayMs <= DEFAULT_AUTO_SAVE_DELAY_MS);
}

/** The copies of unsaved documents on disk (`register.ts`). */
export interface ShadowStorage {
  /** Deletes every copy this window wrote (`idris2.checkOnType.enabled` turned off, deactivation); never rejects. */
  clear(): Promise<void>;
}

/** What `UnsavedChecks` needs; `register.ts` and `extension.ts` supply the real ones. */
export interface UnsavedChecksDeps {
  /** `backendFor(root)`, and `stateFor(root)`: nothing is checked after Stop Backend, a give-up or a refusal of the folder. */
  readonly registry: Pick<BackendRegistry, 'backendFor' | 'stateFor'>;
  readonly projects: Pick<ProjectIndex, 'classify'>;
  /** `checkOnType`, and `checking` and `autoSave` for `savedSoon`. */
  readonly config: Pick<Config, 'checkOnType' | 'checking' | 'autoSave' | 'onDidChange'>;
  readonly trust: WorkspaceTrust;
  /** The checks of the saved files: their diagnostics hidden meanwhile, a module not built yet checked, the cycling holds. */
  readonly checks: Pick<DocumentChecks, 'showSaved' | 'check' | 'saveChecksHeld'>;
  /** Stops every `shadow` session (`SessionPool.stopShadows`), with the reason. */
  stopShadows(detail: string): void;
  readonly storage: ShadowStorage;
  readonly log: Log;
  readonly timers: Timers;
}

/** The collection of the checks of unsaved text, and its diagnostics' source (`backend/ide/backend.ts` `UNSAVED_SOURCE`). */
export const UNSAVED_COLLECTION_NAME = 'idris2 (unsaved)';

/** One document's state (module comment). */
interface Tracked {
  readonly doc: vscode.TextDocument;
  /** The delay before its check. */
  timer: unknown;
  /** The check that runs, with its cancellation. */
  running: { readonly source: vscode.CancellationTokenSource } | undefined;
  /** The version whose check's answer is shown, if one is. */
  shown: number | undefined;
  /** The files of modules not built yet that were checked for it while it has unsaved changes (`missing`). */
  readonly built: Set<string>;
  /** The reasons logged for it while it has unsaved changes. */
  readonly logged: Set<string>;
}

export class UnsavedChecks implements IDisposable {
  private readonly store = new DisposableStore();
  private readonly collection: vscode.DiagnosticCollection;
  private readonly tracked = new Map<string, Tracked>();
  private disposed = false;

  constructor(
    private readonly api: UnsavedChecksApi,
    private readonly deps: UnsavedChecksDeps,
  ) {
    this.collection = this.store.add(api.languages.createDiagnosticCollection(UNSAVED_COLLECTION_NAME));
    this.store.add({ dispose: () => this.tracked.forEach((t) => this.stop(t)) });
    this.store.add(api.workspace.onDidChangeTextDocument((e) => this.changed(e.document, e.contentChanges.length > 0)));
    this.store.add(api.workspace.onDidSaveTextDocument((doc) => this.reset(doc)));
    this.store.add(api.workspace.onDidCloseTextDocument((doc) => this.closed(doc)));
    this.store.add(api.window.onDidChangeActiveTextEditor((editor) => editor !== undefined && this.activated(editor.document)));
    this.store.add(deps.trust.onDidGrant(() => this.activeChanged()));
    this.store.add(deps.config.onDidChange('checkOnType', (change) => change.affects('checkOnType.enabled') && this.settingChanged()));
    this.activeChanged();
  }

  /** The document's entry in `idris2 (unsaved)` (for the tests and the test API). */
  shownFor(uri: vscode.Uri): readonly vscode.Diagnostic[] | undefined {
    return this.collection.get(uri);
  }

  /** The version of the document `uri` whose check is shown, if one is (for the tests and the test API). */
  shownVersion(uri: vscode.Uri): number | undefined {
    return this.tracked.get(uri.toString())?.shown;
  }

  /** Whether a check of the document `uri` waits for its delay or runs (for the tests and the test API). */
  pending(uri: vscode.Uri): boolean {
    const t = this.tracked.get(uri.toString());
    return t !== undefined && (t.timer !== undefined || t.running !== undefined);
  }

  private enabled(doc: vscode.TextDocument): boolean {
    return this.deps.trust.isTrusted && isCheckable(doc) && this.deps.config.checkOnType(doc.uri).enabled;
  }

  /** `enabled`, and no automatic save checks `doc` soon (`savedSoon`). */
  private due(doc: vscode.TextDocument): boolean {
    return (
      this.enabled(doc) &&
      !savedSoon(this.deps.config.autoSave(doc), this.deps.config.checking(doc.uri), this.api.workspace.getWorkspaceFolder(doc.uri) !== undefined)
    );
  }

  private isActive(doc: vscode.TextDocument): boolean {
    return this.api.window.activeTextEditor?.document === doc;
  }

  private track(doc: vscode.TextDocument): Tracked {
    const key = doc.uri.toString();
    let t = this.tracked.get(key);
    if (t === undefined || t.doc !== doc) {
      t = { doc, timer: undefined, running: undefined, shown: undefined, built: new Set(), logged: new Set() };
      this.tracked.set(key, t);
    }
    return t;
  }

  private changed(doc: vscode.TextDocument, contentChanged: boolean): void {
    if (!isCheckable(doc)) {
      return;
    }
    if (!doc.isDirty) {
      // An undo back to the saved text, a revert, the clean state after a save; or the first of the
      // two events of a keystroke in a clean document, whose dirty state follows (`checks.ts`, *The
      // event order*), which this resets in vain.
      this.reset(doc);
      return;
    }
    const t = this.track(doc);
    if (contentChanged && t.running !== undefined) {
      t.running.source.cancel();
      this.backendNotified(doc);
    }
    if (this.isActive(doc) && this.due(doc)) {
      this.schedule(t);
    }
  }

  /** Tells `doc`'s backend that its text changed while a check of it ran (`IdrisBackend.unsavedTextChanged`). */
  private backendNotified(doc: vscode.TextDocument): void {
    void this.deps.projects.classify(doc.fileName).then(
      (root) => this.deps.registry.backendFor(root).unsavedTextChanged(doc),
      () => undefined,
    );
  }

  private activated(doc: vscode.TextDocument): void {
    if (doc.isDirty && this.due(doc)) {
      const t = this.track(doc);
      if (t.shown !== doc.version && t.running === undefined) {
        this.schedule(t);
      }
    }
  }

  private activeChanged(): void {
    const doc = this.api.window.activeTextEditor?.document;
    if (doc !== undefined) {
      this.activated(doc);
    }
  }

  private schedule(t: Tracked, delayMs = this.deps.config.checkOnType(t.doc.uri).delayMs): void {
    if (t.timer !== undefined) {
      this.deps.timers.clear(t.timer);
    }
    t.timer = this.deps.timers.set(() => {
      t.timer = undefined;
      void this.run(t);
    }, delayMs);
  }

  /** The check of `t`'s document, if it still may be checked now (module comment). */
  private async run(t: Tracked): Promise<void> {
    const doc = t.doc;
    if (this.disposed || doc.isClosed || !doc.isDirty || !this.isActive(doc) || !this.due(doc) || this.tracked.get(doc.uri.toString()) !== t) {
      return;
    }
    if (this.deps.checks.saveChecksHeld(doc.uri.toString())) {
      this.schedule(t);
      return;
    }
    t.running?.source.cancel();
    const running = { source: new this.api.CancellationTokenSource() };
    t.running = running;
    const version = doc.version;
    try {
      const root = await this.deps.projects.classify(doc.fileName);
      const backend = this.deps.registry.backendFor(root);
      // As the passive queries (`features/intelligence/types.ts` `DocumentQueries`): after Stop
      // Backend, a give-up or a refusal of its folder nothing starts the compiler until a check does.
      const state = this.deps.registry.stateFor(root)?.kind ?? 'none';
      if (!backend.caps.checksUnsaved || (state !== 'none' && state !== 'active')) {
        this.hide(t);
        return;
      }
      const result = await backend.checkUnsaved(doc, { token: running.source.token });
      // An answer a newer text replaced (its token cancelled) is not shown, whatever the backend did with it.
      if (running.source.token.isCancellationRequested || t.running !== running || this.tracked.get(doc.uri.toString()) !== t || doc.isClosed || !doc.isDirty) {
        return;
      }
      this.apply(t, result);
      const missing = result.missing.filter((uri) => !t.built.has(uri.toString()));
      if (missing.length > 0 && result.problem === undefined) {
        await this.build(t, missing);
        if (t.running === running && !doc.isClosed && doc.isDirty && doc.version === version) {
          t.running = undefined;
          this.schedule(t, 0);
        }
      }
    } catch (error) {
      if (isCancelled(error) || t.running !== running) {
        return;
      }
      this.notChecked(t, error instanceof IdrisException ? errorText(error.error) : error instanceof Error ? error.message : String(error));
    } finally {
      if (t.running === running) {
        t.running = undefined;
      }
      running.source.dispose();
    }
  }

  /** Shows `result` for `t`'s document (module comment, *What is shown*). */
  private apply(t: Tracked, result: UnsavedCheckResult): void {
    if (result.problem !== undefined) {
      this.notChecked(t, `the unsaved text could not be checked: ${result.problem}`);
      return;
    }
    this.collection.set(t.doc.uri, [...result.diagnostics]);
    const count = (severity: vscode.DiagnosticSeverity): number => result.diagnostics.filter((d) => d.severity === severity).length;
    this.deps.checks.showSaved(t.doc.uri, false, { errors: count(this.api.DiagnosticSeverity.Error), warnings: count(this.api.DiagnosticSeverity.Warning) });
    t.shown = result.version;
  }

  /** Checks the saved `files` (modules the text imports that no check has built yet), once each for `t`. */
  private async build(t: Tracked, files: readonly vscode.Uri[]): Promise<void> {
    for (const uri of files) {
      t.built.add(uri.toString());
      try {
        const doc = await this.api.workspace.openTextDocument(uri);
        const refusal = await this.deps.checks.check(doc);
        if (refusal !== undefined) {
          this.logOnce(t, `${uri.fsPath} was not checked: ${refusal.message}`);
        }
      } catch (error) {
        this.logOnce(t, `${uri.fsPath} could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** `t`'s text was not checked: the saved file's diagnostics are shown again, and why is logged once. */
  private notChecked(t: Tracked, reason: string): void {
    this.hide(t);
    this.logOnce(t, reason);
  }

  private logOnce(t: Tracked, reason: string): void {
    if (!t.logged.has(reason)) {
      t.logged.add(reason);
      this.deps.log.info(`Check while typing: ${t.doc.fileName}: ${reason}`);
    }
  }

  /** Removes `t`'s entry and shows the saved file's diagnostics again. */
  private hide(t: Tracked): void {
    this.collection.delete(t.doc.uri);
    this.deps.checks.showSaved(t.doc.uri, true);
    t.shown = undefined;
  }

  private stop(t: Tracked): void {
    if (t.timer !== undefined) {
      this.deps.timers.clear(t.timer);
      t.timer = undefined;
    }
    t.running?.source.cancel();
    t.running = undefined;
  }

  /** `doc` has no unsaved changes any more (saved, undone, reverted): its entry goes, its state too. */
  private reset(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const t = this.tracked.get(key);
    if (t === undefined) {
      return;
    }
    this.stop(t);
    this.hide(t);
    this.tracked.delete(key);
  }

  private closed(doc: vscode.TextDocument): void {
    this.reset(doc);
  }

  /** The active document is checked again if it may be, whatever was shown (the printing options changed). */
  recheck(): void {
    for (const t of this.tracked.values()) {
      t.shown = undefined;
    }
    this.activeChanged();
  }

  private settingChanged(): void {
    for (const t of [...this.tracked.values()]) {
      if (!this.enabled(t.doc)) {
        this.reset(t.doc);
      }
    }
    this.deps.stopShadows('idris2.checkOnType.enabled changed; a check of unsaved text starts the session again');
    for (const t of this.tracked.values()) {
      this.stop(t);
      t.shown = undefined;
    }
    // What is still checked is checked again once the copies are gone.
    void this.deps.storage.clear().then(() => this.disposed || this.activeChanged());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.store.dispose();
    for (const t of this.tracked.values()) {
      this.deps.checks.showSaved(t.doc.uri, true);
    }
    this.tracked.clear();
  }
}
