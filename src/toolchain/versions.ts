/**
 * Parsers for what the toolchain probes print (`toolchain/versions.ts`, ROADMAP M1). The
 * formats, read in the Idris2 v0.8.0 sources (line numbers below; the code is the same on
 * master `1c630e6`) and idris2-lsp `9a2f0ad`, and checked against Homebrew `idris2` 0.8.0 on
 * 2026-09-27 for the four compiler flags (the recorded outputs are the fixtures of
 * `test/unit/toolchainVersions.test.ts`):
 *
 * - `idris2 --version`: `Idris 2, version <v>` (`versionMsg`, `src/Idris/CommandLine.idr`
 *   434–435), where `<v>` is `show version` = `showVersion True`: `<major>.<minor>.<patch>` and,
 *   when the build has a non-empty `VERSION_TAG`, `-<tag>` (`src/Libraries/Data/Version.idr`
 *   25–38; `src/Idris/Version.idr`). The tag is whatever the build put into `IdrisPaths.idr`
 *   (`Makefile` 79–83): by default `git rev-parse --short=9 HEAD` for a build inside a git
 *   checkout whose commit has no tag, else empty (`Makefile` 19–27) [src]. So the tag is free
 *   text, not necessarily a commit.
 * - `idris2 --ttc-version`: one integer and a newline (`printLn ttcVersion`,
 *   `src/Idris/Driver.idr` 255–256) [src].
 * - `idris2 --paths`: one line per directory setting, `+ <label padded> :: <show value>`
 *   (`toString`, `src/Core/Options.idr` 41–54) [src].
 * - `idris2 --list-packages`: `Idris2 TTC Version: <n>`, a rule of five `─`, then per package
 *   `<name> (<version> | unversioned)`, `  ├ TTC Versions: <n>[ (incompatible)], …` and
 *   `  └ <directory>` (`listPackages`, `src/Idris/SetOptions.idr` 214–253) [src]. The `└` line is
 *   the search directory the package was found **in** (`MkQualifiedPkgDir path _`), not the
 *   package's own directory: every package of the Homebrew build prints
 *   `…/libexec/idris2-0.8.0` [live]. Colour codes are never printed here: the compiler turns
 *   colour off when stdout is not a terminal (`src/Idris/Driver.idr` 56–57) [src].
 * - `idris2-lsp --version` (exactly that argument): `Idris2 LSP: <v>` and `Idris2 API: <v>`, both
 *   `show` of a `Version` as above (`printVersion`, idris2-lsp `src/Server/Main.idr` 206–209);
 *   any other argument list prints `Invalid Arguments` and still exits 0 (212–218) [src].
 *
 * Line breaks may be `\n` or `\r\n`. The `--version` parsers look for their line among any
 * others (a wrapper script may print before it); `--ttc-version` and `--list-packages` must
 * consist of their expected lines only, since nothing marks their content otherwise.
 */
import type { InstalledPackage, ToolVersion } from './types';

/** What `idris2 --version` prints before the version. */
export const IDRIS2_VERSION_PREFIX = 'Idris 2, version ';
const LSP_SERVER_PREFIX = 'Idris2 LSP: ';
const LSP_API_PREFIX = 'Idris2 API: ';

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** `<major>.<minor>.<patch>` with an optional `-<tag>`, as `showVersion True` renders it. */
export function parseToolVersion(text: string): ToolVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }
  return { major, minor, patch, ...(match[4] === undefined ? {} : { tag: match[4] }), text };
}

/** The line of `output` that starts with `prefix` (after leading blanks), trimmed. */
function prefixedLine(output: string, prefix: string): string | undefined {
  return lines(output)
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix));
}

/**
 * `idris2 --version`: the `Idris 2, version …` line and the version after the prefix
 * (`undefined` when that text is not a version); `undefined` when there is no such line.
 */
export function parseIdris2Version(
  stdout: string,
): { readonly versionLine: string; readonly version: ToolVersion | undefined } | undefined {
  const versionLine = prefixedLine(stdout, IDRIS2_VERSION_PREFIX);
  if (versionLine === undefined) {
    return undefined;
  }
  return { versionLine, version: parseToolVersion(versionLine.slice(IDRIS2_VERSION_PREFIX.length).trim()) };
}

/** `idris2 --ttc-version`: the digits, when the output is exactly one integer. */
export function parseTtcVersion(stdout: string): string | undefined {
  const text = stdout.trim();
  return /^\d+$/.test(text) ? text : undefined;
}

/** One line of `idris2 --paths`: the label without its padding, and the value as printed. */
export interface PathsEntry {
  readonly label: string;
  readonly value: string;
}

/** The labelled lines of `idris2 --paths` (other lines are skipped); `undefined` when there are none. */
export function parsePaths(stdout: string): PathsEntry[] | undefined {
  const entries: PathsEntry[] = [];
  for (const line of lines(stdout)) {
    const match = /^\+ (.*?)\s+:: (.*)$/.exec(line);
    if (match !== null) {
      entries.push({ label: match[1], value: match[2] });
    }
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * `idris2 --list-packages`: the packages in the order printed (the compiler sorts them by
 * name); `undefined` unless the whole output has the shape described in the module comment.
 */
export function parseListPackages(stdout: string): InstalledPackage[] | undefined {
  const all = lines(stdout);
  while (all.length > 0 && all[all.length - 1] === '') {
    all.pop();
  }
  if (all.length < 2 || !/^Idris2 TTC Version: \d+$/.test(all[0]) || !/^─+$/.test(all[1])) {
    return undefined;
  }
  const packages: InstalledPackage[] = [];
  for (let i = 2; i < all.length; i += 3) {
    const header = /^(.*\S) \((unversioned|\d+(?:\.\d+)*)\)$/.exec(all[i]);
    const ttc = /^ {2}├ TTC Versions:(.*)$/.exec(all[i + 1] ?? '');
    const dir = /^ {2}└ (.+)$/.exec(all[i + 2] ?? '');
    if (header === null || ttc === null || dir === null) {
      return undefined;
    }
    const ttcVersions: string[] = [];
    const listed = ttc[1].trim();
    for (const item of listed === '' ? [] : listed.split(',')) {
      const version = /^(\d+)(?: \(incompatible\))?$/.exec(item.trim());
      if (version === null) {
        return undefined;
      }
      ttcVersions.push(version[1]);
    }
    packages.push({
      name: header[1],
      version: header[2] === 'unversioned' ? undefined : header[2],
      ttcVersions,
      path: dir[1],
    });
  }
  return packages;
}

/** `idris2-lsp --version`: both lines and the versions in them; `undefined` unless both lines are there. */
export function parseLspVersion(stdout: string):
  | {
      readonly serverVersionLine: string;
      readonly serverVersion: ToolVersion | undefined;
      readonly apiVersionLine: string;
      readonly apiVersion: ToolVersion | undefined;
    }
  | undefined {
  const serverVersionLine = prefixedLine(stdout, LSP_SERVER_PREFIX);
  const apiVersionLine = prefixedLine(stdout, LSP_API_PREFIX);
  if (serverVersionLine === undefined || apiVersionLine === undefined) {
    return undefined;
  }
  return {
    serverVersionLine,
    serverVersion: parseToolVersion(serverVersionLine.slice(LSP_SERVER_PREFIX.length).trim()),
    apiVersionLine,
    apiVersion: parseToolVersion(apiVersionLine.slice(LSP_API_PREFIX.length).trim()),
  };
}
