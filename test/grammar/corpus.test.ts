/**
 * Tokenises every .idr and .lidr file of the real-world corpora pinned in test/corpus/corpus.json
 * (fetched into .corpus/ by scripts/fetch-corpus.mjs; `npm run test:corpus` does both) and checks
 * invariants that hold for any code the Idris 2 lexer accepts:
 *
 * - no `invalid.*` scope (the grammar never marks lexically valid code as an error);
 * - the rule stack is back at the root at the end of the file, after one column-0 line that
 *   closes layout regions (see endsAtRoot in idris2.test.ts; in a .lidr file a code line, after
 *   which no Idris 2 construct may be open), except for the files listed in
 *   `endsInsideBlockComment`, which must end inside a block comment and nothing else;
 * - each file tokenises within PER_FILE_BUDGET_MS, a bound meant to catch catastrophic regex
 *   backtracking, not to measure speed (perf.test.ts does that);
 * - each .idr file, turned into bird-track code (`> ` before every line), tokenises exactly as
 *   the .idr file does (harness.ts birdTrackDifferences).
 *
 * Per-corpus statistics (files, lines, time) are logged. The corpora are never copied into the
 * repository; several declare no licence that would allow it.
 *
 * With IDRIS2_LEXER_ORACLE=1 a second suite compares the grammar with the compiler's own lexer:
 * it builds test/corpus/lexer-oracle/LexDump.idr against the `idris2` API package installed with
 * the compiler (IDRIS2 names the binary; default `idris2`), and for every token the lexer
 * produces in the corpora's .idr files and the grammar fixtures it checks the scope the grammar
 * gives the token's first and last character, and that comment scopes cover exactly the lexer's
 * comments. It needs the compiler, so it is not part of CI.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import { birdTrackDifferences, grammarFor, LITERATE_BASE_DEPTH, repoRoot, scopeForFile } from './harness';

interface Corpus {
  readonly name: string;
  readonly url: string;
  readonly commit: string;
  readonly paths: readonly string[];
  readonly licence: string;
  readonly redistribute: boolean;
  readonly endsInsideBlockComment?: Readonly<Record<string, string>>;
}

const PER_FILE_BUDGET_MS = 3000;
const { corpora } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test', 'corpus', 'corpus.json'), 'utf8')) as {
  corpora: readonly Corpus[];
};

function* idrisFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && entry.name !== 'build') {
        yield* idrisFiles(p);
      }
    } else if (/\.(idr|lidr)$/.test(entry.name)) {
      yield p;
    }
  }
}

interface FileResult {
  readonly lines: number;
  readonly ms: number;
  readonly invalid: readonly string[];
  /** Scopes (root excluded) of a column-0 line tokenised after the file. */
  readonly after: readonly string[];
}

async function tokenise(file: string): Promise<FileResult> {
  const scopeName = await scopeForFile(file);
  const literate = scopeName === 'source.idris2.literate';
  const grammar = await grammarFor(scopeName);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const invalid: string[] = [];
  let stack = vsctm.INITIAL;
  const start = process.hrtime.bigint();
  lines.forEach((line, n) => {
    const r = grammar.tokenizeLine(line, stack);
    for (const t of r.tokens) {
      if (t.scopes.some((s) => s.startsWith('invalid.'))) {
        invalid.push(`${n + 1}:${t.startIndex + 1} ${JSON.stringify(line.slice(t.startIndex, t.endIndex))} ${t.scopes.join(' ')}`);
      }
    }
    stack = r.ruleStack;
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // In a .lidr file the column-0 line is a code line, and the literate program with its
  // embedded block stays open to the end (harness.ts LITERATE_BASE_DEPTH).
  const sentinel = grammar.tokenizeLine(literate ? '> x' : 'x', stack);
  const x = sentinel.tokens[sentinel.tokens.length - 1];
  const after =
    sentinel.ruleStack.depth <= (literate ? LITERATE_BASE_DEPTH : 1)
      ? []
      : x.scopes.slice(1).filter((s) => s !== 'meta.embedded.block.idris2');
  return { lines: lines.length, ms, invalid, after };
}

suite('grammar corpus', () => {
  for (const corpus of corpora) {
    test(`${corpus.name} @ ${corpus.commit.slice(0, 12)}`, async function () {
      this.timeout(0);
      const dir = path.join(repoRoot, '.corpus', corpus.name);
      assert.ok(fs.existsSync(dir), `${dir} is missing: run node scripts/fetch-corpus.mjs`);
      const expectedOpen = new Map(Object.entries(corpus.endsInsideBlockComment ?? {}));
      const problems: string[] = [];
      let files = 0;
      let lines = 0;
      let ms = 0;
      let slowest = { ms: 0, file: '' };
      for (const p of corpus.paths) {
        for (const file of idrisFiles(path.join(dir, p))) {
          const rel = path.relative(dir, file).split(path.sep).join('/');
          const r = await tokenise(file);
          files++;
          lines += r.lines;
          ms += r.ms;
          if (r.ms > slowest.ms) {
            slowest = { ms: r.ms, file: rel };
          }
          r.invalid.slice(0, 3).forEach((i) => problems.push(`${rel}:${i}`));
          if (r.ms > PER_FILE_BUDGET_MS) {
            problems.push(`${rel}: ${r.ms.toFixed(0)} ms (budget ${PER_FILE_BUDGET_MS} ms)`);
          }
          if (expectedOpen.has(rel)) {
            expectedOpen.delete(rel);
            if (r.after.length === 0 || !r.after.every((s) => s === 'comment.block.idris2')) {
              problems.push(`${rel}: listed as ending inside a block comment, but ends with [${r.after.join(' ')}]`);
            }
          } else if (r.after.length > 0) {
            problems.push(`${rel}: does not end at the root rule: [${r.after.join(' ')}]`);
          }
        }
      }
      for (const rel of expectedOpen.keys()) {
        problems.push(`${rel}: listed in endsInsideBlockComment but not found`);
      }
      console.log(
        `      ${corpus.name}: ${files} files, ${lines} lines, ${ms.toFixed(0)} ms ` +
          `(${((ms * 1000) / Math.max(lines, 1)).toFixed(1)} µs/line; slowest ${slowest.file} ${slowest.ms.toFixed(0)} ms)`,
      );
      assert.ok(files > 0, 'no .idr or .lidr files found');
      assert.deepStrictEqual(problems, []);
    });
  }
});

suite('grammar corpus as bird-track code', () => {
  for (const corpus of corpora) {
    test(`${corpus.name}: every .idr file tokenises the same as bird-track code`, async function () {
      this.timeout(0);
      const dir = path.join(repoRoot, '.corpus', corpus.name);
      assert.ok(fs.existsSync(dir), `${dir} is missing: run node scripts/fetch-corpus.mjs`);
      const problems: string[] = [];
      for (const p of corpus.paths) {
        for (const file of idrisFiles(path.join(dir, p))) {
          if (file.endsWith('.idr')) {
            const rel = path.relative(dir, file).split(path.sep).join('/');
            (await birdTrackDifferences(fs.readFileSync(file, 'utf8'))).slice(0, 3).forEach((d) => problems.push(`${rel}:${d}`));
          }
        }
      }
      assert.deepStrictEqual(problems, []);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Comparison with the compiler's lexer (opt-in)

/** What the grammar must say about the first (and last) character of each lexer token kind. */
const RESERVED: Readonly<Record<string, string>> = {
  '->': 'keyword.operator.arrow.idris2', '=>': 'keyword.operator.arrow.double.idris2',
  '<-': 'keyword.operator.arrow.left.idris2', ':=': 'keyword.operator.assignment.idris2',
  '$=': 'keyword.operator.assignment.apply.idris2', ':': 'keyword.operator.colon.idris2',
  '=': 'keyword.operator.equals.idris2', '|': 'keyword.operator.pipe.idris2',
  '**': 'keyword.operator.dependent-pair.idris2', '..': 'keyword.operator.range.idris2',
  '\\': 'keyword.operator.lambda.idris2', '?': 'keyword.operator.infer.idris2',
  '!': 'keyword.operator.bang.idris2', '@': 'keyword.operator.as-pattern.idris2',
  '~': 'keyword.operator.unquote.idris2', '&': 'keyword.operator.reserved.idris2',
  '%': 'keyword.operator.reserved.idris2',
};
const OPENERS = ['.(', '.[|', '@{', '[|', '(', '{', '[<', '[>', '[', '`(', '`{', '`['];
const CLOSERS = [')', '}', ']', '|]'];
/** Identifiers the parser gives a keyword meaning in context, which the grammar marks as such. */
const CONTEXTUAL = /^(keyword\.other\.(as|constructor|data-option)|keyword\.operator\.infix|storage\.modifier\.multiplicity)\./;

function agrees(kind: string, payload: string, scopes: readonly string[]): boolean {
  const has = (prefix: string): boolean => scopes.some((s) => s.startsWith(prefix));
  const inComment = has('comment.');
  const inString = has('string.') && !has('meta.embedded.');
  switch (kind) {
    case 'Comment':
      return inComment;
    case 'DocComment':
      return has('comment.line.documentation.');
    case 'Keyword':
      return !inComment && !inString && scopes.some((s) => /^(keyword|storage)\./.test(s));
    case 'Ident':
      return !inComment && !inString && !has('constant.numeric.') && !has('invalid.') &&
        !scopes.some((s) => /^(keyword|storage)\./.test(s) && !CONTEXTUAL.test(s));
    case 'DotSepIdent':
      return has('entity.name.namespace.') || has('keyword.operator.infix.');
    case 'DotIdent':
      return has('punctuation.accessor.') || has('entity.name.');
    case 'HoleIdent':
      return has('variable.other.hole.');
    case 'Symbol':
      if (OPENERS.includes(payload)) {
        return scopes.some((s) => /^punctuation\.section\..*\.begin\./.test(s));
      }
      if (CLOSERS.includes(payload)) {
        return scopes.some((s) => /^punctuation\.section\..*\.end\./.test(s));
      }
      if (payload === ',') {
        return has('punctuation.separator.comma.');
      }
      if (payload === ';') {
        return has('punctuation.separator.semicolon.');
      }
      if (payload === '_') {
        return has('variable.language.wildcard.');
      }
      if (payload === '`') {
        return has('punctuation.definition.infix.');
      }
      if (payload in RESERVED) {
        return scopes.includes(RESERVED[payload]);
      }
      return !inComment && !inString && (scopes.includes('keyword.operator.idris2') || has('entity.name.'));
    case 'IntegerLit':
      return has('constant.numeric.integer.') || (has('storage.modifier.multiplicity.') && (payload === '0' || payload === '1'));
    case 'DoubleLit':
      return has('constant.numeric.float.');
    case 'CharLit':
      return has('constant.character.');
    case 'StringBegin':
    case 'MultiBegin':
      return has('punctuation.definition.string.begin.');
    case 'StringEnd':
      return has('punctuation.definition.string.end.');
    case 'InterpBegin':
      return has('punctuation.section.embedded.begin.');
    case 'InterpEnd':
      return has('punctuation.section.embedded.end.');
    case 'Pragma':
      return has('keyword.other.directive.') || has('meta.directive.unknown.') || has('support.');
    case 'CGDirective':
      return has('keyword.other.directive.');
    case 'MagicDebugInfo':
      return has('constant.language.debug-info.');
    case 'Unrecognised':
      return has('invalid.');
    default:
      return true;
  }
}

/** Kinds whose every character carries the same classification, so the last one is checked too. */
const WHOLE_TOKEN = ['Ident', 'Keyword', 'IntegerLit', 'DoubleLit', 'CharLit', 'HoleIdent', 'Pragma', 'MagicDebugInfo', 'DocComment', 'Comment'];

suite('grammar vs the Idris 2 lexer (IDRIS2_LEXER_ORACLE=1)', () => {
  test('every lexer token and comment gets a matching scope', async function () {
    if (process.env.IDRIS2_LEXER_ORACLE !== '1') {
      this.skip();
    }
    this.timeout(0);
    const idris2 = process.env.IDRIS2 || 'idris2';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-lexer-'));
    const build = spawnSync(
      idris2,
      ['-p', 'idris2', '-p', 'contrib', '--build-dir', path.join(tmp, 'build'), '--output-dir', tmp, '-o', 'lexdump', 'LexDump.idr'],
      { cwd: path.join(repoRoot, 'test', 'corpus', 'lexer-oracle'), encoding: 'utf8' },
    );
    assert.strictEqual(build.status, 0, `building LexDump.idr failed:\n${build.stdout}${build.stderr}`);
    const version = spawnSync(idris2, ['--version'], { encoding: 'utf8' }).stdout.trim();

    const files: string[] = [];
    const fixtures = path.join(repoRoot, 'test', 'fixtures', 'grammar');
    files.push(...fs.readdirSync(fixtures).filter((f) => f.endsWith('.idr')).map((f) => path.join(fixtures, f)));
    for (const corpus of corpora) {
      const dir = path.join(repoRoot, '.corpus', corpus.name);
      assert.ok(fs.existsSync(dir), `${dir} is missing: run node scripts/fetch-corpus.mjs`);
      for (const p of corpus.paths) {
        files.push(...[...idrisFiles(path.join(dir, p))].filter((f) => f.endsWith('.idr')));
      }
    }

    const grammar = await grammarFor('source.idris2');
    const mismatches = new Map<string, { n: number; examples: string[] }>();
    const note = (key: string, where: string): void => {
      const m = mismatches.get(key) ?? { n: 0, examples: [] };
      m.n++;
      if (m.examples.length < 3) {
        m.examples.push(where);
      }
      mismatches.set(key, m);
    };
    let tokens = 0;
    const lexerErrors: string[] = [];
    for (const file of files) {
      const dump = spawnSync(path.join(tmp, 'lexdump'), [file], { encoding: 'utf8', maxBuffer: 1 << 28 });
      assert.strictEqual(dump.status, 0, `lexdump ${file}: ${dump.stderr}`);
      const rows = dump.stdout.split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
      if (rows[0]?.[0] === 'ERROR') {
        lexerErrors.push(`${file}: ${rows[0].slice(1).join(' ')}`);
        continue;
      }
      // The lexer counts \r as part of a line and columns in code points; the grammar sees lines
      // split at \n and UTF-16 indices.
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const utf16 = lines.map((l) => {
        const at = [0];
        let u = 0;
        for (const ch of l) {
          u += ch.length;
          at.push(u);
        }
        return at;
      });
      const col = (line: number, c: number): number => utf16[line]?.[c] ?? c;
      const tokenLines: vsctm.IToken[][] = [];
      let stack = vsctm.INITIAL;
      for (const l of lines) {
        const r = grammar.tokenizeLine(l, stack);
        tokenLines.push(r.tokens);
        stack = r.ruleStack;
      }
      const scopesAt = (line: number, u: number): readonly string[] | undefined =>
        tokenLines[line]?.find((t) => t.startIndex <= u && u < t.endIndex)?.scopes.slice(1);
      const commentCover = lines.map((l) => new Uint8Array(l.length + 1));
      const where = (line: number): string => `${path.relative(repoRoot, file)}:${line + 1} ${lines[line].trim().slice(0, 80)}`;
      for (const [kind, sl, sc, el, ec, payload] of rows) {
        if (kind === 'Space' || kind === 'EndInput' || kind === 'StringLit') {
          continue;
        }
        const line = Number(sl);
        const start = col(line, Number(sc));
        if (kind === 'Comment' || kind === 'DocComment') {
          for (let y = line; y <= Number(el); y++) {
            const from = y === line ? start : 0;
            const to = y === Number(el) ? col(y, Number(ec)) : lines[y].length;
            commentCover[y].fill(1, from, to);
          }
        }
        tokens++;
        const first = scopesAt(line, start);
        if (first !== undefined && !agrees(kind, payload ?? '', first)) {
          note(`${kind} ${kind === 'Symbol' || kind === 'Keyword' ? payload : ''} -> ${first.join(' ')}`, where(line));
        }
        const whole = WHOLE_TOKEN.includes(kind) || (kind === 'Symbol' && !OPENERS.includes(payload) && !CLOSERS.includes(payload) && payload !== '`');
        if (whole && Number(el) === line) {
          const last = scopesAt(line, col(line, Number(ec)) - 1);
          if (last !== undefined && !agrees(kind, payload ?? '', last)) {
            note(`end of ${kind} ${kind === 'Symbol' ? payload : ''} -> ${last.join(' ')}`, where(line));
          }
        }
      }
      tokenLines.forEach((toks, y) => {
        for (const t of toks) {
          if (t.scopes.some((s) => s.startsWith('comment.'))) {
            const end = Math.min(t.endIndex, lines[y].length);
            if (commentCover[y].subarray(t.startIndex, end).includes(0)) {
              note('grammar comment outside a lexer comment', where(y));
            }
          }
        }
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`      ${version}: ${files.length} files, ${tokens} lexer tokens, ${lexerErrors.length} files rejected by the lexer`);
    const report = [...mismatches.entries()].map(([key, m]) => `${m.n}× ${key}\n    ${m.examples.join('\n    ')}`);
    assert.deepStrictEqual(report, []);
    assert.deepStrictEqual(lexerErrors, []);
  });
});
