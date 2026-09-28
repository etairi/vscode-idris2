// features/consent/register.ts against a fake of the VS Code API: the question's three buttons,
// the folders allowed for good in the global state, the status item's Allow… and Manage Allowed
// Folders… (QuickPick, or an argument).
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { Emitter } from '../../src/core/event';
import { ALLOWED_FOLDERS_KEY, consentQuestion, FOLDER_DECISIONS_KEY, registerConsent, type ConsentApi } from '../../src/features/consent/register';

function setup(stored: unknown = undefined, failWrites = false) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const shown: { text: string; buttons: string[] }[] = [];
  const warned: string[] = [];
  const state = {
    button: undefined as string | undefined,
    pick: undefined as ((items: { label: string }[]) => { label: string }[] | undefined) | undefined,
    picked: [] as { label: string }[][],
    info: [] as string[],
  };
  const memento = new Map<string, unknown>([[ALLOWED_FOLDERS_KEY, stored]]);
  const api = {
    window: {
      showWarningMessage: (text: string, ...buttons: string[]) => {
        if (buttons.length === 0) {
          warned.push(text);
          return Promise.resolve(undefined);
        }
        shown.push({ text, buttons });
        return Promise.resolve(state.button);
      },
      showInformationMessage: (text: string) => {
        state.info.push(text);
        return Promise.resolve(undefined);
      },
      showQuickPick: (items: { label: string }[]) => {
        state.picked.push(items);
        return Promise.resolve(state.pick?.(items));
      },
    },
    commands: {
      registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
        commands.set(id, run);
        return { dispose: () => commands.delete(id) };
      },
    },
  } as unknown as ConsentApi;
  const consent = registerConsent(api, {
    trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
    folders: () => ['/w/proj'],
    onDidChangeFolders: new Emitter<void>().event,
    realpath: (p) => Promise.resolve(p),
    platform: 'linux',
    globalState: {
      get: (key: string) => memento.get(key),
      update: (key: string, value: unknown) => {
        if (failWrites) {
          return Promise.reject(new Error('[x](command:y) the storage is closed'));
        }
        memento.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...memento.keys()],
    } as unknown as vscode.Memento,
    log: { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const run = (id: string, ...args: unknown[]) => Promise.resolve(commands.get(id)?.(...args));
  return { consent, commands, shown, warned, state, memento, run };
}

suite('features/consent/register', () => {
  test('the question names the folder and the risk, with the three buttons; each button is its answer', async () => {
    const t = setup();
    for (const [button, verdict] of [
      ['Allow', { allowed: true, basis: 'window' }],
      ['Always Allow for This Folder', { allowed: true, basis: 'always' }],
      ["Don't Allow", { allowed: false, reason: 'denied' }],
      [undefined, { allowed: false, reason: 'unanswered' }],
    ] as const) {
      t.state.button = button;
      const dir = `/outside/${button ?? 'closed'}`;
      assert.deepStrictEqual(await t.consent.gate.permit(dir), verdict);
      assert.deepStrictEqual(t.shown.at(-1), { text: consentQuestion(dir, undefined), buttons: ['Allow', 'Always Allow for This Folder', "Don't Allow"] });
    }
    assert.match(consentQuestion('/x/y', undefined), /^Idris 2: start the compiler in a folder outside the trusted workspace folders\? .*can run code placed in it.* It would start in: “\/x\/y”$/);
    assert.deepStrictEqual(t.memento.get(ALLOWED_FOLDERS_KEY), ['/outside/Always Allow for This Folder']);
    // Beside the list, when the folder was decided (gate.ts, *Decisions in several windows*).
    const decided = t.memento.get(FOLDER_DECISIONS_KEY) as Record<string, number>;
    assert.deepStrictEqual(Object.keys(decided), ['/outside/Always Allow for This Folder']);
    assert.ok(Number.isFinite(decided['/outside/Always Allow for This Folder']));
  });

  test('the question says why the compiler would start there: the package file that chose the folder, or the loose file', async () => {
    const t = setup();
    t.state.button = 'Allow';
    await t.consent.gate.permit('/tmp', { ipkg: '/tmp/x.ipkg' });
    assert.strictEqual(
      t.shown.at(-1)?.text,
      'Idris 2: start the compiler in a folder outside the trusted workspace folders? Starting the compiler in a folder can run ' +
        'code placed in it; until you allow it, Idris files there get highlighting only. It would start in the folder of the ' +
        'package file “x.ipkg”, the first .ipkg found in the folder of the file you opened or above it: “/tmp”',
    );
    await t.consent.gate.permit('/dl', { ipkg: undefined });
    assert.match(t.shown.at(-1)?.text ?? '', / It would start in the folder of the Idris file you opened, which belongs to no package: “\/dl”$/);
  });

  test('stored folders are read from the global state; a value of another shape counts as none', async () => {
    assert.deepStrictEqual(setup(['/a', 3, '/b']).consent.gate.allowedFolders(), ['/a', '/b']);
    assert.deepStrictEqual(setup({ '/a': true }).consent.gate.allowedFolders(), []);
    // Times of another shape are ignored as well (a folder with no time counts as decided before times were kept).
    const odd = setup(['/a']);
    odd.memento.set(FOLDER_DECISIONS_KEY, { '/a': 'yesterday', '/b': 5 });
    assert.deepStrictEqual(odd.consent.gate.allowedFolders(), ['/a']);
    odd.memento.set(FOLDER_DECISIONS_KEY, ['/a']);
    assert.deepStrictEqual(odd.consent.gate.allowedFolders(), ['/a']);
    assert.deepStrictEqual(await setup(['/a']).consent.gate.permit('/a'), { allowed: true, basis: 'always' });
  });

  test("the status item's Allow… asks again about its directory, naming the package file as the first question did", async () => {
    const t = setup();
    t.state.button = "Don't Allow";
    await t.consent.gate.permit('/outside/p', { ipkg: '/outside/p/p.ipkg' });
    t.state.button = 'Allow';
    await t.run('idris2.allowFolder', '/outside/p');
    assert.strictEqual(t.shown.length, 2);
    assert.strictEqual(t.shown[1].text, consentQuestion('/outside/p', { ipkg: '/outside/p/p.ipkg' }));
    assert.deepStrictEqual(t.consent.gate.current('/outside/p'), { allowed: true, basis: 'window' });
    await t.run('idris2.allowFolder', 42); // not a directory: ignored
    assert.strictEqual(t.shown.length, 2);
  });

  test('Manage Allowed Folders…: says when there is none, revokes the folders picked, or those given as an argument', async () => {
    const t = setup(['/a', '/b', '/c']);
    t.state.pick = (items) => items.filter((i) => i.label === '/b');
    await t.run('idris2.manageAllowedFolders');
    assert.deepStrictEqual(t.state.picked[0].map((i) => i.label), ['/a', '/b', '/c']);
    assert.deepStrictEqual(t.memento.get(ALLOWED_FOLDERS_KEY), ['/a', '/c']);
    t.state.pick = () => undefined;
    await t.run('idris2.manageAllowedFolders');
    assert.deepStrictEqual(t.memento.get(ALLOWED_FOLDERS_KEY), ['/a', '/c']);
    await t.run('idris2.manageAllowedFolders', ['/a', '/c', 7]);
    assert.deepStrictEqual(t.memento.get(ALLOWED_FOLDERS_KEY), []);
    await t.run('idris2.manageAllowedFolders');
    assert.match(t.state.info[0], /no folder outside the workspace is always allowed/);
  });

  test('a command that fails (a write of the global state) does not reject: the failure is shown as text', async () => {
    // A rejected command's error is shown by VS Code with its links working (M2 verification of the third review).
    const t = setup(['/a'], true);
    await t.run('idris2.manageAllowedFolders', ['/a']);
    t.state.button = 'Always Allow for This Folder';
    await t.run('idris2.allowFolder', '/outside/x');
    assert.deepStrictEqual(t.warned, [
      'Idris 2: Manage Allowed Folders failed: [x]\u200b(command:y) the storage is closed',
      'Idris 2: Allow… failed: [x]\u200b(command:y) the storage is closed',
    ]);
  });

  test('disposing unregisters both commands', () => {
    const t = setup();
    assert.deepStrictEqual([...t.commands.keys()].sort(), ['idris2.allowFolder', 'idris2.manageAllowedFolders']);
    t.consent.dispose();
    assert.strictEqual(t.commands.size, 0);
  });
});
