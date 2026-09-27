import * as assert from 'assert';
import { IdrisException } from '../../src/core/errors';
import { NO_CAPABILITIES, NullBackend } from '../../src/backend/null';
import type { Capabilities, EditRequest, IdrisBackend } from '../../src/backend/types';

// The backend methods take vscode objects; NullBackend never looks at them, and unit tests may
// not import vscode, so stand-ins of the right static type are passed.
const anyDoc = {} as Parameters<IdrisBackend['load']>[0];
const anyPos = {} as Parameters<IdrisBackend['typeAt']>[1];

async function rejectsUnsupported(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (e) {
    assert.ok(e instanceof IdrisException, `expected an IdrisException, got ${String(e)}`);
    assert.strictEqual(e.error.kind, 'Unsupported');
    const reason = e.error.kind === 'Unsupported' ? e.error.reason : '';
    assert.ok(reason.length > 0, 'the reason must be a sentence the UI can show');
    assert.strictEqual(e.message, reason);
    return reason;
  }
  assert.fail('expected the call to reject');
}

suite('backend/null NullBackend', () => {
  test('kind is "null" and every capability is false', () => {
    const backend: IdrisBackend = new NullBackend();
    assert.strictEqual(backend.kind, 'null');
    const entries = Object.entries(backend.caps);
    assert.strictEqual(entries.length, 19);
    for (const [cap, value] of entries) {
      assert.strictEqual(value, false, `capability ${cap}`);
    }
  });

  test('NO_CAPABILITIES lists every Capabilities key (compile-time) and is frozen', () => {
    // Compile error if Capabilities gains a key that NO_CAPABILITIES does not set.
    const everyKey: Required<Record<keyof Capabilities, boolean>> = NO_CAPABILITIES;
    assert.ok(Object.isFrozen(everyKey));
  });

  test('every method rejects with Unsupported and a reason', async () => {
    const backend: IdrisBackend = new NullBackend();
    const edit: EditRequest = { kind: 'caseSplit', doc: anyDoc, pos: anyPos, name: 'xs' };
    const reasons = [
      await rejectsUnsupported(backend.load(anyDoc)),
      await rejectsUnsupported(backend.typeAt(anyDoc, anyPos, 'xs')),
      await rejectsUnsupported(backend.docsFor('id', 'overview')),
      await rejectsUnsupported(backend.definition(anyDoc, anyPos, 'id')),
      await rejectsUnsupported(backend.holes(anyDoc)),
      await rejectsUnsupported(backend.edit(edit)),
      await rejectsUnsupported(backend.evaluate('1 + 1')),
      await rejectsUnsupported(backend.browseNamespace('Data.Vect')),
    ];
    for (const reason of reasons) {
      assert.match(reason, /needs an Idris 2 backend, and none is running \(syntax only\)\.$/);
    }
    assert.ok(reasons[5].includes('caseSplit'), 'the edit reason names the edit kind');
  });

  test('dispose() does not throw, twice, and the backend still answers Unsupported afterwards', async () => {
    const backend: IdrisBackend = new NullBackend();
    assert.doesNotThrow(() => backend.dispose());
    assert.doesNotThrow(() => backend.dispose());
    await rejectsUnsupported(backend.load(anyDoc));
    assert.ok(Object.values(backend.caps).every((value) => value === false));
  });
});
