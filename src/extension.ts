/**
 * Extension entry point (`src/extension.ts` in docs/ARCHITECTURE.md §2).
 *
 * activate() builds, in this order: the log channel, M0's Help commands, `idris2.isIdrisDocument`
 * and selection ranges; then M1's chain Config → workspace trust → process runner → toolchain
 * service → project index → backend registry → the toolchain UI (status item and QuickPick,
 * Setup Information, install commands, notifications). deactivate() disposes all of it in
 * reverse order.
 *
 * Activation stays cheap: nothing here waits for a process or the file system. The toolchain
 * service starts its first scan when it is created and the UI follows its change events; every
 * process goes through the runner, which starts nothing in an untrusted workspace (Restricted
 * Mode, package.json `capabilities.untrustedWorkspaces`).
 */
import * as os from 'os';
import * as vscode from 'vscode';
import { BackendRegistry } from './backend/registry';
import { Config, usableHomeDirectory } from './core/config';
import { DisposableStore } from './core/disposable';
import { Emitter } from './core/event';
import { createLog } from './core/log';
import { createProcessRunner } from './core/process';
import type { WorkspaceTrust } from './core/trust';
import { registerHelpCommands } from './features/help/commands';
import { registerSelectionRanges } from './features/syntax/selectionRanges';
import { createProjectIndex } from './project/index';
import { trackIsIdrisDocumentContext } from './project/literate';
import type { ProjectIndex, ProjectWorkspace } from './project/types';
import { registerInstallCommands } from './toolchain/install';
import { registerToolchainNotifications, type Notice } from './toolchain/notifications';
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
  const projects = store.add(
    createProjectIndex({ workspace: projectWorkspace(store), toolchain, runner, trust, log }),
  );
  const registry = store.add(new BackendRegistry());

  const status = store.add(
    registerToolchainStatus(vscode, { toolchain, projects, registry, trust, manifest, log }),
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
  };
}

export function deactivate(): void {
  store?.dispose();
  store = undefined;
}
