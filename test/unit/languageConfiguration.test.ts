import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Tests for language-configuration/{idris2,lidr,ipkg}.json. The files are found through
// package.json's contributes.languages, so the manifest wiring is checked too.
//
// VS Code semantics these tests model come from the source of VS Code 1.139.1
// (microsoft/vscode@04c0d99, the version in .vscode-test/). Each table below was also replayed in
// that VS Code, driven through the `type` command and the extension-host API; the expected
// values are what it produced.
// - Every regex is built with `new RegExp(pattern, '')`, or `new RegExp(pattern, flags)` for the
//   {pattern, flags} form (workbench/contrib/codeEditor/common/languageConfigurationExtensionPoint.ts
//   `_parseRegex`). JSON with comments is accepted there; these files are strict JSON so that
//   this test can use JSON.parse.
// - On Enter, the first onEnterRule whose regexes all match wins: beforeText on the text before
//   the cursor, afterText on the text after it, previousLineText on the line above
//   (editor/common/languages/supports/onEnter.ts). Only if no rule matches does VS Code fall back
//   to its bracket rules and then to indentationRules. Bracket characters inside string and
//   comment tokens are deleted from the text before any of this (supports/indentationLineProcessor.ts).
// - The new line is: the current line's leading whitespace, then one indent unit for `indent`,
//   then `appendText`, then the text that was after the cursor (languages/enterAction.ts and
//   cursor/cursorTypeEditOperations.ts `EnterOperation`).
// - wordPattern drives model.getWordAtPosition: completion word ranges, word-based suggestions,
//   textual highlights, TM_CURRENT_WORD, and the extension host's TextDocument.getWordRangeAtPosition.
//   Double-click, Ctrl+D and word navigation use `editor.wordSeparators` instead
//   (cursor/cursorWordOperations.ts), so wordPattern does not decide them.

const PACKAGE_NAME = 'vscode-idris2';

function repoRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === PACKAGE_NAME) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no package.json named "${PACKAGE_NAME}" above ${__dirname}`);
    }
  }
}

type RegexSpec = string | { pattern: string; flags?: string };

interface OnEnterRule {
  beforeText: RegexSpec;
  afterText?: RegexSpec;
  previousLineText?: RegexSpec;
  action: { indent: 'none' | 'indent' | 'indentOutdent' | 'outdent'; appendText?: string; removeText?: number };
}

interface AutoClosingPair {
  open: string;
  close: string;
  notIn?: string[];
}

interface LanguageConfiguration {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: AutoClosingPair[];
  surroundingPairs?: [string, string][];
  wordPattern?: RegexSpec;
  indentationRules?: Record<string, RegexSpec>;
  folding?: { offSide?: boolean; markers?: { start: RegexSpec; end: RegexSpec } };
  onEnterRules?: OnEnterRule[];
}

const root = repoRoot();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { languages: { id: string; configuration?: string }[] };
};

function configFile(id: string): string {
  const lang = manifest.contributes.languages.find((l) => l.id === id);
  assert.ok(lang?.configuration, `package.json contributes no configuration for language "${id}"`);
  return path.join(root, lang.configuration);
}

function load(id: string): LanguageConfiguration {
  return JSON.parse(fs.readFileSync(configFile(id), 'utf8')) as LanguageConfiguration;
}

/** As VS Code's `_parseRegex`. */
function compile(spec: RegexSpec): RegExp {
  return typeof spec === 'string' ? new RegExp(spec, '') : new RegExp(spec.pattern, spec.flags);
}

/** Every regex in a configuration, with its JSON path. */
function regexes(conf: LanguageConfiguration): [string, RegexSpec][] {
  const out: [string, RegexSpec][] = [];
  if (conf.wordPattern !== undefined) {
    out.push(['wordPattern', conf.wordPattern]);
  }
  for (const [k, v] of Object.entries(conf.indentationRules ?? {})) {
    out.push([`indentationRules.${k}`, v]);
  }
  if (conf.folding?.markers) {
    out.push(['folding.markers.start', conf.folding.markers.start], ['folding.markers.end', conf.folding.markers.end]);
  }
  (conf.onEnterRules ?? []).forEach((r, i) => {
    out.push([`onEnterRules[${i}].beforeText`, r.beforeText]);
    if (r.afterText !== undefined) {
      out.push([`onEnterRules[${i}].afterText`, r.afterText]);
    }
    if (r.previousLineText !== undefined) {
      out.push([`onEnterRules[${i}].previousLineText`, r.previousLineText]);
    }
  });
  return out;
}

const INDENT_UNIT = '  '; // editor.tabSize 2 + insertSpaces, the [idris2]/[lidr] defaults in package.json

/**
 * The line VS Code creates when Enter is pressed at `col` (default: end of the last line of
 * `text`), when an onEnterRule matches; `undefined` when none does (VS Code then applies its
 * bracket rules, and otherwise keeps the current line's indentation).
 */
function enter(conf: LanguageConfiguration, text: string, col?: number): string | undefined {
  const lines = text.split('\n');
  const line = lines[lines.length - 1];
  const at = col ?? line.length;
  const before = line.slice(0, at);
  const after = line.slice(at);
  const previous = lines.length > 1 ? lines[lines.length - 2] : '';
  for (const rule of conf.onEnterRules ?? []) {
    const ok = compile(rule.beforeText).test(before)
      && (rule.afterText === undefined || compile(rule.afterText).test(after))
      && (rule.previousLineText === undefined || compile(rule.previousLineText).test(previous));
    if (ok) {
      assert.ok(rule.action.indent === 'none' || rule.action.indent === 'indent', `untested action ${rule.action.indent}`);
      assert.strictEqual(rule.action.removeText, undefined, 'removeText is not modelled');
      const indentation = /^\s*/.exec(before)![0];
      return indentation + (rule.action.indent === 'indent' ? INDENT_UNIT : '') + (rule.action.appendText ?? '') + after;
    }
  }
  return undefined;
}

/** The word that VS Code's getWordAtPosition returns for 0-based `col` of a single line. */
function wordAt(conf: LanguageConfiguration, line: string, col: number): string | null {
  const re = compile(conf.wordPattern!);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of line.matchAll(g)) {
    if (m.index <= col && col <= m.index + m[0].length) {
      return m[0];
    }
  }
  return null;
}

const idris2 = load('idris2');
const lidr = load('lidr');
const ipkg = load('ipkg');
const all: [string, LanguageConfiguration][] = [['idris2', idris2], ['lidr', lidr], ['ipkg', ipkg]];

suite('language configuration files', () => {
  test('the committed files are what scripts/build-language-configuration.mjs generates', () => {
    const script = path.join(root, 'scripts', 'build-language-configuration.mjs');
    const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  });

  test('every regex compiles with JavaScript RegExp, as VS Code builds it', () => {
    for (const [id, conf] of all) {
      const found = regexes(conf);
      assert.ok(found.length > 0, `${id}: no regexes found`);
      for (const [where, spec] of found) {
        assert.doesNotThrow(() => compile(spec), `${id}: ${where}`);
      }
    }
  });

  test('comment tokens are those of the lexers', () => {
    // src/Parser/Lexer/Common.idr: `comment` (--) and `blockComment` ({- -}); both are used by
    // the source lexer (Lexer/Source.idr) and the ipkg lexer (Lexer/Package.idr).
    assert.deepStrictEqual(idris2.comments, { lineComment: '--', blockComment: ['{-', '-}'] });
    assert.deepStrictEqual(ipkg.comments, { lineComment: '--', blockComment: ['{-', '-}'] });
    // Literate: a toggled line comment goes before the bird track, so `-- > f x = 1` becomes
    // prose, which removes the line from the program (checked with idris2 --check). A block
    // comment toggled over several code lines would do that to the first line only and leave
    // `-}` on a code line, so lidr declares no block comment.
    assert.deepStrictEqual(lidr.comments, { lineComment: '--' });
  });

  test('brackets are the single-character pairs only', () => {
    // `[|`, `|]`, `{-`, `-}` are not listed: the outer characters of `[| … |]` already pair as
    // `[`/`]`, and `{-`/`-}` only ever occur inside comment tokens, which bracket matching skips.
    for (const conf of [idris2, lidr]) {
      assert.deepStrictEqual(conf.brackets, [['{', '}'], ['[', ']'], ['(', ')']]);
    }
    assert.strictEqual(ipkg.brackets, undefined, 'the ipkg lexer has no bracket tokens');
  });

  test("a single quote is never auto-closed or used to surround (primes: x', xs'')", () => {
    for (const [id, conf] of all) {
      assert.ok(!(conf.autoClosingPairs ?? []).some((p) => p.open.includes("'")), id);
      assert.ok(!(conf.surroundingPairs ?? []).some((p) => p[0] === "'"), id);
    }
  });

  test('{- auto-closes with -} (typing `{-` gives `{- ‸ -}`), except inside strings', () => {
    // VS Code picks the longest auto-closing open ending in the typed character and, because
    // `{` was already auto-closed, drops the `}` it would duplicate: `{` then `-` yields
    // `{- -}` (observed). Without this pair the result would be `{-}`, an unterminated comment.
    // Not excluded in comments: a nested `{-` inside a block comment needs its own `-}`.
    for (const [id, conf] of all) {
      assert.deepStrictEqual(conf.autoClosingPairs!.find((p) => p.open === '{-'),
        { open: '{-', close: ' -}', notIn: ['string'] }, id);
    }
  });

  test('no indentationRules: nothing re-indents existing lines of a layout-sensitive language', () => {
    // indentationRules also drive outdent-on-type, Reindent Lines, auto-indent on paste and on
    // Move Line (languages/autoIndent.ts, all gated on indentRulesSupport). Any of those can move
    // a line across an Idris layout column. onEnterRules only set the indentation of the new line.
    for (const [id, conf] of all) {
      assert.strictEqual(conf.indentationRules, undefined, id);
    }
  });

  test('folding is indentation-based with off-side blank lines for .idr, and has no markers', () => {
    // No start/end marker convention exists in the Idris 2 compiler, its libraries or the test
    // corpora (the `-- ----` rules there are separators, not pairs).
    assert.deepStrictEqual(idris2.folding, { offSide: true });
    assert.strictEqual(lidr.folding, undefined, 'bird-track code starts in column 0, so indentation folding has nothing to use');
    assert.strictEqual(ipkg.folding, undefined);
  });
});

suite('wordPattern', () => {
  // Identifier rules from src/Parser/Lexer/Common.idr: start `isAlpha x || x > chr 160` (Prelude
  // isAlpha is ASCII-only), then also digits, `_` and `'`. A leading `_` is not an identifier
  // start in practice: Lexer/Source.idr matches the symbol `_` first (`f _x = 1` parses as two
  // arguments). Holes are `?` + identifier (`holeIdent`) unless the `?` belongs to an operator
  // (isOpChar, Core/Name.idr). Words are identifiers and holes only; numbers, operators and the
  // `.` of qualified names are not part of any word. Verified live: `λ`, `→`, `∘∘`, `¡a`, `𝔸`,
  // `x''` are accepted as identifiers by idris2 0.8.0 --check; U+00A0 is not (F18 records the
  // same for `α`, `x₁`, `ℕ`).
  const line = "f ?hole x' Data.Vect.index <?y _z 0xFF 'a' λ→ 𝔸b x.y ??w (.fld) %default";
  const cases: [string, string | null][] = [
    ['f', 'f'], ['?hole', '?hole'], ['hole', '?hole'], ["x'", "x'"], ['Data', 'Data'], ['Vect', 'Vect'],
    ['index', 'index'], ['<?y', null], ['y ', 'y'], ['_z', null], ['z ', 'z'], ['0xFF', null], ['xFF', null],
    ["'a'", null], ["a'", null], ['λ', 'λ→'], ['→', 'λ→'], ['𝔸', '𝔸b'], ['b ', '𝔸b'], ['x.y', 'x'],
    ['.y', 'x'], ['y ??', 'y'], ['??w', null], ['w (', 'w'], ['(.fld', null], ['fld', 'fld'], ['%default', null],
    ['default', 'default'],
  ];
  for (const [needle, expected] of cases) {
    test(`at ${JSON.stringify(needle)} → ${JSON.stringify(expected)}`, () => {
      const col = line.indexOf(needle);
      assert.ok(col >= 0);
      for (const conf of [idris2, lidr]) {
        assert.strictEqual(wordAt(conf, line, col), expected);
      }
    });
  }

  test('a hole name may start with `_` (`holeIdent` is tried before the symbol `_`)', () => {
    // `f = ?_foo` and `f = ?_` pass idris2 0.8.0 --check.
    const l = 'f = ?_foo ?_ _z';
    for (const conf of [idris2, lidr]) {
      assert.strictEqual(wordAt(conf, l, l.indexOf('?_foo')), '?_foo');
      assert.strictEqual(wordAt(conf, l, l.indexOf('foo')), '?_foo');
      assert.strictEqual(wordAt(conf, l, l.indexOf('?_ ')), '?_');
      assert.strictEqual(wordAt(conf, l, l.indexOf('_z')), null);
    }
  });

  test('the identifier after a digit run is not a word (literals such as 0xFF, 1.5e10)', () => {
    assert.strictEqual(wordAt(idris2, '1.5e10', 3), null);
  });

  test('ipkg: package names may contain dashes (identAllowDashes) and start with _', () => {
    const l = 'depends = idris2-lsp, contrib_x >= 0.8, _a';
    assert.strictEqual(wordAt(ipkg, l, l.indexOf('lsp')), 'idris2-lsp');
    assert.strictEqual(wordAt(ipkg, l, l.indexOf('contrib')), 'contrib_x');
    assert.strictEqual(wordAt(ipkg, l, l.indexOf('_a')), '_a');
    assert.strictEqual(wordAt(ipkg, l, l.indexOf('0.8') + 1), null);
    assert.strictEqual(wordAt(ipkg, 'modules = Data.Vect', 12), 'Data');
  });
});

suite('onEnterRules: .idr', () => {
  // A line ending in a token that opens a layout block or leaves the declaration unfinished
  // gets one more indent unit on the next line. Openers: `where`, `do`, `of`, `let`, `\case`,
  // `=`, `=>`, `->` (not as part of a longer operator); lines starting with `mutual`, `failing`,
  // `namespace`, `parameters`, `using`, whose blocks must be indented past the keyword's column
  // (Idris/Parser.idr `nonEmptyBlockAfter col`). A trailing `--` comment is allowed; a keyword
  // inside the comment does not count. Any other line keeps its indentation, which is always
  // valid for the next clause or statement: a line ending in `= ?hole` is a complete clause.
  const cases: [string, string | undefined][] = [
    ['f x = do', '  '],
    ['f x = do -- note', '  '],
    ['  where', '    '],
    ['data Foo : Type where', '  '],
    ['f = case x of', '  '],
    ['  let', '    '],
    ['f = \\case', '  '],
    ['f = \\ case', '  '],
    ['f x =', '  '],
    ['  Z =>', '    '],
    ['foo : Nat ->', '  '],
    ['mutual', '  '],
    ['failing "msg"', '  '],
    ['namespace A.B', '  '],
    ['parameters (x : Nat)', '  '],
    ['  using (a : Type)', '    '],
    ['    g y = do', '      '],
    [' Foo.do', '   '],              // qualified do (Idris/Parser.idr: `(ns, "do")`)
    ['x |--do', '  '],               // `|--` is one operator token, so `do` is code
    ['f x = ?rhs', undefined],
    ['f x = ?f_rhs', undefined],
    ['f x == y', undefined],
    ['x >= ', undefined],
    ['a <-> ', undefined],
    ['-- where', undefined],
    ['||| doc where', undefined],
    ['f = x -- do', undefined],
    ['f x = do --}', undefined],     // `--}` is not a comment, so the line does not end in `do`
    ['somewhere', undefined],
    ["where'", undefined],
    ['f = ?do', undefined],
    ['mutualx', undefined],
    ['public export', undefined],
    ['  x <- foo', undefined],
    ['    f = let x = 1 in x', undefined],
    ['f = (', undefined],            // VS Code's bracket rule indents this one
  ];
  for (const [line, expected] of cases) {
    test(`${JSON.stringify(line)} → ${expected === undefined ? 'no rule' : JSON.stringify(expected)}`, () => {
      assert.strictEqual(enter(idris2, line), expected);
    });
  }

  test('Enter in the middle of a line indents the text after the cursor', () => {
    assert.strictEqual(enter(idris2, 'f x = do bar', 8), '   bar');
    assert.strictEqual(enter(idris2, 'f x = y', 0), undefined);
  });
});

suite('onEnterRules: .lidr bird tracks', () => {
  // Parser/Unlit.idr styleBird: code lines start with `>` or `<` in column 0, followed by a
  // space or the end of the line (Libraries/Text/Literate.idr `line`); unlit removes the marker
  // and one space. Enter on a code line starts the next line with the same marker and the same
  // inner indentation, plus one indent unit after an opener (as for .idr, and also after an
  // open bracket, because the rules take precedence over VS Code's bracket rule). Inner
  // indentation is preserved up to 32 spaces after the marker; deeper lines get the marker and
  // one space. Prose lines get a plain newline.
  const cases: [string, string][] = [
    ['> f x = do', '>   '],
    ['> f x = 1', '> '],
    ['>   x <- foo', '>   '],
    ['>', '> '],
    ['> ', '> '],
    ['< g = do', '<   '],
    ['< g = 1', '< '],
    ['> -- where', '> '],
    ['> ||| doc where', '> '],
    ['> f = (', '>   '],
    ['> mutual', '>   '],
    ['>     where', '>       '],
    ['>\tx', '> '],
    ['prose line', ''],
    ['prose (', ''],
    ['>x', ''],
    [' > x', ' '],
    ['Some prose.\n> f x = do', '>   '],
  ];
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} → ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(enter(lidr, text), expected);
    });
  }

  test('inner indentation is kept for 1–32 spaces, +1 unit after an opener; the fallback beyond', () => {
    for (const marker of ['>', '<']) {
      for (let d = 1; d <= 32; d++) {
        const pad = ' '.repeat(d);
        assert.strictEqual(enter(lidr, `${marker}${pad}x`), `${marker}${pad}`, `${marker} depth ${d}`);
        assert.strictEqual(enter(lidr, `${marker}${pad}x = do`), `${marker}${pad}  `, `${marker} depth ${d} opener`);
      }
      assert.strictEqual(enter(lidr, `${marker}${' '.repeat(33)}x`), `${marker} `);
    }
  });

  test('the bird-track openers are those of .idr', () => {
    for (const line of ['f x = do', 'data Foo : Type where', 'f = case x of', 'f = \\case', 'f x =', 'Z =>',
      'foo : Nat ->', 'let', 'mutual', 'namespace A', 'f x = ?rhs', 'f = x -- do', 'f x == y']) {
      const idr = enter(idris2, line);
      assert.strictEqual(enter(lidr, `> ${line}`), idr === undefined ? '> ' : `> ${idr}`, line);
    }
  });

  test('Enter in the middle of a code line', () => {
    assert.strictEqual(enter(lidr, '> f x = do bar', 10), '>    bar');
  });
});

suite('onEnterRules: .ipkg', () => {
  // The ipkg parser skips all whitespace (Parser/Lexer/Package.idr `spacesOrNewlines`), so this
  // indentation is cosmetic: a field value may start on the next line (checked with
  // idris2 --dump-ipkg-json on a file with indented fields and values in column 0).
  const cases: [string, string | undefined][] = [
    ['modules =', '  '],
    ['  modules =', '    '],
    ['depends = base', undefined],
    ['-- modules =', undefined],
    ['version = 0.1.0', undefined],
    ['depends = base >=', undefined],
  ];
  for (const [line, expected] of cases) {
    test(`${JSON.stringify(line)} → ${expected === undefined ? 'no rule' : JSON.stringify(expected)}`, () => {
      assert.strictEqual(enter(ipkg, line), expected);
    });
  }
});
