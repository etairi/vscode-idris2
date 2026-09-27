module Vlen

import Data.Vect

||| The length of a vector, by recursion (the selection-range fixture of docs/ROADMAP.md M0).
vlen : Vect n a -> Nat
vlen [] = 0
vlen (x :: xs) = ?rhs
