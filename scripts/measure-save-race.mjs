#!/usr/bin/env node
// A save during a load, on the real compiler (docs/measurements/save-race.md). Each round saves a file,
// starts a load, saves the file again while it runs, as VS Code writes a file (open with 'w', then
// write), lets the load end, and loads once more, as the check after that save does. Then it asks the
// compiler for `marker`: what the second save wrote is the only right answer. One compiler process.
//
//   node scripts/measure-save-race.mjs [--rounds 40] [--seed 12345] [--gap 15] [--max-delay 20] [--cure]
//
// --gap: milliseconds between truncating the file and writing it, 0 for as fast as Node does.
// --max-delay: the second save comes up to that many milliseconds into the load; 0 for anywhere in it.
// --cure: what the extension does (src/backend/ide/buildFiles.ts), right before the last load.
// IDRIS2 names the compiler (default: `idris2` on PATH).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const option = (name, otherwise) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? otherwise : Number(process.argv[at + 1]);
};
const rounds = option('rounds', 40);
const gap = option('gap', 0);
const maxDelay = option('max-delay', 0);
const cure = process.argv.includes('--cure');
let state = option('seed', 12345);
const random = (below) => {
  state = (state * 1103515245 + 12345) & 0x7fffffff;
  return state % below;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-race-'));
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'p.ipkg'), 'package p\nsourcedir = "src"\nmodules = M\n');
const file = path.join(dir, 'src', 'M.idr');
const padding = Array.from({ length: 60 }, (_, i) => `f${i} : Nat -> List Nat -> List Nat\nf${i} x xs = map (+ x) (x :: ${i} :: xs)\n`).join('\n');
const text = (marker) => `module M\n\n${padding}\nmarker : Nat\nmarker = ${marker}\n`;

const compiler = spawn(process.env.IDRIS2 ?? 'idris2', ['--ide-mode', '--no-color', '--build-dir', path.join(dir, 'build')], { cwd: dir });
let input = '';
const waiting = new Map();
compiler.stdout.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    if (input.length < 6) {
      return;
    }
    const length = parseInt(input.slice(0, 6), 16);
    if (input.length < 6 + length) {
      return;
    }
    const message = input.slice(6, 6 + length);
    input = input.slice(6 + length);
    const reply = /^\(:return \((:ok|:error)(.*) (\d+)\)\n?$/s.exec(message);
    if (reply !== null && waiting.has(Number(reply[3]))) {
      waiting.get(Number(reply[3]))({ kind: reply[1], body: reply[2] });
      waiting.delete(Number(reply[3]));
    }
  }
});
let id = 0;
const request = (command) =>
  new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    const line = `(${command} ${id})\n`;
    compiler.stdin.write(line.length.toString(16).padStart(6, '0') + line);
  });
const load = () => request('(:load-file "src/M.idr")');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const save = async (contents, wide = 0) => {
  const handle = await fs.promises.open(file, 'w');
  if (wide > 0) {
    await sleep(wide);
  }
  await handle.write(contents);
  await handle.close();
};

const outdate = async () => {
  const ttcDir = path.join(dir, 'build', 'ttc');
  const source = fs.statSync(file, { bigint: true }).mtimeNs;
  let count = 0;
  for (const version of fs.existsSync(ttcDir) ? fs.readdirSync(ttcDir) : []) {
    const ttc = path.join(ttcDir, version, 'M.ttc');
    if (fs.existsSync(ttc) && fs.statSync(ttc, { bigint: true }).mtimeNs > source) {
      await fs.promises.utimes(ttc, 0, 0);
      count += 1;
    }
  }
  return count;
};

fs.writeFileSync(file, text(0));
const started = Date.now();
await load();
const loadMs = Date.now() - started;
const counts = { right: 0, earlierText: 0, emptyModule: 0, other: 0, setBack: 0 };
for (let round = 1; round <= rounds; round++) {
  const first = 1000 + 2 * round;
  const second = first + 1;
  await sleep(15); // a new modification time
  await save(text(first));
  const loading = load();
  await sleep(random(maxDelay > 0 ? maxDelay : Math.max(1, Math.floor(loadMs * 0.9))));
  await save(text(second), gap);
  await loading;
  if (cure) {
    counts.setBack += await outdate();
  }
  await load();
  const answer = await request('(:interpret "marker")');
  const value = /"(\d+)"/.exec(answer.body)?.[1];
  if (value === String(second)) {
    counts.right += 1;
  } else if (value === String(first)) {
    counts.earlierText += 1;
  } else if (answer.kind === ':error' && /Undefined name marker/.test(answer.body)) {
    counts.emptyModule += 1;
  } else {
    counts.other += 1;
  }
  await sleep(15);
  await save(text(first)); // back to a known state
  await load();
}
console.log(JSON.stringify({ rounds, cure, gap, maxDelay, seed: option('seed', 12345), firstLoadMs: loadMs, ...counts }));
compiler.kill();
fs.rmSync(dir, { recursive: true, force: true });
