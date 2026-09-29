# Changelog

All notable changes to the "Idris 2" extension (`vscode-idris2`) are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/); the extension's version is
independent of Idris 2 releases (`docs/ROADMAP.md` §7.4).

## [Unreleased]

Not published yet. A build of this repository (version 0.0.1) gives you the following. It
supports macOS and Linux; on Windows, use VS Code with WSL, where the extension runs on Linux.

### Added

- **The compiler's errors and warnings in the editor** (milestone M2). Idris 2 files — in a
  package or on their own, literate files included — are checked with the compiler's IDE mode
  when they are first shown and whenever they are saved (`idris2.checking.trigger`: `onSave`,
  `afterDelay`, `manual`). Errors and warnings appear in the editor and the Problems panel, also
  those of imported modules and of a malformed `.ipkg`, and the language status shows the result
  (`checking…`, `✓`, `2 errors`, `stale`, `stopped`, …). New commands: **Check File**, **Restart
  Backend**, **Stop Backend**, **Show Protocol Trace** and **Manage Allowed Folders…**.
- **One compiler per project, under your control** (M2). The compiler talks to the extension over
  its standard input and output — no network port, unless you choose the `socket` transport in
  your user settings —, keeps its build files in `build/.vscode-idris2`, apart from your own
  builds, when the package allows it, and stops when it has been idle for a while. Before it starts
  in a folder outside the trusted workspace folders, the extension asks you. Optional limits on
  how many compilers run and how many files are checked at once (`idris2.ideMode.maxSessions`,
  `idris2.ideMode.maxBackgroundChecks`; no limit by default).
- **Toolchain and project detection** (M1). The extension finds `idris2`, `idris2-lsp` and `pack`,
  shows the compiler version in the language status and says whether the language server fits the
  compiler; **Show Setup Information**, **Rescan Toolchain** and **Report Issue…**; install
  commands for Idris 2, pack and idris2-lsp that type the command into a terminal without running
  it; the **Get Started with Idris 2** walkthrough. Every file is matched to its `.ipkg` package
  the way the compiler finds it, also above the folder you opened.
- **Language support** (M0). Highlighting for Idris 2, literate Idris (`.lidr`) and `.ipkg` files,
  following the compiler's own lexer; comment toggling, bracket matching, indentation on Enter,
  indentation-based folding and **Expand Selection**; snippets; the Help commands **Show
  Output**, **Open Settings** and **Open Idris 2 Documentation**; editor defaults for Idris files.
- **Workspace Trust.** In Restricted Mode the extension runs no program; highlighting and editing
  support keep working.
- Extension icon: the official Idris logo (BSD-3, see `THIRD_PARTY_NOTICES.md`).

What each milestone built in detail, how it differs from the plan and how it was tested is
recorded in `docs/as-built/`.
