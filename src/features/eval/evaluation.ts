/**
 * The text side of **Idris 2: Evaluate Selection** (ROADMAP M3; `register.ts` is the command and
 * the decorations): which text is evaluated, and how the compiler's answer is shown.
 *
 * **The expression** is the selected text. In a document with line markers (the compiler's view,
 * `compilerLiterateStyleOf`: bird tracks `> `/`< `, Org's `#+IDRIS: `) the markers are left out of
 * each selected code line (`linePrefixWidth`, F11). A selection in a bird-track document that
 * reaches into a prose line with anything but white space is not evaluated (prose is not Idris). In
 * an Org document a line without the marker is prose or a line of a `#+BEGIN_SRC` block, which this
 * version does not tell apart (the blocks are M12's, E19): a selection within one such line is sent
 * as it is (a block's line is code; prose gets the compiler's parse error), and one over several
 * lines that reaches into one with anything but white space is not evaluated (third review of M3:
 * the markers were left out for bird tracks only, so the continuation lines of an Org selection were
 * sent with their `#+IDRIS: ` [unit-level]). White space alone is not evaluated either. **A
 * selection over several lines keeps every line's column**: its first line is indented by one space
 * per column the compiler counts before the selection's start (`core/positions.ts`
 * `toCompilerColumn`), since the lines after it keep theirs and Idris's layout rule is
 * column-sensitive — sent from column 0, a `let`, `case … of`, `do` or `where` block opened on the
 * first line no longer lines up with its continuation lines [live, 2026-09-29, one `timeout 60
 * idris2 --ide-mode`: `(:interpret "let a = 1\n        b = 2\n    in a + b")` answers `Undefined
 * name b`, and with the first line indented by 4 spaces `3`; `do x <- Just 1` over two lines `Last
 * statement in do block must be an expression`, indented `Just 2`; a continuation line indented less
 * than the first line's start (`    plus 1\n  2`) still answers `3`] (*review of M3*). A selection
 * within one line is sent as it is: indenting it would move every column of it by the same amount,
 * which changes nothing the parser compares — the columns of its tokens with each other, and with
 * the REPL's own indentation 0, which every token after the first exceeds either way [src, v0.8.0:
 * the REPL parses `typeExpr pdef (Virtual Interactive) init`, `src/Idris/Parser.idr` 2744–2745;
 * `init = 0` and `continueF`, `src/Parser/Rule/Source.idr` 473–482]. Whether the text is an expression at all — not
 * a REPL command such as `:exec` — is decided by the backend before anything is sent
 * (`IdrisBackend.evaluate`; ROADMAP §9, 2026-09-28); its rule skips leading white space.
 *
 * **The answer** (`Evaluation`) is compiler text, which quotes the user's and installed packages'
 * source: the label after the line is one line with its control and format characters written out
 * (`editorLabel`, `core/untrustedText.ts`), and the hover has it, its control and format
 * characters written out too (`visible`), in a code block whose fence no line of it can close
 * (`codeBlock`), in a `MarkdownString` that is not trusted and has no HTML or theme icons
 * (`register.ts`). What the compiler answers [live,
 * 0.8.0, transcripts `eval-values`, `eval-socket`]: a value as it prints it (`[1, 2]`, `"hi!"` with
 * the quotes, `\x => plus x 1`); an `IO` action normalised, not run — `the (IO ()) (putStrLn "hi")`
 * is `MkIO (prim__putStr "hi\n")`, and nothing is printed over either transport —; and a bare
 * `putStrLn "hi"` is the error `Can't find an implementation for HasIO ?io.`, since nothing fixes
 * its monad. The hover says both.
 */
import type { Evaluation } from '../../backend/types';
import { toCompilerColumn, type EditorRange, type PositionDocument } from '../../core/positions';
import { codeBlock, editorLabel, visible, type MarkdownSink } from '../../core/untrustedText';
import { compilerLiterateStyleOf, hasLineMarkers, linePrefixWidth } from '../../project/literate';

/** What `selectedExpression` reads of a document; `vscode.TextDocument` satisfies it. */
export type SelectionDocument = PositionDocument;

export type SelectedExpression =
  | { readonly kind: 'expression'; readonly text: string }
  /** Nothing but white space is selected. */
  | { readonly kind: 'empty' }
  /** The selection reaches into prose on `line` (0-based, of the document) of a bird-track document. */
  | { readonly kind: 'prose'; readonly line: number }
  /**
   * A selection over several lines of an Org document reaches into `line` (0-based, of the
   * document), which has no `#+IDRIS:` marker: prose or a block's line (module comment).
   */
  | { readonly kind: 'unmarked'; readonly line: number };

/** The text to evaluate for `selection` of `doc` (module comment, *The expression*). */
export function selectedExpression(doc: SelectionDocument, selection: EditorRange): SelectedExpression {
  const style = compilerLiterateStyleOf(doc);
  const markers = hasLineMarkers(style);
  const lines: string[] = [];
  for (let line = selection.start.line; line <= selection.end.line; line++) {
    const text = doc.lineAt(line).text;
    const from = line === selection.start.line ? selection.start.character : 0;
    const to = line === selection.end.line ? selection.end.character : text.length;
    const marker = markers ? linePrefixWidth(style, text) : 0;
    if (marker === undefined) {
      if (style === 'org' && selection.start.line === selection.end.line) {
        lines.push(text.slice(from, to));
        continue;
      }
      if (/\S/u.test(text.slice(from, to))) {
        return style === 'org' ? { kind: 'unmarked', line } : { kind: 'prose', line };
      }
      lines.push('');
      continue;
    }
    lines.push(text.slice(Math.max(from, marker), Math.max(to, marker)));
  }
  const text = lines.join('\n');
  if (!/\S/u.test(text)) {
    return { kind: 'empty' };
  }
  const indent = lines.length > 1 ? ' '.repeat(toCompilerColumn(doc, selection.start) ?? 0) : '';
  return { kind: 'expression', text: indent + text };
}

/** The longest label drawn after a line, in UTF-16 code units; the hover has the whole answer. */
export const MAX_LABEL_LENGTH = 120;

/** The first line of an error message, without the `Error: ` the compiler puts before most. */
function errorSummary(message: string): string {
  return (message.split(/\r\n|\n|\r/u, 1)[0] ?? '').replace(/^Error: /u, '');
}

/** The label drawn after the evaluated text's last line: `= <value>` or `✗ <first line of the error>`. */
export function resultLabel(evaluation: Evaluation): string {
  if (evaluation.kind === 'error') {
    return `✗ ${editorLabel(errorSummary(evaluation.message.text), MAX_LABEL_LENGTH)}`;
  }
  const value = editorLabel(evaluation.value.text, MAX_LABEL_LENGTH);
  return value === '' ? '= (no value)' : `= ${value}`;
}

/** Whether `value` is an `IO` action as the compiler normalises one (`MkIO (prim__putStr "hi\n")`). */
function isIoAction(value: string): boolean {
  return /^MkIO\b/u.test(value);
}

/** Whether `message` is the compiler's answer to an `IO` action whose monad nothing fixes. */
function isUnfixedIo(message: string): boolean {
  return message.includes("Can't find an implementation for HasIO");
}

/**
 * Appends the hover over an evaluated text to `md` (module comment, *The answer*). `stale`: the
 * document had unsaved changes when it was evaluated, so the names in the expression were looked
 * up in the saved file.
 */
export function appendResultHover(md: MarkdownSink, evaluation: Evaluation, stale: boolean): void {
  if (evaluation.kind === 'value') {
    md.appendMarkdown('**Idris 2: value**\n');
    md.appendMarkdown(codeBlock(visible(evaluation.value.text), 'idris2'));
    if (isIoAction(evaluation.value.text)) {
      md.appendMarkdown('\nAn `IO` action is shown as the compiler normalises it, not run: Evaluate Selection evaluates expressions only.\n');
    }
  } else {
    md.appendMarkdown('**Idris 2: not evaluated**\n');
    md.appendMarkdown(codeBlock(visible(evaluation.message.text), 'text'));
    if (isUnfixedIo(evaluation.message.text)) {
      md.appendMarkdown('\nTo see an `IO` action, give its type, as in `the (IO ()) (putStrLn "hi")`; it is shown, not run.\n');
    }
  }
  if (stale) {
    md.appendMarkdown('\n_The file had unsaved changes: the names in the expression refer to the file as saved._\n');
  }
}
