/**
 * Locating `idris2`, `idris2-lsp` and `pack` (`toolchain/discover.ts`, ROADMAP M1 scope, F22).
 * The order of the search is the one `ToolSource` in `toolchain/types.ts` documents and the
 * `idris2.toolchain.*Path` descriptions in `package.json` promise:
 *
 * 1. the setting, when it is not empty — then nothing else: an absolute path (on Windows one
 *    with a drive or UNC root) is taken as is, a bare command name is looked up on `PATH`,
 *    anything else (a relative path) is missing;
 * 2. `PATH` of the effective environment;
 * 3. pack's bin directory, then the `bin` directory of pack's current collection when it
 *    exists (`pack.ts`, which also says why the latter is not expected to exist);
 * 4. on macOS and Linux `/opt/homebrew/bin` and `/usr/local/bin`, then on every platform
 *    `~/.idris2/bin`;
 *
 * with steps 2 and 3 swapped by `idris2.toolchain.preferPack`. A directory met a second time
 * (e.g. `/opt/homebrew/bin` on `PATH`) is searched once, under the step that met it first;
 * whether a tool lies in one of pack's directories is decided by its directory, whichever step
 * found it (`ToolLocation.inPackDirectory`), compared both as written and with symbolic links
 * resolved. Only fully qualified directories are searched (`isFullyQualifiedPath`): an empty or
 * relative `PATH` entry would be resolved against the Extension Host's working directory, and on
 * Windows an entry such as `\tools` against the root of its current drive, neither of which is
 * related to the user's shell. For the same reason step 4's two POSIX directories are not
 * searched on Windows, where they would name `\opt\homebrew\bin` and `\usr\local\bin` on the
 * current drive, in whose root other local users may be able to create folders. Without a home
 * directory (`usableHomeDirectory`) `~/.idris2/bin` is left out; pack's directories follow
 * pack's own `$HOME` (`pack.ts`).
 *
 * Executables. On POSIX a regular file with an execute bit for this process (symbolic links
 * followed; the path is reported as found, not resolved). On Windows any file named by the
 * command plus one extension of `PATHEXT`, tried in `PATHEXT` order (`.COM;.EXE;.BAT;.CMD`
 * when it is unset) and restricted to the ones the process runner can start (`.com`, `.exe`,
 * `.bat`, `.cmd`); a command that already ends in one of them is tried as it is. The same holds
 * for an absolute path in a setting (`C:\tools\idris2` finds `C:\tools\idris2.exe`), as
 * `cmd.exe` resolves a typed path. `PATH` entries may be quoted there, and environment names
 * are case-insensitive. When nothing is found, the reason names the candidates that exist but
 * cannot be run (a file without its execute bit, a directory). The search reads only the file
 * system, so it runs in Restricted Mode too.
 */
import * as path from 'path';
import { environmentValue, isFullyQualifiedPath, type Environment } from '../core/process';
import type { FileSystemProbe } from './fileSystem';
import type { PackLayout } from './pack';
import type { DiscoveryEnvironment, ToolKind, ToolLocation, ToolSource } from './types';

/** The outcome of the search for one tool. */
export type Discovery =
  | { readonly found: true; readonly location: ToolLocation }
  | { readonly found: false; readonly searched: readonly string[]; readonly reason: string };

type PathSettingKey = 'idris2Path' | 'lspPath' | 'packPath';

const SETTING: Readonly<Record<ToolKind, PathSettingKey>> = {
  idris2: 'idris2Path',
  'idris2-lsp': 'lspPath',
  pack: 'packPath',
};

/** The full name of the setting that configures `tool`, e.g. `idris2.toolchain.lspPath`. */
function settingName(tool: ToolKind): string {
  return `idris2.toolchain.${SETTING[tool]}`;
}

/** Windows extensions the process runner can start: executables directly, batch files via cmd.exe. */
const RUNNABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

interface SearchDirectory {
  readonly dir: string;
  readonly source: ToolSource;
  readonly detail: string;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The fully qualified entries of `PATH`, in order (quotes around a Windows entry removed). */
export function pathEntries(env: Environment, platform: NodeJS.Platform): string[] {
  const value = environmentValue(env, 'PATH', platform);
  if (value === undefined) {
    return [];
  }
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => (platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry))
    .filter((entry) => isFullyQualifiedPath(entry, platform));
}

/** The Windows file extensions to try, in `PATHEXT` order, lower-cased; see the module comment. */
function windowsExtensions(env: Environment): string[] {
  const listed = (environmentValue(env, 'PATHEXT', 'win32') || DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => RUNNABLE_EXTENSIONS.includes(ext));
  return [...new Set(listed)];
}

/** The file names that run `command` on `platform`. */
function fileNames(command: string, env: Environment, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') {
    return [command];
  }
  const extensions = windowsExtensions(env);
  return extensions.some((ext) => command.toLowerCase().endsWith(ext))
    ? [command]
    : extensions.map((ext) => command + ext);
}

/** A key under which two spellings of one directory compare equal. */
function directoryKey(dir: string, platform: NodeJS.Platform): string {
  const p = pathApi(platform);
  const normal = p.normalize(dir);
  const trimmed = normal.length > p.parse(normal).root.length ? normal.replace(/[\\/]+$/, '') : normal;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function uniqueDirectories(dirs: readonly SearchDirectory[], platform: NodeJS.Platform): SearchDirectory[] {
  const seen = new Set<string>();
  return dirs.filter((d) => {
    const key = directoryKey(d.dir, platform);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The directories of steps 2–4, in search order (see the module comment). */
function searchDirectories(environment: DiscoveryEnvironment, pack: PackLayout): SearchDirectory[] {
  const { platform, homeDir, env, settings } = environment;
  const p = pathApi(platform);
  const onPath: SearchDirectory[] = pathEntries(env, platform).map((dir) => ({
    dir,
    source: 'PATH',
    detail: `PATH entry ${dir}`,
  }));
  const packDirs: SearchDirectory[] = [];
  if (pack.binDir !== undefined) {
    packDirs.push({ dir: pack.binDir, source: 'pack', detail: `pack's bin directory ${pack.binDir}` });
  }
  if (pack.collectionBinDir !== undefined && pack.collection !== undefined) {
    packDirs.push({ dir: pack.collectionBinDir, source: 'pack', detail: `bin directory of pack collection ${pack.collection}` });
  }
  const wellKnownDirs = [
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin']),
    ...(homeDir === undefined ? [] : [p.join(homeDir, '.idris2', 'bin')]),
  ];
  const wellKnown: SearchDirectory[] = wellKnownDirs.map((dir) => ({ dir, source: 'wellKnown', detail: `directory ${dir}` }));
  const ordered = settings.preferPack ? [...packDirs, ...onPath, ...wellKnown] : [...onPath, ...packDirs, ...wellKnown];
  return uniqueDirectories(
    ordered.filter((d) => isFullyQualifiedPath(d.dir, platform)),
    platform,
  );
}

/**
 * Whether `a` and `b` name the same directory: compared as `directoryKey` does, else after
 * resolving symbolic links in both (e.g. a `PATH` entry `~/bin` that links to `~/.local/bin`,
 * or `/tmp` and `/private/tmp` on macOS). When a path cannot be resolved, only the first
 * comparison counts.
 */
async function sameDirectory(a: string, b: string | undefined, platform: NodeJS.Platform, fs: FileSystemProbe): Promise<boolean> {
  if (b === undefined) {
    return false;
  }
  if (directoryKey(a, platform) === directoryKey(b, platform)) {
    return true;
  }
  const [realA, realB] = [await fs.realpath(a), await fs.realpath(b)];
  return realA !== undefined && realB !== undefined && directoryKey(realA, platform) === directoryKey(realB, platform);
}

/**
 * The `ToolLocation` of the executable `file` in directory `dir`, found by `source`: in
 * pack's directories when `dir` is pack's bin directory or its collection's `bin` directory
 * (`sameDirectory`).
 */
async function locate(
  tool: ToolKind,
  file: string,
  dir: string,
  found: { readonly source: ToolSource; readonly detail: string },
  pack: PackLayout,
  platform: NodeJS.Platform,
  fs: FileSystemProbe,
): Promise<ToolLocation> {
  const inCollection = pack.collection !== undefined && (await sameDirectory(dir, pack.collectionBinDir, platform, fs));
  return {
    kind: tool,
    path: file,
    source: found.source,
    detail: found.detail,
    inPackDirectory: inCollection || (await sameDirectory(dir, pack.binDir, platform, fs)),
    ...(inCollection ? { packCollection: pack.collection } : {}),
  };
}

/** A candidate that exists but cannot be run, and why. */
interface Skipped {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'other';
}

/** The first candidate, in order, that is an executable file; else the ones that exist but are not. */
async function firstRunnable(
  candidates: readonly string[],
  fs: FileSystemProbe,
): Promise<{ readonly hit: string } | { readonly skipped: readonly Skipped[] }> {
  const skipped: Skipped[] = [];
  for (const candidate of candidates) {
    const info = await fs.stat(candidate);
    if (info?.kind === 'file' && info.executable) {
      return { hit: candidate };
    }
    if (info !== undefined) {
      skipped.push({ path: candidate, kind: info.kind });
    }
  }
  return { skipped };
}

async function firstExecutable(
  dirs: readonly SearchDirectory[],
  names: readonly string[],
  platform: NodeJS.Platform,
  fs: FileSystemProbe,
): Promise<{ readonly dir: SearchDirectory; readonly path: string } | { readonly skipped: readonly Skipped[] }> {
  const p = pathApi(platform);
  const skipped: Skipped[] = [];
  for (const dir of dirs) {
    const found = await firstRunnable(
      names.map((name) => p.join(dir.dir, name)),
      fs,
    );
    if ('hit' in found) {
      return { dir, path: found.hit };
    }
    skipped.push(...found.skipped);
  }
  return { skipped };
}

function describeNonExecutable(kind: 'file' | 'directory' | 'other' | undefined): string {
  switch (kind) {
    case undefined:
      return 'does not exist';
    case 'directory':
      return 'is a directory';
    case 'file':
      return 'is not executable';
    case 'other':
      return 'is not a regular file';
  }
}

/** `reason` followed by the candidates that exist but cannot be run, if any. */
function withSkipped(reason: string, skipped: readonly Skipped[]): string {
  return skipped.length === 0
    ? reason
    : `${reason} Found but not usable: ${skipped.map((s) => `${s.path} (${describeNonExecutable(s.kind)})`).join(', ')}.`;
}

/** A command name without any path part: no separator, and on Windows no drive (`C:x`). */
function isBareName(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? !/[\\/:]/.test(value) : !value.includes('/');
}

async function discoverConfigured(
  tool: ToolKind,
  configured: string,
  environment: DiscoveryEnvironment,
  pack: PackLayout,
  fs: FileSystemProbe,
): Promise<Discovery> {
  const { platform, env } = environment;
  const key = settingName(tool);
  if (isFullyQualifiedPath(configured, platform)) {
    // On Windows, `C:\tools\idris2` is tried with each PATHEXT extension (module comment).
    const candidates = fileNames(configured, env, platform);
    const found = await firstRunnable(candidates, fs);
    if ('hit' in found) {
      const dir = pathApi(platform).dirname(found.hit);
      const location = await locate(tool, found.hit, dir, { source: 'setting', detail: `setting ${key}` }, pack, platform, fs);
      return { found: true, location };
    }
    if (candidates.length === 1) {
      return {
        found: false,
        searched: candidates,
        reason: `${key} is set to ${configured}, which ${describeNonExecutable(found.skipped[0]?.kind)}.`,
      };
    }
    const extensions = candidates.map((c) => c.slice(configured.length)).join(', ');
    return {
      found: false,
      searched: candidates,
      reason: withSkipped(`${key} is set to ${configured}, and no file ${configured} with one of the extensions ${extensions} (PATHEXT) exists.`, found.skipped),
    };
  }
  if (isBareName(configured, platform)) {
    const dirs = uniqueDirectories(
      pathEntries(env, platform).map((dir) => ({ dir, source: 'setting', detail: `PATH entry ${dir}` })),
      platform,
    );
    const hit = await firstExecutable(dirs, fileNames(configured, env, platform), platform, fs);
    if ('path' in hit) {
      const detail = `setting ${key} ("${configured}" in ${hit.dir.detail})`;
      return { found: true, location: await locate(tool, hit.path, hit.dir.dir, { source: 'setting', detail }, pack, platform, fs) };
    }
    return {
      found: false,
      searched: dirs.map((d) => d.dir),
      reason: withSkipped(`${key} is set to the command name "${configured}", which is in no PATH directory.`, hit.skipped),
    };
  }
  const windowsHint = platform === 'win32' ? ' (on Windows a full path starts with a drive, as in C:\\, or is a UNC path \\\\server\\share)' : '';
  return {
    found: false,
    searched: [configured],
    reason: `${key} is set to "${configured}", which is neither an absolute path${windowsHint} nor a bare command name.`,
  };
}

/**
 * Searches for `tool` as described in the module comment. `pack` is the layout `readPackLayout`
 * read from the same environment.
 */
export async function discoverTool(
  tool: ToolKind,
  environment: DiscoveryEnvironment,
  pack: PackLayout,
  fs: FileSystemProbe,
): Promise<Discovery> {
  const configured = environment.settings[SETTING[tool]];
  if (configured !== '') {
    return discoverConfigured(tool, configured, environment, pack, fs);
  }
  const dirs = searchDirectories(environment, pack);
  const hit = await firstExecutable(dirs, fileNames(tool, environment.env, environment.platform), environment.platform, fs);
  if (!('path' in hit)) {
    return {
      found: false,
      searched: dirs.map((d) => d.dir),
      reason: withSkipped(`${tool} is not on PATH, in pack's directories or in the usual installation directories.`, hit.skipped),
    };
  }
  const { dir } = hit;
  return { found: true, location: await locate(tool, hit.path, dir.dir, dir, pack, environment.platform, fs) };
}
