// Suite `intelligence` (.vscode-test.mjs): workspace test/fixtures/workspaces/simple-ipkg, the
// package's own folder (its session directory is the workspace folder: no consent question), the
// fake tools, the default transport (stdio). The fake compiler replays the replies recorded from
// Idris 2 0.8.0 (transcripts load-simple-ipkg, simple-ipkg-lookups and shapes-lookups), so what
// the tests see is what the real compiler's replies turn into: ROADMAP §5 M3 acceptance,
// integration part (hover, definition across files, semantic tokens, the F33 replay), plus the
// documentation document, document symbols and highlights. The fake's logs
// (FAKE_IDRIS2_LOG, FAKE_IDRIS2_REQUEST_LOG, switched on through idris2.toolchain.env) show which
// requests produced each answer. Positions below are 0-based (VS Code); the requests they name
// are 1-based lines and 0-based columns (F2).
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { readTranscripts, transcriptsDir } from '../../fake-idris2/client';
import {
  assertUntrustedMarkdown,
  extensionApi,
  FakeLogs,
  hoverWith,
  loadedIn,
  semanticTokensWhen,
  setToolchainSetting,
  settledScan,
  showFile,
  tokenAt,
  waitFor,
  waitForAsync,
  workspaceFile,
} from '../support';

const root = (): string => workspaceFile().fsPath;
const file = (name: string): string => workspaceFile('src', 'Foo', name).fsPath;

/** The idris2-lsp legend (`SemanticTokenLegend`, features/intelligence/types.ts), in its order. */
const LEGEND = ['type', 'function', 'enumMember', 'variable', 'keyword', 'namespace', 'postulate', 'module', 'comment'];

suite('M3 read-only intelligence on simple-ipkg (fake compiler replaying the 0.8.0 transcripts)', () => {
  let api: TestApi;
  let logs: FakeLogs;

  /**
   * Whether the check session read the request `command` (its text without the id), or one that
   * `command` matches when it is a pattern for that text.
   */
  const checkRead = (command: string | RegExp): boolean =>
    logs.requestsOf('check').some((r) => {
      const m = /^\((.*) [0-9]+\)\n$/s.exec(r.request);
      return m !== null && (typeof command === 'string' ? m[1] === command : command.test(m[1]));
    });

  suiteSetup(async () => {
    api = await extensionApi();
    await settledScan(api, 'the first scan');
    logs = new FakeLogs();
    await setToolchainSetting(api, 'env', logs.env);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await setToolchainSetting(api, 'env', undefined);
    logs.dispose();
  });

  test('hover on greeting (B.idr): "Foo.B.greeting : String" from a positional :type-of, in untrusted markdown', async () => {
    const doc = await showFile('src', 'Foo', 'B.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    // `greeting = shout "hello"`, line 7: the definition's occurrence of the name.
    const hover = await hoverWith(doc.uri, new vscode.Position(6, 0), 'Foo.B.greeting : String');
    assertUntrustedMarkdown(hover);
    assert.ok(checkRead('(:type-of "greeting" 7 0)'), JSON.stringify(logs.requestsOf('check')));
  });

  test('F12 on shout (B.idr) opens src/Foo/A.idr at the span :name-at returns: (2,0)–(3,24), from the export line to the end of the signature', async () => {
    const doc = await showFile('src', 'Foo', 'B.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    const locations = await waitForAsync('a definition of shout', async () => {
      const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider',
        doc.uri,
        new vscode.Position(6, 11),
      );
      return found.length > 0 ? found : undefined;
    });
    assert.strictEqual(locations.length, 1, JSON.stringify(locations));
    const [location] = locations;
    const uri = 'targetUri' in location ? location.targetUri : location.uri;
    const range = 'targetRange' in location ? location.targetRange : location.range;
    assert.strictEqual(uri.fsPath, file('A.idr'));
    assert.deepStrictEqual(
      [range.start.line, range.start.character, range.end.line, range.end.character],
      [2, 0, 3, 24],
    );
    assert.ok(checkRead('(:name-at "shout")'));
  });

  test('semantic tokens of Shapes.idr: Circle is an enumMember, area a function (the idris2-lsp legend, no modifiers)', async () => {
    const doc = await showFile('src', 'Foo', 'Shapes.idr');
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
    assert.deepStrictEqual(legend.tokenTypes, LEGEND);
    assert.deepStrictEqual(legend.tokenModifiers, []);
    const tokens = await semanticTokensWhen(doc.uri, 'Circle and area', (t) => tokenAt(t, 6, 2) !== undefined && tokenAt(t, 11, 0) !== undefined);
    // `  Circle : Double -> Shape` (line 7) and `area : Shape -> Double` (line 12): :data and :function.
    assert.deepStrictEqual(tokenAt(tokens, 6, 2), { line: 6, character: 2, length: 6, type: 'enumMember', modifiers: 0 });
    assert.deepStrictEqual(tokenAt(tokens, 11, 0), { line: 11, character: 0, length: 4, type: 'function', modifiers: 0 });
    // `area (Circle r) = pi * r * r`: the use of the constructor and the bound variable.
    assert.strictEqual(tokenAt(tokens, 12, 6)?.type, 'enumMember');
    assert.strictEqual(tokenAt(tokens, 12, 13)?.type, 'variable');
    assert.strictEqual(tokenAt(tokens, 0, 0)?.type, 'keyword'); // `module`
    assert.strictEqual(tokenAt(tokens, 0, 7)?.type, 'module'); // `Foo.Shapes`
  });

  test('F33: the highlighting replayed for Shapes.idr has empty :type and :doc-overview; hover on area still answers, from :type-of', async () => {
    const [shapes] = readTranscripts(transcriptsDir('0.8.0')).filter((t) => t.meta.scenario === 'shapes-lookups');
    const named = shapes.events.filter((e) => e.kind === 'recv' && e.text.startsWith('(:output (:ok (:highlight-source') && e.text.includes('(:name '));
    assert.ok(named.length > 30, `${named.length} named highlights`);
    for (const e of named) {
      assert.ok(e.kind === 'recv' && e.text.includes('(:doc-overview "") (:type "")'), JSON.stringify(e));
    }
    const doc = await showFile('src', 'Foo', 'Shapes.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    const hover = await hoverWith(doc.uri, new vscode.Position(11, 0), 'Foo.Shapes.area : Shape -> Double');
    assertUntrustedMarkdown(hover);
    assert.ok(checkRead('(:type-of "area" 12 0)'));
    // The doc overview comes from :docs-for (F31: the compiler ignores the mode).
    await hoverWith(doc.uri, new vscode.Position(11, 0), 'The area of a shape.');
    assert.ok(checkRead(/^\(:docs-for "area"( :overview| :full)?\)$/), JSON.stringify(logs.requestsOf('check').map((r) => r.request)));
  });

  test('hover on a pattern variable (r in area (Circle r)): its type from the positional :type-of', async () => {
    const doc = await showFile('src', 'Foo', 'Shapes.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    await hoverWith(doc.uri, new vscode.Position(12, 13), 'r : Double');
    assert.ok(checkRead('(:type-of "r" 13 13)'));
  });

  test('document highlights of r in area (Circle r) = pi * r * r: its three occurrences in that clause, not the r of perimeter', async () => {
    const doc = await showFile('src', 'Foo', 'Shapes.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    await semanticTokensWhen(doc.uri, 'the index of the load', (t) => tokenAt(t, 12, 13) !== undefined);
    const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
      'vscode.executeDocumentHighlights',
      doc.uri,
      new vscode.Position(12, 13),
    );
    assert.deepStrictEqual(
      highlights.map((h) => [h.range.start.line, h.range.start.character, h.range.end.character]).sort(),
      [
        [12, 13, 14],
        [12, 23, 24],
        [12, 27, 28],
      ],
    );
  });

  test('document symbols of Shapes.idr name its top-level declarations', async () => {
    const doc = await showFile('src', 'Foo', 'Shapes.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    const names = await waitForAsync('document symbols', async () => {
      const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
      );
      const flat: string[] = [];
      const walk = (list: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): void => {
        for (const s of list) {
          flat.push(s.name);
          if ('children' in s) {
            walk(s.children);
          }
        }
      };
      walk(symbols ?? []);
      return flat.length > 0 ? flat : undefined;
    });
    for (const name of ['Shape', 'area', 'scale', 'twice', 'Measured']) {
      assert.ok(names.some((n) => n === name || n.endsWith(`.${name}`)), `${name} is not among ${JSON.stringify(names)}`);
    }
  });

  test('Docs at Cursor, and Show Documentation… with the name at the cursor accepted, open a read-only idris2-doc: document with the compiler\'s text on area', async () => {
    const doc = await showFile('src', 'Foo', 'Shapes.idr');
    await loadedIn(api, root(), doc.uri.fsPath);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    editor.selection = new vscode.Selection(11, 1, 11, 1);
    const docsShown = (): vscode.TextDocument | undefined =>
      vscode.window.visibleTextEditors.map((e) => e.document).find((d) => d.uri.scheme === 'idris2-doc');
    await vscode.commands.executeCommand('idris2.docsAtCursor');
    const shown = await waitFor('an idris2-doc: document', docsShown);
    // Plain text, by the path's extension (not by the first line, which is compiler text): nothing in it is interpreted.
    assert.strictEqual(shown.languageId, 'plaintext');
    assert.match(shown.getText(), /Foo\.Shapes\.area : Shape -> Double\n\s+The area of a shape\.\n\s+Visibility: export/);
    await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups');
    await waitFor('the idris2-doc: document closed', () => (docsShown() === undefined ? true : undefined));
    // Show Documentation… asks for the name in an input box, the name at the cursor suggested;
    // accepting it (as Enter does) opens the same document.
    await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(11, 1, 11, 1);
    let settled = false;
    void Promise.resolve(vscode.commands.executeCommand('idris2.showDocumentation')).finally(() => {
      settled = true;
    });
    await waitForAsync('Show Documentation… to finish after its input box was accepted', async () => {
      if (!settled) {
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      }
      return settled ? true : undefined;
    });
    const again = await waitFor('an idris2-doc: document again', docsShown);
    assert.match(again.getText(), /Foo\.Shapes\.area : Shape -> Double/);
    assert.deepStrictEqual(api.intelligenceNotices.filter((n) => n.includes('Documentation')), []);
  });
});
