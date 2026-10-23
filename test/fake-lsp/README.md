# `test/fake-lsp`

The fake language server of the `lsp` integration suite (ROADMAP M5, `docs/ARCHITECTURE.md` §12): a
Node script that stands in for `idris2-lsp` and answers the Language Server Protocol over stdio by
replaying the sessions recorded from the real server (`npm run record:lsp-transcripts`,
`test/fixtures/lsp-transcripts/`). It needs only Node and runs on every CI runner. The LSP e2e suite
(`test/e2e/lsp*.test.ts`) runs the real server instead.

| File | What it is |
|---|---|
| `bin/idris2-lsp` | the launcher `.vscode-test.mjs` names as the `lsp` suite's `idris2.toolchain.lspPath`: a `#!/bin/sh` script, mode 755, that runs the `node` on `PATH`. With no arguments it `exec`s `server.mjs`; with any argument (M1's `--version` probe) it `exec`s `test/fake-tools/fake-idris2-lsp.mjs`, so the probe and its fault variables behave as in every other suite. No `.cmd`: native Windows is out of scope (CLAUDE.md) |
| `server.mjs` | the process: framing, the logs, the fault |
| `replay.mjs` | the replay model: which recording answers a message |

The unit test is `test/unit/fakeLsp.test.ts`.

| Variable | Effect |
|---|---|
| `FAKE_IDRIS2_LSP_TRANSCRIPTS=<dir>` | the recordings to replay; `.vscode-test.mjs` sets it to `test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a` for the `lsp` suite. Unset, an empty directory, or a recording that cannot be replayed (not format 1, a `spawn-error`/`stdin-error` event, a `base64` text): `fake-idris2-lsp: <reason>` on stderr, exit 2, before anything is read |
| `FAKE_IDRIS2_LSP_LOG=<file>` | the server appends `{"pid", "args", "cwd"}` as one JSON line when it starts (not the `--version` runs, which `fake-idris2-lsp.mjs` answers), so a test sees that it started, how often, and in which directory |
| `FAKE_IDRIS2_LSP_MESSAGE_LOG=<file>` | every message the server reads is appended as one JSON line `{"pid", "message", "replay"}` before it is answered: the message as parsed, and what answered it — `<scenario>:<line>` (the line of the matched client message in `<scenario>.jsonl`), `initialize`, `shutdown`, `unrecorded`, `fault`, or `null` for a message that is never matched (`initialized`, `didChange`, `didClose`, `didChangeConfiguration`, `$/cancelRequest`, a response). A test reads from it what reached the server — and that a document did not |
| `FAKE_IDRIS2_LSP_FAULT=missing-ipkg` | "Faults" below |
| `FAKE_IDRIS2_LSP_MODE`, `FAKE_IDRIS2_LSP_DELAY_MS` | `test/fake-tools/faults.mjs`, applied by the server at its start as by the `--version` fake |

Tests set these through `idris2.toolchain.env`, which the extension passes to every process it starts.
A log that cannot be written (its directory deleted while the server runs) is named on stderr and
otherwise ignored, so that a test's cleanup does not end the server.

## Replay

`${ROOT}` in every recording stands for the server's **working directory** (its real path): the
recorder started the server in its copy of the scenario's workspace (`meta.workspace`), as the
extension starts it in a workspace folder. So the `lsp` suite, whose server runs in
`test/fixtures/workspaces/lsp-ipkg`, can replay the scenarios recorded there; `holes-ipkg`,
`literate-md` and `loose-file` were recorded in other workspaces and answer only a server started in
a copy of theirs (the unit test does that). `${HOME}` stands for the home directory.

The server's state that the replay follows, each rule from idris2-lsp `9a2f0ad`'s source [src, cited in
`replay.mjs`]: the dirty documents (a `didChange` makes a document dirty, `didSave` and `didClose`
clean), the file loaded last (`didOpen`, `didSave`, and a request about a document that is not dirty
load it; `didClose` forgets it), and the options (`initializationOptions`, then every
`didChangeConfiguration`'s `settings`, top-level keys of the right JSON type only, as
`processSettings` reads them; `logSeverity` and `logFile` are not compared).

- **Matching.** A client message is compared with the recorded client messages by a key: the method
  and what the server reads of the parameters — the document's file (as its real path) and the position
  for hover, definition, highlights, signature help and completion; the file for symbols, semantic
  tokens, code lenses and document links; the file, the range and `context.only` for a code action (the
  attached diagnostics and `triggerKind` are ignored, as the server ignores them); the command and its
  arguments for `workspace/executeCommand` (files as real paths, a code-action argument as for a code
  action; `metavars`' arguments ignored, as the server ignores them); the file for `didOpen` and
  `didSave`. The text of a `didOpen`, `didChange` or `didSave` is not compared: the server reads the file
  from disk. A request matches only a recording made under the same **conditions**: its document
  equally dirty or clean, the same options, and, for a command about no document (`metavars`, `repl`,
  `browseNamespace`), the same file loaded last.
- **Which recording.** Only a recorded message whose fixture files were on disk then as they are now
  is eligible: `meta.fixtures`, changed by the recording's `fs` events before the message (a save
  writes a file, `ipkg-deleted` deletes one), compared by SHA-256 below the working directory, absent
  files included. So an edited or unrelated file is never answered with a stale reply. Among the
  eligible matches, one recorded when the server loaded the document first exactly when it does now (a
  load publishes the file's diagnostics again) is preferred, then the first by scenario name and line.
  The unit test checks that the choice never matters: two recorded messages with the same key,
  conditions, files and load have the same recorded answer.
- **Replies.** The recorded output after the matched message, up to the next client message, is
  written in its recorded order: messages, re-framed with this run's paths and their `Content-Length`
  recomputed, as the server writes them (JSON with every non-ASCII character as a `\uXXXX` escape in
  capitals); unframed stdout bytes (the `%logging` lines of `logging`); and stderr lines (the server's
  log). The response carries the live request's id; the server's own requests
  (`workspace/semanticTokens/refresh` after a save) are numbered from 0 in each session, as the
  server numbers them; the client's answers to them are read and ignored. `initialize` is answered with
  the recorded capabilities (identical in every recording, the unit test checks), `shutdown` with
  `null`, and `exit` ends the process with 0 after `shutdown`, else with 1, as the server does.
- **No recording.** A request no eligible recording matches is logged as `unrecorded`, named on stderr,
  and answered: `null` for a request about a document (hover, definition, highlights, signature help,
  completion, symbols, semantic tokens, code lenses, document links, code actions) — an answer the
  real server gives in several states (a dirty document, no name at the position; code lenses and
  document links always), so that VS Code's own requests (symbols for the outline, highlights and code
  actions at the cursor) do not fail; for one of the five commands the server handles,
  `{"code": -32603, "message": "fake-idris2-lsp: no recorded reply for <key>"}`, so that a command a
  test sends without a recording fails with a message naming it; for any other method the server's
  own `{"code": -32601, "message": "Method not implemented yet"}`. A `didOpen` or `didSave` without a
  recording publishes nothing. This is not server behaviour: record the scenario
  (`npm run record:lsp-transcripts`, one server at a time) instead of writing replies by hand.

`test/unit/fakeLsp.test.ts` replays every recording in a fresh copy of its workspace — request ids
shifted, the recorder's file changes made at the same points — and requires the fake's stdout to equal
the recorded stdout byte for byte (re-framed for the copy's paths) and the recorded exit code, with no
message left unrecorded; it also checks the matching rules above, the logs, the fault and the launcher.

## Faults

`FAKE_IDRIS2_LSP_FAULT=missing-ipkg` simulates the condition F35 describes from the source: every request
about a document (and `exprSearchWithHints`/`refineHole`, whose code action names one) is answered with
the response error `withURI` gives when `loadURI` finds no `.ipkg` —
`{"code": 3, "message": "Cannot load ipkg file for <uri>: \"Cannot find the ipkg file\"", "data": null}`
(`Server/ProcessMessage.idr` 221–225, 291–297 [src]) — and `didOpen`/`didSave` publish nothing. The
server also logs the message; the fake does not, so that a test sees the response alone. **Live, the
server never answers this**: for a file without an `.ipkg` it answers code 4, `Error: Source file
"<path>" is not in the source directory ""`, or null (recording `loose-file`; ROADMAP §0 F35).

## Not mirrored

- Where the server's stderr lines fall among its stdout messages (not reproducible either between
  two recordings); the fake writes each group's lines in their recorded place.
- Server state beyond the rules above: the order of loads in other histories, the semantic-token and
  hover caches, hole names a refinement made in another session (`?vlen_rhs_0` after a recorded
  `refineHole`), the text of a document changed but not saved (completion answers as recorded).
- The `version` of a `publishDiagnostics` after `didOpen` is the recorded one (1, as VS Code's first
  version of a document), not the live `didOpen`'s.
- Input the server cannot read: the server answers a parse error before it exits with 1; the fake
  writes a line on stderr and exits with 1.
- Timing: answers are written at once.
