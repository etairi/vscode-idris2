import * as assert from 'assert';
import type { IdrisError, IdrisErrorKind } from '../../src/core/errors';

// `IdrisError` is types only, so this test is mostly checked by `tsc` when the tests are
// compiled: it fails to compile if the union gains or loses a kind relative to the list from
// docs/ARCHITECTURE.md §2.
suite('core/errors IdrisError', () => {
  test('the union has exactly the ten kinds listed in ARCHITECTURE §2', () => {
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
    ] as const satisfies readonly IdrisErrorKind[];

    // Compile error if the union has a kind that is not listed above.
    type NotListed = Exclude<IdrisErrorKind, (typeof kinds)[number]>;
    const everyKindListed: [NotListed] extends [never] ? true : false = true;

    assert.strictEqual(everyKindListed, true);
    assert.strictEqual(new Set(kinds).size, 10);
  });

  test('Unsupported carries a reason, the other variants a message', () => {
    // Narrowing on `kind` is how the UI is meant to consume the union (ARCHITECTURE §3.1).
    const textOf = (e: IdrisError): string => (e.kind === 'Unsupported' ? e.reason : e.message);

    assert.strictEqual(textOf({ kind: 'Unsupported', reason: 'needs idris2-lsp' }), 'needs idris2-lsp');
    assert.strictEqual(textOf({ kind: 'ToolchainMissing', message: 'idris2 not found on PATH' }), 'idris2 not found on PATH');
  });
});
