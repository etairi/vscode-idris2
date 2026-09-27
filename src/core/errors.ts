/**
 * The `IdrisError` union (`core/errors.ts` in docs/ARCHITECTURE.md §2; contract in §3.1).
 *
 * Types only: nothing in the skeleton constructs or throws these. Every `IdrisBackend` method
 * either returns a typed result or throws an `IdrisError`; `Unsupported` is an ordinary outcome
 * that the UI turns into a sentence ("needs idris2-lsp", "save the file first", …), never a
 * silent no-op.
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
