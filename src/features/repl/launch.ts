/**
 * The command line of a REPL terminal and the text typed into it, without `vscode`
 * (`features/repl/types.ts`).
 *
 * **The command line** [live, Idris 2 0.8.0, 2026-10-30, in a pseudo-terminal on copies of the fixtures].
 * A project's REPL is `idris2 --find-ipkg <file>`, not ROADMAP's `idris2 --repl <ipkg>`: after `--repl`,
 * `:r` answers `No file can be reloaded`, and the prompt is the package's last module, not the file the
 * user is in. With `--find-ipkg` the prompt is the file's module, the package's `depends` and `sourcedir`
 * apply, and `:r` rebuilds what an edit changed, an imported module included. A file outside a package
 * is `idris2 [-p <package>…] <file>`. Either starts on a file with errors, and `:r` loads it once they
 * are fixed. The build goes to the project's own build directory, as for `idris2` in a terminal of the
 * user's, never to the `check` session's.
 *
 * **rlwrap.** The compiler's REPL reads plain lines: the Up arrow arrives as the text `^[[A`, a parse
 * error, and there is no history. `rlwrap`, found on `PATH`, gives both; without it the terminal has
 * what its line discipline has.
 *
 * **One line.** What is typed into the terminal is one line, whatever is selected: line breaks become
 * spaces, so that text cannot run a second command, and text with a control character is not typed
 * at all (Ctrl+C, Ctrl+D and the like act on the terminal, not on the text; M1's rule for terminals).
 */
import * as path from 'path';
import type { IdeModeSettings } from '../../core/config';
import type { Classification } from '../../project/types';

/** What a REPL terminal runs. */
export interface ReplLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The command line of the REPL of `file`, relative to the directory the terminal starts in (module comment). */
export function replLaunch(input: {
  readonly root: Classification;
  readonly relativeFile: string;
  readonly idris2: string;
  readonly rlwrap?: string;
  readonly cwd: string;
  readonly settings: Pick<IdeModeSettings, 'loosePackages' | 'extraArgs'>;
  readonly env: Readonly<Record<string, string>>;
}): ReplLaunch {
  const { root, settings } = input;
  const packages = root.kind === 'project' ? ['--find-ipkg'] : settings.loosePackages.flatMap((pkg) => ['-p', pkg]);
  const args = [...packages, ...settings.extraArgs, input.relativeFile];
  return input.rlwrap === undefined
    ? { executable: input.idris2, args, cwd: input.cwd, env: input.env }
    : { executable: input.rlwrap, args: [input.idris2, ...args], cwd: input.cwd, env: input.env };
}

/** The folder a terminal's name shows: a window can have a REPL per project. */
export function replTerminalName(root: Classification): string {
  return `Idris 2 REPL: ${path.basename(root.dir)}`;
}

const LINE_BREAK = /\r\n|[\r\n\v\f\u2028\u2029\u0085]/;

export type ReplLine =
  | { readonly kind: 'line'; readonly text: string }
  /** Nothing but white space. */
  | { readonly kind: 'empty' }
  /** It has a control character. */
  | { readonly kind: 'control' };

/** `text` as the one line that is typed into a REPL (module comment). */
export function replLine(text: string): ReplLine {
  const line = text
    .split(LINE_BREAK)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ')
    .replace(/\t/g, ' ');
  if (line === '') {
    return { kind: 'empty' };
  }
  return /\p{Cc}/u.test(line) ? { kind: 'control' } : { kind: 'line', text: line };
}
