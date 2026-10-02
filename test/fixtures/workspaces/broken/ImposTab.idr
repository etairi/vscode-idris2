module ImposTab

-- M4: Case Split on tab-indented clauses: every constructor impossible, and a one-line case
-- (docs/as-built/M4.md, *Sixth review fixes*).

import Data.Fin

g : Nat
g = f Nothing
  where
	f : Maybe Nat -> Nat
	f m = case m of x => ?f_rhs
	v : Fin 0 -> Void
	v x = ?v_rhs
