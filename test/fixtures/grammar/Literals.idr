||| Numeric and character literals (src/Parser/Lexer/Source.idr rawTokens: doubleLit,
||| binUnderscoredLit, hexUnderscoredLit, octUnderscoredLit, digitsUnderscoredLit, charLit).
module Literals

decimal : Integer
decimal = 1_000_000 + 42 + 0

hexadecimal : Integer
hexadecimal = 0xFF_FF + 0XAb

octal : Integer
octal = 0o7_55

binary : Integer
binary = 0b1010_0101

floating : Double
floating = 3.25 + 1.5e-3 + 2.0e+2 + 6.02e23

chars : List Char
chars = ['a', 'λ', '\'', '\\', '"', '\n', '\t', '\x41', '\o101', '\65', '\NUL', '\SOH', '\SO', '\DEL', '\&']

-- Primes belong to identifiers; a quote at the start of a token begins a char literal.
primed : Char -> Char
primed x' = x'

x'y' : Char
x'y' = 'y'

-- 0 and 1 are ordinary literals in expressions and multiplicities in binders.
literalsNotMultiplicities : List Nat
literalsNotMultiplicities = [0, 1, 0 + 1]
