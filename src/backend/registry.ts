/**
 * `BackendRegistry` (`backend/registry.ts` in docs/ARCHITECTURE.md §2, §3.2): which backend serves
 * a project root, what its process is doing, and the status label derived from both.
 *
 * A root is a `Classification` of the project index (ARCHITECTURE §3.2): the directory of the
 * nearest `.ipkg` (a `ProjectRoot`), else a loose file's directory. Roots are found lazily, as
 * documents are classified, so a backend is not registered root by root: a `BackendProvider`
 * serves every root it is asked about. M2 registers one provider, IDE mode, for all roots
 * (`backend/ide/backend.ts`); without one every root is served by `NullBackend` and the status
 * reads `· syntax only` (principle 4). The routing policy of `idris2.backend.mode` — a provider
 * per root chosen between IDE mode and idris2-lsp, a secondary backend and per-feature fallback —
 * is M5's (ARCHITECTURE §3.2).
 *
 * No runtime dependency on `vscode`, so it is unit-tested on plain Node.
 */
import type { IDisposable } from '../core/disposable';
import { Emitter, type Event } from '../core/event';
import type { Classification } from '../project/types';
import { NullBackend } from './null';
import type { BackendKind, IdrisBackend } from './types';

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
 * - `stopped` — stopped on request (**Idris 2: Stop Backend**), or because the permission for its
 *   directory was revoked (`revokedDir`: that directory; the next request asks again); the next
 *   request starts it again;
 * - `failed` — given up (repeated crashes, a process that cannot be started, an unsupported
 *   protocol version) until it is restarted; `reason` is one sentence;
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

export class BackendRegistry implements IDisposable {
  private provider: BackendProvider | undefined;
  private providerEvents: IDisposable | undefined;
  private readonly nullBackend = new NullBackend();
  private readonly changed = new Emitter<void>();
  private disposed = false;

  /** Fires after a provider is set or removed, and when the provider's state changes. */
  readonly onDidChange: Event<void> = this.changed.event;

  /**
   * Makes `provider` serve every root until the returned subscription is disposed. The caller
   * keeps ownership of `provider` (the registry never disposes it). Setting a second provider
   * while one is set is a programming error and throws: choosing between two is M5's routing.
   */
  setProvider(provider: BackendProvider): IDisposable {
    if (this.disposed) {
      throw new Error('BackendRegistry is disposed');
    }
    if (this.provider !== undefined) {
      throw new Error(`a ${this.provider.kind} provider is already set`);
    }
    this.provider = provider;
    this.providerEvents = provider.onDidChangeState(() => this.changed.fire());
    this.changed.fire();
    let set = true;
    return {
      dispose: () => {
        if (!set) {
          return;
        }
        set = false;
        if (this.provider === provider) {
          this.provider = undefined;
          this.providerEvents?.dispose();
          this.providerEvents = undefined;
          this.changed.fire();
        }
      },
    };
  }

  /**
   * The backend serving `root`: the provider's, else `NullBackend`; also `NullBackend` for a
   * document that has no root (`undefined`: untitled or non-file documents, which the index does
   * not classify).
   */
  backendFor(root: Classification | undefined): IdrisBackend {
    return root !== undefined && this.provider !== undefined ? this.provider.backendFor(root) : this.nullBackend;
  }

  /** The status label of `root`, from the kind of the backend serving it. */
  labelFor(root: Classification | undefined): BackendLabel {
    return LABELS[this.backendFor(root).kind];
  }

  /**
   * The label of a file document whose root is still being classified: the provider's, since it
   * serves every root (M2), so that the status item does not say `syntax only` while the project
   * index answers. M5's routing, which may serve roots differently, has to revisit this.
   */
  pendingLabel(): BackendLabel {
    return LABELS[this.provider?.kind ?? 'null'];
  }

  /** What the backend of `root` is doing; `undefined` when no provider serves it. */
  stateFor(root: Classification | undefined): BackendState | undefined {
    return root !== undefined ? this.provider?.stateFor(root) : undefined;
  }

  /** Forgets the provider (which belongs to whoever set it). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.provider = undefined;
    this.providerEvents?.dispose();
    this.providerEvents = undefined;
    this.changed.dispose();
  }
}
