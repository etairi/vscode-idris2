Layout across bird-track lines. The code of a line starts after the marker and one
whitespace character, so the rules that look for the start of a line, and those that look
for the start of a bracket, have to find that position.

> module BirdLayout

A data declaration whose body holds a block comment that reaches the code column, then a
second data declaration and a signature on the lines right after it:

> data T = A
>   {- a comment whose text
> reaches the code column -}
>   | B
> data U = C | D
> t : T
> t = B

Continuation lines inside brackets are not the start of the bracket:

> pairs : Maybe Nat
> pairs = (do x <- Just 1
>             y <- Just 2
>             pure (x + y))

> record P where
>   constructor MkP
>   px, py : Nat

> moved : P -> P
> moved p = { px := 1,
>             py := 2
>           } p

The end.
