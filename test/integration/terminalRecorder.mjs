// A terminal "shell" for the install-command tests (terminalRecorder.ts beside it, used by
// test/integration/toolchainUi.test.ts and test/e2e/install.test.ts): it records every byte the
// terminal sends it into the file named by its first argument and executes nothing. The tests
// make it the default terminal profile, so the install commands type into it instead of into a
// real shell; the file then shows exactly what was typed, and whether a line break (Enter) was
// sent.
//
// In a terminal, standard input is a pseudo-terminal (a ConPTY console on Windows) whose line
// discipline would hold typed text back until a line break; raw mode passes each byte on as it
// arrives.
import fs from 'node:fs';
import process from 'node:process';

const out = process.argv[2];
fs.writeFileSync(out, '');
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.on('data', (chunk) => fs.appendFileSync(out, chunk));
process.stdin.on('end', () => process.exit(0));
process.stdout.write('vscode-idris2 e2e: typed text is recorded here and never executed\r\n');
