import * as assert from 'assert';
import { DisposableStore, IDisposable } from '../../src/core/disposable';

function recorder(log: string[], name: string, fail = false): IDisposable {
  return {
    dispose() {
      log.push(name);
      if (fail) {
        throw new Error(`boom ${name}`);
      }
    },
  };
}

suite('core/disposable DisposableStore', () => {
  test('add() returns its argument and dispose() disposes in reverse registration order', () => {
    const log: string[] = [];
    const store = new DisposableStore();
    const a = recorder(log, 'a');
    assert.strictEqual(store.add(a), a);
    store.add(recorder(log, 'b'));
    store.add(recorder(log, 'c'));
    assert.strictEqual(store.size, 3);
    assert.strictEqual(store.isDisposed, false);

    store.dispose();

    assert.deepStrictEqual(log, ['c', 'b', 'a']);
    assert.strictEqual(store.size, 0);
    assert.strictEqual(store.isDisposed, true);
  });

  test('dispose() is idempotent', () => {
    const log: string[] = [];
    const store = new DisposableStore();
    store.add(recorder(log, 'a'));
    store.dispose();
    store.dispose();
    assert.deepStrictEqual(log, ['a']);
  });

  test('adding to a disposed store disposes the item immediately and does not retain it', () => {
    const log: string[] = [];
    const store = new DisposableStore();
    store.dispose();
    store.add(recorder(log, 'late'));
    assert.deepStrictEqual(log, ['late']);
    assert.strictEqual(store.size, 0);
  });

  test('a throwing item does not stop the others from being disposed; the first error is rethrown', () => {
    const log: string[] = [];
    const store = new DisposableStore();
    store.add(recorder(log, 'a'));
    store.add(recorder(log, 'b', true));
    store.add(recorder(log, 'c', true));
    store.add(recorder(log, 'd'));

    assert.throws(() => store.dispose(), /boom c/);

    assert.deepStrictEqual(log, ['d', 'c', 'b', 'a']);
    assert.strictEqual(store.isDisposed, true);
    assert.strictEqual(store.size, 0);
  });

  test('clear() disposes the items but leaves the store usable', () => {
    const log: string[] = [];
    const store = new DisposableStore();
    store.add(recorder(log, 'a'));
    store.clear();
    assert.deepStrictEqual(log, ['a']);
    assert.strictEqual(store.isDisposed, false);

    store.add(recorder(log, 'b'));
    store.dispose();
    assert.deepStrictEqual(log, ['a', 'b']);
  });

  test('registering the store on itself throws', () => {
    const store = new DisposableStore();
    assert.throws(() => store.add(store), /on itself/);
    assert.strictEqual(store.size, 0);
  });
});
