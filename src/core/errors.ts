/**
 * The `IdrisError` union (`core/errors.ts` in docs/ARCHITECTURE.md §2; contract in §3.1).
 *
 * Every `IdrisBackend` method either returns a typed result or throws an `IdrisError`;
 * `Unsupported` is an ordinary outcome that the UI turns into a sentence ("needs idris2-lsp",
 * "save the file first", …), never a silent no-op.
 *
 * The union is plain data. What is thrown is an `IdrisException` carrying it in `.error`, so
 * that a thrown value is a real `Error` (stack trace, `no-throw-literal`) while callers still
 * narrow on `error.kind`. `NullBackend` (M0) is the first thrower (`Unsupported` only).
 *
 * Each variant carries only its discriminant and a human-readable text for now. The milestone
 * that first throws a variant is expected to add the structured fields it needs (paths,
 * versions, ranges, …); the set of kinds itself is fixed by ARCHITECTURE §2 and pinned by
 * `test/unit/errors.test.ts`.
 */
export type IdrisError =
  | { kind: 'ToolchainMissing'; message: string }
  | { kind: 'VersionMismatch'; message: string }
  | { kind: 'BackendCrashed'; message: string }
  | { kind: 'RequestTimeout'; message: string }
  | { kind: 'ProtocolError'; message: string }
  | { kind: 'NoIpkg'; message: string }
  | { kind: 'IpkgParseError'; message: string }
  | { kind: 'DirtyDocument'; message: string }
  | { kind: 'LoadFailed'; message: string }
  | { kind: 'Unsupported'; reason: string };

export type IdrisErrorKind = IdrisError['kind'];

/** The human-readable text of an error: `reason` for `Unsupported`, `message` otherwise. */
export function errorText(error: IdrisError): string {
  return error.kind === 'Unsupported' ? error.reason : error.message;
}

/** The thrown form of an `IdrisError`. */
export class IdrisException extends Error {
  constructor(readonly error: IdrisError) {
    super(errorText(error));
    this.name = 'IdrisException';
  }
}

/** `new IdrisException({ kind: 'Unsupported', reason })`. */
export function unsupported(reason: string): IdrisException {
  return new IdrisException({ kind: 'Unsupported', reason });
}

/**
 * The rejection of a request that was not failed but abandoned: cancelled by its token, or
 * dropped by a stop or a restart the user or the extension chose (`backend/ide/session.ts`). It
 * is an `Error` named `Cancelled`, not an `IdrisError` (whose kinds ARCHITECTURE §2 fixes), so
 * that callers keep what they showed instead of reporting a failure.
 */
export function cancelled(message = 'Cancelled'): Error {
  const error = new Error(message);
  error.name = 'Cancelled';
  return error;
}

/** Whether `error` is a `cancelled` rejection. */
export function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'Cancelled';
}
