// toolchain/versions.ts against the real outputs of Homebrew idris2 0.8.0 (macOS arm64), each
// recorded once on 2026-09-27 with `timeout 120 /opt/homebrew/bin/idris2 <flag>` run in
// /opt/homebrew/bin (stdout; stderr was empty and every exit code 0), plus synthetic variants
// built from the formats the module comment of versions.ts cites. No idris2-lsp is installed,
// so its outputs are synthetic, built from `printVersion` (idris2-lsp src/Server/Main.idr 206–209).
import * as assert from 'assert';
import {
  parseIdris2Version,
  parseListPackages,
  parseLspVersion,
  parsePaths,
  parseTtcVersion,
  parseToolVersion,
} from '../../src/toolchain/versions';

const REAL_VERSION = 'Idris 2, version 0.8.0\n';
const REAL_TTC_VERSION = '2025081600\n';
const CELLAR = '/opt/homebrew/Cellar/idris2/0.8.0_2/libexec';
const REAL_PATHS =
  '+ Working Directory      :: "/opt/homebrew/bin"\n' +
  '+ Source Directory       :: Nothing\n' +
  '+ Build Directory        :: "build"\n' +
  '+ Local Depend Directory :: "depends"\n' +
  '+ Output Directory       :: "build/exec"\n' +
  `+ Installation Prefix    :: "${CELLAR}"\n` +
  '+ Extra Directories      :: ["."]\n' +
  `+ Package Search Paths   :: [${CELLAR}/idris2-0.8.0]\n` +
  `+ Package Directories    :: ["${CELLAR}/idris2-0.8.0/base-0.8.0", "${CELLAR}/idris2-0.8.0/prelude-0.8.0"]\n` +
  `+ CG Library Directories :: ["${CELLAR}/idris2-0.8.0/lib", "/opt/homebrew/bin"]\n` +
  `+ Data Directories       :: ["${CELLAR}/idris2-0.8.0/support"]\n`;

function listed(name: string, version: string, ttc: string, dir: string): string {
  return `${name} (${version})\n  ├ TTC Versions: ${ttc}\n  └ ${dir}\n`;
}

const LIBS = `${CELLAR}/idris2-0.8.0`;
const REAL_LIST_PACKAGES =
  'Idris2 TTC Version: 2025081600\n─────\n' +
  ['base', 'contrib', 'idris2', 'linear', 'network', 'prelude', 'test']
    .map((name) => listed(name, '0.8.0', '2025081600', LIBS))
    .join('');

// Recorded the same day from a directory holding depends/foo/{2024010100,2025081600},
// depends/bar-baz-1.2.3/2025081600 and an empty depends/empty-0.1 (the compiler also lists
// <cwd>/depends); the scratch directory's long path is shortened to /tmp/lp here.
const DEPENDS = '/tmp/lp/depends';
const REAL_LIST_PACKAGES_WITH_DEPENDS =
  'Idris2 TTC Version: 2025081600\n─────\n' +
  listed('bar-baz', '1.2.3', '2025081600', DEPENDS) +
  listed('base', '0.8.0', '2025081600', LIBS) +
  listed('contrib', '0.8.0', '2025081600', LIBS) +
  listed('empty', '0.1', '', DEPENDS) +
  listed('foo', 'unversioned', '2024010100 (incompatible), 2025081600', DEPENDS) +
  ['idris2', 'linear', 'network', 'prelude', 'test'].map((name) => listed(name, '0.8.0', '2025081600', LIBS)).join('');

suite('toolchain/versions', () => {
  suite('parseToolVersion (showVersion True)', () => {
    test('a release version has no tag', () => {
      assert.deepStrictEqual(parseToolVersion('0.8.0'), { major: 0, minor: 8, patch: 0, text: '0.8.0' });
    });

    test('a build between releases carries the 9-character commit as its tag', () => {
      assert.deepStrictEqual(parseToolVersion('0.8.0-1c630e6a2'), {
        major: 0,
        minor: 8,
        patch: 0,
        tag: '1c630e6a2',
        text: '0.8.0-1c630e6a2',
      });
    });

    test('the tag is free text: VERSION_TAG may be set to anything, dashes included', () => {
      assert.strictEqual(parseToolVersion('1.10.2-rc-1 local')?.tag, 'rc-1 local');
      // ROADMAP M1 acceptance: a `-dev`-suffixed string.
      assert.deepStrictEqual(parseToolVersion('0.9.0-dev'), { major: 0, minor: 9, patch: 0, tag: 'dev', text: '0.9.0-dev' });
      assert.strictEqual(parseToolVersion('12.0.3')?.minor, 0);
    });

    test('anything else is not a version', () => {
      for (const text of ['', '0.8', '0.8.0.1', 'v0.8.0', '0.8.0-', ' 0.8.0', 'x.y.z', '99999999999999999999.0.0']) {
        assert.strictEqual(parseToolVersion(text), undefined, text);
      }
    });
  });

  suite('parseIdris2Version', () => {
    test('the real Homebrew 0.8.0 output', () => {
      assert.deepStrictEqual(parseIdris2Version(REAL_VERSION), {
        versionLine: 'Idris 2, version 0.8.0',
        version: { major: 0, minor: 8, patch: 0, text: '0.8.0' },
      });
    });

    test('a development build', () => {
      const parsed = parseIdris2Version('Idris 2, version 0.8.0-1c630e6a2\n');
      assert.strictEqual(parsed?.version?.tag, '1c630e6a2');
      assert.strictEqual(parsed?.version?.text, '0.8.0-1c630e6a2');
    });

    test('CRLF line breaks and lines before or after the version line are tolerated', () => {
      const parsed = parseIdris2Version('warning: something\r\nIdris 2, version 0.8.0\r\ntrailing junk\r\n');
      assert.strictEqual(parsed?.versionLine, 'Idris 2, version 0.8.0');
      assert.strictEqual(parsed?.version?.text, '0.8.0');
    });

    test('an unrecognised version after the prefix keeps the line but no version', () => {
      assert.deepStrictEqual(parseIdris2Version('Idris 2, version 0.8\n'), {
        versionLine: 'Idris 2, version 0.8',
        version: undefined,
      });
    });

    test('no version line: empty output, another program, the prefix alone', () => {
      for (const output of ['', '\n', 'Idris2 LSP: 0.1.0\n', 'Idris 2, version\n', 'idris 2, version 0.8.0\n']) {
        assert.strictEqual(parseIdris2Version(output), undefined, JSON.stringify(output));
      }
    });
  });

  suite('parseTtcVersion', () => {
    test('the real output', () => {
      assert.strictEqual(parseTtcVersion(REAL_TTC_VERSION), '2025081600');
      assert.strictEqual(parseTtcVersion('2025081600\r\n'), '2025081600');
    });

    test('anything but one integer is rejected', () => {
      for (const output of ['', '\n', 'x\n', '2025081600\njunk\n', 'Idris 2, version 0.8.0\n', '-1\n']) {
        assert.strictEqual(parseTtcVersion(output), undefined, JSON.stringify(output));
      }
    });
  });

  suite('parsePaths', () => {
    test('the real output: eleven labelled lines, padding removed, values as printed', () => {
      const entries = parsePaths(REAL_PATHS);
      assert.strictEqual(entries?.length, 11);
      assert.deepStrictEqual(entries?.[0], { label: 'Working Directory', value: '"/opt/homebrew/bin"' });
      assert.deepStrictEqual(entries?.[1], { label: 'Source Directory', value: 'Nothing' });
      assert.deepStrictEqual(entries?.[7], {
        label: 'Package Search Paths',
        value: `[${CELLAR}/idris2-0.8.0]`,
      });
    });

    test('CRLF and other lines are tolerated', () => {
      const entries = parsePaths(`junk\r\n${REAL_PATHS.replace(/\n/g, '\r\n')}`);
      assert.strictEqual(entries?.length, 11);
      assert.deepStrictEqual(entries?.[10], { label: 'Data Directories', value: `["${CELLAR}/idris2-0.8.0/support"]` });
    });

    test('no labelled line: undefined', () => {
      assert.strictEqual(parsePaths(''), undefined);
      assert.strictEqual(parsePaths('Idris 2, version 0.8.0\n'), undefined);
    });
  });

  suite('parseListPackages', () => {
    test('the real output of the Homebrew build: seven versioned packages, directory = search path', () => {
      const packages = parseListPackages(REAL_LIST_PACKAGES);
      assert.deepStrictEqual(
        packages?.map((p) => p.name),
        ['base', 'contrib', 'idris2', 'linear', 'network', 'prelude', 'test'],
      );
      assert.deepStrictEqual(packages?.[1], {
        name: 'contrib',
        version: '0.8.0',
        ttcVersions: ['2025081600'],
        path: LIBS,
      });
    });

    test('the real output with local depends: unversioned, incompatible, hyphenated, no TTC directory', () => {
      const packages = parseListPackages(REAL_LIST_PACKAGES_WITH_DEPENDS);
      assert.strictEqual(packages?.length, 10);
      assert.deepStrictEqual(packages?.[0], { name: 'bar-baz', version: '1.2.3', ttcVersions: ['2025081600'], path: DEPENDS });
      assert.deepStrictEqual(packages?.[3], { name: 'empty', version: '0.1', ttcVersions: [], path: DEPENDS });
      assert.deepStrictEqual(packages?.[4], {
        name: 'foo',
        version: undefined,
        ttcVersions: ['2024010100', '2025081600'],
        path: DEPENDS,
      });
    });

    test('CRLF line breaks', () => {
      assert.strictEqual(parseListPackages(REAL_LIST_PACKAGES.replace(/\n/g, '\r\n'))?.length, 7);
    });

    test('a compiler with no packages at all', () => {
      assert.deepStrictEqual(parseListPackages('Idris2 TTC Version: 2025081600\n─────\n'), []);
    });

    test('any deviation from the shape rejects the whole output', () => {
      const cases: Record<string, string> = {
        empty: '',
        'no header': REAL_LIST_PACKAGES.split('\n').slice(1).join('\n'),
        'no rule': REAL_LIST_PACKAGES.replace('─────\n', ''),
        'trailing junk': `${REAL_LIST_PACKAGES}junk\n`,
        'truncated entry': REAL_LIST_PACKAGES.split('\n').slice(0, -2).join('\n'),
        'bad TTC item': REAL_LIST_PACKAGES.replace('TTC Versions: 2025081600', 'TTC Versions: soon'),
        'bad version': REAL_LIST_PACKAGES.replace('base (0.8.0)', 'base (latest)'),
      };
      for (const [name, output] of Object.entries(cases)) {
        assert.strictEqual(parseListPackages(output), undefined, name);
      }
    });
  });

  suite('parseLspVersion', () => {
    test('a server built from a git checkout against a development compiler', () => {
      const parsed = parseLspVersion('Idris2 LSP: 0.1.0-9a2f0ad12\nIdris2 API: 0.8.0-1c630e6a2\n');
      assert.deepStrictEqual(parsed, {
        serverVersionLine: 'Idris2 LSP: 0.1.0-9a2f0ad12',
        serverVersion: { major: 0, minor: 1, patch: 0, tag: '9a2f0ad12', text: '0.1.0-9a2f0ad12' },
        apiVersionLine: 'Idris2 API: 0.8.0-1c630e6a2',
        apiVersion: { major: 0, minor: 8, patch: 0, tag: '1c630e6a2', text: '0.8.0-1c630e6a2' },
      });
    });

    test('release versions, CRLF and surrounding lines', () => {
      const parsed = parseLspVersion('note\r\nIdris2 LSP: 0.1.0\r\nIdris2 API: 0.8.0\r\nmore\r\n');
      assert.strictEqual(parsed?.serverVersion?.text, '0.1.0');
      assert.strictEqual(parsed?.apiVersion?.text, '0.8.0');
      assert.strictEqual(parsed?.apiVersion?.tag, undefined);
    });

    test('an unrecognised API version keeps the line', () => {
      const parsed = parseLspVersion('Idris2 LSP: 0.1.0\nIdris2 API: dev\n');
      assert.strictEqual(parsed?.apiVersionLine, 'Idris2 API: dev');
      assert.strictEqual(parsed?.apiVersion, undefined);
    });

    test('both lines are required: "Invalid Arguments", one line, empty output', () => {
      for (const output of ['Invalid Arguments\n', 'Idris2 LSP: 0.1.0\n', 'Idris2 API: 0.8.0\n', '']) {
        assert.strictEqual(parseLspVersion(output), undefined, JSON.stringify(output));
      }
    });
  });
});
