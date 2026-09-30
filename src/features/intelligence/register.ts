/**
 * `registerIntelligence` (`types.ts`, *Modules and entry points*): M3's read-only providers and
 * commands over the backend of each document's root — the hover, **Idris 2: Type at Cursor**,
 * **Docs at Cursor**, **Show Documentation…** and **Browse Namespace…**, Go to Definition, the
 * `idris2-doc` documents, semantic tokens, document symbols and document highlights. Completion and
 * inlay hints are `completion.ts` and `inlayHints.ts`; evaluation is `features/eval`.
 *
 * Every provider registers with `idrisDocumentSelector()` (D21), except the two of the
 * documentation documents, which are not Idris documents (the content provider of the scheme
 * `idris2-doc`, and the semantic tokens that colour it). A provider answers only for a file on
 * disk whose backend has the capability (`IdrisBackend.caps`); otherwise it answers nothing, and
 * VS Code shows what it shows without this extension. A command asks the backend whatever its
 * capabilities, so that a backend that cannot answer says why (`Unsupported`, ARCHITECTURE §3.1),
 * in a notification.
 *
 * **Commands.**
 * - **Type at Cursor** asks what the hover asks (`hover.ts`), loading the file when it must
 *   (`DocumentQueries`, `command`), and then shows the hover at the cursor
 *   (`editor.action.showHover`), which answers from the cache: the type in its code block, with the
 *   notes and the doc overview. The hover renders multi-line answers (a hole's goal) as they are,
 *   which a notification, which joins lines, would not.
 * - **Docs at Cursor** shows the whole `:docs-for` answer of the name at the cursor in an
 *   `idris2-doc` document beside the editor; **Show Documentation…** does so for a name typed in
 *   (the name at the cursor suggested), and **Browse Namespace…** for the name picked from a
 *   namespace's listing.
 * - Why there is nothing (no name at the cursor, the compiler's reason, no type — while the document
 *   is stale, that the compiler answers about the file as last checked: a position on a changed line
 *   is not asked about, fourth review of M3 —, and what checks it again, `recheckAdvice` —, no docs) is a
 *   notification made with `plainText` (CLAUDE.md, M2 rule), and every handler catches what it
 *   throws (`guarded`), since VS Code shows a rejected command's message with links working. The
 *   texts quote names of the source and compiler output, so each is one line with its control and
 *   format characters written out (`editorLabel`: an identifier may hold a bidirectional control),
 *   and a quoted name is cut at `MAX_QUOTED_NAME` (*review of M3*).
 * - Go to Definition on a local variable answers nothing and says nothing: VS Code asks the
 *   provider also while the mouse passes over a word with Cmd or Ctrl held (`startFindDefinitionFromMouse`
 *   in the 1.139.1 workbench bundle [src]), where a notification would come from a gesture that
 *   asked nothing (*review of M3*); the reason goes to the log (debug), and so does the backend's
 *   reason when it has no answer (a definition in a package whose sources are not installed; since
 *   the fourth review of M3 — before, it was dropped).
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 */
import type * as vscode from 'vscode';
import type { RichText } from '../../backend/types';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { plainText } from '../../core/notificationText';
import type { EditorRange } from '../../core/positions';
import { editorLabel } from '../../core/untrustedText';
import { idrisDocumentSelector } from '../../project/literate';
import { isCheckable, type Staleness } from '../diagnostics/checks';
import { DOC_SCHEME, docPath, docQuery, namespaceItem, namespaceSuggestion, parseDocQuery, selectDocs } from './docs';
import { documentHighlights } from './highlights';
import { docsKey, documentTokens, hoverAt, nameAt, renderHover, type HoverDeps } from './hover';
import { offsetOf, positionOf, syntaxModelOf } from './occurrence';
import { AnswerCache, isFileDocument } from './queries';
import { encodeRichText, encodeTokens, SEMANTIC_TOKEN_LEGEND } from './semanticTokens';
import { documentSymbols, type DocumentSymbolModel } from './symbols';
import { splitName } from './text';
import type { HoverModel, IntelligenceDeps, QueryOutcome } from './types';

export const TYPE_AT_CURSOR_COMMAND = 'idris2.typeAtCursor';
export const DOCS_AT_CURSOR_COMMAND = 'idris2.docsAtCursor';
export const SHOW_DOCUMENTATION_COMMAND = 'idris2.showDocumentation';
export const BROWSE_NAMESPACE_COMMAND = 'idris2.browseNamespace';

export type IntelligenceApi = Pick<
  typeof vscode,
  | 'languages'
  | 'commands'
  | 'window'
  | 'workspace'
  | 'MarkdownString'
  | 'Hover'
  | 'Position'
  | 'Range'
  | 'Uri'
  | 'SemanticTokensLegend'
  | 'SemanticTokens'
  | 'DocumentSymbol'
  | 'SymbolKind'
  | 'DocumentHighlight'
  | 'EventEmitter'
  | 'ViewColumn'
>;

export interface Intelligence extends IDisposable {
  /** The notifications shown in this window, in order; kept only with `keepNotices` (the test API). */
  readonly notices: readonly string[];
}

export interface IntelligenceOptions {
  /** Keep `Intelligence.notices` (the test API; `extension.ts` sets it under the test runner). */
  readonly keepNotices?: boolean;
}

const NO_FILE = 'Idris 2: this command needs an Idris file saved on disk in the active editor.';
const NO_NAME = 'Idris 2: there is no name at the cursor.';

/** The longest name a notification quotes, in UTF-16 code units (module comment). */
const MAX_QUOTED_NAME = 100;

/** `name` as a notification quotes it (module comment). */
const quoted = (name: string): string => `"${editorLabel(name, MAX_QUOTED_NAME)}"`;

/**
 * What checks a stale document again, by why it is stale (the status item says the same,
 * `toolchain/status.ts`): **Check File** checks the saved file and does not save, so with unsaved
 * changes it leaves the document stale (fifth review of M3: the notification offered it there), and
 * with the `manual` trigger a save checks nothing.
 */
function recheckAdvice(staleness: Staleness | undefined): string {
  const { unsaved, manual } = staleness ?? { unsaved: true, manual: false };
  if (!unsaved) {
    return 'Run Idris 2: Check File to check it again.';
  }
  return manual ? 'Save the file, then run Idris 2: Check File, to check it again.' : 'Save the file to check it again.';
}

export function registerIntelligence(api: IntelligenceApi, deps: IntelligenceDeps, options: IntelligenceOptions = {}): Intelligence {
  const store = new DisposableStore();
  const notices: string[] = [];
  const selector = idrisDocumentSelector();
  const answers = store.add(new AnswerCache(deps.loads));
  // Not another document of the same path, such as a `git:` one (`isFileDocument`).
  store.add(
    api.workspace.onDidCloseTextDocument((doc) => {
      if (isFileDocument(doc)) {
        answers.forget(doc.fileName);
      }
    }),
  );
  const hoverDeps: HoverDeps = {
    queries: deps.queries,
    answers,
    registry: deps.registry,
    projects: deps.projects,
    checks: deps.checks,
    manual: (doc) => deps.config.checking(doc.uri).trigger === 'manual',
    position: (p) => new api.Position(p.line, p.character),
  };
  const range = (r: EditorRange): vscode.Range => new api.Range(r.start.line, r.start.character, r.end.line, r.end.character);

  /** Shows `text` (one line of plain text, module comment) and records it for the test API. */
  const notify = (text: string): void => {
    const shown = editorLabel(text);
    if (options.keepNotices === true) {
      notices.push(shown);
    }
    void api.window.showInformationMessage(plainText(shown));
  };

  const guarded =
    (what: string, run: () => Promise<void>) =>
    async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.error(`Intelligence: ${what} failed: ${message}`);
        notify(`Idris 2: ${what} failed: ${message}`);
      }
    };

  /** The active editor, when it shows an Idris file on disk; otherwise says so. */
  const activeFile = (): vscode.TextEditor | undefined => {
    const editor = api.window.activeTextEditor;
    if (editor === undefined || !isCheckable(editor.document)) {
      notify(NO_FILE);
      return undefined;
    }
    return editor;
  };

  const markdown = (model: HoverModel): vscode.MarkdownString => {
    const md = new api.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.supportThemeIcons = false;
    renderHover(md, model);
    return md;
  };

  // --- hover and Type at Cursor --------------------------------------------------------------

  store.add(
    api.languages.registerHoverProvider(selector, {
      provideHover: async (doc, pos, token) => {
        const result = await hoverAt(hoverDeps, doc, pos, 'passive');
        return result.kind === 'model' && !token.isCancellationRequested ? new api.Hover(markdown(result.model), range(result.model.range)) : undefined;
      },
    }),
  );

  store.add(
    api.commands.registerCommand(
      TYPE_AT_CURSOR_COMMAND,
      guarded('Type at Cursor', async () => {
        const editor = activeFile();
        if (editor === undefined) {
          return;
        }
        const result = await hoverAt(hoverDeps, editor.document, editor.selection.active, 'command');
        switch (result.kind) {
          case 'noName':
            notify(NO_NAME);
            return;
          case 'unavailable':
            notify(`Idris 2: ${result.reason}`);
            return;
          case 'noType':
            notify(
              result.stale
                ? `Idris 2: no type for ${quoted(result.occurrence.name)} here: the compiler answers about the file as it last checked it, ` +
                    `and the editor shows changes made since. ${recheckAdvice(result.staleness)}`
                : `Idris 2: the compiler has no type for ${quoted(result.occurrence.name)} here.`,
            );
            return;
          case 'model':
            await api.commands.executeCommand('editor.action.showHover');
            return;
        }
      }),
    ),
  );

  // --- documentation documents ----------------------------------------------------------------

  /** What each open documentation document shows (for its semantic tokens), and its source file, by URI. */
  const shown = new Map<string, { readonly uri: vscode.Uri; readonly rich: RichText; readonly file: string }>();
  const docsChanged = store.add(new api.EventEmitter<vscode.Uri>());

  const askDocs = (doc: vscode.TextDocument, name: string, mode: 'passive' | 'command'): Promise<QueryOutcome<RichText | undefined>> => {
    const root = splitName(name).root;
    return answers.get(doc.fileName, docsKey(root, 'full'), () => deps.queries.run(doc, mode, (b) => b.docsFor(doc, root, 'full')));
  };

  const sourceDocument = async (uri: string): Promise<vscode.TextDocument> =>
    api.workspace.textDocuments.find((d) => d.uri.toString() === uri) ?? (await api.workspace.openTextDocument(api.Uri.parse(uri)));

  store.add(
    api.workspace.registerTextDocumentContentProvider(DOC_SCHEME, {
      onDidChange: docsChanged.event,
      provideTextDocumentContent: async (uri) => {
        const request = parseDocQuery(uri.query);
        if (request === undefined) {
          return '';
        }
        let source: vscode.TextDocument;
        try {
          source = await sourceDocument(request.source);
        } catch (error) {
          deps.log.warn(`Intelligence: the documentation of ${request.name}: ${error instanceof Error ? error.message : String(error)}`);
          return `No documentation for ${request.name}: its file cannot be opened.`;
        }
        const outcome = await askDocs(source, request.name, 'passive');
        const rich: RichText =
          outcome.kind === 'unavailable'
            ? { text: `No documentation for ${request.name}: ${outcome.reason}`, spans: [] }
            : outcome.value === undefined
              ? { text: `No documentation for ${request.name}.`, spans: [] }
              : selectDocs(outcome.value, request.name);
        shown.set(uri.toString(), { uri, rich, file: source.fileName });
        return rich.text;
      },
    }),
  );
  store.add(api.workspace.onDidCloseTextDocument((doc) => shown.delete(doc.uri.toString())));
  // Refreshed when the source's own file is loaded, then asked again if that load made the answer
  // stale (`AnswerCache`). Not at a load of another file of its root, even one that built
  // something: the source is not the file loaded then, so the question gets `NotLoaded`, and unless
  // the source is the active document nothing loads it (a passive query), so the document would
  // show that it cannot answer instead of the docs it shows.
  store.add(
    deps.loads.onDidLoad(({ file }) => {
      for (const entry of shown.values()) {
        if (entry.file === file) {
          docsChanged.fire(entry.uri);
        }
      }
    }),
  );
  store.add(
    api.languages.registerDocumentSemanticTokensProvider(
      { scheme: DOC_SCHEME },
      {
        provideDocumentSemanticTokens: (doc) => {
          const entry = shown.get(doc.uri.toString());
          return entry === undefined ? undefined : new api.SemanticTokens(Uint32Array.from(encodeRichText(entry.rich)));
        },
      },
      new api.SemanticTokensLegend([...SEMANTIC_TOKEN_LEGEND], []),
    ),
  );

  /** Opens the documentation of `name` beside `doc`'s editor, or says why there is none. */
  const showDocumentation = async (doc: vscode.TextDocument, name: string): Promise<void> => {
    const outcome = await askDocs(doc, name, 'command');
    if (outcome.kind === 'unavailable') {
      notify(`Idris 2: ${outcome.reason}`);
      return;
    }
    if (outcome.value === undefined) {
      notify(`Idris 2: the compiler has no documentation for ${quoted(name)}.`);
      return;
    }
    const uri = api.Uri.from({ scheme: DOC_SCHEME, path: docPath(name), query: docQuery({ source: doc.uri.toString(), name }) });
    const document = await api.workspace.openTextDocument(uri);
    await api.window.showTextDocument(document, { viewColumn: api.ViewColumn.Beside, preview: true, preserveFocus: true });
  };

  store.add(
    api.commands.registerCommand(
      DOCS_AT_CURSOR_COMMAND,
      guarded('Docs at Cursor', async () => {
        const editor = activeFile();
        if (editor === undefined) {
          return;
        }
        const { occurrence } = await nameAt(hoverDeps, editor.document, editor.selection.active);
        if (occurrence === undefined) {
          notify(NO_NAME);
          return;
        }
        if (occurrence.decor === 'bound') {
          // `:docs-for` looks names up globally: it would document a global the local shadows.
          notify(`Idris 2: ${quoted(occurrence.name)} is a local variable, which has no documentation.`);
          return;
        }
        await showDocumentation(editor.document, occurrence.name);
      }),
    ),
  );

  store.add(
    api.commands.registerCommand(
      SHOW_DOCUMENTATION_COMMAND,
      guarded('Show Documentation', async () => {
        const editor = activeFile();
        if (editor === undefined) {
          return;
        }
        const { occurrence } = await nameAt(hoverDeps, editor.document, editor.selection.active);
        const name = await api.window.showInputBox({
          title: 'Idris 2: Show Documentation',
          prompt: 'The name to show the documentation of, as this file sees it (e.g. map, or Data.Vect.index)',
          value: occurrence === undefined || occurrence.decor === 'bound' ? '' : occurrence.name,
        });
        if (name !== undefined && name.trim() !== '') {
          await showDocumentation(editor.document, name.trim());
        }
      }),
    ),
  );

  store.add(
    api.commands.registerCommand(
      BROWSE_NAMESPACE_COMMAND,
      guarded('Browse Namespace', async () => {
        const editor = activeFile();
        if (editor === undefined) {
          return;
        }
        const doc = editor.document;
        const model = syntaxModelOf(doc);
        const typed = await api.window.showInputBox({
          title: 'Idris 2: Browse Namespace',
          prompt: 'A namespace, e.g. Data.Vect: its names visible from this file are listed (its module must be imported here, or be this file)',
          value: namespaceSuggestion(model, model === undefined ? 0 : offsetOf(model, editor.selection.active)),
        });
        const ns = typed?.trim();
        if (ns === undefined || ns === '') {
          return;
        }
        const outcome = await deps.queries.run(doc, 'command', (b) => b.browseNamespace(doc, ns));
        if (outcome.kind === 'unavailable') {
          notify(`Idris 2: ${outcome.reason}`);
          return;
        }
        if (outcome.value.length === 0) {
          notify(`Idris 2: no names of ${quoted(ns)} are visible from this file: the namespace is unknown, not imported here, or exports nothing visible.`);
          return;
        }
        const picked = await api.window.showQuickPick(outcome.value.map(namespaceItem), {
          title: 'Idris 2: Browse Namespace',
          placeHolder: 'Pick a name to show its documentation',
          matchOnDescription: true,
        });
        if (picked !== undefined) {
          await showDocumentation(doc, `${ns}.${picked.entry.name}`);
        }
      }),
    ),
  );

  // --- Go to Definition -------------------------------------------------------------------------

  store.add(
    api.languages.registerDefinitionProvider(selector, {
      provideDefinition: async (doc, pos) => {
        if (!isCheckable(doc)) {
          return undefined;
        }
        const { occurrence, backend } = await nameAt(hoverDeps, doc, pos);
        if (occurrence === undefined || !backend.caps.definition) {
          return undefined;
        }
        if (occurrence.decor === 'bound') {
          // A local variable: the compiler finds definitions by name only (`:name-at`, whose
          // positional form is a stub, F2, F3), so it would find a global of the same name. Nothing
          // is shown (module comment: a Cmd-hover asks too).
          deps.log.debug(`Intelligence: Go to Definition of the local variable ${editorLabel(occurrence.name, MAX_QUOTED_NAME)}: not looked up (by name the compiler would find a global).`);
          return undefined;
        }
        // Not kept here: the backend keeps what it asked and read per load, and moves the ranges to
        // the text the target documents show at each call (`IdrisBackend.definition`).
        const outcome = await deps.queries.run(doc, 'passive', (b) =>
          b.definition(doc, hoverDeps.position(occurrence.range.start), occurrence.name, occurrence.decor, occurrence.namespace),
        );
        if (outcome.kind === 'unavailable') {
          // Not a notification (module comment: a Cmd-hover asks too), but in the log, at the level
          // of the local variable's reason above (a Cmd-hover over many words would fill it).
          deps.log.debug(`Intelligence: Go to Definition of ${editorLabel(occurrence.name, MAX_QUOTED_NAME)}: ${editorLabel(outcome.reason)}`);
          return undefined;
        }
        return outcome.value;
      },
    }),
  );

  // --- semantic tokens ---------------------------------------------------------------------------

  // The index changes with loads only. Not on `registry.onDidChange`, which IDE mode fires at
  // every request (`AnswerCache`): VS Code would ask for every visible document's tokens each time.
  const tokensChanged = store.add(new api.EventEmitter<void>());
  store.add(deps.loads.onDidLoad(() => tokensChanged.fire()));
  store.add(
    api.languages.registerDocumentSemanticTokensProvider(
      selector,
      {
        onDidChangeSemanticTokens: tokensChanged.event,
        provideDocumentSemanticTokens: async (doc) => {
          if (!isCheckable(doc)) {
            return undefined;
          }
          const { backend, tokens } = await documentTokens(hoverDeps, doc);
          if (!backend.caps.semanticTokens || tokens === undefined) {
            return undefined;
          }
          return new api.SemanticTokens(Uint32Array.from(encodeTokens(tokens, doc)));
        },
      },
      new api.SemanticTokensLegend([...SEMANTIC_TOKEN_LEGEND], []),
    ),
  );

  // --- document symbols and highlights ---------------------------------------------------------

  const withBackend = async (doc: vscode.TextDocument, capability: 'documentSymbols' | 'documentHighlights'): Promise<boolean> =>
    isCheckable(doc) && deps.registry.backendFor(await deps.projects.classify(doc.fileName)).caps[capability];

  store.add(
    api.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols: async (doc) => {
        const model = syntaxModelOf(doc);
        if (model === undefined || !(await withBackend(doc, 'documentSymbols'))) {
          return undefined;
        }
        const at = (offset: number): vscode.Position => hoverDeps.position(positionOf(model, offset));
        const convert = (s: DocumentSymbolModel): vscode.DocumentSymbol => {
          const symbol = new api.DocumentSymbol(
            s.name,
            s.detail,
            api.SymbolKind[s.kind],
            new api.Range(at(s.range.start), at(s.range.end)),
            new api.Range(at(s.selection.start), at(s.selection.end)),
          );
          symbol.children = s.children.map(convert);
          return symbol;
        };
        return documentSymbols(model).map(convert);
      },
    }),
  );

  store.add(
    api.languages.registerDocumentHighlightProvider(selector, {
      provideDocumentHighlights: async (doc, pos) => {
        if (!(await withBackend(doc, 'documentHighlights'))) {
          return undefined;
        }
        const { occurrence, tokens } = await nameAt(hoverDeps, doc, pos);
        if (occurrence === undefined || tokens === undefined) {
          return undefined;
        }
        return documentHighlights(tokens, occurrence, syntaxModelOf(doc))?.map((r) => new api.DocumentHighlight(range(r)));
      },
    }),
  );

  return { notices, dispose: () => store.dispose() };
}
