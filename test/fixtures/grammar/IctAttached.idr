-- Excerpt from idris-compiler-tools, https://github.com/JankaGramofonomanka/idris-compiler-tools
-- commit e323d4707231ea0fb57b6b4015a35a6440cdc42a, file lng-compiler/src/Data/Attached.idr.
-- Copyright (c) 2023 Jan Serwatka. MIT License; the full notice is in NOTICE.md next to this file.
-- Changes: module renamed to IctAttached; `import Data.Some` and the two functions over `Some` (inSome, outOfSome) removed.
||| A module defining the `Attached` data type and its interface
module IctAttached



||| A data item attached to a value.
||| The purpose of this data type is tag values, while keeping track of the
||| tag in the type-level.
export
data Attached : (x : t) -> Type -> Type where
  Attach : (0 x : t) -> (y : t') -> Attached x t'

export infixr 6 :~:
||| An alias for `Attached`
public export
(:~:) : (x : t) -> Type -> Type
(:~:) = Attached

||| Combine two items attached to the same tag
export
combine : (a -> b -> c) -> Attached x a -> Attached x b -> Attached x c
combine f (Attach x a) (Attach x b) = Attach x (f a b)

||| Attach a data item to a tag
export
attach : (0 x : t) -> (y : t') -> Attached x t'
attach = Attach

||| Detach a data item from a tag
export
detach : Attached x t -> t
detach (Attach x a) = a

||| Detach a data item from a tag and attach it to another
export
reattach : {x : t} -> (y : t) -> Attached x a -> Attached y a
reattach y (Attach x a) = Attach y a

export
implementation Functor (Attached x) where
  map f (Attach x y) = Attach x (f y)

export
implementation Foldable (Attached x) where
  foldr f acc (Attach x elem) = f elem acc

export
implementation Traversable (Attached x) where
  traverse f (Attach x y) = pure (Attach x) <*> (f y)


||| Distribute the attachment to the lements of a list
export
distribute : Attached x (List a) -> List (Attached x a)
distribute (Attach x l) = foldr (\elem => (Attach x elem ::)) Nil l

||| Move the attachment to the dependent (the second) element of the dependent pair
export
detachParam : {f : a -> Type} -> Attached x (y ** f y) -> (y ** Attached x (f y))
detachParam (Attach x (y ** fy)) = (y ** Attach x fy)
