// features/intelligence/queries.ts: DocumentQueries (types.ts, steps 1–3) — nothing asked in
// Restricted Mode or for a document not on disk; on NotLoaded the document is loaded as Check File
// loads it and asked again, a passive query only for the active document of a running (or idle)
// backend whose trigger is not manual; one load for the queries that need it at once — and the
// AnswerCache kept per file until that file is loaded again.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { BackendState } from '../../src/backend/registry';
import type { CheckingTrigger } from '../../src/core/config';
import { cancelled, IdrisException, unsupported } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { CheckRefusal } from '../../src/features/diagnostics/checks';
import { AnswerCache, createDocumentQueries } from '../../src/features/intelligence/queries';
import type { LoadedFileEvent, QueryOutcome } from '../../src/features/intelligence/types';
import type { Classification } from '../../src/project/types';
import { asDoc, FakeBackend, FakeDocument, quietLog, settle } from './support/intelligence';

function setup() {
  const backend = new FakeBackend();
  backend.loaded = new Set();
  const doc = new FakeDocument('/w/A.idr', 'module A\n');
  const state = {
    trusted: true,
    active: doc as FakeDocument | undefined,
    backendState: { kind: 'active' } as BackendState | undefined,
    trigger: 'onSave' as CheckingTrigger,
    refusal: undefined as CheckRefusal | undefined,
    /** Whether a check loads the file into the backend. */
    loads: true,
    /** The document's check already running (`runningCheck`), if any. */
    running: undefined as Promise<CheckRefusal | undefined> | undefined,
  };
  const checked: string[] = [];
  const gates: (() => void)[] = [];
  const queries = createDocumentQueries({
    registry: { backendFor: () => backend, stateFor: () => state.backendState },
    projects: { classify: (file: string) => Promise.resolve<Classification>({ kind: 'loose', dir: file.slice(0, file.lastIndexOf('/')) }) },
    checks: {
      check: async (d: vscode.TextDocument) => {
        checked.push(d.fileName);
        await new Promise<void>((resolve) => gates.push(resolve));
        if (state.loads) {
          backend.loaded?.add(d.fileName);
        }
        return state.refusal;
      },
      runningCheck: () => state.running,
      activeDocument: () => (state.active === undefined ? undefined : asDoc(state.active)),
    },
    config: { checking: () => ({ trigger: state.trigger, delayMs: 700 }) },
    trust: {
      get isTrusted() {
        return state.trusted;
      },
      onDidGrant: new Emitter<void>().event,
    },
    log: quietLog,
  });
  /** Runs a type query and lets every pending check finish. */
  const ask = async (mode: 'passive' | 'command', target = doc): Promise<QueryOutcome<unknown>> => {
    const pending = queries.run(asDoc(target), mode, (b) => b.typeAt(asDoc(target), { line: 0, character: 0 } as vscode.Position, 'x'));
    pending.catch(() => undefined); // the test awaits it after the checks have run
    for (let i = 0; i < 5; i++) {
      await settle();
      gates.splice(0).forEach((open) => open());
    }
    return pending;
  };
  return { backend, doc, state, checked, gates, queries, ask };
}

suite('features/intelligence/queries', () => {
  test('Restricted Mode and documents that are not files are unavailable, and nothing is asked', async () => {
    const t = setup();
    t.state.trusted = false;
    assert.strictEqual((await t.ask('command')).kind, 'unavailable');
    t.state.trusted = true;
    const untitled = new FakeDocument('Untitled-1', 'x', 'idris2', 'untitled');
    const outcome = await t.ask('command', untitled);
    assert.deepStrictEqual(outcome, { kind: 'unavailable', reason: 'The document is not a file on disk: save it first.' });
    assert.deepStrictEqual(t.backend.calls, []);
    assert.deepStrictEqual(t.checked, []);
  });

  test('a loaded file is asked once, without a check', async () => {
    const t = setup();
    t.backend.loaded = null;
    t.backend.typeAnswer = () => Promise.resolve({ text: 'x : Nat', spans: [], lookup: 'position' });
    assert.deepStrictEqual(await t.ask('passive'), { kind: 'answer', value: { text: 'x : Nat', spans: [], lookup: 'position' } });
    assert.deepStrictEqual(t.backend.calls, ['typeAt x 0:0']);
    assert.deepStrictEqual(t.checked, []);
  });

  test('NotLoaded: a command loads the file as Check File does and asks again', async () => {
    const t = setup();
    t.state.active = undefined; // a command loads whatever the active document
    t.state.backendState = { kind: 'stopped' };
    t.state.trigger = 'manual';
    t.backend.typeAnswer = () => Promise.resolve({ text: 'x : Nat', spans: [], lookup: 'position' });
    assert.strictEqual((await t.ask('command')).kind, 'answer');
    assert.deepStrictEqual(t.checked, ['/w/A.idr']);
    assert.deepStrictEqual(t.backend.calls, ['typeAt x 0:0', 'typeAt x 0:0']);
  });

  test('NotLoaded: a passive query loads the active document of a none or active backend', async () => {
    for (const kind of ['none', 'active'] as const) {
      const t = setup();
      t.state.backendState = { kind };
      assert.strictEqual((await t.ask('passive')).kind, 'answer', kind);
      assert.deepStrictEqual(t.checked, ['/w/A.idr']);
    }
  });

  test('NotLoaded while the document\'s check runs (opened, still classified): the query waits for that check and loads nothing itself', async () => {
    for (const mode of ['passive', 'command'] as const) {
      const t = setup();
      t.backend.typeAnswer = () => Promise.resolve({ text: 'x : Nat', spans: [], lookup: 'position' });
      let finish = (): void => undefined;
      t.state.running = new Promise<CheckRefusal | undefined>((resolve) => {
        finish = () => {
          t.backend.loaded?.add('/w/A.idr');
          resolve(undefined);
        };
      });
      const pending = t.queries.run(asDoc(t.doc), mode, (b) => b.typeAt(asDoc(t.doc), { line: 0, character: 0 } as vscode.Position, 'x'));
      await settle();
      assert.deepStrictEqual(t.backend.calls, ['typeAt x 0:0'], mode);
      finish();
      assert.strictEqual((await pending).kind, 'answer', mode);
      assert.deepStrictEqual(t.checked, [], `${mode}: no second load`);
      assert.deepStrictEqual(t.backend.calls, ['typeAt x 0:0', 'typeAt x 0:0'], mode);
    }
    const u = setup();
    u.state.running = Promise.resolve({ message: 'Not allowed in /w', dir: '/w' });
    assert.deepStrictEqual(await u.ask('command'), { kind: 'unavailable', reason: 'Not allowed in /w' }, 'the running check\'s refusal');
    assert.deepStrictEqual(u.checked, []);
  });

  test('NotLoaded: a passive query loads nothing for another document, a stopped or failed backend, or manual checking', async () => {
    const cases: [string, (t: ReturnType<typeof setup>) => void][] = [
      ['not active', (t) => (t.state.active = new FakeDocument('/w/B.idr', ''))],
      ['no active document', (t) => (t.state.active = undefined)],
      ['stopped', (t) => (t.state.backendState = { kind: 'stopped' })],
      ['failed', (t) => (t.state.backendState = { kind: 'failed', reason: 'gave up' })],
      ['not allowed', (t) => (t.state.backendState = { kind: 'notAllowed', dir: '/w', reason: 'denied' })],
      ['no provider', (t) => (t.state.backendState = undefined)],
      ['manual', (t) => (t.state.trigger = 'manual')],
    ];
    for (const [what, arrange] of cases) {
      const t = setup();
      arrange(t);
      const outcome = await t.ask('passive');
      assert.strictEqual(outcome.kind, 'unavailable', what);
      assert.deepStrictEqual(t.checked, [], what);
      assert.deepStrictEqual(t.backend.calls, ['typeAt x 0:0'], what);
    }
  });

  test("a refused load is unavailable with the refusal's message; NotLoaded again after the load is unavailable", async () => {
    const t = setup();
    t.state.refusal = { message: 'Not allowed in /w', dir: '/w' };
    assert.deepStrictEqual(await t.ask('command'), { kind: 'unavailable', reason: 'Not allowed in /w' });
    const u = setup();
    u.state.loads = false; // another file of the root was loaded in between
    const outcome = await u.ask('command');
    assert.deepStrictEqual(outcome, { kind: 'unavailable', reason: '/w/A.idr is not loaded' });
    assert.deepStrictEqual(u.checked, ['/w/A.idr']);
  });

  test('an Idris error or a cancellation is unavailable with its text; any other rejection is rethrown', async () => {
    const t = setup();
    t.backend.loaded = null;
    t.backend.typeAnswer = () => Promise.reject(unsupported('Showing a type needs a backend.'));
    assert.deepStrictEqual(await t.ask('passive'), { kind: 'unavailable', reason: 'Showing a type needs a backend.' });
    t.backend.typeAnswer = () => Promise.reject(new IdrisException({ kind: 'RequestTimeout', message: 'timed out' }));
    assert.deepStrictEqual(await t.ask('passive'), { kind: 'unavailable', reason: 'timed out' });
    t.backend.typeAnswer = () => Promise.reject(cancelled('Stopped'));
    assert.deepStrictEqual(await t.ask('passive'), { kind: 'unavailable', reason: 'Stopped' });
    t.backend.typeAnswer = () => Promise.reject(new TypeError('bug'));
    await assert.rejects(t.ask('passive'), TypeError);
  });

  test('queries that need a load at once share one check', async () => {
    const t = setup();
    const first = t.queries.run(asDoc(t.doc), 'passive', (b) => b.docsFor(asDoc(t.doc), 'x', 'overview'));
    const second = t.queries.run(asDoc(t.doc), 'command', (b) => b.docsFor(asDoc(t.doc), 'y', 'full'));
    for (let i = 0; i < 5; i++) {
      await settle();
      t.gates.splice(0).forEach((open) => open());
    }
    assert.strictEqual((await first).kind, 'answer');
    assert.strictEqual((await second).kind, 'answer');
    assert.deepStrictEqual(t.checked, ['/w/A.idr']);
    // Once settled, a later NotLoaded loads again.
    t.backend.loaded?.clear();
    await t.ask('command');
    assert.deepStrictEqual(t.checked, ['/w/A.idr', '/w/A.idr']);
  });

  suite('AnswerCache', () => {
    function cacheSetup() {
      const loads = new Emitter<LoadedFileEvent>();
      const cache = new AnswerCache({ onDidLoad: loads.event });
      let asked = 0;
      const answer = (value: string) => (): Promise<QueryOutcome<string>> => {
        asked++;
        return Promise.resolve({ kind: 'answer', value });
      };
      const root: Classification = { kind: 'loose', dir: '/w' };
      return { cache, loads, answer, asked: () => asked, root };
    }

    test('an answer is kept per file and key; a load that built nothing keeps every answer, the loaded file\'s included', async () => {
      const t = cacheSetup();
      t.loads.fire({ root: t.root, file: '/w/A.idr', rebuilt: true });
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'k', t.answer('1')), { kind: 'answer', value: '1' });
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'k', t.answer('2')), { kind: 'answer', value: '1' });
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'j', t.answer('3')), { kind: 'answer', value: '3' });
      t.loads.fire({ root: t.root, file: '/w/B.idr', rebuilt: false });
      t.loads.fire({ root: t.root, file: '/w/A.idr', rebuilt: false });
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'k', t.answer('4')), { kind: 'answer', value: '1' });
      assert.strictEqual(t.asked(), 2);
      t.cache.dispose();
      t.loads.fire({ root: t.root, file: '/w/A.idr', rebuilt: true });
    });

    test('a load that built something makes the answers of every file of its root stale: a dependency saved and loaded', async () => {
      // B imports A: A's `shout` changed, A was saved and loaded; B, not checked again, must not
      // keep the type it had of `shout` (review of M3).
      const t = cacheSetup();
      const other: Classification = { kind: 'loose', dir: '/elsewhere' };
      t.loads.fire({ root: t.root, file: '/w/B.idr', rebuilt: true });
      t.loads.fire({ root: other, file: '/elsewhere/C.idr', rebuilt: true });
      assert.deepStrictEqual(await t.cache.get('/w/B.idr', 'typeAt shout', t.answer('Foo.A.shout : String -> String')), { kind: 'answer', value: 'Foo.A.shout : String -> String' });
      assert.deepStrictEqual(await t.cache.get('/elsewhere/C.idr', 'k', t.answer('c')), { kind: 'answer', value: 'c' });
      t.loads.fire({ root: t.root, file: '/w/A.idr', rebuilt: true });
      assert.deepStrictEqual(await t.cache.get('/w/B.idr', 'typeAt shout', t.answer('Foo.A.shout : String -> Nat')), { kind: 'answer', value: 'Foo.A.shout : String -> Nat' });
      assert.deepStrictEqual(await t.cache.get('/elsewhere/C.idr', 'k', t.answer('c2')), { kind: 'answer', value: 'c' }, 'another root keeps its answers');
    });

    test('forget (the document closed) drops the file\'s answers', async () => {
      const t = cacheSetup();
      t.loads.fire({ root: t.root, file: '/w/A.idr', rebuilt: true });
      await t.cache.get('/w/A.idr', 'k', t.answer('1'));
      t.cache.forget('/w/A.idr');
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'k', t.answer('2')), { kind: 'answer', value: '2' });
    });

    test('unavailable outcomes are asked again; a pending question is shared; fresh asks again', async () => {
      const t = cacheSetup();
      const missing = (): Promise<QueryOutcome<string>> => Promise.resolve({ kind: 'unavailable', reason: 'not loaded' });
      assert.strictEqual((await t.cache.get('/w/A.idr', 'k', missing)).kind, 'unavailable');
      await settle();
      const a = t.cache.get('/w/A.idr', 'k', t.answer('1'));
      const b = t.cache.get('/w/A.idr', 'k', t.answer('2'));
      assert.strictEqual(a, b);
      await a;
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'k', t.answer('3'), true), { kind: 'answer', value: '3' });
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'k', t.answer('4')), { kind: 'answer', value: '3' }, 'the fresh answer is kept');
    });

    test('a question pending while its file is loaded is not kept', async () => {
      const t = cacheSetup();
      let resolve: (o: QueryOutcome<string>) => void = () => undefined;
      const pending = t.cache.get('/w/A.idr', 'k', () => new Promise<QueryOutcome<string>>((r) => (resolve = r)));
      t.loads.fire({ root: t.root, file: '/w/A.idr', rebuilt: true });
      resolve({ kind: 'answer', value: 'old' });
      await pending;
      assert.deepStrictEqual(await t.cache.get('/w/A.idr', 'k', t.answer('new')), { kind: 'answer', value: 'new' });
    });
  });
});
