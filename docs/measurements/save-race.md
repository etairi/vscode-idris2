# A save during a load

What the race of review 1's N1 does on the real compiler, and what `src/backend/ide/buildFiles.ts` does
about it. Taken on 2026-10-30 with `scripts/measure-save-race.mjs`: Idris 2 0.8.0 from Homebrew in IDE
mode, one process, Node 24.13.0, macOS 27.0.1. A seed fixes the delays only: the rest is the machine's
timing, so a run gives other counts near these.

Each round saves a file, starts a load, saves again during it as VS Code writes a file, and loads once
more, as the check after that save does. Only the second save's text is a right answer.

| When the second save comes | Build files | Rounds | Right | Earlier text | Empty module |
|---|---|---:|---:|---:|---:|
| Anywhere in the load (`--seed 12345`) | left | 40 | 28 | 12 | 0 |
| The same | set back (`--cure`) | 40 | 40 | 0 | 0 |
| Up to 20 ms in, file empty for 15 ms (`--seed 4242 --gap 15 --max-delay 20`) | left | 40 | 3 | 28 | 9 |
| The same | set back | 40 | 40 | 0 | 0 |
| The same (`--seed 9001 --rounds 60`) | set back | 60 | 60 | 0 | 0 |

An empty module is the file read between VS Code's truncation and its write. The compiler loads it
without an error (an empty file answers `(:ok ())`), and `marker` is then `Undefined name`. The first
row's timing is what two quick saves give. The others aim at the moment the compiler reads the file.

Over idris2-lsp the same thing was seen without aiming, in 1 run of 8 of an e2e test that saved right
after an undo: a 29-byte `.ttm`, as an empty file gives, no hover, and a TTC newer than the source.
