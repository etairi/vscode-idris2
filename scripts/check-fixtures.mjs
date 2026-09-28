#!/usr/bin/env node
// Checks that every committed Idris fixture is valid for the installed compiler:
//   *.idr, *.lidr  →  idris2 --check    (from the file's source root, see sourceRoot below);
//                     also the literate double extensions *.idr.<ext> and *.lidr.<ext>
//                     (<ext> from the compiler's table, src/project/literate.ts), which the
//                     extension treats as Idris whatever their language mode; a bare .md, .tex,
//                     … fixture is its host language's and is not checked
//   *.ipkg         →  idris2 --dump-ipkg-json   (from the file's directory)
// Files named *.invalid.idr / *.invalid.lidr / *.invalid.ipkg are skipped: they are fixtures
// that are deliberately not valid Idris. The fixtures of the `broken` workspace (M2: the
// IDE-mode transcripts and the diagnostics tests load them) keep their names, which their module
// names and the recorded transcripts depend on; instead EXPECTED_PROBLEMS below lists what each
// must report, and such a file passes only when the compiler exits 1 with exactly those
// `Error:`/`Warning:` lines and location lines — so a broken fixture that starts to compile, or
// fails for another reason, is reported.
//
// It then checks every snippet in snippets/*.json the same way: each body is expanded as VS Code
// expands it with its defaults (every option of a choice in turn) into a host file from
// SNIPPET_HOSTS below, which supplies the declarations around it.
//
// The whole of test/fixtures is copied to a temporary directory first, and the snippet hosts
// are written there too, so the build/ directories the compiler writes never land in the
// repository. A check fails when the exit code is not 0, when the output contains "not found"
// (`--check` exits 0 on `Module X not found`, F9 in docs/ROADMAP.md §0), or when an output line
// starts with "Error:".
//
// Usage: node scripts/check-fixtures.mjs          (IDRIS2=<path> overrides the binary)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(repo, 'test', 'fixtures');
const idris2 = process.env.IDRIS2 || 'idris2';

function run(args, cwd) {
  const r = spawnSync(idris2, args, { cwd, encoding: 'utf8' });
  if (r.error) {
    throw new Error(`cannot run ${idris2}: ${r.error.message}`);
  }
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** `.idr.<ext>` / `.lidr.<ext>` for each literate extension of `src/Parser/Unlit.idr`. */
const DOUBLE_EXTENSION = /\.(idr|lidr)\.(lidr|org|md|markdown|dj|tex|ltx|typ)$/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'build') { yield* walk(p); }
    } else if (entry.isFile()) {
      yield p;
    }
  }
}

/**
 * The directory to run `--check` from. `--check` applies no .ipkg (only `--find-ipkg` does,
 * src/Idris/Driver.idr 193), so the source directory is the cwd, and a file declaring
 * `module A.B.C` must sit at A/B/C.<ext> below it — otherwise the compiler reports "Module name
 * … does not match file name". The declaration is looked for at the start of a line, after a
 * bird track (`>` or `<` and blanks) in a .lidr file. A file without one is module Main and is
 * checked from its own directory, as is a file whose path does not end in its module path (the
 * compiler then reports the mismatch).
 */
function sourceRoot(file) {
  const text = fs.readFileSync(file, 'utf8');
  const decl = file.endsWith('.lidr') ? /^[><][ \t]+module[ \t]+(\S+)/m : /^module[ \t]+(\S+)/m;
  const m = decl.exec(text);
  const dir = path.dirname(file);
  if (m === null) {
    return dir;
  }
  const parents = m[1].split('.').slice(0, -1);
  const tail = parents.join(path.sep);
  return parents.length > 0 && dir.endsWith(path.sep + tail) ? dir.slice(0, -(tail.length + 1)) : dir;
}

// ---------------------------------------------------------------------------------------------
// Snippet expansion. The TextMate snippet grammar as VS Code implements it
// (editor/contrib/snippet/browser/snippetParser.ts): `$n`, `${n}`, `${n:default}`, `${n|a,b|}`,
// `$NAME`, `${NAME}`, `${NAME:default}`; `\` escapes `$`, `}` and `\` (and `,` `|` in a choice).
// Defaults may nest markers. Every occurrence of tab stop n shows the default of the first
// placeholder or choice numbered n; `$0` is the final cursor and inserts nothing.
// ---------------------------------------------------------------------------------------------

/** Parses `text` from `i` up to an unescaped `}` (when `nested`) into nodes. */
function parseSnippet(text, i = 0, nested = false) {
  const nodes = [];
  let literal = '';
  const flush = () => {
    if (literal !== '') { nodes.push({ kind: 'text', value: literal }); literal = ''; }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && '$}\\'.includes(text[i + 1] ?? '')) {
      literal += text[i + 1];
      i += 2;
    } else if (c === '}' && nested) {
      flush();
      return { nodes, end: i + 1 };
    } else if (c === '$') {
      const m = /^\$(?:(\d+)|([A-Za-z_]\w*)|\{(\d+)([:|}])|\{([A-Za-z_]\w*)([:}]))/.exec(text.slice(i));
      if (m === null) {
        literal += c;
        i++;
        continue;
      }
      flush();
      i += m[0].length;
      if (m[1] !== undefined) {
        nodes.push({ kind: 'tabstop', index: Number(m[1]) });
      } else if (m[2] !== undefined) {
        nodes.push({ kind: 'variable', name: m[2] });
      } else if (m[3] !== undefined && m[4] === '}') {
        nodes.push({ kind: 'tabstop', index: Number(m[3]) });
      } else if (m[3] !== undefined && m[4] === ':') {
        const inner = parseSnippet(text, i, true);
        nodes.push({ kind: 'tabstop', index: Number(m[3]), children: inner.nodes });
        i = inner.end;
      } else if (m[3] !== undefined) {
        const close = text.indexOf('|}', i);
        if (close < 0) { throw new Error(`unterminated choice in ${JSON.stringify(text)}`); }
        const options = text.slice(i, close).split(/(?<!\\),/).map((o) => o.replace(/\\([,|\\$}])/g, '$1'));
        nodes.push({ kind: 'tabstop', index: Number(m[3]), options });
        i = close + 2;
      } else if (m[6] === '}') {
        nodes.push({ kind: 'variable', name: m[5] });
      } else {
        const inner = parseSnippet(text, i, true);
        nodes.push({ kind: 'variable', name: m[5], children: inner.nodes });
        i = inner.end;
      }
    } else {
      literal += c;
      i++;
    }
  }
  if (nested) { throw new Error(`unterminated \${ in ${JSON.stringify(text)}`); }
  flush();
  return { nodes, end: i };
}

/** Every expansion of `body` (one per combination of choice options), with `variables`. */
function expandSnippet(body, variables) {
  const { nodes } = parseSnippet(body);
  const definitions = new Map(); // tab stop → its first placeholder or choice node
  const visit = (list) => {
    for (const node of list) {
      if (node.kind === 'tabstop' && (node.children || node.options) && !definitions.has(node.index)) {
        definitions.set(node.index, node);
      }
      if (node.children) { visit(node.children); }
    }
  };
  visit(nodes);
  const choices = [...definitions.values()].filter((d) => d.options);
  let combos = [new Map()];
  for (const choice of choices) {
    combos = combos.flatMap((combo) => choice.options.map((o) => new Map([...combo, [choice.index, o]])));
  }
  return combos.map((picked) => {
    const render = (list, seen) => list.map((node) => {
      if (node.kind === 'text') { return node.value; }
      if (node.kind === 'variable') {
        if (!(node.name in variables)) { throw new Error(`no value for snippet variable ${node.name}`); }
        return variables[node.name];
      }
      if (node.index === 0) { return ''; }
      if (picked.has(node.index)) { return picked.get(node.index); }
      const def = definitions.get(node.index);
      if (def === undefined) { return ''; }
      if (seen.has(node.index)) { throw new Error(`tab stop ${node.index} contains itself`); }
      return render(def.children, new Set([...seen, node.index]));
    }).join('');
    return render(nodes, new Set());
  });
}

/**
 * Inserts an expansion where `@@` stands in `host`, as VS Code inserts a snippet with the
 * `[idris2]` defaults (editor.insertSpaces, editor.tabSize 2): a leading tab becomes two spaces,
 * and every line after the first is prefixed with the indentation of the line holding `@@`.
 */
function insertSnippet(host, expansion) {
  const at = host.indexOf('@@');
  const indent = /[ \t]*$/.exec(host.slice(0, at))[0];
  const lines = expansion.split('\n').map((line, k) => {
    const normalised = line.replace(/^\t+/, (tabs) => '  '.repeat(tabs.length));
    return k === 0 ? normalised : indent + normalised;
  });
  return host.slice(0, at) + lines.join('\n') + host.slice(at + 2);
}

/**
 * The context each snippet is checked in: the file it is expanded into, the text around it
 * (`@@` marks where the prefix is typed) and any other files the check needs. Keyed by
 * language, then by the snippet's name in snippets/<language>.json; a snippet without an
 * entry fails the check.
 */
const SNIPPET_HOSTS = {
  idris2: {
    'Module header': { file: 'Snip.idr', text: '@@\n' },
    'Data type (GADT syntax)': { file: 'Main.idr', text: '@@\n' },
    Record: { file: 'Main.idr', text: '@@\n' },
    Interface: { file: 'Main.idr', text: '@@\n' },
    Implementation: { file: 'Main.idr', text: 'data MyType = A\n\n@@\n' },
    'Case expression': { file: 'Main.idr', text: 'f : Nat -> Nat\nf x =\n  @@\n' },
    'With clause': { file: 'Main.idr', text: 'expr : Nat\nexpr = 0\n\nf : Nat -> Nat\n@@\n' },
    'Where block': { file: 'Main.idr', text: 'f : Nat\nf = helper\n  @@\n' },
    'Do block': { file: 'Main.idr', text: 'main : IO ()\nmain =\n  @@\n' },
    'Let expression': { file: 'Main.idr', text: 'f : Nat\nf =\n  @@\n' },
    'Lambda case': { file: 'Main.idr', text: 'f : Nat -> Nat\nf =\n  @@\n' },
    'Failing block': { file: 'Main.idr', text: '@@\n' },
    Namespace: { file: 'Main.idr', text: '@@\n' },
    'Parameters block': { file: 'Main.idr', text: '@@\n' },
    'Default totality': { file: 'Main.idr', text: '@@\n\nf : Nat\nf = 0\n' },
    'Main function': { file: 'Main.idr', text: '@@\n' },
  },
  ipkg: {
    'Package description': {
      file: 'snip.ipkg',
      text: '@@\n',
      extra: { 'src/Main.idr': 'main : IO ()\nmain = pure ()\n' },
    },
    'Executable fields': {
      file: 'snip.ipkg',
      text: 'package snip\n@@\n',
      extra: { 'Main.idr': 'main : IO ()\nmain = pure ()\n' },
    },
  },
};

/** Writes every snippet expansion into its host under `dir`; yields the files to check. */
function* snippetChecks(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  for (const { language, path: file } of manifest.contributes.snippets) {
    const snippets = JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
    for (const [name, snippet] of Object.entries(snippets)) {
      const host = SNIPPET_HOSTS[language]?.[name];
      const label = `snippet ${language} "${name}"`;
      if (host === undefined) {
        yield { label, error: 'no entry in SNIPPET_HOSTS (scripts/check-fixtures.mjs)' };
        continue;
      }
      const base = path.basename(host.file, path.extname(host.file));
      const expansions = expandSnippet(snippet.body.join('\n'), { TM_FILENAME_BASE: base });
      for (const [k, expansion] of expansions.entries()) {
        const where = path.join(dir, language, `${Object.keys(snippets).indexOf(name)}-${k}`);
        fs.mkdirSync(where, { recursive: true });
        for (const [extra, text] of Object.entries(host.extra ?? {})) {
          fs.mkdirSync(path.dirname(path.join(where, extra)), { recursive: true });
          fs.writeFileSync(path.join(where, extra), text);
        }
        const target = path.join(where, host.file);
        fs.writeFileSync(target, insertSnippet(host.text, expansion));
        yield { label: expansions.length > 1 ? `${label} #${k + 1}` : label, file: target };
      }
    }
  }
}

/**
 * The deliberately broken fixtures (paths relative to test/fixtures) and the `Error:`/`Warning:`
 * lines and location lines each must print, in order; observed with Idris 2 0.8.0 on 2026-09-27.
 */
const EXPECTED_PROBLEMS = {
  'workspaces/broken/Bad.idr': ['Error: While processing right hand side of f. When unifying:', 'Bad:4:7--4:12'],
  'workspaces/broken/Err.lidr': ["Error: While processing right hand side of g. Can't find an implementation for FromString Nat.", 'Err:9:5--9:8'],
  'workspaces/broken/ErrMd.idr.md': [
    "Error: While processing right hand side of g. Can't find an implementation for FromString Nat.",
    'ErrMd:9:5--9:8',
  ],
  'workspaces/broken/Mixed.idr': [
    'Warning: Unreachable clause: f n',
    'Mixed:5:1--5:4',
    'Error: While processing right hand side of g. When unifying:',
    'Mixed:8:7--8:8',
  ],
  'workspaces/broken/Part.idr': ['Error: g is not covering.', 'Part:3:1--3:15', 'Error: main is not covering.', 'Part:6:1--6:13'],
  'workspaces/broken/UsesBad.idr': ['Error: While processing right hand side of f. When unifying:', 'Bad:4:7--4:12'],
  'workspaces/broken/bad-ipkg/bad.ipkg': ['Error: Unrecognised property "pkgs".', '"bad.ipkg":3:1--3:5'],
};

/** The `Error:`/`Warning:` lines and the location lines (`Mod:L:C--L:C`, `"x.ipkg":L:C--L:C`) of `output`. */
function problemLines(output) {
  return output.split(/\r?\n/).filter((line) => /^(Error|Warning): /.test(line) || /^("[^"]*"|\S+):\d+:\d+--\d+:\d+$/.test(line));
}

/** The idris2 invocation that checks `file`: [cwd, args]. */
function checkCommand(file) {
  if (/\.(idr|lidr)$/.test(file) || DOUBLE_EXTENSION.test(file)) {
    const cwd = sourceRoot(file);
    return [cwd, ['--check', path.relative(cwd, file)]];
  }
  return [path.dirname(file), ['--dump-ipkg-json', path.basename(file)]];
}

const version = run(['--version'], repo);
console.log(`Using ${idris2}: ${version.output.trim()}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-fixtures-'));
let failures = 0;
let checked = 0;

function check(label, file, expected) {
  const [cwd, args] = checkCommand(file);
  checked++;
  const r = run(args, cwd);
  const bad =
    expected === undefined
      ? r.status !== 0 || /not found/i.test(r.output) || /^Error:/m.test(r.output)
      : r.status !== 1 || JSON.stringify(problemLines(r.output)) !== JSON.stringify(expected);
  const as = expected === undefined ? '' : ', expected to fail';
  console.log(`${bad ? 'FAIL' : 'ok  '}  ${label}   (idris2 ${args.join(' ')} in ${path.relative(tmp, cwd) || '.'}${as})`);
  if (bad) {
    if (expected !== undefined) {
      console.log(`      expected exit 1 with:\n${expected.map((line) => `      ! ${line}`).join('\n')}`);
    }
    failures++;
    console.log(`      exit ${r.status}\n${r.output.replace(/^/gm, '      | ')}`);
    console.log(fs.readFileSync(file, 'utf8').replace(/^/gm, '      > '));
  }
}

try {
  fs.cpSync(fixtures, tmp, { recursive: true, filter: (src) => path.basename(src) !== 'build' });
  for (const rel of Object.keys(EXPECTED_PROBLEMS)) {
    if (!fs.existsSync(path.join(tmp, rel))) {
      checked++;
      failures++;
      console.log(`FAIL  ${rel}: listed in EXPECTED_PROBLEMS but missing`);
    }
  }
  for (const file of walk(tmp)) {
    const rel = path.relative(tmp, file);
    if (/\.invalid\.(idr|lidr|ipkg)$/.test(file)) {
      console.log(`skip  ${rel}`);
      continue;
    }
    if (/\.(idr|lidr|ipkg)$/.test(file) || DOUBLE_EXTENSION.test(file)) {
      check(rel, file, EXPECTED_PROBLEMS[rel.split(path.sep).join('/')]);
    }
  }
  const snippetDir = path.join(tmp, '.snippets');
  for (const item of snippetChecks(snippetDir)) {
    if (item.error !== undefined) {
      checked++;
      failures++;
      console.log(`FAIL  ${item.label}: ${item.error}`);
    } else {
      check(item.label, item.file);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${checked} fixture(s) and snippet expansion(s) checked, ${failures} failed.`);
process.exitCode = failures > 0 || checked === 0 ? 1 : 0;
