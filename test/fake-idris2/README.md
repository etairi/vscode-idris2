# `test/fake-idris2`

A Node script that stands in for the `idris2` binary, so that tests can drive the IDE protocol
without a compiler (`docs/ARCHITECTURE.md` §12, decision D15). It needs only Node (no
dependencies) and runs on every CI runner.

```sh
node test/fake-idris2/fake-idris2.mjs --version            # Idris 2, version 0.8.0
node test/fake-idris2/fake-idris2.mjs --ide-mode           # IDE protocol on stdin/stdout
node test/fake-idris2/fake-idris2.mjs --ide-mode-socket [host:port]
```

Any other command line is rejected with exit code 2 and a message on stderr naming the
arguments. The real compiler would accept many of them, so the fake does not pretend to be the
real compiler's `Error: Unknown flag …` (stderr, exit 1).

## What M0 implements

The **handshake and the `version` command**, over stdio and TCP. Anything else that parses as an
s-expression is answered the way the compiler answers a request it cannot interpret. The unit
test is `test/unit/fakeIdris2.test.ts`.

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
- Clients that connect after the first socket client: the fake never reads from them (the real
  compiler calls `accept` once); not compared with the real compiler.

## Intended for M2: transcript replay (not implemented)

M2 turns the fake into a replayer of sessions recorded from the real compiler by the e2e suite
(`IDRIS2_RECORD=1`, ARCHITECTURE §12). The plan below is a proposal that M2 may revise. The code
already has the seam: `createSession(send)` returns `{ start, receive }` and knows nothing about
transports, so a replaying session can replace it in both `serveStdio` and `serveSocket`.

- **Location.** `test/fixtures/transcripts/<idris2-version>/<name>.jsonl`, one JSON object per
  line.
- **First line.** `{"kind":"meta","idris2":"0.8.0","commit":"15a3e4e","transport":"socket",
  "args":[…],"cwd":"<fixture workspace, relative>","recorded":"<ISO date>"}`.
- **Other lines, in wire order.**
  - `{"kind":"request","text":"((:load-file \"Bad.idr\") 1)\n"}`
  - `{"kind":"reply","text":"(:return (:ok ()) 1)\n"}`: a frame's text without its prefix. The
    fake recomputes the prefix with the compiler's rule (code points), and the recorder asserts
    that the recorded prefix equals that count.
  - `{"kind":"stdout","text":"hi\n"}`: unframed process output (F5).
- **Replay.** The fake is selected with an environment variable naming the transcript. It sends
  every `reply`/`stdout` line up to the first `request`. After that, each incoming request must
  equal the next `request` line, and the replies up to the next `request` are sent back. A
  mismatch is a test failure, reported as a `:return :error` whose text names the expected
  request. Ids are replayed as recorded, so a test must send the recorded ids.
