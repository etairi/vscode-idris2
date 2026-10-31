// features/repl (ROADMAP M8): the REPL's command line and the text typed into it (launch.ts), the
// `-- >>>` lines and their answers (docEval.ts), and the commands against fakes of the `vscode` parts
// they use: the checks before a terminal starts, one terminal per root, what is typed, `:r` on save,
// the lenses with Run all's question, and Query…. Evaluations are answered by hand here; the recorded
// answers are `eval-query`'s (protocolTranscripts.test.ts, replCommand.test.ts).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { Evaluation } from '../../src/backend/types';
import type { SaveBeforeAction } from '../../src/core/config';
import { unsupported } from '../../src/core/errors';
import { Emitter } from '../../src/core/event';
import type { GateVerdict } from '../../src/core/trust';
import type { EvaluationRun } from '../../src/features/eval/register';
import { answerLines, answerReplacement, docEvalLines } from '../../src/features/repl/docEval';
import { replLaunch, replLine, replTerminalName } from '../../src/features/repl/launch';
import { nameAtEnd } from '../../src/features/repl/query';
import { OPEN_REPL_COMMAND, QUERY_COMMAND, registerRepl, REPL_DOCS_COMMAND, REPL_TYPE_COMMAND, RUN_ALL_DOC_EVAL_COMMAND, RUN_DOC_EVAL_COMMAND, SEND_TO_REPL_COMMAND, type ReplApi } from '../../src/features/repl/register';
import type { ReplDeps } from '../../src/features/repl/types';
import type { Classification } from '../../src/project/types';
import { repoRoot } from '../fake-tools/paths';
import { FakeEditingApi, FakeRange, FakeTextDoc } from './support/editingFakes';
import { recordingLog } from './support/fakeTransport';

const fixture = (name: string): string => fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', 'broken', name), 'utf8');
const PROJECT = { kind: 'project', dir: '/w/pkg', ipkgPath: '/w/pkg/pkg.ipkg' } as unknown as Classification;
const LOOSE = { kind: 'loose', dir: '/w/loose' } as unknown as Classification;
const value = (text: string): Evaluation => ({ kind: 'value', value: { text, spans: [] } });
const wrong = (text: string): Evaluation => ({ kind: 'error', message: { text, spans: [] } });
const answer = (evaluation: Evaluation): EvaluationRun => ({ kind: 'answer', evaluation });

suite('features/repl: the command line and what is typed (launch.ts)', () => {
  const settings = { loosePackages: ['contrib'], extraArgs: ['--no-color'] };
  const base = { idris2: '/opt/idris2', cwd: '/real', settings, env: { A: '1' } };

  test('a project: the file with its package (`:r` works, the prompt is the file\'s module); a loose file: its packages', () => {
    assert.deepStrictEqual(replLaunch({ ...base, root: PROJECT, relativeFile: 'src/Foo/B.idr' }), {
      executable: '/opt/idris2',
      args: ['--find-ipkg', '--no-color', 'src/Foo/B.idr'],
      cwd: '/real',
      env: { A: '1' },
    });
    assert.deepStrictEqual(replLaunch({ ...base, root: LOOSE, relativeFile: 'Main.idr' }).args, ['-p', 'contrib', '--no-color', 'Main.idr']);
  });

  test('rlwrap, when found, runs the compiler', () => {
    const launch = replLaunch({ ...base, root: LOOSE, relativeFile: 'Main.idr', rlwrap: '/opt/rlwrap' });
    assert.strictEqual(launch.executable, '/opt/rlwrap');
    assert.deepStrictEqual(launch.args, ['/opt/idris2', '-p', 'contrib', '--no-color', 'Main.idr']);
  });

  test('the terminal names the folder: a window can have one per project', () => {
    assert.strictEqual(replTerminalName(PROJECT), 'Idris 2 REPL: pkg');
  });

  test('what is typed is one line: line breaks become spaces, so that text cannot run a second command', () => {
    assert.deepStrictEqual(replLine('double 2'), { kind: 'line', text: 'double 2' });
    assert.deepStrictEqual(replLine('  a\n    b\r\n\tc  '), { kind: 'line', text: 'a b c' });
    assert.deepStrictEqual(replLine('x\u2028:exec main\u2029y\vz\fw\u0085v'), { kind: 'line', text: 'x :exec main y z w v' });
    assert.deepStrictEqual(replLine('a\tb'), { kind: 'line', text: 'a b' });
    assert.deepStrictEqual(replLine(' \n\t '), { kind: 'empty' });
  });

  test('a line past what a terminal\'s line discipline holds is not typed: it would never arrive, and the REPL would be stuck (review 1, M16)', () => {
    assert.strictEqual(replLine('x'.repeat(1000)).kind, 'line');
    assert.deepStrictEqual(replLine('x'.repeat(1001)), { kind: 'long' });
    assert.deepStrictEqual(replLine('€'.repeat(400)), { kind: 'long' }, 'counted in bytes');
  });

  test('a control character is not typed: it would act on the terminal, not be text', () => {
    for (const text of ['a\u0003', '\u0004', 'a\u001b[A', 'x\u007f', 'x\u0080', 'x\u009b']) {
      assert.deepStrictEqual(replLine(text), { kind: 'control' }, JSON.stringify(text));
    }
  });
});

suite('features/repl: the -- >>> lines (docEval.ts)', () => {
  const doc = new FakeTextDoc({ fileName: '/w/DocEval.idr', text: fixture('DocEval.idr') });

  test('line comments of their own: not three dashes, not in a block comment or a string', () => {
    assert.deepStrictEqual(docEvalLines(doc).map((l) => l.text), ['double 2', 'the (List Nat) [1, 2]', ':t double', ':doc double', 'doesNotExist', ':exec main']);
    assert.deepStrictEqual(docEvalLines(doc).map((l) => doc.lineAt(l.line).text.slice(0, 7)), Array(6).fill('-- >>> '));
  });

  test('a comment after code is none; indentation and spacing are kept; trailing white space is not part of the text', () => {
    const text = 'f : Nat\nf = 1 -- >>> no\n  -- >>> indented  \n--   >>>   spaced\n-- >>>\n-- >>>x\n';
    const lines = docEvalLines(new FakeTextDoc({ fileName: '/w/A.idr', text }));
    assert.deepStrictEqual(lines.map((l) => [l.line, l.text, l.prefix]), [[2, 'indented', '  '], [3, 'spaced', '']]);
  });

  test('a bird-track line keeps its marker; prose has none; a style the lexer does not read has none', () => {
    const lit = new FakeTextDoc({ fileName: '/w/L.lidr', text: '-- >>> prose\n\n> f : Nat\n> f = 1\n> -- >>> f\n' });
    assert.deepStrictEqual(docEvalLines(lit).map((l) => [l.line, l.text, l.prefix]), [[4, 'f', '> ']]);
    assert.deepStrictEqual(docEvalLines(new FakeTextDoc({ fileName: '/w/F.idr.md', text: '```idris\n-- >>> f\n```', languageId: 'markdown' })), []);
  });

  test('the answer beneath the line; a further line of it is marked; it stays a comment whatever it says', () => {
    const [line] = docEvalLines(new FakeTextDoc({ fileName: '/w/A.idr', text: '  -- >>> f\n' }));
    assert.deepStrictEqual(answerLines(line, '2'), ['  -- f = 2']);
    assert.deepStrictEqual(answerLines(line, 'a\n  b\r\nc\u2028main = rm\n'), ['  -- f = a', '  -- >   b', '  -- > c', '  -- > main = rm']);
    assert.deepStrictEqual(answerLines(line, 'a\u202eb\u0007'), ['  -- f = a\\u{202E}b\\u{7}']);
  });

  test('written beneath; run again, over the answer before it, its further lines too, and nothing else', () => {
    const text = 'x : Nat\nx = 1\n-- >>> x\n-- x = 1\n-- > more\n-- >\n-- other\n';
    const d = new FakeTextDoc({ fileName: '/w/A.idr', text });
    const [line] = docEvalLines(d);
    assert.deepStrictEqual(answerReplacement(d, line, '2'), { range: { start: { line: 3, character: 0 }, end: { line: 5, character: 4 } }, text: '-- x = 2' });
    const fresh = new FakeTextDoc({ fileName: '/w/A.idr', text: 'x = 1\n-- >>> x\n-- y = 1\n' });
    assert.deepStrictEqual(answerReplacement(fresh, docEvalLines(fresh)[0], '2'), { range: { start: { line: 1, character: 8 }, end: { line: 1, character: 8 } }, text: '\n-- x = 2' });
  });

  test('comments below an answer are kept, indented ones too (review 1, H6)', () => {
    const d = new FakeTextDoc({ fileName: '/w/A.idr', text: 'x = 1\n-- >>> x\n-- x = 1\n--   note: do not remove this\n--   see the proof\nf : Nat\n' });
    assert.deepStrictEqual(answerReplacement(d, docEvalLines(d)[0], '2'), { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } }, text: '-- x = 2' });
  });

  test('a line of an answer is never read back as a -- >>> line, whatever it says (review 1, M14)', () => {
    const [line] = docEvalLines(new FakeTextDoc({ fileName: '/w/A.idr', text: '-- >>> f\n' }));
    const lines = answerLines(line, 'a\n>>> x\n  >>> y');
    const written = new FakeTextDoc({ fileName: '/w/A.idr', text: `-- >>> f\n${lines.join('\n')}\n` });
    assert.deepStrictEqual(docEvalLines(written).map((l) => l.text), ['f']);
  });

  test('a blank line of an answer has no white space a save could trim; so a re-run finds all of it, and a blank answer too (review 1, M15)', () => {
    const [line] = docEvalLines(new FakeTextDoc({ fileName: '/w/A.idr', text: '-- >>> f\n' }));
    const lines = answerLines(line, 'a\n\nb');
    assert.deepStrictEqual(lines, ['-- f = a', '-- >', '-- > b']);
    assert.ok(lines.every((l) => l === l.trimEnd()));
    const d = new FakeTextDoc({ fileName: '/w/A.idr', text: `-- >>> f\n${lines.join('\n')}\nnext\n` });
    assert.deepStrictEqual(answerReplacement(d, docEvalLines(d)[0], 'z').range, { start: { line: 1, character: 0 }, end: { line: 3, character: 6 } });
    assert.deepStrictEqual(answerLines(line, ''), ['-- f =']);
    const blank = new FakeTextDoc({ fileName: '/w/A.idr', text: '-- >>> f\n-- f =\n' });
    assert.deepStrictEqual(answerReplacement(blank, docEvalLines(blank)[0], 'z').range, { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } });
  });

  test('on the last line of a file, without a line break', () => {
    const d = new FakeTextDoc({ fileName: '/w/A.idr', text: 'x = 1\n-- >>> x' });
    assert.deepStrictEqual(answerReplacement(d, docEvalLines(d)[0], '1').text, '\n-- x = 1');
  });
});

class FakeTerminal {
  readonly sent: string[] = [];
  shown: (boolean | undefined)[] = [];
  disposed = false;
  exitStatus: { code: number } | undefined;
  constructor(readonly options: { name: string; shellPath: string; shellArgs: string[]; cwd: string; env: Record<string, string>; isTransient: boolean }) {}
  sendText(text: string, execute: boolean): void {
    this.sent.push(`${text}${execute ? '⏎' : ''}`);
  }
  show(preserveFocus?: boolean): void {
    this.shown.push(preserveFocus);
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeQuickPick {
  items: { label: string; name?: string; description?: string }[] = [];
  activeItems: { label: string; name?: string }[] = [];
  value = '';
  title = '';
  placeholder = '';
  ignoreFocusOut = false;
  disposed = false;
  private readonly changed = new Emitter<string>();
  private readonly accepted = new Emitter<void>();
  private readonly hidden = new Emitter<void>();
  readonly onDidChangeValue = this.changed.event;
  readonly onDidAccept = this.accepted.event;
  readonly onDidHide = this.hidden.event;
  show(): void {}
  hide(): void {
    this.hidden.fire();
  }
  dispose(): void {
    this.disposed = true;
  }
  /** Types `value`, as the user does. */
  type(value: string): void {
    this.value = value;
    this.changed.fire(value);
  }
  /** Accepts the item at `index` (none: the first). */
  accept(index = 0): void {
    this.activeItems = this.items.slice(index, index + 1);
    this.accepted.fire();
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function setup(options: { root?: Classification; trusted?: boolean; file?: string; text?: string; files?: readonly string[]; path?: string; gate?: { permit?: GateVerdict; recheck?: GateVerdict | undefined }; startProblem?: Error; findPackage?: (dir: string) => string | undefined; ideMode?: { loosePackages?: string[]; extraArgs?: string[] } } = {}) {
  const api = new FakeEditingApi();
  const window = api.window as unknown as Record<string, unknown>;
  const closed = new Emitter<FakeTerminal>();
  const terminals: FakeTerminal[] = [];
  window.createTerminal = (terminalOptions: FakeTerminal['options']) => {
    const terminal = new FakeTerminal(terminalOptions);
    terminals.push(terminal);
    return terminal;
  };
  window.onDidCloseTerminal = closed.event;
  const channel: string[] = [];
  const shownChannels: boolean[] = [];
  window.createOutputChannel = () => ({ appendLine: (line: string) => channel.push(line), show: (keep: boolean) => shownChannels.push(keep), dispose: () => undefined });
  const picks: FakeQuickPick[] = [];
  window.createQuickPick = () => {
    const pick = new FakeQuickPick();
    picks.push(pick);
    return pick;
  };
  const warnings: { text: string; items: unknown[] }[] = [];
  let choice: string | undefined;
  window.showWarningMessage = (text: string, ...items: unknown[]) => {
    warnings.push({ text, items });
    return Promise.resolve(items.length > 0 ? choice : undefined);
  };
  const saved = new Emitter<FakeTextDoc>();
  (api.workspace as unknown as Record<string, unknown>).onDidSaveTextDocument = saved.event;
  let provider: { provideCodeLenses(doc: unknown): { range: FakeRange; command: { title: string; command: string; arguments?: unknown[] } }[]; onDidChangeCodeLenses: (listener: () => void) => { dispose(): void } } | undefined;
  (api.languages as unknown as Record<string, unknown>).registerCodeLensProvider = (_selector: unknown, given: typeof provider) => {
    provider = given;
    return { dispose: () => undefined };
  };
  (api as unknown as Record<string, unknown>).CodeLens = class {
    constructor(
      readonly range: unknown,
      readonly command: unknown,
    ) {}
  };

  const root = options.root ?? PROJECT;
  const asked: string[] = [];
  const reasons: unknown[] = [];
  const allowed: GateVerdict = { allowed: true, basis: 'workspaceFolder' };
  const evaluations: { text: string; options: unknown }[] = [];
  const answers: ((text: string) => EvaluationRun | Promise<EvaluationRun>)[] = [];
  const completions: string[] = [];
  const settings = { reloadOnSave: false };
  const savePolicy: { value: SaveBeforeAction } = { value: 'always' };
  const grant = new Emitter<void>();
  const stats = new Set(options.files ?? []);
  let startProblem = options.startProblem;
  const starts = { count: 0 };
  const deps: ReplDeps = {
    projects: {
      classify: (file: string) => Promise.resolve(file.startsWith('/other/') ? ({ kind: 'loose', dir: '/other' } as unknown as Classification) : root),
      sessionCwd: (r: Classification) => r.dir,
    },
    toolchain: {
      current: { settings: { env: { FROM_SETTINGS: '1' } }, idris2: { status: 'probed', location: { path: '/opt/idris2' } } } as never,
    },
    config: { ideMode: () => ({ loosePackages: ['contrib'], extraArgs: [], ...options.ideMode }) as never, repl: () => settings, saveBeforeAction: () => savePolicy.value },
    trust: { isTrusted: options.trusted ?? true, onDidGrant: grant.event },
    gate: {
      permit: (dir: string, why?: unknown) => {
        asked.push(`permit ${dir}`);
        reasons.push(why);
        return Promise.resolve(options.gate?.permit ?? allowed);
      },
      recheck: (dir: string) => {
        asked.push(`recheck ${dir}`);
        return Promise.resolve(options.gate !== undefined && 'recheck' in options.gate ? options.gate.recheck : { ...allowed, realDir: `/real${dir}` });
      },
      current: () => undefined,
      onDidChange: new Emitter<void>().event,
    },
    startProblem: () => {
      starts.count++;
      return Promise.resolve(startProblem as never);
    },
    findPackage: (dir: string) => Promise.resolve(options.findPackage === undefined ? `${dir}/pkg.ipkg` : options.findPackage(dir)),
    fileSystem: { stat: (file: string) => Promise.resolve(stats.has(file) ? { kind: 'file', executable: true } : undefined) },
    processEnv: { PATH: options.path ?? 'relative:/usr/bin:/opt/bin' },
    platform: 'darwin',
    evaluation: {
      run: (_doc, text, runOptions) => {
        evaluations.push({ text, options: runOptions });
        const next = answers.shift();
        return Promise.resolve(next === undefined ? answer(value(`value of ${text}`)) : next(text));
      },
    },
    queries: {
      run: <T>(_doc: unknown, _mode: unknown, query: (backend: never) => Promise<T>) =>
        query({ completions: (_d: unknown, prefix: string) => Promise.resolve(completions.filter((name) => name.startsWith(prefix))) } as never).then((v) => ({ kind: 'answer' as const, value: v })),
    },
    registry: { backendFor: () => ({}) as never },
    log: recordingLog(),
  };
  const registration = registerRepl(api as unknown as ReplApi, deps);
  const doc = api.workspace.open(new FakeTextDoc({ fileName: options.file ?? '/w/pkg/src/Main.idr', text: options.text ?? fixture('DocEval.idr') }));
  const select = (startLine: number, startCharacter: number, endLine = startLine, endCharacter = startCharacter): void => {
    const range = new FakeRange(startLine, startCharacter, endLine, endCharacter);
    api.window.activeTextEditor = {
      document: doc,
      selection: Object.assign(range, { isEmpty: startLine === endLine && startCharacter === endCharacter, active: range.end }),
    } as never;
  };
  select(0, 0);
  return {
    api,
    deps,
    doc,
    terminals,
    closed,
    saved,
    grant,
    select,
    asked,
    reasons,
    warnings,
    evaluations,
    answers,
    completions,
    settings,
    savePolicy,
    channel,
    shownChannels,
    picks,
    registration,
    starts,
    setChoice: (next: string | undefined) => {
      choice = next;
    },
    setProblem: (next: Error | undefined) => {
      startProblem = next;
    },
    lenses: () => provider?.provideCodeLenses(doc) ?? [],
    onLensesChanged: (listener: () => void) => provider?.onDidChangeCodeLenses(listener),
    messages: () => api.window.messages.map((m) => m.text),
  };
}

suite('features/repl: the terminal', () => {
  test('Open REPL: the checks, the consent gate twice, then a terminal in the real path judged, with the toolchain\'s environment', async () => {
    const t = setup();
    await t.api.run(OPEN_REPL_COMMAND);
    assert.deepStrictEqual(t.asked, ['permit /w/pkg', 'recheck /w/pkg']);
    assert.deepStrictEqual(t.reasons, [{ ipkg: '/w/pkg/pkg.ipkg' }]);
    assert.strictEqual(t.terminals.length, 1);
    assert.deepStrictEqual(t.terminals[0].options, {
      name: 'Idris 2 REPL: pkg',
      shellPath: '/opt/idris2',
      shellArgs: ['--find-ipkg', 'src/Main.idr'],
      cwd: '/real/w/pkg',
      env: { FROM_SETTINGS: '1' },
      isTransient: true,
    });
    assert.deepStrictEqual(t.terminals[0].shown, [undefined], 'the focus goes to it');
    assert.deepStrictEqual(t.registration.view.launches.map((l) => l.executable), ['/opt/idris2']);
  });

  test('nothing starts in Restricted Mode, and nobody is asked', async () => {
    const t = setup({ trusted: false });
    await t.api.run(OPEN_REPL_COMMAND);
    assert.deepStrictEqual([t.terminals.length, t.asked.length], [0, 0]);
    assert.match(t.messages()[0], /Restricted Mode/);
  });

  test('what keeps the compiler from starting is said, before the consent question', async () => {
    const t = setup({ startProblem: unsupported('No Idris 2 compiler to start') });
    await t.api.run(OPEN_REPL_COMMAND);
    assert.deepStrictEqual([t.terminals.length, t.asked.length], [0, 0]);
    assert.match(t.warnings[0].text, /No Idris 2 compiler to start/);
  });

  test('a folder refused, or revoked after the question: no terminal, and why', async () => {
    const refused = setup({ gate: { permit: { allowed: false, reason: 'denied' } } });
    await refused.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(refused.terminals.length, 0);
    assert.match(refused.warnings[0].text, /Don't Allow/);
    const revoked = setup({ gate: { recheck: undefined } });
    await revoked.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(revoked.terminals.length, 0);
    assert.match(revoked.warnings[0].text, /no longer allowed/);
  });

  test('a path the compiler would read otherwise, or as an option, starts nothing', async () => {
    for (const file of ['/w/pkg/a:b.idr', '/w/pkg/a?b.idr', '/w/pkg/-x.idr']) {
      const t = setup({ file });
      await t.api.run(OPEN_REPL_COMMAND);
      assert.strictEqual(t.terminals.length, 0, file);
      assert.match(t.warnings[0].text, /is not started on this file/, file);
    }
  });

  test('the compiler\'s own walk must find the root\'s package: a package file gone or another one starts nothing (review 1, H7)', async () => {
    for (const found of [undefined, '/real/w/pkg/other.ipkg', '/real/w/parent.ipkg']) {
      const t = setup({ findPackage: () => found });
      await t.api.run(OPEN_REPL_COMMAND);
      assert.strictEqual(t.terminals.length, 0, String(found));
      assert.match(t.warnings[0].text, /The REPL is not started: searching from \/real\/w\/pkg/, String(found));
    }
    const own = setup({ findPackage: (dir) => `${dir}/pkg.ipkg` });
    await own.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(own.terminals.length, 1);
    const loose = setup({ root: LOOSE, file: '/w/loose/Main.idr', findPackage: () => assert.fail('no walk: `idris2 <file>` uses no package') });
    await loose.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(loose.terminals.length, 1);
  });

  test('VS Code expands ${…} in a terminal\'s executable, arguments and directory, so what holds it is not started (review 1, H8)', async () => {
    const cases = [
      setup({ ideMode: { extraArgs: ['--ide-mode${env:UNSET}-socket'] } }),
      setup({ file: '/w/pkg/${workspaceFolder}.idr' }),
      setup({ root: { ...LOOSE, dir: '/w/d${env:X}' } as unknown as Classification, file: '/w/d${env:X}/Main.idr' }),
      setup({ root: LOOSE, file: '/w/loose/Main.idr', ideMode: { loosePackages: ['${pathSeparator}'] } }),
    ];
    for (const t of cases) {
      await t.api.run(OPEN_REPL_COMMAND);
      assert.strictEqual(t.terminals.length, 0);
      assert.match(t.warnings[0].text, /VS Code would expand/);
    }
  });

  test('what keeps the compiler from starting is asked again after the consent question, which can take long (review 1, M13)', async () => {
    const t = setup();
    const permit = t.deps.gate.permit.bind(t.deps.gate);
    t.deps.gate.permit = (dir, why) => {
      t.setProblem(unsupported('The Idris 2 compiler went away'));
      return permit(dir, why);
    };
    await t.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(t.terminals.length, 0);
    assert.strictEqual(t.starts.count, 2);
    assert.match(t.warnings[0].text, /went away/);
  });

  test('one terminal per root: a second command shows it, a closed or ended one is replaced, another root has its own', async () => {
    const t = setup();
    await Promise.all([t.api.run(OPEN_REPL_COMMAND), t.api.run(OPEN_REPL_COMMAND)]);
    assert.strictEqual(t.terminals.length, 1);
    assert.strictEqual(t.terminals[0].shown.length, 2);
    t.terminals[0].exitStatus = { code: 0 };
    await t.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(t.terminals.length, 2);
    t.closed.fire(t.terminals[1]);
    await t.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(t.terminals.length, 3);
    const other = t.api.workspace.open(new FakeTextDoc({ fileName: '/other/O.idr', text: 'x = 1' }));
    t.api.window.activeTextEditor = { document: other, selection: { active: { line: 0, character: 0 }, isEmpty: true } } as never;
    await t.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(t.terminals.length, 4);
    assert.strictEqual(t.terminals[3].options.cwd, '/real/other');
  });

  test('a loose file: its packages; rlwrap on PATH, not in a relative entry, runs it', async () => {
    const t = setup({ root: LOOSE, file: '/w/loose/Main.idr', files: ['relative/rlwrap', '/opt/bin/rlwrap'] });
    await t.api.run(OPEN_REPL_COMMAND);
    assert.strictEqual(t.terminals[0].options.shellPath, '/opt/bin/rlwrap');
    assert.deepStrictEqual(t.terminals[0].options.shellArgs, ['/opt/idris2', '-p', 'contrib', 'Main.idr']);
  });

  test('dispose closes the terminals', async () => {
    const t = setup();
    await t.api.run(OPEN_REPL_COMMAND);
    t.registration.dispose();
    assert.strictEqual(t.terminals[0].disposed, true);
  });

  test('Send to REPL opens it if needed, and leaves the focus in the editor: the selection, or the line', async () => {
    const t = setup();
    t.select(3, 0, 3, 6); // `double`
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.deepStrictEqual(t.terminals[0].sent, ['double⏎']);
    assert.deepStrictEqual(t.terminals[0].shown, [true]);
    t.select(4, 3);
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.deepStrictEqual(t.terminals[0].sent, ['double⏎', 'double n = n + n⏎']);
    assert.strictEqual(t.terminals.length, 1);
    assert.deepStrictEqual(t.registration.view.typed, ['double', 'double n = n + n']);
  });

  test('a selection over several lines is one line; a blank line sends nothing; a control character is not typed', async () => {
    const t = setup({ text: 'a\n  b\n\nc\u0003\n' });
    t.select(0, 0, 1, 3);
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.deepStrictEqual(t.terminals[0].sent, ['a b⏎']);
    t.select(2, 0);
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.strictEqual(t.terminals[0].sent.length, 1);
    t.select(3, 0, 3, 2);
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.strictEqual(t.terminals[0].sent.length, 1);
    assert.match(t.warnings[0].text, /control character/);
  });

  test('bird tracks are left out of what is typed; prose is not sent', async () => {
    const t = setup({ file: '/w/pkg/L.lidr', text: 'prose\n\n> f : Nat\n> f = 1\n' });
    t.select(3, 3);
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.deepStrictEqual(t.terminals[0].sent, ['f = 1⏎']);
    t.select(0, 2);
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.strictEqual(t.terminals[0].sent.length, 1);
    assert.match(t.messages()[0], /needs code/);
  });

  test(':t and :doc of the selection, or of the name at the cursor', async () => {
    const t = setup();
    t.select(3, 0, 3, 6);
    await t.api.run(REPL_TYPE_COMMAND);
    t.select(3, 2);
    await t.api.run(REPL_DOCS_COMMAND);
    assert.deepStrictEqual(t.terminals[0].sent, [':t double⏎', ':doc double⏎']);
    t.select(1, 0);
    await t.api.run(REPL_TYPE_COMMAND);
    assert.strictEqual(t.terminals[0].sent.length, 2);
  });

  test('without an Idris file, or a file on disk: says so', async () => {
    const t = setup();
    t.api.window.activeTextEditor = undefined;
    await t.api.run(OPEN_REPL_COMMAND);
    assert.match(t.messages()[0], /Open REPL needs an Idris file/);
    const untitled = t.api.workspace.open(new FakeTextDoc({ fileName: 'Untitled-1', text: 'x', scheme: 'untitled' }));
    t.api.window.activeTextEditor = { document: untitled, selection: { active: { line: 0, character: 0 } } } as never;
    await t.api.run(SEND_TO_REPL_COMMAND);
    assert.match(t.messages()[1], /needs a file saved on disk/);
    assert.strictEqual(t.terminals.length, 0);
  });

  test('reload on save: `:r` into the open REPL of the file\'s root; not when it is off, closed, another root\'s, or the file no Idris file', async () => {
    const t = setup();
    t.saved.fire(t.doc);
    await settle();
    await t.api.run(OPEN_REPL_COMMAND);
    t.saved.fire(t.doc);
    await settle();
    assert.deepStrictEqual(t.terminals[0].sent, [], 'the setting is off');
    t.settings.reloadOnSave = true;
    t.saved.fire(t.doc);
    await settle();
    assert.deepStrictEqual(t.terminals[0].sent, [':r⏎']);
    t.saved.fire(new FakeTextDoc({ fileName: '/other/O.idr', text: 'x' }));
    t.saved.fire(new FakeTextDoc({ fileName: '/w/pkg/notes.txt', text: 'x', languageId: 'plaintext' }));
    await settle();
    assert.strictEqual(t.terminals[0].sent.length, 1);
    t.closed.fire(t.terminals[0]);
    t.saved.fire(t.doc);
    await settle();
    assert.strictEqual(t.terminals[0].sent.length, 1);
  });
});

suite('features/repl: the -- >>> lenses', () => {
  const text = 'x : Nat\nx = 1\n\n-- >>> x\n-- >>> :t x\n';

  test('Run on each line, Run all once when there are several; none in Restricted Mode or a file not on disk; a grant refreshes them', () => {
    const t = setup({ text });
    assert.deepStrictEqual(t.lenses().map((l) => [l.command.title, l.command.command, l.command.arguments, l.range.start.line]), [
      ['Run', RUN_DOC_EVAL_COMMAND, [{ uri: t.doc.uri.toString(), line: 3 }], 3],
      ['Run all (2)', RUN_ALL_DOC_EVAL_COMMAND, undefined, 3],
      ['Run', RUN_DOC_EVAL_COMMAND, [{ uri: t.doc.uri.toString(), line: 4 }], 4],
    ]);
    assert.deepStrictEqual(setup({ text: '-- >>> x\n' }).lenses().map((l) => l.command.title), ['Run']);
    const untrusted = setup({ text, trusted: false });
    assert.deepStrictEqual(untrusted.lenses(), []);
    let fired = 0;
    untrusted.onLensesChanged(() => fired++);
    untrusted.grant.fire();
    assert.strictEqual(fired, 1);
  });

  test('Run evaluates the line as the file shows it, with :t and :doc allowed, and writes the answer beneath', async () => {
    const t = setup({ text });
    await t.api.run(RUN_DOC_EVAL_COMMAND, { uri: t.doc.uri.toString(), line: 3 });
    assert.deepStrictEqual(t.evaluations, [{ text: 'x', options: { queryCommands: true } }]);
    assert.strictEqual(t.doc.lineAt(4).text, '-- x = value of x');
    assert.strictEqual(t.api.workspace.edits.length, 1);
  });

  test('the compiler answers for the saved file: unsaved changes are saved first, or nothing runs under `never`', async () => {
    const t = setup({ text });
    t.doc.isDirty = true;
    await t.api.run(RUN_DOC_EVAL_COMMAND, { uri: t.doc.uri.toString(), line: 3 });
    assert.strictEqual(t.doc.saves, 1);
    assert.strictEqual(t.evaluations.length, 1);
    const never = setup({ text });
    never.doc.isDirty = true;
    never.savePolicy.value = 'never';
    never.setChoice('Run 2');
    await never.api.run(RUN_DOC_EVAL_COMMAND, { uri: never.doc.uri.toString(), line: 3 });
    await never.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.deepStrictEqual(never.evaluations, []);
    assert.deepStrictEqual([never.doc.saves, never.api.workspace.edits.length], [0, 0]);
    assert.match(never.messages()[0], /save/i);
  });

  test('an error of the compiler is shown, and nothing is written; a refusal or a failure says why; a cancellation says nothing', async () => {
    const cases: [EvaluationRun, RegExp | undefined][] = [
      [answer(wrong('Undefined name x')), /✗ Undefined name x/],
      [{ kind: 'refused', reason: 'Not run: of the REPL commands' }, /Not run: of the REPL commands/],
      [{ kind: 'failed', reason: 'does not load' }, /not evaluated: does not load/],
      [{ kind: 'cancelled', reason: 'cancelled' }, undefined],
    ];
    for (const [run, shown] of cases) {
      const t = setup({ text });
      t.answers.push(() => run);
      await t.api.run(RUN_DOC_EVAL_COMMAND, { uri: t.doc.uri.toString(), line: 3 });
      assert.strictEqual(t.api.workspace.edits.length, 0);
      const all = [...t.messages(), ...t.warnings.map((w) => w.text)];
      if (shown === undefined) {
        assert.deepStrictEqual(all, []);
      } else {
        assert.match(all[0], shown);
      }
    }
  });

  test('the file changed meanwhile: the answer is shown, not written; a line that is gone or was never one says so', async () => {
    const t = setup({ text });
    t.answers.push(() => {
      t.doc.version++;
      return answer(value('1'));
    });
    await t.api.run(RUN_DOC_EVAL_COMMAND, { uri: t.doc.uri.toString(), line: 3 });
    assert.strictEqual(t.api.workspace.edits.length, 0);
    assert.match(t.messages()[0], /x = 1 \(not written: the file changed meanwhile\)/);
    await t.api.run(RUN_DOC_EVAL_COMMAND, { uri: t.doc.uri.toString(), line: 0 });
    await t.api.run(RUN_DOC_EVAL_COMMAND, { uri: 'file:///nope', line: 3 });
    await t.api.run(RUN_DOC_EVAL_COMMAND);
    assert.deepStrictEqual(t.messages().slice(1), Array(3).fill('Idris 2: that -- >>> line is no longer there.'));
    assert.strictEqual(t.evaluations.length, 1);
  });

  test('Run all asks first, saying how many; declined, nothing is evaluated', async () => {
    const t = setup({ text });
    await t.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.match(t.warnings[0].text, /run the 2 -- >>> lines of this file\?/);
    assert.match(t.warnings[0].text, /compile-time code it reaches runs/);
    assert.deepStrictEqual(t.warnings[0].items, ['Run 2']);
    assert.deepStrictEqual(t.evaluations, []);
  });

  /** `lines` put at the top of the document, as an edit does. */
  const shift = (t: ReturnType<typeof setup>, ...lines: string[]): void => {
    t.doc.lines.unshift(...lines);
    t.doc.version++;
  };

  test('lines added while Run all\'s question is open: the answers go beneath their lines as they are now (review 1, H2)', async () => {
    const t = setup({ text });
    t.setChoice('Run 2');
    const ask = (t.api.window as unknown as { showWarningMessage: (text: string, ...items: unknown[]) => Promise<string | undefined> }).showWarningMessage;
    (t.api.window as unknown as Record<string, unknown>).showWarningMessage = (message: string, ...items: unknown[]) => {
      shift(t, '-- one', '-- two');
      return ask(message, ...items);
    };
    await t.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.deepStrictEqual(t.doc.lines.slice(5), ['-- >>> x', '-- x = value of x', '-- >>> :t x', '-- :t x = value of :t x', '']);
  });

  test('the lines themselves changed while Run all asked: what was agreed to is not what is there, so nothing runs (review 1, H2)', async () => {
    const t = setup({ text });
    t.setChoice('Run 2');
    const ask = (t.api.window as unknown as { showWarningMessage: (text: string, ...items: unknown[]) => Promise<string | undefined> }).showWarningMessage;
    (t.api.window as unknown as Record<string, unknown>).showWarningMessage = (message: string, ...items: unknown[]) => {
      t.doc.lines[3] = '-- >>> :t y';
      t.doc.version++;
      return ask(message, ...items);
    };
    await t.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.deepStrictEqual(t.evaluations, []);
    assert.match(t.messages()[0], /changed while you were asked/);
  });

  test('a save that moves the line (a formatter): Run answers beneath the line as it is now; one that removes it says so (review 1, H2)', async () => {
    const t = setup({ text });
    t.doc.isDirty = true;
    t.doc.onSave = () => shift(t, '-- formatted');
    await t.api.run(RUN_DOC_EVAL_COMMAND, { uri: t.doc.uri.toString(), line: 3 });
    assert.deepStrictEqual(t.doc.lines.slice(4, 6), ['-- >>> x', '-- x = value of x']);
    const gone = setup({ text });
    gone.doc.isDirty = true;
    gone.doc.onSave = () => {
      gone.doc.lines[3] = '-- formatted away';
      gone.doc.version++;
    };
    await gone.api.run(RUN_DOC_EVAL_COMMAND, { uri: gone.doc.uri.toString(), line: 3 });
    assert.deepStrictEqual(gone.evaluations, []);
    assert.match(gone.messages()[0], /no longer there/);
  });

  test('a file shortened during the run: the answers are shown, and nothing fails (review 1, H2)', async () => {
    const t = setup({ text });
    t.setChoice('Run 2');
    t.answers.push(() => {
      t.doc.lines = ['x = 1'];
      t.doc.version++;
      // As VS Code's, which the fake's is not.
      t.doc.lineAt = (line: number) => {
        assert.ok(line < t.doc.lines.length, 'Illegal value for `line`');
        return { text: t.doc.lines[line] };
      };
      return answer(value('1'));
    });
    await t.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.strictEqual(t.api.workspace.edits.length, 0);
    assert.ok(t.messages().some((m) => /not written: the file changed meanwhile/.test(m)), t.messages().join('|'));
    assert.deepStrictEqual(t.api.window.messages.filter((m) => m.severity === 'error'), []);
  });

  test('Run all, accepted: one at a time, in order, and all answers in one edit', async () => {
    const t = setup({ text });
    t.setChoice('Run 2');
    await t.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.deepStrictEqual(t.evaluations.map((e) => e.text), ['x', ':t x']);
    assert.strictEqual(t.api.workspace.edits.length, 1);
    assert.deepStrictEqual(t.doc.lines.slice(3), ['-- >>> x', '-- x = value of x', '-- >>> :t x', '-- :t x = value of :t x', '']);
  });

  test('Run all: lines without a value are counted, the others written; a cancellation stops it; no lines says so', async () => {
    const t = setup({ text });
    t.setChoice('Run 2');
    t.answers.push(() => answer(wrong('no')), () => answer(value('Nat')));
    await t.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.deepStrictEqual(t.doc.lines.slice(3), ['-- >>> x', '-- >>> :t x', '-- :t x = Nat', '']);
    assert.match(t.warnings[1].text, /1 of 2 -- >>> lines gave no value\. The first: x: ✗ no/);
    const stopped = setup({ text });
    stopped.setChoice('Run 2');
    stopped.answers.push(() => ({ kind: 'cancelled', reason: 'cancelled' }));
    await stopped.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.strictEqual(stopped.evaluations.length, 1);
    const none = setup({ text: 'x = 1\n' });
    await none.api.run(RUN_ALL_DOC_EVAL_COMMAND);
    assert.match(none.messages()[0], /has no -- >>> lines/);
  });
});

suite('features/repl: Query…', () => {
  test('nameAtEnd: what completion replaces', () => {
    assert.strictEqual(nameAtEnd(':t Data.Vect.len'), 'Data.Vect.len');
    assert.strictEqual(nameAtEnd('map (+1) xs'), 'xs');
    assert.strictEqual(nameAtEnd('foo '), '');
    assert.strictEqual(nameAtEnd(''), '');
  });

  const opened = async () => {
    const t = setup({ text: 'x = 1\n' });
    const running = t.api.run(QUERY_COMMAND);
    await settle();
    return { t, running, pick: t.picks[0] };
  };

  test('the first item runs what is typed, the others complete the name at its end', async () => {
    const { t, running, pick } = await opened();
    t.completions.push('vlen', 'vect', 'other');
    pick.type(':t v');
    await settle();
    assert.deepStrictEqual(pick.items.map((i) => [i.label, i.description, i.name]), [[':t v', 'Run', undefined], ['vlen', undefined, 'vlen'], ['vect', undefined, 'vect']]);
    pick.accept(2);
    await settle();
    assert.strictEqual(pick.value, ':t vect');
    assert.strictEqual(pick.disposed, false, 'it stays open');
    pick.accept(0);
    await running;
    assert.deepStrictEqual(t.evaluations, [{ text: ':t vect', options: { queryCommands: true } }]);
    assert.deepStrictEqual(t.channel, ['> :t vect', 'value of :t vect']);
    assert.deepStrictEqual(t.shownChannels, [true]);
    assert.strictEqual(pick.disposed, true);
  });

  test('completion replaces only the last part of a qualified name', async () => {
    const { t, running, pick } = await opened();
    t.completions.push('length');
    pick.type('Data.Vect.len');
    await settle();
    pick.accept(1);
    await settle();
    assert.strictEqual(pick.value, 'Data.Vect.length');
    pick.hide();
    await running;
  });

  test('a refusal is said and goes to no channel; an error of the compiler goes there; dismissed runs nothing; compiler text is made visible', async () => {
    const refused = await opened();
    refused.t.answers.push(() => ({ kind: 'refused', reason: 'Not run: of the REPL commands' }));
    refused.pick.type(':exec main');
    await settle();
    refused.pick.accept(0);
    await refused.running;
    assert.deepStrictEqual(refused.t.channel, []);
    assert.match(refused.t.messages()[0], /Not run: of the REPL commands/);
    const error = await opened();
    error.t.answers.push(() => answer(wrong('Undefined\u202e\n')));
    error.pick.type('nope');
    await settle();
    error.pick.accept(0);
    await error.running;
    assert.deepStrictEqual(error.t.channel, ['> nope', 'Undefined\\u{202E}']);
    const dismissed = await opened();
    dismissed.pick.type('x');
    dismissed.pick.hide();
    await dismissed.running;
    assert.deepStrictEqual(dismissed.t.evaluations, []);
  });
});

