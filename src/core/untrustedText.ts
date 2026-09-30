/**
 * How compiler text is shown (M3): in a hover or tooltip (`codeBlock`, `visible`, `MarkdownSink`),
 * in a QuickPick item (`quickPickText`), and drawn inside a line — an inlay hint's label, the label
 * of an evaluation result, a decoration's `contentText` (`editorLabel`). Shared by
 * `features/intelligence` and `features/eval`.
 *
 * Everything the compiler sends — types, docs, values, error messages, namespace listings — quotes
 * the user's source and that of installed packages, so it is shown as text and never interpreted
 * (`features/intelligence/types.ts`, *Untrusted text*). Its control and format characters are
 * written out as `\u{…}`: they would otherwise act where the text is drawn — the bidirectional
 * controls (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C; `\p{Cf}`) reorder the text after
 * them, so that a value could read like another one (the "Trojan Source" technique,
 * CVE-2021-42574), and zero-width characters hide what is there; an Idris identifier may hold
 * either, since every character above U+00A0 is an identifier character (`isIdentTrailing`,
 * `src/Parser/Lexer/Common.idr` [src]). VS Code's `editor.renderControlCharacters` shows such
 * characters in the document, not in text an extension adds. Drawn inside a line, the text must
 * also be one line.
 *
 * No dependency on `vscode`.
 */

/**
 * A line break (CR LF, LF, CR, U+0085, U+2028, U+2029) with the spaces and tabs around it: the
 * compiler breaks a long type or value over lines and indents the continuation, which one line
 * shows as one space. Other runs of spaces are kept, since they may be the content of a string.
 */
const LINE_BREAK = /[ \t]*(?:\r\n|[\n\r\u0085\u2028\u2029])[ \t]*/g;

/**
 * The characters `editorLabel` and `visible` write out: controls (`\p{Cc}`, C0 and C1, the tab
 * included), format characters (`\p{Cf}`: the bidirectional controls, the zero-width characters
 * U+200B–U+200D, U+2060 and U+FEFF, the soft hyphen, the invisible operators, the tag characters,
 * among others), the other default-ignorable code points (`\p{Default_Ignorable_Code_Point}`: in
 * Node 24.13's Unicode data 267 assigned ones that are neither, drawn as nothing — the combining grapheme joiner U+034F, the
 * variation selectors U+FE00–U+FE0F and U+E0100–U+E01EF, the Mongolian ones U+180B–U+180D and
 * U+180F, U+17B4 and U+17B5 — or as a blank — the Hangul fillers U+115F, U+1160, U+3164 and
 * U+FFA0), and U+2800, the blank braille pattern: M2's `shownPath` writes all of them out
 * (`core/notificationText.ts` `HIDDEN`; the second review of M3 found them missing here, so
 * `: N\u{34F}a\u{FE0F}t` was drawn as `: Nat`). For `editorLabel`, line breaks have become spaces
 * before this applies.
 *
 * Why the class must never be narrowed below the controls: the label of an evaluation result is a
 * decoration's `contentText`, which VS Code 1.139.1 puts into a CSS rule as `content:'…';`,
 * escaping only `'` and `\` and keeping the text up to the first line terminator
 * (`contentText.match(/^.*$/m)[0].replace(/['\\]/g, …)` [src, the workbench bundle]); `.` matches
 * U+000C, which CSS's input preprocessing turns into a line feed that ends the string, so the text
 * after it would be read as CSS [reasoned from CSS Syntax 3, not run in VS Code].
 */
const INVISIBLE_CLASS = String.raw`\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800`;
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'gu');

/** A character of `INVISIBLE` as `\u{XXXX}`. */
const writtenOut = (c: string): string => `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;

/**
 * `text` as one line for a label the editor draws: the ends are trimmed, each line break with the
 * spaces and tabs around it becomes one space, and each remaining character of `INVISIBLE` (a
 * control or format character, another default-ignorable code point, U+2800) is written as
 * `\u{XXXX}` (module comment). When the result has more than `maxLength` UTF-16 code
 * units it is cut at a character boundary and ends with `…`.
 */
export function editorLabel(text: string, maxLength = Number.POSITIVE_INFINITY): string {
  const line = text
    .trim()
    .replace(LINE_BREAK, ' ')
    .replace(INVISIBLE, writtenOut);
  if (line.length <= maxLength) {
    return line;
  }
  let cut = '';
  for (const c of line) {
    if (cut.length + c.length > maxLength - 1) {
      break;
    }
    cut += c;
  }
  return `${cut}…`;
}

/**
 * What the hovers render through (`vscode.MarkdownString`). Compiler text goes in only inside a
 * `codeBlock`, never through `MarkdownString.appendText`, whose escaper in VS Code 1.139.1 leaves
 * `&`, `<` and `:` alone: a named character reference (`&rlm;`) came out as the invisible
 * character, and `<https://…>` as a link (`features/intelligence/hover.ts`, *review of M3*).
 */
export interface MarkdownSink {
  /** Taken as markdown: only this extension's own text, or a code block from `codeBlock`. */
  appendMarkdown(value: string): unknown;
}

/**
 * The info string of a `codeBlock`: `idris2` for Idris text (a type, a value), `text` for prose (a
 * doc overview, an error message) — never empty, and never compiler text. VS Code 1.139.1 colours a
 * block without an info string in the language of the editor the hover belongs to
 * (`renderCodeBlock`: `o ? getLanguageIdByLanguageName(o) : …getModel()?.getLanguageId()` [src,
 * the workbench bundle]), so a docstring's prose was coloured by the Idris grammar (second review of
 * M3); `text` is an alias of `plaintext` there (`registerLanguage({id: "plaintext", …, aliases:
 * [<Plain Text>, "text"]})`, and aliases are what `getLanguageIdByLanguageName` looks up [src]).
 */
export type CodeBlockLanguage = 'idris2' | 'text';

/**
 * A fenced code block holding `text` verbatim, as markdown. The fence is a run of backticks
 * longer than every run of backticks anywhere in `text` (at least three), so that no line of
 * `text` can close it: CommonMark closes a backtick fence with a line of at least as many
 * backticks indented by up to three spaces, and VS Code 1.139.1's own `appendCodeblock` sizes its
 * fence by the runs at the start of a line only (`$6` in the extension host bundle [src]), which a
 * line of two spaces and three backticks escapes. `language`: `CodeBlockLanguage`. The block starts
 * and ends on a line of its own. The longest run is found by one pass over the text, so that any
 * number of runs works (*review of M3*: spreading one argument per run into `Math.max` threw
 * `RangeError` from about 125,000 runs on Node 24.13 [unit-level]).
 */
export function codeBlock(text: string, language: CodeBlockLanguage): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `\n${fence}${language}\n${text}\n${fence}\n`;
}

/**
 * `text` with the characters of `INVISIBLE` (controls, format characters, the other
 * default-ignorable code points, U+2800) written out as `\u{XXXX}` (module comment), line feeds
 * kept: for compiler text a hover or tooltip shows, which is rendered markdown, not document text,
 * so the editor's marking of such characters is not expected to reach it (not checked in VS Code).
 * The multi-line counterpart of `editorLabel`.
 */
export function visible(text: string): string {
  return text.replace(INVISIBLE, (c) => (c === '\n' ? c : writtenOut(c)));
}

/**
 * `text` for a QuickPick item's `label`, `description` or `detail`, which render `$(<name>)` as a
 * theme icon [doc: `QuickPickItem` in `@types/vscode` 1.138.0]: a zero-width space (U+200B)
 * between every `$` and a `(` after it, so that no icon can be formed and the text reads the same.
 */
export function quickPickText(text: string): string {
  return text.replace(/\$(?=\()/g, () => '$\u200b');
}
