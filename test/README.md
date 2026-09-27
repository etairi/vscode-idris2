# `test/` layout

The testing layers of `docs/ARCHITECTURE.md` §12 and the `test/` tree of §2, annotated with the
milestone (`docs/ROADMAP.md` §5) that adds each part. Parts marked **M0**, **M1** or
**skeleton** exist.

| Layer | Runner | Needs | Exists | Added by |
|---|---|---|---|---|
| Unit | mocha on Node, `npm run test:unit` | nothing (Node spawns the fake tools and `/bin/sh`) | **M0**, **M1** (lists below) | decoders, `IdeSession`/`FakeTransport`: M2, M9 (CLI parser), M11, M13 |
| Grammar | `vscode-textmate` + `vscode-oniguruma` snapshots, `npm run test:grammar` | nothing | **M0** (`grammar/`, harness `grammar/harness.ts`) | injections: M12 |
| Integration | `@vscode/test-cli` (Electron), `npm test`, one suite per fixture workspace | VS Code download | **M0** (suite `integration` on `fixtures/workspaces/loose-file`), **M1** (the same suite with the fake tools; suites `simple-ipkg` and `toolchain-path`) | fake compiler / fake LSP driven suites: M2, M5 and every UI milestone |
| E2E | same runner, `npm run test:e2e` (suite `e2e`, only with `IDRIS2_E2E=1` or that script) | real `idris2` (+ `idris2-lsp`) | **M1** (`e2e/`, on `fixtures/workspaces/simple-ipkg`) | every milestone adds at least one |
| Contract | mocha suite parameterised over backends | as above | no | whichever of M4/M5 ships second |
| Manual | `docs/checklists/Mn.md` | — | **M0**, **M1** (`docs/checklists/M0.md`, `M1.md`) | each milestone |

```
test/
├─ unit/                      M0        mocha on Node, no vscode import allowed
├─ grammar/                   M0        TextMate tests: harness.ts, idris2/lidr/ipkg tests, snapshots/,
│                                       corpus.test.ts (npm run test:corpus), perf.test.ts,
│                                       idris2-scopes.md (scope inventory + limits, kept in sync by a test)
├─ corpus/                    M0        corpus.json (pinned repositories, fetched into .corpus/),
│                                       lexer-oracle/LexDump.idr (the 0.8.0 lexer as reference)
├─ integration/               M0, M1    @vscode/test-cli suites per fixture workspace: the top-level
│                                       *.test.ts (suite integration), simple-ipkg/, path/
│                                       (suite toolchain-path); support.ts is their shared helper
├─ e2e/                       M1        real idris2 (IDRIS2_E2E=1); M2 adds IDRIS2_RECORD=1 transcript refresh
├─ fake-idris2/               M0 (handshake + :version), M1 (recorded --ttc-version, --paths,
│                                       --list-packages, --dump-ipkg-json), M2 (transcript replay
│                                       over stdio + socket)
├─ fake-tools/                M1        launchers (sh + .cmd) of the fake idris2, idris2-lsp
│                                       (--version) and pack; fault modes; simulated pack layouts
├─ fake-lsp/                  M5        Node script (vscode-languageserver) replaying JSON-RPC
└─ fixtures/
   ├─ transcripts/<idris2-version>/*.jsonl   M2   recorded IDE-mode sessions
   ├─ cli/<idris2-version>/*.txt              M9   recorded --check/--build output
   ├─ ipkg/                                   M1   package files of the ipkg reader tests, each with
   │                                                its --dump-ipkg-json output recorded in
   │                                                unit/support/ipkgRecordings.ts; *.invalid.ipkg
   │                                                are skipped by check:fixtures
   ├─ grammar/*.idr, *.lidr, *.ipkg           M0   tokenisation fixtures (npm run check:fixtures:
   │                                                idris2 --check / --dump-ipkg-json); ipkg-sources/
   │                                                holds the prose-only modules the .ipkg fixtures
   │                                                list; NOTICE.md attributes the excerpts
   └─ workspaces/
      ├─ loose-file/          M0        no ipkg; checked with idris2 0.8.0 (`--check`, exit 0):
      │                                 Hello.idr (imports Data.Vect), Vlen.idr (the selection-range
      │                                 example), Lit.lidr (bird tracks with prose); Notes.md (plain
      │                                 Markdown, the non-Idris document); Doc.idr.md (M1: literate
      │                                 Markdown with a double extension, selected in the Markdown mode)
      ├─ simple-ipkg/         M1        sourcedir = "src", depends = contrib, modules Foo.A and Foo.B
      │                                 (B imports A; A does not import contrib, since check:fixtures
      │                                 checks each file without package flags; M2 adds the load test)
      ├─ multi-module/        M9        one error in src/Sub.idr (build-task acceptance; no earlier suite needs it)
      ├─ broken/              M2, M4    type + coverage errors; Clean.idr, Plain.idr, Ambig.idr
      ├─ literate/            M3 (Lit.lidr), M4 (Lit2.lidr), M12 (Lit3.lidr and the .md, .tex, .org, .typ hosts)
      └─ golden-tests/        M10       Test.Golden layout
```

ARCHITECTURE §12 lists the fixture workspaces and recorded fixtures without milestones; the
milestones given for them above are inferred from the first suite that needs each one
(ROADMAP §5) and may move.

## Unit tests of the M0 code (`unit/`)

- `positions.test.ts` — `core/positions.ts`: every F2 and F11 example of ROADMAP §0 literally
  (the test names cite them), the `:case-split` column base, and CLI columns in `.lidr`.
- `literate.test.ts` — `project/literate.ts`: the selector table, `birdPrefixWidth`, and the
  `idris2.isIdrisDocument` tracker against a fake editor surface (including that disposing it
  resets a true key to false once).
- `nullBackend.test.ts`, `errors.test.ts` — `backend/null.ts`, `core/errors.ts`.
- `syntaxLexer.test.ts`, `selectionRangeModel.test.ts` — `features/syntax/`: lexer rules (each
  surprising one was confirmed with `idris2 --check`), selection chains (including empty,
  whitespace-only and CRLF texts, where the chain is never empty), and a check over every
  offset of several texts that each range contains the previous one.
- `disposable.test.ts` — `core/disposable.ts`.
- `languageConfiguration.test.ts` — `language-configuration/*.json`: runs
  `scripts/build-language-configuration.mjs --check`, compiles every regex as VS Code does,
  and replays tables of Enter and word cases whose expected values were observed in VS Code
  1.139.1.
- `snippets.test.ts` — `snippets/*.json`: shape, prefixes, tab stops. That the expansions are
  valid Idris is checked by `npm run check:fixtures` (it needs the compiler).
- `fakeIdris2.test.ts` — `fake-idris2/fake-idris2.mjs` against replies recorded from the real
  compiler (handshake, `version`, unknown commands, framing, and the end-of-input rules: when
  it exits silently with 0 and when it prints `Alas…` and exits 1), over stdio and TCP.

## Unit tests of the M1 code (`unit/`)

Every module below has no runtime `vscode` import; the UI modules take the `vscode` namespace as
a parameter and are tested against a fake of it. `support/toolchainFixtures.ts` builds
snapshots and project roots and a fake `ToolchainService` for them.

- `config.test.ts`, `event.test.ts` — `core/config.ts` (validation, `~` expansion, no expansion
  without a usable home directory, one pair of surrounding quotes removed, change events per
  group) and `core/event.ts` (snapshot
  rounds, errors, dispose); compile-time checks that `vscode.workspace`, `vscode.Event` and
  `vscode.LogOutputChannel` fit the interfaces.
- `manifest.test.ts` — `package.json`'s M1 contributions: every setting's type, default, scope
  and description; `core/config.ts` reads exactly the contributed keys; Restricted Mode
  (`"limited"`, the restricted settings); commands, menus, `when` clauses (only the context keys
  the extension sets), the submenu listing every command once; the walkthrough's pages and links.
- `process.test.ts` — `core/process.ts` with real child processes: output and exit codes,
  arguments passed without a shell, the environment overlay, the working directory, stdin at
  end of file, spawn errors, the output limit, termination (time limit, the process group,
  SIGKILL escalation, a grandchild holding the pipes, and a program that ignores SIGTERM after
  its `sh` wrapper died on it, the shape of the idris2 launchers), the trust gate, one process at
  a time in call order, `dispose()` (the running process killed at once, without a grace period
  and without a log line, queued and later requests rejected); `cmd.exe` quoting, the choice of `cmd.exe` and the batch-file test
  as strings everywhere, and on Windows only a real `.cmd` round trip and a timed-out `.cmd`
  stopped together with its child (`taskkill /T`).
- `toolchainDiscover.test.ts`, `toolchainPack.test.ts` — the search over an in-memory file system
  (POSIX and Windows layouts, `PATHEXT`, also for an absolute Windows path without an extension,
  `preferPack`, the setting's no-fallback rule, pack's directories recognised whichever step
  finds a tool in them, no home directory, candidates that exist but cannot be run named in the
  reason) and pack's
  directories and collection (defaults, `XDG_*`, `PACK_*`, the state file winning over the
  global `pack.toml`, a FIFO named `pack.toml`, no home directory) in temporary directories.
- `toolchainVersions.test.ts`, `toolchainVerdict.test.ts` — the parsers on the outputs of the
  Homebrew 0.8.0 build recorded on 2026-09-27 (`--version`, `--ttc-version`, `--paths`,
  `--list-packages`, also with a local `depends/`) and on synthetic variants (tags, `-dev`,
  CRLF, idris2-lsp's two lines and its `Invalid Arguments`); the verdict table.
- `toolchainService.test.ts` — scans against a fake runner: probe order, Restricted Mode
  (located, nothing run), trust granted, failures, the settings' environment, pack; scheduling
  (one queued scan shared by requests during a scan, events, dispose: no probe starts after it).
- `ipkg.test.ts`, `projectIndex.test.ts` — `project/ipkg.ts` and `project/index.ts` against the
  compiler output recorded in `support/ipkgRecordings.ts` (12 fixture files and 16 texts,
  `idris2 --dump-ipkg-json <name>` in the file's directory, one process at a time, and the same
  byte for byte when run as the extension runs it, with the absolute path; each fixture
  recording carries its SHA-256, and a test fails when a package file under `fixtures/ipkg` or
  `simple-ipkg` has no recording or has changed — re-record it then, as the file's header says):
  the walk (listing order, stopping rules), the dump parser (raw strings, warnings before the
  JSON, errors with ranges), the fallback reader against every recording (byte-order marks and
  NULs read as the compiler reads them), long and pathological block comments (no stack limit,
  a comment that fails late read in polynomial time, the work limit), which package files are
  read at all (a directory, a file over 256 KiB, a FIFO, a link to `/dev/zero`: refused without
  running the compiler), classification (a root outside the workspace folders is read without
  the compiler), caching and invalidation (the workspace folders, a changed `.ipkg` dropping
  only its model, the snapshot's environment, created and deleted paths: module files, a folder
  moved in or deleted and reported alone, `main`, build output changing nothing, a package
  folder renamed on disk; dispose; one root for two spellings on Windows), `roots()` (read when
  asked for), and the module ↔ path mapping.
- `literate.test.ts` (M1 part) — the compiler's literate table, `splitFileExtensions`,
  `isIdrisSourceFileName`, and the double-extension rows, matched as VS Code matches a
  `**/*.<ext>` pattern (case-sensitive `endsWith` on the path).
- `backendRegistry.test.ts`, `statusItem.test.ts`, `setupInformation.test.ts`,
  `notifications.test.ts`, `installCommands.test.ts` — the registry's labels; the status texts,
  the QuickPick (the submenu's entries, read from the real `package.json`, in the order of VS
  Code's `compareMenuItems`), the logged status changes and `idris2.packFound`, the previous
  file's package never shown for a newly active file; the Setup Information text (inline code
  around backticks) and Report Issue… (with and without the issue reporter;
  `idris2.toolchain.env` values only of path variables, URL credentials masked up to the last
  `@`, so that no secret reaches either); the once-per-condition notices; the install actions,
  the POSIX quoting of the pack path (checked by `/bin/sh`), PowerShell's quote characters, a
  pack path with a control character (or, on POSIX, a backslash) refused, that the text is
  typed with no line break, and that every terminal starts in the home directory (none without
  one).
- `fakeTools.test.ts` — `fake-tools/`: each launcher runs its tool's script (shell script
  with the executable bit, `.cmd` shim); the fake compiler's recorded probes, including that
  every `--dump-ipkg-json` recording still matches its fixture's bytes; the fake idris2-lsp and
  pack; the fault modes; and the simulated pack layouts (skipped on Windows), including that
  running pack's `idris2` wrapper runs pack.

## E2E suite (`e2e/`, M1)

Runs with `npm run test:e2e` (the `e2e` suite of `.vscode-test.mjs`, workspace
`fixtures/workspaces/simple-ipkg`, no toolchain settings) against the `idris2` on `PATH`; the
macOS CI job runs it after `brew install idris2`. It reads the extension's state through the test
API that `activate()` returns in `ExtensionMode.Test` (`src/extension.ts`), and compares it with
what the real compiler prints **in the same run** (shapes, not the literal 0.8.0):

- `toolchain.test.ts` — the `idris2` found is the first on `PATH` (else a well-known directory);
  its parsed version and TTC version equal `--version` / `--ttc-version`; `--paths` and
  `--list-packages` were read; `src/Foo/B.idr` belongs to the `simple.ipkg` root, whose model
  comes from `--dump-ipkg-json` (sourcedir `src`, depends `contrib`, the same modules the
  compiler prints) and whose session directory is the ipkg directory; Show Setup Information
  shows the version line and TTC version. Before a test runs the real compiler itself it waits
  until the extension is idle (`helpers.ts` `extensionIdle`: no scan running, and the model read
  with `--dump-ipkg-json` for the current snapshot), so that two `idris2` processes never run at
  once.
- `install.test.ts` — Install Idris 2… (macOS only; elsewhere it opens a browser), Install pack…
  and Install or Update idris2-lsp with pack (with `idris2.toolchain.packPath` set to the fake
  pack) each type their exact command into a terminal and send no line break; the last one's
  terminal starts in the home directory. The default terminal profile is the integration
  suite's terminal recorder (`integration/terminalRecorder.ts`), which records the bytes the
  terminal sends instead of running a shell, so nothing can be executed even by a
  regression.

## Grammar tests (`grammar/`)

- `harness.ts` loads the grammars through `package.json` (so the manifest wiring is tested
  too) with `vscode-textmate` and `vscode-oniguruma` at the versions VS Code 1.139.1 ships.
- `idris2.test.ts` — `scripts/build-grammar.mjs --check`; every include resolves and every rule
  is used; every regex compiles; the scope inventory matches `idris2-scopes.md`; one snapshot
  per `.idr` fixture with the root end state and no `invalid` scope; targeted assertions for
  each M0 construct and for the lexer's surprising rules (each confirmed with `idris2 --check`).
- `lidr.test.ts`, `ipkg.test.ts` — line classification after the compiler's unlit step, state
  carried across bird-track lines, every `.ipkg` field and the comment automaton; snapshots
  (the `.lidr` ones also with no `invalid` scope). `lidr.test.ts` also converts every `.idr`
  fixture to bird-track code and requires the same tokens as in the `.idr` file
  (`harness.ts` `birdTrackDifferences`). It does this a second time with a prose line after
  every code line, where the code must tokenise like the `.idr` file with an empty line at
  each prose line (the compiler's unlit step turns prose into empty lines).
- `perf.test.ts` — median of five tokenisations of the `.idr` fixtures, concatenated and
  repeated to at least 2,000 lines (2,372 with the final M0 fixtures, 2026-09-27); logs the time,
  and asserts a 300 ms budget: twice the slowest CI median (ROADMAP E6).
- `corpus.test.ts` — not part of `test:grammar`; `npm run test:corpus` fetches the corpora and
  tokenises every file (no `invalid` scope, root end state except the files listed in
  `corpus.json`), then checks that every corpus `.idr` file tokenises the same as bird-track
  code (`birdTrackDifferences`). With `IDRIS2_LEXER_ORACLE=1` it builds `corpus/lexer-oracle/LexDump.idr`
  against the installed compiler and checks each lexer token's scope.
- Snapshots: `UPDATE_SNAPSHOTS=1 npm run test:grammar` rewrites them; review the diff before
  committing, never regenerate blindly.

## Integration suite (`integration/`)

- `activation.test.ts` holds **root-level** `suiteSetup`/`suiteTeardown` hooks. `@vscode/test-cli`
  gathers files with `glob`, whose order is not sorted, so the activation measurement cannot rely
  on running first as a test; a root hook runs before every suite whatever the file order. It
  asserts that the extension is inactive, opens `Hello.idr`, waits (deadline 10 s) for it to
  become active through `onLanguage:idris2`, and prints the elapsed time as
  `[activation] openTextDocument(Hello.idr) → extension active: N ms`; the test asserts
  N < 250 ms, or N < 1,000 ms when `CI` is set (the bounds and their justification are in the
  file). The teardown closes all editors
  so that the next run does not restore an Idris editor from `.vscode-test/user-data`, which would
  activate the extension early and fail the "inactive until opened" test.
- `languages.test.ts` — language ids of `.idr`, `.lidr`, `.md` and a temporary `.ipkg` (written to
  the OS temp directory: an `.ipkg` in the workspace would trigger `workspaceContains:**/*.ipkg`),
  and the `configurationDefaults` for `[idris2]`/`[lidr]` (`inspect().defaultLanguageValue`),
  including `files.eol` for `[lidr]` only.
- `documents.test.ts` — `isIdrisDocument` and `idrisDocumentSelector()` (through
  `vscode.languages.match`) on real documents, including (M1) `Doc.idr.md` in the Markdown
  mode, selected by a pattern row. The `idris2.isIdrisDocument` context key has no
  read-back API, so its logic is covered by the unit test only.
- `selectionRanges.test.ts` — `vscode.executeSelectionRangeProvider` on `Vlen.idr` (ROADMAP M0
  acceptance) and `Lit.lidr`. VS Code merges its own ranges (such as the whole line) into the
  chain, so the expected ranges are asserted in order, not as the complete chain.
- Help commands: all three are checked to be registered; Show Output and Open Settings are run.
  Open Idris 2 Documentation is not run, because it would open the system browser.
- `toolchainUi.test.ts` (M1, suite `integration`: the fake tools named in the user settings of
  `.vscode-test.mjs`) — the fakes are found and probed, the pair is compatible; the status item
  reads `Idris 2 0.8.0 · syntax only` and names the loose file; Show Setup Information shows
  paths, raw and parsed versions, the verdict and trust; every contributed command is
  registered; the status QuickPick equals the visible submenu entries; with `idris2Path` set to
  a missing file, one warning with Install Idris 2…, Set Path and Show Output, not repeated by a
  rescan, and everything else still works; a server with another API version
  (`FAKE_IDRIS2_LSP_API_VERSION`) is announced once; the install commands type their exact
  text, with no line break, into a terminal whose default profile is the terminal recorder
  (`terminalRecorder.ts`, below), started in the home directory with `idris2.toolchain.env` for
  the pack ones — Install or Update idris2-lsp on every platform, Windows included. Tests that
  change a setting restore it.
- `simple-ipkg/classification.test.ts` (M1, suite `simple-ipkg`, workspace folder
  `simple-ipkg/src`) — `Foo/B.idr` belongs to the `.ipkg` above the folder, the session
  directory is the `.ipkg`'s, the module is `Foo.B`, the model comes from the built-in reader
  because the `.ipkg` lies outside the folder (sourcedir `src`, depends `contrib`); `roots()` is
  empty while the status item and Setup Information name the root and say it lies outside.
- `path/discovery.test.ts` (M1, suite `toolchain-path`, no toolchain settings, the fake tools'
  directory prepended to `PATH`) — the three tools are found through `PATH`.
- `support.ts` — the test API, polling (`waitFor`, deadline 10 s), and setting a toolchain
  setting then waiting for the rescan it triggers.
- `terminalRecorder.ts`, `terminalRecorder.mjs` (M1, shared with the e2e suite) — make a Node
  script that records every byte a terminal sends it, and runs nothing, the default terminal
  profile (`terminal.integrated.profiles.<osx|linux|windows>`), then run a command and return
  what it typed once nothing more has arrived for 1.5 s. The profile is set once per suite, with
  one output file that each test deletes first: with a file per test, a terminal opened right
  after the profile changed wrote to the previous test's file (observed once in VS Code 1.139.1;
  see the comment in the file).
- `editor.test.ts` — Enter at the end of a line in untitled `idris2` and `lidr` editors, run
  through `editor.action.insertLineAfter`, which VS Code 1.139.1 implements with the same
  routine as a typed Enter. Like the `type` command, it goes to whichever code editor has text
  or widget focus; unlike `type`, it falls back to the active editor when no code editor has
  focus. Both that fallback and the `chat.disableAIFeatures` setting of `.vscode-test.mjs`,
  which keeps the chat input from holding the focus, are needed; the reasoning is in the file.
  `.lidr` code lines must continue the marker, which fails if the lidr grammar is mapped to
  the language `idris2` again. The suite also covers indentation folding of a `where` block
  (`editor.fold`, then `visibleRanges`; the blank line after the block stays visible only with
  `folding.offSide`), and Ctrl+D inside `?hole` and `x'` (the `editor.wordSeparators` default). VS Code loads a
  language configuration and computes folding ranges asynchronously, so the suite waits
  (deadline 10 s) until each language's Enter rules take effect, and retries the fold.

Conventions already in force:

- mocha's `tdd` interface (`suite` / `test`) everywhere, both on Node and in the Extension Host.
- Unit tests import from `../../src/...` and must not import `vscode`.
- Tests are compiled by `tsc` into `out/` (`npm run compile-tests`); `.vscode-test.mjs` and
  `test:unit` run the compiled `.js` files.
- `.vscode-test.mjs` gives each suite its own profile (`.vscode-test/user-data`,
  `user-data-ipkg`, `user-data-path`, `user-data-e2e`), rewritten before every run so that
  settings a test changes never leak into another suite, and fails early if a profile's IPC
  socket path would reach the 103-character limit (F17 in `docs/ROADMAP.md` §0); the
  protection is the short checkout path. It also passes `--force-disable-user-env`, so the
  Extension Host sees the suite's environment rather than the developer's login-shell `PATH`
  (without it the `toolchain-path` suite did not see the prepended fake-tools directory,
  observed 2026-09-27).
- `.vscode-test.mjs` also writes `{"chat.disableAIFeatures": true}` to each profile's
  `User/settings.json` before each run. The chat input VS Code 1.139.1 builds at startup is a
  code editor, and when the test window starts without OS focus it kept the editor focus, so
  editor commands went to it and the Enter tests failed (observed 2026-09-27; see the comment
  in the file).
- No test may depend on a wall-clock timeout below 1 s (ARCHITECTURE §12). The one deliberate
  exception is the activation bound of 250 ms on the development machine (1,000 ms under CI),
  which the M0 acceptance calls for.
