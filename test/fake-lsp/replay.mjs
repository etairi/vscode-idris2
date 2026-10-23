// The replay model of the fake idris2-lsp (test/fake-lsp/README.md, "Replay"): which recorded
// answer a client message gets. No I/O but reading the transcripts and the fixture files; the
// framing, the logs and the faults are server.mjs's, so the unit test (test/unit/fakeLsp.test.ts)
// drives the same model through the process.
//
// The server's behaviour this model follows, read in idris2-lsp 9a2f0ad [src]:
//   - It answers one message at a time, in order (`runServer`, Server/Main.idr 153).
//   - `didOpen` and `didSave` load the file (`loadURI`), which publishes its diagnostics; `didSave`
//     then sends `workspace/semanticTokens/refresh` (Server/ProcessMessage.idr 574–592). `didChange`
//     marks the file dirty (594–604), and while it is dirty hover, highlights, definition, code
//     actions, signature help and symbols answer null and semantic tokens `RequestCancelled`
//     (367–511); a save clears it. `didClose` forgets the loaded file (`openFile := Nothing`, 606–618).
//   - A request about a file that is not the loaded one loads it first (`loadIfNeeded`, `withURI`,
//     267–297); `metavars`, `repl` and `browseNamespace` answer in the context of the file loaded
//     last.
//   - `processSettings` (137–189) reads the options from the top level of `initializationOptions`
//     and of `didChangeConfiguration`'s `settings`, each only with the right JSON type.
//   - `exit` ends the process with 0 after `shutdown`, else with 1 (563–568).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The transcript format this model reads (test/fixtures/lsp-transcripts/README.md, `meta.format`). */
export const FORMAT = 1;

const REPLAYED_EVENTS = new Set(['send', 'recv', 'unframed', 'stderr', 'fs', 'exit', 'files']);

/**
 * Reads every `*.jsonl` of `dir`, sorted by name. Throws, naming the file, when one cannot be
 * replayed: not format 1, an event of a kind this model does not know (`spawn-error`,
 * `stdin-error`), or a text stored as base64 (not valid UTF-8).
 */
export function readTranscripts(dir) {
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  if (names.length === 0) {
    throw new Error(`no transcript (*.jsonl) in ${dir}`);
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    const [meta, ...events] = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
    if (meta?.kind !== 'meta' || meta.format !== FORMAT) {
      throw new Error(`${file}: not a format-${FORMAT} transcript`);
    }
    events.forEach((event, i) => {
      if (!REPLAYED_EVENTS.has(event.kind) || 'base64' in event) {
        throw new Error(`${file}:${i + 2}: an event the fake cannot replay (${JSON.stringify(event.kind)})`);
      }
    });
    return { file, name: meta.scenario, meta, events };
  });
}

/** `text` with the transcript placeholders replaced (README "Placeholders"); `json`: inside JSON strings. */
function substitute(text, places, json) {
  const lit = (s) => (json ? JSON.stringify(s).slice(1, -1) : s);
  return text
    .replaceAll('file://${ROOT}', lit(pathToFileURL(places.root).href))
    .replaceAll('${ROOT}', lit(places.root))
    .replaceAll('file://${HOME}', lit(pathToFileURL(places.home).href))
    .replaceAll('${HOME}', lit(places.home));
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** The server's option defaults (`defaultConfig`, Server/Configuration.idr 77–98; the compiler's printing options). */
const DEFAULT_OPTIONS = {
  longActionTimeout: 1000,
  maxCodeActionResults: 5,
  showImplicits: false,
  showMachineNames: false,
  fullNamespace: false,
  briefCompletions: false,
};

/** `processSettings`: the options in `settings` of the right type replace the current ones. */
function processSettings(options, settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return options;
  }
  const next = { ...options };
  for (const [key, fallback] of Object.entries(DEFAULT_OPTIONS)) {
    if (key in settings && typeof settings[key] === typeof fallback) {
      next[key] = settings[key];
    }
  }
  return next;
}

/** Requests answered about one position of a document. */
const AT_POSITION = new Set([
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/documentHighlight',
  'textDocument/signatureHelp',
  'textDocument/completion',
]);

/** Requests answered about a whole document. */
const WHOLE_DOCUMENT = new Set([
  'textDocument/documentSymbol',
  'textDocument/semanticTokens/full',
  'textDocument/codeLens',
  'textDocument/documentLink',
]);

/** Requests that answer from the loaded file and load the document first unless it is dirty (`withURI`). */
const LOADING = new Set([
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/documentHighlight',
  'textDocument/signatureHelp',
  'textDocument/documentSymbol',
  'textDocument/semanticTokens/full',
  'textDocument/codeAction',
]);

/** The commands the server handles (`handleRequest WorkspaceExecuteCommand`, Server/ProcessMessage.idr 512–546). */
const COMMANDS = new Set(['repl', 'metavars', 'exprSearchWithHints', 'refineHole', 'browseNamespace']);

export const isRequest = (message) => typeof message.method === 'string' && message.id !== undefined;
export const isNotification = (message) => typeof message.method === 'string' && message.id === undefined;

/**
 * How a file named in a message is compared: its real path, so that a document reached through a
 * symbolic link and one named by its real path are the same file. `realpath` throws for a file that
 * does not exist; the path is then used as it is.
 */
function fileKey(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) {
    return String(uri);
  }
  const file = fileURLToPath(uri);
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * A code action request as the server reads it: the document, the range and `context.only`. The
 * attached diagnostics and `triggerKind` are left out: the server ignores both [src: the code action
 * modules read `params.range` and `params.context.only`; the quick fixes come from its own store, F28].
 */
function codeActionKey(params) {
  const at = (p) => ({ line: p?.line, character: p?.character });
  return {
    file: fileKey(params?.textDocument?.uri),
    range: { start: at(params?.range?.start), end: at(params?.range?.end) },
    only: Array.isArray(params?.context?.only) ? [...params.context.only].sort() : null,
  };
}

/** An executeCommand argument with file URIs as files and code action requests as `codeActionKey`. */
function normaliseArgument(value) {
  if (typeof value === 'string') {
    return value.startsWith('file:') ? `file:${fileKey(value)}` : value;
  }
  if (Array.isArray(value)) {
    return value.map(normaliseArgument);
  }
  if (value !== null && typeof value === 'object') {
    if ('textDocument' in value && 'range' in value && 'context' in value) {
      return codeActionKey(value);
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normaliseArgument(value[key])]),
    );
  }
  return value;
}

/**
 * The URI of the document a client message is about, if any: its `textDocument`, or for
 * `exprSearchWithHints` and `refineHole` the code action request in its argument.
 */
export function documentUri(message) {
  const uri = message.params?.textDocument?.uri ?? message.params?.arguments?.[0]?.codeAction?.textDocument?.uri;
  return typeof uri === 'string' ? uri : undefined;
}

/** The document a client message is about, as `fileKey`, if any. */
function documentOf(message) {
  const uri = documentUri(message);
  return uri === undefined ? undefined : fileKey(uri);
}

/**
 * The key two client messages must share for one to be answered with the other's recording: the
 * method and what the server reads of the parameters (README, "Matching"). `undefined` for a message
 * that is never matched (`initialize`, `shutdown` and the notifications without output are handled by
 * the session itself; responses are not matched).
 */
export function keyOf(message) {
  const { method, params } = message;
  if (isRequest(message)) {
    if (AT_POSITION.has(method)) {
      return `${method} ${fileKey(params?.textDocument?.uri)} ${params?.position?.line}:${params?.position?.character}`;
    }
    if (WHOLE_DOCUMENT.has(method)) {
      return `${method} ${fileKey(params?.textDocument?.uri)}`;
    }
    if (method === 'textDocument/codeAction') {
      return `${method} ${JSON.stringify(codeActionKey(params))}`;
    }
    if (method === 'workspace/executeCommand') {
      // The server ignores metavars' arguments (`MkExecuteCommandParams _ "metavars" _`).
      const args = params?.command === 'metavars' ? [] : normaliseArgument(params?.arguments ?? null);
      return `${method} ${params?.command} ${JSON.stringify(args)}`;
    }
    return undefined;
  }
  if (isNotification(message) && (method === 'textDocument/didOpen' || method === 'textDocument/didSave')) {
    return `${method} ${fileKey(params?.textDocument?.uri)}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------------------------

/**
 * What of the server's state the replay follows: the dirty documents, the file loaded last and the
 * options. (The files on disk are compared separately, `Replayer.eligible`.)
 */
class ServerState {
  dirty = new Set();
  loaded = undefined;
  options = { ...DEFAULT_OPTIONS };
  shutdown = false;

  /** What a request or notification changes, as the server does when it receives it. */
  apply(message) {
    const { method, params } = message;
    const doc = documentOf(message);
    switch (method) {
      case 'initialize':
        this.options = processSettings(this.options, params?.initializationOptions);
        return;
      case 'shutdown':
        this.shutdown = true;
        return;
      case 'workspace/didChangeConfiguration':
        this.options = processSettings(this.options, params?.settings);
        return;
      case 'textDocument/didOpen':
        this.loaded = doc;
        return;
      case 'textDocument/didChange':
        this.dirty.add(doc);
        return;
      case 'textDocument/didSave':
        this.dirty.delete(doc);
        this.loaded = doc;
        return;
      case 'textDocument/didClose':
        this.dirty.delete(doc);
        this.loaded = undefined;
        return;
      default:
        if (doc !== undefined && !this.dirty.has(doc) && (LOADING.has(method) || method === 'workspace/executeCommand')) {
          this.loaded = doc;
        }
    }
  }

  /** Whether the server loads the document of `message` before it answers (`loadIfNeeded`): it is not the file loaded last. */
  reloads(message) {
    const doc = documentOf(message);
    return isRequest(message) && doc !== undefined && LOADING.has(message.method) && doc !== this.loaded;
  }

  /**
   * The conditions under which a request is answered now (README, "Matching"): whether its document
   * is dirty, the options, and for a command about no document the file loaded last. A notification
   * has none: `didOpen` and `didSave` load the file whatever the state was.
   */
  conditions(message) {
    if (!isRequest(message)) {
      return '{}';
    }
    const doc = documentOf(message);
    return JSON.stringify({
      dirty: doc === undefined ? null : this.dirty.has(doc),
      options: this.options,
      loaded: doc === undefined ? (this.loaded ?? null) : null,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------------------------

/**
 * The recorded client messages of `transcript`, each with its key, its conditions, the fixture files
 * as they were on disk when the server received it (`meta.fixtures`, changed by the `fs` events
 * before it), and the group of server output that followed it up to the next client request or
 * notification: messages, unframed stdout bytes and stderr lines, in the recorded order (the order
 * of stderr lines among stdout messages is not reproducible, README "Reproducibility").
 */
function recordedSteps(transcript, places) {
  const steps = [];
  const state = new ServerState();
  const files = new Map(Object.entries(transcript.meta.fixtures ?? {}));
  let current;
  transcript.events.forEach((event, i) => {
    const line = i + 2;
    switch (event.kind) {
      case 'send': {
        const message = JSON.parse(substitute(event.text, places, true));
        if (!isRequest(message) && !isNotification(message)) {
          return; // the recorder's answer to a server request
        }
        current = {
          scenario: transcript.name,
          line,
          message,
          key: keyOf(message),
          conditions: state.conditions(message),
          reload: state.reloads(message),
          files: new Map(files),
          group: [],
        };
        state.apply(message);
        steps.push(current);
        return;
      }
      case 'recv':
        current?.group.push({ kind: 'message', message: JSON.parse(substitute(event.text, places, true)) });
        return;
      case 'unframed':
      case 'stderr':
        current?.group.push({ kind: event.kind, text: substitute(event.text, places, false) });
        return;
      case 'fs':
        files.set(event.file, event.action === 'write' ? event.sha256 : null);
        return;
      default:
        return; // exit, files
    }
  });
  return steps;
}

/** The SHA-256 of `file` in hex, or `null` when it does not exist. */
function sha256Of(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * A session's replay: `receive(message)` updates the server state and returns what the server
 * writes in answer, as `{ replay, output }`; `replay` names the recording that answered
 * (`<scenario>:<line>`, the line of the client message in its `.jsonl`), or is `unrecorded`, or
 * `null` for a message that is not matched; `output` is a list of `{ kind: 'message', message }`,
 * `{ kind: 'unframed', text }` and `{ kind: 'stderr', text }` with this session's ids and paths.
 */
export class Replayer {
  /**
   * `transcripts`: `readTranscripts`; `root`: the server's working directory, which stands for
   * `${ROOT}` in every recording (the recorder started the server in its copy of `meta.workspace`);
   * `home`: for `${HOME}`.
   */
  constructor(transcripts, { root, home }) {
    this.root = root;
    const all = transcripts.flatMap((transcript) => recordedSteps(transcript, { root, home }));
    /** The steps a message can be matched with, in order of scenario and line. */
    this.steps = all.filter((step) => step.key !== undefined);
    // Every recording starts with the same `initialize` answer (the capabilities do not depend on
    // the options or the workspace, `serverCapabilities`); the first one answers every session.
    const initialize = all.find((step) => step.message.method === 'initialize');
    const response = initialize?.group.find((item) => item.kind === 'message' && item.message.id === initialize.message.id);
    if (response === undefined) {
      throw new Error('no transcript has the response to initialize');
    }
    this.initializeAnswer = response.message;
    this.state = new ServerState();
    this.nextServerRequestId = 0;
  }

  /** A recorded step applies only while the files it was recorded against are on disk as they were then. */
  eligible(step) {
    for (const [file, sha] of step.files) {
      if (sha256Of(path.join(this.root, file)) !== sha) {
        return false;
      }
    }
    return true;
  }

  /**
   * The recorded step that answers `message` now, if any (README, "Matching"): one with the same key
   * and conditions that is eligible — preferably one recorded when the server loaded the document
   * first exactly when it does now (the load publishes the file's diagnostics again), then the first
   * by scenario and line.
   */
  match(message) {
    const key = keyOf(message);
    if (key === undefined) {
      return undefined;
    }
    const conditions = this.state.conditions(message);
    const reload = this.state.reloads(message);
    const candidates = this.steps.filter((step) => step.key === key && step.conditions === conditions && this.eligible(step));
    return candidates.find((step) => step.reload === reload) ?? candidates[0];
  }

  /** The recorded group of `step`, with `id`'s response re-addressed and the server's requests numbered for this session. */
  replayGroup(step, id) {
    return step.group.map((item) => {
      if (item.kind !== 'message') {
        return item;
      }
      const { message } = item;
      if (step.message.id !== undefined && message.method === undefined && message.id === step.message.id) {
        return { kind: 'message', message: { ...message, id } };
      }
      if (isRequest(message)) {
        return { kind: 'message', message: { ...message, id: this.nextServerRequestId++ } };
      }
      return item;
    });
  }

  receive(message) {
    if (!isRequest(message) && !isNotification(message)) {
      return { replay: null, output: [] }; // a response to one of the server's requests
    }
    if (message.method === 'initialize') {
      this.state.apply(message);
      return { replay: 'initialize', output: [{ kind: 'message', message: { ...this.initializeAnswer, id: message.id } }] };
    }
    if (message.method === 'shutdown') {
      this.state.apply(message);
      return { replay: 'shutdown', output: [{ kind: 'message', message: { jsonrpc: '2.0', id: message.id, result: null } }] };
    }
    const step = this.match(message);
    this.state.apply(message);
    if (step !== undefined) {
      return { replay: `${step.scenario}:${step.line}`, output: this.replayGroup(step, message.id) };
    }
    if (isNotification(message)) {
      return { replay: keyOf(message) === undefined ? null : 'unrecorded', output: [] };
    }
    return { replay: 'unrecorded', output: [{ kind: 'message', message: unrecordedAnswer(message) }] };
  }

  /** The exit code `exit` ends the process with now. */
  get exitCode() {
    return this.state.shutdown ? 0 : 1;
  }
}

/**
 * The answer to a request no recording matches (README, "No recording"): `null` for a request about
 * a document, which is the real server's answer in several states (a dirty file, no name at the
 * position) and keeps VS Code's automatic requests (symbols, highlights, code actions at the cursor)
 * from failing; an error naming the request otherwise, so that a command a test sends without a
 * recording fails loudly. Not server behaviour.
 */
function unrecordedAnswer(message) {
  const { method, id } = message;
  if (AT_POSITION.has(method) || WHOLE_DOCUMENT.has(method) || method === 'textDocument/codeAction') {
    return { jsonrpc: '2.0', id, result: null };
  }
  if (method === 'workspace/executeCommand' && COMMANDS.has(message.params?.command)) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: `fake-idris2-lsp: no recorded reply for ${keyOf(message)}` } };
  }
  // lsp-lib's `methodNotFound`, which the server answers for every other request (its last
  // `handleRequest` clause, Server/ProcessMessage.idr 547–549; commands-clean.jsonl, an unknown command).
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not implemented yet', data: null } };
}
