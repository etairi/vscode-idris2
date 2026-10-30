/**
 * The goal panel's host (`types.ts`): the `WebviewPanel`, what it follows, and the webview's messages.
 * What it shows is `state.ts`. Only type imports from `vscode`: `register.ts` passes the namespace as
 * `api`, and the unit tests a fake.
 *
 * Nothing is computed while the panel is hidden or closed: it subscribes while a panel exists, and
 * sends a state only while it is visible and its script runs (`ready`); a state that shows the same
 * as the last one is not sent, so that a move of the cursor within a hole draws nothing.
 */
import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import type { EditChoice } from '../../backend/types';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { plainText } from '../../core/notificationText';
import type { EditorRange } from '../../core/positions';
import { editorLabel } from '../../core/untrustedText';
import { isIdrisDocument } from '../../project/literate';
import type { FromWebview, GoalAction, MessageSeverity, PanelState, PanelToggle, ToWebview } from '../../webview/protocol';
import type { EditingCommandId } from '../editing/types';
import { panelHtml } from './html';
import { buildPanel, goalMarkdown, type PanelDiagnostic, type PanelDocument, type PanelInput, type PanelTargets, type PinnedHole } from './state';
import type { GoalPanelDeps, GoalPanelView } from './types';

/** The webview's type, also what VS Code restores a panel by (package.json `activationEvents`). */
export const GOAL_PANEL_VIEW_TYPE = 'idris2.goalPanel';

const SCRIPT = ['dist', 'goalPanel.js'] as const;
const STYLE = ['media', 'goalPanel.css'] as const;

/** The longest text of a choice, in UTF-16 code units. */
const MAX_CHOICE = 500;

/** The parts of the `vscode` namespace the panel uses. */
export type GoalPanelApi = Pick<typeof vscode, 'ViewColumn' | 'ConfigurationTarget' | 'DiagnosticSeverity' | 'Range' | 'Uri'> & {
  readonly window: Pick<
    typeof vscode.window,
    | 'activeTextEditor'
    | 'visibleTextEditors'
    | 'createWebviewPanel'
    | 'showTextDocument'
    | 'showInformationMessage'
    | 'showErrorMessage'
    | 'setStatusBarMessage'
    | 'onDidChangeActiveTextEditor'
    | 'onDidChangeTextEditorSelection'
  >;
  readonly workspace: Pick<
    typeof vscode.workspace,
    'textDocuments' | 'asRelativePath' | 'getConfiguration' | 'onDidChangeTextDocument' | 'onDidSaveTextDocument' | 'onDidCloseTextDocument'
  >;
  readonly languages: Pick<typeof vscode.languages, 'getDiagnostics' | 'onDidChangeDiagnostics'>;
  readonly env: { readonly clipboard: Pick<vscode.Clipboard, 'writeText'> };
};

const ACTIONS: ReadonlySet<string> = new Set<GoalAction>(['proofSearch', 'nextResult', 'intro', 'makeLemma', 'generateDefinition']);
const TOGGLES: ReadonlySet<string> = new Set<PanelToggle>(['showImplicits', 'showMachineNames', 'fullNamespace', 'pin', 'follow']);

const isIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** Whether `value` is a message the webview may send (module comment of `types.ts`). */
export function isFromWebview(value: unknown): value is FromWebview {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
    case 'copy':
    case 'save':
      return true;
    case 'rendered':
      return isIndex(message.version) && typeof message.text === 'string';
    case 'action':
      return typeof message.action === 'string' && ACTIONS.has(message.action);
    case 'refine':
      return typeof message.expression === 'string';
    case 'premise':
      return (message.action === 'caseSplit' || message.action === 'jump') && typeof message.name === 'string';
    case 'hole':
    case 'message':
      return isIndex(message.version) && isIndex(message.index);
    case 'choose':
      return message.index === undefined || isIndex(message.index);
    case 'toggle':
      return typeof message.option === 'string' && TOGGLES.has(message.option);
    default:
      return false;
  }
}

const ACTION_COMMANDS: Readonly<Record<Exclude<GoalAction, 'generateDefinition'>, EditingCommandId>> = {
  proofSearch: 'idris2.proofSearch',
  nextResult: 'idris2.nextResult',
  intro: 'idris2.intro',
  makeLemma: 'idris2.makeLemma',
};

/** The settings of a printing option, by backend (`core/config.ts` `DisplayOptions`). */
const OPTION_KEYS: Readonly<Record<'showImplicits' | 'showMachineNames' | 'fullNamespace', { readonly ideMode: string; readonly lsp: string }>> = {
  showImplicits: { ideMode: 'ideMode.showImplicits', lsp: 'lsp.showImplicits' },
  showMachineNames: { ideMode: 'ideMode.showMachineNames', lsp: 'lsp.showMachineNames' },
  fullNamespace: { ideMode: 'ideMode.fullNamespace', lsp: 'lsp.fullNamespace' },
};

const FOLLOW_KEY = 'goalPanel.followCursor';

const NO_TARGETS: PanelTargets = { binders: new Map(), rows: [], messages: [], pinLost: false };

/** The place the panel follows. */
interface Place {
  readonly editor: vscode.TextEditor;
  readonly doc: vscode.TextDocument;
  cursor: vscode.Position;
}

export class GoalPanelHost implements GoalPanelView, IDisposable {
  private panel: vscode.WebviewPanel | undefined;
  /** What lives as long as the panel. */
  private subscriptions: DisposableStore | undefined;
  private place: Place | undefined;
  private pinned: PinnedHole | undefined;
  /** The script runs (`ready`): a state sent now is not lost. */
  private ready = false;
  private timer: unknown;
  /** Grows with every `update`: an older one that was waiting gives up. */
  private updates = 0;
  private version = 0;
  private shown: PanelState | undefined;
  private lastSent: string | undefined;
  private targets = NO_TARGETS;
  private lastRendered: Extract<FromWebview, { type: 'rendered' }> | undefined;
  private choosing: { readonly prompt: string; readonly choices: readonly EditChoice[]; readonly resolve: (choice: EditChoice | undefined) => void } | undefined;

  constructor(
    private readonly api: GoalPanelApi,
    private readonly deps: GoalPanelDeps,
  ) {}

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  state(): PanelState | undefined {
    return this.shown;
  }

  rendered(): Extract<FromWebview, { type: 'rendered' }> | undefined {
    return this.lastRendered;
  }

  /** `idris2.toggleGoalPanel` (`types.ts`). */
  toggle(): void {
    if (!this.deps.trust.isTrusted) {
      void this.api.window.showInformationMessage(plainText('Idris 2: nothing is run in Restricted Mode. Trust the workspace to use the goal panel.'));
    } else if (this.panel === undefined) {
      const { Beside } = this.api.ViewColumn;
      this.attach(this.api.window.createWebviewPanel(GOAL_PANEL_VIEW_TYPE, 'Idris 2 Goal', { viewColumn: Beside, preserveFocus: true }, this.webviewOptions()));
    } else if (this.panel.visible) {
      this.panel.dispose();
    } else {
      this.panel.reveal(undefined, true);
    }
  }

  /** A panel VS Code restored after a reload (`deserializeWebviewPanel`). */
  restore(panel: vscode.WebviewPanel): void {
    if (!this.deps.trust.isTrusted || this.panel !== undefined) {
      panel.dispose();
      return;
    }
    panel.webview.options = this.webviewOptions();
    this.attach(panel);
    this.deps.log.info('Goal panel: restored.');
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    const { joinPath } = this.api.Uri;
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [joinPath(this.deps.extensionUri, SCRIPT[0]), joinPath(this.deps.extensionUri, STYLE[0])],
    };
  }

  private attach(panel: vscode.WebviewPanel): void {
    const { joinPath } = this.api.Uri;
    this.panel = panel;
    this.ready = false;
    panel.iconPath = joinPath(this.deps.extensionUri, 'media', 'icon.png');
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      script: panel.webview.asWebviewUri(joinPath(this.deps.extensionUri, ...SCRIPT)).toString(),
      style: panel.webview.asWebviewUri(joinPath(this.deps.extensionUri, ...STYLE)).toString(),
    });
    this.place = this.startingPlace();
    const store = new DisposableStore();
    this.subscriptions = store;
    store.add(panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(message)));
    store.add(panel.onDidChangeViewState(() => this.schedule(0)));
    store.add(panel.onDidDispose(() => this.closed()));
    this.subscribe(store);
  }

  /** The active editor's Idris document, else a visible one. */
  private startingPlace(): Place | undefined {
    const { window } = this.api;
    const editor = [window.activeTextEditor, ...window.visibleTextEditors].find((e) => e !== undefined && isIdrisDocument(e.document));
    return editor === undefined ? undefined : this.placeOf(editor);
  }

  private placeOf(editor: vscode.TextEditor): Place {
    return { editor, doc: editor.document, cursor: editor.selection.active };
  }

  private subscribe(store: DisposableStore): void {
    const { window, workspace, languages } = this.api;
    const { deps } = this;
    const follows = (doc: vscode.TextDocument): boolean => doc === this.place?.doc;
    store.add(
      window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined && isIdrisDocument(editor.document) && deps.config.goalPanel().followCursor) {
          this.place = this.placeOf(editor);
          this.schedule(0);
        }
      }),
    );
    store.add(
      window.onDidChangeTextEditorSelection((e) => {
        if (this.place !== undefined && follows(e.textEditor.document) && deps.config.goalPanel().followCursor) {
          this.place.cursor = e.textEditor.selection.active;
          this.schedule(deps.config.goalPanel().debounceMs);
        }
      }),
    );
    store.add(workspace.onDidChangeTextDocument((e) => follows(e.document) && this.schedule(deps.config.goalPanel().debounceMs)));
    store.add(workspace.onDidSaveTextDocument((doc) => follows(doc) && this.schedule(0)));
    store.add(
      workspace.onDidCloseTextDocument((doc) => {
        if (follows(doc)) {
          this.place = this.startingPlace();
          this.schedule(0);
        }
      }),
    );
    store.add(languages.onDidChangeDiagnostics((e) => this.place !== undefined && e.uris.some((uri) => uri.toString() === this.place?.doc.uri.toString()) && this.schedule(0)));
    store.add(deps.model.onDidChange(() => this.schedule(0)));
    store.add(deps.checks.onDidChange(() => this.schedule(0)));
    store.add(deps.editing.onDidChangeCycle(() => this.schedule(0)));
    store.add(
      deps.config.onDidChange('goalPanel', () => {
        if (deps.config.goalPanel().followCursor) {
          this.followAgain();
        }
        this.schedule(0);
      }),
    );
    store.add(deps.config.onDidChange('ideMode', () => this.schedule(0)));
    store.add(
      deps.config.onDidChange('lsp', (change) => {
        this.schedule(0);
        if (Object.values(OPTION_KEYS).some((keys) => change.affects(keys.lsp))) {
          this.relistLspHoles().catch((error: unknown) => this.failed('listing the holes', error));
        }
      }),
    );
  }

  /** Following is on again: the panel goes where the cursor is now. */
  private followAgain(): void {
    const { activeTextEditor } = this.api.window;
    const editor = activeTextEditor !== undefined && isIdrisDocument(activeTextEditor.document) ? activeTextEditor : this.place?.editor;
    if (editor !== undefined) {
      this.place = this.placeOf(editor);
    }
  }

  /** idris2-lsp prints the holes when asked: the ones of the file followed are asked for again (`HoleModel.relist`). */
  private async relistLspHoles(): Promise<void> {
    const doc = this.place?.doc;
    if (doc !== undefined) {
      const root = await this.deps.projects.classify(doc.fileName);
      if (this.deps.registry.backendFor(root).kind === 'lsp') {
        await this.deps.model.relist(root, doc.fileName);
      }
    }
  }

  private failed(what: string, error: unknown): void {
    this.deps.log.error(`Goal panel: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  private closed(): void {
    this.subscriptions?.dispose();
    this.subscriptions = undefined;
    this.panel = undefined;
    this.place = undefined;
    this.pinned = undefined;
    this.shown = undefined;
    this.lastSent = undefined;
    this.lastRendered = undefined;
    this.targets = NO_TARGETS;
    this.ready = false;
    this.setChoosing(undefined);
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.deps.timers.clear(this.timer);
      this.timer = undefined;
    }
  }

  /** Updates the panel in `ms`, instead of any update that waits. */
  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = this.deps.timers.set(() => {
      this.timer = undefined;
      this.update().catch((error: unknown) => this.failed('the update', error));
    }, ms);
  }

  private async input(): Promise<Omit<PanelInput, 'model' | 'relativePath' | 'documentOf' | 'hasCycle' | 'pinned' | 'choices'>> {
    const { deps, place } = this;
    const follow = deps.config.goalPanel().followCursor;
    if (place === undefined) {
      const options = deps.config.ideMode().display;
      return { stale: false, diagnostics: [], options, follow, caps: { editing: false, editingNext: false, intro: false, refine: false } };
    }
    const root = await deps.projects.classify(place.doc.fileName);
    const backend = deps.registry.backendFor(root);
    const status = deps.checks.statusOf(place.doc, root);
    const { showImplicits, showMachineNames, fullNamespace } = backend.kind === 'lsp' ? deps.config.lsp() : deps.config.ideMode().display;
    const { editing, editingNext, intro, refine } = backend.caps;
    return {
      place: { doc: place.doc as PanelDocument, cursor: place.cursor },
      stale: (status?.kind === 'checked' || status?.kind === 'packageError') && status.stale,
      diagnostics: this.diagnosticsOf(place.doc),
      options: { showImplicits, showMachineNames, fullNamespace },
      follow,
      caps: { editing, editingNext, intro, refine },
    };
  }

  /** The compiler's and the server's diagnostics of `doc`, not other extensions'. */
  private diagnosticsOf(doc: vscode.TextDocument): PanelDiagnostic[] {
    const { Error, Warning } = this.api.DiagnosticSeverity;
    const severity = (s: vscode.DiagnosticSeverity): MessageSeverity => (s === Error ? 'error' : s === Warning ? 'warning' : 'information');
    return this.api.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.source?.startsWith('idris2') === true)
      .map((d) => ({ severity: severity(d.severity), message: d.message, range: d.range }));
  }

  private async update(): Promise<void> {
    const { panel } = this;
    const update = ++this.updates;
    if (panel === undefined || !panel.visible || !this.ready) {
      return;
    }
    const input = await this.input();
    if (update !== this.updates || panel !== this.panel) {
      return;
    }
    const { workspace } = this.api;
    const choosing = this.choosing;
    const { state, targets } = buildPanel({
      ...input,
      model: this.deps.model,
      relativePath: (file) => workspace.asRelativePath(file),
      documentOf: (file) => workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.fileName === file) as PanelDocument | undefined,
      hasCycle: (doc) => this.deps.editing.cycleOf(doc.uri.toString()) !== undefined,
      ...(this.pinned === undefined ? {} : { pinned: this.pinned }),
      ...(choosing === undefined ? {} : { choices: { prompt: choosing.prompt, labels: choosing.choices.map((c) => editorLabel(c.label, MAX_CHOICE)) } }),
    });
    this.targets = targets;
    if (targets.pinLost) {
      this.pinned = undefined;
    }
    const sent = JSON.stringify(state);
    if (sent === this.lastSent) {
      return;
    }
    this.lastSent = sent;
    this.shown = { ...state, version: ++this.version };
    const message: ToWebview = { type: 'state', state: this.shown };
    void panel.webview.postMessage(message);
  }

  /** Shows `choosing` (or none) in the panel, and ends the question that was open. */
  private setChoosing(choosing: GoalPanelHost['choosing']): void {
    this.choosing?.resolve(undefined);
    this.choosing = choosing;
    this.schedule(0);
  }

  private readonly choose = (reason: 'intro' | 'ambiguous', choices: readonly EditChoice[]): Promise<EditChoice | undefined> =>
    new Promise((resolve) => {
      const prompt = reason === 'intro' ? 'What to put into the hole:' : 'The name is ambiguous; which one to refine the hole with:';
      this.setChoosing({ prompt, choices, resolve });
    });

  private answerChoice(index: number | undefined): void {
    const choosing = this.choosing;
    this.choosing = undefined;
    this.schedule(0);
    choosing?.resolve(index === undefined ? undefined : choosing.choices[index]);
  }

  async receive(message: unknown): Promise<void> {
    if (!isFromWebview(message)) {
      this.deps.log.warn('Goal panel: ignored a message that is not one of the panel\'s.');
      return;
    }
    try {
      await this.handle(message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.deps.log.error(`Goal panel: ${message.type} failed: ${text}`);
      void this.api.window.showErrorMessage(plainText(editorLabel(`Idris 2: the goal panel failed: ${text}`)));
    }
  }

  private async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.lastSent = undefined;
        this.schedule(0);
        return;
      case 'rendered':
        this.lastRendered = message;
        this.deps.log.debug(`Goal panel: drew state ${message.version}.`);
        return;
      case 'action':
        await this.act(message.action);
        return;
      case 'refine':
        await this.onHole('idris2.refineHole', message.expression);
        return;
      case 'premise':
        await this.onPremise(message.action, message.name);
        return;
      case 'hole':
        await this.revealRow(message.version, message.index);
        return;
      case 'message':
        await this.showMessage(message.version, message.index);
        return;
      case 'choose':
        this.answerChoice(message.index);
        return;
      case 'toggle':
        await this.toggleOption(message.option);
        return;
      case 'copy':
        await this.copy();
        return;
      case 'save':
        await this.place?.doc.save();
        return;
    }
  }

  private async act(action: GoalAction): Promise<void> {
    if (action === 'generateDefinition') {
      const { doc, declaration } = this.targets;
      if (doc !== undefined && declaration !== undefined) {
        await this.deps.editing.run('idris2.generateDefinition', { uri: doc.uri.toString(), ...declaration });
      }
    } else if (action === 'nextResult') {
      const { doc } = this.targets;
      if (doc !== undefined) {
        await this.deps.editing.run(ACTION_COMMANDS[action], undefined, { doc: doc as vscode.TextDocument });
      }
    } else {
      await this.onHole(ACTION_COMMANDS[action]);
    }
  }

  /** Runs `command` on the hole shown; `hint`: Refine's expression. */
  private async onHole(command: EditingCommandId, hint?: string): Promise<void> {
    const { doc, hole } = this.targets;
    if (doc !== undefined && hole !== undefined) {
      await this.deps.editing.run(command, { uri: doc.uri.toString(), ...hole, ...(hint === undefined ? {} : { hint }) }, { choose: this.choose });
    }
  }

  /** The editor to show something in: not the active group, which may be the panel's. */
  private get viewColumn(): vscode.ViewColumn | undefined {
    return this.place?.editor.viewColumn;
  }

  private async onPremise(action: 'caseSplit' | 'jump', name: string): Promise<void> {
    const { doc, binders } = this.targets;
    const binder = binders.get(name);
    if (doc === undefined || binder === undefined) {
      return;
    }
    if (action === 'caseSplit') {
      await this.deps.editing.run('idris2.caseSplit', { uri: doc.uri.toString(), position: binder.position, name: binder.name });
    } else {
      await this.showRange(doc as vscode.TextDocument, binder.range);
    }
  }

  private async showRange(doc: vscode.TextDocument, range: EditorRange): Promise<void> {
    const { viewColumn } = this;
    await this.api.window.showTextDocument(doc, {
      selection: new this.api.Range(range.start.line, range.start.character, range.end.line, range.end.character),
      ...(viewColumn === undefined ? {} : { viewColumn }),
    });
  }

  private async revealRow(version: number, index: number): Promise<void> {
    const ref = this.targets.rows[index];
    if (version === this.shown?.version && ref !== undefined) {
      await this.deps.holes.reveal(ref, this.viewColumn);
    }
  }

  private async showMessage(version: number, index: number): Promise<void> {
    const range = this.targets.messages[index];
    if (version === this.shown?.version && range !== undefined && this.place !== undefined) {
      await this.showRange(this.place.doc, range);
    }
  }

  private async toggleOption(option: PanelToggle): Promise<void> {
    if (option === 'pin') {
      this.pinned = this.pinned === undefined ? this.targets.shown : undefined;
      this.schedule(0);
    } else if (option === 'follow') {
      await this.write(FOLLOW_KEY, !this.deps.config.goalPanel().followCursor);
    } else {
      const doc = this.place?.doc;
      const root = doc === undefined ? undefined : await this.deps.projects.classify(doc.fileName);
      const kind = root === undefined ? 'ideMode' : this.deps.registry.backendFor(root).kind;
      const { display } = this.deps.config.ideMode();
      const value = kind === 'lsp' ? this.deps.config.lsp()[option] : display[option];
      await this.write(OPTION_KEYS[option][kind === 'lsp' ? 'lsp' : 'ideMode'], !value);
    }
  }

  /** Writes a setting where its value comes from: the workspace's, if it has one, else the user's. */
  private async write(key: string, value: boolean): Promise<void> {
    const { ConfigurationTarget } = this.api;
    const settings = this.api.workspace.getConfiguration('idris2');
    await settings.update(key, value, settings.inspect(key)?.workspaceValue === undefined ? ConfigurationTarget.Global : ConfigurationTarget.Workspace);
  }

  private async copy(): Promise<void> {
    if (this.shown?.goal !== undefined) {
      await this.api.env.clipboard.writeText(goalMarkdown(this.shown.goal));
      this.api.window.setStatusBarMessage('Idris 2: goal copied', 2000);
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.closed();
  }
}
