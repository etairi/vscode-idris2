module DupHole

-- M4: two holes of one name in a module; only the first is registered.

f : Nat -> Nat
f x = ?h

g : String -> String -> Nat
g a b = ?h
