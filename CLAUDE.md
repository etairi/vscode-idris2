# CLAUDE.md — vscode-idris2

Guidance for Claude Code when working in this repository (a VS Code extension for Idris 2).

## Where things are decided

- `docs/ROADMAP.md` — milestones M0–M16, the verified facts F1–F36 (§0), open questions (§9).
  **Features are implemented in the milestone that owns them, with the scope written there.**
  Do not pull a later milestone's feature forward, and do not stub it with an empty module:
  placeholders for future parts are the README files in `src/` and `test/`. The one deliberate
  exception already made: the "Idris 2" output channel and **Idris 2: Show Output** belong to
  M0's Help group and were taken into the skeleton as its minimal activation proof (something
  `activate()` must do so the integration test has an observable effect). M0 adds the group's
  other two commands; nothing else from M0 exists.
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
- Test corpora: `idris-compiler-tools` (MIT, Jan Serwatka) may be excerpted into fixtures with
  attribution; **Yaffle declares no licence**, so it is only fetched at test time at a pinned
  commit and never copied into this repository.

## Build and test

```sh
npm install
npm run compile      # check-types (tsc --noEmit) + lint (eslint src test) + esbuild → dist/
npm run test:unit    # compile-tests (tsc → out/) + mocha --ui tdd on out/test/unit/**
npm test             # pretest (compile-tests + compile) + vscode-test (.vscode-test.mjs)
npm run package      # production bundle (minified, no sourcemap)
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
- Script names follow generator-code 1.12.0, not ARCHITECTURE §13 literally: here `package`
  is the production esbuild bundle and `vscode:prepublish` runs it, whereas §13 lists `package`
  = `vsce package` and `vscode:prepublish` = production bundle. `@vscode/vsce` is not a
  devDependency and `vsce package` cannot succeed until the repository URL exists (Q1), so the
  rename is deferred to the milestone that adds the packaging step to CI (§13); until then this
  deviation is deliberate. `test:grammar` and `test:e2e` do not exist yet (M0, M2).
- Every `.ts` file under `src/` must be imported by something or be the entry point; every file
  under `test/` must be a test. No dead code.

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
- **F17 socket path.** `@vscode/test-cli` fails with `listen EINVAL … .vscode-test/user-data/
  1.13-main.sock` when the user-data-dir path exceeds 103 characters. `.vscode-test.mjs` passes
  `--user-data-dir=<checkout>/.vscode-test/user-data` explicitly, which is also test-electron's
  default; the protection is the short checkout path, so keep the checkout short and never move
  that directory somewhere long.
- On this machine: Node v24.13.0, npm 11.11.0, Idris 2 0.8.0 at `/opt/homebrew/bin/idris2`
  (no `idris2-lsp`, no `pack`), VS Code 1.139 with the CLI at
  `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` (not on PATH).
  Fixture `.idr` files must pass `idris2 --check`; delete the `build/` directory it creates.

## Working rules

- Do not commit, tag, publish or install anything globally unless asked.
- Claims in README/CHANGELOG must be true of the code as built; plans belong in
  `docs/ROADMAP.md`.
