/**
 * Tests of syntaxes/idris2.tmLanguage.json (scope source.idris2): the generated file is current
 * and internally consistent, every fixture in test/fixtures/grammar/*.idr matches its snapshot,
 * and targeted assertions pin each lexical construct, including the cases where the Idris 2
 * lexer does something surprising (test/grammar/idris2-scopes.md lists them).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import {
  endStateIsRoot,
  grammarFor,
  hasScope,
  matchSnapshot,
  repoRoot,
  scopesAt,
  tokenizeFile,
  tokenizeText,
  TokenizeResult,
} from './harness';

const SCOPE = 'source.idris2';
const GRAMMAR_FILE = path.join(repoRoot, 'syntaxes', 'idris2.tmLanguage.json');
const FIXTURES = path.join(repoRoot, 'test', 'fixtures', 'grammar');

/**
 * `data` declarations are regions that last while lines are indented past the `data` line, so
 * a file that ends inside one ends with that region open. One column-0 line that is not a
 * comment ends such a region once nothing is open inside it, so a complete file must be back at
 * the root after it.
 */
async function endsAtRoot(text: string): Promise<boolean> {
  const closed = text.endsWith('\n') ? `${text}x` : `${text}\nx`;
  return endStateIsRoot(await tokenizeText(SCOPE, closed));
}

/** The position of the `nth` occurrence (0-based) of `needle` in `text`, plus `offset`. */
function find(text: string, needle: string, nth = 0, offset = 0): { line: number; col: number } {
  let index = -1;
  for (let i = 0; i <= nth; i++) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) {
      throw new Error(`"${needle}" occurs fewer than ${nth + 1} times in ${JSON.stringify(text)}`);
    }
  }
  index += offset;
  const before = text.slice(0, index);
  const line = before.split('\n').length - 1;
  return { line, col: index - (before.lastIndexOf('\n') + 1) };
}

interface At {
  readonly nth?: number;
  readonly offset?: number;
}

async function scopesOf(text: string, needle: string, at: At = {}): Promise<readonly string[]> {
  const { line, col } = find(text, needle, at.nth, at.offset);
  return scopesAt(await tokenizeText(SCOPE, text), line, col);
}

/** Asserts that the token at `needle` carries `scope` (or a scope below it). */
async function expectScope(text: string, needle: string, scope: string, at: At = {}): Promise<void> {
  const scopes = await scopesOf(text, needle, at);
  assert.ok(hasScope(scopes, scope), `"${needle}" in ${JSON.stringify(text)}: expected ${scope}, got ${scopes.join(' ')}`);
}

/** Asserts that the token at `needle` carries no scope at or below `scope`. */
async function expectNoScope(text: string, needle: string, scope: string, at: At = {}): Promise<void> {
  const scopes = await scopesOf(text, needle, at);
  assert.ok(!hasScope(scopes, scope), `"${needle}" in ${JSON.stringify(text)}: unexpected ${scope} in ${scopes.join(' ')}`);
}

/** Asserts that the token at `needle` has only the root scope (a plain identifier). */
async function expectPlain(text: string, needle: string, at: At = {}): Promise<void> {
  const scopes = await scopesOf(text, needle, at);
  assert.deepStrictEqual(scopes, [SCOPE], `"${needle}" in ${JSON.stringify(text)}: expected no scope, got ${scopes.join(' ')}`);
}

/** Every `name`/`contentName` in a grammar object. */
function grammarScopes(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((n) => grammarScopes(n, into));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'name' || key === 'contentName') && typeof value === 'string') {
        into.add(value);
      } else {
        grammarScopes(value, into);
      }
    }
  }
  return into;
}

function allScopes(result: TokenizeResult): string[] {
  return result.lines.flatMap((l) => l.tokens.flatMap((t) => t.scopes));
}

/** Asserts that `text` ends back at the root rule and that no token has an `invalid` scope. */
async function expectClean(text: string): Promise<void> {
  const result = await tokenizeText(SCOPE, text);
  assert.ok(endStateIsRoot(result), `${JSON.stringify(text)}: not at root`);
  assert.deepStrictEqual(allScopes(result).filter((sc) => sc.startsWith('invalid')), [], JSON.stringify(text));
}

// ---------------------------------------------------------------------------------------------

suite('idris2 grammar: generated file', () => {
  const grammar = JSON.parse(fs.readFileSync(GRAMMAR_FILE, 'utf8')) as {
    repository: Record<string, unknown>;
    patterns: unknown[];
  };

  test('syntaxes/idris2.tmLanguage.json is what scripts/build-grammar.mjs generates', () => {
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-grammar.mjs'), '--check'], {
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  });

  test('every include names a repository rule, and every repository rule is included', () => {
    const included = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(collect);
      } else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === 'include' && typeof value === 'string') {
            included.add(value);
          } else {
            collect(value);
          }
        }
      }
    };
    collect(grammar);
    const keys = Object.keys(grammar.repository);
    const dangling = [...included].filter((i) => !(i.startsWith('#') && keys.includes(i.slice(1))));
    assert.deepStrictEqual(dangling, [], 'includes without a repository rule');
    const unused = keys.filter((k) => !included.has(`#${k}`));
    assert.deepStrictEqual(unused, [], 'repository rules nothing includes');
  });

  test('every regex compiles with the Oniguruma build used by vscode-textmate', async () => {
    await grammarFor(SCOPE); // loads the WebAssembly module
    const failures: string[] = [];
    const visit = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => visit(n, `${where}[${i}]`));
      } else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (['match', 'begin', 'end', 'while'].includes(key) && typeof value === 'string') {
            // vscode-textmate substitutes back-references in end/while before compiling.
            const source = key === 'end' || key === 'while' ? value.replace(/\\[0-9]/g, 'x') : value;
            try {
              new oniguruma.OnigScanner([source]).dispose();
            } catch (e) {
              failures.push(`${where}.${key}: ${(e as Error).message}`);
            }
          } else {
            visit(value, `${where}.${key}`);
          }
        }
      }
    };
    visit(grammar, '');
    assert.deepStrictEqual(failures, []);
  });

  test('every scope ends in .idris2, and test/grammar/idris2-scopes.md lists exactly the emitted scopes', () => {
    const emitted = grammarScopes([grammar.patterns, grammar.repository]); // not the display name
    assert.deepStrictEqual([...emitted].filter((s) => !s.endsWith('.idris2')), []);
    const doc = fs.readFileSync(path.join(repoRoot, 'test', 'grammar', 'idris2-scopes.md'), 'utf8');
    const documented = new Set([...doc.matchAll(/^\| `([a-z0-9.-]+\.idris2)` \|/gm)].map((m) => m[1]));
    assert.deepStrictEqual([...emitted].filter((s) => !documented.has(s)).sort(), [], 'emitted but not documented');
    assert.deepStrictEqual([...documented].filter((s) => !emitted.has(s)).sort(), [], 'documented but not emitted');
  });
});

suite('idris2 grammar: fixtures', () => {
  const fixtures = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.idr')).sort();

  test('the fixture directory has .idr fixtures', () => {
    assert.ok(fixtures.length >= 10, `only ${fixtures.length} fixtures`);
  });

  for (const name of fixtures) {
    test(`${name}: snapshot, root end state, no invalid scope`, async () => {
      const file = path.join(FIXTURES, name);
      const result = await tokenizeFile(file);
      matchSnapshot(file, result);
      assert.ok(await endsAtRoot(fs.readFileSync(file, 'utf8')), 'the rule stack is not back at the root');
      const invalid = result.lines.flatMap((l, n) =>
        l.tokens.filter((t) => hasScope(t.scopes, 'invalid')).map((t) => `${n}:${t.startIndex} ${t.text}`),
      );
      assert.deepStrictEqual(invalid, []);
      assert.deepStrictEqual(allScopes(result).filter((s) => s !== SCOPE && !s.endsWith('.idris2')), []);
    });
  }
});

suite('idris2 grammar: keywords', () => {
  // src/Parser/Lexer/Source.idr 187-202 (identical in v0.8.0): keywords ++ fixityKeywords ++ totality.
  const LEXER_KEYWORDS = [
    'data', 'module', 'where', 'let', 'in', 'do', 'record', 'auto', 'default', 'implicit', 'failing',
    'mutual', 'namespace', 'parameters', 'with', 'proof', 'impossible', 'case', 'of', 'if', 'then',
    'else', 'forall', 'rewrite', 'typebind', 'autobind', 'using', 'interface', 'implementation',
    'open', 'import', 'public', 'export', 'private', 'infixl', 'infixr', 'infix', 'prefix', 'total',
    'partial', 'covering',
  ];

  test('each of the lexer\'s 41 keywords is a keyword or storage scope wherever it stands', async () => {
    assert.strictEqual(LEXER_KEYWORDS.length, 41);
    for (const kw of LEXER_KEYWORDS) {
      const scopes = await scopesOf(`x ${kw} y`, kw);
      assert.ok(hasScope(scopes, 'keyword') || hasScope(scopes, 'storage'), `${kw}: ${scopes.join(' ')}`);
    }
  });

  test('Idris 1 keywords and other non-keywords are plain identifiers', async () => {
    for (const word of ['class', 'instance', 'codata', 'dsl', 'syntax', 'tactics', 'postulate', 'constructor', 'as', 'Type0']) {
      await expectPlain(`x ${word} y`, word);
    }
  });

  test('a keyword followed by an identifier character is an identifier', async () => {
    await expectPlain("f data' x", "data'");
    await expectPlain('f where_ x', 'where_');
    await expectPlain('f total2 x', 'total2');
  });

  test('keyword groups', async () => {
    await expectScope('f = if b then 1 else 2', 'then', 'keyword.control.conditional.idris2');
    await expectScope('f = case x of y => y', 'of', 'keyword.control.case.idris2');
    await expectScope('f = let x = 1 in x', 'in', 'keyword.control.let.idris2');
    await expectScope('f x with (x) proof p', 'proof', 'keyword.control.with.idris2');
    await expectScope('f Z impossible', 'impossible', 'keyword.control.impossible.idris2');
    await expectScope('public export', 'public', 'storage.modifier.visibility.idris2');
    await expectScope('total', 'total', 'storage.modifier.totality.idris2');
    await expectScope('covering', 'covering', 'storage.modifier.totality.idris2');
    await expectScope('mutual', 'mutual', 'keyword.other.mutual.idris2');
    await expectScope('failing "msg"', 'failing', 'keyword.other.failing.idris2');
    await expectScope('open', 'open', 'keyword.other.reserved.idris2');
  });

  test('a qualified `do` is a do block; a keyword after a projection dot is a field', async () => {
    await expectScope('m = M.do pure x', 'do', 'keyword.control.do.idris2');
    await expectScope('m = M.do pure x', 'M', 'entity.name.namespace.idris2');
    await expectScope('y = x.data', 'data', 'variable.other.member.idris2');
  });
});

suite('idris2 grammar: comments', () => {
  test('"--" starts a comment, even when an operator could continue; "--}" does not', async () => {
    await expectScope('x = y --> z', '-->', 'comment.line.double-dash.idris2');
    await expectScope('x = y ---- z', 'z', 'comment.line.double-dash.idris2');
    await expectScope('x = y--z', 'z', 'comment.line.double-dash.idris2');
    await expectScope('x = y >-- z', '>--', 'keyword.operator.idris2');
    await expectNoScope('x = y >-- z', 'z', 'comment');
    await expectNoScope('x = 1 --}', '--}', 'comment');
  });

  test('"--" inside a string or a char literal is not a comment', async () => {
    await expectScope('s = "a -- b" ++ c', 'b', 'string.quoted.double.idris2');
    await expectNoScope('s = "a -- b" ++ c', 'c', 'comment');
    await expectNoScope("c = '-' -- x", "'-'", 'comment');
  });

  test('"|||" at a token start is a documentation comment, also mid-line; inside an operator it is not', async () => {
    await expectScope('||| Docs', 'Docs', 'comment.line.documentation.idris2');
    await expectScope('x = a ||| b', 'b', 'comment.line.documentation.idris2');
    await expectScope('x = a >||| b', '>|||', 'keyword.operator.idris2');
    await expectNoScope('x = a >||| b', 'b', 'comment');
  });

  test('block comments nest to depth 3 and code resumes after the last close', async () => {
    const text = '{- 1 {- 2 {- 3 -} 2 -} 1 -} code';
    const depth = (scopes: readonly string[]): number => scopes.filter((s) => s === 'comment.block.idris2').length;
    assert.strictEqual(depth(await scopesOf(text, '3')), 3);
    assert.strictEqual(depth(await scopesOf(text, '2', { nth: 1 })), 2);
    assert.strictEqual(depth(await scopesOf(text, '1', { nth: 1 })), 1);
    await expectPlain(text, 'code');
  });

  test('"--" inside a block comment hides the rest of its line, including "-}"', async () => {
    const text = '{- a -- b -} c\n d -} e';
    await expectScope(text, 'c', 'comment.block.idris2');
    await expectScope(text, 'd', 'comment.block.idris2');
    await expectPlain(text, 'e');
  });

  test('strings and char literals inside a block comment are skipped', async () => {
    await expectScope('{- "-}" x -} y', 'x', 'comment.block.idris2');
    await expectPlain('{- "-}" x -} y', 'y');
    await expectPlain(`{- '"' -} y`, 'y');
    await expectScope('{- "a\n-} b" c -} d', 'c', 'comment.block.idris2');
    await expectPlain('{- "a\n-} b" c -} d', 'd');
  });

  test('"{-}" opens a comment at top level but opens and closes one inside a comment', async () => {
    await expectScope('{-} x\ny', 'y', 'comment.block.idris2');
    await expectScope('{--} x\ny', 'y', 'comment.block.idris2');
    await expectPlain('{- {-} {--} -} y', 'y');
  });
});

suite('idris2 grammar: names, holes and identifiers', () => {
  test('"?name" is a hole; "?" alone is the reserved symbol; inside an operator it is not a hole', async () => {
    await expectScope('f = ?rhs', 'rhs', 'variable.other.hole.idris2');
    await expectScope('f = ?rhs', '?', 'punctuation.definition.hole.idris2');
    await expectScope("f = ?in_1'", "in_1'", 'variable.other.hole.idris2');
    await expectScope('x : ?', '?', 'keyword.operator.infer.idris2');
    await expectScope('x = a >?b', '>?', 'keyword.operator.idris2');
    await expectPlain('x = a >?b', 'b');
  });

  test("primes belong to identifiers; a quote at a token start is a char literal", async () => {
    await expectPlain("f x' = x'", "x'");
    await expectPlain("f x'y' = 1", "x'y'");
    await expectScope("f x' = 'a'", "'a'", 'constant.character.idris2');
  });

  test('"_x" is the wildcard followed by the identifier x', async () => {
    await expectScope('f _x = 1', '_', 'variable.language.wildcard.idris2');
    await expectPlain('f _x = 1', 'x', { offset: 0, nth: 0 });
  });

  test('Unicode identifiers, and a Unicode arrow is an identifier (F18)', async () => {
    await expectPlain('f α x₁ = ℕ', 'α');
    await expectPlain('f α x₁ = ℕ', 'x₁');
    await expectPlain('f α x₁ = ℕ', 'ℕ');
    await expectPlain('f = a → b', '→');
    await expectScope('α : ℕ', 'α', 'entity.name.function.idris2');
  });

  test('qualified names: namespace parts, operators and projections', async () => {
    await expectScope('x = Data.List.length xs', 'Data', 'entity.name.namespace.idris2');
    await expectScope('x = Data.List.length xs', 'List', 'entity.name.namespace.idris2');
    await expectPlain('x = Data.List.length xs', 'length');
    await expectScope('x = Prelude.Ops.(+) 1', 'Ops', 'entity.name.namespace.idris2');
    await expectScope('x = Prelude.Ops.(+) 1', '+', 'keyword.operator.idris2');
    await expectScope('x = p.fst', 'fst', 'variable.other.member.idris2');
    await expectScope('x = p .fst', '.', 'punctuation.accessor.idris2');
    await expectScope('x = map (.fst) ps', 'fst', 'variable.other.member.idris2');
    await expectScope('x = f . g', '.', 'keyword.operator.idris2');
  });

  test('"%hide Ns.infixl.(op)" hides a fixity: the last part before ".(" is the fixity', async () => {
    const hide = '%hide Prelude.Ops.infixl.(+)';
    await expectScope(hide, 'Ops', 'entity.name.namespace.idris2');
    await expectScope(hide, 'infixl', 'keyword.other.fixity.idris2');
    await expectScope(hide, '+', 'keyword.operator.idris2');
    await expectScope('%hide A.prefix.(-)', 'prefix', 'keyword.other.fixity.idris2');
    await expectPlain('%hide Prelude.Types.elem', 'elem');
  });

  test('reserved names and magic constants', async () => {
    for (const t of ['Type', 'Int', 'Integer', 'Bits64', 'String', 'Char', 'Double']) {
      await expectScope(`f : ${t}`, t, 'support.type.primitive.idris2');
    }
    await expectScope('f : Lazy a', 'Lazy', 'support.type.idris2');
    await expectScope('f = Force x', 'Force', 'support.function.idris2');
    await expectScope('f = __LOC__', '__LOC__', 'constant.language.debug-info.idris2');
  });
});

suite('idris2 grammar: literals', () => {
  test('integer and double literal forms', async () => {
    await expectScope('x = 1_000', '1_000', 'constant.numeric.integer.decimal.idris2');
    await expectScope('x = 0xFF_FF', '0xFF_FF', 'constant.numeric.integer.hexadecimal.idris2');
    await expectScope('x = 0XAB', '0XAB', 'constant.numeric.integer.hexadecimal.idris2');
    await expectScope('x = 0o7_7', '0o7_7', 'constant.numeric.integer.octal.idris2');
    await expectScope('x = 0b1010_1', '0b1010_1', 'constant.numeric.integer.binary.idris2');
    await expectScope('x = 1.5e-3', '1.5e-3', 'constant.numeric.float.idris2');
  });

  test('forms the lexer splits in two', async () => {
    const tokens = async (text: string): Promise<string[]> =>
      (await tokenizeText(SCOPE, text)).lines[0].tokens.map((t) => t.text).filter((t) => t.trim() !== '');
    assert.deepStrictEqual(await tokens('1.0E5'), ['1.0', 'E5']);
    assert.deepStrictEqual(await tokens('0B1'), ['0', 'B1']);
    assert.deepStrictEqual(await tokens('0x_FF'), ['0', 'x_FF']);
    assert.deepStrictEqual(await tokens('1..5'), ['1', '..', '5']);
  });

  test('char literals and their escapes', async () => {
    for (const lit of ["'a'", "'\\n'", "'\\''", "'\\\\'", "'\\x41'", "'\\o101'", "'\\65'", "'\\NUL'", "'\\SOH'", "'\\DEL'", "'λ'"]) {
      await expectScope(`c = ${lit}`, lit, 'constant.character.idris2');
      if (lit.includes('\\')) {
        await expectScope(`c = ${lit}`, lit, 'constant.character.escape.idris2', { offset: 1 });
      }
    }
  });

  test('0 and 1 are multiplicities before a bound name and numbers elsewhere', async () => {
    await expectScope('f : (0 x : A) -> B', '0', 'storage.modifier.multiplicity.idris2');
    await expectScope('f : {auto 0 p : P} -> B', '0', 'storage.modifier.multiplicity.idris2');
    await expectScope('f : (1 x, y : A) -> B', '1', 'storage.modifier.multiplicity.idris2');
    await expectScope('f = \\0 x => x', '0', 'storage.modifier.multiplicity.idris2');
    await expectScope('f = let 1 k = n in k', '1', 'storage.modifier.multiplicity.idris2');
    await expectScope('0 T : Type', '0', 'storage.modifier.multiplicity.idris2');
    await expectScope('  1 v <- action', '1', 'storage.modifier.multiplicity.idris2');
    await expectScope('f n with 0 (n)', '0', 'storage.modifier.multiplicity.idris2');
    await expectScope('f = g 0 x', '0', 'constant.numeric.integer.decimal.idris2');
    await expectScope('f : Vect 0 a -> Nat', '0', 'constant.numeric.integer.decimal.idris2');
    await expectScope('f = [0, 1]', '1', 'constant.numeric.integer.decimal.idris2');
    // defaultImplicitPi: the value comes before the optional multiplicity.
    await expectScope('f : {default 0 k : Nat} -> Nat', '0', 'constant.numeric.integer.decimal.idris2');
    await expectScope('f : {default 0 k : Nat} -> Nat', 'k', 'variable.parameter.idris2');
  });

  test('0 or 1 alone on a column-0 line is the multiplicity of the claim that follows', async () => {
    // "0" / "zeroVal : Nat" / "zeroVal = 3" checks, and using zeroVal in a clause is rejected as
    // "not accessible in this context" (test/fixtures/grammar/Declarations.idr has the form).
    const lone = '0\nzeroVal : Nat\nzeroVal = 3';
    await expectScope(lone, '0', 'storage.modifier.multiplicity.idris2');
    await expectScope(lone, 'zeroVal', 'entity.name.function.idris2');
    await expectScope('1 -- linear\nv : Nat', '1', 'storage.modifier.multiplicity.idris2');
    // Indented, it may be an argument on a continuation line.
    await expectScope('g = f 0\n  1', '1', 'constant.numeric.integer.decimal.idris2');
    await expectScope('g = f\n  0\nh : Nat', '0', 'constant.numeric.integer.decimal.idris2');
    await expectScope('xs = [ 1\n, 0\n]', '0', 'constant.numeric.integer.decimal.idris2');
  });

  test('0 and 1 start a binding only where a statement starts', async () => {
    const comprehension = 'p top = [(x, y) | y <- upTo 1 top, x <- upTo 1 y]';
    await expectScope(comprehension, '1', 'constant.numeric.integer.decimal.idris2');
    await expectScope(comprehension, '1', 'constant.numeric.integer.decimal.idris2', { nth: 1 });
    await expectScope('f = do 1 x <- a', '1', 'storage.modifier.multiplicity.idris2');
    await expectScope('f = do 1 x <- a', 'do', 'keyword.control.do.idris2');
    await expectScope('g = do { a; 1 y <- b }', '1', 'storage.modifier.multiplicity.idris2');
    await expectScope('h = f 1 x <- a', '1', 'constant.numeric.integer.decimal.idris2');
  });
});

suite('idris2 grammar: strings', () => {
  test('escapes and interpolation in a plain string', async () => {
    const text = 's = "a\\tb \\{show x} c"';
    await expectScope(text, '\\t', 'constant.character.escape.idris2');
    await expectScope(text, '\\{', 'punctuation.section.embedded.begin.idris2');
    await expectScope(text, 'show', 'meta.embedded.line.idris2');
    await expectScope(text, '}', 'punctuation.section.embedded.end.idris2');
    await expectScope(text, 'c', 'string.quoted.double.idris2');
    await expectNoScope(text, 'c', 'meta.interpolation');
  });

  test('an interpolation containing a string with a brace, a char literal and braces', async () => {
    const text = 's = "a \\{ "}" } b \\{ f {x = \'}\'} } c"';
    await expectScope(text, '}', 'string.quoted.double.idris2', { nth: 0 });
    await expectScope(text, '}', 'punctuation.section.embedded.end.idris2', { nth: 1 });
    await expectScope(text, 'b', 'string.quoted.double.idris2');
    await expectNoScope(text, 'b', 'meta.interpolation');
    await expectScope(text, "'}'", 'constant.character.idris2');
    await expectScope(text, '}', 'punctuation.section.braces.end.idris2', { nth: 3 });
    await expectScope(text, '}', 'punctuation.section.embedded.end.idris2', { nth: 4 });
    await expectNoScope(text, 'c', 'meta.interpolation');
    assert.ok(endStateIsRoot(await tokenizeText(SCOPE, text)));
  });

  test('"\\\\{" is an escaped backslash, not an interpolation', async () => {
    await expectScope('s = "\\\\{x}"', '\\\\', 'constant.character.escape.idris2');
    await expectNoScope('s = "\\\\{x}"', 'x', 'meta.interpolation');
  });

  test('raw strings: the closing delimiter needs the hashes, and escapes need them too', async () => {
    const text = 's = ##"a"#b \\n \\##n \\#{no} \\##{x}"## ++ t';
    await expectScope(text, 'b', 'string.quoted.double.raw.idris2');
    await expectNoScope(text, '\\n', 'constant.character.escape');
    await expectScope(text, '\\##n', 'constant.character.escape.idris2');
    await expectNoScope(text, 'no', 'meta.interpolation');
    await expectScope(text, 'x', 'meta.interpolation.idris2');
    await expectPlain(text, 't');
    await expectScope('s = #"say "hi""#', 'hi', 'string.quoted.double.raw.idris2');
    await expectScope('s = ####"a"### b"####', 'b', 'string.quoted.double.raw.idris2');
    await expectPlain('s = ####"a"### b"#### ++ t', 't');
  });

  test('multi-line strings, raw and plain', async () => {
    const text = 's = """\n  a "q" \\{x}\n  """\nt = #"""\n  """ \\#{y}\n  """#\nu = 1';
    await expectScope(text, 'a', 'string.quoted.triple.idris2');
    await expectScope(text, 'x', 'meta.interpolation.idris2');
    await expectScope(text, '"""', 'string.quoted.triple.raw.idris2', { nth: 3 });
    await expectScope(text, 'y', 'meta.interpolation.idris2');
    await expectPlain(text, 'u');
  });

  test('a single-line string that is not closed ends at the end of its line', async () => {
    await expectPlain('s = "abc\nt = 1', 't');
  });

  test('an interpolation may span lines inside a single-line string', async () => {
    const text = 's = "a \\{ show\n  x } b"\nt = 1';
    await expectScope(text, 'x', 'meta.interpolation.idris2');
    await expectScope(text, 'b', 'string.quoted.double.idris2');
    await expectPlain(text, 't');
  });
});

suite('idris2 grammar: declarations', () => {
  test('module header and imports', async () => {
    await expectScope('module Data.Foo', 'Foo', 'entity.name.namespace.idris2');
    const imp = 'import public Data.Vect as V';
    await expectScope(imp, 'import', 'keyword.control.import.idris2');
    await expectScope(imp, 'public', 'storage.modifier.visibility.idris2');
    await expectScope(imp, 'Vect', 'entity.name.namespace.idris2');
    await expectScope(imp, 'as', 'keyword.other.as.idris2');
    await expectScope(imp, 'V', 'entity.name.namespace.idris2', { nth: 1 });
    await expectScope('import Data.Vect', '.', 'punctuation.separator.namespace.idris2');
  });

  test('signatures: names, operators, modifiers and multiplicities', async () => {
    await expectScope('map : (a -> b) -> List a -> List b', 'map', 'entity.name.function.idris2');
    await expectScope('  helper, other : Nat', 'other', 'entity.name.function.idris2');
    await expectScope('(++) : a -> a -> a', '++', 'entity.name.function.idris2');
    await expectScope('export %inline f : Nat', 'f', 'entity.name.function.idris2');
    await expectScope('export %inline f : Nat', '%inline', 'keyword.other.directive.idris2');
    await expectScope('public export 0 T : Type', 'T', 'entity.name.function.idris2');
    await expectScope('Dest : Edge a -> a', 'Dest', 'entity.name.function.idris2');
    await expectNoScope('f x = x :: xs', 'f', 'entity.name');
    await expectNoScope('  x :: xs', 'x', 'entity.name');
  });

  test('data declarations: type name, GADT and simple constructors', async () => {
    const gadt = 'data Vect : Nat -> Type -> Type where\n  Nil : Vect 0 a\n  (::) : a -> Vect n a -> Vect (S n) a\nf : Nat';
    await expectScope(gadt, 'Vect', 'entity.name.type.data.idris2');
    await expectScope(gadt, 'Nil', 'entity.name.function.constructor.idris2');
    await expectScope(gadt, '::', 'entity.name.function.constructor.idris2');
    await expectScope(gadt, 'f', 'entity.name.function.idris2');
    const simple = 'data Colour = Red | Green\n  | Blue\nf : Nat';
    await expectScope(simple, 'Red', 'entity.name.function.constructor.idris2');
    await expectScope(simple, 'Blue', 'entity.name.function.constructor.idris2');
    await expectScope(simple, 'f', 'entity.name.function.idris2');
    const documented = 'data Edge a\n  = ||| doc\n    (~>) a a';
    await expectScope(documented, '~>', 'entity.name.function.constructor.idris2');
    const blank = 'data T where\n  A : T\n\n  ||| doc\n  B : T';
    await expectScope(blank, 'B', 'entity.name.function.constructor.idris2');
    await expectScope('data T : Type where [noHints, search x]', 'noHints', 'keyword.other.data-option.idris2');
    await expectScope('data T : Type where [noHints, search x]', 'search', 'keyword.other.data-option.idris2');
  });

  test('data options on a line after "where", also after comment lines, in data and record bodies', async () => {
    // Both forms check (test/fixtures/grammar/Declarations.idr); Idris 2 0.8.0's prelude/Builtin.idr:124 has the first.
    const data = 'data Rel : Nat -> Type where -- note\n\n  {- options -}\n  [search n]\n  MkRel : Rel n\nnext : Nat';
    await expectScope(data, 'search', 'keyword.other.data-option.idris2');
    await expectScope(data, '[', 'punctuation.section.brackets.begin.idris2');
    await expectNoScope(data, '[', 'meta.brackets');
    await expectScope(data, 'MkRel', 'entity.name.function.constructor.idris2');
    await expectScope(data, 'next', 'entity.name.function.idris2');
    await expectNoScope(data, 'next', 'meta.declaration.data');
    const rec = 'record R where\n  [noHints]\n  constructor MkR\n  val : Nat';
    await expectScope(rec, 'noHints', 'keyword.other.data-option.idris2');
    await expectScope(rec, 'constructor', 'keyword.other.constructor.idris2');
    await expectScope(rec, 'val', 'entity.name.function.idris2');
    // A column-0 doc comment still ends an empty data declaration; a list in a where block is a list.
    await expectNoScope('data E : Type where\n\n||| doc\nf : Nat', 'doc', 'meta.declaration.data');
    const list = 'f = g\n  where\n    xs : List Nat\n    xs = [search, external]';
    await expectScope(list, 'xs', 'entity.name.function.idris2');
    await expectNoScope(list, 'search', 'keyword.other.data-option');
  });

  test('comments do not end a data declaration, even where they reach column 0', async () => {
    // Each case passes idris2 --check 0.8.0 (test/fixtures/grammar/Layout.idr holds them).
    const block = 'data T = A\n  {- a comment that\nspans column 0 = B | C -}\n  | B\nf : T';
    await expectScope(block, 'spans', 'comment.block.idris2');
    await expectScope(block, '-}', 'punctuation.definition.comment.end.idris2');
    await expectScope(block, 'B', 'entity.name.function.constructor.idris2', { nth: 1 });
    await expectScope(block, 'f', 'entity.name.function.idris2');
    await expectClean(block);
    const gadt = 'data U : Type where\n  UA : U\n  {- note\nx : U -}\n  UB : U\nf : U';
    await expectScope(gadt, 'x', 'comment.block.idris2');
    await expectScope(gadt, 'UB', 'entity.name.function.constructor.idris2');
    await expectClean(gadt);
    const between = 'data Op = Add\n        | Sub\n{-\n        | Mul\n-}\n        | Div\n-- | Pow\n        | Neg\nops : List Op';
    await expectScope(between, 'Mul', 'comment.block.idris2');
    await expectScope(between, 'Div', 'entity.name.function.constructor.idris2');
    await expectScope(between, 'Neg', 'entity.name.function.constructor.idris2');
    await expectScope(between, 'ops', 'entity.name.function.idris2');
    const lineComment = 'data Bar : Type where\n  MkBar : Bar\n-- a column-0 comment\n  MkBaz : Bar';
    await expectScope(lineComment, 'MkBaz', 'entity.name.function.constructor.idris2');
  });

  test('a data declaration ends at a column-0 line, also without a space after its name', async () => {
    const tight = 'data Foo=A\n  | B\nf : Nat';
    await expectScope(tight, 'A', 'entity.name.function.constructor.idris2');
    await expectScope(tight, 'B', 'entity.name.function.constructor.idris2');
    await expectScope(tight, 'f', 'entity.name.function.idris2');
    await expectNoScope(tight, 'f', 'meta.declaration.data');
  });

  test('a data declaration in quoted declarations ends before the closing "]"', async () => {
    const quoted = 'x = `[ data Q = QA | QB ]\ny = 1';
    await expectScope(quoted, ']', 'punctuation.section.quote.end.idris2');
    await expectNoScope(quoted, 'y', 'meta.quote');
    await expectClean(quoted);
    const quoted2 = 'x = `[ data R = RA\n              | RB ]\ny = 1';
    await expectScope(quoted2, 'RB', 'entity.name.function.constructor.idris2');
    await expectScope(quoted2, ']', 'punctuation.section.quote.end.idris2');
    await expectClean(quoted2);
  });

  test('a declaration right after "where" on the same line', async () => {
    await expectScope('f x = go x where go : Nat -> Nat', 'go', 'entity.name.function.idris2', { nth: 1 });
    await expectScope('interface Nice a where nice : a -> a', 'nice', 'entity.name.function.idris2');
    await expectScope('g = h\n  where 0 E : Type', '0', 'storage.modifier.multiplicity.idris2');
    await expectScope('g = h\n  where 0 E : Type', 'E', 'entity.name.function.idris2');
    const gadt = 'data T : Type where MkT, MkU : T';
    await expectScope(gadt, 'MkT', 'entity.name.function.constructor.idris2');
    await expectScope(gadt, 'MkU', 'entity.name.function.constructor.idris2');
    await expectNoScope('f = x where', 'where', 'entity.name');
  });

  test('a data declaration or claim that follows another token on its line', async () => {
    // Each checks (test/fixtures/grammar/Declarations.idr, Failing.idr and Elab.idr hold them).
    const mutual = 'mutual data Ev : Nat -> Type where\n         EvZ : Ev Z\n         EvS : Od n -> Ev (S n)\n' +
      '       data Od : Nat -> Type where\n         OdS : Ev n -> Od (S n)\n       isEv : Nat -> Bool';
    await expectScope(mutual, 'mutual', 'keyword.other.mutual.idris2');
    await expectNoScope(mutual, 'mutual', 'meta.declaration.data');
    await expectScope(mutual, 'Ev', 'entity.name.type.data.idris2');
    await expectScope(mutual, 'EvZ', 'entity.name.function.constructor.idris2');
    await expectScope(mutual, 'EvS', 'entity.name.function.constructor.idris2');
    await expectScope(mutual, 'Od', 'entity.name.type.data.idris2', { nth: 1 });
    await expectScope(mutual, 'OdS', 'entity.name.function.constructor.idris2');
    await expectScope(mutual, 'isEv', 'entity.name.function.idris2');
    await expectNoScope(mutual, 'isEv', 'meta.declaration.data');
    const where = 'f = count B\n  where data T : Type where\n          A : T\n          B : T\n        count : T -> Nat';
    await expectScope(where, 'T', 'entity.name.type.data.idris2');
    await expectScope(where, 'A', 'entity.name.function.constructor.idris2');
    await expectScope(where, 'B', 'entity.name.function.constructor.idris2', { nth: 1 });
    await expectScope(where, 'count', 'entity.name.function.idris2', { nth: 1 });
    await expectNoScope(where, 'count', 'meta.declaration.data', { nth: 1 });
    const ns = 'namespace N data U : Type where\n                 MkU : U';
    await expectScope(ns, 'N', 'entity.name.namespace.idris2');
    await expectScope(ns, 'U', 'entity.name.type.data.idris2');
    await expectScope(ns, 'MkU', 'entity.name.function.constructor.idris2');
    await expectScope('data P = PA; data Q = QA | QB', 'Q', 'entity.name.type.data.idris2');
    await expectScope('data P = PA; data Q = QA | QB', 'QB', 'entity.name.function.constructor.idris2');
    const failing = 'failing "Mismatch" bad2 : Nat\n                   bad2 = "x"';
    await expectScope(failing, 'Mismatch', 'string.quoted.double.idris2');
    await expectScope(failing, 'bad2', 'entity.name.function.idris2');
    await expectScope('failing "Undefined name" data B = MkB Missing', 'MkB', 'entity.name.function.constructor.idris2');
    await expectScope('mutual f : Nat\n       f = 1', 'f', 'entity.name.function.idris2');
    await expectScope('namespace N g : Nat\n            g = 2', 'g', 'entity.name.function.idris2');
    // In quoted declarations the data region ends at the next declaration of the quote block.
    const quoted = 'qd = `[ data Col = Red | Green\n        total\n        paint : Col -> Nat\n        paint Red = 1 ]';
    await expectScope(quoted, 'Col', 'entity.name.type.data.idris2');
    await expectScope(quoted, 'Green', 'entity.name.function.constructor.idris2');
    await expectNoScope(quoted, 'total', 'meta.declaration.data');
    await expectScope(quoted, 'paint', 'entity.name.function.idris2');
    await expectNoScope(quoted, 'paint', 'meta.declaration.data');
    await expectScope(quoted, ']', 'punctuation.section.quote.end.idris2');
    await expectClean(quoted);
    // A data declaration after ";" in explicit braces ends before the "}" (checks).
    const braces = 'h = k where { k : Nat; k = 2; data V = D }';
    await expectScope(braces, 'D', 'entity.name.function.constructor.idris2');
    await expectScope(braces, '}', 'punctuation.section.braces.end.idris2');
    await expectClean(braces);
  });

  test('the type name of a data declaration after a line break or a comment', async () => {
    // dataDeclBody reads the name with no layout check; each case checks (Declarations.idr).
    const nextLine = 'data\n  Tree : Type where\n  Leaf : Tree\n  Node : Tree -> Tree -> Tree';
    await expectScope(nextLine, 'Tree', 'entity.name.type.data.idris2');
    await expectNoScope(nextLine, 'Tree', 'entity.name.function');
    await expectScope(nextLine, 'Leaf', 'entity.name.function.constructor.idris2');
    await expectScope(nextLine, 'Node', 'entity.name.function.constructor.idris2');
    await expectScope('data {- the type -} Foo : Type where\n  MkFoo : Foo', 'Foo', 'entity.name.type.data.idris2');
    await expectScope('data {- the type -} Foo : Type where\n  MkFoo : Foo', 'the', 'comment.block.idris2');
    await expectScope('data -- the name follows\n  Foo : Type where\n  MkFoo : Foo', 'Foo', 'entity.name.type.data.idris2');
    // A type name that ends in "data" is not "data".
    const meta = 'data Metadata -- constructors on the next line\n  = Meta';
    await expectScope(meta, 'Metadata', 'entity.name.type.data.idris2');
    await expectScope(meta, 'Meta', 'entity.name.function.constructor.idris2', { nth: 1 });
  });

  test('a block comment in a declaration head', async () => {
    // Each checks (Declarations.idr); the record form is tested below.
    await expectScope('interface {- c -} Sho a where', 'Sho', 'entity.name.type.interface.idris2');
    await expectScope('interface {- c -} Sho a where', '{-', 'comment.block.idris2');
    await expectScope('namespace {- c -} NS', 'NS', 'entity.name.namespace.idris2');
    await expectScope('f {- c -} : Nat', 'f', 'entity.name.function.idris2');
    await expectScope('f {- c -} : Nat', ':', 'keyword.operator.colon.idris2');
    await expectScope('f = g\n  where h {- c -} : Nat', 'h', 'entity.name.function.idris2', { nth: 1 });
  });

  test('records, interfaces, implementations and namespaces', async () => {
    const rec = 'record Point where\n  constructor MkPoint\n  x : Nat';
    await expectScope(rec, 'Point', 'entity.name.type.record.idris2');
    await expectScope(rec, 'constructor', 'keyword.other.constructor.idris2');
    await expectScope(rec, 'MkPoint', 'entity.name.function.constructor.idris2');
    await expectScope(rec, 'x', 'entity.name.function.idris2');
    await expectScope('interface Eq a => Ord a where', 'Ord', 'entity.name.type.interface.idris2');
    await expectNoScope('interface Eq a => Ord a where', 'Eq', 'entity.name');
    await expectScope('interface Elsewhere a => Ord a where', 'Ord', 'entity.name.type.interface.idris2');
    await expectScope('implementation [rev] Ord Nat where', 'rev', 'entity.name.function.implementation.idris2');
    await expectScope('[Rev] Eq a => Ord (List a) where', 'Rev', 'entity.name.function.implementation.idris2');
    await expectNoScope('f = g\n  [x] ++ Xs', 'x', 'entity.name');
    await expectScope('namespace A.B', 'B', 'entity.name.namespace.idris2');
    await expectScope('export infixl 6 <+>', '6', 'constant.numeric.integer.decimal.idris2');
    // fixDecl takes any intLit: "infixl 0x5 +++" declares precedence 5 (verified).
    await expectScope('infixl 0x5 +++', '0x5', 'constant.numeric.integer.hexadecimal.idris2', { offset: 1 });
    await expectScope('infixr 1_0 ***', '1_0', 'constant.numeric.integer.decimal.idris2', { offset: 1 });
    await expectScope('export infixl 6 <+>', 'infixl', 'keyword.other.fixity.idris2');
    await expectScope('export typebind infixr 0 =@', 'typebind', 'storage.modifier.binding.idris2');
  });

  test('binders, named arguments and record updates', async () => {
    await expectScope('f : (x, y : A) -> B', 'y', 'variable.parameter.idris2');
    await expectScope('f : {n : Nat} -> B', 'n', 'variable.parameter.idris2');
    await expectScope('f : {auto p : P} -> B', 'p', 'variable.parameter.idris2');
    await expectScope('f = g {a = Nat} {n} x', 'a', 'variable.parameter.idris2');
    await expectScope('f = g {a = Nat} {n} x', 'n', 'variable.parameter.idris2');
    await expectScope('f = \\x, _ => x', 'x', 'variable.parameter.idris2');
    await expectScope('f : forall a, b . a', 'b', 'variable.parameter.idris2');
    await expectScope('f = (x <- e) =>> g x', 'x', 'variable.parameter.idris2');
    // dpairType: a name after "**" is bound again (test/fixtures/grammar/Expressions.idr).
    const dpair = 'f : (x : Nat ** y : Nat ** x = y) -> Nat';
    await expectScope(dpair, 'y', 'variable.parameter.idris2');
    await expectNoScope(dpair, 'x', 'variable.parameter', { nth: 1 });
    await expectScope('T = (ty : Type\n     ** make : (Nat -> ty)\n     ** ty)', 'make', 'variable.parameter.idris2');
    await expectNoScope('f (x ** y ** _) = x + y', 'y', 'variable.parameter');
    await expectNoScope('f = (a <**> b : T)', 'b', 'variable.parameter');
    // withProblem: "proof", a multiplicity, the name it binds (Expressions.idr has the first).
    await expectScope('h x with (x) proof eq', 'eq', 'variable.parameter.idris2');
    await expectScope('k x with (x) proof 1 p', '1', 'storage.modifier.multiplicity.idris2');
    await expectScope('k x with (x) proof 1 p', 'p', 'variable.parameter.idris2', { nth: 1 });
    const upd = 'f p = { x := 1, a.b $= S } p';
    await expectScope(upd, 'x', 'variable.other.member.idris2');
    await expectScope(upd, 'b', 'variable.other.member.idris2');
    await expectScope(upd, '$=', 'keyword.operator.assignment.apply.idris2');
    await expectNoScope('f = (x + y)', 'x', 'variable.parameter');
  });

  test('typed lambda binders (bindList: each binder may have a type)', async () => {
    await expectScope('f = \\x : Nat => x', 'x', 'variable.parameter.idris2');
    const two = 'f = \\x : Nat, y : Nat => x + y';
    await expectScope(two, 'x', 'variable.parameter.idris2');
    await expectScope(two, 'y', 'variable.parameter.idris2');
    await expectScope(two, ',', 'punctuation.separator.comma.idris2');
    await expectPlain(two, 'x', { nth: 1 });
    await expectScope(two, '=>', 'keyword.operator.arrow.double.idris2');
    const mixed = 'f = \\0 x : Vect 0 a, y, 1 z : (Nat, Nat) => x';
    await expectScope(mixed, '0', 'storage.modifier.multiplicity.idris2');
    await expectScope(mixed, '0', 'constant.numeric.integer.decimal.idris2', { nth: 1 });
    await expectScope(mixed, 'y', 'variable.parameter.idris2');
    await expectScope(mixed, 'z', 'variable.parameter.idris2');
    await expectNoScope(mixed, 'Nat', 'variable.parameter');
    // An unfinished typed lambda does not run past its line.
    await expectPlain('f = \\x : Nat\ny, z', 'y');
  });

  test('a lambda binds a plain name only when it starts with a lower-case ASCII letter or is "_"', async () => {
    // isPatternVariable (src/Core/Name.idr): "\X => X", "\X : Nat => X" and "\α => α" fail with
    // "Undefined name" (verified); "\Refl => Refl" matches on the constructor.
    await expectPlain('sym = \\Refl => Refl', 'Refl');
    await expectPlain('f = \\X : Nat => X', 'X');
    await expectPlain('g = \\x, Y => x', 'Y');
    await expectScope('g = \\x, Y => x', 'x', 'variable.parameter.idris2');
    await expectPlain('h = \\α => α', 'α');
    await expectScope('k = \\_ => 1', '_', 'variable.language.wildcard.idris2');
  });

  test('plain-name lambda binders next to pattern binders', async () => {
    // Each checks (test/fixtures/grammar/Expressions.idr lambdaPatterns, lambdaUnit, lambdaLinear).
    const acc = 'f = foldl (\\acc, (a, b) => acc + a + b) 0';
    await expectScope(acc, 'acc', 'variable.parameter.idris2');
    await expectNoScope(acc, '(a, b)', 'variable', { offset: 1 });
    await expectNoScope(acc, 'acc', 'variable', { nth: 1 });
    const unit = 'h = \\ (), v => v';
    await expectScope(unit, 'v', 'variable.parameter.idris2');
    await expectPlain(unit, 'v', { nth: 1 });
    const lin = 'l = \\1 (a, b) => (a, b)';
    await expectScope(lin, '1', 'storage.modifier.multiplicity.idris2');
    await expectNoScope(lin, 'a', 'variable');
  });

  test('a backslash that is part of an operator, that ends its line, or that a closing bracket follows', async () => {
    await expectScope('d = xs \\\\ ys', '\\\\', 'keyword.operator.idris2');
    await expectPlain('d = xs \\\\ ys', 'ys');
    // A lambda region ends at the end of its line, also when that comes right after the "\".
    const eol = 'f = \\\ng : Nat';
    await expectScope(eol, '\\', 'keyword.operator.lambda.idris2');
    await expectScope(eol, 'g', 'entity.name.function.idris2');
    await expectClean('f = map (\\\n  k => k) xs');
    // A closing bracket ends the lambda region, so an unfinished "(\)" still closes its group.
    const typing = 'f = map (\\) xs\ng : Nat';
    await expectScope(typing, ')', 'punctuation.section.parens.end.idris2');
    await expectScope(typing, 'g', 'entity.name.function.idris2');
    await expectClean(typing);
    await expectClean('s = "\\{g \\}"\ni = [| f \\x |]');
  });

  test('a default implicit whose value is bracketed', async () => {
    await expectScope('f : {default (S Z) n : Nat} -> Nat', 'n', 'variable.parameter.idris2');
    await expectScope('f : {default [] xs : List Nat} -> Nat', 'xs', 'variable.parameter.idris2');
    await expectScope('f : {default (replicate n 1) xs : Vect n Nat} -> Nat', 'xs', 'variable.parameter.idris2');
    await expectNoScope('f : {default (replicate n 1) xs : Vect n Nat} -> Nat', 'n', 'variable.parameter');
    await expectScope('f : {default Foo.bar.x k : T} -> Nat', 'k', 'variable.parameter.idris2');
  });

  test('a block comment between "record" and the type name or the "{" of the deprecated update', async () => {
    // Both check (test/fixtures/grammar/Declarations.idr and Expressions.idr); comments are whitespace.
    const decl = 'record {- a 2-D point -} Point where\n  constructor MkPoint';
    await expectScope(decl, '{-', 'comment.block.idris2');
    await expectScope(decl, '2', 'comment.block.idris2');
    await expectNoScope(decl, '{-', 'meta.braces');
    await expectScope(decl, 'Point', 'entity.name.type.record.idris2');
    const upd = 'f b = record {- old syntax -} { val = 1 } b';
    await expectScope(upd, 'old', 'comment.block.idris2');
    await expectScope(upd, '{', 'punctuation.section.braces.begin.idris2', { nth: 1 });
    await expectScope(upd, 'val', 'variable.other.member.idris2');
    await expectClean(upd);
    // A comment the rules do not look past (it holds a string) is still a comment, not a brace.
    const str = 'f b = record {- "s" -} { val = 1 } b';
    await expectScope(str, '{-', 'comment.block.idris2');
    await expectNoScope(str, '{-', 'meta.braces');
    await expectClean(str);
  });

  test('the deprecated "record { … }" update: fields with "=", "$=" and Idris 1 "->" paths', async () => {
    const upd = 'f r = record { a = 1, b $= S } r';
    await expectScope(upd, 'record', 'storage.type.record.idris2');
    await expectScope(upd, 'a', 'variable.other.member.idris2');
    await expectScope(upd, 'b', 'variable.other.member.idris2');
    await expectNoScope(upd, 'a', 'variable.parameter');
    const path = 'f q = record { p->a = 2 } q';
    await expectScope(path, 'p', 'variable.other.member.idris2');
    await expectScope(path, 'a', 'variable.other.member.idris2');
    await expectScope(path, '->', 'keyword.operator.arrow.idris2');
    await expectClean(path);
  });

  test('a named argument or update field on the line after a "{" or comma that ends its line', async () => {
    const named = 'x = f {\n  a = Nat,\n  b = Bool -- note\n} 1';
    await expectScope(named, 'a', 'variable.parameter.idris2');
    await expectScope(named, 'b', 'variable.parameter.idris2');
    const update = 'y = { a := 1, -- note\n\n      branch := Z } s';
    await expectScope(update, 'branch', 'variable.other.member.idris2');
    await expectNoScope(update, 'Z', 'variable');
    await expectScope('z = f {a = 1,\n       b} 2', 'b', 'variable.parameter.idris2');
    // Only the first token of the line is examined, and binders are not continued.
    await expectNoScope('z = f {a = 1,\n  g b = c}', 'g', 'variable');
    await expectNoScope('z = f {a = 1,\n  g b = c}', 'b', 'variable');
    await expectNoScope('w : {\n  n : Nat} -> Nat', 'n', 'variable.parameter');
    await expectClean(update);
    // A "," or "{" at the end of a line comment continues nothing (both check).
    await expectNoScope('u = named {n = S -- successor,\n                   three}', 'three', 'variable');
    await expectNoScope('u = named {n = S -- successor {\n                   three}', 'three', 'variable');
  });

  test('a name pun that ends its line, in leading-comma and one-per-line layouts', async () => {
    // Both check (test/fixtures/grammar/Expressions.idr punsPerLine).
    const mixed = 'w = MkR { a = 1\n        , b\n        , c = 2 }';
    await expectScope(mixed, 'b', 'variable.parameter.idris2');
    const lead = 'w = MkR { a\n        , b -- note\n        , c }';
    await expectScope(lead, 'a', 'variable.parameter.idris2');
    await expectScope(lead, 'b', 'variable.parameter.idris2');
    await expectScope(lead, 'c', 'variable.parameter.idris2');
    await expectScope('w = f {a = 1,\n       b\n      } 2', 'b', 'variable.parameter.idris2');
    await expectClean(lead);
  });

  test('comma-separated binders in parentheses: the old "parameters" syntax and "using"', async () => {
    // Both check; the old parameters syntax with a deprecation warning (test/fixtures/grammar/Declarations.idr).
    await expectScope('parameters (a : Int, b : Int)\n  f : Int', 'b', 'variable.parameter.idris2');
    const cont = 'parameters (s : Int,\n            t : Int)\n  g : Int';
    await expectScope(cont, 't : Int)', 'variable.parameter.idris2');
    await expectScope(cont, ',', 'punctuation.separator.comma.idris2');
    await expectScope(cont, 'g', 'entity.name.function.idris2');
    await expectScope('using (xs : List a, n : Nat)', 'n : Nat', 'variable.parameter.idris2');
    // A tuple continued on the next line has no binder.
    await expectNoScope('t = (a,\n     b)', 'b', 'variable');
    await expectClean(cont);
  });
});

suite('idris2 grammar: operators, brackets and pragmas', () => {
  test('reserved symbols as whole operators, and longer operators that contain them', async () => {
    const cases: [string, string][] = [
      ['->', 'keyword.operator.arrow.idris2'], ['=>', 'keyword.operator.arrow.double.idris2'],
      ['<-', 'keyword.operator.arrow.left.idris2'], [':=', 'keyword.operator.assignment.idris2'],
      ['$=', 'keyword.operator.assignment.apply.idris2'], [':', 'keyword.operator.colon.idris2'],
      ['=', 'keyword.operator.equals.idris2'], ['|', 'keyword.operator.pipe.idris2'],
      ['**', 'keyword.operator.dependent-pair.idris2'], ['..', 'keyword.operator.range.idris2'],
      ['\\', 'keyword.operator.lambda.idris2'], ['!', 'keyword.operator.bang.idris2'],
      ['@', 'keyword.operator.as-pattern.idris2'], ['~', 'keyword.operator.unquote.idris2'],
      ['&', 'keyword.operator.reserved.idris2'],
    ];
    for (const [op, scope] of cases) {
      await expectScope(`a ${op} b`, op, scope);
    }
    for (const op of ['==', '::', '<->', '>|||', '<$>', '\\\\', '...', '>>=']) {
      const scopes = await scopesOf(`a ${op} b`, op);
      assert.ok(scopes.includes('keyword.operator.idris2'), `${op}: ${scopes.join(' ')}`);
    }
  });

  test('backtick operators, including a qualified operator', async () => {
    await expectScope('x = a `div` b', 'div', 'keyword.operator.infix.idris2');
    await expectScope('x = a `Prelude.(<*>)` b', 'Prelude', 'keyword.operator.infix.idris2');
    await expectScope('x = a `Prelude.(<*>)` b', '`', 'punctuation.definition.infix.end.idris2', { nth: 1 });
    // The backtick is a token of its own: spaces may separate it from the name (verified).
    await expectScope('x = 10 ` div ` 2', 'div', 'keyword.operator.infix.idris2');
    await expectScope('x = 10 ` div ` 2', '`', 'punctuation.definition.infix.end.idris2', { nth: 1 });
  });

  test('a backtick before "(", "{" or "[" opens a quote, as the lexer reads it', async () => {
    // "10 `div`(2)" is `, div, `( to the lexer (groupSymbols come first); idris2 rejects it.
    for (const [text, open] of [['d = 10 `div`(2)', '`('], ['d = a `div`{b}', '`{'], ['d = a `div`[1]', '`[']]) {
      await expectScope(text, open, 'punctuation.section.quote.begin.idris2');
      await expectNoScope(text, 'div', 'keyword.operator.infix');
    }
  });

  test('\\case and lambda', async () => {
    await expectScope('f = \\case Z => 1', 'case', 'keyword.control.case.idris2');
    await expectScope('f = \\case Z => 1', '\\', 'keyword.operator.lambda.idris2');
  });

  test('every group symbol opens a bracket closed by its partner', async () => {
    const cases: [string, string, string][] = [
      ['x = [| f a |]', '[|', 'punctuation.section.idiom.begin.idris2'],
      ['x = Foo.[| f a |]', '.[|', 'punctuation.section.idiom.begin.idris2'],
      ['x = [< 1, 2 ]', '[<', 'punctuation.section.brackets.begin.idris2'],
      ['x = [> 1, 2 ]', '[>', 'punctuation.section.brackets.begin.idris2'],
      ['x = `(a + ~b)', '`(', 'punctuation.section.quote.begin.idris2'],
      ['x = `{Foo.bar}', '`{', 'punctuation.section.quote.begin.idris2'],
      ['x = `[ f : Nat ]', '`[', 'punctuation.section.quote.begin.idris2'],
      ['x = f @{inst} y', '@{', 'punctuation.section.braces.begin.idris2'],
      ['f n .(g n) = n', '.(', 'punctuation.section.parens.begin.idris2'],
    ];
    for (const [text, open, scope] of cases) {
      await expectScope(text, open, scope);
      const result = await tokenizeText(SCOPE, text);
      assert.ok(endStateIsRoot(result), `${text}: bracket not closed`);
      assert.ok(!allScopes(result).some((s) => s.startsWith('invalid')), `${text}: invalid scope`);
    }
    await expectScope('x = `[ f : Nat ]', 'f', 'entity.name.function.idris2');
  });

  test('a closing bracket with no open group is invalid (the lexer\'s Unrecognised token)', async () => {
    await expectScope('x = 1 )', ')', 'invalid.illegal.unmatched-bracket.idris2');
    await expectScope('x = (1 ]', ']', 'invalid.illegal.unmatched-bracket.idris2');
  });

  test('pragmas the parser accepts are directives; an unknown one is one token without a keyword scope', async () => {
    // Every `pragma "…"` / `decoratedPragma fname "…"` in src/Idris/Parser.idr (master and v0.8.0),
    // except World and MkWorld, which are values; `%cg` is its own lexer token.
    const accepted = [
      'allow_overloads', 'ambiguity_depth', 'auto_implicit_depth', 'auto_lazy', 'builtin', 'charLit',
      'declsLit', 'default', 'defaulthint', 'deprecate', 'doubleLit', 'export', 'extern', 'foreign',
      'foreign_impl', 'globalhint', 'hide', 'hint', 'inline', 'integerLit', 'language', 'logging',
      'macro', 'name', 'nameLit', 'nf_metavar_threshold', 'noinline', 'nomangle', 'pair',
      'prefix_record_projections', 'rewrite', 'runElab', 'search', 'search_timeout', 'spec', 'start',
      'stringLit', 'syntactic', 'tcinline', 'totality_depth', 'transform', 'TTImpLit',
      'unbound_implicits', 'unhide', 'unsafe', 'cg',
    ];
    for (const p of accepted) {
      await expectScope(`%${p} x`, `%${p}`, 'keyword.other.directive.idris2');
    }
    await expectScope('%defualt total', '%defualt', 'meta.directive.unknown.idris2');
    await expectNoScope('%defualt total', '%defualt', 'keyword');
    await expectScope('%inline2 x', '%inline2', 'meta.directive.unknown.idris2');
    await expectScope('w : %World', '%World', 'support.type.primitive.idris2');
    await expectScope('w = %MkWorld', '%MkWorld', 'support.constant.idris2');
    await expectScope('%auto_lazy off', 'off', 'constant.language.idris2');
    await expectScope('%language ElabReflection', 'ElabReflection', 'support.constant.extension.idris2');
    await expectScope('%builtin Natural Nat', 'Natural', 'support.constant.builtin.idris2');
    await expectScope('%cg chez extraRuntime=a.ss', 'chez', 'support.constant.backend.idris2');
    await expectScope('%cg chez extraRuntime=a.ss', 'a.ss', 'string.unquoted.directive.idris2');
    await expectScope('%cg javascript {\n minimal\n}', 'minimal', 'string.unquoted.directive.idris2');
  });
});

suite('idris2 grammar: recovery from unbalanced brackets', () => {
  test('an unclosed bracket ends at a column-0 declaration keyword or declaration pragma', async () => {
    const text = 'f = g (h\n  x\nexport\nsig : Nat';
    await expectScope(text, 'x', 'meta.parens.idris2');
    await expectScope(text, 'sig', 'entity.name.function.idris2');
    assert.ok(endStateIsRoot(await tokenizeText(SCOPE, text)));
    await expectScope('f = [1\ndata T = A', 'T', 'entity.name.type.data.idris2');
    await expectScope('f = {1\n%default total', '%default', 'keyword.other.directive.idris2');
    await expectNoScope('f = {1\n%default total', '%default', 'meta.braces');
  });

  test('valid continuation lines at column 0 stay inside the bracket', async () => {
    const valid = [
      'xs = [ 1\n     , 2\n]',
      'ys = (1 +\n2)',
      'n : (\nx : Nat) -> Nat',
      'r = f (\nrecord { x = 1 } p)',
      'record R where {\n||| doc\nx : Nat\n}',
    ];
    for (const text of valid) {
      const result = await tokenizeText(SCOPE, text);
      assert.ok(endStateIsRoot(result), `${JSON.stringify(text)}: not at root`);
      assert.ok(!allScopes(result).some((s) => s.startsWith('invalid')), `${JSON.stringify(text)}: invalid scope`);
    }
  });
});
