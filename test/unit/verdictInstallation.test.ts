// toolchain/verdict.ts since M5: idris2-lsp is paired with the compiler of its own installation, the
// idris2 beside it (ServerCompiler, user decision of 2026-10-01), not with the idris2 the search
// found. The versions imitate the development machine: Homebrew 0.8.0 on PATH, pack's wrappers for
// collection nightly-261002 (Idris2 1c630e6) side by side in pack's bin directory.
import * as assert from 'assert';
import type {
  CompilerVersionInfo,
  Idris2Info,
  LspInfo,
  ServerCompiler,
  ToolLocation,
  ToolState,
} from '../../src/toolchain/types';
import { judgePair } from '../../src/toolchain/verdict';
import { parseToolVersion } from '../../src/toolchain/versions';

const PACK_BIN = '/Users/u/.local/share/pack/bin';

function at(kind: ToolLocation['kind'], path: string): ToolLocation {
  return { kind, path, source: 'setting', detail: 'setting', inPackDirectory: false };
}

function compiler(version: string, path: string): ToolState<CompilerVersionInfo> {
  return {
    status: 'probed',
    location: at('idris2', path),
    info: { versionLine: `Idris 2, version ${version}`, version: parseToolVersion(version), probes: [] },
  };
}

const HOMEBREW: ToolState<Idris2Info> = {
  status: 'probed',
  location: at('idris2', '/opt/homebrew/bin/idris2'),
  info: {
    versionLine: 'Idris 2, version 0.8.0',
    version: parseToolVersion('0.8.0'),
    ttcVersion: '2025081600',
    pathsText: undefined,
    packages: undefined,
    probes: [],
  },
};

function server(api: string): ToolState<LspInfo> {
  return {
    status: 'probed',
    location: at('idris2-lsp', `${PACK_BIN}/idris2-lsp`),
    info: {
      serverVersionLine: 'Idris2 LSP: 0.1.0-9a2f0ad6a',
      serverVersion: parseToolVersion('0.1.0-9a2f0ad6a'),
      apiVersionLine: `Idris2 API: ${api}`,
      apiVersion: parseToolVersion(api),
      probes: [],
    },
  };
}

function beside(state: ToolState<CompilerVersionInfo>): ServerCompiler {
  return { source: 'beside', sameAsIdris2: false, state };
}

suite('toolchain/verdict: the compiler of the server\'s installation (M5)', () => {
  const PACK_IDRIS2 = `${PACK_BIN}/idris2`;

  test('the pack pair is compatible although the idris2 on PATH is another version', () => {
    const verdict = judgePair(HOMEBREW, server('0.8.0-1c630e67c'), beside(compiler('0.8.0-1c630e67c', PACK_IDRIS2)));
    assert.strictEqual(verdict?.kind, 'compatible', verdict?.reason);
    assert.ok(verdict?.reason.includes(PACK_IDRIS2), verdict?.reason);
    // Without the compiler beside it (M1's pairing) the same server is a likely mismatch with Homebrew's.
    assert.strictEqual(judgePair(HOMEBREW, server('0.8.0-1c630e67c'))?.kind, 'likelyMismatch');
  });

  test('a server whose API differs from the compiler beside it is a likely mismatch, whatever idris2 the search found', () => {
    const verdict = judgePair(HOMEBREW, server('0.8.0'), beside(compiler('0.8.0-1c630e67c', PACK_IDRIS2)));
    assert.strictEqual(verdict?.kind, 'likelyMismatch');
    assert.ok(verdict?.reason.includes('Idris 2 API 0.8.0,') && verdict.reason.includes(`(${PACK_IDRIS2})`), verdict?.reason);
  });

  test('tags that abbreviate one commit to different lengths are one version beside the server too', () => {
    const verdict = judgePair(HOMEBREW, server('0.8.0-1c630e67c'), beside(compiler('0.8.0-1c630e6', PACK_IDRIS2)));
    assert.strictEqual(verdict?.kind, 'compatible');
    assert.ok(verdict?.reason.includes('1c630e6…'), verdict?.reason);
  });

  test('a compiler beside that did not answer, was not run, or printed no version makes the verdict unknown', () => {
    const failed: ToolState<CompilerVersionInfo> = {
      status: 'failed',
      location: at('idris2', PACK_IDRIS2),
      reason: 'idris2 --version exited with code 2: [ fatal ] Package `idris2` is not built',
      probes: [],
    };
    const located: ToolState<CompilerVersionInfo> = { status: 'located', location: at('idris2', PACK_IDRIS2) };
    const unparsed: ToolState<CompilerVersionInfo> = {
      status: 'probed',
      location: at('idris2', PACK_IDRIS2),
      info: { versionLine: 'Idris 2, version banana', version: undefined, probes: [] },
    };
    for (const [state, because] of [
      [failed, 'did not report its version'],
      [located, 'Restricted Mode'],
      [unparsed, 'does not recognise'],
    ] as const) {
      const verdict = judgePair(HOMEBREW, server('0.8.0-1c630e67c'), beside(state));
      assert.strictEqual(verdict?.kind, 'unknown');
      assert.ok(verdict?.reason.includes(because) && verdict.reason.includes(PACK_IDRIS2), verdict?.reason);
    }
  });

  test('a server that was not run, or printed no API version, is unknown with a compiler beside it', () => {
    const located: ToolState<LspInfo> = { status: 'located', location: at('idris2-lsp', `${PACK_BIN}/idris2-lsp`) };
    assert.strictEqual(judgePair(HOMEBREW, located, beside(compiler('0.8.0', PACK_IDRIS2)))?.kind, 'unknown');
    const odd = server('0.8.0');
    assert.ok(odd.status === 'probed');
    const noApi: ToolState<LspInfo> = { ...odd, info: { ...odd.info, apiVersionLine: 'Idris2 API: ?', apiVersion: undefined } };
    const verdict = judgePair(HOMEBREW, noApi, beside(compiler('0.8.0', PACK_IDRIS2)));
    assert.ok(verdict?.kind === 'unknown' && verdict.reason.includes('API version'), verdict?.reason);
  });

  test('source "search" (no idris2 beside the server) keeps M1\'s pairing with the idris2 found', () => {
    const lsp = server('0.8.0');
    const search: ServerCompiler = { source: 'search', state: HOMEBREW };
    assert.deepStrictEqual(judgePair(HOMEBREW, lsp, search), judgePair(HOMEBREW, lsp));
    assert.strictEqual(judgePair(HOMEBREW, lsp, search)?.kind, 'compatible');
  });

  test('no server, no verdict, whatever the compiler beside', () => {
    const missing: ToolState<LspInfo> = { status: 'missing', searched: [], reason: 'not found' };
    assert.strictEqual(judgePair(HOMEBREW, missing, beside(compiler('0.8.0', PACK_IDRIS2))), undefined);
  });
});
