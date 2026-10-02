module Blocks

-- M4: Make Lemma in namespace, mutual, interface and parameters blocks; Add Missing Cases in a
-- parameters block and after a block comment; Make With on a let binding
-- (docs/as-built/M4.md, *Layout*).

data T = A | B | C

namespace N
  public export
  data U = MkU

  g : U -> Nat
  g u = ?ns_rhs

mutual
  data V = MkV

  f : V -> Nat
  f v = ?mut_rhs

interface Foo a where
  foo : a -> Nat
  foo x = ?default_rhs

parameters (k : Nat)
  f4 : T -> Nat
  f4 A = k

  pw : Nat -> Nat
  pw x = ?pw_rhs

bc : T -> Nat
bc A = 0
{-
bc B = 1
-}

letw : Nat -> IO Nat
letw n = do
  let y = ?let_rhs
  pure y
