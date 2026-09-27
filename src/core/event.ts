/**
 * A minimal event type and emitter with no `vscode` dependency, so that services built on
 * them (the toolchain service and the project index of M1) can be unit-tested on plain Node.
 *
 * `Event<T>` is the call shape of `vscode.Event<T>` without the `thisArgs`/`disposables`
 * parameters: a `vscode.Event<T>` is assignable to it, and an `Event<T>` can be handed to code
 * that only calls `event(listener)`.
 */
import type { IDisposable } from './disposable';

export type Event<T> = (listener: (e: T) => unknown) => IDisposable;

/**
 * Owns the listeners of one event.
 *
 * - `fire(e)` calls every listener registered at the time of the call, in registration order.
 *   A listener added during `fire` is called from the next `fire` on; one removed during
 *   `fire` is still called in that round if it had not been called yet — the round works on a
 *   snapshot of the listener list.
 * - If listeners throw, every listener is still called and the first error is rethrown after
 *   the last one (as `DisposableStore.clear` does).
 * - Disposing a subscription twice is harmless. After `dispose()` the emitter drops its
 *   listeners, `fire` does nothing, and subscribing returns an inert subscription.
 */
export class Emitter<T> implements IDisposable {
  private listeners: Array<{ readonly call: (e: T) => unknown }> = [];
  private disposed = false;

  readonly event: Event<T> = (listener) => {
    if (this.disposed) {
      return { dispose: () => undefined };
    }
    // A wrapper object per subscription, so the same function subscribed twice is two
    // subscriptions, each removable on its own.
    const entry = { call: listener };
    this.listeners.push(entry);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== entry);
      },
    };
  };

  fire(e: T): void {
    if (this.disposed) {
      return;
    }
    let failed = false;
    let firstError: unknown;
    for (const entry of [...this.listeners]) {
      try {
        entry.call(e);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) {
      throw firstError;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners = [];
  }
}
