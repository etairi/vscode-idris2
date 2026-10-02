/**
 * Extension entry point (`src/extension.ts` in docs/ARCHITECTURE.md §2).
 *
 * activate() builds, in this order: the log channel, M0's Help commands, `idris2.isIdrisDocument`
 * and selection ranges; then M1's chain Config → workspace trust → process runner → toolchain
 * service → project index → backend registry; then M2's consent gate, protocol trace, session
 * pool and IDE-mode backend (the registry's provider for every root), the checks with their
 * diagnostic collection, and the backend and trace commands; then M3's providers and commands
 * (hover, definition, documentation, namespaces, semantic tokens, symbols, highlights, completion,
 * inlay hints — all asking through one `DocumentQueries` — and Evaluate Selection); then M4's
 * interactive editing (commands, code actions, cycling), the holes (model, Holes view, Next /
 * Previous Hole, List Holes) with the `idris2.isIdrisWorkspace` context key, and Show Keybindings;
 * then the toolchain UI (status item and QuickPick, Setup Information, install commands,
 * notifications). deactivate() disposes all of it in reverse order, which kills every session
 * process.
 *
 * Activation stays cheap: nothing here waits for a process or the file system. The toolchain
 * service starts its first scan when it is created and the UI follows its change events; no
 * session process starts before an Idris document is checked (the pool starts a session with its
 * first request). M3's providers ask only when VS Code calls them, and the `eval` session starts
 * at the first evaluation. M4's commands ask when they are run, and the holes model asks after the
 * loads the checks make. Every process goes through `core/process.ts`, which starts nothing in an
 * untrusted workspace (Restricted Mode, package.json `capabilities.untrustedWorkspaces`).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { IdeMode } from './backend/ide/backend';
import { createSessionPool } from './backend/ide/pool';
import { ideCodec } from './backend/ide/protocol';
import { systemClock } from './backend/ide/session';
import type { SessionPool } from './backend/ide/types';
import { BackendRegistry } from './backend/registry';
import { Config, usableHomeDirectory } from './core/config';
import { DisposableStore } from './core/disposable';
import { Emitter } from './core/event';
import { createLog } from './core/log';
import { createProcessRunner } from './core/process';
import type { WorkspaceTrust } from './core/trust';
import type { ConsentGate } from './features/consent/gate';
import { registerConsent } from './features/consent/register';
import { DocumentChecks } from './features/diagnostics/checks';
import { registerBackendCommands, type BackendNotice } from './features/diagnostics/commands';
import { ProtocolTraceChannel, registerTraceCommands } from './features/diagnostics/trace';
import { registerEditing } from './features/editing/register';
import { registerEvaluation, type EvaluationOutcome, type DrawnEvaluation } from './features/eval/register';
import { registerHelpCommands } from './features/help/commands';
import { registerShowKeybindings } from './features/help/keybindings';
import { registerHoles } from './features/holes/register';
import type { HoleNode } from './features/holes/tree';
import type { HoleModel } from './features/holes/types';
import { trackIsIdrisWorkspace } from './features/holes/workspaceContext';
import { registerCompletion } from './features/intelligence/completion';
import { registerInlayHints } from './features/intelligence/inlayHints';
import { createDocumentQueries } from './features/intelligence/queries';
import { registerIntelligence } from './features/intelligence/register';
import type { IntelligenceDeps } from './features/intelligence/types';
import { registerSelectionRanges } from './features/syntax/selectionRanges';
import { createProjectIndex } from './project/index';
import { findIpkg } from './project/ipkg';
import { trackIsIdrisDocumentContext } from './project/literate';
import type { ProjectIndex, ProjectWorkspace } from './project/types';
import { registerInstallCommands } from './toolchain/install';
import { registerToolchainNotifications, type Notice } from './toolchain/notifications';
import { readRegularTextFile, readSourceFile } from './toolchain/fileSystem';
import { createToolchainService } from './toolchain/service';
import { registerSetupInformation } from './toolchain/setupInfo';
import { registerToolchainStatus, type StatusMenuEntry } from './toolchain/status';
import type { ToolchainService } from './toolchain/types';

/**
 * What activate() returns when the extension runs under the test runner
 * (`ExtensionMode.Test`), so that integration tests can read state that VS Code's API does not
 * expose (a language status item's text, the notices shown). Otherwise activate() returns
 * `undefined`: there is no public API.
 */
export interface TestApi {
  readonly toolchain: ToolchainService;
  readonly projects: ProjectIndex;
  readonly registry: BackendRegistry;
  readonly statusItem: vscode.LanguageStatusItem;
  statusMenuEntries(): StatusMenuEntry[];
  /** The toolchain notices shown in this window, in order. */
  readonly notices: readonly Notice[];
  readonly setupInformationUri: vscode.Uri;
  /** M2: the IDE-mode session pool (the sessions, their state and command line; Stop). */
  readonly sessions: SessionPool;
  /** M2: the documents' check states and the "idris2" diagnostic collection. */
  readonly checks: DocumentChecks;
  /** M2: the consent gate (open questions, answering them, the folders allowed for good). */
  readonly consent: ConsentGate;
  /** M2: the crash and give-up notices shown in this window, in order. */
  readonly backendNotices: readonly BackendNotice[];
  /** M3: the notifications of Type/Docs at Cursor, Show Documentation and Browse Namespace…, in order. */
  readonly intelligenceNotices: readonly string[];
  /** M3: every run of Evaluate Selection in this window, in order, with what it showed. */
  readonly evaluations: readonly EvaluationOutcome[];
  /** M3: the evaluation results drawn in the document of `uri` (VS Code's API cannot read decorations). */
  evaluationResults(uri: vscode.Uri): readonly DrawnEvaluation[];
  /**
   * M4: the editing commands (`features/editing/register.ts`): every run's outcome, in order
   * (`outcomes`), and each document's Proof Search or Generate Definition cycle (`cycleOf`).
   */
  readonly editing: ReturnType<typeof registerEditing>;
  /** M4: the holes of the files the compiler checked (`features/holes/types.ts` `HoleModel`). */
  readonly holes: HoleModel;
  /** M4: the Holes view's tree data (its items, as VS Code gets them). */
  readonly holesTree: vscode.TreeDataProvider<HoleNode>;
  /** M4: the Holes view (its badge). */
  readonly holesView: vscode.TreeView<HoleNode>;
}

let store: DisposableStore | undefined;

/** `vscode.workspace` trust as the services see it (`core/trust.ts`). */
function workspaceTrust(): WorkspaceTrust {
  return {
    get isTrusted() {
      return vscode.workspace.isTrusted;
    },
    onDidGrant: (listener) => vscode.workspace.onDidGrantWorkspaceTrust(() => listener()),
  };
}

/** The workspace surface of the project index; folders that are not `file:` URIs are ignored. */
function projectWorkspace(disposables: DisposableStore): ProjectWorkspace {
  const ipkgCreatedOrDeleted = disposables.add(new Emitter<string>());
  const ipkgChanged = disposables.add(new Emitter<string>());
  const pathCreatedOrDeleted = disposables.add(new Emitter<string>());
  const forFiles =
    (emitter: Emitter<string>) =>
    (uri: vscode.Uri): void => {
      if (uri.scheme === 'file') {
        emitter.fire(uri.fsPath);
      }
    };
  const ipkgWatcher = disposables.add(vscode.workspace.createFileSystemWatcher('**/*.ipkg'));
  disposables.add(ipkgWatcher.onDidCreate(forFiles(ipkgCreatedOrDeleted)));
  disposables.add(ipkgWatcher.onDidChange(forFiles(ipkgChanged)));
  disposables.add(ipkgWatcher.onDidDelete(forFiles(ipkgCreatedOrDeleted)));
  // Every path, folders included (a deleted or moved folder is often reported alone), created
  // and deleted only: a change of a file's content changes no walk and no model but its .ipkg's.
  const pathWatcher = disposables.add(vscode.workspace.createFileSystemWatcher('**/*', false, true, false));
  disposables.add(pathWatcher.onDidCreate(forFiles(pathCreatedOrDeleted)));
  disposables.add(pathWatcher.onDidDelete(forFiles(pathCreatedOrDeleted)));
  return {
    folders: () =>
      (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
    onDidChangeFolders: (listener) => vscode.workspace.onDidChangeWorkspaceFolders(() => listener()),
    findIpkgFiles: async () =>
      (await vscode.workspace.findFiles('**/*.ipkg')).filter((uri) => uri.scheme === 'file').map((uri) => uri.fsPath),
    onDidCreateOrDeleteIpkgFile: ipkgCreatedOrDeleted.event,
    onDidChangeIpkgFile: ipkgChanged.event,
    onDidCreateOrDeletePath: pathCreatedOrDeleted.event,
  };
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  store = new DisposableStore();
  context.subscriptions.push(store);
  const manifest = context.extension.packageJSON as { version?: string; bugs?: { url?: string } };

  const log = store.add(createLog());
  store.add(registerHelpCommands(log, context.extension.id));
  store.add(
    trackIsIdrisDocumentContext({
      activeDocument: () => vscode.window.activeTextEditor?.document,
      onDidChangeActiveDocument: (listener) => {
        const events = new DisposableStore();
        events.add(vscode.window.onDidChangeActiveTextEditor(listener));
        events.add(vscode.workspace.onDidOpenTextDocument(listener));
        return events;
      },
      setContext: (key, value) => {
        void vscode.commands.executeCommand('setContext', key, value);
      },
    }),
  );
  store.add(registerSelectionRanges());

  const homeDir = usableHomeDirectory(os.homedir());
  if (homeDir === undefined) {
    log.warn(
      `The home directory is unknown (os.homedir() returned ${JSON.stringify(os.homedir())}): a leading ~ in the ` +
        'idris2.toolchain paths is not expanded, ~/.idris2/bin is not searched, and no terminal is opened for the install commands.',
    );
  }
  const config = new Config(vscode.workspace, homeDir);
  const trust = workspaceTrust();
  const runner = store.add(createProcessRunner({ trust, log }));
  const toolchain = store.add(
    createToolchainService({
      config,
      trust,
      runner,
      log,
      platform: process.platform,
      homeDir,
      processEnv: process.env,
    }),
  );
  const workspaceSurface = projectWorkspace(store);
  const projects = store.add(createProjectIndex({ workspace: workspaceSurface, toolchain, runner, trust, log }));
  const registry = store.add(new BackendRegistry());

  // M2: IDE mode. Nothing here starts a process: a session starts with its first request.
  const workspaceFolders = (): readonly string[] =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  const consent = store.add(
    registerConsent(vscode, {
      trust,
      folders: workspaceFolders,
      onDidChangeFolders: (listener) => vscode.workspace.onDidChangeWorkspaceFolders(() => listener()),
      realpath: (p) => fs.promises.realpath(p),
      platform: process.platform,
      globalState: context.globalState,
      log,
    }),
  );
  const trace = store.add(new ProtocolTraceChannel(vscode, config));
  const pool = store.add(
    createSessionPool({
      toolchain,
      projects,
      config,
      trust,
      gate: consent.gate,
      codec: ideCodec,
      trace,
      log,
      platform: process.platform,
      processEnv: process.env,
    }),
  );
  const ideMode = store.add(
    new IdeMode({
      pool,
      projects,
      config,
      clock: systemClock,
      gate: consent.gate,
      api: vscode,
      readFile: readSourceFile,
      realpath: (p) => fs.promises.realpath(p),
      findPackage: async (dir) => (await findIpkg(dir))?.ipkgPath,
      directoryId: async (p) => {
        const stat = await fs.promises.stat(p, { bigint: true });
        return `${stat.dev}:${stat.ino}`;
      },
      platform: process.platform,
      isOpen: (fileName) => vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'file' && d.fileName === fileName),
      openText: (fileName) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.fileName === fileName)?.getText(),
    }),
  );
  store.add(registry.setProvider(ideMode));
  const checks = store.add(
    new DocumentChecks(vscode, {
      readFile: async (p, maxBytes) => {
        const read = await readRegularTextFile(p, maxBytes);
        return read.ok ? read.text : undefined;
      },
      registry,
      roots: ideMode,
      projects,
      config,
      trust,
      consent: consent.gate,
      log,
      timers: { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) },
    }),
  );
  const backendCommands = store.add(
    registerBackendCommands(vscode, { checks, control: ideMode, projects, toolchain, trust, log }),
  );

  // M3: read-only intelligence and evaluation. Registering starts nothing: the providers ask the
  // backend when VS Code calls them, through one DocumentQueries (which loads a document the way
  // Check File does when its file is not the one loaded); the loads they follow are IdeMode's.
  const intelligenceDeps: IntelligenceDeps = {
    queries: createDocumentQueries({ registry, projects, checks, config, trust, log }),
    loads: ideMode,
    registry,
    projects,
    checks,
    config,
    log,
  };
  const intelligence = store.add(
    registerIntelligence(vscode, intelligenceDeps, { keepNotices: context.extensionMode === vscode.ExtensionMode.Test }),
  );
  store.add(registerCompletion(vscode, { ...intelligenceDeps, warmUp: ideMode }));
  store.add(registerInlayHints(vscode, intelligenceDeps));
  const evaluation = store.add(
    registerEvaluation(
      vscode,
      { registry, projects, config, trust, log },
      { keepOutcomes: context.extensionMode === vscode.ExtensionMode.Test },
    ),
  );

  // M4: interactive editing and holes. Registering starts nothing: the commands ask when they are
  // run (through the same DocumentQueries), the holes model after the loads the checks make.
  const editing = store.add(
    registerEditing(
      vscode,
      { queries: intelligenceDeps.queries, loads: ideMode, registry, projects, checks, config, trust, log },
      { keepOutcomes: context.extensionMode === vscode.ExtensionMode.Test },
    ),
  );
  const holes = store.add(registerHoles(vscode, { queries: intelligenceDeps.queries, loads: ideMode, releases: ideMode, registry, log }));
  store.add(
    trackIsIdrisWorkspace({
      // One result is enough (`maxResults`): the project index lists them all itself.
      hasIpkgFile: async () => (await vscode.workspace.findFiles('**/*.ipkg', undefined, 1)).some((uri) => uri.scheme === 'file'),
      onDidCreateOrDeleteIpkgFile: workspaceSurface.onDidCreateOrDeleteIpkgFile,
      onDidChangeFolders: workspaceSurface.onDidChangeFolders,
      openDocuments: () => vscode.workspace.textDocuments,
      onDidOpenDocument: (listener) => vscode.workspace.onDidOpenTextDocument(listener),
      setContext: (key, value) => {
        void vscode.commands.executeCommand('setContext', key, value);
      },
      log,
    }),
  );
  store.add(registerShowKeybindings(vscode, { config, manifest: context.extension.packageJSON, platform: process.platform }));

  store.add(
    registerTraceCommands(vscode, {
      acceptArgument: context.extensionMode === vscode.ExtensionMode.Test,
      trace,
      raw: ideMode,
      projects,
      log,
    }),
  );

  const status = store.add(
    registerToolchainStatus(vscode, { toolchain, projects, registry, checks, trust, manifest, log }),
  );
  const setup = store.add(
    registerSetupInformation(vscode, {
      toolchain,
      projects,
      trust,
      extension: {
        id: context.extension.id,
        version: manifest.version ?? '(unknown version)',
        issuesUrl: manifest.bugs?.url,
      },
      os: { platform: process.platform, release: os.release(), arch: process.arch, nodeVersion: process.version },
      log,
    }),
  );
  store.add(registerInstallCommands(vscode, { toolchain, config, platform: process.platform, homeDir }));
  const notifications = store.add(registerToolchainNotifications(vscode, toolchain, log));

  log.info(`vscode-idris2 ${manifest.version ?? '(unknown version)'} activated`);

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return undefined;
  }
  return {
    toolchain,
    projects,
    registry,
    statusItem: status.item,
    statusMenuEntries: () => status.menuEntries(),
    notices: notifications.shown,
    setupInformationUri: setup.uri,
    sessions: pool,
    checks,
    consent: consent.gate,
    backendNotices: backendCommands.notices,
    intelligenceNotices: intelligence.notices,
    evaluations: evaluation.outcomes,
    evaluationResults: (uri) => evaluation.drawn(uri.toString()),
    editing,
    holes: holes.model,
    holesTree: holes.tree,
    holesView: holes.view,
  };
}

export function deactivate(): void {
  store?.dispose();
  store = undefined;
}
