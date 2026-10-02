/**
 * The IDE-mode backend (`backend/ide/backend.ts`, docs/ARCHITECTURE.md §3.1, §5; ROADMAP M2):
 * `IdeBackend implements IdrisBackend` over the `SessionPool`, and `IdeMode`, the registry's
 * provider for every root and the control surface of the backend commands (Stop, Restart, Send
 * Raw Protocol Request, crash notices) and of the checks (a root's last document closed; a
 * root's session serving again after an automatic restart, `onDidRestart`; the active document's
 * root, which `idris2.ideMode.maxSessions` never stops).
 *
 * M2 implements `load` (`caps.diagnostics`); M3 the queries, the token index and evaluation;
 * M4 `holes` and `edit` (below).
 *
 * **Queries** (M3; `IdrisBackend`, *Queries*, in `backend/types.ts`). `typeAt`, `docsFor`,
 * `definition`, `completions` and `browseNamespace` ask the root's `check` session, in the context
 * of the file it loaded last: the backend notes, for every `:load-file` it sends, which document it
 * is for (`LoadRecord`, keyed by the session's `LoadedFile`), and a query whose document is not the
 * one the session's `loadedFile` records — another file, a raw request, no process — rejects with
 * `NotLoaded` at once, sending and starting nothing; one that is sends its request with a
 * `beforeSend` check that it still is (a load queued before it may change it) — for `typeAt`,
 * `docsFor` and `definition`, that the same load is (an urgent reload may pass it, `ask`). A query never
 * loads. `typeAt` and `docsFor` answers, and `definition`'s `:name-at` answers and target files,
 * are cached per load (a new `LoadRecord`) and request, and the three wait for a reload of the
 * document's file that is being made (`loadedCheckSession`).
 * The first `:repl-completions` after every load took 113–423 ms on `contrib`, the later ones
 * about 1–3 ms (docs/measurements/first-load.md, which sent one prefix per module). On
 * `broken/Clean.idr` the first after each load took 171–209 ms whatever its prefix — one that
 * matches no name (`zq`: 183 ms) included —, every later one 1.3–3.4 ms whatever prefix it had,
 * and a `:type-of` in between warmed nothing [live, 2026-09-29, one `timeout 120 idris2
 * --ide-mode` session on a copy of `broken/Clean.idr`, five loads, six prefixes]; so
 * `IdeMode.warmUpCompletions` sends one such request after a load, for a completion provider to
 * call before the user needs it — once the session has had nothing to do for `WARM_UP_QUIET_MS`,
 * so that it is not put before a query that waits for the load (third review of M3: sent at once,
 * it went before the hover, Type at Cursor, Go to Definition or first inlay hint whose load had
 * just been answered, and before a hover waiting for the check after a save, delaying each by the
 * slow first completion, 0.1–0.4 s [unit-level, the reviewer's probes]).
 *
 * **Token index** (M3, `highlight.ts`): built from the frames of each answered `check` load of a
 * document, kept per document — while the document is open, and for at most `MAX_INDEXES` others,
 * those used last; until its root is released — and announced by `IdeMode.onDidLoad` (once per reply, also for merged loads, with
 * whether the load may have changed the root's answers, `LoadedDocument.rebuilt`). The loaded file
 * and the files its diagnostics name are read from disk when the reply arrives, for the bird-track
 * offset (F11) and the code-point columns (E14) of `core/positions.ts`; the loaded file is read
 * right before the load is written too, and the index keeps its text only when both reads agree
 * (`TokenIndex.text`).
 *
 * **Evaluation** (M3, ROADMAP §9 2026-09-28): `evaluate` refuses, before anything else, text the
 * REPL parser could read as a command (`replCommand.ts`); then, one evaluation at a time per
 * `eval` session, it loads the document's file there (the same package walk and checks right
 * before the write as a `check` load; its diagnostics are not shown) and sends `(:interpret
 * "EXPR")`, queued right behind the load (`interpretIn`), with a `beforeSend` check that that load
 * answered and is still the session's. **The file is loaded before every evaluation**, also when
 * the session loaded it last: the compiler keeps what a load read — the file and the modules it
 * imports — in memory, and an imported module saved since (in another editor, by a `git checkout`)
 * would otherwise be evaluated as it was, while `:load-file` rebuilds whatever changed on disk. A
 * load of an unchanged file took 0.08–0.24 s on `contrib` modules, up to 0.40 s
 * (docs/measurements/first-load.md [live]). The `:interpret` has its own time limit,
 * `idris2.eval.timeout`, and a cancellation stops the `eval` session: an evaluation that does not
 * end grows the compiler's memory fast [live, *review of M3*: `loop 0` of `loop n = loop (S n)`
 * went from 265 to 1,576 MiB in 7.0 s]; the session does not start again by itself (`session.ts`).
 * One that ends keeps the memory it made the process take, so after an evaluation whose
 * `:interpret` took longer than `EVAL_RELEASE_AFTER_MS` the `eval` session is stopped
 * (`SessionPool.releaseEvaluation`) and starts again at the next evaluation (second review of M3).
 *
 * **The path in `:load-file`.** The compiler accepts an absolute path only when it lies,
 * as text, below its working directory and source directory (`corePathToNS`, `mbPathToNS`,
 * `src/Core/Directory.idr` 224–245 on v0.8.0 [src]), and its working directory is `getcwd()`
 * (`setWorkingDir`, `src/Core/Context.idr` 2188–2193 [src]), which on POSIX is the physical path:
 * started in a directory spelled through a symbolic link, the compiler refused the file's path
 * through the link (`Source file … is not in the source directory …`) and loaded its real path
 * [live, load-symlink]. So the path sent is the real path of the session directory joined with
 * the file's path relative to it — on POSIX; on Windows the file's path as it is, because how
 * the compiler sees its working directory there was not tried [open]. A file's path relative to
 * the session directory never climbs out of it: the directory is the file's own (loose) or that
 * of the `.ipkg` found above it (`project/index.ts`).
 *
 * **The package, as the compiler finds it.** At every `:load-file` the compiler walks up from its
 * current working directory — the physical path — to the first directory with an `.ipkg`,
 * changes into it and applies that package's `builddir`, `opts` and `depends` (`findIpkg`, F13;
 * `IDEMode/REPL.idr` 145, `Idris/Package.idr` 1089–1110, `Core/Directory.idr` 333–349 on v0.8.0
 * [src]); a loose session given a parent `evil.ipkg` wrote its TTCs to that package's `builddir`
 * [live, M2 second review]. The move is sticky: a project session whose `.ipkg` was renamed moved
 * to the parent package's folder at its next load, and stayed there after the `.ipkg` came back,
 * so that every later load failed (`Module name A does not match file name`) [live, M2 third review,
 * 2026-09-28, one `timeout 60 idris2 --ide-mode` session, `:cwd` after each load]. The project index
 * walks the logical path and watches only the workspace folders (and those with a debounce), so
 * its classification can be stale: a package file created, renamed or deleted outside the
 * workspace folders, or one above the physical directory of a folder reached through a symbolic
 * link. The directory the compiler would move to was never put to the consent gate. So before
 * each load the walk is done again from the session directory's real path (`findPackage`), and
 * the load is sent only when it finds nothing for a loose file, and the root's own `.ipkg` in the
 * session directory for a project (compared by path: the same directory, the same name). Otherwise
 * nothing is sent: the load fails (`LoadFailed`) with a message that says what to do, and the
 * root's sessions are stopped (`SessionPool.packageChanged`), since a compiler that has moved
 * already would not walk from the session directory again. The walk is done when the load is
 * queued (so that nothing is started, and no question asked, for a load that would be refused)
 * and again when it is the next to be sent to a process that has answered the handshake
 * (`RequestOptions.beforeSend`), with the checks of the directory below; only microtasks separate
 * that walk from the write. Each walk has the load's time limit, `idris2.ideMode.longActionTimeout`
 * (`withinLimit`; the session's own for the second): one that has not settled by then fails the
 * load with `LoadFailed`, nothing sent. The classification that comes before the first walk
 * (`ProjectIndex.classify`, cached per directory) has no limit of its own [reasoned from the code]. (*M2 second verification of the third review*: the walk was done only
 * when the load was queued, and a first load then waited for the toolchain scan, the consent
 * question — open for as long as the user leaves it — and the start, so a package file created
 * in a parent meanwhile, e.g. in `/tmp`, was adopted at that load [unit-level].) The compiler walks from its own working
 * directory, which follows the directory, not its path (`getcwd`): a session directory moved or
 * replaced while its compiler runs would make the walk start elsewhere than the compiler's. So when
 * a process starts, `IdeMode` notes the identity of its directory (`directoryId`: device and inode),
 * and before each load the directory now at the session's path must be the same one; a directory
 * whose real path cannot be read (it was moved away or deleted) or whose identity changed fails the
 * load the same way, loose sessions included (*M2 verification of the third review*: before, a
 * loose session whose directory could not be resolved was sent the load, and loose sessions were
 * never stopped); so does a session directory whose real path is not the one the load's path was
 * built from. A package file created, removed or renamed between that walk and the compiler's
 * (while the compiler reads the load, or before a later one), and a directory replaced in the
 * few milliseconds between a process's start and the reading of its identity, are not caught: a
 * compiler that has moved that way works from the other package's folder, with its `builddir`,
 * `opts` and `depends` — a loose file is then checked as part of that package, a project's loads
 * may fail with a module-name mismatch — until a later walk finds a change and stops it, or the
 * session is restarted.
 *
 * **Holes** (M4, `holes.ts`). When a `check` load is answered, its reply hook
 * (`RequestOptions.onReply`) asks `(:metavariables 80)`, and that reply's hook `(:name-at "NAME")`
 * for each unqualified name that may be a hole's (at most `MAX_LOCATED_NAMES`, the loaded file's
 * first), all `urgent`, so that they are sent before a load that was waiting, which would change the
 * compiler's context (UX review of M4: in a batch of visible documents the holes of all but the
 * last were refused), and all `longAction`s: on large types they take seconds (`listHoles`). When
 * they take longer than `idris2.ideMode.longActionTimeout` (the process restarts), they are not asked
 * after a load of the same text of the file again, nor for `HolesOptions.kept` (`slowHoles`), until a
 * listing of it succeeds (List Holes asks, with Cancel: `HolesOptions.token` restarts the session
 * while the listing runs, `untilCancelled`). The answer is kept per load; `holes` returns the one of the session's last
 * load of the document's file, also after another file was loaded, and asks again only while that
 * file is the one loaded last (`NotLoaded` when neither holds). An urgent load already waiting when
 * the reply arrives (`maxBackgroundChecks`) still goes first; that load's holes are then known at
 * its file's next load. A hole's range is converted
 * with the text its file had: the loaded file's as the load read it (`LoadRecord.textBefore`), another
 * file's as read from disk (kept per load, as for `definition`, and off when that file changed on
 * disk since the compiler built it).
 *
 * **Edits** (M4, `edits.ts`). `edit` is answered like a query and never loads. A request that names
 * a place is sent only while the session's last load is of the document's file and read exactly the
 * lines the document shows at `EditRequest.version` — the text read right before the load was
 * written and again when its reply arrived, both the same (`LoadRecord.loadedText`) — since the
 * compiler edits the text it loaded; otherwise it rejects with `NotLoaded`, having sent nothing.
 * `edits.ts` plans the request and its replacement ranges from those lines; its refusals, and names
 * that are not Idris names, are `Unsupported`, sent nothing. Right before the write the load must
 * still be the session's last, and for `:case-split`, which reads its line from the file on disk when
 * it is asked, the file must still hold that text. The requests that find a hole by its name in the
 * compiler's whole context (`EditPlan.hole`: Intro, Refine Hole, Proof Search, Make Lemma) are sent
 * only when that load's holes hold one hole of the name, at the cursor (`holeRefusal`). Proof
 * Search, Generate Definition (and their `-Next`), Refine Hole, Intro, Make Lemma and Add Missing
 * Cases run under `idris2.ideMode.longActionTimeout` (`EditPlan.long`); a cancellation before the write drops the
 * request, one after it restarts the root's `check` session only (`restartCheck`: the protocol has
 * no cancel). That costs the loaded file, the answers kept per load and the running search: the
 * queries waiting in the session are refused before their write (`NotLoaded`) and asked again after
 * a load, and the file is loaded again, in a new process on the build directory the old one left,
 * which took
 * 0.22–0.31 s to start and 0.10–0.24 s to load on `contrib` modules (docs/measurements/first-load.md,
 * *Headline numbers* [live]).
 *
 * **Searches** (`-Next`). The compiler keeps one proof search and one definition search per process
 * (`psResult`, `gdResult`, `Idris/REPL/Opts.idr` [src]); a load resets both (`resetProofState`,
 * `Idris/REPL.idr` 833–845 [src]), a new one of the same kind replaces it. So a `-Next` is sent only
 * while the search it continues is the session's: started by this backend for the same document,
 * answered, and not followed by a load (the load record changed), a search of its kind or a raw
 * request (`SearchState`), nor by a restart of the process; otherwise it is refused with
 * `Unsupported`, sending nothing, so that no next result of a stale search is applied. Queries and
 * the other edits in between do not touch the search [src] and are allowed.
 *
 * Only type imports from `vscode`: the diagnostic objects are built with the `api` passed in, so
 * the module is unit-tested on Node.
 */
import { createHash } from 'crypto';
import * as path from 'path';
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { cancelled, errorText, IdrisException, unsupported } from '../../core/errors';
import { Emitter, type Event } from '../../core/event';
import type { Config } from '../../core/config';
import { holeTokenNames } from '../../core/idrisSyntax';
import {
  editorLines,
  fromIdeReplySpan,
  textMap,
  toIdeTypeOfRequest,
  toIdeTypeOfRequestPastStart,
  type EditorPosition,
  type EditorRange,
  type IdeRequestPoint,
  type PositionDocument,
  type TextMap,
} from '../../core/positions';
import type { SessionGate } from '../../core/trust';
import { editorLabel } from '../../core/untrustedText';
import { compilerReading, compilerReadsPathAsGiven, packageOptionWords } from '../../project/ipkg';
import type { Classification, ProjectIndex } from '../../project/types';
import { NO_CAPABILITIES } from '../null';
import { rootKey, type BackendProvider, type BackendState } from '../registry';
import type {
  BackendKind,
  Capabilities,
  Decor,
  EditRequest,
  EditResult,
  Evaluation,
  Hole,
  HolesOptions,
  IdrisBackend,
  LoadOptions,
  LoadResult,
  NamespaceEntry,
  NextRequest,
  RichText,
  TokenIndex,
  TypeInfo,
} from '../types';
import { loadDiagnostics, type DiagnosticRecord, type LoadDiagnostics } from './diagnostics';
import { editText, holeRefusal, nameProblem, planEdit, planNext, type EditPlan } from './edits';
import { tokenIndexOf } from './highlight';
import { holeEntries, holesOf, namesToLocate } from './holes';
import {
  browseNamespace,
  decodeBuildingLine,
  decodeCompletions,
  decodeMetavariables,
  decodeNameAt,
  decodeText,
  docsFor,
  interpret,
  loadFile,
  metavariables,
  nameAt,
  replCompletions,
  toRichText,
  typeOf,
  type Metavariable,
  type NameLocation,
} from './protocol';
import { replCommandRefusal } from './replCommand';
import { duration, type Clock } from './session';
import type { IdeCommand, IdeSession, LoadedFile, LookupRequestOptions, Reply, SessionLaunch, SessionPool, SessionStateChange } from './types';

/** IDE mode since M4: diagnostics (M2), the read-only intelligence of ROADMAP M3, the holes and edits of M4. */
export const IDE_MODE_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  ...NO_CAPABILITIES,
  diagnostics: true,
  hover: true,
  definition: true,
  completion: true,
  semanticTokens: true,
  documentSymbols: true,
  documentHighlights: true,
  holes: true,
  holeLocations: true,
  editing: true,
  editingNext: true,
  intro: true,
  refine: true,
  missingCases: true,
  docs: true,
  evaluate: true,
  browseNamespace: true,
});

/** The `vscode` constructors the backend needs to build diagnostics. */
export type DiagnosticsApi = Pick<
  typeof vscode,
  'Uri' | 'Range' | 'Position' | 'Diagnostic' | 'DiagnosticSeverity' | 'DiagnosticRelatedInformation' | 'Location'
>;

export interface IdeModeDeps {
  readonly pool: SessionPool;
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd'>;
  /**
   * `diagnostics`; `ideMode().longActionTimeoutMs`, the limit of the walk made when a load is queued;
   * `evaluation().timeoutMs`, the limit of an `:interpret` (`idris2.eval.timeout`).
   */
  readonly config: Pick<Config, 'diagnostics' | 'ideMode' | 'evaluation'>;
  /** The timers of that limit, and the time an evaluation took (`systemClock` in the extension). */
  readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout' | 'now'>;
  readonly gate: Pick<SessionGate, 'current' | 'onDidChange'>;
  readonly api: DiagnosticsApi;
  /**
   * Reads a source file as UTF-8 (`toolchain/fileSystem.ts` `readSourceFile`: a regular file of at
   * most `MAX_SOURCE_FILE_BYTES`, anything else rejected unopened — a path in a reply may name a
   * FIFO or a device): the text the compiler read, for the bird-track offset (F11) and the
   * code-point columns (E14) of the ranges in its replies. Callers treat a rejection as a file that
   * cannot be read.
   */
  readFile(p: string): Promise<string>;
  /** `fs.promises.realpath`. */
  realpath(p: string): Promise<string>;
  /**
   * The package file the compiler's walk finds at or above `dir` (`project/ipkg.ts` `findIpkg`:
   * the first `.ipkg` in listing order of the nearest directory that has one), else `undefined`.
   */
  findPackage(dir: string): Promise<string | undefined>;
  /**
   * What tells the directory at `p` (following symbolic links) apart from another one put in its
   * place: its device and inode numbers (`fs.promises.stat(p, { bigint: true })`); rejects when
   * there is none.
   */
  directoryId(p: string): Promise<string>;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /**
   * Whether a document of the file `fileName` is open in this window (`vscode.workspace.textDocuments`):
   * such a file's token index is never evicted (`MAX_INDEXES`).
   */
  isOpen(fileName: string): boolean;
  /**
   * The text of the document of the file `fileName` open in this window (`file` scheme), or
   * `undefined` when none is: Go to Definition moves a target range read from the file on disk to
   * the text its editor shows (`IdeBackend.definition`), since VS Code applies a location to the open
   * document.
   */
  openText(fileName: string): string | undefined;
}

/**
 * The text the compiler read, as `core/positions.ts` reads a document: without a byte order mark
 * at its start, which the compiler drops before it unlits and lexes the file — in a `.lidr` whose
 * line 0 is `> ` behind a byte order mark, `module` on line 1 was highlighted on compiler line 2, so
 * line 0 was read as a line of a marker and white space only (F11) [live, idris2 0.8.0, fourth
 * review of M3] — and VS Code does not show (`occurrence.ts` `indexDescribes`). Until that review
 * it was kept, so a bird-track line 0 read as prose and every reply position below it was shifted.
 */
function textDocument(fileName: string, text: string | undefined): PositionDocument {
  const lines = text === undefined ? [] : text.replace(/^\uFEFF/, '').split('\n');
  return {
    languageId: '',
    fileName,
    isUntitled: false,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
  };
}

/** Moves a range of a file's text, `range` of the lines `before`, to the lines `after` (`shownRange`). */
type RangeMove = (range: EditorRange) => EditorRange | undefined;

/**
 * `RangeMove` by `map`, from a text a load read to a document's text (`core/positions.ts`
 * `textMap`): the range's start and end in the document's text, with its end at its start when the
 * end is on a line changed since, or `undefined` when its start is.
 */
function moveBy(map: TextMap): RangeMove {
  return (range) => {
    const start = map.toShown(range.start);
    return start === undefined ? undefined : { start, end: map.toShown(range.end) ?? start };
  };
}

/** A `\r` that is not the start of a `\r\n`. */
const LONE_CR = /\r(?!\n)/;

/**
 * How a range of a file, converted with `read` (the file as read from disk), is moved to `shown`, the
 * text of the file's open document (`IdeBackend.definition`), or, when none is open, to `read` as VS
 * Code will show it: `undefined` when the lines are the same (the range stays); otherwise `moveBy`
 * (`core/positions.ts` `textMap`, exact where the two differ only in their line breaks, in a file that
 * is not literate: *Literate lines* there). A file that
 * is not open has other lines in VS Code only after a lone `\r`, where its editor breaks a line and
 * the compiler does not (`core/positions.ts` `editorLines`): until the sixth review of M3 the range
 * stayed, and F12 landed one line too high there [unit-level, the verifier's probe; the compiler's
 * `\n`-only lines live, idris2 0.8.0]; until the seventh, a definition starting on the line holding
 * the `\r` was refused as changed, also in a file not open [unit-level, the verifier's probe].
 */
function shownRange(read: string, shown: string | undefined): RangeMove | undefined {
  const text = read.replace(/^\uFEFF/, '');
  if (!LONE_CR.test(text) && (shown === undefined || shown === text)) {
    return undefined;
  }
  return moveBy(textMap(text, shown ?? text));
}

/**
 * Why a load is not sent (`IdeBackend.loadRefusal`): the error it fails with (`LoadFailed`), and
 * the detail the root's sessions are stopped with (`SessionPool.packageChanged`).
 */
interface LoadRefusal {
  readonly detail: string;
  readonly error: IdrisException;
}

function refusal(detail: string, message: string): LoadRefusal {
  return { detail, error: new IdrisException({ kind: 'LoadFailed', message }) };
}

/** A process ended unexpectedly, or the pool gave up on one (for the crash notices). */
export interface BackendFailure {
  readonly root: Classification;
  /** false: it is being restarted; true: given up until restarted. */
  readonly gaveUp: boolean;
  readonly detail: string;
  /**
   * A crash of a root whose session has not answered a request since its previous crash (a file
   * that crashes the compiler at every load): the commands show no second notice for it.
   */
  readonly repeated: boolean;
}

/**
 * A root's `check` session serves again after an automatic restart (`IdeMode.onDidRestart`):
 * `reconfigure` — its command line changed (a setting, a toolchain scan, the package), so what
 * the documents show came from the old one; `crash` — it ended unexpectedly (an exit or a
 * protocol error; not a time-out, whose request would only time out again) and the request in
 * flight was lost.
 */
export interface BackendRestart {
  readonly root: Classification;
  readonly cause: 'reconfigure' | 'crash';
}

/** An answered `:load-file` of a `check` session (`IdeMode.onDidLoad`). */
export interface LoadedDocument {
  readonly root: Classification;
  /** The loaded document's `fileName`. */
  readonly file: string;
  /**
   * The load may have changed what the compiler answers about any file of the root: it built a
   * module (a `Building` line: the file or a module it imports changed on disk), it failed, it is
   * the first load answered by this process (a load cut off earlier, by a time-out or a stop, may
   * have built modules without an answer), or the file read another text right before it than
   * before this process's last announced load of it (`LoadRecord.textBefore`). A load that built
   * nothing reloaded the same build files, so what was answered before it still holds (F7; *review
   * of M3*) — unless another process had built the file's new text into a build directory it shares
   * with this one (the `eval` session, the user's own build: D5, where the package or `extraArgs`
   * choose the directory): then the load builds nothing and the answers change, and until the
   * seventh review of M3 a hover at a position not asked since answered from the text before
   * [unit-level, the verifier's probe; that such a load builds nothing is from D5 and the code, not
   * run].
   */
  readonly rebuilt: boolean;
  /**
   * The load returned an error: in the file (the compiler still answers about the declarations
   * before it), or in a module the file imports (it then answers about none of the file's names:
   * `(:type-of "xs" 6 5)` answered `Undefined name xs` [live, fifth review of M3]). A failed load is
   * also `rebuilt`.
   */
  readonly failed: boolean;
}

/**
 * The causes of a crash (the session restarts) as `SessionStateChange` reports them: not
 * `longActionTimeout`, a long request that ran past its limit — an edit, which its command reports
 * (`onDidFail` would add a second warning, "stopped unexpectedly", for a limit the user waited on),
 * or the holes of a load, which the Holes view logs (`features/holes/model.ts`).
 */
const CRASH_CAUSES = new Set(['exit', 'timeout', 'protocolError']);

/**
 * The provider of every root (`BackendRegistry.setProvider`) and the control surface of the
 * backend commands. One `IdeBackend` serves all roots: `load` classifies its document and asks
 * the pool for the root's `check` session.
 */
export class IdeMode implements BackendProvider, IDisposable {
  readonly kind: BackendKind = 'ideMode';
  private readonly backend: IdeBackend;
  private readonly store = new DisposableStore();
  private readonly stateChanged = this.store.add(new Emitter<void>());
  private readonly failed = this.store.add(new Emitter<BackendFailure>());
  private readonly restarted = this.store.add(new Emitter<BackendRestart>());
  private readonly loaded = this.store.add(new Emitter<LoadedDocument>());
  private readonly released = this.store.add(new Emitter<Classification>());
  /** The last state change of each root's `check` session, by `rootKey`. */
  private readonly lastChange = new Map<string, SessionStateChange>();
  /** Why a root's `check` session is being restarted, until its next handshake (`onDidRestart`). */
  private readonly pendingRestarts = new Map<string, BackendRestart['cause']>();
  /** The roots whose `check` session crashed and has not answered a request since (`BackendFailure.repeated`). */
  private readonly crashedSinceReply = new Set<string>();

  readonly onDidChangeState: Event<void> = this.stateChanged.event;
  /** A `check` session crashed (and is being restarted) or was given up. */
  readonly onDidFail: Event<BackendFailure> = this.failed.event;
  /**
   * A root's `check` session serves again after an automatic restart (`BackendRestart`): when
   * the new process has sent its handshake, or at once when a `failed` session was returned to
   * `stopped` because its command line changed. Restart Backend (`restart`) is not reported: the
   * command checks the visible documents itself.
   */
  readonly onDidRestart: Event<BackendRestart> = this.restarted.event;
  /**
   * A `:load-file` of a `check` session was answered, whatever its outcome, and the token index of
   * `file` (the loaded document's `fileName`) was updated, or kept when the load sent no
   * highlighting (`features/intelligence/types.ts` `LoadNotifications`). Once per reply: callers
   * whose loads were merged share it. Loads of the `eval` session are not reported.
   */
  readonly onDidLoad: Event<LoadedDocument> = this.loaded.event;
  /** A root was released (`release`): what its loads answered no longer describes an open file. */
  readonly onDidRelease: Event<Classification> = this.released.event;

  constructor(private readonly deps: IdeModeDeps) {
    this.backend = new IdeBackend(deps, (loaded) => this.loaded.fire(loaded));
    this.store.add(
      deps.pool.onDidChange(({ session, change }) => {
        // Every role's process: the loads of both check the directory it was started in.
        if (change.state === 'starting' && session.launch !== undefined) {
          this.backend.started(session.launch);
        }
        if (session.role !== 'check') {
          return;
        }
        this.backend.sessionChanged(session);
        const key = rootKey(session.root);
        this.lastChange.set(key, change);
        this.noteRestart(session.root, change);
        if (change.state === 'failed') {
          this.crashedSinceReply.delete(key);
          this.failed.fire({ root: session.root, gaveUp: true, detail: change.detail ?? change.cause, repeated: false });
        } else if (change.state === 'restarting' && CRASH_CAUSES.has(change.cause)) {
          const repeated = this.crashedSinceReply.has(key);
          this.crashedSinceReply.add(key);
          this.failed.fire({ root: session.root, gaveUp: false, detail: change.detail ?? change.cause, repeated });
        } else if (change.cause === 'reply' || change.state === 'stopped') {
          this.crashedSinceReply.delete(key);
        }
        this.stateChanged.fire();
      }),
    );
    this.store.add(deps.gate.onDidChange(() => this.stateChanged.fire()));
  }

  backendFor(): IdrisBackend {
    return this.backend;
  }

  /** Follows a `check` session through an automatic restart to its next handshake (`onDidRestart`). */
  private noteRestart(root: Classification, change: SessionStateChange): void {
    const key = rootKey(root);
    const pending = this.pendingRestarts.get(key);
    if (change.cause === 'reconfigure') {
      if (change.state === 'stopped') {
        this.pendingRestarts.delete(key);
        this.restarted.fire({ root, cause: 'reconfigure' });
      } else {
        this.pendingRestarts.set(key, 'reconfigure');
      }
    } else if (change.state === 'restarting' && (change.cause === 'exit' || change.cause === 'protocolError')) {
      if (pending !== 'reconfigure') {
        this.pendingRestarts.set(key, 'crash');
      }
    } else if (change.state === 'restarting' && (change.cause === 'timeout' || change.cause === 'longActionTimeout')) {
      if (pending === 'crash') {
        this.pendingRestarts.delete(key);
      }
    } else if (change.state === 'ready' && change.cause === 'handshake') {
      if (pending !== undefined) {
        this.pendingRestarts.delete(key);
        this.restarted.fire({ root, cause: pending });
      }
    } else if (change.state === 'stopped' || change.state === 'failed') {
      this.pendingRestarts.delete(key);
    }
  }

  private checkSession(root: Classification): IdeSession | undefined {
    const key = rootKey(root);
    return this.deps.pool.sessions().find((s) => s.role === 'check' && rootKey(s.root) === key);
  }

  stateFor(root: Classification): BackendState {
    const dir = this.deps.projects.sessionCwd(root);
    const verdict = this.deps.gate.current(dir);
    if (verdict !== undefined && !verdict.allowed && (verdict.reason === 'denied' || verdict.reason === 'unanswered')) {
      return { kind: 'notAllowed', dir, reason: verdict.reason };
    }
    const session = this.checkSession(root);
    const change = this.lastChange.get(rootKey(root));
    switch (session?.state) {
      case undefined:
        return { kind: 'none' };
      case 'stopped':
        // Revoked: named until the directory is allowed again without a question (e.g. its folder
        // was added to the workspace), when the next check just starts the compiler.
        return change?.cause === 'consentRevoked'
          ? verdict?.allowed === true
            ? { kind: 'stopped' }
            : { kind: 'stopped', revokedDir: dir }
          : change?.cause === 'stop'
            ? { kind: 'stopped' }
            : { kind: 'none' };
      case 'failed':
        return { kind: 'failed', reason: change?.detail ?? 'the compiler could not be started' };
      default:
        return { kind: 'active' };
    }
  }

  /**
   * The roots with a session of either role that has a process or is starting one (for Stop and
   * Restart), each once: a root whose only process is its `eval` session's counts too.
   */
  activeRoots(): readonly Classification[] {
    const roots = new Map<string, Classification>();
    for (const s of this.deps.pool.sessions()) {
      if (s.state !== 'stopped' && s.state !== 'failed' && !roots.has(rootKey(s.root))) {
        roots.set(rootKey(s.root), s.root);
      }
    }
    return [...roots.values()];
  }

  /** Stops the sessions of `root`, or of every root. */
  stop(root?: Classification): void {
    this.deps.pool.stop(root);
  }

  /**
   * Stops the sessions of `root` because its last open document was closed (`SessionPool.release`),
   * forgets the token indexes of its files, and announces it (`onDidRelease`).
   */
  release(root: Classification): void {
    this.deps.pool.release(root);
    this.backend.forget(root);
    this.released.fire(root);
  }

  /**
   * Sends one `:repl-completions` to the `check` session of `doc`'s root when that session's last
   * answered load is of `doc`'s file and nothing has completed since (module comment: the first
   * completion after every load is the slow one), as soon as the session has been idle — nothing in
   * flight or queued — for `WARM_UP_QUIET_MS`; nothing when that has not happened within
   * `WARM_UP_MAX_WAIT_MS`, or the session loaded another file or ended meanwhile. For a completion
   * provider to call before the user completes, e.g. when a load of the active document is
   * announced (`onDidLoad`). Loads and starts nothing; resolves when the answer has arrived or
   * nothing was sent, and never rejects.
   */
  warmUpCompletions(doc: vscode.TextDocument): Promise<void> {
    return this.backend.warmUpCompletions(doc);
  }

  /**
   * The root of the active document, `pending` while it is being found, or none
   * (`features/diagnostics/checks.ts` `ActiveRoot`): its sessions are kept when
   * `idris2.ideMode.maxSessions` is exceeded (`SessionPool.setActiveRoot`).
   */
  setActiveRoot(root: Classification | 'pending' | undefined): void {
    this.deps.pool.setActiveRoot(root);
  }

  /**
   * Why a load of `doc` in `root` would be refused without the consent question being asked, or
   * `undefined` (`features/diagnostics/checks.ts` `LoadPreflight`: the checks ask the question
   * themselves for a background check under `idris2.ideMode.maxBackgroundChecks`, and a load that
   * nothing asks about must not get a question from them either): the walk `load` makes when the
   * load is queued (module comment, with its time limit), then what the pool checks before the
   * question (`SessionPool.startProblem`). Starts, stops and asks nothing.
   */
  refusalBeforeQuestion(doc: vscode.TextDocument, root: Classification): Promise<string | undefined> {
    return this.backend.refusalBeforeQuestion(doc, root);
  }

  /** Starts the sessions of `root` again now, or restarts every running session. */
  restart(root?: Classification): void {
    if (root === undefined) {
      this.deps.pool.restartAll();
    } else {
      this.deps.pool.restart(root);
    }
  }

  /**
   * Sends `text` verbatim as the command of a request `(<text> <id>)` to the `check` session of
   * `root` (**Idris 2 (Developer): Send Raw Protocol Request…**); the session writes the frames to
   * the protocol trace. Resolves with the `:return` as one line. The request may be anything —
   * a `:load-file`, a `:proof-search` — so it runs under `idris2.ideMode.longActionTimeout`.
   */
  async sendRaw(root: Classification, text: string): Promise<string> {
    const session = this.deps.pool.sessionFor(root, 'check');
    const reply = await session.request(
      { kind: 'raw', text },
      {
        kind: 'longAction',
        beforeSend: () => {
          this.backend.rawRequest(session);
          return Promise.resolve();
        },
      },
    );
    return describeReturn(reply);
  }

  dispose(): void {
    this.store.dispose();
    this.backend.dispose();
  }
}

/** A `:return` in one line, for the trace: `ok`, or `error: <first line>`. */
function describeReturn(reply: Reply): string {
  const payload = reply.payload;
  const id = reply.returnedId === undefined ? `${reply.id}` : `${reply.returnedId} (attributed to ${reply.id})`;
  return payload.kind === 'error' ? `id ${id}: error: ${payload.message.split('\n', 1)[0]}` : `id ${id}: ${payload.kind}`;
}

/** Whether `req` continues a search. */
function isNextRequest(req: EditRequest): req is NextRequest {
  return req.kind === 'exprSearchNext' || req.kind === 'generateDefNext';
}

/** Whether `doc` shows the lines of `loaded`, a text a load read (its line breaks aside: VS Code joins a document's lines with one). */
function showsLines(doc: vscode.TextDocument, loaded: string): boolean {
  const lines = editorLines(loaded.replace(/^\uFEFF/, ''));
  return lines.length === doc.lineCount && lines.every((line, i) => doc.lineAt(i).text === line);
}

/**
 * What the backend knows about one `:load-file` it sent (module comment, *Queries*), keyed by the
 * `LoadedFile` object the session records as its `loadedFile` once the load has returned.
 */
interface LoadRecord {
  /** The loaded document's `fileName`. */
  readonly fileName: string;
  /** The `rootKey` of the session's root. */
  readonly root: string;
  /** The load returned `(:ok …)`; `undefined` until it has returned. */
  ok: boolean | undefined;
  /**
   * A `check` load: the file's text as read right before the load was written (`queueLoad`'s
   * `readBefore`). `TokenIndex.text` is the text read when the reply has arrived only when it is
   * this one, so that it is the text the compiler read in between (*review of M3*: read after the
   * reply alone, a save during the load made the index describe the newer text).
   */
  textBefore: string | undefined;
  /**
   * A `check` load: the text the compiler read, known when the file read the same right before the
   * load was written (`textBefore`) and when its reply arrived; else `undefined`. Edits are asked
   * only while the document shows its lines (module comment, *Edits*).
   */
  loadedText: string | undefined;
  /** `holes`' answer for this load. */
  holes: Promise<Hole[]> | undefined;
  /** `typeAt` answers of this load, by request (`at L C NAME` positional, `name NAME` by name). */
  readonly types: Map<string, Promise<TypeInfo | undefined>>;
  /** `definition`'s `:name-at` answers of this load, by the name asked (`undefined`: an error). */
  readonly names: Map<string, Promise<readonly NameLocation[] | undefined>>;
  /** The target files `definition` read during this load, by path (`undefined`: cannot be read). */
  readonly sources: Map<string, Promise<string | undefined>>;
  /** `docsFor` answers of this load, by name. */
  readonly docs: Map<string, Promise<RichText | undefined>>;
  /** A `:repl-completions` has been sent after this load (`warmUpCompletions`). */
  warm: boolean;
}

/** A load sent by `queueLoad`: its reply, the path sent, the session directory and the record of the load the session answered. */
interface SentLoad {
  readonly reply: Reply;
  readonly sent: string;
  readonly cwd: string;
  readonly record: LoadRecord;
}

/** A load in a session's queue (`queueLoad`); `done` settles with its reply. */
interface QueuedLoad {
  readonly done: Promise<SentLoad>;
}

/**
 * Above this many token indexes, those of files without an open document are dropped, the least
 * recently used first (*review of M3*: an index of the 2,000-line module took 3.1 MiB of heap, its
 * tokens and text, and the indexes of every file ever loaded were kept while any file of their root
 * was open). The index of a file with an open document is never dropped (`IdeModeDeps.isOpen`;
 * second review of M3): when a tab is shown again VS Code asks for its semantic tokens, and with no
 * index the provider has none, so VS Code clears them (`setSemanticTokens(null, …)` [src, the
 * 1.139.1 workbench bundle]), its inlay hints are gone too, and nothing loads the file again until a
 * hover, a completion, Check File or a save. So the indexes kept are those of the open documents
 * that were loaded, and at most this many others.
 */
const MAX_INDEXES = 16;

/**
 * The rejection of a query whose document is not the file the root's `check` session loaded last
 * (`core/errors.ts` `NotLoaded`).
 */
function notLoaded(doc: vscode.TextDocument): IdrisException {
  return new IdrisException({
    kind: 'NotLoaded',
    message:
      `${path.basename(doc.fileName)} is not the file the compiler of its project has loaded last, ` +
      'so it cannot answer questions about it until the file is checked again.',
    file: doc.fileName,
  });
}

/**
 * The rejection (`NotLoaded`) of a query that waited while its file was loaded again (`ask`): the file
 * is the one loaded last, but not by the load the query was made for. Until the ninth review of M3 it
 * was `notLoaded`'s text, false here; `DocumentQueries` shows it when the query is overtaken twice.
 */
function reloaded(doc: vscode.TextDocument): IdrisException {
  return new IdrisException({
    kind: 'NotLoaded',
    message: `${path.basename(doc.fileName)} was checked again while the question waited; ask again.`,
    file: doc.fileName,
  });
}

/**
 * The rejection (`NotLoaded`) of an edit of a document that does not show the lines the compiler
 * loaded (module comment, *Edits*): the caller saves, loads it and asks again.
 */
function notAsLoaded(doc: vscode.TextDocument): IdrisException {
  return new IdrisException({
    kind: 'NotLoaded',
    message:
      `${path.basename(doc.fileName)} does not show the text the compiler loaded (it has unsaved changes, or changed since it ` +
      'was checked), and the compiler edits the text it loaded: save the file and check it again.',
    file: doc.fileName,
  });
}

/** The two searches the compiler keeps per process (module comment, *Searches*). */
type SearchKind = 'exprSearch' | 'generateDef';

/** A search this backend started and the compiler answered (module comment, *Searches*). */
interface SearchState {
  /**
   * The load that was the session's last when it was sent, of the file of the document it was
   * started for (`LoadRecord.fileName`; `recordOf` gives a document only a record of its own file).
   */
  readonly record: LoadRecord;
  /** The process that answered it. */
  readonly launch: SessionLaunch | undefined;
  /** `SessionSearches.sent[kind]` right after it was sent. */
  readonly sent: number;
}

/** Per `check` session: how many requests that replace a search of each kind were sent, and the searches that are current. */
interface SessionSearches {
  readonly sent: Record<SearchKind, number>;
  readonly current: Partial<Record<SearchKind, SearchState>>;
}

/** What each `-Next` continues and is called. */
const NEXT: Readonly<Record<NextRequest['kind'], { readonly kind: SearchKind; readonly title: string; readonly search: string }>> = {
  exprSearchNext: { kind: 'exprSearch', title: 'Next Result', search: 'Proof Search' },
  generateDefNext: { kind: 'generateDef', title: 'Next Definition', search: 'Generate Definition' },
};

/**
 * An `eval` session whose `:interpret` took longer than this is stopped once it has answered
 * (`SessionPool.releaseEvaluation`; module comment, *Evaluation*). The compiler keeps the memory an
 * evaluation made it take: on the e2e suite's 2,000-line module the `eval` process took 191 MiB after
 * its start, 206–210 MiB after the load and 247 MiB after six evaluations of 27–34 ms each; an
 * evaluation of `the (List Nat) [1..2000]` took 6.3 s in one run and 4.6 s in another and left the
 * process at 689 and 716 MiB, where it stayed for 30 s idle and after a small evaluation [live,
 * second review of M3: macOS `footprint` of the Chez process]. A second is far above those ordinary
 * evaluations; how much an evaluation of about a second leaves behind was not measured (the bound is
 * a choice). The next evaluation pays a new process's start and first load.
 */
export const EVAL_RELEASE_AFTER_MS = 1_000;

/** The prefix a completion warm-up sends: any prefix warms the next completion [live, module comment]. */
const WARM_UP_PREFIX = 'zq';

/**
 * How long a `check` session must have been idle before a completion warm-up is sent to it
 * (`IdeBackend.warmUpCompletions`): long enough that the requests which follow a load one after
 * another — a query that waited for it, a round of inlay hints, each sent within microtasks of the
 * previous answer — are not interrupted by it, short against the time before a user types after
 * a load. A choice, not measured; also the interval at which it looks again.
 */
export const WARM_UP_QUIET_MS = 150;

/** After this long without `WARM_UP_QUIET_MS` of quiet, a warm-up is not sent: the session is busy anyway. A choice. */
export const WARM_UP_MAX_WAIT_MS = 10_000;

/**
 * The part of `name` after its namespace, when `name` is qualified (`Data.Vect.index` → `index`):
 * the namespace segments are capitalised identifiers followed by a dot.
 */
function unqualified(name: string): string {
  return name.replace(/^(?:\p{Lu}[\p{L}\p{N}_']*\.)+(?=.)/u, '');
}

/**
 * The leading run of `root` that the compiler completes as a whole: letters and digits of ASCII and
 * every character above U+00A0 (`parseTask`, `src/TTImp/Interactive/Completion.idr` 38–42 on v0.8.0
 * [src]); `_`, `'` and operator characters end it.
 */
function completable(root: string): string {
  let run = '';
  for (const ch of root) {
    if (!/^[0-9A-Za-z]$/.test(ch) && (ch.codePointAt(0) ?? 0) <= 0xa0) {
      break;
    }
    run += ch;
  }
  return run;
}

/**
 * Whether a positional `:type-of` answer describes a local other than `name`: the compiler answers
 * for the local at the position whatever name is asked (transcript `unicode-columns`: `(:type-of
 * "y" 12 3)` → `x₁ : ℕ` [live]), which happens when the editor's position and the loaded text
 * disagree. The name is what the answer's last line has before ` : ` (a hole's goal ends with it);
 * a global's is qualified, an operator's too (`Foo.Shapes.area`, `Foo.Shapes.(|+|)`,
 * `Prelude.List.(++)` [live, `shapes-lookups`, `lit-lookups`]), so only an unqualified name
 * different from `name` (a leading `?` of a hole ignored) counts. An operator bound by `where` or
 * `let` is a local, answered unqualified and without parentheses, as it is asked (`<%> : Nat -> Nat
 * -> Nat` for `(:type-of "<%>" 6 8)` [live, third review of M3, one `timeout 60 idris2 --ide-mode`
 * on a small file]; until that review an unqualified parenthesised name was also passed over, a
 * shape no `:type-of` answer had). A method implementation's machine name
 * (`perimeter_Measured_Shape` for `perimeter` [live, `shapes-lookups`]) counts too, and then the
 * name lookup answers with the method's declared type.
 */
function describesAnotherLocal(answer: string, name: string): boolean {
  const lastLine = answer.slice(answer.lastIndexOf('\n') + 1);
  const separator = lastLine.indexOf(' : ');
  const shown = separator < 0 ? lastLine : lastLine.slice(0, separator);
  return !shown.includes('.') && shown !== name.replace(/^\?/, '');
}

/**
 * One entry per line of a `:browse-namespace` answer, `[MULTIPLICITY ]NAME : TYPE` [live,
 * `clean-queries`: a hole is listed as `1 vlen_rhs : …`], with the answer's highlighting cut to
 * each entry; `name` is `NAME` without the multiplicity. A line that starts with white space would
 * continue the previous entry's type: none did, also at 196 characters [live, `clean-queries`,
 * `Data.Vect`], but the listing is laid out by the pretty-printer (`hang 0 ty`,
 * `src/Idris/Doc/String.idr` 681 on v0.8.0 [src]).
 */
function namespaceEntries(listing: RichText): NamespaceEntry[] {
  const entries: { start: number; end: number }[] = [];
  let at = 0;
  for (const line of listing.text.split('\n')) {
    const end = at + line.length;
    if (/^\s/.test(line) && entries.length > 0) {
      entries[entries.length - 1].end = end;
    } else if (line.trim() !== '') {
      entries.push({ start: at, end });
    }
    at = end + 1;
  }
  return entries.map(({ start, end }) => {
    const text = listing.text.slice(start, end);
    const separator = text.indexOf(' : ');
    const shown = separator < 0 ? text : text.slice(0, separator);
    const spans = listing.spans
      .filter((span) => span.start >= start && span.start + span.length <= end)
      .map((span) => ({ ...span, start: span.start - start }));
    return { name: shown.replace(/^[01] /, ''), signature: { text, spans } };
  });
}

/**
 * Where a position of the text a document shows lies in the text the compiler's last load of its
 * file read (`IdeBackend.loadedPlace`): the document to convert it with (`core/positions.ts`: the
 * literate line map and the code-point columns of that text) and the position in it; `undefined`
 * when it is on a line changed since that cannot be matched (`toLoadedPosition`).
 */
type LoadedPlace = { readonly document: PositionDocument; readonly pos: EditorPosition } | undefined;

/** How the text a load read and the text a document shows correspond (`core/positions.ts` `textMap`), and the loaded text as a document. */
interface ComparedLines {
  readonly map: TextMap;
  readonly document: PositionDocument;
}

/** `ComparedLines` of `loaded` (the text of `fileName` a load read) and `shown` (a document's). */
function compareLines(fileName: string, loaded: string, shown: string): ComparedLines {
  return { map: textMap(loaded, shown), document: textDocument(fileName, loaded) };
}

export class IdeBackend implements IdrisBackend {
  readonly kind: BackendKind = 'ideMode';
  readonly caps: Readonly<Capabilities> = IDE_MODE_CAPABILITIES;
  /** The directory each process was started in (`directoryId`, `undefined`: none), by its launch (module comment). */
  private readonly startedIn = new WeakMap<SessionLaunch, Promise<string | undefined>>();
  /** The loads this backend sent, by the `LoadedFile` each was requested with (module comment, *Queries*). */
  private readonly records = new WeakMap<LoadedFile, LoadRecord>();
  /** The replies whose token index was built and whose load was announced (merged loads share one). */
  private readonly answered = new WeakSet<Reply>();
  /**
   * The token index of each document, by `fileName`, with the key of its root (`forget`); in the
   * order of their last use, the oldest first (`MAX_INDEXES`).
   */
  private readonly indexes = new Map<string, { readonly root: string; readonly index: TokenIndex }>();
  /** The evaluation running or last run in each `eval` session: one at a time (module comment). */
  private readonly evaluations = new WeakMap<IdeSession, Promise<unknown>>();
  /** Per root (`rootKey`), the process whose load was announced last (`LoadedDocument.rebuilt`). */
  private readonly announcedLaunch = new Map<string, SessionLaunch | undefined>();
  /**
   * Per root (`rootKey`) and file, the SHA-256 of the text its last announced load read
   * (`LoadRecord.textBefore`; `undefined`: not read), for `LoadedDocument.rebuilt`.
   */
  private readonly announcedTexts = new Map<string, Map<string, string | undefined>>();
  /** Per `check` session, when its state last changed (`sessionChanged`; `warmUpCompletions` waits for quiet). */
  private readonly lastChange = new WeakMap<IdeSession, number>();
  /** Per `check` session and file, the load of it that is being made (`typeAt` and `docsFor` wait for it). */
  private readonly pendingLoads = new WeakMap<IdeSession, Map<string, Promise<unknown>>>();
  /**
   * Per load, the last document version compared with the text it read (`loadedPlace`): `lines`
   * when they differ.
   */
  private readonly comparisons = new WeakMap<LoadRecord, { readonly doc: vscode.TextDocument; readonly version: number; readonly lines: ComparedLines | undefined }>();
  /** Per `check` session, its searches (module comment, *Searches*). */
  private readonly searches = new WeakMap<IdeSession, SessionSearches>();
  /**
   * Per root (`rootKey`) and file (`fileName`), the holes of the file's load answered last (module
   * comment, *Holes*): kept for the files with an open document (`IdeModeDeps.isOpen`) and the file
   * kept last, and forgotten with the root (`forget`).
   */
  private readonly keptHoles = new Map<string, Map<string, Promise<Hole[]>>>();
  /**
   * Per root (`rootKey`) and file, the SHA-256 of the text of the load whose holes took longer than
   * `idris2.ideMode.longActionTimeout` (module comment, *Holes*): they are not asked for after a load
   * of that text again, nor for `HolesOptions.kept`, so that each load does not cost that time and a
   * restart.
   */
  private readonly slowHoles = new Map<string, Map<string, string>>();

  constructor(
    private readonly deps: IdeModeDeps,
    /** `IdeMode.onDidLoad`'s emitter. */
    private readonly announce: (loaded: LoadedDocument) => void,
  ) {}

  /** A process was just started with `launch` (`IdeMode`, on the change to `starting`): notes the directory it was started in. */
  started(launch: SessionLaunch): void {
    this.startedIn.set(
      launch,
      this.deps.directoryId(launch.realCwd ?? launch.cwd).catch(() => undefined),
    );
  }

  /**
   * The real path of the session directory; or, when it cannot be resolved, or the process of
   * `session` was started in another directory than the one there now (module comment), the
   * refusal of the load.
   */
  private async sessionDirectory(session: IdeSession): Promise<string | LoadRefusal> {
    const cwd = session.cwd;
    let realCwd: string;
    try {
      realCwd = await this.deps.realpath(cwd);
    } catch (error) {
      const detail = `the folder of its session, ${cwd}, cannot be resolved (${error instanceof Error ? error.message : String(error)})`;
      return refusal(
        detail,
        `Not checked: ${detail}, so nothing was sent to the compiler, which would look for a package from wherever it runs now.`,
      );
    }
    const launch = session.launch;
    const expected = launch === undefined ? undefined : this.startedIn.get(launch);
    if (expected !== undefined) {
      const [then, now] = await Promise.all([expected, this.deps.directoryId(cwd).catch(() => undefined)]);
      if (then === undefined || now === undefined || then !== now) {
        const detail = `the folder ${realCwd} is not the one the compiler was started in (it was moved or replaced while the compiler ran)`;
        return refusal(
          detail,
          `Not checked: ${detail}, so nothing was sent to the compiler, which looks for a package from the folder it runs in. ` +
            'The next check starts it again in this folder.',
        );
      }
    }
    return realCwd;
  }

  /** The path to send in `:load-file` for `file` in a session started in `cwd`, whose real path is `realCwd` (module comment). */
  private loadPath(cwd: string, realCwd: string, file: string): string {
    return this.deps.platform === 'win32' ? file : path.join(realCwd, path.relative(cwd, file));
  }

  /**
   * The refusal of the load of `file` when the compiler, walking up from `dir` (the real path of the
   * session directory), would not use the package of `root` (module comment): a loose file's walk
   * must find no package file, a project's must find its own `.ipkg` in `dir`.
   */
  private async otherPackage(root: Classification, file: string, dir: string): Promise<LoadRefusal | undefined> {
    const found = await this.deps.findPackage(dir);
    const name = path.basename(file);
    if (root.kind === 'loose') {
      if (found === undefined) {
        return undefined;
      }
      // A compiler that has moved already (a load that raced with the package file) is stopped too.
      return refusal(
        `searching from ${dir}, the real path of its folder, the compiler would find the package file ${found}`,
        `Not checked: searching from ${dir}, the real path of its folder, the compiler would find the package file ${found} ` +
          `and check ${name} as part of that package, in that package's folder, which the extension did not ` +
          'find when it classified the file, so nothing was sent to the compiler. If the package file is new, the next check ' +
          'takes it into account when it lies inside the workspace folders, and after a reload of the window otherwise; if the ' +
          `folder is reached through a symbolic link, open the file through its real path, ${path.join(dir, name)}.`,
      );
    }
    const own = path.join(dir, path.basename(root.ipkgPath));
    if (found !== undefined && path.relative(found, own) === '') {
      return undefined;
    }
    const detail =
      found === undefined
        ? `searching from ${dir}, the real path of its folder, the compiler finds no package file, not ${root.ipkgPath}`
        : `searching from ${dir}, the real path of its folder, the compiler would find the package file ${found}, not ${root.ipkgPath}`;
    return refusal(
      detail,
      `Not checked: ${detail}, so nothing was sent to the compiler, which would check ${name} ` +
        `${found === undefined ? 'without a package' : "as part of that package, in that package's folder"}. The package file ` +
        'was removed, renamed or replaced after the extension classified the file: the next check takes that into account when ' +
        'it lies inside the workspace folders, and after a reload of the window otherwise.',
    );
  }

  /**
   * Why a load of `file` in `session` must not be sent now (module comment); else the real path of
   * the session directory. `sentFrom`: the real path the load's path was built from, which the
   * session directory must still have.
   */
  private async loadRefusal(root: Classification, session: IdeSession, file: string, sentFrom?: string): Promise<LoadRefusal | string> {
    const dir = await this.sessionDirectory(session);
    if (typeof dir !== 'string') {
      return dir;
    }
    if (sentFrom !== undefined && dir !== sentFrom) {
      const detail = `the real path of the folder of its session changed from ${sentFrom} to ${dir} while the load waited`;
      return refusal(detail, `Not checked: ${detail}, so nothing was sent to the compiler. The next check starts it again in this folder.`);
    }
    if (this.deps.platform !== 'win32') {
      // The compiler parses paths with its own parser: `\` is a separator to it, and it stops
      // reading at `:` or `?`. Its walk from such a folder goes elsewhere than `findPackage`'s,
      // and it would read another file (`project/ipkg.ts` `findIpkg`).
      const sent = this.loadPath(session.cwd, dir, file);
      const misread = [dir, sent].find((p) => !compilerReadsPathAsGiven(p, this.deps.platform));
      if (misread !== undefined) {
        const detail = `the compiler reads the path ${misread} as ${compilerReading(misread)}`;
        return refusal(
          detail,
          `Not checked: ${detail} (it takes \\ for a folder separator and stops reading a path at : or ?), so it would look for a ` +
            'package elsewhere and could check another file; nothing was sent to it. Rename the folder or the file without these characters.',
        );
      }
    }
    return (await this.otherPackage(root, file, dir)) ?? dir;
  }

  /**
   * The documents the ranges of a load's reply are converted with (`loadDiagnostics`, the token
   * index): the loaded file, the files its `:warning` frames name and, after a failed load, the
   * root's `.ipkg` (whose parse error has a range, F10), read from disk when the reply has arrived —
   * the text the compiler read, unless the file changed again since — for the bird-track offset
   * (F11) and the code-point columns (E14) of `core/positions.ts`. A file that cannot be read is
   * taken as having neither (`textDocument` without text).
   */
  private async documents(
    reply: Reply,
    cwd: string,
    loadedPath: string,
    ipkgPath: string | undefined,
  ): Promise<{ readonly documentFor: (p: string) => PositionDocument; readonly textOf: (p: string) => string | undefined }> {
    const files = [loadedPath];
    for (const message of reply.messages) {
      if (message.kind === 'warning') {
        files.push(path.resolve(cwd, message.warning.file));
      }
    }
    if (reply.payload.kind === 'error' && ipkgPath !== undefined) {
      files.push(ipkgPath);
    }
    const texts = new Map<string, string | undefined>();
    await Promise.all(
      [...new Set(files)].map(async (file) => {
        texts.set(file, await this.deps.readFile(file).catch(() => undefined));
      }),
    );
    return { documentFor: (p) => textDocument(p, texts.get(p)), textOf: (p) => texts.get(p) };
  }

  /**
   * `walk`, the walk made when a load is queued (module comment), unless it has not settled within
   * `idris2.ideMode.longActionTimeout`, the limit of the walk before the send
   * (`RequestOptions.beforeSend`): then it rejects with `LoadFailed`, nothing having been sent, and
   * the root's sessions are left as they are (a slow file system is no change of package). The walk
   * itself is not interrupted; its late result is ignored. (*M2 verification of the Q20–Q22 fixes*:
   * this walk had no limit, so on a hung network mount it never settled — the document read
   * `checking…` for good, **Stop Backend** could not end it, since the load was in no session yet, and
   * a background check it belonged to kept its `idris2.ideMode.maxBackgroundChecks` slot [unit-level,
   * the verifier's probes].)
   */
  private withinLimit<T>(walk: Promise<T>): Promise<T> {
    const limit = this.deps.config.ideMode().longActionTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = this.deps.clock.setTimeout(
        () =>
          reject(
            new IdrisException({
              kind: 'LoadFailed',
              message:
                `Not checked: the search for the file's package (the real path of its folder, a package file above it) did not ` +
                `finish within ${duration(limit)}, so nothing was sent to the compiler.`,
            }),
          ),
        limit,
      );
      walk.then(
        (value) => {
          this.deps.clock.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.deps.clock.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** `IdeMode.refusalBeforeQuestion`. */
  async refusalBeforeQuestion(doc: vscode.TextDocument, root: Classification): Promise<string | undefined> {
    const session = this.deps.pool.sessionFor(root, 'check');
    try {
      const early = await this.withinLimit(this.loadRefusal(root, session, doc.fileName));
      if (typeof early !== 'string') {
        return errorText(early.error.error);
      }
    } catch (error) {
      // The load would fail the same way.
      return error instanceof IdrisException ? errorText(error.error) : String(error);
    }
    const problem = await this.deps.pool.startProblem();
    return problem === undefined ? undefined : errorText(problem.error);
  }

  /** Rejects with `Unsupported` (`reason`) unless `doc` is a file on disk, which is all the compiler reads. */
  private requireFile(doc: vscode.TextDocument, reason: string): void {
    if (doc.uri.scheme !== 'file' || doc.isUntitled) {
      throw unsupported(reason);
    }
  }

  /**
   * Queues a `:load-file` of `doc` in `session` of `root` (a `check` or an `eval` session) after the
   * package walk and the checks of the module comment, and notes the load (`LoadRecord`); resolves
   * once the request is in the session's queue, `done` when it is answered. `readBefore` (a `check`
   * load): reads the file right before the load is written (`LoadRecord.textBefore`), before the
   * walk, so that only microtasks still separate the walk from the write.
   */
  private async queueLoad(
    root: Classification,
    session: IdeSession,
    doc: vscode.TextDocument,
    options: { readonly load?: LoadOptions; readonly readBefore?: boolean; readonly holes?: boolean; readonly superseded?: () => boolean } = {},
  ): Promise<QueuedLoad> {
    const cwd = session.cwd;
    // Checked once now, so that nothing is started (or asked) for a load that would be refused …
    const early = await this.withinLimit(this.loadRefusal(root, session, doc.fileName));
    if (typeof early !== 'string') {
      this.deps.pool.packageChanged(root, early.detail);
      throw early.error;
    }
    const realCwd = early;
    const sent = this.loadPath(cwd, realCwd, doc.fileName);
    const file: LoadedFile = doc.isDirty ? { path: sent } : { path: sent, version: doc.version };
    const own: LoadRecord = {
      fileName: doc.fileName,
      root: rootKey(root),
      ok: undefined,
      textBefore: undefined,
      loadedText: undefined,
      holes: undefined,
      types: new Map(),
      names: new Map(),
      sources: new Map(),
      docs: new Map(),
      warm: false,
    };
    // … and again when the load is the next to be sent, to a process that has started and answered
    // (module comment): until then a first load waits for the toolchain scan, the consent question
    // and the start, and any load for the requests before it.
    let refused: LoadRefusal | undefined;
    const beforeSend = async (): Promise<void> => {
      const text = options.readBefore === true ? await this.deps.readFile(doc.fileName).catch(() => undefined) : undefined;
      const now = await this.loadRefusal(root, session, doc.fileName, realCwd);
      if (typeof now !== 'string') {
        refused = now;
        throw now.error;
      }
      own.textBefore = text;
    };
    this.records.set(file, own);
    const urgent = options.load?.urgent;
    // A `check` load: its holes are asked for as soon as it is answered (module comment, *Holes*),
    // unless a newer load of the file is pending: they would only delay it, which answers for itself
    // (and `holes`, `edit` wait for it, or ask themselves when it is refused before it is sent).
    const onReply = (): void => {
      if (options.superseded?.() === true) {
        return;
      }
      const recorded = session.loadedFile;
      const record = (recorded?.path === sent ? this.records.get(recorded) : undefined) ?? own;
      if (record.holes === undefined && this.holesTooSlow(record)) {
        return;
      }
      this.keepHoles(record, record.holes ?? this.noteSlowHoles(record, this.listHoles(session, doc, record, true)));
    };
    const request = session.request(loadFile(sent), {
      kind: 'load',
      file,
      beforeSend,
      ...(urgent === undefined ? {} : { urgent }),
      ...(options.holes === true ? { onReply } : {}),
    });
    const done = request.then(
      (reply): SentLoad => {
        // Merged loads send the newest caller's `LoadedFile`, which the session has just recorded.
        const recorded = session.loadedFile;
        const record = (recorded?.path === sent ? this.records.get(recorded) : undefined) ?? own;
        record.ok = reply.payload.kind !== 'error';
        return { reply, sent, cwd, record };
      },
      (error: unknown) => {
        if (refused !== undefined && error === refused.error) {
          // The load is out of the queue: the stop cancels only what waited behind it.
          this.deps.pool.packageChanged(root, refused.detail);
        }
        throw error;
      },
    );
    return { done };
  }

  /** Notes `loading`, a load of `file` in the `check` session `session`, until it settles (`loadedCheckSession` waits for it). */
  private notePending(session: IdeSession, file: string, loading: Promise<unknown>): void {
    let pending = this.pendingLoads.get(session);
    if (pending === undefined) {
      pending = new Map();
      this.pendingLoads.set(session, pending);
    }
    const loads = pending;
    loads.set(file, loading);
    const clear = (): void => {
      if (loads.get(file) === loading) {
        loads.delete(file);
      }
    };
    loading.then(clear, clear);
  }

  async load(doc: vscode.TextDocument, options?: LoadOptions): Promise<LoadResult> {
    this.requireFile(doc, 'Only a file saved on disk can be checked: the compiler reads the file, not the editor.');
    const root = await this.deps.projects.classify(doc.fileName);
    const session = this.deps.pool.sessionFor(root, 'check');
    // `result` is noted as the file's pending load before any reply can come (`queueLoad` awaits first).
    const superseded = (): boolean => {
      const pending = this.pendingLoads.get(session)?.get(doc.fileName);
      return pending !== undefined && pending !== result;
    };
    const result = this.loadIn(root, session, doc, options, superseded);
    this.notePending(session, doc.fileName, result);
    return result;
  }

  /** `load` in `session`, the `check` session of `root`; `superseded`: whether a newer load of the file is pending. */
  private async loadIn(root: Classification, session: IdeSession, doc: vscode.TextDocument, options: LoadOptions | undefined, superseded: () => boolean): Promise<LoadResult> {
    const { reply, sent, cwd, record } = await (await this.queueLoad(root, session, doc, { load: options, readBefore: true, holes: true, superseded })).done;
    const ipkgPath = root.kind === 'project' ? root.ipkgPath : undefined;
    const { documentFor, textOf } = await this.documents(reply, cwd, doc.fileName, ipkgPath);
    if (!this.answered.has(reply)) {
      this.answered.add(reply);
      const text = textOf(doc.fileName);
      record.loadedText = text !== undefined && text === record.textBefore ? text : undefined;
      const index = tokenIndexOf(reply.messages, {
        file: doc.fileName,
        isLoadedFile: (name) => name === sent || path.resolve(cwd, name) === doc.fileName,
        document: documentFor(doc.fileName),
        text: text !== undefined && text === record.textBefore ? text : undefined,
        ok: record.ok === true,
      });
      if (index !== undefined) {
        this.keepIndex(doc.fileName, rootKey(root), index);
      }
      const key = rootKey(root);
      const launch = session.launch;
      const failed = reply.payload.kind === 'error';
      const newProcess = launch === undefined || this.announcedLaunch.get(key) !== launch;
      let texts = this.announcedTexts.get(key);
      if (texts === undefined) {
        texts = new Map();
        this.announcedTexts.set(key, texts);
      }
      const read = record.textBefore === undefined ? undefined : createHash('sha256').update(record.textBefore).digest('hex');
      const changedText = texts.has(doc.fileName) && texts.get(doc.fileName) !== read;
      texts.set(doc.fileName, read);
      const rebuilt =
        failed || newProcess || changedText || reply.messages.some((m) => m.kind === 'write-string' && decodeBuildingLine(m.text) !== undefined);
      this.announcedLaunch.set(key, launch);
      this.announce({ root, file: doc.fileName, rebuilt, failed });
    }
    const result = loadDiagnostics(reply, {
      loadedPath: doc.fileName,
      sentPath: sent,
      cwd,
      ipkgPath,
      includeSourceExcerpt: this.deps.config.diagnostics().includeSourceExcerpt,
      warningsAsErrors:
        session.launch?.args.includes('-Werror') === true ||
        (root.kind === 'project' && root.model.status === 'ok' && packageOptionWords(root.model.model.opts).includes('-Werror')),
      documentFor,
    });
    return this.toLoadResult(result);
  }

  private range(range: EditorRange): vscode.Range {
    const { api } = this.deps;
    return new api.Range(
      new api.Position(range.start.line, range.start.character),
      new api.Position(range.end.line, range.end.character),
    );
  }

  private diagnostic(record: DiagnosticRecord): vscode.Diagnostic {
    const { api } = this.deps;
    const severity = record.severity === 'error' ? api.DiagnosticSeverity.Error : api.DiagnosticSeverity.Warning;
    const diagnostic = new api.Diagnostic(this.range(record.range), record.message, severity);
    diagnostic.source = 'idris2';
    if (record.related.length > 0) {
      diagnostic.relatedInformation = record.related.map(
        (r) => new api.DiagnosticRelatedInformation(new api.Location(api.Uri.file(r.path), this.range(r.range)), r.message),
      );
    }
    return diagnostic;
  }

  private toLoadResult(result: LoadDiagnostics): LoadResult {
    const { api } = this.deps;
    return {
      ok: result.ok,
      diagnostics: [...result.files].map(([file, records]) => [api.Uri.file(file), records.map((r) => this.diagnostic(r))] as const),
      ...(result.packageError === undefined
        ? {}
        : { packageError: { uri: api.Uri.file(result.packageError.path), message: result.packageError.message } }),
      ...(result.blockedBy === undefined ? {} : { blockedBy: result.blockedBy.map((file) => api.Uri.file(file)) }),
    };
  }

  // -----------------------------------------------------------------------------------------
  // Queries (module comment, *Queries*)
  // -----------------------------------------------------------------------------------------

  /** The record of the load `session` answered last when it is `doc`'s file; else `undefined`. */
  private recordOf(session: IdeSession, doc: vscode.TextDocument): LoadRecord | undefined {
    const file = session.loadedFile;
    const record = file === undefined ? undefined : this.records.get(file);
    return record?.fileName === doc.fileName ? record : undefined;
  }

  /**
   * The `check` session of `doc`'s root and the record of its load of `doc`'s file; rejects with
   * `NotLoaded` when that session's last answered load is not of `doc`'s file (or it has no process).
   * `afterReload`: while a load of `doc`'s file is being made in that session and `doc`'s file is the
   * one loaded (a check after a save), waits for that load first, so that an answer kept per load
   * (`typeAt`, `docsFor`, `definition`) is not the previous load's (*review of M3*: a hover during
   * the check after a save showed the type before it, with no stale note). A query asked before a
   * reload was queued needs no wait: its check before the write refuses it when the reload went
   * first (`ask`, an `urgent` load).
   */
  private async loadedCheckSession(
    doc: vscode.TextDocument,
    afterReload = false,
  ): Promise<{ readonly session: IdeSession; readonly record: LoadRecord }> {
    this.requireFile(doc, 'Only a file saved on disk can be asked about: the compiler reads the file, not the editor.');
    const root = await this.deps.projects.classify(doc.fileName);
    const session = this.deps.pool.sessionFor(root, 'check');
    for (
      let pending = afterReload ? this.pendingLoads.get(session)?.get(doc.fileName) : undefined;
      pending !== undefined && this.recordOf(session, doc) !== undefined;
      pending = this.pendingLoads.get(session)?.get(doc.fileName)
    ) {
      await pending.then(
        () => undefined,
        () => undefined,
      );
    }
    const record = this.recordOf(session, doc);
    if (record === undefined) {
      throw notLoaded(doc);
    }
    return { session, record };
  }

  /**
   * Sends a query about `doc` to its `check` session, checking right before the write that `doc`'s
   * file is still the one loaded — and, given `record`, that the load answered last is that one, the
   * load the query's answer is kept for and its positions were converted with (`typeAt`, `docsFor`,
   * `definition`). A reload of the file may overtake a query that waits: the checks mark the active
   * document's load `urgent` while `idris2.ideMode.maxBackgroundChecks` is set, and an urgent request
   * goes before every request that waits (`session.ts`). Such a query is refused (`NotLoaded`, with
   * `reloaded`'s text), and `DocumentQueries` asks again once the check has ended (sixth review of M3: it was sent after the
   * reload with the position converted for the load before, and the compiler answered about another
   * line [unit-level, the verifier's probe on the real session]).
   */
  private ask(
    session: IdeSession,
    doc: vscode.TextDocument,
    command: IdeCommand,
    record?: LoadRecord,
    options: Partial<Pick<LookupRequestOptions, 'kind' | 'urgent' | 'onReply'>> = {},
  ): Promise<Reply> {
    return session.request(command, {
      kind: 'lookup',
      ...options,
      beforeSend: () => {
        const loaded = this.recordOf(session, doc);
        if (loaded === undefined) {
          return Promise.reject(notLoaded(doc));
        }
        return record !== undefined && loaded !== record ? Promise.reject(reloaded(doc)) : Promise.resolve();
      },
    });
  }

  /** `compute()` once per `key` in `cache` while it has not failed. */
  private cached<T>(cache: Map<string, Promise<T>>, key: string, compute: () => Promise<T>): Promise<T> {
    const known = cache.get(key);
    if (known !== undefined) {
      return known;
    }
    const answer = compute();
    cache.set(key, answer);
    answer.catch(() => {
      if (cache.get(key) === answer) {
        cache.delete(key);
      }
    });
    return answer;
  }

  /**
   * The positional `(:type-of "NAME" L C)` (F2; `L C` from `core/positions.ts`, code points, E14).
   * When it describes another local (`describesAnotherLocal`) and a name may end right at `pos`, it
   * is asked once more one code point further (`toIdeTypeOfRequestPastStart`: the compiler answers
   * for a local whose span holds the position, end included, so at the start of `++` in `xs++ys` it
   * answered for `xs` [live, second review of M3]). When no positional answer describes `NAME` —
   * both describe another local, or the request fails — `(:type-of "NAME")`, except for a variable
   * (`decor` `bound`, the caller's token index): by name the compiler would describe a global the
   * local shadows, which every caller drops (the hover, inlay hints), so the answer is `undefined`
   * without that request (*review of M3*). Each request's answer is kept per load, by the point
   * sent. Waits for a reload of the file being made (`loadedCheckSession`).
   *
   * **Unsaved changes** (third review of M3). The compiler answers about the text its last load of
   * the file read, and `pos` is a position of the text `doc` shows; while they differ, `pos` is
   * asked about where it lies in the loaded text (`loadedPlace`), converted with that text (its
   * literate line map, F11, and code-point columns, E14). Asked at `pos` as it is, a line inserted
   * above moved the question to another line — below it a local got no type, and one of another
   * clause with the same name answered with that clause's type (`n : Nat` for `g n = n` of `g :
   * String -> String` once `f`'s clause above was deleted) [unit-level, the reviewer's probe]. The
   * lines are matched by a line diff since the fourth review of M3 (`core/positions.ts`
   * `lineCorrespondence`): before, a line between two separate edits was matched with the loaded
   * line of the same number, and the hover over `x` of `let x = the Nat 1` asked about the next
   * line's `x` (`x : String`) [live answers, the reviewer's probe]. A position the loaded text
   * cannot be matched at (on a line of a hunk that inserted or deleted lines, or on a line edited in
   * place with other text before it) gets no positional request, only the lookup by name (not for a
   * variable).
   */
  async typeAt(doc: vscode.TextDocument, pos: vscode.Position, name: string, decor?: Decor): Promise<TypeInfo | undefined> {
    this.requireFile(doc, 'Only a file saved on disk can be asked about: the compiler reads the file, not the editor.');
    if (toIdeTypeOfRequest(doc, pos) === undefined) {
      return undefined;
    }
    const { session, record } = await this.loadedCheckSession(doc, true);
    const place = this.loadedPlace(doc, record, pos);
    const ask = (point: IdeRequestPoint | undefined): Promise<TypeInfo | undefined> =>
      this.cached(record.types, point === undefined ? `name ${name}` : `at ${point.line} ${point.column} ${name}`, async () => {
        const answer = decodeText((await this.ask(session, doc, typeOf(name, point), record)).payload);
        return answer.kind === 'ok' ? { ...toRichText(answer.value), lookup: point === undefined ? 'name' : 'position' } : undefined;
      });
    const at = place === undefined ? undefined : toIdeTypeOfRequest(place.document, place.pos);
    const first = at === undefined ? undefined : await ask(at);
    if (first !== undefined && !describesAnotherLocal(first.text, name)) {
      return first;
    }
    const past = first === undefined || place === undefined ? undefined : toIdeTypeOfRequestPastStart(place.document, place.pos);
    if (past !== undefined) {
      const second = await ask(past);
      if (second !== undefined && !describesAnotherLocal(second.text, name)) {
        return second;
      }
    }
    return decor === 'bound' ? undefined : ask(undefined);
  }

  /**
   * `LoadedPlace` of `pos`, a position of the text `doc` shows, for the load `record` (`typeAt`,
   * *Unsaved changes*): `doc` itself while it shows the text that load read
   * (`LoadRecord.textBefore`, a byte order mark ignored) or that text is not known; otherwise the
   * position `core/positions.ts` `toLoadedPosition` finds in it, with that text as the document.
   * The comparison is made once per document version and load.
   */
  private loadedPlace(doc: vscode.TextDocument, record: LoadRecord, pos: EditorPosition): LoadedPlace {
    const compared = this.comparedWithLoad(doc, record);
    if (compared === undefined || compared === 'same') {
      return { document: doc, pos };
    }
    const moved = compared.map.toRead(pos);
    return moved === undefined ? undefined : { document: compared.document, pos: moved };
  }

  /**
   * The text `doc` shows compared with the text the load `record` read (`LoadRecord.textBefore`, a
   * byte order mark ignored): `'same'`, or their lines and how they correspond, with the loaded text
   * as a document to convert with; `undefined` when that text is not known. Made once per document
   * version and load.
   */
  private comparedWithLoad(doc: vscode.TextDocument, record: LoadRecord): ComparedLines | 'same' | undefined {
    const loaded = record.textBefore?.replace(/^\uFEFF/, '');
    if (loaded === undefined) {
      return undefined;
    }
    let compared = this.comparisons.get(record);
    if (compared?.doc !== doc || compared.version !== doc.version) {
      const shown = doc.getText();
      compared = { doc, version: doc.version, lines: shown === loaded ? undefined : compareLines(doc.fileName, loaded, shown) };
      this.comparisons.set(record, compared);
    }
    return compared.lines ?? 'same';
  }

  /**
   * `(:docs-for "NAME")`: the whole text, whatever `mode` asks, since the compiler ignores it (F31)
   * and the caller takes the overview (`IdrisBackend.docsFor`); `undefined` when the compiler answers
   * an error (`Undefined name` [live]). Waits for a reload of the file being made (`loadedCheckSession`).
   */
  async docsFor(doc: vscode.TextDocument, name: string): Promise<RichText | undefined> {
    const { session, record } = await this.loadedCheckSession(doc, true);
    return this.cached(record.docs, name, async () => {
      const answer = decodeText((await this.ask(session, doc, docsFor(name), record)).payload);
      return answer.kind === 'ok' ? toRichText(answer.value) : undefined;
    });
  }

  /**
   * `(:name-at "NAME")` with `name` unqualified (the qualified form answers `()`, F2; a qualified
   * `name` keeps the answers whose name ends with it). Refused with `Unsupported` when `decor` is
   * `bound` (a local variable, by the caller's token index: the positional `:name-at` is a stub, F3,
   * so a local has no definition to find by name, and one found would be a global it shadows). Until
   * the third review of M3 the backend looked the occurrence up in its own index at `pos`, which
   * describes the saved file: with a line inserted above and not saved, `Vect` of `vlen : Vect n a
   * -> Nat` was refused as the local `xs` that the index had at that position [unit-level].
   *
   * `namespace`: the namespace the caller's token index gives the occurrence (`Token.namespace`: on
   * a reference, the namespace of the name it refers to, F33 — `Prelude.Types.List` on a use of
   * `length` of lists [live, fourth review of M3]). When some entries are that name (`NS.name`, or
   * `NS.(op)` for an operator), only those are kept; otherwise, and without a namespace (`""` on
   * bound and declaring occurrences), every entry is: `:name-at` answers every definition of the
   * name in the compiler's context, also of modules the file does not import (`length` of
   * `Data.List1`, `Prelude.Types.List`, `…SnocList`, `…String` and `Data.Vect` in a file importing
   * only `Data.Vect` [live, the same review]).
   *
   * Entries whose file is not an absolute path (`(Interactive)`, `(File-Not-Found)`) are left out,
   * and so are those whose file cannot be read (`IdeModeDeps.readFile`: not a regular file of at
   * most `MAX_SOURCE_FILE_BYTES` either): a name of an installed package points into its sources
   * (`/opt/homebrew/Cellar/idris2/0.8.0_2/libexec/idris2-0.8.0/…` [live, `clean-queries`]), which an
   * installation may lack. A file inside the session directory's real path is given as the editor
   * spells it; each target file is read for its ranges (bird-track offset, F11 — `:name-at` answers
   * unlit columns [live, `lit-lookups`] — and E14). VS Code applies a location to the target's open
   * document, so when that document shows other text than the file read (unsaved changes), the range
   * is moved to it (`shownRange`; for a file not open, to the lines VS Code will show, which differ
   * below a lone `\r`); a range that starts on a line changed since is left out. When no
   * entry is left, `Unsupported` says why. The `:name-at` answer and the target files' texts are kept
   * per load (`LoadRecord`), the moving is done at each call: VS Code asks at every Go to Definition
   * and every Cmd-hover, for each occurrence of a name, and until the fourth review of M3 each asked
   * the compiler again and read every target file again (three installed sources, 67,267 bytes, for
   * `::` [unit-level, the reviewer's probe]). Like `typeAt`, waits for a reload of the file being made.
   *
   * **The loaded file** (fifth review of M3). An entry in the file the load read is converted with
   * the text it read (`LoadRecord.textBefore`) and moved to the text `doc` shows, as `typeAt` compares
   * them (`comparedWithLoad`), not with the file on disk: the two differ after a save that was not
   * checked (the `manual` trigger, or a save during the load), and then F12 landed off — a line
   * inserted at the top and saved gave `area` the range above it, an undo back to the loaded text
   * one line higher still — and was right or not depending on whether it had been used before the
   * save (the first read is kept per load) [unit-level, the reviewer's probes]. Another file's entry
   * describes that module as the compiler last built it; after a change of that file on disk that no
   * load has built since — a save under the `manual` trigger, and under any trigger a change made
   * outside VS Code (a checkout, a formatter, a code generator) while the file is not checked —, its
   * range is converted with the newer text on disk and may be off, and with an open document of it
   * the result depends on whether it was read before the change (the first read is kept per load)
   * [unit-level, ninth review of M3: the verifier's probe, two lines inserted at the top of an
   * imported module not open gave its old range; not handled: the text the compiler built it from is
   * not kept, and telling such a change by the file's modification time against the time of the load
   * would refuse ranges that are right — of a file touched but not changed, until the next load, and
   * wherever the file system's clock runs ahead of the extension host's (a WSL or container mount)].
   */
  async definition(doc: vscode.TextDocument, _pos: vscode.Position, name: string, decor?: Decor, namespace?: string): Promise<vscode.Location[]> {
    this.requireFile(doc, 'Only a file saved on disk can be asked about: the compiler reads the file, not the editor.');
    if (decor === 'bound') {
      throw unsupported(
        `${name} is a local variable. Go to Definition finds global names only: the compiler looks definitions up by name, ` +
          'and its lookup by position is not implemented.',
      );
    }
    const { session, record } = await this.loadedCheckSession(doc, true);
    const root = unqualified(name);
    const entries = await this.cached(record.names, root, async () => {
      const answer = decodeNameAt((await this.ask(session, doc, nameAt(root), record)).payload);
      return answer.kind === 'ok' ? answer.value : undefined;
    });
    if (entries === undefined) {
      return [];
    }
    const named = entries.filter(
      (entry) => path.isAbsolute(entry.file) && (root === name || entry.name === name || entry.name.endsWith(`.${name}`)),
    );
    const inNamespace = namespace === undefined || namespace === '' ? [] : named.filter((entry) => entry.name === `${namespace}.${root}` || entry.name === `${namespace}.(${root})`);
    const found = inNamespace.length > 0 ? inNamespace : named;
    const spelled = (file: string): string => this.spelledPath(session, file);
    const textOf = (file: string): Promise<string | undefined> => this.cached(record.sources, file, () => this.deps.readFile(file).catch(() => undefined));
    const shown = new Map<string, RangeMove | undefined>();
    // The loaded file's spans describe the text the load read (*The loaded file*, above).
    const loaded = this.comparedWithLoad(doc, record);
    const { api } = this.deps;
    const located = await Promise.all(
      found.map(async (entry) => {
        const file = spelled(entry.file);
        let range: EditorRange;
        let toShown: RangeMove | undefined;
        const fromLoad = file === doc.fileName && loaded !== undefined;
        if (fromLoad) {
          range = fromIdeReplySpan(loaded === 'same' ? doc : loaded.document, entry.span);
          toShown = loaded === 'same' ? undefined : moveBy(loaded.map);
        } else {
          const text = await textOf(entry.file);
          if (text === undefined) {
            return 'unreadable';
          }
          if (!shown.has(file)) {
            shown.set(file, shownRange(text, this.deps.openText(file)));
          }
          range = fromIdeReplySpan(textDocument(entry.file, text), entry.span);
          toShown = shown.get(file);
        }
        const moved = toShown === undefined ? range : toShown(range);
        return moved === undefined ? (fromLoad ? 'changedSinceLoad' : 'unsaved') : new api.Location(api.Uri.file(file), this.range(moved));
      }),
    );
    const readable = located.filter((location): location is vscode.Location => typeof location !== 'string');
    if (readable.length === 0 && found.length > 0) {
      // A range the text shown moved: the loaded file's since its load read it, another file's
      // against its text on disk, which differs only by unsaved changes (a saved one not built since
      // is not seen: *The loaded file*, above).
      const changed = found.findIndex((_, i) => located[i] !== 'unreadable');
      throw unsupported(
        changed >= 0
          ? `The definition of ${name} is in ${spelled(found[changed].file)}, on lines ` +
              `${located[changed] === 'changedSinceLoad' ? 'changed since the compiler read it' : 'with unsaved changes'}: save that file and check it again to find it.`
          : `The definition of ${name} is in ${found[0].file}, which cannot be read on this computer ` +
              '(an installed package whose sources were not installed, or a file that was moved).',
      );
    }
    return readable;
  }

  /** `file`, a path in a reply, as the editor spells it when it lies inside the session directory's real path. */
  private spelledPath(session: IdeSession, file: string): string {
    const realCwd = session.launch?.realCwd;
    const inside = realCwd === undefined ? undefined : path.relative(realCwd, file);
    return inside === undefined || inside.startsWith('..') || path.isAbsolute(inside) ? file : path.join(session.cwd, inside);
  }

  /**
   * The holes of `doc`'s file as the root's `check` session's last load of it found them (module
   * comment, *Holes*; `holes.ts`): asked for when that load was answered, or now when it is the load
   * answered last; `[]` when the compiler answers `:metavariables` with an error. Waits for a reload
   * of the file being made (`loadedCheckSession`). `NotLoaded` when the session has not loaded the
   * file, or loaded another since and has no holes of this one.
   */
  async holes(doc: vscode.TextDocument, options: HolesOptions = {}): Promise<Hole[]> {
    let found: { readonly session: IdeSession; readonly record: LoadRecord };
    try {
      found = await this.loadedCheckSession(doc, true);
    } catch (error) {
      const kept = options.kept === true ? this.keptHoles.get(rootKey(await this.deps.projects.classify(doc.fileName)))?.get(doc.fileName) : undefined;
      if (kept === undefined || !(error instanceof IdrisException) || error.error.kind !== 'NotLoaded') {
        throw error;
      }
      return kept;
    }
    const { session, record } = found;
    if (record.holes === undefined && options.kept === true && this.holesTooSlow(record)) {
      throw new IdrisException({
        kind: 'RequestTimeout',
        message: `The holes of ${path.basename(doc.fileName)} are not asked for again: listing them took longer than idris2.ideMode.longActionTimeout at a load of the same text.`,
      });
    }
    const token = options.token;
    if (token?.isCancellationRequested === true) {
      throw cancelled('Cancelled before the holes were asked for.');
    }
    const listing = record.holes ?? this.keepHoles(record, this.listHoles(session, doc, record, false));
    return token === undefined ? listing : this.untilCancelled(listing, token, session.root);
  }

  /**
   * `listing` until `token` is cancelled (`HolesOptions.token`): a cancellation before `listing`
   * settles rejects with `Cancelled` at once and restarts the `check` session of `root`
   * (`restartCheck`), which ends the request in flight — the listing's, or the one it waits behind;
   * the listing's other waiters then get its error, and the next load asks again.
   */
  private untilCancelled(listing: Promise<Hole[]>, token: vscode.CancellationToken, root: Classification): Promise<Hole[]> {
    return new Promise((resolve, reject) => {
      const subscription = token.onCancellationRequested(() => {
        subscription.dispose();
        this.deps.pool.restartCheck(root, 'a listing of holes the user cancelled was running');
        reject(cancelled('Cancelled: the compiler was restarted, since it cannot stop a request it is answering.'));
      });
      listing.then(
        (holes) => {
          subscription.dispose();
          resolve(holes);
        },
        (error: unknown) => {
          subscription.dispose();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** Whether listing the holes of `record`'s text took too long before (`slowHoles`). */
  private holesTooSlow(record: LoadRecord): boolean {
    const slow = this.slowHoles.get(record.root)?.get(record.fileName);
    return slow !== undefined && record.textBefore !== undefined && slow === createHash('sha256').update(record.textBefore).digest('hex');
  }

  /**
   * Keeps `holes` as `record`'s (`LoadRecord.holes`) and as its file's (`keptHoles`) until it
   * fails; drops the kept holes of the root's other files without an open document.
   */
  private keepHoles(record: LoadRecord, holes: Promise<Hole[]>): Promise<Hole[]> {
    record.holes = holes;
    let kept = this.keptHoles.get(record.root);
    if (kept === undefined) {
      kept = new Map();
      this.keptHoles.set(record.root, kept);
    }
    kept.set(record.fileName, holes);
    for (const file of [...kept.keys()]) {
      if (file !== record.fileName && !this.deps.isOpen(file)) {
        kept.delete(file);
      }
    }
    holes.then(
      () => this.slowHoles.get(record.root)?.delete(record.fileName),
      () => {
        if (record.holes === holes) {
          record.holes = undefined;
        }
        if (this.keptHoles.get(record.root)?.get(record.fileName) === holes) {
          this.keptHoles.get(record.root)?.delete(record.fileName);
        }
      },
    );
    return holes;
  }

  /**
   * `holes`, the listing asked right after `record`'s load (`listHoles`' `first`), noting in
   * `slowHoles` when it times out. Only that listing: its requests are sent one right after the
   * other after the load, so a time-out it gets is its own, not that of a request before it (whose
   * time-out rejects the requests queued behind it too, `session.ts`).
   */
  private noteSlowHoles(record: LoadRecord, holes: Promise<Hole[]>): Promise<Hole[]> {
    holes.catch((error: unknown) => {
      if (error instanceof IdrisException && error.error.kind === 'RequestTimeout' && record.textBefore !== undefined) {
        let slow = this.slowHoles.get(record.root);
        if (slow === undefined) {
          slow = new Map();
          this.slowHoles.set(record.root, slow);
        }
        slow.set(record.fileName, createHash('sha256').update(record.textBefore).digest('hex'));
      }
    });
    return holes;
  }

  /**
   * `(:metavariables 80)` and the `:name-at` of each name to locate, for the load `record`. `first`:
   * right after the load's reply (`queueLoad`), the requests are `urgent` and each is made in the
   * reply hook of the one before (`RequestOptions.onReply`), so that they are all sent before a
   * request that was waiting — another file's load would change the compiler's context. They are
   * `longAction`s (`idris2.ideMode.longActionTimeout`; past it the process restarts without counting
   * towards giving up, `session.ts`): the compiler normalises each hole's type and premises, which
   * took 6.55 s for `:metavariables` with four holes of `Vect 65536 Bits8` [live, the UX review of
   * M4] — under `requestTimeout` (5 s) each such load restarted the process, and the fourth within
   * five minutes gave the backend up [unit-level, the same review].
   */
  private async listHoles(session: IdeSession, doc: vscode.TextDocument, record: LoadRecord, first: boolean): Promise<Hole[]> {
    const asked = { kind: 'longAction', ...(first ? { urgent: () => true } : {}) } as const;
    const own = holeTokenNames(record.textBefore ?? '');
    const locate = (metavariables: readonly Metavariable[]): Promise<Array<[string, readonly NameLocation[] | undefined]>> =>
      Promise.all(
        namesToLocate(metavariables, own).map(async (name) => {
          const entry = await this.cached(record.names, name, async () => {
            const located = decodeNameAt((await this.ask(session, doc, nameAt(name), record, asked)).payload);
            return located.kind === 'ok' ? located.value : undefined;
          });
          return [name, entry] as [string, readonly NameLocation[] | undefined];
        }),
      );
    let locating: ReturnType<typeof locate> | undefined;
    const reply = await this.ask(session, doc, metavariables(), record, {
      ...asked,
      onReply: (r) => {
        const listed = decodeMetavariables(r.payload);
        if (listed.kind === 'ok') {
          locating = locate(listed.value);
        }
      },
    });
    const answer = decodeMetavariables(reply.payload);
    if (answer.kind === 'error') {
      return [];
    }
    const entries = new Map(await (locating ?? locate(answer.value)));
    // One document per file, not per hole: its lines (and a literate file's line map) are made once.
    const documents = new Map<string, PositionDocument>();
    for (const file of new Set(holeEntries(answer.value, entries).map((e) => e.file).filter((f) => path.isAbsolute(f)))) {
      const spelled = this.spelledPath(session, file);
      const text =
        spelled === doc.fileName && record.textBefore !== undefined
          ? record.textBefore
          : await this.cached(record.sources, file, () => this.deps.readFile(file).catch(() => undefined));
      if (text !== undefined) {
        documents.set(file, textDocument(file, text));
      }
    }
    const { api } = this.deps;
    return holesOf(answer.value, entries, own, (entry) => {
      // Not absolute (`(Interactive)`), or not readable: no location.
      const document = documents.get(entry.file);
      return document === undefined ? undefined : new api.Location(api.Uri.file(this.spelledPath(session, entry.file)), this.range(fromIdeReplySpan(document, entry.span)));
    });
  }

  /**
   * The edit `req` asks for (module comment, *Edits*; `edits.ts`). Refuses, before anything is
   * classified or sent, a name that is not an Idris name; then, with `NotLoaded`, a document whose
   * file is not the one its root's `check` session loaded last or that does not show the lines that
   * load read (at `req.version`); then what `planEdit` refuses, and the requests that need a clean load
   * after a load that returned an error (F16).
   */
  async edit(req: EditRequest): Promise<EditResult> {
    const doc = req.doc;
    this.requireFile(doc, 'Only a file saved on disk can be edited with the compiler: it reads the file, not the editor.');
    if (isNextRequest(req)) {
      return this.editNext(req);
    }
    const problem = nameProblem(req);
    if (problem !== undefined) {
      throw unsupported(problem);
    }
    const { session, record } = await this.loadedCheckSession(doc, true);
    const loaded = record.loadedText;
    if (doc.version !== req.version || loaded === undefined || !showsLines(doc, loaded)) {
      throw notAsLoaded(doc);
    }
    const plan = planEdit(req, editText(doc, loaded));
    if (plan.afterFailedLoad !== undefined && record.ok !== true) {
      throw unsupported(plan.afterFailedLoad);
    }
    if (plan.hole !== undefined) {
      const holes = await (record.holes ?? this.keepHoles(record, this.listHoles(session, doc, record, false)));
      const refusal = holeRefusal(req, plan.hole, holes, record.ok === true);
      if (refusal !== undefined) {
        throw unsupported(refusal);
      }
    }
    const starts = plan.starts;
    let sent = 0;
    const reply = await this.sendEdit(session, plan, req.token, async () => {
      if (this.recordOf(session, doc) !== record) {
        throw reloaded(doc);
      }
      if (plan.readsDisk) {
        const disk = await this.deps.readFile(doc.fileName).catch(() => undefined);
        if (disk === undefined || disk.replace(/^\uFEFF/, '') !== loaded.replace(/^\uFEFF/, '')) {
          throw notAsLoaded(doc);
        }
      }
      if (starts !== undefined) {
        sent = this.searchesOf(session).sent[starts] += 1;
      }
    });
    if (starts !== undefined && reply.payload.kind === 'ok') {
      this.searchesOf(session).current[starts] = { record, launch: session.launch, sent };
    }
    return plan.decode(reply.payload);
  }

  /**
   * A `-Next` (module comment, *Searches*): sent only while the search it continues is current, in
   * the document it was started for, whose text at `req.version` holds the previous result at
   * `req.previous`.
   */
  private async editNext(req: NextRequest): Promise<EditResult> {
    const doc = req.doc;
    const next = NEXT[req.kind];
    const root = await this.deps.projects.classify(doc.fileName);
    const session = this.deps.pool.sessionFor(root, 'check');
    const ended = (): IdrisException =>
      unsupported(
        `${next.title}: the ${next.search} it would continue has ended — the file was loaded again, another ${next.search} was ` +
          `started, or the compiler was restarted since. Run ${next.search} again.`,
      );
    if (!this.isCurrentSearch(session, next.kind, doc)) {
      throw ended();
    }
    if (doc.version !== req.version) {
      throw unsupported(`${next.title}: ${path.basename(doc.fileName)} changed since the previous result was applied.`);
    }
    const plan = planNext(req.kind, editText(doc, ''), req.previous);
    const reply = await this.sendEdit(session, plan, req.token, () =>
      this.isCurrentSearch(session, next.kind, doc) ? Promise.resolve() : Promise.reject(ended()),
    );
    return plan.decode(reply.payload);
  }

  /** The searches of `session` (module comment, *Searches*). */
  private searchesOf(session: IdeSession): SessionSearches {
    let searches = this.searches.get(session);
    if (searches === undefined) {
      searches = { sent: { exprSearch: 0, generateDef: 0 }, current: {} };
      this.searches.set(session, searches);
    }
    return searches;
  }

  /**
   * Whether the search of `kind` that `session` answered last was started for `doc`'s file and is
   * still the compiler's (module comment, *Searches*): its load is still the session's last, and of
   * `doc`'s file (`recordOf`).
   */
  private isCurrentSearch(session: IdeSession, kind: SearchKind, doc: vscode.TextDocument): boolean {
    const searches = this.searchesOf(session);
    const search = searches.current[kind];
    return (
      search !== undefined &&
      search.sent === searches.sent[kind] &&
      search.launch === session.launch &&
      this.recordOf(session, doc) === search.record
    );
  }

  /**
   * A raw request is being written to `session` (`IdeMode.sendRaw`): it may be a search or a load,
   * so no search of the session is continued after it (module comment, *Searches*).
   */
  rawRequest(session: IdeSession): void {
    const searches = this.searchesOf(session);
    searches.sent.exprSearch += 1;
    searches.sent.generateDef += 1;
  }

  /**
   * Sends an edit request of `plan` to the `check` session `session`, `check` running right before
   * the write. `token`: a cancellation before the write drops it; one after it restarts the session
   * (module comment, *Edits*). Either rejects with the `Cancelled` error. A request the encoder
   * refuses (above 16 MiB) is `Unsupported`.
   */
  private async sendEdit(
    session: IdeSession,
    plan: EditPlan,
    token: vscode.CancellationToken | undefined,
    check: () => Promise<void>,
  ): Promise<Reply> {
    // A function: the token changes under the awaits below.
    const isCancelled = (): boolean => token?.isCancellationRequested === true;
    if (isCancelled()) {
      throw cancelled('Cancelled before the request was sent to the compiler.');
    }
    let written = false;
    const subscription = token?.onCancellationRequested(() => {
      if (written) {
        this.deps.pool.restartCheck(session.root, 'a request the user cancelled was running');
      }
    });
    try {
      return await session.request(plan.command, {
        kind: plan.long ? 'longAction' : 'lookup',
        ...(token === undefined ? {} : { token }),
        beforeSend: async () => {
          await check();
          written = true;
        },
      });
    } catch (error) {
      if (isCancelled()) {
        throw cancelled(
          written
            ? 'Cancelled: the compiler was restarted, since it cannot stop a request it is answering; the file is loaded again when it is needed.'
            : 'Cancelled before the request was sent to the compiler.',
        );
      }
      if (error instanceof RangeError) {
        throw unsupported(`Not sent: ${error.message}`);
      }
      throw error;
    } finally {
      subscription?.dispose();
    }
  }

  /**
   * `(:repl-completions "RUN")`, where `RUN` is the leading run of `prefix`'s name root that the
   * compiler completes as a whole (`completable`; the namespace of a qualified prefix is dropped, as
   * the compiler ignores it); the answer is filtered by that root and repeated names are dropped,
   * which also drops machine names such as `{a:129}` [live]. `[]` without asking when the root
   * starts with a character the compiler cannot complete (`_`, an operator), or when the compiler
   * answers an error.
   */
  async completions(doc: vscode.TextDocument, prefix: string): Promise<readonly string[]> {
    const root = unqualified(prefix);
    const run = completable(root);
    if (run === '') {
      return [];
    }
    const { session, record } = await this.loadedCheckSession(doc);
    const answer = decodeCompletions((await this.ask(session, doc, replCompletions(run))).payload);
    record.warm = true;
    return answer.kind === 'ok' ? [...new Set(answer.value.names.filter((n) => n.startsWith(root)))] : [];
  }

  /** `IdeMode.warmUpCompletions`. */
  async warmUpCompletions(doc: vscode.TextDocument): Promise<void> {
    try {
      const { session, record } = await this.loadedCheckSession(doc);
      for (let waited = 0; ; ) {
        if (record.warm || this.recordOf(session, doc) !== record) {
          return;
        }
        const quiet = this.deps.clock.now() - (this.lastChange.get(session) ?? Number.NEGATIVE_INFINITY);
        if (session.idle && quiet >= WARM_UP_QUIET_MS) {
          break;
        }
        if (waited >= WARM_UP_MAX_WAIT_MS) {
          return;
        }
        const wait = session.idle ? WARM_UP_QUIET_MS - quiet : WARM_UP_QUIET_MS;
        await new Promise<void>((resolve) => this.deps.clock.setTimeout(resolve, wait));
        waited += wait;
      }
      record.warm = true;
      await this.ask(session, doc, replCompletions(WARM_UP_PREFIX));
    } catch {
      // Nothing to warm (another file loaded, no process), or the request failed: a completion
      // after it is only slower.
    }
  }

  /** A state change of the `check` session `session` (`IdeMode`): its time, for the warm-up's quiet. */
  sessionChanged(session: IdeSession): void {
    this.lastChange.set(session, this.deps.clock.now());
  }

  /** `(:browse-namespace "NS")`, one entry per name (`namespaceEntries`); `[]` for an empty answer or an error. */
  async browseNamespace(doc: vscode.TextDocument, ns: string): Promise<NamespaceEntry[]> {
    const { session } = await this.loadedCheckSession(doc);
    const answer = decodeText((await this.ask(session, doc, browseNamespace(ns))).payload);
    return answer.kind === 'ok' ? namespaceEntries(toRichText(answer.value)) : [];
  }

  tokens(doc: vscode.TextDocument): TokenIndex | undefined {
    const entry = this.indexes.get(doc.fileName);
    if (entry === undefined) {
      return undefined;
    }
    // Used now: the last to go (`MAX_INDEXES`).
    this.indexes.delete(doc.fileName);
    this.indexes.set(doc.fileName, entry);
    return entry.index;
  }

  /**
   * Keeps `index` as `file`'s; above `MAX_INDEXES` indexes, drops those of files without an open
   * document, the least recently used first, until there are `MAX_INDEXES` or none of them is left.
   */
  private keepIndex(file: string, root: string, index: TokenIndex): void {
    this.indexes.delete(file);
    this.indexes.set(file, { root, index });
    for (const oldest of [...this.indexes.keys()]) {
      if (this.indexes.size <= MAX_INDEXES) {
        break;
      }
      if (!this.deps.isOpen(oldest)) {
        this.indexes.delete(oldest);
      }
    }
  }

  /** Forgets the token indexes of the files of `root`, its last announced process and texts and its kept holes (its last document was closed). */
  forget(root: Classification): void {
    const key = rootKey(root);
    for (const [file, entry] of this.indexes) {
      if (entry.root === key) {
        this.indexes.delete(file);
      }
    }
    this.announcedLaunch.delete(key);
    this.announcedTexts.delete(key);
    this.keptHoles.delete(key);
    this.slowHoles.delete(key);
  }

  // -----------------------------------------------------------------------------------------
  // Evaluation (module comment, *Evaluation*)
  // -----------------------------------------------------------------------------------------

  async evaluate(doc: vscode.TextDocument, expr: string, token?: vscode.CancellationToken): Promise<Evaluation> {
    const refusedCommand = replCommandRefusal(expr);
    if (refusedCommand !== undefined) {
      throw unsupported(refusedCommand);
    }
    if (expr.includes('\u0000')) {
      throw unsupported('Not evaluated: the text contains a NUL character, which cannot be sent to the compiler.');
    }
    this.requireFile(doc, 'Only an expression in a file saved on disk can be evaluated: the compiler reads the file, not the editor.');
    const root = await this.deps.projects.classify(doc.fileName);
    const session = this.deps.pool.sessionFor(root, 'eval');
    const previous = this.evaluations.get(session) ?? Promise.resolve();
    const evaluation = previous.then(() => this.evaluateIn(root, session, doc, expr, token));
    this.evaluations.set(session, evaluation.catch(() => undefined));
    return evaluation;
  }

  /**
   * One evaluation in the `eval` session (module comment): a load, then `:interpret`. A cancellation
   * of `token` stops the session (`SessionPool.cancelEvaluation`: IDE mode has no cancel, and only
   * stopping the process ends an evaluation that runs); one that came while an earlier evaluation
   * ran starts nothing. A failed session's error says how to start it again: Restart Backend returns
   * it to `stopped` (`SessionPool.restart`), and the next evaluation starts a process.
   */
  private async evaluateIn(
    root: Classification,
    session: IdeSession,
    doc: vscode.TextDocument,
    expr: string,
    token: vscode.CancellationToken | undefined,
  ): Promise<Evaluation> {
    if (token?.isCancellationRequested === true) {
      throw cancelled('Evaluate Selection was cancelled before the evaluation started.');
    }
    const subscription = token?.onCancellationRequested(() => this.deps.pool.cancelEvaluation(root));
    try {
      return await this.interpretIn(root, session, doc, expr, token);
    } catch (error) {
      if (error instanceof IdrisException && error.error.kind === 'BackendCrashed' && session.state === 'failed') {
        throw new IdrisException({
          kind: 'BackendCrashed',
          message: `${error.error.message} After Idris 2: Restart Backend, the next evaluation starts the evaluation session again.`,
        });
      }
      throw error;
    } finally {
      subscription?.dispose();
    }
  }

  /**
   * The load and the `:interpret` of one evaluation. The `:interpret` is queued right after the load,
   * before its reply, so that the session is never idle between the two: with
   * `idris2.ideMode.maxSessions` it would be the first to be stopped then (`pool.ts`), and every
   * evaluation under a limit of 1 failed that way (*review of M3* [unit-level, the real pool]). Its
   * check before the write waits for the load's reply: nothing is sent when the load failed (the
   * load's error is the answer) or when the session no longer has that load (defensive: only an
   * evaluation sends to the session, one at a time, and a stop or crash rejects both requests).
   * The `:interpret` has its own time limit, `idris2.eval.timeout`.
   */
  private async interpretIn(
    root: Classification,
    session: IdeSession,
    doc: vscode.TextDocument,
    expr: string,
    token: vscode.CancellationToken | undefined,
  ): Promise<Evaluation> {
    const { done } = await this.queueLoad(root, session, doc);
    const failedLoad = new Error('the load before the evaluation failed');
    const lost = new Error('the evaluation session lost the loaded file');
    const timeoutMs = this.deps.config.evaluation().timeoutMs;
    const interpreting = session.request(interpret(expr), {
      kind: 'longAction',
      timeoutMs,
      beforeSend: async () => {
        const loaded = await done;
        if (loaded.record.ok !== true) {
          throw failedLoad;
        }
        if (this.recordOf(session, doc) !== loaded.record) {
          throw lost;
        }
      },
    });
    // Rejected too when the load is: its check awaits the load, and a stop rejects both.
    interpreting.catch(() => undefined);
    if (token?.isCancellationRequested === true) {
      // Cancelled while the load was being queued (the package walk), when there was nothing to stop.
      this.deps.pool.cancelEvaluation(root);
    }
    const loaded = await done;
    if (loaded.record.ok !== true) {
      throw new IdrisException({ kind: 'LoadFailed', message: this.evaluationLoadError(root, doc, loaded) });
    }
    // Sent right after the load's reply (its check before the write waits only for it).
    const started = this.deps.clock.now();
    let reply: Reply;
    try {
      reply = await interpreting;
    } catch (error) {
      if (error === lost) {
        throw new IdrisException({
          kind: 'BackendCrashed',
          message: 'Not evaluated: the evaluation session no longer had the file loaded when the expression was to be sent; nothing was evaluated.',
        });
      }
      if (error instanceof RangeError) {
        // What the codec cannot send (a request above 16 MiB): the user's text, not a fault.
        throw unsupported(`Not evaluated: ${error.message}`);
      }
      if (error instanceof IdrisException && error.error.kind === 'RequestTimeout') {
        throw new IdrisException({
          kind: 'RequestTimeout',
          message:
            `Not evaluated: the evaluation did not finish within ${duration(timeoutMs)} (idris2.eval.timeout), so its compiler ` +
            'process was stopped; it starts again at the next evaluation.',
        });
      }
      throw error;
    }
    const took = this.deps.clock.now() - started;
    if (took > EVAL_RELEASE_AFTER_MS) {
      this.deps.pool.releaseEvaluation(
        root,
        `the evaluation took ${duration(took)}, so the evaluation session is stopped to give back the memory it kept; it starts again at the next evaluation`,
      );
    }
    const answer = decodeText(reply.payload);
    return answer.kind === 'ok'
      ? { kind: 'value', value: toRichText(answer.value) }
      : { kind: 'error', message: toRichText({ text: answer.message, highlighting: answer.highlighting }) };
  }

  /** The message of an evaluation whose file does not load: the file and its first error, from the load's diagnostics. */
  private evaluationLoadError(root: Classification, doc: vscode.TextDocument, loaded: SentLoad): string {
    const diagnostics = loadDiagnostics(loaded.reply, {
      loadedPath: doc.fileName,
      sentPath: loaded.sent,
      cwd: loaded.cwd,
      ipkgPath: root.kind === 'project' ? root.ipkgPath : undefined,
      includeSourceExcerpt: false,
      warningsAsErrors: false,
      documentFor: (p) => textDocument(p, undefined),
    });
    const first = [...diagnostics.files].flatMap(([file, records]) => records.map((r) => ({ file, r }))).find(({ r }) => r.severity === 'error');
    // Compiler text, which quotes the source: one line, its control and format characters written out.
    const what =
      first === undefined
        ? loaded.reply.payload.kind === 'error' ? editorLabel(loaded.reply.payload.message.split('\n', 1)[0], 200) : ''
        : `${path.basename(first.file)}: ${editorLabel(first.r.message.split('\n', 1)[0], 200)}`;
    return `Not evaluated: ${path.basename(doc.fileName)} does not compile (${what}). Evaluation needs the file to load.`;
  }

  /** Forgets the token indexes and the processes and texts of the announced loads; the pool owns the sessions. */
  dispose(): void {
    this.indexes.clear();
    this.announcedLaunch.clear();
    this.announcedTexts.clear();
  }
}
