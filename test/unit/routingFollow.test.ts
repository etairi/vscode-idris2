// features/backend/follow.ts: what a route change does to IDE mode's sessions and checks, the
// consent question for documents routed to idris2-lsp, and the one-time notification for files
// idris2-lsp cannot load (ROADMAP M5, F35).
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { rootKey, type BackendChoice, type Route } from '../../src/backend/registry';
import { Emitter } from '../../src/core/event';
import type { Log } from '../../src/core/log';
import type { GateVerdict, PermitReason } from '../../src/core/trust';
import { followRoutes, type FollowApi } from '../../src/features/backend/follow';
import type { RoutingNotice } from '../../src/features/backend/types';
import type { Classification } from '../../src/project/types';
import { FakeToolchain, LOOSE, lspProbed, missing, projectRoot, snapshot } from './support/toolchainFixtures';

const silentLog: Log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function document(fileName: string): vscode.TextDocument {
  return { uri: { scheme: 'file', fsPath: fileName, toString: () => `file://${fileName}` }, fileName, languageId: 'idris2' } as unknown as vscode.TextDocument;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const PROJECT = projectRoot();
const OUTSIDE = projectRoot({ ipkgPath: '/outside/p/p.ipkg', dir: '/outside/p', insideWorkspace: false });
const A = document('/w/simple-ipkg/src/Foo/A.idr');
const B = document('/outside/p/B.idr');
const L = document('/w/loose-file/Main.idr');

function harness(options: { idris2Usable?: boolean } = {}) {
  const roots = new Map<string, Classification>([
    [A.fileName, PROJECT],
    [B.fileName, OUTSIDE],
    [L.fileName, LOOSE],
  ]);
  const routes = new Map<string, Route>();
  const routesChanged = new Emitter<void>();
  const visibleChanged = new Emitter<readonly vscode.TextEditor[]>();
  const opened = new Emitter<vscode.TextDocument>();
  const projectsChanged = new Emitter<void>();
  const granted = new Emitter<void>();
  const missingIpkg = new Emitter<{ readonly uri?: vscode.Uri }>();
  const trust = { isTrusted: true };
  const state = {
    open: [A, B, L] as vscode.TextDocument[],
    visible: [A, B, L] as vscode.TextDocument[],
    verdicts: new Map<string, GateVerdict>(),
    permits: [] as [string, PermitReason | undefined][],
    stopped: [] as string[],
    cancelled: [] as string[],
    forgotten: [] as string[],
    rechecked: [] as string[],
    choices: [] as [string, BackendChoice | undefined][],
    warnings: [] as { message: string; actions: string[] }[],
    /** What the next warning is answered with. */
    answer: undefined as string | undefined,
  };
  const api = {
    window: {
      get visibleTextEditors() {
        return state.visible.map((document) => ({ document }));
      },
      onDidChangeVisibleTextEditors: visibleChanged.event,
      showWarningMessage: (message: string, ...actions: string[]) => {
        state.warnings.push({ message, actions });
        return Promise.resolve(state.answer);
      },
    },
    workspace: {
      get textDocuments() {
        return state.open;
      },
      onDidOpenTextDocument: opened.event,
    },
  } as unknown as FollowApi;
  const toolchain = new FakeToolchain(
    snapshot(options.idris2Usable === false ? { idris2: missing(), lsp: lspProbed('0.8.0') } : { lsp: lspProbed('0.8.0') }),
  );
  const notices: RoutingNotice[] = [];
  const follow = followRoutes(api, {
    trust: {
      get isTrusted() {
        return trust.isTrusted;
      },
      onDidGrant: granted.event,
    },
    projects: {
      classify: (fileName) => Promise.resolve(roots.get(fileName) ?? LOOSE),
      sessionCwd: (root) => root.dir,
      onDidChange: projectsChanged.event,
    },
    registry: { routeFor: (root) => routes.get(rootKey(root)) ?? { kind: 'ideMode' }, onDidChangeRoutes: routesChanged.event },
    gate: {
      current: (dir) => state.verdicts.get(dir),
      permit: (dir, why) => {
        state.permits.push([dir, why]);
        return new Promise<GateVerdict>(() => {});
      },
    },
    choices: {
      set: (root, choice) => {
        state.choices.push([rootKey(root), choice]);
        return Promise.resolve();
      },
    },
    toolchain,
    ideMode: { stop: (root) => state.stopped.push(rootKey(root)) },
    checks: {
      cancelWaiting: (root) => state.cancelled.push(rootKey(root)),
      forgetRoot: (root) => state.forgotten.push(rootKey(root)),
      recheckVisible: (root) => {
        state.rechecked.push(rootKey(root));
        return Promise.resolve();
      },
    },
    onDidReportMissingIpkg: missingIpkg.event,
    log: silentLog,
    notices,
  });
  const route = async (root: Classification, next: Route): Promise<void> => {
    routes.set(rootKey(root), next);
    routesChanged.fire();
    await settle();
  };
  return { follow, state, trust, notices, route, visibleChanged, missingIpkg, granted };
}

suite('features/backend/follow', () => {
  test('a root leaving IDE mode has its waiting checks dropped, its sessions stopped and its problems forgotten; one coming back is checked again', async () => {
    const h = harness();
    await settle();
    assert.deepStrictEqual([h.state.stopped, h.state.rechecked], [[], []], 'the first look changes nothing');
    await h.route(PROJECT, { kind: 'lsp' });
    assert.deepStrictEqual(h.state.cancelled, [rootKey(PROJECT)]);
    assert.deepStrictEqual(h.state.stopped, [rootKey(PROJECT)]);
    assert.deepStrictEqual(h.state.forgotten, [rootKey(PROJECT)]);
    assert.deepStrictEqual(h.state.rechecked, []);
    await h.route(PROJECT, { kind: 'ideMode' });
    assert.deepStrictEqual(h.state.rechecked, [rootKey(PROJECT)]);
    assert.deepStrictEqual(h.state.stopped, [rootKey(PROJECT)], 'stopped once');
    assert.deepStrictEqual(h.state.forgotten, [rootKey(PROJECT)], 'forgotten once');
    h.follow.dispose();
  });

  test('a shown document routed to idris2-lsp: the gate is asked about its root\'s folder once it has no verdict; never in Restricted Mode', async () => {
    const h = harness();
    await settle();
    h.state.verdicts.set(PROJECT.dir, { allowed: true, basis: 'workspaceFolder' });
    await h.route(OUTSIDE, { kind: 'lsp' });
    await h.route(PROJECT, { kind: 'lsp' });
    assert.deepStrictEqual(h.state.permits, [[OUTSIDE.dir, { ipkg: OUTSIDE.ipkgPath }], [OUTSIDE.dir, { ipkg: OUTSIDE.ipkgPath }]], 'only the folder without a verdict');
    h.state.verdicts.set(OUTSIDE.dir, { allowed: false, reason: 'denied' });
    h.visibleChanged.fire([]);
    await settle();
    assert.strictEqual(h.state.permits.length, 2, 'a denial is not asked again here');
    const untrusted = harness();
    untrusted.trust.isTrusted = false;
    await untrusted.route(OUTSIDE, { kind: 'lsp' });
    assert.deepStrictEqual(untrusted.state.permits, []);
  });

  test('a document opened but not shown is not asked about', async () => {
    const h = harness();
    h.state.visible = [A];
    await h.route(OUTSIDE, { kind: 'lsp' });
    assert.deepStrictEqual(h.state.permits, []);
  });

  test('a shown file served by nothing: one notification per root, offering IDE mode when idris2 is usable', async () => {
    const h = harness();
    h.state.answer = 'Use IDE Mode for This Folder';
    await h.route(LOOSE, { kind: 'none', why: 'noIpkg' });
    assert.strictEqual(h.state.warnings.length, 1);
    assert.match(h.state.warnings[0].message, /^Idris 2: idris2-lsp cannot load the Idris files of “\/w\/loose-file”: idris2-lsp loads a file only when an \.ipkg file/);
    assert.deepStrictEqual(h.state.warnings[0].actions, ['Use IDE Mode for This Folder']);
    assert.deepStrictEqual(h.notices.map((n) => n.kind), ['noIpkg']);
    await settle();
    assert.deepStrictEqual(h.state.choices, [[rootKey(LOOSE), 'ideMode']]);
    h.visibleChanged.fire([]);
    await settle();
    assert.strictEqual(h.state.warnings.length, 1, 'once per root and window');
    const noCompiler = harness({ idris2Usable: false });
    await noCompiler.route(LOOSE, { kind: 'none', why: 'noIpkg' });
    assert.deepStrictEqual(noCompiler.state.warnings[0].actions, [], 'no IDE mode to offer');
  });

  test('the server\'s report of a missing .ipkg (F35 safety net) gives the notification for that file\'s root, once', async () => {
    const h = harness();
    await settle();
    h.missingIpkg.fire({ uri: A.uri });
    await settle();
    assert.deepStrictEqual(h.notices.map((n) => n.kind), ['missingIpkg']);
    assert.match(h.notices[0].message, /idris2-lsp found no \.ipkg file for “\/w\/simple-ipkg\/src\/Foo\/A\.idr”/);
    h.missingIpkg.fire({ uri: A.uri });
    h.missingIpkg.fire({});
    await settle();
    assert.strictEqual(h.notices.length, 1);
  });
});
