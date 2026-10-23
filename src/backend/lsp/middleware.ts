/**
 * The language client's middleware (`backend/lsp/middleware.ts`; ARCHITECTURE §3.2, §5.3; ROADMAP M5):
 * which documents reach idris2-lsp, in which coordinates, and how its answers are shown.
 *
 * **Which features are the client's.** The language client (`client.ts`) registers only the
 * features listed in `client.ts` `CLIENT_FEATURES`; through this middleware they serve the documents
 * of the roots the routing gives idris2-lsp (`LspOwnership`): completion, hover, signature help,
 * definition, document highlights, document symbols, semantic tokens, the published diagnostics, and
 * the server's quick fixes but Add Missing Cases. For those documents the extension's own providers
 * stay silent (`backend/types.ts`, the capability table), so nothing is answered twice. What edits
 * a document under M4's rules goes through `IdrisBackend` instead (`backend.ts`, which asks through
 * `LspClientHandle`): the editing commands and their light bulbs, Add Missing Cases (the
 * extension's own quick fix on a coverage error, which is why the server's is dropped here), the
 * holes, evaluation and namespace listings.
 *
 * **Ownership.** No document reaches the server unless `LspOwnership.admits` holds for it now: the
 * server builds a file it is told about — at `didOpen`, at `didSave`, and before answering any
 * request about it, also one never opened (`loadURI`, `withURI`; `Server/ProcessMessage.idr`
 * 197–297 [src]; a hover on an unopened `Foo/A.idr` built it [live, recording `features-cross`]) —
 * and building runs the elaborator scripts it reaches. `DocumentSync` keeps the set of documents the
 * server has open: `didOpen` is forwarded only when `admits` holds (asked when the notification is
 * made, per document in order), `didChange` and `didClose` only for an open one, `didSave` only for
 * an open one that is still admitted; when `admits` may change (`LspOwnership.onDidChange`) the
 * client opens and closes documents to match (`reconcile`), clearing the diagnostics of each one it
 * closes. Every provider hook answers `undefined` or `[]` without asking for a document that is not
 * open and admitted (`serves`). Below the hooks, the client's general `sendNotification` and
 * `sendRequest` hooks are a last check that nothing names another document: a `textDocument/*`
 * notification passes only for a document the sync opened (or is opening), and a request that names
 * a document (also inside `workspace/executeCommand`'s `codeAction` argument) only for an open,
 * admitted one.
 *
 * **Text sync.** Each change is sent as the document's whole text (one content change without a
 * range), although the server offers incremental sync (`change: 2`, F20 [live]): its copy is used
 * only by completion (`identifierAtPosition` on `virtualDocuments`, `Completion/Handler.idr`
 * 191–203 [src]), it applies a range's `character` as a count of its string's characters, code points
 * on the Chez backend (lsp-lib `Language/LSP/VirtualDocument.idr` `takePos`/`dropPos`, `strSubstr`
 * [src]) where VS Code counts UTF-16 units, and an
 * insertion right after the file's last line break landed on the line above in its copy [live,
 * recording `features-cross`]. A whole text has none of these problems; lsp-lib applies it as the new
 * content (`contentChangeEvent`, same file [src]).
 *
 * **Coordinates.** The server reads and writes positions in the compiler's coordinates: the
 * compiler's 0-based line and its code-point column of the unlit text (`findPointInTreeLoc` on the
 * request's position; `mkLocation'`, `Language/LSP/Definition.idr` 22–51 [src]; in a bird-track file
 * unlit columns, and lines shifted by one below a line of `> ` and spaces [live, recording `lit2`,
 * E1]). Completion is the exception: it reads its copy of the file, by file line and code points of
 * the raw line (`identifierAtPosition`). So every position goes through `core/positions.ts` on the
 * way out (`toServerPosition`, or `codePointsBefore` for completion) and back (`fromServerPosition`):
 * hover ranges, definitions (in another file with that file's open document, else its text on
 * disk), highlights, symbols, semantic tokens, diagnostics and the quick fixes' edits.
 *
 * **Paths.** A `file:` document is sent as the real path of its folder joined with its name, and the
 * server's URIs are mapped back to the documents they were made from (`ServerPaths`): the server
 * refuses a file whose path is not below the physical path of its working directory.
 *
 * **Untrusted text.** What the server sends quotes the user's and installed packages' source: the
 * M3 rules apply (`core/untrustedText.ts`). A hover is rebuilt as a `MarkdownString` that is not
 * trusted, without HTML or theme icons, whose only content is `codeBlock`s of the server's text
 * (`visible`): the server's own form, a fence of `idris` around the type (every recorded hover [live]),
 * becomes an `idris2` block of the type, anything else a `text` block of the whole text. Completion
 * labels and details are drawn as `editorLabel`/`quickPickText` (M3's completion rule), with
 * `filterText` and `insertText` the server's; documentation (a plain string from this server
 * [live]) is `visible` plain text, and markdown would become a `text` block. Signature labels and
 * documentation likewise; symbol names `editorLabel`; quick-fix titles `quickPickText(editorLabel(…))`.
 * Nothing the server sends can run a command: completion items and code actions are rebuilt without
 * their `command` (and without `additionalTextEdits`), and a quick fix keeps only an edit of its own
 * document.
 *
 * **Quick fixes.** The server answers `textDocument/codeAction` with every stored quick fix of the
 * file, whatever the position and `context.diagnostics` (F28 [live]), and runs every code action
 * module (expression search included, up to `idris2.lsp.longActionTimeout`) unless `context.only`
 * excludes it. So a request is sent only when VS Code asks for quick fixes, always with `only:
 * quickfix`, and a fix is kept only when its kind is `quickfix`, its diagnostic (in editor
 * coordinates) is one VS Code passed, and its edit changes this document alone; Add Missing Cases is
 * left to the extension's own quick fix (above). None in a bird-track or Org file: the server's new
 * text has no line markers [live, recording `lit2`: Add Clause inserts `> vapp xs ys = …` with one,
 * but Make Case writes `> > vlen xs = …`], and M4's rules for literate files are `backend.ts`'s.
 *
 * **Dirty documents.** The server answers `null` for most requests about a document changed since its
 * last save, and `RequestCancelled` (`-32800`, `Document Dirty`) for `semanticTokens/full`
 * ([live], recording `dirty`). The library turns that error into a `CancellationError` (`handleFailedRequest`,
 * vscode-languageclient 10.1.2 `lib/common/client.js` 1825–1857 [src]); the hook makes sure it is
 * one. VS Code takes a cancelled semantic-tokens request as expected (no error is reported) and does
 * not replace the tokens it shows (VS Code 1.140.0 workbench bundle, the error branch of its document
 * semantic-tokens request [src]). Returning the last tokens instead (ARCHITECTURE §5.3) would set
 * tokens computed for the text before the unsaved edits: VS Code applies to a result only the edits
 * made while the request ran (same place [src]).
 *
 * No runtime dependency on `vscode` or `vscode-languageclient` (type imports only): `client.ts`
 * passes the `vscode` namespace as `api`, unit tests pass fakes.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import type { Middleware } from 'vscode-languageclient/node';
import { unsupported } from '../../core/errors';
import type { Log } from '../../core/log';
import { plainText } from '../../core/notificationText';
import { codePointsBefore, fromIdeReply, toIdeTypeOfRequest, type EditorPosition, type EditorRange, type PositionDocument } from '../../core/positions';
import { codeBlock, editorLabel, quickPickText, visible } from '../../core/untrustedText';
import { compilerLiterateStyleOf, hasLineMarkers } from '../../project/literate';
import type { LspOwnership } from './types';

// -------------------------------------------------------------------------------------------
// Coordinates
// -------------------------------------------------------------------------------------------

/**
 * The server's position of `pos` in `doc`: the compiler's 0-based line and the code points of the
 * unlit text before `pos` (module comment, *Coordinates*); `undefined` on a prose line of a
 * bird-track file. Built on `toIdeTypeOfRequest`, whose line is the same compiler line counted from
 * 1, as IDE-mode requests count it.
 */
export function toServerPosition(doc: PositionDocument, pos: EditorPosition): EditorPosition | undefined {
  const point = toIdeTypeOfRequest(doc, pos);
  return point === undefined ? undefined : { line: point.line - 1, character: point.column };
}

/** The editor position of a position the server sent: the compiler's 0-based line and column, as an IDE-mode reply's. */
export function fromServerPosition(doc: PositionDocument, pos: EditorPosition): EditorPosition {
  return fromIdeReply(doc, { line: pos.line, column: pos.character });
}

export function fromServerRange(doc: PositionDocument, range: EditorRange): EditorRange {
  return { start: fromServerPosition(doc, range.start), end: fromServerPosition(doc, range.end) };
}

/** Completion's position: the file line, and the code points of the raw line before `pos` (module comment). */
export function toServerCompletionPosition(doc: PositionDocument, pos: EditorPosition): EditorPosition {
  const text = pos.line < doc.lineCount ? doc.lineAt(pos.line).text : '';
  return { line: pos.line, character: codePointsBefore(text, pos.character) };
}

/**
 * Semantic tokens of the server (the LSP encoding: five numbers per token, positions relative to
 * the token before) moved to the editor's lines and columns, encoded again. A token that does not
 * land on one line with a positive length (the empty extra line of a doubled bird-track line), or
 * that would come before the one before it, is left out.
 */
export function toEditorTokens(doc: PositionDocument, data: Uint32Array): Uint32Array {
  const out: number[] = [];
  let line = 0;
  let character = 0;
  let previous: EditorPosition = { line: 0, character: 0 };
  for (let i = 0; i + 4 < data.length; i += 5) {
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    line += data[i];
    const start = fromServerPosition(doc, { line, character });
    const end = fromServerPosition(doc, { line, character: character + data[i + 2] });
    const before = start.line < previous.line || (start.line === previous.line && start.character < previous.character);
    if (end.line !== start.line || end.character <= start.character || before) {
      continue;
    }
    out.push(
      start.line - previous.line,
      start.line === previous.line ? start.character - previous.character : start.character,
      end.character - start.character,
      data[i + 3],
      data[i + 4],
    );
    previous = start;
  }
  return Uint32Array.from(out);
}

/** A text as `core/positions.ts` reads a document, without a byte order mark (as `backend/ide/backend.ts` reads a file). */
function textSnapshot(fileName: string, text: string): PositionDocument {
  const lines = text.replace(/^﻿/, '').split('\n');
  return { languageId: '', fileName, isUntitled: false, lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] ?? '' }) };
}

/** Whether `doc` has line markers (bird tracks, Org's `#+IDRIS:`), whose lines the server's new text lacks. */
function hasMarkers(doc: PositionDocument): boolean {
  return hasLineMarkers(compilerLiterateStyleOf(doc));
}

// -------------------------------------------------------------------------------------------
// Untrusted text
// -------------------------------------------------------------------------------------------

/** The server's hover: one fence of `idris` around the text (module comment, *Untrusted text*). */
const SERVER_HOVER = /^```idris\n([\s\S]*)\n```$/;

/** What a hover, completion documentation or signature documentation holds, as the library converted it. */
type ServerContent = vscode.MarkdownString | vscode.MarkedString;

/** The markdown of one piece of server content: only `codeBlock`s (module comment). */
export function contentMarkdown(content: ServerContent): string {
  if (typeof content === 'string') {
    return codeBlock(visible(content), 'text');
  }
  if ('language' in content) {
    return codeBlock(visible(content.value), content.language === 'idris' ? 'idris2' : 'text');
  }
  const fenced = SERVER_HOVER.exec(content.value);
  return fenced === null ? codeBlock(visible(content.value), 'text') : codeBlock(visible(fenced[1]), 'idris2');
}

// -------------------------------------------------------------------------------------------
// Paths
// -------------------------------------------------------------------------------------------

/**
 * The URI the server is sent for a document, and the document a URI of the server names (module
 * comment, *Paths*). The server changes into a file's folder before it loads it and takes the
 * compiler's working directory from `getcwd()`, the physical path, while it takes the file's path from
 * the URI; the compiler accepts the file only when that path lies, as text, below the source directory
 * it derives from the working directory (`corePathToNS`, `Core/Directory.idr` [src]; IDE mode's
 * `:load-file` met the same rule, `backend/ide/backend.ts`, *The path in `:load-file`*). A document
 * reached through a symbolic link — any folder under `/tmp` on macOS, which is `/private/tmp` — was
 * refused with `Source file "/tmp/…" is not in the source directory "/private/tmp/…"` and got no
 * answer at all [live, packaged-extension check, 2026-10-02]. So a `file:` document is sent as the real
 * path of its folder joined with its name (as found when it is first sent, kept for the client's life),
 * and every URI the server sends back is mapped to the document it was made from; a URI the server
 * names that was never sent (a definition in an installed package) stays as it is. Other schemes, and
 * Windows (out of scope, the compiler's view of its working directory there not tried), are sent as
 * they are.
 */
export class ServerPaths {
  private readonly sent = new Map<string, string>();
  private readonly documents = new Map<string, string>();

  constructor(
    /** The real path of a folder, `undefined` when it cannot be resolved (`fs.realpathSync.native`). */
    private readonly realpath: (dir: string) => string | undefined,
    private readonly uris: Pick<typeof vscode.Uri, 'file' | 'parse'>,
    private readonly platform: NodeJS.Platform,
  ) {}

  /** The URI the server is sent for `uri`. */
  toServer(uri: vscode.Uri): string {
    const key = uri.toString();
    const known = this.sent.get(key);
    if (known !== undefined) {
      return known;
    }
    if (uri.scheme !== 'file' || this.platform === 'win32') {
      return key;
    }
    const dir = this.realpath(path.dirname(uri.fsPath));
    const server = dir === undefined ? key : this.uris.file(path.join(dir, path.basename(uri.fsPath))).toString();
    this.sent.set(key, server);
    this.documents.set(server, key);
    return server;
  }

  /** The document a URI the server wrote names: the one sent as it, else the URI as it is. */
  fromServer(value: string): vscode.Uri {
    return this.uris.parse(this.documentKey(value));
  }

  /** `fromServer(value).toString()` without parsing what is known: the key the sync keeps documents by. */
  documentKey(value: string): string {
    return this.documents.get(value) ?? value;
  }
}

// -------------------------------------------------------------------------------------------
// Document sync
// -------------------------------------------------------------------------------------------

/** How `DocumentSync` reaches the running language client (`client.ts`). */
export interface SyncChannel {
  /** `textDocument/didOpen` of `doc` as it is now. */
  open(doc: vscode.TextDocument): Promise<void>;
  /** `textDocument/didChange` with `doc`'s whole text and version as they are now. */
  change(doc: vscode.TextDocument): Promise<void>;
  /** `textDocument/didSave` of `doc`, with its text (the server reads the file from disk). */
  save(doc: vscode.TextDocument): Promise<void>;
  close(doc: vscode.TextDocument): Promise<void>;
  /** Drops what the client shows of the server's diagnostics for `uri`. */
  clearDiagnostics(uri: vscode.Uri): void;
}

/** The notifications that name a document, and which state of it lets each pass (`permitsNotification`). */
const DOCUMENT_NOTIFICATIONS: Readonly<Record<string, 'opening' | 'open' | 'closing'>> = {
  'textDocument/didOpen': 'opening',
  'textDocument/didChange': 'open',
  'textDocument/didSave': 'open',
  'textDocument/didClose': 'closing',
};

/**
 * Which documents the server has open (module comment, *Ownership*, *Text sync*). One per
 * `LspClient`; `attach` starts afresh for each language client it creates (a new server process
 * knows no document), `detach` when it stops. Every step for one document runs after the steps
 * before it for that document, so that a `didChange` cannot overtake the `didOpen` that waits for
 * `admits`.
 *
 * **The library's held-back opens.** vscode-languageclient 10.1.2 does not send `didOpen` at once for
 * a document that is open but not visible when it starts: it keeps it and sends it (through the
 * `didOpen` hook) before the next notification or request it sends, whatever that is about
 * (`DidOpenTextDocumentFeature.register`, `sendPendingOpenNotifications`, `lib/common/
 * textSynchronization.js`, `client.js` 581–588, 671–688 [src]). That next notification can be this
 * sync's own, about the same document (`reconcile` opening it), so the hook is then called while
 * that document's step waits for the send that called it: it queues its step without waiting for
 * it, which would wait for itself (a deadlock that left documents unopened until the integration
 * suite found it, 2026-10-02).
 *
 * **Clean again.** The server takes a document as changed from a `didChange` until a `didSave` or
 * `didClose`, whatever the text, and answers `null` for it meanwhile (`dirtyFiles`,
 * `Server/ProcessMessage.idr` 582–604 [src]; [live, recording `dirty`]). When VS Code shows a
 * document unchanged again without a save — an undo back to the saved text, a revert — the sync
 * sends `didSave` with its text, so that the server answers again for the file on disk, which is
 * what the editor shows. Not while VS Code is saving it (`willSave` until the save's `didSave`), so
 * that a save is one `didSave`, not two.
 */
export class DocumentSync {
  private channel: SyncChannel | undefined;
  /** Bumped by `attach` and `detach`: work queued for an earlier client does nothing. */
  private epoch = 0;
  private readonly open = new Map<string, vscode.Uri>();
  private readonly opening = new Set<string>();
  /** The documents whose `didClose` is being sent: no longer open, and the last check lets it pass. */
  private readonly closing = new Set<string>();
  private readonly changed = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();
  /** The documents whose step is running now (`enqueue`). */
  private readonly running = new Set<string>();
  /** The open documents the server was sent changes of since their `didOpen` or `didSave`. */
  private readonly unsaved = new Set<string>();
  /** The documents VS Code is saving (`willSave`), until the save's `didSave`. */
  private readonly saving = new Set<string>();

  constructor(
    private readonly ownership: LspOwnership,
    private readonly log: Log,
  ) {}

  attach(channel: SyncChannel): void {
    this.reset();
    this.channel = channel;
  }

  detach(): void {
    this.reset();
    this.channel = undefined;
  }

  private reset(): void {
    this.epoch++;
    this.open.clear();
    this.opening.clear();
    this.closing.clear();
    this.changed.clear();
    this.chains.clear();
    this.running.clear();
    this.unsaved.clear();
  }

  /** Runs `work` after the queued work of `uri`; a failure is logged, not passed on. */
  private enqueue(uri: vscode.Uri, work: (channel: SyncChannel) => Promise<void>): Promise<void> {
    const key = uri.toString();
    const epoch = this.epoch;
    const run = async (): Promise<void> => {
      const channel = this.channel;
      if (epoch !== this.epoch || channel === undefined) {
        return;
      }
      this.running.add(key);
      try {
        await work(channel);
      } catch (error) {
        this.log.warn(`Language server: a notification about ${uri.toString()} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // A step of an earlier client that ends late leaves the current client's steps alone.
        if (epoch === this.epoch) {
          this.running.delete(key);
        }
      }
    };
    const next = (this.chains.get(key) ?? Promise.resolve()).then(run);
    this.chains.set(key, next);
    return next;
  }

  /** Waits for the queued work of `uri`. */
  async settled(uri: vscode.Uri): Promise<void> {
    await this.chains.get(uri.toString());
  }

  /** Whether the server has `uri` open (the sync sent its `didOpen` and no `didClose` since). */
  isOpen(uri: vscode.Uri): boolean {
    return this.open.has(uri.toString());
  }

  /** Whether `uri` is open and admitted now, after its queued work: the provider hooks ask only then. */
  async serves(uri: vscode.Uri): Promise<boolean> {
    await this.settled(uri);
    return this.isOpen(uri) && (await this.ownership.admits(uri));
  }

  /** Opens `doc` with `send` if it is admitted; `send` is the library's own `didOpen` or `SyncChannel.open`. */
  private async openWith(doc: vscode.TextDocument, send: () => Promise<void>): Promise<void> {
    const key = doc.uri.toString();
    if (this.open.has(key) || !(await this.ownership.admits(doc.uri))) {
      return;
    }
    this.opening.add(key);
    try {
      await send();
      this.open.set(key, doc.uri);
      this.unsaved.delete(key);
    } finally {
      this.opening.delete(key);
    }
  }

  /** The library's `didOpen` (class comment, *The library's held-back opens*: not awaited while the document's own step runs). */
  didOpen(doc: vscode.TextDocument, next: (doc: vscode.TextDocument) => Promise<void>): Promise<void> {
    const reentrant = this.running.has(doc.uri.toString());
    const queued = this.enqueue(doc.uri, () => this.openWith(doc, () => next(doc)));
    return reentrant ? Promise.resolve() : queued;
  }

  /** Sends the whole text once for the changes queued so far (module comment, *Text sync*). */
  didChange(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    this.changed.add(key);
    return this.enqueue(doc.uri, async (channel) => {
      if (this.changed.delete(key) && this.open.has(key)) {
        await channel.change(doc);
        this.unsaved.add(key);
      }
    });
  }

  /** VS Code is about to save `doc` (`onWillSaveTextDocument`): its save sends `didSave` (class comment, *Clean again*). */
  willSave(doc: vscode.TextDocument): void {
    this.saving.add(doc.uri.toString());
  }

  didSave(doc: vscode.TextDocument, next: (doc: vscode.TextDocument) => Promise<void>): Promise<void> {
    const key = doc.uri.toString();
    this.saving.delete(key);
    return this.enqueue(doc.uri, async () => {
      if (this.open.has(key) && (await this.ownership.admits(doc.uri))) {
        await next(doc);
        this.unsaved.delete(key);
      }
    });
  }

  /**
   * A change event of `doc` (`onDidChangeTextDocument`, also one of its dirty state only): when it
   * shows the document unchanged and the server was sent changes since, `didSave` (class comment,
   * *Clean again*). Looked at once the event's other listeners have run, so that the library's
   * `didChange` of the same event is queued first.
   */
  stateChanged(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const clean = (): boolean => !doc.isDirty && !doc.isClosed && this.unsaved.has(key) && !this.saving.has(key) && this.open.has(key);
    queueMicrotask(() => {
      if (!clean()) {
        return;
      }
      void this.enqueue(doc.uri, async (channel) => {
        if (clean() && (await this.ownership.admits(doc.uri))) {
          await channel.save(doc);
          this.unsaved.delete(key);
        }
      });
    });
  }

  didClose(doc: vscode.TextDocument, next: (doc: vscode.TextDocument) => Promise<void>): Promise<void> {
    const key = doc.uri.toString();
    this.saving.delete(key);
    return this.enqueue(doc.uri, async () => {
      if (this.open.has(key)) {
        await this.closeWith(key, () => next(doc));
      }
    });
  }

  /**
   * Opens the documents of `docs` that are admitted and not open, and closes (clearing their
   * diagnostics) the open ones that are not admitted any more (`LspOwnership.onDidChange`).
   */
  async reconcile(docs: readonly vscode.TextDocument[]): Promise<void> {
    await Promise.all(
      docs.map((doc) =>
        this.enqueue(doc.uri, async (channel) => {
          const key = doc.uri.toString();
          if (!this.open.has(key)) {
            await this.openWith(doc, () => channel.open(doc));
          } else if (!(await this.ownership.admits(doc.uri))) {
            await this.closeWith(key, () => channel.close(doc));
            channel.clearDiagnostics(doc.uri);
          }
        }),
      ),
    );
  }

  /** Closes the open document `key` with `send`: the library's own `didClose` or `SyncChannel.close`. */
  private async closeWith(key: string, send: () => Promise<void>): Promise<void> {
    this.open.delete(key);
    this.unsaved.delete(key);
    this.closing.add(key);
    try {
      await send();
    } finally {
      this.closing.delete(key);
    }
  }

  /** The general `sendNotification` hook's check (module comment, *Ownership*): `uri` is the notification's document. */
  permitsNotification(method: string, uri: string): boolean {
    const needs = DOCUMENT_NOTIFICATIONS[method];
    return needs === 'opening' ? this.opening.has(uri) : needs === 'open' ? this.open.has(uri) : needs === 'closing' ? this.closing.has(uri) : false;
  }

  /** The general `sendRequest` hook's check: `uri` is open and admitted now. */
  async permitsRequest(uri: string): Promise<boolean> {
    const known = this.open.get(uri);
    return known !== undefined && (await this.ownership.admits(known));
  }
}

/** The document a request's or notification's parameters name: `textDocument.uri`, or that of `workspace/executeCommand`'s `codeAction` argument. */
export function documentOf(params: unknown): string | undefined {
  const uriOf = (value: unknown): string | undefined => {
    const doc = typeof value === 'object' && value !== null ? (value as { textDocument?: { uri?: unknown } }).textDocument : undefined;
    return typeof doc?.uri === 'string' ? doc.uri : undefined;
  };
  const direct = uriOf(params);
  if (direct !== undefined) {
    return direct;
  }
  const args = typeof params === 'object' && params !== null ? (params as { arguments?: unknown }).arguments : undefined;
  const first: unknown = Array.isArray(args) ? args[0] : undefined;
  return typeof first === 'object' && first !== null ? uriOf((first as { codeAction?: unknown }).codeAction) : undefined;
}

/**
 * The message the server's error response carries for a file without an `.ipkg` (F35, corrected in
 * M5). Two forms: code 3 with `Cannot find the ipkg file` (`withURI`, `Server/ProcessMessage.idr`
 * 292–297 [src]), which cannot occur with Idris2 `1c630e6`, whose `findIpkg (Just f)` returns the
 * file itself when it finds no `.ipkg` (`Idris/Package.idr` 1093–1110 [src]); and what does occur
 * [live, recording `loose-file`]: a request's error with code 4 (`Server/Main.idr` 116–122 [src]),
 * `Error: Source file "<abs>" is not in the source directory ""` (`corePathToNS`,
 * `Core/Directory.idr` 233–239 [src]: the working directory is empty when no `.ipkg` set it).
 */
export function isMissingIpkgError(code: number, message: string): boolean {
  return (code === 3 && message.includes('Cannot find the ipkg file')) || message.includes('is not in the source directory ""');
}

// -------------------------------------------------------------------------------------------
// The middleware
// -------------------------------------------------------------------------------------------

/** What the middleware uses of the `vscode` namespace. */
export type MiddlewareApi = Pick<
  typeof vscode,
  | 'MarkdownString'
  | 'Hover'
  | 'Position'
  | 'Range'
  | 'Location'
  | 'Diagnostic'
  | 'DiagnosticRelatedInformation'
  | 'DiagnosticSeverity'
  | 'DocumentHighlight'
  | 'SymbolInformation'
  | 'SemanticTokens'
  | 'SignatureHelp'
  | 'SignatureInformation'
  | 'ParameterInformation'
  | 'CompletionItem'
  | 'CompletionList'
  | 'CodeAction'
  | 'CodeActionKind'
  | 'WorkspaceEdit'
  | 'CancellationError'
> & { readonly workspace: Pick<typeof vscode.workspace, 'textDocuments'> };

export interface MiddlewareDeps {
  readonly api: MiddlewareApi;
  readonly sync: DocumentSync;
  /** The text of a file on disk, for a definition in a file that is not open; `undefined` when it cannot be read. */
  readonly readText: (fileName: string) => Promise<string | undefined>;
  readonly log: Log;
  /**
   * The server published the diagnostics of `uri`, a document it has open: it has just loaded the
   * file, as it does at `didOpen`, at `didSave` and before answering a request about a file it has
   * not loaded, and publishes after each load [live, recordings `diagnostics`, `features-cross`];
   * `failed`: they hold an error. For the holes model (`client.ts` `onDidLoad`).
   */
  readonly published?: (uri: vscode.Uri, failed: boolean) => void;
  /**
   * A request about the document `uri` (as the request names it) was answered with a missing-`.ipkg`
   * error (`isMissingIpkgError`; the F35 safety net, `client.ts` `onDidReportMissingIpkg`). Seen in the
   * request hook, below the library's providers, which turn a failed request into an empty answer.
   */
  readonly missingIpkg?: (uri: string) => void;
  /**
   * The document key of a URI as the server is sent it (`ServerPaths.documentKey`): the hooks below
   * the providers see the requests' and notifications' parameters converted already. The identity
   * when absent.
   */
  readonly documentKey?: (serverUri: string) => string;
}

/** The longest quick-fix title shown, as M4 cuts its titles (`features/editing/messages.ts` `MAX_SHOWN`). */
const MAX_TITLE = 120;

/** The server's own Add Missing Cases quick fix (F28), which the extension's quick fix replaces (module comment). */
const ADD_MISSING_CASES = 'QuickFix: Add missing cases';

/** Builds the middleware (module comment). */
export function createMiddleware(deps: MiddlewareDeps): Middleware {
  const { api, sync, log } = deps;
  /** The document a request's or notification's parameters name, as the sync keeps it. */
  const documentNamed = (params: unknown): string | undefined => {
    const named = documentOf(params);
    return named === undefined || deps.documentKey === undefined ? named : deps.documentKey(named);
  };

  const range = (r: EditorRange): vscode.Range => new api.Range(r.start.line, r.start.character, r.end.line, r.end.character);
  const position = (p: EditorPosition): vscode.Position => new api.Position(p.line, p.character);

  const openDocument = (uri: vscode.Uri): vscode.TextDocument | undefined =>
    api.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());

  /** The document whose text converts positions in `uri`: its open document, else its file's text; `undefined` when neither is there. */
  const documentFor = async (uri: vscode.Uri): Promise<PositionDocument | undefined> => {
    const open = openDocument(uri);
    if (open !== undefined || uri.scheme !== 'file') {
      return open;
    }
    const text = await deps.readText(uri.fsPath);
    return text === undefined ? undefined : textSnapshot(uri.fsPath, text);
  };

  const markdown = (content: readonly ServerContent[]): vscode.MarkdownString => {
    const md = new api.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.supportThemeIcons = false;
    for (const piece of content) {
      md.appendMarkdown(contentMarkdown(piece));
    }
    return md;
  };

  const documentation = (doc: string | vscode.MarkdownString | undefined): string | vscode.MarkdownString | undefined =>
    doc === undefined ? undefined : typeof doc === 'string' ? visible(doc) : markdown([doc]);

  const location = async (loc: vscode.Location): Promise<vscode.Location> => {
    const target = await documentFor(loc.uri);
    return target === undefined ? loc : new api.Location(loc.uri, range(fromServerRange(target, loc.range)));
  };

  const completionItem = (item: vscode.CompletionItem): vscode.CompletionItem => {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    const shown = new api.CompletionItem(quickPickText(editorLabel(label)), item.kind);
    shown.insertText = item.insertText ?? label;
    shown.filterText = item.filterText ?? label;
    shown.sortText = item.sortText;
    // plainText for the syntactic rule of `.detail` (test/unit/notificationText.test.ts); a detail is not parsed for links.
    shown.detail = item.detail === undefined ? undefined : plainText(quickPickText(editorLabel(item.detail)));
    shown.documentation = documentation(item.documentation);
    return shown;
  };

  const sameRange = (a: vscode.Range, b: EditorRange): boolean =>
    a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line && a.end.character === b.end.character;

  /** A quick fix of the server as shown (module comment, *Quick fixes*), or `undefined` when it is not kept. */
  const quickFix = (doc: vscode.TextDocument, action: vscode.Command | vscode.CodeAction, asked: readonly vscode.Diagnostic[]): vscode.CodeAction | undefined => {
    if (!('kind' in action) || action.kind === undefined || action.kind.value !== api.CodeActionKind.QuickFix.value || action.title === ADD_MISSING_CASES) {
      return undefined;
    }
    const fixes = (action.diagnostics ?? []).flatMap((d) => {
      const at = fromServerRange(doc, d.range);
      return asked.filter((a) => sameRange(a.range, at) && a.message === d.message);
    });
    const entries = action.edit?.entries() ?? [];
    if (fixes.length === 0 || entries.length === 0 || entries.some(([uri]) => uri.toString() !== doc.uri.toString())) {
      return undefined;
    }
    const edit = new api.WorkspaceEdit();
    for (const [, edits] of entries) {
      for (const e of edits) {
        if (!('newText' in e)) {
          return undefined;
        }
        edit.replace(doc.uri, range(fromServerRange(doc, e.range)), e.newText);
      }
    }
    const shown = new api.CodeAction(quickPickText(editorLabel(action.title, MAX_TITLE)), api.CodeActionKind.QuickFix);
    shown.diagnostics = fixes;
    shown.isPreferred = action.isPreferred;
    shown.edit = edit;
    return shown;
  };

  const isCancellation = (error: unknown): boolean =>
    error instanceof api.CancellationError || (error instanceof Error && (error as { code?: unknown }).code === -32800);

  return {
    // --- text sync -----------------------------------------------------------------------------
    didOpen: (doc, next) => sync.didOpen(doc, next),
    didChange: (event) => sync.didChange(event.document),
    didSave: (doc, next) => sync.didSave(doc, next),
    didClose: (doc, next) => sync.didClose(doc, next),

    // --- the last check below the hooks --------------------------------------------------------
    sendNotification: async (type, next, params) => {
      const method = typeof type === 'string' ? type : type.method;
      const uri = documentNamed(params);
      if (method.startsWith('textDocument/') && (uri === undefined || !sync.permitsNotification(method, uri))) {
        log.debug(`Language server: ${method} not sent (the document is not one the server may see).`);
        return;
      }
      return next(type, params);
    },
    sendRequest: async (type, param, token, next) => {
      const method = typeof type === 'string' ? type : type.method;
      const uri = documentNamed(param);
      if (uri !== undefined && !(await sync.permitsRequest(uri))) {
        throw unsupported(`${method} was not sent: idris2-lsp has not opened this file, or its project is not served by idris2-lsp now.`);
      }
      try {
        return await next(type, param, token);
      } catch (error) {
        const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
        if (uri !== undefined && typeof code === 'number' && error instanceof Error && isMissingIpkgError(code, error.message)) {
          deps.missingIpkg?.(uri);
        }
        throw error;
      }
    },

    // --- diagnostics ---------------------------------------------------------------------------
    handleDiagnostics: (uri, diagnostics, next) => {
      const doc = openDocument(uri);
      if (doc === undefined || !sync.isOpen(uri)) {
        next(uri, []);
        return;
      }
      next(
        uri,
        diagnostics.map((d) => {
          const shown = new api.Diagnostic(range(fromServerRange(doc, d.range)), d.message, d.severity);
          shown.source = d.source;
          shown.code = typeof d.code === 'string' || typeof d.code === 'number' ? d.code : undefined;
          shown.tags = d.tags;
          shown.relatedInformation = d.relatedInformation
            ?.filter((r) => r.location.uri.toString() === uri.toString())
            .map((r) => new api.DiagnosticRelatedInformation(new api.Location(uri, range(fromServerRange(doc, r.location.range))), r.message));
          return shown;
        }),
      );
      deps.published?.(uri, diagnostics.some((d) => d.severity === api.DiagnosticSeverity.Error));
    },

    // --- providers -----------------------------------------------------------------------------
    provideHover: async (doc, pos, token, next) => {
      const at = (await sync.serves(doc.uri)) ? toServerPosition(doc, pos) : undefined;
      const hover = at === undefined ? undefined : await next(doc, position(at), token);
      if (hover === undefined || hover === null) {
        return undefined;
      }
      return new api.Hover(markdown(hover.contents), hover.range === undefined ? undefined : range(fromServerRange(doc, hover.range)));
    },

    provideCompletionItem: async (doc, pos, context, token, next) => {
      if (!(await sync.serves(doc.uri))) {
        return undefined;
      }
      const answer = await next(doc, position(toServerCompletionPosition(doc, pos)), context, token);
      if (answer === undefined || answer === null) {
        return undefined;
      }
      return Array.isArray(answer) ? answer.map(completionItem) : new api.CompletionList(answer.items.map(completionItem), answer.isIncomplete);
    },

    provideSignatureHelp: async (doc, pos, context, token, next) => {
      const at = (await sync.serves(doc.uri)) ? toServerPosition(doc, pos) : undefined;
      const help = at === undefined ? undefined : await next(doc, position(at), context, token);
      if (help === undefined || help === null) {
        return undefined;
      }
      const shown = new api.SignatureHelp();
      shown.signatures = help.signatures.map((s) => {
        const signature = new api.SignatureInformation(visible(s.label), documentation(s.documentation));
        signature.parameters = s.parameters.map(
          (p) => new api.ParameterInformation(typeof p.label === 'string' ? visible(p.label) : p.label, documentation(p.documentation)),
        );
        return signature;
      });
      shown.activeSignature = help.activeSignature;
      shown.activeParameter = help.activeParameter;
      return shown;
    },

    provideDefinition: async (doc, pos, token, next) => {
      const at = (await sync.serves(doc.uri)) ? toServerPosition(doc, pos) : undefined;
      const found = at === undefined ? undefined : await next(doc, position(at), token);
      if (found === undefined || found === null) {
        return undefined;
      }
      // The server answers one Location (F20 [live]); a LocationLink has no `uri` and is left out.
      const locations = (Array.isArray(found) ? found : [found]).filter((l): l is vscode.Location => 'uri' in l);
      return Promise.all(locations.map(location));
    },

    provideDocumentHighlights: async (doc, pos, token, next) => {
      const at = (await sync.serves(doc.uri)) ? toServerPosition(doc, pos) : undefined;
      const highlights = at === undefined ? undefined : await next(doc, position(at), token);
      return (highlights ?? []).map((h) => new api.DocumentHighlight(range(fromServerRange(doc, h.range)), h.kind));
    },

    provideDocumentSymbols: async (doc, token, next) => {
      const symbols = (await sync.serves(doc.uri)) ? await next(doc, token) : undefined;
      // The server answers SymbolInformation (F20 [live]); a DocumentSymbol has no `location` and is left out.
      return (symbols ?? [])
        .filter((s): s is vscode.SymbolInformation => 'location' in s && s.location.uri.toString() === doc.uri.toString())
        .map(
          (s) =>
            new api.SymbolInformation(
              editorLabel(s.name),
              s.kind,
              editorLabel(s.containerName),
              new api.Location(doc.uri, range(fromServerRange(doc, s.location.range))),
            ),
        );
    },

    provideDocumentSemanticTokens: async (doc, token, next) => {
      if (!(await sync.serves(doc.uri))) {
        return undefined;
      }
      try {
        const tokens = await next(doc, token);
        return tokens === undefined || tokens === null ? undefined : new api.SemanticTokens(toEditorTokens(doc, tokens.data), tokens.resultId);
      } catch (error) {
        throw isCancellation(error) ? new api.CancellationError() : error;
      }
    },

    provideCodeActions: async (doc, asked, context, token, next) => {
      const wanted = context.only === undefined || context.only.intersects(api.CodeActionKind.QuickFix);
      if (!wanted || context.diagnostics.length === 0 || hasMarkers(doc) || !(await sync.serves(doc.uri))) {
        return [];
      }
      const start = toServerPosition(doc, asked.start);
      const end = toServerPosition(doc, asked.end);
      if (start === undefined || end === undefined) {
        return [];
      }
      const only = { diagnostics: [], only: api.CodeActionKind.QuickFix, triggerKind: context.triggerKind };
      const actions = await next(doc, new api.Range(position(start), position(end)), only, token);
      return (actions ?? []).flatMap((a) => quickFix(doc, a, context.diagnostics) ?? []);
    },
  };
}
