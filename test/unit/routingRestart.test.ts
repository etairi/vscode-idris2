// features/backend/restart.ts: which setting change prompts a restart of idris2-lsp (ROADMAP M5).
import * as assert from 'assert';
import { restartReason } from '../../src/features/backend/restart';

suite('features/backend/restart: restartReason', () => {
  test('idris2.lsp.logFile: only clearing it needs a restart (the server cannot go back to its standard error)', () => {
    assert.match(restartReason('/tmp/a.log', '') ?? '', /earlier idris2\.lsp\.logFile until it starts again/);
    assert.strictEqual(restartReason('/tmp/a.log', '/tmp/b.log'), undefined, 'a new path is forwarded');
    assert.strictEqual(restartReason('', '/tmp/b.log'), undefined);
    assert.strictEqual(restartReason('', ''), undefined);
  });
});
