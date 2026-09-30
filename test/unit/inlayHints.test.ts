// features/intelligence/inlayHints.ts: which :bound tokens get a hint (the first of each name per
// top-level declaration), the label from a positional :type-of, the requests (visible range only,
// one at a time, kept per load), and when nothing is shown (unsaved changes, a token index of
// another text, the setting off). The tokens and answers are those of the recorded transcript
// `clean-queries` (test/fixtures/transcripts/0.8.0, Clean.idr of the broken workspace).
import * as assert from 'assert';
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
      // A load of that text: its new index is not the one those answers were asked with; where a
      // query is refused, nothing is shown for it.
      t.backend.index = { file: '/w/Clean.idr', text: t.doc.text, tokens: CLEAN_TOKENS };
      t.loads.fire({ root: looseRoot('/w'), file: '/w/Clean.idr', rebuilt: true });
      t.backend.answerType = () => Promise.reject(new IdrisException({ kind: 'Unsupported', reason: 'stopped' }));
      assert.deepStrictEqual(await t.hints(), []);
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
