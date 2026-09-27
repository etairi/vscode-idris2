||| Directives (pragmas): the `%` names accepted by src/Idris/Parser.idr that can stand in a
||| module checked by Idris 2 0.8.0. The settings at the end restate the Prelude's own.
module Directives

import Data.Vect
import Language.Reflection

%default total
%language ElabReflection
%auto_lazy on
%unbound_implicits on
%prefix_record_projections off
%ambiguity_depth 3
%totality_depth 5
%auto_implicit_depth 50
%nf_metavar_threshold 25
%search_timeout 1000
%logging off
%logging "elab" 0

%name Vect xs, ys

%cg chez extraRuntime=runtime.ss
%cg javascript {minimal}

%inline
double : Nat -> Nat
double n = n + n

%noinline
triple : Nat -> Nat
triple n = 3 * n

%tcinline
tc : Nat -> Nat
tc = S

%hint
natHint : Nat
natHint = 0

%deprecate
old : Nat
old = 1

%foreign "C:puts,libc"
prim__puts : String -> PrimIO Int

%export "javascript:exportedFn"
exported : Nat -> Nat
exported = S

%spec a
specialised : {a : Type} -> List a -> List a
specialised = id

%transform "double-plus" double n = n + n

%macro
three : Elab Nat
three = pure 3

usesMacro : Nat
usesMacro = three

elaborated : Nat
elaborated = %runElab (pure 3)

searched : Nat
searched = %search

world : %World
world = %MkWorld

logged : Nat
logged = %logging "elab" 0 (double 1)

syntactic : Nat -> Nat
syntactic n with %syntactic (n)
  syntactic n | Z = 0
  syntactic n | S k = k

data Peano = PZ | PS Peano

%builtin Natural Peano

%hide Prelude.Types.List.length
%unhide Prelude.Types.List.length
%hide Prelude.Ops.infixl.(+)
private infixl 8 +

%pair Builtin.Pair Builtin.fst Builtin.snd
%rewrite Builtin.Equal Builtin.rewrite__impl
%integerLit Prelude.Num.fromInteger
%stringLit Builtin.fromString
%charLit Builtin.fromChar
%doubleLit Builtin.fromDouble
%allow_overloads Prelude.Num.fromInteger
