import * as assert from 'assert';
// Type-only: erased from the compiled test, which therefore does not load `vscode`.
import type * as vscode from 'vscode';
import * as path from 'path';
import {
  Config,
  expandHome,
  MAX_DELAY_MS,
  readCheckingSettings,
  readDiagnosticsSettings,
  readEvaluationSettings,
  readIdeModeSettings,
  readInlayHintSettings,
  readKeybindingScheme,
  readSaveBeforeAction,
  readToolchainSettings,
  readTraceSettings,
  usableHomeDirectory,
  type ConfigurationChange,
  type ConfigurationHost,
  type ConfigurationReader,
} from '../../src/core/config';

const HOME = '/home/u';

/** A section whose `get` answers from `values` (keys relative to `idris2.`). */
function section(values: Record<string, unknown>): ConfigurationReader {
  return { get: (key) => values[key] };
}

/** A host with one `idris2` section and a change event the test fires by hand. */
function fakeHost(values: Record<string, unknown>): {
  host: ConfigurationHost;
  sections: string[];
  scopes: unknown[];
  change(affected: readonly string[]): void;
} {
  const sections: string[] = [];
  const scopes: unknown[] = [];
  const listeners = new Set<(e: ConfigurationChange) => unknown>();
  const host: ConfigurationHost = {
    getConfiguration: (name, scope) => {
      sections.push(name);
      scopes.push(scope);
      return section(values);
    },
    onDidChangeConfiguration: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const change = (affected: readonly string[]): void => {
    // VS Code's affectsConfiguration is true for the changed key and each of its ancestors.
    const event: ConfigurationChange = {
      affectsConfiguration: (s) => affected.some((key) => key === s || key.startsWith(`${s}.`)),
    };
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  return { host, sections, scopes, change };
}

suite('core/config', () => {
  suite('expandHome', () => {
    test('a leading ~ alone or before a separator is the home directory', () => {
      assert.strictEqual(expandHome('~', HOME), HOME);
      assert.strictEqual(expandHome('~/bin/idris2', HOME), `${HOME}/bin/idris2`);
      assert.strictEqual(expandHome('~\\bin\\idris2.exe', 'C:\\Users\\u'), 'C:\\Users\\u\\bin\\idris2.exe');
    });

    test('without a home directory nothing is expanded: an empty or relative HOME is no home', () => {
      assert.strictEqual(usableHomeDirectory(''), undefined);
      assert.strictEqual(usableHomeDirectory('relative/home'), undefined);
      assert.strictEqual(usableHomeDirectory(path.resolve('/home/u')), path.resolve('/home/u'));
      // With HOME='' os.homedir() returns '', and '~/bin/idris2' must not become '/bin/idris2'.
      assert.strictEqual(expandHome('~/bin/idris2', usableHomeDirectory('')), '~/bin/idris2');
      assert.strictEqual(readToolchainSettings(section({ 'toolchain.idris2Path': '~/bin/idris2' }), undefined).idris2Path, '~/bin/idris2');
    });

    test('~user, a ~ elsewhere and plain paths are left alone', () => {
      assert.strictEqual(expandHome('~other/bin/idris2', HOME), '~other/bin/idris2');
      assert.strictEqual(expandHome('/opt/~/idris2', HOME), '/opt/~/idris2');
      assert.strictEqual(expandHome('idris2', HOME), 'idris2');
      assert.strictEqual(expandHome('', HOME), '');
    });
  });

  suite('readToolchainSettings', () => {
    test('the contributed defaults read as "discover everything, no environment"', () => {
      const settings = readToolchainSettings(
        section({
          'toolchain.idris2Path': '',
          'toolchain.lspPath': '',
          'toolchain.packPath': '',
          'toolchain.preferPack': false,
          'toolchain.env': {},
        }),
        HOME,
      );
      assert.deepStrictEqual(settings, {
        idris2Path: '',
        lspPath: '',
        packPath: '',
        preferPack: false,
        env: {},
        ignoredEnvEntries: [],
      });
    });

    test('paths are trimmed and ~-expanded; each path setting is read from its own key', () => {
      const settings = readToolchainSettings(
        section({
          'toolchain.idris2Path': '  ~/.idris2/bin/idris2 ',
          'toolchain.lspPath': '/opt/lsp/idris2-lsp',
          'toolchain.packPath': 'pack',
          'toolchain.preferPack': true,
        }),
        HOME,
      );
      assert.strictEqual(settings.idris2Path, `${HOME}/.idris2/bin/idris2`);
      assert.strictEqual(settings.lspPath, '/opt/lsp/idris2-lsp');
      assert.strictEqual(settings.packPath, 'pack');
      assert.strictEqual(settings.preferPack, true);
    });

    test('one pair of surrounding double quotes is removed (Explorer\'s "Copy as path"), after trimming, before ~', () => {
      const read = (value: string): string => readToolchainSettings(section({ 'toolchain.idris2Path': value }), HOME).idris2Path;
      assert.strictEqual(read('"C:\\tools\\idris2.exe"'), 'C:\\tools\\idris2.exe');
      assert.strictEqual(read('  "C:\\Program Files\\Idris2\\idris2.exe" '), 'C:\\Program Files\\Idris2\\idris2.exe');
      assert.strictEqual(read('"~/bin/idris2"'), `${HOME}/bin/idris2`);
      assert.strictEqual(read('""/x/idris2""'), '"/x/idris2"', 'only one pair');
      assert.strictEqual(read('"/x/idris2'), '"/x/idris2', 'an unpaired quote stays');
      assert.strictEqual(read('"'), '"');
      assert.strictEqual(read('""'), '');
    });

    test('values of the wrong type read as the defaults', () => {
      const settings = readToolchainSettings(
        section({
          'toolchain.idris2Path': 42,
          'toolchain.lspPath': null,
          'toolchain.packPath': ['pack'],
          'toolchain.preferPack': 'true',
          'toolchain.env': ['A=1'],
        }),
        HOME,
      );
      assert.deepStrictEqual(settings, {
        idris2Path: '',
        lspPath: '',
        packPath: '',
        preferPack: false,
        env: {},
        ignoredEnvEntries: [],
      });
      for (const env of [null, 'A=1', 7, undefined]) {
        assert.deepStrictEqual(readToolchainSettings(section({ 'toolchain.env': env }), HOME).env, {});
      }
    });

    test('env keeps string entries verbatim and lists every entry a process cannot take', () => {
      const settings = readToolchainSettings(
        section({
          'toolchain.env': {
            IDRIS2_PREFIX: '~/.idris2',
            EMPTY: '',
            N: 1,
            Z: null,
            '': 'x',
            'A=B': 'c',
            NUL: 'a\0b',
          },
        }),
        HOME,
      );
      assert.deepStrictEqual(settings.env, { IDRIS2_PREFIX: '~/.idris2', EMPTY: '' });
      assert.deepStrictEqual(settings.ignoredEnvEntries, [
        { key: 'N', reason: 'the value is number, not a string' },
        { key: 'Z', reason: 'the value is null, not a string' },
        { key: '', reason: 'the name is empty' },
        { key: 'A=B', reason: 'the name contains "="' },
        { key: 'NUL', reason: 'the name or value contains a NUL character' },
      ]);
    });
  });

  suite('M2 settings (checking, ideMode, diagnostics, trace)', () => {
    test('valid values are read as written', () => {
      assert.deepStrictEqual(
        readCheckingSettings(section({ 'checking.trigger': 'afterDelay', 'checking.delay': 1500 })),
        { trigger: 'afterDelay', delayMs: 1500 },
      );
      assert.deepStrictEqual(
        readIdeModeSettings(
          section({
            'ideMode.transport': 'stdio',
            'ideMode.isolateBuildDir': false,
            'ideMode.loosePackages': ['contrib', 'network'],
            'ideMode.extraArgs': ['--log', '1'],
            'ideMode.requestTimeout': 2000,
            'ideMode.longActionTimeout': 120000,
            'ideMode.idleTimeout': 0,
            'ideMode.maxSessions': 3,
            'ideMode.maxBackgroundChecks': 1,
          }),
        ),
        {
          transport: 'stdio',
          isolateBuildDir: false,
          loosePackages: ['contrib', 'network'],
          extraArgs: ['--log', '1'],
          requestTimeoutMs: 2000,
          longActionTimeoutMs: 120000,
          idleTimeoutMs: 0,
          maxSessions: 3,
          maxBackgroundChecks: 1,
        },
      );
      assert.deepStrictEqual(readDiagnosticsSettings(section({ 'diagnostics.includeSourceExcerpt': true })), {
        includeSourceExcerpt: true,
      });
      assert.deepStrictEqual(readTraceSettings(section({ 'trace.protocol': true })), { protocol: true });
    });

    test('an unknown enum value or a value of the wrong type reads as the default', () => {
      for (const trigger of ['onType', 'ONSAVE', 7, null, ['manual']]) {
        assert.strictEqual(readCheckingSettings(section({ 'checking.trigger': trigger })).trigger, 'onSave', String(trigger));
      }
      for (const transport of ['tcp', 'Socket', true, {}]) {
        assert.strictEqual(readIdeModeSettings(section({ 'ideMode.transport': transport })).transport, 'stdio');
      }
      for (const delay of ['700', null, Number.NaN, Number.POSITIVE_INFINITY, [700]]) {
        assert.strictEqual(readCheckingSettings(section({ 'checking.delay': delay })).delayMs, 700, String(delay));
      }
      const ide = readIdeModeSettings(
        section({
          'ideMode.isolateBuildDir': 'false',
          'ideMode.loosePackages': 'contrib',
          'ideMode.extraArgs': { a: 1 },
          'ideMode.requestTimeout': '5',
          'ideMode.longActionTimeout': null,
          'ideMode.idleTimeout': Number.NaN,
          'ideMode.maxSessions': '3',
          'ideMode.maxBackgroundChecks': Number.POSITIVE_INFINITY,
        }),
      );
      assert.deepStrictEqual(ide, {
        transport: 'stdio',
        isolateBuildDir: true,
        loosePackages: [],
        extraArgs: [],
        requestTimeoutMs: 5000,
        longActionTimeoutMs: 60000,
        idleTimeoutMs: 600000,
        maxSessions: 0,
        maxBackgroundChecks: 0,
      });
      assert.strictEqual(readDiagnosticsSettings(section({ 'diagnostics.includeSourceExcerpt': 'yes' })).includeSourceExcerpt, false);
      assert.strictEqual(readTraceSettings(section({ 'trace.protocol': 1 })).protocol, false);
    });

    test('a number below the minimum the schema declares reads as that minimum', () => {
      assert.strictEqual(readCheckingSettings(section({ 'checking.delay': 5 })).delayMs, 100);
      const ide = readIdeModeSettings(
        section({ 'ideMode.requestTimeout': 0, 'ideMode.longActionTimeout': -1, 'ideMode.idleTimeout': -60000 }),
      );
      assert.strictEqual(ide.requestTimeoutMs, 1000);
      assert.strictEqual(ide.longActionTimeoutMs, 1000);
      assert.strictEqual(ide.idleTimeoutMs, 0);
    });

    test('a delay above 2^31 - 1 ms (which setTimeout would run after 1 ms) reads as 2^31 - 1', () => {
      assert.strictEqual(MAX_DELAY_MS, 2147483647);
      assert.strictEqual(readCheckingSettings(section({ 'checking.delay': 2 ** 31 })).delayMs, MAX_DELAY_MS);
      const ide = readIdeModeSettings(
        section({ 'ideMode.requestTimeout': 2 ** 31, 'ideMode.longActionTimeout': 1e12, 'ideMode.idleTimeout': Number.MAX_SAFE_INTEGER }),
      );
      assert.strictEqual(ide.requestTimeoutMs, MAX_DELAY_MS);
      assert.strictEqual(ide.longActionTimeoutMs, MAX_DELAY_MS);
      assert.strictEqual(ide.idleTimeoutMs, MAX_DELAY_MS);
      assert.strictEqual(readIdeModeSettings(section({ 'ideMode.longActionTimeout': MAX_DELAY_MS })).longActionTimeoutMs, MAX_DELAY_MS);
    });

    test('list settings keep their string entries in order: package names only when non-empty', () => {
      const ide = readIdeModeSettings(
        section({
          'ideMode.loosePackages': ['contrib', '', 3, null, 'network'],
          'ideMode.extraArgs': ['--log', '', 5, '1'],
        }),
      );
      assert.deepStrictEqual(ide.loosePackages, ['contrib', 'network']);
      assert.deepStrictEqual(ide.extraArgs, ['--log', '', '1']);
    });

    test('Q20: the transport is stdio unless socket is written; the former default "auto" reads as stdio, "socket" is kept', () => {
      // Decided by the user on 2026-09-28 (ROADMAP §9 Q20): stdio on every platform, the socket
      // only as an explicit opt-in. `auto` (socket on macOS and Linux until then) is no longer
      // offered; a settings.json that still has it gets the new default.
      assert.strictEqual(readIdeModeSettings(section({})).transport, 'stdio');
      assert.strictEqual(readIdeModeSettings(section({ 'ideMode.transport': 'auto' })).transport, 'stdio');
      assert.strictEqual(readIdeModeSettings(section({ 'ideMode.transport': 'stdio' })).transport, 'stdio');
      assert.strictEqual(readIdeModeSettings(section({ 'ideMode.transport': 'socket' })).transport, 'socket');
    });

    test('Q21: maxSessions and maxBackgroundChecks are 0 (no limit) unless set; a fraction is rounded down, a negative number is 0', () => {
      assert.deepStrictEqual(
        [readIdeModeSettings(section({})).maxSessions, readIdeModeSettings(section({})).maxBackgroundChecks],
        [0, 0],
      );
      for (const [value, read] of [
        [2, 2],
        [2.9, 2],
        [0, 0],
        [-1, 0],
        [0.5, 0],
        [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        [null, 0],
        ['2', 0],
        [Number.NaN, 0],
        [Number.NEGATIVE_INFINITY, 0],
      ] as const) {
        const ide = readIdeModeSettings(section({ 'ideMode.maxSessions': value, 'ideMode.maxBackgroundChecks': value }));
        assert.deepStrictEqual([ide.maxSessions, ide.maxBackgroundChecks], [read, read], String(value));
      }
    });
  });

  suite('M3 settings (inlayHints, eval)', () => {
    test('both are on unless false is written; a value of the wrong type reads as the default (on)', () => {
      assert.deepStrictEqual(readInlayHintSettings(section({})), { variableTypes: true });
      assert.deepStrictEqual(readEvaluationSettings(section({})), { inlineResults: true, timeoutMs: 10000 });
      assert.deepStrictEqual(readInlayHintSettings(section({ 'inlayHints.variableTypes': false })), { variableTypes: false });
      assert.deepStrictEqual(readEvaluationSettings(section({ 'eval.inlineResults': false })), { inlineResults: false, timeoutMs: 10000 });
      for (const value of ['false', 0, null, [], {}, true]) {
        assert.strictEqual(readInlayHintSettings(section({ 'inlayHints.variableTypes': value })).variableTypes, true, String(value));
        assert.strictEqual(readEvaluationSettings(section({ 'eval.inlineResults': value })).inlineResults, true, String(value));
      }
    });

    test('eval.timeout: from 1000 ms to MAX_DELAY_MS; outside reads as the nearer bound, anything else as 10000', () => {
      const timeout = (value: unknown) => readEvaluationSettings(section({ 'eval.timeout': value })).timeoutMs;
      assert.strictEqual(timeout(2500), 2500);
      assert.strictEqual(timeout(0), 1000);
      assert.strictEqual(timeout(2 ** 31), MAX_DELAY_MS);
      for (const value of ['5000', null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
        assert.strictEqual(timeout(value), 10000, String(value));
      }
    });

    test('Config reads them from the idris2 section afresh, and onDidChange fires for their groups only', () => {
      const values: Record<string, unknown> = { 'inlayHints.variableTypes': false };
      const { host, sections, change } = fakeHost(values);
      const config = new Config(host, HOME);
      assert.strictEqual(config.inlayHints().variableTypes, false);
      values['inlayHints.variableTypes'] = true;
      assert.strictEqual(config.inlayHints().variableTypes, true);
      assert.strictEqual(config.evaluation().inlineResults, true);
      assert.deepStrictEqual(sections, ['idris2', 'idris2', 'idris2']);
      const calls: string[] = [];
      for (const group of ['inlayHints', 'eval'] as const) {
        config.onDidChange(group, () => calls.push(group));
      }
      change(['idris2.inlayHints.variableTypes']);
      change(['idris2.eval.inlineResults']);
      change(['idris2.keybindings.scheme']);
      change(['idris2.evalX']);
      assert.deepStrictEqual(calls, ['inlayHints', 'eval']);
    });
  });

  suite('M4 settings (checking.saveBeforeAction)', () => {
    test('always, prompt or never as written; anything else reads as the default, always', () => {
      assert.strictEqual(readSaveBeforeAction(section({})), 'always');
      for (const value of ['always', 'prompt', 'never'] as const) {
        assert.strictEqual(readSaveBeforeAction(section({ 'checking.saveBeforeAction': value })), value);
      }
      for (const value of ['Never', 'ask', '', true, 0, null, ['never'], {}]) {
        assert.strictEqual(readSaveBeforeAction(section({ 'checking.saveBeforeAction': value })), 'always', String(value));
      }
    });

    test('Config.saveBeforeAction(scope) reads the resource-scoped section for the scope, afresh; a change fires the checking group', () => {
      const values: Record<string, unknown> = { 'checking.saveBeforeAction': 'never' };
      const { host, sections, scopes, change } = fakeHost(values);
      const config = new Config(host, HOME);
      const uri = { scheme: 'file', path: '/w/A.idr' } as unknown as vscode.Uri;
      assert.strictEqual(config.saveBeforeAction(uri), 'never');
      values['checking.saveBeforeAction'] = 'prompt';
      assert.strictEqual(config.saveBeforeAction(), 'prompt');
      assert.deepStrictEqual(sections, ['idris2', 'idris2']);
      assert.deepStrictEqual(scopes, [uri, undefined]);
      const calls: string[] = [];
      config.onDidChange('checking', (c) => calls.push(String(c.affects('checking.saveBeforeAction'))));
      change(['idris2.checking.saveBeforeAction']);
      assert.deepStrictEqual(calls, ['true']);
    });
  });

  suite('keybindings.scheme (read for Show Keybindings, M4)', () => {
    test('the four schemes as written; the value as a when clause compares it with ==, anything else no scheme', () => {
      for (const value of ['auto', 'chords', 'prefix', 'none'] as const) {
        assert.strictEqual(readKeybindingScheme(section({ 'keybindings.scheme': value })), value);
      }
      // `config.idris2.keybindings.scheme == 'auto'` holds for a list whose text is `auto` [src: VS
      // Code 1.139.1 ContextKeyEqualsExpr.evaluate uses ==].
      assert.strictEqual(readKeybindingScheme(section({ 'keybindings.scheme': ['auto'] })), 'auto');
      assert.strictEqual(readKeybindingScheme(section({ 'keybindings.scheme': [['prefix']] })), 'prefix');
      // No binding's clause holds for these: nothing is on.
      for (const value of [undefined, 'Auto', 'emacs', '', 0, true, null, {}, ['auto', 'none']]) {
        assert.strictEqual(readKeybindingScheme(section({ 'keybindings.scheme': value })), undefined, String(value));
      }
      // The loose comparison itself, which the reader mirrors.
      // eslint-disable-next-line eqeqeq
      assert.ok((['auto'] as unknown) == 'auto' && !((['auto', 'none'] as unknown) == 'auto'));
    });

    test('Config.keybindingScheme reads the window\'s value afresh; a change fires the keybindings group', () => {
      const values: Record<string, unknown> = { 'keybindings.scheme': 'prefix' };
      const { host, scopes, change } = fakeHost(values);
      const config = new Config(host, HOME);
      assert.strictEqual(config.keybindingScheme(), 'prefix');
      values['keybindings.scheme'] = 'none';
      assert.strictEqual(config.keybindingScheme(), 'none');
      assert.deepStrictEqual(scopes, [undefined, undefined]);
      const calls: string[] = [];
      config.onDidChange('keybindings', () => calls.push('keybindings'));
      change(['idris2.keybindings.scheme']);
      change(['idris2.eval.timeout']);
      assert.deepStrictEqual(calls, ['keybindings']);
    });
  });

  suite('Config', () => {
    test('vscode.workspace is a ConfigurationHost (a compile-time check)', () => {
      const asHost = (workspace: typeof vscode.workspace): ConfigurationHost => workspace;
      assert.strictEqual(typeof asHost, 'function');
    });

    test('toolchain() reads the idris2 section afresh on every call', () => {
      const values: Record<string, unknown> = { 'toolchain.idris2Path': '/a/idris2' };
      const { host, sections } = fakeHost(values);
      const config = new Config(host, HOME);
      assert.strictEqual(config.toolchain().idris2Path, '/a/idris2');
      values['toolchain.idris2Path'] = '/b/idris2';
      assert.strictEqual(config.toolchain().idris2Path, '/b/idris2');
      assert.deepStrictEqual(sections, ['idris2', 'idris2']);
    });

    test('checking(scope) reads the resource-scoped section for the scope; the other groups read the window\'s', () => {
      const values: Record<string, unknown> = { 'checking.trigger': 'manual', 'ideMode.transport': 'socket', 'trace.protocol': true };
      const { host, sections, scopes } = fakeHost(values);
      const config = new Config(host, HOME);
      const uri = { scheme: 'file', path: '/w/A.idr' } as unknown as vscode.Uri;
      assert.strictEqual(config.checking(uri).trigger, 'manual');
      assert.strictEqual(config.checking().trigger, 'manual');
      assert.strictEqual(config.ideMode().transport, 'socket');
      assert.strictEqual(config.diagnostics().includeSourceExcerpt, false);
      assert.strictEqual(config.trace().protocol, true);
      assert.deepStrictEqual(sections, ['idris2', 'idris2', 'idris2', 'idris2', 'idris2']);
      assert.deepStrictEqual(scopes, [uri, undefined, undefined, undefined, undefined]);
    });

    test('onDidChange fires per group: ideMode, checking, diagnostics and trace each for their own keys', () => {
      const { host, change } = fakeHost({});
      const config = new Config(host, HOME);
      const calls: string[] = [];
      for (const group of ['ideMode', 'checking', 'diagnostics', 'trace'] as const) {
        config.onDidChange(group, () => calls.push(group));
      }
      change(['idris2.ideMode.transport']);
      change(['idris2.checking.delay']);
      change(['idris2.diagnostics.includeSourceExcerpt']);
      change(['idris2.trace.protocol']);
      change(['idris2.toolchain.env']);
      change(['idris2.ideModeX']);
      assert.deepStrictEqual(calls, ['ideMode', 'checking', 'diagnostics', 'trace']);
    });

    test('onDidChange tells its listener which settings changed (keys relative to idris2.)', () => {
      const { host, change } = fakeHost({});
      const config = new Config(host, HOME);
      const seen: string[][] = [];
      const keys = ['ideMode.transport', 'ideMode.maxSessions', 'ideMode.maxBackgroundChecks', 'ideMode'];
      config.onDidChange('ideMode', (settings) => seen.push(keys.filter((key) => settings.affects(key))));
      change(['idris2.ideMode.maxSessions']);
      change(['idris2.ideMode.transport', 'idris2.ideMode.maxBackgroundChecks']);
      assert.deepStrictEqual(seen, [
        ['ideMode.maxSessions', 'ideMode'],
        ['ideMode.transport', 'ideMode.maxBackgroundChecks', 'ideMode'],
      ]);
    });

    test('onDidChange("toolchain") fires for idris2.toolchain.* only, until disposed', () => {
      const { host, change } = fakeHost({});
      const config = new Config(host, HOME);
      let calls = 0;
      const subscription = config.onDidChange('toolchain', () => calls++);
      change(['idris2.toolchain.idris2Path']);
      change(['idris2.toolchain.env']);
      change(['idris2.toolchainX']);
      change(['idris2.checking.trigger']);
      change(['editor.tabSize']);
      assert.strictEqual(calls, 2);
      subscription.dispose();
      change(['idris2.toolchain.lspPath']);
      assert.strictEqual(calls, 2);
    });
  });
});
