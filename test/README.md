# `test/` layout

The testing layers of `docs/ARCHITECTURE.md` §12 and the `test/` tree of §2, annotated with the
milestone (`docs/ROADMAP.md` §5) that adds each part. Parts marked **M0**, **M1**, **M2**, **M3**
or **skeleton** exist.

| Layer | Runner | Needs | Exists | Added by |
|---|---|---|---|---|
| Unit | mocha on Node, `npm run test:unit` | nothing (Node spawns the fake tools and `/bin/sh`) | **M0**, **M1**, **M2**, **M3** (lists below) | M9 (CLI parser), M11, M13 |
| Grammar | `vscode-textmate` + `vscode-oniguruma` snapshots, `npm run test:grammar` | nothing | **M0** (`grammar/`, harness `grammar/harness.ts`) | injections: M12 |
| Integration | `@vscode/test-cli` (Electron), `npm test`, one suite per fixture workspace | VS Code download | **M0** (suite `integration` on `fixtures/workspaces/loose-file`), **M1** (the same suite with the fake tools; suites `simple-ipkg` and `toolchain-path`), **M2** (suites `diagnostics`, `loose-stdio`, `consent`; the fake compiler replays the transcripts), **M3** (suites `intelligence`, `intelligence-loose`; tests in `integration` and `diagnostics`) | fake LSP driven suites: M5; every UI milestone |
| E2E | same runner, `npm run test:e2e` (suite `e2e`, only with `IDRIS2_E2E=1` or that script) | real `idris2` (+ `idris2-lsp`) | **M1** (`e2e/`, on `fixtures/workspaces/simple-ipkg`), **M2** (protocol facts, sessions, fake parity, E21), **M3** (the M3 acceptance, E14, the IO rendering, the REPL parser's commands) | every milestone adds at least one |
| Contract | mocha suite parameterised over backends | as above | no | whichever of M4/M5 ships second |
| Manual | `docs/checklists/Mn.md` | — | **M0**, **M1**, **M2**, **M3** (`docs/checklists/M0.md` … `M3.md`) | each milestone |

```
test/
├─ unit/                      M0        mocha on Node, no vscode import allowed
├─ grammar/                   M0        TextMate tests: harness.ts, idris2/lidr/ipkg tests, snapshots/,
│                                       corpus.test.ts (npm run test:corpus), perf.test.ts,
│                                       idris2-scopes.md (scope inventory + limits, kept in sync by a test)
├─ corpus/                    M0        corpus.json (pinned repositories, fetched into .corpus/),
│                                       lexer-oracle/LexDump.idr (the 0.8.0 lexer as reference)
├─ integration/               M0–M3     @vscode/test-cli suites per fixture workspace: the top-level
│                                       *.test.ts (suite integration), simple-ipkg/, path/
│                                       (suite toolchain-path), diagnostics/, loose-stdio/,
│                                       consent/ (M2), intelligence/, intelligence-loose/ (M3);
│                                       support.ts is their shared helper
├─ e2e/                       M1–M3     real idris2 (IDRIS2_E2E=1); ideDriver.ts drives IDE-mode
│                                       sessions of it (M2)
├─ fake-idris2/               M0 (handshake + :version), M1 (recorded --ttc-version, --paths,
│                                       --list-packages, --dump-ipkg-json), M2 (transcript replay
│                                       over stdio + socket, injected faults, a command-line log;
│                                       client.ts, the byte-level client its tests share), M3
│                                       (replay by session role, told by the build directory; a
│                                       log of the requests each process read)
├─ fake-tools/                M1        launchers (sh + .cmd) of the fake idris2, idris2-lsp
│                                       (--version) and pack; fault modes; simulated pack layouts
├─ fake-lsp/                  M5        Node script (vscode-languageserver) replaying JSON-RPC
└─ fixtures/
   ├─ transcripts/<idris2-version>/*.jsonl   M2   recorded IDE-mode sessions (42 for 0.8.0), by
   │                                                scripts/record-transcripts.mjs; format and
   │                                                scenarios in transcripts/README.md
   ├─ cli/<idris2-version>/*.txt              M9   recorded --check/--build output
   ├─ ipkg/                                   M1   package files of the ipkg reader tests, each with
   │                                                its --dump-ipkg-json output recorded in
   │                                                unit/support/ipkgRecordings.ts; *.invalid.ipkg
   │                                                are skipped by check:fixtures
   ├─ grammar/*.idr, *.lidr, *.ipkg           M0   tokenisation fixtures (npm run check:fixtures:
   │                                                idris2 --check / --dump-ipkg-json); ipkg-sources/
   │                                                holds the prose-only modules the .ipkg fixtures
   │                                                list; NOTICE.md attributes the excerpts
   └─ workspaces/
      ├─ loose-file/          M0        no ipkg; checked with idris2 0.8.0 (`--check`, exit 0):
      │                                 Hello.idr (imports Data.Vect), Vlen.idr (the selection-range
      │                                 example), Lit.lidr (bird tracks with prose; since the second
      │                                 review of M3 also `> ` and `>   ` lines, each two lines of
      │                                 the compiler's text, and `xs++ys`, `n+1`); Notes.md (plain
      │                                 Markdown, the non-Idris document); Doc.idr.md (M1: literate
      │                                 Markdown with a double extension, selected in the Markdown mode);
      │                                 .vscode/settings.json (M2: asks for the socket transport, which
      │                                 only user settings may choose, ROADMAP §9 Q20; checking.delay 777)
      ├─ simple-ipkg/         M1        sourcedir = "src", depends = contrib, modules Foo.A and Foo.B
      │                                 (B imports A; A does not import contrib, since check:fixtures
      │                                 checks each file without package flags); M2 loads it in e2e;
      │                                 M3 adds Foo.Shapes (data, records, an interface and its
      │                                 implementation, an operator, docstrings: hover, tokens,
      │                                 symbols, docs, Browse Namespace…)
      ├─ builddir-ipkg/       M2        an .ipkg with builddir = "out" (F12, E21)
      ├─ multi-module/        M9        one error in src/Sub.idr (build-task acceptance; no earlier suite needs it)
      ├─ broken/              M2        Bad.idr (type error), Warn.idr (unreachable clause),
      │                                 Mixed.idr (both), Part.idr (coverage), UsesBad.idr (imports
      │                                 Bad), Err.lidr, ErrMd.idr.md (literate), bad-ipkg/ (F10),
      │                                 Clean.idr, Plain.idr, Ambig.idr (the editing facts F2, F15,
      │                                 F29, F30; M4 edits them), warnings/ (one file per warning
      │                                 kind, E5), Unicode.idr (M3: E14, characters outside the
      │                                 BMP, combining marks, comments); the broken ones are in
      │                                 check:fixtures' EXPECTED_PROBLEMS
      ├─ literate/            M4 (Lit2.lidr), M12 (Lit3.lidr and the .md, .tex, .org, .typ hosts); M3's
      │                                 acceptance names literate/Lit.lidr, and uses loose-file/Lit.lidr
      └─ golden-tests/        M10       Test.Golden layout
```

ARCHITECTURE §12 lists the fixture workspaces and recorded fixtures without milestones; the
milestones given for them above are inferred from the first suite that needs each one
(ROADMAP §5) and may move.

## Unit tests of the M0 code (`unit/`)

- `positions.test.ts` — `core/positions.ts`: every F2 and F11 example of ROADMAP §0 literally
  (the test names cite them), the `:case-split` column base, and CLI columns in `.lidr`.
- `literate.test.ts` — `project/literate.ts`: the selector table, `birdPrefixWidth`, and the
  `idris2.isIdrisDocument` tracker against a fake editor surface (including that disposing it
  resets a true key to false once).
- `nullBackend.test.ts`, `errors.test.ts` — `backend/null.ts`, `core/errors.ts`.
- `syntaxLexer.test.ts`, `selectionRangeModel.test.ts` — `features/syntax/`: lexer rules (each
  surprising one was confirmed with `idris2 --check`), selection chains (including empty,
  whitespace-only and CRLF texts, where the chain is never empty), and a check over every
  offset of several texts that each range contains the previous one.
- `disposable.test.ts` — `core/disposable.ts`.
- `languageConfiguration.test.ts` — `language-configuration/*.json`: runs
  `scripts/build-language-configuration.mjs --check`, compiles every regex as VS Code does,
  and replays tables of Enter and word cases whose expected values were observed in VS Code
  1.139.1.
- `snippets.test.ts` — `snippets/*.json`: shape, prefixes, tab stops. That the expansions are
  valid Idris is checked by `npm run check:fixtures` (it needs the compiler).
- `fakeIdris2.test.ts` — `fake-idris2/fake-idris2.mjs` against replies recorded from the real
  compiler (handshake, `version`, unknown commands, framing, and the end-of-input rules: when
  it exits silently with 0 and when it prints `Alas…` and exits 1), over stdio and TCP.

## Unit tests of the M2 code (`unit/`)

No compiler runs in them; recorded compiler output comes from `fixtures/transcripts/0.8.0`.

- `sexp.test.ts`, `wire.test.ts`, `protocol.test.ts` — `backend/ide/{sexp,wire,protocol}.ts`:
  round trips of `"`, `\`, newlines, `→` and `𝕟`; every character outside printable ASCII
  written as a decimal escape (with `\&` before a digit); the reader's escape and grammar rules
  (the port of the compiler's reader, which was compared with the real compiler on 45 requests,
  see `docs/as-built/M2.md`, *Protocol*); request prefixes in UTF-8 bytes, reply prefixes in code points,
  headers of 6–8 lower-case digits followed by `(` and a reply head; noise (also `00000a(hello)`),
  the end-of-input tail, a tail cut inside a frame (`truncated`), a stream whose line ends were
  written as `\r\n` (E13, also inside strings), a reply glued to output without a newline, also
  after output of one or two hex digits (`7000015(…`, at every cut), chunks split anywhere (every
  single cut and pair of cuts, byte at a time, seeded property tests with mulberry32: sexp seed
  1, wire seeds 5, 7 and 11), a 7-digit prefix whose six-digit reading does not end a reply;
  every builder and decoder, and the handshake of another shape marked as such.
- `protocolTranscripts.test.ts` — every frame of the recordings (34 in M2, 42 since M3) cut and
  decoded under 20 random chunkings each (seeds 1–34 in M2; the socket recordings with the socket's decoder,
  `framesOnly`), and again with every `\n` of the stream written as `\r\n`
  (4 chunkings each, seeds 101–134), every request rebuilt byte for byte by a builder, every
  reply decoded by its command's decoder, and the facts each scenario pins (F1–F7, F10, F11,
  F14–F16, F29–F31, F33) asserted on the decoded values.
- `session.test.ts` — `backend/ide/session.ts` against `support/fakeTransport.ts` (a fake clock,
  a JSON codec, transports whose frames, output and exit the test injects): the handshake
  (major version 2 only; a socket that was connected but got no handshake: after 2 s, after the
  end-of-input line, and an exit at once, which is an ordinary crash), one request in
  flight, cancellation, time limits, F4 attribution, unframed output (the process's output over
  stdio, a protocol error on the socket), an unreadable `:return`, an unreadable handshake
  (failed at once), anything received on the socket — a byte of an item not complete yet
  included — ruling out a takeover, a restart refused for a directory that is gone (no
  revocation), a stream that ends
  inside a frame (reported with the exit code and stderr), an `overflow`, protocol errors, crashes,
  backoff and give-up, merged loads, the check before a request is written (`beforeSend`: after
  the handshake, again for a new process, the newer of merged loads, within the request's own
  time limit, abandoned when its request is cancelled, the next request going on at once), an
  `urgent` request going before the others waiting but never before the one in flight or one
  whose check runs or has passed (ROADMAP §9 Q21), time-outs that name the
  bytes of an incomplete item, the loaded file, idle, stop (also while the consent question
  is open; the requests it abandons reject as `Cancelled`), restart and dispose.
- `pool.test.ts` — `backend/ide/pool.ts` with fake transports, toolchain, settings and gate:
  the command line of ARCHITECTURE §5.2 and `effectiveCheckBuildDir` (POSIX and Windows; a
  `--build-dir` in the `.ipkg`'s `opts` or in `extraArgs`; `--ide-mode` by default on every
  platform value, `--ide-mode-socket` only when chosen, ROADMAP §9 Q20), trust → toolchain scan → consent →
  snapshot → the directory judged again before every spawn (a folder revoked, a directory
  replaced or unresolvable during the scan is not started in; the process started in the real
  path the last verdict judged, with the isolated build directory there too, and not restarted by
  a load), the `.ipkg` named to the gate, an `extraArgs` with `--ide-mode` or
  `--ide-mode-socket` starting nothing (also when it is set while the question is open),
  restarts only when
  the command line changes, consent withdrawn, stop, release (the last document closed), a
  changed package file (`packageChanged`), restart, dispose; `idris2.ideMode.maxSessions`
  (ROADMAP §9 Q21): none evicted with the default 0, the least recently used idle session evicted
  above the limit, never a busy one or the active root's (also when that one is the least
  recently used), none while none is idle, an evicted root started again by its next request
  (after the gate), a lower limit applied at once without restarting anything, a change of the
  limits alone not returning a `failed` session to `stopped`, a change of the active root
  applying the limit again, none evicted while the active root is `pending`; `startProblem` (what
  refuses a start before the consent question, asking and starting nothing).
- `transport.test.ts`, `processSession.test.ts` — the transports and `startLongRunningProcess`
  with real processes (the fake compiler and small Node scripts): the port line, output before
  and after it, a compiler that cannot open its socket, more than 1 MiB before the port, a
  connection closed by the compiler (and one closed by a stop), a process that ends inside a
  frame (`truncated`, then its stderr and exit), on the socket a reply with an unknown head and a
  stream cut inside a header, the bytes received before an item completes, the buffer bound
  (`overflow`), the start in `realCwd`, stop and dispose.
- `sessionOverFakeIdris2.test.ts` — the pool with real transports over both transports against
  the fake compiler through its launcher: replayed loads (one that makes the compiler log, over
  both transports), and the injected faults (crash, a crash inside a reply — reported with its
  exit code, stderr line and incomplete frame —, noise, id mismatch, hang) with the restarts
  they cause (noise over stdio causes none); `FAKE_IDRIS2_LOG` checks the command
  lines, and every test waits until no fake process is left.
- `diagnostics.test.ts` — `backend/ide/diagnostics.ts` on the recorded replies
  (`support/loadReplies.ts` turns a transcript into the `Reply`s the session hands over): exact
  ranges and messages, severities (the known-warning table on every `warning-*` recording,
  `-Werror`), which files a load determines, the `.ipkg` error, the not-checked error and the
  files that caused it (`blockedBy`).
- `backendIde.test.ts` — `backend/ide/backend.ts`: the `:load-file` path (real path of the
  session directory), the walk again before every load, when it is queued and when it is the next
  to be sent (for a loose file a package file found stops it and its sessions, also one created
  while a first load waited for the consent question; for a project anything but its own `.ipkg`
  does), a path the compiler reads otherwise (`\`, `:`, `?`), a session directory that cannot be
  resolved, is not the one its compiler was started in (identity noted at the start, at the real
  path it was started in) or whose real path changed while the load waited, the walk made when
  the load is queued failing it after `longActionTimeout` when it hangs (nothing sent, nothing
  stopped), the `urgent` option handed to the session, `refusalBeforeQuestion` (the walk's refusal,
  else the pool's start problem; nothing started, stopped or asked),
  diagnostics built from recorded replies (`-Werror` on the command line or in `opts`,
  `blockedBy`), the per-root state for the status item, crash notices (a repeated crash before an
  answered request), the automatic restarts the checks follow (`onDidRestart`), the commands' and
  the checks' control surface.
- `diagnosticsChecks.test.ts`, `diagnosticsCommands.test.ts` — `features/diagnostics/*` against
  a fake of the VS Code API: triggers, `runningCheck` (M3: the newest check while it runs) (`afterDelay` saves nothing in Restricted Mode, for a
  refused folder or a given-up session), document states, the collection (overlapping checks of
  one document: every result applied in the order the checks started; counts read from the
  collection; a closed document's diagnostics given back on reopening, only for the same text;
  `known`; a document never checked here keeps them when it closes; a deleted file's document),
  documents not checked because of an imported file checked again once it is clean, a saved
  `.ipkg`, consent refusals (also for a document shown later), a load abandoned by a stop
  (`Cancelled`), Restricted Mode, checks after automatic restarts, releasing a root (and what
  its loads set on files that are not open) when its last document closes or a check finds the
  document in another root (an open file keeps what it shows, until it closes), a file changed on
  disk (checked again, also when the reload comes during a check — the first one, the one a
  re-created file started, a change back and forth; `stale` with `manual`; a BOM and other line
  ends on disk), told apart from a keystroke by reading the file, with the change events in VS
  Code's order (the text change with the dirty state from before it, then a dirty-state event): a
  keystroke checks nothing (also after Stop Backend, also when its dirty-state event is late), an
  undo back to the checked text makes it current again (also while its check runs, and after a
  check started with unsaved changes), one back to the text of a check Stop Backend cancelled
  reads `stale`, and a check started between a text change and its dirty-state event reads the
  file; a file deleted and created again, one load per
  trigger for a document shown in two editor groups; the active document (the last active Idris
  file while another editor is active) and its root told to the backend, and its check started
  last where several visible documents are checked at once (M3; with a limit, its load urgent
  unless, at its handover, a load of the batch in its root handed over before it has not settled,
  decided once and counted per root — alone in its root, as after an import was fixed, urgent —,
  and the documented exceptions: a folder not judged yet;
  a check of the batch in its root left waiting for a slot, when the batch's checks that take one,
  of any root, outnumber the free slots, also with a slot held by a background check outside the
  batch);
  `idris2.ideMode.maxBackgroundChecks` (ROADMAP §9 Q21): all at once with the default 0, one at
  a time in order with 1 while the active document's check starts at once, a waiting document
  that becomes active promoted, a waiting check dropped when its document closes or a newer check
  of it takes its place, a higher limit (or 0) starting waiting checks, a lower one stopping
  nothing, Stop Backend dropping the waiting checks of its root or of all (`cancelWaiting`, also
  one still waiting for its folder's answer), a background check of a folder not judged yet asking
  first without holding a slot, a refused folder taking none, running checks counted again when
  the active document or the limit changes, a revoked folder's waiting check refused without a
  question, the `pending` active root, the active document's load `urgent` only while a limit is
  set, the active document's closing counting its running check, an active document no check
  tracks (the `manual` trigger) classified for its root, a background check whose load would be
  refused anyway (`refusalBeforeQuestion`) not asked about, a folder deleted while a check runs
  getting none of its late result; and (verification after Q20–Q22) an undo or a reload back
  to the checked text while another check of it runs, a file deleted while its check runs, a
  reload after a failed first check, `stale` after a check started with unsaved changes or with a
  file that is not UTF-8; Check File (and its refusal with
  Allow…), Stop and Restart Backend, the crash notices (one per root until a request is
  answered), the trace channel and Send Raw Protocol Request (a text given as the argument only
  under the test runner).
- `consent.test.ts`, `consentRegister.test.ts` — `features/consent/*`: Restricted Mode, trusted
  folders, one question per directory and window, the three answers, the folders allowed for
  good, canonical paths (symbolic links, case; on Windows only the drive letter folded, names that
  differ in case and KELVIN, ANGSTROM and OHM SIGN kept apart; an unresolvable directory is refused
  with its error, `recheck` reads the real path again and returns it), revocation (holding before
  the store's write completes), timed decisions (this window's
  later decision over a copy of its earlier write that comes back late; a revocation in another
  window asked about here and not written back by this window's next decision), a
  question shown again by Allow… while it waits (the
  first answer to any showing decides); the notification's buttons and text (naming the `.ipkg`
  that chose the folder), Allow… and Manage Allowed Folders… (a failed write shown as text, not
  left to reject).
- M1 files extended in M2: `config.test.ts` (the M2 settings and their validation; a delay
  above 2^31 − 1 ms; the transport `stdio` unless `socket` is written, the former `auto` read as
  `stdio`; the two limits; which keys a change affects), `manifest.test.ts` (the M2 settings,
  commands, menus and restricted settings; the delays' maximum; the transport's values, default,
  `application` scope — user settings only — and description, also of the trace; the two limits
  described as per window; every `idris2.ideMode.*` key either shaping a session or only
  limiting what runs), `errors.test.ts` (`cancelled`),
  `statusItem.test.ts` (the check texts, `stale` by its cause and trigger, `up to date`, `not allowed here` and its Allow… link,
  Allow… while the question waits, `stopped` after a revocation, a detail without links, with
  quoted paths and a consent text first, and the command's plain-string tooltip), `backendRegistry.test.ts` (one provider,
  `BackendState`, `pendingLabel`), `fakeIdris2.test.ts` (now through `fake-idris2/client.ts`).
- `notificationText.test.ts` — `core/notificationText.ts`: VS Code 1.139.1's link pattern (copied)
  finds no link in the consent question about hostile folder names or in quoted compiler text
  after `plainText`, the shown text is unchanged; the question keeps its warning first and whole
  whatever the folder's name or length, counted in UTF-16 units, and writes out look-alike quotes
  (the whole two-apostrophe group of Unicode's `confusables.txt`, the characters it maps to three
  or four apostrophes, every space but U+0020) and runs of two or more apostrophe-like characters,
  combining marks on them included (`shownPath`); and a scan of `src/`'s syntax trees, with names
  resolved by the type checker, finds every text VS Code parses for links (messages, input-box and
  QuickPick prompts, validation messages, progress texts, the status detail) a literal or wholly
  one `plainText(…)` call, and every use of those APIs a direct call (no element access,
  destructuring, `.call`, non-literal options, `+=`, `Object.assign` from anything but plain
  object literals, `Object.defineProperty` or `Reflect.set`, and no text key set by a
  destructuring assignment or as a `for … of`/`for … in` target).
- `fakeIdris2Replay.test.ts` — the fake compiler's replay: every transcript replayed over both
  transports and compared item by item with the recording (prefixes, program output, end of
  input, exit code), the fixture hashes, the choice between recordings by history, a request
  without a recording, the injected faults and the command lines it accepts or refuses.

## Unit tests of the M3 code (`unit/`)

No compiler runs in them; recorded compiler output comes from `fixtures/transcripts/0.8.0` (M3
added the recordings `clean-queries`, `shapes-lookups`, `simple-ipkg-lookups`, `lit-lookups`,
`unicode-columns`, `eval-values`, `eval-command-forms` and `eval-socket`). The features are tested
against fakes of the VS Code API (`support/intelligence.ts`, `support/interactiveFakes.ts`) and of
the backend.

- `replCommand.test.ts` — `backend/ide/replCommand.ts`, the refusal of Evaluate Selection: every
  text the compiler ran as the command `:t id` in `eval-command-forms` is refused; the expressions
  of `eval-values` are sent; the REPL commands that run programs or change the session, however
  they are preceded (white space, control and format characters, comments); and a port of the
  compiler's lexer rules as an oracle, checked against the recorded texts and then run on 20,000
  generated texts (seed 20260929): every text it reads as a command is refused.
- `positions.test.ts` (M3 part) — E14: `codePointsBefore` and `utf16Length`, and every
  conversion of the §7 table on lines with characters outside the BMP (the recorded answers of
  `unicode-columns`); `toCompilerColumn` and `codeLineSpans` (a range over lines, per code line);
  `lineCorrespondence` (a line diff anchored on unique lines: on 800 random pairs of texts, seed
  23, its equal pairs a common subsequence to which no two equal lines can be added, and a longest
  one when no text repeats a line; a block moved past another kept together; the bound
  `MAX_LINE_EDITS`), `compilerLines` and `editorLines` (a lone `\r`), `editorSplit` and `textMap`
  (a text a load read and a document's that differ only in line breaks mapped exactly, the line
  holding a lone `\r` too: every position of 2,000 random texts, seed 777; split first, then
  diffed, with an edit: below the lone `\r` and after it on its line, and every position of 3,000
  randomly edited texts mapped to the same text before it and back, seed 99), `toLoadedPosition` (a position of the text shown in the text a load read,
  also between two separate edits) and `toShownPosition` (the converse, for a definition's range).
- `protocolTranscripts.test.ts` (M3 part) — the new recordings: every request rebuilt byte for
  byte and every reply decoded; E14 (all 24 positional answers of `unicode-columns` land on the
  named local and convert back to the recorded column), highlighting offsets inside a reply that
  count code points, the completion and namespace-listing shapes, and an IO action shown, not run
  (nothing unframed over stdio, nothing on the socket's stdout); `highlightSourceId` finds exactly
  the `:highlight-source` frames of every recording.
- `highlight.test.ts` — `backend/ide/highlight.ts`: the token index of eight recorded loads (every
  named token holds its name in the fixture text at the converted range, except the recorded
  sugar: tuple commas, list brackets), duplicates merged, E14, the `.lidr` offset, failed loads
  (no index), frames of another file or shape, and the cost of 24,000 frames (asserted < 1,000 ms,
  a guard against a regression in kind since the fifth review of M3; the 200 ms budget is timed for
  the provider: its encoding by `semanticTokens.test.ts`, its answer after a real load by the e2e
  suite; the numbers are in `docs/as-built/M3.md`, *Measured*).
- `backendIde.test.ts` (M3 part) — the queries (`NotLoaded` at once and right before the write,
  also when a reload of the same file went first, then with a text of its own,
  positional `:type-of` then by name, an answer about another local not taken, a variable not
  asked by name, `perimeter`'s machine name answered by name, caches per load, a reload being
  made waited for, a position of a document with unsaved changes asked where it lies in the file
  as loaded, a local operator's answer), definition (a bound variable refused by the caller's
  decoration, also with unsaved changes; qualified names; the token's namespace; unreadable and
  non-absolute targets; the `:name-at` answer and the target files kept per load; a range moved
  to the target's open document with unsaved changes, or left out on a changed line with the
  reason for its kind of change, and to the lines VS Code shows of a target that is not open,
  below a lone `\r`; a definition starting on the line that holds one, in the loaded file and in
  another file, open or not),
  completions, namespace listings, the token index (its text only when the file read the same
  before and after the load; at most 16 kept; a byte order mark dropped, as the compiler drops
  it) and `onDidLoad` (`rebuilt` — also a load that built nothing of another text than the file's
  last announced load read —, `failed`), the completion
  warm-up (sent once the session has been idle for a while, given up after a limit), and evaluation (the refusal before the backend classifies or starts anything, a load
  before every `:interpret`, the `:interpret` queued with the load under `idris2.eval.timeout`,
  one evaluation at a time, the load lost before the `:interpret`, a time-out, a failed session,
  a cancellation, a file that does not load, the directory check of the `eval` process); and an
  evaluation with the real session pool at `maxSessions` 0, 1 and 2 (one `eval` process each).
- `pool.test.ts` (M3 part) — the `eval` role: its command line (`build/.vscode-idris2-eval` unless
  the package or `extraArgs` choose the build directory), counted towards `maxSessions` while idle
  (starting an evaluation stops no other root's session) and evicted before any `check` session,
  stopped — not restarted — by Restart Backend (one project or all) and by a change of its command
  line, stopped by `cancelEvaluation`, its idle limit of at most 2 minutes. `session.test.ts` (M3 part): an `eval` session is not restarted after an
  exit, a request time-out or a handshake time-out, and drops the `:highlight-source` outputs of
  its request unread.
- `hover.test.ts`, `hoverQueries.test.ts`, `hoverText.test.ts` —
  `features/intelligence/{occurrence,hover,queries,text}.ts`: the name at a position (index, else
  the lexer), the tokens that still apply to another text (and all of them again for the text the
  load read; those of the line that holds a lone `\r`), the hover model and the answers it drops, the occurrence's decoration passed on, no
  type kept while the document is stale, `isStale`, what checks a stale document again (also for a
  stale package error under the `manual` trigger, and while a check runs, from the settings), the
  rendering (compiler text only
  in fences no line can close — the overview too, whose named character references and autolinks
  `appendText` let through —, invisible characters written out), `DocumentQueries` (Restricted
  Mode, the load on `NotLoaded` for commands and for the active document only, one shared check,
  the document's running check waited for instead of a second)
  and `AnswerCache` (kept until a load of the root that built something, also of another file;
  dropped when the file's document closes, not another document of its path, the file's root kept);
  the `:docs-for` blocks and their overview.
- `semanticTokens.test.ts`, `symbols.test.ts`, `documentHighlights.test.ts`, `definition.test.ts`,
  `docs.test.ts`, `browse.test.ts` — the legend and encoding (recorded tokens of `Shapes.idr` and
  `Lit.lidr`; multi-line tokens per line, after the bird-track marker and not on prose lines; of
  overlapping tokens the inner one; literals `:data`; 2,000 lines under the budget), document
  symbols from the syntax model, highlights (bound names per clause, globals per file), Go to
  Definition (nothing shown for locals; the decoration and namespace passed on; the backend's
  reason logged), the `idris2-doc:` document (a `.txt` path, refreshed
  after a load; a docstring with links, HTML, icons and fences shown as text), Show
  Documentation… and Browse Namespace….
- `completion.test.ts`, `inlayHints.test.ts` — where completion applies, the keywords and
  directives (against the lexer and the grammar), the time limit (an incomplete list, answers
  kept per file, a longer prefix answered from a pending shorter one), the pre-warming after a
  load of the active file, a compiler name as a label (invisible characters written out, no theme
  icon; inserted as it is); which bound tokens get a hint, the label, the tooltip, the range asked
  about, the caches, nothing asked while the document has unsaved changes or shows another text
  than the index (also after it was closed, changed and opened again), and then the kept hints at
  the places their tokens were carried to (also between two separate edits), a saved file with
  mixed line breaks or a lone `\r` asked about at the lines VS Code shows, and the answers a load
  made stale where nothing can be asked (a failed save, a refused query, a line edited in place,
  not a swapped clause, an index of another text without a stale event, a lone `\r` on a hinted
  line saved as the document's line break, or kept with the line edited after the variable), not
  replaced by an answer that shows nothing after a failed load, which a close of the file's own
  document forgets; nothing asked while the file's index has no text,
  also when the document shows the text of the index before; the index the answers were asked
  with not kept alive once the backend replaced it (`WeakRef`, the collector exposed at run time);
  the caches of both kept when another document of the file's path (a `git:` one) closes, and the
  file's root kept when its own document closes (answers asked after it opened again go stale with
  a load of the root).
- `eval.test.ts`, `untrustedText.test.ts` — `features/eval`: the selected expression (bird
  tracks and Org's `#+IDRIS:` markers, prose, Org lines without a marker, a selection over lines
  indented to its column: `let` and `case … of` blocks),
  the label and the hover, the command's outcomes, notifications (one line, invisible characters
  written out) and results drawn, the Cancel offered a second after the evaluation started (not
  while it waits behind another of its root, also a third one asked after the first ended), and,
  with the real `IdeMode`
  over recording fakes, every command form refused before any session is asked for;
  `core/untrustedText.ts`: the fence (also for 200,000 runs of backticks), `visible`,
  `quickPickText`, `editorLabel` (every format character, also those that are not
  default-ignorable).
- `fileSystem.test.ts` — `toolchain/fileSystem.ts` `readSourceFile`, how IDE mode reads the source
  files its replies name: a FIFO and `/dev/zero` refused unopened, the 8 MiB limit.
- `keybindings.test.ts` — every command a keybinding binds, and every command `package.json`
  contributes, is registered by a `registerCommand` call with a literal id in `src/`.
- M2 files extended in M3: `config.test.ts` and `manifest.test.ts` (the M3 settings, commands,
  menus and keybindings; `idris2.keybindings.scheme` in the user settings only), `errors.test.ts`
  (`NotLoaded`), `nullBackend.test.ts`, `statusItem.test.ts` (the item written only when what it
  shows changed), `fakeIdris2Replay.test.ts` (each
  recording replayed with its own command line, so in its session role).

## Integration suites of M3 (`integration/`)

The fake compiler replays the M3 recordings; `FAKE_IDRIS2_REQUEST_LOG` shows which process read
which request.

- `intelligence/` (suite `intelligence`, workspace `simple-ipkg`) — hover on `greeting`, F12 on
  `shout` into `A.idr`, the semantic tokens of `Shapes.idr` in idris2-lsp's legend, a replay whose
  highlighting has empty `:type`/`:doc-overview` fields (F33) with the hover answering from
  `:type-of`, the bound variable `r`, highlights, symbols, and Docs at Cursor / Show
  Documentation… (the input box accepted).
- `intelligence-loose/` (suite `intelligence-loose`, workspace `broken`) — `queries.test.ts`: the
  hover and the inlay hint on `xs` (moved with its line under an unsaved inserted line, again in
  place after the revert, none with the setting off), completion of `vl`, E14 on `Unicode.idr`; `evaluation.test.ts`: REPL commands
  refused with nothing sent and no `eval` process started, values and IO actions from a new `eval`
  session (its own build directory, the `check` session's transport), the `check` session
  untouched; `keybindings.test.ts`: the nine bindings VS Code accepted, per scheme, and E23 (the
  default keymap's bindings that share a scheme's first key, printed, and pinned on macOS).
- `intelligenceLit.test.ts` (suite `integration`) — `Lit.lidr`: tokens and hover in file columns;
  below its `> `/`>   ` lines the compiler's lines are the file's plus one per such line, and the
  hover on `++` right after `xs` asks one column further.
- `diagnostics/evaluationSocket.test.ts` (suite `diagnostics`) — the `eval` session uses the
  socket when the user chose it for the `check` session.

## Unit tests of the M1 code (`unit/`)

Every module below has no runtime `vscode` import; the UI modules take the `vscode` namespace as
a parameter and are tested against a fake of it. `support/toolchainFixtures.ts` builds
snapshots and project roots and a fake `ToolchainService` for them.

- `config.test.ts`, `event.test.ts` — `core/config.ts` (validation, `~` expansion, no expansion
  without a usable home directory, one pair of surrounding quotes removed, change events per
  group) and `core/event.ts` (snapshot
  rounds, errors, dispose); compile-time checks that `vscode.workspace`, `vscode.Event` and
  `vscode.LogOutputChannel` fit the interfaces.
- `manifest.test.ts` — `package.json`'s M1 contributions: every setting's type, default, scope
  and description; `core/config.ts` reads exactly the contributed keys; Restricted Mode
  (`"limited"`, the restricted settings); commands, menus, `when` clauses (only the context keys
  the extension sets), the submenu listing every command once; the walkthrough's pages and links.
- `process.test.ts` — `core/process.ts` with real child processes: output and exit codes,
  arguments passed without a shell, the environment overlay, the working directory, stdin at
  end of file, spawn errors, the output limit, termination (time limit, the process group,
  SIGKILL escalation, a grandchild holding the pipes, and a program that ignores SIGTERM after
  its `sh` wrapper died on it, the shape of the idris2 launchers), the trust gate, one process at
  a time in call order, `dispose()` (the running process killed at once, without a grace period
  and without a log line, queued and later requests rejected); `cmd.exe` quoting, the choice of `cmd.exe` and the batch-file test
  as strings everywhere, and on Windows only a real `.cmd` round trip and a timed-out `.cmd`
  stopped together with its child (`taskkill /T`).
- `toolchainDiscover.test.ts`, `toolchainPack.test.ts` — the search over an in-memory file system
  (POSIX and Windows layouts, `PATHEXT`, also for an absolute Windows path without an extension,
  `preferPack`, the setting's no-fallback rule, pack's directories recognised whichever step
  finds a tool in them, no home directory, candidates that exist but cannot be run named in the
  reason) and pack's
  directories and collection (defaults, `XDG_*`, `PACK_*`, the state file winning over the
  global `pack.toml`, a FIFO named `pack.toml`, no home directory) in temporary directories.
- `toolchainVersions.test.ts`, `toolchainVerdict.test.ts` — the parsers on the outputs of the
  Homebrew 0.8.0 build recorded on 2026-09-27 (`--version`, `--ttc-version`, `--paths`,
  `--list-packages`, also with a local `depends/`) and on synthetic variants (tags, `-dev`,
  CRLF, idris2-lsp's two lines and its `Invalid Arguments`); the verdict table.
- `toolchainService.test.ts` — scans against a fake runner: probe order, Restricted Mode
  (located, nothing run), trust granted, failures, the settings' environment, pack; scheduling
  (one queued scan shared by requests during a scan, events, dispose: no probe starts after it).
- `ipkg.test.ts`, `projectIndex.test.ts` — `project/ipkg.ts` and `project/index.ts` against the
  compiler output recorded in `support/ipkgRecordings.ts` (12 fixture files and 16 texts,
  `idris2 --dump-ipkg-json <name>` in the file's directory, one process at a time, and the same
  byte for byte when run as the extension runs it, with the absolute path; each fixture
  recording carries its SHA-256, and a test fails when a package file under `fixtures/ipkg` or
  `simple-ipkg` has no recording or has changed — re-record it then, as the file's header says):
  the walk (listing order, stopping rules; a folder whose name has a `\` it cannot follow as the
  compiler does, M2), the dump parser (raw strings, warnings before the
  JSON, errors with ranges), the fallback reader against every recording (byte-order marks and
  NULs read as the compiler reads them), long and pathological block comments (no stack limit,
  a comment that fails late read in polynomial time, the work limit), which package files are
  read at all (a directory, a file over 256 KiB, a FIFO, a link to `/dev/zero`: refused without
  running the compiler), classification (a root outside the workspace folders is read without
  the compiler), caching and invalidation (the workspace folders, a changed `.ipkg` dropping
  only its model, the snapshot's environment, created and deleted paths: module files, a folder
  moved in or deleted and reported alone, `main`, build output changing nothing, a package
  folder renamed on disk; dispose; one root for two spellings on Windows), `roots()` (read when
  asked for), and the module ↔ path mapping.
- `literate.test.ts` (M1 part) — the compiler's literate table, `splitFileExtensions`,
  `isIdrisSourceFileName`, and the double-extension rows, matched as VS Code matches a
  `**/*.<ext>` pattern (case-sensitive `endsWith` on the path).
- `backendRegistry.test.ts`, `statusItem.test.ts`, `setupInformation.test.ts`,
  `notifications.test.ts`, `installCommands.test.ts` — the registry's labels; the status texts,
  the QuickPick (the submenu's entries, read from the real `package.json`, in the order of VS
  Code's `compareMenuItems`), the logged status changes and `idris2.packFound`, the previous
  file's package never shown for a newly active file; the Setup Information text (inline code
  around backticks) and Report Issue… (with and without the issue reporter;
  `idris2.toolchain.env` values only of path variables, URL credentials masked up to the last
  `@`, so that no secret reaches either); the once-per-condition notices; the install actions,
  the POSIX quoting of the pack path (checked by `/bin/sh`), PowerShell's quote characters, a
  pack path with a control character (or, on POSIX, a backslash) refused, that the text is
  typed with no line break, and that every terminal starts in the home directory (none without
  one).
- `fakeTools.test.ts` — `fake-tools/`: each launcher runs its tool's script (shell script
  with the executable bit, `.cmd` shim); the fake compiler's recorded probes, including that
  every `--dump-ipkg-json` recording still matches its fixture's bytes; the fake idris2-lsp and
  pack; the fault modes; and the simulated pack layouts (skipped on Windows), including that
  running pack's `idris2` wrapper runs pack.

## E2E suite (`e2e/`, M1–M3)

Runs with `npm run test:e2e` (the `e2e` suite of `.vscode-test.mjs`, workspace
`fixtures/workspaces/simple-ipkg`, no toolchain settings) against the `idris2` on `PATH`; the
macOS CI job runs it after `brew install idris2`. It reads the extension's state through the test
API that `activate()` returns in `ExtensionMode.Test` (`src/extension.ts`), and compares it with
what the real compiler prints **in the same run** (shapes, not the literal 0.8.0):

- `toolchain.test.ts` — the `idris2` found is the first on `PATH` (else a well-known directory);
  its parsed version and TTC version equal `--version` / `--ttc-version`; `--paths` and
  `--list-packages` were read; `src/Foo/B.idr` belongs to the `simple.ipkg` root, whose model
  comes from `--dump-ipkg-json` (sourcedir `src`, depends `contrib`, the same modules the
  compiler prints) and whose session directory is the ipkg directory; Show Setup Information
  shows the version line and TTC version. Before a test runs the real compiler itself it waits
  until the extension is idle (`helpers.ts` `extensionIdle`: no scan running, and the model read
  with `--dump-ipkg-json` for the current snapshot), so that two `idris2` processes never run at
  once.
- `install.test.ts` — Install Idris 2… (macOS only; elsewhere it opens a browser), Install pack…
  and Install or Update idris2-lsp with pack (with `idris2.toolchain.packPath` set to the fake
  pack) each type their exact command into a terminal and send no line break; the last one's
  terminal starts in the home directory. The default terminal profile is the integration
  suite's terminal recorder (`integration/terminalRecorder.ts`), which records the bytes the
  terminal sends instead of running a shell, so nothing can be executed even by a
  regression. `useTerminalRecorder` waits until a probe terminal with the default profile runs
  the recorder, since VS Code applies a profile change up to 2 s late (`docs/as-built/M1.md`,
  *Acceptance as tested*).
- `protocolFacts.test.ts` (M2) — every fact F1–F7, F10, F12–F14, F29–F33 of ROADMAP §0 (and the
  F12 addendum: a `--build-dir` in `opts`, where `checkBuildDir` says) against
  the real compiler, through `ideDriver.ts` (which starts `idris2 --ide-mode` or
  `--ide-mode-socket` itself, one request at a time, and decodes with the extension's codec),
  the addenda of F5 (two requests in one socket write, input that ends inside a request, the
  compiler's log lines over both transports), a load of a generated 1,202-line module whose
  ~10,000 `:highlight-source` frames must all decode (it prints its numbers: the M2 risk "big
  files"), and every 0.8.0 transcript compared with what the compiler sends now (skipped, as
  pending, when the installed compiler is another version).
- `sessions.test.ts` (M2) — the extension's own sessions: `simple-ipkg/src/Foo/B.idr` loads
  cleanly on open in one stdio session (the default, ROADMAP §9 Q20) in the `.ipkg` directory
  with `--build-dir build/.vscode-idris2`; the TTC files appear only there, and
  `effectiveCheckBuildDir` names it (F32); a killed compiler is replaced and the next load
  answers within 2 s; 100 saves leave one process, and B.idr then shows no diagnostics and the
  status `checked` with none; `idris2.ideMode.transport = "socket"` in the user settings restarts
  the session with `--ide-mode-socket`, which loads cleanly, and removing it restarts it over
  stdio; a loose file outside the workspace loads after its folder is allowed, and a `cd`
  request gets the F4 attribution.
- `fakeParity.test.ts` (M2) — the fake compiler and the real one get the same bytes for three
  scenarios over both transports and for `load-logging` over stdio; their streams, output and
  exit must be identical.
- `e21.test.ts` (M2) — ROADMAP §9 E21: one IDE-mode session and one `idris2 --build` at the same
  time on `builddir-ipkg` (the only test that runs two compiler processes); both succeed and the
  TTC files stay usable. It prints whether the two compiled at the same time.
- `intelligence.test.ts` (M3) — the M3 acceptance with the real compiler: hover on `greeting`, F12
  on `shout`, the tokens of `Circle` and `area`, the hover and inlay hint on `xs`, completion of
  `vl`, E14 on `Unicode.idr`, Evaluate Selection (`:exec` refused with no process started; `[1, 2]`,
  the IO action and the `HasIO` error from an `eval` process with its own build directory; the
  hover answering afterwards), `Lit.lidr`'s `module` token at column 2, and the semantic tokens of
  a generated 2,000-line module (asserted < 200 ms; it prints its numbers). One compiler at a
  time: the evaluation runs while the root's `check` session is stopped.
- `protocolFacts.test.ts` (M3 part) — E14 for `:type-of` and `:highlight-source`, an IO action
  given to `:interpret` normalised and not run over both transports, and which spellings of `:t id`
  the REPL parser reads as a command; `fakeParity.test.ts` adds `eval-values` over both
  transports.

## Grammar tests (`grammar/`)

- `harness.ts` loads the grammars through `package.json` (so the manifest wiring is tested
  too) with `vscode-textmate` and `vscode-oniguruma` at the versions VS Code 1.139.1 ships.
- `idris2.test.ts` — `scripts/build-grammar.mjs --check`; every include resolves and every rule
  is used; every regex compiles; the scope inventory matches `idris2-scopes.md`; one snapshot
  per `.idr` fixture with the root end state and no `invalid` scope; targeted assertions for
  each M0 construct and for the lexer's surprising rules (each confirmed with `idris2 --check`).
- `lidr.test.ts`, `ipkg.test.ts` — line classification after the compiler's unlit step, state
  carried across bird-track lines, every `.ipkg` field and the comment automaton; snapshots
  (the `.lidr` ones also with no `invalid` scope). `lidr.test.ts` also converts every `.idr`
  fixture to bird-track code and requires the same tokens as in the `.idr` file
  (`harness.ts` `birdTrackDifferences`). It does this a second time with a prose line after
  every code line, where the code must tokenise like the `.idr` file with an empty line at
  each prose line (the compiler's unlit step turns prose into empty lines).
- `perf.test.ts` — median of five tokenisations of the `.idr` fixtures, concatenated and
  repeated to at least 2,000 lines (2,372 with the final M0 fixtures, 2026-09-27); logs the time,
  and asserts a 300 ms budget: twice the slowest CI median (ROADMAP E6).
- `corpus.test.ts` — not part of `test:grammar`; `npm run test:corpus` fetches the corpora and
  tokenises every file (no `invalid` scope, root end state except the files listed in
  `corpus.json`), then checks that every corpus `.idr` file tokenises the same as bird-track
  code (`birdTrackDifferences`). With `IDRIS2_LEXER_ORACLE=1` it builds `corpus/lexer-oracle/LexDump.idr`
  against the installed compiler and checks each lexer token's scope.
- Snapshots: `UPDATE_SNAPSHOTS=1 npm run test:grammar` rewrites them; review the diff before
  committing, never regenerate blindly.

## Integration suite (`integration/`)

- `activation.test.ts` holds **root-level** `suiteSetup`/`suiteTeardown` hooks. `@vscode/test-cli`
  gathers files with `glob`, whose order is not sorted, so the activation measurement cannot rely
  on running first as a test; a root hook runs before every suite whatever the file order. It
  asserts that the extension is inactive, opens `Hello.idr`, waits (deadline 10 s) for it to
  become active through `onLanguage:idris2`, and prints the elapsed time as
  `[activation] openTextDocument(Hello.idr) → extension active: N ms`; the test asserts
  N < 250 ms, or N < 1,000 ms when `CI` is set (the bounds and their justification are in the
  file). The teardown closes all editors
  so that the next run does not restore an Idris editor from `.vscode-test/user-data`, which would
  activate the extension early and fail the "inactive until opened" test.
- `languages.test.ts` — language ids of `.idr`, `.lidr`, `.md` and a temporary `.ipkg` (written to
  the OS temp directory: an `.ipkg` in the workspace would trigger `workspaceContains:**/*.ipkg`),
  and the `configurationDefaults` for `[idris2]`/`[lidr]` (`inspect().defaultLanguageValue`),
  including `files.eol` for `[lidr]` only.
- `documents.test.ts` — `isIdrisDocument` and `idrisDocumentSelector()` (through
  `vscode.languages.match`) on real documents, including (M1) `Doc.idr.md` in the Markdown
  mode, selected by a pattern row. The `idris2.isIdrisDocument` context key has no
  read-back API, so its logic is covered by the unit test only.
- `selectionRanges.test.ts` — `vscode.executeSelectionRangeProvider` on `Vlen.idr` (ROADMAP M0
  acceptance) and `Lit.lidr`. VS Code merges its own ranges (such as the whole line) into the
  chain, so the expected ranges are asserted in order, not as the complete chain.
- Help commands: all three are checked to be registered; Show Output and Open Settings are run.
  Open Idris 2 Documentation is not run, because it would open the system browser.
- `toolchainUi.test.ts` (M1, suite `integration`: the fake tools named in the user settings of
  `.vscode-test.mjs`) — the fakes are found and probed, the pair is compatible; the status item
  reads `Idris 2 0.8.0 · IDE mode · ✓` (M2) and names the loose file; Show Setup Information shows
  paths, raw and parsed versions, the verdict and trust; every contributed command is
  registered; the status QuickPick equals the visible submenu entries; with `idris2Path` set to
  a missing file, one warning with Install Idris 2…, Set Path and Show Output, not repeated by a
  rescan, and everything else still works; a server with another API version
  (`FAKE_IDRIS2_LSP_API_VERSION`) is announced once; the install commands type their exact
  text, with no line break, into a terminal whose default profile is the terminal recorder
  (`terminalRecorder.ts`, below), started in the home directory with `idris2.toolchain.env` for
  the pack ones — Install or Update idris2-lsp on every platform, Windows included. Tests that
  change a setting restore it.
- `simple-ipkg/classification.test.ts` (M1, suite `simple-ipkg`, workspace folder
  `simple-ipkg/src`) — `Foo/B.idr` belongs to the `.ipkg` above the folder, the session
  directory is the `.ipkg`'s, the module is `Foo.B`, the model comes from the built-in reader
  because the `.ipkg` lies outside the folder (sourcedir `src`, depends `contrib`); `roots()` is
  empty while the status item and Setup Information name the root and say it lies outside
  (M2: the status reads `… · checking…` while the consent question nobody answers is open).
- `diagnostics/diagnostics.test.ts` (M2, suite `diagnostics`, workspace `broken`, the socket
  transport chosen in the suite's user settings) — the diagnostics of `Bad.idr` (one Error at (3,6)–(3,11)), `Warn.idr` (one
  Warning), `Mixed.idr`, `UsesBad.idr`, `Err.lidr` (file columns), `ErrMd.idr.md` and
  `bad-ipkg/Main.idr` (the `.ipkg` error at 1-based 3:1), with the status texts; Stop Backend
  (this project, all projects: no process left, checked with `/bin/ps` except on Windows),
  Check File, a second fake compiler in `idris2Path` restarting the session with it (it logs
  its own command lines, so the test sees that it ran, and Check File's load is dispatched to it
  and answered), Restart Backend (a `:load-file` is sent
  to the new process); every contributed command registered, `idris2.allowFolder` the only
  internal one; the resource limits (ROADMAP §9 Q21) in VS Code: `maxSessions` 1 with the loose
  root and `bad-ipkg/` (the idle loose session evicted when the project's file is checked as the
  active file, `Bad.idr` keeping its error and status, its next save starting it again and
  evicting the other), and `maxBackgroundChecks` 1 with the Output panel focused and three roots
  visible (the Output panel is the active editor, a document of scheme `output`; the checks'
  active document stays the last Idris file, `bad-ipkg/Main.idr`; after Restart Backend the two
  background files, `Bad.idr` and `warnings/Deprecated.idr` in the loose roots `broken/` and
  `broken/warnings/`, are sent one after the other — the second not before the first is answered,
  read from the sessions' state changes — and `Main.idr`'s check completes; whether it went before
  the second background load is timing there, and the unit tests pin it). The first shows `Bad.idr` again in the
  editor group that holds `Main.idr`: in the other group it did not become
  `window.activeTextEditor` while the test window had no OS focus.
- `loose-stdio/stdio.test.ts` (M2, suite `loose-stdio`, workspace `loose-file`, no transport
  setting: the default, stdio) — `Hello.idr` and `Lit.lidr` checked in their directory with
  `--ide-mode`; the workspace's `.vscode/settings.json` asks for the socket and is ignored (the
  setting is read from user settings only; a resource-scoped key in the same file shows that VS Code
  read it), and no fake compiler runs with `--ide-mode-socket`; `idris2.ideMode.loosePackages`
  restarts the session with `-p`.
- `consent/consent.test.ts` (M2, suite `consent`, workspace folder `simple-ipkg/src`) — opening
  `Foo/B.idr` asks once about the package directory and starts nothing meanwhile; Don't Allow
  (no process, no diagnostics, `not allowed here` with the link Allow…; neither a save nor Check
  File asks again); Allow… asks again, Always Allow
  checks the file and remembers the folder (while the question asked again waits, the status
  reads `checking…` with Allow…); Manage Allowed Folders… revokes it, the session stops (the
  status names the revocation) and the next check asks again, and after Don't Allow no process
  starts and the gate says `denied` at every poll. The test answers through the test API
  (`ConsentGate.respond`), which resolves the question as the buttons do.
- M1 tests changed in M2: `toolchainUi.test.ts` and `path/discovery.test.ts` expect
  `Idris 2 0.8.0 · IDE mode · ✓` once `Hello.idr` is checked (M1: `· syntax only`).
- `path/discovery.test.ts` (M1, suite `toolchain-path`, no toolchain settings, the fake tools'
  directory prepended to `PATH`) — the three tools are found through `PATH`.
- `support.ts` — the test API, polling (`waitFor`, deadline 10 s; a failure message given as a
  function describes the state at the deadline, as `statusText`'s does), and setting a toolchain
  setting then waiting for the rescan it triggers; M2: showing a file, waiting for its
  diagnostics or a status text, the check session of a directory, saving without a change, and
  the fake IDE-mode processes of a workspace (`/bin/ps`; not on Windows); `settled` waits until a
  session is `ready` with no state change for 1 s (after the completion warm-up, which follows a
  load once the session has been idle for 150 ms).
- `terminalRecorder.ts`, `terminalRecorder.mjs` (M1, shared with the e2e suite) — make a Node
  script that records every byte a terminal sends it, and runs nothing, the default terminal
  profile (`terminal.integrated.profiles.<osx|linux|windows>`), then run a command and return
  what it typed once nothing more has arrived for 1.5 s. The profile is set once per suite, with
  one output file that each test deletes first: with a file per test, a terminal opened right
  after the profile changed wrote to the previous test's file (observed once in VS Code 1.139.1;
  see the comment in the file).
- `editor.test.ts` — Enter at the end of a line in untitled `idris2` and `lidr` editors, run
  through `editor.action.insertLineAfter`, which VS Code 1.139.1 implements with the same
  routine as a typed Enter. Like the `type` command, it goes to whichever code editor has text
  or widget focus; unlike `type`, it falls back to the active editor when no code editor has
  focus. Both that fallback and the `chat.disableAIFeatures` setting of `.vscode-test.mjs`,
  which keeps the chat input from holding the focus, are needed; the reasoning is in the file.
  `.lidr` code lines must continue the marker, which fails if the lidr grammar is mapped to
  the language `idris2` again. The suite also covers indentation folding of a `where` block
  (`editor.fold`, then `visibleRanges`; the blank line after the block stays visible only with
  `folding.offSide`), and Ctrl+D inside `?hole` and `x'` (the `editor.wordSeparators` default). VS Code loads a
  language configuration and computes folding ranges asynchronously, so the suite waits
  (deadline 10 s) until each language's Enter rules take effect, and retries the fold.

Conventions already in force:

- mocha's `tdd` interface (`suite` / `test`) everywhere, both on Node and in the Extension Host.
- Unit tests import from `../../src/...` and must not import `vscode`.
- Tests are compiled by `tsc` into `out/` (`npm run compile-tests`); `.vscode-test.mjs` and
  `test:unit` run the compiled `.js` files.
- `.vscode-test.mjs` gives each suite its own profile (`.vscode-test/user-data`,
  `user-data-ipkg`, `user-data-path`, `user-data-diag`, `user-data-stdio`, `user-data-consent`,
  `user-data-e2e`), rewritten before every run so that
  settings a test changes never leak into another suite, and fails early if a profile's IPC
  socket path would reach the 103-character limit (F17 in `docs/ROADMAP.md` §0); the
  protection is the short checkout path. It also passes `--force-disable-user-env`, so the
  Extension Host sees the suite's environment rather than the developer's login-shell `PATH`
  (without it the `toolchain-path` suite did not see the prepended fake-tools directory,
  observed 2026-09-27).
- `.vscode-test.mjs` also writes `{"chat.disableAIFeatures": true}` to each profile's
  `User/settings.json` before each run. The chat input VS Code 1.139.1 builds at startup is a
  code editor, and when the test window starts without OS focus it kept the editor focus, so
  editor commands went to it and the Enter tests failed (observed 2026-09-27; see the comment
  in the file).
- No test may depend on a wall-clock timeout below 1 s (ARCHITECTURE §12). The one deliberate
  exception is the activation bound of 250 ms on the development machine (1,000 ms under CI),
  which the M0 acceptance calls for.
