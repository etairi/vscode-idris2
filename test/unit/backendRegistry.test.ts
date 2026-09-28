import * as assert from 'assert';
import { NullBackend } from '../../src/backend/null';
import { BackendRegistry, rootKey, type BackendProvider, type BackendState } from '../../src/backend/registry';
import type { BackendKind, IdrisBackend } from '../../src/backend/types';
import { Emitter } from '../../src/core/event';
import type { Classification } from '../../src/project/types';
import { LOOSE, projectRoot } from './support/toolchainFixtures';

/** The registry reads only `kind`; the rest of the backend is never called here. */
function backendOf(kind: BackendKind): IdrisBackend {
  return { kind } as unknown as IdrisBackend;
}

/** A provider whose states are set per root key by the test. */
class FakeProvider implements BackendProvider {
  readonly backend: IdrisBackend;
  readonly states = new Map<string, BackendState>();
  readonly asked: Classification[] = [];
  readonly changed = new Emitter<void>();
  readonly onDidChangeState = this.changed.event;
  constructor(readonly kind: BackendKind) {
    this.backend = backendOf(kind);
  }
  backendFor(root: Classification): IdrisBackend {
    this.asked.push(root);
    return this.backend;
  }
  stateFor(root: Classification): BackendState {
    return this.states.get(rootKey(root)) ?? { kind: 'none' };
  }
}

suite('backend/registry (M2: one provider serves every root; its state for the status)', () => {
  const project = projectRoot();

  test('without a provider every root, and a document without one, gets NullBackend, "syntax only" and no state', () => {
    const registry = new BackendRegistry();
    for (const root of [project, LOOSE, undefined]) {
      assert.ok(registry.backendFor(root) instanceof NullBackend);
      assert.strictEqual(registry.labelFor(root), 'syntax only');
      assert.strictEqual(registry.stateFor(root), undefined);
    }
  });

  test('a provider serves every root it is asked about, and its kind names the label', () => {
    const registry = new BackendRegistry();
    const ide = new FakeProvider('ideMode');
    registry.setProvider(ide);
    assert.strictEqual(registry.backendFor(project), ide.backend);
    assert.strictEqual(registry.backendFor(LOOSE), ide.backend);
    assert.strictEqual(registry.labelFor(project), 'IDE mode');
    assert.deepStrictEqual(ide.asked, [project, LOOSE, project]);
    // A document without a root is never handed to the provider.
    assert.ok(registry.backendFor(undefined) instanceof NullBackend);
    assert.strictEqual(registry.labelFor(undefined), 'syntax only');
  });

  test('pendingLabel (a file whose root is not known yet) is the provider\'s label, else "syntax only"', () => {
    const registry = new BackendRegistry();
    assert.strictEqual(registry.pendingLabel(), 'syntax only');
    const registration = registry.setProvider(new FakeProvider('ideMode'));
    assert.strictEqual(registry.pendingLabel(), 'IDE mode');
    registration.dispose();
    assert.strictEqual(registry.pendingLabel(), 'syntax only');
  });

  test('stateFor is the provider\'s, per root; a state change of the provider fires onDidChange', () => {
    const registry = new BackendRegistry();
    const ide = new FakeProvider('ideMode');
    registry.setProvider(ide);
    let fired = 0;
    registry.onDidChange(() => fired++);
    ide.states.set(rootKey(project), { kind: 'stopped' });
    ide.changed.fire();
    assert.strictEqual(fired, 1);
    assert.deepStrictEqual(registry.stateFor(project), { kind: 'stopped' });
    assert.deepStrictEqual(registry.stateFor(LOOSE), { kind: 'none' });
    assert.strictEqual(registry.stateFor(undefined), undefined);
  });

  test('a project is keyed by its .ipkg and a loose file by its directory, so the two never share a key', () => {
    const sameDir = projectRoot({ dir: LOOSE.dir, ipkgPath: `${LOOSE.dir}/p.ipkg` });
    assert.notStrictEqual(rootKey(sameDir), rootKey(LOOSE));
    // The classification is a value: an equal one found later has the same key.
    assert.strictEqual(rootKey({ kind: 'loose', dir: LOOSE.dir }), rootKey(LOOSE));
  });

  test('onDidChange fires when the provider is set and removed; removing twice is harmless and stops its events', () => {
    const registry = new BackendRegistry();
    let fired = 0;
    registry.onDidChange(() => fired++);
    const ide = new FakeProvider('ideMode');
    const registration = registry.setProvider(ide);
    assert.strictEqual(fired, 1);
    registration.dispose();
    assert.strictEqual(fired, 2);
    assert.strictEqual(registry.labelFor(project), 'syntax only');
    registration.dispose();
    ide.changed.fire();
    assert.strictEqual(fired, 2);
  });

  test('a second provider while one is set is refused (routing between two is M5); after removal another may be set', () => {
    const registry = new BackendRegistry();
    const registration = registry.setProvider(new FakeProvider('ideMode'));
    assert.throws(() => registry.setProvider(new FakeProvider('lsp')), /already set/);
    assert.strictEqual(registry.labelFor(project), 'IDE mode');
    registration.dispose();
    registry.setProvider(new FakeProvider('lsp'));
    assert.strictEqual(registry.labelFor(project), 'idris2-lsp');
  });

  test('after dispose: setting a provider throws, lookups fall back to NullBackend, no event fires', () => {
    const registry = new BackendRegistry();
    let fired = 0;
    registry.onDidChange(() => fired++);
    const ide = new FakeProvider('ideMode');
    const registration = registry.setProvider(ide);
    registry.dispose();
    registry.dispose();
    assert.strictEqual(registry.labelFor(project), 'syntax only');
    assert.strictEqual(registry.stateFor(project), undefined);
    assert.throws(() => registry.setProvider(new FakeProvider('ideMode')), /disposed/);
    ide.changed.fire();
    registration.dispose();
    assert.strictEqual(fired, 1);
  });
});
