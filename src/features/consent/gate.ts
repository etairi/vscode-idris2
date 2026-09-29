/**
 * The consent gate of IDE-mode sessions: `SessionGate` (`core/trust.ts`) as decided by the user on
 * 2026-09-27 (ROADMAP §9, "Decided by the user on 2026-09-27 (before M2)").
 *
 * Starting the compiler in a directory can execute code found there (the Homebrew `idris2`
 * loads `libc.dylib` by its leaf name and macOS `dlopen` searches the working directory; pack's
 * wrappers merge the `pack.toml` of every parent directory: docs/as-built/M1.md, *Processes*,
 * *Roots outside the workspace folders*), and workspace trust covers the workspace folders only.
 * So a session may start in a directory
 * - never in Restricted Mode (nobody is asked; the M1 rule);
 * - at once when the directory is a trusted workspace folder or lies inside one;
 * - otherwise once the user has allowed that directory: the question is asked once per
 *   directory and window, offering **Allow** (this window), **Always Allow for This Folder**
 *   (remembered in `ConsentStore`, i.e. the extension's global state, until revoked with
 *   **Idris 2: Manage Allowed Folders…**) and **Don't Allow** (this window). A question closed
 *   without an answer counts as not allowed and is not asked again by itself; `askAgain` (the
 *   status item's **Allow…**) asks again. The question is a warning notification with buttons,
 *   which VS Code does not keep on screen: after its timeout it goes to the notification centre,
 *   still waiting for an answer (only an error with actions is sticky, `get sticky()` in VS Code
 *   1.139.1's workbench bundle [src]). While it waits, the status item's link is **Allow…** too,
 *   and `askAgain` shows it again; the new notification replaces the hidden one (VS Code closes
 *   an equal notification when it adds one, `addNotification` [src]), and whichever showing is
 *   answered first decides — a showing closed because a newer one replaced it does not count.
 *
 * Directories are compared in a canonical form: the real path (`fs.promises.realpath`, which
 * resolves symbolic links and, on macOS, returns the case stored on disk, so `/tmp/x` and
 * `/private/tmp/X` on the default case-insensitive APFS are one directory [live, Node 24.13,
 * 2026-09-27]), with, on Windows, the drive letter lower-cased (VS Code spells it lower-case, the
 * file system upper-case). Nothing else is folded: the real path carries the case stored on disk
 * (`GetFinalPathNameByHandle`, which libuv's `realpath` calls [reasoned, not run on Windows,
 * ROADMAP E13]), and NTFS keeps names that differ only in case apart in a folder marked
 * case-sensitive (WSL creates such folders; `fsutil file setCaseSensitiveInfo`), so folding them
 * made a sibling `C:\src\REPO` of the workspace folder `C:\src\repo`, or a case variant of an
 * allowed folder, pass for it (M2 verification of the third review, simulated with `platform:
 * 'win32'`; before it, every ASCII letter was folded, and before the third review `toLowerCase`
 * also merged KELVIN SIGN with `k`). "Inside a folder" compares the keys as text (the folder's key
 * and a separator is a prefix of the directory's), not with `path.win32.relative`, which
 * lower-cases. A session directory that cannot be resolved (it does
 * not exist) gets no verdict but `unresolved` (with the error), and nobody is asked: judged by its spelling it
 * could pass for a directory inside a workspace folder while a symbolic link on its way leads
 * elsewhere (*second review*: `ws/link/missing`, with `ws/link` → `../outside`, was allowed as
 * `workspaceFolder`, and the verdict stayed cached after the directory appeared). A workspace
 * folder that cannot be resolved is compared as `path.resolve` spells it, without folding, so a
 * directory spelled otherwise is not inside it (and is asked about). "A directory" is that
 * directory only, not its subdirectories; "inside a workspace folder" is the folder or any
 * directory below it, both canonical. The remembered folders are stored as real paths.
 *
 * The pool asks `permit` before a spawn and, after its last wait (a toolchain scan), `recheck`,
 * which reads the real path again, so that a directory replaced by a symbolic link in between is
 * judged by its new target; the process is then started at once.
 *
 * **Decisions in several windows.** Every window's global state is one store: a write in one
 * window reaches the `Memento` of every other window without a reload, and also comes back to the
 * window that wrote it [src, VS Code 1.139.1: a window saves a change to the main process after
 * 100 ms (`DEFAULT_FLUSH_DELAY`), and the main process sends each change of a profile storage key
 * to every window, the writer included, after another 100 ms (`STORAGE_CHANGE_DEBOUNCE_TIME`,
 * `listen("onDidChangeStorage")` in `out/main.js`), with the value stored when it sends it; the
 * window takes it when it differs from its own copy (`acceptExternal`), `MainThreadStorage`
 * forwards every change of a watched key to the Extension Host, external ones included, and
 * `ExtensionMemento` replaces its whole value with it (workbench and extension-host bundles)].
 * `Memento` has no change event, so another window's decision applies here when a session next asks
 * (`permit`) or the status is drawn (`current`); a session already running here is not stopped by
 * a revocation elsewhere. Because a window's own writes come back late, a window that writes twice
 * in quick succession (**Always Allow**, then a revocation, within a few hundred milliseconds) reads
 * its first write again for a while after the second one has completed, until the second one's copy
 * arrives; a `permit` then would start the compiler without asking. (This may be what failed the
 * consent suite once, docs/as-built/M2.md, *Status* [open: not reproduced].) So the store keeps,
 * beside the folders allowed for good, when each folder was last decided (`ConsentRecord.decided`), and this window keeps its own decisions
 * with their times: a stored value that is older than this window's decision about a folder (or
 * has no time) is outdated there, and this window's decision holds; a newer one — another window's
 * later decision — holds here too. A write is the stored record with this window's newer decisions
 * applied, so it never brings back a folder another window revoked later. (*Third review* kept
 * this window's decisions for good and wrote all of them back, which ignored and then undid a
 * revocation in another window: M2 verification, two gates sharing one simulated store; VS Code not
 * run.) Two windows that decide within the time a write takes to reach the other can still
 * overwrite each other's record (the store holds one value); each keeps its own decision in its
 * window. Times are the computer's clock (`Date.now`), made later than every decision the window
 * has made or read about that folder.
 */
import * as path from 'path';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { Emitter, type Event } from '../../core/event';
import type { Log } from '../../core/log';
import type { GateVerdict, PermitReason, SessionGate, WorkspaceTrust } from '../../core/trust';

/** The internal command of the status item's **Allow…**: asks again about one directory. */
export const ALLOW_FOLDER_COMMAND = 'idris2.allowFolder';

/** The three answers of the question (`undefined`: closed without one). */
export type ConsentChoice = 'allow' | 'always' | 'deny';

/** What the store holds (module comment, *Decisions in several windows*). */
export interface ConsentRecord {
  /** The folders allowed for good, as real paths. */
  readonly folders: readonly string[];
  /**
   * When each folder (a real path) was last allowed for good or revoked, in ms since the epoch; a
   * folder decided before these times were kept has none.
   */
  readonly decided: Readonly<Record<string, number>>;
}

/** Where the folders allowed for good are kept (the extension's global state, shared by every window). */
export interface ConsentStore {
  get(): ConsentRecord;
  set(record: ConsentRecord): Promise<void>;
}

export interface ConsentGateDeps {
  readonly trust: WorkspaceTrust;
  /** Absolute paths of the workspace folders (`file:` folders only). */
  folders(): readonly string[];
  readonly onDidChangeFolders: Event<void>;
  /** `fs.promises.realpath`. */
  realpath(p: string): Promise<string>;
  /** `process.platform`: Windows paths are compared case-insensitively. */
  readonly platform: NodeJS.Platform;
  readonly store: ConsentStore;
  /**
   * Shows the question about `dir` (its real path) and why the compiler would start there;
   * resolves with the answer, or `undefined` when the notification was closed without one.
   */
  ask(dir: string, why: PermitReason | undefined): PromiseLike<ConsentChoice | undefined>;
  readonly log: Log;
  /** `Date.now`, for the times of the decisions. */
  now?(): number;
}

/** A directory in its two forms: the real path (for display and storage) and the comparison key. */
interface Canonical {
  readonly real: string;
  readonly key: string;
}

type WindowAnswer = 'allow' | 'deny' | 'unanswered';

/** A folder allowed for good (`always`) or revoked, and when. */
interface Decision {
  readonly real: string;
  readonly always: boolean;
  readonly at: number;
}

interface OpenQuestion {
  readonly dir: string;
  readonly verdict: Promise<GateVerdict>;
  /** Answers it from code, as if the user had chosen. */
  readonly respond: (choice: ConsentChoice | undefined) => void;
  /** Shows the notification again (see the module comment). */
  readonly show: () => void;
}

export class ConsentGate implements SessionGate, IDisposable {
  private readonly pathApi: path.PlatformPath;
  private readonly store = new DisposableStore();
  private readonly changed = new Emitter<void>();
  /** Canonical forms computed so far, by the spelling they were asked for. */
  private readonly canonicals = new Map<string, Canonical>();
  private folderKeys: readonly string[] = [];
  private folderGeneration = 0;
  private foldersReady: Promise<void>;
  /** This window's answers, by key. */
  private readonly answers = new Map<string, WindowAnswer>();
  /** Why a session would start in each directory, as `permit` was last told (for `askAgain`). */
  private readonly reasons = new Map<string, PermitReason>();
  /** The folders this window allowed for good (`always`) or revoked, by key, and when (module comment). */
  private readonly decided = new Map<string, Decision>();
  /** The time of this window's last decision: the next one is later. */
  private lastDecision = 0;
  /** The keys whose stored value was last seen outdated by this window's decision (logged once). */
  private readonly outdated = new Set<string>();
  private readonly questions = new Map<string, OpenQuestion>();
  private disposed = false;

  readonly onDidChange: Event<void> = this.changed.event;

  constructor(private readonly deps: ConsentGateDeps) {
    this.pathApi = deps.platform === 'win32' ? path.win32 : path.posix;
    this.store.add(this.changed);
    this.foldersReady = this.readFolders();
    this.store.add(
      deps.onDidChangeFolders(() => {
        this.foldersReady = this.readFolders().then(() => this.fire());
      }),
    );
    this.store.add(deps.trust.onDidGrant(() => this.fire()));
  }

  /** The comparison key of a real (or resolved) path: on Windows its drive letter lower-cased (module comment). */
  private keyOf(p: string): string {
    return this.deps.platform === 'win32' ? p.replace(/^[A-Z](?=:)/, (c) => c.toLowerCase()) : p;
  }

  /**
   * The canonical form of `dir` now, remembered for `current`; when it cannot be resolved, the
   * error's message (and the form is forgotten).
   */
  private async canonical(dir: string): Promise<Canonical | string> {
    let real: string;
    try {
      real = await this.deps.realpath(dir);
    } catch (error) {
      this.canonicals.delete(dir);
      return error instanceof Error ? error.message : String(error);
    }
    const canonical = { real, key: this.keyOf(real) };
    this.canonicals.set(dir, canonical);
    return canonical;
  }

  /** Reads the folders' canonical forms; a later read wins over an earlier one still running. */
  private async readFolders(): Promise<void> {
    const generation = ++this.folderGeneration;
    const keys = await Promise.all(
      this.deps.folders().map(async (folder) => this.keyOf(await this.deps.realpath(folder).catch(() => this.pathApi.resolve(folder)))),
    );
    if (generation === this.folderGeneration) {
      this.folderKeys = keys;
    }
  }

  /** Whether `key` is a workspace folder or lies below one (compared as text, module comment). */
  private insideFolder(key: string): boolean {
    const sep = this.pathApi.sep;
    return this.folderKeys.some((folder) => key === folder || key.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`));
  }

  /**
   * The store as this window reads it (module comment, *Decisions in several windows*): the stored
   * record, with this window's decisions applied where the store's are older or have no time.
   */
  private resolved(): { readonly folders: string[]; readonly decided: Record<string, number>; readonly outdated: ReadonlySet<string> } {
    const record = this.deps.store.get();
    const times = new Map<string, number>();
    for (const [folder, at] of Object.entries(record.decided)) {
      const key = this.keyOf(folder);
      times.set(key, Math.max(times.get(key) ?? at, at));
    }
    const outdated = new Set<string>();
    for (const [key, own] of this.decided) {
      const stored = times.get(key);
      if (stored === undefined || stored < own.at) {
        outdated.add(key);
      }
    }
    const folders = record.folders.filter((folder) => !outdated.has(this.keyOf(folder)));
    const decided: Record<string, number> = {};
    for (const [folder, at] of Object.entries(record.decided)) {
      if (!outdated.has(this.keyOf(folder))) {
        decided[folder] = at;
      }
    }
    for (const key of outdated) {
      const own = this.decided.get(key);
      if (own !== undefined) {
        decided[own.real] = own.at;
        if (own.always) {
          folders.push(own.real);
        }
      }
    }
    return { folders, decided, outdated };
  }

  /** Whether `key` is allowed for good: the store's answer, or this window's newer decision (module comment). */
  private remembered(key: string): boolean {
    const store = this.resolved();
    const own = this.decided.get(key);
    const stored = this.deps.store.get().folders.some((folder) => this.keyOf(folder) === key);
    if (own !== undefined && store.outdated.has(key) && stored !== own.always) {
      if (!this.outdated.has(key)) {
        this.outdated.add(key);
        this.deps.log.info(
          `Consent: the stored list of folders always allowed ${stored ? 'names' : 'lacks'} ${own.real} as it was before this ` +
            `window ${own.always ? 'allowed it for good' : 'revoked it'}; this window's later decision holds`,
        );
      }
    } else {
      this.outdated.delete(key);
    }
    return store.folders.some((folder) => this.keyOf(folder) === key);
  }

  /**
   * Records this window's decision about the folders, now, and writes the store with it (module
   * comment). The decision is later than every decision it saw: the clock, this window's last one
   * and the stored ones about these folders (another window's in the same millisecond included).
   */
  private async decide(folders: readonly string[], always: boolean): Promise<void> {
    const keys = new Set(folders.map((real) => this.keyOf(real)));
    const seen = Object.entries(this.deps.store.get().decided)
      .filter(([folder]) => keys.has(this.keyOf(folder)))
      .map(([, at]) => at + 1);
    const now = Math.max(this.deps.now?.() ?? Date.now(), this.lastDecision + 1, ...seen);
    this.lastDecision = now;
    for (const real of folders) {
      this.decided.set(this.keyOf(real), { real, always, at: now });
    }
    const { folders: allowed, decided } = this.resolved();
    await this.deps.store.set({ folders: allowed, decided });
  }

  /** The verdict for `canonical` without asking; `undefined` when nobody was asked. */
  private verdictOf(canonical: Canonical): GateVerdict | undefined {
    if (!this.deps.trust.isTrusted) {
      return { allowed: false, reason: 'restrictedMode' };
    }
    if (this.insideFolder(canonical.key)) {
      return { allowed: true, basis: 'workspaceFolder' };
    }
    if (this.remembered(canonical.key)) {
      return { allowed: true, basis: 'always' };
    }
    switch (this.answers.get(canonical.key)) {
      case 'allow':
        return { allowed: true, basis: 'window' };
      case 'deny':
        return { allowed: false, reason: 'denied' };
      case 'unanswered':
        return { allowed: false, reason: 'unanswered' };
      case undefined:
        return undefined;
    }
  }

  async permit(dir: string, why?: PermitReason): Promise<GateVerdict> {
    if (!this.deps.trust.isTrusted) {
      return { allowed: false, reason: 'restrictedMode' };
    }
    const canonical = await this.canonical(dir);
    if (typeof canonical === 'string') {
      return { allowed: false, reason: 'unresolved', error: canonical };
    }
    if (why !== undefined) {
      this.reasons.set(canonical.key, why);
    }
    await this.foldersReady;
    return this.verdictOf(canonical) ?? this.question(canonical, why).verdict;
  }

  current(dir: string): GateVerdict | undefined {
    if (!this.deps.trust.isTrusted) {
      return { allowed: false, reason: 'restrictedMode' };
    }
    const canonical = this.canonicals.get(dir);
    return canonical === undefined ? undefined : this.verdictOf(canonical);
  }

  async recheck(dir: string): Promise<GateVerdict | undefined> {
    if (!this.deps.trust.isTrusted) {
      return { allowed: false, reason: 'restrictedMode' };
    }
    const canonical = await this.canonical(dir);
    if (typeof canonical === 'string') {
      return { allowed: false, reason: 'unresolved', error: canonical };
    }
    await this.foldersReady;
    const verdict = this.questions.has(canonical.key) ? undefined : this.verdictOf(canonical);
    return verdict?.allowed === true ? { ...verdict, realDir: canonical.real } : verdict;
  }

  /** Whether the question about `dir` is open now. */
  asking(dir: string): boolean {
    const canonical = this.canonicals.get(dir);
    return canonical !== undefined && this.questions.has(canonical.key);
  }

  /** The real paths of the directories whose question is open. */
  openQuestions(): readonly string[] {
    return [...this.questions.values()].map((q) => q.dir);
  }

  /**
   * Answers the open question about `dir` (a spelling `permit` was given, or its real path) as if
   * the user had chosen `choice`; false when no question about it is open.
   */
  respond(dir: string, choice: ConsentChoice | undefined): boolean {
    const key = this.canonicals.get(dir)?.key ?? this.keyOf(dir);
    const question = this.questions.get(key);
    question?.respond(choice);
    return question !== undefined;
  }

  /**
   * Forgets this window's answer about `dir` and asks again (the status item's **Allow…**), or
   * shows the open question about it again; the verdict when the directory needs no question.
   */
  async askAgain(dir: string): Promise<GateVerdict> {
    if (!this.deps.trust.isTrusted) {
      return { allowed: false, reason: 'restrictedMode' };
    }
    const canonical = await this.canonical(dir);
    if (typeof canonical === 'string') {
      return { allowed: false, reason: 'unresolved', error: canonical };
    }
    await this.foldersReady;
    const open = this.questions.get(canonical.key);
    if (open !== undefined) {
      this.deps.log.info(`Consent: asking again whether the compiler may run in ${canonical.real}`);
      open.show();
      return open.verdict;
    }
    this.answers.delete(canonical.key);
    return this.verdictOf(canonical) ?? this.question(canonical, this.reasons.get(canonical.key)).verdict;
  }

  /** The folders allowed for good, as real paths: the stored ones, with this window's newer decisions applied. */
  allowedFolders(): readonly string[] {
    return this.resolved().folders;
  }

  /**
   * Forgets `folders` (real paths from `allowedFolders`) and this window's answers about them, so
   * that their sessions stop and the next one asks again.
   */
  async revoke(folders: readonly string[]): Promise<void> {
    const keys = new Set(folders.map((f) => this.keyOf(f)));
    // The decision is recorded, and this window's answers forgotten, before the store's write
    // completes (*M2 second verification of the third review*: until it had, a folder this window
    // had answered Allow for still read as allowed, and a start meanwhile went ahead). A failed
    // write rejects, but this window keeps the revocation.
    const written = this.decide(folders, false);
    for (const key of keys) {
      this.answers.delete(key);
    }
    this.deps.log.info(`Consent: revoked ${folders.join(', ')}`);
    this.fire();
    await written;
  }

  private question(canonical: Canonical, why: PermitReason | undefined): OpenQuestion {
    const open = this.questions.get(canonical.key);
    if (open !== undefined) {
      return open;
    }
    // The first answer decides; `respond` answers from code, a showing from the user.
    let respond: (choice: ConsentChoice | undefined) => void = () => undefined;
    const answered = new Promise<ConsentChoice | undefined>((resolve) => (respond = resolve));
    let showings = 0;
    const show = (): void => {
      const showing = ++showings;
      Promise.resolve()
        .then(() => this.deps.ask(canonical.real, why))
        .then(
          (choice) => {
            // Closed without an answer counts only for the newest showing: an older one is closed
            // by VS Code when the newer, equal notification replaces it.
            if (choice !== undefined || showing === showings) {
              respond(choice);
            }
          },
          (error: unknown) => {
            this.deps.log.warn(`Consent: the question about ${canonical.real} failed: ${String(error)}`);
            if (showing === showings) {
              respond(undefined);
            }
          },
        );
    };
    const verdict = answered.then((choice) => this.record(canonical, choice));
    show();
    const question = { dir: canonical.real, verdict, respond, show };
    this.questions.set(canonical.key, question);
    this.deps.log.info(`Consent: asking whether the compiler may run in ${canonical.real}`);
    this.fire();
    return question;
  }

  private async record(canonical: Canonical, choice: ConsentChoice | undefined): Promise<GateVerdict> {
    this.questions.delete(canonical.key);
    let verdict: GateVerdict;
    switch (choice) {
      case 'allow':
        this.answers.set(canonical.key, 'allow');
        verdict = { allowed: true, basis: 'window' };
        break;
      case 'always':
        await this.decide([canonical.real], true);
        verdict = { allowed: true, basis: 'always' };
        break;
      case 'deny':
        this.answers.set(canonical.key, 'deny');
        verdict = { allowed: false, reason: 'denied' };
        break;
      case undefined:
        this.answers.set(canonical.key, 'unanswered');
        verdict = { allowed: false, reason: 'unanswered' };
        break;
    }
    this.deps.log.info(`Consent: ${canonical.real}: ${choice ?? 'closed without an answer'}`);
    this.fire();
    return verdict;
  }

  private fire(): void {
    if (!this.disposed) {
      this.changed.fire();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.store.dispose();
  }
}
