// features/holes/navigation.ts and the commands Next Hole / Previous Hole of
// features/holes/register.ts: where the holes of a document's text are (M0's lexer, never in a
// comment, a string or a prose line), the order the commands move in (document order, wrapping),
// and how a hole the compiler reported is found again in a text edited since.
import * as assert from 'assert';
import type { EditorRange } from '../../src/core/positions';
import { offsetOf, syntaxModelOf } from '../../src/features/intelligence/occurrence';
import { editorRange, holeTokens, locateHole, nextHole, previousHole } from '../../src/features/holes/navigation';
import { registerHoles, type HolesApi } from '../../src/features/holes/register';
import type { HolesDeps } from '../../src/features/holes/types';
import { Emitter } from '../../src/core/event';
import { FakeDocument, FakePosition, FakeRange, FakeUri, quietLog } from './support/intelligence';

/** The texts of the holes the model of `text` has, in order. */
function holesOf(text: string, fileName = '/w/A.idr'): string[] {
  const model = syntaxModelOf(new FakeDocument(fileName, text)) ?? assert.fail('not modelled');
  return holeTokens(model).map((h) => text.slice(h.start, h.end));
}

const r = (l1: number, c1: number, l2: number, c2: number): EditorRange => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

suite('holes: where the text has holes (M0 lexer)', () => {
  test('holes of code, in document order; none in comments, doc comments, strings or characters', () => {
    const text = [
      'module A',
      '-- ?inLineComment',
      '{- ?inBlock {- ?nested -} -}',
      '||| ?inDocComment',
      'f : Nat -> String',
      'f n = g ?first "?inString" \'?\' ?second',
      '  where g : Nat -> String -> Char -> Nat -> String',
      's : String',
      's = "\\{?inInterpolation} x"',
      'u : Nat',
      'u = ?ünïcode_1',
    ].join('\n');
    assert.deepStrictEqual(holesOf(text), ['?first', '?second', '?inInterpolation', '?ünïcode_1']);
  });

  test('bird tracks: a `?name` on a prose line is no hole', () => {
    const text = ['Prose with ?notAHole in it.', '', '> f : Nat', '> f = ?code', '', 'More ?prose.'].join('\n');
    assert.deepStrictEqual(holesOf(text, '/w/A.lidr'), ['?code']);
  });

  test('the fenced literate styles are not modelled (M12): no model, so the commands say so', () => {
    assert.strictEqual(syntaxModelOf(new FakeDocument('/w/A.idr.md', '```idris\nf = ?h\n```\n', 'markdown')), undefined);
  });
});

suite('holes: Next and Previous Hole order', () => {
  // Offsets: ?a at 0–2, ?b at 10–12, ?c at 20–22.
  const holes = [
    { start: 0, end: 2 },
    { start: 10, end: 12 },
    { start: 20, end: 22 },
  ];

  test('Next: the first hole that starts after the offset; from a hole\'s start or inside it, the one after', () => {
    assert.deepStrictEqual(nextHole(holes, 5), { hole: holes[1], wrapped: false });
    assert.deepStrictEqual(nextHole(holes, 10), { hole: holes[2], wrapped: false });
    assert.deepStrictEqual(nextHole(holes, 11), { hole: holes[2], wrapped: false });
    assert.deepStrictEqual(nextHole(holes, 9), { hole: holes[1], wrapped: false });
  });

  test('Next wraps around to the first hole after the last one', () => {
    assert.deepStrictEqual(nextHole(holes, 20), { hole: holes[0], wrapped: true });
    assert.deepStrictEqual(nextHole(holes, 30), { hole: holes[0], wrapped: true });
  });

  test('Previous: the last hole that starts before the offset; from a selected hole, the one before; from inside one, its start', () => {
    assert.deepStrictEqual(previousHole(holes, 15), { hole: holes[1], wrapped: false });
    assert.deepStrictEqual(previousHole(holes, 20), { hole: holes[1], wrapped: false });
    assert.deepStrictEqual(previousHole(holes, 21), { hole: holes[2], wrapped: false });
    assert.deepStrictEqual(previousHole(holes, 1), { hole: holes[0], wrapped: false });
  });

  test('Previous wraps around to the last hole before the first one', () => {
    assert.deepStrictEqual(previousHole(holes, 0), { hole: holes[2], wrapped: true });
  });

  test('no hole: nothing', () => {
    assert.strictEqual(nextHole([], 0), undefined);
    assert.strictEqual(previousHole([], 0), undefined);
  });

  test('stepping Next from the start visits every hole once, in document order, then wraps', () => {
    const text = 'f = ?one\ng = (?two, ?three)\nh = ?four';
    const model = syntaxModelOf(new FakeDocument('/w/A.idr', text)) ?? assert.fail('not modelled');
    const tokens = holeTokens(model);
    const seen: string[] = [];
    let from = 0;
    for (let i = 0; i < 5; i++) {
      const step = nextHole(tokens, from) ?? assert.fail('no step');
      seen.push(`${text.slice(step.hole.start, step.hole.end)}${step.wrapped ? ' (wrapped)' : ''}`);
      from = step.hole.start;
    }
    assert.deepStrictEqual(seen, ['?one', '?two', '?three', '?four', '?one (wrapped)']);
    const back: string[] = [];
    for (let i = 0; i < 5; i++) {
      const step = previousHole(tokens, from) ?? assert.fail('no step');
      back.push(`${text.slice(step.hole.start, step.hole.end)}${step.wrapped ? ' (wrapped)' : ''}`);
      from = step.hole.start;
    }
    assert.deepStrictEqual(back, ['?four (wrapped)', '?three', '?two', '?one', '?four (wrapped)']);
  });
});

suite('holes: finding a reported hole in the text (locateHole)', () => {
  const lines = (text: string) => (line: number) => text.split('\n')[line];
  const model = (text: string, fileName = '/w/A.idr') => syntaxModelOf(new FakeDocument(fileName, text));

  test('the recorded range, when the text still has `?name` there', () => {
    const text = 'module A\n\nvlen : List a -> Nat\nvlen xs = ?vlen_rhs';
    assert.deepStrictEqual(locateHole(model(text), lines(text), 'vlen_rhs', r(3, 10, 3, 19)), r(3, 10, 3, 19));
  });

  test('moved by an edit made since: the `?name` token nearest to the recorded line', () => {
    const text = 'module A\n\n-- two lines\n-- added above\nvlen : List a -> Nat\nvlen xs =\n  ?vlen_rhs';
    assert.deepStrictEqual(locateHole(model(text), lines(text), 'vlen_rhs', r(3, 10, 3, 19)), r(6, 2, 6, 11));
  });

  test('two `?name` in the text (one typed since): the one nearer the recorded line; the first of two as near', () => {
    const text = 'f = ?h\n\n\n\n\n\n\ng = ?h';
    assert.deepStrictEqual(locateHole(model(text), lines(text), 'h', r(6, 4, 6, 6)), r(7, 4, 7, 6));
    assert.deepStrictEqual(locateHole(model(text), lines(text), 'h', r(1, 4, 1, 6)), r(0, 4, 0, 6));
    assert.deepStrictEqual(locateHole(model('f = ?h\ng = ?h'), lines('f = ?h\ng = ?h'), 'h', r(5, 0, 5, 2)), r(1, 4, 1, 6));
    assert.deepStrictEqual(locateHole(model('f = ?h\n\ng = ?h'), lines('f = ?h\n\ng = ?h'), 'h', r(1, 0, 1, 2)), r(0, 4, 0, 6));
  });

  test('two holes of one name in different namespaces (they load; ninth review of M4): moved, the one of the same index; another count of them: undefined, not the other hole', () => {
    const ns = ['module NS', 'namespace A', '  export', '  x : Nat', '  x = ?todo', '', 'namespace B', '  export', '  y : Nat', '  y = ?todo'];
    const moved = ['-- one', '-- two', '-- three', ...ns].join('\n');
    // The reviewer's case: B's ?todo recorded at 10:6 (0-based 9:6), three lines inserted above.
    assert.deepStrictEqual(locateHole(model(moved), lines(moved), 'todo', r(9, 6, 9, 11), { index: 1, count: 2 }), r(12, 6, 12, 11));
    assert.deepStrictEqual(locateHole(model(moved), lines(moved), 'todo', r(4, 6, 4, 11), { index: 0, count: 2 }), r(7, 6, 7, 11));
    // Without the ordinal the nearest line would be A's: the reason for it.
    assert.deepStrictEqual(locateHole(model(moved), lines(moved), 'todo', r(9, 6, 9, 11)), r(7, 6, 7, 11));
    const third = [...ns, '', 'z : Nat', 'z = ?todo'].join('\n');
    assert.strictEqual(locateHole(model(`-- one\n${third}`), lines(`-- one\n${third}`), 'todo', r(9, 6, 9, 11), { index: 1, count: 2 }), undefined);
    // The ordinal decides even at the recorded place (final review of M4): another count is a changed file …
    assert.strictEqual(locateHole(model(third), lines(third), 'todo', r(9, 6, 9, 11), { index: 1, count: 2 }), undefined);
    // … namespace A deleted: B's ?todo now sits at A's recorded place, and A is gone …
    const deleted = ['module NS', ...ns.slice(6)].join('\n');
    assert.strictEqual(locateHole(model(deleted), lines(deleted), 'todo', r(4, 6, 4, 11), { index: 0, count: 2 }), undefined);
    // … five lines inserted: A's ?todo now sits at B's recorded place, and B is five lines below it.
    const five = ['-- 1', '-- 2', '-- 3', '-- 4', '-- 5', ...ns].join('\n');
    assert.deepStrictEqual(locateHole(model(five), lines(five), 'todo', r(9, 6, 9, 11), { index: 1, count: 2 }), r(14, 6, 14, 11));
  });

  test('the text the recorded ranges were read from (`unchanged`) with a `?name` the compiler does not list (a `failing` block): the recorded place; edited: undefined (eleventh review of M4)', () => {
    const ns = ['module F', 'namespace A', '  export', '  x : Nat', '  x = ?todo', 'namespace B', '  export', '  y : Nat', '  y = ?todo', 'failing', '  z : Nat', '  z = "s" + ?todo'].join('\n');
    // Live, idris2 0.8.0: :metavariables lists F.A.todo and F.B.todo only, at 5:6 and 10:6 (1-based).
    assert.deepStrictEqual(locateHole(model(ns), lines(ns), 'todo', r(4, 6, 4, 11), { index: 0, count: 2 }, true), r(4, 6, 4, 11));
    assert.deepStrictEqual(locateHole(model(ns), lines(ns), 'todo', r(8, 6, 8, 11), { index: 1, count: 2 }, true), r(8, 6, 8, 11));
    assert.strictEqual(locateHole(model(ns), lines(ns), 'todo', r(8, 6, 8, 11), { index: 1, count: 2 }), undefined);
    // Unchanged, and no token at the recorded place: undefined, not the nearest one.
    assert.strictEqual(locateHole(model(ns), lines(ns), 'todo', r(7, 6, 7, 11), { index: 1, count: 2 }, true), undefined);
    // Unchanged with the same count: the ordinal, as edited.
    const two = ns.split('\n').slice(0, 9).join('\n');
    assert.deepStrictEqual(locateHole(model(two), lines(two), 'todo', r(8, 6, 8, 11), { index: 1, count: 2 }, true), r(8, 6, 8, 11));
  });

  test('no location: the first `?name` of the text', () => {
    const text = 'f = ?h\ng = ?h';
    assert.deepStrictEqual(locateHole(model(text), lines(text), 'h', undefined), r(0, 4, 0, 6));
  });

  test('gone, or only in a comment, a string or a longer name: undefined', () => {
    const text = 'f = 0 -- was ?h\ng = "?h"\nk = ?hh';
    assert.strictEqual(locateHole(model(text), lines(text), 'h', r(0, 4, 0, 6)), undefined);
  });

  test('a hole edited into an identifier in place (unsaved): gone, not the identifier', () => {
    const text = 'module Clean\n\nf : Nat\nf = vlen_rhs\n';
    assert.strictEqual(locateHole(model(text), lines(text), 'vlen_rhs', r(3, 4, 3, 13)), undefined);
    assert.strictEqual(locateHole(undefined, lines(text), 'vlen_rhs', r(3, 4, 3, 12)), undefined);
  });

  test('bird tracks: found on its code line, never on a prose line', () => {
    const text = 'Prose ?h here.\n\n> f : Nat\n> f = ?h';
    assert.deepStrictEqual(locateHole(model(text, '/w/A.lidr'), lines(text), 'h', r(0, 6, 0, 8)), r(3, 6, 3, 8));
  });

  test('a literate style the lexer does not read: only the recorded range, by its text', () => {
    const text = '```idris\nf = ?h\n```';
    assert.deepStrictEqual(locateHole(undefined, lines(text), 'h', r(1, 4, 1, 6)), r(1, 4, 1, 6));
    assert.strictEqual(locateHole(undefined, lines(text), 'h', r(1, 3, 1, 5)), undefined);
    assert.strictEqual(locateHole(undefined, lines(text), 'h', undefined), undefined);
    assert.strictEqual(locateHole(undefined, lines(text), 'h', r(9, 0, 9, 2)), undefined);
  });

  test('editorRange converts the lexer\'s offsets on CRLF text', () => {
    const text = 'f : Nat\r\nf = ?h';
    const m = syntaxModelOf(new FakeDocument('/w/A.idr', text)) ?? assert.fail('not modelled');
    assert.deepStrictEqual(editorRange(m, holeTokens(m)[0]), r(1, 4, 1, 6));
    assert.strictEqual(offsetOf(m, { line: 1, character: 4 }), holeTokens(m)[0].start);
  });
});

// -------------------------------------------------------------------------------------------
// The commands
// -------------------------------------------------------------------------------------------

class FakeSelection extends FakeRange {
  constructor(anchor: FakePosition, active: FakePosition) {
    super(anchor, active);
  }
  isEqual(other: FakeRange): boolean {
    return (
      this.start.line === other.start.line && this.start.character === other.start.character && this.end.line === other.end.line && this.end.character === other.end.character
    );
  }
}

/** A fake of the parts of `HolesApi` that Next and Previous Hole use; the tree view is created and ignored. */
function commandsApi() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const messages: string[] = [];
  const statusMessages: string[] = [];
  const revealed: FakeRange[] = [];
  const state = { editor: undefined as { document: FakeDocument; selection: FakeSelection; revealRange(range: FakeRange): void } | undefined };
  const event = () => () => ({ dispose: () => undefined });
  const api = {
    commands: {
      registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
        commands.set(id, run);
        return { dispose: () => commands.delete(id) };
      },
    },
    window: {
      get activeTextEditor() {
        return state.editor;
      },
      showInformationMessage: (text: string) => {
        messages.push(text);
        return Promise.resolve(undefined);
      },
      setStatusBarMessage: (text: string) => {
        statusMessages.push(text);
        return { dispose: () => undefined };
      },
      createTreeView: () => ({ dispose: () => undefined }),
    },
    workspace: {
      textDocuments: [],
      asRelativePath: (p: string) => p,
      onDidChangeTextDocument: event(),
      onDidSaveTextDocument: event(),
      onDidOpenTextDocument: event(),
      onDidCloseTextDocument: event(),
      onDidDeleteFiles: event(),
      onDidRenameFiles: event(),
      createFileSystemWatcher: () => ({ onDidDelete: event(), dispose: () => undefined }),
    },
    Range: FakeRange,
    Selection: FakeSelection,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    EventEmitter: class {
      private readonly emitter = new Emitter<unknown>();
      readonly event = this.emitter.event;
      fire(e: unknown): void {
        this.emitter.fire(e);
      }
      dispose(): void {
        this.emitter.dispose();
      }
    },
    TreeItem: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {},
    Uri: FakeUri,
    QuickPickItemKind: { Separator: -1 },
  };
  const deps = {
    queries: { run: () => assert.fail('no query') },
    loads: { onDidLoad: () => ({ dispose: () => undefined }) },
    releases: { onDidRelease: () => ({ dispose: () => undefined }) },
    registry: { backendFor: () => assert.fail('no backend') },
    log: quietLog,
  } as unknown as HolesDeps;
  const registration = registerHoles(api as unknown as HolesApi, deps);
  const open = (doc: FakeDocument, line: number, character: number, endLine = line, endCharacter = character): void => {
    state.editor = {
      document: doc,
      selection: new FakeSelection(new FakePosition(line, character), new FakePosition(endLine, endCharacter)),
      revealRange: (range) => revealed.push(range),
    };
  };
  const run = async (id: string): Promise<string | undefined> => {
    await commands.get(id)?.();
    const s = state.editor?.selection;
    return s === undefined ? undefined : `${s.start.line}:${s.start.character}-${s.end.line}:${s.end.character}`;
  };
  return { registration, open, run, messages, statusMessages, revealed, state };
}

suite('holes: the Next Hole and Previous Hole commands', () => {
  const text = ['module A', '', 'f : Nat -> Nat', 'f n = ?one -- ?notOne', '', 'g : Nat', 'g = plus ?two ?three'].join('\n');

  test('Next selects the next hole and reveals it; at the end it goes around, saying so in the status bar', async () => {
    const t = commandsApi();
    t.open(new FakeDocument('/w/A.idr', text), 0, 0);
    assert.strictEqual(await t.run('idris2.nextHole'), '3:6-3:10');
    assert.strictEqual(await t.run('idris2.nextHole'), '6:9-6:13');
    assert.strictEqual(await t.run('idris2.nextHole'), '6:14-6:20');
    assert.deepStrictEqual(t.statusMessages, []);
    assert.strictEqual(await t.run('idris2.nextHole'), '3:6-3:10');
    assert.deepStrictEqual(t.statusMessages, ['Idris 2: went around to the first hole']);
    assert.strictEqual(t.revealed.length, 4);
    assert.deepStrictEqual(t.messages, []);
    t.registration.dispose();
  });

  test('Previous goes backwards and around to the last hole', async () => {
    const t = commandsApi();
    t.open(new FakeDocument('/w/A.idr', text), 3, 6, 3, 10);
    assert.strictEqual(await t.run('idris2.previousHole'), '6:14-6:20');
    assert.deepStrictEqual(t.statusMessages, ['Idris 2: went around to the last hole']);
    assert.strictEqual(await t.run('idris2.previousHole'), '6:9-6:13');
    assert.strictEqual(await t.run('idris2.previousHole'), '3:6-3:10');
    t.registration.dispose();
  });

  test('unsaved text: the holes the editor shows, a hole typed since included', async () => {
    const t = commandsApi();
    const doc = new FakeDocument('/w/A.idr', text);
    doc.edit(`${text}\nh : Nat\nh = ?typedNow`);
    t.open(doc, 6, 15);
    assert.strictEqual(await t.run('idris2.nextHole'), '8:4-8:13');
    t.registration.dispose();
  });

  test('says why when it does nothing: no hole, the only hole selected, not an Idris editor, a literate style not read', async () => {
    const t = commandsApi();
    t.open(new FakeDocument('/w/A.idr', 'f : Nat\nf = 0 -- ?commented'), 0, 0);
    await t.run('idris2.nextHole');
    t.open(new FakeDocument('/w/B.idr', 'f = ?only'), 0, 4, 0, 9);
    await t.run('idris2.nextHole');
    await t.run('idris2.previousHole');
    t.open(new FakeDocument('/w/notes.txt', 'f = ?h', 'plaintext'), 0, 0);
    await t.run('idris2.nextHole');
    t.open(new FakeDocument('/w/A.idr.md', '```idris\nf = ?h\n```', 'markdown'), 0, 0);
    await t.run('idris2.previousHole');
    t.state.editor = undefined;
    await t.run('idris2.nextHole');
    assert.deepStrictEqual(t.messages, [
      'Idris 2: there is no hole (?name) in this file.',
      'Idris 2: this is the only hole in this file.',
      'Idris 2: this is the only hole in this file.',
      'Idris 2: this command needs an Idris file in the active editor.',
      'Idris 2: Next Hole and Previous Hole read Idris source files (.idr) and bird-track literate files (.lidr); this literate style is not read yet.',
      'Idris 2: this command needs an Idris file in the active editor.',
    ]);
    t.registration.dispose();
  });

  test('the cursor inside the only hole: Next selects it (not the same as doing nothing)', async () => {
    const t = commandsApi();
    t.open(new FakeDocument('/w/B.idr', 'f = ?only'), 0, 6);
    assert.strictEqual(await t.run('idris2.nextHole'), '0:4-0:9');
    assert.deepStrictEqual(t.messages, []);
    t.registration.dispose();
  });
});
