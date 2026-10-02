module Holes.Main

import Holes.Util

-- E16: imports Holes.Util, which imports Holes.Base; `todo` is also a hole of Holes.Base.

count : List Nat -> Nat
count ns = ?todo

size : Nat
size = thrice ?size_rhs
