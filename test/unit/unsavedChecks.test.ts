// features/shadow/unsavedChecks.ts: check while typing (ROADMAP M6) against fakes of the vscode
// namespace parts it uses, a scripted backend, fake checks and timers fired by hand: which
// document is checked and when, what is shown and hidden, cancellation, the modules not built
// yet, the cycling holds, the setting, Restricted Mode, the documents an automatic save saves soon,
// dispose.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { UnsavedCheckOptions, UnsavedCheckResult } from '../../src/backend/types';
import { DEFAULT_AUTO_SAVE_DELAY_MS, type AutoSaveSettings, type CheckingSettings, type CheckOnTypeSettings, type SettingsChange } from '../../src/core/config';
import { cancelled, IdrisException, unsupported } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { Timers } from '../../src/features/diagnostics/checks';
import { savedSoon, UNSAVED_COLLECTION_NAME, UnsavedChecks, type UnsavedChecksApi, type UnsavedChecksDeps } from '../../src/features/shadow/unsavedChecks';
import type { Classification } from '../../src/project/types';
import { recordingLog } from './support/fakeTransport';

interface FakeUri {
  readonly scheme: string;
  readonly fsPath: string;
  toString(): string;
}
const uri = (fsPath: string, scheme = 'file'): FakeUri => ({ scheme, fsPath, toString: () => `${scheme}://${fsPath}` });

class FakeDocument {
  isDirty = true;
  isClosed = false;
  version = 1;
  text = 'module A\n';
  readonly uri: FakeUri;
  constructor(
    readonly fileName: string,
    readonly languageId = 'idris2',
    scheme = 'file',
  ) {
    this.uri = uri(fileName, scheme);
  }
  getText(): string {
    return this.text;
  }
}

class FakeCollection {
  readonly entries = new Map<string, readonly unknown[]>();
  constructor(readonly name: string) {}
  set(u: FakeUri, diagnostics: readonly unknown[]): void {
    this.entries.set(u.toString(), diagnostics);
  }
  get(u: FakeUri): readonly unknown[] | undefined {
    return this.entries.get(u.toString());
  }
  delete(u: FakeUri): void {
    this.entries.delete(u.toString());
  }
  dispose(): void {}
}

class ManualTimers implements Timers {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  private next = 0;
  set(callback: () => void, ms: number): unknown {
    this.pending.set(++this.next, { callback, ms });
    return this.next;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fireAll(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    all.forEach((t) => t.callback());
  }
}

class FakeTokenSource {
  static made: FakeTokenSource[] = [];
  private readonly emitter = new Emitter<void>();
  readonly token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  disposed = false;
  constructor() {
    FakeTokenSource.made.push(this);
  }
  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A backend whose checks of unsaved text the test answers by hand, in order. */
class ScriptedBackend {
  readonly kind = 'ideMode' as const;
  caps = { checksUnsaved: true };
  readonly checks: { doc: FakeDocument; options: UnsavedCheckOptions | undefined; resolve(r: UnsavedCheckResult): void; reject(e: unknown): void }[] = [];
  readonly changed: FakeDocument[] = [];
  checkUnsaved(doc: FakeDocument, options?: UnsavedCheckOptions): Promise<UnsavedCheckResult> {
    return new Promise((resolve, reject) => this.checks.push({ doc, options, resolve, reject }));
  }
  unsavedTextChanged(doc: FakeDocument): void {
    this.changed.push(doc);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const ROOT: Classification = { kind: 'loose', dir: '/w' };

function setup(options: { trusted?: boolean; settings?: (scope: FakeUri | undefined) => CheckOnTypeSettings; active?: FakeDocument } = {}) {
  const changed = new Emitter<{ document: FakeDocument; contentChanges: readonly unknown[] }>();
  const saved = new Emitter<FakeDocument>();
  const closed = new Emitter<FakeDocument>();
  const activeChanged = new Emitter<{ document: FakeDocument } | undefined>();
  const configChanged = new Emitter<SettingsChange>();
  const granted = new Emitter<void>();
  const collections: FakeCollection[] = [];
  const window = { activeTextEditor: options.active === undefined ? undefined : { document: options.active } } as { activeTextEditor: { document: FakeDocument } | undefined };
  const opened: string[] = [];
  /** What `savedSoon` reads: VS Code's auto-save settings, `idris2.checking.*`, whether a document is in a workspace folder. */
  const saving = {
    files: { mode: 'off', delayMs: 1000, whenNoErrors: false, workspaceFilesOnly: false } as AutoSaveSettings,
    checking: { trigger: 'onSave', delayMs: 700 } as CheckingSettings,
    insideWorkspace: true,
  };
  /** The scopes VS Code's auto-save settings were read for. */
  const autoSaveScopes: unknown[] = [];
  const api = {
    CancellationTokenSource: FakeTokenSource,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
      createDiagnosticCollection: (name: string) => {
        const c = new FakeCollection(name);
        collections.push(c);
        return c;
      },
    },
    window: {
      get activeTextEditor() {
        return window.activeTextEditor;
      },
      onDidChangeActiveTextEditor: activeChanged.event,
    },
    workspace: {
      onDidChangeTextDocument: changed.event,
      onDidSaveTextDocument: saved.event,
      onDidCloseTextDocument: closed.event,
      openTextDocument: (u: FakeUri) => {
        opened.push(u.fsPath);
        return Promise.resolve(new FakeDocument(u.fsPath));
      },
      getWorkspaceFolder: () => (saving.insideWorkspace ? { uri: uri('/w'), name: 'w', index: 0 } : undefined),
    },
  } as unknown as UnsavedChecksApi;
  const backend = new ScriptedBackend();
  /** The root's backend state (`BackendRegistry.stateFor`). */
  const state = { kind: 'active' as 'none' | 'active' | 'stopped' | 'failed' | 'notAllowed' };
  const trust = { isTrusted: options.trusted ?? true, onDidGrant: granted.event };
  let settings = options.settings ?? (() => ({ enabled: true, delayMs: 500 }));
  const shownSaved: string[] = [];
  const checked: string[] = [];
  const held = new Set<string>();
  const stops: string[] = [];
  const clears: number[] = [];
  const log = recordingLog();
  const timers = new ManualTimers();
  const deps: UnsavedChecksDeps = {
    registry: { backendFor: () => backend as never, stateFor: () => ({ kind: state.kind }) as never },
    projects: { classify: () => Promise.resolve(ROOT) },
    config: {
      checkOnType: (scope?: unknown) => settings(scope as FakeUri | undefined),
      checking: () => saving.checking,
      autoSave: (scope?: unknown) => {
        autoSaveScopes.push(scope);
        return saving.files;
      },
      onDidChange: (group: string, listener: (change: SettingsChange) => void) =>
        group === 'checkOnType' ? configChanged.event(listener) : { dispose: () => undefined },
    } as unknown as UnsavedChecksDeps['config'],
    trust,
    checks: {
      showSaved: (u: vscode.Uri, shown: boolean, counts?: { errors: number; warnings: number }) =>
        shownSaved.push(`${shown ? 'show' : 'hide'} ${u.fsPath}${counts === undefined ? '' : ` ${counts.errors} ${counts.warnings}`}`),
      check: (d: vscode.TextDocument) => {
        checked.push(d.fileName);
        return Promise.resolve(undefined);
      },
      saveChecksHeld: (key: string) => held.has(key),
    } as unknown as UnsavedChecksDeps['checks'],
    stopShadows: (detail) => stops.push(detail),
    storage: {
      clear: () => {
        clears.push(1);
        return Promise.resolve();
      },
    },
    log,
    timers,
  };
  FakeTokenSource.made = [];
  const unsaved = new UnsavedChecks(api, deps);
  const [collection] = collections;
  return {
    unsaved,
    collection,
    backend,
    timers,
    trust,
    log,
    shownSaved,
    checked,
    held,
    stops,
    clears,
    opened,
    window,
    state,
    saving,
    autoSaveScopes,
    setSettings: (f: (scope: FakeUri | undefined) => CheckOnTypeSettings) => (settings = f),
    /** A keystroke: the content change (VS Code sends it with the dirty state from before), then the dirty state. */
    type: (doc: FakeDocument, text = `${doc.text}x`) => {
      const before = doc.isDirty;
      doc.text = text;
      doc.version++;
      doc.isDirty = before;
      changed.fire({ document: doc, contentChanges: [{}] });
      doc.isDirty = true;
      if (!before) {
        changed.fire({ document: doc, contentChanges: [] });
      }
    },
    /** An undo back to the saved text: the change with the dirty state from before, then clean. */
    undoToSaved: (doc: FakeDocument) => {
      doc.version++;
      changed.fire({ document: doc, contentChanges: [{}] });
      doc.isDirty = false;
      changed.fire({ document: doc, contentChanges: [] });
    },
    save: (doc: FakeDocument) => {
      doc.isDirty = false;
      saved.fire(doc);
      changed.fire({ document: doc, contentChanges: [] });
    },
    close: (doc: FakeDocument) => {
      doc.isClosed = true;
      closed.fire(doc);
    },
    activate: (doc: FakeDocument | undefined) => {
      window.activeTextEditor = doc === undefined ? undefined : { document: doc };
      activeChanged.fire(window.activeTextEditor);
    },
    configChanged: (key: string) => configChanged.fire({ affects: (k) => k === key || key.startsWith(`${k}.`) }),
    grant: () => {
      trust.isTrusted = true;
      granted.fire();
    },
  };
}

const answer = (version: number, diagnostics: unknown[] = [{ message: 'e', source: 'idris2 (unsaved)', severity: 0 }], extra: Partial<UnsavedCheckResult> = {}): UnsavedCheckResult =>
  ({ ok: diagnostics.length === 0, version, diagnostics, missing: [], ...extra }) as unknown as UnsavedCheckResult;

suite('features/shadow (check while typing)', () => {
  test('its collection is idris2 (unsaved); an edit of the active Idris document is checked after the delay, a newer edit restarts it', async () => {
    const a = new FakeDocument('/w/A.idr');
    a.isDirty = false;
    const t = setup({ active: a });
    assert.strictEqual(t.collection.name, UNSAVED_COLLECTION_NAME);
    assert.strictEqual(UNSAVED_COLLECTION_NAME, 'idris2 (unsaved)');
    t.type(a);
    assert.deepStrictEqual([...t.timers.pending.values()].map((p) => p.ms), [500]);
    t.type(a);
    assert.strictEqual(t.timers.pending.size, 1, 'one delay, restarted');
    assert.strictEqual(t.backend.checks.length, 0);
    t.timers.fireAll();
    await settle();
    assert.deepStrictEqual(t.backend.checks.map((c) => c.doc), [a]);
    t.backend.checks[0].resolve(answer(a.version));
    await settle();
    assert.deepStrictEqual(t.collection.get(a.uri), [{ message: 'e', source: 'idris2 (unsaved)', severity: 0 }]);
    assert.deepStrictEqual(t.shownSaved, ['hide /w/A.idr 1 0'], 'with the counts the status gives');
    assert.strictEqual(t.unsaved.shownVersion(a.uri as unknown as vscode.Uri), a.version);
    // The delay is the document's setting.
    t.setSettings(() => ({ enabled: true, delayMs: 1200 }));
    t.type(a);
    assert.deepStrictEqual([...t.timers.pending.values()].map((p) => p.ms), [1200]);
  });

  test('only the active editor\'s document: another one is checked once it becomes active with text its check did not read', async () => {
    const a = new FakeDocument('/w/A.idr');
    a.isDirty = false;
    const b = new FakeDocument('/w/B.idr');
    const t = setup({ active: a });
    t.type(b);
    assert.strictEqual(t.timers.pending.size, 0, 'not the active document');
    t.activate(b);
    t.timers.fireAll();
    await settle();
    assert.deepStrictEqual(t.backend.checks.map((c) => c.doc), [b]);
    t.backend.checks[0].resolve(answer(b.version));
    await settle();
    // Active again with the text its check read: nothing; a timer that fires when it is not active checks nothing.
    t.activate(a);
    t.activate(b);
    assert.strictEqual(t.timers.pending.size, 0);
    t.type(b);
    t.activate(a);
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 1);
  });

  test('the active document at activation, with unsaved changes, is checked after the delay', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    assert.strictEqual(t.timers.pending.size, 1);
    t.timers.fireAll();
    await settle();
    assert.deepStrictEqual(t.backend.checks.map((c) => c.doc), [a]);
  });

  test('a save, an undo back to the saved text, a close: the entry goes and the saved diagnostics are shown again', async () => {
    for (const end of ['save', 'undo', 'close'] as const) {
      const a = new FakeDocument('/w/A.idr');
      const t = setup({ active: a });
      t.type(a);
      t.timers.fireAll();
      await settle();
      t.backend.checks[0].resolve(answer(a.version));
      await settle();
      assert.ok(t.collection.get(a.uri) !== undefined, end);
      if (end === 'save') {
        t.save(a);
      } else if (end === 'undo') {
        t.undoToSaved(a);
      } else {
        t.close(a);
      }
      assert.strictEqual(t.collection.get(a.uri), undefined, end);
      assert.deepStrictEqual(t.shownSaved, ['hide /w/A.idr 1 0', 'show /w/A.idr'], end);
      assert.strictEqual(t.unsaved.shownVersion(a.uri as unknown as vscode.Uri), undefined, end);
    }
  });

  test('not checked: a document not on disk or not Idris, Restricted Mode (until trust is granted), the setting off, a backend that does not check unsaved text', async () => {
    const untitled = new FakeDocument('/w/U.idr', 'idris2', 'untitled');
    const text = new FakeDocument('/w/notes.txt', 'plaintext');
    const u = setup({ active: untitled });
    u.type(untitled);
    u.activate(text);
    u.type(text);
    assert.strictEqual(u.timers.pending.size, 0);

    const a = new FakeDocument('/w/A.idr');
    const r = setup({ active: a, trusted: false });
    r.type(a);
    assert.strictEqual(r.timers.pending.size, 0, 'Restricted Mode');
    r.grant();
    assert.strictEqual(r.timers.pending.size, 1, 'checked once trust is granted');

    const off = setup({ active: a, settings: () => ({ enabled: false, delayMs: 500 }) });
    off.type(a);
    assert.strictEqual(off.timers.pending.size, 0, 'the setting off');

    const lsp = setup({ active: a });
    lsp.backend.caps = { checksUnsaved: false };
    lsp.type(a);
    lsp.timers.fireAll();
    await settle();
    assert.strictEqual(lsp.backend.checks.length, 0, 'idris2-lsp roots are not checked so');
    assert.deepStrictEqual(lsp.shownSaved, ['show /w/A.idr']);
  });

  test('after Stop Backend, a give-up or a refusal of the folder (the root\'s state), nothing is checked and the saved diagnostics are shown, until a check starts the compiler again', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    t.timers.fireAll();
    await settle();
    t.backend.checks[0].resolve(answer(a.version));
    await settle();
    for (const kind of ['stopped', 'failed', 'notAllowed'] as const) {
      t.state.kind = kind;
      t.type(a);
      t.timers.fireAll();
      await settle();
      assert.strictEqual(t.backend.checks.length, 1, kind);
      assert.strictEqual(t.collection.get(a.uri), undefined, kind);
    }
    t.state.kind = 'none';
    t.type(a);
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 2, 'none: no process yet, or stopped for being idle');
  });

  test('a newer edit while a check runs: its token is cancelled, the backend told, and its answer, if any, not shown', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    t.type(a);
    t.timers.fireAll();
    await settle();
    const first = t.backend.checks[0];
    t.type(a);
    await settle();
    assert.strictEqual(first.options?.token?.isCancellationRequested, true);
    assert.deepStrictEqual(t.backend.changed, [a], 'unsavedTextChanged');
    first.resolve(answer(a.version - 1));
    await settle();
    assert.strictEqual(t.collection.get(a.uri), undefined, 'the older answer is not shown');
    first.reject(cancelled('x'));
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 2);
    t.backend.checks[1].resolve(answer(a.version));
    await settle();
    assert.strictEqual(t.unsaved.shownVersion(a.uri as unknown as vscode.Uri), a.version);
    assert.ok(FakeTokenSource.made.every((s) => s.disposed));
  });

  test('a refusal or a failure, or a problem in the answer: the entry goes, the saved diagnostics are shown, the reason logged once', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    const run = async (outcome: (c: ScriptedBackend['checks'][number]) => void) => {
      t.type(a);
      t.timers.fireAll();
      await settle();
      outcome(t.backend.checks[t.backend.checks.length - 1]);
      await settle();
    };
    await run((c) => c.resolve(answer(a.version)));
    assert.ok(t.collection.get(a.uri) !== undefined);
    await run((c) => c.reject(unsupported('The unsaved text of A.idr is not checked: A.idr is not inside the source directory /w/src.')));
    assert.strictEqual(t.collection.get(a.uri), undefined);
    assert.deepStrictEqual(t.shownSaved, ['hide /w/A.idr 1 0', 'show /w/A.idr']);
    await run((c) => c.reject(unsupported('The unsaved text of A.idr is not checked: A.idr is not inside the source directory /w/src.')));
    await run((c) => c.reject(new IdrisException({ kind: 'BackendCrashed', message: 'The Idris 2 process for unsaved text ended.' })));
    await run((c) => c.resolve(answer(a.version, [], { problem: 'the compiler refused the package file written to check it: x' })));
    assert.deepStrictEqual(
      t.log.lines.filter((l) => l.startsWith('info: Check while typing')),
      [
        'info: Check while typing: /w/A.idr: The unsaved text of A.idr is not checked: A.idr is not inside the source directory /w/src.',
        'info: Check while typing: /w/A.idr: The Idris 2 process for unsaved text ended.',
        'info: Check while typing: /w/A.idr: the unsaved text could not be checked: the compiler refused the package file written to check it: x',
      ],
    );
  });

  test('modules the text imports that no check built yet: each checked as saved once, then the text checked again', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    t.type(a);
    t.timers.fireAll();
    await settle();
    t.backend.checks[0].resolve(answer(a.version, [{ message: 'Module C not found' }], { missing: [uri('/w/C.idr') as unknown as vscode.Uri] }));
    await settle();
    assert.deepStrictEqual(t.opened, ['/w/C.idr']);
    assert.deepStrictEqual(t.checked, ['/w/C.idr']);
    assert.deepStrictEqual([...t.timers.pending.values()].map((p) => p.ms), [0], 'checked again at once');
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 2);
    // Still not found (C has errors, so the check made no build files): not checked again.
    t.backend.checks[1].resolve(answer(a.version, [{ message: 'Module C not found' }], { missing: [uri('/w/C.idr') as unknown as vscode.Uri] }));
    await settle();
    assert.deepStrictEqual(t.checked, ['/w/C.idr']);
    assert.strictEqual(t.timers.pending.size, 0);
    assert.deepStrictEqual(t.collection.get(a.uri), [{ message: 'Module C not found' }]);
  });

  test('while M4\'s cycling holds the document\'s save checks, it is not checked; the delay starts again', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    t.held.add(a.uri.toString());
    t.type(a);
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 0);
    assert.strictEqual(t.timers.pending.size, 1);
    t.held.clear();
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 1);
  });

  test('savedSoon: VS Code\'s auto-save after a short delay (its isShortAutoSaveDelay) or the afterDelay trigger within as long, a save the trigger checks', () => {
    const files = (f: Partial<AutoSaveSettings> = {}): AutoSaveSettings => ({ mode: 'afterDelay', delayMs: 1000, whenNoErrors: false, workspaceFilesOnly: false, ...f });
    const onSave: CheckingSettings = { trigger: 'onSave', delayMs: 700 };
    assert.strictEqual(DEFAULT_AUTO_SAVE_DELAY_MS, 1000);
    assert.strictEqual(savedSoon(files(), onSave, true), true, 'VS Code\'s default delay');
    assert.strictEqual(savedSoon(files({ delayMs: 0 }), onSave, true), true);
    assert.strictEqual(savedSoon(files({ delayMs: 1001 }), onSave, true), false, 'a longer delay: checked meanwhile');
    for (const mode of ['off', 'onFocusChange', 'onWindowChange'] as const) {
      assert.strictEqual(savedSoon(files({ mode }), onSave, true), false, mode);
    }
    assert.strictEqual(savedSoon(files({ whenNoErrors: true }), onSave, true), false, 'a file with an error is not saved');
    assert.strictEqual(savedSoon(files({ workspaceFilesOnly: true }), onSave, true), true);
    assert.strictEqual(savedSoon(files({ workspaceFilesOnly: true }), onSave, false), false, 'outside the workspace folders: not saved');
    assert.strictEqual(savedSoon(files(), onSave, false), true);
    const off = files({ mode: 'off' });
    assert.strictEqual(savedSoon(off, { trigger: 'afterDelay', delayMs: 700 }, true), true, 'the afterDelay trigger, its default delay');
    assert.strictEqual(savedSoon(off, { trigger: 'afterDelay', delayMs: 1000 }, false), true);
    assert.strictEqual(savedSoon(off, { trigger: 'afterDelay', delayMs: 1001 }, true), false);
    assert.strictEqual(savedSoon(files(), { trigger: 'manual', delayMs: 700 }, true), false, 'under manual a save checks nothing');
  });

  test('a document an automatic save saves soon is not checked: no delay starts, one that ends checks nothing, nor does becoming active; otherwise it is checked', async () => {
    const a = new FakeDocument('/w/A.idr');
    a.isDirty = false;
    const t = setup({ active: a });
    const pending = (): boolean => t.unsaved.pending(a.uri as unknown as vscode.Uri);
    t.saving.files = { mode: 'afterDelay', delayMs: 1000, whenNoErrors: false, workspaceFilesOnly: false };
    t.type(a);
    assert.strictEqual(t.timers.pending.size, 0, 'no delay started');
    assert.strictEqual(pending(), false);
    assert.ok(t.autoSaveScopes.length > 0 && t.autoSaveScopes.every((s) => s === a), 'read for the document itself (its language\'s settings)');
    // Auto-save turned on while the delay runs: when it ends, nothing is checked.
    t.saving.files = { ...t.saving.files, mode: 'off' };
    t.type(a);
    assert.strictEqual(pending(), true);
    t.saving.files = { ...t.saving.files, mode: 'afterDelay' };
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 0);
    // The afterDelay trigger with its default delay, likewise; becoming active starts nothing either.
    t.saving.files = { ...t.saving.files, mode: 'off' };
    t.saving.checking = { trigger: 'afterDelay', delayMs: 700 };
    t.type(a);
    t.activate(undefined);
    t.activate(a);
    assert.strictEqual(t.timers.pending.size, 0);
    // Outside the workspace folders with files.autoSaveWorkspaceFilesOnly, VS Code does not save it: checked.
    t.saving.checking = { trigger: 'onSave', delayMs: 700 };
    t.saving.files = { mode: 'afterDelay', delayMs: 1000, whenNoErrors: false, workspaceFilesOnly: true };
    t.saving.insideWorkspace = false;
    t.type(a);
    t.timers.fireAll();
    await settle();
    assert.deepStrictEqual(t.backend.checks.map((c) => c.doc), [a]);
  });

  test('idris2.checkOnType.enabled changed: the documents it is off for lose their entry, the shadow sessions stop, the copies go; the active document is checked again', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    t.type(a);
    t.timers.fireAll();
    await settle();
    t.backend.checks[0].resolve(answer(a.version));
    await settle();
    t.setSettings(() => ({ enabled: false, delayMs: 500 }));
    t.configChanged('checkOnType.enabled');
    await settle();
    assert.strictEqual(t.collection.get(a.uri), undefined);
    assert.deepStrictEqual(t.stops, ['idris2.checkOnType.enabled changed; a check of unsaved text starts the session again']);
    assert.deepStrictEqual(t.clears, [1]);
    assert.strictEqual(t.timers.pending.size, 0, 'off: not checked again');
    t.setSettings(() => ({ enabled: true, delayMs: 500 }));
    t.configChanged('checkOnType.enabled');
    await settle();
    assert.strictEqual(t.timers.pending.size, 1, 'on again: the active document with unsaved changes is checked again');
    // A change of the delay alone stops nothing.
    t.configChanged('checkOnType.delay');
    assert.strictEqual(t.stops.length, 2);
  });

  test('dispose shows the saved diagnostics of every document again and checks nothing more', async () => {
    const a = new FakeDocument('/w/A.idr');
    const t = setup({ active: a });
    t.type(a);
    t.timers.fireAll();
    await settle();
    t.backend.checks[0].resolve(answer(a.version));
    await settle();
    t.unsaved.dispose();
    assert.deepStrictEqual(t.shownSaved, ['hide /w/A.idr 1 0', 'show /w/A.idr']);
    t.type(a);
    t.timers.fireAll();
    await settle();
    assert.strictEqual(t.backend.checks.length, 1);
  });
});
