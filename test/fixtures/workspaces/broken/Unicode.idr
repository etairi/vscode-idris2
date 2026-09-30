module Unicode

-- E14 (docs/ROADMAP.md, section 9): characters of several UTF-8 bytes before a column. Line 12:
-- U+03B1 (2 bytes) and U+2081 (3 bytes) in names; line 15: two U+1D55F (4 bytes, 2 UTF-16
-- units each) in a string; line 18: e and the combining mark U+0301 (2 code points, 1
-- grapheme) in a string; line 21: U+1D55F and U+03B1 in a block comment.

ℕ : Type
ℕ = Nat

α : ℕ -> ℕ -> ℕ
α x₁ y = x₁ + y

astral : String -> (String, String)
astral s = ("𝕟𝕟", s)

combining : String -> (String, String)
combining t = ("é", t)

commented : Nat -> Nat
commented {- 𝕟 α -} m = m
