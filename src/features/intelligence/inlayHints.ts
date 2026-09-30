/**
 * Inlay hints for the types of pattern variables (ROADMAP M3 outcome: `vlen xs = …` shows
 * `: Vect ?_ ?_` after `xs`; the landscape's gap 5): an `InlayHintsProvider` for every Idris
 * document (`idrisDocumentSelector`), switched by `idris2.inlayHints.variableTypes` (default on,
 * ROADMAP §9 2026-09-28); VS Code's `editor.inlayHints.*` settings apply on top (`maximumLength`,
 * "Maximum overall length of inlay hints, for a single line, before they get truncated by the
 * editor" [src: VS Code 1.139.1 `nls.messages.json`], cuts long types; the tooltip has the whole
 * answer).
 *
 * **Where.** At the `:bound` tokens of the token index (`IdrisBackend.tokens`, the compiler's
 * `:highlight-source` of the file's last load: bound variables carry no type there, F33) — but
 * only at the **first occurrence of each name within its top-level declaration**, a layout block
 * of M0's syntax model (`features/syntax/selectionRangeModel.ts`: a line that starts a top-level
 * item and the deeper-indented lines after it; each clause and each type signature is one). A
 * variable is bound at its first occurrence in the clause almost always (a pattern of the
 * left-hand side, a `\x =>`, a `let`, a `do` bind or a `case` alternative), and every later
 * occurrence has the same type, so this shows each variable's type once, where it is bound —
 * `append (x :: xs) ys = x :: append xs ys` gets hints after its first `x`, `xs` and `ys` only, and
 * a type signature one per implicit variable (`n : Nat`), not one per use. A second variable of an already hinted name
 * in the same declaration (a shadowing binder, another `case` alternative) gets none. (A
 * refinement of ROADMAP M3's "one `:type-of` per `:bound` token", which would repeat the type
 * after every use.) In a literate style M0's model does not read (the fenced ones, M12) the unit
 * is the line.
 *
 * **What.** One positional `:type-of` per hinted token (`IdrisBackend.typeAt` at the token's
 * start, F2, F30), through `DocumentQueries` in the `passive` mode, one request at a time (so that
 * a hover waits for one of them at most, not for all), for the tokens in the range VS Code asks
 * about only — in VS Code 1.139.1 the visible lines and a viewport's height of lines (at least 20)
 * above and below them, widened by 30 lines on each side (`getVisibleRangesPlusViewportAboveBelow`
 * and `_getHintsRanges` in the workbench bundle [src]), about three to four times the visible
 * lines (for a window of 50 lines about 210 lines, which on the 2,000-line module of the e2e suite
 * the review of M3 estimated at about 140 positional `:type-of` requests, asked again after each
 * load that makes the answers stale); the label is `: <type>`, from an answer of the form
 * `<name> : <type>` found `by position` — an answer for another name at that position, or found
 * by name (which may describe a global of the same name), shows nothing. Compiler text is drawn
 * as one line with its control and format characters written out (`core/untrustedText.ts`
 * `editorLabel`), and in the tooltip in a code block, those characters written out too (`visible`,
 * `codeBlock`).
 *
 * **When.** The compiler is asked only while the document shows the text the token index was made
 * from (`occurrence.ts` `showsIndexText`: no unsaved changes, and the text the load read, also after
 * an undo or a revert): the tokens and answers describe the saved file as last loaded. A file with
 * mixed line breaks or a lone `\r` counts too, though VS Code shows it with one line break and a lone
 * `\r` as a break of its own: its hints are asked for and placed where its tokens are carried to
 * (`currentTokens`; until the sixth review of M3 such a file got none) — in a file that is not
 * literate; in a literate one the compiler's unlit step may end or join lines at a lone `\r`, which
 * is not mapped, so hints after it may land on another line (`core/positions.ts` *Literate lines*).
 * Answers are kept per file until a load makes them stale (`queries.ts` `StaleAnswers`: a load of
 * any file of the root that built something) or the document closes; every load asks VS Code for
 * the hints again (`LoadNotifications.onDidLoad`), so scrolling back asks nothing; a query that is
 * unavailable (the file loaded last is another one and this is not the active document, the backend
 * stopped, …) ends the round — the tokens left get the answers a load made stale, if any (below) —
 * and is asked again next time — also when an Idris file's editor
 * becomes the active one (`onDidChangeActiveTextEditor`), whose file a passive query may then load:
 * VS Code 1.139.1 asks for hints again on a provider's change, a model or language change, the
 * configuration, scrolling, an edit and a double click, not on focus (`InlayHintsController` [src,
 * the workbench bundle]), so the hints of the second of two editors side by side, dropped by a load
 * of the first that built something, stayed missing until a scroll or an edit there (second review
 * of M3).
 *
 * **Unsaved changes** (third review of M3). While the document shows other text, the provider asks
 * nothing and shows the hints it kept, each at the place its token was carried to
 * (`occurrence.ts` `currentTokens`, as the semantic tokens are: the unchanged lines, wherever a line
 * diff finds them, and on a line edited in place a token whose text is where it was, with the same
 * text before it — not one kept by its text alone, `keptByTextAlone`, which may be another
 * occurrence, fifth review of M3); a hint whose token was not carried over is left out, and its
 * tooltip says the type is the saved file's. Until that
 * review it showed none while the document had unsaved changes (ROADMAP M3: "skipped while the
 * document is dirty"): VS Code 1.139.1 replaces the hints in the range it asks about with the
 * provider's answer, and gives the line with the cursor the width of the hints before the cursor
 * only for the hints the answer has there (`_updateHintsDecorators` [src, the workbench bundle]), so
 * at the first keystroke every hint went, the text of every hinted line moved left, and it moved
 * back after the save, the load and the queries [src; not observed in a running VS Code]. A hint
 * kept that way can be out of date where the edit changed the type (a signature being edited): it
 * shows the type as last checked until the save, as the hover does, which says so.
 *
 * **Answers a load made stale** (fourth to sixth reviews of M3). A load that makes a file's answers
 * stale moves them to `lastKnown` rather than dropping them, with the token index they were asked
 * with. They are shown only where nothing can be asked — for a token carried over while the document
 * shows other text than the index (above), and for the tokens left in a round a query ended
 * unavailable —, and a fresh answer, one that shows nothing included, takes a token's place — but
 * not one that shows nothing while the file's last load failed (`LoadedFileEvent.failed`): after a
 * load that failed because of a module it imports, the compiler answers about none of the file's
 * names (`(:type-of "xs" 6 5)` answered `Undefined name xs` [live, the fifth review of M3]), and until
 * the sixth review the hints of the active, unchanged file went while the import was broken and came
 * back when it was fixed [unit-level, the verifier's probe]; an answer about a declaration before an error in the file itself is
 * still taken. When the file's index is of another text than theirs, they are carried over to it
 * (`rekeyed`): an answer stays with a hinted token of the new index at the same column, of the same
 * name, on the line the line diff of the two texts pairs with its line (`core/positions.ts`
 * `lineCorrespondence`, of the texts split as the editor splits them, `editorSplit`: eighth review
 * of M3), when that line is equal or edited in place with the same text before the token's end
 * (`samePlace`, the rule of the unsaved changes above). A load whose index has no text
 * (the file was saved during it) leaves the hints placed by the index before it. The answers go only
 * when the file's document closes (not another document of its path, a `git:` one:
 * `queries.ts` `isFileDocument`); a load that makes them stale again adds its fresh answers to them,
 * and an answer that shows nothing does not replace a type there (after a failed load of the kind
 * above the types were lost for good before the fifth review). Before the fourth review two common
 * states lost every hint of a file, VS Code replacing
 * them with an empty answer, so that the text of every hinted line moved left: a save whose load
 * failed (a failed load counts as `rebuilt` and sends no highlighting, so the index stays and the
 * document shows other text than it, where nothing is asked), and a visible editor that is not the
 * active one after a load of another file of its root that built something (its queries are
 * refused, `queries.ts`); they came back only after a successful save, or when that editor was
 * focused. Until the fifth, every state in which a *new* index could not be asked lost them the same
 * way: a save followed by typing before its load answered (`files.autoSave = afterDelay` too), a
 * visible editor whose own file was saved and loaded before another file's load displaced it (Save
 * All, `files.autoSave = onFocusChange`), and a save during a load [unit-level, the reviewers'
 * probes]. Such a hint may be out of date where the file or a module it imports changed the type;
 * its tooltip says it comes from an earlier check.
 */
import type * as vscode from 'vscode';
import type { Token, TokenIndex, TypeInfo } from '../../backend/types';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { editorSplit, lineCorrespondence, type EditorPosition, type EditorRange } from '../../core/positions';
import { codeBlock, editorLabel, visible } from '../../core/untrustedText';
import { compilerLiterateStyleOf, idrisDocumentSelector, isIdrisDocument, type CompiledDocument } from '../../project/literate';
import { buildSyntaxModel, isModelledStyle } from '../syntax/selectionRangeModel';
import { currentTokens, indexDescribes, indexTokenOf, keptByTextAlone, showsIndexText } from './occurrence';
import { isFileDocument, StaleAnswers } from './queries';
import type { IntelligenceDeps } from './types';

/** The part of the `vscode` namespace the provider uses. */
export type InlayHintsApi = Pick<
  typeof vscode,
  'languages' | 'workspace' | 'window' | 'EventEmitter' | 'InlayHint' | 'InlayHintKind' | 'Position' | 'MarkdownString'
>;

/** A token that gets a hint: a `:bound` token with a name. */
export interface HintedToken extends Token {
  readonly name: string;
}

/**
 * The tokens of `tokens` that get a hint (module comment, *Where*): the `bound` ones with a name,
 * the first of each name per unit. `unitOf` gives a line's unit.
 */
export function hintedTokens(tokens: readonly Token[], unitOf: (line: number) => string): HintedToken[] {
  const seen = new Set<string>();
  const hinted: HintedToken[] = [];
  for (const token of tokens) {
    if (token.decor !== 'bound' || token.name === undefined || token.name === '') {
      continue;
    }
    const key = `${unitOf(token.range.start.line)}\u0000${token.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      hinted.push(token as HintedToken);
    }
  }
  return hinted;
}

/**
 * The units of `text`'s lines: the header line of the top-level layout block a line belongs to
 * (M0's model), or the line itself where the model has no block, or cannot read the document.
 */
export function declarationUnits(text: string, doc: CompiledDocument): (line: number) => string {
  const style = compilerLiterateStyleOf(doc);
  if (!isModelledStyle(style)) {
    return (line) => `line ${line}`;
  }
  const model = buildSyntaxModel(text, style);
  return (line) => {
    let block = model.blockAtLine[line];
    while (block?.parent !== undefined) {
      block = block.parent;
    }
    return block === undefined ? `line ${line}` : `block ${block.headerLine}`;
  };
}

/**
 * The label of `name`'s hint from `typeAt`'s answer (module comment, *What*): `: <type>` as one
 * line, or `undefined` when the answer is not a positional one about `name`.
 */
export function hintLabel(name: string, info: TypeInfo): string | undefined {
  const head = `${name} : `;
  if (info.lookup !== 'position' || !info.text.startsWith(head)) {
    return undefined;
  }
  const type = editorLabel(info.text.slice(head.length));
  return type === '' ? undefined : `: ${type}`;
}

function before(a: EditorPosition, b: EditorPosition): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

/** Whether `inner` lies in `outer` (touching counts). */
function within(inner: EditorRange, outer: EditorRange): boolean {
  return !before(inner.start, outer.start) && !before(outer.end, inner.end);
}

/** An answer kept for a token: its label and the compiler's text, or `null` for one that shows nothing. */
type KeptHint = { readonly label: string; readonly text: string } | null;

/**
 * A token index with a text, and its hinted tokens (`hintedTokens`). `index` holds only the hinted
 * tokens (`lightIndex`): what answers kept by it need of an index is its text and, for the tokens
 * carried to a document's text (`carriedHinted`), those tokens. Until the seventh review of M3 it was
 * the whole index the answers were asked with, which the answers kept alive after the backend had
 * replaced it — after a load that built nothing (a new index of the same text), and aside for a hidden
 * editor — up to one extra index per open file (5 MB for 24,000 tokens) [unit-level, the verifier's
 * probe].
 */
interface HintedIndex {
  readonly index: TokenIndex;
  readonly text: string;
  readonly hinted: readonly HintedToken[];
}

/** Answers for one file, by token (`keyOf`), and the token index they were asked with. */
interface FileHints extends HintedIndex {
  readonly hints: Map<string, KeptHint>;
}

/** The key of an answer about the token `name` of an index that starts at `start` (its own start: `keyOf`). */
function keyAt(start: EditorPosition, name: string): string {
  return `${start.line}:${start.character}:${name}`;
}

/** The key of an answer about `token` of an index (`keyAt`). */
function keyOf(token: HintedToken): string {
  return keyAt(token.range.start, token.name);
}

/**
 * `from`'s answers carried over to the tokens of `to`, an index of another text of the file (module
 * comment, *Answers a load made stale*): the answer about the token at the same column, of the same
 * name, on the line of `from`'s text that the line diff pairs with the token's line (`samePlace`).
 * Both texts are split as the editor splits them first (`core/positions.ts` `editorSplit`), and the
 * lines, columns and pairs are those of the editor lines: VS Code saves a file with a lone `\r` with
 * its one line break, so the saved text has a line more there than the text before, and diffed as
 * the compiler's lines (`compilerLines`, until the eighth review of M3) the line that held the `\r`
 * was paired with neither of the two it became, and its answers were not carried over [unit-level,
 * the verifier's probe].
 */
function rekeyed(from: FileHints, to: HintedIndex): FileHints {
  const before = editorSplit(from.text);
  const after = editorSplit(to.text);
  const { toBefore } = lineCorrespondence(before.lines, after.lines);
  const hints = new Map<string, KeptHint>();
  for (const token of to.hinted) {
    const range = after.toEditorRange(token.range);
    const line = range.start.line;
    const old = line < toBefore.length ? toBefore[line] : -1;
    const key = old < 0 || !samePlace(before.lines[old], after.lines[line], range) ? undefined : keyAt(before.toCompiler({ line: old, character: range.start.character }), token.name);
    if (key !== undefined && from.hints.has(key)) {
      hints.set(keyOf(token), from.hints.get(key) as KeptHint);
    }
  }
  return { ...to, hints };
}

/**
 * Whether a token at `range` (of the editor's lines), on the line `now` of a new index's text, stands
 * where it stood on `was`, the line of the old text the line diff pairs with it (`rekeyed`): an equal
 * line, or a line edited in place with the same text before the token's end — the rule by which
 * `occurrence.ts` `carriedOver` keeps a token on the dirty path, not by its text alone
 * (`keptByTextAlone`: two clauses swapped and both edited pair each with the other, and their
 * variables are at the same columns). Until the sixth review of M3 only equal lines counted, so the
 * hints of the lines edited between two indexes vanished in the states the answers are carried for —
 * typically the line being typed on, whose text then moved left [unit-level, the verifier's probe].
 */
function samePlace(was: string, now: string, range: EditorRange): boolean {
  const { start, end } = range;
  return was === now || (start.line === end.line && was.slice(0, end.character) === now.slice(0, end.character));
}

/** `into` (answers kept aside) with `fresh`'s answers added, one that shows nothing never replacing a type (module comment); a new map. */
function merged(into: FileHints, fresh: FileHints): FileHints {
  const hints = new Map(into.hints);
  fresh.hints.forEach((hint, key) => {
    if (hint !== null || !hints.get(key)) {
      hints.set(key, hint);
    }
  });
  return { ...fresh, hints };
}

/**
 * The hinted tokens of `index` carried over to the text `doc` shows (`occurrence.ts`
 * `currentTokens`), each with the token of the index it stands for (`target`, which its answer is
 * kept by); not one kept by its text alone, which may be another occurrence (`keptByTextAlone`).
 */
function carriedHinted(doc: vscode.TextDocument, index: TokenIndex, hinted: readonly HintedToken[]): Array<{ readonly shown: Token; readonly target: HintedToken }> {
  const hintedSet = new Set<Token>(hinted);
  const carried: Array<{ readonly shown: Token; readonly target: HintedToken }> = [];
  for (const shown of currentTokens(doc, index)) {
    const target = indexTokenOf(shown);
    if (hintedSet.has(target) && !keptByTextAlone(shown)) {
      carried.push({ shown, target: target as HintedToken });
    }
  }
  return carried;
}

export function registerInlayHints(api: InlayHintsApi, deps: IntelligenceDeps): IDisposable {
  const store = new DisposableStore();
  const changed = store.add(new api.EventEmitter<void>());
  /** Per file, the answers until a load makes them stale. */
  const answers = new Map<string, FileHints>();
  /** Per file, the answers loads made stale (module comment, *Answers a load made stale*). */
  const lastKnown = new Map<string, FileHints>();
  const stale = new StaleAnswers();
  /** The files whose last load failed (`LoadedFileEvent.failed`): an answer that shows nothing is not kept then (module comment). */
  const failed = new Set<string>();
  /** The hinted tokens of a token index (the text it was made from does not change). */
  const hintedByIndex = new WeakMap<TokenIndex, readonly HintedToken[]>();
  /** `index` (of `text`) holding only its hinted tokens (`HintedIndex`); the one given when it already does. */
  const lightIndex = (index: TokenIndex, text: string, hinted: readonly HintedToken[]): TokenIndex => {
    if (index.tokens === hinted) {
      return index;
    }
    const light: TokenIndex = { file: index.file, text, tokens: hinted };
    hintedByIndex.set(light, hinted);
    return light;
  };

  /** Moves `current`, `file`'s answers, to the answers kept aside (`lastKnown`), carried over to its index first. */
  const keepAside = (file: string, current: FileHints): void => {
    const last = lastKnown.get(file);
    const base = last === undefined ? { ...current, hints: new Map<string, KeptHint>() } : last.text === current.text ? last : rekeyed(last, current);
    lastKnown.set(file, merged(base, current));
  };

  store.add(
    deps.loads.onDidLoad((loaded) => {
      if (loaded.failed === true) {
        failed.add(loaded.file);
      } else {
        failed.delete(loaded.file);
      }
      for (const file of stale.after(loaded)) {
        const current = answers.get(file);
        if (current !== undefined) {
          answers.delete(file);
          keepAside(file, current);
        }
      }
      changed.fire();
    }),
  );
  store.add(deps.config.onDidChange('inlayHints', () => changed.fire()));
  // An Idris file's editor becoming the active one: its hints are asked for again, since now a
  // passive query may load it (module comment, *When*).
  store.add(
    api.window.onDidChangeActiveTextEditor((editor) => {
      if (editor !== undefined && editor.document.uri.scheme === 'file' && isIdrisDocument(editor.document)) {
        changed.fire();
      }
    }),
  );
  store.add(
    api.workspace.onDidCloseTextDocument((doc) => {
      // Not another document of the same path (`queries.ts` `isFileDocument`).
      if (isFileDocument(doc)) {
        answers.delete(doc.fileName);
        lastKnown.delete(doc.fileName);
        failed.delete(doc.fileName); // its root stays known (`StaleAnswers`)
      }
    }),
  );

  /** `hint.tooltip`'s note: `fresh`, an answer about the index of the file's last load; else one kept aside (module comment). */
  const hintOf = (token: Token, kept: NonNullable<KeptHint>, fresh: boolean): vscode.InlayHint => {
    const hint = new api.InlayHint(new api.Position(token.range.end.line, token.range.end.character), kept.label, api.InlayHintKind.Type);
    hint.paddingLeft = true;
    const tooltip = new api.MarkdownString();
    tooltip.isTrusted = false;
    tooltip.supportHtml = false;
    tooltip.supportThemeIcons = false;
    tooltip.appendMarkdown(codeBlock(visible(kept.text), 'idris2'));
    tooltip.appendText(
      fresh
        ? 'The type of this occurrence in the saved file, as the compiler inferred it at its last check.'
        : 'The type of this occurrence as the compiler inferred it at an earlier check; the file, or a module it imports, has changed since.',
    );
    hint.tooltip = tooltip;
    return hint;
  };

  const provider: vscode.InlayHintsProvider = {
    onDidChangeInlayHints: changed.event,
    provideInlayHints: async (doc, range, token) => {
      if (!deps.config.inlayHints().variableTypes || doc.uri.scheme !== 'file') {
        return [];
      }
      const backend = deps.registry.backendFor(await deps.projects.classify(doc.fileName));
      const current = backend.tokens(doc);
      if (token.isCancellationRequested) {
        return [];
      }
      // The index the hints are placed by: the file's, or, while it has no text (the file was saved
      // during its load), the one the kept answers were asked with (module comment).
      const index = current === undefined || current.text !== undefined ? current : (answers.get(doc.fileName)?.index ?? lastKnown.get(doc.fileName)?.index);
      if (index?.text === undefined) {
        return [];
      }
      let hinted = hintedByIndex.get(index);
      if (hinted === undefined) {
        // M0's model breaks a line at a lone `\r` too, the compiler does not in a file that is not
        // literate (`core/positions.ts` `compilerLines`, *Literate lines*), and the index's lines are
        // the compiler's: the model reads a space there instead, so that its lines are the index's
        // (sixth review of M3).
        hinted = hintedTokens(index.tokens, declarationUnits(index.text.replace(/^\uFEFF/, '').replace(/\r(?!\n)/g, ' '), doc));
        hintedByIndex.set(index, hinted);
      }
      const text = index.text;
      let kept = answers.get(doc.fileName);
      if (kept?.text !== text) {
        if (kept !== undefined) {
          keepAside(doc.fileName, kept);
        }
        kept = { index: lightIndex(index, text, hinted), text, hinted, hints: new Map() };
        answers.set(doc.fileName, kept);
      }
      let last = lastKnown.get(doc.fileName);
      if (last !== undefined && last.text !== text) {
        last = rekeyed(last, kept);
        lastKnown.set(doc.fileName, last);
      }
      const known = last?.hints;
      /** The answer kept for `key`, and whether it is fresh: one about this index, else one kept aside (`null`: shows nothing). */
      const answerOf = (key: string): { readonly answer: KeptHint | undefined; readonly fresh: boolean } =>
        kept.hints.has(key) ? { answer: kept.hints.get(key), fresh: true } : { answer: known?.get(key), fresh: false };
      if (index !== current || !showsIndexText(doc, index)) {
        // Module comment, *Unsaved changes*: the kept hints of the tokens carried over, nothing asked.
        const hints: vscode.InlayHint[] = [];
        for (const { shown, target } of carriedHinted(doc, index, hinted)) {
          if (!within(shown.range, range)) {
            continue;
          }
          const { answer, fresh } = answerOf(keyOf(target));
          if (answer !== undefined && answer !== null) {
            hints.push(hintOf(shown, answer, fresh));
          }
        }
        return hints;
      }
      // The document shows the index's text, exactly or but for its line breaks (module comment,
      // *When*): then at the places its tokens are carried to.
      const targets = indexDescribes(doc, index) ? hinted.map((target) => ({ shown: target as Token, target })) : carriedHinted(doc, index, hinted);
      const hints: vscode.InlayHint[] = [];
      let unavailable = false;
      for (const { shown, target } of targets) {
        if (!within(shown.range, range)) {
          continue;
        }
        const key = keyOf(target);
        let { answer, fresh } = answerOf(key);
        if (!fresh && !unavailable) {
          if (token.isCancellationRequested) {
            break;
          }
          const start = new api.Position(shown.range.start.line, shown.range.start.character);
          const outcome = await deps.queries.run(doc, 'passive', (b) => b.typeAt(doc, start, target.name, 'bound'));
          if (outcome.kind === 'unavailable') {
            deps.log.debug(`Inlay hints for ${doc.fileName}: ${outcome.reason}`);
            // Module comment, *When*: nothing more is asked this round; the tokens left get the
            // answers a load made stale, if any.
            unavailable = true;
          } else {
            const label = outcome.value === undefined ? undefined : hintLabel(target.name, outcome.value);
            const fetched: KeptHint = label === undefined || outcome.value === undefined ? null : { label, text: outcome.value.text };
            // After a failed load an answer that shows nothing is not kept: the one kept aside stays,
            // and the backend's answer is asked again next time (module comment, *Answers a load made
            // stale*). Otherwise it is kept — not as the file's when a load made its answers stale
            // meanwhile: `kept` is then no longer the file's, and VS Code asks again after that load.
            if (fetched !== null || !failed.has(doc.fileName)) {
              answer = fetched;
              fresh = true;
              kept.hints.set(key, fetched);
            }
          }
        }
        if (answer !== undefined && answer !== null) {
          hints.push(hintOf(shown, answer, fresh));
        }
      }
      return hints;
    },
  };
  store.add(api.languages.registerInlayHintsProvider(idrisDocumentSelector(), provider));
  return store;
}
