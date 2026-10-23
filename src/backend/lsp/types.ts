/**
 * The contracts of the idris2-lsp layer (`backend/lsp/`, docs/ARCHITECTURE.md §2, §3.2, §4, §5.3;
 * ROADMAP M5): what the language client (`client.ts`, `middleware.ts`, `commands.ts`), the backend
 * (`backend.ts`, `edits.ts`, `holes.ts`) and the routing (`backend/registry.ts`,
 * `features/backend/`) agree on, and the two constants the manifest's settings depend on. Types and
 * constants only, with type imports from `vscode` and `vscode-languageclient` (whose protocol types
 * are those of `vscode-languageserver-protocol`), so the module has no runtime dependency and unit
 * tests import it on plain Node.
 *
 * **The server**, as read in idris2-lsp `9a2f0ad` and lsp-lib `512504c` (the commits pack installed,
 * docs/as-built/M5.md) [src, unless tagged otherwise; ROADMAP §0 F20, F26, F28, F34, F35]:
 *
 * - It is started with no arguments (`main`, `Server/Main.idr` 211–218) and speaks JSON-RPC over
 *   its standard input and output. At start it adds its working directory to the compiler's
 *   library directories (`addLibDir cwd`, `startServer`), so it is started in a trusted workspace
 *   folder, through `core/process.ts` `startLongRunningProcess` (ROADMAP M5, security).
 * - It keeps one loaded file (`openFile`) and declares `workspaceFolders.supported = false`
 *   (`Server/Capabilities.idr`). It loads a file at `didOpen` and `didSave`, and before answering a
 *   request about a file it has not loaded (`loadURI`, `withURI`; `Server/ProcessMessage.idr`
 *   197–297): it changes its working directory to the file's folder, finds the `.ipkg` above it
 *   (`findIpkg`) and builds the file and its imports, which runs the elaborator scripts they reach.
 *   So no document of a root may reach it before that root is admitted (`LspOwnership`). Without an
 *   `.ipkg` it publishes nothing for an opened file and logs `LOG ERROR:Server: … Source file "<abs>" is
 *   not in the source directory ""`; a request about such a file it has not opened answers that text
 *   with code 4, one about an opened one `null` or `[]`; an `.ipkg` deleted while it runs is not
 *   reported at all [live, recordings `loose-file`, `ipkg-deleted`; ROADMAP §0 F35 as corrected in M5:
 *   the `Cannot find the ipkg file` branch of `loadURI` cannot run with Idris2 `1c630e6`, whose
 *   `findIpkg (Just f)` returns the file itself when it finds no `.ipkg`, `Idris/Package.idr`
 *   1093–1110].
 * - Positions: a `Location` it sends carries the compiler's line and column as they are
 *   (`mkLocation'`, `Language/LSP/Definition.idr` 22–51), and it reads a request's `character` as
 *   the compiler's column (`findPointInTreeLoc (line, col)` in the code actions). The compiler counts
 *   columns in code points (E14) and, in a bird-track file, in unlit columns and lines (F11), where
 *   LSP counts UTF-16 units of the file's own lines; so on a line with characters outside the BMP,
 *   and in literate files, the two differ — `core/positions.ts` converts [live for a bird-track file,
 *   recording `lit2`: unlit columns, and lines shifted below a line of `> ` and spaces; a line with a
 *   character outside the BMP was not recorded].
 * - Log lines are `LOG <SEVERITY>:<topic>: <text>`, written to its standard error or to `logFile`
 *   (`log`, `Server/Log.idr` 76–82), with SEVERITY in capitals — `DEBUG`, `INFO`, `WARNING`, `ERROR`,
 *   `CRITICAL` (`Show Severity`, lsp-lib `Language/LSP/Severity.idr`) [live: `DEBUG`, `INFO`,
 *   `WARNING`, `ERROR` in the recordings]; F35's `LOG Error:Server: …` was wrong. At `debug`, its
 *   default, it logs every message it receives with its content (`handleMessage`: `Received message:
 *   …`), the text of the documents included.
 * - Its `serverInfo.version` is the constant `"0.1"` (F20); `idris2-lsp --version` names its build.
 */
import type * as vscode from 'vscode';
import type { CodeAction, CodeActionParams, Location, SymbolInformation } from 'vscode-languageclient';
import type { LspLogSeverity } from '../../core/config';
import type { IDisposable } from '../../core/disposable';
import type { Event } from '../../core/event';

/**
 * The `LanguageClient`'s id. vscode-languageclient 10.1.2 reads the setting `<id>.trace.server`
 * itself (`refreshTrace`, `lib/common/client.js` 1509–1534 [src]), so this id makes it read
 * `idris2.lsp.trace.server`. It writes the trace only while its trace channel's log level is
 * `Trace`, and then reads `off` as `messages` (same lines), which is why the setting offers
 * `messages` and `verbose` only.
 */
export const LSP_CLIENT_ID = 'idris2.lsp';

/**
 * The `LanguageClient`'s name, which vscode-languageclient also gives its output channel when the
 * options name none (`outputChannel`, `lib/common/client.js` 531–539 [src]): the channel of **Idris 2:
 * Show Language Server Output**. The server's standard error and the client's trace go there (the
 * client gets no separate `traceOutputChannel`; the setting `idris2.lsp.trace.server` names this
 * channel).
 */
export const LSP_CLIENT_NAME = 'Idris 2 Language Server';

/**
 * The object the client sends as `initializationOptions` and as the `settings` of every
 * `workspace/didChangeConfiguration` (sent by the client itself, not through
 * `synchronize.configurationSection`, which nests keys by section; D8): idris2-lsp's
 * `processSettings` reads these keys from the top level (F20; `Server/ProcessMessage.idr` 137–189),
 * ignoring a key it does not find and logging one of the wrong type. Built from `core/config.ts`
 * `LspSettings`; a change applies to the running server and restarts nothing.
 */
export interface LspServerOptions {
  /**
   * Left out when `idris2.lsp.logFile` is empty: the server refuses a path that is not absolute (it
   * logs an error, `changeLogFile`, `Server/Log.idr` 106–117) and has no way back to standard error,
   * so clearing the setting takes effect when the server starts again (the setting says so).
   */
  readonly logFile?: string;
  readonly logSeverity: LspLogSeverity;
  /** Milliseconds (`setSearchTimeout`). */
  readonly longActionTimeout: number;
  readonly maxCodeActionResults: number;
  readonly showImplicits: boolean;
  readonly showMachineNames: boolean;
  readonly fullNamespace: boolean;
  readonly briefCompletions: boolean;
}

// -------------------------------------------------------------------------------------------
// workspace/executeCommand
// -------------------------------------------------------------------------------------------

/**
 * The commands the server handles in `workspace/executeCommand` (`handleRequest
 * WorkspaceExecuteCommand`, `Server/ProcessMessage.idr` 512–546). It advertises `repl`,
 * `exprSearchWithHints`, `refineHoleWithHints` and `metavars` (`executeCommandOptions`,
 * `Server/Capabilities.idr`) but handles `refineHole`, not `refineHoleWithHints`, and also the
 * unadvertised `browseNamespace` (F20); another command, or arguments of another shape, is answered
 * with an error (`methodNotFound`, `invalidParams`).
 */
export type LspCommandName = 'repl' | 'metavars' | 'exprSearchWithHints' | 'refineHole' | 'browseNamespace';

/** The `arguments` of each command. */
export interface LspCommandArguments {
  /**
   * One text, which the server hands to the compiler's REPL (`interpret`, as IDE mode's `:interpret`
   * does), in the context of the file it loaded last: the REPL's parser reads `:` commands (`:exec`,
   * `:sh`, `:set …`) [src; live, E10, recording `repl`: `:t id` and `:version` ran]. So
   * `LspClientHandle.executeCommand` refuses such text with M3's `replCommandRefusal` before anything
   * is sent (ROADMAP M5, security). Evaluate does not use it (`backend.ts`): only the developer
   * command sends `repl`, raw.
   */
  readonly repl: readonly [text: string];
  /** None: the server ignores the arguments. */
  readonly metavars: readonly [];
  readonly exprSearchWithHints: readonly [ExprSearchWithHintsParams];
  readonly refineHole: readonly [RefineHoleParams];
  /** A namespace, which the server parses as the compiler's `namespaceId` (`[]` when it does not parse). */
  readonly browseNamespace: readonly [namespace: string];
}

/** The answer of each command (the `result` of the response). */
export interface LspCommandResults {
  /** The REPL's answer, printed without colour (`replResultToDoc`, `render`). */
  readonly repl: string;
  readonly metavars: readonly LspMetavar[];
  /**
   * One action per result, at most `maxCodeActionResults`, each titled `Expression search on <hole>
   * as ~ <the result's first 50 characters> ...` with a `WorkspaceEdit` that replaces the range the
   * compiler recorded for the hole's name by the whole result (`Language/LSP/CodeAction/ExprSearch.idr`
   * 51–66, 76–116; F34).
   */
  readonly exprSearchWithHints: readonly CodeAction[];
  /**
   * At most one action, titled `Refine hole on <hole>`; none when the compiler answers with an error,
   * an ambiguity included (`RefineHole.idr` 53–97; F34): ambiguity is not reported.
   */
  readonly refineHole: readonly CodeAction[];
  /**
   * The names the namespace exports that are not private, sorted, each with `name` = `<name> :
   * <type>`, a kind and a location (`browseNamespaceCmd`, `Language/LSP/BrowseNamespace.idr`); a name
   * without a location in a file is left out.
   */
  readonly browseNamespace: readonly SymbolInformation[];
}

/**
 * `ExprSearchWithHintsParams` (`Language/LSP/CodeAction/ExprSearch.idr` 34–39): the code action
 * request to answer and names for the search to use; each hint is parsed as a name and looked up,
 * and one that does not parse or is not found is dropped (`exprSearchWithHints`, 129–143).
 */
export interface ExprSearchWithHintsParams {
  readonly codeAction: CodeActionParams;
  readonly hints: readonly string[];
}

/**
 * `RefineHoleParams` (`RefineHole.idr` 38–43): `hint` is parsed as an expression (`aPTerm`) and the
 * hole refined with it (`Refine False line hole hint`), so, as in IDE mode, it can run the elaborator
 * scripts it reaches (ROADMAP §9 Q24).
 */
export interface RefineHoleParams {
  readonly codeAction: CodeActionParams;
  readonly hint: string;
}

/**
 * One hole of `metavars` (`Language/LSP/Metavars.idr` 35–51, 85–111; F26): a user hole of the
 * compiler's context after the server's last load (`getUserHoles`), printed without colour. The holes
 * of the modules the file imports are listed too, as IDE mode's are (E16), and the holes a refinement
 * or an Intro made, without a location [live, recordings `holes-ipkg`, `ambig`].
 */
export interface LspMetavar {
  /** `show` of the hole's name, which is qualified (`Clean.vlen_rhs`) [src; live]. */
  readonly name: string;
  /** Where the hole is (`mkLocation` of its definition; positions as in the module comment); absent or `null` without one. */
  readonly location?: Location | null;
  /** The goal, printed with the printing options (`showImplicits`, …). */
  readonly type: string;
  readonly premises: readonly LspPremise[];
}

/** One premise of an `LspMetavar`. */
export interface LspPremise {
  readonly name: string;
  /** Absent [live: no premise of the recordings has the field]; the source builds it from `replFC`, which is no position in a file (`mapContext`). */
  readonly location?: Location | null;
  readonly type: string;
  /** `show` of the compiler's multiplicity: `Rig0`, `Rig1` or `RigW` (`Algebra/ZeroOneOmega.idr` 40–43 on Idris2 `1c630e6`; `Rig1` not recorded). */
  readonly multiplicity: string;
  readonly isImplicit: boolean;
}

// -------------------------------------------------------------------------------------------
// Routing ↔ client
// -------------------------------------------------------------------------------------------

/**
 * Which documents may reach the server (ROADMAP M5, security; ARCHITECTURE §3.2): implemented by
 * the routing (`backend/registry.ts`), asked by the client's middleware before it lets a
 * notification (`didOpen`, `didChange`, `didSave`, `didClose`) or a provider's request about a
 * document through, and by `LspClientHandle` before every request it sends about one. Ownership is
 * enforced here and not by the client's `documentSelector`, so that a root can change backend
 * without restarting the client (D7).
 */
export interface LspOwnership {
  /**
   * True only when all of these hold now: the workspace is trusted; `uri` is a `file:` Idris document
   * whose root (`ProjectIndex.classify`) has an `.ipkg` and is served by idris2-lsp
   * (`idris2.backend.mode`, **Switch Backend…**); and the root's folder lies inside a trusted
   * workspace folder or the consent gate has allowed it (`SessionGate.current`, M2). It never asks
   * the consent question: the routing asks it when such a document is opened, and fires `onDidChange`
   * once the answer changes what this returns.
   */
  admits(uri: vscode.Uri): Promise<boolean>;
  /**
   * Fires when `admits` may answer differently for some document: a change of the routing, a consent
   * answer or revocation, trust granted, an `.ipkg` created or deleted.
   */
  readonly onDidChange: Event<void>;
}

/**
 * The client's process, for the status, the commands and the routing:
 * - `notStarted` — no process yet: it starts with the first admitted document;
 * - `starting` — the process runs and has not answered `initialize` yet;
 * - `running`;
 * - `stopped` — stopped by **Idris 2: Stop Language Server** (the status reads `stopped`); what
 *   starts it again is `client.ts`'s documented choice;
 * - `failed` — given up (it could not be started, or ended too often); `reason` is one sentence.
 */
export type LspClientState =
  | { readonly kind: 'notStarted' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'running' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The language client as the backend, the commands and the routing use it (`client.ts`). Every
 * request is about a document, `about`, and is sent only when `LspOwnership.admits(about)` holds —
 * the one way the extension's own code reaches the server, as `IdeBackend.load` is IDE mode's (M2).
 * A request rejects with an `IdrisException` (`core/errors.ts`): `Unsupported`, having sent nothing,
 * when `about` is not admitted, the workspace is untrusted or the server cannot run (the reason says
 * which); `BackendCrashed` when the server ended before answering; `RequestTimeout`; or with the
 * `Cancelled` error when `token` is cancelled. A server's error response rejects with `LoadFailed`
 * when it is a missing-`.ipkg` error (`client.ts` `isMissingIpkgError`: code 4 `… is not in the source
 * directory ""` [live], or the source's code 3 `Cannot find the ipkg file`) and with `ProtocolError`
 * otherwise, its message kept as the server's untrusted text.
 */
export interface LspClientHandle extends IDisposable {
  readonly state: LspClientState;
  readonly onDidChangeState: Event<void>;
  /**
   * Fires when the server says it cannot load a document for want of an `.ipkg` (the F35 safety net,
   * for a root the routing gave idris2-lsp although the server finds no `.ipkg` for it): a response
   * error of that kind (`client.ts` `isMissingIpkgError`), or such a log line on the server's
   * standard error (`missingIpkgInLog`; only while `idris2.lsp.logFile` is empty). `uri` is the
   * document's when known. It is not guaranteed to come: an `.ipkg` deleted while the server runs is
   * never reported, and the server goes on loading with its options [live, recording
   * `ipkg-deleted`]. The routing shows the one-time notification.
   */
  readonly onDidReportMissingIpkg: Event<{ readonly uri?: vscode.Uri }>;
  /** A request (`textDocument/codeAction`, …) about `about`; starts the client first when it has not started. */
  request<R>(about: vscode.Uri, method: string, params: object, token?: vscode.CancellationToken): Promise<R>;
  /** `workspace/executeCommand` of `command` with `args`, about `about` (the document whose context answers). */
  executeCommand<C extends LspCommandName>(
    about: vscode.Uri,
    command: C,
    args: LspCommandArguments[C],
    token?: vscode.CancellationToken,
  ): Promise<LspCommandResults[C]>;
  /**
   * The URI the server is sent for the document `uri` (`middleware.ts` `ServerPaths`: the real path of
   * its folder joined with its name), for the parameters of a request built here.
   */
  serverUri(uri: vscode.Uri): string;
  /** The document a URI the server wrote names (the one sent as it, else the URI as it is). */
  documentUri(value: string): vscode.Uri;
  /** **Idris 2: Stop Language Server**: state `stopped`. */
  stop(): Promise<void>;
  /** **Idris 2: Restart Language Server**: stops the process if one runs and starts a new one. */
  restart(): Promise<void>;
}
