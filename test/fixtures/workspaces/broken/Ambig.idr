module Ambig

namespace A
  export
  foo : Nat -> Nat
  foo n = n

namespace B
  export
  foo : Nat -> Nat
  foo n = S n

g : Nat
g = ?g_rhs
