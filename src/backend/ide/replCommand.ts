/**
 * Whether the compiler's REPL parser could read a text as a REPL command rather than an
 * expression (`backend/ide/replCommand.ts`): the refusal of **Idris 2: Evaluate Selection**
 * (`IdrisBackend.evaluate`; ROADMAP §9, decided 2026-09-28: evaluate expressions only). IDE mode's
 * `(:interpret "TEXT")` hands `TEXT` to the REPL's `interpret` (`process (Interpret cmd)`,
 * `src/Idris/IDEMode/REPL.idr` 143–144), which parses it with `parseRepl` and runs what it finds
 * (`src/Idris/REPL.idr` 1144–1163), so `:exec` would run a program, `:set eval execute` change the
 * session's evaluation mode for good (F27), `:sh` run a shell command, `:cd` move the compiler.
 * The rule must therefore be **at least as strict as the parser**: every text the parser reads as
 * a command is refused; refusing some texts it would read as an expression is acceptable.
 *
 * **What the parser does** [src, v0.8.0 `15a3e4e`; the rules cited are textually identical on
 * master `1c630e6`]:
 * 1. `runParser (Virtual Interactive) Nothing inp (parseEmptyCmd <|> parseCmd)` lexes the whole
 *    text without an unlit step (`src/Parser/Source.idr` 16–40) and drops the `Space` and
 *    `Comment` tokens before parsing (`lexTo`, `src/Parser/Lexer/Source.idr` 367–395).
 *    `Space` is one character for which the Prelude's `isSpace` holds: `' '`, `\t`, `\r`, `\n`,
 *    `\f`, `\v`, U+00A0 (`libs/prelude/Prelude/Types.idr` 929–936). `Comment` is a line comment
 *    (`--`, more dashes, not followed by `}`, to the end of the line) or a block comment
 *    (`{-` … `-}`, nested, with string and character literals inside skipped;
 *    `src/Parser/Lexer/Common.idr` 10–65). A doc comment `|||` is a token of its own.
 * 2. `command` (`src/Idris/Parser.idr` 2751–2759) is `eoi` (nothing), one of the commands of
 *    `parserCommandsForHelp`, `:?`, or else an expression (`eval`). Every command's rule starts with
 *    `symbol ":"` (all 19 command-rule builders, lines 2333–2675), and `:?` with `symbol ":?"`: a
 *    `Symbol` token, which the lexer makes of a run of operator characters
 *    (`validSymbol = some (pred isOpChar)`, `isOpChar` = one of ``:!#$%&*+./<=>?@\^|-~``,
 *    `src/Core/Name.idr` 87–88). So a text is read as a command exactly when its first token that is
 *    not a space or a comment is the symbol `:` or `:?` — the ASCII colon: U+FF1A (fullwidth colon)
 *    and the like are no operator characters.
 *
 * **The rule here**, which does not reproduce the comment lexer (a mistake there, e.g. about a
 * `-}` inside a string in a block comment, would let a command through): skip every leading
 * character that is white space, a control character or a format character in Unicode
 * (`\p{White_Space}`, `\p{Cc}`, `\p{Cf}` — a superset of the compiler's `isSpace`, and also
 * U+3000, U+200B, U+FEFF, which the compiler does not skip); then the text is refused when it
 * starts with `:`, and, when it starts with `--` or `{-` (a comment may start there), when a `:`
 * appears anywhere after that. It is at least as strict as the parser: if the parser's first
 * token is `:` or `:?`, everything before it is spaces (skipped here too) and comments; with no
 * comment the first character left here is that `:`; with one, the text left here starts with the
 * first comment's `--` or `{-` (neither `-` nor `{` is skipped) and the `:` comes after it. It
 * refuses more than the parser: expressions after a leading comment that contain a `:` (a type
 * annotation `\x : Nat => x`, a cons `x :: xs`), texts starting with `::` or `:=`, and a colon
 * after U+3000, U+200B or U+FEFF (a parse error for the compiler) — acceptable, since such text is
 * rarely selected to be evaluated and the reason says what to do.
 *
 * Checked against the compiler [live, transcript `eval-command-forms`, 2026-09-29]: `:t id` ran as
 * a command after a space, tab, CR, LF, VT, FF or U+00A0, after `{- c -}` and after `-- c` and a
 * line break, and written `: t id`; it did not after U+3000, U+200B or U+FEFF, after `||| d` and a
 * line break (parse errors), with U+FF1A for the colon (an identifier) or as `:T id`.
 */

/**
 * Characters skipped before the first token: Unicode white space, control and format characters
 * (a superset of the compiler's `isSpace`, module comment).
 */
const SKIPPED = /^[\p{White_Space}\p{Cc}\p{Cf}]*/u;

/**
 * Why `text` is not evaluated because the compiler's REPL parser could read it as a command
 * (module comment), as one sentence of plain text; `undefined` when it is read as an expression.
 */
export function replCommandRefusal(text: string): string | undefined {
  const rest = text.slice(SKIPPED.exec(text)?.[0].length ?? 0);
  if (rest.startsWith(':')) {
    return (
      'Not evaluated: the text starts with ":", so the compiler would read it as a REPL command (such as :exec or :set), ' +
      'and Evaluate Selection evaluates expressions only. Programs are run from a terminal.'
    );
  }
  if ((rest.startsWith('--') || rest.startsWith('{-')) && rest.includes(':')) {
    return (
      'Not evaluated: the text starts with a comment and contains ":", so the compiler could read it as a REPL command ' +
      '(such as :exec or :set) after the comment, and Evaluate Selection evaluates expressions only. Select the expression without the comment.'
    );
  }
  return undefined;
}
