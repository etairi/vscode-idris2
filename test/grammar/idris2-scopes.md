# `source.idris2` scope inventory

Every scope that `syntaxes/idris2.tmLanguage.json` can assign, with what it marks. The grammar is
generated from `syntaxes/src/idris2.grammar.mjs`, whose rules cite the Idris 2 lexer and parser
they reproduce (master `1c630e6` and v0.8.0 `15a3e4e`, which agree on every lexical rule used).
`test/grammar/idris2.test.ts` checks that the table below lists exactly the scopes the grammar
emits. All scopes end in `.idris2`; themes match them by prefix (`keyword.control`,
`entity.name.function`, …).

## Scopes

| Scope | Marks | Example |
|---|---|---|
| `comment.line.double-dash.idris2` | line comment | `-- note`, `-->` |
| `comment.line.documentation.idris2` | documentation comment | `\|\|\| Docs.` |
| `comment.block.idris2` | block comment, nested | `{- {- -} -}` |
| `punctuation.definition.comment.idris2` | `--` and `\|\|\|` | |
| `punctuation.definition.comment.begin.idris2` | `{-` | |
| `punctuation.definition.comment.end.idris2` | `-}` | |
| `keyword.control.conditional.idris2` | `if` `then` `else` | |
| `keyword.control.case.idris2` | `case` `of`, and `case` in `\case` | |
| `keyword.control.do.idris2` | `do`, also qualified `M.do` | |
| `keyword.control.let.idris2` | `let` `in` | |
| `keyword.control.with.idris2` | `with` `proof` | |
| `keyword.control.rewrite.idris2` | `rewrite` | |
| `keyword.control.impossible.idris2` | `impossible` | |
| `keyword.control.import.idris2` | `import` | |
| `keyword.other.module.idris2` | `module` | |
| `keyword.other.where.idris2` | `where` | |
| `keyword.other.namespace.idris2` | `namespace` | |
| `keyword.other.parameters.idris2` | `parameters` | |
| `keyword.other.mutual.idris2` | `mutual` | |
| `keyword.other.using.idris2` | `using` | |
| `keyword.other.failing.idris2` | `failing` | |
| `keyword.other.forall.idris2` | `forall` | |
| `keyword.other.fixity.idris2` | `infixl` `infixr` `infix` `prefix`, also before `.(` in `%hide` | `%hide Prelude.Ops.infixl.(+)` |
| `keyword.other.reserved.idris2` | `open` `implicit` (reserved words no parser rule uses) | |
| `keyword.other.as.idris2` | `as` in `import M as N` | |
| `keyword.other.constructor.idris2` | `constructor` in a record or interface body | |
| `keyword.other.data-option.idris2` | `noHints` `uniqueSearch` `search` `external` `noNewtype` in the `[ … ]` that follows `where` in a data or record declaration, on the same or a later line | `where [search n]` |
| `keyword.other.directive.idris2` | a pragma the parser accepts | `%default`, `%inline`, `%cg` |
| `meta.directive.unknown.idris2` | any other `%name` (one token, a parse error) | `%defualt` |
| `storage.type.data.idris2` | `data` | |
| `storage.type.record.idris2` | `record` | |
| `storage.type.interface.idris2` | `interface` | |
| `storage.type.implementation.idris2` | `implementation` | |
| `storage.modifier.visibility.idris2` | `public` `export` `private` | |
| `storage.modifier.totality.idris2` | `total` `partial` `covering` | |
| `storage.modifier.implicit.idris2` | `auto` `default` | `{auto p : P}` |
| `storage.modifier.binding.idris2` | `typebind` `autobind` | |
| `storage.modifier.multiplicity.idris2` | `0` / `1` before a bound name, or alone on a column-0 line before a claim | `(0 x : A)`, `let 1 k = n`, `\0 x =>`, `0 T : Type` |
| `keyword.operator.idris2` | any other operator | `+`, `::`, `<$>`, `>--` |
| `keyword.operator.arrow.idris2` | `->` | |
| `keyword.operator.arrow.double.idris2` | `=>` | |
| `keyword.operator.arrow.left.idris2` | `<-` | |
| `keyword.operator.assignment.idris2` | `:=` | |
| `keyword.operator.assignment.apply.idris2` | `$=` | |
| `keyword.operator.colon.idris2` | `:` | |
| `keyword.operator.equals.idris2` | `=` | |
| `keyword.operator.pipe.idris2` | `\|` | |
| `keyword.operator.dependent-pair.idris2` | `**` | |
| `keyword.operator.range.idris2` | `..` | |
| `keyword.operator.lambda.idris2` | `\` | |
| `keyword.operator.infer.idris2` | `?` on its own | `x : ?` |
| `keyword.operator.bang.idris2` | `!` | `!(pure 1)` |
| `keyword.operator.as-pattern.idris2` | `@` | `all@(x :: _)` |
| `keyword.operator.unquote.idris2` | `~` | `` `(~t) `` |
| `keyword.operator.reserved.idris2` | `&` `%` on their own (reserved, unused) | |
| `keyword.operator.infix.idris2` | a name used infix | `` `div` `` |
| `punctuation.definition.infix.begin.idris2` | opening backtick | |
| `punctuation.definition.infix.end.idris2` | closing backtick | |
| `entity.name.namespace.idris2` | module, import and namespace names; qualifiers | `Data.Vect`, `Prelude.(+)` |
| `punctuation.separator.namespace.idris2` | `.` in a qualified or module name | |
| `entity.name.type.data.idris2` | the type declared by `data` | |
| `entity.name.type.record.idris2` | the type declared by `record` | |
| `entity.name.type.interface.idris2` | the interface declared by `interface` | |
| `entity.name.function.idris2` | a name declared by a signature (functions, record fields, interface methods) | `map : …` |
| `entity.name.function.constructor.idris2` | a data constructor in a `data` declaration or after `constructor` | `MkPoint`, `(::)` |
| `entity.name.function.implementation.idris2` | a named implementation | `[rev] Ord Nat where` |
| `variable.parameter.idris2` | a bound name in a binder (also after `**` in a dependent pair and after `proof`), lambda or `forall`; a named argument or name pun | `(x : A)`, `(x : A ** y : B x)`, `proof eq`, `\x =>`, `\x : A =>`, `{n = 3}`, `{ n }` |
| `variable.other.member.idris2` | a field in a projection or record update | `p.x`, `{ x := 1 }`, `record { x = 1 }` |
| `variable.other.hole.idris2` | a hole | `?rhs` |
| `punctuation.definition.hole.idris2` | the `?` of a hole | |
| `variable.language.wildcard.idris2` | `_` | |
| `support.type.primitive.idris2` | reserved type names and `%World` | `Type`, `Int`, `String`, `Bits8` |
| `support.type.idris2` | `Lazy` `Inf` | |
| `support.function.idris2` | `Delay` `Force` | |
| `support.constant.idris2` | `%MkWorld` | |
| `support.constant.extension.idris2` | a language extension | `%language ElabReflection` |
| `support.constant.builtin.idris2` | a builtin kind | `%builtin Natural T` |
| `support.constant.backend.idris2` | the backend of a `%cg` directive | `%cg chez …` |
| `string.unquoted.directive.idris2` | the rest of a `%cg` directive | |
| `constant.language.idris2` | `on` / `off` directive arguments | `%auto_lazy on` |
| `constant.language.debug-info.idris2` | `__LOC__` `__FILE__` `__LINE__` `__COL__` | |
| `constant.numeric.integer.decimal.idris2` | decimal integer | `1_000` |
| `constant.numeric.integer.hexadecimal.idris2` | hexadecimal integer | `0xFF_FF`, `0XAB` |
| `constant.numeric.integer.octal.idris2` | octal integer | `0o755` |
| `constant.numeric.integer.binary.idris2` | binary integer | `0b1010_0101` |
| `constant.numeric.float.idris2` | double | `1.5e-3` |
| `constant.character.idris2` | char literal | `'a'` |
| `punctuation.definition.character.begin.idris2` | opening `'` | |
| `punctuation.definition.character.end.idris2` | closing `'` | |
| `constant.character.escape.idris2` | escape in a char or string | `\n`, `\x41`, `\SOH`, `\#n` |
| `string.quoted.double.idris2` | string | `"…"` |
| `string.quoted.double.raw.idris2` | string with hashes | `#"…"#` |
| `string.quoted.triple.idris2` | multi-line string | `"""` … `"""` |
| `string.quoted.triple.raw.idris2` | multi-line string with hashes | `#"""` … `"""#` |
| `punctuation.definition.string.begin.idris2` | opening delimiter | |
| `punctuation.definition.string.end.idris2` | closing delimiter | |
| `meta.interpolation.idris2` | an interpolation with its delimiters | `\{x}`, `\#{x}` |
| `meta.embedded.line.idris2` | the code inside an interpolation (resets string colouring) | |
| `punctuation.section.embedded.begin.idris2` | `\{` `\#{` … | |
| `punctuation.section.embedded.end.idris2` | `}` closing an interpolation | |
| `meta.parens.idris2` | `( … )` and `.( … )` | |
| `meta.brackets.idris2` | `[ … ]`, `[< … ]`, `[> … ]` | |
| `meta.braces.idris2` | `{ … }` and `@{ … }`; `record { … }` (the deprecated update, keyword and any comment before the `{` included) | |
| `meta.idiom.idris2` | `[\| … \|]` and `.[\| … \|]` | |
| `meta.quote.idris2` | `` `( … ) ``, `` `{ … } ``, `` `[ … ] `` | |
| `punctuation.section.parens.begin.idris2` | `(` `.(` | |
| `punctuation.section.parens.end.idris2` | `)` | |
| `punctuation.section.brackets.begin.idris2` | `[` `[<` `[>` | |
| `punctuation.section.brackets.end.idris2` | `]` | |
| `punctuation.section.braces.begin.idris2` | `{` `@{` | |
| `punctuation.section.braces.end.idris2` | `}` | |
| `punctuation.section.idiom.begin.idris2` | `[\|` `.[\|` | |
| `punctuation.section.idiom.end.idris2` | `\|]` | |
| `punctuation.section.quote.begin.idris2` | `` `( `` `` `{ `` `` `[ `` | |
| `punctuation.section.quote.end.idris2` | the matching closer | |
| `punctuation.separator.comma.idris2` | `,` | |
| `punctuation.separator.semicolon.idris2` | `;` | |
| `punctuation.accessor.idris2` | `.` of a projection | `p.x`, `(.x)` |
| `meta.declaration.data.idris2` | a `data` declaration and its indented body (with comment lines in or right after it) | |
| `invalid.illegal.unmatched-bracket.idris2` | a closing bracket with no open group (the lexer's Unrecognised token) | |

## Lexer behaviour the grammar reproduces (verified with `idris2 --check`, 0.8.0)

Each item was checked with a small module; "canary" means a deliberate type error placed after
the construct, which is reported only if the construct ended where claimed.

- `--` always starts a comment at a token start (`-->` is a comment); `--}` does not; `>--` is an
  operator. `|||` at a token start is a doc comment, even mid-line (`x = True ||| y` fails to parse).
- At top level, `{-` and all following dashes open a comment, so `{-}`, `{--}` and `{---}`
  never close (canary). Inside a comment, `{-}` and `{--}` open and close at once (canary);
  `--` hides the rest of its line, including `-}`; strings (which may span lines) and char
  literals are skipped. A file may end inside an unclosed comment.
- `_x` is `_` followed by `x` (`f _x = 1` is `f _ x = 1`).
- `0X` is accepted as a hexadecimal prefix; `0B1`, `0x_FF` and `1.0E5` split into two tokens.
- A backslash before an unknown character is dropped (`"\q" == "q"`); `\x` with no digits
  is dropped; `'\&'` is `'\0'`.
- In `#"…"#` strings `\n` is literal and `\#{…}` interpolates; `\\{` is not an interpolation.
  An interpolation may span lines inside a single-line string.
- Continuation lines inside brackets may start at column 0 (`]`, `2)`, `x : Nat) -> Nat`), and a
  braced record body may hold a doc comment at column 0; braced `where` and `namespace` blocks
  with column-0 declarations do not parse.
- After `public export data Foo : Type where`, a constructor at column 2 is a parse error: the
  body must be indented past the `data` keyword itself.
- Comments are whitespace to the layout rule: a `data` body continues over lines that start with
  a comment, even at column 0 (`data Op = Add` / `        | Sub` / `{-` / `        | Mul` /
  `-}` / `        | Div`, and `-- | Pow` at column 0 between two constructors, check), and a
  block comment inside the body may reach column 0. Declarations quoted with `` `[ `` may be
  data declarations (`` `[ data T = A | B ] ``), also followed by more declarations at the
  column of `data` (`` `[ data Col = Red | Green `` / `        total` /
  `        paint : Col -> Nat` / …). The first declaration of a `where` block may follow `where`
  on its line (`data T : Type where MkT : T`, `interface Nice a where nice : a -> a`,
  `where 0 E : Type`), and so may the first entry of a block opened by `mutual`, `namespace N`
  or `failing` with its optional message, a data declaration included: `mutual data Ev : … where`
  with its constructors on the next lines, `where data T : Type where`,
  `namespace Tagged data Tag : Type where`, `mutual twice : Nat -> Nat`,
  `namespace Claimed claimed : Nat`, `failing "FromString Nat" stringForNat : Nat` and
  `failing "Undefined name" data Broken = MkBroken Missing` check. A data declaration may also
  follow `;` (`data Pa = PA; data Qb = QB1 | QB2`, and `h = k where { k : Nat; k = 2; data V = D }`).
- `dataDeclBody` reads the type name with no layout check, and comments are whitespace, so the
  name may follow a line break or a comment: `data` / `  Rose : Type where`, `data -- note` /
  `  Foo : Type where` and `data {- the type -} Leafy : Type where` check.
- A backtick is a token of its own, so `` 10 ` div ` 2 `` uses `div` infix; a backtick followed
  by `(`, `{` or `[` is the quote opener `` `( ``, `` `{ `` or `` `[ ``, so `` 10 `div`(2) `` does
  not parse.
- Typed lambda binders `\x : Nat, y : Nat => x + y`; a bracketed default value
  `{default (S Z) n : Nat}`; the deprecated update `record { a = 1, b $= S } r` and its
  Idris 1 paths `record { p->a = 2 } q` (both give a deprecation warning); fixity hiding
  `%hide Prelude.Ops.infixl.(+)`.
- `\{n} => n` is rejected by 0.8.0 (implicit lambda binders are master only).
- A lambda binds a plain name only when it starts with an ASCII lower-case letter or is `_`
  (`isPatternVariable`, whose `isLower` is ASCII-only): `\X => X`, `\X : Nat => X` and
  `\α => α` fail with `Undefined name`, and `\Refl => Refl` matches on the constructor. A plain
  name may stand next to pattern binders: `\acc, (a, b) => …`, `\ (), v => v`,
  `\1 (a, b) => (a, b)`; the `\` may end its line (`map (\` / `  k => k)`).
- Comments are whitespace between `record` and what follows: `record {- c -} Point where` and
  `record {- c -} { val = 1 } b` check, and so do `interface {- c -} Shows a where`,
  `namespace {- c -} Spaced` and `commented {- c -} : Nat`. Data options may follow `where` on a later line, after a
  line comment, comment lines, blank lines and a block comment (`data Rel … where -- note` /
  `  [search n]`), in data and record bodies (`record R where` / `  [noHints]`).
- The precedence of a fixity declaration is any integer literal: `infixl 0x5 +++` declares
  precedence 5, and `infixr 1_0 ***` checks.
- `parameters (a : Nat, b : Nat)` (the old syntax, with a deprecation warning), the same with
  the second binder on the next line, and `using (xs : List a, n : Nat)` check;
  `f : (a : Nat, b : Nat) -> Nat` does not parse ("Expected a type declaration").
- Name puns one per line (`MkPoint { px` / `, py -- note` / `}`), and a named argument whose
  line ends in a comment that ends in `,` or `{` (`{n = S -- successor,` / `three}`), check.
- 0.8.0 prints `||| @ n …` parameter documentation verbatim in `:doc`; it is not given a scope.
- A multiplicity may stand alone on the line before its claim: after `0` / `zeroVal : Nat` /
  `zeroVal = 3`, using `zeroVal` in a clause fails with "not accessible in this context". Outside
  brackets a column-0 line continues an expression only after a line that ends in an operator
  (`x = 2 +` / `1` and `x = the Nat $` / `1` check; `x = S` / `0` does not parse).
- A dependent pair binds again after `**`: `(x : Nat ** y : Nat ** x = y)` and
  `(ty : Type` / `** make : (Nat -> ty)` / `** ty)` check. `with (x) proof eq` binds `eq`, and
  `with (x) proof 1 p` binds `p` linearly (leaving it unused is reported as a linear name).
- In a `.lidr` file a prose line is an empty line to the compiler (`reduce` in
  `Libraries/Text/Literate.idr` keeps only its newline), also inside an open bracket, data
  declaration or multi-line string (test/fixtures/grammar/BirdMultiline.lidr checks).

## Checking the grammar against the compiler's lexer

`test/grammar/corpus.test.ts` has an opt-in suite that builds
`test/corpus/lexer-oracle/LexDump.idr` against the `idris2` API package installed with the
compiler and compares, for every token the compiler's lexer produces, the scope the grammar
gives the token's first and last character, and that comment scopes cover exactly the lexer's
comments. It runs over the grammar fixtures and every `.idr` file of the pinned corpora:

```sh
IDRIS2_LEXER_ORACLE=1 npm run test:corpus    # IDRIS2=<path> selects another compiler
```

On Idris 2 0.8.0 it reports no mismatch over 1,160 files and 1,138,787 lexer tokens.

The same test file also turns every `.idr` file of the corpora into bird-track code (`> ` before
each line) and checks that `source.idris2.literate` gives each character the scopes
`source.idris2` gives it in the `.idr` file; `test/grammar/lidr.test.ts` does the same for the
`.idr` fixtures, and again with a prose line after every code line, which must tokenise as the
`.idr` file with an empty line in its place.

## Literate files

`syntaxes/lidr.tmLanguage.json` (`source.idris2.literate`) embeds this grammar. Before the first
code line, prose lines are `meta.prose.lidr`. From the first code line to the end of the file
the text is one embedded Idris 2 block (`meta.embedded.block.idris2`): code lines start with
`punctuation.definition.bird-track.lidr`, and each prose line is consumed whole as
`meta.prose.lidr` by a grammar injection that is tried before any Idris 2 rule. The prose line
leaves the Idris 2 rule stack as it was, just as the compiler reads it as an empty line. So a
bracket, block comment, multi-line string or data declaration that is open before a prose line
is still open after it, and the prose line carries the scopes that are open there (inside an
unclosed block comment it is scoped as the comment, which is how the compiler reads it). A
whitespace-only line is a blank line of the embedded code.

## Deliberate limits

- Constructors are recognised inside `meta.declaration.data.idris2`, which lasts while lines are
  indented past the line that holds `data` (not past the keyword, see above) or start with a
  comment, and while a comment, string or bracket opened in the body is open. So a comment line
  right after a data declaration is inside the region too. The region is still open at the end
  of a file that ends inside a `data` declaration; tests append one column-0 line before
  checking that the rule stack is back at the root.
- A data declaration that follows another token on its line (after `` `[ ``, `mutual`, `where`,
  `namespace N`, `failing` or `;`) starts at a column a TextMate rule cannot know. Its region
  ends at the next line of code that is not indented (and is not a comment), that starts with a
  declaration keyword, a modifier or a declaration pragma, or that starts with a claim of a
  lower-case name (constructors are capitalised or operators), and before a closing bracket it
  did not open. A clause written at the column of the block without a claim before it (a
  `where` block whose next entry is `f x = …`) stays inside the region, where only capitalised
  names after `=` or `|` could be mistaken for constructors. After `;` inside a data declaration
  (`data Pa = PA; data Qb = QB1 | QB2`) the second region is nested in the first, so its tokens
  carry `meta.declaration.data.idris2` twice.
- A bracket left open by unbalanced code ends at the next column-0 line (in a `.lidr` file, the
  first column after the bird track) that starts with a declaration keyword or a
  declaration-only pragma. Continuation lines that are valid Idris do not trigger this (see
  above); a doc comment does not either, because a braced record body may hold one at column 0
  (`record R where {` / `||| doc` / `x : Nat` / `}` checks).
- Strings with four or more hashes end correctly but their escapes and interpolations are not
  marked (the corpora use at most two).
- A single-line string also ends at the end of its line (the lexer rejects the newline).
- Binder names are recognised right after the opening bracket, on the same line, and in
  parentheses after a comma, on its line or at the start of the next one when the comma ends
  its line (the comma-separated binders of `parameters (a : A, b : B)` and `using`), and after
  `**` on the same line (`(x : Nat ** y : Nat ** x = y)`; a `**` that ends its line is not
  looked past). Named
  arguments, name puns and update fields are recognised right after the `{` or a comma on the
  same line, and on the next non-blank line when the `{` or comma ends its line (only for
  `{ … }`, not in the deprecated `record { … }` update). A pun that ends its line is taken for a
  named argument, so an update field whose `:=` is on the next line (`{semanticHighlighting` /
  `  := …}`, which checks; 1 site in the corpora) is marked `variable.parameter`, not
  `variable.other.member`. A braced record field (`{auto 0 prf : P}` in a record body) is marked
  as a binder, not as a field. Lambda binders are marked on the lambda's line, up to the `=>`:
  a plain name that the lambda binds (see above; other names are references and get no scope),
  and not the names inside a pattern binder (`\(a, b) =>`), which are unmarked as in clause
  patterns. The default value in `{default V x : T}` is matched as a literal, a (qualified) name
  with projections, or a bracket group nested at most one level deep; after a deeper value the
  binder is not marked.
- Any comments and line breaks between `data` and the type name are looked past. A comment
  between `record`, `interface` or `namespace` and the name (or the `{` of the deprecated
  update), or between the names of a claim and its `:`, is looked past only when it is a block
  comment that closes on its line and holds no nested comment, `--` or string
  (`record {- c -} Point where`, `f {- c -} : Nat`); otherwise the keyword and the comment are
  scoped on their own and the name or the update's fields are not marked. `record`,
  `interface` or `namespace` at the end of its line leaves the name on the next line unmarked.
- Data options are recognised in the `[ … ]` that follows a `where` directly or after comments
  and line breaks, when it starts with one of the five option words. A `where` that ends its
  line therefore also looks at the first line of any `where` block: a declaration there that
  starts with such a list (a named implementation called `search`, `[search] Show T where`, or
  a clause of an infix operator, `[external] <+> y = …`) would have it marked as data options.
- Signatures are recognised at the start of a line and right after `where`, `mutual`,
  `namespace N` or `failing` (with its optional single-line message) on the same line; not after
  `;` (`x = 1; y : Nat`), where a `let` block's typed binding could stand, and not after `let` on
  the same line (`let x : T = e` is a typed binding there). A typed binding on a later line of
  a `let` block (`let z : Nat = 3` / `    w : Nat = 4`) and a typed do-bind (`x : Nat <- pure 1`;
  both check) are marked as signatures (`entity.name.function`), although the parser binds
  them: at the start of a line they differ from a claim only after the type (`letBinder` parses
  the type without `=`, a claim's type may be an equality `p : a = b`), which a TextMate rule
  cannot find. Typed `let` bindings of this kind occur in the corpora (Idris 2 0.8.0
  `libs/contrib/System/Random.idr` 28-29); a typed do-bind does not. A name alone on its line
  whose `:` opens the next line (`MkClock` / `    : {type : ClockType} -> …`, 144 times in the
  corpora) is not marked: a TextMate rule cannot look at the next line, and a lone identifier
  can also be a continuation line of an expression. A multiplicity alone on its line is marked
  only at column 0, where a new declaration starts (`0` / `Hidden : Type`; once in the corpora);
  an indented one may be an argument on a continuation line and stays a number. At column 0 a
  lone `0` or `1` can also be the right operand of an operator that ends the line before
  (`x = 2 +` / `1` checks), and is then marked as a multiplicity too; the corpora have no such
  line. The compiler's
  semantic highlighting
  (docs/ROADMAP.md M3) is the planned way to mark such names and the typed bindings above.
  `constructor` is recognised at the start of a line only, not in
  `record R where constructor MkR`.
- An interface name is marked when the whole head up to the name is on the `interface` line;
  after constraints that end their line (`interface (MonadReader r m, …) =>` /
  `  MonadRWS r w s m | m where`) it is not.
- A named implementation is recognised with the `implementation` keyword, or without it when the
  line starts with `[name]` followed by the interface and ends with `where`; the name of the
  interface being implemented is not marked. A continuation line of the same shape is taken for
  one too: in `h = g` / `  [x] A where` / `    x : T` (which checks) the list's `x` is marked as
  an implementation name. The corpora have no such line: all 137 lines the rule matches there
  are named implementations (at column 0, or after a modifier line or `where`).
- A backtick split from its name by a comment or a line break gets no scope.
- Declarations in a block with explicit braces (`mutual { data T = A | B }`,
  `where { data V = D; g : Nat; g = 1 }`, both check) are not recognised as declarations:
  they are recognised at the start of a line outside any bracket, and in quoted declarations
  (`` `[ … ] ``); the exception is a data declaration after `;`, which is recognised inside the
  braces too. A claim right after the `{` is read as an implicit binder and marked
  `variable.parameter` (`k` in `h = k where { k : Nat; k = 2 }`, which checks).
- A capitalised name after `=` or `|` inside a `data` declaration is taken to be a constructor
  (`data T = A | B`); an unparenthesised equality type in a constructor's type (`C : a = B -> T`)
  would be marked the same way.
