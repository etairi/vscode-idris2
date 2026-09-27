import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BackendRegistry } from '../../src/backend/registry';
import type { BackendKind, IdrisBackend } from '../../src/backend/types';
import { Emitter } from '../../src/core/event';
import type { Classification } from '../../src/project/types';
import {
  describeStatus,
  registerToolchainStatus,
  statusMenuEntries,
  type StatusApi,
  type StatusInput,
} from '../../src/toolchain/status';
import {
  FakeToolchain,
  LOOSE,
  idris2Probed,
  location,
  missing,
  packFound,
  projectRoot,
  snapshot,
} from './support/toolchainFixtures';

function repoRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === 'vscode-idris2') {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no vscode-idris2 package.json above ${__dirname}`);
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string; title: string }[]; menus: Record<string, { command?: string }[]> };
};

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return { trusted: true, scanning: false, snapshot: snapshot(), label: 'syntax only', root: undefined, ...overrides };
}

suite('toolchain/status', () => {
  suite('describeStatus', () => {
    test('a probed 0.8.0 compiler with no backend: "Idris 2 0.8.0 · syntax only", information', () => {
      const view = describeStatus(input());
      assert.strictEqual(view.text, 'Idris 2 0.8.0 · syntax only');
      assert.strictEqual(view.severity, 'information');
      assert.strictEqual(view.busy, false);
      assert.strictEqual(view.commandTitle, 'Show Commands…');
      assert.match(view.detail, /^idris2 \/opt\/homebrew\/bin\/idris2/);
    });

    test('the version is shown as printed, tag included, and the label is the registry\'s', () => {
      const view = describeStatus(input({ snapshot: snapshot({ idris2: idris2Probed('0.8.0-1c630e6a2') }), label: 'IDE mode' }));
      assert.strictEqual(view.text, 'Idris 2 0.8.0-1c630e6a2 · IDE mode');
    });

    test('a version line whose version did not parse says so instead of guessing', () => {
      const probed = idris2Probed();
      assert.ok(probed.status === 'probed');
      const unparsed = { ...probed, info: { ...probed.info, version: undefined } };
      assert.strictEqual(
        describeStatus(input({ snapshot: snapshot({ idris2: unparsed }) })).text,
        'Idris 2 (unrecognised version) · syntax only',
      );
    });

    test('missing compiler: "idris2 not found — Setup…", warning, the reason as detail', () => {
      const view = describeStatus(input({ snapshot: snapshot({ idris2: missing('The configured path /x/idris2 does not exist.') }) }));
      assert.deepStrictEqual(view, {
        text: 'idris2 not found — Setup…',
        detail: 'The configured path /x/idris2 does not exist.',
        severity: 'warning',
        busy: false,
        commandTitle: 'Setup…',
      });
    });

    test('a compiler that failed to run is a warning with the path and the reason', () => {
      const failed = { status: 'failed' as const, location: location('idris2', '/x/idris2'), reason: 'exit code 3', probes: [] };
      const view = describeStatus(input({ snapshot: snapshot({ idris2: failed }) }));
      assert.strictEqual(view.text, 'idris2 not working — Setup…');
      assert.strictEqual(view.detail, '/x/idris2: exit code 3');
      assert.strictEqual(view.severity, 'warning');
    });

    test('Restricted Mode wins over any snapshot: detection disabled, nothing claimed about idris2', () => {
      for (const s of [undefined, snapshot(), snapshot({ trusted: false })]) {
        const view = describeStatus(input({ trusted: false, snapshot: s }));
        assert.strictEqual(view.text, 'Restricted Mode — toolchain detection disabled');
        assert.strictEqual(view.severity, 'information');
      }
    });

    test('before the first trusted scan finishes (also right after trust was granted) the item is busy', () => {
      for (const s of [undefined, snapshot({ trusted: false })]) {
        const view = describeStatus(input({ snapshot: s }));
        assert.strictEqual(view.text, 'Idris 2');
        assert.strictEqual(view.busy, true);
      }
    });

    test('a rescan keeps the last result on screen and marks the item busy', () => {
      const view = describeStatus(input({ scanning: true }));
      assert.strictEqual(view.text, 'Idris 2 0.8.0 · syntax only');
      assert.strictEqual(view.busy, true);
    });

    test('the detail names the root; an unreadable .ipkg or several .ipkg files in one directory are warnings', () => {
      assert.match(describeStatus(input({ root: LOOSE })).detail, /loose file \(no \.ipkg above \/w\/loose-file\)/);
      const ok = describeStatus(input({ root: projectRoot() }));
      assert.match(ok.detail, /project \/w\/simple-ipkg\/simple-ipkg\.ipkg/);
      assert.strictEqual(ok.severity, 'information');
      const broken = describeStatus(
        input({
          root: projectRoot({
            model: { status: 'error', source: 'dump-json', error: { message: 'Error: Unrecognised property "pkgs".\n"bad.ipkg":3:1--3:5' } },
          }),
        }),
      );
      assert.match(broken.detail, /could not be read: Error: Unrecognised property "pkgs"\.$/);
      assert.strictEqual(broken.severity, 'warning');
      const several = describeStatus(input({ root: projectRoot({ otherIpkgs: ['/w/simple-ipkg/b.ipkg'] }) }));
      assert.match(several.detail, /other \.ipkg files in that directory: \/w\/simple-ipkg\/b\.ipkg/);
      assert.strictEqual(several.severity, 'warning');
      assert.ok(!ok.detail.includes('outside'));
      const outside = describeStatus(input({ root: projectRoot({ insideWorkspace: false }) }));
      assert.match(outside.detail, /project \/w\/simple-ipkg\/simple-ipkg\.ipkg \(outside the workspace folders: read without the compiler\)/);
      assert.strictEqual(outside.severity, 'information');
    });

    test('a likely server mismatch is reported in the detail (no backend uses the server in M1)', () => {
      const view = describeStatus(input({ snapshot: snapshot({ verdict: { kind: 'likelyMismatch', reason: 'API 0.7.0 ≠ 0.8.0.' } }) }));
      assert.match(view.detail, /idris2-lsp: API 0\.7\.0 ≠ 0\.8\.0\.$/);
      assert.strictEqual(view.severity, 'information');
      assert.doesNotMatch(describeStatus(input({ snapshot: snapshot({ verdict: { kind: 'compatible', reason: 'same' } }) })).detail, /idris2-lsp/);
    });
  });

  suite('statusMenuEntries (the QuickPick repeats the editor-title submenu)', () => {
    const submenu = manifest.contributes.menus['idris2.editorTitle'].map((e) => e.command);

    test('on the real package.json without pack: every submenu command but Install or Update idris2-lsp, in menu order', () => {
      assert.deepStrictEqual(
        statusMenuEntries(manifest, { packFound: false }).map((e) => e.command),
        [
          'idris2.showSetupInformation',
          'idris2.rescanToolchain',
          'idris2.installIdris2',
          'idris2.installPack',
          'idris2.showOutput',
          'idris2.openSettings',
          'idris2.openDocumentation',
          'idris2.reportIssue',
        ],
      );
    });

    test('with pack: Install or Update idris2-lsp replaces Install pack…', () => {
      const commands = statusMenuEntries(manifest, { packFound: true }).map((e) => e.command);
      assert.ok(commands.includes('idris2.installIdris2Lsp'));
      assert.ok(!commands.includes('idris2.installPack'));
      assert.strictEqual(commands.indexOf('idris2.installIdris2Lsp'), 3);
    });

    test('the two contexts together cover exactly the submenu, and the titles are the contributed ones', () => {
      const both = [...statusMenuEntries(manifest, { packFound: false }), ...statusMenuEntries(manifest, { packFound: true })];
      assert.deepStrictEqual([...new Set(both.map((e) => e.command))].sort(), [...submenu].sort());
      for (const entry of both) {
        assert.strictEqual(entry.title, manifest.contributes.commands.find((c) => c.command === entry.command)?.title);
      }
    });

    test("order is VS Code's compareMenuItems: navigation, other groups, no group; order (none = 0); title", () => {
      // Transcribed from MenuInfo.compareMenuItems in VS Code 1.139.1's workbench bundle [src]:
      // an entry without @order counts as order 0 and so comes first in its group, and entries
      // without a group come after every group.
      const shuffled = {
        contributes: {
          commands: [
            { command: 'a', title: 'A' },
            { command: 'b', title: 'B' },
            { command: 'c', title: 'C' },
            { command: 'd', title: 'D' },
            { command: 'n', title: 'N' },
            { command: 'y', title: 'Y' },
            { command: 'z', title: 'Z' },
          ],
          menus: {
            'idris2.editorTitle': [
              { command: 'z' },
              { command: 'd', group: '2_x@1' },
              { command: 'c', group: '1_x' },
              { command: 'b', group: '1_x@2' },
              { command: 'y' },
              { command: 'a', group: '1_x@10' },
              { command: 'n', group: 'navigation@5' },
            ],
          },
        },
      };
      assert.deepStrictEqual(
        statusMenuEntries(shuffled, { packFound: false }).map((e) => [e.command, e.group]),
        [
          ['n', 'navigation'],
          ['c', '1_x'],
          ['b', '1_x'],
          ['a', '1_x'],
          ['d', '2_x'],
          ['y', ''],
          ['z', ''],
        ],
      );
    });

    test('a when clause it cannot evaluate, or a command that is not contributed, is an error, not a silent entry', () => {
      const withWhen = (when: string) => ({
        contributes: { commands: [{ command: 'a', title: 'A' }], menus: { 'idris2.editorTitle': [{ command: 'a', when }] } },
      });
      assert.throws(() => statusMenuEntries(withWhen('idris2.isIdrisDocument'), { packFound: true }), /cannot evaluate/);
      assert.throws(
        () => statusMenuEntries({ contributes: { commands: [], menus: { 'idris2.editorTitle': [{ command: 'x' }] } } }, { packFound: false }),
        /does not contribute/,
      );
    });
  });

  suite('registerToolchainStatus (against a fake VS Code API)', () => {
    interface FakeItem {
      text: string;
      detail?: string;
      busy: boolean;
      severity: number;
      command?: { command: string; title: string };
      name?: string;
      disposed: boolean;
      dispose(): void;
    }

    /** What the status code reads of a `vscode.TextDocument`. */
    interface FakeDocument {
      languageId: string;
      fileName: string;
      isUntitled: boolean;
      uri: { scheme: string; fsPath: string; toString(): string };
    }
    const fileDocument = (languageId: string, fsPath: string): FakeDocument => ({
      languageId,
      fileName: fsPath,
      isUntitled: false,
      uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` },
    });

    function setup(initial = snapshot()) {
      const items: FakeItem[] = [];
      const contextWrites: [string, unknown][] = [];
      const executed: string[] = [];
      const commands = new Map<string, () => Promise<void>>();
      const activeEditorChanged = new Emitter<void>();
      const documentOpened = new Emitter<FakeDocument>();
      const projectsChanged = new Emitter<void>();
      const trustGranted = new Emitter<void>();
      const classifications = new Map<string, Promise<Classification>>();
      let picked: ((items: { label: string; kind?: number; command?: string }[]) => unknown) | undefined;
      const state = { activeDocument: undefined as undefined | FakeDocument };
      const logged: string[] = [];
      const api = {
        languages: {
          createLanguageStatusItem: () => {
            const item: FakeItem = { text: '', busy: false, severity: 0, disposed: false, dispose: () => (item.disposed = true) };
            items.push(item);
            return item;
          },
        },
        window: {
          get activeTextEditor() {
            return state.activeDocument && { document: state.activeDocument };
          },
          onDidChangeActiveTextEditor: activeEditorChanged.event,
          showQuickPick: (list: { label: string; kind?: number; command?: string }[]) => Promise.resolve(picked?.(list)),
        },
        workspace: {
          onDidOpenTextDocument: documentOpened.event,
        },
        commands: {
          registerCommand: (id: string, run: () => Promise<void>) => {
            commands.set(id, run);
            return { dispose: () => commands.delete(id) };
          },
          executeCommand: (id: string, ...args: unknown[]) => {
            if (id === 'setContext') {
              contextWrites.push([args[0] as string, args[1]]);
            } else {
              executed.push(id);
            }
            return Promise.resolve();
          },
        },
        LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
        QuickPickItemKind: { Separator: -1, Default: 0 },
      } as unknown as StatusApi;
      const toolchain = new FakeToolchain(initial);
      const registry = new BackendRegistry();
      const trust = { isTrusted: true, onDidGrant: trustGranted.event };
      const status = registerToolchainStatus(api, {
        toolchain,
        projects: {
          classify: (file: string) => classifications.get(file) ?? Promise.resolve(LOOSE),
          onDidChange: projectsChanged.event,
        },
        registry,
        trust,
        manifest,
        log: { trace: () => undefined, debug: () => undefined, info: (m: string) => logged.push(m), warn: () => undefined, error: () => undefined },
      });
      return {
        logged,
        item: items[0],
        status,
        toolchain,
        registry,
        trust,
        trustGranted,
        contextWrites,
        executed,
        commands,
        classifications,
        state,
        activeEditorChanged,
        documentOpened,
        projectsChanged,
        choose: (f: typeof picked) => (picked = f),
      };
    }

    const settle = () => new Promise((resolve) => setImmediate(resolve));

    test('the item shows the snapshot, runs Show Commands…, and follows new snapshots', () => {
      const t = setup();
      assert.strictEqual(t.item.text, 'Idris 2 0.8.0 · syntax only');
      assert.strictEqual(t.item.severity, 0);
      assert.deepStrictEqual(t.item.command, { command: 'idris2.showStatusMenu', title: 'Show Commands…' });
      t.toolchain.setScanning(true);
      assert.strictEqual(t.item.busy, true);
      t.toolchain.publish({ idris2: missing() });
      assert.strictEqual(t.item.text, 'idris2 not found — Setup…');
      assert.strictEqual(t.item.severity, 1);
      assert.strictEqual(t.item.busy, false);
      // Each change of text or severity is logged once; the busy flag alone is not.
      assert.deepStrictEqual(t.logged, ['Status: Idris 2 0.8.0 · syntax only', 'Status: idris2 not found — Setup… (warning)']);
    });

    test('the label follows the registry for the active document\'s root', async () => {
      const t = setup();
      const root = projectRoot();
      t.classifications.set('/w/simple-ipkg/src/Foo/B.idr', Promise.resolve(root));
      t.state.activeDocument = fileDocument('idris2', '/w/simple-ipkg/src/Foo/B.idr');
      t.activeEditorChanged.fire();
      await settle();
      assert.match(t.item.detail ?? '', /project \/w\/simple-ipkg\/simple-ipkg\.ipkg/);
      const registration = t.registry.register(root, { kind: 'ideMode' as BackendKind } as unknown as IdrisBackend);
      assert.strictEqual(t.item.text, 'Idris 2 0.8.0 · IDE mode');
      registration.dispose();
      assert.strictEqual(t.item.text, 'Idris 2 0.8.0 · syntax only');
    });

    test('a slow classification answered after a newer one is dropped', async () => {
      const t = setup();
      let resolveSlow: (c: Classification) => void = () => undefined;
      t.classifications.set('/w/a/Slow.idr', new Promise((resolve) => (resolveSlow = resolve)));
      t.state.activeDocument = fileDocument('idris2', '/w/a/Slow.idr');
      t.activeEditorChanged.fire();
      t.state.activeDocument = fileDocument('idris2', '/w/loose-file/Hello.idr');
      t.activeEditorChanged.fire();
      await settle();
      resolveSlow(projectRoot());
      await settle();
      assert.match(t.item.detail ?? '', /loose file/);
    });

    test("switching to another Idris file never shows the previous file's root while the new one is classified", async () => {
      const t = setup();
      // The first file's package has a problem (F10), so the item is a warning.
      t.classifications.set('/w/a/A.idr', Promise.resolve(projectRoot({ otherIpkgs: ['/w/a/other.ipkg'] })));
      t.state.activeDocument = fileDocument('idris2', '/w/a/A.idr');
      t.activeEditorChanged.fire();
      await settle();
      assert.strictEqual(t.item.severity, 1);
      assert.match(t.item.detail ?? '', /other \.ipkg files/);
      // The second file's classification is slow (e.g. --dump-ipkg-json behind a rescan).
      let resolveSlow: (c: Classification) => void = () => undefined;
      t.classifications.set('/w/b/B.idr', new Promise((resolve) => (resolveSlow = resolve)));
      t.state.activeDocument = fileDocument('idris2', '/w/b/B.idr');
      t.activeEditorChanged.fire();
      t.toolchain.publish(); // a render while the answer is pending
      await settle();
      assert.strictEqual(t.item.severity, 0);
      assert.doesNotMatch(t.item.detail ?? '', /project|other \.ipkg/);
      resolveSlow(LOOSE);
      await settle();
      assert.match(t.item.detail ?? '', /loose file/);
    });

    test('a project change keeps the root of the same file until the new answer arrives', async () => {
      const t = setup();
      t.classifications.set('/w/a/A.idr', Promise.resolve(projectRoot()));
      t.state.activeDocument = fileDocument('idris2', '/w/a/A.idr');
      t.activeEditorChanged.fire();
      await settle();
      assert.match(t.item.detail ?? '', /project /);
      t.classifications.set('/w/a/A.idr', new Promise(() => undefined));
      t.projectsChanged.fire();
      await settle();
      assert.match(t.item.detail ?? '', /project /);
    });

    test('a non-Idris active editor leaves the item as it was (VS Code hides it anyway)', async () => {
      const t = setup();
      t.state.activeDocument = fileDocument('markdown', '/w/Notes.md');
      t.activeEditorChanged.fire();
      await settle();
      assert.strictEqual(t.item.text, 'Idris 2 0.8.0 · syntax only');
    });

    test('a document that becomes Idris in place (language mode changed) is classified: VS Code reports close + open only', async () => {
      const t = setup();
      t.classifications.set('/w/a/A.idr', Promise.resolve(projectRoot({ otherIpkgs: ['/w/a/other.ipkg'] })));
      t.state.activeDocument = fileDocument('idris2', '/w/a/A.idr');
      t.activeEditorChanged.fire();
      await settle();
      assert.strictEqual(t.item.severity, 1);
      const notes = fileDocument('markdown', '/w/b/Notes.md');
      t.state.activeDocument = notes;
      t.activeEditorChanged.fire();
      await settle();
      // Change Language Mode → Idris 2: the same document, now idris2; no active-editor event.
      notes.languageId = 'idris2';
      t.documentOpened.fire(notes);
      await settle();
      assert.match(t.item.detail ?? '', /loose file/);
      assert.doesNotMatch(t.item.detail ?? '', /other \.ipkg|project/);
      assert.strictEqual(t.item.severity, 0);
      // Another document opening (not the active one) changes nothing.
      t.classifications.set('/w/c/C.idr', Promise.resolve(projectRoot()));
      t.documentOpened.fire(fileDocument('idris2', '/w/c/C.idr'));
      await settle();
      assert.match(t.item.detail ?? '', /loose file/);
    });

    test('idris2.packFound is written only when it changes, and reset to false on dispose', () => {
      const t = setup();
      assert.deepStrictEqual(t.contextWrites, []);
      t.toolchain.publish({ pack: packFound() });
      t.toolchain.publish({ pack: packFound() });
      assert.deepStrictEqual(t.contextWrites, [['idris2.packFound', true]]);
      t.status.dispose();
      assert.deepStrictEqual(t.contextWrites, [
        ['idris2.packFound', true],
        ['idris2.packFound', false],
      ]);
      assert.strictEqual(t.item.disposed, true);
      assert.strictEqual(t.commands.size, 0);
    });

    test('Show Commands… lists the menu entries with a separator between groups and runs the chosen one', async () => {
      const t = setup();
      let shown: { label: string; kind?: number; command?: string }[] = [];
      t.choose((list) => {
        shown = list;
        return list.find((i) => i.command === 'idris2.rescanToolchain');
      });
      await t.commands.get('idris2.showStatusMenu')?.();
      assert.deepStrictEqual(
        shown.map((i) => (i.kind === -1 ? '---' : i.command)),
        [
          'idris2.showSetupInformation',
          'idris2.rescanToolchain',
          '---',
          'idris2.installIdris2',
          'idris2.installPack',
          '---',
          'idris2.showOutput',
          'idris2.openSettings',
          'idris2.openDocumentation',
          'idris2.reportIssue',
        ],
      );
      assert.deepStrictEqual(t.executed, ['idris2.rescanToolchain']);
      assert.deepStrictEqual(t.status.menuEntries(), statusMenuEntries(manifest, { packFound: false }));
    });

    test('Restricted Mode: the item says so, and granting trust re-renders it', () => {
      const t = setup(snapshot({ trusted: false }));
      t.trust.isTrusted = false;
      t.trustGranted.fire();
      assert.strictEqual(t.item.text, 'Restricted Mode — toolchain detection disabled');
      t.trust.isTrusted = true;
      t.trustGranted.fire();
      assert.strictEqual(t.item.text, 'Idris 2');
      assert.strictEqual(t.item.busy, true);
    });
  });
});
