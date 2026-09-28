// core/process.ts startLongRunningProcess (M2): the runner's rules for the long-running compiler
// processes of IDE-mode sessions, against real child processes (node itself, and /bin/sh on
// POSIX). As in process.test.ts, no assertion depends on how fast a process starts: the time
// limits below are deadlines for things that must happen, never races.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IdrisException } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import {
  startLongRunningProcess,
  type LongRunningExit,
  type LongRunningOptions,
  type LongRunningProcess,
  type LongRunningRequest,
} from '../../src/core/process';
import { recordingLog } from './support/fakeTransport';

const NODE = process.execPath;
const POSIX = process.platform !== 'win32';

function options(overrides: Partial<LongRunningOptions> = {}): LongRunningOptions {
  return {
    trust: { isTrusted: true, onDidGrant: new Emitter<void>().event },
    log: recordingLog(),
    platform: process.platform,
    baseEnv: process.env,
    ...overrides,
  };
}

interface Observed {
  readonly process: LongRunningProcess;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly events: string[];
  readonly exit: Promise<LongRunningExit>;
  /** Resolves when stdout contains `text`. */
  stdoutIncludes(text: string): Promise<void>;
  text(): string;
}

function start(request: Partial<LongRunningRequest> & { args: string[] }, opts: LongRunningOptions = options()): Observed {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const events: string[] = [];
  const watchers: Array<() => void> = [];
  let resolveExit: (exit: LongRunningExit) => void = () => undefined;
  const exit = new Promise<LongRunningExit>((resolve) => {
    resolveExit = resolve;
  });
  const text = () => Buffer.concat(stdout).toString('utf8');
  const child = startLongRunningProcess(
    { executable: NODE, cwd: os.tmpdir(), stdin: 'pipe', ...request },
    {
      onSpawn: () => events.push('spawn'),
      onStdout: (chunk) => {
        events.push('stdout');
        stdout.push(Buffer.from(chunk));
        watchers.forEach((w) => w());
      },
      onStderr: (chunk) => stderr.push(Buffer.from(chunk)),
      onExit: (e) => {
        events.push('exit');
        resolveExit(e);
      },
    },
    opts,
  );
  return {
    process: child,
    stdout,
    stderr,
    events,
    exit,
    text,
    stdoutIncludes: (needle) =>
      new Promise((resolve) => {
        const check = () => {
          if (text().includes(needle)) {
            resolve();
          }
        };
        watchers.push(check);
        check();
      }),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) {
      assert.fail(`process ${pid} is still running`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

suite('core/process: long-running processes (M2)', function () {
  // Process start-up is slow on some CI machines; no assertion depends on it.
  this.timeout(30_000);

  test('Restricted Mode: throws Unsupported and starts nothing', () => {
    assert.throws(
      () => start({ args: ['-e', ''] }, options({ trust: { isTrusted: false, onDidGrant: new Emitter<void>().event } })),
      (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported' && /Restricted Mode/.test(e.message),
    );
  });

  test('only fully qualified executables and working directories, and no NUL', () => {
    assert.throws(() => start({ executable: 'node', args: [] }), /executable "node" is not an absolute path/);
    assert.throws(() => start({ args: [], cwd: 'relative' }), /working directory "relative" is not an absolute path/);
    assert.throws(() => start({ args: ['a\0b'] }), /NUL/);
    assert.throws(
      () => start({ executable: '\\tools\\idris2.exe', args: [], cwd: 'C:\\w' }, options({ platform: 'win32' })),
      /executable .* is not an absolute path \(with a drive or UNC root/,
    );
  });

  test('stdin, stdout and stderr stream while the process runs; spawn comes first and exit once, last', async () => {
    const script =
      "process.stdout.write('ready\\n');" +
      "process.stdin.on('data', (d) => { process.stdout.write('echo:' + d); if (String(d).includes('bye')) { process.stderr.write('warning'); process.exit(4); } });";
    const run = start({ args: ['-e', script] });
    await run.stdoutIncludes('ready\n');
    run.process.write(Buffer.from('hello\n'));
    await run.stdoutIncludes('echo:hello\n');
    run.process.write(Buffer.from('bye\n'));
    const exit = await run.exit;
    assert.deepStrictEqual(exit, { code: 4, signal: null });
    assert.strictEqual(Buffer.concat(run.stderr).toString('utf8'), 'warning');
    assert.strictEqual(run.events[0], 'spawn');
    assert.deepStrictEqual(run.events.filter((e) => e === 'exit'), ['exit']);
    assert.strictEqual(run.events[run.events.length - 1], 'exit');
    run.process.write(Buffer.from('after the end is ignored\n'));
  });

  test('the environment overlay and the working directory are applied; stdin "ignore" is at end of file', async () => {
    const tmp = fs.realpathSync(os.tmpdir());
    const script =
      "process.stdin.on('data', () => {}); process.stdin.on('end', () => {" +
      'console.log(JSON.stringify([process.cwd(), process.env.VI2_A, process.env.VI2_B])); });';
    const run = start(
      { args: ['-e', script], cwd: tmp, env: { VI2_A: 'overlaid' }, stdin: 'ignore' },
      options({ baseEnv: { ...process.env, VI2_A: 'inherited', VI2_B: 'kept' } }),
    );
    await run.exit;
    const [cwd, a, b] = JSON.parse(run.text()) as string[];
    assert.strictEqual(fs.realpathSync(cwd), tmp);
    assert.deepStrictEqual([a, b], ['overlaid', 'kept']);
  });

  test('a missing executable ends with the spawn error, reported asynchronously and logged', async () => {
    const log = recordingLog();
    const run = start({ executable: path.join(os.tmpdir(), 'vi2-no-such-dir', 'idris2'), args: [] }, options({ log }));
    assert.strictEqual(run.events.length, 0, 'nothing is reported synchronously');
    const exit = await run.exit;
    assert.strictEqual(exit.code, null);
    assert.ok(exit.spawnError?.startsWith('ENOENT'), exit.spawnError);
    assert.ok(!run.events.includes('spawn'));
    assert.ok(log.lines.some((l) => l.startsWith('warn: ') && l.includes('could not be started')));
  });

  test('Windows: a batch file with an argument cmd.exe would expand is refused before anything starts', async () => {
    // The refusal is decided on strings (batchFileCommand), so it runs on every platform.
    const run = start(
      { executable: 'C:\\tools\\idris2.cmd', args: ['--ide-mode', '%PATH%'], cwd: 'C:\\w' },
      options({ platform: 'win32', baseEnv: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } }),
    );
    assert.deepStrictEqual(run.events, []);
    const exit = await run.exit;
    assert.match(exit.spawnError ?? '', /refused to run a batch file through cmd\.exe: the argument "%PATH%" contains %/);
  });

  test('stop: SIGTERM to the process group, then SIGKILL; a child that ignores SIGTERM under an sh wrapper is killed too (POSIX)', async function () {
    if (!POSIX) {
      this.skip();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-session-'));
    const program = path.join(dir, 'stubborn.js');
    fs.writeFileSync(program, "process.on('SIGTERM', () => {}); console.log(String(process.pid)); setInterval(() => {}, 1000);\n");
    let pid = 0;
    try {
      // The shape of the Homebrew idris2 launcher: sh runs the program as its child (no exec).
      const run = start({ executable: '/bin/sh', args: ['-c', `"$0" "$1"; true`, NODE, program], stdin: 'ignore' }, options({ graceMs: 300 }));
      await run.stdoutIncludes('\n');
      pid = Number(run.text().trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      run.process.stop();
      run.process.stop();
      const exit = await run.exit;
      assert.strictEqual(exit.code, null);
      await gone(pid, 10_000);
    } finally {
      if (pid > 0 && alive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('kill: SIGKILL at once, without a grace period and without a log line', async () => {
    const log = recordingLog();
    const run = start({ args: ['-e', "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000);"] }, options({ log, graceMs: 60_000 }));
    await run.stdoutIncludes('up');
    run.process.kill();
    const exit = await run.exit;
    if (POSIX) {
      assert.strictEqual(exit.signal, 'SIGKILL');
    }
    assert.deepStrictEqual(log.lines.filter((l) => !l.startsWith('debug:')), []);
  });
});
