# `test/` layout

The testing layers of `docs/ARCHITECTURE.md` §12 and the `test/` tree of §2, annotated with the
milestone (`docs/ROADMAP.md` §5) that adds each part. Parts marked **M0** or **skeleton** exist.

| Layer | Runner | Needs | Exists | Added by |
|---|---|---|---|---|
| Unit | mocha on Node, `npm run test:unit` | nothing | **M0** (list below) | decoders, parsers, `IdeSession`/`FakeTransport`: M1, M2, M9 (CLI parser), M11, M13 |
| Grammar | `vscode-textmate` + `vscode-oniguruma` snapshots, `npm run test:grammar` | nothing | **M0** (`grammar/`, harness `grammar/harness.ts`) | injections: M12 |
| Integration | `@vscode/test-cli` (Electron), `npm test`, one suite per fixture workspace | VS Code download | **M0** (suite `integration` on `fixtures/workspaces/loose-file`) | fake compiler / fake LSP driven suites: M2, M5 and every UI milestone |
| E2E | same runner, `IDRIS2_E2E=1` | real `idris2` (+ `idris2-lsp`) | no | M1 (first: toolchain discovery against the real `idris2`), then every milestone adds at least one |
| Contract | mocha suite parameterised over backends | as above | no | whichever of M4/M5 ships second |
| Manual | `docs/checklists/Mn.md` | — | **M0** (`docs/checklists/M0.md`) | each milestone |

```
test/
├─ unit/                      M0        mocha on Node, no vscode import allowed
├─ grammar/                   M0        TextMate tests: harness.ts, idris2/lidr/ipkg tests, snapshots/,
│                                       corpus.test.ts (npm run test:corpus), perf.test.ts,
│                                       idris2-scopes.md (scope inventory + limits, kept in sync by a test)
├─ corpus/                    M0        corpus.json (pinned repositories, fetched into .corpus/),
│                                       lexer-oracle/LexDump.idr (the 0.8.0 lexer as reference)
├─ integration/               M0        @vscode/test-cli suites per fixture workspace
├─ e2e/                       M1        real idris2 (IDRIS2_E2E=1); M2 adds IDRIS2_RECORD=1 transcript refresh
├─ fake-idris2/               M0 (handshake + :version), M2 (transcript replay over stdio + socket)
├─ fake-lsp/                  M5        Node script (vscode-languageserver) replaying JSON-RPC
└─ fixtures/
   ├─ transcripts/<idris2-version>/*.jsonl   M2   recorded IDE-mode sessions
   ├─ cli/<idris2-version>/*.txt              M9   recorded --check/--build output
   ├─ grammar/*.idr, *.lidr, *.ipkg           M0   tokenisation fixtures (npm run check:fixtures:
   │                                                idris2 --check / --dump-ipkg-json); ipkg-sources/
   │                                                holds the prose-only modules the .ipkg fixtures
   │                                                list; NOTICE.md attributes the excerpts
   └─ workspaces/
      ├─ loose-file/          M0        no ipkg; checked with idris2 0.8.0 (`--check`, exit 0):
      │                                 Hello.idr (imports Data.Vect), Vlen.idr (the selection-range
      │                                 example), Lit.lidr (bird tracks with prose); Notes.md (plain
      │                                 Markdown, the non-Idris document)
      ├─ simple-ipkg/         M1        sourcedir = "src", depends = contrib, two modules (M2 adds the load test)
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
  asserts only a coarse 2,000 ms bound until the CI median is known (ROADMAP E6).
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
  `vscode.languages.match`) on real documents. The `idris2.isIdrisDocument` context key has no
  read-back API, so its logic is covered by the unit test only.
- `selectionRanges.test.ts` — `vscode.executeSelectionRangeProvider` on `Vlen.idr` (ROADMAP M0
  acceptance) and `Lit.lidr`. VS Code merges its own ranges (such as the whole line) into the
  chain, so the expected ranges are asserted in order, not as the complete chain.
- Help commands: all three are checked to be registered; Show Output and Open Settings are run.
  Open Idris 2 Documentation is not run, because it would open the system browser.
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
- `.vscode-test.mjs` passes `--user-data-dir=<checkout>/.vscode-test/user-data` explicitly —
  the directory `@vscode/test-electron` would choose anyway — because the Electron IPC socket
  path is limited to 103 characters (F17 in `docs/ROADMAP.md` §0); the protection is the short
  checkout path, and the flag is where a shorter one would be substituted.
- `.vscode-test.mjs` also writes `{"chat.disableAIFeatures": true}` to that profile's
  `User/settings.json` before each run. The chat input VS Code 1.139.1 builds at startup is a
  code editor, and when the test window starts without OS focus it kept the editor focus, so
  editor commands went to it and the Enter tests failed (observed 2026-09-27; see the comment
  in the file).
- No test may depend on a wall-clock timeout below 1 s (ARCHITECTURE §12). The one deliberate
  exception is the activation bound of 250 ms on the development machine (1,000 ms under CI),
  which the M0 acceptance calls for.
