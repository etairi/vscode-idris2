import * as assert from 'assert';
import { NoticeGate, noticesFor, registerToolchainNotifications, type NotificationApi } from '../../src/toolchain/notifications';
import { FakeToolchain, SETTINGS, lspProbed, missing, snapshot } from './support/toolchainFixtures';

const MISMATCH = { kind: 'likelyMismatch' as const, reason: 'The server reports Idris2 API 0.7.0; the compiler is 0.8.0.' };

suite('toolchain/notifications', () => {
  suite('noticesFor', () => {
    test('a missing compiler: one warning with Install Idris 2…, Set Path and Show Output, in that order', () => {
      const notices = noticesFor(snapshot({ idris2: missing('Not on PATH.') }));
      assert.strictEqual(notices.length, 1);
      assert.strictEqual(notices[0].kind, 'idris2Missing');
      assert.strictEqual(notices[0].message, 'Idris 2: the compiler (idris2) was not found. Not on PATH.');
      assert.deepStrictEqual(notices[0].actions, [
        { label: 'Install Idris 2…', command: 'idris2.installIdris2', args: [] },
        { label: 'Set Path', command: 'workbench.action.openSettings', args: ['idris2.toolchain.idris2Path'] },
        { label: 'Show Output', command: 'idris2.showOutput', args: [] },
      ]);
    });

    test('a found compiler, and every verdict but likelyMismatch, need no notice', () => {
      assert.deepStrictEqual(noticesFor(snapshot()), []);
      for (const kind of ['compatible', 'unknown'] as const) {
        assert.deepStrictEqual(noticesFor(snapshot({ lsp: lspProbed('0.8.0'), verdict: { kind, reason: 'r' } })), []);
      }
    });

    test('a likely mismatch: one warning with the verdict\'s reason', () => {
      const notices = noticesFor(snapshot({ lsp: lspProbed('0.7.0'), verdict: MISMATCH }));
      assert.deepStrictEqual(
        notices.map((n) => [n.kind, n.message, n.actions.map((a) => a.label)]),
        [['pairMismatch', `Idris 2: idris2-lsp and idris2 likely do not match. ${MISMATCH.reason}`, ['Show Setup Information', 'Open Settings']]],
      );
    });

    test('nothing in Restricted Mode: workspace path settings are ignored there, so "missing" may be wrong', () => {
      assert.deepStrictEqual(noticesFor(snapshot({ trusted: false, idris2: missing() })), []);
    });

    test('the missing-compiler condition is the configured path: same path, same key; another path, another key', () => {
      const key = (idris2Path: string, reason: string) =>
        noticesFor(snapshot({ settings: { ...SETTINGS, idris2Path }, idris2: missing(reason) }))[0].key;
      assert.strictEqual(key('', 'a'), key('', 'b'));
      assert.notStrictEqual(key('', 'a'), key('/x/idris2', 'a'));
    });
  });

  test('NoticeGate admits each key once', () => {
    const gate = new NoticeGate();
    const [notice] = noticesFor(snapshot({ idris2: missing() }));
    assert.strictEqual(gate.admit(notice), true);
    assert.strictEqual(gate.admit(notice), false);
    assert.strictEqual(gate.admit({ ...notice, key: 'other' }), true);
  });

  suite('registerToolchainNotifications (against a fake VS Code API)', () => {
    function setup(click: (actions: string[]) => string | undefined = () => undefined) {
      const warnings: { message: string; actions: string[] }[] = [];
      const executed: unknown[][] = [];
      const api = {
        window: {
          showWarningMessage: (message: string, ...actions: string[]) => {
            warnings.push({ message, actions });
            return Promise.resolve(click(actions));
          },
        },
        commands: {
          executeCommand: (...args: unknown[]) => Promise.resolve(void executed.push(args)),
        },
      } as unknown as NotificationApi;
      const toolchain = new FakeToolchain();
      const logged: string[] = [];
      const log = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: (m: string) => void logged.push(m), error: () => undefined };
      const notifications = registerToolchainNotifications(api, toolchain, log);
      return { warnings, executed, toolchain, notifications, logged };
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    test('shown once per window: not again for a rescan with the same result, nor for scanning flips', () => {
      const t = setup();
      t.toolchain.publish({ idris2: missing() });
      t.toolchain.setScanning(true);
      t.toolchain.publish({ idris2: missing(), reason: 'command' });
      t.toolchain.publish({ idris2: missing(), reason: 'settingsChanged' });
      assert.strictEqual(t.warnings.length, 1);
      assert.deepStrictEqual(t.warnings[0].actions, ['Install Idris 2…', 'Set Path', 'Show Output']);
      assert.deepStrictEqual(t.notifications.shown.map((n) => n.kind), ['idris2Missing']);
      assert.deepStrictEqual(t.logged, [t.warnings[0].message]);
    });

    test('a found compiler in between does not re-arm it; a new configured path does', () => {
      const t = setup();
      t.toolchain.publish({ idris2: missing() });
      t.toolchain.publish({});
      t.toolchain.publish({ idris2: missing() });
      assert.strictEqual(t.warnings.length, 1);
      t.toolchain.publish({ idris2: missing(), settings: { ...SETTINGS, idris2Path: '/x/idris2' } });
      assert.strictEqual(t.warnings.length, 2);
    });

    test('the mismatch warning is shown once for the same pair', () => {
      const t = setup();
      t.toolchain.publish({ lsp: lspProbed('0.7.0'), verdict: MISMATCH });
      t.toolchain.publish({ lsp: lspProbed('0.7.0'), verdict: MISMATCH });
      assert.deepStrictEqual(t.notifications.shown.map((n) => n.kind), ['pairMismatch']);
    });

    test('a clicked action runs its command with its arguments', async () => {
      const t = setup((actions) => actions[1]);
      t.toolchain.publish({ idris2: missing() });
      await settle();
      assert.deepStrictEqual(t.executed, [['workbench.action.openSettings', 'idris2.toolchain.idris2Path']]);
    });

    test('a click that arrives after dispose runs nothing', async () => {
      const t = setup((actions) => actions[0]);
      t.toolchain.publish({ idris2: missing() });
      t.notifications.dispose();
      await settle();
      assert.deepStrictEqual(t.executed, []);
    });
  });
});
