// backend/ide/shadow.ts: the options a shadow directory's package file keeps (read as the 0.8.0
// option parser reads them), the package file itself — read back with the port of the compiler's
// ipkg parser (`project/ipkg.ts` `readIpkgText`), so that what the compiler will read is checked —,
// the path of a document's copy and the shadow directory's name. No file is written.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SHADOW_SOURCE_DIR, shadowCopyPath, shadowDirectoryOf, shadowPackage, shadowPackageOptions } from '../../src/backend/ide/shadow';
import { modelFromDumpOutput, readIpkgText } from '../../src/project/ipkg';
import { repoRoot } from '../fake-tools/paths';
import type { IpkgModel, IpkgVersionBounds, ProjectRoot } from '../../src/project/types';
import { LOOSE, projectRoot } from './support/toolchainFixtures';

const ANY: IpkgVersionBounds = { lower: undefined, lowerInclusive: true, upper: undefined, upperInclusive: true };

function withModel(fields: Partial<IpkgModel>): ProjectRoot {
  const root = projectRoot();
  if (root.model.status !== 'ok') {
    throw new Error('fixture');
  }
  return { ...root, model: { ...root.model, model: { ...root.model.model, ...fields } } };
}

/** The package file of `root`, read back as the compiler's parser reads it. */
function readBack(root: ProjectRoot | typeof LOOSE, extraArgs: readonly string[] = []): { text: string; sourceDir: string; model: IpkgModel } {
  const shadow = shadowPackage(root, extraArgs);
  if ('problem' in shadow) {
    throw new Error(shadow.problem);
  }
  const read = readIpkgText(shadow.text);
  if (read.status !== 'ok') {
    throw new Error(`${read.error.message}\n${shadow.text}`);
  }
  return { ...shadow, model: read.model };
}

suite('backend/ide/shadow', () => {
  suite('the options the package file keeps', () => {
    test('without an option that is left out, every word is kept as it is, mistakes included (the compiler reports them as for the check session)', () => {
      for (const opts of ['--total', '--total -Wno-shadowing --no-prelude', '--no-color --console-width 0', '--ignore-missing-ipkg', '--exec main --cg chez', '--frobnicate', '-p']) {
        assert.deepStrictEqual(shadowPackageOptions(opts), { kept: opts.split(' '), left: [], sourceDir: undefined }, opts);
      }
      assert.deepStrictEqual(shadowPackageOptions(undefined), { kept: [], left: [], sourceDir: undefined });
      assert.deepStrictEqual(shadowPackageOptions(' \t--total\n  -Werror '), { kept: ['--total', '-Werror'], left: [], sourceDir: undefined }, 'split as the compiler splits them');
    });

    test('the options that name directories or written files are left out with their word, read with the compiler\'s parser', () => {
      assert.deepStrictEqual(shadowPackageOptions('--build-dir tmp --total'), { kept: ['--total'], left: ['--build-dir', 'tmp'], sourceDir: undefined });
      assert.deepStrictEqual(shadowPackageOptions('--total --output-dir /abs/out --dumpcases cases.txt --dumplifted l --dumpanf a --dumpvmcode v -Werror'), {
        kept: ['--total', '-Werror'],
        left: ['--output-dir', '/abs/out', '--dumpcases', 'cases.txt', '--dumplifted', 'l', '--dumpanf', 'a', '--dumpvmcode', 'v'],
        sourceDir: undefined,
      });
      // A word another option takes is that option's: `-p` takes `--build-dir` as its package name.
      assert.deepStrictEqual(shadowPackageOptions('-p --build-dir'), { kept: ['-p', '--build-dir'], left: [], sourceDir: undefined });
      // `Required` takes the next word whatever it is; `Optional` only one that does not start with `-`.
      assert.deepStrictEqual(shadowPackageOptions('--repl --build-dir x'), { kept: ['--repl'], left: ['--build-dir', 'x'], sourceDir: undefined });
      assert.deepStrictEqual(shadowPackageOptions('--repl p.ipkg --build-dir x'), { kept: ['--repl', 'p.ipkg'], left: ['--build-dir', 'x'], sourceDir: undefined });
      assert.deepStrictEqual(shadowPackageOptions('--log 2 --console-width auto --build-dir x'), { kept: ['--log', '2', '--console-width', 'auto'], left: ['--build-dir', 'x'], sourceDir: undefined });
      assert.deepStrictEqual(shadowPackageOptions('--bash-completion a b --build-dir x'), { kept: ['--bash-completion', 'a', 'b'], left: ['--build-dir', 'x'], sourceDir: undefined });
      // `--bash-completion` takes two words whatever they are: here the `--build-dir` is one.
      assert.deepStrictEqual(shadowPackageOptions('--bash-completion a --build-dir'), { kept: ['--bash-completion', 'a', '--build-dir'], left: [], sourceDir: undefined });
      // A word that is no option and does not start with `--` is an input file, which a load ignores.
      assert.deepStrictEqual(shadowPackageOptions('--build-dir x Main.idr -Wfoo'), { kept: ['Main.idr', '-Wfoo'], left: ['--build-dir', 'x'], sourceDir: undefined });
    });

    test('--source-dir: left out, and its directory, the last one, is the source directory the check session uses', () => {
      assert.deepStrictEqual(shadowPackageOptions('--source-dir lib --total'), { kept: ['--total'], left: ['--source-dir', 'lib'], sourceDir: 'lib' });
      assert.deepStrictEqual(shadowPackageOptions('--source-dir a --source-dir b'), { kept: [], left: ['--source-dir', 'a', '--source-dir', 'b'], sourceDir: 'b' });
    });

    test('problems: an option left out among words the parser cannot read, or a control character', () => {
      assert.deepStrictEqual(shadowPackageOptions('--total --build-dir'), { problem: "the package's opts end with --build-dir without its value" });
      assert.deepStrictEqual(shadowPackageOptions('--build-dir x --frobnicate'), { problem: 'the package\'s opts contain "--frobnicate", which the compiler does not know' });
      assert.deepStrictEqual(shadowPackageOptions('--bash-completion --build-dir'), { problem: "the package's opts end with --bash-completion without its value" });
      assert.deepStrictEqual(shadowPackageOptions('--total \u0001x'), { problem: 'the package\'s opts contain a word with a control character ("\\u0001x")' });
    });
  });

  suite('the package file', () => {
    test('a project: its name, its depends with their bounds, the options kept, sourcedir "src"; read back the same', () => {
      const root = withModel({
        depends: [
          { name: 'contrib', bounds: ANY },
          { name: 'base', bounds: { lower: '0.8.0', lowerInclusive: true, upper: '0.9', upperInclusive: false } },
          { name: 'linear', bounds: { lower: '1.0', lowerInclusive: false, upper: undefined, upperInclusive: true } },
          { name: 'network', bounds: { lower: undefined, lowerInclusive: true, upper: '2', upperInclusive: true } },
          { name: 'test', bounds: { lower: '0.8.0', lowerInclusive: true, upper: '0.8.0', upperInclusive: true } },
        ],
        opts: '--total --build-dir out -Wno-shadowing',
      });
      const { text, sourceDir, model } = readBack(root);
      assert.match(text, /^-- Written by the Idris 2 extension/);
      assert.match(text, /\ndepends = contrib, base >= 0\.8\.0 && < 0\.9, linear > 1\.0, network <= 2, test >= 0\.8\.0 && <= 0\.8\.0\n/);
      assert.strictEqual(model.name, 'simple-ipkg');
      assert.strictEqual(model.sourcedir, SHADOW_SOURCE_DIR);
      assert.strictEqual(model.builddir, undefined, 'no builddir: the session\'s --build-dir holds');
      assert.strictEqual(model.opts, '--total -Wno-shadowing');
      assert.deepStrictEqual(
        model.depends,
        root.model.status === 'ok' ? root.model.model.depends : [],
        'the bounds the compiler will read are the package\'s',
      );
      assert.strictEqual(sourceDir, 'src', 'the root\'s source directory, for the copy\'s path');
    });

    test('no depends, no opts: neither field; the words of opts written back as the lexer read them, escapes included', () => {
      const plain = readBack(withModel({ depends: [], opts: undefined }));
      assert.doesNotMatch(plain.text, /depends|opts/);
      assert.deepStrictEqual(plain.model.depends, []);
      // The field `opts = "--directive \"a\\b\" --total"` reads as these words (`StringLit (stripQuotes s)`).
      const raw = '--directive \\"a\\\\b\\" --total';
      const quoted = readBack(withModel({ opts: raw }));
      assert.ok(quoted.text.includes(`\nopts = "${raw}"\n`), quoted.text);
      assert.strictEqual(quoted.model.opts, raw);
    });

    test('the source directory: the last --source-dir of opts, else sourcedir, else extraArgs\' last one, else "."', () => {
      assert.strictEqual(readBack(withModel({ opts: '--source-dir lib' })).sourceDir, 'lib');
      assert.strictEqual(readBack(withModel({}), ['--source-dir', 'x']).sourceDir, 'src');
      assert.strictEqual(readBack(withModel({ sourcedir: undefined }), ['--source-dir', 'x', '--source-dir', 'y']).sourceDir, 'y');
      assert.strictEqual(readBack(withModel({ sourcedir: undefined })).sourceDir, '.');
    });

    test('a loose file: a package of its own with nothing in it but its source directory', () => {
      const { text, sourceDir, model } = readBack(LOOSE);
      assert.match(text, /\npackage shadow\nsourcedir = "src"\n$/);
      assert.deepStrictEqual([model.name, model.depends, model.opts], ['shadow', [], undefined]);
      assert.strictEqual(sourceDir, '.');
      assert.strictEqual(readBack(LOOSE, ['--source-dir', 'lib']).sourceDir, 'lib');
    });

    test('problems: a package file that could not be read, opts that cannot be read, a bound that is no version', () => {
      assert.deepStrictEqual(shadowPackage(projectRoot({ model: { status: 'error', source: 'dump-json', error: { message: 'x' } } }), []), {
        problem: 'its package file could not be read',
      });
      assert.deepStrictEqual(shadowPackage(withModel({ opts: '--build-dir' }), []), { problem: "the package's opts end with --build-dir without its value" });
      assert.deepStrictEqual(shadowPackage(withModel({ depends: [{ name: 'odd', bounds: { ...ANY, lower: '1.x' } }] }), []), {
        problem: 'the version bounds of its dependency odd cannot be written in a package file',
      });
    });
  });

  test('the shadow-* fixture workspaces (the recorded shadow sessions\' directories) hold the package file the extension writes for simple-ipkg', () => {
    // The model as the extension reads it in the fake-tool suites: from the recorded --dump-ipkg-json output.
    const recorded = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'test', 'fake-idris2', 'recorded-cli-0.8.0.json'), 'utf8')) as {
      dumpIpkgJson: { ipkg: string; stdout: string }[];
    };
    const dump = recorded.dumpIpkgJson.find((entry) => entry.ipkg === 'test/fixtures/workspaces/simple-ipkg/simple.ipkg');
    assert.ok(dump !== undefined);
    const model = modelFromDumpOutput({ exitCode: 0, signal: null, stdout: dump.stdout, stderr: '', timedOut: false, durationMs: 0 });
    assert.ok(model?.status === 'ok');
    const shadow = shadowPackage(projectRoot({ model }), []);
    assert.ok('text' in shadow);
    for (const workspace of ['shadow-simple-error', 'shadow-simple-hole']) {
      assert.strictEqual(fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', workspace, 'shadow.ipkg'), 'utf8'), shadow.text, workspace);
    }
  });

  suite('where the copy goes', () => {
    test('its path below the source directory, resolved against the session directory; none outside it', () => {
      assert.deepStrictEqual(shadowCopyPath('/w/p', 'src', '/w/p/src/Foo/B.idr', 'darwin'), { relative: 'Foo/B.idr' });
      assert.deepStrictEqual(shadowCopyPath('/w/p', '.', '/w/p/Main.lidr', 'darwin'), { relative: 'Main.lidr' });
      assert.deepStrictEqual(shadowCopyPath('/w/p', '/abs/lib', '/abs/lib/X.idr', 'darwin'), { relative: 'X.idr' });
      assert.deepStrictEqual(shadowCopyPath('/w/p', 'src', '/w/p/src/..odd/X.idr', 'darwin'), { relative: '..odd/X.idr' }, 'a folder whose name starts with two dots');
      assert.deepStrictEqual(shadowCopyPath('/w/p', 'src', '/w/p/tests/T.idr', 'darwin'), { problem: 'T.idr is not inside the source directory /w/p/src' });
      assert.deepStrictEqual(shadowCopyPath('/w/p', 'src', '/w/p/src', 'darwin'), { problem: 'src is not inside the source directory /w/p/src' });
      assert.deepStrictEqual(shadowCopyPath('C:\\w\\p', 'src', 'C:\\w\\p\\src\\Foo\\B.idr', 'win32'), { relative: 'Foo\\B.idr' });
      assert.deepStrictEqual(shadowCopyPath('C:\\w\\p', 'src', 'D:\\other\\B.idr', 'win32'), { problem: 'B.idr is not inside the source directory C:\\w\\p\\src' });
    });

    test('the shadow directory: 16 hexadecimal digits of a hash of the root, so that no name of it shows', () => {
      const project = shadowDirectoryOf('/g/shadow', projectRoot(), 'darwin');
      assert.match(project, /^\/g\/shadow\/[0-9a-f]{16}$/);
      assert.strictEqual(shadowDirectoryOf('/g/shadow', projectRoot(), 'darwin'), project, 'the same root, the same directory');
      assert.notStrictEqual(shadowDirectoryOf('/g/shadow', LOOSE, 'darwin'), project);
      assert.doesNotMatch(project, /simple|ipkg/);
      assert.match(shadowDirectoryOf('C:\\g\\shadow', LOOSE, 'win32'), /^C:\\g\\shadow\\[0-9a-f]{16}$/);
    });
  });
});
