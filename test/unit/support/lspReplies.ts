// The exchanges of an idris2-lsp recording (test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a, format
// in its README): each request the recorder sent, with the server's response, `${ROOT}` replaced by
// `LSP_ROOT`; a language client (`LspClientHandle`) that answers the backend from them — only a
// request the recorder sent, its parameters equal, so that the backend's requests are shown to be the
// recorded ones (positions, `only` keys and all); and the fixtures as the backend reads them.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { LspBackend } from '../../../src/backend/lsp/backend';
import type { LspClientHandle, LspCommandArguments, LspCommandName, LspCommandResults } from '../../../src/backend/lsp/types';
import type { EditResult, TextReplacement } from '../../../src/backend/types';
import type { EditorRange } from '../../../src/core/positions';
import { IdrisException } from '../../../src/core/errors';
import { Emitter } from '../../../src/core/event';
import { repoRoot } from '../../fake-tools/paths';
import { FakeDocument, FakeRange, FakeUri } from './intelligence';

/** What `${ROOT}` stands for in the tests: the workspace copy the recorder started the server in. */
export const LSP_ROOT = '/lsp';

const RECORDINGS = path.join(repoRoot(), 'test', 'fixtures', 'lsp-transcripts', '0.1.0-9a2f0ad6a');

interface RecordedEvent {
  readonly kind: string;
  readonly text?: string;
  readonly workspace?: string;
}

export interface LspExchange {
  readonly method: string;
  readonly params: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function events(scenario: string): RecordedEvent[] {
  return fs
    .readFileSync(path.join(RECORDINGS, `${scenario}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line.split('${ROOT}').join(LSP_ROOT)) as RecordedEvent);
}

/** The fixture directory a scenario's `${ROOT}` is a copy of (`meta.workspace`), absolute. */
export function recordedWorkspace(scenario: string): string {
  const [meta] = events(scenario);
  assert.ok(meta.kind === 'meta' && meta.workspace !== undefined, `${scenario}: no meta line`);
  return path.join(repoRoot(), meta.workspace);
}

/** Every request of `scenario` that has an id, with the server's response, in order. */
export function lspExchanges(scenario: string): LspExchange[] {
  const pending = new Map<number, { method: string; params: unknown }>();
  const exchanges: LspExchange[] = [];
  for (const event of events(scenario)) {
    if ((event.kind !== 'send' && event.kind !== 'recv') || event.text === undefined) {
      continue;
    }
    const message = JSON.parse(event.text) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
    if (event.kind === 'send' && message.id !== undefined && message.method !== undefined) {
      pending.set(message.id, { method: message.method, params: message.params });
    } else if (event.kind === 'recv' && message.id !== undefined && message.method === undefined) {
      const request = pending.get(message.id);
      if (request !== undefined) {
        pending.delete(message.id);
        exchanges.push(message.error === undefined ? { ...request, result: message.result } : { ...request, error: message.error });
      }
    }
  }
  return exchanges;
}

/** The answer recorded for the first `method` request of `scenario` whose parameters satisfy `matches`. */
export function recordedResult(scenario: string, method: string, matches: (params: unknown) => boolean = () => true): unknown {
  const found = lspExchanges(scenario).find((x) => x.method === method && matches(x.params));
  assert.ok(found !== undefined, `${scenario}: no recorded ${method}`);
  return found.result;
}

/**
 * A language client answering from recorded exchanges. A request is answered by the first exchange
 * not used yet of its method whose parameters are deeply equal; a request the recorder did not send
 * fails the test, except `textDocument/documentSymbol`, which the backend sends before the commands
 * that name no document and which is answered by `symbols` when given.
 */
export class ReplayClient implements Pick<LspClientHandle, 'plainPrinting' | 'request' | 'executeCommand' | 'onDidChangeState' | 'serverUri' | 'documentUri'> {
  readonly sent: { readonly method: string; readonly params: unknown }[] = [];
  private readonly used = new Set<LspExchange>();
  private readonly states = new Emitter<void>();
  readonly onDidChangeState = this.states.event;
  /** The recordings' documents are their real paths already (`${ROOT}` is a `realpath`): sent as they are. */
  readonly serverUri = (uri: vscode.Uri): string => uri.toString();
  readonly documentUri = (value: string): vscode.Uri => FakeUri.parse(value) as unknown as vscode.Uri;

  constructor(
    private readonly exchanges: readonly LspExchange[],
    private readonly symbols?: unknown,
  ) {}

  plainPrinting<T>(_about: vscode.Uri, run: () => Promise<T>): Promise<T> {
    return run();
  }

  request<R>(_about: vscode.Uri, method: string, params: object): Promise<R> {
    this.sent.push({ method, params });
    const found = this.exchanges.find((x) => !this.used.has(x) && x.method === method && isDeepEqual(x.params, params));
    if (found === undefined) {
      if (method === 'textDocument/documentSymbol' && this.symbols !== undefined) {
        return Promise.resolve(this.symbols as R);
      }
      return Promise.reject(new Error(`not recorded: ${method} ${JSON.stringify(params)}`));
    }
    this.used.add(found);
    return found.error === undefined
      ? Promise.resolve(found.result as R)
      : Promise.reject(new IdrisException({ kind: 'ProtocolError', message: found.error.message }));
  }

  executeCommand<C extends LspCommandName>(about: vscode.Uri, command: C, args: LspCommandArguments[C]): Promise<LspCommandResults[C]> {
    return this.request<LspCommandResults[C]>(about, 'workspace/executeCommand', { command, arguments: args });
  }

  /** As the client does when its process starts or stops. */
  fireState(): void {
    this.states.fire();
  }
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b)), a);
    return true;
  } catch {
    return false;
  }
}

class FakeLocation {
  constructor(
    readonly uri: FakeUri,
    readonly range: FakeRange,
  ) {}
}

/** `vscode.Uri` with `file`, as the backend uses it. */
class FakeFileUri extends FakeUri {
  static file(p: string): FakeUri {
    return new FakeUri('file', p, '');
  }
}

/** The `vscode` constructors `LspBackend` takes (`LspBackendApi`). */
export const fakeLspApi = { Uri: FakeFileUri, Range: FakeRange, Location: FakeLocation } as unknown as ConstructorParameters<typeof LspBackend>[0]['api'];

/** A file of `scenario`'s workspace, as the document `${LSP_ROOT}/<relative>` (its text from the fixture). */
export function lspDocument(scenario: string, relative: string): FakeDocument {
  return new FakeDocument(`${LSP_ROOT}/${relative}`, fs.readFileSync(path.join(recordedWorkspace(scenario), relative), 'utf8'));
}

/** `readFile` over `scenario`'s workspace: `${LSP_ROOT}/<relative>` is the fixture's file. */
export function workspaceReader(scenario: string): (p: string) => Promise<string> {
  const workspace = recordedWorkspace(scenario);
  return (p: string) =>
    p.startsWith(`${LSP_ROOT}/`) ? fs.promises.readFile(path.join(workspace, p.slice(LSP_ROOT.length + 1)), 'utf8') : Promise.reject(new Error(`not a fixture: ${p}`));
}

/** An `LspBackend` over `scenario`'s recording (`ReplayClient`), with `maxCodeActionResults` `max`. */
export function replayBackend(scenario: string, options: { readonly symbols?: unknown; readonly max?: number } = {}): { readonly backend: LspBackend; readonly client: ReplayClient } {
  const client = new ReplayClient(lspExchanges(scenario), options.symbols);
  return { backend: backendOver(client, scenario, options.max), client };
}

/** Offset of `p` in `lines` joined with `\n`. */
function offset(lines: readonly string[], p: { readonly line: number; readonly character: number }): number {
  return lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
}

/** `text` (lines joined with `\n`) after `result`'s replacements, which must be an `edit`. */
export function appliedText(text: string, result: EditResult): string {
  assert.strictEqual(result.type, 'edit', JSON.stringify(result));
  const lines = text.split('\n');
  let out = text;
  for (const r of [...(result as Extract<EditResult, { type: 'edit' }>).replacements].sort((a, b) => offset(lines, b.range.start) - offset(lines, a.range.start))) {
    out = out.slice(0, offset(lines, r.range.start)) + r.text + out.slice(offset(lines, r.range.end));
  }
  return out;
}

/** The range the text of `r` takes once applied (what the cycling controller follows). */
export function followed(r: TextReplacement): EditorRange {
  const parts = r.text.split('\n');
  const end =
    parts.length === 1
      ? { line: r.range.start.line, character: r.range.start.character + parts[0].length }
      : { line: r.range.start.line + parts.length - 1, character: parts[parts.length - 1].length };
  return { start: r.range.start, end };
}

/**
 * A language client whose answers a test writes (`answer(method, params)`; `executeCommand` is
 * `workspace/executeCommand` with `{ command, arguments }`), recording what was sent.
 */
export class ScriptedClient implements Pick<LspClientHandle, 'plainPrinting' | 'request' | 'executeCommand' | 'onDidChangeState' | 'serverUri' | 'documentUri'> {
  readonly sent: { readonly method: string; readonly params: unknown }[] = [];
  private readonly states = new Emitter<void>();
  readonly onDidChangeState = this.states.event;
  readonly serverUri = (uri: vscode.Uri): string => uri.toString();
  readonly documentUri = (value: string): vscode.Uri => FakeUri.parse(value) as unknown as vscode.Uri;

  constructor(private readonly answer: (method: string, params: unknown) => unknown) {}

  /** The edits that ran through `plainPrinting`, and each request's place in it. */
  plainRuns = 0;
  plainPrinting<T>(_about: vscode.Uri, run: () => Promise<T>): Promise<T> {
    this.plainRuns++;
    return run();
  }

  request<R>(_about: vscode.Uri, method: string, params: object): Promise<R> {
    this.sent.push({ method, params });
    try {
      return Promise.resolve(this.answer(method, params) as R);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  executeCommand<C extends LspCommandName>(about: vscode.Uri, command: C, args: LspCommandArguments[C]): Promise<LspCommandResults[C]> {
    return this.request<LspCommandResults[C]>(about, 'workspace/executeCommand', { command, arguments: args });
  }

  fireState(): void {
    this.states.fire();
  }
}

/** An `LspBackend` over `client`, reading `scenario`'s workspace, with `maxCodeActionResults` `max`. */
export function backendOver(client: ScriptedClient | ReplayClient, scenario: string, max = 5, readFile?: (p: string) => Promise<string>): LspBackend {
  return new LspBackend({
    client,
    config: { lsp: () => ({ maxCodeActionResults: max }) as ReturnType<ConstructorParameters<typeof LspBackend>[0]['config']['lsp']> },
    api: fakeLspApi,
    readFile: readFile ?? workspaceReader(scenario),
  });
}
