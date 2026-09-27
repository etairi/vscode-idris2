# Find the Idris 2 toolchain

The extension looks for three programs:

- **idris2**, the compiler;
- **idris2-lsp**, the language server (optional);
- **pack**, the Idris 2 package manager (optional), which installs idris2-lsp.

For each one it takes the path in its setting (`idris2.toolchain.idris2Path`, `lspPath`, `packPath`) if you set one, and then looks nowhere else. Otherwise it searches `PATH`, then pack's directories (its bin directory, `~/.local/bin` unless `PACK_BIN_DIR` names another, then the `bin` directory of pack's current collection if there is one), then on macOS and Linux `/opt/homebrew/bin` and `/usr/local/bin`, and `~/.idris2/bin`. With `idris2.toolchain.preferPack`, pack's directories come before `PATH`.

When an Idris file is open, the language status next to the language mode shows the result, for example `Idris 2 0.8.0 · syntax only`. This version of the extension does not check code with the compiler yet, so it always says `syntax only` after the version.

- **Idris 2: Show Setup Information** lists each program, where it was found, the commands the extension ran to identify it and what they printed.
- **Idris 2: Rescan Toolchain** searches again, for example after you install something. Changing an `idris2.toolchain.*` setting rescans too.

In Restricted Mode (a workspace you have not trusted) the extension runs no program at all, so it cannot tell versions; trust the workspace to detect the toolchain.
