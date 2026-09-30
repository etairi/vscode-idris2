/**
 * **Idris 2: Show Documentation…** and **Docs at Cursor** (ROADMAP M3): the compiler's
 * documentation of a name in a read-only document of the scheme `idris2-doc`, and the helpers of
 * **Browse Namespace…**, which opens it for the name picked. No `vscode` import: `register.ts`
 * makes the URIs, the content provider and the QuickPick from these.
 *
 * **The document is plain text.** Its path is the name followed by ` (Idris 2 docs).txt` (the name
 * as a label shows it, `editorLabel`: its invisible characters, bidirectional controls among them,
 * written out, since the path's last segment is the editor tab's title; an operator's `/` written as
 * U+2215, so that it does not make a path segment). VS Code 1.139.1 gives a content provider's
 * document the language its path names and only when the path names none the language whose
 * first-line pattern the text's first line matches (`$registerTextContentProvider` →
 * `createByFilepathOrFirstLine`, and the guessing function `R5o`, in the workbench bundle [src]);
 * the path's language is chosen on the lowercased path by the user's `files.associations` first,
 * then among the languages' contributions an exact file name, else the longest matching
 * `filenamePattern`, else the longest extension (`k5o` [src]). Without an extension the first line
 * decided, which is compiler text: the built-in Raku pattern (`raku` anywhere, `use v6`, … in
 * `perl/package.json`) took `Main.rakuFoo : Nat` (*review of M3* [src]). `.txt` is plain text's
 * (`plaintext`), so the reply is shown as the compiler wrote it — unless the user associated `*.txt`
 * with another language, or another installed extension contributes a `filenamePattern` that the
 * path matches: ms-python's `pip-requirements` has `**\/*constraints*.txt` and
 * `**\/*requirements*.{txt, in}`, so the documentation of `solveConstraints` opens in that mode and
 * that extension's features run on it (second review of M3 [src, its `package.json` 2026.4.0]; the
 * text is still only shown, and coloured by this extension's semantic tokens, which are registered
 * by scheme). A fixed file name matched by a language of this extension's own (`filenames`, which
 * ranks first) would avoid that, but every tab would then have the same title; not done
 * (docs/as-built/M3.md, *Open issues*). The editor's own link detection makes links of `http://`,
 * `https://` and `file://` URLs only (the link computer's state machine in the workbench bundle
 * [src]), so a `command:` URI in a docstring stays text. The reply's decorations colour it through
 * semantic tokens (`semanticTokens.ts`).
 */
import type { NamespaceEntry, RichText, RichTextSpan } from '../../backend/types';
import { editorLabel, quickPickText } from '../../core/untrustedText';
import type { SyntaxModel } from '../syntax/selectionRangeModel';
import { namespaceKeywordBefore } from './occurrence';
import { docBlocks, sliceRichText, splitName } from './text';

export const DOC_SCHEME = 'idris2-doc';

/** What a documentation document shows: `name` (as asked, perhaps qualified) in the context of `source`. */
export interface DocRequest {
  /** The URI (`toString()`) of the Idris document whose loaded file answers. */
  readonly source: string;
  readonly name: string;
}

/** The path of the document of `name`: see the module comment (the query carries the name itself). */
export function docPath(name: string): string {
  return `/${editorLabel(name).replace(/\//g, '\u2215')} (Idris 2 docs).txt`;
}

/** The query of the document's URI, which carries the request. */
export function docQuery(request: DocRequest): string {
  return new URLSearchParams({ source: request.source, name: request.name }).toString();
}

export function parseDocQuery(query: string): DocRequest | undefined {
  const params = new URLSearchParams(query);
  const source = params.get('source');
  const name = params.get('name');
  return source === null || name === null || name === '' ? undefined : { source, name };
}

/**
 * The part of a `:docs-for` reply that documents `name`: `:docs-for` takes an unqualified name
 * (`Data.Vect.index` is sent as `index`, `register.ts`) and answers for every definition of it,
 * so a qualified `name` keeps the blocks whose namespace it names (`Data.Vect` for
 * `Data.Vect.index`; also `Vect` for it, and `Prelude.Basics` for the compiler's shortened
 * `Prelude.(::)`). When no block matches, or `name` is unqualified, the whole reply is shown.
 */
export function selectDocs(rich: RichText, name: string): RichText {
  const { namespace: wanted } = splitName(name);
  if (wanted === undefined) {
    return rich;
  }
  const kept = docBlocks(rich.text).filter((block) => {
    const ns = splitName(block.name).namespace;
    return ns !== undefined && (ns === wanted || ns.endsWith(`.${wanted}`) || wanted.startsWith(`${ns}.`));
  });
  if (kept.length === 0) {
    return rich;
  }
  const parts = kept.map((block) => sliceRichText(rich, block.start, block.end));
  const spans: RichTextSpan[] = [];
  let text = '';
  for (const part of parts) {
    if (text !== '') {
      text += '\n';
    }
    spans.push(...part.spans.map((s) => ({ ...s, start: s.start + text.length })));
    text += part.text;
  }
  return { text, spans };
}

// -------------------------------------------------------------------------------------------
// Browse Namespace…
// -------------------------------------------------------------------------------------------

/** A QuickPick item of a namespace listing: the name, and its type as the description. */
export interface NamespaceItem {
  readonly label: string;
  readonly description: string;
  readonly entry: NamespaceEntry;
}

/**
 * The QuickPick item of `entry` (`NAME : TYPE`, a hole with its multiplicity first: `1 vlen_rhs :
 * …` [live, transcript `clean-queries`]): each text one line with its invisible characters written
 * out (`core/untrustedText.ts` `editorLabel`) and no theme icon (`quickPickText`).
 */
export function namespaceItem(entry: NamespaceEntry): NamespaceItem {
  const text = entry.signature.text;
  const colon = text.indexOf(' : ');
  const shown = (t: string): string => quickPickText(editorLabel(t));
  return {
    label: shown(entry.name),
    description: shown(colon < 0 ? text : text.slice(colon + 3)),
    entry,
  };
}

/**
 * The namespace **Browse Namespace…** suggests: the module or namespace written at `offset` (a
 * qualified name there: its namespace; `import Data.Vect`: `Data.Vect`), else the document's own
 * module (`module Foo.Shapes`), else nothing.
 */
export function namespaceSuggestion(model: SyntaxModel | undefined, offset: number): string {
  if (model === undefined) {
    return '';
  }
  const index = model.tokens.findIndex((t) => t.kind === 'ident' && t.start <= offset && offset <= t.end);
  const at = model.tokens[index];
  if (at !== undefined) {
    const introduced = namespaceKeywordBefore(model.tokens, index);
    if (introduced === 'import' || introduced === 'module' || introduced === 'namespace') {
      return at.text;
    }
    const qualified = splitName(at.text).namespace;
    if (qualified !== undefined) {
      return qualified;
    }
  }
  const header = model.tokens.findIndex((t) => t.kind === 'keyword' && t.text === 'module');
  const name = header < 0 ? undefined : model.tokens[header + 1];
  return name?.kind === 'ident' ? name.text : '';
}
