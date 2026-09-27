#!/usr/bin/env node
// Generates syntaxes/idris2.tmLanguage.json from syntaxes/src/idris2.grammar.mjs.
//
//   node scripts/build-grammar.mjs           write the JSON
//   node scripts/build-grammar.mjs --check   exit 1 if the committed JSON differs from the generated one
//
// The keyword, pragma and operator lists live as data in the generator, next to the lexer and
// parser references they were copied from; the JSON is committed so that the extension needs no
// build step for its grammar, and test/grammar/idris2.test.ts runs --check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrammar } from '../syntaxes/src/idris2.grammar.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repo, 'syntaxes', 'idris2.tmLanguage.json');
const generated = `${JSON.stringify(buildGrammar(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const committed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (committed !== generated) {
    console.error(`${path.relative(repo, target)} is out of date: run node scripts/build-grammar.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(repo, target)} is up to date`);
} else {
  fs.writeFileSync(target, generated);
  console.log(`wrote ${path.relative(repo, target)}`);
}
