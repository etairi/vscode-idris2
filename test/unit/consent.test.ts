// features/consent/gate.ts: when an IDE-mode session may start in a directory (ROADMAP §9, the
// user's decision of 2026-09-27) — Restricted Mode, trusted workspace folders, the question asked
// once per directory and window, the folders allowed for good, canonical paths.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Emitter } from '../../src/core/event';
import type { GateVerdict } from '../../src/core/trust';
import { ConsentGate, type ConsentChoice, type ConsentRecord, type ConsentStore } from '../../src/features/consent/gate';

const quietLog = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

class MemoryStore implements ConsentStore {
  folders: string[] = [];
  decided: Record<string, number> = {};
  get(): ConsentRecord {
    return { folders: this.folders, decided: this.decided };
  }
  set(record: ConsentRecord): Promise<void> {
    this.folders = [...record.folders];
    this.decided = { ...record.decided };
    return Promise.resolve();
  }
}

interface Setup {
  gate: ConsentGate;
  store: MemoryStore;
  trust: { isTrusted: boolean; onDidGrant: Emitter<void>['event'] };
  trustGranted: Emitter<void>;
  folders: string[];
  foldersChanged: Emitter<void>;
  /** The questions shown, by real path, with the function that answers each. */
  questions: { dir: string; answer: (choice: ConsentChoice | undefined) => void }[];
  changes: () => number;
}

function setup(options: {
  folders?: string[];
  trusted?: boolean;
  platform?: NodeJS.Platform;
  store?: MemoryStore;
  /** `realpath`: a map of spellings, else the path itself; `missing` paths reject. */
  links?: Record<string, string>;
  missing?: string[];
  realpath?: (p: string) => Promise<string>;
  /** Receives the gate's info lines. */
  info?: (line: string) => void;
  /** The clock of the decisions. */
  now?: () => number;
}): Setup {
  const trustGranted = new Emitter<void>();
  const foldersChanged = new Emitter<void>();
  const trust = { isTrusted: options.trusted ?? true, onDidGrant: trustGranted.event };
  const folders = options.folders ?? ['/w/proj'];
  const store = options.store ?? new MemoryStore();
  const questions: Setup['questions'] = [];
  const gate = new ConsentGate({
    trust,
    folders: () => folders,
    onDidChangeFolders: foldersChanged.event,
    realpath:
      options.realpath ??
      ((p) =>
        options.missing?.includes(p) === true
          ? Promise.reject(Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }))
          : Promise.resolve(options.links?.[p] ?? p)),
    platform: options.platform ?? 'darwin',
    store,
    ask: (dir) => new Promise((resolve) => questions.push({ dir, answer: resolve })),
    log: options.info === undefined ? quietLog : { ...quietLog, info: options.info },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let changes = 0;
  gate.onDidChange(() => changes++);
  return { gate, store, trust, trustGranted, folders, foldersChanged, questions, changes: () => changes };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Waits until `n` questions have been shown. */
async function questionsShown(t: Setup, n: number): Promise<void> {
  for (let i = 0; i < 20 && t.questions.length < n; i++) {
    await settle();
  }
  assert.strictEqual(t.questions.length, n);
}

suite('features/consent/gate', () => {
  test('Restricted Mode: never allowed and nobody is asked, whatever the directory', async () => {
    const t = setup({ trusted: false });
    for (const dir of ['/w/proj', '/elsewhere']) {
      assert.deepStrictEqual(await t.gate.permit(dir), { allowed: false, reason: 'restrictedMode' });
      assert.deepStrictEqual(t.gate.current(dir), { allowed: false, reason: 'restrictedMode' });
      assert.deepStrictEqual(await t.gate.askAgain(dir), { allowed: false, reason: 'restrictedMode' });
    }
    assert.strictEqual(t.questions.length, 0);
  });

  test('a trusted workspace folder and the directories below it are allowed without a question; a sibling with a longer name is not', async () => {
    const t = setup({ folders: ['/w/proj'] });
    assert.deepStrictEqual(await t.gate.permit('/w/proj'), { allowed: true, basis: 'workspaceFolder' });
    assert.deepStrictEqual(await t.gate.permit('/w/proj/sub/dir'), { allowed: true, basis: 'workspaceFolder' });
    assert.deepStrictEqual(t.gate.current('/w/proj/sub/dir'), { allowed: true, basis: 'workspaceFolder' });
    assert.strictEqual(t.questions.length, 0);
    void t.gate.permit('/w/proj2');
    void t.gate.permit('/w');
    await questionsShown(t, 2);
    assert.deepStrictEqual(t.questions.map((q) => q.dir), ['/w/proj2', '/w']);
  });

  test('outside the folders: one question per directory, shared by concurrent requests; Allow holds for this window', async () => {
    const t = setup({});
    assert.strictEqual(t.gate.current('/pkg'), undefined, 'nobody asked yet');
    const first = t.gate.permit('/pkg');
    const second = t.gate.permit('/pkg');
    await questionsShown(t, 1);
    assert.strictEqual(t.gate.asking('/pkg'), true);
    assert.deepStrictEqual(t.gate.openQuestions(), ['/pkg']);
    assert.strictEqual(t.gate.current('/pkg'), undefined, 'the question is open');
    t.questions[0].answer('allow');
    const expected: GateVerdict = { allowed: true, basis: 'window' };
    assert.deepStrictEqual(await first, expected);
    assert.deepStrictEqual(await second, expected);
    assert.strictEqual(t.gate.asking('/pkg'), false);
    assert.deepStrictEqual(await t.gate.permit('/pkg'), expected);
    assert.deepStrictEqual(t.gate.current('/pkg'), expected);
    assert.strictEqual(t.questions.length, 1);
    assert.deepStrictEqual(t.store.folders, [], 'Allow is not remembered');
    // "Per directory" means the directory itself.
    void t.gate.permit('/pkg/sub');
    await questionsShown(t, 2);
  });

  test("Don't Allow holds for this window without asking again; Allow… (askAgain) asks again", async () => {
    const t = setup({});
    const denied = t.gate.permit('/pkg');
    await questionsShown(t, 1);
    t.questions[0].answer('deny');
    assert.deepStrictEqual(await denied, { allowed: false, reason: 'denied' });
    assert.deepStrictEqual(await t.gate.permit('/pkg'), { allowed: false, reason: 'denied' });
    assert.deepStrictEqual(t.gate.current('/pkg'), { allowed: false, reason: 'denied' });
    assert.strictEqual(t.questions.length, 1);
    const again = t.gate.askAgain('/pkg');
    await questionsShown(t, 2);
    t.questions[1].answer('allow');
    assert.deepStrictEqual(await again, { allowed: true, basis: 'window' });
  });

  test('a question closed without an answer is "unanswered" and is not shown again by itself', async () => {
    const t = setup({});
    const closed = t.gate.permit('/pkg');
    await questionsShown(t, 1);
    t.questions[0].answer(undefined);
    assert.deepStrictEqual(await closed, { allowed: false, reason: 'unanswered' });
    assert.deepStrictEqual(await t.gate.permit('/pkg'), { allowed: false, reason: 'unanswered' });
    assert.strictEqual(t.questions.length, 1);
  });

  test('Always Allow is remembered as the real path, holds in a new window, and Manage Allowed Folders revokes it', async () => {
    const store = new MemoryStore();
    const t = setup({ store, links: { '/w/link-to-pkg': '/real/pkg' } });
    const always = t.gate.permit('/w/link-to-pkg');
    await questionsShown(t, 1);
    assert.strictEqual(t.questions[0].dir, '/real/pkg', 'the question names the real path');
    t.questions[0].answer('always');
    assert.deepStrictEqual(await always, { allowed: true, basis: 'always' });
    assert.deepStrictEqual(store.folders, ['/real/pkg']);

    const next = setup({ store, links: { '/w/link-to-pkg': '/real/pkg' } });
    assert.deepStrictEqual(await next.gate.permit('/real/pkg'), { allowed: true, basis: 'always' });
    assert.deepStrictEqual(await next.gate.permit('/w/link-to-pkg'), { allowed: true, basis: 'always' });
    assert.deepStrictEqual(next.gate.allowedFolders(), ['/real/pkg']);
    assert.strictEqual(next.questions.length, 0);

    const before = next.changes();
    await next.gate.revoke(['/real/pkg']);
    assert.strictEqual(next.changes(), before + 1);
    assert.deepStrictEqual(store.folders, []);
    assert.strictEqual(next.gate.current('/w/link-to-pkg'), undefined, 'unknown again: its sessions stop, the next one asks');
    void next.gate.permit('/w/link-to-pkg');
    await questionsShown(next, 1);
  });

  test('revoking also forgets this window\'s Allow for that folder', async () => {
    const t = setup({});
    const allowed = t.gate.permit('/pkg');
    await questionsShown(t, 1);
    t.questions[0].answer('allow');
    await allowed;
    await t.gate.revoke(['/pkg']);
    assert.strictEqual(t.gate.current('/pkg'), undefined);
  });

  test('one directory spelled through a link or with another case (as realpath canonicalises on macOS) is one directory', async () => {
    const t = setup({ folders: ['/Users/u/Proj'], links: { '/users/u/proj/src': '/Users/u/Proj/src', '/tmp/x': '/private/tmp/X', '/tmp/X': '/private/tmp/X' } });
    assert.deepStrictEqual(await t.gate.permit('/users/u/proj/src'), { allowed: true, basis: 'workspaceFolder' });
    const first = t.gate.permit('/tmp/x');
    const second = t.gate.permit('/tmp/X');
    await questionsShown(t, 1);
    t.questions[0].answer('allow');
    assert.deepStrictEqual(await first, await second);
    assert.deepStrictEqual(t.gate.current('/tmp/X'), { allowed: true, basis: 'window' });
  });

  test('Windows: the drive letter is compared without regard to case; the rest as the real path spells it', async () => {
    // realpath returns the case stored on disk (simulated by `links`), the drive letter upper-case.
    const store = new MemoryStore();
    store.folders = ['D:\\Pkgs\\Lib'];
    const links = { 'c:\\work\\proj\\src': 'C:\\Work\\Proj\\src', 'd:\\pkgs\\lib': 'D:\\Pkgs\\Lib', 'c:\\Work\\Proj': 'C:\\Work\\Proj' };
    const t = setup({ platform: 'win32', folders: ['c:\\Work\\Proj'], store, links });
    assert.deepStrictEqual(await t.gate.permit('c:\\work\\proj\\src'), { allowed: true, basis: 'workspaceFolder' });
    assert.deepStrictEqual(await t.gate.permit('d:\\pkgs\\lib'), { allowed: true, basis: 'always' });
    // A spelling realpath keeps (here: the lower-case drive letter VS Code uses) is folded too.
    assert.deepStrictEqual(await t.gate.permit('c:\\Work\\Proj\\x'), { allowed: true, basis: 'workspaceFolder' });
    assert.deepStrictEqual(await t.gate.permit('d:\\Pkgs\\Lib'), { allowed: true, basis: 'always' });
    assert.strictEqual(t.questions.length, 0);
    await t.gate.revoke(['D:\\Pkgs\\Lib']);
    assert.deepStrictEqual(store.folders, []);
  });

  test('Windows: names that differ only in case are different folders (NTFS keeps them apart in a case-sensitive folder)', async () => {
    // M2 verification of the third review: with every ASCII letter folded, C:\src\REPO passed for
    // the workspace folder C:\src\repo, and C:\proj\LIB for the allowed C:\proj\lib.
    const store = new MemoryStore();
    store.folders = ['C:\\proj\\lib'];
    const t = setup({ platform: 'win32', folders: ['C:\\src\\repo'], store });
    for (const dir of ['C:\\src\\REPO\\x', 'C:\\src\\REPO', 'C:\\proj\\LIB']) {
      void t.gate.permit(dir);
    }
    await questionsShown(t, 3);
    assert.deepStrictEqual(await t.gate.permit('C:\\src\\repo\\x'), { allowed: true, basis: 'workspaceFolder' });
    assert.deepStrictEqual(await t.gate.permit('C:\\proj\\lib'), { allowed: true, basis: 'always' });
    // A workspace folder whose real path cannot be read is compared as spelled (not folded): a
    // directory spelled otherwise is asked about.
    const gone = setup({ platform: 'win32', folders: ['C:\\Gone'], missing: ['C:\\Gone'] });
    void gone.gate.permit('C:\\GONE\\x');
    await questionsShown(gone, 1);
  });

  test('Windows: KELVIN, ANGSTROM and OHM SIGN are not the letters NTFS keeps apart from them', async () => {
    // `toLowerCase` maps U+212A to k, U+212B to å and U+2126 to ω; NTFS does not (module comment).
    const store = new MemoryStore();
    store.folders = ['C:\\proj\\sk', 'C:\\proj\\å', 'C:\\proj\\ω'];
    const t = setup({ platform: 'win32', folders: ['C:\\Users\\me\\k', 'C:\\Users\\me\\å', 'C:\\Users\\me\\ω'], store });
    for (const dir of ['C:\\Users\\me\\\u212a', 'C:\\Users\\me\\\u212b', 'C:\\Users\\me\\\u2126', 'C:\\proj\\s\u212a', 'C:\\proj\\\u212b', 'C:\\proj\\\u2126']) {
      void t.gate.permit(dir);
    }
    await questionsShown(t, 6);
    assert.deepStrictEqual(await t.gate.permit('c:\\Users\\me\\k\\src'), { allowed: true, basis: 'workspaceFolder' });
    assert.deepStrictEqual(await t.gate.permit('c:\\proj\\sk'), { allowed: true, basis: 'always' });
    // A folder at the root of a drive (its key ends with the separator) contains its subdirectories.
    const root = setup({ platform: 'win32', folders: ['D:\\'] });
    assert.deepStrictEqual(await root.gate.permit('d:\\x'), { allowed: true, basis: 'workspaceFolder' });
  });

  test("a copy of this window's earlier write that comes back after a later one does not undo the later decision", async () => {
    // VS Code sends each write of the global state back to every window, the writer included, with
    // the value stored when it sends it (gate.ts module comment [src]); a window that writes twice
    // quickly reads its first write again for a while. Simulated: the copy is put into the store.
    let clock = 1000;
    const store = new MemoryStore();
    const lines: string[] = [];
    const t = setup({ store, info: (line) => lines.push(line), now: () => clock });
    const always = t.gate.permit('/pkg');
    await questionsShown(t, 1);
    t.questions[0].answer('always');
    assert.deepStrictEqual(await always, { allowed: true, basis: 'always' });
    const afterAlways = store.get();
    assert.deepStrictEqual(afterAlways, { folders: ['/pkg'], decided: { '/pkg': 1000 } });
    await t.gate.revoke(['/pkg']);
    assert.deepStrictEqual(store.get(), { folders: [], decided: { '/pkg': 1001 } }, 'the clock is made strictly increasing');
    store.folders = [...afterAlways.folders];
    store.decided = { ...afterAlways.decided };
    assert.strictEqual(t.gate.current('/pkg'), undefined, 'still revoked: not allowed without asking');
    assert.strictEqual(t.gate.current('/pkg'), undefined);
    assert.deepStrictEqual(t.gate.allowedFolders(), []);
    const logged = lines.filter((l) => l.includes("this window's later decision holds"));
    assert.deepStrictEqual(
      logged,
      ["Consent: the stored list of folders always allowed names /pkg as it was before this window revoked it; this window's later decision holds"],
      'logged once',
    );
    // The same for a list written before times were kept (no time: outdated by any decision here).
    store.decided = {};
    assert.strictEqual(t.gate.current('/pkg'), undefined);
    void t.gate.permit('/pkg');
    await questionsShown(t, 2);
    clock = 2000;
    t.questions[1].answer('always');
    await settle();
    // And the other way round: a copy of the revocation arrives after Always Allow.
    store.folders = [];
    store.decided = { '/pkg': 1001 };
    assert.deepStrictEqual(t.gate.current('/pkg'), { allowed: true, basis: 'always' });
    assert.deepStrictEqual(t.gate.allowedFolders(), ['/pkg']);
  });

  test('a revocation holds at once, before the store\'s write has completed: also over this window\'s own Allow', async () => {
    // M2 second verification of the third review: the window's answers were forgotten only after the
    // write, so meanwhile a folder answered Allow here (and Always in another window) read as allowed.
    const store = new MemoryStore();
    const a = setup({ store });
    const b = setup({ store });
    const allowed = a.gate.permit('/x');
    await questionsShown(a, 1);
    a.questions[0].answer('allow');
    assert.deepStrictEqual(await allowed, { allowed: true, basis: 'window' });
    const always = b.gate.permit('/x');
    await questionsShown(b, 1);
    b.questions[0].answer('always');
    await always;
    let release = (): void => undefined;
    store.set = (record) => {
      store.folders = [...record.folders];
      store.decided = { ...record.decided };
      return new Promise<void>((resolve) => (release = resolve)); // the write completes later
    };
    const before = a.changes();
    const revoked = a.gate.revoke(['/x']);
    assert.strictEqual(await a.gate.recheck('/x'), undefined, 'a start now would need a question');
    assert.strictEqual(a.gate.current('/x'), undefined);
    assert.strictEqual(a.changes(), before + 1, 'the sessions there are stopped now');
    release();
    await revoked;
    assert.strictEqual(a.changes(), before + 1);
  });

  test('a folder revoked in another window is asked about here, and a later write here does not bring it back', async () => {
    // M2 verification of the third review: this window's decisions used to win for good, and every
    // write re-asserted them, so a revocation elsewhere was ignored here and then undone for every
    // window. Two windows share one store; each write reaches the other's copy (gate.ts [src]).
    let clock = 1000;
    const store = new MemoryStore();
    const a = setup({ store, now: () => clock });
    const b = setup({ store, now: () => clock });
    const always = a.gate.permit('/x');
    await questionsShown(a, 1);
    a.questions[0].answer('always');
    assert.deepStrictEqual(await always, { allowed: true, basis: 'always' });
    assert.deepStrictEqual(await b.gate.permit('/x'), { allowed: true, basis: 'always' }, 'the other window reads it');
    // In the same millisecond by the clock: still later than the decision it read.
    await b.gate.revoke(['/x']);
    assert.deepStrictEqual(store.folders, []);
    // Window A: not allowed without asking any more.
    assert.strictEqual(a.gate.current('/x'), undefined);
    const asked = a.gate.permit('/x');
    await questionsShown(a, 2);
    // An unrelated Always Allow in window A keeps the revocation.
    clock = 3000;
    const other = a.gate.permit('/y');
    await questionsShown(a, 3);
    a.questions[2].answer('always');
    await other;
    assert.deepStrictEqual(store.folders, ['/y']);
    assert.deepStrictEqual(store.decided, { '/x': 1001, '/y': 3000 });
    // A new window: /x is asked about, /y is allowed.
    const fresh = setup({ store });
    assert.deepStrictEqual(await fresh.gate.permit('/y'), { allowed: true, basis: 'always' });
    void fresh.gate.permit('/x');
    await questionsShown(fresh, 1);
    a.questions[1].answer('deny');
    assert.deepStrictEqual(await asked, { allowed: false, reason: 'denied' });
  });

  test('a directory that cannot be resolved gets no verdict but unresolved, and nobody is asked; once it resolves it is judged by its real path', async () => {
    // Judged by its spelling, ws/link/missing would pass for a directory inside the folder while
    // ws/link leads outside it (second review, reproduced with the gate as built).
    const missing = ['/w/proj/link/missing'];
    const t = setup({ folders: ['/w/proj'], realpath: (p) => (missing.includes(p) ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(p.replace('/w/proj/link', '/outside'))) });
    const unresolved = { allowed: false, reason: 'unresolved', error: 'ENOENT: /w/proj/link/missing' };
    assert.deepStrictEqual(await t.gate.permit('/w/proj/link/missing'), unresolved, 'with the error, for the message');
    assert.strictEqual(t.gate.current('/w/proj/link/missing'), undefined, 'no verdict is remembered');
    assert.deepStrictEqual(await t.gate.recheck('/w/proj/link/missing'), unresolved);
    assert.deepStrictEqual(await t.gate.askAgain('/w/proj/link/missing'), unresolved);
    assert.strictEqual(t.questions.length, 0);
    missing.length = 0; // the directory appears, at /outside/missing
    void t.gate.permit('/w/proj/link/missing');
    await questionsShown(t, 1);
    assert.strictEqual(t.questions[0].dir, '/outside/missing');
  });

  test('recheck reads the real path again: a directory replaced by a symbolic link after permit is judged by its target, without asking', async () => {
    const links: Record<string, string> = {};
    const t = setup({ folders: ['/w/proj'], realpath: (p) => Promise.resolve(links[p] ?? p) });
    assert.deepStrictEqual(await t.gate.permit('/w/proj/sub'), { allowed: true, basis: 'workspaceFolder' });
    // The real path it judged comes with the verdict: the pool starts the process there.
    links['/w/proj/sub'] = '/w/proj/real-sub';
    assert.deepStrictEqual(await t.gate.recheck('/w/proj/sub'), { allowed: true, basis: 'workspaceFolder', realDir: '/w/proj/real-sub' });
    links['/w/proj/sub'] = '/elsewhere';
    assert.strictEqual(await t.gate.recheck('/w/proj/sub'), undefined, 'the target would need a question');
    assert.strictEqual(t.gate.current('/w/proj/sub'), undefined);
    assert.strictEqual(t.questions.length, 0);
    const untrusted = setup({ trusted: false });
    assert.deepStrictEqual(await untrusted.gate.recheck('/w/proj'), { allowed: false, reason: 'restrictedMode' });
  });

  test('a question whose notification went to the notification centre: askAgain shows it again, and the first answer to any showing decides', async () => {
    const t = setup({});
    const verdict = t.gate.permit('/pkg');
    await questionsShown(t, 1);
    const again = t.gate.askAgain('/pkg');
    await questionsShown(t, 2);
    assert.deepStrictEqual(t.questions.map((q) => q.dir), ['/pkg', '/pkg']);
    // VS Code closes the older, equal notification when it adds the new one: that close does not count.
    t.questions[0].answer(undefined);
    await settle();
    assert.strictEqual(t.gate.asking('/pkg'), true);
    t.questions[1].answer('allow');
    assert.deepStrictEqual(await verdict, { allowed: true, basis: 'window' });
    assert.deepStrictEqual(await again, { allowed: true, basis: 'window' });
    t.questions[1].answer('deny'); // a late answer changes nothing
    await settle();
    assert.deepStrictEqual(t.gate.current('/pkg'), { allowed: true, basis: 'window' });

    // The newest showing closed without an answer: unanswered.
    const u = setup({});
    const closed = u.gate.permit('/pkg');
    await questionsShown(u, 1);
    void u.gate.askAgain('/pkg');
    await questionsShown(u, 2);
    u.questions[1].answer(undefined);
    assert.deepStrictEqual(await closed, { allowed: false, reason: 'unanswered' });
    // An answer on the older showing, still open in the notification centre, also decides.
    const o = setup({});
    const old = o.gate.permit('/pkg');
    await questionsShown(o, 1);
    void o.gate.askAgain('/pkg');
    await questionsShown(o, 2);
    o.questions[0].answer('deny');
    assert.deepStrictEqual(await old, { allowed: false, reason: 'denied' });
  });

  test('respond answers an open question from code (the test API); false when none is open', async () => {
    const t = setup({});
    assert.strictEqual(t.gate.respond('/pkg', 'allow'), false);
    const verdict = t.gate.permit('/pkg');
    await questionsShown(t, 1);
    assert.strictEqual(t.gate.respond('/pkg', 'deny'), true);
    assert.deepStrictEqual(await verdict, { allowed: false, reason: 'denied' });
  });

  test('a question that fails to show counts as closed', async () => {
    const gate = new ConsentGate({
      trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
      folders: () => [],
      onDidChangeFolders: new Emitter<void>().event,
      realpath: (p) => Promise.resolve(p),
      platform: 'linux',
      store: new MemoryStore(),
      ask: () => {
        throw new Error('no window');
      },
      log: quietLog,
    });
    assert.deepStrictEqual(await gate.permit('/pkg'), { allowed: false, reason: 'unanswered' });
  });

  test('onDidChange fires when a question opens and is answered, when trust is granted and after the folders changed', async () => {
    const t = setup({ folders: [] });
    const verdict = t.gate.permit('/w/proj');
    await questionsShown(t, 1);
    assert.strictEqual(t.changes(), 1);
    t.questions[0].answer('deny');
    await verdict;
    assert.strictEqual(t.changes(), 2);
    t.trustGranted.fire();
    assert.strictEqual(t.changes(), 3);
    // Adding the folder allows it; the event comes once the folders are read.
    t.folders.push('/w/proj');
    t.foldersChanged.fire();
    await settle();
    assert.strictEqual(t.changes(), 4);
    assert.deepStrictEqual(t.gate.current('/w/proj'), { allowed: true, basis: 'workspaceFolder' });
  });

  test('when the folders change twice quickly, the later list wins even if its read finishes first', async () => {
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
    const t = setup({
      folders: [],
      realpath: async (p) => {
        if (p === '/old') {
          await slow;
        }
        return p;
      },
    });
    await settle();
    t.folders.splice(0, t.folders.length, '/old');
    t.foldersChanged.fire();
    t.folders.splice(0, t.folders.length, '/new');
    t.foldersChanged.fire();
    await settle();
    releaseSlow();
    await settle();
    assert.deepStrictEqual(await t.gate.permit('/new/x'), { allowed: true, basis: 'workspaceFolder' });
    void t.gate.permit('/old/x');
    await questionsShown(t, 1);
  });

  test('with the real file system: a directory reached through a symbolic link is its target', async function () {
    if (process.platform === 'win32') {
      this.skip(); // creating symbolic links needs a privilege on Windows
    }
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-consent-'));
    try {
      const target = path.join(base, 'target');
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(base, 'link'));
      const store = new MemoryStore();
      store.folders = [fs.realpathSync.native(target)];
      const gate = new ConsentGate({
        trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
        folders: () => [],
        onDidChangeFolders: new Emitter<void>().event,
        realpath: (p) => fs.promises.realpath(p),
        platform: process.platform,
        store,
        ask: () => Promise.resolve(undefined),
        log: quietLog,
      });
      assert.deepStrictEqual(await gate.permit(path.join(base, 'link')), { allowed: true, basis: 'always' });
      gate.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
