# `test/` layout

The testing layers of `docs/ARCHITECTURE.md` §12 and the `test/` tree of §2, annotated with the
milestone (`docs/ROADMAP.md` §5) that adds each part. Only the parts marked **skeleton** exist.

| Layer | Runner | Needs | Exists | Added by |
|---|---|---|---|---|
| Unit | mocha on Node, `npm run test:unit` | nothing | **skeleton** (`unit/disposable.test.ts`, `unit/errors.test.ts`) | codecs, positions, decoders, parsers, `IdeSession`/`FakeTransport`: M0 (`positions`), M1, M2, M9 (CLI parser), M11, M13 |
| Grammar | `vscode-textmate` + `vscode-oniguruma` snapshots, `npm run test:grammar` | nothing | no (no script yet) | M0 |
| Integration | `@vscode/test-cli` (Electron), `npm test`, one suite per fixture workspace | VS Code download | **skeleton** (suite `integration` on `fixtures/workspaces/loose-file`) | fake compiler / fake LSP driven suites: M2, M5 and every UI milestone |
| E2E | same runner, `IDRIS2_E2E=1` | real `idris2` (+ `idris2-lsp`) | no | M1 (first: toolchain discovery against the real `idris2`), then every milestone adds at least one |
| Contract | mocha suite parameterised over backends | as above | no | whichever of M4/M5 ships second |
| Manual | `docs/checklists/Mn.md` | — | no | each milestone |

```
test/
├─ unit/                      skeleton  mocha on Node, no vscode import allowed
├─ grammar/                   M0        TextMate snapshot tests
├─ integration/               skeleton  @vscode/test-cli suites per fixture workspace
├─ e2e/                       M1        real idris2 (IDRIS2_E2E=1); M2 adds IDRIS2_RECORD=1 transcript refresh
├─ fake-idris2/               M0 (handshake + :version), M2 (transcript replay over stdio + socket)
├─ fake-lsp/                  M5        Node script (vscode-languageserver) replaying JSON-RPC
└─ fixtures/
   ├─ transcripts/<idris2-version>/*.jsonl   M2   recorded IDE-mode sessions
   ├─ cli/<idris2-version>/*.txt              M9   recorded --check/--build output
   ├─ grammar/*.idr                            M0   tokenisation corpus (also idris2 --check'ed in CI)
   └─ workspaces/
      ├─ loose-file/          skeleton  no ipkg; Hello.idr imports Data.Vect (checked with idris2 0.8.0)
      ├─ simple-ipkg/         M1        sourcedir = "src", depends = contrib, two modules (M2 adds the load test)
      ├─ multi-module/        M9        one error in src/Sub.idr (build-task acceptance; no earlier suite needs it)
      ├─ broken/              M2, M4    type + coverage errors; Clean.idr, Plain.idr, Ambig.idr
      ├─ literate/            M3 (Lit.lidr), M4 (Lit2.lidr), M12 (Lit3.lidr and the .md, .tex, .org, .typ hosts)
      └─ golden-tests/        M10       Test.Golden layout
```

ARCHITECTURE §12 lists the fixture workspaces and recorded fixtures without milestones; the
milestones given for them above are inferred from the first suite that needs each one
(ROADMAP §5) and may move.

Conventions already in force:

- mocha's `tdd` interface (`suite` / `test`) everywhere, both on Node and in the Extension Host.
- Unit tests import from `../../src/...` and must not import `vscode`.
- Tests are compiled by `tsc` into `out/` (`npm run compile-tests`); `.vscode-test.mjs` and
  `test:unit` run the compiled `.js` files.
- `.vscode-test.mjs` passes `--user-data-dir=<checkout>/.vscode-test/user-data` explicitly —
  the directory `@vscode/test-electron` would choose anyway — because the Electron IPC socket
  path is limited to 103 characters (F17 in `docs/ROADMAP.md` §0); the protection is the short
  checkout path, and the flag is where a shorter one would be substituted.
- No test may depend on a wall-clock timeout below 1 s (ARCHITECTURE §12).
