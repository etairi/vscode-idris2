/**
 * Typed access to the `idris2.*` settings (`core/config.ts` in docs/ARCHITECTURE.md §2, §11).
 * Every setting is read through this module; its keys, defaults, scopes and descriptions are
 * contributed in `package.json` (`contributes.configuration`), and `test/unit/manifest.test.ts`
 * keeps the two in step.
 *
 * M1 contributes the `idris2.toolchain.*` section. The module has no runtime dependency on
 * `vscode`: `extension.ts` passes `vscode.workspace` as the `ConfigurationHost`, unit tests
 * pass a fake.
 *
 * Values are validated here, so that callers never see a wrongly typed value from a
 * hand-edited `settings.json`: a value of the wrong type reads as the default, and an `env`
 * entry that cannot be put into a process environment is dropped and listed in
 * `ignoredEnvEntries` (for Setup Information).
 */
import * as path from 'path';
import type { IDisposable } from './disposable';

/** The configuration section every key of this extension lives under. */
export const CONFIGURATION_SECTION = 'idris2';

/** The groups of settings a listener can subscribe to; later milestones add theirs. */
export type ConfigurationGroup = 'toolchain';

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

/** What `vscode.workspace` offers that this module uses. */
export interface ConfigurationHost {
  getConfiguration(section: string): ConfigurationReader;
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

  /** Calls `listener` after any setting of `idris2.<group>.*` changes, in any scope. */
  onDidChange(group: ConfigurationGroup, listener: () => void): IDisposable {
    const section = `${CONFIGURATION_SECTION}.${group}`;
    return this.host.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(section)) {
        listener();
      }
    });
  }
}
