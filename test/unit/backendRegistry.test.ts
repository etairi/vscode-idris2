import * as assert from 'assert';
import { NullBackend } from '../../src/backend/null';
import { BackendRegistry, rootKey } from '../../src/backend/registry';
import type { BackendKind, IdrisBackend } from '../../src/backend/types';
import { LOOSE, projectRoot } from './support/toolchainFixtures';

/** The registry reads only `kind`; the rest of the backend is never called here. */
function backendOf(kind: BackendKind): IdrisBackend {
  return { kind } as unknown as IdrisBackend;
}

suite('backend/registry (M1: registration and status label)', () => {
  const project = projectRoot();

  test('with nothing registered every root, and a document without one, gets NullBackend and "syntax only"', () => {
    const registry = new BackendRegistry();
    for (const root of [project, LOOSE, undefined]) {
      assert.ok(registry.backendFor(root) instanceof NullBackend);
      assert.strictEqual(registry.labelFor(root), 'syntax only');
    }
  });

  test('a registered backend serves its root only, and its kind names the label', () => {
    const registry = new BackendRegistry();
    const ide = backendOf('ideMode');
    registry.register(project, ide);
    assert.strictEqual(registry.backendFor(project), ide);
    assert.strictEqual(registry.labelFor(project), 'IDE mode');
    assert.strictEqual(registry.labelFor(projectRoot({ ipkgPath: '/w/other/other.ipkg', dir: '/w/other' })), 'syntax only');
    assert.strictEqual(registry.labelFor(LOOSE), 'syntax only');
    registry.register(LOOSE, backendOf('lsp'));
    assert.strictEqual(registry.labelFor(LOOSE), 'idris2-lsp');
  });

  test('a project is keyed by its .ipkg and a loose file by its directory, so the two never share a key', () => {
    const sameDir = projectRoot({ dir: LOOSE.dir, ipkgPath: `${LOOSE.dir}/p.ipkg` });
    assert.notStrictEqual(rootKey(sameDir), rootKey(LOOSE));
    const registry = new BackendRegistry();
    registry.register(LOOSE, backendOf('ideMode'));
    assert.strictEqual(registry.labelFor(sameDir), 'syntax only');
    // The classification is a value: an equal one found later maps to the same backend.
    assert.strictEqual(registry.labelFor({ kind: 'loose', dir: LOOSE.dir }), 'IDE mode');
  });

  test('onDidChange fires once per registration and once per unregistration; disposing twice is harmless', () => {
    const registry = new BackendRegistry();
    let fired = 0;
    registry.onDidChange(() => fired++);
    const registration = registry.register(project, backendOf('ideMode'));
    assert.strictEqual(fired, 1);
    registration.dispose();
    assert.strictEqual(fired, 2);
    assert.strictEqual(registry.labelFor(project), 'syntax only');
    registration.dispose();
    assert.strictEqual(fired, 2);
  });

  test('a second backend for a root that has one is refused (routing between two is M5)', () => {
    const registry = new BackendRegistry();
    const first = backendOf('ideMode');
    registry.register(project, first);
    assert.throws(() => registry.register(project, backendOf('lsp')), /already registered/);
    assert.strictEqual(registry.backendFor(project), first);
  });

  test('an old registration disposed after a newer one for the same root leaves the newer one in place', () => {
    const registry = new BackendRegistry();
    const old = registry.register(project, backendOf('ideMode'));
    old.dispose();
    const lsp = backendOf('lsp');
    registry.register(project, lsp);
    old.dispose();
    assert.strictEqual(registry.backendFor(project), lsp);
  });

  test('after dispose: registering throws, lookups fall back to NullBackend, no event fires', () => {
    const registry = new BackendRegistry();
    let fired = 0;
    registry.onDidChange(() => fired++);
    const registration = registry.register(project, backendOf('ideMode'));
    registry.dispose();
    registry.dispose();
    assert.strictEqual(registry.labelFor(project), 'syntax only');
    assert.throws(() => registry.register(LOOSE, backendOf('ideMode')), /disposed/);
    registration.dispose();
    assert.strictEqual(fired, 1);
  });
});
