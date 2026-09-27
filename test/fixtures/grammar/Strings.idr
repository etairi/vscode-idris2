||| String literals: escapes, interpolation, raw strings with one to three hashes, and
||| multi-line strings (src/Parser/Lexer/Source.idr stringTokens, multilineBegin).
module Strings

import Data.List

n : Nat
n = 3

plain : String
plain = "tab\t, quote \", backslash \\, not a comment -- here, interpolated \{show n}"

escapes : String
escapes = "\x41\o101\65\NUL\SOH\SO\DEL\&\q"

notInterpolated : String
notInterpolated = "\\{ braces }"

nested : String
nested = "\{ pack (replicate {a = Char} 2 (the Char '}')) } and \{ "}" } and \{ show [n, n] }"

spanning : String
spanning = "a \{ show
                   n } b"

raw1 : String
raw1 = #"raw: \n is two characters, "quotes" are fine, \#{show n} interpolates, \{no} does not"#

raw2 : String
raw2 = ##"a"#b \##{show n} \#{no}"##

raw3 : String
raw3 = ###"a"##b \###{show n}"###

multi : String
multi = """
  multi-line \{show n} with "quotes" and ""
  a line continuation \
  here
  """

multiRaw : String
multiRaw = #"""
  raw """ inside, \{no}, \#{show n}
  """#

empty : String
empty = ""
