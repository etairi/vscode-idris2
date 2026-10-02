// features/help/keybindings.ts: the document of **Idris 2: Show Keybindings**, generated from
// package.json's contributed keybindings. Checked against the letter table of ARCHITECTURE §10
// (written out here, not read from the manifest), for every scheme on macOS and on Linux, so that a
// binding added, dropped or rebound in the manifest — or a generator that reads the manifest
// otherwise than VS Code — fails here.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { KeybindingScheme, SettingsChange } from '../../src/core/config';
import { Emitter } from '../../src/core/event';
import { displayKey, KEYBINDINGS_DOCUMENT_SCHEME, keybindingsText, platformKey, registerShowKeybindings, type ShowKeybindingsApi } from '../../src/features/help/keybindings';
import { repoRoot } from '../fake-tools/paths';
import { FakeUri } from './support/intelligence';

interface Binding {
  readonly command: string;
  readonly key: string;
  readonly mac?: string;
  readonly when?: string;
}

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as {
  contributes: { keybindings: Binding[]; commands: { command: string; title: string; category?: string }[] };
};

/** ARCHITECTURE §10's letter table: the second key of each shortcut and the command it runs (M3's t d e, M4's other letters). */
const LETTERS: readonly (readonly [string, string, string])[] = [
  ['t', 'idris2.typeAtCursor', 'Idris 2: Type at Cursor'],
  ['d', 'idris2.docsAtCursor', 'Idris 2: Docs at Cursor'],
  ['e', 'idris2.evaluateSelection', 'Idris 2: Evaluate Selection'],
  ['c', 'idris2.caseSplit', 'Idris 2: Case Split'],
  ['a', 'idris2.addClause', 'Idris 2: Add Clause'],
  ['l', 'idris2.makeLemma', 'Idris 2: Make Lemma'],
  ['w', 'idris2.makeWith', 'Idris 2: Make With'],
  ['m', 'idris2.makeCase', 'Idris 2: Make Case'],
  ['s', 'idris2.proofSearch', 'Idris 2: Proof Search'],
  ['n', 'idris2.nextResult', 'Idris 2: Next Result'],
  ['g', 'idris2.generateDefinition', 'Idris 2: Generate Definition'],
  ['i', 'idris2.intro', 'Idris 2: Intro'],
  ['r', 'idris2.refineHole', 'Idris 2: Refine Hole…'],
  ['[', 'idris2.previousHole', 'Idris 2: Previous Hole'],
  [']', 'idris2.nextHole', 'Idris 2: Next Hole'],
];

/** The rows the document lists (key, title, command), in its order. */
function rows(text: string): [string, string, string][] {
  return text
    .split('\n')
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(/ {3,}/) as [string, string, string]);
}

/** The keys a scheme binds on a platform, per ARCHITECTURE §10 (`auto`: chords on macOS, prefix elsewhere). */
function expectedRows(scheme: 'auto' | 'chords' | 'prefix', platform: NodeJS.Platform): [string, string, string][] {
  const resolved = scheme === 'auto' ? (platform === 'darwin' ? 'chords' : 'prefix') : scheme;
  return LETTERS.map(([letter, command, title]) => {
    const key = letter.toUpperCase();
    return [resolved === 'chords' ? `Ctrl+C Ctrl+${key}` : `Ctrl+Alt+I ${key}`, title, command];
  });
}

suite('Show Keybindings: the document, from package.json', () => {
  test('every contributed binding has the when clause the generator reads: an Idris editor with focus, and one scheme', () => {
    for (const b of manifest.contributes.keybindings) {
      const terms = (b.when ?? '').split(' && ');
      assert.deepStrictEqual(terms.slice(0, 2), ['editorTextFocus', 'idris2.isIdrisDocument'], JSON.stringify(b));
      assert.match(terms[2] ?? '', /^config\.idris2\.keybindings\.scheme == '(auto|chords|prefix)'$/, JSON.stringify(b));
      assert.strictEqual(terms.length, 3, JSON.stringify(b));
    }
  });

  for (const platform of ['darwin', 'linux'] as const) {
    for (const scheme of ['auto', 'chords', 'prefix'] as const) {
      test(`${scheme} on ${platform}: exactly the letters of ARCHITECTURE §10, with this platform's keys, in the manifest's order`, () => {
        assert.deepStrictEqual(rows(keybindingsText(manifest, scheme, platform)), expectedRows(scheme, platform));
      });
    }
  }

  test('the header says which scheme is on and what auto is on this platform; Next Result\'s and Generate Definition\'s second uses follow their lines', () => {
    const mac = keybindingsText(manifest, 'auto', 'darwin').split('\n');
    assert.deepStrictEqual(mac.slice(0, 7), [
      'Idris 2 keyboard shortcuts',
      '',
      'Scheme: auto, which on macOS is chords.',
      'Ctrl+C, then Ctrl and the key. On macOS Ctrl is the Control key, not Command.',
      'A keymap extension that binds Ctrl+C itself (VSCodeVim does by default) takes precedence: choose prefix then.',
      'The shortcuts work while the editor of an Idris file has the keyboard focus.',
      '',
    ]);
    const g = mac.findIndex((line) => line.includes('idris2.generateDefinition'));
    assert.match(mac[g + 1], /^ {5,}with the cursor on the declaration or the result of the definition being cycled: Next Definition$/);
    // ROADMAP §9 Q26: `n` continues a Generate Definition cycle too.
    const n = mac.findIndex((line) => line.includes('idris2.nextResult'));
    assert.match(mac[n + 1], /^ {5,}while the file's cycle is a Generate Definition's: the next definition$/);
    const linux = keybindingsText(manifest, 'auto', 'linux').split('\n');
    assert.deepStrictEqual(linux.slice(2, 5), [
      'Scheme: auto, which on Linux is prefix.',
      'Ctrl+Alt+I, then the key.',
      'In Idris editors Ctrl+Alt+I then no longer opens the Chat view.',
    ]);
    assert.deepStrictEqual(keybindingsText(manifest, 'chords', 'linux').split('\n').slice(2, 6), [
      'Scheme: chords.',
      'Ctrl+C, then Ctrl and the key.',
      'In Idris editors Ctrl+C then no longer copies.',
      'A keymap extension that binds Ctrl+C itself (VSCodeVim does by default) takes precedence: choose prefix then.',
    ]);
  });

  test('none, or a value that turns every binding off: no shortcut listed, and it says so and how to choose a scheme', () => {
    for (const [scheme, line] of [
      ['none', 'The setting idris2.keybindings.scheme is none: no shortcut is on.'],
      [undefined, 'The setting idris2.keybindings.scheme has a value other than auto, chords, prefix or none: no shortcut is on.'],
    ] as const) {
      const text = keybindingsText(manifest, scheme, 'darwin');
      assert.deepStrictEqual(rows(text), []);
      assert.ok(text.split('\n').includes(line), text);
      assert.match(text, /chooses auto, chords, prefix or none/);
      assert.ok(text.split('\n').includes('Changes made in your keybindings.json are not shown here.'));
    }
  });

  test('a binding without a scheme in its when clause would be on under every scheme; a malformed manifest lists nothing', () => {
    const extra = { contributes: { keybindings: [{ command: 'x.y', key: 'f5', when: 'editorTextFocus' }], commands: [] } };
    assert.deepStrictEqual(rows(keybindingsText(extra, 'none', 'linux')), [['F5', 'x.y', 'x.y']]);
    for (const bad of [undefined, null, 1, { contributes: 1 }, { contributes: { keybindings: [{ command: 1, key: 'a' }, null] } }]) {
      assert.deepStrictEqual(rows(keybindingsText(bad, 'chords', 'darwin')), []);
    }
  });

  test('keys: the platform\'s own key when the binding has one, shown with capitalised modifiers', () => {
    const b = { command: 'c', key: 'ctrl+alt+i c', mac: 'ctrl+c ctrl+c', linux: 'ctrl+shift+enter' };
    assert.strictEqual(platformKey(b, 'darwin'), 'ctrl+c ctrl+c');
    assert.strictEqual(platformKey(b, 'linux'), 'ctrl+shift+enter');
    assert.strictEqual(platformKey(b, 'win32'), 'ctrl+alt+i c');
    assert.strictEqual(displayKey('ctrl+c ctrl+['), 'Ctrl+C Ctrl+[');
    assert.strictEqual(displayKey('ctrl+shift+enter'), 'Ctrl+Shift+Enter');
    assert.strictEqual(displayKey('cmd+alt+i ]'), 'Cmd+Alt+I ]');
  });
});

suite('Show Keybindings: the command and its document', () => {
  function api() {
    const commands = new Map<string, () => Promise<void>>();
    const providers = new Map<string, vscode.TextDocumentContentProvider>();
    const shown: { uri: string; options: unknown }[] = [];
    const surface = {
      commands: {
        registerCommand: (id: string, run: () => Promise<void>) => {
          commands.set(id, run);
          return { dispose: () => commands.delete(id) };
        },
      },
      workspace: {
        registerTextDocumentContentProvider: (scheme: string, provider: vscode.TextDocumentContentProvider) => {
          providers.set(scheme, provider);
          return { dispose: () => providers.delete(scheme) };
        },
        openTextDocument: (uri: FakeUri) => Promise.resolve({ uri }),
      },
      window: {
        showTextDocument: (doc: { uri: FakeUri }, options: unknown) => {
          shown.push({ uri: doc.uri.toString(), options });
          return Promise.resolve();
        },
      },
      Uri: FakeUri,
      EventEmitter: class<T> {
        private readonly emitter = new Emitter<T>();
        readonly event = this.emitter.event;
        fire(e: T): void {
          this.emitter.fire(e);
        }
        dispose(): void {
          this.emitter.dispose();
        }
      },
    };
    return { surface: surface as unknown as ShowKeybindingsApi, commands, providers, shown };
  }

  test('opens a plain-text document of the scheme set now, and redraws it when the setting changes', async () => {
    const t = api();
    let scheme: KeybindingScheme | undefined = 'chords';
    const changes = new Emitter<SettingsChange>();
    const groups: string[] = [];
    const registration = registerShowKeybindings(t.surface, {
      config: {
        keybindingScheme: () => scheme,
        onDidChange: (group, listener) => {
          groups.push(group);
          return changes.event(listener);
        },
      },
      manifest,
      platform: 'linux',
    });
    await t.commands.get('idris2.showKeybindings')?.();
    assert.deepStrictEqual(t.shown, [{ uri: `${KEYBINDINGS_DOCUMENT_SCHEME}:/Idris 2 Keyboard Shortcuts.txt`, options: { preview: true } }]);
    const provider = t.providers.get(KEYBINDINGS_DOCUMENT_SCHEME) ?? assert.fail('no provider');
    const content = (): string => provider.provideTextDocumentContent(FakeUri.parse(t.shown[0].uri) as unknown as vscode.Uri, {} as vscode.CancellationToken) as string;
    assert.deepStrictEqual(rows(content()), expectedRows('chords', 'linux'));
    const fired: string[] = [];
    provider.onDidChange?.((uri) => fired.push(uri.toString()));
    assert.deepStrictEqual(groups, ['keybindings']);
    scheme = 'none';
    changes.fire({ affects: () => true });
    assert.deepStrictEqual(fired, [t.shown[0].uri]);
    assert.deepStrictEqual(rows(content()), []);
    registration.dispose();
    assert.strictEqual(t.commands.size, 0);
    assert.strictEqual(t.providers.size, 0);
  });
});
