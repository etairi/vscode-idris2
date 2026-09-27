<p align="center">
  <img src="media/idris-logo-256.png" alt="Idris logo" width="112">
</p>

# Idris 2 for Visual Studio Code

Language support for [Idris 2](https://www.idris-lang.org/), a purely functional programming
language with first-class dependent types.

> **Preview.** The extension is in early development and not yet on the Marketplace. It
> currently provides highlighting, editing support and toolchain detection; checking your code
> with the compiler (errors, types, holes, case splitting, proof search) is being built next —
> see the [roadmap](docs/ROADMAP.md).

## Features

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
  program; highlighting and editing support keep working.

## Requirements

- Visual Studio Code 1.138 or newer.
- [Idris 2](https://idris2.readthedocs.io/en/latest/) for the toolchain features (tested with
  Idris 2 0.8.0). Highlighting, editing support and snippets work without it.
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

1. Open a folder that contains Idris 2 code, or a single `.idr` file.
2. Hover over the `{}` next to the **Idris 2** language mode in the status bar: the language
   status shows the compiler version (for example `Idris 2 0.8.0 · syntax only`), or a
   **Setup…** link if `idris2` was not found.
3. Run **Idris 2: Show Setup Information** from the Command Palette to see the detected
   toolchain and the package of the current file.

The **Get Started with Idris 2** walkthrough on VS Code's Welcome page covers the same steps.

## Commands

All commands are in the Command Palette under **Idris 2**, and in the **Idris 2** menu of the
editor title bar for Idris files.

| Command | Description |
|---|---|
| Show Commands… | Lists the commands below (also opened by clicking the language status) |
| Show Setup Information | Report of the tools found, their versions and the current file's package |
| Rescan Toolchain | Look for `idris2`, `idris2-lsp` and `pack` again |
| Install Idris 2… | Type the install command into a terminal (macOS), or open the installation guide |
| Install pack… | Type pack's install command into a terminal, or open pack's instructions |
| Install or Update idris2-lsp with pack | Type `pack install-app idris2-lsp` into a terminal |
| Report Issue… | Open VS Code's issue reporter with the setup information filled in |
| Show Output | Show the extension's log |
| Open Settings | Open the extension's settings |
| Open Idris 2 Documentation | Open the Idris 2 documentation in the browser |

## Settings

| Setting | Default | Description |
|---|---|---|
| `idris2.toolchain.idris2Path` | `""` | Path to `idris2`. Empty: search `PATH`, pack's directories and the usual install locations |
| `idris2.toolchain.lspPath` | `""` | Path to `idris2-lsp`. Empty: search as above |
| `idris2.toolchain.packPath` | `""` | Path to `pack`. Empty: search as above |
| `idris2.toolchain.preferPack` | `false` | Search pack's directories before `PATH` |
| `idris2.toolchain.env` | `{}` | Extra environment variables for the tools the extension runs |

The extension also sets a few editor defaults for Idris files (two-space indentation with
spaces, semantic highlighting on, and word boundaries that keep `?hole` and `x'` whole). You
can override them in your settings under `[idris2]` and `[lidr]`.

## Privacy and security

- No telemetry; the extension itself makes no network requests.
- In a trusted workspace it runs only `idris2`, `idris2-lsp` and `pack` queries (`--version` and
  similar), one at a time, with a time limit, and never inside your project folders.
  pack's `idris2` and `idris2-lsp` wrappers start pack, which may contact the network to
  update its package database.
- The install commands only type a command into a terminal that opens in your home directory.

## Known limitations

- No compiler integration yet: errors, types and interactive editing arrive with the next
  milestones.
- Windows support is experimental; it is tested with simulated tools only.
- pack and idris2-lsp support has been tested against simulated installations only.
- The grammar's known limits (rare layouts) are listed in
  [test/grammar/idris2-scopes.md](test/grammar/idris2-scopes.md).

## Roadmap

The planned features — compiler diagnostics, hover, go to definition, holes and interactive
editing, a goal panel, check-as-you-type, REPL and build integration, literate Markdown and
LaTeX, Unicode input — are described in [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing

Issues and pull requests are welcome at
[github.com/etairi/vscode-idris2](https://github.com/etairi/vscode-idris2). See
[CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and the project layout.

## License

[MIT](LICENSE). The Idris logo is copyright © Edwin Brady and is used under the BSD 3-Clause
license of the [Idris 2](https://github.com/idris-lang/Idris2) repository; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This extension is not affiliated with or
endorsed by the Idris project.
