import * as assert from 'assert';
import { IdrisException, cancelled, errorText, isCancelled, unsupported, type IdrisError, type IdrisErrorKind } from '../../src/core/errors';

// The first test is checked by `tsc` when the tests are compiled: it fails to compile if the
// union gains or loses a kind relative to the list from docs/ARCHITECTURE.md §2.
suite('core/errors IdrisError', () => {
  test('the union has exactly the ten kinds listed in ARCHITECTURE §2 and M3\'s NotLoaded', () => {
    // Compile error if a listed kind is not a member of the union.
    const kinds = [
      'ToolchainMissing',
      'VersionMismatch',
      'BackendCrashed',
      'RequestTimeout',
      'ProtocolError',
      'NoIpkg',
      'IpkgParseError',
      'DirtyDocument',
      'LoadFailed',
      'Unsupported',
      // M3: a question about a document whose file is not the one its check session has loaded.
      'NotLoaded',
    ] as const satisfies readonly IdrisErrorKind[];

    // Compile error if the union has a kind that is not listed above.
    type NotListed = Exclude<IdrisErrorKind, (typeof kinds)[number]>;
    const everyKindListed: [NotListed] extends [never] ? true : false = true;

    assert.strictEqual(everyKindListed, true);
    assert.strictEqual(new Set(kinds).size, 11);
  });

  test('NotLoaded carries a message and the file the load would send', () => {
    const error: IdrisError = { kind: 'NotLoaded', message: 'another file is loaded', file: '/w/src/Foo/B.idr' };
    assert.strictEqual(errorText(error), 'another file is loaded');
    assert.strictEqual(new IdrisException(error).message, 'another file is loaded');
  });

  test('Unsupported carries a reason, the other variants a message', () => {
    // Narrowing on `kind` is how the UI is meant to consume the union (ARCHITECTURE §3.1).
    const unsupportedError: IdrisError = { kind: 'Unsupported', reason: 'needs idris2-lsp' };
    const missing: IdrisError = { kind: 'ToolchainMissing', message: 'idris2 not found on PATH' };

    assert.strictEqual(errorText(unsupportedError), 'needs idris2-lsp');
    assert.strictEqual(errorText(missing), 'idris2 not found on PATH');
  });

  test('IdrisException is a real Error that carries the IdrisError', () => {
    const error: IdrisError = { kind: 'DirtyDocument', message: 'save the file first' };
    const e = new IdrisException(error);
    assert.ok(e instanceof Error);
    assert.strictEqual(e.name, 'IdrisException');
    assert.strictEqual(e.message, 'save the file first');
    assert.strictEqual(e.error, error);
    assert.ok(typeof e.stack === 'string');
  });

  test('unsupported(reason) builds the Unsupported exception', () => {
    const e = unsupported('stubbed in this compiler version');
    assert.deepStrictEqual(e.error, { kind: 'Unsupported', reason: 'stubbed in this compiler version' });
    assert.strictEqual(e.message, 'stubbed in this compiler version');
    assert.throws(() => {
      throw e;
    }, IdrisException);
  });

  test('cancelled(message) is an Error named Cancelled, not an IdrisException; isCancelled tells it apart', () => {
    const e = cancelled('The Idris 2 session was stopped (Stop Backend).');
    assert.ok(e instanceof Error && !(e instanceof IdrisException));
    assert.strictEqual(e.name, 'Cancelled');
    assert.strictEqual(e.message, 'The Idris 2 session was stopped (Stop Backend).');
    assert.strictEqual(cancelled().message, 'Cancelled');
    assert.strictEqual(isCancelled(e), true);
    assert.strictEqual(isCancelled(unsupported('x')), false);
    assert.strictEqual(isCancelled(new Error('Cancelled')), false);
    assert.strictEqual(isCancelled('Cancelled'), false);
  });
});
