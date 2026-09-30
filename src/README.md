# `src/` layout

This is the `src/` part of the repository tree in `docs/ARCHITECTURE.md` §2, annotated with the
milestone (`docs/ROADMAP.md` §5) that creates each part. Only the files marked **skeleton**,
**M0**, **M1**, **M2** or **M3** exist today. Nothing else is stubbed: a folder appears when its milestone
lands, never as an empty module.

```
src/
├─ extension.ts               M0–M3     activate(): log channel, Help commands, the
│                                       idris2.isIdrisDocument context key, selection ranges
│                                       (M0); then Config → workspace trust → process runner →
│                                       toolchain service → project index → backend registry
│                                       (M1); then the consent gate, protocol trace, session
│                                       pool, IDE-mode backend (the registry's provider),
│                                       checks and backend commands (M2); then the providers
│                                       and commands of intelligence/ and eval/ over one
│                                       DocumentQueries (M3); then the status item, Setup
│                                       Information, install commands, notifications.
│                                       Waits for no process; returns a test API only in
│                                       ExtensionMode.Test. deactivate() disposes everything in
│                                       reverse order, which kills every session process.
├─ core/
│  ├─ log.ts                  skeleton  LogOutputChannel "Idris 2" (M1: silent once disposed);
│  │                                    M2: the ProtocolTrace interface the sessions write to
│  │                                    (its channel is features/diagnostics/trace.ts)
│  ├─ disposable.ts           skeleton  DisposableStore
│  ├─ errors.ts               skeleton  IdrisError union (types only in the skeleton); M0 adds
│  │                                    IdrisException (the thrown form), unsupported(reason),
│  │                                    errorText; M3 adds NotLoaded (a query about a file the
│  │                                    check session has not loaded last: load, then ask again)
│  ├─ config.ts               M1–M3     typed, validated idris2.toolchain.* (M1),
│  │                                    idris2.checking.*, ideMode.*, diagnostics.*, trace.*
│  │                                    (M2), inlayHints.*, eval.* (M3) + change events per
│  │                                    group (keybindings.scheme is read by VS Code only)
│  ├─ event.ts                M1        Event/Emitter without vscode (unit-tested services)
│  ├─ trust.ts                M1, M2    WorkspaceTrust: isTrusted, onDidGrant (Restricted Mode);
│  │                                    M2: SessionGate, the consent contract of the sessions
│  ├─ process.ts              M1, M2    the ONE process runner: trust gate, one at a time
│  │                                    (FIFO), no shell (Windows .cmd/.bat through quoted
│  │                                    cmd.exe, or refused), process-group termination on
│  │                                    time-out, 1 MiB output limit, dispose at deactivation;
│  │                                    M2: startLongRunningProcess for session processes (the
│  │                                    same rules without the queue and the output limit)
│  ├─ positions.ts            M0, M3    the ONLY module converting between the coordinate
│  │                                    conventions of ARCHITECTURE §7, incl. the .lidr offset;
│  │                                    M3: the compiler's columns count code points, the
│  │                                    editor's UTF-16 units (E14: codePointsBefore,
│  │                                    utf16Length, with each line's text); the literate
│  │                                    line map (a marker followed only by white space is
│  │                                    two lines of the unlit text, F11 addendum)
│  ├─ notificationText.ts     M2        plainText: every notification message, input-box and
│  │                                    progress text and the status item's detail as text (VS
│  │                                    Code makes links of [label](command:…) in them);
│  │                                    shownPath: a quoted, visible, bounded path
│  └─ untrustedText.ts        M3        compiler text as text: codeBlock (a fence no line of the
│                                       text can close), visible and editorLabel (control and
│                                       format characters and the other default-ignorable
│                                       ones written out as \u{…}; one line for
│                                       labels drawn in the editor), quickPickText (no $(icon))
├─ toolchain/                 M1
│  ├─ types.ts                          the contracts (snapshot, tool states, verdict, runner,
│  │                                    service); types only
│  ├─ discover.ts                       locate idris2 / idris2-lsp / pack (pure, over a probe)
│  ├─ fileSystem.ts                     the file-system probe discover.ts and pack.ts use; the
│  │                                    bounded read of a regular file (pack.toml, .ipkg, the
│  │                                    source files IDE mode's replies name: readSourceFile)
│  ├─ pack.ts                           pack's directories and current collection (file system
│  │                                    only; pack is never started)
│  ├─ versions.ts                       parse --version, --ttc-version, --paths,
│  │                                    --list-packages, idris2-lsp --version
│  ├─ verdict.ts                        the idris2 / idris2-lsp pair verdict
│  ├─ service.ts                        ToolchainService: scans and immutable snapshots
│  ├─ status.ts                         LanguageStatusItem (M2: with the active document's
│  │                                    check), status QuickPick (= the editor-title
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
│                                       the idris2.isIdrisDocument tracker, birdPrefixWidth(line)
│                                       (M3: linePrefixWidth and isDoubledLine for the line
│                                       markers of bird tracks and Org),
│                                       compilerLiterateStyleOf(doc) (by file name, as the
│                                       compiler decides; for positions.ts), and (M1) the
│                                       compiler's full literate-extension table and module
│                                       source order; M12 adds content detection
├─ backend/
│  ├─ types.ts                M0        IdrisBackend, Capabilities, domain types (ARCHITECTURE §3.1),
│  │                                    EditKind / EditRequest / EditResult (§3.3); M2:
│  │                                    LoadResult.packageError; M3: the queries' contract
│  │                                    (answered in the context of the file loaded last,
│  │                                    NotLoaded otherwise), completions, tokens (Token,
│  │                                    TokenIndex), TypeInfo.lookup, Evaluation
│  ├─ null.ts                 M0        NullBackend: every capability false, every call rejects
│  │                                    with Unsupported
│  ├─ registry.ts             M1, M2    one BackendProvider serving every root (M2: IDE mode;
│  │                                    none → NullBackend, "syntax only"), the per-root
│  │                                    BackendState and status label, rootKey; per-root routing
│  │                                    and per-feature fallback arrive with M5
│  ├─ ide/                    M2, M3    (M3 adds highlight, replCommand; M4 holes)
│  │  ├─ types.ts                       the contracts of the layer (types only): s-expressions,
│  │  │                                 frames, messages, IdeCodec, Transport, IdeSession,
│  │  │                                 SessionPool, and who may import whom
│  │  ├─ sexp.ts                        the compiler's s-expression reader, ported; the writer
│  │  │                                 (printable ASCII, non-ASCII as decimal escapes)
│  │  ├─ wire.ts                        framing: request prefixes count UTF-8 bytes, reply
│  │  │                                 prefixes code points (6–8 lower-case hex digits, "("
│  │  │                                 and a reply head); streaming decoder, unframed lines
│  │  │                                 (and a reply glued to output, also after one or two
│  │  │                                 hex digits), the tail (truncated inside a frame),
│  │  │                                 \r\n line ends undone
│  │  ├─ protocol.ts                    ideCodec; request builders and reply decoders (load,
│  │  │                                 lookups, editing commands; M3/M4 use most of them);
│  │  │                                 the F4/F5 predicates; M3: completions, namespace
│  │  │                                 listings, toRichText (highlighting offsets from code
│  │  │                                 points to string offsets, E14)
│  │  ├─ transport.ts                   stdio (the default) and socket (the opt-in; the first
│  │  │                                 port line, 127.0.0.1) transports over
│  │  │                                 startLongRunningProcess; buffer bound
│  │  ├─ session.ts                     the IdeSession state machine: handshake, one request in
│  │  │                                 flight, FIFO (urgent loads first), merged loads,
│  │  │                                 time limits, F4 attribution, unframed output over
│  │  │                                 stdio, a socket taken by another program, backoff
│  │  │                                 and give-up, idle, stop, restart
│  │  ├─ pool.ts                        one session per root and role (check; M3: eval, with
│  │  │                                 its own build/.vscode-idris2-eval): command line, build
│  │  │                                 directory (effectiveCheckBuildDir), trust → toolchain →
│  │  │                                 consent before every spawn, restarts on changes,
│  │  │                                 idris2.ideMode.maxSessions (evicts idle sessions: eval
│  │  │                                 sessions first, then check sessions of other roots,
│  │  │                                 least recently used first)
│  │  ├─ diagnostics.ts                 a load's reply → diagnostic records: files, ranges,
│  │  │                                 messages, severity (known-warning table), .ipkg error
│  │  ├─ highlight.ts       M3          a load's :highlight-source frames → the token index
│  │  │                                 (name, decoration, span; duplicates merged)
│  │  ├─ replCommand.ts     M3          whether the REPL parser could read a text as a command:
│  │  │                                 the refusal of Evaluate Selection (at least as strict
│  │  │                                 as the parser; the argument is in the module comment)
│  │  └─ backend.ts                     IdeBackend (load, with the compiler's package walk done
│  │                                    again right before every load is sent; M3: the queries,
│  │                                    the token index, evaluation in the eval session; holes
│  │                                    and edit Unsupported until M4) and IdeMode, the
│  │                                    registry's provider and the commands' control surface
│  │                                    (M3: onDidLoad, warmUpCompletions)
│  ├─ lsp/                    M5        client, commands, backend (vscode-languageclient 10.x)
│  └─ cli/                    M9, M11   runner, diagnostics (text-format parser)
├─ features/                  one folder per feature area
│  ├─ help/                   M0
│  │  └─ commands.ts                    Show Output, Open Settings (@ext:<id>), Open Idris 2
│  │                                    Documentation (static URL via env.openExternal)
│  ├─ syntax/                 M0        syntactic features that need no backend
│  │  ├─ lexer.ts                       tolerant port of the compiler's lexer (tokens, comments,
│  │  │                                 strings, bracket groups); no vscode import; KEYWORDS
│  │  │                                 exported for M3's completion
│  │  ├─ selectionRangeModel.ts         token → groups → layout blocks → declaration group →
│  │  │                                 document; plain and bird-track text only (the fenced
│  │  │                                 styles wait for M12); no vscode import
│  │  └─ selectionRanges.ts             the SelectionRangeProvider adapter
│  ├─ consent/                M2        the user's consent for sessions outside the trusted
│  │  │                                 workspace folders (ROADMAP §9, 2026-09-27)
│  │  ├─ gate.ts                        ConsentGate implements SessionGate: canonical paths,
│  │  │                                 the question once per directory and window, the
│  │  │                                 folders allowed for good (global state)
│  │  └─ register.ts                    the notification, the status item's Allow… (internal
│  │                                    idris2.allowFolder), Manage Allowed Folders…
│  ├─ diagnostics/            M2
│  │  ├─ checks.ts                      triggers, per-document state, the "idris2"
│  │  │                                 DiagnosticCollection (every result applied in order;
│  │  │                                 kept for closed documents), the status the item shows,
│  │  │                                 checks after automatic restarts, a fixed import or a
│  │  │                                 saved .ipkg, releasing a root's sessions when its last
│  │  │                                 document closes; the active document (its root to the
│  │  │                                 pool) and idris2.ideMode.maxBackgroundChecks
│  │  ├─ commands.ts                    Check File, Restart / Stop Backend, crash notices
│  │  └─ trace.ts                       the "Idris 2: Protocol Trace" channel, Show Protocol
│  │                                    Trace, Send Raw Protocol Request…
│  ├─ intelligence/           M3
│  │  ├─ types.ts                       the contracts of M3's providers (types only): semantic-token
│  │  │                                 legend and decoration mapping, hover model, DocumentQueries
│  │  │                                 (load, then ask again, on NotLoaded), load notifications,
│  │  │                                 IntelligenceDeps; the rules for showing compiler text
│  │  ├─ queries.ts                     DocumentQueries (on NotLoaded, load as Check File does, or
│  │  │                                 wait for the document's running check, and
│  │  │                                 ask again; a passive query loads only the active
│  │  │                                 document), AnswerCache (per file) and StaleAnswers
│  │  │                                 (a load of the root that built something drops them)
│  │  ├─ occurrence.ts                  the name at a position (index token, else the lexer); the
│  │  │                                 index tokens that still apply while the text differs
│  │  ├─ text.ts                        reading compiler text: :docs-for blocks and their
│  │  │                                 overview, declared names, qualified names
│  │  ├─ hover.ts                       the hover model (type, doc overview, stale), the answers
│  │  │                                 it drops, its rendering
│  │  ├─ semanticTokens.ts              idris2-lsp's legend; index → VS Code's encoding; the
│  │  │                                 docs document's spans
│  │  ├─ symbols.ts                     document symbols from M0's syntax model
│  │  ├─ highlights.ts                  document highlights (name + decoration; bound names
│  │  │                                 per clause or signature)
│  │  ├─ docs.ts                        the idris2-doc: document (path, query, the blocks of a
│  │  │                                 qualified name); Browse Namespace…'s items and suggestion
│  │  ├─ completion.ts                  keywords, %-directives and the compiler's names;
│  │  │                                 warm-up after each load of the active file; 150 ms
│  │  │                                 wait, then an incomplete list; answers per file
│  │  ├─ inlayHints.ts                  ": <type>" after the first bound occurrence of each
│  │  │                                 name per top-level declaration (positional :type-of,
│  │  │                                 one at a time, the range VS Code asks about, kept
│  │  │                                 until a load makes them stale; none while dirty or
│  │  │                                 the index is stale)
│  │  └─ register.ts                    registerIntelligence: hover, Type/Docs at Cursor, Show
│  │                                    Documentation…, Browse Namespace…, definition, the
│  │                                    docs content provider, semantic tokens, symbols,
│  │                                    highlights
│  ├─ eval/                   M3
│  │  ├─ evaluation.ts                  the selected expression (bird-track markers dropped,
│  │  │                                 prose refused, lines over several kept at their
│  │  │                                 columns); the label after the line; the hover
│  │  └─ register.ts                    Evaluate Selection and Clear Evaluation Results; the
│  │                                    decorations and their lifecycle; the notification
│  │                                    when inline results are off; Cancel after a second
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
`errors.ts` and `disposable.ts` exist since the skeleton. ARCHITECTURE §2 also lists
`core/async.ts` (debounce, AsyncQueue, withTimeout, CancellationToken helpers); M2 did not
create it, because the one queue, the time limits and the cancellation live in
`backend/ide/session.ts` and the `afterDelay` debounce in `features/diagnostics/checks.ts`
(ARCHITECTURE §2, `core/async.ts`). `backend/ide/types.ts`, `backend/ide/pool.ts` and `features/consent/`
are M2 files that §2 does not list. `features/help/`
and `features/syntax/` hold M0's Help group and selection ranges (ROADMAP M0); ARCHITECTURE §2
lists them since M0. Feature modules export a `register…` function that returns a Disposable
and takes only what the feature needs (`registerHelpCommands(log, extensionId)`,
`registerSelectionRanges()`).

Rules that already apply (ARCHITECTURE §2): `features/*` never import from `backend/ide` or
`backend/lsp` directly, only from `backend/types.ts` and `backend/registry.ts` (M2: the
commands, the trace and the checks get the IDE-mode controls as interfaces that `extension.ts`
fills from `IdeMode`);
`core/positions.ts` is the only module that adds or subtracts 1 from a line or column (but M1's
fallback `.ipkg` parser, `project/ipkg.ts`, which counts its lexer's positions into the 1-based
ones the compiler prints). Every
registration uses `idrisDocumentSelector()` (D21). Modules that are unit-tested import `vscode`
only as types; the M1 UI modules take the `vscode` namespace as a parameter (`api`) for that
reason. Every process the extension starts goes through `core/process.ts` (Restricted Mode;
probes one at a time; M2's session processes through `startLongRunningProcess`, after the
consent gate).
