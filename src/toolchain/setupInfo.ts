/**
 * **Idris 2: Show Setup Information**, **Idris 2: Report Issue…** and **Idris 2: Rescan
 * Toolchain** (ROADMAP M1; `toolchain/status.ts` in docs/ARCHITECTURE.md §2 lists them with the
 * status surface, they live here to keep that file to the status item).
 *
 * Setup Information is a read-only virtual Markdown document (scheme `idris2-setup`) that says
 * what the last toolchain scan found and how: each executable's path and the search step that
 * found it, every command the scan ran with its raw output and the values parsed from it
 * (`idris2 --version`, `--ttc-version`, `--paths`, `--list-packages`, `idris2-lsp --version`),
 * pack's layout and collection, the pair verdict with its reason, the workspace trust state, the
 * projects in the workspace and the active document's root, and the extension, VS Code and OS
 * versions. It is refreshed whenever the toolchain snapshot, the project index or the trust
 * state changes. Report Issue… opens VS Code's issue reporter for this extension with that text
 * as the issue body. Of `idris2.toolchain.env` it therefore shows the values only of the
 * variables that name directories or programs (`SHOWN_ENV_VALUE`, with any `user:password@` of
 * a URL masked), and of the others only their names, since those may hold tokens or a proxy's
 * password.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`, so
 * the renderer is unit-tested on plain Node.
 */
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../core/disposable';
import type { Log } from '../core/log';
import { plainText } from '../core/notificationText';
import type { WorkspaceTrust } from '../core/trust';
import { isIdrisDocument } from '../project/literate';
import type { Classification, IpkgDependency, ProjectIndex, ProjectRoot } from '../project/types';
import type {
  Idris2Info,
  LspInfo,
  PackState,
  ProbeRecord,
  ToolchainService,
  ToolchainSnapshot,
  ToolLocation,
  ToolState,
  ToolVersion,
} from './types';

export const SETUP_SCHEME = 'idris2-setup';
export const SHOW_SETUP_COMMAND = 'idris2.showSetupInformation';
export const RESCAN_COMMAND = 'idris2.rescanToolchain';
export const REPORT_ISSUE_COMMAND = 'idris2.reportIssue';
/**
 * VS Code's command for the issue reporter. It takes `{ extensionId, issueTitle, issueBody }`,
 * and is registered only when `telemetry.feedback.enabled` is true and the product has an
 * issue URL [src: VS Code 1.139.1 workbench bundle, `vscode.openIssueReporter` next to
 * `workbench.action.openIssueReporter`]; it is not in `@types/vscode` 1.138.
 */
const ISSUE_REPORTER_COMMAND = 'vscode.openIssueReporter';

// -------------------------------------------------------------------------------------------
// The document text
// -------------------------------------------------------------------------------------------

export interface HostInfo {
  readonly appName: string;
  readonly vscodeVersion: string;
  /** `vscode.env.remoteName`: `undefined` for a local window. */
  readonly remoteName: string | undefined;
  /** `process.platform`, `os.release()`, `process.arch`, `process.version` of the Extension Host. */
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly nodeVersion: string;
}

export interface ActiveDocumentInfo {
  readonly path: string;
  readonly classification: Classification;
  readonly moduleName: string | undefined;
  readonly sessionCwd: string;
}

export interface SetupInput {
  readonly generatedAt: Date;
  readonly extension: { readonly id: string; readonly version: string };
  readonly host: HostInfo;
  readonly trusted: boolean;
  readonly scanning: boolean;
  readonly snapshot: ToolchainSnapshot | undefined;
  /** `ProjectIndex.roots()`: the projects whose `.ipkg` lies inside a workspace folder. */
  readonly projects: readonly ProjectRoot[];
  /** The last active Idris document with a file path, if any. */
  readonly activeDocument: ActiveDocumentInfo | undefined;
}

/** The length of the longest run of backticks in `text` (0 when it has none). */
function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
}

/**
 * Inline code showing `value` as it is. CommonMark ends a code span at the first run of
 * backticks as long as its opening one and strips one space from each end when both ends have
 * one, so the delimiter is one backtick longer than the longest run in the value, and the
 * value is padded with a space on each side when it contains a backtick (which could otherwise
 * touch the delimiter) or both starts and ends with a space.
 */
function code(value: string): string {
  const delimiter = '`'.repeat(longestBacktickRun(value) + 1);
  const pad = value.includes('`') || (value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '');
  return pad ? `${delimiter} ${value} ${delimiter}` : `${delimiter}${value}${delimiter}`;
}

/** A fenced block longer than any run of backticks inside `text`, so the text cannot end it. */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}text\n${text.endsWith('\n') ? text : `${text}\n`}${fence}`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function describeVersion(version: ToolVersion | undefined): string {
  if (version === undefined) {
    return 'not recognised';
  }
  const tag = version.tag === undefined ? 'no tag' : `tag ${code(version.tag)}`;
  return `${code(version.text)} (major ${version.major}, minor ${version.minor}, patch ${version.patch}, ${tag})`;
}

function describeLocation(location: ToolLocation): string[] {
  const lines = [`- Path: ${code(location.path)}`, `- Found by: ${location.source} — ${location.detail}`];
  if (location.inPackDirectory) {
    lines.push(`- In one of pack's directories${location.packCollection === undefined ? '' : `: the bin directory of collection ${code(location.packCollection)}`}`);
  }
  return lines;
}

function describeProbe(tool: string, probe: ProbeRecord): string[] {
  const { result } = probe;
  let outcome: string;
  if (result.spawnError !== undefined) {
    outcome = `could not be started: ${result.spawnError}`;
  } else if (result.timedOut) {
    outcome = 'killed after the time limit';
  } else if (result.exitCode !== null) {
    outcome = `exit code ${result.exitCode}`;
  } else {
    outcome = `ended by signal ${result.signal ?? '(unknown)'}`;
  }
  const output = (name: string, text: string): string => (text === '' ? `${name}: (empty)` : `${name}:\n\n${fenced(text)}`);
  return [
    '',
    `### ${code([tool, ...probe.args].join(' '))}`,
    '',
    `${outcome}, ${Math.round(result.durationMs)} ms`,
    '',
    output('stdout', result.stdout),
    '',
    output('stderr', result.stderr),
  ];
}

function describeSearch(searched: readonly string[]): string[] {
  return searched.length === 0 ? [] : ['- Searched, in order:', ...searched.map((place) => `  - ${code(place)}`)];
}

function describeTool<Info>(
  name: string,
  state: ToolState<Info>,
  describeInfo: (info: Info) => string[],
  probesOf: (info: Info) => readonly ProbeRecord[],
): string[] {
  const lines = [`## ${name}`, ''];
  switch (state.status) {
    case 'missing':
      lines.push(`- Not found. ${state.reason}`, ...describeSearch(state.searched));
      break;
    case 'located':
      lines.push(...describeLocation(state.location), '- Not run: the workspace is not trusted (Restricted Mode).');
      break;
    case 'probed':
      lines.push(...describeLocation(state.location), ...describeInfo(state.info));
      for (const probe of probesOf(state.info)) {
        lines.push(...describeProbe(name, probe));
      }
      break;
    case 'failed':
      lines.push(...describeLocation(state.location), `- Failed: ${state.reason}`);
      for (const probe of state.probes) {
        lines.push(...describeProbe(name, probe));
      }
      break;
  }
  return lines;
}

function describeIdris2(info: Idris2Info): string[] {
  const notRun = (flag: string): boolean => info.notRun?.probes.some((args) => args[0] === flag) === true;
  const unknown = (flag: string): string =>
    notRun(flag)
      ? `unknown (not run: ${code(['idris2', ...(info.notRun?.after ?? [])].join(' '))} timed out before it)`
      : 'unknown (the probe failed or its output was not recognised)';
  const lines = [
    `- Version line: ${code(info.versionLine)}`,
    `- Version: ${describeVersion(info.version)}`,
    `- TTC version: ${info.ttcVersion === undefined ? unknown('--ttc-version') : code(info.ttcVersion)}`,
  ];
  if (info.pathsText === undefined) {
    lines.push(`- Paths (\`--paths\`): ${unknown('--paths')}`);
  }
  if (info.packages === undefined) {
    lines.push(`- Installed packages (\`--list-packages\`): ${unknown('--list-packages')}`);
  } else {
    lines.push(`- Installed packages (\`--list-packages\`): ${info.packages.length}`);
    for (const pkg of info.packages) {
      const ttc = pkg.ttcVersions.length === 0 ? '' : `, TTC ${pkg.ttcVersions.join(', ')}`;
      lines.push(`  - ${code(pkg.name)} ${pkg.version ?? '(unversioned)'}${ttc} — ${code(pkg.path)}`);
    }
  }
  return lines;
}

function describeLsp(info: LspInfo): string[] {
  return [
    `- Server line: ${code(info.serverVersionLine)}`,
    `- Server version: ${describeVersion(info.serverVersion)}`,
    `- API line: ${code(info.apiVersionLine)}`,
    `- Idris2 API version: ${describeVersion(info.apiVersion)}`,
  ];
}

function describePack(state: PackState): string[] {
  const lines = ['## pack', ''];
  if (state.status === 'missing') {
    lines.push(`- Not found. ${state.reason}`, ...describeSearch(state.searched));
    return lines;
  }
  const { info } = state;
  const directory = (dir: string | undefined): string =>
    dir === undefined ? 'none: `HOME` is not an absolute path, and pack then stops with its NoPackDir error' : code(dir);
  lines.push(
    ...describeLocation(info.location),
    `- Configuration directory: ${directory(info.configDir)}`,
    `- State directory: ${directory(info.stateDir)}`,
    `- Current collection: ${info.collection === undefined ? 'unknown (could not read `collection` from pack.toml)' : code(info.collection)}`,
    `- Collection bin directory: ${info.collectionBinDir === undefined ? 'none' : code(info.collectionBinDir)}`,
    "- The extension never starts pack itself; this is read from the file system. (pack's `idris2` and `idris2-lsp` wrappers run pack when they are probed.)",
  );
  return lines;
}

function describeDependency(dep: IpkgDependency): string {
  const bounds = dep.bounds;
  if (bounds.lower === undefined && bounds.upper === undefined) {
    return code(dep.name);
  }
  const parts: string[] = [];
  if (bounds.lower !== undefined) {
    parts.push(`${bounds.lowerInclusive ? '>=' : '>'} ${bounds.lower}`);
  }
  if (bounds.upper !== undefined) {
    parts.push(`${bounds.upperInclusive ? '<=' : '<'} ${bounds.upper}`);
  }
  return `${code(dep.name)} ${parts.join(' && ')}`;
}

/** Why a root's model is not the compiler's although it might have been. */
const OUTSIDE_WORKSPACE =
  'outside the workspace folders, so it is read by the built-in reader, not the compiler (workspace trust does not cover the folders above)';

function describeProject(root: ProjectRoot): string[] {
  const lines = [`### ${code(root.ipkgPath)}`, '', `- Directory (the working directory of its sessions): ${code(root.dir)}`];
  if (!root.insideWorkspace) {
    lines.push(`- The .ipkg lies ${OUTSIDE_WORKSPACE}.`);
  }
  if (root.otherIpkgs.length > 0) {
    lines.push(
      `- **Other .ipkg files in this directory:** ${root.otherIpkgs.map(code).join(', ')}. The compiler uses the first one its directory listing returns (F10), so which one applies depends on the file system; keep one .ipkg per directory.`,
    );
  }
  const source =
    root.model.source === 'dump-json' ? 'read by the compiler (`idris2 --dump-ipkg-json`)' : 'read by the built-in fallback reader (limited)';
  if (root.model.status === 'error') {
    const { error } = root.model;
    const range =
      error.range === undefined
        ? ''
        : ` at ${error.range.startLine}:${error.range.startColumn}--${error.range.endLine}:${error.range.endColumn}`;
    lines.push(`- Could not be read${range}, ${source}:`, '', fenced(error.message));
    return lines;
  }
  const { model } = root.model;
  lines.push(
    `- Model ${source}:`,
    `  - package: ${code(model.name)}${model.version === undefined ? '' : ` ${model.version}`}`,
    `  - sourcedir: ${model.sourcedir === undefined ? '(not set: the .ipkg directory)' : code(model.sourcedir)}`,
    `  - builddir: ${model.builddir === undefined ? '(not set)' : code(model.builddir)}`,
    `  - depends: ${model.depends.length === 0 ? '(none)' : model.depends.map(describeDependency).join(', ')}`,
    `  - modules: ${model.modules.length === 0 ? '(none)' : model.modules.map(code).join(', ')}`,
  );
  if (model.main !== undefined || model.executable !== undefined) {
    lines.push(`  - main: ${model.main ?? '(not set)'}, executable: ${model.executable ?? '(not set)'}`);
  }
  return lines;
}

function describeClassification(classification: Classification): string {
  if (classification.kind === 'loose') {
    return `loose file (no .ipkg in ${code(classification.dir)} or above it)`;
  }
  return `project ${code(classification.ipkgPath)}${classification.insideWorkspace ? '' : `, ${OUTSIDE_WORKSPACE}`}`;
}

/**
 * The variables of `idris2.toolchain.env` whose values Setup Information shows: those that name
 * directories or programs for the search and the tools (`PATH`, `PATHEXT`, Chez Scheme's
 * `CHEZ`, and the `IDRIS2_*`, `PACK_*` and `XDG_*` families). Names are compared
 * case-insensitively, as Windows does.
 */
const SHOWN_ENV_VALUE = /^(?:PATH|PATHEXT|CHEZ|IDRIS2_\w*|PACK_\w*|XDG_\w*)$/i;

/**
 * `value` with the `user:password@` part of every URL in it replaced by `…@`: everything from
 * the `//` to the **last** `@` before the next white space. A URL parser takes the user
 * information up to the last `@` of the authority (the WHATWG parser reads
 * `http://user:p@ss@proxy` as password `p%40ss`), and a raw `/` in a password is not valid but
 * may still be written; masking up to the last `@` of the word hides the password in both
 * cases, at the price of hiding more than the user information when a later part of the word
 * has an `@` too.
 */
function maskCredentials(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)\S*@/gi, '$1…@');
}

/** One entry of `idris2.toolchain.env`: `NAME=value`, or the name alone (see `SHOWN_ENV_VALUE`). */
function describeEnvEntry(name: string, value: string): string {
  return SHOWN_ENV_VALUE.test(name)
    ? code(`${name}=${maskCredentials(value)}`)
    : `${code(name)} (value not shown, ${Array.from(value).length} characters)`;
}

/** The text of the Setup Information document. */
export function renderSetupInformation(input: SetupInput): string {
  const { host, snapshot } = input;
  const lines: string[] = [
    '# Idris 2: Setup Information',
    '',
    `Generated ${input.generatedAt.toISOString()} by ${input.extension.id} ${input.extension.version}. ` +
      'Read-only; it follows every rescan (**Idris 2: Rescan Toolchain**), and **Idris 2: Report Issue…** ' +
      'puts it into an issue report. It contains paths of this machine, and the values of the path variables ' +
      'of `idris2.toolchain.env` (its other variables by name only): review it before sharing it.',
    '',
    '## Environment',
    '',
    `- ${host.appName} ${host.vscodeVersion}${host.remoteName === undefined ? '' : `, remote ${code(host.remoteName)}`}`,
    `- OS: ${host.platform} ${host.release} (${host.arch}); Extension Host Node ${host.nodeVersion}`,
    `- Workspace trust: ${input.trusted ? 'trusted' : 'not trusted — Restricted Mode: no program is run, so nothing below was run'}`,
    '',
  ];

  if (snapshot === undefined) {
    lines.push('## Toolchain', '', input.scanning ? 'The first scan is still running.' : 'No scan has finished.', '');
  } else {
    const { settings } = snapshot;
    const pathSetting = (value: string): string => (value === '' ? '(empty: discover)' : code(value));
    const env = Object.entries(settings.env);
    lines.push(
      '## Settings used by the last scan (`idris2.toolchain.*`)',
      '',
      `- idris2Path: ${pathSetting(settings.idris2Path)}`,
      `- lspPath: ${pathSetting(settings.lspPath)}`,
      `- packPath: ${pathSetting(settings.packPath)}`,
      `- preferPack: ${settings.preferPack}`,
      `- env: ${env.length === 0 ? '(none)' : env.map(([k, v]) => describeEnvEntry(k, v)).join(', ')}`,
      ...settings.ignoredEnvEntries.map((e) => `- env entry ${code(e.key)} ignored: ${e.reason}`),
      '',
      '## Last scan',
      '',
      `- Scan #${snapshot.generation} (${snapshot.reason}), finished ${new Date(snapshot.finishedAt).toISOString()}`,
      `- Workspace trusted when it started: ${yesNo(snapshot.trusted)}; a new scan is running now: ${yesNo(input.scanning)}`,
      ...snapshot.errors.map((e) => `- Scan error: ${e}`),
      '',
      ...describeTool('idris2', snapshot.idris2, describeIdris2, (info) => info.probes),
      '',
      ...describeTool('idris2-lsp', snapshot.lsp, describeLsp, (info) => info.probes),
      '',
      ...describePack(snapshot.pack),
      '',
      '## Pair verdict (idris2-lsp and idris2)',
      '',
      snapshot.verdict === undefined
        ? 'No idris2-lsp was found, so there is no pair to judge.'
        : `**${snapshot.verdict.kind}**: ${snapshot.verdict.reason}`,
      '',
    );
  }

  lines.push('## Projects in the workspace', '');
  if (input.projects.length === 0) {
    lines.push('No .ipkg file inside the workspace folders.', '');
  } else {
    for (const root of input.projects) {
      lines.push(...describeProject(root), '');
    }
  }

  lines.push('## Active document', '');
  const active = input.activeDocument;
  if (active === undefined) {
    lines.push('No Idris document with a file path has been active.');
  } else {
    lines.push(
      `- ${code(active.path)}`,
      `- Belongs to: ${describeClassification(active.classification)}`,
      `- Module name: ${active.moduleName === undefined ? '(none: outside the source directory, or not an Idris file name)' : code(active.moduleName)}`,
      `- Session working directory: ${code(active.sessionCwd)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** The body **Report Issue…** hands to the issue reporter. */
export function issueBody(setupInformation: string): string {
  return [
    '<!-- What did you do, what did you expect, and what happened instead? -->',
    '',
    '',
    '<details>',
    '<summary>Setup Information</summary>',
    '',
    setupInformation,
    '</details>',
    '',
  ].join('\n');
}

// -------------------------------------------------------------------------------------------
// The VS Code side
// -------------------------------------------------------------------------------------------

export type SetupApi = Pick<typeof vscode, 'commands' | 'workspace' | 'window' | 'env' | 'Uri' | 'EventEmitter' | 'version'>;

export interface SetupDeps {
  readonly toolchain: ToolchainService;
  readonly projects: Pick<ProjectIndex, 'roots' | 'classify' | 'pathToModule' | 'sessionCwd' | 'onDidChange'>;
  readonly trust: WorkspaceTrust;
  /** `issuesUrl` is package.json's `bugs.url`. */
  readonly extension: { readonly id: string; readonly version: string; readonly issuesUrl: string | undefined };
  /** Everything of `HostInfo` that does not come from `api`. */
  readonly os: Pick<HostInfo, 'platform' | 'release' | 'arch' | 'nodeVersion'>;
  readonly log: Log;
}

export interface SetupInformation extends IDisposable {
  /** The URI of the Setup Information document. */
  readonly uri: vscode.Uri;
  /** The document text as of now. */
  render(): Promise<string>;
}

/**
 * Registers the Setup Information document provider and the commands Show Setup Information,
 * Rescan Toolchain and Report Issue….
 */
export function registerSetupInformation(api: SetupApi, deps: SetupDeps): SetupInformation {
  const store = new DisposableStore();
  const uri = api.Uri.from({ scheme: SETUP_SCHEME, path: '/Idris 2 Setup Information.md' });
  const changed = store.add(new api.EventEmitter<vscode.Uri>());

  // The Idris document the report describes: the active editor's, or the last one before the
  // Setup Information editor itself became active.
  let lastDocument: string | undefined;
  const followActiveEditor = (): void => {
    const doc = api.window.activeTextEditor?.document;
    if (doc !== undefined && doc.uri.scheme === 'file' && isIdrisDocument(doc)) {
      lastDocument = doc.uri.fsPath;
    }
  };
  followActiveEditor();
  store.add(api.window.onDidChangeActiveTextEditor(followActiveEditor));

  const render = async (): Promise<string> => {
    let activeDocument: ActiveDocumentInfo | undefined;
    if (lastDocument !== undefined) {
      const path = lastDocument;
      const classification = await deps.projects.classify(path);
      activeDocument = {
        path,
        classification,
        moduleName: deps.projects.pathToModule(classification, path),
        sessionCwd: deps.projects.sessionCwd(classification),
      };
    }
    return renderSetupInformation({
      generatedAt: new Date(),
      extension: deps.extension,
      host: { ...deps.os, appName: api.env.appName, vscodeVersion: api.version, remoteName: api.env.remoteName },
      trusted: deps.trust.isTrusted,
      scanning: deps.toolchain.scanning,
      snapshot: deps.toolchain.current,
      projects: await deps.projects.roots(),
      activeDocument,
    });
  };

  store.add(
    api.workspace.registerTextDocumentContentProvider(SETUP_SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: () => render(),
    }),
  );
  const refresh = (): void => changed.fire(uri);
  store.add(deps.toolchain.onDidChange(refresh));
  store.add(deps.projects.onDidChange(refresh));
  store.add(deps.trust.onDidGrant(refresh));

  store.add(
    api.commands.registerCommand(SHOW_SETUP_COMMAND, async () => {
      followActiveEditor();
      refresh(); // an already loaded document is re-read; a new one is rendered on open
      const doc = await api.workspace.openTextDocument(uri);
      await api.window.showTextDocument(doc, { preview: false });
    }),
  );
  store.add(api.commands.registerCommand(RESCAN_COMMAND, () => deps.toolchain.rescan('command')));
  store.add(
    api.commands.registerCommand(REPORT_ISSUE_COMMAND, async () => {
      followActiveEditor();
      const body = issueBody(await render());
      try {
        await api.commands.executeCommand(ISSUE_REPORTER_COMMAND, { extensionId: deps.extension.id, issueBody: body });
      } catch (error) {
        // Not registered when feedback is disabled (`telemetry.feedback.enabled`) or the build
        // has no issue URL: hand the report over through the clipboard instead.
        deps.log.warn(`${ISSUE_REPORTER_COMMAND} failed: ${String(error)}`);
        await api.env.clipboard.writeText(body);
        const { issuesUrl } = deps.extension;
        const open = 'Open Issues Page';
        const choice = await api.window.showInformationMessage(
          plainText("VS Code's issue reporter is not available. The report, with the Setup Information, was copied to the clipboard."),
          ...(issuesUrl === undefined ? [] : [open]),
        );
        if (choice === open && issuesUrl !== undefined) {
          await api.env.openExternal(api.Uri.parse(issuesUrl));
        }
      }
    }),
  );

  return { uri, render, dispose: () => store.dispose() };
}
