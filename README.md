<p align="center">
  <img src="media/idris-logo-256.png" alt="Idris logo" width="112">
</p>

# Idris 2 for Visual Studio Code

Language support for [Idris 2](https://www.idris-lang.org/), a purely functional programming
language with first-class dependent types.

> **Preview.** The extension is in early development and not yet on the Marketplace. It
> currently provides highlighting, editing support, toolchain detection and the compiler's
> errors and warnings; types, holes, case splitting and proof search are being built next —
> see the [roadmap](docs/ROADMAP.md).

## Features

- **Errors and warnings from the compiler**: when you open or save an Idris file, the extension
  checks it with the compiler's IDE mode and shows its errors and
  warnings in the editor and the Problems panel — for files in a package (`.ipkg`) and for
  single files, literate ones (`.lidr`, `.idr.md`, …) included. Errors in an imported module
  and a malformed `.ipkg` are shown where they are, and the files they kept from being checked
  are checked again once they are fixed and saved, and a file changed on disk outside the editor
  (a checkout) is checked again. The language status item says `checking…`, `✓`, `2 errors`,
  `stale` (unsaved changes, or a file changed on disk and not checked yet) or `stopped`.
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
| `idris2.ideMode.maxSessions` | `0` | The most compiler processes kept running at once in this VS Code window (`0`: no limit; each window counts its own). Above it, the idle one used least recently is stopped (never a busy one, never the active file's); it starts again at its project's next check |
| `idris2.ideMode.maxBackgroundChecks` | `0` | The most files other than the active one checked at once in this VS Code window (`0`: no limit; each window counts its own); the others wait their turn, and **Stop Backend** drops those still waiting. The active file never waits for them: within one project, where the compiler answers one check at a time, its check goes before the others waiting, after the one being compiled. A file whose folder waits for your permission takes no turn meanwhile |
| `idris2.diagnostics.includeSourceExcerpt` | `false` | Keep the compiler's source excerpt in the messages |
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
- The protocol trace (off by default) contains your source text and paths. It is written to an
  output channel, which VS Code also keeps as a file in its logs folder (**Developer: Open
  Extension Logs Folder**) for several sessions; it is not sent anywhere.
- The install commands only type a command into a terminal that opens in your home directory.

## Known limitations

- The compiler checks the file as saved on disk; checking while you type, hover types, holes
  and interactive editing arrive with the next milestones.
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
  on macOS. Nothing limits this by default, so files open from many folders at once add up. On a
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
- Windows support is experimental; it is tested with simulated tools only.
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

The planned features — hover, go to definition, holes and interactive editing, a goal panel,
check-as-you-type, REPL and build integration, literate Markdown and LaTeX, Unicode input — are
described in [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing

Issues and pull requests are welcome at
[github.com/etairi/vscode-idris2](https://github.com/etairi/vscode-idris2). See
[CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and the project layout.

## License

[MIT](LICENSE). The Idris logo is copyright © Edwin Brady and is used under the BSD 3-Clause
license of the [Idris 2](https://github.com/idris-lang/Idris2) repository; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This extension is not affiliated with or
endorsed by the Idris project.
