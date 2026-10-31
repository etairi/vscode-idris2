// Unit tests of backend/ide/buildFiles.ts: which build files a save makes stale, on a real file system.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nodeBuildFiles, outdateBuild, type BuildPlace } from '../../src/backend/ide/buildFiles';

suite('backend/ide/buildFiles: a save during a build (review 1, N1)', () => {
  let dir: string;
  let place: BuildPlace;
  const old = new Date(1_000_000_000_000);
  const later = new Date(1_000_000_500_000);
  const sooner = new Date(999_999_500_000);

  /** Writes `relative` below `dir` with the modification time `time`, and answers its path. */
  function file(relative: string, time: Date): string {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    fs.utimesSync(full, time, time);
    return full;
  }

  const stale = (source: string): Promise<readonly string[]> => outdateBuild(nodeBuildFiles, place, source, 'darwin');
  const time = (p: string): number => fs.statSync(p).mtimeMs;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-build-'));
    place = { buildDir: path.join(dir, 'build'), cwd: dir, sourceDir: 'src' };
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a build file newer than the source is set back, so that the compiler builds it again; its contents stay', async () => {
    const source = file('src/Foo/A.idr', old);
    const ttc = file('build/ttc/2025081600/Foo/A.ttc', later);
    assert.deepStrictEqual(await stale(source), [ttc]);
    assert.ok(time(ttc) < time(source), 'older than the source: `isTTCOutdated` compares `>=`');
    assert.strictEqual(fs.readFileSync(ttc, 'utf8'), 'x');
    assert.deepStrictEqual(await stale(source), [], 'once');
  });

  test('a build file older than the source, or as old, stays: the compiler rebuilds it by itself', async () => {
    const source = file('src/A.idr', old);
    const older = file('build/ttc/1/A.ttc', sooner);
    const same = file('build/ttc/2/A.ttc', old);
    assert.deepStrictEqual(await stale(source), []);
    assert.strictEqual(time(older), sooner.getTime());
    assert.strictEqual(time(same), old.getTime());
  });

  test('every TTC version directory is looked at, and only this module: not one of another name, nor a neighbour', async () => {
    const source = file('src/Foo/A.idr', old);
    const first = file('build/ttc/1/Foo/A.ttc', later);
    const second = file('build/ttc/2/Foo/A.ttc', later);
    const neighbour = file('build/ttc/1/Foo/B.ttc', later);
    const sameName = file('build/ttc/1/A.ttc', later);
    assert.deepStrictEqual([...(await stale(source))].sort(), [first, second].sort());
    assert.strictEqual(time(neighbour), later.getTime());
    assert.strictEqual(time(sameName), later.getTime());
  });

  test('a literate file has the module of its name without any extension', async () => {
    for (const name of ['Lit.lidr', 'Lit.md', 'Lit.idr.md', 'Lit.org', 'Lit.tex']) {
      const source = file(`src/${name}`, old);
      const ttc = file('build/ttc/1/Lit.ttc', later);
      assert.deepStrictEqual(await stale(source), [ttc], name);
    }
  });

  test('nothing to do: no build directory, no source, a file outside the source directory, a project without one', async () => {
    const source = file('src/A.idr', old);
    assert.deepStrictEqual(await stale(source), []);
    file('build/ttc/1/A.ttc', later);
    assert.deepStrictEqual(await stale(path.join(dir, 'src', 'Gone.idr')), []);
    assert.deepStrictEqual(await stale(file('other/A.idr', old)), []);
    const loose = file('Loose.idr', old);
    const ttc = file('build/ttc/1/Loose.ttc', later);
    place = { ...place, sourceDir: '.' };
    assert.deepStrictEqual(await stale(loose), [ttc]);
  });

  test('a symbolic link in the build directory is left alone, and what it names', async () => {
    const source = file('src/A.idr', old);
    const target = file('elsewhere/secret', later);
    fs.mkdirSync(path.join(dir, 'build', 'ttc', '1'), { recursive: true });
    fs.symlinkSync(target, path.join(dir, 'build', 'ttc', '1', 'A.ttc'));
    assert.deepStrictEqual(await stale(source), []);
    assert.strictEqual(time(target), later.getTime());
  });
});
