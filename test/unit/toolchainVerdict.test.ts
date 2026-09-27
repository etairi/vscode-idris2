// toolchain/verdict.ts: the pair verdict of ROADMAP M1 / D20 as a table. Versions are written as
// the compiler and the server print them (versions.ts); locations name the search step, and a
// tool found by the step `pack` lies in pack's directories unless a row says otherwise.
import * as assert from 'assert';
import type {
  Idris2Info,
  LspInfo,
  ToolLocation,
  ToolSource,
  ToolState,
  VerdictKind,
} from '../../src/toolchain/types';
import { judgePair } from '../../src/toolchain/verdict';
import { parseToolVersion } from '../../src/toolchain/versions';

function location(kind: ToolLocation['kind'], source: ToolSource, packCollection?: string): ToolLocation {
  return {
    kind,
    path: `/somewhere/${source}/${kind}`,
    source,
    detail: `${source} directory`,
    inPackDirectory: source === 'pack',
    ...(packCollection === undefined ? {} : { packCollection }),
  };
}

/** `state` as the search reports it when pack's bin directory is on PATH: found by PATH, in pack's directory. */
function onPathInPackBin<Info>(state: ToolState<Info>): ToolState<Info> {
  assert.ok(state.status === 'probed');
  return { ...state, location: { ...state.location, source: 'PATH', detail: 'PATH entry /home/u/.local/bin', inPackDirectory: true } };
}

function idris2(version: string, source: ToolSource, packCollection?: string): ToolState<Idris2Info> {
  return {
    status: 'probed',
    location: location('idris2', source, packCollection),
    info: {
      versionLine: `Idris 2, version ${version}`,
      version: parseToolVersion(version),
      ttcVersion: '2025081600',
      pathsText: undefined,
      packages: undefined,
      probes: [],
    },
  };
}

function lsp(api: string, source: ToolSource, packCollection?: string): ToolState<LspInfo> {
  return {
    status: 'probed',
    location: location('idris2-lsp', source, packCollection),
    info: {
      serverVersionLine: 'Idris2 LSP: 0.1.0',
      serverVersion: parseToolVersion('0.1.0'),
      apiVersionLine: `Idris2 API: ${api}`,
      apiVersion: parseToolVersion(api),
      probes: [],
    },
  };
}

const MISSING = { status: 'missing', searched: ['/usr/bin'], reason: 'not found' } as const;
const located = (kind: ToolLocation['kind']) => ({ status: 'located', location: location(kind, 'PATH') }) as const;
const failed = (kind: ToolLocation['kind']) =>
  ({ status: 'failed', location: location(kind, 'PATH'), reason: 'x --version exited with code 1.', probes: [] }) as const;

interface Row {
  readonly name: string;
  readonly idris2: ToolState<Idris2Info>;
  readonly lsp: ToolState<LspInfo>;
  /** `undefined`: no verdict at all. */
  readonly kind: VerdictKind | undefined;
  /** A fragment the reason must contain. */
  readonly because?: string;
}

const HOMEBREW = idris2('0.8.0', 'PATH');
const PACK_DEV = '0.8.0-1c630e6a2';

const TABLE: readonly Row[] = [
  // No server: no pair to judge, whatever idris2 is.
  { name: 'no idris2-lsp, idris2 probed', idris2: HOMEBREW, lsp: MISSING, kind: undefined },
  { name: 'neither tool found', idris2: MISSING, lsp: MISSING, kind: undefined },
  // Missing parts.
  { name: 'idris2 missing', idris2: MISSING, lsp: lsp(PACK_DEV, 'pack'), kind: 'unknown', because: 'idris2 was not found' },
  { name: 'Restricted Mode (both located)', idris2: located('idris2'), lsp: located('idris2-lsp'), kind: 'unknown', because: 'Restricted Mode' },
  { name: 'idris2 probe failed', idris2: failed('idris2'), lsp: lsp('0.8.0', 'PATH'), kind: 'unknown', because: 'exited with code 1' },
  { name: 'server probe failed', idris2: HOMEBREW, lsp: failed('idris2-lsp'), kind: 'unknown', because: 'idris2-lsp did not report' },
  { name: 'idris2 version unrecognised', idris2: idris2('0.8', 'PATH'), lsp: lsp('0.8.0', 'PATH'), kind: 'unknown', because: 'Idris 2, version 0.8' },
  { name: 'API version unrecognised', idris2: HOMEBREW, lsp: lsp('dev', 'PATH'), kind: 'unknown', because: 'Idris2 API: dev' },
  // Equal texts: compatible, whatever the layout.
  { name: 'pack pair, same development version', idris2: idris2(PACK_DEV, 'pack'), lsp: lsp(PACK_DEV, 'pack'), kind: 'compatible' },
  { name: 'release compiler + release-built server off pack', idris2: HOMEBREW, lsp: lsp('0.8.0', 'PATH'), kind: 'compatible' },
  { name: 'pack server + equal non-pack idris2', idris2: idris2(PACK_DEV, 'PATH'), lsp: lsp(PACK_DEV, 'pack'), kind: 'compatible' },
  // One commit hash abbreviated to different lengths (Nix's 7-character shortRev, a longer git
  // abbreviation where 9 are ambiguous) or cases: the same commit, compatible.
  {
    name: 'a 7-character and a 9-character abbreviation of one commit',
    idris2: idris2('0.8.0-1c630e6', 'PATH'),
    lsp: lsp(PACK_DEV, 'PATH'),
    kind: 'compatible',
    because: 'tags that abbreviate the same commit hash (1c630e6…)',
  },
  { name: 'the longer one on the compiler side', idris2: idris2('0.8.0-1c630e6a2f', 'PATH'), lsp: lsp(PACK_DEV, 'pack'), kind: 'compatible' },
  { name: 'hexadecimal tags differing in case', idris2: idris2('0.8.0-1C630E6A2', 'PATH'), lsp: lsp(PACK_DEV, 'PATH'), kind: 'compatible' },
  // Not the same commit: too short, not hexadecimal, not a prefix, or another version number.
  { name: 'a 6-character prefix is not enough', idris2: idris2('0.8.0-1c630e', 'PATH'), lsp: lsp(PACK_DEV, 'PATH'), kind: 'likelyMismatch' },
  { name: 'non-hexadecimal tags are compared as text', idris2: idris2('0.9.0-devel', 'PATH'), lsp: lsp('0.9.0-dev', 'PATH'), kind: 'likelyMismatch' },
  { name: 'hexadecimal tags that are not prefixes', idris2: idris2('0.8.0-1c630e6b2', 'PATH'), lsp: lsp(PACK_DEV, 'PATH'), kind: 'likelyMismatch' },
  { name: 'prefix tags on different versions', idris2: idris2('0.7.0-1c630e6', 'PATH'), lsp: lsp(PACK_DEV, 'PATH'), kind: 'likelyMismatch' },
  // Different texts: likely mismatch, the layout picks the explanation.
  {
    name: 'pack server, Homebrew idris2 first on PATH',
    idris2: HOMEBREW,
    lsp: lsp(PACK_DEV, 'pack'),
    kind: 'likelyMismatch',
    because: "idris2-lsp was found in pack's directories",
  },
  {
    // pack's README has users put ~/.local/bin on PATH; the search then meets it as a PATH entry.
    name: "pack server found through PATH in pack's bin directory, Homebrew idris2 first on PATH",
    idris2: HOMEBREW,
    lsp: onPathInPackBin(lsp(PACK_DEV, 'pack')),
    kind: 'likelyMismatch',
    because: "idris2-lsp was found in pack's directories (PATH entry /home/u/.local/bin)",
  },
  {
    name: 'two pack collections',
    idris2: idris2('0.8.0-aaaaaaaaa', 'pack', 'nightly-260901'),
    lsp: lsp(PACK_DEV, 'pack', 'nightly-260924'),
    kind: 'likelyMismatch',
    because: 'found in different pack collections (nightly-260901 and nightly-260924)',
  },
  {
    name: 'release idris2 + server built outside pack',
    idris2: HOMEBREW,
    lsp: lsp(PACK_DEV, 'PATH'),
    kind: 'likelyMismatch',
    because: 'an untagged build (a release, or a build made outside a git checkout)',
  },
  {
    name: 'tag differs only',
    idris2: idris2('0.8.0-bbbbbbbbb', 'setting'),
    lsp: lsp(PACK_DEV, 'setting'),
    kind: 'likelyMismatch',
    because: `built against Idris 2 API ${PACK_DEV}, but idris2 is 0.8.0-bbbbbbbbb.`,
  },
  {
    name: 'dev idris2 + release-built server',
    idris2: idris2(PACK_DEV, 'PATH'),
    lsp: lsp('0.8.0', 'wellKnown'),
    kind: 'likelyMismatch',
    because: `built against Idris 2 API 0.8.0, but idris2 is ${PACK_DEV}.`,
  },
];

suite('toolchain/verdict', () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const verdict = judgePair(row.idris2, row.lsp);
      if (row.kind === undefined) {
        assert.strictEqual(verdict, undefined);
        return;
      }
      assert.strictEqual(verdict?.kind, row.kind, verdict?.reason);
      assert.ok(verdict.reason.length > 0);
      if (row.because !== undefined) {
        assert.ok(verdict.reason.includes(row.because), `"${verdict.reason}" should contain "${row.because}"`);
      }
    });
  }
});
