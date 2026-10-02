> module LitIndent

Bird tracks: Add Clause on a declaration indented in a where block or a mutual block keeps
the declaration's indentation (docs/as-built/M4.md, *Layout*).

> sumAll : List Nat -> Nat
> sumAll xs = go 0 xs
>   where
>     go : Nat -> List Nat -> Nat

> mutual
>   isEven : Nat -> Bool
