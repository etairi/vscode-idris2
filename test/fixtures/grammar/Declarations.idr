||| Declarations: module header, imports, visibility and totality, signatures, data types,
||| records, interfaces, implementations, namespaces, parameters, mutual and using blocks,
||| and fixities (src/Idris/Parser.idr topDecl).
module Declarations

import Data.Vect
import public Data.List
import Data.String as Str

%default total

private infixl 6 <:+>
export infixr 5 +++
export infix 4 ===?
public export prefix 10 ~~

public export
data Colour = Red | Green
  | Blue

||| A binary tree.
public export
data Tree : Type -> Type where
  ||| An empty tree.
  Leaf : Tree a
  Node : (left : Tree a) -> a -> (right : Tree a) -> Tree a

data Pair' : Type -> Type -> Type where
  (<:>) : a -> b -> Pair' a b

export total
data Shape : Type where
  Circle, Square : Nat -> Shape

  Triangle : (a, b, c : Nat) -> Shape

data Opts : Type where [noHints, uniqueSearch]
  MkOpts : Opts

data OneLine : Type where OL1, OL2 : OneLine

data Later : Type

data Later : Type where
  MkLater : Later

public export
record Point where
  constructor MkPoint
  x, y : Nat
  {auto 0 prf : x = x}

record Box (a : Type) {n : Nat} where
  constructor MkBox
  0 len : Nat
  item : a

public export
interface Container (0 f : Type -> Type) where
  empty : f a
  insert : a -> f a -> f a

interface Eq a => Ord' a where
  constructor MkOrd'
  compare' : a -> a -> Ordering

interface Nice a where nice : a -> a

implementation Container List where
  empty = []
  insert = (::)

[reversed] Ord' Nat where
  compare' x y = compare y x

implementation [natural] Ord' Nat where
  compare' = compare

public export
(<:+>) : Nat -> Nat -> Nat
(<:+>) = (+)

export
(+++), (===?) : Nat -> Nat -> Bool
(+++) x y = x == y
(===?) x y = x /= y

(~~) : Nat -> Nat
(~~) = S

partial export
loop : Nat -> Nat
loop n = loop n

0 Erased : Type
Erased = Nat

namespace Inner.Deep
  export
  value : Nat
  value = 1

parameters (n : Nat) {auto ok : NonZero n}
  scaled : Nat -> Nat
  scaled k = k * n

mutual
  isEven : Nat -> Bool
  isEven Z = True
  isEven (S k) = isOdd k

  isOdd : Nat -> Bool
  isOdd Z = False
  isOdd (S k) = isEven k

using (a : Type)
  identity : a -> a
  identity x = x

private
secret : Nat
secret = 42

export typebind infixr 0 =@

0 (=@) : (x : Type) -> (x -> Type) -> Type
(=@) x f = (1 v : x) -> f v

linearId : (x : Nat) =@ Nat
linearId x = x

private autobind infixr 0 =>>

(=>>) : Maybe a -> (a -> Maybe b) -> Maybe b
(=>>) = (>>=)

bound : Maybe Nat
bound = (x <- Just 1) =>> Just (x + 1)

covering
countUp : Nat -> Nat
countUp n = countUp (S n)

record {- a comment -} Commented where
  constructor MkCommented
  field : Nat

data Rel : (n : Nat) -> Type where -- options on the next line
  [search n]
  MkRel : Rel n

record Hinted where
  [noHints]
  constructor MkHinted
  hinted : Nat

export infixl 0x5 +^+

export
(+^+) : Nat -> Nat -> Nat
x +^+ y = x + y

parameters (base : Nat,
            step : Nat)
  stepped : Nat -> Nat
  stepped k = base + k * step

using (xs : List Nat, len : Nat)
  lenOf : List Nat -> Nat
  lenOf = length

-- A data declaration or a claim that does not start its line: the first entry of a block
-- opened on the same line, or a declaration after ";".
mutual data EvenN : Nat -> Type where
         EvenZ : EvenN Z
         EvenS : OddN n -> EvenN (S n)
       data OddN : Nat -> Type where
         OddS : EvenN n -> OddN (S n)

mutual twice : Nat -> Nat
       twice n = n + n

namespace Tagged data Tag : Type where
                   MkTag : Tag

namespace Claimed claimed : Nat
                  claimed = 3

data Pa = PA; data Qb = QB1 | QB2

counted : Nat
counted = count Two
  where data Count : Type where
          One : Count
          Two : Count
        count : Count -> Nat
        count One = 1
        count Two = 2

-- The type name of a data declaration on the line after "data", or after a comment.
data
  Rose : Type where
  Bud : Rose
  Bloom : Rose -> Rose

data {- the type -} Leafy : Type where
  MkLeafy : Leafy

interface {- a comment -} Shows a where
  shows : a -> String

namespace {- a comment -} Spaced
  export
  spaced : Nat
  spaced = 1

commented {- a comment -} : Nat
commented = 2

-- A multiplicity alone on the line before its claim.
0
Hidden : Type
Hidden = Nat
