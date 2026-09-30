// features/intelligence/inlayHints.ts: which :bound tokens get a hint (the first of each name per
// top-level declaration), the label from a positional :type-of, the requests (visible range only,
// one at a time, kept per load), and when nothing is shown (unsaved changes, a token index of
// another text, the setting off). The tokens and answers are those of the recorded transcript
// `clean-queries` (test/fixtures/transcripts/0.8.0, Clean.idr of the broken workspace).
import * as assert from 'assert';
import * as v8 from 'v8';
import * as vm from 'vm';
import type * as vscode from 'vscode';
import type { Decor, Token, TokenIndex, TypeInfo } from '../../src/backend/types';
import { IdrisException } from '../../src/core/errors';
import { declarationUnits, hintedTokens, hintLabel, registerInlayHints, type InlayHintsApi } from '../../src/features/intelligence/inlayHints';
import {
  asDoc,
  FakeBackend,
  fakeDoc,
  FakeEventEmitter,
  FakeMarkdownString,
  FakePosition,
  FakeRange,
  fakeToken,
  intelligenceDeps,
  looseRoot,
  type FakeDoc,
} from './support/interactiveFakes';

const CLEAN_TEXT = [
  'module Clean',
  '',
  'import Data.Vect',
  '',
  'append : Vect n a -> Vect m a -> Vect (n + m) a',
  '',
  'vlen : Vect n a -> Nat',
  'vlen xs = ?vlen_rhs',
  '',
].join('\n');

const token = (line: number, start: number, end: number, decor: Decor, name?: string): Token => ({
  range: { start: { line, character: start }, end: { line, character: end } },
  decor,
  ...(name === undefined ? {} : { name, namespace: '' }),
});

/** The :highlight-source tokens of Clean.idr's load in `clean-queries` (the bound ones, and a few others). */
const CLEAN_TOKENS: Token[] = [
  token(0, 0, 6, 'keyword'),
  token(0, 7, 12, 'module'),
  token(4, 0, 6, 'function', 'append'),
  token(4, 9, 13, 'type', 'Vect'),
  token(4, 14, 15, 'bound', 'n'),
  token(4, 16, 17, 'bound', 'a'),
  token(4, 26, 27, 'bound', 'm'),
  token(4, 28, 29, 'bound', 'a'),
  token(4, 39, 40, 'bound', 'n'),
  token(4, 43, 44, 'bound', 'm'),
  token(4, 46, 47, 'bound', 'a'),
  token(6, 12, 13, 'bound', 'n'),
  token(6, 14, 15, 'bound', 'a'),
  token(7, 0, 4, 'function', 'vlen'),
  token(7, 5, 7, 'bound', 'xs'),
];

/** The positional :type-of answers recorded for those tokens. */
const RECORDED: Record<string, string> = { n: 'n : Nat', a: 'a : Type', m: 'm : Nat', xs: 'xs : Vect ?_ ?_' };

const typeInfo = (text: string, lookup: TypeInfo['lookup'] = 'position'): TypeInfo => ({ text, spans: [], lookup });

/** `token` moved `by` lines down, as the index of a text with lines inserted above it has it. */
const shifted = (t: Token, by: number): Token => ({
  ...t,
  range: { start: { line: t.range.start.line + by, character: t.range.start.character }, end: { line: t.range.end.line + by, character: t.range.end.character } },
});

/** The hints of the recorded answers (`RECORDED`) on CLEAN_TEXT, with the lines of vlen `by` lines down. */
const cleanHints = (by = 0): string[] => ['4:15 : Nat', '4:17 : Type', '4:27 : Nat', `${6 + by}:13 : Nat`, `${6 + by}:15 : Type`, `${7 + by}:7 : Vect ?_ ?_`];

const REFUSED = (): Promise<never> => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: "only the active editor's file is loaded" }));

class FakeInlayHint {
  paddingLeft: boolean | undefined;
  tooltip: FakeMarkdownString | undefined;
  constructor(
    readonly position: FakePosition,
    readonly label: string,
    readonly kind: number,
  ) {}
}

const TYPE_KIND = 1;

function setup(doc: FakeDoc = fakeDoc({ fileName: '/w/Clean.idr', text: CLEAN_TEXT, version: 3 })) {
  const backend = new FakeBackend();
  backend.index = { file: doc.fileName, text: doc.text, tokens: CLEAN_TOKENS };
  backend.answerType = (_line, _character, name) => Promise.resolve(RECORDED[name] === undefined ? undefined : typeInfo(RECORDED[name]));
  const t = intelligenceDeps(backend);
  let provider: vscode.InlayHintsProvider | undefined;
  const closed = new FakeEventEmitter<FakeDoc>();
  const activated = new FakeEventEmitter<{ document: FakeDoc } | undefined>();
  let emitter: FakeEventEmitter<void> | undefined;
  const api = {
    languages: {
      registerInlayHintsProvider: (_selector: unknown, p: vscode.InlayHintsProvider) => {
        provider = p;
        return { dispose: () => (provider = undefined) };
      },
    },
    workspace: { onDidCloseTextDocument: closed.event },
    window: { onDidChangeActiveTextEditor: activated.event },
    EventEmitter: function () {
      emitter = new FakeEventEmitter<void>();
      return emitter;
    },
    InlayHint: FakeInlayHint,
    InlayHintKind: { Type: TYPE_KIND },
    Position: FakePosition,
    MarkdownString: FakeMarkdownString,
  } as unknown as InlayHintsApi;
  const registration = registerInlayHints(api, t.deps);
  const hints = async (range = new FakeRange(0, 0, 100, 0), cancel = fakeToken()): Promise<FakeInlayHint[]> => {
    assert.ok(provider !== undefined);
    const result = await provider.provideInlayHints(asDoc(doc), range as unknown as vscode.Range, cancel as unknown as vscode.CancellationToken);
    return (result ?? []) as unknown as FakeInlayHint[];
  };
  const shown = (list: FakeInlayHint[]): string[] => list.map((h) => `${h.position.line}:${h.position.character} ${h.label}`);
  return { ...t, backend, doc, hints, shown, registration, closed, activated, changes: () => emitter?.fired ?? 0 };
}

suite('features/intelligence/inlayHints', () => {
  suite('which tokens get a hint', () => {
    test('the first :bound token of each name per top-level declaration: each variable once, where it is bound', () => {
      const doc = fakeDoc({ fileName: '/w/Clean.idr', text: CLEAN_TEXT });
      const hinted = hintedTokens(CLEAN_TOKENS, declarationUnits(CLEAN_TEXT, doc));
      assert.deepStrictEqual(
        hinted.map((t) => `${t.range.start.line}:${t.range.start.character} ${t.name}`),
        // The signature of append: n, a, m once each (not seven hints); vlen's signature and its
        // clause are separate declarations.
        ['4:14 n', '4:16 a', '4:26 m', '6:12 n', '6:14 a', '7:5 xs'],
      );
    });

    test('a clause with a where block is one unit; each clause and signature its own', () => {
      const text = ['f : Nat -> Nat', 'f n = go n', '  where', '    go : Nat -> Nat', '    go k = k + n', 'g n = n'].join('\n');
      const units = declarationUnits(text, fakeDoc({ fileName: '/w/F.idr', text }));
      assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(units), ['block 0', 'block 1', 'block 1', 'block 1', 'block 1', 'block 5']);
      const tokens = [token(1, 2, 3, 'bound', 'n'), token(1, 9, 10, 'bound', 'n'), token(4, 7, 8, 'bound', 'k'), token(4, 11, 12, 'bound', 'k'), token(4, 15, 16, 'bound', 'n'), token(5, 2, 3, 'bound', 'n')];
      assert.deepStrictEqual(
        hintedTokens(tokens, units).map((t) => `${t.range.start.line}:${t.range.start.character}`),
        ['1:2', '4:7', '5:2'],
      );
    });

    test('bird-track documents are read by M0\'s model; a fenced literate document by line', () => {
      const lidr = ['Prose.', '', '> f : Nat -> Nat', '> f n =', '>   n', '', 'More prose.', '> g n = n'].join('\n');
      const units = declarationUnits(lidr, fakeDoc({ fileName: '/w/Lit.lidr', languageId: 'lidr', text: lidr }));
      assert.strictEqual(units(3), units(4));
      assert.notStrictEqual(units(2), units(3));
      assert.notStrictEqual(units(4), units(7));
      const md = ['```idris', 'f n =', '  n', '```'].join('\n');
      const fenced = declarationUnits(md, fakeDoc({ fileName: '/w/Doc.idr.md', languageId: 'markdown', text: md }));
      assert.deepStrictEqual([1, 2].map(fenced), ['line 1', 'line 2']);
    });

    test('tokens that are not :bound, or have no name, get none', () => {
      const tokens = [token(0, 0, 1, 'function', 'f'), token(0, 2, 3, 'bound'), token(0, 4, 5, 'data', 'Z')];
      assert.deepStrictEqual(hintedTokens(tokens, () => 'one'), []);
    });
  });

  suite('the label', () => {
    test('`: <type>` from a positional answer about the name', () => {
      assert.strictEqual(hintLabel('xs', typeInfo('xs : Vect ?_ ?_')), ': Vect ?_ ?_');
      assert.strictEqual(hintLabel('x₁', typeInfo('x₁ : ℕ')), ': ℕ');
    });

    test('nothing from an answer by name (it may be a global of that name) or about another name', () => {
      assert.strictEqual(hintLabel('xs', typeInfo('xs : Vect ?_ ?_', 'name')), undefined);
      // `(:type-of "y" 12 3)` answered `x₁ : ℕ` [live, transcript unicode-columns].
      assert.strictEqual(hintLabel('y', typeInfo('x₁ : ℕ')), undefined);
      assert.strictEqual(hintLabel('x', typeInfo('xs : Nat')), undefined);
      assert.strictEqual(hintLabel('x', typeInfo('x : ')), undefined);
    });

    test('one line: a broken type joined, control and format characters written out', () => {
      assert.strictEqual(hintLabel('f', typeInfo('f : Vect n a ->\n    Vect m a')), ': Vect n a -> Vect m a');
      assert.strictEqual(hintLabel('s', typeInfo('s : T "\u202Eabc"')), ': T "\\u{202E}abc"');
    });
  });

  suite('the provider', () => {
    test('hints after each hinted token, from positional queries in the passive mode', async () => {
      const t = setup();
      const hints = await t.hints();
      assert.deepStrictEqual(t.shown(hints), ['4:15 : Nat', '4:17 : Type', '4:27 : Nat', '6:13 : Nat', '6:15 : Type', '7:7 : Vect ?_ ?_']);
      assert.deepStrictEqual(t.backend.calls, ['typeAt 4:14 n', 'typeAt 4:16 a', 'typeAt 4:26 m', 'typeAt 6:12 n', 'typeAt 6:14 a', 'typeAt 7:5 xs']);
      assert.ok(t.queries.runs.every((r) => r.mode === 'passive'));
      const xs = hints[5];
      assert.strictEqual(xs.kind, TYPE_KIND);
      assert.strictEqual(xs.paddingLeft, true);
      assert.strictEqual(xs.tooltip?.isTrusted, false);
      assert.strictEqual(xs.tooltip?.supportHtml, false);
      assert.strictEqual(xs.tooltip?.supportThemeIcons, false);
      assert.ok(xs.tooltip?.value.startsWith('\n```idris2\nxs : Vect ?_ ?_\n```\n'), xs.tooltip?.value);
    });

    test('the tooltip writes out control and format characters too (a bidi override in a type)', async () => {
      const t = setup();
      t.backend.answerType = (_l, _c, name) => Promise.resolve(name === 'xs' ? typeInfo('xs : T "‮ab​"') : undefined);
      const [xs] = await t.hints(new FakeRange(7, 0, 7, 19));
      assert.ok(xs.tooltip?.value.startsWith('\n```idris2\nxs : T "\\u{202E}ab\\u{200B}"\n```\n'), xs.tooltip?.value);
    });

    test('only the tokens in the range asked about', async () => {
      const t = setup();
      assert.deepStrictEqual(t.shown(await t.hints(new FakeRange(7, 0, 7, 19))), ['7:7 : Vect ?_ ?_']);
      assert.deepStrictEqual(t.backend.calls, ['typeAt 7:5 xs']);
    });

    test('answers are kept until a load of the root that built something (also of another file: an import), which asks VS Code for the hints again', async () => {
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      await t.hints();
      await t.hints();
      assert.strictEqual(t.backend.calls.length, 6);
      const before = t.changes();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: false });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      t.loads.fire({ root: looseRoot('/elsewhere'), file: '/elsewhere/X.idr', rebuilt: true });
      assert.strictEqual(t.changes(), before + 3, 'every load asks for the hints again');
      await t.hints();
      assert.strictEqual(t.backend.calls.length, 6, 'loads that built nothing, and another root\'s, keep them');
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      await t.hints();
      assert.strictEqual(t.backend.calls.length, 12, 'a load of another file of the root that built something drops them');
      // Closing the document forgets them too.
      t.closed.fire(t.doc);
      await t.hints();
      assert.strictEqual(t.backend.calls.length, 18);
    });

    test('an answer that shows nothing is kept too: not asked again', async () => {
      const t = setup();
      t.backend.answerType = (_l, _c, name) => Promise.resolve(name === 'xs' ? typeInfo('xs : Vect ?_ ?_', 'name') : undefined);
      assert.deepStrictEqual(await t.hints(), []);
      await t.hints();
      assert.strictEqual(t.backend.calls.length, 6);
    });

    test('an unavailable query ends the round (asked again next time); the hints found so far are shown', async () => {
      const t = setup();
      t.backend.answerType = (_l, _c, name) =>
        name === 'm' ? Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'stopped' })) : Promise.resolve(typeInfo(RECORDED[name]));
      assert.deepStrictEqual(t.shown(await t.hints()), ['4:15 : Nat', '4:17 : Type']);
      assert.deepStrictEqual(t.backend.calls, ['typeAt 4:14 n', 'typeAt 4:16 a', 'typeAt 4:26 m']);
      assert.ok(t.logged.some((m) => m.includes('stopped')));
      t.backend.answerType = (_l, _c, name) => Promise.resolve(typeInfo(RECORDED[name]));
      assert.strictEqual((await t.hints()).length, 6);
      assert.deepStrictEqual(t.backend.calls.slice(3), ['typeAt 4:26 m', 'typeAt 6:12 n', 'typeAt 6:14 a', 'typeAt 7:5 xs']);
    });

    test('a save whose load failed: the hints stay, from the answers the load made stale; nothing asked (fourth review of M3)', async () => {
      // Before, the failed load (rebuilt, no highlighting: the index stays) dropped the answers, and
      // the document, showing other text than the index, got none until a save that loaded.
      const t = setup();
      const saved = t.shown(await t.hints());
      const asked = t.backend.calls.length;
      t.doc.text = `${CLEAN_TEXT}broken =\n`;
      t.doc.version = 4;
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      assert.deepStrictEqual(t.shown(await t.hints()), saved);
      assert.strictEqual(t.backend.calls.length, asked);
      // A load of that text: its new index is not the one those answers were asked with; they are
      // carried over to it (the lines are unchanged), shown where a query is refused, and their
      // tooltip says they come from an earlier check (fifth review of M3: nothing was shown).
      t.backend.index = { file: '/w/Clean.idr', text: t.doc.text, tokens: CLEAN_TOKENS };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      t.backend.answerType = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'stopped' }));
      const carried = await t.hints();
      assert.deepStrictEqual(t.shown(carried), saved);
      assert.ok(carried[5].tooltip?.value.endsWith('as the compiler inferred it at an earlier check; the file, or a module it imports, has changed since\\.'), carried[5].tooltip?.value);
    });

    test('a query refused after another file\'s load made the answers stale (an editor that is not the active one): the hints stay until fresh ones come (fourth review of M3)', async () => {
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false }); // its root is learnt from its loads
      const saved = t.shown(await t.hints());
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      t.backend.answerType = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: "only the active editor's file is loaded" }));
      assert.deepStrictEqual(t.shown(await t.hints()), saved);
      assert.strictEqual(t.backend.calls.length, 7, 'one query, refused: nothing more is asked this round');
      // Asked again once it can be: the fresh answers take the tokens' places.
      t.backend.answerType = (_l, _c, name) => Promise.resolve(typeInfo(name === 'xs' ? 'xs : List Nat' : RECORDED[name]));
      assert.strictEqual(t.shown(await t.hints()).at(-1), '7:7 : List Nat');
      // Closing the document forgets both.
      t.closed.fire(t.doc);
      t.backend.answerType = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'stopped' }));
      assert.deepStrictEqual(await t.hints(), []);
    });

    test('a save, then typing before its load answered: the hints stay, carried over to the new index; nothing asked (fifth review of M3)', async () => {
      // The load replaced the index, the document showed other text again, and the answers, of
      // another index text, were dropped: every hint went (also with files.autoSave = afterDelay).
      const t = setup();
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints());
      const asked = t.backend.calls.length;
      const saved = CLEAN_TEXT.replace('vlen : Vect', '-- a note\nvlen : Vect');
      t.doc.text = `${saved}-- typing`;
      t.doc.version = 5;
      t.doc.isDirty = true;
      t.backend.index = { file: '/w/Clean.idr', text: saved, tokens: CLEAN_TOKENS.map((k) => (k.range.start.line >= 6 ? shifted(k, 1) : k)) };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      const hints = await t.hints();
      assert.deepStrictEqual(t.shown(hints), cleanHints(1));
      assert.strictEqual(t.backend.calls.length, asked);
      assert.ok(hints[5].tooltip?.value.includes('at an earlier check'), hints[5].tooltip?.value);
    });

    test('an editor that is not the active one, whose file was saved and loaded before another file\'s load displaced it: the hints stay (fifth review of M3)', async () => {
      // Its queries are refused, and the answers kept aside were of the index before its save.
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await t.hints();
      const saved = `-- a note\n${CLEAN_TEXT}`;
      t.doc.text = saved;
      t.doc.version = 4;
      t.backend.index = { file: '/w/Clean.idr', text: saved, tokens: CLEAN_TOKENS.map((k) => shifted(k, 1)) };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      t.backend.answerType = REFUSED;
      assert.deepStrictEqual(t.shown(await t.hints()), ['5:15 : Nat', '5:17 : Type', '5:27 : Nat', '7:13 : Nat', '7:15 : Type', '8:7 : Vect ?_ ?_']);
      assert.strictEqual(t.backend.calls.length, 7, 'one query, refused');
    });

    test('a load whose index has no text (the file saved during it): the hints placed by the index before it; nothing asked (fifth review of M3)', async () => {
      const t = setup();
      await t.hints();
      const asked = t.backend.calls.length;
      t.doc.text = `-- a note\n${CLEAN_TEXT}`;
      t.doc.version = 4;
      t.backend.index = { file: '/w/Clean.idr', tokens: CLEAN_TOKENS.map((k) => shifted(k, 1)) };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      assert.deepStrictEqual(t.shown(await t.hints()), ['5:15 : Nat', '5:17 : Type', '5:27 : Nat', '7:13 : Nat', '7:15 : Type', '8:7 : Vect ?_ ?_']);
      assert.strictEqual(t.backend.calls.length, asked);
      // The document clean and showing exactly the text of the index before (the file saved back to
      // it during the load): still nothing asked while the file's own index has no text — the
      // compiler's last load read a text the extension does not know, and its answers would be kept
      // as the older index's (seventh review of M3: no test pinned this; without the check every
      // hinted token was asked).
      t.doc.text = CLEAN_TEXT;
      t.doc.version = 5;
      const back = await t.hints();
      assert.deepStrictEqual(t.shown(back), cleanHints());
      assert.strictEqual(t.backend.calls.length, asked);
      assert.ok(back[5].tooltip?.value.includes('at an earlier check'), back[5].tooltip?.value);
      // No index at all (the root released): nothing.
      t.backend.index = undefined;
      assert.deepStrictEqual(await t.hints(), []);
    });

    test('the answers kept do not keep a token index the backend replaced alive: after a load that built nothing, and aside for a hidden editor (seventh review of M3)', async () => {
      // Until that review they held the whole index they were asked with (one of 24,000 tokens is
      // about 5 MB [unit-level, the verifier's probe]). Node gives the collector to a new context once
      // the flag is set.
      v8.setFlagsFromString('--expose-gc');
      const gc = vm.runInNewContext('gc') as () => void;
      /** Whether `ref`'s index was collected: a WeakRef keeps its target until the job that made or read it ends. */
      const collected = async (ref: WeakRef<TokenIndex>): Promise<boolean> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
        return ref.deref() === undefined;
      };
      const indexOf = (): TokenIndex => ({ file: '/w/Clean.idr', text: CLEAN_TEXT, tokens: [...CLEAN_TOKENS] });
      // A load that built nothing: the backend's new index has the same text; the provider runs again.
      const t = setup();
      let first: TokenIndex | undefined = indexOf();
      t.backend.index = first;
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints());
      const replaced = new WeakRef(first);
      first = undefined;
      t.backend.index = indexOf();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints());
      assert.strictEqual(t.backend.calls.length, 6, 'the answers kept');
      assert.ok(await collected(replaced), 'the index of the load before');
      // A hidden editor: another file's load made the answers stale (kept aside), then the file's own
      // load replaced the index; the provider does not run for it.
      const hidden = setup();
      let own: TokenIndex | undefined = indexOf();
      hidden.backend.index = own;
      hidden.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await hidden.hints();
      const aside = new WeakRef(own);
      own = undefined;
      hidden.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      hidden.backend.index = indexOf();
      hidden.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      assert.ok(await collected(aside), 'the index the answers kept aside were asked with');
      // The answers are still there, and still shown where nothing can be asked.
      hidden.backend.answerType = REFUSED;
      assert.deepStrictEqual(hidden.shown(await hidden.hints()), cleanHints());
    });

    test('a load of changed text that built nothing: the answers of the text before are kept aside and carried to the new index, shown where nothing can be asked (seventh review of M3)', async () => {
      // A load sends its highlighting also when it builds nothing [recorded, 0.8.0: the second load of
      // `clean-lookups` has no Building line and 31 highlight frames], as when a build directory shared
      // with the eval session or the user's own build already holds the new text's build (D5). IDE mode
      // announces such a load as `rebuilt` since the same review (backendIde.test.ts); the provider
      // does not rely on it: with the index replaced without a stale event, it sees that the answers
      // are of another text itself. No test pinned that: without it they were dropped.
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints());
      const saved = `-- a note\n${CLEAN_TEXT}`;
      t.doc.text = saved;
      t.doc.version = 4;
      t.backend.index = { file: '/w/Clean.idr', text: saved, tokens: CLEAN_TOKENS.map((k) => shifted(k, 1)) };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      t.backend.answerType = REFUSED;
      const carried = await t.hints();
      assert.deepStrictEqual(t.shown(carried), ['5:15 : Nat', '5:17 : Type', '5:27 : Nat', '7:13 : Nat', '7:15 : Type', '8:7 : Vect ?_ ?_']);
      assert.ok(carried[5].tooltip?.value.includes('at an earlier check'), carried[5].tooltip?.value);
      // With unsaved changes as well (nothing asked).
      t.doc.text = `${saved}-- typing`;
      t.doc.version = 5;
      t.doc.isDirty = true;
      assert.deepStrictEqual(t.shown(await t.hints()), t.shown(carried));
    });

    test('a fresh answer that shows nothing is not replaced by one kept aside, in a refused round or with unsaved changes; kept aside, it does not replace a type (fifth review of M3)', async () => {
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await t.hints();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      // A module it imports broke: xs gets no type now (`Undefined name xs` [live]).
      t.backend.answerType = (_l, _c, name) => Promise.resolve(name === 'xs' ? undefined : typeInfo(RECORDED[name]));
      assert.deepStrictEqual(t.shown(await t.hints(new FakeRange(7, 0, 7, 19))), []);
      t.backend.answerType = REFUSED;
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints().slice(0, 5), 'refused: xs shows nothing');
      t.doc.text = `-- a note\n${CLEAN_TEXT}`;
      t.doc.version = 4;
      t.doc.isDirty = true;
      assert.deepStrictEqual(t.shown(await t.hints()), ['5:15 : Nat', '5:17 : Type', '5:27 : Nat', '7:13 : Nat', '7:15 : Type'], 'unsaved: xs shows nothing');
      // The module fixed: its load makes those answers stale too; where nothing can be asked, the
      // type kept aside comes back (the answer that showed nothing did not replace it).
      t.doc.text = CLEAN_TEXT;
      t.doc.version = 5;
      t.doc.isDirty = false;
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints());
    });

    test('answers kept aside by two loads are merged: a round that asked about part of the file keeps the others (fifth review of M3)', async () => {
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await t.hints(new FakeRange(4, 0, 6, 40));
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      t.backend.answerType = (_l, _c, name) => Promise.resolve(typeInfo(name === 'xs' ? 'xs : List Nat' : RECORDED[name]));
      await t.hints(new FakeRange(7, 0, 7, 19));
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      t.backend.answerType = REFUSED;
      assert.deepStrictEqual(t.shown(await t.hints()), [...cleanHints().slice(0, 5), '7:7 : List Nat']);
    });

    test('a line edited in place between two indexes keeps its hints when the new index cannot be asked: the same text before the variable (sixth review of M3)', async () => {
      // A save, typing again before its load answered: the answers kept aside were carried to the
      // new index across equal lines only, so the hint of the line being typed on went (and the text
      // after the variable moved left) until the next save, load and query round.
      const saved = ['module B', '', 'vlen : List a -> Nat', 'vlen xs = length xs', ''];
      const t = setup(fakeDoc({ fileName: '/w/B.idr', text: saved.join('\n'), version: 1 }));
      const tokens = [token(2, 14, 15, 'bound', 'a'), token(3, 5, 7, 'bound', 'xs')];
      t.backend.index = { file: '/w/B.idr', text: saved.join('\n'), tokens };
      t.backend.answerType = (_l, _c, name) => Promise.resolve(typeInfo(name === 'a' ? 'a : Type' : 'xs : List a'));
      t.loads.fire({ root: looseRoot('/w'), file: '/w/B.idr', rebuilt: true });
      assert.deepStrictEqual(t.shown(await t.hints()), ['2:15 : Type', '3:7 : List a']);
      const edited = saved.join('\n').replace('vlen xs = length xs', 'vlen xs = length xs + 0');
      t.doc.text = `${edited}-- still typing`;
      t.doc.version = 4;
      t.doc.isDirty = true;
      t.backend.index = { file: '/w/B.idr', text: edited, tokens };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/B.idr', rebuilt: true });
      const asked = t.backend.calls.length;
      assert.deepStrictEqual(t.shown(await t.hints()), ['2:15 : Type', '3:7 : List a']);
      assert.strictEqual(t.backend.calls.length, asked, 'nothing asked');
      // Other text before the variable on the edited line: not the same place, no hint.
      const moved = saved.join('\n').replace('vlen xs = length xs', 'vlen  xs = length xs');
      t.doc.text = `${moved}-- still typing`;
      t.doc.version = 5;
      t.backend.index = { file: '/w/B.idr', text: moved, tokens: [tokens[0], token(3, 6, 8, 'bound', 'xs')] };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/B.idr', rebuilt: true });
      assert.deepStrictEqual(t.shown(await t.hints()), ['2:15 : Type']);
    });

    test('two clauses swapped and both edited, saved, the new index not asked: no hint shows the other clause\'s type (sixth review of M3)', async () => {
      // The lines are paired as edited in place, and x is at the same columns in both: carried over
      // by its line alone, the Left clause's answer went to the Right clause's x and back.
      const saved = ['module M', '', 'f : Either Nat String -> Nat', 'f (Left  x) = x', 'f (Right x) = length x', ''];
      const t = setup(fakeDoc({ fileName: '/w/M.idr', text: saved.join('\n'), version: 1 }));
      const clauses = [token(3, 9, 10, 'bound', 'x'), token(3, 14, 15, 'bound', 'x'), token(4, 9, 10, 'bound', 'x'), token(4, 21, 22, 'bound', 'x')];
      t.backend.index = { file: '/w/M.idr', text: saved.join('\n'), tokens: clauses };
      const types: Record<string, string> = { '3:9': 'x : Nat', '4:9': 'x : String' };
      t.backend.answerType = (line, character) => Promise.resolve(typeInfo(types[`${line}:${character}`] ?? 'x : ?'));
      t.loads.fire({ root: looseRoot('/w'), file: '/w/M.idr', rebuilt: true });
      assert.deepStrictEqual(t.shown(await t.hints()), ['3:10 : Nat', '4:10 : String']);
      const swapped = ['module M', '', 'f : Either Nat String -> Nat', 'f (Right x) = length x + 0', 'f (Left  x) = x + 0', ''].join('\n');
      t.doc.text = swapped;
      t.doc.version = 2;
      t.backend.index = { file: '/w/M.idr', text: swapped, tokens: [token(3, 9, 10, 'bound', 'x'), token(3, 21, 22, 'bound', 'x'), token(4, 9, 10, 'bound', 'x'), token(4, 14, 15, 'bound', 'x')] };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/M.idr', rebuilt: true });
      t.backend.answerType = REFUSED;
      assert.deepStrictEqual(t.shown(await t.hints()), []);
    });

    test('a saved file with mixed line breaks or a lone \\r: the hints are asked for and shown at the lines VS Code shows (sixth review of M3)', async () => {
      // VS Code joins a document's lines with one line break and breaks a line at a lone \r too, so
      // the document never showed the text the load read, and nothing was asked: no hints at all.
      for (const [what, disk, shown, hint, asked] of [
        ['a CRLF line in an LF file', 'module M\r\n\nf : Nat -> Nat\nf x = x\n', 'module M\n\nf : Nat -> Nat\nf x = x\n', '3:3 : Nat', 'typeAt 3:2 x'],
        ['a lone \\r in a comment', 'module M\n-- a\r-- b\nf : Nat -> Nat\nf x = x\n', 'module M\n-- a\n-- b\nf : Nat -> Nat\nf x = x\n', '4:3 : Nat', 'typeAt 4:2 x'],
        // The variable on the line that holds the \r (seventh review of M3: that line was never
        // paired, so its hint was missing).
        ['a lone \\r after the variable on its line', 'module M\n\nf : Nat -> Nat\nf x = x -- a\r-- b\n', 'module M\n\nf : Nat -> Nat\nf x = x -- a\n-- b\n', '3:3 : Nat', 'typeAt 3:2 x'],
      ] as const) {
        const t = setup(fakeDoc({ fileName: '/w/M.idr', text: shown, version: 1 }));
        // The compiler's lines: split at \n only.
        t.backend.index = { file: '/w/M.idr', text: disk, tokens: [token(3, 2, 3, 'bound', 'x')] };
        t.backend.answerType = () => Promise.resolve(typeInfo('x : Nat'));
        assert.deepStrictEqual(t.shown(await t.hints()), [hint], what);
        assert.deepStrictEqual(t.backend.calls, [asked], `${what}: asked at the editor's position, which the backend converts`);
        // With unsaved changes, nothing is asked, as for any other text.
        t.doc.isDirty = true;
        t.doc.version = 2;
        t.doc.text = `${shown}-- typing`;
        assert.deepStrictEqual(t.shown(await t.hints()), [hint], `${what}, typing: the kept hint`);
        assert.strictEqual(t.backend.calls.length, 1);
      }
      // The declarations are read at the compiler's lines too: the use of x on f's second line gets
      // none, g's x gets one (read at the editor's lines, the lone \r moved both into the wrong unit).
      const disk = 'module M\n-- a\r-- b\nf : Nat -> Nat\nf x =\n  x\ng : Nat -> Nat\ng x = x\n';
      const t = setup(fakeDoc({ fileName: '/w/M.idr', text: disk.replace('\r', '\n'), version: 1 }));
      t.backend.index = { file: '/w/M.idr', text: disk, tokens: [token(3, 2, 3, 'bound', 'x'), token(4, 2, 3, 'bound', 'x'), token(6, 2, 3, 'bound', 'x')] };
      t.backend.answerType = () => Promise.resolve(typeInfo('x : Nat'));
      assert.deepStrictEqual(t.shown(await t.hints()), ['4:3 : Nat', '7:3 : Nat']);
    });

    test('a lone \\r on a hinted line, the file saved with the document\'s line break, the new index not asked: the hints are carried over (eighth review of M3)', async () => {
      // VS Code writes a document's lines joined by its one line break, so the saved text has a line
      // more where the lone \r was. Diffed as the compiler's lines, the line that held it was paired
      // with neither of the two it became, and its answers were not carried over (the verifier's probe).
      const text = 'module M\n\nf : Nat -> Nat\nf x = x -- a\r-- b\ng : Nat -> Nat\ng y = y\n';
      const cases: Array<{ what: string; disk: string; tokens: Token[]; hints: string[]; saved: string; moved: Token[]; after: string[] }> = [
        {
          what: 'a variable before the \\r',
          disk: text,
          tokens: [token(3, 2, 3, 'bound', 'x'), token(5, 2, 3, 'bound', 'y')],
          hints: ['3:3 : Nat', '6:3 : Nat'],
          saved: text.replace('\r', '\n'),
          moved: [token(3, 2, 3, 'bound', 'x'), token(6, 2, 3, 'bound', 'y')],
          after: ['3:3 : Nat', '6:3 : Nat'],
        },
        // After the \r on its compiler line: the answer is kept by the compiler's column 10.
        {
          what: 'a variable after the \\r',
          disk: 'module M\n\nf : Nat -> Nat\n{- a\r-} f x = x\n',
          tokens: [token(3, 10, 11, 'bound', 'x')],
          hints: ['4:6 : Nat'],
          saved: 'module M\n\nf : Nat -> Nat\n{- a\n-} f x = x\n',
          moved: [token(4, 5, 6, 'bound', 'x')],
          after: ['4:6 : Nat'],
        },
        // A new text that keeps the lone \r (a line added above it outside VS Code): its tokens are
        // moved to the editor's lines too before the diff.
        {
          what: 'the \\r kept, a line added above',
          disk: text,
          tokens: [token(3, 2, 3, 'bound', 'x'), token(5, 2, 3, 'bound', 'y')],
          hints: ['3:3 : Nat', '6:3 : Nat'],
          saved: `-- new\n${text}`,
          moved: [token(4, 2, 3, 'bound', 'x'), token(6, 2, 3, 'bound', 'y')],
          after: ['4:3 : Nat', '7:3 : Nat'],
        },
        // The \r kept before the variable, its line edited after it (a file saved outside VS Code):
        // the lines are compared up to the token's end on the editor's line (column 6), not the
        // compiler's (column 11, past the edit) (ninth review of M3, the verifier's mutant I4).
        {
          what: 'the \\r kept before the variable, the line edited after it',
          disk: 'module M\n\nf : Nat -> Nat\n{- a\r-} f x = x\n',
          tokens: [token(3, 10, 11, 'bound', 'x')],
          hints: ['4:6 : Nat'],
          saved: 'module M\n\nf : Nat -> Nat\n{- a\r-} f x = x + 1\n',
          moved: [token(3, 10, 11, 'bound', 'x')],
          after: ['4:6 : Nat'],
        },
      ];
      for (const { what, disk, tokens, hints, saved, moved, after } of cases) {
        const t = setup(fakeDoc({ fileName: '/w/M.idr', text: disk.replace('\r', '\n'), version: 1 }));
        t.backend.index = { file: '/w/M.idr', text: disk, tokens };
        t.backend.answerType = (_line, _character, name) => Promise.resolve(typeInfo(`${name} : Nat`));
        t.loads.fire({ root: looseRoot('/w'), file: '/w/M.idr', rebuilt: true });
        assert.deepStrictEqual(t.shown(await t.hints()), hints, `${what}: clean`);
        // Saved, and typing again before the save's load answered: the new index is not asked.
        const shown = saved.replace('\r', '\n');
        t.doc.isDirty = true;
        t.doc.version = 2;
        t.doc.text = `${shown}-- typing`;
        t.backend.index = { file: '/w/M.idr', text: saved, tokens: moved };
        t.loads.fire({ root: looseRoot('/w'), file: '/w/M.idr', rebuilt: true });
        const asked = t.backend.calls.length;
        assert.deepStrictEqual(t.shown(await t.hints()), after, `${what}: typing`);
        assert.strictEqual(t.backend.calls.length, asked, `${what}: nothing asked`);
        // Clean, and the new index's queries refused (a visible editor that is not the active one).
        t.doc.isDirty = false;
        t.doc.version = 3;
        t.doc.text = shown;
        t.backend.answerType = REFUSED;
        assert.deepStrictEqual(t.shown(await t.hints()), after, `${what}: refused`);
      }
    });

    test('after a load that failed (a broken import), an answer that shows nothing does not take the place of a type kept aside; after a successful one it does (sixth review of M3)', async () => {
      // The compiler answers `Undefined name xs` about every name of the file then [live, fifth
      // review of M3]: the hints went while the file was active and clean, and came back once the
      // import was fixed — two layout jumps.
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints());
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true, failed: false });
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true, failed: true });
      t.backend.answerType = () => Promise.resolve(undefined);
      const asked = t.backend.calls.length;
      const kept = await t.hints();
      assert.deepStrictEqual(t.shown(kept), cleanHints());
      assert.ok(kept[5].tooltip?.value.includes('at an earlier check'), kept[5].tooltip?.value);
      assert.strictEqual(t.backend.calls.length, asked + 6, 'asked (the backend keeps its answers per load)');
      // An answer that describes the type is taken as ever.
      t.backend.answerType = (_l, _c, name) => Promise.resolve(name === 'xs' ? typeInfo('xs : Vect 2 Nat') : undefined);
      assert.deepStrictEqual(t.shown(await t.hints()), [...cleanHints().slice(0, 5), '7:7 : Vect 2 Nat']);
      t.doc.text = `${CLEAN_TEXT}-`;
      t.doc.version = 4;
      t.doc.isDirty = true;
      assert.deepStrictEqual(t.shown(await t.hints()), [...cleanHints().slice(0, 5), '7:7 : Vect 2 Nat'], 'typing');
      // A load that succeeded: an answer that shows nothing is an answer again.
      t.doc.text = CLEAN_TEXT;
      t.doc.version = 5;
      t.doc.isDirty = false;
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true, failed: false });
      t.backend.answerType = () => Promise.resolve(undefined);
      assert.deepStrictEqual(t.shown(await t.hints()), []);
    });

    test('closing the file\'s own document forgets that its last load failed: once it is shown again, an answer that shows nothing is kept (ninth review of M3)', async () => {
      // Until a load of it arrives (the manual trigger), such answers were otherwise asked again every
      // round; nothing is kept aside after a close for them to protect.
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true, failed: true });
      t.backend.answerType = () => Promise.resolve(undefined);
      await t.hints();
      const failedRound = t.backend.calls.length;
      await t.hints();
      assert.strictEqual(t.backend.calls.length, failedRound + 6, 'while the last load failed: asked again every round');
      t.closed.fire(t.doc);
      assert.deepStrictEqual(t.shown(await t.hints()), []);
      const reopened = t.backend.calls.length;
      await t.hints();
      assert.strictEqual(t.backend.calls.length, reopened, 'kept: not asked again');
    });

    test('closing another document of the same path (a git: one) keeps the file\'s answers and its root (sixth review of M3)', async () => {
      // VS Code gives a git: document the file's fileName: its close (the Source Control view's Open
      // Changes) dropped the kept hints, and the file's root, so that a load of an import that
      // changed no longer made its answers stale.
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: false });
      await t.hints();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      t.backend.answerType = REFUSED;
      const gitDoc = fakeDoc({ fileName: '/w/Clean.idr', text: CLEAN_TEXT, scheme: 'git' });
      t.closed.fire(gitDoc);
      assert.deepStrictEqual(t.shown(await t.hints()), cleanHints(), 'the answers kept aside stay');
      t.backend.answerType = (_l, _c, name) => Promise.resolve(typeInfo(RECORDED[name]));
      await t.hints();
      t.closed.fire(gitDoc);
      const asked = t.backend.calls.length;
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      await t.hints();
      assert.strictEqual(t.backend.calls.length, asked + 6, 'a load of its root still makes its answers stale');
    });

    test('the file\'s own document closed and opened again with no load of its own: a load of its root still makes the hints asked since stale (tenth review of M3)', async () => {
      // Under the manual trigger a reopened document is not loaded, and the session still answers
      // about it while it is the file loaded last; the close forgot the file's root, so its hints
      // were never asked again after a load of a changed import (the verifier's probe).
      const t = setup();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      await t.hints();
      t.closed.fire(t.doc);
      const closed = t.backend.calls.length;
      await t.hints();
      await t.hints();
      assert.strictEqual(t.backend.calls.length, closed + 6, 'asked again after the close, then kept');
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Other.idr', rebuilt: true });
      await t.hints();
      assert.strictEqual(t.backend.calls.length, closed + 12, 'made stale by a load of its root');
    });

    test('a cancelled request asks nothing more', async () => {
      const t = setup();
      const cancel = fakeToken();
      t.backend.answerType = (_l, _c, name) => {
        cancel.isCancellationRequested = true;
        return Promise.resolve(typeInfo(RECORDED[name]));
      };
      await t.hints(undefined, cancel);
      assert.deepStrictEqual(t.backend.calls, ['typeAt 4:14 n']);
    });

    test('with unsaved changes: the kept hints of the tokens carried over, at their new places; nothing asked (third review of M3)', async () => {
      const t = setup();
      const saved = t.shown(await t.hints());
      assert.deepStrictEqual(saved, ['4:15 : Nat', '4:17 : Type', '4:27 : Nat', '6:13 : Nat', '6:15 : Type', '7:7 : Vect ?_ ?_']);
      const asked = t.backend.calls.length;
      // A line inserted above `vlen`: its hints move down with it.
      t.doc.text = CLEAN_TEXT.replace('vlen : Vect', '-- a note\nvlen : Vect');
      t.doc.version = 4;
      t.doc.isDirty = true;
      assert.deepStrictEqual(t.shown(await t.hints()), ['4:15 : Nat', '4:17 : Type', '4:27 : Nat', '7:13 : Nat', '7:15 : Type', '8:7 : Vect ?_ ?_']);
      // Typing after `xs` on its line: the hint before the cursor stays where it was.
      t.doc.text = CLEAN_TEXT.replace('vlen xs = ?vlen_rhs', 'vlen xs = ?vlen_rhs + 1');
      t.doc.version = 5;
      assert.deepStrictEqual(t.shown(await t.hints()), saved);
      // A change before a token on its line: that token's hint goes; the others stay.
      t.doc.text = CLEAN_TEXT.replace('vlen xs = ?vlen_rhs', 'vlen  xs = ?vlen_rhs');
      t.doc.version = 6;
      assert.deepStrictEqual(t.shown(await t.hints()), saved.slice(0, -1));
      // Only in the range asked about.
      assert.deepStrictEqual(t.shown(await t.hints(new FakeRange(6, 0, 7, 0))), ['6:13 : Nat', '6:15 : Type']);
      assert.strictEqual(t.backend.calls.length, asked, 'the compiler is asked nothing while the text differs');
    });

    test('with two separate unsaved edits: each kept hint on its own variable\'s line, not a neighbour\'s (fourth review of M3)', async () => {
      // The reviewer's probe: the Left clause's `x` got the Right clause's `: String`, and the Right
      // clause's none, with a line inserted at the top and the last line edited.
      const saved = ['module M', '', 'f : Either Nat String -> Nat', 'f (Left  x) = x', 'f (Right x) = length x', '', 'g : Nat', 'g = 1'];
      const t = setup(fakeDoc({ fileName: '/w/M.idr', text: saved.join('\n'), version: 1 }));
      t.backend.index = {
        file: '/w/M.idr',
        text: saved.join('\n'),
        tokens: [token(3, 9, 10, 'bound', 'x'), token(3, 14, 15, 'bound', 'x'), token(4, 9, 10, 'bound', 'x'), token(4, 21, 22, 'bound', 'x')],
      };
      const types: Record<string, string> = { '3:9': 'x : Nat', '4:9': 'x : String' };
      t.backend.answerType = (line, character) => Promise.resolve(typeInfo(types[`${line}:${character}`] ?? 'x : ?'));
      assert.deepStrictEqual(t.shown(await t.hints()), ['3:10 : Nat', '4:10 : String']);
      t.doc.isDirty = true;
      for (const [version, shown] of [
        [2, ['module M', '-- note', '', 'f : Either Nat String -> Nat', 'f (Left  x) = x', 'f (Right x) = length x', '', 'g : Nat', 'g = 2']],
        // The same line count: a line inserted at the top, the last one deleted.
        [3, ['module M', '-- note', '', 'f : Either Nat String -> Nat', 'f (Left  x) = x', 'f (Right x) = length x', '', 'g : Nat']],
      ] as const) {
        t.doc.text = shown.join('\n');
        t.doc.version = version;
        assert.deepStrictEqual(t.shown(await t.hints()), ['4:10 : Nat', '5:10 : String'], `version ${version}`);
      }
    });

    test('two clauses swapped and both edited: no hint on a variable kept by its text alone, with other text before it (fifth review of M3)', async () => {
      // Each clause's line is paired with the other's as a line edited in place, and x is at the same
      // columns in both: the kept hints showed each other's types [unit-level, the reviewer's probe].
      const saved = ['module M', '', 'f : Either Nat String -> Nat', 'f (Left  x) = x', 'f (Right x) = length x', ''];
      const t = setup(fakeDoc({ fileName: '/w/M.idr', text: saved.join('\n'), version: 1 }));
      t.backend.index = {
        file: '/w/M.idr',
        text: saved.join('\n'),
        tokens: [token(3, 9, 10, 'bound', 'x'), token(3, 14, 15, 'bound', 'x'), token(4, 9, 10, 'bound', 'x'), token(4, 21, 22, 'bound', 'x')],
      };
      const types: Record<string, string> = { '3:9': 'x : Nat', '4:9': 'x : String' };
      t.backend.answerType = (line, character) => Promise.resolve(typeInfo(types[`${line}:${character}`] ?? 'x : ?'));
      assert.deepStrictEqual(t.shown(await t.hints()), ['3:10 : Nat', '4:10 : String']);
      t.doc.isDirty = true;
      t.doc.text = ['module M', '', 'f : Either Nat String -> Nat', 'f (Right x) = length x + 0', 'f (Left  x) = x + 0', ''].join('\n');
      t.doc.version = 2;
      assert.deepStrictEqual(t.shown(await t.hints()), []);
      // Typing after the variable on its line keeps its hint: the text before it is the same.
      t.doc.text = saved.join('\n').replace('f (Left  x) = x', 'f (Left  x) = x + 0');
      t.doc.version = 3;
      assert.deepStrictEqual(t.shown(await t.hints()), ['3:10 : Nat', '4:10 : String']);
    });

    test('nothing is asked while the document has unsaved changes, shows another text than the index, or is not a file; with no kept answers nothing is shown', async () => {
      const dirty = setup(fakeDoc({ fileName: '/w/Clean.idr', text: CLEAN_TEXT, version: 3, isDirty: true }));
      assert.deepStrictEqual(await dirty.hints(), []);
      const edited = setup();
      edited.doc.text = `${CLEAN_TEXT}-- saved since\n`; // saved again and not loaded since (the `manual` trigger)
      edited.doc.version = 4;
      assert.deepStrictEqual(await edited.hints(), []);
      const reopened = setup();
      // Closed, changed on disk and opened again: VS Code numbers it from 1 again, the old index's
      // text is not the document's (review of M3: the version alone matched).
      reopened.backend.index = { ...(reopened.backend.index as TokenIndex), text: `-- before the checkout\n${CLEAN_TEXT}` };
      reopened.doc.version = 1;
      assert.deepStrictEqual(await reopened.hints(), []);
      const unknown = setup();
      unknown.backend.index = { file: '/w/Clean.idr', tokens: CLEAN_TOKENS }; // the text changed during the load
      assert.deepStrictEqual(await unknown.hints(), []);
      const none = setup();
      none.backend.index = undefined;
      assert.deepStrictEqual(await none.hints(), []);
      const untitled = setup(fakeDoc({ fileName: 'Untitled-1', text: CLEAN_TEXT, scheme: 'untitled' }));
      assert.deepStrictEqual(await untitled.hints(), []);
      for (const t of [dirty, edited, reopened, unknown, none, untitled]) {
        assert.deepStrictEqual(t.backend.calls, []);
      }
    });

    test('an undo or a revert back to the text the load read (a new version, the same text): the hints again', async () => {
      const t = setup();
      t.backend.index = { ...(t.backend.index as TokenIndex), text: CLEAN_TEXT };
      t.doc.version = 5;
      assert.ok((await t.hints()).length > 0);
    });

    test('idris2.inlayHints.variableTypes off: nothing; a change of it asks VS Code for the hints again', async () => {
      const t = setup();
      t.config.variableTypes = false;
      assert.deepStrictEqual(await t.hints(), []);
      assert.deepStrictEqual(t.backend.calls, []);
      const before = t.changes();
      t.config.change('inlayHints');
      t.config.change('eval');
      assert.strictEqual(t.changes(), before + 1);
    });

    test('an Idris file\'s editor becoming active asks VS Code for the hints again; another editor, or none, does not (second review of M3)', () => {
      // Two editors side by side: a load of the one that built something dropped the other's kept
      // answers, and its passive query was refused while it was not the active document.
      const t = setup();
      const before = t.changes();
      t.activated.fire({ document: fakeDoc({ fileName: '/w/B.idr', text: 'b = 1' }) });
      assert.strictEqual(t.changes(), before + 1);
      t.activated.fire({ document: fakeDoc({ fileName: '/w/notes.md', text: '# x', languageId: 'markdown' }) });
      t.activated.fire({ document: fakeDoc({ fileName: 'Untitled-1', text: 'x', scheme: 'untitled' }) });
      t.activated.fire(undefined);
      assert.strictEqual(t.changes(), before + 1);
    });

    test('disposing unregisters the provider and its listeners', () => {
      const t = setup();
      t.registration.dispose();
      const before = t.changes();
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      t.activated.fire({ document: t.doc });
      assert.strictEqual(t.changes(), before);
    });
  });
});
