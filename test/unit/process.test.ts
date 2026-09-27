// core/process.ts: the process runner, against real child processes (node itself, and /bin/sh
// on POSIX), plus the pure helpers. No test depends on a process finishing within a short
// time: the time limits below either never expire (generous limits for quick children) or
// always expire (children that never end by themselves).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Log } from '../../src/core/log';
import { IdrisException } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import {
  batchFileCommand,
  commandInterpreter,
  createProcessRunner,
  createTunedProcessRunner,
  describeFailure,
  environmentValue,
  isBatchFile,
  isFullyQualifiedPath,
  overlayEnvironment,
  type OwnedProcessRunner,
  type ProcessRunnerTuning,
} from '../../src/core/process';
import type { ProcessResult } from '../../src/toolchain/types';

const NODE = process.execPath;
const GENEROUS = 60_000;
const POSIX = process.platform !== 'win32';

interface RecordingLog extends Log {
  readonly lines: string[];
}

function recordingLog(): RecordingLog {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => {
    lines.push(`${level}: ${message}`);
  };
  return { lines, trace: record('trace'), debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

function trust(isTrusted: boolean) {
  return { isTrusted, onDidGrant: new Emitter<void>().event };
}

function runner(options: Partial<ProcessRunnerTuning> = {}, log: Log = recordingLog()): OwnedProcessRunner {
  return createTunedProcessRunner(
    { trust: trust(true), log },
    { platform: process.platform, baseEnv: process.env, graceMs: 2_000, outputLimitBytes: 1024 * 1024, ...options },
  );
}

/** Whether a process with this pid exists (signal 0 tests for it, on Windows too). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves once `pid` is gone; fails after `ms` (a deadline, not a timing assertion). */
async function gone(pid: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) {
      assert.fail(`process ${pid} is still running`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Runs `node -e <script> <args…>`. */
function runNode(r: OwnedProcessRunner, script: string, extra: { args?: string[]; timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {}) {
  return r.run({
    executable: NODE,
    args: ['-e', script, ...(extra.args ?? [])],
    timeoutMs: extra.timeoutMs ?? GENEROUS,
    ...(extra.env === undefined ? {} : { env: extra.env }),
    ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
  });
}

suite('core/process', () => {
  suite('environment helpers', () => {
    test('overlay replaces inherited variables and drops unset ones', () => {
      assert.deepStrictEqual(overlayEnvironment({ A: '1', B: undefined, C: '3' }, { A: 'x', D: '4' }, 'linux'), {
        A: 'x',
        C: '3',
        D: '4',
      });
    });

    test('POSIX names are case-sensitive', () => {
      assert.deepStrictEqual(overlayEnvironment({ Path: '/a' }, { PATH: '/b' }, 'darwin'), { Path: '/a', PATH: '/b' });
      assert.strictEqual(environmentValue({ Path: '/a' }, 'PATH', 'linux'), undefined);
    });

    test('Windows names are case-insensitive: PATH replaces Path', () => {
      assert.deepStrictEqual(overlayEnvironment({ Path: 'C:\\a', Other: 'o' }, { PATH: 'C:\\b' }, 'win32'), {
        Other: 'o',
        PATH: 'C:\\b',
      });
      assert.strictEqual(environmentValue({ Path: 'C:\\a' }, 'PATH', 'win32'), 'C:\\a');
    });
  });

  suite('batchFileCommand (cmd.exe quoting)', () => {
    const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

    test('the batch file and every argument in quotes, the whole in one more pair, verbatim', () => {
      assert.deepStrictEqual(
        batchFileCommand('C:\\Program Files (x86)\\a&b\\idris2.cmd', ['--version', 'x y', 'a&b|c<d>e^f(g)'], COMSPEC),
        {
          file: COMSPEC,
          args: ['/d', '/s', '/v:off', '/c', '""C:\\Program Files (x86)\\a&b\\idris2.cmd" "--version" "x y" "a&b|c<d>e^f(g)""'],
        },
      );
    });

    test('without an absolute cmd.exe (ComSpec, SystemRoot) a batch file is refused', () => {
      assert.strictEqual(commandInterpreter({ ComSpec: 'D:\\cmd\\cmd.exe', SystemRoot: 'C:\\Windows' }), 'D:\\cmd\\cmd.exe');
      assert.strictEqual(commandInterpreter({ COMSPEC: 'cmd.exe', SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\cmd.exe');
      assert.strictEqual(commandInterpreter({ ComSpec: 'cmd.exe' }), undefined);
      // A root on the current drive is not a fully qualified path, for ComSpec or SystemRoot.
      assert.strictEqual(commandInterpreter({ ComSpec: '\\cmd.exe', SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\cmd.exe');
      assert.strictEqual(commandInterpreter({ SystemRoot: '\\Windows' }), undefined);
      const result = batchFileCommand('C:\\t\\idris2.cmd', ['--version'], commandInterpreter({}));
      assert.ok('refused' in result && result.refused.includes('neither ComSpec nor SystemRoot'), JSON.stringify(result));
    });

    test('a name Windows resolves to a batch file counts as one: trailing dots and spaces', () => {
      for (const file of ['C:\\t\\idris2.cmd', 'C:\\t\\IDRIS2.BAT', 'C:\\t\\idris2.cmd.', 'C:\\t\\idris2.cmd . ']) {
        assert.strictEqual(isBatchFile(file), true, file);
      }
      for (const file of ['C:\\t\\idris2.exe', 'C:\\t\\idris2.cmd.exe', 'C:\\t\\cmd']) {
        assert.strictEqual(isBatchFile(file), false, file);
      }
    });

    test('text cmd.exe would expand or split is refused, not escaped', () => {
      const cases: Array<[string, string[], string]> = [
        ['C:\\t\\idris2.cmd', ['%PATH%'], 'contains %'],
        ['C:\\t\\idris2.cmd', ['!x!'], 'contains !'],
        ['C:\\t\\idris2.cmd', ['say "hi"'], 'contains "'],
        ['C:\\t\\idris2.cmd', ['a\nb'], 'a line break'],
        ['C:\\t\\idris2.cmd', ['a\rb'], 'a carriage return'],
        ['C:\\t\\idris2.cmd', ['C:\\dir\\'], 'ends with a backslash'],
        ['C:\\100%\\idris2.cmd', [], 'the path'],
      ];
      for (const [file, args, why] of cases) {
        const result = batchFileCommand(file, args, COMSPEC);
        assert.ok('refused' in result && result.refused.includes(why), `${JSON.stringify(args)}: ${JSON.stringify(result)}`);
      }
    });
  });

  test('describeFailure', () => {
    const base: ProcessResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
    assert.strictEqual(describeFailure(base, 5000), undefined);
    assert.strictEqual(describeFailure({ ...base, exitCode: 2 }, 5000), 'exited with code 2');
    assert.strictEqual(describeFailure({ ...base, exitCode: null, signal: 'SIGSEGV' }, 5000), 'was ended by SIGSEGV');
    assert.strictEqual(describeFailure({ ...base, exitCode: null, timedOut: true }, 5000), 'did not finish within 5 s and was stopped');
    assert.strictEqual(
      describeFailure({ ...base, exitCode: null, spawnError: 'ENOENT: spawn /x ENOENT' }, 5000),
      'could not be started (ENOENT: spawn /x ENOENT)',
    );
  });

  suite('running processes', function () {
    // Process start-up is slow on some CI machines; no assertion depends on it.
    this.timeout(30_000);

    test('stdout, stderr and the exit code; UTF-8 split across writes decodes intact', async () => {
      const script =
        "const b = Buffer.from('→𝕟é', 'utf8');" +
        'process.stdout.write(b.subarray(0, 2));' +
        'setTimeout(() => { process.stdout.write(b.subarray(2)); process.stderr.write(process.argv[1]); process.exit(3); }, 50);';
      const result = await runNode(runner(), script, { args: ['to stderr'] });
      assert.strictEqual(result.stdout, '→𝕟é');
      assert.strictEqual(result.stderr, 'to stderr');
      assert.strictEqual(result.exitCode, 3);
      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.timedOut, false);
      assert.strictEqual(result.spawnError, undefined);
      assert.ok(result.durationMs > 0);
    });

    test('arguments reach the child unchanged (no shell)', async () => {
      const args = ['$HOME', '*', 'a b', '"q"', "'s'", '`x`', ';|&', ''];
      const result = await runNode(runner(), 'console.log(JSON.stringify(process.argv.slice(1)))', { args });
      assert.deepStrictEqual(JSON.parse(result.stdout), args);
    });

    test('the environment overlay replaces inherited variables', async () => {
      const name = 'VI2_PROCESS_TEST_INHERITED';
      const r = runner({ baseEnv: { ...process.env, [name]: 'inherited', VI2_KEPT: 'kept' } });
      const result = await runNode(r, `console.log(JSON.stringify([process.env.${name}, process.env.VI2_KEPT, process.env.VI2_NEW]))`, {
        env: { [name]: 'overlaid', VI2_NEW: 'new' },
      });
      assert.deepStrictEqual(JSON.parse(result.stdout), ['overlaid', 'kept', 'new']);
    });

    test("the default working directory is the executable's directory; an explicit one is used", async () => {
      const r = runner();
      const byDefault = await runNode(r, 'console.log(process.cwd())');
      assert.strictEqual(fs.realpathSync(byDefault.stdout.trim()), fs.realpathSync(path.dirname(NODE)));
      const tmp = fs.realpathSync(os.tmpdir());
      const explicit = await runNode(r, 'console.log(process.cwd())', { cwd: tmp });
      assert.strictEqual(fs.realpathSync(explicit.stdout.trim()), tmp);
    });

    test('stdin is at end of file at once', async () => {
      const result = await runNode(runner(), "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('eof'));");
      assert.strictEqual(result.stdout.trim(), 'eof');
    });

    test('a missing executable resolves with the spawn error', async () => {
      const missing = path.join(os.tmpdir(), 'vi2-no-such-dir', 'idris2');
      const log = recordingLog();
      const result = await runner({}, log).run({ executable: missing, args: ['--version'], timeoutMs: GENEROUS });
      assert.strictEqual(result.exitCode, null);
      assert.ok(result.spawnError?.startsWith('ENOENT'), result.spawnError);
      assert.ok(log.lines.some((l) => l.startsWith('warn:') && l.includes('could not be started')));
    });

    test('output beyond the limit stops the child and is cut at the limit', async () => {
      const log = recordingLog();
      const script = "const s = 'x'.repeat(65536); (function w() { while (process.stdout.write(s)); process.stdout.once('drain', w); })();";
      const result = await runNode(runner({ outputLimitBytes: 100_000 }, log), script);
      assert.strictEqual(result.stdout.length, 100_000);
      assert.strictEqual(result.exitCode, null);
      assert.strictEqual(result.timedOut, false);
      assert.ok(log.lines.some((l) => l.includes('more than 100000 bytes')));
    });

    test('termination: time limit, process group, SIGKILL escalation, pipes held by a grandchild', async () => {
      // Each scenario has its own runner, so all of them run at the same time. No outcome
      // depends on how fast anything starts: the children never end by themselves.
      //
      // - grandchild: the child starts a detached grandchild that inherits stdout, prints its
      //   pid and exits 0; the grandchild would hold the pipes for 30 s, but the result comes
      //   once the grace period after the child's exit has passed (the Windows case, where
      //   only the direct child can be terminated).
      // - POSIX group: `sleep` is a grandchild that holds the pipes. With a grace period beyond
      //   the suite's 30 s mocha limit, the result comes in time only if the SIGTERM sent to the
      //   group at the time limit also ended `sleep`.
      // - POSIX escalation: a group that ignores SIGTERM (a disposition `sleep` inherits) ends
      //   only by the SIGKILL that follows the grace period.
      // - elsewhere: a Node child that never ends is stopped at the time limit.
      const grandchildScript =
        "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' });" +
        'console.log(c.pid); c.unref();';
      const sh = (graceMs: number, script: string) =>
        runner({ graceMs }).run({ executable: '/bin/sh', args: ['-c', script], timeoutMs: 1_000 });
      const [grandchild, terminated, killed] = await Promise.all([
        runNode(runner({ graceMs: 1_000 }), grandchildScript),
        POSIX
          ? sh(60_000, 'sleep 30; echo never')
          : runNode(runner(), 'setInterval(() => {}, 1000); console.log("started")', { timeoutMs: 1_000 }),
        POSIX ? sh(200, 'trap "" TERM; sleep 30; echo never') : undefined,
      ]);

      const pid = Number(grandchild.stdout.trim());
      try {
        assert.strictEqual(grandchild.exitCode, 0);
        assert.strictEqual(grandchild.timedOut, false);
      } finally {
        if (Number.isSafeInteger(pid) && pid > 0) {
          process.kill(pid);
        }
      }
      assert.ok(Number.isSafeInteger(pid) && pid > 0, `the grandchild's pid was collected: ${JSON.stringify(grandchild.stdout)}`);

      for (const result of killed === undefined ? [terminated] : [terminated, killed]) {
        assert.strictEqual(result.timedOut, true);
        assert.strictEqual(result.exitCode, null);
        assert.ok(!result.stdout.includes('never'));
      }
      if (POSIX) {
        assert.strictEqual(terminated.signal, 'SIGTERM');
        assert.strictEqual(killed?.signal, 'SIGKILL');
      }
    });

    test('POSIX: after a wrapper dies on SIGTERM, its child that ignores it is killed after the grace period', async function () {
      if (!POSIX) {
        this.skip();
      }
      // The shape of the idris2 launchers (Homebrew's, pack's): `sh` runs the program as its
      // child (`; true` keeps sh from exec'ing it) and ends on SIGTERM at once; the program
      // ignores SIGTERM and holds the output pipes. Only the SIGKILL to the group stops it.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-wrapper-'));
      const program = path.join(dir, 'stubborn.js');
      fs.writeFileSync(program, "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);\n");
      let pid = 0;
      try {
        const result = await runner({ graceMs: 500 }).run({
          executable: '/bin/sh',
          args: ['-c', `"$0" "$1"; true`, NODE, program],
          timeoutMs: 1_000,
        });
        pid = Number(result.stdout.trim());
        assert.ok(Number.isSafeInteger(pid) && pid > 0, `the program's pid was printed: ${JSON.stringify(result.stdout)}`);
        assert.strictEqual(result.timedOut, true);
        await gone(pid, 10_000);
      } finally {
        if (pid > 0 && alive(pid)) {
          process.kill(pid, 'SIGKILL');
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    if (process.platform === 'win32') {
      test('Windows: a timed-out .cmd file is stopped together with the program it started (taskkill /T)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-cmd-'));
        let pid = 0;
        try {
          fs.writeFileSync(path.join(dir, 'forever.js'), 'console.log(process.pid); setInterval(() => {}, 1000);\n');
          const cmd = path.join(dir, 'forever.cmd');
          fs.writeFileSync(cmd, `@"${NODE}" "%~dp0forever.js"\r\n`);
          const result = await runner({ graceMs: 1_000 }).run({ executable: cmd, args: [], timeoutMs: 5_000 });
          pid = Number(result.stdout.trim());
          assert.ok(Number.isSafeInteger(pid) && pid > 0, `the program's pid was printed: ${JSON.stringify(result.stdout)}`);
          assert.strictEqual(result.timedOut, true);
          await gone(pid, 10_000);
        } finally {
          if (pid > 0 && alive(pid)) {
            process.kill(pid);
          }
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });

      test('Windows: a .cmd file runs through cmd.exe with its arguments intact; unsafe ones are refused', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-cmd-'));
        try {
          fs.writeFileSync(path.join(dir, 'echo.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
          const cmd = path.join(dir, 'echo tool.cmd');
          fs.writeFileSync(cmd, `@"${NODE}" "%~dp0echo.js" %*\r\n`);
          const args = ['--version', 'a b', 'x&y', '(p)', 'c^d', 'e|f', 'g<h>'];
          const result = await runner().run({ executable: cmd, args, timeoutMs: GENEROUS });
          assert.strictEqual(result.exitCode, 0, result.stderr);
          assert.deepStrictEqual(JSON.parse(result.stdout), args);
          const refused = await runner().run({ executable: cmd, args: ['%PATH%'], timeoutMs: GENEROUS });
          assert.ok(refused.spawnError?.includes('contains %'), refused.spawnError);
          assert.strictEqual(refused.stdout, '');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });

  suite('the runner contract', function () {
    this.timeout(30_000);

    test('Restricted Mode: rejects with Unsupported and starts nothing', async () => {
      const r = createProcessRunner({ trust: trust(false), log: recordingLog() });
      // A missing executable would resolve with ENOENT if it were attempted.
      await assert.rejects(
        r.run({ executable: path.join(os.tmpdir(), 'vi2-none', 'x'), args: [], timeoutMs: GENEROUS }),
        (e: unknown) => e instanceof IdrisException && e.error.kind === 'Unsupported' && e.message.includes('Restricted Mode'),
      );
    });

    test('trust is read at every call: once granted, processes run', async () => {
      const state = { isTrusted: false, onDidGrant: new Emitter<void>().event };
      const r = createProcessRunner({ trust: state, log: recordingLog() });
      await assert.rejects(r.run({ executable: NODE, args: ['-e', ''], timeoutMs: GENEROUS }));
      state.isTrusted = true;
      assert.strictEqual((await r.run({ executable: NODE, args: ['-e', ''], timeoutMs: GENEROUS })).exitCode, 0);
    });

    test('invalid requests reject', async () => {
      const r = runner();
      await assert.rejects(r.run({ executable: 'node', args: [], timeoutMs: GENEROUS }), /not an absolute path/);
      await assert.rejects(r.run({ executable: NODE, args: [], timeoutMs: 0 }), /time limit/);
      await assert.rejects(r.run({ executable: NODE, args: ['a\0b'], timeoutMs: GENEROUS }), /NUL/);
      await assert.rejects(r.run({ executable: NODE, args: [], cwd: 'relative', timeoutMs: GENEROUS }), /working directory/);
    });

    test('Windows: an executable or working directory on the current drive (\\x) or relative to a drive (C:x) is refused', async () => {
      // Checked before anything is spawned, so this runs on every platform.
      const r = runner({ platform: 'win32' });
      for (const executable of ['\\usr\\local\\bin\\idris2.exe', '/opt/homebrew/bin/idris2', 'C:idris2.exe']) {
        await assert.rejects(r.run({ executable, args: [], timeoutMs: GENEROUS }), /executable .* is not an absolute path \(with a drive or UNC root/);
      }
      await assert.rejects(
        r.run({ executable: 'C:\\tools\\idris2.exe', args: [], cwd: '\\work', timeoutMs: GENEROUS }),
        /working directory "\\\\work" is not an absolute path/,
      );
    });

    test('isFullyQualifiedPath: a drive with a separator or a UNC path on Windows, a leading / on POSIX', () => {
      for (const p of ['C:\\x', 'c:/x', '\\\\srv\\share\\x', '//srv/share', '\\\\?\\C:\\x']) {
        assert.ok(isFullyQualifiedPath(p, 'win32'), p);
      }
      for (const p of ['\\x', '/x', 'C:x', 'C:', 'x', '', '\\\\', '\\\\\\x']) {
        assert.ok(!isFullyQualifiedPath(p, 'win32'), p);
      }
      assert.ok(isFullyQualifiedPath('/x', 'linux') && !isFullyQualifiedPath('x', 'darwin') && !isFullyQualifiedPath('', 'linux'));
    });

    test('one process at a time, in call order', async () => {
      const r = runner();
      const script = 'const s = Date.now(); setTimeout(() => console.log(JSON.stringify([s, Date.now()])), 100);';
      const results = await Promise.all([0, 1, 2].map(() => runNode(r, script)));
      const spans = results.map((res) => JSON.parse(res.stdout) as [number, number]);
      for (let i = 1; i < spans.length; i++) {
        assert.ok(spans[i][0] >= spans[i - 1][1], `run ${i} started at ${spans[i][0]} before run ${i - 1} ended at ${spans[i - 1][1]}`);
      }
    });

    test('an invalid request is rejected without being queued', async () => {
      const r = runner();
      const bad = r.run({ executable: 'relative', args: [], timeoutMs: GENEROUS });
      const good = runNode(r, 'console.log("ok")');
      await assert.rejects(bad);
      assert.strictEqual((await good).stdout.trim(), 'ok');
    });

    test('dispose: the running process is stopped without a log line, queued and later requests reject', async () => {
      const log = recordingLog();
      const r = runner({ graceMs: 500 }, log);
      const running = runNode(r, 'setInterval(() => {}, 1000); console.log("started")');
      const queued = runNode(r, 'console.log("never")');
      // Dispose once the first process has been started (the runner logs each start).
      const deadline = Date.now() + 10_000;
      while (!log.lines.some((l) => l.startsWith('debug: Running '))) {
        assert.ok(Date.now() < deadline, 'the first process did not start');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      r.dispose();
      const stopped = await running;
      assert.strictEqual(stopped.exitCode, null);
      assert.strictEqual(stopped.timedOut, false);
      await assert.rejects(queued, /disposed before the process started/);
      await assert.rejects(runNode(r, ''), /has been disposed/);
      assert.deepStrictEqual(log.lines.filter((l) => !l.startsWith('debug:')), [], 'nothing is logged after dispose');
    });

    test('POSIX: dispose kills at once, without a grace period (a child that ignores SIGTERM)', async function () {
      if (!POSIX) {
        this.skip();
      }
      // deactivate() is synchronous and the Extension Host may exit before a grace timer
      // fires. With a grace period beyond the suite's 30 s limit, the result comes in time only
      // if dispose() sent SIGKILL itself.
      const log = recordingLog();
      const r = runner({ graceMs: 60_000 }, log);
      const running = runNode(r, "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);");
      const deadline = Date.now() + 10_000;
      while (!log.lines.some((l) => l.startsWith('debug: Running '))) {
        assert.ok(Date.now() < deadline, 'the process did not start');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Before the child installs its handler a SIGTERM would end it with signal SIGTERM, after
      // it the result would wait for the grace period: either fails the assertions below.
      r.dispose();
      const stopped = await running;
      assert.strictEqual(stopped.signal, 'SIGKILL');
      assert.strictEqual(stopped.exitCode, null);
    });

    test('every run is logged at debug level', async () => {
      const log = recordingLog();
      await runNode(runner({}, log), '', { args: ['a b'] });
      assert.ok(log.lines.some((l) => l.startsWith('debug: Running ') && l.includes('"a b"')), log.lines.join('\n'));
    });
  });
});
