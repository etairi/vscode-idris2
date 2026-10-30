// features/backend/migration.ts: the copy of bamboo's idris2-lsp.* settings (ROADMAP M5, F36). The
// key map is checked key by key, against bamboo's keys and against this extension's manifest.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BAMBOO_KEY_MAP, planMigration, type FoundValue } from '../../src/features/backend/migration';

function repoRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate) && (JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string }).name === 'idris2-language-tools') {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no idris2-language-tools package.json above ${__dirname}`);
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { scope?: string; type?: string; enum?: string[] }> } | { properties: Record<string, { scope?: string; type?: string; enum?: string[] }> }[] };
};
const configuration = manifest.contributes.configuration;
const PROPERTIES = Array.isArray(configuration) ? Object.assign({}, ...configuration.map((c) => c.properties)) as Record<string, { scope?: string; type?: string; enum?: string[] }> : configuration.properties;

/**
 * bamboo's settings, as its package.json 0.7.2 contributes them (bamboo/idris2-lsp-vscode at
 * 1e93392, fetched 2026-10-01; ROADMAP F36), with their types.
 */
const BAMBOO_KEYS = [
  'path',
  'loglevel',
  'logFile',
  'longActionTimeout',
  'maxCodeActionResults',
  'showImplicits',
  'showMachineNames',
  'fullNamespace',
  'briefCompletions',
  'trace.server',
];

/** One value set by the user in `target`, whose target key is not set there. */
function found(from: string, value: unknown, target: FoundValue['target'] = 'global', existing?: unknown, folder?: string): FoundValue {
  return { from, target, value, existing, ...(folder === undefined ? {} : { folder }) };
}

function copyOf(from: string, value: unknown): unknown {
  const plan = planMigration([found(from, value)]);
  assert.strictEqual(plan.copies.length + plan.skipped.length, 1, JSON.stringify(plan));
  return plan.copies[0]?.value;
}

suite('features/backend/migration (bamboo\'s settings)', () => {
  test('the key map, key by key (F36): loglevel → logSeverity, the seven options 1:1, path → toolchain.lspPath, trace.server', () => {
    assert.deepStrictEqual(
      BAMBOO_KEY_MAP.map((k) => [k.from, k.to]),
      [
        ['loglevel', 'idris2.lsp.logSeverity'],
        ['logFile', 'idris2.lsp.logFile'],
        ['longActionTimeout', 'idris2.lsp.longActionTimeout'],
        ['maxCodeActionResults', 'idris2.lsp.maxCodeActionResults'],
        ['showImplicits', 'idris2.lsp.showImplicits'],
        ['showMachineNames', 'idris2.lsp.showMachineNames'],
        ['fullNamespace', 'idris2.lsp.fullNamespace'],
        ['briefCompletions', 'idris2.lsp.briefCompletions'],
        ['path', 'idris2.toolchain.lspPath'],
        ['trace.server', 'idris2.lsp.trace.server'],
      ],
    );
    assert.deepStrictEqual([...BAMBOO_KEY_MAP.map((k) => k.from)].sort(), [...BAMBOO_KEYS].sort(), 'every key bamboo contributes, once');
  });

  test('every target is a setting of this extension, and "folder-scoped" is exactly what its manifest scope allows', () => {
    for (const key of BAMBOO_KEY_MAP) {
      const property = PROPERTIES[key.to];
      assert.ok(property !== undefined, `${key.to} is contributed`);
      // VS Code writes a folder's value only for scopes resource, language-overridable, machine-overridable.
      const folder = ['resource', 'language-overridable', 'machine-overridable'].includes(property.scope ?? 'window');
      assert.strictEqual(key.folderScoped, folder, key.to);
    }
  });

  test('values are copied as this extension reads them', () => {
    assert.strictEqual(copyOf('loglevel', 'warning'), 'warning');
    assert.strictEqual(copyOf('loglevel', 'Error'), 'error', 'the server upper-cases it anyway');
    assert.strictEqual(copyOf('logFile', '/tmp/lsp.log'), '/tmp/lsp.log');
    assert.strictEqual(copyOf('logFile', '~/lsp.log'), '~/lsp.log');
    assert.strictEqual(copyOf('longActionTimeout', 5000), 5000);
    assert.strictEqual(copyOf('longActionTimeout', 1500.7), 1500);
    assert.strictEqual(copyOf('maxCodeActionResults', 10), 10);
    for (const key of ['showImplicits', 'showMachineNames', 'fullNamespace', 'briefCompletions']) {
      assert.strictEqual(copyOf(key, true), true, key);
      assert.strictEqual(copyOf(key, false), false, key);
    }
    assert.strictEqual(copyOf('path', ' /opt/lsp/bin/idris2-lsp '), '/opt/lsp/bin/idris2-lsp');
    assert.strictEqual(copyOf('path', 'idris2-lsp'), 'idris2-lsp', 'a bare command name is looked up on PATH, as bamboo did');
    assert.strictEqual(copyOf('trace.server', 'verbose'), 'verbose');
    assert.strictEqual(copyOf('trace.server', 'messages'), 'messages');
  });

  test('values that would mean something else here, or are of the wrong type, are reported, not copied', () => {
    const skipped = (from: string, value: unknown): string => {
      const plan = planMigration([found(from, value)]);
      assert.deepStrictEqual(plan.copies, [], `${from} = ${JSON.stringify(value)}`);
      assert.strictEqual(plan.skipped.length, 1);
      return plan.skipped[0].reason;
    };
    assert.match(skipped('logFile', 'stderr'), /standard error/);
    assert.match(skipped('logFile', 'logs/lsp.log'), /not an absolute path/);
    assert.match(skipped('trace.server', 'off'), /no "off"/);
    assert.match(skipped('loglevel', 'verbose'), /not one of/);
    assert.match(skipped('longActionTimeout', 0), /at least 1/);
    assert.match(skipped('maxCodeActionResults', Number.NaN), /at least 1/);
    assert.match(skipped('maxCodeActionResults', '5'), /at least 1/);
    assert.match(skipped('showImplicits', 'true'), /true or false/);
    assert.match(skipped('path', ''), /not a path/);
    assert.match(skipped('trace.server', { verbosity: 'verbose' }), /messages or verbose/);
  });

  test('a target already set in the same place is left alone; another place still gets the value', () => {
    const plan = planMigration([found('loglevel', 'info', 'global', 'debug'), found('loglevel', 'info', 'workspace', undefined)]);
    assert.deepStrictEqual(plan.copies, [{ from: 'loglevel', to: 'idris2.lsp.logSeverity', target: 'workspace', value: 'info' }]);
    assert.deepStrictEqual(plan.skipped, []);
  });

  test('a workspace folder\'s value: copied for a folder-scoped target, reported for a window-scoped one', () => {
    const plan = planMigration([found('path', '/x/idris2-lsp', 'workspaceFolder', undefined, '/w/a'), found('showImplicits', true, 'workspaceFolder', undefined, '/w/a')]);
    assert.deepStrictEqual(plan.copies, [{ from: 'path', to: 'idris2.toolchain.lspPath', target: 'workspaceFolder', folder: '/w/a', value: '/x/idris2-lsp' }]);
    assert.deepStrictEqual(plan.skipped, [{ from: 'showImplicits', target: 'workspaceFolder', folder: '/w/a', reason: 'idris2.lsp.showImplicits cannot be set for one workspace folder' }]);
  });

  test('keys bamboo does not have, and values not set, are ignored', () => {
    assert.deepStrictEqual(planMigration([found('logSeverity', 'info'), found('loglevel', undefined)]), { copies: [], skipped: [] });
  });
});
