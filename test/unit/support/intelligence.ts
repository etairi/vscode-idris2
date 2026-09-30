// Test doubles for M3's read-only providers (src/features/intelligence): a text document, a
// backend whose answers the test sets, a fake of the part of the VS Code API `registerIntelligence`
// uses, and readers of the recorded IDE-mode transcripts (test/fixtures/transcripts/0.8.0), so
// that tokens and replies in the tests are the compiler's own. No process is started.
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { parseSexp, serializeSexp } from '../../../src/backend/ide/sexp';
import type { Sexp } from '../../../src/backend/ide/types';
import type { Capabilities, Decor, IdrisBackend, NamespaceEntry, RichText, RichTextSpan, Token, TokenIndex, TypeInfo } from '../../../src/backend/types';
import { Emitter } from '../../../src/core/event';
import { IdrisException } from '../../../src/core/errors';
import { fromIdeReplySpan } from '../../../src/core/positions';
import { repoRoot } from '../../fake-tools/paths';

// -------------------------------------------------------------------------------------------
// Documents
// -------------------------------------------------------------------------------------------

/** A text document with what the providers read; `vscode.TextDocument` in the tests (`asDoc`). */
export class FakeDocument {
  version = 1;
  isDirty = false;
  private lines: string[];
  readonly uri: { readonly scheme: string; readonly fsPath: string; readonly path: string; readonly query: string; toString(): string };

  constructor(
    readonly fileName: string,
    private text: string,
    readonly languageId = fileName.endsWith('.lidr') ? 'lidr' : 'idris2',
    scheme = 'file',
  ) {
    this.lines = text.split('\n');
    this.uri = { scheme, fsPath: fileName, path: fileName, query: '', toString: () => `${scheme}://${fileName}` };
  }

  get isUntitled(): boolean {
    return this.uri.scheme === 'untitled';
  }

  get lineCount(): number {
    return this.lines.length;
  }

  lineAt(line: number): { text: string } {
    return { text: this.lines[line] };
  }

  getText(): string {
    return this.text;
  }

  /** An edit: new text, a new version, unsaved unless `saved`. */
  edit(text: string, saved = false): void {
    this.text = text;
    this.lines = text.split('\n');
    this.version++;
    this.isDirty = !saved;
  }
}

export function asDoc(doc: FakeDocument): vscode.TextDocument {
  return doc as unknown as vscode.TextDocument;
}

/** A fixture file of the repository as a `FakeDocument` named by its absolute path. */
export function fixtureDocument(relative: string): FakeDocument {
  const file = path.join(repoRoot(), relative);
  return new FakeDocument(file, fs.readFileSync(file, 'utf8'));
}

// -------------------------------------------------------------------------------------------
// Recorded transcripts
// -------------------------------------------------------------------------------------------

interface Event {
  readonly kind: string;
  readonly text?: string;
}

function events(scenario: string): Event[] {
  const file = path.join(repoRoot(), 'test/fixtures/transcripts/0.8.0', `${scenario}.jsonl`);
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event);
}

function items(s: Sexp | undefined): readonly Sexp[] {
  return s?.kind === 'list' ? s.items : [];
}

/** The values after the keyword `:name` in a property list such as `((:name "x") (:start 1 2))`. */
function values(list: Sexp | undefined, name: string): readonly Sexp[] {
  for (const entry of items(list)) {
    const [key, ...rest] = items(entry);
    if (key?.kind === 'symbol' && key.name === name) {
      return rest;
    }
  }
  return [];
}

/** The first value after `:name` (`values`). */
function property(list: Sexp | undefined, name: string): Sexp | undefined {
  return values(list, name)[0];
}

const DECORS: ReadonlySet<string> = new Set(['comment', 'type', 'function', 'data', 'keyword', 'bound', 'namespace', 'postulate', 'module']);

/**
 * The tokens of the first load in `scenario` whose `:highlight-source` frames name a file ending in
 * `fileSuffix`, as `IdrisBackend.tokens` has them: in `doc`'s file columns (the bird-track offset
 * applied by `core/positions.ts`), sorted, identical entries once.
 */
export function recordedTokens(scenario: string, fileSuffix: string, doc: FakeDocument): Token[] {
  const tokens: Token[] = [];
  const seen = new Set<string>();
  for (const e of events(scenario)) {
    if (e.kind !== 'recv' || e.text === undefined || !e.text.includes(':highlight-source')) {
      continue;
    }
    const frame = parseSexp(e.text.trim());
    // (:output (:ok (:highlight-source (ENTRY …))) id), ENTRY = ((location) (properties))
    const entries = items(items(items(items(frame)[1])[1])[1]);
    for (const entry of entries) {
      const [location, props] = items(entry);
      const filename = property(location, 'filename');
      const decor = property(props, 'decor');
      const key = serializeSexp(entry);
      if (filename?.kind !== 'string' || !filename.value.endsWith(fileSuffix) || decor?.kind !== 'symbol' || !DECORS.has(decor.name) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const point = (at: readonly Sexp[]): { line: number; column: number } => {
        const [l, c] = at;
        return { line: Number(l?.kind === 'integer' ? l.value : -1), column: Number(c?.kind === 'integer' ? c.value : -1) };
      };
      const name = property(props, 'name');
      const ns = property(props, 'namespace');
      tokens.push({
        range: fromIdeReplySpan(doc, { start: point(values(location, 'start')), end: point(values(location, 'end')) }),
        decor: decor.name as Decor,
        ...(name?.kind === 'string' ? { name: name.value } : {}),
        ...(ns?.kind === 'string' ? { namespace: ns.value } : {}),
      });
    }
  }
  return tokens.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character || a.range.end.line - b.range.end.line || a.range.end.character - b.range.end.character);
}

/** A `TokenIndex` of `doc`'s current text. */
export function indexOf(doc: FakeDocument, tokens: Token[]): TokenIndex {
  return { file: doc.fileName, text: doc.getText(), tokens };
}

/**
 * The reply of the request of `scenario` whose text contains `request`: its string and the spans
 * that carry a decoration (offsets in code points, as the compiler counts; the tests use ASCII
 * replies, where they are UTF-16 offsets as well), or `error` for an `(:error …)` reply.
 */
export function recordedReply(scenario: string, request: string): RichText & { readonly error?: true } {
  const all = events(scenario);
  const sent = all.findIndex((e) => e.kind === 'send' && e.text !== undefined && e.text.includes(request));
  if (sent < 0) {
    throw new Error(`${scenario}: no request with ${request}`);
  }
  const reply = all.slice(sent + 1).find((e) => e.kind === 'recv' && e.text !== undefined && e.text.startsWith('(:return'));
  const [, result] = items(parseSexp((reply?.text ?? '').trim()));
  const [status, value, spans] = items(result);
  const text = value?.kind === 'string' ? value.value : '';
  const decorated: RichTextSpan[] = items(spans).flatMap((span) => {
    const [start, length, props] = items(span);
    const decor = property(props, 'decor');
    return start?.kind === 'integer' && length?.kind === 'integer' && decor?.kind === 'symbol' && DECORS.has(decor.name)
      ? [{ start: Number(start.value), length: Number(length.value), decor: decor.name as Decor }]
      : [];
  });
  return status?.kind === 'symbol' && status.name === 'error' ? { text, spans: decorated, error: true } : { text, spans: decorated };
}

/** `recordedReply` of a `:type-of` as `TypeInfo`. */
export function recordedType(scenario: string, request: string, lookup: TypeInfo['lookup'] = 'position'): TypeInfo {
  const { text, spans } = recordedReply(scenario, request);
  return { text, spans, lookup };
}

// -------------------------------------------------------------------------------------------
// Backend
// -------------------------------------------------------------------------------------------

export const ALL_CAPABILITIES: Capabilities = {
  diagnostics: true,
  hover: true,
  definition: true,
  completion: true,
  signatureHelp: false,
  semanticTokens: true,
  documentSymbols: true,
  documentHighlights: true,
  holes: false,
  holeLocations: false,
  editing: false,
  editingNext: false,
  intro: false,
  refine: false,
  missingCases: false,
  evaluate: true,
  docs: true,
  browseNamespace: true,
  checksUnsaved: false,
};

type Answer<T> = (name: string, pos?: vscode.Position) => Promise<T>;

/**
 * A backend whose answers the test sets. `loaded`: the files whose queries it answers (others get
 * `NotLoaded`, as `IdeBackend` does for a file its session did not load last); `null` answers
 * every file. `calls` records every query as `method name [line:character]`.
 */
export class FakeBackend implements IdrisBackend {
  readonly kind = 'ideMode' as const;
  caps: Capabilities = { ...ALL_CAPABILITIES };
  index: TokenIndex | undefined;
  loaded: Set<string> | null = null;
  readonly calls: string[] = [];
  /** The `decor` of each `typeAt` and `definition` call, in order. */
  readonly decors: (Decor | undefined)[] = [];
  /** The `namespace` of each `definition` call, in order. */
  readonly namespaces: (string | undefined)[] = [];
  typeAnswer: Answer<TypeInfo | undefined> = () => Promise.resolve(undefined);
  docsAnswer: Answer<RichText | undefined> = () => Promise.resolve(undefined);
  definitionAnswer: Answer<vscode.Location[]> = () => Promise.resolve([]);
  browseAnswer: (ns: string) => Promise<NamespaceEntry[]> = () => Promise.resolve([]);

  private query(doc: vscode.TextDocument, call: string): void {
    this.calls.push(call);
    if (this.loaded !== null && !this.loaded.has(doc.fileName)) {
      throw new IdrisException({ kind: 'NotLoaded', message: `${doc.fileName} is not loaded`, file: doc.fileName });
    }
  }

  load(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  async typeAt(doc: vscode.TextDocument, pos: vscode.Position, name: string, decor?: Decor): Promise<TypeInfo | undefined> {
    this.decors.push(decor);
    this.query(doc, `typeAt ${name} ${pos.line}:${pos.character}`);
    return this.typeAnswer(name, pos);
  }

  async docsFor(doc: vscode.TextDocument, name: string, mode: 'overview' | 'full'): Promise<RichText | undefined> {
    this.query(doc, `docsFor ${name} ${mode}`);
    return this.docsAnswer(name);
  }

  async definition(doc: vscode.TextDocument, pos: vscode.Position, name: string, decor?: Decor, namespace?: string): Promise<vscode.Location[]> {
    this.decors.push(decor);
    this.namespaces.push(namespace);
    this.query(doc, `definition ${name} ${pos.line}:${pos.character}`);
    return this.definitionAnswer(name, pos);
  }

  async browseNamespace(doc: vscode.TextDocument, ns: string): Promise<NamespaceEntry[]> {
    this.query(doc, `browseNamespace ${ns}`);
    return this.browseAnswer(ns);
  }

  completions(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  holes(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  edit(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  evaluate(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  tokens(doc: vscode.TextDocument): TokenIndex | undefined {
    return this.index?.file === doc.fileName ? this.index : undefined;
  }

  dispose(): void {}
}

export const quietLog = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** Lets pending promise callbacks run. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// -------------------------------------------------------------------------------------------
// VS Code API
// -------------------------------------------------------------------------------------------

export class FakePosition {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class FakeRange {
  readonly start: FakePosition;
  readonly end: FakePosition;
  constructor(a: FakePosition | number, b: FakePosition | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new FakePosition(a, b as number);
      this.end = new FakePosition(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as FakePosition;
    }
  }
}

/** Records what was appended and how, and the flags. */
export class FakeMarkdownString {
  readonly parts: { readonly kind: 'text' | 'markdown'; readonly value: string }[] = [];
  isTrusted: boolean | undefined = undefined;
  supportHtml = false;
  supportThemeIcons = false;
  appendText(value: string): this {
    this.parts.push({ kind: 'text', value });
    return this;
  }
  appendMarkdown(value: string): this {
    this.parts.push({ kind: 'markdown', value });
    return this;
  }
}

export class FakeUri {
  constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query: string,
  ) {}
  get fsPath(): string {
    return this.path;
  }
  static from(c: { scheme: string; path?: string; query?: string }): FakeUri {
    return new FakeUri(c.scheme, c.path ?? '', c.query ?? '');
  }
  static parse(s: string): FakeUri {
    const m = /^([a-z0-9-]+):(?:\/\/)?([^?]*)(?:\?(.*))?$/.exec(s);
    if (m === null) {
      throw new Error(`cannot parse ${s}`);
    }
    return new FakeUri(m[1], m[2], m[3] ?? '');
  }
  toString(): string {
    return this.scheme === 'file' ? `file://${this.path}` : `${this.scheme}:${this.path}${this.query === '' ? '' : `?${this.query}`}`;
  }
}

class FakeEventEmitter<T> {
  private readonly emitter = new Emitter<T>();
  readonly event = this.emitter.event;
  fire(e: T): void {
    this.emitter.fire(e);
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

export interface Providers {
  hover?: vscode.HoverProvider;
  definition?: vscode.DefinitionProvider;
  symbols?: vscode.DocumentSymbolProvider;
  highlights?: vscode.DocumentHighlightProvider;
  /** By selector: `idris` (the document selector) or `docs` (`{ scheme: 'idris2-doc' }`). */
  semanticTokens: Map<'idris' | 'docs', { provider: vscode.DocumentSemanticTokensProvider; legend: { tokenTypes: string[]; tokenModifiers: string[] } }>;
  content?: vscode.TextDocumentContentProvider;
}

/** A fake of `IntelligenceApi`; `state` steers the window, the other fields record. */
export function fakeApi() {
  const providers: Providers = { semanticTokens: new Map() };
  const selectors: unknown[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const executed: unknown[][] = [];
  const messages: string[] = [];
  const inputBoxes: Record<string, unknown>[] = [];
  const quickPicks: { items: unknown[]; options: Record<string, unknown> }[] = [];
  const shownDocuments: { doc: FakeDocument; options: unknown }[] = [];
  const closed = new Emitter<{ uri: { toString(): string } }>();
  const state = {
    editor: undefined as { document: FakeDocument; selection: { active: FakePosition } } | undefined,
    input: undefined as string | undefined,
    pick: undefined as ((items: unknown[]) => unknown) | undefined,
    textDocuments: [] as FakeDocument[],
  };
  const register =
    (key: 'hover' | 'definition' | 'symbols' | 'highlights') =>
    (selector: unknown, provider: never): { dispose(): void } => {
      selectors.push(selector);
      (providers as unknown as Record<string, unknown>)[key] = provider;
      return { dispose: () => undefined };
    };
  const api = {
    languages: {
      registerHoverProvider: register('hover'),
      registerDefinitionProvider: register('definition'),
      registerDocumentSymbolProvider: register('symbols'),
      registerDocumentHighlightProvider: register('highlights'),
      registerDocumentSemanticTokensProvider: (selector: unknown, provider: vscode.DocumentSemanticTokensProvider, legend: never) => {
        selectors.push(selector);
        const key = (selector as { scheme?: string }).scheme === 'idris2-doc' ? 'docs' : 'idris';
        providers.semanticTokens.set(key, { provider, legend });
        return { dispose: () => undefined };
      },
    },
    commands: {
      registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
        commands.set(id, run);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: (...args: unknown[]) => {
        executed.push(args);
        return Promise.resolve();
      },
    },
    window: {
      get activeTextEditor() {
        return state.editor;
      },
      showInformationMessage: (text: string) => {
        messages.push(text);
        return Promise.resolve(undefined);
      },
      showInputBox: (options: Record<string, unknown>) => {
        inputBoxes.push(options);
        return Promise.resolve(state.input);
      },
      showQuickPick: (pickItems: unknown[], options: Record<string, unknown>) => {
        quickPicks.push({ items: pickItems, options });
        return Promise.resolve(state.pick?.(pickItems));
      },
      showTextDocument: (doc: FakeDocument, options: unknown) => {
        shownDocuments.push({ doc, options });
        return Promise.resolve();
      },
    },
    workspace: {
      get textDocuments() {
        return state.textDocuments;
      },
      openTextDocument: async (uri: FakeUri) => {
        const open = state.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (open !== undefined) {
          return open;
        }
        if (uri.scheme === 'idris2-doc' && providers.content !== undefined) {
          const text = (await providers.content.provideTextDocumentContent(uri as unknown as vscode.Uri, { isCancellationRequested: false } as vscode.CancellationToken)) ?? '';
          const doc = new FakeDocument(uri.path, text, 'plaintext', 'idris2-doc');
          Object.defineProperty(doc, 'uri', { value: uri });
          state.textDocuments.push(doc);
          return doc;
        }
        throw new Error(`cannot open ${uri.toString()}`);
      },
      registerTextDocumentContentProvider: (_scheme: string, provider: vscode.TextDocumentContentProvider) => {
        providers.content = provider;
        return { dispose: () => undefined };
      },
      onDidCloseTextDocument: closed.event,
    },
    MarkdownString: FakeMarkdownString,
    Hover: class {
      constructor(
        readonly contents: FakeMarkdownString,
        readonly range: FakeRange,
      ) {}
    },
    Position: FakePosition,
    Range: FakeRange,
    Uri: FakeUri,
    SemanticTokensLegend: class {
      constructor(
        readonly tokenTypes: string[],
        readonly tokenModifiers: string[],
      ) {}
    },
    SemanticTokens: class {
      constructor(readonly data: Uint32Array) {}
    },
    DocumentSymbol: class {
      children: unknown[] = [];
      constructor(
        readonly name: string,
        readonly detail: string,
        readonly kind: number,
        readonly range: FakeRange,
        readonly selectionRange: FakeRange,
      ) {}
    },
    SymbolKind: { Namespace: 2, Method: 5, Field: 7, Constructor: 8, Interface: 10, Function: 11, Struct: 22 },
    DocumentHighlight: class {
      constructor(readonly range: FakeRange) {}
    },
    EventEmitter: FakeEventEmitter,
    ViewColumn: { Beside: -2 },
  };
  const cancel = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken;
  const run = (id: string, ...args: unknown[]) => Promise.resolve(commands.get(id)?.(...args));
  return { api, providers, selectors, commands, executed, messages, inputBoxes, quickPicks, shownDocuments, state, cancel, run, closed };
}
