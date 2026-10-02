// The line reader (`src/core/idrisSyntax.ts`) against M0's `lex` (`src/features/syntax/lexer.ts`): both run the
// lexer of `src/core/idrisLexer.ts`, `lex` on the whole text, the reader a line at a time from what is open after
// the line before. `test/unit/support/lineReading.ts` says what must agree. Here: every line of every .idr, .lidr
// and .md file under test/fixtures (a literate file read raw, as code, too), curated texts, and generated ones; the
// corpora in test/grammar/corpus.test.ts (`npm run test:corpus`, CI).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { repoRoot } from '../fake-tools/paths';
import { lineDifferences } from './support/lineReading';

const fixtures = path.join(repoRoot(), 'test', 'fixtures');

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(p);
    } else if (/\.(idr|lidr|md)$/u.test(entry.name)) {
      yield p;
    }
  }
}

/**
 * Texts that each pin a case where a line break meets a lexeme (`core/idrisLexer.ts`, *Line by line*), with what the
 * compiler's lexer does there.
 */
const CURATED: readonly string[] = [
  // `'\''` and the quotes after it (M4's third review of the fixes: the old reader paired the literal's last quote
  // with the next one and opened a string at `'"'` that ran over the following lines).
  "quotes : Char -> Char -> Bool\nquotes '\\'' '\"' = True\nquotes _ _ = False\n\nf : Nat -> Nat\nf x = ?h * case x of _ => 1\n                       + 2\n",
  "q : List Char\nq = ['\\'','\"']\n\nf x = ?h * case x of _ => 1\n",
  "c = ['\\\\', '\\x41', '\\NUL', '\\SOH', '\\DEL', '\\o17', '\\65', 'a', '\"', '{', '-', '😀', '\\😀']\n",
  // A character literal across a line break: `'` ⏎ `'` and `'\` ⏎ `'`; then one the next line does not close.
  "x = '\n' + y\nz = '\\\n'\n",
  "x = '\ny\nz = '\\\nw\n",
  // ...and in a block comment, where it hides the `"` after it (`'` ⏎ `'"…`), or not.
  "{- a '\n'\" -}\nx = 1\n",
  "{- a '\n\"'\" -}\nx = 1 -}\ny\n",
  // A `"` string: an escape at the end of the line takes the break (the string goes on), anything else ends it,
  // which the compiler rejects (the reader is `unsure` from there on).
  's = "abc\\\ndef"\nt = 1\n',
  's = "abc\nt = "x"\n',
  's = #"a\\#\nb"#\nt = #"a\\\nb"#\n',
  // Strings: raw ones with `"` inside, multiline ones, raw multiline ones, `"""` not followed by a line break.
  'r = #"a"b"# ++ ##"c"#d"## ++ "e\\"f"\n',
  'm = """\n  a " b\n  \\{x ++ "y\\{z}"} -}\n  """\nn = 1\n',
  'm = #"""\n  a """ b\n  \\#{x}\n  """#\n',
  'm = """ x\n',
  'm = """   \n  t\n  """\n',
  // Interpolations over lines, with comments, strings, characters and brackets in them.
  'f x = "a \\{show (x +\n  1) -- " no end\n  ++ "b"} c" ++ \'"\'\n',
  'f x = "a \\{ {- "\n -} x } b"\n',
  'f x = """\n  \\{ case x of\n      _ => "\\{y}" }\n  """\n',
  // Block comments: nesting, `{--}`, `--}`, `-}` hidden by `--`, strings and characters inside, an odd number of `"`.
  '{- a {- b -} c\n -} x = 1\n',
  '{- a {--} b\n -} x\n',
  '{- a -- -}\n -} x\n',
  '{- a "-}" b\n -} x\n',
  "{- a '-}' b\n -} x\n",
  '{- a " b\n c " -} x\n',
  '{- " -} x\n',
  '{-}\n x -}\ny\n',
  '{----}\n x\n',
  '{-- a --}\nx\n',
  // Line and doc comments, and operators of dashes.
  'f = 1 --} 2\nx --> y\n(-->) : Nat\ng = 1 -- " {-\n||| doc " {-\nh = a --- b\n',
  'x = a -} b\ny = a --} b -- c\n',
  // White space the lexer reads as space (NBSP, \\f, \\v), and characters it does not.
  'f\u00a0x\u000b=\u000c1\nf\u2003x = 1\n',
  // Names: primes, unicode, namespaces, record projections, `_`, `__LOC__`, holes, pragmas, `%cg` on one line.
  "f x' α₁ 𝑥 = Data.Vect.fromList x.field _foo __LOC__ ?h_1 ?a.b %inline M.do A.B.do a.do\n%cg chez {x}\n",
  // Brackets over lines: an idiom bracket whose `|]` is on the next line, a stray closer, a mismatched one.
  'f = [| g\n  x |] <*> [ y |]\n',
  'f = (a\n  ]\nb) )\n',
  'f = .( x ) @{ y } `( z ) `{ w } `[ v ] [< u ] [> t ]\n',
  // Numbers.
  'n = 1.5e3 0x1F 0XfF 0b1_01 0o17 1_000 1.5e 12abc 1. .5\n',
];

/** A generator of adversarial texts: lines of atoms that start and end lexemes, joined without spaces or with one. */
const ATOMS: readonly string[] = [
  '"', '"', "'", "'", '\\', '\\', '{', '}', '-', '-', '--', '{-', '-}', '(', ')', '[', ']', '|', '|]', '[|', '#', '##', '"""',
  ' ', ' ', '  ', '\u00a0', '\u000c', '\u000b', 'a', "x'", 'α', '𝑥', 'X.', 'M.do', 'do', 'of', 'where', 'let', '0x1', '1.5',
  '?h', '%cg', '%foreign', '|||', '`[', '`', '\\{', '_', ';', '.(', '@{', 'NUL', 'x41', "'\\''", "'\"'", "'\\\\'", "'\\x41'",
  "'\\NUL'", '"a\\"b"', '#"a"b"#', '-->', '--}', '<->', '=', ':', ',',
];

function generated(count: number, seed: number): string[] {
  // mulberry32
  let s = seed >>> 0;
  const random = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const texts: string[] = [];
  for (let n = 0; n < count; n++) {
    const lines: string[] = [];
    const lineCount = 1 + Math.floor(random() * 5);
    for (let l = 0; l < lineCount; l++) {
      let line = '';
      const atoms = Math.floor(random() * 10);
      for (let a = 0; a < atoms; a++) {
        line += ATOMS[Math.floor(random() * ATOMS.length)] + (random() < 0.3 ? ' ' : '');
      }
      lines.push(line);
    }
    texts.push(lines.join('\n'));
  }
  return texts;
}

suite('core/idrisSyntax line reader against lex', () => {
  test('every line of every fixture (literate files raw too)', () => {
    const problems: string[] = [];
    let files = 0;
    for (const file of sourceFiles(fixtures)) {
      files++;
      problems.push(...lineDifferences(fs.readFileSync(file, 'utf8'), path.relative(repoRoot(), file), 3).problems);
    }
    assert.ok(files > 50, `${files} fixtures`);
    assert.deepStrictEqual(problems, []);
  });

  test('curated texts where a line break meets a lexeme', () => {
    const problems = CURATED.flatMap((text, i) => lineDifferences(text, `curated#${i}`).problems);
    assert.deepStrictEqual(problems, []);
  });

  test('a character literal that a line break cuts, which the next line does not close, is the one difference (code the compiler rejects)', () => {
    assert.strictEqual(lineDifferences("x = '\ny\nz = '\\\nw\n", 'cut').cutChars, 2);
    assert.strictEqual(lineDifferences("x = '\n' + y\nz = '\\\n'\n", 'closed').cutChars, 0);
  });

  test('generated texts (20,000, seeded)', function () {
    this.timeout(60_000);
    const problems: string[] = [];
    for (const [i, text] of generated(20_000, 0x1d415).entries()) {
      problems.push(...lineDifferences(text, `generated#${i} ${JSON.stringify(text)}`, 1).problems);
      if (problems.length >= 5) {
        break;
      }
    }
    assert.deepStrictEqual(problems, []);
  });
});
