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
 * from (`occurrence.ts` `indexDescribes`: no unsaved changes, and exactly the text the load read,
 * also after an undo or a revert): the tokens and answers describe the saved file as last loaded.
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
 * diff finds them, and on a line edited in place a token whose text is where it was); a hint whose
 * token was not carried over is left out, and its tooltip says the type is the saved file's. Until that
 * review it showed none while the document had unsaved changes (ROADMAP M3: "skipped while the
 * document is dirty"): VS Code 1.139.1 replaces the hints in the range it asks about with the
 * provider's answer, and gives the line with the cursor the width of the hints before the cursor
 * only for the hints the answer has there (`_updateHintsDecorators` [src, the workbench bundle]), so
 * at the first keystroke every hint went, the text of every hinted line moved left, and it moved
 * back after the save, the load and the queries [src; not observed in a running VS Code]. A hint
 * kept that way can be out of date where the edit changed the type (a signature being edited): it
 * shows the type as last checked until the save, as the hover does, which says so.
 *
 * **Answers a load made stale** (fourth review of M3). A load that makes a file's answers stale
 * moves them to `lastKnown` rather than dropping them, with the text of the token index they were
 * asked with. They are shown only where nothing can be asked — for a token carried over while the
 * document shows other text than the index (above), and for the tokens left in a round a query ended
 * unavailable — and only while the file's index is still of that text; a fresh answer takes a
 * token's place, and they go when the index changes or the document closes. Before that review two
 * common states lost every hint of a file, VS Code replacing them with an empty answer, so that the
 * text of every hinted line moved left: a save whose load failed (a failed load counts as `rebuilt`
 * and sends no highlighting, so the index stays and the document shows other text than it, where
 * nothing is asked), and a visible editor that is not the active one after a load of another file of
 * its root that built something (its queries are refused, `queries.ts`); they came back only after
 * a successful save, or when that editor was focused [unit-level, the reviewer's probes]. Such a
 * hint may be out of date where the load that made it stale changed the type (an edited module it
 * imports); the tooltip says the type is the one the compiler inferred at its last check.
 */
import type * as vscode from 'vscode';
import type { Token, TokenIndex, TypeInfo } from '../../backend/types';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import type { EditorPosition, EditorRange } from '../../core/positions';
import { codeBlock, editorLabel, visible } from '../../core/untrustedText';
import { compilerLiterateStyleOf, idrisDocumentSelector, isIdrisDocument, type CompiledDocument } from '../../project/literate';
import { buildSyntaxModel, isModelledStyle } from '../syntax/selectionRangeModel';
import { currentTokens, indexDescribes, indexTokenOf } from './occurrence';
import { StaleAnswers } from './queries';
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

/** Answers for one file, by token (`line:character:name` of the index), and the text of the token index they were asked with. */
interface FileHints {
  readonly text: string;
  readonly hints: Map<string, KeptHint>;
}

export function registerInlayHints(api: InlayHintsApi, deps: IntelligenceDeps): IDisposable {
  const store = new DisposableStore();
  const changed = store.add(new api.EventEmitter<void>());
  /** Per file, the answers until a load makes them stale. */
  const answers = new Map<string, FileHints>();
  /** Per file, the answers loads made stale (module comment, *Answers a load made stale*). */
  const lastKnown = new Map<string, FileHints>();
  const stale = new StaleAnswers();
  /** The hinted tokens of a token index (the text it was made from does not change). */
  const hintedByIndex = new WeakMap<TokenIndex, readonly HintedToken[]>();

  store.add(
    deps.loads.onDidLoad((loaded) => {
      for (const file of stale.after(loaded)) {
        const current = answers.get(file);
        if (current === undefined) {
          continue;
        }
        answers.delete(file);
        const last = lastKnown.get(file);
        if (last?.text === current.text) {
          current.hints.forEach((hint, key) => last.hints.set(key, hint));
        } else {
          lastKnown.set(file, current);
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
      answers.delete(doc.fileName);
      lastKnown.delete(doc.fileName);
      stale.forget(doc.fileName);
    }),
  );

  const hintOf = (token: Token, kept: NonNullable<KeptHint>): vscode.InlayHint => {
    const hint = new api.InlayHint(new api.Position(token.range.end.line, token.range.end.character), kept.label, api.InlayHintKind.Type);
    hint.paddingLeft = true;
    const tooltip = new api.MarkdownString();
    tooltip.isTrusted = false;
    tooltip.supportHtml = false;
    tooltip.supportThemeIcons = false;
    tooltip.appendMarkdown(codeBlock(visible(kept.text), 'idris2'));
    tooltip.appendText('The type of this occurrence in the saved file, as the compiler inferred it at its last check.');
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
      const index = backend.tokens(doc);
      if (index?.text === undefined || token.isCancellationRequested) {
        return [];
      }
      let hinted = hintedByIndex.get(index);
      if (hinted === undefined) {
        hinted = hintedTokens(index.tokens, declarationUnits(index.text.replace(/^\uFEFF/, ''), doc));
        hintedByIndex.set(index, hinted);
      }
      const text = index.text;
      let kept = answers.get(doc.fileName);
      if (kept?.text !== text) {
        kept = { text, hints: new Map() };
        answers.set(doc.fileName, kept);
      }
      const last = lastKnown.get(doc.fileName);
      if (last !== undefined && last.text !== text) {
        lastKnown.delete(doc.fileName); // answers about another text of the file: never shown again
      }
      const known = last?.text === text ? last.hints : undefined;
      const keyOf = (t: HintedToken): string => `${t.range.start.line}:${t.range.start.character}:${t.name}`;
      if (!indexDescribes(doc, index)) {
        // Module comment, *Unsaved changes*: the kept hints of the tokens carried over, nothing asked.
        const hintedSet = new Set<Token>(hinted);
        const hints: vscode.InlayHint[] = [];
        for (const current of currentTokens(doc, index)) {
          const target = indexTokenOf(current);
          const key = hintedSet.has(target) && within(current.range, range) ? keyOf(target as HintedToken) : undefined;
          const answer = key === undefined ? undefined : (kept.hints.get(key) ?? known?.get(key));
          if (answer !== undefined && answer !== null) {
            hints.push(hintOf(current, answer));
          }
        }
        return hints;
      }
      const hints: vscode.InlayHint[] = [];
      let unavailable = false;
      for (const target of hinted) {
        if (!within(target.range, range)) {
          continue;
        }
        const key = keyOf(target);
        let answer = kept.hints.get(key);
        if (answer === undefined && !unavailable) {
          if (token.isCancellationRequested) {
            break;
          }
          const start = new api.Position(target.range.start.line, target.range.start.character);
          const outcome = await deps.queries.run(doc, 'passive', (b) => b.typeAt(doc, start, target.name, 'bound'));
          if (outcome.kind === 'unavailable') {
            deps.log.debug(`Inlay hints for ${doc.fileName}: ${outcome.reason}`);
            // Module comment, *When*: nothing more is asked this round; the tokens left get the
            // answers a load made stale, if any.
            unavailable = true;
          } else {
            const label = outcome.value === undefined ? undefined : hintLabel(target.name, outcome.value);
            answer = label === undefined || outcome.value === undefined ? null : { label, text: outcome.value.text };
            // Not kept as the file's when a load made its answers stale meanwhile: `kept` is then no
            // longer the file's (it may be the answers kept aside, `lastKnown`, shown only where
            // nothing can be asked).
            kept.hints.set(key, answer);
          }
        }
        answer ??= unavailable ? known?.get(key) : undefined;
        if (answer !== undefined && answer !== null) {
          hints.push(hintOf(target, answer));
        }
      }
      return hints;
    },
  };
  store.add(api.languages.registerInlayHintsProvider(idrisDocumentSelector(), provider));
  return store;
}
