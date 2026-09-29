/**
 * Workspace trust as the M1 services see it (docs/as-built/M1.md, *Restricted Mode*),
 * and, since M2, the gate every IDE-mode session passes before its process starts.
 *
 * `package.json` declares `capabilities.untrustedWorkspaces.supported = "limited"`: in an
 * untrusted workspace the extension spawns no process at all — no `--version` probe, no
 * `--dump-ipkg-json` — and does only file-system work (locating executables, the ipkg walk,
 * the fallback ipkg reader). Every spawn goes through the process runner of `core/process.ts`,
 * which refuses to start anything while `isTrusted` is false; the services check `isTrusted`
 * first so that they can report the reason ("disabled in Restricted Mode") instead of an error.
 *
 * `extension.ts` adapts `vscode.workspace.isTrusted` and `vscode.workspace.onDidGrantWorkspaceTrust`
 * to this interface; unit tests pass a fake. The API has no event for trust being withdrawn,
 * only for it being granted, so there is none here either.
 */
import type { Event } from './event';

export interface WorkspaceTrust {
  /** Read at every use: it changes from false to true when the user grants trust. */
  readonly isTrusted: boolean;
  /** Fires when the user grants trust to the workspace (the toolchain service rescans). */
  readonly onDidGrant: Event<void>;
}

/**
 * Why a session may start in a directory:
 * - `workspaceFolder` — the workspace is trusted and the directory lies inside one of its
 *   folders (compared by canonical path, see `SessionGate`);
 * - `window` — the user chose **Allow** for it in this window;
 * - `always` — the user chose **Always Allow for This Folder** (remembered across windows until
 *   revoked with **Idris 2: Manage Allowed Folders…**).
 */
export type AllowedBasis = 'workspaceFolder' | 'window' | 'always';

/**
 * Why a session may not start in a directory:
 * - `restrictedMode` — the workspace is not trusted: nothing runs and nobody is asked (M1 rule);
 * - `denied` — the user chose **Don't Allow** in this window;
 * - `unanswered` — the question was shown in this window and closed without an answer. It is
 *   not shown again by itself; the status item offers to ask again.
 * - `unresolved` — the directory's real path could not be read (it does not exist, or a
 *   component cannot be searched), so it cannot be judged; nobody is asked, and nothing could
 *   start there anyway. Only `permit` and `recheck` give it (and `ConsentGate.askAgain`), with the
 *   error.
 */
export type RefusedReason = 'restrictedMode' | 'denied' | 'unanswered' | 'unresolved';

export type GateVerdict =
  /**
   * `realDir`: set by `recheck`, the real path it judged; the pool starts the process there, not
   * through the symbolic links of the path it was given, which may point elsewhere by the time
   * the process changes into it.
   */
  | { readonly allowed: true; readonly basis: AllowedBasis; readonly realDir?: string }
  /** `error`: for `unresolved`, why the real path could not be read (the error's message). */
  | { readonly allowed: false; readonly reason: RefusedReason; readonly error?: string };

/**
 * Why a session would start in a directory, for the question: `ipkg` is the package file whose
 * directory it is (the first `.ipkg` found in the file's directory or above it, F13), `undefined`
 * for a loose file's own directory.
 */
export interface PermitReason {
  readonly ipkg: string | undefined;
}

/**
 * The consent gate of IDE-mode sessions (decided by the user on 2026-09-27, ROADMAP §9 "Decided
 * by the user on 2026-09-27 (before M2)"). Starting the compiler in a directory can execute code
 * found there — the Homebrew `idris2` loads `libc.dylib` by its leaf name and macOS `dlopen`
 * searches the working directory, and pack's wrappers merge the `pack.toml` of every parent
 * directory (docs/as-built/M1.md, *Processes*, *Roots outside the workspace folders*) — and
 * workspace trust covers only the workspace folders. A session's working directory is the
 * directory of its root's `.ipkg`, or a loose file's directory (`ProjectIndex.sessionCwd`), which
 * can lie outside every workspace folder.
 *
 * The session pool (`backend/ide/pool.ts`) calls `permit` before **every** spawn of a session
 * process (the first one, after a stop, after a crash), and starts nothing unless the verdict
 * is `allowed`; after its last wait it calls `recheck`, which resolves the directory again, so
 * that only microtasks separate the verdict from the spawn. The implementation
 * (`features/consent/`, M2) decides:
 * - Restricted Mode: `{ allowed: false, reason: 'restrictedMode' }` at once, without asking.
 * - A directory inside a workspace folder of the trusted workspace: `workspaceFolder`.
 * - Otherwise it asks **once per directory and window** with a notification offering *Allow*
 *   (this window), *Always Allow for This Folder* (persisted) and *Don't Allow* (this window).
 *   Concurrent `permit` calls for one directory share the one question; the promise stays
 *   pending until the user answers or closes the notification (`unanswered`).
 *
 * "Per directory" means the directory itself, not its subdirectories. Directories are compared
 * by a canonical form, so that one directory reached through a symbolic link, spelled with
 * another case on a case-insensitive file system (the default APFS on macOS) or with another
 * drive-letter case on Windows is one directory — both for "inside a workspace folder" and for
 * the persisted list. `dir` is an absolute path as the project index gives it.
 *
 * `onDidChange` fires when a verdict may have changed (trust granted, a folder allowed, revoked or
 * denied); the pool then stops the running sessions whose directory `current` no longer allows.
 */
export interface SessionGate {
  /**
   * The verdict for `dir`, asking the user if this window has not asked about `dir` yet; `why`
   * goes into the question (the first caller's, when several wait for one question).
   */
  permit(dir: string, why?: PermitReason): Promise<GateVerdict>;
  /** The verdict for `dir` without asking; `undefined` while nobody has been asked or the question is open. */
  current(dir: string): GateVerdict | undefined;
  /**
   * The verdict for `dir` as it is now, without asking: its real path is read again (a directory
   * replaced by a symbolic link since `permit` is judged by its new target), and an allowed
   * verdict carries it (`realDir`); `undefined` when that directory would need a question.
   */
  recheck(dir: string): Promise<GateVerdict | undefined>;
  readonly onDidChange: Event<void>;
}
