/**
 * Tokenisation time of the Idris 2 grammar (ROADMAP E6). The input is every committed fixture in
 * test/fixtures/grammar/*.idr, concatenated in name order and repeated until it has at least
 * MIN_LINES lines, so the measurement needs nothing outside the repository. After one warm-up run
 * (regex compilation), the input is tokenised RUNS times from a fresh rule stack; the median is
 * logged with the machine and Node version and must stay within BUDGET_MS.
 *
 * BUDGET_MS is twice the CI median (ROADMAP E6). The first two M0 CI runs (36327101720 and
 * 36327327811, 2026-09-27, 2,372 lines) logged medians of 84.2 and 83.0 ms on ubuntu-latest and
 * 118.4 and 148.8 ms on macos-latest (a virtualised Apple M1, the slower and noisier runner);
 * the budget is 2 × 148.8 ms, rounded to 300 ms. The development machine (Apple M4) measures
 * about 52 ms. The test runs locally too, so a slower developer machine could exceed the
 * budget without a regression; the logged runs make that easy to tell apart.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import { grammarFor, repoRoot } from './harness';

const MIN_LINES = 2000;
const RUNS = 5;
const BUDGET_MS = 300;

suite('grammar performance', () => {
  test(`idris2: median of ${RUNS} tokenisations of a ${MIN_LINES}+ line input`, async function () {
    this.timeout(0);
    const dir = path.join(repoRoot, 'test', 'fixtures', 'grammar');
    const text = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.idr'))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    const once = text.split(/\r?\n/);
    const lines: string[] = [];
    while (lines.length < MIN_LINES) {
      lines.push(...once);
    }
    const grammar = await grammarFor('source.idris2');
    const run = (): number => {
      let stack = vsctm.INITIAL;
      const start = process.hrtime.bigint();
      for (const line of lines) {
        stack = grammar.tokenizeLine(line, stack).ruleStack;
      }
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    run();
    const times = Array.from({ length: RUNS }, run).sort((a, b) => a - b);
    const median = times[Math.floor(RUNS / 2)];
    console.log(
      `      ${lines.length} lines; runs ${times.map((t) => t.toFixed(1)).join(', ')} ms; median ${median.toFixed(1)} ms ` +
        `(${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.platform()} ${os.arch()}, Node ${process.version})`,
    );
    assert.ok(median <= BUDGET_MS, `median ${median.toFixed(1)} ms exceeds ${BUDGET_MS} ms`);
  });
});
