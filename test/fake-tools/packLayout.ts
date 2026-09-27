/**
 * Builds a simulated pack installation under a temporary home directory, for tests of the
 * toolchain search (test/fake-tools/README.md, "Simulated pack layouts"). pack is not installed
 * on the development machine (ROADMAP §9: it is installed only in M5), so the layout follows
 * pack's source at idris2-pack 6baee7d [src], and its README where the README says more [doc];
 * where the two disagree, both are available and the difference is named below.
 *
 * Directories (getPackDirs, src/Pack/Config/Environment.idr 313–350; PackDirs,
 * src/Pack/Core/Types.idr 137–179):
 * - user (config): `$XDG_CONFIG_HOME/pack`, default `$HOME/.config/pack`;
 * - state: `$XDG_STATE_HOME/pack`, default `$HOME/.local/state/pack`;
 * - bin: `$HOME/.local/bin` (`PACK_BIN_DIR` overrides it; not simulated).
 *
 * Files:
 * - `<bin>/pack` is a symbolic link to `<state>/install/pack/<pack commit>/pack` (packExec, `link
 *   installedExec packExec`, src/Pack/Runner/Install.idr 577–586).
 * - `<bin>/idris2` and `<bin>/idris2-lsp` are pack's wrapper scripts (appLink, Install.idr
 *   157–188; the text below has the same commands, its blank lines may differ): `sh` scripts that ask `pack app-path <app>` for the binary and, for applications
 *   using the package path, export `IDRIS2_PACKAGE_PATH`, `IDRIS2_LIBS` and `IDRIS2_DATA` from
 *   `pack package-path`, `libs-path` and `data-path`. So running a pack-installed `idris2` runs
 *   pack. idris2 uses the package path (Install.idr 324); for idris2-lsp it comes from the
 *   collection's entry, which was not read [open]; the wrapper here uses it too.
 * - The binaries themselves are in the install tree keyed by the **compiler commit**, not by the
 *   collection: `<state>/install/<idris commit>/idris2/bin/idris2` (commitDir and idrisExec,
 *   Environment.idr 133–152) and `<state>/install/<idris commit>/idris2-lsp/<commit>/bin/idris2-lsp` (pkgBinDir, 189–190).
 * - The current collection: pack reads `<config>/pack.toml`, then `<state>/pack.toml`, then any
 *   `pack.toml` from the working directory upwards, and a later `collection` key wins
 *   (`foldl update … (global::collToml::localConfs)`, Environment.idr 482–487; `update` keeps the
 *   later `collection`, src/Pack/Config/Types.idr 371–374). pack writes `<state>/pack.toml` on
 *   every run where it is missing and on `pack switch` (collectionTomlContent,
 *   Environment.idr 449–457; writeCollection 695–702), so the global collection is the one in
 *   `<state>/pack.toml`.
 * - [doc, not in the source] pack's README ("Application Binaries") also names
 *   `$XDG_STATE_HOME/pack/install/<collection>/bin` for wrapper scripts. No code in 6baee7d
 *   writes that directory; `collectionBinTools` creates it for tests of a search that looks there.
 * - `<state>/fake-pack.json` is not pack's: it tells `fake-pack.mjs` what `app-path` and the path
 *   queries answer.
 *
 * pack's wrappers are `sh` scripts, so layouts are built on macOS and Linux only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fakeScript, type FakeTool } from './paths';

/** The compiler commit pinned by pack-db's `nightly-260924` (F22) — Idris2 master 1c630e6. */
const IDRIS_COMMIT = '1c630e67c386629a0fbbc6b78a59176fde7f0a76';
/** idris2-lsp 9a2f0ad, the server commit of the same collection (F22). */
const LSP_COMMIT = '9a2f0ad6a95815fe3ed438ddba08c95574a4de54';
/** idris2-pack 6baee7d, the source this layout follows. */
const PACK_COMMIT = '6baee7d5d59a93cf147de7b1208a2ad934645673';

export interface PackLayoutOptions {
  /** An existing empty directory; it plays `$HOME`. */
  readonly home: string;
  /** The collection pack would use (`<state>/pack.toml`). Default `nightly-260924` (F22). */
  readonly collection?: string;
  /**
   * `true`: config and state live under `<home>/xdg/config` and `<home>/xdg/state`, and `env`
   * sets `XDG_CONFIG_HOME` and `XDG_STATE_HOME`. `false` (default): pack's defaults under `$HOME`.
   */
  readonly xdg?: boolean;
  /** The tools installed in `<bin>` and the install tree. Default: all three. */
  readonly tools?: readonly FakeTool[];
  /** Tools that also get a wrapper in `<state>/install/<collection>/bin` (README only, [doc]). */
  readonly collectionBinTools?: readonly FakeTool[];
  /** A `collection` key in the user's `<config>/pack.toml`; default: that file is not written. */
  readonly globalCollection?: string;
  /** Write `<state>/pack.toml`. Default `true` (pack writes it on its first run). */
  readonly stateToml?: boolean;
}

export interface PackLayout {
  /** The variables a process needs to see this layout: `HOME`, and the `XDG_*` ones with `xdg`. */
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
  readonly configDir: string;
  readonly stateDir: string;
  /** `$HOME/.local/bin`. */
  readonly binDir: string;
  readonly collection: string;
  /** `<state>/install/<collection>/bin` (exists only for `collectionBinTools`). */
  readonly collectionBinDir: string;
  /** What `<bin>` holds for each installed tool (a link for pack, wrappers for the others). */
  readonly bin: Readonly<Partial<Record<FakeTool, string>>>;
  /** The executable behind each installed tool in the install tree. */
  readonly installed: Readonly<Partial<Record<FakeTool, string>>>;
}

/** A shell word: single-quoted, with `'` written as `'\''`. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function writeExecutable(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

/** A launcher that runs the fake tool's script with the node on PATH. */
function launcher(file: string, tool: FakeTool): void {
  writeExecutable(file, `#!/bin/sh\nexec node ${shellQuote(fakeScript(tool))} "$@"\n`);
}

/** pack's wrapper script for `app` (appLink with withPkgPath = True, codegen Default). */
function wrapper(file: string, packExec: string, app: string): void {
  const noApp = [
    `[ fatal ] Package \`${app}\` is not built or not installed in the current`,
    '          environment. Maybe, it was installed with an older compiler version',
    '          or using a local `pack.toml` which is not available in the current',
    `          directory. Try to reinstall it with \`pack install-app ${app}\`.`,
  ];
  writeExecutable(
    file,
    [
      '#!/bin/sh',
      '',
      'PACK=pack',
      `if [ -f "${packExec}" ] && [ -x "${packExec}" ]; then`,
      `  PACK="${packExec}"`,
      'fi',
      '',
      `if ! APPLICATION="$(\${PACK} app-path ${app})" || [ ! -r "$APPLICATION" ]; then {`,
      ...noApp.map((line) => `  echo '${line}'`),
      '  } >&2; exit 2',
      'fi',
      'export IDRIS2_PACKAGE_PATH="$(${PACK} package-path)"',
      'export IDRIS2_LIBS="$(${PACK} libs-path)"',
      'export IDRIS2_DATA="$(${PACK} data-path)"',
      '',
      '',
      '$APPLICATION "$@"',
      '',
    ].join('\n'),
  );
}

export function buildPackLayout(options: PackLayoutOptions): PackLayout {
  if (process.platform === 'win32') {
    throw new Error('pack layouts are simulated on macOS and Linux only (its wrappers are sh scripts)');
  }
  const home = options.home;
  const collection = options.collection ?? 'nightly-260924';
  const tools = options.tools ?? ['pack', 'idris2', 'idris2-lsp'];
  const env: Record<string, string> = { HOME: home };
  let configDir = path.join(home, '.config', 'pack');
  let stateDir = path.join(home, '.local', 'state', 'pack');
  if (options.xdg === true) {
    env.XDG_CONFIG_HOME = path.join(home, 'xdg', 'config');
    env.XDG_STATE_HOME = path.join(home, 'xdg', 'state');
    configDir = path.join(env.XDG_CONFIG_HOME, 'pack');
    stateDir = path.join(env.XDG_STATE_HOME, 'pack');
  }
  const binDir = path.join(home, '.local', 'bin');
  const install = path.join(stateDir, 'install');
  const collectionBinDir = path.join(install, collection, 'bin');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const packExec = path.join(binDir, 'pack');
  const installedPaths: Record<FakeTool, string> = {
    pack: path.join(install, 'pack', PACK_COMMIT, 'pack'),
    idris2: path.join(install, IDRIS_COMMIT, 'idris2', 'bin', 'idris2'),
    'idris2-lsp': path.join(install, IDRIS_COMMIT, 'idris2-lsp', LSP_COMMIT, 'bin', 'idris2-lsp'),
  };
  const bin: Partial<Record<FakeTool, string>> = {};
  const installed: Partial<Record<FakeTool, string>> = {};
  const apps: Record<string, string> = {};
  for (const tool of tools) {
    launcher(installedPaths[tool], tool);
    installed[tool] = installedPaths[tool];
    bin[tool] = path.join(binDir, tool);
    if (tool === 'pack') {
      fs.symlinkSync(installedPaths.pack, packExec);
    } else {
      apps[tool] = installedPaths[tool];
      wrapper(path.join(binDir, tool), packExec, tool);
    }
  }
  for (const tool of options.collectionBinTools ?? []) {
    if (tool === 'pack') {
      launcher(path.join(collectionBinDir, tool), tool);
    } else {
      wrapper(path.join(collectionBinDir, tool), packExec, tool);
    }
  }

  if (options.stateToml ?? true) {
    // collectionTomlContent (Environment.idr 449–457); pack's `quote` wraps the name in double
    // quotes without escaping (src/Pack/Core/Types.idr 27–28), which JSON.stringify matches for
    // the plain names used here.
    fs.writeFileSync(
      path.join(stateDir, 'pack.toml'),
      [
        '# Warning: This file was auto-generated and is maintained by pack.',
        '#          Any changes could be overwritten by pack at any time.',
        '#          Custom settings should go to the global `pack.toml` file',
        '#          or any `pack.toml` file local to a project.',
        `collection = ${JSON.stringify(collection)}`,
        '',
      ].join('\n'),
    );
  }
  if (options.globalCollection !== undefined) {
    fs.writeFileSync(path.join(configDir, 'pack.toml'), `collection = ${JSON.stringify(options.globalCollection)}\n`);
  }
  const libDir = path.join(install, IDRIS_COMMIT, 'idris2', 'idris2-0.8.0');
  fs.writeFileSync(
    path.join(stateDir, 'fake-pack.json'),
    `${JSON.stringify({ apps, packagePath: libDir, libsPath: path.join(libDir, 'lib'), dataPath: path.join(libDir, 'support') }, null, 2)}\n`,
  );
  return { env, home, configDir, stateDir, binDir, collection, collectionBinDir, bin, installed };
}
