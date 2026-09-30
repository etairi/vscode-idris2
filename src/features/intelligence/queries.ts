/**
 * `DocumentQueries` (`types.ts`): asks a document's backend a question that needs the document's
 * file loaded, loading it first — the way **Check File** does — when the backend answers
 * `NotLoaded`; `AnswerCache`, the answers kept per file; and `StaleAnswers`, which loads make
 * which files' kept answers stale (also for completion and inlay hints).
 *
 * Only type imports from `vscode`; unit-tested against fakes of the deps.
 */
import type * as vscode from 'vscode';
import { rootKey } from '../../backend/registry';
import type { IdrisBackend } from '../../backend/types';
import type { IDisposable } from '../../core/disposable';
import { errorText, IdrisException, isCancelled } from '../../core/errors';
import type { Classification } from '../../project/types';
import { isCheckable, type CheckRefusal } from '../diagnostics/checks';
import type { DocumentQueries, DocumentQueriesDeps, LoadedFileEvent, LoadNotifications, QueryMode, QueryOutcome } from './types';

const RESTRICTED = 'Restricted Mode: the compiler is not run in a workspace that is not trusted.';
const NOT_A_FILE = 'The document is not a file on disk: save it first.';

function unavailable<T>(reason: string): QueryOutcome<T> {
  return { kind: 'unavailable', reason };
}

type Attempt<T> = { readonly kind: 'done'; readonly outcome: QueryOutcome<T> } | { readonly kind: 'notLoaded'; readonly message: string };

/**
 * The implementation of `DocumentQueries` (its contract, steps 1–3, is in `types.ts`). Loads that
 * several queries of one document need at once are one `checks.check(doc)`: a hover, a
 * definition and the semantic tokens of a document that is not loaded ask together. A check of the
 * document that is already running (the one its opening started, still classifying it) is that
 * load: the queries wait for it (`DocumentChecks.runningCheck`) rather than load the file again
 * after it.
 */
export function createDocumentQueries(deps: DocumentQueriesDeps): DocumentQueries {
  const loading = new Map<string, Promise<CheckRefusal | undefined>>();

  const load = (doc: vscode.TextDocument): Promise<CheckRefusal | undefined> => {
    const key = doc.uri.toString();
    let pending = loading.get(key);
    if (pending === undefined) {
      pending = (deps.checks.runningCheck(doc) ?? deps.checks.check(doc)).finally(() => loading.delete(key));
      loading.set(key, pending);
    }
    return pending;
  };

  const attempt = async <T>(backend: IdrisBackend, query: (backend: IdrisBackend) => Promise<T>): Promise<Attempt<T>> => {
    try {
      return { kind: 'done', outcome: { kind: 'answer', value: await query(backend) } };
    } catch (error) {
      if (error instanceof IdrisException) {
        return error.error.kind === 'NotLoaded'
          ? { kind: 'notLoaded', message: error.error.message }
          : { kind: 'done', outcome: unavailable(errorText(error.error)) };
      }
      if (isCancelled(error)) {
        return { kind: 'done', outcome: unavailable((error as Error).message) };
      }
      throw error;
    }
  };

  /** Why a `passive` query must not load `doc` (`types.ts`, step 3), or `undefined` when it may. */
  const passiveRefusal = (doc: vscode.TextDocument, root: Classification): string | undefined => {
    if (deps.checks.activeDocument()?.uri.toString() !== doc.uri.toString()) {
      return 'The file is not loaded, and only the active editor\'s file is loaded to answer the editor by itself.';
    }
    const state = deps.registry.stateFor(root);
    if (state?.kind !== 'none' && state?.kind !== 'active') {
      return 'The file is not loaded, and the compiler of its project is not running (Idris 2: Restart Backend starts it).';
    }
    if (deps.config.checking(doc.uri).trigger === 'manual') {
      return 'The file is not loaded: with manual checking, Idris 2: Check File loads it.';
    }
    return undefined;
  };

  const run = async <T>(
    doc: vscode.TextDocument,
    mode: QueryMode,
    query: (backend: IdrisBackend) => Promise<T>,
  ): Promise<QueryOutcome<T>> => {
    if (!deps.trust.isTrusted) {
      return unavailable(RESTRICTED);
    }
    if (!isCheckable(doc)) {
      return unavailable(NOT_A_FILE);
    }
    const root = await deps.projects.classify(doc.fileName);
    const first = await attempt(deps.registry.backendFor(root), query);
    if (first.kind === 'done') {
      return first.outcome;
    }
    const refused = mode === 'passive' ? passiveRefusal(doc, root) : undefined;
    if (refused !== undefined) {
      deps.log.debug(`Intelligence: ${doc.fileName}: ${refused}`);
      return unavailable(refused);
    }
    const refusal = await load(doc);
    if (refusal !== undefined) {
      return unavailable(refusal.message);
    }
    const second = await attempt(deps.registry.backendFor(root), query);
    return second.kind === 'done' ? second.outcome : unavailable(second.message);
  };

  return { run };
}

/**
 * Which files' kept answers a load makes stale (`LoadNotifications`; *review of M3*). An answer
 * about a file depends on the file and on the modules it imports, so a load that may have changed
 * what the compiler answers (`rebuilt`: it built a module, failed, or was its process's first)
 * makes the answers about every file of its root stale — a dependency edited and saved is loaded
 * by itself, and the files that import it are not checked again. A load that built nothing keeps
 * them all, the loaded file's included: the compiler answers from the same build files as before.
 * The root of each file is learnt from the loads (every file with answers was loaded: a query is
 * answered only while its file is the one loaded); `forget` drops a closed document's.
 */
export class StaleAnswers {
  private readonly roots = new Map<string, string>();

  /** The files whose kept answers `loaded` makes stale (see the class comment). */
  after(loaded: LoadedFileEvent): readonly string[] {
    const key = rootKey(loaded.root);
    this.roots.set(loaded.file, key);
    return loaded.rebuilt ? [...this.roots].filter(([, root]) => root === key).map(([file]) => file) : [];
  }

  forget(file: string): void {
    this.roots.delete(file);
  }
}

/**
 * Answers kept per file (`types.ts` `DocumentQueries`, *The providers keep answers per file*): an
 * entry stays until a load makes it stale (`StaleAnswers`) or the file's document closes
 * (`forget`). Only answers are kept; an `unavailable` outcome is asked again next time (the file
 * may be loaded by then). A pending question is shared by those who ask it meanwhile.
 *
 * Not reset when the registry reports a change (`BackendRegistry.onDidChange`): IDE mode reports
 * every request that way (each state change of a `check` session fires it — `ready` → `busy` when
 * a request is sent, `busy` → `ready` at its reply; `session.ts` `setState`, `pool.ts`, `IdeMode`
 * in `backend/ide/backend.ts` [src]), which would empty the cache at every answer. An answer stays
 * true of the file as the load it came from read it, whatever happens to the process afterwards
 * (a stop, a crash, a restart): the next process's first load counts as `rebuilt`.
 */
export class AnswerCache implements IDisposable {
  private files = new Map<string, Map<string, Promise<QueryOutcome<unknown>>>>();
  private readonly stale = new StaleAnswers();
  private readonly subscription: IDisposable;

  constructor(loads: LoadNotifications) {
    this.subscription = loads.onDidLoad((loaded) => {
      for (const file of this.stale.after(loaded)) {
        this.files.delete(file);
      }
    });
  }

  /**
   * The cached outcome of `key` for `file`, else `ask()`'s, which is cached when it is an answer.
   * `fresh`: ask again whatever is cached (and cache the new answer) — for a document whose check
   * is running, whose cached answers may describe the text before it.
   */
  get<T>(file: string, key: string, ask: () => Promise<QueryOutcome<T>>, fresh = false): Promise<QueryOutcome<T>> {
    let answers = this.files.get(file);
    const cached = fresh ? undefined : answers?.get(key);
    if (cached !== undefined) {
      return cached as Promise<QueryOutcome<T>>;
    }
    if (answers === undefined) {
      answers = new Map();
      this.files.set(file, answers);
    }
    const asked = ask();
    const entries = answers;
    entries.set(key, asked);
    const forget = (): void => {
      if (entries.get(key) === asked) {
        entries.delete(key);
      }
    };
    asked.then((outcome) => outcome.kind === 'answer' || forget(), forget);
    return asked;
  }

  /** Drops what is kept for `file` (its document was closed; a reopened document is checked again). */
  forget(file: string): void {
    this.files.delete(file);
    this.stale.forget(file);
  }

  dispose(): void {
    this.subscription.dispose();
    this.files = new Map();
  }
}
