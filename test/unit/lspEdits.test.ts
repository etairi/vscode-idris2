// backend/lsp/edits.ts through LspBackend.edit, over the recordings of idris2-lsp 0.1.0-9a2f0ad6a
// (test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a): the requests are the recorded ones (ReplayClient
// answers only those), the answers are applied by M4's rules (always bracket, Make Case's bracketed
// form, IDE mode's places), the refusals made before anything is sent are the ones the server's limits
// need, and an answer that is not for the place asked, or of another document, is not applied. That
// IDE mode gives the same text is test/unit/contract.test.ts.
import * as assert from 'assert';
import * as fs from 'fs';
import type * as vscode from 'vscode';
import type { EditRequest, EditResult } from '../../src/backend/types';
import { editorLines } from '../../src/core/positions';
import { IdrisException } from '../../src/core/errors';
import { FakeDocument } from './support/intelligence';
import { appliedText, backendOver, followed, LSP_ROOT, lspDocument, lspExchanges, recordedResult, recordedWorkspace, replayBackend, ReplayClient, ScriptedClient } from './support/lspReplies';

const asDoc = (doc: FakeDocument): vscode.TextDocument => doc as unknown as vscode.TextDocument;
const pos = (line: number, character: number): vscode.Position => ({ line, character }) as vscode.Position;

/** The error `promise` rejects with, of `kind`; its message. */
async function rejection(promise: Promise<unknown>, kind: string): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof IdrisException && error.error.kind === kind, String(error));
    return error.message;
  }
  assert.fail('not rejected');
}

/** The first line of `result` applied to `doc`'s text, at `line`, and the next `count - 1`. */
const linesAfter = (doc: FakeDocument, result: EditResult, line: number, count = 1): string[] => appliedText(doc.getText(), result).split('\n').slice(line, line + count);

/** A document whose lines are `text`'s as the editor breaks them (a lone `\r` too), with a reader of the same text. */
function editorDocument(fileName: string, text: string): { readonly doc: vscode.TextDocument; readonly readFile: (p: string) => Promise<string> } {
  const lines = editorLines(text);
  const doc = {
    uri: { scheme: 'file', fsPath: fileName, path: fileName, query: '', toString: () => `file://${fileName}` },
    fileName,
    languageId: fileName.endsWith('.lidr') ? 'lidr' : 'idris2',
    isUntitled: false,
    isDirty: false,
    version: 1,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] }),
    getText: () => lines.join('\n'),
  };
  return { doc: doc as unknown as vscode.TextDocument, readFile: () => Promise.resolve(text) };
}

suite('backend/lsp/edits: the edits over idris2-lsp, under M4\'s rules', () => {
  suite('the recorded answers, applied by M4\'s rules', () => {
    test('Intro: one choice per action, a candidate of more than one token in parentheses, as the server printed it in the label', async () => {
      const { backend } = replayBackend('actions-clean');
      const doc = lspDocument('actions-clean', 'src/Clean.idr');
      const r = await backend.edit({ kind: 'intro', doc: asDoc(doc), version: doc.version, pos: pos(7, 10), name: 'vlen_rhs' });
      assert.ok(r.type === 'choices' && r.reason === 'intro');
      assert.deepStrictEqual(r.choices.map((c) => [c.label, c.replacements[0].text]), [['0', '0'], ['S ?vlen_rhs_0', '(S ?vlen_rhs_0)']]);
    });

    test('Intro and Proof Search keep a candidate the compiler bracketed itself as it is (a prefix argument): no second pair', async () => {
      const { backend } = replayBackend('edits-searches');
      const doc = lspDocument('edits-searches', 'src/Edits.idr');
      const intro = await backend.edit({ kind: 'intro', doc: asDoc(doc), version: doc.version, pos: pos(56, 12), name: 'under_rhs' });
      assert.ok(intro.type === 'choices');
      assert.strictEqual(linesAfter(doc, { type: 'edit', replacements: intro.choices[1].replacements }, 56)[0], 'under n = S (S ?under_rhs_0)');
      const lambda = await backend.edit({ kind: 'exprSearch', doc: asDoc(doc), version: doc.version, pos: pos(80, 6), name: 'fun_rhs', hints: [] });
      assert.deepStrictEqual(linesAfter(doc, lambda, 80), ['fun = (\\k => k)']);
    });

    test('Make Lemma: the type above the declaration with the comments above it, the call in parentheses', async () => {
      const { backend } = replayBackend('edits-shapes');
      const doc = lspDocument('edits-shapes', 'src/Edits.idr');
      const r = await backend.edit({ kind: 'makeLemma', doc: asDoc(doc), version: doc.version, pos: pos(26, 16), name: 'go_rhs' });
      // Above the comment right above `sumAll`'s declaration (`lemmaPlace`), with a blank line after it.
      assert.deepStrictEqual(linesAfter(doc, r, 21, 4), ['go_rhs : List Nat -> List Nat -> Nat -> Nat', '', '-- A clause in a where block.', 'sumAll : List Nat -> Nat']);
      assert.strictEqual(linesAfter(doc, r, 28)[0], '    go acc ys = (go_rhs xs ys acc)');
    });

    test('Make Case: the bracketed case, rewritten from the server\'s unbracketed one; on a bird-track line with one marker per line', async () => {
      const clean = replayBackend('actions-clean');
      const doc = lspDocument('actions-clean', 'src/Clean.idr');
      const r = await clean.backend.edit({ kind: 'makeCase', doc: asDoc(doc), version: doc.version, pos: pos(7, 10), name: 'vlen_rhs' });
      assert.deepStrictEqual(linesAfter(doc, r, 7, 2), ['vlen xs = (case _ of', '                case_val => ?vlen_rhs)']);
      const lit = replayBackend('lit2');
      const lidr = lspDocument('lit2', 'src/Lit2.lidr');
      const l = await lit.backend.edit({ kind: 'makeCase', doc: asDoc(lidr), version: lidr.version, pos: pos(8, 12), name: 'vlen_rhs' });
      assert.deepStrictEqual(linesAfter(lidr, l, 8, 2), ['> vlen xs = (case _ of', '>                 case_val => ?vlen_rhs)']);
    });

    test('Make With: the whole clause line replaced, although the server\'s range ends one character short; on a bird-track line the marker once', async () => {
      const clean = replayBackend('actions-clean');
      const doc = lspDocument('actions-clean', 'src/Clean.idr');
      const r = await clean.backend.edit({ kind: 'makeWith', doc: asDoc(doc), version: doc.version, pos: pos(7, 10), name: 'vlen_rhs' });
      assert.deepStrictEqual(linesAfter(doc, r, 7, 3), ['vlen xs with (_)', '  vlen xs | with_pat = ?vlen_rhs_rhs', '']);
      const lit = replayBackend('lit2');
      const lidr = lspDocument('lit2', 'src/Lit2.lidr');
      const l = await lit.backend.edit({ kind: 'makeWith', doc: asDoc(lidr), version: lidr.version, pos: pos(8, 12), name: 'vlen_rhs' });
      assert.deepStrictEqual(linesAfter(lidr, l, 8, 3), ['> vlen xs with (_)', '>   vlen xs | with_pat = ?vlen_rhs_rhs', '>']);
    });

    test('Add Clause: after the function\'s clauses (the server puts it above them, where it is unreachable)', async () => {
      const { backend } = replayBackend('diagnostics');
      const doc = lspDocument('diagnostics', 'src/Part.idr');
      // The server's edit inserts `g k = ?g_rhs` at line 3, above `g 0 = 0` [live, recording `diagnostics`].
      assert.deepStrictEqual((recordedResult('diagnostics', 'textDocument/codeAction', (p) => JSON.stringify(p).includes('AddClause')) as { edit: unknown }[])[0].edit, {
        changes: { [`file://${LSP_ROOT}/src/Part.idr`]: [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, newText: 'g k = ?g_rhs\n' }] },
      });
      const r = await backend.edit({ kind: 'addClause', doc: asDoc(doc), version: doc.version, pos: pos(2, 0), name: 'g' });
      assert.deepStrictEqual(linesAfter(doc, r, 2, 3), ['g : Nat -> Nat', 'g 0 = 0', 'g k = ?g_rhs']);
    });

    test('Add Missing Cases: the quick fix of the declaration\'s coverage error, its clauses after the function\'s (the server: at the first blank line)', async () => {
      const { backend, client } = replayBackend('diagnostics');
      const doc = lspDocument('diagnostics', 'src/Part.idr');
      const r = await backend.edit({ kind: 'addMissingCases', doc: asDoc(doc), version: doc.version, pos: pos(2, 0), name: 'g' });
      assert.deepStrictEqual(linesAfter(doc, r, 3, 3), ['g 0 = 0', 'g (S _) = ?g_missing_case_1', '']);
      assert.deepStrictEqual(client.sent.map((s) => (s.params as { context?: { only?: string[] } }).context?.only), [['quickfix']]);
    });

    test('Add Missing Cases in a namespace: the report under the module and namespace IDE mode\'s plan reads (M.N.f), the clause indented as the declaration', async () => {
      const text = '||| A module.\nmodule M\n\nnamespace N\n  export\n  f : Bool -> Nat\n  f True = 0\n';
      const fix = {
        title: 'QuickFix: Add missing cases',
        kind: 'quickfix',
        diagnostics: [{ range: { start: { line: 5, character: 2 }, end: { line: 5, character: 18 } }, message: 'f is not covering.' }],
        edit: { changes: { [`file://${LSP_ROOT}/src/M.idr`]: [{ range: { start: { line: 7, character: 0 }, end: { line: 7, character: 0 } }, newText: 'f False = ?f_missing_case_1\n' }] } },
      };
      const doc = new FakeDocument(`${LSP_ROOT}/src/M.idr`, text);
      const backend = backendOver(new ScriptedClient(() => [fix]), 'actions-clean', 5, () => Promise.resolve(text));
      const r = await backend.edit({ kind: 'addMissingCases', doc: asDoc(doc), version: doc.version, pos: pos(5, 2), name: 'f' });
      assert.deepStrictEqual(linesAfter(doc, r, 5, 3), ['  f : Bool -> Nat', '  f True = 0', '  f False = ?f_missing_case_1']);
      // A quick fix of another declaration's coverage error (its diagnostic elsewhere) is not taken.
      const elsewhere = { ...fix, diagnostics: [{ ...fix.diagnostics[0], range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } } }] };
      const other = backendOver(new ScriptedClient(() => [elsewhere]), 'actions-clean', 5, () => Promise.resolve(text));
      await rejection(other.edit({ kind: 'addMissingCases', doc: asDoc(doc), version: doc.version, pos: pos(5, 2), name: 'f' }), 'Unsupported');
    });

    test('Add Missing Cases on a declaration without a coverage error: the server has no quick fix, and the refusal says so', async () => {
      // The server answers every quick fix of the file for any position [live]: the recorded ones.
      const fixes = recordedResult('diagnostics', 'textDocument/codeAction', (p) => JSON.stringify(p).includes('quickfix'));
      const backend = backendOver(new ScriptedClient(() => fixes), 'diagnostics');
      const doc = lspDocument('diagnostics', 'src/Part.idr');
      // `main`'s error is "Calls non covering function", whose only quick fix is `Add partial annotation`.
      const reason = await rejection(backend.edit({ kind: 'addMissingCases', doc: asDoc(doc), version: doc.version, pos: pos(5, 0), name: 'main' }), 'Unsupported');
      assert.match(reason, /^Add Missing Cases: idris2-lsp offers missing cases only as the quick fix of a coverage error/u);
    });

    test('columns in code points (E14): a hole after a character outside the BMP is asked and checked at its compiler columns, replaced at its editor ones', async () => {
      const text = 'module M\n\nf : (String, Nat)\nf = ("\u{1D55F}", ?h)\n';
      const doc = new FakeDocument(`${LSP_ROOT}/src/M.idr`, text);
      const intro = (start: number, end: number): object[] => [
        { title: 'Intro S ?h_0 over hole h', kind: 'refactor.rewrite', edit: { changes: { [`file://${LSP_ROOT}/src/M.idr`]: [{ range: { start: { line: 3, character: start }, end: { line: 3, character: end } }, newText: 'S ?h_0' }] } } },
      ];
      const client = new ScriptedClient(() => intro(10, 12));
      const r = await backendOver(client, 'actions-clean', 5, () => Promise.resolve(text)).edit({ kind: 'intro', doc: asDoc(doc), version: doc.version, pos: pos(3, 11), name: 'h' });
      assert.deepStrictEqual((client.sent[0].params as { range: unknown }).range, { start: { line: 3, character: 10 }, end: { line: 3, character: 10 } });
      assert.ok(r.type === 'choices');
      assert.deepStrictEqual(r.choices[0].replacements, [{ range: { start: { line: 3, character: 11 }, end: { line: 3, character: 13 } }, text: '(S ?h_0)' }]);
      // The same range in UTF-16 units is another place to the compiler: not applied.
      await rejection(backendOver(new ScriptedClient(() => intro(11, 13)), 'actions-clean', 5, () => Promise.resolve(text)).edit({ kind: 'intro', doc: asDoc(doc), version: doc.version, pos: pos(3, 11), name: 'h' }), 'Unsupported');
    });

    test('Refine Hole and Proof Search with hints load the document first (documentSymbol), then executeCommand', async () => {
      const symbols = lspExchanges('dirty').find((x) => x.method === 'textDocument/documentSymbol' && x.result !== null)?.result;
      const client = new ReplayClient(lspExchanges('commands-clean'), symbols);
      const backend = backendOver(client, 'commands-clean');
      const doc = lspDocument('commands-clean', 'src/Clean.idr');
      const r = await backend.edit({ kind: 'refine', doc: asDoc(doc), version: doc.version, pos: pos(7, 10), name: 'vlen_rhs', hint: 'S' });
      assert.deepStrictEqual(linesAfter(doc, r, 7), ['vlen xs = (S ?vlen_rhs_0)']);
      assert.deepStrictEqual(client.sent.map((s) => s.method), ['textDocument/documentSymbol', 'workspace/executeCommand']);
    });
  });

  suite('Next Result and Next Definition: the server\'s further results', () => {
    test('Proof Search\'s results one by one, then exhausted when the server gave fewer than idris2.lsp.maxCodeActionResults', async () => {
      const { backend } = replayBackend('edits-searches');
      const doc = lspDocument('edits-searches', 'src/Edits.idr');
      let r = await backend.edit({ kind: 'exprSearch', doc: asDoc(doc), version: doc.version, pos: pos(60, 13), name: 'choose_rhs', hints: [] });
      const seen = [];
      for (;;) {
        assert.strictEqual(r.type, 'edit');
        const replacement = (r as Extract<EditResult, { type: 'edit' }>).replacements[0];
        doc.edit(appliedText(doc.getText(), r));
        seen.push(doc.getText().split('\n')[60]);
        r = await backend.edit({ kind: 'exprSearchNext', doc: asDoc(doc), version: doc.version, previous: followed(replacement) });
        if (r.type === 'exhausted') {
          break;
        }
      }
      assert.deepStrictEqual(seen, ['choose x y = y', 'choose x y = x', 'choose x y = False', 'choose x y = True']);
    });

    test('when the server gave as many results as the limit, the last Next says it may have more (decision 3: say so)', async () => {
      const { backend } = replayBackend('actions-clean', { max: 5 });
      const doc = lspDocument('actions-clean', 'src/Clean.idr');
      let r = await backend.edit({ kind: 'exprSearch', doc: asDoc(doc), version: doc.version, pos: pos(7, 10), name: 'vlen_rhs', hints: [] });
      for (let k = 0; k < 4; k++) {
        const replacement = (r as Extract<EditResult, { type: 'edit' }>).replacements[0];
        doc.edit(appliedText(doc.getText(), r));
        r = await backend.edit({ kind: 'exprSearchNext', doc: asDoc(doc), version: doc.version, previous: followed(replacement) });
      }
      assert.strictEqual(appliedText(doc.getText(), r).split('\n')[7], 'vlen xs = 4');
      const replacement = (r as Extract<EditResult, { type: 'edit' }>).replacements[0];
      doc.edit(appliedText(doc.getText(), r));
      const reason = await rejection(backend.edit({ kind: 'exprSearchNext', doc: asDoc(doc), version: doc.version, previous: followed(replacement) }), 'Unsupported');
      assert.match(reason, /^Next Result: idris2-lsp gives at most idris2\.lsp\.maxCodeActionResults results \(5\), and all of them were shown/u);
    });

    test('Generate Definition\'s numbered actions are the next definitions (the server\'s "Generate next definition" repeats the first)', async () => {
      const { backend } = replayBackend('actions-clean');
      const doc = lspDocument('actions-clean', 'src/Clean.idr');
      const first = await backend.edit({ kind: 'generateDef', doc: asDoc(doc), version: doc.version, pos: pos(4, 0), name: 'append' });
      const replacement = (first as Extract<EditResult, { type: 'edit' }>).replacements[0];
      doc.edit(appliedText(doc.getText(), first));
      const next = await backend.edit({ kind: 'generateDefNext', doc: asDoc(doc), version: doc.version, previous: followed(replacement) });
      assert.deepStrictEqual(appliedText(doc.getText(), next).split('\n').slice(5, 8), ['append [] ys = ys', 'append (x :: xs) [] = x :: append xs []', 'append (x :: xs) (y :: ys) = x :: append xs (x :: ys)']);
    });

    test('a Next is refused for another document, after another search of its kind, after the server restarted, and for a changed version', async () => {
      const { backend, client } = replayBackend('actions-clean');
      const doc = lspDocument('actions-clean', 'src/Clean.idr');
      const first = await backend.edit({ kind: 'exprSearch', doc: asDoc(doc), version: doc.version, pos: pos(7, 10), name: 'vlen_rhs', hints: [] });
      const previous = followed((first as Extract<EditResult, { type: 'edit' }>).replacements[0]);
      doc.edit(appliedText(doc.getText(), first));
      const other = new FakeDocument(`${LSP_ROOT}/src/Other.idr`, doc.getText());
      assert.match(await rejection(backend.edit({ kind: 'exprSearchNext', doc: asDoc(other), version: other.version, previous }), 'Unsupported'), /^Next Result: the search it would continue has ended/u);
      assert.match(await rejection(backend.edit({ kind: 'generateDefNext', doc: asDoc(doc), version: doc.version, previous }), 'Unsupported'), /^Next Definition: the search it would continue has ended/u);
      assert.match(await rejection(backend.edit({ kind: 'exprSearchNext', doc: asDoc(doc), version: doc.version + 1, previous }), 'Unsupported'), /^Next Result: the file changed/u);
      client.fireState();
      assert.match(await rejection(backend.edit({ kind: 'exprSearchNext', doc: asDoc(doc), version: doc.version, previous }), 'Unsupported'), /^Next Result: the search it would continue has ended/u);
    });
  });

  suite('refused before anything is sent', () => {
    const clean = (): { readonly doc: FakeDocument; readonly client: ScriptedClient; readonly backend: ReturnType<typeof backendOver> } => {
      const client = new ScriptedClient(() => assert.fail('nothing may be sent'));
      return { doc: lspDocument('actions-clean', 'src/Clean.idr'), client, backend: backendOver(client, 'actions-clean') };
    };

    test('a name that is not an Idris name (M4\'s hard requirement), checked before the document is read', async () => {
      const { doc, client } = clean();
      let read = 0;
      const backend = backendOver(client, 'actions-clean', 5, () => {
        read++;
        return Promise.resolve(doc.getText());
      });
      for (const req of [
        { kind: 'intro', name: 'vlen_rhs :exec main' },
        { kind: 'caseSplit', name: 'case' },
        { kind: 'addMissingCases', name: 'g\n:t id' },
        { kind: 'exprSearch', name: 'vlen_rhs', hints: ['"; :t id'] },
        { kind: 'refine', name: 'vlen_rhs', hint: 'S) junk' },
      ] as const) {
        await rejection(backend.edit({ ...req, doc: asDoc(doc), version: doc.version, pos: pos(7, 10) } as EditRequest), 'Unsupported');
      }
      assert.strictEqual(read, 0);
      assert.deepStrictEqual(client.sent, []);
    });

    test('a document with unsaved changes, a changed version, or whose file on disk differs', async () => {
      const { doc, client, backend } = clean();
      const req = { kind: 'makeCase', name: 'vlen_rhs', pos: pos(7, 10) } as const;
      assert.match(await rejection(backend.edit({ ...req, doc: asDoc(doc), version: doc.version + 1 }), 'Unsupported'), /the file changed since the command asked/u);
      doc.edit(`${doc.getText()}\n`, false);
      assert.match(await rejection(backend.edit({ ...req, doc: asDoc(doc), version: doc.version }), 'DirtyDocument'), /this document has unsaved changes/u);
      doc.edit(doc.getText().replace('vlen xs', 'vlen ys'), true);
      assert.match(await rejection(backend.edit({ ...req, doc: asDoc(doc), version: doc.version, pos: pos(7, 10) }), 'Unsupported'), /the file on disk is not the text the editor shows/u);
      assert.deepStrictEqual(client.sent, []);
    });

    test('a file with a lone carriage return, a literate file with CRLF breaks: the compiler numbers their lines otherwise', async () => {
      for (const [fileName, text, pattern] of [
        [`${LSP_ROOT}/src/M.idr`, 'module M\n-- a\rb\nf : Nat\nf = ?h\n', /in a file with a carriage return that ends no line/u],
        [`${LSP_ROOT}/src/L.lidr`, '> module L\r\n> f : Nat\r\n> f = ?h\r\n', /in a literate file with CRLF line breaks/u],
      ] as const) {
        const { doc, readFile } = editorDocument(fileName, text);
        const client = new ScriptedClient(() => assert.fail('nothing may be sent'));
        const backend = backendOver(client, 'actions-clean', 5, readFile);
        const line = doc.lineCount - 2;
        const reason = await rejection(backend.edit({ kind: 'intro', doc, version: 1, pos: pos(line, doc.lineAt(line).text.indexOf('?')), name: 'h' }), 'Unsupported');
        assert.match(reason, pattern);
        assert.deepStrictEqual(client.sent, []);
      }
    });

    test('Make Lemma, Make Case and Make With below a bird-track line of a marker and a space (the server would read the next line); Intro is sent', async () => {
      const lidr = lspDocument('lit2', 'src/Lit2.lidr');
      assert.strictEqual(lidr.lineAt(15).text, '> ');
      for (const kind of ['makeLemma', 'makeCase', 'makeWith'] as const) {
        const client = new ScriptedClient(() => assert.fail('nothing may be sent'));
        const reason = await rejection(backendOver(client, 'lit2').edit({ kind, doc: asDoc(lidr), version: lidr.version, pos: pos(17, 11), name: 'half_rhs' }), 'Unsupported');
        assert.match(reason, /is not available over idris2-lsp below line 16, which holds a literate marker followed only by spaces/u);
      }
      const client = new ScriptedClient(() => []);
      await rejection(backendOver(client, 'lit2').edit({ kind: 'intro', doc: asDoc(lidr), version: lidr.version, pos: pos(17, 11), name: 'half_rhs' }), 'Unsupported');
      // Sent at the compiler's line 18 (file line 17 plus the doubled line) and unlit column 9.
      assert.deepStrictEqual((client.sent[0].params as { range: unknown }).range, { start: { line: 18, character: 9 }, end: { line: 18, character: 9 } });
    });

    test('Make With on a hole alone below its clause\'s = (the server rewrites the hole\'s line)', async () => {
      const client = new ScriptedClient(() => assert.fail('nothing may be sent'));
      const doc = lspDocument('edits-shapes', 'src/Edits.idr');
      const reason = await rejection(backendOver(client, 'edits-shapes').edit({ kind: 'makeWith', doc: asDoc(doc), version: doc.version, pos: pos(14, 2), name: 'count_rhs' }), 'Unsupported');
      assert.match(reason, /^Make With: idris2-lsp rewrites the hole's own line, and this hole is on a line of its own below the clause's =/u);
    });
  });

  suite('answers that are not applied', () => {
    const workspace = recordedWorkspace('actions-clean');
    const cleanText = fs.readFileSync(`${workspace}/src/Clean.idr`, 'utf8');
    const uri = `file://${LSP_ROOT}/src/Clean.idr`;
    const introAction = (target: string, range: object, newText = 'S ?vlen_rhs_0', title = 'Intro S ?vlen_rhs_0 over hole vlen_rhs'): object[] => [
      { title, kind: 'refactor.rewrite', edit: { changes: { [target]: [{ range, newText }] } } },
    ];
    const holeRange = { start: { line: 7, character: 10 }, end: { line: 7, character: 19 } };
    const ask = (answer: unknown): Promise<EditResult> => {
      const client = new ScriptedClient(() => answer);
      const doc = new FakeDocument(`${LSP_ROOT}/src/Clean.idr`, cleanText);
      return backendOver(client, 'actions-clean').edit({ kind: 'intro', doc: asDoc(doc), version: doc.version, pos: pos(7, 10), name: 'vlen_rhs' });
    };

    test('the server\'s null (it has unsaved changes of the file) is DirtyDocument', async () => {
      assert.match(await rejection(ask(null), 'DirtyDocument'), /^Intro: idris2-lsp has unsaved changes of this file/u);
    });

    test('an edit of another document, of another range, or of another hole\'s name is refused', async () => {
      assert.match(await rejection(ask(introAction(`file://${LSP_ROOT}/src/Other.idr`, holeRange)), 'Unsupported'), /^Intro: idris2-lsp's answer changes another file than this one/u);
      assert.match(await rejection(ask(introAction(uri, { start: { line: 7, character: 9 }, end: { line: 7, character: 19 } })), 'Unsupported'), /^Intro: idris2-lsp's answer is not for the place asked/u);
      assert.match(await rejection(ask(introAction(uri, holeRange, 'S ?h', 'Intro S ?h over hole other')), 'Unsupported'), /^Intro: idris2-lsp offered no candidate/u);
    });

    test('Make Lemma on a bird-track line: a lemma without the line\'s marker (the server takes it from the line at the compiler\'s number) is not applied, it would be prose', async () => {
      const lidr = lspDocument('lit2', 'src/Lit2.lidr');
      const lemma = (type: string): object[] => [
        {
          title: 'Make lemma for hole ?Lit2.vlen_rhs',
          kind: 'refactor.extract',
          edit: {
            changes: {
              [`file://${LSP_ROOT}/src/Lit2.lidr`]: [
                { range: { start: { line: 7, character: 0 }, end: { line: 7, character: 0 } }, newText: `${type}\n\n` },
                { range: { start: { line: 8, character: 10 }, end: { line: 8, character: 19 } }, newText: 'vlen_rhs xs' },
              ],
            },
          },
        },
      ];
      const req = { kind: 'makeLemma', doc: asDoc(lidr), version: lidr.version, pos: pos(8, 12), name: 'vlen_rhs' } as const;
      assert.match(await rejection(backendOver(new ScriptedClient(() => lemma('vlen_rhs : Vect n a -> Nat')), 'lit2').edit(req), 'Unsupported'), /^Make Lemma: idris2-lsp's answer is not for the place asked/u);
      const marked = await backendOver(new ScriptedClient(() => lemma('> vlen_rhs : Vect n a -> Nat')), 'lit2').edit(req);
      assert.deepStrictEqual(linesAfter(lidr, marked, 7, 3), ['> vlen_rhs : Vect n a -> Nat', '', '> vlen : Vect n a -> Nat']);
    });

    test('an answer of another shape is a ProtocolError', async () => {
      await rejection(ask({ not: 'a list' }), 'ProtocolError');
      await rejection(ask([{ title: 'Intro S over hole vlen_rhs', kind: 'refactor.rewrite', edit: { changes: { [uri]: [{ range: holeRange }] } } }]), 'ProtocolError');
    });

  });
});
