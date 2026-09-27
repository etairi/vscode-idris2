# Idris 2 for Visual Studio Code (`vscode-idris2`)

**Status: milestone M1 — toolchain and project discovery, on top of M0's syntax layer. The
extension finds `idris2`, `idris2-lsp` and `pack`, reads their versions and tells you which
`.ipkg` a file belongs to, but it does not check code with the compiler yet: no diagnostics,
types, holes or interactive editing.** Those arrive milestone by milestone as laid out in
[`docs/ROADMAP.md`](docs/ROADMAP.md) (M2 connects to the compiler's IDE mode).

## What works today

The editing features in this first list work without an Idris installation. Activation waits
for no process; what the extension runs afterwards is described under
[Toolchain and projects](#toolchain-and-projects-m1).

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
  - **Idris 2: Open Settings** opens the Settings editor filtered to this extension (the
    `idris2.toolchain.*` settings below).
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

The manifest also declares the semantic token types `module` and `postulate`, and the
`vscode-languageclient` dependency, for later milestones (M3, M5). No code uses them yet.

## Toolchain and projects (M1)

- **Finding the tools.** For each of `idris2`, `idris2-lsp` and `pack`, a non-empty
  `idris2.toolchain.idris2Path` / `lspPath` / `packPath` is the only place looked at (an
  absolute path, on Windows one starting with a drive such as `C:\` or a `\\server\share`
  path, or a command name looked up on `PATH`; on Windows a name or path without an extension
  is tried with the extensions of `PATHEXT`, as `cmd.exe` does; if it names nothing, the tool
  is reported missing). Otherwise the extension searches `PATH`, then pack's directories (its
  bin directory, `~/.local/bin` unless `PACK_BIN_DIR` names another, where `~` is the `HOME`
  that pack itself reads, then the `bin` directory of pack's current collection if one exists),
  then on macOS and Linux `/opt/homebrew/bin` and `/usr/local/bin`, and on every platform
  `~/.idris2/bin`. Only absolute directories are searched (on Windows, with a drive or a
  `\\server\share` root: a `PATH` entry such as `\tools`, relative to the current drive, is
  skipped). `idris2.toolchain.preferPack` puts pack's directories before `PATH`. When nothing
  is found, the reason names any file that was found but cannot be run (e.g. one without its
  execute permission).
- **What it runs.** In a trusted workspace, after activation, on **Idris 2: Rescan Toolchain**,
  when an `idris2.toolchain.*` setting changes and when you grant trust: `idris2 --version`,
  and if that printed a version, `idris2 --ttc-version`, `--paths` and `--list-packages`; then
  `idris2-lsp --version` if a server was found; then `idris2 --dump-ipkg-json <file>`, with the
  file's absolute path, for the packages it needs to read whose `.ipkg` lies inside a
  workspace folder. If one of these probes of `idris2` runs out of time, the ones after it are
  not run. One process at a time, each started directly, without a shell (on Windows a
  `.cmd`/`.bat` file goes through a quoted `cmd.exe` command line, or is refused), with a 5 s
  limit (a process still running then is stopped together with the processes it started, as
  far as the operating system allows: see `docs/ROADMAP.md` M1 As built, *Processes*), in the
  tool's own directory, with `idris2.toolchain.env` added to its environment. Starting the
  compiler in a directory can run code found there: the Homebrew `idris2` 0.8.0 loaded a
  `libc.dylib` placed in the directory it was started in (tested on macOS), which is why
  `--dump-ipkg-json` is not started in the package's directory (the compiler changes into it
  only afterwards) and why nothing is run in an untrusted workspace. The extension never starts `pack` itself;
  but pack's own `idris2` and `idris2-lsp` in `~/.local/bin` are wrapper scripts that run pack
  every time they run, so probing a pack-installed compiler runs pack too (read in pack's
  source; pack was not installed during development, see `docs/ROADMAP.md` M1).
- **Language status.** Next to the language mode of an Idris file: `Idris 2 0.8.0 · syntax
  only` (no compiler backend exists before M2), or a warning `idris2 not found — Setup…` /
  `idris2 not working — Setup…`, or `Restricted Mode — toolchain detection disabled`. Its
  detail names the package the file belongs to. Clicking it opens **Idris 2: Show Commands…**,
  which lists the same commands as the **Idris 2** menu in the editor title bar of Idris files:
  - **Show Setup Information**: a read-only document with each tool's path and how it was
    found, every command run with its raw output and the values read from it, pack's
    directories and collection, whether `idris2-lsp` fits `idris2` (the "pair verdict": the
    same version text, `Idris2 API: …` against `Idris 2, version …`, or the same version with
    one commit hash abbreviated to different lengths; a heuristic), the packages
    in the workspace and the active file's package, module name and working directory. Of
    `idris2.toolchain.env` it shows the values only of the path variables (`PATH`, `PATHEXT`,
    `CHEZ`, `IDRIS2_*`, `PACK_*`, `XDG_*`, with a `user:password@` in a URL masked) and the
    names of the others, since **Report Issue…** puts the document into an issue.
  - **Rescan Toolchain**.
  - **Install Idris 2…** (macOS: opens a terminal with `brew install idris2` typed in; elsewhere:
    opens Idris 2's installation instructions), **Install pack…** (types pack's documented
    install command; on Windows opens pack's instructions) and **Install or Update idris2-lsp
    with pack** (types `<pack> install-app idris2-lsp`, with the path of the pack found; offered
    once pack is found). pack installs the `idris2-lsp` of its current collection and leaves an
    installed one as it is, so to move to a newer server, switch collections first (`pack switch
    latest`, see pack's README). **Nothing is executed:** the command is typed without a line
    break, and runs only if you press Enter; a pack path containing a control character, which
    the terminal would act on while it is typed, or (outside Windows) a backslash, which fish
    reads differently inside quotes, is refused with a warning instead. The terminal starts in
    your home directory, not in the workspace folder: pack reads the `pack.toml` of the
    directory it runs in and of every directory above it, so a project's `pack.toml` could
    otherwise choose what gets built. Without a known home directory no terminal is opened.
  - **Show Output**, **Open Settings**, **Open Idris 2 Documentation**, and **Report Issue…**,
    which opens VS Code's issue reporter with Setup Information in the body (or copies the
    report to the clipboard when the issue reporter is not available).
- **Warnings.** When `idris2` is not found, one warning with **Install Idris 2…**, **Set Path**
  and **Show Output**; when `idris2-lsp` likely does not fit `idris2`, one warning with the
  reason. Each is shown once per window for the same condition.
- **Packages.** A file belongs to the package of the nearest `.ipkg` found by walking up from its
  folder to the root of the file system — the compiler's own search, so it also finds an
  `.ipkg` above the workspace folder — and otherwise is a loose file. When a directory holds
  several `.ipkg` files, the compiler uses whichever its directory listing returns first; the
  language status turns into a warning then. The package is read with `idris2 --dump-ipkg-json`,
  or, without a usable compiler, in Restricted Mode, or when the `.ipkg` lies outside the
  workspace folders (workspace trust does not cover the folders above; the language status and
  Setup Information say so), with a built-in reader that follows the compiler's `.ipkg` grammar
  (it does not check that the listed modules and `main` exist). Only a regular file of at most
  256 KiB is read, by either; a directory, a pipe or a device named `*.ipkg` is reported as
  unreadable. Creating, deleting or moving a module file or a folder in the workspace reads the
  packages it can affect again, and updates the list of packages.
- **Literate files with a double extension** (`Main.idr.md`, `Notes.lidr.tex`, and the other
  literate extensions of the compiler: `.markdown`, `.dj`, `.org`, `.ltx`, `.typ`) count as Idris
  documents for the extension's commands and menus while keeping their Markdown, LaTeX, … mode.
  A plain `.md` or `.tex` file does not count (planned for M12). The Idris ranges of Expand
  Selection are not offered in these files yet (their host language's still are).
- **Walkthrough.** **Get Started with Idris 2**, among the walkthroughs of VS Code's Welcome
  page: find the toolchain, install what is missing, open a project.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `idris2.toolchain.idris2Path` | `""` | the `idris2` to use; empty: search as above |
| `idris2.toolchain.lspPath` | `""` | the `idris2-lsp` to use; empty: search |
| `idris2.toolchain.packPath` | `""` | the `pack` to use; empty: search |
| `idris2.toolchain.preferPack` | `false` | search pack's directories before `PATH` |
| `idris2.toolchain.env` | `{}` | environment variables for every tool the extension runs; the search reads `PATH` (and `PATHEXT` on Windows) and pack's `HOME`, `XDG_*` and `PACK_*` directory variables from the same environment |

A leading `~` in a path setting is your home directory (left as it is when the Extension Host
has none, e.g. with an empty `HOME`), and one pair of double quotes around a path setting is
ignored (as Windows' "Copy as path" adds them); `env` values are used as written.

### Restricted Mode

In an untrusted workspace the extension runs no program at all — no version probe, no
`--dump-ipkg-json` — and reads `.ipkg` files with its built-in reader; highlighting, snippets
and editing support work as usual (`capabilities.untrustedWorkspaces.supported: "limited"`).
VS Code ignores workspace values of `idris2Path`, `lspPath`, `packPath` and `env` there. Granting
trust starts a scan. The install commands stay available: they only type a command into a
terminal that starts in your home directory, where nothing of the workspace applies.

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
- No Idris toolchain is needed to build, package, or run the unit, grammar and integration
  tests: the integration suites use the fake tools in `test/fake-tools`. The e2e suite
  (`npm run test:e2e`), `npm run check:fixtures` and the lexer comparison below need `idris2`
  (Idris 2 0.8.0 was used). `idris2-lsp` and `pack` were not installed on the development
  machine; everything about them was built from their sources and documentation and tested
  against fakes.

## Build, run, test

```sh
npm ci
npm run compile      # tsc --noEmit, eslint, esbuild → dist/extension.js, dist/goalPanel.js
npm run watch        # the default build task in VS Code (tsc + esbuild in watch mode)
npm run test:unit    # mocha on Node: test/unit/**, no VS Code involved
npm run test:grammar # TextMate tests: snapshots, targeted scope assertions, a timing check
npm test             # @vscode/test-cli: downloads VS Code into .vscode-test/ and runs the
                     # integration suites (integration, simple-ipkg, toolchain-path), one VS
                     # Code instance each, with the fake tools of test/fake-tools
npm run test:e2e     # the e2e suite: the real idris2 on PATH, on the simple-ipkg fixture
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

Each test suite has its own profile under `.vscode-test/` (`user-data`, `user-data-ipkg`,
`user-data-path`, `user-data-e2e`), rewritten before every run. The Electron IPC socket created
there must have a path shorter than 103 characters, so keep the checkout at a short path (F17 in
`docs/ROADMAP.md` §0); `.vscode-test.mjs` stops with a message if it is too long. It also
writes `"chat.disableAIFeatures": true` into each test profile's settings: VS Code's chat input
is itself a code editor, and when the test window started behind another application it
received the editor commands meant for the test documents. To try a packaged `.vsix` without
touching your own VS Code profile, see [`docs/checklists/M1.md`](docs/checklists/M1.md).

## Privacy

The extension itself makes no network requests and collects no telemetry. It runs the tools it
finds, though, and pack's `idris2` and `idris2-lsp` wrappers run `pack` each time (`pack
app-path`, and for `idris2` three more path queries), which can reach the network: in pack's
source, such a query runs `git` against the package database's repository when that database
has not been fetched yet, and `git ls-remote` when a package of the collection or of pack's
configuration names a `fetch-latest:` commit (or a `latest:` one not fetched before) [read in
idris2-pack `6baee7d`; pack was not installed during development]. **Open Idris 2
Documentation** and, outside macOS, **Install Idris 2…** and (on Windows) **Install pack…**
hand a fixed URL to VS Code when you run them. The install commands type commands that use the
network (`brew`, `curl`, `pack`) into a terminal; they run only if you press Enter. **Report
Issue…** opens VS Code's issue reporter, which sends nothing unless you submit it. Network
access happens otherwise only at development time: `npm ci` fetches the packages in `package-lock.json`, `npm test` downloads a
VS Code build into `.vscode-test/`, and `npm run test:corpus` fetches the pinned corpora from
GitHub.
