# Review 1: the whole progress, M1–M8

The user's `/code-review` of 2026-10-30 at `ced9c6f`, which followed `docs/review-brief.md`: 14 lanes and
5 angles, then verifiers per area. Nothing was fixed in the review. Each finding says how it was known:
[live] on the real compiler, server or VS Code, [unit] the real code with fakes, [src] by reading.

Fixes follow the brief: one at a time, each with a test that failed first. The *Fix* column is filled as
they land. H4 is tested with scripted sessions only, as a live run needs two compilers at once.

## High

| # | Where | Finding | Known by | Fix |
|---|---|---|---|---|
| H1 | `backend/ide/pool.ts` | Printing options reach the sessions that answer edits, so a display toggle changes the text edits write | [live] | Fixed: an edit runs with the options off, on both backends. Over idris2-lsp too, which the review did not cover [live]; a change of its options keeps its cached actions, so it also reloads the document |
| H2 | `features/repl/register.ts` | Run All and Run read their lines before the question and the save, and the version after, so answers can land on the wrong lines | [unit] | Fixed: lines and version are read together, after the question and the save; Run all runs only what was agreed to |
| H3 | `backend/lsp/middleware.ts` | A dirty document opened by the sync gets only `didOpen`, so the server answers for the disk text at the editor's positions | [live] | Fixed: a document dirty at `didOpen` gets a `didChange` right after it [live] |
| H4 | `backend/ide/backend.ts` | `editNext` goes to the shadow session whenever it has a current search, even when the cycle follows a newer search in the check session | [unit] | Fixed: `-Next` goes to the session of the newest search of its kind. Tested with scripted sessions only: a live run needs two compilers |
| H5 | `backend/lsp/backend.ts` | `holes` sends `documentSymbol`, which loads the file, on every publish: two open documents reload each other for ever | [live] | Fixed: a refresh makes the server load a document at most once per version; 0 refreshes in 5 s with two files open [live] |
| H6 | `features/repl/docEval.ts` | A re-run takes every following `--   ` line for the old answer, so it deletes comments below an answer | [unit] | Fixed: further lines of an answer start `-- > `, so a re-run knows them |
| H7 | `features/repl/terminals.ts` | No package walk: when the root's `.ipkg` is gone, `--find-ipkg` moves to a parent package the gate never judged | [live] compiler, [unit] extension | Fixed: the compiler's walk must find the root's own `.ipkg`, which also refuses a folder where it would take another one |
| H8 | `features/repl/terminals.ts` | VS Code expands `${…}` in a terminal's executable, arguments and directory after they were vetted | [live] | Fixed: nothing with `${` is started |

## Medium, reported in detail

| # | Where | Finding | Known by | Fix |
|---|---|---|---|---|
| M1 | `backend/ide/backend.ts` | `typeAt` and `docsFor` go to a shadow session whose check failed, so any error removes every local's hover | [live], [unit] | Fixed: a session whose check failed answers no hover or docs; the check session does |
| M2 | `backend/ide/shadow.ts` | `shadow.ipkg` resolves `depends` from the shadow directory, so a project's local `depends/` is not found | [live] | Fixed: a shadow directory links the root's `depends` [live]. Not `IDRIS2_PACKAGE_PATH`, which pack's wrapper sets itself |
| M3 | `backend/lsp/client.ts` | Stop or Restart on a stuck server leaves a request pending, which blocks editing commands on that document | [unit] | Fixed: a stop ends the requests in flight |
| M4 | `backend/lsp/middleware.ts` | A clean document reloaded from disk stays dirty on the server | [live] | Fixed: a change that leaves a document clean and equal to its file is followed by `didSave` |
| M5 | `features/goalPanel/host.ts` | `choose` records a question with no panel to show it | [unit] | Fixed: no visible panel, the QuickPick asks; hiding the panel ends a question it shows |
| M6 | `features/editing/targets.ts` | `isMissingCasesDiagnostic` compares the source with `idris2`, not `idris2 (unsaved)` | [unit] | Fixed: the check accepts `idris2 (unsaved)` |
| M7 | `features/holes/model.ts` | An unsaved check's holes stay after an undo back to the saved text | [unit] | Fixed: the end of an unsaved check lists the holes again |

## Medium, cut by the report's cap of 15

| # | Where | Finding | Fix |
|---|---|---|---|
| M8 | `features/intelligence/queries.ts:157` | After a printing toggle, hover and inlay caches keep the old text | Fixed: a change of a printing option empties the answers kept |
| M9 | `features/intelligence/hover.ts:167` | Shadow docs survive an undo, and even Check File | Fixed: docs asked while a document has unsaved changes are kept apart from the saved file's |
| M10 | `extension.ts:339` | Stop Backend is silent on an idris2-lsp root | Fixed: it says so, as Restart Backend does |
| M11 | `backend/lsp/client.ts:1190` | Restart reuses a folder that has gone and says nothing | Fixed: the folder is judged first; else it starts for an open file it may serve, or says it did not restart |
| M12 | `backend/registry.ts:603` | No refusal of `:` or `?` paths on the LSP route, against the guide | Fixed: such a path is not admitted; the path judged is the one the server is sent |
| M13 | `features/repl/terminals.ts:96` | No second `extraArgsProblem` or settled snapshot | Fixed: `startProblem` again after the question |
| M14 | `features/repl/docEval.ts:32` | An answer's `--   >>> x` line is read back as a lens line | Fixed by H6's mark |
| M15 | `features/repl/docEval.ts:66` | A blank answer line is trimmed on save, so a re-run leaves a tail | Fixed by H6's mark: no line ends in white space |
| M16 | `features/repl/launch.ts:77` | No length limit: past about 1,000 bytes a line never runs and the REPL is stuck [live] | Fixed: a line over 1,000 bytes is not typed, and it says so |
| M17 | `backend/lsp/middleware.ts:465` | A closed document's problems stay [live] | Fixed: `didClose` clears them, as IDE mode does at a close |
| M18 | `features/holes/model.ts:324` | A saved load answered from the shadow session strips imported holes of their locations | Fixed: such a load asks for no holes |
| M19 | `features/shadow/unsavedChecks.ts:220` | Nothing re-checks when an imported module changes | Fixed: a load that rebuilt another file of the root checks the active document again, and the others when they become active |
| M20 | `features/shadow/unsavedChecks.ts:220` | `shown === version` counts as loaded, so commands save the file after another document's check or an idle stop | Fixed: a document whose check its session no longer holds is checked again when it becomes active, and a command checks the unsaved text first, so it saves only when that text cannot be checked [live] |

## Found while fixing

| # | Where | Finding | Known by | State |
|---|---|---|---|---|
| N1 | the compiler, VS Code's save | A load that overlaps a save leaves a build file newer than the source, from what it read before: the earlier text, or none at all if it read between VS Code's truncation and its write. The next load then builds nothing, on both backends | [live]: `docs/measurements/save-race.md`. The limitation M2 recorded, whose empty form was found here | Fixed for saves in the editor: once nothing runs, a build file newer than the file saved is set back, so that the load after a save always builds the text saved. Live tests of both backends fail without it. A change by another program, another window or the REPL has no save to act on, and stays in the guide, *Changes during a build* |

| N2 | `backend/ide/session.ts` | A printing option changed while a load of the file waits: the new load merged into that one, ahead of the option, and an `urgent` load could pass it, so the holes were printed the old way and nothing printed them again. Two options ticked quickly in the goal panel could leave one with no effect | [live]: the goal panel's e2e test at low CPU priority, 1 run of 2. Reading the queue explained it, [unit] on the real session and pool | Fixed: a printing option is a barrier, which no load merges or passes across |

The low findings are in the review's report and were not triaged here. Its candidates and probes were kept
in `/tmp/vi2-review`, which does not survive a reboot.
