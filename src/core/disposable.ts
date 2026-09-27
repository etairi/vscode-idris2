/**
 * Minimal disposable helpers (`core/disposable.ts` in docs/ARCHITECTURE.md §2).
 *
 * Deliberately free of any `vscode` import so it can be unit-tested on plain Node
 * (`npm run test:unit`); `vscode.Disposable` is structurally an `IDisposable`.
 */

export interface IDisposable {
  dispose(): unknown;
}

/**
 * Owns a set of disposables and disposes them together, in reverse order of registration.
 *
 * - `dispose()` is idempotent.
 * - Adding to an already disposed store disposes the new item immediately.
 * - If several items throw while being disposed, every item is still disposed and the first
 *   error is rethrown afterwards.
 */
export class DisposableStore implements IDisposable {
  private readonly items = new Set<IDisposable>();
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.items.size;
  }

  /** Registers `item` and returns it, so `const x = store.add(makeX())` reads naturally. */
  add<T extends IDisposable>(item: T): T {
    if ((item as IDisposable) === this) {
      throw new Error('Cannot register a DisposableStore on itself');
    }
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  /** Disposes and forgets every registered item; the store itself stays usable. */
  clear(): void {
    const items = [...this.items].reverse();
    this.items.clear();
    let firstError: unknown;
    let failed = false;
    for (const item of items) {
      try {
        item.dispose();
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    }
    if (failed) {
      throw firstError;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear();
  }
}
