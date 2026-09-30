<p align="center">
  <img src="media/idris-logo-256.png" alt="Idris logo" width="112">
</p>

# Idris 2 for Visual Studio Code

Language support for [Idris 2](https://www.idris-lang.org/), a purely functional programming
language with first-class dependent types.

> **Preview.** The extension is in early development and not yet on the Marketplace. It
> currently provides highlighting, editing support, toolchain detection, the compiler's errors
> and warnings, and answers from the compiler — types on hover, go to definition, documentation,
> completion, semantic highlighting, inlay hints and evaluation of expressions; holes, case
> splitting and proof search are being built next — see the [roadmap](docs/ROADMAP.md).

## Features

- **Errors and warnings from the compiler**: when you open or save an Idris file, the extension
  checks it with the compiler's IDE mode and shows its errors and
  warnings in the editor and the Problems panel — for files in a package (`.ipkg`) and for
  single files, literate ones (`.lidr`, `.idr.md`, …) included. Errors in an imported module
  and a malformed `.ipkg` are shown where they are, and the files they kept from being checked
  are checked again once they are fixed and saved, and a file changed on disk outside the editor
  (a checkout) is checked again. The language status item says `checking…`, `✓`, `2 errors`,
  `stale` (unsaved changes, or a file changed on disk and not checked yet) or `stopped`.
- **Types, definitions and documentation from the compiler**: hovering over a name shows its
  type, local pattern variables included, and the first paragraph of its documentation;
  **Type at Cursor** and **Docs at Cursor** do the same from the keyboard. **Go to Definition**
  (F12) jumps to the definition of a global name, also in another file or in an installed
  package whose sources are installed. **Show Documentation…** opens the compiler's
  documentation of a name in a read-only document, and **Browse Namespace…** lists the names of
  a namespace with their types. The answers come from the compiler's last check of the saved
  file.
- **Semantic highlighting, outline and completion**: the compiler's view colours functions,
  types, data constructors, bound variables, modules and keywords (in the token types of
  idris2-lsp, so themes colour both alike); the Outline and breadcrumbs list the declarations;
  the occurrences of the name under the cursor are highlighted; **Ctrl+Space** completes names in
  scope, keywords and `%` directives.
- **Inlay hints** after pattern variables with their types (`vlen xs = …` shows `: Vect ?_ ?_`
  after `xs`; `idris2.inlayHints.variableTypes`). While a file has unsaved changes they show the
  types of its last check, staying with their variables.
- **Evaluate Selection** evaluates the selected expression in the context of the saved file and
  shows the result after the line and in a hover (**Clear Evaluation Results** removes them). It
  evaluates expressions only: an `IO` action is shown as a value, not run, and REPL commands
  such as `:exec` are refused.
- **Keyboard shortcuts** for Type at Cursor, Docs at Cursor and Evaluate Selection in Idris
  editors: `Ctrl+C Ctrl+T` / `D` / `E` on macOS (the Control key), `Ctrl+Alt+I T` / `D` / `E`
  on Linux; `idris2.keybindings.scheme` chooses the other form, or none. A keymap extension that
  binds `Ctrl+C` itself, such as VSCodeVim, takes precedence over the `Ctrl+C` shortcuts: choose
  `prefix` then.
- **Syntax highlighting** for Idris 2 (`.idr`), literate Idris (`.lidr`, bird style) and package
  files (`.ipkg`). The grammar follows the Idris 2 compiler's own lexer: holes (`?goal`),
  pragmas (`%default total`), string interpolation, multi-line and raw strings, nested and
  documentation comments, quantities (`0`/`1`), `failing` blocks and `\case`.
- **Editing support**: comment toggling, bracket matching and auto-closing, indentation after
  `where`, `do`, `of`, `=` and friends, the `> ` marker continued on Enter in `.lidr` files,
  indentation-based folding, **Expand Selection** that grows through brackets, clauses and
  declarations, and `?hole` / `x'` selected as whole words.
- **Snippets** for common Idris 2 declarations (`data`, `record`, `interface`, `case`, `with`,
  `failing`, …) and `.ipkg` files. Every snippet expands to code that the compiler accepts.
- **Toolchain detection**: finds `idris2`, `idris2-lsp` and `pack`, shows the compiler version in
  the language status bar, and checks whether the language server matches the compiler.
  **Show Setup Information** gives a full report of what was found and how.
- **Guided installation**: commands that type the install command for Idris 2, pack or
  idris2-lsp into a terminal. Nothing is run until you press Enter.
- **Project detection**: every file is matched to its `.ipkg` package the way the compiler
  finds it, including a package above the folder you opened.
- **Workspace Trust**: in an untrusted (Restricted Mode) workspace the extension never runs a
  program; highlighting and editing support keep working. Outside the trusted folders it asks
  before it starts the compiler (see *Privacy and security*).

## Requirements

- Visual Studio Code 1.138 or newer.
- [Idris 2](https://idris2.readthedocs.io/en/latest/) for checking and the toolchain features
  (tested with Idris 2 0.8.0). Highlighting, editing support and snippets work without it.
- Optional: [pack](https://github.com/stefan-hoeck/idris2-pack) and
  [idris2-lsp](https://github.com/idris-community/idris2-lsp).
- macOS or Linux. On Windows, use VS Code with
  [WSL](https://code.visualstudio.com/docs/remote/wsl): the extension then runs in Linux
  with a Linux `idris2`. Native Windows is not supported.

## Installation

The extension is not yet published. To install it from source (Node.js 24 required):

```sh
git clone https://github.com/etairi/vscode-idris2
cd vscode-idris2
npm ci
npm run package
code --install-extension vscode-idris2-0.0.1.vsix
```

Disable other Idris extensions while you use this one: they claim the same file types.

## Getting started

1. Open a folder that contains Idris 2 code, and trust it when VS Code asks.
2. Open an `.idr` file. Errors and warnings appear when it is opened and each time you save it.
3. Hover over the `{}` next to the **Idris 2** language mode in the status bar: the language
   status shows the compiler version and the result (for example
   `Idris 2 0.8.0 · IDE mode · 1 error`), or a **Setup…** link if `idris2` was not found.
4. Run **Idris 2: Show Setup Information** from the Command Palette to see the detected
   toolchain and the package of the current file.

The **Get Started with Idris 2** walkthrough on VS Code's Welcome page covers the same steps.

## Commands

All commands are in the Command Palette under **Idris 2**, and in the **Idris 2** menu of the
editor title bar for Idris files.

| Command | Description |
|---|---|
| Show Commands… | Lists the commands below (also opened by clicking the language status) |
| Check File | Check the current file now (the saved file on disk) |
| Type at Cursor | Show the type of the name at the cursor (as the hover does) |
| Docs at Cursor | Open the documentation of the name at the cursor |
| Show Documentation… | Open the documentation of a name you type |
| Browse Namespace… | List a namespace's names and types; pick one to open its documentation |
| Evaluate Selection | Evaluate the selected expression (expressions only; `IO` actions are shown, not run) |
| Clear Evaluation Results | Remove the results shown in the editor |
| Restart Backend | Restart the compiler of this project, or of all projects |
| Stop Backend | Stop the compiler of this project, or of all projects, for example before `pack build`; the next check starts it again |
| Show Setup Information | Report of the tools found, their versions and the current file's package |
| Rescan Toolchain | Look for `idris2`, `idris2-lsp` and `pack` again |
| Install Idris 2… | Type the install command into a terminal (macOS), or open the installation guide |
| Install pack… | Type pack's install command into a terminal, or open pack's instructions |
| Install or Update idris2-lsp with pack | Type `pack install-app idris2-lsp` into a terminal |
| Manage Allowed Folders… | List the folders outside the workspace where the compiler may always start, and revoke them |
| Report Issue… | Open VS Code's issue reporter with the setup information filled in |
| Show Output | Show the extension's log |
| Show Protocol Trace | Show the messages exchanged with the compiler (with `idris2.trace.protocol` on) |
| Open Settings | Open the extension's settings |
| Open Idris 2 Documentation | Open the Idris 2 documentation in the browser |

For diagnosing problems, **Idris 2 (Developer): Send Raw Protocol Request…** sends one request
that you type to the compiler of the active file's project; it is available while
`idris2.trace.protocol` is on. A request can do anything the compiler's interactive mode can,
as you: `(:interpret ":sh \"…\"")` runs a shell command, and `(:interpret ":cd …")` moves the
compiler to another folder, where later checks look for a package, until **Restart Backend**. A
raw `:load-file` is sent as typed, without the extension's check that the compiler would use the
file's package, so it can move the compiler to another package's folder as well.

## Settings

| Setting | Default | Description |
|---|---|---|
| `idris2.toolchain.idris2Path` | `""` | Path to `idris2`. Empty: search `PATH`, pack's directories and the usual install locations |
| `idris2.toolchain.lspPath` | `""` | Path to `idris2-lsp`. Empty: search as above |
| `idris2.toolchain.packPath` | `""` | Path to `pack`. Empty: search as above |
| `idris2.toolchain.preferPack` | `false` | Search pack's directories before `PATH` |
| `idris2.toolchain.env` | `{}` | Extra environment variables for the tools the extension runs |
| `idris2.checking.trigger` | `"onSave"` | When a file is checked: `onSave` (when opened and saved), `afterDelay` (also save it automatically after a pause in typing — this writes your files), `manual` (only **Check File**) |
| `idris2.checking.delay` | `700` | The pause in milliseconds for `afterDelay` |
| `idris2.ideMode.transport` | `"stdio"` | `stdio` (the compiler's standard input and output) or `socket` (a local port; see *Privacy and security* before choosing it). User settings only |
| `idris2.ideMode.isolateBuildDir` | `true` | Keep the editor's build files in `build/.vscode-idris2`, apart from your own builds (not possible when the `.ipkg` sets `builddir` or a `--build-dir` in `opts`, or `extraArgs` has a `--build-dir`) |
| `idris2.ideMode.loosePackages` | `[]` | Packages for files without an `.ipkg`, e.g. `["contrib"]` |
| `idris2.ideMode.extraArgs` | `[]` | Extra arguments for the compiler (not `--ide-mode` or `--ide-mode-socket`: with either, the compiler is not started) |
| `idris2.ideMode.requestTimeout`, `longActionTimeout`, `idleTimeout` | `5000`, `60000`, `600000` | Time limits in milliseconds: a quick request, checking a file, and how long an unused compiler keeps running |
| `idris2.ideMode.maxSessions` | `0` | The most compiler processes kept running at once in this VS Code window (`0`: no limit; each window counts its own; a project's evaluation process counts too, once it has answered: starting an evaluation stops no other process). Above it, idle ones are stopped, never a busy one: first evaluation processes, then the checking processes of projects other than the active file's, the one used least recently first; a stopped one starts again when it is next needed |
| `idris2.ideMode.maxBackgroundChecks` | `0` | The most files other than the active one checked at once in this VS Code window (`0`: no limit; each window counts its own); the others wait their turn, and **Stop Backend** drops those still waiting. The active file never waits for them: within one project, where the compiler answers one check at a time, its check goes before the others waiting, after the one being compiled. A file whose folder waits for your permission takes no turn meanwhile |
| `idris2.diagnostics.includeSourceExcerpt` | `false` | Keep the compiler's source excerpt in the messages |
| `idris2.inlayHints.variableTypes` | `true` | Show the types of pattern variables as inlay hints |
| `idris2.eval.inlineResults` | `true` | Show Evaluate Selection's result in the editor; off: in a notification |
| `idris2.eval.timeout` | `10000` | Milliseconds an evaluation may take; a longer one stops the evaluation's compiler process |
| `idris2.keybindings.scheme` | `"auto"` | Keyboard shortcuts: `chords` (`Ctrl+C Ctrl+<letter>`), `prefix` (`Ctrl+Alt+I <letter>`), `none`; `auto` is `chords` on macOS and `prefix` elsewhere. On Linux, `chords` makes `Ctrl+C` start a shortcut in Idris editors instead of copying, and `prefix` does the same to `Ctrl+Alt+I`, which then no longer opens the Chat view there. A keymap extension that binds `Ctrl+C` itself (VSCodeVim) takes precedence over `chords` (User settings only) |
| `idris2.trace.protocol` | `false` | Record the messages exchanged with the compiler in an output channel (user settings only) |

The extension also sets a few editor defaults for Idris files (two-space indentation with
spaces, semantic highlighting on, and word boundaries that keep `?hole` and `x'` whole). You
can override them in your settings under `[idris2]` and `[lidr]`.

## Privacy and security

- No telemetry; the extension itself makes no network requests.
- Restricted Mode (an untrusted workspace): the extension runs no program at all.
- In a trusted workspace it runs short queries of `idris2` and `idris2-lsp` (`--version`,
  reading an `.ipkg`, and similar) one at a time, with a time limit, in the tools' own
  directories; it never starts `pack` itself.
  To check files it runs `idris2` in IDE mode **in the project's directory** — the folder of
  the `.ipkg`, or of a file without one — because the compiler reads the package from there.
  Starting the compiler in a folder can run code placed in that folder, so for a folder outside
  the trusted workspace folders (a package above the folder you opened, or a file opened from
  elsewhere) the extension first asks: **Allow** (this window), **Always Allow for This Folder**
  (remembered; revoke it with **Idris 2: Manage Allowed Folders…**) or **Don't Allow**; the
  question names the package file that chose the folder, if one did. Until you allow it, files
  there get highlighting only; while the question waits, the status item's **Allow…** shows it
  again. On macOS and Linux the compiler is started in the folder as the extension judged it
  (symbolic links resolved). Right before each check is sent to the compiler, the extension makes
  sure that it would use the package it was started for: for a file without a package, that it would not find
  a package file above its folder after all (one created later, or one above a folder reached
  through a symbolic link); for a package, that its `.ipkg` is still there (not renamed or
  removed); and that the folder is still the one the compiler was started in (not moved, deleted
  or replaced). Otherwise the compiler would move to another package's folder, so the file is
  then not checked, that compiler is stopped, and the status says why. Folder names and compiler
  messages quoted in notifications and in the status item are shown as text: VS Code would turn
  a label in square brackets followed by a `command:` target in parentheses into a link that
  runs a command. The question names the folder
  last, in quotes, with line breaks, other invisible characters and characters that look like
  quotes written out and a very long path shortened in the middle (the whole path is in the
  **Idris 2** output), so that a folder's name cannot add to or hide the question's warning; the
  status item puts what it says about permissions before any path.
- With pack's `idris2`, pack also reads the `pack.toml` of every folder above the one the
  compiler starts in, including folders above a trusted workspace folder, which the extension
  does not ask about. What such a file can make pack do has not been examined.
- The extension talks to the compiler over the compiler's standard input and output: no
  network port is opened (`idris2.ideMode.transport` = `stdio`, the default on every platform).
  The other choice, `socket`, can be made in your user settings only — never in a workspace's
  settings, nor in a remote machine's (such as those a dev container's configuration fills) —,
  and `idris2.ideMode.extraArgs` cannot bring it in (with
  `--ide-mode-socket` there the compiler is not started). With `socket` the compiler listens on a
  local TCP port (127.0.0.1) and serves the first program that connects, without checking which
  one. The extension connects as soon as the compiler
  prints the port, but another program on this computer can connect first (from the moment the
  port is open) and then use the compiler as you — including running programs. The extension
  notices when its own connection gets no answer, stops that compiler and does not restart it by
  itself, but by then the other program may have acted. Do not choose `socket` on a computer
  shared with other users.
- pack's `idris2` and `idris2-lsp` wrappers start pack, which may contact the network to update
  its package database.
- **Evaluate Selection** runs a second compiler process for the project, in the same folder, with
  the same permission and the same transport as the one that checks files; it starts only when
  you evaluate an expression there — never by itself, also not after it ended or was stopped —,
  stops after 2 minutes without an evaluation (or after `idris2.ideMode.idleTimeout`, if that is
  shorter; never for being idle when that setting is `0`) and after an evaluation that took more
  than a second, and keeps its build files in `build/.vscode-idris2-eval`. The extension refuses, before anything is
  sent, any text the compiler's REPL would read as a command (`:exec`, `:sh`, `:set …`, also
  behind white space, comments or invisible characters), and never changes how that process
  evaluates, so an `IO` action is shown as a value and not run. Evaluating an expression can
  still run elaborator scripts, which can read and write files in the project's folders (by
  relative paths, which `..` cannot leave, but a symbolic link in them can): the script of any
  `%macro` function the
  expression uses — defined in the project or in an installed package, with no `%language
  ElabReflection` needed —, and a `%runElab` in the expression when that extension is on in the
  compiler (a module that turns it on, built by the same process, is enough). Checking a file runs
  the scripts the file uses; evaluating runs those the expression uses.
- Types, documentation, values and error messages from the compiler quote your source and that of
  installed packages. The extension shows them as text: its hovers never run commands or render
  HTML, a docstring's markup, `command:` links and icons stay literal, and in its hovers, inlay
  hints, evaluation results, the notifications of its type, documentation and evaluation
  commands and of a compiler that stopped, the labels of the completion list (the name inserted
  is the compiler's), lists to pick from and the title of a documentation tab, invisible
  characters that could reorder or hide text (bidirectional controls, zero-width and other
  invisible characters) are written out as `\u{…}`. The errors and warnings of a check (the
  Problems panel, the editor's hover over a problem) are handed to VS Code as the compiler wrote
  them, without that. The documentation document itself
  (**Docs at Cursor**, **Show Documentation…**) shows the compiler's text as it is, as plain text,
  where VS Code's own marking of such characters applies. That document is a `.txt` document: if
  you associated `*.txt` with another language, or another extension claims some `.txt` names (the
  Python extension takes names containing `requirements` or `constraints`), it opens in that
  language.
- The protocol trace (off by default) contains your source text and paths. It is written to an
  output channel, which VS Code also keeps as a file in its logs folder (**Developer: Open
  Extension Logs Folder**) for several sessions; it is not sent anywhere.
- The install commands only type a command into a terminal that opens in your home directory.

## Known limitations

- The compiler checks the file as saved on disk, and its answers (types, definitions,
  completions, inlay hints, evaluation) refer to the saved file: while a file has unsaved changes
  the hover says so, and the inlay hints keep the types of the last check, also where an edit
  changed a type (a signature being edited) until the file is saved. Checking while you type,
  holes and interactive editing arrive with the next milestones.
- Literate files (`.lidr`, `.idr.md`, `.idr.org`, …) need LF line ends: the compiler drops a CRLF
  line break outside the code, so a `.lidr` with CRLF does not compile, and a Markdown file with
  CRLF compiles with its line numbers shifted, which puts its errors, hovers and highlighting on
  the wrong lines. The status bar shows `CRLF` or `LF` for the file; clicking it switches it.
- The compiler answers about one file of a project at a time, the one it checked last. Hovers,
  inlay hints, completion and Go to Definition in another editor of the same project, even one
  shown side by side, may not answer until you click into it, which checks that file again; its
  inlay hints meanwhile are those found before, if any.
- Go to Definition finds global names only: the compiler looks definitions up by name, so a local
  variable has none to go to. Inlay hints show each variable's type once per clause or signature,
  where it first appears. Completion offers the names the compiler knows from the file's last
  check, without saying what kind of name each is; after a qualifier (`Data.Vect.fil`) it offers
  every name that starts with what was typed, whatever its namespace, because the compiler's
  completion ignores namespaces.
- Evaluate Selection checks the file again in its own process before every evaluation, so that it
  sees the saved files as they are (about 0.1–0.4 s for an unchanged file in our measurements); the first
  evaluation in a project compiles its modules into `build/.vscode-idris2-eval`. An evaluation
  that does not end (a function that loops) makes the compiler's memory grow fast — by more than
  a gigabyte within seconds in one measurement —, so it is stopped after `idris2.eval.timeout`
  (10 seconds), together with the evaluation's compiler process, which starts again at the next
  evaluation; an evaluation still running after a second can be cancelled from its notification.
- The language status and the crash notices are about the compiler that checks files, not the
  evaluation's: the status can read `stopped` while an evaluation's compiler runs. **Stop
  Backend** and **Restart Backend** stop both (Restart starts only the checking one again).
- On macOS and Linux a file is not checked when its path contains `\`, `:` or `?`, or a folder
  name of only white space: the compiler reads such a path differently (`\` as a folder separator),
  so it would look for its package elsewhere and could check another file. The status says so.
- The compiler reports a file's warnings only when it rebuilds the file. A file whose build
  output is up to date from an earlier session shows no warnings until it is rebuilt, and its
  status reads `up to date` instead of `✓`; a file closed and opened again in the same window
  gets back the warnings it showed, if its text did not change.
- **Resource use.** Each project (each `.ipkg` folder, and each folder of files without one) has
  its own compiler process, which runs until it has been idle for `idris2.ideMode.idleTimeout`
  (10 minutes) or the project's last file is closed, and files of different projects are checked
  at the same time. A project's first check compiles the project's modules that the file imports
  (into `build/.vscode-idris2`, unless the `.ipkg` names its own build directory), which takes
  time and memory; one idle process took about 75–210 MB of memory after checking a small file
  on macOS. Evaluating an expression starts a second process for the project, which loads the
  same modules — about 190–250 MiB in one measurement on a 2,000-line file —, and stops after 2
  minutes without an evaluation (never for being idle when `idris2.ideMode.idleTimeout` is `0`).
  An evaluation that computes much leaves that process larger (about 700 MiB after one that took
  4.6–6.3 seconds), so the process is also stopped after any evaluation that took more than a second;
  the next evaluation starts it again, which takes a little longer.
  Nothing limits this by default, so files open from many folders at once add up. On a
  machine with little memory, set for example `idris2.ideMode.maxSessions` to `3` and
  `idris2.ideMode.maxBackgroundChecks` to `1`: fewer compilers run and fewer files are checked
  at once, and a project whose compiler was stopped to stay within the limit starts a new one,
  which loads its modules again, at its next check. **Stop Backend → All projects** stops them
  all. The limits and **Stop Backend** apply to each VS Code window separately: with two windows
  open, up to twice as many compilers can run.
- Two windows that check files of the same project (for example two folders of one package, or
  one file opened in both) each run their own compiler, and both write the same build directory
  (`build/.vscode-idris2` by default). Whether two compilers writing there at once can spoil its
  build files has not been settled; **Stop Backend** in one of the windows avoids it.
- Native Windows is not supported (Idris 2 itself needs MSYS2 to build there); use WSL.
- pack and idris2-lsp support has been tested against simulated installations only.
- The compiler rebuilds a file only when it was saved after its build output was written. A file
  saved again while the compiler was still building it keeps the result of the text it read
  first; edit and save it once more to have the new text checked.
- With the `stdio` transport (the default), a file whose `%logging` output quotes text that looks
  like a reply of the compiler's protocol (six hex digits, then `(:return ` or another reply's
  start, e.g. in a string) cannot be checked: the check fails with a protocol error. The `socket`
  transport is not affected, but read *Privacy and security* before choosing it.
- The grammar's known limits (rare layouts) are listed in
  [test/grammar/idris2-scopes.md](test/grammar/idris2-scopes.md).

## Roadmap

The planned features — holes and interactive editing, a goal panel, check-as-you-type, REPL and
build integration, literate Markdown and LaTeX, Unicode input — are described in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing

Issues and pull requests are welcome at
[github.com/etairi/vscode-idris2](https://github.com/etairi/vscode-idris2). See
[CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and the project layout.

## License

[MIT](LICENSE). The Idris logo is copyright © Edwin Brady and is used under the BSD 3-Clause
license of the [Idris 2](https://github.com/idris-lang/Idris2) repository; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This extension is not affiliated with or
endorsed by the Idris project.
