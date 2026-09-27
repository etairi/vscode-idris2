# Idris 2 for Visual Studio Code (`vscode-idris2`)

**Status: milestone M0 — the syntax layer and the engineering harness. The extension does not
run the Idris 2 compiler yet: no diagnostics, types, holes or interactive editing.** Those arrive
milestone by milestone as laid out in [`docs/ROADMAP.md`](docs/ROADMAP.md) (M1 finds the
toolchain, M2 connects to the compiler's IDE mode).

## What works today

Everything below works without an Idris installation. The extension starts no process and
reads no file when it activates.

- **Languages.** `idris2` (`.idr`), `lidr` (`.lidr`, bird-track literate Idris) and `ipkg`
  (`.ipkg`). If another extension also claims `.idr` or the language id `idris2` (for example
  `j-nava.idris2-language-support`), disable it: two contributions for one language conflict.
- **Highlighting** (TextMate grammars `source.idris2`, `source.idris2.literate`, `source.ipkg`),
  written from the Idris 2 compiler's own lexer and parser (Idris 2 v0.8.0 and master
  `1c630e6`). It covers `%`-directives, `?hole` names, `failing` blocks, `\case`, the `0`/`1`
  multiplicities of binders, totality and visibility modifiers, the declaration keywords,
  string interpolation `"\{…}"`, multi-line `"""` strings, raw `#"…"#` strings, `|||`
  documentation comments and nested `{- -}` comments, following the lexer's comment rules
  exactly (`-->` is a comment, `--}` is not). Idris 1's `class`, `instance`, `codata`, `dsl`
  and `syntax` are ordinary identifiers. The scopes are listed in
  [`test/grammar/idris2-scopes.md`](test/grammar/idris2-scopes.md), together with the
  grammar's known limits. In `.lidr` files, a line that starts with `>` or `<` followed by one
  whitespace character or by nothing is highlighted as Idris, and every other line is prose,
  as the compiler reads them. The compiler reads a prose line as an empty line, so a bracket,
  block comment or multi-line string left open on one code line is still open on the next code
  line, and the highlighting follows it there. In `.ipkg` files, all fields the compiler accepts are recognised, including `datadir`
  (only Idris 2 master accepts it).
- **Editing.**
  - Comment toggling: `--` everywhere, and `{- -}` in `.idr` and `.ipkg`. `.lidr` has no block
    comment, because Toggle Block Comment would place `{-` before a `>` marker. Over several
    code lines that turns the first line into prose and leaves `-}` on a code line, which
    `idris2 --check` rejects; over a single code line the file still checks, but the line has
    silently become prose and dropped out of the program.
  - Bracket pairs `()`, `[]` and `{}`. Typing `{-` gives `{- -}`, and `'` is never auto-closed,
    because of primes such as `x'`.
  - Indentation-based folding for `.idr`.
  - Pressing Enter after a line ending in `where`, `do`, `of`, `let`, `\case`, `=`, `=>` or `->`,
    or after a `mutual`/`failing`/`namespace`/`parameters`/`using` header, indents the next
    line. Nothing re-indents existing lines.
  - In `.lidr`, Enter on a code line continues the `> ` (or `< `) marker and keeps the
    indentation after it (up to 32 spaces).
  - Words include `?holes` and primes. Double-click and Ctrl+D select `?hole` and `x'` whole,
    because the extension sets `editor.wordSeparators` for `[idris2]` and `[lidr]` to VS Code's
    default without `'` and `?`.
- **Snippets.** Idris: `module`, `data`, `record`, `interface`, `implementation`, `case`,
  `with`, `where`, `do`, `let`, `\case`, `failing`, `namespace`, `parameters`, `%default`,
  `main`. `.ipkg`: `package`, `executable`. `npm run check:fixtures` expands each one with its
  defaults (every option of a choice) and checks it with `idris2 --check` or `--dump-ipkg-json`.
- **Expand Selection** (Shift+Alt+→, ⌃⇧⌘→ on macOS) in `.idr` and `.lidr`. The ranges are
  syntactic, from a port of the compiler's lexer: token, then the enclosing bracket, string or
  interpolation, then layout blocks, then the declaration (a signature with its clauses), then
  the file. On `vlen (x :: xs) = ?rhs` it grows from `x` to `x :: xs`, then `(x :: xs)`, then
  the clause.
- **Help commands**, which need no compiler:
  - **Idris 2: Show Output** reveals the "Idris 2" log.
  - **Idris 2: Open Settings** opens the Settings editor filtered to this extension. It has no
    settings of its own yet.
  - **Idris 2: Open Idris 2 Documentation** asks VS Code to open
    <https://idris2.readthedocs.io/en/latest/> in the browser.
- **Editor defaults** for `[idris2]` and `[lidr]`:
  - `editor.tabSize: 2` and `editor.insertSpaces: true`.
  - `editor.semanticHighlighting.enabled: true`, for the semantic tokens later milestones
    provide.
  - `editor.unicodeHighlight.ambiguousCharacters: false`, so Greek and mathematical identifiers
    are not boxed.
  - `editor.wordSeparators`, as described above.
  - For `[lidr]` only, `files.eol: "\n"`: idris2 0.8.0 joins a line that ends in CRLF to the
    next one in a `.lidr` file, so a `.lidr` saved with Windows line breaks does not compile.
    The setting only decides for text without line breaks (a new file); a file that has line
    breaks keeps the kind most of them are, so convert an existing CRLF file with the `CRLF`
    item in the status bar.
- **Restricted Mode.** The extension runs in untrusted workspaces
  (`capabilities.untrustedWorkspaces.supported: true`), because nothing it does today executes
  workspace content.

The manifest also declares the semantic token types `module` and `postulate`, and the
`vscode-languageclient` dependency, for later milestones (M3, M5). No code uses them yet.

## Licence and repository

- Licensed under the [MIT licence](LICENSE). The grammar test fixtures include short excerpts
  of MIT- and BSD-3-licensed Idris code, attributed in
  [`test/fixtures/grammar/NOTICE.md`](test/fixtures/grammar/NOTICE.md). They are not part of
  the packaged extension.
- Source: <https://github.com/etairi/vscode-idris2>.
- The `publisher` field is `etairi`, provisionally: it makes local `vsce package` builds possible.
  A Marketplace publisher with that id has not been created yet, so nothing has been published
  (`docs/ROADMAP.md` M15).

## Requirements

- Node.js 24 and npm (developed with Node v24.13.0, npm 11.11.0).
- Visual Studio Code ≥ 1.138 (`engines.vscode`). Developed and tested with 1.139.1.
- No Idris toolchain is needed to build, test or package the extension. Two optional checks use
  one (Idris 2 0.8.0 was used): `npm run check:fixtures` and the lexer comparison below.

## Build, run, test

```sh
npm ci
npm run compile      # tsc --noEmit, eslint, esbuild → dist/extension.js, dist/goalPanel.js
npm run watch        # the default build task in VS Code (tsc + esbuild in watch mode)
npm run test:unit    # mocha on Node: test/unit/**, no VS Code involved
npm run test:grammar # TextMate tests: snapshots, targeted scope assertions, a timing check
npm test             # @vscode/test-cli: downloads VS Code into .vscode-test/ and runs
                     # test/integration/** in an Extension Host on the loose-file fixture
npm run package      # vsce package → vscode-idris2-<version>.vsix (runs check-types, lint and
                     # the production bundle first, via vscode:prepublish)
```

Grammar and fixture tooling:

```sh
npm run test:corpus            # fetches pinned real-world repositories (needs network; see
                               # test/corpus/corpus.json) into .corpus/, tokenises them all, and
                               # checks that each .idr file tokenises the same as bird-track code
IDRIS2_LEXER_ORACLE=1 npm run test:corpus
                               # also compares the grammar with the Idris 2 lexer, token by
                               # token; needs idris2 with its `idris2` and `contrib` packages
                               # (IDRIS2=<path> picks the binary)
npm run check:fixtures         # idris2 --check / --dump-ipkg-json on every fixture and every
                               # snippet expansion (needs idris2)
npm run build:grammar          # regenerate syntaxes/idris2.tmLanguage.json from syntaxes/src/
npm run build:language-configuration   # regenerate language-configuration/*.json
UPDATE_SNAPSHOTS=1 npm run test:grammar   # rewrite snapshots; review the diff before committing
npm run docs:graph:check       # ROADMAP §4 graph matches docs/milestones.yaml (docs:graph rewrites it)
```

The corpus test reads `edwinb/Yaffle`, `JankaGramofonomanka/idris-compiler-tools` and the
Idris 2 v0.8.0 libraries at pinned commits. Yaffle declares no licence, so it is only fetched
into the git-ignored `.corpus/` and never copied into this repository.

In VS Code, **Run Extension** (F5) launches an Extension Development Host with the bundle from
`dist/`; **Extension Tests** is wired to the `integration` suite of `.vscode-test.mjs` through
js-debug's `testConfiguration` setting (present in VS Code 1.139; this launch configuration has
not been exercised by an automated run). The recommended extensions in
`.vscode/extensions.json` provide the eslint integration, the esbuild problem matcher used by
the watch task, and the Test Explorer integration for `.vscode-test.mjs`.

The integration tests pass `--user-data-dir=<checkout>/.vscode-test/user-data` explicitly. That
is the same directory `@vscode/test-electron` uses by default; the Electron IPC socket created
there must have a path shorter than 103 characters, so keep the checkout at a short path (F17 in
`docs/ROADMAP.md` §0). Before each run, `.vscode-test.mjs` writes
`"chat.disableAIFeatures": true` into that test profile's settings. VS Code's chat input is
itself a code editor, and when the test window started behind another application it received
the editor commands meant for the test documents. To try a packaged `.vsix` without touching
your own VS Code profile, see [`docs/checklists/M0.md`](docs/checklists/M0.md).

## Privacy

The extension makes no network requests and collects no telemetry. **Open Idris 2
Documentation** hands a fixed URL to VS Code when you run it. Network access happens only at
development time: `npm ci` fetches the packages in `package-lock.json`, `npm test` downloads a
VS Code build into `.vscode-test/`, and `npm run test:corpus` fetches the pinned corpora from
GitHub.
