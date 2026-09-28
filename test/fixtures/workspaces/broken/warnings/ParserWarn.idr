module ParserWarn

record R where
  constructor MkR
  n : Nat

bump : R -> R
bump r = record { n = 1 } r

parameters (x : Nat, y : Nat)
  add : Nat
  add = x + y

twice : (Nat -> Nat) -> Nat
twice f = f (f 0)

use : Nat
use = twice \k => k

%nomangle "scheme:foo"
foo : Nat -> Nat
foo n = n
