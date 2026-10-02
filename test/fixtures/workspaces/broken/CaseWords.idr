module CaseWords

import Data.Vect

-- Case Split on lines whose answer the compiler reshapes or garbles: the word of in a comment or a
-- string, a hole in parentheses, a string holding a pattern variable; and on case alternatives
-- (docs/as-built/M4.md, *Seventh review fixes*).

vlen : Vect n a -> Nat
vlen xs = ?vlen_rhs -- the length of the vector

word : List Nat -> String -> Nat
word xs "of" = ?word_rhs
word _ _ = 0

paren : List Nat -> Nat
paren xs = (?paren_rhs)

named : List Nat -> String -> Nat
named xs "xs" = ?named_rhs
named _ _ = 0

alt : Maybe Nat -> Nat
alt m = case m of
  Just y => ?alt_rhs -- the rest of it
  Nothing => 0

made : Vect n a -> Nat
made xs = case xs of
               case_val => ?made_rhs

closing : Nat -> Nat
closing n = (case n of
               case_val => ?closing_rhs)
