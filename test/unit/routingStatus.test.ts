// toolchain/status.ts, M5: the status item of a root served by idris2-lsp (the client's state, the
// server's API version) and of a root served by nothing because idris2-lsp needs an .ipkg.
import * as assert from 'assert';
import { NO_IPKG_REASON } from '../../src/backend/registry';
import { describeStatus, type StatusInput } from '../../src/toolchain/status';
import type { LspInfo, ToolState } from '../../src/toolchain/types';
import { LOOSE, LSP_PATH, lspProbed, missing, projectRoot, snapshot } from './support/toolchainFixtures';

function server(api: string): ToolState<LspInfo> {
  const probed = lspProbed(api);
  assert.ok(probed.status === 'probed');
  const [major, minor, rest] = api.split('.');
  const [patch, tag] = rest.split('-');
  return { ...probed, info: { ...probed.info, apiVersion: { major: Number(major), minor: Number(minor), patch: Number(patch), tag, text: api } } };
}

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    trusted: true,
    scanning: false,
    snapshot: snapshot({ lsp: server('0.8.0-1c630e67c') }),
    label: 'idris2-lsp',
    root: projectRoot(),
    ...overrides,
  };
}

suite('toolchain/status: idris2-lsp (M5)', () => {
  test('running: the server\'s API version and the label, with where its diagnostics are', () => {
    const view = describeStatus(input({ backend: { kind: 'active' } }));
    assert.strictEqual(view.text, 'Idris 2 0.8.0-1c630e67c · idris2-lsp');
    assert.strictEqual(view.severity, 'information');
    assert.ok(view.detail.startsWith(`idris2-lsp ${LSP_PATH}; project`), view.detail);
    assert.ok(view.detail.includes('Problems view'));
  });

  test('without a usable idris2 the item still describes the server, not "idris2 not found"', () => {
    const view = describeStatus(input({ snapshot: snapshot({ idris2: missing(), lsp: server('0.8.0') }), backend: { kind: 'active' } }));
    assert.strictEqual(view.text, 'Idris 2 0.8.0 · idris2-lsp');
  });

  test('stopped, failed and not allowed come from the client\'s state, not from a check', () => {
    assert.strictEqual(describeStatus(input({ backend: { kind: 'stopped' } })).text, 'Idris 2 0.8.0-1c630e67c · idris2-lsp · stopped');
    const failed = describeStatus(input({ backend: { kind: 'failed', reason: 'idris2-lsp was not found.' } }));
    assert.strictEqual(failed.text, 'Idris 2 0.8.0-1c630e67c · idris2-lsp · failed');
    assert.strictEqual(failed.severity, 'error');
    assert.ok(failed.detail.includes('idris2-lsp: idris2-lsp was not found.'));
    const refused = describeStatus(input({ backend: { kind: 'notAllowed', dir: '/outside/p', reason: 'denied' } }));
    assert.strictEqual(refused.text, 'Idris 2 0.8.0-1c630e67c · idris2-lsp · not allowed here');
    assert.strictEqual(refused.commandTitle, 'Allow…');
    assert.strictEqual(refused.allow, '/outside/p');
    assert.ok(refused.detail.startsWith('idris2-lsp may not load the files of'), 'the consent text comes before any path');
    // A check of the checks (which do not check such a root) is not shown.
    const withCheck = describeStatus(input({ backend: { kind: 'active' }, check: { kind: 'checked', errors: 2, warnings: 0, stale: false, known: true } as never }));
    assert.strictEqual(withCheck.text, 'Idris 2 0.8.0-1c630e67c · idris2-lsp');
  });

  test('no server found but routed to it: no version, and the failure from the state', () => {
    const view = describeStatus(input({ snapshot: snapshot({ lsp: missing('idris2-lsp was not found.') }), backend: { kind: 'failed', reason: 'idris2-lsp was not found.' } }));
    assert.strictEqual(view.text, 'Idris 2 · idris2-lsp · failed');
    assert.ok(view.detail.startsWith('idris2-lsp not found'));
  });

  test('a likely mismatch is named in the detail', () => {
    const view = describeStatus(input({ snapshot: snapshot({ lsp: server('0.7.0'), verdict: { kind: 'likelyMismatch', reason: 'API 0.7.0 is not 0.8.0.' } }) }));
    assert.ok(view.detail.includes('idris2-lsp: API 0.7.0 is not 0.8.0.'));
  });

  test('a file served by nothing says why: idris2-lsp needs an .ipkg', () => {
    const view = describeStatus(input({ label: 'syntax only', root: LOOSE, unserved: NO_IPKG_REASON }));
    assert.strictEqual(view.text, 'Idris 2 0.8.0 · syntax only');
    assert.ok(view.detail.includes(NO_IPKG_REASON), view.detail);
  });
});
