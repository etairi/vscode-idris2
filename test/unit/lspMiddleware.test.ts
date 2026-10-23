// backend/lsp/middleware.ts: which documents reach idris2-lsp (DocumentSync and the hooks), the
// coordinates (the compiler's, from the recordings of test/fixtures/lsp-transcripts), and how the
// server's answers are shown (untrusted text, no commands, quick fixes filtered). No process, no
// `vscode`: the API is a fake.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { Middleware } from 'vscode-languageclient/node';
import { Emitter } from '../../src/core/event';
import { IdrisException } from '../../src/core/errors';
import {
  contentMarkdown,
  createMiddleware,
  documentOf,
  DocumentSync,
  fromServerPosition,
  fromServerRange,
  toEditorTokens,
  toServerCompletionPosition,
  toServerPosition,
  ServerPaths,
  type MiddlewareApi,
  type SyncChannel,
} from '../../src/backend/lsp/middleware';
import type { LspOwnership } from '../../src/backend/lsp/types';
import { codeBlock } from '../../src/core/untrustedText';
import { repoRoot } from '../fake-tools/paths';
import { FakeDocument, FakePosition, FakeRange, FakeUri, fixtureDocument, quietLog, settle } from './support/intelligence';

// -------------------------------------------------------------------------------------------
// Recordings
// -------------------------------------------------------------------------------------------

const TRANSCRIPTS = path.join(repoRoot(), 'test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a');

interface Recorded {
  readonly kind: string;
  readonly text?: string;
}

function recorded(scenario: string): Recorded[] {
  return fs
    .readFileSync(path.join(TRANSCRIPTS, `${scenario}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Recorded);
}

/** The result of the response to the request of `scenario` whose sent text contains `request` (the first one). */
function recordedResult(scenario: string, request: string): unknown {
  const events = recorded(scenario);
  const sent = events.find((e) => e.kind === 'send' && e.text?.includes(request));
  assert.ok(sent?.text, `no request ${request} in ${scenario}`);
  const id = (JSON.parse(sent.text) as { id: number }).id;
  const answer = events.find((e) => e.kind === 'recv' && e.text !== undefined && (JSON.parse(e.text) as { id?: number }).id === id && !e.text.includes('"method"'));
  assert.ok(answer?.text);
  return (JSON.parse(answer.text) as { result: unknown }).result;
}

const LIT2 = 'test/fixtures/workspaces/lsp-ipkg/src/Lit2.lidr';

// -------------------------------------------------------------------------------------------
// A fake of the VS Code API the middleware uses
// -------------------------------------------------------------------------------------------

class FakeMarkdown {
  value = '';
  isTrusted: boolean | undefined = undefined;
  supportHtml: boolean | undefined = undefined;
  supportThemeIcons: boolean | undefined = undefined;
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
}

class FakeHover {
  constructor(
    readonly contents: unknown,
    readonly range?: FakeRange,
  ) {}
}

class FakeLocation {
  constructor(
    readonly uri: { toString(): string },
    readonly range: FakeRange,
  ) {}
}

class FakeDiagnostic {
  source: string | undefined;
  code: unknown;
  tags: unknown;
  relatedInformation: unknown;
  constructor(
    readonly range: FakeRange,
    readonly message: string,
    readonly severity?: number,
  ) {}
}

class FakeRelated {
  constructor(
    readonly location: FakeLocation,
    readonly message: string,
  ) {}
}

class FakeHighlight {
  constructor(
    readonly range: FakeRange,
    readonly kind?: number,
  ) {}
}

class FakeSymbol {
  constructor(
    readonly name: string,
    readonly kind: number,
    readonly containerName: string,
    readonly location: FakeLocation,
  ) {}
}

class FakeTokens {
  constructor(
    readonly data: Uint32Array,
    readonly resultId?: string,
  ) {}
}

class FakeSignatureHelp {
  signatures: FakeSignature[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

class FakeSignature {
  parameters: unknown[] = [];
  constructor(
    readonly label: string,
    readonly documentation?: unknown,
  ) {}
}

class FakeParameter {
  constructor(
    readonly label: unknown,
    readonly documentation?: unknown,
  ) {}
}

class FakeCompletionItem {
  insertText: unknown;
  filterText: string | undefined;
  sortText: string | undefined;
  detail: string | undefined;
  documentation: unknown;
  command: unknown;
  additionalTextEdits: unknown;
  range: unknown;
  constructor(
    readonly label: string | { label: string },
    readonly kind?: number,
  ) {}
}

class FakeCompletionList {
  constructor(
    readonly items: FakeCompletionItem[],
    readonly isIncomplete?: boolean,
  ) {}
}

class FakeKind {
  static readonly QuickFix = new FakeKind('quickfix');
  static readonly Refactor = new FakeKind('refactor');
  constructor(readonly value: string) {}
  contains(other: FakeKind): boolean {
    return this.value === other.value || other.value.startsWith(`${this.value}.`);
  }
  intersects(other: FakeKind): boolean {
    return this.contains(other) || other.contains(this);
  }
}

class FakeCodeAction {
  diagnostics: FakeDiagnostic[] | undefined;
  isPreferred: boolean | undefined;
  edit: FakeEdit | undefined;
  command: unknown;
  constructor(
    readonly title: string,
    readonly kind?: FakeKind,
  ) {}
}

class FakeEdit {
  readonly edits: [{ toString(): string }, { range: FakeRange; newText: string }[]][] = [];
  replace(uri: { toString(): string }, range: FakeRange, newText: string): void {
    const entry = this.edits.find(([u]) => u.toString() === uri.toString());
    if (entry === undefined) {
      this.edits.push([uri, [{ range, newText }]]);
    } else {
      entry[1].push({ range, newText });
    }
  }
  entries(): [{ toString(): string }, { range: FakeRange; newText: string }[]][] {
    return this.edits;
  }
}

class FakeCancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

function fakeApi(docs: FakeDocument[] = []): MiddlewareApi {
  return {
    MarkdownString: FakeMarkdown,
    Hover: FakeHover,
    Position: FakePosition,
    Range: FakeRange,
    Location: FakeLocation,
    Diagnostic: FakeDiagnostic,
    DiagnosticRelatedInformation: FakeRelated,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    DocumentHighlight: FakeHighlight,
    SymbolInformation: FakeSymbol,
    SemanticTokens: FakeTokens,
    SignatureHelp: FakeSignatureHelp,
    SignatureInformation: FakeSignature,
    ParameterInformation: FakeParameter,
    CompletionItem: FakeCompletionItem,
    CompletionList: FakeCompletionList,
    CodeAction: FakeCodeAction,
    CodeActionKind: FakeKind,
    WorkspaceEdit: FakeEdit,
    CancellationError: FakeCancellationError,
    workspace: { textDocuments: docs },
  } as unknown as MiddlewareApi;
}

const r = (sl: number, sc: number, el: number, ec: number): FakeRange => new FakeRange(sl, sc, el, ec);
const asDoc = (doc: FakeDocument): vscode.TextDocument => doc as unknown as vscode.TextDocument;
const asUri = (doc: FakeDocument): vscode.Uri => doc.uri as unknown as vscode.Uri;

/** An ownership that admits the URIs of `admitted` (changed by the test). */
class FakeOwnership implements LspOwnership {
  readonly admitted = new Set<string>();
  readonly asked: string[] = [];
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  async admits(uri: vscode.Uri): Promise<boolean> {
    this.asked.push(uri.toString());
    await settle();
    return this.admitted.has(uri.toString());
  }
}

/** What a sync sent, in order. */
class FakeChannel implements SyncChannel {
  readonly sent: string[] = [];
  readonly cleared: string[] = [];
  async open(doc: vscode.TextDocument): Promise<void> {
    this.sent.push(`open ${doc.uri.toString()}`);
  }
  async change(doc: vscode.TextDocument): Promise<void> {
    this.sent.push(`change ${doc.uri.toString()} v${doc.version} ${JSON.stringify(doc.getText())}`);
  }
  async save(doc: vscode.TextDocument): Promise<void> {
    this.sent.push(`save ${doc.uri.toString()}`);
  }
  async close(doc: vscode.TextDocument): Promise<void> {
    this.sent.push(`close ${doc.uri.toString()}`);
  }
  clearDiagnostics(uri: vscode.Uri): void {
    this.cleared.push(uri.toString());
  }
}

interface Setup {
  readonly ownership: FakeOwnership;
  readonly sync: DocumentSync;
  readonly channel: FakeChannel;
  readonly middleware: Middleware;
  readonly doc: FakeDocument;
  /** The library's `next` of the text sync: records what it would send. */
  readonly next: (label: string) => (doc: vscode.TextDocument) => Promise<void>;
}

/** A middleware with `doc` open in the editor; `served` admits it and opens it in the sync. */
async function setup(
  doc: FakeDocument,
  options: {
    served?: boolean;
    readText?: (f: string) => Promise<string | undefined>;
    docs?: FakeDocument[];
    published?: (uri: vscode.Uri, failed: boolean) => void;
  } = {},
): Promise<Setup> {
  const ownership = new FakeOwnership();
  const sync = new DocumentSync(ownership, quietLog);
  const channel = new FakeChannel();
  sync.attach(channel);
  const middleware = createMiddleware({
    api: fakeApi(options.docs ?? [doc]),
    sync,
    readText: options.readText ?? (async () => undefined),
    log: quietLog,
    ...(options.published === undefined ? {} : { published: options.published }),
  });
  const next =
    (label: string) =>
    async (d: vscode.TextDocument): Promise<void> => {
      channel.sent.push(`${label} ${d.uri.toString()}`);
    };
  if (options.served !== false) {
    ownership.admitted.add(doc.uri.toString());
    await sync.didOpen(asDoc(doc), next('didOpen'));
  }
  return { ownership, sync, channel, middleware, doc, next };
}

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken;

// -------------------------------------------------------------------------------------------
// Coordinates
// -------------------------------------------------------------------------------------------

suite('backend/lsp/middleware: coordinates', () => {
  test('a bird-track file: unlit columns, and the line below a line of "> " and spaces shifted by one (E1, recording lit2)', () => {
    const doc = fixtureDocument(LIT2);
    // File line 16 is "> half : Nat -> Nat", below the "> " of line 15; the recorder asked about
    // Nat at {17, 7} and the server answered `Prelude.Nat : Type`.
    assert.strictEqual(doc.lineAt(16).text, '> half : Nat -> Nat');
    assert.deepStrictEqual(toServerPosition(doc, { line: 16, character: 9 }), { line: 17, character: 7 });
    // Above the doubled line the line is the file's, the column unlit: xs at {8, 5}.
    assert.deepStrictEqual(toServerPosition(doc, { line: 8, character: 7 }), { line: 8, character: 5 });
    // A prose line has no server position.
    assert.strictEqual(toServerPosition(doc, { line: 4, character: 3 }), undefined);
    // metavars located half_rhs at {18,9}-{18,18}: the file's line 17, after "> ".
    const metavars = recordedResult('lit2', '"metavars"') as { name: string; location: { range: { start: { line: number; character: number }; end: { line: number; character: number } } } }[];
    const half = metavars.find((m) => m.name === 'Lit2.half_rhs');
    assert.ok(half);
    const shown = fromServerRange(doc, half.location.range);
    assert.deepStrictEqual(shown, { start: { line: 17, character: 11 }, end: { line: 17, character: 20 } });
    assert.strictEqual(doc.lineAt(17).text.slice(shown.start.character, shown.end.character), '?half_rhs');
  });

  test('columns count code points: a character outside the BMP is one column to the server, two to the editor', () => {
    const doc = new FakeDocument('/p/src/A.idr', 'module A\nf : String\nf = "\u{1D55F}\u{1D55F}" ++ x\n');
    assert.deepStrictEqual(toServerPosition(doc, { line: 2, character: 14 }), { line: 2, character: 12 });
    assert.deepStrictEqual(fromServerPosition(doc, { line: 2, character: 12 }), { line: 2, character: 14 });
    // Completion reads the raw line: code points, the file's line, no literate offset.
    assert.deepStrictEqual(toServerCompletionPosition(doc, { line: 2, character: 14 }), { line: 2, character: 12 });
    assert.deepStrictEqual(toServerCompletionPosition(fixtureDocument(LIT2), { line: 16, character: 9 }), { line: 16, character: 9 });
  });

  test('semantic tokens of a bird-track file move to the file\'s lines and columns (recording lit2)', () => {
    const doc = fixtureDocument(LIT2);
    const data = Uint32Array.from((recordedResult('lit2', 'semanticTokens/full') as { data: number[] }).data);
    const decode = (encoded: Uint32Array): [number, number, number][] => {
      const out: [number, number, number][] = [];
      let line = 0;
      let character = 0;
      for (let i = 0; i < encoded.length; i += 5) {
        character = encoded[i] === 0 ? character + encoded[i + 1] : encoded[i + 1];
        line += encoded[i];
        out.push([line, character, encoded[i + 2]]);
      }
      return out;
    };
    const server = decode(data);
    const shown = decode(toEditorTokens(doc, data));
    assert.strictEqual(shown.length, server.length);
    // `half` of the type declaration: the server's {17, 0}, the file's line 16 after "> ".
    assert.ok(server.some(([l, c, n]) => l === 17 && c === 0 && n === 4));
    assert.ok(shown.some(([l, c, n]) => l === 16 && c === 2 && n === 4));
    for (const [line, character, length] of shown) {
      assert.strictEqual(doc.lineAt(line).text.startsWith('>'), true, `token on prose line ${line}`);
      assert.ok(character >= 2 && character + length <= doc.lineAt(line).text.length);
    }
  });

  test('a token on the extra line of a doubled bird-track line, or out of order, is left out', () => {
    const doc = new FakeDocument('/p/src/L.lidr', '> module L\n> \n> x : Nat\n');
    // Compiler line 2 is the extra line of file line 1; compiler line 3 is file line 2.
    const out = toEditorTokens(doc, Uint32Array.from([2, 0, 1, 0, 0, 1, 0, 1, 0, 0]));
    assert.deepStrictEqual([...out], [2, 2, 1, 0, 0]);
  });
});

// -------------------------------------------------------------------------------------------
// Untrusted text
// -------------------------------------------------------------------------------------------

suite('backend/lsp/middleware: paths', () => {
  // The server refuses a file whose path is not below the physical path of its working directory
  // (ServerPaths; packaged-extension check, 2026-10-02: a workspace under /tmp, which is /private/tmp).
  const uris = { file: (p: string) => new FakeUri('file', p, ''), parse: (v: string) => FakeUri.parse(v) } as unknown as Pick<typeof vscode.Uri, 'file' | 'parse'>;
  const real = (dir: string): string | undefined => (dir.startsWith('/tmp/') ? `/private${dir}` : dir.startsWith('/gone') ? undefined : dir);
  const asVscode = (u: FakeUri): vscode.Uri => u as unknown as vscode.Uri;

  test('a file is sent as the real path of its folder joined with its name, and the server\'s URI maps back to the document', () => {
    const paths = new ServerPaths(real, uris, 'darwin');
    const doc = new FakeUri('file', '/tmp/w/src/A.idr', '');
    assert.strictEqual(paths.toServer(asVscode(doc)), 'file:///private/tmp/w/src/A.idr');
    assert.strictEqual(paths.fromServer('file:///private/tmp/w/src/A.idr').toString(), 'file:///tmp/w/src/A.idr');
    assert.strictEqual(paths.documentKey('file:///private/tmp/w/src/A.idr'), 'file:///tmp/w/src/A.idr');
    // A URI never sent (a definition in an installed package) stays as it is.
    assert.strictEqual(paths.fromServer('file:///opt/pack/Prelude/Types.idr').toString(), 'file:///opt/pack/Prelude/Types.idr');
    // A real path already, a folder that cannot be resolved, another scheme, Windows: as they are.
    assert.strictEqual(paths.toServer(asVscode(new FakeUri('file', '/w/src/B.idr', ''))), 'file:///w/src/B.idr');
    assert.strictEqual(paths.toServer(asVscode(new FakeUri('file', '/gone/C.idr', ''))), 'file:///gone/C.idr');
    assert.strictEqual(paths.toServer(asVscode(new FakeUri('untitled', 'Untitled-1', ''))), 'untitled:Untitled-1');
    assert.strictEqual(new ServerPaths(real, uris, 'win32').toServer(asVscode(doc)), 'file:///tmp/w/src/A.idr');
  });

  test('the last check reads a converted parameter as its document: a request naming the server\'s URI of an open document passes', async () => {
    const doc = new FakeDocument('/tmp/w/src/A.idr', 'module A\n');
    const paths = new ServerPaths(real, uris, 'darwin');
    const ownership = new FakeOwnership();
    ownership.admitted.add(doc.uri.toString());
    const sync = new DocumentSync(ownership, quietLog);
    sync.attach(new FakeChannel());
    await sync.didOpen(asDoc(doc), async () => undefined);
    const middleware = createMiddleware({ api: fakeApi([doc]), sync, readText: async () => undefined, log: quietLog, documentKey: (u) => paths.documentKey(u) });
    const server = paths.toServer(doc.uri as unknown as vscode.Uri);
    assert.strictEqual(await middleware.sendRequest?.('textDocument/hover', { textDocument: { uri: server } }, undefined, async () => 'answered'), 'answered');
    const sent: string[] = [];
    await middleware.sendNotification?.('textDocument/didChange', async () => void sent.push('sent'), { textDocument: { uri: server } });
    assert.deepStrictEqual(sent, ['sent']);
  });
});

suite('backend/lsp/middleware: untrusted text', () => {
  test("the server's hover (a fence of idris around the type) becomes an idris2 code block of the type", () => {
    const hover = (recordedResult('dirty', '"textDocument/hover"') as { contents: { value: string } }).contents.value;
    assert.strictEqual(hover, '```idris\nxs : Vect ?_ ?_\n```');
    assert.strictEqual(contentMarkdown(new FakeMarkdown(hover) as unknown as vscode.MarkdownString), codeBlock('xs : Vect ?_ ?_', 'idris2'));
  });

  test('a type that holds a fence cannot close the block; controls are written out; other markdown is shown as text', () => {
    const tricky = '```idris\nf : String\n```\n[x](command:evil)\n‮\n```';
    const md = contentMarkdown(new FakeMarkdown(tricky) as unknown as vscode.MarkdownString);
    assert.strictEqual(md, codeBlock('f : String\n```\n[x](command:evil)\n\\u{202E}', 'idris2'));
    assert.ok(md.startsWith('\n````idris2\n'));
    assert.strictEqual(contentMarkdown(new FakeMarkdown('**bold** <b>x</b>') as unknown as vscode.MarkdownString), codeBlock('**bold** <b>x</b>', 'text'));
    assert.strictEqual(contentMarkdown('plain'), codeBlock('plain', 'text'));
    assert.strictEqual(contentMarkdown({ language: 'idris', value: 'n : Nat' }), codeBlock('n : Nat', 'idris2'));
  });

  test('hover: an untrusted MarkdownString without HTML or icons, its range in editor coordinates, asked at the server\'s position', async () => {
    const doc = fixtureDocument(LIT2);
    const { middleware } = await setup(doc);
    let asked: FakePosition | undefined;
    const hover = (await middleware.provideHover?.(asDoc(doc), new FakePosition(16, 9) as unknown as vscode.Position, token, (_d, pos) => {
      asked = pos as unknown as FakePosition;
      return new FakeHover([new FakeMarkdown('```idris\nPrelude.Nat : Type\n```')], r(17, 7, 17, 10)) as unknown as vscode.Hover;
    })) as unknown as FakeHover;
    assert.deepStrictEqual(asked, new FakePosition(17, 7));
    const md = hover.contents as FakeMarkdown;
    assert.strictEqual(md.isTrusted, false);
    assert.strictEqual(md.supportHtml, false);
    assert.strictEqual(md.supportThemeIcons, false);
    assert.strictEqual(md.value, codeBlock('Prelude.Nat : Type', 'idris2'));
    assert.deepStrictEqual(hover.range, r(16, 9, 16, 12));
  });

  test('completion: labels and details drawn as compiler text in a list, filterText and insertText the server\'s, no command or extra edits', async () => {
    const doc = new FakeDocument('/p/src/B.idr', 'module B\nx = sho\n');
    const { middleware } = await setup(doc);
    const item = new FakeCompletionItem('Foo.A.$(zap)shout‮');
    item.insertText = '(shout ?shout_arg_0)';
    item.detail = 'String -> String';
    item.documentation = '  Visibility: export​';
    item.command = { command: 'workbench.action.terminal.sendSequence', title: 'x' };
    item.additionalTextEdits = [{}];
    const list = (await middleware.provideCompletionItem?.(
      asDoc(doc),
      new FakePosition(1, 7) as unknown as vscode.Position,
      { triggerKind: 0, triggerCharacter: undefined } as vscode.CompletionContext,
      token,
      () => new FakeCompletionList([item], true) as unknown as vscode.CompletionList,
    )) as unknown as FakeCompletionList;
    assert.strictEqual(list.isIncomplete, true);
    const shown = list.items[0];
    assert.strictEqual(shown.label, 'Foo.A.$​(zap)shout\\u{202E}');
    assert.strictEqual(shown.filterText, 'Foo.A.$(zap)shout‮');
    assert.strictEqual(shown.insertText, '(shout ?shout_arg_0)');
    assert.strictEqual(shown.detail, 'String -> String');
    assert.strictEqual(shown.documentation, '  Visibility: export\\u{200B}');
    assert.strictEqual(shown.command, undefined);
    assert.strictEqual(shown.additionalTextEdits, undefined);
  });

  test('signature help: label and documentation with their controls written out (recording plain: a plain string with 𝕟)', async () => {
    const doc = new FakeDocument('/p/src/Plain.idr', 'module Plain\n\nf : Nat -> Nat\nf n = n\nx = f 1\n');
    const { middleware } = await setup(doc);
    const recordedHelp = recordedResult('plain', 'textDocument/signatureHelp') as { signatures: { label: string; documentation: string }[] };
    const signature = new FakeSignature(recordedHelp.signatures[0].label, `${recordedHelp.signatures[0].documentation}⁦`);
    const help = new FakeSignatureHelp();
    help.signatures = [signature];
    const shown = (await middleware.provideSignatureHelp?.(
      asDoc(doc),
      new FakePosition(4, 4) as unknown as vscode.Position,
      {} as vscode.SignatureHelpContext,
      token,
      () => help as unknown as vscode.SignatureHelp,
    )) as unknown as FakeSignatureHelp;
    assert.strictEqual(shown.signatures[0].label, 'Plain.f');
    assert.ok(String(shown.signatures[0].documentation).includes('The identity on \u{1D55F} → \u{1D55F}'));
    assert.ok(String(shown.signatures[0].documentation).endsWith('\\u{2066}'));
  });
});

// -------------------------------------------------------------------------------------------
// Ownership
// -------------------------------------------------------------------------------------------

suite('backend/lsp/middleware: ownership', () => {
  test('didOpen reaches the server only for an admitted document (the consent check before didOpen)', async () => {
    const doc = new FakeDocument('/outside/src/A.idr', 'module A\n');
    const { sync, channel, ownership, next } = await setup(doc, { served: false });
    await sync.didOpen(asDoc(doc), next('didOpen'));
    assert.deepStrictEqual(channel.sent, []);
    assert.deepStrictEqual(ownership.asked, [doc.uri.toString()]);
    assert.strictEqual(sync.isOpen(asUri(doc)), false);
    // Not open: its changes, saves and closing are not sent either.
    await sync.didChange(asDoc(doc));
    await sync.didSave(asDoc(doc), next('didSave'));
    await sync.didClose(asDoc(doc), next('didClose'));
    assert.deepStrictEqual(channel.sent, []);
    ownership.admitted.add(doc.uri.toString());
    await sync.didOpen(asDoc(doc), next('didOpen'));
    assert.deepStrictEqual(channel.sent, [`didOpen ${doc.uri.toString()}`]);
    assert.strictEqual(sync.isOpen(asUri(doc)), true);
  });

  test('changes are sent as the whole text once for the changes queued, after the didOpen that waits for admits', async () => {
    const doc = new FakeDocument('/p/src/A.idr', 'module A\n');
    const { sync, channel, ownership, next } = await setup(doc, { served: false });
    ownership.admitted.add(doc.uri.toString());
    const opening = sync.didOpen(asDoc(doc), next('didOpen'));
    doc.edit('module A\n-- 1\n');
    const first = sync.didChange(asDoc(doc));
    doc.edit('module A\n-- 12\n');
    const second = sync.didChange(asDoc(doc));
    await Promise.all([opening, first, second]);
    assert.deepStrictEqual(channel.sent, [`didOpen ${doc.uri.toString()}`, `change ${doc.uri.toString()} v3 "module A\\n-- 12\\n"`]);
  });

  test('didSave needs the document admitted still; didClose is sent for an open document and closes it', async () => {
    const doc = new FakeDocument('/p/src/A.idr', 'module A\n');
    const { sync, channel, ownership, next } = await setup(doc);
    ownership.admitted.clear();
    await sync.didSave(asDoc(doc), next('didSave'));
    assert.deepStrictEqual(channel.sent, [`didOpen ${doc.uri.toString()}`]);
    await sync.didClose(asDoc(doc), next('didClose'));
    assert.deepStrictEqual(channel.sent, [`didOpen ${doc.uri.toString()}`, `didClose ${doc.uri.toString()}`]);
    assert.strictEqual(sync.isOpen(asUri(doc)), false);
  });

  test("the library's held-back didOpen, sent from inside the send of the same document's open, is queued, not waited for (no deadlock)", async () => {
    // vscode-languageclient sends the didOpen it held back for a document not visible at its start
    // before any notification, also before reconcile's own didOpen of that document (DocumentSync,
    // *The library's held-back opens*).
    const doc = new FakeDocument('/p/src/A.idr', 'module A\n');
    const ownership = new FakeOwnership();
    ownership.admitted.add(doc.uri.toString());
    const sync = new DocumentSync(ownership, quietLog);
    const channel = new FakeChannel();
    const libraryOpen = async (d: vscode.TextDocument): Promise<void> => void channel.sent.push(`didOpen ${d.uri.toString()}`);
    channel.open = async (d: vscode.TextDocument): Promise<void> => {
      await sync.didOpen(d, libraryOpen);
      channel.sent.push(`open ${d.uri.toString()}`);
    };
    sync.attach(channel);
    const done = Promise.race([
      sync.reconcile([asDoc(doc)]).then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('deadlock'), 1000)),
    ]);
    assert.strictEqual(await done, 'done');
    await sync.settled(asUri(doc));
    assert.deepStrictEqual(channel.sent, [`open ${doc.uri.toString()}`], 'opened once, by reconcile');
    assert.strictEqual(sync.isOpen(asUri(doc)), true);
  });

  test('clean again without a save (an undo back to the saved text): didSave, once; not while VS Code saves it, nor for a document never changed', async () => {
    const doc = new FakeDocument('/p/src/A.idr', 'module A\n');
    const { sync, channel, next } = await setup(doc);
    const uri = doc.uri.toString();
    // A document never changed on the server: nothing.
    sync.stateChanged(asDoc(doc));
    await settle();
    await sync.settled(asUri(doc));
    assert.deepStrictEqual(channel.sent, [`didOpen ${uri}`]);
    // A change, then an undo back to the saved text: the change, then a save.
    doc.edit('module A\n-- x\n');
    await sync.didChange(asDoc(doc));
    doc.edit('module A\n', true);
    const undo = sync.didChange(asDoc(doc));
    sync.stateChanged(asDoc(doc));
    await undo;
    await settle();
    await sync.settled(asUri(doc));
    assert.deepStrictEqual(channel.sent.slice(1), [`change ${uri} v2 "module A\\n-- x\\n"`, `change ${uri} v3 "module A\\n"`, `save ${uri}`]);
    sync.stateChanged(asDoc(doc));
    await settle();
    await sync.settled(asUri(doc));
    assert.strictEqual(channel.sent.filter((m) => m.startsWith('save')).length, 1, 'once');
    // A change saved by VS Code: its own didSave, no second one.
    doc.edit('module A\n-- y\n');
    await sync.didChange(asDoc(doc));
    sync.willSave(asDoc(doc));
    doc.edit('module A\n-- y\n', true);
    sync.stateChanged(asDoc(doc));
    await settle();
    await sync.didSave(asDoc(doc), next('didSave'));
    await settle();
    await sync.settled(asUri(doc));
    assert.deepStrictEqual(channel.sent.slice(4), [`change ${uri} v4 "module A\\n-- y\\n"`, `didSave ${uri}`]);
    // Saved: a later event of the clean document sends nothing.
    sync.stateChanged(asDoc(doc));
    await settle();
    await sync.settled(asUri(doc));
    assert.deepStrictEqual(channel.sent.slice(4), [`change ${uri} v4 "module A\\n-- y\\n"`, `didSave ${uri}`]);
  });

  test('reconcile opens what became admitted and closes what is not admitted any more, clearing its diagnostics', async () => {
    const a = new FakeDocument('/p/src/A.idr', 'module A\n');
    const b = new FakeDocument('/p/src/B.idr', 'module B\n');
    const { sync, channel, ownership } = await setup(a);
    ownership.admitted.delete(a.uri.toString());
    ownership.admitted.add(b.uri.toString());
    await sync.reconcile([asDoc(a), asDoc(b)]);
    assert.deepStrictEqual(channel.sent.slice(1), [`close ${a.uri.toString()}`, `open ${b.uri.toString()}`]);
    assert.deepStrictEqual(channel.cleared, [a.uri.toString()]);
    assert.strictEqual(sync.isOpen(asUri(a)), false);
    assert.strictEqual(sync.isOpen(asUri(b)), true);
  });

  test('a new client starts afresh: nothing is open, and work queued for the old one does nothing', async () => {
    const doc = new FakeDocument('/p/src/A.idr', 'module A\n');
    const { sync, channel } = await setup(doc);
    const late = sync.didChange(asDoc(doc));
    const fresh = new FakeChannel();
    sync.attach(fresh);
    await late;
    assert.strictEqual(sync.isOpen(asUri(doc)), false);
    assert.deepStrictEqual(fresh.sent, []);
    assert.deepStrictEqual(channel.sent, [`didOpen ${doc.uri.toString()}`]);
    sync.detach();
    await sync.reconcile([asDoc(doc)]);
    assert.deepStrictEqual(fresh.sent, []);
  });

  for (const [what, opened] of [
    ['not opened', false],
    ['open but not admitted any more (before reconcile closes it)', true],
  ] as const) {
    test(`every provider hook answers nothing, without asking the server, for a document ${what}`, async () => {
      const doc = new FakeDocument('/p/src/A.idr', 'module A\nx = 1\n');
      const { middleware, ownership } = await setup(doc, { served: opened });
      ownership.admitted.clear();
      const pos = new FakePosition(1, 0) as unknown as vscode.Position;
      const asked: string[] = [];
      const next =
        (name: string) =>
        (): never => {
          asked.push(name);
          throw new Error(`${name} asked the server`);
        };
      assert.strictEqual(await middleware.provideHover?.(asDoc(doc), pos, token, next('hover')), undefined);
      assert.strictEqual(await middleware.provideCompletionItem?.(asDoc(doc), pos, {} as vscode.CompletionContext, token, next('completion')), undefined);
      assert.strictEqual(await middleware.provideSignatureHelp?.(asDoc(doc), pos, {} as vscode.SignatureHelpContext, token, next('signature')), undefined);
      assert.strictEqual(await middleware.provideDefinition?.(asDoc(doc), pos, token, next('definition')), undefined);
      assert.deepStrictEqual(await middleware.provideDocumentHighlights?.(asDoc(doc), pos, token, next('highlights')), []);
      assert.deepStrictEqual(await middleware.provideDocumentSymbols?.(asDoc(doc), token, next('symbols')), []);
      assert.strictEqual(await middleware.provideDocumentSemanticTokens?.(asDoc(doc), token, next('tokens')), undefined);
      const context = { diagnostics: [new FakeDiagnostic(r(1, 0, 1, 1), 'x')], triggerKind: 1 } as unknown as vscode.CodeActionContext;
      assert.deepStrictEqual(await middleware.provideCodeActions?.(asDoc(doc), r(1, 0, 1, 0) as unknown as vscode.Range, context, token, next('codeActions')), []);
      assert.deepStrictEqual(asked, []);
    });
  }

  test('the last check: a textDocument notification passes only for a document the sync opened, a request naming one only while admitted', async () => {
    const doc = new FakeDocument('/p/src/A.idr', 'module A\n');
    const other = new FakeDocument('/elsewhere/B.idr', 'module B\n');
    const { middleware, ownership } = await setup(doc);
    const sent: string[] = [];
    const notify = async (method: string, uri: string): Promise<void> =>
      middleware.sendNotification?.(method, async () => void sent.push(`${method} ${uri}`), { textDocument: { uri } });
    await notify('textDocument/didChange', doc.uri.toString());
    await notify('textDocument/didChange', other.uri.toString());
    await notify('textDocument/didOpen', other.uri.toString());
    await notify('textDocument/didSave', other.uri.toString());
    await middleware.sendNotification?.('workspace/didChangeConfiguration', async () => void sent.push('config'), { settings: {} });
    assert.deepStrictEqual(sent, [`textDocument/didChange ${doc.uri.toString()}`, 'config']);

    const request = (params: unknown): Promise<unknown> =>
      Promise.resolve(middleware.sendRequest?.('textDocument/hover', params, undefined, async () => 'answered'));
    assert.strictEqual(await request({ textDocument: { uri: doc.uri.toString() } }), 'answered');
    await assert.rejects(request({ textDocument: { uri: other.uri.toString() } }), (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported');
    const command = { command: 'exprSearchWithHints', arguments: [{ codeAction: { textDocument: { uri: other.uri.toString() } }, hints: [] }] };
    await assert.rejects(request(command), IdrisException);
    assert.strictEqual(await request({ command: 'metavars', arguments: [] }), 'answered');
    ownership.admitted.clear();
    await assert.rejects(request({ textDocument: { uri: doc.uri.toString() } }), IdrisException);
  });

  test('the didClose the sync sends passes the last check (reconcile\'s, and the library\'s through didClose); one for another document does not', async () => {
    // Integration, 2026-10-02: the sync forgot the document before sending its didClose, and the hook refused it.
    const a = new FakeDocument('/p/src/A.idr', 'module A\n');
    const b = new FakeDocument('/p/src/B.idr', 'module B\n');
    const { middleware, ownership, sync, channel } = await setup(a, { docs: [a, b] });
    ownership.admitted.add(b.uri.toString());
    await sync.didOpen(asDoc(b), async () => undefined);
    const passed: string[] = [];
    const viaHook = async (uri: string): Promise<void> =>
      middleware.sendNotification?.('textDocument/didClose', async () => void passed.push(uri), { textDocument: { uri } });
    channel.close = (d: vscode.TextDocument) => viaHook(d.uri.toString());
    ownership.admitted.delete(a.uri.toString());
    await sync.reconcile([asDoc(a)]);
    await sync.didClose(asDoc(b), (d) => viaHook(d.uri.toString()));
    await viaHook('file:///p/src/Other.idr');
    assert.deepStrictEqual(passed, [a.uri.toString(), b.uri.toString()]);
    assert.strictEqual(sync.isOpen(asUri(a)), false);
    assert.strictEqual(sync.isOpen(asUri(b)), false);
    // Once closed, a later didClose of it is refused.
    await viaHook(a.uri.toString());
    assert.deepStrictEqual(passed, [a.uri.toString(), b.uri.toString()]);
  });

  test('documentOf finds the document of a request, also inside executeCommand\'s codeAction argument', () => {
    assert.strictEqual(documentOf({ textDocument: { uri: 'file:///a' } }), 'file:///a');
    assert.strictEqual(documentOf({ command: 'refineHole', arguments: [{ codeAction: { textDocument: { uri: 'file:///b' } }, hint: 'x' }] }), 'file:///b');
    assert.strictEqual(documentOf({ command: 'repl', arguments: ['1'] }), undefined);
    assert.strictEqual(documentOf(undefined), undefined);
  });
});

// -------------------------------------------------------------------------------------------
// Answers
// -------------------------------------------------------------------------------------------

suite('backend/lsp/middleware: answers', () => {
  test('diagnostics: moved to the editor\'s coordinates for an open document, dropped (cleared) for any other; a load reported for the open one only', async () => {
    const doc = fixtureDocument(LIT2);
    const loads: [string, boolean][] = [];
    const { middleware } = await setup(doc, { published: (uri, failed) => void loads.push([uri.toString(), failed]) });
    const delivered: [string, FakeDiagnostic[]][] = [];
    const next = (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void => void delivered.push([uri.toString(), diagnostics as unknown as FakeDiagnostic[]]);
    const d = new FakeDiagnostic(r(17, 0, 17, 4), 'half is not covering.', 0);
    d.source = 'idris2';
    d.code = { value: 'x', target: 'command:evil' };
    middleware.handleDiagnostics?.(doc.uri as unknown as vscode.Uri, [d as unknown as vscode.Diagnostic], next);
    const shown = delivered[0][1][0];
    assert.deepStrictEqual(shown.range, r(16, 2, 16, 6));
    assert.strictEqual(shown.message, 'half is not covering.');
    assert.strictEqual(shown.source, 'idris2');
    assert.strictEqual(shown.code, undefined);
    const other = { toString: () => 'file:///elsewhere/B.idr', scheme: 'file', fsPath: '/elsewhere/B.idr' };
    middleware.handleDiagnostics?.(other as unknown as vscode.Uri, [d as unknown as vscode.Diagnostic], next);
    assert.deepStrictEqual(delivered[1], ['file:///elsewhere/B.idr', []]);
    // The holes model follows the server's loads (client.ts onDidLoad): failed when an error is published.
    middleware.handleDiagnostics?.(doc.uri as unknown as vscode.Uri, [new FakeDiagnostic(r(0, 0, 0, 1), 'a warning', 1) as unknown as vscode.Diagnostic], next);
    middleware.handleDiagnostics?.(doc.uri as unknown as vscode.Uri, [], next);
    assert.deepStrictEqual(loads, [
      [doc.uri.toString(), true],
      [doc.uri.toString(), false],
      [doc.uri.toString(), false],
    ]);
  });

  test('definition: a location in another file is moved with that file\'s text on disk', async () => {
    const doc = new FakeDocument('/p/src/A.idr', 'module A\nx = f\n');
    const target = { toString: () => 'file:///p/src/B.idr', scheme: 'file', fsPath: '/p/src/B.idr' };
    const { middleware } = await setup(doc, { readText: async (f) => (f === '/p/src/B.idr' ? 'module B\nf : String\nf = "\u{1D55F}" ++ g\n' : undefined) });
    const found = (await middleware.provideDefinition?.(asDoc(doc), new FakePosition(1, 4) as unknown as vscode.Position, token, () =>
      new FakeLocation(target, r(2, 10, 2, 11)) as unknown as vscode.Location,
    )) as unknown as FakeLocation[];
    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(found[0].range, r(2, 11, 2, 12));
  });

  test('symbols: names drawn as compiler text, locations of this document moved; highlights moved', async () => {
    const doc = fixtureDocument(LIT2);
    const { middleware } = await setup(doc);
    const symbols = (await middleware.provideDocumentSymbols?.(asDoc(doc), token, () => [
      new FakeSymbol('half‮', 12, '', new FakeLocation(doc.uri, r(17, 0, 17, 17))),
      new FakeSymbol('elsewhere', 12, '', new FakeLocation({ toString: () => 'file:///x' }, r(0, 0, 0, 1))),
    ] as unknown as vscode.SymbolInformation[])) as unknown as FakeSymbol[];
    assert.deepStrictEqual(
      symbols.map((s) => [s.name, s.location.range]),
      [['half\\u{202E}', r(16, 2, 16, 19)]],
    );
    const highlights = (await middleware.provideDocumentHighlights?.(asDoc(doc), new FakePosition(16, 2) as unknown as vscode.Position, token, () => [
      new FakeHighlight(r(17, 0, 17, 4), 1),
    ] as unknown as vscode.DocumentHighlight[])) as unknown as FakeHighlight[];
    assert.deepStrictEqual(highlights.map((h) => [h.range, h.kind]), [[r(16, 2, 16, 6), 1]]);
  });

  test('semantic tokens of a dirty document: the server\'s RequestCancelled is a CancellationError (recording dirty)', async () => {
    const doc = new FakeDocument('/p/src/Clean.idr', 'module Clean\n');
    const { middleware } = await setup(doc);
    const dirtyError = recorded('dirty').find((e) => e.kind === 'recv' && e.text?.includes('Document Dirty'));
    assert.ok(dirtyError?.text);
    const { code, message } = (JSON.parse(dirtyError.text) as { error: { code: number; message: string } }).error;
    const responseError = Object.assign(new Error(message), { code });
    await assert.rejects(
      Promise.resolve(middleware.provideDocumentSemanticTokens?.(asDoc(doc), token, () => Promise.reject(responseError))),
      (e: unknown) => e instanceof FakeCancellationError,
    );
    await assert.rejects(
      Promise.resolve(middleware.provideDocumentSemanticTokens?.(asDoc(doc), token, () => Promise.reject(new Error('other')))),
      (e: unknown) => e instanceof Error && e.message === 'other',
    );
  });

  suite('quick fixes', () => {
    const part = new FakeDocument('/p/src/Part.idr', 'module Part\n\ng : Nat -> Nat\ng 0 = 0\n\nmain : IO ()\nmain = printLn (g 1)\n');
    const covering = (): FakeDiagnostic => new FakeDiagnostic(r(2, 0, 2, 14), 'g is not covering.\n\nMissing cases:\n    g (S _)\n', 0);
    const mainCovering = (): FakeDiagnostic => new FakeDiagnostic(r(5, 0, 5, 12), 'main is not covering.\n\nCalls non covering function Part.g', 0);
    /** The server's answer of recording diagnostics (F28): every stored quick fix, whatever was asked. */
    const answer = (): FakeCodeAction[] => {
      const fix = (title: string, diagnostic: FakeDiagnostic, line: number, text: string, uri: { toString(): string } = part.uri): FakeCodeAction => {
        const action = new FakeCodeAction(title, FakeKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.edit = new FakeEdit();
        action.edit.replace(uri, r(line, 0, line, 0), text);
        action.command = { command: 'evil', title: 'evil' };
        return action;
      };
      return [
        fix('QuickFix: Add partial annotation', mainCovering(), 5, 'partial\n'),
        fix('QuickFix: Add missing cases', covering(), 4, 'g (S _) = ?g_missing_case_1\n'),
        fix('QuickFix: Add partial annotation', covering(), 2, 'partial\n'),
        fix('QuickFix: Replace with $(zap)x', covering(), 2, 'x', { toString: () => 'file:///p/src/Other.idr' }),
        new FakeCodeAction('Add clause', new FakeKind('refactor.rewrite')),
      ];
    };

    test('kept: quickfix kind, the diagnostic VS Code passed, an edit of this document alone; Add missing cases left to the extension; asked with only: quickfix', async () => {
      const { middleware } = await setup(part);
      let askedContext: { only?: FakeKind; diagnostics: unknown[] } | undefined;
      const actions = (await middleware.provideCodeActions?.(
        asDoc(part),
        r(2, 3, 2, 3) as unknown as vscode.Range,
        { diagnostics: [covering()], triggerKind: 1 } as unknown as vscode.CodeActionContext,
        token,
        (_d, _r, context) => {
          askedContext = context as unknown as { only?: FakeKind; diagnostics: unknown[] };
          return answer() as unknown as vscode.CodeAction[];
        },
      )) as unknown as FakeCodeAction[];
      assert.strictEqual(askedContext?.only?.value, 'quickfix');
      assert.deepStrictEqual(askedContext?.diagnostics, []);
      assert.deepStrictEqual(
        actions.map((a) => [a.title, a.kind?.value, a.isPreferred, a.command, a.edit?.entries().map(([u, es]) => [u.toString(), es.map((e) => [e.range, e.newText])])]),
        [['QuickFix: Add partial annotation', 'quickfix', true, undefined, [[part.uri.toString(), [[r(2, 0, 2, 0), 'partial\n']]]]]],
      );
    });

    test('nothing without a diagnostic, for a request of other kinds, or in a bird-track file', async () => {
      const { middleware } = await setup(part);
      const ask = (context: unknown): Promise<unknown> =>
        Promise.resolve(middleware.provideCodeActions?.(asDoc(part), r(2, 3, 2, 3) as unknown as vscode.Range, context as vscode.CodeActionContext, token, () => answer() as unknown as vscode.CodeAction[]));
      assert.deepStrictEqual(await ask({ diagnostics: [], triggerKind: 1 }), []);
      assert.deepStrictEqual(await ask({ diagnostics: [covering()], only: FakeKind.Refactor, triggerKind: 1 }), []);
      // In a bird-track file even a fix of this document for the diagnostic VS Code passed is dropped:
      // the server's new text has no line markers (middleware.ts, *Quick fixes*).
      const lit = fixtureDocument(LIT2);
      const literate = await setup(lit);
      const shown = new FakeDiagnostic(r(13, 2, 13, 6), 'both is not covering.', 0);
      const start = toServerPosition(lit, { line: 13, character: 2 });
      const end = toServerPosition(lit, { line: 13, character: 6 });
      assert.ok(start !== undefined && end !== undefined);
      const fix = new FakeCodeAction('QuickFix: Add partial annotation', FakeKind.QuickFix);
      fix.diagnostics = [new FakeDiagnostic(r(start.line, start.character, end.line, end.character), 'both is not covering.', 0)];
      fix.edit = new FakeEdit();
      fix.edit.replace(lit.uri, r(start.line, 0, start.line, 0), 'partial\n');
      assert.deepStrictEqual(
        await literate.middleware.provideCodeActions?.(asDoc(lit), r(13, 3, 13, 3) as unknown as vscode.Range, { diagnostics: [shown], triggerKind: 1 } as unknown as vscode.CodeActionContext, token, () => [fix] as unknown as vscode.CodeAction[]),
        [],
      );
    });
  });
});
