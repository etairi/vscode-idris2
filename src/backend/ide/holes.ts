/**
 * The holes of a load in IDE mode (`backend/ide/holes.ts`, ROADMAP §5 M4, ARCHITECTURE §9): the
 * `(:metavariables 80)` answer (`protocol.ts` `decodeMetavariables`: the quoted qualified name read
 * back, each premise's multiplicity prefix — `0`, `1`, blank for unrestricted —) turned into `Hole`s,
 * and the `:name-at` entry that locates each. Pure; `backend.ts` sends the requests and reads the
 * files. Facts [live, idris2 0.8.0, transcripts `holes-ipkg-*`, `holes-loose-*`, `edits-names`,
 * `hole-errors`, `lit2-editing`]:
 *
 * - `:metavariables` lists the holes of the loaded module and of every module it imports, directly
 *   or not, exported or not (`Holes.Base.secret_rhs` after a load of `Holes.Main`), by unqualified
 *   name, then module; also after a load that returned an error (the holes before and after it).
 * - It also lists declarations without clauses (`Edits.zip3`, `Clean.append`, `Edits.(<||>)`) and
 *   definitions that failed (`HoleErr.bad`), without premises. They are not holes: an operator's
 *   name is no hole's, and the `:name-at` span of the others is the whole declaration, where a
 *   hole's is its `?name` token (`isHoleSpan`). They are left out.
 * - `:name-at` takes the unqualified name (the qualified one answers `()`, F2) and answers every
 *   definition of it in the compiler's context: `todo` gives `Holes.Base.todo` and `Holes.Main.todo`,
 *   each with its absolute path, so the entry of a hole is the one of its qualified name (E16).
 * - Holes of one name in two modules of the loaded context cannot be edited: the commands that look
 *   the hole up by name answer `Could not find hole named todo`, `Can't make lifted definition` or
 *   `Not a searchable hole`, also given the qualified name (`holes-ipkg-main`); the backend refuses
 *   Intro, Refine Hole, Proof Search and Make Lemma there before anything is sent (`edits.ts`
 *   `holeRefusal`).
 *
 * The number of holes is not limited; `MAX_LOCATED_NAMES` bounds the `:name-at` requests per load.
 * The work on the extension host is linear in the number of holes and the size of the files they
 * are in: the loaded text is scanned once for its `?name` tokens, and each file's lines are split
 * once to convert the locations (`backend.ts`).
 */
import type * as vscode from 'vscode';
import type { IdeReplySpan } from '../../core/positions';
import type { Hole, Premise, RichText } from '../types';
import { isIdentifierToken, type Metavariable, type MetavariablePremise, type NameLocation } from './protocol';

/**
 * At most this many names are located per load (one `:name-at` request each); the holes of the
 * names after them have no location. Measured [live, idris2 0.8.0, the UX review of M4]: a
 * `:name-at` round trip over stdio took 0.13 ms (median; 0.28 ms at most), 300 of them 40 ms, so
 * this bound is about 0.3 s of the compiler's time after a load.
 */
export const MAX_LOCATED_NAMES = 2000;

/** The name after the namespace: `Holes.Main.todo` → `todo`, `Edits.ε` → `ε`. */
export function holeName(qualified: string): string {
  return qualified.slice(qualified.lastIndexOf('.') + 1);
}

/**
 * The unqualified names of the entries of `metavariables` that may be holes (`isIdentifierToken`: an
 * operator is not; a name with an invisible character is kept, `a\u{202E}b` [live, security review of
 * M4]), each once, at most `MAX_LOCATED_NAMES`: those to ask `:name-at` for. Those in
 * `inLoadedFile` (the `core/idrisSyntax.ts` `holeTokenNames` of the loaded file's text) come first, then the others, each
 * in the answer's order — which is by name as a string (`Base.aaa_rhs` before `Main.zzz_rhs`
 * [live]), so without it the loaded file's own holes would be the ones left out. Linear in the
 * number of metavariables.
 */
export function namesToLocate(metavariables: readonly Metavariable[], inLoadedFile: ReadonlySet<string>): string[] {
  const names = [...new Set(metavariables.map((m) => holeName(m.name)).filter(isIdentifierToken))];
  return [...names.filter((n) => inLoadedFile.has(n)), ...names.filter((n) => !inLoadedFile.has(n))].slice(0, MAX_LOCATED_NAMES);
}

/** Whether `span` is that of a `?name` token (one line, the name's code points and the `?`), not of a declaration. */
export function isHoleSpan(span: IdeReplySpan, name: string): boolean {
  return span.start.line === span.end.line && span.end.column - span.start.column === [...name].length + 1;
}

const plain = (text: string): RichText => ({ text, spans: [] });

/** A premise; IDE mode does not say which premises are implicit (`Premise.implicit`). */
function premise(p: MetavariablePremise): Premise {
  return { name: p.name, type: plain(p.type), multiplicity: p.multiplicity };
}

/** The `:name-at` entry of `m` in `entries`: the one of its qualified name (E16). */
function entryOf(m: Metavariable, entries: ReadonlyMap<string, readonly NameLocation[] | undefined>): NameLocation | undefined {
  return entries.get(holeName(m.name))?.find((e) => e.name === m.name);
}

/** The entries `holesOf` locates holes with: those of holes (`isHoleSpan`), whose files it needs. */
export function holeEntries(metavariables: readonly Metavariable[], entries: ReadonlyMap<string, readonly NameLocation[] | undefined>): NameLocation[] {
  return metavariables
    .map((m) => entryOf(m, entries))
    .filter((e): e is NameLocation => e !== undefined && isHoleSpan(e.span, holeName(e.name)));
}

/**
 * The holes among `metavariables`, in the answer's order: `entries` holds the `:name-at` answer of
 * each located name (`undefined` for an error answer), `locate` turns an entry into a location
 * (`undefined` when its file cannot be read or is not a path). An entry whose span is not a hole's
 * leaves its metavariable out; a hole without an entry (an error answer, or a name the answer does
 * not list) has no location. A name not asked about (past `MAX_LOCATED_NAMES`) may be a declaration
 * without clauses as well as a hole: it is kept only when it is a `?name` of the loaded file
 * (`inLoadedFile`, as in `namesToLocate`).
 */
export function holesOf(
  metavariables: readonly Metavariable[],
  entries: ReadonlyMap<string, readonly NameLocation[] | undefined>,
  inLoadedFile: ReadonlySet<string>,
  locate: (entry: NameLocation) => vscode.Location | undefined,
): Hole[] {
  const holes: Hole[] = [];
  for (const m of metavariables) {
    const name = holeName(m.name);
    if (!isIdentifierToken(name) || (!entries.has(name) && !inLoadedFile.has(name))) {
      continue;
    }
    const entry = entryOf(m, entries);
    if (entry !== undefined && !isHoleSpan(entry.span, name)) {
      continue;
    }
    const location = entry === undefined ? undefined : locate(entry);
    holes.push({
      name,
      qualifiedName: m.name,
      type: plain(m.type),
      premises: m.premises.map(premise),
      ...(location === undefined ? {} : { location }),
    });
  }
  return holes;
}
