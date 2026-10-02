# CLAUDE.md — vscode-idris2

Guidance for Claude Code when working in this repository (a VS Code extension for Idris 2).

## Where things are decided

- `docs/ROADMAP.md` — milestones M0–M16, the verified facts F1–F36 (§0), open questions (§9).
  **Features are implemented in the milestone that owns them, with the scope written there.**
  Do not pull a later milestone's feature forward, and do not stub it with an empty module:
  placeholders for future parts are the README files in `src/` and `test/`. M0 is implemented
  and accepted (2026-09-27, `docs/as-built/M0.md`); M1 is implemented (2026-09-27,
  `docs/as-built/M1.md`, which lists its deviations from the M1 text); M2 is implemented
  (2026-09-28, `docs/as-built/M2.md`, likewise); M3 is implemented (2026-09-29, commits `04e96aa`
  and `263f38f`, `docs/as-built/M3.md`, likewise); M4 is implemented for IDE mode (2026-10-01,
  commit `982d2fc`, `docs/as-built/M4.md`, likewise; its LSP half — `LspBackend.edit()`,
  `holes()` and the contract suite — is owned by M5, which ships second). The one planned stub is M0's
  `src/webview/goalPanel.ts` (an empty second esbuild entry, ROADMAP M0 "Out"), which M7
  replaces.
- `docs/as-built/` — what was built: one file per finished milestone (`M0.md` … `M4.md`) with
  its deviations from ROADMAP §5 and ARCHITECTURE, measurements, experiments,
  review rounds and gate runs; `README.md` there explains the files and how to read their
  references. Moved out of ROADMAP and ARCHITECTURE on 2026-09-28 so that those two stay
  readable: **a finished milestone's record goes into a new `docs/as-built/Mn.md`**, and its
  ROADMAP §5 entry gets only a short Status entry (done, date, commits, CI run, link);
  ARCHITECTURE keeps the design, with a short "As built" pointer where the code refines a
  section. References take the form `docs/as-built/M2.md`, *Processes* (the entry's heading).
- `docs/ARCHITECTURE.md` — the technical design: repository layout (§2), the `IdrisBackend`
  interface (§3), sessions (§5), coordinates (§7), settings (§11), test layers (§12), build
  (§13), decisions D1–D22 (§14). New code goes where §2 puts it and follows its naming rules.
- `docs/landscape.md` — the survey the design rests on. Every fact in it and in the other two
  documents carries an **epistemic tag**; each document's legend is at its top
  (`landscape.md`: `[live]`, `[src]`, `[mkt]`, `[doc]`, `[untested]`; `ROADMAP.md`: `[live]`,
  `[src]`, `[doc]`, `[gh]`, `[open]`; `ARCHITECTURE.md` legend: `[live]`, `[src]`, `[doc]`,
  `[open]`, and it also uses `[gh]` inline; `docs/as-built/*` use ROADMAP's). When editing or
  quoting these documents, preserve the tags; when adding a fact, tag it the same way and say how it
  was verified. Never upgrade an `[open]`, `[untested]` or `[doc]` fact to `[live]` without
  actually running it.
- Decisions taken by the user on 2026-09-26 (recorded in `docs/ROADMAP.md` §9): MIT licence
  (`LICENSE`, copyright Erkan Tairi); repository `github.com/etairi/vscode-idris2`; publisher
  `etairi` (created by the user on the Marketplace; the first pre-release, 0.1.0, was published there
  by the user on 2026-10-01, tag `v0.1.0`, `CONTRIBUTING.md`, *Releasing*; not on Open VSX yet); language id `idris2` (the clashing
  `j-nava.idris2-language-support` was uninstalled from the user's VS Code); grammar written
  fresh, using existing grammars only as reference; implementation order M0 → M1 → M2 with one
  commit per milestone. Icon (decided 2026-09-27): the official Idris logo,
  `media/idris-logo-256.png` = Idris 2 `icons/idris-256x256.png` at `3a91594` (BSD-3; notice in
  `THIRD_PARTY_NOTICES.md`, which must ship in the `.vsix`; README states no affiliation).
  The user-facing README is kept short, in the style of other language extensions;
  development details go to `CONTRIBUTING.md`, design and history to `docs/`. Decided on 2026-09-27
  (ROADMAP §9 Q2): pack, and with it `idris2-lsp`, is installed only in M5. Decided on
  2026-09-27 before M2 (ROADMAP §9): a session outside the trusted workspace folders needs the
  user's consent per directory (Allow / Always Allow for This Folder / Don't Allow), and the M2
  defaults (`checking.trigger = onSave`, socket transport with stdio as the fallback — superseded
  by Q20 below —, isolated build directory, `loosePackages = []`). Decided on 2026-09-28 (ROADMAP
  §9, the M2 review questions): **Q20** the `check` session uses stdio on every platform by
  default, the socket only as an explicit opt-in in user settings (the former `auto` reads as
  stdio); **Q21** no resource limits by default — `idris2.ideMode.maxSessions` and
  `idris2.ideMode.maxBackgroundChecks`, both `0` = unlimited; **Q22** the backoff/give-up reading
  as built is confirmed. Decided on 2026-09-28 before M3 (ROADMAP §9): **Evaluate evaluates
  expressions only** — `(:interpret "<expr>")` on the separate `eval` session, which follows the
  `check` session's transport rule; no `:exec`, so IO actions are shown, not run; text the REPL
  parser reads as a command is refused; running programs belongs to the REPL terminal (M8) and
  Run main (M9) —; **keybindings as planned** (Q5): `idris2.keybindings.scheme` = `chords`
  (default on macOS) / `prefix` (default elsewhere) / `none`, each milestone binding only its own
  commands, M3 the letters `t`, `d`, `e` (ARCHITECTURE §10). Decided on 2026-09-29 after M3
  (ROADMAP §9): **Q23 accepted** (its recorded rationale corrected on 2026-09-30; the user, told the
  corrected rationale that day, kept the decision and accepted Q24 under it) — Evaluate does not
  refuse the elaborator scripts an expression reaches (a `%macro` applied by name runs its script without
  `ElabReflection`; `%runElab` runs where the extension is on in the compiler's context); the
  README's *Privacy and security* discloses it and must keep doing so; no textual `%runElab` rule
  in `replCommand.ts` (it cannot see macro applications). Whether this covers M8's Query box and
  lenses is M8's open question. Decided on 2026-09-30 (ROADMAP §9 **Q24**): the same holds for
  **Refine Hole…**, whose expression may run the scripts it reaches — documented (README *Privacy
  and security*, the guide), not refused. Decided on 2026-10-01 (ROADMAP §9, M4): **always
  bracket** (rule below, M4); **keep the layout refusal and make it converge** (rule below, M4; after
  that pass one final review: medium and low findings are recorded as known limitations, only a high
  finding stops the commit; a regression of the pass that can change a program was fixed too);
  **Q25** the keybinding letters stay the
  Idris docs' Vim ones; **Q26** Next Result (`n`) continues the document's cycle of either kind.
  **The `eval` session keeps its highlighting output**: no `(:enable-syntax :False)` (the reload
  cost it would save is accepted; the rule "nothing but evaluations goes to it" already forbids it).
- Test corpora (`test/corpus/corpus.json`, fetched by `scripts/fetch-corpus.mjs` into the
  git-ignored `.corpus/`): `idris-compiler-tools` (MIT, Jan Serwatka) and the Idris 2 v0.8.0
  libraries (BSD-3, Edwin Brady) may be excerpted into fixtures, each excerpt with an attribution
  header (source file, commit, changes) and an entry in `test/fixtures/grammar/NOTICE.md`;
  **Yaffle declares no licence**, so it is only fetched at test time at a pinned commit and
  **no text of it is ever copied into this repository**.

## Build and test

```sh
npm ci
npm run compile       # check-types (tsc --noEmit) + lint + esbuild → dist/
npm run lint          # eslint on src, test, scripts, esbuild.mjs (.ts and .mjs); any warning fails
npm run test:unit     # compile-tests (tsc → out/) + mocha --ui tdd on out/test/unit/**
npm run test:grammar  # TextMate snapshots + scope assertions + timing (out/test/grammar/**)
npm run test:corpus   # fetch the pinned corpora (network) and tokenise them; with
                      # IDRIS2_LEXER_ORACLE=1 also compare with the 0.8.0 lexer (needs idris2)
npm test              # pretest (compile-tests + compile) + vscode-test (.vscode-test.mjs):
                      # the suites integration, simple-ipkg, toolchain-path, diagnostics,
                      # loose-stdio, consent, intelligence, intelligence-loose, editing, holes
                      # (fake tools; the fake idris2 replays transcripts)
npm run test:e2e      # compile + the e2e suite against the real idris2 on PATH
npm run check:fixtures        # idris2 --check / --dump-ipkg-json on every fixture and snippet
                              # expansion (temp copy); the broken fixtures must fail as listed
npm run record:transcripts    # record the IDE-mode transcripts (test/fixtures/transcripts/<ver>/)
                              # from the idris2 on PATH (IDRIS2=<path>), one process at a time
npm run docs:graph:check      # ROADMAP §4 graph == docs/milestones.yaml (docs:graph rewrites)
npm run build:grammar                  # syntaxes/src/idris2.grammar.mjs → syntaxes/idris2.tmLanguage.json
npm run build:language-configuration   # → language-configuration/{idris2,lidr,ipkg}.json
npm run package       # vsce package (vscode:prepublish: check-types, lint, production bundle)
```

- Tests use mocha's **tdd** interface (`suite`/`test`) everywhere. Unit tests live in
  `test/unit/`, must not import `vscode`, and import sources as `../../src/...`. Integration
  tests live in `test/integration/`: the top-level files form the suite `integration`
  (workspace `test/fixtures/workspaces/loose-file`), `simple-ipkg/` the suite `simple-ipkg`
  (workspace folder `simple-ipkg/src`), `path/` the suite `toolchain-path`; all three use the
  fake tools of `test/fake-tools`, never a real compiler. `test/e2e/` runs against the real
  `idris2` (`npm run test:e2e`). They read extension state through the test API `activate()`
  returns in `ExtensionMode.Test` (`src/extension.ts`).
- `tsconfig.json` has `rootDir: "."` with `include: ["src", "test"]`, so `compile-tests` emits
  `out/src/**` and `out/test/**`; the runtime bundle is produced by `esbuild.mjs` only.
  ARCHITECTURE §2 describes the file as `noEmit`; that is realised by the `--noEmit` flag of
  `check-types`/`watch:tsc` rather than in the file, because mocha and `@vscode/test-cli` run
  compiled `.js` and need `compile-tests` to emit into `out/`. Deliberate deviation.
- Script names follow ARCHITECTURE §13 since M0: `package` = `vsce package`,
  `vscode:prepublish` = check-types + lint + production bundle. `test:e2e` exists since M1.
- Every `.ts` file under `src/` must be imported by something or be an esbuild entry point
  (`src/webview/goalPanel.ts` is M0's stub entry); every file under `test/` must be a test or
  something a test uses (harness, fixtures, snapshots, corpus list, fake compiler). No dead code.
- **Generated files — edit the generator, never the output:** `syntaxes/idris2.tmLanguage.json`
  (from `syntaxes/src/idris2.grammar.mjs`) and `language-configuration/*.json` (from
  `scripts/build-language-configuration.mjs`). Tests run each generator with `--check`.
- **Snapshots** (`test/grammar/snapshots/*.snap`): never regenerate blindly. After a grammar
  change, run `UPDATE_SNAPSHOTS=1 npm run test:grammar`, read the diff line by line, and say in
  the commit what changed and why it is right.
- **Fixtures**: every `.idr`/`.lidr` under `test/fixtures` must pass `idris2 --check` and every
  `.ipkg` `idris2 --dump-ipkg-json`, except the deliberately broken files of the `broken`
  workspace, which must fail with exactly the errors listed in `EXPECTED_PROBLEMS`
  (`scripts/check-fixtures.mjs`); `npm run check:fixtures` runs both in a temporary copy so
  no `build/` directory lands in the repository. It also expands every snippet into a host file
  (`SNIPPET_HOSTS` in `scripts/check-fixtures.mjs`) and checks it; a new snippet needs a host. Every
  lexical rule of the grammar must be traceable to the compiler's lexer/parser (cited in the
  generator) or to an `idris2 --check` experiment (recorded in `test/grammar/idris2-scopes.md` or
  the test that pins it).

## Toolchain constraints

- **TypeScript must stay on 6.x** (`^6.0.3`): `typescript-eslint` 8.70 declares
  `typescript <6.1`, so TypeScript 7 breaks linting. Do not "upgrade" it. The other pins come
  from generator-code 1.12.0 (eslint ^10.5.0, typescript-eslint ^8.61.1, esbuild ^0.28.1,
  @vscode/test-cli ^0.0.15, @vscode/test-electron ^3.0.0, mocha ^11.7.6, @types/vscode ^1.138.0
  with `engines.vscode ^1.138.0`); the runtime dependency `vscode-languageclient ^10.1.1`
  needs `engines.vscode >= 1.91`.
- **`overrides` in package.json** (`diff ^8.0.4`, `serialize-javascript ^7.0.6`) come verbatim
  from generator-code 1.12.0's template (the reference skeleton emits the identical block). They
  are kept because `npm audit` flags mocha 11.8.0's own pins (`diff ^7`, `serialize-javascript ^6`):
  GHSA-73rr-hh4g-fpgx (diff, DoS in parsePatch/applyPatch), GHSA-5c6j-r48x-rmvq and
  GHSA-qj8w-gfj5-8c6v (serialize-javascript, RCE / CPU-exhaustion DoS) — 4 advisories, 1 high,
  verified 2026-09-25 by running `npm audit` on a copy of the manifest without the overrides.
  `npm audit` offers mocha 12.0.2 as the upstream fix. Drop the overrides once mocha is bumped
  to a version whose own dependency ranges clear the audit (re-run `npm audit` to confirm).
- `vscode-textmate` and `vscode-oniguruma` are pinned to the versions VS Code ships
  (`^9.3.2` and exactly `1.7.0` in 1.139.1, read from its `package.json`), so grammar tests run
  the engine users run. `tsconfig.json` sets `skipLibCheck` because oniguruma's `main.d.ts`
  names the `WebAssembly` namespace, which neither ES2022 nor `@types/node` declares.
- **F17 socket path.** `@vscode/test-cli` fails with `listen EINVAL … .vscode-test/user-data/
  1.13-main.sock` when the user-data-dir path exceeds 103 characters. `.vscode-test.mjs` passes
  `--user-data-dir=<checkout>/.vscode-test/user-data` explicitly, which is also test-electron's
  default; the protection is the short checkout path, so keep the checkout short and never move
  that directory somewhere long.
- On this machine: Node v24.13.0, npm 11.11.0, Idris 2 0.8.0 at `/opt/homebrew/bin/idris2`
  (no `idris2-lsp`, no `pack`), VS Code 1.139 with the CLI at
  `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` (not on PATH).
  Fixtures are checked with `npm run check:fixtures` (see above).

## Rules established by M0

- The lidr grammar entry in `package.json` must **not** map `meta.embedded.block.idris2` to
  the language `idris2` (`embeddedLanguages`): VS Code picks Enter rules, snippets and
  comment settings by the language of the token at the cursor, so the mapping made the `.idr`
  Enter rules run on bird-track lines (verified in VS Code 1.139.1;
  `test/integration/editor.test.ts` fails if it comes back).
- Restricted Mode: M1 changed `capabilities.untrustedWorkspaces.supported` from `true` to
  `"limited"` (without either VS Code disables the whole extension, highlighting included, in
  Restricted Mode — observed in M0). Every later setting that names an executable, arguments or
  environment variables must be added to `restrictedConfigurations` (a unit test in
  `test/unit/manifest.test.ts` lists them), and nothing may be spawned in an untrusted
  workspace (see the M1 rules).
- Manual runs of VS Code (e.g. checking a `.vsix`) must not touch the user's profile: pass
  `--user-data-dir`, `--extensions-dir` **and** `--shared-data-dir`, each a short `/tmp/vi2-*`
  path (F17). VS Code 1.139 otherwise opens `~/.vscode-shared/sharedStorage` even with a
  separate user-data-dir, and inherits the user's trusted-folder list from it. Kill only the
  processes started that way and delete the directories afterwards. `npm test` is not affected
  (it uses an in-memory shared storage).
- `.vscode-test.mjs` writes `{"chat.disableAIFeatures": true}` into
  `.vscode-test/user-data/User/settings.json` before every run. Keep it. VS Code 1.139.1's
  chat input is a code editor, and when the test window starts without OS focus it keeps the
  editor focus, so `type` and `editor.action.*` go to it and the Enter tests fail (observed
  2026-09-27). For the same reason `test/integration/editor.test.ts` presses Enter with
  `editor.action.insertLineAfter`, which runs the same routine as a typed Enter [src], and not
  with the `type` command.

## Rules established by M1

- **Every process the extension starts goes through the one runner in `src/core/process.ts`**:
  it refuses everything while the workspace is untrusted, runs one process at a time in call
  order, never uses a shell (a Windows `.cmd`/`.bat` goes through a quoted `cmd.exe` command
  line or is refused), and stops a timed-out process group (until its result is settled, also
  after the group leader has ended); `deactivate()` disposes it. No other module in `src/`
  imports `child_process`. Terminals (the install commands) only ever get text without a line
  break or any other control character, and start in the home directory, never in a workspace
  folder: pack reads the `pack.toml` of its working directory and of every parent
  (`docs/as-built/M1.md`, *Install commands*).
- **Starting the compiler in a directory can execute code from that directory** (the Homebrew
  `idris2` loaded a planted `libc.dylib` from its working directory; `docs/as-built/M1.md`,
  *Processes*). M1's own runs (probes, `--dump-ipkg-json <absolute .ipkg path>`) therefore start
  in the tool's own directory, and the runner accepts only fully qualified executable and
  working-directory paths (`isFullyQualifiedPath`: on Windows a drive or UNC root, never `\x`
  or `C:x`). A session that must run in a project directory (M2) is a decision to record, not
  a default.
- Unit tests never run the real compiler; they use `test/fake-tools` (sh and `.cmd` launchers
  that run the Node fakes with the `node` on `PATH`) or recorded output. Recorded compiler
  output is keyed by the fixture's SHA-256 in two places, `test/unit/support/ipkgRecordings.ts`
  and `test/fake-idris2/recorded-cli-0.8.0.json`: changing an `.ipkg` fixture fails the unit
  tests until it is re-recorded (the procedure is in the file header and in
  `test/fake-idris2/README.md`; one `timeout 120 idris2` at a time).
- e2e tests call `extensionIdle` (`test/e2e/helpers.ts`) before running `idris2` themselves, so
  that the extension's own probes and the test's process never overlap.
- `.vscode-test.mjs` gives each suite its own profile and passes `--force-disable-user-env`;
  keep both (without the flag the Extension Host takes the login shell's `PATH`, observed).
  Integration tests that change a setting restore it.
- pack is not installed on the development machine until M5 (ROADMAP §9 Q2): pack facts are
  [doc]/[src] and tested only against simulated layouts (`test/fake-tools/packLayout.ts`).
- On this machine `ls` is aliased to `eza` in the shells the agents get, and it hung without a
  terminal (2026-09-27); scripts use `/bin/ls`.

## Rules established by M2

- **IDE-mode session processes** are started by `startLongRunningProcess` in
  `src/core/process.ts`, under the runner's rules (nothing in Restricted Mode, fully qualified
  executable and working directory, no shell but the quoted `.cmd`/`.bat` route, process-group
  stop, immediate kill at `dispose`) except the one-at-a-time queue and the 1 MiB output limit
  (the transport bounds its own buffer). The session pool (`backend/ide/pool.ts`) owns them, and
  `deactivate()` disposes it. They are the only processes that start in a project directory (the
  `.ipkg`'s, or a loose file's; D4, F13), and only after the consent gate
  (`SessionGate.permit`, `features/consent/gate.ts`) allowed it — before **every** spawn — in the
  real path the gate judged last on POSIX (`SessionLaunch.realCwd`). Never add a path that starts the
  compiler in a directory without going through the gate. The compiler walks up for an `.ipkg` at
  every `:load-file` (F13), so a load is sent only through `IdeBackend.load`, which walks again
  right before the request is written (`RequestOptions.beforeSend`) and refuses a path the
  compiler's own path parser reads otherwise (`backend.ts`).
- **Protocol facts live in `src/backend/ide/{sexp,wire,protocol}.ts`** (ARCHITECTURE §1 goal 2).
  The session layer gets the codec injected; `session.ts` imports only the F4/F5 predicates of
  `protocol.ts`, `diagnostics.ts` only `decodeBuildingLine`. Requests are printable ASCII: text
  outside U+0020–U+007E is written as the compiler's decimal escapes (raw UTF-8 is read as
  Latin-1, F1 addendum). Reply prefixes count code points, request prefixes UTF-8 bytes (F1).
- **Transcripts** (`test/fixtures/transcripts/<version>/*.jsonl`) are recorded only by
  `npm run record:transcripts` from the real compiler, never written by hand; each carries the
  SHA-256 of the fixture files it read, and the fake compiler replays a recording only while
  they match (a changed fixture fails the tests until it is re-recorded). Recorded replies and
  requests are compared byte for byte by the unit tests.
- Integration suites never run the real compiler: the fake (`test/fake-idris2`) replays the
  transcripts over stdio and the socket (`FAKE_IDRIS2_TRANSCRIPTS`, set by `.vscode-test.mjs`).
  The e2e suite runs the real one, one process at a time, except `test/e2e/e21.test.ts` (one
  session beside one `idris2 --build` on the one-module `builddir-ipkg` fixture).
- **Text that VS Code parses for links is a literal or wholly one `plainText(…)` call**
  (`src/core/notificationText.ts`; `plainText(a) + b` does not count): the message of
  `show{Information,Warning,Error}Message`, the language status item's `detail`, an input box's
  or QuickPick's `prompt` (also `showQuickPick`'s option) and `validationMessage` (and what
  `validateInput` returns), and a notification progress's `title` and `message`. VS Code 1.139.1
  turns `[label](command:…)` in all of these into a link that runs the command, and the texts quote
  folder names and compiler output (`docs/as-built/M2.md`, *Registry and status*). Call these APIs
  directly (`x.showWarningMessage(…)`, `progress.report(…)`, never through element access,
  destructuring, `.call` or a stored reference), give `showInputBox`, `showQuickPick`,
  `withProgress` and `report` an object literal, and set `detail`, `prompt` and `validationMessage`
  with `=` on the property (not `+=`, element access, `Object.assign`, `Object.defineProperty` or
  `Reflect.set`). `test/unit/notificationText.test.ts` reads the syntax tree of `src/`, resolves
  names with the type checker, and fails otherwise. A command handler must not reject with such a
  text either (VS Code shows a rejected command's message as a notification, links working): catch
  it, log it and show it through `plainText` (`guarded` in `features/consent/register.ts`). A path
  in a text the user decides on (the consent question) goes through `shownPath` — in quotes,
  invisible characters, spaces other than U+0020, characters drawn like a double quote (or like
  three or four apostrophes) and runs of two or more drawn like an apostrophe (with the marks on
  them) written out, shortened in the middle to 200 UTF-16 units — and comes after the fixed text;
  in the status item's detail a consent text comes before any path.
- Features see the IDE-mode backend only through `backend/registry.ts` (`BackendProvider`,
  `BackendState`) and interfaces `extension.ts` fills from `IdeMode` (`BackendControl`,
  `RawRequests`, `RootRelease`, `RootRestarts`, `ActiveRoot`, `LoadPreflight`), never by importing
  `backend/ide`.
- **Transport and limits** (ROADMAP §9 Q20, Q21, decided 2026-09-28). Sessions speak stdio
  (`--ide-mode`) unless the user chose `socket`; `idris2.ideMode.transport` (like
  `idris2.trace.protocol`) is `application`-scoped (VS Code reads it from the user settings only,
  never from a workspace's nor from a remote machine's, which a dev container's configuration
  fills, so only the user's own choice opens the socket's unauthenticated port) and its
  description says what the port exposes; an
  `idris2.ideMode.extraArgs` that names `--ide-mode` or `--ide-mode-socket` starts nothing
  (`pool.ts` `extraArgsProblem`), since the compiler serves the socket whenever that flag is on its
  command line. Every `idris2.ideMode.*`
  key is in `IDE_MODE_SESSION_KEYS` (a change may restart sessions whose command line it changes)
  or `IDE_MODE_LIMIT_KEYS` (a change restarts nothing) in `core/config.ts`;
  `test/unit/manifest.test.ts` checks it. `maxSessions` and `maxBackgroundChecks` default to `0`
  (no limit), and with `0` the pool and the checks must behave exactly as without them (no
  eviction scheduled, no slot or question awaited). The pool evicts only an `idle` session that is
  not the active root's, and none while the active root is `pending` (a file just opened is being
  classified); the checks never make the active document's check wait for a slot, mark its load
  `urgent` while a limit is set (`LoadOptions`; the session sends it before the root's requests that
  wait, queries included — a query whose answer is kept per load (`typeAt`, `docsFor`,
  `definition`) that it passes is refused before its write (`NotLoaded`) and asked again,
  `IdeBackend.ask`; completions and namespace listings are sent after it and answer for the new
  load —, never before the one in flight or one whose package walk runs or has passed) — except in
  a batch of visible documents, which leaves the active one's load not urgent when, at its handover,
  a load of the batch in its root handed over before it has not settled (`CheckOptions.batch`,
  decided once: it stays first-in, first-out, behind the root's requests queued before it,
  background loads included — a documented choice, tenth review of M3; alone in its root, it stays
  urgent); the active one is not loaded
  last when a check of the batch in its root hands its load over after it: at activation or trust
  grant while the gate has no verdict for that check's folder yet, and when that check is left
  waiting for a slot, since the batch's checks that take one (not the active one's, not those whose
  folder is refused or whose load is refused before the question; of any root) outnumber the free
  slots (the limit less the checks that hold one, those outside the batch included) — not fixed,
  documented (sixth to ninth reviews of M3, option (c); not a user decision), `checks.ts` *The
  active document* —, ask the
  backend (`LoadPreflight`) before they ask a consent question themselves, and Stop Backend drops
  the checks still waiting (`DocumentChecks.cancelWaiting`) before it stops the sessions. Both
  limits count per VS Code window (each has its own extension host, pool and checks).

## Rules established by M3

- **Compiler text is untrusted** (it quotes the user's and installed packages' source): a
  `MarkdownString` that shows any is never `isTrusted` and has `supportHtml` and
  `supportThemeIcons` off, and compiler text enters it only inside `core/untrustedText.ts`
  `codeBlock` (a fence no line of the text can close — not `appendCodeblock`, whose fence an
  indented line can close, and not `appendText`, whose escaper in VS Code 1.139.1 lets named
  character references and autolinks through), with `visible` writing out control and format
  characters; text drawn inside a line (inlay hint labels, decorations' `contentText`)
  goes through `editorLabel`, QuickPick item texts through `quickPickText`; documents that show it
  are plain text (the `idris2-doc:` scheme). The M2 `plainText` rule still covers notifications.
  `test/unit/untrustedText.test.ts`, `hover.test.ts` and `eval.test.ts` pin it.
- **Evaluate evaluates expressions only** (ROADMAP §9, 2026-09-28): `IdrisBackend.evaluate`
  refuses with `backend/ide/replCommand.ts` `replCommandRefusal` — at least as strict as the
  compiler's REPL parser; the argument is in its module comment, `test/unit/replCommand.test.ts`
  checks it against the recordings and a lexer oracle — before anything is classified, started
  or sent. Nothing may send to the `eval` session text that changes its evaluation mode (`:set`),
  runs a program (`:exec`) or anything else the parser reads as a command, and nothing but
  evaluations (with the load before each) goes to it; the `check` session never gets
  `:interpret` of an evaluation. The `eval` session goes through the same `prepare` (trust,
  toolchain, consent gate) as the `check` session.
- **Columns count code points** in the compiler (E14, settled [live]); only `core/positions.ts`
  converts them (`codePointsBefore`, `utf16Length`, with each line's text), also for the
  highlighting offsets inside a reply (`protocol.ts` `toRichText`). Features never convert again.
  **Lines are not always file lines either**: in a bird-track (or Org `#+IDRIS:`) file every line
  of a marker and white space only (`> `) is two lines of the compiler's unlit text (ROADMAP F11
  addendum), so a compiler line goes through `positions.ts` (`toIdeLineRequest`, `fromIdeReply`,
  `fromCli`, …) too, never `line ± 1` in a feature (`displayLine` for a line shown to the user).
- **Queries go through `features/intelligence` `DocumentQueries`**: a backend query never loads a
  file (it rejects with `NotLoaded`, having sent and started nothing), and the caller loads the
  document through the checks, so that the load's diagnostics are shown. A passive provider loads
  only the active document. Providers refresh on `LoadNotifications.onDidLoad`, **never on
  `BackendRegistry.onDidChange`**, which IDE mode fires at every state change of a `check`
  session (twice per request) — refreshing there would re-query at every answer.
- Integration tests must not assume that a `check` session is `ready` right after a load: M3
  sends requests after loads (the completion warm-up, inlay hints). Wait for the state instead —
  and `ready` is not the end either: the warm-up is sent once the session has been idle for
  150 ms (`WARM_UP_QUIET_MS`), so a test that asserts no request is sent first waits with
  `settled` (`test/integration/support.ts`: `ready` and no state change for 1 s). Likewise a
  completion asked right after a load may get the keywords alone, marked incomplete; ask again.
- Transcripts of the `eval` role (`eval-*`) are recorded with the `eval` session's command line
  (`--build-dir …/.vscode-idris2-eval`); the fake compiler answers a process only from recordings
  of its own role, told by that build directory.

## Rules established by M4

- **Names from a document are untrusted.** Every name an edit sends (a hole's, a pattern
  variable's, a function's, a proof-search hint) is checked against the compiler's name grammar
  (`backend/ide/protocol.ts` `isHoleName`, `isIdentifierName`, `isOperatorInParentheses`) by
  `IdrisBackend.edit` before it classifies or sends anything (the command may have saved and
  checked the file by then; no text taken from a name reaches the compiler), and
  `(:interpret ":missing NAME")` is built only by `missingCases()`, which throws on anything else,
  so no text in a file can become another REPL command. Refine Hole's expression goes only into the
  string slot of `:refine`. Refusals do not echo a rejected name.
- **An edit lands only where and when it was asked.** `IdrisBackend.edit` answers with
  replacements of the request's document (`EditResult` `edit`), computed for `EditRequest.version`;
  IDE mode makes a request only for a document that, at `EditRequest.version`, shows exactly the
  lines its `check` session's last load read (`LoadRecord.loadedText`), and
  `features/editing/apply.ts` applies the answer as one `WorkspaceEdit` of that document only
  while its version is still `version` (one undo step). Intro, Refine Hole, Proof Search and Make
  Lemma, which the compiler answers for the hole it registered under the name, are sent only when
  that load's holes put the one hole of the name at the cursor (`edits.ts` `holeRefusal`).
  A `-Next` is sent only while the compiler's search is the one it continues (per session and
  kind; any load, a search of the same kind or a raw request ends it).
- **Always bracket** (user decision, 2026-10-01, ROADMAP §9): an answer put in place of a hole —
  Intro (also a single candidate applied without asking), Refine Hole… and its ambiguity
  alternatives, Proof Search and its next results, Make Lemma's call — goes in parentheses unless it
  is one token (`core/idrisSyntax.ts` `isOneToken`: a name, a literal, a hole, an operator in
  parentheses, or one bracket group spanning the whole answer; a postfix projection `.x` counts as
  more, since the parser applies it to the expression before it) that would not run into a name right
  before the hole or a `.` right after it, and is not a string literal touching a `"` (`edits.ts`
  `inPlace`, wherever the hole is; `docs/as-built/M4.md`, *Edits*); after a backtick a space goes
  before an answer that starts with a bracket (`` `( `` would open a quotation); at the head of an
  idiom bracket on the hole's line only a name, a hole or a lambda is put, anything else is refused
  (`idiomHeadProblem`). **Do not add a reading of the code around the hole to leave parentheses
  out**: that analysis missed a case in
  every review round, each a silent change of the program. Refine Hole's ambiguity alternatives are
  offered only when each is the hinted name, qualified, followed by its arguments (`isNameApplied`);
  the infix form the compiler prints for a binary operator with a fixity is refused. **Make Case**
  applies only the compiler's bracketed form (`makeCase`, `Idris/IDEMode/MakeClause.idr` 57–81
  [src]; `edits.ts` `madeCase` rebuilds both forms from the line): the bracketed answer as it is,
  the unbracketed one rewritten into it, anything else refused.
- **The layout refusal** (user decision, 2026-10-01, ROADMAP §9: kept, made to converge). Make
  Case and the answers in place are refused before sending when the rest of the hole's line starts
  an entry of a layout block (`core/idrisSyntax.ts` `opensBlockOnLine`) or the code of the hole's
  entry before it, read from the nearest line above whose first token is left of the hole line's
  (`edits.ts` `entryStart`), ends inside a `parameters`/`using`/`with` header (`holdsBlockHeader`),
  and the first token below is right of the hole (`edits.ts` `layoutProblem`): the new text would move that entry's
  column, which can change the program silently (`docs/as-built/M4.md`, *Blocks after the hole*).
  The block openers are the block calls of `src/Idris/Parser.idr` 0.8.0, all of them (a `where`'s
  options and any `|` read conservatively), listed with line numbers in the comment above
  `ENTRY_KEYWORDS` in `core/idrisSyntax.ts`, each with a test in
  `test/unit/idrisSyntax.test.ts`; a new opener goes into that list with its citation and a test.
  `edits.ts` reads every line's layout column from its first token (`firstTokenColumn`: past white
  space, U+00A0 and comments; `entryAt`), not its leading spaces and tabs, and gives new lines that
  column (`layoutIndentation`). QuickPick labels stay as the compiler printed them.
- **Next Result continues either cycle** (Q26): `n` sends the `-Next` of the document's cycle's kind;
  Next Definition and Generate Definition on the cycle's declaration or result continue a Generate
  Definition cycle only (`features/editing/commands.ts` `continues`).
- **Lines of edit requests** go through `core/positions.ts` like every other compiler line:
  `toIdeCaseSplitRequest` / `toIdeLineRequest` for the commands that find their place by the
  lexer's lines, `toIdeSourceLineRequest` for `:make-lemma`, `:make-case`, `:make-with`, which read
  the raw source line (they differ below a doubled bird-track line, F11 addendum).
- The holes model refreshes on `LoadNotifications.onDidLoad` and asks `IdrisBackend.holes` directly
  (with `HolesOptions.kept`); it never loads (the M3 rule for passive providers). List Holes asks
  without `kept`, so that it checks a file that is not the one loaded last.
- **One lexer, shared.** The lexer's tables and rules and the stack of what is open (brackets,
  strings, interpolations, a block comment or character literal cut by a line break) live in
  `core/idrisLexer.ts` (`lexText`, a port of the compiler's lexer rule by rule, resumable at a line
  break). M0's `lex()` runs it on a whole text; the line reader of the edits (`core/idrisSyntax.ts`:
  `levelTokens`, `openAfter`, `firstTokenColumn`, `opensBlockOnLine`, `holdsBlockHeader`,
  `clauseName`, `withClauseStart`, `caseSplitLineProblem`) runs it a line at a time. **The line
  reader reads no lexeme itself**; a lexeme rule changes in `idrisLexer.ts` only. One older reader
  remains outside it, a known limitation: `edits.ts` `startsToken`/`holeTokenAt`, which find the
  hole token at the cursor (it misses a hole right after a raw string's `"#`, a false refusal).
  `core/idrisSyntax.ts` re-exports `KEYWORDS`, `OPERATOR_CHARACTERS`, `GROUP_SYMBOLS` and
  `isKeyword`, and keeps the parser's tables (reserved symbols, modifiers, function-option pragmas,
  block openers); `selectionRangeModel.ts`, `occurrence.ts`, `symbols.ts`, completion,
  `targets.ts`, the holes and `edits.ts` import from there (of the features, only
  `features/syntax/lexer.ts` imports `idrisLexer.ts`; in core, `idrisSyntax.ts`); the light bulb and the backend read Make With's clause and Case Split's
  line with the same predicates. Do not copy them. Guards: `test/unit/idrisSyntaxLines.test.ts`
  and the corpus suite *line reader against lex* (`npm run test:corpus`, in CI) compare the reader with `lex()` token by
  token; `test/unit/syntaxLexer.test.ts` pins the rules and the documented line-by-line
  deviations; the lexer oracle (`IDRIS2_LEXER_ORACLE=1 npm run test:corpus`, local only) checks
  `lex()` against the compiler's own lexer. The comparison cannot see a rule broken the same way on
  both sides; the unit tests and the oracle can.
- A contributed keybinding names a command its milestone registers (`test/unit/keybindings.test.ts`;
  the editing commands are registered in a loop over `EDITING_COMMAND_KINDS`, which that test
  accepts from `features/editing/register.ts` only), and the `intelligence-loose` suite checks
  every letter against VS Code's resolved keymap (E23).
- An integration test that restarts a session (e.g. through `idris2.toolchain.env`) and then shows
  a file must not wait for a load that showing it may not start: a document still open from an
  earlier test file is checked only once per opening (M2), and the restart checks only the
  documents visible at its handshake. Start the check when none runs (`editing/fixture.ts`
  `showLoaded`).
- `@vscode/test-cli` runs the newest stable VS Code it finds or downloads: since 2026-09-30
  (during M4's integration) that is 1.140.0, not the 1.139.1 whose bundle the M0–M3 `[src]` facts
  were read from; no difference between the two has been met.
- VS Code (1.139.1 and 1.140.0 [src]) registers commands of its own for every contributed view
  (`idris2.holes.focus`, `.open`, `.removeView`, `.resetViewLocation`, `.toggleVisibility`); tests
  that list the extension's commands leave them out.

## Platforms

- Supported: macOS and Linux (and Windows through WSL, which is Linux). **Native Windows is
  out of scope** (user decision, 2026-09-28; ROADMAP §9): CI has no Windows job, and no new
  Windows-specific work is done. Existing Windows code paths stay as they are and are covered
  only by unit tests that simulate `process.platform = 'win32'` on macOS/Linux; keep those
  passing, but do not extend them.

## Working rules

- Do not commit, tag, publish or install anything globally unless asked.
- Claims in README, `docs/guide.md` (the user guide the README links to) and CHANGELOG must be true
  of the code as built; plans belong in `docs/ROADMAP.md`. `CHANGELOG.md` (shown on the
  Marketplace) says in a few user-facing lines per milestone what a user gets, in Keep-a-Changelog
  sections; implementation detail, test counts and review history go to `docs/as-built/Mn.md`.
- Run at most one `idris2` process at a time, never in the background or in parallel, and
  never on the corpora or the Idris 2 libraries (the lexer oracle compiles only
  `LexDump.idr` and runs the resulting lexer over them). The one approved exception (user,
  2026-09-28): `scripts/measure-first-load.mjs` on a copy of Idris 2's `contrib` under `/tmp`,
  one process at a time (`docs/measurements/first-load.md`). This machine has 16 GB, and parallel
  compiler runs have taken it down (2026-09-27). `check:fixtures` and the lexer oracle spawn
  `idris2` one file at a time (`spawnSync`) and honour `IDRIS2=<path>`, so a wrapper running
  `timeout 120 idris2 "$@"` adds a time limit. Start only one VS Code test instance at a time.
  The Homebrew `idris2` is a shell launcher that runs `chez --program …/idris2_app/idris2.so`, so
  `pgrep -x idris2` never sees a compiler; count them with `pgrep -f idris2_app/idris2.so`.
