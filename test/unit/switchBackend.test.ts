// features/backend/switchBackend.ts: what Idris 2: Switch Backend… offers for a root (ROADMAP M5;
// the user's decision of 2026-10-01).
import * as assert from 'assert';
import { NO_IPKG_REASON } from '../../src/backend/registry';
import { switchOptions } from '../../src/features/backend/switchBackend';
import { LOOSE, LSP_PATH, idris2Probed, lspProbed, missing, projectRoot, snapshot } from './support/toolchainFixtures';

const PROJECT = projectRoot();
const BOTH = snapshot({ lsp: lspProbed('0.8.0') });

suite('features/backend/switchBackend', () => {
  test('a project with both tools: both backends, the serving one marked; nothing to forget without a choice', () => {
    const { options, notOffered, anyChange } = switchOptions(PROJECT, { kind: 'ideMode' }, undefined, 'auto', BOTH);
    assert.deepStrictEqual(
      options.map((o) => [o.label, o.choice]),
      [
        ['IDE mode', 'ideMode'],
        ['idris2-lsp', 'lsp'],
      ],
    );
    assert.ok(options[0].description.startsWith('serves this project now; idris2 0.8.0 at /opt/homebrew/bin/idris2'), options[0].description);
    assert.ok(options[1].description.startsWith(`Idris 2 API Idris2 API: 0.8.0 at ${LSP_PATH}`), options[1].description);
    assert.deepStrictEqual(notOffered, []);
    assert.strictEqual(anyChange, true);
  });

  test('a remembered choice adds Follow the Setting, naming the setting\'s value', () => {
    const { options } = switchOptions(PROJECT, { kind: 'lsp' }, 'lsp', 'ideMode', BOTH);
    assert.deepStrictEqual(options.map((o) => o.choice), ['ideMode', 'lsp', undefined]);
    assert.strictEqual(options[2].label, 'Follow the Setting');
    assert.match(options[2].description, /idris2\.backend\.mode is "ideMode"/);
    assert.ok(options[1].description.startsWith('serves this project now'));
  });

  test('a loose file: idris2-lsp is not offered, with why; IDE mode is', () => {
    const { options, notOffered, anyChange } = switchOptions(LOOSE, { kind: 'none', why: 'noIpkg' }, undefined, 'lsp', BOTH);
    assert.deepStrictEqual(options.map((o) => o.choice), ['ideMode']);
    assert.deepStrictEqual(notOffered, [`idris2-lsp is not offered: ${NO_IPKG_REASON}`]);
    assert.strictEqual(anyChange, true, 'IDE mode would serve a file served by nothing');
  });

  test('only the serving backend usable and no choice: nothing to change, and why the other is missing', () => {
    const { options, notOffered, anyChange } = switchOptions(PROJECT, { kind: 'ideMode' }, undefined, 'auto', snapshot({ lsp: missing('idris2-lsp was not found.') }));
    assert.deepStrictEqual(options.map((o) => o.choice), ['ideMode']);
    assert.strictEqual(anyChange, false);
    assert.deepStrictEqual(notOffered, ['idris2-lsp needs a server, which is not usable: idris2-lsp was not found.']);
    const noCompiler = switchOptions(PROJECT, { kind: 'lsp' }, undefined, 'auto', snapshot({ idris2: missing('idris2 was not found.'), lsp: lspProbed('0.8.0') }));
    assert.deepStrictEqual(noCompiler.options.map((o) => o.choice), ['lsp']);
    assert.strictEqual(noCompiler.anyChange, false);
    assert.deepStrictEqual(noCompiler.notOffered, ['IDE mode needs idris2, which is not usable: idris2 was not found.']);
  });

  test('a likely mismatch is offered with the verdict\'s warning (an explicit choice only needs the server to answer)', () => {
    const s = snapshot({ idris2: idris2Probed(), lsp: lspProbed('0.7.0'), verdict: { kind: 'likelyMismatch', reason: 'API 0.7.0 is not 0.8.0.' } });
    const lsp = switchOptions(PROJECT, { kind: 'ideMode' }, undefined, 'auto', s).options.find((o) => o.choice === 'lsp');
    assert.ok(lsp?.description.endsWith(' — likely mismatch: API 0.7.0 is not 0.8.0.'), lsp?.description);
  });

  test('before the first scan nothing is offered', () => {
    const { options, notOffered, anyChange } = switchOptions(PROJECT, { kind: 'ideMode' }, undefined, 'auto', undefined);
    assert.deepStrictEqual(options, []);
    assert.strictEqual(anyChange, false);
    assert.strictEqual(notOffered.length, 2);
  });
});
