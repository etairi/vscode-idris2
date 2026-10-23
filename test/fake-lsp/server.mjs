// fake idris2-lsp, the language server: a stand-in for `idris2-lsp` started with no arguments, which
// serves the Language Server Protocol over stdio by replaying the sessions recorded from the real
// server (`npm run record:lsp-transcripts`, test/fixtures/lsp-transcripts/). Started by
// test/fake-lsp/bin/idris2-lsp; README.md describes the replay, the logs and the faults, and what
// is not mirrored. The replay model is replay.mjs; this file is the process: framing, logs, faults.
//
// Environment:
//   FAKE_IDRIS2_LSP_TRANSCRIPTS   the directory of the recordings (required; .vscode-test.mjs sets it)
//   FAKE_IDRIS2_LSP_LOG           appends `{"pid", "args", "cwd"}` as one JSON line when the server starts
//   FAKE_IDRIS2_LSP_MESSAGE_LOG   appends `{"pid", "message", "replay"}` for every message received
//   FAKE_IDRIS2_LSP_FAULT         `missing-ipkg` (README.md, "Faults")
//   FAKE_IDRIS2_LSP_MODE, FAKE_IDRIS2_LSP_DELAY_MS   test/fake-tools/faults.mjs, applied before anything else
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { applyFaults } from '../fake-tools/faults.mjs';
import { documentUri, isNotification, isRequest, readTranscripts, Replayer } from './replay.mjs';

const TOOL = 'fake-idris2-lsp';

/** A mistake in the test or the recordings: stderr, exit code 2, before anything is served. */
function misconfigured(message) {
  process.stderr.write(`${TOOL}: ${message}\n`);
  process.exit(2);
}

/**
 * Appends `value` to a log as one JSON line. A log that cannot be written (a test deleted its
 * directory while this process still ran) is reported on stderr and otherwise ignored: the server
 * goes on answering, as a test's cleanup must not crash it.
 */
function appendJsonLine(file, value) {
  if (file === undefined || file === '') {
    return;
  }
  try {
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  } catch (error) {
    process.stderr.write(`${TOOL}: cannot append to ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

await applyFaults(TOOL, 'FAKE_IDRIS2_LSP');
appendJsonLine(process.env.FAKE_IDRIS2_LSP_LOG, { pid: process.pid, args: process.argv.slice(2), cwd: process.cwd() });

const FAULTS = new Set(['missing-ipkg']);
const fault = process.env.FAKE_IDRIS2_LSP_FAULT ?? '';
if (fault !== '' && !FAULTS.has(fault)) {
  misconfigured(`FAKE_IDRIS2_LSP_FAULT must be one of ${[...FAULTS].join(', ')}, not ${JSON.stringify(fault)}`);
}

const transcriptsDir = process.env.FAKE_IDRIS2_LSP_TRANSCRIPTS ?? '';
if (transcriptsDir === '') {
  misconfigured('FAKE_IDRIS2_LSP_TRANSCRIPTS is not set, so there is nothing to replay');
}
let replayer;
try {
  // `${ROOT}` is the working directory: the recorder started the server in its copy of the workspace,
  // as the extension starts it in a workspace folder.
  replayer = new Replayer(readTranscripts(transcriptsDir), { root: fs.realpathSync.native(process.cwd()), home: os.homedir() });
} catch (error) {
  misconfigured(error instanceof Error ? error.message : String(error));
}

const messageLog = process.env.FAKE_IDRIS2_LSP_MESSAGE_LOG;

/**
 * A body as the server writes it: JSON with every character outside ASCII as a `\uXXXX` escape in
 * capitals (a character outside the BMP as its surrogate pair), as every recorded body is
 * (test/fixtures/lsp-transcripts/README.md, "Format").
 */
function serverJson(message) {
  return JSON.stringify(message).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

function write(item) {
  switch (item.kind) {
    case 'message': {
      const body = serverJson(item.message);
      process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
      return;
    }
    case 'unframed':
      process.stdout.write(item.text);
      return;
    case 'stderr':
      // A recorded line keeps its line break (scripts/record-lsp-transcripts.mjs `LineReader`).
      process.stderr.write(item.text.endsWith('\n') ? item.text : `${item.text}\n`);
      return;
  }
}

/**
 * `missing-ipkg`: what `withURI` answers when `loadURI` finds no `.ipkg` (Server/ProcessMessage.idr
 * 221–225, 291–297 [src]) — for every request about a document, the response error with code 3 and
 * the message `Cannot load ipkg file for <uri>: "Cannot find the ipkg file"`; `didOpen` and `didSave`
 * publish nothing. The server also logs that message; the fake does not, so that a test sees the
 * response alone. (Live, a file without an `.ipkg` gets other answers, test/fixtures/lsp-transcripts
 * `loose-file`; this fault simulates the source path F35 describes.)
 */
function missingIpkg(message) {
  const uri = documentUri(message);
  if (uri === undefined || !(isRequest(message) || message.method === 'textDocument/didOpen' || message.method === 'textDocument/didSave')) {
    return undefined;
  }
  replayer.state.apply(message);
  if (!isRequest(message)) {
    return { replay: 'fault', output: [] };
  }
  const error = { code: 3, message: `Cannot load ipkg file for ${uri}: "Cannot find the ipkg file"`, data: null };
  return { replay: 'fault', output: [{ kind: 'message', message: { jsonrpc: '2.0', id: message.id, error } }] };
}

function receive(body) {
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    process.stderr.write(`${TOOL}: a message that is not JSON: ${JSON.stringify(body)}\n`);
    process.exit(1);
  }
  const answer = (fault === 'missing-ipkg' ? missingIpkg(message) : undefined) ?? replayer.receive(message);
  appendJsonLine(messageLog, { pid: process.pid, message, replay: answer.replay });
  if (answer.replay === 'unrecorded' && isRequest(message)) {
    process.stderr.write(`${TOOL}: no recorded reply for ${message.method}; answered ${serverJson(answer.output[0].message)}\n`);
  }
  answer.output.forEach(write);
  if (isNotification(message) && message.method === 'exit') {
    const code = replayer.exitCode;
    process.stdout.write('', () => process.exit(code));
  }
}

// Framing: header lines up to an empty line, `Content-Length` among them, then that many bytes of
// body (the server's `handleMessage`, Server/Main.idr 81–91 [src]). Input the server cannot read
// ends it with exit code 1, as the server's does; its parse-error response is not mirrored.
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) {
      return;
    }
    const header = buffer.subarray(0, end).toString('ascii');
    const match = /^Content-Length: *(\d+)$/im.exec(header);
    if (match === null) {
      process.stderr.write(`${TOOL}: a header without Content-Length: ${JSON.stringify(header)}\n`);
      process.exit(1);
    }
    const length = Number(match[1]);
    if (buffer.length < end + 4 + length) {
      return;
    }
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
    buffer = buffer.subarray(end + 4 + length);
    receive(body);
  }
});
// End of input: the server exits with 1 (`fEOF`, Server/Main.idr 87–88).
process.stdin.on('end', () => process.exit(1));
