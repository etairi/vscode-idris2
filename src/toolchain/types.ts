/**
 * Shared types of the M1 toolchain layer (`toolchain/*` in docs/ARCHITECTURE.md §2; ROADMAP M1).
 *
 * This module is the contract between the parts of M1: the discovery and probing code
 * (`toolchain/discover.ts`, `versions.ts`, `verdict.ts`, `pack.ts`, and `service.ts`, which
 * runs the scans), the process runner (`core/process.ts`), the UI (`toolchain/status.ts`,
 * `setupInfo.ts`, `install.ts`, `notifications.ts`, `backend/registry.ts`) and the project
 * index (`project/index.ts`, which runs `idris2 --dump-ipkg-json` through the same runner).
 * Types only; no runtime code.
 *
 * Facts the types rest on, read in the sources named in ROADMAP §0's legend (Idris2 v0.8.0 and
 * master 1c630e6, idris2-lsp 9a2f0ad, idris2-pack 6baee7d):
 *
 * - `idris2 --version` prints `Idris 2, version ` followed by `show version` and a newline
 *   (`versionMsg`, `src/Idris/CommandLine.idr` 435 on v0.8.0, 434 on master). `show` renders
 *   `<major>.<minor>.<patch>` and, when the build has a version tag, `-<tag>`
 *   (`showVersion True`, `src/Libraries/Data/Version.idr` 26–38, the same on master). The tag
 *   is the Makefile's `VERSION_TAG`, which defaults to `git rev-parse --short=9 HEAD` when the
 *   compiler is built inside a git checkout at a commit that is not tagged (`Makefile` 19–27 on
 *   v0.8.0) [src]. The Homebrew 0.8.0 build on the development machine prints
 *   `Idris 2, version 0.8.0` (F25) [live].
 * - `idris2 --ttc-version` prints `printLn ttcVersion` (`quitOpts`, `src/Idris/Driver.idr` on
 *   v0.8.0): an `Int`, `2025_08_16_00` on v0.8.0 and master (`src/Core/Binary.idr`) [src];
 *   `2025081600` on the development machine [live].
 * - `idris2-lsp --version` (exactly that one argument) prints two lines,
 *   `Idris2 LSP: <show Server.Version.version>` and `Idris2 API: <show Idris.Version.version>`
 *   (`printVersion`, `src/Server/Main.idr` 206–209); both use the compiler's `Show Version`
 *   above. The server's own version is 0.1.0 plus the same kind of git tag (idris2-lsp
 *   `Makefile` 8–20, 58); the API version is the one compiled into the `idris2api` package the
 *   server was built against [src]. No server was run (none is installed; ROADMAP §9 Q2).
 * - pack (`toolchain/pack.ts` has the details and line numbers): it needs `$HOME` to be an
 *   absolute path (`~` below) and has no directories otherwise; its configuration directory is
 *   `$PACK_USER_DIR`, else `$XDG_CONFIG_HOME/pack`, else `~/.config/pack`; its state directory
 *   (`db/`, `install/`) is `$PACK_STATE_DIR`, else `$XDG_STATE_HOME/pack`, else
 *   `~/.local/state/pack`; its bin directory, which holds the link `pack` and the wrapper
 *   scripts `idris2`, `idris2-lsp`, …, is `$PACK_BIN_DIR`, else `~/.local/bin`
 *   (`getPackDirs`, `src/Pack/Config/Environment.idr` 313–350 [src]; INSTALL.md 41–57, README
 *   29–31, 364–366 [doc]). The current collection is the `collection` of `<state>/pack.toml`,
 *   which `pack switch` writes, else that of `<config>/pack.toml` (Environment.idr 65–66,
 *   449–457, 487, 695–702 [src]). README 293–299 [doc] also names
 *   `$XDG_STATE_HOME/pack/install/<collection>/bin`, but no code in 6baee7d creates it and
 *   `pack gc` would delete it (`src/Pack/Runner/Database.idr` 381–384) [src]. pack's wrappers run
 *   pack itself (`pack app-path <app>`, and for `idris2` also `package-path`, `libs-path`,
 *   `data-path`: `appLink`, `src/Pack/Runner/Install.idr` 139–188 [src]), so probing a
 *   pack-installed `idris2` runs pack even though the extension never starts pack directly.
 *   pack is not installed on the development machine (ROADMAP §9: installed only in M5), so
 *   nothing about it was observed.
 */
import type { Config, ToolchainSettings } from '../core/config';
import type { IDisposable } from '../core/disposable';
import type { Event } from '../core/event';
import type { Log } from '../core/log';
import type { WorkspaceTrust } from '../core/trust';

export type ToolKind = 'idris2' | 'idris2-lsp' | 'pack';

// -------------------------------------------------------------------------------------------
// Discovery
// -------------------------------------------------------------------------------------------

/**
 * Which step of the search found an executable. The order of the search (ROADMAP M1 scope,
 * F22), for each of the three tools:
 *
 * 1. `setting` — `idris2.toolchain.<tool>Path` when it is not empty. Then **only** that value is
 *    used: an absolute path is taken as is, a bare command name (no path separator) is looked
 *    up on `PATH`, anything else is reported missing. A configured value that names nothing is
 *    reported missing and the search does **not** fall back to the other steps (principle 4:
 *    the extension must not silently run a different binary than the one configured).
 * 2. `PATH` — the `PATH` of the effective environment (process environment overlaid with
 *    `idris2.toolchain.env`); on Windows each directory is tried with the `PATHEXT` extensions.
 * 3. `pack` — pack's bin directory (`$PACK_BIN_DIR`, else `~/.local/bin`), then
 *    `<state>/install/<collection>/bin` for pack's current collection (`toolchain/pack.ts`) when
 *    that directory exists.
 * 4. `wellKnown` — on macOS and Linux `/opt/homebrew/bin` and `/usr/local/bin`, then on every
 *    platform `~/.idris2/bin`.
 *
 * With `idris2.toolchain.preferPack`, step 3 comes before step 2. Only fully qualified
 * directories are searched (`isFullyQualifiedPath` in `core/process.ts`; `discover.ts`). The `~`
 * of step 4 is `os.homedir()` when that is an absolute path (`usableHomeDirectory`); otherwise
 * `~/.idris2/bin` is not searched. pack's directories in step 3 come from the effective
 * environment as pack computes them: `$HOME` (without an absolute one pack has none), the
 * `XDG_*` and `PACK_*` variables, and pack's defaults (`pack.ts`).
 */
export type ToolSource = 'setting' | 'PATH' | 'pack' | 'wellKnown';

/** An executable that was found. */
export interface ToolLocation {
  readonly kind: ToolKind;
  /** Absolute path of the executable as found (symbolic links not resolved). */
  readonly path: string;
  readonly source: ToolSource;
  /** How it was found, for Setup Information, e.g. "PATH entry /opt/homebrew/bin". */
  readonly detail: string;
  /**
   * Whether its directory is one of pack's (the bin directory, or the `bin` directory of pack's
   * current collection), whichever step found it: pack's README (29–31, 317 [doc]) asks users
   * to put `~/.local/bin` on `PATH`, where the search meets it as a `PATH` entry first.
   */
  readonly inPackDirectory: boolean;
  /** The pack collection whose `bin` directory held it. */
  readonly packCollection?: string;
}

/** The inputs of the search, so that it can be unit-tested against simulated layouts. */
export interface DiscoveryEnvironment {
  readonly platform: NodeJS.Platform;
  /**
   * `usableHomeDirectory(os.homedir())`: `undefined` when that is not an absolute path. Used for
   * `~/.idris2/bin`; pack's directories use `HOME` of `env` (`pack.ts`).
   */
  readonly homeDir: string | undefined;
  /** The effective environment: `process.env` overlaid with `idris2.toolchain.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly settings: ToolchainSettings;
}

// -------------------------------------------------------------------------------------------
// Running tools (the process runner is src/core/process.ts)
// -------------------------------------------------------------------------------------------

/**
 * One short-lived command. `src/core/process.ts` exports
 * `createProcessRunner(options: ProcessRunnerOptions): ProcessRunner`.
 *
 * Rules every implementation keeps:
 * - **Trust.** While `trust.isTrusted` is false, `run` starts nothing and rejects with an
 *   `IdrisException` of kind `Unsupported` (the reason names Restricted Mode). This is the one
 *   choke point for the Restricted Mode rule; callers check trust first to report it properly.
 * - **One at a time.** Requests run strictly one after another in call order (a FIFO queue), so
 *   the extension never has two probes of the toolchain running at once (the development
 *   machine has 16 GB and parallel compiler runs have taken it down; CLAUDE.md).
 * - **No shell for strings we did not write.** Executables are spawned directly with an
 *   argument vector. Windows `.cmd`/`.bat` files, which Node refuses to spawn without a shell
 *   (`EINVAL` since the fix for CVE-2024-27980 [doc: Node.js security release, April 2024]),
 *   go through `cmd.exe /d /s /c` with every argument quoted for `cmd`, and a path or argument
 *   that cannot be quoted safely is refused rather than passed through.
 * - `run` resolves for every outcome of a started or attempted process — non-zero exit,
 *   signal, timeout (the process is killed), spawn failure — and rejects only for the trust
 *   refusal above, for invalid requests, and once the runner's owner has disposed it
 *   (`OwnedProcessRunner` in `core/process.ts`: at deactivation).
 */
export interface ProcessRequest {
  /** Absolute path of the executable. */
  readonly executable: string;
  readonly args: readonly string[];
  /**
   * Working directory; the runner's default is the executable's directory. Not the workspace:
   * the compiler reads its cwd for more than ipkg discovery, e.g. `--list-packages` also lists
   * the packages in `<cwd>/depends` (`findPackages` → `pkgLocalDirectory`,
   * `src/Idris/SetOptions.idr`, `src/Core/Directory.idr` 35–40 on v0.8.0) [src].
   */
  readonly cwd?: string;
  /**
   * Variables that replace inherited ones of the same name (`idris2.toolchain.env`). On
   * Windows names are compared case-insensitively, as the OS does.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds before the process is killed; ROADMAP M1 uses 5,000 for every probe. */
  readonly timeoutMs: number;
}

export interface ProcessResult {
  /** `null` when the process did not exit normally (signal, timeout, spawn failure). */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the process could not be started, e.g. `ENOENT`, `EACCES`. */
  readonly spawnError?: string;
  readonly durationMs: number;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export interface ProcessRunnerOptions {
  readonly trust: WorkspaceTrust;
  /** Each run is logged: the command line at debug level, failures at warn level. */
  readonly log: Log;
}

/** A command the toolchain layer ran, with its raw result (Setup Information, Report Issue). */
export interface ProbeRecord {
  /** The arguments after the executable, e.g. `['--version']`. */
  readonly args: readonly string[];
  readonly result: ProcessResult;
}

// -------------------------------------------------------------------------------------------
// What the probes found
// -------------------------------------------------------------------------------------------

/** A version as `showVersion True` renders it: `<major>.<minor>.<patch>` and optional `-<tag>`. */
export interface ToolVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The compiler's `versionTag` (usually a git commit abbreviated to 9 or more characters), without the `-`. */
  readonly tag?: string;
  /** The version exactly as printed, e.g. `0.8.0` or `0.8.0-1c630e6a2`; the verdict compares these. */
  readonly text: string;
}

/** One entry of `idris2 --list-packages`. */
export interface InstalledPackage {
  readonly name: string;
  /** `undefined` when the compiler lists the package as unversioned. */
  readonly version: string | undefined;
  /** The TTC versions the package was built for. */
  readonly ttcVersions: readonly string[];
  /**
   * The directory the package was found in (a package search path, or `<cwd>/depends`), as the
   * `└` line prints it; not the package's own directory (`toolchain/versions.ts`).
   */
  readonly path: string;
}

export interface Idris2Info {
  /** The first line of `--version` output, e.g. `Idris 2, version 0.8.0`. */
  readonly versionLine: string;
  /** Parsed from `versionLine`; `undefined` when the text after the prefix is not a version. */
  readonly version: ToolVersion | undefined;
  /** `--ttc-version` output, trimmed (digits only); `undefined` if that probe failed. */
  readonly ttcVersion: string | undefined;
  /** `--paths` output verbatim; `undefined` if that probe failed. */
  readonly pathsText: string | undefined;
  /** Parsed `--list-packages` output; `undefined` if that probe failed or did not parse. */
  readonly packages: readonly InstalledPackage[] | undefined;
  /** Every command run for this tool, in order. */
  readonly probes: readonly ProbeRecord[];
  /**
   * The follow-up probes that were not run because an earlier one (`after`) timed out
   * (`service.ts`); absent when none was skipped. Their values above are `undefined`.
   */
  readonly notRun?: { readonly after: readonly string[]; readonly probes: readonly (readonly string[])[] };
}

export interface LspInfo {
  /** The `Idris2 LSP: …` line. */
  readonly serverVersionLine: string;
  readonly serverVersion: ToolVersion | undefined;
  /** The `Idris2 API: …` line. */
  readonly apiVersionLine: string;
  readonly apiVersion: ToolVersion | undefined;
  readonly probes: readonly ProbeRecord[];
}

/** pack's layout; pack itself is never run by discovery (nothing in M1 needs its output). */
export interface PackInfo {
  readonly location: ToolLocation;
  /**
   * `$PACK_USER_DIR`, else `$XDG_CONFIG_HOME/pack`, else `~/.config/pack`, where `~` is `$HOME`
   * of the effective environment; `undefined` when that is not an absolute path (`pack.ts`).
   */
  readonly configDir: string | undefined;
  /** `$PACK_STATE_DIR`, else `$XDG_STATE_HOME/pack`, else `~/.local/state/pack`; as `configDir`. */
  readonly stateDir: string | undefined;
  /**
   * The `collection` of `<stateDir>/pack.toml` (written by `pack switch`), else of
   * `<configDir>/pack.toml`; `undefined` if neither names one.
   */
  readonly collection: string | undefined;
  /** `<stateDir>/install/<collection>/bin` when that directory exists. */
  readonly collectionBinDir: string | undefined;
}

/**
 * What is known about `idris2` or `idris2-lsp`:
 * - `missing` — not found; `searched` lists the places tried, in order, and `reason` says why
 *   in one sentence (e.g. that a configured path does not exist);
 * - `located` — found, but not run because the workspace is not trusted (Restricted Mode);
 * - `probed` — found and run; for `idris2` this requires `--version` to exit 0 with a line
 *   starting `Idris 2, version `, for `idris2-lsp` both `--version` lines;
 * - `failed` — found, but running it failed or printed something unexpected.
 */
export type ToolState<Info> =
  | { readonly status: 'missing'; readonly searched: readonly string[]; readonly reason: string }
  | { readonly status: 'located'; readonly location: ToolLocation }
  | { readonly status: 'probed'; readonly location: ToolLocation; readonly info: Info }
  | {
      readonly status: 'failed';
      readonly location: ToolLocation;
      readonly reason: string;
      readonly probes: readonly ProbeRecord[];
    };

/** pack is found when its executable is; the layout is read from the file system only. */
export type PackState =
  | { readonly status: 'missing'; readonly searched: readonly string[]; readonly reason: string }
  | { readonly status: 'found'; readonly info: PackInfo };

/**
 * Whether `idris2` and `idris2-lsp` fit together (ROADMAP M1 technical approach, D20). A
 * heuristic: `compatible` iff the server's `Idris2 API` version text equals the compiler's
 * version text or differs only in how far one commit hash is abbreviated, `likelyMismatch`
 * otherwise (where the two were found only chooses the explanation, `verdict.ts`;
 * docs/as-built/M1.md, *Pair verdict*); `unknown` when the texts are not available
 * (e.g. Restricted Mode, a failed probe). `reason` is one sentence for the UI.
 */
export type VerdictKind = 'compatible' | 'likelyMismatch' | 'unknown';

export interface Verdict {
  readonly kind: VerdictKind;
  readonly reason: string;
}

export type RescanReason = 'activation' | 'command' | 'settingsChanged' | 'trustGranted';

/** The result of one scan. Immutable: a rescan produces a new snapshot. */
export interface ToolchainSnapshot {
  /** 1 for the first scan, +1 for each later one. */
  readonly generation: number;
  readonly reason: RescanReason;
  /** `WorkspaceTrust.isTrusted` when the scan started; if false nothing was run. */
  readonly trusted: boolean;
  /** The settings the scan used. */
  readonly settings: ToolchainSettings;
  readonly idris2: ToolState<Idris2Info>;
  readonly lsp: ToolState<LspInfo>;
  readonly pack: PackState;
  /** `undefined` when no `idris2-lsp` was found (there is no pair to judge). */
  readonly verdict: Verdict | undefined;
  /** Unexpected failures of the scan itself, one sentence each (tool failures are in the states). */
  readonly errors: readonly string[];
  /** `Date.now()` when the scan finished. */
  readonly finishedAt: number;
}

/**
 * The toolchain service the UI and the project index consume. `src/toolchain/service.ts`
 * exports `createToolchainService(deps: ToolchainServiceDeps): ToolchainService`;
 * `extension.ts` creates it.
 *
 * - The first scan starts when the service is created, without delaying `activate()`.
 * - It rescans on `rescan()`, on a change of `idris2.toolchain.*`, and when trust is granted.
 * - A `rescan()` during a scan queues one more scan after it (several calls share it) and
 *   resolves with the snapshot of a scan that started after the call, so it reflects the
 *   settings at the time of the call.
 * - `onDidChange` fires whenever `scanning` or `current` changes.
 * - After `dispose()` no further process is started: a running scan stops before its next
 *   probe and is not published; queued and later `rescan()` calls reject.
 */
export interface ToolchainService extends IDisposable {
  /** The last finished scan; `undefined` until the first one finishes. */
  readonly current: ToolchainSnapshot | undefined;
  readonly scanning: boolean;
  readonly onDidChange: Event<void>;
  rescan(reason: RescanReason): Promise<ToolchainSnapshot>;
}

/** What `createToolchainService` needs; `extension.ts` supplies the real ones. */
export interface ToolchainServiceDeps {
  readonly config: Pick<Config, 'toolchain' | 'onDidChange'>;
  readonly trust: WorkspaceTrust;
  readonly runner: ProcessRunner;
  readonly log: Log;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `usableHomeDirectory(os.homedir())` (`DiscoveryEnvironment.homeDir`). */
  readonly homeDir: string | undefined;
  /** `process.env` of the Extension Host; `idris2.toolchain.env` is overlaid on it per scan. */
  readonly processEnv: Readonly<Record<string, string | undefined>>;
}
