/**
 * The IDE-mode backend (`backend/ide/backend.ts`, docs/ARCHITECTURE.md §3.1, §5; ROADMAP M2):
 * `IdeBackend implements IdrisBackend` over the `SessionPool`, and `IdeMode`, the registry's
 * provider for every root and the control surface of the backend commands (Stop, Restart, Send
 * Raw Protocol Request, crash notices) and of the checks (a root's last document closed; a
 * root's session serving again after an automatic restart, `onDidRestart`; the active document's
 * root, which `idris2.ideMode.maxSessions` never stops).
 *
 * M2 implements `load` only (`caps.diagnostics`); the other methods reject with `Unsupported`
 * until the milestones that own them (hover, types and documentation M3, holes and editing M4).
 *
 * **The path in `:load-file`.** The compiler accepts an absolute path only when it lies,
 * as text, below its working directory and source directory (`corePathToNS`, `mbPathToNS`,
 * `src/Core/Directory.idr` 224–245 on v0.8.0 [src]), and its working directory is `getcwd()`
 * (`setWorkingDir`, `src/Core/Context.idr` 2188–2193 [src]), which on POSIX is the physical path:
 * started in a directory spelled through a symbolic link, the compiler refused the file's path
 * through the link (`Source file … is not in the source directory …`) and loaded its real path
 * [live, load-symlink]. So the path sent is the real path of the session directory joined with
 * the file's path relative to it — on POSIX; on Windows the file's path as it is, because how
 * the compiler sees its working directory there was not tried [open]. A file's path relative to
 * the session directory never climbs out of it: the directory is the file's own (loose) or that
 * of the `.ipkg` found above it (`project/index.ts`).
 *
 * **The package, as the compiler finds it.** At every `:load-file` the compiler walks up from its
 * current working directory — the physical path — to the first directory with an `.ipkg`,
 * changes into it and applies that package's `builddir`, `opts` and `depends` (`findIpkg`, F13;
 * `IDEMode/REPL.idr` 145, `Idris/Package.idr` 1089–1110, `Core/Directory.idr` 333–349 on v0.8.0
 * [src]); a loose session given a parent `evil.ipkg` wrote its TTCs to that package's `builddir`
 * [live, M2 second review]. The move is sticky: a project session whose `.ipkg` was renamed moved
 * to the parent package's folder at its next load, and stayed there after the `.ipkg` came back,
 * so that every later load failed (`Module name A does not match file name`) [live, M2 third review,
 * 2026-09-28, one `timeout 60 idris2 --ide-mode` session, `:cwd` after each load]. The project index
 * walks the logical path and watches only the workspace folders (and those with a debounce), so
 * its classification can be stale: a package file created, renamed or deleted outside the
 * workspace folders, or one above the physical directory of a folder reached through a symbolic
 * link. The directory the compiler would move to was never put to the consent gate. So before
 * each load the walk is done again from the session directory's real path (`findPackage`), and
 * the load is sent only when it finds nothing for a loose file, and the root's own `.ipkg` in the
 * session directory for a project (compared by path: the same directory, the same name). Otherwise
 * nothing is sent: the load fails (`LoadFailed`) with a message that says what to do, and the
 * root's sessions are stopped (`SessionPool.packageChanged`), since a compiler that has moved
 * already would not walk from the session directory again. The walk is done when the load is
 * queued (so that nothing is started, and no question asked, for a load that would be refused)
 * and again when it is the next to be sent to a process that has answered the handshake
 * (`RequestOptions.beforeSend`), with the checks of the directory below; only microtasks separate
 * that walk from the write. Each walk has the load's time limit, `idris2.ideMode.longActionTimeout`
 * (`withinLimit`; the session's own for the second): one that has not settled by then fails the
 * load with `LoadFailed`, nothing sent. The classification that comes before the first walk
 * (`ProjectIndex.classify`, cached per directory) has no limit of its own [reasoned from the code]. (*M2 second verification of the third review*: the walk was done only
 * when the load was queued, and a first load then waited for the toolchain scan, the consent
 * question — open for as long as the user leaves it — and the start, so a package file created
 * in a parent meanwhile, e.g. in `/tmp`, was adopted at that load [unit-level].) The compiler walks from its own working
 * directory, which follows the directory, not its path (`getcwd`): a session directory moved or
 * replaced while its compiler runs would make the walk start elsewhere than the compiler's. So when
 * a process starts, `IdeMode` notes the identity of its directory (`directoryId`: device and inode),
 * and before each load the directory now at the session's path must be the same one; a directory
 * whose real path cannot be read (it was moved away or deleted) or whose identity changed fails the
 * load the same way, loose sessions included (*M2 verification of the third review*: before, a
 * loose session whose directory could not be resolved was sent the load, and loose sessions were
 * never stopped); so does a session directory whose real path is not the one the load's path was
 * built from. A package file created, removed or renamed between that walk and the compiler's
 * (while the compiler reads the load, or before a later one), and a directory replaced in the
 * few milliseconds between a process's start and the reading of its identity, are not caught: a
 * compiler that has moved that way works from the other package's folder, with its `builddir`,
 * `opts` and `depends` — a loose file is then checked as part of that package, a project's loads
 * may fail with a module-name mismatch — until a later walk finds a change and stops it, or the
 * session is restarted.
 *
 * Only type imports from `vscode`: the diagnostic objects are built with the `api` passed in, so
 * the module is unit-tested on Node.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { errorText, IdrisException, unsupported } from '../../core/errors';
import { Emitter, type Event } from '../../core/event';
import type { Config } from '../../core/config';
import type { EditorRange, PositionDocument } from '../../core/positions';
import type { SessionGate } from '../../core/trust';
import { compilerReading, compilerReadsPathAsGiven, packageOptionWords } from '../../project/ipkg';
import { literateStyleOfFileName } from '../../project/literate';
import type { Classification, ProjectIndex } from '../../project/types';
import { NO_CAPABILITIES } from '../null';
import { rootKey, type BackendProvider, type BackendState } from '../registry';
import type {
  BackendKind,
  Capabilities,
  EditResult,
  Hole,
  IdrisBackend,
  LoadOptions,
  LoadResult,
  NamespaceEntry,
  RichText,
  TypeInfo,
} from '../types';
import { loadDiagnostics, type DiagnosticRecord, type LoadDiagnostics } from './diagnostics';
import { loadFile } from './protocol';
import { duration, type Clock } from './session';
import type { IdeSession, Reply, SessionLaunch, SessionPool, SessionStateChange } from './types';

/** IDE mode in M2: diagnostics only. */
export const IDE_MODE_CAPABILITIES: Readonly<Capabilities> = Object.freeze({ ...NO_CAPABILITIES, diagnostics: true });

/** The `vscode` constructors the backend needs to build diagnostics. */
export type DiagnosticsApi = Pick<
  typeof vscode,
  'Uri' | 'Range' | 'Position' | 'Diagnostic' | 'DiagnosticSeverity' | 'DiagnosticRelatedInformation' | 'Location'
>;

export interface IdeModeDeps {
  readonly pool: SessionPool;
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd'>;
  /** `diagnostics`; `ideMode().longActionTimeoutMs`, the limit of the walk made when a load is queued. */
  readonly config: Pick<Config, 'diagnostics' | 'ideMode'>;
  /** The timers of that limit (`systemClock` in the extension). */
  readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  readonly gate: Pick<SessionGate, 'current' | 'onDidChange'>;
  readonly api: DiagnosticsApi;
  /** Reads a file as UTF-8 (`fs.promises.readFile`), for the literate offset of bird-track files. */
  readFile(p: string): Promise<string>;
  /** `fs.promises.realpath`. */
  realpath(p: string): Promise<string>;
  /**
   * The package file the compiler's walk finds at or above `dir` (`project/ipkg.ts` `findIpkg`:
   * the first `.ipkg` in listing order of the nearest directory that has one), else `undefined`.
   */
  findPackage(dir: string): Promise<string | undefined>;
  /**
   * What tells the directory at `p` (following symbolic links) apart from another one put in its
   * place: its device and inode numbers (`fs.promises.stat(p, { bigint: true })`); rejects when
   * there is none.
   */
  directoryId(p: string): Promise<string>;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
}

/** The text the compiler read, as `core/positions.ts` reads a document. */
function textDocument(fileName: string, text: string | undefined): PositionDocument {
  const lines = text === undefined ? [] : text.split('\n');
  return {
    languageId: '',
    fileName,
    isUntitled: false,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
  };
}

/**
 * Why a load is not sent (`IdeBackend.loadRefusal`): the error it fails with (`LoadFailed`), and
 * the detail the root's sessions are stopped with (`SessionPool.packageChanged`).
 */
interface LoadRefusal {
  readonly detail: string;
  readonly error: IdrisException;
}

function refusal(detail: string, message: string): LoadRefusal {
  return { detail, error: new IdrisException({ kind: 'LoadFailed', message }) };
}

/** A process ended unexpectedly, or the pool gave up on one (for the crash notices). */
export interface BackendFailure {
  readonly root: Classification;
  /** false: it is being restarted; true: given up until restarted. */
  readonly gaveUp: boolean;
  readonly detail: string;
  /**
   * A crash of a root whose session has not answered a request since its previous crash (a file
   * that crashes the compiler at every load): the commands show no second notice for it.
   */
  readonly repeated: boolean;
}

/**
 * A root's `check` session serves again after an automatic restart (`IdeMode.onDidRestart`):
 * `reconfigure` — its command line changed (a setting, a toolchain scan, the package), so what
 * the documents show came from the old one; `crash` — it ended unexpectedly (an exit or a
 * protocol error; not a time-out, whose request would only time out again) and the request in
 * flight was lost.
 */
export interface BackendRestart {
  readonly root: Classification;
  readonly cause: 'reconfigure' | 'crash';
}

/** The causes of a crash (the session restarts) as `SessionStateChange` reports them. */
const CRASH_CAUSES = new Set(['exit', 'timeout', 'protocolError']);

/**
 * The provider of every root (`BackendRegistry.setProvider`) and the control surface of the
 * backend commands. One `IdeBackend` serves all roots: `load` classifies its document and asks
 * the pool for the root's `check` session.
 */
export class IdeMode implements BackendProvider, IDisposable {
  readonly kind: BackendKind = 'ideMode';
  private readonly backend: IdeBackend;
  private readonly store = new DisposableStore();
  private readonly stateChanged = this.store.add(new Emitter<void>());
  private readonly failed = this.store.add(new Emitter<BackendFailure>());
  private readonly restarted = this.store.add(new Emitter<BackendRestart>());
  /** The last state change of each root's `check` session, by `rootKey`. */
  private readonly lastChange = new Map<string, SessionStateChange>();
  /** Why a root's `check` session is being restarted, until its next handshake (`onDidRestart`). */
  private readonly pendingRestarts = new Map<string, BackendRestart['cause']>();
  /** The roots whose `check` session crashed and has not answered a request since (`BackendFailure.repeated`). */
  private readonly crashedSinceReply = new Set<string>();

  readonly onDidChangeState: Event<void> = this.stateChanged.event;
  /** A `check` session crashed (and is being restarted) or was given up. */
  readonly onDidFail: Event<BackendFailure> = this.failed.event;
  /**
   * A root's `check` session serves again after an automatic restart (`BackendRestart`): when
   * the new process has sent its handshake, or at once when a `failed` session was returned to
   * `stopped` because its command line changed. Restart Backend (`restart`) is not reported: the
   * command checks the visible documents itself.
   */
  readonly onDidRestart: Event<BackendRestart> = this.restarted.event;

  constructor(private readonly deps: IdeModeDeps) {
    this.backend = new IdeBackend(deps);
    this.store.add(
      deps.pool.onDidChange(({ session, change }) => {
        if (session.role !== 'check') {
          return;
        }
        if (change.state === 'starting' && session.launch !== undefined) {
          this.backend.started(session.launch);
        }
        const key = rootKey(session.root);
        this.lastChange.set(key, change);
        this.noteRestart(session.root, change);
        if (change.state === 'failed') {
          this.crashedSinceReply.delete(key);
          this.failed.fire({ root: session.root, gaveUp: true, detail: change.detail ?? change.cause, repeated: false });
        } else if (change.state === 'restarting' && CRASH_CAUSES.has(change.cause)) {
          const repeated = this.crashedSinceReply.has(key);
          this.crashedSinceReply.add(key);
          this.failed.fire({ root: session.root, gaveUp: false, detail: change.detail ?? change.cause, repeated });
        } else if (change.cause === 'reply' || change.state === 'stopped') {
          this.crashedSinceReply.delete(key);
        }
        this.stateChanged.fire();
      }),
    );
    this.store.add(deps.gate.onDidChange(() => this.stateChanged.fire()));
  }

  backendFor(): IdrisBackend {
    return this.backend;
  }

  /** Follows a `check` session through an automatic restart to its next handshake (`onDidRestart`). */
  private noteRestart(root: Classification, change: SessionStateChange): void {
    const key = rootKey(root);
    const pending = this.pendingRestarts.get(key);
    if (change.cause === 'reconfigure') {
      if (change.state === 'stopped') {
        this.pendingRestarts.delete(key);
        this.restarted.fire({ root, cause: 'reconfigure' });
      } else {
        this.pendingRestarts.set(key, 'reconfigure');
      }
    } else if (change.state === 'restarting' && (change.cause === 'exit' || change.cause === 'protocolError')) {
      if (pending !== 'reconfigure') {
        this.pendingRestarts.set(key, 'crash');
      }
    } else if (change.state === 'restarting' && change.cause === 'timeout') {
      if (pending === 'crash') {
        this.pendingRestarts.delete(key);
      }
    } else if (change.state === 'ready' && change.cause === 'handshake') {
      if (pending !== undefined) {
        this.pendingRestarts.delete(key);
        this.restarted.fire({ root, cause: pending });
      }
    } else if (change.state === 'stopped' || change.state === 'failed') {
      this.pendingRestarts.delete(key);
    }
  }

  private checkSession(root: Classification): IdeSession | undefined {
    const key = rootKey(root);
    return this.deps.pool.sessions().find((s) => s.role === 'check' && rootKey(s.root) === key);
  }

  stateFor(root: Classification): BackendState {
    const dir = this.deps.projects.sessionCwd(root);
    const verdict = this.deps.gate.current(dir);
    if (verdict !== undefined && !verdict.allowed && (verdict.reason === 'denied' || verdict.reason === 'unanswered')) {
      return { kind: 'notAllowed', dir, reason: verdict.reason };
    }
    const session = this.checkSession(root);
    const change = this.lastChange.get(rootKey(root));
    switch (session?.state) {
      case undefined:
        return { kind: 'none' };
      case 'stopped':
        // Revoked: named until the directory is allowed again without a question (e.g. its folder
        // was added to the workspace), when the next check just starts the compiler.
        return change?.cause === 'consentRevoked'
          ? verdict?.allowed === true
            ? { kind: 'stopped' }
            : { kind: 'stopped', revokedDir: dir }
          : change?.cause === 'stop'
            ? { kind: 'stopped' }
            : { kind: 'none' };
      case 'failed':
        return { kind: 'failed', reason: change?.detail ?? 'the compiler could not be started' };
      default:
        return { kind: 'active' };
    }
  }

  /** The roots whose `check` session has a process or is starting one (for Stop and Restart). */
  activeRoots(): readonly Classification[] {
    return this.deps.pool
      .sessions()
      .filter((s) => s.role === 'check' && s.state !== 'stopped' && s.state !== 'failed')
      .map((s) => s.root);
  }

  /** Stops the sessions of `root`, or of every root. */
  stop(root?: Classification): void {
    this.deps.pool.stop(root);
  }

  /** Stops the sessions of `root` because its last open document was closed (`SessionPool.release`). */
  release(root: Classification): void {
    this.deps.pool.release(root);
  }

  /**
   * The root of the active document, `pending` while it is being found, or none
   * (`features/diagnostics/checks.ts` `ActiveRoot`): its sessions are kept when
   * `idris2.ideMode.maxSessions` is exceeded (`SessionPool.setActiveRoot`).
   */
  setActiveRoot(root: Classification | 'pending' | undefined): void {
    this.deps.pool.setActiveRoot(root);
  }

  /**
   * Why a load of `doc` in `root` would be refused without the consent question being asked, or
   * `undefined` (`features/diagnostics/checks.ts` `LoadPreflight`: the checks ask the question
   * themselves for a background check under `idris2.ideMode.maxBackgroundChecks`, and a load that
   * nothing asks about must not get a question from them either): the walk `load` makes when the
   * load is queued (module comment, with its time limit), then what the pool checks before the
   * question (`SessionPool.startProblem`). Starts, stops and asks nothing.
   */
  refusalBeforeQuestion(doc: vscode.TextDocument, root: Classification): Promise<string | undefined> {
    return this.backend.refusalBeforeQuestion(doc, root);
  }

  /** Starts the sessions of `root` again now, or restarts every running session. */
  restart(root?: Classification): void {
    if (root === undefined) {
      this.deps.pool.restartAll();
    } else {
      this.deps.pool.restart(root);
    }
  }

  /**
   * Sends `text` verbatim as the command of a request `(<text> <id>)` to the `check` session of
   * `root` (**Idris 2 (Developer): Send Raw Protocol Request…**); the session writes the frames to
   * the protocol trace. Resolves with the `:return` as one line. The request may be anything —
   * a `:load-file`, a `:proof-search` — so it runs under `idris2.ideMode.longActionTimeout`.
   */
  async sendRaw(root: Classification, text: string): Promise<string> {
    const reply = await this.deps.pool.sessionFor(root, 'check').request({ kind: 'raw', text }, { kind: 'longAction' });
    return describeReturn(reply);
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** A `:return` in one line, for the trace: `ok`, or `error: <first line>`. */
function describeReturn(reply: Reply): string {
  const payload = reply.payload;
  const id = reply.returnedId === undefined ? `${reply.id}` : `${reply.returnedId} (attributed to ${reply.id})`;
  return payload.kind === 'error' ? `id ${id}: error: ${payload.message.split('\n', 1)[0]}` : `id ${id}: ${payload.kind}`;
}

/** Not in M2: each names the milestone's feature, not the milestone. */
function notYet(what: string): Promise<never> {
  return Promise.reject(unsupported(`${what} is not available with the IDE-mode backend in this version.`));
}

export class IdeBackend implements IdrisBackend {
  readonly kind: BackendKind = 'ideMode';
  readonly caps: Readonly<Capabilities> = IDE_MODE_CAPABILITIES;
  /** The directory each process was started in (`directoryId`, `undefined`: none), by its launch (module comment). */
  private readonly startedIn = new WeakMap<SessionLaunch, Promise<string | undefined>>();

  constructor(private readonly deps: IdeModeDeps) {}

  /** A process was just started with `launch` (`IdeMode`, on the change to `starting`): notes the directory it was started in. */
  started(launch: SessionLaunch): void {
    this.startedIn.set(
      launch,
      this.deps.directoryId(launch.realCwd ?? launch.cwd).catch(() => undefined),
    );
  }

  /**
   * The real path of the session directory; or, when it cannot be resolved, or the process of
   * `session` was started in another directory than the one there now (module comment), the
   * refusal of the load.
   */
  private async sessionDirectory(session: IdeSession): Promise<string | LoadRefusal> {
    const cwd = session.cwd;
    let realCwd: string;
    try {
      realCwd = await this.deps.realpath(cwd);
    } catch (error) {
      const detail = `the folder of its session, ${cwd}, cannot be resolved (${error instanceof Error ? error.message : String(error)})`;
      return refusal(
        detail,
        `Not checked: ${detail}, so nothing was sent to the compiler, which would look for a package from wherever it runs now.`,
      );
    }
    const launch = session.launch;
    const expected = launch === undefined ? undefined : this.startedIn.get(launch);
    if (expected !== undefined) {
      const [then, now] = await Promise.all([expected, this.deps.directoryId(cwd).catch(() => undefined)]);
      if (then === undefined || now === undefined || then !== now) {
        const detail = `the folder ${realCwd} is not the one the compiler was started in (it was moved or replaced while the compiler ran)`;
        return refusal(
          detail,
          `Not checked: ${detail}, so nothing was sent to the compiler, which looks for a package from the folder it runs in. ` +
            'The next check starts it again in this folder.',
        );
      }
    }
    return realCwd;
  }

  /** The path to send in `:load-file` for `file` in a session started in `cwd`, whose real path is `realCwd` (module comment). */
  private loadPath(cwd: string, realCwd: string, file: string): string {
    return this.deps.platform === 'win32' ? file : path.join(realCwd, path.relative(cwd, file));
  }

  /**
   * The refusal of the load of `file` when the compiler, walking up from `dir` (the real path of the
   * session directory), would not use the package of `root` (module comment): a loose file's walk
   * must find no package file, a project's must find its own `.ipkg` in `dir`.
   */
  private async otherPackage(root: Classification, file: string, dir: string): Promise<LoadRefusal | undefined> {
    const found = await this.deps.findPackage(dir);
    const name = path.basename(file);
    if (root.kind === 'loose') {
      if (found === undefined) {
        return undefined;
      }
      // A compiler that has moved already (a load that raced with the package file) is stopped too.
      return refusal(
        `searching from ${dir}, the real path of its folder, the compiler would find the package file ${found}`,
        `Not checked: searching from ${dir}, the real path of its folder, the compiler would find the package file ${found} ` +
          `and check ${name} as part of that package, in that package's folder, which the extension did not ` +
          'find when it classified the file, so nothing was sent to the compiler. If the package file is new, the next check ' +
          'takes it into account when it lies inside the workspace folders, and after a reload of the window otherwise; if the ' +
          `folder is reached through a symbolic link, open the file through its real path, ${path.join(dir, name)}.`,
      );
    }
    const own = path.join(dir, path.basename(root.ipkgPath));
    if (found !== undefined && path.relative(found, own) === '') {
      return undefined;
    }
    const detail =
      found === undefined
        ? `searching from ${dir}, the real path of its folder, the compiler finds no package file, not ${root.ipkgPath}`
        : `searching from ${dir}, the real path of its folder, the compiler would find the package file ${found}, not ${root.ipkgPath}`;
    return refusal(
      detail,
      `Not checked: ${detail}, so nothing was sent to the compiler, which would check ${name} ` +
        `${found === undefined ? 'without a package' : "as part of that package, in that package's folder"}. The package file ` +
        'was removed, renamed or replaced after the extension classified the file: the next check takes that into account when ' +
        'it lies inside the workspace folders, and after a reload of the window otherwise.',
    );
  }

  /**
   * Why a load of `file` in `session` must not be sent now (module comment); else the real path of
   * the session directory. `sentFrom`: the real path the load's path was built from, which the
   * session directory must still have.
   */
  private async loadRefusal(root: Classification, session: IdeSession, file: string, sentFrom?: string): Promise<LoadRefusal | string> {
    const dir = await this.sessionDirectory(session);
    if (typeof dir !== 'string') {
      return dir;
    }
    if (sentFrom !== undefined && dir !== sentFrom) {
      const detail = `the real path of the folder of its session changed from ${sentFrom} to ${dir} while the load waited`;
      return refusal(detail, `Not checked: ${detail}, so nothing was sent to the compiler. The next check starts it again in this folder.`);
    }
    if (this.deps.platform !== 'win32') {
      // The compiler parses paths with its own parser: `\` is a separator to it, and it stops
      // reading at `:` or `?`. Its walk from such a folder goes elsewhere than `findPackage`'s,
      // and it would read another file (`project/ipkg.ts` `findIpkg`).
      const sent = this.loadPath(session.cwd, dir, file);
      const misread = [dir, sent].find((p) => !compilerReadsPathAsGiven(p, this.deps.platform));
      if (misread !== undefined) {
        const detail = `the compiler reads the path ${misread} as ${compilerReading(misread)}`;
        return refusal(
          detail,
          `Not checked: ${detail} (it takes \\ for a folder separator and stops reading a path at : or ?), so it would look for a ` +
            'package elsewhere and could check another file; nothing was sent to it. Rename the folder or the file without these characters.',
        );
      }
    }
    return (await this.otherPackage(root, file, dir)) ?? dir;
  }

  /**
   * The documents `loadDiagnostics` converts ranges with: bird-track files named in the reply's
   * frames, read from disk (the text the compiler read); every other file needs no text.
   */
  private async documents(reply: Reply, cwd: string, loadedPath: string): Promise<(p: string) => PositionDocument> {
    const files = [loadedPath];
    for (const message of reply.messages) {
      if (message.kind === 'warning') {
        files.push(path.resolve(cwd, message.warning.file));
      }
    }
    const bird = [...new Set(files)].filter((file) => literateStyleOfFileName(file) === 'bird');
    const texts = new Map<string, string | undefined>();
    await Promise.all(
      bird.map(async (file) => {
        texts.set(file, await this.deps.readFile(file).catch(() => undefined));
      }),
    );
    return (p) => textDocument(p, texts.get(p));
  }

  /**
   * `walk`, the walk made when a load is queued (module comment), unless it has not settled within
   * `idris2.ideMode.longActionTimeout`, the limit of the walk before the send
   * (`RequestOptions.beforeSend`): then it rejects with `LoadFailed`, nothing having been sent, and
   * the root's sessions are left as they are (a slow file system is no change of package). The walk
   * itself is not interrupted; its late result is ignored. (*M2 verification of the Q20–Q22 fixes*:
   * this walk had no limit, so on a hung network mount it never settled — the document read
   * `checking…` for good, **Stop Backend** could not end it, since the load was in no session yet, and
   * a background check it belonged to kept its `idris2.ideMode.maxBackgroundChecks` slot [unit-level,
   * the verifier's probes].)
   */
  private withinLimit<T>(walk: Promise<T>): Promise<T> {
    const limit = this.deps.config.ideMode().longActionTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = this.deps.clock.setTimeout(
        () =>
          reject(
            new IdrisException({
              kind: 'LoadFailed',
              message:
                `Not checked: the search for the file's package (the real path of its folder, a package file above it) did not ` +
                `finish within ${duration(limit)}, so nothing was sent to the compiler.`,
            }),
          ),
        limit,
      );
      walk.then(
        (value) => {
          this.deps.clock.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.deps.clock.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** `IdeMode.refusalBeforeQuestion`. */
  async refusalBeforeQuestion(doc: vscode.TextDocument, root: Classification): Promise<string | undefined> {
    const session = this.deps.pool.sessionFor(root, 'check');
    try {
      const early = await this.withinLimit(this.loadRefusal(root, session, doc.fileName));
      if (typeof early !== 'string') {
        return errorText(early.error.error);
      }
    } catch (error) {
      // The load would fail the same way.
      return error instanceof IdrisException ? errorText(error.error) : String(error);
    }
    const problem = await this.deps.pool.startProblem();
    return problem === undefined ? undefined : errorText(problem.error);
  }

  async load(doc: vscode.TextDocument, options?: LoadOptions): Promise<LoadResult> {
    if (doc.uri.scheme !== 'file' || doc.isUntitled) {
      throw unsupported('Only a file saved on disk can be checked: the compiler reads the file, not the editor.');
    }
    const root = await this.deps.projects.classify(doc.fileName);
    const session = this.deps.pool.sessionFor(root, 'check');
    const cwd = session.cwd;
    // Checked once now, so that nothing is started (or asked) for a load that would be refused …
    const early = await this.withinLimit(this.loadRefusal(root, session, doc.fileName));
    if (typeof early !== 'string') {
      this.deps.pool.packageChanged(root, early.detail);
      throw early.error;
    }
    const realCwd = early;
    const sent = this.loadPath(cwd, realCwd, doc.fileName);
    // … and again when the load is the next to be sent, to a process that has started and answered
    // (module comment): until then a first load waits for the toolchain scan, the consent question
    // and the start, and any load for the requests before it.
    let refused: LoadRefusal | undefined;
    const beforeSend = async (): Promise<void> => {
      const now = await this.loadRefusal(root, session, doc.fileName, realCwd);
      if (typeof now !== 'string') {
        refused = now;
        throw now.error;
      }
    };
    let reply: Reply;
    try {
      reply = await session.request(loadFile(sent), {
        kind: 'load',
        file: doc.isDirty ? { path: sent } : { path: sent, version: doc.version },
        beforeSend,
        ...(options?.urgent === undefined ? {} : { urgent: options.urgent }),
      });
    } catch (error) {
      if (refused !== undefined && error === refused.error) {
        // The load is out of the queue: the stop cancels only what waited behind it.
        this.deps.pool.packageChanged(root, refused.detail);
      }
      throw error;
    }
    const result = loadDiagnostics(reply, {
      loadedPath: doc.fileName,
      sentPath: sent,
      cwd,
      ipkgPath: root.kind === 'project' ? root.ipkgPath : undefined,
      includeSourceExcerpt: this.deps.config.diagnostics().includeSourceExcerpt,
      warningsAsErrors:
        session.launch?.args.includes('-Werror') === true ||
        (root.kind === 'project' && root.model.status === 'ok' && packageOptionWords(root.model.model.opts).includes('-Werror')),
      documentFor: await this.documents(reply, cwd, doc.fileName),
    });
    return this.toLoadResult(result);
  }

  private range(range: EditorRange): vscode.Range {
    const { api } = this.deps;
    return new api.Range(
      new api.Position(range.start.line, range.start.character),
      new api.Position(range.end.line, range.end.character),
    );
  }

  private diagnostic(record: DiagnosticRecord): vscode.Diagnostic {
    const { api } = this.deps;
    const severity = record.severity === 'error' ? api.DiagnosticSeverity.Error : api.DiagnosticSeverity.Warning;
    const diagnostic = new api.Diagnostic(this.range(record.range), record.message, severity);
    diagnostic.source = 'idris2';
    if (record.related.length > 0) {
      diagnostic.relatedInformation = record.related.map(
        (r) => new api.DiagnosticRelatedInformation(new api.Location(api.Uri.file(r.path), this.range(r.range)), r.message),
      );
    }
    return diagnostic;
  }

  private toLoadResult(result: LoadDiagnostics): LoadResult {
    const { api } = this.deps;
    return {
      ok: result.ok,
      diagnostics: [...result.files].map(([file, records]) => [api.Uri.file(file), records.map((r) => this.diagnostic(r))] as const),
      ...(result.packageError === undefined
        ? {}
        : { packageError: { uri: api.Uri.file(result.packageError.path), message: result.packageError.message } }),
      ...(result.blockedBy === undefined ? {} : { blockedBy: result.blockedBy.map((file) => api.Uri.file(file)) }),
    };
  }

  typeAt(): Promise<TypeInfo | undefined> {
    return notYet('Showing a type');
  }

  docsFor(): Promise<RichText | undefined> {
    return notYet('Showing documentation');
  }

  definition(): Promise<vscode.Location[]> {
    return notYet('Go to Definition');
  }

  holes(): Promise<Hole[]> {
    return notYet('Listing holes');
  }

  edit(): Promise<EditResult> {
    return notYet('Editing with the compiler');
  }

  evaluate(): Promise<RichText> {
    return notYet('Evaluation');
  }

  browseNamespace(): Promise<NamespaceEntry[]> {
    return notYet('Browsing a namespace');
  }

  /** Holds no resources: the pool owns the sessions. */
  dispose(): void {}
}
