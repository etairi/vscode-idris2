module Edits

import Data.Vect

-- E15 (docs/ROADMAP.md §9): the shapes whose replacement ranges M4's edits must get right.

-- A type declaration over three lines, without clauses.
zip3 : Vect n a ->
       Vect n b -> Vect n c ->
       Vect n (a, b, c)

-- Clauses continued over the next lines.
count : List a -> Nat
count xs =
  ?count_rhs

step : Nat -> Nat -> Nat
step m
     n
  = ?step_rhs

-- A clause in a where block.
sumAll : List Nat -> Nat
sumAll xs = go 0 xs
  where
    go : Nat -> List Nat -> Nat
    go acc ys = ?go_rhs

-- A with block.
classify : Nat -> String
classify n with (n > 10)
  classify n | True = ?classify_big
  classify n | False = ?classify_small

-- An operator, declared and defined, and one declared only.
private infixr 5 <&&>, <||>

(<&&>) : Bool -> Bool -> Bool
x <&&> y = ?op_rhs

(<||>) : Bool -> Bool -> Bool

-- Holes inside let and case.
withLet : Nat -> Nat
withLet n = let m = S n in ?let_rhs

withCase : Maybe Nat -> Nat
withCase mn = case mn of
  Nothing => ?case_nothing
  Just k => ?case_just

inline : Nat -> Nat
inline n = case n of m => ?inline_rhs

-- A hole that is not the whole right-hand side.
under : Nat -> Nat
under n = S ?under_rhs

-- Searches with few results or none, and a declaration without clauses.
choose : Bool -> Bool -> Bool
choose x y = ?choose_rhs

describe : Nat -> String
describe n = "n"

isBig : Nat -> Bool
isBig n = n > 10

check : Nat -> Bool
check n = ?check_rhs

label : Nat -> String
label n = ?label_rhs

swap : (a, b) -> (b, a)

pair : a -> b -> (a, b)
pair x y = ?pair_rhs

fun : Nat -> Nat
fun = ?fun_rhs

-- A prime and non-ASCII letters in names.
primed : Nat -> Nat
primed x' = ?h'

δ : Nat -> Nat
δ x₁ = ?ε

-- Missing cases without a coverage error.
partial
both : Bool -> Bool -> Nat
both True True = 1
