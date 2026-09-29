#!/usr/bin/env node
// Measures what the M2 extension's `check` session costs on a real package: the first load of a
// module (which compiles its whole import closure into the isolated build directory), later
// loads, the session's memory, and the latency of the cheap requests M3 will add. The results
// and how they were taken are in docs/measurements/first-load.md. Nothing in the extension or
// its tests uses this script.
//
// **What it runs is what the extension runs** (src/backend/ide/pool.ts `sessionLaunch`,
// transport.ts, wire.ts `encodeFrame`, protocol.ts `loadFile`): `idris2 --ide-mode --no-color
// --build-dir <root>/build/.vscode-idris2`, with the working directory <root> = the real path of
// the directory that holds the package's .ipkg; requests framed as six lower-case hex digits
// giving the UTF-8 byte length of `<request>\n`; one request in flight; a load is
// `((:load-file "<absolute path>") ID)`. The process is started as
// `timeout -k 10 <limit> /usr/bin/time -l idris2 …`: timeout(1) gives the session a hard time
// limit, and BSD time(1) prints the peak RSS when it ends ("maximum resident set size": the
// largest maximum RSS over the idris2 launcher script and the Chez Scheme process it starts, in
// practice Chez's, not their sum; time(1)'s "peak memory footprint" line is the launcher's only
// and must not be used). Only a package whose .ipkg sets neither `builddir` nor a `--build-dir` in `opts` is
// measured: for the others the extension does not isolate the build directory (pool.ts
// `checkBuildDir`).
//
// **Per module**, in a fresh copy of the package (the build directory is emptied first):
//   session 1: start (spawn → `:protocol-version`), then
//     (a) cold load: wall time, `Building` lines, TTC directory size afterwards;
//     (b) reload of the unchanged file, --repeat times;
//     (c) reload after appending a comment line to the module itself, --repeat times;
//     (d) reload after appending a comment line to a dependency in the middle of the module's
//         import closure (the middle of its dependencies-first order), --dep-repeat times;
//     (d') reload after appending an exported definition (`measureFirstLoadEditN : Integer`)
//         to that dependency, which changes its interface, --dep-repeat times;
//     (e) idle RSS: IDLE_MS after the last load, without a request;
//     (f) latency of `:type-of NAME`, `:docs-for NAME`, `:repl-completions PREFIX` and
//         `:metavariables 80`, --queries times each (NAME: the module's first top-level type
//         signature at column 0; PREFIX: its first three characters);
//     (f') the first of each of those requests after a reload of the unchanged file, in
//         --repeat cycles of one reload and one request of each kind;
//     (h) with --saves N (default 0, off): N more cycles of appending a comment line to the
//         module and loading it, the memory read every 10 cycles (does a session grow?);
//     then end of input, and the peak RSS time(1) reports.
//   session 2: a new process on the build directory session 1 left: start and one load (VS Code
//     reopened on a project whose TTCs are fresh).
//   Every appended line is removed afterwards (the files get back their exact bytes).
// Latency is measured in this process from writing the request to reading its `:return`, so it
// includes the pipe, as the extension sees it (not its decoding). RSS is sampled with ps(1) as
// the sum over the processes below time(1) (launcher script + Chez): every RSS_SAMPLE_MS during
// a load (the maximum is reported), once after each step. After each step footprint(1) also
// reads the Chez process's `phys_footprint` and `phys_footprint_peak` (dirty memory with the
// compressed and swapped pages, now and at its peak so far), because RSS drops when macOS
// compresses an idle process. No sampler runs during (f); the RSS sampler (ps every
// RSS_SAMPLE_MS) and the free-memory watch (memory_pressure every MEMORY_SAMPLE_MS) do run during
// the timed loads, on the event loop that reads the compiler's output (some jitter). In (f')
// the memory is read after each reload, before its first request, so that request follows an
// idle gap of the length of that reading.
// The compiler inherits this process's environment (not the Extension Host's with
// `idris2.toolchain.env`), and the report does not record it.
// The JSON report holds module names, line counts, the queried name and prefix, timings, sizes,
// counts and statuses, never a reply's text: the only compiler output it keeps is the first
// UNFRAMED_SAMPLE_LINES stdout lines outside a frame (cut to UNFRAMED_SAMPLE_CHARS), with the
// session's exit status.
//
// **Safety** (CLAUDE.md: parallel compiler runs have taken this 16 GB machine down):
//   - One idris2 process at a time: processes run strictly one after another, and before each
//     one the script waits until no other idris2 compiler (a process running `idris2_app/
//     idris2.so`, the Chez backend's program) runs on the machine, by any user.
//   - Before each process: `memory_pressure -Q` free ≥ MIN_FREE_START % and a 1-minute load
//     average ≤ MAX_LOAD1; otherwise it waits WAIT_MS and checks again, at most MAX_WAITS
//     times, then skips that module (reported). While a session runs, free memory is sampled
//     every MEMORY_SAMPLE_MS (between the requests of (f)); below MIN_FREE_RUNNING % the
//     session's process group is killed and the whole run stops (reported).
//   - Time limits: each load --load-timeout-min (default 30), each other request
//     QUERY_LIMIT_MS, the start START_LIMIT_MS, the whole session under timeout(1) with
//     --session-timeout-min (default 60); on any of them the process group is killed.
//   - No network. The package given with --package is only read: it is copied (without its
//     build directories) to <work>/<its directory name>, and only that copy is written to.
//   - macOS only (BSD time -l, memory_pressure); it refuses to run elsewhere.
//
// Usage:
//   node scripts/measure-first-load.mjs --package <dir> --closures
//     prints the in-package import closure of every module (size in modules and lines) and the
//     modules that would be chosen; starts no compiler.
//   node scripts/measure-first-load.mjs --package <dir> --work <dir> [--out <file.json>]
//       [--module <Name>]... [--repeat 3] [--dep-repeat 2] [--queries 10]
//       [--load-timeout-min 30] [--session-timeout-min 60] [--saves 0]
//     measures. Without --module: the module with the largest in-package import closure (in
//     modules; also the largest in lines when that is another one), the module at the median
//     closure size, and a leaf (no in-package import; the longest one). --work must not exist or
//     be empty. The raw results go to --out (default <work>/first-load.json) as JSON.
//   IDRIS2=<absolute path> selects the compiler (default: the first idris2 on PATH);
//   TIMEOUT=<absolute path> a GNU coreutils timeout (default: /opt/homebrew/bin/timeout, then
//   /usr/local/bin/timeout, then gtimeout or timeout on PATH).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MIN_FREE_START = 25;
const MIN_FREE_RUNNING = 15;
const MAX_LOAD1 = 15;
const WAIT_MS = 60_000;
const MAX_WAITS = 10;
const RSS_SAMPLE_MS = 500;
const MEMORY_SAMPLE_MS = 5_000;
const IDLE_MS = 10_000;
const START_LIMIT_MS = 120_000;
const QUERY_LIMIT_MS = 60_000;
const EXIT_LIMIT_MS = 30_000;
const SHORT_RUN_LIMIT_S = 60;
/** Stdout lines outside a frame: how many of them, and how much of each, the report keeps. */
const UNFRAMED_SAMPLE_LINES = 5;
const UNFRAMED_SAMPLE_CHARS = 200;
/** The Chez backend's compiler process (`chez --program …/idris2_app/idris2.so …`). */
const COMPILER_PROCESS = /\/idris2_app\/idris2\.so(\s|$)/;
const FORMAT = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => process.stderr.write(`[measure] ${text}\n`);

/** Sessions whose process may still run, and files to give back their bytes (see `onSignal`). */
const liveSessions = new Set();
const originals = new Map();

function restoreFiles() {
  for (const [file, bytes] of originals) {
    fs.writeFileSync(file, bytes);
  }
  originals.clear();
}

/** On SIGINT/SIGTERM/SIGHUP: kill every session's process group, restore the files, exit. */
function onSignal(signal) {
  log(`${signal}: killing ${liveSessions.size} session(s) and restoring the edited files`);
  for (const session of liveSessions) {
    session.kill();
  }
  restoreFiles();
  process.exit(128 + os.constants.signals[signal]);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => onSignal(signal));
}
// Also on any other way out (an uncaught exception, process.exit): both steps are synchronous.
process.on('exit', () => {
  for (const session of liveSessions) {
    session.kill();
  }
  restoreFiles();
});

// ---------------------------------------------------------------------------------------------
// The package: its .ipkg, modules, imports and import closures
// ---------------------------------------------------------------------------------------------

/** Number of line feeds (wc -l). */
const lineCount = (text) => text.split('\n').length - 1;

/**
 * `text` with its comments and string literals blanked (line breaks kept): nested `{- … -}`,
 * `--` to the end of the line, `"…"` with backslash escapes. Enough to find `import` lines and
 * top-level signatures at column 0. Simplified: any `--` starts a line comment, also inside an
 * operator such as `-->` or `|--` (the compiler's lexer does not read those as comments), and
 * character literals are not modelled (`'"'` opens a string). Check the closures against the
 * `Building` lines of the cold loads before trusting them on a new package (done for `contrib`).
 */
function stripComments(text) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (depth > 0) {
      if (c === '{' && next === '-') {
        depth++;
        i++;
      } else if (c === '-' && next === '}') {
        depth--;
        i++;
      } else if (c === '\n') {
        out += '\n';
      }
      continue;
    }
    if (c === '{' && next === '-') {
      depth = 1;
      i++;
    } else if (c === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (c === '"') {
      out += '""';
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          i++;
        } else if (text[i] === '\n') {
          out += '\n';
        }
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** The fields of the .ipkg this script needs (as Idris/Package.idr reads them, simplified). */
function readIpkg(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = stripComments(raw);
  const quoted = (name) => new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm').exec(raw)?.[1];
  const dependsMatch = /^depends\s*=\s*([^\n]*(?:\n[ \t]+[^\n]*)*)/m.exec(text);
  return {
    name: /^package\s+(\S+)/m.exec(text)?.[1],
    sourcedir: quoted('sourcedir') ?? '.',
    builddir: quoted('builddir'),
    opts: quoted('opts') ?? quoted('options') ?? '',
    depends: dependsMatch === null
      ? []
      : dependsMatch[1].split(',').map((d) => d.trim().split(/\s+/)[0]).filter((d) => d !== ''),
  };
}

function findIpkg(dir) {
  const found = fs.readdirSync(dir).filter((f) => f.endsWith('.ipkg'));
  if (found.length !== 1) {
    throw new Error(`expected exactly one .ipkg in ${dir}, found ${found.length}`);
  }
  return path.join(dir, found[0]);
}

/** Every `.idr` below `sourceRoot` (build directories skipped) → module name, file, lines, imports. */
function moduleGraph(sourceRoot) {
  const modules = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'build') {
          walk(full);
        }
      } else if (entry.name.endsWith('.idr')) {
        const relative = path.relative(sourceRoot, full);
        const name = relative.slice(0, -'.idr'.length).split(path.sep).join('.');
        const text = fs.readFileSync(full, 'utf8');
        const stripped = stripComments(text);
        const imports = [...stripped.matchAll(/^import\s+(?:public\s+)?([A-Z][A-Za-z0-9_']*(?:\.[A-Z][A-Za-z0-9_']*)*)/gm)]
          .map((m) => m[1]);
        const signature = /^(?:(?:public\s+export|export|private)\s+)?(?:(?:total|partial|covering)\s+)?([a-z][A-Za-z0-9_']*)\s*:\s/m
          .exec(stripped)?.[1];
        modules.set(name, { name, file: full, relative, lines: lineCount(text), imports, signature });
      }
    }
  };
  walk(sourceRoot);
  for (const m of modules.values()) {
    m.local = [...new Set(m.imports.filter((i) => modules.has(i)))].sort();
  }
  return modules;
}

/** The module's in-package import closure, dependencies first, the module itself last. */
function closureOf(modules, name) {
  const seen = new Set();
  const order = [];
  const visit = (m) => {
    if (seen.has(m)) {
      return;
    }
    seen.add(m);
    for (const d of modules.get(m).local) {
      visit(d);
    }
    order.push(m);
  };
  visit(name);
  return order;
}

function closureTable(modules) {
  return [...modules.keys()].sort().map((name) => {
    const order = closureOf(modules, name);
    return {
      module: name,
      lines: modules.get(name).lines,
      closureModules: order.length,
      closureLines: order.reduce((n, m) => n + modules.get(m).lines, 0),
    };
  });
}

/**
 * The largest closure in modules (then lines), the largest in lines when that is another module,
 * the median by closure size in modules, and the longest leaf.
 */
function chooseModules(table) {
  const bySize = [...table].sort((a, b) =>
    a.closureModules - b.closureModules || a.closureLines - b.closureLines || a.module.localeCompare(b.module));
  const largest = bySize[bySize.length - 1];
  const byLines = [...table].sort((a, b) => b.closureLines - a.closureLines || a.module.localeCompare(b.module))[0];
  const median = bySize[Math.floor((bySize.length - 1) / 2)];
  const leaves = table.filter((r) => r.closureModules === 1)
    .sort((a, b) => b.lines - a.lines || a.module.localeCompare(b.module));
  return [
    { role: 'largest closure', ...largest },
    ...(byLines.module === largest.module ? [] : [{ role: 'largest closure in lines', ...byLines }]),
    { role: 'median closure', ...median },
    ...(leaves.length > 0 ? [{ role: 'leaf', ...leaves[0] }] : []),
  ];
}

/** The dependency in the middle of `name`'s closure, and the modules an edit of it invalidates. */
function middleDependency(modules, name) {
  const order = closureOf(modules, name).slice(0, -1);
  if (order.length === 0) {
    return undefined;
  }
  const dependency = order[Math.floor((order.length - 1) / 2)];
  const dependents = closureOf(modules, name).filter((m) => closureOf(modules, m).includes(dependency));
  return { module: dependency, file: modules.get(dependency).file, lines: modules.get(dependency).lines, invalidates: dependents.length };
}

// ---------------------------------------------------------------------------------------------
// The machine: tools, resources, other compilers
// ---------------------------------------------------------------------------------------------

function executableOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

function findCompiler() {
  const configured = process.env.IDRIS2;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`IDRIS2 must be an absolute path, got ${configured}`);
    }
    return configured;
  }
  const found = executableOnPath('idris2');
  if (found === undefined) {
    throw new Error('no idris2 on PATH; set IDRIS2=<absolute path>');
  }
  return found;
}

async function findTimeout() {
  const candidates = process.env.TIMEOUT
    ? [process.env.TIMEOUT]
    : ['/opt/homebrew/bin/timeout', '/usr/local/bin/timeout', executableOnPath('gtimeout'), executableOnPath('timeout')];
  for (const candidate of candidates) {
    if (candidate === undefined || !path.isAbsolute(candidate)) {
      continue;
    }
    try {
      const { stdout } = await execFileAsync(candidate, ['--version']);
      if (stdout.includes('GNU coreutils')) {
        return candidate;
      }
    } catch {
      // not a GNU timeout
    }
  }
  throw new Error('no GNU coreutils timeout found (brew install coreutils); set TIMEOUT=<absolute path>');
}

async function freeMemoryPercent() {
  const { stdout } = await execFileAsync('/usr/bin/memory_pressure', ['-Q']);
  const match = /free percentage:\s*(\d+)%/.exec(stdout);
  if (match === null) {
    throw new Error(`cannot read memory_pressure -Q: ${stdout}`);
  }
  return Number(match[1]);
}

async function processes() {
  const { stdout } = await execFileAsync('/bin/ps', ['-Ao', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 << 20 });
  return stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKiB: Number(m[3]), command: m[4] }));
}

/** footprint(1)'s `phys_footprint` and `phys_footprint_peak` of one process, in bytes. */
async function footprintOf(pid) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/footprint', ['-f', 'bytes', '--noCategories', '-p', String(pid)]);
    const now = /phys_footprint:\s*(\d+) B/.exec(stdout);
    const peak = /phys_footprint_peak:\s*(\d+) B/.exec(stdout);
    return {
      ...(now === null ? {} : { footprintBytes: Number(now[1]) }),
      ...(peak === null ? {} : { footprintPeakBytes: Number(peak[1]) }),
    };
  } catch {
    return {};
  }
}

async function otherCompilers() {
  return (await processes()).filter((p) => COMPILER_PROCESS.test(p.command)).map((p) => p.pid);
}

const loadAverage = () => Number(os.loadavg()[0].toFixed(2));

/**
 * Waits until free memory ≥ MIN_FREE_START %, the 1-minute load ≤ MAX_LOAD1 and no idris2
 * compiler runs; checks every WAIT_MS, at most MAX_WAITS + 1 times.
 */
async function awaitResources(what) {
  for (let attempt = 0; ; attempt++) {
    const free = await freeMemoryPercent();
    const load1 = loadAverage();
    const others = await otherCompilers();
    if (free >= MIN_FREE_START && load1 <= MAX_LOAD1 && others.length === 0) {
      return { ok: true, free, load1, waits: attempt };
    }
    if (attempt === MAX_WAITS) {
      return { ok: false, free, load1, others, waits: attempt };
    }
    log(`${what}: waiting ${WAIT_MS / 1000} s (free memory ${free}%, load ${load1}, other idris2 compilers: ${others.join(' ') || 'none'})`);
    await sleep(WAIT_MS);
  }
}

/** A short compiler run (`--version`, `--list-packages`) under the same rules as a session. */
async function shortRun(timeoutBin, idris2, args, cwd) {
  const ready = await awaitResources(`idris2 ${args.join(' ')}`);
  if (!ready.ok) {
    throw new Error(`resources not available for idris2 ${args.join(' ')}`);
  }
  const { stdout } = await execFileAsync(timeoutBin, ['-k', '5', String(SHORT_RUN_LIMIT_S), idris2, ...args], { cwd });
  return stdout;
}

async function machine() {
  const sysctl = async (key) => (await execFileAsync('/usr/sbin/sysctl', ['-n', key])).stdout.trim();
  const swVers = async (flag) => (await execFileAsync('/usr/bin/sw_vers', [flag])).stdout.trim();
  return {
    cpu: await sysctl('machdep.cpu.brand_string'),
    performanceCores: Number(await sysctl('hw.perflevel0.physicalcpu')),
    efficiencyCores: Number(await sysctl('hw.perflevel1.physicalcpu')),
    memoryBytes: os.totalmem(),
    macOS: `${await swVers('-productVersion')} (${await swVers('-buildVersion')})`,
    arch: process.arch,
    node: process.version,
  };
}

// ---------------------------------------------------------------------------------------------
// One IDE-mode session
// ---------------------------------------------------------------------------------------------

/** The length of the UTF-8 sequence that starts with `lead`. */
function utf8SequenceLength(lead) {
  if (lead < 0x80) {
    return 1;
  }
  if (lead >= 0xf0) {
    return 4;
  }
  if (lead >= 0xe0) {
    return 3;
  }
  return lead >= 0xc0 ? 2 : 1;
}

/** A request as the extension frames it (wire.ts `encodeFrame`); `text` is printable ASCII. */
function frame(text) {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error(`request outside printable ASCII: ${text}`);
  }
  const payload = Buffer.from(`${text}\n`, 'utf8');
  return Buffer.concat([Buffer.from(payload.length.toString(16).padStart(6, '0'), 'latin1'), payload]);
}

/** A string literal as sexp.ts writes it for printable ASCII. */
const sexpString = (value) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

class Session {
  constructor({ timeoutBin, idris2, root, buildDir, limitMinutes }) {
    this.args = ['-k', '10', String(limitMinutes * 60), '/usr/bin/time', '-l', idris2,
      '--ide-mode', '--no-color', '--build-dir', buildDir];
    this.timeoutBin = timeoutBin;
    this.root = root;
    this.buffer = Buffer.alloc(0);
    this.stderr = '';
    this.nextId = 1;
    this.pending = undefined;
    this.handshake = undefined;
    this.unframedLines = 0;
    this.unframedSample = [];
    this.memoryMin = 100;
    this.aborted = undefined;
    this.rssMax = 0;
    this.memoryTimer = undefined;
    this.rssTimer = undefined;
  }

  /** Spawns the process and waits for `:protocol-version`; resolves to the milliseconds taken. */
  start() {
    const started = process.hrtime.bigint();
    this.child = spawn(this.timeoutBin, this.args, { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    liveSessions.add(this);
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        liveSessions.delete(this);
        this.fail(new Error(`the session ended (code ${code}, signal ${signal})`));
        resolve({ code, signal });
      });
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdout.on('data', (chunk) => this.read(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.stdin.on('error', () => {
      // the process ended; the close handler reports it
    });
    this.watchMemory(true);
    void this.checkMemory();
    return this.wait('handshake', START_LIMIT_MS, started);
  }

  wait(kind, limitMs, started) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new Error(`${kind}: no answer within ${limitMs} ms`));
      }, limitMs);
      const done = { started, resolve, reject, timer, frames: 0, bytes: 0, building: [], warnings: 0, highlightFrames: 0, highlightBytes: 0 };
      if (kind === 'handshake') {
        this.handshake = done;
      } else {
        this.pending = done;
      }
    });
  }

  fail(error) {
    for (const waiter of [this.handshake, this.pending]) {
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.handshake = undefined;
    this.pending = undefined;
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (/^[0-9a-f]{6}\(/.test(this.buffer.subarray(0, 7).toString('latin1'))) {
        const codePoints = parseInt(this.buffer.subarray(0, 6).toString('latin1'), 16);
        let end = 6;
        for (let k = 0; k < codePoints && end <= this.buffer.length; k++) {
          end += end < this.buffer.length ? utf8SequenceLength(this.buffer[end]) : 1;
        }
        if (end > this.buffer.length) {
          return;
        }
        const text = this.buffer.subarray(6, end).toString('utf8');
        this.buffer = this.buffer.subarray(end);
        this.onFrame(text, end);
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0 || this.buffer.length < 7) {
        return;
      }
      this.unframedLines++;
      if (this.unframedSample.length < UNFRAMED_SAMPLE_LINES) {
        this.unframedSample.push(this.buffer.subarray(0, Math.min(newline, UNFRAMED_SAMPLE_CHARS)).toString('utf8'));
      }
      this.buffer = this.buffer.subarray(newline + 1);
    }
  }

  onFrame(text, bytes) {
    const kind = /^\(:([a-z-]+)/.exec(text)?.[1];
    const elapsedMs = (waiter) => Number(process.hrtime.bigint() - waiter.started) / 1e6;
    if (kind === 'protocol-version' && this.handshake !== undefined) {
      const waiter = this.handshake;
      this.handshake = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve({ ms: elapsedMs(waiter), version: /^\(:protocol-version (\d+) (\d+)\)/.exec(text)?.slice(1).join('.') });
      return;
    }
    const waiter = this.pending;
    if (waiter === undefined) {
      return;
    }
    waiter.frames++;
    waiter.bytes += bytes;
    if (kind === 'write-string') {
      const building = /^\(:write-string "\s*(\d+)\/(\d+): Building (\S+) /.exec(text);
      if (building !== null) {
        waiter.building.push(building[3]);
      }
    } else if (kind === 'warning') {
      waiter.warnings++;
    } else if (kind === 'output' && text.startsWith('(:output (:ok (:highlight-source')) {
      waiter.highlightFrames++;
      waiter.highlightBytes += bytes;
    } else if (kind === 'return' && Number(/ (\d+)\)\s*$/.exec(text)?.[1]) === waiter.id) {
      this.pending = undefined;
      clearTimeout(waiter.timer);
      const status = /^\(:return \(:(ok|error)/.exec(text)?.[1] ?? 'unknown';
      waiter.resolve({
        ms: elapsedMs(waiter),
        status,
        ...(status === 'ok' ? {} : { message: text.slice(0, 300) }),
        replyBytes: bytes,
        answer: text,
        frames: waiter.frames,
        bytes: waiter.bytes,
        building: waiter.building,
        warnings: waiter.warnings,
        highlightFrames: waiter.highlightFrames,
        highlightBytes: waiter.highlightBytes,
      });
    }
  }

  /** Sends one request (`command` without its id) and resolves when its `:return` arrives. */
  request(command, limitMs) {
    if (this.aborted !== undefined) {
      return Promise.reject(new Error(this.aborted));
    }
    const id = this.nextId++;
    const started = process.hrtime.bigint();
    const answer = this.wait(command, limitMs, started);
    this.pending.id = id;
    this.child.stdin.write(frame(`(${command} ${id})`));
    return answer;
  }

  /** The processes below time(1): the idris2 launcher script and the Chez process. */
  async compilerProcesses() {
    const all = await processes();
    const children = new Map();
    for (const p of all) {
      children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
    }
    const time = (children.get(this.child.pid) ?? [])[0];
    const out = [];
    const stack = time === undefined ? [] : [time.pid];
    while (stack.length > 0) {
      for (const c of children.get(stack.pop()) ?? []) {
        out.push(c);
        stack.push(c.pid);
      }
    }
    return out;
  }

  async rssKiB() {
    return (await this.compilerProcesses()).reduce((n, p) => n + p.rssKiB, 0);
  }

  /**
   * The memory of the compiler process tree now: `rssAfterKiB` (ps, the sum over the launcher
   * script and Chez), and the Chez process's `footprintBytes` and `footprintPeakBytes`
   * (footprint(1)'s `phys_footprint` and `phys_footprint_peak`: its dirty memory, compressed and
   * swapped pages included, now and at its peak; what Activity Monitor shows as Memory). RSS
   * leaves out the pages macOS has compressed, so it drops when an idle process is compressed;
   * the footprint does not.
   */
  async memory() {
    const tree = await this.compilerProcesses();
    const chez = tree.find((p) => COMPILER_PROCESS.test(p.command));
    return {
      rssAfterKiB: tree.reduce((n, p) => n + p.rssKiB, 0),
      ...(chez === undefined ? {} : await footprintOf(chez.pid)),
    };
  }

  /** Samples RSS every RSS_SAMPLE_MS into `rssMax` while on. */
  sampleRss(on) {
    clearInterval(this.rssTimer);
    this.rssTimer = undefined;
    if (on) {
      this.rssMax = 0;
      let busy = false;
      this.rssTimer = setInterval(async () => {
        if (busy) {
          return;
        }
        busy = true;
        try {
          this.rssMax = Math.max(this.rssMax, await this.rssKiB());
        } catch {
          // ps failed once; the next sample counts
        } finally {
          busy = false;
        }
      }, RSS_SAMPLE_MS);
    }
  }

  /** Samples free memory every MEMORY_SAMPLE_MS while on; kills the session below MIN_FREE_RUNNING. */
  watchMemory(on) {
    clearInterval(this.memoryTimer);
    this.memoryTimer = undefined;
    if (on) {
      this.memoryTimer = setInterval(() => void this.checkMemory(), MEMORY_SAMPLE_MS);
    }
  }

  async checkMemory() {
    try {
      const free = await freeMemoryPercent();
      this.memoryMin = Math.min(this.memoryMin, free);
      if (free < MIN_FREE_RUNNING && this.aborted === undefined) {
        this.aborted = `free memory ${free}% < ${MIN_FREE_RUNNING}% during the session`;
        log(this.aborted);
        this.kill();
      }
    } catch {
      // memory_pressure failed once; the next sample counts
    }
  }

  kill() {
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      // the group has ended
    }
  }

  /** Ends the input, waits for the exit, and reads time(1)'s report. */
  async end() {
    this.watchMemory(false);
    this.sampleRss(false);
    this.child.stdin.end();
    let timer;
    const exit = await Promise.race([
      this.exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), EXIT_LIMIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (exit === undefined) {
      this.kill();
      await this.exited;
    }
    const peak = /(\d+)\s+maximum resident set size/.exec(this.stderr);
    const times = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(this.stderr);
    return {
      exit: exit ?? 'killed after end of input',
      peakRssBytes: peak === null ? undefined : Number(peak[1]),
      realSeconds: times === null ? undefined : Number(times[1]),
      userSeconds: times === null ? undefined : Number(times[2]),
      sysSeconds: times === null ? undefined : Number(times[3]),
      unframedLines: this.unframedLines,
      unframedSample: this.unframedSample,
      memoryFreeMinPercent: this.memoryMin,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Measuring one module
// ---------------------------------------------------------------------------------------------

/** Files and bytes below `dir` by extension. */
function directorySize(dir) {
  const result = { files: 0, bytes: 0, ttc: 0, ttm: 0 };
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        result.files++;
        result.bytes += fs.statSync(full).size;
        if (entry.name.endsWith('.ttc')) {
          result.ttc++;
        } else if (entry.name.endsWith('.ttm')) {
          result.ttm++;
        }
      }
    }
  };
  if (fs.existsSync(dir)) {
    walk(dir);
  }
  return result;
}

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const round = (x) => Number(x.toFixed(2));
  return {
    n,
    min: round(sorted[0]),
    median: round(n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2),
    p90: round(sorted[Math.ceil(0.9 * n) - 1]),
    max: round(sorted[n - 1]),
    first: round(values[0]),
  };
}

/** The number of names in a `(:return (:ok (("NAME" …) "REST")) ID)` of `:repl-completions`. */
function completionCount(answer) {
  const list = /^\(:return \(:ok \(\(((?:"(?:[^"\\]|\\.)*"\s*)*)\)/.exec(answer)?.[1];
  return list === undefined ? undefined : [...list.matchAll(/"(?:[^"\\]|\\.)*"/g)].length;
}

const mib = (bytes) => (bytes / 1048576).toFixed(0);

function memoryText(m) {
  return `RSS ${mib(m.rssAfterKiB * 1024)} MiB, footprint ${m.footprintBytes === undefined ? '?' : mib(m.footprintBytes)} MiB (peak ${m.footprintPeakBytes === undefined ? '?' : mib(m.footprintPeakBytes)} MiB)`;
}

/** A load step: the load, its sampled RSS maximum, the RSS after it, the load average. */
async function loadStep(session, step, file, limitMs) {
  session.sampleRss(true);
  const reply = await session.request(`(:load-file ${sexpString(file)})`, limitMs);
  session.sampleRss(false);
  const memory = await session.memory();
  const record = {
    step,
    ms: reply.ms,
    status: reply.status,
    ...(reply.message === undefined ? {} : { message: reply.message }),
    building: reply.building.length,
    builtModules: reply.building,
    warnings: reply.warnings,
    highlightFrames: reply.highlightFrames,
    highlightBytes: reply.highlightBytes,
    frames: reply.frames,
    bytes: reply.bytes,
    rssMaxSampledKiB: Math.max(session.rssMax, memory.rssAfterKiB),
    ...memory,
    load1: loadAverage(),
  };
  log(`  ${step}: ${record.ms.toFixed(0)} ms, ${record.status}, ${record.building} built, ${memoryText(memory)}`);
  return record;
}

async function measureModule(context, choice) {
  const { modules, root, buildDir, options, timeoutBin, idris2 } = context;
  const module = modules.get(choice.module);
  const dependency = middleDependency(modules, choice.module);
  const name = module.signature;
  const prefix = name?.slice(0, 3);
  const result = { ...choice, file: module.relative, dependency, queryName: name, completionPrefix: prefix };
  originals.set(module.file, fs.readFileSync(module.file));
  if (dependency !== undefined) {
    originals.set(dependency.file, fs.readFileSync(dependency.file));
  }
  const limitMs = options.loadTimeoutMin * 60_000;
  let edit = 0;
  const append = (file) => fs.appendFileSync(file, `\n-- measure-first-load: edit ${++edit}\n`);
  const appendDefinition = (file) => {
    const n = ++edit;
    fs.appendFileSync(file, `\n\nexport\nmeasureFirstLoadEdit${n} : Integer\nmeasureFirstLoadEdit${n} = ${n}\n`);
  };

  try {
    fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
    const ready = await awaitResources(`session 1 of ${choice.module}`);
    result.resourcesAtStart = ready;
    if (!ready.ok) {
      result.skipped = 'resources not available';
      return result;
    }
    log(`${choice.module} (${choice.role}): closure ${choice.closureModules} modules, ${choice.closureLines} lines`);
    const session = new Session({ timeoutBin, idris2, root, buildDir, limitMinutes: options.sessionTimeoutMin });
    const steps = [];
    result.session1 = { command: [timeoutBin, ...session.args], cwd: root, steps };
    try {
      const start = await session.start();
      steps.push({ step: 'start', ms: start.ms, protocol: start.version, ...(await session.memory()), load1: loadAverage() });
      log(`  start: ${start.ms.toFixed(0)} ms`);
      steps.push(await loadStep(session, 'a cold', module.file, limitMs));
      result.buildDirAfterCold = directorySize(buildDir);
      for (let i = 1; i <= options.repeat; i++) {
        steps.push(await loadStep(session, `b unchanged ${i}`, module.file, limitMs));
      }
      for (let i = 1; i <= options.repeat; i++) {
        append(module.file);
        steps.push(await loadStep(session, `c module edited ${i}`, module.file, limitMs));
      }
      if (dependency !== undefined) {
        for (let i = 1; i <= options.depRepeat; i++) {
          append(dependency.file);
          steps.push(await loadStep(session, `d dependency edited ${i}`, module.file, limitMs));
        }
        for (let i = 1; i <= options.depRepeat; i++) {
          appendDefinition(dependency.file);
          steps.push(await loadStep(session, `d' dependency interface edited ${i}`, module.file, limitMs));
        }
      }
      await sleep(IDLE_MS);
      steps.push({ step: 'e idle', afterMs: IDLE_MS, ...(await session.memory()), load1: loadAverage() });
      log(`  idle: ${memoryText(steps[steps.length - 1])}`);
      if (name !== undefined) {
        session.watchMemory(false);
        const queries = {
          'type-of': `(:type-of ${sexpString(name)})`,
          'docs-for': `(:docs-for ${sexpString(name)})`,
          'repl-completions': `(:repl-completions ${sexpString(prefix)})`,
          'metavariables': '(:metavariables 80)',
        };
        result.queries = {};
        for (const [kind, command] of Object.entries(queries)) {
          await session.checkMemory();
          const replies = [];
          for (let i = 0; i < options.queries; i++) {
            replies.push(await session.request(command, QUERY_LIMIT_MS));
          }
          result.queries[kind] = {
            request: command,
            ...statistics(replies.map((r) => r.ms)),
            statuses: [...new Set(replies.map((r) => r.status))],
            replyBytes: replies[0].replyBytes,
            ...(kind === 'repl-completions' ? { candidates: completionCount(replies[0].answer) } : {}),
          };
          log(`  ${kind}: median ${result.queries[kind].median} ms, p90 ${result.queries[kind].p90} ms (${result.queries[kind].statuses})`);
        }
        session.watchMemory(true);
        steps.push({ step: 'f after queries', ...(await session.memory()), load1: loadAverage() });
        const afterReload = Object.fromEntries(Object.keys(queries).map((kind) => [kind, []]));
        const afterReloadStatuses = Object.fromEntries(Object.keys(queries).map((kind) => [kind, new Set()]));
        for (let i = 1; i <= options.repeat; i++) {
          steps.push(await loadStep(session, `f' reload ${i}`, module.file, limitMs));
          session.watchMemory(false);
          for (const [kind, command] of Object.entries(queries)) {
            const reply = await session.request(command, QUERY_LIMIT_MS);
            afterReload[kind].push(reply.ms);
            afterReloadStatuses[kind].add(reply.status);
          }
          session.watchMemory(true);
          await session.checkMemory();
        }
        result.queriesAfterReload = Object.fromEntries(Object.entries(afterReload).map(([kind, ms]) =>
          [kind, { ms: ms.map((x) => Number(x.toFixed(2))), ...statistics(ms), statuses: [...afterReloadStatuses[kind]] }]));
        log(`  first requests after a reload: ${Object.entries(result.queriesAfterReload).map(([kind, r]) => `${kind} ${r.median} ms`).join(', ')}`);
      }
      if (options.saves > 0) {
        const ms = [];
        const memory = [];
        for (let i = 1; i <= options.saves; i++) {
          append(module.file);
          const reply = await session.request(`(:load-file ${sexpString(module.file)})`, limitMs);
          if (reply.status !== 'ok') {
            throw new Error(`save ${i}: the load answered ${reply.status}`);
          }
          ms.push(reply.ms);
          if (i % 10 === 0 || i === options.saves) {
            memory.push({ save: i, ...(await session.memory()), load1: loadAverage() });
          }
        }
        result.saves = { n: options.saves, ...statistics(ms), memory };
        const last = memory[memory.length - 1];
        log(`  ${options.saves} saves: median ${result.saves.median} ms, p90 ${result.saves.p90} ms; then ${memoryText(last)}`);
      }
      result.buildDirAtEnd = directorySize(buildDir);
    } catch (error) {
      result.error = session.aborted ?? error.message;
      log(`  stopped: ${result.error}`);
    } finally {
      Object.assign(result.session1, await session.end());
    }
    if (session.aborted !== undefined) {
      result.aborted = session.aborted;
      return result;
    }
    if (result.error !== undefined) {
      return result;
    }

    const ready2 = await awaitResources(`session 2 of ${choice.module}`);
    if (!ready2.ok) {
      result.session2 = { skipped: 'resources not available', resourcesAtStart: ready2 };
      return result;
    }
    const reopened = new Session({ timeoutBin, idris2, root, buildDir, limitMinutes: options.sessionTimeoutMin });
    const steps2 = [];
    result.session2 = { resourcesAtStart: ready2, steps: steps2 };
    try {
      const start = await reopened.start();
      steps2.push({ step: 'start', ms: start.ms, ...(await reopened.memory()), load1: loadAverage() });
      steps2.push(await loadStep(reopened, 'g load on the warm build directory', module.file, limitMs));
    } catch (error) {
      result.session2.error = reopened.aborted ?? error.message;
      log(`  stopped: ${result.session2.error}`);
    } finally {
      Object.assign(result.session2, await reopened.end());
    }
    if (reopened.aborted !== undefined) {
      result.aborted = reopened.aborted;
    }
    return result;
  } finally {
    restoreFiles();
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      package: { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
      module: { type: 'string', multiple: true },
      closures: { type: 'boolean', default: false },
      repeat: { type: 'string', default: '3' },
      'dep-repeat': { type: 'string', default: '2' },
      queries: { type: 'string', default: '10' },
      'load-timeout-min': { type: 'string', default: '30' },
      'session-timeout-min': { type: 'string', default: '60' },
      saves: { type: 'string', default: '0' },
    },
  });
  const count = (key, min, max) => {
    const n = Number(values[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`--${key} must be an integer in ${min}..${max}`);
    }
    return n;
  };
  if (values.package === undefined) {
    throw new Error('--package <dir> is required');
  }
  if (!values.closures && values.work === undefined) {
    throw new Error('--work <dir> is required to measure');
  }
  return {
    package: values.package,
    work: values.work,
    out: values.out,
    modules: values.module,
    closures: values.closures,
    repeat: count('repeat', 1, 20),
    depRepeat: count('dep-repeat', 0, 20),
    queries: count('queries', 1, 1000),
    loadTimeoutMin: count('load-timeout-min', 1, 30),
    sessionTimeoutMin: count('session-timeout-min', 1, 120),
    saves: count('saves', 0, 1000),
  };
}

function printClosures(table, chosen) {
  const sorted = [...table].sort((a, b) => b.closureModules - a.closureModules || b.closureLines - a.closureLines || a.module.localeCompare(b.module));
  console.log('| module | lines | closure (modules) | closure (lines) |');
  console.log('|---|---:|---:|---:|');
  for (const r of sorted) {
    console.log(`| ${r.module} | ${r.lines} | ${r.closureModules} | ${r.closureLines} |`);
  }
  console.log('');
  for (const c of chosen) {
    console.log(`${c.role}: ${c.module} (${c.closureModules} modules, ${c.closureLines} lines)`);
  }
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS only (BSD time -l, memory_pressure)');
  }
  const options = parseOptions(process.argv.slice(2));
  const source = fs.realpathSync(options.package);
  const sourceIpkg = readIpkg(findIpkg(source));
  const sourceModules = moduleGraph(path.resolve(source, sourceIpkg.sourcedir));
  const table = closureTable(sourceModules);
  const automatic = chooseModules(table);
  const chosen = options.modules === undefined
    ? automatic
    : options.modules.map((m) => {
      const row = table.find((r) => r.module === m);
      if (row === undefined) {
        throw new Error(`no module ${m} in ${source}`);
      }
      return { role: automatic.find((c) => c.module === m)?.role ?? 'chosen', ...row };
    });
  if (options.closures) {
    printClosures(table, chosen);
    return;
  }
  if (sourceIpkg.builddir !== undefined || /(^|\s)--build-dir(\s|$)/.test(sourceIpkg.opts)) {
    throw new Error('the .ipkg sets its build directory, so the extension would not isolate it (pool.ts checkBuildDir)');
  }

  const idris2 = findCompiler();
  const timeoutBin = await findTimeout();
  fs.mkdirSync(options.work, { recursive: true });
  const work = fs.realpathSync(options.work);
  if (fs.readdirSync(work).length > 0) {
    throw new Error(`--work ${work} is not empty`);
  }
  const root = path.join(work, path.basename(source));
  fs.cpSync(source, root, { recursive: true, filter: (src) => path.basename(src) !== 'build' });
  if (!/^[\x21-\x7e]+$/.test(root)) {
    throw new Error(`the work path ${root} must be printable ASCII without spaces`);
  }
  const ipkg = readIpkg(findIpkg(root));
  const modules = moduleGraph(path.resolve(root, ipkg.sourcedir));
  const buildDir = path.join(root, 'build', '.vscode-idris2');
  const out = path.resolve(options.out ?? path.join(work, 'first-load.json'));

  const version = (await shortRun(timeoutBin, idris2, ['--version'], work)).trim();
  const listed = await shortRun(timeoutBin, idris2, ['--list-packages'], work);
  const installed = [...listed.matchAll(/^(\S+) \(([^)]*)\)$/gm)].map((m) => `${m[1]} ${m[2]}`);
  const missing = [...new Set(['prelude', 'base', ...ipkg.depends])]
    .filter((d) => !installed.some((i) => i.split(' ')[0] === d));
  if (missing.length > 0) {
    throw new Error(`packages the .ipkg needs are not installed: ${missing.join(', ')}`);
  }

  const report = {
    format: FORMAT,
    tool: 'scripts/measure-first-load.mjs',
    date: localDate(),
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    machine: await machine(),
    idris2: { path: idris2, version, installedPackages: installed },
    timeout: timeoutBin,
    package: { source, root, name: ipkg.name, depends: ipkg.depends, opts: ipkg.opts, modules: modules.size, lines: [...modules.values()].reduce((n, m) => n + m.lines, 0) },
    limits: { MIN_FREE_START, MIN_FREE_RUNNING, MAX_LOAD1, WAIT_MS, MAX_WAITS, RSS_SAMPLE_MS, MEMORY_SAMPLE_MS, IDLE_MS, START_LIMIT_MS, QUERY_LIMIT_MS, options },
    closures: table,
    runs: [],
  };
  const save = () => fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  save();
  for (const choice of chosen) {
    const run = await measureModule({ modules, root, buildDir, options, timeoutBin, idris2 }, choice);
    report.runs.push(run);
    save();
    if (run.aborted !== undefined) {
      log(`stopping: ${run.aborted}`);
      break;
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  log(`wrote ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
