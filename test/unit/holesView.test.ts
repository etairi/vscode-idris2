// features/holes: the `HoleModel` (asked after each load, never loading; which files an answer
// replaces), the Holes view's items (file → hole → premises, the multiplicity prefix, untrusted
// text on one line, the badge), List Holes, the internal command that reveals a hole, and the
// context key `idris2.isIdrisWorkspace`. The holes are those IDE mode reports for the fixtures
// `holes/Base.idr` and `holes/Main.idr` after a load of Main (transcript `holes-loose-main`: the
// order Main.size_rhs, Base.todo, Main.todo, and Base.todo's premises " 0  n", " 0  a", " 1  x",
// "  xs"), as the backend decodes them (test/unit/holes*.test.ts).
import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { Capabilities, Hole, HolesOptions, IdrisBackend, Premise } from '../../src/backend/types';
import { Emitter } from '../../src/core/event';
import { IdrisException } from '../../src/core/errors';
import type { EditorRange } from '../../src/core/positions';
import type { LoadedFileEvent, QueryOutcome } from '../../src/features/intelligence/types';
import { declaredModule, HoleStore } from '../../src/features/holes/model';
import { registerHoles, type HolesApi } from '../../src/features/holes/register';
import { holeDescription, holeLabel, holesBadge, holeTooltip, premiseLabel, REVEAL_HOLE_COMMAND, type HoleNode, type HoleRef } from '../../src/features/holes/tree';
import type { HolesDeps } from '../../src/features/holes/types';
import { IS_IDRIS_WORKSPACE_CONTEXT_KEY, trackIsIdrisWorkspace } from '../../src/features/holes/workspaceContext';
import type { LiterateStyle } from '../../src/project/literate';
import type { Classification } from '../../src/project/types';
import { FakeToken, FakeTokenSource } from './support/editingFakes';
import { ALL_CAPABILITIES, FakeDocument, FakeRange, FakeUri, quietLog, settle } from './support/intelligence';

// -------------------------------------------------------------------------------------------
// Holes as the backend reports them
// -------------------------------------------------------------------------------------------

const BASE = '/w/holes/Base.idr';
const MAIN = '/w/holes/Main.idr';
const ROOT: Classification = { kind: 'loose', dir: '/w/holes' } as Classification;

const r = (l1: number, c1: number, l2: number, c2: number): EditorRange => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

const premise = (name: string, type: string, multiplicity?: Premise['multiplicity']): Premise => ({
  name,
  type: { text: type, spans: [] },
  ...(multiplicity === undefined ? {} : { multiplicity }),
});

function hole(qualifiedName: string, type: string, premises: Premise[], file?: string, range?: EditorRange): Hole {
  const name = qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1);
  return {
    name,
    qualifiedName,
    type: { text: type, spans: [] },
    premises,
    ...(file === undefined || range === undefined ? {} : { location: { uri: FakeUri.parse(`file://${file}`), range } as unknown as vscode.Location }),
  };
}

/** `Base.todo` of `consume x xs = ?todo` (holes/Base.idr line 8, 0-based 7). */
const baseTodo = hole('Base.todo', 'Vect (S n) a', [premise('n', 'Nat', 0), premise('a', 'Type', 0), premise('x', 'a', 1), premise('xs', 'Vect n a', 'unrestricted')], BASE, r(7, 15, 7, 20));
/** `Main.todo` and `Main.size_rhs` (holes/Main.idr lines 6 and 9). */
const mainTodo = hole('Main.todo', 'Nat', [premise('ns', 'List Nat', 'unrestricted')], MAIN, r(5, 11, 5, 16));
const mainSize = hole('Main.size_rhs', 'Nat', [], MAIN, r(8, 7, 8, 16));

// -------------------------------------------------------------------------------------------
// Fakes
// -------------------------------------------------------------------------------------------

/** A backend whose `holes` answers what the test queues, recording each call. */
class HolesBackend {
  readonly kind = 'ideMode' as const;
  caps: Capabilities = { ...ALL_CAPABILITIES, holes: true, holeLocations: true };
  readonly asked: string[] = [];
  /** Whether each call asked for the kept holes too (`HolesOptions.kept`). */
  readonly kept: boolean[] = [];
  answers: (() => Promise<Hole[]>)[] = [];
  holes(doc: vscode.TextDocument, options?: HolesOptions): Promise<Hole[]> {
    this.asked.push(doc.fileName);
    this.kept.push(options?.kept === true);
    const next = this.answers.shift();
    return next === undefined ? Promise.reject(new Error('no answer queued')) : next();
  }
}

function storeWith(open: FakeDocument[]) {
  const loads = new Emitter<LoadedFileEvent>();
  const releases = new Emitter<Classification>();
  const backend = new HolesBackend();
  const logged: string[] = [];
  const warned: string[] = [];
  const log = { ...quietLog, warn: (m: string) => logged.push(`warn ${m}`), error: (m: string) => logged.push(m) };
  const store = new HoleStore({
    loads: { onDidLoad: loads.event },
    releases: { onDidRelease: releases.event },
    registry: { backendFor: () => backend as unknown as IdrisBackend },
    openDocument: (fileName) => open.find((d) => d.fileName === fileName) as unknown as vscode.TextDocument | undefined,
    log,
    warn: (text) => warned.push(text),
  });
  let changes = 0;
  store.onDidChange(() => changes++);
  const load = (file: string, root = ROOT, failed = false): void => loads.fire({ root, file, rebuilt: true, ...(failed ? { failed } : {}) });
  return { store, backend, load, release: (root: Classification) => releases.fire(root), logged, warned, changes: () => changes };
}

const names = (holes: readonly Hole[]): string[] => holes.map((h) => h.qualifiedName);

suite('holes: the model, refreshed after each load', () => {
  test('a load of an open file asks for its holes and files them by location: the loaded module\'s and its imports\'', async () => {
    const t = storeWith([new FakeDocument(MAIN, ''), new FakeDocument(BASE, '')]);
    t.backend.answers.push(() => Promise.resolve([mainSize, baseTodo, mainTodo]));
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.backend.asked, [MAIN]);
    assert.deepStrictEqual(t.backend.kept, [true], 'also the holes kept from its load when another file was loaded since');
    assert.deepStrictEqual(t.store.files(), [BASE, MAIN]);
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.todo', 'Main.size_rhs']);
    assert.deepStrictEqual(names(t.store.holesIn(BASE)), ['Base.todo']);
    assert.strictEqual(t.changes(), 1);
  });

  test('an answer replaces the loaded file\'s holes and those of every file it locates one in, and drops those an earlier answer of that file listed and it does not; other files keep theirs', async () => {
    const other = '/w/holes/Other.idr';
    const otherHole = hole('Other.h', 'Nat', [], other, r(2, 4, 2, 6));
    const t = storeWith([new FakeDocument(MAIN, ''), new FakeDocument(BASE, ''), new FakeDocument(other, '')]);
    t.backend.answers.push(() => Promise.resolve([mainSize, mainTodo, baseTodo]), () => Promise.resolve([otherHole]), () => Promise.resolve([mainSize]));
    t.load(MAIN);
    await settle();
    t.load(other);
    await settle();
    t.load(MAIN);
    await settle();
    // Base's last hole went away (edited outside VS Code, or saved and only Main checked): Main's
    // answer, which listed it before, no longer does [live, UX review of M4's eighth round].
    assert.deepStrictEqual(t.store.files(), [MAIN, other]);
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.size_rhs']);
    assert.deepStrictEqual(names(t.store.holesIn(BASE)), []);
  });

  test('a file or module that only other loaded files\' answers listed keeps its holes; one listed by the loaded file before goes, also when another file listed it too', async () => {
    const other = '/w/holes/Other.idr';
    const packaged = hole('Pkg.Lib.h', 'Nat', []);
    const t = storeWith([new FakeDocument(MAIN, ''), new FakeDocument(other, '')]);
    t.backend.answers.push(
      () => Promise.resolve([baseTodo, packaged]), // Other imports Base and the package's module
      () => Promise.resolve([mainSize]), // Main, which has not listed them
      () => Promise.resolve([mainSize, baseTodo, packaged]), // Main lists them too
      () => Promise.resolve([mainSize]), // and then no more
    );
    t.load(other);
    await settle();
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.store.files(), [BASE, MAIN]);
    assert.deepStrictEqual(t.store.modules(), ['Pkg.Lib']);
    t.load(MAIN);
    await settle();
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.store.files(), [MAIN]);
    assert.deepStrictEqual(t.store.modules(), []);
  });

  test('two importers: a file\'s answer without an import drops its holes only when that file reported them last (ninth review of M4)', async () => {
    const a = '/w/holes/A.idr';
    const b = '/w/holes/B.idr';
    const t = storeWith([new FakeDocument(a, ''), new FakeDocument(b, '')]);
    t.backend.answers.push(
      () => Promise.resolve([baseTodo]), // A imports Base
      () => Promise.resolve([baseTodo]), // B imports Base: B reported it last
      () => Promise.resolve([]), // A no longer imports Base
      () => Promise.resolve([]), // B no longer does either
    );
    for (const file of [a, b, a]) {
      t.load(file);
      await settle();
    }
    assert.deepStrictEqual(t.store.files(), [BASE], 'B, the last check that reported Base\'s holes, was not checked again');
    t.load(b);
    await settle();
    assert.deepStrictEqual(t.store.files(), []);
  });

  test('a load that returned an error: its answer replaces only the groups it lists (ninth review of M4: no holes after a parse error, only an import\'s after an error there)', async () => {
    const t = storeWith([new FakeDocument(MAIN, MAIN_TEXT), new FakeDocument(BASE, '')]);
    const baseBad = hole('Base.bad', 'Nat', [], BASE, r(9, 6, 9, 10));
    t.backend.answers.push(
      () => Promise.resolve([baseTodo]), // Base checked
      () => Promise.resolve([mainSize, mainTodo, baseTodo]), // Main checked
      () => Promise.resolve([]), // Main saved with a parse error
      () => Promise.resolve([baseTodo, baseBad]), // Main checked while Base has a type error
      () => Promise.resolve([mainSize, baseTodo]), // the errors fixed, Main's ?todo filled
    );
    t.load(BASE);
    await settle();
    t.load(MAIN);
    await settle();
    t.load(MAIN, ROOT, true);
    await settle();
    assert.deepStrictEqual(t.store.files(), [BASE, MAIN]);
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.todo', 'Main.size_rhs']);
    assert.deepStrictEqual(names(t.store.holesIn(BASE)), ['Base.todo']);
    t.load(MAIN, ROOT, true);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.todo', 'Main.size_rhs'], 'the loaded file\'s own holes stay');
    assert.deepStrictEqual(names(t.store.holesIn(BASE)), ['Base.todo', 'Base.bad']);
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.size_rhs']);
    assert.deepStrictEqual(names(t.store.holesIn(BASE)), ['Base.todo']);
  });

  test('a failed load whose answer lists none of the loaded file\'s holes drops those whose ?name its text no longer has (final review of M4: a hole filled while a coverage error remains)', async () => {
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    const t = storeWith([main]);
    // A coverage or type error in the file: the compiler lists its holes [live]; then none, as after a parse error.
    t.backend.answers.push(
      () => Promise.resolve([mainSize, mainTodo]),
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );
    t.load(MAIN, ROOT, true);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.todo', 'Main.size_rhs']);
    main.edit(MAIN_TEXT.replace('?todo', '0'));
    t.load(MAIN, ROOT, true);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.size_rhs']);
    main.edit(MAIN_TEXT.replace('?todo', '0').replace('?size_rhs', '1'));
    t.load(MAIN, ROOT, true);
    await settle();
    assert.deepStrictEqual(t.store.files(), []);
    // Checked cleanly, then saved with ?todo filled and a type error: the answer lists the file's holes, which replace them.
    const moved = hole('Main.size_rhs', 'Nat', [], MAIN, r(9, 7, 9, 16));
    t.backend.answers.push(
      () => Promise.resolve([mainTodo, mainSize]),
      () => Promise.resolve([moved]),
    );
    main.edit(MAIN_TEXT);
    t.load(MAIN);
    await settle();
    main.edit(`${MAIN_TEXT.replace('?todo', '0')}\nbad : Nat\nbad = "x"\n`);
    t.load(MAIN, ROOT, true);
    await settle();
    assert.deepStrictEqual(t.store.holesIn(MAIN), [moved]);
  });

  test('a released root\'s files leave the model (their holes and those of their imports), another root\'s stay; an answer that comes after the release is dropped', async () => {
    const otherRoot = { kind: 'loose', dir: '/w/other' } as Classification;
    const other = '/w/other/O.idr';
    const t = storeWith([new FakeDocument(MAIN, ''), new FakeDocument(other, '')]);
    let late: (holes: Hole[]) => void = () => undefined;
    t.backend.answers.push(
      () => Promise.resolve([mainSize, baseTodo]),
      () => Promise.resolve([hole('O.h', 'Nat', [], other, r(2, 4, 2, 6))]),
      () => new Promise<Hole[]>((resolve) => (late = resolve)),
    );
    t.load(MAIN);
    t.load(other, otherRoot);
    await settle();
    assert.deepStrictEqual(t.store.files(), [BASE, MAIN, other]);
    t.load(MAIN);
    await settle();
    const changes = t.changes();
    t.release(ROOT);
    assert.deepStrictEqual(t.store.files(), [other]);
    assert.strictEqual(t.changes(), changes + 1);
    late([mainSize]);
    await settle();
    assert.deepStrictEqual(t.store.files(), [other]);
    t.release(ROOT);
    assert.strictEqual(t.changes(), changes + 1, 'nothing left to drop: no change');
  });

  test('no hole left in the loaded file: it leaves the model', async () => {
    const t = storeWith([new FakeDocument(MAIN, '')]);
    t.backend.answers.push(() => Promise.resolve([mainSize]), () => Promise.resolve([]));
    t.load(MAIN);
    await settle();
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.store.files(), []);
    assert.deepStrictEqual(t.store.holesIn(MAIN), []);
  });

  test('a hole without a location is filed under the loaded file when its text has the ?name; a repeated qualified name is kept once', async () => {
    const t = storeWith([new FakeDocument(MAIN, 'far = ?far\n')]);
    const unlocated = hole('Main.far', 'Nat', []);
    t.backend.answers.push(() => Promise.resolve([unlocated, mainTodo, mainTodo]));
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.todo', 'Main.far']);
    assert.deepStrictEqual(t.store.modules(), []);
  });

  test('a hole without a location and not in the loaded text is listed under its module, once across the loads that report it', async () => {
    // `:name-at dep_hole` answers the file `(File-Not-Found)` for a package built without its sources
    // [live, idris2 0.8.0, UX review of M4, rerun by the fixer]: every file importing it reports the hole.
    const a = '/w/app/A.idr';
    const b = '/w/app/B.idr';
    const depHole = hole('Dep.dep_hole', 'Nat', [premise('n', 'Nat')]);
    const t = storeWith([new FakeDocument(a, 'a = todo 1\n'), new FakeDocument(b, 'b = todo 2\n')]);
    t.backend.answers.push(() => Promise.resolve([depHole]), () => Promise.resolve([depHole, hole('Dep.Inner.other', 'Nat', [])]));
    t.load(a);
    await settle();
    t.load(b);
    await settle();
    assert.deepStrictEqual(t.store.files(), []);
    assert.deepStrictEqual(t.store.modules(), ['Dep', 'Dep.Inner']);
    assert.deepStrictEqual(names(t.store.holesOfModule('Dep')), ['Dep.dep_hole']);
    assert.deepStrictEqual(names(t.store.holesOfModule('Dep.Inner')), ['Dep.Inner.other']);
    t.release(ROOT);
    assert.deepStrictEqual(t.store.modules(), []);
  });

  test('never loads and never asks without cause: not for a file with no open document, not a backend without holes; NotLoaded leaves the model as it was', async () => {
    const t = storeWith([new FakeDocument(MAIN, '')]);
    t.load(BASE);
    t.backend.caps = { ...t.backend.caps, holes: false };
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.backend.asked, []);
    t.backend.caps = { ...t.backend.caps, holes: true };
    t.backend.answers.push(() => Promise.resolve([mainTodo]), () => Promise.reject(new IdrisException({ kind: 'NotLoaded', message: 'not loaded', file: MAIN })));
    t.load(MAIN);
    await settle();
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.todo']);
    assert.deepStrictEqual(t.logged, []);
    // An unexpected failure is logged as an error, and changes nothing either.
    t.backend.answers.push(() => Promise.reject(new TypeError('bug')));
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.todo']);
    assert.strictEqual(t.logged.length, 1);
  });

  test('the answer to an earlier load of a file that arrives after a later load\'s asking is dropped', async () => {
    const t = storeWith([new FakeDocument(MAIN, '')]);
    let answerFirst: (holes: Hole[]) => void = () => undefined;
    t.backend.answers.push(
      () => new Promise((resolve) => (answerFirst = resolve)),
      () => Promise.resolve([mainSize]),
    );
    t.load(MAIN);
    t.load(MAIN);
    await settle();
    answerFirst([mainTodo]);
    await settle();
    assert.deepStrictEqual(names(t.store.holesIn(MAIN)), ['Main.size_rhs']);
  });

  test('forget: the files of a deleted or renamed path, a folder\'s included, leave the model', async () => {
    const t = storeWith([new FakeDocument(MAIN, '')]);
    t.backend.answers.push(() => Promise.resolve([mainTodo, baseTodo]));
    t.load(MAIN);
    await settle();
    t.store.forget(['/w/hol']);
    assert.deepStrictEqual(t.store.files(), [BASE, MAIN]);
    t.store.forget([BASE]);
    assert.deepStrictEqual(t.store.files(), [MAIN]);
    t.store.forget(['/w']);
    assert.deepStrictEqual(t.store.files(), []);
  });

  test('forget while the holes of a load are still asked for: their late answer is dropped (acceptance review of M4)', async () => {
    const t = storeWith([new FakeDocument(MAIN, '')]);
    let answer: (holes: Hole[]) => void = () => undefined;
    t.backend.answers.push(() => new Promise((resolve) => (answer = resolve)));
    t.load(MAIN);
    await settle();
    t.store.forget([MAIN]);
    answer([mainTodo, baseTodo]);
    await settle();
    assert.deepStrictEqual(t.store.files(), []);
  });

  test('holes that took longer than their limit (the compiler was restarted) are a warning in the log, not an error (UX review of M4), and a notification once until a listing answers (eighth round)', async () => {
    const t = storeWith([new FakeDocument(MAIN, '')]);
    const timeout = () => Promise.reject(new IdrisException({ kind: 'RequestTimeout', message: ':metavariables did not answer within 1 min' }));
    t.backend.answers.push(timeout, timeout, () => Promise.resolve([mainSize]), timeout);
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.logged, [`warn Holes: listing the holes of ${MAIN} took too long: :metavariables did not answer within 1 min`]);
    const warning =
      'Idris 2: listing the holes of Main.idr took longer than idris2.ideMode.longActionTimeout, so the compiler was restarted. The Holes view asks for them ' +
      'again once the file changes. List Holes asks at once, which can take as long; it offers Cancel.';
    assert.deepStrictEqual(t.warned, [warning]);
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.warned, [warning], 'once');
    t.load(MAIN);
    await settle();
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.warned, [warning, warning], 'again after a listing that answered');
  });

  test('disposed: loads are no longer followed, and an answer that comes after is dropped', async () => {
    const t = storeWith([new FakeDocument(MAIN, '')]);
    let answer: (holes: Hole[]) => void = () => undefined;
    t.backend.answers.push(() => new Promise((resolve) => (answer = resolve)));
    t.load(MAIN);
    t.store.dispose();
    answer([mainTodo]);
    t.load(MAIN);
    await settle();
    assert.deepStrictEqual(t.store.files(), []);
    assert.deepStrictEqual(t.backend.asked, [MAIN]);
  });
});

suite('holes: what the view\'s items show', () => {
  test('premises: `0 a : Type`, `1 x : a`, `xs : Vect n a` — the multiplicity only for 0 and 1', () => {
    assert.deepStrictEqual(baseTodo.premises.map(premiseLabel), ['0 n : Nat', '0 a : Type', '1 x : a', 'xs : Vect n a']);
    assert.strictEqual(premiseLabel(premise('y', 'Nat')), 'y : Nat');
  });

  test('a hole: `?name`, its goal type as the description, a tooltip in the REPL\'s layout', () => {
    assert.strictEqual(holeLabel(baseTodo), '?todo');
    assert.strictEqual(holeDescription(baseTodo), 'Vect (S n) a');
    assert.strictEqual(holeTooltip(baseTodo), ['0 n : Nat', '0 a : Type', '1 x : a', 'xs : Vect n a', '-'.repeat(30), 'todo : Vect (S n) a'].join('\n'));
  });

  test('compiler text on one line, its control and format characters written out, cut when very long', () => {
    const evil = hole('M.h', 'Vect\n    n‮a', [premise('x​', 'List\n  Nat')]);
    assert.strictEqual(holeDescription(evil), 'Vect n\\u{202E}a');
    assert.strictEqual(premiseLabel(evil.premises[0]), 'x\\u{200B} : List Nat');
    assert.strictEqual(holeTooltip(evil), 'x\\u{200B} : List\n  Nat\n------------------------------\nh : Vect\n    n\\u{202E}a');
    assert.strictEqual(holeDescription(hole('M.h', 'x'.repeat(2000), [])).length, 500);
    // A tooltip is cut at 10,000 UTF-16 code units, not inside a surrogate pair.
    const many = hole('M.h', 'Nat', Array.from({ length: 300 }, (_, i) => premise(`x${i}`, 'Vect n a -> '.repeat(30))));
    assert.strictEqual(holeTooltip(many).length, 10_000);
    assert.ok(holeTooltip(many).endsWith('…'));
    assert.strictEqual(holeTooltip(hole('M.h', `${'x'.repeat(9_963)}\u{1D54F}y`, [])).slice(-2), 'x…');
    // A hole's name may hold such characters too (holes.ts keeps what the compiler registered).
    assert.strictEqual(holeLabel(hole('Zw.a\u202Eb', 'Nat', [])), '?a\\u{202E}b');
    assert.strictEqual(holeLabel(hole(`M.${'h'.repeat(600)}`, 'Nat', [])).length, 500);
  });

  test('a type that quotes a string of 200,000 spaces is labelled in linear time (security review of M4: seconds per label)', () => {
    const spaces = `"a${' '.repeat(200_000)}b"`;
    const crafted = hole('Miss.h', `${spaces} = ${spaces}`, [premise('p', spaces)]);
    const started = process.hrtime.bigint();
    assert.strictEqual(holeDescription(crafted).length, 500);
    assert.strictEqual(premiseLabel(crafted.premises[0]).length, 500);
    assert.ok(process.hrtime.bigint() - started < 200_000_000n, 'more than 200 ms');
  });

  test('the badge counts the holes; none without holes', () => {
    assert.deepStrictEqual(holesBadge(3), { value: 3, tooltip: '3 holes' });
    assert.deepStrictEqual(holesBadge(1), { value: 1, tooltip: '1 hole' });
    assert.strictEqual(holesBadge(0), undefined);
  });
});

// -------------------------------------------------------------------------------------------
// registerHoles against a fake of the VS Code API
// -------------------------------------------------------------------------------------------

class FakeTreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  resourceUri?: FakeUri;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments: unknown[] };
  constructor(
    readonly label: string,
    readonly collapsibleState: number,
  ) {}
}

class FakeThemeIcon {
  static readonly File = new FakeThemeIcon('file');
  constructor(readonly id: string) {}
}

class FakeEventEmitter<T> {
  private readonly emitter = new Emitter<T>();
  readonly event = this.emitter.event;
  fire(e: T): void {
    this.emitter.fire(e);
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

function holesApi(options: { queries?: (doc: vscode.TextDocument) => Promise<QueryOutcome<Hole[]>>; cancelOfferMs?: number } = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const messages: string[] = [];
  const quickPicks: { items: { label: string; description?: string; kind?: number; ref?: HoleRef }[]; options: Record<string, unknown> }[] = [];
  const shown: { doc: FakeDocument; selection: FakeRange }[] = [];
  const opened: string[] = [];
  const events = {
    change: new Emitter<{ document: FakeDocument }>(),
    save: new Emitter<FakeDocument>(),
    open: new Emitter<FakeDocument>(),
    close: new Emitter<FakeDocument>(),
    deleted: new Emitter<{ files: FakeUri[] }>(),
    renamed: new Emitter<{ files: { oldUri: FakeUri; newUri: FakeUri }[] }>(),
    /** The file watcher's deletions (on disk). */
    deletedOnDisk: new Emitter<FakeUri>(),
  };
  const watchers: { glob: string; ignores: boolean[] }[] = [];
  /** The window progress shown (`location title`), and how many are open. */
  const progress: string[] = [];
  /** The cancellable notifications shown (List Holes' Cancel offer). */
  const notifications: { title: string; cancel(): void }[] = [];
  let inProgress = 0;
  const state = {
    editor: undefined as { document: FakeDocument } | undefined,
    textDocuments: [] as FakeDocument[],
    onDisk: new Map<string, string>(),
    pick: undefined as ((items: { label: string; ref?: HoleRef }[]) => unknown) | undefined,
  };
  const view = { badge: undefined as vscode.ViewBadge | undefined, dispose: () => undefined, options: undefined as unknown };
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
      showQuickPick: (items: { label: string; ref?: HoleRef }[], pickOptions: Record<string, unknown>) => {
        quickPicks.push({ items, options: pickOptions });
        return Promise.resolve(state.pick?.(items));
      },
      showTextDocument: (doc: FakeDocument, showOptions: { selection: FakeRange }) => {
        shown.push({ doc, selection: showOptions.selection });
        return Promise.resolve();
      },
      createTreeView: (_id: string, viewOptions: unknown) => {
        view.options = viewOptions;
        return view;
      },
      setStatusBarMessage: () => ({ dispose: () => undefined }),
      withProgress: async <T>(progressOptions: { location: number; title: string }, run: (progress: unknown, token: FakeToken) => Promise<T>): Promise<T> => {
        progress.push(`${progressOptions.location} ${progressOptions.title}`);
        const token = new FakeToken();
        if (progressOptions.location === 15) {
          notifications.push({ title: progressOptions.title, cancel: () => token.cancel() });
          return run(undefined, token);
        }
        inProgress++;
        try {
          return await run(undefined, token);
        } finally {
          inProgress--;
        }
      },
    },
    workspace: {
      get textDocuments() {
        return state.textDocuments;
      },
      openTextDocument: (uri: FakeUri) => {
        opened.push(uri.fsPath);
        const text = state.onDisk.get(uri.fsPath);
        if (text === undefined) {
          return Promise.reject(new Error(`ENOENT ${uri.fsPath}`));
        }
        const doc = new FakeDocument(uri.fsPath, text);
        state.textDocuments.push(doc);
        return Promise.resolve(doc);
      },
      asRelativePath: (p: string) => (p.startsWith('/w/') ? p.slice(3) : p),
      onDidChangeTextDocument: events.change.event,
      onDidSaveTextDocument: events.save.event,
      onDidOpenTextDocument: events.open.event,
      onDidCloseTextDocument: events.close.event,
      onDidDeleteFiles: events.deleted.event,
      onDidRenameFiles: events.renamed.event,
      createFileSystemWatcher: (glob: string, ...ignores: boolean[]) => {
        watchers.push({ glob, ignores });
        return { onDidDelete: events.deletedOnDisk.event, dispose: () => undefined };
      },
    },
    Range: FakeRange,
    Selection: FakeRange,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    QuickPickItemKind: { Separator: -1 },
    ProgressLocation: { Window: 10, Notification: 15 },
    CancellationTokenSource: FakeTokenSource,
    TreeItem: FakeTreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: FakeThemeIcon,
    Uri: { file: (p: string) => new FakeUri('file', p, '') },
    EventEmitter: FakeEventEmitter,
  };
  const loads = new Emitter<LoadedFileEvent>();
  const backend = new HolesBackend();
  const queried: string[] = [];
  const deps = {
    queries: {
      run: (doc: vscode.TextDocument, mode: string, query: (b: IdrisBackend) => Promise<Hole[]>) => {
        queried.push(`${mode} ${doc.fileName}${inProgress > 0 ? ' (in progress)' : ''}`);
        return options.queries?.(doc) ?? query(backend as unknown as IdrisBackend).then((value) => ({ kind: 'answer', value }));
      },
    },
    loads: { onDidLoad: loads.event },
    releases: { onDidRelease: () => ({ dispose: () => undefined }) },
    registry: { backendFor: () => backend },
    log: quietLog,
  } as unknown as HolesDeps;
  const holes = registerHoles(api as unknown as HolesApi, deps, options.cancelOfferMs === undefined ? {} : { cancelOfferMs: options.cancelOfferMs });
  const load = async (file: string, answer: Hole[], failed = false): Promise<void> => {
    backend.answers.push(() => Promise.resolve(answer));
    loads.fire({ root: ROOT, file, rebuilt: true, ...(failed ? { failed } : {}) });
    await settle();
  };
  const run = (id: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(commands.get(id)?.(...args));
  /** The tree as text: one line per item, indented by depth. */
  const tree = (): string[] => {
    const lines: string[] = [];
    const walk = (node: HoleNode | undefined, depth: number): void => {
      for (const child of holes.tree.getChildren(node)) {
        const item = holes.tree.getTreeItem(child) as unknown as FakeTreeItem;
        lines.push(`${'  '.repeat(depth)}${item.label}${item.description ? ` — ${item.description}` : ''}`);
        walk(child, depth + 1);
      }
    };
    walk(undefined, 0);
    return lines;
  };
  return { api, holes, backend, commands, messages, quickPicks, shown, opened, events, watchers, state, view, load, run, tree, queried, progress, notifications };
}

const BASE_TEXT = 'module Base\n\nimport Data.Vect\n\n-- A hole named like one in Main (both are `todo`), with a premise of each multiplicity.\nexport\nconsume : (1 x : a) -> Vect n a -> Vect (S n) a\nconsume x xs = ?todo\n';
const MAIN_TEXT = 'module Main\n\nimport Base\n\ncount : List Nat -> Nat\ncount ns = ?todo\n\nsize : Nat\nsize = ?size_rhs\n';

suite('holes: the Holes view', () => {
  test('file → hole → premises, files by path, holes in document order; the badge counts them', async () => {
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT));
    await t.load(MAIN, [mainSize, baseTodo, mainTodo]);
    assert.deepStrictEqual(t.tree(), [
      'Base.idr — holes',
      '  ?todo — Vect (S n) a',
      '    0 n : Nat',
      '    0 a : Type',
      '    1 x : a',
      '    xs : Vect n a',
      'Main.idr — holes',
      '  ?todo — Nat',
      '    ns : List Nat',
      '  ?size_rhs — Nat',
    ]);
    assert.deepStrictEqual(t.view.badge, { value: 3, tooltip: '3 holes' });
    assert.deepStrictEqual(t.view.options, { treeDataProvider: t.holes.tree, showCollapseAll: true });
    t.holes.dispose();
  });

  test('a module\'s holes without a source location: one group, after the files, each hole once in it and in the badge; no Go to Hole', async () => {
    const t = holesApi();
    const other = '/w/holes/Other.idr';
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT), new FakeDocument(other, 'module Other\n\nimport Dep\n'));
    const depHole = hole('Dep.dep_hole', 'Nat', [premise('n', 'Nat')]);
    await t.load(MAIN, [mainTodo, depHole]);
    await t.load(other, [depHole]);
    assert.deepStrictEqual(t.tree(), ['Main.idr — holes', '  ?todo — Nat', '    ns : List Nat', 'Dep — no source location', '  ?dep_hole — Nat', '    n : Nat']);
    assert.deepStrictEqual(t.view.badge, { value: 2, tooltip: '2 holes' });
    const [, dep] = t.holes.tree.getChildren(undefined);
    const [depNode] = t.holes.tree.getChildren(dep);
    const depItem = t.holes.tree.getTreeItem(depNode);
    assert.strictEqual(depItem.command, undefined);
    assert.notStrictEqual(depItem.id, t.holes.tree.getTreeItem(t.holes.tree.getChildren(t.holes.tree.getChildren(undefined)[0])[0]).id);
    assert.strictEqual(t.holes.tree.resolveTreeItem(depItem, depNode).tooltip, `Dep.dep_hole\n${holeTooltip(depHole)}`);
    t.holes.dispose();
  });

  test('items: ids unique per file and hole, a hole without premises cannot expand, and clicking a hole runs the reveal command with where it was', async () => {
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT));
    await t.load(MAIN, [mainSize, baseTodo, mainTodo]);
    const [base, main] = t.holes.tree.getChildren(undefined);
    const baseItem = t.holes.tree.getTreeItem(base) as unknown as FakeTreeItem;
    assert.strictEqual(baseItem.id, BASE);
    assert.strictEqual(baseItem.collapsibleState, 2);
    assert.strictEqual(baseItem.resourceUri?.fsPath, BASE);
    const [todo, size] = t.holes.tree.getChildren(main).map((n) => t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem);
    assert.strictEqual(todo.id, `${MAIN}\nMain.todo`);
    assert.strictEqual(todo.collapsibleState, 1);
    assert.strictEqual(size.collapsibleState, 0);
    assert.deepStrictEqual(todo.command, { command: REVEAL_HOLE_COMMAND, title: 'Go to Hole', arguments: [{ file: MAIN, name: 'todo', range: r(5, 11, 5, 16) }] });
    const baseTodoItem = t.holes.tree.getTreeItem(t.holes.tree.getChildren(base)[0]) as unknown as FakeTreeItem;
    const premiseIds = t.holes.tree.getChildren(t.holes.tree.getChildren(base)[0]).map((n) => (t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem).id);
    assert.notStrictEqual(baseTodoItem.id, todo.id);
    assert.strictEqual(new Set(premiseIds).size, 4);
    t.holes.dispose();
  });

  test('two holes of one name in one file (namespaces): each item carries its index among them, so that a click finds the right one after an edit (ninth review of M4)', async () => {
    const t = holesApi();
    const ns = '/w/holes/NS.idr';
    const text = 'module NS\nnamespace A\n  export\n  x : Nat\n  x = ?todo\n\nnamespace B\n  export\n  y : Nat\n  y = ?todo\n';
    t.state.textDocuments.push(new FakeDocument(ns, text));
    await t.load(ns, [hole('NS.B.todo', 'Nat', [], ns, r(9, 6, 9, 11)), hole('NS.A.todo', 'Nat', [], ns, r(4, 6, 4, 11))]);
    const items = t.holes.tree.getChildren(t.holes.tree.getChildren(undefined)[0]).map((n) => t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem);
    assert.deepStrictEqual(
      items.map((i) => i.command?.arguments[0]),
      [
        { file: ns, name: 'todo', range: r(4, 6, 4, 11), ordinal: { index: 0, count: 2 } },
        { file: ns, name: 'todo', range: r(9, 6, 9, 11), ordinal: { index: 1, count: 2 } },
      ],
    );
    // Revealed after three lines were inserted above (unsaved): B's own ?todo, not A's.
    const doc = t.state.textDocuments[0];
    doc.edit(`-- 1\n-- 2\n-- 3\n${text}`);
    await t.run(REVEAL_HOLE_COMMAND, items[1].command?.arguments[0]);
    assert.deepStrictEqual(t.shown.map((x) => x.selection), [new FakeRange(12, 6, 12, 11)]);
    // An ordinal that is no index of its count names no hole.
    await t.run(REVEAL_HOLE_COMMAND, { file: ns, name: 'todo', range: r(9, 6, 9, 11), ordinal: { index: 2, count: 2 } });
    assert.deepStrictEqual(t.messages, ['Idris 2: Go to Hole needs a hole of an Idris file.']);
    t.holes.dispose();
  });

  test('two holes of one name and a third ?name the compiler does not list (a failing block): found at their places while the file is unchanged; edited, the message says why (eleventh review of M4)', async () => {
    const t = holesApi();
    const fl = '/w/holes/Fl.idr';
    const text = 'module Fl\nnamespace A\n  export\n  x : Nat\n  x = ?todo\nnamespace B\n  export\n  y : Nat\n  y = ?todo\nfailing\n  z : Nat\n  z = "s" + ?todo\n';
    const doc = new FakeDocument(fl, text);
    t.state.textDocuments.push(doc);
    await t.load(fl, [hole('Fl.A.todo', 'Nat', [], fl, r(4, 6, 4, 11)), hole('Fl.B.todo', 'Nat', [], fl, r(8, 6, 8, 11))]);
    const items = t.holes.tree.getChildren(t.holes.tree.getChildren(undefined)[0]).map((n) => t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem);
    for (const item of items) {
      await t.run(REVEAL_HOLE_COMMAND, item.command?.arguments[0]);
    }
    assert.deepStrictEqual(t.shown.map((x) => x.selection), [new FakeRange(4, 6, 4, 11), new FakeRange(8, 6, 8, 11)]);
    assert.deepStrictEqual(t.messages, []);
    // A line inserted above (unsaved): three ?todo where the compiler listed two, so B's is not known.
    doc.edit(`-- 1\n${text}`);
    await t.run(REVEAL_HOLE_COMMAND, items[1].command?.arguments[0]);
    assert.deepStrictEqual(t.messages, ['Idris 2: Fl.idr now has 3 ?todo and the compiler listed 2, so which one this is is not known: save the file to check it again.']);
    // All gone: the plain message.
    doc.edit(text.replaceAll('?todo', '0'));
    await t.run(REVEAL_HOLE_COMMAND, items[1].command?.arguments[0]);
    assert.strictEqual(t.messages[1], 'Idris 2: ?todo is not in Fl.idr any more: the file changed since the compiler read it.');
    t.holes.dispose();
  });

  test('a saved file is not always the text the ranges were read from: lines moved with no load since, or a failed load that kept the holes, or a load of a file with unsaved changes (twelfth review of M4)', async () => {
    const fl = '/w/holes/Fl.idr';
    const text = 'module Fl\nnamespace A\n  export\n  x : Nat\n  x = ?todo\nnamespace B\n  export\n  y : Nat\n  y = ?todo\nfailing\n  z : Nat\n  z = "s" + ?todo\n';
    const at = (shift: number): Hole[] => [hole('Fl.A.todo', 'Nat', [], fl, r(4 + shift, 6, 4 + shift, 11)), hole('Fl.B.todo', 'Nat', [], fl, r(8 + shift, 6, 8 + shift, 11))];
    // Four lines inserted at the top: B's recorded line 8 now holds A's ?todo.
    const moved = `-- 1\n-- 2\n-- 3\n-- 4\n${text}`;
    const notKnown = (how: string): string => `Idris 2: Fl.idr now has 3 ?todo and the compiler listed 2, so which one this is is not known: ${how}.`;
    const clickB = async (t: ReturnType<typeof holesApi>): Promise<void> => {
      const items = t.holes.tree.getChildren(t.holes.tree.getChildren(undefined)[0]).map((n) => t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem);
      await t.run(REVEAL_HOLE_COMMAND, items[1].command?.arguments[0]);
    };

    // (1) Saved with no load since (idris2.checking.trigger = manual).
    const t = holesApi();
    const doc = new FakeDocument(fl, text);
    t.state.textDocuments.push(doc);
    await t.load(fl, at(0));
    doc.edit(moved, true);
    await clickB(t);
    assert.deepStrictEqual(t.messages, [notKnown('check the file again (it must load without errors)')]);
    // (2) A failed load of the saved text (a parse error): the compiler lists none of its holes, and the model keeps them with the earlier ranges.
    doc.edit(`${moved}w : Nat\nw = (\n`, true);
    await t.load(fl, [], true);
    await clickB(t);
    assert.deepStrictEqual(t.messages.slice(1), [notKnown('check the file again (it must load without errors)')]);
    // (3) A load that reads the text: its ranges are trusted again.
    doc.edit(moved, true);
    await t.load(fl, at(4));
    await clickB(t);
    assert.deepStrictEqual(t.shown.map((x) => x.selection), [new FakeRange(12, 6, 12, 11)]);
    assert.strictEqual(t.messages.length, 2);
    t.holes.dispose();

    // (4) A load answered while the document had unsaved changes: they are not the text the load read.
    const u = holesApi();
    const dirty = new FakeDocument(fl, text);
    u.state.textDocuments.push(dirty);
    dirty.edit(moved);
    await u.load(fl, at(0));
    await clickB(u);
    assert.deepStrictEqual([u.messages, u.shown], [[notKnown('save the file to check it again')], []]);
    u.holes.dispose();
  });

  test('the holes of an imported file: their ranges are trusted while its open document, without unsaved changes when the answer came, still shows that text (twelfth review of M4)', async () => {
    const fl = '/w/holes/Fl.idr';
    const text = 'module Fl\nnamespace A\n  export\n  x : Nat\n  x = ?todo\nnamespace B\n  export\n  y : Nat\n  y = ?todo\nfailing\n  z : Nat\n  z = "s" + ?todo\n';
    const answer = [mainTodo, hole('Fl.A.todo', 'Nat', [], fl, r(4, 6, 4, 11)), hole('Fl.B.todo', 'Nat', [], fl, r(8, 6, 8, 11))];
    const clickB = async (t: ReturnType<typeof holesApi>): Promise<void> => {
      const flItem = t.holes.tree.getChildren(undefined).find((n) => (t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem).label === 'Fl.idr');
      assert.ok(flItem);
      const items = t.holes.tree.getChildren(flItem).map((n) => t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem);
      await t.run(REVEAL_HOLE_COMMAND, items[1].command?.arguments[0]);
    };
    // Open and saved: B's own ?todo, although the file has a third.
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT), new FakeDocument(fl, text));
    await t.load(MAIN, answer);
    await clickB(t);
    assert.deepStrictEqual([t.shown.map((x) => x.selection), t.messages], [[new FakeRange(8, 6, 8, 11)], []]);
    t.holes.dispose();
    // With unsaved changes when the answer came (four lines inserted): not the text the load read.
    const u = holesApi();
    const dirty = new FakeDocument(fl, text);
    u.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT), dirty);
    dirty.edit(`-- 1\n-- 2\n-- 3\n-- 4\n${text}`);
    await u.load(MAIN, answer);
    await clickB(u);
    assert.deepStrictEqual(u.shown, []);
    assert.match(u.messages[0], /so which one this is is not known: save the file to check it again\.$/);
    u.holes.dispose();
  });

  test('an unlocated hole of another module is listed under its module, also when the loaded text has its ?name; one of the loaded module (or a namespace in it) under the file (twelfth review of M4)', async () => {
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT));
    // Base's source not found: its todo is not Main's ?todo, so it is not listed (nor revealed) there.
    await t.load(MAIN, [mainTodo, hole('Base.todo', 'Nat', []), hole('Main.A.size_rhs', 'Nat', [])]);
    assert.deepStrictEqual(t.tree(), ['Main.idr — holes', '  ?todo — Nat', '    ns : List Nat', '  ?size_rhs — Nat', 'Base — no source location', '  ?todo — Nat']);
    const items = t.holes.tree.getChildren(t.holes.tree.getChildren(undefined)[0]).map((n) => t.holes.tree.getTreeItem(n) as unknown as FakeTreeItem);
    const located = items.find((i) => i.id === `${MAIN}\nMain.todo`);
    assert.deepStrictEqual(located?.command?.arguments[0], { file: MAIN, name: 'todo', range: r(5, 11, 5, 16) });
    await t.run(REVEAL_HOLE_COMMAND, located?.command?.arguments[0]);
    assert.deepStrictEqual(t.shown.map((x) => x.selection), [new FakeRange(5, 11, 5, 16)]);
    t.holes.dispose();
  });

  test('a file\'s module is read from its code lines: in bird tracks a > line (also > and a tab), not prose that starts with module; non-ASCII names (last verification of M4)', async () => {
    assert.strictEqual(declaredModule('This file is about the\nmodule system.\n\n>\tmodule Foo\n> f : Nat\n', 'bird'), 'Foo');
    assert.strictEqual(declaredModule('> module Foo.Bar\n', 'bird'), 'Foo.Bar');
    assert.strictEqual(declaredModule('-- x\nmodule \u00dcn\u00ef.Z\u00df\n', undefined), '\u00dcn\u00ef.Z\u00df');
    assert.strictEqual(declaredModule('f : Nat\n', undefined), 'Main');
    // An indented header loads (`  module Indented` / `f = ?mh` answers `Indented.mh` [live, last verification of M4]).
    assert.strictEqual(declaredModule('  module Indented\n\nf : Nat\nf = ?mh\n', undefined), 'Indented');
    assert.strictEqual(declaredModule('\tmodule T\n', undefined), 'T');
    assert.strictEqual(declaredModule('>  module X\n', 'bird'), 'X');
    // Not a line inside a block comment or a `"""` string; in Org style a source block's line too (round 15 of M4).
    assert.strictEqual(declaredModule('{-\n  module documentation\n-}\nmodule Real\n', undefined), 'Real');
    assert.strictEqual(declaredModule('s : String\ns = """\n  module X\n  """\n', undefined), 'Main');
    assert.strictEqual(declaredModule('#+TITLE: x\n\n#+BEGIN_SRC idris\nmodule Foo\n#+END_SRC\n', 'org'), 'Foo');
    assert.strictEqual(declaredModule('#+IDRIS: module Bar\n', 'org'), 'Bar');
    // An unlocated hole of the file's module whose ?name it has is listed under the file.
    const lit = '/w/holes/Lit.lidr';
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(lit, 'This file is about the\nmodule system.\n\n>\tmodule Foo\n> f : Nat\n> f = ?h\n'));
    await t.load(lit, [hole('Foo.h', 'Nat', [])]);
    assert.deepStrictEqual(t.tree(), ['Lit.lidr — holes', '  ?h — Nat']);
    t.holes.dispose();
  });

  test('in the fenced literate styles the module is read from the code blocks only, comments and strings followed over code lines only (lane cycles of M4\'s last round)', async () => {
    // [live, idris2 0.8.0, 2026-10-01: one `--ide-mode` session loaded each text marked so and listed
    // its holes with `:metavariables`.] Prose that leaves `{-` or `"""` open is not code (A.ha listed);
    // an opening never closed opens nothing (no hole listed for B); a closing delimiter anywhere on a
    // line closes the block, and the lines after it are prose (no hole listed for C: `f = ?hc` came
    // after `-- a comment with ``` in it`); a block comment goes on over prose into the next block
    // (only D.hd listed, not the ?hidden inside the comment); prose that starts with `module` is not
    // a header (E.he, G.hg); Org prose is not code (F.hf).
    const cases: readonly (readonly [string, LiterateStyle, string])[] = [
      ['Prose that opens a comment {- and a string """ and never closes them.\n\n```idris\nmodule A\n\nf : Nat\nf = ?ha\n```\n', 'cmark', 'A'], // live
      ['```idris\nmodule B\n\nf : Nat\nf = ?hb\n', 'cmark', 'Main'], // live
      ['```idris\n-- a comment with ``` in it closes the block here\nmodule C\n```\n', 'cmark', 'Main'],
      ['```idris\n{-\n```\nProse.\n```idris\nmodule Hidden\n-}\nmodule Real\n```\n', 'cmark', 'Real'],
      ['\\section{Modules}\nmodule names are written with dots.\n\\begin{code}\nmodule E\nh : Nat\nh = ?he\n\\end{code}\n', 'tex', 'E'], // live
      ['#+TITLE: F\nProse {- here.\n#+BEGIN_SRC idris\nmodule F\nk : Nat\nk = ?hf\n#+END_SRC\n', 'org', 'F'], // live
      ['= Title\nmodule names are prose here.\n/* idris\nmodule G\nm : Nat\nm = ?hg\n*/\n', 'typst', 'G'], // live
      // The other delimiters of each style (`src/Parser/Unlit.idr` [src]); an opening only at a line's start.
      ['Some {- prose\n~~~idris\nmodule T\n~~~\n', 'cmark', 'T'],
      ['Some {- prose\n<!-- idris\nmodule H\n-->\n', 'cmark', 'H'],
      [' ```idris\nmodule I\n```\n', 'cmark', 'Main'],
      // The opening and closing lines are dropped whole: text after the opening delimiter, or a closing line, is not code
      // (`Wrong.md` listed `Main.hw`; a last code line `  + ?hc1 ```` listed only `Close.hc0` [live, M4's review of the
      // decisions]; `reduce` drops the block's last line [src]).
      ['```idris module Wrong\nf : Nat\nf = ?hw\n```\n', 'cmark', 'Main'], // live
      ['```idris\nmodule Q ```\n', 'cmark', 'Main'],
      // The whole opening line, a `{-` on it included, and a closing line that looks like an opening one: it opens nothing
      // (`block s e` consumes `e <+> untilEOL`, `Libraries/Text/Literate.idr` [src]; a file of the first shape, and one
      // whose second ```idris is followed by `x = "not a nat"`, pass `idris2 --check` [live, M4's second review of the fixes]).
      ['```idris {-\nmodule A\n```\n', 'cmark', 'A'], // live
      ['```idris\nf : Nat\n```idris\nmodule X\n```\n', 'cmark', 'Main'], // live
      ['Some {- prose\n\\begin{hidden}\nmodule Hid\n\\end{hidden}\n', 'tex', 'Hid'],
      ['Some {- prose\n#+begin_src idris\nmodule L\n#+end_src\n', 'org', 'L'],
      ['Some {- prose\n#+BEGIN_COMMENT idris\nmodule K\n#+END_COMMENT\n', 'org', 'K'],
      ['#+BEGIN_SRC idris\nnever closed {-\n#+IDRIS: module M\n', 'org', 'M'],
      ['Some {- prose\n```idris\nmodule Ty\n```\n', 'typst', 'Ty'],
    ];
    for (const [text, style, module] of cases) {
      assert.strictEqual(declaredModule(text, style), module, JSON.stringify(text));
    }
    // Linear: 40,000 openings that never close.
    const started = process.hrtime.bigint();
    assert.strictEqual(declaredModule(`${'\\begin{code}\n'.repeat(40_000)}module Late\n`, 'tex'), 'Main');
    assert.ok(process.hrtime.bigint() - started < 200_000_000n, 'more than 200 ms');
    // Linear too: 40,000 lines that each open a string and its interpolation inside the last one (what is open is shared
    // from line to line, not copied).
    const nested = process.hrtime.bigint();
    assert.strictEqual(declaredModule(`${'x = "\\{\n'.repeat(40_000)}module Late\n`, undefined), 'Main');
    assert.ok(process.hrtime.bigint() - nested < 200_000_000n, 'more than 200 ms');
    // An unlocated hole of the module of a Markdown file whose prose opens a comment: listed under the file.
    const doc = '/w/holes/Doc.md';
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(doc, 'Prose that opens a comment {- here.\n\n```idris\nmodule Foo\n\nf : Nat\nf = ?h\n```\n'));
    await t.load(doc, [hole('Foo.h', 'Nat', [])]);
    assert.deepStrictEqual(t.tree(), ['Doc.md — holes', '  ?h — Nat']);
    t.holes.dispose();
  });

  test('a hole\'s and a premise\'s tooltip are made on hover (resolveTreeItem), not sent with every item at each refresh', async () => {
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT));
    await t.load(MAIN, [mainSize, baseTodo, mainTodo]);
    const [base] = t.holes.tree.getChildren(undefined);
    const [todoNode] = t.holes.tree.getChildren(base);
    const [premiseNode] = t.holes.tree.getChildren(todoNode);
    const todoItem = t.holes.tree.getTreeItem(todoNode);
    const premiseItem = t.holes.tree.getTreeItem(premiseNode);
    assert.deepStrictEqual([todoItem.tooltip, premiseItem.tooltip], [undefined, undefined]);
    assert.strictEqual(t.holes.tree.resolveTreeItem(todoItem, todoNode).tooltip, holeTooltip(baseTodo));
    assert.strictEqual(t.holes.tree.resolveTreeItem(premiseItem, premiseNode).tooltip, '0 n : Nat');
    t.holes.dispose();
  });

  test('a file with unsaved changes says so; the view is redrawn when that changes, not at every keystroke', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    await t.load(MAIN, [mainTodo]);
    let redraws = 0;
    t.holes.tree.onDidChangeTreeData(() => redraws++);
    main.edit(`${MAIN_TEXT}-- typing\n`);
    t.events.change.fire({ document: main });
    main.edit(`${MAIN_TEXT}-- typing more\n`);
    t.events.change.fire({ document: main });
    assert.strictEqual(redraws, 1);
    assert.deepStrictEqual(t.tree()[0], 'Main.idr — holes · unsaved changes');
    const item = t.holes.tree.getTreeItem(t.holes.tree.getChildren(undefined)[0]) as unknown as FakeTreeItem;
    assert.match(item.tooltip ?? '', /unsaved changes/);
    main.isDirty = false;
    t.events.save.fire(main);
    assert.strictEqual(redraws, 2);
    assert.deepStrictEqual(t.tree()[0], 'Main.idr — holes');
    t.holes.dispose();
  });

  test('a deleted or renamed file leaves the view; the badge follows', async () => {
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT));
    await t.load(MAIN, [mainTodo, baseTodo]);
    t.events.renamed.fire({ files: [{ oldUri: new FakeUri('file', BASE, ''), newUri: new FakeUri('file', '/w/holes/B2.idr', '') }] });
    assert.deepStrictEqual(t.holes.model.files(), [MAIN]);
    assert.deepStrictEqual(t.view.badge, { value: 1, tooltip: '1 hole' });
    t.events.deleted.fire({ files: [new FakeUri('file', '/w/holes', '')] });
    assert.deepStrictEqual(t.holes.model.files(), []);
    assert.strictEqual(t.view.badge, undefined);
    t.holes.dispose();
  });

  test('a file deleted on disk (a checkout, rm: no onDidDeleteFiles) leaves the view, through a watcher of deletions only', async () => {
    const t = holesApi();
    t.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT));
    await t.load(MAIN, [mainTodo, baseTodo]);
    assert.deepStrictEqual(t.watchers, [{ glob: '**/*', ignores: [true, true, false] }]);
    t.events.deletedOnDisk.fire(new FakeUri('file', BASE, ''));
    assert.deepStrictEqual(t.holes.model.files(), [MAIN]);
    t.holes.dispose();
  });
});

suite('holes: revealing a hole (the tree\'s items, List Holes)', () => {
  test('a name from the argument and List Holes\' reason are shown as one line: control and bidi characters written out, no link', async () => {
    const t = holesApi({ queries: () => Promise.resolve({ kind: 'unavailable', reason: 'a\u202Eb.idr\nis not loaded [x](command:y)' }) });
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    await t.run(REVEAL_HOLE_COMMAND, { file: MAIN, name: 'a\u202Eb' });
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.messages, [
      'Idris 2: the compiler gave no place for ?a\\u{202E}b, and Main.idr has no ?a\\u{202E}b.',
      'Idris 2: a\\u{202E}b.idr is not loaded [x]\u200b(command:y)',
    ]);
    t.holes.dispose();
  });

  test('in an open document that shows the text as it was read: at the recorded range', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    await t.run(REVEAL_HOLE_COMMAND, { file: MAIN, name: 'todo', range: r(5, 11, 5, 16) });
    assert.strictEqual(t.shown.length, 1);
    assert.strictEqual(t.shown[0].doc, main);
    assert.deepStrictEqual(t.shown[0].selection, new FakeRange(5, 11, 5, 16));
    assert.deepStrictEqual(t.opened, []);
    t.holes.dispose();
  });

  test('moved by an unsaved edit: where it is now; a file not open is opened', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    main.edit(`-- a line added above\n${MAIN_TEXT}`);
    t.state.textDocuments.push(main);
    t.state.onDisk.set(BASE, BASE_TEXT);
    await t.run(REVEAL_HOLE_COMMAND, { file: MAIN, name: 'todo', range: r(5, 11, 5, 16) });
    await t.run(REVEAL_HOLE_COMMAND, { file: BASE, name: 'todo', range: r(7, 15, 7, 20) });
    assert.deepStrictEqual(
      t.shown.map((s) => [s.doc.fileName, s.selection]),
      [
        [MAIN, new FakeRange(6, 11, 6, 16)],
        [BASE, new FakeRange(7, 15, 7, 20)],
      ],
    );
    assert.deepStrictEqual(t.opened, [BASE]);
    t.holes.dispose();
  });

  test('says why when it cannot: the hole is gone, the file cannot be opened, the argument names no hole of an Idris file', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    main.edit(MAIN_TEXT.replace('?todo', 'length ns'));
    t.state.textDocuments.push(main);
    await t.run(REVEAL_HOLE_COMMAND, { file: MAIN, name: 'todo', range: r(5, 11, 5, 16) });
    await t.run(REVEAL_HOLE_COMMAND, { file: MAIN, name: 'todo' }); // listed without a place (not located)
    await t.run(REVEAL_HOLE_COMMAND, { file: '/w/holes/Gone.idr', name: 'h' });
    await t.run(REVEAL_HOLE_COMMAND, { file: '/etc/passwd', name: 'h' });
    await t.run(REVEAL_HOLE_COMMAND, { file: 'relative/A.idr', name: 'h' });
    await t.run(REVEAL_HOLE_COMMAND, { file: MAIN, name: 'todo', range: { start: { line: 'x' } } });
    await t.run(REVEAL_HOLE_COMMAND);
    assert.deepStrictEqual(t.messages, [
      'Idris 2: ?todo is not in Main.idr any more: the file changed since the compiler read it.',
      'Idris 2: the compiler gave no place for ?todo, and Main.idr has no ?todo.',
      'Idris 2: Gone.idr, the file of ?h, cannot be opened.',
      'Idris 2: Go to Hole needs a hole of an Idris file.',
      'Idris 2: Go to Hole needs a hole of an Idris file.',
      'Idris 2: Go to Hole needs a hole of an Idris file.',
      'Idris 2: Go to Hole needs a hole of an Idris file.',
    ]);
    assert.deepStrictEqual(t.opened, ['/w/holes/Gone.idr']);
    assert.deepStrictEqual(t.shown, []);
    t.holes.dispose();
  });
});

suite('holes: file paths shown (a folder or file name of a cloned repository, or a path the compiler answers)', () => {
  test('the file item\'s label, description and tooltip, the List Holes separator and Go to Hole\'s messages write out invisible characters', async () => {
    const evil = '/w/d\u202Eir/a\u200Bb.idr';
    const evilHole = hole('A.h', 'Nat', [], evil, r(2, 4, 2, 6));
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    await t.load(MAIN, [evilHole]);
    const item = t.holes.tree.getTreeItem(t.holes.tree.getChildren(undefined)[0]) as unknown as FakeTreeItem;
    assert.deepStrictEqual([item.label, item.description, item.tooltip], ['a\\u{200B}b.idr', 'd\\u{202E}ir', '/w/d\\u{202E}ir/a\\u{200B}b.idr']);
    t.backend.answers.push(() => Promise.resolve([mainTodo, evilHole]));
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.quickPicks[0].items.filter((i) => i.kind === -1).map((i) => i.label), ['holes/Main.idr', 'd\\u{202E}ir/a\\u{200B}b.idr']);
    await t.run(REVEAL_HOLE_COMMAND, { file: evil, name: 'h', range: r(2, 4, 2, 6) });
    t.state.textDocuments.push(new FakeDocument(evil, 'module A\n\nh = 0\n'));
    await t.run(REVEAL_HOLE_COMMAND, { file: evil, name: 'h', range: r(2, 4, 2, 6) });
    assert.deepStrictEqual(t.messages, [
      'Idris 2: a\\u{200B}b.idr, the file of ?h, cannot be opened.',
      'Idris 2: ?h is not in a\\u{200B}b.idr any more: the file changed since the compiler read it.',
    ]);
    t.holes.dispose();
  });
});

suite('holes: module names shown (a hole without a source location; module names are identifiers, which may hold such characters)', () => {
  test('the module item\'s label and tooltip, the hole\'s tooltip and List Holes\' message write out invisible characters; a line break is a space in the label', async () => {
    const evilHole = hole('A‮B.h', 'Nat', []);
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    await t.load(MAIN, [evilHole]);
    const [moduleNode] = t.holes.tree.getChildren(undefined);
    const moduleItem = t.holes.tree.getTreeItem(moduleNode) as unknown as FakeTreeItem;
    assert.strictEqual(moduleItem.label, 'A\\u{202E}B');
    assert.match(moduleItem.tooltip ?? '', /^A\\u\{202E\}B\n/u);
    const [holeNode] = t.holes.tree.getChildren(moduleNode);
    assert.match(String(t.holes.tree.resolveTreeItem(t.holes.tree.getTreeItem(holeNode), holeNode).tooltip), /^A\\u\{202E\}B\.h\n/u);
    t.backend.answers.push(() => Promise.resolve([mainTodo, evilHole]));
    t.state.pick = (items) => items.find((i) => i.label === '?h');
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.messages, ['Idris 2: the compiler gave no source location for ?h (A\\u{202E}B.h).']);
    t.holes.dispose();
    const u = holesApi();
    u.state.textDocuments.push(new FakeDocument(MAIN, MAIN_TEXT));
    await u.load(MAIN, [hole('A\nB.h', 'Nat', [])]);
    assert.strictEqual((u.holes.tree.getTreeItem(u.holes.tree.getChildren(undefined)[0]) as unknown as FakeTreeItem).label, 'A B');
    u.holes.dispose();
  });
});

suite('holes: List Holes', () => {
  test('asks the compiler with the command\'s rules; the file\'s own holes first, then each imported file\'s, under a separator; picking one reveals it', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    t.state.onDisk.set(BASE, BASE_TEXT);
    t.backend.answers.push(() => Promise.resolve([baseTodo, mainSize, mainTodo]));
    t.state.pick = (items) => items.find((i) => i.ref?.file === BASE);
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.queried, [`command ${MAIN}`]);
    assert.deepStrictEqual(t.progress, ['10 Idris 2: List Holes…'], 'under the window\'s progress (the file may be checked first)');
    assert.deepStrictEqual(t.backend.kept, [false], 'not the kept holes: the file is checked first when another was loaded since');
    const [pick] = t.quickPicks;
    assert.deepStrictEqual(
      pick.items.map((i) => (i.kind === -1 ? `-- ${i.label}` : `${i.label} : ${i.description}`)),
      ['-- holes/Main.idr', '?todo : Nat', '?size_rhs : Nat', '-- holes/Base.idr', '?todo : Vect (S n) a'],
    );
    assert.deepStrictEqual(pick.options, { title: 'Idris 2: List Holes', placeHolder: 'Pick a hole to go to it', matchOnDescription: true });
    assert.deepStrictEqual(t.shown.map((s) => [s.doc.fileName, s.selection]), [[BASE, new FakeRange(7, 15, 7, 20)]]);
    assert.deepStrictEqual(t.messages, []);
    t.holes.dispose();
  });

  test('a hole without a source location of another module: under that module\'s separator, after the files; picking it says so', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    t.backend.answers.push(() => Promise.resolve([hole('Dep.dep_hole', 'Nat', []), mainTodo, hole('Main.size_rhs', 'Nat', [])]));
    t.state.pick = (items) => items.find((i) => i.label === '?dep_hole');
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(
      t.quickPicks[0].items.map((i) => (i.kind === -1 ? `-- ${i.label}` : `${i.label} : ${i.description}`)),
      ['-- holes/Main.idr', '?todo : Nat', '?size_rhs : Nat', '-- Dep (no source location)', '?dep_hole : Nat'],
    );
    assert.deepStrictEqual(t.messages, ['Idris 2: the compiler gave no source location for ?dep_hole (Dep.dep_hole).']);
    assert.deepStrictEqual(t.shown, []);
    t.holes.dispose();
  });

  test('an unlocated hole of a bird-track file\'s module (read from its > lines, not its prose) is listed under the file', async () => {
    const t = holesApi();
    const lit = new FakeDocument('/w/holes/Lit.lidr', 'This file is about the\nmodule system.\n\n>\tmodule Foo\n> f : Nat\n> f = ?h\n');
    t.state.textDocuments.push(lit);
    t.state.editor = { document: lit };
    t.backend.answers.push(() => Promise.resolve([hole('Foo.h', 'Nat', [])]));
    t.state.pick = () => undefined;
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.quickPicks[0].items.map((i) => (i.kind === -1 ? `-- ${i.label}` : `${i.label} : ${i.description}`)), ['-- holes/Lit.lidr', '?h : Nat']);
    t.holes.dispose();
  });

  test('QuickPick texts cannot draw theme icons; with unsaved changes the placeholder says the list is of the saved file', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    main.edit(`${MAIN_TEXT}\n`);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    t.backend.answers.push(() => Promise.resolve([hole('Main.h', 'Icon $(zap) x', [], MAIN, r(5, 11, 5, 16))]));
    await t.run('idris2.listHoles');
    assert.strictEqual(t.quickPicks[0].items[1].description, 'Icon $​(zap) x');
    assert.strictEqual(t.quickPicks[0].options.placeHolder, 'The holes as the file was saved (it has unsaved changes): pick one to go to it');
    t.holes.dispose();
  });

  test('says why when there is nothing to list: no Idris file on disk, the compiler\'s reason, no holes', async () => {
    const t = holesApi({ queries: (doc) => Promise.resolve(doc.fileName === MAIN ? { kind: 'unavailable', reason: 'Restricted Mode: the compiler is not run in a workspace that is not trusted.' } : { kind: 'answer', value: [] }) });
    await t.run('idris2.listHoles');
    t.state.editor = { document: new FakeDocument('/w/Untitled-1', 'f = ?h', 'idris2', 'untitled') };
    await t.run('idris2.listHoles');
    t.state.editor = { document: new FakeDocument(MAIN, MAIN_TEXT) };
    await t.run('idris2.listHoles');
    t.state.editor = { document: new FakeDocument(BASE, BASE_TEXT) };
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.messages, [
      'Idris 2: List Holes needs an Idris file saved on disk in the active editor.',
      'Idris 2: List Holes needs an Idris file saved on disk in the active editor.',
      'Idris 2: Restricted Mode: the compiler is not run in a workspace that is not trusted.',
      'Idris 2: the compiler reports no holes in this file and the modules it imports.',
    ]);
    assert.deepStrictEqual(t.quickPicks, []);
    t.holes.dispose();
  });

  test('no holes listed after a load that returned an error, while the view keeps the file\'s holes: says the file did not load cleanly (final review of M4)', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    await t.load(MAIN, [mainTodo, mainSize]);
    await t.load(MAIN, [], true); // a parse error: the compiler lists none [live]
    assert.deepStrictEqual(names(t.holes.model.holesIn(MAIN)), ['Main.todo', 'Main.size_rhs']);
    t.backend.answers.push(() => Promise.resolve([]));
    await t.run('idris2.listHoles');
    await t.load(MAIN, []);
    t.backend.answers.push(() => Promise.resolve([]));
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.messages, [
      'Idris 2: the compiler lists no holes, but the file did not load cleanly, which can hide them. Fix the first error and save.',
      'Idris 2: the compiler reports no holes in this file and the modules it imports.',
    ]);
    t.holes.dispose();
  });

  test('holes listed after a load that returned an error (an import\'s only): the title says the file did not load cleanly (eleventh review of M4)', async () => {
    const t = holesApi();
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    await t.load(MAIN, [mainTodo]);
    await t.load(MAIN, [baseTodo], true); // an error in Base: only Base's holes [live]
    t.backend.answers.push(() => Promise.resolve([baseTodo]));
    await t.run('idris2.listHoles');
    assert.strictEqual(t.quickPicks[0].options.title, 'Idris 2: List Holes — the file did not load cleanly, so its own holes may be missing: fix the first error and save');
    await t.load(MAIN, [mainTodo, baseTodo]);
    t.backend.answers.push(() => Promise.resolve([mainTodo, baseTodo]));
    await t.run('idris2.listHoles');
    assert.strictEqual(t.quickPicks[1].options.title, 'Idris 2: List Holes');
    t.holes.dispose();
  });

  test('two holes of one name (namespaces): each item carries its index among them, so that the pick finds the right one after an edit (final review of M4)', async () => {
    const t = holesApi();
    const ns = '/w/holes/NS.idr';
    const text = 'module NS\nnamespace A\n  export\n  x : Nat\n  x = ?todo\n\nnamespace B\n  export\n  y : Nat\n  y = ?todo\n';
    const doc = new FakeDocument(ns, text);
    t.state.textDocuments.push(doc);
    t.state.editor = { document: doc };
    t.backend.answers.push(() => Promise.resolve([hole('NS.B.todo', 'Nat', [], ns, r(9, 6, 9, 11)), hole('NS.A.todo', 'Nat', [], ns, r(4, 6, 4, 11))]));
    // Three lines inserted above (unsaved): the nearest ?todo to B's recorded line is A's.
    doc.edit(`-- 1\n-- 2\n-- 3\n${text}`);
    t.state.pick = (items) => items.filter((i) => i.ref !== undefined)[1];
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(
      t.quickPicks[0].items.filter((i) => i.ref !== undefined).map((i) => i.ref?.ordinal),
      [
        { index: 0, count: 2 },
        { index: 1, count: 2 },
      ],
    );
    assert.deepStrictEqual(t.shown.map((x) => x.selection), [new FakeRange(12, 6, 12, 11)]);
    t.holes.dispose();
  });

  test('a listing that takes long offers Cancel (ninth review of M4); Cancel ends the command at once and cancels the backend\'s token', async () => {
    const t = holesApi({ cancelOfferMs: 0 });
    const main = new FakeDocument(MAIN, MAIN_TEXT);
    t.state.textDocuments.push(main);
    t.state.editor = { document: main };
    let token: vscode.CancellationToken | undefined;
    t.backend.holes = (_doc: vscode.TextDocument, holesOptions?: HolesOptions) => {
      token = holesOptions?.token;
      return new Promise<Hole[]>(() => undefined); // never answers
    };
    const running = t.run('idris2.listHoles');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(t.notifications.map((n) => n.title), ['Idris 2: List Holes is still running. Cancel stops it; a check of the file already running finishes first.']);
    assert.strictEqual(token?.isCancellationRequested, false);
    t.notifications[0].cancel();
    await running;
    assert.strictEqual(token?.isCancellationRequested, true);
    assert.deepStrictEqual(t.messages, []);
    assert.deepStrictEqual(t.quickPicks, []);
    t.holes.dispose();
  });

  test('a failure inside the command is shown as one line of plain text, not thrown', async () => {
    const t = holesApi({ queries: () => Promise.reject(new Error('boom [x](command:evil)\nsecond line')) });
    t.state.editor = { document: new FakeDocument(MAIN, MAIN_TEXT) };
    await t.run('idris2.listHoles');
    assert.deepStrictEqual(t.messages, ['Idris 2: List Holes failed: boom [x]​(command:evil) second line']);
    t.holes.dispose();
  });
});

// -------------------------------------------------------------------------------------------
// idris2.isIdrisWorkspace
// -------------------------------------------------------------------------------------------

function workspaceHost(options: { open?: FakeDocument[]; ipkgs?: string[] } = {}) {
  const set: [string, boolean][] = [];
  const created = new Emitter<string>();
  const folders = new Emitter<void>();
  const opened = new Emitter<FakeDocument>();
  let ipkgs = options.ipkgs ?? [];
  let searches = 0;
  const host = {
    hasIpkgFile: () => {
      searches++;
      return Promise.resolve(ipkgs.length > 0);
    },
    onDidCreateOrDeleteIpkgFile: created.event,
    onDidChangeFolders: folders.event,
    openDocuments: () => options.open ?? [],
    onDidOpenDocument: opened.event,
    setContext: (key: string, value: boolean) => set.push([key, value]),
    log: quietLog,
  };
  return { host, set, created, folders, opened, setIpkgs: (files: string[]) => (ipkgs = files), searches: () => searches };
}

suite('holes: the context key idris2.isIdrisWorkspace, which shows the view', () => {
  test('true at once when an Idris document is open; reset to false when disposed', () => {
    const t = workspaceHost({ open: [new FakeDocument('/w/notes.md', '', 'markdown'), new FakeDocument('/w/A.lidr', '')] });
    const tracker = trackIsIdrisWorkspace(t.host);
    assert.deepStrictEqual(t.set, [[IS_IDRIS_WORKSPACE_CONTEXT_KEY, true]]);
    assert.strictEqual(t.searches(), 0);
    tracker.dispose();
    tracker.dispose();
    assert.deepStrictEqual(t.set, [
      [IS_IDRIS_WORKSPACE_CONTEXT_KEY, true],
      [IS_IDRIS_WORKSPACE_CONTEXT_KEY, false],
    ]);
  });

  test('true once a workspace folder holds an .ipkg: found at the start, or after a folder or .ipkg change; never set back', async () => {
    const t = workspaceHost();
    const tracker = trackIsIdrisWorkspace(t.host);
    await settle();
    assert.deepStrictEqual(t.set, []);
    t.folders.fire();
    await settle();
    assert.deepStrictEqual(t.set, []);
    t.setIpkgs(['/w/p/p.ipkg']);
    t.created.fire('/w/p/p.ipkg');
    await settle();
    assert.deepStrictEqual(t.set, [[IS_IDRIS_WORKSPACE_CONTEXT_KEY, true]]);
    t.setIpkgs([]);
    t.created.fire('/w/p/p.ipkg');
    t.opened.fire(new FakeDocument('/w/B.idr', ''));
    await settle();
    assert.deepStrictEqual(t.set, [[IS_IDRIS_WORKSPACE_CONTEXT_KEY, true]]);
    assert.strictEqual(t.searches(), 3);
    tracker.dispose();
  });

  test('true when an Idris document is opened later; other documents do not count; without either it stays unset, also after dispose', async () => {
    const t = workspaceHost();
    const tracker = trackIsIdrisWorkspace(t.host);
    t.opened.fire(new FakeDocument('/w/notes.txt', '', 'plaintext'));
    assert.deepStrictEqual(t.set, []);
    t.opened.fire(new FakeDocument('/w/A.idr', ''));
    assert.deepStrictEqual(t.set, [[IS_IDRIS_WORKSPACE_CONTEXT_KEY, true]]);
    tracker.dispose();
    const u = workspaceHost();
    trackIsIdrisWorkspace(u.host).dispose();
    await settle();
    assert.deepStrictEqual(u.set, []);
  });
});
