// E2E, ROADMAP §9 E21: do an IDE-mode session and a build sharing the package's build directory
// (an ipkg with `builddir`, where `--build-dir` isolation does not apply, F12) spoil each other's
// TTC files? One session and one `idris2 --build` run concurrently on
// test/fixtures/workspaces/builddir-ipkg — the only test that runs two compiler processes at once
// (CLAUDE.md). The load is sent when the build prints its Building line, so that both work on
// `Hello` at the same time as far as timing allows; whether they overlapped is printed, since a
// one-module package compiles in milliseconds and the overlap is not guaranteed.
import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { decodeBuildingLine } from '../../src/backend/ide/protocol';
import { copyWorkspace, filesBelow, runIdeSession } from './ideDriver';
import { extensionApi, probedIdris2, quiesce } from './helpers';

interface BuildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Starts `idris2 --build builddir.ipkg`; `building` resolves at its first Building line (or its end). */
function startBuild(idris2: string, cwd: string): { building: Promise<void>; done: Promise<BuildResult> } {
  const child = spawn(idris2, ['--build', 'builddir.ipkg'], { cwd, detached: true });
  const limit = setTimeout(() => {
    if (child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL'); // its process group: the compiler behind the sh wrapper too
    }
  }, 60000);
  let stdout = '';
  let stderr = '';
  let saw: () => void = () => undefined;
  const building = new Promise<void>((resolve) => (saw = resolve));
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('Building')) {
      saw();
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const done = new Promise<BuildResult>((resolve) =>
    child.on('exit', (code) => {
      clearTimeout(limit);
      saw();
      resolve({ code, stdout, stderr });
    }),
  );
  return { building, done };
}

suite('E2E: E21, an IDE-mode session and idris2 --build sharing builddir', function () {
  this.timeout(120000);

  test('a load during a concurrent --build: both succeed and the TTC files stay usable', async () => {
    const api = await extensionApi();
    await quiesce(api);
    const idris2 = probedIdris2(api);
    const { dir, root } = copyWorkspace('builddir-ipkg');
    try {
      const hello = path.join(root, 'src', 'Hello.idr');
      let build: { building: Promise<void>; done: Promise<BuildResult> } | undefined;
      // As the extension starts it for a package with builddir: no --build-dir (F12, D5).
      const run = await runIdeSession({
        executable: idris2,
        cwd: root,
        transport: 'stdio',
        args: ['--no-color'],
        requests: [`((:load-file "${hello}") 1)\n`, `((:load-file "${hello}") 2)\n`, '((:type-of "hello") 3)\n'],
        beforeRequest: async (index) => {
          if (index === 0) {
            build = startBuild(idris2, root);
            await build.building;
          }
        },
      });
      assert.ok(build);
      const built = await build.done;
      assert.deepStrictEqual(built, { code: 0, stdout: '1/1: Building Hello (src/Hello.idr)\n', stderr: '' });
      const [first, second, typeOf] = run.exchanges;
      assert.strictEqual(first.frames.at(-1), '(:return (:ok ()) 1)\n');
      assert.strictEqual(second.frames.at(-1), '(:return (:ok ()) 2)\n');
      assert.match(typeOf.frames.at(-1) ?? '', /^\(:return \(:ok "Hello\.hello : String" /);
      assert.strictEqual(run.stderr, '');
      const sessionBuilt = first.messages.some(
        (m) => m.kind === 'message' && m.message.kind === 'write-string' && decodeBuildingLine(m.message.text) !== undefined,
      );
      // The record for ROADMAP §9 E21: whether the two compiled Hello at the same time.
      console.log(`E21: the session's load ${sessionBuilt ? 'built Hello as well (both wrote the TTC)' : 'found the TTC fresh (no overlap)'}.`);

      // Afterwards, alone: the TTCs are read as up to date, so nothing is rebuilt.
      const again = startBuild(idris2, root);
      assert.deepStrictEqual(await again.done, { code: 0, stdout: '', stderr: '' });
      const outputs = filesBelow(root).filter((f) => !['builddir.ipkg', 'src/Hello.idr'].includes(f));
      assert.ok(outputs.length === 2 && outputs.every((f) => /^out\/ttc\/\d+\/Hello\.tt[cm]$/.test(f)), outputs.join(', '));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
