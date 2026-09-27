Idris 2 constructs that span several bird-track lines keep their state
from one code line to the next.

> module BirdMultiline

A block comment over three code lines:

> {- first line of the comment
>    second line
>    third line -}
> answer : Nat
> answer = 42

A nested comment that continues across an empty line (the compiler reads an
empty line inside code the same way as a line holding only '>'):

> {- outer {- inner -}

>    still in the outer comment -}
> small : Nat
> small = 1

A multi-line string whose body contains comment and quote characters:

> poem : String
> poem = """
>   roses are red {- not a comment -}
>   "quoted" -- not a comment either
>   """
> after : Nat
> after = answer

A list, a data declaration and a multi-line string, each interrupted by prose.
The compiler reads a prose line as an empty line, so each of them continues:

> numbers : List Nat
> numbers = [ 1
The second element follows this line.
>           , 2 ]

> data Interrupted = First
The second constructor:
>                  | Second

> verse : String
> verse = """
>   roses are red
A remark in the middle of the string.
>   violets are blue
>   """
> afterVerse : Nat
> afterVerse = 1

The end.
