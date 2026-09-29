import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Log } from '../../src/core/log';
import { createProcessRunner } from '../../src/core/process';
import {
  compilerReadsPathAsGiven,
  findIpkg,
  ipkgCandidates,
  isIpkgFileName,
  listDirectoryInOsOrder,
  MAX_IPKG_BYTES,
  modelFromDumpOutput,
  packageOptionWords,
  parseDumpJson,
  readIpkgModel,
  readIpkgText,
  type DirectoryLister,
} from '../../src/project/ipkg';
import type { IpkgModel, IpkgModelState } from '../../src/project/types';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../../src/toolchain/types';
import { fakeLauncher, repoRoot } from '../fake-tools/paths';
import { FIXTURE_RECORDINGS, TEXT_RECORDINGS, type DumpRecording } from './support/ipkgRecordings';

function fixture(file: string): string {
  return path.join(repoRoot(), ...file.split('/'));
}

function processResult(recording: DumpRecording): ProcessResult {
  return { exitCode: recording.exitCode, signal: null, stdout: recording.stdout, stderr: recording.stderr, timedOut: false, durationMs: 1 };
}

function recorded(file: string): DumpRecording {
  const recording = FIXTURE_RECORDINGS.find((r) => r.file === file);
  assert.ok(recording, `no recording of ${file}`);
  return recording;
}

function textRecording(name: string): { readonly text: string } & DumpRecording {
  const recording = TEXT_RECORDINGS.find((r) => r.name === name);
  assert.ok(recording, `no recording of ${name}`);
  return recording;
}

/** The model of an `ok` state; fails the test otherwise. */
function modelOf(state: IpkgModelState | undefined): IpkgModel {
  assert.ok(state?.status === 'ok', JSON.stringify(state));
  return state.model;
}

function fakeLog(): { log: Log; warnings: string[] } {
  const warnings: string[] = [];
  const ignore = (): void => undefined;
  return { log: { trace: ignore, debug: ignore, info: ignore, warn: (m: string) => void warnings.push(m), error: ignore }, warnings };
}

const ANY_VERSION = { lower: undefined, lowerInclusive: true, upper: undefined, upperInclusive: true };

/** Every `.ipkg` below `dir`. */
function ipkgFilesBelow(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? ipkgFilesBelow(p) : entry.name.endsWith('.ipkg') ? [p] : [];
  });
}

suite('project/ipkg', () => {
  suite('the recorded compiler output (test/unit/support/ipkgRecordings.ts)', () => {
    test('every package file of test/fixtures/ipkg and simple-ipkg is recorded', () => {
      const files = [
        ...ipkgFilesBelow(fixture('test/fixtures/ipkg')),
        ...ipkgFilesBelow(fixture('test/fixtures/workspaces/simple-ipkg')),
      ];
      const recordedFiles = new Set(FIXTURE_RECORDINGS.map((r) => fixture(r.file)));
      assert.ok(files.length >= 9, files.join(', '));
      for (const file of files) {
        assert.ok(recordedFiles.has(file), `${file} has no recording`);
      }
    });

    test('every recorded fixture still has the content it was recorded with', () => {
      for (const r of FIXTURE_RECORDINGS) {
        const sha256 = createHash('sha256').update(fs.readFileSync(fixture(r.file))).digest('hex');
        assert.strictEqual(sha256, r.sha256, `${r.file} changed since it was recorded`);
      }
    });
  });

  suite('discovery (the compiler\'s findIpkgFile)', () => {
    test('a package file is a name whose extension is exactly "ipkg", not a dot-file', () => {
      for (const name of ['a.ipkg', 'a.b.ipkg', 'bad.invalid.ipkg', '..ipkg', '-x.ipkg']) {
        assert.strictEqual(isIpkgFileName(name), true, name);
      }
      for (const name of ['.ipkg', 'A.IPKG', 'a.ipkg.bak', 'ipkg', 'a.ipk']) {
        assert.strictEqual(isIpkgFileName(name), false, name);
      }
    });

    test('names are read with the compiler\'s path parser, for which \\, : and ? are punctuation', () => {
      // [live, M1 review, idris2 0.8.0 `--find-ipkg --check X.idr` beside the one named file]:
      // a?b.ipkg and x\.ipkg were ignored, a.ipkg\ was read, q*.ipkg was read.
      assert.strictEqual(isIpkgFileName('a?b.ipkg'), false, 'read as "a"');
      assert.strictEqual(isIpkgFileName('x\\.ipkg'), false, 'last component ".ipkg"');
      assert.strictEqual(isIpkgFileName('a.ipkg\\'), true, 'a trailing separator');
      assert.strictEqual(isIpkgFileName('q*.ipkg'), true);
      // From the source: a leading "<text>:" is a volume.
      assert.strictEqual(isIpkgFileName('a:b.ipkg'), true, 'volume A:, file b.ipkg');
      assert.strictEqual(isIpkgFileName('foo:.ipkg'), false, 'volume F:, file .ipkg');
      assert.strictEqual(isIpkgFileName('a.ipkg/.'), true, 'a trailing "." is skipped');
      assert.strictEqual(isIpkgFileName('a.ipkg/..'), false, 'no file name after ".."');
      assert.strictEqual(isIpkgFileName('a.ipkg\\ '), true, 'a component of white space is dropped');
    });

    test('compilerReadsPathAsGiven: the path the compiler splits is the path passed', () => {
      for (const file of ['/w/p/simple.ipkg', '/w/My Projects/p.ipkg', '/w/ x/p.ipkg', '/w/-x.ipkg']) {
        assert.ok(compilerReadsPathAsGiven(file, 'darwin'), file);
      }
      // [live]: co:lon and back\slash (and a directory named " ") made the compiler read another path.
      for (const file of ['/w/co:lon/p.ipkg', '/w/q?/p.ipkg', '/w/back\\slash/p.ipkg', '/w/ /p.ipkg', '/w/\u00a0\t/p.ipkg']) {
        assert.ok(!compilerReadsPathAsGiven(file, 'linux'), file);
      }
      for (const file of ['C:\\w\\p.ipkg', 'c:\\w\\p.ipkg', 'C:/w/p.ipkg', '\\\\srv\\share\\w\\p.ipkg']) {
        assert.ok(compilerReadsPathAsGiven(file, 'win32'), file);
      }
      for (const file of ['C:\\w:x\\p.ipkg', 'C:\\w\\q?\\p.ipkg', 'C:\\ \\p.ipkg']) {
        assert.ok(!compilerReadsPathAsGiven(file, 'win32'), file);
      }
    });

    test('the first package file in listing order is the one; the others are listed (F10)', () => {
      const dir = path.resolve('/w/p');
      assert.deepStrictEqual(ipkgCandidates(dir, ['z.ipkg', 'Main.idr', 'a.ipkg', 'b.ipkg']), {
        dir,
        ipkgPath: path.join(dir, 'z.ipkg'),
        otherIpkgs: [path.join(dir, 'a.ipkg'), path.join(dir, 'b.ipkg')],
      });
      assert.strictEqual(ipkgCandidates(dir, ['Main.idr', '.ipkg']), undefined);
    });

    /** A lister over `tree` (directory → names; a missing directory cannot be listed) that records its calls. */
    function fakeFs(tree: Record<string, readonly string[]>): { list: DirectoryLister; listed: string[] } {
      const listed: string[] = [];
      return {
        listed,
        list: (dir) => {
          listed.push(dir);
          return Promise.resolve(tree[dir]);
        },
      };
    }

    const root = path.resolve('/');
    const a = path.join(root, 'a');
    const b = path.join(a, 'b');
    const c = path.join(b, 'c');

    test('walks up to the nearest directory with a package file', async () => {
      const { list, listed } = fakeFs({ [c]: ['X.idr'], [b]: ['c'], [a]: ['b', 'p.ipkg'], [root]: ['a', 'top.ipkg'] });
      assert.deepStrictEqual(await findIpkg(c, list), { dir: a, ipkgPath: path.join(a, 'p.ipkg'), otherIpkgs: [] });
      assert.deepStrictEqual(listed, [c, b, a]);
    });

    test('walks up to the file-system root and finds nothing', async () => {
      const { list, listed } = fakeFs({ [c]: [], [b]: ['c'], [a]: ['b'], [root]: ['a'] });
      assert.strictEqual(await findIpkg(c, list), undefined);
      assert.deepStrictEqual(listed, [c, b, a, root]);
    });

    test('stops at a directory it cannot list, as the compiler does', async () => {
      const { list, listed } = fakeFs({ [c]: [], [a]: ['b', 'p.ipkg'], [root]: ['a'] });
      assert.strictEqual(await findIpkg(c, list), undefined);
      assert.deepStrictEqual(listed, [c, b]);
    });

    test('finds the package file of the starting directory itself, listing nothing above', async () => {
      const { list, listed } = fakeFs({ [c]: ['c.ipkg'] });
      assert.deepStrictEqual(await findIpkg(c, list), { dir: c, ipkgPath: path.join(c, 'c.ipkg'), otherIpkgs: [] });
      assert.deepStrictEqual(listed, [c]);
    });

    test('lists in the order fs.opendir yields, without sorting (fs.readdir sorts, the compiler does not)', async () => {
      const promises = fs.promises as { opendir: unknown };
      const original = promises.opendir;
      const names = ['c.ipkg', 'b.ipkg', 'X.idr', 'a.ipkg'];
      promises.opendir = () =>
        Promise.resolve(
          (async function* () {
            yield* names.map((name) => ({ name }));
          })(),
        );
      try {
        assert.deepStrictEqual(await listDirectoryInOsOrder(path.resolve('/any')), names);
      } finally {
        promises.opendir = original;
      }
    });

    test('lists a directory with fs.opendir: the names readdir gives, undefined for no directory', async () => {
      const dir = fixture('test/fixtures/ipkg/literate/src/Lit');
      const names = await listDirectoryInOsOrder(dir);
      assert.deepStrictEqual([...(names ?? [])].sort(), fs.readdirSync(dir).sort());
      assert.strictEqual(await listDirectoryInOsOrder(path.join(dir, 'missing')), undefined);
      assert.strictEqual(await listDirectoryInOsOrder(path.join(dir, 'Twice.idr')), undefined);
    });

    test('from simple-ipkg/src/Foo, the walk finds simple.ipkg two levels up', async () => {
      const dir = fixture('test/fixtures/workspaces/simple-ipkg');
      assert.deepStrictEqual(await findIpkg(path.join(dir, 'src', 'Foo')), {
        dir,
        ipkgPath: path.join(dir, 'simple.ipkg'),
        otherIpkgs: [],
      });
    });

    test('POSIX: from a folder whose name has a \\ the compiler goes up elsewhere; the walk cannot see it, so the path is marked as misread', async function () {
      if (process.platform === 'win32') {
        this.skip(); // \ is the separator there, in both walks
      }
      // M2 second verification of the third review: r/x\y with r/x/evil.ipkg; the compiler, started in
      // r/x\y, went up to r/x (splitParent parses \ as a separator) and adopted evil.ipkg [live, 0.8.0].
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-bs-')));
      try {
        const start = path.join(base, 'r', 'x\\y');
        fs.mkdirSync(start, { recursive: true });
        fs.mkdirSync(path.join(base, 'r', 'x'));
        fs.writeFileSync(path.join(base, 'r', 'x', 'evil.ipkg'), 'package evil\n');
        assert.strictEqual(await findIpkg(start), undefined, 'path.dirname goes from r/x\\y to r');
        assert.strictEqual(compilerReadsPathAsGiven(start, process.platform), false, 'so backend.ts sends no load from there');
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    test('with two package files, the walk takes the first the OS lists and names the other', async () => {
      const dir = fixture('test/fixtures/ipkg/two-ipkgs');
      const osOrder = ((await listDirectoryInOsOrder(dir)) ?? []).filter((name) => name.endsWith('.ipkg'));
      assert.deepStrictEqual([...osOrder].sort(), ['first.ipkg', 'second.ipkg']);
      assert.deepStrictEqual(await findIpkg(dir), {
        dir,
        ipkgPath: path.join(dir, osOrder[0]),
        otherIpkgs: [path.join(dir, osOrder[1])],
      });
    });
  });

  suite('--dump-ipkg-json output (modelFromDumpOutput)', () => {
    test('simple-ipkg: sourcedir "src", depends on contrib without bounds, two modules', () => {
      const state = modelFromDumpOutput(processResult(recorded('test/fixtures/workspaces/simple-ipkg/simple.ipkg')));
      assert.deepStrictEqual(state, {
        status: 'ok',
        source: 'dump-json',
        model: {
          name: 'simple',
          version: '0.1.0',
          depends: [{ name: 'contrib', bounds: ANY_VERSION }],
          modules: ['Foo.A', 'Foo.B'],
          sourcedir: 'src',
        },
      });
    });

    test('a warning printed before the JSON is skipped; bounds, main and executable are read', () => {
      const r = recorded('test/fixtures/ipkg/versions/versions.ipkg');
      assert.match(r.stdout, /^Warning: Deprecation warning/);
      assert.deepStrictEqual(modelOf(modelFromDumpOutput(processResult(r))), {
        name: 'versions',
        depends: [
          { name: 'contrib', bounds: { lower: '0.3', lowerInclusive: true, upper: '1.0', upperInclusive: false } },
          { name: 'base', bounds: { lower: '0.8.0', lowerInclusive: true, upper: '0.8.0', upperInclusive: true } },
          { name: 'prelude', bounds: { lower: undefined, lowerInclusive: true, upper: '2.10', upperInclusive: true } },
        ],
        modules: [],
        main: 'Main',
        executable: 'my-exe',
      });
    });

    test('strings are read raw: sourcedir "src\\\\main" is the compiler\'s src\\\\main, where JSON.parse fails', () => {
      const r = recorded('test/fixtures/ipkg/escapes/esc.ipkg');
      // The compiler prints the literal of `authors` with its newline, which JSON forbids.
      assert.throws(() => JSON.parse(r.stdout) as unknown, SyntaxError);
      assert.deepStrictEqual(modelOf(modelFromDumpOutput(processResult(r))), {
        name: 'esc',
        depends: [],
        modules: ['Esc.M'],
        sourcedir: String.raw`src\\main`,
      });
    });

    test('comments: nested, with a string holding "-}", and a top-level {--} that runs to the end', () => {
      assert.deepStrictEqual(modelOf(modelFromDumpOutput(processResult(recorded('test/fixtures/ipkg/comments/comments.ipkg')))), {
        name: 'comments',
        depends: [],
        modules: [],
        sourcedir: 'a',
        builddir: 'b',
      });
    });

    test('an unknown property (F10) is an error with the compiler\'s message and range', () => {
      const state = modelFromDumpOutput(processResult(recorded('test/fixtures/ipkg/bad-property/bad.invalid.ipkg')));
      assert.deepStrictEqual(state, {
        status: 'error',
        source: 'dump-json',
        error: {
          message: 'Unrecognised property "pkgs".',
          range: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 5 },
        },
      });
    });

    test('a trailing comma (F10) is "Expected end of file." at the comma', () => {
      const state = modelFromDumpOutput(processResult(recorded('test/fixtures/ipkg/trailing-comma/comma.invalid.ipkg')));
      assert.deepStrictEqual(state, {
        status: 'error',
        source: 'dump-json',
        error: { message: 'Expected end of file.', range: { startLine: 2, startColumn: 24, endLine: 2, endColumn: 25 } },
      });
    });

    test('a listed module without a source file is an error of the package file', () => {
      assert.deepStrictEqual(modelFromDumpOutput(processResult(textRecording('miss.ipkg'))), {
        status: 'error',
        source: 'dump-json',
        error: { message: 'Module Nope not found', range: { startLine: 2, startColumn: 11, endLine: 3, endColumn: 1 } },
      });
    });

    test('an error without a location has no range', () => {
      const state = modelFromDumpOutput({ ...processResult({ exitCode: 1, stdout: '', stderr: 'Error: Something.\n' }) });
      assert.deepStrictEqual(state, { status: 'error', source: 'dump-json', error: { message: 'Something.' } });
    });

    test('a run that produced neither the JSON nor an error yields nothing (the caller falls back)', () => {
      const ok = processResult(recorded('test/fixtures/workspaces/simple-ipkg/simple.ipkg'));
      const failures: ProcessResult[] = [
        { ...ok, exitCode: null, spawnError: 'ENOENT' },
        { ...ok, exitCode: null, timedOut: true },
        { ...ok, exitCode: null, signal: 'SIGKILL' },
        { ...ok, stdout: 'not json\n' },
        { ...ok, stdout: `${ok.stdout}trailing text\n` },
        { ...ok, stdout: '{"name": "p","depends": [],"modules": "Foo"}\n' },
        { ...ok, stdout: '{"name": "p","depends": [{"a": true}],"modules": []}\n' },
        { ...ok, stdout: '{"name": "p","depends": [],"modules": [],"sourcedir": true}\n' },
        { ...ok, exitCode: 1, stdout: '', stderr: 'Uncaught exception\n' },
      ];
      for (const failure of failures) {
        assert.strictEqual(modelFromDumpOutput(failure), undefined, JSON.stringify(failure));
      }
    });
  });

  suite('parseDumpJson', () => {
    test('reads strings raw: escapes stay as written, a raw newline is part of the string', () => {
      const json = parseDumpJson(String.raw`{"name": "a\\b","q": "say \"hi\"","t": "tab\t"}` + '\n');
      assert.deepStrictEqual(json, new Map([
        ['name', String.raw`a\\b`],
        ['q', String.raw`say \"hi\"`],
        ['t', String.raw`tab\t`],
      ]));
      assert.deepStrictEqual(parseDumpJson('{"name": "two\nlines"}'), new Map([['name', 'two\nlines']]));
    });

    test('reads lists, objects, booleans and empty containers; skips lines before the object', () => {
      const json = parseDumpJson('Warning: w\n{"name": "p", "l": [], "o": {}, "b": [true, false], "d": [{"x": {"y": "z"}}]}\n');
      assert.deepStrictEqual(json, new Map<string, unknown>([
        ['name', 'p'],
        ['l', []],
        ['o', new Map()],
        ['b', [true, false]],
        ['d', [new Map([['x', new Map([['y', 'z']])]])]],
      ]));
    });

    test('rejects what the compiler never prints', () => {
      for (const text of [
        '',
        '{"nam": "p"}',
        'x {"name": "p"}',
        '{"name": "p"',
        '{"name": "p}',
        '{"name": "p" "x": "y"}',
        '{"name": "p","n": 1}',
        '{"name": "p","n": null}',
        '{"name": "p"} {}',
      ]) {
        assert.strictEqual(parseDumpJson(text), undefined, text);
      }
    });
  });

  suite('the fallback reader (readIpkgText) against the compiler', () => {
    test('every recorded fixture: the same model, or the same error message and range', () => {
      for (const r of FIXTURE_RECORDINGS) {
        const fallback = readIpkgText(fs.readFileSync(fixture(r.file), 'utf8'));
        const compiler = modelFromDumpOutput(processResult(r));
        assert.ok(compiler !== undefined, r.file);
        assert.deepStrictEqual({ ...fallback, source: 'dump-json' }, compiler, r.file);
      }
    });

    test('every recorded grammar case but a missing module: the same model or error', () => {
      for (const r of TEXT_RECORDINGS.filter((t) => t.name !== 'miss.ipkg')) {
        const compiler = modelFromDumpOutput(processResult(r));
        assert.ok(compiler !== undefined, r.name);
        assert.deepStrictEqual({ ...readIpkgText(r.text), source: 'dump-json' }, compiler, r.name);
      }
    });

    test('opts: both readers keep it as written; `options` and `opts` are one field, the last one wins; its words', () => {
      const handwritten = FIXTURE_RECORDINGS.find((r) => r.file === 'test/fixtures/grammar/Handwritten.ipkg');
      assert.ok(handwritten !== undefined);
      assert.strictEqual(modelOf(modelFromDumpOutput(processResult(handwritten))).opts, '--no-color --console-width 0');
      assert.strictEqual(modelOf(readIpkgText(fs.readFileSync(fixture(handwritten.file), 'utf8'))).opts, '--no-color --console-width 0');
      assert.strictEqual(modelOf(readIpkgText('package p\nopts = "--build-dir a"\noptions = "--total"\n')).opts, '--total');
      assert.strictEqual(modelOf(readIpkgText('package p\n')).opts, undefined);
      // `words` splits at the compiler's isSpace (U+00A0 included) and drops empty words.
      assert.deepStrictEqual(packageOptionWords(' --build-dir\t\tb\u00a0-p\r\ncontrib\f\v'), ['--build-dir', 'b', '-p', 'contrib']);
      assert.deepStrictEqual(packageOptionWords(undefined), []);
    });

    test('the text as the compiler reads it: a U+FEFF starting a line is dropped, a NUL ends its line', () => {
      assert.strictEqual(modelOf(readIpkgText(textRecording('bom.ipkg').text)).sourcedir, 'src');
      assert.strictEqual(modelOf(readIpkgText(textRecording('bom2.ipkg').text)).sourcedir, 'src');
      assert.strictEqual(readIpkgText(textRecording('bom3.ipkg').text).status, 'error', 'not inside a line');
      assert.strictEqual(modelOf(readIpkgText(textRecording('nul.ipkg').text)).sourcedir, 's');
      assert.strictEqual(modelOf(readIpkgText(textRecording('nul2.ipkg').text)).sourcedir, 'ab', 'the next line is joined');
    });

    test('the documented difference: a listed module without a file is not an error without the compiler', () => {
      assert.deepStrictEqual(modelOf(readIpkgText(textRecording('miss.ipkg').text)), { name: 'miss', depends: [], modules: ['Nope'] });
    });

    test('Lexical.ipkg (M0 grammar fixture): the corner cases read as the compiler reads them', () => {
      const model = modelOf(readIpkgText(fs.readFileSync(fixture('test/fixtures/grammar/Lexical.ipkg'), 'utf8')));
      assert.strictEqual(model.name, 'tally-lexical');
      assert.strictEqual(model.version, undefined, 'the string form of version is not stored');
      assert.strictEqual(model.main, 'Tally', 'a capitalised name ends at a dash');
      assert.deepStrictEqual(model.modules, ['Tally', 'Tally.Parse']);
      assert.strictEqual(model.sourcedir, 'ipkg-sources');
    });

    test('text that is no package file at all is an error with a range', () => {
      const state = readIpkgText('');
      assert.ok(state.status === 'error');
      assert.deepStrictEqual(state.error, {
        message: 'Expected property package.',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      });
    });

    test('long comments have no stack limit: 200,000 braces, 5,000 dashes between words', () => {
      // The recursive automaton this replaced ran out of stack between 3,000 and 5,000 `-x`.
      assert.deepStrictEqual(modelOf(readIpkgText(`package p\n{- ${'{'.repeat(200_000)} -}\n`)), { name: 'p', depends: [], modules: [] });
      assert.strictEqual(modelOf(readIpkgText(`package p\n{- ${'-x'.repeat(5_000)} -}\nsourcedir = "d"\n`)).sourcedir, 'd');
    });

    test('a comment that fails late is read in polynomial time, with the compiler\'s answer', () => {
      // `late.ipkg` (recorded) is this shape with n = 3; every `{-` is tried as an opener and as
      // text, which took the recursive reader (and takes the compiler's lexer) time exponential
      // in n. With n = 60 a regression is a hang that mocha's time limit reports.
      const late = textRecording('late.ipkg');
      assert.strictEqual(late.text, `package late\n{-${'{-x'.repeat(3)}"`);
      const expected = modelFromDumpOutput(processResult(late));
      assert.deepStrictEqual({ ...readIpkgText(`package late\n{-${'{-x'.repeat(60)}"`), source: 'dump-json' }, expected);
    });

    test('a pathological comment exhausts the work limit and is an error, quickly', () => {
      assert.deepStrictEqual(readIpkgText(`package p\n{-${'{-x'.repeat(20_000)}"`), {
        status: 'error',
        source: 'fallback',
        error: { message: 'A block comment of the file is too complex for the built-in reader.' },
      });
    });
  });

  suite('readIpkgModel', () => {
    const simple = fixture('test/fixtures/workspaces/simple-ipkg/simple.ipkg');

    function fakeRunner(answer: (request: ProcessRequest) => Promise<ProcessResult>): ProcessRunner & { requests: ProcessRequest[] } {
      const requests: ProcessRequest[] = [];
      return {
        requests,
        run: (request) => {
          requests.push(request);
          return answer(request);
        },
      };
    }

    test("runs idris2 --dump-ipkg-json <absolute path> in the compiler's directory with the configured environment", async () => {
      // Not in the package directory: starting a program there can load code from it
      // (docs/as-built/M1.md, *Processes*); the compiler changes into it itself, with the same
      // output.
      const runner = fakeRunner(() => Promise.resolve(processResult(recorded('test/fixtures/workspaces/simple-ipkg/simple.ipkg'))));
      const { log, warnings } = fakeLog();
      const state = await readIpkgModel(simple, { runner, executable: '/opt/idris2/bin/idris2', env: { IDRIS2_PREFIX: '/opt/p' } }, log);
      assert.deepStrictEqual(runner.requests, [
        {
          executable: '/opt/idris2/bin/idris2',
          args: ['--dump-ipkg-json', simple],
          env: { IDRIS2_PREFIX: '/opt/p' },
          timeoutMs: 5000,
        },
      ]);
      assert.strictEqual(state.source, 'dump-json');
      assert.strictEqual(modelOf(state).sourcedir, 'src');
      assert.deepStrictEqual(warnings, []);
    });

    test('reports the compiler\'s error for a malformed package file', async () => {
      const bad = fixture('test/fixtures/ipkg/bad-property/bad.invalid.ipkg');
      const runner = fakeRunner(() => Promise.resolve(processResult(recorded('test/fixtures/ipkg/bad-property/bad.invalid.ipkg'))));
      const state = await readIpkgModel(bad, { runner, executable: '/x/idris2', env: {} }, fakeLog().log);
      assert.ok(state.status === 'error' && state.source === 'dump-json', JSON.stringify(state));
    });

    test('falls back to the built-in reader when the run fails or is refused, and says so in the log', async () => {
      const failed = fakeRunner(() =>
        Promise.resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT', durationMs: 0 }),
      );
      const refused = fakeRunner(() => Promise.reject(new Error('Restricted Mode')));
      for (const runner of [failed, refused]) {
        const { log, warnings } = fakeLog();
        const state = await readIpkgModel(simple, { runner, executable: '/x/idris2', env: {} }, log);
        assert.strictEqual(state.source, 'fallback');
        assert.strictEqual(modelOf(state).sourcedir, 'src');
        assert.strictEqual(warnings.length, 1, warnings.join('\n'));
      }
    });

    test('a package whose name starts with "-" gets the compiler\'s model (the fake compiler takes no "-x" as the file, as the compiler)', async function () {
      this.timeout(20_000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-dash-'));
      try {
        const dash = path.join(dir, '-x.ipkg');
        fs.copyFileSync(simple, dash); // the fake answers by content: simple.ipkg's recording
        const runner = createProcessRunner({ trust: { isTrusted: true, onDidGrant: () => ({ dispose: () => undefined }) }, log: fakeLog().log });
        const { log, warnings } = fakeLog();
        const state = await readIpkgModel(dash, { runner, executable: fakeLauncher('idris2'), env: {} }, log);
        assert.deepStrictEqual(warnings, []);
        assert.strictEqual(state.source, 'dump-json', JSON.stringify(state));
        assert.strictEqual(modelOf(state).name, 'simple');
        runner.dispose();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('POSIX: a path the compiler would read differently is read with the built-in reader, without running it', async function () {
      if (process.platform === 'win32') {
        this.skip(); // no ':' in Windows file names
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-colon-'));
      try {
        const ipkg = path.join(dir, 'co:lon', 'simple.ipkg');
        fs.mkdirSync(path.dirname(ipkg));
        fs.copyFileSync(simple, ipkg);
        const runner = fakeRunner(() => Promise.reject(new Error('must not run')));
        const { log, warnings } = fakeLog();
        const state = await readIpkgModel(ipkg, { runner, executable: '/x/idris2', env: {} }, log);
        assert.deepStrictEqual(runner.requests, []);
        assert.strictEqual(state.source, 'fallback');
        assert.strictEqual(modelOf(state).sourcedir, 'src');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /the compiler's path parser would read another path/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('without a compiler, reads the file with the built-in reader', async () => {
      const state = await readIpkgModel(simple, undefined, fakeLog().log);
      assert.deepStrictEqual(state, {
        status: 'ok',
        source: 'fallback',
        model: modelOf(modelFromDumpOutput(processResult(recorded('test/fixtures/workspaces/simple-ipkg/simple.ipkg')))),
      });
    });

    suite('only a regular file of at most 256 KiB is read, by either reader', () => {
      let dir: string;
      setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-ipkg-'));
      });
      teardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });

      /** Reads `name` in `dir` with a compiler whose runner records requests; asserts the error. */
      async function refused(name: string, message: RegExp): Promise<void> {
        const runner = fakeRunner(() => Promise.reject(new Error('not expected')));
        const state = await readIpkgModel(path.join(dir, name), { runner, executable: '/x/idris2', env: {} }, fakeLog().log);
        assert.ok(state.status === 'error', JSON.stringify(state));
        assert.match(state.error.message, message);
        assert.deepStrictEqual(runner.requests, [], 'the compiler is not run on it');
      }

      test('a directory named x.ipkg', async () => {
        fs.mkdirSync(path.join(dir, 'x.ipkg'));
        await refused('x.ipkg', /^x\.ipkg is not a regular file \(a directory\), so it was not read\.$/);
      });

      test('a file larger than 256 KiB (the fallback reader blocks the Extension Host in linear time)', async () => {
        assert.strictEqual(MAX_IPKG_BYTES, 256 * 1024);
        fs.writeFileSync(path.join(dir, 'big.ipkg'), `package big\n${' '.repeat(256 * 1024)}`);
        await refused('big.ipkg', /^big\.ipkg is larger than 262144 bytes, so it was not read\.$/);
        // A file of exactly the limit is read.
        fs.writeFileSync(path.join(dir, 'edge.ipkg'), `package edge\n${' '.repeat(256 * 1024 - 'package edge\n'.length)}`);
        const state = await readIpkgModel(path.join(dir, 'edge.ipkg'), undefined, fakeLog().log);
        assert.strictEqual(state.status, 'ok', JSON.stringify(state));
      });

      test('a missing file', async () => {
        await refused('gone.ipkg', /^gone\.ipkg cannot be read \(ENOENT\), so it was not read\.$/);
      });

      test('POSIX: a FIFO is refused at once (reading it would wait for a writer)', async function () {
        if (process.platform === 'win32') {
          this.skip();
        }
        execFileSync('mkfifo', [path.join(dir, 'fifo.ipkg')]);
        await refused('fifo.ipkg', /^fifo\.ipkg is not a regular file \(a FIFO\), so it was not read\.$/);
      });

      test('POSIX: a symbolic link to /dev/zero is refused (reading it would not end)', async function () {
        if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) {
          this.skip();
        }
        fs.symlinkSync('/dev/zero', path.join(dir, 'zero.ipkg'));
        await refused('zero.ipkg', /^zero\.ipkg is not a regular file \(a device\), so it was not read\.$/);
      });

      test('a symbolic link to a regular package file is read', async function () {
        if (process.platform === 'win32') {
          this.skip(); // creating a symbolic link needs a privilege there
        }
        fs.symlinkSync(simple, path.join(dir, 'link.ipkg'));
        assert.strictEqual(modelOf(await readIpkgModel(path.join(dir, 'link.ipkg'), undefined, fakeLog().log)).name, 'simple');
      });
    });
  });
});
