// backend/ide/backend.ts against a fake session pool and a fake of the vscode constructors: the
// path sent in :load-file, the conversion of the recorded replies to vscode diagnostics, the
// per-root state the status item shows, the crash notices, and the commands' control surface.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  IdeMode,
  IDE_MODE_CAPABILITIES,
  WARM_UP_MAX_WAIT_MS,
  WARM_UP_QUIET_MS,
  type DiagnosticsApi,
  type IdeModeDeps,
  type LoadedDocument,
} from '../../src/backend/ide/backend';
import { ideCodec } from '../../src/backend/ide/protocol';
import { serializeSexp, sym } from '../../src/backend/ide/sexp';
import type {
  IdeCommand,
  IdeMessage,
  IdeSession,
  LoadedFile,
  Reply,
  RequestOptions,
  SessionPool,
  SessionPoolChange,
  SessionRole,
  SessionState,
  SessionStateChange,
} from '../../src/backend/ide/types';
import type { TokenIndex } from '../../src/backend/types';
import type { IdeModeSettings } from '../../src/core/config';
import { cancelled, errorText, IdrisException, isCancelled } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { GateVerdict } from '../../src/core/trust';
import type { Classification } from '../../src/project/types';
import { repoRoot } from '../fake-tools/paths';
import { createTunedSessionPool } from '../../src/backend/ide/pool';
import { DEFAULT_SESSION_TIMING } from '../../src/backend/ide/session';
import { FakeClock, FakeTransport, flush, jsonCodec, ok, recordingLog, RecordingTrace, ret, str } from './support/fakeTransport';
import { recordedExchanges } from './support/loadReplies';
import { FakeToolchain, LOOSE, projectRoot, snapshot } from './support/toolchainFixtures';

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
  state: SessionState = 'stopped';
  launch: IdeSession['launch'] = undefined;
  readonly protocolVersion = undefined;
  /** As the real session: the `file` of the last load answered (set before its caller resumes). */
  loadedFile: LoadedFile | undefined = undefined;
  readonly changed = new Emitter<SessionStateChange>();
  readonly onDidChangeState = this.changed.event;
  /** The requests sent (their `beforeSend` passed), with the options but that hook. */
  readonly requests: { command: IdeCommand; options: RequestOptions }[] = [];
  next: (command: IdeCommand) => Promise<Reply> = () => Promise.reject(new Error('no reply scripted'));
  /** Stands for what a request waits for before it is sent: the toolchain scan, the consent question, the start. */
  waitBeforeSend: Promise<void> = Promise.resolve();
  /** Runs right before a request's `beforeSend` (what may happen to the process meanwhile). */
  beforeCheck: (command: IdeCommand) => void = () => undefined;
  /**
   * Whether a request's `onReply` runs when its reply arrives, before the caller resumes, as the real
   * session runs it; off unless a test turns it on (the holes a check load asks for afterwards).
   */
  replyHooks = false;
  constructor(
    readonly root: Classification,
    readonly cwd: string,
    readonly role: SessionRole = 'check',
  ) {}
  /** How often `request` was called (a first request starts a process, after the consent question). */
  asked = 0;
  /** The requests called and not yet settled. */
  private running = 0;
  /** As the real session's (nothing in flight or waiting), but for its state, which a test moves. */
  get idle(): boolean {
    return this.running === 0;
  }
  async request(command: IdeCommand, options: RequestOptions): Promise<Reply> {
    this.asked++;
    this.running++;
    try {
      const { beforeSend, onReply, ...sent } = options;
      await this.waitBeforeSend;
      this.beforeCheck(command);
      await beforeSend?.();
      this.requests.push({ command, options: sent });
      const reply = await this.next(command);
      if (options.kind === 'load') {
        this.loadedFile = options.file;
      }
      if (this.replyHooks) {
        onReply?.(reply);
      }
      return reply;
    } finally {
      this.running--;
    }
  }
}

class FakePool implements SessionPool {
  readonly list: FakeSession[] = [];
  readonly calls: string[] = [];
  readonly changed = new Emitter<SessionPoolChange>();
  readonly onDidChange = this.changed.event;
  sessionFor(root: Classification, role: SessionRole = 'check'): FakeSession {
    let session = this.list.find((s) => JSON.stringify(s.root) === JSON.stringify(root) && s.role === role);
    if (session === undefined) {
      session = new FakeSession(root, root.dir, role);
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
  restartCheck(root: Classification, detail: string): void {
    this.calls.push(`restartCheck ${root.dir}: ${detail}`);
  }
  cancelEvaluation(root: Classification): void {
    this.calls.push(`cancelEvaluation ${root.dir}`);
  }
  releaseEvaluation(root: Classification, detail: string): void {
    this.calls.push(`releaseEvaluation ${root.dir}: ${detail}`);
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
  /** The editor's text (for the positions of the queries); none by default. */
  text: string;
}

function doc(fileName: string, overrides: Partial<Doc> = {}): vscode.TextDocument {
  const lines = overrides.text === undefined ? [] : overrides.text.split('\n');
  return {
    uri: { scheme: 'file', fsPath: fileName, toString: () => `file://${fileName}` },
    fileName,
    isUntitled: false,
    isDirty: false,
    version: 7,
    languageId: 'idris2',
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] }),
    getText: () => overrides.text ?? '',
    ...overrides,
  } as unknown as vscode.TextDocument;
}

/** A cancellation token the test cancels (`vscode.CancellationTokenSource`'s part the backend uses). */
class CancellationSource {
  private readonly emitter = new Emitter<void>();
  readonly token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event } as unknown as vscode.CancellationToken & { isCancellationRequested: boolean };
  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
}

/** Timers the test fires by hand (`fire`), for the time limit of the walk made when a load is queued. */
class ManualClock {
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  private next = 0;
  /** The time `now()` gives; a test moves it. */
  time = 0;
  now(): number {
    return this.time;
  }
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
      evaluation: () => ({ inlineResults: true, timeoutMs: 10_000 }),
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
    isOpen: () => false,
    openText: () => undefined,
    ...overrides,
  };
  const ide = new IdeMode(deps);
  return { ide, pool, gateChanged, verdicts, read, searched, clock, deps, backend: ide.backendFor() };
}

const plainRange = (r: Range) => [r.start.line, r.start.character, r.end.line, r.end.character];

/** Lets pending promise callbacks and immediates run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

suite('backend/ide/backend (IdeMode, IdeBackend)', () => {
  test('capabilities: diagnostics (M2), the read-only intelligence (M3), holes and editing (M4); signature help and the unsaved checks are not IDE mode\'s', () => {
    const { backend } = setup();
    assert.strictEqual(backend.kind, 'ideMode');
    assert.deepStrictEqual(
      Object.entries(backend.caps).filter(([, on]) => on).map(([cap]) => cap).sort(),
      [
        'browseNamespace', 'completion', 'definition', 'diagnostics', 'docs', 'documentHighlights', 'documentSymbols', 'editing', 'editingNext',
        'evaluate', 'holeLocations', 'holes', 'hover', 'intro', 'missingCases', 'refine', 'semanticTokens',
      ],
    );
    assert.strictEqual(backend.caps, IDE_MODE_CAPABILITIES);
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
    // Read right before the load was written (the token index's text) and when the reply arrived.
    assert.deepStrictEqual(read, ['/w/broken/Err.lidr', '/w/broken/Err.lidr']);
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

  test('onDidFail: a crash (exit, timeout, protocol error) that restarts, and a give-up; not a long action over its limit, which its command reports', () => {
    const { ide, pool } = setup();
    const failures: [boolean, string, boolean][] = [];
    ide.onDidFail((f) => failures.push([f.gaveUp, f.detail, f.repeated]));
    const session = pool.sessionFor(LOOSE);
    pool.move(session, 'ready', 'handshake');
    pool.move(session, 'restarting', 'exit', 'exit code 3; last stderr line: boom');
    pool.move(session, 'starting', 'backoff');
    pool.move(session, 'restarting', 'timeout', 'no reply within 60 s');
    pool.move(session, 'restarting', 'longActionTimeout', ':proof-search did not answer within 1 min');
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
    pool.move(session, 'restarting', 'exit', 'exit code 3');
    pool.move(session, 'restarting', 'longActionTimeout', ':proof-search did not answer within 1 min');
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
    const third: Classification = { kind: 'loose', dir: '/w/third' };
    pool.move(pool.sessionFor(LOOSE), 'ready', 'handshake');
    pool.move(pool.sessionFor(LOOSE, 'eval'), 'busy', 'dispatch');
    pool.move(pool.sessionFor(other), 'stopped', 'stop');
    pool.move(pool.sessionFor(other, 'eval'), 'failed', 'spawnError');
    // A root whose only process is its eval session's is running too (Stop Backend lists it).
    pool.move(pool.sessionFor(third, 'eval'), 'ready', 'handshake');
    assert.deepStrictEqual(ide.activeRoots(), [LOOSE, third]);
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

// -------------------------------------------------------------------------------------------
// M3: the queries, the token index and evaluation, against the recorded 0.8.0 replies
// -------------------------------------------------------------------------------------------

const WORKSPACES = path.join(repoRoot(), 'test', 'fixtures', 'workspaces');

/** The fixture text of `/w/<workspace>/<file>` or `/private/w/<workspace>/<file>`, as the backend reads files. */
function fixtureFile(p: string): Promise<string> {
  const relative = p.replace(/^(\/private)?\/w\//, '');
  return fs.promises.readFile(path.join(WORKSPACES, relative), 'utf8');
}

function fixtureText(relative: string): string {
  return fs.readFileSync(path.join(WORKSPACES, relative), 'utf8');
}

/** A reply with `payload` as the compiler writes it (`(:ok "n : Nat" ())`, `(:ok ())`), decoded as the session decodes it. */
function answer(payload: string): Reply {
  const decoded = ideCodec.decodeMessage(`(:return ${payload} 1)`);
  assert.ok(decoded.kind === 'message' && decoded.message.kind === 'return', payload);
  return { id: 1n, payload: decoded.message.payload, messages: [] };
}

/** A reply the compiler would give for a name it does not know. */
const undefinedName = (text: string): Reply => ({ id: 0n, payload: { kind: 'error', message: `Undefined name ${text}. \n`, highlighting: [] }, messages: [] });

/**
 * Answers each command as `scenario` recorded it (paths under `root`), else with `extra` (by the
 * command's s-expression), else as an undefined name.
 */
function replaying(scenario: string, root: string, extra: Record<string, Reply> = {}): (command: IdeCommand) => Promise<Reply> {
  const exchanges = recordedExchanges(scenario, root);
  return (command) => {
    const text = command.kind === 'raw' ? command.text : serializeSexp(command);
    const found = exchanges.find((x) => x.request.replace(/ \d+\)\n$/, '').slice(1) === text);
    return Promise.resolve(found?.reply ?? extra[text] ?? undefinedName(text));
  };
}

const commands = (session: { requests: { command: IdeCommand }[] }): string[] =>
  session.requests.map((r) => (r.command.kind === 'raw' ? r.command.text : serializeSexp(r.command)));

const pos = (line: number, character: number) => new Position(line, character) as vscode.Position;

/** The narrowest token of `index` holding (line, character). */
const tokenAtFor = (index: TokenIndex | undefined, line: number, character: number) =>
  index?.tokens
    .filter((t) => t.range.start.line === line && t.range.start.character <= character && character < t.range.end.character)
    .sort((a, b) => a.range.end.character - a.range.start.character - (b.range.end.character - b.range.start.character))[0];

suite('backend/ide/backend M3 (queries, token index, evaluation)', () => {
  const CLEAN = '/w/broken/Clean.idr';
  const cleanDoc = (overrides: Partial<Doc> = {}) => doc(CLEAN, { text: fixtureText('broken/Clean.idr'), ...overrides });

  /** An IdeMode whose broken/ check session replays `scenario`, with Clean.idr (or `file`) loaded. */
  async function loaded(scenario: string, file = 'Clean.idr') {
    const t = setup({ readFile: fixtureFile });
    const announced: LoadedDocument[] = [];
    t.ide.onDidLoad((e) => announced.push(e));
    const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
    session.next = replaying(scenario, '/private/w/broken');
    const d = doc(`/w/broken/${file}`, { text: fixtureText(`broken/${file}`) });
    await t.backend.load(d);
    return { ...t, session, announced, d };
  }

  suite('the token index and onDidLoad', () => {
    test('a load builds the document\'s index from its frames (Clean.idr: xs is bound at (7,5)) and announces it once', async () => {
      const { backend, announced, d } = await loaded('clean-queries');
      const index = backend.tokens(d);
      assert.strictEqual(index?.file, CLEAN);
      assert.strictEqual(index.text, fixtureText('broken/Clean.idr'), 'the text read from disk before the load was written and after its reply');
      assert.deepStrictEqual(
        index.tokens.filter((t) => t.name === 'xs').map((t) => [t.range.start.line, t.range.start.character, t.decor]),
        [[7, 5, 'bound']],
      );
      assert.deepStrictEqual(announced, [{ root: { kind: 'loose', dir: '/w/broken' }, file: CLEAN, rebuilt: true, failed: false }]);
      assert.strictEqual(backend.tokens(doc('/w/broken/Other.idr')), undefined);
    });

    test('merged loads share one reply: one index build, one announcement; a failed load keeps the index; release forgets it', async () => {
      const t = setup({ readFile: fixtureFile });
      const announced: LoadedDocument[] = [];
      t.ide.onDidLoad((e) => announced.push(e));
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const reply = recordedExchanges('clean-queries', '/private/w/broken')[0].reply;
      session.next = () => Promise.resolve(reply);
      await Promise.all([t.backend.load(cleanDoc()), t.backend.load(cleanDoc({ version: 8 }))]);
      assert.strictEqual(announced.length, 1);
      const before = t.backend.tokens(cleanDoc());
      assert.ok(before !== undefined && before.tokens.length > 0);
      // A load that returns an error sends no highlighting [live]: the index stays, the load is announced.
      session.next = () => Promise.resolve(recordedExchanges('load-bad', '/private/w/broken')[0].reply);
      await t.backend.load(cleanDoc({ version: 9 }));
      assert.strictEqual(t.backend.tokens(cleanDoc()), before);
      assert.strictEqual(announced.length, 2);
      t.ide.release({ kind: 'loose', dir: '/w/broken' });
      assert.strictEqual(t.backend.tokens(cleanDoc()), undefined);
    });

    test('rebuilt: a load that built a module, failed, or is its process\'s first; not a later one that built nothing; failed: one that returned an error', async () => {
      const t = setup({ readFile: fixtureFile });
      const announced: LoadedDocument[] = [];
      t.ide.onDidLoad((e) => announced.push(e));
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const first = { executable: '/bin/idris2', args: [], cwd: '/w/broken', env: {}, transport: 'stdio' as const };
      session.launch = first;
      const building = recordedExchanges('clean-queries', '/private/w/broken')[0].reply;
      assert.ok(building.messages.some((m) => m.kind === 'write-string' && /Building Clean/.test(m.text)), 'the recorded load built Clean');
      // A new reply object for each load, as the session makes (merged loads share one).
      const quiet = (): Reply => ({ id: 2n, payload: { kind: 'ok', result: { kind: 'list', items: [] }, highlighting: [] }, messages: [] });
      const failed = (): Reply => ({ id: 3n, payload: { kind: 'error', message: 'x', highlighting: [] }, messages: [] });
      for (const reply of [quiet, () => ({ ...building }), quiet, quiet, failed, quiet]) {
        session.next = () => Promise.resolve(reply());
        await t.backend.load(cleanDoc());
      }
      // A new process (after a crash, a stop, a restart): its first load counts, whatever it sent.
      session.launch = { ...first };
      session.next = () => Promise.resolve(quiet());
      await t.backend.load(cleanDoc());
      await t.backend.load(cleanDoc());
      assert.deepStrictEqual(announced.map((e) => e.rebuilt), [true, true, false, false, true, false, true, false]);
      assert.deepStrictEqual(announced.map((e) => e.failed), [false, false, false, false, true, false, false, false]);
    });

    test('rebuilt: also a load that built nothing of a text other than the one the file\'s last load read (seventh review of M3)', async () => {
      // Where the package or extraArgs give the check and eval sessions one build directory (D5), an
      // evaluation (or the user's own build) builds the saved text there first, and the check load
      // builds nothing: the hover's answers kept by position described the text before.
      let clean = fixtureText('broken/Clean.idr');
      const t = setup({ readFile: (p) => (p === CLEAN ? Promise.resolve(clean) : fixtureFile(p)) });
      const announced: LoadedDocument[] = [];
      t.ide.onDidLoad((e) => announced.push(e));
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      session.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', env: {}, transport: 'stdio' as const };
      const quiet = (): Reply => ({ id: 2n, payload: { kind: 'ok', result: { kind: 'list', items: [] }, highlighting: [] }, messages: [] });
      session.next = () => Promise.resolve(quiet());
      const plain = doc('/w/broken/Plain.idr', { text: fixtureText('broken/Plain.idr') });
      await t.backend.load(cleanDoc());
      await t.backend.load(cleanDoc());
      await t.backend.load(plain);
      clean = `-- a note\n${clean}`;
      await t.backend.load(cleanDoc({ text: clean }));
      await t.backend.load(cleanDoc({ text: clean }));
      await t.backend.load(plain);
      assert.deepStrictEqual(
        announced.map((e) => `${path.basename(e.file)} ${e.rebuilt}`),
        // The process's first; the same text; another file's first load in this process (no answer
        // about it can be kept yet); a changed text; the same again; Plain unchanged.
        ['Clean.idr true', 'Clean.idr false', 'Plain.idr false', 'Clean.idr true', 'Clean.idr false', 'Plain.idr false'],
      );
      // A new process: its first load counts, whatever it read.
      session.launch = { ...session.launch };
      await t.backend.load(cleanDoc({ text: clean }));
      await t.backend.load(cleanDoc({ text: clean }));
      assert.deepStrictEqual(announced.slice(6).map((e) => e.rebuilt), [true, false]);
    });

    test('the index keeps the text only when the file reads the same right before the load and after its reply', async () => {
      let reads = 0;
      const t = setup({ readFile: (p) => (p.endsWith('/Clean.idr') && ++reads === 1 ? Promise.resolve('-- the text before a save\n') : fixtureFile(p)) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const replay = replaying('clean-queries', '/private/w/broken');
      session.next = async (command) => ({ ...(await replay(command)) });
      await t.backend.load(cleanDoc());
      const changed = t.backend.tokens(cleanDoc());
      assert.ok(changed !== undefined && changed.tokens.length > 0);
      assert.strictEqual(changed.text, undefined, 'saved during the load: which text the compiler read is not known');
      await t.backend.load(cleanDoc({ version: 8 }));
      assert.strictEqual(t.backend.tokens(cleanDoc())?.text, fixtureText('broken/Clean.idr'));
    });

    test('at most 16 token indexes are kept, the least recently used going first; a use keeps one', async () => {
      const t = setup({ readFile: fixtureFile });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const reply = recordedExchanges('clean-queries', '/private/w/broken')[0].reply;
      const file = (i: number) => doc(`/w/broken/F${i}.idr`);
      // Every load names Clean.idr's frames; each file's index is that of its own load (isLoadedFile by path).
      session.next = () => Promise.resolve({ ...reply });
      await t.backend.load(cleanDoc());
      for (let i = 0; i < 15; i++) {
        await t.backend.load(file(i));
      }
      assert.ok(t.backend.tokens(cleanDoc()) !== undefined, '16 kept');
      await t.backend.load(file(15));
      assert.strictEqual(t.backend.tokens(file(0)), undefined, 'the least recently used went');
      assert.ok(t.backend.tokens(cleanDoc()) !== undefined, 'the one used just before stays');
      assert.ok(t.backend.tokens(file(15)) !== undefined);
    });

    test('the index of a file with an open document is never dropped: 17 open files keep 17; a closed one goes first (second review of M3)', async () => {
      // Dropped, a re-shown tab lost its semantic tokens and inlay hints until something loaded it again.
      const open = new Set<string>();
      const t = setup({ readFile: fixtureFile, isOpen: (f) => open.has(f) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const reply = recordedExchanges('clean-queries', '/private/w/broken')[0].reply;
      const file = (i: number) => doc(`/w/broken/F${i}.idr`);
      session.next = () => Promise.resolve({ ...reply });
      for (let i = 0; i < 17; i++) {
        open.add(file(i).fileName);
        await t.backend.load(file(i));
      }
      for (let i = 0; i < 17; i++) {
        assert.ok(t.backend.tokens(file(i)) !== undefined, `F${i}: open, kept`);
      }
      // F3 is closed (another file of the root stays open): the next load drops it, not the older F0.
      open.delete(file(3).fileName);
      open.add(file(17).fileName);
      await t.backend.load(file(17));
      assert.strictEqual(t.backend.tokens(file(3)), undefined, 'the closed one went');
      assert.ok(t.backend.tokens(file(0)) !== undefined, 'the least recently used open one stays');
      assert.ok(t.backend.tokens(file(17)) !== undefined);
    });

    test('E14 in diagnostics: a :warning column after characters outside the BMP is moved to its UTF-16 column', async () => {
      const t = setup({ readFile: () => Promise.resolve('f = ("𝕟𝕟", zz)\n') });
      const reply: Reply = {
        id: 1n,
        payload: { kind: 'ok', result: { kind: 'list', items: [] }, highlighting: [] },
        messages: [{ kind: 'warning', id: 1n, warning: { file: 'Astral.idr', span: { start: { line: 0, column: 11 }, end: { line: 0, column: 13 } }, message: 'Unused.', highlighting: [] } }],
      };
      t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }).next = () => Promise.resolve(reply);
      const result = await t.backend.load(doc('/w/broken/Astral.idr'));
      assert.deepStrictEqual(plainRange((result.diagnostics.find(([u]) => u.fsPath === '/w/broken/Astral.idr')?.[1][0] as unknown as Diagnostic).range), [0, 13, 0, 15]);
    });
  });

  suite('queries: only about the file the check session loaded last', () => {
    test('before any load, and for another file than the one loaded: NotLoaded at once, nothing sent or started', async () => {
      const t = setup({ readFile: fixtureFile });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      for (const query of [
        () => t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs'),
        () => t.backend.docsFor(cleanDoc(), 'vlen', 'overview'),
        () => t.backend.definition(cleanDoc(), pos(6, 0), 'vlen'),
        () => t.backend.completions(cleanDoc(), 'vl'),
        () => t.backend.browseNamespace(cleanDoc(), 'Clean'),
      ]) {
        await assert.rejects(query(), (e: unknown) => e instanceof IdrisException && e.error.kind === 'NotLoaded' && e.error.file === CLEAN);
      }
      assert.strictEqual(session.asked, 0);
      const other = await loaded('clean-queries');
      await assert.rejects(other.backend.typeAt(doc('/w/broken/Bad.idr'), pos(3, 6), 'x'), /Bad\.idr is not the file the compiler of its project has loaded last/);
      assert.strictEqual(other.session.asked, 1, 'only the load');
    });

    test('a load of another file queued before the query: the check right before the write refuses it (NotLoaded), nothing sent', async () => {
      const t = await loaded('clean-queries');
      t.session.beforeCheck = () => {
        t.session.loadedFile = { path: '/private/w/broken/Bad.idr', version: 1 };
      };
      await assert.rejects(t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs'), (e: unknown) => e instanceof IdrisException && e.error.kind === 'NotLoaded');
      assert.deepStrictEqual(commands(t.session), ['(:load-file "/private/w/broken/Clean.idr")']);
    });

    test('a reload of the same file that went before a waiting query (an urgent load): the query is refused (NotLoaded), not sent with the position of the load before (sixth review of M3)', async () => {
      // While maxBackgroundChecks is set the active document's load is urgent and passes every
      // request that waits, lookups too: the :type-of converted for the load before was sent after
      // the reload, and the compiler answered about the reloaded text at the old coordinates.
      const t = await loaded('clean-queries');
      let open: () => void = () => undefined;
      t.session.waitBeforeSend = new Promise<void>((resolve) => (open = resolve));
      const queries = [
        t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs'),
        t.backend.docsFor(cleanDoc(), 'vlen', 'full'),
        t.backend.definition(cleanDoc(), pos(6, 1), 'vlen'),
      ].map((query) => query.then(() => 'answered', (e: unknown) => (e instanceof IdrisException ? `${e.error.kind}: ${errorText(e.error)}` : String(e))));
      await settle();
      t.session.waitBeforeSend = Promise.resolve();
      await t.backend.load(cleanDoc({ version: 9 })); // the reload, sent first
      open();
      // Not "is not the file … loaded last", which it is (ninth review of M3).
      assert.deepStrictEqual(await Promise.all(queries), Array(3).fill('NotLoaded: Clean.idr was checked again while the question waited; ask again.'));
      assert.deepStrictEqual(commands(t.session), ['(:load-file "/private/w/broken/Clean.idr")', '(:load-file "/private/w/broken/Clean.idr")']);
      // Asked again (as DocumentQueries does), they are sent for the new load.
      assert.strictEqual((await t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs'))?.text, 'xs : Vect ?_ ?_');
    });

    test('typeAt: the positional :type-of (F2) with the lookup it used and the reply\'s highlighting; cached per load and position', async () => {
      const t = await loaded('clean-queries');
      const xs = await t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs');
      assert.deepStrictEqual(xs, { text: 'xs : Vect ?_ ?_', spans: [{ start: 5, length: 4, decor: 'type' }], lookup: 'position' });
      assert.strictEqual(commands(t.session).at(-1), '(:type-of "xs" 8 5)');
      assert.strictEqual(await t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs'), xs, 'the same answer, not asked again');
      assert.strictEqual(t.session.requests.length, 2);
      // A new load of the file: asked again.
      await t.backend.load(cleanDoc({ version: 8 }));
      await t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs');
      assert.strictEqual(t.session.requests.length, 4);
    });

    test('typeAt: when the positional request fails, by name (lookup "name"); undefined when that fails too; a prose line asks nothing', async () => {
      const t = await loaded('clean-queries');
      // `(:type-of "index")` was recorded by name; asked at a position where the compiler finds nothing.
      const index = await t.backend.typeAt(cleanDoc(), pos(0, 0), 'index');
      assert.strictEqual(index?.lookup, 'name');
      assert.match(index.text, /^Data\.List\.index : .*\nData\.Vect\.index : Fin len -> Vect len elem -> elem$/);
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:type-of "index" 1 0)', '(:type-of "index")']);
      assert.strictEqual(await t.backend.typeAt(cleanDoc(), pos(0, 3), 'nope'), undefined);
      const lit = setup({ readFile: fixtureFile });
      const litDoc = doc('/w/loose-file/Lit.lidr', { languageId: 'lidr', text: fixtureText('loose-file/Lit.lidr') });
      assert.strictEqual(await lit.backend.typeAt(litDoc, pos(2, 3), 'Prose'), undefined);
      assert.strictEqual(lit.pool.list.length, 0, 'no session asked');
    });

    test('typeAt: an answer about another local (the editor and the loaded text disagree) is not taken; E14 columns on astral lines', async () => {
      const t = await loaded('unicode-columns', 'Unicode.idr');
      const unicode = doc('/w/broken/Unicode.idr', { text: fixtureText('broken/Unicode.idr') });
      // (:type-of "y" 12 3) answers `x₁ : ℕ` [live]; a name may end there (`x` comes before column
      // 3), so one column further, which answers `x₁ : ℕ` too; by name then, which the compiler does
      // not know.
      assert.strictEqual(await t.backend.typeAt(unicode, pos(11, 3), 'y'), undefined);
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:type-of "y" 12 3)', '(:type-of "y" 12 4)', '(:type-of "y")']);
      // `astral s = ("𝕟𝕟", s)`: the editor's UTF-16 column 20 is the compiler's 18.
      const s = await t.backend.typeAt(unicode, pos(14, 20), 's');
      assert.deepStrictEqual(s, { text: 's : String', spans: [{ start: 4, length: 6, decor: 'type' }], lookup: 'position' });
      assert.strictEqual(commands(t.session).at(-1), '(:type-of "s" 15 18)');
    });

    test('typeAt: a variable (the caller\'s token is :bound) is not asked by name: the answer would be a global it shadows', async () => {
      const project = projectRoot({ dir: '/w/simple-ipkg', ipkgPath: '/w/simple-ipkg/simple-ipkg.ipkg' });
      const shapes = '/w/simple-ipkg/src/Foo/Shapes.idr';
      const t = setup({ readFile: fixtureFile, roots: { [shapes]: project } });
      const session = t.pool.sessionFor(project);
      session.next = replaying('shapes-lookups', '/w/simple-ipkg');
      const d = doc(shapes, { text: fixtureText('simple-ipkg/src/Foo/Shapes.idr') });
      await t.backend.load(d);
      // The interface parameter `a` of `interface Measured a where`: the positional answer is
      // `Undefined name a` [live, shapes-lookups]; no request by name follows.
      assert.strictEqual(tokenAtFor(t.backend.tokens(d), 17, 19)?.decor, 'bound');
      assert.strictEqual(await t.backend.typeAt(d, pos(17, 19), 'a', 'bound'), undefined);
      assert.deepStrictEqual(commands(session).slice(1), ['(:type-of "a" 18 19)']);
      // The method `perimeter` of `Measured Shape where`: the positional answer names the
      // implementation's machine name, another name [live]; by name, the method's declared type.
      const perimeter = await t.backend.typeAt(d, pos(23, 2), 'perimeter');
      assert.deepStrictEqual([perimeter?.text, perimeter?.lookup], ['Foo.Shapes.perimeter : Measured a => a -> Double', 'name']);
      assert.deepStrictEqual(commands(session).slice(2), ['(:type-of "perimeter" 24 2)', '(:type-of "perimeter")']);
    });

    test('typeAt, docsFor and definition wait for a reload of the file being made, instead of answering from the load before it', async () => {
      const t = await loaded('clean-queries');
      t.session.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', realCwd: '/private/w/broken', env: {}, transport: 'stdio' };
      const before = await t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs');
      await t.backend.definition(cleanDoc(), pos(6, 1), 'vlen'); // its :name-at answer is kept for this load
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const replay = t.session.next;
      t.session.next = async (command) => {
        if (command.kind !== 'raw' && serializeSexp(command).startsWith('(:load-file')) {
          await gate;
        }
        return replay(command);
      };
      const reload = t.backend.load(cleanDoc({ version: 9 }));
      await settle();
      let answered: unknown;
      const during = t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs').then((a) => (answered = a));
      const docs = t.backend.docsFor(cleanDoc(), 'vlen', 'full');
      // Go to Definition (or a Cmd-hover) during the check after a save (fifth review of M3: not pinned).
      let found: unknown;
      const where = t.backend.definition(cleanDoc(), pos(6, 1), 'vlen').then((l) => (found = l));
      await settle();
      assert.strictEqual(answered, undefined, 'not answered from the previous load while the reload runs');
      assert.strictEqual(found, undefined, 'no location from the previous load\'s :name-at while the reload runs');
      open();
      await reload;
      await during;
      assert.notStrictEqual(answered, before, 'a new answer, of the new load');
      assert.deepStrictEqual(answered, before);
      assert.ok((await docs) !== undefined);
      assert.strictEqual(((await where) as unknown as Location[]).length, 1);
      assert.deepStrictEqual(commands(t.session).slice(3), [
        '(:load-file "/private/w/broken/Clean.idr")',
        '(:type-of "xs" 8 5)',
        '(:docs-for "vlen")',
        '(:name-at "vlen")',
      ]);
    });

    test('docsFor: the whole text for either mode (F31), cached per load; undefined for an unknown name', async () => {
      const t = await loaded('clean-queries');
      const vlen = await t.backend.docsFor(cleanDoc(), 'vlen', 'overview');
      assert.strictEqual(vlen?.text, 'Clean.vlen : Vect n a -> Nat\n  Visibility: private');
      assert.strictEqual(await t.backend.docsFor(cleanDoc(), 'vlen', 'full'), vlen);
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:docs-for "vlen")']);
      assert.strictEqual(await t.backend.docsFor(cleanDoc(), 'nope', 'full'), undefined);
    });

    test('definition: :name-at by name, the file as the editor spells it, the span in the target\'s columns; installed sources as sent', async () => {
      const t = await loaded('clean-queries');
      // The installed sources are there (as on the recording machine).
      t.deps.readFile = (p) => (p.startsWith('/opt/homebrew/') ? Promise.resolve('') : fixtureFile(p));
      t.session.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', realCwd: '/private/w/broken', env: {}, transport: 'stdio' };
      const [vlen] = (await t.backend.definition(cleanDoc(), pos(6, 1), 'vlen')) as unknown as Location[];
      assert.strictEqual(vlen.uri.fsPath, CLEAN);
      assert.deepStrictEqual(plainRange(vlen.range), [6, 0, 6, 22]);
      const index = (await t.backend.definition(cleanDoc(), pos(0, 0), 'index')) as unknown as Location[];
      assert.deepStrictEqual(index.map((l) => [l.uri.fsPath, ...plainRange(l.range)]), [
        ['/opt/homebrew/Cellar/idris2/0.8.0_2/libexec/idris2-0.8.0/base-0.8.0/Data/List.idr', 80, 0, 84, 70],
        ['/opt/homebrew/Cellar/idris2/0.8.0_2/libexec/idris2-0.8.0/base-0.8.0/Data/Vect.idr', 137, 0, 143, 40],
      ]);
      // A qualified name is asked unqualified (the qualified form answers ()) and keeps its own definitions.
      const qualified = (await t.backend.definition(cleanDoc(), pos(0, 0), 'Data.Vect.index')) as unknown as Location[];
      assert.deepStrictEqual(qualified.map((l) => l.uri.fsPath), ['/opt/homebrew/Cellar/idris2/0.8.0_2/libexec/idris2-0.8.0/base-0.8.0/Data/Vect.idr']);
      assert.strictEqual(commands(t.session).at(-1), '(:name-at "index")');
    });

    test('definition: a bound variable is refused (Unsupported, nothing asked); an unknown name finds nothing', async () => {
      const t = await loaded('clean-queries');
      await assert.rejects(t.backend.definition(cleanDoc(), pos(7, 6), 'xs', 'bound'), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'Unsupported');
        assert.match(e.message, /^xs is a local variable\. Go to Definition finds global names only/);
        return true;
      });
      assert.strictEqual(t.session.requests.length, 1);
      assert.deepStrictEqual(await t.backend.definition(cleanDoc(), pos(0, 0), 'nope'), []);
    });

    test('definition: files that cannot be read (sources not installed) are left out; with none left, Unsupported says where', async () => {
      const t = await loaded('clean-queries');
      t.deps.readFile = (p) => (p.endsWith('/Data/Vect.idr') ? Promise.resolve('') : Promise.reject(new Error('ENOENT')));
      const index = (await t.backend.definition(cleanDoc(), pos(0, 0), 'index')) as unknown as Location[];
      assert.deepStrictEqual(index.map((l) => path.basename(l.uri.fsPath)), ['Vect.idr']);
      await assert.rejects(t.backend.definition(cleanDoc(), pos(0, 0), 'id'), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'Unsupported');
        assert.strictEqual(
          e.message,
          'The definition of id is in /opt/homebrew/Cellar/idris2/0.8.0_2/libexec/idris2-0.8.0/prelude-0.8.0/Prelude/Basics.idr, which cannot be read on this computer ' +
            '(an installed package whose sources were not installed, or a file that was moved).',
        );
        return true;
      });
    });

    test('definition: entries whose file is not an absolute path ((Interactive), (File-Not-Found)) are left out, unread', async () => {
      const t = await loaded('clean-queries');
      const read: string[] = [];
      t.deps.readFile = (p) => {
        read.push(p);
        return Promise.resolve('f : Nat\n');
      };
      t.session.next = () => Promise.resolve(answer('(:ok (("Clean.f" (:filename "(Interactive)") (:start 0 0) (:end 0 1))))'));
      assert.deepStrictEqual(await t.backend.definition(cleanDoc(), pos(0, 0), 'f'), []);
      // Another name: the answer for `f` is kept for this load.
      t.session.next = () =>
        Promise.resolve(
          answer('(:ok (("Clean.g" (:filename "(File-Not-Found)") (:start 0 0) (:end 0 1)) ("Clean.g" (:filename "/w/broken/F.idr") (:start 0 0) (:end 0 1))))'),
        );
      const found = (await t.backend.definition(cleanDoc(), pos(0, 0), 'g')) as unknown as Location[];
      assert.deepStrictEqual(found.map((l) => [l.uri.fsPath, ...plainRange(l.range)]), [['/w/broken/F.idr', 0, 0, 0, 1]]);
      assert.deepStrictEqual(read, ['/w/broken/F.idr']);
    });

    test('definition with unsaved changes: the caller\'s decoration decides, not the index at the editor position (third review of M3)', async () => {
      const t = await loaded('clean-queries');
      t.deps.readFile = (p) => (p.startsWith('/opt/homebrew/') ? Promise.resolve('') : fixtureFile(p));
      // A line inserted after line 5, not saved: `vlen : Vect n a -> Nat` is line 7 now, and the
      // index (the saved file) has the local `xs` of `vlen xs = ?vlen_rhs` ending at (7,7).
      assert.ok(t.backend.tokens(cleanDoc())?.tokens.some((k) => k.name === 'xs' && k.decor === 'bound' && k.range.end.line === 7 && k.range.end.character === 7));
      const lines = fixtureText('broken/Clean.idr').split('\n');
      lines.splice(6, 0, '');
      const dirty = cleanDoc({ text: lines.join('\n'), isDirty: true, version: 9 });
      const found = (await t.backend.definition(dirty, pos(7, 7), 'Vect', 'type')) as unknown as Location[];
      assert.deepStrictEqual(
        found.map((l) => [path.basename(l.uri.fsPath), ...plainRange(l.range)]),
        [['Vect.idr', 15, 0, 20, 64]],
      );
      assert.strictEqual(commands(t.session).at(-1), '(:name-at "Vect")');
    });

    test('typeAt with unsaved changes: asked where the position lies in the file as loaded; on a changed line only after the same text (third review of M3)', async () => {
      const saved = 'module Clash\n\nf : Nat -> Nat\nf n = n\n\ng : String -> String\ng n = n\n';
      const t = setup({ readFile: () => Promise.resolve(saved) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/c' });
      // What the compiler answers about the saved file [the shapes of live answers, e.g. `clean-queries`].
      const types: Record<string, string> = { '(:type-of "n" 4 2)': '(:ok "n : Nat" ())', '(:type-of "n" 7 2)': '(:ok "n : String" ())' };
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        return Promise.resolve(text.startsWith('(:load-file') ? answer('(:ok ())') : types[text] === undefined ? undefinedName(text) : answer(types[text]));
      };
      const file = '/w/c/Clash.idr';
      await t.backend.load(doc(file, { text: saved }));
      const shown = (text: string) => doc(file, { text, isDirty: true, version: 9 });
      // f's clause deleted: g's `n` is on the editor's line 3, the file's line 6 (0-based).
      const deleted = await t.backend.typeAt(shown('module Clash\n\ng : String -> String\ng n = n\n'), pos(3, 2), 'n', 'bound');
      assert.deepStrictEqual([deleted?.text, deleted?.lookup], ['n : String', 'position']);
      // Three lines inserted above f: f's `n` is on the editor's line 6, the file's line 3.
      const inserted = await t.backend.typeAt(shown('module Clash\n\n-- a\n-- b\n-- c\nf : Nat -> Nat\nf n = n\n\ng : String -> String\ng n = n\n'), pos(6, 2), 'n', 'bound');
      assert.strictEqual(inserted?.text, 'n : Nat');
      // Typing on g's line after `n`: the same place of the line as loaded.
      const typing = await t.backend.typeAt(shown('module Clash\n\nf : Nat -> Nat\nf n = n\n\ng : String -> String\ng n = n ++ ""\n'), pos(6, 2), 'n', 'bound');
      assert.strictEqual(typing?.text, 'n : String');
      // Other text before the position on a changed line: no positional request; a variable is not asked by name either.
      const moved = shown('module Clash\n\nf : Nat -> Nat\nf n = n\n\ng : String -> String\ng m n = n\n');
      assert.strictEqual(await t.backend.typeAt(moved, pos(6, 4), 'n', 'bound'), undefined);
      assert.strictEqual((await t.backend.typeAt(moved, pos(6, 8), 'length'))?.lookup, undefined);
      assert.deepStrictEqual(commands(session).slice(1), ['(:type-of "n" 7 2)', '(:type-of "n" 4 2)', '(:type-of "length")']);
    });

    test('typeAt between two separate unsaved edits: the let-bound x of its own line (fourth review of M3)', async () => {
      // [live, idris2 0.8.0, the reviewer's session] (:type-of "x" 5 6) → x : Nat, (:type-of "x" 6 6) → x : String.
      const saved = 'module M\n\nmain : IO ()\nmain = do\n  let x = the Nat 1\n  let x = show x\n  putStrLn x\n\ng : Nat\ng = 1';
      const t = setup({ readFile: () => Promise.resolve(saved) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/m' });
      const types: Record<string, string> = { '(:type-of "x" 5 6)': '(:ok "x : Nat" ())', '(:type-of "x" 6 6)': '(:ok "x : String" ())' };
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        return Promise.resolve(text.startsWith('(:load-file') ? answer('(:ok ())') : types[text] === undefined ? undefinedName(text) : answer(types[text]));
      };
      const file = '/w/m/M.idr';
      await t.backend.load(doc(file, { text: saved }));
      // An import inserted as line 1, and g's body changed: the first let is on the editor's line 5.
      const shown = saved.replace('module M\n', 'module M\nimport Data.List\n').replace('g = 1', 'g = 2');
      const x = await t.backend.typeAt(doc(file, { text: shown, isDirty: true, version: 9 }), pos(5, 6), 'x', 'bound');
      assert.deepStrictEqual([x?.text, x?.lookup], ['x : Nat', 'position']);
      assert.deepStrictEqual(commands(session).slice(1), ['(:type-of "x" 5 6)']);
    });

    test('typeAt with unsaved changes in a .lidr: the compiler\'s line from the text as loaded, with its `> ` lines (third review of M3)', async () => {
      const t = setup({ readFile: fixtureFile });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/loose-file' });
      session.next = replaying('lit-lookups', '/w/loose-file');
      const text = fixtureText('loose-file/Lit.lidr');
      await t.backend.load(doc('/w/loose-file/Lit.lidr', { languageId: 'lidr', text }));
      // Line 6, `> `, is two lines of the unlit text (F11 addendum); as `> -- a note` it would be one.
      const lines = text.split('\n');
      assert.strictEqual(lines[6], '> ');
      lines[6] = '> -- a note';
      const edited = doc('/w/loose-file/Lit.lidr', { languageId: 'lidr', text: lines.join('\n'), isDirty: true, version: 9 });
      const xs = await t.backend.typeAt(edited, pos(8, 7), 'xs', 'bound');
      assert.deepStrictEqual([xs?.text, xs?.lookup], ['xs : List Nat', 'position']);
      assert.strictEqual(commands(session).at(-1), '(:type-of "xs" 10 5)');
    });

    test('typeAt: an operator bound by where or let is answered unqualified and unparenthesised, and taken at its position [live]', async () => {
      const t = await loaded('clean-queries');
      // `(:type-of "<%>" 6 8)` on `f n = n <%> 1` with `(<%>)` in f's where block answered this [live, third review of M3].
      t.session.next = (command) =>
        Promise.resolve(command.kind !== 'raw' && serializeSexp(command) === '(:type-of "<%>" 7 8)' ? answer('(:ok "<%> : Nat -> Nat -> Nat" ())') : undefinedName('<%>'));
      const op = await t.backend.typeAt(cleanDoc(), pos(6, 8), '<%>', 'function');
      assert.deepStrictEqual([op?.text, op?.lookup], ['<%> : Nat -> Nat -> Nat', 'position']);
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:type-of "<%>" 7 8)']);
    });

    test('typeAt of an operator right after a local: one code point further, where the compiler answers for the operator [live]', async () => {
      const t = setup({ readFile: fixtureFile });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/loose-file' });
      session.next = replaying('lit-lookups', '/w/loose-file');
      const litDoc = doc('/w/loose-file/Lit.lidr', { languageId: 'lidr', text: fixtureText('loose-file/Lit.lidr') });
      await t.backend.load(litDoc);
      // `> glue xs ys = xs++ys` is file line 8 (0-based), the compiler's line 9 below the `> ` line
      // (F11 addendum); `++` is at file column 17, unlit 15, where `xs` answers.
      const plus = await t.backend.typeAt(litDoc, pos(8, 17), '++');
      assert.deepStrictEqual([plus?.text, plus?.lookup], ['Prelude.List.(++) : List a -> List a -> List a', 'position']);
      // `> bump n = n+1`, file line 11, the compiler's 13: `+` has one code point, so its end.
      const add = await t.backend.typeAt(litDoc, pos(11, 12), '+');
      assert.deepStrictEqual([add?.text, add?.lookup], ['Prelude.(+) : Num ty => ty -> ty -> ty', 'position']);
      // A local answered at its start (the pattern `n` of `bump n`): no second request.
      const n = await t.backend.typeAt(litDoc, pos(11, 7), 'n');
      assert.deepStrictEqual([n?.text, n?.lookup], ['n : Nat', 'position']);
      assert.deepStrictEqual(commands(session).slice(1), [
        '(:type-of "++" 10 15)',
        '(:type-of "++" 10 16)',
        '(:type-of "+" 14 10)',
        '(:type-of "+" 14 11)',
        '(:type-of "n" 14 5)',
      ]);
    });

    test('definition: the :name-at answer and the target files are kept per load; a new load asks and reads again (fourth review of M3)', async () => {
      // VS Code asks at every Go to Definition and every Cmd-hover, for each occurrence of a name.
      const t = await loaded('clean-queries');
      const read: string[] = [];
      t.deps.readFile = (p) => {
        if (p.startsWith('/opt/homebrew/')) {
          read.push(path.basename(p));
          return Promise.resolve('');
        }
        return fixtureFile(p);
      };
      const nameAts = () => commands(t.session).filter((c) => c.startsWith('(:name-at'));
      const first = (await t.backend.definition(cleanDoc(), pos(0, 0), '::')) as unknown as Location[];
      const again = (await t.backend.definition(cleanDoc(), pos(7, 3), '::')) as unknown as Location[];
      assert.strictEqual(first.length, 3);
      assert.deepStrictEqual(again.map((l) => l.uri.fsPath), first.map((l) => l.uri.fsPath));
      assert.deepStrictEqual(nameAts(), ['(:name-at "::")']);
      assert.deepStrictEqual(read.sort(), ['Basics.idr', 'Types.idr', 'Vect.idr']);
      await t.backend.load(cleanDoc({ version: 9 }));
      await t.backend.definition(cleanDoc(), pos(0, 0), '::');
      assert.deepStrictEqual(nameAts(), ['(:name-at "::")', '(:name-at "::")']);
      assert.strictEqual(read.length, 6);
    });

    test('definition into a document with unsaved changes: the range moved to the text it shows; on a line changed since, left out (fourth review of M3)', async () => {
      // VS Code applies a location to the open document: with a line inserted above and not saved,
      // the saved file's range landed one line too high (the integrator's check on Shapes.idr).
      const t = await loaded('clean-queries');
      t.session.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', realCwd: '/private/w/broken', env: {}, transport: 'stdio' };
      const saved = fixtureText('broken/Clean.idr');
      const asked: string[] = [];
      t.deps.openText = (file) => {
        asked.push(file);
        return undefined;
      };
      let version = 7;
      const range = async (shown: string): Promise<number[][]> =>
        ((await t.backend.definition(cleanDoc({ text: shown, version: ++version, isDirty: shown !== saved }), pos(0, 0), 'vlen')) as unknown as Location[]).map((l) =>
          plainRange(l.range),
        );
      assert.deepStrictEqual(await range(`-- a note\n${saved}`), [[7, 0, 7, 22]], 'saved (6,0)-(6,22), one line further');
      assert.deepStrictEqual(asked, [], 'the loaded file is the document asked about (the document as the editor spells its path)');
      // The document showing the loaded text (a byte order mark on disk ignored): as read.
      t.deps.readFile = (p) => fixtureFile(p).then((text) => (p.endsWith('/Clean.idr') ? `\uFEFF${text}` : text));
      await t.backend.load(cleanDoc({ version: 9 }));
      assert.deepStrictEqual(await range(saved), [[6, 0, 6, 22]]);
      // The signature edited in place after its first word: the start stays, the end (other text
      // before it) goes to the start.
      assert.deepStrictEqual(await range(saved.replace('vlen : Vect n a -> Nat', 'vlen : Vect n a -> Integer')), [[6, 0, 6, 0]]);
      // The signature's line split in two: no line of it is known any more; with no other entry, why.
      await assert.rejects(range(saved.replace('vlen : Vect n a -> Nat', 'vlen : Vect n a ->\n  Nat')), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'Unsupported');
        assert.strictEqual(
          e.message,
          'The definition of vlen is in /w/broken/Clean.idr, on lines changed since the compiler read it: save that file and check it again to find it.',
        );
        return true;
      });
    });

    test('definition in another file: its range read from disk, moved to the text of its open document (fourth review of M3)', async () => {
      const t = setup({ readFile: (p) => Promise.resolve(p.endsWith('/Lib.idr') ? 'module Lib\n\nexport\nhelper : Nat\nhelper = 1\n' : 'module M\n\nimport Lib\n\nx : Nat\nx = helper\n') });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/two' });
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        return Promise.resolve(
          text.startsWith('(:load-file') ? answer('(:ok ())') : answer('(:ok (("Lib.helper" (:filename "/w/two/Lib.idr") (:start 3 0) (:end 3 12))))'),
        );
      };
      let shown: string | undefined = '-- a note\nmodule Lib\n\nexport\nhelper : Nat\nhelper = 1\n';
      t.deps.openText = (file) => (file === '/w/two/Lib.idr' ? shown : undefined);
      const m = doc('/w/two/M.idr', { text: 'module M\n\nimport Lib\n\nx : Nat\nx = helper\n' });
      await t.backend.load(m);
      const range = async (): Promise<number[]> => plainRange(((await t.backend.definition(m, pos(5, 5), 'helper', 'function')) as unknown as Location[])[0].range);
      assert.deepStrictEqual(await range(), [4, 0, 4, 12], 'its open document has a line inserted above');
      shown = undefined;
      assert.deepStrictEqual(await range(), [3, 0, 3, 12], 'no document open: as read');
      // A lone \r above it on disk, which the open document shows as a line break (fifth review of
      // M3): the compiler's line 2 is the document's line 3.
      t.deps.readFile = (p) => Promise.resolve(p.endsWith('/Lib.idr') ? 'module Lib\n-- a\rb\nhelper : Nat\nhelper = 1\n' : '');
      shown = 'module Lib\n-- a\nb\nhelper : Nat\nhelper = 1\n';
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        return Promise.resolve(
          text.startsWith('(:load-file') ? answer('(:ok ())') : answer('(:ok (("Lib.helper" (:filename "/w/two/Lib.idr") (:start 2 0) (:end 2 12))))'),
        );
      };
      await t.backend.load(m);
      assert.deepStrictEqual(await range(), [3, 0, 3, 12]);
      // Not open: VS Code will open it with the \r as a line break too (sixth review of M3: the range
      // stayed on the compiler's line 2, one line too high).
      shown = undefined;
      assert.deepStrictEqual(await range(), [3, 0, 3, 12], 'not open');
    });

    test('definition in the loaded file: converted with the text the load read, not the file on disk, and moved to the text shown (fifth review of M3)', async () => {
      // With the manual trigger a save checks nothing: the file on disk and the document show a line
      // inserted at the top, and the compiler's span describes the text before it. Converted with the
      // file on disk, F12 landed a line too high, and after an undo back to the loaded text two lines
      // too high; and the result depended on whether F12 had been used before the save (the first
      // read of the file is kept per load) [unit-level, the reviewer's probes].
      const loadedText = 'module M\n\narea : Nat -> Nat\narea x = x\n\nmain : IO ()\nmain = printLn (area 1)\n';
      const savedText = `-- a note\n${loadedText}`;
      let disk = loadedText;
      const t = setup({ readFile: () => Promise.resolve(disk) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/m' });
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        return Promise.resolve(
          text.startsWith('(:load-file') ? answer('(:ok ())') : answer('(:ok (("M.area" (:filename "/w/m/M.idr") (:start 2 0) (:end 3 10))))'),
        );
      };
      await t.backend.load(doc('/w/m/M.idr', { text: loadedText }));
      disk = savedText;
      t.deps.openText = (file) => (file === '/w/m/M.idr' ? savedText : undefined);
      const range = async (text: string, version: number, isDirty = false): Promise<number[]> =>
        plainRange(((await t.backend.definition(doc('/w/m/M.idr', { text, version, isDirty }), pos(0, 0), 'area', 'function')) as unknown as Location[])[0].range);
      assert.deepStrictEqual(await range(savedText, 8), [3, 0, 4, 10], 'saved, not checked: where area is shown');
      assert.deepStrictEqual(await range(loadedText, 9, true), [2, 0, 3, 10], 'undone back to the loaded text (unsaved)');
    });

    test('a lone \\r in the file: the compiler\'s lines break at \\n only; below it a position is asked about and a range shown where it is (fifth review of M3)', async () => {
      // idris2 --check on `module M\n-- a\r-- b\nx : Nat\nx = "s"\n` reported M:4:5--4:8 [live, idris2
      // 0.8.0]; VS Code breaks lines at the \r too, and shows the file's lines joined by one line
      // break. Split at the \r as well, the loaded text put x on the line above the one asked about.
      const disk = 'module M\n-- a\rb\narea : Nat -> Nat\narea x = x\n';
      const t = setup({ readFile: () => Promise.resolve(disk) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/cr' });
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        if (text.startsWith('(:load-file')) {
          return Promise.resolve(answer('(:ok ())'));
        }
        if (text === '(:type-of "x" 4 5)') {
          return Promise.resolve(answer('(:ok "x : Nat" ())'));
        }
        return Promise.resolve(text === '(:name-at "area")' ? answer('(:ok (("M.area" (:filename "/w/cr/M.idr") (:start 2 0) (:end 3 10))))') : undefinedName(text));
      };
      const shown = doc('/w/cr/M.idr', { text: 'module M\n-- a\nb\narea : Nat -> Nat\narea x = x\n' });
      await t.backend.load(shown);
      assert.strictEqual((await t.backend.typeAt(shown, pos(4, 5), 'x', 'bound'))?.text, 'x : Nat');
      assert.deepStrictEqual(commands(session).filter((c) => c.startsWith('(:type-of')), ['(:type-of "x" 4 5)']);
      const [area] = (await t.backend.definition(shown, pos(3, 0), 'area', 'function')) as unknown as Location[];
      assert.deepStrictEqual(plainRange(area.range), [3, 0, 4, 10]);
    });

    test('a definition starting on the line that holds a lone \\r: found, in the loaded file and in another file, open or not (seventh review of M3)', async () => {
      // [live, idris2 0.8.0, the verifier] this file loads, and (:name-at "area") answers (:start 2 0)
      // (:end 3 10). Diffed with the editor's lines, the compiler's line holding the \r was never
      // paired: F12 was refused as "on lines changed since the compiler read it", also for a file
      // that is not open, where there is nothing to save.
      const disk = 'module M\n\narea : Nat -> Nat -- a\r-- b\narea x = x\n\ng : Nat -> Nat\ng y = y -- c\r-- d\n';
      const lib = 'module Lib\n\nhelper : Nat -- a\r-- b\nhelper = 1\n';
      const t = setup({ readFile: (p) => Promise.resolve(p.endsWith('/Lib.idr') ? lib : disk) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/cr' });
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        if (text.startsWith('(:load-file')) {
          return Promise.resolve(answer('(:ok ())'));
        }
        if (text === '(:type-of "y" 7 6)') {
          return Promise.resolve(answer('(:ok "y : Nat" ())'));
        }
        if (text === '(:name-at "area")') {
          return Promise.resolve(answer('(:ok (("M.area" (:filename "/w/cr/M.idr") (:start 2 0) (:end 3 10))))'));
        }
        return Promise.resolve(text === '(:name-at "helper")' ? answer('(:ok (("Lib.helper" (:filename "/w/cr/Lib.idr") (:start 2 0) (:end 2 12))))') : undefinedName(text));
      };
      const shown = doc('/w/cr/M.idr', { text: 'module M\n\narea : Nat -> Nat -- a\n-- b\narea x = x\n\ng : Nat -> Nat\ng y = y -- c\n-- d\n' });
      await t.backend.load(shown);
      const found = async (name: string): Promise<number[][]> =>
        ((await t.backend.definition(shown, pos(4, 0), name, 'function')) as unknown as Location[]).map((l) => plainRange(l.range));
      assert.deepStrictEqual(await found('area'), [[2, 0, 4, 10]], 'the loaded file: its end one line further down, after the \\r');
      // The variable on the line holding the \r (the editor's line 7, the compiler's 6: 7 1-based), as
      // the verifier asked it live.
      assert.strictEqual((await t.backend.typeAt(shown, pos(7, 6), 'y', 'bound'))?.text, 'y : Nat');
      assert.ok(commands(session).includes('(:type-of "y" 7 6)'));
      t.deps.openText = () => undefined;
      assert.deepStrictEqual(await found('helper'), [[2, 0, 2, 12]], 'another file, not open');
      t.deps.openText = (file) => (file === '/w/cr/Lib.idr' ? 'module Lib\n\nhelper : Nat -- a\n-- b\nhelper = 1\n' : undefined);
      assert.deepStrictEqual(await found('helper'), [[2, 0, 2, 12]], 'another file, open: the same text but for its line breaks');
      // Its line edited, unsaved: refused, and the reason says why (not "since the compiler read it").
      t.deps.openText = (file) => (file === '/w/cr/Lib.idr' ? 'module Lib\n\nhelper :\n  Nat -- a\n-- b\nhelper = 2\n' : undefined);
      await assert.rejects(found('helper'), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'Unsupported');
        assert.strictEqual(e.message, 'The definition of helper is in /w/cr/Lib.idr, on lines with unsaved changes: save that file and check it again to find it.');
        return true;
      });
    });

    test('definition: the namespace of the occurrence\'s token keeps the definitions in it; none matching, or none given, keeps all (fourth review of M3)', async () => {
      // `(:name-at "length")` in a file importing Data.Vect, where `Prelude.List.length xs` is
      // highlighted with (:namespace "Prelude.Types.List") [live, idris2 0.8.0, fourth review of M3].
      const t = setup({ readFile: () => Promise.resolve('') });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/ops' });
      const lib = '/opt/homebrew/Cellar/idris2/0.8.0_2/libexec/idris2-0.8.0';
      const lengths =
        `(:ok (("Data.List1.length" (:filename "${lib}/base-0.8.0/Data/List1.idr") (:start 68 0) (:end 69 23)) ` +
        `("Prelude.Types.List.length" (:filename "${lib}/prelude-0.8.0/Prelude/Types.idr") (:start 527 2) (:end 529 24)) ` +
        `("Prelude.Types.SnocList.length" (:filename "${lib}/prelude-0.8.0/Prelude/Types.idr") (:start 428 2) (:end 429 28)) ` +
        `("Prelude.Types.String.length" (:filename "${lib}/prelude-0.8.0/Prelude/Types.idr") (:start 789 2) (:end 798 24)) ` +
        `("Data.Vect.length" (:filename "${lib}/base-0.8.0/Data/Vect.idr") (:start 25 0) (:end 26 36))))`;
      // The recorded answer for `::` (transcript clean-queries).
      const conses = recordedExchanges('clean-queries', '/w/ops').find((x) => x.request.includes('(:name-at "::")'));
      assert.ok(conses !== undefined);
      session.next = (command) => {
        const text = command.kind === 'raw' ? command.text : serializeSexp(command);
        return Promise.resolve(text.startsWith('(:load-file') ? answer('(:ok ())') : text === '(:name-at "length")' ? answer(lengths) : conses.reply);
      };
      const opsDoc = doc('/w/ops/Ops.idr');
      await t.backend.load(opsDoc);
      const found = async (name: string, namespace?: string) =>
        ((await t.backend.definition(opsDoc, pos(5, 7), name, 'function', namespace)) as unknown as Location[]).map((l) => `${path.basename(l.uri.fsPath)} ${l.range.start.line}`);
      assert.deepStrictEqual(await found('length', 'Prelude.Types.List'), ['Types.idr 527']);
      assert.deepStrictEqual(await found('length', 'Data.Vect'), ['Vect.idr 25']);
      assert.strictEqual((await found('length', 'Some.Other')).length, 5, 'none in that namespace: all');
      assert.strictEqual((await found('length')).length, 5, 'no namespace (a declaring occurrence): all');
      // An operator's entry is named with its parentheses.
      assert.deepStrictEqual(await found('::', 'Data.Vect'), ['Vect.idr 18']);
    });

    test('a byte order mark: dropped before the reply positions are converted, as the compiler drops it (fourth review of M3)', async () => {
      // [live, idris2 0.8.0, fourth review of M3] L.lidr is EF BB BF, "> ", "> module L", "", "> g : Nat -> Nat",
      // "> g y = y": line 0 is doubled (the mark dropped), so `module` is on compiler line 2 and
      // `(:name-at "g")` answers (4 0)-(4 14).
      const text = '\uFEFF> \n> module L\n\n> g : Nat -> Nat\n> g y = y\n';
      const t = setup({ readFile: () => Promise.resolve(text) });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/bom' });
      const frame = (line: number, start: number, end: number, props: string): IdeMessage => {
        const decoded = ideCodec.decodeMessage(`(:output (:ok (:highlight-source ((((:filename "L.lidr") (:start ${line} ${start}) (:end ${line} ${end})) (${props}))))) 1)`);
        assert.ok(decoded.kind === 'message');
        return decoded.message;
      };
      const warning = ideCodec.decodeMessage('(:warning ("L.lidr" (5 6) (5 7) "A warning on y." ()) 1)');
      assert.ok(warning.kind === 'message');
      session.next = (command) => {
        const sent = command.kind === 'raw' ? command.text : serializeSexp(command);
        if (sent.startsWith('(:load-file')) {
          const load = answer('(:ok ())');
          return Promise.resolve({ ...load, messages: [frame(2, 0, 6, '(:decor :keyword)'), frame(5, 2, 3, '(:name "y") (:namespace "") (:decor :bound)'), warning.message] });
        }
        return Promise.resolve(answer('(:ok (("L.g" (:filename "/w/bom/L.lidr") (:start 4 0) (:end 4 14))))'));
      };
      const lit = doc('/w/bom/L.lidr', { languageId: 'lidr', text: text.slice(1) });
      const result = await t.backend.load(lit);
      const tokens = t.backend.tokens(lit)?.tokens.map((k) => [k.decor, ...plainRange(k.range as unknown as Range)]);
      assert.deepStrictEqual(tokens, [['keyword', 1, 2, 1, 8], ['bound', 4, 4, 4, 5]], 'module on file line 1 after its marker; y on line 4');
      assert.deepStrictEqual(plainRange((result.diagnostics[0][1][0] as unknown as Diagnostic).range), [4, 8, 4, 9], 'the warning on the second y');
      const [g] = (await t.backend.definition(lit, pos(4, 2), 'g')) as unknown as Location[];
      assert.deepStrictEqual(plainRange(g.range), [3, 2, 3, 16]);
      // A .idr with a byte order mark and an astral character on line 0: the end of a span after it.
      const idr = '\uFEFFmodule B -- \u{1D55F}\n';
      const u = setup({ readFile: () => Promise.resolve(idr) });
      const bSession = u.pool.sessionFor({ kind: 'loose', dir: '/w/b' });
      bSession.next = () => {
        const decoded = ideCodec.decodeMessage('(:output (:ok (:highlight-source ((((:filename "B.idr") (:start 0 9) (:end 0 13)) ((:decor :comment)))))) 1)');
        assert.ok(decoded.kind === 'message');
        return Promise.resolve({ ...answer('(:ok ())'), messages: [decoded.message] });
      };
      const bDoc = doc('/w/b/B.idr', { text: idr.slice(1) });
      await u.backend.load(bDoc);
      assert.deepStrictEqual(u.backend.tokens(bDoc)?.tokens.map((k) => plainRange(k.range as unknown as Range)), [[0, 9, 0, 14]], 'the comment ends after the two units of U+1D55F');
    });

    test('definition in a .lidr: :name-at answers unlit columns (F11), moved by the bird track of the target line', async () => {
      const t = setup({ readFile: fixtureFile });
      const session = t.pool.sessionFor({ kind: 'loose', dir: '/w/loose-file' });
      session.next = replaying('lit-lookups', '/w/loose-file');
      const litDoc = doc('/w/loose-file/Lit.lidr', { languageId: 'lidr', text: fixtureText('loose-file/Lit.lidr') });
      await t.backend.load(litDoc);
      const [double] = (await t.backend.definition(litDoc, pos(4, 3), 'double')) as unknown as Location[];
      assert.deepStrictEqual(plainRange(double.range), [4, 2, 4, 21]);
      // Below the `> ` and `>   ` lines the compiler's lines are one and two further (F11 addendum):
      // `(:name-at "bump")` answers (12 0)–(12 17), file line 10.
      const [bump] = (await t.backend.definition(litDoc, pos(11, 3), 'bump')) as unknown as Location[];
      assert.deepStrictEqual(plainRange(bump.range), [10, 2, 10, 19]);
    });

    test('completions: the run the compiler completes is sent, the answer filtered by the root typed and without repeats', async () => {
      const t = await loaded('clean-queries');
      assert.deepStrictEqual(await t.backend.completions(cleanDoc(), 'vl'), ['vlen_rhs', 'vlen']);
      // `vlen_r`: the compiler cannot complete past `_`, so `vlen` is sent and the answer filtered.
      assert.deepStrictEqual(await t.backend.completions(cleanDoc(), 'vlen_r'), ['vlen_rhs']);
      // Nothing it could complete: nothing sent.
      assert.deepStrictEqual(await t.backend.completions(cleanDoc(), '_x'), []);
      assert.deepStrictEqual(await t.backend.completions(cleanDoc(), ''), []);
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:repl-completions "vl")', '(:repl-completions "vlen")']);
      // A qualified prefix: the compiler ignores namespaces, so only the root is sent.
      t.session.next = replaying('clean-queries', '/private/w/broken', { '(:repl-completions "V")': recordedExchanges('clean-queries', '/r')[13].reply });
      assert.deepStrictEqual(await t.backend.completions(cleanDoc(), 'Data.V'), ['Vect', 'Void', 'View']);
      assert.strictEqual(commands(t.session).at(-1), '(:repl-completions "V")');
      const project = projectRoot({ dir: '/w/simple-ipkg', ipkgPath: '/w/simple-ipkg/simple.ipkg' });
      const simple = setup({ readFile: fixtureFile, roots: { '/w/simple-ipkg/src/Foo/B.idr': project } });
      const s = simple.pool.sessionFor(project);
      s.next = replaying('simple-ipkg-lookups', '/w/simple-ipkg');
      const b = doc('/w/simple-ipkg/src/Foo/B.idr');
      await simple.backend.load(b);
      assert.deepStrictEqual(await simple.backend.completions(b, 'sh'), ['shout', 'show', 'showPrec', 'showParens', 'showCon', 'showArg']);
    });

    test('warmUpCompletions: one :repl-completions after each load of the loaded file, none after a completion; nothing when not loaded; never rejects', async () => {
      const t = await loaded('clean-queries');
      await t.ide.warmUpCompletions(cleanDoc());
      await t.ide.warmUpCompletions(cleanDoc());
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:repl-completions "zq")']);
      await t.ide.warmUpCompletions(doc('/w/broken/Bad.idr'));
      assert.strictEqual(t.session.requests.length, 2);
      await t.backend.load(cleanDoc({ version: 8 }));
      await t.backend.completions(cleanDoc(), 'vl');
      await t.ide.warmUpCompletions(cleanDoc());
      assert.deepStrictEqual(commands(t.session).slice(3), ['(:repl-completions "vl")']);
      await t.backend.load(cleanDoc({ version: 9 }));
      t.session.next = () => Promise.reject(new IdrisException({ kind: 'RequestTimeout', message: 'too slow' }));
      await t.ide.warmUpCompletions(cleanDoc());
      assert.strictEqual(commands(t.session).at(-1), '(:repl-completions "zq")');
    });

    test('warmUpCompletions waits until the session has been idle for WARM_UP_QUIET_MS: a query right after the load goes first (third review of M3)', async () => {
      const t = await loaded('clean-queries');
      t.clock.time = 1_000;
      t.pool.move(t.session, 'ready', 'reply'); // the load's answer
      let warmed = false;
      const warm = t.ide.warmUpCompletions(cleanDoc()).then(() => (warmed = true));
      await settle();
      assert.deepStrictEqual(commands(t.session).slice(1), [], 'nothing at once');
      // A hover right after the load: sent before the warm-up, and its answer keeps the session busy.
      await t.backend.typeAt(cleanDoc(), pos(7, 5), 'xs', 'bound');
      t.clock.time = 1_100;
      t.pool.move(t.session, 'busy', 'dispatch');
      t.pool.move(t.session, 'ready', 'reply');
      t.clock.fire();
      await settle();
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:type-of "xs" 8 5)'], 'not yet idle for WARM_UP_QUIET_MS');
      t.clock.time = 1_100 + WARM_UP_QUIET_MS;
      t.clock.fire();
      await warm;
      assert.ok(warmed);
      assert.deepStrictEqual(commands(t.session).slice(1), ['(:type-of "xs" 8 5)', '(:repl-completions "zq")']);
    });

    test('warmUpCompletions: nothing when the session was never idle within WARM_UP_MAX_WAIT_MS, or loaded another file meanwhile', async () => {
      const t = await loaded('clean-queries');
      let release: () => void = () => undefined;
      const replay = t.session.next;
      t.session.next = (command) => (command.kind === 'raw' ? new Promise<Reply>((resolve) => (release = () => void replay(command).then(resolve))) : replay(command));
      const busy = t.ide.sendRaw({ kind: 'loose', dir: '/w/broken' }, '(:version)');
      await settle();
      assert.strictEqual(t.session.idle, false);
      let done = false;
      const warm = t.ide.warmUpCompletions(cleanDoc()).then(() => (done = true));
      await settle();
      let waits = 0;
      for (; !done && waits <= 2 * (WARM_UP_MAX_WAIT_MS / WARM_UP_QUIET_MS); waits++) {
        t.clock.time += WARM_UP_QUIET_MS;
        t.clock.fire();
        await settle();
      }
      await warm;
      assert.strictEqual(waits, Math.ceil(WARM_UP_MAX_WAIT_MS / WARM_UP_QUIET_MS), 'it gave up after the limit');
      release();
      await busy;
      assert.ok(!commands(t.session).includes('(:repl-completions "zq")'));
      // Idle again but just changed; while it waits for quiet, another file is loaded: nothing is warmed for Clean.idr.
      t.pool.move(t.session, 'ready', 'reply');
      const other = t.ide.warmUpCompletions(cleanDoc());
      await settle();
      t.session.loadedFile = { path: '/private/w/broken/Bad.idr', version: 1 };
      t.clock.time += WARM_UP_QUIET_MS;
      t.clock.fire();
      await other;
      assert.ok(!commands(t.session).includes('(:repl-completions "zq")'));
    });

    test('browseNamespace: one entry per line, the multiplicity of a hole dropped from its name; [] for an empty listing', async () => {
      const t = await loaded('clean-queries');
      const vect = await t.backend.browseNamespace(cleanDoc(), 'Data.Vect');
      assert.strictEqual(vect.length, 84);
      assert.deepStrictEqual(vect.slice(0, 3).map((e) => e.name), ['(++)', '(::)', 'Nil']);
      const [hole] = await t.backend.browseNamespace(cleanDoc(), 'Clean');
      assert.strictEqual(hole.name, 'vlen_rhs');
      assert.strictEqual(hole.signature.text, '1 vlen_rhs : (0 a : Type) -> (0 n : Nat) -> Vect n a -> Nat');
      assert.deepStrictEqual(hole.signature.spans.slice(0, 2), [{ start: 0, length: 1, decor: 'keyword' }, { start: 2, length: 8, decor: 'function' }]);
      assert.deepStrictEqual(await t.backend.browseNamespace(cleanDoc(), 'Nope.Nothing'), []);
      // Offsets are per entry.
      const [second] = vect.slice(1, 2);
      assert.ok(second.signature.spans.every((span) => span.start + span.length <= second.signature.text.length));
      // A line starting with white space would continue the previous entry (not observed on 0.8.0).
      t.session.next = () => Promise.resolve({ id: 1n, payload: { kind: 'ok', result: { kind: 'string', value: 'a : Nat ->\n  Nat\nb : Nat' }, highlighting: [] }, messages: [] });
      assert.deepStrictEqual((await t.backend.browseNamespace(cleanDoc(), 'X')).map((e) => [e.name, e.signature.text]), [['a', 'a : Nat ->\n  Nat'], ['b', 'b : Nat']]);
    });
  });

  suite('evaluate: expressions only, in the eval session', () => {
    test('a REPL command is refused before anything is classified, started or sent (ROADMAP §9)', async () => {
      const t = setup({ readFile: fixtureFile, projects: { classify: () => assert.fail('classified'), sessionCwd: (r) => r.dir } });
      for (const text of [':exec putStrLn "hi"', '  :set eval execute', '{- c -}\n:sh rm -rf x', '​:q']) {
        await assert.rejects(t.backend.evaluate(cleanDoc(), text), (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported' && /^Not evaluated: /.test(e.message));
      }
      await assert.rejects(t.backend.evaluate(cleanDoc(), 'f "\u0000"'), /NUL/);
      assert.strictEqual(t.pool.list.length, 0);
    });

    test('the eval session loads the file, then interprets; values, errors and the IO action (shown, not run); the check session is untouched', async () => {
      const t = setup({ readFile: fixtureFile });
      const check = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      evalSession.next = replaying('eval-values', '/private/w/broken');
      assert.deepStrictEqual(await t.backend.evaluate(cleanDoc(), 'the (Vect 2 Nat) [1, 2]'), {
        kind: 'value',
        value: { text: '[1, 2]', spans: [{ start: 1, length: 1, decor: 'data' }, { start: 4, length: 1, decor: 'data' }] },
      });
      const io = await t.backend.evaluate(cleanDoc(), 'the (IO ()) (putStrLn "hi")');
      assert.deepStrictEqual(io.kind === 'value' && io.value.text, 'MkIO (prim__putStr "hi\\n")');
      const bare = await t.backend.evaluate(cleanDoc(), 'putStrLn "hi"');
      assert.ok(bare.kind === 'error' && bare.message.text.startsWith("Error: Can't find an implementation for HasIO ?io."));
      const load = '(:load-file "/private/w/broken/Clean.idr")';
      assert.deepStrictEqual(commands(evalSession), [
        load,
        '(:interpret "the (Vect 2 Nat) [1, 2]")',
        load,
        '(:interpret "the (IO ()) (putStrLn \\"hi\\")")',
        load,
        '(:interpret "putStrLn \\"hi\\"")',
      ]);
      assert.deepStrictEqual(evalSession.requests.map((r) => r.options.kind), ['load', 'longAction', 'load', 'longAction', 'load', 'longAction']);
      assert.strictEqual(check.asked, 0, 'nothing reached the check session');
      // The walk before each of the eval session's loads, twice, as for a check (the package it would adopt).
      assert.deepStrictEqual(t.searched, Array(6).fill('/private/w/broken'));
    });

    test('the file is loaded before every evaluation, also when the session loaded it last at the same version (an import may have changed on disk)', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      evalSession.next = replaying('eval-values', '/private/w/broken');
      await t.backend.evaluate(cleanDoc(), 'vlen');
      await t.backend.evaluate(cleanDoc(), 'vlen');
      await t.backend.evaluate(cleanDoc({ version: 8, isDirty: true }), 'vlen');
      assert.deepStrictEqual(commands(evalSession).map((c) => c.split(' ')[0]), [
        '(:load-file', '(:interpret', '(:load-file', '(:interpret', '(:load-file', '(:interpret',
      ]);
    });

    test('a file that does not load: LoadFailed with its first error; the next evaluation loads again', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      evalSession.next = replaying('load-bad', '/private/w/broken');
      const bad = doc('/w/broken/Bad.idr');
      for (let i = 0; i < 2; i++) {
        await assert.rejects(t.backend.evaluate(bad, 'f'), (e: unknown) => {
          assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
          assert.match(e.message, /^Not evaluated: Bad\.idr does not compile \(Bad\.idr: While processing right hand side of f\./);
          return true;
        });
      }
      assert.deepStrictEqual(commands(evalSession), ['(:load-file "/private/w/broken/Bad.idr")', '(:load-file "/private/w/broken/Bad.idr")']);
    });

    test('the compiler\'s line in the message of a file that does not load is one line with its invisible characters written out', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      evalSession.next = () =>
        Promise.resolve({
          id: 1n,
          payload: { kind: 'error', message: 'Error: 1 error', highlighting: [] },
          messages: [
            { kind: 'warning', id: 1n, warning: { file: 'Bad.idr', span: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } }, message: 'Undefined name x\u202Ey.\n\nBad.idr:1:1--1:2', highlighting: [] } },
          ],
        } as Reply);
      await assert.rejects(t.backend.evaluate(doc('/w/broken/Bad.idr'), 'f'), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'LoadFailed');
        assert.strictEqual(e.message, 'Not evaluated: Bad.idr does not compile (Bad.idr: Undefined name x\\u{202E}y.). Evaluation needs the file to load.');
        return true;
      });
    });

    test('one evaluation at a time per eval session: a load and its :interpret are never separated by another file\'s load', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      evalSession.next = replaying('eval-values', '/private/w/broken', {
        '(:load-file "/private/w/broken/Plain.idr")': recordedExchanges('plain', '/private/w/broken')[0].reply,
      });
      await Promise.all([t.backend.evaluate(cleanDoc(), 'vlen'), t.backend.evaluate(doc('/w/broken/Plain.idr'), 'f 1'), t.backend.evaluate(cleanDoc(), 'nope')]);
      assert.deepStrictEqual(commands(evalSession), [
        '(:load-file "/private/w/broken/Clean.idr")',
        '(:interpret "vlen")',
        '(:load-file "/private/w/broken/Plain.idr")',
        '(:interpret "f 1")',
        '(:load-file "/private/w/broken/Clean.idr")',
        '(:interpret "nope")',
      ]);
    });

    test('the :interpret is queued with the load, before its reply, under idris2.eval.timeout; its check waits for the load', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const replay = replaying('eval-values', '/private/w/broken');
      const asked: string[] = [];
      const request = evalSession.request.bind(evalSession);
      evalSession.request = (command, options) => {
        asked.push(command.kind === 'raw' ? command.text : serializeSexp(command));
        return request(command, options);
      };
      evalSession.next = async (command) => {
        if (command.kind !== 'raw' && serializeSexp(command).startsWith('(:load-file')) {
          await gate;
        }
        return replay(command);
      };
      const evaluation = t.backend.evaluate(cleanDoc(), 'vlen');
      await settle();
      assert.deepStrictEqual(asked, ['(:load-file "/private/w/broken/Clean.idr")', '(:interpret "vlen")'], 'both queued while the load runs');
      assert.deepStrictEqual(commands(evalSession), ['(:load-file "/private/w/broken/Clean.idr")'], 'the :interpret not sent before the reply');
      open();
      assert.strictEqual((await evaluation).kind, 'value');
      assert.deepStrictEqual(evalSession.requests.map((r) => [r.options.kind, r.options.timeoutMs]), [['load', undefined], ['longAction', 10_000]]);
    });

    test('the session no longer having the load when the :interpret is to be sent: BackendCrashed, nothing evaluated, no second attempt', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      evalSession.next = replaying('eval-values', '/private/w/broken');
      // Right before the :interpret's check, once the load has answered, the load is gone.
      const request = evalSession.request.bind(evalSession);
      evalSession.request = (command, options) =>
        command.kind !== 'raw' && serializeSexp(command).startsWith('(:interpret')
          ? request(command, {
              ...options,
              beforeSend: async () => {
                while (evalSession.loadedFile === undefined) {
                  await new Promise((resolve) => setImmediate(resolve));
                }
                evalSession.loadedFile = undefined;
                await options.beforeSend?.();
              },
            })
          : request(command, options);
      await assert.rejects(t.backend.evaluate(cleanDoc(), 'vlen'), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'BackendCrashed');
        assert.match(e.message, /no longer had the file loaded/);
        return true;
      });
      assert.deepStrictEqual(commands(evalSession), ['(:load-file "/private/w/broken/Clean.idr")']);
    });

    test('an :interpret over its time limit: RequestTimeout naming idris2.eval.timeout; a failed session says how to start it again', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      const replay = replaying('eval-values', '/private/w/broken');
      evalSession.next = (command) =>
        command.kind !== 'raw' && serializeSexp(command).startsWith('(:interpret')
          ? Promise.reject(new IdrisException({ kind: 'RequestTimeout', message: ':interpret did not answer within 10 s; the Idris 2 process was stopped.' }))
          : replay(command);
      await assert.rejects(t.backend.evaluate(cleanDoc(), 'loop 0'), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'RequestTimeout');
        assert.strictEqual(
          e.message,
          'Not evaluated: the evaluation did not finish within 10 s (idris2.eval.timeout), so its compiler process was stopped; it starts again at the next evaluation.',
        );
        return true;
      });
      evalSession.state = 'failed';
      evalSession.next = () => Promise.reject(new IdrisException({ kind: 'BackendCrashed', message: 'The Idris 2 session has failed: it could not be started.' }));
      await assert.rejects(t.backend.evaluate(cleanDoc(), 'vlen'), (e: unknown) => {
        assert.ok(e instanceof IdrisException && e.error.kind === 'BackendCrashed');
        assert.strictEqual(e.message, 'The Idris 2 session has failed: it could not be started. After Idris 2: Restart Backend, the next evaluation starts the evaluation session again.');
        return true;
      });
    });

    test('an evaluation whose :interpret took more than a second stops the eval session afterwards (the memory it kept); a quicker one does not', async () => {
      // Second review of M3: after a 4.6–6.3 s evaluation the process stayed at about 700 MiB.
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      const replay = replaying('eval-values', '/private/w/broken');
      let interpretMs = 0;
      evalSession.next = async (command) => {
        const reply = await replay(command);
        if (command.kind !== 'raw' && serializeSexp(command).startsWith('(:interpret')) {
          t.clock.time += interpretMs;
        }
        return reply;
      };
      interpretMs = 1_000;
      assert.strictEqual((await t.backend.evaluate(cleanDoc(), 'vlen')).kind, 'value');
      assert.deepStrictEqual(t.pool.calls, [], 'a second: kept');
      interpretMs = 1_001;
      const slow = await t.backend.evaluate(cleanDoc(), 'the (Vect 2 Nat) [1, 2]');
      assert.strictEqual(slow.kind, 'value', 'the answer is still given');
      assert.deepStrictEqual(t.pool.calls, [
        'releaseEvaluation /w/broken: the evaluation took 1 s, so the evaluation session is stopped to give back the memory it kept; it starts again at the next evaluation',
      ]);
      // An error answer that took long releases it too; the load before it does not count.
      interpretMs = 5_000;
      assert.strictEqual((await t.backend.evaluate(cleanDoc(), 'nope')).kind, 'error');
      assert.strictEqual(t.pool.calls.length, 2);
    });

    test('cancelling: the eval session is stopped (IDE mode has no cancel); a cancellation before the evaluation started sends nothing', async () => {
      const t = setup({ readFile: fixtureFile });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      const replay = replaying('eval-values', '/private/w/broken');
      let stop: (error: Error) => void = () => undefined;
      evalSession.next = (command) =>
        command.kind !== 'raw' && serializeSexp(command).startsWith('(:interpret') ? new Promise<Reply>((_resolve, reject) => (stop = reject)) : replay(command);
      const token = new CancellationSource();
      const evaluation = t.backend.evaluate(cleanDoc(), 'loop 0', token.token);
      await settle();
      assert.deepStrictEqual(t.pool.calls, []);
      token.cancel();
      assert.deepStrictEqual(t.pool.calls, ['cancelEvaluation /w/broken']);
      // What the pool's stop does to the request in flight.
      stop(cancelled('The Idris 2 session was stopped (Evaluate Selection was cancelled).'));
      await assert.rejects(evaluation, (e: unknown) => isCancelled(e));
      // Cancelled already: nothing is sent, nothing stopped.
      const before = evalSession.asked;
      await assert.rejects(t.backend.evaluate(cleanDoc(), 'vlen', token.token), (e: unknown) => isCancelled(e));
      assert.strictEqual(evalSession.asked, before);
      assert.deepStrictEqual(t.pool.calls, ['cancelEvaluation /w/broken']);
      // A later cancellation of a finished evaluation stops nothing.
      const later = new CancellationSource();
      evalSession.next = replay;
      assert.strictEqual((await t.backend.evaluate(cleanDoc(), 'vlen', later.token)).kind, 'value');
      later.cancel();
      assert.deepStrictEqual(t.pool.calls, ['cancelEvaluation /w/broken']);
    });

    test('an eval process\'s start notes its directory too: its loads check it like the check session\'s', async () => {
      let identity = 'dev 1 ino 10';
      const t = setup({ readFile: fixtureFile, directoryId: () => Promise.resolve(identity) });
      const evalSession = t.pool.sessionFor({ kind: 'loose', dir: '/w/broken' }, 'eval');
      evalSession.launch = { executable: '/bin/idris2', args: [], cwd: '/w/broken', env: {}, transport: 'stdio' };
      t.pool.move(evalSession, 'starting', 'start');
      await settle();
      identity = 'dev 1 ino 11';
      evalSession.next = replaying('eval-values', '/private/w/broken');
      await assert.rejects(t.backend.evaluate(cleanDoc(), 'vlen'), /is not the one the compiler was started in/);
      assert.strictEqual(evalSession.requests.length, 0);
    });
  });
});

// -------------------------------------------------------------------------------------------
// M3: an evaluation with the real session pool (idris2.ideMode.maxSessions)
// -------------------------------------------------------------------------------------------

/** A transport that answers every request after a macrotask, as a process would: loads with `(:ok ())`, the rest with `"3"`. */
class AnsweringTransport extends FakeTransport {
  override send(bytes: Uint8Array): void {
    super.send(bytes);
    const request = this.lastSent();
    const head = request.command.kind === 'list' && request.command.items[0]?.kind === 'symbol' ? request.command.items[0].name : '';
    setImmediate(() => this.message(ret(request.id, head === 'load-file' ? ok() : ok(str('3')))));
  }
}

suite('backend/ide/backend M3: evaluation with the real session pool', () => {
  const A = '/w/a';
  const ROOT_A: Classification = { kind: 'loose', dir: A };

  function withPool(maxSessions: number) {
    const settings: IdeModeSettings = {
      transport: 'stdio',
      isolateBuildDir: true,
      loosePackages: [],
      extraArgs: [],
      requestTimeoutMs: 5_000,
      longActionTimeoutMs: 60_000,
      idleTimeoutMs: 600_000,
      maxSessions,
      maxBackgroundChecks: 0,
    };
    const config = {
      ideMode: () => settings,
      diagnostics: () => ({ includeSourceExcerpt: false }),
      evaluation: () => ({ inlineResults: true, timeoutMs: 10_000 }),
      onDidChange: () => ({ dispose: () => undefined }),
    };
    const allowed: GateVerdict = { allowed: true, basis: 'workspaceFolder' };
    const gate = { permit: () => Promise.resolve(allowed), current: () => allowed, recheck: () => Promise.resolve(allowed), onDidChange: new Emitter<void>().event };
    const transports: AnsweringTransport[] = [];
    const clock = new FakeClock();
    const pool = createTunedSessionPool(
      {
        toolchain: new FakeToolchain(snapshot()),
        projects: { sessionCwd: (r: Classification) => r.dir },
        config,
        trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
        gate,
        codec: jsonCodec,
        trace: new RecordingTrace(),
        log: recordingLog(),
        platform: 'darwin',
        processEnv: {},
      },
      {
        timing: DEFAULT_SESSION_TIMING,
        clock,
        createTransport: (launch) => {
          const transport = new AnsweringTransport(launch, {});
          transports.push(transport);
          return transport;
        },
      },
    );
    const ide = new IdeMode({
      pool,
      projects: { classify: (file: string) => Promise.resolve<Classification>({ kind: 'loose', dir: file.slice(0, file.lastIndexOf('/')) }), sessionCwd: (r) => r.dir },
      config,
      clock,
      gate,
      api,
      readFile: () => Promise.resolve('module A\n\nx : Nat\nx = 1\n'),
      realpath: (p) => Promise.resolve(p),
      findPackage: () => Promise.resolve(undefined),
      directoryId: (p) => Promise.resolve(`id ${p}`),
      platform: 'darwin',
      isOpen: () => true,
      openText: () => undefined,
    });
    const evalProcesses = () => transports.filter((t) => t.launch.args.some((arg) => arg.endsWith('.vscode-idris2-eval')));
    return { ide, pool, transports, evalProcesses };
  }

  for (const max of [1, 2, 0]) {
    test(`maxSessions ${max}, the active root's check session running: the evaluation answers, from one eval process`, async () => {
      // Before the fix, with a limit of 1 the eval session was idle between its load's reply and
      // the :interpret, was evicted, and the evaluation failed after three process starts (review of M3).
      const t = withPool(max);
      try {
        t.pool.setActiveRoot(ROOT_A);
        await t.ide.backendFor().load(doc(`${A}/A.idr`));
        const evaluation = await t.ide.backendFor().evaluate(doc(`${A}/A.idr`), '1 + 2');
        assert.deepStrictEqual(evaluation, { kind: 'value', value: { text: '3', spans: [] } });
        const [evalProcess, ...more] = t.evalProcesses();
        assert.deepStrictEqual(more, []);
        assert.deepStrictEqual(
          evalProcess.sent.map((r) => (r.command.kind === 'list' && r.command.items[0]?.kind === 'symbol' ? r.command.items[0].name : '?')),
          ['load-file', 'interpret'],
        );
        await flush();
        // Idle once answered: with a limit of 1, it is the one stopped, not the active root's check session.
        const check = t.pool.sessions().find((s) => s.role === 'check');
        const evalSession = t.pool.sessions().find((s) => s.role === 'eval');
        assert.deepStrictEqual([check?.state, evalSession?.state], ['ready', max === 1 ? 'stopped' : 'ready']);
      } finally {
        t.pool.dispose();
      }
    });
  }
});

suite('backend/ide/backend M4 (holes, edits)', () => {
  /**
   * Replays `scenario` for the requests the backend sends: the nth sending of a command gets its
   * nth recorded answer (the last one once they run out); an unrecorded command fails the test.
   */
  function inOrder(scenario: string | readonly string[], root: string): (command: IdeCommand) => Promise<Reply> {
    const exchanges = (typeof scenario === 'string' ? [scenario] : scenario).flatMap((name) => recordedExchanges(name, root));
    const sent = new Map<string, number>();
    return (command) => {
      const text = command.kind === 'raw' ? command.text : serializeSexp(command);
      const answers = exchanges.filter((x) => x.request.replace(/ \d+\)\n$/, '').slice(1) === text);
      const nth = sent.get(text) ?? 0;
      sent.set(text, nth + 1);
      return answers.length === 0 ? Promise.reject(new Error(`${scenario}: not recorded: ${text}`)) : Promise.resolve(answers[Math.min(nth, answers.length - 1)].reply);
    };
  }

  /** An IdeMode whose check session of `dir` replays `scenario`, with `file` loaded; `reads` lists the files read. */
  async function loadedFile(scenario: string | readonly string[], dir: string, file: string, replyHooks = false, open: (file: string) => boolean = () => false) {
    const reads: string[] = [];
    const disk = { changed: false };
    const t = setup({
      isOpen: (f: string) => open(f),
      readFile: async (p: string) => {
        reads.push(p);
        const text = await fixtureFile(p);
        return disk.changed ? `${text}-- changed on disk\n` : text;
      },
    });
    const root: Classification = { kind: 'loose', dir };
    const session = t.pool.sessionFor(root);
    session.next = inOrder(scenario, realpathOf(dir));
    session.replyHooks = replyHooks;
    // As a started process: replies name files by the directory's real path (`/private/w/broken`).
    session.launch = { executable: '/bin/idris2', args: [], cwd: dir, realCwd: realpathOf(dir), env: {}, transport: 'stdio' };
    const text = fixtureText(`${dir.replace(/^\/w\//, '')}/${file}`);
    const d = doc(`${dir}/${file}`, { text });
    await t.backend.load(d);
    return { ...t, session, root, d, text, reads, disk };
  }

  const kind = (e: unknown): string | undefined => (e instanceof IdrisException ? e.error.kind : isCancelled(e) ? 'Cancelled' : undefined);
  const rejectsWith = (p: Promise<unknown>, expected: string, pattern = /./): Promise<void> =>
    assert.rejects(p, (e: unknown) => kind(e) === expected && pattern.test((e as Error).message));

  /** Clean.idr's edits and its holes (`:metavariables`, `:name-at`: the requests the hole commands wait for). */
  const CLEAN = ['clean-editing', 'clean-lookups'];
  /** The commands sent but the loads and the holes' requests. */
  const editsSent = (session: { requests: { command: IdeCommand }[] }): string[] => commands(session).filter((c) => !/^\(:(load-file|metavariables|name-at) /.test(c));

  const caseSplitOf = (d: vscode.TextDocument, version = 7) =>
    ({ kind: 'caseSplit', doc: d, version, pos: pos(7, 0), name: 'xs' }) as const;

  test('holes: :metavariables, then :name-at per unqualified name; Base\'s todo and Main\'s told apart (E16); kept per load', async () => {
    const t = await loadedFile('holes-loose-main', '/w/holes', 'Main.idr');
    const readsAfterLoad = t.reads.length;
    const holes = await t.backend.holes(t.d);
    assert.deepStrictEqual(commands(t.session), ['(:load-file "/w/holes/Main.idr")', '(:metavariables 80)', '(:name-at "size_rhs")', '(:name-at "todo")']);
    assert.deepStrictEqual(t.session.requests.slice(1).map((r) => r.options.kind), ['longAction', 'longAction', 'longAction']);
    assert.deepStrictEqual(
      holes.map((h) => [h.qualifiedName, h.location?.uri.fsPath, h.location === undefined ? undefined : plainRange(h.location.range as unknown as Range)]),
      [
        ['Main.size_rhs', '/w/holes/Main.idr', [8, 7, 8, 16]],
        ['Base.todo', '/w/holes/Base.idr', [7, 15, 7, 20]],
        ['Main.todo', '/w/holes/Main.idr', [5, 11, 5, 16]],
      ],
    );
    assert.deepStrictEqual(holes[1].premises.map((p) => [p.name, p.multiplicity]), [['n', 0], ['a', 0], ['x', 1], ['xs', 'unrestricted']]);
    // The loaded file's text is the one the load read; the imported module's is read from disk once.
    assert.deepStrictEqual(t.reads.slice(readsAfterLoad), ['/w/holes/Base.idr']);
    assert.strictEqual(await t.backend.holes(t.d), holes);
    assert.strictEqual(t.session.requests.length, 4, 'kept per load');
    await rejectsWith(t.backend.holes(doc('/w/holes/Base.idr', { text: fixtureText('holes/Base.idr') })), 'NotLoaded');
  });

  test('a check load\'s holes are asked for when its reply arrives (its reply hook), urgent, the file\'s own names first; kept for the holes view when another file is loaded after it', async () => {
    const open = new Set(['/w/holes/Main.idr']);
    const t = await loadedFile('holes-loose-main', '/w/holes', 'Main.idr', true, (f) => open.has(f));
    await flush();
    assert.deepStrictEqual(commands(t.session), ['(:load-file "/w/holes/Main.idr")', '(:metavariables 80)', '(:name-at "size_rhs")', '(:name-at "todo")']);
    assert.ok(t.session.requests.slice(1).every((r) => (r.options as { urgent?: () => boolean }).urgent?.() === true), 'urgent');
    // Long actions: on large types they take seconds, and past their limit the restart is not counted towards giving up (UX review of M4).
    assert.deepStrictEqual(new Set(t.session.requests.slice(1).map((r) => r.options.kind)), new Set(['longAction']));
    // Base is loaded next (a batch of visible documents): Main's holes stay those of Main's load.
    await t.backend.load(doc('/w/holes/Base.idr', { text: fixtureText('holes/Base.idr') }));
    await flush();
    const asked = t.session.requests.length;
    const holes = await t.backend.holes(t.d, { kept: true });
    assert.deepStrictEqual(holes.map((h) => [h.qualifiedName, h.location?.uri.fsPath]), [
      ['Main.size_rhs', '/w/holes/Main.idr'],
      ['Base.todo', '/w/holes/Base.idr'],
      ['Main.todo', '/w/holes/Main.idr'],
    ]);
    assert.strictEqual(t.session.requests.length, asked, 'nothing asked again');
    // Without `kept` (List Holes): NotLoaded, so that the caller checks the file first.
    await rejectsWith(t.backend.holes(t.d), 'NotLoaded');
    // A file this session never loaded: NotLoaded, as before.
    await rejectsWith(t.backend.holes(doc('/w/holes/Other.idr', { text: 'module Other\n' }), { kept: true }), 'NotLoaded');
    // Forgotten with the root (its last document closed), which is announced (the Holes view drops its files).
    const released: unknown[] = [];
    t.ide.onDidRelease((root) => released.push(root));
    t.ide.release(t.root);
    assert.deepStrictEqual(released, [t.root]);
    await rejectsWith(t.backend.holes(t.d, { kept: true }), 'NotLoaded');
    // Kept only while the file has an open document: Main loaded again and closed, the next kept holes (Base's) drop Main's.
    await t.backend.load(doc('/w/holes/Main.idr', { text: t.text, version: 9 }));
    await flush();
    open.delete('/w/holes/Main.idr');
    await t.backend.load(doc('/w/holes/Base.idr', { text: fixtureText('holes/Base.idr'), version: 10 }));
    await flush();
    await rejectsWith(t.backend.holes(t.d, { kept: true }), 'NotLoaded');
  });

  test('a check load\'s holes are not asked when a newer load of the same file is pending (they would only delay it)', async () => {
    const t = await loadedFile('holes-loose-main', '/w/holes', 'Main.idr', true, () => true);
    await flush();
    const before = t.session.requests.length;
    // A load in flight and a newer one of the same file (saved again meanwhile): only the newer asks.
    const replay = t.session.next;
    const held: (() => void)[] = [];
    t.session.next = (command) => (command.kind !== 'raw' && serializeSexp(command).startsWith('(:load-file ') ? new Promise<void>((go) => held.push(go)).then(() => replay(command)) : replay(command));
    const first = t.backend.load(doc('/w/holes/Main.idr', { text: t.text, version: 8 }));
    await flush();
    const second = t.backend.load(doc('/w/holes/Main.idr', { text: t.text, version: 9 }));
    for (let i = 0; i < 10 && held.length < 2; i++) {
      await flush();
    }
    assert.strictEqual(held.length, 2);
    held[0]();
    await first;
    await flush();
    assert.deepStrictEqual(commands(t.session).slice(before), ['(:load-file "/w/holes/Main.idr")', '(:load-file "/w/holes/Main.idr")'], 'no holes asked after the first');
    held[1]();
    await second;
    await t.backend.holes(t.d);
    assert.strictEqual(commands(t.session)[before + 2], '(:metavariables 80)', 'the newer load\'s holes');
  });

  test('holes with a token (List Holes\' Cancel; ninth review of M4): a cancel while the listing runs rejects at once and restarts the check session; one before sends nothing; one after restarts nothing', async () => {
    const t = await loadedFile('holes-loose-main', '/w/holes', 'Main.idr');
    const early = new CancellationSource();
    early.cancel();
    await rejectsWith(t.backend.holes(t.d, { token: early.token }), 'Cancelled', /before the holes were asked/);
    assert.deepStrictEqual(commands(t.session), ['(:load-file "/w/holes/Main.idr")']);
    const replay = t.session.next;
    let answer: () => void = () => undefined;
    t.session.next = (command) => (command.kind !== 'raw' && serializeSexp(command) === '(:metavariables 80)' ? new Promise<void>((go) => (answer = go)).then(() => replay(command)) : replay(command));
    const late = new CancellationSource();
    const listing = t.backend.holes(t.d, { token: late.token });
    await flush();
    late.cancel();
    await rejectsWith(listing, 'Cancelled', /the compiler was restarted/);
    assert.deepStrictEqual(t.pool.calls.filter((c) => c.startsWith('restart')), ['restartCheck /w/holes: a listing of holes the user cancelled was running']);
    // The listing goes on for its other waiters; a token cancelled after it answered restarts nothing.
    answer();
    const after = new CancellationSource();
    const holes = await t.backend.holes(t.d, { token: after.token });
    after.cancel();
    assert.strictEqual(holes.length, 3);
    assert.strictEqual(t.pool.calls.filter((c) => c.startsWith('restart')).length, 1);
  });

  test('holes that took longer than longActionTimeout after a load are not asked after a load of the same text again, nor for kept; a changed text is asked (UX review of M4\'s eighth round)', async () => {
    const t = await loadedFile('holes-loose-main', '/w/holes', 'Main.idr', true, () => true);
    await flush();
    const replay = t.session.next;
    let timeOut = true;
    t.session.next = (command) =>
      command.kind !== 'raw' && serializeSexp(command) === '(:metavariables 80)' && timeOut
        ? Promise.reject(new IdrisException({ kind: 'RequestTimeout', message: ':metavariables did not answer within 1 min' }))
        : replay(command);
    const loadAgain = async (version: number): Promise<string[]> => {
      const before = t.session.requests.length;
      await t.backend.load(doc('/w/holes/Main.idr', { text: t.text, version }));
      await flush();
      return commands(t.session).slice(before);
    };
    assert.deepStrictEqual(await loadAgain(8), ['(:load-file "/w/holes/Main.idr")', '(:metavariables 80)']);
    timeOut = false;
    assert.deepStrictEqual(await loadAgain(9), ['(:load-file "/w/holes/Main.idr")'], 'the same text: not asked again');
    await rejectsWith(t.backend.holes(doc('/w/holes/Main.idr', { text: t.text, version: 9 }), { kept: true }), 'RequestTimeout', /not asked for again/);
    t.disk.changed = true;
    assert.deepStrictEqual((await loadAgain(10)).slice(0, 2), ['(:load-file "/w/holes/Main.idr")', '(:metavariables 80)'], 'another text: asked');
    t.disk.changed = false;
    assert.deepStrictEqual((await loadAgain(11)).slice(0, 2), ['(:load-file "/w/holes/Main.idr")', '(:metavariables 80)'], 'and after a listing that answered, the first text too');
  });

  test('edit: sent while the document shows the lines the load read, the recorded answer as replacements of that text', async () => {
    const t = await loadedFile('clean-editing', '/w/broken', 'Clean.idr');
    const result = await t.backend.edit(caseSplitOf(t.d));
    assert.deepStrictEqual(result, {
      type: 'edit',
      replacements: [{ range: { start: { line: 7, character: 0 }, end: { line: 7, character: 19 } }, text: 'vlen [] = ?vlen_rhs_0\nvlen (x :: xs) = ?vlen_rhs_1' }],
    });
    assert.deepStrictEqual(commands(t.session).slice(1), ['(:case-split 8 1 "xs")']);
    assert.strictEqual(t.session.requests[1].options.kind, 'lookup');
    // :case-split reads the file from disk when it is asked: it was read again right before the write.
    assert.strictEqual(t.reads.filter((p) => p === '/private/w/broken/Clean.idr' || p === '/w/broken/Clean.idr').length, 3);
  });

  test('the hole commands in a bird-track file: the load\'s holes put ?vlen_rhs and ?half_rhs (below the line the compiler counts twice) at the cursor, so they are sent (lit2-editing)', async () => {
    const t = await loadedFile('lit2-editing', '/w/broken', 'Lit2.lidr');
    // ?vlen_rhs on file line 9, ?half_rhs on file line 18, below the `> ` of line 16 (F11 addendum).
    const intro = await t.backend.edit({ kind: 'intro', doc: t.d, version: 7, pos: pos(8, 13), name: 'vlen_rhs' });
    assert.strictEqual(intro.type, 'choices', JSON.stringify(intro));
    const search = await t.backend.edit({ kind: 'exprSearch', doc: t.d, version: 7, pos: pos(17, 13), name: 'half_rhs', hints: [] });
    assert.strictEqual(search.type, 'edit', JSON.stringify(search));
    const refined = await t.backend.edit({ kind: 'refine', doc: t.d, version: 7, pos: pos(17, 13), name: 'half_rhs', hint: 'S' });
    assert.strictEqual(refined.type, 'edit', JSON.stringify(refined));
    assert.deepStrictEqual(editsSent(t.session), ['(:intro 9 "vlen_rhs")', '(:proof-search 19 "half_rhs" ())', '(:refine 19 "half_rhs" "S")']);
  });

  test('NotLoaded, nothing sent: another version, other lines (unsaved changes), another file, no load; a name that is not a name is Unsupported first', async () => {
    const t = await loadedFile('clean-editing', '/w/broken', 'Clean.idr');
    await rejectsWith(t.backend.edit(caseSplitOf(t.d, 6)), 'NotLoaded', /does not show the text the compiler loaded/);
    const dirty = doc('/w/broken/Clean.idr', { text: `-- a new line\n${t.text}`, isDirty: true });
    await rejectsWith(t.backend.edit(caseSplitOf(dirty)), 'NotLoaded', /does not show the text the compiler loaded/);
    await rejectsWith(t.backend.edit(caseSplitOf(doc('/w/broken/Bad.idr', { text: fixtureText('broken/Bad.idr') }))), 'NotLoaded', /not the file/);
    await rejectsWith(t.backend.edit({ ...caseSplitOf(t.d), name: 'xs :exec main' }), 'Unsupported', /not an Idris variable name/);
    await rejectsWith(t.backend.edit({ kind: 'addMissingCases', doc: t.d, version: 7, pos: pos(4, 0), name: 'append\n:exec main' }), 'Unsupported');
    // An untitled document with the loaded file's path and text: the compiler reads files, so it is refused first.
    const untitled = doc('/w/broken/Clean.idr', { text: t.text, isUntitled: true, uri: { scheme: 'untitled', fsPath: '/w/broken/Clean.idr', toString: () => 'untitled:/w/broken/Clean.idr' } });
    await rejectsWith(t.backend.edit(caseSplitOf(untitled)), 'Unsupported', /Only a file saved on disk can be edited/);
    assert.strictEqual(t.session.requests.length, 1, 'only the load');
    const fresh = setup({ readFile: fixtureFile });
    await rejectsWith(fresh.backend.edit(caseSplitOf(t.d)), 'NotLoaded');
    assert.strictEqual(fresh.pool.list.length === 0 || fresh.pool.list.every((s) => s.asked === 0), true);
  });

  test('the same lines with other line breaks are the same text (VS Code joins a document\'s lines with one)', async () => {
    const t = await loadedFile('clean-editing', '/w/broken', 'Clean.idr');
    const crlf = doc('/w/broken/Clean.idr', { text: t.text.replace(/\n/g, '\r\n') });
    // `doc` splits at \n only: give it the lines without their \r, as VS Code would.
    const lines = t.text.split('\n');
    const shown = { ...crlf, lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) } as unknown as vscode.TextDocument;
    assert.strictEqual((await t.backend.edit(caseSplitOf(shown))).type, 'edit');
  });

  test('F16: after a load that returned an error, Case Split, Add Clause and Generate Definition are refused unsent; Make Case is sent (its answer in the bracketed form)', async () => {
    const t = await loadedFile('hole-errors', '/w/broken', 'HoleErr.idr');
    await rejectsWith(t.backend.edit({ kind: 'caseSplit', doc: t.d, version: 7, pos: pos(5, 7), name: 'n' }), 'Unsupported', /did not load cleanly/);
    await rejectsWith(t.backend.edit({ kind: 'addClause', doc: t.d, version: 7, pos: pos(4, 0), name: 'before' }), 'Unsupported', /did not load cleanly/);
    assert.strictEqual(t.session.requests.length, 1);
    const made = await t.backend.edit({ kind: 'makeCase', doc: t.d, version: 7, pos: pos(11, 12), name: 'after_rhs' });
    assert.deepStrictEqual(made.type === 'edit' && made.replacements[0].text, 'after xs = (case _ of\n                 case_val => ?after_rhs)');
    assert.deepStrictEqual(commands(t.session).slice(1), ['(:make-case 12 "after_rhs")']);
  });

  test('a hole found by its name alone is asked about only when the load\'s holes put the one hole of that name at the cursor', async () => {
    // DupHole.idr: `f x = ?h` (line 5) and `g a b = ?h` (line 8); the second is never registered.
    const dup = await loadedFile('dup-holes', '/w/broken', 'DupHole.idr');
    for (const req of [
      { kind: 'exprSearch', doc: dup.d, version: 7, pos: pos(8, 9), name: 'h', hints: [] },
      { kind: 'makeLemma', doc: dup.d, version: 7, pos: pos(8, 8), name: 'h' },
      { kind: 'intro', doc: dup.d, version: 7, pos: pos(8, 8), name: 'h' },
      { kind: 'refine', doc: dup.d, version: 7, pos: pos(8, 8), name: 'h', hint: 'x' },
    ] as const) {
      await rejectsWith(dup.backend.edit(req), 'Unsupported', /has not registered this \?h: the file did not load cleanly/);
    }
    assert.deepStrictEqual(editsSent(dup.session), [], 'the recorded answer for the second ?h is the first one\'s');
    const first = await dup.backend.edit({ kind: 'exprSearch', doc: dup.d, version: 7, pos: pos(5, 7), name: 'h', hints: [] });
    assert.deepStrictEqual(first.type === 'edit' && first.replacements, [{ range: { start: { line: 5, character: 6 }, end: { line: 5, character: 8 } }, text: 'x' }]);
    assert.deepStrictEqual(editsSent(dup.session), ['(:proof-search 6 "h" ())']);
    // Holes/Main.idr and Holes/Base.idr both have a ?todo (a clean load): the compiler would not answer for either.
    const holes = await loadedFile('holes-loose-main', '/w/holes', 'Main.idr');
    await rejectsWith(holes.backend.edit({ kind: 'exprSearch', doc: holes.d, version: 7, pos: pos(5, 12), name: 'todo', hints: [] }), 'Unsupported', /knows 2 holes named \?todo/);
    assert.deepStrictEqual(editsSent(holes.session), []);
  });

  test('right before the write: a load since (NotLoaded, "checked again"), and for :case-split a file changed on disk (NotLoaded)', async () => {
    const t = await loadedFile(CLEAN, '/w/broken', 'Clean.idr');
    t.disk.changed = true;
    await rejectsWith(t.backend.edit(caseSplitOf(t.d)), 'NotLoaded', /does not show the text the compiler loaded/);
    t.disk.changed = false;
    await t.backend.holes(t.d);
    t.session.beforeCheck = () => {
      t.session.loadedFile = { path: '/private/w/broken/Clean.idr', version: 9 };
    };
    await rejectsWith(t.backend.edit({ kind: 'intro', doc: t.d, version: 7, pos: pos(7, 12), name: 'vlen_rhs' }), 'NotLoaded', /checked again/);
    assert.deepStrictEqual(editsSent(t.session), [], 'nothing but the load and the holes');
  });

  test('searches: long requests; -Next continues the search while it is the compiler\'s, and is refused unsent after a load, a raw request, another document', async () => {
    const t = await loadedFile(CLEAN, '/w/broken', 'Clean.idr');
    const first = await t.backend.edit({ kind: 'exprSearch', doc: t.d, version: 7, pos: pos(7, 12), name: 'vlen_rhs', hints: [] });
    assert.deepStrictEqual(first.type === 'edit' && first.replacements, [{ range: { start: { line: 7, character: 10 }, end: { line: 7, character: 19 } }, text: '0' }]);
    const after = doc('/w/broken/Clean.idr', { text: t.text.replace('?vlen_rhs', '0'), version: 8, isDirty: true });
    const previous = { start: { line: 7, character: 10 }, end: { line: 7, character: 11 } };
    const next = await t.backend.edit({ kind: 'exprSearchNext', doc: after, version: 8, previous });
    assert.deepStrictEqual(next.type === 'edit' && next.replacements, [{ range: previous, text: '1' }]);
    assert.deepStrictEqual(editsSent(t.session), ['(:proof-search 8 "vlen_rhs" ())', ':proof-search-next']);
    assert.deepStrictEqual(t.session.requests.slice(-2).map((r) => r.options.kind), ['longAction', 'longAction']);
    // Not for another document, nor for the other kind of search.
    await rejectsWith(t.backend.edit({ kind: 'exprSearchNext', doc: doc('/w/broken/Other.idr'), version: 7, previous }), 'Unsupported', /has ended/);
    await rejectsWith(t.backend.edit({ kind: 'generateDefNext', doc: after, version: 8, previous }), 'Unsupported', /Generate Definition it would continue has ended/);
    // A raw request may have been anything.
    await t.ide.sendRaw(t.root, '(:version)').catch(() => undefined);
    await rejectsWith(t.backend.edit({ kind: 'exprSearchNext', doc: after, version: 8, previous }), 'Unsupported', /Proof Search it would continue has ended/);
    // A new search, then a load: the load resets it.
    await t.backend.edit({ kind: 'generateDef', doc: t.d, version: 7, pos: pos(4, 0), name: 'append' });
    const defined = doc('/w/broken/Clean.idr', { text: t.text, version: 9 });
    await t.backend.load(defined);
    await rejectsWith(t.backend.edit({ kind: 'generateDefNext', doc: defined, version: 9, previous }), 'Unsupported', /has ended/);
    assert.deepStrictEqual(commands(t.session).slice(-3), ['(:version)', '(:generate-def 5 "append")', '(:load-file "/private/w/broken/Clean.idr")']);
  });

  test('a -Next with no search to continue is refused before it asks the session (which, stopped, would start a process)', async () => {
    const t = await loadedFile(CLEAN, '/w/broken', 'Clean.idr');
    const asked = t.session.asked;
    const previous = { start: { line: 7, character: 10 }, end: { line: 7, character: 11 } };
    await rejectsWith(t.backend.edit({ kind: 'exprSearchNext', doc: t.d, version: 7, previous }), 'Unsupported', /Proof Search it would continue has ended/);
    await rejectsWith(t.backend.edit({ kind: 'generateDefNext', doc: t.d, version: 7, previous }), 'Unsupported', /Generate Definition it would continue has ended/);
    assert.strictEqual(t.session.asked, asked, 'no request made');
  });

  test('a -Next whose search ended while it waited in the queue (a load went first) is refused at its write, unsent', async () => {
    const t = await loadedFile(CLEAN, '/w/broken', 'Clean.idr');
    await t.backend.edit({ kind: 'exprSearch', doc: t.d, version: 7, pos: pos(7, 12), name: 'vlen_rhs', hints: [] });
    const after = doc('/w/broken/Clean.idr', { text: t.text.replace('?vlen_rhs', '0'), version: 8, isDirty: true });
    const previous = { start: { line: 7, character: 10 }, end: { line: 7, character: 11 } };
    t.session.beforeCheck = () => {
      t.session.loadedFile = { path: '/private/w/broken/Clean.idr', version: 9 };
    };
    await rejectsWith(t.backend.edit({ kind: 'exprSearchNext', doc: after, version: 8, previous }), 'Unsupported', /Proof Search it would continue has ended/);
    assert.deepStrictEqual(editsSent(t.session), ['(:proof-search 8 "vlen_rhs" ())']);
  });

  test('a -Next on a document changed since its previous result is refused unsent; "No more results" is exhausted', async () => {
    const t = await loadedFile('edits-searches', '/w/broken', 'Edits.idr');
    const swap = await t.backend.edit({ kind: 'generateDef', doc: t.d, version: 7, pos: pos(74, 0), name: 'swap' });
    assert.deepStrictEqual(swap.type === 'edit' && swap.replacements[0].text, 'swap x = (snd x, fst x)\n');
    const previous = { start: { line: 75, character: 0 }, end: { line: 76, character: 0 } };
    const applied = doc('/w/broken/Edits.idr', { text: t.text.replace('swap : (a, b) -> (b, a)\n', 'swap : (a, b) -> (b, a)\nswap x = (snd x, fst x)\n'), version: 8 });
    await rejectsWith(t.backend.edit({ kind: 'generateDefNext', doc: applied, version: 7, previous }), 'Unsupported', /changed since/);
    const second = await t.backend.edit({ kind: 'generateDefNext', doc: applied, version: 8, previous });
    assert.deepStrictEqual(second.type === 'edit' && second.replacements, [{ range: previous, text: 'swap (x, y) = (y, x)\n' }]);
    assert.deepStrictEqual(await t.backend.edit({ kind: 'generateDefNext', doc: applied, version: 8, previous }), { type: 'exhausted' });
  });

  test('cancellation: before the write the request is dropped; after it the check session alone is restarted', async () => {
    const t = await loadedFile(CLEAN, '/w/broken', 'Clean.idr');
    const early = new CancellationSource();
    early.cancel();
    await rejectsWith(t.backend.edit({ kind: 'exprSearch', doc: t.d, version: 7, pos: pos(7, 12), name: 'vlen_rhs', hints: [], token: early.token }), 'Cancelled', /before the request was sent/);
    assert.deepStrictEqual(editsSent(t.session), []);
    let reject: (e: Error) => void = () => undefined;
    t.session.next = () => new Promise<Reply>((_, no) => (reject = no));
    const late = new CancellationSource();
    const running = t.backend.edit({ kind: 'exprSearch', doc: t.d, version: 7, pos: pos(7, 12), name: 'vlen_rhs', hints: [], token: late.token });
    await settle();
    assert.deepStrictEqual(t.session.requests[t.session.requests.length - 1].options.token, late.token, 'the session drops it if it is cancelled before the write');
    late.cancel();
    assert.deepStrictEqual(t.pool.calls.filter((c) => c.startsWith('restart')), ['restartCheck /w/broken: a request the user cancelled was running']);
    reject(cancelled('The Idris 2 process was restarted.'));
    await rejectsWith(running, 'Cancelled', /the compiler was restarted/);
  });

  test('cancellation of a request still queued (behind another request, not written): nothing is restarted and it is never sent', async () => {
    const t = await loadedFile(CLEAN, '/w/broken', 'Clean.idr');
    const before = t.session.requests.length;
    let drop: (e: Error) => void = () => undefined;
    // What the request waits for before its write: the request in flight ahead of it.
    t.session.waitBeforeSend = new Promise<void>((_, no) => (drop = no));
    const queued = new CancellationSource();
    const waiting = t.backend.edit({ kind: 'generateDef', doc: t.d, version: 7, pos: pos(4, 0), name: 'append', token: queued.token });
    await settle();
    queued.cancel();
    assert.deepStrictEqual(t.pool.calls.filter((c) => c.startsWith('restart')), [], 'nothing was running for it');
    // The session drops a request cancelled before its write (session.ts).
    drop(cancelled('The request was cancelled before it was sent.'));
    await rejectsWith(waiting, 'Cancelled', /before the request was sent/);
    assert.strictEqual(t.session.requests.length, before);
  });

  test('restartCheck of the real pool restarts a busy check session only; an idle one, and the eval session, are left alone', async () => {
    const settings: IdeModeSettings = {
      transport: 'stdio',
      isolateBuildDir: true,
      loosePackages: [],
      extraArgs: [],
      requestTimeoutMs: 5_000,
      longActionTimeoutMs: 60_000,
      idleTimeoutMs: 600_000,
      maxSessions: 0,
      maxBackgroundChecks: 0,
    };
    const allowed: GateVerdict = { allowed: true, basis: 'workspaceFolder' };
    const transports: FakeTransport[] = [];
    const pool = createTunedSessionPool(
      {
        toolchain: new FakeToolchain(snapshot()),
        projects: { sessionCwd: (r: Classification) => r.dir },
        config: { ideMode: () => settings, onDidChange: () => ({ dispose: () => undefined }) },
        trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
        gate: { permit: () => Promise.resolve(allowed), current: () => allowed, recheck: () => Promise.resolve(allowed), onDidChange: new Emitter<void>().event },
        codec: jsonCodec,
        trace: new RecordingTrace(),
        log: recordingLog(),
        platform: 'darwin',
        processEnv: {},
      },
      {
        timing: DEFAULT_SESSION_TIMING,
        clock: new FakeClock(),
        createTransport: (launch) => {
          const transport = new FakeTransport(launch, {});
          transports.push(transport);
          return transport;
        },
      },
    );
    try {
      const root: Classification = { kind: 'loose', dir: '/w/a' };
      const check = pool.sessionFor(root, 'check');
      const evaluation = pool.sessionFor(root, 'eval');
      for (const session of [check, evaluation]) {
        const answered = session.request(sym('version'), { kind: 'lookup' });
        await flush();
        const transport = transports[transports.length - 1];
        transport.message(ret(transport.lastSent().id, ok(str('v'))));
        await answered;
      }
      pool.restartCheck(root, 'nothing in flight');
      assert.deepStrictEqual([check.state, evaluation.state, transports.map((t) => t.stopCalls)], ['ready', 'ready', [0, 0]]);
      const busy = check.request(sym('version'), { kind: 'longAction' });
      busy.catch(() => undefined);
      await flush();
      assert.strictEqual(check.state, 'busy');
      pool.restartCheck(root, 'a request the user cancelled was running');
      await assert.rejects(busy, (e: unknown) => isCancelled(e));
      assert.deepStrictEqual([evaluation.state, transports.map((t) => t.stopCalls)], ['ready', [1, 0]]);
      const after: string = check.state;
      assert.ok(after === 'restarting' || after === 'starting' || after === 'ready', after);
    } finally {
      pool.dispose();
    }
  });
});
