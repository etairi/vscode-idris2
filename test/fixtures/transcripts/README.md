# IDE-mode transcripts

Sessions of the real compiler's IDE mode, recorded by `scripts/record-transcripts.mjs` (ROADMAP
M2, ARCHITECTURE §12). They are the ground truth for the fake compiler's replay
(`test/fake-idris2`) and for the protocol decoders, and they pin the protocol facts of ROADMAP §0
that each scenario names. `0.8.0/` holds the recordings of the Homebrew `idris2` 0.8.0
(`/opt/homebrew/bin/idris2`, macOS arm64), made on 2026-09-27; the eight M3 scenarios (from
`shapes-lookups` to `eval-socket` in the table below) on 2026-09-29; the M4 scenarios (from
`clean-split-columns` on, 23 recordings) on 2026-09-30.

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
(2026-09-27; for the eight M3 scenarios, 2026-09-29; for the first fifteen M4 recordings,
2026-09-30). The eight added during M4's reviews (`edits-layout`, `lit-indent-editing`,
`edits-blocks`, `dup-holes`, `edits-same-name`, `edits-impossible`, `edits-case-words`,
`edits-shadowing`) were recorded again on 2026-09-30 and matched byte for byte except the
`executable` field (the path of a time-limit wrapper). Every recording here names
`/opt/homebrew/bin/idris2` as its `executable`: `clean-lookups` and `edits-shadowing`, first made
through such a wrapper, were recorded again with it at the end of M4's ninth review and matched
byte for byte apart from that field.

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
| `clean-lookups` | `broken` | `Clean.idr`, `:type-of "xs" 8 4/5/7/8`, `:type-of "vlen"`, `:docs-for "id"` (plain, `:full`, `:overview`), `:name-at` unqualified and qualified, `:metavariables 80`, reload with a line argument; `:name-at "append"` (added and re-recorded in M4, 2026-09-30) | F2, F7, F30, F31, F33; M4: a declaration without clauses, which `:metavariables` lists, has the whole declaration as its `:name-at` span |
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
| `clean-split-columns` | `broken` | `Clean.idr`, `:case-split 8 C "xs"` for C = 2–7 | F2: with `clean-editing`'s columns, every column from 0 to 8 (the end of `vlen xs`) splits, 9 does not |
| `plain-split-columns` | `broken` | `Plain.idr`, `(:metavariables 80)`, `:case-split 5 C "n"` for C = 1–5 | F15: `No clause to split here` at every column (the compiler keeps a clause's left-hand side for splitting only when its right-hand side is a hole, `TTImp/ProcessDef.idr` 516–521 on v0.8.0 [src]); `:metavariables` of a file without holes is `()` |
| `ambig-holes` | `broken` | `Ambig.idr`, `(:metavariables 80)`, `:name-at "g_rhs"`, `:refine 14 "g_rhs"` with `A.foo`, then with `Ambig.B.foo` | a qualified name refines, and the answer drops the qualification: `foo ?g_rhs_0`, then `foo ?g_rhs_1` |
| `part-editing` | `broken` | `Part.idr` (a coverage error), `(:metavariables 80)`, `:add-clause 3 "g"`, `:generate-def 3 "g"`, `:add-clause 6 "main"`, `:missing main` | F16: after a failed load the requests that find a declaration by its line fail (`g not defined here`, `Can't find declaration for g on line 3`); `:missing main` answers `Part.main: Calls non covering function Part.g` |
| `hole-errors` | `broken` | `HoleErr.idr` (a type error in `bad`, a coverage error in `cover`); `(:metavariables 80)`; `:name-at` of `before_rhs`, `after_rhs`, `bad`; `:case-split` in both holes' clauses; `:add-clause` of `before` and `cover`; `:generate-def` of `bad`; positional `:type-of` of the local `xs`; `:make-lemma`, `:make-case`, `:make-with` on `after_rhs`; `:intro`, `:refine` on `before_rhs`; `:proof-search` and `-next`; `:missing` of `cover` and `bad` | F16: after a failed load `:metavariables` lists the holes before and after the error, and `bad`, whose definition failed; the position-based requests fail (`No clause to split here`, `before not defined here`, `Can't find declaration for bad on line 8`, `Undefined name xs.`); the others answer as after a clean load |
| `edits-same-name` | `broken` | `SameName.idr`, which imports `SameBase.idr`: `:missing` of `g` (defined in both modules), `f` (in the namespaces `A` and `B`) and `go` (at the top level and in a `where` block) | F15: each report is named by module and namespace (`SameBase.g:` / `g (S _)` / `SameName.g: All cases covered`; `SameName.A.f: All cases covered` / `SameName.B.f:` / `f False`); for the where-local `go` the answer is the top-level one's (`SameName.go:` / `go Y`) |
| `dup-holes` | `broken` | `DupHole.idr` (`f x = ?h`, `g a b = ?h`: `DupHole.h is already defined`): `(:metavariables 80)`, `:name-at` of `h` and `g`, `:proof-search` on both `?h` lines, `:make-lemma` on the second | E16: only the first `?h` is registered; both searches answer `x` (the first's variable) and the lemma is the first's (`h : Nat -> Nat`) |
| `edits-shapes` | `broken` | `Edits.idr`: `:add-clause` on lines 8–11 of the three-line declaration of `zip3` (and with another name), `:generate-def` on lines 8–10; `:case-split`, `:make-lemma`, `:make-case`, `:make-with` and `:add-clause` on a clause continued on the next line (`count`), a clause whose left-hand side spans two lines with `=` on a third (`step`), a where block, a with block, an operator, a hole in a `let`, case alternatives (also on one line), a hole under an application | E15: the answers of `:case-split`, `:make-case` and `:make-with` are built from the request line's text alone (a clause's next lines are not in them); `:case-split` finds the clause by position and rewrites the request line (`     n` twice on `step`'s second line); `:make-case` of a line without the hole returns the line unchanged; `:make-with` takes the line's text up to its first `=` (also that of `=>`) as the left-hand side; `:add-clause` answers for every line of the declaration, ignores the name, and names the hole `<fn>_rhs` also when that hole exists |
| `edits-searches` | `broken` | `Edits.idr`: `:proof-search` and `-next` until `No more results` (`choose_rhs`: `y`, `x`, `False`, `True`), with the hint `isBig`, an unknown hint, no result (`label_rhs : String`, also with the hint `describe`), a pair, a function; `:generate-def` and `-next` until `No more results` (`swap`: two results), on an operator, on `zip3`; `:intro` with one (a pair; a function: a lambda), two and no candidates; `:refine` with `not`, `describe`, `plus`, a local, a constructor, `length` (four alternatives), failing ones, a string literal with escapes, `:t id`, and an expression followed by a line break and more text | F29, F30: the hint's results come after the constructors' (`isBig n`, `isBig 0`); a hint does not help a goal of a primitive type (`String`); `-next` after the end answers `No more results` again; `zip3`'s first two definitions each come twice; `:refine` parses its text as an expression (`:t id`: parse errors) and ignores text after the first expression (`describe 1` for `describe 1\n:t id`) |
| `edits-names` | `broken` | `Edits.idr`: `(:metavariables 80)`; `:name-at` of every hole, of the declarations without clauses (`zip3`, `swap`, the operator `<\|\|>` bare and in parentheses) and of an unknown name; each command on `?h'` (pattern variable `x'`) and on `?ε` (pattern variable `x₁`, function `δ`); `:missing` of 13 texts; the hole commands with the unknown hole name `nope`; `:generate-def` with no declaration on the line and with a definition | F1, F2, F15: `:metavariables` lists a declaration without clauses as a hole (no premises; its `:name-at` span is the whole declaration, a hole's starts at its `?`); a non-ASCII name is written with a decimal escape inside the quoted name (`"\"Edits.\\949\""`); `:name-at` finds an operator written bare; `:missing NAME` answers for every function of that name in scope (`Prelude.Types.count` and `Edits.count`), takes an operator in parentheses, refuses text after the name (a parse error; a `--` comment is accepted) and a where-local name (`Undefined name go`); with an unknown hole name `:make-case` returns the line unchanged and `:make-with` answers as for a hole |
| `edits-layout` | `broken` | `Layout.idr`: `:make-lemma` on the clauses of an infix operator, of an operator in prefix form, of a backticked name and of a function below a modifier line and a `%inline` line; `:missing` and `:add-clause` of a function declared first in a `mutual` block; `:add-clause` and `:generate-def` on `%inline inl :`, on `(<->)` and on `pair, other :`; `:make-with` on a hole with a comment after it; `:case-split` and `:make-with` on a clause whose left-hand side starts on the line above | F15, F30: the lemma answers do not say where the type goes; on a declaration of two names `:add-clause` and `:generate-def` answer for the last whatever the name sent (`other k = ?other_rhs` for `"pair"`); a pragma before the name is accepted; `:make-with` drops a comment after the hole; on a left-hand side started above, `:case-split` and `:make-with` rewrite the one line (`  0 = ?above_rhs_0`, `  y with (_)`) |
| `edits-blocks` | `broken` | `Blocks.idr` (coverage errors in `bc` and `f4`): `:make-lemma` in a `namespace`, a `mutual` block, an interface's default method and a `parameters` block; `:missing f4` (in the `parameters` block) and `:missing bc` (a clause of it in a block comment); `:make-with` on a `let` binding; then `Indented.idr`: `:make-lemma` where the top level is indented | E15: the lemma types name the block's types (`ns_rhs : U -> Nat`); a default method's lemma takes the dictionary (`default_rhs x __con`); a `parameters` lemma takes the parameters (`pw_rhs k x`); `:missing f4` lists the parameter as a pattern (`f4 _ B`); `:make-with` answers `  let y with (_)` |
| `lit-indent-editing` | `broken` | `LitIndent.lidr`: `:add-clause` on a declaration in a `where` block and in a `mutual` block, `:generate-def` on the latter | F11: `:add-clause` writes one space less after the `>` than the declaration has (`>    go k ks = ?go_rhs` for `>     go : …`), `:generate-def` does not |
| `edits-impossible` | `broken` | `Absurd.lidr`: `:case-split` of `p` in `notInNil : Elem x [] -> Void` (every constructor impossible) and of `x` in a one-line `case`; then `ImposTab.idr`: the same two shapes on the tab-indented clauses of a `where` block | E15, F11: when every constructor is impossible the answer is `<clause> impossible` lines indented by the line's leading spaces only, so without the `> ` and the tab (`notInNil Here impossible`, `v FZ impossible`); in a one-line `case` the lines after the first are indented with spaces up to the alternative's column, marker and tab included (`                     (Just x) => ?pick_rhs_1`) |
| `edits-case-words` | `broken` | `CaseWords.idr`: `:case-split` on a clause with the word `of` in a trailing comment, one with `"of"` as a pattern, `paren xs = (?paren_rhs)`, `named xs "xs" = ?named_rhs`, a case alternative with `of` in its comment, and on Make Case's `case_val`, alone and in a `case` in parentheses | E15: the word `of` anywhere on the line makes the compiler cut each new line but the first at that column (`                                    length of the vector`, `           xs) "of" = ?word_rhs_1`); a hole followed by `)` loses the `)` on each new line but the last (`paren [] = (?paren_rhs_0`); a name in a string is rewritten too (`named [] "[]" = ?named_rhs_0`); `case_val` splits cleanly, and its `)` closing an earlier line's bracket stays on the last line only |
| `edits-shadowing` | `broken` | `Shadow.idr`: `:case-split` of `xs` and of `n` in `vlen {n = n} xs = ?vlen_rhs`, of `xs` in `vlen2 {n} xs = ?vlen2_rhs`, of `y` in `fields (MkP {x = x, y = y}) = ?fields_rhs`; `:add-clause` of `f : (Nat -> Nat) -> Nat` and of `j : Nat -> Nat -> Nat`, `:generate-def` of `j`; `:make-with` on `mw x= ?mw_h`; `:intro` on `?g` in `foo x = ?g (S x)` | E15: a braced named argument matched with a variable of its own name gets the new pattern before that variable (`vlen {n = 0 = 0} []`, `MkP {x = x, y = False = False}`), `{n}` is split cleanly (`vlen2 {n = 0} []`); the compiler names arguments like the function (`f f = ?f_rhs`, `j k j = ?j_rhs`, `j k j = j`); Make With copies the text before `=` as it is (`mw xwith (_)`, `  mw x| with_pat = ?mw_h_rhs`); Intro on a hole applied to an argument answers a lambda over a qualified name (`\Shadow.argTy => ?g_0`) |
| `lit2-editing` | `broken` | `Lit2.lidr`: `(:metavariables 80)`, `:name-at`; `:case-split 9 C "xs"` for C = 0–10; `:add-clause`, `:make-lemma`, `:make-case`, `:make-with`, `:proof-search` and two `-next`, `:generate-def` and two `-next`, `:intro`, `:refine`, `:missing` above the `> ` line (file line 16); below it, the commands at `half`'s compiler lines (18, 19) and at its file line (18) | F11: the lines of `:case-split`, `:add-clause` and `:generate-def` and the lemma's type carry one `> `; the first line of `:make-case` carries `> > `, the lines of `:make-with` `> > > ` and `> >   > `; `:missing` answers without `> `; below the `> ` line the requests that read a source line by its number read the next file line (`:case-split` → `>` twice, `:make-case` → `>`, a lemma type without `> `) |
| `holes-ipkg-main` | `holes-ipkg` | `src/Holes/Main.idr`; `(:metavariables 80)`; `:name-at` of `todo`, `util_rhs`, `secret_rhs`, `size_rhs`; on Main's `todo`: `:intro`, `:make-lemma`, `:proof-search`, `:refine`, `:intro` with the qualified name, `:make-case`, `:make-with`, `:case-split`; `:intro` on `size_rhs`; then `src/Holes/Other.idr`, `:metavariables`, `:name-at "todo"`; `src/Holes/Main.idr` again (fresh TTC files), the same two | E16: `:metavariables` lists the holes of the loaded module and of every module it imports, directly or not, exported or not (`Holes.Base.secret_rhs`), by unqualified name, then module; same-named holes differ in their qualified names; `:name-at "todo"` answers one entry per module, each with its absolute path; with two holes of one name in scope, the requests that look the hole up by name fail (`Could not find hole named todo`, `Can't make lifted definition`, `Not a searchable hole`), also with the qualified name; after `Holes.Other` only its `todo` is listed |
| `holes-ipkg-base`, `-util`, `-other` | `holes-ipkg` | each module loaded first: `(:metavariables 80)`, `:name-at` of its holes' names; `:intro` on `todo` in Base and Other | E16: Base lists its two holes, Util those of Util and Base, Other only its own; `:intro` on a `todo` that is the only one in scope answers |
| `holes-loose-main` | `holes` | `Main.idr` (importing `Base.idr`); `(:metavariables 80)`; `:name-at` of `todo` and `size_rhs`; `:intro` on each; `Base.idr` (fresh TTC file), `:metavariables`, `:name-at "todo"` | E16 for loose files, as in `holes-ipkg-main`; premises of multiplicity 0, 1 and unrestricted (`" 0  n"`, `" 1  x"`, `"  xs"`) |
| `holes-loose-base` | `holes` | `Base.idr`; `(:metavariables 80)`; `:name-at "todo"` | the hole of `Base` alone |
