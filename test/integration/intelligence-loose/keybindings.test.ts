// Suite `intelligence-loose`: the keyboard shortcuts of M3 (ROADMAP §9 Q5, decided 2026-09-28;
// ARCHITECTURE §10): the letters t, d and e under `idris2.keybindings.scheme`. What is checked is
// what VS Code made of package.json's contributions in this running instance — its Default
// Keybindings document (`workbench.action.openDefaultKeybindingsFile`, the core's and every
// extension's bindings with the key resolved for this OS and the `when` clause as VS Code parsed
// it: `getDefaultKeybindingsContent` / `writeKeybindingItem` in VS Code 1.139.1's workbench bundle
// [src]) — and that the commands the letters run are registered. The `when` clauses are then
// evaluated for each value of the setting. That VS Code evaluates `config.idris2.keybindings.scheme`
// in a key press from the user settings is VS Code's own behaviour and is not simulated here: no
// API dispatches a key (docs/checklists/M3.md presses them).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { waitFor, workspaceFile } from '../support';

interface Binding {
  readonly key: string;
  readonly command: string;
  readonly when?: string;
}

const LETTERS = { t: 'idris2.typeAtCursor', d: 'idris2.docsAtCursor', e: 'idris2.evaluateSelection' } as const;
const SCHEMES = ['auto', 'chords', 'prefix', 'none'] as const;
/**
 * E23 on macOS [live, VS Code 1.139.1, this suite]: the bindings whose first key is `ctrl+c` (the
 * `chords` scheme, the default there) or `ctrl+alt+i` (`prefix`) in the Default Keybindings
 * document, other than this extension's.
 */
const E23_DARWIN: Record<string, string[]> = { 'ctrl+c': [], 'ctrl+alt+i': [] };

/** The `when` clause's parts other than the scheme, as ARCHITECTURE §10 requires them. */
const FIXED_PARTS = ['editorTextFocus', 'idris2.isIdrisDocument'];

/** The keys each scheme binds to `letter` on this OS; `auto` is `chords` on macOS, `prefix` elsewhere. */
function expectedKey(scheme: (typeof SCHEMES)[number], letter: string): string | undefined {
  const resolved = scheme === 'auto' ? (process.platform === 'darwin' ? 'chords' : 'prefix') : scheme;
  return resolved === 'chords' ? `ctrl+c ctrl+${letter}` : resolved === 'prefix' ? `ctrl+alt+i ${letter}` : undefined;
}

/** The bindings of VS Code's Default Keybindings document (`_getDefaultKeybindings` [src]). */
async function defaultKeybindings(): Promise<Binding[]> {
  await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
  const doc = await waitFor('the Default Keybindings document', () =>
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === 'vscode://defaultsettings/keybindings.json'),
  );
  const text = doc.getText();
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  // A comment line, the array (`[` and `]` on lines of their own), then the unbound commands as comments.
  const array = /^\[$[\s\S]*?^\]$/m.exec(text);
  assert.ok(array, `no array in the Default Keybindings document: ${text.slice(0, 200)}`);
  return JSON.parse(array[0]) as Binding[];
}

/**
 * The scheme a binding's `when` clause requires, if the clause is exactly the fixed parts and one
 * `config.idris2.keybindings.scheme == '<scheme>'` (in any order: VS Code serialises the parsed
 * expression, which may reorder it); otherwise `undefined`.
 */
function schemeOf(when: string | undefined): string | undefined {
  const parts = (when ?? '').split(' && ');
  const schemes = parts.flatMap((p) => /^config\.idris2\.keybindings\.scheme == '([a-z]+)'$/.exec(p)?.[1] ?? []);
  const rest = parts.filter((p) => !p.startsWith('config.idris2.keybindings.scheme'));
  return schemes.length === 1 && rest.length === FIXED_PARTS.length && FIXED_PARTS.every((f) => rest.includes(f))
    ? schemes[0]
    : undefined;
}

suite('M3 keybindings: t, d, e under idris2.keybindings.scheme', () => {
  let bindings: Binding[];
  let ours: Binding[];

  suiteSetup(async () => {
    bindings = await defaultKeybindings();
    ours = bindings.filter((b) => b.command.startsWith('idris2.'));
  });

  test('VS Code accepted exactly the nine bindings: one per letter and scheme (auto, chords, prefix), none for `none`', () => {
    assert.strictEqual(ours.length, 9, JSON.stringify(ours, null, 1));
    for (const b of ours) {
      assert.ok(schemeOf(b.when) !== undefined, `unexpected when clause: ${JSON.stringify(b)}`);
    }
  });

  for (const scheme of SCHEMES) {
    test(`scheme ${scheme}: ${scheme === 'none' ? 'no letter is bound' : 'each letter runs its command, with this OS\'s key'}`, () => {
      const active = ours.filter((b) => schemeOf(b.when) === scheme);
      const expected = Object.entries(LETTERS).flatMap(([letter, command]) => {
        const key = expectedKey(scheme, letter);
        return key === undefined ? [] : [{ key, command }];
      });
      const sortKey = (b: { command: string }): string => b.command;
      assert.deepStrictEqual(
        active.map((b) => ({ key: b.key, command: b.command })).sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
        expected.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
      );
    });
  }

  test('the three commands are registered, and no other idris2 command is bound', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of Object.values(LETTERS)) {
      assert.ok(registered.has(command), `${command} is not registered`);
    }
    assert.deepStrictEqual([...new Set(ours.map((b) => b.command))].sort(), Object.values(LETTERS).sort());
  });

  test('E23: the bindings of VS Code and of other extensions whose first key is a scheme\'s first key, on this OS', () => {
    // ROADMAP §9 Q5 / E23: the collisions of both schemes with the default keymap, listed before
    // the first binding ships. A binding here is shadowed in Idris editors (`editorTextFocus &&
    // idris2.isIdrisDocument`) under the scheme when its own `when` clause also holds there. The
    // list is written to the test log; docs/as-built/M3.md, *E23*, records it.
    // The document lists the core bindings too (so that an empty list below means something).
    assert.ok(bindings.some((b) => b.command === 'editor.action.clipboardCopyAction'), 'no core binding read');
    const firstKey = (key: string): string => key.split(' ')[0];
    const collisions = Object.fromEntries(
      ['ctrl+c', 'ctrl+alt+i'].map((first) => [
        first,
        bindings
          .filter((b) => !b.command.startsWith('idris2.') && firstKey(b.key) === first)
          .map((b) => `${b.key} → ${b.command}${b.when === undefined ? '' : ` when ${b.when}`}`)
          .sort(),
      ]),
    );
    console.log(`      E23 (${process.platform}): ${JSON.stringify(collisions, null, 2).replace(/\n/g, '\n      ')}`);
    if (process.platform === 'darwin') {
      assert.deepStrictEqual(collisions, E23_DARWIN);
    }
  });

  test('the setting is read from the user settings only: writing it to the workspace is refused', async () => {
    const settings = workspaceFile('.vscode', 'settings.json').fsPath;
    const existed = fs.existsSync(path.dirname(settings));
    const config = vscode.workspace.getConfiguration('idris2.keybindings');
    assert.strictEqual(config.inspect('scheme')?.defaultValue, 'auto');
    try {
      await assert.rejects(Promise.resolve(config.update('scheme', 'chords', vscode.ConfigurationTarget.Workspace)));
      assert.strictEqual(config.inspect('scheme')?.workspaceValue, undefined);
    } finally {
      // Nothing was written if the update was refused; if it was not, undo it.
      if (vscode.workspace.getConfiguration('idris2.keybindings').inspect('scheme')?.workspaceValue !== undefined) {
        await config.update('scheme', undefined, vscode.ConfigurationTarget.Workspace);
      }
      if (!existed) {
        fs.rmSync(path.dirname(settings), { recursive: true, force: true });
      }
    }
  });
});
