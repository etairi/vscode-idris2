||| Elaborator reflection: quoted terms, names and declarations, and unquotes
||| (src/Idris/Parser.idr simplerExpr: "`(", "`{", "`[", "~").
module Elab

import Language.Reflection

%language ElabReflection

quoted : TTImp
quoted = `(1 + 2)

name : Name
name = `{Prelude.plus}

decls : List Decl
decls = `[ foo : Nat
           foo = 1 ]

dataDecls : List Decl
dataDecls = `[ data Q = QA | QB ]

dataDecls2 : List Decl
dataDecls2 = `[ data R = RA
                       | RB ]

dataDecls3 : List Decl
dataDecls3 = `[ data Col = Red | Green
                total
                paint : Col -> Nat
                paint Red = 1
                paint Green = 2 ]

unquoted : TTImp -> TTImp
unquoted t = `(~t + ~(quoted))

%macro
answer : Elab Nat
answer = pure 42

used : Nat
used = answer
