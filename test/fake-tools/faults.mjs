// Fault injection shared by the fake tools (test/fake-tools/README.md, "Simulating faults").
//
// Each fake reads `<PREFIX>_MODE` and `<PREFIX>_DELAY_MS` from its environment, where PREFIX is
// FAKE_IDRIS2, FAKE_IDRIS2_LSP or FAKE_PACK. Integration tests set them through the
// `idris2.toolchain.env` setting, which the extension passes to every process it starts.
//
//   <PREFIX>_MODE      unset or `normal`; `fail` (stderr line, exit 1); `hang` (no output, never
//                      exits by itself until FAKE_TOOL_HANG_LIMIT_MS, default 60000, have passed,
//                      then exits 1, so that a process the test runner failed to kill does not
//                      outlive the run); `garbage` (tool-specific unexpected output, see each fake)
//   <PREFIX>_DELAY_MS  milliseconds to wait before doing anything (a slow tool that still answers)
//
// Any other value is a mistake in the test, reported with exit code 2 like every command line
// the fakes do not implement.
import process from 'node:process';

const MODES = new Set(['normal', 'fail', 'hang', 'garbage']);

function misconfigured(tool, message) {
  process.stderr.write(`${tool}: ${message}\n`);
  process.exit(2);
}

/**
 * Applies the delay and the `fail`/`hang` modes for `tool` (its name in messages) and resolves
 * with `'normal'` or `'garbage'` when the fake should go on. For `fail` the process exits; for
 * `hang` the promise never resolves.
 */
export async function applyFaults(tool, prefix) {
  const mode = process.env[`${prefix}_MODE`] || 'normal';
  if (!MODES.has(mode)) {
    misconfigured(tool, `${prefix}_MODE must be one of ${[...MODES].join(', ')}, not ${JSON.stringify(mode)}`);
  }
  const delayText = process.env[`${prefix}_DELAY_MS`];
  if (delayText !== undefined && delayText !== '') {
    const delay = Number(delayText);
    if (!Number.isInteger(delay) || delay < 0) {
      misconfigured(tool, `${prefix}_DELAY_MS must be a non-negative integer, not ${JSON.stringify(delayText)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (mode === 'fail') {
    process.stderr.write(`${tool}: simulated failure (${prefix}_MODE=fail)\n`);
    process.exit(1);
  }
  if (mode === 'hang') {
    const limitText = process.env.FAKE_TOOL_HANG_LIMIT_MS;
    const limit = limitText === undefined || limitText === '' ? 60000 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 0) {
      misconfigured(tool, `FAKE_TOOL_HANG_LIMIT_MS must be a non-negative integer, not ${JSON.stringify(limitText)}`);
    }
    setTimeout(() => process.exit(1), limit);
    return new Promise(() => {});
  }
  return mode;
}

/** Rejects a command line the fake does not implement: stderr, exit code 2. */
export function notImplemented(tool, argv) {
  misconfigured(tool, `arguments not implemented by the fake: ${JSON.stringify(argv)}`);
}
