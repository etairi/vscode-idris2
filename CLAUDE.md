# CLAUDE.md — vscode-idris2

Guidance for Claude Code when working in this repository (a VS Code extension for Idris 2).

## Where things are decided

- `docs/ROADMAP.md` — milestones M0–M16, the verified facts F1–F36 (§0), open questions (§9).
  **Features are implemented in the milestone that owns them, with the scope written there.**
  Do not pull a later milestone's feature forward, and do not stub it with an empty module:
  placeholders for future parts are the README files in `src/` and `test/`. M0 is implemented
  and accepted (2026-09-27, ROADMAP M0 "As built"); the one planned stub is M0's
  `src/webview/goalPanel.ts` (an empty second esbuild entry, ROADMAP M0 "Out"), which M7
  replaces.
- `docs/ARCHITECTURE.md` — the technical design: repository layout (§2), the `IdrisBackend`
  interface (§3), sessions (§5), coordinates (§7), settings (§11), test layers (§12), build
  (§13), decisions D1–D22 (§14). New code goes where §2 puts it and follows its naming rules.
- `docs/landscape.md` — the survey the design rests on. Every fact in it and in the other two
  documents carries an **epistemic tag**; each document's legend is at its top
  (`landscape.md`: `[live]`, `[src]`, `[mkt]`, `[doc]`, `[untested]`; `ROADMAP.md`: `[live]`,
  `[src]`, `[doc]`, `[gh]`, `[open]`; `ARCHITECTURE.md` legend: `[live]`, `[src]`, `[doc]`,
  `[open]`, and it also uses `[gh]` inline). When editing or quoting
  these documents, preserve the tags; when adding a fact, tag it the same way and say how it
  was verified. Never upgrade an `[open]`, `[untested]` or `[doc]` fact to `[live]` without
  actually running it.
- Decisions taken by the user on 2026-09-26 (recorded in `docs/ROADMAP.md` §9): MIT licence
  (`LICENSE`, copyright Erkan Tairi); repository `github.com/etairi/vscode-idris2`; publisher
  `etairi` (provisional, not yet created on the Marketplace); language id `idris2` (the clashing
  `j-nava.idris2-language-support` was uninstalled from the user's VS Code); grammar written
  fresh, using existing grammars only as reference; implementation order M0 → M1 → M2 with one
  commit per milestone. Still undecided: the icon — do not invent one.
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
npm test              # pretest (compile-tests + compile) + vscode-test (.vscode-test.mjs)
npm run check:fixtures        # idris2 --check / --dump-ipkg-json on every fixture and snippet
                              # expansion (temp copy)
npm run docs:graph:check      # ROADMAP §4 graph == docs/milestones.yaml (docs:graph rewrites)
npm run build:grammar                  # syntaxes/src/idris2.grammar.mjs → syntaxes/idris2.tmLanguage.json
npm run build:language-configuration   # → language-configuration/{idris2,lidr,ipkg}.json
npm run package       # vsce package (vscode:prepublish: check-types, lint, production bundle)
```

- Tests use mocha's **tdd** interface (`suite`/`test`) everywhere. Unit tests live in
  `test/unit/`, must not import `vscode`, and import sources as `../../src/...`. Integration
  tests live in `test/integration/` and run in the Extension Host on
  `test/fixtures/workspaces/loose-file`.
- `tsconfig.json` has `rootDir: "."` with `include: ["src", "test"]`, so `compile-tests` emits
  `out/src/**` and `out/test/**`; the runtime bundle is produced by `esbuild.mjs` only.
  ARCHITECTURE §2 describes the file as `noEmit`; that is realised by the `--noEmit` flag of
  `check-types`/`watch:tsc` rather than in the file, because mocha and `@vscode/test-cli` run
  compiled `.js` and need `compile-tests` to emit into `out/`. Deliberate deviation.
- Script names follow ARCHITECTURE §13 since M0: `package` = `vsce package`,
  `vscode:prepublish` = check-types + lint + production bundle. `test:e2e` arrives with M2.
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
  `.ipkg` `idris2 --dump-ipkg-json`; `npm run check:fixtures` runs both in a temporary copy so
  no `build/` directory lands in the repository. It also expands every snippet into a host file
  (`SNIPPET_HOSTS` in `scripts/check-fixtures.mjs`) and checks it; a new snippet needs a host. Every lexical rule of the grammar must be
  traceable to the compiler's lexer/parser (cited in the generator) or to an `idris2 --check`
  experiment (recorded in `test/grammar/idris2-scopes.md` or the test that pins it).

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
- `capabilities.untrustedWorkspaces.supported` is `true` because M0 executes nothing from the
  workspace; without it VS Code disables the whole extension, highlighting included, in
  Restricted Mode (observed). **The first milestone that spawns a process (M1) must change it
  to `"limited"`** and list every setting that names an executable or arguments in
  `restrictedConfigurations`, and gate spawning on `workspace.isTrusted`.
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

## Working rules

- Do not commit, tag, publish or install anything globally unless asked.
- Claims in README/CHANGELOG must be true of the code as built; plans belong in
  `docs/ROADMAP.md`.
- Run at most one `idris2` process at a time, never in the background or in parallel, and
  never on the corpora or the Idris 2 libraries (the lexer oracle compiles only
  `LexDump.idr` and runs the resulting lexer over them). This machine has 16 GB, and parallel
  compiler runs have taken it down (2026-09-27). `check:fixtures` and the lexer oracle spawn
  `idris2` one file at a time (`spawnSync`) and honour `IDRIS2=<path>`, so a wrapper running
  `timeout 120 idris2 "$@"` adds a time limit. Start only one VS Code test instance at a time.
