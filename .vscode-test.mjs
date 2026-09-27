// @vscode/test-cli configuration: one suite per fixture workspace (docs/ARCHITECTURE.md §2, §12).
// Only the `integration` suite exists in the skeleton; later milestones add suites for the
// other fixture workspaces and the e2e suite gated on IDRIS2_E2E=1.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const root = dirname(fileURLToPath(import.meta.url));

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
      `--user-data-dir=${resolve(root, '.vscode-test/user-data')}`,
      '--disable-extensions',
    ],
    mocha: {
      ui: 'tdd',
      timeout: 20000,
    },
  },
]);
