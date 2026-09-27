||| Expressions: binding forms, control flow, operators, brackets, arguments, record updates,
||| holes and projections (src/Idris/Parser.idr expr, simpleExpr, simplerExpr).
module Expressions

import Data.Fin
import Data.List
import Data.Nat
import Data.SnocList
import Data.Vect

%default total

private infixl 1 |:>

(|:>) : a -> (a -> b) -> b
x |:> f = f x

record Point where
  constructor MkPoint
  px : Nat
  py : Nat

linearLet : (1 n : Nat) -> Nat
linearLet n = let 1 k = n in k

letBlock : Nat
letBlock =
  let m : Nat
      m = 2
      k = m + 1
  in k

cases : Nat -> Bool
cases n = case n of
  Z => True
  S _ => False

lambdaCase : Nat -> Bool
lambdaCase = \case
  Z => True
  S _ => False

conditional : Bool -> Nat
conditional b = if b then 1 else 0

lambdas : Nat -> Nat -> Nat
lambdas = \x, y => x + y

erasedLambda : (0 _ : Nat) -> Nat
erasedLambda = \0 x => 1

doBlock : Maybe Nat
doBlock = do
  x <- Just (the Nat 1)
  let y = x + 1
  (a, b) <- Just (y, y)
  Just (a + b)

namespace Opt
  export
  (>>=) : Maybe a -> (a -> Maybe b) -> Maybe b
  (>>=) = Prelude.(>>=)

qualifiedDo : Maybe Nat
qualifiedDo = Opt.do
  x <- Just (the Nat 1)
  Just (x + 1)

withView : List Nat -> Nat
withView xs with (xs)
  withView xs | [] = 0
  withView xs | (y :: _) = y

withProof : (n : Nat) -> Nat
withProof n with (n) proof eq
  withProof n | Z = 0
  withProof n | S k = k

impossibleCase : Fin 0 -> Void
impossibleCase FZ impossible
impossibleCase (FS _) impossible

rewriting : (n : Nat) -> n + 0 = n
rewriting n = rewrite plusZeroRightNeutral n in Refl

operators : Nat -> Nat
operators n = (+ 1) (n * 2) |:> (`minus` 1) |:> (10 `max`) |:> (\k => k) |:> Prelude.(+) 1

sections : List Nat
sections = map (+ 1) [1, 2] ++ map (2 *) [3]

bang : IO ()
bang = printLn !(pure (the Nat 1))

asPattern : List Nat -> List Nat
asPattern all@(x :: _) = x :: all
asPattern [] = []

dependentPair : (n : Nat ** Vect n Nat)
dependentPair = (1 ** [0])

ranges : List Nat
ranges = [1 .. 5] ++ [1, 3 .. 9] ++ [x * 2 | x <- [1, 2], x > 1]

snoc : SnocList Nat
snoc = [< 1, 2, 3]

forward : List Nat
forward = [> 1, 2]

idiom : Maybe Nat
idiom = [| Just 1 + Just 2 |]

namedArgs : Nat
namedArgs = length (replicate {a = Nat} 2 0)

implicitPattern : {n : Nat} -> Vect n a -> Nat
implicitPattern {n} _ = n

autoArg : Show a => a -> String
autoArg @{inst} x = show @{inst} x

recordUpdate : Point -> Point
recordUpdate p = { px := 1, py $= S } p

projections : Point -> Nat
projections p = p.px + p .py + (.px) p + sum (map (.py) (the (List Point) [p]))

hole : Nat -> Nat
hole n = ?todo_hole

inferred : ?
inferred = the Nat 3

wildcard : Nat -> Nat
wildcard _ = 0

universal : forall a, b . a -> b -> a
universal x _ = x

dotted : (n : Nat) -> (m : Nat) -> n = m -> Nat
dotted n .(n) Refl = n

multiplicities : (0 n : Nat) -> {auto 0 prf : n = n} -> (1 x : Nat) -> Nat
multiplicities _ x = x

defaultImplicit : {default 0 k : Nat} -> Nat
defaultImplicit = k

typedLambda : Nat -> (0 _ : Nat) -> Nat
typedLambda = \x : Nat, 0 _ : Nat => x

spacedInfix : Nat
spacedInfix = 10 ` minus ` 2

defaultList : {default [] xs : List Nat} -> Nat
defaultList = length xs

defaultApp : {default (S Z) n : Nat} -> Nat
defaultApp = n

record Segment where
  constructor MkSegment
  from : Point
  to : Point

oldUpdate : Point -> Point
oldUpdate p = record { px = 1, py $= S } p

oldPathUpdate : Segment -> Segment
oldPathUpdate s = record { from->px = 0 } s

continuedUpdate : Segment -> Segment
continuedUpdate s = { from.px := 1,
                      to $= id
                    } s

pairOf : {a : Type} -> {b : Type} -> a -> b -> (a, b)
pairOf x y = (x, y)

continuedNamed : (Nat, Bool)
continuedNamed = pairOf {
                   a = Nat,
                   b = Bool
                 } 1 True

parenDo : Maybe Nat
parenDo = (do x <- Just 1
              y <- Just 2
              pure (x + y))

whereClaim : Nat -> Nat
whereClaim n = go n where go : Nat -> Nat
                          go k = S k

upTo : Nat -> Nat -> List Nat
upTo a b = [a .. b]

triangles : Nat -> List (Nat, Nat)
triangles top = [(x, y) | y <- upTo 1 top, x <- upTo 1 y]

unit : ()
unit = ()

lambdaPatterns : List (Nat, Nat) -> Nat
lambdaPatterns = foldl (\acc, (a, b) => acc + a + b) 0

lambdaUnit : () -> Nat -> Nat
lambdaUnit = \ (), v => v

lambdaLinear : (1 _ : (Nat, Nat)) -> (Nat, Nat)
lambdaLinear = \1 (a, b) => (a, b)

lambdaMatch : a = b -> b = a
lambdaMatch = \Refl => Refl

lambdaNextLine : List Nat -> List Nat
lambdaNextLine = map (\
  k => k)

oldUpdateCommented : Point -> Point
oldUpdateCommented p = record {- deprecated -} { px = 1 } p

punsPerLine : Nat -> Nat -> Point
punsPerLine px py = MkPoint { px
                            , py -- note
                            }

successorArg : {n : Nat} -> Nat
successorArg = n

commentEndsInComma : Nat
commentEndsInComma = successorArg {n = S -- successor,
                                     Z}

dependentPairs : (n : Nat ** m : Nat ** n = m) -> Nat
dependentPairs (n ** m ** _) = n + m

dependentLines : (ty : Type
                  ** make : (Nat -> ty)
                  ** ty)
dependentLines = (Nat ** S ** 0)
