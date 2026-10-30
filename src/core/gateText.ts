/**
 * Why the consent gate keeps Idris 2 from a directory (`core/trust.ts` `SessionGate`), as one
 * sentence of plain text: the sessions' refusals (`backend/ide/pool.ts`) and the REPL terminal's
 * (`features/repl`), which start the compiler in a project directory under the same gate.
 */
import { shownPath } from './notificationText';
import { RESTRICTED_MODE_REASON } from './process';
import type { GateVerdict } from './trust';

/** Why a session in `dir` may not start (any more), for the requests it rejects. */
export function refusedText(verdict: GateVerdict | undefined, dir: string): string {
  return verdict === undefined || verdict.allowed ? `running Idris 2 in ${shownPath(dir)} is no longer allowed` : refusalText(verdict, dir);
}

export function refusalText(verdict: Extract<GateVerdict, { allowed: false }>, dir: string): string {
  switch (verdict.reason) {
    case 'restrictedMode':
      return RESTRICTED_MODE_REASON;
    case 'denied':
      return `Idris 2 is not started in ${shownPath(dir)}: "Don't Allow" was chosen for this folder in this window. The Idris 2 status item offers to allow it.`;
    case 'unanswered':
      return `Idris 2 is not started in ${shownPath(dir)}: the question whether it may run there was closed without an answer. The Idris 2 status item offers to ask again.`;
    case 'unresolved':
      return (
        `Idris 2 is not started in ${shownPath(dir)}: its real path could not be read (${verdict.error ?? 'no reason given'}), ` +
        'so whether it lies inside a trusted workspace folder cannot be judged.'
      );
  }
}
