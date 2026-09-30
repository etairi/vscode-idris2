# IDE-mode transcripts

Sessions of the real compiler's IDE mode, recorded by `scripts/record-transcripts.mjs` (ROADMAP
M2, ARCHITECTURE §12). They are the ground truth for the fake compiler's replay
(`test/fake-idris2`) and for the protocol decoders, and they pin the protocol facts of ROADMAP §0
that each scenario names. `0.8.0/` holds the recordings of the Homebrew `idris2` 0.8.0
(`/opt/homebrew/bin/idris2`, macOS arm64), made on 2026-09-27; the eight M3 scenarios (the last
rows of the table below) on 2026-09-29.

## Recording

```sh
node scripts/record-transcripts.mjs --list            # the scenarios and what each one pins
node scripts/record-transcripts.mjs                   # all of them → test/fixtures/transcripts/<version>/
node scripts/record-transcripts.mjs load-bad plain    # only these
node scripts/record-transcripts.mjs --out /tmp/x      # elsewhere, e.g. to compare another compiler
```

The script needs no VS Code. (ARCHITECTURE §12 planned the refresh as `IDRIS2_RECORD=1` of the
e2e suite; the recordings in this directory were made by this script.)

`IDRIS2=<absolute path>` selects the compiler (default: the first `idris2` on `PATH`); the
version directory is taken from its `--version`. The script runs **one compiler process at a
time** (CLAUDE.md) and kills each process group after 120 s, or when the handshake or a
request's `:return` has not arrived within 60 s. It runs only on macOS and Linux (process groups).

For every scenario it copies the scenario's fixture workspace (without `build/` directories) to a
fresh temporary directory, starts `idris2 --ide-mode` (or `--ide-mode-socket`) there with the
arguments the extension uses — `--no-color --build-dir <session directory>/build/.vscode-idris2`
(`…/.vscode-idris2-eval` for the M3 `eval` session, `backend/ide/types.ts` `SessionRole`), never
`--find-ipkg` (ARCHITECTURE §5.2, D4, D5) — waits for the handshake, sends each request
only after the `:return` of the previous one (ARCHITECTURE §5.1: one request in flight), then
ends the input (closes stdin, or the socket) and waits for the exit. Nothing is written to the
repository except the transcripts; the compiler's `build/` output stays in the temporary copy and
is listed in the transcript. Two runs on the development machine produced byte-identical files
(2026-09-27; for the eight M3 scenarios, 2026-09-29).

A changed fixture must be recorded again: each transcript carries the SHA-256 of the fixture
files it read (`fixtures` below), so a test can detect a stale recording.

## Format

One JSON object per line, UTF-8. The first line is the `meta` object; every other line is one
event, in the order the recorder observed them. There are no timestamps: timing is recorded only
as this order. Events from different streams (the protocol stream, stdout, stderr) are ordered by
arrival at the recorder, which the operating system may interleave differently from run to run;
within one stream the order is exact.

### `meta`

| Field | Meaning |
|---|---|
| `format` | `1` |
| `scenario`, `description`, `facts` | the scenario's name (= file name), what it shows, and the ROADMAP §0 facts it pins |
| `idris2` | `version` (`0.8.0`), `versionText` (the `--version` line), `executable` (a path under the home directory is written `~/…`) |
| `platform`, `recorded` | `process.platform process.arch`, and the local date |
| `transport` | `stdio` (`--ide-mode`) or `socket` (`--ide-mode-socket`) |
| `args` | the compiler's arguments, with placeholders |
| `cwd` | the directory in the repository that `${ROOT}` stands for, relative to the repository root: the session directory (`ProjectIndex.sessionCwd`: the `.ipkg`'s directory, or a loose file's) |
| `processCwd` | the spelling of that directory the process was started in: `${ROOT}`, or `${LINK}` for `load-symlink` |
| `placeholders` | each placeholder that stands for a path, with the length of the path it replaced (see *Prefixes*) |
| `fixtures` | `{ <path relative to cwd>: <sha256 hex> }` of the files the session reads |

### Events

| `kind` | Fields | Meaning |
|---|---|---|
| `send` | `prefix`, `text` | a request frame written to the compiler: `prefix` is the six hex digits as written, `text` the rest (the s-expression and its `\n`) |
| `recv` | `prefix`, `text` | a frame read from the protocol stream (stdout for `stdio`, the socket for `socket`) |
| `unframed` | `text` | bytes of the protocol stream that are not a frame — a frame starts with a reply header: six hex digits, `(` and the head of a reply, `(:return ` … — up to and including the next `\n` (F5: program output and the end-of-input line over stdio), or up to a reply header after it (`exec-stdio-putstr`), also right after one or two hex digits (`exec-stdio-putstr-digit`: `7000015(:return …` is `7`, then a frame); at the end of the stream, an incomplete rest. The extension's decoder (`src/backend/ide/wire.ts`) reads headers of seven and eight digits too; the two rules differ only for replies of 0x1000000 code points or more, which no recording contains |
| `stdout` | `text` | a line of the process's stdout outside the protocol stream (socket transport only; the first one is the port, recorded as `${PORT}\n`) |
| `stderr` | `text` | a line of the process's stderr (none occurs in the 0.8.0 recordings) |
| `socket-end` | — | the compiler closed the socket |
| `socket-error`, `spawn-error` | `text` | a socket or spawn error (none occurs in the 0.8.0 recordings) |
| `close` | — | the recorder ended the input: closed stdin (`stdio`) or its end of the socket (`socket`) |
| `exit` | `code`, `signal` | the process ended |
| `files` | `written` | files below the workspace copy that the session created or changed, relative to `${ROOT}` and sorted |

A text that is not valid UTF-8 would be stored as `base64` instead of `text`; none occurs in the
0.8.0 recordings. A `text` ending without `\n` is a stream's last, unterminated line.

### Placeholders

| Placeholder | Stands for |
|---|---|
| `${ROOT}` | the real path (`realpath`) of the session directory in the temporary copy; it corresponds to `cwd` in the repository |
| `${LINK}` | `load-symlink` only: a symbolic link to `${ROOT}`, which the process was started in |
| `${PORT}` | the TCP port the compiler printed (socket transport) |

Only these exact spellings are replaced. The recorder refuses to write a transcript that still
contains the temporary directory in any other spelling (such as `/tmp` for `/private/tmp` on
macOS), the repository's path or the home directory, and one where the compiler printed `${`.
Other paths stay as the compiler wrote them: `:name-at` of a name from an installed package
answers the absolute path of its source in the compiler's installation
(`/opt/homebrew/Cellar/idris2/0.8.0_2/libexec/idris2-0.8.0/…` in `shapes-lookups` and
`clean-queries`), which is the recording machine's.

### Prefixes

A request's prefix counts the **UTF-8 bytes** of its text (F1); a reply's prefix counts the
**code points** of its text (F1 addendum). Both are stored as they were on the wire, for the text
with the real paths in it. To check a prefix, replace each placeholder by any ASCII string of the
length that `meta.placeholders` gives for it and count the bytes (`send`) or code points
(`recv`); the recorder checks every frame this way before it writes the file. The recorded paths
are padded to 128 characters, so that the request prefixes do not depend on the recording
machine's temporary directory.

A replay that substitutes its own paths for the placeholders must compute the prefixes of the
substituted texts by the same two rules. Ids appear only inside the texts, as the last element of
`(<command> <id>)` and of each reply.

## Scenarios (0.8.0)

Fixture workspaces are under `test/fixtures/workspaces/`. Every session uses the stdio transport
unless the table says `socket`; the frames of 13 of the scenarios were also recorded over the
socket on 2026-09-27 and were identical (the recordings kept are the stdio ones).

| Scenario | Workspace (`cwd`) | Requests | Pins |
|---|---|---|---|
| `handshake` | `loose-file` | `:version` (bare), `((:version) 2)`, `(:cd "/tmp")`, an unparsable `((:version 4`, `:version`; end of input | F4 (previous id), F5 (`Alas…`, exit 1) |
| `handshake-socket` | `loose-file`, socket | `:version`; the client closes | F5 (port line, `Alas…` on stdout) |
| `load-bad` | `broken` | `Bad.idr` | F6: one `:warning` at (3 6)–(3 11), then `:error` |
| `load-warn` | `broken` | `Warn.idr` twice | F7: one `:warning` and `:ok`; the reload has no `Building` and no `:warning`, but highlighting |
| `load-mixed` | `broken` | `Mixed.idr` | F7: a warning and an error, both `:warning` frames, then `:error` |
| `load-part` | `broken` | `Part.idr`, `:missing g`, `:type-of "main" 7 0`, `:type-of "main"` | F6 (`Missing cases:`), F15, F16 |
| `load-uses-bad` | `broken` | `UsesBad.idr` | a `:warning` for the imported `Bad.idr` |
| `load-switch` | `broken` | `Bad`, `Warn`, `Bad`, `Warn` in one session | F7 across files: a failed file is built and reported again, a fresh one is not |
| `load-symlink` | `broken`, started in `${LINK}` | `Clean.idr` through the link, by real path, relative | the absolute path through the link is refused |
| `load-bad-ipkg` | `broken/bad-ipkg` | `Main.idr` | F10: `:error` with `"bad.ipkg":3:1--3:5`, no `:warning` |
| `load-simple-ipkg` | `simple-ipkg` | `src/Foo/B.idr` twice | F12, F13, F32: TTC files under `build/.vscode-idris2`; F7 reload |
| `load-builddir-ipkg` | `builddir-ipkg` | `src/Hello.idr` | F12: `builddir = "out"` overrides `--build-dir` |
| `load-loose` | `loose-file` | `Hello.idr` | a loose file importing `Data.Vect` |
| `load-lidr` | `broken` | `Err.lidr`, `:type-of "n" 4 2`, `:type-of "n" 4 4` | F11: unlit reply columns; positional lookups after a failed load |
| `load-lit` | `loose-file` | `Lit.lidr`, `:type-of "n" 6 7`, `:type-of "n" 6 9` | F11: requests take unlit columns |
| `load-md` | `broken` | `ErrMd.idr.md` | F11: fenced Markdown, exact columns |
| `clean-lookups` | `broken` | `Clean.idr`, `:type-of "xs" 8 4/5/7/8`, `:type-of "vlen"`, `:docs-for "id"` (plain, `:full`, `:overview`), `:name-at` unqualified and qualified, `:metavariables 80`, reload with a line argument | F2, F7, F30, F31, F33 |
| `clean-editing` | `broken` | `Clean.idr`, `:case-split 8 0/1/8/9 "xs"`, `:add-clause`, `:make-lemma`, `:make-with`, `:make-case`, `:proof-search` + two `-next` + `:all`, `:generate-def` + two `-next`, `:intro`, `:refine` | F2, F29, F30, F31 |
| `ambig-refine` | `broken` | `Ambig.idr`, `:refine 14 "g_rhs" "foo"` | F29: the ambiguity error |
| `plain` | `broken` | `Plain.idr`, `:case-split 5 0 "n"`, `:printdef f`, `:docs-for "f"` (non-ASCII reply), `(:interpret "\"→\"")`, `(:bogus "é")` | F1 (both directions), F15 |
| `stubs` | `broken` | the eleven stub commands | F3 |
| `enable-syntax` | `broken` | `(:enable-syntax :False)`, `Clean.idr` | F14: no `:highlight-source` frame |
| `load-logging` | `broken` | `Logging.idr` (a `%logging "declare.def" 3` pragma) | F5 addendum: the compiler's `LOG` lines and an empty line unframed between the frames of the load |
| `exec-stdio` | `loose-file` | `:exec putStrLn "hi"` | F5: `hi` unframed in the protocol stream |
| `exec-stdio-putstr` | `loose-file` | `:exec putStr "hi"` | F5 addendum: `hi` without a newline, and the `:return` right after it on the same line (`hi000015(:return …)`) |
| `exec-stdio-putstr-digit` | `loose-file` | `:exec putStr "7"`, `:exec putStr "ab"` | F5 addendum: hex digits without a newline run into the next header (`7000015(:return …`, `ab000015(:return …`) |
| `exec-socket` | `loose-file`, socket | the same | F5: `hi` on the process stdout |
| `warning-parser`, `-shadow-global`, `-shadow-local`, `-visibility`, `-deprecated`, `-generic` | `broken/warnings` | the file of that warning kind | E5, F28: each warning kind arrives as `:warning` with `(:return (:ok ()))` |
| `warning-ipkg-deprecated` | `broken/warnings/old-version` | `Main.idr` twice | E5: the `.ipkg`'s deprecation warning, sent at every load, before `Building` |
| `shapes-lookups` | `simple-ipkg` | `src/Foo/Shapes.idr`; positional `:type-of` at 16 occurrences of globals (declarations, definitions, uses, operators) and at the start of each of the 37 `:bound` tokens of its highlighting; `:type-of` by name (7 names, one a local); `:docs-for` (10 names: with and without docs, a constructor, the type, an interface and its method, an operator, `pi`, an unknown name); `:name-at` (6); `:browse-namespace` of `Foo.Shapes`, `Data.Vect` (not imported) and `Nope.Nothing`; `:repl-completions` of `ar`, `Ci`, `\|+` | M3: the decorations of the semantic-tokens acceptance (`Circle` `:data`, `area` `:function`), `:namespace` of references (the defining module); a positional `:type-of` of the interface parameter on its header answers `Undefined name`; the shapes of `:docs-for`, `:name-at` (from the doc comment or visibility to the end of the signature; a method's is its name) and `:browse-namespace` |
| `simple-ipkg-lookups` | `simple-ipkg` | `src/Foo/B.idr`; positional `:type-of` of `greeting` (declaration and definition) and of `shout`; `:name-at` of `shout` (in `src/Foo/A.idr`) and `greeting`; `:docs-for` of both; `:browse-namespace "Foo.A"`; `:repl-completions` of `sh`, `gr`; then `src/Foo/A.idr` (its TTC is fresh: no `Building`, F7) and positional `:type-of` there | definition across modules; completions repeat names (`show` 24 times) |
| `clean-queries` | `broken` | `Clean.idr`; positional `:type-of` at the start of its 10 `:bound` tokens; `:repl-completions` of `vl`, `vlen`, `Data.V`, `?`, `vlen_` and `""`; `:name-at` of `vlen`, `index`, `id`, `Vect`, `::`; `:browse-namespace` of `Data.Vect`, `Clean`, `Nope.Nothing`; `:docs-for` of `Vect`, `::`, `vlen`; `:type-of` by name of `xs` and `index`; positional `:type-of` of `Vect` and of the hole `vlen_rhs` | the completion context (`Data.V` → `("Vect" "Void" "View")` and `"Data."`) and the prefixes it cannot complete; `:name-at` into the installed sources, one entry per overloaded name; a private name is not browsed, a hole is (with its multiplicity); a hole's `:type-of` is its goal |
| `unicode-columns` | `broken` | `Unicode.idr`; positional `:type-of` at every column from 0 to one past the UTF-8 length of lines 12, 15, 18 and 21 (one name per line), and of `x₁` at its two starts; `ℕ` positionally, `α` by name; `:name-at` of `α` and `commented`; `:docs-for "ℕ"`; `:repl-completions "α"` (non-ASCII text as decimal escapes) | E14: request and reply columns count code points (not UTF-8 bytes, UTF-16 units or graphemes); a positional `:type-of` answers for the local at the column whatever name it asks for (F2); F1 (non-ASCII in both directions) |
| `lit-lookups` | `loose-file` | `Lit.lidr`; positional `:type-of` of `double`, `+` and the three `n` at unlit columns; `:name-at`, `:docs-for` of `double`; `:browse-namespace "Lit"`; below its `> ` and `>   ` lines (re-recorded 2026-09-29, second review of M3): positional `:type-of` of `glue`, `bump` and their `:bound` tokens, of `++` in `xs++ys` and `+` in `n+1` at their start and one column further, `++` by name, `:docs-for` of `glue` and `++`, `:name-at` of `glue` and `bump` | F11: `:name-at` answers unlit columns too; a private name is not browsed; F11 addendum: a marker followed only by white space is two lines of the unlit text (`glue` on file line 7, 0-based, is the compiler's line 8, `bump` on 10 its 12); at the start of an operator right after a local the local answers (`xs : List Nat`), one column further the operator |
| `eval-values` | `broken`, the `eval` session's build directory | `Clean.idr`; `:interpret` of `the (Vect 2 Nat) [1, 2]` (and `[1,2]`), `"hi" ++ "!"`, `vlen`, `the (Nat -> Nat) (\x => x + 1)`, `putStrLn "hi"`, `the (IO ()) (putStrLn "hi")`, `vlen [1, 2]`, `the Nat "x"`, `nope`, `:t id` | ROADMAP §9 (2026-09-28): an IO action is normalised, not run (`MkIO (prim__putStr "hi\n")`; nothing unframed in the stream); `putStrLn "hi"` alone is an error (no `HasIO` implementation chosen); `:interpret` runs REPL commands |
| `eval-command-forms` | `broken`, the `eval` session's build directory | `Clean.idr`; `:interpret` of `:t id` behind each of space, tab, CR, LF, VT, FF, U+00A0, U+3000, U+200B, U+FEFF, behind `{- c -}`, `-- c` and a line break, `\|\|\| d` and a line break; as `: t id`, with U+FF1A for the colon, as `:T id`; of `""`, three spaces and `-- c` | which texts the REPL parser reads as a command (the refusal of the `eval` session, `backend/ide/replCommand.ts`) |
| `eval-socket` | `broken`, the `eval` session's build directory, socket | `Clean.idr`, `:interpret` of `the (IO ()) (putStrLn "hi")` | F5: nothing is printed on the process stdout either |
