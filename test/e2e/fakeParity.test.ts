// E2E (ROADMAP M2): the fake compiler's transcript replay against the real idris2. For five
// recorded scenarios, over both transports (one of them over stdio only), the real compiler and
// test/fake-idris2 (replaying test/fixtures/transcripts/<version>) get the same bytes in the
// same workspace copy, and every item of their protocol streams — frame texts and the bytes each
// took on the wire, which include the prefix — must be identical, as must the program output,
// the end of input and the exit code. Unit tests replay every transcript against the recording
// (test/unit/fakeIdris2Replay); this test closes the loop with the compiler the recordings came
// from.
import * as assert from 'assert';
import * as fs from 'fs';
import { transcriptsDir } from '../fake-idris2/client';
import { fakeLauncher } from '../fake-tools/paths';
import { copyWorkspace, recordedScenario, runScenario, scenarioWorkspace, type LiveRun } from './ideDriver';
import { extensionApi, probedIdris2, probedVersion, quiesce } from './helpers';

/**
 * - load-bad: a :warning and an :error, paths in replies (F6);
 * - load-simple-ipkg: two modules, dozens of :highlight-source frames, a reload (F7, F12, F13);
 * - plain: non-ASCII in both directions and a reply with the previous id (F1, F4);
 * - load-logging, over stdio only: the compiler's log lines unframed between the frames (F5). Over
 *   the socket the real compiler's stdout is a pipe, block-buffered, so the lines come at its
 *   exit, while the fake writes them with the reply (test/fake-idris2/README.md);
 * - eval-values (M3): an `eval` session (its own build directory, which is how the fake picks the
 *   recordings of that role), `:interpret` of values, an IO action, errors and a REPL command.
 */
const SCENARIOS: readonly (readonly [string, readonly ('stdio' | 'socket')[]])[] = [
  ['load-bad', ['stdio', 'socket']],
  ['load-simple-ipkg', ['stdio', 'socket']],
  ['plain', ['stdio', 'socket']],
  ['load-logging', ['stdio']],
  ['eval-values', ['stdio', 'socket']],
];

/** Everything of a run that the two processes must agree on. */
function observable(run: LiveRun): unknown {
  return {
    handshake: run.handshake,
    exchanges: run.exchanges.map((e) => ({
      request: e.request,
      items: e.items.map((i) => ({ kind: i.kind, text: i.text, byteLength: i.byteLength })),
      stdout: e.stdout,
    })),
    tailStream: run.tailStream,
    tailStdout: run.tailStdout,
    exitCode: run.exitCode,
    stderr: run.stderr,
  };
}

suite('E2E: the fake compiler replays what the real idris2 sends', function () {
  this.timeout(120000);
  let idris2: string;
  let transcripts: string;

  suiteSetup(async function () {
    this.timeout(90000);
    const api = await extensionApi();
    await quiesce(api);
    idris2 = probedIdris2(api);
    transcripts = transcriptsDir(probedVersion(api));
  });

  for (const [name, transports] of SCENARIOS) {
    for (const transport of transports) {
      test(`${name} over ${transport}: identical frames, output and exit`, async function () {
        if (!fs.existsSync(transcripts)) {
          // No recordings of this compiler version: `npm run record:transcripts` makes them.
          this.skip();
        }
        const workspace = copyWorkspace(scenarioWorkspace(recordedScenario(name)));
        try {
          // The real compiler first (it writes TTCs into the copy, which the fake never reads).
          const real = await runScenario(idris2, name, { transport, workspace });
          const fake = await runScenario(fakeLauncher('idris2'), name, {
            transport,
            workspace,
            env: { FAKE_IDRIS2_TRANSCRIPTS: transcripts },
          });
          assert.deepStrictEqual(observable(fake.run), observable(real.run));
        } finally {
          fs.rmSync(workspace.dir, { recursive: true, force: true });
        }
      });
    }
  }
});
