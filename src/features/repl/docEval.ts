/**
 * `-- >>> expr` lines (ROADMAP M8), without `vscode`: which lines they are, and the comment that holds
 * an answer. `register.ts` is the lenses and their commands.
 *
 * **A line** is a line comment of its own that reads `-- >>> text`, as the lexer sees it: so not inside
 * a string or a block comment, not `--- >>>`, and not prose in a literate file. A bird-track line keeps
 * its marker. Document styles the lexer does not read (M12's) have none.
 *
 * **The answer** goes beneath the line as `-- text = answer`, and a further line of the answer as
 * `--   line`. Running a line again replaces those lines. The answer is compiler text and goes into
 * the user's file: each of its lines starts with the comment marker, so it stays a comment whatever it
 * says, and control and format characters are written out (`visible`).
 */
import type { TextReplacement } from '../../backend/types';
import type { EditorRange } from '../../core/positions';
import { visible } from '../../core/untrustedText';
import { compilerLiterateStyleOf, linePrefixWidth } from '../../project/literate';
import { editorRange } from '../holes/navigation';
import { syntaxModelOf, type TextDoc } from '../intelligence/occurrence';

export interface DocEvalLine {
  /** 0-based. */
  readonly line: number;
  /** What follows `-- >>> `. */
  readonly text: string;
  /** What comes before the `--` on the line: its indentation, a bird track. */
  readonly prefix: string;
  /** The comment. */
  readonly range: EditorRange;
}

const DOC_EVAL = /^-- +>>> +(\S.*?)\s*$/;

/** The `-- >>>` lines of `doc`, in order (module comment). */
export function docEvalLines(doc: TextDoc): readonly DocEvalLine[] {
  const model = syntaxModelOf(doc);
  if (model === undefined) {
    return [];
  }
  const style = compilerLiterateStyleOf(doc);
  const found: DocEvalLine[] = [];
  for (const token of model.tokens) {
    if (token.kind !== 'comment') {
      continue;
    }
    const range = editorRange(model, token);
    if (range.start.line !== range.end.line) {
      continue;
    }
    const lineText = doc.lineAt(range.start.line).text;
    const text = DOC_EVAL.exec(lineText.slice(range.start.character))?.[1];
    const prefix = lineText.slice(0, range.start.character);
    if (text !== undefined && prefix.slice(linePrefixWidth(style, lineText) ?? 0).trim() === '') {
      found.push({ line: range.start.line, text, prefix, range });
    }
  }
  return found;
}

/** The comment lines that hold `answer` for `line` (module comment). */
export function answerLines(line: DocEvalLine, answer: string): readonly string[] {
  const [first, ...rest] = answer
    .trimEnd()
    .split(/\r\n|[\r\n\v\f\u2028\u2029\u0085]/)
    .map((part) => visible(part).trimEnd());
  return [`${line.prefix}-- ${line.text} = ${first}`, ...rest.map((part) => `${line.prefix}--   ${part}`)];
}

/** The replacement that writes `answer` beneath `line`, over the answer of an earlier run (module comment). */
export function answerReplacement(doc: TextDoc, line: DocEvalLine, answer: string): TextReplacement {
  const lines = answerLines(line, answer).join('\n');
  const firstOfOld = `${line.prefix}-- ${line.text} = `;
  const next = line.line + 1;
  if (next < doc.lineCount && doc.lineAt(next).text.startsWith(firstOfOld)) {
    let last = next;
    while (last + 1 < doc.lineCount && doc.lineAt(last + 1).text.startsWith(`${line.prefix}--   `)) {
      last++;
    }
    return {
      range: { start: { line: next, character: 0 }, end: { line: last, character: doc.lineAt(last).text.length } },
      text: lines,
    };
  }
  const end = { line: line.line, character: doc.lineAt(line.line).text.length };
  return { range: { start: end, end }, text: `\n${lines}` };
}
