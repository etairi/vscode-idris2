# Review brief

For the review of the whole progress that the user runs as a separate workflow once M8 is finished
(ROADMAP §9, decided 2026-10-30). **Last updated after the fixes of review 1.** Start here, then read
`CLAUDE.md`, which holds the rules the code must keep. Review 1 ran at `ced9c6f`; its findings and fixes
are in `as-built/review-1.md`. A next round starts with those fixes, which no reviewer has read, then
the low findings the review reported and nobody triaged.

## What is reviewed

Everything on `main`: `src/`, the contributions in `package.json`, `esbuild.mjs`, the workflows, and
what the documents claim about the code. Design documents: `docs/ROADMAP.md` (the plan and every user
decision, §9), `docs/ARCHITECTURE.md` (the design, decisions D1–D22), `docs/as-built/Mn.md` (what was
built, with deviations, measurements and open issues).

## How much review each part has had

Spend the effort where the last column is thin.

| Part | Built | Review so far |
|---|---|---|
| M0 language foundation | 2026-09-27 | three rounds, accepted by the user |
| M1 toolchain, projects | 2026-09-27 | three rounds (`as-built/M1.md`, *Review fixes*) |
| M2 IDE-mode core | 2026-09-28 | three rounds and a verification (`as-built/M2.md`) |
| M3 intelligence | 2026-09-29 | eleven rounds (`as-built/M3.md`) |
| M4 editing, holes | 2026-10-01 | fifteen rounds, a convergence pass, a final review (`as-built/M4.md`, *Review rounds*) |
| M5 idris2-lsp | 2026-10-02 | **one reviewer**, after the workflow's hit the API limit; read in full only the files listed in `as-built/M5.md`, *Review* |
| M6 check while typing | 2026-10-24 | **author only** (`as-built/M6.md`, *Review*) |
| Auto-save rule of M6 (`adb6d2b`) | 2026-10-24 | **author only** |
| Rename to Idris 2 Language Tools (`ab1e1ba`) | 2026-10-30 | **author only**; no fresh Marketplace listing yet |
| M7 goal panel | 2026-10-30 | **author only** (`as-built/M7.md`, *Review*) |
| M8 REPL, Query, `-- >>>` lenses | 2026-10-30 | **author only** (`as-built/M8.md`, *Review*) |
| All of the above | 2026-10-30 | review 1: 14 lanes, 5 angles, verifiers (`as-built/review-1.md`) |
| The fixes of review 1, with N1 and all of M20 | 2026-10-30 | **author only** |

A failed, stalled or rate-limited reviewer never counts as a clean round. Check that each reviewer
really finished before calling a round clean.

## Suggested lanes

One reviewer per lane, with the rule sections of `CLAUDE.md` it must hold the code to.

| Lane | Files | Hold it to |
|---|---|---|
| Processes and trust | `core/process.ts`, `core/trust.ts`, `features/consent`, the spawn paths of `backend/ide/pool.ts` and `backend/lsp/client.ts`, `toolchain/` | M1 and M2 rules: one runner, no shell, nothing in Restricted Mode, the gate before every spawn, the real path judged |
| Protocol and sessions | `backend/ide/{sexp,wire,protocol,session,transport}.ts`, `replCommand.ts` | M2, M3: codec facts in one place, ASCII requests, a load only through `IdeBackend.load`, nothing but evaluations to `eval` |
| Checks and unsaved text | `features/diagnostics`, `features/shadow`, `backend/ide/shadow.ts`, the `showsUnsavedCheck` path of `backend/ide/backend.ts` | M2, M6: stale states, the user's files never written, the check session's build directory untouched |
| Editing | `features/editing`, `backend/ide/edits.ts`, `core/idrisSyntax.ts`, `core/idrisLexer.ts`, `core/positions.ts` | M3, M4: names untrusted, an edit lands only where and when asked, always bracket, the layout refusal, one lexer |
| idris2-lsp | `backend/lsp`, `backend/registry.ts`, `features/backend` | M5: `LspAdmission`, the middleware, the contract suite. Least read so far: `client.ts` lifecycle, `backend.ts`, `edits.ts` beyond its bounds |
| Webview and holes | `features/goalPanel`, `src/webview`, `media/goalPanel.css`, `features/holes` | M7: the webview is untrusted, messages name only the state, no command re-implemented; M3's untrusted text |
| Intelligence and grammar | `features/intelligence`, `features/syntax`, `syntaxes/`, `language-configuration/` | M3: passive providers never load, positions only through `positions.ts`; every grammar rule traceable |
| REPL and doc-eval | `features/repl`, `backend/ide/replCommand.ts` `queryRefusal`, `features/eval/register.ts` `run` | M8: the gate before the terminal, one line typed, the allow-list, answers stay comments, Run all asks |
| Claims | `README.md`, `docs/guide.md`, `CHANGELOG.md`, the settings' descriptions | CLAUDE.md, *Working rules*: true of the code as built; epistemic tags never upgraded without a run |
| Tests | `test/`, the fakes, `.vscode-test.mjs` | Does a test fail when the rule it names breaks? A fake that drifted from the real tool hides bugs (`e2e/fakeParity.test.ts`, `e2e/protocolFacts.test.ts` guard it) |

Worth a specific look because no second reader has seen them: `pool.ts` `sendDisplayOptions`, the
`firstRequests` order, `EditingRunOptions` in `commands.ts`, `HoleStore.relist`, `savedSoon` against VS
Code's own `isShortAutoSaveDelay`, `backend/ide/shadow.ts`, `terminals.ts` `start` (it repeats by hand
what `pool.ts` `prepare` does for a session), `queryRefusal` against the compiler's parser, and
`answerReplacement`, which writes compiler text into the user's file.

## Hard constraints for every reviewer

These protect the user's machine and accounts. A reviewer that breaks one has failed, whatever it found.

- **At most one `idris2` or `idris2-lsp` process at a time, and one VS Code test instance.** The machine
  has 16 GB, and parallel compilers have taken it down. Reviewers in parallel must not each run them:
  give one lane the runs, or run them one after another. Count with `pgrep -f idris2_app/idris2.so`.
- Never run a compiler on the corpora or on Idris 2's libraries.
- Never touch the user's VS Code profile (`~/Library/Application Support/Code`). A manual run passes
  `--user-data-dir`, `--extensions-dir` and `--shared-data-dir`, each a short `/tmp/vi2-*` path.
- Do not commit, tag, push, publish or install anything. Publishing is the user's alone.
- Every pack command, starting its wrappers included, runs with
  `PACK_BIN_DIR=$HOME/.local/share/pack/bin`; nothing is installed, updated or removed with pack.
- No text of Yaffle is copied into the repository; recordings and generated files are never edited by hand.
- Never print or use a token from the conversation.
- On this machine `ls`, `grep` and `df` are aliases that misbehave: use `/bin/ls`, `/usr/bin/grep`, `/bin/df`.

## Gates

Run one at a time, in this order. The expected figures are from after the fixes of review 1.

```sh
npm run check-types && npm run lint
npm run test:unit                 # 3,161 passing, 1 pending
npm run test:grammar              # 195 passing
npm test                          # eleven suites, 180 tests
IDRIS2_E2E=1 npm run test:e2e     # 105 passing
PACK_BIN_DIR=$HOME/.local/share/pack/bin IDRIS2_LSP=$HOME/.local/share/pack/bin/idris2-lsp \
  npm run test:e2e:lsp            # 24 passing
npm run check:fixtures            # 120 checks, 0 failed
npm run docs:graph:check
npm run package
```

An e2e line `the panel's group is active, and VS Code still names …` is no failure (`as-built/M7.md`,
*Open issues*). A failure `more than 200 ms` in `holesView.test.ts` on a busy machine is a wall-clock guard
(`as-built/M8.md`, *Open issues*): run it alone before calling it a finding. A manual step of the milestones is in `docs/checklists/`; `M7.md` and `M8.md` there have
not yet been worked through by a person, and `M8.md` holds the one acceptance item that needs two
compilers at once. Publishing under the new name is on hold, and is the user's decision.

## Not findings

Decided by the user (ROADMAP §9), so report one only with a new argument:

- Always bracket an answer in place of a hole; keep the layout refusal; Q23 and Q24 (Evaluate and
  Refine Hole… run the elaborator scripts they reach, documented, not refused); Q25, Q26.
- IDE mode the default; stdio the default, the socket a user-settings opt-in; no resource limits by
  default; native Windows out of scope.
- `shadow.ipkg` in the shadow directory, for now; check while typing on by default;
  `idris2.lsp.logSeverity` `info`.
- The identity `etairi.idris2-language-tools`, no "unofficial" statement, the logo with gears for now.
- Plain TypeScript in the webview for now; the goal panel opened by hand.
- Query and the lenses send expressions, `:t` and `:doc`, on the shared `eval` session; Q23 covers Query
  and a single Run; Run all asks first.

Already recorded, so report one only if it is worse than recorded: the *Limitations* and *Open issues*
of each `docs/as-built/Mn.md`, and `docs/guide.md`, *Known limitations*.

## Reporting and fixing

Give each finding its exact place, the concrete input and state that make it fail, and how you know
(run it, or cite the source; say which). "Could not find a gap" is not "correct": say which of the two
you mean, and list what you did not read. Severity: **high** a wrong edit of the user's text, a security
boundary crossed, data lost, a crash; **medium** a wrong result or a refusal that blocks a normal use;
**low** the rest.

The bounded rule of M5 applies unless the user sets another: fix rounds until none finds a high or medium
issue, at most three, then one final review fixing only high findings and regressions. The rest is
recorded as known limitations. Findings of a review are fixed one at a time with a test that failed
before the fix, and milestones' as-built files record the rounds.
