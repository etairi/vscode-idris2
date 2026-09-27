// fake-pack: a stand-in for pack in integration tests (test/fake-tools/README.md). The extension
// never runs pack itself (package.json, idris2.toolchain.packPath); pack runs only inside pack's
// own wrapper scripts, which call `pack app-path <app>` and, for applications that need the
// package path, `pack package-path`, `libs-path` and `data-path` (appLink and pthStr,
// src/Pack/Runner/Install.idr 139–188 on idris2-pack 6baee7d) [src]. packLayout.ts writes such
// wrappers, and this fake answers exactly those four queries from `<state>/fake-pack.json`,
// which packLayout.ts writes too. Everything else is rejected with exit code 2.
//
// The state directory is found as pack finds it (getPackDirs and getStateDir,
// src/Pack/Config/Environment.idr 313–350): $HOME must be set, then $PACK_STATE_DIR, else
// $XDG_STATE_HOME/pack, else $HOME/.local/state/pack, where a variable counts only if it holds
// an absolute path (getEnvPath parses it as `Path Abs`).
//
// Environment:
//   FAKE_PACK_LOG                 if set, every invocation appends one JSON line
//                                 {"args": [...], "cwd": "..."} to this file before anything
//                                 else happens, so that a test can assert pack was not run
//   FAKE_PACK_MODE, FAKE_PACK_DELAY_MS  faults.mjs (`garbage` behaves like `normal`)
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applyFaults, notImplemented } from './faults.mjs';

const TOOL = 'fake-pack';

function envPath(name) {
  const value = process.env[name];
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

function stateDir() {
  const home = envPath('HOME');
  if (home === undefined) {
    process.stderr.write(`${TOOL}: HOME is not set to an absolute path (pack's NoPackDir)\n`);
    process.exit(1);
  }
  const packState = envPath('PACK_STATE_DIR');
  if (packState !== undefined) {
    return packState;
  }
  const xdgState = envPath('XDG_STATE_HOME');
  return xdgState !== undefined ? path.join(xdgState, 'pack') : path.join(home, '.local', 'state', 'pack');
}

function readLayout() {
  const file = path.join(stateDir(), 'fake-pack.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`${TOOL}: cannot read ${file}: ${e.message}\n`);
    process.exit(1);
  }
}

async function main(argv) {
  const log = process.env.FAKE_PACK_LOG;
  if (log !== undefined && log !== '') {
    fs.appendFileSync(log, JSON.stringify({ args: argv, cwd: process.cwd() }) + '\n');
  }
  await applyFaults(TOOL, 'FAKE_PACK');
  if (argv.length === 2 && argv[0] === 'app-path') {
    const app = readLayout().apps?.[argv[1]];
    if (typeof app !== 'string') {
      process.stderr.write(`${TOOL}: application ${JSON.stringify(argv[1])} is not installed in this layout\n`);
      process.exit(1);
    }
    process.stdout.write(app + '\n');
    return;
  }
  const query = { 'package-path': 'packagePath', 'libs-path': 'libsPath', 'data-path': 'dataPath' }[argv[0]];
  if (argv.length === 1 && query !== undefined) {
    process.stdout.write(`${readLayout()[query] ?? ''}\n`);
    return;
  }
  notImplemented(TOOL, argv);
}

await main(process.argv.slice(2));
