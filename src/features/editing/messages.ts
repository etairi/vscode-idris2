/**
 * The texts of the editing commands (`types.ts`, *One edit*, step 4): their titles, what each needs
 * at the cursor, and how a compiler error (`EditResult` `failed`) is shown — rephrased when it is
 * one the table knows, as the compiler sent it otherwise, and with the advice to fix the file's
 * first error when its last load reported errors (ROADMAP M4: "this clause has no hole to split
 * on", "the file did not load cleanly — fix the first error and save").
 *
 * **After a load with errors** the commands that find their place by line or position answer with
 * misleading errors [live, prep and recorder of M4, transcripts `hole-errors` and `part-editing`,
 * which contradict F16's first probe]: `:case-split` `No clause to split here` also on a clause
 * whose right-hand side is a hole, `:add-clause` `<f> not defined here`, `:generate-def` `Can't
 * find declaration for <f> on line L` — after a type error and also after a coverage error alone
 * (`:case-split` there checked live in M4's ninth review, not recorded).
 * So when the file's last load reported errors, the advice comes first and the compiler's text
 * after it, never a rephrasing that blames the clause.
 *
 * No `vscode` import.
 */
import type { EditKind } from '../../backend/types';
import { editorLabel } from '../../core/untrustedText';
import type { EditingCommandId, EditingCommandKinds } from './types';

/** The commands and the edit each asks for (`EditingCommandKinds`; package.json has the titles). */
export const EDITING_COMMAND_KINDS: EditingCommandKinds = {
  'idris2.caseSplit': 'caseSplit',
  'idris2.addClause': 'addClause',
  'idris2.makeLemma': 'makeLemma',
  'idris2.makeWith': 'makeWith',
  'idris2.makeCase': 'makeCase',
  'idris2.proofSearch': 'exprSearch',
  'idris2.nextResult': 'exprSearchNext',
  'idris2.generateDefinition': 'generateDef',
  'idris2.nextDefinition': 'generateDefNext',
  'idris2.intro': 'intro',
  'idris2.refineHole': 'refine',
  'idris2.addMissingCases': 'addMissingCases',
};

/** The commands' titles, as package.json contributes them (a unit test compares the two). */
export const EDITING_COMMAND_TITLES: Readonly<Record<EditingCommandId, string>> = {
  'idris2.caseSplit': 'Case Split',
  'idris2.addClause': 'Add Clause',
  'idris2.makeLemma': 'Make Lemma',
  'idris2.makeWith': 'Make With',
  'idris2.makeCase': 'Make Case',
  'idris2.proofSearch': 'Proof Search',
  'idris2.nextResult': 'Next Result',
  'idris2.generateDefinition': 'Generate Definition',
  'idris2.nextDefinition': 'Next Definition',
  'idris2.intro': 'Intro',
  'idris2.refineHole': 'Refine Hole…',
  'idris2.addMissingCases': 'Add Missing Cases',
};

/** A command's name in a sentence: its title without the ellipsis of one that asks for more (`Refine Hole`). */
export function commandName(command: EditingCommandId): string {
  return EDITING_COMMAND_TITLES[command].replace(/…$/u, '');
}

/**
 * The notification text of a refusal `reason` of command `name` (an `Unsupported` or other error
 * text): `Idris 2: <name>: <reason>`, or `Idris 2: <reason>` when the reason already starts with
 * the command's name (the backend's refusals do: `Case Split: this line …`, `Add Clause needs …`).
 */
export function refusalText(name: string, reason: string): string {
  return reason.startsWith(`${name}:`) || reason.startsWith(`${name} `) ? `Idris 2: ${reason}` : `Idris 2: ${name}: ${reason}`;
}

/** What a command acts on at the cursor (`targets.ts`). */
export type TargetKind = 'hole' | 'patternVariable' | 'declaration' | 'coverage';

/** The target of each command that acts at the cursor. */
export const TARGET_OF: Readonly<Record<Exclude<EditKind, 'exprSearchNext' | 'generateDefNext'>, TargetKind>> = {
  caseSplit: 'patternVariable',
  addClause: 'declaration',
  generateDef: 'declaration',
  makeLemma: 'hole',
  makeWith: 'hole',
  makeCase: 'hole',
  exprSearch: 'hole',
  intro: 'hole',
  refine: 'hole',
  addMissingCases: 'coverage',
};

/** What the cursor must be on, per target: the second half of "Idris 2: <Title>: put the cursor …". */
export const NEEDS: Readonly<Record<TargetKind, string>> = {
  hole: 'put the cursor on a hole (?name).',
  patternVariable: 'put the cursor on a variable of a clause\'s left-hand side, such as the xs of "f xs = ?rhs".',
  declaration: 'put the cursor on a type declaration (name : type).',
  coverage: 'put the cursor on a type declaration (name : type), or on a "… is not covering" error that lists missing cases.',
};

/**
 * Compiler errors the commands rephrase when the file loaded without errors (module comment):
 * `kinds`, the message as the compiler sends it (`pattern`, whole), and the text shown after
 * "Idris 2: " [live, the transcripts named].
 */
const KNOWN_ERRORS: readonly { readonly kinds: readonly EditKind[]; readonly pattern: RegExp; readonly text: string }[] = [
  {
    // `plain`, `plain-split-columns`, `edits-shapes`: a right-hand side that is not a bare hole
    // (`f n = n`, F15; a `let`, a `case`, `S ?h`), a `with` header, the `= ?h` line of a clause.
    kinds: ['caseSplit'],
    pattern: /^No clause to split here$/u,
    text: 'this clause has no hole to split on. Case Split needs a clause whose right-hand side is a hole, such as "f xs = ?rhs", with the cursor on a variable of its left-hand side.',
  },
  {
    // `edits-names`: `:generate-def` on a declaration that has clauses.
    kinds: ['generateDef'],
    pattern: /^Already defined$/u,
    text: 'the function already has clauses. Generate Definition writes the clauses of a type declaration that has none.',
  },
  {
    // `edits-searches`: `:proof-search` on a String-typed hole (hints do not help there).
    kinds: ['exprSearch'],
    pattern: /^No search results$/u,
    text: 'Proof Search found no expression for this hole.',
  },
  {
    // [live, fifth review of M4, rerun by the fixer: `f x = ?length`]: the compiler finds the hole by
    // its unqualified name in its whole context (`lookupCtxtName`, `lookupDefName`, `lookupDefTyName`,
    // `Idris/REPL.idr` 504–716 [src]), and these are its answers when that name matches more than the
    // hole. The request is sent only when the load's holes hold one hole of the name, at the cursor
    // (`holeRefusal`), so the other match is a definition that is not a hole.
    kinds: ['intro', 'refine', 'exprSearch', 'makeLemma'],
    pattern: /^(?:Could not find hole named \S+|Not a searchable hole|Can't make lifted definition)$/u,
    text: 'the compiler finds a hole by its name, and another definition in scope has this hole\'s name (an imported function or constructor, such as length or Z), so it did not find the hole. Rename the hole.',
  },
];

/** The longest compiler text a notification quotes, in UTF-16 code units. */
export const MAX_COMPILER_TEXT = 300;

/**
 * The longest name or compiler text a light-bulb title, an input box's prompt or a QuickPick label
 * shows, in UTF-16 code units (as the Holes view's labels, `holes/tree.ts`).
 */
export const MAX_SHOWN = 500;

/**
 * The compiler's error `message` as a notification quotes it: without the location block that the
 * elaborator adds after a blank line (`(Interactive):1:1--1:4` and the source excerpt under it,
 * noise here, F29), as one line with its control and format characters written out
 * (`editorLabel`), cut at `MAX_COMPILER_TEXT`.
 */
export function compilerText(message: string): string {
  const cut = interactiveBlock(message);
  return editorLabel(cut < 0 ? message : message.slice(0, cut), MAX_COMPILER_TEXT);
}

/**
 * Where the `(Interactive)` block starts in `message`: a line break in the white space right before
 * the first `\n(Interactive):` that has one there (a blank line before it); -1 without one. The
 * white space around the cut is trimmed by `editorLabel`. Linear in the length of `message` (the
 * regular expression `/\n\s*\n\(Interactive\):/` backtracks over runs of blank lines: 735 ms for
 * 40,000 of them, security review of M4).
 */
function interactiveBlock(message: string): number {
  const marker = '\n(Interactive):';
  for (let at = message.indexOf(marker); at >= 0; at = message.indexOf(marker, at + 1)) {
    for (let i = at - 1; i >= 0 && /\s/u.test(message[i]); i--) {
      if (message[i] === '\n') {
        return i;
      }
    }
  }
  return -1;
}

/**
 * What a command shows for the compiler's error `message` (module comment): the advice first when
 * `loadFailed` (the file's last load reported errors), else the known rephrasing, else the
 * compiler's text.
 */
export function failureText(command: EditingCommandId, message: string, loadFailed: boolean): string {
  const title = commandName(command);
  if (loadFailed) {
    return `Idris 2: ${title}: the file did not load cleanly — fix the first error and save, then run ${title} again. The compiler answered: ${compilerText(message)}`;
  }
  const kind = EDITING_COMMAND_KINDS[command];
  const known = KNOWN_ERRORS.find((k) => k.kinds.includes(kind) && k.pattern.test(message));
  return known !== undefined ? `Idris 2: ${title}: ${known.text}` : `Idris 2: ${title}: ${compilerText(message)}`;
}
