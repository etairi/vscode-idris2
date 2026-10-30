/**
 * The REPL terminals (`types.ts`): one per root, opened through the checks every compiler start goes
 * through.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import { rootKey } from '../../backend/registry';
import { DisposableStore, type IDisposable } from '../../core/disposable';
import { unsupported } from '../../core/errors';
import { refusalText, refusedText } from '../../core/gateText';
import { overlayEnvironment } from '../../core/process';
import { compilerReadsPathAsGiven } from '../../project/ipkg';
import type { Classification } from '../../project/types';
import { pathEntries } from '../../toolchain/discover';
import { replLaunch, replTerminalName, type ReplLaunch } from './launch';
import type { ReplDeps } from './types';

/** The part of the `vscode` namespace the terminals use. */
export interface ReplTerminalsApi {
  readonly window: Pick<typeof vscode.window, 'createTerminal' | 'onDidCloseTerminal'>;
}

export class ReplTerminals implements IDisposable {
  private readonly store = new DisposableStore();
  private readonly open = new Map<string, vscode.Terminal>();
  /** Per root, the REPL being started: a second command waits for it instead of starting another. */
  private readonly starting = new Map<string, Promise<vscode.Terminal>>();
  readonly launches: ReplLaunch[] = [];
  readonly typed: string[] = [];

  constructor(
    private readonly api: ReplTerminalsApi,
    private readonly deps: ReplDeps,
  ) {
    this.store.add(
      api.window.onDidCloseTerminal((closed) => {
        for (const [key, terminal] of this.open) {
          if (terminal === closed) {
            this.open.delete(key);
          }
        }
      }),
    );
  }

  /** The open REPL of `root`. */
  of(root: Classification): vscode.Terminal | undefined {
    const terminal = this.open.get(rootKey(root));
    return terminal?.exitStatus === undefined ? terminal : undefined;
  }

  /** The REPL of the root of `file`, started on `file` if it has none. Rejects with why it cannot start. */
  async ensure(file: string): Promise<vscode.Terminal> {
    const root = await this.deps.projects.classify(file);
    const running = this.of(root);
    if (running !== undefined) {
      return running;
    }
    const key = rootKey(root);
    const started =
      this.starting.get(key) ??
      this.start(root, file).finally(() => {
        this.starting.delete(key);
      });
    this.starting.set(key, started);
    return started;
  }

  /** Types `line`, which `launch.ts` `replLine` made, and Enter. */
  type(terminal: vscode.Terminal, line: string): void {
    this.typed.push(line);
    terminal.sendText(line, true);
  }

  private async start(root: Classification, file: string): Promise<vscode.Terminal> {
    const { deps } = this;
    const problem = await deps.startProblem();
    if (problem !== undefined) {
      throw problem;
    }
    const cwd = deps.projects.sessionCwd(root);
    const relativeFile = path.relative(cwd, file);
    if (relativeFile.startsWith('-') || !compilerReadsPathAsGiven(relativeFile, deps.platform)) {
      throw unsupported('The REPL is not started on this file: the compiler would read its path as an option or as another path (it takes \\ for a folder separator and stops reading a path at : or ?).');
    }
    const verdict = await deps.gate.permit(cwd, { ipkg: root.kind === 'project' ? root.ipkgPath : undefined });
    if (!verdict.allowed) {
      throw unsupported(refusalText(verdict, cwd));
    }
    const rlwrap = await this.rlwrap();
    // The question and the search can take a while: the directory is judged again, as it is now.
    const now = await deps.gate.recheck(cwd);
    if (now === undefined || !now.allowed) {
      throw unsupported(refusedText(now, cwd));
    }
    const snapshot = deps.toolchain.current;
    if (snapshot?.idris2.status !== 'probed') {
      throw unsupported('The REPL is not started: no Idris 2 compiler was found.');
    }
    const ideMode = deps.config.ideMode();
    const launch = replLaunch({
      root,
      relativeFile,
      idris2: snapshot.idris2.location.path,
      ...(rlwrap === undefined ? {} : { rlwrap }),
      cwd: deps.platform === 'win32' ? cwd : (now.realDir ?? cwd),
      settings: ideMode,
      env: snapshot.settings.env,
    });
    this.launches.push(launch);
    const terminal = this.api.window.createTerminal({
      name: replTerminalName(root),
      shellPath: launch.executable,
      shellArgs: [...launch.args],
      cwd: launch.cwd,
      env: { ...launch.env },
      // Not brought back after a reload, when nothing here would know it.
      isTransient: true,
    });
    this.open.set(rootKey(root), terminal);
    return terminal;
  }

  /** `rlwrap` on `PATH` (`launch.ts`), of the environment the terminal gets; only directories with a full path. */
  private async rlwrap(): Promise<string | undefined> {
    const { deps } = this;
    if (deps.platform === 'win32') {
      return undefined;
    }
    const env = overlayEnvironment(deps.processEnv, deps.toolchain.current?.settings.env ?? {}, deps.platform);
    for (const dir of pathEntries(env, deps.platform)) {
      const candidate = path.join(dir, 'rlwrap');
      const found = await deps.fileSystem.stat(candidate);
      if (found?.kind === 'file' && found.executable) {
        return candidate;
      }
    }
    return undefined;
  }

  dispose(): void {
    this.store.dispose();
    for (const terminal of this.open.values()) {
      terminal.dispose();
    }
    this.open.clear();
  }
}
