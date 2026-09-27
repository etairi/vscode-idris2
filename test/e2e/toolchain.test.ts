// E2E (ROADMAP M1 acceptance): toolchain discovery and the project model against the real
// idris2. Every expected value is read from the real compiler in the same run, so the suite
// checks shapes and agreement, not the literal 0.8.0 of the development machine (the macOS CI
// job's `brew install idris2` will move past it).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Idris2Info, ToolchainSnapshot, ToolLocation } from '../../src/toolchain/types';
import { extensionApi, extensionIdle, firstOnPath, runReal, waitFor, workspaceDir } from './helpers';

/** `idris2 --version`: `Idris 2, version ` + showVersion True (Libraries/Data/Version.idr 26–38). */
const VERSION_LINE = /^Idris 2, version (\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

suite('E2E: toolchain discovery with the real idris2', () => {
  let snapshot: ToolchainSnapshot;
  let location: ToolLocation;
  let info: Idris2Info;

  suiteSetup(async function () {
    this.timeout(90000);
    const api = await extensionApi();
    // The last scan (the activation scan, or the one that followed install.test.ts restoring its
    // setting); this suite forces none.
    await waitFor('the first toolchain scan', () => api.toolchain.current);
    await extensionIdle(api);
    const current = api.toolchain.current;
    assert.ok(current);
    snapshot = current;
    assert.ok(snapshot.trusted, 'the e2e workspace is trusted (@vscode/test-electron passes --disable-workspace-trust)');
    const idris2 = snapshot.idris2;
    assert.strictEqual(idris2.status, 'probed', `idris2 was not probed: ${JSON.stringify(idris2)}`);
    location = idris2.location;
    info = idris2.info;
  });

  test('the idris2 found is the first on PATH, or else one in a well-known directory', () => {
    // The e2e profile sets no idris2.toolchain.* setting, so the search runs (ARCHITECTURE §11).
    assert.strictEqual(snapshot.settings.idris2Path, '');
    const onPath = firstOnPath('idris2');
    if (onPath !== undefined) {
      assert.strictEqual(location.source, 'PATH');
      assert.strictEqual(location.path, onPath);
    } else {
      assert.strictEqual(location.source, 'wellKnown');
    }
    assert.ok(path.isAbsolute(location.path), location.path);
  });

  test('the parsed version equals what idris2 --version prints in this run', () => {
    const printed = runReal(location.path, ['--version']).split('\n')[0];
    const m = VERSION_LINE.exec(printed);
    assert.ok(m, `unexpected --version output: ${printed}`);
    assert.strictEqual(info.versionLine, printed);
    const version = info.version;
    assert.ok(version, 'the version line was not parsed');
    assert.strictEqual(version.major, Number(m[1]));
    assert.strictEqual(version.minor, Number(m[2]));
    assert.strictEqual(version.patch, Number(m[3]));
    assert.strictEqual(version.tag, m[4]);
    assert.strictEqual(version.text, printed.slice('Idris 2, version '.length));
  });

  test('the TTC version equals what idris2 --ttc-version prints in this run', () => {
    const printed = runReal(location.path, ['--ttc-version']).trim();
    assert.match(printed, /^\d+$/);
    assert.strictEqual(info.ttcVersion, printed);
  });

  test('--paths and --list-packages were read; contrib is installed for this TTC version', () => {
    assert.ok(info.pathsText?.includes('+ Working Directory'), info.pathsText);
    const packages = info.packages;
    assert.ok(packages, '--list-packages was not parsed');
    for (const name of ['prelude', 'base', 'contrib']) {
      assert.ok(packages.some((p) => p.name === name), `${name} is missing from ${JSON.stringify(packages)}`);
    }
    const contrib = packages.find((p) => p.name === 'contrib');
    assert.ok(contrib?.ttcVersions.includes(info.ttcVersion ?? ''), JSON.stringify(contrib));
    for (const p of packages) {
      assert.ok(path.isAbsolute(p.path), JSON.stringify(p));
      assert.ok(p.ttcVersions.every((v) => /^\d+$/.test(v)), JSON.stringify(p));
    }
  });
});

suite('E2E: the simple-ipkg project read with --dump-ipkg-json', () => {
  test('Foo/B.idr belongs to the simple-ipkg root, whose model comes from the compiler', async function () {
    this.timeout(90000);
    const api = await extensionApi();
    await waitFor('the first toolchain scan', () => api.toolchain.current);
    const dir = workspaceDir();
    const ipkgs = fs.readdirSync(dir).filter((name) => name.endsWith('.ipkg'));
    assert.strictEqual(ipkgs.length, 1, `expected one .ipkg in ${dir}: ${ipkgs.join(', ')}`);
    const ipkg = path.join(dir, ipkgs[0]);

    // The index re-reads a model after each toolchain snapshot, so a model read before the
    // first scan finished (with the fallback reader) is replaced by the compiler's.
    const root = await waitFor('a model read with --dump-ipkg-json', async () => {
      const c = await api.projects.classify(path.join(dir, 'src', 'Foo', 'B.idr'));
      return c.kind === 'project' && c.model.source === 'dump-json' ? c : undefined;
    });
    assert.strictEqual(root.ipkgPath, ipkg);
    assert.strictEqual(root.dir, dir);
    assert.deepStrictEqual(root.otherIpkgs, []);
    assert.strictEqual(root.model.status, 'ok', JSON.stringify(root.model));
    const model = root.model.model;

    // What the compiler prints in this run, run as the index runs it: the absolute path of the
    // ipkg, in the compiler's own directory (project/ipkg.ts readIpkgModel).
    await extensionIdle(api);
    const location = api.toolchain.current?.idris2;
    assert.strictEqual(location?.status, 'probed');
    const executable = location.location.path;
    const printed = JSON.parse(runReal(executable, ['--dump-ipkg-json', ipkg], path.dirname(executable))) as {
      name: string;
      sourcedir?: string;
      modules: string[];
      depends: Record<string, unknown>[];
    };
    assert.strictEqual(printed.sourcedir, 'src');
    // ROADMAP M1 acceptance: `depends = [contrib]`, exactly (one key per dependency object).
    assert.deepStrictEqual(printed.depends.map((d) => Object.keys(d)), [['contrib']], JSON.stringify(printed.depends));

    assert.strictEqual(model.name, printed.name);
    assert.strictEqual(model.sourcedir, 'src');
    assert.deepStrictEqual([...model.modules], printed.modules);
    assert.deepStrictEqual(
      model.depends.map((d) => d.name),
      printed.depends.map((d) => Object.keys(d)[0]),
    );
    assert.strictEqual(api.projects.sessionCwd(root), dir);
    assert.strictEqual(api.projects.pathToModule(root, path.join(dir, 'src', 'Foo', 'B.idr')), 'Foo.B');
  });

  test('Show Setup Information lists the version and TTC version the compiler printed', async function () {
    this.timeout(60000);
    const api = await extensionApi();
    const snapshot = await waitFor('the first toolchain scan', () => api.toolchain.current);
    assert.strictEqual(snapshot.idris2.status, 'probed');
    const { versionLine, ttcVersion } = snapshot.idris2.info;
    assert.ok(ttcVersion);
    await vscode.commands.executeCommand('idris2.showSetupInformation');
    const text = await waitFor('the Setup Information document', () => {
      const document = vscode.window.activeTextEditor?.document;
      return document?.uri.toString() === api.setupInformationUri.toString() ? document.getText() : undefined;
    });
    assert.ok(text.includes(versionLine), text);
    assert.ok(text.includes(ttcVersion), text);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});

