/**
 * The reading of compiler text M3 shows (`types.ts`, *Untrusted text*): which declaration a block
 * of a `:docs-for` reply documents, its overview, and the parts of a name. How such text is shown —
 * the fenced code block no line can close, invisible characters written out, QuickPick texts
 * without theme icons — is `core/untrustedText.ts`, which `features/eval` shares. No `vscode`
 * import, so it is unit-tested on Node.
 *
 * Everything here treats the text as data. Types, docs and namespace listings quote the user's
 * source and that of installed packages, so a docstring may hold markdown, HTML, `command:` links
 * or `$(icon)` sequences meant to be interpreted; none of them is.
 */
import type { RichText, RichTextSpan } from '../../backend/types';

// -------------------------------------------------------------------------------------------
// `:docs-for` replies
// -------------------------------------------------------------------------------------------

/**
 * The section headers the compiler writes under a declaration in `:docs-for` output, each as
 * `  <Header>:` — `header "…"` in `src/Idris/Doc/String.idr`, the same set on v0.8.0 `15a3e4e` and
 * master `1c630e6` [src]. They end the user's docstring, which the compiler writes first, indented
 * by two spaces (`reflowDoc`, `showDoc` [src]).
 */
const DOC_SECTION_HEADERS: readonly string[] = [
  'Totality',
  'Visibility',
  'Fixity Declaration',
  'Fixity Declarations',
  'Parameters',
  'Constraints',
  'Constructor',
  'Constructors',
  'Methods',
  'Implementation',
  'Implementations',
  'Hint',
  'Hints',
  'Projection',
  'Projections',
  'Codata (infinite data type) annotation',
  'Laziness annotation',
  'Laziness compiler primitive',
  'Unquotes',
];

/**
 * The name a line of compiler output declares, as the compiler prints it (`Foo.Shapes.area`,
 * `Prelude.(::)`, `x₁`), or `undefined` when the line does not start a declaration. A declaration
 * line starts in column 0 with an optional multiplicity (`0 `, `1 `), an optional kind (`data `,
 * `record `, `interface `; `prettyKindedName`), the name, and ` : ` — the shape of `:type-of`
 * answers (`displayType`, `src/Idris/Doc/Display.idr` 26–34 on v0.8.0) and of the first line of
 * each `:docs-for` block (`showDoc`, `src/Idris/Doc/String.idr` 444–482) [src]. The premises of a
 * hole's goal are indented and so declare nothing here; its last line (`vlen_rhs : Nat`) does.
 */
export function declaredName(line: string): string | undefined {
  const m = /^(?:[01] )?(?:(?:data|record|interface) )?(\S.*?) : /.exec(line);
  return m === null ? undefined : m[1];
}

/** The names the lines of `text` declare (`declaredName`), in order. */
export function declaredNames(text: string): string[] {
  return text.split('\n').flatMap((line) => declaredName(line) ?? []);
}

/** A namespace prefix: identifiers, each followed by a dot (`Data.Vect.`). */
const QUALIFIER = /^(?:[\p{L}_][\p{L}\p{N}_']*\.)+/u;

/**
 * A name as the compiler prints it or a user types it, split into its namespace and its root:
 * `Foo.Shapes.area` → `Foo.Shapes`, `area`; `Prelude.(::)` → `Prelude`, `::`; `(|+|)` →
 * `undefined`, `|+|`; `<.>` → `undefined`, `<.>` (an operator's dots are its own).
 */
export function splitName(name: string): { readonly namespace: string | undefined; readonly root: string } {
  const qualifier = QUALIFIER.exec(name)?.[0];
  const namespace = qualifier !== undefined && qualifier.length < name.length ? qualifier.slice(0, -1) : undefined;
  const rest = namespace === undefined ? name : name.slice(namespace.length + 1);
  const root = rest.length > 2 && rest.startsWith('(') && rest.endsWith(')') ? rest.slice(1, -1) : rest;
  return { namespace, root };
}

/** The root of a name (`splitName`). */
export function nameRoot(name: string): string {
  return splitName(name).root;
}

/** One declaration's part of a `:docs-for` reply: the offsets of its text in the whole. */
export interface DocBlock {
  /** The declared name (`declaredName` of its declaration line). */
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The declarations of a `:docs-for` reply, in order. An overloaded name is answered with one block
 * per definition, each starting with its declaration line in column 0 (recorded: `::` gives
 * `Prelude.(::)`, `Prelude.Stream.(::)` and `Data.Vect.(::)` [live, transcript `clean-queries`]);
 * the lines under it are indented. A deprecated definition's line is preceded by `=DEPRECATED=`
 * (`showDoc` [src]), which belongs to its block. Text before the first declaration line forms no
 * block.
 */
export function docBlocks(text: string): DocBlock[] {
  const blocks: { name: string; start: number; end: number }[] = [];
  let offset = 0;
  let pendingStart: number | undefined;
  for (const line of text.split('\n')) {
    const name = declaredName(line);
    if (name !== undefined) {
      const start = pendingStart ?? offset;
      if (blocks.length > 0) {
        blocks[blocks.length - 1].end = start;
      }
      blocks.push({ name, start, end: text.length });
      pendingStart = undefined;
    } else if (line === '=DEPRECATED=') {
      pendingStart = offset;
    } else if (!/^\s/.test(line) && line !== '') {
      pendingStart = undefined;
    }
    offset += line.length + 1;
  }
  return blocks.map((b) => ({ ...b, end: trimEnd(text, b.start, b.end) }));
}

/** `end` moved back over the line break that separates a block from the next one. */
function trimEnd(text: string, start: number, end: number): number {
  return end > start && text.charAt(end - 1) === '\n' ? end - 1 : end;
}

/**
 * The first paragraph of the docstring in a `:docs-for` block (its text from `block.start` to
 * `block.end`), as one line: the lines after the declaration line, each indented by the
 * compiler's two spaces, up to the first empty line or section header (`DOC_SECTION_HEADERS`);
 * `undefined` when the block has no docstring (the compiler ignores the overview mode, F31, so the
 * extension takes it). Heuristic in one respect: a docstring line that itself starts with
 * `<Header>:` ends the paragraph early — the reply carries no mark of where the docstring ends
 * (`UserDocString` has no IDE decoration, `src/Idris/IDEMode/Pretty.idr` 39 [src]).
 */
export function docOverview(text: string, block: DocBlock): string | undefined {
  const lines = text.slice(block.start, block.end).split('\n');
  const first = lines.findIndex((line) => declaredName(line) !== undefined);
  const paragraph: string[] = [];
  for (const line of lines.slice(first + 1)) {
    if (!line.startsWith('  ') || line.trim() === '' || isSectionHeader(line)) {
      break;
    }
    paragraph.push(line.trim());
  }
  return paragraph.length > 0 ? paragraph.join(' ') : undefined;
}

function isSectionHeader(line: string): boolean {
  return DOC_SECTION_HEADERS.some((header) => line.startsWith(`  ${header}:`));
}

/**
 * The part of `rich` from `start` to `end`, its spans cut to it and moved with it (a span that
 * does not overlap is dropped).
 */
export function sliceRichText(rich: RichText, start: number, end: number): RichText {
  const spans: RichTextSpan[] = [];
  for (const span of rich.spans) {
    const from = Math.max(span.start, start);
    const to = Math.min(span.start + span.length, end);
    if (to > from) {
      spans.push({ ...span, start: from - start, length: to - from });
    }
  }
  return { text: rich.text.slice(start, end), spans };
}
