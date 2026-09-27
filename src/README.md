# `src/` layout

This is the `src/` part of the repository tree in `docs/ARCHITECTURE.md` §2, annotated with the
milestone (`docs/ROADMAP.md` §5) that creates each part. Only the files marked **skeleton** or
**M0** exist today. Nothing else is stubbed: a folder appears when its milestone lands, never as
an empty module.

```
src/
├─ extension.ts               M0        activate(): log channel, Help commands, the
│                                       idris2.isIdrisDocument context key, selection ranges;
│                                       no process spawn, no file-system access.
│                             Target shape (ARCHITECTURE §2): Log → Config → Toolchain →
│                             ProjectIndex → BackendRegistry → features, each behind a
│                             capability check; deactivate() disposes everything.
├─ core/
│  ├─ log.ts                  skeleton  LogOutputChannel "Idris 2"; the optional
│  │                                    "Idris 2: Protocol Trace" channel comes with M2
│  ├─ disposable.ts           skeleton  DisposableStore
│  ├─ errors.ts               skeleton  IdrisError union (types only in the skeleton); M0 adds
│  │                                    IdrisException (the thrown form), unsupported(reason),
│  │                                    errorText
│  ├─ config.ts               M1 (first idris2.* setting)  typed accessors + change events
│  ├─ positions.ts            M0        the ONLY module converting between the coordinate
│  │                                    conventions of ARCHITECTURE §7, incl. the .lidr offset
│  └─ async.ts                M2        debounce, AsyncQueue, withTimeout, CancellationToken helpers
├─ toolchain/                 M1
│  ├─ discover.ts                       locate idris2 / idris2-lsp / pack
│  ├─ versions.ts                       parse --version, --ttc-version, --paths, …; pair verdict
│  ├─ status.ts                         LanguageStatusItem(s), status QuickPick, Setup Information
│  ├─ pack.ts                           pack detection; user-triggered terminal commands only
│  └─ install.ts                        guided installs as pre-typed terminal commands
├─ project/                   M0, M1
│  ├─ ipkg.ts                 M1        nearest .ipkg upward (compiler's findIpkg walk), model via
│  │                                    idris2 --dump-ipkg-json, fallback reader
│  ├─ index.ts                M1        Document → ProjectRoot | LooseFile; watches **/*.ipkg
│  └─ literate.ts             M0        idrisDocumentSelector() / isIdrisDocument(doc) — the ONE
│                                       selector every registration uses — from a table of
│                                       language ids (idris2, lidr), the idris2.isIdrisDocument
│                                       tracker, birdPrefixWidth(line), and
│                                       compilerLiterateStyleOf(doc) (bird by file name, as the
│                                       compiler decides; for positions.ts); M1 extends the table
│                                       with literate styles by file extension, M12 with content
│                                       detection
├─ backend/
│  ├─ types.ts                M0        IdrisBackend, Capabilities, domain types (ARCHITECTURE §3.1),
│  │                                    EditKind / EditRequest / EditResult (§3.3)
│  ├─ null.ts                 M0        NullBackend: every capability false, every call rejects
│  │                                    with Unsupported
│  ├─ registry.ts             M1        minimal: backend registration + status text (first user:
│  │                                    toolchain/status.ts); per-root routing and per-feature
│  │                                    fallback arrive with M2/M5
│  ├─ ide/                    M2, M3    sexp, wire, transport, session, protocol, diagnostics,
│  │                                    highlight, holes, backend
│  ├─ lsp/                    M5        client, commands, backend (vscode-languageclient 10.x)
│  └─ cli/                    M9, M11   runner, diagnostics (text-format parser)
├─ features/                  one folder per feature area
│  ├─ help/                   M0
│  │  └─ commands.ts                    Show Output, Open Settings (@ext:<id>), Open Idris 2
│  │                                    Documentation (static URL via env.openExternal)
│  ├─ syntax/                 M0        syntactic features that need no backend
│  │  ├─ lexer.ts                       tolerant port of the compiler's lexer (tokens, comments,
│  │  │                                 strings, bracket groups); no vscode import
│  │  ├─ selectionRangeModel.ts         token → groups → layout blocks → declaration group →
│  │  │                                 document; no vscode import
│  │  └─ selectionRanges.ts             the SelectionRangeProvider adapter
│  ├─ diagnostics/            M2
│  ├─ intelligence/           M3
│  ├─ eval/                   M3
│  ├─ editing/                M4
│  ├─ holes/                  M4
│  ├─ goalPanel/              M7
│  ├─ shadow/                 M6
│  ├─ repl/                   M8
│  ├─ tasks/                  M9
│  ├─ tests/                  M10
│  ├─ ipkg/                   M11
│  ├─ literate/               M12
│  ├─ unicode/                M13
│  └─ extras/                 M14
└─ webview/
   └─ goalPanel.ts            M0 stub, M7  goal panel front-end (vanilla TS); second esbuild entry
```

Milestone attributions come from the tags in ARCHITECTURE §2 and the scopes in ROADMAP §5.
§2 tags no `core/` file and not `backend/registry.ts` with a milestone. `core/positions.ts` is
M0 by ROADMAP M0's scope list; `log.ts`, `errors.ts` and `disposable.ts` exist since the
skeleton. The milestones of the remaining three are inferred from their first users:
`core/config.ts` (the first `idris2.*` settings are M1's `toolchain.*`, §11), `core/async.ts`
(`backend/ide/session.ts`, M2) and `backend/registry.ts` (M1: ROADMAP M1's `LanguageStatusItem`
"whose text comes from the registry" — `· syntax only` until a backend registers — and
ARCHITECTURE §2's entry for `toolchain/status.ts`, tagged M1, say the same). `features/help/`
and `features/syntax/` hold M0's Help group and selection ranges (ROADMAP M0); ARCHITECTURE §2
lists them since M0. Feature modules export a `register…` function that returns a Disposable
and takes only what the feature needs (`registerHelpCommands(log, extensionId)`,
`registerSelectionRanges()`).

Rules that already apply (ARCHITECTURE §2): `features/*` never import from `backend/ide` or
`backend/lsp` directly, only from `backend/types.ts` and `backend/registry.ts`;
`core/positions.ts` is the only module that adds or subtracts 1 from a line or column. Every
registration uses `idrisDocumentSelector()` (D21). Modules that are unit-tested import `vscode`
only as types.
