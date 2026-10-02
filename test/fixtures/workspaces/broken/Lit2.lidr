> module Lit2
>
> import Data.Vect

Bird tracks: the clauses a case split makes keep a single `> `. The line of a
marker and a space above `half` is two lines to the compiler (docs/ROADMAP.md F11).

> vlen : Vect n a -> Nat
> vlen xs = ?vlen_rhs
>
> vapp : Vect n a -> Vect m a -> Vect (n + m) a
>
> partial
> both : Bool -> Bool -> Nat
> both True True = 1
> 
> half : Nat -> Nat
> half n = ?half_rhs
>
> twice : Nat -> Nat
> twice n = n + n
