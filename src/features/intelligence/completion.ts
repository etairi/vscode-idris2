/**
 * Completion (ROADMAP M3 outcome: Ctrl+Space completes global names plus keywords and
 * `%`-directives): a `CompletionItemProvider` for every Idris document (`idrisDocumentSelector`).
 *
 * **What is offered where.** At an identifier (letters, digits, `_`, `'` and every character above
 * U+00A0, starting with a letter, `_` or such a character — `isIdentStart`/`isIdentTrailing`,
 * `src/Parser/Lexer/Common.idr` 73–82 on v0.8.0 [src]) the keywords of the compiler's lexer
 * (`KEYWORDS`, `features/syntax/lexer.ts`) and the names in scope that start with what was typed,
 * from the backend (`IdrisBackend.completions`: the compiler's `:repl-completions`); after a `.`
 * (a qualified name, a projection) or a `?` (a hole) the names only, completing the last part —
 * of every namespace: `:repl-completions` ignores namespaces [live: `Data.V` gives `Vect`, `Void`,
 * `View`], so after `Data.Vect.fil` a name such as `fileSize` is offered, which does not resolve
 * there (second review of M3; not filtered, the README says so).
 * After `%`, the names the parser accepts there (`DIRECTIVES`). On a prose line of a bird-track
 * document nothing (the compiler reads no code there). The names describe the file as its last
 * load read it (the saved file): what unsaved text defines is not among them (unsaved text is M6).
 *
 * **Never blocking** (docs/measurements/first-load.md [live]: `:repl-completions` answered in
 * 0.8–3.1 ms at the median and within 10.8 ms at p90, but the first one after every load took
 * 113–423 ms on `contrib`, up to 0.97 s in a session macOS had compressed, and a request sent during
 * a load waits for it, up to 1.5 s behind a first load): two measures.
 * 1. *Pre-warming.* After every load of the active document's file (`LoadNotifications.onDidLoad`)
 *    the provider asks the backend to warm the next completion up (`CompletionWarmUp`: the IDE-mode
 *    backend sends one `:repl-completions` to that session once it has been idle for a moment,
 *    loading and starting nothing, `IdeMode.warmUpCompletions`), while the user has not typed yet:
 *    the first request after a load is slow whatever its prefix, and any prefix makes the next one
 *    fast [live, 2026-09-29, the backend's module comment, `backend/ide/backend.ts`]. It costs the
 *    session that time after each load of the active file (a hover made meanwhile waits for it; the
 *    queries that follow the load go first), in exchange for the first completion.
 * 2. *A time limit.* The provider waits at most `COMPILER_WAIT_MS` for the compiler. When the names
 *    are not there by then — a first request before the pre-warm finished, a request queued behind
 *    a load — it answers with the keywords alone and marks the list incomplete, so VS Code asks
 *    again at the next keystroke; the request goes on and its answer is kept for that.
 *
 * **Names as labels** (third review of M3). A name from the compiler is untrusted text: every
 * character above U+00A0 is an identifier character (`isIdentTrailing`), so a package can export a
 * name with a bidirectional control, and an elaborator script can make any string a name. VS Code
 * 1.139.1 draws a completion label with theme icons on (`$(zap)` becomes an icon; the suggest
 * widget's `IconLabel` with `supportIcons` [src, the workbench bundle]) and bidirectional controls
 * acting, so the label is the name as `core/untrustedText.ts` draws compiler text in a line and in a
 * list to pick from (`editorLabel`, `quickPickText`), while `insertText` and `filterText` are the
 * name itself: what is typed and inserted is unchanged [live, the reviewer's probe: `(:repl-completions
 * "vl")` answered `vlxyz\u{202E}ab` and `vl$(zap)`].
 *
 * **Kept answers.** Per file, the names of each prefix asked, until a load of the root makes them
 * stale (`queries.ts` `StaleAnswers`: a load that built something may change what is in scope, also
 * in the files that import what it built) or the document closes. A longer prefix is answered from
 * a kept shorter one by filtering, since the backend's answer is every name in scope that starts
 * with the prefix (`IdrisBackend.completions`), and so is one typed while a shorter one is still
 * asked (the first request after a load is the slow one): one request serves the keystrokes that
 * follow it, instead of one more queued per keystroke (*review of M3*). Requests go through
 * `DocumentQueries` in the `passive` mode, which loads the file only for the active document
 * (`types.ts`).
 */
import type * as vscode from 'vscode';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { editorLabel, quickPickText } from '../../core/untrustedText';
import { birdPrefixWidth, compilerLiterateStyleOf, idrisDocumentSelector, isIdrisDocument } from '../../project/literate';
import { KEYWORDS } from '../syntax/lexer';
import { StaleAnswers } from './queries';
import type { IntelligenceDeps, LoadedFileEvent, QueryOutcome } from './types';

/**
 * Every name the parser accepts after `%` (`pragma "…"` and `decoratedPragma fname "…"` in
 * `src/Idris/Parser.idr`, identical on v0.8.0 and master 1c630e6 [src]) but `World` and `MkWorld`,
 * the primitive world type and value, and `cg`, which the lexer reads itself (`cgDirective`,
 * `src/Parser/Lexer/Source.idr` 175–185). The grammar's list (`KNOWN_PRAGMAS` in
 * `syntaxes/src/idris2.grammar.mjs`) is the same, without `cg` (test/unit/completion.test.ts
 * compares them). The compiler's own `%` completion offers only the 22 top-level directives of
 * `allPragmas` (`src/Idris/Syntax/Pragmas.idr` 130–154); these include the function options
 * (`%inline`, `%foreign`, …) and the expression forms (`%search`, `%runElab`) as well.
 */
export const DIRECTIVES: readonly string[] = [
  'allow_overloads', 'ambiguity_depth', 'auto_implicit_depth', 'auto_lazy', 'builtin', 'cg',
  'charLit', 'declsLit', 'default', 'defaulthint', 'deprecate', 'doubleLit', 'export', 'extern',
  'foreign', 'foreign_impl', 'globalhint', 'hide', 'hint', 'inline', 'integerLit', 'language',
  'logging', 'macro', 'name', 'nameLit', 'nf_metavar_threshold', 'noinline', 'nomangle', 'pair',
  'prefix_record_projections', 'rewrite', 'runElab', 'search', 'search_timeout', 'spec', 'start',
  'stringLit', 'syntactic', 'tcinline', 'totality_depth', 'transform', 'TTImpLit',
  'unbound_implicits', 'unhide', 'unsafe',
];

/**
 * How long the provider waits for the compiler's names (module comment, *Never blocking*): above
 * the measured steady state (median 0.8–3.1 ms, p90 ≤ 10.8 ms) with room for the extension host's own
 * latency, below the first request after a load (113 ms and more) and a wait behind a load. A
 * design choice from those measurements, not itself measured.
 */
export const COMPILER_WAIT_MS = 150;

/** At most this many answers are kept per file; the oldest go first. */
const MAX_KEPT_ANSWERS = 64;

/** Where the cursor is, for completion (`completionSite`). UTF-16 columns on the cursor's line. */
export type CompletionSite =
  /** After `%`: `start` is the `%`'s column, `end` the end of the name after it. */
  | { readonly kind: 'directive'; readonly start: number; readonly end: number }
  /**
   * In or after an identifier, or where one may start (`prefix` empty): `start`..`end` is the
   * identifier (its last part in a qualified name); `prefix` is its part before the cursor.
   * `keywords`: whether a keyword may stand here (not after `.` or `?`).
   */
  | { readonly kind: 'name'; readonly start: number; readonly end: number; readonly prefix: string; readonly keywords: boolean };

/** `isIdentStart` (Normal flavour): `_`, an ASCII letter, or a character above U+00A0. */
function isIdentStart(codePoint: number): boolean {
  return codePoint === 0x5f || (codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a) || codePoint > 0xa0;
}

/** `isIdentTrailing` (Normal flavour): an identifier start, an ASCII digit, or `'`. */
function isIdentTrailing(codePoint: number): boolean {
  return isIdentStart(codePoint) || (codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x27;
}

/** The code point that ends at UTF-16 offset `end` of `text`, and its length in code units. */
function codePointBefore(text: string, end: number): { readonly codePoint: number; readonly length: number } | undefined {
  if (end <= 0) {
    return undefined;
  }
  const low = text.charCodeAt(end - 1);
  if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return { codePoint: (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000, length: 2 };
    }
  }
  return { codePoint: low, length: 1 };
}

/**
 * Where completion happens at UTF-16 column `character` of `line` (one line of text, without its
 * break), or `undefined` where nothing is completed: in a run of identifier characters that does
 * not begin with an identifier start — a number (`12`, `0x1f`) or a character literal (`'a`).
 */
export function completionSite(line: string, character: number): CompletionSite | undefined {
  // The run of identifier characters around the cursor.
  let start = character;
  for (let c = codePointBefore(line, start); c !== undefined && isIdentTrailing(c.codePoint); c = codePointBefore(line, start)) {
    start -= c.length;
  }
  let end = character;
  while (end < line.length) {
    const codePoint = line.codePointAt(end) ?? 0;
    if (!isIdentTrailing(codePoint)) {
      break;
    }
    end += codePoint > 0xffff ? 2 : 1;
  }
  if (start < character && !isIdentStart(line.codePointAt(start) ?? 0)) {
    return undefined;
  }
  const before = line.charAt(start - 1);
  if (before === '%') {
    return { kind: 'directive', start: start - 1, end };
  }
  return { kind: 'name', start, end, prefix: line.slice(start, character), keywords: before !== '.' && before !== '?' };
}

/** The answers kept for one file since its last load (module comment, *Kept answers*). */
interface FileAnswers {
  readonly names: Map<string, readonly string[]>;
  readonly pending: Map<string, Promise<readonly string[] | undefined>>;
}

/** What the provider shows at a name site: the compiler's names, and whether it has all of them. */
export interface NameCompletions {
  readonly names: readonly string[];
  /** The compiler did not answer in time (or could not be asked yet): ask again at the next keystroke. */
  readonly incomplete: boolean;
}

/**
 * What warms a root's next completion up after a load (module comment, *Pre-warming*):
 * `IdeMode.warmUpCompletions`, which `extension.ts` passes. It loads and starts nothing, resolves
 * when done, and never rejects.
 */
export interface CompletionWarmUp {
  warmUpCompletions(doc: vscode.TextDocument): Promise<void>;
}

/** What `registerCompletion` needs: the M3 dependencies, and the backend's warm-up. */
export interface CompletionDeps extends IntelligenceDeps {
  readonly warmUp: CompletionWarmUp;
}

export interface CompletionOptions {
  /** `COMPILER_WAIT_MS` unless a test sets it. */
  readonly waitMs?: number;
}

/** The part of the `vscode` namespace the provider uses. */
export type CompletionApi = Pick<
  typeof vscode,
  'languages' | 'window' | 'workspace' | 'CompletionItem' | 'CompletionItemKind' | 'CompletionList' | 'Range'
>;

/**
 * The compiler's side of completion: kept answers, the pre-warming and the time limit (module
 * comment). `registerCompletion` builds one; the unit tests drive it through the provider.
 */
class CompilerNames implements IDisposable {
  private readonly files = new Map<string, FileAnswers>();
  private readonly stale = new StaleAnswers();
  private readonly store = new DisposableStore();
  private readonly waitMs: number;

  constructor(
    private readonly deps: Pick<CompletionDeps, 'queries' | 'loads' | 'warmUp' | 'log'>,
    /** The active editor's document, which is pre-warmed after its loads. */
    private readonly activeDocument: () => vscode.TextDocument | undefined,
    options: CompletionOptions = {},
  ) {
    this.waitMs = options.waitMs ?? COMPILER_WAIT_MS;
    this.store.add(deps.loads.onDidLoad((loaded) => this.loaded(loaded)));
  }

  /**
   * The names in scope at `doc` that start with `prefix` (not empty), as far as the compiler gave
   * them within the time limit: from a kept answer, else from a request for `prefix` or a shorter
   * prefix still pending (module comment, *Kept answers*), else from a new request.
   */
  async namesFor(doc: vscode.TextDocument, prefix: string): Promise<NameCompletions> {
    const answers = this.answersFor(doc.fileName);
    const kept = keptAnswer(answers, prefix);
    if (kept !== undefined) {
      return { names: kept, incomplete: false };
    }
    const shorter = pendingAnswer(answers, prefix);
    const request =
      shorter ?? this.request(answers, prefix, () => this.deps.queries.run(doc, 'passive', (backend) => backend.completions(doc, prefix)));
    const answer = await withinTime(request, this.waitMs);
    if (answer === timedOut) {
      return { names: [], incomplete: true };
    }
    return { names: (answer ?? []).filter((name) => name.startsWith(prefix)), incomplete: false };
  }

  /** Drops what is kept for `file` (its document was closed; a reopened document is checked again). */
  forget(file: string): void {
    this.files.delete(file);
    this.stale.forget(file);
  }

  dispose(): void {
    this.store.dispose();
    this.files.clear();
  }

  private answersFor(file: string): FileAnswers {
    let answers = this.files.get(file);
    if (answers === undefined) {
      answers = { names: new Map(), pending: new Map() };
      this.files.set(file, answers);
    }
    return answers;
  }

  /**
   * Sends `ask` for `prefix` and keeps its answer in `answers` — which is no longer consulted once
   * the file was loaded again (`loaded`), so an answer that arrives after that load is returned to
   * its caller but not kept for later ones. `undefined` when the backend could not answer.
   */
  private request(
    answers: FileAnswers,
    prefix: string,
    ask: () => Promise<QueryOutcome<readonly string[]>>,
  ): Promise<readonly string[] | undefined> {
    const request = ask()
      .then(
        (outcome) => {
          if (outcome.kind === 'unavailable') {
            this.deps.log.debug(`Completion of "${prefix}": ${outcome.reason}`);
            return undefined;
          }
          answers.names.set(prefix, outcome.value);
          if (answers.names.size > MAX_KEPT_ANSWERS) {
            answers.names.delete(answers.names.keys().next().value as string);
          }
          return outcome.value;
        },
        (error: unknown) => {
          this.deps.log.error(`Completion of "${prefix}" failed: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        },
      )
      .finally(() => answers.pending.delete(prefix));
    answers.pending.set(prefix, request);
    return request;
  }

  /**
   * A load answered: forget the answers it makes stale (`StaleAnswers`), and warm up when it is of
   * the active document's file.
   */
  private loaded(loaded: LoadedFileEvent): void {
    for (const file of this.stale.after(loaded)) {
      this.files.delete(file);
    }
    const doc = this.activeDocument();
    if (doc !== undefined && doc.fileName === loaded.file && doc.uri.scheme === 'file' && isIdrisDocument(doc)) {
      void this.deps.warmUp.warmUpCompletions(doc);
    }
  }
}

/** The names for `prefix` from the longest kept prefix of it (module comment, *Kept answers*). */
function keptAnswer(answers: FileAnswers, prefix: string): readonly string[] | undefined {
  for (let length = prefix.length; length > 0; length--) {
    const names = answers.names.get(prefix.slice(0, length));
    if (names !== undefined) {
      return length === prefix.length ? names : names.filter((name) => name.startsWith(prefix));
    }
  }
  return undefined;
}

/** The pending request of the longest prefix of `prefix` (itself included), if any; the caller filters its names. */
function pendingAnswer(answers: FileAnswers, prefix: string): Promise<readonly string[] | undefined> | undefined {
  for (let length = prefix.length; length > 0; length--) {
    const pending = answers.pending.get(prefix.slice(0, length));
    if (pending !== undefined) {
      return pending;
    }
  }
  return undefined;
}

const timedOut: unique symbol = Symbol('timed out');

/** `promise`'s value, or `timedOut` when it has none after `ms` milliseconds. */
async function withinTime<T>(promise: Promise<T>, ms: number): Promise<T | typeof timedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `line` of `doc` is Idris code as the compiler reads it: not on a bird-track document's prose lines. */
function isCodeLine(doc: vscode.TextDocument, line: number): boolean {
  return compilerLiterateStyleOf(doc) !== 'bird' || birdPrefixWidth(doc.lineAt(line).text) !== undefined;
}

export function registerCompletion(api: CompletionApi, deps: CompletionDeps, options: CompletionOptions = {}): IDisposable {
  const store = new DisposableStore();
  const names = store.add(new CompilerNames(deps, () => api.window.activeTextEditor?.document, options));
  store.add(api.workspace.onDidCloseTextDocument((doc) => names.forget(doc.fileName)));

  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems: async (doc, position, token) => {
      if (!isCodeLine(doc, position.line)) {
        return undefined;
      }
      const site = completionSite(doc.lineAt(position.line).text, position.character);
      if (site === undefined) {
        return undefined;
      }
      const ranges = {
        inserting: new api.Range(position.line, site.start, position.line, position.character),
        replacing: new api.Range(position.line, site.start, position.line, site.end),
      };
      const item = (label: string, kind: vscode.CompletionItemKind | undefined): vscode.CompletionItem => {
        const completion = new api.CompletionItem(label, kind);
        completion.range = ranges;
        return completion;
      };
      /** A name from the compiler (module comment, *Names as labels*). */
      const nameItem = (name: string): vscode.CompletionItem => {
        const completion = item(quickPickText(editorLabel(name)), undefined);
        completion.insertText = name;
        completion.filterText = name;
        return completion;
      };
      if (site.kind === 'directive') {
        return new api.CompletionList(DIRECTIVES.map((name) => item(`%${name}`, api.CompletionItemKind.Keyword)));
      }
      const keywords = site.keywords ? [...KEYWORDS].map((keyword) => item(keyword, api.CompletionItemKind.Keyword)) : [];
      if (site.prefix === '' || doc.uri.scheme !== 'file') {
        // Nothing typed yet: the keywords, and ask again once there is a prefix. An untitled
        // document has no file for the compiler to have loaded.
        return new api.CompletionList(keywords, site.prefix === '');
      }
      const found = await names.namesFor(doc, site.prefix);
      if (token.isCancellationRequested) {
        return undefined;
      }
      // The compiler reports no kind of name (`((names…) "context")`), so none is claimed here.
      return new api.CompletionList([...keywords, ...found.names.map(nameItem)], found.incomplete);
    },
  };
  store.add(api.languages.registerCompletionItemProvider(idrisDocumentSelector(), provider));
  return store;
}
