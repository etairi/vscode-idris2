/**
 * Where the fake tools live (test/fake-tools/README.md). The scripts are `.mjs` files in the
 * source tree, which `tsc` does not copy to `out/`, so compiled tests find them from the
 * repository root.
 */
import * as fs from 'fs';
import * as path from 'path';

export type FakeTool = 'idris2' | 'idris2-lsp' | 'pack';

/** The checkout: the nearest directory above this file whose package.json is vscode-idris2's. */
export function repoRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'vscode-idris2') {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no vscode-idris2 package.json above ${__dirname}`);
    }
  }
}

/** The Node script behind each fake tool. */
export function fakeScript(tool: FakeTool): string {
  const root = repoRoot();
  switch (tool) {
    case 'idris2':
      return path.join(root, 'test', 'fake-idris2', 'fake-idris2.mjs');
    case 'idris2-lsp':
      return path.join(root, 'test', 'fake-tools', 'fake-idris2-lsp.mjs');
    case 'pack':
      return path.join(root, 'test', 'fake-tools', 'fake-pack.mjs');
  }
}

/** The directory of the launchers (.vscode-test.mjs names the same one). */
export function fakeBinDir(): string {
  return path.join(repoRoot(), 'test', 'fake-tools', 'bin');
}

/** The launcher of `tool` for `platform`: `bin/<tool>` (a shell script) or `bin/<tool>.cmd`. */
export function fakeLauncher(tool: FakeTool, platform: NodeJS.Platform = process.platform): string {
  return path.join(fakeBinDir(), platform === 'win32' ? `${tool}.cmd` : tool);
}
