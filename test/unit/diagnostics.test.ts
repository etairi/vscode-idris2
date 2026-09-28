// backend/ide/diagnostics.ts on the replies recorded from Idris 2 0.8.0
// (test/fixtures/transcripts/0.8.0), decoded by protocol.ts: ranges, messages, severities, which
// files a load determines, the .ipkg error and the "not checked" error of a failed load.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  KNOWN_WARNINGS,
  knownWarning,
  loadDiagnostics,
  messageText,
  type DiagnosticRecord,
  type LoadContext,
  type LoadDiagnostics,
} from '../../src/backend/ide/diagnostics';
import type { Reply } from '../../src/backend/ide/types';
import type { PositionDocument } from '../../src/core/positions';
import { repoRoot } from '../fake-tools/paths';
import { recordedExchanges } from './support/loadReplies';

/** A document with no text: enough for every file that is not bird-track. */
function plain(fileName: string): PositionDocument {
  return { languageId: '', fileName, isUntitled: false, lineCount: 0, lineAt: () => ({ text: '' }) };
}

/** The fixture file's text as the compiler read it. */
function fixture(fileName: string, relative: string): PositionDocument {
  const lines = fs.readFileSync(path.join(repoRoot(), 'test', 'fixtures', 'workspaces', relative), 'utf8').split('\n');
  return { languageId: '', fileName, isUntitled: false, lineCount: lines.length, lineAt: (i) => ({ text: lines[i] ?? '' }) };
}

function context(overrides: Partial<LoadContext> & Pick<LoadContext, 'loadedPath' | 'sentPath' | 'cwd'>): LoadContext {
  return {
    ipkgPath: undefined,
    includeSourceExcerpt: false,
    warningsAsErrors: false,
    documentFor: plain,
    ...overrides,
  };
}

/** The reply of the n-th request of a scenario, recorded with `${ROOT}` = `root`. */
function reply(scenario: string, root: string, n = 0): Reply {
  return recordedExchanges(scenario, root)[n].reply;
}

/** `files` as plain data, for deepStrictEqual. */
function files(result: LoadDiagnostics): Record<string, DiagnosticRecord[]> {
  return Object.fromEntries([...result.files].map(([file, records]) => [file, [...records]]));
}

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const BROKEN = '/w/broken';
const loose = (name: string, overrides: Partial<LoadContext> = {}) =>
  context({ loadedPath: `${BROKEN}/${name}`, sentPath: `${BROKEN}/${name}`, cwd: BROKEN, ...overrides });

suite('backend/ide/diagnostics (the recorded 0.8.0 replies)', () => {
  test('Bad.idr (load-bad): one error at 0-based (3,6)–(3,11), the message without its location and excerpt (F6)', () => {
    const result = loadDiagnostics(reply('load-bad', BROKEN), loose('Bad.idr'));
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(files(result), {
      [`${BROKEN}/Bad.idr`]: [
        {
          range: range(3, 6, 3, 11),
          severity: 'error',
          message: 'While processing right hand side of f. When unifying:\n    Nat\nand:\n    String\nMismatch between: Nat and String.',
          related: [],
        },
      ],
    });
    assert.strictEqual(result.packageError, undefined);
  });

  test('with idris2.diagnostics.includeSourceExcerpt the message keeps the location line and the excerpt', () => {
    const result = loadDiagnostics(reply('load-bad', BROKEN), loose('Bad.idr', { includeSourceExcerpt: true }));
    const [record] = result.files.get(`${BROKEN}/Bad.idr`) ?? [];
    assert.strictEqual(
      record.message,
      'While processing right hand side of f. When unifying:\n    Nat\nand:\n    String\nMismatch between: Nat and String.\n\n' +
        'Bad:4:7--4:12\n 1 | module Bad\n 2 | \n 3 | f : Nat -> String\n 4 | f x = x + 1\n           ^^^^^',
    );
  });

  test('Warn.idr (load-warn): after (:ok ()) the frame is a warning; the reload without Building determines no file (F7)', () => {
    const [first, second] = recordedExchanges('load-warn', BROKEN);
    const loaded = loadDiagnostics(first.reply, loose('Warn.idr'));
    assert.strictEqual(loaded.ok, true);
    assert.deepStrictEqual(files(loaded), {
      [`${BROKEN}/Warn.idr`]: [{ range: range(4, 0, 4, 3), severity: 'warning', message: 'Unreachable clause: f n', related: [] }],
    });
    const reloaded = loadDiagnostics(second.reply, loose('Warn.idr'));
    assert.strictEqual(reloaded.ok, true);
    assert.deepStrictEqual(files(reloaded), {}, 'the diagnostics shown for Warn.idr are kept');
  });

  test('Mixed.idr (load-mixed): after (:error …) the known warning stays a warning and the type error is an error (F7, D9)', () => {
    const result = loadDiagnostics(reply('load-mixed', BROKEN), loose('Mixed.idr'));
    assert.deepStrictEqual(
      result.files.get(`${BROKEN}/Mixed.idr`)?.map((d) => [d.severity, d.message.split('\n', 1)[0], d.range]),
      [
        ['warning', 'Unreachable clause: f n', range(4, 0, 4, 3)],
        ['error', 'While processing right hand side of g. When unifying:', range(7, 6, 7, 7)],
      ],
    );
  });

  test('…and with -Werror every frame of a failed load is an error (the compiler prints warnings as errors with the same text)', () => {
    const result = loadDiagnostics(reply('load-mixed', BROKEN), loose('Mixed.idr', { warningsAsErrors: true }));
    assert.deepStrictEqual(
      result.files.get(`${BROKEN}/Mixed.idr`)?.map((d) => d.severity),
      ['error', 'error'],
    );
  });

  test('Part.idr (load-part): the Missing cases block and the text after the excerpt are kept', () => {
    const result = loadDiagnostics(reply('load-part', BROKEN), loose('Part.idr'));
    assert.deepStrictEqual(
      result.files.get(`${BROKEN}/Part.idr`)?.map((d) => [d.range, d.message]),
      [
        [range(2, 0, 2, 14), 'g is not covering.\n\nMissing cases:\n    g (S _)'],
        [range(5, 0, 5, 12), 'main is not covering.\n\nCalls non covering function Part.g'],
      ],
    );
  });

  test('UsesBad.idr (load-uses-bad): the error lands on the imported Bad.idr; UsesBad.idr says it was not checked', () => {
    const result = loadDiagnostics(reply('load-uses-bad', BROKEN), loose('UsesBad.idr'));
    const bad = result.files.get(`${BROKEN}/Bad.idr`);
    assert.strictEqual(bad?.length, 1);
    assert.strictEqual(bad[0].severity, 'error');
    assert.deepStrictEqual(bad[0].range, range(3, 6, 3, 11));
    assert.deepStrictEqual(result.files.get(`${BROKEN}/UsesBad.idr`), [
      {
        range: range(0, 0, 0, 0),
        severity: 'error',
        message: 'Not checked: the compiler reported errors in Bad.idr.',
        related: [{ path: `${BROKEN}/Bad.idr`, range: range(3, 6, 3, 11), message: 'While processing right hand side of f. When unifying:' }],
      },
    ]);
    // The files that stopped it, for the checks to check it again once they are clean.
    assert.deepStrictEqual(result.blockedBy, [`${BROKEN}/Bad.idr`]);
  });

  test('bad-ipkg/Main.idr (load-bad-ipkg): the .ipkg error lands on the .ipkg at 1-based 3:1, i.e. (2,0)–(2,4) (F10)', () => {
    const dir = `${BROKEN}/bad-ipkg`;
    const ipkg = `${dir}/bad.ipkg`;
    const result = loadDiagnostics(
      reply('load-bad-ipkg', dir),
      context({ loadedPath: `${dir}/Main.idr`, sentPath: `${dir}/Main.idr`, cwd: dir, ipkgPath: ipkg }),
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.packageError, { path: ipkg, message: 'Unrecognised property "pkgs".' });
    assert.strictEqual(result.blockedBy, undefined, 'a package-file error is not an imported file\'s');
    assert.deepStrictEqual(files(result), {
      [ipkg]: [{ range: range(2, 0, 2, 4), severity: 'error', message: 'Unrecognised property "pkgs".', related: [] }],
      [`${dir}/Main.idr`]: [
        {
          range: range(0, 0, 0, 0),
          severity: 'error',
          message: 'Not checked: the package file bad.ipkg could not be read.',
          related: [{ path: ipkg, range: range(2, 0, 2, 4), message: 'Unrecognised property "pkgs".' }],
        },
      ],
    });
  });

  test('simple-ipkg (load-simple-ipkg): every built module and the .ipkg are determined; the sent real path maps to the document', () => {
    // The session directory is spelled through a link (/w/…); the compiler's own path, which the
    // extension sends, is the real one (/private/w/…).
    const cwd = '/w/simple-ipkg';
    const real = '/private/w/simple-ipkg';
    const [first, second] = recordedExchanges('load-simple-ipkg', real);
    const ctx = context({
      loadedPath: `${cwd}/src/Foo/B.idr`,
      sentPath: `${real}/src/Foo/B.idr`,
      cwd,
      ipkgPath: `${cwd}/simple.ipkg`,
    });
    assert.deepStrictEqual(files(loadDiagnostics(first.reply, ctx)), {
      [`${cwd}/simple.ipkg`]: [],
      [`${cwd}/src/Foo/A.idr`]: [],
      [`${cwd}/src/Foo/B.idr`]: [],
    });
    assert.deepStrictEqual(files(loadDiagnostics(second.reply, ctx)), { [`${cwd}/simple.ipkg`]: [] }, 'the reload rebuilt nothing (F7)');
  });

  test('the .ipkg deprecation warning (warning-ipkg-deprecated) is on the .ipkg at every load, also one that rebuilt nothing', () => {
    const dir = `${BROKEN}/warnings/old-version`;
    const ctx = context({ loadedPath: `${dir}/Main.idr`, sentPath: `${dir}/Main.idr`, cwd: dir, ipkgPath: `${dir}/old.ipkg` });
    const expected = [
      { range: range(1, 0, 2, 0), severity: 'warning', message: 'Deprecation warning: version numbers must now be of the form x.y.z', related: [] },
    ];
    const [first, second] = recordedExchanges('warning-ipkg-deprecated', dir);
    assert.deepStrictEqual(files(loadDiagnostics(first.reply, ctx)), { [`${dir}/old.ipkg`]: expected, [`${dir}/Main.idr`]: [] });
    assert.deepStrictEqual(files(loadDiagnostics(second.reply, ctx)), { [`${dir}/old.ipkg`]: expected });
  });

  test('Err.lidr (load-lidr): reply columns are unlit, so the range moves right by the bird-track prefix (F11)', () => {
    const file = `${BROKEN}/Err.lidr`;
    const result = loadDiagnostics(
      reply('load-lidr', BROKEN),
      loose('Err.lidr', { documentFor: (p) => (p === file ? fixture(p, 'broken/Err.lidr') : plain(p)) }),
    );
    const [record] = result.files.get(file) ?? [];
    assert.deepStrictEqual(record.range, range(8, 6, 8, 9));
    assert.strictEqual(record.message, "While processing right hand side of g. Can't find an implementation for FromString Nat.");
  });

  test('ErrMd.idr.md (load-md): fenced Markdown has exact columns (F11)', () => {
    const file = `${BROKEN}/ErrMd.idr.md`;
    const result = loadDiagnostics(
      reply('load-md', BROKEN),
      loose('ErrMd.idr.md', { documentFor: (p) => (p === file ? fixture(p, 'broken/ErrMd.idr.md') : plain(p)) }),
    );
    assert.deepStrictEqual(result.files.get(file)?.[0].range, range(8, 4, 8, 7));
  });

  test('a failed load without any frame (load-symlink: a path through a link) puts the compiler\'s message on the document', () => {
    const [refused] = recordedExchanges('load-symlink', BROKEN);
    assert.strictEqual(refused.reply.payload.kind, 'error');
    assert.deepStrictEqual(refused.reply.messages, []);
    const result = loadDiagnostics(refused.reply, loose('Clean.idr'));
    const [record] = result.files.get(`${BROKEN}/Clean.idr`) ?? [];
    assert.strictEqual(record.severity, 'error');
    assert.deepStrictEqual(record.range, range(0, 0, 0, 0));
    assert.match(record.message, /^Source file ".*\/Clean\.idr" is not in the source directory ".*"$/);
  });

  suite('the known-warning table (E5): every recorded warning kind is recognised, after a failed load too', () => {
    const scenarios: [string, string, string[]][] = [
      ['warning-parser', 'ParserWarn.idr', ['ParserWarning', 'ParserWarning', 'ParserWarning', 'ParserWarning']],
      ['warning-shadow-global', 'ShadowGlobal.idr', ['ShadowingGlobalDefs']],
      ['warning-shadow-local', 'ShadowLocal.idr', ['ShadowingLocalBindings']],
      ['warning-visibility', 'Visibility.idr', ['IncompatibleVisibility']],
      ['warning-deprecated', 'Deprecated.idr', ['Deprecated']],
      ['warning-generic', 'GenericWarn.idr', ['GenericWarn', 'GenericWarn']],
      ['warning-ipkg-deprecated', 'Main.idr', ['Deprecated']],
      ['load-warn', 'Warn.idr', ['UnreachableClause']],
    ];
    for (const [scenario, name, constructors] of scenarios) {
      test(`${scenario}: ${constructors.join(', ')}`, () => {
        const recorded = recordedExchanges(scenario, BROKEN)[0].reply;
        assert.strictEqual(recorded.payload.kind, 'ok');
        const warnings = recorded.messages.flatMap((m) => (m.kind === 'warning' ? [m.warning.message] : []));
        assert.deepStrictEqual(warnings.map(knownWarning), constructors);
        // The same frames followed by (:return (:error …)) (as with an error elsewhere) stay
        // warnings; the loaded file, which got no error of its own, gets the failure's message.
        const failed: Reply = { ...recorded, payload: { kind: 'error', message: 'Error(s) building file', highlighting: [] } };
        const result = loadDiagnostics(failed, loose(name));
        const all = [...result.files.values()].flat();
        const summary = all.filter((d) => d.message === 'Error(s) building file');
        assert.deepStrictEqual(summary.map((d) => [d.severity, d.range]), [['error', range(0, 0, 0, 0)]]);
        assert.deepStrictEqual(all.filter((d) => !summary.includes(d)).map((d) => d.severity), constructors.map(() => 'warning'));
      });
    }

    test('error messages are not in the table', () => {
      for (const scenario of ['load-bad', 'load-part', 'load-lidr', 'load-md']) {
        for (const m of recordedExchanges(scenario, BROKEN)[0].reply.messages) {
          if (m.kind === 'warning') {
            assert.strictEqual(knownWarning(m.warning.message), undefined, m.warning.message);
          }
        }
      }
    });

    test('the table covers the seven warning constructors of the compiler (src/Core/Core.idr 70–88)', () => {
      assert.deepStrictEqual(
        [...new Set(KNOWN_WARNINGS.map((w) => w.constructor))].sort(),
        ['Deprecated', 'GenericWarn', 'IncompatibleVisibility', 'ParserWarning', 'ShadowingGlobalDefs', 'ShadowingLocalBindings', 'UnreachableClause'],
      );
    });
  });

  suite('messageText', () => {
    test('a multi-line location without caret (IncompatibleVisibility) and zero-padded line numbers are removed', () => {
      const visibility = recordedExchanges('warning-visibility', BROKEN)[0].reply.messages.find((m) => m.kind === 'warning');
      assert.ok(visibility?.kind === 'warning');
      assert.strictEqual(
        messageText(visibility.warning.message, false),
        'Visibility.T has been forward-declared with export visibility, cannot change to public export. This will be an error in a later release.',
      );
      const parser = recordedExchanges('warning-parser', BROKEN)[0].reply.messages.filter((m) => m.kind === 'warning');
      assert.deepStrictEqual(
        parser.map((m) => (m.kind === 'warning' ? messageText(m.warning.message, false) : '')),
        [
          'DEPRECATED: "%nomangle".\n  Use "%export" instead',
          'DEPRECATED: trailing lambda. Use a $ or parens',
          'DEPRECATED: old parameter syntax https://github.com/idris-lang/Idris2/issues/3447',
          'DEPRECATED: old record update syntax.\n  Use "{ f := v } p" instead of "record { f = v } p"\n  and "{ f $= v } p" instead of "record { f $= v } p"',
        ],
      );
    });

    test('a location line not after a blank line is text; one at the very start is a location', () => {
      assert.strictEqual(messageText('See\nFoo:1:2--1:3\n 1 | x', false), 'See\nFoo:1:2--1:3\n 1 | x');
      assert.strictEqual(messageText('Foo:1:2--1:3\n 1 | x\n     ^\n\nAfter.', false), 'After.');
    });

    test('two locations (ploc2 of two distant spans) both go, with the text between them', () => {
      const text = 'Pattern variable x unifies with: y.\n\nM:2:1--2:2\n 2 | x\n     ^\n\nM:9:1--9:2\n 9 | y\n     ^\n\nSuggestion: Use the same name.';
      assert.strictEqual(messageText(text, false), 'Pattern variable x unifies with: y.\n\nSuggestion: Use the same name.');
    });
  });

  test('a frame whose FILE is the compiler\'s placeholder goes to the loaded document\'s start, with its whole text', () => {
    const failed: Reply = {
      id: 1n,
      payload: { kind: 'error', message: 'Error(s) building file /w/broken/Bad.idr', highlighting: [] },
      messages: [
        {
          kind: 'warning',
          id: 1n,
          warning: {
            file: '(File-Not-Found)',
            span: { start: { line: 3, column: 6 }, end: { line: 3, column: 11 } },
            message: 'Mismatch.\n\nOther:4:7--4:12\n 4 | f x\n     ^^^\n',
            highlighting: [],
          },
        },
      ],
    };
    assert.deepStrictEqual(files(loadDiagnostics(failed, loose('Bad.idr'))), {
      [`${BROKEN}/Bad.idr`]: [
        { range: range(0, 0, 0, 0), severity: 'error', message: 'Mismatch.\n\nOther:4:7--4:12\n 4 | f x\n     ^^^', related: [] },
      ],
    });
  });
});
