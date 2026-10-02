/**
 * Helpers of the `editing` suite (.vscode-test.mjs): workspace test/fixtures/workspaces/broken,
 * loose files, whose session directory is the workspace folder (no consent question); the fake
 * compiler replays the transcripts recorded from Idris 2 0.8.0, keyed by the fixtures' SHA-256, so
 * every test leaves each file as it is on disk: an applied edit is undone (and must take exactly
 * one undo step) or reverted, and a save saves unchanged text. Not a test file itself.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { EditingCommandId, EditingOutcome } from '../../../src/features/editing/types';
import { checkSession, loadedIn, showFile, waitFor, workspaceFile, type FakeLogs } from '../support';

/** The session directory of the loose files: the workspace folder. */
export const root = (): string => workspaceFile().fsPath;

/**
 * Opens the workspace file `name` in the active editor with the cursor at `at` and returns the
 * editor. The command under test loads the file itself when its compiler has not (the check on
 * open runs only the first time a document is shown, M2).
 */
export async function showAt(name: string, at: vscode.Position): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(workspaceFile(name));
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(at, at);
  return editor;
}

/**
 * Shows the workspace file `name` and waits until the `check` session has loaded it (a suite's
 * setup, after the environment setting restarted the session). A document still open from an
 * earlier suite is not checked when shown again (M2: once per opened document), and the restart
 * checks only the documents visible at its handshake, so when neither applies the helper starts
 * the check itself, as Check File does.
 */
export async function showLoaded(api: TestApi, name: string): Promise<vscode.TextDocument> {
  const doc = await showFile(name);
  if (api.checks.runningCheck(doc) === undefined && checkSession(api, root())?.loadedFile?.path !== doc.uri.fsPath) {
    await api.checks.check(doc);
  }
  await loadedIn(api, root(), doc.uri.fsPath);
  return doc;
}

/** `text` with `deleteCount` lines from line `start` (0-based) replaced by `lines`. */
export function spliceLines(text: string, start: number, deleteCount: number, ...lines: string[]): string {
  const all = text.split('\n');
  all.splice(start, deleteCount, ...lines);
  return all.join('\n');
}

/** Asserts that `outcome` is an applied edit of `command` in `doc`. */
export function assertApplied(outcome: EditingOutcome, command: EditingCommandId, doc: vscode.TextDocument): void {
  assert.deepStrictEqual(outcome, { command, kind: 'applied', uri: doc.uri.toString() });
}

/** Asserts that `outcome` is a message of `command` (nothing changed) matching `pattern`, and returns the message. */
export function assertMessage(outcome: EditingOutcome, command: EditingCommandId, pattern: RegExp): string {
  assert.ok(outcome.kind === 'message' && outcome.command === command, JSON.stringify(outcome));
  assert.match(outcome.message, pattern);
  return outcome.message;
}

/**
 * Undoes once in `editor` and waits until its document is `saved` again and not dirty: an edit
 * that took more than one undo step fails here.
 */
export async function undoOnce(editor: vscode.TextEditor, saved: string): Promise<void> {
  await vscode.window.showTextDocument(editor.document);
  await vscode.commands.executeCommand('undo');
  await waitFor(
    () => `one undo to restore ${editor.document.fileName} as saved (it reads ${JSON.stringify(editor.document.getText())}, dirty: ${editor.document.isDirty})`,
    () => (editor.document.getText() === saved && !editor.document.isDirty ? true : undefined),
  );
}

/** Reverts every open document of the workspace that has unsaved changes (a failed test's leftovers). */
export async function revertAll(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file')) {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
}

/** The requests of M4's edits: what nothing but an editing command sends (`backend/types.ts` `EditKind`). */
const EDIT_REQUEST = /^\(:(case-split|add-clause|make-lemma|make-with|make-case|proof-search|generate-def|intro|refine|interpret) |^:(proof-search-next|generate-def-next)$/;

/**
 * The texts, without the id, of the edit requests (`EDIT_REQUEST`) that the fake's `check`
 * sessions read from the `from`-th request of its log on: `(:case-split 8 6 "xs")`,
 * `:proof-search-next`. Passive requests (a load, the holes' `:metavariables`) are left out.
 */
export function editRequests(logs: FakeLogs, from: number): string[] {
  return logs
    .requestsOf('check', from)
    .map((r) => /^\((.*) [0-9]+\)\n$/s.exec(r.request)?.[1] ?? r.request)
    .filter((t) => EDIT_REQUEST.test(t));
}
