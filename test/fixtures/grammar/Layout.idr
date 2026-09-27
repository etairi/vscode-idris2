||| Layout cases the grammar has to survive: continuation lines at column 0 inside brackets,
||| binders split across lines, blank lines and comments inside data declarations (also
||| comments that reach column 0, which the layout rule ignores), and a data declaration at
||| the end of the file.
module Layout

xs : List Nat
xs = [ 1
     , 2
]

sumOf : Nat
sumOf = (1 +
2)

identity : (
x : Nat) -> Nat
identity x = x

pairUp : (a : Type) -> (b : Type) ->
         (x : a) -> (y : b) -> (a, b)
pairUp _ _ x y = (x, y)

data Token : Type where
  ||| A number.
  Number : Nat -> Token

  -- A comment between constructors.
  Plus : Token

  ||| An operator
  ||| with a two-line comment.
  Times : Token

data Op = Add
        | Sub
{-
        | Mul
-}
        | Div
-- | Pow
        | Neg

data Note = Plain
  {- a comment whose text
reaches column 0 = B | C -}
  | Sharp

data Gadt : Type where
  G1 : Gadt
  {- a comment
g : Gadt -}
  G2 : Gadt
-- a column-0 line comment inside the body
  G3 : Gadt

ops : List Op
ops = [Add, Sub, Div, Neg]

data Simple
  = One
  | Two
