#!/usr/bin/env node
// Generates language-configuration/{idris2,lidr,ipkg}.json.
//
//   node scripts/build-language-configuration.mjs           write the three files
//   node scripts/build-language-configuration.mjs --check   exit 1 if a committed file differs
//
// The files are committed so that the extension needs no build step; the generator exists
// because lidr.json repeats the Idris Enter rules once per bird-track indentation depth (133
// rules) and must not be edited by hand. test/unit/languageConfiguration.test.ts runs --check
// and pins the behaviour of every rule; test/integration/editor.test.ts checks them in VS Code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Character classes (regex source), traced to src/Parser/Lexer/Common.idr and Core/Name.idr
// (identical on Idris 2 master 1c630e6 and v0.8.0 apart from imports).
// isIdentStart Normal without '_': for identifiers the symbols list wins (`_x` is `_` then `x`),
// but not after a hole's `?` — holeIdent (`is '?' <+> identNormal`, Lexer/Source.idr) comes before
// the symbols in rawTokens, so `?_foo` and `?_` are holes (both pass idris2 0.8.0 --check).
const S = 'A-Za-z\\u00A1-\\uFFFF';
const T = "\\w'\\u00A1-\\uFFFF"; // isIdentTrailing Normal
const O = ':!#$%&*+./<=>?@\\\\^|~-'; // isOpChar
const IDENT = `[${S}][${T}]*`;

// A `?hole` is one word unless its `?` is part of an operator; an identifier is a word unless
// it continues an identifier, a digit run (the letters of 0xFF, 1.5e10) or a prime.
const wordPattern = `(?<![${O}])\\?[_${S}][${T}]*` + `|(?<![${S}][${T}]*|[0-9']|(?:^|[^${O}])\\?)${IDENT}`;

// .ipkg names may contain dashes (package names, src/Parser/Lexer/Package.idr).
const SI = 'A-Za-z_\\u00A1-\\uFFFF';
const TI = "\\w'\\-\\u00A1-\\uFFFF";
const ipkgWordPattern = `(?<![${SI}][${TI}]*|[0-9])[${SI}][${TI}]*`;

// A line comment: `--` (plus dashes) not followed by `}`; never part of a longer operator.
const COMMENT = '--(?!-*\\})';
const TRAIL = `\\s*(?:${COMMENT}.*)?$`;
// Code before the opener: anything that does not start a line comment.
const CODE = `(?:(?!(?<![${O}])${COMMENT}).)*`;
const OPENER = `(?:(?<![${T}?])(?:where|do|of|let)|\\\\\\s*case|(?<![${O}])(?:=>?|->))`;
const HEADER = `(?:mutual|failing|namespace|parameters|using)(?![${T}]).*$`;

const openerAfterIndent = `(?:${HEADER}|(?!\\|\\|\\|)${CODE}${OPENER}${TRAIL})`;
const birdOpenerAfterIndent = `(?:${HEADER}|(?!\\|\\|\\|)${CODE}(?:${OPENER}|[([{])${TRAIL})`;

const idrisRules = [{ beforeText: `^\\s*${openerAfterIndent}`, action: { indent: 'indent' } }];

// On a bird-track code line, Enter repeats the marker and the indentation after it (one rule per
// depth, because appendText is a constant), plus one level after an opener or an open bracket.
// Deeper lines, and a tab after the marker, fall back to the marker and one space.
const MAX_BIRD_INDENT = 32;
const birdRules = [];
for (const m of ['>', '<']) {
  // Neither '>' nor '<' is special in a JavaScript regex.
  birdRules.push({ beforeText: `^${m}$`, action: { indent: 'none', appendText: `${m} ` } });
  for (let d = 1; d <= MAX_BIRD_INDENT; d++) {
    birdRules.push({
      beforeText: `^${m} {${d}}(?! )${birdOpenerAfterIndent}`,
      action: { indent: 'none', appendText: m + ' '.repeat(d + 2) },
    });
    birdRules.push({
      beforeText: `^${m} {${d}}(?! )`,
      action: { indent: 'none', appendText: m + ' '.repeat(d) },
    });
  }
  birdRules.push({ beforeText: `^${m}\\s`, action: { indent: 'none', appendText: `${m} ` } });
}
// Prose lines: a plain newline, never VS Code's bracket-based indentation.
birdRules.push({ beforeText: '^', action: { indent: 'none' } });

const idrisPairs = {
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: '`', close: '`', notIn: ['string', 'comment'] },
    { open: '{-', close: ' -}', notIn: ['string'] },
  ],
  surroundingPairs: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
    ['"', '"'],
    ['`', '`'],
  ],
};

const configurations = {
  idris2: {
    comments: { lineComment: '--', blockComment: ['{-', '-}'] },
    ...idrisPairs,
    wordPattern,
    folding: { offSide: true },
    onEnterRules: idrisRules,
  },
  // No block comment: Toggle Block Comment over bird-track lines would put `{-` before a
  // marker. Over several code lines the compiler then rejects the `-}` left on a code line;
  // over a single line the line silently becomes prose (see README and
  // test/unit/languageConfiguration.test.ts).
  lidr: {
    comments: { lineComment: '--' },
    ...idrisPairs,
    wordPattern,
    onEnterRules: birdRules,
  },
  ipkg: {
    comments: { lineComment: '--', blockComment: ['{-', '-}'] },
    autoClosingPairs: [
      { open: '"', close: '"', notIn: ['string'] },
      { open: '{-', close: ' -}', notIn: ['string'] },
    ],
    surroundingPairs: [['"', '"']],
    wordPattern: ipkgWordPattern,
    onEnterRules: [{ beforeText: `^(?:(?!${COMMENT}).)*(?<![<>=])=${TRAIL}`, action: { indent: 'indent' } }],
  },
};

/** Two-level layout: one line per array element or nested key, so each rule reads on one line. */
function format(conf) {
  const lines = ['{'];
  const keys = Object.keys(conf);
  keys.forEach((k, i) => {
    const v = conf[k];
    const comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(v)) {
      lines.push(`  ${JSON.stringify(k)}: [`);
      v.forEach((e, j) => lines.push(`    ${JSON.stringify(e)}${j < v.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else if (v !== null && typeof v === 'object') {
      lines.push(`  ${JSON.stringify(k)}: {`);
      const ks = Object.keys(v);
      ks.forEach((kk, j) => lines.push(`    ${JSON.stringify(kk)}: ${JSON.stringify(v[kk])}${j < ks.length - 1 ? ',' : ''}`));
      lines.push(`  }${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
    }
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
let stale = 0;
for (const [name, conf] of Object.entries(configurations)) {
  const target = path.join(repo, 'language-configuration', `${name}.json`);
  const rel = path.relative(repo, target);
  const generated = format(conf);
  if (check) {
    const committed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (committed === generated) {
      console.log(`${rel} is up to date`);
    } else {
      console.error(`${rel} is out of date: run node scripts/build-language-configuration.mjs`);
      stale++;
    }
  } else {
    fs.writeFileSync(target, generated);
    console.log(`wrote ${rel}`);
  }
}
process.exitCode = stale > 0 ? 1 : 0;
