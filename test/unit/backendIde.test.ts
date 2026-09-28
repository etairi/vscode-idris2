// backend/ide/backend.ts against a fake session pool and a fake of the vscode constructors: the
// path sent in :load-file, the conversion of the recorded replies to vscode diagnostics, the
// per-root state the status item shows, the crash notices, and the commands' control surface.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { IdeMode, IDE_MODE_CAPABILITIES, type DiagnosticsApi, type IdeModeDeps } from '../../src/backend/ide/backend';
import type {
  IdeCommand,
  IdeSession,
  Reply,
  RequestOptions,
  SessionPool,
  SessionPoolChange,
  SessionState,
  SessionStateChange,
} from '../../src/backend/ide/types';
import type { IdeModeSettings } from '../../src/core/config';
import { IdrisException } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { GateVerdict } from '../../src/core/trust';
import type { Classification } from '../../src/project/types';
import { recordedExchanges } from './support/loadReplies';
import { LOOSE, projectRoot } from './support/toolchainFixtures';

class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}
class Location {
  constructor(
    readonly uri: vscode.Uri,
    readonly range: Range,
  ) {}
}
class DiagnosticRelatedInformation {
  constructor(
    readonly location: Location,
    readonly message: string,
  ) {}
}
class Diagnostic {
  source?: string;
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: number,
  ) {}
}
const api = {
  Position,
  Range,
  Location,
  DiagnosticRelatedInformation,
  Diagnostic,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` }) },
} as unknown as DiagnosticsApi;

/** A session whose replies the test scripts, recording every request. */
class FakeSession implements IdeSession {
  readonly role = 'check' as const;
  state: SessionState = 'stopped';
  launch: IdeSession['launch'] = undefined;
  readonly protocolVersion = undefined;
  readonly loadedFile = undefined;
  readonly changed = new Emitter<SessionStateChange>();
  readonly onDidChangeState = this.changed.event;
  /** The requests sent (their `beforeSend` passed), with the options but that hook. */
  readonly requests: { command: IdeCommand; options: RequestOptions }[] = [];
  next: () => Promise<Reply> = () => Promise.reject(new Error('no reply scripted'));
  /** Stands for what a request waits for before it is sent: the toolchain scan, the consent question, the start. */
  waitBeforeSend: Promise<void> = Promise.resolve();
  constructor(
    readonly root: Classification,
    readonly cwd: string,
  ) {}
  /** How often `request` was called (a first request starts a process, after the consent question). */
  asked = 0;
  async request(command: IdeCommand, options: RequestOptions): Promise<Reply> {
    this.asked++;
    const { beforeSend, ...sent } = options;
    await this.waitBeforeSend;
    await beforeSend?.();
    this.requests.push({ command, options: sent });
    return this.next();
  }
}

class FakePool implements SessionPool {
  readonly list: FakeSession[] = [];
  readonly calls: string[] = [];
  readonly changed = new Emitter<SessionPoolChange>();
  readonly onDidChange = this.changed.event;
  sessionFor(root: Classification): FakeSession {
    let session = this.list.find((s) => JSON.stringify(s.root) === JSON.stringify(root));
    if (session === undefined) {
      session = new FakeSession(root, root.dir);
      this.list.push(session);
    }
    return session;
  }
  sessions(): readonly IdeSession[] {
    return this.list;
  }
  effectiveCheckBuildDir(root: Classification): string {
    return `${root.dir}/build/.vscode-idris2`;
  }
  stop(root?: Classification): void {
    this.calls.push(`stop ${root?.dir ?? 'all'}`);
  }
  release(root: Classification): void {
    this.calls.push(`release ${root.dir}`);
  }
  packageChanged(root: Classification, detail: string): void {
    this.calls.push(`packageChanged ${root.dir}: ${detail}`);
  }
  restart(root: Classification): void {
    this.calls.push(`restart ${root.dir}`);
  }
  restartAll(): void {
    this.calls.push('restartAll');
  }
  setActiveRoot(root: Classification | 'pending' | undefined): void {
    this.calls.push(`setActiveRoot ${root === 'pending' ? root : (root?.dir ?? 'none')}`);
  }
  /** What `startProblem` reports (the pool's checks before the consent question). */
  problem: IdrisException | undefined = undefined;
  startProblem(): Promise<IdrisException | undefined> {
    this.calls.push('startProblem');
    return Promise.resolve(this.problem);
  }
  /** Moves `session` to `state` and tells the listeners, as the real pool does. */
  move(session: FakeSession, state: SessionState, cause: SessionStateChange['cause'], detail?: string): void {
    const previous = session.state;
    session.state = state;
    this.changed.fire({ session, change: { previous, state, cause, ...(detail === undefined ? {} : { detail }) } });
  }
  dispose(): void {}
}

interface Doc {
  uri: { scheme: string; fsPath: string; toString(): string };
  fileName: string;
  isUntitled: boolean;
  isDirty: boolean;
  version: number;
  languageId: string;
}

function doc(fileName: string, overrides: Partial<Doc> = {}): vscode.TextDocument {
  return {
    uri: { scheme: 'file', fsPath: fileName, toString: () => `file://${fileName}` },
    fileName,
    isUntitled: false,
    isDirty: false,
    version: 7,
    languageId: 'idris2',
    ...overrides,
  } as unknown as vscode.TextDocument;
}

/** Timers the test fires by hand (`fire`), for the time limit of the walk made when a load is queued. */
class ManualClock {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  private next = 0;
  setTimeout(callback: () => void, ms: number): unknown {
    this.pending.set(++this.next, { callback, ms });
    return this.next;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Runs every pending timer. */
  fire(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    all.forEach((t) => t.callback());
  }
}

/** The real path of a directory in these tests: `/w/broken` is reached through a link. */
const realpathOf = (p: string): string => (p === '/w/broken' ? '/private/w/broken' : p);

function setup(overrides: Partial<IdeModeDeps> & { roots?: Record<string, Classification>; verdicts?: Record<string, GateVerdict> } = {}) {
  const pool = new FakePool();
  const gateChanged = new Emitter<void>();
  const verdicts = overrides.verdicts ?? {};
  const read: string[] = [];
  const searched: string[] = [];
  const clock = new ManualClock();
  const deps: IdeModeDeps = {
    pool,
    projects: {
      classify: (file: string) => Promise.resolve(overrides.roots?.[file] ?? { kind: 'loose', dir: file.slice(0, file.lastIndexOf('/')) }),
      sessionCwd: (root: Classification) => root.dir,
    },
    config: {
      diagnostics: () => ({ includeSourceExcerpt: false }),
      ideMode: () => ({ longActionTimeoutMs: 60_000 }) as IdeModeSettings,
    },
    clock,
    gate: { current: (dir: string) => verdicts[dir], onDidChange: gateChanged.event },
    api,
    readFile: (p: string) => {
      read.push(p);
      return Promise.resolve('> module Err\n\n> h : Nat -> Nat\n> h n = n\n\nProse between the code lines.\n\n> g : Nat\n> g = "x"\n');
    },
    realpath: (p: string) => Promise.resolve(realpathOf(p)),
    // The compiler's walk finds a project root's own .ipkg in its real directory, else nothing.
    findPackage: (dir: string) => {
      searched.push(dir);
      const project = Object.values(overrides.roots ?? {}).find((r) => r.kind === 'project' && realpathOf(r.dir) === dir);
      return Promise.resolve(project?.kind === 'project' ? `${dir}/${project.ipkgPath.slice(project.ipkgPath.lastIndexOf('/') + 1)}` : undefined);
    },
    directoryId: (p: string) => Promise.resolve(`id ${realpathOf(p)}`),
    platform: 'darwin',
    ...overrides,
  };
  const ide = new IdeMode(deps);
  return { ide, pool, gateChanged, verdicts, read, searched, clock, backend: ide.backendFor() };
}

const plainRange = (r: Range) => [r.start.line, r.start.character, r.end.line, r.end.character];

/** Lets pending promise callbacks and immediates run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

suite('backend/ide/backend (IdeMode, IdeBackend)', () => {
  test('capabilities: diagnostics only in M2; the other methods say they are not available yet', async () => {
    const { backend } = setup();
    assert.strictEqual(backend.kind, 'ideMode');
    assert.deepStrictEqual(
      Object.entries(backend.caps).filter(([, on]) => on).map(([cap]) => cap),
      ['diagnostics'],
    );
    assert.strictEqual(backend.caps, IDE_MODE_CAPABILITIES);
    for (const call of [
      () => backend.typeAt(doc('/w/A.idr'), new Position(0, 0) as vscode.Position, 'x'),
      () => backend.docsFor('id', 'full'),
      () => backend.holes(doc('/w/A.idr')),
      () => backend.evaluate('1'),
    ]) {
      await assert.rejects(call(), (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported');
    }
  });

  test('load sends the real path of the session directory joined with the file\'s relative path, as a load of that path and version', async () => {
    const { backend, pool } = setup();
    const session = pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    session.next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
    await backend.load(doc('/w/broken/Bad.idr'));
    assert.strictEqual(session.requests.length, 1);
    assert.deepStrictEqual(session.requests[0].command, {
      kind: 'list',
      items: [
        { kind: 'symbol', name: 'load-file' },
        { kind: 'string', value: '/private/w/broken/Bad.idr' },
      ],
    });
    assert.deepStrictEqual(session.requests[0].options, { kind: 'load', file: { path: '/private/w/broken/Bad.idr', version: 7 } });
  });

  test('a document with unsaved changes is loaded without a version (the disk has another one); on Windows the path is sent as it is', async () => {
    const { backend, pool } = setup({ platform: 'win32' });
    const session = pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    session.next = () => Promise.resolve(recordedExchanges('load-warn', '/w/broken')[0].reply);
    await backend.load(doc('/w/broken/Warn.idr', { isDirty: true }));
    assert.deepStrictEqual(session.requests[0].options, { kind: 'load', file: { path: '/w/broken/Warn.idr' } });
  });

  test('the recorded Bad.idr reply becomes one vscode Error at (3,6)–(3,11) with source idris2, on the document\'s own path', async () => {
    const { backend, pool } = setup();
    pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
    const result = await backend.load(doc('/w/broken/Bad.idr'));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.packageError, undefined);
    assert.strictEqual(result.diagnostics.length, 1);
    const [uri, diagnostics] = result.diagnostics[0];
    assert.strictEqual(uri.fsPath, '/w/broken/Bad.idr');
    assert.strictEqual(diagnostics.length, 1);
    const d = diagnostics[0] as unknown as Diagnostic;
    assert.deepStrictEqual(plainRange(d.range), [3, 6, 3, 11]);
    assert.strictEqual(d.severity, 0);
    assert.strictEqual(d.source, 'idris2');
    assert.match(d.message, /^While processing right hand side of f\./);
    assert.strictEqual(d.relatedInformation, undefined);
  });

  test('the .ipkg error (F10) is reported as the package error, and the not-checked error points at it', async () => {
    const root = projectRoot({ dir: '/w/broken/bad-ipkg', ipkgPath: '/w/broken/bad-ipkg/bad.ipkg' });
    const { backend, pool } = setup({ roots: { '/w/broken/bad-ipkg/Main.idr': root } });
    pool.sessionFor(root).next = () => Promise.resolve(recordedExchanges('load-bad-ipkg', '/w/broken/bad-ipkg')[0].reply);
    const result = await backend.load(doc('/w/broken/bad-ipkg/Main.idr'));
    assert.strictEqual(result.packageError?.uri.fsPath, '/w/broken/bad-ipkg/bad.ipkg');
    assert.strictEqual(result.packageError.message, 'Unrecognised property "pkgs".');
    const byFile = new Map(result.diagnostics.map(([uri, list]) => [uri.fsPath, list as unknown as Diagnostic[]]));
    assert.deepStrictEqual(plainRange(byFile.get('/w/broken/bad-ipkg/bad.ipkg')?.[0].range ?? assert.fail()), [2, 0, 2, 4]);
    const [notChecked] = byFile.get('/w/broken/bad-ipkg/Main.idr') ?? [];
    assert.strictEqual(notChecked.message, 'Not checked: the package file bad.ipkg could not be read.');
    assert.strictEqual(notChecked.relatedInformation?.[0].location.uri.fsPath, '/w/broken/bad-ipkg/bad.ipkg');
    assert.deepStrictEqual(plainRange(notChecked.relatedInformation[0].location.range), [2, 0, 2, 4]);
    assert.strictEqual(result.blockedBy, undefined);
  });

  test('a document stopped by errors in the files it imports: blockedBy names them (UsesBad → Bad)', async () => {
    const { backend, pool } = setup();
    pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).next = () => Promise.resolve(recordedExchanges('load-uses-bad', '/private/w/broken')[0].reply);
    const result = await backend.load(doc('/w/broken/UsesBad.idr'));
    assert.deepStrictEqual(result.blockedBy?.map((u) => u.fsPath), ['/w/broken/Bad.idr']);
  });

  test('a bird-track file named in the frames is read from disk for the unlit offset (F11)', async () => {
    const { backend, pool, read } = setup();
    pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).next = () => Promise.resolve(recordedExchanges('load-lidr', '/private/w/broken')[0].reply);
    const result = await backend.load(doc('/w/broken/Err.lidr', { languageId: 'lidr' }));
    assert.deepStrictEqual(read, ['/w/broken/Err.lidr']);
    assert.deepStrictEqual(plainRange((result.diagnostics[0][1][0] as unknown as Diagnostic).range), [8, 6, 8, 9]);
  });

  test('-Werror on the session\'s command line makes every frame of a failed load an error', async () => {
    const { backend, pool } = setup();
    const session = pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    session.launch = { executable: '/x/idris2', args: ['--ide-mode', '--no-color', '-Werror'], cwd: '/w/broken', env: {}, transport: 'stdio' };
    session.next = () => Promise.resolve(recordedExchanges('load-mixed', '/private/w/broken')[0].reply);
    const result = await backend.load(doc('/w/broken/Mixed.idr'));
    assert.deepStrictEqual(result.diagnostics[0][1].map((d) => d.severity), [0, 0]);
  });

  test('-Werror in the .ipkg\'s opts, which the compiler applies at every load, does the same', async () => {
    const root = projectRoot({ dir: '/w/broken', ipkgPath: '/w/broken/p.ipkg' });
    assert.ok(root.model.status === 'ok');
    const withWerror: Classification = { ...root, model: { ...root.model, model: { ...root.model.model, opts: '--total  -Werror' } } };
    const { backend, pool } = setup({ roots: { '/w/broken/Mixed.idr': withWerror } });
    pool.sessionFor(withWerror).next = () => Promise.resolve(recordedExchanges('load-mixed', '/private/w/broken')[0].reply);
    const result = await backend.load(doc('/w/broken/Mixed.idr'));
    const mixed = result.diagnostics.find(([uri]) => uri.fsPath === '/w/broken/Mixed.idr');
    assert.deepStrictEqual(mixed?.[1].map((d) => d.severity), [0, 0]);
  });

  test('a loose file: the walk is done again from the real path, and a package file found there stops the load (F13)', async () => {
    // None found: the load is sent; the walk started at the session directory's real path.
    const clean = setup();
    const session = clean.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    session.next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
    await clean.backend.load(doc('/w/broken/Bad.idr'));
    assert.deepStrictEqual(clean.searched, ['/private/w/broken', '/private/w/broken'], 'before the load is queued, and before it is sent');
    assert.strictEqual(session.requests.length, 1);

    // One found (new, or above the physical folder of a symbolic link): the compiler would change
    // into that package's folder, which was never put to the gate, so nothing is sent.
    const found = setup({ findPackage: () => Promise.resolve('/private/w/evil.ipkg') });
    await assert.rejects(found.backend.load(doc('/w/broken/Bad.idr')), (e: unknown) => {
      assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
      assert.match(e.message, /searching from \/private\/w\/broken, the real path of its folder, the compiler would find the package file \/private\/w\/evil\.ipkg/);
      assert.match(e.message, /open the file through its real path, \/private\/w\/broken\/Bad\.idr\.$/);
      return true;
    });
    assert.strictEqual(found.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).requests.length, 0, 'nothing was sent');
    // Its sessions are stopped too: a compiler that has moved already (a load that raced with the
    // package file) would keep working there (M2 verification of the third review).
    assert.deepStrictEqual(found.pool.calls, [
      'packageChanged /w/broken: searching from /private/w/broken, the real path of its folder, the compiler would find the package file /private/w/evil.ipkg',
    ]);
  });

  test('a session directory that cannot be resolved, or is not the one its compiler was started in, fails the load and stops the root, loose or not', async () => {
    // Unresolvable (moved away, deleted): before, a loose file's load was sent (the walk from the
    // spelled path listed nothing, so it found no package), and the compiler searched from wherever it was.
    const project = projectRoot({ dir: '/w/broken', ipkgPath: '/w/broken/p.ipkg' });
    for (const root of [{ kind: 'loose', dir: '/w/broken' } as const, project]) {
      const gone = setup({ roots: { '/w/broken/Bad.idr': root }, realpath: (p) => Promise.reject(new Error(`ENOENT: no such file or directory, realpath '${p}'`)) });
      await assert.rejects(gone.backend.load(doc('/w/broken/Bad.idr')), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
        assert.match(e.message, /^Not checked: the folder of its session, \/w\/broken, cannot be resolved \(ENOENT: .*\), so nothing was sent to the compiler/);
        return true;
      });
      assert.strictEqual(gone.pool.sessionFor(root).requests.length, 0, `${root.kind}: nothing was sent`);
      assert.strictEqual(gone.pool.calls.length, 1);
      assert.match(gone.pool.calls[0], /^packageChanged \/w\/broken: the folder of its session, \/w\/broken, cannot be resolved/);
    }

    // Replaced while its compiler runs: the compiler walks from the directory it was started in
    // (getcwd), the check from the path. The identity is noted when the process starts.
    let identity = 'dev 1 ino 10';
    const moved = setup({ directoryId: () => Promise.resolve(identity) });
    const session = moved.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    session.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', env: {}, transport: 'socket' };
    moved.pool.move(session, 'starting', 'start');
    session.next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
    await moved.backend.load(doc('/w/broken/Bad.idr'));
    assert.strictEqual(session.requests.length, 1, 'the same directory: sent');
    identity = 'dev 1 ino 11';
    await assert.rejects(moved.backend.load(doc('/w/broken/Bad.idr')), (e: unknown) => {
      assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
      assert.match(e.message, /^Not checked: the folder \/private\/w\/broken is not the one the compiler was started in/);
      return true;
    });
    assert.strictEqual(session.requests.length, 1, 'another directory: nothing sent');
    assert.match(moved.pool.calls.at(-1) ?? '', /^packageChanged \/w\/broken: the folder \/private\/w\/broken is not the one the compiler was started in/);
    // A new process there notes the new directory: its loads are sent again.
    session.launch = { ...session.launch };
    moved.pool.move(session, 'starting', 'start');
    await moved.backend.load(doc('/w/broken/Bad.idr'));
    assert.strictEqual(session.requests.length, 2);
    // The identity could not be read when the process started (the directory was already gone): refused.
    const unknown = setup({ directoryId: () => Promise.reject(new Error('ENOENT')) });
    const s2 = unknown.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    s2.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', env: {}, transport: 'socket' };
    unknown.pool.move(s2, 'starting', 'start');
    await assert.rejects(unknown.backend.load(doc('/w/broken/Bad.idr')), /is not the one the compiler was started in/);
  });

  test('a project: the walk from the real path must find the root\'s own .ipkg; else nothing is sent and its sessions stop', async () => {
    // Found in the session directory: the load is sent.
    const project = projectRoot({ dir: '/w/broken', ipkgPath: '/w/broken/p.ipkg' });
    const p = setup({ roots: { '/w/broken/Bad.idr': project } });
    p.pool.sessionFor(project).next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
    await p.backend.load(doc('/w/broken/Bad.idr'));
    assert.deepStrictEqual(p.searched, ['/private/w/broken', '/private/w/broken']);
    assert.strictEqual(p.pool.sessionFor(project).requests.length, 1);
    assert.deepStrictEqual(p.pool.calls, []);

    // Renamed away: the compiler would find the parent's evil.ipkg and move there for good (M2 third review [live]).
    for (const [walk, what] of [
      ['/private/w/evil.ipkg', /the compiler would find the package file \/private\/w\/evil\.ipkg, not \/w\/broken\/p\.ipkg/],
      [undefined, /the compiler finds no package file, not \/w\/broken\/p\.ipkg/],
      ['/private/w/broken/a.ipkg', /would find the package file \/private\/w\/broken\/a\.ipkg, not/],
    ] as const) {
      const moved = setup({ roots: { '/w/broken/Bad.idr': project }, findPackage: () => Promise.resolve(walk) });
      await assert.rejects(moved.backend.load(doc('/w/broken/Bad.idr')), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
        assert.match(e.message, what);
        assert.match(e.message, /^Not checked: searching from \/private\/w\/broken, the real path of its folder, .*so nothing was sent to the compiler/);
        return true;
      });
      assert.strictEqual(moved.pool.sessionFor(project).requests.length, 0, 'nothing was sent');
      assert.strictEqual(moved.pool.calls.length, 1);
      assert.match(moved.pool.calls[0], /^packageChanged \/w\/broken: searching from \/private\/w\/broken/, 'its sessions are stopped');
    }
  });

  // M2 second verification of the third review: the walk ran when the load was queued, and a first
  // load then waited for the toolchain scan, the consent question (open for as long as the user
  // leaves it) and the start, with no second walk and no directory check (no process yet).
  suite('the checks again when the load is the next to be sent', () => {
    const deferred = (): { promise: Promise<void>; resolve(): void } => {
      let resolve = (): void => undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    test('a package file created while a first load waited (the consent question, the start) stops it: nothing is sent', async () => {
      const walks: string[] = [];
      let planted: string | undefined;
      const t = setup({
        findPackage: (dir) => {
          walks.push(`${dir}: ${planted ?? 'none'}`);
          return Promise.resolve(planted);
        },
      });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const question = deferred();
      session.waitBeforeSend = question.promise;
      session.next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
      const load = t.backend.load(doc('/w/broken/Bad.idr'));
      await settle();
      assert.deepStrictEqual(walks, ['/private/w/broken: none']);
      planted = '/private/evil.ipkg'; // in a parent the attacker can write to (/tmp)
      question.resolve();
      await assert.rejects(load, (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
        assert.match(e.message, /the compiler would find the package file \/private\/evil\.ipkg/);
        return true;
      });
      assert.deepStrictEqual(walks, ['/private/w/broken: none', '/private/w/broken: /private/evil.ipkg']);
      assert.strictEqual(session.requests.length, 0, 'nothing was sent');
      assert.deepStrictEqual(t.pool.calls, [
        'packageChanged /w/broken: searching from /private/w/broken, the real path of its folder, the compiler would find the package file /private/evil.ipkg',
      ]);
    });

    test('a first load: its process\'s directory is checked too, once it has started (it had none when the load was queued)', async () => {
      let identity = 'dev 1 ino 10';
      const t = setup({ directoryId: () => Promise.resolve(identity) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const start = deferred();
      session.waitBeforeSend = start.promise;
      session.next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
      const load = t.backend.load(doc('/w/broken/Bad.idr'));
      await settle();
      session.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', env: {}, transport: 'socket' };
      t.pool.move(session, 'starting', 'start');
      await settle();
      identity = 'dev 1 ino 11'; // replaced after the start, before the load is sent
      start.resolve();
      await assert.rejects(load, /is not the one the compiler was started in/);
      assert.strictEqual(session.requests.length, 0);
      assert.match(t.pool.calls.at(-1) ?? '', /^packageChanged \/w\/broken: the folder \/private\/w\/broken is not the one/);
    });

    test('the directory a process was started in is noted at the real path it was started in (realCwd), not through the spelled path', async () => {
      const ids: Record<string, string> = { '/private/w/broken': 'dev 1 ino 10', '/w/broken': 'dev 1 ino 10' };
      const t = setup({ directoryId: (p) => Promise.resolve(ids[p] ?? 'none') });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      ids['/w/broken'] = 'dev 1 ino 11'; // the link on the spelled path re-pointed after the spawn
      session.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', realCwd: '/private/w/broken', env: {}, transport: 'socket' };
      t.pool.move(session, 'starting', 'start');
      await settle();
      await assert.rejects(t.backend.load(doc('/w/broken/Bad.idr')), /is not the one the compiler was started in/);
      assert.strictEqual(session.requests.length, 0);
    });

    test('POSIX: a folder or file whose real path the compiler reads otherwise (\\, :, ?) is not loaded, and nothing is started', async () => {
      // M2 second verification of the third review: the compiler takes `\` for a separator, so from
      // r/x\y its walk went up to r/x, where it adopted evil.ipkg, which findPackage never saw [live].
      for (const [real, reading] of [
        ['/private/r/x\\y', '/private/r/x/y'],
        ['/private/r/a:b', '/private/r/a'],
        ['/private/r/q?', '/private/r/q'],
      ]) {
        const t = setup({ realpath: (p) => Promise.resolve(p === '/w/broken' ? real : p), findPackage: () => Promise.resolve(undefined) });
        await assert.rejects(t.backend.load(doc('/w/broken/Bad.idr')), (e: unknown) => {
          assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
          assert.ok(e.message.startsWith(`Not checked: the compiler reads the path ${real} as ${reading} (`), e.message);
          return true;
        });
        assert.strictEqual(t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).asked, 0, `${real}: nothing started`);
      }
      // The file's own name too.
      const t = setup();
      await assert.rejects(t.backend.load(doc('/w/broken/B\\ad.idr')), /reads the path \/private\/w\/broken\/B\\ad\.idr as \/private\/w\/broken\/B\/ad\.idr/);
      // Windows: its separator; not refused here.
      const w = setup({ platform: 'win32' });
      w.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).next = () => Promise.resolve(recordedExchanges('load-bad', '/w/broken')[0].reply);
      await w.backend.load(doc('/w/broken/Bad.idr'));
    });

    test('a session directory whose real path changed while the load waited: nothing is sent (the path sent was built from the old one)', async () => {
      let real = '/private/w/broken';
      const t = setup({ realpath: (p) => Promise.resolve(p === '/w/broken' ? real : p) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const wait = deferred();
      session.waitBeforeSend = wait.promise;
      const load = t.backend.load(doc('/w/broken/Bad.idr'));
      await settle();
      real = '/private/elsewhere/broken';
      wait.resolve();
      await assert.rejects(load, /the real path of the folder of its session changed from \/private\/w\/broken to \/private\/elsewhere\/broken while the load waited/);
      assert.strictEqual(session.requests.length, 0);
      assert.strictEqual(t.pool.calls.length, 1);
    });
  });

  test('the walk made when a load is queued has the load\'s time limit: a hung one fails the load (LoadFailed), nothing sent, nothing stopped', async () => {
    // M2 verification of the Q20–Q22 fixes (the verifier's probe earlywalk): a realpath on a hung
    // network mount never settled, so the load never did, and Stop Backend could not end it.
    const t = setup({ realpath: () => new Promise<string>(() => undefined) });
    const load = t.backend.load(doc('/w/broken/Bad.idr'));
    let settled = false;
    load.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();
    assert.deepStrictEqual([...t.clock.pending.values()].map((timer) => timer.ms), [60_000], 'longActionTimeout');
    assert.strictEqual(settled, false);
    t.clock.fire();
    await assert.rejects(load, (e: unknown) => {
      assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
      assert.match(e.message, /^Not checked: the search for the file's package .* did not finish within 1 min, so nothing was sent to the compiler\.$/);
      return true;
    });
    assert.strictEqual(t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).asked, 0, 'no request');
    assert.deepStrictEqual(t.pool.calls, [], 'a slow file system is no package change: nothing is stopped');
    // A walk that settles in time leaves no timer.
    const quick = setup();
    quick.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
    await quick.backend.load(doc('/w/broken/Bad.idr'));
    assert.strictEqual(quick.clock.pending.size, 0);
  });

  test('load hands the urgent option to the session (the active document\'s load under maxBackgroundChecks)', async () => {
    const { backend, pool } = setup();
    const session = pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    session.next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
    const urgent = () => true;
    await backend.load(doc('/w/broken/Bad.idr'), { urgent });
    assert.strictEqual((session.requests[0].options as { urgent?: unknown }).urgent, urgent);
  });

  test('refusalBeforeQuestion: the walk\'s refusal, else the pool\'s start problem, else none; nothing is started, stopped or asked', async () => {
    // What the checks ask before they ask the consent question themselves (M2 verification of the
    // Q20–Q22 fixes, the verifier's probe L4).
    const root: Classification = { kind: 'loose', dir: '/w/broken' };
    const misread = setup({ realpath: (p) => Promise.resolve(p === '/w/broken' ? '/private/r/a:b' : p), findPackage: () => Promise.resolve(undefined) });
    assert.match((await misread.ide.refusalBeforeQuestion(doc('/w/broken/Bad.idr'), root)) ?? '', /^Not checked: the compiler reads the path \/private\/r\/a:b as \/private\/r\/a /);
    assert.deepStrictEqual(misread.pool.calls, [], 'the pool is not asked, and nothing stopped');
    const found = setup({ findPackage: () => Promise.resolve('/private/w/evil.ipkg') });
    assert.match((await found.ide.refusalBeforeQuestion(doc('/w/broken/Bad.idr'), root)) ?? '', /would find the package file \/private\/w\/evil\.ipkg/);
    const hung = setup({ realpath: () => new Promise<string>(() => undefined) });
    const pending = hung.ide.refusalBeforeQuestion(doc('/w/broken/Bad.idr'), root);
    await settle();
    hung.clock.fire();
    assert.match((await pending) ?? '', /did not finish within 1 min/);
    const missing = setup();
    missing.pool.problem = new IdrisException({ kind: 'ToolchainMissing', message: 'No Idris 2 compiler to start: not found' });
    assert.strictEqual(await missing.ide.refusalBeforeQuestion(doc('/w/broken/Bad.idr'), root), 'No Idris 2 compiler to start: not found');
    assert.deepStrictEqual(missing.pool.calls, ['startProblem']);
    const fine = setup();
    assert.strictEqual(await fine.ide.refusalBeforeQuestion(doc('/w/broken/Bad.idr'), root), undefined);
    assert.deepStrictEqual(fine.pool.calls, ['startProblem']);
    assert.strictEqual(fine.pool.sessionFor(root).asked, 0, 'no request, so no start and no question');
  });

  test('a rejected request is passed on (the checks feature turns it into the document\'s state)', async () => {
    const { backend, pool } = setup();
    pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).next = () =>
      Promise.reject(new IdrisException({ kind: 'RequestTimeout', message: 'no reply within 60 s' }));
    await assert.rejects(backend.load(doc('/w/broken/Bad.idr')), /no reply within 60 s/);
  });

  test('an untitled or non-file document is not loaded: the compiler reads files', async () => {
    const { backend, pool } = setup();
    await assert.rejects(
      backend.load(doc('Untitled-1', { isUntitled: true, uri: { scheme: 'untitled', fsPath: 'Untitled-1', toString: () => 'untitled:Untitled-1' } })),
      (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported',
    );
    assert.strictEqual(pool.list.length, 0);
  });

  suite('stateFor (the status item)', () => {
    test('no session: none; starting, ready, busy, restarting: active; failed: the detail', () => {
      const { ide, pool } = setup();
      assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'none' });
      const session = pool.sessionFor(LOOSE);
      for (const state of ['starting', 'ready', 'busy', 'restarting'] as const) {
        pool.move(session, state, 'start');
        assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'active' });
      }
      pool.move(session, 'failed', 'gaveUp', 'three crashes within five minutes');
      assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'failed', reason: 'three crashes within five minutes' });
    });

    test('stopped: "stopped" after Stop Backend or a revoked permission (with its directory), "none" after the idle timeout, the last document closed, an eviction (maxSessions) or a changed package file (the results still hold)', () => {
      const { ide, pool } = setup();
      const session = pool.sessionFor(LOOSE);
      pool.move(session, 'ready', 'handshake');
      pool.move(session, 'stopped', 'stop');
      assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'stopped' });
      pool.move(session, 'ready', 'handshake');
      pool.move(session, 'stopped', 'consentRevoked');
      assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'stopped', revokedDir: LOOSE.dir });
      // Allowed again without a question (its folder added to the workspace): no revocation to name.
      const allowed = setup({ verdicts: { [LOOSE.dir]: { allowed: true, basis: 'workspaceFolder' } } });
      const again = allowed.pool.sessionFor(LOOSE);
      allowed.pool.move(again, 'ready', 'handshake');
      allowed.pool.move(again, 'stopped', 'consentRevoked');
      assert.deepStrictEqual(allowed.ide.stateFor(LOOSE), { kind: 'stopped' });
      // A restart refused because the directory is gone (spawnError, session.ts) is no revocation either.
      pool.move(session, 'restarting', 'exit');
      pool.move(session, 'stopped', 'spawnError');
      assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'none' });
      for (const cause of ['idle', 'closed', 'evicted', 'packageChanged'] as const) {
        pool.move(session, 'ready', 'handshake');
        pool.move(session, 'stopped', cause);
        assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'none' }, cause);
      }
    });

    test('the gate\'s refusal wins (not allowed here), except in Restricted Mode, which the status says otherwise', () => {
      const { ide, pool, verdicts, gateChanged } = setup();
      let changes = 0;
      ide.onDidChangeState(() => changes++);
      pool.move(pool.sessionFor(LOOSE), 'ready', 'handshake');
      verdicts[LOOSE.dir] = { allowed: false, reason: 'denied' };
      gateChanged.fire();
      assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'notAllowed', dir: LOOSE.dir, reason: 'denied' });
      verdicts[LOOSE.dir] = { allowed: false, reason: 'restrictedMode' };
      assert.deepStrictEqual(ide.stateFor(LOOSE), { kind: 'active' });
      assert.strictEqual(changes, 2);
    });
  });

  test('onDidFail: a crash (exit, timeout, protocol error) that restarts, and a give-up', () => {
    const { ide, pool } = setup();
    const failures: [boolean, string, boolean][] = [];
    ide.onDidFail((f) => failures.push([f.gaveUp, f.detail, f.repeated]));
    const session = pool.sessionFor(LOOSE);
    pool.move(session, 'ready', 'handshake');
    pool.move(session, 'restarting', 'exit', 'exit code 3; last stderr line: boom');
    pool.move(session, 'starting', 'backoff');
    pool.move(session, 'restarting', 'timeout', 'no reply within 60 s');
    pool.move(session, 'restarting', 'protocolError', 'unframed bytes');
    pool.move(session, 'restarting', 'restart'); // a requested restart is no crash
    pool.move(session, 'failed', 'gaveUp', 'three crashes within five minutes');
    // After a give-up (and after an answered request, or a stop) the next crash is noticed again.
    pool.move(session, 'starting', 'restart');
    pool.move(session, 'restarting', 'exit', 'exit code 4');
    pool.move(session, 'starting', 'backoff');
    pool.move(session, 'ready', 'handshake');
    pool.move(session, 'busy', 'dispatch');
    pool.move(session, 'ready', 'reply');
    pool.move(session, 'restarting', 'exit', 'exit code 5');
    pool.move(session, 'stopped', 'stop');
    pool.move(session, 'restarting', 'exit', 'exit code 6');
    assert.deepStrictEqual(failures, [
      [false, 'exit code 3; last stderr line: boom', false],
      [false, 'no reply within 60 s', true],
      [false, 'unframed bytes', true],
      [true, 'three crashes within five minutes', false],
      [false, 'exit code 4', false],
      [false, 'exit code 5', false],
      [false, 'exit code 6', false],
    ]);
  });

  test('onDidRestart: after a reconfigure or a crash (exit, protocol error), at the next handshake; not after Restart Backend or a time-out', () => {
    const { ide, pool } = setup();
    const events: string[] = [];
    ide.onDidRestart((e) => events.push(`${e.root.dir} ${e.cause}`));
    const session = pool.sessionFor(LOOSE);
    pool.move(session, 'ready', 'handshake');
    assert.deepStrictEqual(events, [], 'a first start is not a restart');
    pool.move(session, 'restarting', 'reconfigure', 'the idris2.ideMode settings changed: arguments');
    pool.move(session, 'starting', 'backoff');
    assert.deepStrictEqual(events, [], 'not before the new process answered');
    pool.move(session, 'ready', 'handshake');
    assert.deepStrictEqual(events, [`${LOOSE.dir} reconfigure`]);
    pool.move(session, 'restarting', 'exit', 'exit code 3');
    pool.move(session, 'starting', 'backoff');
    pool.move(session, 'ready', 'handshake');
    pool.move(session, 'restarting', 'protocolError', 'noise');
    pool.move(session, 'starting', 'backoff');
    pool.move(session, 'ready', 'handshake');
    assert.deepStrictEqual(events.slice(1), [`${LOOSE.dir} crash`, `${LOOSE.dir} crash`]);
    // A crash, then a reconfigure before the new process answered: reconfigure (it rechecks more).
    pool.move(session, 'restarting', 'exit', 'exit code 3');
    pool.move(session, 'restarting', 'reconfigure', 'a new toolchain scan');
    pool.move(session, 'ready', 'handshake');
    assert.deepStrictEqual(events.slice(3), [`${LOOSE.dir} reconfigure`]);
    // A time-out (its request would time out again), Restart Backend (the command rechecks itself),
    // or a stop before the handshake: nothing.
    pool.move(session, 'restarting', 'timeout', 'no reply within 60 s');
    pool.move(session, 'ready', 'handshake');
    pool.move(session, 'restarting', 'exit', 'exit code 3');
    pool.move(session, 'restarting', 'timeout', 'no (:protocol-version …) within 10 s');
    pool.move(session, 'ready', 'handshake');
    pool.move(session, 'restarting', 'restart', 'Restart Backend');
    pool.move(session, 'ready', 'handshake');
    pool.move(session, 'restarting', 'exit', 'exit code 3');
    pool.move(session, 'stopped', 'stop');
    pool.move(session, 'ready', 'handshake');
    assert.strictEqual(events.length, 4);
    // A failed session returned to stopped because its command line changed: at once.
    pool.move(session, 'failed', 'gaveUp', 'gave up');
    pool.move(session, 'stopped', 'reconfigure', 'the idris2.ideMode settings changed');
    assert.deepStrictEqual(events.slice(4), [`${LOOSE.dir} reconfigure`]);
  });

  test('the commands\' and the checks\' control: active roots, stop, release, restart, the active root, and a raw request to the root\'s check session', async () => {
    const { ide, pool } = setup();
    const other = projectRoot();
    pool.move(pool.sessionFor(LOOSE), 'ready', 'handshake');
    pool.move(pool.sessionFor(other), 'stopped', 'stop');
    assert.deepStrictEqual(ide.activeRoots(), [LOOSE]);
    ide.stop(LOOSE);
    ide.stop();
    ide.release(other);
    ide.restart(other);
    ide.restart();
    // The checks' active document (idris2.ideMode.maxSessions never stops its root's sessions).
    ide.setActiveRoot(other);
    ide.setActiveRoot('pending');
    ide.setActiveRoot(undefined);
    assert.deepStrictEqual(pool.calls, [
      `stop ${LOOSE.dir}`,
      'stop all',
      `release ${other.dir}`,
      `restart ${other.dir}`,
      'restartAll',
      `setActiveRoot ${other.dir}`,
      'setActiveRoot pending',
      'setActiveRoot none',
    ]);

    const session = pool.sessionFor(LOOSE);
    session.next = () => Promise.resolve({ id: 5n, payload: { kind: 'error', message: 'Unrecognised command: x\nmore', highlighting: [] }, messages: [], returnedId: 4n });
    assert.strictEqual(await ide.sendRaw(LOOSE, '(:bogus "x")'), 'id 4 (attributed to 5): error: Unrecognised command: x');
    // Anything may be sent (a :load-file, a :proof-search): the long-action limit applies.
    assert.deepStrictEqual(session.requests.at(-1), { command: { kind: 'raw', text: '(:bogus "x")' }, options: { kind: 'longAction' } });
  });
});
