||| Identifiers (src/Parser/Lexer/Common.idr isIdentStart, isIdentTrailing): ASCII letters,
||| '_', primes after the first character, and every character above U+00A0. Operators
||| are ASCII only (src/Core/Name.idr isOpChar), so a Unicode arrow is an identifier.
module Unicode

α : Nat
α = 1

x₁ : Nat
x₁ = α + 1

data ℕ : Type where
  Zero : ℕ
  Succ : ℕ -> ℕ

toNat : ℕ -> Nat
toNat Zero = 0
toNat (Succ k) = S (toNat k)

snake_case' : Nat
snake_case' = x₁

-- `_x` is the symbol `_` followed by `x`, so `f _ x` has two arguments here.
twoArgs : Nat -> Nat -> Nat
twoArgs _x = x
