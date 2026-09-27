||| Line, block and documentation comments, including the lexer's edge cases
||| (src/Parser/Lexer/Common.idr comment, blockComment, toEndComment).
module Comments

-- A line comment.
---- More dashes still start a line comment.
-- An operator cannot begin with two dashes, so the rest of this line is a comment: --> x

{- A block comment. -}
{- depth 1 {- depth 2 {- depth 3 -} 2 -} 1 -}
{- Two dashes inside a block comment hide the rest of the line -- even -} here
   so this comment ends on the next line. -}
{- A string inside a block comment is skipped: "-}" does not close it. -}
{- So is a char literal: '"' does not start a string; the apostrophe in don't is plain text. -}
{- Inside a comment, {-} and {--} open and close at once. -}
{- Extra dashes may close a comment ---}
{-
   A comment over several lines.
-}

private infixl 5 >--, >|||

||| A documentation comment.
||| @ n the number to double
double : (n : Nat) -> Nat
double n = n + n -- a trailing comment

||| Operators that contain "--" or "|||" after their first character are operators.
(>--) : Nat -> Nat -> Nat
(>--) = (+)

(>|||) : Nat -> Nat -> Nat
(>|||) = (*)

x : Nat
x = double 1--a comment directly after a token

y : Nat
y = 1 >-- 2 >||| 3 {- a block comment inside an expression -} + 4
