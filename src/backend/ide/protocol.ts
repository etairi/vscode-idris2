/**
 * The IDE protocol's messages (`backend/ide/protocol.ts`, docs/ARCHITECTURE.md §2): `ideCodec`
 * for the session layer (`types.ts` `IdeCodec`), request builders, and decoders of the replies.
 * Every reply shape here was recorded from Idris 2 0.8.0 (`test/fixtures/transcripts/0.8.0`,
 * pinned by `test/unit/protocolTranscripts.test.ts`) unless its comment says `[src]`; the source
 * references are to v0.8.0, whose protocol modules are identical on master 1c630e6 apart from
 * imports.
 *
 * **Coordinates.** The builders take request positions exactly as `core/positions.ts` computes
 * them (`toIdeTypeOfRequest`, `toIdeCaseSplitRequest`, `toIdeLineRequest`: 1-based lines, the
 * column base of each command), and the decoders return reply positions as sent (0-based,
 * end-exclusive, unlit columns in bird-track files; `IdeReplySpan`); `core/positions.ts`
 * converts them (ARCHITECTURE §7). Nothing here adds or subtracts 1.
 *
 * **Results.** A command answers `(:return (:ok RESULT [HL]) ID)` or `(:return (:error MESSAGE
 * [HL]) ID)`; each `decode…` function takes that `ReplyPayload` and returns a `CommandResult`:
 * the typed result, or the compiler's error, which is an answer, not a failure. A payload of
 * another shape throws an `IdrisException` of kind `ProtocolError`.
 */
import { IdrisException } from '../../core/errors';
import type { IdeReplyPoint, IdeReplySpan, IdeRequestPoint } from '../../core/positions';
import type { Multiplicity } from '../types';
import { int, list, parseSexp, serializeSexp, SexpSyntaxError, str, sym } from './sexp';
import type {
  DecodedMessage,
  HighlightSpan,
  IdeCodec,
  IdeCommand,
  IdeMessage,
  OutgoingFrame,
  ReplyPayload,
  Sexp,
} from './types';
import { createFrameDecoder, encodeFrame } from './wire';

// -------------------------------------------------------------------------------------------
// The codec
// -------------------------------------------------------------------------------------------

/**
 * `(COMMAND ID)` serialized (`sexp.ts`: printable ASCII, non-ASCII text as escapes) and framed
 * (`wire.ts`). A `RawCommand`'s text is put in verbatim, and its non-ASCII characters are sent as
 * UTF-8, which the compiler reads as Latin-1 (F1 addendum). Throws a `RangeError` for a command
 * `serializeSexp` refuses and for a request above `MAX_REQUEST_BYTES`.
 */
function encodeRequest(command: IdeCommand, id: bigint): OutgoingFrame {
  return encodeFrame(command.kind === 'raw'
    ? `(${command.text} ${serializeSexp(int(id))})`
    : serializeSexp(list(command, int(id))));
}

function decodeMessage(text: string): DecodedMessage {
  let sexp: Sexp;
  try {
    sexp = parseSexp(text);
  } catch (e) {
    if (e instanceof SexpSyntaxError) {
      return { kind: 'invalid', reason: e.message };
    }
    throw e;
  }
  const message = toMessage(sexp);
  if (message !== undefined) {
    return { kind: 'message', message };
  }
  const returnId = unreadableReturnId(sexp);
  const handshake = symbolName(listItems(sexp)?.[0]) === 'protocol-version';
  return { kind: 'unknown', sexp, ...(returnId === undefined ? {} : { returnId }), ...(handshake ? { handshake } : {}) };
}

/**
 * The id of a `:return` whose payload `toMessage` cannot read (a newer compiler's extra field, a
 * highlight span of another shape): a list headed by `:return` that ends in an integer. The reply
 * still ends that request, so the session answers it at once instead of waiting for its time
 * limit (`DecodedMessage`).
 */
function unreadableReturnId(sexp: Sexp): bigint | undefined {
  const items = listItems(sexp);
  return items !== undefined && items.length >= 2 && symbolName(items[0]) === 'return'
    ? integer(items[items.length - 1])
    : undefined;
}

export const ideCodec: IdeCodec = { encodeRequest, createFrameDecoder, decodeMessage };

/**
 * `Reply` (`src/Protocol/IDE.idr`): `(:protocol-version MAJOR MINOR)`, `(:return PAYLOAD ID)`,
 * `(:output PAYLOAD ID)`, `(:write-string TEXT ID)`, `(:set-prompt TEXT ID)` (never recorded; [src]),
 * `(:warning (FILE (L C) (L C) MESSAGE [HL]) ID)`.
 */
function toMessage(sexp: Sexp): IdeMessage | undefined {
  const items = listItems(sexp);
  if (items?.length !== 3) {
    return undefined;
  }
  const [head, first, second] = items;
  switch (symbolName(head)) {
    case 'protocol-version': {
      const major = smallInteger(first);
      const minor = smallInteger(second);
      return major === undefined || minor === undefined ? undefined : { kind: 'protocol-version', major, minor };
    }
    case 'return':
    case 'output': {
      const payload = toPayload(first);
      const id = integer(second);
      return payload === undefined || id === undefined
        ? undefined
        : { kind: symbolName(head) === 'return' ? 'return' : 'output', id, payload };
    }
    case 'write-string':
    case 'set-prompt': {
      const text = string(first);
      const id = integer(second);
      return text === undefined || id === undefined
        ? undefined
        : { kind: symbolName(head) === 'write-string' ? 'write-string' : 'set-prompt', id, text };
    }
    case 'warning': {
      const report = listItems(first);
      const id = integer(second);
      if (report === undefined || id === undefined || (report.length !== 4 && report.length !== 5)) {
        return undefined;
      }
      const file = string(report[0]);
      const start = replyPoint(report[1]);
      const end = replyPoint(report[2]);
      const message = string(report[3]);
      const highlighting = report.length === 5 ? highlightSpans(report[4]) : [];
      return file === undefined || start === undefined || end === undefined || message === undefined
        || highlighting === undefined
        ? undefined
        : { kind: 'warning', id, warning: { file, span: { start, end }, message, highlighting } };
    }
    default:
      return undefined;
  }
}

/**
 * `ReplyPayload`: `(:ok (:highlight-source HLS))`, `(:ok RESULT [HL])`, `(:error MESSAGE [HL])`.
 * The compiler omits an empty `HL`.
 */
function toPayload(sexp: Sexp): ReplyPayload | undefined {
  const items = listItems(sexp);
  if (items === undefined || items.length < 2 || items.length > 3) {
    return undefined;
  }
  const highlighting = items.length === 3 ? highlightSpans(items[2]) : [];
  if (highlighting === undefined) {
    return undefined;
  }
  switch (symbolName(items[0])) {
    case 'ok': {
      const source = listItems(items[1]);
      if (items.length === 2 && source?.length === 2 && symbolName(source[0]) === 'highlight-source') {
        return { kind: 'highlight-source', highlights: source[1] };
      }
      return { kind: 'ok', result: items[1], highlighting };
    }
    case 'error': {
      const message = string(items[1]);
      return message === undefined ? undefined : { kind: 'error', message, highlighting };
    }
    default:
      return undefined;
  }
}

/** `((START LENGTH PROPERTIES) …)`, e.g. `((5 4 ((:decor :type))))` (F30). */
function highlightSpans(sexp: Sexp): HighlightSpan[] | undefined {
  return mapList(sexp, (span) => {
    const parts = listItems(span);
    const start = parts?.length === 3 ? smallInteger(parts[0]) : undefined;
    const length = parts?.length === 3 ? smallInteger(parts[1]) : undefined;
    return parts === undefined || start === undefined || length === undefined
      ? undefined
      : { start, length, properties: parts[2] };
  });
}

// -------------------------------------------------------------------------------------------
// The two protocol facts the session layer applies (F4, F5)
// -------------------------------------------------------------------------------------------

/**
 * Whether an unframed item is the line the compiler prints when its input ends at a request
 * boundary (`getChar`, `src/Idris/IDEMode/REPL.idr` 78–88; F5): over stdio it arrives in the
 * protocol stream, over the socket on the process's stdout. It is also recognised with `\r\n`,
 * which a Windows C runtime in text mode would write (ROADMAP E13 [open]).
 */
export function isEndOfInputLine(text: string): boolean {
  return text === 'Alas the file is done, aborting\n' || text === 'Alas the file is done, aborting\r\n';
}

/**
 * Whether a reply is one of the two errors the compiler sends with the id of the previous
 * recognised request (0 before the first) instead of the request's own: `Parse error: …` and
 * `Unrecognised command: …` (`printIDEError outf idx …` in `loop`, `src/Idris/IDEMode/REPL.idr`
 * 462–496; F4). The session attributes such a return to the request in flight (ARCHITECTURE
 * §5.1).
 */
export function answersWithPreviousId(payload: ReplyPayload): boolean {
  return payload.kind === 'error'
    && (payload.message.startsWith('Parse error:') || payload.message.startsWith('Unrecognised command:'));
}

// -------------------------------------------------------------------------------------------
// Request builders
// -------------------------------------------------------------------------------------------

/**
 * `(:load-file "PATH")`. The session's working directory is the `.ipkg`'s (or the loose file's)
 * directory and the path is absolute (D4, F13). The compiler also takes a line number after the
 * path and drops it (F31), so the builder has none. The compiler compares the path with its
 * working directory as the operating system resolves it: a path through a symbolic link to that
 * directory is refused (`Source file "…" is not in the source directory "<real path>"`, transcript
 * `load-symlink`, a loose file), so `PATH` must start with the directory's real path. Non-ASCII
 * characters arrive intact only because `sexp.ts` escapes them.
 */
export function loadFile(absolutePath: string): Sexp {
  return list(sym('load-file'), str(absolutePath));
}

/**
 * `(:type-of "NAME")`, or with `at` (`toIdeTypeOfRequest`: 1-based line, 0-based column,
 * inclusive end) `(:type-of "NAME" L C)` (F2, F30). Answer: `decodeText`.
 */
export function typeOf(name: string, at?: IdeRequestPoint): Sexp {
  return at === undefined
    ? list(sym('type-of'), str(name))
    : list(sym('type-of'), str(name), int(at.line), int(at.column));
}

/**
 * `(:docs-for "NAME")`. The compiler parses and ignores a mode `:overview`/`:full` (F31), so the
 * builder has none. Answer: `decodeText`.
 */
export function docsFor(name: string): Sexp {
  return list(sym('docs-for'), str(name));
}

/**
 * `(:name-at "NAME")`: the definitions of an unqualified name (a qualified name answers `()`;
 * the form with a line and column is a stub, F2, F3). Answer: `decodeNameAt`.
 */
export function nameAt(name: string): Sexp {
  return list(sym('name-at'), str(name));
}

/**
 * `(:metavariables 80)`: the holes of the loaded file. The compiler requires the integer and
 * ignores it (`process (Metavariables _)`, `src/Idris/IDEMode/REPL.idr` 240 [src]); 80 is what the
 * recordings send. Answer: `decodeMetavariables`.
 */
export function metavariables(): Sexp {
  return list(sym('metavariables'), int(80));
}

/**
 * `(:case-split L C "NAME")` with `at` from `toIdeCaseSplitRequest` (1-based column; 0 means
 * anywhere on the line, F2). Answer: `decodeText`, the replacement lines.
 */
export function caseSplit(at: IdeRequestPoint, name: string): Sexp {
  return list(sym('case-split'), int(at.line), int(at.column), str(name));
}

/** `(:add-clause L "NAME")`, `L` the type declaration's line (`toIdeLineRequest`). Answer: `decodeText`. */
export function addClause(line: number, name: string): Sexp {
  return list(sym('add-clause'), int(line), str(name));
}

/** `(:make-lemma L "HOLE")`. Answer: `decodeLemma`. */
export function makeLemma(line: number, hole: string): Sexp {
  return list(sym('make-lemma'), int(line), str(hole));
}

/** `(:make-case L "HOLE")`. Answer: `decodeText`, the replacement lines. */
export function makeCase(line: number, hole: string): Sexp {
  return list(sym('make-case'), int(line), str(hole));
}

/** `(:make-with L "HOLE")`. Answer: `decodeText`, the replacement lines. */
export function makeWith(line: number, hole: string): Sexp {
  return list(sym('make-with'), int(line), str(hole));
}

/**
 * `(:proof-search L "HOLE" (HINT …))`. The compiler parses and ignores a mode `:all` after the
 * hints (F31), so the builder has none. Answer: `decodeText` (F30: the string is followed by
 * highlighting).
 */
export function proofSearch(line: number, hole: string, hints: readonly string[] = []): Sexp {
  return list(sym('proof-search'), int(line), str(hole), list(...hints.map(str)));
}

/** The bare symbol `:proof-search-next` (F4). Answer: `decodeText`. */
export function proofSearchNext(): Sexp {
  return sym('proof-search-next');
}

/** `(:generate-def L "NAME")`, `L` the type declaration's line (F30). Answer: `decodeText`, one multi-line string. */
export function generateDef(line: number, name: string): Sexp {
  return list(sym('generate-def'), int(line), str(name));
}

/** The bare symbol `:generate-def-next` (F4). Answer: `decodeText`. */
export function generateDefNext(): Sexp {
  return sym('generate-def-next');
}

/** `(:intro L "HOLE")` (F29). Answer: `decodeIntro`. */
export function intro(line: number, hole: string): Sexp {
  return list(sym('intro'), int(line), str(hole));
}

/**
 * `(:refine L "HOLE" "EXPRESSION")` (F29). Answer: `decodeText`; an ambiguous name is an error
 * whose alternatives `decodeAmbiguity` lists.
 */
export function refine(line: number, hole: string, expression: string): Sexp {
  return list(sym('refine'), int(line), str(hole), str(expression));
}

/** `(:interpret "INPUT")`: one REPL input. Answer: `decodeText`. */
export function interpret(input: string): Sexp {
  return list(sym('interpret'), str(input));
}

/** `(:interpret ":missing NAME")` (F15). Answer: `decodeMissingCases`. */
export function missingCases(name: string): Sexp {
  return interpret(`:missing ${name}`);
}

/** The bare symbol `:version` (F4). Answer: `decodeVersion`. */
export function version(): Sexp {
  return sym('version');
}

// -------------------------------------------------------------------------------------------
// Reply decoders
// -------------------------------------------------------------------------------------------

/** A command's answer: its result, or the compiler's error with the error's highlighting. */
export type CommandResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly message: string; readonly highlighting: readonly HighlightSpan[] };

/** A string result and the highlighting after it (offsets into `text`, F30). */
export interface HighlightedText {
  readonly text: string;
  readonly highlighting: readonly HighlightSpan[];
}

/**
 * `(:ok "TEXT" [HL])`: the answer of `:type-of`, `:docs-for`, `:interpret`, `:case-split`,
 * `:add-clause`, `:make-case`, `:make-with`, `:proof-search(-next)`, `:generate-def(-next)` and
 * `:refine`. Edit replies in a bird-track file carry the `> ` prefix (F11).
 */
export function decodeText(payload: ReplyPayload): CommandResult<HighlightedText> {
  return decodeResult(payload, '"TEXT"', (result, highlighting) => {
    const text = string(result);
    return text === undefined ? undefined : { text, highlighting };
  });
}

/** `(:ok ("CANDIDATE" …))`: the answer of `:intro`, one or more candidates (F29). */
export function decodeIntro(payload: ReplyPayload): CommandResult<string[]> {
  return decodeResult(payload, '("CANDIDATE" …)', (result) => {
    const candidates = strings(result);
    return candidates !== undefined && candidates.length > 0 ? candidates : undefined;
  });
}

/** The answer of `:make-lemma`: replace the hole with `application`, declare `lemma` above. */
export interface MetavariableLemma {
  readonly application: string;
  readonly lemma: string;
}

/** `(:ok (:metavariable-lemma (:replace-metavariable "APP") (:definition-type "LEMMA")))`. */
export function decodeLemma(payload: ReplyPayload): CommandResult<MetavariableLemma> {
  return decodeResult(payload, '(:metavariable-lemma …)', (result) => {
    const items = listItems(result);
    if (items?.length !== 3 || symbolName(items[0]) !== 'metavariable-lemma') {
      return undefined;
    }
    const application = tagged(items[1], 'replace-metavariable');
    const lemma = tagged(items[2], 'definition-type');
    return application === undefined || lemma === undefined ? undefined : { application, lemma };
  });
}

/** One definition of a name, as `:name-at` reports it. */
export interface NameLocation {
  /** Qualified, e.g. `Clean.vlen_rhs`. */
  readonly name: string;
  /** Absolute, or `(Interactive)` / `(File-Not-Found)` (`sexpOriginDesc`, `src/Idris/IDEMode/REPL.idr` [src]). */
  readonly file: string;
  /** 0-based, end exclusive (F2). */
  readonly span: IdeReplySpan;
}

/** `(:ok ((NAME (:filename F) (:start L C) (:end L C)) …))`, or `(:ok ())` (F2). */
export function decodeNameAt(payload: ReplyPayload): CommandResult<NameLocation[]> {
  return decodeResult(payload, '((NAME FILE-CONTEXT) …)', (result) => mapList(result, (entry) => {
    const items = listItems(entry);
    const name = items?.length === 4 ? string(items[0]) : undefined;
    const location = items?.length === 4 ? fileContext(list(...items.slice(1))) : undefined;
    return name === undefined || location === undefined ? undefined : { name, ...location };
  }));
}

/** A hole and its context, as `:metavariables` reports it. */
export interface Metavariable {
  /** Qualified, e.g. `Clean.vlen_rhs`. */
  readonly name: string;
  readonly type: string;
  readonly premises: readonly MetavariablePremise[];
}

export interface MetavariablePremise {
  readonly name: string;
  readonly type: string;
  readonly multiplicity: Multiplicity;
  readonly implicit: boolean;
}

/**
 * `(:ok ((NAME (PREMISE …) ("TYPE" HL)) …))`, `(:ok ())` without holes. `NAME` is the Idris
 * `show` of the name's text, quotes and escapes included (`"\"Clean.vlen_rhs\""`), and is read
 * back with the string reader (`holeIDE`, `src/Idris/IDEMode/Holes.idr`). A premise is
 * `("NAME" "TYPE" HL)` whose name is `" " ++ showCount m ++ " " ++ n` with `showCount` `"0 "`,
 * `"1 "` or `""` for unrestricted (`src/Algebra.idr`), and `n` in braces when implicit:
 * `" 0  a"`, `"  xs"`. The highlighting slots are always `()` on 0.8.0 (`-- TODO` in
 * `src/Protocol/IDE/Holes.idr`) and are not read. Premises carry no locations (F2).
 */
export function decodeMetavariables(payload: ReplyPayload): CommandResult<Metavariable[]> {
  return decodeResult(payload, '((NAME PREMISES (TYPE HL)) …)', (result) => mapList(result, (hole) => {
    const items = listItems(hole);
    if (items?.length !== 3) {
      return undefined;
    }
    const shownName = string(items[0]);
    const name = shownName === undefined ? undefined : readShownString(shownName);
    const premises = mapList(items[1], premise);
    const conclusion = listItems(items[2]);
    const type = conclusion?.length === 2 && listItems(conclusion[1]) !== undefined ? string(conclusion[0]) : undefined;
    return name === undefined || premises === undefined || type === undefined ? undefined : { name, type, premises };
  }));
}

const PREMISE_NAME = /^ (?:([01]) )? (.+)$/s;

function premise(sexp: Sexp): MetavariablePremise | undefined {
  const items = listItems(sexp);
  if (items?.length !== 3 || listItems(items[2]) === undefined) {
    return undefined;
  }
  const shown = string(items[0]);
  const type = string(items[1]);
  const match = shown === undefined ? null : PREMISE_NAME.exec(shown);
  if (match === null || type === undefined) {
    return undefined;
  }
  const implicit = match[2].startsWith('{') && match[2].endsWith('}');
  return {
    name: implicit ? match[2].slice(1, -1) : match[2],
    type,
    multiplicity: match[1] === '0' ? 0 : match[1] === '1' ? 1 : 'unrestricted',
    implicit,
  };
}

/** The compiler's version, from `:version`; `tag` is absent for a release build. */
export interface IdrisVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly tag?: string;
}

/** `(:ok ((MAJOR MINOR PATCH) ("TAG")))`, e.g. `((0 8 0) (""))` (`src/Protocol/IDE/Result.idr`). */
export function decodeVersion(payload: ReplyPayload): CommandResult<IdrisVersion> {
  return decodeResult(payload, '((MAJOR MINOR PATCH) ("TAG"))', (result) => {
    const items = listItems(result);
    const numbers = items?.length === 2 ? listItems(items[0]) : undefined;
    const tags = items?.length === 2 ? strings(items[1]) : undefined;
    const [major, minor, patch] = (numbers ?? []).map(smallInteger);
    if (numbers?.length !== 3 || major === undefined || minor === undefined || patch === undefined
      || tags?.length !== 1) {
      return undefined;
    }
    return tags[0] === '' ? { major, minor, patch } : { major, minor, patch, tag: tags[0] };
  });
}

/** What `:missing NAME` reports for one function (`handleMissing'`, `src/Idris/REPL.idr` 1208–1214). */
export type MissingCases =
  /** `NAME:` and one missing clause per line, e.g. `Part.g:\ng (S _)` (F15). */
  | { readonly kind: 'missing'; readonly name: string; readonly clauses: readonly string[] }
  /** `NAME: Calls non covering function F` / `…functions: F, G` [src]. */
  | { readonly kind: 'callsNonCovering'; readonly name: string; readonly functions: readonly string[] }
  /** `NAME: All cases covered` [src]. */
  | { readonly kind: 'covered'; readonly name: string };

const MISSING_HEADER = /^(\S+):$/;
const CALLS_NON_COVERING = /^(\S+): Calls non covering function(?: (\S+)|s: (.+))$/;
const ALL_COVERED = /^(\S+): All cases covered$/;

/** `(:ok "TEXT")` of `(:interpret ":missing NAME")`: the reports joined by newlines. */
export function decodeMissingCases(payload: ReplyPayload): CommandResult<MissingCases[]> {
  return decodeResult(payload, '"MISSING-CASES"', (result) => {
    const text = string(result);
    if (text === undefined) {
      return undefined;
    }
    const reports: MissingCases[] = [];
    // An empty line can only come from a report without clauses (`showSep "\n" []`).
    for (const line of text.split('\n').filter((l) => l !== '')) {
      const covered = ALL_COVERED.exec(line);
      const calls = CALLS_NON_COVERING.exec(line);
      const header = MISSING_HEADER.exec(line);
      const last = reports[reports.length - 1];
      if (covered !== null) {
        reports.push({ kind: 'covered', name: covered[1] });
      } else if (calls !== null) {
        const functions = calls[2] !== undefined ? [calls[2]] : calls[3].split(', ');
        reports.push({ kind: 'callsNonCovering', name: calls[1], functions });
      } else if (header !== null) {
        reports.push({ kind: 'missing', name: header[1], clauses: [] });
      } else if (last?.kind === 'missing') {
        reports[reports.length - 1] = { ...last, clauses: [...last.clauses, line] };
      } else {
        return undefined;
      }
    }
    return reports;
  });
}

/**
 * The alternatives of `:refine`'s ambiguity error, e.g. `["Ambig.A.foo ?g_rhs_0",
 * "Ambig.B.foo ?g_rhs_0"]`, or `undefined` for another error. They are the lines indented by
 * four spaces between `Ambiguous elaboration. Possible results:` and the first blank line; the
 * `(Interactive)` location after it is not part of them (F29; `perrorRaw (AmbiguousElab …)`,
 * `src/Idris/Error.idr` 438–451). An alternative that the pretty-printer broke over several
 * lines would come back as several alternatives; that was not observed [open].
 */
export function decodeAmbiguity(message: string): string[] | undefined {
  const [first, ...rest] = message.split('\n');
  if (first !== 'Ambiguous elaboration. Possible results:') {
    return undefined;
  }
  const alternatives: string[] = [];
  for (const line of rest) {
    if (line === '') {
      break;
    }
    if (!line.startsWith('    ')) {
      return undefined;
    }
    alternatives.push(line.slice(4));
  }
  return alternatives.length > 0 ? alternatives : undefined;
}

/** A module the compiler started to build during a load (`:write-string`, F7). */
export interface BuildingLine {
  /** 1-based position in this load's build order, and the number of modules to build. */
  readonly index: number;
  readonly total: number;
  /** e.g. `Foo.A` */
  readonly module: string;
  /**
   * As the compiler has it: the path given to `:load-file` for the loaded module, a path relative
   * to the session's working directory for an imported one (`1/2: Building Foo.A (src/Foo/A.idr)`
   * then `2/2: Building Foo.B (/…/src/Foo/B.idr)`, transcript `load-simple-ipkg`).
   */
  readonly file: string;
}

/**
 * `N/M: Building MODULE (FILE)`, with `N` padded with spaces to the width of `M` (`msgPrefix`,
 * `buildMsg` in `src/Idris/ModTree.idr` 259–265), or `undefined` for another text. A load whose
 * modules are all up to date sends none (F7).
 */
export function decodeBuildingLine(text: string): BuildingLine | undefined {
  const match = /^ *(\d+)\/(\d+): Building (\S+) \((.*)\)$/.exec(text);
  return match === null
    ? undefined
    : { index: Number(match[1]), total: Number(match[2]), module: match[3], file: match[4] };
}

/** One entry of `(:output (:ok (:highlight-source (HIGHLIGHT …))) ID)` (F33). */
export interface SourceHighlight {
  readonly file: string;
  /** 0-based, end exclusive, unlit columns in bird-track files (F2, F11). */
  readonly span: IdeReplySpan;
  /** The `(:decor :NAME)` symbol's name: `keyword`, `function`, `bound`, `type`, `data`, … */
  readonly decor: string;
  /** Present on names only (`Highlight`; the other entries are `LwHighlight`). */
  readonly name?: string;
  /** `""` for bound names and for a name in its type declaration; the module on its definition (F33). */
  readonly namespace?: string;
  readonly implicit?: boolean;
  readonly key?: string;
  /** Always `""` on 0.8.0 and master (F33): types come from `:type-of`, docs from `:docs-for`. */
  readonly docOverview?: string;
  /** Always `""` on 0.8.0 and master (F33). */
  readonly type?: string;
}

/**
 * The `highlights` of a `highlight-source` payload: `((FILE-CONTEXT PROPERTIES) …)` with
 * `PROPERTIES` = `((:name S) (:namespace S) (:decor :D) (:implicit B) (:key S) (:doc-overview S)
 * (:type S))` for a name or `((:decor :D))` otherwise (`src/Protocol/IDE/Highlight.idr`). Throws a
 * `ProtocolError` for another shape.
 */
export function decodeSourceHighlights(highlights: Sexp): SourceHighlight[] {
  const decoded = mapList(highlights, (entry) => {
    const items = listItems(entry);
    const location = items?.length === 2 ? fileContext(items[0]) : undefined;
    const properties = items?.length === 2 ? mapList(items[1], (property) => {
      const pair = listItems(property);
      const key = pair?.length === 2 ? symbolName(pair[0]) : undefined;
      return key === undefined || pair === undefined ? undefined : [key, pair[1]] as const;
    }) : undefined;
    if (location === undefined || properties === undefined) {
      return undefined;
    }
    const map = new Map(properties);
    const decor = symbolName(map.get('decor'));
    if (decor === undefined) {
      return undefined;
    }
    const highlight: { -readonly [K in keyof SourceHighlight]: SourceHighlight[K] } = { ...location, decor };
    for (const [property, field] of TEXT_PROPERTIES) {
      const value = map.get(property);
      if (value?.kind === 'string') {
        highlight[field] = value.value;
      }
    }
    const implicit = map.get('implicit');
    if (implicit?.kind === 'bool') {
      highlight.implicit = implicit.value;
    }
    return highlight;
  });
  if (decoded === undefined) {
    throw protocolError('(:highlight-source ((FILE-CONTEXT PROPERTIES) …))', highlights);
  }
  return decoded;
}

/** The string-valued properties of a `Highlight` and the fields they fill. */
const TEXT_PROPERTIES = [
  ['name', 'name'],
  ['namespace', 'namespace'],
  ['key', 'key'],
  ['doc-overview', 'docOverview'],
  ['type', 'type'],
] as const;

// -------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------

function decodeResult<T>(
  payload: ReplyPayload,
  expected: string,
  decode: (result: Sexp, highlighting: readonly HighlightSpan[]) => T | undefined,
): CommandResult<T> {
  if (payload.kind === 'error') {
    return { kind: 'error', message: payload.message, highlighting: payload.highlighting };
  }
  if (payload.kind === 'ok') {
    const value = decode(payload.result, payload.highlighting);
    if (value !== undefined) {
      return { kind: 'ok', value };
    }
    throw protocolError(`(:ok ${expected})`, payload.result);
  }
  throw protocolError(`(:ok ${expected})`, list(sym('highlight-source'), payload.highlights));
}

function protocolError(expected: string, got: Sexp): IdrisException {
  let shown: string;
  try {
    shown = serializeSexp(got);
  } catch {
    shown = `a ${got.kind}`;
  }
  const limit = 200;
  const excerpt = shown.length > limit ? `${shown.slice(0, limit)}…` : shown;
  return new IdrisException({ kind: 'ProtocolError', message: `expected ${expected}, got ${excerpt}` });
}

function listItems(sexp: Sexp | undefined): readonly Sexp[] | undefined {
  return sexp?.kind === 'list' ? sexp.items : undefined;
}

function string(sexp: Sexp | undefined): string | undefined {
  return sexp?.kind === 'string' ? sexp.value : undefined;
}

function symbolName(sexp: Sexp | undefined): string | undefined {
  return sexp?.kind === 'symbol' ? sexp.name : undefined;
}

function integer(sexp: Sexp | undefined): bigint | undefined {
  return sexp?.kind === 'integer' ? sexp.value : undefined;
}

/** An integer that fits a JavaScript number exactly (positions, lengths, version numbers). */
function smallInteger(sexp: Sexp | undefined): number | undefined {
  const value = integer(sexp);
  return value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value);
}

function strings(sexp: Sexp): string[] | undefined {
  return mapList(sexp, string);
}

/** `f` of every item of a list, or `undefined` when `sexp` is not a list or `f` fails on an item. */
function mapList<T>(sexp: Sexp, f: (item: Sexp) => T | undefined): T[] | undefined {
  const items = listItems(sexp);
  if (items === undefined) {
    return undefined;
  }
  const out: T[] = [];
  for (const item of items) {
    const value = f(item);
    if (value === undefined) {
      return undefined;
    }
    out.push(value);
  }
  return out;
}

/** `(:TAG "TEXT")` */
function tagged(sexp: Sexp, tag: string): string | undefined {
  const items = listItems(sexp);
  return items?.length === 2 && symbolName(items[0]) === tag ? string(items[1]) : undefined;
}

/** `(L C)` of a `:warning`. */
function replyPoint(sexp: Sexp): IdeReplyPoint | undefined {
  const items = listItems(sexp);
  const line = items?.length === 2 ? smallInteger(items[0]) : undefined;
  const column = items?.length === 2 ? smallInteger(items[1]) : undefined;
  return line === undefined || column === undefined ? undefined : { line, column };
}

/** `FileContext`: `((:filename "F") (:start L C) (:end L C))` (`src/Protocol/IDE/FileContext.idr`). */
function fileContext(sexp: Sexp): { file: string; span: IdeReplySpan } | undefined {
  const items = listItems(sexp);
  if (items?.length !== 3) {
    return undefined;
  }
  const file = tagged(items[0], 'filename');
  const start = taggedPoint(items[1], 'start');
  const end = taggedPoint(items[2], 'end');
  return file === undefined || start === undefined || end === undefined ? undefined : { file, span: { start, end } };
}

/** `(:TAG L C)` */
function taggedPoint(sexp: Sexp, tag: string): IdeReplyPoint | undefined {
  const items = listItems(sexp);
  return items?.length === 3 && symbolName(items[0]) === tag ? replyPoint(list(items[1], items[2])) : undefined;
}

/** The value of an Idris `show`n string (`"…"` with its escapes), read as the compiler would. */
function readShownString(shown: string): string | undefined {
  if (!shown.startsWith('"')) {
    return undefined;
  }
  try {
    return string(parseSexp(shown));
  } catch (e) {
    if (e instanceof SexpSyntaxError) {
      return undefined;
    }
    throw e;
  }
}
