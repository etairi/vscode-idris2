# idris2-lsp transcripts

Sessions of the real language server idris2-lsp, recorded by `scripts/record-lsp-transcripts.mjs`
(ROADMAP M5, ARCHITECTURE §12). They are the ground truth for the fake language server's replay
(`test/fake-lsp`) and for the LSP backend's decoding, and they pin the server facts of ROADMAP §0
that each scenario names. `0.1.0-9a2f0ad6a/` holds the recordings of the server pack installed on
the development machine on 2026-10-01 (macOS arm64), made the same day:

- `idris2-lsp --version`: `Idris2 LSP: 0.1.0-9a2f0ad6a`, `Idris2 API: 0.8.0-1c630e67c`
  (idris2-lsp `9a2f0ad`, lsp-lib `512504c`, built by pack `6baee7d` against Idris 2 `1c630e6`:
  the commits pack's package collection `nightly-261002` pins);
- run through pack's wrapper `~/.local/share/pack/bin/idris2-lsp` (that machine's
  `PACK_BIN_DIR`, outside `PATH`).

## Recording

```sh
node scripts/record-lsp-transcripts.mjs --list        # the scenarios and what each one shows
PACK_BIN_DIR=$HOME/.local/share/pack/bin IDRIS2_LSP=$HOME/.local/share/pack/bin/idris2-lsp \
  node scripts/record-lsp-transcripts.mjs             # all of them → test/fixtures/lsp-transcripts/<version>/
node scripts/record-lsp-transcripts.mjs dirty repl    # only these
node scripts/record-lsp-transcripts.mjs --out /tmp/x  # elsewhere
```

`IDRIS2_LSP=<absolute path>` selects the server (default: the first `idris2-lsp` on `PATH`); the
version directory is the `Idris2 LSP:` version it prints. pack's wrapper runs pack at every start,
and pack reads `PACK_BIN_DIR`: set it when pack's bin directory is not `~/.local/bin`. The script
runs **one server at a time** (CLAUDE.md) and kills each process group after 300 s, or when a
response has not arrived within 120 s. It runs only on macOS and Linux (process groups). It needs
no VS Code.

For every scenario it copies the scenario's fixture workspace (without `build/` directories) to a
fresh temporary directory, starts the server there with no arguments (the extension starts it in a
workspace folder), sends `initialize` and `initialized`, the scenario's steps, `shutdown` and
`exit`, and waits for the process to end. Each request is sent after the response to the previous
one; a `didOpen` or `didSave` waits for the file's `publishDiagnostics` (and a `didSave` also for
the server's `workspace/semanticTokens/refresh`), or for a log line where the server publishes
nothing; every step is followed by 300 ms without output. The server's requests are answered at
once with `null`. Nothing is written to the repository except the transcripts; the server's
`build/` output stays in the temporary copy and is listed in the transcript.

**The `initialize` request is not the one vscode-languageclient sends.** Its client capabilities
are a small subset; the three the server reads — `textDocument.hover.contentFormat` (Markdown first),
`textDocument.publishDiagnostics` and `workspace.semanticTokens.refreshSupport` (true) — are set
as vscode-languageclient 10.1.2 sets them. `processId` is `null`, `clientInfo` names the recorder.
The `initializationOptions` are the extension's defaults (`backend/lsp/types.ts`
`LspServerOptions`) except `logSeverity`: `debug` (the default) in `initialize` and
`features-cross`, `info` elsewhere, because at `debug` the server writes every message it
receives and sends into its log once more; `options` and `commands-clean` change options.

**Reproducibility.** Two full recordings on 2026-10-01 gave, for every scenario, the same
sequence of non-log events and the same sequence of log lines; only where the log lines (stderr)
fall between the messages (stdout) differed, since the two pipes are read as the operating system
delivers them. Within one stream the order is exact.

A changed fixture must be recorded again: each transcript carries the SHA-256 of the fixture
files it read (`fixtures` below).

## Format

One JSON object per line, UTF-8. The first line is the `meta` object; every other line is one
event, in the order the recorder observed it. There are no timestamps.

### `meta`

| Field | Meaning |
|---|---|
| `format` | `1` |
| `scenario`, `description`, `facts` | the scenario's name (= file name), what it shows, and the ROADMAP §0 facts it concerns |
| `server` | `version` (`0.1.0-9a2f0ad6a`), `api` (`0.8.0-1c630e67c`), `versionText` (the two `--version` lines), `executable` (a path under the home directory is written `~/…`) |
| `platform`, `recorded` | `process.platform process.arch`, and the local date |
| `workspace` | the fixture directory that `${ROOT}` is a copy of, relative to the repository root |
| `extra` | only when present: files of `test/fixtures` copied into `${ROOT}` before the start (`{ <path in the copy>: <path in the repository> }`) |
| `processCwd` | `${ROOT}`: the server's working directory |
| `placeholders` | each placeholder that occurs, with the UTF-8 byte length of the path it replaced (see *Content-Length*) |
| `fixtures` | `{ <path relative to ${ROOT}>: <sha256 hex> }` of the files the scenario opens or the server reads |

### Events

| `kind` | Fields | Meaning |
|---|---|---|
| `send` | `length`, `text` | a message written to the server: `length` is its `Content-Length`, `text` its JSON body (the recorder writes no other header) |
| `recv` | `length`, `text`, and `header` when not exactly `Content-Length: <length>\r\n\r\n` | a message read from the server's stdout: its header block and its body, taken by the header's byte count as a client takes it (no recording has a `header` field: the server writes `Content-Length` only) |
| `unframed` | `text` | bytes of the server's stdout that are not a message: output of the compiler itself (`logging`: the `LOG` lines of a `%logging` pragma) |
| `stderr` | `text` | a line of the server's stderr: its log, `LOG <SEVERITY>:<topic>: <text>` with the severity in capitals (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |
| `fs` | `action` (`write`, `delete`), `file`, `sha256` for `write` | the recorder changed a file of the copy: a save writes the document's text before `didSave`; `ipkg-deleted` deletes the `.ipkg` |
| `spawn-error`, `stdin-error` | `text` | an error of the process or of its stdin (none occurs in the recordings) |
| `exit` | `code`, `signal` | the process ended |
| `files` | `written` | files below `${ROOT}` that the server created or changed, relative to it and sorted (the recorder's own saves left out) |

A `text` that is not valid UTF-8 would be stored as `base64` instead; none occurs. Every body the
server wrote is ASCII: it escapes other characters as `\uXXXX`, characters outside the BMP as a
surrogate pair (`plain`, the signature help of a doc comment with `𝕟`). The client's bodies are
UTF-8 as `JSON.stringify` writes them (`didOpen` of `Plain.idr` and `Edits.idr`).

### Placeholders

| Placeholder | Stands for |
|---|---|
| `${ROOT}` | the real path (`realpath`) of the workspace copy, padded to 128 characters; file URIs are `file://${ROOT}/…` (the path needs no percent-encoding) |
| `${HOME}` | the home directory: the server's definition of a name from an installed package answers the absolute path of its source in pack's installation (`features-shapes`, `pi`) |

Only these exact spellings are replaced. The recorder refuses to write a transcript that still
contains the temporary directory in any other spelling, the repository's path or the home
directory, and one where a text contains `${`.

### Content-Length

`length` is the `Content-Length` as it was on the wire: the UTF-8 bytes of the body with the real
paths in it. To check it, replace each placeholder by any ASCII string of the byte length that
`meta.placeholders` gives and count the bytes; the recorder checks every message this way before it
writes the file. A replay that substitutes its own paths must compute the length of the
substituted body. Request ids are the client's `1, 2, …` per session; the server's one request
per session (`workspace/semanticTokens/refresh`, in `diagnostics`, `dirty` and `ipkg-deleted`)
has id `0`.

## Scenarios

All but `holes-ipkg`, `literate-md` and `loose-file` run in `test/fixtures/workspaces/lsp-ipkg`: a copy of
`simple-ipkg` (`simple.ipkg`, `src/Foo/{A,B,Shapes}.idr`, byte for byte) with the M4 editing
fixtures `Clean.idr`, `Ambig.idr`, `Part.idr`, `Plain.idr`, `Edits.idr` and `Lit2.lidr` of
`broken/` (byte for byte) in `src/`. `node scripts/record-lsp-transcripts.mjs --list` prints each
scenario's description.

| Scenario | Shows |
|---|---|
| `initialize` | capabilities, `serverInfo`, the options' log lines (log at `debug`) |
| `options` | `initializationOptions` applied (`showImplicits`); `didChangeConfiguration` with the flat object, a nested one (ignored), wrong types (logged) |
| `diagnostics` | `publishDiagnostics` at open and save; the quick fixes (F28) with and without `only`; Add Clause, Generate Definition, hover and tokens in a file with errors; a request after `didClose` loads the file again |
| `dirty` | after an unsaved change: `null` for hover, symbols, highlights, definition, signature help and code actions, `RequestCancelled` (`-32800`, `Document Dirty`) for semantic tokens; answers again after the save |
| `features-shapes` | document symbols, semantic tokens, hover, document highlight, definition (in the file; in the prelude, under `${HOME}`), signature help |
| `features-cross` | hover and definition into a file not opened; `browseNamespace`; completion after incremental changes |
| `actions-clean` | `textDocument/codeAction` with each `context.only` key of ARCHITECTURE §3.3 on `Clean.idr` (the F30 fixture), at the columns where each answers; Generate next definition repeated; without `only`, generic kinds, `quickfix` |
| `commands-clean` | `metavars`, `exprSearchWithHints`, `refineHole` (also failing), `maxCodeActionResults` changed, the advertised `refineHoleWithHints` and an unknown command (`-32601`) |
| `ambig` | `refineHole` with an ambiguous name (no action, F34) and qualified ones; Intro and Expression search; `metavars` lists the holes the refinements made |
| `plain` | no action on a clause without a hole; hover, signature help (non-ASCII doc comment), symbols; `metavars` empty |
| `repl` | E10: `repl` evaluates expressions and runs the colon commands `:t id` and `:version` (no `:exec` is sent); a non-string argument (`-32602`) |
| `edits-shapes` | E15's shapes over LSP (`Edits.idr`): Add Clause, Generate Definition, Case Split, Make Lemma/Case/With |
| `edits-searches` | Expression search, Intro, Generate Definition (and next), `refineHole`, `metavars`, non-ASCII and primed names (`Edits.idr`) |
| `holes-ipkg` | E16 over LSP, `test/fixtures/workspaces/holes-ipkg`: `metavars` after loading `Holes.Main` and then `Holes.Other`; the hole commands on `Holes.Main`'s `todo` (a hole of `Holes.Base` has the same name) |
| `lit2` | E1, bird tracks: positions and edits in a `.lidr` (unlit columns, the doubled line below `> `) |
| `literate-md` | E1, Markdown: `Lit/Mark.idr.md`, `Lit/Twice.md` and `Lit/Bird.lidr` of `test/fixtures/ipkg/literate` |
| `logging` | a `%logging` pragma (`broken/Logging.idr`, copied in): the compiler's `LOG` lines on the server's stdout, between messages |
| `loose-file` | F35, `test/fixtures/workspaces/loose-file` (no `.ipkg`): what a client sees for a file the server cannot load |
| `ipkg-deleted` | F35: the `.ipkg` deleted while the server runs |
