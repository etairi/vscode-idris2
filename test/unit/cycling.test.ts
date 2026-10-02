// features/editing/cycling.ts and the two Next commands (ARCHITECTURE §10 `CyclingController`;
// features/editing/types.ts, *Cycling*): Proof Search and Generate Definition start a cycle of their
// document; Next Result (a cycle of either kind, ROADMAP §9 Q26) / Next Definition (a Generate
// Definition's) send the range the cycle follows and apply the next result as a fresh replacement;
// the status bar shows `↻ next (n)` while the active editor's document has
// a cycle; a change not made by the controller, a load of the root, another search, a close, no
// more results, a failure or a cancel end it, and the next command says why. The results are the
// recorded ones (clean-editing: Proof Search on ?vlen_rhs gives 0, then 1, 2; Generate Definition on
// append gives two clauses, then three, F30).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { EditRequest, EditResult, NextRequest, TextReplacement } from '../../src/backend/types';
import { cancelled, IdrisException } from '../../src/core/errors';
import { registerEditing } from '../../src/features/editing/register';
import type { EditingCommandId } from '../../src/features/editing/types';
import { repoRoot } from '../fake-tools/paths';
import { editingDeps, FakeEditBackend, FakeEditingApi, FakeRange, FakeTextDoc, looseRoot, range } from './support/editingFakes';

const fixture = (name: string): string => fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'broken', name), 'utf8');
const rep = (sl: number, sc: number, el: number, ec: number, text: string): TextReplacement => ({ range: range(sl, sc, el, ec), text });
const edit = (...replacements: TextReplacement[]): Promise<EditResult> => Promise.resolve({ type: 'edit', replacements });

const APPEND_1 = 'append [] ys = ys\nappend (x :: xs) ys = x :: append xs ys\n';
const APPEND_2 = 'append [] ys = ys\nappend (x :: xs) [] = x :: append xs []\nappend (x :: xs) (y :: ys) = x :: append xs (y :: ys)\n';

function setUp(line = 7, character = 12, cancelOfferMs = 60_000) {
  const api = new FakeEditingApi();
  const backend = new FakeEditBackend();
  const env = editingDeps(backend);
  const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true, cancelOfferMs });
  const doc = api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Clean.idr', text: fixture('Clean.idr') }));
  api.window.showAt(doc, line, character);
  const uri = doc.uri.toString();
  const run = async (id: EditingCommandId) => {
    const before = registration.outcomes.length;
    await api.run(id);
    return registration.outcomes.slice(before);
  };
  const lastMessage = (): string => api.window.messages.at(-1)?.text ?? '';
  const status = () => {
    const item = api.window.statusItems[0];
    return item.visible ? { text: item.text, command: item.command } : undefined;
  };
  /** Proof Search on ?vlen_rhs answering `0`, then Next Result answering from `nexts`. */
  const searchVlen = async (nexts: (req: EditRequest) => Promise<EditResult>): Promise<void> => {
    backend.answer = (req) => (req.kind === 'exprSearch' ? edit(rep(7, 10, 7, 19, '0')) : nexts(req));
    await run('idris2.proofSearch');
  };
  return { api, backend, env, registration, doc, uri, run, lastMessage, status, searchVlen };
}

suite('features/editing: cycling (CyclingController, Next Result, Next Definition)', () => {
  test('Next Result\'s Cancel notification says nothing of a check: the Next commands never check the file (UX review of M4\'s eighth round)', async () => {
    const t = setUp(7, 12, 0);
    await t.searchVlen((req) => new Promise((_resolve, reject) => req.token?.onCancellationRequested(() => reject(cancelled('Cancelled')))));
    const running = t.api.run('idris2.nextResult');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(t.api.window.notifications.at(-1)?.title, 'Idris 2: Next Result is still running. Cancel stops it.');
    t.api.window.notifications.at(-1)?.cancel();
    await running;
  });

  test('Proof Search → a cycle (↻ next (1)); Next Result sends the range and version of the last result, replaces it, counts; No more results ends it', async () => {
    const t = setUp();
    const answers = ['1', '2'];
    await t.searchVlen((req) => {
      const next = answers.shift();
      return next === undefined ? Promise.resolve({ type: 'exhausted' }) : edit({ range: (req as NextRequest).previous, text: next });
    });
    assert.deepStrictEqual(t.registration.cycleOf(t.uri), { uri: t.uri, kind: 'exprSearch', range: range(7, 10, 7, 11), version: 2, shown: 1 });
    assert.deepStrictEqual(t.status(), { text: '↻ next (1)', command: 'idris2.nextResult' });
    assert.strictEqual(t.registration.statusText(), '↻ next (1)');

    assert.deepStrictEqual(await t.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'applied', uri: t.uri }]);
    const next = t.backend.requests[1] as NextRequest;
    assert.deepStrictEqual({ kind: next.kind, version: next.version, previous: next.previous, doc: next.doc }, {
      kind: 'exprSearchNext',
      version: 2,
      previous: range(7, 10, 7, 11),
      doc: t.doc,
    });
    assert.ok(next.token !== undefined, 'a long request has a token');
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 1');
    assert.deepStrictEqual(t.registration.cycleOf(t.uri)?.shown, 2);
    assert.deepStrictEqual(t.status(), { text: '↻ next (2)', command: 'idris2.nextResult' });
    await t.run('idris2.nextResult');
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 2');
    assert.deepStrictEqual(t.registration.cycleOf(t.uri)?.version, 4);
    assert.strictEqual(t.api.workspace.edits.length, 3, 'each result its own WorkspaceEdit (one undo step each)');

    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /Proof Search has no more results/);
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    assert.strictEqual(t.status(), undefined);
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 2');
    const sent = t.backend.requests.length;
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /the Proof Search ended: there were no more results/);
    assert.strictEqual(t.backend.requests.length, sent, 'nothing is sent without a cycle');
  });

  test('Generate Definition → a cycle; `g` (Generate Definition) on its declaration or in its result runs Next Definition; Next Result continues it too (ROADMAP §9 Q26)', async () => {
    const t = setUp(4, 3);
    t.backend.answer = (req) =>
      req.kind === 'generateDef' ? edit(rep(5, 0, 5, 0, APPEND_1)) : req.kind === 'generateDefNext' ? edit({ range: req.previous, text: APPEND_2 }) : Promise.reject(new Error(req.kind));
    await t.run('idris2.generateDefinition');
    assert.deepStrictEqual(t.registration.cycleOf(t.uri), { uri: t.uri, kind: 'generateDef', range: range(5, 0, 7, 0), version: 2, shown: 1 });
    assert.deepStrictEqual(t.status(), { text: '↻ next (1)', command: 'idris2.nextDefinition' });
    assert.strictEqual(t.api.window.statusItems[0].name, 'Idris 2: Next Result / Next Definition', 'the item\'s name covers both kinds');
    // `g` with the cursor still on the declaration: the next definition.
    assert.deepStrictEqual(await t.run('idris2.generateDefinition'), [{ command: 'idris2.generateDefinition', kind: 'applied', uri: t.uri }]);
    assert.deepStrictEqual(t.backend.requests.map((r) => r.kind), ['generateDef', 'generateDefNext']);
    assert.deepStrictEqual(t.doc.lines.slice(4, 9), ['append : Vect n a -> Vect m a -> Vect (n + m) a', ...APPEND_2.split('\n')]);
    assert.deepStrictEqual(t.registration.cycleOf(t.uri)?.range, range(5, 0, 8, 0));
    // In the result.
    t.api.window.showAt(t.doc, 6, 3);
    await t.run('idris2.generateDefinition');
    assert.deepStrictEqual(t.backend.requests.map((r) => r.kind), ['generateDef', 'generateDefNext', 'generateDefNext']);
    // The same result again (zip3 in edits-searches): nothing to change, and the search goes on.
    assert.match(JSON.stringify(await t.run('idris2.nextDefinition')), /Generate Definition gave the result shown again/);
    assert.deepStrictEqual(t.registration.cycleOf(t.uri), { uri: t.uri, kind: 'generateDef', range: range(5, 0, 8, 0), version: 3, shown: 4 });
    assert.strictEqual(t.api.workspace.edits.length, 2);
    // Next Result continues it too: the next definition (here the same again), named as Next Result's.
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [
      { command: 'idris2.nextResult', kind: 'message', message: 'Idris 2: Generate Definition gave the result shown again. Run Next Result for the one after it.' },
    ]);
    assert.deepStrictEqual(t.backend.requests.map((r) => r.kind), ['generateDef', 'generateDefNext', 'generateDefNext', 'generateDefNext', 'generateDefNext']);
    assert.strictEqual(t.registration.cycleOf(t.uri)?.shown, 5);
  });

  test('`g` in a Proof Search cycle\'s result is Generate Definition, not a continuation: it reads its target and sends no -Next', async () => {
    const t = setUp();
    await t.searchVlen(() => Promise.reject(new Error('not asked')));
    const sent = t.backend.requests.length;
    t.api.window.showAt(t.doc, 7, 10);
    assert.match(JSON.stringify(await t.run('idris2.generateDefinition')), /type declaration/);
    assert.strictEqual(t.backend.requests.length, sent);
    assert.strictEqual(t.registration.cycleOf(t.uri)?.kind, 'exprSearch');
  });

  test('`g` at the start of the declaration right below the result (which ends with a line break) generates that one, not the next definition', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const registration = registerEditing(api.asApi(), editingDeps(backend).deps, { keepOutcomes: true, cancelOfferMs: 60_000 });
    const text = 'module M\n\nappend : List a -> List a -> List a\nzip3 : List a -> List b -> List c -> List (a, b, c)\n';
    const doc = api.workspace.open(new FakeTextDoc({ fileName: '/w/M.idr', text }));
    backend.answer = (req) =>
      req.kind === 'generateDef' && req.name === 'append'
        ? edit(rep(3, 0, 3, 0, 'append [] ys = ys\nappend (x :: xs) ys = x :: append xs ys\n'))
        : req.kind === 'generateDef' && req.name === 'zip3'
          ? edit(rep(6, 0, 6, 0, 'zip3 = ?zip\n'))
          : Promise.reject(new Error(req.kind));
    api.window.showAt(doc, 2, 3);
    await api.run('idris2.generateDefinition');
    assert.deepStrictEqual(registration.cycleOf(doc.uri.toString())?.range, range(3, 0, 5, 0));
    api.window.showAt(doc, 5, 0);
    await api.run('idris2.generateDefinition');
    assert.deepStrictEqual(backend.requests.map((r) => [r.kind, (r as EditRequest & { name?: string }).name]), [['generateDef', 'append'], ['generateDef', 'zip3']]);
    // At the end of the result's last line, the result's: the next definition.
    backend.answer = (req) => (req.kind === 'generateDefNext' ? edit({ range: req.previous, text: 'zip3 [] _ _ = []\n' }) : Promise.reject(new Error(req.kind)));
    api.window.showAt(doc, 6, 11);
    await api.run('idris2.generateDefinition');
    assert.strictEqual(backend.requests.at(-1)?.kind, 'generateDefNext');
  });

  test('a change the controller did not make ends the cycle (an undo too); Next then says so and sends nothing', async () => {
    const t = setUp();
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    t.api.workspace.type(t.doc, new FakeRange(0, 12, 0, 12), ' ');
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    assert.strictEqual(t.status(), undefined);
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /the Proof Search ended: the file was changed after its last result/);
    assert.strictEqual(t.backend.requests.length, 1);
  });

  test('a load of the root ends the cycle (the compiler\'s search is reset); a load of another root does not', async () => {
    const t = setUp();
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    t.env.loads.fire({ root: looseRoot('/elsewhere'), file: '/elsewhere/A.idr', rebuilt: true });
    assert.strictEqual(t.registration.cycleOf(t.uri)?.shown, 1);
    t.env.loads.fire({ root: looseRoot('/w/broken'), file: '/w/broken/Other.idr', rebuilt: false });
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /a file of its project was loaded again/);
  });

  test('a load between the search\'s answer and its result being applied: no cycle starts', async () => {
    const t = setUp();
    t.api.workspace.beforeApply = () => t.env.loads.fire({ root: looseRoot('/w/broken'), file: '/w/broken/Clean.idr', rebuilt: false });
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 0', 'the result is applied');
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /loaded again/);
  });

  test('Next Result while the search\'s first request is out says the search is still running (not that it ended), and sends nothing', async () => {
    const t = setUp();
    // An earlier cycle of the document, whose result leaves a hole to search again.
    t.backend.answer = () => edit(rep(7, 10, 7, 19, 'S ?vlen_rhs'));
    await t.run('idris2.proofSearch');
    assert.strictEqual(t.registration.cycleOf(t.uri)?.kind, 'exprSearch');
    t.api.window.showAt(t.doc, 7, 14);
    let answer: (r: EditResult) => void = () => undefined;
    t.backend.answer = () => new Promise<EditResult>((resolve) => (answer = resolve));
    const searching = t.run('idris2.proofSearch');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const asked = t.backend.requests.length;
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /Proof Search is still running for this file; once its result is shown, run Next Result for the next one/);
    assert.strictEqual(t.backend.requests.length, asked);
    answer({ type: 'edit', replacements: [rep(7, 12, 7, 21, '2')] });
    await searching;
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = S 2');
    assert.strictEqual(t.registration.cycleOf(t.uri)?.kind, 'exprSearch');
    t.backend.answer = (req) => edit({ range: (req as NextRequest).previous, text: '3' });
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'applied', uri: t.uri }]);
  });

  test('another search in the root ends the cycles of its documents; closing the document forgets its cycle', async () => {
    const t = setUp();
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    const other = t.api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Other.idr', text: 'module Other\n\nf : Nat\nf = ?f_rhs\n' }));
    t.api.window.showAt(other, 3, 5);
    assert.strictEqual(t.status(), undefined, 'the item follows the active editor');
    t.backend.answer = () => Promise.resolve({ type: 'failed', message: 'No search results' });
    await t.run('idris2.proofSearch');
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    t.api.window.showAt(t.doc, 7, 12);
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /another search started in its project/);

    const u = setUp();
    await u.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    u.api.workspace.close(u.doc);
    assert.strictEqual(u.registration.cycleOf(u.uri), undefined);
    assert.strictEqual(u.status(), undefined);
  });

  test('a cycle holds its document\'s save checks (auto-save would load it and end the cycle); every end releases the hold, once', async () => {
    const released = (t: ReturnType<typeof setUp>): boolean[] => t.env.holds.map((h) => h.released);
    const t = setUp();
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    assert.deepStrictEqual(t.env.holds, [{ uri: t.uri, released: false }]);
    await t.run('idris2.nextResult');
    assert.deepStrictEqual(released(t), [false], 'a next result keeps it');
    t.api.workspace.type(t.doc, new FakeRange(0, 12, 0, 12), ' ');
    assert.deepStrictEqual(released(t), [true], 'changed');
    const ends: ((u: ReturnType<typeof setUp>) => unknown)[] = [
      (u) => u.env.loads.fire({ root: looseRoot('/w/broken'), file: '/w/broken/Other.idr', rebuilt: false }),
      (u) => u.api.workspace.close(u.doc),
      (u) => u.registration.dispose(),
    ];
    for (const end of ends) {
      const u = setUp();
      await u.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
      end(u);
      assert.deepStrictEqual(released(u), [true], String(end));
    }
    // A new search's first result: the old cycle's hold released, a new one taken.
    const v = setUp();
    await v.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    v.backend.answer = () => edit(rep(7, 10, 7, 11, '2'));
    v.api.window.showAt(v.doc, 7, 10);
    v.doc.lines[7] = 'vlen xs = ?vlen_rhs';
    await v.run('idris2.proofSearch');
    assert.deepStrictEqual(released(v), [true, false]);
  });

  test('the status item follows the active editor', async () => {
    const t = setUp();
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    const other = t.api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Other.idr', text: 'module Other\n' }));
    t.api.window.showAt(other, 0, 0);
    assert.strictEqual(t.status(), undefined);
    assert.strictEqual(t.registration.statusText(), undefined);
    t.api.window.showAt(t.doc, 7, 10);
    assert.deepStrictEqual(t.status(), { text: '↻ next (1)', command: 'idris2.nextResult' });
  });

  test('Next never saves and never loads, whatever the setting; it continues the active editor\'s document only', async () => {
    const t = setUp();
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    assert.ok(t.doc.isDirty);
    const runs = t.env.queries.runs.length;
    await t.run('idris2.nextResult');
    assert.strictEqual(t.doc.saves, 0);
    assert.ok(t.doc.isDirty);
    assert.strictEqual(t.env.queries.runs.length, runs, 'Next asked through DocumentQueries, which may load');
    t.api.window.activeTextEditor = undefined;
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /Next Result continues Proof Search or Generate Definition in the active Idris file/);
    t.api.window.showAt(t.doc, 7, 10);
    t.env.settings.trusted = false;
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /Restricted Mode/);
    assert.strictEqual(t.backend.requests.length, 2);
  });

  test('a refused Next (the backend\'s search ended), a failure, a cancel: the cycle ends, and the next command says why', async () => {
    const t = setUp();
    await t.searchVlen(() => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'The search ended: the file was loaded since.' })));
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /Next Result: The search ended: the file was loaded since\./);
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /its last request failed/);

    const c = setUp();
    await c.searchVlen(() => Promise.reject(cancelled('Cancelled')));
    assert.deepStrictEqual(await c.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'cancelled' }]);
    assert.match(JSON.stringify(await c.run('idris2.nextResult')), /its last request was cancelled/);
  });

  test('one editing command at a time per document: Generate Definition pressed again while its request is out (or Case Split) sends nothing and says so; pressed once its result is shown, the next one', async () => {
    const t = setUp(4, 3);
    let answer: (r: EditResult) => void = () => undefined;
    t.backend.answer = (req) =>
      req.kind === 'generateDef'
        ? new Promise<EditResult>((resolve) => (answer = resolve))
        : req.kind === 'generateDefNext'
          ? edit({ range: req.previous, text: APPEND_2 })
          : Promise.reject(new Error(req.kind));
    const first = t.run('idris2.generateDefinition');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(t.backend.requests.map((r) => r.kind), ['generateDef']);
    assert.deepStrictEqual(await t.run('idris2.generateDefinition'), [
      { command: 'idris2.generateDefinition', kind: 'message', message: 'Idris 2: Generate Definition is still running for this file; once its result is shown, run Next Result for the next one.' },
    ]);
    // Not "run it again": on another declaration it would start a Generate Definition there.
    t.api.window.showAt(t.doc, 6, 2);
    assert.deepStrictEqual(await t.run('idris2.generateDefinition'), [
      { command: 'idris2.generateDefinition', kind: 'message', message: 'Idris 2: Generate Definition is still running for this file; once its result is shown, run Next Result for the next one.' },
    ]);
    t.api.window.showAt(t.doc, 7, 5);
    assert.deepStrictEqual(await t.run('idris2.caseSplit'), [
      { command: 'idris2.caseSplit', kind: 'message', message: 'Idris 2: Generate Definition is still running for this file; run Case Split once it has finished.' },
    ]);
    assert.deepStrictEqual(t.backend.requests.map((r) => r.kind), ['generateDef'], 'nothing more sent');
    answer({ type: 'edit', replacements: [rep(5, 0, 5, 0, APPEND_1)] });
    assert.deepStrictEqual((await first).at(-1), { command: 'idris2.generateDefinition', kind: 'applied', uri: t.uri });
    assert.strictEqual(t.registration.cycleOf(t.uri)?.kind, 'generateDef', 'the first result starts the cycle');
    t.api.window.showAt(t.doc, 4, 3);
    await t.run('idris2.generateDefinition');
    assert.deepStrictEqual(t.backend.requests.map((r) => r.kind), ['generateDef', 'generateDefNext']);
    assert.deepStrictEqual(t.doc.lines.slice(5, 8), APPEND_2.split('\n').slice(0, 3));
  });

  test('a Next whose kind is not the file\'s cycle says which cycle it is and how to continue it; a Next while another command runs for the file waits for it', async () => {
    const t = setUp();
    await t.searchVlen(() => Promise.reject(new Error('not asked')));
    const sent = t.backend.requests.length;
    assert.match(JSON.stringify(await t.run('idris2.nextDefinition')), /this file's cycle is Proof Search's: run Next Result, or click ↻ next in the status bar\./);
    let answer: (r: EditResult) => void = () => undefined;
    t.backend.answer = () => new Promise<EditResult>((resolve) => (answer = resolve));
    t.api.window.showAt(t.doc, 7, 5);
    const split = t.run('idris2.caseSplit');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No advice: Case Split loads the file (the result applied changed it), which ends the cycle (review of the fixes).
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'message', message: 'Idris 2: Case Split is still running for this file.' }]);
    assert.deepStrictEqual(await t.run('idris2.nextDefinition'), [{ command: 'idris2.nextDefinition', kind: 'message', message: 'Idris 2: Case Split is still running for this file.' }]);
    assert.deepStrictEqual(t.backend.requests.slice(sent).map((r) => r.kind), ['caseSplit']);
    answer({ type: 'failed', message: 'no' });
    await split;
  });

  test('Next Definition while Next Result runs in a Proof Search cycle: told to run Next Result once it has finished, not itself (review of the decisions of 2026-10-01)', async () => {
    const t = setUp();
    let release: (() => void) | undefined;
    await t.searchVlen((req) => new Promise((resolve) => (release = () => resolve({ type: 'edit', replacements: [{ range: (req as NextRequest).previous, text: '1' }] }))));
    const first = t.run('idris2.nextResult');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(await t.run('idris2.nextDefinition'), [
      {
        command: 'idris2.nextDefinition',
        kind: 'message',
        message: "Idris 2: Next Result is still running for this file, and this file's cycle is Proof Search's: once it has finished, run Next Result.",
      },
    ]);
    // Next Result itself again: the plain message; neither sent anything.
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /Idris 2: Next Result is still running for this file\./);
    assert.strictEqual(t.backend.requests.length, 2);
    release?.();
    await first;
    assert.match(JSON.stringify(await t.run('idris2.nextDefinition')), /this file's cycle is Proof Search's: run Next Result/);
    // A search that runs (saving, before it ends the file's cycles) keeps its own advice.
    let pressed: Promise<unknown> | undefined;
    t.api.window.showAt(t.doc, 4, 2);
    t.doc.isDirty = true;
    t.doc.onSave = () => (pressed ??= t.run('idris2.nextDefinition'));
    t.backend.answer = () => edit(rep(5, 0, 5, 0, APPEND_1));
    await t.run('idris2.generateDefinition');
    assert.match(JSON.stringify(await pressed), /Idris 2: Generate Definition is still running for this file; once its result is shown, run Next Definition for the next one\./);
  });

  test('one Next at a time per document: pressed again while its request is out, it says so and sends nothing', async () => {
    const t = setUp();
    let release: (() => void) | undefined;
    await t.searchVlen((req) => new Promise((resolve) => (release = () => resolve({ type: 'edit', replacements: [{ range: (req as NextRequest).previous, text: '1' }] }))));
    const first = t.run('idris2.nextResult');
    await new Promise((resolve) => setImmediate(resolve));
    await t.run('idris2.nextResult');
    assert.strictEqual(t.backend.requests.length, 2);
    release?.();
    await first;
    assert.deepStrictEqual(t.registration.outcomes.slice(-2), [
      { command: 'idris2.nextResult', kind: 'message', message: 'Idris 2: Next Result is still running for this file.' },
      { command: 'idris2.nextResult', kind: 'applied', uri: t.uri },
    ]);
    assert.strictEqual(t.registration.cycleOf(t.uri)?.shown, 2);
  });

  test('a user\'s change that lands while the next result is applied: not applied, the cycle ends', async () => {
    const t = setUp();
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    t.api.workspace.beforeApply = () => t.api.workspace.type(t.doc, new FakeRange(0, 12, 0, 12), ' ');
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /the file changed while the compiler worked/);
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 0');
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
  });

  test('a user\'s change while the Next request is out: its answer, for the version the cycle had, is not applied; said so', async () => {
    const t = setUp();
    let release: (() => void) | undefined;
    await t.searchVlen((req) => new Promise((resolve) => (release = () => resolve({ type: 'edit', replacements: [{ range: (req as NextRequest).previous, text: '1' }] }))));
    const next = t.run('idris2.nextResult');
    await new Promise((resolve) => setImmediate(resolve));
    t.api.workspace.type(t.doc, new FakeRange(0, 12, 0, 12), ' ');
    release?.();
    assert.match(JSON.stringify(await next), /the file changed while the compiler worked/);
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 0', 'the previous result stays; the answer lands nowhere');
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
  });

  test('two searches out at once in one project (two files): the first one\'s result starts no cycle (the compiler\'s search is the second\'s), so no Next continues the wrong one', async () => {
    const t = setUp();
    const doc = t.api.workspace.open(new FakeTextDoc({ fileName: '/w/T.idr', text: ['module T', '', 'f : Nat -> Nat', 'f n = ?h1', ''].join('\n') }));
    const other = t.api.workspace.open(new FakeTextDoc({ fileName: '/w/U.idr', text: ['module U', '', 'g : Nat -> Nat', 'g n = ?h2', ''].join('\n') }));
    const uri = doc.uri.toString();
    const pending: ((r: EditResult) => void)[] = [];
    t.backend.answer = (req) =>
      req.kind === 'exprSearch' ? new Promise((resolve) => pending.push(resolve)) : edit({ range: (req as NextRequest).previous, text: 'NEXT' });
    t.api.window.showAt(doc, 3, 7); // ?h1
    const first = t.run('idris2.proofSearch');
    await new Promise((resolve) => setTimeout(resolve, 10));
    t.api.window.showAt(other, 3, 7); // ?h2, asked before ?h1's answer
    const second = t.run('idris2.proofSearch');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(pending.length, 2);
    pending[0]({ type: 'edit', replacements: [rep(3, 6, 3, 9, 'n')] });
    assert.deepStrictEqual((await first).map((o) => o.kind), ['applied']);
    assert.strictEqual(t.registration.cycleOf(uri), undefined);
    pending[1]({ type: 'edit', replacements: [rep(3, 6, 3, 9, 'S n')] });
    assert.deepStrictEqual((await second).at(-1), { command: 'idris2.proofSearch', kind: 'applied', uri: other.uri.toString() });
    assert.strictEqual(t.registration.cycleOf(other.uri.toString())?.kind, 'exprSearch', 'the second search\'s cycle');
    t.api.window.showAt(doc, 3, 6);
    assert.match(JSON.stringify(await t.run('idris2.nextResult')), /another search started in its project/);
    assert.ok(!t.backend.requests.some((r) => r.kind === 'exprSearchNext'), 'no Next sent');
    assert.strictEqual(doc.lineAt(3).text, 'f n = n');
  });

  test('a user\'s change right after a result was applied, before applyEdit resolved (two changes): no cycle starts, and a cycle ends', async () => {
    const first = setUp();
    first.api.workspace.afterApply = () => first.api.workspace.type(first.doc, new FakeRange(0, 12, 0, 12), ' ');
    await first.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    assert.strictEqual(first.doc.lineAt(7).text, 'vlen xs = 0');
    assert.strictEqual(first.registration.cycleOf(first.uri), undefined, 'the first result\'s change was not alone');
    // Next Result says why, not "run Proof Search first" (acceptance review of M4).
    const sent = first.backend.requests.length;
    await first.run('idris2.nextResult');
    assert.strictEqual(first.lastMessage(), 'Idris 2: the Proof Search ended: the file was changed after its last result. Run Proof Search again.');
    assert.strictEqual(first.backend.requests.length, sent);
    const next = setUp();
    await next.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    assert.ok(next.registration.cycleOf(next.uri) !== undefined);
    next.api.workspace.afterApply = () => next.api.workspace.type(next.doc, new FakeRange(0, 12, 0, 12), ' ');
    await next.run('idris2.nextResult');
    assert.strictEqual(next.doc.lineAt(7).text, 'vlen xs = 1');
    assert.strictEqual(next.registration.cycleOf(next.uri), undefined, 'the next result\'s change was not alone');
  });

  test('the change of an applied result that reaches the extension after applyEdit resolved: the cycle does not go on (conservative)', async () => {
    const t = setUp();
    t.api.workspace.lateEvents = true;
    await t.searchVlen(() => edit(rep(7, 10, 7, 11, '1')));
    assert.strictEqual(t.doc.lineAt(7).text, 'vlen xs = 0');
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
  });

  test('Next Result continues a Generate Definition cycle (ROADMAP §9 Q26): generateDefNext with the cycle\'s range and version, never a Proof Search\'s; its own undo step, no save, no load; no more results ends it', async () => {
    const t = setUp(4, 3);
    const nexts = [APPEND_2];
    t.backend.answer = (req) => {
      if (req.kind === 'generateDef') {
        return edit(rep(5, 0, 5, 0, APPEND_1));
      }
      if (req.kind !== 'generateDefNext') {
        return Promise.reject(new Error(`${req.kind} sent in a Generate Definition cycle`));
      }
      const text = nexts.shift();
      return text === undefined ? Promise.resolve({ type: 'exhausted' }) : edit({ range: req.previous, text });
    };
    await t.run('idris2.generateDefinition');
    // Away from the declaration and its result: Next Result follows the file's cycle, not the cursor.
    t.api.window.showAt(t.doc, 0, 0);
    const runs = t.env.queries.runs.length;
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'applied', uri: t.uri }]);
    const next = t.backend.requests[1] as NextRequest;
    assert.deepStrictEqual({ kind: next.kind, version: next.version, previous: next.previous, doc: next.doc }, { kind: 'generateDefNext', version: 2, previous: range(5, 0, 7, 0), doc: t.doc });
    assert.ok(next.token !== undefined, 'a long request has a token');
    assert.deepStrictEqual(t.doc.lines.slice(4, 9), ['append : Vect n a -> Vect m a -> Vect (n + m) a', ...APPEND_2.split('\n')]);
    assert.deepStrictEqual(t.registration.cycleOf(t.uri), { uri: t.uri, kind: 'generateDef', range: range(5, 0, 8, 0), version: 3, shown: 2 });
    assert.deepStrictEqual(t.status(), { text: '↻ next (2)', command: 'idris2.nextDefinition' }, 'the status-bar item stays');
    assert.strictEqual(t.api.workspace.edits.length, 2, 'each result its own WorkspaceEdit (one undo step each)');
    assert.strictEqual(t.doc.saves, 0);
    assert.strictEqual(t.env.queries.runs.length, runs, 'Next Result asked through DocumentQueries, which may load');
    // No more results: said as Generate Definition's; the cycle ends, and the next command says why.
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'message', message: 'Idris 2: Generate Definition has no more results.' }]);
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    assert.strictEqual(t.status(), undefined);
    const sent = t.backend.requests.length;
    for (const command of ['idris2.nextResult', 'idris2.nextDefinition'] as const) {
      assert.deepStrictEqual(await t.run(command), [
        { command, kind: 'message', message: 'Idris 2: the Generate Definition ended: there were no more results. Run Generate Definition again.' },
      ]);
    }
    assert.strictEqual(t.backend.requests.length, sent, 'nothing is sent without a cycle');
  });

  test('the backend\'s refusal of a next definition (which names Next Definition) is said by Next Result, Next Definition and `g` each under its own name, once; a Proof Search\'s as before', async () => {
    const rest = 'the Generate Definition it would continue has ended — the file was loaded again, another Generate Definition was started, or the compiler was restarted since. Run Generate Definition again.';
    const cases = [
      ['idris2.nextResult', 0, 0, 'Next Result'],
      ['idris2.nextDefinition', 0, 0, 'Next Definition'],
      ['idris2.generateDefinition', 4, 3, 'Generate Definition'],
    ] as const;
    for (const [command, line, character, name] of cases) {
      const t = setUp(4, 3);
      t.backend.answer = (req) =>
        req.kind === 'generateDef' ? edit(rep(5, 0, 5, 0, APPEND_1)) : Promise.reject(new IdrisException({ kind: 'Unsupported', reason: `Next Definition: ${rest}` }));
      await t.run('idris2.generateDefinition');
      t.api.window.showAt(t.doc, line, character);
      assert.deepStrictEqual(await t.run(command), [{ command, kind: 'message', message: `Idris 2: ${name}: ${rest}` }]);
      assert.deepStrictEqual(t.backend.requests.map((r) => r.kind), ['generateDef', 'generateDefNext']);
      assert.strictEqual(t.registration.cycleOf(t.uri), undefined, command);
    }
    const p = setUp();
    const search = 'the Proof Search it would continue has ended — the file was loaded again. Run Proof Search again.';
    await p.searchVlen(() => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: `Next Result: ${search}` })));
    assert.deepStrictEqual(await p.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'message', message: `Idris 2: Next Result: ${search}` }]);
  });

  test('while a search runs, the search again or a Next command is told what gets the next result once the first is shown: Next Result for either search, Next Definition for a Generate Definition', async () => {
    const t = setUp(4, 3);
    let answer: (r: EditResult) => void = () => undefined;
    t.backend.answer = () => new Promise<EditResult>((resolve) => (answer = resolve));
    const first = t.run('idris2.generateDefinition');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const running = 'Idris 2: Generate Definition is still running for this file; once its result is shown,';
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [{ command: 'idris2.nextResult', kind: 'message', message: `${running} run Next Result for the next one.` }]);
    assert.deepStrictEqual(await t.run('idris2.nextDefinition'), [{ command: 'idris2.nextDefinition', kind: 'message', message: `${running} run Next Definition for the next one.` }]);
    answer({ type: 'failed', message: 'no' });
    await first;
    const p = setUp();
    p.backend.answer = () => new Promise<EditResult>((resolve) => (answer = resolve));
    const searching = p.run('idris2.proofSearch');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(await p.run('idris2.nextDefinition'), [
      { command: 'idris2.nextDefinition', kind: 'message', message: 'Idris 2: Proof Search is still running for this file; once its result is shown, run Next Result for the next one.' },
    ]);
    answer({ type: 'failed', message: 'no' });
    await searching;
    assert.strictEqual(t.backend.requests.length + p.backend.requests.length, 2, 'nothing more sent');
  });

  test('without a cycle it continues, a Next command says what it continues; the reason a cycle ended goes only to a command that continues its kind', async () => {
    const t = setUp();
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [
      { command: 'idris2.nextResult', kind: 'message', message: 'Idris 2: Next Result continues a Proof Search or Generate Definition: run Proof Search or Generate Definition first.' },
    ]);
    const nextDefinitionFirst = [
      { command: 'idris2.nextDefinition', kind: 'message', message: 'Idris 2: Next Definition continues a Generate Definition: run Generate Definition first.' },
    ];
    assert.deepStrictEqual(await t.run('idris2.nextDefinition'), nextDefinitionFirst);
    // A Proof Search cycle that ended: Next Result says why; Next Definition does not take it for its own.
    await t.searchVlen(() => Promise.resolve({ type: 'exhausted' }));
    await t.run('idris2.nextResult');
    assert.strictEqual(t.registration.cycleOf(t.uri), undefined);
    assert.deepStrictEqual(await t.run('idris2.nextResult'), [
      { command: 'idris2.nextResult', kind: 'message', message: 'Idris 2: the Proof Search ended: there were no more results. Run Proof Search again.' },
    ]);
    assert.deepStrictEqual(await t.run('idris2.nextDefinition'), nextDefinitionFirst);
    // A Generate Definition cycle that a change ended: both say why, and nothing is sent.
    const g = setUp(4, 3);
    g.backend.answer = (req) => (req.kind === 'generateDef' ? edit(rep(5, 0, 5, 0, APPEND_1)) : Promise.reject(new Error(req.kind)));
    await g.run('idris2.generateDefinition');
    g.api.workspace.type(g.doc, new FakeRange(0, 12, 0, 12), ' ');
    for (const command of ['idris2.nextResult', 'idris2.nextDefinition'] as const) {
      assert.deepStrictEqual(await g.run(command), [
        { command, kind: 'message', message: 'Idris 2: the Generate Definition ended: the file was changed after its last result. Run Generate Definition again.' },
      ]);
    }
    assert.deepStrictEqual(g.backend.requests.map((r) => r.kind), ['generateDef']);
  });
});
