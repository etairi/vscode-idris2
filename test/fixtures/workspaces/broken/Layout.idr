module Layout

-- M4: where Make Lemma, Add Clause, Add Missing Cases and Make With put their text, and the
-- declarations they take (docs/as-built/M4.md, *Layout*).

private infixr 5 <&&>, <||>
private infixl 6 <->

(<&&>) : Bool -> Bool -> Bool
False <&&> y = ?and_false
True <&&> y = ?and_true

(<||>) : Bool -> Bool -> Bool
(<||>) False y = y
(<||>) True y = ?or_true

plus2 : Nat -> Nat -> Nat
Z `plus2` y = y
S k `plus2` y = ?plus2_rhs

public export
%inline
twice : Nat -> Nat
twice x = ?twice_rhs

mutual
  partial
  isEven : Nat -> Bool
  partial
  isOdd : Nat -> Bool

  isEven Z = True
  isEven (S k) = isOdd k

  isOdd (S k) = isEven k

%inline inl : Nat -> Nat

(<->) : Nat -> Nat -> Nat

pair, other : Nat -> Nat

note : List a -> Nat
note xs = ?note_rhs -- keep this note

above : Nat -> Nat -> Nat
above x
  y = ?above_rhs
