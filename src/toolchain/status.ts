/**
 * The toolchain status surface (`toolchain/status.ts` in docs/ARCHITECTURE.md §2; ROADMAP M1, M2):
 * one `LanguageStatusItem` on `idrisDocumentSelector()` whose text comes from the toolchain
 * snapshot, the backend registry and, since M2, the active document's check
 * (`Idris 2 0.8.0 · IDE mode · 2 errors`; ARCHITECTURE §6.1: `checking… / ✓ / n errors / stale /
 * stopped`), the status QuickPick (**Idris 2: Show Commands…**) and the `idris2.packFound` context
 * key. Each change of the item's text or severity is written to the "Idris 2" output channel
 * (`Status: …`). The item's properties are written only when something it shows changed (third
 * review of M3): the registry and the checks report every request of a `check` session twice
 * (`ready` → `busy` → `ready`), and each write of a property of a VS Code 1.139.1 language status
 * item, equal or not, schedules a message that sends the whole item to the window (the writes of
 * one turn of the event loop share one; `createLanguageStatusItem` in the extension host bundle
 * [src]), so a round of inlay hints (about 140 requests) sent about 280 unchanged items [reasoned
 * from that code, not counted].
 *
 * When the compiler may not start in the active document's directory (the user did not allow
 * it, ROADMAP §9 2026-09-27), the item says so (`not allowed here`) and its link is **Allow…**,
 * which asks again; while the question is open — for a check, or because **Allow…** asked again
 * — the item reads `checking…` and its link is **Allow…** too, which shows it again (a
 * notification with buttons goes to the notification centre after its timeout). A file the
 * compiler found already built, whose warnings this window does not know (F7), reads `up to date`
 * rather than `✓`.
 *
 * **The detail is text, not links.** VS Code 1.139.1 parses a language status item's `detail`
 * for `[label](command:…)` links in its hover (`_renderTextPlus` → `parseLinkedText`, links opened
 * with commands allowed), and a pinned item's status-bar tooltip is `new MarkdownString(detail,
 * { isTrusted: true })` unless the item's command has a tooltip [src: its workbench bundle]. The
 * detail quotes paths and compiler output, which anybody who can name a folder controls, so it
 * goes through `plainText` (`core/notificationText.ts`), and the command carries the detail as
 * its tooltip, a plain string, so that no trusted markdown is made of it. (A side effect: the
 * language status hover shows the command's tooltip as its link's hover title, so the link
 * **Show Commands…** or **Allow…** repeats the detail shown beside it when hovered [src: the
 * hover's `Link(…, { label: command.title, title: command.tooltip })`]. VS Code offers no other
 * tooltip for a pinned item, so this is accepted.) The folders and package files in the detail are
 * quoted with `shownPath`, like the question's, and a consent text (a question open, a refusal, a
 * revocation) comes first, so that no path chosen by somebody else comes before it.
 *
 * The QuickPick lists exactly the entries of the **Idris 2** editor-title submenu
 * (`contributes.menus["idris2.editorTitle"]` in package.json), in the order VS Code shows that
 * menu and under the same `when` conditions, read from the manifest at run time so that the two
 * cannot drift apart.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`, so the
 * pure parts (`describeStatus`, `statusMenuEntries`) are unit-tested on plain Node.
 */
import type * as vscode from 'vscode';
import type { BackendLabel, BackendRegistry } from '../backend/registry';
import { DisposableStore, type IDisposable } from '../core/disposable';
import type { Log } from '../core/log';
import { plainText, shownPath } from '../core/notificationText';
import type { WorkspaceTrust } from '../core/trust';
import { ALLOW_FOLDER_COMMAND } from '../features/consent/gate';
import type { CheckStatus, CheckStatusSource } from '../features/diagnostics/checks';
import { idrisDocumentSelector, isIdrisDocument } from '../project/literate';
import type { Classification, ProjectIndex } from '../project/types';
import type { ToolchainService, ToolchainSnapshot } from './types';

export const STATUS_MENU_COMMAND = 'idris2.showStatusMenu';
/** The editor-title submenu whose entries the status QuickPick repeats. */
export const EDITOR_TITLE_SUBMENU = 'idris2.editorTitle';
/** Context key: pack's executable was found by the last scan (gates the two pack commands). */
export const PACK_FOUND_CONTEXT_KEY = 'idris2.packFound';
const STATUS_ITEM_ID = 'idris2.toolchain';

// -------------------------------------------------------------------------------------------
// What the item says
// -------------------------------------------------------------------------------------------

export interface StatusInput {
  /** `WorkspaceTrust.isTrusted` now. */
  readonly trusted: boolean;
  readonly scanning: boolean;
  readonly snapshot: ToolchainSnapshot | undefined;
  /** The registry's label for the active document's root. */
  readonly label: BackendLabel;
  /** The active Idris document's root; `undefined` when it has none or it is not known yet. */
  readonly root: Classification | undefined;
  /** The active document's check; `undefined` when it is not checked at all (e.g. untitled). */
  readonly check?: CheckStatus;
}

export type StatusSeverity = 'information' | 'warning' | 'error';

export interface StatusView {
  readonly text: string;
  readonly detail: string;
  readonly severity: StatusSeverity;
  readonly busy: boolean;
  /** The title of the item's command (shown as its link). */
  readonly commandTitle: string;
  /** Set when the link is **Allow…**: the directory to ask about again (`ALLOW_FOLDER_COMMAND`). */
  readonly allow?: string;
}

const SHOW_COMMANDS = 'Show Commands…';
const SETUP = 'Setup…';
const ALLOW = 'Allow…';

const SEVERITY_ORDER: readonly StatusSeverity[] = ['information', 'warning', 'error'];

function worse(a: StatusSeverity, b: StatusSeverity): StatusSeverity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** What a check adds to the item: a suffix of the text, a part of the detail, and so on. */
interface CheckView {
  readonly suffix?: string;
  readonly detail?: string;
  readonly severity: StatusSeverity;
  readonly busy?: boolean;
  readonly allow?: string;
  /** A text about the consent gate (a question open, a refusal, a revocation): it comes first in the detail. */
  readonly consent?: boolean;
}

function checkView(check: CheckStatus | undefined): CheckView {
  switch (check?.kind) {
    case undefined:
    case 'notChecked':
      return { severity: 'information' };
    case 'checking':
      // While the consent question waits (its notification may have gone to the notification
      // centre), the link shows it again (`features/consent/gate.ts`).
      return check.waitingFor === undefined
        ? { suffix: 'checking…', detail: 'checking the saved file', severity: 'information', busy: true }
        : {
            suffix: 'checking…',
            detail: `waiting for your permission to start the compiler in ${shownPath(check.waitingFor)}`,
            severity: 'information',
            busy: true,
            allow: check.waitingFor,
            consent: true,
          };
    case 'checked': {
      const found =
        check.errors + check.warnings === 0
          ? 'no errors or warnings'
          : [check.errors > 0 ? count(check.errors, 'error') : '', check.warnings > 0 ? count(check.warnings, 'warning') : '']
              .filter((part) => part !== '')
              .join(', ');
      // Stale: what to do depends on why (M2 verification of the third review: a file changed on
      // disk is saved already, and with the manual trigger a save checks nothing).
      const staleness = check.staleness ?? { unsaved: true, manual: false };
      const then = staleness.unsaved
        ? staleness.manual
          ? 'save, then run Check File to check the changes'
          : 'save to check the changes'
        : 'run Check File to check it';
      if (!check.known) {
        // A fresh TTC: the compiler rebuilt nothing and repeated no warning (F7); no error is
        // possible, since a file with errors gets no TTC.
        const detail =
          'checked: no errors; the compiler found the file already built and did not repeat its warnings, if it has any ' +
          '(they are shown when it is built again)';
        return check.stale
          ? { suffix: 'stale', detail: `${detail}; ${staleness.unsaved ? 'the file has unsaved changes' : 'the file changed since'}; ${then}`, severity: 'information' }
          : { suffix: 'up to date', detail, severity: 'information' };
      }
      if (check.stale) {
        const what = staleness.unsaved ? `the saved file had ${found}` : `the file changed after it was checked, which found ${found}`;
        return { suffix: 'stale', detail: `${what}; ${then}`, severity: 'information' };
      }
      const suffix = check.errors > 0 ? count(check.errors, 'error') : check.warnings > 0 ? count(check.warnings, 'warning') : '✓';
      return { suffix, detail: `checked: ${found}`, severity: 'information' };
    }
    case 'packageError':
      return {
        suffix: check.stale ? 'stale' : 'package file error',
        detail: `the compiler could not read ${shownPath(check.ipkg)}: ${check.message.split('\n', 1)[0]}`,
        severity: 'warning',
      };
    case 'loadFailed':
      return { suffix: 'failed', detail: `checking failed: ${check.reason}`, severity: 'warning' };
    case 'backendFailed':
      return { suffix: 'failed', detail: `the compiler was given up: ${check.reason}; Restart Backend to try again`, severity: 'error' };
    case 'stopped':
      return check.revokedDir === undefined
        ? { suffix: 'stopped', detail: 'the compiler is stopped; the next check starts it again', severity: 'information' }
        : {
            suffix: 'stopped',
            detail: `the compiler was stopped because the permission for ${shownPath(check.revokedDir)} was revoked; the next check asks again`,
            severity: 'information',
            consent: true,
          };
    case 'notAllowed':
      return {
        suffix: 'not allowed here',
        detail:
          `the compiler may not start in ${shownPath(check.dir)}, which is outside the trusted workspace folders ` +
          `(${check.reason === 'denied' ? "you chose Don't Allow" : 'the question was closed'}); highlighting only`,
        severity: 'warning',
        allow: check.dir,
        consent: true,
      };
  }
}

function rootDetail(root: Classification | undefined): { text: string; problem: boolean } | undefined {
  if (root === undefined) {
    return undefined;
  }
  if (root.kind === 'loose') {
    return { text: `loose file (no .ipkg above ${shownPath(root.dir)})`, problem: false };
  }
  const parts = [`project ${shownPath(root.ipkgPath)}${root.insideWorkspace ? '' : ' (outside the workspace folders: read without the compiler)'}`];
  let problem = false;
  if (root.model.status === 'error') {
    parts.push(`which could not be read: ${root.model.error.message.split('\n')[0]}`);
    problem = true;
  }
  if (root.otherIpkgs.length > 0) {
    // F10: the compiler takes the first .ipkg its directory listing yields.
    parts.push(`other .ipkg files in that directory: ${root.otherIpkgs.map(shownPath).join(', ')} — the compiler uses only one`);
    problem = true;
  }
  return { text: parts.join('; '), problem };
}

/** The text, detail and severity of the status item for one state. */
export function describeStatus(input: StatusInput): StatusView {
  const busy = input.scanning;
  if (!input.trusted) {
    return {
      text: 'Restricted Mode — toolchain detection disabled',
      detail: 'No program is run in an untrusted workspace: idris2 is neither detected nor started to check files. Trust the workspace to use it.',
      severity: 'information',
      busy,
      commandTitle: SHOW_COMMANDS,
    };
  }
  const snapshot = input.snapshot;
  if (snapshot === undefined || !snapshot.trusted) {
    // The first scan, or the rescan that follows a grant of trust, has not finished yet.
    return { text: 'Idris 2', detail: 'Looking for idris2…', severity: 'information', busy: true, commandTitle: SHOW_COMMANDS };
  }
  const idris2 = snapshot.idris2;
  if (idris2.status === 'missing') {
    return { text: 'idris2 not found — Setup…', detail: idris2.reason, severity: 'warning', busy, commandTitle: SETUP };
  }
  if (idris2.status === 'failed') {
    return {
      text: 'idris2 not working — Setup…',
      detail: `${idris2.location.path}: ${idris2.reason}`,
      severity: 'warning',
      busy,
      commandTitle: SETUP,
    };
  }
  // `located` (found, not run) belongs to untrusted scans, handled above; it has no version.
  const version = idris2.status === 'probed' ? ` ${idris2.info.version?.text ?? '(unrecognised version)'}` : '';
  const details = [`idris2 ${idris2.location.path}`];
  const root = rootDetail(input.root);
  if (root !== undefined) {
    details.push(root.text);
  }
  if (snapshot.verdict?.kind === 'likelyMismatch') {
    details.push(`idris2-lsp: ${snapshot.verdict.reason}`);
  }
  // A check is shown only for a backend that checks (not for `syntax only`).
  const check = checkView(input.label === 'syntax only' ? undefined : input.check);
  if (check.detail !== undefined) {
    // What the consent gate says comes first, before the paths above, which anybody who can name a
    // folder chooses (*M2 second verification of the third review*: a folder named
    // `…; checked: no errors; …` came before the consent sentence).
    if (check.consent === true) {
      details.unshift(check.detail);
    } else {
      details.push(check.detail);
    }
  }
  return {
    text: `Idris 2${version} · ${input.label}${check.suffix === undefined ? '' : ` · ${check.suffix}`}`,
    detail: details.join('; '),
    severity: worse(root?.problem === true ? 'warning' : 'information', check.severity),
    busy: busy || check.busy === true,
    commandTitle: check.allow === undefined ? SHOW_COMMANDS : ALLOW,
    ...(check.allow === undefined ? {} : { allow: check.allow }),
  };
}

// -------------------------------------------------------------------------------------------
// The QuickPick entries, from the manifest
// -------------------------------------------------------------------------------------------

/** The context keys a submenu `when` clause may test; M1 sets only this one besides the selector key. */
export interface MenuContext {
  readonly packFound: boolean;
}

export interface StatusMenuEntry {
  readonly command: string;
  readonly title: string;
  /** The menu group (`1_toolchain`, …; `''` for none); the QuickPick puts a separator between groups. */
  readonly group: string;
}

interface ManifestMenuEntry {
  readonly command?: unknown;
  readonly group?: unknown;
  readonly when?: unknown;
}

/**
 * Evaluates the `when` clauses the submenu uses. Anything else throws, so that a new clause in
 * package.json fails the unit test on the real manifest instead of being shown unconditionally.
 */
function whenHolds(when: unknown, context: MenuContext): boolean {
  if (when === undefined) {
    return true;
  }
  if (when === PACK_FOUND_CONTEXT_KEY) {
    return context.packFound;
  }
  if (when === `!${PACK_FOUND_CONTEXT_KEY}`) {
    return !context.packFound;
  }
  throw new Error(`the status menu cannot evaluate the when clause ${JSON.stringify(when)}`);
}

/**
 * `"1_toolchain@2"` → group `1_toolchain`, order 2, as VS Code reads a contributed menu item's
 * `group@order`: split at the last `@` when it is not the first character, the order being
 * `Number(…) || undefined`, which the menu compares as 0 [src: VS Code 1.139.1 workbench bundle,
 * the `menus` extension point]. A missing group is `''`.
 */
function splitGroup(value: unknown): { group: string; order: number } {
  const text = typeof value === 'string' ? value : '';
  const at = text.lastIndexOf('@');
  if (at <= 0) {
    return { group: text, order: 0 };
  }
  return { group: text.slice(0, at), order: Number(text.slice(at + 1)) || 0 };
}

/**
 * VS Code's `MenuInfo.compareMenuItems` [src: VS Code 1.139.1 workbench bundle]: entries with a
 * group before entries without one, `navigation` before every other group, other groups by
 * `localeCompare`; within a group by order (none counts as 0), then by title.
 */
function compareMenuEntries(
  a: { readonly group: string; readonly order: number; readonly title: string },
  b: { readonly group: string; readonly order: number; readonly title: string },
): number {
  if (a.group !== b.group) {
    if (a.group === '') {
      return 1;
    }
    if (b.group === '') {
      return -1;
    }
    if (a.group === 'navigation') {
      return -1;
    }
    if (b.group === 'navigation') {
      return 1;
    }
    const byGroup = a.group.localeCompare(b.group);
    if (byGroup !== 0) {
      return byGroup;
    }
  }
  return a.order < b.order ? -1 : a.order > b.order ? 1 : a.title.localeCompare(b.title);
}

/**
 * The commands of the editor-title submenu that are visible in `context`, in the order VS
 * Code's menu service shows them (`compareMenuEntries`).
 */
export function statusMenuEntries(manifest: unknown, context: MenuContext): StatusMenuEntry[] {
  const contributes = (manifest as { contributes?: { menus?: Record<string, unknown>; commands?: unknown } })
    .contributes;
  const entries = contributes?.menus?.[EDITOR_TITLE_SUBMENU];
  const commands = contributes?.commands;
  if (!Array.isArray(entries) || !Array.isArray(commands)) {
    throw new Error(`package.json has no menus["${EDITOR_TITLE_SUBMENU}"] or commands`);
  }
  const titles = new Map<string, string>();
  for (const c of commands as { command?: unknown; title?: unknown }[]) {
    if (typeof c.command === 'string' && typeof c.title === 'string') {
      titles.set(c.command, c.title);
    }
  }
  const visible = (entries as ManifestMenuEntry[])
    .filter((entry) => typeof entry.command === 'string' && whenHolds(entry.when, context))
    .map((entry) => {
      const command = entry.command as string;
      const title = titles.get(command);
      if (title === undefined) {
        throw new Error(`the submenu names ${command}, which package.json does not contribute`);
      }
      return { command, title, ...splitGroup(entry.group) };
    });
  visible.sort(compareMenuEntries);
  return visible.map(({ command, title, group }) => ({ command, title, group }));
}

// -------------------------------------------------------------------------------------------
// The VS Code side
// -------------------------------------------------------------------------------------------

export type StatusApi = Pick<
  typeof vscode,
  'languages' | 'window' | 'workspace' | 'commands' | 'LanguageStatusSeverity' | 'QuickPickItemKind'
>;

export interface StatusDeps {
  readonly toolchain: ToolchainService;
  readonly projects: Pick<ProjectIndex, 'classify' | 'onDidChange'>;
  readonly registry: BackendRegistry;
  /** The active document's check (M2). */
  readonly checks: CheckStatusSource;
  readonly trust: WorkspaceTrust;
  /** `context.extension.packageJSON`. */
  readonly manifest: unknown;
  readonly log: Log;
}

export interface ToolchainStatus extends IDisposable {
  /** The language status item (read by the integration tests). */
  readonly item: vscode.LanguageStatusItem;
  /** What the status QuickPick lists now. */
  menuEntries(): StatusMenuEntry[];
}

/**
 * Creates the status item, keeps it and `idris2.packFound` up to date, and registers
 * **Idris 2: Show Commands…**. Disposing removes both and resets `idris2.packFound` to false if
 * it was set: context keys outlive the extension otherwise (see `trackIsIdrisDocumentContext`).
 */
export function registerToolchainStatus(api: StatusApi, deps: StatusDeps): ToolchainStatus {
  const store = new DisposableStore();
  const item = store.add(api.languages.createLanguageStatusItem(STATUS_ITEM_ID, idrisDocumentSelector()));
  item.name = 'Idris 2';

  let root: Classification | undefined;
  /** The file whose root `root` is (or is being classified); see `followActiveDocument`. */
  let rootFor: string | undefined;
  /** Numbers the classification requests, so that a late answer for an older one is dropped. */
  let request = 0;
  /** The active Idris document, while it is the one the item describes. */
  let activeDoc: vscode.TextDocument | undefined;
  let packFound = false;
  const setPackFound = (value: boolean): void => {
    if (value !== packFound) {
      packFound = value;
      void api.commands.executeCommand('setContext', PACK_FOUND_CONTEXT_KEY, value);
    }
  };

  // The last text and severity written to the log: the item is not readable through VS Code's
  // API, so the "Idris 2" output channel records each change of what it says.
  let logged: string | undefined;
  // What the item's properties were last set to (module comment: written only when it changed).
  let written: string | undefined;
  const render = (): void => {
    const snapshot = deps.toolchain.current;
    const view = describeStatus({
      trusted: deps.trust.isTrusted,
      scanning: deps.toolchain.scanning,
      snapshot,
      // A file whose root is still being classified gets the provider's label, not `syntax only`.
      label: root === undefined && rootFor !== undefined ? deps.registry.pendingLabel() : deps.registry.labelFor(root),
      root,
      check: activeDoc === undefined ? undefined : deps.checks.statusOf(activeDoc, root),
    });
    const shown = `Status: ${view.text}${view.severity === 'information' ? '' : ` (${view.severity})`}`;
    if (shown !== logged) {
      logged = shown;
      deps.log.info(shown);
    }
    setPackFound(snapshot?.pack.status === 'found');
    // Text, not links, also in a pinned item's tooltip (module comment).
    const detail = plainText(view.detail);
    const key = JSON.stringify([view.text, detail, view.busy, view.severity, view.commandTitle, view.allow ?? null]);
    if (key === written) {
      return;
    }
    written = key;
    item.text = view.text;
    item.detail = detail;
    item.busy = view.busy;
    item.severity =
      view.severity === 'error'
        ? api.LanguageStatusSeverity.Error
        : view.severity === 'warning'
          ? api.LanguageStatusSeverity.Warning
          : api.LanguageStatusSeverity.Information;
    item.command =
      view.allow === undefined
        ? { command: STATUS_MENU_COMMAND, title: view.commandTitle, tooltip: detail }
        : { command: ALLOW_FOLDER_COMMAND, title: view.commandTitle, tooltip: detail, arguments: [view.allow] };
  };

  // The root of the active Idris document. Classification is asynchronous (it may read the
  // file system and run the compiler, whose run can wait behind a rescan's probes); `request`
  // drops answers that arrive after a newer one was asked for. When the active document
  // changes, the previous document's root is cleared at once, so that the item never shows it
  // (or its warning) for the new one; a new answer for the same document (after a project
  // change) replaces the old one when it arrives.
  const followActiveDocument = (): void => {
    const doc = api.window.activeTextEditor?.document;
    if (doc === undefined || !isIdrisDocument(doc)) {
      return; // the item is hidden for other editors; keep what it last said
    }
    const current = ++request;
    activeDoc = doc;
    if (doc.uri.scheme !== 'file') {
      root = undefined;
      rootFor = undefined;
      render();
      return;
    }
    const file = doc.uri.fsPath;
    if (file !== rootFor) {
      root = undefined;
      rootFor = file;
      render();
    }
    deps.projects.classify(file).then(
      (classification) => {
        if (current === request && !store.isDisposed) {
          root = classification;
          render();
        }
      },
      (error: unknown) => deps.log.warn(`Could not classify ${file}: ${String(error)}`),
    );
  };

  store.add(deps.toolchain.onDidChange(render));
  store.add(deps.registry.onDidChange(render));
  store.add(deps.checks.onDidChange(render));
  store.add(deps.trust.onDidGrant(render));
  store.add(deps.projects.onDidChange(followActiveDocument));
  store.add(api.window.onDidChangeActiveTextEditor(followActiveDocument));
  // A change of the active document's language mode (e.g. to Idris 2) is reported as the
  // document closing and opening again, without an active-editor event (VS Code 1.139.1:
  // `$acceptModelLanguageChanged` fires the remove and add events of the document only [src]),
  // as `trackIsIdrisDocumentContext` also knows.
  store.add(
    api.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.toString() === api.window.activeTextEditor?.document.uri.toString()) {
        followActiveDocument();
      }
    }),
  );

  const menuEntries = (): StatusMenuEntry[] => statusMenuEntries(deps.manifest, { packFound });
  store.add(
    api.commands.registerCommand(STATUS_MENU_COMMAND, async () => {
      const items: (vscode.QuickPickItem & { command?: string })[] = [];
      let group: string | undefined;
      for (const entry of menuEntries()) {
        if (group !== undefined && entry.group !== group) {
          items.push({ label: '', kind: api.QuickPickItemKind.Separator });
        }
        group = entry.group;
        items.push({ label: entry.title, command: entry.command });
      }
      const picked = await api.window.showQuickPick(items, { title: 'Idris 2', placeHolder: item.text });
      if (picked?.command !== undefined) {
        await api.commands.executeCommand(picked.command);
      }
    }),
  );
  store.add({ dispose: () => setPackFound(false) });

  render();
  followActiveDocument();
  return { item, menuEntries, dispose: () => store.dispose() };
}
