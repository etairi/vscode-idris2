// features/diagnostics/commands.ts and trace.ts against a fake of the VS Code API: Check File,
// Stop and Restart Backend (the active root or all, from a QuickPick or an argument), the crash
// and give-up notices with Show Output and Restart, the protocol trace channel, Show Protocol
// Trace and Send Raw Protocol Request.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { ConfigurationGroup, SettingsChange } from '../../src/core/config';
import { Emitter } from '../../src/core/event';
import type { CheckRefusal } from '../../src/features/diagnostics/checks';
import { registerBackendCommands, type BackendControl, type CommandsApi } from '../../src/features/diagnostics/commands';
import { ProtocolTraceChannel, registerTraceCommands, traceLine, type TraceApi } from '../../src/features/diagnostics/trace';
import type { Classification } from '../../src/project/types';
import type { ToolchainSnapshot } from '../../src/toolchain/types';
import { missing, snapshot } from './support/toolchainFixtures';

interface FakeDoc {
  uri: { scheme: string; fsPath: string; toString(): string };
  fileName: string;
  languageId: string;
  isUntitled: boolean;
}
const fileDoc = (fileName: string, languageId = 'idris2', scheme = 'file'): FakeDoc => ({
  uri: { scheme, fsPath: fileName, toString: () => `${scheme}://${fileName}` },
  fileName,
  languageId,
  isUntitled: scheme === 'untitled',
});

const quietLog = { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeApi() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const executed: unknown[][] = [];
  const messages: { level: string; text: string; actions: string[] }[] = [];
  const state = {
    active: undefined as FakeDoc | undefined,
    pick: undefined as ((items: { label: string; scope?: string }[]) => unknown) | undefined,
    answer: undefined as string | undefined,
    input: undefined as string | undefined,
    picked: [] as { label: string; description?: string }[][],
  };
  const channels: { name: string; lines: string[]; shown: number }[] = [];
  const message =
    (level: string) =>
    (text: string, ...actions: string[]): Promise<string | undefined> => {
      messages.push({ level, text, actions });
      return Promise.resolve(state.answer);
    };
  const api = {
    window: {
      get activeTextEditor() {
        return state.active && { document: state.active };
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showQuickPick: (items: { label: string; description?: string }[]) => {
        state.picked.push(items);
        return Promise.resolve(state.pick?.(items));
      },
      showInputBox: () => Promise.resolve(state.input),
      createOutputChannel: (name: string) => {
        const channel = { name, lines: [] as string[], shown: 0 };
        channels.push(channel);
        return { info: (line: string) => channel.lines.push(line), show: () => channel.shown++, dispose: () => undefined };
      },
    },
    commands: {
      registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
        commands.set(id, run);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: (...args: unknown[]) => {
        executed.push(args);
        return Promise.resolve();
      },
    },
  };
  return { api: api as unknown as CommandsApi & TraceApi, commands, executed, messages, state, channels };
}

class FakeControl implements BackendControl {
  readonly calls: string[] = [];
  roots: Classification[] = [];
  readonly failed = new Emitter<{ root: Classification; gaveUp: boolean; detail: string; repeated: boolean }>();
  readonly onDidFail = this.failed.event;
  activeRoots(): readonly Classification[] {
    return this.roots;
  }
  stop(root?: Classification): void {
    this.calls.push(`stop ${root?.dir ?? 'all'}`);
  }
  restart(root?: Classification): void {
    this.calls.push(`restart ${root?.dir ?? 'all'}`);
  }
}

function setupCommands(trusted = true) {
  const fake = fakeApi();
  const control = new FakeControl();
  const toolchain = { current: snapshot() as ToolchainSnapshot | undefined };
  const checked: string[] = [];
  const rechecked: (string | undefined)[] = [];
  const refusal: { next: CheckRefusal | undefined } = { next: undefined };
  const logged: string[] = [];
  const registration = registerBackendCommands(fake.api, {
    checks: {
      check: (doc: vscode.TextDocument) => {
        checked.push(doc.fileName);
        return Promise.resolve(refusal.next);
      },
      recheckVisible: (root?: Classification) => {
        rechecked.push(root?.dir);
        return Promise.resolve();
      },
      // Recorded with the control's calls, so that the tests see their order.
      cancelWaiting: (root?: Classification) => control.calls.push(`cancelWaiting ${root?.dir ?? 'all'}`),
    },
    control,
    projects: { classify: (file: string) => Promise.resolve({ kind: 'loose', dir: file.slice(0, file.lastIndexOf('/')) }) },
    toolchain,
    trust: { isTrusted: trusted, onDidGrant: new Emitter<void>().event },
    log: { ...quietLog, info: (m: string) => logged.push(m) },
  });
  const run = (id: string, ...args: unknown[]) => Promise.resolve(fake.commands.get(id)?.(...args));
  return { ...fake, control, checked, rechecked, refusal, registration, run, toolchain, logged };
}

suite('features/diagnostics/commands', () => {
  test('Check File checks the active Idris file; otherwise it says why', async () => {
    const t = setupCommands();
    await t.run('idris2.checkFile');
    t.state.active = fileDoc('/w/Notes.md', 'markdown');
    await t.run('idris2.checkFile');
    t.state.active = fileDoc('Untitled-1', 'idris2', 'untitled');
    await t.run('idris2.checkFile');
    t.state.active = fileDoc('/w/a/A.idr');
    await t.run('idris2.checkFile');
    assert.deepStrictEqual(t.checked, ['/w/a/A.idr']);
    assert.deepStrictEqual(
      t.messages.map((m) => m.text),
      ['Idris 2: open an Idris file to check it.', 'Idris 2: open an Idris file to check it.', 'Idris 2: save the file first; the compiler checks the file on disk.'],
    );
  });

  test('Check File in a folder the compiler may not start in says so, with Allow… for that folder (not a silent no-op)', async () => {
    const t = setupCommands();
    t.state.active = fileDoc('/o/A.idr');
    t.refusal.next = { message: 'Idris 2 is not started in /o: "Don\'t Allow" was chosen for this folder in this window.', dir: '/o' };
    t.state.answer = 'Allow…';
    await t.run('idris2.checkFile');
    await settle();
    assert.deepStrictEqual(t.messages.at(-1), {
      level: 'info',
      text: 'Idris 2 is not started in /o: "Don\'t Allow" was chosen for this folder in this window.',
      actions: ['Allow…'],
    });
    assert.deepStrictEqual(t.executed, [['idris2.allowFolder', '/o']]);
    // Nothing to allow (e.g. Restricted Mode began): the sentence alone; dismissed: nothing runs.
    t.refusal.next = { message: 'nothing runs in Restricted Mode', dir: undefined };
    await t.run('idris2.checkFile');
    await settle();
    assert.deepStrictEqual(t.messages.at(-1), { level: 'info', text: 'nothing runs in Restricted Mode', actions: [] });
    t.refusal.next = { message: 'x', dir: '/o' };
    t.state.answer = undefined;
    await t.run('idris2.checkFile');
    await settle();
    assert.strictEqual(t.executed.length, 1);
  });

  test('Check File and Restart Backend in Restricted Mode: nothing runs, one sentence says why', async () => {
    const t = setupCommands(false);
    t.state.active = fileDoc('/w/a/A.idr');
    await t.run('idris2.checkFile');
    await t.run('idris2.restartBackend', 'all');
    assert.deepStrictEqual(t.checked, []);
    assert.deepStrictEqual(t.control.calls, []);
    assert.strictEqual(t.messages.length, 2);
    assert.match(t.messages[0].text, /Restricted Mode/);
  });

  test('Stop Backend: the QuickPick offers this project and all projects; an argument skips it', async () => {
    const t = setupCommands();
    t.state.active = fileDoc('/w/a/A.idr');
    t.control.roots = [{ kind: 'loose', dir: '/w/a' }, { kind: 'loose', dir: '/w/b' }];
    t.state.pick = (items) => items.find((i) => i.label === 'This project');
    await t.run('idris2.stopBackend');
    assert.deepStrictEqual(
      t.state.picked[0].map((i) => [i.label, i.description]),
      [
        ['This project', '/w/a'],
        ['All projects', '2 running'],
      ],
    );
    t.state.pick = (items) => items.find((i) => i.label === 'All projects');
    await t.run('idris2.stopBackend');
    t.state.pick = () => undefined; // dismissed
    await t.run('idris2.stopBackend');
    await t.run('idris2.stopBackend', 'current');
    await t.run('idris2.stopBackend', 'all');
    t.state.active = undefined;
    await t.run('idris2.stopBackend', 'current'); // no active root: nothing, and a sentence says why
    // The checks still waiting for a background slot are dropped first (checks.ts `cancelWaiting`).
    assert.deepStrictEqual(t.control.calls, [
      'cancelWaiting /w/a',
      'stop /w/a',
      'cancelWaiting all',
      'stop all',
      'cancelWaiting /w/a',
      'stop /w/a',
      'cancelWaiting all',
      'stop all',
    ]);
    assert.match(t.messages.at(-1)?.text ?? '', /Stop Backend needs an active Idris file/);
  });

  test('without an active Idris file the QuickPick offers all projects only', async () => {
    const t = setupCommands();
    t.state.pick = (items) => items[0];
    await t.run('idris2.stopBackend');
    assert.deepStrictEqual(t.state.picked[0].map((i) => i.label), ['All projects']);
    assert.deepStrictEqual(t.control.calls, ['cancelWaiting all', 'stop all']);
  });

  test('Restart Backend restarts and checks the visible files of that root (or of all) again', async () => {
    const t = setupCommands();
    t.state.active = fileDoc('/w/a/A.idr');
    await t.run('idris2.restartBackend', 'current');
    await t.run('idris2.restartBackend', 'all');
    assert.deepStrictEqual(t.control.calls, ['restart /w/a', 'restart all']);
    assert.deepStrictEqual(t.rechecked, ['/w/a', undefined]);
  });

  test('a crash is a warning, a give-up an error, each with Show Output and Restart, recorded for the test API', async () => {
    const t = setupCommands();
    const root: Classification = { kind: 'loose', dir: '/w/a' };
    t.state.answer = 'Show Output';
    t.control.failed.fire({ root, gaveUp: false, detail: 'exit code 3', repeated: false });
    await settle();
    // A second crash before the session answered a request: logged, no second notice.
    t.control.failed.fire({ root, gaveUp: false, detail: 'exit code 3 again', repeated: true });
    await settle();
    t.state.answer = 'Restart';
    // The detail as the session words it (the reading confirmed by ROADMAP §9 Q22: the fourth unexpected end gives up).
    const gaveUp = 'exit code 3; 4 unexpected ends within 5 min, and the session restarts itself at most 3 times in that period';
    t.control.failed.fire({ root, gaveUp: true, detail: gaveUp, repeated: false });
    await settle();
    assert.deepStrictEqual(
      t.messages.map((m) => [m.level, m.text, m.actions]),
      [
        ['warning', 'Idris 2: the compiler for /w/a stopped unexpectedly (exit code 3); it is being restarted.', ['Show Output', 'Restart']],
        ['error', `Idris 2: the compiler for /w/a was given up: ${gaveUp}. Restart it to try again.`, ['Show Output', 'Restart']],
      ],
    );
    assert.deepStrictEqual(t.registration.notices.map((n) => n.kind), ['crashed', 'gaveUp']);
    assert.ok(t.logged.some((m) => m.includes('Not shown as a notice again') && m.includes('exit code 3 again')));
    assert.deepStrictEqual(t.executed, [['idris2.showOutput']]);
    assert.deepStrictEqual(t.control.calls, ['restart /w/a']);
    assert.deepStrictEqual(t.rechecked, ['/w/a']);
    // A detail quoting what the process sent (a protocol error's excerpt) is one line with its
    // invisible characters written out (fourth review of M3).
    t.state.answer = undefined;
    t.control.failed.fire({ root, gaveUp: false, detail: 'a frame that is not an s-expression: "(:ok \u202Eevil\nnext"', repeated: false });
    await settle();
    assert.strictEqual(t.messages.at(-1)?.text, 'Idris 2: the compiler for /w/a stopped unexpectedly (a frame that is not an s-expression: "(:ok \\u{202E}evil next"); it is being restarted.');
  });

  test('no notice while the toolchain has no working idris2 (its own notice reports that)', async () => {
    const t = setupCommands();
    t.toolchain.current = snapshot({ idris2: missing() });
    t.control.failed.fire({ root: { kind: 'loose', dir: '/w/a' }, gaveUp: true, detail: 'No Idris 2 compiler to start', repeated: false });
    await settle();
    assert.deepStrictEqual(t.messages, []);
    assert.deepStrictEqual(t.registration.notices, []);
  });

  test('disposing unregisters the three commands', () => {
    const t = setupCommands();
    assert.deepStrictEqual([...t.commands.keys()].sort(), ['idris2.checkFile', 'idris2.restartBackend', 'idris2.stopBackend']);
    t.registration.dispose();
    assert.strictEqual(t.commands.size, 0);
  });
});

suite('features/diagnostics/trace', () => {
  function setupTrace(on: boolean, acceptArgument = true) {
    const fake = fakeApi();
    const changed = new Emitter<void>();
    const settings = { protocol: on };
    const config = {
      trace: () => ({ ...settings }),
      onDidChange: (group: ConfigurationGroup, listener: (change: SettingsChange) => void) =>
        group === 'trace' ? changed.event(() => listener({ affects: (key) => key.startsWith('trace.') })) : { dispose: () => undefined },
    };
    const trace = new ProtocolTraceChannel(fake.api, config);
    const sent: [string, string][] = [];
    let reply: () => Promise<string> = () => Promise.resolve('id 1: ok');
    registerTraceCommands(fake.api, {
      acceptArgument,
      trace,
      raw: {
        sendRaw: (root, text) => {
          sent.push([root.dir, text]);
          return reply();
        },
      },
      projects: { classify: (file: string) => Promise.resolve({ kind: 'loose', dir: file.slice(0, file.lastIndexOf('/')) }) },
      log: quietLog,
    });
    const run = (id: string, ...args: unknown[]) => Promise.resolve(fake.commands.get(id)?.(...args));
    return {
      ...fake,
      trace,
      sent,
      run,
      turn: (value: boolean) => {
        settings.protocol = value;
        changed.fire();
      },
      reply: (f: () => Promise<string>) => (reply = f),
    };
  }

  test('entries are written only while idris2.trace.protocol is on; the channel is created on first use', () => {
    const t = setupTrace(false);
    t.trace.append({ session: 'check /w/a', direction: 'send', text: '000018(:version 1)\n' });
    assert.strictEqual(t.channels.length, 0);
    t.turn(true);
    assert.strictEqual(t.trace.enabled, true);
    t.trace.append({ session: 'check /w/a', direction: 'send', text: '00000c(:version 1)\n' });
    t.trace.append({ session: 'check /w/a', direction: 'receive', text: '(:return (:ok ((0 8 0) (""))) 1)\n' });
    assert.deepStrictEqual(t.channels.map((c) => [c.name, c.lines]), [
      ['Idris 2: Protocol Trace', ['send check /w/a: 00000c(:version 1)', 'receive check /w/a: (:return (:ok ((0 8 0) (""))) 1)']],
    ]);
    t.turn(false);
    t.trace.append({ session: 'check /w/a', direction: 'event', text: 'ready → stopped (stop)' });
    assert.strictEqual(t.channels[0].lines.length, 2);
    t.trace.dispose();
    assert.strictEqual(t.trace.enabled, false);
  });

  test('traceLine keeps a frame\'s inner line breaks and drops its final one', () => {
    assert.strictEqual(traceLine({ session: 's', direction: 'receive', text: '(:warning ("A.idr" "a\nb") 1)\n' }), 'receive s: (:warning ("A.idr" "a\nb") 1)');
  });

  test('Show Protocol Trace shows the channel; while the trace is off it says how to turn it on', async () => {
    const t = setupTrace(false);
    t.state.answer = 'Open Setting';
    await t.run('idris2.showProtocolTrace');
    assert.strictEqual(t.channels[0].shown, 1);
    assert.match(t.messages[0].text, /idris2\.trace\.protocol/);
    assert.deepStrictEqual(t.executed, [['workbench.action.openSettings', 'idris2.trace.protocol']]);
  });

  test('Send Raw Protocol Request: refused while the trace is off or without an Idris file; sent verbatim to the active root; the answer goes to the trace', async () => {
    const t = setupTrace(false);
    t.state.active = fileDoc('/w/a/A.idr');
    await t.run('idris2.sendRawRequest', ':version');
    assert.deepStrictEqual(t.sent, []);
    t.turn(true);
    t.state.active = fileDoc('/w/Notes.md', 'markdown');
    await t.run('idris2.sendRawRequest', ':version');
    assert.deepStrictEqual(t.sent, []);
    t.state.active = fileDoc('/w/a/A.idr');
    await t.run('idris2.sendRawRequest', ':version');
    t.state.input = '(:type-of "main")';
    await t.run('idris2.sendRawRequest');
    t.state.input = undefined; // the input box was dismissed
    await t.run('idris2.sendRawRequest');
    assert.deepStrictEqual(t.sent, [
      ['/w/a', ':version'],
      ['/w/a', '(:type-of "main")'],
    ]);
    assert.deepStrictEqual(t.channels[0].lines, ['event Send Raw Protocol Request: answered: id 1: ok', 'event Send Raw Protocol Request: answered: id 1: ok']);
    t.reply(() => Promise.reject(new Error('the session is not allowed')));
    await t.run('idris2.sendRawRequest', ':version');
    assert.strictEqual(t.channels[0].lines.at(-1), 'event Send Raw Protocol Request: failed: the session is not allowed');
    assert.match(t.messages.at(-1)?.text ?? '', /the raw request failed: the session is not allowed/);
  });

  test('Send Raw Protocol Request outside the test runner ignores a text passed as the argument: the user types it', async () => {
    // A raw (:interpret ":sh …") runs a shell command, so no command link or other extension may send one unseen.
    const t = setupTrace(true, false);
    t.state.active = fileDoc('/w/a/A.idr');
    t.state.input = undefined;
    await t.run('idris2.sendRawRequest', '(:interpret ":sh \\"touch X\\"")');
    assert.deepStrictEqual(t.sent, [], 'the input box was shown and dismissed: nothing sent');
    t.state.input = ':version';
    await t.run('idris2.sendRawRequest', '(:interpret ":sh \\"touch X\\"")');
    assert.deepStrictEqual(t.sent, [['/w/a', ':version']]);
  });
});
