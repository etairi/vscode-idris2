import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Tests for snippets/idris2.json and snippets/ipkg.json, found through package.json's
// contributes.snippets. That every body, expanded with its defaults, is valid Idris 2 (or a valid
// .ipkg) is not checked here, because it needs the compiler: `npm run check:fixtures` expands each
// snippet into a host file and runs idris2 --check / --dump-ipkg-json on it.

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

interface Snippet {
  prefix: string | string[];
  body: string[];
  description: string;
}

const root = repoRoot();
const contributed = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { snippets: { language: string; path: string }[] };
}).contributes.snippets;

/**
 * The tab stops, placeholders, choices and variables of a snippet body, following the
 * TextMate snippet grammar that VS Code implements (editor/contrib/snippet/browser/snippetParser.ts):
 * `$n`, `${n}`, `${n:default}`, `${n|a,b|}`, `$NAME`, `${NAME}`, `${NAME:default}`; `\` escapes
 * `$`, `}` and `\`. Throws on an unterminated `${`.
 */
function markers(body: string): { tabstops: number[]; variables: string[] } {
  const tabstops: number[] = [];
  const variables: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
    } else if (c === '$') {
      const m = /^\$(?:(\d+)|\{(\d+)(?=[:}|])|([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?=[:}]))/.exec(body.slice(i));
      if (m) {
        if (m[1] ?? m[2]) {
          tabstops.push(Number(m[1] ?? m[2]));
        } else {
          variables.push(m[3] ?? m[4]);
        }
        if (m[2] !== undefined || m[4] !== undefined) {
          depth++;
        }
        i += m[0].length - 1;
      }
    } else if (c === '}' && depth > 0) {
      depth--;
    }
  }
  if (depth !== 0) {
    throw new Error(`unterminated \${ in ${JSON.stringify(body)}`);
  }
  return { tabstops, variables };
}

for (const { language, path: file } of contributed) {
  suite(`snippets for ${language} (${file})`, () => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');

    test('is well-formed JSON of named snippets', () => {
      const snippets = JSON.parse(text) as Record<string, Snippet>;
      assert.ok(Object.keys(snippets).length > 0);
      for (const [name, s] of Object.entries(snippets)) {
        assert.deepStrictEqual(Object.keys(s).sort(), ['body', 'description', 'prefix'], name);
        const prefixes = Array.isArray(s.prefix) ? s.prefix : [s.prefix];
        assert.ok(prefixes.length > 0 && prefixes.every((p) => typeof p === 'string' && p.length > 0), `${name}: prefix`);
        assert.ok(Array.isArray(s.body) && s.body.length > 0, `${name}: body`);
        assert.ok(s.body.every((l) => typeof l === 'string'), `${name}: body lines must be strings`);
        assert.ok(typeof s.description === 'string' && s.description.length > 0, `${name}: description`);
      }
    });

    test('prefixes are unique', () => {
      const snippets = JSON.parse(text) as Record<string, Snippet>;
      const seen = new Map<string, string>();
      for (const [name, s] of Object.entries(snippets)) {
        for (const p of Array.isArray(s.prefix) ? s.prefix : [s.prefix]) {
          assert.ok(!seen.has(p), `prefix ${JSON.stringify(p)} of "${name}" is also used by "${seen.get(p)}"`);
          seen.set(p, name);
        }
      }
    });

    test('bodies indent with tabs only and have no trailing whitespace', () => {
      // VS Code converts a leading tab to the editor's indentation and prepends the current
      // line's indentation to every following line, so relative layout survives any tab size.
      const snippets = JSON.parse(text) as Record<string, Snippet>;
      for (const [name, s] of Object.entries(snippets)) {
        for (const line of s.body) {
          assert.ok(/^\t*(?! )/.test(line), `${name}: ${JSON.stringify(line)} is indented with spaces`);
          assert.ok(!/[ \t]$/.test(line), `${name}: ${JSON.stringify(line)} has trailing whitespace`);
        }
      }
    });

    test('tab stops are well-formed and only known variables are used', () => {
      const snippets = JSON.parse(text) as Record<string, Snippet>;
      for (const [name, s] of Object.entries(snippets)) {
        const { tabstops, variables } = markers(s.body.join('\n'));
        assert.ok(tabstops.length > 0, `${name}: no tab stops`);
        assert.ok(tabstops.filter((t) => t === 0).length <= 1, `${name}: $0 appears more than once`);
        const numbered = [...new Set(tabstops.filter((t) => t > 0))].sort((a, b) => a - b);
        assert.deepStrictEqual(numbered, numbered.map((_, i) => i + 1), `${name}: tab stops are not 1..n`);
        for (const v of variables) {
          assert.ok(v === 'TM_FILENAME_BASE', `${name}: unexpected variable ${v}`);
        }
      }
    });
  });
}

test('snippets are contributed for idris2 and ipkg only', () => {
  // lidr has none: the bodies' continuation lines would lack the `> ` bird track.
  assert.deepStrictEqual(contributed.map((c) => c.language).sort(), ['idris2', 'ipkg']);
});
