/**
 * The migration of bamboo's settings (ROADMAP M5, F36; ARCHITECTURE §11): when settings of the
 * extension `bamboo.idris2-lsp` (section `idris2-lsp`) are set and the matching settings of this
 * extension are not, a notification offers to copy them (**Copy Settings**, **Not Now**, **Don't
 * Ask Again**).
 *
 * **The key map** (`BAMBOO_KEY_MAP`), checked against bamboo's `package.json` 0.7.2 and
 * `src/extension.ts` at `1e93392` (the head of `bamboo/idris2-lsp-vscode`, fetched 2026-10-01
 * [src]): `loglevel` → `idris2.lsp.logSeverity` (bamboo contributes `loglevel` but its client sends
 * `extensionConfig.get("logSeverity")`, so the contributed key never reached the server, F36; the
 * values are the same five, lower case); `logFile`, `longActionTimeout`, `maxCodeActionResults`,
 * `showImplicits`, `showMachineNames`, `fullNamespace`, `briefCompletions` → `idris2.lsp.<same>`;
 * `path` → `idris2.toolchain.lspPath`; `trace.server` → `idris2.lsp.trace.server`. What is not
 * copied, and why (`convert`):
 * - `logFile` `stderr` (bamboo's default, which its client also sends when the setting is empty) and
 *   any path that is neither absolute nor starts with `~`: the server ignores a path that is not
 *   absolute and keeps its standard error (`changeLogFile`, `Server/Log.idr` 106–117 [src]), which is
 *   this extension's default (an empty `idris2.lsp.logFile`);
 * - `trace.server` `off`: this extension's setting has no `off` (the client writes its trace only
 *   while the channel's log level is Trace, `backend/lsp/types.ts` `LSP_CLIENT_ID`);
 * - a number below 1 or not finite for the two counts (`idris2.lsp.*` minimum 1; a fraction is
 *   rounded down, the schema says integer), and a value of the wrong type.
 * A value is copied to the scope it is set in (user, workspace, or one workspace folder). VS Code
 * writes a workspace folder's value only of a setting of scope `resource`, `language-overridable`
 * or `machine-overridable` (the configuration-editing check, scopes 5–7 [src: VS Code 1.140.0
 * workbench bundle]); `idris2.lsp.*` but `logFile` are `window`-scoped, so a folder's value of those
 * is not copied (the result says so). bamboo's settings are left as they are.
 *
 * **When.** At activation and whenever an `idris2-lsp.*` setting changes, in a trusted workspace only
 * (a workspace's values would be copied into the workspace's own settings, and in Restricted Mode
 * VS Code ignores the workspace values of `idris2.toolchain.lspPath` and `idris2.lsp.logFile`); once
 * per window for each set of values to copy; never again after **Don't Ask Again** (the global
 * state). Nothing copies without that question: no command does it unasked, so no command link and
 * no other extension can write these settings through this extension.
 *
 * Only type imports from `vscode`: the plan (`planMigration`) is unit-tested on plain Node.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import { plainText } from '../../core/notificationText';
import type { WorkspaceTrust } from '../../core/trust';
import type { RoutingNotice } from './types';

/** bamboo's configuration section. */
export const BAMBOO_SECTION = 'idris2-lsp';
/** The global-state key of **Don't Ask Again**. */
export const MIGRATION_DECLINED_KEY = 'idris2.bambooMigrationDeclined';

/** Where a value is set: the user's settings, the workspace's, or a workspace folder's. */
export type MigrationTarget = 'global' | 'workspace' | 'workspaceFolder';

export type Converted = { readonly value: unknown } | { readonly skip: string };

export interface BambooKey {
  /** bamboo's key, under `idris2-lsp.`. */
  readonly from: string;
  /** This extension's full key. */
  readonly to: string;
  /** Whether VS Code writes `to` in a workspace folder's settings (module comment). */
  readonly folderScoped: boolean;
  convert(value: unknown): Converted;
}

const LOG_SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical'];

function asBoolean(value: unknown): Converted {
  return typeof value === 'boolean' ? { value } : { skip: 'not true or false' };
}

function asCount(value: unknown): Converted {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? { value: Math.floor(value) } : { skip: 'not a number of at least 1' };
}

/** The key map of the module comment. */
export const BAMBOO_KEY_MAP: readonly BambooKey[] = [
  {
    from: 'loglevel',
    to: 'idris2.lsp.logSeverity',
    folderScoped: false,
    convert: (value) => {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
      return text !== undefined && LOG_SEVERITIES.includes(text) ? { value: text } : { skip: `not one of ${LOG_SEVERITIES.join(', ')}` };
    },
  },
  {
    from: 'logFile',
    to: 'idris2.lsp.logFile',
    folderScoped: true,
    convert: (value) => {
      if (typeof value !== 'string') {
        return { skip: 'not a text' };
      }
      const text = value.trim();
      if (text === '' || text === 'stderr') {
        return { skip: 'standard error, the default here' };
      }
      return path.posix.isAbsolute(text) || path.win32.isAbsolute(text) || text.startsWith('~')
        ? { value: text }
        : { skip: 'not an absolute path, which idris2-lsp ignores' };
    },
  },
  { from: 'longActionTimeout', to: 'idris2.lsp.longActionTimeout', folderScoped: false, convert: asCount },
  { from: 'maxCodeActionResults', to: 'idris2.lsp.maxCodeActionResults', folderScoped: false, convert: asCount },
  { from: 'showImplicits', to: 'idris2.lsp.showImplicits', folderScoped: false, convert: asBoolean },
  { from: 'showMachineNames', to: 'idris2.lsp.showMachineNames', folderScoped: false, convert: asBoolean },
  { from: 'fullNamespace', to: 'idris2.lsp.fullNamespace', folderScoped: false, convert: asBoolean },
  { from: 'briefCompletions', to: 'idris2.lsp.briefCompletions', folderScoped: false, convert: asBoolean },
  {
    from: 'path',
    to: 'idris2.toolchain.lspPath',
    folderScoped: true,
    convert: (value) => (typeof value === 'string' && value.trim() !== '' ? { value: value.trim() } : { skip: 'not a path' }),
  },
  {
    from: 'trace.server',
    to: 'idris2.lsp.trace.server',
    folderScoped: false,
    convert: (value) =>
      value === 'messages' || value === 'verbose'
        ? { value }
        : value === 'off'
          ? { skip: 'this extension writes the trace only while the channel\'s log level is Trace, so it has no "off"' }
          : { skip: 'not messages or verbose' },
  },
];

/** One of bamboo's values as it is set, and the value of its target in the same place. */
export interface FoundValue {
  readonly from: string;
  readonly target: MigrationTarget;
  /** The workspace folder's path, for `workspaceFolder`. */
  readonly folder?: string;
  readonly value: unknown;
  /** The value `to` has in the same place; `undefined` when it has none there. */
  readonly existing: unknown;
}

export interface Copy {
  readonly from: string;
  readonly to: string;
  readonly target: MigrationTarget;
  readonly folder?: string;
  readonly value: unknown;
}

export interface Skipped {
  readonly from: string;
  readonly target: MigrationTarget;
  readonly folder?: string;
  readonly reason: string;
}

export interface MigrationPlan {
  readonly copies: readonly Copy[];
  /** bamboo's values that will not be copied, with why (a target already set is not listed). */
  readonly skipped: readonly Skipped[];
}

/** What to copy (module comment): a value set by the user, whose target is not set in the same place. */
export function planMigration(found: readonly FoundValue[]): MigrationPlan {
  const copies: Copy[] = [];
  const skipped: Skipped[] = [];
  for (const entry of found) {
    const key = BAMBOO_KEY_MAP.find((k) => k.from === entry.from);
    if (key === undefined || entry.value === undefined || entry.existing !== undefined) {
      continue;
    }
    const where = { target: entry.target, ...(entry.folder === undefined ? {} : { folder: entry.folder }) };
    if (entry.target === 'workspaceFolder' && !key.folderScoped) {
      skipped.push({ from: entry.from, ...where, reason: `${key.to} cannot be set for one workspace folder` });
      continue;
    }
    const converted = key.convert(entry.value);
    if ('skip' in converted) {
      skipped.push({ from: entry.from, ...where, reason: converted.skip });
    } else {
      copies.push({ from: entry.from, to: key.to, ...where, value: converted.value });
    }
  }
  return { copies, skipped };
}

/** `idris2-lsp.loglevel (workspace folder /w/a settings)`. */
function describe(where: { readonly target: MigrationTarget; readonly folder?: string }, key: string): string {
  const scope = where.target === 'global' ? 'user' : where.target === 'workspace' ? 'workspace' : `workspace folder ${where.folder ?? ''}`;
  return `${key} (${scope} settings)`;
}

// -------------------------------------------------------------------------------------------
// The VS Code side
// -------------------------------------------------------------------------------------------

export type MigrationApi = Pick<typeof vscode, 'window' | 'workspace' | 'ConfigurationTarget'>;

export interface MigrationDeps {
  readonly trust: WorkspaceTrust;
  /** `context.globalState`: **Don't Ask Again**. */
  readonly globalState: Pick<vscode.Memento, 'get' | 'update'>;
  readonly log: Log;
  /** Records each notification shown (the test API). */
  readonly notices: RoutingNotice[];
}

const COPY = 'Copy Settings';
const NOT_NOW = 'Not Now';
const NEVER = "Don't Ask Again";

/** bamboo's values as they are set, read through VS Code's `inspect`. */
function findValues(api: MigrationApi): FoundValue[] {
  const found: FoundValue[] = [];
  const ours = (key: string, folder?: vscode.Uri) => api.workspace.getConfiguration(undefined, folder).inspect(key);
  for (const key of BAMBOO_KEY_MAP) {
    const theirs = api.workspace.getConfiguration(BAMBOO_SECTION).inspect(key.from);
    const target = ours(key.to);
    if (theirs?.globalValue !== undefined) {
      found.push({ from: key.from, target: 'global', value: theirs.globalValue, existing: target?.globalValue });
    }
    if (theirs?.workspaceValue !== undefined) {
      found.push({ from: key.from, target: 'workspace', value: theirs.workspaceValue, existing: target?.workspaceValue });
    }
    for (const folder of api.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      const value = api.workspace.getConfiguration(BAMBOO_SECTION, folder.uri).inspect(key.from)?.workspaceFolderValue;
      if (value !== undefined) {
        found.push({
          from: key.from,
          target: 'workspaceFolder',
          folder: folder.uri.fsPath,
          value,
          existing: ours(key.to, folder.uri)?.workspaceFolderValue,
        });
      }
    }
  }
  return found;
}

/** Offers the copy (module comment, *When*). */
export function registerBambooMigration(api: MigrationApi, deps: MigrationDeps): IDisposable {
  const store = new DisposableStore();
  /** The plans offered in this window (the JSON of their copies). */
  const offered = new Set<string>();

  const copy = async (plan: MigrationPlan): Promise<void> => {
    const done: string[] = [];
    const failed: string[] = [];
    for (const c of plan.copies) {
      const folder = c.folder === undefined ? undefined : api.workspace.workspaceFolders?.find((f) => f.uri.fsPath === c.folder)?.uri;
      const target =
        c.target === 'global'
          ? api.ConfigurationTarget.Global
          : c.target === 'workspace'
            ? api.ConfigurationTarget.Workspace
            : api.ConfigurationTarget.WorkspaceFolder;
      try {
        if (c.target === 'workspaceFolder' && folder === undefined) {
          throw new Error('the workspace folder is gone');
        }
        await api.workspace.getConfiguration(undefined, folder).update(c.to, c.value, target);
        done.push(describe(c, `${BAMBOO_SECTION}.${c.from} → ${c.to}`));
      } catch (error) {
        failed.push(`${describe(c, c.to)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const notCopied = plan.skipped.map((s) => `${describe(s, `${BAMBOO_SECTION}.${s.from}`)}: ${s.reason}`);
    deps.log.info(`Copied the settings of idris2-lsp: ${done.join('; ') || 'none'}${failed.length > 0 ? `. Failed: ${failed.join('; ')}` : ''}${notCopied.length > 0 ? `. Not copied: ${notCopied.join('; ')}` : ''}`);
    const message =
      `Idris 2: copied ${done.length} of the idris2-lsp extension's settings` +
      (failed.length > 0 ? `; ${failed.length} could not be written (${failed.join('; ')})` : '') +
      (notCopied.length > 0 ? `; not copied: ${notCopied.join('; ')}` : '') +
      '.';
    deps.notices.push({ kind: 'migration', message, actions: [] });
    if (failed.length > 0) {
      await api.window.showWarningMessage(plainText(message));
    } else {
      await api.window.showInformationMessage(plainText(message));
    }
  };

  /** Looks for values to copy and offers them; resolves when the offer was answered or none was made. */
  const check = async (): Promise<void> => {
    if (!deps.trust.isTrusted || deps.globalState.get(MIGRATION_DECLINED_KEY) === true) {
      return;
    }
    const plan = planMigration(findValues(api));
    const key = JSON.stringify(plan.copies);
    if (plan.copies.length === 0 || offered.has(key)) {
      return;
    }
    offered.add(key);
    const keys = [...new Set(plan.copies.map((c) => `${BAMBOO_SECTION}.${c.from}`))].join(', ');
    const message = `Idris 2: settings of the idris2-lsp extension (bamboo.idris2-lsp) are set: ${keys}. Copy them to this extension's settings? They are left as they are.`;
    deps.notices.push({ kind: 'migration', message, actions: [COPY, NOT_NOW, NEVER] });
    const picked = await api.window.showInformationMessage(plainText(message), COPY, NOT_NOW, NEVER);
    if (store.isDisposed) {
      return;
    }
    if (picked === COPY) {
      await copy(planMigration(findValues(api)));
    } else if (picked === NEVER) {
      await deps.globalState.update(MIGRATION_DECLINED_KEY, true);
    }
  };

  const guardedCheck = (): void => {
    check().catch((error: unknown) => deps.log.warn(`Copying the settings of idris2-lsp failed: ${String(error)}`));
  };

  store.add(
    api.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(BAMBOO_SECTION)) {
        guardedCheck();
      }
    }),
  );
  store.add(deps.trust.onDidGrant(guardedCheck));
  guardedCheck();
  return store;
}
