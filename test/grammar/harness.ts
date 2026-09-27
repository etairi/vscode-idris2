/**
 * TextMate grammar test harness (the "Grammar" layer of docs/ARCHITECTURE.md §12).
 *
 * Runs under mocha on Node without VS Code: `vscode-textmate` tokenises with the Oniguruma
 * WebAssembly build of `vscode-oniguruma`, the same pair of libraries VS Code uses. Grammars are
 * located through `contributes.grammars` and `contributes.languages` of the repository's
 * package.json, never by hard-coded paths, so every test also checks the manifest wiring: a
 * grammar that is not contributed, or a contributed path that does not exist, fails with a
 * message naming the manifest entry.
 *
 * Conventions: lines and columns are 0-based and token ends are exclusive (VS Code's
 * `Position`/`Range` convention); a line is the text between two `\n` (a preceding `\r` is
 * dropped), without the terminator.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';

/** One token of one line. `language` is the language id VS Code would assign to the token. */
export interface Token {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
  /** Outermost first; `scopes[0]` is the grammar's root scope. */
  readonly scopes: readonly string[];
  readonly language: string;
}

export interface TokenizedLine {
  readonly text: string;
  readonly tokens: readonly Token[];
}

export interface TokenizeResult {
  readonly scopeName: string;
  readonly lines: readonly TokenizedLine[];
  /** The rule stack after the last line; see `endStateIsRoot`. */
  readonly ruleStack: vsctm.StateStack;
}

interface ManifestGrammar {
  readonly language?: string;
  readonly scopeName: string;
  readonly path: string;
  readonly embeddedLanguages?: Readonly<Record<string, string>>;
}

interface ManifestLanguage {
  readonly id: string;
  readonly extensions?: readonly string[];
}

interface Manifest {
  readonly name?: string;
  readonly contributes?: {
    readonly languages?: readonly ManifestLanguage[];
    readonly grammars?: readonly ManifestGrammar[];
  };
}

const PACKAGE_NAME = 'vscode-idris2';

/**
 * The directory of the package.json named "vscode-idris2", found by walking up from this file.
 * The walk (rather than a fixed `../..`) keeps the harness working from any output directory
 * inside the checkout: `out/test/grammar/` (`npm run test:grammar`) or a private
 * `tsc --outDir <dir>` inside it.
 */
export const repoRoot: string = findRepoRoot(__dirname);

function findRepoRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Manifest;
      if (manifest.name === PACKAGE_NAME) {
        return dir;
      }
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no package.json named "${PACKAGE_NAME}" above ${start}`);
    }
  }
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Manifest;
}

/** Everything derived from the manifest and the loaded Oniguruma library; built once. */
interface Environment {
  readonly registry: vsctm.Registry;
  readonly grammarsByScope: ReadonlyMap<string, ManifestGrammar>;
  readonly languages: readonly ManifestLanguage[];
  /** vscode-textmate identifies languages by number; index + 1 (0 is reserved). */
  readonly languageNumber: ReadonlyMap<string, number>;
}

let environment: Promise<Environment> | undefined;

function getEnvironment(): Promise<Environment> {
  environment ??= createEnvironment();
  return environment;
}

async function createEnvironment(): Promise<Environment> {
  const manifest = readManifest();
  const languages = manifest.contributes?.languages ?? [];
  const grammars = manifest.contributes?.grammars ?? [];

  const languageNumber = new Map(languages.map((l, i) => [l.id, i + 1]));
  const grammarsByScope = new Map<string, ManifestGrammar>();
  for (const g of grammars) {
    if (grammarsByScope.has(g.scopeName)) {
      throw new Error(`package.json contributes scope "${g.scopeName}" twice`);
    }
    if (g.language !== undefined && !languageNumber.has(g.language)) {
      throw new Error(
        `package.json grammar "${g.scopeName}" names language "${g.language}", which is not in contributes.languages`,
      );
    }
    for (const [scope, language] of Object.entries(g.embeddedLanguages ?? {})) {
      if (!languageNumber.has(language)) {
        throw new Error(
          `package.json grammar "${g.scopeName}" embeds "${scope}" as language "${language}", which is not in contributes.languages`,
        );
      }
    }
    grammarsByScope.set(g.scopeName, g);
  }

  // vscode-oniguruma is pinned to the version VS Code ships (1.7.0 in VS Code 1.139.1), whose
  // loadWASM takes an ArrayBuffer rather than a Node Buffer.
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const onigLib: vsctm.IOnigLib = {
    createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
    createOnigString: (str) => new oniguruma.OnigString(str),
  };

  const registry = new vsctm.Registry({
    onigLib: Promise.resolve(onigLib),
    // Called for the requested scope and for every scope a loaded grammar includes. A scope
    // this package does not contribute (e.g. one owned by a built-in VS Code grammar) resolves
    // to null, which vscode-textmate treats as "include nothing", as VS Code does when the
    // owning extension is absent.
    loadGrammar: async (scopeName) => {
      const entry = grammarsByScope.get(scopeName);
      if (entry === undefined) {
        return null;
      }
      const file = path.resolve(repoRoot, entry.path);
      if (!fs.existsSync(file)) {
        throw new Error(
          `grammar file for scope "${scopeName}" is missing: package.json contributes.grammars points to ${entry.path} (${file})`,
        );
      }
      return vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
    },
  });

  return { registry, grammarsByScope, languages, languageNumber };
}

/**
 * The compiled grammar for a contributed scope, loaded as VS Code loads it: with the manifest's
 * language and `embeddedLanguages`. Exposed for tests that drive `tokenizeLine` directly (e.g.
 * timing measurements, where `tokenizeText`'s second pass for languages would distort the
 * result).
 */
export function grammarFor(scopeName: string): Promise<vsctm.IGrammar> {
  let grammar = grammars.get(scopeName);
  if (grammar === undefined) {
    grammar = loadGrammar(scopeName);
    grammars.set(scopeName, grammar);
  }
  return grammar;
}

const grammars = new Map<string, Promise<vsctm.IGrammar>>();

async function loadGrammar(scopeName: string): Promise<vsctm.IGrammar> {
  const env = await getEnvironment();
  const entry = env.grammarsByScope.get(scopeName);
  if (entry === undefined) {
    const known = [...env.grammarsByScope.keys()].join(', ');
    throw new Error(`scope "${scopeName}" is not in package.json contributes.grammars (known: ${known})`);
  }
  const embeddedLanguages: vsctm.IEmbeddedLanguagesMap = {};
  for (const [scope, language] of Object.entries(entry.embeddedLanguages ?? {})) {
    embeddedLanguages[scope] = env.languageNumber.get(language)!;
  }
  const initialLanguage = entry.language === undefined ? 0 : env.languageNumber.get(entry.language)!;
  const grammar = await env.registry.loadGrammarWithConfiguration(scopeName, initialLanguage, {
    embeddedLanguages,
  });
  if (grammar === null) {
    throw new Error(`vscode-textmate could not load the grammar for "${scopeName}"`);
  }
  return grammar;
}

/**
 * Bits 0–7 of vscode-textmate's encoded token attributes hold the language number
 * (`EncodedTokenAttributes.getLanguageId`, which the package does not export).
 */
const LANGUAGE_ID_MASK = 0xff;

/** Tokenises `text` with the grammar of `scopeName`, line by line, carrying the rule stack. */
export async function tokenizeText(scopeName: string, text: string): Promise<TokenizeResult> {
  const grammar = await grammarFor(scopeName);
  const env = await getEnvironment();
  const languageName = (n: number): string => env.languages[n - 1]?.id ?? `<language ${n}>`;

  const lines: TokenizedLine[] = [];
  let ruleStack = vsctm.INITIAL;
  for (const line of text.split(/\r?\n/)) {
    const scoped = grammar.tokenizeLine(line, ruleStack);
    // Same input state, so the same tokenisation; only the per-token language is read from it.
    const encoded = grammar.tokenizeLine2(line, ruleStack).tokens;
    const languageAt = (offset: number): string => {
      let language = 0;
      for (let i = 0; i < encoded.length && encoded[i] <= offset; i += 2) {
        language = encoded[i + 1] & LANGUAGE_ID_MASK;
      }
      return languageName(language);
    };
    const tokens: Token[] = [];
    for (const t of scoped.tokens) {
      // vscode-textmate tokenises `line + "\n"`, so the last token may end one past the line.
      const endIndex = Math.min(t.endIndex, line.length);
      if (t.startIndex < endIndex) {
        tokens.push({
          startIndex: t.startIndex,
          endIndex,
          text: line.slice(t.startIndex, endIndex),
          scopes: t.scopes,
          language: languageAt(t.startIndex),
        });
      }
    }
    lines.push({ text: line, tokens });
    ruleStack = scoped.ruleStack;
  }
  return { scopeName, lines, ruleStack };
}

/** The contributed scope for a file, chosen from its extension as VS Code chooses it. */
export async function scopeForFile(file: string): Promise<string> {
  const env = await getEnvironment();
  const ext = path.extname(file).toLowerCase();
  const language = env.languages.find((l) => (l.extensions ?? []).some((e) => e.toLowerCase() === ext));
  if (language === undefined) {
    throw new Error(`no language in package.json contributes.languages claims the extension "${ext}" (${file})`);
  }
  const grammar = [...env.grammarsByScope.values()].find((g) => g.language === language.id);
  if (grammar === undefined) {
    throw new Error(`language "${language.id}" has no grammar in package.json contributes.grammars`);
  }
  return grammar.scopeName;
}

/** Tokenises a file with the grammar its extension selects (see `scopeForFile`). */
export async function tokenizeFile(file: string): Promise<TokenizeResult> {
  return tokenizeText(await scopeForFile(file), fs.readFileSync(file, 'utf8'));
}

/** The token covering 0-based `line`/`col`; throws when there is none. */
export function tokenAt(result: TokenizeResult, line: number, col: number): Token {
  const l = result.lines[line];
  if (l === undefined) {
    throw new RangeError(`line ${line} is out of range (0..${result.lines.length - 1})`);
  }
  const token = l.tokens.find((t) => t.startIndex <= col && col < t.endIndex);
  if (token === undefined) {
    throw new RangeError(`no token at ${line}:${col} (line length ${l.text.length})`);
  }
  return token;
}

/** The scopes (root first) of the token covering 0-based `line`/`col`. */
export function scopesAt(result: TokenizeResult, line: number, col: number): readonly string[] {
  return tokenAt(result, line, col).scopes;
}

/**
 * Whether one of `scopes` is `prefix` or lies below it in the dot hierarchy — the way a
 * TextMate selector matches: `keyword.control` matches `keyword.control.idris2` but not
 * `keyword.controlx`.
 */
export function hasScope(scopes: readonly string[], prefix: string): boolean {
  return scopes.some((s) => s === prefix || s.startsWith(`${prefix}.`));
}

/**
 * True when tokenisation ended back at the grammar's root rule, i.e. no begin/end or
 * begin/while construct (string, block comment, …) was left open by the last line. A fixture
 * that is complete Idris should always end at the root.
 */
export function endStateIsRoot(result: TokenizeResult): boolean {
  return result.ruleStack.depth <= 1;
}

/**
 * Rule-stack depth of `source.idris2.literate` with no Idris 2 construct open: the root, plus,
 * from the first code line on, the literate program and its embedded Idris 2 block, which stay
 * open to the end of the file (a prose line does not end them; see syntaxes/lidr.tmLanguage.json).
 */
export const LITERATE_BASE_DEPTH = 3;

/** `endStateIsRoot` for `source.idris2.literate`: no Idris 2 construct is open after the last line. */
export function literateEndStateIsBase(result: TokenizeResult): boolean {
  return result.ruleStack.depth <= LITERATE_BASE_DEPTH;
}

/** Scopes that only the literate grammar adds around embedded Idris 2 code. */
const LITERATE_ONLY = new Set(['source.idris2', 'source.idris2.literate', 'meta.embedded.block.idris2']);

/**
 * Per line of `text`, and per character from column `from` on, the scopes of its token under
 * `scopeName` without LITERATE_ONLY. Uses `tokenizeLine` only (no language pass), for speed.
 */
async function scopesPerChar(scopeName: string, text: string, from: number): Promise<string[][]> {
  const grammar = await grammarFor(scopeName);
  let ruleStack = vsctm.INITIAL;
  return text.split(/\r?\n/).map((line) => {
    const r = grammar.tokenizeLine(line, ruleStack);
    ruleStack = r.ruleStack;
    const out: string[] = [];
    for (const t of r.tokens) {
      for (let i = Math.max(t.startIndex, from); i < Math.min(t.endIndex, line.length); i++) {
        out[i - from] = t.scopes.filter((s) => !LITERATE_ONLY.has(s)).join(' ');
      }
    }
    return out;
  });
}

/**
 * Tokenises `idrText` as `source.idris2`, and again as bird-track code (`> ` before every
 * line, `>` for an empty one) with `source.idris2.literate`, and returns one entry for each line
 * whose scopes differ (at its first differing character, 1-based `line:col` of `idrText`); code
 * on a bird-track line must tokenise exactly as in a .idr file.
 *
 * With `prose`, the literate text also has the line `prose` after every code line, and the .idr
 * text an empty line in the same place, because that is what the compiler's unlit step makes of
 * a prose line; the code lines must still tokenise alike.
 */
export async function birdTrackDifferences(idrText: string, prose?: string): Promise<string[]> {
  const lines = idrText.split(/\r?\n/);
  const step = prose === undefined ? 1 : 2;
  const idrLines = prose === undefined ? lines : lines.flatMap((l) => [l, '']);
  const lidrLines = lines.flatMap((l) => {
    const code = l === '' ? '>' : `> ${l}`;
    return prose === undefined ? [code] : [code, prose];
  });
  const idr = await scopesPerChar('source.idris2', idrLines.join('\n'), 0);
  const lidr = await scopesPerChar('source.idris2.literate', lidrLines.join('\n'), 2);
  const differences: string[] = [];
  lines.forEach((text, n) => {
    const [a, b] = [idr[n * step], lidr[n * step]];
    for (let i = 0; i < text.length; i++) {
      if (a[i] !== b[i]) {
        differences.push(`${n + 1}:${i + 1} idr [${a[i]}] lidr [${b[i]}] ${text.trim()}`);
        break;
      }
    }
  });
  return differences;
}

const SNAPSHOT_HEADER =
  '# vscode-textmate snapshot. One token per line: LINE:START-END "text" scopes (0-based,\n' +
  '# end exclusive, root scope omitted). Regenerate with UPDATE_SNAPSHOTS=1.\n';

/**
 * A stable text rendering for review in diffs: a header, then one line per non-empty token,
 * `L:C-C "text" scope1 scope2…` with the text JSON-quoted and the root scope left out.
 */
export function renderSnapshot(result: TokenizeResult): string {
  const out: string[] = [];
  result.lines.forEach((line, n) => {
    for (const t of line.tokens) {
      const scopes = t.scopes.slice(1).join(' ');
      out.push(`${n}:${t.startIndex}-${t.endIndex} ${JSON.stringify(t.text)}${scopes ? ` ${scopes}` : ''}`);
    }
  });
  return SNAPSHOT_HEADER + out.map((l) => `${l}\n`).join('');
}

export const SNAPSHOT_DIR: string = path.join(repoRoot, 'test', 'grammar', 'snapshots');

export type SnapshotOutcome = 'matched' | 'created' | 'updated';

/**
 * Compares `renderSnapshot(result)` with `test/grammar/snapshots/<basename of fixturePath>.snap`.
 *
 * - `UPDATE_SNAPSHOTS=1`: (re)writes the file; returns `updated` (or `created`).
 * - Missing file: writes it and returns `created` — except under `CI` (set by GitHub Actions),
 *   where a missing snapshot fails, so that CI never passes by recording its own expectation.
 * - Otherwise: returns `matched`, or fails with mocha's diff of expected vs actual.
 */
export function matchSnapshot(fixturePath: string, result: TokenizeResult): SnapshotOutcome {
  const file = path.join(SNAPSHOT_DIR, `${path.basename(fixturePath)}.snap`);
  const actual = renderSnapshot(result);
  const exists = fs.existsSync(file);
  if (process.env.UPDATE_SNAPSHOTS === '1' || !exists) {
    if (!exists && process.env.CI) {
      assert.fail(`snapshot ${path.relative(repoRoot, file)} is missing; create it locally and commit it`);
    }
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    return exists ? 'updated' : 'created';
  }
  assert.strictEqual(actual, fs.readFileSync(file, 'utf8'), `snapshot ${path.relative(repoRoot, file)} differs`);
  return 'matched';
}
