// features/editing/saveBeforeAction.ts: idris2.checking.saveBeforeAction (ARCHITECTURE §11; the
// editing commands run on the saved file). `always` saves silently, `prompt` asks once per run (a
// modal question naming the file, Save or VS Code's Cancel), `never` refuses on a dirty document
// with a message; a document without unsaved changes is never saved; a save that fails ends the
// command. The command flow's use of it is in editing.test.ts.
import * as assert from 'assert';
import type { SaveBeforeAction } from '../../src/core/config';
import { SAVE_BUTTON, saveBeforeAction } from '../../src/features/editing/saveBeforeAction';
import { editingDeps, FakeEditBackend, FakeEditingApi, FakeTextDoc } from './support/editingFakes';
import { registerEditing } from '../../src/features/editing/register';

const dirty = (): FakeTextDoc => new FakeTextDoc({ fileName: '/w/broken/Clean.idr', text: 'module Clean\n', isDirty: true });

suite('features/editing: save before an action', () => {
  test('a document without unsaved changes is left alone under every setting', async () => {
    for (const setting of ['always', 'prompt', 'never'] as SaveBeforeAction[]) {
      const api = new FakeEditingApi();
      const doc = new FakeTextDoc({ fileName: '/w/A.idr', text: 'module A\n' });
      assert.deepStrictEqual(await saveBeforeAction(api.asApi(), doc, setting, 'Case Split'), { kind: 'ready' }, setting);
      assert.strictEqual(doc.saves, 0);
      assert.strictEqual(api.window.messages.length, 0);
    }
  });

  test('always: saves without asking', async () => {
    const api = new FakeEditingApi();
    const doc = dirty();
    assert.deepStrictEqual(await saveBeforeAction(api.asApi(), doc, 'always', 'Case Split'), { kind: 'ready' });
    assert.strictEqual(doc.saves, 1);
    assert.strictEqual(api.window.messages.length, 0);
  });

  test('prompt: one modal question naming the file; Save saves, anything else cancels and saves nothing', async () => {
    const api = new FakeEditingApi();
    const doc = dirty();
    api.window.answer = SAVE_BUTTON;
    assert.deepStrictEqual(await saveBeforeAction(api.asApi(), doc, 'prompt', 'Proof Search'), { kind: 'ready' });
    assert.deepStrictEqual(api.window.messages, [
      { severity: 'info', text: 'Idris 2: Proof Search works on the file as saved. Save “Clean.idr” now?', modal: true, items: ['Save'] },
    ]);
    assert.strictEqual(doc.saves, 1);
    const again = dirty();
    api.window.answer = undefined;
    assert.deepStrictEqual(await saveBeforeAction(api.asApi(), again, 'prompt', 'Proof Search'), { kind: 'cancelled' });
    assert.strictEqual(again.saves, 0);
    assert.ok(again.isDirty);
  });

  test('prompt: a file name that could read as a link or hide characters is shown quoted, written out', async () => {
    const api = new FakeEditingApi();
    const doc = new FakeTextDoc({ fileName: '/w/[x](command:y)\u202E.idr', text: 'module X\n', isDirty: true });
    await saveBeforeAction(api.asApi(), doc, 'prompt', 'Intro');
    assert.strictEqual(api.window.messages[0].text, 'Idris 2: Intro works on the file as saved. Save “[x]\u200B(command:y)\\u{202E}.idr” now?');
  });

  test('never: refuses on a dirty document, saying to save first, and saves nothing', async () => {
    const api = new FakeEditingApi();
    const doc = dirty();
    const outcome = await saveBeforeAction(api.asApi(), doc, 'never', 'Make Lemma');
    assert.deepStrictEqual(outcome, {
      kind: 'refused',
      message: 'Idris 2: save the file first. Make Lemma works on the file as saved, and idris2.checking.saveBeforeAction is "never".',
    });
    assert.strictEqual(doc.saves, 0);
    assert.strictEqual(api.window.messages.length, 0, 'the command shows the message');
  });

  test('a save that does not happen ends the command with a message', async () => {
    const api = new FakeEditingApi();
    const doc = dirty();
    doc.saveResult = false;
    assert.deepStrictEqual(await saveBeforeAction(api.asApi(), doc, 'always', 'Add Clause'), {
      kind: 'refused',
      message: 'Idris 2: the file was not saved, so Add Clause did not run.',
    });
  });

  test('in the command: the setting of the document is read, the save comes before the request, and a declined question sends nothing', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true });
    const doc = api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Clean.idr', text: 'module Clean\n\nf : Nat\nf = ?h\n', isDirty: true }));
    api.window.showAt(doc, 3, 5);
    let savedWhenAsked: boolean | undefined;
    backend.answer = () => {
      savedWhenAsked = !doc.isDirty;
      return Promise.resolve({ type: 'failed', message: 'No search results' });
    };
    await api.run('idris2.proofSearch');
    assert.strictEqual(savedWhenAsked, true);
    doc.isDirty = true;
    env.settings.saveBeforeAction = 'prompt';
    api.window.answer = undefined;
    await api.run('idris2.proofSearch');
    env.settings.saveBeforeAction = 'never';
    await api.run('idris2.proofSearch');
    assert.deepStrictEqual(registration.outcomes.slice(1), [
      { command: 'idris2.proofSearch', kind: 'cancelled' },
      { command: 'idris2.proofSearch', kind: 'message', message: 'Idris 2: save the file first. Proof Search works on the file as saved, and idris2.checking.saveBeforeAction is "never".' },
    ]);
    assert.strictEqual(backend.requests.length, 1);
    assert.strictEqual(doc.saves, 1);
  });

  test('in the command: a save that changes the text at the target (a formatter) stops the command; a change elsewhere does not', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true });
    const doc = api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Clean.idr', text: 'module Clean\n\nf : Nat\nf = ?h\n', isDirty: true }));
    api.window.showAt(doc, 3, 5);
    doc.onSave = () => api.workspace.type(doc, { start: { line: 3, character: 4 }, end: { line: 3, character: 6 } } as never, '?g');
    await api.run('idris2.proofSearch');
    assert.match(JSON.stringify(registration.outcomes), /the file changed at the cursor before Proof Search could ask the compiler/);
    assert.strictEqual(backend.requests.length, 0);
    doc.isDirty = true;
    doc.onSave = () => api.workspace.type(doc, { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } } as never, '-- the end');
    api.window.showAt(doc, 3, 5);
    backend.answer = () => Promise.resolve({ type: 'failed', message: 'x' });
    await api.run('idris2.proofSearch');
    // The hole is where it was: asked there, at the version the save left.
    const req = backend.requests[0];
    assert.ok(req.kind === 'exprSearch');
    assert.deepStrictEqual([req.name, req.pos.line, req.pos.character, req.version], ['g', 3, 4, doc.version]);
    assert.strictEqual(doc.version, 3);
  });

  test('in the command: a save that only trims white space at the end of the target\'s line (files.trimTrailingWhitespace) does not stop it (review of the fixes)', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true });
    const doc = api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Clean.idr', text: 'module Clean\n\nf : Nat\nf = ?h  \n', isDirty: true }));
    api.window.showAt(doc, 3, 5);
    doc.onSave = () => api.workspace.type(doc, { start: { line: 3, character: 6 }, end: { line: 3, character: 8 } } as never, '');
    backend.answer = () => Promise.resolve({ type: 'failed', message: 'x' });
    await api.run('idris2.proofSearch');
    assert.strictEqual(doc.lineAt(3).text, 'f = ?h');
    const req = backend.requests[0];
    assert.ok(req?.kind === 'exprSearch', JSON.stringify(registration.outcomes));
    assert.deepStrictEqual([req.name, req.pos.line, req.pos.character, req.version], ['h', 3, 4, doc.version]);
  });

  test('in the command: a save that removes a line above the target stops it, though the line now there has a name of the same text in that column (review of the decisions of 2026-10-01)', async () => {
    const api = new FakeEditingApi();
    const backend = new FakeEditBackend();
    const env = editingDeps(backend);
    const registration = registerEditing(api.asApi(), env.deps, { keepOutcomes: true });
    const doc = api.workspace.open(new FakeTextDoc({ fileName: '/w/broken/Clean.idr', text: 'module Clean\n\nf : Nat -> Nat -> Nat\n\nf x Z = ?a\nf x (S k) = ?b\n', isDirty: true }));
    api.window.showAt(doc, 4, 2);
    doc.onSave = () => api.workspace.type(doc, { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } } as never, '');
    await api.run('idris2.caseSplit');
    assert.strictEqual(doc.lineAt(4).text, 'f x (S k) = ?b');
    assert.match(JSON.stringify(registration.outcomes), /the file changed at the cursor before Case Split could ask the compiler/);
    assert.strictEqual(backend.requests.length, 0);
  });
});
