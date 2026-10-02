/**
 * Checking documents and showing the result (`features/diagnostics`, docs/ARCHITECTURE.md §6, §8;
 * ROADMAP M2): the triggers of `idris2.checking.trigger`, the per-document state of §6.1 and the
 * one `DiagnosticCollection` "idris2" (the saved files; `idris2 (unsaved)` is M6's, `idris2
 * build` M9's).
 *
 * - **Which documents.** Idris documents (`isIdrisDocument`, the M1 selector rule: the `idris2`
 *   and `lidr` modes and the double extensions `.idr.<ext>`, `.lidr.<ext>`) that are files: the
 *   compiler checks the file on disk, so an untitled document is never checked.
 * - **Triggers** (ARCHITECTURE §6.2). `onSave` (default): a document is checked once when it is
 *   first shown in an editor after being opened — the visible editors at activation, and each
 *   one that becomes visible; a document opened but never shown (by another extension, a search)
 *   is not checked — and each time it is saved. `afterDelay`: as `onSave`, and an Idris file with
 *   unsaved changes is saved once `idris2.checking.delay` ms have passed without an edit (opt-in:
 *   it writes the user's files), which then checks it. `manual`: only **Idris 2: Check File**.
 *   While M4's cycling holds a document's save checks (`SaveCheckHolds`), its automatic saves
 *   (`files.autoSave`, the `afterDelay` save) check nothing until the hold ends; any other save
 *   (the user's) checks it, which ends the cycle.
 *   The trigger is read for each document's resource scope. Several documents of one root are
 *   checked one after another by the root's one session (it runs one request at a time, and
 *   merges queued loads of one file).
 * - **Restricted Mode**: nothing is checked (nothing may run), and `afterDelay` saves nothing
 *   (it would save only to check); the status item says why. When trust is granted, the visible
 *   documents are checked as if they had just been shown. Nor does `afterDelay` save a document
 *   whose folder the consent gate refused, or whose root's session was given up (`failed`): the
 *   load that would follow is refused at once.
 * - **State** (ARCHITECTURE §6.1): `idle` (not checked in this window), `loading`, `ok`,
 *   `warnings`, `errors`, `ipkgError` (the load stopped at the `.ipkg`, F10), and `failed` (the
 *   load was not answered: the process ended or timed out, the protocol broke, no compiler) —
 *   an addition to §6.1, which has no state for it. `ok`, `warnings` and `errors`, and the
 *   status's counts, are read from the collection when asked for, so they follow a later load of
 *   another document that determined this one. A document with unsaved changes is `stale`: what
 *   is shown is the saved file's result; so is one whose text changed since its last check without
 *   becoming dirty (see *Changes on disk*). A load the consent gate refused (or Restricted Mode, or
 *   a backend that does not check) leaves the previous state; once the directory is allowed, the
 *   refused documents that are visible are checked again, and a refused document shown later is
 *   checked when it is shown. `check` returns the refusal, so that **Check File** can say it. A
 *   load abandoned by Stop Backend, Restart Backend, a restart for a changed command line or a
 *   release (`isCancelled`) is no failure either: the previous state stays, and the restarts
 *   check the visible documents again themselves.
 * - **Results.** A load sets the diagnostics of each file it determined (`LoadResult`), so a
 *   reload that rebuilt nothing keeps what is shown (F7). Every result is applied, also one that
 *   arrives after a newer check of the same document was started, file by file in the order the
 *   checks started: a file keeps what a later-started check set (one root's loads are answered in
 *   order by its one session, so this is the order they were built in). Only the newest check of
 *   a document sets the document's state. (*Second review*: an older result used to be dropped
 *   whole, but the newer load finds the TTC it wrote fresh and determines nothing, F7, so what
 *   the older one found — a fixed error, new warnings — was never shown.) A result of a check
 *   whose document was closed meanwhile is dropped. **Limitation** [src]: the compiler rebuilds a
 *   module only when its source is at least as new as its TTC (`isTTCOutdated` compares
 *   modification times, `src/Idris/ProcessIdr.idr` 252–263, `ModTree.idr` 160–163 on v0.8.0;
 *   `-Xcheck-hashes` is disabled), so a file saved while the compiler was building it keeps the
 *   TTC of the text it read: the load after the save builds nothing, and what is shown is the
 *   earlier text's result until the file is changed and saved again.
 * - **Changes on disk.** When the file of an open, saved document changes outside the editor (a
 *   checkout, a formatter run in a terminal), VS Code reloads the document and reports a change of
 *   its text without a save, and the document stays clean. A document a check was started for
 *   (one that completed, failed, was cancelled or refused; not one never checked) whose text then
 *   differs from the text its check read is checked again (unless its trigger is `manual`, when it
 *   only reads `stale`): while a check runs, the text that check started with; otherwise the text
 *   the last completed check read, and the text of the last check started (a check that failed or
 *   was cancelled or refused is not repeated for the text it read; a refused one is refused again
 *   at once, without a question, unless its folder's verdict changed). A reload back to the text
 *   the last completed check read makes its result current again. **Telling a reload from a keystroke**: the change event does not
 *   say which it is, and its `isDirty` is not the state after the change — VS Code 1.139.1 sends a
 *   file's text change with the dirty state from before it, and the new dirty state in a second
 *   event without content changes (below). So a text change of a document that reads as clean is
 *   taken for a reload only when the file on disk holds exactly the document's new text (a UTF-8
 *   BOM dropped, line ends compared as `\n`: a document has one line-end sequence, `eol`), read
 *   after the event; otherwise it is a keystroke, and its dirty-state event follows. A file that
 *   is not UTF-8, or cannot be read, is therefore not checked again by a reload; it reads `stale`
 *   until a check (Check File) that started after that change completes with the document
 *   unchanged: that check read the file the document shows. Until that is settled the text is not
 *   known to be the saved one, and a check that starts meanwhile does not take it for the text it
 *   checks. A result is `stale` for any text but the one it was checked for: when no document
 *   version is known to show that text (a check that started with unsaved changes), the text is
 *   compared with it. An undo back to the text the last completed check read (the dirty-state event
 *   that leaves the document clean) starts no check and makes its result current again, also while
 *   another check runs (whose result replaces it if it completes); one back to the text of a check
 *   that was cancelled (Stop Backend) or failed reads `stale` until the next save or Check File;
 *   typing never starts a check. A document whose file was deleted and is
 *   created again (a checkout) is checked again when the file appears in a workspace folder (the
 *   file watcher sees only those), and once more when VS Code's reload, which comes later, brings
 *   another text; also when the deletion came while a check of it ran, whose result is then not
 *   shown on it (the compiler may have read the file before the deletion, or reported it missing).
 *   (*Verification after Q20–Q22*: an undo while a check of the same text ran, and that check
 *   cancelled, read `stale`; a reload after a first check that failed checked nothing; a check that
 *   started with unsaved changes left the result never `stale` afterwards; a check running across
 *   a deletion cleared it, so the creation checked nothing.) (*M2 verification of the third review*: a reload was compared only with the last
 *   completed check, so one during a running check — the first check, the check a create started, a
 *   change back and forth — was missed, and a clean document read `stale`; an undo while a save's
 *   check ran loaded the file again. *Second verification*: every text change of a clean-looking
 *   document was taken for a reload, so the first keystroke after a check loaded the saved file
 *   again — also after Stop Backend, which it undid — and a check that it started took the unsaved
 *   text for the checked one; an undo back to the saved text read `stale`. The unit tests had
 *   fired the dirty state before the content change, the opposite of VS Code's order.)
 *   **The event order** [src: VS Code 1.139.1 `workbench.desktop.main.js`; live: the
 *   `diagnostics` integration suite observes `1 clean`, `0 dirty` for an edit made with
 *   `workspace.applyEdit` and `1 dirty`, `0 clean` for an undo, M2 integration 2026-09-28]: the model's content
 *   listener that sends the change to the Extension Host (`$acceptModelChanged(uri, e,
 *   textFileService.isDirty(uri))`) is registered when the model is created (`onModelAdded` →
 *   `handleModelAdded`), before `TextFileEditorModel.installModelListeners` registers the one that
 *   marks the file dirty or clean; the dirty change then goes out as `$acceptDirtyStateChanged`,
 *   which the Extension Host fires as a change event with no content changes. A reload of a clean
 *   file sets no dirty state (`ignoreDirtyOnModelContentChange`), and a revert marks the file clean
 *   before it reloads, so both arrive as one text change of a clean document.
 * - **Closing and deleting.** Closing an Idris document this window checked removes its
 *   diagnostics and state from view (not those of a document it never tracked, which another
 *   file's load may have given it, while that load's root has a checked document), but this window
 *   remembers them: when the document is opened
 *   again and a load determines nothing for it (its TTC is fresh, so the compiler repeats no
 *   warning, F7), they are shown again — provided its text is what it was when it was closed and
 *   its last check had checked that version. A file nothing in this window has determined
 *   (fresh from an earlier session) has no known warnings: its status reads `up to date`, not
 *   `✓`. Deleting a file or folder in the workspace removes the diagnostics of everything at or
 *   below it, and an open document there reads as not checked; a check that was running then shows
 *   none of its results at or below it (the compiler may have read the files before the deletion).
 * - **What another file's fix changes.** A document the compiler did not check because of errors
 *   in files it imports carries only "Not checked: …" (`LoadResult.blockedBy`); once a load finds
 *   one of those files clean, the visible such documents of the root are checked again, and a
 *   hidden one when it is shown. Saving a root's `.ipkg` checks the root's visible documents again,
 *   so that a fixed package-file error goes away (the compiler reads the `.ipkg` at every load,
 *   F10, F13). A changed command line (a new `builddir`) restarts the session when the project
 *   index has read the new model (`pool.ts`), which may be after that check.
 * - **Automatic restarts** (`RootRestarts.onDidRestart`). When a root's session serves again
 *   because its command line changed (settings, toolchain, package), its visible documents are
 *   checked again, so that what they show comes from the new command line; after a crash (an
 *   exit or a protocol error), a visible document whose load the crash killed (`failed`) is
 *   checked once more, and only once until a check of it completes, so that a file that crashes
 *   the compiler does not loop. Restart Backend checks the visible documents itself
 *   (`commands.ts`).
 * - **The last document of a root.** When a checked document closes, or a check finds that it
 *   belongs to another root now (its `.ipkg` was created, renamed or removed), and no other tracked
 *   document belongs to its old root (none is still being classified either), that root's
 *   sessions are released (`RootRelease`; ARCHITECTURE §5.1: sessions stop when their root's last
 *   document closes), and the diagnostics its loads set on files that are not open are removed
 *   with them — its `.ipkg`'s, and those of imported files it built (no session is left to
 *   update them). An open file that no check of its own tracks (with `manual`, one never checked;
 *   one opened but never shown) keeps what they gave it until it is checked, or until it closes.
 *   VS Code reports a close when it disposes the document, which can be a while
 *   after its last editor was closed, and also when the document's language mode changes (close,
 *   then open).
 * - **Checks of one document started together** (a document shown in two editor groups, which
 *   the triggers that check the visible documents visit twice) load it once: each check takes a
 *   new generation before its first wait, and a check that is no longer the newest after
 *   classifying the file stops there, before it loads.
 * - **The active document** is the document of the active editor when it is an Idris file that is
 *   checked (`isCheckable`); while the active editor is anything else (another language, an output
 *   channel, none), the last such document, as long as it is open. Its root goes to the backend
 *   (`ActiveRoot`), whose sessions `idris2.ideMode.maxSessions` never stops (ROADMAP §9 Q21);
 *   while a check of it has not classified it yet, `pending`, for which the backend stops no
 *   session for the limit (the root of a file just opened is not known yet, and may be the one
 *   whose idle session would be stopped). An active document that no check tracks (with the
 *   `manual` trigger, one never checked, or checked before it was closed and opened again) is
 *   classified by itself for this, `pending` meanwhile. Where several visible documents are
 *   checked at once (activation, trust granted, Restart Backend, a restart for a changed command
 *   line, a consent answer, a package file saved, an import fixed), the active document's check is
 *   started last (`visibleDocuments`), so that its load is queued last and its file is the one its
 *   root's compiler loaded last — unless the other files take longer to classify, since each load is
 *   queued once its file is classified (fourth review of M3), or, while a limit is set
 *   (*Background checks*), a check of the batch in the active document's root waits before its load
 *   while the active one does not, so that its load is handed over after the active one's: (1) the
 *   gate has no verdict for its folder yet — at activation and when trust is granted —, and it asks
 *   about the folder first (`askFirst`); (2) it waits for a slot, which the active document's check
 *   never does: the batch's checks that take a slot — all but the active one's and those whose
 *   folder the gate refuses or whose load is refused before the question (`LoadPreflight`), of any
 *   root — outnumber the free slots (the limit less the checks that hold one: the background checks
 *   that run, of the batch or not, such as the save of a document open but not visible, whose folder
 *   is neither refused nor being asked about), and it is one of those left to wait — at any batch,
 *   with the folder known (seventh review of M3: with a limit of 1 and three visible files of one
 *   project, B, A, C; eighth review: with a limit of 2, two other visible files and a background
 *   check of a fourth file running, B, A, C, and B, C, A without it; ninth review: with a limit of
 *   1, B of another project allowed and C of A's project, B, A, C; B's folder refused, B, C, A).
 *   Then the active file is loaded, then the other, then the active one again for its first query,
 *   and the other file's queries are refused until it is focused. Not fixed, documented (sixth to
 *   ninth reviews of M3, the finding's option (c); not a decision of the user's): a limit is not the
 *   default; making the active document's check wait for the question step of the others would make
 *   it wait for their preflight and, while a question about another folder is open, until it is
 *   answered; and waiting for their slots would delay its diagnostics by their compile times. The
 *   active document's load is not `urgent` when, at its handover, a load of the batch in its root
 *   handed over before it has not settled — decided then, once: it stays first-in, first-out when
 *   that load settles, so the loads of its root queued before it, background loads outside the batch
 *   included, still go first (`CheckOptions.batch`). A batch that checks it alone in its root (an
 *   import fixed) leaves it urgent; one that checks it with another file of its root (two files that
 *   the fixed import blocked) makes it wait for the background loads of the root queued before it
 *   (tenth review of M3: not fixed, documented). Deciding once is a choice, not a fix: the load keeps
 *   its first-in, first-out place behind those loads, so they do not displace it; deciding again at
 *   each dispatch would send it before them once the batch's earlier loads in its root had settled,
 *   as the urgent rule does in the alone case (M2), which shows its diagnostics sooner but has it
 *   loaded again for its first query (eleventh review of M3). Marking the batch's other loads urgent
 *   would reorder the loads of documents that are not active.
 * - **Background checks** (`idris2.ideMode.maxBackgroundChecks`, ROADMAP §9 Q21; `0`, the default,
 *   is no limit and changes nothing above: no check waits, and the gate is not asked here).
 *   Otherwise a check of a document that is not the active one waits, after classifying the file
 *   (so that it waits as `checking…`), first for the answer about its folder if the consent gate
 *   has no verdict for it yet (`permit`; the load then gets it at once), outside the slots — an
 *   open question, which can wait in the notification centre for good, holds no slot — and then
 *   for a slot, unless the gate refuses the folder (the load is refused at once and starts
 *   nothing). Before that question the backend is asked whether the load would be refused without
 *   one (`LoadPreflight`: the walk for its package, no compiler, `extraArgs`, as the load and the
 *   pool check before they ask); if so nothing is asked, and the load goes at once, without a
 *   slot, to be refused as it would be without a limit. A check counts against the limit while it runs, is not the active document's, and
 *   the gate neither refuses its folder nor has the question about it open; a new one starts only
 *   while fewer than that many count. The others
 *   wait in the order they reached the slot step (one that asked about its folder first reaches it
 *   when answered, possibly after a later check of a folder already judged); a newer check of a
 *   waiting document takes the older one's place.
 *   The active document's check never waits for a slot, and a waiting check whose document becomes
 *   the active one starts at once. The running checks are counted again when the active document,
 *   the limit or a folder's verdict changes: a check that started as the active document's counts
 *   once another is active, one that started without a limit counts once one is set, and one whose
 *   folder's question is open (it started while its document was active) does not count while it
 *   waits for the answer. A higher limit (or `0`) starts waiting checks at once; a lower one stops
 *   nothing that runs. A waiting check does not load (the previous state stays) when its document
 *   closes or a newer check of it replaces it, on **Stop Backend** for its root or for all
 *   (`cancelWaiting`, also while it waits for its folder's answer), and when its folder is not
 *   allowed any more (a revocation; then it counts as refused, as a load the session rejects).
 *   Within one root the session sends one request at a time (`session.ts`), and the compiler cannot
 *   be interrupted: while a limit is set the active document's load is marked `urgent`
 *   (`LoadOptions`), so that it goes before the root's loads that wait, but still after the load
 *   being compiled and after one whose package walk (`beforeSend`) runs or has passed — at most
 *   those two, whatever they were checked for (*M2 verification of the Q20–Q22 fixes*: the queue
 *   was first-in, first-out, so after moving through several files of one project during its first
 *   compile the active file's load waited behind every load handed over before it, none of them
 *   bounded by the limit) — except where several visible documents are checked at once and, at the
 *   active one's handover, a load of the batch in its root handed over before it has not settled:
 *   then its load is not urgent, and waits for the root's requests queued before it (*The active
 *   document*, `CheckOptions.batch`, with its exception). Without a limit the order is as before.
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`, so the
 * logic is unit-tested against a fake of it.
 */
import { createHash } from 'crypto';
import * as path from 'path';
import type * as vscode from 'vscode';
import { rootKey, type BackendRegistry, type BackendState } from '../../backend/registry';
import type { LoadResult } from '../../backend/types';
import type { Config } from '../../core/config';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { errorText, IdrisException, isCancelled } from '../../core/errors';
import { Emitter, type Event } from '../../core/event';
import type { Log } from '../../core/log';
import type { SessionGate, WorkspaceTrust } from '../../core/trust';
import { isIpkgFileName } from '../../project/ipkg';
import { isIdrisDocument } from '../../project/literate';
import type { Classification, ProjectIndex } from '../../project/types';

export const DIAGNOSTIC_COLLECTION_NAME = 'idris2';

export type LoadState = 'idle' | 'loading' | 'ok' | 'warnings' | 'errors' | 'ipkgError' | 'failed';

/** What the status item says about the active document (rendered by `toolchain/status.ts`). */
export type CheckStatus =
  | { readonly kind: 'notChecked' }
  /** `waitingFor`: the directory whose permission question is open. */
  | { readonly kind: 'checking'; readonly waitingFor: string | undefined }
  /**
   * `known`: this window knows the compiler's report for the file (a load determined it, or it
   * was remembered when its document was closed); false when the compiler found the file already
   * built (e.g. by an earlier session) and repeated nothing, so its warnings, if any, are unknown.
   */
  | {
      readonly kind: 'checked';
      readonly errors: number;
      readonly warnings: number;
      readonly stale: boolean;
      readonly known: boolean;
      /** Set when `stale`: why, for the status's detail. */
      readonly staleness?: Staleness;
    }
  /** `staleness`: set when `stale`, as for `checked` (seventh review of M3: Type at Cursor took the trigger as not `manual`). */
  | { readonly kind: 'packageError'; readonly ipkg: string; readonly message: string; readonly stale: boolean; readonly staleness?: Staleness }
  | { readonly kind: 'loadFailed'; readonly reason: string }
  /** `revokedDir`: stopped because the permission for that directory was revoked (the next check asks again). */
  | { readonly kind: 'stopped'; readonly revokedDir?: string }
  | { readonly kind: 'backendFailed'; readonly reason: string }
  | { readonly kind: 'notAllowed'; readonly dir: string; readonly reason: 'denied' | 'unanswered' };

/**
 * Why a result is stale: `unsaved` changes (else the text changed since the check without a save,
 * e.g. on disk), and whether the trigger is `manual`, under which a save checks nothing.
 */
export interface Staleness {
  readonly unsaved: boolean;
  readonly manual: boolean;
}

/**
 * Holding the save checks of a document (M4, `features/editing/cycling.ts`): while a cycle of Proof
 * Search or Generate Definition results runs in it, an automatic save of it (VS Code's
 * `files.autoSave`, with the reason `AfterDelay` or `FocusOut`, or the `afterDelay` save of a result
 * just applied, which VS Code reports as `Manual`, "by an API call" [doc, vscode.d.ts 1.138]) starts
 * no check — its load would end the compiler's search, and with it the next results. Any other save
 * checks the document as always, and its load ends the cycle: one with the reason `Manual` that the
 * checks did not make, and one with no reason — **Save without Formatting** runs no save
 * participants, so `onWillSaveTextDocument` does not fire for it (`skipSaveParticipants`, VS Code
 * 1.139.1 workbench [src]). When the hold is released the document is checked if it was saved meanwhile,
 * has no unsaved changes then (otherwise its next save checks it), and no check has started since
 * that save (the load that ended the cycle may be that check).
 */
export interface SaveCheckHolds {
  /** Holds the save checks of the document `uri` (`uri.toString()`) until the result is disposed. */
  holdSaveChecks(uri: string): IDisposable;
}

/** The status item's view of the checks. */
export interface CheckStatusSource {
  /** `undefined` for a document that is not checked at all (not an Idris file on disk). */
  statusOf(doc: vscode.TextDocument, root: Classification | undefined): CheckStatus | undefined;
  readonly onDidChange: Event<void>;
}

export type ChecksApi = Pick<typeof vscode, 'languages' | 'window' | 'workspace' | 'DiagnosticSeverity' | 'TextDocumentSaveReason'>;

/** `setTimeout`/`clearTimeout`, injected so that the `afterDelay` debounce is unit-tested without waiting. */
export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** What the checks tell the backend (`IdeMode.release`): no open document of `root` is left. */
export interface RootRelease {
  release(root: Classification): void;
}

/**
 * What the checks tell the backend (`IdeMode.setActiveRoot`): the root of the active document
 * (module comment), whose sessions `idris2.ideMode.maxSessions` never stops; `pending` while a
 * check of the active document is still finding its root (then no session is stopped for the
 * limit); `undefined` for none.
 */
export interface ActiveRoot {
  setActiveRoot(root: Classification | 'pending' | undefined): void;
}

/**
 * What the checks learn from the backend (`IdeMode.onDidRestart`): a root's session serves again
 * after an automatic restart — `reconfigure` (its command line changed) or `crash` (an exit or a
 * protocol error killed the request in flight).
 */
export interface RootRestarts {
  readonly onDidRestart: Event<{ readonly root: Classification; readonly cause: 'reconfigure' | 'crash' }>;
}

/**
 * What the checks ask the backend (`IdeMode.refusalBeforeQuestion`) before they ask the consent
 * question themselves for a background check (module comment, *Background checks*): why the load
 * would be refused without any question — the walk for its package, no compiler, `extraArgs` —, or
 * `undefined`. Starts, stops and asks nothing.
 */
export interface LoadPreflight {
  refusalBeforeQuestion(doc: vscode.TextDocument, root: Classification): Promise<string | undefined>;
}

/** Why **Check File** did not check: the gate's refusal, and the directory to ask about again (none in Restricted Mode). */
export interface CheckRefusal {
  readonly message: string;
  readonly dir: string | undefined;
}

/**
 * Checks of several visible documents started at once (`CheckOptions.batch`): per root (`rootKey`),
 * how many of their loads were handed over to the backend and have not settled yet.
 */
class CheckBatch {
  private readonly loading = new Map<string, number>();

  /** Whether a load of the batch in `root` was handed over and has not settled. */
  pending(root: string): boolean {
    return (this.loading.get(root) ?? 0) > 0;
  }

  handedOver(root: string): void {
    this.loading.set(root, (this.loading.get(root) ?? 0) + 1);
  }

  settled(root: string): void {
    const left = (this.loading.get(root) ?? 0) - 1;
    if (left > 0) {
      this.loading.set(root, left);
    } else {
      this.loading.delete(root);
    }
  }
}

/** How a check was started (`DocumentChecks.check`). */
export interface CheckOptions {
  /**
   * The checks of several visible documents started at once, in `visibleDocuments`' order, the active
   * document last (activation, trust granted, an automatic restart, a consent answer, a package file
   * saved, an import fixed, Restart Backend); one object per such start. The active document's load
   * is then not `urgent` when, at its handover, a load of the batch in its root handed over before it
   * has not settled — decided once, not again at each dispatch (tenth review of M3; a choice, module
   * comment *The active document*): it stays first-in, first-out, behind the root's requests queued
   * before it. The batch queues it last on purpose, so that its file is the one its root's compiler
   * loaded last, and `urgent` sent it first again whenever the batch's loads waited together, as
   * for a process that is starting (fifth review of M3: with `maxBackgroundChecks` set, activation
   * loaded the active file, then the other, then the active file once more for its first hover, and
   * the other file's queries were refused).
   * Otherwise it is `urgent` as ever (ninth review of M3: every batch made it not urgent, also one
   * that checks the active document alone in its root — the check after an import it uses was
   * fixed —, whose load then waited behind the background loads of its root [unit-level, the
   * verifier's probe]).
   * The active one is still not loaded last when a check of the batch in its root hands its load over
   * after it (module comment, *The active document*: not fixed, documented, sixth to ninth reviews of
   * M3).
   */
  readonly batch?: CheckBatch;
}

/** `CheckOptions` of the checks of one batch (`CheckOptions.batch`). */
function newBatch(): CheckOptions {
  return { batch: new CheckBatch() };
}

export interface ChecksDeps {
  /**
   * The text of the regular file at `fsPath` decoded as UTF-8, or `undefined` when it cannot be
   * read or has more than `maxBytes` bytes (`readRegularTextFile`); to tell a reload from a
   * keystroke (module comment, *Changes on disk*).
   */
  readonly readFile: (fsPath: string, maxBytes: number) => Promise<string | undefined>;
  readonly registry: Pick<BackendRegistry, 'backendFor' | 'stateFor' | 'onDidChange'>;
  readonly roots: RootRelease & RootRestarts & ActiveRoot & LoadPreflight;
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd'>;
  /** `checking` per document; `ideMode().maxBackgroundChecks` and its changes (module comment, *Background checks*). */
  readonly config: Pick<Config, 'checking' | 'ideMode' | 'onDidChange'>;
  readonly trust: WorkspaceTrust;
  /**
   * The consent gate: whether a question is open, and the verdict once answered; `permit` asks
   * before a background check takes a slot (module comment, *Background checks*).
   */
  readonly consent: Pick<SessionGate, 'current' | 'permit' | 'onDidChange'> & { asking(dir: string): boolean };
  readonly log: Log;
  readonly timers: Timers;
}

/** A document's state as kept; `checked` is `ok`, `warnings` or `errors`, read from the collection. */
type Settled = 'idle' | 'checked' | 'ipkgError' | 'failed';

interface Tracked {
  /** The document, while it is open. */
  readonly document: vscode.TextDocument;
  loadState: Settled | 'loading';
  /** The state of the last check that completed (`loadState` without `loading`). */
  settled: Settled;
  /** Incremented by each check; only the newest sets the state. */
  generation: number;
  /** The newest check's promise (`check`) while it runs (`runningCheck`). */
  newest: Promise<CheckRefusal | undefined> | undefined;
  root: Classification | undefined;
  packageError: { readonly ipkg: string; readonly message: string } | undefined;
  failure: string | undefined;
  /** The last check was refused by the consent gate. */
  refused: boolean;
  /** Checked once after it was first shown (the open trigger). */
  checkedOnOpen: boolean;
  /**
   * The document version that shows the text the last completed check read (none while it shows
   * another): set by the check, and again when the document shows that text once more (an undo, a
   * reload of it).
   */
  checkedVersion: number | undefined;
  /** SHA-256 (`textHash`) of the text that check read: the document's, or the file's when it started with unsaved changes; none when unknown. */
  checkedHash: string | undefined;
  /** SHA-256 of the text the newest check read or reads, likewise (none until the file has been read). */
  sentHash: string | undefined;
  /**
   * Its text changed while it read as clean, and whether that was a reload or a keystroke (whose
   * dirty-state event follows) is not settled yet (module comment, *Changes on disk*).
   */
  unconfirmed: boolean;
  /** Its file was deleted since its last check (a create checks it again). */
  deleted: boolean;
  /** How often its file was deleted: a check that started before a deletion does not clear `deleted`. */
  deletions: number;
  /** Checked again once after a crash killed its load (`RootRestarts`); cleared by a completed check. */
  retriedAfterCrash: boolean;
  /** The imported files whose errors kept the last completed check from checking it (`LoadResult.blockedBy`). */
  blockedBy: readonly vscode.Uri[];
  /** The `afterDelay` save timer. */
  saveTimer: unknown;
}

/** A check whose load was let through (module comment, *Background checks*), until it ends. */
interface RunningCheck {
  readonly t: Tracked;
  readonly root: Classification;
  /** It counts against `idris2.ideMode.maxBackgroundChecks` now (`recount`). */
  holds: boolean;
}

/**
 * What a check got from its admission (module comment, *Background checks*): its load goes, as
 * `run`; or it does not load — `dropped`: a newer check of its document took its place, or the
 * document closed (or the checks were disposed); `cancelled`: Stop Backend; `refused`: the
 * permission for its folder was withdrawn while it waited.
 */
type Admission =
  | { readonly go: true; readonly run: RunningCheck }
  | { readonly go: false; readonly why: 'dropped' | 'cancelled' | 'refused' };

const DROPPED: Admission = { go: false, why: 'dropped' };
const CANCELLED: Admission = { go: false, why: 'cancelled' };
const REFUSED: Admission = { go: false, why: 'refused' };

/** A background check waiting for a slot. */
interface WaitingCheck {
  readonly t: Tracked;
  readonly root: Classification;
  /** Ends the wait of the check that owns this place now. */
  start(admission: Admission): void;
}

/** A background check waiting for the answer about its folder before it takes a slot. */
interface AskingCheck {
  readonly root: Classification;
  /** Stop Backend was run meanwhile: it does not load. */
  cancelled: boolean;
}

/** Diagnostics of a closed document, kept for its next load (module comment, "Results"). */
interface ClosedReport {
  /** SHA-256 of the document's text when it was closed. */
  readonly hash: string;
  readonly diagnostics: readonly vscode.Diagnostic[];
}

/**
 * A file's text as its document shows it: VS Code drops a UTF-8 BOM, and a document has one
 * line-end sequence (`TextDocument.eol`), so line ends are written as `\n`.
 */
function asShown(text: string): string {
  return (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

/** SHA-256 of a document's text, or of a file's text read to compare with one (`asShown`). */
function textHash(text: string): string {
  return createHash('sha256').update(asShown(text)).digest('hex');
}

/** Whether the file text `disk` is the document text `text` (`asShown`). */
function sameText(disk: string, text: string): boolean {
  return asShown(disk) === asShown(text);
}

/**
 * The most a check that starts with unsaved changes reads of the file, to learn which text the
 * compiler checks: 16 MiB, or more for a larger document.
 */
const UNSAVED_READ_BYTES = 16 * 1024 * 1024;

/** Whether the URI `text` (`Uri.toString()`) is `prefix`'s or lies below it (a deleted file or folder). */
function atOrBelow(prefix: string, text: string): boolean {
  return text === prefix || text.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/** Whether `a` and `b` name one path (`path.relative` compares case-insensitively on Windows). */
function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

/** Whether `doc` is checked at all: an Idris document that is a file on disk. */
export function isCheckable(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && isIdrisDocument(doc);
}

export class DocumentChecks implements CheckStatusSource, SaveCheckHolds, IDisposable {
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  private readonly tracked = new Map<string, Tracked>();
  /** The documents (`uri.toString()`) whose save checks are held (`holdSaveChecks`), and whether one was saved meanwhile. */
  private readonly holds = new Map<string, { saved: boolean; generation: number }>();
  /** The reason of the save each document (`uri.toString()`) is about to have (`onWillSaveTextDocument`), until its save event. */
  private readonly saveReasons = new Map<string, vscode.TextDocumentSaveReason>();
  /** The documents (`uri.toString()`) the `afterDelay` timer is saving, until their save event. */
  private readonly ownSaves = new Set<string>();
  /** The files (by URI) whose diagnostics in the collection a load in this window determined. */
  private readonly reported = new Set<string>();
  /** What closed documents showed, by URI, until a load determines them again. */
  private readonly closedReports = new Map<string, ClosedReport>();
  /** Numbers the checks in the order they start. */
  private sequence = 0;
  /** For each URI in the collection, the number of the check whose result set its diagnostics. */
  private readonly applied = new Map<string, number>();
  /** For each URI in the collection, the key (`rootKey`) of the root whose load set its diagnostics. */
  private readonly appliedBy = new Map<string, string>();
  /** The numbers (`sequence`) of the checks that have started and not ended. */
  private readonly inFlight = new Set<number>();
  /**
   * The files and folders deleted while checks ran (`deleted`), by URI, with the number of the last
   * check started before the deletion: no check up to that number shows a result at or below it
   * (`apply`). Kept while such a check runs.
   */
  private readonly deletions: { readonly prefix: string; readonly after: number }[] = [];
  /** The last active editor's document that is checked, while it is open (module comment, *The active document*). */
  private lastActive: vscode.TextDocument | undefined;
  /** The root last told to the backend (`ActiveRoot`), by `rootKey` (or `pending`); `null` before the first. */
  private activeRootKey: string | undefined | null = null;
  /** The classification of the active document made because no check had classified it (`classifiedActive`). */
  private activeClassification: { readonly key: string; root: Classification | 'pending' | undefined } | undefined;
  /** The checks whose load was let through, until they end (module comment, *Background checks*). */
  private readonly running = new Set<RunningCheck>();
  /** Background checks waiting for a slot, in the order they asked. */
  private readonly waiting: WaitingCheck[] = [];
  /** Background checks waiting for the answer about their folder before they take a slot. */
  private readonly askingFirst = new Set<AskingCheck>();
  readonly collection: vscode.DiagnosticCollection;
  readonly onDidChange: Event<void> = this.changed.event;

  constructor(
    private readonly api: ChecksApi,
    private readonly deps: ChecksDeps,
  ) {
    this.collection = this.store.add(api.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME));
    this.store.add({ dispose: () => this.tracked.forEach((t) => this.stopTimer(t)) });
    this.store.add({ dispose: () => this.waiting.splice(0).forEach((w) => w.start(DROPPED)) });
    this.store.add(api.window.onDidChangeActiveTextEditor(() => this.activeChanged()));
    this.store.add(
      deps.config.onDidChange('ideMode', (change) => {
        if (change.affects('ideMode.maxBackgroundChecks')) {
          this.recount();
        }
      }),
    );
    // Not a batch: an editor opened makes its document visible and active, and while a limit is set
    // its load goes before the root's loads that wait (module comment, *Background checks*).
    this.store.add(api.window.onDidChangeVisibleTextEditors(() => this.visibleDocuments().forEach((doc) => this.shown(doc))));
    this.store.add(
      api.workspace.onDidOpenTextDocument((doc) => {
        // A change of language mode is reported as close + open of the document, with no
        // visible-editor event (VS Code 1.139.1 [src], see `toolchain/status.ts`).
        if (api.window.visibleTextEditors.some((e) => e.document === doc)) {
          this.shown(doc);
        }
      }),
    );
    this.store.add(api.workspace.onDidCloseTextDocument((doc) => this.closed(doc)));
    this.store.add(api.workspace.onWillSaveTextDocument((e) => this.saveReasons.set(e.document.uri.toString(), e.reason)));
    this.store.add(api.workspace.onDidSaveTextDocument((doc) => this.saved(doc)));
    this.store.add(api.workspace.onDidChangeTextDocument((e) => this.edited(e.document, e.contentChanges.length > 0)));
    const files = this.store.add(api.workspace.createFileSystemWatcher('**/*', false, true, false));
    this.store.add(files.onDidDelete((uri) => this.deleted(uri)));
    this.store.add(files.onDidCreate((uri) => this.created(uri)));
    this.store.add(deps.registry.onDidChange(() => this.changed.fire()));
    // Documents shown in Restricted Mode were not checked; they are once trust is granted.
    this.store.add(
      deps.trust.onDidGrant(() => {
        const batch = newBatch();
        this.visibleDocuments().forEach((doc) => this.shown(doc, batch));
      }),
    );
    this.store.add(deps.consent.onDidChange(() => this.consentChanged()));
    this.store.add(deps.roots.onDidRestart(({ root, cause }) => this.restarted(root, cause)));
    this.activeChanged();
    const batch = newBatch();
    this.visibleDocuments().forEach((doc) => this.shown(doc, batch));
  }

  private trigger(doc: vscode.TextDocument): 'onSave' | 'afterDelay' | 'manual' {
    return this.deps.config.checking(doc.uri).trigger;
  }

  private track(doc: vscode.TextDocument): Tracked {
    const key = doc.uri.toString();
    let t = this.tracked.get(key);
    if (t === undefined) {
      t = {
        document: doc,
        loadState: 'idle',
        settled: 'idle',
        generation: 0,
        newest: undefined,
        root: undefined,
        packageError: undefined,
        failure: undefined,
        refused: false,
        checkedOnOpen: false,
        checkedVersion: undefined,
        checkedHash: undefined,
        sentHash: undefined,
        unconfirmed: false,
        deleted: false,
        deletions: 0,
        retriedAfterCrash: false,
        blockedBy: [],
        saveTimer: undefined,
      };
      this.tracked.set(key, t);
    }
    return t;
  }

  private stopTimer(t: Tracked): void {
    if (t.saveTimer !== undefined) {
      this.deps.timers.clear(t.saveTimer);
      t.saveTimer = undefined;
    }
  }

  // --- triggers ------------------------------------------------------------------------------

  private shown(doc: vscode.TextDocument, options?: CheckOptions): void {
    if (!this.deps.trust.isTrusted || !isCheckable(doc) || this.trigger(doc) === 'manual') {
      return;
    }
    const t = this.track(doc);
    if (!t.checkedOnOpen || (t.refused && this.allowedNow(t)) || this.unblocked(t)) {
      t.checkedOnOpen = true;
      void this.check(doc, options);
    }
  }

  /** Whether a load in this window has found clean one of the files that kept `t`'s last check from checking it. */
  private unblocked(t: Tracked): boolean {
    return t.loadState !== 'loading' && t.blockedBy.some((file) => this.reported.has(file.toString()) && this.errorCount(file) === 0);
  }

  private errorCount(file: vscode.Uri): number {
    return (this.collection.get(file) ?? []).filter((d) => d.severity === this.api.DiagnosticSeverity.Error).length;
  }

  /** Whether the gate now allows the directory of the root a refused check was for. */
  private allowedNow(t: Tracked): boolean {
    return t.root !== undefined && this.deps.consent.current(this.deps.projects.sessionCwd(t.root))?.allowed === true;
  }

  holdSaveChecks(uri: string): IDisposable {
    const hold = { saved: false, generation: 0 };
    this.holds.set(uri, hold);
    return {
      dispose: () => {
        if (this.holds.get(uri) !== hold) {
          return;
        }
        this.holds.delete(uri);
        const doc = this.tracked.get(uri)?.document;
        const checkedSince = (this.tracked.get(uri)?.generation ?? 0) !== hold.generation;
        if (hold.saved && !checkedSince && doc !== undefined && !doc.isClosed && !doc.isDirty && isCheckable(doc) && this.trigger(doc) !== 'manual') {
          void this.check(doc);
        }
      },
    };
  }

  private saved(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const reason = this.saveReasons.get(key);
    this.saveReasons.delete(key);
    const own = this.ownSaves.delete(key);
    if (isCheckable(doc)) {
      const hold = this.holds.get(key);
      const automatic = reason === this.api.TextDocumentSaveReason.AfterDelay || reason === this.api.TextDocumentSaveReason.FocusOut;
      if (hold !== undefined && (own || automatic)) {
        hold.saved = true;
        hold.generation = this.tracked.get(key)?.generation ?? 0;
      } else if (this.trigger(doc) !== 'manual') {
        void this.check(doc);
      }
    } else if (doc.uri.scheme === 'file' && isIpkgFileName(path.basename(doc.uri.fsPath))) {
      this.packageSaved(doc.uri.fsPath);
    }
  }

  /** A package file was saved: the visible documents of the root it governs are checked again. */
  private packageSaved(ipkg: string): void {
    const batch = newBatch();
    for (const doc of this.visibleDocuments()) {
      const root = this.tracked.get(doc.uri.toString())?.root;
      if (root?.kind === 'project' && samePath(root.ipkgPath, ipkg) && isCheckable(doc) && this.trigger(doc) !== 'manual') {
        void this.check(doc, batch);
      }
    }
  }

  /**
   * Whether a load of a document of `root` could run now: the consent gate has not refused its
   * folder and its session was not given up (`afterDelay` saves only then).
   */
  private mayLoad(root: Classification | undefined): boolean {
    if (root === undefined) {
      return true;
    }
    const verdict = this.deps.consent.current(this.deps.projects.sessionCwd(root));
    const backend = this.deps.registry.stateFor(root)?.kind;
    return (verdict === undefined || verdict.allowed) && backend !== 'failed' && backend !== 'notAllowed';
  }

  /**
   * A change event of `doc`: `contentChanged` when its text changed, else only its dirty state.
   * The `isDirty` of a text change is the state before it (module comment, *Changes on disk*).
   */
  private edited(doc: vscode.TextDocument, contentChanged: boolean): void {
    if (!isCheckable(doc)) {
      return;
    }
    const t = this.tracked.get(doc.uri.toString());
    if (t !== undefined) {
      if (contentChanged && !doc.isDirty) {
        // A reload, or a keystroke whose dirty-state event is still to come.
        t.unconfirmed = true;
        void this.confirmReload(doc, t);
      } else {
        t.unconfirmed = false;
        if (!contentChanged && !doc.isDirty && t.checkedHash !== undefined && textHash(doc.getText()) === t.checkedHash) {
          // Clean again with the text the last completed check read (an undo back to it): its result
          // applies — also while a check runs, whose result replaces it (and this version) if it
          // completes, and which may be cancelled instead (*verification after Q20–Q22*: it read `stale` then).
          t.checkedVersion = doc.version;
        }
      }
      this.changed.fire(); // `stale` may have changed
    }
    const checking = this.deps.config.checking(doc.uri);
    if (checking.trigger !== 'afterDelay' || !this.deps.trust.isTrusted) {
      // In Restricted Mode nothing is checked, so nothing is saved to be checked.
      if (t !== undefined) {
        this.stopTimer(t);
      }
      return;
    }
    const tracked = t ?? this.track(doc);
    this.stopTimer(tracked);
    if (!doc.isDirty) {
      return;
    }
    tracked.saveTimer = this.deps.timers.set(() => {
      tracked.saveTimer = undefined;
      if (!doc.isClosed && doc.isDirty && this.trigger(doc) === 'afterDelay' && this.mayLoad(tracked.root)) {
        const key = doc.uri.toString();
        this.ownSaves.add(key);
        // A save that fails resolves `false` (vscode.d.ts 1.138 [doc]) and sends no save event: the
        // user's next save is then not taken for this one.
        void doc.save().then(
          (ok) => {
            if (!ok) {
              this.ownSaves.delete(key);
              this.deps.log.warn(`Could not save ${doc.fileName}.`);
            }
          },
          (error: unknown) => {
            this.ownSaves.delete(key);
            this.deps.log.warn(`Could not save ${doc.fileName}: ${String(error)}`);
          },
        );
      }
    }, checking.delayMs);
  }

  /**
   * The text of a document that read as clean changed: a reload when the file on disk holds that
   * very text, read now, and the document is still clean at that version; else a keystroke, whose
   * dirty-state event comes (or came meanwhile), or a later change that is judged by itself.
   */
  private async confirmReload(doc: vscode.TextDocument, t: Tracked): Promise<void> {
    const version = doc.version;
    const text = doc.getText();
    // A UTF-8 file with this text has at most 3 bytes per UTF-16 unit (a `\n` read as `\r\n`
    // included), and a BOM: anything longer differs.
    const disk = await this.deps.readFile(doc.uri.fsPath, 3 * text.length + 3);
    if (this.tracked.get(doc.uri.toString()) !== t || doc.isClosed || doc.isDirty || doc.version !== version) {
      return;
    }
    if (disk !== undefined && sameText(disk, text)) {
      t.unconfirmed = false;
      if (t.generation > 0) {
        // A check was started for it (module comment, *Changes on disk*): not only one that
        // completed (*verification after Q20–Q22*: a document whose first check failed kept
        // "checking failed" through a reload of a fixed text).
        this.reloaded(doc, t);
      }
      this.changed.fire();
    }
  }

  /**
   * VS Code reloaded a clean document from its changed file (module comment, *Changes on disk*).
   * While a check runs, the text is compared with the one it started with (its result comes);
   * otherwise with the one the last completed check read.
   */
  private reloaded(doc: vscode.TextDocument, t: Tracked): void {
    const hash = textHash(doc.getText());
    const again = this.deps.trust.isTrusted && this.trigger(doc) !== 'manual';
    if (hash === t.checkedHash) {
      // The text the last completed check read: its result applies (until a running check's replaces it).
      t.checkedVersion = doc.version;
    }
    if (t.loadState === 'loading') {
      if (hash !== t.sentHash && again) {
        void this.check(doc); // the running check read another text
      }
    } else if (hash !== t.checkedHash && hash !== t.sentHash && again) {
      // (The text of a check that was cancelled, failed or refused is not checked again by itself.)
      void this.check(doc);
    }
  }

  private closed(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const t = this.tracked.get(key);
    if (this.lastActive !== undefined && this.lastActive.uri.toString() === key) {
      this.lastActive = undefined;
    }
    if (t === undefined) {
      // Never checked here: what other loads gave it stays, as for a file that is not open — unless
      // the root whose load gave it was released meanwhile (`release` keeps what open files show).
      const by = this.appliedBy.get(key);
      if (by !== undefined && !this.neededKey(by)) {
        this.forget(doc.uri);
      }
      return;
    }
    this.stopTimer(t);
    this.tracked.delete(key);
    this.dropWaiting((w) => w.t === t, DROPPED);
    if (isIdrisDocument(doc)) {
      const shown = this.collection.get(doc.uri);
      if (shown !== undefined && this.reported.has(key) && !doc.isDirty && t.checkedVersion === doc.version) {
        this.closedReports.set(key, { hash: textHash(doc.getText()), diagnostics: [...shown] });
      }
      this.forget(doc.uri);
    }
    if (t.root !== undefined && !this.needed(t.root)) {
      this.release(t.root);
    }
    this.noteActiveRoot();
    // Another document may be the active one now (or none): a check that started as this one's
    // counts as a background check from now on (*M2 verification of the Q20–Q22 fixes*: closing the
    // active document while a non-Idris editor was active left its running check uncounted, and one
    // more background check started than the limit).
    this.recount();
    this.changed.fire();
  }

  /** Removes a file's diagnostics from the collection and from what this window knows it showed. */
  private forget(file: vscode.Uri): void {
    const key = file.toString();
    this.reported.delete(key);
    this.applied.delete(key);
    this.appliedBy.delete(key);
    this.collection.delete(file);
  }

  /**
   * No checked document of `root` is left: its sessions stop, and the diagnostics its loads set on
   * files that are not open (its `.ipkg`, imported files) go with them. An open file keeps what it
   * shows — one no trigger checked itself, e.g. with `manual` (*M2 verification of the third
   * review*: its errors vanished while it was open) — until it is checked or closed.
   */
  private release(root: Classification): void {
    this.deps.roots.release(root);
    const key = rootKey(root);
    const open = new Set(this.api.workspace.textDocuments.map((doc) => doc.uri.toString()));
    const gone: vscode.Uri[] = [];
    this.collection.forEach((file) => {
      const uri = file.toString();
      if (this.appliedBy.get(uri) === key && !this.tracked.has(uri) && !open.has(uri)) {
        gone.push(file);
      }
    });
    gone.forEach((file) => this.forget(file));
  }

  /**
   * Whether a tracked document may still need the sessions of `root`: one that belongs to it,
   * or one whose check is still classifying it.
   */
  private needed(root: Classification): boolean {
    return this.neededKey(rootKey(root));
  }

  /** `needed` by the root's key (`rootKey`). */
  private neededKey(key: string): boolean {
    return [...this.tracked.values()].some((other) =>
      other.root === undefined ? other.loadState === 'loading' : rootKey(other.root) === key,
    );
  }

  private deleted(uri: vscode.Uri): void {
    const prefix = uri.toString();
    const below = (text: string): boolean => atOrBelow(prefix, text);
    if (this.inFlight.size > 0) {
      // The checks running now may have read what was there: their results are not shown at or
      // below it (`apply`).
      this.deletions.push({ prefix, after: this.sequence });
    }
    const gone: vscode.Uri[] = [];
    this.collection.forEach((entry) => {
      if (below(entry.toString())) {
        gone.push(entry);
      }
    });
    gone.forEach((entry) => this.forget(entry));
    for (const key of [...this.reported, ...this.closedReports.keys()]) {
      if (below(key)) {
        this.reported.delete(key);
        this.closedReports.delete(key);
      }
    }
    // An open document of a deleted file has no result any more.
    for (const [key, t] of this.tracked) {
      if (below(key)) {
        t.settled = 'idle';
        if (t.loadState !== 'loading') {
          t.loadState = 'idle';
        }
        t.packageError = undefined;
        t.failure = undefined;
        t.checkedVersion = undefined;
        t.checkedHash = undefined;
        t.deleted = true;
        t.deletions++;
        t.blockedBy = [];
      }
    }
    this.changed.fire();
  }

  /** A file or folder was created: an open document there whose file had been deleted is checked again. */
  private created(uri: vscode.Uri): void {
    const prefix = uri.toString();
    for (const [key, t] of this.tracked) {
      if (t.deleted && atOrBelow(prefix, key) && isCheckable(t.document) && this.trigger(t.document) !== 'manual') {
        t.deleted = false;
        void this.check(t.document);
      }
    }
  }

  /** A root's session serves again after an automatic restart (module comment). */
  private restarted(root: Classification, cause: 'reconfigure' | 'crash'): void {
    const key = rootKey(root);
    const batch = newBatch();
    for (const doc of this.visibleDocuments()) {
      const t = this.tracked.get(doc.uri.toString());
      if (t?.root === undefined || rootKey(t.root) !== key || !isCheckable(doc) || this.trigger(doc) === 'manual') {
        continue;
      }
      if (cause === 'crash') {
        if (t.loadState !== 'failed' || t.retriedAfterCrash) {
          continue;
        }
        t.retriedAfterCrash = true;
      }
      void this.check(doc, batch);
    }
  }

  private consentChanged(): void {
    this.changed.fire();
    // A background check waiting for a slot was let in while its folder was allowed (it asked
    // first, `askFirst`); one whose folder is not allowed any more (revoked) is refused, as the
    // session rejects its queue then (module comment, *Background checks*).
    this.dropWaiting((w) => this.deps.consent.current(this.deps.projects.sessionCwd(w.root))?.allowed !== true, REFUSED);
    this.recount();
    const batch = newBatch();
    for (const doc of this.visibleDocuments()) {
      const t = this.tracked.get(doc.uri.toString());
      if (t?.refused === true && t.root !== undefined && this.deps.consent.current(this.deps.projects.sessionCwd(t.root))?.allowed) {
        void this.check(doc, batch);
      }
    }
  }

  // --- checking ------------------------------------------------------------------------------

  /**
   * Loads `doc` into its root's backend and shows the result. Resolves when the result is shown
   * (or dropped), with the refusal when the consent gate refused the load; never rejects:
   * failures become the document's state and a log line.
   */
  check(doc: vscode.TextDocument, options: CheckOptions = {}): Promise<CheckRefusal | undefined> {
    const promise = this.checkNow(doc, options);
    // `checkNow` has tracked the document (and counted its generation) before its first wait.
    const t = this.tracked.get(doc.uri.toString());
    if (t !== undefined) {
      t.newest = promise;
      void promise.then(() => {
        if (t.newest === promise) {
          t.newest = undefined;
        }
      });
    }
    return promise;
  }

  /**
   * The newest check of `doc` while it runs (the promise `check` returned), or `undefined`. For a
   * query that found the file not loaded (`features/intelligence/queries.ts`): it waits for this
   * check instead of starting another, which would load the file a second time once this one is
   * done (integration after the third review of M3: a hover right after a file was opened, while
   * its check classified it, made two `:load-file` of it [live, the packaged-extension check]).
   */
  runningCheck(doc: vscode.TextDocument): Promise<CheckRefusal | undefined> | undefined {
    return this.tracked.get(doc.uri.toString())?.newest;
  }

  private async checkNow(doc: vscode.TextDocument, options: CheckOptions): Promise<CheckRefusal | undefined> {
    if (!this.deps.trust.isTrusted || !isCheckable(doc)) {
      return undefined;
    }
    const batch = options.batch;
    /** The active document's check, started last of a batch on purpose (`CheckOptions.batch`). */
    const lastOfBatch = batch !== undefined && this.isActive(doc);
    const key = doc.uri.toString();
    const t = this.track(doc);
    const generation = ++t.generation;
    const sequence = ++this.sequence;
    /** Not closed since: its results still apply. */
    const open = (): boolean => this.tracked.get(key) === t;
    /** The newest check of the document: it sets the state. */
    const current = (): boolean => open() && t.generation === generation;
    // The compiler reads the saved file: with unsaved changes the document's text is not what it
    // checks, nor is it known to be while a text change of a clean-looking document is not settled
    // (module comment, *Changes on disk*); then the file is read, as the compiler will read it.
    const saved = !doc.isDirty && !t.unconfirmed;
    /** Clean, but its text not matched with the file's (a reload of a file that is not UTF-8, *Changes on disk*). */
    const unmatched = !doc.isDirty && t.unconfirmed;
    const startVersion = doc.version;
    const version = saved ? doc.version : undefined;
    /** Its file's deletions so far: one after this point keeps this check's result off the document. */
    const deletions = t.deletions;
    let hash = saved ? textHash(doc.getText()) : undefined;
    t.sentHash = hash;
    t.loadState = 'loading';
    t.refused = false;
    /** The check's load was let through (`admission`): counted in `running` until it ends. */
    let run: RunningCheck | undefined;
    this.noteActiveRoot(); // the active document's root is `pending` until classified
    this.changed.fire();
    this.inFlight.add(sequence);
    try {
      const [root, disk] = await Promise.all([
        this.deps.projects.classify(doc.fileName),
        saved ? undefined : this.deps.readFile(doc.uri.fsPath, Math.max(UNSAVED_READ_BYTES, 3 * doc.getText().length + 3)).catch(() => undefined),
      ]);
      if (!current()) {
        return undefined;
      }
      if (!saved) {
        hash = disk === undefined ? undefined : textHash(disk);
        t.sentHash = hash;
      }
      const previous = t.root;
      t.root = root;
      if (previous !== undefined && rootKey(previous) !== rootKey(root) && !this.needed(previous)) {
        // Its package file was created, renamed or removed: no open document needs the old root.
        this.release(previous);
      }
      this.noteActiveRoot();
      this.changed.fire();
      // A background check may wait for its folder's answer and for a slot (module comment);
      // without a limit, and for the active document, it is let through at once, nothing awaited.
      const pending = this.admission(t, doc, root, current);
      const admitted = pending instanceof Promise ? await pending : pending;
      run = admitted.go ? admitted.run : undefined;
      if (!admitted.go || !current()) {
        if (!admitted.go && admitted.why !== 'dropped' && current()) {
          // Not loaded, as a load the session rejected for the same reason: the previous state stays.
          t.loadState = t.settled;
          t.refused = admitted.why === 'refused';
          this.deps.log.info(
            `Not checked: ${doc.fileName}: ${admitted.why === 'refused' ? 'the permission for its folder was withdrawn while it waited for a slot' : 'Stop Backend'}`,
          );
        }
        return undefined;
      }
      // While a limit is set, the active document's load goes before the root's loads that wait
      // (module comment, *Background checks*), unless a batch queued it last, after a load of the
      // batch in its root that has not settled now (`CheckOptions.batch`: decided here, once); without
      // a limit the backend's queue is as before.
      const batchRoot = rootKey(root);
      const queuedLast = lastOfBatch && batch.pending(batchRoot);
      batch?.handedOver(batchRoot);
      let result: LoadResult;
      try {
        result = await this.deps.registry
          .backendFor(root)
          .load(doc, { urgent: () => !queuedLast && this.deps.config.ideMode().maxBackgroundChecks > 0 && this.isActive(doc) });
      } finally {
        batch?.settled(batchRoot);
      }
      if (!open()) {
        return undefined;
      }
      // Its file was deleted while the check ran: the result is not shown on it (a deleted file
      // reads as not checked, and its creation checks it again; *verification after Q20–Q22*: the
      // result cleared `deleted`, so the creation checked nothing).
      const deletedMeanwhile = t.deletions !== deletions;
      const determined = this.apply(result, sequence, root);
      if (!current()) {
        // A newer check of this document is waiting for its own result (module comment, "Results").
        this.unblock(root, determined, doc);
        this.changed.fire();
        return undefined;
      }
      if (deletedMeanwhile) {
        t.loadState = t.settled;
        this.unblock(root, determined, doc);
        return undefined;
      }
      const kept = this.closedReports.get(key);
      if (!this.reported.has(key) && kept !== undefined && kept.hash === hash) {
        // Determined by nothing this time (a fresh TTC, F7): what the document showed when it
        // was closed, for this very text, still applies.
        this.collection.set(doc.uri, [...kept.diagnostics]);
        this.applied.set(key, sequence);
        this.appliedBy.set(key, rootKey(root));
        this.reported.add(key);
        this.closedReports.delete(key);
      }
      t.packageError = result.packageError && { ipkg: result.packageError.uri.fsPath, message: result.packageError.message };
      t.failure = undefined;
      // The document shows the text the check read (also after an undo back to it while the check
      // ran, or when it started with unsaved changes that were undone meanwhile): that version. So
      // does a clean document unchanged since a check that started with its text not matched with
      // the file's (VS Code decoded the file otherwise): the check read the file it shows. Otherwise
      // the version it started with, or none (then `statusOf` compares the text with `checkedHash`).
      const shows = !doc.isDirty && ((hash !== undefined && textHash(doc.getText()) === hash) || (unmatched && doc.version === startVersion));
      t.checkedVersion = shows ? doc.version : version;
      t.checkedHash = hash;
      t.deleted = false;
      t.retriedAfterCrash = false;
      t.blockedBy = result.blockedBy ?? [];
      t.settled = t.packageError !== undefined ? 'ipkgError' : 'checked';
      t.loadState = t.settled;
      this.unblock(root, determined, doc);
      return undefined;
    } catch (error) {
      if (!current()) {
        return undefined;
      }
      if (error instanceof IdrisException && error.error.kind === 'Unsupported') {
        // The consent gate refused (or Restricted Mode began, or the backend does not check): nothing ran.
        t.loadState = t.settled;
        t.refused = true;
        const message = errorText(error.error);
        this.deps.log.info(`Not checked: ${doc.fileName}: ${message}`);
        const dir = t.root === undefined ? undefined : this.deps.projects.sessionCwd(t.root);
        const verdict = dir === undefined ? undefined : this.deps.consent.current(dir);
        const askable = verdict !== undefined && !verdict.allowed && (verdict.reason === 'denied' || verdict.reason === 'unanswered');
        return { message, dir: askable ? dir : undefined };
      } else if (isCancelled(error)) {
        // Abandoned by a stop or a restart, not failed: what was shown stays.
        t.loadState = t.settled;
        this.deps.log.info(`Not checked: ${doc.fileName}: ${(error as Error).message}`);
      } else {
        t.settled = 'failed';
        t.loadState = 'failed';
        t.failure = error instanceof IdrisException ? errorText(error.error) : String(error);
        this.deps.log.warn(`Checking ${doc.fileName} failed: ${t.failure}`);
      }
      return undefined;
    } finally {
      this.inFlight.delete(sequence);
      // A deletion is kept while a check that started before it runs.
      const oldest = Math.min(...this.inFlight);
      this.deletions.splice(0, this.deletions.length, ...this.deletions.filter((d) => d.after >= oldest));
      if (run !== undefined) {
        this.running.delete(run);
        this.drain();
      }
      if (current()) {
        this.noteActiveRoot(); // a check that found no root (it failed) leaves none
        this.changed.fire();
      }
    }
  }

  // --- the active document and background checks (module comment) -----------------------------

  /**
   * The documents of the visible editors, the active document last (module comment, *The active
   * document*): the checks that start several of them at once queue their loads in this order, and
   * a root's compiler answers about the file it loaded last (F27), which a passive query loads only
   * when it is the active document (`features/intelligence` `DocumentQueries`). Until the fourth
   * review of M3 they were in the editors' order, so the active file, loaded before another file of
   * its root, was loaded once more for its first hover or inlay hints, and the other file's queries
   * were refused [unit-level].
   */
  private visibleDocuments(): vscode.TextDocument[] {
    const docs = this.api.window.visibleTextEditors.map((e) => e.document);
    const active = this.activeDocument()?.uri.toString();
    return [...docs.filter((d) => d.uri.toString() !== active), ...docs.filter((d) => d.uri.toString() === active)];
  }

  /** The active document (module comment, *The active document*); public for the test API. */
  activeDocument(): vscode.TextDocument | undefined {
    const doc = this.api.window.activeTextEditor?.document;
    return doc !== undefined && isCheckable(doc) ? doc : this.lastActive;
  }

  private isActive(doc: vscode.TextDocument): boolean {
    return this.activeDocument()?.uri.toString() === doc.uri.toString();
  }

  /**
   * The active editor changed: remember its document, start a waiting check of it, count the
   * running checks again (the one of the document that was active is a background check now), tell
   * the backend its root.
   */
  private activeChanged(): void {
    const doc = this.api.window.activeTextEditor?.document;
    if (doc !== undefined && isCheckable(doc)) {
      if (this.lastActive !== doc) {
        this.activeClassification = undefined; // classified again when it becomes the active one (its package may have changed)
      }
      this.lastActive = doc;
      const key = doc.uri.toString();
      const index = this.waiting.findIndex((w) => w.t.document.uri.toString() === key);
      if (index >= 0) {
        // Promoted: it starts now, without a slot.
        const promoted = this.waiting.splice(index, 1)[0];
        promoted.start(this.admit(promoted.t, promoted.root, false));
      }
    }
    this.recount();
    this.noteActiveRoot();
  }

  /**
   * Tells the backend the active document's root when it changed (`ActiveRoot`): `pending` while
   * a check of it has not classified it yet (*verification after Q20–Q22*: `undefined` then let
   * `maxSessions` stop the idle session of the root of a file just opened in it).
   */
  private noteActiveRoot(): void {
    const doc = this.activeDocument();
    const t = doc === undefined ? undefined : this.tracked.get(doc.uri.toString());
    const root: Classification | 'pending' | undefined =
      t?.root ?? (t?.loadState === 'loading' ? 'pending' : doc === undefined ? undefined : this.classifiedActive(doc));
    const key = root === undefined || root === 'pending' ? root : rootKey(root);
    if (key !== this.activeRootKey) {
      this.activeRootKey = key;
      this.deps.roots.setActiveRoot(root);
    }
  }

  /**
   * The root of an active document that no check has classified (module comment, *The active
   * document*): classified here, again each time another document becomes the active one;
   * `pending` until then, `undefined` if that fails (*M2 verification of the Q20–Q22 fixes*: with
   * the `manual` trigger such a document had no root, so the backend was told none, and
   * `maxSessions` could stop the idle session of its very project, e.g. one that **Check File** on
   * another of its files had started).
   */
  private classifiedActive(doc: vscode.TextDocument): Classification | 'pending' | undefined {
    if (doc.isClosed) {
      return undefined; // (VS Code may report the close before the active editor's change)
    }
    const key = doc.uri.toString();
    if (this.activeClassification?.key !== key) {
      const entry: { readonly key: string; root: Classification | 'pending' | undefined } = { key, root: 'pending' };
      this.activeClassification = entry;
      const settle = (root: Classification | undefined): void => {
        if (this.activeClassification === entry && !this.store.isDisposed) {
          entry.root = root;
          this.noteActiveRoot();
        }
      };
      this.deps.projects.classify(doc.fileName).then(settle, () => settle(undefined));
    }
    return this.activeClassification.root;
  }

  /** `idris2.ideMode.maxBackgroundChecks` as it applies to a check of `doc`: `0` (none) for the active document. */
  private limitFor(doc: vscode.TextDocument): number {
    const max = this.deps.config.ideMode().maxBackgroundChecks;
    return max > 0 && !this.isActive(doc) ? max : 0;
  }

  /**
   * Whether a check of `doc` in `root` counts against the limit (module comment, *Background
   * checks*): a limit is set, `doc` is not the active document, and the gate neither refuses the
   * folder (the load is refused at once and starts nothing) nor has its question open (the load
   * waits for the user, not for the compiler). A folder the gate has not judged yet counts.
   */
  private countsAgainstLimit(doc: vscode.TextDocument, root: Classification): boolean {
    const dir = this.deps.projects.sessionCwd(root);
    return this.limitFor(doc) > 0 && !this.deps.consent.asking(dir) && this.deps.consent.current(dir)?.allowed !== false;
  }

  /** The running checks that count against the limit. */
  private heldSlots(): number {
    let held = 0;
    this.running.forEach((run) => (held += run.holds ? 1 : 0));
    return held;
  }

  /** Lets the check of `t` load: it runs, counted when `holds`, until it ends. */
  private admit(t: Tracked, root: Classification, holds: boolean): Admission {
    const run: RunningCheck = { t, root, holds };
    this.running.add(run);
    return { go: true, run };
  }

  /**
   * Whether the check of `doc` (tracked as `t`, in `root`) loads, and when (module comment,
   * *Background checks*): at once without a limit and for the active document; a background check
   * of a folder the gate has no verdict for yet first waits for the answer (`permit`), outside the
   * slots; then as `slotFor` says. Returned as a promise while it waits.
   */
  private admission(t: Tracked, doc: vscode.TextDocument, root: Classification, current: () => boolean): Admission | Promise<Admission> {
    if (this.limitFor(doc) > 0 && this.deps.consent.current(this.deps.projects.sessionCwd(root)) === undefined) {
      return this.askFirst(t, doc, root, current);
    }
    return this.slotFor(t, doc, root);
  }

  /**
   * Asks the gate about the folder of a background check before it takes a slot (*verification
   * after Q20–Q22*: the question, which can wait in the notification centre for good, held the
   * slot, and every other background check waited with it). The load asks again and gets the same
   * verdict at once. First the backend says whether the load would be refused without any question
   * (`LoadPreflight`); then nothing is asked, and the load goes at once, without a slot.
   */
  private async askFirst(t: Tracked, doc: vscode.TextDocument, root: Classification, current: () => boolean): Promise<Admission> {
    const asking: AskingCheck = { root, cancelled: false };
    this.askingFirst.add(asking);
    /** Why the load would be refused before any question (`LoadPreflight`). */
    let refused: string | undefined;
    try {
      // Nothing is asked for a load that is refused before the question anyway, as without a
      // limit (*M2 verification of the Q20–Q22 fixes*: the question came before the checks that the
      // backend and the pool make first — no compiler, `extraArgs`, a path the compiler misreads, a
      // package file other than the root's — and after Allow the load was refused all the same).
      refused = await this.deps.roots.refusalBeforeQuestion(doc, root);
      if (refused === undefined && !asking.cancelled && current()) {
        await this.deps.consent.permit(this.deps.projects.sessionCwd(root), { ipkg: root.kind === 'project' ? root.ipkgPath : undefined });
      }
    } catch {
      // The load asks again and reports what goes wrong.
    } finally {
      this.askingFirst.delete(asking);
    }
    if (asking.cancelled) {
      return CANCELLED;
    }
    if (!current()) {
      return DROPPED;
    }
    // A load refused anyway starts nothing: it goes at once, and is refused as it would be without a limit.
    return refused !== undefined ? this.admit(t, root, false) : this.slotFor(t, doc, root);
  }

  /**
   * The slot step: load at once when no limit applies (none is set, the active document), when the
   * gate refuses the folder (the load is refused at once and starts nothing), or when a slot is
   * free; else — returned as a promise — wait in line for one, in the place of an older
   * waiting check of the same document if there is one (which is dropped).
   */
  private slotFor(t: Tracked, doc: vscode.TextDocument, root: Classification): Admission | Promise<Admission> {
    const max = this.limitFor(doc);
    const index = this.waiting.findIndex((w) => w.t === t);
    const older = index >= 0 ? this.waiting[index] : undefined;
    const holds = this.countsAgainstLimit(doc, root);
    if (!holds || this.heldSlots() < max) {
      if (older !== undefined) {
        this.waiting.splice(index, 1);
        older.start(DROPPED);
      }
      return this.admit(t, root, holds);
    }
    return new Promise<Admission>((resolve) => {
      const place: WaitingCheck = { t, root, start: resolve };
      if (older !== undefined) {
        this.waiting[index] = place;
        older.start(DROPPED);
      } else {
        this.waiting.push(place);
      }
    });
  }

  /** Starts waiting checks while slots are free (all of them when there is no limit any more). */
  private drain(): void {
    const max = this.deps.config.ideMode().maxBackgroundChecks;
    while (this.waiting.length > 0 && (max <= 0 || this.heldSlots() < max)) {
      const next = this.waiting.shift() as WaitingCheck;
      next.start(this.admit(next.t, next.root, this.countsAgainstLimit(next.t.document, next.root)));
    }
  }

  /**
   * Counts the running checks again — after the active document, the limit or a folder's verdict
   * changed — and starts waiting ones if slots are free. A check that started as the active
   * document's counts once another document is active (*verification after Q20–Q22*: it did not,
   * so more background checks ran than the limit), and so does one that started without a limit
   * once one is set; nothing that runs is stopped.
   */
  private recount(): void {
    this.running.forEach((run) => (run.holds = this.countsAgainstLimit(run.t.document, run.root)));
    this.drain();
  }

  /** Ends the wait of the waiting checks `which` selects with `admission` (they do not load). */
  private dropWaiting(which: (w: WaitingCheck) => boolean, admission: Admission): void {
    const dropped: WaitingCheck[] = [];
    const kept: WaitingCheck[] = [];
    this.waiting.forEach((w) => (which(w) ? dropped : kept).push(w));
    if (dropped.length > 0) {
      this.waiting.splice(0, this.waiting.length, ...kept);
      dropped.forEach((w) => w.start(admission));
    }
  }

  /**
   * **Stop Backend** (module comment, *Background checks*): the background checks of `root`, or of
   * every root, that wait for a slot or for the answer about their folder do not load; the previous
   * state stays (*verification after Q20–Q22*: a waiting check took the slot the stop freed and
   * started the stopped compiler again).
   */
  cancelWaiting(root?: Classification): void {
    const key = root === undefined ? undefined : rootKey(root);
    const of = (other: Classification): boolean => key === undefined || rootKey(other) === key;
    this.askingFirst.forEach((asking) => (asking.cancelled ||= of(asking.root)));
    this.dropWaiting((w) => of(w.root), CANCELLED);
  }

  /**
   * Sets the diagnostics of each file `result` determined, unless a check that started later has
   * already set them (module comment, "Results"), or it lies at or below a file or folder deleted
   * since this check started (`deletions`; *M2 verification of the Q20–Q22 fixes*: only the checked
   * document's own file was left out, so a folder deleted while a check ran — a checkout — got the
   * late result back on its other files, e.g. imported modules not open); returns the files it set.
   */
  private apply(result: LoadResult, sequence: number, root: Classification): ReadonlyMap<string, vscode.Uri> {
    const set = new Map<string, vscode.Uri>();
    const deleted = this.deletions.filter((d) => d.after >= sequence);
    for (const [file, diagnostics] of result.diagnostics) {
      const key = file.toString();
      if ((this.applied.get(key) ?? 0) > sequence || deleted.some((d) => atOrBelow(d.prefix, key))) {
        continue;
      }
      this.collection.set(file, [...diagnostics]);
      this.applied.set(key, sequence);
      this.appliedBy.set(key, rootKey(root));
      this.reported.add(key);
      this.closedReports.delete(key);
      set.set(key, file);
    }
    return set;
  }

  /**
   * Checks again the visible documents of `root` that were not checked because of errors in files
   * they import, when this load (of `loaded`) found one of those files clean (module comment).
   */
  private unblock(root: Classification, determined: ReadonlyMap<string, vscode.Uri>, loaded: vscode.TextDocument): void {
    const key = rootKey(root);
    const batch = newBatch();
    for (const doc of this.visibleDocuments()) {
      const t = this.tracked.get(doc.uri.toString());
      if (doc === loaded || t?.root === undefined || rootKey(t.root) !== key || t.loadState === 'loading') {
        continue;
      }
      const fixed = t.blockedBy.some((file) => determined.has(file.toString()) && this.errorCount(file) === 0);
      if (fixed && isCheckable(doc) && this.trigger(doc) !== 'manual') {
        void this.check(doc, batch);
      }
    }
  }

  /**
   * Checks the visible documents of `root` (or of every root) again, unless their trigger is
   * `manual` (after **Restart Backend** and a notice's **Restart**).
   */
  async recheckVisible(root?: Classification): Promise<void> {
    const docs = this.visibleDocuments().filter((d) => isCheckable(d) && this.trigger(d) !== 'manual');
    const batch = newBatch();
    await Promise.all(
      docs.map(async (doc) => {
        if (root === undefined || rootKey(await this.deps.projects.classify(doc.fileName)) === rootKey(root)) {
          await this.check(doc, batch);
        }
      }),
    );
  }

  /** The document's state, for the test API and the unit tests. */
  loadStateOf(doc: vscode.TextDocument): LoadState | undefined {
    const state = this.tracked.get(doc.uri.toString())?.loadState;
    if (state !== 'checked') {
      return state;
    }
    const { errors, warnings } = this.counts(doc.uri);
    return errors > 0 ? 'errors' : warnings > 0 ? 'warnings' : 'ok';
  }

  /** The errors and warnings the collection shows for `file`. */
  private counts(file: vscode.Uri): { readonly errors: number; readonly warnings: number } {
    const shown = this.collection.get(file) ?? [];
    return {
      errors: shown.filter((d) => d.severity === this.api.DiagnosticSeverity.Error).length,
      warnings: shown.filter((d) => d.severity === this.api.DiagnosticSeverity.Warning).length,
    };
  }

  statusOf(doc: vscode.TextDocument, root: Classification | undefined): CheckStatus | undefined {
    if (!isCheckable(doc)) {
      return undefined;
    }
    const t = this.tracked.get(doc.uri.toString());
    const theRoot = root ?? t?.root;
    const backend: BackendState | undefined = this.deps.registry.stateFor(theRoot);
    if (backend?.kind === 'notAllowed') {
      return { kind: 'notAllowed', dir: backend.dir, reason: backend.reason };
    }
    // The question about the directory is open (a check waits for it, or Allow… asked again): the
    // status waits for it too, and its Allow… link shows the question again.
    const dir = theRoot === undefined ? undefined : this.deps.projects.sessionCwd(theRoot);
    if (dir !== undefined && this.deps.consent.asking(dir)) {
      return { kind: 'checking', waitingFor: dir };
    }
    if (t?.loadState === 'loading') {
      return { kind: 'checking', waitingFor: undefined };
    }
    if (backend?.kind === 'failed') {
      return { kind: 'backendFailed', reason: backend.reason };
    }
    if (backend?.kind === 'stopped') {
      return backend.revokedDir === undefined ? { kind: 'stopped' } : { kind: 'stopped', revokedDir: backend.revokedDir };
    }
    if (t === undefined || t.loadState === 'idle') {
      return { kind: 'notChecked' };
    }
    // Unsaved changes, or a text changed on disk since the check (module comment): a version other
    // than the one that shows the checked text, or, when none is known to (the check started with
    // unsaved changes, or with a text not matched with the file's), a text other than the one it
    // read (*verification after Q20–Q22*: no version meant never `stale`).
    const stale =
      doc.isDirty ||
      (t.checkedVersion !== undefined ? t.checkedVersion !== doc.version : t.checkedHash !== undefined && textHash(doc.getText()) !== t.checkedHash);
    const staleness = (): Staleness => ({ unsaved: doc.isDirty, manual: this.trigger(doc) === 'manual' });
    switch (t.loadState) {
      case 'failed':
        return { kind: 'loadFailed', reason: t.failure ?? 'the compiler did not answer' };
      case 'ipkgError': {
        const error = { kind: 'packageError', ipkg: t.packageError?.ipkg ?? '', message: t.packageError?.message ?? '', stale } as const;
        return stale ? { ...error, staleness: staleness() } : error;
      }
      default: {
        const checked = { kind: 'checked', ...this.counts(doc.uri), stale, known: this.reported.has(doc.uri.toString()) } as const;
        return stale ? { ...checked, staleness: staleness() } : checked;
      }
    }
  }

  dispose(): void {
    this.store.dispose();
    this.tracked.clear();
  }
}
