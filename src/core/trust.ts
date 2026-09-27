/**
 * Workspace trust as the M1 services see it (docs/ROADMAP.md M1 "As built": Restricted Mode).
 *
 * `package.json` declares `capabilities.untrustedWorkspaces.supported = "limited"`: in an
 * untrusted workspace the extension spawns no process at all — no `--version` probe, no
 * `--dump-ipkg-json` — and does only file-system work (locating executables, the ipkg walk,
 * the fallback ipkg reader). Every spawn goes through the process runner of `core/process.ts`,
 * which refuses to start anything while `isTrusted` is false; the services check `isTrusted`
 * first so that they can report the reason ("disabled in Restricted Mode") instead of an error.
 *
 * `extension.ts` adapts `vscode.workspace.isTrusted` and `vscode.workspace.onDidGrantWorkspaceTrust`
 * to this interface; unit tests pass a fake. The API has no event for trust being withdrawn,
 * only for it being granted, so there is none here either.
 */
import type { Event } from './event';

export interface WorkspaceTrust {
  /** Read at every use: it changes from false to true when the user grants trust. */
  readonly isTrusted: boolean;
  /** Fires when the user grants trust to the workspace (the toolchain service rescans). */
  readonly onDidGrant: Event<void>;
}
