-- Excerpt from the Idris 2 base library, https://github.com/idris-lang/Idris2
-- tag v0.8.0 (commit 15a3e4e70843f7a34100f6470c04b791330788df), file libs/base/Data/Fin.idr.
-- Copyright (c) 2020 Edwin Brady, School of Computer Science, University of St Andrews.
-- BSD 3-Clause License; the full notice is in NOTICE.md next to this file.
-- Changes: module renamed to BaseLibFin, `Fin.finToNat` qualified as `BaseLibFin.finToNat`,
-- and the file cut after the definition of `last`.
module BaseLibFin

import Control.Function
import public Control.Ord
import Data.List1
import public Data.Maybe
import public Data.Nat
import public Data.So
import Decidable.Equality.Core

%default total

||| Numbers strictly less than some bound.  The name comes from "finite sets".
|||
||| It's probably not a good idea to use `Fin` for arithmetic, and they will be
||| exceedingly inefficient at run time.
||| @ n the upper bound
public export
data Fin : (n : Nat) -> Type where
    FZ : Fin (S k)
    FS : Fin k -> Fin (S k)

||| Coerce between Fins with equal indices
public export
coerce : {n : Nat} -> (0 eq : m = n) -> Fin m -> Fin n -- TODO: make linear
coerce {n = S _} eq FZ = FZ
coerce {n = Z} eq FZ impossible
coerce {n = S _} eq (FS k) = FS (coerce (injective eq) k)
coerce {n = Z} eq (FS k) impossible

%transform "coerce-identity" coerce eq k = replace {p = Fin} eq k

export
Uninhabited (Fin Z) where
  uninhabited FZ impossible
  uninhabited (FS f) impossible

export
Uninhabited (FZ = FS k) where
  uninhabited Refl impossible

export
Uninhabited (FS k = FZ) where
  uninhabited Refl impossible

export
Uninhabited (n = m) => Uninhabited (FS n = FS m) where
  uninhabited Refl @{nm} = uninhabited Refl @{nm}

export
Injective FS where
  injective Refl = Refl

||| Convert a Fin to a Nat
public export
finToNat : Fin n -> Nat
finToNat FZ = Z
finToNat (FS k) = S $ finToNat k

export
Eq (Fin n) where
  x == y = finToNat x == finToNat y

finToNatInjective : (fm : Fin k) -> (fn : Fin k) -> (finToNat fm) = (finToNat fn) -> fm = fn
finToNatInjective FZ     FZ     _    = Refl
finToNatInjective (FS _) FZ     Refl impossible
finToNatInjective FZ     (FS _) Refl impossible
finToNatInjective (FS m) (FS n) prf  =
  cong FS $ finToNatInjective m n $ injective prf

||| `finToNat` is injective
export
Injective BaseLibFin.finToNat where
 injective = (finToNatInjective _ _)

export
Cast (Fin n) Nat where
    cast = finToNat

||| Convert a Fin to an Integer
public export
finToInteger : Fin n -> Integer
finToInteger FZ     = 0
finToInteger (FS k) = 1 + finToInteger k

-- %builtin NaturalToInteger Data.Fin.finToInteger

export
Show (Fin n) where
  show = show . finToInteger

export
Cast (Fin n) Integer where
    cast = finToInteger

||| Weaken the bound on a Fin by 1
public export
weaken : Fin n -> Fin (S n)
weaken FZ     = FZ
weaken (FS k) = FS $ weaken k

||| Weaken the bound on a Fin by some amount
public export
weakenN : (0 n : Nat) -> Fin m -> Fin (m + n)
weakenN n FZ = FZ
weakenN n (FS f) = FS $ weakenN n f

||| Weaken the bound on a Fin using a constructive comparison
public export
weakenLTE : Fin n -> LTE n m -> Fin m
weakenLTE  FZ     LTEZero impossible
weakenLTE (FS _)  LTEZero impossible
weakenLTE  FZ    (LTESucc _) = FZ
weakenLTE (FS x) (LTESucc y) = FS $ weakenLTE x y

||| Attempt to tighten the bound on a Fin.
||| Return the tightened bound if there is one, else nothing.
export
strengthen : {n : _} -> Fin (S n) -> Maybe (Fin n)
strengthen {n = S _} FZ = Just FZ
strengthen {n = S _} (FS p) with (strengthen p)
  strengthen (FS _) | Nothing = Nothing
  strengthen (FS _) | Just q  = Just $ FS q
strengthen _ = Nothing

||| Add some natural number to a Fin, extending the bound accordingly
||| @ n the previous bound
||| @ m the number to increase the Fin by
public export
shift : (m : Nat) -> Fin n -> Fin (m + n)
shift Z f = f
shift (S m) f = FS $ shift m f

||| Increment a Fin, wrapping on overflow
public export
finS : {n : Nat} -> Fin n -> Fin n
finS {n = S _} x = case strengthen x of
    Nothing => FZ
    Just y => FS y

||| The largest element of some Fin type
public export
last : {n : _} -> Fin (S n)
last {n=Z} = FZ
last {n=S _} = FS last
