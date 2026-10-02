# vscode-idris2 — technical architecture

Status: design document, 2026-09-23. Companion to `ROADMAP.md` (what to build, in which
increments) and `landscape.md` (the verified survey this design rests on). This file is the
specification the skeleton and every milestone are built to; `src/README.md` and
`test/README.md` mark which parts exist (as of M4, 2026-09-30: the parts tagged M0, M1, M2, M3 or
M4 below, M4 for IDE mode only; `docs/as-built/M0.md` … `M4.md` record where the code departs from
this text, with the evidence).

Evidence tags follow `landscape.md`: **[live]** run on this machine (macOS arm64, Homebrew
`idris2` 0.8.0) during the planning session, **[src]** read in the named checkout (`idris2-lsp`
`9a2f0ad`, Idris2 master `1c630e6`), **[doc]** from a README/spec, **[open]** not verified.
Facts established beyond `landscape.md` are collected in `ROADMAP.md` §0; this document cites
them by number (F1, F2, …) where a design choice depends on one.

---

## 1. Goals that shape the architecture

1. **Two backends, one feature surface.** Every feature is written against `IdrisBackend`.
   The compiler's IDE protocol (`idris2 --ide-mode`) is always available; `idris2-lsp`
   is richer but version-locked, ipkg-required and save-gated (landscape §3). Either can be
   built first; both can coexist per project root.
2. **Protocol facts live in one place.** Wire format, coordinate conventions and reply shapes
   are isolated in `src/backend/ide/` and `src/core/positions.ts`, each pinned by tests that
   replay frames recorded from a real compiler. A compiler release should touch ≤ 3 files.
3. **Never corrupt the checking session.** Program output over stdio IDE mode is unframed
   (F5); `:set` persists across loads. Therefore: evaluation runs in a *separate* session from
   checking, and the `check` session, which sends no `:exec` of its own, reads unframed output as
   the process's own. (Until 2026-09-28: "socket transport by default"; the user chose stdio for the
   `check` session on every platform, because the socket's port serves the first local
   connection unauthenticated — D1, ROADMAP §9 Q20.)
4. **Honest state.** Every result is labelled with its source (saved file, unsaved shadow copy,
   build) and the backend that produced it; nothing is faked with regexes.
5. **Testable without VS Code, then with VS Code, then with the compiler.** Unit → integration
   (fake compiler/server replaying transcripts) → e2e (real toolchain).
6. **No telemetry, no network.** The only network-adjacent actions are user-initiated terminal
   commands (`pack …`) and opening a docs URL.

---

## 2. Repository and `src/` layout

```
vscode-idris2/
├─ package.json                  manifest: engines.vscode ^1.138.0; contributes: languages,
│                                grammars, semanticTokenTypes/Scopes, configuration (idris2.*),
│                                configurationDefaults for [idris2]/[lidr] (M0), commands,
│                                keybindings (each milestone contributes only the bindings of
│                                commands it registers, §10), menus (editor/title submenu
│                                "Idris 2" + commandPalette when-clauses, M1), viewsContainers/
│                                views, taskDefinitions, problemMatchers, tomlValidation for
│                                pack.toml (M11), walkthroughs (minimal M1, polished M15)
├─ scripts/                                                                         (M0)
│  ├─ deps-graph.mjs             regenerates ROADMAP §4's Mermaid graph from docs/milestones.yaml
│  ├─ build-grammar.mjs          syntaxes/src/idris2.grammar.mjs → syntaxes/idris2.tmLanguage.json
│  │                             (--check: fail if the committed JSON is stale)
│  ├─ build-language-configuration.mjs
│  │                             → language-configuration/{idris2,lidr,ipkg}.json (--check, run
│  │                             by test/unit/languageConfiguration.test.ts)
│  ├─ check-fixtures.mjs         idris2 --check / --dump-ipkg-json on every fixture and every
│  │                             snippet expansion, in a temp copy
│  └─ fetch-corpus.mjs           fetches the pinned real-world corpora (test/corpus/corpus.json)
│                                into .corpus/ (git-ignored, never committed)
├─ schemas/pack.toml.schema.json authored from the pack README (M11, provenance in the file)
├─ esbuild.mjs                   two entries: src/extension.ts → dist/extension.js (cjs, node,
│                                external: vscode); src/webview/goalPanel.ts → dist/goalPanel.js
│                                (iife, browser). --minify for release, sourcemaps in dev.
├─ tsconfig.json                 strict, noUnusedLocals; target es2022; module node16; noEmit
│                                (esbuild emits)
├─ eslint.config.mjs             typescript-eslint, flat config
├─ .vscode-test.mjs              @vscode/test-cli: one suite per fixture workspace; explicit
│                                --user-data-dir (F17: >103-char socket paths fail; M0 uses
│                                <checkout>/.vscode-test/user-data, so keep the checkout short;
│                                M1: one profile per suite, checked against the limit, and
│                                --force-disable-user-env)
├─ .vscodeignore                 excludes src/, test/, docs/, fixtures
├─ language-configuration/       idris2.json, lidr.json, ipkg.json (generated by
│                                scripts/build-language-configuration.mjs, committed)
├─ syntaxes/                     idris2.tmLanguage.json (generated, committed), lidr.tmLanguage.json,
│  │                             ipkg.tmLanguage.json (M0); injections/{markdown,latex,org,typst}.json
│  │                             (M12)
│  └─ src/idris2.grammar.mjs     the idris2 grammar's generator: keyword/pragma/operator lists as
│                                data, each cited to the lexer or parser line (M0; not shipped)
├─ snippets/                     idris2.json, ipkg.json
├─ media/                        walkthrough/*.md (the M1 walkthrough's pages); icons; goal
│                                panel CSS (codicons via @vscode/codicons)
├─ docs/                         landscape.md, ROADMAP.md, ARCHITECTURE.md, milestones.yaml (M0,
│                                input of scripts/deps-graph.mjs), checklists/, upstream.md
├─ src/
│  ├─ extension.ts               activate(): Log → Config → Toolchain → ProjectIndex →
│  │                             BackendRegistry → features (each behind a capability check);
│  │                             deactivate(): dispose everything, kill all sessions
│  ├─ core/
│  │  ├─ log.ts                  LogOutputChannel "Idris 2"; optional "Idris 2: Protocol Trace"
│  │  ├─ config.ts               typed accessors for every idris2.* setting + change events (M1)
│  │  ├─ event.ts                Event/Emitter without vscode, for unit-tested services  (M1)
│  │  ├─ trust.ts                WorkspaceTrust (isTrusted, onDidGrant): Restricted Mode  (M1)
│  │  ├─ process.ts              the ONE process runner: refuses to start anything in an
│  │  │                          untrusted workspace, one process at a time (FIFO), no shell
│  │  │                          (Windows .cmd/.bat via quoted cmd.exe or refused), process-
│  │  │                          group termination on time-out, 1 MiB output limit,
│  │  │                          dispose at deactivation                              (M1)
│  │  │                          as built (M2): startLongRunningProcess starts the session
│  │  │                          processes under the same rules, without the queue and the
│  │  │                          output limit
│  │  ├─ errors.ts               IdrisError union: ToolchainMissing | VersionMismatch |
│  │  │                          BackendCrashed | RequestTimeout | ProtocolError | NoIpkg |
│  │  │                          IpkgParseError | DirtyDocument | LoadFailed | Unsupported(reason)
│  │  │                          (as built, M3: also NotLoaded — a query about a file the check
│  │  │                          session has not loaded last; the caller loads it and asks again)
│  │  ├─ positions.ts            the ONLY module converting between the five coordinate
│  │  │                          conventions (§7) incl. the .lidr column offset; as built (M3):
│  │  │                          compiler columns in code points ↔ editor columns in UTF-16 units
│  │  │                          (E14)
│  │  ├─ notificationText.ts     (as built, M2) plainText: notification messages and the
│  │  │                          status item's detail as text, never `[..](command:..)` links
│  │  ├─ untrustedText.ts        (as built, M3) compiler text shown as text: a code fence no line
│  │  │                          of it can close, control and format characters written out,
│  │  │                          one-line labels, QuickPick texts without theme icons
│  │  ├─ idrisLexer.ts           (as built, M4) the compiler's lexer ported rule by rule,
│  │  │                          resumable at line breaks (lexText): M0's lex runs it on a
│  │  │                          whole text, the edits' line reader a line at a time
│  │  ├─ idrisSyntax.ts          (as built, M4) Idris 2 source read without the compiler: the
│  │  │                          parser's tables and the lexer's (re-exported), the edits' line
│  │  │                          reader on idrisLexer.ts (Make With's clause and Case Split's
│  │  │                          line for the backend and the light bulb), isOneToken,
│  │  │                          opensBlockOnLine (the blocks of Idris/Parser.idr),
│  │  │                          holdsBlockHeader and firstTokenColumn
│  │  ├─ async.ts                debounce, AsyncQueue, withTimeout, CancellationToken helpers
│  │  │                          (as built: not created in M2 — the queue, time limits and
│  │  │                          cancellation are in backend/ide/session.ts, the afterDelay
│  │  │                          debounce in features/diagnostics/checks.ts)
│  │  └─ disposable.ts
│  ├─ toolchain/                                                                     (M1)
│  │  ├─ types.ts                the toolchain contracts: ToolchainSnapshot, ToolState, Verdict,
│  │  │                          ProcessRunner, ToolchainService (types only)
│  │  ├─ discover.ts             locate idris2 / idris2-lsp / pack: settings (only) → PATH →
│  │  │                          pack (its bin dir, ~/.local/bin or $PACK_BIN_DIR;
│  │  │                          <state>/install/<collection>/bin if it exists) →
│  │  │                          /opt/homebrew/bin, /usr/local/bin (macOS, Linux) →
│  │  │                          ~/.idris2/bin; absolute directories only (Windows: drive
│  │  │                          or UNC root)
│  │  ├─ fileSystem.ts           the file-system probe the search takes (faked in unit tests);
│  │  │                          the bounded read of a regular file (pack.toml, .ipkg; as built,
│  │  │                          M3: the source files IDE mode's replies name, readSourceFile)
│  │  ├─ pack.ts                 pack's directories and current collection, read from the file
│  │  │                          system; pack is never started (F22 corrections)
│  │  ├─ versions.ts             parse `idris2 --version`, `--ttc-version`, `--paths`,
│  │  │                          `--list-packages`, `idris2-lsp --version`
│  │  ├─ verdict.ts              pair verdict (D20; docs/as-built/M1.md)
│  │  ├─ service.ts              ToolchainService: scans (one at a time; on activation,
│  │  │                          settings change, trust grant, Rescan) → immutable snapshots
│  │  ├─ status.ts               LanguageStatusItem whose text comes from the registry
│  │  │                          ("· syntax only" until a backend registers); status QuickPick
│  │  │                          = the editor/title submenu's entries; idris2.packFound
│  │  ├─ setupInfo.ts            "Show Setup Information" document, "Rescan Toolchain",
│  │  │                          "Report Issue…" (vscode.openIssueReporter, pre-filled)
│  │  ├─ notifications.ts        one-time warnings: compiler missing, likely mismatch
│  │  └─ install.ts              "Install Idris 2…", "Install pack…", "Install idris2-lsp":
│  │                             pre-typed terminal commands, never executed (F36 [doc]);
│  │                             as built: terminals start in the home directory
│  ├─ project/                                                                   (M0, M1)
│  │  ├─ types.ts                ProjectRoot | LooseFile, IpkgModel, ProjectIndex (types; M1)
│  │  ├─ ipkg.ts                 nearest .ipkg upward from a file to the filesystem root —
│  │  │                          the compiler's own findIpkg walk (F13), uncapped; model via
│  │  │                          `idris2 --dump-ipkg-json`; parse errors → the root's model
│  │  │                          (status error, the compiler's message and range;
│  │  │                          docs/as-built/M1.md); fallback reader when idris2 is
│  │  │                          absent or not run (as built: a port of the compiler's
│  │  │                          ipkg grammar)
│  │  ├─ index.ts                Document → ProjectRoot(ipkg dir, model) | LooseFile(dir);
│  │  │                          watches **/*.ipkg and every created/deleted path (folders
│  │  │                          included); module name ↔ path mapping
│  │  └─ literate.ts             (M0) idrisDocumentSelector() + isIdrisDocument(doc) — the
│  │                             ONE selector every provider/command/view registers with —
│  │                             the idris2.isIdrisDocument context key, bird-track prefix
│  │                             width per line, and the compiler's bird style by file name
│  │                             (§7); (M1) the other literate styles of the Unlit.idr
│  │                             extension table, selector rows for the double extensions
│  │                             .idr.<ext>/.lidr.<ext>; (M12) content detection, fences
│  ├─ backend/
│  │  ├─ types.ts                IdrisBackend interface, Capabilities, domain types (Hole,
│  │  │                          Premise, TypeInfo, EditRequest/EditResult, Loaded…)   (M0)
│  │  ├─ null.ts                 NullBackend: every capability false, every call Unsupported (M0)
│  │  ├─ registry.ts             per-ProjectRoot backend choice (auto | lsp | ideMode), per-
│  │  │                          feature fallback, lifecycle (start lazily, stop on close);
│  │  │                          M1: registration + status label only; as built (M2): one
│  │  │                          BackendProvider for every root, BackendState, pendingLabel
│  │  ├─ ide/                                                                        (M2, M3)
│  │  │  ├─ types.ts             (as built, M2) the layer's contracts, types only: s-expressions,
│  │  │  │                       frames, messages, IdeCodec, Transport, IdeSession, SessionPool
│  │  │  ├─ sexp.ts              s-expression parser/serializer; escapes " and \; bare-symbol
│  │  │  │                       commands (:version, :proof-search-next, :generate-def-next);
│  │  │  │                       as built: a port of the compiler's reader, and every character
│  │  │  │                       outside printable ASCII written as a decimal escape (F1)
│  │  │  ├─ wire.ts              6-hex length framing: requests count UTF-8 bytes, replies
│  │  │  │                       count code points (F1); streaming splitter;
│  │  │  │                       tolerant of the unframed EOF tail and other non-hex noise;
│  │  │  │                       as built: a reply header is 6–8 lower-case hex digits, "(" and
│  │  │  │                       a reply head; a tail cut inside a frame is `truncated`; a reply
│  │  │  │                       glued to output is cut out of the line, also after one or two
│  │  │  │                       hex digits; `\r\n` line ends are undone (E13)
│  │  │  ├─ transport.ts         StdioTransport (default, D1) | SocketTransport (opt-in in user
│  │  │  │                       settings: `--ide-mode-socket`, read port from stdout, net.connect)
│  │  │  ├─ session.ts           IdeSession state machine (§5): one in-flight request, FIFO,
│  │  │  │                       timeouts, id-mismatch attribution, backoff, loaded-file tracking
│  │  │  ├─ pool.ts              (as built, M2) SessionPool: one session per root and role, the
│  │  │  │                       command line (§5.2), effectiveCheckBuildDir, trust → toolchain
│  │  │  │                       → consent gate before every spawn, restarts on changes
│  │  │  ├─ protocol.ts          typed request builders + reply decoders for every command
│  │  │  ├─ diagnostics.ts       :warning frames → Diagnostic (severity rule, message split,
│  │  │  │                       ipkg-error mapping)
│  │  │  ├─ highlight.ts         :highlight-source frames → token index of name/decor/span
│  │  │  │                       only (semantic tokens, document symbols/highlights, the
│  │  │  │                       :bound tokens inlay hints ask :type-of about); the frames'
│  │  │  │                       :type/:doc-overview are always "" (F33); as built (M3):
│  │  │  │                       document symbols come from M0's syntax model instead
│  │  │  ├─ replCommand.ts       (as built, M3) whether the REPL parser could read a text as a
│  │  │  │                       command: Evaluate Selection's refusal (ROADMAP §9, 2026-09-28)
│  │  │  ├─ holes.ts             (as built, M4) the :metavariables answer → Hole, located by
│  │  │  │                       the :name-at entry of its qualified name
│  │  │  ├─ edits.ts             (as built, M4) per EditKind: the request, the refusals before
│  │  │  │                       sending, where the reply goes (E15), the literate repairs
│  │  │  └─ backend.ts           IdeBackend implements IdrisBackend over a SessionPool
│  │  ├─ lsp/                                                                        (M5)
│  │  │  ├─ client.ts            LanguageClient (vscode-languageclient/node 10.x) factory,
│  │  │  │                       initializationOptions, didChangeConfiguration forwarding,
│  │  │  │                       ownership middleware, RequestCancelled tolerance, stop/restart
│  │  │  ├─ commands.ts          executeCommand wrappers: repl, metavars, exprSearchWithHints,
│  │  │  │                       refineHole, browseNamespace
│  │  │  └─ backend.ts           LspBackend implements IdrisBackend; holes() via metavars and
│  │  │                          edit() via codeAction selected by title (§3.3) are owned by
│  │  │                          whichever of M4/M5 ships second (ROADMAP M4/M5 scope)
│  │  └─ cli/                                                                        (M9, M11)
│  │     ├─ runner.ts            execFile/spawn idris2 or pack with cwd, env, cancellation
│  │     └─ diagnostics.ts       parser for the landscape §4.2 text format; stem → path mapping
│  ├─ features/                  one folder per feature area; each exports a register…(…)
│  │  │                          function returning a Disposable, taking only what it needs
│  │  │                          (ctx, deps once a feature needs them)
│  │  ├─ help/                   Show Output, Open Settings, Open Idris 2 Documentation (M0);
│  │  │                          Show Keybindings (M4, keybindings.ts, types.ts)
│  │  ├─ syntax/                 lexer.ts (lex: the tokens and bracket groups of
│  │  │                          core/idrisLexer.ts),
│  │  │                          selectionRangeModel.ts (token → groups → layout blocks →
│  │  │                          declaration → document), selectionRanges.ts (provider)  (M0)
│  │  ├─ consent/                (as built, M2) the consent gate of sessions outside the
│  │  │                          trusted workspace folders (ROADMAP §9, 2026-09-27): gate.ts,
│  │  │                          register.ts (question, Allow…, Manage Allowed Folders…)
│  │  ├─ diagnostics/            three DiagnosticCollections (§8)                    (M2)
│  │  │                          as built: checks.ts (triggers, states, the "idris2"
│  │  │                          collection), commands.ts (Check File, Stop/Restart Backend,
│  │  │                          crash notices), trace.ts (Protocol Trace, Send Raw)
│  │  ├─ intelligence/           hover, Type/Docs at Cursor, definition, semanticTokens,
│  │  │                          documentSymbols, documentHighlights, completion, docs
│  │  │                          virtual document, inlay hints (pattern-variable types) (M3);
│  │  │                          as built: types.ts, queries.ts, occurrence.ts, text.ts,
│  │  │                          hover.ts, semanticTokens.ts, symbols.ts, highlights.ts,
│  │  │                          docs.ts, completion.ts, inlayHints.ts, register.ts
│  │  ├─ eval/                   evaluate selection (eval session), inline decorations (M3);
│  │  │                          as built: evaluation.ts, register.ts
│  │  ├─ editing/                commands, CodeActionProvider, CyclingController,
│  │  │                          save-before-action, keybinding schemes                (M4)
│  │  │                          as built: types.ts, commands.ts, targets.ts, apply.ts,
│  │  │                          cycling.ts, codeActions.ts, saveBeforeAction.ts,
│  │  │                          longRunning.ts, messages.ts, register.ts (the schemes
│  │  │                          are package.json's)
│  │  ├─ holes/                  HoleModel, tree view, next/previous, QuickPick       (M4)
│  │  │                          as built: types.ts, model.ts, tree.ts, navigation.ts,
│  │  │                          workspaceContext.ts (idris2.isIdrisWorkspace), register.ts
│  │  ├─ goalPanel/              WebviewPanel host + message protocol (§9)            (M7)
│  │  ├─ shadow/                 shadow typecheck of dirty buffers (§6.3)             (M6)
│  │  ├─ repl/                   terminal REPL, send-to-REPL, `-- >>>` code lens      (M8)
│  │  ├─ tasks/                  TaskProvider, Pseudoterminal build runner, run lens  (M9)
│  │  ├─ tests/                  TestController for Test.Golden suites                (M10)
│  │  ├─ ipkg/                   completion, validation, modules sync, scaffold        (M11)
│  │  ├─ literate/               routing of literate documents, injection glue        (M12)
│  │  ├─ unicode/                abbreviation trie, input controller                  (M13)
│  │  └─ extras/                 namespace browser, workspace symbols, type-definition
│  │                             heuristic, docs links                                (M14)
│  └─ webview/
│     └─ goalPanel.ts            goal panel front-end (vanilla TS, no framework)      (M7)
└─ test/
   ├─ unit/                      mocha on Node, no vscode: sexp, wire, positions, decoders,
   │                             diagnostics mapping, cli parser, ipkg json, versions, trie,
   │                             IdeSession against a FakeTransport (fault injection)
   ├─ grammar/                   TextMate snapshot tests (vscode-textmate + vscode-oniguruma),
   │                             snapshots/*.snap, the corpus and performance tests      (M0)
   ├─ corpus/                    corpus.json (pinned real-world repositories, tokenised at test
   │                             time), lexer-oracle/LexDump.idr (the compiler's own lexer as a
   │                             reference, opt-in: IDRIS2_LEXER_ORACLE=1)               (M0)
   ├─ integration/               @vscode/test-cli suites per fixture workspace, driven by the
   │                             fake compiler / fake LSP server (no toolchain needed); M1:
   │                             the terminal recorder the e2e suite shares
   ├─ e2e/                       same runner, real idris2 (IDRIS2_E2E=1 or npm run test:e2e;
   │                             M1); LSP suites need idris2-lsp; IDRIS2_RECORD=1 refreshes
   │                             transcripts (as built, M2: scripts/record-transcripts.mjs,
   │                             npm run record:transcripts, does)
   ├─ fake-idris2/               Node script replaying transcripts over stdio and socket; M1:
   │                             recorded --ttc-version/--paths/--list-packages/--dump-ipkg-json
   ├─ fake-tools/                (M1) sh and .cmd launchers of the fake idris2, idris2-lsp and
   │                             pack; fault modes; simulated pack layouts
   ├─ fake-lsp/                  Node script (vscode-languageserver) replaying JSON-RPC
   └─ fixtures/
      ├─ transcripts/<idris2-version>/*.jsonl   recorded IDE-mode sessions
      ├─ cli/<idris2-version>/*.txt              recorded --check/--build output
      ├─ ipkg/                                    package files for the ipkg reader (M1): errors,
      │                                           escapes, comments, versions, two .ipkg in one
      │                                           directory, literate module sources
      ├─ grammar/*.idr, *.lidr, *.ipkg            tokenisation fixtures (M0); ipkg-sources/ holds
      │                                           the modules the .ipkg fixtures list; NOTICE.md
      │                                           attributes the excerpts
      └─ workspaces/  loose-file/  simple-ipkg/ (sourcedir=src, depends=contrib)
                      multi-module/  broken/ (type + coverage errors)  literate/
                      golden-tests/  (Test.Golden layout)
```

Naming rules: `features/*` never import from `backend/ide` or `backend/lsp` directly, only
from `backend/types.ts` and `backend/registry.ts`. `core/positions.ts` is the only module that
adds or subtracts 1 from a line or column (as built, one exception from M1: the fallback `.ipkg`
parser `project/ipkg.ts` counts its own lexer's positions into the 1-based ones the compiler
prints).

---

## 3. Backend abstraction

### 3.1 The interface

```ts
// src/backend/types.ts
export type BackendKind = 'ideMode' | 'lsp' | 'null';

export interface Capabilities {
  diagnostics: boolean;        // load + errors
  hover: boolean; definition: boolean; completion: boolean; signatureHelp: boolean;
  semanticTokens: boolean; documentSymbols: boolean; documentHighlights: boolean;
  holes: boolean; holeLocations: boolean;          // LSP metavars has locations; IDE via :name-at
  editing: boolean; editingNext: boolean;          // -next cycling: IDE native; LSP partial
  intro: boolean; refine: boolean; missingCases: boolean;
  evaluate: boolean; docs: boolean; browseNamespace: boolean;
  checksUnsaved: boolean;                          // true only for the shadow backend (M6)
}

export interface IdrisBackend {
  readonly kind: BackendKind;
  readonly caps: Readonly<Capabilities>;
  load(doc: vscode.TextDocument, options?: LoadOptions): Promise<LoadResult>; // diagnostics (+ token index)
  typeAt(doc, pos: vscode.Position, name: string): Promise<TypeInfo | undefined>;
  docsFor(name: string, mode: 'overview' | 'full'): Promise<RichText | undefined>;
  definition(doc, pos, name): Promise<vscode.Location[]>;
  holes(doc, options?: HolesOptions): Promise<Hole[]>;                  // as built (M4): `kept` for the view, `token` for List Holes
  edit(req: EditRequest): Promise<EditResult>;                          // §3.3
  evaluate(expr: string): Promise<RichText>;
  browseNamespace(ns: string): Promise<NamespaceEntry[]>;
  dispose(): void;
}
```

`LoadOptions` (added in M2 for ROADMAP §9 Q21): `urgent?: () => boolean`, asked each time the
backend chooses the next request for the root's compiler; while it returns true the load goes
before the root's requests that wait and are not being sent yet. The checks set it for the active
document's load while `idris2.ideMode.maxBackgroundChecks` is above 0 (§6.2); a backend without a
queue of its own ignores it.

Every method either returns a typed result or throws an `IdrisError`; `Unsupported(reason)`
is an ordinary outcome that the UI turns into a sentence ("needs idris2-lsp", "save the file
first", "stubbed in this compiler version"), never a silent no-op.

`NullBackend` (all capabilities `false`) is defined in M0 so that the LSP backend (M5) and the
IDE backend (M2) can be built in either order and every feature can be registered
unconditionally behind `caps` checks.

**As built (M3).** The query methods take the document whose context answers them —
`docsFor(doc, name, mode)`, `browseNamespace(doc, ns)`, `evaluate(doc, expr)` returning an
`Evaluation` (a value, or the compiler's error about the expression, which is an answer, not a
failure) — and M3 adds `completions(doc, prefix)` and the synchronous `tokens(doc)` (the token
index of the file's last load that sent highlighting; `TokenIndex` in `backend/types.ts`). In IDE
mode a query is answered by the root's `check` session in the context of the file it loaded last
(the compiler keeps one loaded file, F2); for another file it rejects with `NotLoaded` at once,
having sent and started nothing, and the caller (`features/intelligence` `DocumentQueries`) loads
the document the way **Check File** does (or waits for the check of it that is already running)
and asks again. `TypeInfo` says how the type was found
(`lookup: 'position' | 'name'`). `typeAt` and `definition` take the decoration the caller's token
index gives the occurrence (`decor?: Decor`): a `bound` one is not looked up by name (the backend
used its own index at the editor position until the third review of M3, which describes the saved
file); `definition` also takes the token's namespace, which picks the definitions of that name
in it (fourth review of M3). A position is one of the text the document shows; while that differs
from the text the compiler loaded, IDE mode asks about it where it lies in the loaded text (the
loaded text split at a lone `\r` as VS Code splits it, exactly for a file that is not literate
— in a literate file the unlit step reads a lone `\r` otherwise, not modelled —, then a line diff:
`core/positions.ts` `textMap`, `lineCorrespondence`; seventh review of M3). A definition's range in
the loaded file is converted with the text the load read and moved to the text the document shows;
one in another file is read from disk and moved to the lines VS Code shows of it — its open
document's text, or, when none is open, the file's own lines as VS Code breaks them (they differ
after a lone `\r`); after a change of that file on disk that no load has built — a save under the
`manual` trigger, or a change outside VS Code under any trigger — it may be off
(`docs/as-built/M3.md`, *Open issues*). Details: `backend/types.ts` and `docs/as-built/M3.md`,
*Queries*.

### 3.2 Registry and routing

`BackendRegistry` maps a **ProjectRoot** (the directory of the nearest `.ipkg` found walking
up from a document **to the filesystem root** — the same walk the compiler's `findIpkg` does
from the process cwd (F13), so the extension and the compiler always agree on which ipkg
governs a file even when the workspace folder is opened inside the package; the workspace
folder only limits which projects the UI lists — else the document's directory for a loose
file) to one *primary* backend and an optional *secondary* one. The status item's text is
derived from this registry: `· syntax only` while no backend is registered for the document's
root, `· IDE mode` / `· idris2-lsp` / `stopped` otherwise (goal 4).

**One document selector.** Every provider, command enablement, view and keybinding `when`
clause is registered with `idrisDocumentSelector()` / `isIdrisDocument(doc)` / the
`idris2.isIdrisDocument` context key from `project/literate.ts` (M0), never with a bare
language id: literate documents keep their host language ids (`markdown`, `latex`, …, ROADMAP
M12), so a language-id selector would silently exclude them and M12 would have to retrofit
every registration made by M2–M5. The one deliberate exception is the `LanguageClient`'s own
`documentSelector` (`idris2` + `lidr`, M5): whether the server accepts literate files is
[open] (E1), and ownership is enforced by middleware anyway. In M0 the selector is built from
language rows only (`idris2`, `lidr`): `.lidr` has its own id, and a pattern row would select
documents that `isIdrisDocument` (keyed on `languageId`) rejects. Rows selected by file pattern
or content come with M1's extension table and M12, each with the matching `isIdrisDocument`
test (`docs/as-built/M0.md`). As built in M1: pattern rows `**/*.idr.<ext>` and
`**/*.lidr.<ext>` for each literate extension, which VS Code matches on the file path, and an
`isIdrisDocument` that tests the same suffixes on `document.fileName`; a bare `.md`, `.tex`,
`.org` or `.typ` is selected only from M12 (`docs/as-built/M1.md`).

Policy for `idris2.backend.mode`:

| mode | primary | secondary |
|---|---|---|
| `auto` (default) | `lsp` iff `idris2-lsp` is found **and** the pair verdict is compatible **and** the root has an `.ipkg` (the server requires one [src]) **and** the document is not literate (server acceptance [open]); else `ideMode` | the other one, if it can serve that root |
| `lsp` | `lsp` (error status if unavailable) | none |
| `ideMode` | `ideMode` | none |

Per-feature fallback: when the primary lacks a capability (LSP has no `-next` cycling or
`intro` list; IDE mode has no signature help), the registry answers from the secondary if one
is running for that root. Loose files are always `ideMode` (server needs an ipkg [src]).

**LSP ownership is enforced with `LanguageClientOptions.middleware`, not with document
selectors**: the single `LanguageClient` (the server keeps one open file and declares
`workspaceFolders.supported = false` [src]) sees all `idris2`/`lidr` documents, and each
middleware hook returns `undefined`/`[]` for documents whose root is not LSP-owned. This lets
a root switch backend at runtime without restarting the client.

### 3.3 Edits

```ts
type EditKind = 'caseSplit' | 'addClause' | 'makeLemma' | 'makeCase' | 'makeWith'
              | 'exprSearch' | 'exprSearchNext' | 'generateDef' | 'generateDefNext'
              | 'intro' | 'refine' | 'addMissingCases';
interface EditRequest { kind: EditKind; doc; pos; name: string; hints?: string[]; hint?: string; }
type EditResult =
  | { type: 'replaceLines'; startLine: number; endLine: number; text: string }   // 0-based, inclusive
  | { type: 'replaceRange'; range: vscode.Range; text: string }
  | { type: 'lemma'; declaration: string; replacement: string }                  // make-lemma
  | { type: 'choices'; items: string[] }                                         // intro
  | { type: 'workspaceEdit'; edit: vscode.WorkspaceEdit }                        // LSP codeAction
  | { type: 'exhausted' };                                                       // "No more results"
```

The IDE backend synthesises `replaceLines` from the compiler's line-oriented replies (§7); the
LSP backend returns the server's `CodeAction.edit`. `features/editing` applies either as a
`WorkspaceEdit` with one undo stop, and the `CyclingController` remembers the replaced range
for `-Next` variants (§10).

**Code-action kinds and the LSP mapping (F34).** The IDE backend's own actions are exposed
under the server's *filter keys*
`refactor.rewrite.{AddClause,CaseSplit,ExprSearch,GenerateDef,GenerateDefNext,Intro,MakeCase,MakeWith,RefineHole}`
and `refactor.extract.MakeLemma` [src `Language/LSP/CodeAction/*.idr`; the server README's
`MakeClause` is stale]. The server, however, returns every action with the **generic** kind
`refactor.rewrite` (MakeLemma: `refactor.extract`) and distinguishes them by title, and each
of its action modules honours `context.only` for its own key or the generic one. Consequences:

1. The keyboard surface is **our own commands on both backends**, never
   `editor.action.codeAction` with a kind (VS Code's kind-prefix filter is expected to drop a
   `refactor.rewrite` action when `refactor.rewrite.CaseSplit` is requested — ROADMAP E24).
2. `LspBackend.edit()` sends `textDocument/codeAction` with `context.only = [<specific key>]`
   and then selects by title pattern:

| EditKind | `only` key | title pattern | result |
|---|---|---|---|
| `caseSplit` | `refactor.rewrite.CaseSplit` | `Case split on ?<n>` | `workspaceEdit` |
| `addClause` | `refactor.rewrite.AddClause` | `Add clause` | `workspaceEdit` |
| `makeLemma` | `refactor.extract.MakeLemma` | `Make lemma for hole ?<n>` | `workspaceEdit` |
| `makeWith` / `makeCase` | `…MakeWith` / `…MakeCase` | `Make with for hole ?<n>` / `Make case for hole ?<n>` | `workspaceEdit` |
| `exprSearch` / `exprSearchNext` | `refactor.rewrite.ExprSearch` | `Expression search on <n> as ~ <str> ...` (≤ `maxCodeActionResults`, default 5) | `workspaceEdit`, then `exhausted` |
| `generateDef` / `generateDefNext` | `…GenerateDef` / `…GenerateDefNext` | `Generate definition #<i> as ~ …` / `Generate next definition` | `workspaceEdit` |
| `intro` | `refactor.rewrite.Intro` | `Intro <str> over hole <n>` — **one action per candidate** | `choices` built from the titles' `<str>` |
| `refine` | `executeCommand refineHole {codeAction, hint}` | `Refine hole on <n>` | `workspaceEdit`; an `EditError` (incl. ambiguity) yields **no action** → `Unsupported('ambiguity is not reported by idris2-lsp')` |
| `addMissingCases` | quick fix | `kind == quickfix` **and** the coverage diagnostic attached (title `QuickFix: Add missing cases`, F28) | `workspaceEdit` |

The contract suite (§12) asserts that both backends produce the same text for the same
fixture; it is switched on by whichever of M4/M5 ships second.

**As built (M4).** M4 shipped first, so the LSP rows above, `LspBackend.edit()`/`holes()` and the
contract suite are M5's. The contract M4 built (`backend/types.ts`) is backend-neutral and
refines this section: `EditRequest` is a union by kind carrying `version` (the document version
the answer is computed for) and a cancellation `token`; `EditResult` is `edit` (replacements of
the request's document only — §3.3's `replaceLines`, `replaceRange`, `lemma` and `workspaceEdit` in
one form, so that no result can change another document and the E15 range rules live in the
backend), `choices` (Intro's candidates and Refine's ambiguity), `failed` (the compiler's answer
without an edit) or `exhausted`. An expression put in place of a hole (Intro, Refine Hole and its
alternatives, Proof Search and its next results, Make Lemma's call) goes in parentheses unless it is
one token (`core/idrisSyntax.ts` `isOneToken`; a postfix projection `.x` counts as more, since it
attaches to the expression before it) that would not run into a name right before the hole,
a `.` right after it or a `"` on either side, wherever the hole is; after a backtick a space goes
before an answer that starts with a bracket; at the head of an idiom bracket on the hole's line only
a name, a hole or a lambda is put, anything else refused. Refine's ambiguity alternatives are
offered only in prefix form (the qualified name followed by its arguments). Make Case always applies
the bracketed case, rewriting an unbracketed answer into it and refusing any other (ROADMAP §9,
2026-10-01). Make Case and the answers in place are refused when the rest of the hole's line, read
from what is open at the hole, starts an entry of a layout block (the block calls of
`Idris/Parser.idr`), or the hole is in a `parameters`, `using` or `with` header (read from the nearest line above whose first token is left of the hole line's), and
the first token below is right of the hole (`edits.ts` `layoutProblem`; kept and made to converge,
ROADMAP §9, 2026-10-01): the line reader behind it runs M0's lexer (`core/idrisLexer.ts`). The
shapes it misses or over-refuses: `docs/as-built/M4.md`, *Open issues*.
`docs/as-built/M4.md`, *Edits*.

---

## 4. The three engines

```
                 features/*  (providers, commands, views, panel)
                        │ IdrisBackend + Capabilities
             ┌──────────┴───────────┐
             │ backend/registry.ts  │  per ProjectRoot: auto | lsp | ideMode (+ fallback)
             └───┬──────────────┬───┘
                 │              │                          backend/cli/runner.ts
   ┌─────────────┴───┐   ┌──────┴───────────────┐   ┌──────────────────────────┐
   │ backend/lsp     │   │ backend/ide          │   │ one-shot processes:      │
   │ LanguageClient  │   │ SessionPool per root │   │ --version --paths        │
   │ one per window  │   │ roles: check | eval  │   │ --dump-ipkg-json         │
   │ ownership via   │   │ | shadow             │   │ --build --typecheck      │
   │ middleware      │   │ stdio (default) /    │   │ --clean --install --mkdoc│
   │                 │   │ socket (opt-in)      │   │ --exec, --check, pack …  │
   └────────┬────────┘   └──────────┬───────────┘   └──────────────────────────┘
      JSON-RPC/stdio          s-expressions
        idris2-lsp        idris2 --ide-mode
```

- **LSP client**: `vscode-languageclient/node` 10.x, `ServerOptions = { command: <idris2-lsp>,
  options: { cwd: <workspace folder>, env } }`. `initializationOptions` is the flat object of
  the eight server options (`logFile`, `logSeverity`, `longActionTimeout`,
  `maxCodeActionResults`, `showImplicits`, `showMachineNames`, `fullNamespace`,
  `briefCompletions` [landscape §3]). Setting changes are forwarded by sending
  `workspace/didChangeConfiguration` **ourselves with the same flat object as `settings`**,
  because the server's `processSettings` does `lookup "logFile"` etc. on the top-level object
  [src `ProcessMessage.idr` 137–189, 570–572]; `synchronize.configurationSection` is not used
  (the client library nests keys by dotted section, which the server would ignore — reported
  by the plan reviewers, not re-read here).
- **IDE-mode sessions**: one `SessionPool` per ProjectRoot, each holding up to three
  `IdeSession`s by role: `check` (loads saved files, owns diagnostics/tokens/holes/edits),
  `eval` (`:interpret` of expressions only — no `:exec`, ROADMAP §9, decided 2026-09-28 before
  M3; started lazily; kept apart from the checking state — `:set showimplicits` persists across
  a later `:load-file` and changes `:type-of` output in that session [live, F27]), `shadow` (M6,
  cwd outside the project).
  Spawn arguments: see §5.2.
- **CLI runner**: stateless `execFile`/`spawn` with explicit `cwd`, `--no-color`, `NO_COLOR=1`,
  a timeout and a `CancellationToken`. Output is always parsed; exit codes are never trusted
  alone (`idris2 --check` exits 0 on `Module X not found`, F9).

---

## 5. Process and lifecycle management

### 5.1 `IdeSession` state machine

```
stopped ─spawn─▶ starting ─(:protocol-version 2 1 within 10 s)─▶ ready ◀────────┐
   ▲                │ timeout / exit / bad version                  │ request     │ reply
   │                ▼                                               ▼             │
   └─── failed ◀── restarting (backoff 0 s, 2 s, 10 s; ≥ 3 crashes / 5 min → failed + notify)
                                                                  busy ───────────┘
```

- **Handshake.** Accept `(:protocol-version 2 x)`; refuse `< 2` with a clear message (Idris 1
  speaks v1 [landscape §2.2]); warn once on `> 2.1`.
- **One request in flight.** The protocol is sequential; `IdeSession.request(sexp, {timeout,
  token})` enqueues FIFO. Queued requests carry a `CancellationToken` and are dropped if
  cancelled before dispatch. `:load-file` requests for the same file are de-duplicated.
- **Timeouts.** `idris2.ideMode.requestTimeout` (default 5 s) for lookups;
  `idris2.ideMode.longActionTimeout` (default 60 s) for `:load-file`, `:proof-search`,
  `:generate-def`. The protocol has no cancel: a timeout kills the process, rejects the queue
  with `RequestTimeout`, and re-spawns. (As built, M4: a user's cancel of an edit request already
  written restarts the root's `check` session alone, `SessionPool.restartCheck`; `:refine`, `:intro`,
  `:make-lemma`, `:missing` and the holes' requests after a load are long actions too, and a long action's
  timeout is not counted towards giving up.)
- **Id attribution.** A `:return` whose id ≠ the in-flight id is attributed to the in-flight
  request **only** when its text starts with `Unrecognised command` or `Parse error` (the
  compiler tags unparseable requests with the *previous* id — landscape §4.3, F4); any other
  mismatch is a `ProtocolError`: log the raw frame, restart.
- **Unframed bytes.** A header that is not six hex digits is logged; on stdio the known EOF
  tail `Alas the file is done, aborting` is ignored, anything else is a `ProtocolError`
  (restart). On the socket transport program output never reaches the stream (F5).
- **Loaded-file tracking.** The session remembers `(uri, savedVersion)` of the last
  `:load-file`; file-scoped requests re-issue `:load-file` when different. **As built (M3):** a
  query never re-issues a load in the session: it rejects with `NotLoaded`, having sent and started
  nothing, and the caller loads the document through the checks, so that the load's diagnostics are
  shown (§3.1 *As built (M3)*; `docs/as-built/M3.md`, *Queries*). A reload of a file
  whose TTC is fresh emits no `:write-string "N/M: Building …"` and **no `:warning` frames**
  (but does re-emit `:highlight-source` frames) [live, F7]: the absence of a `Building` line
  is the signal to keep existing diagnostics.
- **Idle reaping and explicit stop.** Sessions stop after `idris2.ideMode.idleTimeout`
  (default 10 min), when their root's last document closes, or on **Idris 2: Stop Backend**
  (current root or all roots; status `stopped`; the next request or Check File respawns
  lazily) — the escape hatch for a pegged compiler or for running `pack build` without a
  concurrent TTC writer; all are killed in `deactivate()`.
- **Configuration changes.** A change to any `idris2.toolchain.*` or `idris2.ideMode.*`
  setting restarts every session (new binary, argv, env or transport take effect at once);
  the LSP client prompts "Restart language server?" for `toolchain.lspPath`/`lsp.trace.server`
  and forwards the eight server options without a restart (§4).
- **Effective build directory.** `SessionPool.effectiveCheckBuildDir(root)` =
  `<root>/<build>/.vscode-idris2` when `ideMode.isolateBuildDir` is on and the ipkg has no
  `builddir`, else `<root>/<builddir or build>`; the shadow role (§5.2, §6.3) reads its TTCs
  from there (F32) and no other module recomputes it.
- **Transport** (D1; decided by the user on 2026-09-28, ROADMAP §9 Q20). `stdio` (default, on
  every platform): spawn `idris2 --ide-mode --no-color …` and speak over its standard input and
  output; no port is opened. The `check` session sends no `:exec` of its own (only a raw request
  typed with the developer command can), so the program output that F5 finds in the stdio stream
  does not reach it in normal use, and whatever unframed output arrives — the compiler's log
  lines, a raw request's program output — is read as the process's output (as built:
  `docs/as-built/M2.md`, *ARCHITECTURE §5.1*). `socket` (`idris2 --ide-mode-socket`), an explicit
  opt-in in user settings only: read the port printed on stdout (F5), `net.connect(port,
  '127.0.0.1')`; the process's stdout after the port line is program output. The compiler serves
  the first connection to that port, unauthenticated (as built: `docs/as-built/M2.md`,
  *ARCHITECTURE §5.1*). Q20 left the
  transport of the `eval` session, then planned to run `:exec`, to M3 (ROADMAP §9 Q20); until
  2026-09-28 this paragraph made the socket the default and stdio the fallback. **Settled on
  2026-09-28 before M3** (ROADMAP §9): the `eval` session evaluates expressions only and sends no
  `:exec`, so it follows the same rule as the `check` session — stdio, the socket only when the
  user opted in.

**As built (M2).** The code refines this section; the record, with its evidence, is
`docs/as-built/M2.md`, *ARCHITECTURE §5.1*: **Transport** (the values `stdio` and `socket`, the
setting's `application` scope, the socket's unauthenticated first connection and the takeover
detection), **Handshake**, **Backoff and give-up** (the reading the user confirmed, ROADMAP §9
Q22), **At most `idris2.ideMode.maxSessions`** (ROADMAP §9 Q21), **Queue** (what a time-out, an
exit, a stop and dispose reject; `beforeSend` checks; `urgent` loads), **Id attribution** (stricter
than above), **Merged loads**, **Configuration changes** (a deviation: only the sessions whose
command line would differ restart), **Stop when the last document closes** and **Unframed bytes**
(differs from the text above: over stdio unframed output is the process's own output, not an
error).

### 5.2 Spawn rules per role

| role | cwd | extra args / env | notes |
|---|---|---|---|
| `check` | ipkg directory (project) or the file's directory (loose) | `-p <pkg>` from `idris2.ideMode.loosePackages` for loose files; `--build-dir <root>/<build>/.vscode-idris2` **only when the ipkg has no `builddir` field** (the field overrides the flag, F12); `idris2.ideMode.extraArgs` | never `--find-ipkg` (from a subdirectory it breaks relative loads, F13); files sent as absolute paths (work from the ipkg dir, fail from a foreign cwd, F13) |
| `eval` | same as `check` | same | `:interpret` of expressions only (ROADMAP §9, 2026-09-28): no `:exec`, so no program output. Evaluate (M3) refuses, before sending, text the REPL parser reads as a command (`:exec`, `:sh`, `:set …`); M8's Query box and `-- >>>` lenses, which share this session, must not send such text either, except commands that cannot run IO or change the session's options (proposed: `:t`, `:doc`; ROADMAP M8, *Open questions*). Nothing that sends to this session ever changes its evaluation mode from the default, which normalises IO actions instead of running them [src] |
| `shadow` | `<globalStorage>/shadow/<rootHash>/` (no `.ipkg` above it) | `IDRIS2_PATH=<effectiveCheckBuildDir>/ttc` (§5.1 — `<root>/build/.vscode-idris2/ttc` in the default configuration; `<root>/build/ttc` does not exist in a fresh clone, F32), `--build-dir <shadowRoot>/build`, same `-p` flags | F8 + F32; only the active editor's document is shadowed |

`<build>` is the ipkg's `builddir` if set, else `build`. Without `--build-dir` isolation the
`check` session shares the project's TTC directory with `idris2 --build`/`pack build`/the LSP
server; this is documented as a limitation for ipkgs that set `builddir` ([open]: whether
concurrent writers actually corrupt TTCs), and Stop Backend (§5.1) is the manual remedy. The
isolated directory does not keep windows apart: sessions are per window and per root, so two VS
Code windows whose files belong to one root (two folders of one package, one loose file opened in
both) each run a `check` session writing the same `build/.vscode-idris2` — the same [open]
question (`docs/as-built/M2.md`, *E21*), the same remedy, and a limitation in `docs/guide.md`
(*Resource use*, *Known limitations*).

**As built (M2).** Only the `check` role exists (M3 adds `eval`, M6 `shadow`). Its command line,
what the pool checks before every spawn (trust, the toolchain scan, the consent gate on the
directory's real path), the path sent in `:load-file`, the package walk before each load and the
build directory the compiler ends up using are recorded in `docs/as-built/M2.md`, *ARCHITECTURE
§5.2*.

**As built (M3).** Elaborator scripts the expression reaches are not refused (ROADMAP §9 Q23,
accepted 2026-09-29): a `%macro` applied by name runs its script, `%runElab` runs where
`ElabReflection` is on in the compiler's context; M8's Query box and lenses inherit this unless
M8 decides otherwise (ROADMAP M8, *Open questions*). The `eval` role differs from the table in one argument: it gets `--build-dir
<session directory>/build/.vscode-idris2-eval` whenever the `.ipkg` and `extraArgs` choose no
build directory, whatever `idris2.ideMode.isolateBuildDir` says, so that it never compiles into the
`check` session's directory (whose next load would then report no warnings for a file the `eval`
session rebuilt, F7) and the two processes never write one directory at once (E21). It is
started at the first evaluation in its root, through the same trust, toolchain and consent checks
and with the same transport rule as the `check` session; it loads the document's file (with the
same package walk right before the write) before every `:interpret`, which is queued right behind
that load, so that it evaluates in the files as saved at that moment; the `:interpret` has its own
time limit, `idris2.eval.timeout` (10 s), and a cancelled evaluation stops the session; it counts
towards `idris2.ideMode.maxSessions` while it is idle (being started or evaluating, it does not
make room for itself by stopping another session; fourth review of M3), and that limit's eviction
stops idle `eval` sessions first. **It never
starts a process by itself**: **Restart Backend** (one project or all) and a change of its command
line stop it instead of restarting it, it is not restarted after an unexpected end (a deviation
from §5.1's backoff), and it stops after 2 minutes without a request (or the shorter
`idris2.ideMode.idleTimeout`; never for being idle when that is 0) and after an evaluation whose
`:interpret` took more than a second, to give back the memory the process kept (second review of
M3); **Stop Backend** and the other ways a root's sessions stop stop it too. Evaluate refuses text the REPL parser could read as a command before the backend classifies,
starts or sends anything (`backend/ide/replCommand.ts`, at least as strict as the parser). Record:
`docs/as-built/M3.md`, *Evaluation*.

### 5.3 LanguageClient lifecycle

Started lazily on the first LSP-owned document; `ErrorHandler` with the same backoff policy;
`idris2.restartLanguageServer` and `idris2.stopLanguageServer` commands (status `stopped`);
`idris2.showLanguageServerOutput` opens the client's channel, where the server's stderr `LOG
<severity>:<topic>: …` lines land [src `Server/Log.idr` 78–82]; `RequestCancelled` from
`semanticTokens/full` on dirty documents is swallowed and the last tokens are returned
[landscape §7].

**Missing ipkg.** The server never reports it: `loadURI` only logs `Cannot load ipkg file for
<uri>: "Cannot find the ipkg file"` to its log handle and `didOpen`/`didSave` discard the
result; no `window/showMessage` exists in `src/Server` (F35). The condition is therefore
detected **client-side before routing** — the registry never gives a root without an `.ipkg`
to the LSP backend (§3.2) and shows the one-time notification ("this file has no `.ipkg`, so
idris2-lsp cannot load it") offering the New Project scaffold (M11, when present) or "Use IDE
mode for this folder" (M2, when present). Safety net for a root whose ipkg disappears while
LSP-owned: a `ResponseError` with code `3` whose message contains `Cannot find the ipkg file`
(`withURI`, [src `ProcessMessage.idr` 292–297]) and, when the extension spawns the server
itself so that stderr is a stream it owns, the line `LOG Error:Server: Cannot load ipkg file
for` — both derived from source, not observed live (Q2), and neither is guaranteed to fire
because `loadURI` records `openFile` before the ipkg check fails (F35).

---

## 6. Document state and checking modes

### 6.1 `DocumentSession`

```ts
interface DocumentSession {
  uri: vscode.Uri; root: ProjectRoot | LooseFile; backend: IdrisBackend;
  savedVersion: number;           // document.version at last save
  loadState: 'idle' | 'loading' | 'ok' | 'warnings' | 'errors' | 'ipkgError';
  stale: boolean;                 // document.version !== savedVersion (and no shadow result)
  holes: Hole[]; tokens?: TokenIndex; lastLoadHadBuilding: boolean;
}
```

All views subscribe to `onDidChangeSession`. The status item shows `checking… / ✓ / n errors /
stale / stopped`; hovers get an italic "results refer to the saved file" header when `stale`.

**As built (M2).** No `DocumentSession` type and no `onDidChangeSession` exist under these names:
the per-document state is `DocumentChecks`' tracked entry (`features/diagnostics/checks.ts`);
what it holds in place of `savedVersion` and `lastLoadHadBuilding` is recorded in
`docs/as-built/M2.md`, *ARCHITECTURE §6.1*.

### 6.2 Triggers (`idris2.checking.trigger`)

- `onSave` (default): `:load-file` (or the server's own `didSave` reload) on save and on open.
- `afterDelay`: debounced `document.save()` of Idris documents only (opt-in; it writes the
  user's files) — the only mitigation that also unlocks the LSP's dirty-gated features.
- `manual`: only the *Check File* command.

**As built (M2).** `loadState` gains `failed`. What "on open" means; how `afterDelay`, Restricted
Mode, the consent gate, Stop Backend, a file changed on disk, undo and closing a document act on
checks; and the status item's texts are recorded in `docs/as-built/M2.md`, *ARCHITECTURE §6.2*.

**The active document and background checks** (decided by the user on 2026-09-28, ROADMAP §9 Q21).
The active document is the active editor's when that is an Idris file on disk, and while the active
editor is something else (another language, an output channel — VS Code 1.139.1 reports the focused
Output panel as the active text editor [live, `docs/as-built/M2.md`, *Resource limits*] —, none)
the last such document, as long as it is open; the checks tell the pool its root (`ActiveRoot` →
`SessionPool.setActiveRoot`, `docs/as-built/M2.md`, *ARCHITECTURE §5.1*, *At most `idris2.ideMode.maxSessions`*).
With `idris2.ideMode.maxBackgroundChecks` above `0` (the default `0` is no limit and changes
nothing above), a check of any other document waits after classifying the file, reading
`checking…`: first, when the consent gate has no verdict for its folder yet, for the answer (the
checks ask `SessionGate.permit`; an open question holds no slot) — unless the backend says the load
would be refused before any question (`LoadPreflight` → `IdeMode.refusalBeforeQuestion`: the
package walk, then `SessionPool.startProblem`), when nothing is asked and the load goes at once,
without a slot —, then for one of that many slots, unless the gate refuses the folder (the load is
refused at once). A check counts while it runs, is not the active document's, and its folder is
neither refused nor asked about; the others wait in the order they reach the slot step, and a newer
check of a waiting document takes the older one's place. The running checks are counted again when
the active document, the limit or a verdict changes, and when a document closes, so a check that
started as the active document's counts once another is active or it closed. The active document's
check never waits for a slot, and a waiting check whose document becomes the active one starts at
once. A waiting check does not load when its document closes, on **Stop Backend** for its root or
for all (`DocumentChecks.cancelWaiting`, called by the command before it stops the sessions), or
when its folder is revoked (then as refused). A higher limit (or `0`) starts waiting checks at
once; a lower one interrupts nothing. While a check of the active document has not classified it,
its root reads `pending` to the pool (`docs/as-built/M2.md`, *ARCHITECTURE §5.1*); an active
document no check tracks (the `manual` trigger) is classified by the checks for this. The limit is
on checks, not on process starts (Restart Backend for every root restarts the processes together).
Within one root the session sends one request at a time and the compiler cannot be interrupted, so
the checks mark the active document's load `urgent` (`LoadOptions`, §3.1) while a limit is set —
except when it is checked with other visible documents and, at its handover, one of theirs in its
root handed over before it has not settled (then, decided once, it stays first-in, first-out,
behind the root's requests queued before it, background loads included; `checks.ts` *The active
document*, `CheckOptions.batch`) —: it
goes before the root's requests that
wait (queries too: a query whose answer is kept per load —
`typeAt`, `docsFor`, `definition` — that it passes is refused before its write, `NotLoaded`, and
asked again after the load; completions and namespace listings are sent after it and answer for the
new load; `docs/as-built/M3.md`, *Sixth review of M3*), after the
one in flight and after one whose package walk runs or has passed — at most those two
(`docs/as-built/M2.md`, *ARCHITECTURE §5.1*, *Queue*). Both
limits count per VS Code window: each window has its own extension host, pool and checks
(`docs/as-built/M2.md`, *Resource limits*).

### 6.3 Shadow typecheck (M6) — check-while-typing without saving

Verified mechanism (F8, F32): copy the dirty buffer to `<shadowRoot>/<path relative to
sourcedir>` where `<shadowRoot>` has no `.ipkg` above it; spawn a `shadow` session with cwd
`<shadowRoot>`, `IDRIS2_PATH=<effectiveCheckBuildDir>/ttc` (the directory *containing* the
TTC-version directory; the version directory itself fails, F8; and it must be the **check
session's** build directory — `<root>/build/.vscode-idris2/ttc` under the default D5
isolation, since `<root>/build/ttc` only exists after the user's own `idris2 --build` and may
be stale, F32) and `--build-dir <shadowRoot>/build`; `:load-file "<rel path>"` resolves
`import`s of sibling modules from those TTCs, lists the new holes, and leaves the check
session's build directory untouched. If a sibling is `not found`, the check session loads the
saved sibling once (writing its TTC into the same directory) and the shadow load is retried.
Results land in the `idris2 (unsaved)` diagnostic collection
and replace the saved-file diagnostics for that document while it is dirty; `:metavariables`,
`:type-of` and editing commands are routed to the shadow session for dirty documents (text is
identical, so positions map 1:1). Cancellation = kill and respawn the shadow session. Sibling
modules that are themselves unsaved are a documented limitation (the shadow sees their last
TTC). Shadow sessions send `(:enable-syntax :False)` first, which suppresses `:highlight-source`
frames [live, F14], since tokens still come from the saved load.

---

## 7. Coordinates (`core/positions.ts`)

Six conventions, all verified on 0.8.0 [live] with the fact cited per row:

| Surface | Line | Column | End |
|---|---|---|---|
| VS Code / LSP | 0-based | 0-based | exclusive |
| IDE **request** `:type-of NAME L C` (F2, F30) | **1-based** | 0-based | **inclusive** (col == end of token still succeeds) |
| IDE **request** `:case-split L C NAME` (F2) | **1-based** | **1-based**; `C = 0` means anywhere on line L | **inclusive**; observed: any column up to the end of the clause's left-hand side works, not only NAME's |
| IDE request `:add-clause L`, `:generate-def L` (line of the *type declaration*), `:make-lemma L` (F2, F11, F30) | 1-based | — | — |
| IDE request `:intro L`, `:refine L`, `:proof-search L` (F29, F30 — verified during the review; F2 does not cover them) | 1-based | — | — |
| IDE **reply** `:warning (L C) (L C)`, `:name-at (:start L C) (:end L C)`, `:highlight-source` | 0-based | 0-based | exclusive |
| CLI text `Mod:L:C--L:C` (`--check`, `--build`, `--dump-ipkg-json` errors) | 1-based | 1-based | exclusive |

**Literate offset.** For bird-track `.lidr` files the compiler works in *unlit* columns: every
reply column on a `> `/`< ` line is `fileColumn − prefixWidth`, and requests must send unlit
columns too (`(:type-of "n" 6 2)` succeeds for an `n` at file column 4; `:case-split` takes
1-based unlit columns; F11). The CLI text columns of `--check` on a `.lidr` are unlit as well
(`Err:6:5--6:8` for file columns 6–9, 0-based; F11). Lines are file lines — in a file with LF
line breaks: the compiler drops a CRLF break in a `.lidr`, joining the line to the next one,
which is why `[lidr]` defaults `files.eol` to `\n` (F11) — except below a marker followed only by
white space (`> `, `>   `), which is two lines of the unlit text, so that every such line above a
file line adds one to the compiler's line (F11 addendum [live], second review of M3; `.lidr`'s
Enter rule makes such lines). Org's `#+IDRIS:` lines are line markers too (offset 9, and the same
doubling [live]). For fenced styles (`.md` verified; `.tex`/`.typ` and Org's blocks [open], E19)
lines and columns are exact in a file with LF line breaks; with CRLF the compiler drops the breaks
outside code blocks, so its lines after prose are smaller than the file's (F11 addendum of the
third review of M3 [live]; not mapped, README *Known limitations*). `positions.ts` therefore exposes `toIdeTypeOfRequest` /
`toIdeCaseSplitRequest` / `toIdeLineRequest` for requests and `fromIdeReply(Span)` /
`fromCli(Span)` for replies and CLI text, which consult `project/literate.ts` for the per-line
prefix width, the doubled lines (kept per document and version) and for whether the compiler
reads the document as bird-track at all (M0). The compiler decides that by the file name
(`isLitFile`, a case-sensitive suffix test in `src/Parser/Unlit.idr`), not by the editor's
language mode, so `compilerLiterateStyleOf` does too; only an untitled document, which has no
name the compiler could see, falls back to its language id [src] [live, 0.8.0: a bird-track
`Up.LIDR` fails `--check` at its first `>`]. Upstream fix: Idris2 #1508
[gh, cited by plan-ecosystem; issue number not verified offline].

**Column unit (E14, settled in M3).** The compiler counts columns in **code points**, in requests
and in replies [live, 2026-09-29, transcript `unicode-columns`: `:type-of`, `:highlight-source`
and `:name-at`; `:warning`, `:case-split` and the CLI text by the same lexer counts, [src]
`Libraries/Text/Lexer/Tokenizer.idr`, not recorded on such a line]; VS Code counts UTF-16 units.
They differ only for characters outside the Basic Multilingual Plane, so `positions.ts` converts
every column with the text of its line (`codePointsBefore`, `utf16Length`), and a line without such
characters passes through unchanged. The highlighting offsets inside a reply's text count code
points too (`backend/ide/protocol.ts` `toRichText` converts them). Details and the recorded
columns: `docs/as-built/M3.md`, *E14*.

**Edit replies in `.lidr`** come back *with* the `> ` prefix (`> f 0 = ?f_rhs_0`,
`> h k = ?h_rhs`, and even the make-lemma `definition-type` `> f_rhs : Nat -> Nat`, while
`replace-metavariable` is unprefixed) [live, F11]; `.md` replies are plain. `features/editing`
must not add a second prefix. **As built (M4):** make-case and make-with replies carry the marker
twice or three times (`> > `), since IDE mode leaves the compiler's literate style unset [src];
`backend/ide/edits.ts` repairs exactly that shape, and the replacements it returns are final. The
raw source line that make-lemma, make-case and make-with read is `toIdeSourceLineRequest`, not the
unlit line (`docs/as-built/M4.md`, *Literate files*).

---

## 8. Diagnostics and problem matchers

Three `DiagnosticCollection`s: `idris2` (saved file, from the check session or the server),
`idris2 (unsaved)` (shadow), `idris2 build` (tasks; cleared per build).

**IDE-mode `:warning` → `Diagnostic`.** Frame shape `(:warning (FILE (L C) (L C) MSG HL) ID)`
with FILE relative to the session cwd and 0-based end-exclusive positions (F6). `range` from the
tuple (after the literate offset); `message` = text before the blank line preceding
`Mod:l:c--l:c`, plus a `Missing cases:` block when present; the source excerpt is dropped unless
`idris2.diagnostics.includeSourceExcerpt`. **Severity rule** (F7): after `(:return (:ok …))`
every frame of that load is `Warning`; after `(:return (:error …))` frames are `Error` unless
the first line matches the known-warning table. The compiler's warning constructors on master
are `ParserWarning`, `UnreachableClause`, `ShadowingGlobalDefs`, `IncompatibleVisibility`,
`ShadowingLocalBindings`, `Deprecated`, `GenericWarn` [src `Core/Core.idr` 70–87]; only the
pretty-printed first line `Unreachable clause: …` was observed live, the others must be
collected before they are added to the table ([open], M2). Frames for files other than the
loaded one are attached to that file (path resolved
against cwd). A `(:return (:error MSG))` **without** any `:warning` frame whose MSG contains
`"<name>.ipkg":L:C--L:C` is an ipkg parse error (F10): it becomes a diagnostic on the ipkg file
and `loadState = 'ipkgError'`.

**As built (M2; `backend/ide/diagnostics.ts`).** The message rule (every location block removed),
the known-warning table of all seven warning constructors (E5), `-Werror`, how an `.ipkg` error is
recognised, which files a load's diagnostics replace, the "Not checked: …" error and the
fresh-TTC limitation are recorded in `docs/as-built/M2.md`, *ARCHITECTURE §8*.

**CLI output → `Diagnostic`** (`backend/cli/diagnostics.ts`). Format per landscape §4.2:
`Error:`/`Warning:` block, then `<Module>:L:C--L:C` (1-based) and a snippet. `<Module>` is a
module stem, not a path: map through the `N/M: Building <Module> (<path>)` lines seen in the same
run, else through the ipkg `sourcedir` + module path, trying `.idr` and the literate extensions.
Exit codes are advisory only (F9). A declarative `problemMatchers` contribution `$idris2`
(matching only the location line) is also provided for user-authored tasks, documented as unable
to map module stems to files.

---

## 9. Holes and the goal panel

Two views over one `HoleModel`:

- **Holes tree view** (`idris2.holes`, side-bar container "Idris 2", M4): file → hole →
  premises; click jumps; badge = count. Cheap, keyboard-navigable. As built (M4): the model asks
  `holes()` after every load of an open file, also while the view is hidden (the badge shows on
  the activity-bar icon); IDE mode asks the compiler right after each `check` load, before a load
  queued behind it, unless a newer load of the file is queued; a hole without a location that is
  not a `?name` of the loaded text is listed under its module (a package whose source the compiler
  does not find); `idris2.holes.showInSideBar` only hides the view; `docs/as-built/M4.md`, *Holes*.
- **Goal panel** (`WebviewPanel`, `ViewColumn.Beside`, `retainContextWhenHidden`, M7): the
  Lean-InfoView analogue. Chosen over a tree because premises need multi-line, highlighted,
  monospace rendering and per-item buttons; over a `WebviewView` because users keep it beside
  the code and it needs width.

Data sources: IDE mode `(:metavariables W)` → `((NAME PREMISES (TYPE HL)) …)` with NAME
double-quoted inside the string and premises `(" 0  a" "Type" ())` carrying a multiplicity
prefix (`0`, `1`, blank = ω) and **no locations** (F2); locations via `(:name-at "<unqualified>")`
(qualified names return `()`), one request per hole, cached per load. LSP `metavars` →
`Metavar[]` with `location`, `premises[].isImplicit` and `multiplicity` [src `Metavars.idr`].
As built (M4): one `:name-at` per unqualified name — it answers every hole of that name, and the
entry of the hole's qualified name is its location (E16) —, at most 2,000 names per load, the
loaded file's first;
`:metavariables` also lists declarations without clauses and failed definitions, whose `:name-at`
span is the declaration, and they are left out [live].

Webview contract (`src/webview/goalPanel.ts` ↔ `features/goalPanel/host.ts`), all over
`postMessage`, CSP `default-src 'none'; style-src ${cspSource} 'nonce-…'; script-src 'nonce-…'`:

```ts
// host → webview
type ToWebview =
  | { type: 'state'; version: number; doc: string; stale: boolean;
      current?: HoleView; holes: HoleView[]; messages: DiagnosticView[];
      options: { showImplicits: boolean; showMachineNames: boolean; fullNamespace: boolean };
      caps: Pick<Capabilities, 'editing' | 'editingNext' | 'intro' | 'refine'> }
  | { type: 'pinned'; pinned: boolean } | { type: 'theme' };
// webview → host
type FromWebview =
  | { type: 'ready' }
  | { type: 'action'; edit: EditKind; hole: string; premise?: string; hint?: string }
  | { type: 'jump'; uri: string; line: number; col: number }
  | { type: 'toggle'; option: 'showImplicits' | 'showMachineNames' | 'fullNamespace' | 'pin' | 'follow' }
  | { type: 'copy'; format: 'markdown' | 'plain' };
```

The webview is a pure renderer with a version counter; every action is dispatched to the M4
command with explicit arguments, so the panel never re-implements editing. Toggles map to IDE
`(:interpret ":set showimplicits")`/`(:get-options)` on the check session (session state is
mutable) or to LSP `didChangeConfiguration`.

---

## 10. Interactive editing details

- **Availability** is decided syntactically by the `CodeActionProvider` (cursor on `?name`;
  line matches `^\s*<ident>\s*:`; cursor on a pattern variable) and semantically by the reply.
  On 0.8.0, `:case-split` on a clause whose right-hand side is not a hole answers
  `No clause to split here` [live, F15]; this and the `Undefined name`/`Can't find declaration`
  failures after a load with errors (reported by plan-proof-ux, **not reproduced here** for
  `:type-of`, F16) are rephrased by a small table before being shown.
- **Line-oriented replies** (`case-split`, `add-clause`, `make-with`, `make-case`,
  `generate-def`) replace the clause's lines: the clause starts at the request line and extends
  over following lines that are more indented or continue an expression; `add-clause` and
  `generate-def` insert after the type declaration's last line. `make-lemma` returns
  `(:metavariable-lemma (:replace-metavariable APP) (:definition-type SIG))`: insert `SIG`
  before the enclosing top-level declaration, replace `?hole` with `APP`. `intro` returns a list
  of strings (`("0" "S ?f_rhs_0")`, F29) → QuickPick (applied directly if unique). `refine`
  returns one string, or `(:error "Ambiguous elaboration. Possible results:\n    A\n    B\n\n
  (Interactive):1:1--1:4 …")` whose indented lines between `Possible results:` and the blank
  line are the qualified alternatives (F29) → QuickPick; over LSP the server drops the
  ambiguity (F34), so the command answers `Unsupported`. `:proof-search` replies carry highlight
  metadata after the string and `:generate-def` returns one multi-line string (F30).
- **`CyclingController`** (proof search / generate def): remembers the replaced range, applies
  `:proof-search-next` / `:generate-def-next` (bare symbols) as a fresh replacement with its own
  undo stop, shows a status-bar `↻ next (n)`, cancels on any edit outside the range, and ends on
  `No more results`. On LSP it walks the up-to-`maxCodeActionResults` `Expression search …`
  actions or the `Generate next definition` action (§3.3, F34).
- **Add missing cases**: `(:interpret ":missing NAME")` → `"Mod.f:\nf (S _)"` (F15) → one
  clause per line as `<clause> = ?<fn>_missing_case_<k>` (k from 1), inserted at the first blank
  line after the declaration's last line — exactly the server's quick-fix convention
  [src `Server/QuickFix.idr` 46, 98–108] — offered as a `quickfix` on the coverage diagnostic;
  on LSP the server's own quick fix is selected by `kind == quickfix` plus the attached
  coverage diagnostic (its title is `QuickFix: Add missing cases`, F28 — never matched by the
  bare message). `:add-missing` itself is a stub (F3).
- **Keybindings**: two schemes selected by `idris2.keybindings.scheme` via `when:
  config.idris2.keybindings.scheme == '…'`: `chords` (`ctrl+c ctrl+<x>`, Emacs/Agda style,
  default on macOS; its letters are those of the Idris docs' Vim bindings, not Emacs idris-mode's
  — kept by the user's decision, ROADMAP §9 Q25) and `prefix` (`ctrl+alt+i <x>`, default elsewhere, avoiding GNOME's
  `ctrl+alt+<letter>` bindings), plus `none`. **Each milestone contributes only the bindings of
  commands it registers** (a binding to an unregistered command shows "command … not found"),
  all under `idris2.isIdrisDocument && editorTextFocus`. The schemes and the table below were
  confirmed as planned by the user on 2026-09-28 (ROADMAP §9 Q5); M3 contributes `t`, `d`, `e`.
  The letter table is a reservation:

| letter | command | owner |
|---|---|---|
| `c` `a` `l` `w` `m` | case split, add clause, make lemma, make with, make case | M4 |
| `s` `n` `g` `i` `r` | proof search, next result (of either cycle), generate def (also next), intro, refine | M4 |
| `[` `]` | previous / next hole | M4 |
| `t` `d` `e` | type at cursor, docs at cursor, evaluate selection | M3 |
| `,` | toggle goal panel (also `ctrl+shift+enter` / `cmd+shift+enter`, Lean's binding — deliberately shadows VS Code's "Insert Line Above" inside Idris editors, listed as an accepted collision) | M7 |

  Collisions with VS Code's default keymap are checked by an integration test or a diff
  against a checked-in snapshot of "Open Default Keyboard Shortcuts (JSON)" from VS Code 1.139
  (the default keymap is not an npm artefact); deliberate, editor-scoped collisions are
  listed in the table. (`ctrl+shift+enter` is VS Code's **Insert Line Above**,
  `editor.action.insertLineBefore`, `primary: 3075` = CtrlCmd+Shift+Enter under `editorTextFocus`
  [src, the workbench bundles of 1.139.1 and 1.140.0].)

  **As built (M3).** VS Code has no per-platform setting default, so the setting's default is
  `auto`, which binds `chords` on macOS and `prefix` elsewhere (a `mac` key on the `auto`
  bindings); `idris2.keybindings.scheme` has `application` scope (user settings only). The
  integration suite reads VS Code's resolved Default Keybindings: nine bindings (t, d, e under
  `auto`, `chords` and `prefix`), none under `none`, and E23 — on macOS no other binding of VS
  Code 1.139.1 starts with `ctrl+c` or `ctrl+alt+i` [live]. On Linux the setting's description
  warns that `ctrl+c` (copy) and `ctrl+alt+i` (the Chat view) are shadowed in Idris editors under
  the scheme that uses them. The Chat binding is VS Code 1.139.1's **Open Chat**, `primary: 2599`
  (CtrlCmd+Alt+I: Ctrl+Alt+I on Linux and Windows) with `mac: 2343` (Cmd+Ctrl+I) and no `when`
  [src, the workbench bundle]; the Linux list of VS Code 1.139.1 is nine `ctrl+c` copy bindings and
  the two `ctrl+alt+i` Chat bindings, each a single chord [live, CI run 36715864881, ubuntu job, at
  `263f38f`], so only the first key is shadowed. The check covers VS Code's own bindings only: a keymap
  extension's binding of `ctrl+c` (VSCodeVim's, active with its defaults) outranks the `chords`
  bindings, which the README and the setting's description say [src and doc, not run].
  `docs/as-built/M3.md`, *Keybindings*.

  **As built (M4).** The letters `c a l w m s n g i r [ ]` under the same three schemes (45
  bindings with M3's); `n` continues the document's cycle of either kind (`:proof-search-next` or
  `:generate-def-next`, ROADMAP §9 Q26); `g` runs Next Definition inside the command when the cursor
  is on the declaration or the result of the document's Generate Definition cycle; Next Definition, Add
  Missing Cases, List Holes and Show Keybindings have no key. E23 for every letter: on macOS no
  other binding of VS Code 1.140.0 is one of these chords or starts with one [live]; on Linux M3's
  list (above) holds single chords only, and the check of these letters runs at the first CI run of
  the M4 commit. **Idris 2: Show
  Keybindings** is generated from the manifest. `docs/as-built/M4.md`, *Keybindings*.

**As built (M4), the rest of this section.** Availability: the light bulb reads the text only
(nothing is sent); Case Split is offered on a variable (not starting with a capital) of a
one-line clause whose right-hand side is a bare hole and that has no `where` block below, Add Clause
and Generate Definition on a declaration no clause follows and not `%foreign` or `%extern`, Make
With only where the backend sends it (`core/idrisSyntax.ts` `withClauseStart`, shared); an action
the backend refuses unsent for its line (`misreadBelow`, a CRLF literate file, Make Case after the
same `?name`, Case Split on a line whose answer the compiler garbles, `caseSplitLineProblem`, a NUL)
is shown disabled with the reason. Make Case: the compiler replaces the first `?h` of the line by
`case _ of` and puts `case_val => ?h`, followed by the rest of the line, on a new line; only for a
prefix argument does it bracket `case _ of` … `?h`, so that the rest of the line follows the `)`
(`makeCase` [src]); the backend always applies the bracketed form (ROADMAP §9, 2026-10-01). Case Split: the compiler answers line L alone, rewritten, so the backend asks only
when line L holds a hole and replaces that line. F16 does not hold for the commands that find
their place by line: after a load with an error, `:case-split`, `:add-clause` and `:generate-def`
answer misleading errors [live], so they are refused unsent ("the file did not load cleanly — fix
the first error and save"); the other commands are sent, and their failures show that advice
before the compiler's text. Make Lemma inserts the type above the type declaration of the
function holding the hole (with its doc comments and modifier and pragma lines; for an infix,
prefix-form or backticked clause too; inside a `namespace` or `mutual` block, above the
declaration in that block), not at the nearest blank line above the hole (the compiler's REPL and
idris2-lsp), which can be inside a `where` block; it is not applied when the application passes a
name the compiler made (`conArg`, `lcase`). Add Clause goes after the function's clauses when it
has some (its catch-all above them would make them unreachable). Intro, Refine, Proof Search and Make Lemma are
sent only when the load's holes put the one hole of the name at the cursor (the compiler looks it
up by name). Add Missing Cases inserts
after the function's clauses (also when they come later in the block than the declaration, as in
a `mutual` block), not at the first blank line after the declaration. The `CyclingController`
ends a cycle on any change of its document (an undo and a change inside the result included, not
only an edit outside it), also on any load of its root and on another search there (the compiler
keeps `psResult` and `gdResult` apart [src], so this is conservative) — a search's first result
starts no cycle when another search started in its root after it —, and holds the document's
save checks while it runs (auto-save would load the file and end it). The editing commands run one
at a time per document (a second one says which one runs and sends nothing). A cancel after the request
was written restarts the root's `check` session only (`SessionPool.restartCheck`). `.lidr` edit replies: the compiler's literate style is unset in
IDE mode, so make-case and make-with answers carry a doubled marker (`> > `) that the backend
repairs; `:missing` answers carry none (F11 addendum of M4). `docs/as-built/M4.md`, *Edits*.

---

## 11. Settings (`idris2.*`)

Every key has a `markdownDescription` and a scope (`machine-overridable` for paths,
`resource` for checking/literate/build, `window` otherwise) and is read only through
`core/config.ts`.

| Key | Default | Milestone |
|---|---|---|
| `toolchain.idris2Path`, `toolchain.lspPath`, `toolchain.packPath` | `""` (discover) | M1 |
| `toolchain.preferPack` | `false` | M1 |
| `toolchain.env` | `{}` (e.g. `IDRIS2_PREFIX`) | M1 |
| `backend.mode` | `"auto"` (`auto` \| `lsp` \| `ideMode`) | M5 |
| `checking.trigger`, `checking.delay` | `"onSave"`, `700` ms | M2 |
| `checking.saveBeforeAction` | `"always"` (`always` \| `prompt` \| `never`) | M4 |
| `checkOnType.enabled`, `checkOnType.delay` | `true`, `500` ms (shadow) | M6 |
| `ideMode.transport` | `"stdio"` (`stdio` \| `socket`; user settings only; until 2026-09-28 `"auto"` as built, planned `"socket"`, ROADMAP §9 Q20) | M2 |
| `ideMode.isolateBuildDir` | `true` | M2 |
| `ideMode.loosePackages` | `[]` (`-p` flags for loose files) | M2 |
| `ideMode.extraArgs` | `[]` (never `--ide-mode` or `--ide-mode-socket`: nothing starts, `docs/as-built/M2.md`, *ARCHITECTURE §5.1*) | M2 |
| `ideMode.requestTimeout`, `ideMode.longActionTimeout`, `ideMode.idleTimeout` | `5000`, `60000`, `600000` ms | M2 |
| `ideMode.maxSessions`, `ideMode.maxBackgroundChecks` | `0`, `0` (no limit; ROADMAP §9 Q21) | M2 |
| `diagnostics.includeSourceExcerpt` | `false` | M2 |
| `lsp.{logFile,logSeverity,longActionTimeout,maxCodeActionResults,showImplicits,showMachineNames,fullNamespace,briefCompletions}` | server defaults [landscape §3] | M5 |
| `lsp.trace.server` | `"off"` | M5 |
| `keybindings.scheme` | `"chords"` on macOS, `"prefix"` elsewhere (as built: `"auto"`, which means that, §10) | M3 or M4, whichever ships first (both contribute bindings under it, §10) |
| `holes.showInSideBar` | `true` | M4 |
| `goalPanel.autoOpen`, `goalPanel.followCursor`, `goalPanel.debounce` | `false`, `true`, `50` ms | M7 |
| `eval.inlineResults` | `true` | M3 |
| `eval.timeout` | `10000` ms (as built; the time limit of an evaluation, *review of M3*) | M3 |
| `inlayHints.variableTypes`, `inlayHints.multiplicities` | `true`, `false` (the latter [open]; not created in M3, which has no multiplicity hints) | M3 |
| `repl.reloadOnSave` | `false` | M8 |
| `build.tool` | `"auto"` (`auto` \| `idris2` \| `pack`) | M9 |
| `test.runnerCommand` | `""` (convention) | M10 |
| `literate.extensions` | `[".lidr", ".idr.md", ".lidr.md", …]` (see M12) | M12 |
| `input.enabled`, `input.leader`, `input.eagerReplacement`, `input.customTranslations`, `input.languages` | `false`, `"\\"`, `true`, `{}`, `["idris2","lidr"]` | M13 |
| `docs.onlineBaseUrl` | `""` | M14 |
| `trace.protocol` | `false` (dump raw frames) | M2 |

**As built (M1, M2).** The keys of M1 and M2 in the table exist. Their scopes, which of them are
`restrictedConfigurations`, the bounds of the time limits and limits, and how a value of the
wrong type reads are recorded in `docs/as-built/M1.md` and `docs/as-built/M2.md`, *ARCHITECTURE
§11*. **As built (M3):** `inlayHints.variableTypes`, `eval.inlineResults` (both `window` scope,
on unless `false`), `eval.timeout` (`window`, 1000 ms to 2^31 − 1 ms, added by the review of M3)
and `keybindings.scheme` (`application` scope, read by VS Code's `when` clauses only) exist;
`docs/as-built/M3.md`, *Settings*. **As built (M4):** `checking.saveBeforeAction` (`resource`
scope, like the rest of `checking.*`; Next Result and Next Definition never save) and
`holes.showInSideBar` (`window` scope; read by the view's `when` clause only) exist, and
**Show Keybindings** reads `keybindings.scheme` through `Config.keybindingScheme`.

Migration (M5): on first activation, if bamboo's `idris2-lsp.*` settings exist, offer to copy
them with this key map (F36): `idris2-lsp.loglevel → idris2.lsp.logSeverity` (bamboo's key
name differs from the server option it never actually read), `idris2-lsp.{logFile,
longActionTimeout, maxCodeActionResults, showImplicits, showMachineNames, fullNamespace,
briefCompletions} → idris2.lsp.<same>`, `idris2-lsp.path → idris2.toolchain.lspPath`,
`idris2-lsp.trace.server → idris2.lsp.trace.server`.

---

## 12. Testing layers and fixtures

| Layer | Runner | Needs | Covers |
|---|---|---|---|
| Unit | mocha on Node (`npm run test:unit`, < 5 s) | nothing | `sexp` (escaping, bare symbols), `wire` (byte framing round-trips `"`, `\`, newline, `→`; EOF tail), `positions` (the §7 table, literate offset), reply decoders on recorded transcripts, `:warning` mapping, CLI parser on recorded `--check`/`--build` output, ipkg JSON, version parsing/verdicts, `IdeSession` against `FakeTransport` (id mismatch, noise, delays, crash) |
| Grammar | `vscode-textmate` + `vscode-oniguruma` snapshots (`npm run test:grammar`) | nothing | scopes over `test/fixtures/grammar/*.idr`, `.lidr`, `.ipkg`, injections |
| Integration | `@vscode/test-cli` (Electron, per fixture workspace) | VS Code download | activation, contributions, commands, providers, settings, routing, diagnostics rendering, hole views, task UI — driven by `test/fake-idris2` (stdio + socket) and `test/fake-lsp` replaying transcripts |
| E2E | same runner, `IDRIS2_E2E=1` | real `idris2` (+ `idris2-lsp`) | the facts in `ROADMAP.md` §0 as regression tests (planned: every row; as built in M2: F1–F7, F10, F12–F14, F29–F33); `IDRIS2_RECORD=1` refreshes `test/fixtures/transcripts/<version>/` |
| Contract | mocha suite parameterised over backends | as above | the same fixture yields the same holes/types/edits from `IdeBackend` and `LspBackend`; owned by whichever of M4/M5 ships second (§3.3), runs against the fakes in CI and the real toolchain in e2e |
| Manual | `docs/checklists/Mn.md` | — | 5–10 steps per milestone before tagging |

**As built (M1, M2).** The suites that exist and what drives them, the transcript recorder (`npm
run record:transcripts`, in place of `IDRIS2_RECORD=1`), the fake compiler's faults and the unit
suite's run time are recorded in `docs/as-built/M1.md` and `docs/as-built/M2.md`, *ARCHITECTURE
§12*; `test/README.md` describes every suite. M3 adds the integration suites `intelligence`
(`simple-ipkg`) and `intelligence-loose` (`broken`), the fake compiler's replay by session role
and its request log, and the e2e file `intelligence.test.ts` (`docs/as-built/M3.md`, *Tests*). M4
adds the integration suites `editing` (`broken`) and `holes` (`holes`), the fake compiler's
held-back answers and its replay matching without queries, the e2e file `editing.test.ts`, and a
differential test of the edits' line reader against M0's lexer (unit, and the corpus suite in CI)
beside the lexer oracle's check of that lexer (local); the contract suite is M5's
(`docs/as-built/M4.md`, *Tests*).

Fixture workspaces: `loose-file/` (no ipkg, `import Data.Vect`), `simple-ipkg/` (`sourcedir =
"src"`, `depends = contrib`, two modules), `multi-module/` (one error in a sub-module),
`broken/` (type error, coverage error, unreachable clause; `Clean.idr` = the F30 editing
fixture, `Plain.idr` = F15's non-hole clause, `Ambig.idr` = F29's ambiguous refine),
`literate/` (`.lidr`, `.md`, `.tex`, `.org`, `.typ`), `golden-tests/` (`Test.Golden` layout:
`tests.ipkg`, `<pool>/<case>/{run,expected}`, two cases — also E8's recording source). The
M6 e2e runs on a fresh copy of `simple-ipkg` with no `build/` directory (F32).

Determinism: no test depends on wall-clock timeouts < 1 s; the fake compiler can inject the
id-mismatch and noise faults on demand. `.vscode-test.mjs` passes a short `--user-data-dir`
(or the checkout lives at a short path) because the Electron IPC socket path is limited to
103 characters (F17). `@vscode/test-cli` 0.0.15 honours a `--user-data-dir` given in
`launchArgs` [live, 2026-09-27: pointing it at `/tmp/vi2-t` moved the run's logs there and none
were written under the default `.vscode-test/user-data`]. `.vscode-test.mjs` also writes
`chat.disableAIFeatures: true` into that profile before each run: in VS Code 1.139.1 the chat
input, itself a code editor, kept the editor focus when the test window started without OS
focus, and editor commands went to it [live, 2026-09-27: without the setting neither `type` nor
`editor.action.insertLineAfter` changed the document, and the Enter suite failed in its setup; with the
setting the `insertLineAfter` variant passed in every later run, while the `type` variant still
failed 2 tests in 1 of 2 runs, so the tests use `insertLineAfter`, which falls back to the
active editor when no code editor has focus]. The M0 activation test is the one
deliberate exception to the 1 s rule: it asserts open → active < 250 ms on the development
machine and < 1,000 ms when `CI` is set (the reasoning, with the one CI data point, is in
`test/integration/activation.test.ts`).

---

## 13. Build, bundle, package, publish

- **Toolchain**: TypeScript 6.x pinned initially (generator-code 1.12.0 pins `^6.0.3`;
  `latest` is 7.0.2 — landscape §1), `esbuild` 0.28.x, `typescript-eslint` 8.x,
  `@vscode/test-cli` 0.0.15, `@vscode/test-electron` 3.1.x, `vscode-languageclient` ^10.1.1,
  `@types/vscode` 1.138.x with `engines.vscode ^1.138.0`.
- **Scripts**: `compile` (esbuild both entries), `watch`, `check-types` (`tsc --noEmit`),
  `lint`, `test:unit`, `test:grammar`, `test` (integration), `test:e2e`, `package`
  (`vsce package`), `vscode:prepublish` (production bundle). Added in M0: `build:grammar`,
  `build:language-configuration`, `test:corpus` (fetches the pinned corpora; needs network),
  `check:fixtures` (needs `idris2`), `docs:graph` / `docs:graph:check`.
- **Bundle budget**: extension < 1 MB, webview < 300 KB; no native dependencies → one
  universal `.vsix`; `extensionKind: ["workspace"]` (spawns local processes).
- **CI (GitHub Actions)**: `ubuntu-latest` — lint, types, unit, grammar, integration
  (`xvfb-run`), `vsce package` artifact; `macos-latest` — integration + e2e with
  `brew install idris2` (0.8.0); `windows-latest` — lint/unit/integration only until socket
  mode and path quoting are verified [open]. Optional jobs: nightly against Idris 2 master
  (allowed to fail, opens a tracking issue); weekly LSP e2e via `pack` (compatibility canary).
  Since 2026-09-28 there is no `windows-latest` job: native Windows is out of scope (ROADMAP §9,
  platforms).
- **Publishing**: tags `vX.Y.Z` → `vsce publish` (Marketplace) and `ovsx publish` (Open VSX)
  from CI secrets; `--pre-release` channel for master-tracking builds. `@vscode/vsce` 4 and
  `ovsx` require Node ≥ 22 [npm, per plan-ecosystem; not re-verified].

---

## 14. Decisions

| # | Decision | Rationale | Rejected alternatives |
|---|---|---|---|
| D1 | **stdio** (`--ide-mode`) for the `check` session by default on every platform; the socket (`--ide-mode-socket`) only as an explicit opt-in in user settings (`idris2.ideMode.transport`, `application` scope — not a workspace's settings nor a remote machine's; `machine` until the M2 verification of the Q20–Q22 fixes, which a dev container's configuration could fill —; an `extraArgs` naming it starts nothing, since the compiler would serve the socket whatever `transport` says; the takeover detection stays for the opt-in). Decided by the user on 2026-09-28 (ROADMAP §9 Q20); the transport of M3's `eval` session, which runs `:exec`, is revisited in M3 — **settled before M3** (2026-09-28, ROADMAP §9): Evaluate evaluates expressions only and sends no `:exec`, so the `eval` session follows the same rule | The socket's port serves the first local connection, unauthenticated, and whoever wins can run programs as the user (`:interpret ":sh …"`, `:exec`) [src + live, `docs/as-built/M2.md`, *ARCHITECTURE §5.1*]; stdio opens no port. The original reason for the socket — `:exec`/IO output is written unframed into the stdio stream (F5) — does not apply to the `check` session, which sends no `:exec` of its own (a raw request typed with the developer command can), and the compiler's log lines and other unframed output in the stdio stream are read as the process's output since the M2 review (`docs/as-built/M2.md`, *ARCHITECTURE §5.1*, *Unframed bytes*; one limitation left: a log line quoting a reply header, `docs/guide.md`, *Known limitations*). **History:** until 2026-09-28 D1 read "socket transport by default, stdio fallback", and M2 as first built defaulted to `auto` (socket on macOS and Linux, stdio on Windows) | the socket by default (the unauthenticated port); an authenticated socket upstream (U2, not available today); stdio only with "never send :exec" for the `eval` session (breaks on any IO evaluation — M3 decides its transport; since 2026-09-28 this is what the `eval` session does, because the user chose to have Evaluate show IO actions rather than run them, ROADMAP §9) |
| D2 | Request frame length = UTF-8 **bytes** incl. trailing newline; **reply** frames are read by their prefix in **code points** | Verified: byte count round-trips `→`, code-point count desynchronises (F1); landscape §4.3 agrees. The compiler prefixes its replies with their length in code points (F1 addendum [live]), so a reader that cuts replies by bytes desynchronises on the first non-ASCII reply | counting characters as the rst says [doc] — wrong in practice on 0.8.0 for requests, right for replies |
| D3 | Separate `eval` session from the `check` session | `:set` persists across loads; evaluation of IO must not touch checking state | re-asserting options after each eval via `:get-options` (fragile) |
| D4 | One `IdeSession` pool per ProjectRoot with cwd = ipkg dir (loose: file dir), never `--find-ipkg` | `findIpkg` walks up from the process cwd and `chdir`s (F13; [src `Package.idr` 1093–1110]); loads from a foreign cwd fail even with absolute paths, and `--find-ipkg` from a subdirectory breaks relative loads (F13) | one global process (cannot serve two projects); `--find-ipkg` |
| D5 | `--build-dir <root>/<build>/.vscode-idris2` isolation when the ipkg has no `builddir`; the resulting `effectiveCheckBuildDir` is exposed by the `SessionPool` and is what the shadow role imports from (F32) | avoids TTC races with the user's builds and the server (not between two VS Code windows checking one root, which share it, §5.2 [open]); the ipkg field overrides the flag (F12), so isolation is conditional and documented; `<root>/build/ttc` does not exist in a fresh clone (F32) | always share the project build dir; a separate `IDRIS2_PREFIX` |
| D6 | Check-while-typing via shadow copies + `IDRIS2_PATH` (M6), not debounced auto-save by default | verified mechanism that never writes user files and needs no upstream change (F8) | debounced `document.save()` (kept as an opt-in trigger); waiting for U3 |
| D7 | `IdrisBackend` + `NullBackend` from M0; routing per root; LSP ownership via middleware | LSP and IDE backends can be built in either order; per-root switching without client restart | document selectors (need a client restart); one backend only |
| D8 | Forward LSP settings by sending `didChangeConfiguration` with the flat options object | `processSettings` reads top-level keys [src] | `synchronize.configurationSection` (nests by dotted path; ignored by the server) |
| D9 | Diagnostics severity from the `:return` kind + a known-warning table | `:warning` frames carry no severity; warning-only loads return `:ok` (F7) | treating every frame as an error (wrong for `Unreachable clause`) |
| D10 | Never trust CLI exit codes alone | `--check` exits 0 on `Module X not found` (F9) | exit-code-driven task results |
| D11 | Read `.ipkg` through `idris2 --dump-ipkg-json`; validate via its errors | the compiler is the parser of record; error format `Error: … "f.ipkg":L:C--L:C` is usable (F10) | hand-written ipkg parser as primary (kept only as a fallback when idris2 is absent). As built (M1): the fallback also serves Restricted Mode, an `.ipkg` outside the workspace folders, a path the compiler's path parser would read differently and a failed run; the compiler is given the `.ipkg`'s absolute path and runs in its own directory (`docs/as-built/M1.md`, *Model*, *Roots outside the workspace folders*) |
| D12 | Literate positions: `.lidr` needs a client-side unlit-column offset both ways; `.md` exact | verified (F11); upstream fix Idris2 #1508 [gh, unverified here] | treating all literate styles alike |
| D13 | Goal display = webview panel; hole list = tree view | rich rendering + buttons vs. cheap navigation; Lean's InfoView is a webview | tree only; `WebviewView` in the side bar |
| D14 | Vanilla TS webview, no framework | small bundle, no CSP surprises | React; `@vscode-elements/elements` (may be added later) |
| D15 | Record/replay fake compiler and fake LSP server for CI | three-OS CI without a compiler, transcripts recorded from the real one keep the fake honest | e2e only (slow, needs toolchain on every runner) |
| D16 | One keybinding surface = **our own commands** on both backends; our IDE-mode actions carry the server's filter-key kinds (F34); on LSP, actions are requested with `only` and selected by title; `:missing` for Add Missing Cases | the server returns only the generic `refactor.rewrite` kind, so `editor.action.codeAction` with a specific kind cannot be the shared surface (F34, E24); `:add-missing` is a stub (F3), `:interpret ":missing"` works (F15) | `editor.action.codeAction` keybindings with kinds; parsing the diagnostic text only |
| D17 | No regex-based definition/references/rename | wrong under shadowing, locals and overloads (landscape §2.2); missing capabilities are named and routed upstream | zjhmale-style workspace regex scans |
| D18 | Idris 1 out of scope unless requested (M16) | protocol v1 differs, Idris 1 not installed, two extensions already serve it | v1 branch in every protocol module |
| D19 | No telemetry, no network | private by construction; the README states it and a test scans the bundle for network APIs (`fetch(`, `http(s).request`, non-loopback `net.connect`) — not for URL literals, which the Help commands hold for `vscode.env.openExternal` (ROADMAP M15) | opt-in telemetry |
| D20 | Pair verdict = `idris2-lsp --version`'s `Idris2 API` vs `idris2 --version`, plus pack-layout heuristic | the flag exists [src `Server/Main.idr` 206–218]; `serverInfo.version` is the constant `"0.1"` [src]; the true coupling is the pinned commit/TTC, so the verdict is a heuristic and runtime failures are also detected. As built (M1): equal version texts are compatible whatever the layout, and the layout only chooses the explanation of a mismatch (`docs/as-built/M1.md`, *Pair verdict*) | `serverInfo.version` (useless); assuming compatibility |
| D21 | One document selector (`idrisDocumentSelector()`/`isIdrisDocument()`/`idris2.isIdrisDocument`) from M0, used by every registration | literate hosts keep their language ids (M12), so language-id selectors would exclude them and force a retrofit of M2–M5 | per-provider language-id selectors; dedicated literate language ids (breaks Markdown preview / LaTeX Workshop) |
| D22 | Guided installs are pre-typed terminal commands (`brew install idris2`, pack's install script, `pack install-app idris2-lsp`); the extension never executes them | zero-setup users need an actionable route on day one (gap 8), principle 8 forbids silent network access | downloading binaries (rust-analyzer style); no install help until M15 |
