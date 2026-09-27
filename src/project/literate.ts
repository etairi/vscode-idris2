/**
 * The single document-selector rule (`project/literate.ts` in docs/ARCHITECTURE.md §2, §3.2,
 * decision D21) and the bird-track line helper that `core/positions.ts` needs (F11).
 *
 * Every provider, command enablement, view and `when` clause is registered through
 * `idrisDocumentSelector()` / `isIdrisDocument()` / the `idris2.isIdrisDocument` context key,
 * never with a bare language id, so that later milestones widen what counts as an Idris
 * document by adding rows to `IDRIS_DOCUMENT_TABLE` instead of retrofitting registrations:
 * M1 adds literate styles detected by file extension (the compiler's table in
 * `src/Parser/Unlit.idr`), M12 content detection for literate hosts (Markdown, LaTeX, …) that
 * keep their own language ids.
 *
 * The module has no runtime dependency on `vscode` (only type imports), so it is unit-tested on
 * plain Node; `extension.ts` supplies the editor events for the context key.
 */
import type * as vscode from 'vscode';
import type { IDisposable } from '../core/disposable';

/**
 * A literate style whose code lines carry a line marker the compiler strips. M0 knows only the
 * bird style of `.lidr` files (`styleBird = MkLitStyle Nil [">", "<"] [".lidr"]` in
 * `src/Parser/Unlit.idr`, identical on master 1c630e6 and v0.8.0).
 */
export type LiterateStyle = 'bird';

/** What the selector rule needs to know about a document; `vscode.TextDocument` satisfies it. */
export interface IdrisDocumentCandidate {
  readonly languageId: string;
}

interface IdrisDocumentRow {
  /** A language id contributed in package.json. */
  readonly languageId: string;
  /** How the compiler reads documents of this language; `undefined` for plain source. */
  readonly literate: LiterateStyle | undefined;
}

/** M0 table: the two language ids whose documents the compiler reads as Idris 2 source. */
const IDRIS_DOCUMENT_TABLE: readonly IdrisDocumentRow[] = [
  { languageId: 'idris2', literate: undefined },
  { languageId: 'lidr', literate: 'bird' },
];

/** The context key kept equal to `isIdrisDocument(activeTextEditor.document)`. */
export const IS_IDRIS_DOCUMENT_CONTEXT_KEY = 'idris2.isIdrisDocument';

/** The document selector every Idris registration uses (ARCHITECTURE §3.2). */
export function idrisDocumentSelector(): vscode.DocumentFilter[] {
  return IDRIS_DOCUMENT_TABLE.map((row) => ({ language: row.languageId }));
}

export function isIdrisDocument(doc: IdrisDocumentCandidate): boolean {
  return IDRIS_DOCUMENT_TABLE.some((row) => row.languageId === doc.languageId);
}

/** The literate style of `doc`, or `undefined` for plain source and for non-Idris documents. */
export function literateStyleOf(doc: IdrisDocumentCandidate): LiterateStyle | undefined {
  return IDRIS_DOCUMENT_TABLE.find((row) => row.languageId === doc.languageId)?.literate;
}

/**
 * What the compiler's choice of literate style needs to know about a document;
 * `vscode.TextDocument` satisfies it.
 */
export interface CompiledDocument extends IdrisDocumentCandidate {
  readonly fileName: string;
  readonly isUntitled: boolean;
}

/**
 * The file-name suffixes of the bird style: `styleBird = MkLitStyle Nil [">", "<"] [".lidr"]` in
 * `src/Parser/Unlit.idr` (master 1c630e6 and v0.8.0); no other style lists `.lidr`.
 */
const BIRD_EXTENSIONS: readonly string[] = ['.lidr'];

/**
 * The literate style the compiler applies to `doc`, as far as M0 knows styles (bird only).
 * The compiler decides by the file name, not by the editor's language mode: it unlits a file
 * when `isLitFile fname` finds a style whose extension is a (case-sensitive) suffix of the name
 * (`isSuffixOf`, `src/Parser/Unlit.idr`; idris2 0.8.0 `--check` parses a bird-track `Up.LIDR`
 * as plain source and fails at the `>`). So a `.lidr` file switched to the `idris2` mode is
 * still bird-style for the compiler, and a `.idr` file in the `lidr` mode is not. A document
 * that was never saved has no file name the compiler could see; its language mode decides.
 */
export function compilerLiterateStyleOf(doc: CompiledDocument): LiterateStyle | undefined {
  if (doc.isUntitled) {
    return literateStyleOf(doc);
  }
  return BIRD_EXTENSIONS.some((ext) => doc.fileName.endsWith(ext)) ? 'bird' : undefined;
}

/**
 * Whitespace as the compiler's `isSpace` defines it (`libs/prelude/Prelude/Types.idr`):
 * space, `\t`, `\r`, `\n`, `\f`, `\v` and U+00A0.
 */
const IDRIS_SPACE = new Set([' ', '\t', '\r', '\n', '\f', '\v', '\u00a0']);

/**
 * Width of the bird-track marker the compiler strips from `lineText` (one line, without its
 * line break), or `undefined` when the line is not a code line.
 *
 * Source (`src/Libraries/Text/Literate.idr`, identical on master and v0.8.0): a code line is
 * `exact m <+> (newline <|> space <+> untilEOL)` for a marker `m` in `[">", "<"]`, lexed from
 * the start of the line, where `space` is exactly one `isSpace` character; `reduce` then keeps
 * `substr (length m + 1) …`, i.e. drops the marker and that one character. So:
 * - `"> x"`, `">\tx"`, `">   x"` → 2 (only one space is stripped; the rest is code indentation);
 * - `">"` alone → 1 (an empty code line);
 * - `">x"` → `undefined`: not a code line at all — the compiler treats it as prose.
 * Verified with idris2 0.8.0 `--check`: a name declared on a `>x : Nat` line is undefined, and
 * errors on `>\tg = "x"` and `>   g = "x"` are reported at file column − 2.
 */
export function birdPrefixWidth(lineText: string): number | undefined {
  const marker = lineText.charAt(0);
  if (marker !== '>' && marker !== '<') {
    return undefined;
  }
  if (lineText.length === 1) {
    return 1;
  }
  return IDRIS_SPACE.has(lineText.charAt(1)) ? 2 : undefined;
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
