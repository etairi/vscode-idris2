||| `failing` blocks (src/Idris/Parser.idr failDecls): the declarations inside must fail to
||| check, with an error that contains the given message if there is one.
module Failing

failing "Can't find an implementation for FromString Nat"
  notANat : Nat
  notANat = "not a nat"

failing
  alsoWrong : Nat
  alsoWrong = True

failing """
  Can't find an implementation for FromChar Nat
  """
  charForNat : Nat
  charForNat = 'c'

failing "FromString Nat" stringForNat : Nat
                         stringForNat = "x"

failing "Undefined name" data Broken = MkBroken Missing

ok : Nat
ok = 1
