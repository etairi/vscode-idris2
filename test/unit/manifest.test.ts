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
  readEvaluationSettings,
  readIdeModeSettings,
  readInlayHintSettings,
  readKeybindingScheme,
  readSaveBeforeAction,
  readToolchainSettings,
  readTraceSettings,
  type ConfigurationReader,
} from '../../src/core/config';

// Consistency of package.json's M1–M4 contributions: settings (with core/config.ts, which reads
// them), Restricted Mode, commands, menus, views, keybindings and the walkthrough. Whether each
// command is also *registered* at run time is an integration question (test/integration/).

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

interface Keybinding {
  command: string;
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

interface WalkthroughStep {
  id: string;
  description: string;
  media: { markdown?: string };
  completionEvents?: string[];
}

interface View {
  id: string;
  name: string;
  icon?: string;
  contextualTitle?: string;
  when?: string;
}

interface ViewWelcome {
  view: string;
  contents: string;
  when?: string;
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
    viewsContainers: Record<string, { id: string; title: string; icon: string }[]>;
    views: Record<string, View[]>;
    viewsWelcome: ViewWelcome[];
    keybindings: Keybinding[];
    walkthroughs: { id: string; steps: WalkthroughStep[] }[];
  };
}

const root = repoRoot();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const { properties } = manifest.contributes.configuration;
const commandIds = manifest.contributes.commands.map((c) => c.command);

/**
 * The context keys the extension sets; a `when` clause may use no other `idris2.*` key, apart
 * from `config.idris2.<setting>` for a contributed setting. `idris2.isIdrisWorkspace` (M4) shows
 * the Holes view (`features/holes/types.ts`).
 */
const CONTEXT_KEYS = ['idris2.isIdrisDocument', 'idris2.packFound', 'idris2.isIdrisWorkspace'];

/** The commands M3 contributes (ROADMAP §5 M3). */
const M3_COMMANDS = [
  'idris2.typeAtCursor',
  'idris2.docsAtCursor',
  'idris2.showDocumentation',
  'idris2.browseNamespace',
  'idris2.evaluateSelection',
  'idris2.clearEvaluationResults',
];

/** The commands M4 contributes (ROADMAP §5 M4), in the order of the editor-title submenu, then the Help group's. */
const M4_COMMANDS = [
  'idris2.caseSplit',
  'idris2.addClause',
  'idris2.makeLemma',
  'idris2.makeWith',
  'idris2.makeCase',
  'idris2.proofSearch',
  'idris2.nextResult',
  'idris2.generateDefinition',
  'idris2.nextDefinition',
  'idris2.intro',
  'idris2.refineHole',
  'idris2.addMissingCases',
  'idris2.nextHole',
  'idris2.previousHole',
  'idris2.listHoles',
  'idris2.showKeybindings',
];

/**
 * The keybinding letters and their commands (ARCHITECTURE §10's reservation table): M3 owns `t`,
 * `d`, `e`; M4 `c a l w m s n g i r [ ]` (`g` runs Generate Definition, which gives the next
 * definition when pressed again, `features/editing/types.ts`); each milestone binds only the commands
 * it registers. In the order package.json lists them.
 */
const LETTERS: Record<string, string> = {
  t: 'idris2.typeAtCursor',
  d: 'idris2.docsAtCursor',
  e: 'idris2.evaluateSelection',
  c: 'idris2.caseSplit',
  a: 'idris2.addClause',
  l: 'idris2.makeLemma',
  w: 'idris2.makeWith',
  m: 'idris2.makeCase',
  s: 'idris2.proofSearch',
  n: 'idris2.nextResult',
  g: 'idris2.generateDefinition',
  i: 'idris2.intro',
  r: 'idris2.refineHole',
  '[': 'idris2.previousHole',
  ']': 'idris2.nextHole',
};

/** The command that opens the status QuickPick; every other command but the developer ones is a menu entry. */
const STATUS_MENU_COMMAND = 'idris2.showStatusMenu';
const SUBMENU = 'idris2.editorTitle';

/** Commands for diagnosing the protocol (ROADMAP M2): category "Idris 2 (Developer)", only with the trace on. */
const DEVELOPER_COMMANDS = ['idris2.sendRawRequest'];
const DEVELOPER_WHEN = 'config.idris2.trace.protocol && isWorkspaceTrusted';

/**
 * Settings the extension never reads: VS Code reads them in the `when` clause of a contributed
 * view (`config.<key>`, M4), so core/config.ts has no accessor for them. (`idris2.keybindings.scheme`,
 * read by the keybindings' clauses, has one since M4: Show Keybindings lists the keys that are on.)
 */
const WHEN_CLAUSE_SETTINGS = ['idris2.holes.showInSideBar'];

/** Every `when` clause of a view or of a view's welcome content. */
const viewWhenClauses = (): string[] => [
  ...Object.values(manifest.contributes.views).flatMap((views) => views.map((v) => v.when ?? '')),
  ...manifest.contributes.viewsWelcome.map((w) => w.when ?? ''),
];

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
    readInlayHintSettings(reader),
    readEvaluationSettings(reader),
    readSaveBeforeAction(reader),
    readKeybindingScheme(reader),
  ];
  return { keys, settings };
}

suite('package.json (M1–M4 contributions)', () => {
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

    test('core/config.ts reads exactly the contributed keys but those only the keybindings read, and the contributed defaults read as its defaults', () => {
      const { keys, settings } = readAllSettings((key) => properties[key]?.default);
      assert.deepStrictEqual(
        [...keys].sort(),
        Object.keys(properties).filter((key) => !WHEN_CLAUSE_SETTINGS.includes(key)).sort(),
      );
      // Each of those is contributed and read by a keybinding's or a view's when clause.
      const clauses = [...manifest.contributes.keybindings.map((k) => k.when ?? ''), ...viewWhenClauses()];
      for (const key of WHEN_CLAUSE_SETTINGS) {
        assert.ok(key in properties, key);
        assert.ok(clauses.some((clause) => new RegExp(`(^| )config\\.${key.replace(/\./g, '\\.')}( |$)`).test(clause)), key);
      }
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
        { variableTypes: true },
        { inlineResults: true, timeoutMs: 10000 },
        'always',
        'auto',
      ]);
      // Every value absent (a setting VS Code does not know) reads as the same defaults — but the
      // keybinding scheme, which reads as VS Code's when clauses compare it (core/config.ts).
      assert.deepStrictEqual(readAllSettings(() => undefined).settings, [...settings.slice(0, -1), undefined]);
    });

    test('the M2 defaults are the ones ARCHITECTURE §11 and the user\'s decisions of 2026-09-27 and 2026-09-28 name', () => {
      const defaults = Object.fromEntries(
        Object.entries(properties)
          // checking.saveBeforeAction is M4's (below).
          .filter(([key]) => /^idris2\.(checking|ideMode|diagnostics|trace)\./.test(key) && key !== 'idris2.checking.saveBeforeAction')
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

    test('the M3 defaults: inlay hints for pattern-variable types and inline evaluation results on, 10 s for an evaluation, the platform\'s keybinding scheme', () => {
      const defaults = Object.fromEntries(
        Object.entries(properties)
          .filter(([key]) => /^idris2\.(inlayHints|eval|keybindings)\./.test(key))
          .map(([key, schema]) => [key, schema.default]),
      );
      assert.deepStrictEqual(defaults, {
        // On by default (ROADMAP §9, decided 2026-09-28 before M3).
        'idris2.inlayHints.variableTypes': true,
        'idris2.eval.inlineResults': true,
        // Shorter than ideMode.longActionTimeout: an evaluation that does not end grows the
        // compiler's memory fast (review of M3 [live]: 265 → 1,576 MiB in 7.0 s).
        'idris2.eval.timeout': 10000,
        // chords on macOS, prefix elsewhere (ROADMAP §9 Q5, 2026-09-28): a manifest default cannot
        // differ by platform, so `auto` stands for that choice (the keybindings suite below).
        'idris2.keybindings.scheme': 'auto',
      });
      // Multiplicity hints are out of M3's scope ([open], ROADMAP M3 *Scope*): no setting for them.
      assert.ok(!('idris2.inlayHints.multiplicities' in properties));
      assert.deepStrictEqual(properties['idris2.keybindings.scheme'].enum, ['auto', 'chords', 'prefix', 'none']);
    });

    test('the M4 defaults: save before an editing command, the Holes view shown; the long-action limit names the long M4 actions', () => {
      const saveBeforeAction = properties['idris2.checking.saveBeforeAction'];
      assert.deepStrictEqual(saveBeforeAction.enum, ['always', 'prompt', 'never']);
      // ARCHITECTURE §11: `always`, per resource like the rest of idris2.checking.*.
      assert.strictEqual(saveBeforeAction.default, 'always');
      assert.strictEqual(saveBeforeAction.scope, 'resource');
      const showInSideBar = properties['idris2.holes.showInSideBar'];
      assert.strictEqual(showInSideBar.default, true);
      assert.strictEqual(showInSideBar.scope, 'window');
      // M3 had removed them from the description, since they did not exist yet.
      assert.match(
        properties['idris2.ideMode.longActionTimeout'].markdownDescription ?? '',
        /check a file and list its holes, to search for an expression \(\*\*Idris 2: Proof Search\*\*\) or generate a definition \(\*\*Generate Definition\*\*\), to get the next result of either \(\*\*Next Result\*\*, \*\*Next Definition\*\*\), or to answer \*\*Intro\*\*, \*\*Make Lemma\*\*, \*\*Refine Hole…\*\* and \*\*Add Missing Cases\*\*/,
      );
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
      assert.strictEqual(properties['idris2.eval.timeout'].minimum, MIN_REQUEST_TIMEOUT_MS);
      assert.strictEqual(properties['idris2.ideMode.idleTimeout'].minimum, 0);
      assert.strictEqual(properties['idris2.ideMode.maxSessions'].minimum, 0);
      assert.strictEqual(properties['idris2.ideMode.maxBackgroundChecks'].minimum, 0);
      // Each window has its own extension host, pool and checks: the limits are per window (M2
      // verification of the Q20–Q22 fixes: the descriptions read as machine-wide).
      assert.match(properties['idris2.ideMode.maxSessions'].markdownDescription ?? '', /at once in this VS Code window; .* Each window counts its own/);
      assert.match(properties['idris2.ideMode.maxBackgroundChecks'].markdownDescription ?? '', /at once in this VS Code window \(each window counts its own\)/);
      // Every delay is bounded by what Node's setTimeout can wait (core/config.ts MAX_DELAY_MS).
      const delays = ['idris2.checking.delay', 'idris2.ideMode.requestTimeout', 'idris2.ideMode.longActionTimeout', 'idris2.ideMode.idleTimeout', 'idris2.eval.timeout'];
      for (const key of delays) {
        assert.strictEqual(properties[key].maximum, MAX_DELAY_MS, key);
        assert.ok((properties[key].default as number) <= MAX_DELAY_MS, key);
      }
      assert.deepStrictEqual(
        Object.keys(properties).filter((key) => properties[key].maximum !== undefined).sort(),
        [...delays].sort(),
      );
    });

    test('scopes: checking.* per resource (a folder may choose its trigger), ideMode/diagnostics/inlayHints/eval/holes per window, the transport, the trace and the keybinding scheme in user settings only (application)', () => {
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
        } else if (key === 'idris2.keybindings.scheme') {
          // User settings only: VS Code has no workspace keybindings either, and a workspace that
          // chose `chords` would take Ctrl+C (copy) in Idris editors on Linux (M3).
          assert.strictEqual(schema.scope, 'application', key);
        } else if (/^idris2\.(ideMode|diagnostics|trace|inlayHints|eval|holes)\./.test(key)) {
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

    test('the M3 commands: in the Command Palette on Idris documents, where they ask the compiler only in a trusted workspace', () => {
      const when = (command: string): string | undefined =>
        manifest.contributes.menus.commandPalette.find((entry) => entry.command === command)?.when;
      const titles = Object.fromEntries(manifest.contributes.commands.map((c) => [c.command, c.title]));
      assert.deepStrictEqual(
        M3_COMMANDS.map((id) => titles[id]),
        ['Type at Cursor', 'Docs at Cursor', 'Show Documentation…', 'Browse Namespace…', 'Evaluate Selection', 'Clear Evaluation Results'],
      );
      for (const id of M3_COMMANDS) {
        // Clearing the results shown runs nothing; the others need a session (none in Restricted Mode).
        assert.strictEqual(
          when(id),
          id === 'idris2.clearEvaluationResults' ? 'idris2.isIdrisDocument' : 'idris2.isIdrisDocument && isWorkspaceTrusted',
          id,
        );
      }
    });

    test('the M4 commands: in the Command Palette on Idris documents, those that ask the compiler only in a trusted workspace; Show Keybindings everywhere', () => {
      const when = (command: string): string | undefined =>
        manifest.contributes.menus.commandPalette.find((entry) => entry.command === command)?.when;
      const titles = Object.fromEntries(manifest.contributes.commands.map((c) => [c.command, c.title]));
      assert.deepStrictEqual(
        M4_COMMANDS.map((id) => titles[id]),
        [
          'Case Split',
          'Add Clause',
          'Make Lemma',
          'Make With',
          'Make Case',
          'Proof Search',
          'Next Result',
          'Generate Definition',
          'Next Definition',
          'Intro',
          'Refine Hole…',
          'Add Missing Cases',
          'Next Hole',
          'Previous Hole',
          'List Holes',
          'Show Keybindings',
        ],
      );
      // Show Keybindings runs nothing; Next and Previous Hole move between the `?name` tokens of the
      // text (features/holes/types.ts); the others need the compiler (none in Restricted Mode).
      const noCompiler: Record<string, string | undefined> = {
        'idris2.showKeybindings': undefined,
        'idris2.nextHole': 'idris2.isIdrisDocument',
        'idris2.previousHole': 'idris2.isIdrisDocument',
      };
      for (const id of M4_COMMANDS) {
        assert.strictEqual(when(id), id in noCompiler ? noCompiler[id] : 'idris2.isIdrisDocument && isWorkspaceTrusted', id);
      }
      // In the submenu (and so the status QuickPick): the editing commands after the M3 ones, the
      // hole commands after them, Show Keybindings in the Help group.
      const groups = Object.fromEntries(manifest.contributes.menus[SUBMENU].map((e) => [e.command, e.group]));
      assert.deepStrictEqual(
        M4_COMMANDS.map((id) => groups[id]),
        [
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `0_interactive@${n}`),
          ...[1, 2, 3].map((n) => `0_interactive_holes@${n}`),
          '3_help@4',
        ],
      );
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
        ...manifest.contributes.keybindings.map((k) => [`keybinding ${k.key} of ${k.command}`, k.when ?? ''] as const),
        ...viewWhenClauses().map((clause) => ['a view', clause] as const),
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

  suite('views (M4; ARCHITECTURE §9)', () => {
    test('the "Idris 2" activity-bar container holds the Holes view, shown by its setting in a window where Idris is used', () => {
      assert.deepStrictEqual(manifest.contributes.viewsContainers, {
        // A codicon: VS Code 1.139.1 reads a container's icon with ThemeIcon.fromString before
        // taking it as a path [src: `registerCustomViewContainers` in its workbench bundle].
        activitybar: [{ id: 'idris2', title: 'Idris 2', icon: '$(question)' }],
      });
      assert.deepStrictEqual(manifest.contributes.views, {
        idris2: [
          {
            id: 'idris2.holes',
            name: 'Holes',
            icon: '$(question)',
            contextualTitle: 'Idris 2',
            when: 'config.idris2.holes.showInSideBar && idris2.isIdrisWorkspace',
          },
        ],
      });
    });

    test('the Holes view says why it is empty: no holes, or Restricted Mode, where the compiler does not run', () => {
      const welcome = manifest.contributes.viewsWelcome;
      assert.deepStrictEqual(welcome.map((w) => [w.view, w.when]), [
        ['idris2.holes', 'isWorkspaceTrusted'],
        ['idris2.holes', '!isWorkspaceTrusted'],
      ]);
      // Static text: no links (welcome content turns `[label](command:…)` into a button).
      for (const w of welcome) {
        assert.ok(!w.contents.includes(']('), w.contents);
      }
    });
  });

  suite('keybindings (M3, M4; ROADMAP §9 Q5, ARCHITECTURE §10)', () => {
    const bindings = manifest.contributes.keybindings;
    const whenFor = (scheme: string): string =>
      `editorTextFocus && idris2.isIdrisDocument && config.idris2.keybindings.scheme == '${scheme}'`;

    /** The key sequence VS Code uses on `platform` (the `mac`/`linux` field if present, else `key`). */
    const keyOn = (binding: Keybinding, platform: 'mac' | 'linux'): string => binding[platform] ?? binding.key;

    test('exactly the letters of M3 and M4 are bound, each to its command, under each scheme but none', () => {
      const schemes = properties['idris2.keybindings.scheme'].enum ?? [];
      const bound = schemes.filter((scheme) => scheme !== 'none');
      assert.deepStrictEqual(bound, ['auto', 'chords', 'prefix']);
      const expected: Keybinding[] = [];
      for (const [letter, command] of Object.entries(LETTERS)) {
        expected.push({ command, key: `ctrl+c ctrl+${letter}`, when: whenFor('chords') });
        expected.push({ command, key: `ctrl+alt+i ${letter}`, when: whenFor('prefix') });
        // auto: chords on macOS, prefix elsewhere — a manifest default cannot differ by platform,
        // but a keybinding's `mac` key can.
        expected.push({ command, key: `ctrl+alt+i ${letter}`, mac: `ctrl+c ctrl+${letter}`, when: whenFor('auto') });
      }
      assert.deepStrictEqual(bindings, expected);
      // ARCHITECTURE §10's table: 3 letters of M3, 12 of M4 (M7's `,` is not bound before M7).
      assert.deepStrictEqual(Object.keys(LETTERS).join(''), 'tdecalwmsngir[]');
    });

    test('with the scheme none nothing is bound: every binding requires one of the other schemes', () => {
      for (const binding of bindings) {
        const scheme = /config\.idris2\.keybindings\.scheme == '([a-z]+)'$/.exec(binding.when ?? '')?.[1];
        assert.ok(scheme !== undefined && scheme !== 'none', `${binding.key}: ${binding.when}`);
        // Only in an Idris editor with the text focus (ARCHITECTURE §10), never through `||`.
        assert.ok((binding.when ?? '').startsWith('editorTextFocus && idris2.isIdrisDocument && '), binding.key);
        assert.ok(!(binding.when ?? '').includes('||'), binding.key);
      }
    });

    test('auto resolves to the chords on macOS and to the prefix on Linux, as chords and prefix do on every platform', () => {
      const keys = (scheme: string, platform: 'mac' | 'linux'): string[] =>
        bindings.filter((b) => b.when === whenFor(scheme)).map((b) => keyOn(b, platform));
      assert.deepStrictEqual(keys('auto', 'mac'), keys('chords', 'mac'));
      assert.deepStrictEqual(keys('auto', 'linux'), keys('prefix', 'linux'));
      assert.deepStrictEqual(
        keys('chords', 'linux'),
        Object.keys(LETTERS).map((letter) => `ctrl+c ctrl+${letter}`),
      );
      assert.deepStrictEqual(
        keys('prefix', 'mac'),
        Object.keys(LETTERS).map((letter) => `ctrl+alt+i ${letter}`),
      );
    });

    test('every bound command is a contributed M3 or M4 command, and each command has at most one letter', () => {
      for (const binding of bindings) {
        assert.ok(commandIds.includes(binding.command), binding.command);
        assert.ok(M3_COMMANDS.includes(binding.command) || M4_COMMANDS.includes(binding.command), binding.command);
      }
      const commands = Object.values(LETTERS);
      assert.strictEqual(new Set(commands).size, commands.length);
    });

    test('the setting\'s descriptions name the collisions with VS Code\'s default keys (Ctrl+C copy, Ctrl+Alt+I chat)', () => {
      // VS Code 1.139.1's default keymap [src: `workbench.desktop.main.js` of 1.139.1, whose
      // keybindings are numbers (KeyMod CtrlCmd 2048, Alt 512, WinCtrl 256; KeyC 33, KeyI 39), read
      // for every `primary`/`secondary` whose first chord is one of these keys, and the
      // `contributes.keybindings` of its 97 built-in extensions, 2026-09-29]: ctrl+c (2081) is copy
      // on Linux and Windows (`editor.action.clipboardCopyAction` and others); ctrl+alt+i (2599) is
      // Open Chat there (`workbench.action.chat.open`, weight 200, no when clause; ctrl+cmd+i on
      // macOS); on macOS Control+C (289) is bound only in the terminal, Control+Option+I (807) not at
      // all, and no default chord starts with any of the four. The resolver takes the last binding
      // of a first chord whose when clause holds and waits for a second key if that is a chord
      // (`resolve`/`_findCommand`, same bundle), bindings being sorted by weight (`cDo`), and an
      // extension's binding weighs 400 plus its index (`_asCommandRule`) against 100 for the editor's
      // copy and 200 for Open Chat, so each scheme takes its first key in Idris editors with the text
      // focus. M4's letters are second keys after the same first keys, so they add no collision with
      // a default binding (the scan was repeated on 2026-09-30 for M4 and found no default chord
      // starting with either first key; `ctrl+[`/`ctrl+]` alone stay Outdent/Indent Line on Linux).
      const schema = properties['idris2.keybindings.scheme'];
      assert.match(schema.markdownEnumDescriptions?.[1] ?? '', /On Linux and Windows, `Ctrl\+C` then starts a shortcut in Idris editors and no longer copies there\./);
      assert.match(schema.markdownEnumDescriptions?.[2] ?? '', /On Linux and Windows, `Ctrl\+Alt\+I` then starts a shortcut in Idris editors and no longer opens the Chat view there\./);
      assert.match(schema.markdownDescription ?? '', /Read from your user settings only/);
      // The keys themselves are listed by Show Keybindings, not in the description.
      assert.match(schema.markdownDescription ?? '', /\*\*Idris 2: Show Keybindings\*\* lists them/);
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
