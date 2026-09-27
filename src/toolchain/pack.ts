/**
 * pack's directories and current collection (`toolchain/pack.ts`, ROADMAP M1), read from the
 * file system only: the extension never starts pack (principle 8; D22), and nothing in M1 needs
 * its output. (pack's own `idris2` and `idris2-lsp` wrappers run pack whenever they run, so
 * probing a pack-installed `idris2` runs pack indirectly; `toolchain/types.ts`.) pack is not
 * installed on the development machine (ROADMAP §9: installed only in M5), so everything here
 * was read, not observed, in idris2-pack `6baee7d` (2026-09-08):
 * README.md and INSTALL.md [doc], and the source [src]. The two disagree in places; where they
 * do, the code follows the source and says so.
 *
 * Directories (`getPackDirs`, `src/Pack/Config/Environment.idr` 313–350 [src]; INSTALL.md
 * 41–57 [doc]); a variable counts only when it holds an absolute path (pack parses it as a
 * `Path Abs`; the parser is in the external `filepath` package, which was not read; here a
 * fully qualified path, `isFullyQualifiedPath`). `~` is **`$HOME` of the effective
 * environment** (the Extension Host's, overlaid with `idris2.toolchain.env`), the one pack's
 * wrappers are run with: `getPackDirs` reads it first and stops with `NoPackDir` when it is not
 * an absolute path, before it looks at any other variable (Environment.idr 343–345 [src]), so
 * without it pack has no directories at all, and neither has the layout here. Not
 * `os.homedir()`, which ignores a `HOME` set in `idris2.toolchain.env` and is `USERPROFILE` on
 * Windows. Then:
 * - config: `$PACK_USER_DIR`, else `$XDG_CONFIG_HOME/pack`, else `~/.config/pack`;
 * - state: `$PACK_STATE_DIR`, else `$XDG_STATE_HOME/pack`, else `~/.local/state/pack`;
 * - bin: `$PACK_BIN_DIR`, else `~/.local/bin` — where pack puts the symbolic link `pack` and
 *   the wrapper scripts `idris2`, `idris2-lsp`, … (`packBinDir`, `appLink`,
 *   `src/Pack/Runner/Install.idr` 157–186 [src]; README 29–31, 364–366 [doc]).
 *
 * Current collection. README 172–173 [doc] puts the user settings in
 * `$XDG_CONFIG_HOME/pack/pack.toml`, but the collection chosen by `pack switch` is written to
 * **`<state>/pack.toml`** (`collectionToml = MkF pd.state packToml`, Environment.idr 65–66;
 * `writeCollection` 695–702; content `collection = "<name>"`, 449–457 [src]), and pack reads the
 * configuration as `foldl update (init <latest>) (global :: collToml :: local)` (487), where a
 * later file's `collection` wins (`update`, `src/Pack/Config/Types.idr` 371–374). pack creates
 * `<state>/pack.toml` on its first run (478–480). So the collection pack uses outside a project
 * that has its own `pack.toml` is the `collection` of `<state>/pack.toml`, else that of
 * `<config>/pack.toml` (whose generated content has none, `initToml`, `src/Pack/Config/TOML.idr`
 * 86–265). Project-local `pack.toml` files are not read here.
 *
 * Collection `bin` directory. README 293–299 [doc] says a wrapper for each application is
 * also added to `$XDG_STATE_HOME/pack/install/<collection>/bin`. No code in `6baee7d` writes
 * such a directory [src]: `install/` holds `<idris2 commit>/idris2/bin` (the compiler),
 * `<idris2 commit>/<package>/<commit>/bin` (applications) and `pack/<commit>` (Environment.idr
 * 80–190), `appLink` writes wrappers only to the bin directory above, and `pack gc` deletes
 * every entry of `install/` that is neither `pack` nor a known compiler commit (`idrisDelDir`,
 * `src/Pack/Runner/Database.idr` 381–384). The directory is still searched, as ROADMAP M1 and
 * the `idris2.toolchain.*Path` descriptions say, when it exists; with the current source it
 * will not.
 */
import * as path from 'path';
import { environmentValue, isFullyQualifiedPath, type Environment } from '../core/process';
import type { FileSystemProbe } from './fileSystem';

/** pack's directories; all `undefined` when `$HOME` is not an absolute path (see above). */
export interface PackDirectories {
  /** pack's user settings directory (holds the global `pack.toml`). */
  readonly configDir: string | undefined;
  /** pack's state directory (`db/`, `install/`, and the `pack.toml` that `pack switch` writes). */
  readonly stateDir: string | undefined;
  /** Where pack puts its own link and the application wrappers. */
  readonly binDir: string | undefined;
}

export interface PackLayout extends PackDirectories {
  /** The current collection (see the module comment); `undefined` if neither file names one. */
  readonly collection: string | undefined;
  /** `<stateDir>/install/<collection>/bin` when that directory exists (README [doc]; see above). */
  readonly collectionBinDir: string | undefined;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** pack's three directories for the environment `env` (see the module comment). */
export function packDirectories(env: Environment, platform: NodeJS.Platform): PackDirectories {
  const p = pathApi(platform);
  const absolute = (name: string): string | undefined => {
    const value = environmentValue(env, name, platform);
    return value !== undefined && isFullyQualifiedPath(value, platform) ? value : undefined;
  };
  const home = absolute('HOME');
  if (home === undefined) {
    return { configDir: undefined, stateDir: undefined, binDir: undefined };
  }
  const xdg = (name: string, fallback: string[]): string => {
    const value = absolute(name);
    return value === undefined ? p.join(home, ...fallback, 'pack') : p.join(value, 'pack');
  };
  return {
    configDir: absolute('PACK_USER_DIR') ?? xdg('XDG_CONFIG_HOME', ['.config']),
    stateDir: absolute('PACK_STATE_DIR') ?? xdg('XDG_STATE_HOME', ['.local', 'state']),
    binDir: absolute('PACK_BIN_DIR') ?? p.join(home, '.local', 'bin'),
  };
}

/**
 * The top-level `collection` key of a `pack.toml` text: a basic string without escapes or a
 * literal string, before the first table header; `undefined` when there is none, or when the
 * value could not name a directory (empty, `.`, `..`, or containing a path separator or NUL),
 * because it becomes part of a path.
 */
export function parseCollection(toml: string): string | undefined {
  for (const line of toml.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      return undefined;
    }
    const match = /^\s*collection\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (match !== null) {
      const name = match[1] ?? match[2];
      return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name) ? name : undefined;
    }
  }
  return undefined;
}

/** pack's directories, current collection and collection `bin` directory, from the file system. */
export async function readPackLayout(env: Environment, platform: NodeJS.Platform, fs: FileSystemProbe): Promise<PackLayout> {
  const p = pathApi(platform);
  const dirs = packDirectories(env, platform);
  let collection: string | undefined;
  for (const dir of [dirs.stateDir, dirs.configDir]) {
    if (dir === undefined) {
      continue;
    }
    const text = await fs.readTextFile(p.join(dir, 'pack.toml'));
    collection = text === undefined ? undefined : parseCollection(text);
    if (collection !== undefined) {
      break;
    }
  }
  let collectionBinDir: string | undefined;
  if (collection !== undefined && dirs.stateDir !== undefined) {
    const candidate = p.join(dirs.stateDir, 'install', collection, 'bin');
    collectionBinDir = (await fs.stat(candidate))?.kind === 'directory' ? candidate : undefined;
  }
  return { ...dirs, collection, collectionBinDir };
}
