module Shadow

import Data.Vect

-- Answers the compiler gets wrong for names a clause or a type reuses: a braced named argument
-- matched with a variable of its own name, an argument named like its function, a clause without
-- a space before its =, and a hole applied to an argument (docs/as-built/M4.md, *Eighth review
-- fixes*).

vlen : {n : Nat} -> Vect n a -> Nat
vlen {n = n} xs = ?vlen_rhs

vlen2 : {n : Nat} -> Vect n a -> Nat
vlen2 {n} xs = ?vlen2_rhs

record P where
  constructor MkP
  x : Nat
  y : Bool

fields : P -> Nat
fields (MkP {x = x, y = y}) = ?fields_rhs

f : (Nat -> Nat) -> Nat

j : Nat -> Nat -> Nat

mw : Nat -> Nat
mw x= ?mw_h

foo : Nat -> Nat
foo x = ?g (S x)
