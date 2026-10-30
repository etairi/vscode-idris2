module DocEval

||| Twice a number.
double : Nat -> Nat
double n = n + n

main : IO ()
main = putStrLn "ran main"

-- The -- >>> lines of M8's lenses, and what is not one.

-- >>> double 2
-- >>> the (List Nat) [1, 2]
-- >>> :t double
-- >>> :doc double
-- >>> doesNotExist
-- >>> :exec main

--- >>> three dashes
{- -- >>> in a block comment -}
text : String
text = "-- >>> in a string"
