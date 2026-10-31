// features/shadow/register.ts: the storage of the copies of unsaved documents — one folder per
// window (the extension host's process id), the folders of ended windows deleted at activation,
// this window's at deactivation. No file is touched: the file operations are fakes.
import * as assert from 'assert';
import * as path from 'path';
import { Emitter } from '../../src/core/event';
import { isRunning, registerUnsavedChecks, removeEndedWindows, shadowBaseOf, SHADOW_STORAGE_DIR, type StorageFs } from '../../src/features/shadow/register';
import type { UnsavedChecksApi, UnsavedChecksDeps } from '../../src/features/shadow/unsavedChecks';
import { recordingLog } from './support/fakeTransport';

class FakeStorageFs implements StorageFs {
  readonly removed: string[] = [];
  constructor(
    private readonly names: string[] | undefined,
    private readonly failing = new Set<string>(),
  ) {}
  readdir(): Promise<string[]> {
    return this.names === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve([...this.names]);
  }
  remove(p: string): Promise<void> {
    if (this.failing.has(p)) {
      return Promise.reject(new Error('EBUSY'));
    }
    this.removed.push(p);
    return Promise.resolve();
  }
  removeNow(p: string): void {
    if (this.failing.has(p)) {
      throw new Error('EBUSY');
    }
    this.removed.push(`now ${p}`);
  }
}

suite('features/shadow (the storage of the copies)', () => {
  test('a window\'s folder: <globalStorage>/shadow/<process id>', () => {
    assert.strictEqual(SHADOW_STORAGE_DIR, 'shadow');
    assert.strictEqual(shadowBaseOf('/g', 4242), path.join('/g', 'shadow', '4242'));
  });

  test('at activation the folders of ended windows go; this window\'s, running ones\' and other names stay', async () => {
    const fs = new FakeStorageFs(['100', '200', '300', 'notes', '0', '007', '400']);
    const running = new Set([200]);
    const removed = await removeEndedWindows('/g/shadow', 300, fs, (pid) => running.has(pid));
    assert.deepStrictEqual(removed, [path.join('/g/shadow', '100'), path.join('/g/shadow', '400')]);
    assert.deepStrictEqual(fs.removed, removed);
  });

  test('nothing to clean: no storage folder yet; a folder that cannot be deleted is left for the next activation', async () => {
    assert.deepStrictEqual(await removeEndedWindows('/g/shadow', 1, new FakeStorageFs(undefined), () => false), []);
    const fs = new FakeStorageFs(['10', '11'], new Set([path.join('/g/shadow', '10')]));
    assert.deepStrictEqual(await removeEndedWindows('/g/shadow', 1, fs, () => false), [path.join('/g/shadow', '11')]);
  });

  test('registerUnsavedChecks: the ended windows\' folders go at activation; at dispose this window\'s folder at once (an asynchronous removal would not finish), a failure logged', async () => {
    const none = () => ({ dispose: () => undefined });
    const api = {
      CancellationTokenSource: class {},
      DiagnosticSeverity: { Error: 0, Warning: 1 },
      languages: { createDiagnosticCollection: () => ({ set: none, delete: none, get: () => undefined, dispose: () => undefined }) },
      window: { activeTextEditor: undefined, onDidChangeActiveTextEditor: none },
      workspace: { onDidChangeTextDocument: none, onDidSaveTextDocument: none, onDidCloseTextDocument: none, openTextDocument: () => Promise.reject(new Error('x')) },
    } as unknown as UnsavedChecksApi;
    const deps = (fs: StorageFs, log = recordingLog()) => ({
      registry: { backendFor: () => undefined, stateFor: () => undefined } as unknown as UnsavedChecksDeps['registry'],
      projects: { classify: () => Promise.reject(new Error('x')) },
      config: { checkOnType: () => ({ enabled: true, delayMs: 500 }), onDidChange: none } as unknown as UnsavedChecksDeps['config'],
      trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
      checks: { showSaved: () => undefined, check: () => Promise.resolve(undefined), saveChecksHeld: () => false } as unknown as UnsavedChecksDeps['checks'],
      loads: { onDidLoad: () => ({ dispose: () => undefined }) },
      stopShadows: () => undefined,
      storageDir: '/g/shadow',
      shadowBase: '/g/shadow/7',
      pid: 7,
      fs,
      log,
      timers: { set: () => 0, clear: () => undefined },
    });
    // 99999999 is above every pid_max (Linux: 2^22 at most; macOS: 99998), so no process has it.
    const fs = new FakeStorageFs(['7', '99999999']);
    const registration = registerUnsavedChecks(api, deps(fs));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(fs.removed, [path.join('/g/shadow', '99999999')], 'the ended window, not this one (7)');
    registration.dispose();
    assert.deepStrictEqual(fs.removed.at(-1), 'now /g/shadow/7');
    const failing = new FakeStorageFs([], new Set(['/g/shadow/7']));
    const log = recordingLog();
    registerUnsavedChecks(api, deps(failing, log)).dispose();
    assert.ok(log.lines.some((l) => /warn: Check while typing: the copies in \/g\/shadow\/7 could not be deleted: EBUSY/.test(l)), log.lines.join('\n'));
  });

  test('isRunning: kill(pid, 0) succeeds, or fails with EPERM (another user\'s process); ESRCH is ended', () => {
    assert.strictEqual(isRunning(5, () => undefined), true);
    const failWith = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    assert.strictEqual(isRunning(5, failWith('EPERM')), true);
    assert.strictEqual(isRunning(5, failWith('ESRCH')), false);
    assert.strictEqual(isRunning(process.pid), true, 'this process runs');
  });
});
