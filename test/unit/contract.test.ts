// The contract suite (ROADMAP §5 M4 and M5, ARCHITECTURE §3.3 and §12; the user's decision 3 of
// 2026-10-01): the same edit request on the same fixture, answered by idris2 0.8.0 in IDE mode (the
// transcripts of test/fixtures/transcripts/0.8.0, decoded by backend/ide/edits.ts) and by idris2-lsp
// 0.1.0-9a2f0ad6a (the recordings of test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a, through
// LspBackend), gives the same EditResult: the same text in the same place, or the same refusal. The
// fixtures are byte for byte the same files (`broken/<F>` in IDE mode, `lsp-ipkg/src/<F>` over LSP,
// test/fixtures/lsp-transcripts/README.md). Where the two backends answer differently, the difference
// is pinned in its own test with its reason (docs/as-built/M5.md, *Contract*).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { editText, planEdit, planNext, type EditText } from '../../src/backend/ide/edits';
import { serializeSexp } from '../../src/backend/ide/sexp';
import type { ReplyPayload } from '../../src/backend/ide/types';
import type { EditAtRequest, EditResult, ExprSearchRequest, RefineRequest } from '../../src/backend/types';
import { IdrisException } from '../../src/core/errors';
import { repoRoot } from '../fake-tools/paths';
import { recordedExchanges } from './support/loadReplies';
import { appliedText, followed, lspDocument, replayBackend } from './support/lspReplies';

type AtRequest = EditAtRequest | ExprSearchRequest | RefineRequest;
/** A request without its document and version, which each backend's side fills in. */
type Asked = Omit<EditAtRequest, 'doc' | 'version' | 'pos'> | Omit<ExprSearchRequest, 'doc' | 'version' | 'pos'> | Omit<RefineRequest, 'doc' | 'version' | 'pos'>;

const BROKEN = path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'broken');

/** The IDE-mode transcripts recorded on each fixture of `broken/`. */
const IDE_SCENARIOS: Readonly<Record<string, readonly string[]>> = {
  'Clean.idr': ['clean-editing', 'clean-split-columns'],
  'Edits.idr': ['edits-shapes', 'edits-searches', 'edits-names'],
  'Ambig.idr': ['ambig-refine', 'ambig-holes'],
  'Part.idr': ['part-editing', 'load-part'],
  'Lit2.lidr': ['lit2-editing'],
};

/** The fixture `broken/<file>` as IDE mode's plans see it (the compiler read the same text). */
function ideText(file: string, content?: string): EditText {
  const text = content ?? fs.readFileSync(path.join(BROKEN, file), 'utf8');
  const lines = text.split('\n');
  const fileName = `/fx/broken/${file}`;
  return editText({ fileName, languageId: file.endsWith('.lidr') ? 'lidr' : 'idris2', isUntitled: false, lineCount: lines.length, lineAt: (line) => ({ text: lines[line] }) }, text);
}

/** The recorded IDE-mode answer to `command` (its `nth` sending) in the fixture's transcripts. */
function ideAnswer(file: string, command: string, nth = 0): ReplyPayload {
  const matching = IDE_SCENARIOS[file].flatMap((scenario) => recordedExchanges(scenario, '/fx/broken')).filter((x) => /^\((.*) \d+\)\n$/su.exec(x.request)?.[1] === command);
  assert.ok(matching.length > nth, `${file}: no recorded IDE-mode request ${command}`);
  return matching[nth].reply.payload;
}

/** IDE mode's result of `asked` at `line`:`character` of `broken/<file>`: its plan, decoding the recorded answer. */
function ideResult(file: string, line: number, character: number, asked: Asked, nth = 0): EditResult {
  const plan = planEdit({ ...asked, doc: {} as vscode.TextDocument, version: 1, pos: { line, character } as vscode.Position } as AtRequest, ideText(file));
  return plan.decode(ideAnswer(file, serializeSexp(plan.command), nth));
}

/** idris2-lsp's result of the same request on `src/<file>` of the recording `scenario`, through `LspBackend`. */
async function lspResult(scenario: string, file: string, line: number, character: number, asked: Asked): Promise<EditResult> {
  const { backend } = replayBackend(scenario, { symbols: [] });
  const doc = lspDocument(scenario, `src/${file}`);
  return backend.edit({ ...asked, doc: doc as unknown as vscode.TextDocument, version: doc.version, pos: { line, character } as vscode.Position } as AtRequest);
}

/** The refusal (an `Unsupported` exception) of `f`, sync or async, or a failure of the test. */
async function refusalOf(f: () => unknown): Promise<string> {
  try {
    await f();
  } catch (error) {
    assert.ok(error instanceof IdrisException && error.error.kind === 'Unsupported', String(error));
    return error.message;
  }
  assert.fail('not refused');
}

const at = (kind: EditAtRequest['kind'], name: string): Asked => ({ kind, name });
const search = (name: string, hints: string[] = []): Asked => ({ kind: 'exprSearch', name, hints });
const refine = (name: string, hint: string): Asked => ({ kind: 'refine', name, hint });

/** `[LSP recording, fixture, line, character, request]`: both backends answer, the same EditResult. */
const SAME: readonly (readonly [string, string, number, number, Asked])[] = [
  // Clean.idr, the acceptance fixture (F29, F30).
  ['actions-clean', 'Clean.idr', 7, 5, at('caseSplit', 'xs')],
  ['actions-clean', 'Clean.idr', 4, 0, at('addClause', 'append')],
  ['actions-clean', 'Clean.idr', 7, 10, at('makeLemma', 'vlen_rhs')],
  ['actions-clean', 'Clean.idr', 7, 10, at('makeWith', 'vlen_rhs')],
  ['actions-clean', 'Clean.idr', 7, 10, at('makeCase', 'vlen_rhs')],
  ['actions-clean', 'Clean.idr', 7, 10, at('intro', 'vlen_rhs')],
  ['actions-clean', 'Clean.idr', 7, 10, search('vlen_rhs')],
  ['actions-clean', 'Clean.idr', 4, 0, at('generateDef', 'append')],
  ['commands-clean', 'Clean.idr', 7, 10, refine('vlen_rhs', 'S')],
  // Edits.idr, E15's shapes.
  ['edits-shapes', 'Edits.idr', 7, 0, at('addClause', 'zip3')],
  ['edits-shapes', 'Edits.idr', 14, 2, at('makeLemma', 'count_rhs')],
  ['edits-shapes', 'Edits.idr', 14, 2, at('makeCase', 'count_rhs')],
  ['edits-shapes', 'Edits.idr', 19, 4, at('makeCase', 'step_rhs')],
  ['edits-shapes', 'Edits.idr', 16, 0, at('addClause', 'step')],
  ['edits-shapes', 'Edits.idr', 26, 11, at('caseSplit', 'ys')],
  ['edits-shapes', 'Edits.idr', 25, 4, at('addClause', 'go')],
  ['edits-shapes', 'Edits.idr', 26, 16, at('makeLemma', 'go_rhs')],
  ['edits-shapes', 'Edits.idr', 26, 16, at('makeCase', 'go_rhs')],
  ['edits-shapes', 'Edits.idr', 26, 16, at('makeWith', 'go_rhs')],
  ['edits-shapes', 'Edits.idr', 31, 11, at('caseSplit', 'n')],
  ['edits-shapes', 'Edits.idr', 29, 0, at('addClause', 'classify')],
  ['edits-shapes', 'Edits.idr', 31, 22, at('makeLemma', 'classify_big')],
  ['edits-shapes', 'Edits.idr', 31, 22, at('makeCase', 'classify_big')],
  ['edits-shapes', 'Edits.idr', 31, 22, at('makeWith', 'classify_big')],
  ['edits-shapes', 'Edits.idr', 38, 0, at('caseSplit', 'x')],
  ['edits-shapes', 'Edits.idr', 38, 7, at('caseSplit', 'y')],
  ['edits-shapes', 'Edits.idr', 37, 0, at('addClause', '(<&&>)')],
  ['edits-shapes', 'Edits.idr', 40, 0, at('addClause', '(<||>)')],
  ['edits-shapes', 'Edits.idr', 38, 11, at('makeLemma', 'op_rhs')],
  ['edits-shapes', 'Edits.idr', 38, 11, at('makeCase', 'op_rhs')],
  ['edits-shapes', 'Edits.idr', 38, 11, at('makeWith', 'op_rhs')],
  ['edits-shapes', 'Edits.idr', 44, 27, at('makeLemma', 'let_rhs')],
  ['edits-shapes', 'Edits.idr', 44, 27, at('makeCase', 'let_rhs')],
  ['edits-shapes', 'Edits.idr', 49, 7, at('caseSplit', 'k')],
  ['edits-shapes', 'Edits.idr', 49, 12, at('makeLemma', 'case_just')],
  ['edits-shapes', 'Edits.idr', 49, 12, at('makeCase', 'case_just')],
  ['edits-shapes', 'Edits.idr', 52, 26, at('makeCase', 'inline_rhs')],
  ['edits-shapes', 'Edits.idr', 56, 12, at('makeLemma', 'under_rhs')],
  ['edits-shapes', 'Edits.idr', 56, 12, at('makeCase', 'under_rhs')],
  // Edits.idr, the searches.
  ['edits-searches', 'Edits.idr', 60, 13, search('choose_rhs')],
  ['edits-searches', 'Edits.idr', 69, 10, search('check_rhs')],
  ['edits-searches', 'Edits.idr', 69, 10, search('check_rhs', ['isBig'])],
  ['edits-searches', 'Edits.idr', 77, 11, search('pair_rhs')],
  ['edits-searches', 'Edits.idr', 80, 6, search('fun_rhs')],
  ['edits-searches', 'Edits.idr', 77, 11, at('intro', 'pair_rhs')],
  ['edits-searches', 'Edits.idr', 80, 6, at('intro', 'fun_rhs')],
  ['edits-searches', 'Edits.idr', 74, 0, at('generateDef', 'swap')],
  ['edits-searches', 'Edits.idr', 72, 10, refine('label_rhs', 'describe')],
  ['edits-searches', 'Edits.idr', 77, 11, refine('pair_rhs', 'MkPair')],
  // Edits.idr, a primed and non-ASCII names (E14).
  ['edits-searches', 'Edits.idr', 84, 7, at('caseSplit', "x'")],
  ['edits-searches', 'Edits.idr', 84, 12, at('makeLemma', "h'")],
  ['edits-searches', 'Edits.idr', 84, 12, at('makeCase', "h'")],
  ['edits-searches', 'Edits.idr', 84, 12, at('makeWith', "h'")],
  ['edits-searches', 'Edits.idr', 87, 2, at('caseSplit', 'x₁')],
  ['edits-searches', 'Edits.idr', 87, 7, at('makeLemma', 'ε')],
  ['edits-searches', 'Edits.idr', 87, 7, at('makeCase', 'ε')],
  ['edits-searches', 'Edits.idr', 87, 7, at('makeWith', 'ε')],
  ['edits-searches', 'Edits.idr', 87, 7, at('intro', 'ε')],
  // Lit2.lidr: bird tracks (F11; E1 over LSP), the server's unlit columns.
  ['lit2', 'Lit2.lidr', 8, 7, at('caseSplit', 'xs')],
  ['lit2', 'Lit2.lidr', 10, 4, at('addClause', 'vapp')],
  ['lit2', 'Lit2.lidr', 8, 12, at('makeLemma', 'vlen_rhs')],
  ['lit2', 'Lit2.lidr', 8, 12, at('makeCase', 'vlen_rhs')],
  ['lit2', 'Lit2.lidr', 8, 12, at('makeWith', 'vlen_rhs')],
  ['lit2', 'Lit2.lidr', 8, 12, at('intro', 'vlen_rhs')],
  // Ambig.idr: a qualified name refines (F29).
  ['ambig', 'Ambig.idr', 13, 4, refine('g_rhs', 'A.foo')],
  // Part.idr: the coverage error's missing case (F28).
  ['diagnostics', 'Part.idr', 2, 0, at('addMissingCases', 'g')],
];

/** `[LSP recording, fixture, line, character, request]`: both backends refuse it before sending anything. */
const BOTH_REFUSE: readonly (readonly [string, string, number, number, Asked])[] = [
  // A one-line case's `of` (caseLineProblem).
  ['edits-shapes', 'Edits.idr', 52, 21, at('caseSplit', 'm')],
  // Make With on a `let` binding, a case alternative, an application and a clause whose left-hand side
  // is on the lines above (withClauseStart).
  ['edits-shapes', 'Edits.idr', 44, 27, at('makeWith', 'let_rhs')],
  ['edits-shapes', 'Edits.idr', 49, 12, at('makeWith', 'case_just')],
  ['edits-shapes', 'Edits.idr', 56, 12, at('makeWith', 'under_rhs')],
  ['edits-shapes', 'Edits.idr', 19, 4, at('makeWith', 'step_rhs')],
  // A clause continued over the next line (the line holds no hole).
  ['edits-shapes', 'Edits.idr', 13, 6, at('caseSplit', 'xs')],
  // Below `> ` (counted twice, F11 addendum).
  ['lit2', 'Lit2.lidr', 18, 7, at('caseSplit', 'n')],
];

suite('contract: IDE mode and idris2-lsp give the same edits (decision 3 of 2026-10-01)', () => {
  for (const [scenario, file, line, character, asked] of SAME) {
    test(`${file} ${asked.kind} ${asked.name}${'hint' in asked ? ` ${asked.hint}` : ''}${'hints' in asked && asked.hints.length > 0 ? ` [${asked.hints.join(', ')}]` : ''} at ${line}:${character}`, async () => {
      const ide = ideResult(file, line, character, asked);
      const lsp = await lspResult(scenario, file, line, character, asked);
      assert.deepStrictEqual(lsp, ide);
    });
  }

  for (const [scenario, file, line, character, asked] of BOTH_REFUSE) {
    test(`both refuse ${file} ${asked.kind} ${asked.name} at ${line}:${character}`, async () => {
      await refusalOf(() => ideResult(file, line, character, asked));
      const { backend, client } = replayBackend(scenario, { symbols: [] });
      const doc = lspDocument(scenario, `src/${file}`);
      await refusalOf(() => backend.edit({ ...asked, doc: doc as unknown as vscode.TextDocument, version: doc.version, pos: { line, character } as vscode.Position } as AtRequest));
      assert.deepStrictEqual(client.sent, [], 'nothing was sent to idris2-lsp');
    });
  }

  test('the next results of a proof search are the same: Clean.idr ?vlen_rhs → 0, 1, 2 (E24, same order)', async () => {
    const original = fs.readFileSync(path.join(BROKEN, 'Clean.idr'), 'utf8');
    const first = ideResult('Clean.idr', 7, 10, search('vlen_rhs'));
    const { backend } = replayBackend('actions-clean', { symbols: [] });
    const doc = lspDocument('actions-clean', 'src/Clean.idr');
    const lspFirst = await backend.edit({ kind: 'exprSearch', doc: doc as unknown as vscode.TextDocument, version: doc.version, pos: { line: 7, character: 10 } as vscode.Position, name: 'vlen_rhs', hints: [] });
    assert.deepStrictEqual(lspFirst, first);
    let text = appliedText(original, first);
    let previous = followed((first as Extract<EditResult, { type: 'edit' }>).replacements[0]);
    for (const [nth, expected] of [[0, '1'], [1, '2']] as const) {
      doc.edit(text);
      const ide = planNext('exprSearchNext', ideText('Clean.idr', text), previous).decode(ideAnswer('Clean.idr', ':proof-search-next', nth));
      const lsp = await backend.edit({ kind: 'exprSearchNext', doc: doc as unknown as vscode.TextDocument, version: doc.version, previous });
      assert.deepStrictEqual(lsp, ide);
      text = appliedText(text, ide);
      assert.strictEqual(text.split('\n')[7], `vlen xs = ${expected}`);
      previous = followed((ide as Extract<EditResult, { type: 'edit' }>).replacements[0]);
    }
  });

  suite('where the two answer differently (docs/as-built/M5.md, *Contract*)', () => {
    test('Next Definition: the first definition is the same, the next ones come in another order (E24)', async () => {
      const original = fs.readFileSync(path.join(BROKEN, 'Clean.idr'), 'utf8');
      const first = ideResult('Clean.idr', 4, 0, at('generateDef', 'append'));
      const { backend } = replayBackend('actions-clean', { symbols: [] });
      const doc = lspDocument('actions-clean', 'src/Clean.idr');
      assert.deepStrictEqual(await backend.edit({ kind: 'generateDef', doc: doc as unknown as vscode.TextDocument, version: doc.version, pos: { line: 4, character: 0 } as vscode.Position, name: 'append' }), first);
      const text = appliedText(original, first);
      const previous = followed((first as Extract<EditResult, { type: 'edit' }>).replacements[0]);
      doc.edit(text);
      const ide = appliedText(text, planNext('generateDefNext', ideText('Clean.idr', text), previous).decode(ideAnswer('Clean.idr', ':generate-def-next')));
      const lsp = appliedText(text, await backend.edit({ kind: 'generateDefNext', doc: doc as unknown as vscode.TextDocument, version: doc.version, previous }));
      assert.strictEqual(ide.split('\n')[7], 'append (x :: xs) (y :: ys) = x :: append xs (y :: ys)');
      assert.strictEqual(lsp.split('\n')[7], 'append (x :: xs) (y :: ys) = x :: append xs (x :: ys)');
    });

    test('Generate Definition: idris2-lsp\'s first definition can be another of the compiler\'s than IDE mode\'s first (E24)', async () => {
      // [recording, the declaration's line, its name, the line the definition starts on, IDE mode's first line, idris2-lsp's]
      for (const [scenario, line, name, first, ide, lsp] of [
        ['edits-shapes', 7, 'zip3', 10, 'zip3 [] [] [] = []', 'zip3 [] ys zs = []'],
        ['edits-searches', 40, '(<||>)', 41, 'False <||> y = y', 'x <||> y = y'],
      ] as const) {
        const original = fs.readFileSync(path.join(BROKEN, 'Edits.idr'), 'utf8');
        assert.strictEqual(appliedText(original, ideResult('Edits.idr', line, 0, at('generateDef', name))).split('\n')[first], ide);
        assert.strictEqual(appliedText(original, await lspResult(scenario, 'Edits.idr', line, 0, at('generateDef', name))).split('\n')[first], lsp);
      }
    });

    test('Refine Hole with an ambiguous name: IDE mode offers the qualified alternatives, idris2-lsp answers nothing and the refusal says so (F34)', async () => {
      const ide = ideResult('Ambig.idr', 13, 4, refine('g_rhs', 'foo'));
      assert.deepStrictEqual(
        ide.type === 'choices' ? ide.choices.map((c) => c.label) : ide,
        ['Ambig.A.foo ?g_rhs_0', 'Ambig.B.foo ?g_rhs_0'],
      );
      const reason = await refusalOf(() => lspResult('ambig', 'Ambig.idr', 13, 4, refine('g_rhs', 'foo')));
      assert.match(reason, /^Refine Hole: idris2-lsp gave no refinement and reports no reason: the expression may be ambiguous \(IDE mode then offers the alternatives\)/u);
    });

    test('Make With on a hole alone below its clause\'s =: IDE mode rewrites the clause, idris2-lsp is not asked (its answer is garbage)', async () => {
      const ide = appliedText(fs.readFileSync(path.join(BROKEN, 'Edits.idr'), 'utf8'), ideResult('Edits.idr', 14, 2, at('makeWith', 'count_rhs')));
      assert.deepStrictEqual(ide.split('\n').slice(13, 15), ['count xs with (_)', '  count xs | with_pat = ?count_rhs_rhs']);
      const reason = await refusalOf(() => lspResult('edits-shapes', 'Edits.idr', 14, 2, at('makeWith', 'count_rhs')));
      assert.match(reason, /^Make With: idris2-lsp rewrites the hole's own line/u);
    });

    test('Add Clause after a load with errors: IDE mode\'s compiler finds no declaration, idris2-lsp answers (placed after the clauses by M4\'s rule)', async () => {
      const ide = ideResult('Part.idr', 2, 0, at('addClause', 'g'));
      assert.deepStrictEqual(ide, { type: 'failed', message: 'g not defined here' });
      const lsp = appliedText(fs.readFileSync(path.join(BROKEN, 'Part.idr'), 'utf8'), await lspResult('diagnostics', 'Part.idr', 2, 0, at('addClause', 'g')));
      assert.deepStrictEqual(lsp.split('\n').slice(2, 6), ['g : Nat -> Nat', 'g 0 = 0', 'g k = ?g_rhs', '']);
    });

    test('Proof Search without a result: IDE mode\'s compiler says so, idris2-lsp answers nothing and the refusal says so', async () => {
      const ide = ideResult('Edits.idr', 72, 10, search('label_rhs'));
      assert.deepStrictEqual(ide, { type: 'failed', message: 'No search results' });
      const reason = await refusalOf(() => lspResult('edits-searches', 'Edits.idr', 72, 10, search('label_rhs')));
      assert.match(reason, /^Proof Search: idris2-lsp found no expression for this hole/u);
    });
  });
});
