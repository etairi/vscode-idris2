/**
 * `BackendRegistry` (`backend/registry.ts` in docs/ARCHITECTURE.md §2, §3.2), in the minimal
 * form M1 needs: which backend serves a project root, and the status label derived from it.
 *
 * A root is a `Classification` of the project index (ARCHITECTURE §3.2): the directory of the
 * nearest `.ipkg` (a `ProjectRoot`), else a loose file's directory. Nothing registers a
 * backend in M1, so every root is served by `NullBackend` and the status item reads
 * `· syntax only` (ROADMAP M1; principle 4 forbids naming a backend that does not run). The
 * IDE-mode backend (M2) and the idris2-lsp backend (M5) register here; per-root routing with a
 * secondary backend and per-feature fallback arrive with them, as does a `stopped` label for a
 * registered backend whose process ended.
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
 * The registry key of a root. A project is identified by its `.ipkg` (the one the compiler's
 * `findIpkg` picks), a loose file by its directory; the prefixes keep the two apart when a
 * directory gains an `.ipkg` and a loose-file root becomes a project root.
 */
export function rootKey(root: Classification): string {
  return root.kind === 'project' ? `project:${root.ipkgPath}` : `loose:${root.dir}`;
}

export class BackendRegistry implements IDisposable {
  private readonly backends = new Map<string, IdrisBackend>();
  private readonly nullBackend = new NullBackend();
  private readonly changed = new Emitter<void>();
  private disposed = false;

  /** Fires after a backend is registered or unregistered. */
  readonly onDidChange: Event<void> = this.changed.event;

  /**
   * Makes `backend` the backend of `root` until the returned subscription is disposed. The
   * caller keeps ownership of `backend` (the registry never disposes it). Registering a second
   * backend for a root that has one is a programming error and throws: the routing policy
   * that chooses between two backends (ARCHITECTURE §3.2) is M5's.
   */
  register(root: Classification, backend: IdrisBackend): IDisposable {
    if (this.disposed) {
      throw new Error('BackendRegistry is disposed');
    }
    const key = rootKey(root);
    if (this.backends.has(key)) {
      throw new Error(`a backend is already registered for ${key}`);
    }
    this.backends.set(key, backend);
    this.changed.fire();
    let registered = true;
    return {
      dispose: () => {
        if (!registered) {
          return;
        }
        registered = false;
        if (this.backends.get(key) === backend) {
          this.backends.delete(key);
          this.changed.fire();
        }
      },
    };
  }

  /**
   * The backend serving `root`; `NullBackend` when none is registered, and for a document that
   * has no root (`undefined`: untitled or non-file documents, which the index does not classify).
   */
  backendFor(root: Classification | undefined): IdrisBackend {
    return (root && this.backends.get(rootKey(root))) ?? this.nullBackend;
  }

  /** The status label of `root`, from the kind of the backend serving it. */
  labelFor(root: Classification | undefined): BackendLabel {
    return LABELS[this.backendFor(root).kind];
  }

  /** Forgets every registration (the backends themselves belong to whoever registered them). */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.backends.clear();
    this.changed.dispose();
  }
}
