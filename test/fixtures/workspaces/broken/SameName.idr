module SameName

import SameBase

-- M4: Add Missing Cases takes the :missing report of the declaration's own module and namespace
-- (docs/as-built/M4.md, *Third review fixes*): SameBase.g and B.f have missing cases, the g and the
-- A.f declared here do not; the go local to h is refused, since :missing answers for the top-level go.

g : Bool -> Bool
g True = False
g False = True

namespace A
  export
  f : Nat -> Nat
  f n = n

namespace B
  export
  partial
  f : Bool -> Nat
  f True = 1

data T = X | Y

partial
go : T -> Nat
go X = 0

partial
h : T -> Nat
h t = go t
  where
    partial
    go : T -> Nat
    go Y = 1
