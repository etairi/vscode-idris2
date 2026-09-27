// @vscode/test-cli configuration: one suite per fixture workspace (docs/ARCHITECTURE.md §2, §12).
// Only the `integration` suite exists in the skeleton; later milestones add suites for the
// other fixture workspaces and the e2e suite gated on IDRIS2_E2E=1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const root = dirname(fileURLToPath(import.meta.url));
const userDataDir = resolve(root, '.vscode-test/user-data');

// VS Code 1.139.1 builds the chat view at startup, and its input is a code editor. When the
// test window starts without OS focus (another application is in front), that input keeps
// widget focus, and every editor command the tests run (`type`, `editor.action.*`) goes to
// it instead of the document editor: `getFocusedCodeEditor()` returns any code editor with
// text or widget focus [src: its workbench bundle]. Observed: no Enter test could insert a
// line while `vscode.window.state.focused` was false; with this setting all of them could.
// `chat.disableAIFeatures` is window-scoped (scope 4), so the profile's settings.json holds it.
mkdirSync(resolve(userDataDir, 'User'), { recursive: true });
writeFileSync(resolve(userDataDir, 'User/settings.json'), `${JSON.stringify({ 'chat.disableAIFeatures': true }, null, 2)}\n`);

export default defineConfig([
  {
    label: 'integration',
    files: 'out/test/integration/**/*.test.js',
    workspaceFolder: 'test/fixtures/workspaces/loose-file',
    launchArgs: [
      // F17 (docs/ROADMAP.md §0): the Electron IPC socket is created under the user-data-dir
      // and its path must stay below 103 characters. @vscode/test-electron defaults to this
      // same directory (<extensionRoot>/.vscode-test/user-data) when no --user-data-dir is
      // given [src: @vscode/test-electron 3.x out/util.js 421-422, out/download.js 325], and
      // @vscode/test-cli passes launchArgs through unchanged [src: @vscode/test-cli 0.0.15
      // out/cli/platform/desktop.mjs 106]. The explicit flag therefore changes nothing today;
      // it documents the constraint and is the place to substitute a shorter path if this
      // checkout ever moves somewhere long. The real protection is the short checkout path.
      `--user-data-dir=${userDataDir}`,
      '--disable-extensions',
    ],
    mocha: {
      ui: 'tdd',
      timeout: 20000,
    },
  },
]);
