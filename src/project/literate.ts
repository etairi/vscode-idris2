/**
 * The single document-selector rule (`project/literate.ts` in docs/ARCHITECTURE.md §2, §3.2,
 * decision D21), the compiler's table of literate styles and file extensions, and the bird-track
 * line helper that `core/positions.ts` needs (F11).
 *
 * Every provider, command enablement, view and `when` clause is registered through
 * `idrisDocumentSelector()` / `isIdrisDocument()` / the `idris2.isIdrisDocument` context key,
 * never with a bare language id, so that later milestones widen what counts as an Idris
 * document by adding rows to `IDRIS_DOCUMENT_TABLE` instead of retrofitting registrations.
 * M0 selected the two language ids `idris2` and `lidr`. M1 adds the file names that are Idris
 * without doubt whatever their language mode: the double extensions `.idr.<ext>` and
 * `.lidr.<ext>` of every literate extension (docs/as-built/M1.md, *Literate table and
 * selector*). A bare `.md`, `.tex`,
 * `.org` or `.typ` file keeps its host language and is not selected: that needs content
 * detection and is M12's opt-in.
 *
 * The literate table (`LITERATE_STYLE_TABLE`) is the compiler's (`src/Parser/Unlit.idr`,
 * identical on v0.8.0 and master 1c630e6 apart from imports) [src]; `project/index.ts` maps
 * modules to paths with it (`MODULE_SOURCE_EXTENSIONS`, `isIdrisSourceFileName`).
 *
 * The module has no runtime dependency on `vscode` (only type imports), so it is unit-tested on
 * plain Node; `extension.ts` supplies the editor events for the context key.
 */
import type * as vscode from 'vscode';
import type { IDisposable } from '../core/disposable';

/**
 * A literate style of the compiler: `styleBird`, `styleOrg`, `styleCMark`, `styleTeX` and
 * `styleTypst` of `src/Parser/Unlit.idr`. The styles with line markers (`bird`, and Org's
 * `#+IDRIS:` lines) have the column offset and the line map that `core/positions.ts` applies
 * (`linePrefixWidth`, `isDoubledLine`; F11); fenced `.md` positions are exact (F11), and the
 * positions inside the fences of the other styles are ROADMAP E19 (M12).
 */
export type LiterateStyle = 'bird' | 'org' | 'cmark' | 'tex' | 'typst';

/**
 * `supportedStyles = [styleBird, styleOrg, styleCMark, styleTeX, styleTypst]` with each style's
 * `file_extensions`, in the compiler's order.
 */
const LITERATE_STYLE_TABLE: readonly { readonly style: LiterateStyle; readonly extensions: readonly string[] }[] = [
  { style: 'bird', extensions: ['.lidr'] },
  { style: 'org', extensions: ['.org'] },
  { style: 'cmark', extensions: ['.md', '.markdown', '.dj'] },
  { style: 'tex', extensions: ['.tex', '.ltx'] },
  { style: 'typst', extensions: ['.typ'] },
];

/** `concatMap file_extensions supportedStyles`: `.lidr .org .md .markdown .dj .tex .ltx .typ`. */
export const LITERATE_EXTENSIONS: readonly string[] = LITERATE_STYLE_TABLE.flatMap((row) => row.extensions);

/**
 * `listOfExtensionsStr` (`src/Core/Directory.idr` 105–106 on v0.8.0): the suffixes `nsToSource`
 * appends to `<sourcedir>/<A/B>` to find the source of module `A.B`, in the order it tries
 * them; the first file that can be opened wins (`firstAvailable`). They are the literate
 * extensions, each after the prefixes `""`, `.idr` and `.lidr` (`listOfExtensionsLiterate`),
 * then `.yaff`, then `.idr` — so `.idr` comes last and a `Shadow.md` beside `Shadow.idr` is
 * the module's source [live, idris2 0.8.0: `--check` of a module importing `Shadow` printed
 * `Building Shadow (Shadow.md)`].
 */
export const MODULE_SOURCE_EXTENSIONS: readonly string[] = [
  ...['', '.idr', '.lidr'].flatMap((prefix) => LITERATE_EXTENSIONS.map((ext) => prefix + ext)),
  '.yaff',
  '.idr',
];

/**
 * The literate style the compiler gives a file of this name: `isLitFile`, the first style one of
 * whose extensions is a suffix of the name (`isSuffixOf`, case-sensitive: `Up.LIDR` is plain
 * source to idris2 0.8.0, F11 [live]). No extension of one style is a suffix of another's, so at
 * most one style matches; `Foo.lidr.md` is `cmark`, `Foo.md.lidr` is `bird`.
 */
export function literateStyleOfFileName(fileName: string): LiterateStyle | undefined {
  return LITERATE_STYLE_TABLE.find((row) => row.extensions.some((ext) => fileName.endsWith(ext)))?.style;
}

/**
 * A file name split as `splitExtensions` does (`src/Libraries/Utils/Path.idr`): at every `.`,
 * where a leading `.` belongs to the stem. `Foo.idr.md` → `Foo` + `[idr, md]`,
 * `.hidden.lidr` → `.hidden` + `[lidr]`, `.md` → `.md` + `[]`.
 */
export function splitFileExtensions(baseName: string): { readonly stem: string; readonly extensions: readonly string[] } {
  const parts = baseName.split('.');
  if (parts[0] === '' && parts.length > 1) {
    return { stem: `.${parts[1]}`, extensions: parts.slice(2) };
  }
  return { stem: parts[0], extensions: parts.slice(1) };
}

/**
 * Whether the compiler takes `baseName` for the name of an Idris source file:
 * `splitIdrisFileName` (`src/Core/Directory.idr` 127–137 on v0.8.0), i.e. `hasLitFileExt` (the
 * file's extensions end with the chunks of a `listOfExtensionsLiterate` entry, which comes down
 * to a last extension from `LITERATE_EXTENSIONS`) or a last extension of exactly `idr`. So
 * `Foo.idr`, `Foo.lidr`, `Foo.idr.md` and `Foo.notes.org` are source names; `Foo.IDR`,
 * `Foo.yaff`, and the dot-files `.idr` and `.md` are not.
 */
export function isIdrisSourceFileName(baseName: string): boolean {
  const { extensions } = splitFileExtensions(baseName);
  const last = extensions[extensions.length - 1];
  return last !== undefined && (last === 'idr' || LITERATE_EXTENSIONS.includes(`.${last}`));
}

/**
 * What the selector rule needs to know about a document; `vscode.TextDocument` satisfies it.
 * `fileName` is `uri.fsPath` in VS Code (`TextDocument.fileName` returns `this._uri.fsPath`
 * [src: VS Code 1.139.1 `extensionHostProcess.js`]), also for untitled documents.
 */
export interface IdrisDocumentCandidate {
  readonly languageId: string;
  readonly fileName: string;
}

/**
 * A row of the selector table: a language id contributed in package.json, or a file-name suffix
 * that selects a document whatever its language mode.
 */
type IdrisDocumentRow =
  | {
      readonly kind: 'language';
      readonly languageId: string;
      /** How the editor treats documents in this language mode; `undefined` for plain source. */
      readonly literate: LiterateStyle | undefined;
    }
  | {
      readonly kind: 'suffix';
      /** `.idr.<ext>` or `.lidr.<ext>`; the selector's pattern is `**\/*<suffix>`. */
      readonly suffix: string;
      /** The compiler's style for such a file (`literateStyleOfFileName`). */
      readonly literate: LiterateStyle;
    };

/**
 * The language ids `idris2` and `lidr` (M0), then one suffix row per double extension: the
 * compiler reads `Foo.idr.md` and `Foo.lidr.md` as literate Idris (`isLitFile`) and finds them
 * as the source of module `Foo` (`MODULE_SOURCE_EXTENSIONS`), and the `.idr`/`.lidr` part of
 * the name says that the file is meant as Idris, which a bare `Foo.md` does not. The
 * `.idr.lidr`/`.lidr.lidr` rows repeat what the `lidr` language row selects in its own mode,
 * and keep those files selected in another mode.
 */
const IDRIS_DOCUMENT_TABLE: readonly IdrisDocumentRow[] = [
  { kind: 'language', languageId: 'idris2', literate: undefined },
  { kind: 'language', languageId: 'lidr', literate: 'bird' },
  ...['.idr', '.lidr'].flatMap((prefix) =>
    LITERATE_STYLE_TABLE.flatMap(({ style, extensions }) =>
      extensions.map((ext): IdrisDocumentRow => ({ kind: 'suffix', suffix: prefix + ext, literate: style })),
    ),
  ),
];

/**
 * Whether `row` selects `doc`, exactly as VS Code scores the row's `DocumentFilter`: a language
 * row compares the language id; a suffix row is the pattern `**\/*<suffix>`, which VS Code
 * 1.139.1 matches against `uri.fsPath` with a case-sensitive `endsWith(<suffix>)` (the glob
 * fast path for `**\/*.<ext>` patterns; `ignoreCase` defaults to false) [src: its
 * `extensionHostProcess.js`, the language-selector `score` and glob `parse` functions]. So
 * `Foo.IDR.MD` is selected by neither, like the compiler, whose `isLitFile` is case-sensitive.
 */
function rowSelects(row: IdrisDocumentRow, doc: IdrisDocumentCandidate): boolean {
  return row.kind === 'language' ? row.languageId === doc.languageId : doc.fileName.endsWith(row.suffix);
}

/** The context key kept equal to `isIdrisDocument(activeTextEditor.document)`. */
export const IS_IDRIS_DOCUMENT_CONTEXT_KEY = 'idris2.isIdrisDocument';

/** The document selector every Idris registration uses (ARCHITECTURE §3.2). */
export function idrisDocumentSelector(): vscode.DocumentFilter[] {
  return IDRIS_DOCUMENT_TABLE.map((row) =>
    row.kind === 'language' ? { language: row.languageId } : { pattern: `**/*${row.suffix}` },
  );
}

/** True exactly when `vscode.languages.match(idrisDocumentSelector(), doc) > 0`. */
export function isIdrisDocument(doc: IdrisDocumentCandidate): boolean {
  return IDRIS_DOCUMENT_TABLE.some((row) => rowSelects(row, doc));
}

/**
 * The literate style of `doc` as the editor treats it, from the first row that selects it: the
 * language mode decides for `idris2` and `lidr` documents (so a `.lidr` file in the `idris2`
 * mode is plain source here, as it is for highlighting), the double extension for a document
 * only a suffix row selects (`Foo.idr.md` in the `markdown` mode is `cmark`); `undefined` for
 * plain source and for non-Idris documents. What the compiler does is `compilerLiterateStyleOf`.
 */
export function literateStyleOf(doc: IdrisDocumentCandidate): LiterateStyle | undefined {
  return IDRIS_DOCUMENT_TABLE.find((row) => rowSelects(row, doc))?.literate;
}

/**
 * What the compiler's choice of literate style needs to know about a document;
 * `vscode.TextDocument` satisfies it.
 */
export interface CompiledDocument extends IdrisDocumentCandidate {
  readonly isUntitled: boolean;
}

/**
 * The literate style the compiler applies to `doc`. The compiler decides by the file name, not
 * by the editor's language mode (`literateStyleOfFileName`), so a `.lidr` file switched to the
 * `idris2` mode is still bird-style for the compiler, and a `.idr` file in the `lidr` mode is
 * not. A document that was never saved has no file name the compiler could see; the editor's
 * view (`literateStyleOf`) decides.
 */
export function compilerLiterateStyleOf(doc: CompiledDocument): LiterateStyle | undefined {
  return doc.isUntitled ? literateStyleOf(doc) : literateStyleOfFileName(doc.fileName);
}

/**
 * Whitespace as the compiler's `isSpace` defines it (`libs/prelude/Prelude/Types.idr` 929–937 on
 * v0.8.0): space, `\t`, `\r`, `\n`, `\f`, `\v` and U+00A0.
 */
export function isIdrisSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v' || c === ' ';
}

/**
 * The line markers of each style (`line_markers` of its `MkLitStyle`, `src/Parser/Unlit.idr`):
 * `>` and `<` for bird tracks, `#+IDRIS:` for Org; the other styles have fences only. In an Org
 * file a `#+IDRIS:` line inside a `#+BEGIN_SRC idris` block is the block's (the block's lexer is
 * tried first, `rawTokens`), which the functions below, which read one line, do not see; such a
 * line is not valid Idris anyway (ROADMAP E19, M12, models the blocks).
 */
const LINE_MARKERS: Readonly<Record<LiterateStyle, readonly string[]>> = {
  bird: ['>', '<'],
  org: ['#+IDRIS:'],
  cmark: [],
  tex: [],
  typst: [],
};

/** Whether `style` marks code lines with a line marker (`LINE_MARKERS`): `bird` and `org`. */
export function hasLineMarkers(style: LiterateStyle | undefined): style is 'bird' | 'org' {
  return style !== undefined && LINE_MARKERS[style].length > 0;
}

/** The marker of `style` that `lineText` starts with, if any (the markers of a style are not prefixes of each other). */
function markerOf(style: LiterateStyle, lineText: string): string | undefined {
  return LINE_MARKERS[style].find((m) => lineText.startsWith(m));
}

/**
 * Width of the line marker of `style` the compiler strips from `lineText` (one line, without its
 * line break), or `undefined` when the line is not a marked code line (for a style without line
 * markers, always).
 *
 * Source (`src/Libraries/Text/Literate.idr`, identical on master and v0.8.0): a code line is
 * `exact m <+> (newline <|> space <+> untilEOL)` for a marker `m` of the style, lexed from the
 * start of the line, where `space` is exactly one `isSpace` character; `reduce` then keeps
 * `substr (length m + 1) …`, i.e. drops the marker and that one character. So, for bird tracks:
 * - `"> x"`, `">\tx"`, `">   x"` → 2 (only one space is stripped; the rest is code indentation);
 * - `">"` alone → 1 (an empty code line);
 * - `">x"` → `undefined`: not a code line at all — the compiler treats it as prose.
 * Verified with idris2 0.8.0 `--check`: a name declared on a `>x : Nat` line is undefined, and
 * errors on `>\tg = "x"` and `>   g = "x"` are reported at file column − 2. For Org,
 * `#+IDRIS: f : Nat` → 9: `f` was reported at (4 0)–(4 1) on file column 9 [live, 0.8.0, second
 * review of M3].
 */
export function linePrefixWidth(style: LiterateStyle | undefined, lineText: string): number | undefined {
  const marker = style === undefined ? undefined : markerOf(style, lineText);
  if (marker === undefined) {
    return undefined;
  }
  if (lineText.length === marker.length) {
    return marker.length;
  }
  return isIdrisSpace(lineText.charAt(marker.length)) ? marker.length + 1 : undefined;
}

/** `linePrefixWidth` of bird tracks (`>`, `<`). */
export function birdPrefixWidth(lineText: string): number | undefined {
  return linePrefixWidth('bird', lineText);
}

/**
 * Whether the compiler's unlit text holds `lineText` (a line of a `style` document that a line
 * break follows) as **two** lines: a marker followed by one or more `isSpace` characters and
 * nothing else (`"> "`, `">   "`, `"<\t"`, `"#+IDRIS: "`). In `reduce` (`Literate.idr`, above) a
 * code line whose `trim` is the marker gives `"\n"`, but `space <+> untilEOL` stopped before the
 * line break, which is then a token of its own and gives a second `"\n"`; a marker alone (`">"`)
 * consumed its line break (`exact m <+> newline`), so it is one line. So every such line moves the
 * compiler's line numbers of the lines below it down by one [live, idris2 0.8.0, second review of
 * M3: after `> ` and `>   ` lines `(:name-at "k")` answered line 15 for file line 13, and
 * `idris2 --check` reported an error on file line 7 (1-based) after a `> ` line as `E:8:5--8:8`;
 * after `#+IDRIS: ` in an Org file, `g` on file line 7 at line 8].
 */
export function isDoubledLine(style: LiterateStyle | undefined, lineText: string): boolean {
  const marker = style === undefined ? undefined : markerOf(style, lineText);
  if (marker === undefined || lineText.length === marker.length) {
    return false;
  }
  return Array.from(lineText.slice(marker.length)).every(isIdrisSpace);
}

/**
 * The editor surface the context key follows. `extension.ts` adapts `vscode.window` and
 * `vscode.workspace` to it; unit tests pass a fake.
 */
export interface ActiveDocumentHost {
  /** The document of the active text editor, if there is one. */
  activeDocument(): IdrisDocumentCandidate | undefined;
  /**
   * Fires when the active document may have changed: a different active editor, or a document
   * (re)opened — VS Code reports a language-mode change as close + open
   * (`languages.setTextDocumentLanguage` in the API documentation).
   */
  onDidChangeActiveDocument(listener: () => void): IDisposable;
  setContext(key: string, value: boolean): void;
}

/**
 * Keeps `idris2.isIdrisDocument` equal to `isIdrisDocument` of the active editor's document:
 * sets it immediately and after every change event, skipping writes that would not change it.
 * Disposing stops following the editor and, if the key is `true`, resets it to `false`: the
 * `setContext` command creates the key on the window's global context-key service (VS Code
 * 1.139.1: `_setContext` calls `createKey` there) and nothing removes it when the extension is
 * deactivated, so menus and enablements gated on it would otherwise stay visible.
 */
export function trackIsIdrisDocumentContext(host: ActiveDocumentHost): IDisposable {
  let current: boolean | undefined;
  const update = (): void => {
    const doc = host.activeDocument();
    const value = doc !== undefined && isIdrisDocument(doc);
    if (value !== current) {
      current = value;
      host.setContext(IS_IDRIS_DOCUMENT_CONTEXT_KEY, value);
    }
  };
  update();
  const events = host.onDidChangeActiveDocument(update);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      events.dispose();
      if (current === true) {
        current = false;
        host.setContext(IS_IDRIS_DOCUMENT_CONTEXT_KEY, false);
      }
    },
  };
}
