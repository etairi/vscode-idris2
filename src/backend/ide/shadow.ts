/**
 * The copy of an unsaved document that a `shadow` session checks (ROADMAP M6; ARCHITECTURE §6.3;
 * `types.ts` `SessionRole`): where it is written and the package file written beside it. Pure; the
 * backend writes the files (`backend.ts`, *Unsaved text*).
 *
 * **Layout.** A root's shadow directory (`SessionPool.shadowDirectory`: `<globalStorage>/shadow/<hash
 * of the root>`, so that no name of the root shows) holds `shadow.ipkg`, the copy at
 * `src/<path of the document below the root's source directory>`, so that the compiler gives it the
 * module name the `check` session gives the file, and `build/`, the session's `--build-dir`. The
 * compiler finds the copy's imports of the root's other modules in the `check` session's build
 * directory (`IDRIS2_PATH`, F8, F32); `src/` holds only the copy of the document checked last
 * (`backend.ts`): the compiler looks for an import in its own build directory before the search path
 * (`nsToPath`, `src/Core/Directory.idr` 198–207 on v0.8.0 [src]), so a module built there from
 * another document's unsaved text would hide the `check` session's.
 *
 * **The package file** (E9, settled 2026-10-24). At every `:load-file` the compiler walks up from
 * its working directory to the first directory with an `.ipkg` and applies that package
 * (`findIpkg`, `src/Idris/Package.idr` 1093–1109, called by every IDE-mode `:load-file`,
 * `src/Idris/IDEMode/REPL.idr` 145–149 [src]; F13): its `builddir`, its `opts` as `preOptions`
 * (`processOptions`, 460–467), and its `depends`, resolved with their version bounds and their own
 * dependencies (`addDeps`, 392–455). `shadow.ipkg` gives the copy the root's `depends` and `opts`
 * that way, so that the copy is checked as the `check` session checks the file. On a command line
 * `-p` adds one package and none of its dependencies (`addPkgDir p anyBounds`,
 * `src/Idris/SetOptions.idr` 188–193, 436–438 [src]): with `-p test` alone a module importing
 * `Test.Golden` failed with `Error: Module System.Path not found` (`test` depends on `contrib`),
 * and loaded with a `shadow.ipkg` of `depends = test` [live, 0.8.0, 2026-10-24, scratch E9b]. The
 * package file also ends the compiler's walk in the shadow directory, so that no `.ipkg` above the
 * extension's storage is applied. It has no `builddir`, and `sourcedir = "src"`, which a load applies
 * over a `--source-dir` of the command line (`idris2.ideMode.extraArgs`).
 *
 * **The options left out** (`LEFT_OUT`): those that name the compiler's directories or the files it
 * writes — `--build-dir`, `--source-dir`, `--output-dir` and the `--dump…` files: in the shadow
 * session they would move the copy's build or source directory, or write where the user's own
 * build writes. Every other option acts as it does in the `check` session, where the compiler
 * applies the same words the same way (`preOptions`).
 */
import { createHash } from 'crypto';
import * as path from 'path';
import { packageOptionWords } from '../../project/ipkg';
import type { Classification, IpkgVersionBounds } from '../../project/types';
import { rootKey } from '../registry';

/** The package file of a shadow directory (module comment). */
export const SHADOW_PACKAGE_FILE = 'shadow.ipkg';
/** The source directory of a shadow directory, which holds the copy. */
export const SHADOW_SOURCE_DIR = 'src';
/** The build directory of a shadow directory (the `shadow` session's `--build-dir`). */
export const SHADOW_BUILD_DIR = 'build';

/** How an option of the compiler's parser takes the word after it. */
type OptionWord = 'required' | 'optional';

/**
 * The options of the compiler's parser and the words each takes (`options`,
 * `src/Idris/CommandLine.idr` 234–394 on v0.8.0 [src]), read as `processArgs` reads them (453–487):
 * a `Required`, `RequiredNat`, `AutoNat` or `RequiredLogLevel` argument takes the next word whatever it
 * is (the compiler rejects a word that is not a number or a log level, which only an option that is
 * kept can be); an `Optional` one takes it unless it starts with `-`.
 */
const OPTION_WORDS: ReadonlyMap<string, readonly OptionWord[]> = new Map<string, readonly OptionWord[]>([
  ...[
    '--check',
    '-c',
    '--no-prelude',
    '--whole-program',
    '--wp',
    '--profile',
    '--no-cse',
    '--total',
    '-Werror',
    '-Wno-shadowing',
    '-Xcheck-hashes',
    '-Xcase-tree-opt',
    '--prefix',
    '--paths',
    '--libdir',
    '--list-packages',
    '--find-ipkg',
    '--ignore-missing-ipkg',
    '--ide-mode',
    '--no-banner',
    '--quiet',
    '-q',
    '--show-implicits',
    '--show-machine-names',
    '--show-namespaces',
    '--color',
    '--colour',
    '--no-color',
    '--no-colour',
    '--verbose',
    '--version',
    '-v',
    '--ttc-version',
    '--debug-elab-check',
  ].map((flag): [string, readonly OptionWord[]] => [flag, []]),
  ...[
    '--output',
    '-o',
    '--exec',
    '-x',
    '--codegen',
    '--cg',
    '--incremental-cg',
    '--inc',
    '--directive',
    '--package',
    '-p',
    '--source-dir',
    '--build-dir',
    '--output-dir',
    '--client',
    '--timing',
    '--console-width',
    '--log',
    '--yaffle',
    '--ttimp',
    '--ttm',
    '--dumpcases',
    '--dumplifted',
    '--dumpanf',
    '--dumpvmcode',
    '--alt-error-count',
    '--bash-completion-script',
    '--zsh-completion-script',
  ].map((flag): [string, readonly OptionWord[]] => [flag, ['required']]),
  ...['--init', '--dump-ipkg-json', '--dump-installdir', '--build', '--install', '--install-with-src', '--mkdoc', '--typecheck', '--clean', '--repl', '--ide-mode-socket', '--help', '-h', '-?'].map(
    (flag): [string, readonly OptionWord[]] => [flag, ['optional']],
  ),
  ['--bash-completion', ['required', 'required']],
]);

/** The options the package file leaves out, each with the word it takes (module comment). */
const LEFT_OUT: ReadonlySet<string> = new Set(['--build-dir', '--source-dir', '--output-dir', '--dumpcases', '--dumplifted', '--dumpanf', '--dumpvmcode']);

/**
 * The words of an `.ipkg`'s `opts` (split as the compiler splits them, `packageOptionWords`) that the
 * package file keeps, and those it leaves out (`LEFT_OUT`, with their words), in order; `sourceDir`:
 * the directory of the last `--source-dir` among them, which the compiler applies at every load of
 * the package after its `sourcedir` (`findIpkg`). The words are read with the compiler's parser only
 * when one of the options left out is among them; otherwise all are kept as they are, and the
 * compiler reports a mistake in them as it does for the `check` session. `problem`: one of the
 * options left out is among them and the words cannot be read (an unknown option, an option without
 * its word), or a word holds a control character, which the package file cannot carry; there is no
 * check of unsaved text for such a package.
 */
export function shadowPackageOptions(
  opts: string | undefined,
): { readonly kept: readonly string[]; readonly left: readonly string[]; readonly sourceDir: string | undefined } | { readonly problem: string } {
  const words = packageOptionWords(opts);
  const control = words.find((word) => /[\u0000-\u001f\u007f]/.test(word));
  if (control !== undefined) {
    return { problem: `the package's opts contain a word with a control character (${JSON.stringify(control)})` };
  }
  if (!words.some((word) => LEFT_OUT.has(word))) {
    return { kept: words, left: [], sourceDir: undefined };
  }
  const kept: string[] = [];
  const left: string[] = [];
  let sourceDir: string | undefined;
  for (let i = 0; i < words.length; ) {
    const word = words[i];
    const takes = OPTION_WORDS.get(word);
    if (takes === undefined) {
      if (word.startsWith('--')) {
        return { problem: `the package's opts contain "${word}", which the compiler does not know` };
      }
      // An input file to the compiler's parser, which a load ignores (`preOptions`).
      kept.push(word);
      i += 1;
      continue;
    }
    let end = i + 1;
    for (const argument of takes) {
      const next = words[end];
      if (argument === 'required') {
        if (next === undefined) {
          return { problem: `the package's opts end with ${word} without its value` };
        }
        end += 1;
      } else if (next !== undefined && !next.startsWith('-')) {
        end += 1;
      }
    }
    if (LEFT_OUT.has(word)) {
      left.push(...words.slice(i, end));
      if (word === '--source-dir') {
        sourceDir = words[i + 1];
      }
    } else {
      kept.push(...words.slice(i, end));
    }
    i = end;
  }
  return { kept, left, sourceDir };
}

/** A version of the package file's syntax (`sepBy1 dot' integerLit`, `src/Idris/Package.idr` 158–175 [src]). */
const VERSION = /^\d+(\.\d+)*$/;

/** The bounds of a dependency as the package file writes them (`depends`, `src/Idris/Package.idr` 156–199 [src]). */
function boundsText(bounds: IpkgVersionBounds): string | undefined {
  const parts: string[] = [];
  if (bounds.lower !== undefined) {
    if (!VERSION.test(bounds.lower)) {
      return undefined;
    }
    parts.push(`${bounds.lowerInclusive ? '>=' : '>'} ${bounds.lower}`);
  }
  if (bounds.upper !== undefined) {
    if (!VERSION.test(bounds.upper)) {
      return undefined;
    }
    parts.push(`${bounds.upperInclusive ? '<=' : '<'} ${bounds.upper}`);
  }
  return parts.join(' && ');
}

/**
 * `raw` as a string literal of the package file. The compiler's ipkg lexer keeps a literal's text as
 * it is between the quotes (`StringLit (stripQuotes s)`, `src/Parser/Lexer/Package.idr` 115 on
 * v0.8.0 [src]), escapes included, and so does an `.ipkg`'s model (`project/ipkg.ts`): the words of
 * a field read that way are written back as they are.
 */
function stringLiteral(raw: string): string {
  return `"${raw}"`;
}

/**
 * The text of `shadow.ipkg` for `root` (module comment), and the source directory of the root, as
 * the `check` session's loads use it, relative to the root's session directory or absolute
 * (`shadowCopyPath`); or why there is no check of unsaved text for the root. `extraArgs`:
 * `idris2.ideMode.extraArgs`, whose last `--source-dir` the `check` session keeps when its package
 * names none.
 */
export function shadowPackage(root: Classification, extraArgs: readonly string[]): { readonly text: string; readonly sourceDir: string } | { readonly problem: string } {
  const header = '-- Written by the Idris 2 extension for VS Code to check unsaved text; rewritten before every check of it.\n';
  const fromExtraArgs = lastSourceDir(extraArgs);
  if (root.kind === 'loose') {
    return { text: `${header}package shadow\nsourcedir = ${stringLiteral(SHADOW_SOURCE_DIR)}\n`, sourceDir: fromExtraArgs ?? '.' };
  }
  if (root.model.status !== 'ok') {
    return { problem: 'its package file could not be read' };
  }
  const model = root.model.model;
  const options = shadowPackageOptions(model.opts);
  if ('problem' in options) {
    return options;
  }
  const depends: string[] = [];
  for (const dependency of model.depends) {
    const bounds = boundsText(dependency.bounds);
    if (bounds === undefined) {
      return { problem: `the version bounds of its dependency ${dependency.name} cannot be written in a package file` };
    }
    depends.push(bounds === '' ? dependency.name : `${dependency.name} ${bounds}`);
  }
  const lines = [`package ${model.name}`, `sourcedir = ${stringLiteral(SHADOW_SOURCE_DIR)}`];
  if (depends.length > 0) {
    lines.push(`depends = ${depends.join(', ')}`);
  }
  if (options.kept.length > 0) {
    lines.push(`opts = ${stringLiteral(options.kept.join(' '))}`);
  }
  return { text: `${header}${lines.join('\n')}\n`, sourceDir: options.sourceDir ?? model.sourcedir ?? fromExtraArgs ?? '.' };
}

/** The directory of the last `--source-dir` of a command line's words (`undefined`: none, or one without its directory). */
function lastSourceDir(words: readonly string[]): string | undefined {
  let dir: string | undefined;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--source-dir') {
      dir = words[i + 1];
      i += 1;
    }
  }
  return dir;
}

/**
 * The path of `fileName`'s copy below the shadow directory's `src/` (module comment): its path below
 * `sourceDir` (`shadowPackage`), resolved against `cwd`, the root's session directory, where the
 * compiler resolves it; or why it has none — the file is not inside that directory, where the
 * compiler would not check it as a module of the package either.
 */
export function shadowCopyPath(cwd: string, sourceDir: string, fileName: string, platform: NodeJS.Platform): { readonly relative: string } | { readonly problem: string } {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const dir = pathApi.resolve(cwd, sourceDir);
  const relative = pathApi.relative(dir, fileName);
  if (relative === '' || relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    return { problem: `${pathApi.basename(fileName)} is not inside the source directory ${dir}` };
  }
  return { relative };
}

/** The directory of `root`'s `shadow` session under `base` (`SessionPool.shadowDirectory`): a hash of the root, so that no name of it shows. */
export function shadowDirectoryOf(base: string, root: Classification, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(base, createHash('sha256').update(rootKey(root)).digest('hex').slice(0, 16));
}
