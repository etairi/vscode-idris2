import * as assert from 'assert';
import { Emitter } from '../../src/core/event';
import type { Classification } from '../../src/project/types';
import {
  issueBody,
  registerSetupInformation,
  renderSetupInformation,
  type SetupApi,
  type SetupInput,
} from '../../src/toolchain/setupInfo';
import {
  FakeToolchain,
  IDRIS2_PATH,
  LOOSE,
  LSP_PATH,
  SETTINGS,
  idris2Probed,
  location,
  lspProbed,
  missing,
  packFound,
  probe,
  projectRoot,
  snapshot,
} from './support/toolchainFixtures';

const HOST = {
  appName: 'Visual Studio Code',
  vscodeVersion: '1.139.1',
  remoteName: undefined,
  platform: 'darwin',
  release: '25.0.0',
  arch: 'arm64',
  nodeVersion: 'v22.20.0',
};

function input(overrides: Partial<SetupInput> = {}): SetupInput {
  return {
    generatedAt: new Date(Date.UTC(2026, 8, 27, 12, 30, 0)),
    extension: { id: 'etairi.vscode-idris2', version: '0.0.1' },
    host: HOST,
    trusted: true,
    scanning: false,
    snapshot: snapshot(),
    projects: [],
    activeDocument: undefined,
    ...overrides,
  };
}

/** The lines of `text` that start with `prefix`. */
function linesStarting(text: string, prefix: string): string[] {
  return text.split('\n').filter((line) => line.startsWith(prefix));
}

suite('toolchain/setupInfo', () => {
  suite('renderSetupInformation', () => {
    test('environment, trust and the extension version come first', () => {
      const text = renderSetupInformation(input());
      assert.ok(text.startsWith('# Idris 2: Setup Information\n\nGenerated 2026-09-27T12:30:00.000Z by etairi.vscode-idris2 0.0.1.'));
      assert.ok(text.includes('\n- Visual Studio Code 1.139.1\n'));
      assert.ok(text.includes('\n- OS: darwin 25.0.0 (arm64); Extension Host Node v22.20.0\n'));
      assert.ok(text.includes('\n- Workspace trust: trusted\n'));
      assert.ok(renderSetupInformation(input({ host: { ...HOST, remoteName: 'ssh-remote' } })).includes('1.139.1, remote `ssh-remote`'));
    });

    test('a probed idris2: path and how it was found, parsed values, and every probe with its raw output', () => {
      const text = renderSetupInformation(input());
      assert.ok(text.includes('## idris2\n\n- Path: `/opt/homebrew/bin/idris2`\n- Found by: PATH — PATH entry /opt/homebrew/bin\n'));
      assert.ok(text.includes('- Version line: `Idris 2, version 0.8.0`\n'));
      assert.ok(text.includes('- Version: `0.8.0` (major 0, minor 8, patch 0, no tag)\n'));
      assert.ok(text.includes('- TTC version: `2025081600`\n'));
      assert.ok(text.includes('  - `contrib` 0.8.0, TTC 2025081600 — `/opt/homebrew/lib/idris2/contrib-0.8.0`\n'));
      assert.deepStrictEqual(linesStarting(text, '### '), [
        '### `idris2 --version`',
        '### `idris2 --ttc-version`',
        '### `idris2 --paths`',
        '### `idris2 --list-packages`',
      ]);
      assert.ok(text.includes('### `idris2 --version`\n\nexit code 0, 12 ms\n\nstdout:\n\n```text\nIdris 2, version 0.8.0\n```\n\nstderr: (empty)\n'));
    });

    test('a TTC version or paths that are unknown say that the probe failed or was not understood', () => {
      const probed = idris2Probed();
      assert.ok(probed.status === 'probed');
      const unknown = { ...probed, info: { ...probed.info, ttcVersion: undefined, pathsText: undefined } };
      const text = renderSetupInformation(input({ snapshot: snapshot({ idris2: unknown }) }));
      assert.ok(text.includes('- TTC version: unknown (the probe failed or its output was not recognised)\n'));
      assert.ok(text.includes('- Paths (`--paths`): unknown (the probe failed or its output was not recognised)\n'));
    });

    test('probes skipped after a time-out are named as not run', () => {
      const probed = idris2Probed();
      assert.ok(probed.status === 'probed');
      const info = {
        ...probed.info,
        ttcVersion: undefined,
        pathsText: undefined,
        packages: undefined,
        notRun: { after: ['--ttc-version'], probes: [['--paths'], ['--list-packages']] },
      };
      const text = renderSetupInformation(input({ snapshot: snapshot({ idris2: { ...probed, info } }) }));
      assert.ok(text.includes('- TTC version: unknown (the probe failed or its output was not recognised)\n'));
      assert.ok(text.includes('- Paths (`--paths`): unknown (not run: `idris2 --ttc-version` timed out before it)\n'));
      assert.ok(text.includes('- Installed packages (`--list-packages`): unknown (not run: `idris2 --ttc-version` timed out before it)\n'));
    });

    test('a -dev tag is shown, and probe output containing backticks gets a longer fence', () => {
      const probed = idris2Probed('0.8.0-1c630e6a2');
      assert.ok(probed.status === 'probed');
      const tricky = { ...probed, info: { ...probed.info, probes: [probe(['--paths'], 'a ``` b\n````\n')] } };
      const text = renderSetupInformation(input({ snapshot: snapshot({ idris2: tricky }) }));
      assert.ok(text.includes('- Version: `0.8.0-1c630e6a2` (major 0, minor 8, patch 0, tag `1c630e6a2`)'));
      assert.ok(text.includes('stdout:\n\n`````text\na ``` b\n````\n`````\n'));
    });

    test('inline code survives backticks and surrounding spaces in the value (CommonMark code spans)', () => {
      const probed = idris2Probed();
      assert.ok(probed.status === 'probed');
      const at = (path: string) =>
        renderSetupInformation(input({ snapshot: snapshot({ idris2: { ...probed, location: { ...probed.location, path } } }) }));
      // A delimiter one backtick longer than the longest run inside, padded with a space.
      assert.ok(at('/a``b/idris2').includes('- Path: ``` /a``b/idris2 ```\n'));
      assert.ok(at('/a`b/idris2').includes('- Path: `` /a`b/idris2 ``\n'));
      assert.ok(at('`/x/idris2').includes('- Path: `` `/x/idris2 ``\n'));
      // A space at both ends would be stripped once, so one more is added on each side.
      assert.ok(at(' /x/idris2 ').includes('- Path: `  /x/idris2  `\n'));
      assert.ok(at('/x/idris2').includes('- Path: `/x/idris2`\n'));
    });

    test('a probe that could not start, timed out, or was killed says so instead of an exit code', () => {
      const failed = {
        status: 'failed' as const,
        location: { kind: 'idris2' as const, path: '/x/idris2', source: 'setting' as const, detail: 'idris2.toolchain.idris2Path', inPackDirectory: false },
        reason: 'idris2 --version could not be started.',
        probes: [
          { args: ['--version'], result: { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'EACCES', durationMs: 1 } },
          { args: ['--version'], result: { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true, durationMs: 5000 } },
          { args: ['--version'], result: { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: 'x', timedOut: false, durationMs: 3 } },
        ],
      };
      const text = renderSetupInformation(input({ snapshot: snapshot({ idris2: failed }) }));
      assert.ok(text.includes('- Found by: setting — idris2.toolchain.idris2Path\n- Failed: idris2 --version could not be started.\n'));
      assert.ok(text.includes('could not be started: EACCES, 1 ms'));
      assert.ok(text.includes('killed after the time limit, 5000 ms'));
      assert.ok(text.includes('ended by signal SIGKILL, 3 ms'));
    });

    test('missing tools list the places searched, in order', () => {
      const text = renderSetupInformation(input({ snapshot: snapshot({ idris2: missing('Not on PATH.') }) }));
      assert.ok(text.includes('## idris2\n\n- Not found. Not on PATH.\n- Searched, in order:\n  - `PATH entry /usr/bin`\n  - `/opt/homebrew/bin/idris2`\n'));
    });

    test('idris2-lsp versions, pack layout and the verdict with its reason', () => {
      const text = renderSetupInformation(
        input({
          snapshot: snapshot({
            lsp: lspProbed('0.8.0-1c630e6a2'),
            pack: packFound(),
            verdict: { kind: 'likelyMismatch', reason: 'The server was built for 0.8.0-1c630e6a2, the compiler is 0.8.0.' },
          }),
        }),
      );
      assert.ok(text.includes(`## idris2-lsp\n\n- Path: \`${LSP_PATH}\``));
      assert.ok(text.includes('- API line: `Idris2 API: 0.8.0-1c630e6a2`\n- Idris2 API version: not recognised\n'));
      assert.ok(text.includes('### `idris2-lsp --version`'));
      assert.ok(text.includes('- Current collection: `nightly-260924`\n'));
      assert.ok(text.includes('- Collection bin directory: `/home/u/.local/state/pack/install/nightly-260924/bin`\n'));
      assert.ok(text.includes("## pack\n\n- Path: `/home/u/.local/bin/pack`\n- Found by: pack — pack wrapper directory ~/.local/bin\n- In one of pack's directories\n"));
      assert.ok(text.includes('**likelyMismatch**: The server was built for 0.8.0-1c630e6a2, the compiler is 0.8.0.'));
      assert.ok(renderSetupInformation(input()).includes('No idris2-lsp was found, so there is no pair to judge.'));
    });

    test('settings as the scan used them, including ignored env entries', () => {
      const text = renderSetupInformation(
        input({
          snapshot: snapshot({
            settings: {
              idris2Path: '/x/idris2',
              lspPath: '',
              packPath: '',
              preferPack: true,
              env: { IDRIS2_PREFIX: '/opt/i' },
              ignoredEnvEntries: [{ key: 'A=B', reason: 'the name contains "="' }],
            },
          }),
        }),
      );
      assert.ok(text.includes('- idris2Path: `/x/idris2`\n- lspPath: (empty: discover)\n'));
      assert.ok(text.includes('- preferPack: true\n- env: `IDRIS2_PREFIX=/opt/i`\n- env entry `A=B` ignored: the name contains "="\n'));
    });

    test('env: values only of the path variables, credentials in their URLs masked; neither the document nor the issue body has a secret', () => {
      const env = {
        PATH: '/opt/bin:/usr/bin',
        Path: 'C:\\bin',
        IDRIS2_PACKAGE_PATH: '/opt/p',
        XDG_STATE_HOME: '/s',
        PACK_MIRROR: 'https://me:pw-in-url@mirror.example/db',
        CHEZ: '/usr/bin/scheme',
        HTTPS_PROXY: 'http://me:s3cret@proxy:8080',
        GITHUB_TOKEN: 'ghp_token',
        MY_IDRIS2_KEY: 'k3y',
        // A URL parser takes the user information up to the last `@`; a raw `/` in a password.
        IDRIS2_X: 'http://user:p@ss-at@proxy:8080',
        PACK_X: 'http://user:pa/ss-slash@proxy',
      };
      const text = renderSetupInformation(input({ snapshot: snapshot({ settings: { ...SETTINGS, env } }) }));
      assert.ok(
        text.includes(
          '- env: `PATH=/opt/bin:/usr/bin`, `Path=C:\\bin`, `IDRIS2_PACKAGE_PATH=/opt/p`, `XDG_STATE_HOME=/s`, ' +
            '`PACK_MIRROR=https://…@mirror.example/db`, `CHEZ=/usr/bin/scheme`, `HTTPS_PROXY` (value not shown, 27 characters), ' +
            '`GITHUB_TOKEN` (value not shown, 9 characters), `MY_IDRIS2_KEY` (value not shown, 3 characters), ' +
            '`IDRIS2_X=http://…@proxy:8080`, `PACK_X=http://…@proxy`\n',
        ),
        text,
      );
      for (const secret of ['s3cret', 'ghp_token', 'k3y', 'pw-in-url', 'ss-at', 'ss-slash']) {
        assert.ok(!text.includes(secret), secret);
        assert.ok(!issueBody(text).includes(secret), secret);
      }
      assert.ok(text.includes('review it before sharing it'));
    });

    test('pack without an absolute HOME: no directories, as pack has none', () => {
      const found = packFound();
      assert.ok(found.status === 'found');
      const text = renderSetupInformation(
        input({ snapshot: snapshot({ pack: { ...found, info: { ...found.info, configDir: undefined, stateDir: undefined } } }) }),
      );
      const none = 'none: `HOME` is not an absolute path, and pack then stops with its NoPackDir error';
      assert.ok(text.includes(`- Configuration directory: ${none}\n`));
      assert.ok(text.includes(`- State directory: ${none}\n`));
    });

    test('a tool in the bin directory of a pack collection says so', () => {
      const lsp = lspProbed('0.8.0');
      assert.ok(lsp.status === 'probed');
      const inCollection = { ...lsp, location: { ...lsp.location, inPackDirectory: true, packCollection: 'nightly-260924' } };
      const text = renderSetupInformation(input({ snapshot: snapshot({ lsp: inCollection }) }));
      assert.ok(text.includes("- In one of pack's directories: the bin directory of collection `nightly-260924`\n"));
    });

    test('Restricted Mode: said at the top, and a located tool is marked as not run', () => {
      const text = renderSetupInformation(
        input({
          trusted: false,
          snapshot: snapshot({ trusted: false, idris2: { status: 'located', location: location('idris2', IDRIS2_PATH) } }),
        }),
      );
      assert.ok(text.includes('- Workspace trust: not trusted — Restricted Mode: no program is run, so nothing below was run\n'));
      assert.ok(text.includes('- Not run: the workspace is not trusted (Restricted Mode).'));
    });

    test('before the first scan finishes there is no toolchain section yet', () => {
      const text = renderSetupInformation(input({ snapshot: undefined, scanning: true }));
      assert.ok(text.includes('## Toolchain\n\nThe first scan is still running.\n'));
      assert.ok(!text.includes('## idris2\n'));
    });

    test('projects: the model and where it came from, parse errors with their range, several .ipkg files', () => {
      const ok = projectRoot({
        model: {
          status: 'ok',
          source: 'dump-json',
          model: {
            name: 'simple-ipkg',
            version: '0.1.0',
            depends: [
              { name: 'contrib', bounds: { lower: undefined, lowerInclusive: true, upper: undefined, upperInclusive: true } },
              { name: 'base', bounds: { lower: '0.6.0', lowerInclusive: true, upper: '0.9', upperInclusive: false } },
            ],
            modules: ['Foo.A', 'Foo.B'],
            sourcedir: 'src',
          },
        },
      });
      const broken = projectRoot({
        ipkgPath: '/w/bad/bad.ipkg',
        dir: '/w/bad',
        otherIpkgs: ['/w/bad/other.ipkg'],
        model: {
          status: 'error',
          source: 'fallback',
          error: { message: 'Unrecognised property "pkgs".', range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 5 } },
        },
      });
      const text = renderSetupInformation(input({ projects: [ok, broken] }));
      assert.ok(text.includes('### `/w/simple-ipkg/simple-ipkg.ipkg`\n\n- Directory (the working directory of its sessions): `/w/simple-ipkg`\n'));
      assert.ok(text.includes('- Model read by the compiler (`idris2 --dump-ipkg-json`):\n  - package: `simple-ipkg` 0.1.0\n  - sourcedir: `src`\n  - builddir: (not set)\n'));
      assert.ok(text.includes('  - depends: `contrib`, `base` >= 0.6.0 && < 0.9\n  - modules: `Foo.A`, `Foo.B`\n'));
      assert.ok(text.includes('- **Other .ipkg files in this directory:** `/w/bad/other.ipkg`.'));
      assert.ok(text.includes('- Could not be read at 3:1--3:5, read by the built-in fallback reader (limited):\n\n```text\nUnrecognised property "pkgs".\n```'));
      assert.ok(renderSetupInformation(input()).includes('No .ipkg file inside the workspace folders.'));
    });

    test('the active document: its root, module name and session directory', () => {
      const text = renderSetupInformation(
        input({
          activeDocument: { path: '/w/simple-ipkg/src/Foo/B.idr', classification: projectRoot(), moduleName: 'Foo.B', sessionCwd: '/w/simple-ipkg' },
        }),
      );
      assert.ok(
        text.includes(
          '- `/w/simple-ipkg/src/Foo/B.idr`\n- Belongs to: project `/w/simple-ipkg/simple-ipkg.ipkg`\n- Module name: `Foo.B`\n- Session working directory: `/w/simple-ipkg`\n',
        ),
      );
      const loose = renderSetupInformation(input({ activeDocument: { path: '/w/loose-file/Hello.idr', classification: LOOSE, moduleName: 'Hello', sessionCwd: LOOSE.dir } }));
      assert.ok(loose.includes('- Belongs to: loose file (no .ipkg in `/w/loose-file` or above it)\n'));
    });

    test('a root outside the workspace folders says so, in the project list and for the active document', () => {
      const outside = projectRoot({ insideWorkspace: false, model: { ...projectRoot().model, source: 'fallback' } as ReturnType<typeof projectRoot>['model'] });
      const text = renderSetupInformation(
        input({
          projects: [outside],
          activeDocument: { path: '/w/simple-ipkg/src/Foo/B.idr', classification: outside, moduleName: 'Foo.B', sessionCwd: '/w/simple-ipkg' },
        }),
      );
      const reason = 'outside the workspace folders, so it is read by the built-in reader, not the compiler (workspace trust does not cover the folders above)';
      assert.ok(text.includes(`- Directory (the working directory of its sessions): \`/w/simple-ipkg\`\n- The .ipkg lies ${reason}.\n`), text);
      assert.ok(text.includes(`- Belongs to: project \`/w/simple-ipkg/simple-ipkg.ipkg\`, ${reason}\n`), text);
      assert.ok(!renderSetupInformation(input({ projects: [projectRoot()] })).includes('outside the workspace folders'));
    });

    test('issueBody puts the document into a collapsed section under an empty description', () => {
      const body = issueBody('# Idris 2: Setup Information\n');
      assert.ok(body.startsWith('<!-- What did you do'));
      assert.ok(body.includes('<details>\n<summary>Setup Information</summary>\n\n# Idris 2: Setup Information\n\n</details>'));
    });
  });

  suite('registerSetupInformation (against a fake VS Code API)', () => {
    function setup(reporter: (args: unknown) => Promise<unknown>) {
      const commands = new Map<string, () => Promise<unknown>>();
      const clipboard: string[] = [];
      const opened: string[] = [];
      const messages: string[] = [];
      let provider: { provideTextDocumentContent(): Promise<string> } | undefined;
      const toolchain = new FakeToolchain(snapshot());
      const api = {
        Uri: {
          from: (parts: { scheme: string; path: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }),
          parse: (value: string) => ({ value }),
        },
        EventEmitter: Emitter,
        version: '1.139.1',
        env: {
          appName: 'Visual Studio Code',
          remoteName: undefined,
          clipboard: { writeText: (text: string) => Promise.resolve(void clipboard.push(text)) },
          openExternal: (uri: { value: string }) => Promise.resolve(opened.push(uri.value) > 0),
        },
        window: {
          activeTextEditor: {
            document: { languageId: 'idris2', fileName: '/w/loose-file/Hello.idr', isUntitled: false, uri: { scheme: 'file', fsPath: '/w/loose-file/Hello.idr' } },
          },
          onDidChangeActiveTextEditor: new Emitter<void>().event,
          showInformationMessage: (message: string, ...items: string[]) => Promise.resolve(void messages.push(message)).then(() => items[0]),
          showTextDocument: () => Promise.resolve(),
        },
        workspace: {
          registerTextDocumentContentProvider: (_scheme: string, p: typeof provider) => {
            provider = p;
            return { dispose: () => undefined };
          },
          openTextDocument: () => Promise.resolve({}),
        },
        commands: {
          registerCommand: (id: string, run: () => Promise<unknown>) => {
            commands.set(id, run);
            return { dispose: () => commands.delete(id) };
          },
          executeCommand: (id: string, args: unknown) => (id === 'vscode.openIssueReporter' ? reporter(args) : Promise.resolve()),
        },
      } as unknown as SetupApi;
      const classify = (): Promise<Classification> => Promise.resolve(LOOSE);
      const setupInformation = registerSetupInformation(api, {
        toolchain,
        projects: {
          roots: () => Promise.resolve([]),
          classify,
          pathToModule: () => 'Hello',
          sessionCwd: (c) => c.dir,
          onDidChange: new Emitter<void>().event,
        },
        trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
        extension: { id: 'etairi.vscode-idris2', version: '0.0.1', issuesUrl: 'https://github.com/etairi/vscode-idris2/issues' },
        os: { platform: 'darwin', release: '25.0.0', arch: 'arm64', nodeVersion: 'v22.20.0' },
        log: { trace: () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      return { commands, clipboard, opened, messages, toolchain, setupInformation, provider: () => provider };
    }

    test('the provider renders the current snapshot and the active document; Rescan Toolchain rescans', async () => {
      const t = setup(() => Promise.resolve());
      const text = await t.provider()?.provideTextDocumentContent();
      assert.ok(text?.includes('- Version line: `Idris 2, version 0.8.0`'));
      assert.ok(text?.includes('- `/w/loose-file/Hello.idr`\n- Belongs to: loose file'));
      await t.commands.get('idris2.rescanToolchain')?.();
      assert.deepStrictEqual(t.toolchain.rescans, ['command']);
      assert.ok((await t.setupInformation.render()).includes('- Scan #2 (command)'));
    });

    test('Report Issue… hands the extension id and the Setup Information to the issue reporter', async () => {
      const calls: unknown[] = [];
      const t = setup((args) => Promise.resolve(void calls.push(args)));
      await t.commands.get('idris2.reportIssue')?.();
      assert.strictEqual(calls.length, 1);
      const { extensionId, issueBody: body } = calls[0] as { extensionId: string; issueBody: string };
      assert.strictEqual(extensionId, 'etairi.vscode-idris2');
      assert.ok(body.includes('<summary>Setup Information</summary>'));
      assert.ok(body.includes('- Version line: `Idris 2, version 0.8.0`'));
      assert.deepStrictEqual(t.clipboard, []);
    });

    test('without the issue reporter the report goes to the clipboard, and the issues page opens on request', async () => {
      const t = setup(() => Promise.reject(new Error("command 'vscode.openIssueReporter' not found")));
      await t.commands.get('idris2.reportIssue')?.();
      assert.strictEqual(t.clipboard.length, 1);
      assert.ok(t.clipboard[0].includes('<summary>Setup Information</summary>'));
      assert.match(t.messages[0], /copied to the clipboard/);
      assert.deepStrictEqual(t.opened, ['https://github.com/etairi/vscode-idris2/issues']);
    });
  });
});
