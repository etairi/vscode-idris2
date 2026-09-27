import * as assert from 'assert';
// Type-only: erased from the compiled test, which therefore does not load `vscode`.
import type * as vscode from 'vscode';
import * as path from 'path';
import {
  Config,
  expandHome,
  readToolchainSettings,
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
  change(affected: readonly string[]): void;
} {
  const sections: string[] = [];
  const listeners = new Set<(e: ConfigurationChange) => unknown>();
  const host: ConfigurationHost = {
    getConfiguration: (name) => {
      sections.push(name);
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
  return { host, sections, change };
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
