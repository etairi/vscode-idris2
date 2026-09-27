/**
 * The toolchain service (`toolchain/service.ts`; contract `ToolchainService` in
 * `toolchain/types.ts`): scans for `idris2`, `idris2-lsp` and `pack`, runs the version probes,
 * judges the pair, and keeps the result as an immutable `ToolchainSnapshot` until the next scan.
 *
 * One scan:
 * 1. reads `workspace.isTrusted`, the `idris2.toolchain.*` settings, and the effective
 *    environment (the Extension Host's, overlaid with `idris2.toolchain.env`);
 * 2. reads pack's layout and searches for the three tools (`pack.ts`, `discover.ts`: file
 *    system only);
 * 3. if the workspace is trusted, runs through the process runner, one after another:
 *    `idris2 --version`, and when that printed its version line `--ttc-version`, `--paths` and
 *    `--list-packages`, stopping after the first of these three that times out (the others are
 *    recorded as not run: each would wait for its own limit, and a scan is repeated on every
 *    settings change); then `idris2-lsp --version` — each with a 5 s limit, the tool's
 *    directory as working directory and `idris2.toolchain.env` as environment. pack is never
 *    run. In Restricted Mode nothing is run and a found tool is `located`;
 * 4. judges the pair (`verdict.ts`).
 *
 * Scans run one at a time: the first when the service is created (not awaited by `activate`),
 * then on `rescan()`, on a change of `idris2.toolchain.*` and when the workspace is granted
 * trust. A request while a scan runs queues one more scan, which every request made in the
 * meantime shares; it starts when the running one ends, so its snapshot reflects the settings
 * at the time of each of those requests. `onDidChange` fires when `scanning` or `current`
 * changes (once when both change together). After `dispose()` the running scan starts no
 * further probe and is not published, and queued and later requests reject.
 */
import { DisposableStore } from '../core/disposable';
import { Emitter, type Event } from '../core/event';
import { describeFailure, overlayEnvironment, PROBE_TIMEOUT_MS } from '../core/process';
import { discoverTool, type Discovery } from './discover';
import { nodeFileSystem } from './fileSystem';
import { readPackLayout } from './pack';
import type {
  DiscoveryEnvironment,
  Idris2Info,
  LspInfo,
  PackState,
  ProbeRecord,
  ProcessResult,
  ProcessRunner,
  RescanReason,
  ToolchainService,
  ToolchainServiceDeps,
  ToolchainSnapshot,
  ToolLocation,
  ToolState,
} from './types';
import { judgePair } from './verdict';
import {
  IDRIS2_VERSION_PREFIX,
  parseIdris2Version,
  parseListPackages,
  parseLspVersion,
  parsePaths,
  parseTtcVersion,
} from './versions';

/** Thrown by a probe that would start after the service was disposed; ends the scan. */
class ScanCancelled extends Error {
  constructor() {
    super('The toolchain service was disposed during the scan.');
  }
}

/** Runs `location` with each argument list in turn and records every run. */
class ProbeLog {
  readonly probes: ProbeRecord[] = [];

  constructor(
    private readonly runner: ProcessRunner,
    private readonly location: ToolLocation,
    private readonly env: Readonly<Record<string, string>>,
    private readonly cancelled: () => boolean,
  ) {}

  async run(args: readonly string[]): Promise<ProcessResult> {
    if (this.cancelled()) {
      throw new ScanCancelled();
    }
    const result = await this.runner.run({ executable: this.location.path, args, env: this.env, timeoutMs: PROBE_TIMEOUT_MS });
    this.probes.push({ args, result });
    return result;
  }
}

function succeeded(result: ProcessResult): boolean {
  return describeFailure(result, PROBE_TIMEOUT_MS) === undefined;
}

/** "idris2 --version exited with code 2: <first line of stderr>." */
function failureReason(command: string, result: ProcessResult): string {
  const failure = describeFailure(result, PROBE_TIMEOUT_MS) ?? 'succeeded';
  const firstLine = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  return firstLine === undefined ? `${command} ${failure}.` : `${command} ${failure}: ${firstLine.slice(0, 200)}`;
}

async function probeIdris2(
  runner: ProcessRunner,
  location: ToolLocation,
  env: Readonly<Record<string, string>>,
  cancelled: () => boolean,
): Promise<ToolState<Idris2Info>> {
  const log = new ProbeLog(runner, location, env, cancelled);
  const versionRun = await log.run(['--version']);
  if (!succeeded(versionRun)) {
    return { status: 'failed', location, reason: failureReason('idris2 --version', versionRun), probes: log.probes };
  }
  const parsed = parseIdris2Version(versionRun.stdout);
  if (parsed === undefined) {
    return {
      status: 'failed',
      location,
      reason: `idris2 --version printed no line starting "${IDRIS2_VERSION_PREFIX}".`,
      probes: log.probes,
    };
  }
  // The follow-up probes; after one times out, the rest are not run (module comment).
  const outputs = new Map<string, string>();
  let timedOut: readonly string[] | undefined;
  const notRun: (readonly string[])[] = [];
  for (const args of [['--ttc-version'], ['--paths'], ['--list-packages']]) {
    if (timedOut !== undefined) {
      notRun.push(args);
      continue;
    }
    const result = await log.run(args);
    if (result.timedOut) {
      timedOut = args;
    } else if (succeeded(result)) {
      outputs.set(args[0], result.stdout);
    }
  }
  const ttc = outputs.get('--ttc-version');
  const paths = outputs.get('--paths');
  const packages = outputs.get('--list-packages');
  return {
    status: 'probed',
    location,
    info: {
      versionLine: parsed.versionLine,
      version: parsed.version,
      ttcVersion: ttc === undefined ? undefined : parseTtcVersion(ttc),
      pathsText: paths !== undefined && parsePaths(paths) !== undefined ? paths : undefined,
      packages: packages === undefined ? undefined : parseListPackages(packages),
      probes: log.probes,
      ...(timedOut === undefined || notRun.length === 0 ? {} : { notRun: { after: timedOut, probes: notRun } }),
    },
  };
}

async function probeLsp(
  runner: ProcessRunner,
  location: ToolLocation,
  env: Readonly<Record<string, string>>,
  cancelled: () => boolean,
): Promise<ToolState<LspInfo>> {
  const log = new ProbeLog(runner, location, env, cancelled);
  const result = await log.run(['--version']);
  if (!succeeded(result)) {
    return { status: 'failed', location, reason: failureReason('idris2-lsp --version', result), probes: log.probes };
  }
  const parsed = parseLspVersion(result.stdout);
  if (parsed === undefined) {
    return {
      status: 'failed',
      location,
      reason: 'idris2-lsp --version did not print both an "Idris2 LSP: " and an "Idris2 API: " line.',
      probes: log.probes,
    };
  }
  return { status: 'probed', location, info: { ...parsed, probes: log.probes } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One scan (see the module comment); `cancelled` is asked before each process is started. */
async function scan(
  deps: ToolchainServiceDeps,
  generation: number,
  reason: RescanReason,
  cancelled: () => boolean,
): Promise<ToolchainSnapshot> {
  const trusted = deps.trust.isTrusted;
  const settings = deps.config.toolchain();
  const env = overlayEnvironment(deps.processEnv, settings.env, deps.platform);
  const environment: DiscoveryEnvironment = { platform: deps.platform, homeDir: deps.homeDir, env, settings };
  const layout = await readPackLayout(env, deps.platform, nodeFileSystem);
  const idris2Found = await discoverTool('idris2', environment, layout, nodeFileSystem);
  const lspFound = await discoverTool('idris2-lsp', environment, layout, nodeFileSystem);
  const packFound = await discoverTool('pack', environment, layout, nodeFileSystem);
  const errors: string[] = [];

  async function probe<Info>(
    found: Discovery,
    run: (location: ToolLocation) => Promise<ToolState<Info>>,
  ): Promise<ToolState<Info>> {
    if (!found.found) {
      return { status: 'missing', searched: found.searched, reason: found.reason };
    }
    if (!trusted) {
      return { status: 'located', location: found.location };
    }
    try {
      return await run(found.location);
    } catch (error) {
      if (error instanceof ScanCancelled) {
        throw error;
      }
      // The runner rejects only for invalid requests and in Restricted Mode, neither of which
      // a scan that started trusted makes; this is a bug, reported rather than hidden.
      const message = `Running ${found.location.path} failed unexpectedly: ${errorMessage(error)}`;
      errors.push(message);
      return { status: 'failed', location: found.location, reason: message, probes: [] };
    }
  }

  const idris2 = await probe(idris2Found, (location) => probeIdris2(deps.runner, location, settings.env, cancelled));
  const lsp = await probe(lspFound, (location) => probeLsp(deps.runner, location, settings.env, cancelled));
  const pack: PackState = packFound.found
    ? {
        status: 'found',
        info: {
          location: packFound.location,
          configDir: layout.configDir,
          stateDir: layout.stateDir,
          collection: layout.collection,
          collectionBinDir: layout.collectionBinDir,
        },
      }
    : { status: 'missing', searched: packFound.searched, reason: packFound.reason };
  return {
    generation,
    reason,
    trusted,
    settings,
    idris2,
    lsp,
    pack,
    verdict: judgePair(idris2, lsp),
    errors,
    finishedAt: Date.now(),
  };
}

function summary<Info>(state: ToolState<Info>, version: (info: Info) => string): string {
  switch (state.status) {
    case 'missing':
      return `not found (${state.reason})`;
    case 'located':
      return `at ${state.location.path} (${state.location.detail}; not run)`;
    case 'failed':
      return `at ${state.location.path} (${state.location.detail}) failed: ${state.reason}`;
    case 'probed':
      return `${version(state.info)} at ${state.location.path} (${state.location.detail})`;
  }
}

interface Waiter {
  resolve(snapshot: ToolchainSnapshot): void;
  reject(error: unknown): void;
}

class Service implements ToolchainService {
  private snapshot: ToolchainSnapshot | undefined;
  private active = false;
  private queued: { readonly reason: RescanReason; readonly waiters: Waiter[] } | undefined;
  private generation = 0;
  private disposed = false;
  private readonly changed = new Emitter<void>();
  private readonly subscriptions = new DisposableStore();

  readonly onDidChange: Event<void> = this.changed.event;

  constructor(private readonly deps: ToolchainServiceDeps) {
    this.subscriptions.add(this.changed);
    this.subscriptions.add(deps.config.onDidChange('toolchain', () => this.trigger('settingsChanged')));
    this.subscriptions.add(deps.trust.onDidGrant(() => this.trigger('trustGranted')));
    this.trigger('activation');
  }

  get current(): ToolchainSnapshot | undefined {
    return this.snapshot;
  }

  get scanning(): boolean {
    return this.active;
  }

  rescan(reason: RescanReason): Promise<ToolchainSnapshot> {
    if (this.disposed) {
      return Promise.reject(new Error('The toolchain service has been disposed.'));
    }
    return new Promise<ToolchainSnapshot>((resolve, reject) => {
      if (this.queued === undefined) {
        this.queued = { reason, waiters: [] };
      }
      this.queued.waiters.push({ resolve, reject });
      if (!this.active) {
        void this.drain();
      }
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const queued = this.queued;
    this.queued = undefined;
    queued?.waiters.forEach((w) => w.reject(new Error('The toolchain service was disposed before the scan started.')));
    this.subscriptions.dispose();
  }

  /** A scan requested by an event; its failure is already logged by `drain`. */
  private trigger(reason: RescanReason): void {
    this.rescan(reason).catch(() => undefined);
  }

  private fire(): void {
    try {
      this.changed.fire();
    } catch (error) {
      this.deps.log.error(`A listener of the toolchain service failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Runs queued scans until none is left. Called only while no scan runs; ends right after
   * clearing `scanning`, so that a `rescan()` from an `onDidChange` listener starts its own drain.
   */
  private async drain(): Promise<void> {
    this.active = true;
    this.fire();
    for (;;) {
      const batch = this.queued;
      if (batch === undefined || this.disposed) {
        break;
      }
      this.queued = undefined;
      const generation = ++this.generation;
      let snapshot: ToolchainSnapshot;
      try {
        snapshot = await scan(this.deps, generation, batch.reason, () => this.disposed);
      } catch (error) {
        if (!this.disposed) {
          this.deps.log.error(`Toolchain scan ${generation} (${batch.reason}) failed: ${errorMessage(error)}`);
        }
        batch.waiters.forEach((w) => w.reject(error));
        continue;
      }
      if (this.disposed) {
        batch.waiters.forEach((w) => w.resolve(snapshot));
        break;
      }
      this.logSnapshot(snapshot);
      this.snapshot = snapshot;
      const more = this.queued !== undefined;
      this.active = more;
      this.fire();
      batch.waiters.forEach((w) => w.resolve(snapshot));
      if (!more) {
        return;
      }
    }
    // After a failed last scan, or after dispose: `current` did not change, `scanning` does.
    this.active = false;
    if (!this.disposed) {
      this.fire();
    }
  }

  private logSnapshot(snapshot: ToolchainSnapshot): void {
    const pack = snapshot.pack.status === 'found' ? `at ${snapshot.pack.info.location.path}` : 'not found';
    const verdict = snapshot.verdict === undefined ? '' : `; pair ${snapshot.verdict.kind}: ${snapshot.verdict.reason}`;
    this.deps.log.info(
      `Toolchain scan ${snapshot.generation} (${snapshot.reason}${snapshot.trusted ? '' : ', Restricted Mode: nothing run'}): ` +
        `idris2 ${summary(snapshot.idris2, (info) => info.version?.text ?? info.versionLine)}; ` +
        `idris2-lsp ${summary(snapshot.lsp, (info) => `API ${info.apiVersion?.text ?? info.apiVersionLine}`)}; pack ${pack}${verdict}`,
    );
    snapshot.errors.forEach((e) => this.deps.log.error(e));
  }
}

/** The toolchain service of the contract in `toolchain/types.ts`. */
export function createToolchainService(deps: ToolchainServiceDeps): ToolchainService {
  return new Service(deps);
}
