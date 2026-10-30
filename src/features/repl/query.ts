/**
 * **Idris 2: Query…** (ROADMAP M8): a box with completion of the name being typed, whose answer goes to
 * the output channel `Idris 2 Query`, which keeps what was asked. VS Code's input box has no completion,
 * so this is a QuickPick: its first item runs what is typed, and the others complete the name at its end.
 * The names are those of Completion (`IdrisBackend.completions`, the compiler's `:repl-completions` on the
 * `check` session; a passive query, which starts nothing by itself and asks only for the active file).
 */
import type * as vscode from 'vscode';
import { editorLabel, quickPickText } from '../../core/untrustedText';
import type { DocumentQueries } from '../intelligence/types';

/** The part of the `vscode` namespace the box uses. */
export interface QueryApi {
  readonly window: Pick<typeof vscode.window, 'createQuickPick'>;
}

/** The longest name a list shows, in UTF-16 code units. */
const MAX_LABEL = 200;
/** The most names the list shows. */
const MAX_NAMES = 50;

interface QueryItem extends vscode.QuickPickItem {
  /** The name it completes to; none on the item that runs the text. */
  readonly name?: string;
}

/** The name being typed at the end of `text`, which completion replaces. */
export function nameAtEnd(text: string): string {
  return /[\p{L}\p{N}_'.]+$/u.exec(text)?.[0] ?? '';
}

/** Asks for a query in the context of `doc`, and resolves with it, `undefined` when dismissed. */
export function askQuery(api: QueryApi, queries: Pick<DocumentQueries, 'run'>, doc: vscode.TextDocument): Promise<string | undefined> {
  return new Promise((resolve) => {
    const pick = api.window.createQuickPick<QueryItem>();
    pick.title = 'Idris 2: Query';
    pick.placeholder = 'An expression, :t expression or :doc name, in the context of the file as saved';
    pick.ignoreFocusOut = true;
    let asked = 0;
    const run = (value: string): QueryItem => ({ label: quickPickText(editorLabel(value, MAX_LABEL)), description: 'Run', alwaysShow: true });
    const refresh = async (value: string): Promise<void> => {
      const number = ++asked;
      pick.items = value.trim() === '' ? [] : [run(value)];
      const prefix = nameAtEnd(value).split('.').pop() ?? '';
      if (prefix === '') {
        return;
      }
      const outcome = await queries.run(doc, 'passive', (backend) => backend.completions(doc, prefix));
      if (number === asked && outcome.kind === 'answer') {
        const names = outcome.value.slice(0, MAX_NAMES).map((name) => ({ label: quickPickText(editorLabel(name, MAX_LABEL)), alwaysShow: true, name }));
        pick.items = [run(value), ...names];
      }
    };
    pick.onDidChangeValue((value) => void refresh(value));
    pick.onDidAccept(() => {
      const { name } = pick.activeItems[0] ?? {};
      if (name !== undefined) {
        const typed = pick.value;
        const end = typed.length - (nameAtEnd(typed).split('.').pop() ?? '').length;
        pick.value = `${typed.slice(0, end)}${name}`;
        void refresh(pick.value);
        return;
      }
      const text = pick.value.trim();
      resolve(text === '' ? undefined : text);
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
}
