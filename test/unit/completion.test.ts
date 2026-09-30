// features/intelligence/completion.ts: where completion happens and what it offers (keywords,
// %-directives, the compiler's names), the pre-warming after a load, the kept answers, and that
// the provider never waits longer than its time limit for the compiler (ROADMAP M3,
// docs/measurements/first-load.md).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { IdrisException } from '../../src/core/errors';
import {
  COMPILER_WAIT_MS,
  completionSite,
  DIRECTIVES,
  registerCompletion,
  type CompletionApi,
} from '../../src/features/intelligence/completion';
import { KEYWORDS } from '../../src/features/syntax/lexer';
import { repoRoot } from '../fake-tools/paths';
import {
  asDoc,
  deferred,
  FakeBackend,
  fakeDoc,
  FakeEventEmitter,
  FakeRange,
  fakeToken,
  intelligenceDeps,
  looseRoot,
  settle,
  type FakeDoc,
} from './support/interactiveFakes';

class FakeCompletionItem {
  range: { inserting: FakeRange; replacing: FakeRange } | undefined;
  insertText: string | undefined;
  filterText: string | undefined;
  constructor(
    readonly label: string,
    readonly kind?: number,
  ) {}
}

class FakeCompletionList {
  constructor(
    readonly items: FakeCompletionItem[] = [],
    readonly isIncomplete = false,
  ) {}
}

const KEYWORD_KIND = 13;

/** The keywords, in the lexer's order. */
const keywords = [...KEYWORDS];

function setup(options: { waitMs?: number; active?: FakeDoc } = {}) {
  const backend = new FakeBackend();
  const { deps, loads, queries, logged } = intelligenceDeps(backend);
  const window = { activeTextEditor: options.active && { document: options.active } };
  const closed = new FakeEventEmitter<FakeDoc>();
  let provider: vscode.CompletionItemProvider | undefined;
  const api = {
    workspace: { onDidCloseTextDocument: closed.event },
    languages: {
      registerCompletionItemProvider: (_selector: unknown, p: vscode.CompletionItemProvider) => {
        provider = p;
        return { dispose: () => (provider = undefined) };
      },
    },
    window,
    CompletionItem: FakeCompletionItem,
    CompletionList: FakeCompletionList,
    Range: FakeRange,
    CompletionItemKind: { Keyword: KEYWORD_KIND },
  } as unknown as CompletionApi;
  const warmedUp: string[] = [];
  const warmUp = {
    warmUpCompletions: (doc: vscode.TextDocument) => {
      warmedUp.push(doc.fileName);
      return Promise.resolve();
    },
  };
  const registration = registerCompletion(api, { ...deps, warmUp }, { waitMs: options.waitMs ?? 1000 });
  const complete = async (doc: FakeDoc, line: number, character: number, token = fakeToken()): Promise<FakeCompletionList | undefined> => {
    assert.ok(provider !== undefined, 'the provider is registered');
    const result = await provider.provideCompletionItems(
      asDoc(doc),
      { line, character } as vscode.Position,
      token as unknown as vscode.CancellationToken,
      {} as vscode.CompletionContext,
    );
    return result as unknown as FakeCompletionList | undefined;
  };
  return { backend, deps, loads, queries, logged, window, registration, complete, warmedUp, closed, provider: () => provider };
}

const labels = (list: FakeCompletionList | undefined): string[] => (list?.items ?? []).map((i) => i.label);
const compilerLabels = (list: FakeCompletionList | undefined): string[] => (list?.items ?? []).filter((i) => i.kind !== KEYWORD_KIND).map((i) => i.label);

const CLEAN = fakeDoc({ fileName: '/w/Clean.idr', text: 'module Clean\n\nvlen : Vect n a -> Nat\nvlen xs = vl\n' });

suite('features/intelligence/completion', () => {
  suite('completionSite: where the cursor is', () => {
    test('an identifier: its part before the cursor, the whole of it to replace', () => {
      assert.deepStrictEqual(completionSite('vlen xs = vl', 12), { kind: 'name', start: 10, end: 12, prefix: 'vl', keywords: true });
      // In the middle of a word: the prefix ends at the cursor, the replaced range at the word's end.
      assert.deepStrictEqual(completionSite('x = vlen', 6), { kind: 'name', start: 4, end: 8, prefix: 'vl', keywords: true });
      // `_` and `'` are identifier characters (isIdentStart, isIdentTrailing), and so is every
      // character above U+00A0, astral ones included (UTF-16 columns).
      assert.deepStrictEqual(completionSite("f x' = vlen_r", 13), { kind: 'name', start: 7, end: 13, prefix: 'vlen_r', keywords: true });
      assert.deepStrictEqual(completionSite("g = x'", 6), { kind: 'name', start: 4, end: 6, prefix: "x'", keywords: true });
      assert.deepStrictEqual(completionSite('h = α𝕟x', 8), { kind: 'name', start: 4, end: 8, prefix: 'α𝕟x', keywords: true });
      // The cursor between the two UTF-16 units of 𝕟 is not a place VS Code puts it; before 𝕟:
      assert.deepStrictEqual(completionSite('h = α𝕟x', 5), { kind: 'name', start: 4, end: 8, prefix: 'α', keywords: true });
      assert.deepStrictEqual(completionSite('h = _a', 6), { kind: 'name', start: 4, end: 6, prefix: '_a', keywords: true });
    });

    test('where an identifier may start: an empty prefix', () => {
      assert.deepStrictEqual(completionSite('', 0), { kind: 'name', start: 0, end: 0, prefix: '', keywords: true });
      assert.deepStrictEqual(completionSite('f = (', 5), { kind: 'name', start: 5, end: 5, prefix: '', keywords: true });
    });

    test('after `.` (a qualified name, a projection) and `?` (a hole): names only, the last part', () => {
      assert.deepStrictEqual(completionSite('x = Data.Vect.le', 16), { kind: 'name', start: 14, end: 16, prefix: 'le', keywords: false });
      assert.deepStrictEqual(completionSite('x = ?vl', 7), { kind: 'name', start: 5, end: 7, prefix: 'vl', keywords: false });
    });

    test('after `%`: a directive, from the `%` on', () => {
      assert.deepStrictEqual(completionSite('%def', 4), { kind: 'directive', start: 0, end: 4 });
      assert.deepStrictEqual(completionSite('  %', 3), { kind: 'directive', start: 2, end: 3 });
      assert.deepStrictEqual(completionSite('%default tot', 2), { kind: 'directive', start: 0, end: 8 });
    });

    test('nothing where the run of identifier characters does not begin an identifier: a number, a character literal', () => {
      assert.strictEqual(completionSite('x = 12', 6), undefined);
      assert.strictEqual(completionSite('x = 0x1f', 8), undefined);
      assert.strictEqual(completionSite('x = 1ab', 7), undefined);
      assert.strictEqual(completionSite("c = 'a", 6), undefined);
    });
  });

  suite('the static items', () => {
    test('the keywords are the lexer\'s (Source.idr `keywords` and `fixityKeywords`)', () => {
      assert.deepStrictEqual(keywords.slice(0, 3), ['data', 'module', 'where']);
      assert.strictEqual(keywords.length, 41);
      assert.ok(keywords.includes('covering') && keywords.includes('infixl'));
    });

    test('the directives are the grammar\'s known pragmas (KNOWN_PRAGMAS) plus %cg, which the grammar matches with its own rule', () => {
      const grammar = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'syntaxes', 'idris2.tmLanguage.json'), 'utf8')) as {
        repository: Record<string, { patterns?: { match?: string; name?: string; begin?: string }[] }>;
      };
      const directive = grammar.repository.pragma.patterns?.find((p) => p.name === 'keyword.other.directive.idris2')?.match ?? '';
      const alternatives = /^%\(\?:([^)]*)\)/.exec(directive)?.[1].split('|') ?? [];
      assert.deepStrictEqual([...alternatives].sort(), DIRECTIVES.filter((d) => d !== 'cg').sort());
      assert.ok(JSON.stringify(grammar.repository['cg-directive']).includes('%cg'));
      assert.strictEqual(new Set(DIRECTIVES).size, DIRECTIVES.length);
    });
  });

  suite('the provider', () => {
    test('at an identifier: the keywords and the compiler\'s names that start with the prefix, from a passive query', async () => {
      const t = setup();
      t.backend.names = ['vlen', 'vlen_rhs', 'Vect', 'show'];
      const list = await t.complete(CLEAN, 3, 12);
      assert.deepStrictEqual(labels(list), [...keywords, 'vlen', 'vlen_rhs']);
      assert.strictEqual(list?.isIncomplete, false);
      assert.deepStrictEqual(t.backend.calls, ['completions vl']);
      assert.deepStrictEqual(t.queries.runs, [{ file: '/w/Clean.idr', mode: 'passive' }]);
      // Each item replaces the identifier: inserting up to the cursor, replacing to its end.
      const item = list?.items.find((i) => i.label === 'vlen');
      assert.deepStrictEqual(item?.range, { inserting: new FakeRange(3, 10, 3, 12), replacing: new FakeRange(3, 10, 3, 12) });
      // No kind is claimed for a compiler name (the reply names none); keywords are keywords.
      assert.strictEqual(item?.kind, undefined);
      assert.strictEqual(list?.items[0].kind, KEYWORD_KIND);
    });

    test('a name is drawn as untrusted text: invisible characters written out, no theme icon; inserted and filtered as it is (third review of M3)', async () => {
      const t = setup();
      // [live, the reviewer's probe] `(:repl-completions "vl")` answered these two names of one file.
      t.backend.names = ['vlxyz\u202Eab', 'vl$(zap)', 'vlen'];
      const list = await t.complete(CLEAN, 3, 12);
      const names = (list?.items ?? []).filter((i) => i.kind !== KEYWORD_KIND);
      assert.deepStrictEqual(
        names.map((i) => [i.label, i.insertText, i.filterText]),
        [
          ['vlxyz\\u{202E}ab', 'vlxyz\u202Eab', 'vlxyz\u202Eab'],
          ['vl$\u200b(zap)', 'vl$(zap)', 'vl$(zap)'],
          ['vlen', 'vlen', 'vlen'],
        ],
      );
    });

    test('never waits longer than its time limit: without the compiler\'s answer, the keywords now, marked incomplete; the answer serves the next keystroke', async () => {
      const t = setup({ waitMs: 20 });
      const answer = deferred<readonly string[]>();
      t.backend.completions = () => answer.promise;
      const started = Date.now();
      const first = await t.complete(CLEAN, 3, 12);
      const waited = Date.now() - started;
      assert.ok(waited < 500, `answered after ${waited} ms`);
      assert.deepStrictEqual(labels(first), keywords);
      assert.strictEqual(first?.isIncomplete, true, 'VS Code asks again at the next keystroke');
      // The request goes on; once answered, the next request is answered from it, with no new request.
      answer.resolve(['vlen', 'vlen_rhs']);
      await settle();
      const second = await t.complete(CLEAN, 3, 12);
      assert.deepStrictEqual(compilerLabels(second), ['vlen', 'vlen_rhs']);
      assert.strictEqual(second?.isIncomplete, false);
      assert.deepStrictEqual(t.backend.calls, ['completions vl']);
    });

    test('the default time limit is below the first request after a load (113 ms and more) and above the steady state (p90 ≤ 10.8 ms)', () => {
      assert.ok(COMPILER_WAIT_MS > 10.8 * 5 && COMPILER_WAIT_MS < 1000, String(COMPILER_WAIT_MS));
    });

    test('one request per prefix while it is pending, and none for a longer prefix typed meanwhile: it is filtered from the pending answer', async () => {
      const t = setup({ waitMs: 10 });
      const answer = deferred<readonly string[]>();
      t.backend.completions = () => answer.promise;
      const doc = fakeDoc({ fileName: '/w/Clean.idr', text: 'a = vl\nb = vle\nc = vlen_\nd = x' });
      await t.complete(doc, 0, 6);
      await t.complete(doc, 0, 6);
      // The first request after a load is the slow one: the keystrokes that follow wait for it.
      const vle = await t.complete(doc, 1, 7);
      assert.deepStrictEqual([labels(vle), vle?.isIncomplete], [keywords, true], 'the keywords now, the list incomplete');
      const later = t.complete(doc, 2, 9);
      assert.deepStrictEqual(t.backend.calls, ['completions vl']);
      answer.resolve(['vlen', 'vlen_rhs', 'vlx']);
      assert.deepStrictEqual(compilerLabels(await later), ['vlen_rhs'], 'the pending answer, filtered');
      assert.deepStrictEqual(compilerLabels(await t.complete(doc, 1, 7)), ['vlen', 'vlen_rhs'], 'kept, and filtered');
      // Another root prefix: a request of its own.
      t.backend.completions = () => Promise.resolve(['xs']);
      assert.deepStrictEqual(compilerLabels(await t.complete(doc, 3, 5)), ['xs']);
      assert.deepStrictEqual(t.backend.calls, ['completions vl', 'completions x']);
    });

    test('a pending shorter prefix\'s answer, when it arrives in time, is filtered for the longer one', async () => {
      const t = setup({ waitMs: 1000 });
      const answer = deferred<readonly string[]>();
      t.backend.completions = () => answer.promise;
      const doc = fakeDoc({ fileName: '/w/Clean.idr', text: 'a = vl\nb = vlen_' });
      const first = t.complete(doc, 0, 6);
      const second = t.complete(doc, 1, 9);
      await settle();
      answer.resolve(['vlen', 'vlen_rhs', 'vlet']);
      assert.deepStrictEqual(compilerLabels(await first), ['vlen', 'vlen_rhs', 'vlet']);
      assert.deepStrictEqual(compilerLabels(await second), ['vlen_rhs']);
      assert.deepStrictEqual(t.backend.calls, ['completions vl']);
    });

    test('a longer prefix is answered from a kept shorter one, until a load of the root that built something', async () => {
      const t = setup();
      t.backend.names = ['vlen', 'vlen_rhs', 'view'];
      const doc = fakeDoc({ fileName: '/w/Clean.idr', text: 'x = v\ny = vle\n' });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      assert.deepStrictEqual(compilerLabels(await t.complete(doc, 0, 5)), ['vlen', 'vlen_rhs', 'view']);
      assert.deepStrictEqual(compilerLabels(await t.complete(doc, 1, 7)), ['vlen', 'vlen_rhs']);
      assert.deepStrictEqual(t.backend.calls, ['completions v']);
      // Loads that built nothing, this file's included, and another root's, keep what was kept.
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: false });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      t.loads.fire({ root: looseRoot('/x'), file: '/x/Y.idr', rebuilt: true });
      await t.complete(doc, 1, 7);
      assert.deepStrictEqual(t.backend.calls, ['completions v']);
      // A load of another file of the root that built something (an import changed): asked again.
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      await t.complete(doc, 1, 7);
      assert.deepStrictEqual(t.backend.calls, ['completions v', 'completions vle']);
      // Closing the document forgets them too.
      t.closed.fire(doc);
      await t.complete(doc, 1, 7);
      assert.deepStrictEqual(t.backend.calls, ['completions v', 'completions vle', 'completions vle']);
    });

    test('closing another document of the same path (a git: one) keeps the names and the file\'s root (sixth review of M3)', async () => {
      // VS Code gives a git: document the file's fileName; its close dropped the kept names and the
      // file's root, so a load of an import that changed no longer made them stale.
      const t = setup();
      t.backend.names = ['vlen', 'view'];
      const doc = fakeDoc({ fileName: '/w/Clean.idr', text: 'x = v\n' });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      await t.complete(doc, 0, 5);
      t.closed.fire(fakeDoc({ fileName: '/w/Clean.idr', text: 'x = v\n', scheme: 'git' }));
      await t.complete(doc, 0, 5);
      assert.deepStrictEqual(t.backend.calls, ['completions v'], 'still kept');
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      await t.complete(doc, 0, 5);
      assert.deepStrictEqual(t.backend.calls, ['completions v', 'completions v'], 'made stale by a load of its root');
    });

    test('the file\'s own document closed and opened again with no load of its own: a load of its root still makes the names asked since stale (tenth review of M3)', async () => {
      // Under the manual trigger a reopened document is not loaded; the close forgot the file's root,
      // so the names asked after the reopen were kept across a load of a changed import.
      const t = setup();
      t.backend.names = ['vlen', 'view'];
      const doc = fakeDoc({ fileName: '/w/Clean.idr', text: 'x = v\n' });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      await t.complete(doc, 0, 5);
      t.closed.fire(doc);
      await t.complete(doc, 0, 5);
      await t.complete(doc, 0, 5);
      assert.deepStrictEqual(t.backend.calls, ['completions v', 'completions v'], 'asked again after the close, then kept');
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      await t.complete(doc, 0, 5);
      assert.deepStrictEqual(t.backend.calls, ['completions v', 'completions v', 'completions v'], 'made stale by a load of its root');
    });

    test('an answer that arrives after a new load of the file is shown but not kept', async () => {
      const t = setup({ waitMs: 1000 });
      const answer = deferred<readonly string[]>();
      t.backend.completions = () => answer.promise;
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      const pending = t.complete(CLEAN, 3, 12);
      await settle();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      answer.resolve(['vlen']);
      assert.deepStrictEqual(compilerLabels(await pending), ['vlen']);
      t.backend.completions = () => Promise.resolve(['vlen', 'vlen_rhs']);
      assert.deepStrictEqual(compilerLabels(await t.complete(CLEAN, 3, 12)), ['vlen', 'vlen_rhs']);
      assert.deepStrictEqual(t.backend.calls, ['completions vl', 'completions vl']);
    });

    test('when the backend cannot answer: the keywords, complete (nothing to wait for)', async () => {
      const t = setup();
      t.backend.completions = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'no backend' }));
      const list = await t.complete(CLEAN, 3, 12);
      assert.deepStrictEqual(labels(list), keywords);
      assert.strictEqual(list?.isIncomplete, false);
      assert.ok(t.logged.some((m) => m.startsWith('debug Completion of "vl": no backend')));
    });

    test('nothing typed yet: the keywords without asking, marked incomplete so that the first letter asks', async () => {
      const t = setup();
      const doc = fakeDoc({ fileName: '/w/A.idr', text: 'f = ' });
      const list = await t.complete(doc, 0, 4);
      assert.deepStrictEqual(labels(list), keywords);
      assert.strictEqual(list?.isIncomplete, true);
      assert.deepStrictEqual(t.backend.calls, []);
    });

    test('after `.`: names only; after `%`: the directives, replacing from the `%`', async () => {
      const t = setup();
      t.backend.names = ['length'];
      const doc = fakeDoc({ fileName: '/w/A.idr', text: 'x = Data.List.le\n%def' });
      assert.deepStrictEqual(labels(await t.complete(doc, 0, 16)), ['length']);
      const directives = await t.complete(doc, 1, 4);
      assert.deepStrictEqual(labels(directives), DIRECTIVES.map((d) => `%${d}`));
      assert.deepStrictEqual(directives?.items[0].range, { inserting: new FakeRange(1, 0, 1, 4), replacing: new FakeRange(1, 0, 1, 4) });
      assert.deepStrictEqual(t.backend.calls, ['completions le']);
    });

    test('an untitled document: keywords only (the compiler has no file of it); a bird-track prose line and a number: nothing', async () => {
      const t = setup();
      const untitled = fakeDoc({ fileName: 'Untitled-1', text: 'x = vl', scheme: 'untitled' });
      assert.deepStrictEqual(labels(await t.complete(untitled, 0, 6)), keywords);
      const lit = fakeDoc({ fileName: '/w/Lit.lidr', languageId: 'lidr', text: 'Some prose vl\n> x = vl' });
      assert.strictEqual(await t.complete(lit, 0, 13), undefined);
      assert.deepStrictEqual(compilerLabels(await t.complete(lit, 1, 8)), []);
      assert.strictEqual(await t.complete(fakeDoc({ fileName: '/w/N.idr', text: 'x = 42' }), 0, 6), undefined);
      assert.deepStrictEqual(t.backend.calls, ['completions vl']);
    });

    test('a cancelled request answers nothing', async () => {
      const t = setup();
      const token = fakeToken();
      t.backend.completions = () => {
        token.isCancellationRequested = true;
        return Promise.resolve(['vlen']);
      };
      assert.strictEqual(await t.complete(CLEAN, 3, 12, token), undefined);
    });
  });

  suite('pre-warming after a load', () => {
    test('a load of the active document\'s file asks the backend to warm the next completion up; nothing else is sent', async () => {
      const t = setup({ active: CLEAN });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await settle();
      assert.deepStrictEqual(t.warmedUp, ['/w/Clean.idr']);
      assert.deepStrictEqual(t.backend.calls, []);
      assert.deepStrictEqual(t.queries.runs, []);
    });

    test('not for a load of another file, nor without an active Idris file on disk', async () => {
      const t = setup({ active: CLEAN });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: false });
      t.window.activeTextEditor = { document: fakeDoc({ fileName: '/w/Clean.idr', text: '', languageId: 'markdown' }) };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      t.window.activeTextEditor = undefined;
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await settle();
      assert.deepStrictEqual(t.warmedUp, []);
    });

    test('disposing stops the pre-warming and unregisters the provider', async () => {
      const t = setup({ active: CLEAN });
      t.registration.dispose();
      assert.strictEqual(t.provider(), undefined);
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await settle();
      assert.deepStrictEqual(t.warmedUp, []);
    });
  });
});
