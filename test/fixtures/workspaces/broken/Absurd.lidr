> module Absurd

Bird tracks: Case Split where every constructor is impossible, and on a one-line case, gives
each new line the marker (docs/as-built/M4.md, *Sixth review fixes*).

> import Data.List.Elem

> notInNil : Elem x [] -> Void
> notInNil p = ?notInNil_rhs

> pick : Maybe Nat -> Nat
> pick m = case m of x => ?pick_rhs
