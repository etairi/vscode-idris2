-- Excerpt from idris-compiler-tools, https://github.com/JankaGramofonomanka/idris-compiler-tools
-- commit e323d4707231ea0fb57b6b4015a35a6440cdc42a, file control-flow/src/ControlFlow/Edge.idr.
-- Copyright (c) 2023 Jan Serwatka. MIT License; the full notice is in NOTICE.md next to this file.
-- Changes: module renamed to IctEdge; `import Theory` and the four lemmas that use it removed.
module IctEdge


export infix 6 ~>, <~

||| An edge between vertices
||| @ a the type of vertex identifiers
public export
data Edge a
  = ||| `v ~> w` - an edge from `v` to `w`
    (~>) a a

public export
(<~) : a -> a -> Edge a
(<~) = flip (~>)

public export
Dest : Edge a -> a
Dest (from ~> to) = to

public export
Origin : Edge a -> a
Origin (from ~> to) = from

export infix 8 ~~>, ~>>, <~~, <<~

||| A *collection* of `vs` by `v`
public export
(~~>) : (vs : List a) -> (v : a) -> List (Edge a)
vs ~~> v = map (~> v) vs

||| A *distribution* of `v` to `vs`
public export
(~>>) : (v : a) -> (vs : List a) -> List (Edge a)
v ~>> vs = map (v ~>) vs

||| Flipped `(~~>)`
public export
(<~~) : (v : a) -> (vs : List a) -> List (Edge a)
(<~~) = flip (~~>)

||| Flipped `(~>>)`
public export
(<<~) : (vs : List a) -> (v : a) -> List (Edge a)
(<<~) = flip (~>>)
