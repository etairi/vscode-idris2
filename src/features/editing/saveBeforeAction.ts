/**
 * The save-before-action policy (`idris2.checking.saveBeforeAction`, `core/config.ts`
 * `SaveBeforeAction`; `types.ts`, *One edit*, step 2). The compiler edits the text its last load of
 * the file read, so an editing command runs on the saved file: a document with unsaved changes is
 * saved (`always`, the default), saved once the user agrees — one question per run of a command
 * (`prompt`) —, or not saved, the command asking for the save (`never`). A save that does not
 * happen (VS Code's `save()` resolves false) ends the command with a message. A document without
 * unsaved changes is left alone under every setting.
 *
 * Only type imports from `vscode`.
 */
import * as path from 'path';
import type * as vscode from 'vscode';
import type { SaveBeforeAction } from '../../core/config';
import { plainText, shownPath } from '../../core/notificationText';

/** The part of the `vscode` namespace the policy uses. */
export type SaveApi = { readonly window: Pick<typeof vscode.window, 'showInformationMessage'> };

/** The part of a document the policy reads; `vscode.TextDocument` satisfies it. */
export interface SaveDocument {
  readonly fileName: string;
  readonly isDirty: boolean;
  save(): Thenable<boolean>;
}

/**
 * What the policy decided: `ready` — the document has no unsaved changes (it had none, or was
 * saved); `refused` — the command stops, `message` (plain text) says why; `cancelled` — the user
 * declined the save.
 */
export type SaveOutcome = { readonly kind: 'ready' } | { readonly kind: 'refused'; readonly message: string } | { readonly kind: 'cancelled' };

/** The button of the `prompt` question. */
export const SAVE_BUTTON = 'Save';

/**
 * Applies `setting` to `doc` before the command titled `title` (`Case Split`) runs. With `prompt`
 * the question is modal: it names the file (`shownPath`, after the fixed text, the M2 rule) and
 * offers Save (and VS Code's own Cancel).
 */
export async function saveBeforeAction(api: SaveApi, doc: SaveDocument, setting: SaveBeforeAction, title: string): Promise<SaveOutcome> {
  if (!doc.isDirty) {
    return { kind: 'ready' };
  }
  if (setting === 'never') {
    return {
      kind: 'refused',
      message: `Idris 2: save the file first. ${title} works on the file as saved, and idris2.checking.saveBeforeAction is "never".`,
    };
  }
  if (setting === 'prompt') {
    const answer = await api.window.showInformationMessage(
      plainText(`Idris 2: ${title} works on the file as saved. Save ${shownPath(path.basename(doc.fileName))} now?`),
      { modal: true },
      SAVE_BUTTON,
    );
    if (answer !== SAVE_BUTTON) {
      return { kind: 'cancelled' };
    }
  }
  if (!(await doc.save())) {
    return { kind: 'refused', message: `Idris 2: the file was not saved, so ${title} did not run.` };
  }
  return { kind: 'ready' };
}
