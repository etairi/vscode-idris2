// The replies of a recorded transcript (test/fixtures/transcripts/0.8.0, format in its README)
// as the session layer hands them to its callers: one `Reply` per request, with every message
// the compiler sent for it before its `:return`, decoded by `protocol.ts` — so that the
// diagnostics mapping is tested on the compiler's exact output. `${ROOT}` is replaced by the
// directory the test chooses.
import * as fs from 'fs';
import * as path from 'path';
import { ideCodec } from '../../../src/backend/ide/protocol';
import type { IdeMessage, Reply } from '../../../src/backend/ide/types';
import { repoRoot } from '../../fake-tools/paths';

export interface RecordedExchange {
  /** The request's text as sent (`${ROOT}` replaced). */
  readonly request: string;
  readonly reply: Reply;
}

interface TranscriptEvent {
  readonly kind: string;
  readonly text?: string;
  readonly cwd?: string;
}

/** The transcript's `meta.cwd`: the fixture directory, relative to the repository. */
export function transcriptCwd(scenario: string): string {
  const [meta] = readEvents(scenario);
  if (meta.kind !== 'meta' || meta.cwd === undefined) {
    throw new Error(`${scenario}: no meta line`);
  }
  return meta.cwd;
}

function readEvents(scenario: string): TranscriptEvent[] {
  const file = path.join(repoRoot(), 'test', 'fixtures', 'transcripts', '0.8.0', `${scenario}.jsonl`);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptEvent);
}

/** Every request of `scenario` with its reply, in order. */
export function recordedExchanges(scenario: string, root: string): RecordedExchange[] {
  const exchanges: RecordedExchange[] = [];
  let request: string | undefined;
  let messages: IdeMessage[] = [];
  for (const event of readEvents(scenario)) {
    if (event.kind === 'send') {
      request = (event.text ?? '').split('${ROOT}').join(root);
      messages = [];
      continue;
    }
    if (event.kind !== 'recv' || request === undefined) {
      continue;
    }
    const decoded = ideCodec.decodeMessage((event.text ?? '').split('${ROOT}').join(root));
    if (decoded.kind !== 'message') {
      throw new Error(`${scenario}: a frame the decoder does not read: ${event.text}`);
    }
    const message = decoded.message;
    if (message.kind === 'return') {
      exchanges.push({ request, reply: { id: message.id, payload: message.payload, messages } });
      request = undefined;
    } else {
      messages.push(message);
    }
  }
  return exchanges;
}
