/**
 * `features/repl` (ROADMAP M8): the REPL in a terminal, and evaluation where you write. It adds no
 * backend capability, and nothing here runs until a command does; `extension.ts` registers it.
 *
 * **The terminal** is the compiler's own REPL (`launch.ts`), so it starts the compiler in a project
 * directory: only in a trusted workspace, through the toolchain's checks and the consent gate, in the
 * real path the gate judged last (M2's rules, `terminals.ts`). It is the one terminal that runs a
 * program, and the program is the compiler: VS Code starts it, not `core/process.ts`, and the user is
 * at its prompt. It is not a session: it has no timeouts, **Stop Backend** leaves it alone, and it
 * counts against no limit. There is one per root, kept until it closes.
 *
 * **Query…** and the **`-- >>>` lenses** use the root's `eval` session, through
 * `EvaluationResults.run`, with the allow-list of ROADMAP §9, 2026-10-30: expressions, `:t` and `:doc`
 * (`IdrisBackend.evaluate`'s `queryCommands`). The elaborator scripts they reach run, as for Evaluate
 * (Q23); so a single lens or a Query runs what the user reads, and **Run all** asks first, saying how
 * many lines it runs, since those comments may be unread in a cloned repository.
 */
import type * as vscode from 'vscode';
import type { BackendRegistry } from '../../backend/registry';
import type { Config } from '../../core/config';
import type { IDisposable } from '../../core/disposable';
import type { IdrisException } from '../../core/errors';
import type { Log } from '../../core/log';
import type { SessionGate, WorkspaceTrust } from '../../core/trust';
import type { ProjectIndex } from '../../project/types';
import type { FileSystemProbe } from '../../toolchain/fileSystem';
import type { ToolchainService } from '../../toolchain/types';
import type { EvaluationResults } from '../eval/register';
import type { DocumentQueries } from '../intelligence/types';
import type { ReplLaunch } from './launch';

export interface ReplDeps {
  readonly projects: Pick<ProjectIndex, 'classify' | 'sessionCwd'>;
  readonly toolchain: Pick<ToolchainService, 'current'>;
  readonly config: Pick<Config, 'ideMode' | 'repl' | 'saveBeforeAction'>;
  readonly trust: WorkspaceTrust;
  readonly gate: SessionGate;
  /** `SessionPool.startProblem`: what keeps the compiler from starting, before the consent question. */
  startProblem(): Promise<IdrisException | undefined>;
  /** Looks for `rlwrap` (`launch.ts`). */
  readonly fileSystem: Pick<FileSystemProbe, 'stat'>;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly evaluation: Pick<EvaluationResults, 'run'>;
  readonly queries: Pick<DocumentQueries, 'run'>;
  readonly registry: Pick<BackendRegistry, 'backendFor'>;
  readonly log: Log;
}

/** What the tests read (`TestApi.repl`). */
export interface ReplView {
  /** What each terminal was started with, in order. */
  readonly launches: readonly ReplLaunch[];
  /** What was typed into the terminals, in order. */
  readonly typed: readonly string[];
  /** The open REPL terminal of the document's root. */
  terminalOf(doc: vscode.TextDocument): Promise<vscode.Terminal | undefined>;
}

export interface ReplRegistration extends IDisposable {
  readonly view: ReplView;
}
