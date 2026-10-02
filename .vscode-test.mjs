// @vscode/test-cli configuration: one suite per fixture workspace (docs/ARCHITECTURE.md §2, §12).
//
//   integration     test/fixtures/workspaces/loose-file; out/test/integration/*.test.js (the M0
//                   suite and the M1 UI tests); toolchain = the fake tools, set by user settings
//   simple-ipkg     test/fixtures/workspaces/simple-ipkg/src, a workspace folder *inside* the
//                   package (the .ipkg is above it, F13); out/test/integration/simple-ipkg/*;
//                   toolchain = the fake tools, set by user settings
//   toolchain-path  loose-file again; out/test/integration/path/*; no toolchain settings, the
//                   fake tools are found through PATH (the directory is prepended to it)
//   diagnostics     (M2) test/fixtures/workspaces/broken; out/test/integration/diagnostics/*;
//                   fake tools, idris2.ideMode.transport = socket, the opt-in of ROADMAP §9 Q20
//                   (on every platform: the fake's socket mode runs on Windows too, so the
//                   extension's socket transport is exercised there even though the real
//                   compiler's is unverified, E13)
//   loose-stdio     (M2) loose-file again; out/test/integration/loose-stdio/*; fake tools, no
//                   transport setting: the default, stdio (ROADMAP §9 Q20). The workspace's
//                   .vscode/settings.json asks for the socket, which the tests show is ignored
//                   (user settings only); the file applies to the integration and toolchain-path
//                   suites too, where the default is expected as well
//   consent         (M2) test/fixtures/workspaces/simple-ipkg/src: a workspace folder inside a
//                   package, so the session directory (the .ipkg's) lies outside every
//                   workspace folder and needs the user's consent; out/test/integration/consent/*;
//                   fake tools, the default transport (stdio)
//   intelligence    (M3) test/fixtures/workspaces/simple-ipkg: the package's own folder, so its
//                   session directory is a workspace folder and needs no consent;
//                   out/test/integration/intelligence/*; fake tools, the default transport
//                   (stdio): hover, definition across files, docs, namespaces, semantic tokens,
//                   symbols and highlights through recorded transcripts
//   intelligence-loose (M3) test/fixtures/workspaces/broken (loose files: Clean.idr, the F30
//                   fixture); out/test/integration/intelligence-loose/*; fake tools, stdio: types
//                   of pattern variables, inlay hints, completion, evaluation (the eval session,
//                   the refusal of REPL commands) and the keybinding schemes
//   editing         (M4) test/fixtures/workspaces/broken (loose files: Clean.idr, the F30 editing
//                   fixture; Ambig.idr, F29; Part.idr, F15; Plain.idr, F15; Lit2.lidr, F11);
//                   out/test/integration/editing/*; fake tools, stdio: the editing commands, their
//                   code actions and cycling, save before an action
//   holes           (M4) test/fixtures/workspaces/holes: loose files, Main.idr importing Base.idr,
//                   a hole `todo` in each (E16); out/test/integration/holes/*; fake tools, stdio:
//                   the Holes view, Next/Previous Hole, List Holes, Show Keybindings
//   e2e             test/fixtures/workspaces/simple-ipkg; out/test/e2e/** (M1–M4 files);
//                   the real toolchain (no toolchain settings, the runner's PATH). Only part of the
//                   configuration when IDRIS2_E2E=1 or when run as `npm run test:e2e`, so
//                   `npm test` needs no compiler; the suite's own environment has IDRIS2_E2E=1.
//
// test-cli runs the suites one after another, each in its own VS Code instance [src:
// @vscode/test-cli 0.0.15 out/bin.mjs 117-122]. Each suite has its own profile (user-data-dir), rewritten below before every run, so settings a test
// changes never leak into another suite or the next run. Extension state does not persist
// either: when extension tests run, VS Code 1.139.1 keeps its storage in memory
// (`useInMemoryStorage: !!extensionTestsLocationURI` in its main.js [src]; that
// `ExtensionContext.globalState` goes through that storage was inferred, not traced), so every
// suite starts with no remembered allowed folders; tests that allow one revoke it.
//
// Integration suites never run the real compiler: the fake tools are test/fake-tools/bin/{idris2,
// idris2-lsp,pack} (`.cmd` launchers on Windows). User settings name them, which beats every
// other place the search looks (idris2.toolchain.* in package.json), so the result does not
// depend on what is installed on the machine. Tests may change these settings at run time
// (ConfigurationTarget.Global) to switch scenarios and must restore them.
//
// The fake compiler's IDE mode replays the transcripts recorded from the real one (M2,
// test/fake-idris2/README.md): every fake-tool suite's environment has
// FAKE_IDRIS2_TRANSCRIPTS = the absolute path of test/fixtures/transcripts/<version>, which the
// Extension Host inherits (--force-disable-user-env, below) and passes on to every process it
// starts; a test can point one session elsewhere through idris2.toolchain.env, which the
// extension overlays on its own environment.
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const root = dirname(fileURLToPath(import.meta.url));

// F17 (docs/ROADMAP.md §0): VS Code 1.139.1 creates its main IPC socket at
// `<user-data-dir>/<first four characters of its version>-main.sock` (`1.13-main.sock`) on
// macOS, and on Linux when $XDG_RUNTIME_DIR is unset (Windows uses a named pipe); it warns when
// that path reaches 103 characters on macOS, 107 on Linux [src: `main.js` of 1.139.1], and
// listen() fails with EINVAL beyond the OS limit (F17). Every profile below is checked against
// the stricter bound, so a long checkout path fails here with a clear message instead.
const IPC_HANDLE_LIMIT = 103;

function userDataDir(name) {
  const dir = resolve(root, '.vscode-test', name);
  const handle = resolve(dir, 'x.xx-main.sock');
  if (process.platform !== 'win32' && Buffer.byteLength(handle) >= IPC_HANDLE_LIMIT) {
    throw new Error(
      `The IPC socket path ${handle} would be ${Buffer.byteLength(handle)} bytes, ` +
        `at or above VS Code's limit of ${IPC_HANDLE_LIMIT} (F17): move the checkout to a shorter path.`,
    );
  }
  return dir;
}

// VS Code 1.139.1 builds the chat view at startup, and its input is a code editor. When the
// test window starts without OS focus (another application is in front), that input keeps
// widget focus, and every editor command the tests run (`type`, `editor.action.*`) goes to
// it instead of the document editor: `getFocusedCodeEditor()` returns any code editor with
// text or widget focus [src: its workbench bundle]. Observed: no Enter test could insert a
// line while `vscode.window.state.focused` was false; with this setting all of them could.
// `chat.disableAIFeatures` is window-scoped (scope 4), so the profile's settings.json holds it.
const BASE_SETTINGS = { 'chat.disableAIFeatures': true };

const fakeBin = resolve(root, 'test/fake-tools/bin');
const fakeTool = (name) => resolve(fakeBin, process.platform === 'win32' ? `${name}.cmd` : name);
const FAKE_TOOL_SETTINGS = {
  'idris2.toolchain.idris2Path': fakeTool('idris2'),
  'idris2.toolchain.lspPath': fakeTool('idris2-lsp'),
  'idris2.toolchain.packPath': fakeTool('pack'),
};

// The version directory of the transcripts the fake replays: the fake reports 0.8.0 unless
// FAKE_IDRIS2_VERSION says otherwise (test/fake-tools/README.md).
const FAKE_ENV = { FAKE_IDRIS2_TRANSCRIPTS: resolve(root, 'test/fixtures/transcripts/0.8.0') };

/** Creates (or resets) the profile `.vscode-test/<name>` with `settings` as its user settings. */
function profile(name, settings) {
  const dir = userDataDir(name);
  mkdirSync(resolve(dir, 'User'), { recursive: true });
  writeFileSync(resolve(dir, 'User/settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  return dir;
}

/**
 * - `--user-data-dir`: the suite's profile. `@vscode/test-cli` passes launchArgs through
 *   unchanged [src: @vscode/test-cli 0.0.15 out/cli/platform/desktop.mjs 106], and it honours
 *   the flag [live, ARCHITECTURE §12].
 * - `--force-disable-user-env`: VS Code 1.139.1 otherwise runs the user's login shell on macOS
 *   and Linux (unless VSCODE_CLI is set) and builds the Extension Host's environment from its
 *   result [src: `resolveShellEnv` in `main.js`, `_start` of the local extension host in
 *   `workbench.desktop.main.js`], so the extension would see the developer's shell PATH
 *   instead of the suite's. With the flag it sees the environment the suite was started with
 *   [live, 2026-09-27: without the flag the toolchain-path suite's Extension Host had the
 *   login shell's PATH, without the prepended fake-tools directory; with it, the suite's PATH].
 * - Workspace trust needs nothing here: @vscode/test-electron always appends
 *   `--disable-workspace-trust` [src: out/runTest.js 64], so every test workspace is trusted
 *   (`workspace.isTrusted` was true in the integration suite [live, 2026-09-27]) and Restricted
 *   Mode cannot be reached in these suites; its gate is unit-tested. User settings, like the
 *   fake-tool paths below, would apply even then: restrictedConfigurations makes VS Code ignore
 *   only the workspace values of those keys in Restricted Mode [doc: VS Code's workspace trust
 *   extension guide].
 */
function launchArgs(userData) {
  return [`--user-data-dir=${userData}`, '--disable-extensions', '--force-disable-user-env'];
}

// Windows may spell the variable `Path`; the merged environment must override that same key.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

const e2eEnabled = process.env.IDRIS2_E2E === '1' || process.env.npm_lifecycle_event === 'test:e2e';

// `failZero`: test-cli 0.0.15 reports a suite whose `files` match nothing as passing ("0
// passing", exit 0; observed 2026-09-27), so a renamed test directory would silently stop
// testing. Mocha's failZero makes such a suite fail; test-cli hands these options to `new Mocha`
// in the Extension Host [src: @vscode/test-cli 0.0.15 out/runner.cjs 14-18].
const mocha = { ui: 'tdd', timeout: 20000, failZero: true };

export default defineConfig([
  {
    label: 'integration',
    files: 'out/test/integration/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/loose-file',
    env: FAKE_ENV,
    // `.vscode-test/user-data` is also @vscode/test-electron's default profile directory
    // [src: @vscode/test-electron 3.x out/util.js 421-422, out/download.js 325].
    launchArgs: launchArgs(profile('user-data', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  {
    label: 'simple-ipkg',
    files: 'out/test/integration/simple-ipkg/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/simple-ipkg/src',
    env: FAKE_ENV,
    launchArgs: launchArgs(profile('user-data-ipkg', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  {
    label: 'toolchain-path',
    files: 'out/test/integration/path/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/loose-file',
    env: { ...FAKE_ENV, [pathKey]: `${fakeBin}${delimiter}${process.env[pathKey] ?? ''}` },
    launchArgs: launchArgs(profile('user-data-path', BASE_SETTINGS)),
    mocha,
  },
  {
    label: 'diagnostics',
    files: 'out/test/integration/diagnostics/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/broken',
    env: FAKE_ENV,
    launchArgs: launchArgs(
      profile('user-data-diag', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS, 'idris2.ideMode.transport': 'socket' }),
    ),
    mocha,
  },
  {
    label: 'loose-stdio',
    files: 'out/test/integration/loose-stdio/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/loose-file',
    env: FAKE_ENV,
    // No transport here: the default (stdio) applies, and the workspace's own "socket" must not.
    launchArgs: launchArgs(profile('user-data-stdio', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  {
    label: 'consent',
    files: 'out/test/integration/consent/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/simple-ipkg/src',
    env: FAKE_ENV,
    launchArgs: launchArgs(profile('user-data-consent', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  {
    label: 'intelligence',
    files: 'out/test/integration/intelligence/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/simple-ipkg',
    env: FAKE_ENV,
    launchArgs: launchArgs(profile('user-data-intel', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  {
    label: 'intelligence-loose',
    files: 'out/test/integration/intelligence-loose/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/broken',
    env: FAKE_ENV,
    launchArgs: launchArgs(profile('user-data-intel-loose', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  {
    label: 'editing',
    files: 'out/test/integration/editing/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/broken',
    env: FAKE_ENV,
    launchArgs: launchArgs(profile('user-data-editing', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  {
    label: 'holes',
    files: 'out/test/integration/holes/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/holes',
    env: FAKE_ENV,
    launchArgs: launchArgs(profile('user-data-holes', { ...BASE_SETTINGS, ...FAKE_TOOL_SETTINGS })),
    mocha,
  },
  ...(e2eEnabled
    ? [
        {
          label: 'e2e',
          files: 'out/test/e2e/**/*.test.js',
          workspaceFolder: 'test/fixtures/workspaces/simple-ipkg',
          env: { IDRIS2_E2E: '1' },
          launchArgs: launchArgs(profile('user-data-e2e', BASE_SETTINGS)),
          mocha: { ...mocha, timeout: 60000 },
        },
      ]
    : []),
]);
