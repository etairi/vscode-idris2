# Install what is missing

The extension never installs anything by itself. Each command below either opens a terminal with the install command typed in (read it, then press Enter to run it) or opens installation instructions in your browser. The terminal starts in your home directory rather than in the workspace folder, because pack reads the `pack.toml` of the directory it runs in and of every directory above it.

- **Idris 2: Install Idris 2…** On macOS it types `brew install idris2` (this needs [Homebrew](https://brew.sh/)). On other systems it opens Idris 2's installation instructions, which cover package managers, pack and building from source.
- **Idris 2: Install pack…** It types pack's documented install command:

  ```sh
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/stefan-hoeck/idris2-pack/main/install.bash)"
  ```

  pack needs Chez Scheme first and builds its own `idris2`; afterwards, add `~/.local/bin` to your `PATH` (see pack's installation instructions). On Windows the command opens those instructions instead.
- **Idris 2: Install or Update idris2-lsp with pack** It types `pack install-app idris2-lsp`, with the full path of the pack that was found. It is offered once pack has been found. pack installs the idris2-lsp of its current package collection and leaves one that is already installed as it is; for a newer server, switch to a newer collection first (`pack switch latest`).

idris2-lsp is built against one particular compiler; pack installs the server and the compiler from the same package collection, so the two match.

After installing, run **Idris 2: Rescan Toolchain**.
