# `src/` layout

This is the `src/` part of the repository tree in `docs/ARCHITECTURE.md` §2, annotated with the
milestone (`docs/ROADMAP.md` §5) that creates each part. Only the files marked **skeleton**,
**M0** or **M1** exist today. Nothing else is stubbed: a folder appears when its milestone
lands, never as an empty module.

```
src/
├─ extension.ts               M0, M1    activate(): log channel, Help commands, the
│                                       idris2.isIdrisDocument context key, selection ranges
│                                       (M0); then Config → workspace trust → process runner →
│                                       toolchain service → project index → backend registry →
│                                       status item, Setup Information, install commands,
│                                       notifications (M1). Waits for no process; returns a
│                                       test API only in ExtensionMode.Test. deactivate()
│                                       disposes everything in reverse order.
├─ core/
│  ├─ log.ts                  skeleton  LogOutputChannel "Idris 2" (M1: silent once disposed);
│  │                                    the optional "Idris 2: Protocol Trace" channel comes
│  │                                    with M2
│  ├─ disposable.ts           skeleton  DisposableStore
│  ├─ errors.ts               skeleton  IdrisError union (types only in the skeleton); M0 adds
│  │                                    IdrisException (the thrown form), unsupported(reason),
│  │                                    errorText
│  ├─ config.ts               M1        typed, validated idris2.toolchain.* + change events
│  ├─ event.ts                M1        Event/Emitter without vscode (unit-tested services)
│  ├─ trust.ts                M1        WorkspaceTrust: isTrusted, onDidGrant (Restricted Mode)
│  ├─ process.ts              M1        the ONE process runner: trust gate, one at a time
│  │                                    (FIFO), no shell (Windows .cmd/.bat through quoted
│  │                                    cmd.exe, or refused), process-group termination on
│  │                                    time-out, 1 MiB output limit, dispose at deactivation
│  ├─ positions.ts            M0        the ONLY module converting between the coordinate
│  │                                    conventions of ARCHITECTURE §7, incl. the .lidr offset
│  └─ async.ts                M2        debounce, AsyncQueue, withTimeout, CancellationToken helpers
├─ toolchain/                 M1
│  ├─ types.ts                          the contracts (snapshot, tool states, verdict, runner,
│  │                                    service); types only
│  ├─ discover.ts                       locate idris2 / idris2-lsp / pack (pure, over a probe)
│  ├─ fileSystem.ts                     the file-system probe discover.ts and pack.ts use; the
│  │                                    bounded read of a regular file (pack.toml, .ipkg)
│  ├─ pack.ts                           pack's directories and current collection (file system
│  │                                    only; pack is never started)
│  ├─ versions.ts                       parse --version, --ttc-version, --paths,
│  │                                    --list-packages, idris2-lsp --version
│  ├─ verdict.ts                        the idris2 / idris2-lsp pair verdict
│  ├─ service.ts                        ToolchainService: scans and immutable snapshots
│  ├─ status.ts                         LanguageStatusItem, status QuickPick (= the editor-title
│  │                                    submenu), idris2.packFound
│  ├─ setupInfo.ts                      Show Setup Information, Rescan Toolchain, Report Issue…
│  ├─ notifications.ts                  one-time warnings (compiler missing, likely mismatch)
│  └─ install.ts                        guided installs as pre-typed terminal commands
├─ project/                   M0, M1
│  ├─ types.ts                M1        ProjectRoot | LooseFile, IpkgModel, ProjectIndex (types)
│  ├─ ipkg.ts                 M1        nearest .ipkg upward (the compiler's findIpkg walk, in
│  │                                    directory order, names read with a port of its path
│  │                                    parser), model via idris2 --dump-ipkg-json <absolute
│  │                                    path> (strings read raw), fallback reader (a port of the
│  │                                    compiler's ipkg lexer and grammar)
│  ├─ index.ts                M1        Document → ProjectRoot | LooseFile, cached; invalidated
│  │                                    by **/*.ipkg changes, created or deleted files and
│  │                                    folders, workspace-folder changes and toolchain
│  │                                    snapshots; module ↔ path mapping in the compiler's
│  │                                    nsToSource order
│  └─ literate.ts             M0, M1    idrisDocumentSelector() / isIdrisDocument(doc) — the ONE
│                                       selector every registration uses — from a table of
│                                       language ids (idris2, lidr; M0) and, since M1, pattern
│                                       rows for the double extensions .idr.<ext>/.lidr.<ext>;
│                                       the idris2.isIdrisDocument tracker, birdPrefixWidth(line),
│                                       compilerLiterateStyleOf(doc) (by file name, as the
│                                       compiler decides; for positions.ts), and (M1) the
│                                       compiler's full literate-extension table and module
│                                       source order; M12 adds content detection
├─ backend/
│  ├─ types.ts                M0        IdrisBackend, Capabilities, domain types (ARCHITECTURE §3.1),
│  │                                    EditKind / EditRequest / EditResult (§3.3)
│  ├─ null.ts                 M0        NullBackend: every capability false, every call rejects
│  │                                    with Unsupported
│  ├─ registry.ts             M1        minimal: backend registration per root + status label
│  │                                    (NullBackend → "syntax only"); per-root routing,
│  │                                    per-feature fallback and "stopped" arrive with M2/M5
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
│  │  │                                 document; plain and bird-track text only (the fenced
│  │  │                                 styles wait for M12); no vscode import
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
§2 tags `core/config.ts`, `event.ts`, `trust.ts` and `process.ts` with M1 (they were added in
M1 for the toolchain settings, the toolchain service, Restricted Mode and the probes), and its
entry for `backend/registry.ts` reads "M1: registration + status label only". The other
`core/` files have no tag: `positions.ts` is M0 by ROADMAP M0's scope list; `log.ts`,
`errors.ts` and `disposable.ts` exist since the skeleton; and the milestone of `async.ts` was
inferred from its first user (`backend/ide/session.ts`, M2). `features/help/`
and `features/syntax/` hold M0's Help group and selection ranges (ROADMAP M0); ARCHITECTURE §2
lists them since M0. Feature modules export a `register…` function that returns a Disposable
and takes only what the feature needs (`registerHelpCommands(log, extensionId)`,
`registerSelectionRanges()`).

Rules that already apply (ARCHITECTURE §2): `features/*` never import from `backend/ide` or
`backend/lsp` directly, only from `backend/types.ts` and `backend/registry.ts`;
`core/positions.ts` is the only module that adds or subtracts 1 from a line or column. Every
registration uses `idrisDocumentSelector()` (D21). Modules that are unit-tested import `vscode`
only as types; the M1 UI modules take the `vscode` namespace as a parameter (`api`) for that
reason. Every process the extension starts goes through `core/process.ts` (Restricted Mode, one
at a time).
