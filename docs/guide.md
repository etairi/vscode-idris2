# User guide

How the Idris 2 extension behaves, in more detail than the [README](../README.md). Every setting
is also described in the Settings UI: search for `@ext:etairi.vscode-idris2`.

- [Checking files](#checking-files)
- [Code intelligence](#code-intelligence)
- [Evaluation](#evaluation)
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
| `stale` | unsaved changes, or the file changed on disk and was not checked yet |
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

## Keyboard shortcuts

In Idris editors, the letter `t` runs **Type at Cursor**, `d` **Docs at Cursor** and `e`
**Evaluate Selection**. `idris2.keybindings.scheme` chooses the form:

| Scheme | Keys | Note |
|---|---|---|
| `auto` (default) | | `chords` on macOS, `prefix` elsewhere |
| `chords` | `Ctrl+C Ctrl+<letter>` | on macOS the Control key, not Command; elsewhere `Ctrl+C` then no longer copies in Idris editors |
| `prefix` | `Ctrl+Alt+I <letter>` | outside macOS, `Ctrl+Alt+I` then no longer opens the Chat view in Idris editors |
| `none` | | no shortcuts; the commands stay in the Command Palette |

- A keymap extension that binds `Ctrl+C` itself (VSCodeVim does by default) wins over `chords`:
  choose `prefix` then.
- The setting is read from your user settings only: a workspace cannot change your keyboard.

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
| `idris2.ideMode.transport` | `"stdio"` | `stdio` or `socket` (see [Transport](#transport)); user settings only |
| `idris2.ideMode.isolateBuildDir` | `true` | Keep the editor's build files in `build/.vscode-idris2` |
| `idris2.ideMode.loosePackages` | `[]` | Packages for files without an `.ipkg`, e.g. `["contrib"]` |
| `idris2.ideMode.extraArgs` | `[]` | Extra compiler arguments; with `--ide-mode` or `--ide-mode-socket` among them, the compiler is not started |
| `idris2.ideMode.requestTimeout` | `5000` | Milliseconds for a quick request; a longer one restarts the compiler |
| `idris2.ideMode.longActionTimeout` | `60000` | Milliseconds for checking a file; likewise |
| `idris2.ideMode.idleTimeout` | `600000` | Milliseconds an unused compiler keeps running |
| `idris2.ideMode.maxSessions` | `0` | Most compiler processes per window (`0`: no limit); see below |
| `idris2.ideMode.maxBackgroundChecks` | `0` | Most files other than the active one checked at once (`0`: no limit); see below |
| `idris2.diagnostics.includeSourceExcerpt` | `false` | Keep the compiler's source excerpt in the messages |
| `idris2.inlayHints.variableTypes` | `true` | Types of pattern variables as inlay hints |
| `idris2.eval.inlineResults` | `true` | Evaluation results in the editor; off: in a notification |
| `idris2.eval.timeout` | `10000` | Milliseconds an evaluation may take; a longer one stops its process |
| `idris2.keybindings.scheme` | `"auto"` | See [Keyboard shortcuts](#keyboard-shortcuts); user settings only |
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
reads `.ipkg` files with a limited built-in reader. Highlighting, snippets and editing work. The
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

### Compiler text

Types, documentation, values and error messages quote your source and that of installed packages.
The extension shows them as text:

- Its hovers never run commands or render HTML; a docstring's markup, `command:` links and icons
  stay literal.
- Invisible characters that could reorder or hide text (bidirectional controls, zero-width and
  other invisible characters) are written out as `\u{…}` in: hovers, inlay hints, evaluation
  results, the notifications of the type, documentation and evaluation commands and of a
  compiler that stopped, the completion list's labels (the name inserted is the compiler's), lists
  to pick from, and a documentation tab's title.
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
  another line until the file you are in is checked again. Checking while you type, holes and
  interactive editing arrive with the next milestones ([roadmap](ROADMAP.md)).
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
- **Resource use** is not limited by default, and two windows on one project share a build
  directory: see [Resource use](#resource-use).
- **Native Windows** is not supported (Idris 2 itself needs MSYS2 to build there); use WSL.
- **pack and idris2-lsp** support has been tested against simulated installations only.
- **The grammar's** known limits (rare layouts) are listed in
  [test/grammar/idris2-scopes.md](../test/grammar/idris2-scopes.md).
