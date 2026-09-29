# First load, saves and request latency of the `check` session (baseline before M3)

What the M2 extension's IDE-mode `check` session costs on a real package: the first load of a
module, which compiles its whole import closure into the isolated build directory; later loads
and saves; the session's memory; and the latency of the cheap requests M3 will add. Measured on
2026-09-28, before M3 was started, with `scripts/measure-first-load.mjs` (its header documents
usage, what it measures and its safety rules). The raw results are the JSON files in
[`first-load-2026-09-28/`](first-load-2026-09-28/): `run-A.json`, `run-B.json`, `run-D.json`
(three runs over the same four modules; D with the script as it is in the repository),
`run-C.json` (300 saves on one module), and `run-0.json` and `run-1.json` (the preliminary runs,
made with earlier versions of the script; *Preliminary runs*).

Evidence tags as in `docs/ROADMAP.md`: **[live 2026-09-28]** measured on the machine below on that
date, in the runs named; **[src]** read in this repository's source; **[open]** not measured.
Every number in this file is [live 2026-09-28] from runs A–D unless it says otherwise.

The subject is Idris 2's `contrib` library. `CLAUDE.md` forbids running `idris2` on the Idris 2
libraries in general. This benchmark is the one exception, approved by the user on 2026-09-28
(the proposal named "a module of Idris 2's `contrib` library, under the usual one-process limit",
and the user chose it; recorded in `docs/ROADMAP.md` §9 and `CLAUDE.md`). It was run under those
resource rules: a copy under `/tmp`, one compiler process at a time, free memory and load checked
before every process (the script's *Safety*). One compiler process ran at a time throughout. The
exception covers `scripts/measure-first-load.mjs` on `contrib` only; the independent check of the
method used a self-written package instead.

## Headline numbers

Ranges over runs A, B and D. "Footprint" is macOS's `phys_footprint` of the compiler process (see
*Method*: the memory number to use on macOS). Timings varied by up to about a third between runs
(*Run to run*); the footprints did not vary at all (RSS did).

| What | Cost |
|---|---|
| Session start (spawn → `:protocol-version`) | 0.22–0.31 s; footprint 191 MiB before any load |
| **First load, empty build directory** (compiles the whole in-package closure) | **1.22–1.46 s** for 18 modules / 2,108 lines and for 11 modules / 2,354 lines; 0.22–0.30 s for 2 modules / 124 lines; 0.81–0.95 s for one 682-line module |
| Reload, file unchanged | 0.08–0.24 s in (b); up to 0.40 s in (f′) |
| Save of the open file (comment appended; the file is rebuilt) | 0.11–0.17 s (16- and 34-line files), 0.31–0.44 s (229 lines), 0.78–0.96 s (682 lines) |
| Save of a dependency, comment only (only it is rebuilt) | 0.15–0.30 s |
| Save of a dependency, exported definition added (2, 4 or 5 modules rebuilt) | 0.19–0.75 s |
| Reopen: new session on the build directory a session left | start 0.22–0.31 s + load 0.10–0.24 s |
| Memory of one session | footprint 206–224 MiB after the first load; 221–278 MiB idle after 7–11 loads; peak 264–424 MiB; over 300 saves (run C) 225–284 MiB with a peak of 442 MiB and no upward trend |
| Build directory | 0.22–2.52 MB (one `.ttc` and one `.ttm` per module of the closure) |
| `:type-of NAME`, `:docs-for NAME` | median 0.12–0.96 ms, p90 ≤ 4.1 ms, max 10.5 ms; the first after a reload ≤ 1.9 ms |
| `:metavariables` (no holes in these modules) | median ≤ 0.1 ms |
| `:repl-completions PREFIX` | median 0.8–3.1 ms, p90 ≤ 10.8 ms — but **the first one after every load takes 113–423 ms** |

## Setup

| | |
|---|---|
| Machine | Apple M4 (4 performance + 6 efficiency cores), 16 GB (17,179,869,184 bytes), arm64 |
| OS | macOS 27.0 (26A428) |
| Compiler | `Idris 2, version 0.8.0` (Homebrew `idris2` 0.8.0_2; `/opt/homebrew/bin/idris2` is a shell script that runs `idris2_app/idris2.so`, whose `#!` line starts `chez --program`; Chez Scheme 10.4.1); TTC version 2025081600 (`ttcVersion`, `src/Core/Binary.idr` at v0.8.0 [src]) |
| Node, timeout | Node v24.13.0; GNU coreutils `timeout` 9.12 |
| Date and time (PDT) | 2026-09-28: run A 17:01:44–17:02:49, run B 17:02:57–17:04:02, run C 17:05:30–17:07:32, run D 19:18:24–19:19:32 |
| Load | 1-minute load average, read at every step: 3.55–4.08 (A), 3.43–3.92 (B), 2.67–4.58 (C), 2.72–3.09 (D). The user's applications were running; no other `idris2` compiler ran (the script waits until none does) |
| Free memory | `memory_pressure -Q` free: 32–46 % when a session of A–C started and never below 32 % during one; 27–33 % in D (27 % at its first start). The script's limits (start at ≥ 25 %, stop below 15 %, 1-minute load ≤ 15) were never hit: no waits, no aborts |

## Subject: `contrib`

- The `contrib` library of Idris 2 v0.8.0 (BSD-3-Clause, Edwin Brady): `libs/contrib` of the
  checkout `~/Library/Caches/vscode-idris2-dev/Idris2-0.8.0` at
  `15a3e4e70843f7a34100f6470c04b791330788df`, the v0.8.0 commit that `test/corpus/corpus.json`
  pins; copied to `/tmp/vi2-pre3/bench/contrib` (identical to the source, `diff -rq`, after all
  runs), and by the script again into a fresh work directory per run, which is the only place it
  writes. No text of the library is in this repository; the JSON files hold module names, line
  counts and the four names queried.
- `contrib.ipkg` has no `depends` (only the implicit `prelude` and `base`, both installed as
  0.8.0 per `idris2 --list-packages`), `opts = "--ignore-missing-ipkg -Wno-shadowing"`, and no
  `builddir` or `sourcedir`, so the extension passes `--build-dir <root>/build/.vscode-idris2`
  (`pool.ts` `checkBuildDir` [src]). 103 modules (all `.idr`), 12,780 lines (`wc -l`).
- **Import closure** of a module: the modules of the package it imports, directly or not, and
  itself, read from its `import` lines with comments removed (`prelude` and `base` come from the
  installed TTCs and are not counted). 49 of the 103 modules are leaves; the median closure has 2
  modules, the largest 18. The closures are computed from the source text; the compiler checked
  them only for the four modules loaded: in every cold load of runs A–D the modules it reported
  as `Building` were exactly the computed closure (compared as sets).
- The ten largest closures (`--closures`, computed):

  | module | lines | closure (modules) | closure (lines) |
  |---|---:|---:|---:|
  | Language.JSON | 16 | 18 | 2,108 |
  | Language.JSON.Parser | 79 | 16 | 2,052 |
  | Language.JSON.Lexer | 40 | 15 | 1,810 |
  | Language.JSON.Tokens | 82 | 14 | 1,770 |
  | Language.JSON.String | 17 | 13 | 1,688 |
  | System.Directory.Tree | 229 | 11 | 2,354 |
  | Text.Lexer.Tokenizer | 160 | 11 | 1,965 |
  | Language.JSON.String.Parser | 26 | 11 | 1,629 |
  | System.Path | 594 | 10 | 2,125 |
  | Decidable.Finite.Fin | 33 | 10 | 1,014 |

- **Chosen** (the script's automatic choice): the largest closure in modules,
  `Language.JSON` (18 modules, 2,108 lines; the file itself 16 lines); the largest in lines,
  `System.Directory.Tree` (11 modules, 2,354 lines; 229); the median, `Data.Nat.Order.Strict`
  (2 modules, 124 lines; 34); and the longest leaf, `Data.Seq.Internal` (682 lines). The
  dependency edited in (d)/(d′), the middle of the closure's dependencies-first order:
  `Text.Lexer` (417 lines) for `Language.JSON`, `Text.Quantity` (44) for
  `System.Directory.Tree`, `Decidable.Order.Strict` (90) for `Data.Nat.Order.Strict`; the leaf
  has none. The names queried in (f) are each module's first top-level signature: `parse`,
  `fileName`, `decLT`, `err`.

## Commands

```sh
cp -R ~/Library/Caches/vscode-idris2-dev/Idris2-0.8.0/libs/contrib /tmp/vi2-pre3/bench/contrib
node scripts/measure-first-load.mjs --package /tmp/vi2-pre3/bench/contrib --closures
# run A (runs B and D: the same with work-B / run-B.json and work-D / run-D.json)
/opt/homebrew/bin/timeout 590 node scripts/measure-first-load.mjs \
  --package /tmp/vi2-pre3/bench/contrib --work /tmp/vi2-pre3/bench/work-A \
  --out /tmp/vi2-pre3/bench/results/run-A.json
# run C
/opt/homebrew/bin/timeout 590 node scripts/measure-first-load.mjs \
  --package /tmp/vi2-pre3/bench/contrib --work /tmp/vi2-pre3/bench/work-C \
  --out /tmp/vi2-pre3/bench/results/run-C.json --module System.Directory.Tree --saves 300
```

The outer `timeout 590` kept each run inside one foreground call; on its signal the script kills
its session and restores the edited files (tried at 19:24 on a scratch package of three
self-written modules with the script as it is: `timeout -s TERM 14` stopped it during `--saves`;
it killed its session, no compiler process was left, and the files were byte-identical to the
originals, `diff -rq`). Defaults: `--repeat 3`, `--dep-repeat 2`, `--queries 10`,
`--load-timeout-min 30`, `--session-timeout-min 60`.

**Script versions.** Run D used the script as it is in the repository. Runs A–C used earlier
versions of it, which were not kept: according to the first version of this page, A and B ran
before `--saves` was added (default 0, which runs nothing); C ran before the report recorded
the statuses of the (f′) requests and a sample of the unframed stdout lines (added afterwards,
together with run D). Neither addition changes what is sent or timed. The JSON of A, B and D
records the same steps, the same request texts and the same edited dependency for every module,
and D reproduced A's built modules, `:highlight-source` output, reply sizes and memory footprints
exactly (*Run to run*).

Each session was started as (run A, first module)

```sh
/opt/homebrew/bin/timeout -k 10 3600 /usr/bin/time -l /opt/homebrew/bin/idris2 --ide-mode --no-color \
  --build-dir /private/tmp/vi2-pre3/bench/work-A/contrib/build/.vscode-idris2
```

in `/private/tmp/vi2-pre3/bench/work-A/contrib` (the real path; `/tmp` is a symbolic link on
macOS), with requests such as
`((:load-file "/private/tmp/vi2-pre3/bench/work-A/contrib/Language/JSON.idr") 2)`.

## Method

- **As the extension does it** [src]: the command line and working directory (`pool.ts`
  `sessionLaunch`, stdio transport, default settings: no `extraArgs`), the framing (`wire.ts`
  `encodeFrame`: six hex digits giving the UTF-8 byte length of the request and its newline), the
  request shapes (`protocol.ts` `loadFile`, `typeOf` without a position, `docsFor`,
  `metavariables`; `:repl-completions` as ROADMAP M3 plans it), one request in flight, absolute
  paths under the working directory's real path.
- **Not as the extension does it**: two waiting wrappers, timeout(1) and time(1), sit above the
  launcher script (they only wait; they are left out of the RSS sums); the extension's own work
  around a load (the consent gate, the package walk before each load, diagnostics, VS Code) is
  not included; latency is taken in the script, from writing a request to reading its
  `:return`, so it includes the pipe but not the extension's decoding. The compiler inherits the
  environment of the shell that ran the script, not the Extension Host's environment overlaid
  with `idris2.toolchain.env`; variables that change what the compiler reads (`IDRIS2_*`,
  `CHEZ*`, `DYLD_*`, `PATH`) are not recorded in the JSON [open for runs A–D; none of the first
  three families was set in the integrator's shell when this page was revised, which is not
  evidence about the runs' shell].
- **Samplers in the timed loads**: during every load the script starts `ps -Ao …` every 500 ms
  (the RSS sampler) and, while a session runs outside (f), `memory_pressure` every 5 s (the
  free-memory watch), both on the event loop that reads the compiler's output. They take CPU
  while a load is timed, so they add some jitter to the load times (not quantified; probably a
  few ms). No sampler runs during the requests of (f).
- **A gap before the (f′) requests**: after each (f′) reload the script reads the memory
  (`ps -A` and footprint(1) on the Chez process) before it sends the first request, so "the first
  request after a reload" follows the reload's `:return` after a gap of tens to hundreds of
  milliseconds (not recorded) in which the compiler is idle. The extension may send a request at
  once; whether the first request is slower then was not measured.
- **Steps**, per module (see the script header): start; (a) cold load after the build directory
  was removed; (b) three reloads of the unchanged file; (c) three reloads, each after appending a
  comment line to the module; (d) two reloads, each after appending a comment line to the
  dependency; (d′) two reloads, each after appending an exported definition
  (`measureFirstLoadEditN : Integer`) to the dependency; (e) 10 s without a request; (f) ten of
  each request; (f′) three cycles of one reload of the unchanged file and one request of each
  kind; then end of input. Session 2 ("reopen"): a new process on the build directory session 1
  left, one load. Run C adds 300 cycles of appending a comment line to the module and loading
  it, reading the memory every 10.
- **Statistics**: median (of ten: the mean of the 5th and 6th); p90 by nearest rank (of ten: the
  9th smallest); "first" is the first of the ten.
- **Memory**: after each step, `footprint -f bytes --noCategories -p <pid>` on the Chez process
  gives `phys_footprint` (dirty memory, compressed and swapped pages included; what Activity
  Monitor shows as Memory) and `phys_footprint_peak` (the process's high-water mark); ps(1)
  gives RSS (launcher script + Chez, sampled every 500 ms during a load); time(1) gives the
  session's "maximum resident set size" at its end: the largest maximum RSS over the launcher and
  the Chez process it starts (in practice Chez's), not their sum (checked: for a shell script
  whose child allocates 300 MB, `time -l` reported 315 MB; the method's verification got 308 MiB
  for a 300 MB grandchild). time(1)'s own "peak memory footprint" line reports only its direct
  child, the launcher (about 1.5 MB), and is not used. **Use the
  footprint**: RSS leaves out the pages macOS has compressed, and it did compress idle sessions —
  in run B the RSS of the idle `Data.Nat.Order.Strict` session was 89 MiB while its footprint
  stayed at 221 MiB (and 3 MiB in a preliminary run, below). The footprint readings of runs A, B
  and D agree to the MiB at every step; the RSS readings do not.
- **End of input**: every session of A–D wrote one unframed stdout line and exited with status 1
  (D recorded the line: `Alas the file is done, aborting`), as F5 in `docs/ROADMAP.md` describes.

## Results

### Loads (ms)

"built" = the `Building` lines of that load.

| module | run | start | (a) cold | (b) unchanged ×3 | (c) module edited ×3 | (d) dep. comment ×2 | (d′) dep. definition ×2 | (f′) reload ×3 | reopen: start + load |
|---|---|---:|---:|---|---|---|---|---|---|
| Language.JSON | A | 237 | 1326 (18 built) | 125, 124, 170 | 146, 153, 147 | 229, 272 (1 built) | 360, 357 (5 built) | 122, 132, 135 | 227 + 148 |
| Language.JSON | B | 231 | 1282 (18 built) | 124, 135, 166 | 147, 149, 145 | 223, 253 (1 built) | 348, 354 (5 built) | 122, 130, 134 | 221 + 152 |
| Language.JSON | D | 274 | 1460 (18 built) | 136, 151, 181 | 169, 164, 165 | 246, 298 (1 built) | 448, 404 (5 built) | 170, 146, 152 | 248 + 169 |
| System.Directory.Tree | A | 231 | 1308 (11 built) | 191, 167, 157 | 323, 354, 318 | 193, 210 (1 built) | 745, 611 (4 built) | 232, 164, 164 | 233 + 182 |
| System.Directory.Tree | B | 222 | 1215 (11 built) | 185, 150, 154 | 315, 348, 313 | 191, 198 (1 built) | 631, 680 (4 built) | 234, 162, 168 | 223 + 180 |
| System.Directory.Tree | D | 256 | 1411 (11 built) | 218, 176, 185 | 379, 443, 371 | 218, 226 (1 built) | 680, 680 (4 built) | 265, 189, 185 | 265 + 202 |
| Data.Nat.Order.Strict | A | 231 | 215 (2 built) | 79, 80, 79 | 115, 149, 111 | 153, 156 (1 built) | 191, 224 (2 built) | 83, 85, 81 | 239 + 109 |
| Data.Nat.Order.Strict | B | 222 | 228 (2 built) | 79, 78, 80 | 112, 149, 115 | 154, 152 (1 built) | 186, 220 (2 built) | 82, 82, 82 | 237 + 103 |
| Data.Nat.Order.Strict | D | 260 | 297 (2 built) | 92, 94, 87 | 127, 170, 123 | 176, 172 (1 built) | 215, 266 (2 built) | 92, 94, 91 | 266 + 115 |
| Data.Seq.Internal | A | 246 | 846 (1 built) | 228, 183, 186 | 830, 790, 835 | — | — | 187, 242, 191 | 259 + 216 |
| Data.Seq.Internal | B | 225 | 805 (1 built) | 216, 181, 185 | 840, 776, 820 | — | — | 232, 403, 303 | 314 + 228 |
| Data.Seq.Internal | D | 255 | 947 (1 built) | 242, 206, 205 | 957, 888, 946 | — | — | 232, 307, 216 | 249 + 239 |

Every load answered `(:ok …)` and none sent a warning. What (d′) rebuilt (the same in A, B and
D): for `Language.JSON`, `Text.Lexer` and four of the seven modules above it
(`Language.JSON.String.Lexer`, `…String.Parser`, `…String`, `Language.JSON.Lexer`), not
`Language.JSON` itself; for `System.Directory.Tree`, `Text.Quantity`, `Text.Lexer`, `Text.Parser`
and `System.Path`, not the module itself; for `Data.Nat.Order.Strict`, both. So a rebuild does
not always reach every importer; here it twice stopped below the loaded module. The mechanism
(presumably a comparison of the imports' interface hashes) was not checked in the compiler's
source.

### Run to run

Run D, taken two and a quarter hours after A and B with the script as it is now, built the same
modules in every load, received the same `:highlight-source` output and the same reply sizes, and
read the same footprints (to the MiB, at every step) as A and B. Its timings were higher: the
cold loads by 12–34 % over the mean of A and B (1,460 against 1,304 ms, 1,411 against 1,262,
297 against 222, 947 against 826), the other loads by similar amounts, the first
`:repl-completions` after a load by up to about a quarter — although D ran at a lower 1-minute
load average (2.7–3.1 against 3.4–4.1) and with less free memory (27–33 % against 32–46 %). The
cause was not investigated. Read the timings on this page as ±⅓, not to the millisecond; a
preliminary run (below) was slower still on one module.

### Memory (MiB)

| module | run | footprint after start | after (a) | idle (e): footprint / RSS | session peak footprint | `time -l` max RSS | reopen: peak footprint / max RSS | build directory after (a) |
|---|---|---:|---:|---|---:|---:|---|---|
| Language.JSON | A | 191 | 216 | 245 / 234 | 312 | 319 | 215 / 216 | 2.27 MB, 18 `.ttc` + 18 `.ttm` |
| Language.JSON | B | 191 | 216 | 245 / 220 | 312 | 322 | 215 / 216 | 2.27 MB, 18 `.ttc` + 18 `.ttm` |
| Language.JSON | D | 191 | 216 | 245 / 199 | 312 | 322 | 215 / 216 | 2.27 MB, 18 `.ttc` + 18 `.ttm` |
| System.Directory.Tree | A | 191 | 223 | 258 / 233 | 424 | 408 | 215 / 216 | 2.52 MB, 11 `.ttc` + 11 `.ttm` |
| System.Directory.Tree | B | 191 | 223 | 258 / 210 | 424 | 406 | 215 / 216 | 2.52 MB, 11 `.ttc` + 11 `.ttm` |
| System.Directory.Tree | D | 191 | 223 | 258 / 206 | 424 | 406 | 215 / 216 | 2.52 MB, 11 `.ttc` + 11 `.ttm` |
| Data.Nat.Order.Strict | A | 191 | 206 | 221 / 224 | 264 | 289 | 215 / 216 | 0.22 MB, 2 `.ttc` + 2 `.ttm` |
| Data.Nat.Order.Strict | B | 191 | 206 | 221 / 89 | 264 | 274 | 215 / 216 | 0.22 MB, 2 `.ttc` + 2 `.ttm` |
| Data.Nat.Order.Strict | D | 191 | 206 | 221 / 182 | 264 | 272 | 215 / 216 | 0.22 MB, 2 `.ttc` + 2 `.ttm` |
| Data.Seq.Internal | A | 191 | 224 | 278 / 268 | 319 | 320 | 215 / 216 | 2.22 MB, 1 `.ttc` + 1 `.ttm` |
| Data.Seq.Internal | B | 191 | 224 | 278 / 141 | 319 | 320 | 215 / 216 | 2.22 MB, 1 `.ttc` + 1 `.ttm` |
| Data.Seq.Internal | D | 191 | 224 | 278 / 240 | 319 | 297 | 215 / 216 | 2.22 MB, 1 `.ttc` + 1 `.ttm` |

"Session peak footprint" is the largest `phys_footprint_peak` read in session 1 (11 loads
before (e), 7 for the leaf; 3 after it). The footprint rises over a session's first loads (for
`Language.JSON`: 216 MiB after (a), 312 MiB after the 14th load); run C shows where that stops.

### 300 saves (run C, `System.Directory.Tree`)

A save appends a comment line to the module and loads it (one module rebuilt each time). Load
time over the 300: median 332 ms, p90 371 ms, min 312 ms, max 518 ms.

| after save | 10 | 40 | 70 | 100 | 130 | 160 | 190 | 220 | 250 | 280 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| footprint (MiB) | 284 | 257 | 254 | 231 | 250 | 236 | 264 | 249 | 258 | 245 |
| peak footprint (MiB) | 442 | 442 | 442 | 442 | 442 | 442 | 442 | 442 | 442 | 442 |

All 30 readings (every 10th save): footprint 225–284 MiB, peak 442 MiB from the 10th save on;
`time -l` max RSS of the session 432 MiB. The footprint stayed level (the cause was not
examined); nothing grew over the 300 saves.

### Highlight output of one load (first reload of the unchanged file; identical in A, B and D)

M3's token index is built from these frames; every load of the file sends them again (F7).

| module | lines of the loaded file | `:highlight-source` frames | bytes | bytes per line |
|---|---:|---:|---:|---:|
| Language.JSON | 16 | 32 | 6,271 | 392 |
| System.Directory.Tree | 229 | 1,249 | 293,679 | 1,282 |
| Data.Nat.Order.Strict | 34 | 171 | 39,314 | 1,156 |
| Data.Seq.Internal | 682 | 8,658 | 2,080,626 | 3,051 |

### Requests (ms): ten of each after the loads, step (f)

| module | run | request | median | p90 | max | first | reply bytes |
|---|---|---|---:|---:|---:|---:|---:|
| Language.JSON | A | `(:type-of "parse")` | 0.49 | 0.74 | 1.37 | 1.37 | 797 |
| Language.JSON | A | `(:docs-for "parse")` | 0.66 | 0.76 | 0.79 | 0.79 | 1,330 |
| Language.JSON | A | `(:repl-completions "par")` | 1.81 | 9.76 | 282.74 | 282.74 | 234 (12 names) |
| Language.JSON | A | `(:metavariables 80)` | 0.08 | 0.11 | 0.15 | 0.15 | 28 |
| Language.JSON | B | `(:type-of "parse")` | 0.43 | 0.71 | 1.50 | 1.50 | 797 |
| Language.JSON | B | `(:docs-for "parse")` | 0.64 | 0.70 | 0.75 | 0.75 | 1,330 |
| Language.JSON | B | `(:repl-completions "par")` | 2.25 | 10.82 | 280.59 | 280.59 | 234 (12 names) |
| Language.JSON | B | `(:metavariables 80)` | 0.10 | 0.11 | 0.13 | 0.13 | 28 |
| Language.JSON | D | `(:type-of "parse")` | 0.44 | 0.68 | 1.50 | 1.50 | 797 |
| Language.JSON | D | `(:docs-for "parse")` | 0.76 | 0.81 | 1.07 | 1.07 | 1,330 |
| Language.JSON | D | `(:repl-completions "par")` | 2.36 | 10.49 | 323.25 | 323.25 | 234 (12 names) |
| Language.JSON | D | `(:metavariables 80)` | 0.09 | 0.12 | 0.13 | 0.13 | 28 |
| System.Directory.Tree | A | `(:type-of "fileName")` | 0.21 | 0.27 | 0.53 | 0.53 | 388 |
| System.Directory.Tree | A | `(:docs-for "fileName")` | 0.50 | 0.54 | 0.78 | 0.78 | 931 |
| System.Directory.Tree | A | `(:repl-completions "fil")` | 2.24 | 8.77 | 320.25 | 320.25 | 244 (16 names) |
| System.Directory.Tree | A | `(:metavariables 80)` | 0.08 | 0.10 | 0.11 | 0.11 | 28 |
| System.Directory.Tree | B | `(:type-of "fileName")` | 0.47 | 0.59 | 0.79 | 0.79 | 388 |
| System.Directory.Tree | B | `(:docs-for "fileName")` | 0.96 | 4.06 | 10.52 | 0.85 | 931 |
| System.Directory.Tree | B | `(:repl-completions "fil")` | 1.77 | 7.95 | 340.35 | 340.35 | 244 (16 names) |
| System.Directory.Tree | B | `(:metavariables 80)` | 0.07 | 0.10 | 0.11 | 0.11 | 28 |
| System.Directory.Tree | D | `(:type-of "fileName")` | 0.23 | 0.31 | 0.61 | 0.61 | 388 |
| System.Directory.Tree | D | `(:docs-for "fileName")` | 0.54 | 0.72 | 0.84 | 0.84 | 931 |
| System.Directory.Tree | D | `(:repl-completions "fil")` | 3.12 | 10.74 | 396.72 | 396.72 | 244 (16 names) |
| System.Directory.Tree | D | `(:metavariables 80)` | 0.09 | 0.11 | 0.19 | 0.19 | 28 |
| Data.Nat.Order.Strict | A | `(:type-of "decLT")` | 0.13 | 0.21 | 0.63 | 0.63 | 356 |
| Data.Nat.Order.Strict | A | `(:docs-for "decLT")` | 0.20 | 0.23 | 0.24 | 0.21 | 537 |
| Data.Nat.Order.Strict | A | `(:repl-completions "dec")` | 1.07 | 2.53 | 153.00 | 153.00 | 332 (33 names) |
| Data.Nat.Order.Strict | A | `(:metavariables 80)` | 0.08 | 0.08 | 0.10 | 0.10 | 28 |
| Data.Nat.Order.Strict | B | `(:type-of "decLT")` | 0.21 | 0.47 | 1.64 | 1.64 | 356 |
| Data.Nat.Order.Strict | B | `(:docs-for "decLT")` | 0.17 | 0.21 | 0.33 | 0.33 | 537 |
| Data.Nat.Order.Strict | B | `(:repl-completions "dec")` | 1.07 | 2.52 | 158.91 | 158.91 | 332 (33 names) |
| Data.Nat.Order.Strict | B | `(:metavariables 80)` | 0.08 | 0.09 | 0.11 | 0.11 | 28 |
| Data.Nat.Order.Strict | D | `(:type-of "decLT")` | 0.19 | 0.33 | 0.80 | 0.80 | 356 |
| Data.Nat.Order.Strict | D | `(:docs-for "decLT")` | 0.23 | 0.33 | 0.41 | 0.33 | 537 |
| Data.Nat.Order.Strict | D | `(:repl-completions "dec")` | 1.81 | 3.29 | 171.48 | 171.48 | 332 (33 names) |
| Data.Nat.Order.Strict | D | `(:metavariables 80)` | 0.08 | 0.11 | 0.15 | 0.15 | 28 |
| Data.Seq.Internal | A | `(:type-of "err")` | 0.12 | 0.17 | 0.30 | 0.30 | 168 |
| Data.Seq.Internal | A | `(:docs-for "err")` | 0.12 | 0.18 | 0.20 | 0.20 | 342 |
| Data.Seq.Internal | A | `(:repl-completions "err")` | 0.79 | 3.01 | 115.22 | 115.22 | 38 (1 name) |
| Data.Seq.Internal | A | `(:metavariables 80)` | 0.07 | 0.08 | 0.10 | 0.10 | 28 |
| Data.Seq.Internal | B | `(:type-of "err")` | 0.12 | 0.18 | 1.27 | 1.27 | 168 |
| Data.Seq.Internal | B | `(:docs-for "err")` | 0.19 | 0.26 | 0.39 | 0.39 | 342 |
| Data.Seq.Internal | B | `(:repl-completions "err")` | 0.93 | 6.66 | 138.27 | 138.27 | 38 (1 name) |
| Data.Seq.Internal | B | `(:metavariables 80)` | 0.06 | 0.07 | 0.12 | 0.12 | 28 |
| Data.Seq.Internal | D | `(:type-of "err")` | 0.12 | 0.15 | 0.45 | 0.45 | 168 |
| Data.Seq.Internal | D | `(:docs-for "err")` | 0.15 | 0.18 | 0.19 | 0.19 | 342 |
| Data.Seq.Internal | D | `(:repl-completions "err")` | 1.01 | 3.59 | 129.38 | 129.38 | 38 (1 name) |
| Data.Seq.Internal | D | `(:metavariables 80)` | 0.08 | 0.10 | 0.14 | 0.14 | 28 |

Every request of (f) answered `(:ok …)` in A–D, and every request of (f′) in D (A–C did not
record those statuses). The `:metavariables` reply is `(:ok ())` in all four modules: none has a
hole, so its latency with holes is not measured here.

### The first request of each kind after a reload, step (f′), three cycles (ms)

| module | run | `:type-of` | `:docs-for` | `:repl-completions` | `:metavariables` |
|---|---|---|---|---|---|
| Language.JSON | A | 0.77, 0.84, 0.97 | 1.87, 0.96, 1.05 | 290.31, 242.69, 286.50 | 0.17, 0.15, 0.16 |
| Language.JSON | B | 0.83, 0.81, 0.91 | 1.80, 0.87, 0.99 | 288.42, 237.41, 276.86 | 0.15, 0.17, 0.18 |
| Language.JSON | D | 0.94, 1.10, 1.10 | 1.86, 1.10, 1.11 | 337.86, 274.03, 326.71 | 0.15, 0.16, 0.15 |
| System.Directory.Tree | A | 0.71, 0.47, 0.43 | 0.67, 0.65, 0.61 | 310.78, 366.91, 319.05 | 0.15, 0.15, 0.16 |
| System.Directory.Tree | B | 0.40, 0.41, 0.41 | 0.57, 0.56, 0.57 | 308.92, 361.69, 318.17 | 0.15, 0.15, 0.15 |
| System.Directory.Tree | D | 0.49, 0.78, 0.42 | 0.67, 0.66, 0.59 | 387.00, 422.94, 357.65 | 0.22, 0.15, 0.15 |
| Data.Nat.Order.Strict | A | 0.46, 0.47, 0.46 | 0.21, 0.24, 0.29 | 186.16, 152.57, 197.84 | 0.13, 0.14, 0.16 |
| Data.Nat.Order.Strict | B | 0.57, 0.47, 0.51 | 0.24, 0.21, 0.28 | 193.06, 149.13, 200.77 | 0.15, 0.14, 0.15 |
| Data.Nat.Order.Strict | D | 0.52, 0.55, 0.58 | 0.23, 0.27, 0.43 | 223.36, 172.92, 255.42 | 0.16, 0.16, 0.16 |
| Data.Seq.Internal | A | 0.28, 0.29, 0.24 | 0.17, 0.21, 0.17 | 117.09, 112.83, 113.69 | 0.15, 0.14, 0.15 |
| Data.Seq.Internal | B | 0.75, 0.50, 0.30 | 0.75, 0.43, 0.17 | 149.51, 138.32, 235.10 | 0.24, 0.23, 0.64 |
| Data.Seq.Internal | D | 0.37, 0.29, 0.28 | 0.22, 0.19, 0.20 | 140.21, 128.86, 130.49 | 0.18, 0.17, 0.21 |

The first `:repl-completions` after a load (in (f′), and the first of (f)) took 95–253 times the
median of the ten in (f) of the same run, in every cycle: the cost comes back with every load, not
only with the first in a session. The first `:type-of`/`:docs-for` after a reload in (f′) took
0.17–1.87 ms, 0.6–6.3 times the median of the same request in (f); the first of the ten in (f)
took 0.19–1.64 ms, 0.9–10.6 times that median (10.6: run B, `Data.Seq.Internal`, `:type-of`
1.27 ms against 0.12 ms). Relatively slower, but still under 2 ms.

## What the numbers say

### For users

- **Opening a project for the first time** compiles the imports of the file you open into
  `build/.vscode-idris2`, once. On this machine that took 1.2–1.5 s for the largest import
  closures of `contrib` (11–18 modules, about 2,100–2,400 lines), 0.2–0.3 s for a small one,
  and 0.8–0.95 s for a single 682-line module. How it grows for projects much larger than that
  was not measured (below); compile time depends on the code, not only on its length (the
  682-line module took about two thirds as long as 2,354 lines spread over 11 modules).
- **Saving** rebuilds the saved file and reloads it: 0.1–0.45 s for files up to 229 lines,
  0.8–0.96 s for the 682-line one. Saving a module that others import rebuilds that module and
  only some of its importers: a comment-only change rebuilt that module alone, an added
  definition two to five modules (not always up to the open file).
- **Reopening VS Code** on a project checked before: the build directory is still there, so the
  first load only reads it — 0.3–0.55 s including the session's start.
- **Memory**: each open project root runs one compiler session; for these `contrib` modules it
  took about 200–280 MiB, with peaks of 260–440 MiB while loading (other projects were not
  measured); it did not grow over 300 saves. On macOS, Activity Monitor's
  Memory column (the footprint) is the number to watch; the RSS some tools show drops when
  macOS compresses an idle session. `idris2.ideMode.maxSessions` caps the number of sessions per
  window (M2, ROADMAP §9 Q21).

### For M3 (request budgets)

- **Hover and Type/Docs at Cursor**: `:type-of` and `:docs-for` by name answered in well under
  1 ms at the median and within 4.1 ms at p90 (one outlier of 10.5 ms in 120 `:docs-for`), and
  within 1.9 ms as the first request after a load (in (f′), after the gap described in
  *Method*). At these sizes the compiler's answer is not
  what limits a hover. The positional form `(:type-of NAME L C)` that hover and the inlay hints
  send was **not** measured [open].
- **Inlay hints**: one `:type-of` per bound variable in view; at the medians measured here (about
  0.1–1 ms each, one request in flight), 100 hints would take roughly 10–100 ms — arithmetic
  from these medians, not a measured batch, and for the name form only.
- **Completion**: `:repl-completions` took 113–423 ms for the first request after every load
  (more for the larger closures: 113–235 ms for the leaf, 149–255 ms for the 2-module closure,
  237–423 ms for the two large ones) and about 1–3 ms afterwards. A completion provider that
  sends it on the first keystroke after a save would stall for that long; M3 could send one
  cheap `:repl-completions` right after each load while the session is idle, or answer from a
  cache and refresh it after the load; pre-warming after each load is the main recommendation.
  Suggested budget (a recommendation from these numbers, not a measurement): about 1 s for the
  first completion after a load on projects of this size — runs A, B and D stayed at or below
  0.43 s, but preliminary run 1 measured 0.62–0.97 s for `Language.JSON` (the first of (f) and
  the three of (f′)) in a session macOS had compressed while it was idle (*Preliminary runs*).
- **Token index**: a load sends up to 3 KB of `:highlight-source` output per source line (2.08 MB
  in 8,658 frames for the 682-line module), again at every reload (F7). Build the index from the
  stream as frames arrive, and replace it per load rather than merge. At the densities measured
  (0.4–3 KB per line) a 2,000-line file would send roughly 0.8–6 MB per load (arithmetic, not
  measured), which M3's budget "tokens for a 2,000-line fixture in < 200 ms after load" (ROADMAP
  M3) has to absorb. How much of a reload's 0.08–0.24 s is spent producing this output was not
  separated.
- **A second session per root** (`eval`, M3): inferred, not measured (the `eval` session does
  not exist yet): another process of about 190 MiB before its first load, since every session
  measured here started at a footprint of 191 MiB, plus what its loads add.
- **Queue**: a session has one request in flight (ARCHITECTURE §5.1 [src]), so a hover sent during
  a load waits for it: up to 1.5 s behind a first load and 0.1–1.0 s behind a save here.

## Not measured

- Projects larger than `contrib`'s largest closure (18 modules, 2,354 lines at most), such as
  the compiler's own sources (`idris2api.ipkg`), and packages with `depends` on installed
  packages; growth beyond these sizes is not extrapolated.
- The extension end to end (VS Code, the consent gate, the package walk before each load,
  diagnostics); the socket transport; Linux or any other machine (the script is macOS-only).
- `(:type-of NAME L C)` (positional), `:name-at`, `:browse-namespace`, `:interpret` (M3's
  evaluation), `:metavariables` with holes, loads that fail with errors or warnings.
- Several sessions at once (several roots, or `check` + `eval`), background checks, and the
  machine under a high load (all runs at a 1-minute load of 2.7–4.6).
- Why run D's timings were higher than A's and B's (*Run to run*).
- Sessions longer than 300 saves or kept for hours; whether macOS's compression of an idle
  session slows its next requests (one observation below, not established).
- A cold start from an empty disk cache: the script copies the package right before it
  measures (which reads every source file), and the installed `prelude`/`base` TTCs had been
  read by the runs before.

## Preliminary runs

Two earlier runs used earlier versions of the script (the same command line, requests and steps;
before the footprint readings, and the first also before (f′)). Their JSON, as those versions
wrote it, is in [`first-load-2026-09-28/`](first-load-2026-09-28/): `run-0.json` and `run-1.json`
(copied from the runs' `/tmp` output on 2026-09-28, unchanged). Run 0 (16:57, `Language.JSON`
only): cold 1,256 ms (18 built), `time -l` max RSS 253 MiB,
`:type-of` median 3.61 ms and the first `:repl-completions` 489 ms. Run 1 (16:58–16:59, the four
modules): cold 1,327 / 1,749 / 227 / 835 ms. In run 1 the idle RSS (e) of the `Language.JSON`
and `System.Directory.Tree` sessions was 3 MiB — macOS had compressed them — and in the
`Language.JSON` session the (f′) reloads then took 360–375 ms (122–170 ms in runs A, B and D) and
the first `:repl-completions` after them 681–972 ms (237–338 ms in A, B and D; the first of (f)
619 ms). In the `System.Directory.Tree` session the first `:repl-completions` of (f) took 441 ms
and those after the (f′) reloads 328–488 ms (309–423 ms in A, B and D). That is one
observation, not a finding: in run B the idle `Data.Nat.Order.Strict` session was compressed too
(RSS 89 MiB) and its later requests were no slower than in run A.
