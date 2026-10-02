// Fakes of the VS Code API for the unit tests of M4's editing features (test/unit/editing.test.ts,
// cycling.test.ts, codeActions.test.ts, saveBeforeAction.test.ts). Unit tests may not import
// `vscode`, so the classes the features construct are stand-ins with the fields they set and the
// tests read. `FakeWorkspace.applyEdit` applies a WorkspaceEdit to the fake documents as VS Code
// does (all or nothing, one version step, one change event, refused when the version the extension
// host sent is not the document's), so the golden tests compare the resulting text.
import type * as vscode from 'vscode';
import type { Capabilities, EditRequest, EditResult, IdrisBackend } from '../../../src/backend/types';
import type { SaveBeforeAction } from '../../../src/core/config';
import { Emitter } from '../../../src/core/event';
import type { CheckStatus } from '../../../src/features/diagnostics/checks';
import type { EditingApi } from '../../../src/features/editing/register';
import type { EditingDeps } from '../../../src/features/editing/types';
import type { DocumentQueries, LoadedFileEvent, QueryMode, QueryOutcome } from '../../../src/features/intelligence/types';
import { IdrisException, isCancelled } from '../../../src/core/errors';
import type { Classification } from '../../../src/project/types';

export const quietLog = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

export class FakePosition {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class FakeRange {
  readonly start: FakePosition;
  readonly end: FakePosition;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new FakePosition(startLine, startCharacter);
    this.end = new FakePosition(endLine, endCharacter);
  }
}

export const range = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

/** `vscode.EndOfLine`. */
export const FakeEndOfLine = { LF: 1, CRLF: 2 } as const;

export interface FakeTextDocOptions {
  readonly fileName: string;
  readonly text: string;
  readonly languageId?: string;
  readonly scheme?: string;
  readonly version?: number;
  readonly isDirty?: boolean;
  readonly eol?: 'LF' | 'CRLF';
}

/** A text document whose text the fake workspace edits; the tests may change `isDirty`, `isClosed` and `saveResult`. */
export class FakeTextDoc {
  readonly uri: { readonly scheme: string; readonly fsPath: string; toString(): string };
  readonly fileName: string;
  readonly languageId: string;
  readonly isUntitled: boolean;
  version: number;
  isDirty: boolean;
  isClosed = false;
  readonly eol: number;
  lines: string[];
  saves = 0;
  /** What `save()` resolves with; `undefined`: true, and the document is no longer dirty. */
  saveResult: boolean | undefined;
  /** Runs inside `save()` before it resolves (a formatter on save, a test's probe). */
  onSave: (() => void) | undefined;

  constructor(options: FakeTextDocOptions) {
    const scheme = options.scheme ?? 'file';
    this.uri = { scheme, fsPath: options.fileName, toString: () => `${scheme}://${options.fileName}` };
    this.fileName = options.fileName;
    this.languageId = options.languageId ?? (options.fileName.endsWith('.lidr') ? 'lidr' : 'idris2');
    this.isUntitled = scheme === 'untitled';
    this.version = options.version ?? 1;
    this.isDirty = options.isDirty ?? false;
    this.eol = options.eol === 'CRLF' ? FakeEndOfLine.CRLF : FakeEndOfLine.LF;
    this.lines = options.text.split(/\r\n|\n/);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  lineAt(line: number): { readonly text: string } {
    return { text: this.lines[line] ?? '' };
  }

  /** The text with `\n` between lines (whatever `eol`): what the tests compare. */
  get text(): string {
    return this.lines.join('\n');
  }

  getText(r?: { readonly start: FakePosition; readonly end: FakePosition }): string {
    const eol = this.eol === FakeEndOfLine.CRLF ? '\r\n' : '\n';
    if (r === undefined) {
      return this.lines.join(eol);
    }
    if (r.start.line === r.end.line) {
      return this.lines[r.start.line].slice(r.start.character, r.end.character);
    }
    return [
      this.lines[r.start.line].slice(r.start.character),
      ...this.lines.slice(r.start.line + 1, r.end.line),
      this.lines[r.end.line].slice(0, r.end.character),
    ].join(eol);
  }

  save(): Promise<boolean> {
    this.saves++;
    this.onSave?.();
    if (this.saveResult === false) {
      return Promise.resolve(false);
    }
    this.isDirty = false;
    return Promise.resolve(true);
  }
}

/** `vscode.WorkspaceEdit`, recording its replacements. */
export class FakeWorkspaceEdit {
  readonly entries: { uri: string; range: FakeRange; text: string }[] = [];
  replace(uri: { toString(): string }, r: FakeRange, text: string): void {
    this.entries.push({ uri: uri.toString(), range: r, text });
  }
}

export interface ChangeEvent {
  readonly document: FakeTextDoc;
  readonly contentChanges: readonly unknown[];
}

/** `vscode.workspace`: the open documents, `applyEdit` on them, and the change and close events. */
export class FakeWorkspace {
  readonly textDocuments: FakeTextDoc[] = [];
  readonly changed = new Emitter<ChangeEvent>();
  readonly closed = new Emitter<FakeTextDoc>();
  readonly onDidChangeTextDocument = this.changed.event;
  readonly onDidCloseTextDocument = this.closed.event;
  /** Every WorkspaceEdit given to `applyEdit`, applied or not. */
  readonly edits: FakeWorkspaceEdit[] = [];
  /** Runs when `applyEdit` is called, before it looks at the versions (a user's keystroke in between). */
  beforeApply: (() => void) | undefined;
  /** Whether a change event of the edit comes after `applyEdit` resolved (VS Code sends it before). */
  lateEvents = false;
  /** Runs after the edit was applied and its change event sent, before `applyEdit` resolves (a user's keystroke then). */
  afterApply: (() => void) | undefined;

  open(doc: FakeTextDoc): FakeTextDoc {
    this.textDocuments.push(doc);
    return doc;
  }

  close(doc: FakeTextDoc): void {
    doc.isClosed = true;
    this.textDocuments.splice(this.textDocuments.indexOf(doc), 1);
    this.closed.fire(doc);
  }

  /** A change of `doc`'s text by someone else (the user typing): replaces `r` with `text`. */
  type(doc: FakeTextDoc, r: FakeRange, text: string): void {
    splice(doc, r, text);
    doc.version++;
    doc.isDirty = true;
    this.changed.fire({ document: doc, contentChanges: [{}] });
  }

  async applyEdit(edit: FakeWorkspaceEdit): Promise<boolean> {
    this.edits.push(edit);
    const find = (uri: string): FakeTextDoc | undefined => this.textDocuments.find((d) => d.uri.toString() === uri);
    // The extension host sends each text edit with the version it knows now (apply.ts).
    const sent = [...new Set(edit.entries.map((e) => e.uri))].map((uri) => ({ uri, version: find(uri)?.version }));
    this.beforeApply?.();
    await Promise.resolve();
    const docs = sent.map(({ uri, version }) => {
      const doc = find(uri);
      return doc !== undefined && doc.version === version ? doc : undefined;
    });
    if (docs.some((d) => d === undefined)) {
      return false;
    }
    for (const doc of docs as FakeTextDoc[]) {
      const mine = edit.entries.filter((e) => e.uri === doc.uri.toString());
      // From the last to the first, so that the ranges hold.
      for (const e of [...mine].reverse()) {
        splice(doc, e.range, e.text);
      }
      doc.version++;
      doc.isDirty = true;
      if (!this.lateEvents) {
        this.changed.fire({ document: doc, contentChanges: mine });
      } else {
        setImmediate(() => this.changed.fire({ document: doc, contentChanges: mine }));
      }
    }
    this.afterApply?.();
    return true;
  }
}

function splice(doc: FakeTextDoc, r: FakeRange, text: string): void {
  const before = doc.lines[r.start.line].slice(0, r.start.character);
  const after = doc.lines[r.end.line].slice(r.end.character);
  const inserted = (before + text + after).split(/\r\n|\r|\n/);
  doc.lines.splice(r.start.line, r.end.line - r.start.line + 1, ...inserted);
}

/** `vscode.StatusBarItem`. */
export class FakeStatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  name: string | undefined;
  visible = false;
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.visible = false;
  }
}

/** `vscode.CancellationToken` and its source. */
export class FakeToken {
  isCancellationRequested = false;
  private readonly emitter = new Emitter<void>();
  readonly onCancellationRequested = this.emitter.event;
  cancel(): void {
    if (!this.isCancellationRequested) {
      this.isCancellationRequested = true;
      this.emitter.fire();
    }
  }
}

export class FakeTokenSource {
  readonly token = new FakeToken();
  cancel(): void {
    this.token.cancel();
  }
  dispose(): void {}
}

/** A notification progress with Cancel, as the test sees it. */
export interface ShownProgress {
  readonly title: string;
  readonly cancellable: boolean;
  /** Clicks Cancel. */
  cancel(): void;
  /** Whether the task's promise has settled (VS Code then closes the notification). */
  closed: boolean;
}

/** `vscode.window`: the active editor, the messages shown, scripted input boxes and QuickPicks, progress. */
export class FakeWindow {
  activeTextEditor: { document: FakeTextDoc; selection: { active: FakePosition } } | undefined;
  readonly activeChanged = new Emitter<unknown>();
  readonly onDidChangeActiveTextEditor = this.activeChanged.event;
  readonly messages: { severity: 'info' | 'warning' | 'error'; text: string; modal: boolean; items: string[] }[] = [];
  /** The answer to a modal question (the button's title), else `undefined`. */
  answer: string | undefined;
  /** The input boxes asked, and the answer to give. */
  readonly inputBoxes: { prompt?: string; placeHolder?: string; ignoreFocusOut?: boolean }[] = [];
  inputAnswer: string | undefined;
  /** The QuickPicks shown, and which item to pick (by index; `undefined`: closed). */
  readonly quickPicks: { labels: string[]; placeHolder?: string }[] = [];
  pick: number | undefined = 0;
  readonly windowProgress: string[] = [];
  readonly notifications: ShownProgress[] = [];
  readonly statusItems: FakeStatusBarItem[] = [];

  showAt(doc: FakeTextDoc, line: number, character: number): void {
    this.activeTextEditor = { document: doc, selection: { active: new FakePosition(line, character) } };
    this.activeChanged.fire(this.activeTextEditor);
  }

  private show(severity: 'info' | 'warning' | 'error', text: string, rest: unknown[]): Promise<string | undefined> {
    const options = rest[0];
    const modal = typeof options === 'object' && options !== null && (options as { modal?: boolean }).modal === true;
    const items = rest.slice(modal || (typeof options === 'object' && options !== null) ? 1 : 0).filter((i): i is string => typeof i === 'string');
    this.messages.push({ severity, text, modal, items });
    return Promise.resolve(modal ? this.answer : undefined);
  }

  showInformationMessage(text: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.show('info', text, rest);
  }
  showWarningMessage(text: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.show('warning', text, rest);
  }
  showErrorMessage(text: string, ...rest: unknown[]): Promise<string | undefined> {
    return this.show('error', text, rest);
  }

  showInputBox(options: { prompt?: string; placeHolder?: string; ignoreFocusOut?: boolean }): Promise<string | undefined> {
    this.inputBoxes.push(options);
    return Promise.resolve(this.inputAnswer);
  }

  showQuickPick<T extends { label: string }>(items: readonly T[], options: { placeHolder?: string }): Promise<T | undefined> {
    this.quickPicks.push({ labels: items.map((i) => i.label), placeHolder: options.placeHolder });
    return Promise.resolve(this.pick === undefined ? undefined : items[this.pick]);
  }

  withProgress<T>(
    options: { location: number; title?: string; cancellable?: boolean },
    task: (progress: { report(): void }, token: FakeToken) => Thenable<T>,
  ): Thenable<T> {
    const token = new FakeToken();
    const result = task({ report: () => undefined }, token);
    if (options.location === FakeProgressLocation.Notification) {
      const shown: ShownProgress = { title: options.title ?? '', cancellable: options.cancellable === true, cancel: () => token.cancel(), closed: false };
      this.notifications.push(shown);
      const close = (): void => {
        shown.closed = true;
      };
      result.then(close, close);
    } else {
      this.windowProgress.push(options.title ?? '');
    }
    return result;
  }

  createStatusBarItem(): FakeStatusBarItem {
    const item = new FakeStatusBarItem();
    this.statusItems.push(item);
    return item;
  }
}

export const FakeProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

/** `vscode.CodeActionKind` (the part the provider uses). */
export class FakeCodeActionKind {
  static readonly Empty = new FakeCodeActionKind('');
  constructor(readonly value: string) {}
  append(part: string): FakeCodeActionKind {
    return new FakeCodeActionKind(this.value === '' ? part : `${this.value}.${part}`);
  }
  contains(other: FakeCodeActionKind): boolean {
    return this.value === other.value || other.value.startsWith(`${this.value}.`);
  }
}

export class FakeCodeAction {
  command: { command: string; title: string; arguments?: unknown[] } | undefined;
  diagnostics: unknown[] | undefined;
  isPreferred: boolean | undefined;
  disabled: { readonly reason: string } | undefined;
  constructor(
    readonly title: string,
    readonly kind: FakeCodeActionKind,
  ) {}
}

export interface CodeActionContextLike {
  readonly diagnostics: readonly unknown[];
  readonly only?: FakeCodeActionKind;
}

/** The API the editing features take (`EditingApi`), with the parts the tests drive. */
export class FakeEditingApi {
  readonly window = new FakeWindow();
  readonly workspace = new FakeWorkspace();
  readonly handlers = new Map<string, (args?: unknown) => Promise<void>>();
  readonly commands = {
    registerCommand: (id: string, handler: (args?: unknown) => Promise<void>) => {
      this.handlers.set(id, handler);
      return { dispose: () => this.handlers.delete(id) };
    },
  };
  diagnostics: unknown[] = [];
  provider:
    | { provideCodeActions(doc: unknown, r: FakeRange, context: CodeActionContextLike): Promise<FakeCodeAction[]> }
    | undefined;
  providedKinds: string[] = [];
  readonly languages = {
    getDiagnostics: () => this.diagnostics,
    registerCodeActionsProvider: (
      _selector: unknown,
      provider: { provideCodeActions(doc: unknown, r: FakeRange, context: CodeActionContextLike): Promise<FakeCodeAction[]> },
      metadata: { providedCodeActionKinds: FakeCodeActionKind[] },
    ) => {
      this.provider = provider;
      this.providedKinds = metadata.providedCodeActionKinds.map((k) => k.value);
      return { dispose: () => (this.provider = undefined) };
    },
  };
  readonly Position = FakePosition;
  readonly Range = FakeRange;
  readonly WorkspaceEdit = FakeWorkspaceEdit;
  readonly EndOfLine = FakeEndOfLine;
  readonly ProgressLocation = FakeProgressLocation;
  readonly CancellationTokenSource = FakeTokenSource;
  readonly CodeAction = FakeCodeAction;
  readonly CodeActionKind = FakeCodeActionKind;
  readonly StatusBarAlignment = { Left: 1, Right: 2 };

  asApi(): EditingApi {
    return this as unknown as EditingApi;
  }

  /** Runs the registered command `id` as VS Code would (with `args` if given). */
  run(id: string, args?: unknown): Promise<void> {
    const handler = this.handlers.get(id);
    if (handler === undefined) {
      throw new Error(`${id} is not registered`);
    }
    return handler(args);
  }
}

/** A backend whose `edit` answers with what the test scripts, recording the requests. */
export class FakeEditBackend {
  readonly kind = 'ideMode' as const;
  caps: Partial<Capabilities> = { editing: true, editingNext: true, intro: true, refine: true, missingCases: true };
  readonly requests: EditRequest[] = [];
  /** Answers the `n`-th request (0-based). Default: rejects. */
  answer: (req: EditRequest, n: number) => Promise<EditResult> = () => Promise.reject(new Error('no answer scripted'));

  asBackend(): IdrisBackend {
    return {
      kind: this.kind,
      caps: this.caps as Capabilities,
      edit: (req: EditRequest) => {
        this.requests.push(req);
        return this.answer(req, this.requests.length - 1);
      },
    } as unknown as IdrisBackend;
  }
}

export const looseRoot = (dir: string): Classification => ({ kind: 'loose', dir }) as Classification;

/**
 * `DocumentQueries` as `features/intelligence/queries.ts` runs a `command`: the query, and on
 * `NotLoaded` one load (`load`, counted) and the query again; an `IdrisException` or a
 * cancellation is `unavailable`.
 */
export function fakeQueries(backend: () => IdrisBackend, load: () => void = () => undefined): DocumentQueries & { loads: number; runs: QueryMode[] } {
  const self = {
    loads: 0,
    runs: [] as QueryMode[],
    async run<T>(_doc: vscode.TextDocument, mode: QueryMode, query: (b: IdrisBackend) => Promise<T>): Promise<QueryOutcome<T>> {
      self.runs.push(mode);
      for (let attempt = 0; ; attempt++) {
        try {
          return { kind: 'answer', value: await query(backend()) };
        } catch (error) {
          if (error instanceof IdrisException && error.error.kind === 'NotLoaded' && attempt === 0) {
            self.loads++;
            load();
            continue;
          }
          if (error instanceof IdrisException) {
            return { kind: 'unavailable', reason: error.message };
          }
          if (isCancelled(error)) {
            return { kind: 'unavailable', reason: (error as Error).message };
          }
          throw error;
        }
      }
    },
  };
  return self;
}

/** `EditingDeps` over one fake backend, with the load event a test fires and the settings it sets. */
export function editingDeps(backend: FakeEditBackend, options: { trusted?: boolean } = {}) {
  const loads = new Emitter<LoadedFileEvent>();
  const queries = fakeQueries(() => backend.asBackend());
  const settings = { saveBeforeAction: 'always' as SaveBeforeAction, status: undefined as CheckStatus | undefined, trusted: options.trusted ?? true };
  const logged: string[] = [];
  /** The save-check holds the cycles took, in order, and whether each was released. */
  const holds: { readonly uri: string; released: boolean }[] = [];
  const deps: EditingDeps = {
    queries,
    loads: { onDidLoad: loads.event },
    registry: { backendFor: () => backend.asBackend() },
    projects: { classify: (file: string) => Promise.resolve(looseRoot(file.slice(0, file.lastIndexOf('/')))) },
    checks: {
      statusOf: () => settings.status,
      onDidChange: new Emitter<void>().event,
      holdSaveChecks: (uri: string) => {
        holds.push({ uri, released: false });
        const hold = holds[holds.length - 1];
        return { dispose: () => (hold.released = true) };
      },
    },
    config: { saveBeforeAction: () => settings.saveBeforeAction },
    trust: {
      get isTrusted() {
        return settings.trusted;
      },
      onDidGrant: new Emitter<void>().event,
    },
    log: { ...quietLog, warn: (m: string) => logged.push(`warn ${m}`), error: (m: string) => logged.push(`error ${m}`) },
  };
  return { deps, loads, queries, settings, logged, holds };
}
