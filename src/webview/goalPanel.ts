/**
 * The goal panel's script (`src/webview/goalPanel.ts` in docs/ARCHITECTURE.md §2, §9), the second
 * esbuild entry point, bundled to `dist/goalPanel.js` as a browser IIFE: it draws each state the host
 * sends (`view.ts`) and acknowledges it. All the rest is the host's (`features/goalPanel`).
 *
 * The extension is compiled without the DOM's types, which would give its Node code `window` and
 * `document` too: these declarations are the little of them that this file uses.
 */
import type { FromWebview, PanelState, ToWebview } from './protocol';
import { draw, panelView, type DocumentLike, type ElementLike, type Ui } from './view';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };
declare const document: DocumentLike;
declare const window: { addEventListener(type: 'message', listener: (event: { readonly data: ToWebview }) => void): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('root') as ElementLike;
const ui: Ui = { post: (message) => vscode.postMessage(message), refine: '' };
let shown: PanelState | undefined;

window.addEventListener('message', ({ data }) => {
  if (data.type === 'state' && (shown === undefined || data.state.version > shown.version)) {
    shown = data.state;
    draw(document, root, panelView(shown, ui));
    vscode.postMessage({ type: 'rendered', version: shown.version, text: root.textContent ?? '' });
  }
});
vscode.postMessage({ type: 'ready' });
