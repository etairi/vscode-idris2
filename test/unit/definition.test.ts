// Go to Definition (register.ts): the backend's locations of a global name, asked at every call
// (the backend keeps what it asked per load and moves the ranges to the text the target documents
// show then: backendIde.test.ts), with the occurrence's decoration and namespace; a local variable
// is not looked up (the compiler finds names by name only, F2/F3, so it would jump to a global of the
// same name), and nothing is shown for it (VS Code asks the provider on a Cmd-hover too), nor for a
// backend's reason, which goes to the log; nothing without the capability or for an untitled document.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { Emitter } from '../../src/core/event';
import { createDocumentQueries } from '../../src/features/intelligence/queries';
import { registerIntelligence } from '../../src/features/intelligence/register';
import type { LoadedFileEvent } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import { IdrisException } from '../../src/core/errors';
import { asDoc, FakeBackend, FakeDocument, FakePosition, fakeApi, fixtureDocument, indexOf, quietLog, recordedTokens } from './support/intelligence';

function setup() {
  const doc = fixtureDocument('test/fixtures/workspaces/simple-ipkg/src/Foo/Shapes.idr');
  const backend = new FakeBackend();
  backend.index = indexOf(doc, recordedTokens('shapes-lookups', 'Foo/Shapes.idr', doc));
  const location = { uri: { fsPath: '/opt/homebrew/…/Prelude/Types.idr' }, range: { start: { line: 996, character: 0 } } } as unknown as vscode.Location;
  backend.definitionAnswer = (name) => Promise.resolve(name === 'pi' ? [location] : []);
  const loads = new Emitter<LoadedFileEvent>();
  const root: Classification = { kind: 'loose', dir: '/w' };
  const registry = { backendFor: () => backend, stateFor: () => ({ kind: 'active' }) as const, onDidChange: new Emitter<void>().event };
  const projects = { classify: () => Promise.resolve(root) };
  const trust = { isTrusted: true, onDidGrant: new Emitter<void>().event };
  const queries = createDocumentQueries({
    registry,
    projects,
    checks: { check: () => Promise.resolve(undefined), runningCheck: () => undefined, activeDocument: () => asDoc(doc) },
    config: { checking: () => ({ trigger: 'onSave', delayMs: 700 }) },
    trust,
    log: quietLog,
  });
  const fake = fakeApi();
  const logged: string[] = [];
  const intelligence = registerIntelligence(fake.api as never, {
    queries,
    loads: { onDidLoad: loads.event },
    registry,
    projects,
    checks: { statusOf: () => undefined, onDidChange: new Emitter<void>().event },
    config: { inlayHints: () => ({ variableTypes: true }), onDidChange: () => ({ dispose: () => undefined }), checking: () => ({ trigger: 'onSave', delayMs: 700 }) },
    log: { ...quietLog, debug: (m: string) => logged.push(`debug ${m}`), info: (m: string) => logged.push(`info ${m}`) },
  }, { keepNotices: true });
  const provide = (line: number, character: number, d: FakeDocument = doc) =>
    fake.providers.definition?.provideDefinition(asDoc(d), new FakePosition(line, character) as never, fake.cancel) as Promise<vscode.Location[] | undefined>;
  return { doc, backend, loads, root, fake, intelligence, provide, location, logged };
}

suite('features/intelligence: Go to Definition', () => {
  test("a global name: the backend's locations, asked at the token's start with its decoration and namespace, at every call", async () => {
    const t = setup();
    assert.deepStrictEqual(await t.provide(12, 19), [t.location]);
    assert.deepStrictEqual(await t.provide(12, 18), [t.location]);
    // Asked each time: the backend keeps its :name-at answer per load, and moves the ranges to the
    // text the target's document shows at each call (fourth review of M3), which an answer kept here
    // would not follow.
    assert.deepStrictEqual(t.backend.calls, ['definition pi 12:18', 'definition pi 12:18']);
    // The occurrence's decoration goes with it: the backend refuses a `bound` one by it, not by its own
    // index at the editor position (third review of M3); and the namespace of the name it refers to,
    // which picks the definition among those of the same name (fourth review of M3).
    assert.deepStrictEqual(t.backend.decors, ['function', 'function']);
    assert.deepStrictEqual(t.backend.namespaces, ['Prelude.Types', 'Prelude.Types']);
    assert.deepStrictEqual(await t.provide(11, 1), [], 'a name the compiler finds nothing for');
    // A declaring occurrence has an empty namespace (F33): none is passed.
    await t.provide(11, 1);
    assert.strictEqual(t.backend.namespaces.at(-1), undefined);
  });

  test("the backend's reason for no answer goes to the log, not to a notification (fourth review of M3)", async () => {
    const t = setup();
    t.backend.definitionAnswer = () =>
      Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'The definition of pi is in /opt/…/Prelude/Types.idr, which cannot be read on this computer.' }));
    assert.strictEqual(await t.provide(12, 19), undefined);
    assert.deepStrictEqual(t.logged, ['debug Intelligence: Go to Definition of pi: The definition of pi is in /opt/…/Prelude/Types.idr, which cannot be read on this computer.']);
    assert.deepStrictEqual(t.intelligence.notices, []);
    assert.deepStrictEqual(t.fake.messages, []);
  });

  test('a local variable is not looked up, and nothing is shown (a Cmd-hover asks the provider too)', async () => {
    const t = setup();
    assert.strictEqual(await t.provide(12, 13), undefined);
    assert.strictEqual(await t.provide(33, 6), undefined);
    assert.deepStrictEqual(t.backend.calls, []);
    assert.deepStrictEqual(t.intelligence.notices, []);
    assert.deepStrictEqual(t.fake.messages, []);
  });

  test('nothing without the capability, for an untitled document, or where there is no name', async () => {
    const t = setup();
    t.backend.caps = { ...t.backend.caps, definition: false };
    assert.strictEqual(await t.provide(12, 19), undefined);
    t.backend.caps = { ...t.backend.caps, definition: true };
    assert.strictEqual(await t.provide(0, 0, new FakeDocument('Untitled-1', 'pi', 'idris2', 'untitled')), undefined);
    assert.strictEqual(await t.provide(4, 1), undefined);
    assert.deepStrictEqual(t.backend.calls, []);
  });
});
