module Base

import Data.Vect

-- A hole named like one in Main (both are `todo`), with a premise of each multiplicity.
export
consume : (1 x : a) -> Vect n a -> Vect (S n) a
consume x xs = ?todo
