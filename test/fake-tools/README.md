# `test/fake-tools`

The fake toolchain of the integration suites (`docs/ARCHITECTURE.md` §12): stand-ins for
`idris2`, `idris2-lsp` and `pack` that need only Node, so that the suites run the same on every
CI runner whether or not a real Idris 2 is installed. The e2e suite (`test/e2e/`) uses the real
tools instead.

| File | What it is |
|---|---|
| `bin/idris2`, `bin/idris2-lsp`, `bin/pack` | launchers for macOS and Linux: `#!/bin/sh` scripts, mode 755, that `exec node <script> "$@"` (the `exec` makes the tool the launcher's process, so killing it on a timeout kills the tool) |
| `bin/idris2.cmd`, `bin/idris2-lsp.cmd`, `bin/pack.cmd` | the same for Windows: `@node "%~dp0<script>" %*`, checked out with CRLF (`.gitattributes`). Node does not start `.cmd` files without a shell, so callers go through `cmd.exe /d /s /c` |
| `../fake-idris2/fake-idris2.mjs` | the fake compiler (its own README covers the IDE protocol and the recorded probes) |
| `fake-idris2-lsp.mjs` | the fake language server; M1 needs only `--version` |
| `fake-pack.mjs` | the fake pack: answers only what pack's wrapper scripts ask it |
| `faults.mjs` | the fault modes shared by the three fakes |
| `paths.ts` | where the scripts and launchers are, for compiled tests |
| `packLayout.ts` | builds a simulated pack installation under a temporary home directory |

The launchers run the `node` found on `PATH`, so a process whose environment has no Node on
`PATH` cannot start them. `.vscode-test.mjs` names `bin/<tool>` (`bin/<tool>.cmd` on Windows) in
the user settings of the `integration` and `simple-ipkg` suites and prepends `bin/` to `PATH` in
the `toolchain-path` suite. The unit test is `test/unit/fakeTools.test.ts`.

## `fake-idris2-lsp.mjs`

Nothing about the server was observed: no `idris2-lsp` is installed on the development machine
(ROADMAP §9 Q2). The fake follows idris2-lsp `9a2f0ad`'s source [src], cited in the file:

| Command line | Output |
|---|---|
| `--version` | `Idris2 LSP: 0.1.0-9a2f0ad6a` and `Idris2 API: 0.8.0`, one line each, exit 0 |
| no arguments | the real binary starts the server (M5); the fake exits 2 |
| anything else | `Invalid Arguments` on stdout, exit 0, as the real `main` does |

`0.1.0-9a2f0ad6a` is what a build at commit `9a2f0ad` in a git checkout would print: the
Makefile's `VERSION_TAG` defaults to `git rev-parse --short=9 HEAD` at an untagged commit.
`FAKE_IDRIS2_LSP_VERSION` and `FAKE_IDRIS2_LSP_API_VERSION` replace the text after `Idris2 LSP: `
and `Idris2 API: `; the default API version equals the fake compiler's version, so the default
pair is textually compatible, and setting it differently simulates a mismatch.

## `fake-pack.mjs`

The extension never runs pack; pack runs inside pack's own wrapper scripts, which ask
`pack app-path <app>` for the binary and, for applications that use the package path, `pack
package-path`, `libs-path` and `data-path` (`appLink`, idris2-pack `6baee7d`
`src/Pack/Runner/Install.idr` 139–188) [src]. The fake answers those four from
`<state dir>/fake-pack.json`, which `packLayout.ts` writes, finding the state directory as pack
does ([src], cited in the file). Every other command line exits 2. With `FAKE_PACK_LOG` set,
each invocation first appends `{"args": […], "cwd": "…"}` as one line to that file, so a test can
assert that pack ran, or did not.

## Simulating faults

Each fake reads `<PREFIX>_MODE` and `<PREFIX>_DELAY_MS`, with PREFIX `FAKE_IDRIS2`,
`FAKE_IDRIS2_LSP` or `FAKE_PACK`. Integration tests set them through `idris2.toolchain.env`,
which the extension passes to every process it starts.

| Variable | Effect |
|---|---|
| `<PREFIX>_MODE=fail` | one line on stderr, nothing on stdout, exit 1 |
| `<PREFIX>_MODE=hang` | no output; the process exits 1 by itself only after `FAKE_TOOL_HANG_LIMIT_MS` (default 60,000 ms), so one that a test failed to kill does not outlive the run (on Windows the launcher is `cmd.exe`, and killing it is not known to end the `node` it started; not tried) |
| `<PREFIX>_MODE=garbage` | idris2: `--version` prints a line that does not start with `Idris 2, version `; idris2-lsp: `Invalid Arguments`; pack: no effect |
| `<PREFIX>_DELAY_MS=N` | waits N ms, then behaves normally (a slow tool within the time limit) |
| `FAKE_IDRIS2_VERSION=<text>` | `idris2 --version` prints `Idris 2, version <text>`: `0.8.0-1c630e67c` simulates a development build, `unknown` an unparsable version. The IDE-mode `version` reply follows it and is refused (exit 2) when the text is not `<major>.<minor>.<patch>[-<tag>]` |

Any other mode, or a delay that is not a non-negative integer, is a mistake in the test and
exits 2.

## Simulated pack layouts (`packLayout.ts`)

`buildPackLayout({ home, collection?, xdg?, tools?, collectionBinTools?, globalCollection?,
stateToml? })` writes a pack installation under `home` and returns its directories, the
environment a process needs to see it (`HOME`, plus `XDG_CONFIG_HOME`/`XDG_STATE_HOME` with
`xdg: true`), and the paths of what it wrote. pack is not installed on the development machine
(ROADMAP §9: only in M5), so the layout follows pack's source at `6baee7d` [src], and its
README where the README says more [doc]; the file cites each rule. What a toolchain search
meets in it:

- `~/.local/bin/pack` is a symbolic link into `<state>/install/pack/<commit>/`;
  `~/.local/bin/idris2` and `idris2-lsp` are wrapper scripts in pack's form. **Running a
  pack-installed `idris2` or `idris2-lsp` runs pack** (`app-path`, and the three path queries);
  the unit test shows this with `FAKE_PACK_LOG`.
- The binaries are under `<state>/install/<idris2 commit>/…`, keyed by the compiler commit, not
  by the collection.
- The current collection is in `<state>/pack.toml`, which pack writes on its first run and on
  `pack switch`; a `collection` in the user's `<config>/pack.toml` (`globalCollection`) is
  overridden by it (`foldl update`, later files win) [src].
- `$XDG_STATE_HOME/pack/install/<collection>/bin` is named by pack's README ("Application
  Binaries") [doc], but no code in `6baee7d` writes it; `collectionBinTools` creates it only so
  that a search that looks there can be tested.

pack's wrappers are `sh` scripts, so layouts are built on macOS and Linux only; the unit tests
of the layout are skipped on Windows. `PACK_USER_DIR`, `PACK_STATE_DIR` and `PACK_BIN_DIR`, which
override pack's directories [src], are not simulated.
