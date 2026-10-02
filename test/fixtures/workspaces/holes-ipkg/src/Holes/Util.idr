module Holes.Util

import Holes.Base

export
thrice : Nat -> Nat
thrice n = twice n + ?util_rhs
