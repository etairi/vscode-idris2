/**
 * The token index of a loaded file (`backend/ide/highlight.ts`, docs/ARCHITECTURE.md §2; ROADMAP
 * M3): the `(:output (:ok (:highlight-source …)) ID)` frames of one `:load-file` reply →
 * `TokenIndex` (`backend/types.ts`), which the semantic tokens, document symbols and highlights
 * and the inlay hints read.
 *
 * **What a frame carries** [live, the 0.8.0 transcripts]: one entry per frame, a span (0-based,
 * end exclusive; unlit columns in a bird-track file, F11; code points, E14) and either
 * `((:decor :D))` — keywords, comments, literals, primitive types — or a name with `:name`,
 * `:namespace`, `:decor`, `:implicit`, `:key`, and `:doc-overview` and `:type`, which are always
 * `""` (F33): the index keeps name, decoration, span, namespace and the implicit flag, nothing
 * else. `:namespace` is `""` on declaring occurrences and on bound names and the defining module on
 * references (`Shape` in `Foo.Shapes`, `pi` in `Prelude.Types` [live, `shapes-lookups`]), so it
 * does not tell names apart (F33).
 *
 * **Conversions.** Every span goes through `core/positions.ts` `fromIdeReplySpan` with the text the
 * compiler read (`backend.ts` reads the file from disk when the reply arrives): the bird-track
 * offset and the code-point columns of lines with characters outside the BMP.
 *
 * **Duplicates and order.** The compiler sends some entries twice: identical ones (`a` in the method
 * signature `perimeter : a -> Double`, `Shape` in `Measured Shape where`), and the method's name in
 * that signature once with the namespace `Foo.Shapes` and once with `""` [live, `shapes-lookups`].
 * Entries with the same span, decoration, name and implicit flag are one token, which keeps a
 * namespace one of them has. The tokens are sorted by start, then end. Nothing in the protocol
 * makes their spans disjoint — an interpolated string's `:data` holds the `:bound` variable inside
 * it [live, review of M3] —, so a consumer that needs disjoint tokens chooses (the semantic tokens:
 * the inner one, `features/intelligence/semanticTokens.ts`). A decoration outside the nine of
 * `Decor` is left out.
 *
 * **Which file.** A load's frames cover the loaded file only [live: the imported `Foo.A` built by
 * the load of `Foo.B` sends none, `load-simple-ipkg`]; frames naming another file are ignored all
 * the same. A load that returns an error sends none [live: `load-bad`, `load-part`, `load-mixed`],
 * and then the previous index of the file is kept (`tokenIndexOf` answers `undefined`), since the
 * file's text is likely close to the one it describes; its `text` says which text that was.
 *
 * **Built once per reply.** The session layer hands a request's messages over with its `:return`
 * (`Reply.messages`, `session.ts`), so the index is built from the collected frames in one pass;
 * each frame's text was parsed when it arrived. The cost of this pass for a large file is measured
 * by `test/unit/highlight.test.ts` (ROADMAP M3 budget: 200 ms for a 2,000-line file).
 */
import { IdrisException } from '../../core/errors';
import { fromIdeReplySpan, type PositionDocument } from '../../core/positions';
import type { Token, TokenIndex } from '../types';
import { asDecor, decodeSourceHighlights, type SourceHighlight } from './protocol';
import type { IdeMessage } from './types';

/** What `tokenIndexOf` needs to know about the loaded file. */
export interface LoadedSource {
  /** The document's `fileName` (`TokenIndex.file`). */
  readonly file: string;
  /** Whether a frame's `:filename` names the loaded file (the path sent in `:load-file`). */
  isLoadedFile(filename: string): boolean;
  /** The text the compiler read, for `core/positions.ts`. */
  readonly document: PositionDocument;
  /**
   * That text as read from disk (`TokenIndex.text`), when it is known to be the text the compiler
   * read (`backend.ts` reads the file before and after the load and passes it only when they agree).
   */
  readonly text: string | undefined;
  /** The `:return` was `(:ok …)`. */
  readonly ok: boolean;
}

/**
 * The token index of the loaded file from the messages of its load, or `undefined` when the load
 * returned an error and sent no highlighting for the file (the previous index stays; module
 * comment). A successful load without any frame for the file gives an empty index. A frame whose
 * payload `decodeSourceHighlights` cannot read (a newer compiler's shape) is skipped: the load's
 * diagnostics do not depend on the index, and the protocol trace shows the frame.
 */
export function tokenIndexOf(messages: readonly IdeMessage[], source: LoadedSource): TokenIndex | undefined {
  const byKey = new Map<string, Token>();
  let frames = 0;
  for (const message of messages) {
    if (message.kind !== 'output' || message.payload.kind !== 'highlight-source') {
      continue;
    }
    let highlights: SourceHighlight[];
    try {
      highlights = decodeSourceHighlights(message.payload.highlights);
    } catch (error) {
      if (error instanceof IdrisException) {
        continue; // a frame of another shape (a newer compiler): the rest of the index is still right
      }
      throw error;
    }
    for (const highlight of highlights) {
      if (!source.isLoadedFile(highlight.file)) {
        continue;
      }
      frames++;
      const decor = asDecor(highlight.decor);
      if (decor === undefined) {
        continue;
      }
      const range = fromIdeReplySpan(source.document, highlight.span);
      const token: Token = {
        range,
        decor,
        ...(highlight.name === undefined ? {} : { name: highlight.name }),
        ...(highlight.namespace === undefined ? {} : { namespace: highlight.namespace }),
        ...(highlight.implicit === undefined ? {} : { implicit: highlight.implicit }),
      };
      const key = [range.start.line, range.start.character, range.end.line, range.end.character, decor, highlight.name ?? '', `${highlight.implicit}`].join('\u0000');
      const kept = byKey.get(key);
      if (kept === undefined) {
        byKey.set(key, token);
      } else if (!kept.namespace && token.namespace) {
        byKey.set(key, { ...kept, namespace: token.namespace });
      }
    }
  }
  if (frames === 0 && !source.ok) {
    return undefined;
  }
  const tokens = [...byKey.values()].sort(
    (a, b) =>
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character ||
      a.range.end.line - b.range.end.line ||
      a.range.end.character - b.range.end.character,
  );
  return { file: source.file, ...(source.text === undefined ? {} : { text: source.text }), tokens };
}
