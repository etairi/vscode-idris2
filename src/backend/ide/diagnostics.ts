/**
 * The reply of a `:load-file` → diagnostic records (`backend/ide/diagnostics.ts`,
 * docs/ARCHITECTURE.md §8, decision D9; ROADMAP M2). No `vscode` import: `backend.ts` turns the
 * records into `vscode.Diagnostic`s, and the unit tests feed it replies decoded from the recorded
 * transcripts (test/fixtures/transcripts/0.8.0).
 *
 * What a load sends [live, the 0.8.0 transcripts]: `(:write-string "N/M: Building <Mod> (<path>)")`
 * for each module it builds, one `(:warning (FILE (L C) (L C) MESSAGE HL))` per problem, and a
 * `:return` that is `(:ok ())` or `(:error MESSAGE)`. From that:
 *
 * - **Files.** FILE is relative to the compiler's working directory (F6): `emitProblem` asks
 *   `nsToSource` for "the file name relative to the working directory", and a package-file
 *   origin is the `.ipkg` name as `findIpkg` found it (`src/Idris/REPL/Common.idr` 104–133 on
 *   v0.8.0 [src]). Names are resolved against the session directory as the project index spells
 *   it, so they come out as the editor spells the files; a name that is the path sent in the
 *   `:load-file` is the loaded document. The compiler's two placeholders `(File-Not-Found)` and
 *   `(Interactive)` name no file: such a frame is attached to the loaded document at its start,
 *   with its whole text (the location line in it is the only place the file is named).
 * - **Ranges.** 0-based, end exclusive, unlit columns in bird-track files (F2, F11), converted by
 *   `core/positions.ts` with the text the compiler read (`LoadContext.documentFor`).
 * - **Messages.** The text without its location blocks: a location line `<origin>:L:C--L:C` after
 *   a blank line, and the source excerpt under it (numbered lines, `|` rows and caret lines;
 *   `ploc`/`ploc2`, `src/Idris/Error.idr` 170–240 on v0.8.0 [src]). Everything else is kept,
 *   which is ARCHITECTURE §8's "text before the location line plus any `Missing cases:` block"
 *   and also the text some errors print after the excerpt (`main is not covering.` …
 *   `Calls non covering function Part.g` [live, load-part]). With
 *   `idris2.diagnostics.includeSourceExcerpt` the text is kept whole.
 * - **Severity** (F7, D9). After `(:return (:ok …))` every frame is a warning. After
 *   `(:return (:error …))` a frame is an error unless its first line is one of
 *   `KNOWN_WARNINGS`, the compiler's warning texts (E5) — and every frame is an error when the
 *   compiler runs with `-Werror`, which turns warnings into errors with the same text
 *   (`emitWarnings`, `src/Idris/REPL/Common.idr` 150–161; `perrorRaw (WarningAsError w) =
 *   pwarningRaw w`, `src/Idris/Error.idr` 795 [src]): on the session's command line, or in the
 *   `.ipkg`'s `opts`, which the compiler applies at every load (`backend.ts`).
 * - **Package file** (F10). A `(:return (:error MESSAGE))` whose MESSAGE has a location line with
 *   a quoted origin, `"bad.ipkg":3:1--3:5`, is the `.ipkg`'s parse error (`PhysicalPkgSrc` is
 *   printed with `show`; a module origin is printed bare): an error on the `.ipkg` at that range
 *   (1-based, as the CLI text prints it), and `LoadDiagnostics.packageError`.
 * - **Which files a load determines** (F7). A reload whose TTC is fresh sends no `Building`
 *   line and no `:warning` frame, so the diagnostics shown for that file still apply. A load
 *   determines, and so replaces, the diagnostics of: every file named by a `Building` line or a
 *   frame; the root's `.ipkg`, which `findIpkg` reads at every load (F13) and whose deprecation
 *   warning is sent again every time [live, warning-ipkg-deprecated]; and, after a failed load,
 *   the loaded document — a file that fails is built again at every load, since no TTC is
 *   written for it [live, load-switch].
 * - **A failed load always says so on the loaded document.** When the compiler reported no
 *   error there — the load stopped at an imported module (`UsesBad.idr` → `Bad.idr` [live,
 *   load-uses-bad]) or at the `.ipkg`, or failed without any frame — one error at the start of
 *   the document explains why it was not checked, with the errors it refers to as related
 *   information; for imported modules, `LoadDiagnostics.blockedBy` lists them.
 */
import * as path from 'path';
import { fromCliSpan, fromIdeReplySpan, type EditorRange, type PositionDocument } from '../../core/positions';
import { decodeBuildingLine } from './protocol';
import type { Reply, WarningReport } from './types';

export type DiagnosticSeverityName = 'error' | 'warning';

/** A location a diagnostic refers to (`vscode.DiagnosticRelatedInformation`). */
export interface RelatedRecord {
  readonly path: string;
  readonly range: EditorRange;
  readonly message: string;
}

export interface DiagnosticRecord {
  readonly range: EditorRange;
  readonly severity: DiagnosticSeverityName;
  readonly message: string;
  readonly related: readonly RelatedRecord[];
}

export interface LoadDiagnostics {
  /** The compiler accepted the file: the `:return` was not an `:error`. */
  readonly ok: boolean;
  /**
   * The diagnostics of every file this load determined (see the module comment), by absolute
   * path as the editor spells it; an empty list for a file it determined to be clean.
   */
  readonly files: ReadonlyMap<string, readonly DiagnosticRecord[]>;
  /** The load stopped at the `.ipkg` (F10): which one, and the compiler's message. */
  readonly packageError?: { readonly path: string; readonly message: string };
  /**
   * The load failed without an error in the loaded document because of errors in the files it
   * imports: those files (the "Not checked" error's related information).
   */
  readonly blockedBy?: readonly string[];
}

export interface LoadContext {
  /** Absolute path of the loaded document as the editor spells it (`TextDocument.fileName`). */
  readonly loadedPath: string;
  /** The path sent in the `:load-file` (see `backend.ts`); `Building` lines repeat it. */
  readonly sentPath: string;
  /** The session's working directory as the project index spells it (`ProjectIndex.sessionCwd`). */
  readonly cwd: string;
  /** The root's `.ipkg` for a project; `undefined` for a loose file. */
  readonly ipkgPath: string | undefined;
  /** `idris2.diagnostics.includeSourceExcerpt`. */
  readonly includeSourceExcerpt: boolean;
  /** The compiler runs with `-Werror`: on the session's command line or in the `.ipkg`'s `opts`. */
  readonly warningsAsErrors: boolean;
  /**
   * The text the compiler read for `path`, for the literate column offset (F11). Only bird-track
   * files (`compilerLiterateStyleOf`, by file name) need their lines; for every other file the
   * conversion is plain arithmetic.
   */
  documentFor(path: string): PositionDocument;
}

// -------------------------------------------------------------------------------------------
// The compiler's warning texts (E5)
// -------------------------------------------------------------------------------------------

export interface KnownWarning {
  /** The constructor of the compiler's `Warning` type (`src/Core/Core.idr` 70–88 on v0.8.0). */
  readonly constructor: string;
  /** Matches the first line of the message as `pwarningRaw` prints it. */
  readonly firstLine: RegExp;
}

/**
 * The first lines of the compiler's warnings, from `pwarningRaw` (`src/Idris/Error.idr` 258–301
 * on v0.8.0) and the places that raise them [src], each observed as a `:warning` frame followed
 * by `(:return (:ok ()))` [live, 2026-09-27, the `warning-*` and `load-warn` transcripts] unless
 * marked [src only]:
 *
 * - `ParserWarning`: every parser warning of 0.8.0 starts with `DEPRECATED: ` (`withWarning` in
 *   `src/Idris/Parser.idr` 648, 905–909, 1162–1166, 1875): `"%nomangle"`, trailing lambda, old
 *   parameter syntax, old record update syntax [live: all four].
 * - `UnreachableClause`: `Unreachable clause: <lhs>`.
 * - `ShadowingGlobalDefs`, `ShadowingLocalBindings`: fixed first lines.
 * - `IncompatibleVisibility`: `<name> has been forward-declared with <v> visibility, cannot change
 *   to <v>. This will be an error in a later release.` — one line, `reflow` did not break it.
 * - `Deprecated`: `Deprecation warning: …`, from `%deprecate` [live] and from the `.ipkg`'s
 *   version (`src/Idris/Package.idr` 234) [live].
 * - `GenericWarn` has free text. Its fixed texts with a location in 0.8.0: the fixity without an
 *   export modifier (`src/Idris/Desugar.idr` 1321) [live], `%unhide` of a name that was not
 *   hidden (`src/Core/Context.idr` 2669) [live], and an ambiguous operator fixity
 *   (`src/Idris/Desugar.idr` 168) [src only]. The text of `%runElab`'s `warn` is the user's own and
 *   cannot be recognised: after a failed load it is shown as an error. The `GenericWarn`s without
 *   a location (a TTC mismatch, no incremental data, compiling a hole) arrive as `:write-string`,
 *   not as frames (`emitProblem`: no FC → `iputStrLn`) [src].
 */
export const KNOWN_WARNINGS: readonly KnownWarning[] = [
  { constructor: 'ParserWarning', firstLine: /^DEPRECATED: / },
  { constructor: 'UnreachableClause', firstLine: /^Unreachable clause: / },
  { constructor: 'ShadowingGlobalDefs', firstLine: /^We are about to implicitly bind the following lowercase names\.$/ },
  {
    constructor: 'IncompatibleVisibility',
    firstLine: / has been forward-declared with .+ visibility, cannot change to .+\. This will be an error in a later release\.$/,
  },
  { constructor: 'ShadowingLocalBindings', firstLine: /^You may be unintentionally shadowing the following local bindings:$/ },
  { constructor: 'Deprecated', firstLine: /^Deprecation warning: / },
  { constructor: 'GenericWarn', firstLine: /^Fixity declaration '.+' does not have an export modifier, and$/ },
  { constructor: 'GenericWarn', firstLine: /^Trying to %unhide `.+`, which was not hidden in the first place$/ },
  { constructor: 'GenericWarn', firstLine: /^operator fixity is ambiguous, we are picking .+ out of :$/ },
];

/** The constructor of the known warning whose first line `message` starts with, if any. */
export function knownWarning(message: string): string | undefined {
  const firstLine = message.split('\n', 1)[0];
  return KNOWN_WARNINGS.find((w) => w.firstLine.test(firstLine))?.constructor;
}

// -------------------------------------------------------------------------------------------
// Message text
// -------------------------------------------------------------------------------------------

/** `ploc`'s head: `Bad:4:7--4:12`, `"bad.ipkg":3:1--3:5`, `(Interactive):1:1--1:4`. */
const LOCATION_LINE = /^\S.*:\d+:\d+--\d+:\d+$/;
/** A line of `ploc`'s excerpt: ` 4 | f x = x + 1`, ` 06 | `, `   |`, `   | ^^^`, `     ^^^`. */
const EXCERPT_LINE = /^ *\d* *\||^ +\^[ ^]*$/;

/**
 * `text` without its location blocks — a location line after a blank line (or at the start),
 * the blank line before it and the excerpt lines under it — and without trailing white space;
 * runs of blank lines left behind are collapsed to one. With `keepExcerpt`, only the trailing
 * white space is removed.
 */
export function messageText(text: string, keepExcerpt: boolean): string {
  if (keepExcerpt) {
    return text.trimEnd();
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (LOCATION_LINE.test(lines[i]) && (i === 0 || lines[i - 1].trim() === '')) {
      if (kept.length > 0 && kept[kept.length - 1].trim() === '') {
        kept.pop();
      }
      while (i + 1 < lines.length && EXCERPT_LINE.test(lines[i + 1])) {
        i++;
      }
      continue;
    }
    kept.push(lines[i]);
  }
  return kept
    .join('\n')
    .replace(/\n\s*\n(\s*\n)+/g, '\n\n')
    .replace(/^\s*\n/, '')
    .trimEnd();
}

/** The first line of a message, for related information and summaries. */
function firstLine(message: string): string {
  return message.split('\n', 1)[0];
}

// -------------------------------------------------------------------------------------------
// Files
// -------------------------------------------------------------------------------------------

/** The compiler's names for "no file" in a warning's FILE (`emitProblem`). */
const NO_FILE = new Set(['(File-Not-Found)', '(Interactive)']);

/** Whether `a` and `b` name the same path (`path.relative` compares case-insensitively on Windows). */
function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

/** A file name as the compiler printed it → an absolute path as the editor spells it. */
function resolveFile(name: string, ctx: LoadContext): string {
  const resolved = path.resolve(ctx.cwd, name);
  return samePath(resolved, path.resolve(ctx.cwd, ctx.sentPath)) || samePath(resolved, ctx.loadedPath)
    ? ctx.loadedPath
    : resolved;
}

/** The location line of a package-file origin: `"bad.ipkg":3:1--3:5` (F10). */
const PACKAGE_LOCATION = /^"((?:[^"\\]|\\.)*)":(\d+):(\d+)--(\d+):(\d+)$/m;

interface PackageFileError {
  readonly path: string;
  readonly range: EditorRange;
  readonly message: string;
}

/** The `.ipkg` error a failed load's MESSAGE reports, if it reports one. */
function packageFileError(message: string, ctx: LoadContext): PackageFileError | undefined {
  const match = PACKAGE_LOCATION.exec(message);
  if (match === null) {
    return undefined;
  }
  // `show` escapes `\` and `"`; a file name found by `listDir` rarely has either.
  const name = match[1].replace(/\\(.)/g, '$1');
  const file = ctx.ipkgPath !== undefined && path.basename(ctx.ipkgPath) === name ? ctx.ipkgPath : path.resolve(ctx.cwd, name);
  const [startLine, startColumn, endLine, endColumn] = match.slice(2).map(Number);
  return {
    path: file,
    range: fromCliSpan(ctx.documentFor(file), {
      start: { line: startLine, column: startColumn },
      end: { line: endLine, column: endColumn },
    }),
    message: messageText(message, ctx.includeSourceExcerpt),
  };
}

// -------------------------------------------------------------------------------------------
// The mapping
// -------------------------------------------------------------------------------------------

const DOCUMENT_START: EditorRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function severityOf(warning: WarningReport, failed: boolean, ctx: LoadContext): DiagnosticSeverityName {
  if (!failed) {
    return 'warning';
  }
  return !ctx.warningsAsErrors && knownWarning(warning.message) !== undefined ? 'warning' : 'error';
}

/** The diagnostics of one `:load-file` reply (see the module comment). */
export function loadDiagnostics(reply: Reply, ctx: LoadContext): LoadDiagnostics {
  const failed = reply.payload.kind === 'error';
  const files = new Map<string, DiagnosticRecord[]>();
  const determined = (file: string): DiagnosticRecord[] => {
    let list = files.get(file);
    if (list === undefined) {
      list = [];
      files.set(file, list);
    }
    return list;
  };
  if (ctx.ipkgPath !== undefined) {
    determined(ctx.ipkgPath);
  }
  if (failed) {
    determined(ctx.loadedPath);
  }

  const otherErrors: RelatedRecord[] = [];
  for (const message of reply.messages) {
    if (message.kind === 'write-string') {
      const built = decodeBuildingLine(message.text);
      if (built !== undefined) {
        determined(resolveFile(built.file, ctx));
      }
      continue;
    }
    if (message.kind !== 'warning') {
      continue;
    }
    const warning = message.warning;
    const severity = severityOf(warning, failed, ctx);
    if (NO_FILE.has(warning.file)) {
      determined(ctx.loadedPath).push({ range: DOCUMENT_START, severity, message: messageText(warning.message, true), related: [] });
      continue;
    }
    const file = resolveFile(warning.file, ctx);
    const record: DiagnosticRecord = {
      range: fromIdeReplySpan(ctx.documentFor(file), warning.span),
      severity,
      message: messageText(warning.message, ctx.includeSourceExcerpt),
      related: [],
    };
    determined(file).push(record);
    if (severity === 'error' && file !== ctx.loadedPath) {
      otherErrors.push({ path: file, range: record.range, message: firstLine(record.message) });
    }
  }

  let packageError: LoadDiagnostics['packageError'];
  let blockedBy: string[] | undefined;
  if (reply.payload.kind === 'error') {
    const errorMessage = reply.payload.message;
    const pkg = packageFileError(errorMessage, ctx);
    if (pkg !== undefined) {
      determined(pkg.path).push({ range: pkg.range, severity: 'error', message: pkg.message, related: [] });
      packageError = { path: pkg.path, message: pkg.message };
    }
    const own = determined(ctx.loadedPath);
    if (!own.some((d) => d.severity === 'error')) {
      own.push(notChecked(errorMessage, pkg, otherErrors, ctx));
      if (pkg === undefined && otherErrors.length > 0) {
        blockedBy = [...new Set(otherErrors.map((e) => e.path))];
      }
    }
  }
  return {
    ok: !failed,
    files,
    ...(packageError === undefined ? {} : { packageError }),
    ...(blockedBy === undefined ? {} : { blockedBy }),
  };
}

/** The error on a loaded document that failed without an error of its own. */
function notChecked(
  errorMessage: string,
  pkg: PackageFileError | undefined,
  otherErrors: readonly RelatedRecord[],
  ctx: LoadContext,
): DiagnosticRecord {
  if (pkg !== undefined) {
    return {
      range: DOCUMENT_START,
      severity: 'error',
      message: `Not checked: the package file ${path.basename(pkg.path)} could not be read.`,
      related: [{ path: pkg.path, range: pkg.range, message: firstLine(pkg.message) }],
    };
  }
  if (otherErrors.length > 0) {
    const names = [...new Set(otherErrors.map((e) => path.relative(ctx.cwd, e.path)))];
    return {
      range: DOCUMENT_START,
      severity: 'error',
      message: `Not checked: the compiler reported errors in ${names.join(', ')}.`,
      related: otherErrors,
    };
  }
  return { range: DOCUMENT_START, severity: 'error', message: messageText(errorMessage, ctx.includeSourceExcerpt), related: [] };
}
