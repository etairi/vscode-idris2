// backend/registry.ts, M5: the routing between IDE mode and idris2-lsp (the user's decision of
// 2026-10-01 on ROADMAP §9 Q7), the choices of Switch Backend, the registry over two providers, the
// LSP provider's states, and which documents may reach the server (LspAdmission).
import * as assert from 'assert';
import type { LspClientState } from '../../src/backend/lsp/types';
import { NullBackend } from '../../src/backend/null';
import {
  availability,
  BACKEND_CHOICES_KEY,
  BackendChoices,
  BackendRegistry,
  BackendRouting,
  decideRoute,
  LspAdmission,
  LspProvider,
  lspBackendState,
  NO_IPKG_REASON,
  rootKey,
  type Availability,
  type BackendChoice,
  type BackendProvider,
  type BackendState,
  type ChoiceStorage,
  type Route,
  type Routing,
  type ToolchainAvailability,
} from '../../src/backend/registry';
import type { BackendKind, IdrisBackend } from '../../src/backend/types';
import type { BackendMode } from '../../src/core/config';
import { IdrisException } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { GateVerdict } from '../../src/core/trust';
import type { Classification } from '../../src/project/types';
import { FakeToolchain, LOOSE, idris2Probed, lspProbed, missing, projectRoot, snapshot } from './support/toolchainFixtures';

const PROJECT = projectRoot();

function tools(idris2: Availability, lsp: Availability, lspLikelyMismatch = false): ToolchainAvailability {
  return { idris2, lsp, lspLikelyMismatch };
}

class MemoryStorage implements ChoiceStorage {
  value: unknown;
  updates = 0;
  get(key: string): unknown {
    return key === BACKEND_CHOICES_KEY ? this.value : undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    assert.strictEqual(key, BACKEND_CHOICES_KEY);
    this.value = JSON.parse(JSON.stringify(value)) as unknown;
    this.updates++;
    return Promise.resolve();
  }
}

/** The registry reads only `kind`; the rest of the backend is never called here. */
function backendOf(kind: BackendKind): IdrisBackend {
  return { kind } as unknown as IdrisBackend;
}

class FakeProvider implements BackendProvider {
  readonly backend: IdrisBackend;
  state: BackendState = { kind: 'none' };
  readonly changed = new Emitter<void>();
  readonly onDidChangeState = this.changed.event;
  constructor(readonly kind: BackendKind) {
    this.backend = backendOf(kind);
  }
  backendFor(): IdrisBackend {
    return this.backend;
  }
  stateFor(): BackendState {
    return this.state;
  }
}

class FakeRouting implements Routing {
  routes = new Map<string, Route>();
  pending: Route = { kind: 'ideMode' };
  problem: string | undefined;
  readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  routeFor(root: Classification): Route {
    return this.routes.get(rootKey(root)) ?? { kind: 'ideMode' };
  }
  pendingRoute(): Route {
    return this.pending;
  }
  lspProblem(): string | undefined {
    return this.problem;
  }
}

suite('backend/registry: routing (M5)', () => {
  suite('decideRoute: the policy table of the user\'s decision of 2026-10-01', () => {
    // [rootKind, mode, choice, idris2, lsp, likely mismatch, expected]
    type Row = readonly [Classification['kind'], BackendMode, BackendChoice | undefined, Availability, Availability, boolean, Route['kind']];
    const ROWS: readonly Row[] = [
      // ideMode: IDE mode for every root, whatever is installed.
      ['project', 'ideMode', undefined, 'usable', 'usable', false, 'ideMode'],
      ['project', 'ideMode', undefined, 'unusable', 'usable', false, 'ideMode'],
      ['loose', 'ideMode', undefined, 'unusable', 'usable', false, 'ideMode'],
      // lsp: idris2-lsp for a root with an .ipkg, whatever the scan says (its state says the rest); a loose file gets none.
      ['project', 'lsp', undefined, 'usable', 'usable', false, 'lsp'],
      ['project', 'lsp', undefined, 'usable', 'unusable', false, 'lsp'],
      ['project', 'lsp', undefined, 'unknown', 'unknown', false, 'lsp'],
      ['project', 'lsp', undefined, 'usable', 'usable', true, 'lsp'],
      ['loose', 'lsp', undefined, 'usable', 'usable', false, 'none'],
      ['loose', 'lsp', undefined, 'unusable', 'unusable', false, 'none'],
      // auto: IDE mode stays the default whenever idris2 is usable or not known yet.
      ['project', 'auto', undefined, 'usable', 'usable', false, 'ideMode'],
      ['loose', 'auto', undefined, 'usable', 'usable', false, 'ideMode'],
      ['project', 'auto', undefined, 'unknown', 'usable', false, 'ideMode'],
      ['project', 'auto', undefined, 'unknown', 'unknown', false, 'ideMode'],
      // auto without a usable idris2: idris2-lsp for a project, when the server is usable and no likely mismatch.
      ['project', 'auto', undefined, 'unusable', 'usable', false, 'lsp'],
      ['loose', 'auto', undefined, 'unusable', 'usable', false, 'none'],
      ['project', 'auto', undefined, 'unusable', 'usable', true, 'ideMode'],
      ['loose', 'auto', undefined, 'unusable', 'usable', true, 'ideMode'],
      ['project', 'auto', undefined, 'unusable', 'unusable', false, 'ideMode'],
      ['project', 'auto', undefined, 'unusable', 'unknown', false, 'ideMode'],
      ['loose', 'auto', undefined, 'unusable', 'unusable', false, 'ideMode'],
      // Switch Backend's choice comes before the setting.
      ['project', 'ideMode', 'lsp', 'usable', 'usable', false, 'lsp'],
      ['project', 'auto', 'lsp', 'usable', 'usable', false, 'lsp'],
      ['project', 'lsp', 'ideMode', 'usable', 'usable', false, 'ideMode'],
      ['project', 'auto', 'ideMode', 'unusable', 'usable', false, 'ideMode'],
      ['loose', 'lsp', 'ideMode', 'usable', 'unusable', false, 'ideMode'],
      ['loose', 'auto', 'ideMode', 'unusable', 'usable', false, 'ideMode'],
      ['loose', 'ideMode', 'lsp', 'usable', 'usable', false, 'none'],
    ];

    for (const [kind, mode, choice, idris2, lsp, mismatch, expected] of ROWS) {
      test(`${kind}, mode ${mode}, choice ${choice ?? '-'}, idris2 ${idris2}, idris2-lsp ${lsp}${mismatch ? ' (likely mismatch)' : ''} → ${expected}`, () => {
        const route = decideRoute(kind, mode, choice, tools(idris2, lsp, mismatch));
        assert.strictEqual(route.kind, expected);
        if (route.kind === 'none') {
          assert.strictEqual(route.why, 'noIpkg');
        }
      });
    }

    test('over every combination: a loose file never goes to idris2-lsp, auto takes it only without a usable idris2, a choice of IDE mode always wins', () => {
      const states: Availability[] = ['usable', 'unusable', 'unknown'];
      for (const kind of ['project', 'loose'] as const) {
        for (const mode of ['auto', 'lsp', 'ideMode'] as const) {
          for (const choice of [undefined, 'ideMode', 'lsp'] as const) {
            for (const idris2 of states) {
              for (const lsp of states) {
                for (const mismatch of [false, true]) {
                  const route = decideRoute(kind, mode, choice, tools(idris2, lsp, mismatch)).kind;
                  const label = JSON.stringify({ kind, mode, choice, idris2, lsp, mismatch, route });
                  if (kind === 'loose') {
                    assert.notStrictEqual(route, 'lsp', label);
                  }
                  if (choice === 'ideMode' || (choice === undefined && mode === 'ideMode')) {
                    assert.strictEqual(route, 'ideMode', label);
                  }
                  if (choice === undefined && mode === 'auto' && route !== 'ideMode') {
                    assert.ok(idris2 === 'unusable' && lsp === 'usable' && !mismatch, label);
                  }
                  if ((choice ?? mode) === 'lsp') {
                    assert.strictEqual(route, kind === 'project' ? 'lsp' : 'none', label);
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  suite('availability: the tools as the policy sees them', () => {
    test('before a trusted scan finished nothing is known', () => {
      assert.deepStrictEqual(availability(undefined), tools('unknown', 'unknown'));
      assert.deepStrictEqual(availability(snapshot({ trusted: false, lsp: lspProbed('0.8.0') })), tools('unknown', 'unknown'));
    });

    test('probed is usable; missing and failed are not, with the scan\'s reason for the server', () => {
      assert.deepStrictEqual(availability(snapshot({ lsp: lspProbed('0.8.0') })), tools('usable', 'usable'));
      assert.deepStrictEqual(availability(snapshot({ idris2: missing(), lsp: missing('idris2-lsp was not found.') })), {
        ...tools('unusable', 'unusable'),
        lspProblem: 'idris2-lsp was not found.',
      });
      const failed = snapshot({
        idris2: { status: 'failed', location: { kind: 'idris2', path: '/x/idris2', source: 'PATH', detail: 'd', inPackDirectory: false }, reason: 'r', probes: [] },
        lsp: { status: 'failed', location: { kind: 'idris2-lsp', path: '/x/idris2-lsp', source: 'PATH', detail: 'd', inPackDirectory: false }, reason: 'it crashed', probes: [] },
      });
      assert.deepStrictEqual(availability(failed), { ...tools('unusable', 'unusable'), lspProblem: 'it crashed' });
    });

    test('a likely mismatch is flagged; compatible and unknown verdicts are not', () => {
      assert.strictEqual(availability(snapshot({ lsp: lspProbed('0.7.0'), verdict: { kind: 'likelyMismatch', reason: 'r' } })).lspLikelyMismatch, true);
      assert.strictEqual(availability(snapshot({ lsp: lspProbed('0.8.0'), verdict: { kind: 'unknown', reason: 'r' } })).lspLikelyMismatch, false);
      assert.strictEqual(availability(snapshot({ lsp: lspProbed('0.8.0'), verdict: { kind: 'compatible', reason: 'r' } })).lspLikelyMismatch, false);
    });
  });

  suite('BackendChoices: Switch Backend\'s choice per root, in the workspace state', () => {
    test('set, read back per root (a project and a loose folder of one directory are apart), forget', async () => {
      const storage = new MemoryStorage();
      const choices = new BackendChoices(storage);
      let fired = 0;
      choices.onDidChange(() => fired++);
      const sameDir = projectRoot({ dir: LOOSE.dir, ipkgPath: `${LOOSE.dir}/p.ipkg` });
      await choices.set(sameDir, 'lsp');
      await choices.set(LOOSE, 'ideMode');
      assert.strictEqual(choices.get(sameDir), 'lsp');
      assert.strictEqual(choices.get(LOOSE), 'ideMode');
      assert.strictEqual(choices.get(PROJECT), undefined);
      assert.deepStrictEqual(storage.value, { [rootKey(sameDir)]: 'lsp', [rootKey(LOOSE)]: 'ideMode' });
      await choices.set(sameDir, undefined);
      assert.strictEqual(choices.get(sameDir), undefined);
      assert.deepStrictEqual(storage.value, { [rootKey(LOOSE)]: 'ideMode' });
      assert.strictEqual(fired, 3);
    });

    test('whatever else the storage holds is ignored', () => {
      const storage = new MemoryStorage();
      const choices = new BackendChoices(storage);
      for (const value of [undefined, null, 'lsp', ['lsp'], 42]) {
        storage.value = value;
        assert.strictEqual(choices.get(PROJECT), undefined);
      }
      storage.value = { [rootKey(PROJECT)]: 'syntax only', [rootKey(LOOSE)]: 'ideMode' };
      assert.strictEqual(choices.get(PROJECT), undefined);
      assert.strictEqual(choices.get(LOOSE), 'ideMode');
    });
  });

  suite('BackendRouting: the policy over the setting, the choices and the last scan', () => {
    function routing(modes: { window?: BackendMode; byRoot?: Map<string, BackendMode> } = {}) {
      const toolchain = new FakeToolchain(snapshot({ idris2: missing(), lsp: lspProbed('0.8.0') }));
      const storage = new MemoryStorage();
      const choices = new BackendChoices(storage);
      const modeChanged = new Emitter<void>();
      const asked: (Classification | undefined)[] = [];
      const r = new BackendRouting({
        modeFor: (root) => {
          asked.push(root);
          return root === undefined ? (modes.window ?? 'auto') : (modes.byRoot?.get(rootKey(root)) ?? modes.window ?? 'auto');
        },
        onDidChangeMode: modeChanged.event,
        choices,
        toolchain,
      });
      let fired = 0;
      r.onDidChange(() => fired++);
      return { r, toolchain, choices, modeChanged, asked, fired: () => fired };
    }

    test('routes per root with the setting of the root\'s folder, the root\'s choice and the scan', async () => {
      const byRoot = new Map<string, BackendMode>([[rootKey(PROJECT), 'ideMode']]);
      const { r, choices, asked } = routing({ byRoot });
      const other = projectRoot({ ipkgPath: '/w/other/o.ipkg', dir: '/w/other' });
      assert.strictEqual(r.routeFor(PROJECT).kind, 'ideMode', 'its folder says ideMode');
      assert.strictEqual(r.routeFor(other).kind, 'lsp', 'auto, no idris2, a usable server');
      assert.strictEqual(r.routeFor(LOOSE).kind, 'none');
      assert.deepStrictEqual(asked, [PROJECT, other, LOOSE]);
      await choices.set(PROJECT, 'lsp');
      assert.strictEqual(r.routeFor(PROJECT).kind, 'lsp', 'the choice comes before the setting');
    });

    test('pendingRoute is a project root\'s without a choice under the window\'s setting', () => {
      const { r, asked } = routing({ window: 'ideMode' });
      assert.strictEqual(r.pendingRoute().kind, 'ideMode');
      assert.deepStrictEqual(asked, [undefined]);
      assert.strictEqual(routing().r.pendingRoute().kind, 'lsp');
    });

    test('lspProblem is the scan\'s reason when the server is not usable', () => {
      const { r, toolchain } = routing();
      assert.strictEqual(r.lspProblem(), undefined);
      toolchain.publish({ lsp: missing('idris2-lsp was not found.') });
      assert.strictEqual(r.lspProblem(), 'idris2-lsp was not found.');
    });

    test('onDidChange fires for a mode change, a choice and a new scan, not when a scan only starts', async () => {
      const { toolchain, choices, modeChanged, fired } = routing();
      modeChanged.fire();
      await choices.set(LOOSE, 'ideMode');
      assert.strictEqual(fired(), 2);
      toolchain.setScanning(true);
      assert.strictEqual(fired(), 2, 'the same snapshot: no route can change');
      toolchain.publish({ idris2: idris2Probed() });
      assert.strictEqual(fired(), 3);
    });
  });

  suite('BackendRegistry with a routing', () => {
    function registry() {
      const reg = new BackendRegistry();
      const ide = new FakeProvider('ideMode');
      const lsp = new FakeProvider('lsp');
      const routing = new FakeRouting();
      reg.setProvider(ide);
      reg.setProvider(lsp);
      reg.setRouting(routing);
      let changes = 0;
      let routeChanges = 0;
      reg.onDidChange(() => changes++);
      reg.onDidChangeRoutes(() => routeChanges++);
      return { reg, ide, lsp, routing, changes: () => changes, routeChanges: () => routeChanges };
    }

    test('each root gets the provider of its route, and its label', () => {
      const { reg, ide, lsp, routing } = registry();
      routing.routes.set(rootKey(PROJECT), { kind: 'lsp' });
      assert.strictEqual(reg.backendFor(PROJECT), lsp.backend);
      assert.strictEqual(reg.labelFor(PROJECT), 'idris2-lsp');
      assert.strictEqual(reg.backendFor(LOOSE), ide.backend);
      assert.strictEqual(reg.labelFor(LOOSE), 'IDE mode');
      assert.strictEqual(reg.routeFor(PROJECT).kind, 'lsp');
    });

    test('a root routed nowhere is served by a backend that refuses with the reason, and has no state', async () => {
      const { reg, routing } = registry();
      routing.routes.set(rootKey(LOOSE), { kind: 'none', why: 'noIpkg' });
      const backend = reg.backendFor(LOOSE);
      assert.strictEqual(backend.kind, 'null');
      assert.strictEqual(reg.labelFor(LOOSE), 'syntax only');
      assert.strictEqual(reg.stateFor(LOOSE), undefined);
      for (const call of [() => backend.load(undefined as never), () => backend.holes(undefined as never), () => backend.evaluate(undefined as never, '1')]) {
        await assert.rejects(call(), (error: unknown) => error instanceof IdrisException && error.error.kind === 'Unsupported' && error.error.reason === `${NO_IPKG_REASON}.`);
      }
    });

    test('without a provider of the route\'s kind: NullBackend, syntax only, no state', () => {
      const reg = new BackendRegistry();
      const ide = new FakeProvider('ideMode');
      reg.setProvider(ide);
      const routing = new FakeRouting();
      reg.setRouting(routing);
      routing.routes.set(rootKey(PROJECT), { kind: 'lsp' });
      assert.ok(reg.backendFor(PROJECT) instanceof NullBackend);
      assert.strictEqual(reg.labelFor(PROJECT), 'syntax only');
      assert.strictEqual(reg.stateFor(PROJECT), undefined);
    });

    test('stateFor: the provider\'s; for a root routed to idris2-lsp while the scan found no usable server, failed with its reason', () => {
      const { reg, ide, lsp, routing } = registry();
      routing.routes.set(rootKey(PROJECT), { kind: 'lsp' });
      lsp.state = { kind: 'active' };
      ide.state = { kind: 'stopped' };
      assert.deepStrictEqual(reg.stateFor(PROJECT), { kind: 'active' });
      assert.deepStrictEqual(reg.stateFor(LOOSE), { kind: 'stopped' });
      routing.problem = 'idris2-lsp was not found.';
      assert.deepStrictEqual(reg.stateFor(PROJECT), { kind: 'failed', reason: 'idris2-lsp was not found.' });
      assert.deepStrictEqual(reg.stateFor(LOOSE), { kind: 'stopped' }, 'IDE mode is not concerned');
    });

    test('pendingLabel follows the routing\'s pending route', () => {
      const { reg, routing } = registry();
      assert.strictEqual(reg.pendingLabel(), 'IDE mode');
      routing.pending = { kind: 'lsp' };
      assert.strictEqual(reg.pendingLabel(), 'idris2-lsp');
      routing.pending = { kind: 'none', why: 'noIpkg' };
      assert.strictEqual(reg.pendingLabel(), 'syntax only');
    });

    test('onDidChangeRoutes fires for a routing change, not for a provider\'s state change; onDidChange for both', () => {
      const { lsp, routing, changes, routeChanges } = registry();
      lsp.changed.fire();
      assert.deepStrictEqual([changes(), routeChanges()], [1, 0]);
      routing.changed.fire();
      assert.deepStrictEqual([changes(), routeChanges()], [2, 1]);
    });

    test('a second routing is refused; removing the routing goes back to IDE mode for every root', () => {
      const reg = new BackendRegistry();
      const ide = new FakeProvider('ideMode');
      reg.setProvider(ide);
      reg.setProvider(new FakeProvider('lsp'));
      const routing = new FakeRouting();
      routing.routes.set(rootKey(PROJECT), { kind: 'lsp' });
      const registration = reg.setRouting(routing);
      assert.throws(() => reg.setRouting(new FakeRouting()), /already set/);
      assert.strictEqual(reg.labelFor(PROJECT), 'idris2-lsp');
      registration.dispose();
      assert.strictEqual(reg.backendFor(PROJECT), ide.backend);
      routing.changed.fire(); // no longer listened to
    });
  });

  suite('LspProvider: the client\'s state for every root, and notAllowed from the consent gate', () => {
    test('lspBackendState maps every client state', () => {
      const cases: [LspClientState, BackendState][] = [
        [{ kind: 'notStarted' }, { kind: 'none' }],
        [{ kind: 'starting' }, { kind: 'active' }],
        [{ kind: 'running' }, { kind: 'active' }],
        [{ kind: 'stopped' }, { kind: 'stopped' }],
        [{ kind: 'failed', reason: 'it ended five times' }, { kind: 'failed', reason: 'it ended five times' }],
      ];
      for (const [client, expected] of cases) {
        assert.deepStrictEqual(lspBackendState(client), expected);
      }
    });

    test('a root whose folder the user did not allow is notAllowed; events of the client and the gate are passed on', () => {
      const clientChanged = new Emitter<void>();
      const gateChanged = new Emitter<void>();
      const verdicts = new Map<string, GateVerdict>([['/outside/p', { allowed: false, reason: 'denied' }]]);
      const client = { state: { kind: 'running' } as LspClientState, onDidChangeState: clientChanged.event };
      const backend = backendOf('lsp');
      const provider = new LspProvider({
        backend,
        client,
        gate: { current: (dir) => verdicts.get(dir), onDidChange: gateChanged.event },
        projects: { sessionCwd: (root) => root.dir },
      });
      let fired = 0;
      provider.onDidChangeState(() => fired++);
      const outside = projectRoot({ dir: '/outside/p', ipkgPath: '/outside/p/p.ipkg', insideWorkspace: false });
      assert.strictEqual(provider.backendFor(), backend);
      assert.deepStrictEqual(provider.stateFor(PROJECT), { kind: 'active' });
      assert.deepStrictEqual(provider.stateFor(outside), { kind: 'notAllowed', dir: '/outside/p', reason: 'denied' });
      verdicts.set('/outside/p', { allowed: false, reason: 'restrictedMode' });
      assert.deepStrictEqual(provider.stateFor(outside), { kind: 'active' }, 'Restricted Mode is not a refusal of the folder');
      client.state = { kind: 'stopped' };
      clientChanged.fire();
      gateChanged.fire();
      assert.strictEqual(fired, 2);
      assert.deepStrictEqual(provider.stateFor(PROJECT), { kind: 'stopped' });
      provider.dispose();
      clientChanged.fire();
      assert.strictEqual(fired, 2);
    });
  });

  suite('LspAdmission: which documents may reach the server', () => {
    const FILE = { scheme: 'file', fsPath: '/w/simple-ipkg/src/Foo/A.idr' } as unknown as import('vscode').Uri;

    function admission(options: { route?: Route; verdict?: GateVerdict | undefined; root?: Classification; realpath?: (dir: string) => string | undefined } = {}) {
      const trust = { isTrusted: true, granted: new Emitter<void>() };
      const routes = new Emitter<void>();
      const gateChanged = new Emitter<void>();
      const projectsChanged = new Emitter<void>();
      const state = {
        route: options.route ?? ({ kind: 'lsp' } as Route),
        verdict: 'verdict' in options ? options.verdict : ({ allowed: true, basis: 'workspaceFolder' } as GateVerdict),
        root: options.root ?? PROJECT,
        rechecked: [] as string[],
        /** Runs while `recheck` waits, to change the world under it. */
        duringRecheck: undefined as (() => void) | undefined,
      };
      const a = new LspAdmission({
        trust: {
          get isTrusted() {
            return trust.isTrusted;
          },
          onDidGrant: trust.granted.event,
        },
        projects: {
          classify: () => Promise.resolve(state.root),
          sessionCwd: (root) => root.dir,
          onDidChange: projectsChanged.event,
        },
        gate: {
          recheck: (dir) => {
            state.rechecked.push(dir);
            state.duringRecheck?.();
            return Promise.resolve(state.verdict);
          },
          onDidChange: gateChanged.event,
        },
        registry: { routeFor: () => state.route, onDidChangeRoutes: routes.event },
        platform: 'darwin',
        realpath: options.realpath ?? ((dir) => dir),
      });
      return { a, trust, state, routes, gateChanged, projectsChanged };
    }

    test('a file of a root routed to idris2-lsp, in a trusted workspace folder, is admitted', async () => {
      const { a, state } = admission();
      assert.strictEqual(await a.admits(FILE), true);
      assert.deepStrictEqual(state.rechecked, [PROJECT.dir], 'the gate judged the root\'s folder');
    });

    test('a path the compiler reads differently is refused before the gate, as on the IDE-mode route (review 1, M12)', async () => {
      for (const fsPath of ['/w/co:lon/src/A.idr', '/w/what?/src/A.idr', '/w/back\\slash/src/A.idr', '/w/ /src/A.idr']) {
        const { a, state } = admission();
        assert.strictEqual(await a.admits({ scheme: 'file', fsPath } as unknown as import('vscode').Uri), false, fsPath);
        assert.deepStrictEqual(state.rechecked, [], fsPath);
      }
    });

    test('the path judged is the one the server is sent, the real path of the folder (review 1, M12)', async () => {
      const { a } = admission({ realpath: () => '/real:folder' });
      assert.strictEqual(await a.admits(FILE), false, 'a link to a folder the compiler misreads');
      const link = { scheme: 'file', fsPath: '/w/li:nk/A.idr' } as unknown as import('vscode').Uri;
      const { a: b } = admission({ realpath: () => '/w/simple-ipkg/src' });
      assert.strictEqual(await b.admits(link), true, 'a link to a folder it reads');
    });

    test('Restricted Mode, another scheme, a file name the compiler does not read as Idris, a loose file, another route: refused before the gate', async () => {
      const untrusted = admission();
      untrusted.trust.isTrusted = false;
      assert.strictEqual(await untrusted.a.admits(FILE), false);
      const { a, state } = admission();
      assert.strictEqual(await a.admits({ scheme: 'untitled', fsPath: '/w/A.idr' } as unknown as import('vscode').Uri), false);
      assert.strictEqual(await a.admits({ scheme: 'file', fsPath: '/w/notes.md' } as unknown as import('vscode').Uri), false);
      assert.strictEqual(await a.admits({ scheme: 'file', fsPath: '/w/A.IDR' } as unknown as import('vscode').Uri), false);
      assert.deepStrictEqual(state.rechecked, []);
      for (const options of [{ root: LOOSE }, { route: { kind: 'ideMode' } as Route }, { route: { kind: 'none', why: 'noIpkg' } as Route }]) {
        const other = admission(options);
        assert.strictEqual(await other.a.admits(FILE), false, JSON.stringify(options));
        assert.deepStrictEqual(other.state.rechecked, []);
      }
    });

    test('literate files the compiler reads (.lidr, .idr.md) are not refused by name', async () => {
      const { a } = admission();
      assert.strictEqual(await a.admits({ scheme: 'file', fsPath: '/w/simple-ipkg/src/Lit.lidr' } as unknown as import('vscode').Uri), true);
      assert.strictEqual(await a.admits({ scheme: 'file', fsPath: '/w/simple-ipkg/src/Lit.idr.md' } as unknown as import('vscode').Uri), true);
    });

    test('a folder outside the trusted folders: refused until the gate allowed it, also after a denial', async () => {
      const outside = projectRoot({ dir: '/outside/p', ipkgPath: '/outside/p/p.ipkg', insideWorkspace: false });
      assert.strictEqual(await admission({ root: outside, verdict: undefined }).a.admits(FILE), false, 'not asked yet');
      assert.strictEqual(await admission({ root: outside, verdict: { allowed: false, reason: 'denied' } }).a.admits(FILE), false);
      assert.strictEqual(await admission({ root: outside, verdict: { allowed: false, reason: 'unresolved', error: 'ENOENT' } }).a.admits(FILE), false);
      assert.strictEqual(await admission({ root: outside, verdict: { allowed: true, basis: 'window' } }).a.admits(FILE), true);
    });

    test('trust lost or the route changed while the gate was asked: refused', async () => {
      const lost = admission();
      lost.state.duringRecheck = () => (lost.trust.isTrusted = false);
      assert.strictEqual(await lost.a.admits(FILE), false);
      const moved = admission();
      moved.state.duringRecheck = () => (moved.state.route = { kind: 'ideMode' });
      assert.strictEqual(await moved.a.admits(FILE), false);
    });

    test('onDidChange fires for a route change, a gate change, trust granted and a project change', () => {
      const { a, trust, routes, gateChanged, projectsChanged } = admission();
      let fired = 0;
      a.onDidChange(() => fired++);
      routes.fire();
      gateChanged.fire();
      trust.granted.fire();
      projectsChanged.fire();
      assert.strictEqual(fired, 4);
      a.dispose();
      routes.fire();
      assert.strictEqual(fired, 4);
    });
  });
});
