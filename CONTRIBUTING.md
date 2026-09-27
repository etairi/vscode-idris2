# Contributing to vscode-idris2

Thank you for helping. This file explains how to build, test and debug the extension, and where
the design lives. Bug reports and feature requests go to the
[issue tracker](https://github.com/etairi/vscode-idris2/issues); **Idris 2: Report Issue…**
fills in the setup information for you.

## Project documents

- [docs/ROADMAP.md](docs/ROADMAP.md): milestones, verified facts about the compiler and
  `idris2-lsp` (§0), open questions, and an "As built" record per milestone.
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
- `idris2` (0.8.0 was used) only for the end-to-end suite, `npm run check:fixtures` and the
  lexer comparison. Unit, grammar and integration tests need no Idris installation: the
  integration suites use the fake `idris2`, `idris2-lsp` and `pack` in `test/fake-tools/`.

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
npm run test:corpus    # tokenise pinned real-world repositories (needs network)
IDRIS2_LEXER_ORACLE=1 npm run test:corpus   # also compare token by token with the Idris 2 lexer
npm run check:fixtures # idris2 --check / --dump-ipkg-json on every fixture and snippet
npm run docs:graph:check  # docs/ROADMAP.md §4 matches docs/milestones.yaml
```

Please run no more than one `idris2` process at a time; type-checking library code in
parallel uses a lot of memory. `check:fixtures` and the lexer comparison already run the
compiler one file at a time, and `IDRIS2=<path>` selects the binary (for example a wrapper that
adds a time limit).

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
  `idris2 --dump-ipkg-json` (`npm run check:fixtures`).

## Test corpora and licences

The corpus test fetches `edwinb/Yaffle`, `JankaGramofonomanka/idris-compiler-tools` and the
Idris 2 v0.8.0 libraries at pinned commits into the git-ignored `.corpus/`. Yaffle declares no
licence: never copy its text into this repository. Short excerpts of MIT or BSD-3 code may be
used as fixtures with an attribution header and an entry in
[test/fixtures/grammar/NOTICE.md](test/fixtures/grammar/NOTICE.md).

## Trying a packaged extension

To try a `.vsix` without touching your own VS Code profile, follow
[docs/checklists/M1.md](docs/checklists/M1.md): it installs the package into separate
`--user-data-dir`, `--extensions-dir` and `--shared-data-dir` directories.

## License

By contributing you agree that your contributions are licensed under the [MIT licence](LICENSE).
