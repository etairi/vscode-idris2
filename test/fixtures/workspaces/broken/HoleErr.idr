module HoleErr

-- F16: a hole before and after a type error, and a function with several missing cases.

before : Nat -> Nat
before n = ?before_rhs

bad : Nat -> String
bad x = x

after : List Nat -> Nat
after xs = ?after_rhs

cover : Bool -> Bool -> Nat
cover True True = 1
