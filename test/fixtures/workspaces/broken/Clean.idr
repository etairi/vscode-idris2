module Clean

import Data.Vect

append : Vect n a -> Vect m a -> Vect (n + m) a

vlen : Vect n a -> Nat
vlen xs = ?vlen_rhs
