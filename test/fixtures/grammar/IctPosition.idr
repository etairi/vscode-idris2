-- Excerpt from idris-compiler-tools, https://github.com/JankaGramofonomanka/idris-compiler-tools
-- commit e323d4707231ea0fb57b6b4015a35a6440cdc42a, file lng-compiler/src/Parse/Data/Position.idr.
-- Copyright (c) 2023 Jan Serwatka. MIT License; the full notice is in NOTICE.md next to this file.
-- Changes: module renamed to IctPosition; `import Data.Doc` and the two DocItem implementations removed.
module IctPosition


public export
record Position where
  constructor MkPosition
  line : Int
  column : Int

public export
record Pos where
  constructor MkPos
  from, to : Position

export
between : Position -> Position -> Pos
between left right = MkPos { from = left, to = right }

export prefix 10 ^
export infix 1 |^
public export
data (^) : Type -> Type where
  (|^) : Pos -> a -> ^ a

export
pos : ^a -> Pos
pos (p |^ x) = p

export
unPos : ^a -> a
unPos (p |^ x) = x

export prefix 10 ^^
export
(^^) : ^a -> a
(^^) = unPos

export
implementation Functor (^) where
  map f (p |^ x) = (p |^ f x)


export
moveRight : Position -> Int -> Position
moveRight p n = { column $= (+n) } p

export
moveRight' : Position -> Position
moveRight' p = p `moveRight` 1

export
moveDown : Position -> Int -> Position
moveDown p n = { line $= (+n) } p

export
moveDown' : Position -> Position
moveDown' p = p `moveDown` 1

export
resetHorizontal : Position -> Position
resetHorizontal p = { column := 1 } p

export
resetVertical : Position -> Position
resetVertical p = { line := 1 } p

export
nextLine : Position -> Position
nextLine = resetHorizontal . moveDown'
