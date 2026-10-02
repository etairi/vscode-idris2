/**
 * **Idris 2: Show Keybindings** (`types.ts`; ROADMAP M4): a read-only plain-text document listing the keyboard shortcuts that are on, generated from the
 * contributed keybindings of the extension's own manifest, so that the list cannot drift from the
 * bindings. Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`.
 *
 * **Which bindings are on.** VS Code runs a contributed binding when its `when` clause holds; ours
 * are `editorTextFocus && idris2.isIdrisDocument && config.idris2.keybindings.scheme == '<scheme>'`
 * (ARCHITECTURE §10), so the ones on are those whose scheme is the setting's value as that clause
 * compares it (`core/config.ts` `readKeybindingScheme`); a binding without a scheme in its clause
 * would be on under every scheme. The key is the one VS Code takes on this platform: the binding's
 * `mac`, `linux` or `win` key, else its `key` [doc: the `contributes.keybindings` reference] — which
 * is how `auto` binds the `chords` keys on macOS (a `mac` key) and the `prefix` keys elsewhere.
 */
import type * as vscode from 'vscode';
import type { KeybindingScheme } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { ShowKeybindingsDeps } from './types';

export const SHOW_KEYBINDINGS_COMMAND = 'idris2.showKeybindings';

/** The scheme of the document's URI (`idris2-keybindings:/Idris 2 Keyboard Shortcuts.txt`, plain text by its extension). */
export const KEYBINDINGS_DOCUMENT_SCHEME = 'idris2-keybindings';
const KEYBINDINGS_DOCUMENT_PATH = '/Idris 2 Keyboard Shortcuts.txt';

/** One entry of `contributes.keybindings`. */
interface ManifestBinding {
  readonly command: string;
  readonly key: string;
  readonly mac?: string;
  readonly linux?: string;
  readonly win?: string;
  readonly when?: string;
}

/** What is said after a command's line, for the commands a key does two things for. */
const SECOND_USE: Readonly<Record<string, string>> = {
  'idris2.nextResult': 'while the file\'s cycle is a Generate Definition\'s: the next definition',
  'idris2.generateDefinition': 'with the cursor on the declaration or the result of the definition being cycled: Next Definition',
};

const SCHEME_CLAUSE = /^config\.idris2\.keybindings\.scheme == '([^']*)'$/;

/** The scheme a `when` clause requires (`config.idris2.keybindings.scheme == '…'`, one of its `&&` terms), if any. */
function schemeOf(when: string | undefined): string | undefined {
  for (const term of (when ?? '').split('&&')) {
    const match = SCHEME_CLAUSE.exec(term.trim());
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The `contributes` arrays of `manifest` that this module reads, well-formed entries only. */
function contributions(manifest: unknown): { bindings: ManifestBinding[]; titles: Map<string, string> } {
  const contributes = isRecord(manifest) && isRecord(manifest.contributes) ? manifest.contributes : {};
  const optional = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string';
  const bindings = (Array.isArray(contributes.keybindings) ? contributes.keybindings : []).filter(
    (b): b is ManifestBinding =>
      isRecord(b) && typeof b.command === 'string' && typeof b.key === 'string' && optional(b.mac) && optional(b.linux) && optional(b.win) && optional(b.when),
  );
  const titles = new Map<string, string>();
  for (const c of Array.isArray(contributes.commands) ? contributes.commands : []) {
    if (isRecord(c) && typeof c.command === 'string' && typeof c.title === 'string') {
      titles.set(c.command, typeof c.category === 'string' ? `${c.category}: ${c.title}` : c.title);
    }
  }
  return { bindings, titles };
}

/** The key VS Code takes for `binding` on `platform`. */
export function platformKey(binding: ManifestBinding, platform: NodeJS.Platform): string {
  const specific = platform === 'darwin' ? binding.mac : platform === 'linux' ? binding.linux : platform === 'win32' ? binding.win : undefined;
  return specific ?? binding.key;
}

const MODIFIERS: Readonly<Record<string, string>> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Cmd', meta: 'Meta', win: 'Win' };

/** `ctrl+c ctrl+[` as `Ctrl+C Ctrl+[`: the modifiers' names capitalised, a letter in upper case. */
export function displayKey(key: string): string {
  return key
    .split(' ')
    .filter((chord) => chord !== '')
    .map((chord) =>
      chord
        .split('+')
        .map((part) => MODIFIERS[part] ?? (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
        .join('+'),
    )
    .join(' ');
}

function platformName(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform === 'win32' ? 'Windows' : platform;
}

/** What each scheme's keys are, and what they take from other uses on this platform (the setting's description says the same). */
function schemeLines(scheme: 'chords' | 'prefix', platform: NodeJS.Platform): string[] {
  if (scheme === 'chords') {
    return [
      'Ctrl+C, then Ctrl and the key.' + (platform === 'darwin' ? ' On macOS Ctrl is the Control key, not Command.' : ''),
      ...(platform === 'darwin' ? [] : ['In Idris editors Ctrl+C then no longer copies.']),
      'A keymap extension that binds Ctrl+C itself (VSCodeVim does by default) takes precedence: choose prefix then.',
    ];
  }
  return ['Ctrl+Alt+I, then the key.', ...(platform === 'darwin' ? [] : ['In Idris editors Ctrl+Alt+I then no longer opens the Chat view.'])];
}

/**
 * The document's text: the bindings of `manifest` that are on under `scheme` (the setting's value
 * as `readKeybindingScheme` reads it; `undefined` for a value that turns every binding off) on
 * `platform`, each with its key and its command's title and id, in the manifest's order.
 */
export function keybindingsText(manifest: unknown, scheme: KeybindingScheme | undefined, platform: NodeJS.Platform): string {
  const { bindings, titles } = contributions(manifest);
  const on = bindings.filter((b) => {
    const required = schemeOf(b.when);
    return required === undefined || required === scheme;
  });
  const lines = ['Idris 2 keyboard shortcuts', ''];
  if (scheme === undefined) {
    lines.push('The setting idris2.keybindings.scheme has a value other than auto, chords, prefix or none: no shortcut is on.');
  } else if (scheme === 'none') {
    lines.push('The setting idris2.keybindings.scheme is none: no shortcut is on.');
  } else {
    const resolved = scheme === 'auto' ? (platform === 'darwin' ? 'chords' : 'prefix') : scheme;
    lines.push(
      scheme === 'auto' ? `Scheme: auto, which on ${platformName(platform)} is ${resolved}.` : `Scheme: ${scheme}.`,
      ...schemeLines(resolved, platform),
      'The shortcuts work while the editor of an Idris file has the keyboard focus.',
    );
  }
  if (on.length > 0) {
    const rows = on.map((b) => ({ key: displayKey(platformKey(b, platform)), title: titles.get(b.command) ?? b.command, command: b.command }));
    const keyWidth = Math.max(...rows.map((r) => r.key.length));
    const titleWidth = Math.max(...rows.map((r) => r.title.length));
    lines.push('');
    for (const row of rows) {
      lines.push(`  ${row.key.padEnd(keyWidth)}   ${row.title.padEnd(titleWidth)}   ${row.command}`);
      const second = SECOND_USE[row.command];
      if (second !== undefined) {
        lines.push(`  ${''.padEnd(keyWidth)}     ${second}`);
      }
    }
  }
  lines.push(
    '',
    'The setting idris2.keybindings.scheme (user settings only) chooses auto, chords, prefix or none; Idris 2: Open Settings shows it.',
    'To change one shortcut, search for its command id in Preferences: Open Keyboard Shortcuts.',
    'Changes made in your keybindings.json are not shown here.',
    '',
  );
  return lines.join('\n');
}

export type ShowKeybindingsApi = Pick<typeof vscode, 'commands' | 'window' | 'workspace' | 'Uri' | 'EventEmitter'>;

/** Registers **Show Keybindings** and the content provider of its document. */
export function registerShowKeybindings(api: ShowKeybindingsApi, deps: ShowKeybindingsDeps): IDisposable {
  const store = new DisposableStore();
  const uri = api.Uri.from({ scheme: KEYBINDINGS_DOCUMENT_SCHEME, path: KEYBINDINGS_DOCUMENT_PATH });
  const changed = store.add(new api.EventEmitter<vscode.Uri>());
  store.add(
    api.workspace.registerTextDocumentContentProvider(KEYBINDINGS_DOCUMENT_SCHEME, {
      onDidChange: changed.event,
      provideTextDocumentContent: () => keybindingsText(deps.manifest, deps.config.keybindingScheme(), deps.platform),
    }),
  );
  store.add(deps.config.onDidChange('keybindings', () => changed.fire(uri)));
  store.add(
    api.commands.registerCommand(SHOW_KEYBINDINGS_COMMAND, async () => {
      const doc = await api.workspace.openTextDocument(uri);
      await api.window.showTextDocument(doc, { preview: true });
    }),
  );
  return store;
}
