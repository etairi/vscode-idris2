/**
 * Shared types of `features/backend` (ROADMAP M5: the routing's user interface — **Idris 2: Switch
 * Backend…**, the one-time notification for a file idris2-lsp cannot load, the copy of bamboo's
 * settings, the prompts to restart the language server). Types only.
 */
import type * as vscode from 'vscode';
import type { Event } from '../../core/event';

/**
 * What this part needs of the language client, which `extension.ts` fills from `LspClient`
 * (features do not import `backend/lsp`, src/README.md): its state, Restart, and its reports of a
 * missing `.ipkg` (`LspClientHandle` in `backend/lsp/types.ts` says when they come).
 */
export interface LanguageServerControl {
  readonly state: { readonly kind: 'notStarted' | 'starting' | 'running' | 'stopped' | 'failed' };
  restart(): Promise<void>;
  readonly onDidReportMissingIpkg: Event<{ readonly uri?: vscode.Uri }>;
}

/** A notification this part showed, recorded for the test API (`extension.ts` `TestApi`). */
export interface RoutingNotice {
  readonly kind: 'noIpkg' | 'missingIpkg' | 'migration' | 'restart';
  /** The text as shown (before `plainText`). */
  readonly message: string;
  /** The buttons offered. */
  readonly actions: readonly string[];
}
