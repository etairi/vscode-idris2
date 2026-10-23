#!/usr/bin/env node
// Records idris2-lsp transcripts from the real language server: the ground truth that the fake
// language server (test/fake-lsp) replays and that the LSP backend's decoding is tested against
// (docs/ROADMAP.md M5, docs/ARCHITECTURE.md §12). The file format is described in
// test/fixtures/lsp-transcripts/README.md; the scenarios are the SCENARIOS table below. Modelled on
// scripts/record-transcripts.mjs (the IDE-mode recorder).
//
// For each scenario the script copies the scenario's fixture workspace to a temporary directory
// (so that no build/ directory lands in the repository), starts one `idris2-lsp` (no arguments:
// JSON-RPC over stdin/stdout, `Server/Main.idr` 211–218) with that copy as its working directory,
// as the extension starts it in a workspace folder, sends `initialize` (the client capabilities
// the server reads, as vscode-languageclient 10.1.2 sets them, and the scenario's
// initializationOptions), `initialized`, the scenario's steps and `shutdown`/`exit`, and writes
// every message in both directions (with the Content-Length each carried), the bytes of the
// server's stdout that are not part of a message, its stderr lines (the server's log), the
// changes the scenario made to the files, the exit status and the files the server wrote, in the
// order they arrived, with the temporary paths replaced by placeholders, to
// test/fixtures/lsp-transcripts/<server version>/<scenario>.jsonl.
//
// Each request is sent only after the response of the previous one, and every step is followed by
// a quiet period (QUIET_MS without output) so that the log lines a step causes are recorded before
// the next step; the server handles one message at a time, in order (`runServer`), so the waiting
// changes no answer, only where stderr lines fall between messages. Requests the server sends
// (`workspace/semanticTokens/refresh` after a save) are answered at once with `null`.
//
// Processes run strictly one after another (CLAUDE.md: one compiler at a time on this machine;
// idris2-lsp is a compiler), each in its own process group, which is killed when the process
// outlives PROCESS_LIMIT_MS or a response takes longer than REQUEST_LIMIT_MS. POSIX only.
//
// Usage: node scripts/record-lsp-transcripts.mjs [--out <dir>] [--list] [scenario ...]
//   IDRIS2_LSP=<absolute path> selects the server (default: the first idris2-lsp on PATH). pack's
//   wrapper (~/.local/bin/idris2-lsp, or $PACK_BIN_DIR/idris2-lsp) runs pack, which reads
//   PACK_BIN_DIR at every run: set it when pack's bin directory is not ~/.local/bin.
//   --out <dir> writes <dir>/<version>/*.jsonl instead of test/fixtures/lsp-transcripts/<version>/.
//   With no scenario names every scenario is recorded, and a .jsonl file in the output directory
//   that no scenario wrote is deleted; with names only those are recorded.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(repo, 'test', 'fixtures');
const FORMAT = 1;
const PROCESS_LIMIT_MS = 300_000;
const REQUEST_LIMIT_MS = 120_000;
const EXIT_LIMIT_MS = 20_000;
/** Output-free time after each step before the next one is sent. */
const QUIET_MS = 300;
/** Length of every recorded workspace root (see `record`). */
const ROOT_LENGTH = 128;
const ROOT = '${ROOT}';
const HOME = '${HOME}';

// ---------------------------------------------------------------------------------------------
// The client side of the session.
// ---------------------------------------------------------------------------------------------

/**
 * The client capabilities sent in `initialize`. idris2-lsp `9a2f0ad` reads three of them
 * [src]: `textDocument.hover.contentFormat` (Markdown is used when listed, `ProcessMessage.idr`
 * 398), `textDocument.publishDiagnostics` (`relatedInformation`, `Server/Diagnostics.idr` 108–160)
 * and `workspace.semanticTokens.refreshSupport` (a `workspace/semanticTokens/refresh` request after
 * each save, `ProcessMessage.idr` 590–592). Those are set as vscode-languageclient 10.1.2 sets them
 * (`lib/common/hover.js` 52, `client.js` 1662–1666, `semanticTokens.js` 100 [src]); the rest is a
 * small subset of what that client sends, not a copy of it.
 */
const CLIENT_CAPABILITIES = {
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    didChangeConfiguration: { dynamicRegistration: false },
    executeCommand: { dynamicRegistration: false },
    semanticTokens: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: true },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: false,
      tagSupport: { valueSet: [1, 2] },
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    codeAction: {
      dynamicRegistration: false,
      isPreferredSupport: true,
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'],
        },
      },
    },
  },
};

/**
 * The initializationOptions the extension sends with its default settings (`backend/lsp/types.ts`
 * `LspServerOptions`, built from `core/config.ts` `readLspSettings`; `logFile` left out when the
 * setting is empty): the server's own defaults, in the flat form `processSettings` reads (F20).
 */
const DEFAULT_OPTIONS = {
  logSeverity: 'debug',
  longActionTimeout: 1000,
  maxCodeActionResults: 5,
  showImplicits: false,
  showMachineNames: false,
  fullNamespace: false,
  briefCompletions: false,
};

/**
 * The same with `logSeverity: 'info'`, used by most scenarios: at `debug` the server writes every
 * message it receives and sends into its log a second time (`Received message: …`, `Response
 * sent: …`), which would double each recording; `initialize` and `features-cross` keep `debug`.
 */
const INFO_OPTIONS = { ...DEFAULT_OPTIONS, logSeverity: 'info' };

// ---------------------------------------------------------------------------------------------
// Scenarios. `workspace` is a directory of test/fixtures, copied to `${ROOT}`, where the server
// starts; `fixtures` the files (relative to it) the scenario opens or the server reads, whose
// SHA-256 goes into the transcript so that a changed fixture can be detected; `extra` maps a path
// of the copy to a file of test/fixtures copied there before the server starts. Steps:
//   open(file)            textDocument/didOpen (version 1, the file's text), then wait for the
//                         publishDiagnostics of that file (`wait: /re/`: for a stderr line
//                         matching it instead)
//   change(file, from, to, text)   textDocument/didChange, one incremental change (the server
//                         syncs incrementally); the recorder keeps the document's text
//   save(file)            writes the document's text to the copy, then textDocument/didSave with
//                         the text (the server's save option includeText), waits as `open` and,
//                         without `wait`, for the server's workspace/semanticTokens/refresh
//   close(file)           textDocument/didClose
//   hover(file, position), codeAction(file, position, only), command(name, args), …   requests;
//                         ${ROOT} in params stands for the root
//   config(settings)      workspace/didChangeConfiguration
//   remove(file)          deletes a file of the copy (recorded as an `fs` event)
// Positions are 0-based lines and UTF-16 columns of the file (LSP); `at(file, line, needle)`
// finds the column of `needle` in the fixture's line, so that no column is counted by hand.
// ---------------------------------------------------------------------------------------------

const fixtureLines = new Map();
function lineOf(workspace, file, line) {
  const key = `${workspace}/${file}`;
  if (!fixtureLines.has(key)) {
    fixtureLines.set(key, fs.readFileSync(path.join(FIXTURES, workspace, file), 'utf8').split('\n'));
  }
  const text = fixtureLines.get(key)[line];
  if (text === undefined) {
    throw new Error(`${key} has no line ${line}`);
  }
  return text;
}

/** A scenario-definition helper bound to one workspace. */
function workspaceHelpers(workspace) {
  const uri = (file) => `file://${ROOT}/${file}`;
  const doc = (file) => ({ textDocument: { uri: uri(file) } });
  /** `{ line, character }` of the `n`-th (from 0) occurrence of `needle` on `line`, plus `offset`. */
  const at = (file, line, needle, offset = 0, n = 0) => {
    const text = lineOf(workspace, file, line);
    let column = -1;
    for (let k = 0; k <= n; k++) {
      column = text.indexOf(needle, column + 1);
      if (column < 0) {
        throw new Error(`${workspace}/${file}:${line}: no ${JSON.stringify(needle)} #${n} in ${JSON.stringify(text)}`);
      }
    }
    return { line, character: column + offset };
  };
  const pos = (line, character) => ({ line, character });
  const request = (method, params) => ({ step: 'request', method, params });
  const positional = (method) => (file, position) => request(method, { ...doc(file), position });
  const range = (position) => ({ start: position, end: position });
  return {
    at,
    pos,
    open: (file, options = {}) => ({ step: 'open', file, ...options }),
    change: (file, from, to, text) => ({ step: 'change', file, range: { start: from, end: to }, text }),
    save: (file, options = {}) => ({ step: 'save', file, ...options }),
    close: (file) => ({ step: 'close', file }),
    remove: (file) => ({ step: 'remove', file }),
    config: (settings) => ({ step: 'notify', method: 'workspace/didChangeConfiguration', params: { settings } }),
    hover: positional('textDocument/hover'),
    definition: positional('textDocument/definition'),
    highlight: positional('textDocument/documentHighlight'),
    signatureHelp: positional('textDocument/signatureHelp'),
    completion: (file, position) => request('textDocument/completion', { ...doc(file), position, context: { triggerKind: 1 } }),
    symbols: (file) => request('textDocument/documentSymbol', doc(file)),
    tokens: (file) => request('textDocument/semanticTokens/full', doc(file)),
    /**
     * textDocument/codeAction at `position` (an empty range), with `only` when given. With
     * `published: true` the context carries the diagnostics last published for the file whose
     * range contains the position, as VS Code passes them.
     */
    codeAction: (file, position, only, options = {}) => ({
      step: 'request',
      method: 'textDocument/codeAction',
      params: {
        ...doc(file),
        range: range(position),
        context: { diagnostics: [], ...(only === undefined ? {} : { only }), triggerKind: 1 },
      },
      published: options.published === true,
    }),
    command: (command, args) => request('workspace/executeCommand', { command, arguments: args }),
    /** The `CodeActionParams` of `exprSearchWithHints` and `refineHole` (F20, F34). */
    actionParams: (file, position, only) => ({
      ...doc(file),
      range: range(position),
      context: { diagnostics: [], ...(only === undefined ? {} : { only }) },
    }),
  };
}

const K = {
  addClause: 'refactor.rewrite.AddClause',
  caseSplit: 'refactor.rewrite.CaseSplit',
  exprSearch: 'refactor.rewrite.ExprSearch',
  generateDef: 'refactor.rewrite.GenerateDef',
  generateDefNext: 'refactor.rewrite.GenerateDefNext',
  intro: 'refactor.rewrite.Intro',
  makeCase: 'refactor.rewrite.MakeCase',
  makeWith: 'refactor.rewrite.MakeWith',
  refineHole: 'refactor.rewrite.RefineHole',
  makeLemma: 'refactor.extract.MakeLemma',
};

/**
 * What the server logs when it cannot load a file for want of an `.ipkg`: F35 expected `Cannot load
 * ipkg file for …`, but Idris 2's `findIpkg (Just f)` answers `Just f` when it finds none
 * (`src/Idris/Package.idr` 1093–1110 at `1c630e6`), so the build fails instead and the handler ends
 * with an error (seen in `loose-file`); both are waited for.
 */
const NO_IPKG = /Error while handling notification|Cannot load ipkg file/;

const LSP = 'workspaces/lsp-ipkg';
const L = workspaceHelpers(LSP);
const CLEAN = 'src/Clean.idr';
const EDITS = 'src/Edits.idr';
const LIT2 = 'src/Lit2.lidr';

/** The three hole commands that answer for a hole at `position`: Make Lemma, Make Case, Make With. */
const holeEdits = (h, file, position) => [
  h.codeAction(file, position, [K.makeLemma]),
  h.codeAction(file, position, [K.makeCase]),
  h.codeAction(file, position, [K.makeWith]),
];

const SCENARIOS = [
  {
    name: 'initialize',
    description: 'initialize with the extension\'s default options (logSeverity debug): the server capabilities and serverInfo, the log lines of the options applied; then shutdown and exit',
    facts: ['F20'],
    workspace: LSP,
    fixtures: [],
    options: DEFAULT_OPTIONS,
    steps: [],
  },
  {
    name: 'options',
    description: 'initializationOptions applied (showImplicits on): hover on vlen and xs in Clean.idr; workspace/didChangeConfiguration with the flat object turns it off, a nested object (as synchronize.configurationSection would send it) is ignored, and the extension\'s whole object',
    facts: ['F20'],
    workspace: LSP,
    fixtures: [CLEAN],
    options: { ...INFO_OPTIONS, showImplicits: true },
    steps: [
      L.open(CLEAN),
      L.hover(CLEAN, L.at(CLEAN, 6, 'vlen')),
      L.hover(CLEAN, L.at(CLEAN, 7, 'xs')),
      L.config({ showImplicits: false }),
      L.hover(CLEAN, L.at(CLEAN, 6, 'vlen')),
      L.config({ idris2: { lsp: { showImplicits: true } } }),
      L.hover(CLEAN, L.at(CLEAN, 6, 'vlen')),
      L.config({ ...INFO_OPTIONS, showImplicits: true, fullNamespace: true }),
      L.hover(CLEAN, L.at(CLEAN, 6, 'vlen')),
      L.config({ ...INFO_OPTIONS, longActionTimeout: 'x', showImplicits: 1 }),
    ],
  },
  {
    name: 'diagnostics',
    description: 'didOpen of Foo/B.idr (clean, imports Foo.A) and Part.idr (two coverage errors): the publishDiagnostics; the quick fixes with context.only quickfix and without only, at each error (F28); Add Clause and Generate Definition, hover and semanticTokens/full in the file with errors; didSave of Part.idr (diagnostics again and a workspace/semanticTokens/refresh request); a quick fix after didClose (the file is loaded again)',
    facts: ['F28', 'F34'],
    workspace: LSP,
    fixtures: ['src/Foo/A.idr', 'src/Foo/B.idr', 'src/Part.idr'],
    options: INFO_OPTIONS,
    steps: [
      L.open('src/Foo/B.idr'),
      L.open('src/Part.idr'),
      L.codeAction('src/Part.idr', L.at('src/Part.idr', 2, 'g'), ['quickfix'], { published: true }),
      L.codeAction('src/Part.idr', L.at('src/Part.idr', 2, 'g'), undefined, { published: true }),
      L.codeAction('src/Part.idr', L.at('src/Part.idr', 5, 'main'), ['quickfix'], { published: true }),
      L.codeAction('src/Part.idr', L.at('src/Part.idr', 2, 'g'), [K.addClause]),
      L.codeAction('src/Part.idr', L.at('src/Part.idr', 5, 'main'), [K.generateDef]),
      L.hover('src/Part.idr', L.at('src/Part.idr', 6, 'printLn')),
      L.tokens('src/Part.idr'),
      L.save('src/Part.idr'),
      L.codeAction('src/Part.idr', L.at('src/Part.idr', 2, 'g'), ['quickfix'], { published: true }),
      L.close('src/Part.idr'),
      L.codeAction('src/Part.idr', L.at('src/Part.idr', 2, 'g'), ['quickfix']),
    ],
  },
  {
    name: 'dirty',
    description: 'Clean.idr: hover before and after an unsaved change (the server answers null for a dirty file), semanticTokens/full (RequestCancelled "Document Dirty"), documentSymbol, documentHighlight, definition, signatureHelp and codeAction while dirty; then didSave and the same requests again',
    facts: ['F20'],
    workspace: LSP,
    fixtures: [CLEAN],
    options: INFO_OPTIONS,
    steps: [
      L.open(CLEAN),
      L.hover(CLEAN, L.at(CLEAN, 7, 'xs')),
      L.tokens(CLEAN),
      L.change(CLEAN, L.pos(8, 0), L.pos(8, 0), '-- edited\n'),
      L.hover(CLEAN, L.at(CLEAN, 7, 'xs')),
      L.tokens(CLEAN),
      L.symbols(CLEAN),
      L.highlight(CLEAN, L.at(CLEAN, 7, 'xs')),
      L.definition(CLEAN, L.at(CLEAN, 7, 'vlen')),
      L.signatureHelp(CLEAN, L.at(CLEAN, 7, 'vlen')),
      L.codeAction(CLEAN, L.at(CLEAN, 7, '?vlen_rhs'), [K.makeLemma]),
      L.save(CLEAN),
      L.hover(CLEAN, L.at(CLEAN, 7, 'xs')),
      L.tokens(CLEAN),
      L.symbols(CLEAN),
      L.codeAction(CLEAN, L.at(CLEAN, 7, '?vlen_rhs'), [K.makeLemma]),
    ],
  },
  {
    name: 'features-shapes',
    description: 'Foo/Shapes.idr: documentSymbol, semanticTokens/full, hover (a function, a constructor, a local, an interface method, an operator), documentHighlight of a local, definition (in the file and in the prelude), signatureHelp',
    facts: ['F20'],
    workspace: LSP,
    fixtures: ['src/Foo/Shapes.idr'],
    options: INFO_OPTIONS,
    steps: (() => {
      const F = 'src/Foo/Shapes.idr';
      return [
        L.open(F),
        L.symbols(F),
        L.tokens(F),
        L.hover(F, L.at(F, 11, 'area')),
        L.hover(F, L.at(F, 12, 'Circle')),
        L.hover(F, L.at(F, 12, 'r)')),
        L.hover(F, L.at(F, 19, 'perimeter')),
        L.hover(F, L.at(F, 40, '|+|')),
        L.highlight(F, L.at(F, 12, 'r)')),
        L.definition(F, L.at(F, 40, 'area')),
        L.definition(F, L.at(F, 12, 'pi')),
        L.signatureHelp(F, L.at(F, 40, 'area')),
        L.signatureHelp(F, L.at(F, 28, 'Circle', 0, 1)),
      ];
    })(),
  },
  {
    name: 'features-cross',
    description: 'Foo/B.idr (imports Foo.A), logSeverity debug: hover and definition of shout (in Foo/A.idr, not open); browseNamespace of Foo.A, Foo.B, a namespace not imported and an unknown one; completion after incremental changes (prefixes of three and two characters; text inserted after the last line break); hover while dirty',
    facts: ['F20'],
    workspace: LSP,
    fixtures: ['src/Foo/A.idr', 'src/Foo/B.idr'],
    options: DEFAULT_OPTIONS,
    steps: (() => {
      const F = 'src/Foo/B.idr';
      return [
        L.open(F),
        L.hover(F, L.at(F, 6, 'shout')),
        L.definition(F, L.at(F, 6, 'shout')),
        L.command('browseNamespace', ['Foo.A']),
        L.command('browseNamespace', ['Foo.B']),
        L.command('browseNamespace', ['Data.Vect']),
        L.command('browseNamespace', ['Nope.Nothing']),
        // Completion reads the identifier around the position in the server's copy of the
        // document, which each didChange updates: first a change inside a line (`greeting = sho
        // "hello"`), then an insertion after the file's last line break, which that copy appends to
        // the last line (lsp-lib `takePos`/`dropPos`), probed at its line and where it went.
        L.change(F, L.pos(6, 11), L.pos(6, 16), 'sho'),
        L.completion(F, L.pos(6, 14)),
        L.completion(F, L.pos(6, 13)),
        L.change(F, L.pos(7, 0), L.pos(7, 0), 'y = gre'),
        L.completion(F, L.pos(7, 7)),
        L.completion(F, L.pos(6, 29)),
        L.hover(F, L.at(F, 6, 'shout')),
      ];
    })(),
  },
  {
    name: 'actions-clean',
    description: 'Clean.idr (the F30 fixture): codeAction with each context.only key of ARCHITECTURE §3.3 at its place (Case Split on xs at columns 0 to 10, Add Clause and Generate Definition on append, the hole commands at the hole\'s columns), Generate next definition three times, Intro, Expression search; without only, with the generic refactor.rewrite / refactor.extract and with quickfix',
    facts: ['F29', 'F30', 'F34'],
    workspace: LSP,
    fixtures: [CLEAN],
    options: INFO_OPTIONS,
    steps: (() => {
      const hole = L.at(CLEAN, 7, '?vlen_rhs');
      const append = L.at(CLEAN, 4, 'append');
      return [
        L.open(CLEAN),
        ...Array.from({ length: 11 }, (_, c) => L.codeAction(CLEAN, L.pos(7, c), [K.caseSplit])),
        L.codeAction(CLEAN, append, [K.addClause]),
        L.codeAction(CLEAN, L.at(CLEAN, 6, 'vlen'), [K.addClause]),
        L.codeAction(CLEAN, L.pos(7, hole.character - 1), [K.makeLemma]),
        L.codeAction(CLEAN, hole, [K.makeLemma]),
        L.codeAction(CLEAN, L.pos(7, hole.character + 1), [K.makeLemma]),
        L.codeAction(CLEAN, L.pos(7, hole.character + 9), [K.makeLemma]),
        L.codeAction(CLEAN, hole, [K.makeWith]),
        L.codeAction(CLEAN, hole, [K.makeCase]),
        L.codeAction(CLEAN, hole, [K.intro]),
        L.codeAction(CLEAN, hole, [K.exprSearch]),
        L.codeAction(CLEAN, hole, [K.refineHole]),
        L.codeAction(CLEAN, append, [K.generateDef]),
        L.codeAction(CLEAN, append, [K.generateDefNext]),
        L.codeAction(CLEAN, append, [K.generateDefNext]),
        L.codeAction(CLEAN, append, [K.generateDefNext]),
        L.codeAction(CLEAN, hole),
        L.codeAction(CLEAN, hole, ['refactor.rewrite']),
        L.codeAction(CLEAN, hole, ['refactor.extract']),
        L.codeAction(CLEAN, hole, ['quickfix']),
        L.codeAction(CLEAN, append),
      ];
    })(),
  },
  {
    name: 'commands-clean',
    description: 'Clean.idr: executeCommand metavars (F26), exprSearchWithHints without and with hints, refineHole with S, a name of the wrong type and an unparsable expression; maxCodeActionResults 2 through didChangeConfiguration and Expression search again; an unknown command and the advertised refineHoleWithHints',
    facts: ['F20', 'F26', 'F34'],
    workspace: LSP,
    fixtures: [CLEAN],
    options: INFO_OPTIONS,
    steps: (() => {
      const hole = L.at(CLEAN, 7, '?vlen_rhs');
      return [
        L.open(CLEAN),
        L.command('metavars', []),
        L.command('exprSearchWithHints', [{ codeAction: L.actionParams(CLEAN, hole), hints: [] }]),
        L.command('exprSearchWithHints', [{ codeAction: L.actionParams(CLEAN, hole), hints: ['S', 'nope'] }]),
        L.command('exprSearchWithHints', [{ codeAction: L.actionParams(CLEAN, hole, [K.exprSearch]), hints: [] }]),
        L.command('refineHole', [{ codeAction: L.actionParams(CLEAN, hole), hint: 'S' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(CLEAN, hole, [K.refineHole]), hint: 'S' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(CLEAN, hole), hint: 'True' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(CLEAN, hole), hint: 'S (' }]),
        L.config({ ...INFO_OPTIONS, maxCodeActionResults: 2 }),
        L.codeAction(CLEAN, hole, [K.exprSearch]),
        L.command('refineHoleWithHints', [{ codeAction: L.actionParams(CLEAN, hole), hint: 'S' }]),
        L.command('nope', []),
      ];
    })(),
  },
  {
    name: 'ambig',
    description: 'Ambig.idr (F29\'s fixture): refineHole with the ambiguous foo (no action; the error only in the log, F34), with A.foo and Ambig.B.foo; Intro and Expression search on the hole; metavars',
    facts: ['F29', 'F34'],
    workspace: LSP,
    fixtures: ['src/Ambig.idr'],
    options: INFO_OPTIONS,
    steps: (() => {
      const F = 'src/Ambig.idr';
      const hole = L.at(F, 13, '?g_rhs');
      return [
        L.open(F),
        L.command('refineHole', [{ codeAction: L.actionParams(F, hole), hint: 'foo' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(F, hole), hint: 'A.foo' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(F, hole), hint: 'Ambig.B.foo' }]),
        L.codeAction(F, hole, [K.intro]),
        L.codeAction(F, hole, [K.exprSearch]),
        L.command('metavars', []),
      ];
    })(),
  },
  {
    name: 'plain',
    description: 'Plain.idr: Case Split and all actions on f n = n (no hole); hover, signatureHelp (the doc comment holds 𝕟, outside the BMP) and documentSymbol; metavars with no hole',
    facts: ['F15', 'F20'],
    workspace: LSP,
    fixtures: ['src/Plain.idr'],
    options: INFO_OPTIONS,
    steps: (() => {
      const F = 'src/Plain.idr';
      return [
        L.open(F),
        L.codeAction(F, L.at(F, 4, 'n'), [K.caseSplit]),
        L.codeAction(F, L.at(F, 4, 'n')),
        L.hover(F, L.at(F, 4, 'f')),
        L.signatureHelp(F, L.at(F, 4, 'f')),
        L.symbols(F),
        L.command('metavars', []),
      ];
    })(),
  },
  {
    name: 'repl',
    description: 'E10: executeCommand repl in the context of Clean.idr: an expression, an IO action (shown, not run), a name with a hole, and the colon commands :t id and :version (no :exec is sent)',
    facts: ['F20'],
    workspace: LSP,
    fixtures: [CLEAN],
    options: INFO_OPTIONS,
    steps: [
      L.open(CLEAN),
      L.command('repl', ['1 + 1']),
      L.command('repl', ['putStrLn "hi"']),
      L.command('repl', ['vlen [1, 2]']),
      L.command('repl', [':t id']),
      L.command('repl', [':version']),
      L.command('repl', [42]),
    ],
  },
  {
    name: 'edits-shapes',
    description: 'E15 over LSP, Edits.idr: Add Clause and Generate Definition on each line of a three-line type declaration; Case Split and the hole commands on a clause continued over the next lines, in a where block, in a with block, on an operator, with the hole in a let, in case alternatives (also on one line) and under an application',
    facts: ['F34'],
    workspace: LSP,
    fixtures: [EDITS],
    options: INFO_OPTIONS,
    steps: [
      L.open(EDITS),
      // zip3 : Vect n a -> / Vect n b -> Vect n c -> / Vect n (a, b, c)   (lines 7–9, no clauses)
      L.codeAction(EDITS, L.at(EDITS, 7, 'zip3'), [K.addClause]),
      L.codeAction(EDITS, L.at(EDITS, 8, 'Vect'), [K.addClause]),
      L.codeAction(EDITS, L.at(EDITS, 9, 'Vect'), [K.addClause]),
      L.codeAction(EDITS, L.at(EDITS, 7, 'zip3'), [K.generateDef]),
      L.codeAction(EDITS, L.at(EDITS, 9, 'Vect'), [K.generateDef]),
      // count xs = / ?count_rhs   (lines 13–14)
      L.codeAction(EDITS, L.at(EDITS, 13, 'xs'), [K.caseSplit]),
      ...holeEdits(L, EDITS, L.at(EDITS, 14, '?count_rhs')),
      // step m / n / = ?step_rhs   (lines 17–19)
      L.codeAction(EDITS, L.at(EDITS, 17, 'm'), [K.caseSplit]),
      L.codeAction(EDITS, L.at(EDITS, 18, 'n'), [K.caseSplit]),
      L.codeAction(EDITS, L.at(EDITS, 16, 'step'), [K.addClause]),
      ...holeEdits(L, EDITS, L.at(EDITS, 19, '?step_rhs')),
      // where / go : Nat -> List Nat -> Nat / go acc ys = ?go_rhs   (lines 24–26)
      L.codeAction(EDITS, L.at(EDITS, 26, 'ys'), [K.caseSplit]),
      L.codeAction(EDITS, L.at(EDITS, 25, 'go'), [K.addClause]),
      ...holeEdits(L, EDITS, L.at(EDITS, 26, '?go_rhs')),
      // classify n with (n > 10) / classify n | True = ?classify_big   (lines 30–31)
      L.codeAction(EDITS, L.at(EDITS, 31, 'n'), [K.caseSplit]),
      L.codeAction(EDITS, L.at(EDITS, 29, 'classify'), [K.addClause]),
      ...holeEdits(L, EDITS, L.at(EDITS, 31, '?classify_big')),
      // x <&&> y = ?op_rhs (line 38); (<||>) : Bool -> Bool -> Bool (line 40, no clauses)
      L.codeAction(EDITS, L.at(EDITS, 38, 'x'), [K.caseSplit]),
      L.codeAction(EDITS, L.at(EDITS, 38, 'y'), [K.caseSplit]),
      L.codeAction(EDITS, L.at(EDITS, 37, '(<&&>)'), [K.addClause]),
      L.codeAction(EDITS, L.at(EDITS, 40, '(<||>)'), [K.addClause]),
      ...holeEdits(L, EDITS, L.at(EDITS, 38, '?op_rhs')),
      // withLet n = let m = S n in ?let_rhs   (line 44)
      L.codeAction(EDITS, L.at(EDITS, 44, 'n'), [K.caseSplit]),
      ...holeEdits(L, EDITS, L.at(EDITS, 44, '?let_rhs')),
      // withCase mn = case mn of / Nothing => ?case_nothing / Just k => ?case_just   (lines 47–49)
      L.codeAction(EDITS, L.at(EDITS, 49, 'k'), [K.caseSplit]),
      ...holeEdits(L, EDITS, L.at(EDITS, 48, '?case_nothing')),
      ...holeEdits(L, EDITS, L.at(EDITS, 49, '?case_just')),
      // inline n = case n of m => ?inline_rhs   (line 52)
      L.codeAction(EDITS, L.at(EDITS, 52, 'm'), [K.caseSplit]),
      ...holeEdits(L, EDITS, L.at(EDITS, 52, '?inline_rhs')),
      // under n = S ?under_rhs   (line 56)
      L.codeAction(EDITS, L.at(EDITS, 56, 'n ='), [K.caseSplit]),
      ...holeEdits(L, EDITS, L.at(EDITS, 56, '?under_rhs')),
    ],
  },
  {
    name: 'edits-searches',
    description: 'E15/E24 over LSP, Edits.idr: Expression search (one, several and no results), Intro (one, two and no candidates), Generate Definition and next (also on an operator), refineHole with a unique name, a local, a constructor and failing; metavars; the hole commands on a primed and on non-ASCII names',
    facts: ['F26', 'F29', 'F30', 'F34'],
    workspace: LSP,
    fixtures: [EDITS],
    options: INFO_OPTIONS,
    steps: (() => {
      const choose = L.at(EDITS, 60, '?choose_rhs');
      const check = L.at(EDITS, 69, '?check_rhs');
      const label = L.at(EDITS, 72, '?label_rhs');
      const pair = L.at(EDITS, 77, '?pair_rhs');
      const fun = L.at(EDITS, 80, '?fun_rhs');
      const under = L.at(EDITS, 56, '?under_rhs');
      return [
        L.open(EDITS),
        L.codeAction(EDITS, choose, [K.exprSearch]),
        L.codeAction(EDITS, check, [K.exprSearch]),
        L.codeAction(EDITS, label, [K.exprSearch]),
        L.codeAction(EDITS, pair, [K.exprSearch]),
        L.codeAction(EDITS, fun, [K.exprSearch]),
        L.codeAction(EDITS, under, [K.exprSearch]),
        L.command('exprSearchWithHints', [{ codeAction: L.actionParams(EDITS, check), hints: ['isBig'] }]),
        L.command('exprSearchWithHints', [{ codeAction: L.actionParams(EDITS, label), hints: ['describe'] }]),
        L.codeAction(EDITS, check, [K.intro]),
        L.codeAction(EDITS, pair, [K.intro]),
        L.codeAction(EDITS, label, [K.intro]),
        L.codeAction(EDITS, fun, [K.intro]),
        L.codeAction(EDITS, under, [K.intro]),
        L.codeAction(EDITS, L.at(EDITS, 74, 'swap'), [K.generateDef]),
        L.codeAction(EDITS, L.at(EDITS, 74, 'swap'), [K.generateDefNext]),
        L.codeAction(EDITS, L.at(EDITS, 40, '(<||>)'), [K.generateDef]),
        L.codeAction(EDITS, L.at(EDITS, 59, 'choose'), [K.generateDef]),
        L.command('refineHole', [{ codeAction: L.actionParams(EDITS, label), hint: 'describe' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(EDITS, check), hint: 'isBig' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(EDITS, pair), hint: 'MkPair' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(EDITS, pair), hint: 'x' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(EDITS, label), hint: 'isBig' }]),
        L.command('refineHole', [{ codeAction: L.actionParams(EDITS, label), hint: 'undefinedName' }]),
        L.command('metavars', []),
        ...holeEdits(L, EDITS, L.at(EDITS, 84, "?h'")),
        L.codeAction(EDITS, L.at(EDITS, 84, "x'"), [K.caseSplit]),
        ...holeEdits(L, EDITS, L.at(EDITS, 87, '?ε')),
        L.codeAction(EDITS, L.at(EDITS, 87, 'x₁'), [K.caseSplit]),
        L.codeAction(EDITS, L.at(EDITS, 87, '?ε'), [K.intro]),
        L.hover(EDITS, L.at(EDITS, 87, 'x₁')),
        L.symbols(EDITS),
      ];
    })(),
  },
  {
    name: 'holes-ipkg',
    description: 'E16 over LSP, holes-ipkg: metavars after loading Holes.Main (which imports Holes.Util, which imports Holes.Base; a hole todo in Main and in Base), the hole commands on Main\'s todo and on size_rhs; then Holes.Other and metavars again',
    facts: ['F26'],
    workspace: 'workspaces/holes-ipkg',
    fixtures: ['holes.ipkg', 'src/Holes/Main.idr', 'src/Holes/Util.idr', 'src/Holes/Base.idr', 'src/Holes/Other.idr'],
    options: INFO_OPTIONS,
    steps: (() => {
      const H = workspaceHelpers('workspaces/holes-ipkg');
      const main = 'src/Holes/Main.idr';
      const todo = H.at(main, 7, '?todo');
      const size = H.at(main, 10, '?size_rhs');
      return [
        H.open(main),
        H.command('metavars', []),
        H.codeAction(main, todo, [K.makeLemma]),
        H.codeAction(main, todo, [K.intro]),
        H.codeAction(main, todo, [K.exprSearch]),
        H.codeAction(main, size, [K.makeLemma]),
        H.open('src/Holes/Other.idr'),
        H.command('metavars', []),
      ];
    })(),
  },
  {
    name: 'lit2',
    description: 'E1 (bird tracks): Lit2.lidr in the ipkg: diagnostics, documentSymbol, semanticTokens/full, hover on xs at its file and its unlit column, Case Split and the hole commands at file and unlit columns, Intro and metavars; below the line `> ` (two lines of the unlit text, F11), hover and Case Split at the file line and at the compiler\'s line',
    facts: ['F11'],
    workspace: LSP,
    fixtures: [LIT2],
    options: INFO_OPTIONS,
    steps: (() => {
      const xs = L.at(LIT2, 8, 'xs');
      const hole = L.at(LIT2, 8, '?vlen_rhs');
      const n = L.at(LIT2, 17, 'n');
      const unlit = (p) => L.pos(p.line, p.character - 2);
      return [
        L.open(LIT2),
        L.symbols(LIT2),
        L.tokens(LIT2),
        L.hover(LIT2, xs),
        L.hover(LIT2, unlit(xs)),
        L.codeAction(LIT2, xs, [K.caseSplit]),
        L.codeAction(LIT2, unlit(xs), [K.caseSplit]),
        ...holeEdits(L, LIT2, hole),
        ...holeEdits(L, LIT2, unlit(hole)),
        L.codeAction(LIT2, unlit(hole), [K.intro]),
        L.codeAction(LIT2, L.at(LIT2, 10, 'vapp'), [K.addClause]),
        L.command('metavars', []),
        L.hover(LIT2, n),
        L.hover(LIT2, unlit(n)),
        L.hover(LIT2, L.pos(n.line + 1, n.character - 2)),
        L.codeAction(LIT2, unlit(n), [K.caseSplit]),
        L.codeAction(LIT2, L.pos(n.line + 1, n.character - 2), [K.caseSplit]),
      ];
    })(),
  },
  {
    name: 'literate-md',
    description: 'E1 (Markdown): test/fixtures/ipkg/literate (lit.ipkg): didOpen of Lit/Mark.idr.md, Lit/Twice.md and Lit/Bird.lidr (bird tracks after prose): diagnostics, documentSymbol and hover in each',
    facts: ['F11', 'F23'],
    workspace: 'ipkg/literate',
    fixtures: ['lit.ipkg', 'src/Lit/Mark.idr.md', 'src/Lit/Twice.md', 'src/Lit/Twice.idr', 'src/Lit/Bird.lidr'],
    options: INFO_OPTIONS,
    steps: (() => {
      const H = workspaceHelpers('ipkg/literate');
      const mark = 'src/Lit/Mark.idr.md';
      const twice = 'src/Lit/Twice.md';
      const bird = 'src/Lit/Bird.lidr';
      return [
        H.open(mark),
        H.symbols(mark),
        H.hover(mark, H.at(mark, 6, 'mark')),
        H.open(twice),
        H.symbols(twice),
        H.hover(twice, H.at(twice, 6, 'fromMarkdown')),
        H.open(bird),
        H.symbols(bird),
        H.hover(bird, H.at(bird, 5, 'bird')),
        H.hover(bird, H.pos(5, 0)),
      ];
    })(),
  },
  {
    name: 'logging',
    description: 'A module with a %logging pragma (broken/Logging.idr, copied into the ipkg\'s src): where the compiler\'s LOG lines go while the server loads it (over IDE mode they enter the protocol stream, F5), then hover',
    facts: ['F5'],
    workspace: LSP,
    extra: { 'src/Logging.idr': 'workspaces/broken/Logging.idr' },
    fixtures: ['src/Logging.idr'],
    options: INFO_OPTIONS,
    steps: [L.open('src/Logging.idr'), L.hover('src/Logging.idr', L.pos(7, 0))],
  },
  {
    name: 'loose-file',
    description: 'F35: a workspace without an .ipkg (loose-file): didOpen of Vlen.idr (no diagnostics; the log says it cannot load the ipkg), then hover, documentSymbol, codeAction and metavars about it, and hover about Hello.idr, which was not opened',
    facts: ['F35'],
    workspace: 'workspaces/loose-file',
    fixtures: ['Vlen.idr', 'Hello.idr'],
    options: INFO_OPTIONS,
    steps: (() => {
      const H = workspaceHelpers('workspaces/loose-file');
      return [
        H.open('Vlen.idr', { wait: NO_IPKG }),
        H.hover('Vlen.idr', H.pos(0, 0)),
        H.symbols('Vlen.idr'),
        H.codeAction('Vlen.idr', H.pos(0, 0)),
        H.command('metavars', []),
        H.hover('Hello.idr', H.pos(0, 0)),
        H.save('Vlen.idr', { wait: NO_IPKG }),
      ];
    })(),
  },
  {
    name: 'ipkg-deleted',
    description: 'F35\'s safety net: Clean.idr loads; the .ipkg is deleted; didSave of Clean.idr (it loads again: the server keeps the options the deleted .ipkg set), then hover about Clean.idr and about Foo/A.idr (not opened), codeAction and documentSymbol about Clean.idr',
    facts: ['F35'],
    workspace: LSP,
    fixtures: ['simple.ipkg', CLEAN, 'src/Foo/A.idr'],
    options: INFO_OPTIONS,
    steps: [
      L.open(CLEAN),
      L.remove('simple.ipkg'),
      L.save(CLEAN),
      L.hover(CLEAN, L.at(CLEAN, 7, 'xs')),
      L.hover('src/Foo/A.idr', L.pos(3, 0)),
      L.codeAction(CLEAN, L.at(CLEAN, 7, '?vlen_rhs'), [K.makeLemma]),
      L.symbols(CLEAN),
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The server to run: IDRIS2_LSP (must be absolute), else the first `idris2-lsp` on PATH. */
function findServer() {
  const configured = process.env.IDRIS2_LSP;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`IDRIS2_LSP must be an absolute path, got ${configured}`);
    }
    return configured;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) {
      continue;
    }
    const candidate = path.join(dir, 'idris2-lsp');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  throw new Error('no idris2-lsp on PATH; set IDRIS2_LSP=<absolute path>');
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const toPosix = (p) => p.split(path.sep).join('/');

/** `p` with the home directory written `~`, so that no transcript names the recording user. */
const homeRelative = (p) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

/** Today in local time, YYYY-MM-DD. */
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every file below `dir` (build directories included) → `size:mtimeMs`. */
function snapshot(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else {
        const st = fs.statSync(p);
        files.set(p, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return files;
}

/** `{ text }` when the bytes are valid UTF-8, else `{ base64 }`. */
function bytesField(bytes) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString('base64') };
  }
}

/** The language id VS Code gives the file (the server ignores it). */
function languageId(file) {
  if (file.endsWith('.lidr')) {
    return 'lidr';
  }
  if (file.endsWith('.md')) {
    return 'markdown';
  }
  return 'idris2';
}

const HEADER_START = Buffer.from('Content-');
const HEADER_END = Buffer.from('\r\n\r\n');

/**
 * Cuts the server's stdout into items as a client must: a message is a header block (lines
 * `Content-Length: N` and optionally `Content-Type: …`, each ending in `\r\n`, then an empty line)
 * followed by N bytes of body (LSP base protocol). Bytes that do not start a header block are
 * unframed output (the compiler's own stdout, if any), up to the next `Content-` or the end of the
 * stream. A body is taken by the byte count of its header, as a client takes it.
 */
class MessageReader {
  constructor(onItem) {
    this.onItem = onItem;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain(false);
  }

  end() {
    this.drain(true);
  }

  drain(ended) {
    while (this.buffer.length > 0) {
      const cut = this.next(ended);
      if (cut === undefined) {
        if (ended) {
          this.onItem({ kind: 'unframed', ...bytesField(this.buffer) });
          this.buffer = Buffer.alloc(0);
        }
        return;
      }
      this.onItem(cut.item);
      this.buffer = this.buffer.subarray(cut.length);
    }
  }

  next(ended) {
    const start = this.buffer.indexOf(HEADER_START);
    if (start !== 0) {
      // Unframed bytes before the next header (or a possible start of one at the end).
      if (start > 0) {
        return { item: { kind: 'unframed', ...bytesField(this.buffer.subarray(0, start)) }, length: start };
      }
      const keep = this.partialHeaderStart();
      if (keep === this.buffer.length) {
        return undefined;
      }
      if (ended && keep === 0) {
        return undefined;
      }
      return { item: { kind: 'unframed', ...bytesField(this.buffer.subarray(0, this.buffer.length - keep)) }, length: this.buffer.length - keep };
    }
    const end = this.buffer.indexOf(HEADER_END);
    if (end < 0) {
      return undefined;
    }
    const header = this.buffer.subarray(0, end + HEADER_END.length).toString('latin1');
    const match = /^Content-Length:\s*(\d+)\r\n/im.exec(header);
    if (match === null) {
      return { item: { kind: 'unframed', ...bytesField(this.buffer.subarray(0, end + HEADER_END.length)) }, length: end + HEADER_END.length };
    }
    const length = Number(match[1]);
    const total = end + HEADER_END.length + length;
    if (this.buffer.length < total) {
      return undefined;
    }
    const body = this.buffer.subarray(end + HEADER_END.length, total);
    return { item: { kind: 'recv', header, length, ...bytesField(body) }, length: total };
  }

  /** How many bytes at the end of the buffer could be the start of `Content-`. */
  partialHeaderStart() {
    for (let k = Math.min(HEADER_START.length - 1, this.buffer.length); k > 0; k--) {
      if (this.buffer.subarray(this.buffer.length - k).equals(HEADER_START.subarray(0, k))) {
        return k;
      }
    }
    return 0;
  }
}

/** Splits a byte stream into lines (each with its `\n`); the rest at the end without one. */
class LineReader {
  constructor(kind, onItem) {
    this.kind = kind;
    this.onItem = onItem;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let newline = this.buffer.indexOf(0x0a); newline >= 0; newline = this.buffer.indexOf(0x0a)) {
      this.onItem({ kind: this.kind, ...bytesField(this.buffer.subarray(0, newline + 1)) });
      this.buffer = this.buffer.subarray(newline + 1);
    }
  }

  end() {
    if (this.buffer.length > 0) {
      this.onItem({ kind: this.kind, ...bytesField(this.buffer) });
      this.buffer = Buffer.alloc(0);
    }
  }
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // the group has ended
  }
}

/** Whether `p` lies inside `range` (both ends included, as VS Code includes a touching diagnostic). */
function contains(range, p) {
  const before = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return before(range.start, p) && before(p, range.end);
}

// ---------------------------------------------------------------------------------------------
// Recording one scenario
// ---------------------------------------------------------------------------------------------

async function record(scenario, server, serverVersion, tmpBase) {
  const workspace = path.join(FIXTURES, scenario.workspace);
  // The copy lives at <tmp>/<scenario name, padded>/<workspace name>, padded so that the root has
  // ROOT_LENGTH characters: the Content-Length of a message that names a path then does not
  // depend on the machine's temporary directory.
  const base = fs.realpathSync(tmpBase);
  const leaf = path.basename(scenario.workspace);
  const padded = ROOT_LENGTH - base.length - leaf.length - 2;
  if (padded < scenario.name.length + 1) {
    throw new Error(`the temporary directory ${base} is too long for a ${ROOT_LENGTH}-character root; set TMPDIR to a shorter one`);
  }
  const holder = path.join(base, `${scenario.name}-`.padEnd(padded, 'x'));
  fs.mkdirSync(holder);
  const copy = path.join(holder, leaf);
  fs.cpSync(workspace, copy, { recursive: true, filter: (src) => path.basename(src) !== 'build' });
  for (const [file, from] of Object.entries(scenario.extra ?? {})) {
    fs.copyFileSync(path.join(FIXTURES, from), path.join(copy, file));
  }
  const root = fs.realpathSync(copy);
  if (root.length !== ROOT_LENGTH || !/^[A-Za-z0-9/._-]+$/.test(root)) {
    throw new Error(`the temporary root ${root} must be ${ROOT_LENGTH} characters that a file URI keeps as they are`);
  }
  const home = os.homedir();
  // Placeholder → the path it stands for. Only these exact spellings are replaced; any other
  // spelling of a temporary directory is reported as a leak below.
  const placeholders = new Map([[ROOT, root], [HOME, home]]);
  const substitute = (text, lengthOnly = false) =>
    [...placeholders].reduce((t, [name, p]) => t.split(name).join(lengthOnly ? 'r'.repeat(Buffer.byteLength(p, 'utf8')) : p), text);
  const anonymise = (text) =>
    [...placeholders].sort((a, b) => b[1].length - a[1].length).reduce((t, [name, p]) => t.split(p).join(name), text);
  const leaks = [holder, tmpBase, base, repo, home];

  const fixtures = {};
  for (const file of scenario.fixtures) {
    const from = scenario.extra?.[file];
    fixtures[file] = sha256(from === undefined ? path.join(workspace, file) : path.join(FIXTURES, from));
  }

  const events = [];
  const waiters = [];
  let lastEventAt = Date.now();
  let placeholderClash;
  /** The diagnostics last published per URI (with placeholders). */
  const published = new Map();
  let write;
  let nextId = 1;
  const push = (event) => {
    if (typeof event.text === 'string' && event.text.includes('${')) {
      placeholderClash ??= event.text;
    }
    events.push(event);
    lastEventAt = Date.now();
    for (const waiter of [...waiters]) {
      if (waiter.test(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  };
  const waitFor = (test, ms, what) =>
    new Promise((resolve, reject) => {
      const waiter = { test, resolve };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`${scenario.name}: no ${what} within ${ms} ms`));
      }, ms);
      waiter.resolve = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
      waiters.push(waiter);
    });
  const quiet = async () => {
    while (Date.now() - lastEventAt < QUIET_MS) {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS - (Date.now() - lastEventAt) + 5));
    }
  };

  /** Sends one message (an object whose strings may hold `${ROOT}`), recorded as `send`. */
  const send = (message) => {
    const body = substitute(JSON.stringify(message));
    const length = Buffer.byteLength(body, 'utf8');
    const header = `Content-Length: ${length}\r\n\r\n`;
    push({ kind: 'send', header, length, text: body });
    write(Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(body, 'utf8')]));
  };
  const request = async (method, params) => {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    await waitFor((e) => e.kind === 'recv' && e.message?.id === id && e.message.method === undefined, REQUEST_LIMIT_MS, `response to ${method} (${id})`);
  };
  const notify = (method, params) => send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });

  const before = snapshot(copy);
  const child = spawn(server, [], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const processTimer = setTimeout(() => killGroup(child), PROCESS_LIMIT_MS);
  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  child.on('error', (error) => push({ kind: 'spawn-error', text: error.message }));
  child.stdin.on('error', (error) => push({ kind: 'stdin-error', text: error.message }));
  write = (bytes) => child.stdin.write(bytes);

  const stderr = new LineReader('stderr', push);
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stderr.on('end', () => stderr.end());
  const messages = new MessageReader((item) => {
    if (item.kind === 'recv' && item.text !== undefined) {
      try {
        item.message = JSON.parse(item.text);
      } catch {
        item.parseError = true;
      }
    }
    push(item);
    const message = item.message;
    if (message?.method === 'textDocument/publishDiagnostics') {
      published.set(anonymise(message.params.uri), message.params.diagnostics);
    }
    if (message?.method !== undefined && message.id !== undefined) {
      // A request of the server (workspace/semanticTokens/refresh): answered at once.
      send({ jsonrpc: '2.0', id: message.id, result: null });
    }
  });
  child.stdout.on('data', (chunk) => messages.push(chunk));
  child.stdout.on('end', () => messages.end());

  /** The documents' texts as the client holds them, and their versions. */
  const documents = new Map();
  /** Files the recorder itself wrote into the copy (saves), left out of `files`. */
  const ownWrites = new Set();
  const diagnosticsOf = (uri) => (e) => e.kind === 'recv' && e.message?.method === 'textDocument/publishDiagnostics' && anonymise(e.message.params.uri) === uri;
  const awaitLoad = async (step, uri) => {
    if (step.wait instanceof RegExp) {
      await waitFor((e) => e.kind === 'stderr' && step.wait.test(e.text ?? ''), REQUEST_LIMIT_MS, `stderr line ${step.wait}`);
      return;
    }
    await waitFor(diagnosticsOf(uri), REQUEST_LIMIT_MS, `diagnostics of ${step.file}`);
  };

  let failure;
  try {
    await request('initialize', {
      processId: null,
      clientInfo: { name: 'vscode-idris2 record-lsp-transcripts' },
      locale: 'en',
      rootPath: ROOT,
      rootUri: `file://${ROOT}`,
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: scenario.options,
      trace: 'off',
      workspaceFolders: [{ uri: `file://${ROOT}`, name: leaf }],
    });
    notify('initialized', {});
    await quiet();
    for (const step of scenario.steps) {
      const uri = step.file === undefined ? undefined : `file://${ROOT}/${step.file}`;
      switch (step.step) {
        case 'open': {
          const text = fs.readFileSync(path.join(root, step.file), 'utf8');
          documents.set(step.file, { text, version: 1 });
          const waiting = awaitLoad(step, uri);
          notify('textDocument/didOpen', { textDocument: { uri, languageId: languageId(step.file), version: 1, text } });
          await waiting;
          break;
        }
        case 'change': {
          const document = documents.get(step.file);
          const lines = document.text.split('\n');
          const offset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
          document.text = document.text.slice(0, offset(step.range.start)) + step.text + document.text.slice(offset(step.range.end));
          document.version++;
          notify('textDocument/didChange', {
            textDocument: { uri, version: document.version },
            contentChanges: [{ range: step.range, rangeLength: offset(step.range.end) - offset(step.range.start), text: step.text }],
          });
          break;
        }
        case 'save': {
          const document = documents.get(step.file);
          fs.writeFileSync(path.join(root, step.file), document.text);
          ownWrites.add(path.join(root, step.file));
          push({ kind: 'fs', action: 'write', file: step.file, sha256: createHash('sha256').update(document.text).digest('hex') });
          const waiting = awaitLoad(step, uri);
          // After a save it loaded, the server asks for a refresh of the semantic tokens (the
          // client capability above), some time after the diagnostics.
          const refresh =
            step.wait === undefined
              ? waitFor((e) => e.kind === 'recv' && e.message?.method === 'workspace/semanticTokens/refresh', REQUEST_LIMIT_MS, 'semantic tokens refresh')
              : undefined;
          notify('textDocument/didSave', { textDocument: { uri }, text: document.text });
          await waiting;
          await refresh;
          break;
        }
        case 'close':
          documents.delete(step.file);
          notify('textDocument/didClose', { textDocument: { uri } });
          break;
        case 'remove':
          fs.rmSync(path.join(root, step.file));
          push({ kind: 'fs', action: 'delete', file: step.file });
          break;
        case 'notify':
          notify(step.method, step.params);
          break;
        case 'request': {
          let params = step.params;
          if (step.published) {
            const position = params.range.start;
            const diagnostics = (published.get(params.textDocument.uri) ?? []).filter((d) => contains(d.range, position));
            params = { ...params, context: { ...params.context, diagnostics } };
          }
          await request(step.method, params);
          break;
        }
        default:
          throw new Error(`unknown step ${step.step}`);
      }
      await quiet();
    }
    await request('shutdown');
    await quiet();
    notify('exit');
    const timer = setTimeout(() => killGroup(child), EXIT_LIMIT_MS);
    const { code, signal } = await exited;
    clearTimeout(timer);
    push({ kind: 'exit', code, signal });
  } catch (error) {
    failure = error;
    killGroup(child);
    await exited;
  } finally {
    clearTimeout(processTimer);
  }
  if (failure !== undefined) {
    failure.events = events.map((e) => ({ ...e, message: undefined, text: typeof e.text === 'string' ? anonymise(e.text) : e.text }));
    throw failure;
  }
  if (placeholderClash !== undefined) {
    throw new Error(`${scenario.name}: a text contains \`\${\`, which the placeholders use: ${placeholderClash.slice(0, 200)}`);
  }

  const after = snapshot(copy);
  const written = [...after.keys()]
    .filter((p) => before.get(p) !== after.get(p) && !ownWrites.has(p))
    .map((p) => toPosix(path.relative(root, p)))
    .sort();
  push({ kind: 'files', written });

  const usedPlaceholders = [...placeholders].filter(([name, p]) => events.some((e) => typeof e.text === 'string' && (e.text.includes(p) || e.text.includes(name))));
  const meta = {
    kind: 'meta',
    format: FORMAT,
    scenario: scenario.name,
    description: scenario.description,
    facts: scenario.facts,
    server: { ...serverVersion, executable: homeRelative(server) },
    platform: `${process.platform} ${process.arch}`,
    recorded: localDate(),
    workspace: toPosix(path.relative(repo, workspace)),
    ...(scenario.extra === undefined
      ? {}
      : { extra: Object.fromEntries(Object.entries(scenario.extra).map(([file, from]) => [file, toPosix(path.relative(repo, path.join(FIXTURES, from)))])) }),
    processCwd: ROOT,
    placeholders: Object.fromEntries(usedPlaceholders.map(([name, p]) => [name, Buffer.byteLength(p, 'utf8')])),
    fixtures,
  };
  const lines = [meta, ...events].map((event) => {
    const out = { ...event };
    delete out.message;
    if (typeof out.text === 'string') {
      out.text = anonymise(out.text);
    }
    if (out.header !== undefined && out.header === `Content-Length: ${out.length}\r\n\r\n`) {
      delete out.header;
    }
    if ((out.kind === 'send' || out.kind === 'recv') && out.text !== undefined) {
      // The Content-Length counts the UTF-8 bytes of the body as sent, with the real paths where
      // placeholders stand.
      const length = Buffer.byteLength(substitute(out.text, true), 'utf8');
      if (out.length !== length) {
        throw new Error(`${scenario.name}: Content-Length ${out.length} is not the byte length ${length} of ${out.text.slice(0, 200)}`);
      }
    }
    if (Array.isArray(out.written)) {
      out.written = out.written.map(anonymise);
    }
    const line = JSON.stringify(out);
    for (const leak of leaks) {
      if (line.includes(leak)) {
        throw new Error(`${scenario.name}: the transcript would contain the local path ${leak}: ${line.slice(0, 300)}`);
      }
    }
    return line;
  });
  // A process of the group that outlived the server (none has been seen) must not survive.
  killGroup(child);
  return { lines, events };
}

let cachedVersion;
/** `idris2-lsp --version`: `Idris2 LSP: <server>` and `Idris2 API: <compiler>` (F20). */
function versionOf(server) {
  if (cachedVersion === undefined) {
    const r = spawnSync(server, ['--version'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) {
      throw new Error(`${server} --version failed (${r.status}): ${r.stdout}${r.stderr}`);
    }
    const text = r.stdout.trim();
    const lsp = /^Idris2 LSP: (\S+)$/m.exec(text);
    const api = /^Idris2 API: (\S+)$/m.exec(text);
    if (lsp === null || api === null) {
      throw new Error(`${server} --version printed ${JSON.stringify(text)}`);
    }
    cachedVersion = { version: lsp[1], api: api[1], versionText: text };
  }
  return cachedVersion;
}

/** One line of the summary: the messages and the responses' kinds. */
function summary(events) {
  const count = (kind) => events.filter((e) => e.kind === kind).length;
  const errors = events.filter((e) => e.kind === 'recv' && e.message?.error !== undefined).length;
  const exit = events.find((e) => e.kind === 'exit');
  return `${count('send')} sent, ${count('recv')} received (${errors} errors), ${count('stderr')} log lines, ${count('unframed')} unframed, exit ${exit?.code ?? exit?.signal}`;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(argv) {
  if (process.platform === 'win32') {
    throw new Error('record-lsp-transcripts.mjs needs POSIX process groups; record on macOS or Linux');
  }
  const names = [];
  let outBase = path.join(repo, 'test', 'fixtures', 'lsp-transcripts');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') {
      for (const s of SCENARIOS) {
        console.log(`${s.name.padEnd(18)} ${s.description}`);
      }
      return;
    }
    if (argv[i] === '--out') {
      outBase = path.resolve(argv[++i]);
    } else {
      names.push(argv[i]);
    }
  }
  const unknown = names.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length > 0) {
    throw new Error(`unknown scenario(s): ${unknown.join(', ')} (--list shows them)`);
  }
  const selected = names.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => names.includes(s.name));
  const server = findServer();
  const serverVersion = versionOf(server);
  console.log(`Using ${server}: ${serverVersion.versionText.replace(/\n/g, ', ')}`);
  const outDir = path.join(outBase, serverVersion.version);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-lsp-rec-'));
  const written = new Set();
  let failures = 0;
  try {
    for (const scenario of selected) {
      try {
        const started = Date.now();
        const { lines, events } = await record(scenario, server, serverVersion, tmpBase);
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, `${scenario.name}.jsonl`);
        fs.writeFileSync(file, `${lines.join('\n')}\n`);
        written.add(path.basename(file));
        console.log(`ok    ${scenario.name}: ${summary(events)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      } catch (error) {
        failures++;
        console.log(`FAIL  ${scenario.name}: ${error.message}`);
        for (const event of (error.events ?? []).slice(-12)) {
          console.log(`      ${JSON.stringify(event).slice(0, 400)}`);
        }
      }
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
  if (names.length === 0 && failures === 0 && fs.existsSync(outDir)) {
    for (const file of fs.readdirSync(outDir)) {
      if (file.endsWith('.jsonl') && !written.has(file)) {
        fs.rmSync(path.join(outDir, file));
        console.log(`removed stale ${file}`);
      }
    }
  }
  console.log(`${written.size} transcript(s) written, ${failures} failed.`);
  process.exitCode = failures > 0 ? 1 : 0;
}

await main(process.argv.slice(2));
