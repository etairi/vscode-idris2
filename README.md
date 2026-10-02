<p align="center">
  <img src="media/idris-logo-256.png" alt="Idris logo" width="112">
</p>

# Idris 2 for Visual Studio Code

Language support for [Idris 2](https://www.idris-lang.org/), a purely functional programming
language with first-class dependent types.

> **Preview.** Early development, published as a pre-release. A goal panel and checking while
> you type come next — see the [roadmap](docs/ROADMAP.md).

## Features

**Compiler feedback**
- Errors and warnings in the editor and the Problems panel, when you open or save a file
- Packages (`.ipkg`, found as the compiler finds them) and single files, literate ones included
- Result in the language status: `checking…`, `✓`, `2 errors`, `stale`, `stopped`

**Code intelligence**
- Types and documentation on hover, local pattern variables included
- Go to Definition (F12) for global names, across files and into installed packages' sources
- Completion of names in scope, keywords and `%` directives
- Semantic highlighting, Outline, breadcrumbs, highlights of the name under the cursor
- Inlay hints with the types of pattern variables
- **Show Documentation…** and **Browse Namespace…**
- **Evaluate Selection**: the value of the selected expression, after the line and on hover

**Holes and interactive editing**
- Case Split, Add Clause, Make Lemma / With / Case, Proof Search, Generate Definition, Intro,
  Refine Hole… (light bulb or keyboard, one undo step each); Add Missing Cases as a quick fix
- An answer put in place of a hole is bracketed when it is more than one token: `vlen xs = (S ?vlen_rhs_0)`
- **Next Result** / **Next Definition**: further results (`↻ next (n)` in the status bar)
- A **Holes** view in the **Idris 2** side bar: each hole's type and local variables, a click away;
  **List Holes**, **Next Hole**, **Previous Hole**

**Editing**
- Syntax highlighting for `.idr`, `.lidr` (bird style) and `.ipkg`, following the compiler's lexer
- Comment toggling, bracket matching, indentation on Enter, folding, Expand Selection
- Snippets for common declarations and `.ipkg` files

**Toolchain**
- Finds `idris2`, `idris2-lsp` and `pack`; **Show Setup Information** reports what was found
- Install commands typed into a terminal — nothing runs until you press Enter

The [user guide](docs/guide.md) describes each feature in detail.

## Requirements

- VS Code 1.138 or newer.
- [Idris 2](https://idris2.readthedocs.io/en/latest/) (tested with 0.8.0) for everything that asks
  the compiler; highlighting, editing and snippets work without it. Optional:
  [pack](https://github.com/stefan-hoeck/idris2-pack), [idris2-lsp](https://github.com/idris-community/idris2-lsp).
- macOS or Linux. On Windows, use [WSL](https://code.visualstudio.com/docs/remote/wsl) with a
  Linux `idris2`; native Windows is not supported.

## Installation

Install the pre-release of **Idris 2** (`etairi.vscode-idris2`) from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=etairi.vscode-idris2)
or [Open VSX](https://open-vsx.org/extension/etairi/vscode-idris2), or run
`code --install-extension etairi.vscode-idris2 --pre-release`. To build it from source (Node.js 24):

```sh
git clone https://github.com/etairi/vscode-idris2 && cd vscode-idris2
npm ci && npm run package
code --install-extension vscode-idris2-0.1.0.vsix
```

Disable other Idris extensions while you use this one: they claim the same file types.

## Quick start

1. Open a folder with Idris 2 code and trust it when VS Code asks.
2. Open an `.idr` file: errors appear when it opens and each time you save it.
3. Hover over `{}` next to **Idris 2** in the status bar: the compiler version, the result and a
   **Show Commands…** link (**Setup…** if `idris2` was not found).

The **Get Started with Idris 2** walkthrough on the Welcome page covers the same steps.

## Keybindings

In Idris editors, `Ctrl+C Ctrl+<key>` (`chords`, default on macOS) or `Ctrl+Alt+I <key>`
(`prefix`, default elsewhere), e.g. `Ctrl+C Ctrl+C` for Case Split:

| Key | Command | Key | Command |
|---|---|---|---|
| `T` | Type at Cursor | `S` | Proof Search |
| `D` | Docs at Cursor | `N` | Next Result (also after Generate Definition) |
| `E` | Evaluate Selection | `G` | Generate Definition (on its declaration or result: the next one) |
| `C` | Case Split | `I` | Intro |
| `A` | Add Clause | `R` | Refine Hole… |
| `L` / `W` / `M` | Make Lemma / With / Case | `[` / `]` | Previous / Next Hole |

Choose with `idris2.keybindings.scheme` (`none` turns them off); **Show Keybindings** lists your
scheme's keys. The letters follow the Vim bindings in the Idris docs, not Emacs idris-mode.

On macOS `Ctrl` is the Control key. Elsewhere, in Idris editors, `chords` takes over copy and
`prefix` the Chat view shortcut. With VSCodeVim, or another keymap that binds `Ctrl+C`, use `prefix`.

## Commands

All under **Idris 2** in the Command Palette; most also in the **Idris 2** menu of the editor
title bar of an Idris file.

| Command | What it does |
|---|---|
| Show Commands…, Show Keybindings | List the commands (also the language status's link); your scheme's keys |
| Check File | Check the current file now |
| Type at Cursor, Docs at Cursor | The type or documentation of the name at the cursor |
| Show Documentation…, Browse Namespace… | Documentation of a name you type; a namespace's names and types |
| Evaluate Selection, Clear Evaluation Results | Evaluate the selected expression; remove the results |
| Case Split, Add Clause, Make Lemma, Make With, Make Case, Intro, Refine Hole…, Add Missing Cases | Edit at the hole, variable or declaration under the cursor |
| Proof Search, Next Result, Generate Definition, Next Definition | Fill a hole or write a definition; the next candidate |
| Next Hole, Previous Hole, List Holes | Move between the holes of the file; list the compiler's holes |
| Restart Backend, Stop Backend | Restart or stop the compiler of this project or of all projects |
| Show Setup Information, Rescan Toolchain | What was found and how; search again |
| Install Idris 2…, Install pack…, Install or Update idris2-lsp with pack | Type the install command into a terminal, or open the instructions |
| Manage Allowed Folders… | Revoke folders outside the workspace where the compiler may always start |
| Show Output, Show Protocol Trace, Report Issue… | The log; the messages exchanged with the compiler; a pre-filled issue report |
| Open Settings, Open Idris 2 Documentation | The extension's settings; the Idris 2 docs in the browser |

## Settings

The ones you are most likely to change; all of them are in the Settings UI (search for
`@ext:etairi.vscode-idris2`), and the [guide](docs/guide.md#settings-in-depth) explains the trade-offs.

| Setting | Default | Description |
|---|---|---|
| `idris2.toolchain.idris2Path` | `""` | Path to `idris2`; empty: search `PATH`, pack's directories and the usual places |
| `idris2.checking.trigger` | `"onSave"` | `onSave`, `afterDelay` (also saves your files after a pause in typing), `manual` |
| `idris2.checking.saveBeforeAction` | `"always"` | An editing command saves the file first; `prompt` asks, `never` asks you to save |
| `idris2.ideMode.loosePackages` | `[]` | Packages for files without an `.ipkg`, e.g. `["contrib"]` |
| `idris2.ideMode.maxSessions` | `0` | Most compiler processes per window (`0`: no limit); try `3` on a small machine |
| `idris2.ideMode.maxBackgroundChecks` | `0` | Most files besides the active one checked at once (`0`: no limit); try `1` |
| `idris2.inlayHints.variableTypes` | `true` | Types of pattern variables as inlay hints |
| `idris2.eval.inlineResults` | `true` | Evaluation results in the editor; off: in a notification |
| `idris2.keybindings.scheme` | `"auto"` | `chords`, `prefix` or `none`; `auto` picks by platform |
| `idris2.holes.showInSideBar` | `true` | The Holes view in the Idris 2 side bar |

## Privacy and security

- No telemetry; the extension itself makes no network requests.
- In Restricted Mode (an untrusted workspace) it runs no program: the **Editing** features and
  Next / Previous Hole work; interactive editing and the Holes view need a trusted workspace.
- It starts the compiler in the project's folder, and asks first when that folder is outside
  your trusted workspace folders (**Allow**, **Always Allow for This Folder**, **Don't Allow**).
- It talks to the compiler over standard input and output: no network port. The opt-in `socket`
  transport opens a local port another program could use first — not for shared computers.
- **Evaluate Selection** evaluates expressions only, in a second compiler process with the same
  permission and transport: `IO` is shown, not run, and REPL commands (`:exec`, …) are refused.
- **Evaluating can run compile-time code** (elaborator scripts, a `%macro` the expression applies,
  `%runElab`), which can write files ([details](docs/guide.md#compile-time-code)).
- **Refine Hole…** checks the expression you type the same way, so it can run such code too.
- Interactive editing sends a name from the file only if it is an Idris name, and applies an
  answer only to the file it asked about, only if that file has not changed since.

What runs where, and how compiler text is shown: [guide](docs/guide.md#privacy-and-security).

## Known limitations

- Answers refer to the **saved** file: hover, completion and the Holes view come from its last
  check; evaluation checks it again first, and most editing commands save it first.
  Checking while you type comes later.
- After a check with errors, Case Split, Add Clause and Generate Definition are refused until the
  file loads cleanly, and an answer in place of a hole is refused where it would shift a block that
  the lines below belong to, but for a few shapes (two of them silent): see the [guide](docs/guide.md#known-limitations).
- The compiler answers about one file per project at a time: another editor of the same project
  answers once you click into it (with `manual` checking, once you run Check File there).
- Go to Definition finds global names only. After a qualifier (`Data.Vect.fil`), completion
  offers matching names from every namespace.
- Literate files need LF line ends: with CRLF a `.lidr` does not compile, and a Markdown one
  compiles with its lines shifted. Click `CRLF` in the status bar to switch.
- Warnings appear only when the compiler rebuilds a file; an up-to-date file reads `up to date`.
- pack and idris2-lsp support has been tested against simulated installations only.

The full list is in the [guide](docs/guide.md#known-limitations).

## Roadmap

A goal panel, check-as-you-type, idris2-lsp, REPL and build integration, literate Markdown and
LaTeX, Unicode input: see [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/etairi/vscode-idris2); see
[CONTRIBUTING.md](CONTRIBUTING.md) for building and testing.

## License

[MIT](LICENSE). The Idris logo is © Edwin Brady, used under the BSD 3-Clause license of
[Idris 2](https://github.com/idris-lang/Idris2) ([notices](THIRD_PARTY_NOTICES.md)). This
extension is not affiliated with or endorsed by the Idris project.
