module Part

g : Nat -> Nat
g 0 = 0

main : IO ()
main = printLn (g 0)
