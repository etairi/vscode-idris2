import * as assert from 'assert';
// Type-only: erased from the compiled test, which therefore does not load `vscode`.
import type * as vscode from 'vscode';
import { Emitter, type Event } from '../../src/core/event';
import type { Log } from '../../src/core/log';
import type { WorkspaceTrust } from '../../src/core/trust';

suite('core/event Emitter', () => {
  test('fire() calls every listener in registration order with the value', () => {
    const emitter = new Emitter<number>();
    const log: string[] = [];
    emitter.event((n) => log.push(`a${n}`));
    emitter.event((n) => log.push(`b${n}`));
    emitter.fire(1);
    emitter.fire(2);
    assert.deepStrictEqual(log, ['a1', 'b1', 'a2', 'b2']);
  });

  test('disposing a subscription removes exactly that subscription, and twice is harmless', () => {
    const emitter = new Emitter<void>();
    let calls = 0;
    const listener = (): void => {
      calls++;
    };
    const first = emitter.event(listener);
    emitter.event(listener);
    emitter.fire();
    assert.strictEqual(calls, 2, 'the same function subscribed twice is two subscriptions');
    first.dispose();
    first.dispose();
    emitter.fire();
    assert.strictEqual(calls, 3);
  });

  test('a round works on a snapshot: listeners added during fire() wait for the next round', () => {
    const emitter = new Emitter<void>();
    const log: string[] = [];
    emitter.event(() => {
      log.push('a');
      emitter.event(() => log.push('late'));
    });
    emitter.fire();
    assert.deepStrictEqual(log, ['a']);
    emitter.fire();
    assert.deepStrictEqual(log, ['a', 'a', 'late']);
  });

  test('a round works on a snapshot: a listener removed during fire() is still called in that round', () => {
    const emitter = new Emitter<void>();
    const log: string[] = [];
    let second: { dispose(): unknown } | undefined;
    emitter.event(() => {
      log.push('a');
      second?.dispose();
    });
    second = emitter.event(() => log.push('b'));
    emitter.fire();
    emitter.fire();
    assert.deepStrictEqual(log, ['a', 'b', 'a']);
  });

  test('when listeners throw, all are still called and the first error is rethrown', () => {
    const emitter = new Emitter<void>();
    const log: string[] = [];
    emitter.event(() => {
      log.push('a');
      throw new Error('first');
    });
    emitter.event(() => {
      log.push('b');
      throw new Error('second');
    });
    emitter.event(() => log.push('c'));
    assert.throws(() => emitter.fire(), /first/);
    assert.deepStrictEqual(log, ['a', 'b', 'c']);
  });

  test('after dispose() fire() does nothing and subscribing is inert', () => {
    const emitter = new Emitter<void>();
    let calls = 0;
    emitter.event(() => calls++);
    emitter.dispose();
    emitter.fire();
    const late = emitter.event(() => calls++);
    emitter.fire();
    late.dispose();
    assert.strictEqual(calls, 0);
  });
});

suite('core/event and core/log against the vscode API (compile-time checks)', () => {
  test('a vscode.Event is an Event, and vscode.workspace can back a WorkspaceTrust', () => {
    const asEvent = (event: vscode.Event<boolean>): Event<boolean> => event;
    const trustFrom = (workspace: typeof vscode.workspace): WorkspaceTrust => ({
      get isTrusted() {
        return workspace.isTrusted;
      },
      onDidGrant: workspace.onDidGrantWorkspaceTrust,
    });
    assert.strictEqual(typeof asEvent, 'function');
    assert.strictEqual(typeof trustFrom, 'function');
  });

  test('a vscode.LogOutputChannel is a Log', () => {
    const asLog = (channel: vscode.LogOutputChannel): Log => channel;
    assert.strictEqual(typeof asLog, 'function');
  });
});
