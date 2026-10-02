// features/diagnostics/checks.ts against a fake of the VS Code API: the triggers of
// idris2.checking.trigger, the per-document state and the status it gives, the diagnostic
// collection (results kept on a reload that determined nothing, older results dropped, close,
// reopen and delete), the consent gate's refusals, Restricted Mode, the checks after the
// backend's automatic restarts, the active document and idris2.ideMode.maxBackgroundChecks
// (ROADMAP §9 Q21).
import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { BackendState } from '../../src/backend/registry';
import type { IdrisBackend, LoadOptions, LoadResult } from '../../src/backend/types';
import type { CheckingTrigger, IdeModeSettings, SettingsChange } from '../../src/core/config';
import { cancelled, IdrisException, unsupported } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { GateVerdict } from '../../src/core/trust';
import { DocumentChecks, type ChecksApi, type Timers } from '../../src/features/diagnostics/checks';
import type { Classification } from '../../src/project/types';
import { LOOSE } from './support/toolchainFixtures';

interface FakeUri {
  scheme: string;
  fsPath: string;
  toString(): string;
}
const uri = (fsPath: string, scheme = 'file'): FakeUri => ({ scheme, fsPath, toString: () => `${scheme}://${fsPath}` });

interface FakeDiagnostic {
  message: string;
  severity: number;
}
const ERROR = 0;
const WARNING = 1;

class FakeDocument {
  isDirty = false;
  isClosed = false;
  saves = 0;
  /** What `save()` resolves: `false` for a save that failed (a conflict, a read-only file). */
  saveSucceeds = true;
  version = 1;
  text = '';
  readonly uri: FakeUri;
  constructor(
    readonly fileName: string,
    readonly languageId = 'idris2',
    scheme = 'file',
  ) {
    this.uri = uri(fileName, scheme);
  }
  save(): Promise<boolean> {
    this.saves++;
    return Promise.resolve(this.saveSucceeds);
  }
  getText(): string {
    return this.text;
  }
}

class FakeCollection {
  readonly entries = new Map<string, { uri: FakeUri; diagnostics: FakeDiagnostic[] }>();
  set(u: FakeUri, diagnostics: FakeDiagnostic[]): void {
    this.entries.set(u.toString(), { uri: u, diagnostics });
  }
  get(u: FakeUri): FakeDiagnostic[] | undefined {
    return this.entries.get(u.toString())?.diagnostics;
  }
  delete(u: FakeUri): void {
    this.entries.delete(u.toString());
  }
  forEach(f: (u: FakeUri) => void): void {
    [...this.entries.values()].forEach((e) => f(e.uri));
  }
  messages(u: FakeUri): string[] | undefined {
    return this.get(u)?.map((d) => d.message);
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

/** A backend whose loads the test resolves by hand, in order. */
class ScriptedBackend {
  readonly kind = 'ideMode' as const;
  caps = { diagnostics: true };
  readonly loads: { doc: FakeDocument; options: LoadOptions | undefined; resolve: (r: LoadResult) => void; reject: (e: unknown) => void }[] = [];
  load(doc: FakeDocument, options?: LoadOptions): Promise<LoadResult> {
    return new Promise((resolve, reject) => this.loads.push({ doc, options, resolve, reject }));
  }
}

const result = (entries: [FakeUri, FakeDiagnostic[]][], extra: Partial<LoadResult> = {}): LoadResult =>
  ({ ok: !entries.some(([, list]) => list.some((d) => d.severity === ERROR)), diagnostics: entries, ...extra }) as unknown as LoadResult;

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const IDE_MODE: IdeModeSettings = {
  transport: 'stdio',
  isolateBuildDir: true,
  loosePackages: [],
  extraArgs: [],
  requestTimeoutMs: 5_000,
  longActionTimeoutMs: 60_000,
  idleTimeoutMs: 600_000,
  maxSessions: 0,
  maxBackgroundChecks: 0,
};

function setup(
  options: { visible?: FakeDocument[]; trigger?: CheckingTrigger; trusted?: boolean; active?: FakeDocument; maxBackgroundChecks?: number } = {},
) {
  const visibleChanged = new Emitter<{ document: FakeDocument }[]>();
  const activeChanged = new Emitter<{ document: FakeDocument } | undefined>();
  const ideModeChanged = new Emitter<SettingsChange>();
  const opened = new Emitter<FakeDocument>();
  const closed = new Emitter<FakeDocument>();
  const saved = new Emitter<FakeDocument>();
  const willSave = new Emitter<{ document: FakeDocument; reason: number }>();
  /** A change of `document`: of its text when `contentChanges` is non-empty, else of its dirty state only. */
  const edited = new Emitter<{ document: FakeDocument; contentChanges?: unknown[] }>();
  const deleted = new Emitter<FakeUri>();
  const created = new Emitter<FakeUri>();
  const registryChanged = new Emitter<void>();
  const consentChanged = new Emitter<void>();
  const restarted = new Emitter<{ root: Classification; cause: 'reconfigure' | 'crash' }>();
  const state = {
    visible: (options.visible ?? []).map((document) => ({ document })),
    trigger: options.trigger ?? ('onSave' as CheckingTrigger),
    backendStates: new Map<string, BackendState>(),
    verdicts: new Map<string, GateVerdict>(),
    asking: new Set<string>(),
    roots: new Map<string, Classification>(),
    /** Files whose classification the test answers by hand. */
    slowClassify: new Map<string, Promise<Classification>>(),
    /** `workspace.textDocuments`: the documents visible or opened, until closed. */
    open: new Set<FakeDocument>(options.visible ?? []),
    /** The files on disk (`ChecksDeps.readFile`), by path; a file not here cannot be read. */
    disk: new Map<string, string>(),
    /** The paths `readFile` was asked for, in order. */
    reads: [] as string[],
    /** The document of `window.activeTextEditor`. */
    active: options.active,
    maxBackgroundChecks: options.maxBackgroundChecks ?? 0,
    /** What the checks told the backend about the active root (`setActiveRoot`), in order. */
    activeRoots: [] as string[],
    /** The directories the checks asked the gate about (`permit`), in order. */
    permits: [] as string[],
    /** Directories whose question `permit` keeps open until `answer`. */
    held: new Set<string>(),
    /** The callers waiting for the answer about a directory. */
    questions: new Map<string, ((verdict: GateVerdict) => void)[]>(),
    /** What the backend says would refuse a load in a directory before any question (`refusalBeforeQuestion`). */
    refusals: new Map<string, string>(),
    /** The directories the checks asked the backend about before a question, in order. */
    preflights: [] as string[],
  };
  // Before the checks subscribe: VS Code updates textDocuments before it fires the events.
  opened.event((doc) => state.open.add(doc));
  closed.event((doc) => state.open.delete(doc));
  let collection: FakeCollection | undefined;
  const api = {
    languages: {
      createDiagnosticCollection: (name: string) => {
        assert.strictEqual(name, 'idris2');
        collection = new FakeCollection();
        return collection;
      },
    },
    window: {
      get visibleTextEditors() {
        return state.visible;
      },
      onDidChangeVisibleTextEditors: visibleChanged.event,
      get activeTextEditor() {
        return state.active === undefined ? undefined : { document: state.active };
      },
      onDidChangeActiveTextEditor: activeChanged.event,
    },
    workspace: {
      onDidOpenTextDocument: opened.event,
      onDidCloseTextDocument: closed.event,
      onDidSaveTextDocument: saved.event,
      onWillSaveTextDocument: willSave.event,
      onDidChangeTextDocument: (listener: (e: { document: FakeDocument; contentChanges: unknown[] }) => void) =>
        edited.event((e) => listener({ contentChanges: [], ...e })),
      createFileSystemWatcher: () => ({ onDidDelete: deleted.event, onDidCreate: created.event, dispose: () => undefined }),
      get textDocuments() {
        return [...state.open];
      },
    },
    DiagnosticSeverity: { Error: ERROR, Warning: WARNING, Information: 2, Hint: 3 },
    TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  } as unknown as ChecksApi;
  const backend = new ScriptedBackend();
  const timers = new ManualTimers();
  const trustGranted = new Emitter<void>();
  const trust = { isTrusted: options.trusted ?? true, onDidGrant: trustGranted.event };
  const logged: string[] = [];
  const rootOf = (file: string): Classification => state.roots.get(file) ?? { kind: 'loose', dir: file.slice(0, file.lastIndexOf('/')) };
  const released: string[] = [];
  const checks = new DocumentChecks(api, {
    readFile: (p, maxBytes) => {
      state.reads.push(p);
      const text = state.disk.get(p);
      return Promise.resolve(text === undefined || Buffer.byteLength(text) > maxBytes ? undefined : text);
    },
    registry: {
      backendFor: () => backend as unknown as IdrisBackend,
      stateFor: (root) => (root === undefined ? undefined : state.backendStates.get(root.dir)),
      onDidChange: registryChanged.event,
    },
    roots: {
      release: (root) => released.push(root.dir),
      onDidRestart: restarted.event,
      setActiveRoot: (root) => state.activeRoots.push(root === 'pending' ? root : (root?.dir ?? 'none')),
      refusalBeforeQuestion: (_doc, root) => {
        state.preflights.push(root.dir);
        return Promise.resolve(state.refusals.get(root.dir));
      },
    },
    projects: { classify: (file) => state.slowClassify.get(file) ?? Promise.resolve(rootOf(file)), sessionCwd: (root) => root.dir },
    config: {
      checking: () => ({ trigger: state.trigger, delayMs: 700 }),
      ideMode: () => ({ ...IDE_MODE, maxBackgroundChecks: state.maxBackgroundChecks }),
      onDidChange: (group, listener) => (group === 'ideMode' ? ideModeChanged.event(listener) : { dispose: () => undefined }),
    },
    trust,
    consent: {
      current: (dir) => state.verdicts.get(dir),
      asking: (dir) => state.asking.has(dir),
      // As the gate: a directory with a verdict gets it at once; one whose question the test holds
      // open (`holdQuestion`) waits for `answer`; any other is inside a workspace folder.
      permit: (dir) => {
        state.permits.push(dir);
        const known = state.verdicts.get(dir);
        if (known !== undefined) {
          return Promise.resolve(known);
        }
        if (state.held.has(dir)) {
          const asked = new Promise<GateVerdict>((resolve) => state.questions.set(dir, [...(state.questions.get(dir) ?? []), resolve]));
          if (!state.asking.has(dir)) {
            // The gate fires when the question opens (after its own waits).
            state.asking.add(dir);
            queueMicrotask(() => consentChanged.fire());
          }
          return asked;
        }
        const verdict: GateVerdict = { allowed: true, basis: 'workspaceFolder' };
        state.verdicts.set(dir, verdict);
        return Promise.resolve(verdict);
      },
      onDidChange: consentChanged.event,
    },
    log: { trace: () => undefined, debug: () => undefined, info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: () => undefined },
    timers,
  });
  let changes = 0;
  checks.onDidChange(() => changes++);
  const asDoc = (d: FakeDocument) => d as unknown as vscode.TextDocument;
  return {
    checks,
    collection: collection ?? assert.fail('no collection created'),
    backend,
    timers,
    trust,
    trustGranted,
    state,
    logged,
    released,
    asDoc,
    changes: () => changes,
    show: (...docs: FakeDocument[]) => {
      docs.forEach((doc) => state.open.add(doc));
      state.visible = docs.map((document) => ({ document }));
      visibleChanged.fire(state.visible);
    },
    /** Makes `doc` the active editor's document (none: `undefined`), as VS Code reports it. */
    activate: (doc: FakeDocument | undefined) => {
      if (doc !== undefined) {
        state.open.add(doc);
      }
      state.active = doc;
      activeChanged.fire(doc === undefined ? undefined : { document: doc });
    },
    /** Keeps the gate's question about `dir` open when it is asked (`permit`), until `answer`. */
    holdQuestion: (dir: string) => state.held.add(dir),
    /** Answers the open question about `dir`, as the gate does: the verdict is recorded, then it fires. */
    answer: (dir: string, verdict: GateVerdict) => {
      state.held.delete(dir);
      state.asking.delete(dir);
      state.verdicts.set(dir, verdict);
      const waiting = state.questions.get(dir) ?? [];
      state.questions.delete(dir);
      waiting.forEach((resolve) => resolve(verdict));
      consentChanged.fire();
    },
    /** Changes idris2.ideMode.maxBackgroundChecks. */
    setMaxBackgroundChecks: (n: number) => {
      state.maxBackgroundChecks = n;
      ideModeChanged.fire({ affects: (key) => key === 'ideMode.maxBackgroundChecks' || key === 'ideMode' });
    },
    opened,
    closed,
    saved,
    willSave,
    edited,
    deleted,
    created,
    registryChanged,
    consentChanged,
    restarted,
    status: (d: FakeDocument, root?: Classification) => checks.statusOf(asDoc(d), root),
  };
}

suite('features/diagnostics/checks', () => {
  suite('triggers', () => {
    test('onSave: a document shown at activation or later is checked once; each save checks it; hidden or non-file documents never', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ visible: [a] });
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [a]);
      const b = new FakeDocument('/w/a/B.idr');
      t.opened.fire(b); // opened but not shown (a search, another extension)
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      t.show(a, b);
      t.show(b, a); // shown again: not checked again
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [a, b]);
      t.saved.fire(a);
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [a, b, a]);
      for (const other of [new FakeDocument('/w/a/Notes.md', 'markdown'), new FakeDocument('Untitled-1', 'idris2', 'untitled')]) {
        t.show(other);
        t.saved.fire(other);
      }
      await settle();
      assert.strictEqual(t.backend.loads.length, 3);
    });

    test('held save checks (M4 cycling): an auto-save checks nothing; the release checks a document saved meanwhile and clean, once', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ visible: [a] });
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      const uri = t.asDoc(a).uri.toString();
      const autoSave = (): void => {
        t.willSave.fire({ document: a, reason: 2 }); // files.autoSave: afterDelay
        t.saved.fire(a);
      };
      let hold = t.checks.holdSaveChecks(uri);
      autoSave();
      autoSave();
      await settle();
      assert.strictEqual(t.backend.loads.length, 1, 'held');
      hold.dispose();
      hold.dispose();
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'checked once at the release');
      t.saved.fire(a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 3, 'released: a save checks again');
      // Not saved while held, or dirty again at the release: nothing.
      t.checks.holdSaveChecks(uri).dispose();
      hold = t.checks.holdSaveChecks(uri);
      autoSave();
      a.isDirty = true;
      hold.dispose();
      await settle();
      assert.strictEqual(t.backend.loads.length, 3);
    });

    test('held save checks: the user\'s save (Manual) checks as always; auto-saves and the checks\' own afterDelay save (Manual too) are held; no second load at the release after a check', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ visible: [a], trigger: 'afterDelay' });
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      const hold = t.checks.holdSaveChecks(t.asDoc(a).uri.toString());
      const save = (reason: number): void => {
        t.willSave.fire({ document: a, reason });
        t.saved.fire(a);
      };
      save(2); // files.autoSave: afterDelay
      save(3); // files.autoSave: onFocusChange
      await settle();
      assert.strictEqual(t.backend.loads.length, 1, 'automatic saves are held');
      a.isDirty = true;
      t.edited.fire({ document: a });
      t.timers.fireAll();
      assert.strictEqual(a.saves, 1, 'the afterDelay save');
      a.isDirty = false;
      save(1); // an extension's save is reported as Manual [doc]
      await settle();
      assert.strictEqual(t.backend.loads.length, 1, 'the checks\' own save is held');
      save(1);
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'the user\'s save checks (its load ends the cycle)');
      hold.dispose();
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'released after that check: the same text is not loaded again');
    });

    test('held save checks: a save with no reason (Save without Formatting runs no save participants, so no willSave event) is the user\'s: checked', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ visible: [a] });
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      const hold = t.checks.holdSaveChecks(t.asDoc(a).uri.toString());
      t.saved.fire(a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'checked during the hold');
      hold.dispose();
    });

    test('held save checks: when the checks\' own afterDelay save fails (no save event), the user\'s next save is checked, not held', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ visible: [a], trigger: 'afterDelay' });
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      const hold = t.checks.holdSaveChecks(t.asDoc(a).uri.toString());
      a.isDirty = true;
      a.saveSucceeds = false;
      t.edited.fire({ document: a });
      t.timers.fireAll();
      assert.strictEqual(a.saves, 1, 'the afterDelay save, which fails');
      await settle();
      a.isDirty = false;
      t.willSave.fire({ document: a, reason: 1 });
      t.saved.fire(a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'the user\'s save checks');
      hold.dispose();
    });

    test('a document whose language mode changes to Idris 2 while visible (close + open, no visibility event) is checked', async () => {
      const notes = new FakeDocument('/w/a/Notes.idr', 'markdown');
      const t = setup({ visible: [notes] });
      await settle();
      assert.strictEqual(t.backend.loads.length, 0);
      const same = Object.assign(notes, { languageId: 'idris2' });
      t.opened.fire(same);
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
    });

    test('manual: neither showing nor saving checks; Check File (check) does', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ visible: [a], trigger: 'manual' });
      t.saved.fire(a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 0);
      void t.checks.check(t.asDoc(a));
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
    });

    test('afterDelay: each edit restarts the delay; when it ends the still-dirty document is saved (which then checks it)', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ trigger: 'afterDelay' });
      a.isDirty = true;
      t.edited.fire({ document: a });
      t.edited.fire({ document: a });
      assert.deepStrictEqual([...t.timers.pending.values()].map((p) => p.ms), [700]);
      t.timers.fireAll();
      assert.strictEqual(a.saves, 1);
      // Undone to the saved text before the delay ended: nothing to save.
      t.edited.fire({ document: a });
      a.isDirty = false;
      t.edited.fire({ document: a });
      assert.strictEqual(t.timers.pending.size, 0);
      // Closed, or the trigger changed, before the delay ended.
      a.isDirty = true;
      t.edited.fire({ document: a });
      t.state.trigger = 'onSave';
      t.timers.fireAll();
      assert.strictEqual(a.saves, 1);
      t.saved.fire(a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
    });

    test('afterDelay in Restricted Mode saves nothing (nothing would be checked); a pending save is dropped', () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ trigger: 'afterDelay', trusted: false });
      a.isDirty = true;
      t.edited.fire({ document: a });
      assert.strictEqual(t.timers.pending.size, 0);
      t.timers.fireAll();
      assert.strictEqual(a.saves, 0);
      // Trusted: the timer runs; an edit while untrusted again (only a test can do that) drops it.
      t.trust.isTrusted = true;
      t.edited.fire({ document: a });
      assert.strictEqual(t.timers.pending.size, 1);
      t.trust.isTrusted = false;
      t.edited.fire({ document: a });
      assert.strictEqual(t.timers.pending.size, 0);
      assert.strictEqual(a.saves, 0);
    });

    test('afterDelay saves nothing where the load would be refused: a folder the gate refused, a session given up', async () => {
      const a = new FakeDocument('/x/A.idr');
      const t = setup({ trigger: 'afterDelay' });
      const check = t.checks.check(t.asDoc(a)); // classifies it: root /x
      await settle();
      t.backend.loads[0].reject(unsupported('Idris 2 is not started in /x: "Don\'t Allow" was chosen.'));
      await check;
      const editAndWait = (): void => {
        a.isDirty = true;
        t.edited.fire({ document: a });
        t.timers.fireAll();
      };
      t.state.verdicts.set('/x', { allowed: false, reason: 'denied' });
      editAndWait();
      t.state.verdicts.set('/x', { allowed: false, reason: 'unanswered' });
      editAndWait();
      t.state.verdicts.set('/x', { allowed: true, basis: 'window' });
      t.state.backendStates.set('/x', { kind: 'failed', reason: 'gave up' });
      editAndWait();
      assert.strictEqual(a.saves, 0);
      t.state.backendStates.set('/x', { kind: 'active' });
      editAndWait();
      assert.strictEqual(a.saves, 1, 'allowed and running: saved');
    });

    test('onSave never saves a document', () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      a.isDirty = true;
      t.edited.fire({ document: a });
      assert.strictEqual(t.timers.pending.size, 0);
    });

    test('Restricted Mode: nothing is checked, not even by Check File; once trust is granted the visible documents are', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ visible: [a], trusted: false });
      await t.checks.check(t.asDoc(a));
      t.saved.fire(a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 0);
      t.trust.isTrusted = true;
      t.trustGranted.fire();
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [a]);
    });
  });

  suite('state, status and results', () => {
    test('checking… then n errors; the diagnostics go to every file the load determined', async () => {
      const a = new FakeDocument('/w/a/UsesBad.idr');
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      await settle();
      assert.deepStrictEqual(t.status(a), { kind: 'checking', waitingFor: undefined });
      t.backend.loads[0].resolve(
        result([
          [a.uri, [{ message: 'Not checked: …', severity: ERROR }]],
          [uri('/w/a/Bad.idr'), [{ message: 'While processing …', severity: ERROR }]],
        ]),
      );
      await check;
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'errors');
      assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 1, warnings: 0, stale: false, known: true });
      assert.deepStrictEqual(t.collection.messages(uri('/w/a/Bad.idr')), ['While processing …']);
    });

    test('runningCheck: the newest check of the document while it runs, then none (integration after the third review of M3)', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const b = new FakeDocument('/w/a/B.idr');
      const t = setup();
      assert.strictEqual(t.checks.runningCheck(t.asDoc(a)), undefined);
      const first = t.checks.check(t.asDoc(a));
      assert.strictEqual(t.checks.runningCheck(t.asDoc(a)), first, 'running from its start, before it has classified the file');
      assert.strictEqual(t.checks.runningCheck(t.asDoc(b)), undefined, 'another document has none');
      const second = t.checks.check(t.asDoc(a));
      assert.strictEqual(t.checks.runningCheck(t.asDoc(a)), second, 'the newest one');
      // The older check, no longer the newest after its classification, ends without a load.
      await first;
      await settle();
      assert.strictEqual(t.checks.runningCheck(t.asDoc(a)), second, 'the older one ending leaves the newest');
      assert.strictEqual(t.backend.loads.length, 1);
      t.backend.loads[0].resolve(result([]));
      await second;
      await settle();
      assert.strictEqual(t.checks.runningCheck(t.asDoc(a)), undefined);
    });

    test('warnings only, then clean; a reload that determined nothing keeps what is shown (F7)', async () => {
      const a = new FakeDocument('/w/a/Warn.idr');
      const t = setup();
      let check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'Unreachable clause: f n', severity: WARNING }]]]));
      await check;
      assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 0, warnings: 1, stale: false, known: true });
      check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[1].resolve(result([]));
      await check;
      assert.deepStrictEqual(t.collection.messages(a.uri), ['Unreachable clause: f n']);
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'warnings');
      check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[2].resolve(result([[a.uri, []]]));
      await check;
      assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
    });

    test('a first load that determines nothing (a TTC fresh from an earlier session): no errors, warnings unknown, not ✓', async () => {
      const a = new FakeDocument('/w/a/Warn.idr');
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([]));
      await check;
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'ok');
      assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: false });
    });

    test('closed and opened again: a reload that determines nothing shows what the document showed, only for the same text', async () => {
      const t = setup();
      const load = async (doc: FakeDocument, entries: [FakeUri, FakeDiagnostic[]][]): Promise<void> => {
        const check = t.checks.check(t.asDoc(doc));
        await settle();
        t.backend.loads.at(-1)?.resolve(result(entries));
        await check;
      };
      const warning = { message: 'Unreachable clause: f n', severity: WARNING };
      const first = Object.assign(new FakeDocument('/w/a/Warn.idr'), { text: 'v1' });
      await load(first, [[first.uri, [warning]]]);
      t.closed.fire(first);
      assert.strictEqual(t.collection.get(first.uri), undefined, 'closing removes them from view');
      // Opened again with the same text; the fresh TTC makes the compiler repeat nothing (F7).
      const again = Object.assign(new FakeDocument('/w/a/Warn.idr'), { text: 'v1' });
      await load(again, []);
      assert.deepStrictEqual(t.collection.messages(again.uri), ['Unreachable clause: f n']);
      assert.deepStrictEqual(t.status(again), { kind: 'checked', errors: 0, warnings: 1, stale: false, known: true });
      // Closed again, changed on disk meanwhile (and built elsewhere, so the TTC is fresh): unknown.
      t.closed.fire(again);
      const changed = Object.assign(new FakeDocument('/w/a/Warn.idr'), { text: 'v2' });
      await load(changed, []);
      assert.strictEqual(t.collection.get(changed.uri), undefined);
      assert.deepStrictEqual(t.status(changed), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: false });
      // Closed with unsaved changes: its text is not the file's, so nothing is kept.
      const dirty = Object.assign(new FakeDocument('/w/a/D.idr'), { text: 'd' });
      await load(dirty, [[dirty.uri, [warning]]]);
      dirty.isDirty = true;
      t.closed.fire(dirty);
      const reopened = Object.assign(new FakeDocument('/w/a/D.idr'), { text: 'd' });
      await load(reopened, []);
      assert.strictEqual(t.collection.get(reopened.uri), undefined);
      // Saved after its last check (manual trigger): not the version the diagnostics were for.
      const saved = Object.assign(new FakeDocument('/w/a/S.idr'), { text: 's' });
      await load(saved, [[saved.uri, [warning]]]);
      saved.version = 2;
      t.closed.fire(saved);
      await load(Object.assign(new FakeDocument('/w/a/S.idr'), { text: 's' }), []);
      assert.strictEqual(t.collection.get(saved.uri), undefined);
    });

    test('a closed document determined by another load, or deleted, is not given its old diagnostics back', async () => {
      const t = setup();
      const load = async (doc: FakeDocument, entries: [FakeUri, FakeDiagnostic[]][]): Promise<void> => {
        const check = t.checks.check(t.asDoc(doc));
        await settle();
        t.backend.loads.at(-1)?.resolve(result(entries));
        await check;
      };
      const a = Object.assign(new FakeDocument('/w/a/A.idr'), { text: 'a' });
      await load(a, [[a.uri, [{ message: 'old', severity: WARNING }]]]);
      t.closed.fire(a);
      // Main.idr's load rebuilt A.idr: A is clean now.
      const main = new FakeDocument('/w/a/Main.idr');
      await load(main, [[main.uri, []], [a.uri, []]]);
      const reopened = Object.assign(new FakeDocument('/w/a/A.idr'), { text: 'a' });
      await load(reopened, []);
      assert.deepStrictEqual(t.collection.messages(reopened.uri), []);
      assert.deepStrictEqual(t.status(reopened), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
      // Deleted while closed: forgotten.
      const b = Object.assign(new FakeDocument('/w/a/B.idr'), { text: 'b' });
      await load(b, [[b.uri, [{ message: 'w', severity: WARNING }]]]);
      t.closed.fire(b);
      t.deleted.fire(uri('/w/a'));
      await load(Object.assign(new FakeDocument('/w/a/B.idr'), { text: 'b' }), []);
      assert.strictEqual(t.collection.get(b.uri), undefined);
    });

    test('unsaved changes make the result stale; the status still counts the saved file', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'x', severity: ERROR }]]]));
      await check;
      const before = t.changes();
      a.isDirty = true;
      t.edited.fire({ document: a });
      assert.strictEqual(t.changes(), before + 1);
      assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 1, warnings: 0, stale: true, known: true, staleness: { unsaved: true, manual: false } });
    });

    test('the .ipkg error: ipkgError and a package-file status', async () => {
      const a = new FakeDocument('/w/b/Main.idr');
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(
        result([[uri('/w/b/bad.ipkg'), [{ message: 'Unrecognised property "pkgs".', severity: ERROR }]]], {
          packageError: { uri: uri('/w/b/bad.ipkg'), message: 'Unrecognised property "pkgs".' },
        } as unknown as Partial<LoadResult>),
      );
      await check;
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'ipkgError');
      assert.deepStrictEqual(t.status(a), { kind: 'packageError', ipkg: '/w/b/bad.ipkg', message: 'Unrecognised property "pkgs".', stale: false });
      // Stale, it says why, as a result does (seventh review of M3: Type at Cursor took the trigger
      // as not manual and advised a save, which checks nothing under the manual trigger).
      a.isDirty = true;
      t.edited.fire({ document: a });
      t.state.trigger = 'manual';
      assert.deepStrictEqual(t.status(a), {
        kind: 'packageError',
        ipkg: '/w/b/bad.ipkg',
        message: 'Unrecognised property "pkgs".',
        stale: true,
        staleness: { unsaved: true, manual: true },
      });
    });

    test('an older result that arrives after a newer one does not overwrite what the newer one set', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      const first = t.checks.check(t.asDoc(a));
      await settle();
      const second = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await second;
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'old', severity: ERROR }]]]));
      await first;
      assert.deepStrictEqual(t.collection.messages(a.uri), []);
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'ok');
    });

    test('a failed load (crash, time-out) is the document\'s state and a log line; it keeps the diagnostics shown', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      let check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'x', severity: ERROR }]]]));
      await check;
      check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[1].reject(new IdrisException({ kind: 'RequestTimeout', message: 'no reply within 60 s' }));
      await check;
      assert.deepStrictEqual(t.status(a), { kind: 'loadFailed', reason: 'no reply within 60 s' });
      assert.deepStrictEqual(t.collection.messages(a.uri), ['x']);
      assert.ok(t.logged.some((m) => m.includes('no reply within 60 s')));
    });

    test('a load the consent gate refused keeps the previous state; once allowed, the visible refused document is checked again', async () => {
      const a = new FakeDocument('/pkg/A.idr');
      const t = setup({ visible: [a] });
      await settle();
      t.backend.loads[0].reject(unsupported('Idris 2 is not started in /pkg: "Don\'t Allow" was chosen.'));
      await settle();
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'idle');
      // Denied: no new check.
      t.state.verdicts.set('/pkg', { allowed: false, reason: 'denied' });
      t.consentChanged.fire();
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      // Allowed (Allow…): checked again.
      t.state.verdicts.set('/pkg', { allowed: true, basis: 'window' });
      t.consentChanged.fire();
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      // A document that was not refused is not checked again by a consent change.
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await settle();
      t.consentChanged.fire();
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
    });

    test('a document refused while in the background is checked when it is shown after its folder was allowed', async () => {
      const a = new FakeDocument('/o/A.idr');
      const b = new FakeDocument('/o/B.idr');
      const t = setup({ visible: [a, b] });
      await settle();
      const denied = unsupported('Idris 2 is not started in /o: "Don\'t Allow" was chosen.');
      t.backend.loads.forEach((l) => l.reject(denied));
      await settle();
      t.state.verdicts.set('/o', { allowed: false, reason: 'denied' });
      t.show(a);
      t.show(b, a); // shown again while still denied: not checked again
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      t.show(a);
      t.state.verdicts.set('/o', { allowed: true, basis: 'window' });
      t.consentChanged.fire();
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [a, b, a]);
      t.show(b, a);
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [a, b, a, b]);
    });

    test('check returns the refusal, with the directory to ask about when the user can allow it', async () => {
      const a = new FakeDocument('/o/A.idr');
      const t = setup();
      t.state.verdicts.set('/o', { allowed: false, reason: 'denied' });
      let check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].reject(unsupported('Idris 2 is not started in /o: "Don\'t Allow" was chosen.'));
      assert.deepStrictEqual(await check, { message: 'Idris 2 is not started in /o: "Don\'t Allow" was chosen.', dir: '/o' });
      // Allowed meanwhile, or no verdict: nothing to ask about.
      t.state.verdicts.set('/o', { allowed: false, reason: 'restrictedMode' });
      check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[1].reject(unsupported('nothing runs in Restricted Mode'));
      assert.deepStrictEqual(await check, { message: 'nothing runs in Restricted Mode', dir: undefined });
      check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[2].resolve(result([[a.uri, []]]));
      assert.strictEqual(await check, undefined);
    });

    test('status priority: not allowed, then checking (waiting for permission), then a failed or stopped backend, then the result', async () => {
      const a = new FakeDocument('/pkg/A.idr');
      const t = setup();
      const root: Classification = { kind: 'loose', dir: '/pkg' };
      assert.deepStrictEqual(t.status(a, root), { kind: 'notChecked' });
      t.state.asking.add('/pkg');
      void t.checks.check(t.asDoc(a));
      await settle();
      assert.deepStrictEqual(t.status(a, root), { kind: 'checking', waitingFor: '/pkg' });
      t.state.backendStates.set('/pkg', { kind: 'notAllowed', dir: '/pkg', reason: 'unanswered' });
      assert.deepStrictEqual(t.status(a, root), { kind: 'notAllowed', dir: '/pkg', reason: 'unanswered' });
      t.state.asking.delete('/pkg');
      t.backend.loads[0].resolve(result([[a.uri, []]]));
      await settle();
      t.state.backendStates.set('/pkg', { kind: 'stopped' });
      assert.deepStrictEqual(t.status(a, root), { kind: 'stopped' });
      t.state.backendStates.set('/pkg', { kind: 'stopped', revokedDir: '/pkg' });
      assert.deepStrictEqual(t.status(a, root), { kind: 'stopped', revokedDir: '/pkg' });
      // Allow… asked again (no check waits for the answer): still waiting, with the Allow… link.
      t.state.asking.add('/pkg');
      assert.deepStrictEqual(t.status(a, root), { kind: 'checking', waitingFor: '/pkg' });
      t.state.asking.delete('/pkg');
      t.state.backendStates.set('/pkg', { kind: 'failed', reason: 'gave up' });
      assert.deepStrictEqual(t.status(a, root), { kind: 'backendFailed', reason: 'gave up' });
      t.state.backendStates.set('/pkg', { kind: 'none' });
      assert.deepStrictEqual(t.status(a, root), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
      assert.strictEqual(t.status(new FakeDocument('/pkg/Notes.md', 'markdown')), undefined);
    });

    test('a backend that does not check (syntax only) refuses: the document stays unchecked, and Check File gets the sentence', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      await settle();
      // As NullBackend.load does (ARCHITECTURE §3.1: Unsupported is a sentence, never a silent no-op).
      t.backend.loads[0].reject(unsupported('Checking the file needs a backend.'));
      assert.deepStrictEqual(await check, { message: 'Checking the file needs a backend.', dir: undefined });
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'idle');
    });

    suite('overlapping checks of one document (second review)', () => {
      test('the first load determined the file, the second found its TTC fresh: the first result is shown', async () => {
        const a = new FakeDocument('/w/a/A.idr');
        const t = setup({ visible: [a] }); // shown: check 1
        await settle();
        t.saved.fire(a); // saved while check 1 is in flight: check 2, queued behind it
        await settle();
        assert.strictEqual(t.backend.loads.length, 2);
        t.backend.loads[0].resolve(result([[a.uri, [{ message: 'Unreachable clause: f n', severity: WARNING }]]]));
        await settle();
        assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'loading', 'check 2 still sets the state');
        t.backend.loads[1].resolve(result([])); // the TTC check 1 wrote is fresh: nothing determined (F7)
        await settle();
        assert.deepStrictEqual(t.collection.messages(a.uri), ['Unreachable clause: f n']);
        assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 0, warnings: 1, stale: false, known: true });
      });

      test('an error fixed by the load in flight when the document was saved twice does not stay on screen', async () => {
        const a = new FakeDocument('/w/a/A.idr');
        const t = setup();
        let check = t.checks.check(t.asDoc(a));
        await settle();
        t.backend.loads[0].resolve(result([[a.uri, [{ message: 'While processing', severity: ERROR }]]]));
        await check;
        t.saved.fire(a); // check 2: the fixed text
        await settle();
        t.saved.fire(a); // check 3, while check 2 is in flight
        await settle();
        t.backend.loads[1].resolve(result([[a.uri, []]])); // a clean rebuild
        t.backend.loads[2].resolve(result([])); // nothing to rebuild
        await settle();
        assert.deepStrictEqual(t.collection.messages(a.uri), []);
        assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
        check = t.checks.check(t.asDoc(a));
        await settle();
        t.backend.loads[3].resolve(result([]));
        await check;
        assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'ok');
      });

      test('a result of a check whose document was closed meanwhile is dropped', async () => {
        const a = new FakeDocument('/w/a/A.idr');
        const t = setup();
        const check = t.checks.check(t.asDoc(a));
        await settle();
        t.closed.fire(a);
        t.backend.loads[0].resolve(result([[a.uri, [{ message: 'x', severity: ERROR }]]]));
        await check;
        assert.strictEqual(t.collection.get(a.uri), undefined);
      });
    });

    test('the counts follow the collection: another document\'s load that rebuilt this one clean changes its status', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const b = new FakeDocument('/w/a/B.idr');
      const t = setup();
      let check = t.checks.check(t.asDoc(b));
      await settle();
      t.backend.loads[0].resolve(result([[b.uri, [{ message: 'e', severity: ERROR }]]]));
      await check;
      assert.deepStrictEqual(t.status(b), { kind: 'checked', errors: 1, warnings: 0, stale: false, known: true });
      check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[1].resolve(result([[a.uri, []], [b.uri, []]])); // B changed on disk and was rebuilt clean
      await check;
      assert.deepStrictEqual(t.status(b), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(b)), 'ok');
    });

    test('a load abandoned by Stop Backend or a restart (Cancelled) is no failure: the previous state stays, logged at info level', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      let check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'w', severity: WARNING }]]]));
      await check;
      check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[1].reject(cancelled('The Idris 2 session was stopped (Stop Backend).'));
      assert.strictEqual(await check, undefined);
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'warnings');
      assert.deepStrictEqual(t.status(a), { kind: 'checked', errors: 0, warnings: 1, stale: false, known: true });
      assert.ok(t.logged.includes('Not checked: /w/a/A.idr: The Idris 2 session was stopped (Stop Backend).'));
      assert.ok(!t.logged.some((m) => m.startsWith('Checking')), 'not logged as a failure');
    });
  });

  suite('what another file\'s change changes (second review)', () => {
    test('a document not checked because of an imported file\'s errors is checked again once a load finds that file clean', async () => {
      const usesBad = new FakeDocument('/w/b/UsesBad.idr');
      const bad = new FakeDocument('/w/b/Bad.idr');
      const t = setup({ visible: [usesBad, bad] });
      await settle();
      const notChecked = { message: 'Not checked: the compiler reported errors in Bad.idr.', severity: ERROR };
      const badError = { message: 'While processing right hand side of f.', severity: ERROR };
      t.backend.loads[0].resolve(result([[usesBad.uri, [notChecked]], [bad.uri, [badError]]], { blockedBy: [bad.uri] } as unknown as Partial<LoadResult>));
      t.backend.loads[1].resolve(result([[bad.uri, [badError]]]));
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'Bad.idr still has its error: nothing to check again');
      // Bad.idr fixed and saved: its load finds it clean, and UsesBad.idr is checked again.
      t.saved.fire(bad);
      await settle();
      t.backend.loads[2].resolve(result([[bad.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [usesBad, bad, bad, usesBad]);
      t.backend.loads[3].resolve(result([[usesBad.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.collection.messages(usesBad.uri), []);
      assert.deepStrictEqual(t.status(usesBad), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
    });

    test('a hidden such document is checked again when it is shown; with the manual trigger it is not', async () => {
      const usesBad = new FakeDocument('/w/b/UsesBad.idr');
      const bad = new FakeDocument('/w/b/Bad.idr');
      const t = setup({ visible: [usesBad] });
      await settle();
      t.backend.loads[0].resolve(
        result([[usesBad.uri, [{ message: 'Not checked: …', severity: ERROR }]], [bad.uri, [{ message: 'e', severity: ERROR }]]], {
          blockedBy: [bad.uri],
        } as unknown as Partial<LoadResult>),
      );
      await settle();
      t.show(bad);
      await settle();
      t.backend.loads[1].resolve(result([[bad.uri, []]]));
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'UsesBad.idr is not visible');
      t.show(usesBad, bad);
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [usesBad, bad, usesBad]);
      t.backend.loads[2].resolve(result([[usesBad.uri, []]]));
      await settle();
      t.show(bad);
      t.show(usesBad, bad); // nothing blocks it any more: not checked again
      await settle();
      assert.strictEqual(t.backend.loads.length, 3);

      // With the manual trigger only Check File checks: Bad.idr's clean load checks nothing else.
      const m = setup({ visible: [usesBad, bad], trigger: 'manual' });
      const first = m.checks.check(m.asDoc(usesBad));
      await settle();
      m.backend.loads[0].resolve(
        result([[usesBad.uri, [{ message: 'Not checked: …', severity: ERROR }]], [bad.uri, [{ message: 'e', severity: ERROR }]]], {
          blockedBy: [bad.uri],
        } as unknown as Partial<LoadResult>),
      );
      await first;
      const second = m.checks.check(m.asDoc(bad));
      await settle();
      m.backend.loads[1].resolve(result([[bad.uri, []]]));
      await second;
      await settle();
      assert.strictEqual(m.backend.loads.length, 2);
    });

    test('saving the root\'s .ipkg checks its visible documents again (not other roots\', not manual ones), which clears a fixed package-file error', async () => {
      const root: Classification = { kind: 'project', ipkgPath: '/w/p/bad.ipkg', dir: '/w/p', otherIpkgs: [], insideWorkspace: true, model: { status: 'error', source: 'dump-json', error: { message: 'x' } } };
      const main = new FakeDocument('/w/p/Main.idr');
      const other = new FakeDocument('/w/q/Other.idr');
      const ipkg = new FakeDocument('/w/p/bad.ipkg', 'ipkg');
      const t = setup();
      t.state.roots.set(main.fileName, root);
      t.show(main, other);
      await settle();
      const pkgError = { message: 'Unrecognised property "pkgs".', severity: ERROR };
      t.backend.loads[0].resolve(
        result([[ipkg.uri, [pkgError]], [main.uri, [{ message: 'Not checked: the package file bad.ipkg could not be read.', severity: ERROR }]]], {
          packageError: { uri: ipkg.uri, message: pkgError.message },
        } as unknown as Partial<LoadResult>),
      );
      t.backend.loads[1].resolve(result([[other.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.status(main), { kind: 'packageError', ipkg: '/w/p/bad.ipkg', message: pkgError.message, stale: false });
      t.saved.fire(ipkg); // the user removed the pkgs line
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [main, other, main]);
      t.backend.loads[2].resolve(result([[ipkg.uri, []], [main.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.collection.messages(ipkg.uri), []);
      assert.deepStrictEqual(t.status(main), { kind: 'checked', errors: 0, warnings: 0, stale: false, known: true });
      t.saved.fire(new FakeDocument('/w/elsewhere/x.ipkg', 'ipkg'));
      t.state.trigger = 'manual';
      t.saved.fire(ipkg);
      await settle();
      assert.strictEqual(t.backend.loads.length, 3);
    });
  });

  suite('changes on disk, editor groups, a new root (M2 third review)', () => {
    /** The file of `doc` holds `text` on disk. */
    const onDisk = (t: ReturnType<typeof setup>, doc: FakeDocument, text: string): void => void t.state.disk.set(doc.fileName, text);

    /** A document checked clean with `text` (on disk too), visible. */
    async function checkedClean(t: ReturnType<typeof setup>, doc: FakeDocument, text: string): Promise<void> {
      doc.text = text;
      onDisk(t, doc, text);
      const check = t.checks.check(t.asDoc(doc));
      await settle();
      t.backend.loads[t.backend.loads.length - 1].resolve(result([[doc.uri, [{ message: 'e', severity: ERROR }]]]));
      await check;
    }

    /** VS Code reloads a clean document from its changed file: one text change, the document still clean. */
    function reload(t: ReturnType<typeof setup>, doc: FakeDocument, text: string): void {
      onDisk(t, doc, text);
      doc.text = text;
      doc.version++;
      t.edited.fire({ document: doc, contentChanges: [{}] });
    }

    /**
     * An edit in the editor as VS Code 1.139.1 reports a file's change (checks.ts module comment,
     * *Changes on disk* [src]): the text change carries the dirty state from BEFORE it, and a change
     * of that state follows as an event without content changes. `dirtyAfter` is false for an undo
     * back to the saved version.
     */
    function type(t: ReturnType<typeof setup>, doc: FakeDocument, text: string, dirtyAfter = true): void {
      doc.text = text;
      doc.version++;
      t.edited.fire({ document: doc, contentChanges: [{}] });
      if (doc.isDirty !== dirtyAfter) {
        doc.isDirty = dirtyAfter;
        t.edited.fire({ document: doc });
      }
    }

    /** An undo back to the saved version, whose text is `text`. */
    const undo = (t: ReturnType<typeof setup>, doc: FakeDocument, text: string): void => type(t, doc, text, false);

    /** A save as VS Code reports it: the file written, the document clean (a dirty-state event), then the save event. */
    function save(t: ReturnType<typeof setup>, doc: FakeDocument): void {
      onDisk(t, doc, doc.text);
      if (doc.isDirty) {
        doc.isDirty = false;
        t.edited.fire({ document: doc });
      }
      t.saved.fire(doc);
    }

    const current = (errors: number) => ({ kind: 'checked', errors, warnings: 0, stale: false, known: true });
    const staleResult = (errors: number, unsaved: boolean, manual = false) => ({
      kind: 'checked',
      errors,
      warnings: 0,
      stale: true,
      known: true,
      staleness: { unsaved, manual },
    });

    test('a clean document whose file changed on disk (VS Code reloaded it) is checked again; meanwhile it is stale, not current', async () => {
      const a = new FakeDocument('/w/a/Bad.idr');
      const t = setup();
      await checkedClean(t, a, 'x = "a"');
      assert.deepStrictEqual(t.status(a), current(1));
      // `git checkout` / a formatter: new text, a new version, not dirty.
      reload(t, a, 'x = 1');
      assert.deepStrictEqual(t.status(a), staleResult(1, false), 'before the file was read');
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'checked again');
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.status(a), current(0));
    });

    test('a reload is recognised with a BOM and other line ends on disk (VS Code drops the one and has one line-end sequence)', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1\n');
      a.text = 'x = 2\ny = 3\n';
      a.version++;
      onDisk(t, a, `${String.fromCharCode(0xfeff)}x = 2\r\ny = 3\r\n`);
      t.edited.fire({ document: a, contentChanges: [{}] });
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
    });

    // M2 second verification: VS Code sends the first keystroke after a check as a text change of
    // a CLEAN document, then a dirty-state event. It was taken for a reload: the saved file was
    // loaded again (also after Stop Backend, which it undid), and an undo read `stale`.
    test('a keystroke loads nothing and reads stale (unsaved); an undo back to the checked text reads the result again', async () => {
      for (const trigger of ['onSave', 'manual'] as const) {
        const a = new FakeDocument('/w/a/A.idr');
        const t = setup({ trigger });
        await checkedClean(t, a, 'x = 1');
        type(t, a, 'x = 12');
        await settle();
        assert.strictEqual(t.backend.loads.length, 1, `${trigger}: the keystroke loaded the file`);
        assert.deepStrictEqual(t.status(a), staleResult(1, true, trigger === 'manual'), trigger);
        type(t, a, 'x = 123');
        undo(t, a, 'x = 1');
        await settle();
        assert.strictEqual(t.backend.loads.length, 1, trigger);
        assert.deepStrictEqual(t.status(a), current(1), `${trigger}: the result applies to this text again`);
      }
    });

    test('a keystroke whose dirty-state event comes only after the file was read is not taken for a reload', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      a.text = 'x = 12';
      a.version++;
      t.edited.fire({ document: a, contentChanges: [{}] });
      await settle(); // the file has been read: it holds x = 1
      assert.deepStrictEqual(t.state.reads, ['/w/a/A.idr']);
      a.isDirty = true;
      t.edited.fire({ document: a });
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      assert.deepStrictEqual(t.status(a), staleResult(1, true));
    });

    test('a keystroke while a check runs loads nothing more; the check read the saved text, which the document no longer shows', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      a.text = 'x = 1';
      onDisk(t, a, 'x = 1');
      const check = t.checks.check(t.asDoc(a));
      await settle();
      type(t, a, 'x = 12');
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'e', severity: ERROR }]]]));
      await check;
      assert.deepStrictEqual(t.status(a), staleResult(1, true));
      undo(t, a, 'x = 1');
      assert.deepStrictEqual(t.status(a), current(1));
    });

    test('after Stop Backend a keystroke leaves the compiler stopped (no load); the next save starts it', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      t.state.backendStates.set('/w/a', { kind: 'stopped' });
      type(t, a, 'x = 12');
      await settle();
      assert.strictEqual(t.backend.loads.length, 1, 'a load would start the stopped compiler again');
      assert.deepStrictEqual(t.status(a), { kind: 'stopped' });
      save(t, a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
    });

    test('type a text, undo, then that text arrives from disk: it is checked, not taken for the checked text', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      type(t, a, 'x = 12');
      undo(t, a, 'x = 1');
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      reload(t, a, 'x = 12'); // git stash pop, a formatter, another editor
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.status(a), current(0));
    });

    test('a check that starts between a text change and its dirty-state event reads the file for the text it checks', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      a.text = 'x = 12';
      a.version++;
      t.edited.fire({ document: a, contentChanges: [{}] }); // the keystroke; its dirty-state event is still to come …
      const between = t.checks.check(t.asDoc(a)); // … when another trigger checks the document
      a.isDirty = true;
      t.edited.fire({ document: a });
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      t.backend.loads[1].resolve(result([[a.uri, [{ message: 'of x = 1', severity: ERROR }]]]));
      await between;
      undo(t, a, 'x = 1');
      assert.deepStrictEqual(t.status(a), current(1), 'the check read x = 1, which the document shows again');
      reload(t, a, 'x = 12');
      await settle();
      assert.strictEqual(t.backend.loads.length, 3, 'x = 12 was never checked');
    });

    test('a check started with unsaved changes (Check File) is of the file: undone to it, current; a reload after that is noticed', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ trigger: 'manual' });
      a.text = 'x = 1';
      onDisk(t, a, 'x = 1');
      type(t, a, 'x = 12');
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'of x = 1', severity: ERROR }]]]));
      await check;
      assert.deepStrictEqual(t.status(a), staleResult(1, true, true));
      undo(t, a, 'x = 1');
      assert.deepStrictEqual(t.status(a), current(1));
      reload(t, a, 'x = 2');
      await settle();
      assert.strictEqual(t.backend.loads.length, 1, 'manual: not checked');
      assert.deepStrictEqual(t.status(a), staleResult(1, false, true));
    });

    test('a save\'s dirty-state event alone checks nothing; the save event does', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      type(t, a, 'x = 2');
      onDisk(t, a, 'x = 2');
      a.isDirty = false;
      t.edited.fire({ document: a });
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      t.saved.fire(a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
    });

    test('with the manual trigger a document changed on disk is not checked, but reads stale', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ trigger: 'manual' });
      await checkedClean(t, a, 'x = 1');
      reload(t, a, 'x = 2');
      await settle();
      assert.strictEqual(t.backend.loads.length, 1);
      assert.deepStrictEqual(t.status(a), staleResult(1, false, true));
    });

    test('a file deleted and created again (a checkout) is checked again when it appears; with the manual trigger it is not', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      t.deleted.fire(uri('/w/a/A.idr'));
      t.created.fire(uri('/w/a/Other.idr'));
      await settle();
      assert.strictEqual(t.backend.loads.length, 1, 'another file');
      t.created.fire(uri('/w/a')); // the folder, restored with the file in it
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      t.created.fire(uri('/w/a/A.idr'));
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'once');
      const m = setup({ trigger: 'manual' });
      await checkedClean(m, a, 'x = 1');
      m.deleted.fire(uri('/w/a/A.idr'));
      m.created.fire(uri('/w/a/A.idr'));
      await settle();
      assert.strictEqual(m.backend.loads.length, 1);
    });

    // M2 verification of the third review: a reload was compared with the text of the last
    // COMPLETED check only, so the reloads below, which arrive while a check runs, were missed.
    test('deleted, then created again with another text: the create checks the old text, the reload that follows the new one', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      t.deleted.fire(uri('/w/a/A.idr'));
      t.created.fire(uri('/w/a/A.idr')); // the watcher's event comes first …
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'the create checks it');
      reload(t, a, 'x = "b"'); // … VS Code's reload of the new text later
      await settle();
      assert.strictEqual(t.backend.loads.length, 3, 'the reload brought another text: checked again');
      t.backend.loads[1].resolve(result([[a.uri, [{ message: 'of the new text', severity: ERROR }]]]));
      t.backend.loads[2].resolve(result([[a.uri, [{ message: 'of the new text', severity: ERROR }]]]));
      await settle();
      assert.deepStrictEqual(t.status(a), current(1));
    });

    test('a change on disk during the first check, and back and forth during a later one, checks the text it brought', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      a.text = 'A';
      const t = setup();
      onDisk(t, a, 'A');
      const first = t.checks.check(t.asDoc(a));
      await settle();
      reload(t, a, 'B');
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'the first check read A');
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'of A', severity: ERROR }]]]));
      await first;
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.status(a), current(0));
      // A → C (its check starts) → A again while it runs.
      reload(t, a, 'C');
      await settle();
      assert.strictEqual(t.backend.loads.length, 3);
      reload(t, a, 'B');
      await settle();
      assert.strictEqual(t.backend.loads.length, 4, 'back to the text of the last completed check, but the running check read C');
      t.backend.loads[2].resolve(result([[a.uri, [{ message: 'of C', severity: ERROR }]]]));
      t.backend.loads[3].resolve(result([[a.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.collection.messages(a.uri), []);
      assert.deepStrictEqual(t.status(a), current(0));
    });

    test('an undo back to the saved text while the save\'s check runs loads nothing more, and the result is current', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'A');
      type(t, a, 'B');
      save(t, a);
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      type(t, a, 'Bx');
      undo(t, a, 'B');
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'the running check read B');
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await settle();
      assert.deepStrictEqual(t.status(a), current(0));
    });

    test('an undo back to the text of a check Stop Backend cancelled does not start the compiler again; it reads stale', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'A');
      type(t, a, 'B');
      save(t, a);
      await settle();
      t.backend.loads[1].reject(cancelled('The Idris 2 session was stopped (Stop Backend).'));
      await settle();
      type(t, a, 'Bx');
      undo(t, a, 'B');
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      assert.deepStrictEqual(t.status(a), staleResult(1, false));
    });

    test('a document shown in two editor groups is loaded once by a restart, an .ipkg save, a consent answer and recheckVisible', async () => {
      // Each trigger visits it twice; the first check is no longer the newest once it has
      // classified the file, and stops before it loads (M2 third review: a double load was suspected).
      const root: Classification = { kind: 'project', ipkgPath: '/w/p/p.ipkg', dir: '/w/p', otherIpkgs: [], insideWorkspace: true, model: { status: 'error', source: 'dump-json', error: { message: 'x' } } };
      const main = new FakeDocument('/w/p/Main.idr');
      const t = setup();
      t.state.roots.set(main.fileName, root);
      t.show(main, main);
      await settle();
      assert.strictEqual(t.backend.loads.length, 1, 'shown');
      const resolveAll = async (): Promise<void> => {
        t.backend.loads.forEach((l) => l.resolve(result([[main.uri, []]])));
        await settle();
      };
      await resolveAll();
      t.restarted.fire({ root, cause: 'reconfigure' });
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'restart');
      await resolveAll();
      t.saved.fire(new FakeDocument('/w/p/p.ipkg', 'ipkg'));
      await settle();
      assert.strictEqual(t.backend.loads.length, 3, '.ipkg saved');
      await resolveAll();
      const rechecked = t.checks.recheckVisible();
      await settle();
      assert.strictEqual(t.backend.loads.length, 4, 'recheckVisible');
      await resolveAll();
      await rechecked;
      // A consent answer: the refused document is checked again once.
      const refused = t.checks.check(t.asDoc(main));
      await settle();
      t.backend.loads[4].reject(unsupported('not allowed'));
      await refused;
      t.state.verdicts.set('/w/p', { allowed: true, basis: 'window' });
      t.consentChanged.fire();
      await settle();
      assert.strictEqual(t.backend.loads.length, 6, 'consent answered');
    });

    test('a check that finds the document in another root releases the old one when no open document needs it', async () => {
      const a = new FakeDocument('/w/p/src/A.idr');
      const t = setup();
      const project: Classification = { kind: 'project', ipkgPath: '/w/p/p.ipkg', dir: '/w/p', otherIpkgs: [], insideWorkspace: true, model: { status: 'error', source: 'dump-json', error: { message: 'x' } } };
      t.state.roots.set(a.fileName, project);
      await checkedClean(t, a, 'x');
      assert.deepStrictEqual(t.released, []);
      // p.ipkg renamed: the file is loose now.
      t.state.roots.delete(a.fileName);
      const check = t.checks.check(t.asDoc(a));
      await settle();
      assert.deepStrictEqual(t.released, ['/w/p'], 'the old root, at once: its session would keep the old package');
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await check;
      // Not while another open document still belongs to the old root.
      const b = new FakeDocument('/w/q/src/B.idr');
      const c = new FakeDocument('/w/q/src/C.idr');
      const q: Classification = { ...project, ipkgPath: '/w/q/q.ipkg', dir: '/w/q' };
      t.state.roots.set(b.fileName, q);
      t.state.roots.set(c.fileName, q);
      await checkedClean(t, b, 'b');
      await checkedClean(t, c, 'c');
      t.state.roots.delete(b.fileName);
      const moved = t.checks.check(t.asDoc(b));
      await settle();
      assert.deepStrictEqual(t.released, ['/w/p']);
      t.backend.loads[t.backend.loads.length - 1].resolve(result([[b.uri, []]]));
      await moved;
    });

    // --- verification after Q20–Q22 ---------------------------------------------------------------

    test('an undo back to the checked text while a check of that text runs makes the result current; cancelled, it stays current', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      save(t, a); // Ctrl+S on the clean file: a second check of 'x = 1'
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
      type(t, a, 'x = 12');
      undo(t, a, 'x = 1');
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'the undo starts nothing');
      t.backend.loads[1].reject(cancelled('The Idris 2 session was stopped (Stop Backend).'));
      await settle();
      assert.deepStrictEqual(t.status(a), current(1), 'the text is the one the last completed check read');
    });

    test('a reload back to the checked text while another check runs makes the result current again', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      await checkedClean(t, a, 'x = 1');
      reload(t, a, 'x = 2');
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'x = 2 is checked');
      reload(t, a, 'x = 1'); // back, e.g. `git checkout -` while that check runs
      await settle();
      assert.strictEqual(t.backend.loads.length, 3, 'the running check read another text: checked again');
      t.backend.loads[1].reject(cancelled('The Idris 2 session was stopped (Stop Backend).'));
      t.backend.loads[2].reject(cancelled('The Idris 2 session was stopped (Stop Backend).'));
      await settle();
      assert.deepStrictEqual(t.status(a), current(1));
    });

    test('a file deleted while its check runs: the result is not shown on it, and its creation checks it again', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const dep = new FakeDocument('/w/a/Dep.idr');
      const t = setup({ visible: [a] });
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, []]]));
      await settle();
      t.saved.fire(a); // a check runs …
      await settle();
      t.deleted.fire(uri('/w/a/A.idr')); // … when the file goes (git switch)
      t.backend.loads[1].resolve(result([
        [a.uri, [{ message: 'File Not Found', severity: ERROR }]],
        [dep.uri, [{ message: 'w', severity: WARNING }]],
      ]));
      await settle();
      assert.strictEqual(t.collection.get(a.uri), undefined, 'not on the deleted file');
      assert.deepStrictEqual(t.collection.messages(dep.uri), ['w'], 'the other files it determined are shown');
      assert.deepStrictEqual(t.status(a), { kind: 'notChecked' });
      t.created.fire(uri('/w/a/A.idr')); // back, with the same text: VS Code reloads nothing
      await settle();
      assert.strictEqual(t.backend.loads.length, 3, 'checked again');
    });

    test('a folder deleted while a check runs: its late result is shown on no file at or below it; a check started after it is', async () => {
      // M2 verification of the Q20–Q22 fixes (the verifier's probe N12): only the checked document's
      // own file was left out, so an imported module below the deleted folder got its error back.
      const a = new FakeDocument('/w/a/A.idr');
      const b = uri('/w/a/B.idr'); // imported, not open
      const other = uri('/w/o/O.idr'); // imported from another folder, not deleted
      const t = setup({ visible: [a] });
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, []], [b, [{ message: 'b error', severity: ERROR }]]]));
      await settle();
      t.saved.fire(a); // check 2 runs …
      await settle();
      t.deleted.fire(uri('/w/a')); // … when the folder goes (git switch)
      assert.strictEqual(t.collection.get(b), undefined, 'the deletion removes it');
      t.saved.fire(a); // check 3 starts after the deletion (the file is back meanwhile, say)
      await settle();
      t.backend.loads[1].resolve(result([[a.uri, []], [b, [{ message: 'b error', severity: ERROR }]], [other, [{ message: 'o', severity: WARNING }]]]));
      await settle();
      assert.strictEqual(t.collection.get(b), undefined, 'the late result is not shown below the deleted folder');
      assert.strictEqual(t.collection.get(a.uri), undefined);
      assert.deepStrictEqual(t.collection.messages(other), ['o'], 'what it determined elsewhere is shown');
      t.backend.loads[2].resolve(result([[a.uri, []], [b, [{ message: 'b again', severity: ERROR }]]]));
      await settle();
      assert.deepStrictEqual(t.collection.messages(b), ['b again'], 'a check that started after the deletion is shown');
      // No check runs: a deletion is not remembered for later checks.
      t.deleted.fire(uri('/w/a/B.idr'));
      t.saved.fire(a);
      await settle();
      t.backend.loads[3].resolve(result([[a.uri, []], [b, [{ message: 'b third', severity: ERROR }]]]));
      await settle();
      assert.deepStrictEqual(t.collection.messages(b), ['b third']);
    });

    test('a reload after a first check that failed checks the new text; a document never checked is not checked by one', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      a.text = 'x = 1';
      onDisk(t, a, 'x = 1');
      const first = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].reject(new IdrisException({ kind: 'BackendCrashed', message: 'exit 1' }));
      await first;
      assert.deepStrictEqual(t.status(a), { kind: 'loadFailed', reason: 'exit 1' });
      reload(t, a, 'x = 2'); // fixed in another editor, or a checkout
      await settle();
      assert.strictEqual(t.backend.loads.length, 2, 'checked again');
      // A document tracked (afterDelay's timer) but never checked: a reload checks nothing.
      const b = new FakeDocument('/w/a/B.idr');
      t.state.trigger = 'afterDelay';
      type(t, b, 'y = 1');
      undo(t, b, 'y = 0');
      reload(t, b, 'y = 2');
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
    });

    test('a check that started with unsaved changes: its result is stale for any other text, also after a save (manual)', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ trigger: 'manual' });
      await checkedClean(t, a, 'x = 1');
      type(t, a, 'x = 12');
      const check = t.checks.check(t.asDoc(a)); // Check File with unsaved changes: the file's 'x = 1' is checked
      await settle();
      save(t, a); // manual: the save checks nothing
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await check;
      assert.deepStrictEqual(t.status(a), staleResult(0, false, true), 'the check read x = 1, the document shows x = 12');
      type(t, a, 'x = 1'); // an undo: dirty, since the file holds x = 12 now
      assert.deepStrictEqual(t.status(a), staleResult(0, true, true));
    });

    test('a file that is not UTF-8: stale after a reload, current after Check File, stale after the next reload', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup({ trigger: 'manual' });
      await checkedClean(t, a, 'x = 1');
      // VS Code decoded the file with another encoding; the UTF-8 read differs.
      const unmatched = (text: string, disk: string) => {
        a.text = text;
        a.version++;
        onDisk(t, a, disk);
        t.edited.fire({ document: a, contentChanges: [{}] });
      };
      unmatched('x = "é"', 'x = "\uFFFD"');
      await settle();
      assert.deepStrictEqual(t.status(a), staleResult(1, false, true));
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[1].resolve(result([[a.uri, []]]));
      await check;
      assert.deepStrictEqual(t.status(a), current(0), 'the check read the file the document shows');
      unmatched('x = "è"', 'x = "\uFFFD\uFFFD"');
      await settle();
      assert.deepStrictEqual(t.status(a), staleResult(0, false, true), 'stale again (before: never again)');
    });
  });

  suite('clearing', () => {
    test('closing an Idris document removes its diagnostics and state (not those of other files)', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const c = new FakeDocument('/w/a/C.idr'); // keeps the root open
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      const other = t.checks.check(t.asDoc(c));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'x', severity: ERROR }]], [uri('/w/a/B.idr'), [{ message: 'y', severity: ERROR }]]]));
      t.backend.loads[1].resolve(result([[c.uri, []]]));
      await check;
      await other;
      t.closed.fire(a);
      assert.strictEqual(t.collection.get(a.uri), undefined);
      assert.deepStrictEqual(t.collection.messages(uri('/w/a/B.idr')), ['y']);
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), undefined);
    });

    test('the root\'s last document closed: what its loads set on files that are not open goes too (no session is left to update it)', async () => {
      const uses = new FakeDocument('/w/a/UsesBad.idr');
      const other = new FakeDocument('/w/b/Other.idr');
      const open = new FakeDocument('/w/a/Open.idr');
      const t = setup();
      t.state.roots.set(open.fileName, { kind: 'loose', dir: '/w/c' }); // open, and tracked for another root
      const first = t.checks.check(t.asDoc(open));
      await settle();
      t.backend.loads[0].resolve(result([[open.uri, []]]));
      await first;
      const check = t.checks.check(t.asDoc(uses));
      await settle();
      // UsesBad's load built the imported Bad.idr (never opened) and the open Open.idr.
      t.backend.loads[1].resolve(
        result([
          [uses.uri, [{ message: 'Not checked', severity: WARNING }]],
          [uri('/w/a/Bad.idr'), [{ message: 'e', severity: ERROR }]],
          [open.uri, [{ message: 'o', severity: WARNING }]],
        ]),
      );
      await check;
      // Another root's load set a diagnostic on a file below /w/a: it is not this root's to remove.
      const second = t.checks.check(t.asDoc(other));
      await settle();
      t.backend.loads[2].resolve(result([[other.uri, []], [uri('/w/a/Shared.idr'), [{ message: 's', severity: WARNING }]]]));
      await second;
      t.closed.fire(uses);
      assert.deepStrictEqual(t.released, ['/w/a']);
      assert.strictEqual(t.collection.get(uri('/w/a/Bad.idr')), undefined, 'Bad.idr, set by the released root and not open, is cleared');
      assert.deepStrictEqual(t.collection.messages(open.uri), ['o'], 'an open document keeps what it shows');
      assert.deepStrictEqual(t.collection.messages(uri('/w/a/Shared.idr')), ['s'], 'set by another root');
    });

    test('manual trigger: an open file that was never checked itself keeps what another file\'s load gave it when that root is released, until it closes', async () => {
      // M2 verification of the third review: release removed what every untracked file showed, so
      // an open, visible B.idr lost its errors when the checked A.idr closed.
      const a = new FakeDocument('/w/a/A.idr');
      const b = new FakeDocument('/w/a/B.idr');
      const t = setup({ visible: [a, b], trigger: 'manual' });
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'Not checked', severity: WARNING }]], [b.uri, [{ message: 'error in B', severity: ERROR }]]]));
      await check;
      t.closed.fire(a);
      assert.deepStrictEqual(t.released, ['/w/a']);
      assert.deepStrictEqual(t.collection.messages(b.uri), ['error in B'], 'B is open: it keeps its error');
      t.closed.fire(b);
      assert.strictEqual(t.collection.get(b.uri), undefined, 'closed after its root was released: nothing is left to update it');
      // While the root has a checked document, closing a file it never tracked keeps what it shows.
      const c = new FakeDocument('/w/c/C.idr');
      const d = new FakeDocument('/w/c/D.idr');
      const u = setup({ visible: [c, d], trigger: 'manual' });
      const checkC = u.checks.check(u.asDoc(c));
      await settle();
      u.backend.loads[0].resolve(result([[c.uri, []], [d.uri, [{ message: 'd', severity: WARNING }]]]));
      await checkC;
      u.closed.fire(d);
      assert.deepStrictEqual(u.collection.messages(d.uri), ['d']);
    });

    test('closing the last document of a root releases its sessions; not while another of the root is open or still being classified', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const b = new FakeDocument('/w/a/B.idr');
      const other = new FakeDocument('/w/other/C.idr');
      const t = setup();
      const checked = async (doc: FakeDocument): Promise<void> => {
        const check = t.checks.check(t.asDoc(doc));
        await settle();
        t.backend.loads.at(-1)?.resolve(result([[doc.uri, []]]));
        await check;
      };
      await checked(a);
      await checked(b);
      await checked(other);
      t.closed.fire(a);
      assert.deepStrictEqual(t.released, [], 'B.idr of the same root is still open');
      t.closed.fire(other);
      assert.deepStrictEqual(t.released, ['/w/other']);
      // A check that is still classifying its document may belong to the root: kept.
      let classified: (root: Classification) => void = () => undefined;
      const d = new FakeDocument('/w/x/D.idr');
      t.state.slowClassify.set(d.fileName, new Promise((resolve) => (classified = resolve)));
      const pending = t.checks.check(t.asDoc(d));
      await settle();
      t.closed.fire(b);
      assert.deepStrictEqual(t.released, ['/w/other']);
      classified({ kind: 'loose', dir: '/w/a' });
      await settle();
      t.backend.loads.at(-1)?.resolve(result([[d.uri, []]]));
      await pending;
      t.closed.fire(d);
      assert.deepStrictEqual(t.released, ['/w/other', '/w/a']);
      // A document that was never checked holds no session: closing it releases nothing.
      t.closed.fire(new FakeDocument('/w/y/E.idr'));
      assert.deepStrictEqual(t.released, ['/w/other', '/w/a']);
    });

    test('an open document that was never checked here keeps, when it closes, what another file\'s load gave it', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const b = new FakeDocument('/w/a/B.idr');
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, []], [b.uri, [{ message: 'Unreachable clause', severity: WARNING }]]]));
      await check;
      t.opened.fire(b); // opened but never shown (Peek Definition, another extension)
      t.closed.fire(b);
      assert.deepStrictEqual(t.collection.messages(b.uri), ['Unreachable clause']);
    });

    test('the last document of a project closed: the .ipkg\'s diagnostics go with its sessions', async () => {
      const root: Classification = { kind: 'project', ipkgPath: '/w/p/bad.ipkg', dir: '/w/p', otherIpkgs: [], insideWorkspace: true, model: { status: 'error', source: 'dump-json', error: { message: 'x' } } };
      const main = new FakeDocument('/w/p/Main.idr');
      const t = setup();
      t.state.roots.set(main.fileName, root);
      const check = t.checks.check(t.asDoc(main));
      await settle();
      t.backend.loads[0].resolve(result([[uri('/w/p/bad.ipkg'), [{ message: 'Unrecognised property "pkgs".', severity: ERROR }]], [main.uri, []]]));
      await check;
      t.closed.fire(main);
      assert.deepStrictEqual(t.released, ['/w/p']);
      assert.strictEqual(t.collection.get(uri('/w/p/bad.ipkg')), undefined);
    });

    test('a deleted file, or a deleted folder, removes the diagnostics at or below it', async () => {
      const t = setup();
      for (const file of ['/w/a/A.idr', '/w/a/sub/B.idr', '/w/ab/C.idr']) {
        t.collection.set(uri(file), [{ message: file, severity: ERROR }]);
      }
      t.deleted.fire(uri('/w/a/sub/B.idr'));
      assert.deepStrictEqual([...t.collection.entries.keys()], ['file:///w/a/A.idr', 'file:///w/ab/C.idr']);
      t.deleted.fire(uri('/w/a'));
      assert.deepStrictEqual([...t.collection.entries.keys()], ['file:///w/ab/C.idr']);
    });

    test('an open document whose file is deleted reads as not checked, not with its old counts', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const t = setup();
      const check = t.checks.check(t.asDoc(a));
      await settle();
      t.backend.loads[0].resolve(result([[a.uri, [{ message: 'e', severity: ERROR }]]]));
      await check;
      const before = t.changes();
      t.deleted.fire(uri('/w/a/A.idr'));
      assert.strictEqual(t.collection.get(a.uri), undefined);
      assert.deepStrictEqual(t.status(a), { kind: 'notChecked' });
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'idle');
      assert.ok(t.changes() > before);
    });
  });

  suite('automatic restarts (onDidRestart)', () => {
    test('reconfigure: the visible documents of that root are checked again, unless their trigger is manual', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const a2 = new FakeDocument('/w/a/A2.idr');
      const b = new FakeDocument('/w/b/B.idr');
      const hidden = new FakeDocument('/w/a/H.idr');
      const t = setup({ visible: [a, a2, b] });
      await settle();
      t.backend.loads.forEach((l) => l.resolve(result([[l.doc.uri, []]])));
      const hiddenCheck = t.checks.check(t.asDoc(hidden));
      await settle();
      t.backend.loads.at(-1)?.resolve(result([[hidden.uri, []]]));
      await hiddenCheck;
      const before = t.backend.loads.length;
      t.restarted.fire({ root: { kind: 'loose', dir: '/w/a' }, cause: 'reconfigure' });
      await settle();
      assert.deepStrictEqual(t.backend.loads.slice(before).map((l) => l.doc), [a, a2]);
      t.state.trigger = 'manual';
      t.restarted.fire({ root: { kind: 'loose', dir: '/w/a' }, cause: 'reconfigure' });
      await settle();
      assert.strictEqual(t.backend.loads.length, before + 2);
    });

    test('crash: a visible document whose load the crash killed is checked once more, and only once until a check completes', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const ok = new FakeDocument('/w/a/Ok.idr');
      const t = setup({ visible: [a, ok] });
      await settle();
      const crashed = new IdrisException({ kind: 'BackendCrashed', message: 'The Idris 2 process ended while answering :load-file.' });
      t.backend.loads[0].reject(crashed);
      t.backend.loads[1].resolve(result([[ok.uri, []]]));
      await settle();
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(a)), 'failed');
      const root: Classification = { kind: 'loose', dir: '/w/a' };
      t.restarted.fire({ root, cause: 'crash' });
      await settle();
      assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [a, ok, a], 'only the failed document');
      t.backend.loads[2].reject(crashed); // it crashes the compiler again
      await settle();
      t.restarted.fire({ root, cause: 'crash' });
      await settle();
      assert.strictEqual(t.backend.loads.length, 3, 'no second retry: no loop');
      // A completed check (the user saved) allows one retry again.
      t.saved.fire(a);
      await settle();
      t.backend.loads[3].resolve(result([[a.uri, []]]));
      await settle();
      t.backend.loads.length = 0;
      t.saved.fire(a);
      await settle();
      t.backend.loads[0].reject(crashed);
      await settle();
      t.restarted.fire({ root, cause: 'crash' });
      await settle();
      assert.strictEqual(t.backend.loads.length, 2);
    });
  });

  test('recheckVisible: the visible documents of one root (or of all), unless their trigger is manual', async () => {
    const a = new FakeDocument('/w/a/A.idr');
    const b = new FakeDocument('/w/b/B.idr');
    const t = setup({ visible: [a, b], trigger: 'manual' });
    await t.checks.recheckVisible(LOOSE);
    assert.strictEqual(t.backend.loads.length, 0);
    t.state.trigger = 'onSave';
    void t.checks.recheckVisible({ kind: 'loose', dir: '/w/b' });
    await settle();
    assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [b]);
    void t.checks.recheckVisible();
    await settle();
    assert.deepStrictEqual(t.backend.loads.map((l) => l.doc), [b, a, b]);
  });

  suite('the active document and idris2.ideMode.maxBackgroundChecks (ROADMAP §9 Q21)', () => {
    const clean = (doc: FakeDocument) => result([[doc.uri, []]]);
    /** The documents whose load was asked for, in order. */
    const loaded = (t: ReturnType<typeof setup>) => t.backend.loads.map((l) => l.doc);
    /** Answers the load of `doc` (the first unanswered one). */
    const finish = (t: ReturnType<typeof setup>, doc: FakeDocument, answered: Set<number>) => {
      const index = t.backend.loads.findIndex((l, i) => l.doc === doc && !answered.has(i));
      assert.ok(index >= 0, `no load of ${doc.fileName}`);
      answered.add(index);
      t.backend.loads[index].resolve(clean(doc));
    };

    test('several visible documents checked at once: the active one\'s load is queued last, so that its file is the one loaded (fourth review of M3)', async () => {
      // A root's compiler answers about the file it loaded last (F27), and a passive query loads
      // only the active document: loaded first, the active file was loaded a second time for its
      // hints, and the other file's queries were refused.
      const [a, b] = ['/w/p/A.idr', '/w/p/B.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b], active: a });
      await settle();
      assert.deepStrictEqual(loaded(t), [b, a], 'at activation');
      const answerAll = async () => {
        t.backend.loads.forEach((l) => l.resolve(clean(l.doc)));
        await settle();
      };
      await answerAll();
      const rechecked = t.checks.recheckVisible();
      await settle();
      assert.deepStrictEqual(loaded(t).slice(2), [b, a], 'Restart Backend (recheckVisible)');
      await answerAll();
      await rechecked;
      t.restarted.fire({ root: { kind: 'loose', dir: '/w/p' }, cause: 'reconfigure' });
      await settle();
      assert.deepStrictEqual(loaded(t).slice(4), [b, a], 'a restart for a changed command line');
      await answerAll();
      // Trust granted: the visible documents are checked as if just shown.
      const u = setup({ visible: [a, b], active: a, trusted: false });
      await settle();
      u.trust.isTrusted = true;
      u.trustGranted.fire();
      await settle();
      assert.deepStrictEqual(loaded(u), [b, a], 'trust granted');
      // Refused, then allowed: both are checked again, the active one last.
      const r = setup({ visible: [a, b], active: a });
      await settle();
      r.backend.loads.forEach((l) => l.reject(unsupported('not allowed')));
      await settle();
      r.state.verdicts.set('/w/p', { allowed: true, basis: 'window' });
      r.consentChanged.fire();
      await settle();
      assert.deepStrictEqual(loaded(r).slice(2), [b, a], 'a consent answer');
    });

    test('0 (the default): three background documents are loaded at once, as before', async () => {
      const [a, b, c] = ['/w/a/A.idr', '/w/b/B.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c] });
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c]);
    });

    test('1 with three background documents: one load at a time, in order, each waiting as checking…; the active document\'s check starts at once meanwhile', async () => {
      const [a, b, c] = ['/w/a/A.idr', '/w/b/B.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      await settle();
      assert.deepStrictEqual(loaded(t), [a]);
      assert.deepStrictEqual(t.status(c), { kind: 'checking', waitingFor: undefined }, 'waiting reads as checking…');
      // The active document is checked at once, beside the background check that holds the slot.
      const x = new FakeDocument('/w/x/X.idr');
      t.activate(x);
      t.show(a, b, c, x);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, x]);
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, x, b]);
      finish(t, x, answered); // the active check held no slot: nothing more starts
      await settle();
      assert.deepStrictEqual(loaded(t), [a, x, b]);
      finish(t, b, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, x, b, c]);
      finish(t, c, answered);
      await settle();
      assert.strictEqual(t.checks.loadStateOf(t.asDoc(c)), 'ok');
      // Check File on the active document while the slot is taken: at once too.
      t.saved.fire(a);
      await settle();
      void t.checks.check(t.asDoc(x));
      await settle();
      assert.deepStrictEqual(loaded(t).slice(4), [a, x]);
    });

    test('a waiting document that becomes the active one is checked at once, without a slot', async () => {
      const [a, b, c] = ['/w/a/A.idr', '/w/b/B.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      await settle();
      assert.deepStrictEqual(loaded(t), [a]);
      t.activate(c);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'promoted past b');
      finish(t, c, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'c took no slot: b still waits for a');
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c, b]);
    });

    test('a waiting check whose document closes is dropped without loading; the next one gets the slot', async () => {
      const [a, b, c] = ['/w/a/A.idr', '/w/b/B.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      await settle();
      const waiting = t.checks.check(t.asDoc(b)); // (b's check again, replacing the one waiting)
      await settle();
      t.show(a, c);
      b.isClosed = true;
      t.closed.fire(b);
      assert.strictEqual(await waiting, undefined, 'the dropped check settles');
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c]);
      finish(t, c, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'b is never loaded');
    });

    test('a newer check of a waiting document takes its place in line; the document is loaded once', async () => {
      const [a, b, c] = ['/w/a/A.idr', '/w/b/B.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      await settle();
      t.saved.fire(c);
      t.saved.fire(b);
      await settle();
      assert.deepStrictEqual(loaded(t), [a]);
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b], 'b first, as it asked first');
      finish(t, b, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c]);
      finish(t, c, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c]);
    });

    test('settings: a higher limit starts waiting checks at once, 0 starts all; a lower one stops nothing that runs', async () => {
      const [a, b, c, d] = ['/w/a/A.idr', '/w/b/B.idr', '/w/c/C.idr', '/w/d/D.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      await settle();
      assert.deepStrictEqual(loaded(t), [a]);
      t.setMaxBackgroundChecks(2);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b]);
      t.setMaxBackgroundChecks(0);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c]);
      // Lower again: a and b still hold their slots, c (started without a limit) none.
      t.setMaxBackgroundChecks(1);
      t.show(a, b, c, d);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c], 'd waits: two hold slots, above the new limit');
      finish(t, c, answered);
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c], 'one still holds a slot');
      finish(t, b, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c, d]);
    });

    test('the active document is the last active Idris file while another editor is active; its root goes to the backend', async () => {
      const a = new FakeDocument('/w/a/A.idr');
      const b = new FakeDocument('/w/b/B.idr');
      const notes = new FakeDocument('/w/a/Notes.md', 'markdown');
      const t = setup({ visible: [a, b], active: a, maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b], 'a is active: b takes the one slot');
      assert.deepStrictEqual(t.state.activeRoots, ['pending', '/w/a'], 'pending while it is classified, then the root');
      t.activate(notes); // e.g. a Markdown file, or the output panel
      await settle();
      assert.deepStrictEqual(t.state.activeRoots, ['pending', '/w/a'], 'still a');
      t.saved.fire(a);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, a], 'still checked at once while b holds the slot');
      t.activate(b);
      await settle();
      assert.deepStrictEqual(t.state.activeRoots, ['pending', '/w/a', '/w/b']);
      t.saved.fire(a);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, a], 'a is a background document now: it waits');
      finish(t, b, answered);
      await settle();
      // The two checks of a that started while it was active count now that b is: the limit is
      // still used up (verification after Q20–Q22: they did not count, and a third one started).
      assert.deepStrictEqual(loaded(t), [a, b, a], 'a\'s earlier checks still run');
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, a]);
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, a, a]);
      b.isClosed = true;
      t.closed.fire(b);
      t.activate(undefined);
      await settle();
      assert.deepStrictEqual(t.state.activeRoots, ['pending', '/w/a', '/w/b', 'none'], 'the active document closed: none');
    });

    // --- verification after Q20–Q22 ---------------------------------------------------------------

    test('Stop Backend (cancelWaiting) drops the waiting checks of its root, or of all: none takes a freed slot', async () => {
      const [a, b1, b2, c] = ['/w/a/A.idr', '/w/b/B1.idr', '/w/b/B2.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ maxBackgroundChecks: 1 });
      // Folders judged already (nothing is asked first), so that the checks reach the slots in order.
      ['/w/a', '/w/b', '/w/c', '/w/d'].forEach((dir) => t.state.verdicts.set(dir, { allowed: true, basis: 'workspaceFolder' }));
      t.show(a, b1, b2, c);
      const answered = new Set<number>();
      await settle();
      assert.deepStrictEqual(loaded(t), [a]);
      t.checks.cancelWaiting({ kind: 'loose', dir: '/w/b' }); // Stop Backend, this project (b's)
      finish(t, a, answered); // the stop of a's own session would free the slot likewise
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'b1 and b2 are not loaded');
      assert.deepStrictEqual([t.status(b1), t.status(b2)], [{ kind: 'notChecked' }, { kind: 'notChecked' }], 'the previous state stays');
      assert.ok(t.logged.some((m) => m.includes('Not checked: /w/b/B1.idr: Stop Backend')));
      // All projects, also a check still waiting for the answer about its folder.
      const [x, d] = ['/o/X.idr', '/w/d/D.idr'].map((f) => new FakeDocument(f));
      t.holdQuestion('/o');
      t.show(a, c, x, d);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c]);
      t.checks.cancelWaiting();
      t.answer('/o', { allowed: true, basis: 'window' });
      finish(t, c, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'neither x (asked) nor d (waiting) loads');
    });

    test('a background check whose folder is not decided asks first, holding no slot; others run meanwhile', async () => {
      const [a, x, c] = ['/w/a/A.idr', '/o/X.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, x, c], active: a, maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      t.holdQuestion('/o');
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'x waits for the answer, c has the slot');
      assert.deepStrictEqual(t.status(x), { kind: 'checking', waitingFor: '/o' });
      assert.deepStrictEqual(t.state.permits, ['/o', '/w/c'], 'asked before the slot; the active a is not asked here');
      t.answer('/o', { allowed: true, basis: 'window' });
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'allowed: x waits for the slot now');
      finish(t, c, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c, x]);
    });

    test('a refused folder takes no slot (the load is refused at once); a running check whose folder\'s question is open does not count', async () => {
      const [a, x, c, d] = ['/w/a/A.idr', '/o/X.idr', '/w/c/C.idr', '/w/d/D.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, c], active: a, maxBackgroundChecks: 1 });
      const answered = new Set<number>();
      t.state.verdicts.set('/o', { allowed: false, reason: 'denied' });
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c], 'c holds the slot');
      t.show(a, c, x); // x: Don't Allow was chosen for its folder
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c, x], 'x does not wait for c: the backend refuses it at once');
      t.backend.loads[2].reject(unsupported('Idris 2 is not started in /o: "Don\'t Allow" was chosen.'));
      finish(t, c, answered);
      await settle();
      // a's own check started while a was active; its folder's question opens (the session asks),
      // and another document becomes active: a's check does not count while the user is asked.
      t.state.verdicts.delete('/w/a');
      t.state.asking.add('/w/a');
      t.consentChanged.fire();
      const b = new FakeDocument('/w/b/B.idr');
      t.activate(b);
      t.show(a, b, d);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, c, x, b, d], 'd is not held back by a');
    });

    test('a limit set while checks run without one counts them: nothing new starts until they are within it', async () => {
      const [a, b, c, d] = ['/w/a/A.idr', '/w/b/B.idr', '/w/c/C.idr', '/w/d/D.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c] });
      const answered = new Set<number>();
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c]);
      t.setMaxBackgroundChecks(1);
      t.show(a, b, c, d);
      await settle();
      finish(t, a, answered);
      finish(t, b, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c], 'c still runs: d waits');
      finish(t, c, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a, b, c, d]);
    });

    test('a revoked folder: its waiting check is refused, not asked about again; it is checked once the folder is allowed', async () => {
      const [a, x, y] = ['/w/a/A.idr', '/o/x/X.idr', '/o/y/Y.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, x, y], active: a, maxBackgroundChecks: 1 });
      t.state.verdicts.set('/o/x', { allowed: true, basis: 'always' });
      t.state.verdicts.set('/o/y', { allowed: true, basis: 'always' });
      await settle();
      assert.deepStrictEqual(loaded(t), [x, a], 'y waits for x\'s slot (the active a is queued last)');
      // Manage Allowed Folders…: both revoked (unknown again; the next start would ask).
      t.state.verdicts.delete('/o/x');
      t.state.verdicts.delete('/o/y');
      t.holdQuestion('/o/x');
      t.holdQuestion('/o/y');
      t.consentChanged.fire();
      t.backend.loads[0].reject(unsupported('running Idris 2 in "/o/x" is no longer allowed')); // the pool stopped x's session
      await settle();
      assert.deepStrictEqual(loaded(t), [x, a], 'y is not loaded');
      assert.deepStrictEqual(t.state.permits, [], 'nobody is asked');
      assert.deepStrictEqual(t.status(y), { kind: 'notChecked' });
      t.answer('/o/y', { allowed: true, basis: 'window' }); // Allow… in the status item
      await settle();
      assert.deepStrictEqual(loaded(t), [x, a, y], 'refused, visible and allowed now: checked');
    });

    test('the active document\'s load is urgent while a limit is set: before its root\'s loads that wait; not with 0', async () => {
      const [a, b] = ['/w/a/A.idr', '/w/a/B.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [b], active: b, maxBackgroundChecks: 1 });
      await settle();
      t.backend.loads[0].resolve(clean(b));
      await settle();
      t.activate(a); // opened: visible and active
      t.show(b, a);
      await settle();
      t.saved.fire(b); // a background check of b
      await settle();
      const urgent = () => t.backend.loads.slice(1).map((l) => l.options?.urgent?.() === true);
      assert.deepStrictEqual(loaded(t).slice(1), [a, b]);
      assert.deepStrictEqual(urgent(), [true, false]);
      t.activate(b);
      assert.deepStrictEqual(urgent(), [false, true], 'asked when the backend chooses: b is the active one now');
      t.activate(new FakeDocument('/w/a/Notes.md', 'markdown'));
      assert.deepStrictEqual(urgent(), [false, true], 'still b while no Idris editor is active');
      t.setMaxBackgroundChecks(0);
      assert.deepStrictEqual(urgent(), [false, false], 'without a limit the queue is first-in, first-out');
    });

    test('several visible documents checked at once while a limit is set: the active one\'s load is not urgent, so that it stays last where the gate knows the folder; at activation and trust grant it does not (fifth and sixth reviews of M3)', async () => {
      // Both loads wait for a process that is starting (activation, a restart): urgent, the active
      // document's load was sent first, the other file was the one loaded, and the active one was
      // loaded again for its first hover.
      const [a, b] = ['/w/a/A.idr', '/w/a/B.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b], active: a, maxBackgroundChecks: 1 });
      await settle();
      const urgent = () => t.backend.loads.map((l) => `${l.doc.fileName} ${l.options?.urgent?.() === true}`);
      // Documented exception, not fixed (sixth review of M3; CLAUDE.md, the M2 rules): at activation the gate has
      // no verdict for the folder yet, so the other document's check asks about it first
      // (`askFirst`) and hands its load over after the active one's. No load of the batch in A's
      // root was handed over before A's, so A's is urgent (ninth review of M3).
      assert.deepStrictEqual(urgent(), ['/w/a/A.idr true', '/w/a/B.idr false'], 'at activation');
      t.activate(b);
      assert.deepStrictEqual(urgent(), ['/w/a/A.idr false', '/w/a/B.idr true'], 'a document of the batch that becomes the active one is urgent');
      t.activate(a);
      t.backend.loads.forEach((l) => l.resolve(clean(l.doc)));
      await settle();
      const rechecked = t.checks.recheckVisible();
      await settle();
      assert.deepStrictEqual(urgent().slice(2), ['/w/a/B.idr false', '/w/a/A.idr false'], 'Restart Backend (recheckVisible)');
      t.backend.loads.slice(2).forEach((l) => l.resolve(clean(l.doc)));
      await settle();
      await rechecked;
      // Trust granted: likewise before the gate knows the folder; once it does, the active one last.
      const u = setup({ visible: [a, b], active: a, trusted: false, maxBackgroundChecks: 1 });
      await settle();
      u.trust.isTrusted = true;
      u.trustGranted.fire();
      await settle();
      assert.deepStrictEqual(loaded(u), [a, b], 'trust granted, no verdict for the folder yet');
      const k = setup({ visible: [a, b], active: a, trusted: false, maxBackgroundChecks: 1 });
      k.state.verdicts.set('/w/a', { allowed: true, basis: 'workspaceFolder' });
      await settle();
      k.trust.isTrusted = true;
      k.trustGranted.fire();
      await settle();
      assert.deepStrictEqual(loaded(k), [b, a], 'trust granted, the folder known');
    });

    test('a batch whose other loads in the active document\'s root were not handed over before its own: the active one\'s load is urgent (ninth review of M3)', async () => {
      // An import fixed checks again the active document alone in its root: every batch made its load
      // not urgent, so it waited behind the background loads already in its root's session (the
      // verifier's probe).
      const [usesBad, bad, c, d] = ['/w/a/UsesBad.idr', '/w/a/Bad.idr', '/w/a/C.idr', '/w/a/D.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [bad, usesBad], active: usesBad, maxBackgroundChecks: 3 });
      t.state.verdicts.set('/w/a', { allowed: true, basis: 'workspaceFolder' });
      await settle();
      const notChecked = { message: 'Not checked: the compiler reported errors in Bad.idr.', severity: ERROR };
      const badError = { message: 'While processing right hand side of f.', severity: ERROR };
      for (const l of t.backend.loads) {
        l.resolve(
          l.doc === usesBad
            ? result([[usesBad.uri, [notChecked]], [bad.uri, [badError]]], { blockedBy: [bad.uri] } as unknown as Partial<LoadResult>)
            : result([[bad.uri, [badError]]]),
        );
        await settle();
      }
      // C and D saved: their background loads wait in the session. Bad.idr fixed and saved.
      t.saved.fire(c);
      t.saved.fire(d);
      t.saved.fire(bad);
      await settle();
      assert.deepStrictEqual(loaded(t).slice(2), [c, d, bad]);
      t.backend.loads[4].resolve(clean(bad));
      await settle();
      assert.deepStrictEqual(loaded(t).slice(2), [c, d, bad, usesBad], 'UsesBad.idr checked again');
      assert.strictEqual(t.backend.loads[5].options?.urgent?.(), true, 'before C and D, as after a save of it');
      t.backend.loads.slice(2).forEach((l) => l.resolve(clean(l.doc)));
      await settle();
      // A batch whose other document is of another root (Restart Backend with a limit of 1): the
      // active one's load is urgent in its own root; with another document of its root handed over
      // first, it is not.
      const [a, b, a2] = ['/w/a/A.idr', '/w/b/B.idr', '/w/a/A2.idr'].map((f) => new FakeDocument(f));
      for (const [others, expected] of [
        [[b], ['/w/b/B.idr false', '/w/a/A.idr true']],
        [[a2], ['/w/a/A2.idr false', '/w/a/A.idr false']],
      ] as const) {
        const u = setup({ visible: [a, ...others], active: a, maxBackgroundChecks: 1 });
        ['/w/a', '/w/b'].forEach((dir) => u.state.verdicts.set(dir, { allowed: true, basis: 'workspaceFolder' }));
        await settle();
        u.backend.loads.forEach((l) => l.resolve(clean(l.doc)));
        await settle();
        const before = u.backend.loads.length;
        const rechecked = u.checks.recheckVisible();
        await settle();
        assert.deepStrictEqual(
          u.backend.loads.slice(before).map((l) => `${l.doc.fileName} ${l.options?.urgent?.() === true}`),
          expected,
          others[0].fileName,
        );
        u.backend.loads.slice(before).forEach((l) => l.resolve(clean(l.doc)));
        await rechecked;
      }
      // The other load of its root settled before the active one's was handed over (its file took
      // longer to classify): urgent again.
      const k = setup({ visible: [a, a2], active: a, maxBackgroundChecks: 1 });
      k.state.verdicts.set('/w/a', { allowed: true, basis: 'workspaceFolder' });
      await settle();
      k.backend.loads.forEach((l) => l.resolve(clean(l.doc)));
      await settle();
      const before = k.backend.loads.length;
      let classified: () => void = () => undefined;
      k.state.slowClassify.set('/w/a/A.idr', new Promise((resolve) => (classified = () => resolve({ kind: 'loose', dir: '/w/a' }))));
      const rechecked = k.checks.recheckVisible();
      await settle();
      assert.deepStrictEqual(loaded(k).slice(before), [a2]);
      k.backend.loads[before].resolve(clean(a2));
      await settle();
      classified();
      await settle();
      assert.deepStrictEqual(
        k.backend.loads.slice(before).map((l) => `${l.doc.fileName} ${l.options?.urgent?.() === true}`),
        ['/w/a/A2.idr false', '/w/a/A.idr true'],
      );
      k.backend.loads.slice(before).forEach((l) => l.resolve(clean(l.doc)));
      await rechecked;
    });

    test('a batch counts its unsettled loads per root, and whether the active one\'s load is urgent is decided at its handover (tenth review of M3)', async () => {
      // B, C and the active A in one root; A takes longer to classify, and B's load settles before A's
      // is handed over while C's has not: A's load is not urgent (the verifier's mutant C5, which made
      // the count a flag, made it urgent, so it went before C's and C was the file loaded last).
      const [a, b, c] = ['/w/a/A.idr', '/w/a/B.idr', '/w/a/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], active: a, maxBackgroundChecks: 3 });
      t.state.verdicts.set('/w/a', { allowed: true, basis: 'workspaceFolder' });
      await settle();
      t.backend.loads.forEach((l) => l.resolve(clean(l.doc)));
      await settle();
      const before = t.backend.loads.length;
      let classified: () => void = () => undefined;
      t.state.slowClassify.set('/w/a/A.idr', new Promise((resolve) => (classified = () => resolve({ kind: 'loose', dir: '/w/a' }))));
      const rechecked = t.checks.recheckVisible();
      await settle();
      assert.deepStrictEqual(loaded(t).slice(before), [b, c]);
      t.backend.loads[before].resolve(clean(b));
      await settle();
      classified();
      await settle();
      const urgent = () => t.backend.loads.slice(before).map((l) => `${l.doc.fileName} ${l.options?.urgent?.() === true}`);
      assert.deepStrictEqual(urgent(), ['/w/a/B.idr false', '/w/a/C.idr false', '/w/a/A.idr false'], 'C\'s load has not settled');
      // Decided once: after C's load settles A's stays not urgent, so it keeps its place in the queue
      // behind whatever the root's session held at its handover (`CheckOptions.batch`).
      t.backend.loads[before + 1].resolve(clean(c));
      await settle();
      assert.deepStrictEqual(urgent().slice(2), ['/w/a/A.idr false'], 'after C\'s load settled');
      t.backend.loads[before + 2].resolve(clean(a));
      await rechecked;
    });

    test('a batch with more other visible documents than the limit: those beyond it wait for a slot and are loaded after the active one, also with the folder known (not fixed, documented; seventh review of M3)', async () => {
      // The active document's check never waits for a slot, so it is not queued last whenever others
      // wait for one: Restart Backend with a limit of 1 loads B, A, C (the verifier's probe).
      // Documented beside the gate case (CLAUDE.md, the M2 rules; `checks.ts` *The active document*):
      // making the active check wait for their slots would delay its diagnostics by their compile times.
      const [a, b, c] = ['/w/a/A.idr', '/w/a/B.idr', '/w/a/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], active: a, maxBackgroundChecks: 1 });
      t.state.verdicts.set('/w/a', { allowed: true, basis: 'workspaceFolder' });
      /** Answers the loads in the order they were handed over, as the root's one session would. */
      const drain = async (from: number): Promise<void> => {
        for (let i = from; i < t.backend.loads.length; i++) {
          t.backend.loads[i].resolve(clean(t.backend.loads[i].doc));
          await settle();
        }
      };
      await settle();
      await drain(0);
      const before = t.backend.loads.length;
      const rechecked = t.checks.recheckVisible();
      await settle();
      await drain(before);
      await rechecked;
      assert.deepStrictEqual(loaded(t).slice(before), [b, a, c]);
      // With a limit that leaves no other check waiting, the active one is last.
      const u = setup({ visible: [a, b, c], active: a, maxBackgroundChecks: 2 });
      u.state.verdicts.set('/w/a', { allowed: true, basis: 'workspaceFolder' });
      await settle();
      u.backend.loads.forEach((l) => l.resolve(clean(l.doc)));
      await settle();
      const again = u.backend.loads.length;
      const all = u.checks.recheckVisible();
      await settle();
      assert.deepStrictEqual(loaded(u).slice(again), [b, c, a]);
      u.backend.loads.slice(again).forEach((l) => l.resolve(clean(l.doc)));
      await all;
    });

    test('a batch with no more other visible documents than the limit, while a background check outside it holds a slot: one of them waits and is loaded after the active one (not fixed, documented; eighth review of M3)', async () => {
      // The documented condition is "another document of the batch waits for a slot": more other
      // documents than free slots, the limit less the checks already running (the verifier's probe).
      const [a, b, c, x] = ['/w/a/A.idr', '/w/a/B.idr', '/w/a/C.idr', '/w/a/X.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, b, c], active: a, maxBackgroundChecks: 2 });
      t.state.verdicts.set('/w/a', { allowed: true, basis: 'workspaceFolder' });
      await settle();
      t.backend.loads.forEach((l) => l.resolve(clean(l.doc)));
      await settle();
      // X is open but not visible; its save starts a background check, which holds a slot while it runs.
      t.saved.fire(x);
      await settle();
      const held = t.backend.loads.length;
      assert.deepStrictEqual(loaded(t).slice(held - 1), [x]);
      const rechecked = t.checks.recheckVisible();
      await settle();
      assert.deepStrictEqual(loaded(t).slice(held), [b, a], 'C waits for the slot X holds; the active A does not');
      // X ends: C gets its slot.
      t.backend.loads[held - 1].resolve(clean(x));
      await settle();
      assert.deepStrictEqual(loaded(t).slice(held), [b, a, c]);
      t.backend.loads.slice(held).forEach((l) => l.resolve(clean(l.doc)));
      await rechecked;
    });

    test('closing the active document while another editor is active counts its running check: no more background checks than the limit', async () => {
      // M2 verification of the Q20–Q22 fixes (the verifier's probe XA).
      const [a, a2, b, c] = ['/w/a/A.idr', '/w/a/A2.idr', '/w/b/B.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const notes = new FakeDocument('/w/a/Notes.md', 'markdown');
      const t = setup({ visible: [a, a2], active: a, maxBackgroundChecks: 1 });
      ['/w/a', '/w/b', '/w/c'].forEach((dir) => t.state.verdicts.set(dir, { allowed: true, basis: 'workspaceFolder' }));
      const answered = new Set<number>();
      await settle();
      assert.deepStrictEqual(loaded(t), [a2, a], 'the active a is queued last');
      finish(t, a2, answered); // a (active) still runs
      await settle();
      t.activate(notes);
      t.state.visible = [{ document: a2 }, { document: notes }];
      a.isClosed = true;
      t.closed.fire(a); // VS Code disposes A.idr later
      t.show(a2, notes, b, c);
      await settle();
      assert.deepStrictEqual(loaded(t), [a2, a], 'a\'s running check counts now: b and c wait');
      finish(t, a, answered);
      await settle();
      assert.deepStrictEqual(loaded(t), [a2, a, b]);
    });

    test('manual trigger: an active document no check tracks is classified for its root (pending meanwhile), so maxSessions keeps its project', async () => {
      // M2 verification of the Q20–Q22 fixes (the verifier's probe XB): the backend was told none.
      const [x, y] = ['/w/a/X.idr', '/w/a/Y.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [x], active: x, trigger: 'manual' });
      await settle();
      assert.deepStrictEqual(t.state.activeRoots, ['pending', '/w/a'], 'x, never checked, classified by itself');
      void t.checks.check(t.asDoc(x)); // Check File
      await settle();
      t.backend.loads[0].resolve(result([[x.uri, []]]));
      await settle();
      let classified: (root: Classification) => void = () => undefined;
      t.state.slowClassify.set(y.fileName, new Promise((resolve) => (classified = resolve)));
      t.show(x, y);
      t.activate(y);
      await settle();
      assert.strictEqual(t.state.activeRoots.at(-1), 'pending', 'while y is classified nothing is stopped for the limit');
      classified({ kind: 'loose', dir: '/w/a' });
      await settle();
      assert.strictEqual(t.state.activeRoots.at(-1), '/w/a');
      assert.strictEqual(t.backend.loads.length, 1, 'classifying loads nothing');
      // Another document no check tracks becomes the active one: classified in its turn.
      t.activate(new FakeDocument('/w/b/Z.idr'));
      await settle();
      assert.deepStrictEqual(t.state.activeRoots.slice(-2), ['pending', '/w/b']);
    });

    test('a background check whose load would be refused anyway is not asked about: it goes at once, holding no slot', async () => {
      // M2 verification of the Q20–Q22 fixes (the verifier's probe L4): the question came before the
      // checks the backend and the pool make first (no compiler, extraArgs, the package walk).
      const [a, x, c] = ['/w/a/A.idr', '/o/X.idr', '/w/c/C.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a, c], active: a, maxBackgroundChecks: 1 });
      t.state.verdicts.set('/w/c', { allowed: true, basis: 'workspaceFolder' });
      await settle();
      assert.deepStrictEqual(loaded(t), [c, a], 'c holds the slot (the active a is queued last)');
      t.holdQuestion('/o');
      t.state.refusals.set('/o', 'No Idris 2 compiler to start: not found');
      t.show(a, c, x);
      await settle();
      assert.deepStrictEqual(t.state.preflights, ['/o'], 'the backend is asked first');
      assert.deepStrictEqual(t.state.permits, [], 'no question');
      assert.deepStrictEqual(loaded(t), [c, a, x], 'x does not wait for c\'s slot: its load is refused at once');
      // Nothing would refuse it: asked, as before.
      t.state.refusals.delete('/o');
      t.backend.loads[2].reject(new IdrisException({ kind: 'ToolchainMissing', message: 'No Idris 2 compiler to start: not found' }));
      await settle();
      t.saved.fire(x);
      await settle();
      assert.deepStrictEqual(t.state.permits, ['/o']);
      assert.deepStrictEqual(t.status(x), { kind: 'checking', waitingFor: '/o' });
    });

    test('while the active document\'s check classifies it, its root is pending (not none)', async () => {
      const [a1, a2] = ['/w/a/A1.idr', '/w/a/A2.idr'].map((f) => new FakeDocument(f));
      const t = setup({ visible: [a1], active: a1 });
      await settle();
      assert.strictEqual(t.state.activeRoots.at(-1), '/w/a');
      let classified: (root: Classification) => void = () => undefined;
      t.state.slowClassify.set(a2.fileName, new Promise((resolve) => (classified = resolve)));
      t.show(a1, a2); // VS Code's order: the visible editors, then the active one
      t.activate(a2);
      await settle();
      assert.strictEqual(t.state.activeRoots.at(-1), 'pending', 'no root yet: pending, so that /w/a is not stopped for maxSessions');
      classified({ kind: 'loose', dir: '/w/a' });
      await settle();
      assert.strictEqual(t.state.activeRoots.at(-1), '/w/a');
    });
  });
});
