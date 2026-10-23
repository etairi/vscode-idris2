/**
 * `registerUnsavedChecks` (ROADMAP M6): the check-while-typing controller (`unsavedChecks.ts`) and
 * the storage of the copies of unsaved documents. A window's copies are kept under
 * `<globalStorage>/shadow/<process id of its extension host>/` (`shadowBaseOf`; the pool's
 * `SessionPoolDeps.shadowBase`): VS Code gives every window of a profile the same global storage, so
 * that two windows of one project never write one copy. At activation the directories of windows
 * whose extension host has ended are deleted (`removeEndedWindows`); at deactivation (at once,
 * `StorageFs.removeNow`), and when `idris2.checkOnType.enabled` changes (`ShadowStorage.clear`),
 * this window's own.
 */
import * as path from 'path';
import type { IDisposable } from '../../core/disposable';
import type { Log } from '../../core/log';
import { UnsavedChecks, type ShadowStorage, type UnsavedChecksApi, type UnsavedChecksDeps } from './unsavedChecks';

/** The folder of the extension's global storage that holds the windows' shadow directories. */
export const SHADOW_STORAGE_DIR = 'shadow';

/** This window's shadow directories (`SessionPoolDeps.shadowBase`). */
export function shadowBaseOf(globalStorage: string, pid: number): string {
  return path.join(globalStorage, SHADOW_STORAGE_DIR, String(pid));
}

/** The file operations of the storage (`fs.promises`, and `fs.rmSync` at deactivation). */
export interface StorageFs {
  /** `readdir`; rejects when the folder does not exist. */
  readdir(p: string): Promise<string[]>;
  /** `rm` with `recursive` and `force`. */
  remove(p: string): Promise<void>;
  /**
   * `rmSync` with `recursive` and `force`: at deactivation, where VS Code ends the extension host
   * right after `deactivate()` returns, before an asynchronous removal would finish [live, M6
   * packaged-extension check: the window's folder was left].
   */
  removeNow(p: string): void;
}

/**
 * Whether the process `pid` runs: `process.kill(pid, 0)` succeeds, or fails with `EPERM` (it runs
 * as another user). A process id reused by another program keeps that window's directory, which
 * holds only copies.
 */
export function isRunning(pid: number, kill: (pid: number, signal: 0) => void = (p, signal) => process.kill(p, signal)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Deletes the folders under `storage` (`<globalStorage>/shadow`) named by the process id of an
 * extension host that no longer runs, not `ownPid`'s; folders with other names are left alone.
 * Resolves with those deleted; never rejects.
 */
export async function removeEndedWindows(storage: string, ownPid: number, fs: StorageFs, running: (pid: number) => boolean = isRunning): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(storage);
  } catch {
    return [];
  }
  const ended = names.filter((name) => /^[1-9][0-9]*$/.test(name) && Number(name) !== ownPid && !running(Number(name)));
  const removed: string[] = [];
  for (const name of ended) {
    const dir = path.join(storage, name);
    try {
      await fs.remove(dir);
      removed.push(dir);
    } catch {
      // Left for the next activation.
    }
  }
  return removed;
}

/** What `registerUnsavedChecks` needs besides the controller's dependencies. */
export interface UnsavedChecksRegistration extends Omit<UnsavedChecksDeps, 'storage'> {
  /** `<globalStorage>/shadow`. */
  readonly storageDir: string;
  /** This window's folder in it (`shadowBaseOf`). */
  readonly shadowBase: string;
  readonly pid: number;
  readonly fs: StorageFs;
  readonly log: Log;
}

/** The controller and the storage clean-ups of the module comment; disposing deletes this window's copies. */
export function registerUnsavedChecks(api: UnsavedChecksApi, deps: UnsavedChecksRegistration): IDisposable & { readonly checks: UnsavedChecks } {
  const storage: ShadowStorage = {
    clear: () =>
      deps.fs.remove(deps.shadowBase).catch((error: unknown) => {
        deps.log.warn(`Check while typing: the copies in ${deps.shadowBase} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
      }),
  };
  void removeEndedWindows(deps.storageDir, deps.pid, deps.fs).then((removed) => {
    if (removed.length > 0) {
      deps.log.debug(`Check while typing: deleted the copies of ended windows: ${removed.join(', ')}`);
    }
  });
  const checks = new UnsavedChecks(api, { ...deps, storage });
  return {
    checks,
    dispose: () => {
      checks.dispose();
      try {
        deps.fs.removeNow(deps.shadowBase);
      } catch (error) {
        // Left for the next activation (`removeEndedWindows`).
        deps.log.warn(`Check while typing: the copies in ${deps.shadowBase} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
