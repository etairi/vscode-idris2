// backend/lsp/commands.ts: Restart, Stop and Show Output over the client, and the developer command
// Send Raw LSP executeCommand — offered only under idris2.trace.protocol in a trusted workspace, its
// text typed by the user (an argument only under the test runner), its answer written to the
// output channel. No `vscode`: the API and the client are fakes.
import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  parseRawCommand,
  registerLanguageServerCommands,
  RESTART_LANGUAGE_SERVER_COMMAND,
  SEND_RAW_LSP_COMMAND,
  SHOW_LANGUAGE_SERVER_OUTPUT_COMMAND,
  STOP_LANGUAGE_SERVER_COMMAND,
  type LanguageServerCommandsApi,
  type LanguageServerCommandsDeps,
} from '../../src/backend/lsp/commands';
import { Emitter } from '../../src/core/event';
import { FakeDocument, quietLog } from './support/intelligence';

class Fixture {
  readonly commands = new Map<string, (...args: unknown[]) => unknown>();
  readonly messages: string[] = [];
  readonly calls: string[] = [];
  readonly output: string[] = [];
  readonly inputs: unknown[] = [];
  typed: string | undefined = 'metavars';
  trace = true;
  trusted = true;
  active: FakeDocument | undefined = new FakeDocument('/w/proj/src/A.idr', 'module A\n');
  answer: () => Promise<unknown> = async () => [];

  constructor(acceptArgument = false) {
    const message = (text: string): Promise<undefined> => {
      this.messages.push(text);
      return Promise.resolve(undefined);
    };
    const api = {
      commands: {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
          this.commands.set(id, handler);
          return { dispose: () => this.commands.delete(id) };
        },
      },
      window: {
        showInformationMessage: message,
        showWarningMessage: message,
        showInputBox: (options: unknown) => {
          this.inputs.push(options);
          return Promise.resolve(this.typed);
        },
        get activeTextEditor() {
          return fixture.active === undefined ? undefined : { document: fixture.active };
        },
      },
    } as unknown as LanguageServerCommandsApi;
    const fixture = this;
    const deps: LanguageServerCommandsDeps = {
      client: {
        restart: async () => void this.calls.push('restart'),
        stop: async () => void this.calls.push('stop'),
        showOutput: () => void this.calls.push('showOutput'),
        writeOutput: (line: string) => void this.output.push(line),
        rawExecuteCommand: async (about: vscode.Uri, command: string, args: readonly unknown[]) => {
          this.calls.push(`raw ${about.toString()} ${command} ${JSON.stringify(args)}`);
          return this.answer();
        },
      },
      config: { trace: () => ({ protocol: this.trace }) } as unknown as LanguageServerCommandsDeps['config'],
      trust: {
        get isTrusted() {
          return fixture.trusted;
        },
        onDidGrant: new Emitter<void>().event,
      },
      acceptArgument,
      log: quietLog,
    };
    registerLanguageServerCommands(api, deps);
  }

  run(id: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.commands.get(id);
    assert.ok(handler, id);
    return Promise.resolve(handler(...args));
  }
}

suite('backend/lsp/commands', () => {
  test('Restart, Stop and Show Output act on the client; Restart in Restricted Mode says why it does nothing', async () => {
    const f = new Fixture();
    await f.run(RESTART_LANGUAGE_SERVER_COMMAND);
    await f.run(STOP_LANGUAGE_SERVER_COMMAND);
    await f.run(SHOW_LANGUAGE_SERVER_OUTPUT_COMMAND);
    assert.deepStrictEqual(f.calls, ['restart', 'stop', 'showOutput']);
    f.trusted = false;
    await f.run(RESTART_LANGUAGE_SERVER_COMMAND);
    assert.deepStrictEqual(f.calls, ['restart', 'stop', 'showOutput']);
    assert.match(f.messages[0], /Restricted Mode/);
  });

  test('a raw command is sent as typed, about the active document, and its answer written to the output', async () => {
    const f = new Fixture();
    f.typed = 'repl [":t id"]';
    f.answer = async () => 'Prelude.id : a -> a‮';
    await f.run(SEND_RAW_LSP_COMMAND);
    assert.deepStrictEqual(f.calls, ['showOutput', 'raw file:///w/proj/src/A.idr repl [":t id"]']);
    assert.deepStrictEqual(f.output, ['Send Raw LSP executeCommand repl: "Prelude.id : a -> a\\u{202E}"']);
  });

  test('not offered without idris2.trace.protocol, in Restricted Mode, or without an Idris file; nothing is sent', async () => {
    for (const change of [(f: Fixture) => (f.trace = false), (f: Fixture) => (f.trusted = false), (f: Fixture) => (f.active = undefined)]) {
      const f = new Fixture();
      change(f);
      await f.run(SEND_RAW_LSP_COMMAND);
      assert.deepStrictEqual(f.calls, []);
      assert.strictEqual(f.inputs.length, 0);
      assert.strictEqual(f.messages.length, 1);
    }
  });

  test('an argument is taken only under the test runner; otherwise the text is typed into the input box', async () => {
    const f = new Fixture(false);
    f.typed = undefined;
    await f.run(SEND_RAW_LSP_COMMAND, 'repl [":sh touch x"]');
    assert.strictEqual(f.inputs.length, 1);
    assert.deepStrictEqual(f.calls, []);
    const test = new Fixture(true);
    await test.run(SEND_RAW_LSP_COMMAND, 'metavars');
    assert.strictEqual(test.inputs.length, 0);
    assert.deepStrictEqual(test.calls, ['showOutput', 'raw file:///w/proj/src/A.idr metavars []']);
  });

  test('a failure is written to the output and shown as plain text', async () => {
    const f = new Fixture();
    f.answer = () => Promise.reject(new Error('[x](command:evil)'));
    await f.run(SEND_RAW_LSP_COMMAND);
    assert.deepStrictEqual(f.output, ['Send Raw LSP executeCommand metavars failed: [x](command:evil)']);
    assert.strictEqual(f.messages[0], 'Idris 2: the raw command failed: [x]​(command:evil)');
  });

  test('the typed text: a command, then optionally a JSON array of arguments', () => {
    assert.deepStrictEqual(parseRawCommand('  metavars '), { command: 'metavars', args: [] });
    assert.deepStrictEqual(parseRawCommand('repl ["1 + 1"]'), { command: 'repl', args: ['1 + 1'] });
    assert.ok('problem' in parseRawCommand(''));
    assert.ok('problem' in parseRawCommand('repl 1 + 1'));
    assert.ok('problem' in parseRawCommand('repl {"a": 1}'));
  });
});
