# Idris tooling landscape for VS Code (survey, 2026-09-23)

This document records what exists today, what was verified, and how. It is the factual
basis for the roadmap in `ROADMAP.md`. Every non-trivial claim carries one of these tags:

- **[live]** — verified by running it on this machine (macOS arm64, `idris2` 0.8.0 from Homebrew).
- **[src]** — read from the named source repository at the named commit.
- **[mkt]** — from the Visual Studio Marketplace API on 2026-09-23.
- **[doc]** — from a project's README/docs, not independently tested.
- **[untested]** — plausible from code reading but not exercised.

Nothing here was tested inside a running VS Code instance; the four extensions were analysed
from source only.

---

## 1. Environment on the development machine

| Item | Value |
|---|---|
| OS / arch | macOS (Darwin 27.0.0), arm64 |
| VS Code | 1.139.0 at `/Applications/Visual Studio Code.app` (the `code` CLI is **not** on `PATH`; use `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`) |
| Installed extensions of note | `j-nava.idris2-language-support` 0.1.2, `leanprover.lean4` 0.0.240, `james-yu.latex-workshop` 10.19.0 |
| Idris 2 | 0.8.0 at `/opt/homebrew/bin/idris2`; prefix `/opt/homebrew/Cellar/idris2/0.8.0_2/libexec`; TTC version 2025081600; installed packages: base, contrib, idris2, linear, network, prelude, test (all 0.8.0) [live] |
| Idris 1 | not installed |
| `idris2-lsp`, `pack` | not installed: neither on `PATH` nor under `~/.pack`, `~/.idris2`, `~/.config/pack`, `~/.local/state/pack` or `~/.local/bin` (pack's current XDG layout, ROADMAP §0 F22) [live] |
| Node / npm / git | v24.13.0 / 11.11.0 / 2.54.0 |

Latest npm versions on 2026-09-23: `@types/vscode` 1.138.0, `vscode-languageclient` 10.1.1,
`@vscode/test-cli` 0.0.15, `@vscode/test-electron` 3.1.0, `@vscode/vsce` 4.0.0, `esbuild` 0.28.2,
`typescript` 7.0.2 (`latest`; `beta` is 6.0.0-beta), `eslint` 10.11.0, `typescript-eslint` 8.70.1,
`generator-code` 1.12.0. `generator-code` 1.12.0 pins `typescript ^6.0.3`, `eslint ^10.5.0`,
`typescript-eslint ^8.61.1`, `esbuild ^0.28.1`, `@vscode/test-cli ^0.0.15`, `@vscode/test-electron ^3.0.0`,
`mocha ^11.7.6`, `@types/mocha ^10.0.10`, `@types/node 24.x`, `npm-run-all ^4.1.5` [src: generator-code tarball].
Its non-interactive CLI: `yo code <dest> -t ts -n <displayName> --extensionId <id> --extensionDescription <d> --pkgManager npm --bundler esbuild --gitInit false -q --skipOpen --skip-install` [live: `yo code --help`].

---

## 2. Existing VS Code extensions

### 2.1 Overview [mkt]

| Extension | Version | Last update | Installs | Backend | Idris 1 | Idris 2 |
|---|---|---|---|---|---|---|
| `zjhmale.Idris` (repo `zjhmale/vscode-idris`) | 0.9.8 | 2017-05-29 | 11,231 | `idris --ide-mode` (IDE protocol v1) | designed for it (untested here) | partial; see §2.2 |
| `meraymond.idris-vscode` (repo `meraymond2/idris-vscode`) | 0.0.14 (published 2022-11-12; last commit 2022-12-29) | 2022-11-12 | 4,816 | IDE protocol v1/v2 (`idris.idris2Mode` switch) | yes [doc] | yes; README says tested against 0.6.0 [doc] |
| `bamboo.idris2-lsp` (repo `bamboo/idris2-lsp-vscode`) | 0.7.1 published; repo at 0.7.2 (2024-11-02) | 2024-08-04 | 3,278 | `idris2-lsp` | no | yes |
| `j-nava.idris2-language-support` (repo `j-nava/idris2-vscode`) | 0.1.2 | 2023-01-31 | 1,804 | `idris2-lsp` | no | yes |

All four TextMate grammars descend from the Atom `idris-hackers/atom-language-idris` grammar via
zjhmale's port: meraymond's is an edit of zjhmale's (113 of 458 normalised lines differ);
j-nava's is meraymond's with `idris`→`idris2` in scope names (2 lines differ); bamboo's README says
it took meraymond's [src]. None of them has rules for `%`-directives (`%default`, `%hint`,
`%foreign`, …), `?hole` names as a distinct scope, `failing` blocks, `\case`, multiplicities
(`0`/`1` binders), or `covering`; all still treat Idris 1's `class`/`instance`/`codata`/`dsl`/`syntax`
as keywords [src].

### 2.2 `zjhmale.Idris` 0.9.8 — Idris 1, IDE protocol v1 [src: commit 2f7786f, 2017-05-29]

Plain JavaScript (~2,600 lines), `engines.vscode ^1.8.0`, deps `rx-lite`, `bennu` (sexp parser).

Compiler-backed features (via `--ide-mode`, one persistent process; a second process is spawned
for totality checks and killed after each run; `idris.numbersOfContinuousTypechecking` restarts
the main process every N typechecks "to avoid memory leaking"):
typecheck (command and on save; errors → `DiagnosticCollection`), optional non-total warnings
(implemented by `:browse-namespace` on the module then `:docs-for` on every name and grepping
for "not total"), type-of / docs-for / print-definition at cursor, hover (docs, type, or docs
falling back to type), list holes (`:metavariables 80`), add-clause, add-proof-clause,
case-split, proof-search, make-with, make-case, make-lemma, apropos, search-by-type
(`:interpret ":search …"`), eval selection, REPL terminal (spawns `idris` with `-p` flags from
the ipkg, sends `:cd` and `:l`), send-selection-to-REPL, optional `replCompletion` completion
(`:repl-completions`), `idris --build <ipkg>` with warnings parsed into diagnostics.

Regex-based (not compiler-backed): go-to/peek definition, document symbols, workspace
symbols, find references, rename, document highlights, signature help. They scan all `.idr`
files in the workspace with regexes (`src/analysis/common.js`, `find-definition.js`)
[src]; expected to be wrong for shadowing, local bindings and overloads [untested].

Other: grammars for `.idr`/`.lidr`/`.ipkg`; ipkg completion (Idris 1 field names) and
go-to-module from ipkg; snippets incl. LaTeX snippets; "cleanup `.ibc`"; new project via the
external `idringen` tool; indentation rules set at activation.

ipkg handling: regexes for `opts =`, `sourcedir =`, `pkgs =` (Idris 1 field; Idris 2 uses
`depends =`, so dependencies are silently ignored) [src].

**Replay against Idris 2 0.8.0 [live].** The extension's exact messages (built with its own
`src/wire/formatter.js`) were sent to `idris2 --ide-mode`; the compiler announced
`(:protocol-version 2 1)`.

| Message as sent | Result |
|---|---|
| `(:interpret ":cd <unquoted path>")` (sent before every load when no ipkg is found, `model.load`) | error `Expected string begin.` — protocol v2 requires a quoted path |
| `(:load-file "<abs path>")` | ok; many `(:output (:ok (:highlight-source …)))` messages precede `(:return (:ok ()) id)` |
| `(:type-of "vlen")`, `(:docs-for "vlen")` | ok, with highlighting metadata |
| `(:print-definition "myMap")` | `(:write-string "print-definition: command not yet implemented. Hopefully soon!")` then `(:return (:ok "myMap"))` |
| `(:metavariables 80)` | ok, but shape differs from v1: names are quoted (`"\"Test.rest\""`) and premises carry a multiplicity prefix (`" 0  a"`) |
| `(:add-clause 7 "append")` | ok → `append x y = ?append_rhs` |
| `(:add-proof-clause 7 "append")` | `(:return (:error "Unrecognised command: …") 7)` — **tagged with the previous request's id (7, not 8)**, so an id-matching client would wait forever; `<==` proof clauses no longer exist in Idris 2 (`Command.idr` marks it deprecated) |
| `(:case-split 10 "xs")` | ok (two clauses) |
| `(:proof-search 15 "rest" ())` | ok → `[]` |
| `(:make-with 10 "vlen")`, `(:make-case 10 "vlen_rhs")` | ok |
| `(:make-lemma 10 "vlen_rhs")` | ok → `(:metavariable-lemma (:replace-metavariable "vlen_rhs xs") (:definition-type "vlen_rhs : Vect n a -> Nat"))` |
| `(:apropos "map")` | `(:write-string "apropros: command not yet implemented. Hopefully soon!")` then `(:return (:ok ""))` |
| `(:repl-completions "myM")` | ok → `(("myMap") "")` |
| `(:browse-namespace "Test")` | ok, highlighted string |
| `:version` | ok → `((0 8 0) (""))` |

Whether the extension's JavaScript then parses the v2 replies correctly was **not** tested.
Its serializer does not escape `"` or `\` inside strings [src].

### 2.3 `j-nava.idris2-language-support` 0.1.2 — thin `idris2-lsp` client [src: commit e533cbd, 2023-01-31]

8 commits total. Entry point written in Idris 2 compiled to JavaScript (`src/VSCode/*.idr`) plus
TypeScript modules; `vscode-languageclient ^7.0.0`; `engines.vscode ^1.66.0`.

Own features: start/restart server command; optional periodic restart (default 10 min);
hover over a *selection* evaluates it via `workspace/executeCommand` `repl`; a "REPL terminal"
pseudoterminal that sends each line to the `repl` command (handles only Enter and Backspace; no
history, arrows, Ctrl-C, or multi-line); optional auto-save before code actions
(`idris2.languageServer.saveOnQuickFix`, a workaround for the server refusing actions on dirty
files); debug command to send an arbitrary `executeCommand`.

Configuration: `idris2.languageServer.path`, `idris2.languageServer.saveOnQuickFix`,
`idris2.serverRestartService.toggle`/`.interval`. **No `initializationOptions`** are passed, so
none of the server's options (§3) can be set.

Declares custom semantic token types `module` (superType `namespace`) and `postulate`
(superType `type`) so the server's legend maps to theme colours.

Bugs: activation event `workspaceContains:**/.ipkg` matches only a file literally named
`.ipkg`; document selector includes language ids `idris`, `idris2`, `lidr` but the extension
registers `idris2`, `ipkg`, `lidr` [src].

### 2.4 `bamboo.idris2-lsp` — `idris2-lsp` client [src: package.json + README only, commit 2024-11-02]

`engines.vscode ^1.52.0`. Commands: evaluate selection, refine hole, show metavariables of the
current file (QuickPick to jump). Settings expose the server's `initializationOptions`
(`briefCompletions`, `fullNamespace`, `logFile`, `loglevel`, `longActionTimeout`,
`maxCodeActionResults`, `showImplicits`, `showMachineNames`) plus `path` and `trace.server`.
The `idris2-lsp` README links to this as its VS Code client [doc].

### 2.5 `meraymond.idris-vscode` — IDE protocol v1/v2 client [src: package.json + README only]

Commands (all via IDE protocol): add clause, add missing, apropos, browse namespace,
case split, docs for, generate definition, interpret selection, list metavariables,
print definition, make case/lemma/with, proof search, type at/of, version. Settings:
`autosave`, `hoverAction`, `idris2Mode`, `idrisPath`, `processArgs`. README notes it activates
only for `.idr`/`.lidr` and that Idris 2 literate variants need manual activation; states no
semantic highlighting [doc].

---

## 3. `idris2-lsp` — the Idris 2 language server [src: idris-community/idris2-lsp, commit "Removing contrib dependency", 2026-08-01]

Written in Idris 2 against the compiler's `idris2api` package; **must be built against the exact
compiler commit** it pins (`Idris2` submodule at `6ca00e7`, a development commit; `LSP-lib`
submodule at `ca77e80`). Release branches: `idris2-0.4.0`, `idris2-0.5.1`, `idris2-0.6.0`,
`idris2-0.7.0`; **no `idris2-0.8.0` branch**. README recommends `pack install-app idris2-lsp`;
manual install requires rebuilding Idris 2 from the submodule with `make install-with-src-libs`
and `make install-with-src-api` [doc]. Go-to-definition into dependencies requires them to be
installed with `idris2 --install-with-src` [doc]. **An `.ipkg` is required**: `loadURI` calls
`findIpkg` and fails otherwise, and it `changeDir`s to the file's folder [src].

Server capabilities advertised (`src/Server/Capabilities.idr`):

| Supported | Advertised but stubbed (returns null) | Not supported (`false`/absent) |
|---|---|---|
| textDocumentSync (open/close, incremental change, save), completion (no trigger chars), hover, signatureHelp, definition, documentHighlight, documentSymbol, codeAction, semanticTokens **full only** (no range), executeCommand | codeLens, documentLink | declaration, typeDefinition, implementation, **references**, **rename**, foldingRange, selectionRange, linkedEditingRange, callHierarchy, moniker, **workspaceSymbol**, color, formatting (all three), workspaceFolders (`supported = false`), file operations |

`executeCommand` commands advertised: `repl`, `exprSearchWithHints`, `refineHoleWithHints`,
`metavars`. Handlers actually implemented (`ProcessMessage.idr`): `repl`, `metavars`,
`exprSearchWithHints`, **`refineHole`** (not `refineHoleWithHints`), and `browseNamespace`
(handled but not advertised). `doc/commands.md` documents `repl`, `metavars`,
`exprSearchWithHints`, `refineHole`, `browseNamespace`. `metavars` returns each hole's
name, location, type, and premises (name, type, location, `isImplicit`).

**Dirty-file gating**: hover, documentHighlight, definition, codeAction, signatureHelp,
documentSymbol, and semanticTokens/full all return null (or `RequestCancelled` for semantic
tokens) while the document has unsaved changes (`isDirty`). Completion is *not* gated. The file
is (re)loaded only on `didOpen` and `didSave`; `didSave` also requests
`workspace/semanticTokens/refresh` if the client supports it. The server keeps a **single
`openFile`** in its configuration; `didClose` clears it and all caches. So switching between
files reloads context [src].

Code actions produced (`TextDocumentCodeAction`, one module each under
`src/Language/LSP/CodeAction/`): quick fixes, ExprSearch, CaseSplit, MakeLemma, MakeWith,
AddClause, MakeCase, Intro, GenerateDef, GenerateDefNext, and RefineHole (the last only via
`executeCommand refineHole`). Each module accepts `context.only` keys
`refactor.rewrite.{AddClause,CaseSplit,ExprSearch,GenerateDef,GenerateDefNext,Intro,MakeCase,MakeWith,RefineHole}`
and `refactor.extract.MakeLemma` (or the generic `refactor.rewrite` / `refactor.extract`;
absent `only` ⇒ allowed), but every **returned** action carries only the generic kind
(`RefactorRewrite`, MakeLemma `RefactorExtract`), so a client must tell them apart by title
(`Add clause`, `Case split on ?<n>`, `Generate next definition`, …) [src: `AddClause.idr` 22–41,
`CaseSplit.idr` 24–43, `GenerateDefNext.idr` 28–38; corrected 2026-09-25]. The server README's
kind table is stale: it lists `MakeClause` (no such key; the Idris-side enum name only) and omits
`GenerateDefNext` [src: README line 78 vs the module list]. Quick-fix titles are
`QuickFix: <msg>` (e.g. `QuickFix: Add missing cases`) [src per ROADMAP §0 F28; not re-read here].

`initializationOptions`: `logFile`, `logSeverity`, `longActionTimeout` (ms, default 5000),
`maxCodeActionResults` (default 5), `showImplicits`, `showMachineNames`, `fullNamespace`,
`briefCompletions` [doc]. Also handles `workspace/didChangeConfiguration` → `processSettings`.

Semantic token legend (no modifiers): `type`, `function`, `enumMember` (data constructors),
`variable` (bound), `keyword`, `namespace`, `postulate`, `module`, `comment` — the last two are
non-standard and need `contributes.semanticTokenTypes` in the client [src].

---

## 4. Idris 2 compiler facts

### 4.1 Command line (0.8.0) [live: `idris2 --help`]

Relevant options: `--check/-c`, `--exec/-x <name>`, `-p <package>`, `--source-dir`, `--build-dir`,
`--output-dir`, `--total`, `-Werror`, `-Wno-shadowing`, `-Xcheck-hashes`; `--prefix`, `--paths`,
`--libdir`, `--list-packages`; package commands `--init [ipkg]` (interactive), `--dump-ipkg-json [ipkg]`,
`--dump-installdir`, `--build`, `--install`, `--install-with-src`, `--mkdoc`, `--typecheck`, `--clean`,
`--repl [ipkg]`, `--find-ipkg`, `--ignore-missing-ipkg`; `--ide-mode`, `--ide-mode-socket [host:port]`;
`--client <REPL command>` (one-shot); `--no-banner`, `--quiet`, `--console-width`,
`--show-implicits`, `--show-machine-names`, `--show-namespaces`, `--no-color`, `--log <n>`,
`--version`, `--ttc-version`, `--bash-completion*`. Environment: `IDRIS2_PREFIX`, `IDRIS2_PATH`,
`IDRIS2_PACKAGE_PATH`, `IDRIS2_DATA`, `IDRIS2_LIBS`, `IDRIS2_CG`, `IDRIS2_INC_CGS`, `CHEZ`,
`RACKET`, `NODE`, `NO_COLOR`, … There is no `-Wall` [live].

### 4.2 Diagnostic output format (0.8.0) [live: `idris2 --check Bad.idr`]

```
1/1: Building Bad (Bad.idr)
Error: While processing right hand side of f. When unifying:
    Nat
and:
    String
Mismatch between: Nat and String.

Bad:4:7--4:12
 1 | module Bad
 ...
 4 | f x = x + 1
           ^^^^^

Error: h is not covering.

Bad:9:1--10:15
 09 | total
 10 | h : Nat -> Nat

Missing cases:
    h 0
```

The location line is `<origin>:<line>:<col>--<line>:<col>` with 1-based line and column, where
`<origin>` is the module/file stem (not a path) for a directly-checked file. Exit code 1 for type
and coverage errors, but **0 for `Error: Module X not found`** (a missing import) [live,
2026-09-25; corrects the earlier "exit code 1 on error"]. So exit codes alone cannot decide
success; the output must be parsed. A problem matcher must pair the `Error:` block with the
location line that follows it.

### 4.3 IDE protocol (v2.1) [live + src: idris-lang/Idris2 master 1c630e6, 2026-09-08]

Wire format: 6 hex-digit byte-length prefix, then an s-expression, then `\n`. On start the
compiler sends `(:protocol-version 2 1)`. Requests are `(<command> <id>)`; replies are
`(:return (:ok SEXP [HIGHLIGHTING]) ID)`, `(:return (:error String [HIGHLIGHTING]) ID)`,
intermediate `(:output (:ok …) ID)` (used for `:highlight-source` during load), and
`(:write-string String ID)`, `(:set-prompt String ID)`, `(:warning (FilePath (L C) (L C) String [HL]) ID)`
[src: docs/source/implementation/ide-protocol.rst].

Commands accepted by `src/Protocol/IDE/Command.idr` (master): `load-file`, `interpret`,
`type-of` (name [line col]), `name-at` (name, optional line/col), `case-split` (line [col] name),
`add-clause`, `add-missing`, `intro`, `refine` (line hole expr), `proof-search` (line name hints
[mode]), `proof-search-next`, `generate-def`, `generate-def-next`, `make-lemma`, `make-case`,
`make-with`, `docs-for` (name [:overview|:full]), `apropos`, `directive`, `metavariables` (width),
`who-calls`, `calls-who`, `browse-namespace`, `normalise-term`, `show-term-implicits`,
`hide-term-implicits`, `elaborate-term`, `print-definition`, `repl-completions`, `enable-syntax`,
`get-options`, `version`. `add-proof-clause` is deprecated/removed. The protocol document also
lists `(:cd PATH)`, but `Command.idr` has no case for it and 0.8.0 answers "Unrecognised command"
[live per ROADMAP §0 F4; corrected 2026-09-25 — an earlier version of this file listed `cd`].
`version`, `proof-search-next` and `generate-def-next` are **bare symbols**: send
`(:generate-def-next 9)`, not `((:generate-def-next) 9)` — the latter is "Unrecognised" [live].

**Stubs.** On 0.8.0, `who-calls`, `calls-who`, `add-missing` and positional `name-at NAME L C`
each answer `(:write-string "<cmd>: command not yet implemented. Hopefully soon!")` followed by
an empty `:ok` [live, 2026-09-25], as do `print-definition` and `apropos` [live, 2026-09-23].
ROADMAP §0 F3 reports the same for `directive`, `normalise-term`, `show-term-implicits`,
`hide-term-implicits` and `elaborate-term` (`todoCmd` in `Idris/IDEMode/REPL.idr`, master and
0.8.0) [src, planning agents; not re-run here]. Working substitutes: `(:interpret ":missing f")`
for missing cases (→ `"Test.myMap: All cases covered"` or the missing clauses) [live];
`(:name-at "f")` without a position returns the definition location
`(("Test.vlen" (:filename "…") (:start 8 0) (:end 8 22)))`, 0-based [live].

**Exercised live and working** (0.8.0): `intro` (→ `(:ok ("0" "S ?vlen_rhs_0"))`, a list of
candidate strings), `generate-def` (→ one multi-line string with all clauses) [live, 2026-09-25];
`refine`, `generate-def-next`, `proof-search-next`, positional `type-of NAME L C` [live per
ROADMAP §0 F29–F30, planning agents]. Request lines are 1-based and request columns 0-based;
reply positions are 0-based with exclusive end [live per ROADMAP §0 F2].

Quirk [live]: a request the compiler cannot parse is answered with
`(:return (:error "Unrecognised command: …") <previous id>)`, so clients need per-request timeouts.

### 4.4 Literate formats [live on 0.8.0; src: master `src/Parser/Unlit.idr`]

`idris2 --check` accepted and built all of: `.lidr` (bird tracks `>`/`<`), `.md` (```` ```idris ````
fences), `.org` (`#+BEGIN_SRC idris`), `.tex` (`\begin{code}`), `.typ` (```` ```idris ````).
Master additionally lists `.markdown`, `.dj`, `.ltx`, plus comment-style blocks
(`<!-- idris -->`, `/* idris */`, `\begin{hidden}`, `#+IDRIS:`), and accepts the prefixes
`.idr.<ext>` / `.lidr.<ext>` [src]. The existing extensions register only `.lidr`.

---

## 5. Gaps relative to mature language tooling

Where each gap has to be closed: **E** = in the extension alone; **S** = needs `idris2-lsp` work
(or a fallback to IDE mode from the extension); **C** = needs compiler work.

1. **No checking while typing; most features refused on unsaved files** (§3 dirty gating). — S (client can mitigate: auto-save on a debounce, or drive IDE mode with `:load-file` on a temp copy).
2. **No find-references, rename, workspace symbols, call hierarchy, go-to-type/implementation.** — S **and C**. The compiler protocol *parses* `who-calls`/`calls-who`, but both are unimplemented stubs in 0.8.0 (§4.3), so call hierarchy needs compiler work first. (Corrected 2026-09-25; an earlier version of this line claimed the compiler side was done.)
3. **Single-file context; slow file switching; no multi-root.** — S.
4. **`.ipkg` required; loose files get nothing.** — S, or E via IDE-mode fallback (`idris2 --ide-mode` needs no ipkg [live]).
5. **No formatting, folding, selection ranges, inlay hints (implicits, multiplicities, pattern-variable types).** — S for semantic ones; E for syntactic folding via a TextMate/indentation heuristic. No maintained Idris 2 formatter is known to the author (not searched exhaustively).
6. **No goal/hole panel** (Lean InfoView / Agda goal buffer analogue) and no hole tree view. — E, on top of `metavars` (server) or `:metavariables` (IDE mode).
7. **Interactive editing not fully exposed / no keybindings**: cycling ExprSearch/GenerateDef results, refine-with-hints, adding missing cases, `intro`, next/previous hole. — E (server has most). The IDE-mode `add-missing` command is a stub in 0.8.0; the working route is `(:interpret ":missing f")` in IDE mode or the server's `QuickFix: Add missing cases` (§4.3, §3). (Corrected 2026-09-25.)
8. **No toolchain management**: locate `idris2`/`idris2-lsp`/`pack`, detect version mismatch (server is version-locked), offer `pack install-app idris2-lsp`, show versions. — E.
9. **No real REPL** (process-backed, history, `:t`/`:doc`, reload on save) and no inline evaluation. — E.
10. **No build/run/test integration**: tasks + problem matcher for `idris2 --build`/`pack build`, "run main" code lens, test explorer for `test` package-style suites. — E.
11. **Weak `.ipkg` support for Idris 2**: field-aware completion/validation, `modules =` sync, `pack.toml`, `idris2 --init` scaffolding. — E.
12. **Literate Idris beyond `.lidr`** (§4.4). — E (language ids + grammar injection into Markdown/LaTeX/Org/Typst) and S (server must accept those files — untested).
13. **Outdated grammar** (§2.1) — E.
14. Nice-to-have: Unicode input method (`\to` → `→`), namespace browser (`browseNamespace`), links from hover to `--mkdoc` HTML, syntax-only web extension for vscode.dev, Idris 1 legacy support via IDE protocol v1 (only if wanted). — E.

## 6. Reference points (not analysed in depth)

- `leanprover.lean4` 0.0.240 is installed locally at
  `~/.vscode/extensions/leanprover.lean4-0.0.240/package.json`: `engines ^1.75.0`; commands for
  InfoView (display goal, pin/pause/copy state, go to definition from InfoView), Unicode input
  (`lean4.input.*`), toolchain setup (`lean4.setup.installLean/installElan/…`), project
  create/open/clone/build/clean, troubleshooting/setup-information output. Good model for the
  goal panel, toolchain and project commands.
- Other models worth studying when a milestone starts: Haskell (`haskell.haskell`, HLS client),
  rust-analyzer (server-managed installs, inlay hints), agda-mode-vscode (goal interaction,
  Unicode input), OCaml Platform.

## 7. Pitfalls noted while reading code

- Idris 2 IDE mode answers unparseable commands with the previous request id (§4.3).
- `version`, `proof-search-next` and `generate-def-next` must be sent as bare symbols, `(:version 7)`, not wrapped in a list (§4.3).
- The 6-hex length prefix counts UTF-8 **bytes** (including the trailing newline), not characters [live per ROADMAP §0 F1].
- Over stdio IDE mode, program output from `:exec` is written unframed into the protocol stream; `--ide-mode-socket` keeps the socket stream framed [live per ROADMAP §0 F5].
- `idris2-lsp` advertises `refineHoleWithHints` but implements `refineHole`; `browseNamespace` is implemented but unadvertised.
- `idris2-lsp` `semanticTokens/full` returns `RequestCancelled` on dirty files; a client must tolerate that error.
- Idris 2 `.ipkg` uses `depends =`; Idris 1 used `pkgs =`.
- zjhmale's sexp serializer does not escape `"`/`\`.
- Diagnostic locations from the CLI use the module/file stem, not a path (§4.2) — a problem matcher needs to map back to files.

---

## 8. Corrections log

The planning session (2026-09-23/25) had four planning agents and three judges re-run and extend
the experiments behind this file; their results are tabulated as F1–F36 in `ROADMAP.md` §0.
Where they contradicted this file, the text above was corrected in place on 2026-09-25 with a
"corrected" note, after re-verifying each point on this machine unless the tag says otherwise:

| Was | Now | Verified |
|---|---|---|
| §5 gap 2: `who-calls`/`calls-who` "already done" in the compiler | stubs in 0.8.0; call hierarchy needs compiler work | live |
| §5 gap 7: `add-missing` "only in IDE mode" | stub; use `:interpret ":missing f"` or the server quick fix | live |
| §4.3: `cd` listed as a protocol command | not a command; "Unrecognised" | ROADMAP F4 (planning agent) |
| §4.3: `intro`, `refine`, `generate-def(-next)`, `proof-search-next` "not exercised live" | all work; reply shapes recorded | `intro`, `generate-def` live here; rest ROADMAP F29–F30 |
| §4.3: nothing on bare-symbol commands | `version`, `*-next` must be bare symbols | live |
| §4.2: "exit code 1 on error" | 0 for a missing module | live |
| §3: code-action kinds copied from the server README (`MakeClause`, no `GenerateDefNext`; "filter keys") | kinds from source; returned kind is generic, select by title | source |
| §1: pack absence judged from `~/.pack` only | XDG paths checked too | live |

Anything in `ROADMAP.md` §0 that is not repeated here was not independently re-verified for this
file and carries its own tag there.
