/**
 * The session pool (docs/ARCHITECTURE.md §4, §5; ROADMAP M2, M3): one `IdeSession` per root and
 * role (`check` since M2, `eval` since M3; `types.ts` `SessionRole`), created when first asked for
 * and started by its first request. The contract is `SessionPool` in `types.ts`; `extension.ts`
 * creates the pool with `createSessionPool` and disposes it in `deactivate()`, which kills every
 * session process at once. Both roles go through the same `prepare` before every spawn (below),
 * in the same directory, with the same transport rule and time limits.
 *
 * - **Command line** (ARCHITECTURE §5.2, `sessionLaunch`): the `idris2` of the current toolchain
 *   snapshot (its `probed` location) with `--ide-mode` (the default on every platform) or, when
 *   the user opted into the socket, `--ide-mode-socket` (`idris2.ideMode.transport`, ROADMAP §9
 *   Q20; `core/config.ts` `TransportKind`), `--no-color`, `-p <pkg>` for each of
 *   `idris2.ideMode.loosePackages` for a loose file only (F25), `--build-dir
 *   <effectiveCheckBuildDir>` when `idris2.ideMode.isolateBuildDir` is on and nothing else sets
 *   the build directory (`checkBuildDir`: a `builddir` or a `--build-dir` in the `.ipkg`'s `opts`
 *   overrides the flag at every load, F12; D5; a `--build-dir` in `extraArgs` comes after it),
 *   then `idris2.ideMode.extraArgs`; never `--find-ipkg` (F13). The `eval` session's command line
 *   differs in the build directory only: `--build-dir <cwd>/build/.vscode-idris2-eval` whenever the
 *   package and `extraArgs` set none, whatever `isolateBuildDir` says (`evalBuildDir`; the reason is
 *   in `types.ts` `SessionRole`). An `extraArgs` that names
 *   `--ide-mode` or `--ide-mode-socket` starts nothing (`extraArgsProblem`): the compiler takes
 *   the socket from anywhere on its command line, so extraArgs, which a trusted workspace can set,
 *   would open the socket's unauthenticated port past `transport`'s user-settings-only rule, and
 *   past the takeover detection, which follows the launch's `transport` (*verification after
 *   Q20–Q22*). The working directory is `ProjectIndex.sessionCwd(root)`: the
 *   `.ipkg`'s directory, or a loose file's (D4). The environment is the snapshot's
 *   `idris2.toolchain.env`, overlaid on the Extension Host's. Files are sent as absolute paths
 *   (F13) by the callers of `request`.
 * - **Before every spawn** (`prepare`): in Restricted Mode nothing starts and nobody is asked
 *   (`Unsupported`); a running toolchain scan, or the first one, is waited for, so that the
 *   `idris2` the settings name now is started; without a `probed` `idris2` → `ToolchainMissing`;
 *   an `extraArgs` naming the transport flags (above) → `BackendCrashed` (these three are
 *   `startProblem`, which `backend.ts` also reports before the checks ask the consent question
 *   themselves, for a background check under `idris2.ideMode.maxBackgroundChecks`);
 *   then the consent gate (`SessionGate.permit` for the working directory and the root's
 *   `.ipkg`, which may ask the user; `Unsupported` with the reason when it refuses); then the
 *   snapshot is read again (a scan may have run while the user was asked) and the command line
 *   computed from it; last, after that wait, the gate judges the directory again
 *   (`SessionGate.recheck`, which reads its real path again), so that a folder revoked, a
 *   workspace folder removed, or a directory replaced by a symbolic link while the scan ran is not
 *   started in; only microtasks separate that verdict from the spawn. The process is started in
 *   the real path that verdict judged (`SessionLaunch.realCwd`), not in the spelled one, whose
 *   symbolic links the child would resolve again when it changes into it: a link re-pointed in
 *   between would have started it in a directory the gate never judged (*M2 second verification of
 *   the third review*, reasoned from the code). The isolated `--build-dir` is placed in that real
 *   path too (`sessionLaunch`'s `buildBase`): built from the spelled one, a link on it re-pointed
 *   during a load redirected that load's TTC reads and writes, and a spelled path through a link
 *   whose name the compiler's path parser misreads (`\`, `:`, `?`) passed the load's check of the
 *   real path while the compiler wrote elsewhere (*verification after Q20–Q22*, reasoned from the
 *   code and `Libraries/Utils/Path.idr`); a running session's command line is compared with one
 *   built on the real path it was started in (`reconcile`), and `effectiveCheckBuildDir` names the
 *   directory in it while that session has one. A directory component of that real path replaced
 *   in between still counts, which needs write access to its parent [reasoned, not run]. On POSIX
 *   only: on Windows the real path of a mapped network drive is a UNC path, which `cmd.exe` (the
 *   route of a `.cmd` wrapper) does not take as its working directory [open: recalled — it says
 *   "CMD does not support UNC paths as current directories" and falls back to the Windows
 *   directory — not checked], and the Windows side is [open] (E13); there the spelled path is used.
 * - **Restarts** (ARCHITECTURE §5.1 "Configuration changes"). When `idris2.ideMode.*` changes, a
 *   toolchain scan publishes a new snapshot, or `sessionFor` is given a changed classification of
 *   a root (e.g. its `.ipkg` gained a `builddir`), every running session (`starting`, `ready`,
 *   `busy`) whose command line would now differ — executable, arguments, working directory,
 *   environment or transport — is restarted (an `eval` session is stopped instead, *Stop, release
 *   and idle*), and every `failed` session returns to `stopped`, so
 *   that its next request tries again; both with the cause `reconfigure`, on which the checks
 *   check the visible documents of the root again (`IdeMode.onDidRestart`). **Deviation from ARCHITECTURE §5.1 / ROADMAP M2** ("any
 *   `idris2.toolchain.*` or `idris2.ideMode.*` setting restarts every session"): a change that
 *   leaves the command line as it is (the three time limits, a toolchain setting that finds the
 *   same `idris2`) does not kill a running process; the time limits apply from the next request
 *   and the idle limit from the next time the session becomes idle, since the sessions read them
 *   then. A session that is `restarting` picks the new command line up when it starts again.
 * - **Consent withdrawn.** When the gate's verdicts may have changed (`SessionGate.onDidChange`),
 *   every session that is not `stopped` or `failed` and whose directory `SessionGate.current`
 *   does not allow (refused, or unknown again) is stopped with cause `consentRevoked`.
 * - **Stop, release and idle.** `stop(root?)` stops sessions of both roles (Stop Backend, cause
 *   `stop`); `restart(root)` stops the root's `eval` session (cause `stop`) and restarts its `check`
 *   session, and `restartAll()` restarts every `check` session that is not stopped and stops every
 *   `eval` session, so an `eval` session starts again at the next evaluation; `cancelEvaluation(root)`
 *   stops the root's `eval` session (cause `stop`: its evaluation was cancelled, and IDE mode has no
 *   cancel), and so does `releaseEvaluation(root, detail)` (after an evaluation that ran long,
 *   `backend.ts`); `release(root)` stops a root's sessions when its last open document was closed (cause
 *   `closed`; `features/diagnostics/checks.ts` decides when); `packageChanged(root)` stops them
 *   when the root's package file is not the one the compiler would find any more (cause
 *   `packageChanged`; `backend.ts` decides); a session stops itself after
 *   `idris2.ideMode.idleTimeout` without a request (`session.ts`), an `eval` session after
 *   `EVAL_IDLE_TIMEOUT_MS` (2 min) when that is shorter — evaluations come in bursts, and its next
 *   start costs a start and a load of the file, which the evaluation makes anyway —, none when the
 *   setting is 0. Each starts again on its next request. **An `eval` session never starts a process
 *   by itself**: it is stopped, not restarted, when its command line changes (cause `reconfigure`,
 *   *Restarts*) and by the two Restart Backend commands, and it does not restart after its
 *   process ended unexpectedly (`session.ts`, *Unexpected ends*), so that no evaluation process
 *   runs that no evaluation asked for (*review of M3*).
 * - **At most `idris2.ideMode.maxSessions`** (ROADMAP §9 Q21; `0`, the default, is no limit and
 *   changes nothing above). A `check` session counts while it has a process or is getting one
 *   (`starting`, `ready`, `busy`, `restarting`); an `eval` session — a process of the same size (it
 *   loads the same modules; a `check` session took 206–278 MiB on `contrib`,
 *   docs/measurements/first-load.md [live]) — only while it is also `idle`. One that is being
 *   started or evaluating is left out, so that an evaluation never stops another session to make
 *   room for itself; once it has answered it counts, and is the first one stopped (below). Until the
 *   fourth review of M3 it counted from its start: with a limit of 2, Evaluate in project P stopped
 *   project Q's idle `check` session, whose next check started it again (a start, a load that counts
 *   as `rebuilt` and drops its kept answers) and stopped the evaluation session in turn
 *   [unit-level, the reviewer's probe with the real pool]. While more count than the limit, the pool stops, with
 *   cause `evicted`, sessions that are `idle` (`IdeSession.idle`: `ready`, nothing in flight or
 *   waiting): first the `eval` sessions, the active root's included, then the `check` sessions that
 *   are not the active root's (`setActiveRoot`), each group least recently used first, until the
 *   count is within the limit or no such session is left. The `eval` sessions go first because
 *   they are the lesser role (a stopped one costs the next evaluation a start and a load, while a
 *   stopped `check` session costs the checks and every query of its root), and the active root's
 *   `eval` session too, since with a limit of 1 the active root's two sessions would otherwise stay
 *   above it for good. A busy session, and the active root's `check` session, are never stopped for
 *   it, so the number of processes can stay above the limit until one becomes idle. While the active document's
 *   root is `pending` (a file just opened is being classified) nothing is stopped for the limit:
 *   that root may be the one whose session is idle
 *   (*verification after Q20–Q22*: it was stopped, and the file's first load started it again). "Used" is a request sent or answered, or a start (the order of those events, not the
 *   clock). The limit is applied after every state change of a session, after a change of the
 *   setting and after a change of the active root, in a microtask, so never inside a session's
 *   own state change. An evicted session starts again at its root's next request, after the gate.
 * - **Which settings restart what.** A change of `IDE_MODE_SESSION_KEYS` (`core/config.ts`) is
 *   handled as above (*Restarts*). A change of `maxSessions` or `maxBackgroundChecks` only is not:
 *   no command line changes, so nothing is restarted and a `failed` session stays `failed` (nothing
 *   about why it failed changed); a lower `maxSessions` stops what exceeds it at once, a higher one
 *   stops nothing (`maxBackgroundChecks` is the checks', `features/diagnostics/checks.ts`).
 */
import * as path from 'path';
import { IDE_MODE_SESSION_KEYS, type IdeModeSettings } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { IdrisException, unsupported } from '../../core/errors';
import { Emitter } from '../../core/event';
import { shownPath } from '../../core/notificationText';
import { RESTRICTED_MODE_REASON } from '../../core/process';
import type { GateVerdict } from '../../core/trust';
import { packageOptionWords } from '../../project/ipkg';
import type { Classification } from '../../project/types';
import type { ToolchainSnapshot } from '../../toolchain/types';
import { rootKey } from '../registry';
import { createSession, DEFAULT_SESSION_TIMING, systemClock, type Clock, type ManagedSession, type SessionTiming, type SpawnPlan } from './session';
import { createTransport } from './transport';
import type {
  IdeSession,
  SessionLaunch,
  SessionPool,
  SessionPoolChange,
  SessionPoolDeps,
  SessionRole,
  Transport,
} from './types';

/**
 * The idle limit of an `eval` session (module comment, *Stop, release and idle*):
 * `idris2.ideMode.idleTimeout` when that is shorter, and none when it is 0.
 */
export const EVAL_IDLE_TIMEOUT_MS = 2 * 60_000;

/** What `createTunedSessionPool` takes besides the dependencies; `createSessionPool` uses the defaults. */
export interface SessionPoolTuning {
  readonly timing: SessionTiming;
  readonly clock: Clock;
  createTransport(launch: SessionLaunch): Transport;
}

/**
 * The directory the last `--build-dir` of `words` names, as the compiler's option parser reads
 * a command line (`MkOpt ["--build-dir"] [Required "dir"]`, `src/Idris/CommandLine.idr` 254, the
 * options applied in order by `preOptions`, `src/Idris/SetOptions.idr` 442 on v0.8.0 [src]):
 * the word after each `--build-dir`. `undefined` when there is none, or when the last word is a
 * `--build-dir` without its directory, which fails the whole parse (then none of the options
 * applies). The other options are not modelled: a `--build-dir` that another option takes as its
 * argument (`-p --build-dir`) is read as a `--build-dir` here.
 */
function buildDirOption(words: readonly string[]): string | undefined {
  let dir: string | undefined;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--build-dir') {
      if (i + 1 === words.length) {
        return undefined;
      }
      dir = words[++i];
    }
  }
  return dir;
}

/**
 * The build directory of `root`'s `check` session (D5, F12, F32), as the compiler ends up using
 * it: at every `:load-file` of a project, `findIpkg` applies the `.ipkg`'s `builddir` and then
 * its `opts` over the command line's `--build-dir` (`src/Idris/Package.idr` 1093–1110 on v0.8.0
 * [src]; F12 and its addendum [live]), and on the command line the last `--build-dir` wins. So
 * it is, from the strongest: a `--build-dir` in the `.ipkg`'s `opts`; its `builddir`; a
 * `--build-dir` in `idris2.ideMode.extraArgs`, which comes after the extension's own arguments;
 * then `<cwd>/build/.vscode-idris2` when `isolateBuildDir` is on, else `<cwd>/build`. Relative
 * directories are resolved against `cwd`, where the compiler applies them (F13). A loose file,
 * and a root whose `.ipkg` could not be read, have no `builddir` or `opts`. `isolated` says
 * whether the extension must pass the directory as `--build-dir`: only in the isolated case.
 */
export function checkBuildDir(
  root: Classification,
  cwd: string,
  settings: Pick<IdeModeSettings, 'isolateBuildDir' | 'extraArgs'>,
  platform: NodeJS.Platform,
): { readonly dir: string; readonly isolated: boolean } {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const chosen = compilerBuildDir(root, settings);
  if (chosen !== undefined) {
    return { dir: pathApi.resolve(cwd, chosen), isolated: false };
  }
  return settings.isolateBuildDir
    ? { dir: pathApi.join(cwd, 'build', '.vscode-idris2'), isolated: true }
    : { dir: pathApi.join(cwd, 'build'), isolated: false };
}

/**
 * The build directory that the package or `idris2.ideMode.extraArgs` sets, as written
 * (`checkBuildDir`: a `--build-dir` in the `.ipkg`'s `opts`, its `builddir`, a `--build-dir` in
 * `extraArgs`); `undefined` when the extension chooses it.
 */
function compilerBuildDir(root: Classification, settings: Pick<IdeModeSettings, 'extraArgs'>): string | undefined {
  const model = root.kind === 'project' && root.model.status === 'ok' ? root.model.model : undefined;
  return buildDirOption(packageOptionWords(model?.opts)) ?? model?.builddir ?? buildDirOption(settings.extraArgs);
}

/**
 * The `--build-dir` of `root`'s `eval` session (`types.ts` `SessionRole`): `<cwd>/build/.vscode-idris2-eval`
 * whenever the extension chooses the build directory — the package and `extraArgs` set none —,
 * whatever `idris2.ideMode.isolateBuildDir` says, so that the `eval` session never compiles into
 * the `check` session's directory, whose next load would then report nothing for a file the `eval`
 * session built (F7); `undefined` when the compiler takes the directory from the package or
 * `extraArgs` for both sessions (a documented limitation, as for the user's own builds, D5).
 */
export function evalBuildDir(
  root: Classification,
  cwd: string,
  settings: Pick<IdeModeSettings, 'extraArgs'>,
  platform: NodeJS.Platform,
): string | undefined {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return compilerBuildDir(root, settings) === undefined ? pathApi.join(cwd, 'build', '.vscode-idris2-eval') : undefined;
}

/**
 * The command line of `root`'s session of `role` (`check` unless given; see the module comment).
 * `buildBase`: the directory the extension's `--build-dir` is placed in — the real path the
 * process starts in (`SessionLaunch.realCwd`, POSIX), so that the build directory, too, is the one
 * the gate judged and not reached through the spelled path's symbolic links; `cwd` when unset.
 */
export function sessionLaunch(input: {
  readonly root: Classification;
  readonly role?: SessionRole;
  readonly cwd: string;
  readonly buildBase?: string;
  readonly idris2: string;
  readonly env: Readonly<Record<string, string>>;
  readonly settings: IdeModeSettings;
  readonly platform: NodeJS.Platform;
}): SessionLaunch {
  const { root, cwd, settings } = input;
  const transport = settings.transport;
  const args = [transport === 'socket' ? '--ide-mode-socket' : '--ide-mode', '--no-color'];
  if (root.kind === 'loose') {
    for (const pkg of settings.loosePackages) {
      args.push('-p', pkg);
    }
  }
  const base = input.buildBase ?? cwd;
  if (input.role === 'eval') {
    const evalDir = evalBuildDir(root, base, settings, input.platform);
    if (evalDir !== undefined) {
      args.push('--build-dir', evalDir);
    }
  } else {
    const build = checkBuildDir(root, base, settings, input.platform);
    if (build.isolated) {
      args.push('--build-dir', build.dir);
    }
  }
  args.push(...settings.extraArgs);
  return { executable: input.idris2, args, cwd, env: input.env, transport };
}

/**
 * Why `idris2.ideMode.extraArgs` may not be used: it names `--ide-mode` or `--ide-mode-socket`
 * (module comment, *Command line*); `undefined` when it does not. The compiler's option parser
 * takes `--ide-mode-socket` wherever it stands as a flag (`MkOpt ["--ide-mode-socket"] [Optional
 * "host:port"]`, `src/Idris/CommandLine.idr` 324–325 on v0.8.0 [src]), and socket mode wins over
 * `--ide-mode` (`ideModeSocket` holds when any `IdeModeSocket` option is given, `SetOptions.idr`
 * 585–588, and `Driver.idr` 210–217 serves stdio only `if not ideSocket` [src]; in the
 * *verification after Q20–Q22* `timeout 6 idris2 --ide-mode --no-color --ide-mode-socket` printed a
 * port and waited [live]); a word taken as another option's argument (`-p --ide-mode-socket`) is
 * refused too, without modelling the other options.
 */
export function extraArgsProblem(extraArgs: readonly string[]): string | undefined {
  const flag = extraArgs.find((word) => word === '--ide-mode' || word === '--ide-mode-socket');
  return flag === undefined
    ? undefined
    : `The Idris 2 session was not started: idris2.ideMode.extraArgs contains "${flag}". The transport is chosen by ` +
        'idris2.ideMode.transport (in user settings only); remove the flag from extraArgs.';
}

/** Which parts of two command lines differ, in words; `[]` when they are the same. */
export function launchDifferences(a: SessionLaunch, b: SessionLaunch): string[] {
  const differences: string[] = [];
  if (a.executable !== b.executable) {
    differences.push(`idris2 ${a.executable} → ${b.executable}`);
  }
  if (a.cwd !== b.cwd) {
    differences.push(`working directory ${a.cwd} → ${b.cwd}`);
  }
  if (a.transport !== b.transport) {
    differences.push(`transport ${a.transport} → ${b.transport}`);
  }
  if (a.args.length !== b.args.length || a.args.some((arg, i) => arg !== b.args[i])) {
    differences.push('arguments');
  }
  const keys = new Set([...Object.keys(a.env), ...Object.keys(b.env)]);
  if ([...keys].some((key) => a.env[key] !== b.env[key])) {
    differences.push('environment (idris2.toolchain.env)');
  }
  return differences;
}

/** Why the snapshot has no `idris2` to start, or `undefined` when it has a `probed` one. */
function toolchainProblem(snapshot: ToolchainSnapshot): string | undefined {
  const idris2 = snapshot.idris2;
  switch (idris2.status) {
    case 'probed':
      return undefined;
    case 'missing':
      return `No Idris 2 compiler to start: ${idris2.reason}`;
    case 'failed':
      return `The Idris 2 compiler at ${idris2.location.path} does not work: ${idris2.reason}`;
    case 'located':
      return `The Idris 2 compiler at ${idris2.location.path} has not been run yet (Restricted Mode).`;
  }
}

/** Why a session in `dir` may not start (any more), for the requests it rejects. */
function refusedText(verdict: GateVerdict | undefined, dir: string): string {
  return verdict === undefined || verdict.allowed ? `running Idris 2 in ${shownPath(dir)} is no longer allowed` : refusalText(verdict, dir);
}

function refusalText(verdict: Extract<GateVerdict, { allowed: false }>, dir: string): string {
  switch (verdict.reason) {
    case 'restrictedMode':
      return RESTRICTED_MODE_REASON;
    case 'denied':
      return `Idris 2 is not started in ${shownPath(dir)}: "Don't Allow" was chosen for this folder in this window. The Idris 2 status item offers to allow it.`;
    case 'unanswered':
      return `Idris 2 is not started in ${shownPath(dir)}: the question whether it may run there was closed without an answer. The Idris 2 status item offers to ask again.`;
    case 'unresolved':
      return (
        `Idris 2 is not started in ${shownPath(dir)}: its real path could not be read (${verdict.error ?? 'no reason given'}), ` +
        'so whether it lies inside a trusted workspace folder cannot be judged.'
      );
  }
}

export function createSessionPool(deps: SessionPoolDeps): SessionPool {
  return createTunedSessionPool(deps, {
    timing: DEFAULT_SESSION_TIMING,
    clock: systemClock,
    createTransport: (launch) =>
      createTransport(launch, { codec: deps.codec, trust: deps.trust, log: deps.log, platform: deps.platform, processEnv: deps.processEnv }),
  });
}

/** `createSessionPool` with explicit timing, clock and transports; exported for the unit tests. */
export function createTunedSessionPool(deps: SessionPoolDeps, tuning: SessionPoolTuning): SessionPool {
  const sessions = new Map<string, ManagedSession>();
  const changed = new Emitter<SessionPoolChange>();
  const subscriptions = new DisposableStore();
  /** Pending waits for a snapshot; resolved with `undefined` at dispose. */
  const waits = new Set<IDisposable>();
  const warnedProtocols = new Set<string>();
  let lastSnapshot = deps.toolchain.current;
  let disposed = false;
  /** When each session was last used (module comment, *At most `maxSessions`*): the order of the uses. */
  const lastUse = new Map<ManagedSession, number>();
  let uses = 0;
  /** `rootKey` of the active document's root (`setActiveRoot`). */
  let activeKey: string | undefined;
  /** The active document's root is being found (`setActiveRoot('pending')`): nothing is evicted. */
  let activePending = false;
  /** A run of `limitSessions` is scheduled. */
  let limitScheduled = false;

  const keyOf = (root: Classification, role: SessionRole): string => `${role}|${rootKey(root)}`;

  /** The command line of `root`'s session of `role` now; `realCwd`: the real path it starts in (POSIX), with the build directory in it. */
  function launchFor(root: Classification, role: SessionRole, snapshot: ToolchainSnapshot, realCwd?: string): SessionLaunch | undefined {
    const idris2 = snapshot.idris2;
    if (idris2.status !== 'probed') {
      return undefined;
    }
    const launch = sessionLaunch({
      root,
      role,
      cwd: deps.projects.sessionCwd(root),
      buildBase: realCwd,
      idris2: idris2.location.path,
      env: snapshot.settings.env,
      settings: deps.config.ideMode(),
      platform: deps.platform,
    });
    return realCwd === undefined ? launch : { ...launch, realCwd };
  }

  /** The current snapshot once no scan is running; `undefined` if the pool is disposed first. */
  function settledSnapshot(): Promise<ToolchainSnapshot | undefined> {
    const settled = (): ToolchainSnapshot | undefined =>
      deps.toolchain.scanning ? undefined : deps.toolchain.current;
    const now = settled();
    if (now !== undefined || disposed) {
      return Promise.resolve(now);
    }
    return new Promise((resolve) => {
      const wait: IDisposable = {
        dispose: () => {
          subscription.dispose();
          waits.delete(wait);
          resolve(undefined);
        },
      };
      const subscription = deps.toolchain.onDidChange(() => {
        const snapshot = settled();
        if (snapshot !== undefined) {
          subscription.dispose();
          waits.delete(wait);
          resolve(snapshot);
        }
      });
      waits.add(wait);
    });
  }

  /** What keeps a session from starting before the consent question (`SessionPool.startProblem`). */
  async function startProblem(): Promise<IdrisException | undefined> {
    if (!deps.trust.isTrusted) {
      return unsupported(RESTRICTED_MODE_REASON);
    }
    const before = await settledSnapshot();
    if (before === undefined) {
      return new IdrisException({ kind: 'BackendCrashed', message: 'The session pool has been shut down.' });
    }
    const missing = toolchainProblem(before);
    if (missing !== undefined) {
      return new IdrisException({ kind: 'ToolchainMissing', message: missing });
    }
    // Checked before the question (nothing would start) and again right before the command line is built.
    const badArgs = extraArgsProblem(deps.config.ideMode().extraArgs);
    if (badArgs !== undefined) {
      return new IdrisException({ kind: 'BackendCrashed', message: badArgs });
    }
    return undefined;
  }

  async function prepare(session: IdeSession): Promise<SpawnPlan> {
    const problem = await startProblem();
    if (problem !== undefined) {
      return { refused: problem };
    }
    const root = session.root;
    const verdict = await deps.gate.permit(session.cwd, { ipkg: root.kind === 'project' ? root.ipkgPath : undefined });
    if (!verdict.allowed) {
      return { refused: unsupported(refusalText(verdict, session.cwd)), ...(verdict.reason === 'unresolved' ? { unresolved: true } : {}) };
    }
    const snapshot = await settledSnapshot();
    if (snapshot === undefined) {
      return { refused: new IdrisException({ kind: 'BackendCrashed', message: 'The session pool has been shut down.' }) };
    }
    // The wait above can take seconds (a scan); the gate's `onDidChange` does not stop a session
    // that is still `stopped` while it prepares, so the directory is judged again, as it is now,
    // with no further wait for anything but that between this verdict and the spawn.
    const now = await deps.gate.recheck(session.cwd);
    if (disposed) {
      return { refused: new IdrisException({ kind: 'BackendCrashed', message: 'The session pool has been shut down.' }) };
    }
    if (now === undefined || !now.allowed) {
      return { refused: unsupported(refusedText(now, session.cwd)), ...(now?.allowed === false && now.reason === 'unresolved' ? { unresolved: true } : {}) };
    }
    const badArgsNow = extraArgsProblem(deps.config.ideMode().extraArgs);
    if (badArgsNow !== undefined) {
      return { refused: new IdrisException({ kind: 'BackendCrashed', message: badArgsNow }) };
    }
    // Started in the real path just judged, not through the links of the spelled one, with the
    // isolated build directory in it too (module comment).
    const launch = launchFor(session.root, session.role, snapshot, deps.platform === 'win32' ? undefined : now.realDir);
    if (launch === undefined) {
      return { refused: new IdrisException({ kind: 'ToolchainMissing', message: toolchainProblem(snapshot) ?? '' }) };
    }
    return { launch };
  }

  /**
   * Restarts `session` if it runs with another command line than it would get now; an `eval`
   * session is stopped instead, and starts with the new one at the next evaluation (module comment,
   * *Stop, release and idle*).
   */
  function reconcile(session: ManagedSession, reason: string): void {
    if (session.state !== 'starting' && session.state !== 'ready' && session.state !== 'busy') {
      return;
    }
    const running = session.launch;
    const snapshot = deps.toolchain.current;
    if (running === undefined || snapshot === undefined) {
      return;
    }
    // Built on the real path the process was started in, as its own command line was.
    const next = launchFor(session.root, session.role, snapshot, running.realCwd);
    const differences = next === undefined ? [toolchainProblem(snapshot) ?? ''] : launchDifferences(running, next);
    if (differences.length === 0) {
      return;
    }
    const detail = `${reason}: ${differences.join(', ')}`;
    if (session.role === 'eval') {
      session.stop('reconfigure', `${detail}; the evaluation session starts again at the next evaluation`);
    } else {
      session.restart(detail, 'reconfigure');
    }
  }

  function reconcileAll(reason: string): void {
    for (const session of sessions.values()) {
      if (session.state === 'failed') {
        session.reset(reason);
      } else {
        reconcile(session, reason);
      }
    }
  }

  subscriptions.add(
    deps.toolchain.onDidChange(() => {
      const current = deps.toolchain.current;
      if (current === undefined || current === lastSnapshot) {
        return;
      }
      lastSnapshot = current;
      reconcileAll('a new toolchain scan');
    }),
  );
  subscriptions.add(
    deps.config.onDidChange('ideMode', (change) => {
      if (IDE_MODE_SESSION_KEYS.some((key) => change.affects(key))) {
        reconcileAll('the idris2.ideMode settings changed');
      }
      if (change.affects('ideMode.maxSessions')) {
        scheduleLimit();
      }
    }),
  );
  subscriptions.add(
    deps.gate.onDidChange(() => {
      for (const session of sessions.values()) {
        if (session.state === 'stopped' || session.state === 'failed') {
          continue;
        }
        const verdict = deps.gate.current(session.cwd);
        if (verdict === undefined || !verdict.allowed) {
          session.stop('consentRevoked', refusedText(verdict, session.cwd));
        }
      }
    }),
  );

  /** Whether `session` counts against `idris2.ideMode.maxSessions`: a process runs or is being started. */
  function running(session: ManagedSession): boolean {
    return session.state !== 'stopped' && session.state !== 'failed';
  }

  /** Applies `idris2.ideMode.maxSessions` in a microtask (module comment); several requests make one run. */
  function scheduleLimit(): void {
    if (limitScheduled || disposed || deps.config.ideMode().maxSessions <= 0) {
      return;
    }
    limitScheduled = true;
    queueMicrotask(() => {
      limitScheduled = false;
      limitSessions();
    });
  }

  /**
   * While more sessions count than the limit, stops idle ones (module comment): first the `eval`
   * sessions, the active root's included, then the `check` sessions that are not the active root's,
   * each group least recently used first.
   */
  function limitSessions(): void {
    const max = deps.config.ideMode().maxSessions;
    if (disposed || max <= 0 || activePending) {
      return;
    }
    const counted = [...sessions.values()].filter(running);
    // An `eval` session counts only while idle (module comment): one being started or evaluating
    // does not make room for itself by stopping another root's `check` session.
    let excess = counted.filter((session) => session.role === 'check' || session.idle).length - max;
    if (excess <= 0) {
      return;
    }
    const byUse = (a: ManagedSession, b: ManagedSession): number => (lastUse.get(a) ?? 0) - (lastUse.get(b) ?? 0);
    const idle = counted.filter((session) => session.idle);
    const candidates = [
      ...idle.filter((session) => session.role === 'eval').sort(byUse),
      ...idle.filter((session) => session.role === 'check' && rootKey(session.root) !== activeKey).sort(byUse),
    ];
    for (const session of candidates) {
      if (excess <= 0) {
        break;
      }
      excess--;
      session.stop(
        'evicted',
        `idris2.ideMode.maxSessions is ${max} and ${counted.length} IDE-mode sessions were running; ` +
          (session.role === 'eval'
            ? 'this was an idle evaluation session, which starts again at the next evaluation'
            : 'this was the least recently used idle one, and it starts again at its next check'),
      );
    }
  }

  function create(root: Classification, role: SessionRole): ManagedSession {
    const session = createSession({
      role,
      root,
      cwd: deps.projects.sessionCwd(root),
      prepare,
      createTransport: (launch) => tuning.createTransport(launch),
      codec: deps.codec,
      trace: deps.trace,
      log: deps.log,
      clock: tuning.clock,
      timing: tuning.timing,
      limits: () => {
        const settings = deps.config.ideMode();
        return {
          requestTimeoutMs: settings.requestTimeoutMs,
          longActionTimeoutMs: settings.longActionTimeoutMs,
          idleTimeoutMs: role === 'eval' && settings.idleTimeoutMs > 0 ? Math.min(settings.idleTimeoutMs, EVAL_IDLE_TIMEOUT_MS) : settings.idleTimeoutMs,
        };
      },
      onNewerProtocol: (warning) => {
        if (!warnedProtocols.has(warning)) {
          warnedProtocols.add(warning);
          deps.log.warn(warning);
        }
      },
    });
    session.onDidChangeState((change) => {
      if (change.state === 'starting' || change.state === 'busy' || (change.state === 'ready' && change.cause === 'reply')) {
        lastUse.set(session, ++uses);
      }
      changed.fire({ session, change });
      scheduleLimit();
    });
    sessions.set(keyOf(root, role), session);
    return session;
  }

  function sessionsOf(root: Classification | undefined): ManagedSession[] {
    const key = root === undefined ? undefined : rootKey(root);
    return [...sessions.values()].filter((session) => key === undefined || rootKey(session.root) === key);
  }

  const pool: SessionPool = {
    sessionFor(root: Classification, role: SessionRole): IdeSession {
      if (disposed) {
        throw new Error('The session pool has been disposed.');
      }
      const existing = sessions.get(keyOf(root, role));
      if (existing === undefined) {
        return create(root, role);
      }
      existing.setRoot(root);
      reconcile(existing, 'the package changed');
      return existing;
    },

    sessions(): readonly IdeSession[] {
      return [...sessions.values()];
    },

    effectiveCheckBuildDir(root: Classification): string {
      // Resolved against the real path the running `check` session was started in (where the
      // compiler resolves a relative builddir, and where the isolated one is placed), else the spelled one.
      const running = sessions.get(keyOf(root, 'check'))?.launch?.realCwd;
      return checkBuildDir(root, running ?? deps.projects.sessionCwd(root), deps.config.ideMode(), deps.platform).dir;
    },

    stop(root?: Classification): void {
      for (const session of sessionsOf(root)) {
        session.stop('stop', root === undefined ? 'Stop Backend, all roots' : 'Stop Backend');
      }
    },

    release(root: Classification): void {
      // Also a `stopped` session: a request still waiting in it (for the consent question) is
      // dropped, so that answering the question later starts nothing.
      for (const session of sessionsOf(root)) {
        session.stop('closed', 'the last open document of its root was closed');
      }
    },

    packageChanged(root: Classification, detail: string): void {
      for (const session of sessionsOf(root)) {
        session.stop('packageChanged', detail);
      }
    },

    restart(root: Classification): void {
      if (disposed) {
        return;
      }
      // The `eval` session starts again at the next evaluation (it has nothing loaded that a check needs).
      sessions.get(keyOf(root, 'eval'))?.stop('stop', 'Restart Backend: the evaluation session starts again at the next evaluation');
      const session = sessions.get(keyOf(root, 'check')) ?? create(root, 'check');
      session.setRoot(root);
      session.restart('Restart Backend');
    },

    restartAll(): void {
      for (const session of sessions.values()) {
        if (session.state === 'stopped') {
          continue;
        }
        if (session.role === 'eval') {
          session.stop('stop', 'Restart Backend, all roots: the evaluation session starts again at the next evaluation');
        } else {
          session.restart('Restart Backend, all roots');
        }
      }
    },

    cancelEvaluation(root: Classification): void {
      sessions.get(keyOf(root, 'eval'))?.stop('stop', 'Evaluate Selection was cancelled; the evaluation session starts again at the next evaluation');
    },

    releaseEvaluation(root: Classification, detail: string): void {
      sessions.get(keyOf(root, 'eval'))?.stop('stop', detail);
    },

    setActiveRoot(root: Classification | 'pending' | undefined): void {
      const pending = root === 'pending';
      const key = root === undefined || root === 'pending' ? undefined : rootKey(root);
      if (key !== activeKey || pending !== activePending) {
        activeKey = key;
        activePending = pending;
        scheduleLimit();
      }
    },

    startProblem,

    onDidChange: changed.event,

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      subscriptions.dispose();
      for (const wait of [...waits]) {
        wait.dispose();
      }
      for (const session of sessions.values()) {
        session.dispose();
      }
      sessions.clear();
      lastUse.clear();
      changed.dispose();
    },
  };
  return pool;
}
