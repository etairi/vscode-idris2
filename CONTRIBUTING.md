# Contributing to vscode-idris2

Thank you for helping. This file explains how to build, test and debug the extension, and where
the design lives. Bug reports and feature requests go to the
[issue tracker](https://github.com/etairi/vscode-idris2/issues); **Idris 2: Report Issue…**
fills in the setup information for you.

## Project documents

- [README.md](README.md) and [docs/guide.md](docs/guide.md): the user-facing overview and the
  user guide (each feature, setting and limitation in detail).
- [docs/ROADMAP.md](docs/ROADMAP.md): milestones, verified facts about the compiler and
  `idris2-lsp` (§0), open questions and the user's decisions (§9), and a short status per
  finished milestone.
- [docs/as-built/](docs/as-built/README.md): an "As built" record per finished milestone — how
  the code departs from the milestone text and the design, measurements, reviews and test runs.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): source layout, the backend abstraction,
  coordinates, settings, test layers and design decisions.
- [docs/landscape.md](docs/landscape.md): survey of existing Idris tooling for VS Code.
- [src/README.md](src/README.md) and [test/README.md](test/README.md): what each source and test
  folder contains.
- [test/grammar/idris2-scopes.md](test/grammar/idris2-scopes.md): the grammar's scopes and
  known limits.

## Requirements

- Node.js 24 and npm.
- Visual Studio Code 1.138 or newer.
- `idris2` (0.8.0 was used) only for the end-to-end suite, `npm run check:fixtures`,
  `npm run record:transcripts` and the lexer comparison. Unit, grammar and integration tests
  need no Idris installation: the integration suites use the fake `idris2`, `idris2-lsp` and
  `pack` in `test/fake-tools/`, and the fake `idris2` answers IDE-mode requests with the replies
  recorded from the real compiler (`test/fixtures/transcripts/`).

## Build and run

```sh
npm ci
npm run compile      # type-check, lint, bundle → dist/
npm run watch        # the default build task in VS Code
npm run package      # vsce package → vscode-idris2-<version>.vsix
```

In VS Code, **Run Extension** (F5) starts an Extension Development Host with the bundle from
`dist/`. **Extension Tests** runs the `integration` suite of `.vscode-test.mjs` under the
debugger.

## Tests

```sh
npm run test:unit      # mocha on Node, no VS Code
npm run test:grammar   # TextMate snapshots, scope assertions and a timing budget
npm test               # integration suites in VS Code (downloaded into .vscode-test/)
npm run test:e2e       # end-to-end against the real idris2 on PATH
npm run test:corpus    # tokenise pinned real-world repositories (needs network); CI runs it
IDRIS2_LEXER_ORACLE=1 npm run test:corpus   # also compare token by token with the Idris 2 lexer
npm run check:fixtures # idris2 --check / --dump-ipkg-json on every fixture and snippet
npm run docs:graph:check  # docs/ROADMAP.md §4 matches docs/milestones.yaml
npm run record:transcripts # re-record the IDE-mode transcripts with the idris2 on PATH
```

`npm test` runs ten suites, each in its own VS Code instance: `integration`, `simple-ipkg` and
`toolchain-path` (toolchain and project discovery), and `diagnostics` (the `broken` workspace over
the socket transport, chosen in the suite's user settings), `loose-stdio` (loose files over standard
input and output, the default, in a workspace whose own settings ask for the socket in vain),
`consent` (a package above the opened folder, which needs the user's consent), `intelligence`
(hover, definition, documentation, semantic tokens on `simple-ipkg`), `intelligence-loose` (inlay
hints, completion, evaluation and the keyboard shortcuts on `broken`), `editing` (the interactive
editing commands, their light bulb and cycling, and `saveBeforeAction` on `broken`) and `holes` (the
Holes view, Next / Previous Hole, List Holes and Show Keybindings on the `holes` workspace). The
fake compiler tells a checking process from an evaluating one by its build directory and answers
each only from the recordings made in that role, ignoring queries such as `:name-at` when it matches
a session's history against the recordings; `FAKE_IDRIS2_REQUEST_LOG` logs the requests each process
read, and `FAKE_IDRIS2_IDE_DELAY=<command>=<ms>` holds back the answers to a command's requests. The
e2e suite runs the protocol facts of `docs/ROADMAP.md` §0 against the real compiler, the extension's
own sessions (over stdio, and over the socket when opted into), a comparison of the fake compiler
with the real one, and the M3 and M4 features.

**One lexer.** `src/core/idrisLexer.ts` is the compiler's lexer ported rule by rule. The syntax
features (`lex()`) run it on whole texts, and the editing commands' line reader
(`src/core/idrisSyntax.ts`) runs it a line at a time; the reader has no lexeme rules of its own. So
change a lexeme rule there only, and do not copy one elsewhere. Three checks guard it:
`test/unit/idrisSyntaxLines.test.ts` (unit) and the corpus suite *line reader against lex*
(`npm run test:corpus`, in CI) compare the reader with `lex()`; `test/unit/syntaxLexer.test.ts`
pins the rules; and `IDRIS2_LEXER_ORACLE=1 npm run test:corpus` (local only, it needs `idris2`)
compares `lex()` with the compiler's own lexer. Since the reader and `lex()` share their rules, the
comparison cannot see a rule broken in both; the other two can. The layout blocks the editing
commands look for are listed, with the line of `src/Idris/Parser.idr` each comes from, above
`ENTRY_KEYWORDS` in `src/core/idrisSyntax.ts`; a new one needs its citation and a test in
`test/unit/idrisSyntax.test.ts`.

Please run no more than one `idris2` process at a time; type-checking library code in
parallel uses a lot of memory. `check:fixtures`, `record:transcripts` and the lexer comparison
already run the compiler one process at a time, and `IDRIS2=<path>` selects the binary (for
example a wrapper that adds a time limit). The one e2e test that runs two at once
(`test/e2e/e21.test.ts`: one IDE-mode session beside one `idris2 --build`) uses a one-module
fixture.

Each integration suite uses its own profile under `.vscode-test/`. VS Code's IPC socket path in
that profile must stay under 103 characters, so keep the checkout at a short path;
`.vscode-test.mjs` stops with a message if it is too long.

## Grammar and generated files

- `syntaxes/idris2.tmLanguage.json` is generated from `syntaxes/src/idris2.grammar.mjs`
  (`npm run build:grammar`); `language-configuration/*.json` from
  `scripts/build-language-configuration.mjs` (`npm run build:language-configuration`). Edit the
  generator, never the output; the tests fail if the output is out of date.
- Every lexical rule should be traceable to the Idris 2 lexer or parser, or to an
  `idris2 --check` experiment recorded in the tests.
- After a grammar change, run `UPDATE_SNAPSHOTS=1 npm run test:grammar`, read the snapshot diff
  line by line, and explain the changes in your commit message.
- Every `.idr`/`.lidr` fixture must pass `idris2 --check` and every `.ipkg` fixture
  `idris2 --dump-ipkg-json` (`npm run check:fixtures`). The deliberately broken files of
  `test/fixtures/workspaces/broken` are the exception: `EXPECTED_PROBLEMS` in
  `scripts/check-fixtures.mjs` lists the errors each must report, and the check fails when one
  reports anything else.

## IDE-mode transcripts

`test/fixtures/transcripts/<version>/` holds IDE-mode sessions recorded from the real compiler
by `npm run record:transcripts` (format and scenarios in
[test/fixtures/transcripts/README.md](test/fixtures/transcripts/README.md)). They are the ground
truth for the fake compiler and the protocol tests. Each transcript carries the SHA-256 of the
fixture files it read, and the fake answers only while they match: after changing such a
fixture, record its scenarios again (`npm run record:transcripts <scenario> …`) and review the
diff. A scenario recorded in the evaluation role (`eval-*`) is started with the `eval` session's
command line (`--build-dir …/.vscode-idris2-eval`), and the fake replays it only to such a
process.

## Test corpora and licences

The corpus test fetches `edwinb/Yaffle`, `JankaGramofonomanka/idris-compiler-tools` and the
Idris 2 v0.8.0 libraries at pinned commits into the git-ignored `.corpus/`. Yaffle declares no
licence: never copy its text into this repository. Short excerpts of MIT or BSD-3 code may be
used as fixtures with an attribution header and an entry in
[test/fixtures/grammar/NOTICE.md](test/fixtures/grammar/NOTICE.md).

## Measuring the check session

`scripts/measure-first-load.mjs` (macOS only) measures what the IDE-mode `check` session costs on
a package: the first load, reloads and saves, memory, and the latency of the cheap requests. It
starts the compiler as the extension does, one process at a time, and only in a copy of the
package under `--work`:

```sh
node scripts/measure-first-load.mjs --package <dir> --closures   # import closures; no compiler
node scripts/measure-first-load.mjs --package <dir> --work /tmp/<empty dir> --out /tmp/<file>.json
```

The script's header lists the steps, options and safety limits. Use a package of your own: the
project does not run `idris2` on the Idris 2 libraries (`CLAUDE.md`). The measurements taken
before M3, their method and their limits are in
[docs/measurements/first-load.md](docs/measurements/first-load.md).

## Trying a packaged extension

To try a `.vsix` without touching your own VS Code profile, follow
[docs/checklists/M4.md](docs/checklists/M4.md) (or `M1.md` … `M3.md`): it installs the package
into separate `--user-data-dir`, `--extensions-dir` and `--shared-data-dir` directories.

## License

By contributing you agree that your contributions are licensed under the [MIT licence](LICENSE).
