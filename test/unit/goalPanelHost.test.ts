// features/goalPanel/host.ts, html.ts: the panel against fakes of the vscode namespace parts it uses,
// timers fired by hand and a model answering by hand: opening, closing and restoring it, what it
// follows, when a state is sent, the page's Content-Security-Policy, and every message of the webview,
// which it checks and turns into commands on its own targets only.
import * as assert from 'assert';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { EditChoice, Hole } from '../../src/backend/types';
import type { SettingsChange } from '../../src/core/config';
import { Emitter } from '../../src/core/event';
import { panelHtml } from '../../src/features/goalPanel/html';
import { GOAL_PANEL_VIEW_TYPE, GoalPanelHost, isFromWebview, type GoalPanelApi } from '../../src/features/goalPanel/host';
import type { GoalPanelDeps } from '../../src/features/goalPanel/types';
import type { EditingCommandArgs, EditingCommandId, EditingRunOptions } from '../../src/features/editing/types';
import type { HoleRef } from '../../src/features/holes/tree';
import type { Classification } from '../../src/project/types';
import type { PanelState, ToWebview } from '../../src/webview/protocol';
import { FakeTextDoc } from './support/editingFakes';
import { recordingLog } from './support/fakeTransport';

const FILE = '/w/Clean.idr';
const TEXT = 'module Clean\n\nimport Data.Vect\n\nappend : Vect n a -> Vect m a -> Vect (n + m) a\n\nvlen : Vect n a -> Nat\nvlen xs = ?vlen_rhs\n';
const ROOT: Classification = { kind: 'loose', dir: '/w' };
const at = (line: number, character: number) => ({ line, character });

const VLEN: Hole = {
  name: 'vlen_rhs',
  qualifiedName: 'Clean.vlen_rhs',
  type: { text: 'Nat', spans: [] },
  premises: [{ name: 'xs', type: { text: 'Vect n a', spans: [] } }],
  location: { uri: { fsPath: FILE }, range: { start: at(7, 10), end: at(7, 19) } } as unknown as Hole['location'],
};

class FakeTimers {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  private next = 0;
  set(callback: () => void, ms: number): unknown {
    this.pending.set(++this.next, { callback, ms });
    return this.next;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fire(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    all.forEach((t) => t.callback());
  }
}

class FakeWebview {
  html = '';
  cspSource = 'vscode-webview:';
  options: unknown;
  readonly posted: ToWebview[] = [];
  readonly messages = new Emitter<unknown>();
  readonly onDidReceiveMessage = this.messages.event;
  asWebviewUri(uri: unknown): unknown {
    return { toString: () => `webview:${String(uri)}` };
  }
  postMessage(message: ToWebview): Promise<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }
}

class FakePanel {
  readonly webview = new FakeWebview();
  visible = true;
  disposed = false;
  iconPath: unknown;
  revealed = 0;
  readonly viewState = new Emitter<void>();
  readonly onDidChangeViewState = this.viewState.event;
  private readonly disposal = new Emitter<void>();
  readonly onDidDispose = this.disposal.event;
  constructor(readonly created?: { viewType: string; title: string; show: unknown; options: unknown }) {}
  reveal(): void {
    this.revealed++;
    this.visible = true;
  }
  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.disposal.fire();
    }
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function setup(options: { trusted?: boolean; backendKind?: 'ideMode' | 'lsp'; follow?: boolean; holes?: readonly Hole[]; noEditor?: boolean; classify?: () => Promise<Classification> } = {}) {
  const doc = new FakeTextDoc({ fileName: FILE, text: TEXT });
  const editor = { document: doc, selection: { active: at(7, 13) }, viewColumn: 1 };
  const activeChanged = new Emitter<unknown>();
  const selectionChanged = new Emitter<{ textEditor: unknown }>();
  const documentChanged = new Emitter<{ document: unknown }>();
  const saved = new Emitter<unknown>();
  const closed = new Emitter<unknown>();
  const diagnosticsChanged = new Emitter<{ uris: readonly unknown[] }>();
  const modelChanged = new Emitter<void>();
  const statusChanged = new Emitter<void>();
  const cycleChanged = new Emitter<void>();
  const settingsChanged = new Map<string, Emitter<SettingsChange>>();
  const panels: FakePanel[] = [];
  const written: [string, unknown, unknown][] = [];
  const shownDocuments: unknown[][] = [];
  const clipboard: string[] = [];
  const notices: string[] = [];
  const window = { activeTextEditor: options.noEditor === true ? undefined : editor } as { activeTextEditor: typeof editor | undefined };
  const workspaceValues = new Map<string, unknown>();
  const api = {
    ViewColumn: { Beside: -2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Range: class {
      constructor(
        readonly sl: number,
        readonly sc: number,
        readonly el: number,
        readonly ec: number,
      ) {}
    },
    Uri: { joinPath: (base: unknown, ...parts: string[]) => [String(base), ...parts].join('/') },
    window: {
      get activeTextEditor() {
        return window.activeTextEditor;
      },
      get visibleTextEditors() {
        return options.noEditor === true ? [] : [editor];
      },
      createWebviewPanel: (viewType: string, title: string, show: unknown, panelOptions: unknown) => {
        const panel = new FakePanel({ viewType, title, show, options: panelOptions });
        panels.push(panel);
        return panel;
      },
      showTextDocument: (...args: unknown[]) => {
        shownDocuments.push(args);
        return Promise.resolve(editor);
      },
      showInformationMessage: (text: string) => {
        notices.push(text);
        return Promise.resolve(undefined);
      },
      showErrorMessage: (text: string) => {
        notices.push(text);
        return Promise.resolve(undefined);
      },
      setStatusBarMessage: (text: string) => {
        notices.push(text);
        return { dispose: () => undefined };
      },
      onDidChangeActiveTextEditor: activeChanged.event,
      onDidChangeTextEditorSelection: selectionChanged.event,
    },
    workspace: {
      get textDocuments() {
        return [doc];
      },
      asRelativePath: (file: string) => path.basename(file),
      getConfiguration: () => ({
        inspect: (key: string) => ({ workspaceValue: workspaceValues.get(key) }),
        update: (key: string, value: unknown, target: unknown) => {
          written.push([key, value, target]);
          return Promise.resolve();
        },
      }),
      onDidChangeTextDocument: documentChanged.event,
      onDidSaveTextDocument: saved.event,
      onDidCloseTextDocument: closed.event,
    },
    languages: {
      getDiagnostics: () => [
        { source: 'other', severity: 0, message: 'another extension', range: { start: at(0, 0), end: at(0, 1) } },
        { source: 'idris2', severity: 1, message: 'unused', range: { start: at(2, 0), end: at(2, 4) } },
      ],
      onDidChangeDiagnostics: diagnosticsChanged.event,
    },
    env: {
      clipboard: {
        writeText: (text: string) => {
          clipboard.push(text);
          return Promise.resolve();
        },
      },
    },
  } as unknown as GoalPanelApi;
  const runs: { command: EditingCommandId; args: EditingCommandArgs | undefined; options: EditingRunOptions | undefined }[] = [];
  const reveals: { ref: HoleRef; viewColumn: unknown }[] = [];
  const relists: string[] = [];
  const timers = new FakeTimers();
  let holes = options.holes ?? [VLEN];
  let cycle = false;
  let stale = false;
  const settings = {
    follow: options.follow ?? true,
    display: { showImplicits: false, showMachineNames: false, fullNamespace: false },
    lsp: { showImplicits: false, showMachineNames: false, fullNamespace: false },
  };
  const group = (name: string): Emitter<SettingsChange> => {
    let emitter = settingsChanged.get(name);
    if (emitter === undefined) {
      emitter = new Emitter<SettingsChange>();
      settingsChanged.set(name, emitter);
    }
    return emitter;
  };
  const deps: GoalPanelDeps = {
    extensionUri: 'ext' as unknown as vscode.Uri,
    model: {
      files: () => (holes.length > 0 ? [FILE] : []),
      holesIn: (file: string) => (file === FILE ? holes : []),
      modules: () => [],
      holesOfModule: () => [],
      lastLoadFailed: () => false,
      rangesText: () => doc.getText(),
      onDidChange: modelChanged.event,
      relist: (_root: Classification, file: string) => {
        relists.push(file);
        return Promise.resolve();
      },
    },
    holes: {
      reveal: (ref, viewColumn) => {
        reveals.push({ ref, viewColumn });
        return Promise.resolve();
      },
    },
    editing: {
      run: (command, args, runOptions) => {
        runs.push({ command, args, options: runOptions });
        return Promise.resolve();
      },
      cycleOf: () => (cycle ? ({} as never) : undefined),
      onDidChangeCycle: cycleChanged.event,
    },
    checks: { statusOf: () => (stale ? { kind: 'checked', errors: 0, warnings: 0, stale: true, known: true } : { kind: 'notChecked' }), onDidChange: statusChanged.event },
    projects: { classify: options.classify ?? (() => Promise.resolve(ROOT)) },
    registry: {
      backendFor: () =>
        ({ kind: options.backendKind ?? 'ideMode', caps: { editing: true, editingNext: true, intro: true, refine: true } }) as never,
    },
    config: {
      goalPanel: () => ({ followCursor: settings.follow, debounceMs: 50 }),
      ideMode: () => ({ display: settings.display }) as never,
      lsp: () => settings.lsp as never,
      onDidChange: (name: string, listener: (change: SettingsChange) => void) => group(name).event(listener),
    } as unknown as GoalPanelDeps['config'],
    trust: { isTrusted: options.trusted ?? true, onDidGrant: new Emitter<void>().event },
    log: recordingLog(),
    timers,
  };
  const host = new GoalPanelHost(api, deps);
  return {
    host,
    doc,
    editor,
    window,
    panels,
    written,
    workspaceValues,
    shownDocuments,
    clipboard,
    notices,
    runs,
    reveals,
    relists,
    timers,
    settings,
    log: deps.log as ReturnType<typeof recordingLog>,
    setHoles: (next: readonly Hole[]) => {
      holes = next;
      modelChanged.fire();
    },
    setCycle: (on: boolean) => {
      cycle = on;
      cycleChanged.fire();
    },
    setStale: (on: boolean) => {
      stale = on;
      statusChanged.fire();
    },
    moveCursor: (line: number, character: number) => {
      editor.selection = { active: at(line, character) };
      selectionChanged.fire({ textEditor: editor });
    },
    edit: () => documentChanged.fire({ document: doc }),
    save: () => saved.fire(doc),
    close: () => closed.fire(doc),
    diagnostics: (uri: unknown) => diagnosticsChanged.fire({ uris: [uri] }),
    activate: (next: unknown) => {
      window.activeTextEditor = next as typeof editor | undefined;
      activeChanged.fire(next);
    },
    settingChanged: (name: string, keys: readonly string[]) => group(name).fire({ affects: (key) => keys.includes(key) }),
    /** The panel opened, its script ready, and the state sent. */
    open: async () => {
      host.toggle();
      const panel = panels[panels.length - 1];
      await host.receive({ type: 'ready' });
      timers.fire();
      await settle();
      return panel;
    },
    update: async () => {
      timers.fire();
      await settle();
    },
  };
}

const lastState = (panel: FakePanel): PanelState => {
  const { posted } = panel.webview;
  return posted[posted.length - 1].state;
};

suite('features/goalPanel: the page', () => {
  test('the Content-Security-Policy allows the extension\'s stylesheet and this page\'s script, and nothing inline, no network', () => {
    const html = panelHtml({ cspSource: 'vscode-webview:', nonce: 'N0nce==', script: 'webview:s.js', style: 'webview:s.css' });
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
    assert.strictEqual(csp, "default-src 'none'; style-src vscode-webview:; script-src 'nonce-N0nce==';");
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
    assert.match(html, /<script nonce="N0nce==" src="webview:s\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="webview:s\.css">/);
    assert.doesNotMatch(html, /<style|onclick|<script>/);
  });
});

suite('features/goalPanel: the webview\'s messages are checked', () => {
  test('those of the protocol pass; anything else does not', () => {
    for (const good of [
      { type: 'ready' },
      { type: 'copy' },
      { type: 'save' },
      { type: 'rendered', version: 1, text: 'x' },
      { type: 'action', action: 'proofSearch' },
      { type: 'action', action: 'generateDefinition' },
      { type: 'refine', expression: 'S' },
      { type: 'premise', action: 'caseSplit', name: 'xs' },
      { type: 'premise', action: 'jump', name: 'xs' },
      { type: 'hole', version: 1, index: 0 },
      { type: 'message', version: 1, index: 0 },
      { type: 'choose' },
      { type: 'choose', index: 2 },
      { type: 'toggle', option: 'pin' },
      { type: 'toggle', option: 'fullNamespace' },
    ]) {
      assert.ok(isFromWebview(good), JSON.stringify(good));
    }
    for (const bad of [
      undefined,
      null,
      'ready',
      {},
      { type: 'run', command: 'workbench.action.quit' },
      { type: 'action', action: 'makeCase' },
      { type: 'action', action: '__proto__' },
      { type: 'refine' },
      { type: 'refine', expression: 1 },
      { type: 'premise', action: 'delete', name: 'x' },
      { type: 'premise', action: 'jump' },
      { type: 'hole', version: 1, index: -1 },
      { type: 'hole', version: 1, index: 1.5 },
      { type: 'message', index: 0 },
      { type: 'choose', index: 'x' },
      { type: 'toggle', option: 'editor.fontSize' },
      { type: 'rendered', version: 1 },
    ]) {
      assert.ok(!isFromWebview(bad), JSON.stringify(bad));
    }
  });

  test('a message that is not one of the protocol does nothing, and is logged', async () => {
    const t = setup();
    await t.open();
    await t.host.receive({ type: 'run', command: 'workbench.action.quit' });
    assert.deepStrictEqual(t.runs, []);
    assert.ok(t.log.lines.some((line) => /ignored a message/.test(line)));
  });
});

suite('features/goalPanel: the panel (host.ts)', () => {
  test('the toggle opens it beside the editor without the focus, with scripts on and only its own folders readable', () => {
    const t = setup();
    t.host.toggle();
    const [panel] = t.panels;
    assert.strictEqual(t.host.isOpen, true);
    assert.strictEqual(panel.created?.viewType, GOAL_PANEL_VIEW_TYPE);
    assert.deepStrictEqual(panel.created?.show, { viewColumn: -2, preserveFocus: true });
    assert.deepStrictEqual(panel.created?.options, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: ['ext/dist', 'ext/media'] });
    assert.match(panel.webview.html, /webview:ext\/dist\/goalPanel\.js/);
    assert.match(panel.webview.html, /webview:ext\/media\/goalPanel\.css/);
    assert.strictEqual(panel.iconPath, 'ext/media/icon.png');
  });

  test('the toggle closes a visible panel, and shows a hidden one without the focus', async () => {
    const t = setup();
    const panel = await t.open();
    panel.visible = false;
    t.host.toggle();
    assert.strictEqual(panel.revealed, 1);
    assert.strictEqual(t.host.isOpen, true);
    t.host.toggle();
    assert.strictEqual(panel.disposed, true);
    assert.strictEqual(t.host.isOpen, false);
    assert.strictEqual(t.host.state(), undefined);
  });

  test('in Restricted Mode no panel opens, one being restored closes, and it says why', () => {
    const t = setup({ trusted: false });
    t.host.toggle();
    assert.deepStrictEqual(t.panels, []);
    assert.match(t.notices[0], /Restricted Mode/);
    const restored = new FakePanel();
    t.host.restore(restored as unknown as vscode.WebviewPanel);
    assert.strictEqual(restored.disposed, true);
  });

  test('a panel restored after a reload gets its page and options; a second one closes', async () => {
    const t = setup();
    const restored = new FakePanel();
    t.host.restore(restored as unknown as vscode.WebviewPanel);
    assert.deepStrictEqual(restored.webview.options, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: ['ext/dist', 'ext/media'] });
    assert.match(restored.webview.html, /Content-Security-Policy/);
    assert.ok(t.log.lines.includes('info: Goal panel: restored.'));
    await t.host.receive({ type: 'ready' });
    await t.update();
    assert.strictEqual(lastState(restored).goal?.label, '?vlen_rhs');
    const second = new FakePanel();
    t.host.restore(second as unknown as vscode.WebviewPanel);
    assert.strictEqual(second.disposed, true);
  });

  test('nothing is sent before the script is ready, nor while hidden; showing it sends what changed', async () => {
    const t = setup();
    t.host.toggle();
    const [panel] = t.panels;
    await t.update();
    assert.deepStrictEqual(panel.webview.posted, []);
    await t.host.receive({ type: 'ready' });
    await t.update();
    assert.strictEqual(panel.webview.posted.length, 1);
    panel.visible = false;
    t.setHoles([]);
    await t.update();
    assert.strictEqual(panel.webview.posted.length, 1);
    panel.visible = true;
    panel.viewState.fire();
    await t.update();
    assert.strictEqual(panel.webview.posted.length, 2);
    assert.strictEqual(lastState(panel).goal, undefined);
  });

  test('a move of the cursor waits for the debounce; a state like the last one is not sent; versions grow', async () => {
    const t = setup();
    const panel = await t.open();
    assert.strictEqual(lastState(panel).goal?.label, '?vlen_rhs');
    const { version } = lastState(panel);
    t.moveCursor(7, 14);
    assert.deepStrictEqual([...t.timers.pending.values()].map((p) => p.ms), [50]);
    t.moveCursor(7, 15);
    assert.strictEqual(t.timers.pending.size, 1, 'the delay starts again');
    await t.update();
    assert.strictEqual(panel.webview.posted.length, 1, 'the same hole: nothing to draw');
    t.moveCursor(0, 0);
    await t.update();
    assert.strictEqual(lastState(panel).goal, undefined);
    assert.ok(lastState(panel).version > version);
  });

  test('what it follows: the model, the status, a cycle, the diagnostics, edits and saves of its document, each sends a state', async () => {
    const t = setup();
    const panel = await t.open();
    t.setCycle(true);
    await t.update();
    assert.strictEqual(lastState(panel).cycle, true);
    t.setStale(true);
    await t.update();
    assert.strictEqual(lastState(panel).stale, true);
    assert.deepStrictEqual(lastState(panel).messages, [{ severity: 'warning', line: 3, text: 'unused' }], 'the compiler\'s only');
    t.setHoles([]);
    await t.update();
    assert.deepStrictEqual(lastState(panel).holes, []);
    t.edit();
    assert.deepStrictEqual([...t.timers.pending.values()].map((p) => p.ms), [50]);
    t.save();
    t.diagnostics(t.doc.uri);
    assert.deepStrictEqual([...t.timers.pending.values()].map((p) => p.ms), [0]);
    await t.update();
  });

  test('with the focus in the panel there is no active editor: it stays on its document and goes on following the cursor there', async () => {
    const t = setup();
    const panel = await t.open();
    t.activate(undefined);
    t.moveCursor(7, 12);
    await t.update();
    assert.strictEqual(lastState(panel).file, 'Clean.idr');
    assert.strictEqual(lastState(panel).goal?.label, '?vlen_rhs');
  });

  test('another Idris editor takes over, a non-Idris one does not; closing the document leaves the panel empty', async () => {
    const t = setup();
    const panel = await t.open();
    const other = new FakeTextDoc({ fileName: '/w/Other.idr', text: 'module Other\n' });
    t.activate({ document: other, selection: { active: at(0, 0) }, viewColumn: 1 });
    await t.update();
    assert.strictEqual(lastState(panel).file, 'Other.idr');
    const plain = new FakeTextDoc({ fileName: '/w/notes.txt', text: 'x', languageId: 'plaintext' });
    t.activate({ document: plain, selection: { active: at(0, 0) }, viewColumn: 1 });
    await t.update();
    assert.strictEqual(lastState(panel).file, 'Other.idr');
  });

  test('following off: it stays on its place while the cursor moves and editors change', async () => {
    const t = setup({ follow: false });
    const panel = await t.open();
    t.moveCursor(0, 0);
    await t.update();
    assert.strictEqual(lastState(panel).goal?.label, '?vlen_rhs');
    t.activate({ document: new FakeTextDoc({ fileName: '/w/Other.idr', text: 'module Other\n' }), selection: { active: at(0, 0) }, viewColumn: 1 });
    await t.update();
    assert.strictEqual(lastState(panel).file, 'Clean.idr');
  });

  test('following turned on again: the panel goes where the cursor is now', async () => {
    const t = setup({ follow: false });
    const panel = await t.open();
    t.moveCursor(0, 0);
    await t.update();
    assert.strictEqual(lastState(panel).goal?.label, '?vlen_rhs');
    t.settings.follow = true;
    t.settingChanged('goalPanel', ['goalPanel.followCursor']);
    await t.update();
    assert.strictEqual(lastState(panel).goal, undefined);
    assert.strictEqual(lastState(panel).follow, true);
  });

  test('each button runs its command on the panel\'s target, with the document, not the active editor', async () => {
    const t = setup();
    await t.open();
    t.activate(undefined);
    const hole = { uri: t.doc.uri.toString(), position: at(7, 10), name: 'vlen_rhs' };
    for (const action of ['proofSearch', 'intro', 'makeLemma'] as const) {
      await t.host.receive({ type: 'action', action });
    }
    await t.host.receive({ type: 'refine', expression: 'S' });
    assert.deepStrictEqual(t.runs.map((r) => [r.command, r.args]), [
      ['idris2.proofSearch', hole],
      ['idris2.intro', hole],
      ['idris2.makeLemma', hole],
      ['idris2.refineHole', { ...hole, hint: 'S' }],
    ]);
    await t.host.receive({ type: 'action', action: 'nextResult' });
    assert.strictEqual(t.runs[4].command, 'idris2.nextResult');
    assert.strictEqual(t.runs[4].args, undefined);
    assert.strictEqual(t.runs[4].options?.doc, t.doc as unknown);
  });

  test('Generate Definition runs on the declaration at the cursor; a button with no target does nothing', async () => {
    const t = setup();
    await t.open();
    t.moveCursor(4, 2);
    await t.update();
    await t.host.receive({ type: 'action', action: 'proofSearch' });
    assert.strictEqual(t.runs.length, 0);
    await t.host.receive({ type: 'action', action: 'generateDefinition' });
    assert.deepStrictEqual(t.runs.map((r) => [r.command, r.args]), [['idris2.generateDefinition', { uri: t.doc.uri.toString(), position: at(4, 0), name: 'append' }]]);
  });

  test('a premise\'s Case Split goes to its binder; Jump shows it in the editor\'s group; an unknown premise does nothing', async () => {
    const t = setup();
    await t.open();
    await t.host.receive({ type: 'premise', action: 'caseSplit', name: 'xs' });
    assert.deepStrictEqual(t.runs.map((r) => [r.command, r.args]), [['idris2.caseSplit', { uri: t.doc.uri.toString(), position: at(7, 5), name: 'xs' }]]);
    await t.host.receive({ type: 'premise', action: 'jump', name: 'xs' });
    assert.strictEqual(t.shownDocuments.length, 1);
    const [shown, options] = t.shownDocuments[0] as [unknown, { selection: { sl: number; sc: number; el: number; ec: number }; viewColumn: number }];
    assert.strictEqual(shown, t.doc as unknown);
    assert.deepStrictEqual([options.selection.sl, options.selection.sc, options.selection.el, options.selection.ec, options.viewColumn], [7, 5, 7, 7, 1]);
    await t.host.receive({ type: 'premise', action: 'caseSplit', name: 'nope' });
    await t.host.receive({ type: 'premise', action: 'jump', name: 'nope' });
    assert.strictEqual(t.runs.length, 1);
    assert.strictEqual(t.shownDocuments.length, 1);
  });

  test('a row reveals its hole in the editor\'s group; a message shows its place; one of an older state does nothing', async () => {
    const t = setup();
    const panel = await t.open();
    const { version } = lastState(panel);
    await t.host.receive({ type: 'hole', version: version - 1, index: 0 });
    await t.host.receive({ type: 'hole', version, index: 9 });
    await t.host.receive({ type: 'message', version: version - 1, index: 0 });
    assert.deepStrictEqual([t.reveals.length, t.shownDocuments.length], [0, 0]);
    await t.host.receive({ type: 'hole', version, index: 0 });
    assert.strictEqual(t.reveals[0].ref.name, 'vlen_rhs');
    assert.strictEqual(t.reveals[0].viewColumn, 1);
    await t.host.receive({ type: 'message', version, index: 0 });
    assert.strictEqual(t.shownDocuments.length, 1);
  });

  test('Intro\'s choices are asked in the panel, and the answer ends the command\'s question', async () => {
    const t = setup();
    const panel = await t.open();
    await t.host.receive({ type: 'action', action: 'intro' });
    const choose = t.runs[0].options?.choose;
    assert.ok(choose !== undefined);
    const zero: EditChoice = { label: '0', replacements: [] };
    const succ: EditChoice = { label: 'S ?f_rhs_0', replacements: [] };
    const picked = choose('intro', [zero, succ]);
    await t.update();
    assert.deepStrictEqual(lastState(panel).choices, { prompt: 'What to put into the hole:', labels: ['0', 'S ?f_rhs_0'] });
    await t.host.receive({ type: 'choose', index: 1 });
    assert.strictEqual(await picked, succ);
    await t.update();
    assert.strictEqual(lastState(panel).choices, undefined);
    const cancelled = choose('ambiguous', [zero]);
    await t.update();
    assert.match(lastState(panel).choices?.prompt ?? '', /ambiguous/);
    await t.host.receive({ type: 'choose' });
    assert.strictEqual(await cancelled, undefined);
    const left = choose('intro', [zero]);
    panel.dispose();
    assert.strictEqual(await left, undefined, 'closing the panel answers none');
  });

  test('Copy writes the goal as Markdown; without a goal nothing', async () => {
    const t = setup();
    await t.open();
    await t.host.receive({ type: 'copy' });
    assert.match(t.clipboard[0], /\*\*\?vlen_rhs\*\*/);
    assert.match(t.clipboard[0], /xs : Vect n a/);
    t.moveCursor(0, 0);
    await t.update();
    await t.host.receive({ type: 'copy' });
    assert.strictEqual(t.clipboard.length, 1);
  });

  test('Pin keeps the hole shown while the cursor moves, until Unpin; a hole that goes ends it', async () => {
    const t = setup();
    const panel = await t.open();
    await t.host.receive({ type: 'toggle', option: 'pin' });
    t.moveCursor(0, 0);
    await t.update();
    assert.strictEqual(lastState(panel).goal?.label, '?vlen_rhs');
    assert.strictEqual(lastState(panel).pinned, true);
    await t.host.receive({ type: 'toggle', option: 'pin' });
    await t.update();
    assert.strictEqual(lastState(panel).goal, undefined);
    assert.strictEqual(lastState(panel).pinned, false);
    t.moveCursor(7, 13);
    await t.update();
    await t.host.receive({ type: 'toggle', option: 'pin' });
    await t.update();
    t.setHoles([]);
    await t.update();
    assert.strictEqual(lastState(panel).pinned, false);
    t.setHoles([VLEN]);
    t.moveCursor(0, 0);
    await t.update();
    assert.strictEqual(lastState(panel).goal, undefined, 'the pin is gone for good');
  });

  test('a printing option writes the setting of the backend serving the file, where its value comes from', async () => {
    const t = setup();
    const panel = await t.open();
    await t.host.receive({ type: 'toggle', option: 'showImplicits' });
    assert.deepStrictEqual(t.written, [['ideMode.showImplicits', true, 1]]);
    t.settings.display = { ...t.settings.display, showImplicits: true };
    t.settingChanged('ideMode', ['ideMode.showImplicits']);
    await t.update();
    assert.strictEqual(lastState(panel).options.showImplicits, true);
    t.workspaceValues.set('ideMode.fullNamespace', false);
    await t.host.receive({ type: 'toggle', option: 'fullNamespace' });
    assert.deepStrictEqual(t.written[1], ['ideMode.fullNamespace', true, 2], 'the workspace\'s, which has a value');
    const lsp = setup({ backendKind: 'lsp' });
    await lsp.open();
    await lsp.host.receive({ type: 'toggle', option: 'showMachineNames' });
    assert.deepStrictEqual(lsp.written, [['lsp.showMachineNames', true, 1]]);
  });

  test('follow writes its setting; over idris2-lsp a changed option has the file\'s holes asked for again', async () => {
    const t = setup();
    await t.open();
    await t.host.receive({ type: 'toggle', option: 'follow' });
    assert.deepStrictEqual(t.written, [['goalPanel.followCursor', false, 1]]);
    t.settingChanged('lsp', ['lsp.showImplicits']);
    await settle();
    assert.deepStrictEqual(t.relists, [], 'IDE mode checks the file again instead');
    const lsp = setup({ backendKind: 'lsp' });
    await lsp.open();
    lsp.settingChanged('lsp', ['lsp.logFile']);
    await settle();
    assert.deepStrictEqual(lsp.relists, []);
    lsp.settingChanged('lsp', ['lsp.showImplicits']);
    await settle();
    assert.deepStrictEqual(lsp.relists, [FILE]);
  });

  test('Save saves the file the banner is about, the one followed, not that of a pinned hole', async () => {
    const t = setup();
    await t.open();
    await t.host.receive({ type: 'save' });
    assert.strictEqual(t.doc.saves, 1);
    await t.host.receive({ type: 'toggle', option: 'pin' });
    await t.update();
    const other = new FakeTextDoc({ fileName: '/w/Other.idr', text: 'module Other\n' });
    t.activate({ document: other, selection: { active: at(0, 0) }, viewColumn: 1 });
    await t.update();
    await t.host.receive({ type: 'save' });
    assert.deepStrictEqual([t.doc.saves, other.saves], [1, 1]);
  });

  test('without an Idris editor: an empty panel, whose buttons do nothing', async () => {
    const t = setup({ noEditor: true, holes: [] });
    const panel = await t.open();
    assert.strictEqual(lastState(panel).file, undefined);
    await t.host.receive({ type: 'action', action: 'proofSearch' });
    await t.host.receive({ type: 'save' });
    assert.deepStrictEqual(t.runs, []);
  });

  test('a failing action is logged and shown as plain text; the panel goes on', async () => {
    const t = setup();
    await t.open();
    t.clipboard.push = () => {
      throw new Error('no clipboard [x](command:evil)');
    };
    await t.host.receive({ type: 'copy' });
    assert.ok(t.log.lines.some((line) => /copy failed/.test(line)));
    assert.ok(t.notices.some((text) => /the goal panel failed/.test(text) && !/\[x\]\(command:/.test(text)), t.notices.join('|'));
  });

  test('a state that cannot be built is logged, and the next one goes on', async () => {
    let fails = true;
    const t = setup({ classify: () => (fails ? Promise.reject(new Error('no project')) : Promise.resolve(ROOT)) });
    const panel = await t.open();
    assert.ok(t.log.lines.some((line) => /the update failed: no project/.test(line)), t.log.lines.join('\n'));
    assert.deepStrictEqual(panel.webview.posted, []);
    fails = false;
    t.setHoles([VLEN]);
    await t.update();
    assert.strictEqual(lastState(panel).goal?.label, '?vlen_rhs');
  });

  test('after the panel closed, its last state\'s targets act on nothing, and a new panel starts clean', async () => {
    const t = setup();
    const panel = await t.open();
    await t.host.receive({ type: 'rendered', version: 1, text: 'shown' });
    panel.dispose();
    assert.strictEqual(t.host.rendered(), undefined);
    await t.host.receive({ type: 'action', action: 'proofSearch' });
    await t.host.receive({ type: 'save' });
    assert.deepStrictEqual([t.runs.length, t.doc.saves], [0, 0]);
    assert.strictEqual(t.timers.pending.size, 0, 'nothing left to run');
    const again = await t.open();
    assert.strictEqual(lastState(again).goal?.label, '?vlen_rhs');
  });

  test('rendered is kept for the tests; dispose closes the panel', async () => {
    const t = setup();
    const panel = await t.open();
    await t.host.receive({ type: 'rendered', version: 3, text: 'shown' });
    assert.deepStrictEqual(t.host.rendered(), { type: 'rendered', version: 3, text: 'shown' });
    assert.ok(t.log.lines.includes('debug: Goal panel: drew state 3.'));
    t.host.dispose();
    assert.strictEqual(panel.disposed, true);
    assert.strictEqual(t.host.isOpen, false);
  });
});
