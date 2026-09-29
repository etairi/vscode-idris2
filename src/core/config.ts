/**
 * Typed access to the `idris2.*` settings (`core/config.ts` in docs/ARCHITECTURE.md §2, §11).
 * Every setting is read through this module; its keys, defaults, scopes and descriptions are
 * contributed in `package.json` (`contributes.configuration`), and `test/unit/manifest.test.ts`
 * keeps the two in step.
 *
 * M1 contributes the `idris2.toolchain.*` section; M2 adds `idris2.checking.*`,
 * `idris2.ideMode.*`, `idris2.diagnostics.*` and `idris2.trace.*`. The module has no runtime
 * dependency on `vscode` (one type import): `extension.ts` passes `vscode.workspace` as the
 * `ConfigurationHost`, unit tests pass a fake.
 *
 * Values are validated here, so that callers never see a wrongly typed value from a
 * hand-edited `settings.json`: a value of the wrong type (or an unknown enum value) reads as the
 * default, a number below its minimum or above its maximum reads as that bound (the bounds the
 * schema in `package.json` declares, which the Settings editor enforces but a hand-edited file
 * does not),
 * an `env` entry that cannot be put into a process environment is dropped and listed in
 * `ignoredEnvEntries` (for Setup Information), and list entries that are not strings (or, for
 * package names, are empty) are dropped.
 */
import * as path from 'path';
import type { ConfigurationScope } from 'vscode';
import type { IDisposable } from './disposable';

/** The configuration section every key of this extension lives under. */
export const CONFIGURATION_SECTION = 'idris2';

/**
 * The groups of settings a listener can subscribe to (`idris2.<group>.*`); later milestones add
 * theirs.
 */
export type ConfigurationGroup = 'toolchain' | 'checking' | 'ideMode' | 'diagnostics' | 'trace';

/** `idris2.toolchain.*` (ARCHITECTURE §11, M1). */
export interface ToolchainSettings {
  /**
   * `idris2.toolchain.idris2Path`, `lspPath`, `packPath`: `''` means "discover". Otherwise the
   * value with surrounding whitespace removed, then one pair of surrounding double quotes (as
   * Windows Explorer's "Copy as path" adds them), then a leading `~` (alone, or followed by `/`
   * or `\`) replaced by the home directory, when it is known (`usableHomeDirectory`).
   * `toolchain/discover.ts` resolves the result (an absolute path, or a bare command name looked
   * up on `PATH`; see the setting's description).
   */
  readonly idris2Path: string;
  readonly lspPath: string;
  readonly packPath: string;
  /** `idris2.toolchain.preferPack`: search pack's directories before `PATH`. */
  readonly preferPack: boolean;
  /**
   * `idris2.toolchain.env`: variables that replace the inherited ones of the same name in the
   * environment of every `idris2`, `idris2-lsp` and `pack` process the extension starts, and
   * in the environment the toolchain search reads (`PATH`, `PATHEXT`, and pack's `HOME`, `XDG_*`
   * and `PACK_*` directory variables). Values are used as written: no `~` or variable expansion.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Entries of `idris2.toolchain.env` that were dropped, with the reason. */
  readonly ignoredEnvEntries: readonly IgnoredEnvEntry[];
}

export interface IgnoredEnvEntry {
  readonly key: string;
  readonly reason: string;
}

/** What `vscode.WorkspaceConfiguration` offers that this module uses. */
export interface ConfigurationReader {
  get(key: string): unknown;
}

/** What `vscode.ConfigurationChangeEvent` offers that this module uses. */
export interface ConfigurationChange {
  affectsConfiguration(section: string): boolean;
}

/**
 * What `Config.onDidChange` tells its listeners: which settings changed. `affects(key)` with a
 * key relative to `idris2.` (e.g. `ideMode.maxSessions`) is true when that setting, or one below
 * it, changed in any scope (`vscode.ConfigurationChangeEvent.affectsConfiguration`).
 */
export interface SettingsChange {
  affects(key: string): boolean;
}

/**
 * What `vscode.workspace` offers that this module uses. `scope` is passed for the settings whose
 * scope is `resource` (`idris2.checking.*`), so that a folder's value applies to its documents;
 * the other groups are read without one.
 */
export interface ConfigurationHost {
  getConfiguration(section: string, scope?: ConfigurationScope): ConfigurationReader;
  onDidChangeConfiguration(listener: (e: ConfigurationChange) => unknown): IDisposable;
}

/**
 * `os.homedir()` when it is an absolute path, else `undefined`: it returns `$HOME` as it
 * is, also when that is empty or relative (`''` with `HOME=` on Node 24.13, macOS
 * [live, 2026-09-27]), and a path built on it would be resolved against the Extension Host's
 * working directory — `~/bin/idris2` would become `/bin/idris2`.
 */
export function usableHomeDirectory(homedir: string): string | undefined {
  return path.isAbsolute(homedir) ? homedir : undefined;
}

/**
 * Replaces a leading `~` by `homeDir` when it stands alone or is followed by `/` or `\`
 * (`~user` forms are left as they are); without a home directory nothing is replaced.
 */
export function expandHome(value: string, homeDir: string | undefined): string {
  if (homeDir === undefined) {
    return value;
  }
  if (value === '~') {
    return homeDir;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return homeDir + value.slice(1);
  }
  return value;
}

/** A path setting as `ToolchainSettings.idris2Path` describes it. */
function pathSetting(value: unknown, homeDir: string | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return expandHome(unquoted, homeDir);
}

/**
 * Why an environment entry cannot be passed to a child process, or `undefined` if it can.
 * Node's `child_process` rejects a NUL byte in a name or a value with `ERR_INVALID_ARG_VALUE`,
 * and an environment string is `name=value`, so a name containing `=` does not survive: a
 * child given `{ "A=B": "c" }` sees `A` set to `B=c` (both checked with Node 24.13 on macOS,
 * 2026-09-27).
 */
function envEntryProblem(key: string, value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return `the value is ${value === null ? 'null' : typeof value}, not a string`;
  }
  if (key === '') {
    return 'the name is empty';
  }
  if (key.includes('=')) {
    return 'the name contains "="';
  }
  if (key.includes('\0') || value.includes('\0')) {
    return 'the name or value contains a NUL character';
  }
  return undefined;
}

function envSetting(value: unknown): Pick<ToolchainSettings, 'env' | 'ignoredEnvEntries'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { env: {}, ignoredEnvEntries: [] };
  }
  const env: Record<string, string> = {};
  const ignoredEnvEntries: IgnoredEnvEntry[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const problem = envEntryProblem(key, entry);
    if (problem === undefined) {
      env[key] = entry as string;
    } else {
      ignoredEnvEntries.push({ key, reason: problem });
    }
  }
  return { env, ignoredEnvEntries };
}

/** Reads and validates `idris2.toolchain.*` from the `idris2` section. */
export function readToolchainSettings(section: ConfigurationReader, homeDir: string | undefined): ToolchainSettings {
  return {
    idris2Path: pathSetting(section.get('toolchain.idris2Path'), homeDir),
    lspPath: pathSetting(section.get('toolchain.lspPath'), homeDir),
    packPath: pathSetting(section.get('toolchain.packPath'), homeDir),
    preferPack: section.get('toolchain.preferPack') === true,
    ...envSetting(section.get('toolchain.env')),
  };
}

// -------------------------------------------------------------------------------------------
// M2: checking, IDE mode, diagnostics, trace (ARCHITECTURE §11; ROADMAP M2 and §9 "Decided by
// the user on 2026-09-27 (before M2)" and "… on 2026-09-28 (M2 review questions)": Q20, Q21)
// -------------------------------------------------------------------------------------------

/**
 * `idris2.checking.trigger` (ARCHITECTURE §6.2):
 * - `onSave` (default): a document is loaded into its root's `check` session when it is opened
 *   and each time it is saved;
 * - `afterDelay`: as `onSave`, and in addition an Idris document with unsaved changes is saved
 *   (`document.save()`) once `checking.delay` ms have passed without an edit — opt-in, because
 *   it writes the user's files;
 * - `manual`: only **Idris 2: Check File** loads a document.
 */
export type CheckingTrigger = 'onSave' | 'afterDelay' | 'manual';

/** `idris2.checking.*`, read for one document's resource scope. */
export interface CheckingSettings {
  readonly trigger: CheckingTrigger;
  /** `idris2.checking.delay`: the `afterDelay` debounce in ms; from `MIN_CHECKING_DELAY_MS` to `MAX_DELAY_MS`. */
  readonly delayMs: number;
}

/**
 * The transport of an IDE-mode session (ARCHITECTURE §5.1, D1), `idris2.ideMode.transport`:
 * - `stdio` (the default on every platform; decided by the user on 2026-09-28, ROADMAP §9 Q20)
 *   spawns `idris2 --ide-mode` and speaks over its standard input and output; nothing listens on
 *   a port. The `check` session sends no `:exec` of its own, whose program output would be
 *   written unframed into this stream (F5; only a raw request typed with Send Raw Protocol
 *   Request… can); the compiler's log lines and other unframed output are read as the process's
 *   output (`wire.ts`, `session.ts`).
 * - `socket`, an explicit opt-in, spawns `idris2 --ide-mode-socket`, reads the port the compiler
 *   prints on stdout and connects to `127.0.0.1`, so that program output stays out of the protocol
 *   stream (F5). The compiler serves the **first** connection to that port, from any local
 *   program, without checking who made it [src v0.8.0 `Idris/IDEMode/REPL.idr` 50–76; live], and
 *   whoever wins can run programs as the user; `session.ts` notices when its own connection gets
 *   no answer (a takeover) and gives the session up. Observed on macOS [live, F5]; not run on Linux
 *   or Windows [open, E13].
 *
 * The setting has `application` scope (package.json): VS Code reads it from the user settings only,
 * never from a workspace's nor from a remote machine's, so neither a workspace nor a dev container's
 * configuration can opt a user into the socket [src: the VS Code 1.139.1 workbench bundle loads
 * workspace and folder settings with the scopes window, resource, language-overridable and
 * machine-overridable only, a remote machine's with those and machine and application-machine,
 * and drops a key of any other scope; and it hands every extension host, a remote one too, the
 * configuration its window read, the user's application settings included (`MainThreadConfiguration`
 * sends `getConfigurationData()`) — not run in a remote window; docs/as-built/M2.md, *Transport*].
 * (*M2 verification of the Q20–Q22 fixes*: it had `machine` scope, which a remote machine's
 * settings — those a dev container's configuration fills — may set, and which a remote window does
 * not read from the local user settings at all.)
 */
export type TransportKind = 'socket' | 'stdio';

/**
 * `idris2.ideMode.*` (ARCHITECTURE §5, §11). A change of the settings that shape a session
 * (`IDE_MODE_SESSION_KEYS`) restarts the sessions whose command line it changes; the time limits
 * apply from the next request (`backend/ide/pool.ts`; docs/as-built/M2.md, *ARCHITECTURE §5.1*,
 * *Configuration changes*). A change of the two limits (`IDE_MODE_LIMIT_KEYS`) restarts nothing
 * (ROADMAP §9 Q21).
 */
export interface IdeModeSettings {
  /** `idris2.ideMode.transport` (`TransportKind`); a value this version does not offer reads as `stdio`. */
  readonly transport: TransportKind;
  /**
   * `idris2.ideMode.isolateBuildDir`: pass `--build-dir <root>/build/.vscode-idris2` unless
   * something else sets the build directory: the root's `.ipkg` `builddir` or a `--build-dir` in
   * its `opts`, which the compiler applies over the flag at every load (F12 and its addendum), or
   * a `--build-dir` in `extraArgs` (`backend/ide/pool.ts` `checkBuildDir`; D5).
   */
  readonly isolateBuildDir: boolean;
  /** `idris2.ideMode.loosePackages`: `-p <name>` for each, for sessions of loose files only (F25). */
  readonly loosePackages: readonly string[];
  /** `idris2.ideMode.extraArgs`: appended after the extension's own arguments of every session. */
  readonly extraArgs: readonly string[];
  /** `idris2.ideMode.requestTimeout`, ms: the limit of a lookup request. */
  readonly requestTimeoutMs: number;
  /** `idris2.ideMode.longActionTimeout`, ms: the limit of `:load-file`, `:proof-search`, `:generate-def`. */
  readonly longActionTimeoutMs: number;
  /** `idris2.ideMode.idleTimeout`, ms: a session with no request for this long is stopped; 0 = never. */
  readonly idleTimeoutMs: number;
  /**
   * `idris2.ideMode.maxSessions` (ROADMAP §9 Q21): `0` (the default) = no limit. Above it, the
   * pool stops the least recently used idle session — never a busy one, never the active
   * document's — which starts again at its root's next check (`backend/ide/pool.ts`).
   */
  readonly maxSessions: number;
  /**
   * `idris2.ideMode.maxBackgroundChecks` (ROADMAP §9 Q21): `0` (the default) = no limit. Otherwise
   * at most this many checks of documents other than the active one run at once, the others wait
   * in order; the active document's check never waits for them
   * (`features/diagnostics/checks.ts`).
   */
  readonly maxBackgroundChecks: number;
}

/**
 * The `idris2.ideMode.*` keys that shape a session: its command line or its time limits. A change
 * of one of them restarts the running sessions whose command line it changes and returns `failed`
 * ones to `stopped` (`backend/ide/pool.ts`). `test/unit/manifest.test.ts` checks that every
 * `idris2.ideMode.*` key is in this list or in `IDE_MODE_LIMIT_KEYS`.
 */
export const IDE_MODE_SESSION_KEYS: readonly string[] = [
  'ideMode.transport',
  'ideMode.isolateBuildDir',
  'ideMode.loosePackages',
  'ideMode.extraArgs',
  'ideMode.requestTimeout',
  'ideMode.longActionTimeout',
  'ideMode.idleTimeout',
];

/**
 * The `idris2.ideMode.*` keys that only limit how much runs at once (ROADMAP §9 Q21): a change
 * applies at once — a lower `maxSessions` stops what exceeds it, a higher `maxBackgroundChecks`
 * starts waiting checks — and restarts no session, since no command line changes.
 */
export const IDE_MODE_LIMIT_KEYS: readonly string[] = ['ideMode.maxSessions', 'ideMode.maxBackgroundChecks'];

/** `idris2.diagnostics.*` (ARCHITECTURE §8). */
export interface DiagnosticsSettings {
  /**
   * `idris2.diagnostics.includeSourceExcerpt`: keep the compiler's source excerpt (the lines it
   * quotes under the location line of a message, F6) in the diagnostic's message.
   */
  readonly includeSourceExcerpt: boolean;
}

/** `idris2.trace.*`. */
export interface TraceSettings {
  /**
   * `idris2.trace.protocol`: write every frame exchanged with the compiler to the "Idris 2:
   * Protocol Trace" output channel, and enable **Idris 2 (Developer): Send Raw Protocol Request…**.
   */
  readonly protocol: boolean;
}

/** The smallest `idris2.checking.delay` (ms); also the schema's `minimum` in package.json. */
export const MIN_CHECKING_DELAY_MS = 100;
/** The smallest request time limit (ms), for both `requestTimeout` and `longActionTimeout`. */
export const MIN_REQUEST_TIMEOUT_MS = 1000;
/**
 * The largest value of every setting that is a delay (`checking.delay`, the three
 * `ideMode.*Timeout`s), 2^31 − 1 ms (about 24.8 days); also the schema's `maximum`. Node's
 * `setTimeout` runs a callback whose delay does not fit a signed 32-bit integer after 1 ms
 * instead (`TimeoutOverflowWarning` [live, Node 24.13, 2026-09-27]), so a larger value meant to
 * turn a limit off would make every load time out at once.
 */
export const MAX_DELAY_MS = 2 ** 31 - 1;

const CHECKING_TRIGGERS: readonly CheckingTrigger[] = ['onSave', 'afterDelay', 'manual'];

/** `value` when it is one of `allowed`, else `fallback`. */
function enumSetting<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * `idris2.ideMode.transport`: `socket` only when written so; anything else is `stdio`. That
 * includes `auto`, the default before 2026-09-28 (`socket` on macOS and Linux, `stdio` on
 * Windows), which the schema no longer offers: a user who wrote it gets the new default, and one
 * who wrote `socket` keeps the socket (ROADMAP §9 Q20).
 */
function transportSetting(value: unknown): TransportKind {
  return value === 'socket' ? 'socket' : 'stdio';
}

/**
 * A count where `0` means "no limit": a finite number is rounded down and read as at least 0;
 * anything else (a string, `null`, `NaN`, an infinity) as 0.
 */
function limitSetting(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * A delay in ms, from `minimum` to `MAX_DELAY_MS`: a number outside reads as the nearer bound,
 * anything but a finite number as `fallback`.
 */
function delaySetting(value: unknown, minimum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(MAX_DELAY_MS, Math.max(minimum, value));
}

/** The string entries of an array (optionally only non-empty ones); anything else reads as `[]`. */
function stringListSetting(value: unknown, nonEmpty: boolean): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && (!nonEmpty || entry !== ''));
}

/** Reads and validates `idris2.checking.*` from the `idris2` section. */
export function readCheckingSettings(section: ConfigurationReader): CheckingSettings {
  return {
    trigger: enumSetting(section.get('checking.trigger'), CHECKING_TRIGGERS, 'onSave'),
    delayMs: delaySetting(section.get('checking.delay'), MIN_CHECKING_DELAY_MS, 700),
  };
}

/** Reads and validates `idris2.ideMode.*` from the `idris2` section. */
export function readIdeModeSettings(section: ConfigurationReader): IdeModeSettings {
  return {
    transport: transportSetting(section.get('ideMode.transport')),
    isolateBuildDir: section.get('ideMode.isolateBuildDir') !== false,
    loosePackages: stringListSetting(section.get('ideMode.loosePackages'), true),
    extraArgs: stringListSetting(section.get('ideMode.extraArgs'), false),
    requestTimeoutMs: delaySetting(section.get('ideMode.requestTimeout'), MIN_REQUEST_TIMEOUT_MS, 5000),
    longActionTimeoutMs: delaySetting(section.get('ideMode.longActionTimeout'), MIN_REQUEST_TIMEOUT_MS, 60000),
    idleTimeoutMs: delaySetting(section.get('ideMode.idleTimeout'), 0, 600000),
    maxSessions: limitSetting(section.get('ideMode.maxSessions')),
    maxBackgroundChecks: limitSetting(section.get('ideMode.maxBackgroundChecks')),
  };
}

/** Reads and validates `idris2.diagnostics.*` from the `idris2` section. */
export function readDiagnosticsSettings(section: ConfigurationReader): DiagnosticsSettings {
  return { includeSourceExcerpt: section.get('diagnostics.includeSourceExcerpt') === true };
}

/** Reads and validates `idris2.trace.*` from the `idris2` section. */
export function readTraceSettings(section: ConfigurationReader): TraceSettings {
  return { protocol: section.get('trace.protocol') === true };
}

/**
 * The settings as the rest of the extension sees them. Reads are not cached: each call
 * reflects the current value, so callers read again after `onDidChange` fires.
 */
export class Config {
  constructor(
    private readonly host: ConfigurationHost,
    /** `usableHomeDirectory(os.homedir())`. */
    private readonly homeDir: string | undefined,
  ) {}

  toolchain(): ToolchainSettings {
    return readToolchainSettings(this.host.getConfiguration(CONFIGURATION_SECTION), this.homeDir);
  }

  /**
   * `idris2.checking.*` for `scope` (the document's URI): these settings are `resource`-scoped,
   * so a workspace folder may set its own; without a scope, the window's value.
   */
  checking(scope?: ConfigurationScope): CheckingSettings {
    return readCheckingSettings(this.host.getConfiguration(CONFIGURATION_SECTION, scope));
  }

  ideMode(): IdeModeSettings {
    return readIdeModeSettings(this.host.getConfiguration(CONFIGURATION_SECTION));
  }

  diagnostics(): DiagnosticsSettings {
    return readDiagnosticsSettings(this.host.getConfiguration(CONFIGURATION_SECTION));
  }

  trace(): TraceSettings {
    return readTraceSettings(this.host.getConfiguration(CONFIGURATION_SECTION));
  }

  /**
   * Calls `listener` after any setting of `idris2.<group>.*` changes, in any scope, with which
   * settings changed (`SettingsChange`).
   */
  onDidChange(group: ConfigurationGroup, listener: (change: SettingsChange) => void): IDisposable {
    const section = `${CONFIGURATION_SECTION}.${group}`;
    return this.host.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(section)) {
        listener({ affects: (key) => e.affectsConfiguration(`${CONFIGURATION_SECTION}.${key}`) });
      }
    });
  }
}
