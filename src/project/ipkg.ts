/**
 * `.ipkg` discovery and reading (`project/ipkg.ts` in docs/ARCHITECTURE.md §2; ROADMAP M1).
 *
 * - **Discovery** (`findIpkg`) walks up from a directory to the file-system root the way the
 *   compiler's `findIpkgFile` walks up from its working directory (F13): in each directory it
 *   takes the **first** entry, in the order the OS lists the directory, whose extension is
 *   `ipkg`, and it stops, finding nothing, at a directory it cannot list.
 * - **Reading** (`readIpkgModel`) accepts only a regular file of at most 256 KiB
 *   (`MAX_IPKG_BYTES`), then runs `idris2 --dump-ipkg-json <absolute path>` (D11) in the
 *   compiler's own directory when the caller passes a compiler (`project/index.ts`: a probed
 *   one, in a trusted workspace, for an `.ipkg` inside a workspace folder) and the compiler's
 *   path parser reads that path unchanged (`compilerReadsPathAsGiven`), and otherwise reads the
 *   text with a port of the compiler's ipkg lexer and parser (the *fallback reader*,
 *   `readIpkgText`).
 *
 * Compiler behaviour this module relies on [src: Idris2 v0.8.0; `src/Core/Directory.idr`,
 * `src/Idris/Package.idr`, `src/Idris/Package/ToJson.idr`, `src/Parser/Lexer/Package.idr`,
 * `src/Parser/Rule/Package.idr`, `src/Parser/Lexer/Common.idr`, `src/Libraries/Text/Lexer.idr`]
 * and runs of idris2 0.8.0 on the development machine [live, 2026-09-27]:
 *
 * - `findIpkgFile` lists a directory with `listDir` and takes `find (\f => extension f == Just
 *   "ipkg")` of the names, unsorted, where `extension` reads the name with the compiler's path
 *   parser (`isIpkgFileName`). `listDir` collects `nextDirEntry`, a call into the support
 *   library's `idris2_nextDirEntry`, whose C source is not in the checkouts consulted; the order
 *   it yields matched `readdir(3)` on the development machine. Node's `fs.readdir` **sorts** the
 *   names (libuv's scandir), whereas `fs.opendir` yields `readdir(3)` order, so the walk lists
 *   with `opendir`. [live, APFS: in a directory whose `ls -f` order was `c.ipkg b.ipkg d.ipkg
 *   X.idr a.ipkg`, `opendir` gave the same order, `readdir` the sorted one, and
 *   `idris2 --find-ipkg --check X.idr` read `c.ipkg`; other file systems and Windows not tried.]
 *   Only names count (`listDir` does not look at entry types): a directory or a symbolic link
 *   named `x.ipkg` stops the walk like a file would.
 * - `--dump-ipkg-json <file>` splits `<file>` with the compiler's path parser (`splitParent`),
 *   changes into the directory part (`setWorkingDir`, which ignores a failed `chdir`), parses the
 *   file part there, resolves every listed module to a source file (a missing one fails with
 *   `Error: Module <M> not found`) and prints the package as JSON on stdout (`processPackage`,
 *   `src/Idris/Package.idr` 966–973, 1000; `setWorkingDir`, `src/Core/Context.idr` 2188–2193).
 *   The flag's argument is `Optional`, so an argument that starts with `-` is not taken as the
 *   file (`src/Idris/CommandLine.idr` 291, 483–486): `--dump-ipkg-json -x.ipkg` printed no JSON
 *   [live, M1 review]. **Strings are printed raw** (`toJson str = "\"\{str}\""`): an
 *   ipkg string literal keeps its escapes verbatim (`stripQuotes` only drops the quotes), so
 *   `sourcedir = "s\\rc"` is printed `"sourcedir": "s\\rc"` and means the compiler's value
 *   `s\\rc`, while `JSON.parse` would return `s\rc`; a newline inside a string literal is
 *   printed as a raw newline, which `JSON.parse` rejects [live]. `parseDumpJson` therefore reads
 *   strings raw. Warnings are printed on stdout **before** the JSON (`version = "0.1"` printed
 *   `Warning: Deprecation warning: version numbers must now be of the form x.y.z`) [live].
 * - Parse errors go to **stderr** with exit code 1: `Error: <message>` (`Unrecognised property
 *   "pkgs".`, `Expected end of file.`, `Module Nope not found`), a blank line, the location
 *   `"<file>":L:C--L:C` (1-based, end exclusive, as `core/positions.ts` describes CLI text) and a
 *   source excerpt (F10) [live].
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Log } from '../core/log';
import { readRegularTextFile } from '../toolchain/fileSystem';
import type { ProcessResult, ProcessRunner } from '../toolchain/types';
import { isIdrisSpace } from './literate';
import type { IpkgDependency, IpkgError, IpkgModel, IpkgModelState, IpkgVersionBounds } from './types';

// -------------------------------------------------------------------------------------------
// Discovery
// -------------------------------------------------------------------------------------------

/** Lists a directory's entry names in the order the OS returns them; `undefined` if it cannot. */
export type DirectoryLister = (dir: string) => Promise<readonly string[] | undefined>;

/** The `DirectoryLister` of the running system: `fs.opendir`, which keeps `readdir(3)` order. */
export async function listDirectoryInOsOrder(dir: string): Promise<readonly string[] | undefined> {
  const names: string[] = [];
  try {
    // Iterating with for-await closes the directory handle when the loop ends or throws.
    for await (const entry of await fs.promises.opendir(dir)) {
      names.push(entry.name);
    }
  } catch {
    return undefined;
  }
  return names;
}

// -------------------------------------------------------------------------------------------
// The compiler's path parser
// -------------------------------------------------------------------------------------------

/** A path as the compiler's `Libraries.Utils.Path.parse` reads it (`Path` there). */
interface CompilerPath {
  readonly volume:
    | { readonly kind: 'disk'; readonly letter: string }
    | { readonly kind: 'unc'; readonly server: string; readonly share: string }
    | undefined;
  readonly hasRoot: boolean;
  /** The body components; `.` and `..` stand for `CurDir` and `ParentDir`. */
  readonly body: readonly string[];
  readonly hasTrailSep: boolean;
}

type PathToken = { readonly punct: '/' | '\\' | ':' | '?' } | { readonly text: string };

/**
 * A port of `parse` in `src/Libraries/Utils/Path.idr` (v0.8.0: lexer 156–166, grammar 169–282;
 * master differs only by one import): `/`, `\`, `:` and `?` are punctuation on every platform, everything else
 * is text; an optional volume (`\\?\server\share`, `\\?\C:`, `\\server\share`, or `C:` — the
 * first character of any text followed by `:`), an optional root (separators), the body
 * components between separators, an optional trailing separator. The parser stops at the first
 * token it cannot use and **ignores the rest** (`a:b/c` reads as `a:b`, `x?y` as `x`); body
 * components that are empty after dropping leading white space are removed, and so is the first
 * `.` after the first component.
 */
function parseCompilerPath(text: string): CompilerPath {
  const tokens: PathToken[] = [];
  for (const m of text.matchAll(/[/\\:?]|[^/\\:?]+/g)) {
    tokens.push('/\\:?'.includes(m[0]) ? { punct: m[0] as '/' | '\\' | ':' | '?' } : { text: m[0] });
  }
  const punct = (i: number, c: string): boolean => {
    const t = tokens[i];
    return t !== undefined && 'punct' in t && t.punct === c;
  };
  const sep = (i: number): boolean => punct(i, '/') || punct(i, '\\');
  const textAt = (i: number): string | undefined => {
    const t = tokens[i];
    return t !== undefined && 'text' in t ? t.text : undefined;
  };
  const verbatim = (i: number): number | undefined =>
    punct(i, '\\') && punct(i + 1, '\\') && punct(i + 2, '?') && punct(i + 3, '\\') ? i + 4 : undefined;
  const serverShare = (i: number | undefined): [CompilerPath['volume'], number] | undefined => {
    const server = i === undefined ? undefined : textAt(i);
    const share = i === undefined || !sep(i + 1) ? undefined : textAt(i + 2);
    return i === undefined || server === undefined || share === undefined ? undefined : [{ kind: 'unc', server, share }, i + 3];
  };
  const disk = (i: number | undefined): [CompilerPath['volume'], number] | undefined => {
    const first = i === undefined ? undefined : Array.from(textAt(i) ?? '')[0];
    // Prelude's toUpper changes only a–z (libs/prelude/Prelude/Types.idr 949–953).
    const letter = first !== undefined && first >= 'a' && first <= 'z' ? first.toUpperCase() : first;
    return i === undefined || letter === undefined || !punct(i + 1, ':') ? undefined : [{ kind: 'disk', letter }, i + 2];
  };
  const [volume, afterVolume] =
    serverShare(verbatim(0)) ??
    disk(verbatim(0)) ??
    serverShare(punct(0, '\\') && punct(1, '\\') ? 2 : undefined) ??
    disk(0) ?? [undefined, 0];
  let i = afterVolume;
  const separators = (): boolean => {
    const start = i;
    while (sep(i)) {
      i++;
    }
    return i > start;
  };
  const hasRoot = separators();
  const body: string[] = [];
  if (textAt(i) !== undefined) {
    body.push(textAt(i++) as string);
    for (;;) {
      const start = i;
      if (!separators() || textAt(i) === undefined) {
        i = start;
        break;
      }
      body.push(textAt(i++) as string);
    }
  }
  const hasTrailSep = separators();
  const kept = body.filter((b) => b === '.' || b === '..' || Array.from(b).some((c) => !isIdrisSpace(c)));
  const firstCurDir = kept.indexOf('.', 1);
  return { volume, hasRoot, body: firstCurDir < 0 ? kept : kept.filter((_, k) => k !== firstCurDir), hasTrailSep };
}

/** `show` of a `Path` with the platform's separator (`Show Volume`, `Show Path`, Path.idr 115–130). */
function showCompilerPath(p: CompilerPath, separator: string): string {
  const volume =
    p.volume === undefined ? '' : p.volume.kind === 'disk' ? `${p.volume.letter}:` : `\\\\${p.volume.server}\\${p.volume.share}`;
  return volume + (p.hasRoot ? separator : '') + p.body.join(separator) + (p.hasTrailSep ? separator : '');
}

/** The path the compiler reads for the POSIX path `file` (`show (parse file)` with `/`). */
export function compilerReading(file: string): string {
  return showCompilerPath(parseCompilerPath(file), '/');
}

/**
 * Whether the compiler reads the absolute path `file` as that same path: its `splitParent` of
 * `file` (which `--dump-ipkg-json` changes into) then names `file`'s directory and base name.
 * Not so when a component contains `:` or `?` (the parser stops there), or on POSIX `\` (a
 * separator for the compiler), or is only white space (dropped); the compiler would then read
 * another file, or a file of that name in its working directory, since `setWorkingDir` ignores a
 * failed `chdir` [live, idris2 0.8.0 with the absolute path run from `/opt/homebrew/bin`: a
 * directory `co:lon` gave `Packages must have an '.ipkg' extension`, one named `back\slash` or
 * `' '` gave `Error: File error in p.ipkg : File Not Found`]. On Windows the drive letter is
 * compared without case (the compiler prints it upper-case) and `/` counts as `\` [open: the
 * compiler's handling of `C:\…` there was not run].
 */
export function compilerReadsPathAsGiven(file: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') {
    return compilerReading(file) === file;
  }
  const expected = file.replace(/\//g, '\\').replace(/^[a-z](?=:)/, (letter) => letter.toUpperCase());
  return showCompilerPath(parseCompilerPath(file), '\\') === expected;
}

/**
 * Whether the compiler counts a directory entry as a package file: `extension name == Just
 * "ipkg"` (`findIpkgFile`, `src/Core/Directory.idr` 333–349), where `extension` takes the last
 * body component of `parse name` (`fileName`, skipping a trailing `.`; none after a `..`) and
 * then the text after its last `.`, unless that `.` is its first character (`fileName'`,
 * `splitFileName`, `fileName`, `extension`: `src/Libraries/Utils/Path.idr` 337–360, 522–548). Case-sensitive: `A.IPKG` does not count,
 * and neither does a file named just `.ipkg`. Because the name goes through the path parser, a
 * POSIX name with `\`, `:` or `?` may count differently from its last `.`: `a?b.ipkg` (read as
 * `a`) and `x\.ipkg` (last component `.ipkg`) do not count, `a.ipkg\` (a trailing separator)
 * and `a:b.ipkg` (volume `a:`) do [live, M1 review, idris2 0.8.0 `--find-ipkg --check`: the
 * first three; the fourth from the source].
 */
export function isIpkgFileName(name: string): boolean {
  const body = parseCompilerPath(name).body;
  let last = body.length - 1;
  while (last >= 0 && body[last] === '.') {
    last--;
  }
  const fileName = last < 0 || body[last] === '..' ? undefined : body[last];
  if (fileName === undefined) {
    return false;
  }
  const dot = fileName.lastIndexOf('.');
  return dot > 0 && fileName.slice(dot + 1) === 'ipkg';
}

/** The package files of one directory, as the compiler's walk sees them. */
export interface IpkgCandidates {
  readonly dir: string;
  /** The one the compiler reads: the first package file in listing order. */
  readonly ipkgPath: string;
  /** The other package files of `dir`, in listing order (F10: the UI warns about them). */
  readonly otherIpkgs: readonly string[];
}

/** The package files among `names` (a listing of `dir`), or `undefined` if there are none. */
export function ipkgCandidates(dir: string, names: readonly string[]): IpkgCandidates | undefined {
  const ipkgs = names.filter(isIpkgFileName).map((name) => path.join(dir, name));
  return ipkgs.length === 0 ? undefined : { dir, ipkgPath: ipkgs[0], otherIpkgs: ipkgs.slice(1) };
}

/**
 * The package files of the nearest directory at or above `startDir` that has one, walking up to
 * the file-system root (F13; the workspace folder does not cap the walk), or `undefined` when
 * there is none or the walk reaches a directory it cannot list.
 *
 * `startDir` is walked as given, logically. The compiler walks up from `getcwd()`, which is the
 * physical path, so when `startDir` lies below a symbolic link the two walks visit different
 * directories above the link (not below it). The extension starts every session in the
 * directory this walk returns (or in the file's own directory, for a loose file), so the
 * compiler finds the same package file in its first step, except for a loose file below a link
 * whose physical ancestors hold a package file that the logical ones do not: before each load of
 * a loose file, `backend/ide/backend.ts` walks again from the real path and refuses the load
 * when a package file is found.
 *
 * The walk goes up with `path.dirname`; the compiler's with `splitParent`, which parses the path
 * with its own parser (`findIpkgFile`, `src/Core/Directory.idr` 333–349; `splitParent`,
 * `src/Libraries/Utils/Path.idr` 323–332, 456–460 on v0.8.0 [src]). They visit the same
 * directories only when the compiler reads the path as given (`compilerReadsPathAsGiven`): on
 * POSIX a `\` is a separator to it, so from `r/x\y` it goes up to `r/x`, a directory this walk never
 * lists [M2 second verification of the third review: live with 0.8.0]; so `backend.ts` sends no
 * load from a session directory whose real path the compiler reads otherwise.
 */
export async function findIpkg(
  startDir: string,
  listDirectory: DirectoryLister = listDirectoryInOsOrder,
): Promise<IpkgCandidates | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    const names = await listDirectory(dir);
    if (names === undefined) {
      return undefined;
    }
    const found = ipkgCandidates(dir, names);
    if (found !== undefined) {
      return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

// -------------------------------------------------------------------------------------------
// Reading
// -------------------------------------------------------------------------------------------

/** A probed compiler to read package files with. */
export interface IpkgCompiler {
  readonly runner: ProcessRunner;
  /** Absolute path of an `idris2` the toolchain service has probed. */
  readonly executable: string;
  /** `idris2.toolchain.env`, which every `idris2` process gets. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Time limit of one `--dump-ipkg-json` run: the 5 s of ROADMAP M1's probes. The run parses one
 * file and checks that the listed modules and `main` exist; a run that times out falls back to
 * the built-in reader.
 */
const DUMP_TIMEOUT_MS = 5_000;

/**
 * The largest package file read, by either reader: 256 KiB. Real ones are a few KiB: the
 * largest of the 43 in the Idris 2 v0.8.0 and master sources, idris2-pack and the test corpora is
 * `idris2api.ipkg`, 7,771 bytes [live, 2026-09-27]. The fallback reader runs on the Extension
 * Host's thread, which every extension shares, in time linear in the text: a crafted `depends`
 * list took 0.47 s at 375 KB and 1.3 s at 1 MB [live, Node 24.13, development machine], so the
 * general 1 MiB limit of `readRegularTextFile` would let a planted file (read in Restricted Mode
 * too) stall it for more than a second, and each root is read at least twice at activation.
 */
export const MAX_IPKG_BYTES = 256 * 1024;

/**
 * Reads the package file at `ipkgPath` (absolute). First the extension reads the file itself
 * with `readRegularTextFile`: a path that is not a regular file of at most `MAX_IPKG_BYTES` (a directory,
 * a FIFO, a device such as a symbolic link to `/dev/zero`) is an error model at once, and
 * neither reader sees it — the compiler would wait on a FIFO, and on a directory too (the M1
 * review saw `idris2 --dump-ipkg-json d.ipkg` on a directory `d.ipkg` still running when
 * `timeout 120` stopped it; not re-run here). Then, with `compiler`, it runs `idris2
 * --dump-ipkg-json <ipkgPath>` in the compiler's own directory (the runner's default), not in
 * the package's: the compiler changes into the package directory itself (module comment), but
 * only after it has started, and starting a program in a directory can load code from there
 * (ROADMAP M1 As built, *Processes*), and pack's wrapper would also merge the `pack.toml` of that
 * directory and of every parent. The output is the same [live: stdout, stderr and exit code of
 * all 12 recorded fixtures, `test/unit/support/ipkgRecordings.ts`, errors included], and an
 * absolute path never starts with `-` (module comment). When `compilerReadsPathAsGiven` says
 * the compiler would read another path (the compiler is then not run), when the run fails (not
 * started, killed, timed out, output that is neither the JSON nor an `Error:`), and without
 * `compiler`, it returns what the fallback reader makes of the text it read. (The compiler opens the file
 * by name again, so a file replaced between the two reads costs at most the run's time limit.)
 * Never rejects.
 */
export async function readIpkgModel(
  ipkgPath: string,
  compiler: IpkgCompiler | undefined,
  log: Log,
): Promise<IpkgModelState> {
  const fileName = path.basename(ipkgPath);
  const file = await readRegularTextFile(ipkgPath, MAX_IPKG_BYTES);
  if (!file.ok) {
    return { status: 'error', source: 'fallback', error: { message: `${fileName} ${file.problem}, so it was not read.` } };
  }
  if (compiler !== undefined && !compilerReadsPathAsGiven(ipkgPath, process.platform)) {
    log.warn(
      `idris2 --dump-ipkg-json was not run on ${ipkgPath}: the compiler's path parser would read another path ` +
        '(a directory name with ":", "?", a backslash, or only white space); reading it with the built-in reader.',
    );
  } else if (compiler !== undefined) {
    try {
      const result = await compiler.runner.run({
        executable: compiler.executable,
        args: ['--dump-ipkg-json', ipkgPath],
        env: compiler.env,
        timeoutMs: DUMP_TIMEOUT_MS,
      });
      const state = modelFromDumpOutput(result);
      if (state !== undefined) {
        return state;
      }
      log.warn(`idris2 --dump-ipkg-json ${ipkgPath}: ${describeFailedRun(result)}; reading it with the built-in reader.`);
    } catch (error) {
      log.warn(`idris2 --dump-ipkg-json ${ipkgPath} was not run (${String(error)}); reading it with the built-in reader.`);
    }
  }
  return readIpkgText(file.text);
}

function describeFailedRun(result: ProcessResult): string {
  if (result.spawnError !== undefined) {
    return `could not start (${result.spawnError})`;
  }
  if (result.timedOut) {
    return 'timed out';
  }
  if (result.exitCode === null) {
    return `ended by signal ${result.signal ?? 'unknown'}`;
  }
  return `exit code ${result.exitCode} with output that is neither the package JSON nor an error`;
}

/**
 * The model or error in the output of one `--dump-ipkg-json` run, or `undefined` when the run
 * did not produce either (not started, killed, timed out, unrecognised output) — the caller
 * then uses the fallback reader.
 */
export function modelFromDumpOutput(result: ProcessResult): IpkgModelState | undefined {
  if (result.spawnError !== undefined || result.timedOut || result.exitCode === null) {
    return undefined;
  }
  if (result.exitCode === 0) {
    const json = parseDumpJson(result.stdout);
    const model = json === undefined ? undefined : modelFromJson(json);
    return model === undefined ? undefined : { status: 'ok', source: 'dump-json', model };
  }
  const error = compilerError(result.stderr) ?? compilerError(result.stdout);
  return error === undefined ? undefined : { status: 'error', source: 'dump-json', error };
}

/**
 * The first `Error: …` report in `text`: the message runs from after `Error: ` to the first
 * blank line; the range is the first `"<file>":L:C--L:C` line after it, if any. The file in
 * that line is not compared with the package file: `--dump-ipkg-json` reads no other file whose
 * errors carry a location.
 */
function compilerError(text: string): IpkgError | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('Error: '));
  if (start < 0) {
    return undefined;
  }
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '') {
    end++;
  }
  const message = [lines[start].slice('Error: '.length), ...lines.slice(start + 1, end)].join('\n');
  for (const line of lines.slice(end)) {
    const m = /^"(?:[^"\\]|\\.)*":(\d+):(\d+)--(\d+):(\d+)$/.exec(line.trim());
    if (m !== null) {
      return {
        message,
        range: { startLine: Number(m[1]), startColumn: Number(m[2]), endLine: Number(m[3]), endColumn: Number(m[4]) },
      };
    }
  }
  return { message };
}

/** A JSON value as `--dump-ipkg-json` prints it: strings are raw, numbers and `null` never occur. */
export type DumpJsonValue = string | boolean | readonly DumpJsonValue[] | ReadonlyMap<string, DumpJsonValue>;

/**
 * The package object in the stdout of `--dump-ipkg-json`: it starts at the first line that
 * begins with `{"name": ` (warnings may come before it) and must run to the end of the output.
 * Strings are read raw: the text between the quotes, where a backslash takes the next character
 * with it (as the compiler's `stringLit` lexer and JSON both delimit strings) but no escape is
 * decoded, which yields the compiler's own value. `undefined` when the text is not of that shape.
 */
export function parseDumpJson(stdout: string): ReadonlyMap<string, DumpJsonValue> | undefined {
  const m = /(^|\n)\{"name": /.exec(stdout);
  if (m === null) {
    return undefined;
  }
  const reader = new RawJsonReader(stdout, m.index + m[1].length);
  const value = reader.value();
  reader.skipWhitespace();
  return value instanceof Map && reader.atEnd() ? value : undefined;
}

class RawJsonReader {
  constructor(
    private readonly text: string,
    private pos: number,
  ) {}

  atEnd(): boolean {
    return this.pos === this.text.length;
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length && ' \t\r\n'.includes(this.text[this.pos])) {
      this.pos++;
    }
  }

  /** The value at the current position, or `undefined` if there is none. */
  value(): DumpJsonValue | undefined {
    this.skipWhitespace();
    const c = this.text[this.pos];
    if (c === '"') {
      return this.string();
    }
    if (c === '[') {
      return this.list('[', ']', () => this.value());
    }
    if (c === '{') {
      const entries = this.list('{', '}', () => this.entry());
      return entries === undefined ? undefined : new Map(entries);
    }
    for (const [word, v] of [['true', true], ['false', false]] as const) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return v;
      }
    }
    return undefined;
  }

  private string(): string | undefined {
    const start = ++this.pos;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === '"') {
        return this.text.slice(start, this.pos++);
      }
      this.pos += c === '\\' ? 2 : 1;
    }
    return undefined;
  }

  private entry(): [string, DumpJsonValue] | undefined {
    this.skipWhitespace();
    const key = this.text[this.pos] === '"' ? this.string() : undefined;
    this.skipWhitespace();
    if (key === undefined || this.text[this.pos] !== ':') {
      return undefined;
    }
    this.pos++;
    const value = this.value();
    return value === undefined ? undefined : [key, value];
  }

  /** `open item (, item)* close` or `open close`. */
  private list<T>(open: string, close: string, item: () => T | undefined): T[] | undefined {
    this.pos++;
    const items: T[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === close) {
      this.pos++;
      return items;
    }
    for (;;) {
      const v = item();
      if (v === undefined) {
        return undefined;
      }
      items.push(v);
      this.skipWhitespace();
      const c = this.text[this.pos++];
      if (c === close) {
        return items;
      }
      if (c !== ',') {
        return undefined;
      }
    }
  }
}

/**
 * The `IpkgModel` of a parsed `--dump-ipkg-json` object (`toJson` in `ToJson.idr`): `name`,
 * `depends` (one-key objects `{"<pkg>": <bounds>}`) and `modules` always; `version`, `main`,
 * `executable`, `sourcedir`, `builddir`, `outputdir` and `opts` when set. Other keys are ignored.
 * `undefined` when a field has an unexpected shape.
 */
function modelFromJson(json: ReadonlyMap<string, DumpJsonValue>): IpkgModel | undefined {
  const name = json.get('name');
  const depends = json.get('depends');
  const modules = json.get('modules');
  if (typeof name !== 'string' || !Array.isArray(depends) || !Array.isArray(modules)) {
    return undefined;
  }
  const deps: IpkgDependency[] = [];
  for (const dep of depends as readonly DumpJsonValue[]) {
    const entry = dep instanceof Map && dep.size === 1 ? [...dep][0] : undefined;
    const bounds = entry === undefined ? undefined : boundsFromJson(entry[1]);
    if (entry === undefined || bounds === undefined) {
      return undefined;
    }
    deps.push({ name: entry[0], bounds });
  }
  if (!modules.every((m): m is string => typeof m === 'string')) {
    return undefined;
  }
  const optional: Record<string, string> = {};
  for (const key of ['version', 'main', 'executable', 'sourcedir', 'builddir', 'outputdir', 'opts'] as const) {
    const value = json.get(key);
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    optional[key] = value;
  }
  return { name, depends: deps, modules: [...modules], ...optional };
}

/**
 * The words of an `.ipkg`'s `opts` as the compiler splits them before it parses them as
 * command-line options at every load of the package (`processOptions`: `getOpts (words opts)`,
 * `src/Idris/Package.idr` 460–467 on v0.8.0; `words` splits at `isSpace`: space, `\t`, `\r`,
 * `\n`, `\f`, `\v` and U+00A0, `libs/base/Data/String.idr` 47, `Prelude/Types.idr` 929–937
 * [src]). The field's text is used as written, as the compiler reads it (`strField`).
 */
export function packageOptionWords(opts: string | undefined): readonly string[] {
  return opts === undefined ? [] : opts.split(/[ \t\r\n\f\v\u00a0]+/).filter((word) => word !== '');
}

/** `PkgVersionBounds` as `toJson` prints it; `"*"` is an absent bound. */
function boundsFromJson(value: DumpJsonValue): IpkgVersionBounds | undefined {
  if (!(value instanceof Map)) {
    return undefined;
  }
  const lower = value.get('lowerBound');
  const upper = value.get('upperBound');
  const lowerInclusive = value.get('lowerInclusive');
  const upperInclusive = value.get('upperInclusive');
  if (
    typeof lower !== 'string' ||
    typeof upper !== 'string' ||
    typeof lowerInclusive !== 'boolean' ||
    typeof upperInclusive !== 'boolean'
  ) {
    return undefined;
  }
  return {
    lower: lower === '*' ? undefined : lower,
    lowerInclusive,
    upper: upper === '*' ? undefined : upper,
    upperInclusive,
  };
}

// -------------------------------------------------------------------------------------------
// The fallback reader: a port of the compiler's ipkg lexer and parser
// -------------------------------------------------------------------------------------------

/**
 * Reads the text of a package file the way `parsePkgFile` parses it, without the compiler.
 *
 * It ports the token map of `src/Parser/Lexer/Package.idr` (tried in order at each position,
 * the first lexer that matches wins, each lexer greedy without backtracking, as `scan` and
 * `tokenise` in `src/Libraries/Text/Lexer/Core.idr` do) with the nested-comment automaton of
 * `src/Parser/Lexer/Common.idr`, and the grammar `parsePkgDesc`/`field` of
 * `src/Idris/Package.idr` (alternatives backtrack unless the failing branch is under `mustWork`,
 * which is entered once a field's property name has matched). A field given twice keeps its
 * last value (`addField`), and version numbers are shown as the compiler shows them (`02.010`
 * becomes `2.10`, a negative number `0`). On every package file the compiler accepts it yields
 * the model `--dump-ipkg-json` yields, and its errors carry the compiler's text and range
 * (`fromLexError`, `fromParsingErrors`: the grammar's message with `.` appended, at the token
 * where parsing stopped) — checked against recorded compiler output in
 * `test/unit/ipkg.test.ts`. It reads the text as the compiler's `readFile` delivers it
 * (`compilerView`: a U+FEFF at the start of a line is dropped, a NUL ends its line). It differs
 * in these ways:
 * - it does not check that the listed modules and `main` exist (`addFields` resolves both
 *   with `nsToSource`, `src/Idris/Package.idr` 268–281 [src]; `--dump-ipkg-json` fails with
 *   `Error: Module <M> not found`, for `main = Main.main` without a file `Main/main.idr` too
 *   [live, M1 review]);
 * - where every alternative of a rule fails (a version bound that is none of `<= >= < > ==`, a
 *   `version` that is neither a string nor a number), its message is its own; the compiler
 *   collects one message per alternative;
 * - it gives up, with an error of its own, on a block comment whose automaton needs more work
 *   than `CommentScanner` allows. The compiler's lexer backtracks the same way without a memo,
 *   so it does at least as much work on the same text [src], and on the texts that reach the
 *   cap exponentially more.
 */
export function readIpkgText(text: string): IpkgModelState {
  try {
    const tokens = lexIpkg(Array.from(compilerView(text)));
    if (!Array.isArray(tokens)) {
      return { status: 'error', source: 'fallback', error: tokens };
    }
    return { status: 'ok', source: 'fallback', model: new IpkgParser(tokens).packageDescription() };
  } catch (error) {
    if (error instanceof ParseFailure) {
      return { status: 'error', source: 'fallback', error: { message: error.message, range: printedRange(error.token) } };
    }
    if (error instanceof CommentTooComplex) {
      return { status: 'error', source: 'fallback', error: { message: 'A block comment of the file is too complex for the built-in reader.' } };
    }
    throw error;
  }
}

/**
 * The text the compiler's parser sees for the file content `text`. `readFile` (`libs/base/
 * System/File/ReadWrite.idr`) reads the file one line at a time (`fGetLine`, each line with its
 * `\n`) through a C string (`prim__readLine : FilePtr -> PrimIO (Ptr String)`), so a NUL ends
 * what is kept of its line, the line's `\n` included, and the next line is joined to the rest;
 * and one U+FEFF at the start of a line is dropped (where exactly was not traced; two in a row
 * were not tried) [live, idris2 0.8.0, `test/unit/support/ipkgRecordings.ts`: a byte-order mark
 * at the start of the file and at the start of line 2 were accepted, one inside a line was the
 * token of `Expected string.`; a line `\0x` was dropped, and `"a\0junk` + newline + `b"` read as
 * `"ab"`].
 */
function compilerView(text: string): string {
  if (!text.includes('﻿') && !text.includes('\0')) {
    return text;
  }
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const kept = line.startsWith('﻿') ? line.slice(1) : line;
      const nul = kept.indexOf('\0');
      return nul < 0 ? kept : kept.slice(0, nul);
    })
    .join('');
}

type TokenKind =
  | 'ident' // DotSepIdent
  | 'separator'
  | 'dot'
  | 'lte'
  | 'gte'
  | 'lt'
  | 'gt'
  | 'eqop'
  | 'andop'
  | 'equals'
  | 'string'
  | 'integer'
  | 'end';

interface Token {
  readonly kind: TokenKind;
  /** The token's text; for a string literal without its quotes (`stripQuotes`), escapes kept. */
  readonly text: string;
  /** 0-based line and column (in code points) of the first character and after the last. */
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
}

/**
 * The range the compiler prints for a parse error at `token` (`fromParsingErrors`,
 * `src/Parser/Support.idr`): the token's bounds, widened to one column when they are empty (the
 * end of input), printed 1-based with the end exclusive — 0-based (2,0)–(2,4) is `3:1--3:5`.
 */
function printedRange(token: Token): IpkgError['range'] {
  const empty = token.start[0] === token.end[0] && token.start[1] === token.end[1];
  return {
    startLine: token.start[0] + 1,
    startColumn: token.start[1] + 1,
    endLine: token.end[0] + 1,
    endColumn: token.end[1] + (empty ? 2 : 1),
  };
}

// Character classes of the Idris prelude (`libs/prelude/Prelude/Types.idr`): ASCII only.
const code = (c: string | undefined): number => (c === undefined ? -1 : (c.codePointAt(0) ?? -1));
const isUpper = (c: string | undefined): boolean => code(c) >= 65 && code(c) <= 90;
const isLower = (c: string | undefined): boolean => code(c) >= 97 && code(c) <= 122;
const isDigit = (c: string | undefined): boolean => code(c) >= 48 && code(c) <= 57;
const isAlpha = (c: string | undefined): boolean => isUpper(c) || isLower(c);
const isHexDigit = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c);
const isOctDigit = (c: string | undefined): boolean => code(c) >= 48 && code(c) <= 55;

type Flavour = 'allowDashes' | 'capitalised' | 'normal';

/** `isIdentStart` and `isIdentTrailing` (`src/Parser/Lexer/Common.idr`). */
function isIdentStart(flavour: Flavour, c: string | undefined): boolean {
  if (c === '_') {
    return true;
  }
  return (flavour === 'capitalised' ? isUpper(c) : isAlpha(c)) || code(c) > 160;
}

function isIdentTrailing(flavour: Flavour, c: string | undefined): boolean {
  if (flavour === 'allowDashes' && c === '-') {
    return true;
  }
  return c === "'" || c === '_' || isDigit(c) || isAlpha(c) || code(c) > 160;
}

/** The escape names `charLit`'s `control` tries, in its order (`src/Libraries/Text/Lexer.idr`). */
const CONTROL_NAMES = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'HT', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US',
  'SP', 'DEL',
];

/**
 * A lexer: the index after the text it recognises at `i`, or -1. `comments` is the block-comment
 * automaton of this text, which only `blockComment` uses.
 */
type Recogniser = (cs: readonly string[], i: number, comments: CommentScanner) => number;

function run(cs: readonly string[], i: number, pred: (c: string | undefined) => boolean): number {
  while (i < cs.length && pred(cs[i])) {
    i++;
  }
  return i;
}

function exact(cs: readonly string[], i: number, word: string): number {
  const chars = Array.from(word);
  return chars.every((c, k) => cs[i + k] === c) ? i + chars.length : -1;
}

/** `comment`: `--`, more dashes, not followed by `}`, then up to (not including) a newline. */
const lineComment: Recogniser = (cs, i) => {
  if (cs[i] !== '-' || cs[i + 1] !== '-') {
    return -1;
  }
  const j = run(cs, i + 2, (c) => c === '-');
  return cs[j] === '}' ? -1 : run(cs, j, (c) => c !== '\n');
};

const COMMENT_SPECIAL = new Set(['-', '{', '"', "'"]);

/** Thrown when a block comment needs more work than `CommentScanner` allows. */
class CommentTooComplex extends Error {}

/** The automaton's states; with a position and a depth they key the memo. */
const TO_END_COMMENT = 0;
const SINGLE_BRACE = 1;
const SINGLE_DASH = 2;
const DOUBLE_DASH = 3;

/** A state entered at a position with a depth (`k` of the compiler's functions). */
type Call = readonly [state: number, position: number, depth: number];

/**
 * One step of a state, as the compiler's alternatives define it: the state's result is `result`
 * (a position, or -1 for failure), or that of `tail`, or that of `attempt` unless it fails and
 * then that of `otherwise`. Every state of the automaton has this shape: at most one
 * alternative that can fail after it has matched, followed by one that decides.
 */
type Step = { readonly result: number } | { readonly tail: Call } | { readonly attempt: Call; readonly otherwise: Call };

/**
 * The nested-comment automaton of `src/Parser/Lexer/Common.idr` (`blockComment`,
 * `toEndComment`, `singleBrace`, `singleDash`, `doubleDash`) over one text. The compiler's
 * `scan` (`src/Libraries/Text/Lexer/Core.idr` 105–130) tries the alternatives of a state in
 * order and returns the first that succeeds, the rest of the comment included, so a state's
 * result is a function of the state, the position and the depth alone. When a comment fails
 * late (an unterminated string, the end of input after a `}`), evaluating that by recursion
 * revisits the same states exponentially often, because each `{-` is tried as an opener and
 * then as text [live, the recursive port this replaces: `package a` + newline + `{-` + `{-x` ×
 * n + `"` took 13 ms at n = 18, 51 ms at 20, 203 ms at 22; the M1 review measured 15 s at 28];
 * the compiler's `scan` backtracks the same way [src]. Here results are memoised on (state,
 * position, depth), which changes no result, only how often it is computed; the memo keeps at
 * most `MEMO_LIMIT` entries, so that it cannot take more than a few MiB of the Extension
 * Host's memory. The evaluation is iterative, with an explicit stack of pending attempts, so a
 * long comment cannot exhaust the call stack. The work is capped at `WORK_BASE +
 * WORK_PER_CHARACTER × length` units, one per state evaluated and one per character scanned,
 * after which `CommentTooComplex` is thrown. A comment that does not fail late costs at most
 * two units per character (every character one of `{`, `-`, `'`: two states each), so only a
 * pathological file reaches the cap [live, development machine, Node 24.13: `{-` + `{-x` × 1000
 * + `"` reached it after about 30 ms, the same shape grown to 1 MiB after about 0.17 s with a
 * peak of 241 MB for the whole Node process; a 1 MiB comment of `-x` pairs was read in about
 * 60 ms at 160 MB, and a 1 MiB file of `sourcedir` lines without comments takes 155 MB].
 */
class CommentScanner {
  static readonly WORK_BASE = 100_000;
  static readonly WORK_PER_CHARACTER = 3;
  static readonly MEMO_LIMIT = 200_000;

  private readonly memo = new Map<number, number>();
  private work = 0;
  private readonly workLimit: number;

  constructor(private readonly cs: readonly string[]) {
    this.workLimit = CommentScanner.WORK_BASE + CommentScanner.WORK_PER_CHARACTER * cs.length;
  }

  /** `blockComment`: `{-`, more dashes, then end of input or `toEndComment 1`. */
  blockComment(i: number): number {
    if (this.cs[i] !== '{' || this.cs[i + 1] !== '-') {
      return -1;
    }
    const j = this.run(i + 2, (c) => c === '-');
    return j === this.cs.length ? j : this.evaluate([TO_END_COMMENT, j, 1]);
  }

  private spend(units: number): void {
    this.work += units;
    if (this.work > this.workLimit) {
      throw new CommentTooComplex();
    }
  }

  /** `run` of the lexer, with the characters it passes counted as work. */
  private run(i: number, pred: (c: string | undefined) => boolean): number {
    const j = run(this.cs, i, pred);
    this.spend(j - i);
    return j;
  }

  /**
   * The result of `call`: follows tail calls, and descends into attempts on a stack. `keys`
   * holds the memo keys of the states whose result is not known yet, innermost last; each
   * pending attempt is four numbers on `pending`: where its maker's keys start in `keys`, and
   * the maker's other alternative.
   */
  private evaluate(call: Call): number {
    const keys: number[] = [];
    const pending: number[] = [];
    let owners = 0; // where, in `keys`, the states waiting for the current call begin
    for (;;) {
      let result: number | undefined;
      while (result === undefined) {
        const [state, i, depth] = call;
        if (state === TO_END_COMMENT && depth === 0) {
          result = i; // `toEndComment Z = empty`: the comment is closed
          break;
        }
        const key = (depth * (this.cs.length + 1) + i) * 4 + state;
        result = this.memo.get(key);
        if (result !== undefined) {
          break;
        }
        this.spend(1);
        keys.push(key);
        const step = this.step(state, i, depth);
        if ('result' in step) {
          result = step.result;
        } else if ('tail' in step) {
          call = step.tail;
        } else {
          pending.push(owners, ...step.otherwise);
          owners = keys.length;
          call = step.attempt;
        }
      }
      // Hand the result back: an attempt that succeeded is the result of the states that made
      // it, one that failed sends them on to their other alternative.
      for (;;) {
        for (let n = owners; n < keys.length; n++) {
          if (this.memo.size < CommentScanner.MEMO_LIMIT) {
            this.memo.set(keys[n], result);
          }
        }
        keys.length = owners;
        if (pending.length === 0) {
          return result;
        }
        const [start, state, i, depth] = pending.splice(pending.length - 4, 4);
        owners = start;
        if (result < 0) {
          call = [state, i, depth];
          break;
        }
      }
    }
  }

  private step(state: number, i: number, k: number): Step {
    const cs = this.cs;
    switch (state) {
      case TO_END_COMMENT: {
        // `toEndComment (S k')`, k = S k' ≥ 1: a run of other characters (then the end of
        // input, or more), `{`, `-`, a character literal or a lone `'`, or a string literal.
        if (i >= cs.length) {
          return { result: -1 };
        }
        const c = cs[i];
        if (!COMMENT_SPECIAL.has(c)) {
          const j = this.run(i, (x) => x !== undefined && !COMMENT_SPECIAL.has(x));
          return j === cs.length ? { result: j } : { tail: [TO_END_COMMENT, j, k] };
        }
        if (c === '{') {
          return { tail: [SINGLE_BRACE, i + 1, k - 1] };
        }
        if (c === '-') {
          return { tail: [SINGLE_DASH, i + 1, k - 1] };
        }
        if (c === "'") {
          const j = charLiteral(cs, i);
          this.spend(Math.max(j - i, 1));
          return { tail: [TO_END_COMMENT, j < 0 ? i + 1 : j, k] };
        }
        const j = stringLiteral(cs, i);
        this.spend((j < 0 ? cs.length : j) - i);
        return j < 0 ? { result: -1 } : { tail: [TO_END_COMMENT, j, k] };
      }
      case SINGLE_BRACE: {
        // `singleBrace k`, after a `{` in a comment nested k + 1 deep: `-`, more dashes, then
        // the end of input or `singleDash (S k)`; else `toEndComment (S k)`.
        if (cs[i] === '-') {
          const j = this.run(i + 1, (c) => c === '-');
          return j === cs.length ? { result: j } : { attempt: [SINGLE_DASH, j, k + 1], otherwise: [TO_END_COMMENT, i, k + 1] };
        }
        return { tail: [TO_END_COMMENT, i, k + 1] };
      }
      case SINGLE_DASH:
        // `singleDash k`, after a `-`: `-` then `doubleDash k`, or `}` then `toEndComment k`;
        // else `toEndComment (S k)`.
        if (cs[i] === '-') {
          return { attempt: [DOUBLE_DASH, i + 1, k], otherwise: [TO_END_COMMENT, i, k + 1] };
        }
        if (cs[i] === '}') {
          return { attempt: [TO_END_COMMENT, i + 1, k], otherwise: [TO_END_COMMENT, i, k + 1] };
        }
        return { tail: [TO_END_COMMENT, i, k + 1] };
      default: {
        // `doubleDash k`, after `--`: more dashes, then `}` and `toEndComment k`, or the rest of
        // the line and `toEndComment (S k)`.
        const j = this.run(i, (c) => c === '-');
        const lineComment: Call = [TO_END_COMMENT, this.run(j, (c) => c !== '\n'), k + 1];
        return cs[j] === '}' ? { attempt: [TO_END_COMMENT, j + 1, k], otherwise: lineComment } : { tail: lineComment };
      }
    }
  }
}

/** `charLit`: `'`, an escape or any character but `'`, then `'`. */
function charLiteral(cs: readonly string[], i: number): number {
  if (cs[i] !== "'") {
    return -1;
  }
  let j = i + 1;
  if (cs[j] === '\\') {
    j++;
    const named = CONTROL_NAMES.map((name) => exact(cs, j, name)).find((e) => e >= 0);
    if (named !== undefined) {
      j = named;
    } else if (cs[j] === 'x' && isHexDigit(cs[j + 1])) {
      j = run(cs, j + 1, isHexDigit);
    } else if (cs[j] === 'o' && isOctDigit(cs[j + 1])) {
      j = run(cs, j + 1, isOctDigit);
    } else if (isDigit(cs[j])) {
      j = run(cs, j, isDigit);
    } else if (j < cs.length) {
      j++;
    } else {
      return -1;
    }
  } else if (j < cs.length && cs[j] !== "'") {
    j++;
  } else {
    return -1;
  }
  return cs[j] === "'" ? j + 1 : -1;
}

/** `stringLit`: `"`, then characters or backslash pairs up to the next `"`. */
function stringLiteral(cs: readonly string[], i: number): number {
  if (cs[i] !== '"') {
    return -1;
  }
  let j = i + 1;
  while (j < cs.length) {
    if (cs[j] === '"') {
      return j + 1;
    }
    j += cs[j] === '\\' && j + 1 < cs.length ? 2 : 1;
  }
  return -1;
}

/** `namespacedIdent`: a capitalised identifier, `.Capitalised` parts each followed by `.`, then optionally `.ident`. */
const namespacedIdent: Recogniser = (cs, i) => {
  if (!isIdentStart('capitalised', cs[i])) {
    return -1;
  }
  let j = run(cs, i + 1, (c) => isIdentTrailing('capitalised', c));
  for (;;) {
    if (cs[j] !== '.' || !isIdentStart('capitalised', cs[j + 1])) {
      break;
    }
    const e = run(cs, j + 2, (c) => isIdentTrailing('capitalised', c));
    if (cs[e] !== '.') {
      break;
    }
    j = e;
  }
  if (cs[j] === '.' && isIdentStart('normal', cs[j + 1])) {
    j = run(cs, j + 2, (c) => isIdentTrailing('normal', c));
  }
  return j;
};

const identAllowDashes: Recogniser = (cs, i) =>
  isIdentStart('allowDashes', cs[i]) ? run(cs, i + 1, (c) => isIdentTrailing('allowDashes', c)) : -1;

const word =
  (w: string): Recogniser =>
  (cs, i) =>
    exact(cs, i, w);

const spaces: Recogniser = (cs, i) => {
  const j = run(cs, i, (c) => c !== undefined && isIdrisSpace(c));
  return j > i ? j : -1;
};

const integer: Recogniser = (cs, i) => {
  const start = cs[i] === '-' ? i + 1 : i;
  const j = run(cs, start, isDigit);
  return j > start ? j : -1;
};

/** `rawTokens` of `src/Parser/Lexer/Package.idr`, in order; `undefined` kinds are dropped. */
const TOKEN_MAP: readonly (readonly [Recogniser, TokenKind | undefined])[] = [
  [lineComment, undefined],
  [(_cs, i, comments) => comments.blockComment(i), undefined],
  [namespacedIdent, 'ident'],
  [identAllowDashes, 'ident'],
  [word(','), 'separator'],
  [word('.'), 'dot'],
  [word('<='), 'lte'],
  [word('>='), 'gte'],
  [word('<'), 'lt'],
  [word('>'), 'gt'],
  [word('=='), 'eqop'],
  [word('&&'), 'andop'],
  [word('='), 'equals'],
  [spaces, undefined],
  [stringLiteral, 'string'],
  [integer, 'integer'],
];

/** The tokens of `cs` (code points) followed by an `end` token, or the error where lexing stopped. */
function lexIpkg(cs: readonly string[]): Token[] | IpkgError {
  const tokens: Token[] = [];
  const comments = new CommentScanner(cs);
  let i = 0;
  let line = 0;
  let column = 0;
  while (i < cs.length) {
    let end = -1;
    let kind: TokenKind | undefined;
    for (const [lexer, k] of TOKEN_MAP) {
      end = lexer(cs, i, comments);
      if (end > i) {
        kind = k;
        break;
      }
    }
    if (end <= i) {
      // `fromLexError` (src/Parser/Support.idr): one column where no token could be read.
      return {
        message: "Can't recognise token.",
        range: { startLine: line + 1, startColumn: column + 1, endLine: line + 1, endColumn: column + 2 },
      };
    }
    const chars = cs.slice(i, end);
    const start = [line, column] as const;
    const lastNewline = chars.lastIndexOf('\n');
    if (lastNewline >= 0) {
      line += chars.filter((c) => c === '\n').length;
      column = chars.length - lastNewline - 1;
    } else {
      column += chars.length;
    }
    if (kind !== undefined) {
      const text = chars.join('');
      tokens.push({ kind, text: kind === 'string' ? text.slice(1, -1) : text, start, end: [line, column] });
    }
    i = end;
  }
  tokens.push({ kind: 'end', text: '', start: [line, column], end: [line, column] });
  return tokens;
}

class ParseFailure extends Error {
  constructor(
    message: string,
    readonly token: Token,
    /** Set by `mustWork`: no enclosing alternative may try another branch. */
    readonly fatal: boolean,
  ) {
    super(message);
  }
}

/** `show` of an identifier (`showLitString`): code points above 127 as `\<decimal>`, `\&` before a digit. */
function showIdentifier(name: string): string {
  const chars = Array.from(name);
  const shown = chars
    .map((c, k) => {
      const n = code(c);
      if (n <= 127) {
        return c;
      }
      return `\\${n}${isDigit(chars[k + 1]) ? '\\&' : ''}`;
    })
    .join('');
  return `"${shown}"`;
}

/** An `ipkg` version or bound: integers joined by `.`, each shown as a `Nat` (negative → 0). */
function showVersion(parts: readonly string[]): string {
  return parts.map((p) => (BigInt(p) < 0n ? '0' : BigInt(p).toString())).join('.');
}

interface Bound {
  readonly side: 'upper' | 'lower';
  readonly version: string;
  readonly inclusive: boolean;
}

/** The values of the fields `IpkgModel` has, as `addField` leaves them (the last one wins). */
interface FieldValues {
  version?: string;
  depends: IpkgDependency[];
  modules: string[];
  main?: string;
  executable?: string;
  sourcedir?: string;
  builddir?: string;
  outputdir?: string;
  opts?: string;
}

/** The grammar of `src/Idris/Package.idr` over the tokens of `lexIpkg`. */
class IpkgParser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  /** `parsePkgDesc` plus the `addField` bookkeeping for the fields `IpkgModel` has. */
  packageDescription(): IpkgModel {
    this.property('package');
    const name = this.packageName();
    const fields: FieldValues = { depends: [], modules: [] };
    for (;;) {
      const t = this.peek();
      const field = t.kind === 'ident' && !t.text.includes('.') ? FIELD_PARSERS.get(t.text) : undefined;
      if (field === undefined) {
        break;
      }
      this.pos++;
      // `mustWork`: once the property name matched, a failure is final.
      try {
        field(this, fields);
      } catch (error) {
        if (error instanceof ParseFailure && !error.fatal) {
          throw new ParseFailure(error.message, error.token, true);
        }
        throw error;
      }
    }
    const t = this.peek();
    if (t.kind === 'end') {
      const { version, main, executable, sourcedir, builddir, outputdir, opts } = fields;
      const optional = Object.entries({ version, main, executable, sourcedir, builddir, outputdir, opts }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      );
      return { name, depends: fields.depends, modules: fields.modules, ...Object.fromEntries(optional) };
    }
    if (t.kind === 'ident') {
      throw new ParseFailure(`Unrecognised property ${showIdentifier(t.text.split('.').pop() ?? '')}.`, t, true);
    }
    throw new ParseFailure('Expected end of file.', t, true);
  }

  peek(): Token {
    return this.tokens[this.pos];
  }

  fail(message: string): never {
    throw new ParseFailure(message, this.peek(), false);
  }

  /** A token of `kind`; its text. */
  terminal(kind: TokenKind, message: string): string {
    const t = this.peek();
    if (t.kind !== kind) {
      this.fail(message);
    }
    this.pos++;
    return t.text;
  }

  /** `exactProperty p`: an identifier without a namespace, equal to `p`. */
  property(p: string): void {
    const t = this.peek();
    if (t.kind !== 'ident' || t.text !== p) {
      this.fail(`Expected property ${p}.`);
    }
    this.pos++;
  }

  equals(): void {
    this.terminal('equals', 'Expected equals.');
  }

  string(): string {
    return this.terminal('string', 'Expected string.');
  }

  /** `packageName`: an identifier without a namespace that `isIdent AllowDashes` accepts. */
  packageName(): string {
    const t = this.peek();
    const chars = Array.from(t.text);
    const valid =
      t.kind === 'ident' &&
      !t.text.includes('.') &&
      isIdentStart('allowDashes', chars[0]) &&
      chars.slice(1).every((c) => isIdentTrailing('allowDashes', c));
    if (!valid) {
      this.fail('Expected package name.');
    }
    this.pos++;
    return t.text;
  }

  /** `moduleIdent`: any identifier; its dotted text is `show` of the module identifier. */
  moduleIdent(): string {
    return this.terminal('ident', 'Expected module identifier.');
  }

  /** `sepBy1 dot' integerLit`, shown as a version. */
  version(): string {
    return showVersion(this.sepBy1('dot', () => this.terminal('integer', 'Expected integer.')));
  }

  /** `p` if it succeeds, else `undefined` with the position restored (a non-fatal failure). */
  attempt<T>(p: () => T): T | undefined {
    const saved = this.pos;
    try {
      return p();
    } catch (error) {
      if (error instanceof ParseFailure && !error.fatal) {
        this.pos = saved;
        return undefined;
      }
      throw error;
    }
  }

  /** `sepBy1 sep p`: `p`, then `sep p` as often as that succeeds. */
  sepBy1<T>(separator: TokenKind, p: () => T): T[] {
    const items = [p()];
    for (;;) {
      const next = this.attempt(() => {
        this.terminal(separator, 'Expected separator.');
        return p();
      });
      if (next === undefined) {
        return items;
      }
      items.push(next);
    }
  }

  /** `langversions` and the bounds of `depends`: `sepBy andop bound`, then `mkBound`. */
  bounds(): IpkgVersionBounds {
    const bounds = this.attempt(() => this.sepBy1('andop', () => this.bound())) ?? [];
    // `anyBounds`: no bound, both inclusive.
    const result: { -readonly [K in keyof IpkgVersionBounds]: IpkgVersionBounds[K] } = {
      lower: undefined,
      lowerInclusive: true,
      upper: undefined,
      upperInclusive: true,
    };
    for (const b of bounds.flat()) {
      if (b.side === 'upper') {
        if (result.upper !== undefined) {
          this.fail('Dependency already has an upper bound.');
        }
        result.upper = b.version;
        result.upperInclusive = b.inclusive;
      } else {
        if (result.lower !== undefined) {
          this.fail('Dependency already has a lower bound.');
        }
        result.lower = b.version;
        result.lowerInclusive = b.inclusive;
      }
    }
    return result;
  }

  /** `bound`: `<=`, `>=`, `<`, `>` or `==` followed by a version. */
  private bound(): Bound[] {
    const t = this.peek();
    const operators: Partial<Record<TokenKind, readonly [Bound['side'] | 'both', boolean]>> = {
      lte: ['upper', true],
      gte: ['lower', true],
      lt: ['upper', false],
      gt: ['lower', false],
      eqop: ['both', true],
    };
    const operator = operators[t.kind];
    if (operator === undefined) {
      this.fail('Expected a version bound.');
    }
    this.pos++;
    const version = this.version();
    const [side, inclusive] = operator;
    return side === 'both'
      ? [
          { side: 'upper', version, inclusive },
          { side: 'lower', version, inclusive },
        ]
      : [{ side, version, inclusive }];
  }
}

/** A field's grammar after its property name (`field`), storing what `IpkgModel` needs. */
type FieldParser = (p: IpkgParser, fields: FieldValues) => void;

/** A field whose value is a string literal (`strField`); only the ones `IpkgModel` has are kept. */
function stringField(key?: 'sourcedir' | 'builddir' | 'outputdir' | 'opts'): FieldParser {
  return (p, fields) => {
    p.equals();
    const value = p.string();
    if (key !== undefined) {
      fields[key] = value;
    }
  };
}

/** The alternatives of `field`, by property name. */
const FIELD_PARSERS: ReadonlyMap<string, FieldParser> = new Map<string, FieldParser>([
  ...[
    'authors', 'maintainers', 'license', 'brief', 'readme', 'homepage', 'sourceloc', 'bugtracker',
    'prebuild', 'postbuild', 'preinstall', 'postinstall', 'preclean', 'postclean',
  ].map((name): [string, FieldParser] => [name, stringField()]),
  // `strField POpts "options"` and `strField POpts "opts"` (`src/Idris/Package.idr` 96–97): one field.
  ['options', stringField('opts')],
  ['opts', stringField('opts')],
  ['sourcedir', stringField('sourcedir')],
  ['builddir', stringField('builddir')],
  ['outputdir', stringField('outputdir')],
  [
    'version',
    (p, fields) => {
      p.equals();
      // `choose stringLit (sepBy1 dot' integerLit)`; a string is the deprecated form, which the
      // compiler warns about and does not store (`PVersionDep`).
      if (p.attempt(() => p.string()) === undefined) {
        fields.version = p.version();
      }
    },
  ],
  ['langversion', (p) => void p.bounds()],
  [
    'depends',
    (p, fields) => {
      p.equals();
      fields.depends = p.sepBy1('separator', () => ({ name: p.packageName(), bounds: p.bounds() }));
    },
  ],
  [
    'modules',
    (p, fields) => {
      p.equals();
      fields.modules = p.sepBy1('separator', () => p.moduleIdent());
    },
  ],
  [
    'main',
    (p, fields) => {
      p.equals();
      fields.main = p.moduleIdent();
    },
  ],
  [
    'executable',
    (p, fields) => {
      p.equals();
      fields.executable = p.attempt(() => p.string()) ?? p.packageName();
    },
  ],
]);
