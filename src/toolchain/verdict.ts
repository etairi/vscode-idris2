/**
 * The pair verdict (`toolchain/verdict.ts`; ROADMAP M1 technical approach, D20): does the
 * `idris2-lsp` that was found fit the `idris2` that was found? A heuristic: the server links
 * the compiler as a library, and the only version it reports is that library's
 * (`Idris2 API: …`, `versions.ts`); the real coupling is the compiler commit and TTC format it
 * was built with (F21, F22), which no flag prints (U1.2).
 *
 * - No `idris2-lsp` found: no verdict (`undefined`), there is no pair.
 * - Both probed and both versions parsed: **compatible iff the API version text equals the
 *   compiler's version text** (tag included: `0.8.0` ≠ `0.8.0-1c630e6a2`) **or the two differ
 *   only in how far one commit hash is abbreviated** (below); otherwise `likelyMismatch`.
 *   Where the two were found only chooses the explanation of a mismatch, most specific first. "In pack's directories" is `ToolLocation.inPackDirectory`, decided by
 *   the executable's directory whichever step of the search found it (pack's README 29–31
 *   [doc] has users put `~/.local/bin` on `PATH`); it says where a tool was found, not who
 *   built it — `~/.local/bin` is not pack's alone:
 *   1. the server was found in pack's directories and `idris2` elsewhere — pack builds each
 *      collection's server against that collection's compiler (F22), so the pair to use is
 *      pack's `idris2` (`idris2.toolchain.preferPack` searches pack's directories first);
 *   2. both were found in the `bin` directories of different pack collections;
 *   3. `idris2` is an untagged build and the server was not found in pack's directories —
 *      idris2-lsp's main branch pins a development commit of the compiler (F21). Untagged is
 *      not the same as released: the tag is empty for a release and for any build made outside
 *      a git checkout (`Makefile` 19–27 [src], `versions.ts`), and master (`1c630e6`) still
 *      says 0.8.0, so a tarball or Nix build of a development commit also prints `0.8.0`;
 *   4. otherwise the two versions are named.
 *   Equal texts are `compatible` whatever the layout: a release compiler with a server built
 *   against the same release (e.g. from an idris2-lsp release branch) is a working pair. By the
 *   same token, two untagged builds of different commits (e.g. both from tarballs of master)
 *   compare equal and are `compatible`: the text cannot tell them apart.
 * - Anything else — `idris2` missing, a tool not run (Restricted Mode), a failed probe, a
 *   version that did not parse — is `unknown`, with the reason.
 *
 * Abbreviated hashes (a heuristic of its own). The same commit can be printed with tags of
 * different lengths: the Makefiles of Idris2 and idris2-lsp use `git rev-parse --short=9 HEAD`
 * (Idris2 `Makefile` 24 on master, idris2-lsp `Makefile` 17 [src]), which prints "a unique prefix
 * with at least" 9 characters, longer in a clone where 9 are ambiguous (git-rev-parse(1), git
 * 2.54 [doc]); and Idris2's `flake.nix` passes `srcRev = self.shortRev` (lines 56, 61 on master
 * [src]), 7 characters in Nix [not checked], to `nix/package.nix`, which is not in the checkout
 * read, so whether it becomes the version tag is [open]. So two tags of 7 to 40 hexadecimal
 * digits of which one is a prefix of the other (ignoring case) with equal `major.minor.patch`
 * count as the same commit. Distinct commits sharing a 7-character prefix exist in large
 * repositories; the heuristic accepts that risk, as the text comparison accepts two untagged
 * builds.
 */
import type { Idris2Info, LspInfo, ToolLocation, ToolState, ToolVersion, Verdict } from './types';

/** A hexadecimal commit abbreviation: 7 (Nix's `shortRev`) to 40 digits. */
const COMMIT_TAG = /^[0-9a-f]{7,40}$/;

/**
 * The shorter of the two tags when `a` and `b` have the same `major.minor.patch` and tags that
 * abbreviate one commit hash (see the module comment), else `undefined`.
 */
function sameCommitPrefix(a: ToolVersion, b: ToolVersion): string | undefined {
  if (a.major !== b.major || a.minor !== b.minor || a.patch !== b.patch || a.tag === undefined || b.tag === undefined) {
    return undefined;
  }
  const [x, y] = [a.tag.toLowerCase(), b.tag.toLowerCase()];
  if (!COMMIT_TAG.test(x) || !COMMIT_TAG.test(y)) {
    return undefined;
  }
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return longer.startsWith(shorter) ? shorter : undefined;
}

function mismatchReason(
  idris2: { readonly location: ToolLocation; readonly info: Idris2Info },
  lsp: { readonly location: ToolLocation; readonly info: LspInfo },
  compilerText: string,
  apiText: string,
): string {
  const versions = `idris2-lsp was built against Idris 2 API ${apiText}, but idris2 is ${compilerText}`;
  if (lsp.location.inPackDirectory && !idris2.location.inPackDirectory) {
    return `${versions}: idris2-lsp was found in pack's directories (${lsp.location.detail}) and idris2 elsewhere (${idris2.location.detail}), while pack builds its idris2-lsp against its own idris2.`;
  }
  const idris2Collection = idris2.location.packCollection;
  const lspCollection = lsp.location.packCollection;
  if (idris2Collection !== undefined && lspCollection !== undefined && idris2Collection !== lspCollection) {
    return `${versions}: they were found in different pack collections (${idris2Collection} and ${lspCollection}).`;
  }
  if (idris2.info.version?.tag === undefined && !lsp.location.inPackDirectory) {
    return `${versions}, an untagged build (a release, or a build made outside a git checkout), and this idris2-lsp was not found in pack's directories: idris2-lsp's main branch is built against a development version of the compiler.`;
  }
  return `${versions}.`;
}

function unusable(tool: 'idris2' | 'idris2-lsp', state: Exclude<ToolState<unknown>, { status: 'probed' }>): string {
  switch (state.status) {
    case 'missing':
      return `${tool} was not found.`;
    case 'located':
      return `${tool} was not run (Restricted Mode), so its version is unknown.`;
    case 'failed':
      return `${tool} did not report its version: ${state.reason}`;
  }
}

/** The verdict on the pair `idris2` + `idris2-lsp` (see the module comment). */
export function judgePair(idris2: ToolState<Idris2Info>, lsp: ToolState<LspInfo>): Verdict | undefined {
  if (lsp.status === 'missing') {
    return undefined;
  }
  if (idris2.status !== 'probed') {
    return { kind: 'unknown', reason: unusable('idris2', idris2) };
  }
  if (lsp.status !== 'probed') {
    return { kind: 'unknown', reason: unusable('idris2-lsp', lsp) };
  }
  const compiler = idris2.info.version;
  if (compiler === undefined) {
    return { kind: 'unknown', reason: `idris2 printed a version this extension does not recognise ("${idris2.info.versionLine}").` };
  }
  const api = lsp.info.apiVersion;
  if (api === undefined) {
    return {
      kind: 'unknown',
      reason: `idris2-lsp printed an API version this extension does not recognise ("${lsp.info.apiVersionLine}").`,
    };
  }
  if (api.text === compiler.text) {
    return { kind: 'compatible', reason: `idris2-lsp was built against Idris 2 API ${api.text}, the version idris2 reports.` };
  }
  const prefix = sameCommitPrefix(compiler, api);
  if (prefix !== undefined) {
    return {
      kind: 'compatible',
      reason: `idris2-lsp was built against Idris 2 API ${api.text} and idris2 is ${compiler.text}: the same version, with tags that abbreviate the same commit hash (${prefix}…) to different lengths.`,
    };
  }
  return { kind: 'likelyMismatch', reason: mismatchReason(idris2, lsp, compiler.text, api.text) };
}
