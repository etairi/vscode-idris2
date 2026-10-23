/**
 * `LspBackend` (`backend/lsp/backend.ts`, docs/ARCHITECTURE.md §2, §3.1; ROADMAP §5 M5): the
 * `IdrisBackend` of the roots the routing gives idris2-lsp, over the language client
 * (`LspClientHandle`, `client.ts`), which sends a request only for a document the routing admits
 * (`LspOwnership`). One instance serves every such root of the window (the server is one process,
 * F20). Only type imports from `vscode`; unit-tested over the recordings of
 * `test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a`.
 *
 * **What it answers, and what not** (`LSP_CAPABILITIES`; ROADMAP §9 Q7, decided 2026-10-01: one
 * backend per root, a feature it lacks unavailable with a message, ARCHITECTURE §3.1):
 * - the edits (`edit`, `edits.ts`) and their next results, under M4's rules;
 * - the holes (`holes`, `metavars`, `holes.ts`);
 * - the names of a namespace (`browseNamespace`, the server's unadvertised command, F20);
 * - not the diagnostics, hover, definition, completion, semantic tokens, symbols, highlights and
 *   signature help: the language client's own providers answer those for the documents of these
 *   roots (`middleware.ts`); the extension's providers ask only a backend whose capability is true, or
 *   get the rejection of these methods (`Unsupported`, saying so) and show nothing;
 * - not the documentation (`docsFor`): the server has no request for it (its hover shows the type);
 * - not Evaluate (`evaluate`), although the server's `repl` command evaluates: it hands the text to
 *   the REPL of the compiler context that checks the files, in the file the server loaded last, which
 *   is another open file's whenever the editor asked about that file in between (each request about
 *   another file loads that file [live, recorder]; after every save the server sends
 *   `workspace/semanticTokens/refresh` [live, recording `diagnostics`], which asks the client to request
 *   the semantic tokens of its editors again [doc: LSP 3.17]), so a value could silently come from
 *   another file's names; and the server handles no cancellation (no
 *   `$/cancelRequest` in `Server/` of idris2-lsp `9a2f0ad` [src]), so an evaluation that does not end
 *   would stop every other feature and grow the process until the server is restarted (IDE mode stops
 *   its separate `eval` session, F27). Its `repl` also runs the REPL's colon commands (E10 [live,
 *   recording `repl`: `:t id`, `:version`]); nothing here sends it.
 *
 * **A document whose file the server has not loaded.** The server keeps one loaded file and loads a
 * document's file before it answers a request that names it (`withURI`), so a code action is answered
 * in its document's context. `metavars`, `browseNamespace`, `refineHole` and `exprSearchWithHints`
 * name no document to load (`Server/ProcessMessage.idr` 512–546 [src]): each is sent after a
 * `textDocument/documentSymbol` of the document, which loads it (`ensureLoaded`). Another request
 * about another file can still come between the two (above); the edits check that the answer is for
 * the hole asked (`edits.ts`), the holes are asked once more when the answer has none of the
 * document's holes while its symbols show some (`holes`), and a namespace's names may then be those
 * visible from the other file (a known limitation, docs/as-built/M5.md).
 *
 * **Unsaved changes.** The server answers nothing (`null`) for a document it was sent changes of and
 * not yet its save (`isDirty` [src]; [live, recording `dirty`]); an edit is asked only for a
 * document without unsaved changes whose lines are the file's on disk, which the server read
 * (`savedText`), and the server's `null` rejects with `DirtyDocument`.
 */
import type * as vscode from 'vscode';
import type { Config } from '../../core/config';
import type { IDisposable } from '../../core/disposable';
import { IdrisException, unsupported } from '../../core/errors';
import { holeTokenNames } from '../../core/idrisSyntax';
import { editorLines, fromIdeReplySpan, type IdeReplySpan, type PositionDocument } from '../../core/positions';
import { editText, nameProblem, type EditText } from '../ide/edits';
import { NO_CAPABILITIES } from '../null';
import type { BackendKind, Capabilities, EditRequest, EditResult, Evaluation, Hole, HolesOptions, IdrisBackend, LoadResult, NamespaceEntry, NextRequest, RichText, TokenIndex, TypeInfo } from '../types';
import { nextResult, planLspEdit, type LspEditRequest } from './edits';
import { decodeMetavars, holeFiles, holesOf, holeSymbolCount } from './holes';
import type { LspClientHandle } from './types';

/** What idris2-lsp's backend answers (module comment); the language client's providers answer the rest. */
export const LSP_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  ...NO_CAPABILITIES,
  holes: true,
  holeLocations: true,
  editing: true,
  editingNext: true,
  intro: true,
  refine: true,
  missingCases: true,
  browseNamespace: true,
});

/** The `vscode` constructors the backend needs for the holes' locations. */
type LspBackendApi = Pick<typeof vscode, 'Uri' | 'Range' | 'Location'>;

interface LspBackendDeps {
  readonly client: Pick<LspClientHandle, 'request' | 'executeCommand' | 'onDidChangeState' | 'serverUri' | 'documentUri'>;
  /** `maxCodeActionResults`: whether a search's results may have been cut (`next`). */
  readonly config: Pick<Config, 'lsp'>;
  readonly api: LspBackendApi;
  /**
   * Reads a source file as UTF-8 (`toolchain/fileSystem.ts` `readSourceFile`: a regular file of at
   * most `MAX_SOURCE_FILE_BYTES`, anything else rejected unopened): the text the server read, for the
   * edits' places and the holes' columns (E14) and literate lines (F11). A rejection is a file that
   * cannot be read.
   */
  readFile(p: string): Promise<string>;
}

/** A search whose further results Next Result or Next Definition applies (`edits.ts` `LspAnswer.more`). */
interface Search {
  /** `vscode.Uri.toString()` of the document it was asked for. */
  readonly uri: string;
  readonly rest: string[];
  /** How many results the server gave. */
  readonly total: number;
  /** The server gave as many as `idris2.lsp.maxCodeActionResults` allowed: it may have more. */
  readonly limited: boolean;
}

const unsupportedPromise = <T>(reason: string): Promise<T> => Promise.reject(unsupported(reason));

/** The language client's providers answer these for the documents idris2-lsp serves (module comment). */
const ANSWERED_BY_THE_CLIENT = 'is answered by idris2-lsp itself for this file (the language client asks it), not by the extension.';

/**
 * The text the compiler read, as `core/positions.ts` reads a document: its lines split at `\n` (the
 * compiler's), without a byte order mark (as IDE mode's `textDocument`, `backend/ide/backend.ts`).
 */
function textDocument(fileName: string, text: string): PositionDocument {
  const lines = text.replace(/^\uFEFF/u, '').split('\n');
  return { languageId: '', fileName, isUntitled: false, lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] ?? '' }) };
}

function isNextRequest(req: EditRequest): req is NextRequest {
  return req.kind === 'exprSearchNext' || req.kind === 'generateDefNext';
}

export class LspBackend implements IdrisBackend {
  readonly kind: BackendKind = 'lsp';
  readonly caps: Readonly<Capabilities> = LSP_CAPABILITIES;
  private readonly searches = new Map<'exprSearch' | 'generateDef', Search>();
  private readonly subscription: IDisposable;

  constructor(private readonly deps: LspBackendDeps) {
    // A server that stopped or started again has another context: no search continues across it.
    this.subscription = deps.client.onDidChangeState(() => this.searches.clear());
  }

  load(): Promise<LoadResult> {
    return unsupportedPromise('Checking the file is idris2-lsp\'s own here: it checks a file when it is opened or saved and shows its problems itself. Save the file to check it again.');
  }

  typeAt(): Promise<TypeInfo | undefined> {
    return unsupportedPromise(`Showing a type ${ANSWERED_BY_THE_CLIENT}`);
  }

  docsFor(): Promise<RichText | undefined> {
    return unsupportedPromise('idris2-lsp has no documentation lookup (its hover shows the type). IDE mode shows documentation (Idris 2: Switch Backend…).');
  }

  definition(): Promise<vscode.Location[]> {
    return unsupportedPromise(`Go to Definition ${ANSWERED_BY_THE_CLIENT}`);
  }

  completions(): Promise<readonly string[]> {
    return unsupportedPromise(`Completion ${ANSWERED_BY_THE_CLIENT}`);
  }

  evaluate(): Promise<Evaluation> {
    return unsupportedPromise(
      'Evaluate Selection needs IDE mode (Idris 2: Switch Backend…): idris2-lsp evaluates in the file it loaded last, which can be another open file, ' +
        'and cannot stop an evaluation without a restart.',
    );
  }

  /** No token index: the language client's semantic tokens answer for these documents. */
  tokens(): TokenIndex | undefined {
    return undefined;
  }

  // -----------------------------------------------------------------------------------------
  // Edits (`edits.ts`)
  // -----------------------------------------------------------------------------------------

  /**
   * The edit `req` asks for (`edits.ts`): refused before anything is read or sent for a name that is
   * not an Idris name (`nameProblem`, M4), then for a document that changed since the command asked,
   * has unsaved changes or does not show its file's lines (`savedText`), then by the plan; the server's
   * answer is checked and applied by M4's rules. A Proof Search or Generate Definition ends the search
   * of its kind and starts one when it answers an edit; Next Result and Next Definition apply its next
   * result (`next`).
   */
  async edit(req: EditRequest): Promise<EditResult> {
    if (isNextRequest(req)) {
      return this.next(req);
    }
    const problem = nameProblem(req);
    if (problem !== undefined) {
      throw unsupported(problem);
    }
    const text = await this.savedText(req.doc, req.version);
    const plan = planLspEdit(req, text, this.deps.client.serverUri(req.doc.uri));
    const search = req.kind === 'exprSearch' || req.kind === 'generateDef' ? req.kind : undefined;
    if (search !== undefined) {
      this.searches.delete(search);
    }
    const limit = this.deps.config.lsp().maxCodeActionResults;
    if (plan.request.method !== 'codeAction') {
      await this.ensureLoaded(req.doc, req.token);
    }
    const reply = await this.send(req.doc, plan.request, req.token);
    const answer = plan.decode(reply, (uri) => this.isDocument(uri, req.doc));
    if (search !== undefined && answer.result.type === 'edit') {
      const rest = [...(answer.more ?? [])];
      this.searches.set(search, { uri: req.doc.uri.toString(), rest, total: rest.length + 1, limited: rest.length + 1 >= limit });
    }
    return answer.result;
  }

  /**
   * The next result of the document's search of `req`'s kind (`Search`): `exhausted` after the last,
   * unless the server may have cut the results (`Search.limited`), which the refusal says (decision 3
   * of 2026-10-01: where the server cannot give an answer IDE mode gives, say so).
   */
  private async next(req: NextRequest): Promise<EditResult> {
    const kind = req.kind === 'exprSearchNext' ? 'exprSearch' : 'generateDef';
    const title = req.kind === 'exprSearchNext' ? 'Next Result' : 'Next Definition';
    const search = this.searches.get(kind);
    if (search === undefined || search.uri !== req.doc.uri.toString()) {
      throw unsupported(
        `${title}: the search it would continue has ended (another search started, idris2-lsp started again, or none was made in this file). ` +
          `Run ${kind === 'exprSearch' ? 'Proof Search' : 'Generate Definition'} again.`,
      );
    }
    if (req.doc.version !== req.version) {
      throw unsupported(`${title}: the file changed since the command asked, so nothing was applied; run it again.`);
    }
    const answer = search.rest.shift();
    if (answer === undefined) {
      this.searches.delete(kind);
      if (search.limited) {
        throw unsupported(
          `${title}: idris2-lsp gives at most idris2.lsp.maxCodeActionResults results (${search.total}), and all of them were shown. ` +
            "Raise that setting for more, or use IDE mode, whose search goes on (Idris 2: Switch Backend…).",
        );
      }
      return { type: 'exhausted' };
    }
    return nextResult(req.kind, editText(req.doc, req.doc.getText()), req.previous, answer);
  }

  /**
   * The text of `doc` as the server read it, for an edit asked at `version` (module comment,
   * *Unsaved changes*): the file's text on disk, when `doc` is a file still at `version`, without
   * unsaved changes, whose lines are the file's (line breaks aside); else a refusal, nothing sent.
   */
  private async savedText(doc: vscode.TextDocument, version: number): Promise<EditText> {
    if (doc.uri.scheme !== 'file') {
      throw unsupported('idris2-lsp edits only a file saved on disk: it reads the file, not the editor.');
    }
    if (doc.version !== version) {
      throw unsupported('the file changed since the command asked, so idris2-lsp was not asked; run the command again.');
    }
    if (doc.isDirty) {
      throw new IdrisException({ kind: 'DirtyDocument', message: 'idris2-lsp answers for the saved file, and this document has unsaved changes: save it and run the command again.' });
    }
    let disk: string;
    try {
      disk = (await this.deps.readFile(doc.fileName)).replace(/^\uFEFF/u, '');
    } catch (error) {
      throw unsupported(`the file could not be read from disk (${error instanceof Error ? error.message : String(error)}), and idris2-lsp answers for the file on disk.`);
    }
    const read = editorLines(disk);
    if (read.length !== doc.lineCount || read.some((line, i) => line !== doc.lineAt(i).text)) {
      throw unsupported('the file on disk is not the text the editor shows (it changed outside the editor?), and idris2-lsp answers for the file on disk: save it and run the command again.');
    }
    return editText(doc, disk);
  }

  private send(doc: vscode.TextDocument, request: LspEditRequest, token: vscode.CancellationToken | undefined): Promise<unknown> {
    const { client } = this.deps;
    switch (request.method) {
      case 'codeAction':
        return client.request<unknown>(doc.uri, 'textDocument/codeAction', request.params, token);
      case 'exprSearchWithHints':
        return client.executeCommand(doc.uri, 'exprSearchWithHints', request.args, token);
      case 'refineHole':
        return client.executeCommand(doc.uri, 'refineHole', request.args, token);
    }
  }

  /**
   * Whether the URI `uri`, as the server wrote it, names `doc`: the server writes back the URI it was
   * sent (`LspClientHandle.serverUri`), parsed, which `documentUri` maps to the document.
   */
  private isDocument(uri: string, doc: vscode.TextDocument): boolean {
    try {
      return this.deps.client.documentUri(this.deps.api.Uri.parse(uri, true).toString()).toString() === doc.uri.toString();
    } catch {
      return false;
    }
  }

  /**
   * Makes the server load `doc`'s file, if it has not (module comment, *A document whose file the
   * server has not loaded*): `textDocument/documentSymbol`, whose answer is returned (`holes` reads
   * it). `DirtyDocument` when the server answers `null`, its answer for unsaved changes.
   */
  private async ensureLoaded(doc: vscode.TextDocument, token: vscode.CancellationToken | undefined): Promise<unknown> {
    const reply = await this.deps.client.request<unknown>(doc.uri, 'textDocument/documentSymbol', { textDocument: { uri: this.deps.client.serverUri(doc.uri) } }, token);
    if (reply === null) {
      throw new IdrisException({
        kind: 'DirtyDocument',
        message: 'idris2-lsp has unsaved changes of this file and answers nothing for them (it has not seen the file saved yet): save it and try again.',
      });
    }
    return reply;
  }

  // -----------------------------------------------------------------------------------------
  // Holes (`holes.ts`)
  // -----------------------------------------------------------------------------------------

  /**
   * (M4, over idris2-lsp) The holes of the compiler's context once the server has loaded `doc`'s
   * file: those of its module and of the modules it imports (`holes.ts`), located in the files as the
   * server read them from disk. Asked twice at most: once more when the document's symbols show holes
   * (`holeSymbolCount`) and the answer locates none in the document — another request about another
   * file came between the two requests (module comment) —, and the second answer is taken as it is
   * (a file whose holes were all solved by unification has such symbols too). `options.kept` changes
   * nothing: the server answers for the file it loads; `options.token` cancels.
   */
  async holes(doc: vscode.TextDocument, options?: HolesOptions): Promise<Hole[]> {
    if (doc.uri.scheme !== 'file') {
      throw unsupported('idris2-lsp lists the holes of a file saved on disk only.');
    }
    const first = await this.listHoles(doc, options?.token);
    return first.located ? first.holes : (await this.listHoles(doc, options?.token)).holes;
  }

  /** One listing; `located`: the answer locates a hole in `doc`, or `doc`'s symbols show none. */
  private async listHoles(doc: vscode.TextDocument, token: vscode.CancellationToken | undefined): Promise<{ readonly holes: Hole[]; readonly located: boolean }> {
    const symbols = await this.ensureLoaded(doc, token);
    const metavars = decodeMetavars(await this.deps.client.executeCommand(doc.uri, 'metavars', [], token));
    const { api } = this.deps;
    const own = doc.uri.toString();
    // By the documents' URIs, not the server's (`LspClientHandle.documentUri`).
    const files = new Map<string, { readonly path: string; readonly document: PositionDocument }>();
    let ownText: string | undefined;
    for (const file of [doc.uri, ...holeFiles(metavars).flatMap((uri) => this.documentFile(uri) ?? [])]) {
      const key = file.toString();
      const text = files.has(key) ? undefined : await this.deps.readFile(file.fsPath).catch(() => undefined);
      if (text !== undefined) {
        files.set(key, { path: file.fsPath, document: textDocument(file.fsPath, text) });
        ownText = key === own ? text : ownText;
      }
    }
    const locate = (uri: string, span: IdeReplySpan): vscode.Location | undefined => {
      const key = this.documentFile(uri)?.toString();
      const file = key === undefined ? undefined : files.get(key);
      if (file === undefined) {
        return undefined;
      }
      const range = fromIdeReplySpan(file.document, span);
      return new api.Location(api.Uri.file(file.path), new api.Range(range.start.line, range.start.character, range.end.line, range.end.character));
    };
    const holes = holesOf(metavars, holeTokenNames(ownText ?? doc.getText()), locate);
    const located = holeSymbolCount(symbols, (uri) => this.isDocument(uri, doc)) === 0 || holes.some((h) => h.location?.uri.toString() === own);
    return { holes, located };
  }

  /** The document a `file:` URI the server wrote names (`LspClientHandle.documentUri`); `undefined` for another URI. */
  private documentFile(uri: string): vscode.Uri | undefined {
    try {
      const parsed = this.deps.client.documentUri(this.deps.api.Uri.parse(uri, true).toString());
      return parsed.scheme === 'file' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------------------------------
  // Namespaces
  // -----------------------------------------------------------------------------------------

  /**
   * (M3, over idris2-lsp) The names `ns` exports that are visible from the file the server loaded,
   * after loading `doc`'s (`ensureLoaded`): its `browseNamespace` command answers one
   * `SymbolInformation` per name, `name` being `<name> : <type>`, private names and names without a
   * location in a file left out (`Language/LSP/BrowseNamespace.idr` [src]; [live, recording
   * `features-cross`: `shout : String -> String` for `Foo.A`, `[]` for a namespace not imported and
   * an unknown one]). `NamespaceEntry.name` is the text before the first ` : `.
   */
  async browseNamespace(doc: vscode.TextDocument, ns: string): Promise<NamespaceEntry[]> {
    if (doc.uri.scheme !== 'file') {
      throw unsupported('idris2-lsp lists the names visible from a file saved on disk only.');
    }
    await this.ensureLoaded(doc, undefined);
    const reply: unknown = await this.deps.client.executeCommand(doc.uri, 'browseNamespace', [ns]);
    if (!Array.isArray(reply) || !reply.every((s: unknown) => typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string')) {
      throw new IdrisException({ kind: 'ProtocolError', message: 'Browse Namespace: idris2-lsp answered something other than a list of names, which this extension does not read.' });
    }
    return (reply as readonly { readonly name: string }[]).map(({ name }) => {
      const at = name.indexOf(' : ');
      return { name: at < 0 ? name : name.slice(0, at), signature: { text: name, spans: [] } };
    });
  }

  /** Forgets the searches; the language client belongs to whoever made it. */
  dispose(): void {
    this.subscription.dispose();
    this.searches.clear();
  }
}
