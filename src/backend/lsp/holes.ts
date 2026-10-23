/**
 * The holes of idris2-lsp's `metavars` (`backend/lsp/holes.ts`, ROADMAP §5 M5, F26; ARCHITECTURE §9):
 * the answer checked and turned into `Hole`s by the rules of IDE mode's holes (`backend/ide/holes.ts`
 * `holesOf`), so that both backends list the same holes. Pure; `backend.ts` sends the requests and
 * reads the files. Facts [live: the recordings `commands-clean`, `holes-ipkg`, `lit2`, `ambig`,
 * `edits-searches` of `test/fixtures/lsp-transcripts/0.1.0-9a2f0ad6a`; src: idris2-lsp `9a2f0ad`
 * `Language/LSP/Metavars.idr` 35–111]:
 *
 * - `metavars` answers the user holes of the compiler's context after the server's last load —
 *   whichever file that was: the command names no document — with their qualified names, as IDE
 *   mode's `:metavariables` does: those of the loaded module and of every module it imports, directly
 *   or not, exported or not (`Holes.Base.secret_rhs` after `Holes.Main` was loaded; E16 over LSP).
 * - Each has its `location` (the hole's `?name` token in the compiler's coordinates, `mkLocation`),
 *   absent for a hole a refinement or an Intro made and that was never applied (`Ambig.g_rhs_0`
 *   after `refineHole`), and it also lists declarations without clauses (`Clean.append`,
 *   `Edits.(<||>)`), located at the whole declaration. As in IDE mode, an entry located elsewhere than
 *   at a `?name` token of its name is left out (`isHoleSpan`), and so is one without a location
 *   unless the loaded file's text has its `?name` (`holeTokenNames`): the refinement's holes, which
 *   no text holds, are not shown.
 * - A premise's `multiplicity` is `show` of the compiler's `ZeroOneOmega`: `Rig0`, `Rig1`, `RigW`
 *   (`Algebra/ZeroOneOmega.idr` 40–43 on Idris2 `1c630e6` [src]; `Rig1` not recorded); its
 *   `isImplicit` is the compiler's flag of the premise, the one IDE mode's `:metavariables` prints as
 *   braces (false for `vlen`'s `a` and `n` in both [live]); its `location` is never set (`replFC`) and
 *   has no field in the answer [live].
 */
import type * as vscode from 'vscode';
import { IdrisException } from '../../core/errors';
import type { IdeReplySpan } from '../../core/positions';
import { holeName, isHoleSpan } from '../ide/holes';
import { isIdentifierToken } from '../ide/protocol';
import type { Hole, Multiplicity, Premise } from '../types';
import type { LspMetavar, LspPremise } from './types';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isPosition = (v: unknown): boolean => isObject(v) && Number.isInteger(v.line) && Number.isInteger(v.character);
const isLocation = (v: unknown): boolean => isObject(v) && typeof v.uri === 'string' && isObject(v.range) && isPosition(v.range.start) && isPosition(v.range.end);

function isPremise(v: unknown): v is LspPremise {
  return isObject(v) && typeof v.name === 'string' && typeof v.type === 'string' && typeof v.multiplicity === 'string' && typeof v.isImplicit === 'boolean';
}

function isMetavar(v: unknown): v is LspMetavar {
  return (
    isObject(v) &&
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    (v.location === undefined || v.location === null || isLocation(v.location)) &&
    Array.isArray(v.premises) &&
    v.premises.every(isPremise)
  );
}

/** The `metavars` answer `reply` checked; `ProtocolError` for an answer of another shape. */
export function decodeMetavars(reply: unknown): readonly LspMetavar[] {
  if (!Array.isArray(reply) || !reply.every(isMetavar)) {
    throw new IdrisException({ kind: 'ProtocolError', message: 'Listing holes: idris2-lsp answered metavars with something other than a list of holes, which this extension does not read.' });
  }
  return reply;
}

/** A hole's location as a span of the compiler's coordinates, which the server sends as they are. */
function spanOf(m: LspMetavar): IdeReplySpan | undefined {
  const range = m.location?.range;
  return range === undefined ? undefined : { start: { line: range.start.line, column: range.start.character }, end: { line: range.end.line, column: range.end.character } };
}

/** Whether `m` is a hole (module comment): a name that can be a hole's, located at a `?name` token of it or not located. */
function isHole(m: LspMetavar): boolean {
  const name = holeName(m.name);
  const span = spanOf(m);
  return isIdentifierToken(name) && (span === undefined || isHoleSpan(span, name));
}

/** The URIs of the files the holes among `metavars` are located in, each once: those `holesOf` converts ranges of. */
export function holeFiles(metavars: readonly LspMetavar[]): string[] {
  return [...new Set(metavars.filter(isHole).flatMap((m) => (m.location === undefined || m.location === null ? [] : [m.location.uri])))];
}

const MULTIPLICITIES: Readonly<Record<string, Multiplicity>> = { Rig0: 0, Rig1: 1, RigW: 'unrestricted' };

function premise(p: LspPremise): Premise {
  const multiplicity = Object.hasOwn(MULTIPLICITIES, p.multiplicity) ? MULTIPLICITIES[p.multiplicity] : undefined;
  return { name: p.name, type: { text: p.type, spans: [] }, ...(multiplicity === undefined ? {} : { multiplicity }), implicit: p.isImplicit };
}

/**
 * The holes among `metavars`, in the answer's order (module comment): `inLoadedFile` holds the
 * `?name`s of the text of the file the holes were asked for (`core/idrisSyntax.ts` `holeTokenNames`),
 * and `locate` turns a hole's file and span into its location (`undefined` when the file cannot be
 * read or is not a file: the hole is kept without one).
 */
export function holesOf(metavars: readonly LspMetavar[], inLoadedFile: ReadonlySet<string>, locate: (uri: string, span: IdeReplySpan) => vscode.Location | undefined): Hole[] {
  const holes: Hole[] = [];
  for (const m of metavars) {
    const name = holeName(m.name);
    const span = spanOf(m);
    if (!isHole(m) || (span === undefined && !inLoadedFile.has(name))) {
      continue;
    }
    const location = span === undefined || m.location === undefined || m.location === null ? undefined : locate(m.location.uri, span);
    holes.push({
      name,
      qualifiedName: m.name,
      type: { text: m.type, spans: [] },
      premises: m.premises.map(premise),
      ...(location === undefined ? {} : { location }),
    });
  }
  return holes;
}

/**
 * How many entries of a `textDocument/documentSymbol` answer `reply` (flat `SymbolInformation`s [live,
 * `features-shapes`, `lit2`]) look like the holes of the document (`isDocument` names its URI): a name
 * that can be a hole's, located at a span as long as `?name`. The server lists a file's holes among
 * its symbols (`half_rhs` at `18:9-18:18` of `Lit2.lidr`); `backend.ts` compares them with the
 * `metavars` answer to tell whether that answer was of the document's context. `null`, the answer for
 * a document with unsaved changes, and any other shape count as 0.
 */
export function holeSymbolCount(reply: unknown, isDocument: (uri: string) => boolean): number {
  if (!Array.isArray(reply)) {
    return 0;
  }
  return reply.filter((s: unknown) => {
    if (!isObject(s) || typeof s.name !== 'string' || !isLocation(s.location)) {
      return false;
    }
    const location = s.location as { readonly uri: string; readonly range: { readonly start: { line: number; character: number }; readonly end: { line: number; character: number } } };
    const span: IdeReplySpan = { start: { line: location.range.start.line, column: location.range.start.character }, end: { line: location.range.end.line, column: location.range.end.character } };
    return isIdentifierToken(s.name) && isDocument(location.uri) && isHoleSpan(span, s.name);
  }).length;
}
