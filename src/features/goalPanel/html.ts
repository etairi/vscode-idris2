/**
 * The goal panel's page (`panelHtml`): an empty root, the stylesheet and the script. Everything it
 * shows comes as data after it loads (`src/webview/view.ts`), so nothing here can quote compiler text.
 *
 * **Content-Security-Policy** (ROADMAP M7, ARCHITECTURE §9): `default-src 'none'`, the stylesheet from
 * the extension, and only the script tag with this page's nonce; no `unsafe-inline`, no inline
 * style, no network, no images.
 */

/** What the page refers to, as `vscode.Webview` gives them. */
export interface PanelPage {
  /** `webview.cspSource`. */
  readonly cspSource: string;
  /** Random, new for each page. */
  readonly nonce: string;
  /** `webview.asWebviewUri` of `dist/goalPanel.js`. */
  readonly script: string;
  /** `webview.asWebviewUri` of `media/goalPanel.css`. */
  readonly style: string;
}

/** The page of `page`. Its values are VS Code's URIs and a nonce of base64 characters, not text from a file. */
export function panelHtml(page: PanelPage): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${page.cspSource}; script-src 'nonce-${page.nonce}';">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<link rel="stylesheet" href="${page.style}">`,
    '<title>Idris 2 Goal</title>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    `<script nonce="${page.nonce}" src="${page.script}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
