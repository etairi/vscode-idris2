# Changelog

All notable changes to the "Idris 2" extension (`vscode-idris2`) are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/); the extension's version is
independent of Idris 2 releases (`docs/ROADMAP.md` §7.4).

## [Unreleased]

Not published yet. A build of this repository (version 0.0.1) gives you the following. It
supports macOS and Linux; on Windows, use VS Code with WSL, where the extension runs on Linux.

### Added

- **Interactive editing** (milestone M4): **Case Split**, **Add Clause**, **Make Lemma**, **Make
  With**, **Make Case**, **Proof Search**, **Generate Definition**, **Intro** and **Refine Hole…**,
  from the Command Palette, the light bulb or the keyboard, and **Add Missing Cases**, from the
  Command Palette or as a quick fix, each one undo step; **Next Result** replaces a result of Proof
  Search or Generate Definition with the next one (so does **Next Definition** after Generate
  Definition; `↻ next (n)` in the status bar). An answer put in place of a hole is put in
  parentheses when it is more than one token, and Make Case writes a bracketed `case`; both are
  refused, with the reason, where the new text would shift a block that the lines below belong to
  (a few shapes are missed, two of them silent: the guide's *Known limitations*).
  Refine Hole… does not offer the alternatives of an ambiguous operator that the compiler prints
  between its arguments; it says so and suggests the qualified prefix form. A file with unsaved
  changes is saved first (`idris2.checking.saveBeforeAction`),
  and an answer is applied only if the file has not changed meanwhile. Like Evaluate Selection,
  Refine Hole… can run compile-time code (README, *Privacy and security*).
- **Holes** (M4): the **Holes** view in a new **Idris 2** side bar — each hole's type and local
  variables, a click away (`idris2.holes.showInSideBar`) —, **List Holes**, **Next Hole** and
  **Previous Hole**.
- **Keyboard shortcuts** (M4) for most of these commands in both schemes (`Ctrl+C Ctrl+C` or
  `Ctrl+Alt+I C` for Case Split, and so on), and **Show Keybindings**, which lists those of your
  scheme.
- **Answers from the compiler** (milestone M3). Hovers show the type of the name under the
  cursor — local pattern variables included — and the first paragraph of its documentation; **Go
  to Definition** jumps to global names, also across files; **Show Documentation…** and **Docs at
  Cursor** open a name's documentation, **Browse Namespace…** lists a namespace; semantic
  highlighting, the Outline, highlights of the name under the cursor, completion of names,
  keywords and `%` directives, and inlay hints with the types of pattern variables
  (`idris2.inlayHints.variableTypes`). New commands: **Type at Cursor**, **Docs at Cursor**, **Show
  Documentation…**, **Browse Namespace…**.
- **Evaluate Selection** (M3): the selected expression's value after the line and in a hover
  (`idris2.eval.inlineResults`), from a second compiler process of the project that starts at the
  first evaluation; expressions only — `IO` actions are shown, not run, and REPL commands such as
  `:exec` are refused —, though it can run compile-time code (elaborator scripts; README, *Privacy
  and security*). An evaluation is stopped after `idris2.eval.timeout` (10 s) and can be cancelled
  once it has run for a second. **Clear Evaluation Results** removes the results.
- **Keyboard shortcuts** (M3) for Type at Cursor, Docs at Cursor and Evaluate Selection:
  `Ctrl+C Ctrl+T` / `D` / `E` on macOS, `Ctrl+Alt+I T` / `D` / `E` on Linux, or none
  (`idris2.keybindings.scheme`).
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
