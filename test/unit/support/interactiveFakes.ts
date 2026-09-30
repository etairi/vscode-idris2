// Fakes of the VS Code API and of the M3 dependencies for the unit tests of completion, inlay hints
// and evaluation (test/unit/completion.test.ts, inlayHints.test.ts, eval.test.ts). Unit tests may
// not import `vscode`, so the classes the features construct (`Range`, `Position`,
// `CompletionItem`, …) are stand-ins with the fields the features set and the tests read.
import type * as vscode from 'vscode';
import type { BackendRegistry } from '../../../src/backend/registry';
import type { Capabilities, IdrisBackend, TokenIndex, TypeInfo, Evaluation } from '../../../src/backend/types';
import type { ConfigurationGroup, SettingsChange } from '../../../src/core/config';
import { IdrisException } from '../../../src/core/errors';
import { Emitter } from '../../../src/core/event';
import type { DocumentQueries, IntelligenceDeps, LoadedFileEvent, QueryMode, QueryOutcome } from '../../../src/features/intelligence/types';
import type { Classification } from '../../../src/project/types';

export const quietLog = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** Resolves after every pending promise callback and one turn of the event loop. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

export class FakeMarkdownString {
  value = '';
  isTrusted: boolean | undefined;
  supportHtml: boolean | undefined;
  supportThemeIcons: boolean | undefined;
  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
  /** Escapes like VS Code's `appendText` does for the characters the tests use. */
  appendText(value: string): this {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, '\\$&');
    return this;
  }
}

export class FakeEventEmitter<T> {
  private readonly emitter = new Emitter<T>();
  fired = 0;
  readonly event = this.emitter.event;
  fire(e: T): void {
    this.fired++;
    this.emitter.fire(e);
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

export interface FakeDocOptions {
  readonly fileName: string;
  readonly text: string;
  readonly languageId?: string;
  readonly scheme?: string;
  readonly version?: number;
  readonly isDirty?: boolean;
}

/** A text document; its fields may be changed by a test (`version`, `isDirty`, `isClosed`). */
export interface FakeDoc {
  readonly uri: { readonly scheme: string; readonly fsPath: string; toString(): string };
  readonly fileName: string;
  readonly languageId: string;
  readonly isUntitled: boolean;
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  text: string;
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
  getText(): string;
}

export function fakeDoc(options: FakeDocOptions): FakeDoc {
  const scheme = options.scheme ?? 'file';
  const doc: FakeDoc = {
    uri: { scheme, fsPath: options.fileName, toString: () => `${scheme}://${options.fileName}` },
    fileName: options.fileName,
    languageId: options.languageId ?? 'idris2',
    isUntitled: scheme === 'untitled',
    version: options.version ?? 1,
    isDirty: options.isDirty ?? false,
    isClosed: false,
    text: options.text,
    get lineCount() {
      return doc.text.split('\n').length;
    },
    lineAt: (line: number) => ({ text: doc.text.split('\n')[line] ?? '' }),
    getText: () => doc.text,
  };
  return doc;
}

/** The fake as the typed `vscode.TextDocument` the features take. */
export const asDoc = (doc: FakeDoc): vscode.TextDocument => doc as unknown as vscode.TextDocument;

/** A cancellation token that a test may cancel. */
export function fakeToken(): { isCancellationRequested: boolean; onCancellationRequested: () => { dispose(): void } } {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
}

/** A promise with its resolve and reject, for answers a test hands out when it chooses. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A backend whose query methods record their calls and answer with what the test sets. */
export class FakeBackend {
  readonly kind = 'ideMode' as const;
  caps: Partial<Capabilities> = { completion: true, hover: true, evaluate: true };
  readonly calls: string[] = [];
  /** `completions(doc, prefix)`; default: every name of `names` starting with `prefix`. */
  names: readonly string[] = [];
  completions: (doc: vscode.TextDocument, prefix: string) => Promise<readonly string[]> = (_doc, prefix) =>
    Promise.resolve(this.names.filter((n) => n.startsWith(prefix)));
  /** `typeAt(doc, pos, name)`; default: undefined. */
  answerType: (line: number, character: number, name: string) => Promise<TypeInfo | undefined> = () => Promise.resolve(undefined);
  /** `evaluate(doc, expr, token)`. */
  answerEvaluation: (expr: string, token?: vscode.CancellationToken) => Promise<Evaluation> = () =>
    Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'no evaluation in this test' }));
  index: TokenIndex | undefined;

  asBackend(): IdrisBackend {
    const self = this;
    return {
      kind: this.kind,
      get caps() {
        return self.caps as Capabilities;
      },
      completions: (doc: vscode.TextDocument, prefix: string) => {
        self.calls.push(`completions ${prefix}`);
        return self.completions(doc, prefix);
      },
      typeAt: (_doc: vscode.TextDocument, pos: vscode.Position, name: string) => {
        self.calls.push(`typeAt ${pos.line}:${pos.character} ${name}`);
        return self.answerType(pos.line, pos.character, name);
      },
      evaluate: (_doc: vscode.TextDocument, expr: string, token?: vscode.CancellationToken) => {
        self.calls.push(`evaluate ${expr}`);
        return self.answerEvaluation(expr, token);
      },
      tokens: () => self.index,
      load: () => {
        self.calls.push('load');
        return Promise.reject(new Error('the features under test must not load'));
      },
    } as unknown as IdrisBackend;
  }
}

/**
 * `DocumentQueries` that runs the query on the backend and turns an `IdrisException` into
 * `unavailable` (the contract of `run`, without its loading); records each call's file and mode.
 */
export function fakeQueries(backend: () => IdrisBackend): DocumentQueries & { readonly runs: { file: string; mode: QueryMode }[] } {
  const runs: { file: string; mode: QueryMode }[] = [];
  return {
    runs,
    async run<T>(doc: vscode.TextDocument, mode: QueryMode, query: (b: IdrisBackend) => Promise<T>): Promise<QueryOutcome<T>> {
      runs.push({ file: doc.fileName, mode });
      try {
        return { kind: 'answer', value: await query(backend()) };
      } catch (error) {
        if (error instanceof IdrisException) {
          return { kind: 'unavailable', reason: error.message };
        }
        throw error;
      }
    },
  };
}

/** Settings of the M3 groups a test can change, with the change event. */
export class FakeConfig {
  variableTypes = true;
  inlineResults = true;
  private readonly changed = new Emitter<ConfigurationGroup>();
  inlayHints = (): { variableTypes: boolean } => ({ variableTypes: this.variableTypes });
  evaluation = (): { inlineResults: boolean; timeoutMs: number } => ({ inlineResults: this.inlineResults, timeoutMs: 10000 });
  onDidChange = (group: ConfigurationGroup, listener: (change: SettingsChange) => void): { dispose(): unknown } =>
    this.changed.event((g) => {
      if (g === group) {
        listener({ affects: () => true });
      }
    });
  change(group: ConfigurationGroup): void {
    this.changed.fire(group);
  }
}

export const looseRoot = (dir: string): Classification => ({ kind: 'loose', dir }) as Classification;

/** `IntelligenceDeps` over one fake backend, with the load event a test fires. */
export function intelligenceDeps(backend: FakeBackend) {
  const loads = new Emitter<LoadedFileEvent>();
  const config = new FakeConfig();
  const queries = fakeQueries(() => backend.asBackend());
  const logged: string[] = [];
  const deps: IntelligenceDeps = {
    queries,
    loads: { onDidLoad: loads.event },
    registry: { backendFor: () => backend.asBackend() },
    projects: { classify: (file: string) => Promise.resolve(looseRoot(file.slice(0, file.lastIndexOf('/')))) },
    checks: { statusOf: () => undefined, onDidChange: new Emitter<void>().event },
    config,
    log: { ...quietLog, debug: (m: string) => logged.push(`debug ${m}`), error: (m: string) => logged.push(`error ${m}`) },
  };
  return { deps, loads, config, queries, logged };
}
