# `test/fake-idris2`

A Node script that stands in for the `idris2` binary, so that tests can drive the IDE protocol
without a compiler (`docs/ARCHITECTURE.md` §12, decision D15). It needs only Node (no
dependencies) and runs on every CI runner.

```sh
node test/fake-idris2/fake-idris2.mjs --version            # Idris 2, version 0.8.0
node test/fake-idris2/fake-idris2.mjs --ttc-version        # M1: recorded output
node test/fake-idris2/fake-idris2.mjs --paths              #   "
node test/fake-idris2/fake-idris2.mjs --list-packages      #   "
node test/fake-idris2/fake-idris2.mjs --dump-ipkg-json [file.ipkg]   # M1: recorded, per fixture
node test/fake-idris2/fake-idris2.mjs --ide-mode           # IDE protocol on stdin/stdout
node test/fake-idris2/fake-idris2.mjs --ide-mode-socket [host:port]
# M2: with the options of a session's command line (ARCHITECTURE §5.2), in any order
node test/fake-idris2/fake-idris2.mjs --ide-mode-socket --no-color -p contrib --build-dir <dir>
```

`--no-color`, `-p`/`--package <pkg>` and `--build-dir <dir>` are accepted next to either IDE
mode and ignored (the replies come from the transcripts, whatever packages or build directory
their recording used). Any other command line — including `--find-ipkg`, which the extension
must never pass (F13), and two IDE modes at once — is rejected with exit code 2 and a message on
stderr naming the arguments. The real compiler would accept many of them, so the fake does not
pretend to be the real compiler's `Error: Unknown flag …` (stderr, exit 1). Tests start it
through the launchers in `test/fake-tools/bin`, and its fault modes (`FAKE_IDRIS2_MODE`,
`FAKE_IDRIS2_DELAY_MS`, `FAKE_IDRIS2_VERSION`) are described in `test/fake-tools/README.md`.

| Variable | Effect |
|---|---|
| `FAKE_IDRIS2_TRANSCRIPTS=<dir>` | IDE mode replays the transcripts in `<dir>` ("Transcript replay" below); `.vscode-test.mjs` sets it to `test/fixtures/transcripts/0.8.0` for every fake-tool suite. Unset: the M0 behaviour below |
| `FAKE_IDRIS2_IDE_FAULT=<fault>@<n>[,…]` | injects a protocol fault at the n-th request ("Injected protocol faults" below) |
| `FAKE_IDRIS2_LOG=<file>` | every invocation first appends `{"pid", "args", "cwd"}` as one JSON line to `<file>` (like `FAKE_PACK_LOG`), so a test can see which command lines were started, and how often |

## Recorded command-line output (M1)

`recorded-cli-0.8.0.json` holds what the real compiler printed for the toolchain probes, and
the fake prints it back byte for byte:

- `--version`, `--ttc-version`, `--paths`, `--list-packages`: one run each of
  `/opt/homebrew/bin/idris2` (Homebrew `idris2` 0.8.0_2, macOS arm64) on 2026-09-27, with stdout
  not a terminal, from an empty directory; every run exited 0 with nothing on stderr. `--paths`
  prints the working directory (twice); the recording has `{{cwd}}` there and the fake puts its
  own working directory in. The Homebrew paths in `--paths` and `--list-packages` are the
  development machine's. `--list-packages` also lists the packages in `<cwd>/depends`
  (`findPackages`, `src/Idris/SetOptions.idr` on v0.8.0) [src]; the fake does not.
- `--dump-ipkg-json`: one entry per fixture ipkg, keyed by the SHA-256 of the file's bytes. The
  fake answers only for a file whose hash has a recording and exits 2 otherwise, so a changed
  fixture fails loudly instead of being answered with stale output; `test/unit/fakeTools.test.ts`
  checks every recorded hash against its fixture. Without a file argument the fake uses the only
  `.ipkg` of the working directory, as `localPackageFile` does (`src/Idris/Package.idr` 937–946 on
  v0.8.0); a file without the `.ipkg` extension gets the compiler's `Packages must have an
  '.ipkg' extension: "<file>".` (stdout, exit 1, `processPackage`). As in the compiler, whose
  argument is `Optional` (`src/Idris/CommandLine.idr` 291, 483–486), an argument that starts
  with `-` is not the file; what the compiler then prints (for `-x.ipkg`, its list of options
  that may override package options, exit 0 [live, M1 review]) is not mirrored: the fake exits 2
  as for any argument list it does not implement.

To record a fixture again, run `timeout 120 idris2 --dump-ipkg-json <file>.ipkg` once in the
fixture's directory (one compiler process at a time, CLAUDE.md), and replace the entry's
`stdout`, `sha256` (`shasum -a 256 <file>.ipkg`) and `recorded` date.

## What M0 implements

The **handshake and the `version` command**, over stdio and TCP (M1 lets `FAKE_IDRIS2_VERSION`
set the version the command reports). Without `FAKE_IDRIS2_TRANSCRIPTS`, anything else that
parses as an s-expression is answered the way the compiler answers a request it cannot
interpret. The unit test is `test/unit/fakeIdris2.test.ts`.

Everything below mirrors Idris 2 **0.8.0** (`15a3e4e`, the Homebrew build on the development
machine). The code cites the source file behind each rule. The relevant files (`IDEMode/REPL.idr`
`getInput`/`loop`, `IDEMode/Commands.idr` `send`/`getMsg`, `Protocol/SExp*.idr`,
`Parser/Support/Escaping.idr`) are identical on master `1c630e6` apart from imports. Master was
compared by reading its source only; the live runs used 0.8.0.

| Behaviour | Real compiler, 0.8.0 |
|---|---|
| `--version` | prints `Idris 2, version 0.8.0\n` and exits 0 |
| Start of a session | `000018(:protocol-version 2 1)\n` |
| `(:version ID)` | `(:return (:ok ((0 8 0) (""))) ID)`. `version` is a bare symbol, so `((:version) ID)` is an unrecognised command (F4). ID is an arbitrary-precision integer: `99999999999999999999` is echoed unchanged. |
| A well-formed s-expression that is not a command | `(:return (:error "Unrecognised command: <show sexp>") PREV)` (F4). PREV is the id of the last *recognised* request, or 0 before the first one. The echo is the compiler's re-serialisation: whitespace is normalised, string escapes are decoded and then re-escaped (only `\` and `"`), `:True`/`:False` are booleans, `0012` becomes `12`, and every CR or CRLF becomes LF. |
| Input that is not an s-expression | `(:return (:error "Parse error: …") PREV)`. **Only the `Parse error: ` prefix and the id are mirrored.** The rest is the fake's own reason, marked `(fake-idris2)`, not the compiler's rendered parse error with its source excerpt and highlighting. |
| End of input (stdin EOF, or the socket client closes) | prints `Alas the file is done, aborting\n` unframed on the process stdout and exits 1 (F5) — unless the unread tail ends *exactly one read* past the end, see below |
| End of input in the middle of a request | exits 0 silently, without answering that request, when the unread tail is an unframed line without its newline (six bytes that are not all hex digits and no newline after them, e.g. `(:version 1)`), exactly 5 bytes (e.g. `00000`), or a framed request one byte short (`00000d(:version 1)`). Any other tail, including an empty one or a frame two or more bytes short, gets the end-of-input line and exit 1. Why: C stdio lets one `fgetc` go past the end before `feof` turns true; `getChar` tests `fEOF` before reading, `loop` tests it after `getInput` and returns (`IDEMode/REPL.idr` 78–115, 462–476 on v0.8.0; `idris2_eof` is `feof`, `support/c/idris_file.c` 179). |
| The socket client resets the connection | prints `Failed to read a character\n` unframed on the process stdout and exits 1: `fgetc` fails, `fGetChar` returns `Left` (it tests `ferror`), and `getChar` reports it (`IDEMode/REPL.idr` 85–87 on v0.8.0). Observed on 0.8.0 (macOS arm64, 2026-09-27) for a reset while idle after the handshake, after a partial header (`00001`, `(:ver`), in an unframed line (`(:version 1`) and in a frame's payload (`00000a((:vers`). |
| `--ide-mode-socket` | binds IPv4 `127.0.0.1` (`localhost`) on port 0 by default. It prints the port in decimal followed by `\n` on stdout (for example `59355\n`) and nothing else, accepts one client, and only then sends the handshake on the socket. The optional `host:port` argument is taken when the next argument does not start with `-`. An unparsable port means port 0. |

The end-of-input rows were compared on 2026-09-27: 23 stdio inputs (the ten in the unit test
plus partial headers, partial frames, unframed lines cut off at several points and a line ending in a bare `\r`)
gave byte-identical stdout and the same exit code, except `000000` (an empty frame), whose
parse-error text is not mirrored; six of them over the socket gave the same socket stream,
process stdout and exit code.

The fake and the real compiler were given the same 22 stdio requests: unknown commands, strings
using every escape form (including NUL and invalid code points), non-ASCII text, whitespace
variants, an uppercase-hex header, an unframed line and very large ids. The two stdout byte
streams were identical: the handshake, 22 replies and the end-of-input line. Parse errors were
kept out of that battery because their text is not mirrored. The socket stream and the process
stdout of a 4-request socket session were identical too, apart from the port number. These
comparison scripts are not in the repository; the unit test pins the representative cases.

## Framing: requests and replies use different units

This finding is new here. It refines F1 in `docs/ROADMAP.md` §0, which checked only the request
direction.

- **Requests.** The compiler reads one `Char` per **byte** (`getNChars` → `fGetChar`), so the
  prefix of a request is its UTF-8 byte length, as F1 says. It also means that the compiler sees
  non-ASCII request text **byte by byte, as Latin-1**. `((:bogus "é") 4)` is echoed as `"Ã©"`,
  and `((:type-of "α") 2)` on a file that defines `α` answers `Undefined name Î±` [live].
- **Replies.** `send` writes `leftPad '0' 6 (asHex (length r))`. `length` is the Idris `String`
  length, which counts **Unicode code points**, while the text itself goes out as UTF-8. Here are
  the live measurements on 0.8.0, over both stdio and the socket:

  | Reply | Prefix | UTF-8 bytes |
  |---|---|---|
  | `:docs-for` on a doc comment containing `→` | 245 | 247 |
  | the same with `𝕟` (U+1D55F, outside the BMP) | 185 | 188 |

  The second row rules out UTF-16 units, which would have given 186. A client that cuts reply
  frames by bytes desynchronises on the first non-ASCII reply.
- `fPutStr` stops at the first NUL even though the prefix counted the whole string. A reply that
  contains a NUL (for example the echo of `"\0"`) is therefore truncated, and the stream
  desynchronises. Numeric escapes that are not valid code points (surrogates, > U+10FFFF) become
  NUL (`cast-int-char` in `support/chez/support.ss`), and the same thing happens to them.

The fake reproduces all three.

## Not mirrored

- The text of parse errors (see the table).
- Numeric string escapes whose value exceeds 2^53. Idris goes through a 64-bit `Int`, and its
  overflow behaviour was not investigated.
- **Requests pipelined on the socket.** The real compiler `fdopen`s the accepted socket once
  in mode `r+` and uses the same `FILE` for reading requests and writing replies
  (`socketToFile`, `IDEMode/REPL.idr` 42–47). On macOS, writing a reply discards whatever the
  stream had already buffered for reading, so a request that arrived in the same read as an
  earlier one is lost without a reply. Observed on 0.8.0 (macOS arm64, 2026-09-27): writing
  `00000c(:version 1)00000c(:version 2)` in one socket write is answered for id 1 only, and a
  `(:version 3)` written 1.5 s later is answered normally; the same bytes on stdio get both
  replies. The mechanism is inferred from the observation and the shared `r+` stream, not read
  in libc's source; Linux was not tried. The fake answers every request, so a client must not
  pipeline requests on the socket and tests cannot catch it if it does.
- Clients that connect after the first socket client: the real compiler calls `accept` once, and
  its listening socket stays open, so a later connection completes in the listen backlog and
  receives nothing (0 bytes in 3 s after connecting second [live, 0.8.0, ROADMAP M2 As built
  *Transport*]). The fake completes such a connection too — Node accepts it — and never reads
  from it or writes to it (`serveSocket`), so the client sees the same: a connection and no
  bytes. Not modelled: the backlog's limit on how many such connections complete.

## Transcript replay (M2)

With `FAKE_IDRIS2_TRANSCRIPTS=<dir>`, IDE mode answers from the sessions recorded from the real
compiler in `<dir>` (`test/fixtures/transcripts/<version>/*.jsonl`, written by
`scripts/record-transcripts.mjs`; the format is in that directory's README). The fake reads every
transcript when it starts and exits 2, before the handshake, if the directory cannot be read,
holds no transcript, or a transcript cannot be replayed (not format 1, or an event other than a
frame or program output between the first request and the recorder's `close`, such as a crash
`exit`). The handshake, `:version`, the framing rules, the end-of-input behaviour and the socket
rules above stay the fake's own; everything else is replayed:

- **Matching.** A request is compared with the recorded requests after two normalisations: the
  id is set aside (`(COMMAND ID)` is compared by `COMMAND`), and every string that is a path in
  the working directory — the real path, or the spelling the process was started with, compared
  case-insensitively and with either separator on Windows — is written `${ROOT}/…`; a path that
  reaches the working directory through a symbolic link is written `${LINK}/…` (transcript
  `load-symlink`). Requests are compared as the compiler reads them, one character per byte (F1
  addendum), and an unparsable request by its text.
- **Which recording.** Only scenarios whose fixture files (`meta.fixtures`, relative to the
  working directory) have the recorded SHA-256 *now* are eligible, so an edited or unrelated
  file is never answered with a stale reply, and two scenarios with the same request (for
  example `Main.idr` under `bad-ipkg/` and under `warnings/old-version/`) are told apart by their
  files. Among the recorded requests that match, the one whose recorded predecessors equal the
  longest run of this session's latest requests wins; ties go to a request whose whole recorded
  prefix matched (a session replayed from its start), then to the first scenario by name, then
  to the earlier request. So a session that repeats a recording gets exactly the recording, and
  one that does not gets the reply recorded after the most similar history: loading `Bad`,
  `Warn`, `Warn` (never recorded together) gives the third load `load-warn`'s reload — no
  `Building` line, no `:warning` (F7). Compiler state that no transcript recorded (a file built
  in another order, `:enable-syntax` followed by another file) is therefore approximated, not
  modelled.
- **Replies.** The recorded group — every frame and the program output up to the next recorded
  request — is sent with the paths spelled as this session spelled them (the separator after the
  root included) and each frame's prefix recomputed (code points, F1 addendum). A reply's id is
  the live request's id where the recording had the recorded request's id, and otherwise the
  session's previous recognised id (F4: the compiler's only other choice; every reply of the
  0.8.0 recordings is one of the two). Program output goes where the compiler sends it for this
  transport (F5): into the protocol stream over stdio, to the process stdout over the socket, so
  a stdio recording also replays over the socket. It is written with the reply it was recorded
  in, also over the socket, where the real compiler's stdout is a block-buffered pipe: its log
  lines (`load-logging`) arrive only when it exits (F5 addendum); that timing is not mirrored.
- **No recording.** A request no eligible scenario matches is answered `(:return (:error
  "fake-idris2: no recorded reply for <normalised command>") ID)` — with the request's own id,
  so that the client's pending request ends instead of waiting, or with the id of the last
  recognised request for an unparsable one (F4) — and the same text goes to stderr as one line. This is not compiler
  behaviour: it makes a test that sends something unrecorded fail with a message that names it.
  Record the scenario (`npm run record:transcripts`, one compiler process at a time) instead of
  writing replies by hand.

`test/unit/fakeIdris2Replay.test.ts` replays every transcript over both transports (ids shifted,
through a symbolic link where the recording used one) and compares each item of the stream, the
program output, the end of input and the exit code with the recording; it also checks that every
fixture file a transcript read still has its recorded SHA-256. The e2e test
`test/e2e/fakeParity.test.ts` gives the real compiler and the fake the same bytes for three
scenarios over both transports and for `load-logging` over stdio, and requires identical
streams, prefixes included.

Not replayed: `stderr` events (none in the 0.8.0 recordings), timing (replies are written at once;
use `FAKE_IDRIS2_IDE_FAULT=hang@n` for a request that never returns), and the files the compiler
writes (`files` events; no TTCs appear).

## Injected protocol faults

`FAKE_IDRIS2_IDE_FAULT` is a comma-separated list of `<fault>@<n>`: the n-th request the process
receives (1-based, every request counts, `:version` too) triggers the fault. Each process counts
from 1, so `crash@1` makes every restarted session crash on its first request too (a test of the
give-up rule). With or without transcripts. Any other value exits 2 before the handshake.

| Fault | Effect |
|---|---|
| `crash` | no reply; `fake-idris2: simulated crash at request n (FAKE_IDRIS2_IDE_FAULT)` on stderr; exit 3 |
| `crash-in-reply` | the first 29 bytes of a reply frame of 64 code points, `000040(:write-string "partial`, in the protocol stream (over the socket too), then `fake-idris2: simulated crash inside a reply at request n (FAKE_IDRIS2_IDE_FAULT)` on stderr, then exit 3: a process that dies in the middle of a reply (the extension reports the exit with the incomplete frame) |
| `hang` | no reply and no further reading, not even of the end of input; exits 1 after `FAKE_TOOL_HANG_LIMIT_MS` (default 60,000 ms) like `FAKE_IDRIS2_MODE=hang`, so a process a test failed to kill does not outlive the run |
| `noise` | the unframed line `fake-idris2: injected noise (FAKE_IDRIS2_IDE_FAULT)` in the protocol stream (over the socket too) before the replies; the extension logs it as the process's output over stdio and treats it as a protocol error on the socket, where the compiler writes only frames |
| `id-mismatch` | the request's `:return` carries its id plus 1000000 (the other frames keep theirs) |
