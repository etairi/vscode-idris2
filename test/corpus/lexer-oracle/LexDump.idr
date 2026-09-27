||| Prints the tokens that the Idris 2 compiler's own lexer (Parser.Lexer.Source.lex, from the
||| `idris2` API package installed with the compiler) produces for one source file, one per line:
|||
|||   KIND <TAB> startLine <TAB> startCol <TAB> endLine <TAB> endCol <TAB> payload
|||
||| Lines and columns are 0-based and count characters (code points). Comments come first; the
||| lexer reports them separately from the tokens. A file the lexer rejects prints one line
||| starting with ERROR. Used by the opt-in lexer comparison in test/grammar/corpus.test.ts.
module Main

import Core.Name.Namespace
import Libraries.Text.Lexer.Tokenizer
import Parser.Lexer.Source
import System
import System.File

kind : Token -> (String, String)
kind (CharLit x) = ("CharLit", x)
kind (DoubleLit x) = ("DoubleLit", show x)
kind (IntegerLit x) = ("IntegerLit", show x)
kind (StringBegin n Single) = ("StringBegin", show n)
kind (StringBegin n Multi) = ("MultiBegin", show n)
kind StringEnd = ("StringEnd", "")
kind InterpBegin = ("InterpBegin", "")
kind InterpEnd = ("InterpEnd", "")
kind (StringLit _) = ("StringLit", "")
kind (HoleIdent x) = ("HoleIdent", x)
kind (Ident x) = ("Ident", x)
kind (DotSepIdent ns n) = ("DotSepIdent", show ns ++ "." ++ n)
kind (DotIdent x) = ("DotIdent", x)
kind (Symbol x) = ("Symbol", x)
kind Space = ("Space", "")
kind Comment = ("Comment", "")
kind (DocComment _) = ("DocComment", "")
kind (CGDirective _) = ("CGDirective", "")
kind EndInput = ("EndInput", "")
kind (Keyword x) = ("Keyword", x)
kind (Pragma x) = ("Pragma", x)
kind (MagicDebugInfo x) = ("MagicDebugInfo", show x)
kind (Unrecognised x) = ("Unrecognised", x)

row : String -> WithBounds a -> String -> String
row k b payload =
  let MkBounds sl sc el ec = b.bounds in
      concat [k, "\t", show sl, "\t", show sc, "\t", show el, "\t", show ec, "\t", payload]

main : IO ()
main = do
  [_, path] <- getArgs
    | _ => die "usage: lexdump FILE"
  Right src <- readFile path
    | Left err => die (show err)
  case lex src of
    Left (reason, l, c, _) => putStrLn (concat ["ERROR\t", show l, "\t", show c, "\t", show reason])
    Right (comments, toks) => do
      traverse_ (\b => putStrLn (row "Comment" b "")) comments
      traverse_ (\t => let (k, p) = kind t.val in putStrLn (row k t p)) toks
