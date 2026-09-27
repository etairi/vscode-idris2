// Source of syntaxes/idris2.tmLanguage.json (scope source.idris2). Regenerate with
//   node scripts/build-grammar.mjs            (writes the JSON)
//   node scripts/build-grammar.mjs --check    (exits 1 when the committed JSON is stale)
// test/grammar/idris2.test.ts runs the --check form.
//
// Every rule is derived from the Idris 2 lexer and parser, read at two commits that agree on
// every lexical rule used here:
//   master 1c630e6 (2026-09-08) and v0.8.0 15a3e4e (the installed compiler).
// File references below are to master; `diff` of src/Parser/Lexer/{Source,Common}.idr,
// src/Libraries/Text/Lexer{,/Core,/Tokenizer}.idr and src/Core/Name.idr between the two commits
// shows only import and implementation changes (SnocList accumulators, %inline). Where the
// parsers differ the difference is noted at the rule (`%language Borrowing`, `\{x} =>`).
// Behaviour that the source alone does not settle was checked with `idris2 --check` (0.8.0);
// those checks are cited as "verified" and listed in test/grammar/idris2-scopes.md.
//
// How the lexer maps onto TextMate. `rawTokens` (src/Parser/Lexer/Source.idr 305-344) is an
// ordered choice tried at each token start, and every recogniser is possessive (PEG `many`/`<|>`
// in src/Libraries/Text/Lexer/Core.idr `scan`). A TextMate scanner picks the leftmost match and,
// among matches at the same position, the first pattern in the list. So the grammar reproduces
// the lexer when (1) every token kind has a rule that matches at the token's start, (2) rules
// that can match at the same position are listed in rawTokens order, and (3) regexes that must
// not backtrack use possessive quantifiers or atomic groups. Identifiers are therefore matched
// as whole tokens even when they get no scope, so that a keyword or a char literal is never
// found inside one (`data'` is an identifier; `x'a'` is one identifier).
//
// Scope names follow the TextMate conventions themes already colour; every scope ends in
// `.idris2`. The inventory with examples is test/grammar/idris2-scopes.md, and a test checks
// that it lists exactly the scopes this file emits.

// ---------------------------------------------------------------------------------------------
// Lexical data, copied from the compiler
// ---------------------------------------------------------------------------------------------

/**
 * `keywords` ++ `fixityKeywords` ++ totality words, in source order
 * (src/Parser/Lexer/Source.idr 187-202; identical in v0.8.0). `parseIdent` turns exactly these
 * identifiers into Keyword tokens, so exactly these are highlighted as keywords. Idris 1's
 * class, instance, codata, dsl, syntax, tactics, postulate are ordinary identifiers.
 */
const LEXER_KEYWORDS = [
  'data', 'module', 'where', 'let', 'in', 'do', 'record',
  'auto', 'default', 'implicit', 'failing', 'mutual', 'namespace',
  'parameters', 'with', 'proof', 'impossible', 'case', 'of',
  'if', 'then', 'else', 'forall', 'rewrite', 'typebind', 'autobind',
  'using', 'interface', 'implementation', 'open', 'import',
  'public', 'export', 'private',
  'infixl', 'infixr', 'infix', 'prefix',
  'total', 'partial', 'covering',
];

/** How each keyword is scoped. The union must be LEXER_KEYWORDS (checked in buildGrammar). */
const KEYWORD_GROUPS = [
  ['keyword.control.conditional', ['if', 'then', 'else']],
  ['keyword.control.case', ['case', 'of']],
  ['keyword.control.do', ['do']],
  ['keyword.control.let', ['let', 'in']],
  ['keyword.control.with', ['with', 'proof']],
  ['keyword.control.rewrite', ['rewrite']],
  ['keyword.control.impossible', ['impossible']],
  ['keyword.control.import', ['import']],
  ['keyword.other.module', ['module']],
  ['keyword.other.where', ['where']],
  ['keyword.other.namespace', ['namespace']],
  ['keyword.other.parameters', ['parameters']],
  ['keyword.other.mutual', ['mutual']],
  ['keyword.other.using', ['using']],
  ['keyword.other.failing', ['failing']],
  ['keyword.other.forall', ['forall']],
  ['keyword.other.fixity', ['infixl', 'infixr', 'infix', 'prefix']],
  // Reserved by the lexer but used by no parser rule (grep of src/Idris/Parser.idr).
  ['keyword.other.reserved', ['open', 'implicit']],
  ['storage.type.data', ['data']],
  ['storage.type.record', ['record']],
  ['storage.type.interface', ['interface']],
  ['storage.type.implementation', ['implementation']],
  ['storage.modifier.visibility', ['public', 'export', 'private']],
  ['storage.modifier.totality', ['total', 'partial', 'covering']],
  ['storage.modifier.implicit', ['auto', 'default']],
  ['storage.modifier.binding', ['typebind', 'autobind']],
];

/**
 * `reservedNames` (src/Parser/Rule/Source.idr): identifiers that cannot be defined or used as
 * ordinary names. `Type` is parsed by `atom` (PType); the primitive types by `constant`;
 * Lazy/Inf/Delay/Force by `lazy` in src/Idris/Parser.idr.
 */
const PRIMITIVE_TYPES = [
  'Type', 'Int', 'Int8', 'Int16', 'Int32', 'Int64', 'Integer',
  'Bits8', 'Bits16', 'Bits32', 'Bits64', 'String', 'Char', 'Double',
];
const DELAY_TYPES = ['Lazy', 'Inf'];
const DELAY_FUNCTIONS = ['Delay', 'Force'];

/**
 * Every name the parser accepts after `%` (`pragma "…"` / `decoratedPragma fname "…"` in
 * src/Idris/Parser.idr on master and v0.8.0; the two lists are identical). `World`/`MkWorld`
 * are primitive values and get their own scopes; `cg` is its own token (cgDirective).
 */
const KNOWN_PRAGMAS = [
  'allow_overloads', 'ambiguity_depth', 'auto_implicit_depth', 'auto_lazy', 'builtin',
  'charLit', 'declsLit', 'default', 'defaulthint', 'deprecate', 'doubleLit', 'export', 'extern',
  'foreign', 'foreign_impl', 'globalhint', 'hide', 'hint', 'inline', 'integerLit', 'language',
  'logging', 'macro', 'name', 'nameLit', 'nf_metavar_threshold', 'noinline', 'nomangle', 'pair',
  'prefix_record_projections', 'rewrite', 'runElab', 'search', 'search_timeout', 'spec', 'start',
  'stringLit', 'syntactic', 'tcinline', 'totality_depth', 'transform', 'TTImpLit',
  'unbound_implicits', 'unhide', 'unsafe',
];

/**
 * Pragmas that can only begin a declaration (never occur inside an expression), used to end an
 * unclosed bracket at a new top-level declaration: the `directive` alternatives, `%transform`,
 * `%builtin` and `%cg`. Not included: search, runElab and logging (also expression forms in
 * `atom`/`expr`/`simplerExpr`), syntactic (a `with` flag), and the function options of
 * `fnDirectOpt`, which `case_` also accepts before `case` (`%inline case x of …`).
 */
const DECLARATION_PRAGMAS = [
  'allow_overloads', 'ambiguity_depth', 'auto_implicit_depth', 'auto_lazy', 'builtin', 'cg',
  'charLit', 'declsLit', 'default', 'doubleLit', 'foreign_impl', 'hide', 'integerLit', 'language',
  'name', 'nameLit', 'nf_metavar_threshold', 'pair', 'prefix_record_projections', 'rewrite',
  'search_timeout', 'start', 'stringLit', 'totality_depth', 'transform', 'TTImpLit',
  'unbound_implicits', 'unhide',
];

/** The function options (fnDirectOpt) that may stand among a declaration's modifiers (visOpt). */
const FUNCTION_PRAGMAS = [
  'inline', 'noinline', 'tcinline', 'hint', 'globalhint', 'defaulthint', 'extern', 'macro',
  'unsafe', 'deprecate',
];

/**
 * `reservedInfixSymbols` (src/Parser/Lexer/Source.idr 244-247) as whole operator tokens, with
 * the role the parser gives each. `|||` is in that list but is always lexed as a doc comment
 * (docComment is tried before validSymbol), so it never reaches the operator rules.
 */
const RESERVED_OPERATORS = [
  ['->', 'keyword.operator.arrow'],
  ['=>', 'keyword.operator.arrow.double'],
  ['<-', 'keyword.operator.arrow.left'],
  [':=', 'keyword.operator.assignment'],
  ['$=', 'keyword.operator.assignment.apply'],
  [':', 'keyword.operator.colon'],
  ['=', 'keyword.operator.equals'],
  ['|', 'keyword.operator.pipe'],
  ['**', 'keyword.operator.dependent-pair'],
  ['..', 'keyword.operator.range'],
  ['\\', 'keyword.operator.lambda'],
  ['?', 'keyword.operator.infer'],
  ['!', 'keyword.operator.bang'],
  ['@', 'keyword.operator.as-pattern'],
  ['~', 'keyword.operator.unquote'],
  // Reserved, no parser rule uses them.
  ['&', 'keyword.operator.reserved'],
  ['%', 'keyword.operator.reserved'],
];

/**
 * Names of the ASCII control characters, in the order `charLit`'s `lexStr` tries them
 * (src/Libraries/Text/Lexer.idr 350-354); `unescape` (src/Parser/Support/Escaping.idr getEsc)
 * accepts the same set in strings. SOH precedes SO, so `\SOH` is one escape.
 */
const ASCII_ESCAPE_NAMES = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
  'BS', 'HT', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
  'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US',
  'SP', 'DEL',
];

/**
 * Hash counts that get dedicated string rules (escape and interpolation prefixes depend on the
 * count, and TextMate cannot back-reference a begin capture outside `end`/`while`). Strings with
 * more hashes use one generic rule that ends correctly but does not mark escapes or
 * interpolation. The corpora pinned in test/corpus/corpus.json use at most two hashes.
 */
const MAX_DEDICATED_HASHES = 3;

// ---------------------------------------------------------------------------------------------
// Regex fragments
// ---------------------------------------------------------------------------------------------

// src/Parser/Lexer/Common.idr isIdentStart / isIdentTrailing: ASCII letters (the Prelude's
// isAlpha is ASCII-only), '_', and every character above U+00A0 (`x > chr 160`); trailing
// characters add ASCII digits and '\''. U+00A0 itself is a space (Prelude isSpace).
const HIGH = String.raw`\x{A1}-\x{10FFFF}`;
const TRAIL_CLASS = `A-Za-z0-9_'${HIGH}`;
const TRAIL = `[${TRAIL_CLASS}]`;
const NOT_TRAIL = `(?!${TRAIL})`;
// src/Core/Name.idr isOpChar: ":!#$%&*+./<=>?@\\^|-~".
const OP_CLASS = String.raw`:!#$%&*+./<=>?@\\^|\-~`;
const NOT_OP = `(?![${OP_CLASS}])`;
const OP_RUN = `[${OP_CLASS}]++`;
/** identNormal: after `?` (hole), `.` (projection), `%` (pragma) and as a qualified name's last part. */
const IDENT = `[A-Za-z_${HIGH}]${TRAIL}*`;
/**
 * An identifier token as it can occur at a token start: a leading `_` is always lexed as the
 * symbol `_` first (`symbols` precedes identNormal in rawTokens; verified: `f _x = 1` is `f _ x`).
 */
const WORD = `[A-Za-z${HIGH}]${TRAIL}*`;
/** `ident Capitalised` at a token start: isUpper or above U+00A0. */
const CAP_WORD = `[A-Z${HIGH}]${TRAIL}*`;
/** `ident Capitalised` after a dot inside a namespaced identifier (a leading `_` is allowed there). */
const CAP_PART = `[A-Z_${HIGH}]${TRAIL}*`;
const KEYWORD_ALT = LEXER_KEYWORDS.join('|');
/** A declarable name: an identifier token that is not a keyword. */
const NAME = `(?!(?:${KEYWORD_ALT})${NOT_TRAIL})${WORD}`;
/** A NAME that starts with an ASCII lower-case letter, so it cannot be a data constructor. */
const LOWER_NAME = `(?!(?:${KEYWORD_ALT})${NOT_TRAIL})[a-z]${TRAIL}*`;
/** opNonNS (src/Parser/Rule/Source.idr): an operator or a postfix projection in parentheses. */
const PAREN_OP = String.raw`\(\s*(?:${OP_RUN}|\.${IDENT})\s*\)`;
/** moduleIdent / namespaceId: dot-separated, every part capitalised. */
const MODULE_NAME = `${CAP_WORD}(?:\\.${CAP_PART})*`;
const BINDER = `(?:${NAME}|_)`;
const BINDER_LIST = `${BINDER}(?:\\s*,\\s*${BINDER})*`;
/** A record field path in an update: `a.b` (dot projections) or Idris 1's `a->b`. */
const FIELD_PATH = String.raw`${NAME}(?:\.${IDENT}|\s*->\s*${NAME})*`;
/**
 * The simpleExpr before the binder of `{default V x : T}`, approximated: a number, a (qualified)
 * name, a string or char literal, or a bracket group nested at most one level deep, then any
 * postfix projections.
 */
const DEFAULT_VALUE = `(?:${[
  String.raw`[0-9][0-9A-Za-z_]*(?:\.[0-9]+(?:e[-+]?[0-9]+)?)?`,
  `(?:${CAP_WORD}\\.)*${IDENT}`,
  String.raw`"(?:[^"\\]|\\.)*"`,
  String.raw`'(?:[^'\\]|\\[^']*)'`,
  String.raw`\((?:[^()]|\([^()]*\))*\)`,
  String.raw`\[(?:[^\[\]]|\[[^\[\]]*\])*\]`,
].join('|')})(?:\\.${IDENT})*`;
const ESCAPE_BODY = [
  ...ASCII_ESCAPE_NAMES,
  // unescape: \x and \o take any number of digits (none is accepted), decimal needs one.
  '[0-9]+', 'x[0-9A-Fa-f]*', 'o[0-7]*',
].join('|');
const CHAR_ESCAPE_BODY = [...ASCII_ESCAPE_NAMES, 'x[0-9A-Fa-f]+', 'o[0-7]+', '[0-9]+'].join('|');

/**
 * The start of a line of code: `^`, or, when syntaxes/lidr.tmLanguage.json embeds this grammar,
 * the position after a bird track and the one whitespace character the compiler strips with it
 * (src/Parser/Unlit.idr). vscode-textmate's \G anchor is usually live there too (the embedding
 * begin/while rules end there), but not after a begin/end rule ended there with zero width: it
 * then restores the anchor saved when that rule was pushed, and saved anchors are reset at every
 * line. The lookbehind finds the position in both cases. In a .idr file it also matches after a
 * column-0 "> " or "< "; no declaration starts with such a line, and a data declaration already
 * ends at its column 0.
 */
const CODE_START = String.raw`(?:^|(?<=^[<>][ \t\f\v\x{A0}]))`;
/** CODE_START, or \G right after the begin of an enclosing rule (`` `[ `` quotes declarations). */
const DECL_START = `(?:${CODE_START}|\\G)`;
/**
 * Right after the opening "(" or "{" of the enclosing bracket rule. \G alone is not enough: in a
 * .lidr file it is also live at the start of every code line, so a continuation line inside the
 * bracket would be taken for its start.
 */
const PAREN_START = String.raw`(?<=\()\G`;
const BRACE_START = String.raw`(?<=\{)\G`;
/** The start of a comment that follows code on a line: a line comment (not "--}") or "{-". */
const COMMENT_START = String.raw`--(?>-*)(?!\})|\{-`;
/**
 * A block comment that closes on its own line and contains no nested comment, line comment or
 * string ("{- a 2-D point -}"), for the rules that must see the token after a comment (comments
 * are whitespace to the parser). The opener takes every dash, as blockComment does, so "{--}"
 * does not match; "--" inside a comment hides the rest of the line (toEndComment), so the body
 * stops at it. A comment of any other shape makes the rule fail, and its tokens are then scoped
 * one by one.
 */
const INLINE_BLOCK_COMMENT = String.raw`\{-++(?:[^-{"\n]|-(?![-}])|\{(?!-))*+-+\}`;

const words = (list) => `(?:${list.join('|')})${NOT_TRAIL}`;
const escapeRegex = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const hashes = (n) => '#'.repeat(n);
/** dataOpt (src/Idris/Parser.idr): the identifiers the parser accepts in "[ … ]" after "where". */
const DATA_OPTION = words(['noHints', 'uniqueSearch', 'search', 'external', 'noNewtype']);

/**
 * Ends a bracket that is still open where a new top-level declaration starts, so that an
 * unbalanced bracket while typing does not swallow the rest of the file. Only text that cannot
 * continue an expression or a braced record body counts: at column 0 (CODE_START), a keyword
 * that only begins declarations, or a declaration-only pragma. Column 0 alone is not a signal:
 * continuation lines there are valid (verified: `xs = [ 1` / `     , 2` / `]`, `ys = (1 +` / `2)`
 * and `n : (` / `x : Nat) -> Nat` all check), so is a doc comment at column 0 inside
 * `record R where {` … `}` (verified), and `record` is excluded because the deprecated
 * `record { … } r` update is an expression. Balanced code never reaches this: its closing
 * bracket comes first.
 */
const BRACKET_RECOVERY = String.raw`${CODE_START}(?=${words([
  'data', 'interface', 'implementation', 'namespace', 'module', 'import', 'mutual',
  'parameters', 'using', 'failing', 'infixl', 'infixr', 'infix', 'prefix', 'public', 'export',
  'private', 'total', 'partial', 'covering', 'typebind', 'autobind',
])}|%${words(DECLARATION_PRAGMAS)})`;

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const s = (name) => `${name}.idris2`;
const inc = (key) => ({ include: `#${key}` });

function keywordRules() {
  return KEYWORD_GROUPS.map(([scope, list]) => ({ match: words(list), name: s(scope) }));
}

/** Strings with `n` leading hashes: escapes are `\` + n×`#`, interpolation `\` + n×`#` + `{`. */
function stringRules(repo) {
  const multi = [];
  const single = [];
  for (let n = MAX_DEDICATED_HASHES; n >= 0; n--) {
    const h = hashes(n);
    const raw = n > 0 ? '.raw' : '';
    const esc = String.raw`\\${h}`;
    repo[`string-interpolation-${n}`] = {
      comment: `stringTokens (Source.idr 288-303): interpStart = "\\\\${h}{" opens an interpolation that is lexed with rawTokens up to its matching "}" (groups nest through compose; verified with a string, a char literal and braces inside).`,
      begin: `${esc}\\{`,
      beginCaptures: { 0: { name: s('punctuation.section.embedded.begin') } },
      end: '\\}',
      endCaptures: { 0: { name: s('punctuation.section.embedded.end') } },
      name: s('meta.interpolation'),
      contentName: s('meta.embedded.line'),
      patterns: [inc('expression')],
    };
    repo[`string-escape-single-${n}`] = {
      comment: `escapeLexer = escape (exact "\\\\${h}") any, interpreted by unescape (src/Parser/Support/Escaping.idr): named ASCII controls, decimal, x-hex, o-octal, and any other character (a backslash before an unknown character is dropped, verified: "\\q" == "q").`,
      match: `${esc}(?:${ESCAPE_BODY}|.)`,
      name: s('constant.character.escape'),
    };
    repo[`string-escape-multi-${n}`] = {
      comment: 'As in single-line strings; in a multi-line string a backslash before the line end is a line continuation (unescape drops the newline).',
      match: `${esc}(?:${ESCAPE_BODY}|[\\s\\S])`,
      name: s('constant.character.escape'),
    };
    multi.push({
      comment: `multilineBegin (Source.idr 165-167): ${n} hash(es), """, then only spaces up to the line end; ends at the first """${h} (multilineEnd, no look-ahead).`,
      begin: `${h}"""(?=[ \\t\\r\\f\\v\\x{A0}]*$)`,
      beginCaptures: { 0: { name: s('punctuation.definition.string.begin') } },
      end: `"""${h}`,
      endCaptures: { 0: { name: s('punctuation.definition.string.end') } },
      name: s(`string.quoted.triple${raw}`),
      patterns: [inc(`string-interpolation-${n}`), inc(`string-escape-multi-${n}`)],
    });
    single.push({
      comment: `stringBegin (Source.idr 159-160) with ${n} hash(es); ends at "${h} not followed by " (Source.idr 335). A single-line string cannot contain a newline (charLexer excludes it), so the rule also ends at the line end; an interpolation may still span lines (verified) because its rule is innermost.`,
      begin: `${h}"`,
      beginCaptures: { 0: { name: s('punctuation.definition.string.begin') } },
      end: `("${h})(?!")|(?=$)`,
      endCaptures: { 1: { name: s('punctuation.definition.string.end') } },
      name: s(`string.quoted.double${raw}`),
      patterns: [inc(`string-interpolation-${n}`), inc(`string-escape-single-${n}`)],
    });
  }
  const over = MAX_DEDICATED_HASHES + 1;
  multi.unshift({
    comment: `Multi-line strings with ${over} or more hashes: correct extent, escapes and interpolation not marked.`,
    begin: `(#{${over},})"""(?=[ \\t\\r\\f\\v\\x{A0}]*$)`,
    beginCaptures: { 0: { name: s('punctuation.definition.string.begin') } },
    end: '"""\\1',
    endCaptures: { 0: { name: s('punctuation.definition.string.end') } },
    name: s('string.quoted.triple.raw'),
  });
  single.unshift({
    comment: `Single-line strings with ${over} or more hashes: correct extent, escapes and interpolation not marked.`,
    begin: `(#{${over},})"`,
    beginCaptures: { 0: { name: s('punctuation.definition.string.begin') } },
    end: '("\\1)(?!")|(?=$)',
    endCaptures: { 1: { name: s('punctuation.definition.string.end') } },
    name: s('string.quoted.double.raw'),
  });
  // multilineBegin precedes stringBegin in rawTokens.
  repo.strings = { patterns: [...multi, ...single] };
}

/** A bracket group: `compose` in rawTokens nests groupSymbols with their groupClose. */
function bracket({ comment, begin, end, beginScope, endScope, name, patterns, recover = true }) {
  return {
    comment,
    begin,
    beginCaptures: { 0: { name: s(beginScope) } },
    end: recover ? `(${end})|${BRACKET_RECOVERY}` : `(${end})`,
    endCaptures: { 1: { name: s(endScope) } },
    name: s(name),
    patterns,
  };
}

/** A declared type name, possibly an operator in parentheses; only the name itself gets `scope`. */
const typeName = (scope) => [
  {
    match: `(\\()\\s*(${OP_RUN}|\\.${IDENT})\\s*(\\))`,
    captures: {
      1: { name: s('punctuation.section.parens.begin') },
      2: { name: s(scope) },
      3: { name: s('punctuation.section.parens.end') },
    },
  },
  { match: IDENT, name: s(scope) },
];

export function buildGrammar() {
  const flat = KEYWORD_GROUPS.flatMap(([, list]) => list);
  const missing = LEXER_KEYWORDS.filter((k) => !flat.includes(k));
  const extra = flat.filter((k) => !LEXER_KEYWORDS.includes(k));
  if (missing.length || extra.length || flat.length !== LEXER_KEYWORDS.length) {
    throw new Error(`KEYWORD_GROUPS does not partition LEXER_KEYWORDS (missing ${missing}, extra ${extra})`);
  }

  const repo = {};

  // --- comments -------------------------------------------------------------------------------

  repo.comments = { patterns: [inc('block-comment'), inc('doc-comment'), inc('line-comment')] };
  repo['block-comment'] = {
    comment: 'blockComment (Common.idr 63-65): "{-" and every following dash open the comment, so a top-level "{-}", "{--}" or "{---}" opens one that is still open after the "}" (verified with a type-error canary after each). Nesting follows the toEndComment automaton (Common.idr 17-61).',
    begin: '\\{-++',
    beginCaptures: { 0: { name: s('punctuation.definition.comment.begin') } },
    end: '-+\\}',
    endCaptures: { 0: { name: s('punctuation.definition.comment.end') } },
    name: s('comment.block'),
    patterns: [
      {
        comment: 'singleBrace/singleDash: inside a comment, "{" + dashes + "}" opens and closes a nested comment (verified: "{-}" and "{--}" inside a comment leave the depth unchanged).',
        match: '\\{-+\\}',
      },
      inc('block-comment'),
      {
        comment: 'toEndComment: a string literal (Lexer.idr stringLit, may span lines) is skipped, so "-}" inside it does not close the comment (verified).',
        begin: '"',
        end: '"',
        patterns: [{ match: '\\\\[\\s\\S]' }],
      },
      {
        comment: 'toEndComment: a char literal is skipped, so \'"\' does not open a string (verified); a lone \' is ordinary text.',
        match: `'(?>\\\\(?>${CHAR_ESCAPE_BODY}|.)|[^'])'`,
      },
      {
        comment: 'doubleDash: "--" not followed (after more dashes) by "}" hides the rest of the line, including any "-}" on it (verified).',
        match: '--(?>-*)(?!\\})[^\\n]*',
      },
    ],
  };
  repo['doc-comment'] = {
    comment: 'docComment (Source.idr 142-143): "|||" at a token start comments the rest of the line; tried before operators, so "x ||| y" is a doc comment (verified), while "|||" inside a longer operator (">|||") is not.',
    match: '(\\|\\|\\|)[^\\n]*',
    name: s('comment.line.documentation'),
    captures: { 1: { name: s('punctuation.definition.comment') } },
  };
  repo['line-comment'] = {
    comment: 'comment (Common.idr 10-15): "--", more dashes, not "}", then the rest of the line. Tried first in rawTokens, so an operator cannot start with "--" (verified: "-->" is a comment); "--}" is not a comment.',
    match: '(--(?>-*))(?!\\})[^\\n]*',
    name: s('comment.line.double-dash'),
    captures: { 1: { name: s('punctuation.definition.comment') } },
  };

  // --- declarations (line-anchored) -----------------------------------------------------------

  const MODIFIERS = String.raw`((?:${words(['public', 'export', 'private', 'total', 'partial', 'covering'])}\s+|%${words(FUNCTION_PRAGMAS)}\s+)*)`;

  repo.declarations = {
    patterns: [
      inc('module-declaration'),
      inc('import-declaration'),
      inc('data-declaration'),
      inc('signature'),
      inc('multiplicity-line'),
      inc('named-implementation'),
      inc('record-constructor'),
    ],
  };
  repo['module-declaration'] = {
    comment: 'progHdr: "module" moduleIdent.',
    match: `(module)${NOT_TRAIL}\\s+(${MODULE_NAME})`,
    captures: {
      1: { name: s('keyword.other.module') },
      2: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
    },
  };
  repo['import-declaration'] = {
    comment: 'import_: "import" ["public"] moduleIdent ["as" namespaceId]; "as" is an identifier the parser decorates as a keyword.',
    match: `(import)${NOT_TRAIL}(?:\\s+(public)${NOT_TRAIL})?\\s+(${MODULE_NAME})(?:\\s+(as)${NOT_TRAIL}\\s+(${MODULE_NAME}))?`,
    captures: {
      1: { name: s('keyword.control.import') },
      2: { name: s('storage.modifier.visibility') },
      3: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
      4: { name: s('keyword.other.as') },
      5: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
    },
  };
  repo['namespace-separator'] = { match: '\\.', name: s('punctuation.separator.namespace') };
  const DATA_BODY = [
    inc('data-type-name-pending'),
    inc('comments'),
    inc('data-constructor-signature'),
    inc('data-constructor-where'),
    inc('data-constructor-simple'),
    inc('expression'),
  ];
  repo['data-declaration'] = {
    comment: 'dataDecl: modifiers, "data", a type name (dataTypeName: capitalised or an operator in parentheses). The region lasts while lines are indented past the line of "data" (blockAfter), so that constructors can be told from functions. The compiler measures from the column of the "data" keyword itself (verified: after "public export data Foo : Type where" a constructor at column 2 is a parse error); such code does not compile, so the line indentation is used. Comments are whitespace to the layout rule, so a line that starts with one does not end the region either (verified: "data Op = Add" / "{-" / "        | Mul" / "-}" / "        | Div", and a column-0 "-- …" line between constructors, check). The region is a begin/end rule, not begin/while: vscode-textmate tests a while condition at every line even inside a nested rule and pops the nested rule with the region, so a block comment reaching column 0 inside the body would end there; an end is tried only while the region is the innermost rule. The end is anchored with CODE_START, never with \\G, which is live right after the begin match ("data Foo=A"). The region also ends before a "]" it did not open, which closes the quote of quoted declarations ("`[" / "  data T = A | B ]" checks); declarations are recognised in no other bracket. A "data" that does not start its line is data-declaration-inline.',
    begin: `${CODE_START}([ \\t]*)${MODIFIERS}(data)${NOT_TRAIL}(?:\\s+(${CAP_WORD}|${PAREN_OP}))?`,
    beginCaptures: {
      2: { patterns: [inc('keywords'), inc('pragma')] },
      3: { name: s('storage.type.data') },
      4: { patterns: typeName('entity.name.type.data') },
    },
    end: String.raw`${CODE_START}(?![ \t]*$|\1[ \t]+\S|[ \t]*(?:--(?>-*)(?!\})|\{-))|(?=\])`,
    name: s('meta.declaration.data'),
    patterns: DATA_BODY,
  };
  repo['data-type-name-pending'] = {
    comment: 'dataDeclBody reads "data" and then the type name with no layout check, and comments are whitespace, so the name may follow a comment or a line break ("data" / "  Rose : Type where", "data -- note" / "  Foo : Type where" and "data {- the type -} Leafy : Type where" check). When the begin of a data declaration ends at "data" itself and only a comment or the line end follows, this region takes the next token, marking it when it is a type name, so that "Tree :" is not read as a constructor signature. It is anchored to the "data" keyword (a lookbehind; \\G alone is also live at the start of every .lidr code line).',
    begin: `(?<!${TRAIL}data)(?<=data)\\G(?=[ \\t]*(?:$|${COMMENT_START}))`,
    end: `(${CAP_WORD}|${PAREN_OP})|(?=\\S)`,
    endCaptures: { 1: { patterns: typeName('entity.name.type.data') } },
    applyEndPatternLast: true,
    patterns: [inc('block-comment'), inc('line-comment')],
  };
  /**
   * Ends a data declaration that does not start its line (data-declaration-inline), where the
   * column of `data` is unknown: at the next line of code that is not indented (and is not a
   * comment), or whose first token begins a declaration and so cannot continue a data body: a
   * declaration-only keyword or pragma, or a claim of a lower-case name (constructors are
   * capitalised or operators, dataConstructorName). Also before a closing bracket, which can
   * only close a group opened outside the region.
   */
  const INLINE_DATA_END = String.raw`${CODE_START}(?:(?![ \t]|$|${COMMENT_START})|(?=[ \t]+(?:${words([
    'data', 'record', 'interface', 'implementation', 'namespace', 'mutual', 'parameters', 'using',
    'failing', 'infixl', 'infixr', 'infix', 'prefix', 'public', 'export', 'private', 'total',
    'partial', 'covering', 'typebind', 'autobind',
  ])}|%${words([...DECLARATION_PRAGMAS, ...FUNCTION_PRAGMAS])}|(?:[01]\s+)?${LOWER_NAME}(?:\s*,\s*${LOWER_NAME})*\s*:${NOT_OP})))|(?=[)\]}])`;
  repo['data-declaration-inline'] = {
    comment: 'A data declaration that follows another token on its line: right after "`[" (quoted declarations), as the first entry of a block opened on the same line by "mutual", "where", "namespace N" or "failing" (with its optional message; all four take a (non)EmptyBlockAfter, so the first entry may follow on the line), or after ";" (verified: "mutual data Ev : Nat -> Type where" with its constructors on the next lines, "where data T : Type where", "namespace N data U : Type where", "failing \\"msg\\" data …", "data P = PA; data Q = QA | QB" and "`[ data Col = Red | Green" / "        total" / "        paint : Col -> Nat" all check). The keyword before "data" keeps its own scope. The body is marked as in data-declaration, but the region ends as INLINE_DATA_END says, because the column of "data" is unknown.',
    begin: `(?:(?<=\`\\[)\\G|(mutual)${NOT_TRAIL}|(namespace)${NOT_TRAIL}\\s+(${MODULE_NAME})|(failing)${NOT_TRAIL}(?:\\s+("(?:[^"\\\\\\n]|\\\\.)*"))?|(where)${NOT_TRAIL}|(?<=;))(\\s*${MODIFIERS}(data)${NOT_TRAIL}(?:\\s+(${CAP_WORD}|${PAREN_OP}))?)`,
    beginCaptures: {
      1: { name: s('keyword.other.mutual') },
      2: { name: s('keyword.other.namespace') },
      3: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
      4: { name: s('keyword.other.failing') },
      5: { patterns: [inc('strings')] },
      6: { name: s('keyword.other.where') },
      // vscode-textmate scopes a capture that has patterns from the rule, not from the capture
      // around it, so 8 and 10 repeat the scope of 7.
      7: { name: s('meta.declaration.data') },
      8: { name: s('meta.declaration.data'), patterns: [inc('keywords'), inc('pragma')] },
      9: { name: s('storage.type.data') },
      10: { name: s('meta.declaration.data'), patterns: typeName('entity.name.type.data') },
    },
    end: INLINE_DATA_END,
    contentName: s('meta.declaration.data'),
    patterns: DATA_BODY,
  };
  repo['data-constructor-signature'] = {
    comment: 'dataBody/tyDecls: "Con1, Con2 : type" in a "where" block; constructor names are capitalised or operators (dataConstructorName).',
    match: `${DECL_START}[ \\t]*((?:${CAP_WORD}|${PAREN_OP})(?:\\s*,\\s*(?:${CAP_WORD}|${PAREN_OP}))*)\\s*(:)${NOT_OP}`,
    captures: {
      1: { patterns: [inc('constructor-name')] },
      2: { name: s('keyword.operator.colon') },
    },
  };
  repo['data-constructor-where'] = {
    comment: 'dataBody: the first constructor may follow "where" on the same line ("data T : Type where MkT : T", verified).',
    match: `(where)${NOT_TRAIL}\\s+((?:${CAP_WORD}|${PAREN_OP})(?:\\s*,\\s*(?:${CAP_WORD}|${PAREN_OP}))*)\\s*(:)${NOT_OP}`,
    captures: {
      1: { name: s('keyword.other.where') },
      2: { patterns: [inc('constructor-name')] },
      3: { name: s('keyword.operator.colon') },
    },
  };
  repo['data-constructor-simple'] = {
    comment: 'simpleData: "=" or "|", an optional doc comment (simpleCon: optDocumentation), then the constructor name, possibly on the next line.',
    begin: `(=|\\|)${NOT_OP}`,
    beginCaptures: { 1: { patterns: [inc('reserved-operators')] } },
    end: `(${CAP_WORD}|${PAREN_OP})|(?=\\S)`,
    endCaptures: { 1: { patterns: [inc('constructor-name')] } },
    applyEndPatternLast: true,
    patterns: [inc('comments')],
  };
  repo['constructor-name'] = {
    patterns: [
      {
        match: `(\\()\\s*(${OP_RUN}|\\.${IDENT})\\s*(\\))`,
        captures: {
          1: { name: s('punctuation.section.parens.begin') },
          2: { name: s('entity.name.function.constructor') },
          3: { name: s('punctuation.section.parens.end') },
        },
      },
      { match: CAP_WORD, name: s('entity.name.function.constructor') },
      { match: ',', name: s('punctuation.separator.comma') },
    ],
  };
  repo.signature = {
    comment: 'localClaim/tyDecls: at the start of a line, modifiers (visOpt: visibility, totality, function pragmas), a multiplicity, then "name1, name2 : type". Names are identifiers or operators in parentheses. Record fields and interface methods are declarations of the same form (fieldDecl, the parser decorates them as functions). A block comment may stand before the colon ("f {- c -} : Nat" checks).',
    match: `${DECL_START}[ \\t]*${MODIFIERS}(?:([01])\\s+)?((?:${NAME}|${PAREN_OP})(?:\\s*,\\s*(?:${NAME}|${PAREN_OP}))*)((?:\\s*${INLINE_BLOCK_COMMENT})*)\\s*(:)${NOT_OP}`,
    captures: {
      1: { patterns: [inc('keywords'), inc('pragma')] },
      2: { name: s('storage.modifier.multiplicity') },
      3: { patterns: [inc('declared-name')] },
      4: { patterns: [inc('comments')] },
      5: { name: s('keyword.operator.colon') },
    },
  };
  repo['multiplicity-line'] = {
    comment: 'A multiplicity alone on a line of code that starts at column 0 ("0" / "Hidden : Type"), before the claim it belongs to (verified: after "0" / "zeroVal : Nat" / "zeroVal = 3", using zeroVal in a clause fails with "not accessible in this context"). Outside brackets a column-0 line starts a new declaration, except after a line that ends in an operator still waiting for its right operand ("x = 2 +" / "1" and "x = the Nat $" / "1" check; "x = S" / "0" and "x = plus 1" / "1" do not parse). A rule cannot see the line before, so such an operand is marked as a multiplicity too; the corpora have no such line, and their one column-0 lone "0" is a multiplicity. An indented one may be an argument on a continuation line, so it stays a number.',
    match: `${CODE_START}([01])(?=[ \\t]*(?:$|${COMMENT_START}))`,
    captures: { 1: { name: s('storage.modifier.multiplicity') } },
  };
  repo['declared-name'] = {
    patterns: [
      {
        match: `(\\()\\s*(${OP_RUN}|\\.${IDENT})\\s*(\\))`,
        captures: {
          1: { name: s('punctuation.section.parens.begin') },
          2: { name: s('entity.name.function') },
          3: { name: s('punctuation.section.parens.end') },
        },
      },
      { match: WORD, name: s('entity.name.function') },
      { match: ',', name: s('punctuation.separator.comma') },
    ],
  };
  repo['named-implementation'] = {
    comment: 'implDecl without the (optional) "implementation" keyword: "[name] Interface args where" at the start of a line. Requiring a following name, constraint or binder and a closing "where" keeps list literals that start a continuation line out.',
    match: `${DECL_START}[ \\t]*${MODIFIERS}(\\[)\\s*(${NAME})\\s*(\\])(?=\\s+[{(A-Z${HIGH}][^\\n]*(?<!${TRAIL})where${NOT_TRAIL}\\s*(?:--[^\\n]*)?$)`,
    captures: {
      1: { patterns: [inc('keywords'), inc('pragma')] },
      2: { name: s('punctuation.section.brackets.begin') },
      3: { name: s('entity.name.function.implementation') },
      4: { name: s('punctuation.section.brackets.end') },
    },
  };
  repo['record-constructor'] = {
    comment: 'recordConstructor: "constructor" (an identifier the parser decorates as a keyword) and a constructor name, alone on the line (atEnd), in a record or interface body.',
    match: `${DECL_START}[ \\t]*(constructor)${NOT_TRAIL}\\s+(${CAP_WORD}|${PAREN_OP})(?=\\s*(?:$|--|\\{-))`,
    captures: {
      1: { name: s('keyword.other.constructor') },
      2: { patterns: [inc('constructor-name')] },
    },
  };

  // --- expressions ----------------------------------------------------------------------------

  repo.expression = {
    comment: 'Token rules in rawTokens order where two can start at the same position.',
    patterns: [
      inc('comments'),
      inc('cg-directive'),
      inc('hole'),
      inc('record-update'),
      inc('brackets'),
      inc('debug-info'),
      inc('punctuation'),
      inc('backtick-operator'),
      inc('multiplicity'),
      inc('numbers'),
      inc('strings'),
      inc('char'),
      inc('projection'),
      inc('qualified-name'),
      inc('declaration-heads'),
      inc('lambda'),
      inc('forall-binders'),
      inc('data-options'),
      inc('keywords'),
      inc('reserved-names'),
      inc('directive-arguments'),
      inc('pragma'),
      inc('identifier'),
      inc('reserved-operators'),
      inc('operator'),
      inc('unmatched-bracket'),
    ],
  };

  repo['cg-directive'] = {
    comment: 'cgDirective (Source.idr 174-181): "%cg", then either a backend name and a braced block, or the rest of the line; one token, tried before other pragmas.',
    patterns: [
      {
        begin: '(%cg)(\\s+)([A-Za-z0-9]+)(\\s*)(\\{)',
        beginCaptures: {
          1: { name: s('keyword.other.directive') },
          3: { name: s('support.constant.backend') },
          5: { name: s('punctuation.section.braces.begin') },
        },
        end: '\\}',
        endCaptures: { 0: { name: s('punctuation.section.braces.end') } },
        contentName: s('string.unquoted.directive'),
      },
      {
        match: '(%cg)(?:(\\s+)([A-Za-z0-9]+))?([^\\n]*)',
        captures: {
          1: { name: s('keyword.other.directive') },
          3: { name: s('support.constant.backend') },
          4: { name: s('string.unquoted.directive') },
        },
      },
    ],
  };
  repo.hole = {
    comment: 'holeIdent (Source.idr 145-146): "?" and an identifier, no keyword check ("?in" is a hole). Tried before operators, so "?x" is a hole but ">?x" is the operator ">?" and x.',
    match: `(\\?)${IDENT}`,
    name: s('variable.other.hole'),
    captures: { 1: { name: s('punctuation.definition.hole') } },
  };

  // Brackets. groupSymbols (Source.idr 218-221) in order; longer symbols first.
  repo['paren-binder'] = {
    comment: 'At the start of "( … )": pibindListName / explicitBind / dpairType / typebind operators bind "name1, name2 : type" with an optional multiplicity; an autobind operator binds "(name <- e)" (opBinderTypes). The parser decorates these names as bound variables.',
    patterns: [
      {
        match: `${PAREN_START}\\s*(?:([01])\\s+)?(${BINDER_LIST})\\s*(:)${NOT_OP}`,
        captures: {
          1: { name: s('storage.modifier.multiplicity') },
          2: { patterns: [inc('binder-name')] },
          3: { name: s('keyword.operator.colon') },
        },
      },
      {
        match: `${PAREN_START}\\s*(${BINDER})\\s*(<-)${NOT_OP}`,
        captures: {
          1: { patterns: [inc('binder-name')] },
          2: { name: s('keyword.operator.arrow.left') },
        },
      },
      {
        comment: 'dpairType / nestedDpair (v0.8.0 src/Idris/Parser.idr 392-417; master names them the same): after "**" a dependent pair may bind again, "name : type ** rest" ("(x : Nat ** y : Nat ** x = y)" checks; decoratedSimpleBinderUName reads the name). The "**" is a whole operator token.',
        match: `(?<![${OP_CLASS}])(\\*\\*)${NOT_OP}\\s*(${NAME})\\s*(:)${NOT_OP}`,
        captures: {
          1: { name: s('keyword.operator.dependent-pair') },
          2: { name: s('variable.parameter') },
          3: { name: s('keyword.operator.colon') },
        },
      },
      {
        comment: 'oldParamDecls (plainBinder) and usingDecls: "parameters (a : A, b : B)" (deprecated: paramDecls parses it withWarning, Parser.idr 1875-1890; 0.8.0 accepts it with that warning, verified) and "using (a : A, n : Nat)" separate "name : type" binders with commas at the top level of the parentheses. No other parenthesised form has a top-level ", name :": a pi binder list is "(a, b : A)", matched above, and "(a : A, b : B) -> T" does not parse (verified).',
        match: `(,)\\s*(${NAME})\\s*(:)${NOT_OP}`,
        captures: {
          1: { name: s('punctuation.separator.comma') },
          2: { name: s('variable.parameter') },
          3: { name: s('keyword.operator.colon') },
        },
      },
    ],
  };
  repo['paren-continuation'] = {
    comment: 'The binder of paren-binder\'s comma form on the line after a comma that ends its line (only a comment may follow): "parameters (f : A -> B," / "            g : C)". The region ends at the first token after the comma that is not a comment, marking it when it is "name :"; a tuple continued on the next line ("(a," / " b)") is left as it was.',
    begin: String.raw`(,)(?=[ \t]*(?:$|${COMMENT_START}))`,
    beginCaptures: { 1: { name: s('punctuation.separator.comma') } },
    end: `(${NAME})\\s*(:)${NOT_OP}|(?=\\S)`,
    endCaptures: {
      1: { name: s('variable.parameter') },
      2: { name: s('keyword.operator.colon') },
    },
    applyEndPatternLast: true,
    patterns: [inc('comments')],
  };
  repo['binder-name'] = {
    patterns: [
      { match: '_', name: s('variable.language.wildcard') },
      { match: '[01](?=\\s)', name: s('storage.modifier.multiplicity') },
      { match: WORD, name: s('variable.parameter') },
      { match: ',', name: s('punctuation.separator.comma') },
    ],
  };
  repo['brace-start'] = {
    comment: 'At the start of "{ … }": an implicit, auto or default binder (implicitPi, autoImplicitPi, defaultImplicitPi, fieldDecl, typedArg), a named argument (braceArgs: "name = e", "name"), or a record update field (field: "path := e", "path $= f").',
    patterns: [
      {
        match: `${BRACE_START}\\s*(auto)${NOT_TRAIL}\\s+(?:([01])\\s+)?(${BINDER_LIST})\\s*(:)${NOT_OP}`,
        captures: {
          1: { name: s('storage.modifier.implicit') },
          2: { name: s('storage.modifier.multiplicity') },
          3: { patterns: [inc('binder-name')] },
          4: { name: s('keyword.operator.colon') },
        },
      },
      {
        comment: 'defaultImplicitPi (Parser.idr 736-750): "default" takes a simpleExpr before the optional multiplicity, so in "{default 0 k : Nat}" the 0 is the default value. DEFAULT_VALUE covers literals, (qualified) names with projections and brackets nested one level deep ("{default [] xs : List Nat}", "{default (replicate n 1) xs : Vect n Nat}").',
        match: `${BRACE_START}\\s*(default)${NOT_TRAIL}\\s+(${DEFAULT_VALUE})(?:(?<=[)\\]"'])\\s*|\\s+)(?:([01])\\s+)?(${BINDER_LIST})\\s*(:)${NOT_OP}`,
        captures: {
          1: { name: s('storage.modifier.implicit') },
          2: { patterns: [inc('expression')] },
          3: { name: s('storage.modifier.multiplicity') },
          4: { patterns: [inc('binder-name')] },
          5: { name: s('keyword.operator.colon') },
        },
      },
      {
        match: `${BRACE_START}\\s*(?:([01])\\s+)?(${BINDER_LIST})\\s*(:)${NOT_OP}`,
        captures: {
          1: { name: s('storage.modifier.multiplicity') },
          2: { patterns: [inc('binder-name')] },
          3: { name: s('keyword.operator.colon') },
        },
      },
    ],
  };
  const FIELD_PATH_CAPTURE = { patterns: [inc('projection'), inc('reserved-operators'), { match: WORD, name: s('variable.other.member') }] };
  /**
   * After a name pun ("{ x }", "{ x, y }"): the next token is "," or "}", or it is on a later line,
   * where puns written one per line ("{ a" / ", b" / "}") put it.
   */
  const PUN_END = String.raw`(?=\s*(?:[,}]|$|${COMMENT_START}))`;
  repo['brace-field'] = {
    comment: 'A named argument or record-update field at the start of "{ … }" or after a comma inside it.',
    patterns: [
      {
        match: `(?:${BRACE_START}|(,))\\s*(${NAME})\\s*(=)${NOT_OP}`,
        captures: {
          1: { name: s('punctuation.separator.comma') },
          2: { name: s('variable.parameter') },
          3: { name: s('keyword.operator.equals') },
        },
      },
      {
        match: `(?:${BRACE_START}|(,))\\s*(${FIELD_PATH})\\s*(:=|\\$=)${NOT_OP}`,
        captures: {
          1: { name: s('punctuation.separator.comma') },
          2: FIELD_PATH_CAPTURE,
          3: { patterns: [inc('reserved-operators')] },
        },
      },
      {
        match: `(?:${BRACE_START}|(,))\\s*(${NAME})${PUN_END}`,
        captures: {
          1: { name: s('punctuation.separator.comma') },
          2: { name: s('variable.parameter') },
        },
      },
    ],
  };
  repo['brace-continuation'] = {
    comment: 'When the "{" of a brace group or a comma inside it ends its line (only a comment may follow), the first token of the next non-blank line may be a named argument or update field, as right after the "{" or the comma on one line (brace-field). The region ends at that token: the field forms are alternatives of the end, so only the first token is examined. The begin is anchored to the "{" itself (BRACE_START) or consumes the comma, so a "{" or "," that ends a line comment ("{n = S -- successor," / "three}") does not start it.',
    begin: String.raw`(?:${BRACE_START}|(,))(?=[ \t]*(?:$|${COMMENT_START}))`,
    beginCaptures: { 1: { name: s('punctuation.separator.comma') } },
    end: `(${NAME})\\s*(=)${NOT_OP}|(${FIELD_PATH})\\s*(:=|\\$=)${NOT_OP}|(${NAME})${PUN_END}|(?=\\S)`,
    endCaptures: {
      1: { name: s('variable.parameter') },
      2: { name: s('keyword.operator.equals') },
      3: FIELD_PATH_CAPTURE,
      4: { patterns: [inc('reserved-operators')] },
      5: { name: s('variable.parameter') },
    },
    applyEndPatternLast: true,
    patterns: [inc('comments')],
  };
  repo.brackets = {
    patterns: [
      bracket({
        comment: 'groupSymbol ".(": a namespace-qualified operator (Prelude.(+)) or a dotted (inaccessible) term.',
        begin: '\\.\\(', end: '\\)', beginScope: 'punctuation.section.parens.begin', endScope: 'punctuation.section.parens.end',
        name: 'meta.parens', patterns: [inc('comments'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbols ".[|" and "[|": idiom brackets, closed by "|]".',
        begin: '\\.?\\[\\|', end: '\\|\\]', beginScope: 'punctuation.section.idiom.begin', endScope: 'punctuation.section.idiom.end',
        name: 'meta.idiom', patterns: [inc('comments'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbol "@{": an auto-implicit argument.',
        begin: '@\\{', end: '\\}', beginScope: 'punctuation.section.braces.begin', endScope: 'punctuation.section.braces.end',
        name: 'meta.braces', patterns: [inc('comments'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbol "`(": a quoted term.',
        begin: '`\\(', end: '\\)', beginScope: 'punctuation.section.quote.begin', endScope: 'punctuation.section.quote.end',
        name: 'meta.quote', patterns: [inc('comments'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbol "`{": a quoted name.',
        begin: '`\\{', end: '\\}', beginScope: 'punctuation.section.quote.begin', endScope: 'punctuation.section.quote.end',
        name: 'meta.quote', patterns: [inc('comments'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbol "`[": quoted declarations (nonEmptyBlock topDecl), which may start at any column, so no recovery.',
        begin: '`\\[', end: '\\]', beginScope: 'punctuation.section.quote.begin', endScope: 'punctuation.section.quote.end',
        name: 'meta.quote', patterns: [inc('comments'), inc('declarations'), inc('expression')], recover: false,
      }),
      bracket({
        comment: 'groupSymbol "[<": a snoc list.',
        begin: '\\[<', end: '\\]', beginScope: 'punctuation.section.brackets.begin', endScope: 'punctuation.section.brackets.end',
        name: 'meta.brackets', patterns: [inc('comments'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbols "[>" and "[": a list (listExpr accepts both openers).',
        begin: '\\[>?', end: '\\]', beginScope: 'punctuation.section.brackets.begin', endScope: 'punctuation.section.brackets.end',
        name: 'meta.brackets', patterns: [inc('comments'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbol "(".',
        begin: '\\(', end: '\\)', beginScope: 'punctuation.section.parens.begin', endScope: 'punctuation.section.parens.end',
        name: 'meta.parens', patterns: [inc('paren-continuation'), inc('comments'), inc('paren-binder'), inc('expression')],
      }),
      bracket({
        comment: 'groupSymbol "{" (a block comment "{-" is matched first).',
        begin: '\\{', end: '\\}', beginScope: 'punctuation.section.braces.begin', endScope: 'punctuation.section.braces.end',
        name: 'meta.braces', patterns: [inc('brace-continuation'), inc('comments'), inc('brace-start'), inc('brace-field'), inc('expression')],
      }),
    ],
  };
  repo['record-update'] = {
    comment: 'record_ and field (Parser.idr 899-944) with the keyword: the deprecated update "record { path = e, path $= f } r". A field (field with kw = True) is a name, then ".name" projections or Idris 1\'s "->name", then "=" or "$=" (verified: "record { a = 1, b $= S } r" and "record { p->a = 2 } q" check with a deprecation warning). A block comment may stand between "record" and "{" ("record {- c -} { a = 1 } r" checks); the "{" of "{-" opens that comment, not the update.',
    begin: `(record)${NOT_TRAIL}((?:\\s*${INLINE_BLOCK_COMMENT})*)\\s*(\\{)(?!-)`,
    beginCaptures: {
      1: { name: s('storage.type.record') },
      2: { patterns: [inc('comments')] },
      3: { name: s('punctuation.section.braces.begin') },
    },
    end: `(\\})|${BRACKET_RECOVERY}`,
    endCaptures: { 1: { name: s('punctuation.section.braces.end') } },
    name: s('meta.braces'),
    patterns: [
      inc('comments'),
      {
        match: `(?:${BRACE_START}|(,))\\s*(${FIELD_PATH})\\s*(=|\\$=)${NOT_OP}`,
        captures: {
          1: { name: s('punctuation.separator.comma') },
          2: { patterns: [inc('projection'), inc('reserved-operators'), { match: WORD, name: s('variable.other.member') }] },
          3: { patterns: [inc('reserved-operators')] },
        },
      },
      inc('expression'),
    ],
  };
  repo['unmatched-bracket'] = {
    comment: 'A closing bracket with no open group: the lexer produces an Unrecognised token (the `symbol` fallback) and the parse fails.',
    match: '[)\\]}]',
    name: s('invalid.illegal.unmatched-bracket'),
  };
  repo['debug-info'] = {
    comment: 'debugInfo (Source.idr 204-207): magic constants, tried before the symbol "_".',
    match: '__(?:LOC|FILE|LINE|COL)__',
    name: s('constant.language.debug-info'),
  };
  repo.punctuation = {
    comment: 'symbols (Source.idr 214-215): ",", ";", "_" and "`"; "_" is tried before identifiers, so "_x" is "_" then "x".',
    patterns: [
      { match: ',', name: s('punctuation.separator.comma') },
      { match: ';', name: s('punctuation.separator.semicolon') },
      { match: '_', name: s('variable.language.wildcard') },
    ],
  };
  repo['backtick-operator'] = {
    comment: 'iOperator (Parser.idr 175-178): symbol "`", a name, symbol "`" is an infix operator; the name may be qualified or an operator in parentheses (`Prelude.(<*>)`, found by the lexer comparison on the corpus). The backtick is a token of its own (symbols), so spaces may separate the three ("10 ` div ` 2" checks). A backtick followed by "(", "{" or "[" is the group symbol "`(", "`{" or "`[" (groupSymbols are tried before symbols), not a closing backtick: "10 `div`(2)" is a quote after "`div" and does not parse (verified).',
    match: `(\`)\\s*((?:${CAP_WORD}\\.)*(?:${IDENT}|${PAREN_OP}))\\s*(\`)(?![({\\[])`,
    name: s('keyword.operator.infix'),
    captures: {
      1: { name: s('punctuation.definition.infix.begin') },
      2: { patterns: [inc('qualified-name'), inc('brackets')] },
      3: { name: s('punctuation.definition.infix.end') },
    },
  };
  repo.multiplicity = {
    comment: 'multiplicity (Parser.idr 647-653): an integer literal 0 or 1 before a bound name, which the parser decorates as a keyword. Before the number rules. Binders at the start of a bracket and in a lambda have their own rules (paren-binder, brace-start, lambda); signatures at the start of a line too.',
    patterns: [
      {
        comment: 'letBinder: "let 1 x = e".',
        match: `(let)${NOT_TRAIL}\\s+([01])(?=\\s+[A-Za-z_${HIGH}(\\[{])`,
        captures: { 1: { name: s('keyword.control.let') }, 2: { name: s('storage.modifier.multiplicity') } },
      },
      {
        comment: 'withProblem (v0.8.0 src/Idris/Parser.idr 1231-1239): "proof", a multiplicity, then the name it binds (decoratedSimpleBinderUName; "h x with (x) proof eq" checks).',
        match: `(proof)${NOT_TRAIL}(?:\\s+([01]))?\\s+(${NAME})`,
        captures: {
          1: { name: s('keyword.control.with') },
          2: { name: s('storage.modifier.multiplicity') },
          3: { name: s('variable.parameter') },
        },
      },
      {
        comment: 'withProblem: "with 0 (e)" and "proof 1 p".',
        match: `(with|proof)${NOT_TRAIL}\\s+([01])(?=\\s)`,
        captures: { 1: { name: s('keyword.control.with') }, 2: { name: s('storage.modifier.multiplicity') } },
      },
      {
        comment: 'doAct: "do 1 x <- e".',
        match: `(do)${NOT_TRAIL}\\s+([01])\\s+(?=${BINDER_LIST}\\s*(?::|<-)${NOT_OP})`,
        captures: { 1: { name: s('keyword.control.do') }, 2: { name: s('storage.modifier.multiplicity') } },
      },
      {
        comment: 'localClaim, fieldBody, doAct: "0 x, y : t" and "1 x <- e" where a statement starts: at the start of a line, or after "(", "{" or ";". Elsewhere the same tokens can be an expression: "[(x, y) | z <- range 1 top, y <- range 1 z]" is not a binding of top.',
        match: `(?:${CODE_START}|(?<=[({;]))\\s*([01])\\s+(?=${BINDER_LIST}\\s*(?::|<-)${NOT_OP})`,
        captures: { 1: { name: s('storage.modifier.multiplicity') } },
      },
    ],
  };
  repo.numbers = {
    comment: 'rawTokens: doubleLit, then binary, hexadecimal ("0x" or "0X"), octal and decimal integers with "_" between digit groups (Lexer.idr 383-397). No other forms: "1.0E5" is 1.0 then E5, "0B1" is 0 then B1, "0x_FF" is 0 then x_FF (verified). The precedence of a fixity declaration is any of these integers (fixDecl takes an intLit; "infixl 0x5 +++" declares precedence 5, verified), so it has no rule of its own.',
    patterns: [
      { match: '[0-9]+\\.[0-9]+(?:e[-+]?[0-9]+)?', name: s('constant.numeric.float') },
      { match: '0b[01]+(?:_[01]+)*', name: s('constant.numeric.integer.binary') },
      { match: '0[xX][0-9A-Fa-f]+(?:_[0-9A-Fa-f]+)*', name: s('constant.numeric.integer.hexadecimal') },
      { match: '0o[0-7]+(?:_[0-7]+)*', name: s('constant.numeric.integer.octal') },
      { match: '[0-9]+(?:_[0-9]+)*', name: s('constant.numeric.integer.decimal') },
    ],
  };
  stringRules(repo);
  repo.char = {
    comment: 'charLit (Lexer.idr 341-357): a quote, an escape or any other character, a quote. Atomic like the PEG: "\'\\\\\'x" is not a char literal. Identifiers absorb primes first, so "x\'" is an identifier.',
    match: `(')((?>\\\\(?>${CHAR_ESCAPE_BODY}|.)|[^']))(')`,
    name: s('constant.character'),
    captures: {
      1: { name: s('punctuation.definition.character.begin') },
      2: { patterns: [{ match: `\\\\(?:${CHAR_ESCAPE_BODY}|.)`, name: s('constant.character.escape') }] },
      3: { name: s('punctuation.definition.character.end') },
    },
  };
  repo.projection = {
    comment: 'dotIdent (Source.idr 148-149): "." and an identifier is a postfix field projection (x.fst, (.fst), p .fst); a spaced "." is the operator. Qualified names are matched from their first part, so "Foo.bar" never reaches this rule.',
    match: `(\\.)(${IDENT})`,
    captures: {
      1: { name: s('punctuation.accessor') },
      2: { name: s('variable.other.member') },
    },
  };
  repo['qualified-name'] = {
    comment: 'namespacedIdent (Common.idr 109-114): capitalised parts separated by dots, optionally ending in a part of any case. Before ".(" or ".[|" every part is the namespace (Prelude.(+)). A qualified "do" (M.do) is a do block (doBlock).',
    patterns: [
      {
        match: `(${CAP_WORD}(?:\\.${CAP_PART})*)(?=\\.\\(|\\.\\[\\|)`,
        captures: { 1: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] } },
      },
      {
        comment: 'fixityNS (src/Parser/Rule/Source.idr 424-439, the argument of %hide): a namespace, a fixity keyword and ".(" hide a fixity ("%hide Prelude.Ops.infixl.(+)"). The lexer reads "Prelude.Ops.infixl" as one DotSepIdent, and the parser gives its last part the fixity meaning.',
        match: `(${MODULE_NAME})(\\.)(infixl|infixr|infix|prefix)(?=\\.\\()`,
        captures: {
          1: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
          2: { name: s('punctuation.separator.namespace') },
          3: { name: s('keyword.other.fixity') },
        },
      },
      {
        match: `(${CAP_WORD}(?:\\.${CAP_PART}(?=\\.))*)(\\.)(?:(do)${NOT_TRAIL}|${IDENT})`,
        captures: {
          1: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
          2: { name: s('punctuation.separator.namespace') },
          3: { name: s('keyword.control.do') },
        },
      },
    ],
  };
  repo['declaration-heads'] = {
    comment: 'Names introduced by keywords anywhere on a line.',
    patterns: [
      inc('data-declaration-inline'),
      {
        comment: 'A claim that follows, on the same line, a keyword whose block may start there: "where" ("f x = go x where go : Nat -> Nat", "interface Nice a where nice : a -> a", "where 0 E : Type"), "mutual", "namespace N" and "failing" with its optional message ("failing \\"Mismatch\\" bad2 : Nat"); all verified. It is the block\'s first declaration, a signature as at the start of a line.',
        match: `(?:(where)${NOT_TRAIL}|(mutual)${NOT_TRAIL}|(namespace)${NOT_TRAIL}\\s+(${MODULE_NAME})|(failing)${NOT_TRAIL}(?:\\s+("(?:[^"\\\\\\n]|\\\\.)*"))?)\\s+${MODIFIERS}(?:([01])\\s+)?((?:${NAME}|${PAREN_OP})(?:\\s*,\\s*(?:${NAME}|${PAREN_OP}))*)((?:\\s*${INLINE_BLOCK_COMMENT})*)\\s*(:)${NOT_OP}`,
        captures: {
          1: { name: s('keyword.other.where') },
          2: { name: s('keyword.other.mutual') },
          3: { name: s('keyword.other.namespace') },
          4: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
          5: { name: s('keyword.other.failing') },
          6: { patterns: [inc('strings')] },
          7: { patterns: [inc('keywords'), inc('pragma')] },
          8: { name: s('storage.modifier.multiplicity') },
          9: { patterns: [inc('declared-name')] },
          10: { patterns: [inc('comments')] },
          11: { name: s('keyword.operator.colon') },
        },
      },
      {
        comment: 'recordDecl: "record" and the type name (the deprecated update syntax "record { … }" has no name), possibly after a block comment ("record {- c -} Point where" checks).',
        match: `(record)${NOT_TRAIL}((?:\\s*${INLINE_BLOCK_COMMENT})*)\\s*(${CAP_WORD}|${PAREN_OP})`,
        captures: {
          1: { name: s('storage.type.record') },
          2: { patterns: [inc('comments')] },
          3: { patterns: typeName('entity.name.type.record') },
        },
      },
      {
        comment: 'ifaceDecl: "interface", constraints ending in "=>", then the interface name; a block comment may stand after "interface" ("interface {- c -} Sho a where" checks).',
        match: `(interface)${NOT_TRAIL}((?:\\s*${INLINE_BLOCK_COMMENT})*)\\s*((?:(?:(?!(?<!${TRAIL})where${NOT_TRAIL}|=>).)*=>\\s*)*)(${NAME}|${PAREN_OP})`,
        captures: {
          1: { name: s('storage.type.interface') },
          2: { patterns: [inc('comments')] },
          3: { patterns: [inc('expression')] },
          4: { patterns: typeName('entity.name.type.interface') },
        },
      },
      {
        comment: 'implDecl: "implementation" with an optional "[name]" for a named implementation.',
        match: `(implementation)${NOT_TRAIL}(?:\\s*(\\[)\\s*(${NAME})\\s*(\\]))?`,
        captures: {
          1: { name: s('storage.type.implementation') },
          2: { name: s('punctuation.section.brackets.begin') },
          3: { name: s('entity.name.function.implementation') },
          4: { name: s('punctuation.section.brackets.end') },
        },
      },
      {
        comment: 'namespaceHead: "namespace" namespaceId; a block comment may stand between them ("namespace {- c -} NS" checks).',
        match: `(namespace)${NOT_TRAIL}((?:\\s*${INLINE_BLOCK_COMMENT})*)\\s*(${MODULE_NAME})`,
        captures: {
          1: { name: s('keyword.other.namespace') },
          2: { patterns: [inc('comments')] },
          3: { name: s('entity.name.namespace'), patterns: [inc('namespace-separator')] },
        },
      },
    ],
  };
  repo.lambda = {
    comment: 'lam (Parser.idr 783-827): "\\case" (a lambda over a case block) and "\\binders => e"; the implicit form "\\{x} =>" is master only (0.8.0 rejects it, verified) and is highlighted by the brace rules.',
    patterns: [
      {
        match: `(\\\\)(case)${NOT_TRAIL}`,
        captures: { 1: { name: s('keyword.operator.lambda') }, 2: { name: s('keyword.control.case') } },
      },
      {
        comment: 'bindList (Parser.idr 655-676; 0.8.0 lacks its braced implicit form): binders separated by commas, each a multiplicity, a pattern (simpleExpr) and an optional ": type" ("\\x : T, (a, b), 1 z => e"). A plain name followed by ":", "," or "=>" is marked as lambda-binder-name decides; other patterns are left to the expression rules. The region ends at the "=>", which it leaves to reserved-operators, at the end of the line, so an unfinished lambda does not run on, or before a closing bracket, which can only close a group opened outside the region (while "map (\\) xs" is being typed, the ")" still closes the parenthesis). A comma at this level separates binders (a comma inside a pattern or a type is inside a bracket). A "\\" followed by another operator character is part of an operator token ("xs \\\\ ys": validSymbol reads the whole run), not a lambda.',
        begin: `(\\\\)${NOT_OP}`,
        beginCaptures: { 1: { name: s('keyword.operator.lambda') } },
        end: `(?==>${NOT_OP}|[)\\]}]|\\|\\])|$`,
        patterns: [
          {
            match: `(?:(?<=\\\\)\\G|(,))\\s*(?:([01])\\s+)?(${BINDER})(?=\\s*(?::${NOT_OP}|,|=>${NOT_OP}))`,
            captures: {
              1: { name: s('punctuation.separator.comma') },
              2: { name: s('storage.modifier.multiplicity') },
              3: { patterns: [inc('lambda-binder-name')] },
            },
          },
          {
            comment: 'multiplicity: "0" or "1" before a binder that is a pattern ("\\1 (a, b) => …").',
            match: `(?:(?<=\\\\)\\G|(,))\\s*([01])(?=\\s)`,
            captures: {
              1: { name: s('punctuation.separator.comma') },
              2: { name: s('storage.modifier.multiplicity') },
            },
          },
          inc('expression'),
        ],
      },
    ],
  };
  repo['lambda-binder-name'] = {
    comment: 'A plain name as a lambda binder. The desugarer binds it only when isPatternVariable holds (src/Idris/Desugar.idr 337, src/Core/Name.idr 111-114): the name is "_" or starts with a letter for which the Prelude\'s isLower (ASCII a-z only) holds. Any other name is a reference to match on: "\\Refl => Refl" matches the constructor, and "\\X => X", "\\X : Nat => X" and "\\α => α" fail with "Undefined name" (verified), so such names get no scope, like constructors in clause patterns.',
    patterns: [
      { match: '_', name: s('variable.language.wildcard') },
      { match: `[a-z]${TRAIL}*`, name: s('variable.parameter') },
      { match: WORD },
    ],
  };
  repo['forall-binders'] = {
    comment: 'forall_: "forall a, b ." binds names.',
    match: `(forall)${NOT_TRAIL}\\s+(${NAME}(?:\\s*,\\s*${NAME})*)(?=\\s*\\.(?![${OP_CLASS}A-Za-z_${HIGH}]))`,
    captures: {
      1: { name: s('keyword.other.forall') },
      2: { patterns: [inc('binder-name')] },
    },
  };
  repo['data-options'] = {
    comment: 'dataBody and recordBody: "where", then dataOpts, an optional "[noHints, uniqueSearch, search x, external, noNewtype]" (identifiers the parser decorates as keywords). They are separate tokens, so comments, blank lines and a line break may come between "where" and "[" (Idris 2 0.8.0 libs/prelude/Builtin.idr: "data Equal … where" / "     [search a b]"; verified: options on the next line of a data and of a record body, and after a line comment, a comment line, a blank line and a block comment in a data body). The region begins at a "where" that is followed on its line by the options or by nothing but a comment, and ends after the "]", at a line that starts with anything but a comment or the options (at column 0, so that the rules anchored at the start of a line still apply), or at any other token (applyEndPatternLast lets comments and the options go first).',
    begin: `(where)${NOT_TRAIL}(?=[ \\t]*(?:$|${COMMENT_START}|\\[\\s*${DATA_OPTION}))`,
    beginCaptures: { 1: { name: s('keyword.other.where') } },
    end: `(?<=\\])|${CODE_START}(?![ \\t]*(?:$|${COMMENT_START}|\\[\\s*${DATA_OPTION}))|(?=\\S)`,
    applyEndPatternLast: true,
    patterns: [
      // Not doc comments: they are tokens, not whitespace, and a column-0 "|||" must end the region.
      inc('block-comment'),
      inc('line-comment'),
      {
        begin: `\\[(?=\\s*${DATA_OPTION})`,
        beginCaptures: { 0: { name: s('punctuation.section.brackets.begin') } },
        end: '\\]',
        endCaptures: { 0: { name: s('punctuation.section.brackets.end') } },
        patterns: [
          inc('comments'),
          { match: DATA_OPTION, name: s('keyword.other.data-option') },
          inc('expression'),
        ],
      },
    ],
  };
  repo.keywords = { patterns: keywordRules() };
  repo['reserved-names'] = {
    comment: 'reservedNames (src/Parser/Rule/Source.idr).',
    patterns: [
      { match: words(PRIMITIVE_TYPES), name: s('support.type.primitive') },
      { match: words(DELAY_TYPES), name: s('support.type') },
      { match: words(DELAY_FUNCTIONS), name: s('support.function') },
    ],
  };
  repo['directive-arguments'] = {
    comment: 'Identifier arguments that the parser gives a meaning (directive in Parser.idr 1458-1573).',
    patterns: [
      {
        match: `(%(?:auto_lazy|unbound_implicits|prefix_record_projections))${NOT_TRAIL}\\s+(on|off)${NOT_TRAIL}`,
        captures: { 1: { name: s('keyword.other.directive') }, 2: { name: s('constant.language') } },
      },
      {
        match: `(%logging)${NOT_TRAIL}\\s+(off)${NOT_TRAIL}`,
        captures: { 1: { name: s('keyword.other.directive') }, 2: { name: s('constant.language') } },
      },
      {
        comment: 'extension: ElabReflection; v0.8.0 also accepts Borrowing (removed on master).',
        match: `(%language)${NOT_TRAIL}\\s+(ElabReflection|Borrowing)${NOT_TRAIL}`,
        captures: { 1: { name: s('keyword.other.directive') }, 2: { name: s('support.constant.extension') } },
      },
      {
        comment: 'builtinType.',
        match: `(%builtin)${NOT_TRAIL}\\s+(Natural|NaturalToInteger|IntegerToNatural)${NOT_TRAIL}`,
        captures: { 1: { name: s('keyword.other.directive') }, 2: { name: s('support.constant.builtin') } },
      },
    ],
  };
  repo.pragma = {
    comment: 'pragma (Source.idr 151-152): "%" and an identifier. The parser accepts the names in KNOWN_PRAGMAS; %World and %MkWorld are the primitive world type and value (atom). Any other name is still one token but a parse error, and is left without a keyword scope.',
    patterns: [
      { match: `%World${NOT_TRAIL}`, name: s('support.type.primitive') },
      { match: `%MkWorld${NOT_TRAIL}`, name: s('support.constant') },
      { match: `%${words(KNOWN_PRAGMAS)}`, name: s('keyword.other.directive') },
      { match: `%${IDENT}`, name: s('meta.directive.unknown') },
    ],
  };
  repo.identifier = {
    comment: 'identNormal / namespacedIdent without a dot: consumed whole so that nothing is found inside it.',
    match: WORD,
  };
  repo['reserved-operators'] = {
    comment: 'reservedInfixSymbols as whole operator tokens.',
    patterns: [...groupBy(RESERVED_OPERATORS).map(([scope, syms]) => ({
      match: `(?:${syms.map(escapeRegex).join('|')})${NOT_OP}`,
      name: s(scope),
    }))],
  };
  repo.operator = {
    comment: 'validSymbol (Source.idr 239-240): a maximal run of operator characters.',
    match: OP_RUN,
    name: s('keyword.operator'),
  };

  return {
    name: 'Idris 2',
    scopeName: 'source.idris2',
    comment: 'Generated by scripts/build-grammar.mjs from syntaxes/src/idris2.grammar.mjs; edit that file, not this one.',
    patterns: [inc('comments'), inc('declarations'), inc('expression')],
    repository: repo,
  };
}

/** [[scope, [sym…]]…] preserving first-appearance order. */
function groupBy(pairs) {
  const out = [];
  for (const [sym, scope] of pairs) {
    const hit = out.find(([sc]) => sc === scope);
    if (hit) {
      hit[1].push(sym);
    } else {
      out.push([scope, [sym]]);
    }
  }
  return out;
}
