import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  IDE_MODE_LIMIT_KEYS,
  IDE_MODE_SESSION_KEYS,
  MAX_DELAY_MS,
  MIN_CHECKING_DELAY_MS,
  MIN_REQUEST_TIMEOUT_MS,
  readCheckingSettings,
  readDiagnosticsSettings,
  readIdeModeSettings,
  readToolchainSettings,
  readTraceSettings,
  type ConfigurationReader,
} from '../../src/core/config';

// Consistency of package.json's M1 and M2 contributions: settings (with core/config.ts, which
// reads them), Restricted Mode, commands, menus and the walkthrough. Whether each command is
// also *registered* at run time is an integration question (test/integration/).

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
  enum?: string[];
  markdownEnumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
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
    commands: { command: string; title: string; category?: string; enablement?: string }[];
    submenus: { id: string; label: string; icon?: string }[];
    menus: Record<string, MenuEntry[]>;
    walkthroughs: { id: string; steps: WalkthroughStep[] }[];
  };
}

const root = repoRoot();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const { properties } = manifest.contributes.configuration;
const commandIds = manifest.contributes.commands.map((c) => c.command);

/**
 * The context keys the extension sets; a `when` clause may use no other `idris2.*` key, apart
 * from `config.idris2.<setting>` for a contributed setting.
 */
const CONTEXT_KEYS = ['idris2.isIdrisDocument', 'idris2.packFound'];

/** The command that opens the status QuickPick; every other command but the developer ones is a menu entry. */
const STATUS_MENU_COMMAND = 'idris2.showStatusMenu';
const SUBMENU = 'idris2.editorTitle';

/** Commands for diagnosing the protocol (ROADMAP M2): category "Idris 2 (Developer)", only with the trace on. */
const DEVELOPER_COMMANDS = ['idris2.sendRawRequest'];
const DEVELOPER_WHEN = 'config.idris2.trace.protocol && isWorkspaceTrusted';

/** Reads every setting through core/config.ts with each key answering `value(key)`; returns the keys read. */
function readAllSettings(value: (key: string) => unknown): { keys: string[]; settings: unknown[] } {
  const keys: string[] = [];
  const reader: ConfigurationReader = {
    get: (key) => {
      keys.push(`idris2.${key}`);
      return value(`idris2.${key}`);
    },
  };
  const settings = [
    readToolchainSettings(reader, '/home/u'),
    readCheckingSettings(reader),
    readIdeModeSettings(reader),
    readDiagnosticsSettings(reader),
    readTraceSettings(reader),
  ];
  return { keys, settings };
}

suite('package.json (M1 and M2 contributions)', () => {
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

    test('core/config.ts reads exactly the contributed keys, and the contributed defaults read as its defaults', () => {
      const { keys, settings } = readAllSettings((key) => properties[key]?.default);
      assert.deepStrictEqual([...keys].sort(), Object.keys(properties).sort());
      assert.deepStrictEqual(settings, [
        { idris2Path: '', lspPath: '', packPath: '', preferPack: false, env: {}, ignoredEnvEntries: [] },
        { trigger: 'onSave', delayMs: 700 },
        {
          transport: 'stdio',
          isolateBuildDir: true,
          loosePackages: [],
          extraArgs: [],
          requestTimeoutMs: 5000,
          longActionTimeoutMs: 60000,
          idleTimeoutMs: 600000,
          maxSessions: 0,
          maxBackgroundChecks: 0,
        },
        { includeSourceExcerpt: false },
        { protocol: false },
      ]);
      // Every value absent (a setting VS Code does not know) reads as the same defaults.
      assert.deepStrictEqual(readAllSettings(() => undefined).settings, settings);
    });

    test('the M2 defaults are the ones ARCHITECTURE §11 and the user\'s decisions of 2026-09-27 and 2026-09-28 name', () => {
      const defaults = Object.fromEntries(
        Object.entries(properties)
          .filter(([key]) => /^idris2\.(checking|ideMode|diagnostics|trace)\./.test(key))
          .map(([key, schema]) => [key, schema.default]),
      );
      assert.deepStrictEqual(defaults, {
        'idris2.checking.trigger': 'onSave',
        'idris2.checking.delay': 700,
        // stdio on every platform; the socket only as an opt-in (ROADMAP §9 Q20, 2026-09-28).
        'idris2.ideMode.transport': 'stdio',
        'idris2.ideMode.isolateBuildDir': true,
        'idris2.ideMode.loosePackages': [],
        'idris2.ideMode.extraArgs': [],
        'idris2.ideMode.requestTimeout': 5000,
        'idris2.ideMode.longActionTimeout': 60000,
        'idris2.ideMode.idleTimeout': 600000,
        // No limits by default (ROADMAP §9 Q21, 2026-09-28).
        'idris2.ideMode.maxSessions': 0,
        'idris2.ideMode.maxBackgroundChecks': 0,
        'idris2.diagnostics.includeSourceExcerpt': false,
        'idris2.trace.protocol': false,
      });
    });

    test('enums list a description per value and contain their default; bounds match core/config.ts', () => {
      for (const [key, schema] of Object.entries(properties)) {
        if (schema.enum !== undefined) {
          assert.ok(schema.enum.includes(schema.default as string), `${key}: default not in enum`);
          assert.strictEqual(schema.markdownEnumDescriptions?.length, schema.enum.length, `${key}: enum descriptions`);
        }
        if (schema.minimum !== undefined) {
          assert.ok((schema.default as number) >= schema.minimum, `${key}: default below minimum`);
        }
      }
      assert.strictEqual(properties['idris2.checking.delay'].minimum, MIN_CHECKING_DELAY_MS);
      assert.strictEqual(properties['idris2.ideMode.requestTimeout'].minimum, MIN_REQUEST_TIMEOUT_MS);
      assert.strictEqual(properties['idris2.ideMode.longActionTimeout'].minimum, MIN_REQUEST_TIMEOUT_MS);
      assert.strictEqual(properties['idris2.ideMode.idleTimeout'].minimum, 0);
      assert.strictEqual(properties['idris2.ideMode.maxSessions'].minimum, 0);
      assert.strictEqual(properties['idris2.ideMode.maxBackgroundChecks'].minimum, 0);
      // Each window has its own extension host, pool and checks: the limits are per window (M2
      // verification of the Q20–Q22 fixes: the descriptions read as machine-wide).
      assert.match(properties['idris2.ideMode.maxSessions'].markdownDescription ?? '', /at once in this VS Code window; .* Each window counts its own/);
      assert.match(properties['idris2.ideMode.maxBackgroundChecks'].markdownDescription ?? '', /at once in this VS Code window \(each window counts its own\)/);
      // Every delay is bounded by what Node's setTimeout can wait (core/config.ts MAX_DELAY_MS).
      const delays = ['idris2.checking.delay', 'idris2.ideMode.requestTimeout', 'idris2.ideMode.longActionTimeout', 'idris2.ideMode.idleTimeout'];
      for (const key of delays) {
        assert.strictEqual(properties[key].maximum, MAX_DELAY_MS, key);
        assert.ok((properties[key].default as number) <= MAX_DELAY_MS, key);
      }
      assert.deepStrictEqual(
        Object.keys(properties).filter((key) => properties[key].maximum !== undefined).sort(),
        [...delays].sort(),
      );
    });

    test('scopes: checking.* per resource (a folder may choose its trigger), ideMode/diagnostics per window, the transport and the trace in user settings only (application)', () => {
      for (const [key, schema] of Object.entries(properties)) {
        if (key.startsWith('idris2.checking.')) {
          assert.strictEqual(schema.scope, 'resource', key);
        } else if (key === 'idris2.ideMode.transport') {
          // User settings only: a workspace cannot switch a user who chose stdio back to the
          // socket, which serves any local program that connects first (ROADMAP §9 Q20); nor can a
          // remote machine's settings (M2 verification of the Q20–Q22 fixes: `machine` let them).
          assert.strictEqual(schema.scope, 'application', key);
        } else if (key === 'idris2.trace.protocol') {
          // User settings only: it offers Send Raw Protocol Request and writes source text and paths
          // (also of consented folders outside the workspace) to the log (M2 verification of the third review).
          assert.strictEqual(schema.scope, 'application', key);
        } else if (/^idris2\.(ideMode|diagnostics|trace)\./.test(key)) {
          assert.strictEqual(schema.scope, 'window', key);
        }
      }
    });

    test('Q20: the transport offers stdio (the default) and the socket, nothing else, and is read from user settings only', () => {
      const transport = properties['idris2.ideMode.transport'];
      assert.deepStrictEqual(transport.enum, ['stdio', 'socket']);
      assert.strictEqual(transport.default, 'stdio');
      // `application`: VS Code reads it from the (local) user settings only — the 1.139.1 workbench
      // bundle loads workspace settings with the scopes 4–7 and a remote machine's with 2–7,
      // `application` being 1 [src]; docs/as-built/M2.md, *Transport* —; the suite loose-stdio has a
      // workspace value "socket" and asserts that it is ignored [integration].
      assert.strictEqual(transport.scope, 'application');
      // The description says what the socket exposes (ROADMAP §9 Q20: "described honestly").
      assert.match(transport.markdownDescription ?? '', /first\*\* connection to that port, from any program on this computer/);
      assert.match(transport.markdownEnumDescriptions?.[1] ?? '', /another program on this computer that connects first can use the compiler as you, including running programs/);
      // A dev container's configuration writes a remote machine's settings ([doc] containers.dev), which
      // an `application` setting is not read from: the description says so.
      assert.match(transport.markdownDescription ?? '', /read from your user settings only — not from a workspace's, nor from a remote machine's \(such as those a dev container's configuration fills\)/);
      // extraArgs cannot bring the socket in by the side door (pool.ts `extraArgsProblem`).
      assert.match(properties['idris2.ideMode.extraArgs'].markdownDescription ?? '', /must not contain `--ide-mode` or `--ide-mode-socket`/);
    });

    test('every idris2.ideMode.* key either shapes a session (a change may restart it) or only limits what runs (a change restarts nothing)', () => {
      const ideModeKeys = Object.keys(properties)
        .filter((key) => key.startsWith('idris2.ideMode.'))
        .map((key) => key.slice('idris2.'.length))
        .sort();
      assert.deepStrictEqual([...IDE_MODE_SESSION_KEYS, ...IDE_MODE_LIMIT_KEYS].sort(), ideModeKeys);
      assert.deepStrictEqual([...IDE_MODE_LIMIT_KEYS].sort(), ['ideMode.maxBackgroundChecks', 'ideMode.maxSessions']);
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

    test('restrictedConfigurations lists every setting naming an executable, arguments, packages or the environment, and only those', () => {
      // CLAUDE.md, "Rules established by M0": such settings are restricted. The IDE-mode
      // arguments (extraArgs) and the packages passed as -p (loosePackages) are of that kind;
      // transport, isolateBuildDir and the time limits only choose among the extension's own
      // arguments and behaviour.
      const expected = Object.keys(properties).filter(
        (key) =>
          (key.startsWith('idris2.toolchain.') && (key.endsWith('Path') || key === 'idris2.toolchain.env')) ||
          key === 'idris2.ideMode.extraArgs' ||
          key === 'idris2.ideMode.loosePackages',
      );
      assert.deepStrictEqual(
        [...(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations ?? [])].sort(),
        expected.sort(),
      );
      assert.strictEqual(expected.length, 6);
    });
  });

  suite('commands and menus', () => {
    test('every command is in the "Idris 2" category, the developer ones in "Idris 2 (Developer)"; ids are unique', () => {
      assert.strictEqual(new Set(commandIds).size, commandIds.length);
      for (const command of manifest.contributes.commands) {
        const expected = DEVELOPER_COMMANDS.includes(command.command) ? 'Idris 2 (Developer)' : 'Idris 2';
        assert.strictEqual(command.category, expected, command.command);
      }
    });

    test('developer commands are enabled and shown only with idris2.trace.protocol on, in a trusted workspace', () => {
      for (const id of DEVELOPER_COMMANDS) {
        assert.strictEqual(manifest.contributes.commands.find((c) => c.command === id)?.enablement, DEVELOPER_WHEN, id);
        assert.strictEqual(manifest.contributes.menus.commandPalette.find((e) => e.command === id)?.when, DEVELOPER_WHEN, id);
        assert.ok(properties['idris2.trace.protocol'], 'the setting the clause reads');
      }
    });

    test('the M2 backend commands are offered in the Command Palette only where they can run', () => {
      const when = (command: string): string | undefined =>
        manifest.contributes.menus.commandPalette.find((entry) => entry.command === command)?.when;
      // Restricted Mode starts no process, so these could do nothing there.
      assert.strictEqual(when('idris2.checkFile'), 'idris2.isIdrisDocument && isWorkspaceTrusted');
      assert.strictEqual(when('idris2.restartBackend'), 'isWorkspaceTrusted');
      assert.strictEqual(when('idris2.stopBackend'), 'isWorkspaceTrusted');
      // Showing the trace and managing the allowed folders run nothing.
      assert.strictEqual(when('idris2.showProtocolTrace'), undefined);
      assert.strictEqual(when('idris2.manageAllowedFolders'), undefined);
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

    test('when clauses use only the context keys the extension sets, and config.* only for contributed settings', () => {
      const clauses = [
        ...Object.entries(manifest.contributes.menus).flatMap(([menu, entries]) =>
          entries.map((entry) => [menu, entry.when ?? ''] as const),
        ),
        ...manifest.contributes.commands.map((c) => [`enablement of ${c.command}`, c.enablement ?? ''] as const),
      ];
      for (const [where, clause] of clauses) {
        for (const match of clause.matchAll(/(config\.)?(idris2\.[A-Za-z0-9_.]+)/g)) {
          if (match[1] !== undefined) {
            assert.ok(match[2] in properties, `${where}: config.${match[2]} is not a contributed setting`);
          } else {
            assert.ok(CONTEXT_KEYS.includes(match[2]), `${where}: unknown context key ${match[2]}`);
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

    test('the submenu lists every contributed command once, except the status-menu opener and the developer commands', () => {
      const listed = manifest.contributes.menus[SUBMENU].map((entry) => entry.command);
      assert.strictEqual(new Set(listed).size, listed.length);
      assert.deepStrictEqual(
        [...listed].sort(),
        commandIds.filter((id) => id !== STATUS_MENU_COMMAND && !DEVELOPER_COMMANDS.includes(id)).sort(),
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
