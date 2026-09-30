#!/usr/bin/env node
// Records IDE-mode transcripts from the real compiler: the ground truth that the fake compiler
// (test/fake-idris2) replays and that the protocol decoders are tested against (docs/ROADMAP.md
// M2, docs/ARCHITECTURE.md §12). The file format is described in
// test/fixtures/transcripts/README.md; the scenarios are the SCENARIOS table below.
//
// For each scenario the script copies the scenario's fixture workspace to a temporary directory
// (so that no build/ directory lands in the repository), starts one `idris2 --ide-mode` (or
// `--ide-mode-socket`) process in the session's working directory with the arguments the
// extension uses (docs/ARCHITECTURE.md §5.2: `--no-color --build-dir <root>/build/.vscode-idris2`,
// `…/.vscode-idris2-eval` for the M3 `eval` session, never `--find-ipkg`), sends the scenario's
// requests one at a time — each only after the `:return` of the previous one — and writes every
// frame in both directions, the unframed bytes of the protocol stream, the process's stdout and
// stderr lines, the end of input, the exit status and the files the session wrote, in the order
// they arrived, with the temporary paths replaced by placeholders, to
// test/fixtures/transcripts/<version>/<scenario>.jsonl.
//
// Processes run strictly one after another (CLAUDE.md: one idris2 at a time on this machine),
// each in its own process group, which is killed when the process outlives PROCESS_LIMIT_MS or
// the handshake or a reply takes longer than REQUEST_LIMIT_MS. POSIX only (process groups).
// Recording the same scenarios twice gives byte-identical files.
//
// Usage: node scripts/record-transcripts.mjs [--out <dir>] [--list] [scenario ...]
//   IDRIS2=<absolute path> selects the compiler (default: the first idris2 on PATH).
//   --out <dir> writes <dir>/<version>/*.jsonl instead of test/fixtures/transcripts/<version>/.
//   With no scenario names every scenario is recorded, and a .jsonl file in the output directory
//   that no scenario wrote is deleted; with names only those are recorded.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = path.join(repo, 'test', 'fixtures', 'workspaces');
const FORMAT = 1;
const PROCESS_LIMIT_MS = 120_000;
const REQUEST_LIMIT_MS = 60_000;
const EXIT_LIMIT_MS = 20_000;
/** Length of every recorded session directory (see `record`). */
const ROOT_LENGTH = 128;
const ROOT = '${ROOT}';
const LINK = '${LINK}';
const PORT = '${PORT}';

// ---------------------------------------------------------------------------------------------
// Scenarios. `workspace` is a directory of test/fixtures/workspaces, `cwd` the session's working
// directory inside it (ProjectIndex.sessionCwd: the .ipkg's directory, or a loose file's), and
// `fixtures` the files (relative to `cwd`) the session reads, whose SHA-256 goes into the
// transcript so that a changed fixture can be detected. A request is the command s-expression
// (`(:load-file "${ROOT}/Bad.idr")`, or a bare symbol such as `:version`, F4); the script sends
// `(<command> <id>)` with ids 1, 2, 3, … `{ raw }` is sent verbatim, with `${ID}` replaced by the
// id, for requests that are not well-formed. `${ROOT}` stands for the session directory (its real
// path); with `link: true` the process is started in `${LINK}`, a symbolic link to it.
// `buildDir` is the last component of the `--build-dir` (default `.vscode-idris2`, the `check`
// session's; `.vscode-idris2-eval` for the `eval` session of M3, `backend/ide/types.ts`
// `SessionRole`).
// ---------------------------------------------------------------------------------------------

const load = (file) => `(:load-file "${ROOT}/${file}")`;

/**
 * `value` as a string of a request, written as the extension writes it (`serializeString`,
 * src/backend/ide/sexp.ts): `\` and `"` escaped, printable ASCII as it is, every other character
 * as its decimal escape (`\8469` for ℕ), followed by `\&` when a digit comes next (F1 addendum).
 * No scenario sends NUL or a lone surrogate, which sexp.ts refuses or replaces.
 */
function quote(value) {
  let out = '"';
  let pendingEscape = false;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (pendingEscape && code >= 0x30 && code <= 0x39) {
      out += '\\&';
    }
    pendingEscape = false;
    if (ch === '"' || ch === '\\') {
      out += `\\${ch}`;
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      out += `\\${code}`;
      pendingEscape = true;
    }
  }
  return `${out}"`;
}

/** `(:type-of "<name>" <line> <column>)` (F2: 1-based line, 0-based column), or by name. */
const typeOf = (name, line, column) =>
  (line === undefined ? `(:type-of ${quote(name)})` : `(:type-of ${quote(name)} ${line} ${column})`);
/** The same positional `:type-of` at every column from `from` to `to`, both included. */
const typeOfSweep = (name, line, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => typeOf(name, line, from + i));
const docsFor = (name) => `(:docs-for ${quote(name)})`;
const nameAt = (name) => `(:name-at ${quote(name)})`;
const completions = (prefix) => `(:repl-completions ${quote(prefix)})`;
const browse = (ns) => `(:browse-namespace ${quote(ns)})`;
const interpret = (text) => `(:interpret ${quote(text)})`;

const SCENARIOS = [
  {
    name: 'handshake',
    description: 'Handshake, :version (a bare symbol), unrecognised commands and a parse error answered with the previous id, then end of input',
    facts: ['F4', 'F5'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'stdio',
    fixtures: [],
    requests: [
      ':version',
      '(:version)',
      '(:cd "/tmp")',
      { raw: '((:version ${ID}' },
      ':version',
    ],
  },
  {
    name: 'handshake-socket',
    description: 'The same handshake and :version over --ide-mode-socket: the port on stdout, the protocol on the socket, then the client closes',
    facts: ['F5'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'socket',
    fixtures: [],
    requests: [':version'],
  },
  {
    name: 'load-bad',
    description: 'A type error: one :warning frame, then (:return (:error …))',
    facts: ['F6', 'F33'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Bad.idr'],
    requests: [load('Bad.idr')],
  },
  {
    name: 'load-warn',
    description: 'A warning only (unreachable clause): one :warning frame and (:return (:ok ())); the reload of the unchanged file has no Building line and no :warning frame, but highlighting again',
    facts: ['F7'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Warn.idr'],
    requests: [load('Warn.idr'), load('Warn.idr')],
  },
  {
    name: 'load-mixed',
    description: 'A warning and an error in one file: both arrive as :warning frames, then (:return (:error …))',
    facts: ['F7'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Mixed.idr'],
    requests: [load('Mixed.idr')],
  },
  {
    name: 'load-part',
    description: 'Coverage errors (a Missing cases block); :missing through :interpret; :type-of after the failed load, positional and by name',
    facts: ['F6', 'F15', 'F16'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Part.idr'],
    requests: [load('Part.idr'), '(:interpret ":missing g")', '(:type-of "main" 7 0)', '(:type-of "main")'],
  },
  {
    name: 'load-uses-bad',
    description: 'Loading a module whose import fails: the :warning frame names the imported file (relative to the working directory)',
    facts: ['F6'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['UsesBad.idr', 'Bad.idr'],
    requests: [load('UsesBad.idr')],
  },
  {
    name: 'load-switch',
    description: 'Several files in one session, as the extension loads them: Bad, Warn, Bad again (no TTC: built and reported again), Warn again (fresh TTC: no Building, no warning)',
    facts: ['F6', 'F7'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Bad.idr', 'Warn.idr'],
    requests: [load('Bad.idr'), load('Warn.idr'), load('Bad.idr'), load('Warn.idr')],
  },
  {
    name: 'load-symlink',
    description: 'The session started in a directory spelled through a symbolic link (${LINK}): an absolute path through the link is "not in the source directory" (the real path, ${ROOT}); the real path and a path relative to the working directory load',
    facts: ['F13'],
    workspace: 'broken',
    cwd: '.',
    link: true,
    transport: 'stdio',
    fixtures: ['Clean.idr'],
    requests: [`(:load-file "${LINK}/Clean.idr")`, load('Clean.idr'), '(:load-file "Clean.idr")'],
  },
  {
    name: 'load-bad-ipkg',
    description: 'A malformed .ipkg in the working directory: (:return (:error …)) carrying the package-file location, and no :warning frame',
    facts: ['F10'],
    workspace: 'broken',
    cwd: 'bad-ipkg',
    transport: 'stdio',
    fixtures: ['bad.ipkg', 'Main.idr'],
    requests: [load('Main.idr')],
  },
  {
    name: 'load-simple-ipkg',
    description: 'A package with depends = contrib, loaded by absolute path from the .ipkg directory; the TTC files go to build/.vscode-idris2; the reload has no Building line',
    facts: ['F7', 'F12', 'F13', 'F32'],
    workspace: 'simple-ipkg',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['simple.ipkg', 'src/Foo/A.idr', 'src/Foo/B.idr'],
    requests: [load('src/Foo/B.idr'), load('src/Foo/B.idr')],
  },
  {
    name: 'load-builddir-ipkg',
    description: 'A package whose .ipkg sets builddir: --build-dir is given anyway, and the TTC files go to the builddir (the field overrides the flag)',
    facts: ['F12'],
    workspace: 'builddir-ipkg',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['builddir.ipkg', 'src/Hello.idr'],
    requests: [load('src/Hello.idr')],
  },
  {
    name: 'load-loose',
    description: 'A loose file (no .ipkg) importing Data.Vect from base, from its own directory',
    facts: ['F13'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Hello.idr'],
    requests: [load('Hello.idr')],
  },
  {
    name: 'load-lidr',
    description: 'A bird-track .lidr with a type error after prose: reply columns are unlit, lines are file lines; after the failed load a positional :type-of of the local n of an earlier clause fails at its unlit and at its file column',
    facts: ['F11', 'F16'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Err.lidr'],
    requests: [load('Err.lidr'), '(:type-of "n" 4 2)', '(:type-of "n" 4 4)'],
  },
  {
    name: 'load-lit',
    description: 'A clean bird-track .lidr: positional :type-of of the local n (file column 9) succeeds at its unlit column 7 and fails at its file column 9',
    facts: ['F11'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Lit.lidr'],
    requests: [load('Lit.lidr'), '(:type-of "n" 6 7)', '(:type-of "n" 6 9)'],
  },
  {
    name: 'load-md',
    description: 'Literate Markdown (fenced, double extension .idr.md) with a type error: lines and columns are exact',
    facts: ['F11'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['ErrMd.idr.md'],
    requests: [load('ErrMd.idr.md')],
  },
  {
    name: 'clean-lookups',
    description: 'Clean.idr: positional :type-of at the column bounds of xs, :type-of by name, :docs-for with and without a mode, :name-at unqualified and qualified, :metavariables, and a reload with the ignored line argument',
    facts: ['F2', 'F7', 'F30', 'F31', 'F33'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Clean.idr'],
    requests: [
      load('Clean.idr'),
      '(:type-of "xs" 8 4)',
      '(:type-of "xs" 8 5)',
      '(:type-of "xs" 8 7)',
      '(:type-of "xs" 8 8)',
      '(:type-of "vlen")',
      '(:docs-for "id")',
      '(:docs-for "id" :full)',
      '(:docs-for "id" :overview)',
      '(:name-at "vlen_rhs")',
      '(:name-at "Clean.vlen_rhs")',
      '(:metavariables 80)',
      `(:load-file "${ROOT}/Clean.idr" 3)`,
    ],
  },
  {
    name: 'clean-editing',
    description: 'Clean.idr: :case-split at the column bounds, :add-clause, :make-lemma/-with/-case, :proof-search and -next, :all, :generate-def and -next, :intro, :refine',
    facts: ['F2', 'F29', 'F30', 'F31'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Clean.idr'],
    requests: [
      load('Clean.idr'),
      '(:case-split 8 0 "xs")',
      '(:case-split 8 1 "xs")',
      '(:case-split 8 8 "xs")',
      '(:case-split 8 9 "xs")',
      '(:add-clause 5 "append")',
      '(:make-lemma 8 "vlen_rhs")',
      '(:make-with 8 "vlen_rhs")',
      '(:make-case 8 "vlen_rhs")',
      '(:proof-search 8 "vlen_rhs" ())',
      ':proof-search-next',
      ':proof-search-next',
      '(:proof-search 8 "vlen_rhs" () :all)',
      '(:generate-def 5 "append")',
      ':generate-def-next',
      ':generate-def-next',
      '(:intro 8 "vlen_rhs")',
      '(:refine 8 "vlen_rhs" "S")',
    ],
  },
  {
    name: 'ambig-refine',
    description: ':refine with a name defined in two namespaces: the ambiguity error',
    facts: ['F29'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Ambig.idr'],
    requests: [load('Ambig.idr'), '(:refine 14 "g_rhs" "foo")'],
  },
  {
    name: 'plain',
    description: 'Plain.idr: :case-split on a clause without a hole, :printdef, a reply with non-ASCII text (prefix in code points), a request with non-ASCII text (prefix in UTF-8 bytes, read as Latin-1)',
    facts: ['F1', 'F15'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Plain.idr'],
    requests: [
      load('Plain.idr'),
      '(:case-split 5 0 "n")',
      '(:interpret ":printdef f")',
      '(:docs-for "f")',
      '(:interpret "\\"→\\"")',
      '(:bogus "é")',
    ],
  },
  {
    name: 'stubs',
    description: 'The eleven commands that are stubs on 0.8.0: a :write-string notice, then an empty :ok',
    facts: ['F3'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: [],
    requests: [
      '(:name-at "vlen_rhs" 8 10)',
      '(:add-missing 5 "f")',
      '(:apropos "id")',
      '(:directive "lazy")',
      '(:who-calls "f")',
      '(:calls-who "f")',
      '(:normalise-term "1 + 1")',
      '(:show-term-implicits "id")',
      '(:hide-term-implicits "id")',
      '(:elaborate-term "id")',
      '(:print-definition "id")',
    ],
  },
  {
    name: 'enable-syntax',
    description: '(:enable-syntax :False), then a load without any :highlight-source frame',
    facts: ['F14'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Clean.idr'],
    requests: ['(:enable-syntax :False)', load('Clean.idr')],
  },
  {
    name: 'exec-stdio',
    description: ':exec over stdio: the program output arrives unframed in the protocol stream',
    facts: ['F5'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'stdio',
    fixtures: [],
    requests: ['(:interpret ":exec putStrLn \\"hi\\"")'],
  },
  {
    name: 'exec-stdio-putstr',
    description: ':exec of output without a final newline over stdio: the next reply follows it on the same line, unframed text then a frame',
    facts: ['F5'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'stdio',
    fixtures: [],
    requests: ['(:interpret ":exec putStr \\"hi\\"")'],
  },
  {
    name: 'exec-stdio-putstr-digit',
    description: ':exec of hex digits without a final newline over stdio: the output runs into the next reply\'s six-digit header (7000015(:return …), which a reader must not take for a header of seven or eight digits',
    facts: ['F5'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'stdio',
    fixtures: [],
    requests: ['(:interpret ":exec putStr \\"7\\"")', '(:interpret ":exec putStr \\"ab\\"")'],
  },
  {
    name: 'load-logging',
    description: 'A %logging pragma: while the file is built the compiler prints LOG lines (and an empty line) unframed into the protocol stream over stdio, between the Building write-string and the :return',
    facts: ['F5'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Logging.idr'],
    requests: [load('Logging.idr')],
  },
  {
    name: 'exec-socket',
    description: ':exec over the socket: the program output goes to the process stdout, the socket stream stays framed',
    facts: ['F5'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'socket',
    fixtures: [],
    requests: ['(:interpret ":exec putStrLn \\"hi\\"")'],
  },
  // E5 (ROADMAP §9): one file per warning constructor of Core/Core.idr on 0.8.0 (UnreachableClause
  // is load-warn above).
  ...[
    ['parser', 'ParserWarn.idr', 'ParserWarning: the four texts of Idris/Parser.idr (withWarning)'],
    ['shadow-global', 'ShadowGlobal.idr', 'ShadowingGlobalDefs'],
    ['shadow-local', 'ShadowLocal.idr', 'ShadowingLocalBindings'],
    ['visibility', 'Visibility.idr', 'IncompatibleVisibility'],
    ['deprecated', 'Deprecated.idr', 'Deprecated (%deprecate): no location line in the message'],
    ['generic', 'GenericWarn.idr', 'GenericWarn: a fixity without an export modifier, and %unhide of a name that is not hidden'],
  ].map(([kind, file, what]) => ({
    name: `warning-${kind}`,
    description: `E5: ${what}`,
    facts: ['F7', 'F28'],
    workspace: 'broken',
    cwd: 'warnings',
    transport: 'stdio',
    fixtures: [file],
    requests: [load(file)],
  })),
  {
    name: 'warning-ipkg-deprecated',
    description: 'E5: Deprecated from the .ipkg (version = "0.1"), reported while the package file is read at every :load-file',
    facts: ['F7', 'F28'],
    workspace: 'broken',
    cwd: 'warnings/old-version',
    transport: 'stdio',
    fixtures: ['old.ipkg', 'Main.idr'],
    requests: [load('Main.idr'), load('Main.idr')],
  },
  // M3 (ROADMAP §5 M3): the queries of the read-only features, each after a load of the file as
  // the `check` session makes it, and the evaluations of the `eval` session.
  {
    name: 'shapes-lookups',
    description: 'Foo/Shapes.idr in simple-ipkg (the semantic-tokens fixture): its highlighting; positional :type-of on globals (declarations, definitions, uses, operators) and on every :bound token (pattern variables, an interface parameter, let- and lambda-bound names), and by name; :docs-for with and without docs (a constructor, the type, an interface and its method, an operator); :name-at; :browse-namespace of its own namespace, of Data.Vect (not imported) and of an unknown one; :repl-completions',
    facts: ['F2', 'F30', 'F31', 'F33'],
    workspace: 'simple-ipkg',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['simple.ipkg', 'src/Foo/Shapes.idr'],
    requests: [
      load('src/Foo/Shapes.idr'),
      // Globals at the start of their token, on declarations, definitions and uses.
      typeOf('Shape', 5, 5),
      typeOf('Circle', 7, 2),
      typeOf('Rectangle', 8, 2),
      typeOf('area', 12, 0),
      typeOf('area', 13, 0),
      typeOf('Circle', 13, 6),
      typeOf('pi', 13, 18),
      typeOf('*', 13, 21),
      typeOf('Measured', 18, 10),
      typeOf('perimeter', 20, 2),
      typeOf('perimeter', 24, 2),
      typeOf('scale', 28, 0),
      typeOf('twice', 33, 0),
      typeOf('|+|', 40, 1),
      typeOf('|+|', 41, 2),
      typeOf('+', 41, 17),
      // Every :bound token of the load's highlighting, at its start (what the inlay hints ask):
      // pattern variables, the interface parameter, let- and lambda-bound names.
      ...[
        ['r', 13, 13], ['r', 13, 23], ['r', 13, 27],
        ['w', 14, 16], ['h', 14, 18], ['w', 14, 23], ['h', 14, 27],
        ['a', 18, 19], ['a', 20, 14], ['r', 24, 20], ['r', 24, 34],
        ['w', 25, 23], ['h', 25, 25], ['w', 25, 35], ['h', 25, 39],
        ['k', 29, 6], ['r', 29, 16], ['r\'', 29, 25], ['k', 29, 30], ['r', 29, 34], ['r\'', 29, 46],
        ['k', 30, 6], ['w', 30, 19], ['h', 30, 21], ['k', 30, 37],
        ['w', 30, 41], ['k', 30, 45], ['h', 30, 49],
        ['f', 34, 6], ['s', 34, 11], ['f', 34, 16], ['f', 34, 19], ['s', 34, 21],
        ['a', 41, 0], ['b', 41, 6], ['a', 41, 15], ['b', 41, 24],
      ].map(([name, line, column]) => typeOf(name, line, column)),
      typeOf('area'),
      typeOf('Circle'),
      typeOf('Shape'),
      typeOf('perimeter'),
      typeOf('|+|'),
      typeOf('+'),
      typeOf('r'),
      docsFor('area'),
      docsFor('scale'),
      docsFor('Circle'),
      docsFor('Rectangle'),
      docsFor('Shape'),
      docsFor('Measured'),
      docsFor('perimeter'),
      docsFor('|+|'),
      docsFor('pi'),
      docsFor('nope'),
      nameAt('area'),
      nameAt('Circle'),
      nameAt('perimeter'),
      nameAt('|+|'),
      nameAt('r'),
      nameAt('pi'),
      browse('Foo.Shapes'),
      browse('Data.Vect'),
      browse('Nope.Nothing'),
      completions('ar'),
      completions('Ci'),
      completions('|+'),
    ],
  },
  {
    name: 'simple-ipkg-lookups',
    description: 'Foo/B.idr in simple-ipkg: positional :type-of of greeting and of shout (imported from Foo.A), :name-at of a name of another module and of this one, :docs-for without docs, :browse-namespace of the imported module, :repl-completions; then Foo/A.idr loaded in the same session (its TTC is fresh) and positional :type-of there',
    facts: ['F2', 'F13'],
    workspace: 'simple-ipkg',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['simple.ipkg', 'src/Foo/A.idr', 'src/Foo/B.idr'],
    requests: [
      load('src/Foo/B.idr'),
      typeOf('greeting', 6, 0),
      typeOf('greeting', 7, 0),
      typeOf('shout', 7, 11),
      nameAt('shout'),
      nameAt('greeting'),
      docsFor('shout'),
      docsFor('greeting'),
      browse('Foo.A'),
      completions('sh'),
      completions('gr'),
      // Definition opens Foo/A.idr, which the checks then load in the same session (its TTC is
      // fresh: no Building line, F7).
      load('src/Foo/A.idr'),
      typeOf('shout', 4, 0),
      typeOf('s', 5, 6),
      typeOf('s', 5, 10),
    ],
  },
  {
    name: 'clean-queries',
    description: 'Clean.idr (imports Data.Vect): positional :type-of of every :bound token; :repl-completions of vl, vlen, Data.V, ?, vlen_ and the empty prefix; :name-at of a name of this file and of the installed packages (Data.Vect.index, Prelude.id, Vect, ::); :browse-namespace of Data.Vect, of the file\'s own namespace and of an unknown one; :docs-for a type, a constructor, a name without docs; :type-of by name of a local and of an overloaded name; positional :type-of of a type and of a hole',
    facts: ['F2', 'F3', 'F31'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Clean.idr'],
    requests: [
      load('Clean.idr'),
      // Every :bound token of the load's highlighting, at its start (what the inlay hints ask).
      ...[
        ['n', 5, 14], ['a', 5, 16], ['m', 5, 26], ['a', 5, 28], ['n', 5, 39], ['m', 5, 43], ['a', 5, 46],
        ['n', 7, 12], ['a', 7, 14], ['xs', 8, 5],
      ].map(([name, line, column]) => typeOf(name, line, column)),
      completions('vl'),
      completions('vlen'),
      completions('Data.V'),
      completions('?'),
      completions('vlen_'),
      completions(''),
      nameAt('vlen'),
      nameAt('index'),
      nameAt('id'),
      nameAt('Vect'),
      nameAt('::'),
      browse('Data.Vect'),
      browse('Clean'),
      browse('Nope.Nothing'),
      docsFor('Vect'),
      docsFor('::'),
      docsFor('vlen'),
      typeOf('xs'),
      typeOf('index'),
      typeOf('Vect', 7, 7),
      typeOf('vlen_rhs', 8, 11),
    ],
  },
  {
    name: 'unicode-columns',
    description: 'E14: Unicode.idr, whose lines 12, 15, 18 and 21 have characters of 2, 3 and 4 UTF-8 bytes (4 bytes are 2 UTF-16 units) and a combining mark before a pattern variable: its highlighting, and a positional :type-of at every column from 0 to one past the line\'s UTF-8 length; non-ASCII names in requests (decimal escapes) and replies',
    facts: ['F1', 'F2'],
    workspace: 'broken',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Unicode.idr'],
    requests: [
      load('Unicode.idr'),
      ...typeOfSweep('y', 12, 0, 21),
      ...typeOfSweep('s', 15, 0, 27),
      ...typeOfSweep('t', 18, 0, 25),
      ...typeOfSweep('m', 21, 0, 30),
      typeOf('x₁', 12, 2),
      typeOf('x₁', 12, 9),
      typeOf('ℕ', 9, 0),
      typeOf('α'),
      nameAt('α'),
      nameAt('commented'),
      docsFor('ℕ'),
      completions('α'),
    ],
  },
  {
    name: 'lit-lookups',
    description: 'Lit.lidr (bird tracks): positional :type-of of the global double, of an operator and of every :bound token at unlit columns, :name-at (the columns of its reply), :docs-for, :browse-namespace; below the lines `> ` (file line 6, 0-based) and `>   ` (file line 9), each two lines of the unlit text, the compiler\'s lines are the file lines plus 1 and 2 (F11 addendum): :type-of and :name-at of glue and bump there, and of an operator directly after a local (`xs++ys`, `n+1`) at its start, where the local answers, and one column further',
    facts: ['F11'],
    workspace: 'loose-file',
    cwd: '.',
    transport: 'stdio',
    fixtures: ['Lit.lidr'],
    requests: [
      load('Lit.lidr'),
      typeOf('double', 5, 0),
      typeOf('double', 6, 0),
      typeOf('+', 6, 13),
      typeOf('n', 6, 7),
      typeOf('n', 6, 11),
      typeOf('n', 6, 15),
      nameAt('double'),
      docsFor('double'),
      browse('Lit'),
      typeOf('glue', 9, 0),
      docsFor('glue'),
      typeOf('xs', 10, 5),
      typeOf('ys', 10, 8),
      typeOf('++', 10, 15),
      typeOf('++', 10, 16),
      typeOf('++'),
      docsFor('++'),
      typeOf('bump', 13, 0),
      typeOf('n', 14, 5),
      typeOf('+', 14, 10),
      typeOf('+', 14, 11),
      nameAt('glue'),
      nameAt('bump'),
    ],
  },
  {
    name: 'eval-values',
    description: 'The eval session (--build-dir …/.vscode-idris2-eval) after it loaded Clean.idr: :interpret of a Vect, a String, function values, putStrLn "hi" (no HasIO implementation is chosen: an error) and the same action at type IO () (normalised, not run: nothing is printed), an expression stuck on a hole, an ill-typed expression, an undefined name, and the REPL command :t id (the REPL parser reads commands in :interpret)',
    facts: ['F5', 'F15', 'F27'],
    workspace: 'broken',
    cwd: '.',
    buildDir: '.vscode-idris2-eval',
    transport: 'stdio',
    fixtures: ['Clean.idr'],
    requests: [
      load('Clean.idr'),
      interpret('the (Vect 2 Nat) [1, 2]'),
      interpret('the (Vect 2 Nat) [1,2]'),
      interpret('"hi" ++ "!"'),
      interpret('vlen'),
      interpret('the (Nat -> Nat) (\\x => x + 1)'),
      interpret('putStrLn "hi"'),
      interpret('the (IO ()) (putStrLn "hi")'),
      interpret('vlen [1, 2]'),
      interpret('the Nat "x"'),
      interpret('nope'),
      interpret(':t id'),
    ],
  },
  {
    name: 'eval-command-forms',
    description: 'The eval session after it loaded Clean.idr: :interpret of the harmless command :t id behind whitespace (space, tab, CR, LF, VT, FF, NBSP, U+3000, U+200B, U+FEFF), comments and a doc comment, with a space after the colon, with a fullwidth colon and in upper case; the empty and blank input and a lone comment',
    facts: ['F1'],
    workspace: 'broken',
    cwd: '.',
    buildDir: '.vscode-idris2-eval',
    transport: 'stdio',
    fixtures: ['Clean.idr'],
    requests: [
      load('Clean.idr'),
      // Space, tab, CR, LF, VT, FF, then NBSP, the ideographic space, the zero-width space and the BOM.
      ...[' ', '\t', '\r', '\n', '\v', '\f', '\u00a0', '\u3000', '\u200b', '\ufeff']
        .map((space) => interpret(`${space}:t id`)),
      interpret('{- c -} :t id'),
      interpret('-- c\n:t id'),
      interpret('||| d\n:t id'),
      interpret(': t id'),
      interpret('\uff1at id'),
      interpret(':T id'),
      interpret(''),
      interpret('   '),
      interpret('-- c'),
    ],
  },
  {
    name: 'eval-socket',
    description: 'The eval session over --ide-mode-socket (the user\'s opt-in, ROADMAP §9 Q20): :interpret of an IO () action prints nothing, neither in the socket stream nor on the process stdout',
    facts: ['F5'],
    workspace: 'broken',
    cwd: '.',
    buildDir: '.vscode-idris2-eval',
    transport: 'socket',
    fixtures: ['Clean.idr'],
    requests: [load('Clean.idr'), interpret('the (IO ()) (putStrLn "hi")')],
  },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The compiler to run: IDRIS2 (must be absolute), else the first `idris2` on PATH. */
function findCompiler() {
  const configured = process.env.IDRIS2;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`IDRIS2 must be an absolute path, got ${configured}`);
    }
    return configured;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) {
      continue;
    }
    const candidate = path.join(dir, 'idris2');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  throw new Error('no idris2 on PATH; set IDRIS2=<absolute path>');
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

/** Number of bytes of the UTF-8 sequence that starts with `lead` (1 for a stray byte). */
function utf8SequenceLength(lead) {
  if (lead < 0x80) {
    return 1;
  }
  if (lead >= 0xc0 && lead < 0xe0) {
    return 2;
  }
  if (lead >= 0xe0 && lead < 0xf0) {
    return 3;
  }
  if (lead >= 0xf0 && lead < 0xf8) {
    return 4;
  }
  return 1;
}

/** `{ text }` when the bytes are valid UTF-8, else `{ base64 }`. */
function bytesField(bytes) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { base64: Buffer.from(bytes).toString('base64') };
  }
}

/**
 * Cuts the compiler's protocol stream into items, as the extension must: a frame starts with a
 * reply header — six hex digits giving the payload's length in **code points** (the reply rule of
 * F1's addendum), `(` and the head of a reply (`(:return `, …: the constructors of `Reply`,
 * `Protocol/IDE.idr`) — and anything else is unframed text up to and including the next `\n` (F5:
 * program output and the end-of-input line over stdio), or up to a reply header after it: output
 * without a final newline is followed at once by the next reply (`:exec putStr "hi"` writes `hi`
 * and the `:return` right after it, `exec-stdio-putstr`; `:exec putStr "7"` writes `7000015(…`,
 * `exec-stdio-putstr-digit`). At the end of the stream an incomplete rest is one unframed item.
 * Only six-digit headers are read (the extension's decoder also reads seven and eight, for replies
 * of 0x1000000 code points or more, which no scenario produces).
 */
const REPLY_HEADER = /[0-9a-f]{6}\(:(?:return|output|write-string|warning|set-prompt|protocol-version) /;

class ProtocolReader {
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
      const cut = this.next();
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

  /** The item at the start of the buffer and its byte length, or undefined if incomplete. */
  next() {
    const header = REPLY_HEADER.exec(this.buffer.toString('latin1'));
    if (header !== null && header.index === 0) {
      const prefix = this.buffer.subarray(0, 6).toString('latin1');
      const codePoints = parseInt(prefix, 16);
      let end = 6;
      for (let k = 0; k < codePoints; k++) {
        if (end >= this.buffer.length) {
          return undefined;
        }
        end += utf8SequenceLength(this.buffer[end]);
      }
      if (end > this.buffer.length) {
        return undefined;
      }
      return { item: { kind: 'recv', prefix, ...bytesField(this.buffer.subarray(6, end)) }, length: end };
    }
    const newline = this.buffer.indexOf(0x0a);
    const at = header === null ? -1 : header.index;
    if (at > 0 && (newline < 0 || at < newline)) {
      return { item: { kind: 'unframed', ...bytesField(this.buffer.subarray(0, at)) }, length: at };
    }
    if (newline < 0) {
      return undefined;
    }
    return { item: { kind: 'unframed', ...bytesField(this.buffer.subarray(0, newline + 1)) }, length: newline + 1 };
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

// ---------------------------------------------------------------------------------------------
// Recording one scenario
// ---------------------------------------------------------------------------------------------

async function record(scenario, compiler, tmpBase) {
  const workspace = path.join(WORKSPACES, scenario.workspace);
  // The copy lives at <tmp>/<scenario name, padded>/<workspace>/<cwd>, padded so that the root
  // has ROOT_LENGTH characters: the recorded request prefixes, which count the root's bytes,
  // then do not depend on the machine's temporary directory.
  const base = fs.realpathSync(tmpBase);
  const rest = path.join(scenario.workspace, scenario.cwd);
  const padded = ROOT_LENGTH - base.length - rest.length - 2;
  if (padded < scenario.name.length + 1) {
    throw new Error(`the temporary directory ${base} is too long for a ${ROOT_LENGTH}-character root; set TMPDIR to a shorter one`);
  }
  const holder = path.join(base, `${scenario.name}-`.padEnd(padded, 'x'));
  fs.mkdirSync(holder);
  const copy = path.join(holder, scenario.workspace);
  fs.cpSync(workspace, copy, { recursive: true, filter: (src) => path.basename(src) !== 'build' });
  const root = fs.realpathSync(path.join(copy, scenario.cwd));
  if (root.length !== ROOT_LENGTH || !/^[\x21-\x7e]+$/.test(root) || root.includes('"') || root.includes('\\')) {
    throw new Error(`the temporary root ${root} must be ${ROOT_LENGTH} printable ASCII characters without quotes or backslashes`);
  }
  // Placeholder → the path it stands for. `${LINK}` is a symbolic link to the root, for the
  // scenarios that start the session through one (`link: true`). Only these exact spellings are
  // replaced; any other spelling of the temporary directory (such as /tmp for /private/tmp on
  // macOS) is reported as a leak below instead of being merged into a placeholder.
  const placeholders = new Map([[ROOT, root]]);
  if (scenario.link) {
    const link = path.join(holder, 'link');
    fs.symlinkSync(root, link);
    placeholders.set(LINK, link);
  }
  const substitute = (text, lengthOnly = false) =>
    [...placeholders].reduce((t, [name, p]) => t.split(name).join(lengthOnly ? 'r'.repeat(p.length) : p), text);
  const anonymise = (text) =>
    [...placeholders].sort((a, b) => b[1].length - a[1].length).reduce((t, [name, p]) => t.split(p).join(name), text);
  const leaks = [holder, tmpBase, base, repo, os.homedir()];

  const fixtures = {};
  for (const file of scenario.fixtures) {
    fixtures[file] = sha256(path.join(workspace, scenario.cwd, file));
  }
  const modeFlag = scenario.transport === 'socket' ? '--ide-mode-socket' : '--ide-mode';
  // The working directory as the extension passes it (ProjectIndex.sessionCwd), and its
  // --build-dir <sessionCwd>/build/.vscode-idris2 (D5, F12), or the eval session's.
  const processCwd = scenario.link ? LINK : ROOT;
  const args = [modeFlag, '--no-color', '--build-dir', `${processCwd}/build/${scenario.buildDir ?? '.vscode-idris2'}`];

  const events = [];
  const waiters = [];
  let placeholderClash;
  const push = (event) => {
    if (event.text?.includes('${') && event.text !== `${PORT}\n`) {
      placeholderClash ??= event.text;
    }
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.test(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  };
  const waitFor = (test, ms, what) => new Promise((resolve, reject) => {
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

  const before = snapshot(copy);
  const child = spawn(compiler, args.map((a) => substitute(a)), {
    cwd: substitute(processCwd),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const processTimer = setTimeout(() => killGroup(child), PROCESS_LIMIT_MS);
  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  child.on('error', (error) => push({ kind: 'spawn-error', text: error.message }));

  const stderr = new LineReader('stderr', push);
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stderr.on('end', () => stderr.end());

  let write;
  let closeInput;
  if (scenario.transport === 'stdio') {
    const protocol = new ProtocolReader(push);
    child.stdout.on('data', (chunk) => protocol.push(chunk));
    child.stdout.on('end', () => protocol.end());
    write = (bytes) => child.stdin.write(bytes);
    closeInput = () => child.stdin.end();
  } else {
    // --ide-mode-socket: the first stdout line is the port (recorded as ${PORT}); everything
    // after it is process output (F5).
    let portLine;
    const stdout = new LineReader('stdout', (item) => {
      if (portLine === undefined) {
        portLine = item.text;
        if (!/^\d+\n$/.test(portLine ?? '')) {
          push({ kind: 'stdout', ...item });
          return;
        }
        push({ kind: 'stdout', text: `${PORT}\n` });
        const socket = net.connect(Number(portLine), '127.0.0.1');
        const protocol = new ProtocolReader(push);
        socket.on('data', (chunk) => protocol.push(chunk));
        socket.on('end', () => {
          protocol.end();
          push({ kind: 'socket-end' });
        });
        socket.on('error', (error) => push({ kind: 'socket-error', text: error.message }));
        write = (bytes) => socket.write(bytes);
        closeInput = () => socket.end();
        return;
      }
      push(item);
    });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stdout.on('end', () => stdout.end());
  }

  let failure;
  try {
    await waitFor((e) => e.kind === 'recv' && e.text?.startsWith('(:protocol-version '), REQUEST_LIMIT_MS, 'handshake');
    let id = 0;
    for (const request of scenario.requests) {
      id++;
      const command = typeof request === 'string' ? `(${request} ${id})` : request.raw.split('${ID}').join(String(id));
      const text = `${substitute(command)}\n`;
      const body = Buffer.from(text, 'utf8');
      const prefix = body.length.toString(16).padStart(6, '0');
      push({ kind: 'send', prefix, text });
      write(Buffer.concat([Buffer.from(prefix, 'latin1'), body]));
      await waitFor((e) => e.kind === 'recv' && e.text?.startsWith('(:return '), REQUEST_LIMIT_MS, `:return for request ${id}`);
    }
    push({ kind: 'close' });
    closeInput();
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
    throw failure;
  }
  if (placeholderClash !== undefined) {
    throw new Error(`${scenario.name}: a text contains \`\${\`, which the placeholders use: ${placeholderClash}`);
  }

  const after = snapshot(copy);
  const written = [...after.keys()]
    .filter((p) => before.get(p) !== after.get(p))
    .map((p) => toPosix(path.relative(root, p)))
    .sort();
  push({ kind: 'files', written });

  const version = /version (\S+)/.exec(versionText(compiler))[1];
  const meta = {
    kind: 'meta',
    format: FORMAT,
    scenario: scenario.name,
    description: scenario.description,
    facts: scenario.facts,
    idris2: { version, versionText: versionText(compiler), executable: homeRelative(compiler) },
    platform: `${process.platform} ${process.arch}`,
    recorded: localDate(),
    transport: scenario.transport,
    args,
    cwd: toPosix(path.relative(repo, path.join(workspace, scenario.cwd))) || '.',
    processCwd,
    placeholders: Object.fromEntries([...placeholders].map(([name, p]) => [name, p.length])),
    fixtures,
  };
  const lines = [meta, ...events].map((event) => {
    const out = { ...event };
    for (const key of ['text', 'written']) {
      if (typeof out[key] === 'string') {
        out[key] = anonymise(out[key]);
      } else if (Array.isArray(out[key])) {
        out[key] = out[key].map(anonymise);
      }
    }
    if ((out.kind === 'send' || out.kind === 'recv') && out.text !== undefined) {
      // The prefix counts the text as sent: UTF-8 bytes of a request (F1), code points of a
      // reply (F1 addendum), with ASCII paths of the recorded lengths where placeholders stand.
      const sent = substitute(out.text, true);
      const length = out.kind === 'send' ? Buffer.byteLength(sent, 'utf8') : [...sent].length;
      if (parseInt(out.prefix, 16) !== length) {
        throw new Error(`${scenario.name}: prefix ${out.prefix} is not the ${out.kind === 'send' ? 'byte' : 'code-point'} length ${length} of ${JSON.stringify(out.text)}`);
      }
    }
    const line = JSON.stringify(out);
    for (const leak of leaks) {
      if (line.includes(leak)) {
        throw new Error(`${scenario.name}: the transcript would contain the local path ${leak}: ${line}`);
      }
    }
    return line;
  });
  // A process of the group that outlived the launcher (none has been seen) must not survive.
  killGroup(child);
  return { version, lines, events };
}

let cachedVersion;
function versionText(compiler) {
  if (cachedVersion === undefined) {
    const r = spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) {
      throw new Error(`${compiler} --version failed: ${r.stderr}`);
    }
    cachedVersion = r.stdout.trim();
  }
  return cachedVersion;
}

/** One line of the summary: the frames and their :return kinds. */
function summary(events) {
  const count = (kind) => events.filter((e) => e.kind === kind).length;
  const returns = events.filter((e) => e.kind === 'recv' && e.text?.startsWith('(:return ')).map((e) => (e.text.startsWith('(:return (:ok') ? 'ok' : 'error'));
  const warnings = events.filter((e) => e.kind === 'recv' && e.text?.startsWith('(:warning ')).length;
  const exit = events.find((e) => e.kind === 'exit');
  return `${count('send')} requests, ${count('recv')} frames (${warnings} :warning), returns ${returns.join(',')}, ${count('unframed')} unframed, exit ${exit?.code ?? exit?.signal}`;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(argv) {
  if (process.platform === 'win32') {
    throw new Error('record-transcripts.mjs needs POSIX process groups; record on macOS or Linux');
  }
  const names = [];
  let outBase = path.join(repo, 'test', 'fixtures', 'transcripts');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') {
      for (const s of SCENARIOS) {
        console.log(`${s.name.padEnd(26)} ${s.description}`);
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
  const compiler = findCompiler();
  console.log(`Using ${compiler}: ${versionText(compiler)}`);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-rec-'));
  const written = new Set();
  let failures = 0;
  let outDir;
  try {
    for (const scenario of selected) {
      try {
        const { version, lines, events } = await record(scenario, compiler, tmpBase);
        outDir = path.join(outBase, version);
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, `${scenario.name}.jsonl`);
        fs.writeFileSync(file, `${lines.join('\n')}\n`);
        written.add(path.basename(file));
        console.log(`ok    ${scenario.name}: ${summary(events)}`);
      } catch (error) {
        failures++;
        console.log(`FAIL  ${scenario.name}: ${error.message}`);
      }
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
  if (names.length === 0 && failures === 0 && outDir !== undefined) {
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
