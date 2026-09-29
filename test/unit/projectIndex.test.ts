import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Log } from '../../src/core/log';
import { Emitter } from '../../src/core/event';
import type { WorkspaceTrust } from '../../src/core/trust';
import type { DirectoryLister } from '../../src/project/ipkg';
import { createProjectIndex } from '../../src/project/index';
import { MODULE_SOURCE_EXTENSIONS } from '../../src/project/literate';
import type { Classification, ProjectIndex, ProjectRoot, ProjectWorkspace } from '../../src/project/types';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../../src/toolchain/types';
import { repoRoot } from '../fake-tools/paths';
import { FIXTURE_RECORDINGS } from './support/ipkgRecordings';
import { FakeToolchain, IDRIS2_PATH, SETTINGS, missing, snapshot } from './support/toolchainFixtures';

const FIXTURES = path.join(repoRoot(), 'test', 'fixtures');
const SIMPLE = path.join(FIXTURES, 'workspaces', 'simple-ipkg');
const IPKG_FIXTURES = path.join(FIXTURES, 'ipkg');
const ENV = { IDRIS2_PREFIX: '/opt/prefix' };

/** Every `.ipkg` below `dir`, as `vscode.workspace.findFiles('**\/*.ipkg')` would report them. */
function ipkgFilesBelow(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? ipkgFilesBelow(p) : entry.name.endsWith('.ipkg') ? [p] : [];
  });
}

class FakeWorkspace implements ProjectWorkspace {
  findCalls = 0;
  readonly foldersChanged = new Emitter<void>();
  readonly ipkgCreatedOrDeleted = new Emitter<string>();
  readonly ipkgChanged = new Emitter<string>();
  readonly pathCreatedOrDeleted = new Emitter<string>();
  readonly onDidChangeFolders = this.foldersChanged.event;
  readonly onDidCreateOrDeleteIpkgFile = this.ipkgCreatedOrDeleted.event;
  readonly onDidChangeIpkgFile = this.ipkgChanged.event;
  readonly onDidCreateOrDeletePath = this.pathCreatedOrDeleted.event;

  constructor(public folderList: string[]) {}

  folders(): readonly string[] {
    return this.folderList;
  }

  findIpkgFiles(): Promise<readonly string[]> {
    this.findCalls++;
    return Promise.resolve(this.folderList.flatMap(ipkgFilesBelow));
  }
}

/** Answers `--dump-ipkg-json <name>` in `cwd` with the recording of that fixture; records every request. */
class FakeRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  /** Called synchronously inside `run`, e.g. to change something while a read starts. */
  beforeAnswer: (() => void) | undefined;
  /** While set, answers wait for it: a process that is still running. */
  gate: Promise<void> | undefined;
  /** Answers queued by a test, used (and removed) before the recordings. */
  readonly answers: ProcessResult[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    this.beforeAnswer?.();
    await this.gate;
    const answer = this.answers.shift();
    if (answer !== undefined) {
      return answer;
    }
    const file = request.args[1] ?? ''; // `--dump-ipkg-json <absolute path>`
    const recording = FIXTURE_RECORDINGS.find((r) => path.join(repoRoot(), ...r.file.split('/')) === file);
    return recording === undefined
      ? { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT', durationMs: 0 }
      : { exitCode: recording.exitCode, signal: null, stdout: recording.stdout, stderr: recording.stderr, timedOut: false, durationMs: 1 };
  }
}

class FakeTrust implements WorkspaceTrust {
  private readonly granted = new Emitter<void>();
  readonly onDidGrant = this.granted.event;

  constructor(public isTrusted: boolean) {}
}

interface Harness {
  readonly index: ProjectIndex;
  readonly workspace: FakeWorkspace;
  readonly runner: FakeRunner;
  readonly toolchain: FakeToolchain;
  readonly warnings: string[];
  /** How often `onDidChange` fired. */
  changes(): number;
}

function harness(
  options: {
    folders?: string[];
    trusted?: boolean;
    toolchain?: FakeToolchain;
    listDirectory?: DirectoryLister;
  } = {},
): Harness {
  // By default the whole fixture tree is the workspace, so its package files are read by the compiler.
  const workspace = new FakeWorkspace(options.folders ?? [FIXTURES]);
  const runner = new FakeRunner();
  // The compiler runs with the environment of the snapshot that probed it.
  const toolchain = options.toolchain ?? new FakeToolchain(snapshot({ settings: { ...SETTINGS, env: ENV } }));
  const warnings: string[] = [];
  const ignore = (): void => undefined;
  const log: Log = { trace: ignore, debug: ignore, info: ignore, warn: (m: string) => void warnings.push(m), error: ignore };
  const index = createProjectIndex(
    {
      workspace,
      toolchain,
      runner,
      trust: new FakeTrust(options.trusted ?? true),
      log,
    },
    options.listDirectory,
  );
  let changes = 0;
  index.onDidChange(() => changes++);
  return { index, workspace, runner, toolchain, warnings, changes: () => changes };
}

/** Resolves once `condition()` holds; fails after 5 s (a deadline, not a timing assertion). */
async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function asRoot(classification: Classification): ProjectRoot {
  assert.strictEqual(classification.kind, 'project', JSON.stringify(classification));
  return classification as ProjectRoot;
}

suite('project/index (ProjectIndex)', () => {
  const disposables: { dispose(): unknown }[] = [];
  teardown(() => {
    for (const d of disposables.splice(0)) {
      d.dispose();
    }
  });
  function track(h: Harness): Harness {
    disposables.push(h.index);
    return h;
  }

  suite('classification (F13: the walk is not capped by the workspace folder)', () => {
    const SIMPLE_MODEL = {
      name: 'simple',
      version: '0.1.0',
      depends: [{ name: 'contrib', bounds: { lower: undefined, lowerInclusive: true, upper: undefined, upperInclusive: true } }],
      modules: ['Foo.A', 'Foo.B'],
      sourcedir: 'src',
    };

    test('simple-ipkg opened as the folder: Foo/B.idr belongs to simple.ipkg, read by the compiler', async () => {
      const h = track(harness({ folders: [SIMPLE] }));
      const b = path.join(SIMPLE, 'src', 'Foo', 'B.idr');
      const root = asRoot(await h.index.classify(b));
      assert.deepStrictEqual(root, {
        kind: 'project',
        ipkgPath: path.join(SIMPLE, 'simple.ipkg'),
        dir: SIMPLE,
        otherIpkgs: [],
        insideWorkspace: true,
        model: { status: 'ok', source: 'dump-json', model: SIMPLE_MODEL },
      });
      assert.deepStrictEqual(h.runner.requests, [
        { executable: IDRIS2_PATH, args: ['--dump-ipkg-json', path.join(SIMPLE, 'simple.ipkg')], env: ENV, timeoutMs: 5000 },
      ]);
      assert.strictEqual(h.index.sessionCwd(root), SIMPLE);
      assert.strictEqual(h.index.pathToModule(root, b), 'Foo.B');
    });

    test('simple-ipkg opened at src/: the ipkg above the folder is the root, read without the compiler', async () => {
      // Workspace trust covers the folder, not the directory above it, where --dump-ipkg-json
      // would run (docs/as-built/M1.md, *Roots outside the workspace folders*); the fallback
      // reader gives the same model.
      const h = track(harness({ folders: [path.join(SIMPLE, 'src')] }));
      const b = path.join(SIMPLE, 'src', 'Foo', 'B.idr');
      const root = asRoot(await h.index.classify(b));
      assert.deepStrictEqual(root, {
        kind: 'project',
        ipkgPath: path.join(SIMPLE, 'simple.ipkg'),
        dir: SIMPLE,
        otherIpkgs: [],
        insideWorkspace: false,
        model: { status: 'ok', source: 'fallback', model: SIMPLE_MODEL },
      });
      assert.deepStrictEqual(h.runner.requests, []);
      assert.strictEqual(h.index.sessionCwd(root), SIMPLE);
      assert.strictEqual(h.index.pathToModule(root, b), 'Foo.B');
      assert.deepStrictEqual(await h.index.roots(), [], 'the ipkg lies above the only workspace folder');
    });

    test('a change of the workspace folders reads the models again: the root moves inside', async () => {
      const h = track(harness({ folders: [path.join(SIMPLE, 'src')] }));
      const b = path.join(SIMPLE, 'src', 'Foo', 'B.idr');
      assert.strictEqual(asRoot(await h.index.classify(b)).model.source, 'fallback');
      const before = h.changes();
      h.workspace.folderList = [SIMPLE];
      h.workspace.foldersChanged.fire();
      assert.ok(h.changes() > before);
      const root = asRoot(await h.index.classify(b));
      assert.strictEqual(root.insideWorkspace, true);
      assert.strictEqual(root.model.source, 'dump-json');
    });

    test('a loose file: its own directory, its module is its file name', async () => {
      const top = path.resolve('/');
      const w = path.join(top, 'w');
      const h = track(harness({ listDirectory: (dir) => Promise.resolve(dir === w ? ['Main.idr', 'sub'] : dir === top ? ['w'] : []) }));
      const loose = await h.index.classify(path.join(w, 'Main.idr'));
      assert.deepStrictEqual(loose, { kind: 'loose', dir: w });
      assert.strictEqual(h.index.sessionCwd(loose), w);
      assert.strictEqual(h.index.pathToModule(loose, path.join(w, 'Main.idr')), 'Main');
      assert.strictEqual(h.index.pathToModule(loose, path.join(w, 'sub', 'A.lidr')), 'sub.A');
      assert.strictEqual(h.index.pathToModule(loose, path.join(top, 'Other.idr')), undefined);
      assert.deepStrictEqual(
        h.index.moduleToPaths(loose, 'A.B'),
        MODULE_SOURCE_EXTENSIONS.map((ext) => path.join(w, 'A', 'B') + ext),
      );
      assert.deepStrictEqual(h.runner.requests, []);
    });

    test('several package files in one directory: the first listed is read, the others named, a warning logged (F10)', async () => {
      const top = path.resolve('/');
      const p = path.join(top, 'p');
      const h = track(
        harness({ trusted: false, listDirectory: (dir) => Promise.resolve(dir === p ? ['z.ipkg', 'X.idr', 'a.ipkg'] : ['p']) }),
      );
      const root = asRoot(await h.index.classify(path.join(p, 'X.idr')));
      assert.strictEqual(root.ipkgPath, path.join(p, 'z.ipkg'));
      assert.deepStrictEqual(root.otherIpkgs, [path.join(p, 'a.ipkg')]);
      assert.ok(h.warnings.some((w) => w.includes('z.ipkg') && w.includes('a.ipkg')), h.warnings.join('\n'));
    });

    test('with two real package files the root agrees with the walk over the OS listing', async () => {
      const dir = path.join(IPKG_FIXTURES, 'two-ipkgs');
      const h = track(harness());
      const root = asRoot(await h.index.classify(path.join(dir, 'Any.idr')));
      assert.deepStrictEqual([root.ipkgPath, ...root.otherIpkgs].map((p) => path.basename(p)).sort(), ['first.ipkg', 'second.ipkg']);
      assert.strictEqual(root.model.status, 'ok');
    });
  });

  suite('reading models', () => {
    test('in Restricted Mode nothing is run: the fallback reader', async () => {
      const h = track(harness({ trusted: false }));
      const root = asRoot(await h.index.classify(path.join(SIMPLE, 'src', 'Foo', 'B.idr')));
      assert.strictEqual(root.model.source, 'fallback');
      assert.strictEqual(root.model.status === 'ok' && root.model.model.sourcedir, 'src');
      assert.deepStrictEqual(h.runner.requests, []);
    });

    test('without a probed idris2 nothing is run: the fallback reader', async () => {
      const h = track(harness({ toolchain: new FakeToolchain(snapshot({ idris2: missing() })) }));
      const root = asRoot(await h.index.classify(path.join(SIMPLE, 'src', 'Foo', 'B.idr')));
      assert.strictEqual(root.model.source, 'fallback');
      assert.deepStrictEqual(h.runner.requests, []);
    });

    test('before the first scan the fallback reader answers; the first snapshot fires onDidChange and the compiler reads', async () => {
      const toolchain = new FakeToolchain(undefined);
      const h = track(harness({ toolchain }));
      const b = path.join(SIMPLE, 'src', 'Foo', 'B.idr');
      assert.strictEqual(asRoot(await h.index.classify(b)).model.source, 'fallback');
      const before = h.changes();
      toolchain.publish();
      assert.strictEqual(h.changes(), before + 1);
      assert.strictEqual(asRoot(await h.index.classify(b)).model.source, 'dump-json');
    });

    test('a malformed package file: an error model, no module mapping, the session still runs in its directory', async () => {
      const dir = path.join(IPKG_FIXTURES, 'bad-property');
      const h = track(harness());
      const root = asRoot(await h.index.classify(path.join(dir, 'A.idr')));
      assert.deepStrictEqual(root.model, {
        status: 'error',
        source: 'dump-json',
        error: { message: 'Unrecognised property "pkgs".', range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 5 } },
      });
      assert.strictEqual(h.index.pathToModule(root, path.join(dir, 'A.idr')), undefined);
      assert.deepStrictEqual(h.index.moduleToPaths(root, 'A'), []);
      assert.strictEqual(h.index.sessionCwd(root), dir);
    });
  });

  suite('caching and invalidation', () => {
    const b = path.join(SIMPLE, 'src', 'Foo', 'B.idr');

    test('classifying again, or concurrently, reads the package file once', async () => {
      const h = track(harness());
      const [first, second] = await Promise.all([h.index.classify(b), h.index.classify(path.join(SIMPLE, 'src', 'Foo', 'A.idr'))]);
      const third = await h.index.classify(b);
      assert.strictEqual(h.runner.requests.length, 1);
      assert.strictEqual(first, second);
      assert.strictEqual(first, third);
    });

    test('a changed .ipkg drops its model and fires onDidChange; the next classify reads again', async () => {
      const h = track(harness());
      await h.index.classify(b);
      const before = h.changes();
      h.workspace.ipkgChanged.fire(path.join(SIMPLE, 'simple.ipkg'));
      assert.strictEqual(h.changes(), before + 1);
      await h.index.classify(b);
      assert.strictEqual(h.runner.requests.length, 2);
    });

    test('a new toolchain snapshot re-reads every model; a change of the scanning flag alone does not', async () => {
      const h = track(harness());
      await h.index.classify(b);
      h.toolchain.setScanning(true);
      await h.index.classify(b);
      assert.strictEqual(h.runner.requests.length, 1);
      h.toolchain.publish();
      await h.index.classify(b);
      assert.strictEqual(h.runner.requests.length, 2);
    });

    test('a change while idris2 runs makes classify read again rather than return the stale model', async () => {
      const h = track(harness());
      let release = (): void => undefined;
      h.runner.gate = new Promise((resolve) => (release = resolve));
      const pending = h.index.classify(b);
      await waitUntil(() => h.runner.requests.length === 1, 'the first read');
      h.workspace.ipkgChanged.fire(path.join(SIMPLE, 'simple.ipkg'));
      h.runner.gate = undefined;
      release();
      const root = asRoot(await pending);
      assert.strictEqual(h.runner.requests.length, 2);
      assert.strictEqual(root, asRoot(await h.index.classify(b)), 'the second read is the one cached');
    });

    test('a change as a read starts is not lost either', async () => {
      const h = track(harness());
      h.runner.beforeAnswer = () => {
        h.runner.beforeAnswer = undefined;
        h.workspace.ipkgChanged.fire(path.join(SIMPLE, 'simple.ipkg'));
      };
      const root = asRoot(await h.index.classify(b));
      assert.strictEqual(h.runner.requests.length, 2);
      assert.strictEqual(root, asRoot(await h.index.classify(b)), 'the second read is the one cached');
    });

    test('after dispose() workspace events do nothing, and no compiler is started', async () => {
      const h = track(harness({ folders: [SIMPLE] }));
      assert.strictEqual((await h.index.roots()).length, 1);
      h.index.dispose();
      const calls = h.workspace.findCalls;
      const changes = h.changes();
      const requests = h.runner.requests.length;
      h.workspace.ipkgChanged.fire(path.join(SIMPLE, 'simple.ipkg'));
      h.workspace.ipkgCreatedOrDeleted.fire(path.join(SIMPLE, 'simple.ipkg'));
      h.workspace.foldersChanged.fire();
      h.workspace.pathCreatedOrDeleted.fire(path.join(SIMPLE, 'src', 'Foo', 'C.idr'));
      h.workspace.pathCreatedOrDeleted.fire(path.join(SIMPLE, 'src'));
      h.toolchain.publish();
      assert.strictEqual(h.workspace.findCalls, calls);
      assert.strictEqual(h.changes(), changes);
      assert.strictEqual(asRoot(await h.index.classify(path.join(IPKG_FIXTURES, 'versions', 'X.idr'))).model.source, 'fallback');
      assert.strictEqual(h.runner.requests.length, requests);
    });

    test('a changed .ipkg drops only its model: no walk and no scan of the workspace again', async () => {
      const h = track(harness({ folders: [SIMPLE] }));
      await h.index.roots();
      const scans = h.workspace.findCalls;
      h.workspace.ipkgChanged.fire(path.join(SIMPLE, 'simple.ipkg'));
      await h.index.classify(b);
      assert.strictEqual(h.runner.requests.length, 2, 'the model was read again');
      assert.strictEqual(h.workspace.findCalls, scans, 'the workspace was not scanned again');
      h.workspace.ipkgCreatedOrDeleted.fire(path.join(SIMPLE, 'other.ipkg'));
      await h.index.roots();
      assert.strictEqual(h.workspace.findCalls, scans + 1, 'a created or deleted .ipkg rescans the workspace');
    });

    test('the compiler runs with the environment of the snapshot that probed it', async () => {
      const h = track(harness({ folders: [SIMPLE] }));
      await h.index.classify(b);
      h.toolchain.publish({ settings: { ...SETTINGS, env: { IDRIS2_PREFIX: '/new' } } });
      await h.index.classify(b);
      assert.deepStrictEqual(
        h.runner.requests.map((r) => r.env),
        [ENV, { IDRIS2_PREFIX: '/new' }],
      );
    });

    suite('created and deleted paths: files and folders (the compiler checks that listed modules and main exist)', () => {
      // Each test first awaits roots(), which waits for the scan of the workspace, so that no
      // change event of that scan is counted.
      const newModule = path.join(SIMPLE, 'src', 'Foo', 'New.idr');
      const PAST_THE_PAUSE_MS = 600;
      /** The shape of the recorded error of miss.ipkg (test/unit/support/ipkgRecordings.ts). */
      const notFound = (module: string): ProcessResult => ({
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: `Error: Module ${module} not found\n\n"simple.ipkg":5:11--6:1\n\n`,
        timedOut: false,
        durationMs: 1,
      });

      test('a compiler error such as "Module Foo.New not found" is read again once a module file appears', async () => {
        const h = track(harness({ folders: [SIMPLE] }));
        h.runner.answers.push(notFound('Foo.New'));
        const [first] = await h.index.roots();
        assert.ok(first.model.status === 'error' && first.model.error.message === 'Module Foo.New not found', JSON.stringify(first));
        assert.strictEqual(h.index.pathToModule(first, b), undefined);
        const before = h.changes();
        h.workspace.pathCreatedOrDeleted.fire(newModule);
        await waitUntil(() => h.changes() > before, 'the change after the pause');
        const second = asRoot(await h.index.classify(b));
        assert.strictEqual(second.model.status, 'ok');
        assert.strictEqual(h.index.pathToModule(second, b), 'Foo.B');
        assert.strictEqual(h.runner.requests.length, 2);
      });

      test('a folder moved in or restored, reported alone, re-reads a "Module … not found" error', async () => {
        // `mv /tmp/Foo src/Foo` or Undo in the Explorer: one event for the folder, none for its
        // files; the folder's name has no module source extension.
        const h = track(harness({ folders: [SIMPLE] }));
        h.runner.answers.push(notFound('Foo.A'));
        const [first] = await h.index.roots();
        assert.strictEqual(first.model.status, 'error');
        const before = h.changes();
        h.workspace.pathCreatedOrDeleted.fire(path.join(SIMPLE, 'src', 'Foo')); // a directory now
        await waitUntil(() => h.changes() > before, 'the change after the pause');
        const second = asRoot(await h.index.classify(b));
        assert.strictEqual(second.model.status, 'ok');
        assert.strictEqual(h.index.pathToModule(second, b), 'Foo.B');
      });

      test('a folder deleted, reported alone, drops the models that found a module source in it, and only those', async () => {
        const h = track(harness({ folders: [SIMPLE, path.join(IPKG_FIXTURES, 'versions')] }));
        const [versions, simple] = await h.index.roots(); // by path: ipkg/versions before workspaces/
        assert.strictEqual(simple.dir, SIMPLE);
        assert.strictEqual(h.runner.requests.length, 2);
        const before = h.changes();
        // The test does not delete anything: the index decides from the paths.
        h.workspace.pathCreatedOrDeleted.fire(path.join(SIMPLE, 'src', 'Foo', 'Gone'));
        h.workspace.pathCreatedOrDeleted.fire(path.join(SIMPLE, 'src', 'Foo', 'A.idr'));
        await waitUntil(() => h.changes() > before, 'the change after the pause');
        assert.strictEqual(h.changes(), before + 1, 'a burst is one change');
        assert.notStrictEqual(asRoot(await h.index.classify(b)), simple, 'simple.ipkg was read again');
        assert.strictEqual(asRoot(await h.index.classify(path.join(versions.dir, 'X.idr'))), versions, 'versions.ipkg was not');
        assert.strictEqual(h.runner.requests.length, 3);

        // The folder above every module, or the source directory itself.
        for (const gone of [path.join(SIMPLE, 'src', 'Foo'), path.join(SIMPLE, 'src')]) {
          const count = h.changes();
          h.workspace.pathCreatedOrDeleted.fire(gone);
          await waitUntil(() => h.changes() > count, `the change after ${gone}`);
          await h.index.classify(b);
        }
        assert.strictEqual(h.runner.requests.length, 5);
      });

      test('files that hold no module source change nothing: build output, created module files beside good models, other packages', async () => {
        const untrusted = track(harness({ folders: [SIMPLE], trusted: false }));
        const trusted = track(harness({ folders: [SIMPLE] }));
        assert.strictEqual((await untrusted.index.roots())[0].model.source, 'fallback');
        assert.strictEqual((await trusted.index.roots())[0].model.source, 'dump-json');
        const scans = trusted.workspace.findCalls;
        const before = [untrusted.changes(), trusted.changes()];
        untrusted.workspace.pathCreatedOrDeleted.fire(newModule);
        untrusted.workspace.pathCreatedOrDeleted.fire(path.join(SIMPLE, 'src', 'Foo', 'A.idr'));
        for (const file of [
          newModule, // adding a file cannot break a model the compiler read without error
          path.join(SIMPLE, 'docs', 'Notes.md'),
          path.join(SIMPLE, 'build', 'ttc', '2025081600', 'Foo', 'A.ttc'),
          path.join(SIMPLE, 'src', 'Foo', 'A.ttm'),
          path.join(SIMPLE, 'src', 'Bar'), // a folder no listed module lies in
        ]) {
          trusted.workspace.pathCreatedOrDeleted.fire(file);
        }
        await new Promise((resolve) => setTimeout(resolve, PAST_THE_PAUSE_MS));
        assert.deepStrictEqual([untrusted.changes(), trusted.changes()], before);
        assert.strictEqual(trusted.runner.requests.length, 1);
        assert.strictEqual(trusted.workspace.findCalls, scans, 'no folder appeared: the workspace was not scanned again');
      });

      test('main is a module source too: a deleted Main.idr drops the model', async () => {
        const h = track(harness({ folders: [SIMPLE] }));
        h.runner.answers.push({
          exitCode: 0,
          signal: null,
          stdout: '{"name": "simple","depends": [],"modules": ["Foo.A"],"main": "Main","sourcedir": "src"}',
          stderr: '',
          timedOut: false,
          durationMs: 1,
        });
        const [root] = await h.index.roots();
        assert.ok(root.model.status === 'ok' && root.model.model.main === 'Main', JSON.stringify(root.model));
        const before = h.changes();
        h.workspace.pathCreatedOrDeleted.fire(path.join(SIMPLE, 'src', 'Main.lidr'));
        await waitUntil(() => h.changes() > before, 'the change after the pause');
        await h.index.classify(b);
        assert.strictEqual(h.runner.requests.length, 2);
      });

      test('a package folder renamed: the listing, the walks and the roots follow', async () => {
        const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-index-')));
        try {
          fs.mkdirSync(path.join(top, 'lib', 'src'), { recursive: true });
          fs.writeFileSync(path.join(top, 'lib', 'lib.ipkg'), 'package lib\nsourcedir = "src"\n');
          fs.writeFileSync(path.join(top, 'lib', 'src', 'X.idr'), 'module X\n');
          const h = track(harness({ folders: [top] }));
          assert.deepStrictEqual((await h.index.roots()).map((r) => r.ipkgPath), [path.join(top, 'lib', 'lib.ipkg')]);
          const before = asRoot(await h.index.classify(path.join(top, 'lib', 'src', 'X.idr')));
          assert.strictEqual(before.dir, path.join(top, 'lib'));

          // `mv lib lib2`: a deletion of lib and a creation of lib2, nothing for the files inside.
          fs.renameSync(path.join(top, 'lib'), path.join(top, 'lib2'));
          const count = h.changes();
          h.workspace.pathCreatedOrDeleted.fire(path.join(top, 'lib'));
          h.workspace.pathCreatedOrDeleted.fire(path.join(top, 'lib2'));
          await waitUntil(() => h.changes() > count, 'the change after the pause');
          assert.deepStrictEqual((await h.index.roots()).map((r) => r.ipkgPath), [path.join(top, 'lib2', 'lib.ipkg')]);
          assert.strictEqual(asRoot(await h.index.classify(path.join(top, 'lib2', 'src', 'X.idr'))).dir, path.join(top, 'lib2'));
          // The old path: no package any more (the walk from it was dropped, not reused).
          assert.deepStrictEqual(await h.index.classify(path.join(top, 'lib', 'src', 'X.idr')), {
            kind: 'loose',
            dir: path.join(top, 'lib', 'src'),
          });
        } finally {
          fs.rmSync(top, { recursive: true, force: true });
        }
      });
    });

    test('Windows: one root for two spellings of a directory that differ in case', async function () {
      if (process.platform !== 'win32') {
        this.skip();
      }
      const h = track(harness());
      const first = await h.index.classify(b);
      const second = await h.index.classify(path.join(SIMPLE.toUpperCase(), 'SRC', 'FOO', 'B.idr'));
      assert.strictEqual(second, first);
      assert.strictEqual(h.runner.requests.length, 1);
    });
  });

  suite('roots(): the packages inside the workspace folders', () => {
    test('one root per directory, sorted by path, with the other package files named; read when asked for', async () => {
      const h = track(harness({ folders: [IPKG_FIXTURES] }));
      await waitUntil(() => h.workspace.findCalls > 0, 'the scan of the workspace');
      assert.strictEqual(h.runner.requests.length, 0, 'scanning the workspace reads no model');
      const roots = await h.index.roots();
      assert.deepStrictEqual(
        roots.map((r) => path.relative(IPKG_FIXTURES, r.dir)),
        ['bad-property', 'comments', 'escapes', 'literate', 'trailing-comma', 'two-ipkgs', 'versions'],
      );
      assert.deepStrictEqual(roots.map((r) => r.ipkgPath), [...roots.map((r) => r.ipkgPath)].sort());
      assert.strictEqual(roots.find((r) => r.dir.endsWith('two-ipkgs'))?.otherIpkgs.length, 1);
      assert.ok(roots.every((r) => r.insideWorkspace));
      assert.strictEqual(h.runner.requests.length, 7, 'each root is read once');
      await h.index.roots();
      assert.strictEqual(h.runner.requests.length, 7, 'and then cached');
    });

    test('a new toolchain snapshot neither scans the workspace nor reads a model until one is asked for', async () => {
      const h = track(harness({ folders: [IPKG_FIXTURES] }));
      assert.strictEqual((await h.index.roots()).length, 7);
      const scans = h.workspace.findCalls;
      h.toolchain.publish();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(h.workspace.findCalls, scans);
      assert.strictEqual(h.runner.requests.length, 7);
      await h.index.roots();
      assert.strictEqual(h.runner.requests.length, 14);
    });

    test('follows a change of the workspace folders and fires onDidChange', async () => {
      const h = track(harness({ folders: [path.join(SIMPLE, 'src')] }));
      assert.deepStrictEqual(await h.index.roots(), []);
      const before = h.changes();
      h.workspace.folderList = [SIMPLE];
      h.workspace.foldersChanged.fire();
      const roots = await h.index.roots();
      assert.deepStrictEqual(roots.map((r) => r.ipkgPath), [path.join(SIMPLE, 'simple.ipkg')]);
      assert.ok(h.changes() > before);
    });

    test('a root that classify already read is listed as the same object', async () => {
      const h = track(harness({ folders: [SIMPLE] }));
      const root = await h.index.classify(path.join(SIMPLE, 'src', 'Foo', 'B.idr'));
      assert.deepStrictEqual(await h.index.roots(), [root]);
      assert.strictEqual(h.runner.requests.length, 1);
    });
  });

  suite('module ↔ path (mbPathToNS, nsToSource)', () => {
    const lit = path.join(IPKG_FIXTURES, 'literate');
    const src = path.join(lit, 'src', 'Lit');

    test('literate modules: every extension of the file name is dropped', async () => {
      const h = track(harness());
      const root = asRoot(await h.index.classify(path.join(src, 'Bird.lidr')));
      assert.strictEqual(root.ipkgPath, path.join(lit, 'lit.ipkg'));
      const cases: [string, string | undefined][] = [
        [path.join(src, 'Bird.lidr'), 'Lit.Bird'],
        [path.join(src, 'Mark.idr.md'), 'Lit.Mark'],
        [path.join(src, 'Twice.md'), 'Lit.Twice'],
        [path.join(src, 'Twice.idr'), 'Lit.Twice'],
        [path.join(lit, 'src', 'Top.idr'), 'Top'],
        [path.join(src, 'Notes.txt'), undefined],
        [path.join(lit, 'lit.ipkg'), undefined],
        [path.join(lit, 'Outside.idr'), undefined],
        [path.join(lit, 'src2', 'Near.idr'), undefined],
      ];
      for (const [file, expected] of cases) {
        assert.strictEqual(h.index.pathToModule(root, file), expected, file);
      }
    });

    test('a module\'s candidate paths come in the compiler\'s order: Twice.md before Twice.idr [live]', async () => {
      const h = track(harness());
      const root = asRoot(await h.index.classify(path.join(src, 'Bird.lidr')));
      const firstExisting = (module: string): string | undefined => h.index.moduleToPaths(root, module).find((p) => fs.existsSync(p));
      assert.deepStrictEqual(h.index.moduleToPaths(root, 'Lit.Twice'), MODULE_SOURCE_EXTENSIONS.map((ext) => path.join(src, 'Twice') + ext));
      // idris2 0.8.0 `--typecheck lit.ipkg` printed `Building Lit.Twice (src/Lit/Twice.md)`.
      assert.strictEqual(firstExisting('Lit.Twice'), path.join(src, 'Twice.md'));
      assert.strictEqual(firstExisting('Lit.Mark'), path.join(src, 'Mark.idr.md'));
      assert.strictEqual(firstExisting('Lit.Bird'), path.join(src, 'Bird.lidr'));
      assert.deepStrictEqual(h.index.moduleToPaths(root, 'Lit..Twice'), []);
      assert.deepStrictEqual(h.index.moduleToPaths(root, ''), []);
    });

    test('sourcedir "src\\\\main" is src/main, as the compiler resolves it', async () => {
      const esc = path.join(IPKG_FIXTURES, 'escapes');
      const m = path.join(esc, 'src', 'main', 'Esc', 'M.idr');
      const h = track(harness());
      const root = asRoot(await h.index.classify(m));
      assert.strictEqual(h.index.pathToModule(root, m), 'Esc.M');
      const candidates = h.index.moduleToPaths(root, 'Esc.M');
      assert.strictEqual(candidates[candidates.length - 1], m);
    });
  });
});
