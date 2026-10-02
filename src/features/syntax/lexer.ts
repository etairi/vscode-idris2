/**
 * The Idris 2 source lexer as tokens and bracket groups, for the syntactic features that must know
 * where tokens, comments, strings and bracket groups are (the syntax model of
 * `selectionRangeModel.ts`). The rules are those of `core/idrisLexer.ts` (a port of the compiler's,
 * with their provenance and deviations), which the line reader of the edits (`core/idrisSyntax.ts`)
 * runs too; `lex` reads a whole text with them and links each token to the group it sits in.
 */
import { delimiterKind, lexText, START, type GroupKind, type TokenKind } from '../../core/idrisLexer';

export type { GroupKind, TokenKind };

export interface Group {
  readonly kind: GroupKind;
  readonly open: Token;
  /** `undefined` while (or if never) closed. */
  close: Token | undefined;
  /** The group this one is nested in, if any. */
  readonly parent: Group | undefined;
}

export interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /**
   * The group the token sits in, not counting a group it delimits: for an opening or closing
   * delimiter this is the delimited group's parent.
   */
  readonly outer: Group | undefined;
  /** For delimiter tokens: the group they open or close. */
  readonly delimits: Group | undefined;
}

export interface LexResult {
  /** In source order; whitespace produces no tokens. */
  readonly tokens: readonly Token[];
  /** In order of their opening delimiters. */
  readonly groups: readonly Group[];
}

type MutableToken = { -readonly [K in keyof Token]: Token[K] };

/** Tokenises Idris 2 source text (already unlit, for literate files). */
export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  const groups: Group[] = [];
  // The groups open, innermost last.
  const open: Group[] = [];

  const makeToken = (kind: TokenKind, start: number, end: number): MutableToken => ({
    kind,
    start,
    end,
    text: text.slice(start, end),
    outer: open[open.length - 1],
    delimits: undefined,
  });

  lexText(text, START, 'text', {
    token(kind, start, end) {
      tokens.push(makeToken(kind, start, end));
    },
    open(kind, start, end) {
      const token = makeToken(delimiterKind(kind, true), start, end);
      const group: Group = { kind, open: token, close: undefined, parent: open[open.length - 1] };
      token.delimits = group;
      tokens.push(token);
      groups.push(group);
      open.push(group);
    },
    close(kind, start, end) {
      const group = open.pop() as Group & { close: Token | undefined };
      const token = makeToken(delimiterKind(kind, false), start, end);
      token.delimits = group;
      group.close = token;
      tokens.push(token);
    },
    drop() {
      open.pop();
    },
  });
  return { tokens, groups };
}
