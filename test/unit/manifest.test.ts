import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { readToolchainSettings } from '../../src/core/config';

// Consistency of package.json's M1 contributions: settings (with core/config.ts, which reads
// them), Restricted Mode, commands, menus and the walkthrough. Whether each command is also
// *registered* at run time is an integration question (test/integration/).

const PACKAGE_NAME = 'vscode-idris2';

function repoRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === PACKAGE_NAME) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no package.json named "${PACKAGE_NAME}" above ${__dirname}`);
    }
  }
}

interface SettingSchema {
  type: string;
  default: unknown;
  scope?: string;
  markdownDescription?: string;
}

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

interface WalkthroughStep {
  id: string;
  description: string;
  media: { markdown?: string };
  completionEvents?: string[];
}

interface Manifest {
  capabilities: {
    untrustedWorkspaces: { supported: boolean | 'limited'; description?: string; restrictedConfigurations?: string[] };
  };
  contributes: {
    configuration: { title: string; properties: Record<string, SettingSchema> };
    commands: { command: string; title: string; category?: string }[];
    submenus: { id: string; label: string; icon?: string }[];
    menus: Record<string, MenuEntry[]>;
    walkthroughs: { id: string; steps: WalkthroughStep[] }[];
  };
}

const root = repoRoot();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const { properties } = manifest.contributes.configuration;
const commandIds = manifest.contributes.commands.map((c) => c.command);

/** The context keys the extension sets; a `when` clause may use no other `idris2.*` key. */
const CONTEXT_KEYS = ['idris2.isIdrisDocument', 'idris2.packFound'];

/** The command that opens the status QuickPick; every other command is a menu entry. */
const STATUS_MENU_COMMAND = 'idris2.showStatusMenu';
const SUBMENU = 'idris2.editorTitle';

suite('package.json (M1 contributions)', () => {
  suite('settings', () => {
    test('every idris2.* setting has a type, a default, a scope and a markdownDescription', () => {
      for (const [key, schema] of Object.entries(properties)) {
        assert.ok(key.startsWith('idris2.'), key);
        assert.ok(schema.type, `${key}: type`);
        assert.ok('default' in schema, `${key}: default`);
        assert.ok(schema.scope, `${key}: scope`);
        assert.ok(schema.markdownDescription && schema.markdownDescription.length > 40, `${key}: markdownDescription`);
      }
    });

    test('paths and the environment are machine-overridable (ARCHITECTURE §11)', () => {
      for (const [key, schema] of Object.entries(properties)) {
        if (key.endsWith('Path') || key === 'idris2.toolchain.env') {
          assert.strictEqual(schema.scope, 'machine-overridable', key);
        }
      }
    });

    test('core/config.ts reads exactly the contributed idris2.toolchain.* keys, and their defaults mean "discover"', () => {
      const read: string[] = [];
      const defaults = readToolchainSettings(
        {
          get: (key) => {
            read.push(`idris2.${key}`);
            return properties[`idris2.${key}`]?.default;
          },
        },
        '/home/u',
      );
      const contributed = Object.keys(properties).filter((key) => key.startsWith('idris2.toolchain.'));
      assert.deepStrictEqual([...read].sort(), [...contributed].sort());
      assert.deepStrictEqual(defaults, {
        idris2Path: '',
        lspPath: '',
        packPath: '',
        preferPack: false,
        env: {},
        ignoredEnvEntries: [],
      });
    });

    test('markdown links to settings (`#key#`) name contributed settings', () => {
      for (const [key, schema] of Object.entries(properties)) {
        for (const match of (schema.markdownDescription ?? '').matchAll(/`#([^#`]+)#`/g)) {
          assert.ok(match[1] in properties, `${key} links to unknown setting ${match[1]}`);
        }
      }
    });
  });

  suite('Restricted Mode', () => {
    test('support is "limited", with a description', () => {
      const { supported, description } = manifest.capabilities.untrustedWorkspaces;
      assert.strictEqual(supported, 'limited');
      assert.ok(description && description.length > 40);
    });

    test('restrictedConfigurations lists every toolchain setting naming an executable or the environment, and only those', () => {
      const expected = Object.keys(properties).filter(
        (key) => key.startsWith('idris2.toolchain.') && (key.endsWith('Path') || key === 'idris2.toolchain.env'),
      );
      assert.deepStrictEqual(
        [...(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations ?? [])].sort(),
        expected.sort(),
      );
      assert.strictEqual(expected.length, 4);
    });
  });

  suite('commands and menus', () => {
    test('every command is in the "Idris 2" category and has a unique id', () => {
      assert.strictEqual(new Set(commandIds).size, commandIds.length);
      for (const command of manifest.contributes.commands) {
        assert.strictEqual(command.category, 'Idris 2', command.command);
      }
    });

    test('every menu entry names a contributed command or submenu', () => {
      const submenuIds = manifest.contributes.submenus.map((s) => s.id);
      for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
        for (const entry of entries) {
          if (entry.command !== undefined) {
            assert.ok(commandIds.includes(entry.command), `${menu}: ${entry.command}`);
          } else {
            assert.ok(entry.submenu && submenuIds.includes(entry.submenu), `${menu}: ${JSON.stringify(entry)}`);
          }
        }
      }
    });

    test('when clauses use only the context keys the extension sets', () => {
      for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
        for (const entry of entries) {
          for (const key of (entry.when ?? '').match(/idris2\.[A-Za-z0-9_.]+/g) ?? []) {
            assert.ok(CONTEXT_KEYS.includes(key), `${menu}: unknown context key ${key}`);
          }
        }
      }
    });

    test('the "Idris 2" editor-title submenu shows on Idris documents, in the navigation group', () => {
      assert.deepStrictEqual(manifest.contributes.submenus.map((s) => [s.id, s.label]), [[SUBMENU, 'Idris 2']]);
      assert.deepStrictEqual(manifest.contributes.menus['editor/title'], [
        { submenu: SUBMENU, when: 'idris2.isIdrisDocument', group: 'navigation' },
      ]);
    });

    test('the submenu lists every contributed command once, except the status-menu opener', () => {
      const listed = manifest.contributes.menus[SUBMENU].map((entry) => entry.command);
      assert.strictEqual(new Set(listed).size, listed.length);
      assert.deepStrictEqual(
        [...listed].sort(),
        commandIds.filter((id) => id !== STATUS_MENU_COMMAND).sort(),
      );
    });

    test('Install pack… and Install or Update idris2-lsp are gated on idris2.packFound, the same way everywhere', () => {
      const whenOf = (menu: string, command: string): string | undefined =>
        manifest.contributes.menus[menu].find((entry) => entry.command === command)?.when;
      for (const menu of ['commandPalette', SUBMENU]) {
        assert.strictEqual(whenOf(menu, 'idris2.installPack'), '!idris2.packFound', menu);
        assert.strictEqual(whenOf(menu, 'idris2.installIdris2Lsp'), 'idris2.packFound', menu);
      }
    });
  });

  suite('walkthrough', () => {
    const steps = manifest.contributes.walkthroughs.flatMap((w) => w.steps);

    test('every step has a markdown page under media/walkthrough/ that exists', () => {
      assert.ok(steps.length > 0);
      for (const step of steps) {
        const page = step.media.markdown;
        assert.ok(page && page.startsWith('media/walkthrough/') && page.endsWith('.md'), step.id);
        assert.ok(fs.existsSync(path.join(root, page)), `${step.id}: ${page} is missing`);
      }
    });

    test('command links and completion events name contributed idris2.* commands', () => {
      for (const step of steps) {
        const linked = [...step.description.matchAll(/\(command:(idris2\.[A-Za-z0-9]+)\)/g)].map((m) => m[1]);
        const completing = (step.completionEvents ?? [])
          .filter((event) => event.startsWith('onCommand:idris2.'))
          .map((event) => event.slice('onCommand:'.length));
        for (const id of [...linked, ...completing]) {
          assert.ok(commandIds.includes(id), `${step.id}: ${id}`);
        }
      }
    });
  });
});
