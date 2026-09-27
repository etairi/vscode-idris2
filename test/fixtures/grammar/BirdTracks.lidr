Bird-track literate Idris 2: a line is code when it starts with '>' or '<'
followed by whitespace or by nothing; every other line is prose.
Prose may touch code directly, with no blank line in between.
> module BirdTracks
>
> import Data.Vect

A '<' line is a hidden code line; the compiler checks it like a '>' line.

< hidden : Nat
< hidden = 2

>not code, because no space follows the marker.
  > not code either, because the marker is not in the first column.

> ||| Doubles a number.
> double : Nat -> Nat
> double n = n + n -- a line comment
>
> vlen : Vect n a -> Nat
> vlen [] = 0
> vlen (x :: xs) = S (vlen xs)
Prose again, right after code.
>	tabbed : Nat
>	tabbed = double hidden

> todo : Nat -> Nat
> todo n = ?todo_rhs

The end.
