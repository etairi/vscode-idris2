# User guide

How the Idris 2 extension behaves, in more detail than the [README](../README.md). Every setting
is also described in the Settings UI: search for `@ext:etairi.vscode-idris2`.

- [Checking files](#checking-files)
- [Code intelligence](#code-intelligence)
- [Evaluation](#evaluation)
- [Holes and interactive editing](#holes-and-interactive-editing)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Editing](#editing)
- [Toolchain](#toolchain)
- [Settings in depth](#settings-in-depth)
- [Resource use](#resource-use)
- [Privacy and security](#privacy-and-security)
- [Diagnosing problems](#diagnosing-problems)
- [Known limitations](#known-limitations)

## Checking files

The compiler checks Idris files — in a package (`.ipkg`) or on their own, literate ones (`.lidr`,
`.idr.md`, …) included. Its errors and warnings appear in the editor and the Problems panel.

| `idris2.checking.trigger` | A file is checked |
|---|---|
| `onSave` (default) | when it is opened and each time it is saved |
| `afterDelay` | as `onSave`; also, a file with unsaved changes is **saved automatically** after a pause in typing (`idris2.checking.delay`, 700 ms) — this writes your files |
| `manual` | only with **Check File** |

- The compiler always checks the file as saved on disk, never the unsaved text in the editor.
- Every file is matched to its `.ipkg` the way the compiler finds it, also a package above the
  folder you opened. Files without one get the packages of `idris2.ideMode.loosePackages`.
- Errors in an imported module and a malformed `.ipkg` are shown where they are. The files they
  kept from being checked are checked again once they are fixed and saved.
- A file changed on disk outside the editor (a checkout, say) is checked again.
- `idris2.diagnostics.includeSourceExcerpt` keeps the compiler's source excerpt in the messages.

The language status (hover over `{}` next to **Idris 2** in the status bar) shows the version
and the result, e.g. `Idris 2 0.8.0 · IDE mode · 1 error`, with the details beside it:

| Status | Meaning |
|---|---|
| `checking…` | a check is running, or waits for your [permission](#folders-outside-the-workspace) |
| `✓`, `2 errors`, `1 warning` | the result of the last check |
| `up to date` | already built in an earlier session, warnings not repeated (see [limitations](#known-limitations)) |
| `stale` | unsaved changes, or the file changed on disk and was not checked yet (also an auto-save during a [Proof Search cycle](#holes-and-interactive-editing)) |
| `not allowed here` | you did not allow the compiler in this folder: highlighting only |
| `failed` | the check failed, or the compiler was given up (**Restart Backend** tries again) |
| `package file error` | the `.ipkg` could not be read |
| `stopped` | the compiler is stopped; the next check starts it again |

**Stop Backend** stops the compiler of this project or of all projects — for example before
`pack build`; the next check starts it again. **Restart Backend** restarts it.

**Build directory.** With `idris2.ideMode.isolateBuildDir` (on by default) the editor's build
files go to `build/.vscode-idris2`, apart from your own builds. That is not possible when the
`.ipkg` sets `builddir` or a `--build-dir` in `opts`, or `idris2.ideMode.extraArgs` has one.

## Code intelligence

Answers come from the compiler's last check of the **saved** file (inlay hints may keep an earlier
one's, see below).

- **Hover**: the type of the name under the cursor, local pattern variables included, and the
  first paragraph of its documentation. With unsaved changes the hover says so.
- **Type at Cursor** and **Docs at Cursor** do the same from the keyboard.
- **Go to Definition** (F12): global names, also in another file or in an installed package
  whose sources are installed.
- **Show Documentation…** opens a name's documentation in a read-only document. **Browse
  Namespace…** lists a namespace's names with their types; pick one to open its documentation.
- **Semantic highlighting**: functions, types, data constructors, bound variables, modules and
  keywords, in idris2-lsp's token types, so themes colour both alike.
- **Outline and breadcrumbs** list the declarations; the occurrences of the name under the
  cursor are highlighted.
- **Completion** (Ctrl+Space): names in scope, keywords and `%` directives.
- **Inlay hints** show pattern variables' types: `vlen xs = …` shows `: Vect ?_ ?_` after `xs`.
  Turn them off with `idris2.inlayHints.variableTypes`; `editor.inlayHints.enabled` also applies.
- While a file has unsaved changes, or the compiler cannot be asked about it, the inlay hints of
  an earlier check stay, also where an edit changed a type; their tooltip says so.

## Evaluation

**Evaluate Selection** evaluates the selected expression in the context of the saved file. The
result appears after the line and in a hover; **Clear Evaluation Results** removes them. With
`idris2.eval.inlineResults` off, it appears in a notification instead.

- **Expressions only.** An `IO` action is shown as a value, not run. Text the compiler's REPL
  would read as a command (`:exec`, `:sh`, `:set …`, also behind white space, comments or
  invisible characters) is refused before anything is sent.
- **Its own process.** Each project gets a second compiler process for evaluation: same folder,
  same permission, same transport as the one that checks files. It starts only when you evaluate
  there — never by itself, also not after it ended or was stopped.
- It stops after 2 minutes without an evaluation (or after `idris2.ideMode.idleTimeout`, if
  shorter; never for being idle when that is `0`), and after an evaluation that took more than
  a second. Its build files go to `build/.vscode-idris2-eval`, unless the `.ipkg` or
  `idris2.ideMode.extraArgs` choose the build directory (see [Build directory](#checking-files)).
- **Before every evaluation** it checks the file again, so that it sees the saved files as they
  are: about 0.1–0.4 s for an unchanged file in our measurements. The first evaluation in a
  project compiles its modules.
- **Time limit.** A loop makes the compiler's memory grow fast (more than a gigabyte within
  seconds in one measurement), so an evaluation is stopped after `idris2.eval.timeout` (10 s),
  with its process, which starts again at the next evaluation.
- An evaluation still running after a second can be cancelled from its notification.
- The language status and the crash notices are about the checking compiler: the status can read
  `stopped` while an evaluation's compiler runs. **Stop Backend** and **Restart Backend** stop both
  processes; Restart starts only the checking one again.

### Compile-time code

Evaluating an expression can run **elaborator scripts**, which can read and write files in the
project's folders, among them its source and build directories wherever the `.ipkg` puts them, by
relative paths that `..` cannot leave (a symbolic link in them can):

- the script of any `%macro` function in the file's scope that the expression applies — defined
  in the project or in an installed package, with no `%language ElabReflection` needed;
- a `%runElab` in the expression, when that extension is on in the compiler (a module that turns
  it on, built by the same process, is enough); its script is the selected text itself.

Checking a file runs the scripts of the modules it rebuilds (the file and the project modules it
imports). Evaluating runs them again when its own process rebuilds them, and also those the
expression uses. That process rebuilds a module (the file, or a project module it imports) at the
first evaluation, unless its build directory already holds that build (it has its own unless the
`.ipkg` or `extraArgs` chooses one); after its file was saved or touched since that build, even
with the same text (the compiler compares modification times); and after a module it imports
changed what it exports. A macro's script is code of the project or of an installed package, and
the process runs only in a folder you trusted or allowed.

## Holes and interactive editing

The compiler's interactive editing, as in Idris 2's own REPL and editor modes. Each command acts
at the cursor and is in the Command Palette and the **Idris 2** menu; most have a key (see
[Keyboard shortcuts](#keyboard-shortcuts)).

| Command | Cursor on | What it does |
|---|---|---|
| **Case Split** | a variable of a clause whose right-hand side is a hole, `vlen xs = ?rhs` | one clause per constructor: `vlen [] = ?rhs_0`, `vlen (x :: xs) = ?rhs_1` |
| **Add Clause** | a type declaration | adds `f x y = ?f_rhs` after it, or after the function's clauses when it has some |
| **Generate Definition** | a type declaration without clauses | writes a definition after it |
| **Make Lemma** | a hole | replaces it with a new function applied to the variables it needs, whose type goes above the declaration with the hole |
| **Make With**, **Make Case** | a hole | turns the clause into a `with` block, or the hole into a `case` |
| **Proof Search** | a hole | fills it with an expression the compiler finds |
| **Intro** | a hole | offers what can start the hole's value (`0`, `S ?rhs_0`); applied at once when there is one |
| **Refine Hole…** | a hole | fills it with the expression you type, applied to new holes; when that expression is one ambiguous name, offers its qualified alternatives (an ambiguity inside a longer expression: the compiler's message); not for a binary operator, or a backticked name, with a fixity, whose alternatives the compiler prints between the arguments (`?h_0 A.(+++) ?h_1`, which would apply the hole): refused, write `A.(+++) x y` yourself |
| **Add Missing Cases** | a coverage error, or a type declaration | adds `g (S _) = ?g_missing_case_1` for each missing case after the function's clauses (numbered after the `?g_missing_case_k` holes already there) |

- **Light bulb.** The same commands are offered as code actions where they apply, found from the
  text alone — nothing is sent to the compiler until you pick one. Add Clause is offered only on a
  declaration without clauses (the command works on any), and neither it nor Generate Definition
  on a `%foreign` or `%extern` function. Add Missing Cases is a quick fix of a
  `… is not covering` error, not for a function of a `where` or `parameters` block; Make Lemma is
  not offered in an `interface` or on a hole named by a keyword. Where a command would be refused,
  its action is mostly left out. Case Split, Add Clause and Generate Definition are shown faded,
  with the reason, in the **Refactor…** menu after a check with errors and where they would be
  refused for a `.lidr` line of `>` and spaces or CRLF line ends; so is Make Case after an earlier
  `?name` of its line, and Case Split where the compiler would garble its answer (below). Some
  refusals show only when the command runs. No action is offered in a
  folder answered **Don't Allow**; all are shown faded while the project's compiler has failed.
- **One undo step** per command. The answer is applied only to the file it was asked about, and
  only if that file has not changed while the compiler worked; otherwise it is dropped and a
  message says so.
- **One at a time per file.** A command run while another one is still working on the same file
  says so and does nothing; once a Proof Search or Generate Definition shows its result, **Next
  Result** gives the next one.
- **The saved file.** The compiler edits the file as saved, so a command first saves a file with
  unsaved changes (`idris2.checking.saveBeforeAction`: `always`, the default; `prompt` asks;
  `never` asks you to save).
- **Next results.** After **Proof Search** or **Generate Definition** the status bar shows
  `↻ next (1)`: click it, or run **Next Result** (after either command) or **Next Definition** (after
  Generate Definition; **Generate Definition** again on the declaration or its result does the
  same), to replace the result with the next one, itself one undo step. The cycle ends when the compiler has no more results, when you change the
  file (an undo included), when a file of the project is checked (a check resets the compiler's
  search), or when another search starts in the project. An auto-save during the cycle checks the
  file only once the cycle has ended; saving it yourself checks it, which ends the cycle. The Next
  commands never save.
- **Long requests.** Proof Search, Generate Definition, Intro, Refine Hole…, Make Lemma, Add
  Missing Cases and the Next commands get `idris2.ideMode.longActionTimeout` (60 s); one that
  takes longer restarts the compiler. One still running after a second can be cancelled from its
  notification; if the compiler was already
  working on it, cancelling restarts the project's compiler, which checks the file again when it is
  next needed. Cancelling while the file is still being checked lets that check finish.
- **Make Lemma** puts the type above the declaration that holds the hole (with its documentation
  comment and its modifier and `%` pragma lines): the top-level one, or, in a `namespace` or
  `mutual` block, the one in that block, indented as it. Idris 2's REPL puts it at the nearest
  blank line above the hole, which may be inside a `where` block.
- **Make With** keeps a comment after the hole at the end of the new `with` line.
- **Parentheses.** An answer of more than one token (Intro, Refine Hole…, Proof Search and its next
  results, Make Lemma's call) is put in parentheses wherever the hole is: `vlen xs = (S ?vlen_rhs_0)`;
  so is a postfix projection `.x`, which Idris applies to the expression before it (`g .x` means
  `(.x) g`, so `g ?h` becomes `g (.x)`), a single token that would run into a name right before the
  hole (`g?h` gives `g(x)`, not `gx`) or into a `.` right after it, and a string next to a `"`.
  After a backtick (``x `div`?h``) a space goes before an answer that starts with a bracket. At the head of an idiom
  bracket on the hole's line (`[| ?h x |]`) only a name, a hole or a lambda is put; other answers
  are refused, since the bracket would read them as applicative, parentheses or not. **Make Case** always writes a bracketed case, `(case _ of` …
  `case_val => ?h)`, so the rest of the line stays outside it; a hole already in parentheses gets
  two pairs.
- **Blocks after the hole.** When the rest of the hole's line starts an entry of a block there
  (`case x of [] => 1`, `where y : Nat`, `\case Z => 1`, `do a`, `M.do a`, `; b`, `| Nothing => 0`,
  also inside a string's `\{…}`; or the hole is in a `parameters (…)`, `using (…)` or `with (…)` header, on
  its line or continued from lines above, with the exceptions under
  [Known limitations](#known-limitations)) and the first token below (after any comment) is right of the hole, Make Case, Intro,
  Refine Hole…, Proof Search and Make Lemma refuse: the new text would move that entry, and the lines below
  would be read against its new column, which can change what the program computes without any
  error. Put that entry on a line of its own first. Strings, character literals and comments are
  read here as the compiler's lexer reads them.
- **Tabs.** On a tab-indented line the compiler writes a space per tab; Case Split, Add Clause,
  Generate Definition (each result), Make With and Make Case put the line's tabs back (in `.idr`
  files).
- **Literate files.** In a `.lidr` file the answers keep a single `> `. A line of `>` and spaces only
  (Enter leaves one after a `> ` line) stops Case Split below it; delete the spaces. Markdown, LaTeX,
  Org and Typst literate files are not supported yet: the commands say so.

### When a command cannot run

A command never fails silently: it says what it needs or why it stopped.

- **Case Split** rewrites the cursor's line only, so that line must hold the clause with its hole
  (`f xs = ?rhs`); otherwise it says "this line has no hole to split on" and asks nothing. Case
  Split and Make With also refuse a clause whose left-hand side starts on an earlier line, and Case
  Split one with a `where` block below it (the block would belong to the last new clause only), and
  the name of an as-pattern (`xs` in `xs@(y :: ys)`, which the compiler never splits): split a
  variable after the `@`. On an erased argument (`(0 n : Nat) ->`) it applies the compiler's clauses,
  which do not check (`Can't match on 0`): undo them.
- **After a check with errors** the compiler no longer finds declarations by their lines: Case
  Split, Add Clause and Generate Definition say that the file did not load cleanly — fix the
  first error and save. The other commands ask anyway; an error they get is shown after that
  advice.
- **Add Clause**, **Generate Definition** and **Add Missing Cases** are refused on a declaration of
  several names (`a, b : Nat -> Nat`: the compiler answers for the last one), and Add Clause and
  Add Missing Cases when the function's clauses are in two places. Add Clause and Generate
  Definition are refused on a `%foreign` or `%extern` function.
- The compiler's answers are shown as it words them, except a few that are rephrased ("No clause
  to split here", "Already defined", "No search results", and those about a hole named like
  another definition, below).
- **Proof Search, Intro, Refine Hole… and Make Lemma** find the hole by its name, so they are
  refused when the compiler knows two holes of that name (in the file and the modules it imports),
  and after a check with errors when the compiler has not registered the hole at the cursor (a
  second `?h` in a module, or a hole in a clause that failed). A hole named like another
  definition in scope (`?length`, `?Z`) cannot be found by the compiler either: rename it (the
  command says so).
- **Make Lemma** is refused in an `interface`, **Add Missing Cases** in a `parameters` block (the
  compiler's missing cases there list the parameters too), and **Make With** where the hole does not
  follow a function clause's `=` (a `let`, a one-line `where`). **Make Case** is refused on a hole
  that the same `?name` text precedes on its line (the compiler rewrites the first one).
- **Refine Hole…**: the compiler reads the expression only as far as it parses and ignores the
  rest; an expression that closes a bracket it did not open (`S Z) x`) is refused.
- **Add Missing Cases** is refused for a function of a `where` or `let` block (the compiler's
  `:missing` does not find it), and applies only the compiler's report on the function declared at
  the cursor, never one of the same name in another module or namespace.
- **Make Lemma** is refused on a hole named by a keyword (`?proof`), or named like a name used in
  its definition (a `where` function, a variable): the lemma is named after the hole. Its answer
  is not applied when the lemma would take a value no code can name — one the compiler named
  itself (an unnamed constraint `Show a =>`: write `{auto s : Show a} ->`; the argument of
  `\case`) or one bound by `_` that other types use (`f (_ ** v)`: write `(n ** v)`) — nor when
  it would take two locals of one name (one shadowing the other).
- **Case Split** does not act on a variable of a one-line `case` (`case m of Just y => ?h`), and
  is refused on an alternative followed by others after a `;` (`  Just y => ?h ; Nothing => 0`):
  the compiler would repeat the whole line for each constructor. It is also refused where the
  compiler would garble its answer, such as a line with the word `of` in a comment or string, a
  hole in parentheses (`f xs = (?rhs)`), a string holding a name of the line's code or a hole
  (`f xs "xs" = ?rhs`), or a named argument matched with a variable of its own name
  (`vlen {n = n} xs = ?rhs`, which the compiler would split into `vlen {n = 0 = 0} []`: write
  `{n}`).
- **Add Clause** and **Generate Definition** are not applied when the compiler names an argument
  like the function (`f f = ?f_rhs` for `f : (Nat -> Nat) -> Nat`), which Idris 2 rejects: name the
  argument in the type, `(g : Nat -> Nat) -> Nat`. **Intro** does not apply what the compiler
  offers for a hole applied to an argument (`?g (S x)`): a lambda over a qualified name
  (`\M.argTy => ?g_0` in a module `M`), which does not check.
- **Add Clause** names the new hole `<f>_rhs` even when that name exists, as the compiler does;
  the next check then reports it as already defined. **Make With** is refused when its new hole,
  `?<h>_rhs`, already exists.
- **Case Split** is refused below a `.lidr` line of `>` followed only by spaces, which the
  compiler counts twice (delete the spaces after the `>`); in some such files Add Clause and
  Generate Definition are too. All three are refused in a literate file with CRLF line ends and in
  any file with a lone carriage return.
- A formatter that runs on save and moves the code under the cursor stops the command: run it
  again.
- A hole written right after a raw string (`g #"x"#?h`) is not recognised as a hole.

### The Holes view

The **Idris 2** icon in the activity bar opens the **Holes** view, once the window has an Idris
file open or a folder with an `.ipkg`:

- file → hole (`?name` and its type) → the local variables in scope (`0 a : Type`, `1 x : a`,
  `xs : Vect n a`; `0` and `1` are multiplicities); the badge counts the holes;
- the holes of each file the compiler checked, and of the modules it imports, from the latest
  check that reported them; a clean check removes the holes it was the last to report and no
  longer lists, and a check with errors changes only the files it reports holes in, and drops the
  checked file's holes whose `?name` is gone;
  a file with unsaved changes is marked `unsaved changes`; a project's holes go when the project's
  last file is closed, a file's when it is deleted;
- clicking a hole selects its `?name`, also where an edit has moved it; when it is gone, or edits
  since the check leave unclear which `?name` it is, it says so;
- a hole the compiler gives no source location for (one of an installed package whose source it
  does not find, say) is listed once under its module, after the files, marked `no source location`;
- `idris2.holes.showInSideBar` hides it.

**List Holes** shows the same in a QuickPick, the current file's holes first; it checks the file
first when it is not the one the compiler checked last (the status bar shows it working), and one
still running after a second can be cancelled from its notification; after a check with errors it
says that the file's own holes may be missing. **Next Hole** and **Previous Hole** move through
the `?name`s of the text you see, unsaved ones included, and wrap around at the end (the status bar
says so); they ask the compiler nothing and work in Restricted Mode, but not in Markdown, LaTeX,
Org or Typst literate files.

## Keyboard shortcuts

In Idris editors each command below has a key; `idris2.keybindings.scheme` chooses how it is
pressed, and **Show Keybindings** (Help group of the **Idris 2** menu) lists those that are on
(not your changes in `keybindings.json`). The letters are those of the Vim bindings in the Idris
docs; Emacs idris-mode's `C-c C-a`, `C-c C-s` and `C-c C-e` run other commands here.

| Key | Command | Key | Command |
|---|---|---|---|
| `t` | Type at Cursor | `s` | Proof Search |
| `d` | Docs at Cursor | `n` | Next Result (after Generate Definition, the next definition) |
| `e` | Evaluate Selection | `g` | Generate Definition; on its result, Next Definition |
| `c` | Case Split | `i` | Intro |
| `a` | Add Clause | `r` | Refine Hole… |
| `l`, `w`, `m` | Make Lemma, Make With, Make Case | `[`, `]` | Previous Hole, Next Hole |

| Scheme | Keys | Note |
|---|---|---|
| `auto` (default) | | `chords` on macOS, `prefix` elsewhere |
| `chords` | `Ctrl+C Ctrl+<key>` | on macOS the Control key, not Command; elsewhere `Ctrl+C` then no longer copies in Idris editors |
| `prefix` | `Ctrl+Alt+I <key>` | outside macOS, `Ctrl+Alt+I` then no longer opens the Chat view in Idris editors |
| `none` | | no shortcuts; the commands stay in the Command Palette |

- A keymap extension that binds `Ctrl+C` itself (VSCodeVim does by default) wins over `chords`:
  choose `prefix` then.
- The setting is read from your user settings only: a workspace cannot change your keyboard.
- `[` and `]` have not been tried with keyboard layouts that need Option or AltGr to type them.

## Editing

- **Syntax highlighting** for Idris 2 (`.idr`), literate Idris (`.lidr`, bird style) and package
  files (`.ipkg`), following the compiler's lexer: holes (`?goal`), pragmas (`%default total`),
  string interpolation, multi-line and raw strings, nested and documentation comments,
  quantities (`0`/`1`), `failing` blocks and `\case`.
- **Editing**: comment toggling; bracket matching and auto-closing; indentation after `where`,
  `do`, `of`, `=` and friends; the `> ` marker continued on Enter in `.lidr` files;
  indentation-based folding; **Expand Selection** through brackets, clauses and declarations.
- **Snippets** for `data`, `record`, `interface`, `case`, `with`, `failing`, … and `.ipkg` files.
  Every snippet expands to code the compiler accepts.
- **Editor defaults** for Idris files: two-space indentation with spaces, semantic highlighting
  on, no highlighting of ambiguous Unicode characters, word boundaries that keep `?hole` and `x'`
  whole, and LF for new `.lidr` files. Override them under `[idris2]` and `[lidr]`.
- The grammar's known limits (rare layouts) are listed in
  [test/grammar/idris2-scopes.md](../test/grammar/idris2-scopes.md).

## Toolchain

- The extension finds `idris2`, `idris2-lsp` and `pack`, shows the compiler version in the
  language status (or a **Setup…** link), and checks whether the language server fits the
  compiler.
- It searches `PATH`, pack's directories and the usual install locations.
  `idris2.toolchain.preferPack` searches pack's directories first; a path setting
  (`idris2Path`, `lspPath`, `packPath`) replaces the search.
- **Show Setup Information** reports the tools found, their versions, how they were found, and
  the current file's package. **Rescan Toolchain** looks again.
- **Install Idris 2…** types `brew install idris2` into a terminal on macOS and opens Idris 2's
  installation guide elsewhere; **Install pack…** types pack's install command (on macOS and
  Linux); **Install or Update idris2-lsp with pack** types `pack install-app idris2-lsp`. Nothing
  runs until you press Enter.
- The **Get Started with Idris 2** walkthrough on the Welcome page shows the first steps.

## Settings in depth

| Setting | Default | Description |
|---|---|---|
| `idris2.toolchain.idris2Path` | `""` | Path to `idris2`; empty: search (see [Toolchain](#toolchain)) |
| `idris2.toolchain.lspPath`, `packPath` | `""` | Paths to `idris2-lsp` and `pack`; empty: search |
| `idris2.toolchain.preferPack` | `false` | Search pack's directories before `PATH` |
| `idris2.toolchain.env` | `{}` | Extra environment variables for the tools the extension runs |
| `idris2.checking.trigger`, `delay` | `"onSave"`, `700` | When files are checked (see [Checking files](#checking-files)) |
| `idris2.checking.saveBeforeAction` | `"always"` | What an editing command does with unsaved changes: save, ask (`prompt`), or ask you to save (`never`) |
| `idris2.ideMode.transport` | `"stdio"` | `stdio` or `socket` (see [Transport](#transport)); user settings only |
| `idris2.ideMode.isolateBuildDir` | `true` | Keep the editor's build files in `build/.vscode-idris2` |
| `idris2.ideMode.loosePackages` | `[]` | Packages for files without an `.ipkg`, e.g. `["contrib"]` |
| `idris2.ideMode.extraArgs` | `[]` | Extra compiler arguments; with `--ide-mode` or `--ide-mode-socket` among them, the compiler is not started |
| `idris2.ideMode.requestTimeout` | `5000` | Milliseconds for a quick request; a longer one restarts the compiler |
| `idris2.ideMode.longActionTimeout` | `60000` | Milliseconds for checking a file and listing its holes, Proof Search, Generate Definition, Intro, Refine Hole…, Make Lemma and Add Missing Cases; likewise |
| `idris2.ideMode.idleTimeout` | `600000` | Milliseconds an unused compiler keeps running |
| `idris2.ideMode.maxSessions` | `0` | Most compiler processes per window (`0`: no limit); see below |
| `idris2.ideMode.maxBackgroundChecks` | `0` | Most files other than the active one checked at once (`0`: no limit); see below |
| `idris2.diagnostics.includeSourceExcerpt` | `false` | Keep the compiler's source excerpt in the messages |
| `idris2.inlayHints.variableTypes` | `true` | Types of pattern variables as inlay hints |
| `idris2.eval.inlineResults` | `true` | Evaluation results in the editor; off: in a notification |
| `idris2.eval.timeout` | `10000` | Milliseconds an evaluation may take; a longer one stops its process |
| `idris2.keybindings.scheme` | `"auto"` | See [Keyboard shortcuts](#keyboard-shortcuts); user settings only |
| `idris2.holes.showInSideBar` | `true` | Show the [Holes view](#the-holes-view) |
| `idris2.trace.protocol` | `false` | Record the messages exchanged with the compiler; user settings only |

**`maxSessions`.** Each window counts its own processes. A project's evaluation process counts
too, once it has answered: starting an evaluation stops no other process. Above the limit, idle
processes are stopped, never a busy one — first evaluation processes, then the checking processes
of projects other than the active file's, the one used least recently first. A stopped process
starts again when it is next needed.

**`maxBackgroundChecks`.** Each window counts its own checks. The others wait their turn, and
**Stop Backend** drops those still waiting. The active file never waits for a turn: within one
project, where the compiler answers one check at a time, its check goes before the others that
wait, after the one being compiled. The exception: several open files of its project are checked
together (for example at startup, when the workspace is trusted, **Restart Backend**, after a
permission answer, a saved `.ipkg`, a fixed import or an automatic restart), and the compiler has
one of the others queued or in progress when the active file's check reaches it. Then the active
file's check is not moved ahead: it waits for the project's checks queued before it, background
checks included, so that the compiler ends on it; those of the others still waiting for a turn or
for their folder's first permission check come after it. A file whose folder waits for your
permission takes no turn.

## Resource use

- Each project (each `.ipkg` folder, and each folder of files without one) has its own compiler
  process. It runs until idle for `idris2.ideMode.idleTimeout` (10 minutes) or until the
  project's last file is closed. Files of different projects are checked at the same time.
- A project's first check compiles the modules the file imports (into `build/.vscode-idris2`,
  unless the `.ipkg` names its own build directory), which takes time and memory. One idle
  process took about 75–210 MB after checking a small file on macOS.
- The evaluation process loads the same modules: about 190–250 MiB in one measurement on a
  2,000-line file. An evaluation that computes much leaves it larger (about 700 MiB after one
  that took 4.6–6.3 s), so it is also stopped after any evaluation over a second; the next
  evaluation starts it again, which takes a little longer.
- **Nothing limits this by default**, so files open from many folders add up. On a machine with
  little memory, set `idris2.ideMode.maxSessions` to `3` and `idris2.ideMode.maxBackgroundChecks`
  to `1`: fewer compilers run and fewer files are checked at once.
- The trade-off: a project whose compiler was stopped to stay within the limit starts a new one
  at its next check, which loads its modules again.
- **Stop Backend → All projects** stops them all. The limits and **Stop Backend** apply to each
  VS Code window separately: with two windows open, up to twice as many compilers can run.
- Two windows that check files of the same project (two folders of one package, or one file
  opened in both) each run their own compiler, and both write the same build directory. Whether
  that can spoil its build files has not been settled; **Stop Backend** in one window avoids it.

## Privacy and security

- No telemetry; the extension itself makes no network requests. pack's `idris2` and `idris2-lsp`
  wrappers start pack, which may contact the network to update its package database.
- The install commands only type a command into a terminal that opens in your home directory.

### Restricted Mode

In an untrusted workspace the extension runs no program at all — not even to read versions — and
reads `.ipkg` files with a limited built-in reader. Highlighting, snippets and the other editing
aids work, and so do Next / Previous Hole; interactive editing and the Holes view need a trusted
workspace. The
workspace's values of the `idris2.toolchain.*` paths and environment, `loosePackages` and
`extraArgs` apply only once the workspace is trusted.

### What runs where

- In a trusted workspace the extension runs short queries of `idris2` and `idris2-lsp`
  (`--version`, reading an `.ipkg`, and similar), one at a time, with a time limit, in the tools'
  own directories. It never starts `pack` itself.
- To check files it runs `idris2` in IDE mode **in the project's directory** — the folder of the
  `.ipkg`, or of a file without one — because the compiler reads the package from there.
- With pack's `idris2`, pack also reads the `pack.toml` of every folder above the one the
  compiler starts in, also above a trusted workspace folder, which the extension does not ask
  about. What such a file can make pack do has not been examined.

### Folders outside the workspace

Starting the compiler in a folder can run code placed in that folder. So for a folder outside
the trusted workspace folders (a package above the folder you opened, a file opened from
elsewhere) the extension asks first:

| Answer | Effect |
|---|---|
| **Allow** | for this window |
| **Always Allow for This Folder** | remembered; revoke it with **Manage Allowed Folders…** |
| **Don't Allow** | for this window; files there get highlighting only |

- The question names the package file that chose the folder, if one did. While it waits, the
  status item's **Allow…** link shows it again.
- The folder is named last, in quotes, with line breaks, other invisible characters and
  quote look-alikes written out, and a very long path shortened in the middle (the whole path is
  in the **Idris 2** output), so that a folder's name cannot add to or hide the warning.
- Folder names and compiler messages quoted in notifications and in the status item are shown as
  text, so a `[label](command:…)` in them is no link. The status item puts what it says about
  permissions before any path.
- On macOS and Linux the compiler starts in the folder as the extension judged it (symbolic links
  resolved). Right before each check, the extension makes sure the compiler would use the package
  it was started for:
  - for a file without a package, that no package file has appeared above its folder (one created
    later, or one above a folder reached through a symbolic link);
  - for a package, that its `.ipkg` is still there (not renamed or removed);
  - and that the folder is still the one it started in (not moved, deleted or replaced).

  Otherwise the compiler would move to another package's folder: the file is not checked, that
  compiler is stopped, and the status says why.

### Transport

- The extension talks to the compiler over its standard input and output: no network port is
  opened (`idris2.ideMode.transport` = `stdio`, the default on every platform).
- `socket` can be chosen in your user settings only — never in a workspace's, nor in a remote
  machine's (such as those a dev container's configuration fills). `idris2.ideMode.extraArgs`
  cannot bring it in: with `--ide-mode-socket` there, the compiler is not started.
- With `socket` the compiler listens on a local TCP port (127.0.0.1) and serves the first program
  that connects, without checking which one. The extension connects as soon as the compiler
  prints the port, but another program on this computer can connect first (from the moment the
  port is open) and use the compiler as you — including running programs.
- The extension notices when its own connection gets no answer, stops that compiler and does not
  restart it by itself, but by then the other program may have acted. **Do not choose `socket` on
  a computer shared with other users.**

### Evaluating expressions

**Evaluate Selection** runs a second compiler process with the same permission and transport,
refuses REPL commands and shows `IO` actions without running them. It can run elaborator scripts
(the project's, installed packages' macros, a `%runElab` in the selection): see
[Compile-time code](#compile-time-code).

### Interactive editing

- The names an editing command takes from the file (a hole's, a variable's, a function's) are
  sent to the compiler only when they are Idris names, so that text in a file cannot make the
  compiler run another command. The expression typed into **Refine Hole…** is sent only as the
  expression.
- **Refine Hole…** has the compiler check that expression as Evaluate Selection does, so it runs
  the elaborator scripts it reaches (see [Compile-time code](#compile-time-code)): tried with
  idris2 0.8.0, a `%macro` applied in the expression and a `%runElab` in it (where
  `ElabReflection` was on) each wrote a file. This is accepted, as for Evaluate Selection
  (decided 2026-09-30): nothing refuses such an expression.
- An answer changes only the file the command asked about, and only if the file has not changed
  since.

### Compiler text

Types, documentation, values and error messages quote your source and that of installed packages.
The extension shows them as text:

- Its hovers never run commands or render HTML; a docstring's markup, `command:` links and icons
  stay literal.
- Invisible characters that could reorder or hide text (bidirectional controls, zero-width and
  other invisible characters) are written out as `\u{…}` in: hovers, inlay hints, evaluation
  results, the notifications of the type, documentation, evaluation and editing commands and of a
  compiler that stopped, the completion list's labels (the name inserted is the compiler's), lists
  to pick from, the Holes view, and a documentation tab's title.
- The errors and warnings of a check (the Problems panel, the editor's hover over a problem) are
  handed to VS Code as the compiler wrote them, without that.
- The documentation document (**Docs at Cursor**, **Show Documentation…**) shows the compiler's
  text as it is, as plain text, where VS Code's own marking of such characters applies.
- That document is a `.txt` document: if you associated `*.txt` with another language, or another
  extension claims some `.txt` names (the Python extension takes names containing `requirements`
  or `constraints`), it opens in that language.

### Protocol trace

The protocol trace (`idris2.trace.protocol`, off by default) contains your source text and paths.
It is written to an output channel, which VS Code also keeps as a file in its logs folder
(**Developer: Open Extension Logs Folder**) for several sessions; it is not sent anywhere.

## Diagnosing problems

- **Show Output** shows the extension's log. **Show Protocol Trace** shows the messages
  exchanged with the compiler, with `idris2.trace.protocol` on.
- **Report Issue…** opens VS Code's issue reporter with the setup information filled in.
- **Idris 2 (Developer): Send Raw Protocol Request…** (while `idris2.trace.protocol` is on) sends
  one request you type to the compiler of the active file's project.
- A raw request can do anything the compiler's interactive mode can, as you:
  `(:interpret ":sh \"…\"")` runs a shell command, and `(:interpret ":cd …")` moves the compiler
  to another folder, where later checks look for a package, until **Restart Backend**.
- A raw `:load-file` is sent as typed, without the check that the compiler would use the file's
  package, so it can move the compiler to another package's folder as well.

## Known limitations

- **The saved file.** The compiler checks the file as saved on disk, and its answers (types,
  definitions, completions, inlay hints, evaluation) refer to it. Go to Definition into another
  file that changed on disk since the last check (a `git checkout`, a formatter) may land on
  another line until the file you are in is checked again. In the Holes view, an imported module's
  holes are those of the last check that reported them, until the file checked then, or the module
  itself, is checked again. Most editing commands save the file first. Checking while you type
  arrives with a later milestone ([roadmap](ROADMAP.md)).
- **Literate files need LF line ends.** The compiler drops a CRLF line break outside the code:
  a `.lidr` with CRLF does not compile, and a Markdown file with CRLF compiles with its lines
  shifted, which puts its errors, hovers and highlighting on the wrong lines. The status bar shows
  `CRLF` or `LF`; clicking it switches.
- **A lone CR** (a carriage return without a line feed) starts a new line in the editor, but not
  always for the compiler. In a `.idr` file the errors and warnings after it are shown too high, one
  line per lone CR before them. In a literate file, errors, hovers, highlighting, inlay hints and
  definitions after it may land on another line or column.
- **One file per project at a time.** The compiler answers about the file it checked last.
  Hovers, inlay hints, completion and Go to Definition in another editor of the same project,
  even one side by side, may not answer until you click into it, which checks that file again —
  with `idris2.checking.trigger` set to `manual`, until you run **Check File** there; its inlay
  hints meanwhile are those found before, if any.
- **Go to Definition** finds global names only: the compiler looks definitions up by name, so a
  local variable has none to go to.
- **Inlay hints** show each variable's type once per clause or signature, where it first appears.
- **Completion** offers the names the compiler knows from the file's last check, without saying
  what kind of name each is. After a qualifier (`Data.Vect.fil`) it offers every name that starts
  with what was typed, whatever its namespace: the compiler's completion ignores namespaces.
- **Warnings** come only when the compiler rebuilds a file. A file whose build output is up to
  date from an earlier session shows none until it is rebuilt, and its status reads `up to date`
  instead of `✓`. A file closed and opened again in the same window gets back the warnings it
  showed, if its text did not change.
- **Saving during a build.** The compiler rebuilds a file only when it was saved after its build
  output was written. A file saved again while it was still being built keeps the result of the
  text read first; edit and save it once more.
- **Unusual paths.** On macOS and Linux a file is not checked when its path contains `\`, `:` or
  `?`, or a folder name of only white space: the compiler reads such a path differently (`\` as
  a folder separator), so it would look for its package elsewhere and could check another file.
  The status says so.
- **`%logging` output.** With the `stdio` transport, a file whose `%logging` output quotes text
  that looks like a reply of the compiler's protocol (six hex digits, then `(:return ` or another
  reply's start, e.g. in a string) cannot be checked: the check fails with a protocol error. The
  `socket` transport is not affected, but read [Transport](#transport) first.
- **Evaluation** reloads the file before every evaluation and has its own process and status
  rules: see [Evaluation](#evaluation).
- **Interactive editing** has the compiler's limits: see
  [When a command cannot run](#when-a-command-cannot-run).
- **Interactive editing, not yet handled** (found in the last review, left for later):
  - Two shapes where an answer of another width can change the program without an error are not
    refused: a hole on a continuation line that starts left of a block entry begun above
    (`f x = case x of _ => 1 +`, then a line with the hole left of the `_`), and an entry whose
    first token is a bracket or string opened at the end of the hole's line (`case x of (`, the
    pattern on the next line). Indent such a continuation line past the entry, or put the entry's
    first token and what follows it on one line; otherwise check the result.
  - Some refusals are not needed: a hole before the `|]` of an idiom bracket opened on a line
    above, and a hole before or inside a `with` expression (`with Prelude.(::) …`). Fill such a
    hole by hand.
  - A hole in a `parameters` header of three or more lines, where a line between the keyword's and
    the hole's starts left of the hole's line, is not seen as in the header: the answer is applied
    and the file stops parsing. Undo it.
  - Make Case right after a backtick (``x `div`?h``) leaves a file that does not parse: undo, put a
    space between the backtick and the hole, and run it again.
  - Next Result and Next Definition do not scroll to the result they replace; it may be off-screen.
  - The Holes view groups a file's holes under `Main` when its `module` line starts with a comment
    or has a non-breaking space before the name.
- **The Holes view** asks the compiler after every check, also while the view is hidden (one
  request, plus one per name it lists); on holes of large types that can take seconds, during which
  the compiler answers nothing else. When that takes longer than `idris2.ideMode.longActionTimeout`,
  the compiler is restarted, a notification says so, and the view stops asking for that file's
  holes until its text changes or **List Holes** lists them (which can take as long; it offers
  Cancel). Past the first 2,000 names, only holes named like a `?name` of
  the checked file are listed, without a location: those of its module under it (a click selects
  the first such `?name`), others under their module. With
  `idris2.ideMode.maxBackgroundChecks` set, a file checked in the background can be missing until
  it is checked again.
- **Resource use** is not limited by default, and two windows on one project share a build
  directory: see [Resource use](#resource-use).
- **Native Windows** is not supported (Idris 2 itself needs MSYS2 to build there); use WSL.
- **pack and idris2-lsp** support has been tested against simulated installations only.
- **The grammar's** known limits (rare layouts) are listed in
  [test/grammar/idris2-scopes.md](../test/grammar/idris2-scopes.md).
