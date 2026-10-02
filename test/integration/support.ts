/**
 * Shared helpers of the integration suites (`integration`, `simple-ipkg`, `toolchain-path`,
 * `diagnostics`, `loose-stdio`, `consent`, `intelligence`, `intelligence-loose`, `editing`, `holes` in
 * .vscode-test.mjs): the running extension's test API, polling, settings that tests change and
 * restore, (M2) sessions, diagnostics and the status text, (M3) the fake compiler's logs,
 * hovers, semantic tokens, inlay hints and evaluations as VS Code's commands return them, and (M4)
 * editing commands, their code actions and the dialogs they open. Not a test file itself (the
 * suites load `*.test.js` only).
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
// Type-only: the tests talk to the running extension (dist/extension.js), not to a second copy
// of its modules.
import type { IdeSession } from '../../src/backend/ide/types';
import type { TestApi } from '../../src/extension';
import type { EditingCommandId, EditingOutcome } from '../../src/features/editing/types';
import type { EvaluationOutcome } from '../../src/features/eval/register';
import type { ToolchainSnapshot } from '../../src/toolchain/types';

export const EXTENSION_ID = 'etairi.vscode-idris2';

/** Activates the extension (a no-op when a document already did) and returns its test API. */
export async function extensionApi(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test instance`);
  const api = await extension.activate();
  assert.ok(api, 'activate() returned no test API (is the extension running in ExtensionMode.Test?)');
  return api;
}

/**
 * Polls `probe` every 50 ms until it returns something other than `undefined`, and fails with
 * `what` after `deadlineMs` (10 s by default; no test relies on a deadline below 1 s,
 * ARCHITECTURE §12). A function `what` is called at the failure, so that the message describes
 * the state at the deadline, not at the start.
 */
export async function waitFor<T>(what: string | (() => string), probe: () => T | undefined, deadlineMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > deadlineMs) {
      assert.fail(`timed out after ${deadlineMs} ms waiting for ${typeof what === 'string' ? what : what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The last snapshot, once no scan is running and `accept` holds for it. */
export function settledScan(
  api: TestApi,
  what: string,
  accept: (snapshot: ToolchainSnapshot) => boolean = () => true,
): Promise<ToolchainSnapshot> {
  return waitFor(what, () => {
    const current = api.toolchain.current;
    return !api.toolchain.scanning && current !== undefined && accept(current) ? current : undefined;
  });
}

type ToolchainKey = 'idris2Path' | 'lspPath' | 'packPath' | 'env';

/**
 * Sets `idris2.toolchain.<key>` in the user settings (`undefined` removes the user value) and
 * waits for the rescan the change triggers: a settled snapshot whose settings show the value.
 */
export async function setToolchainSetting(
  api: TestApi,
  key: ToolchainKey,
  value: string | Record<string, string> | undefined,
): Promise<ToolchainSnapshot> {
  const config = vscode.workspace.getConfiguration('idris2.toolchain');
  await config.update(key, value, vscode.ConfigurationTarget.Global);
  const expected = JSON.stringify(vscode.workspace.getConfiguration('idris2.toolchain').get(key));
  return settledScan(api, `a scan with idris2.toolchain.${key} = ${expected}`, (s) => JSON.stringify(s.settings[key]) === expected);
}

/** The fixture file `name` of the first workspace folder. */
export function workspaceFile(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder is missing');
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

// -------------------------------------------------------------------------------------------
// M2: IDE-mode sessions and diagnostics
// -------------------------------------------------------------------------------------------

/** The `check` session whose working directory is `dir`, if the pool has one. */
export function checkSession(api: TestApi, dir: string): IdeSession | undefined {
  return api.sessions.sessions().find((s) => s.role === 'check' && s.cwd === dir);
}

/** The diagnostics the extension shows for `uri` (its collection's, source `idris2`). */
export function idrisDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'idris2');
}

/** Waits until the diagnostics of `uri` satisfy `accept`, and returns them. */
export function diagnosticsWhen(
  uri: vscode.Uri,
  what: string,
  accept: (diagnostics: vscode.Diagnostic[]) => boolean,
): Promise<vscode.Diagnostic[]> {
  return waitFor(`the diagnostics of ${uri.fsPath}: ${what}`, () => {
    const diagnostics = idrisDiagnostics(uri);
    return accept(diagnostics) ? diagnostics : undefined;
  });
}

/** Opens a workspace file in an editor (which, with the onSave trigger, checks it). */
export async function showFile(...segments: string[]): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(workspaceFile(...segments));
  await vscode.window.showTextDocument(doc);
  return doc;
}

/**
 * Waits until the status item reads `text`; the failure message gives what it read at the deadline,
 * with `context()` (more state the test wants reported) appended.
 */
export function statusText(api: TestApi, text: string, context?: () => string): Promise<true> {
  return waitFor(
    () =>
      `the status item to read ${JSON.stringify(text)} (it reads ${JSON.stringify(api.statusItem.text)}` +
      `${context === undefined ? '' : `; ${context()}`})`,
    () => (api.statusItem.text === text ? true : undefined),
  );
}

/**
 * Saves `doc` with its content unchanged, so that the fake compiler's recordings (keyed by the
 * fixtures' SHA-256) still apply: two edits that cancel out make it dirty (VS Code compares
 * version ids, not text), then it is saved.
 */
export async function saveUnchanged(doc: vscode.TextDocument): Promise<void> {
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  const insert = new vscode.WorkspaceEdit();
  insert.insert(doc.uri, end, ' ');
  assert.ok(await vscode.workspace.applyEdit(insert));
  const remove = new vscode.WorkspaceEdit();
  remove.delete(doc.uri, new vscode.Range(end, end.translate(0, 1)));
  assert.ok(await vscode.workspace.applyEdit(remove));
  assert.ok(doc.isDirty, 'the document should be dirty before the save');
  assert.ok(await doc.save(), 'the document was not saved');
}

/**
 * Sets `idris2.<section>.<key>` in the user settings (`undefined` removes the user value) and
 * waits until the configuration reads it back.
 */
export async function setUserSetting(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(`idris2.${section}`).update(key, value, vscode.ConfigurationTarget.Global);
  await waitFor(`idris2.${section}.${key} to read ${JSON.stringify(value)}`, () => {
    const inspected = vscode.workspace.getConfiguration(`idris2.${section}`).inspect(key);
    return JSON.stringify(inspected?.globalValue) === JSON.stringify(value) ? true : undefined;
  });
}

/**
 * The command lines of the fake compiler's IDE-mode processes now running whose command line
 * names `dir` (their `--build-dir` lies below the session directory), from `ps` (POSIX; `-ww`: no
 * truncation), or `undefined` on Windows, where `ps` is not available.
 */
export function fakeIdeProcesses(dir: string): string[] | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  const out = execFileSync('/bin/ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes('fake-idris2.mjs') && line.includes('--ide-mode') && line.includes(dir));
}

/** Polls the asynchronous `probe` every 50 ms, like `waitFor` (10 s by default). */
export async function waitForAsync<T>(what: string | (() => string), probe: () => Promise<T | undefined>, deadlineMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > deadlineMs) {
      assert.fail(`timed out after ${deadlineMs} ms waiting for ${typeof what === 'string' ? what : what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * How long `settled` wants a session without a state change: well above the quiet the completion
 * warm-up waits for before it is sent (`WARM_UP_QUIET_MS`, 150 ms, `src/backend/ide/backend.ts`;
 * not imported, see above). Should that constant grow past it, a test that asserts no request
 * fails rather than passes.
 */
const SETTLE_MS = 1000;

/**
 * Waits until `session` is `ready` and its state has not changed for `SETTLE_MS`: the requests M3
 * sends on its own after a load (the completion warm-up, once the session has been idle for 150
 * ms) have then been sent and answered. `ready` alone is not enough (CLAUDE.md, M3 rules).
 */
export async function settled(session: IdeSession, deadlineMs = 10000): Promise<void> {
  let last = Date.now();
  const subscription = session.onDidChangeState(() => {
    last = Date.now();
  });
  try {
    await waitFor(
      () => `the session to be ready without a state change for ${SETTLE_MS} ms (it is ${session.state})`,
      () => (session.state === 'ready' && Date.now() - last >= SETTLE_MS ? true : undefined),
      deadlineMs,
    );
  } finally {
    subscription.dispose();
  }
}

/** Waits until the `check` session of `dir` is ready with `file` loaded (the load on open, or a query's). */
export function loadedIn(api: TestApi, dir: string, file: string): Promise<IdeSession> {
  return waitFor(
    () => `${file} to be loaded in the check session of ${dir} (it has ${JSON.stringify(checkSession(api, dir)?.loadedFile)})`,
    () => {
      const session = checkSession(api, dir);
      return session?.state === 'ready' && session.loadedFile?.path === file ? session : undefined;
    },
  );
}

// -------------------------------------------------------------------------------------------
// M3: the fake compiler's logs
// -------------------------------------------------------------------------------------------

/** A line of FAKE_IDRIS2_LOG: a command line the fake was started with. */
export interface FakeInvocation {
  readonly pid: number;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** A line of FAKE_IDRIS2_REQUEST_LOG: a request an IDE-mode process read. */
export interface FakeRequest {
  readonly pid: number;
  readonly request: string;
}

/** The session role a fake's command line names by its build directory (test/fake-idris2/README.md). */
export type FakeRole = 'check' | 'eval';

function readJsonLines<T>(file: string): T[] {
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as T)
    : [];
}

/**
 * The fake compiler's two logs (test/fake-idris2/README.md): FAKE_IDRIS2_LOG, the command lines
 * started, and FAKE_IDRIS2_REQUEST_LOG, every request each IDE-mode process read. A suite switches
 * them on with `setToolchainSetting(api, 'env', logs.env)`: the extension passes
 * `idris2.toolchain.env` to every process it starts, the `eval` session's included, so the logs
 * show what reached which session — and that a refused evaluation reached none.
 */
export class FakeLogs {
  readonly dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-fakelog-')));
  private readonly invocationFile = path.join(this.dir, 'invocations.jsonl');
  private readonly requestFile = path.join(this.dir, 'requests.jsonl');

  get env(): Record<string, string> {
    return { FAKE_IDRIS2_LOG: this.invocationFile, FAKE_IDRIS2_REQUEST_LOG: this.requestFile };
  }

  invocations(): FakeInvocation[] {
    return readJsonLines<FakeInvocation>(this.invocationFile);
  }

  requests(): FakeRequest[] {
    return readJsonLines<FakeRequest>(this.requestFile);
  }

  /** The role of the IDE-mode process `pid`: the last `--build-dir` of its command line. */
  roleOf(pid: number): FakeRole | undefined {
    const args = this.invocations().find((i) => i.pid === pid)?.args ?? [];
    const i = args.lastIndexOf('--build-dir');
    const base = i < 0 ? undefined : path.basename(args[i + 1] ?? '');
    return base === '.vscode-idris2' ? 'check' : base === '.vscode-idris2-eval' ? 'eval' : undefined;
  }

  /** The IDE-mode processes started in `role`. */
  started(role: FakeRole): FakeInvocation[] {
    return this.invocations().filter((i) => i.args.some((a) => a.startsWith('--ide-mode')) && this.roleOf(i.pid) === role);
  }

  /** The requests read by processes of `role`, from the `from`-th request of the log on. */
  requestsOf(role: FakeRole, from = 0): FakeRequest[] {
    return this.requests()
      .slice(from)
      .filter((r) => this.roleOf(r.pid) === role);
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------------------------------
// M3: what the language features return
// -------------------------------------------------------------------------------------------

/** The markdown of the hovers at `pos` (every provider's), as `vscode.executeHoverProvider` returns them. */
export async function hovers(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.MarkdownString[]> {
  const result = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos);
  return result.flatMap((h) =>
    h.contents.map((c) => (c instanceof vscode.MarkdownString ? c : new vscode.MarkdownString(typeof c === 'string' ? c : c.value))),
  );
}

/**
 * The text a reader sees of `markdown` written with `appendText` (VS Code 1.139.1 escapes markdown
 * punctuation with a backslash, writes each space and tab as `&nbsp;` and `>` as `\>`: `appendText`
 * and `B6` in its extension host bundle [src]). Applied to the whole value, code blocks included,
 * where it would drop a backslash before punctuation; none of the texts the tests look for has one.
 */
export function readableText(markdown: vscode.MarkdownString): string {
  return markdown.value.replace(/&nbsp;/g, ' ').replace(/\\([\\`*_{}[\]()#+!~>-])/g, '$1');
}

/**
 * Waits until a hover at `pos` contains `text` (in `readableText`), and returns that hover's
 * markdown. The first hover of a document may load it first (a passive query of the active
 * document), so it is asked again.
 */
export function hoverWith(uri: vscode.Uri, pos: vscode.Position, text: string): Promise<vscode.MarkdownString> {
  let last: string[] = [];
  return waitForAsync(
    () => `a hover at ${pos.line}:${pos.character} of ${path.basename(uri.fsPath)} containing ${JSON.stringify(text)} (last: ${JSON.stringify(last)})`,
    async () => {
      const found = await hovers(uri, pos);
      last = found.map((m) => m.value);
      return found.find((m) => readableText(m).includes(text));
    },
  );
}

/**
 * The hard rules for compiler text in a hover (features/intelligence/types.ts): never trusted, no
 * HTML, no theme icons.
 */
export function assertUntrustedMarkdown(markdown: vscode.MarkdownString): void {
  assert.ok(!markdown.isTrusted, `a hover is trusted: ${markdown.value}`);
  assert.ok(!markdown.supportHtml, `a hover renders HTML: ${markdown.value}`);
  assert.ok(!markdown.supportThemeIcons, `a hover renders theme icons: ${markdown.value}`);
}

/** One semantic token, decoded with the provider's legend. */
export interface DecodedToken {
  readonly line: number;
  readonly character: number;
  readonly length: number;
  readonly type: string;
  readonly modifiers: number;
}

/** The semantic tokens of `uri` as VS Code gets them from the providers, decoded (VS Code's relative encoding). */
export async function semanticTokens(uri: vscode.Uri): Promise<DecodedToken[]> {
  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>('vscode.provideDocumentSemanticTokensLegend', uri);
  const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>('vscode.provideDocumentSemanticTokens', uri);
  if (legend === undefined || tokens === undefined) {
    return [];
  }
  const out: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < tokens.data.length; i += 5) {
    const [deltaLine, deltaStart, length, type, modifiers] = tokens.data.subarray(i, i + 5);
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    out.push({ line, character, length, type: legend.tokenTypes[type] ?? `#${type}`, modifiers });
  }
  return out;
}

/** Waits until the semantic tokens of `uri` satisfy `accept` (they come with the document's load). */
export function semanticTokensWhen(uri: vscode.Uri, what: string, accept: (tokens: DecodedToken[]) => boolean): Promise<DecodedToken[]> {
  let last: DecodedToken[] = [];
  return waitForAsync(
    () => `the semantic tokens of ${path.basename(uri.fsPath)}: ${what} (${last.length} tokens: ${JSON.stringify(last.slice(0, 12))}…)`,
    async () => {
      last = await semanticTokens(uri);
      return accept(last) ? last : undefined;
    },
  );
}

/** The token that starts at `line`:`character`, if any. */
export const tokenAt = (tokens: readonly DecodedToken[], line: number, character: number): DecodedToken | undefined =>
  tokens.find((t) => t.line === line && t.character === character);

/** An inlay hint's label as one string. */
export const hintLabel = (hint: vscode.InlayHint): string =>
  typeof hint.label === 'string' ? hint.label : hint.label.map((part) => part.value).join('');

/** The inlay hints of the whole of `doc`, as `vscode.executeInlayHintProvider` returns them. */
export async function inlayHints(doc: vscode.TextDocument): Promise<vscode.InlayHint[]> {
  const whole = new vscode.Range(0, 0, doc.lineCount, 0);
  return vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, whole);
}

/** The labels of the completion items at `pos`. */
export async function completionLabels(uri: vscode.Uri, pos: vscode.Position): Promise<string[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, pos);
  return list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
}

// -------------------------------------------------------------------------------------------
// M3: evaluation
// -------------------------------------------------------------------------------------------

/**
 * Selects `range` in `editor` and runs **Evaluate Selection**, then returns the outcome it
 * recorded (`TestApi.evaluations`: what the user was shown, which VS Code's API does not expose —
 * neither the decoration after the line nor the notification).
 */
export async function evaluateSelection(api: TestApi, editor: vscode.TextEditor, range: vscode.Range): Promise<EvaluationOutcome> {
  const before = api.evaluations.length;
  editor.selection = new vscode.Selection(range.start, range.end);
  await vscode.commands.executeCommand('idris2.evaluateSelection');
  return waitFor(`the evaluation of ${JSON.stringify(editor.document.getText(range))} to be shown`, () => api.evaluations[before]);
}

// -------------------------------------------------------------------------------------------
// M4: interactive editing and holes
// -------------------------------------------------------------------------------------------

/**
 * Runs the editing command `command` — with `args`, as a code action passes them, or none, as a
 * key or the Command Palette does — and returns the outcome it recorded (`TestApi.editing.outcomes`:
 * what the user was shown, which VS Code's API does not expose). While it runs, `interact` is called
 * every 50 ms (to answer a QuickPick; a no-op while none is open), so that a command waiting for
 * the user can finish.
 */
export async function runEditing(
  api: TestApi,
  command: EditingCommandId,
  args: readonly unknown[] = [],
  interact?: () => Thenable<unknown>,
): Promise<EditingOutcome> {
  const before = api.editing.outcomes.length;
  let failure: unknown;
  // Not awaited: a command that shows a QuickPick settles only once it is answered.
  vscode.commands.executeCommand(command, ...args).then(undefined, (e: unknown) => (failure = e));
  return waitForAsync(`${command} to record its outcome`, async () => {
    if (failure !== undefined) {
      assert.fail(`${command} rejected: ${String(failure)}`);
    }
    const outcome = api.editing.outcomes[before];
    if (outcome === undefined && interact !== undefined) {
      await interact();
    }
    return outcome;
  });
}

/** Accepts the selected (first) item of the QuickPick or input box that is open; a no-op when none is. */
export const acceptQuickPick = (): Thenable<unknown> => vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

/** Closes the QuickPick or input box that is open (as Escape does); a no-op when none is. */
export const closeQuickPick = (): Thenable<unknown> => vscode.commands.executeCommand('workbench.action.closeQuickOpen');

/**
 * Replaces `object[key]` with `value` until `restore()` is called. For the few dialogs no command
 * can answer: VS Code's `type` command types only into a focused code editor [src: its workbench
 * bundle, `EditorHandlerCommand`], never into an input box, and a notification's buttons have no
 * command. The test files and the extension share one `vscode` API object: the extension host
 * gives one per extension, found by the path of the module that requires it [src: the extension
 * host bundle of VS Code 1.139.1, the `vscode` module's `load`], and both lie in this checkout.
 */
function stub<T extends object, K extends keyof T>(object: T, key: K, value: T[K]): () => void {
  const original = object[key];
  object[key] = value;
  assert.strictEqual(object[key], value, `could not replace ${String(key)}`);
  return () => {
    object[key] = original;
  };
}

/** What a stubbed dialog was asked, and how to put the real one back. */
export interface StubbedDialog {
  /** The prompts (input box) or messages (notifications) in order. */
  readonly asked: string[];
  restore(): void;
}

/** Answers every `window.showInputBox` with `value` (`undefined`: the user pressed Escape) until restored. */
export function answerInputBox(value: string | undefined): StubbedDialog {
  const asked: string[] = [];
  const restore = stub(vscode.window, 'showInputBox', (options?: vscode.InputBoxOptions) => {
    asked.push(options?.prompt ?? '');
    return Promise.resolve(value);
  });
  return { asked, restore };
}

type MessageArg = string | vscode.MessageItem | vscode.MessageOptions;

/**
 * Answers every `window.show{Information,Warning,Error}Message` until restored: `choose` gets the
 * message and the buttons' titles and returns the title to click, or `undefined` to dismiss it.
 */
export function answerMessages(choose: (message: string, titles: readonly string[]) => string | undefined): StubbedDialog {
  const asked: string[] = [];
  const answer = (message: string, ...rest: MessageArg[]): Promise<string | vscode.MessageItem | undefined> => {
    asked.push(message);
    const items = rest.filter((r): r is string | vscode.MessageItem => typeof r === 'string' || 'title' in r);
    const title = choose(message, items.map((i) => (typeof i === 'string' ? i : i.title)));
    return Promise.resolve(items.find((i) => (typeof i === 'string' ? i : i.title) === title));
  };
  const restores = (['showInformationMessage', 'showWarningMessage', 'showErrorMessage'] as const).map((key) =>
    stub(vscode.window, key, answer as (typeof vscode.window)[typeof key]),
  );
  return { asked, restore: () => restores.forEach((r) => r()) };
}

/** The code actions VS Code's light bulb gets at `range` of `uri` (every provider's), of `kind` if given. */
export async function codeActionsAt(uri: vscode.Uri, range: vscode.Range, kind?: string): Promise<vscode.CodeAction[]> {
  const found = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>('vscode.executeCodeActionProvider', uri, range, kind);
  // A bare Command has a string `command`; a CodeAction has an optional Command object there.
  return found.filter((a): a is vscode.CodeAction => typeof a.command !== 'string');
}

/** The one code action of `kind` at `range` whose command is `command`; fails if there is none or more than one. */
export async function codeActionFor(uri: vscode.Uri, range: vscode.Range, kind: string, command: EditingCommandId): Promise<vscode.Command> {
  const actions = await codeActionsAt(uri, range, kind);
  const matching = actions.filter((a) => a.kind?.value === kind && a.command?.command === command);
  assert.strictEqual(matching.length, 1, `code actions of kind ${kind} at ${JSON.stringify(range)}: ${JSON.stringify(actions.map((a) => [a.title, a.kind?.value, a.command?.command]))}`);
  const [action] = matching;
  assert.ok(action.command);
  // Our actions carry a command and never an edit: the edit is computed when it is chosen.
  assert.strictEqual(action.edit, undefined, `${action.title} carries an edit`);
  return action.command;
}
