module Holes.Base

-- E16: a hole named like one in Holes.Main, and one in a declaration that is not exported.

export
twice : Nat -> Nat
twice n = ?todo

secret : Nat
secret = ?secret_rhs
