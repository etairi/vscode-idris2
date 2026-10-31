/**
 * `BackendRegistry` (`backend/registry.ts` in docs/ARCHITECTURE.md §2, §3.2): which backend serves
 * a project root, what its process is doing, and the status label derived from both; since M5 also
 * the routing between IDE mode and idris2-lsp and which documents may reach the server.
 *
 * A root is a `Classification` of the project index (ARCHITECTURE §3.2): the directory of the
 * nearest `.ipkg` (a `ProjectRoot`), else a loose file's directory. Roots are found lazily, as
 * documents are classified, so a backend is not registered root by root: a `BackendProvider`
 * serves every root it is asked about. One provider of each kind may be set: IDE mode
 * (`backend/ide/backend.ts`, M2) and idris2-lsp (`LspProvider` below, over `backend/lsp/`, M5).
 * Without a provider for the route of a root, the root is served by `NullBackend` and the status
 * reads `· syntax only` (principle 4).
 *
 * **Routing** (M5; the user's decision of 2026-10-01 on ROADMAP §9 Q7). `decideRoute` is the policy
 * of `idris2.backend.mode`, per root:
 *
 * | wish (the root's **Switch Backend…** choice, else the setting) | root with an `.ipkg` | loose file |
 * |---|---|---|
 * | `ideMode` | IDE mode | IDE mode |
 * | `lsp` | idris2-lsp | none: idris2-lsp cannot load it (F20; the one-time notification, `features/backend`) |
 * | `auto`, a usable `idris2` or not known yet | IDE mode | IDE mode |
 * | `auto`, no usable `idris2`, a usable idris2-lsp that is not a likely mismatch | idris2-lsp | none, as above |
 * | `auto`, neither | IDE mode (which reports the missing compiler, M1) | IDE mode |
 *
 * "Usable" is read from the last toolchain scan (`availability`): a tool whose `--version` answered
 * (`probed`); "not known yet" is before the first trusted scan finished (in Restricted Mode nothing
 * runs anyway). `auto` takes idris2-lsp only when the pair verdict (`toolchain/verdict.ts`, which
 * pairs the server with the compiler of its own installation since M5) is not `likelyMismatch`: an
 * automatic choice should not start a server the extension expects not to work; the user's own
 * choice (`lsp`, **Switch Backend…**) is followed whatever the verdict says, which M1's notification
 * and the status report. One backend serves a root, with no secondary
 * one and no fallback per feature: a feature the chosen backend lacks answers `Unsupported` with
 * the reason (ARCHITECTURE §3.1), which each backend gives itself.
 *
 * A root routed to idris2-lsp while the scan found no usable server reads `failed` with the scan's
 * reason (`stateFor`); its backend is still the LSP provider's, whose requests the client refuses
 * (`backend/lsp/types.ts` `LspClientHandle`). A loose file under `lsp` (and under `auto` when only
 * the server is usable) is served by nothing: `UnservedBackend`, which answers every call with
 * `Unsupported` and that reason.
 *
 * **Which documents reach the server** (`LspAdmission`, the `LspOwnership` of
 * `backend/lsp/types.ts`; ROADMAP M5, security): only a `file:` Idris document of a root routed to
 * idris2-lsp, in a trusted workspace, whose root's folder lies inside a trusted workspace folder or
 * was allowed by the consent gate of M2 — the server changes to a file's folder and builds it,
 * which can run elaborator scripts. `admits` never asks the question; `features/backend` asks it
 * when such a document is shown.
 *
 * No runtime dependency on `vscode` (type imports only), so it is unit-tested on plain Node.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import type { BackendMode } from '../core/config';
import { DisposableStore, type IDisposable } from '../core/disposable';
import { unsupported } from '../core/errors';
import { Emitter, type Event } from '../core/event';
import type { SessionGate, WorkspaceTrust } from '../core/trust';
import { compilerReadsPathAsGiven } from '../project/ipkg';
import { isIdrisDocument, isIdrisSourceFileName } from '../project/literate';
import type { Classification, ProjectIndex } from '../project/types';
import type { ToolchainService, ToolchainSnapshot } from '../toolchain/types';
import type { LspClientHandle, LspClientState, LspOwnership } from './lsp/types';
import { NullBackend } from './null';
import type { BackendKind, EditResult, Evaluation, Hole, IdrisBackend, LoadResult, NamespaceEntry, RichText, TypeInfo } from './types';

/** The backend part of the status text (`Idris 2 0.8.0 · <label>`, ARCHITECTURE §3.2). */
export type BackendLabel = 'syntax only' | 'IDE mode' | 'idris2-lsp';

const LABELS: Readonly<Record<BackendKind, BackendLabel>> = {
  null: 'syntax only',
  ideMode: 'IDE mode',
  lsp: 'idris2-lsp',
};

/**
 * What the backend of a root is doing, for the status item (ARCHITECTURE §3.2 `stopped`, §5.1):
 * - `none` — no process: none was needed yet, or it was stopped for being idle (the next request
 *   starts one; the results shown still hold);
 * - `active` — a process is starting, running, or being restarted after a crash;
 * - `stopped` — stopped on request (**Idris 2: Stop Backend**, **Stop Language Server**), or
 *   because the permission for its directory was revoked (`revokedDir`: that directory; the next
 *   request asks again);
 * - `failed` — given up (repeated crashes, a process that cannot be started, an unsupported
 *   protocol version, no usable server) until it is restarted; `reason` is one sentence;
 * - `notAllowed` — the user did not allow a process in `dir` (**Don't Allow**, or the question was
 *   closed), which lies outside the trusted workspace folders (ROADMAP §9, 2026-09-27).
 */
export type BackendState =
  | { readonly kind: 'none' }
  | { readonly kind: 'active' }
  | { readonly kind: 'stopped'; readonly revokedDir?: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'notAllowed'; readonly dir: string; readonly reason: 'denied' | 'unanswered' };

/** Serves every root it is asked about. */
export interface BackendProvider {
  readonly kind: BackendKind;
  backendFor(root: Classification): IdrisBackend;
  stateFor(root: Classification): BackendState;
  /** Fires when `stateFor` may answer differently for some root. */
  readonly onDidChangeState: Event<void>;
}

/**
 * The registry key of a root. A project is identified by its `.ipkg` (the one the compiler's
 * `findIpkg` picks), a loose file by its directory; the prefixes keep the two apart when a
 * directory gains an `.ipkg` and a loose-file root becomes a project root.
 */
export function rootKey(root: Classification): string {
  return root.kind === 'project' ? `project:${root.ipkgPath}` : `loose:${root.dir}`;
}

// -------------------------------------------------------------------------------------------
// The policy (module comment, *Routing*)
// -------------------------------------------------------------------------------------------

/** A root's choice of **Idris 2: Switch Backend…**, kept in the workspace state (`BackendChoices`). */
export type BackendChoice = 'ideMode' | 'lsp';

/** What a scan says of a tool: its `--version` answered, it did not (missing, failed), or no trusted scan has finished. */
export type Availability = 'usable' | 'unusable' | 'unknown';

export interface ToolchainAvailability {
  readonly idris2: Availability;
  readonly lsp: Availability;
  /** The pair verdict is `likelyMismatch`. */
  readonly lspLikelyMismatch: boolean;
  /** Why the server is not usable, from the scan; set when `lsp` is `unusable`. */
  readonly lspProblem?: string;
}

/** Where a root goes: one of the two backends, or nowhere (`none`, with why). */
export type Route = { readonly kind: 'ideMode' } | { readonly kind: 'lsp' } | { readonly kind: 'none'; readonly why: 'noIpkg' };

/** The `Unsupported` reason of a root routed nowhere, and the start of its status detail. */
export const NO_IPKG_REASON =
  'idris2-lsp loads a file only when an .ipkg file lies in its folder or a folder above it, and this file has none';

/** The tools as `decideRoute` sees them, from a scan (`undefined`: none has finished). */
export function availability(snapshot: ToolchainSnapshot | undefined): ToolchainAvailability {
  if (snapshot === undefined || !snapshot.trusted) {
    return { idris2: 'unknown', lsp: 'unknown', lspLikelyMismatch: false };
  }
  const lsp = snapshot.lsp;
  return {
    idris2: snapshot.idris2.status === 'probed' ? 'usable' : 'unusable',
    lsp: lsp.status === 'probed' ? 'usable' : 'unusable',
    lspLikelyMismatch: snapshot.verdict?.kind === 'likelyMismatch',
    ...(lsp.status === 'missing' || lsp.status === 'failed' ? { lspProblem: lsp.reason } : {}),
  };
}

/** The policy table of the module comment, for a root of kind `rootKind` (`project`: it has an `.ipkg`). */
export function decideRoute(
  rootKind: Classification['kind'],
  mode: BackendMode,
  choice: BackendChoice | undefined,
  tools: ToolchainAvailability,
): Route {
  const toServer = (): Route => (rootKind === 'project' ? { kind: 'lsp' } : { kind: 'none', why: 'noIpkg' });
  const wish = choice ?? mode;
  if (wish === 'ideMode') {
    return { kind: 'ideMode' };
  }
  if (wish === 'lsp') {
    return toServer();
  }
  if (tools.idris2 !== 'unusable') {
    return { kind: 'ideMode' };
  }
  if (tools.lsp === 'usable' && !tools.lspLikelyMismatch) {
    return toServer();
  }
  return { kind: 'ideMode' };
}

// -------------------------------------------------------------------------------------------
// The choices of Switch Backend (workspace state)
// -------------------------------------------------------------------------------------------

/** The part of a `vscode.Memento` the choices use (`context.workspaceState`). */
export interface ChoiceStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The workspace-state key of the choices: an object from `rootKey` to a `BackendChoice`. */
export const BACKEND_CHOICES_KEY = 'idris2.backendChoices';

/**
 * The per-root choices of **Idris 2: Switch Backend…**, remembered for the workspace (the user's
 * decision of 2026-10-01). A stored entry that is not a `BackendChoice` is ignored.
 */
export class BackendChoices implements IDisposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changed.event;

  constructor(private readonly storage: ChoiceStorage) {}

  private all(): Record<string, BackendChoice> {
    const stored = this.storage.get(BACKEND_CHOICES_KEY);
    const choices: Record<string, BackendChoice> = {};
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        if (value === 'ideMode' || value === 'lsp') {
          choices[key] = value;
        }
      }
    }
    return choices;
  }

  get(root: Classification): BackendChoice | undefined {
    return this.all()[rootKey(root)];
  }

  /** Records `choice` for `root`, or forgets the root's choice (`undefined`), then fires `onDidChange`. */
  async set(root: Classification, choice: BackendChoice | undefined): Promise<void> {
    const choices = this.all();
    if (choice === undefined) {
      delete choices[rootKey(root)];
    } else {
      choices[rootKey(root)] = choice;
    }
    await this.storage.update(BACKEND_CHOICES_KEY, choices);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

// -------------------------------------------------------------------------------------------
// The routing
// -------------------------------------------------------------------------------------------

/** What the registry asks of the routing. */
export interface Routing {
  routeFor(root: Classification): Route;
  /** The route of a file whose root is still being classified (the status shows its label). */
  pendingRoute(): Route;
  /** Why the server cannot serve the roots routed to it, from the last scan; `undefined` when it may. */
  lspProblem(): string | undefined;
  /** Fires when `routeFor` may answer differently for some root. */
  readonly onDidChange: Event<void>;
}

export interface RoutingDeps {
  /**
   * `idris2.backend.mode` for `root`'s folder (`resource` scope: `Config.backendMode` with the
   * folder's URI); for `undefined`, the window's value.
   */
  modeFor(root: Classification | undefined): BackendMode;
  /** Fires after `idris2.backend.mode` changed in any scope. */
  readonly onDidChangeMode: Event<void>;
  readonly choices: Pick<BackendChoices, 'get' | 'onDidChange'>;
  readonly toolchain: Pick<ToolchainService, 'current' | 'onDidChange'>;
}

/** `decideRoute` over the setting, the choices and the last scan. */
export class BackendRouting implements Routing, IDisposable {
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange: Event<void> = this.changed.event;
  /** The scan routes were last decided from: the service fires for every start and end of a scan, routes change only with a new snapshot. */
  private seen: ToolchainSnapshot | undefined;

  constructor(private readonly deps: RoutingDeps) {
    this.seen = deps.toolchain.current;
    this.store.add(deps.onDidChangeMode(() => this.changed.fire()));
    this.store.add(deps.choices.onDidChange(() => this.changed.fire()));
    this.store.add(
      deps.toolchain.onDidChange(() => {
        if (deps.toolchain.current !== this.seen) {
          this.seen = deps.toolchain.current;
          this.changed.fire();
        }
      }),
    );
  }

  routeFor(root: Classification): Route {
    return decideRoute(root.kind, this.deps.modeFor(root), this.deps.choices.get(root), availability(this.deps.toolchain.current));
  }

  pendingRoute(): Route {
    // As for a root with an .ipkg and no choice, under the window's setting.
    return decideRoute('project', this.deps.modeFor(undefined), undefined, availability(this.deps.toolchain.current));
  }

  lspProblem(): string | undefined {
    return availability(this.deps.toolchain.current).lspProblem;
  }

  dispose(): void {
    this.store.dispose();
  }
}

// -------------------------------------------------------------------------------------------
// Backends for roots without one
// -------------------------------------------------------------------------------------------

/** The backend of a root routed nowhere (`Route` `none`): every call is `Unsupported` with the reason. */
class UnservedBackend extends NullBackend {
  constructor(private readonly reason: string) {
    super();
  }

  private refuse(): Promise<never> {
    return Promise.reject(unsupported(`${this.reason}.`));
  }

  override load(): Promise<LoadResult> {
    return this.refuse();
  }
  override typeAt(): Promise<TypeInfo | undefined> {
    return this.refuse();
  }
  override docsFor(): Promise<RichText | undefined> {
    return this.refuse();
  }
  override definition(): Promise<vscode.Location[]> {
    return this.refuse();
  }
  override holes(): Promise<Hole[]> {
    return this.refuse();
  }
  override edit(): Promise<EditResult> {
    return this.refuse();
  }
  override completions(): Promise<readonly string[]> {
    return this.refuse();
  }
  override evaluate(): Promise<Evaluation> {
    return this.refuse();
  }
  override browseNamespace(): Promise<NamespaceEntry[]> {
    return this.refuse();
  }
}

const UNSERVED = new UnservedBackend(NO_IPKG_REASON);

// -------------------------------------------------------------------------------------------
// The registry
// -------------------------------------------------------------------------------------------

export class BackendRegistry implements IDisposable {
  private readonly providers = new Map<BackendKind, { readonly provider: BackendProvider; readonly events: IDisposable }>();
  private routing: { readonly routing: Routing; readonly events: IDisposable } | undefined;
  private readonly nullBackend = new NullBackend();
  private readonly changed = new Emitter<void>();
  private readonly routesChanged = new Emitter<void>();
  private disposed = false;

  /** Fires after a provider or the routing is set or removed, when a provider's state changes, and when routes change. */
  readonly onDidChange: Event<void> = this.changed.event;
  /**
   * Fires when `routeFor` or `backendFor` may answer differently for some root (a provider or the
   * routing set or removed, the routing changed) — not at a provider's state change, which IDE mode
   * reports twice per request.
   */
  readonly onDidChangeRoutes: Event<void> = this.routesChanged.event;

  private fireRoutes(): void {
    this.routesChanged.fire();
    this.changed.fire();
  }

  /**
   * Makes `provider` serve the roots routed to its kind until the returned subscription is
   * disposed. The caller keeps ownership of `provider` (the registry never disposes it). Setting a
   * second provider of a kind while one is set is a programming error and throws.
   */
  setProvider(provider: BackendProvider): IDisposable {
    if (this.disposed) {
      throw new Error('BackendRegistry is disposed');
    }
    if (this.providers.has(provider.kind)) {
      throw new Error(`a ${provider.kind} provider is already set`);
    }
    this.providers.set(provider.kind, { provider, events: provider.onDidChangeState(() => this.changed.fire()) });
    this.fireRoutes();
    let set = true;
    return {
      dispose: () => {
        const entry = this.providers.get(provider.kind);
        if (!set || entry?.provider !== provider) {
          return;
        }
        set = false;
        this.providers.delete(provider.kind);
        entry.events.dispose();
        this.fireRoutes();
      },
    };
  }

  /**
   * Routes each root with `routing` until the returned subscription is disposed (the caller keeps
   * ownership). Without a routing, IDE mode serves every root when its provider is set, else the
   * LSP provider does (M2's behaviour with one provider).
   */
  setRouting(routing: Routing): IDisposable {
    if (this.disposed) {
      throw new Error('BackendRegistry is disposed');
    }
    if (this.routing !== undefined) {
      throw new Error('a routing is already set');
    }
    const entry = { routing, events: routing.onDidChange(() => this.fireRoutes()) };
    this.routing = entry;
    this.fireRoutes();
    return {
      dispose: () => {
        if (this.routing === entry) {
          this.routing = undefined;
          entry.events.dispose();
          this.fireRoutes();
        }
      },
    };
  }

  /** Without a routing: IDE mode when its provider is set, else idris2-lsp when its provider is. */
  private defaultRoute(): Route {
    return this.providers.has('ideMode') || !this.providers.has('lsp') ? { kind: 'ideMode' } : { kind: 'lsp' };
  }

  /** Where `root` goes (module comment, *Routing*). */
  routeFor(root: Classification): Route {
    return this.routing?.routing.routeFor(root) ?? this.defaultRoute();
  }

  private backendOf(route: Route, root: Classification): IdrisBackend {
    if (route.kind === 'none') {
      return UNSERVED;
    }
    return this.providers.get(route.kind)?.provider.backendFor(root) ?? this.nullBackend;
  }

  /**
   * The backend serving `root`: the provider's of its route, else `NullBackend` (no provider of
   * that kind), or `UnservedBackend` for a root routed nowhere; also `NullBackend` for a document
   * that has no root (`undefined`: untitled or non-file documents, which the index does not
   * classify).
   */
  backendFor(root: Classification | undefined): IdrisBackend {
    return root === undefined ? this.nullBackend : this.backendOf(this.routeFor(root), root);
  }

  /** The status label of `root`, from the kind of the backend serving it. */
  labelFor(root: Classification | undefined): BackendLabel {
    return LABELS[this.backendFor(root).kind];
  }

  /**
   * The label of a file document whose root is still being classified, so that the status item
   * does not say `syntax only` while the project index answers: the provider's of the routing's
   * `pendingRoute` (that of a project root without a choice under the window's
   * `idris2.backend.mode`), or without a routing, of the route every root gets.
   */
  pendingLabel(): BackendLabel {
    const route = this.routing?.routing.pendingRoute() ?? this.defaultRoute();
    return route.kind === 'none' || !this.providers.has(route.kind) ? 'syntax only' : LABELS[route.kind];
  }

  /**
   * What the backend of `root` is doing; `undefined` when no provider serves it (no root, routed
   * nowhere, no provider of its route's kind). A root routed to idris2-lsp while the last scan found
   * no usable server is `failed` with the scan's reason.
   */
  stateFor(root: Classification | undefined): BackendState | undefined {
    if (root === undefined) {
      return undefined;
    }
    const route = this.routeFor(root);
    if (route.kind === 'none') {
      return undefined;
    }
    const provider = this.providers.get(route.kind)?.provider;
    if (provider === undefined) {
      return undefined;
    }
    const problem = route.kind === 'lsp' ? this.routing?.routing.lspProblem() : undefined;
    return problem !== undefined ? { kind: 'failed', reason: problem } : provider.stateFor(root);
  }

  /** Forgets the providers and the routing (which belong to whoever set them). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.providers.values()) {
      entry.events.dispose();
    }
    this.providers.clear();
    this.routing?.events.dispose();
    this.routing = undefined;
    this.changed.dispose();
    this.routesChanged.dispose();
  }
}

// -------------------------------------------------------------------------------------------
// idris2-lsp as a provider, and which documents reach it
// -------------------------------------------------------------------------------------------

/** The status of a root served by idris2-lsp, from the client's state (`LspClientState`). */
export function lspBackendState(state: LspClientState): BackendState {
  switch (state.kind) {
    case 'notStarted':
      return { kind: 'none' };
    case 'starting':
    case 'running':
      return { kind: 'active' };
    case 'stopped':
      return { kind: 'stopped' };
    case 'failed':
      return { kind: 'failed', reason: state.reason };
  }
}

export interface LspProviderDeps {
  /** The idris2-lsp backend (`backend/lsp/backend.ts`), which serves every root routed to it. */
  readonly backend: IdrisBackend;
  readonly client: Pick<LspClientHandle, 'state' | 'onDidChangeState'>;
  readonly gate: Pick<SessionGate, 'current' | 'onDidChange'>;
  readonly projects: Pick<ProjectIndex, 'sessionCwd'>;
}

/**
 * The registry's provider of kind `lsp`: one client serves every root routed to it (the server
 * keeps one open file, ARCHITECTURE §3.2), so its state is the client's for every root — except a
 * root whose folder the user did not allow (`notAllowed`, as IDE mode reports it).
 */
export class LspProvider implements BackendProvider, IDisposable {
  readonly kind: BackendKind = 'lsp';
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChangeState: Event<void> = this.changed.event;

  constructor(private readonly deps: LspProviderDeps) {
    this.store.add(deps.client.onDidChangeState(() => this.changed.fire()));
    this.store.add(deps.gate.onDidChange(() => this.changed.fire()));
  }

  backendFor(): IdrisBackend {
    return this.deps.backend;
  }

  stateFor(root: Classification): BackendState {
    const dir = this.deps.projects.sessionCwd(root);
    const verdict = this.deps.gate.current(dir);
    if (verdict !== undefined && !verdict.allowed && (verdict.reason === 'denied' || verdict.reason === 'unanswered')) {
      return { kind: 'notAllowed', dir, reason: verdict.reason };
    }
    return lspBackendState(this.deps.client.state);
  }

  dispose(): void {
    this.store.dispose();
  }
}

/**
 * Whether a file of this base name is an Idris document by its name alone: `.idr`, `.lidr`, or a
 * double extension `.idr.<ext>`/`.lidr.<ext>` of the selector (`project/literate.ts`), and a name the
 * compiler reads as a source (`isIdrisSourceFileName`, case-sensitive). A bare `Notes.md`, which
 * the compiler would read as literate Idris, is not (M12's).
 */
function isIdrisFileName(baseName: string): boolean {
  const byName = /\.l?idr$/.test(baseName) || isIdrisDocument({ languageId: '', fileName: baseName });
  return byName && isIdrisSourceFileName(baseName);
}

export interface LspAdmissionDeps {
  readonly trust: WorkspaceTrust;
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd' | 'onDidChange'>;
  readonly gate: Pick<SessionGate, 'recheck' | 'onDidChange'>;
  readonly registry: Pick<BackendRegistry, 'routeFor' | 'onDidChangeRoutes'>;
  readonly platform: NodeJS.Platform;
  /** The real path of a folder, `undefined` when it cannot be resolved (`lsp/client.ts` `realFolder`). */
  readonly realpath: (dir: string) => string | undefined;
}

/**
 * `LspOwnership` (`backend/lsp/types.ts`; module comment, *Which documents reach the server*): a
 * `file:` URI with an Idris file name (`isIdrisFileName`), whose path as the server is sent it the
 * compiler reads as given, as IDE mode refuses another (`ServerPaths`, `compilerReadsPathAsGiven`).
 * The route is read again after each wait, so that an answer reflects the routing when it is given.
 */
export class LspAdmission implements LspOwnership, IDisposable {
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange: Event<void> = this.changed.event;

  constructor(private readonly deps: LspAdmissionDeps) {
    const fire = (): void => this.changed.fire();
    this.store.add(deps.registry.onDidChangeRoutes(fire));
    this.store.add(deps.gate.onDidChange(fire));
    this.store.add(deps.trust.onDidGrant(fire));
    this.store.add(deps.projects.onDidChange(fire));
  }

  async admits(uri: vscode.Uri): Promise<boolean> {
    const { trust, projects, gate, registry, platform, realpath } = this.deps;
    if (!trust.isTrusted || uri.scheme !== 'file' || !isIdrisFileName(path.basename(uri.fsPath))) {
      return false;
    }
    const dir = platform === 'win32' ? undefined : realpath(path.dirname(uri.fsPath));
    if (!compilerReadsPathAsGiven(dir === undefined ? uri.fsPath : path.join(dir, path.basename(uri.fsPath)), platform)) {
      return false;
    }
    const root = await projects.classify(uri.fsPath);
    if (root.kind !== 'project' || registry.routeFor(root).kind !== 'lsp') {
      return false;
    }
    const verdict = await gate.recheck(projects.sessionCwd(root));
    return verdict?.allowed === true && trust.isTrusted && registry.routeFor(root).kind === 'lsp';
  }

  dispose(): void {
    this.store.dispose();
  }
}
