/**
 * Document highlights (ROADMAP M3): the occurrences of the name at the cursor, from the file's
 * token index. No `vscode` import.
 *
 * The compiler's `:namespace` cannot tell two names apart — it is `""` for bound names and for
 * declaring occurrences, and the defining namespace elsewhere (F33, and its refinement recorded
 * with the M3 transcripts) — so occurrences are grouped by name and decoration (ROADMAP M3), and
 * their scope is read from the layout (M0's syntax model):
 * - a bound name (`:bound`, a local variable) within the top-level block that holds the
 *   occurrence — the clause or signature, whose variables no other clause sees (a narrowing of
 *   ROADMAP M3's "enclosing top-level declaration", which would join the variables of all clauses
 *   of a function);
 * - any other name (a global: function, type, constructor, …) in the whole file. **Deviation**
 *   from ROADMAP M3, which scopes every name to its top-level declaration: a global is the same
 *   definition throughout the file except when two definitions of one name and decoration are
 *   used in it (overloading), which the name-based grouping does not tell apart either way.
 * Without the index or a name there (a file not loaded, a hole, a keyword), there is no answer, so
 * VS Code's word-based highlighting applies (its built-in provider answers for every language
 * when the others answer nothing [src: VS Code 1.139.1 workbench bundle, the `f2t` provider and
 * `bBo`, which takes the first result that is not `undefined`]).
 */
import type { Token } from '../../backend/types';
import type { EditorRange } from '../../core/positions';
import type { SyntaxModel } from '../syntax/selectionRangeModel';
import type { Occurrence } from './occurrence';

type Block = NonNullable<SyntaxModel['blockAtLine'][number]>;

/** The top-level block that holds `line`, if any. */
function rootBlockAt(model: SyntaxModel, line: number): Block | undefined {
  let block = model.blockAtLine[line];
  while (block?.parent !== undefined) {
    block = block.parent;
  }
  return block;
}

function key(r: EditorRange): string {
  return `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
}

/**
 * The ranges to highlight for `occurrence` among `tokens` (the index's, `currentTokens`), or
 * `undefined` when the index has nothing to say (see the module comment). `model` is needed for a
 * bound name; without one (a literate style M0 does not model) there is no answer for it.
 */
export function documentHighlights(tokens: readonly Token[], occurrence: Occurrence, model: SyntaxModel | undefined): EditorRange[] | undefined {
  if (occurrence.decor === undefined) {
    return undefined;
  }
  let inScope: (t: Token) => boolean = () => true;
  if (occurrence.decor === 'bound') {
    if (model === undefined) {
      return undefined;
    }
    const scope = rootBlockAt(model, occurrence.range.start.line);
    inScope = (t) => rootBlockAt(model, t.range.start.line) === scope;
  }
  const ranges: EditorRange[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.name === occurrence.name && t.decor === occurrence.decor && inScope(t) && !seen.has(key(t.range))) {
      seen.add(key(t.range));
      ranges.push(t.range);
    }
  }
  return ranges;
}
