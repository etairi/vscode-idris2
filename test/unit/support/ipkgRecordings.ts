/**
 * Output of the real `idris2 --dump-ipkg-json`, for the unit tests of `project/ipkg.ts` and
 * `project/index.ts`. Recorded 2026-09-27 on the development machine with
 * `/opt/homebrew/bin/idris2` (Homebrew idris2 0.8.0, macOS arm64, `idris2 --version` =
 * `Idris 2, version 0.8.0`): one process at a time, each run as `idris2 --dump-ipkg-json <file
 * name>` in the file's directory, stdout and stderr captured separately (neither a terminal).
 * The extension runs `idris2 --dump-ipkg-json <absolute path>` in the compiler's directory
 * instead (`readIpkgModel`); run that way, on copies of the fixtures, all 12 fixture runs below
 * printed the same stdout and stderr with the same exit code [live, 2026-09-27]. Generated from
 * those captures, not typed; `test/unit/ipkg.test.ts` checks that every package
 * file under `test/fixtures` has a recording here and still has the recorded SHA-256, so a
 * changed fixture needs a new recording.
 */

/** What one run printed. */
export interface DumpRecording {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A run on a fixture file; `file` is relative to the repository root, with `/`. */
export interface FixtureRecording extends DumpRecording {
  readonly file: string;
  readonly sha256: string;
}

/** A run on a file written for the recording only; `text` is its whole content. */
export interface TextRecording extends DumpRecording {
  readonly name: string;
  readonly text: string;
}

export const FIXTURE_RECORDINGS: readonly FixtureRecording[] = [
  {
    "file": "test/fixtures/grammar/Handwritten.ipkg",
    "sha256": "ffa8e7fde171b75718ac6916ac135db6f1efc08a8dc4e036c9195ae8d77fe7ad",
    "exitCode": 0,
    "stdout": "{\"name\": \"tally-handwritten\",\"depends\": [{\"contrib\": {\"lowerInclusive\": true,\"lowerBound\": \"*\",\"upperInclusive\": true,\"upperBound\": \"*\"}},{\"test\": {\"lowerInclusive\": true,\"lowerBound\": \"*\",\"upperInclusive\": true,\"upperBound\": \"*\"}}],\"modules\": [\"Main\",\"Tally\",\"Tally.Parse\",\"Tally.Parse.Lexer\",\"Tally.Report\"],\"version\": \"0.2.0\",\"main\": \"Main\",\"executable\": \"tally\",\"opts\": \"--no-color --console-width 0\",\"sourcedir\": \"ipkg-sources\",\"builddir\": \"tally_build\",\"outputdir\": \"tally_out\"}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/grammar/InitTemplate.ipkg",
    "sha256": "cec66cdccefeb9fd5f0e414ce2840aa6e025657de110a77dbdd53d195ad53535",
    "exitCode": 0,
    "stdout": "{\"name\": \"tally\",\"depends\": [{\"base\": {\"lowerInclusive\": true,\"lowerBound\": \"0.8.0\",\"upperInclusive\": true,\"upperBound\": \"*\"}},{\"contrib\": {\"lowerInclusive\": true,\"lowerBound\": \"*\",\"upperInclusive\": true,\"upperBound\": \"*\"}},{\"elab-util\": {\"lowerInclusive\": true,\"lowerBound\": \"*\",\"upperInclusive\": true,\"upperBound\": \"*\"}}],\"modules\": [\"Tally\",\"Tally.Parse\",\"Tally.Parse.Lexer\",\"Tally.Report\"],\"version\": \"0.1.0\",\"langversion\": {\"lowerInclusive\": true,\"lowerBound\": \"0.8.0\",\"upperInclusive\": true,\"upperBound\": \"*\"},\"authors\": \"A. N. Author\",\"license\": \"MIT\",\"brief\": \"Counts words (fixture for the ipkg grammar)\",\"main\": \"Main\",\"executable\": \"tally\",\"opts\": \"--total\",\"sourcedir\": \"ipkg-sources\"}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/grammar/Lexical.ipkg",
    "sha256": "69542a8c17a180aa85092c4aa0ee6788929620ead6b752f38d5b72c028b5caa4",
    "exitCode": 0,
    "stdout": "Warning: Deprecation warning: version numbers must now be of the form x.y.z\n{\"name\": \"tally-lexical\",\"depends\": [{\"base\": {\"lowerInclusive\": true,\"lowerBound\": \"0.5.1\",\"upperInclusive\": true,\"upperBound\": \"1.0\"}},{\"contrib\": {\"lowerInclusive\": true,\"lowerBound\": \"0.8.0\",\"upperInclusive\": true,\"upperBound\": \"0.8.0\"}},{\"network\": {\"lowerInclusive\": false,\"lowerBound\": \"0.1\",\"upperInclusive\": false,\"upperBound\": \"2\"}}],\"modules\": [\"Tally\",\"Tally.Parse\"],\"langversion\": {\"lowerInclusive\": true,\"lowerBound\": \"0.7.0\",\"upperInclusive\": false,\"upperBound\": \"1.0\"},\"brief\": \"a \\\"quoted\\\" word -- not a comment {- nor this -}\nover two lines\",\"main\": \"Tally\",\"executable\": \"tally cli\",\"sourcedir\": \"ipkg-sources\"}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/workspaces/simple-ipkg/simple.ipkg",
    "sha256": "45fbe92a34ee08c37f6315bd74257f336e853136f9a81a017d4daac3fbd38ea0",
    "exitCode": 0,
    "stdout": "{\"name\": \"simple\",\"depends\": [{\"contrib\": {\"lowerInclusive\": true,\"lowerBound\": \"*\",\"upperInclusive\": true,\"upperBound\": \"*\"}}],\"modules\": [\"Foo.A\",\"Foo.B\"],\"version\": \"0.1.0\",\"sourcedir\": \"src\"}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/ipkg/bad-property/bad.invalid.ipkg",
    "sha256": "25ba211c11125848a225046e060d6f0cae44889afd916481afb60901d5a27317",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Unrecognised property \"pkgs\".\n\n\"bad.invalid.ipkg\":3:1--3:5\n 1 | package bad\n 2 | sourcedir = \"src\"\n 3 | pkgs = contrib\n     ^^^^\n"
  },
  {
    "file": "test/fixtures/ipkg/trailing-comma/comma.invalid.ipkg",
    "sha256": "c1fbda8ad19e98083a4cc823c9887bbf415afb890fdebab24a6e7382a1bd1157",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Expected end of file.\n\n\"comma.invalid.ipkg\":2:24--2:25\n 1 | package comma\n 2 | depends = base, contrib,\n                            ^\n"
  },
  {
    "file": "test/fixtures/ipkg/two-ipkgs/first.ipkg",
    "sha256": "109c23ae268ef558d956343d1207a9b1cc322cbf632bc3358645410a3654afa3",
    "exitCode": 0,
    "stdout": "{\"name\": \"first\",\"depends\": [],\"modules\": []}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/ipkg/two-ipkgs/second.ipkg",
    "sha256": "f10a5f1a4c50617e461d81d05d1b058d7caeb80608c6c33e59ffd7fb43631f89",
    "exitCode": 0,
    "stdout": "{\"name\": \"second\",\"depends\": [],\"modules\": []}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/ipkg/literate/lit.ipkg",
    "sha256": "c297e8b76ae051ceef42d951328e9079977eed6317968d3b193d2f37fae59bef",
    "exitCode": 0,
    "stdout": "{\"name\": \"lit\",\"depends\": [],\"modules\": [\"Lit.Bird\",\"Lit.Mark\",\"Lit.Twice\"],\"sourcedir\": \"src\"}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/ipkg/escapes/esc.ipkg",
    "sha256": "6deaecab6e77d1c3fdc8d3be34e46500a40becafa0b858641b060d39fc758550",
    "exitCode": 0,
    "stdout": "{\"name\": \"esc\",\"depends\": [],\"modules\": [\"Esc.M\"],\"authors\": \"first line\nsecond line\",\"brief\": \"say \\\"hi\\\"\",\"sourcedir\": \"src\\\\main\"}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/ipkg/comments/comments.ipkg",
    "sha256": "d2ade99edc100cd229369b94c7bbfe4f1e68014d230af16fdf6d98d2a4a74724",
    "exitCode": 0,
    "stdout": "{\"name\": \"comments\",\"depends\": [],\"modules\": [],\"sourcedir\": \"a\",\"builddir\": \"b\"}\n",
    "stderr": ""
  },
  {
    "file": "test/fixtures/ipkg/versions/versions.ipkg",
    "sha256": "c13f79530f14824cf1d8aea18e6634591675f475e70ae2eaa59f8740f3593240",
    "exitCode": 0,
    "stdout": "Warning: Deprecation warning: version numbers must now be of the form x.y.z\n{\"name\": \"versions\",\"depends\": [{\"contrib\": {\"lowerInclusive\": true,\"lowerBound\": \"0.3\",\"upperInclusive\": false,\"upperBound\": \"1.0\"}},{\"base\": {\"lowerInclusive\": true,\"lowerBound\": \"0.8.0\",\"upperInclusive\": true,\"upperBound\": \"0.8.0\"}},{\"prelude\": {\"lowerInclusive\": true,\"lowerBound\": \"*\",\"upperInclusive\": true,\"upperBound\": \"2.10\"}}],\"modules\": [],\"langversion\": {\"lowerInclusive\": true,\"lowerBound\": \"0.5\",\"upperInclusive\": false,\"upperBound\": \"1\"},\"main\": \"Main\",\"executable\": \"my-exe\"}\n",
    "stderr": ""
  }
];

/**
 * Package files that exercise one rule of the grammar each: a field given twice, the forms of
 * `version` and `executable`, a second lower bound, a namespaced property, an unterminated
 * string, a `-` in a capitalised package name, character literals in a comment, a missing
 * module, and a bound without a version. Added in the M1 review (2026-09-27, same compiler,
 * same procedure): how the compiler reads the file (a byte-order mark at the start of the file,
 * at the start of line 2 and inside a line; a NUL at the start of a line and inside a string
 * literal, `project/ipkg.ts` `compilerView`), and a block comment that fails late (three nested
 * openers and an unterminated string: every alternative fails, so the lexer stops at `{`).
 */
export const TEXT_RECORDINGS: readonly TextRecording[] = [
  {
    "name": "twice.ipkg",
    "text": "package twice\nsourcedir = \"a\"\nsourcedir = \"b\"\ndepends = base\ndepends = contrib\n",
    "exitCode": 0,
    "stdout": "{\"name\": \"twice\",\"depends\": [{\"contrib\": {\"lowerInclusive\": true,\"lowerBound\": \"*\",\"upperInclusive\": true,\"upperBound\": \"*\"}}],\"modules\": [],\"sourcedir\": \"b\"}\n",
    "stderr": ""
  },
  {
    "name": "exe.ipkg",
    "text": "package exe\nexecutable = \"my exe\"\nversion = 1.-2.03\n",
    "exitCode": 0,
    "stdout": "{\"name\": \"exe\",\"depends\": [],\"modules\": [],\"version\": \"1.0.3\",\"executable\": \"my exe\"}\n",
    "stderr": ""
  },
  {
    "name": "exename.ipkg",
    "text": "package exename\nexecutable = my-exe\nversion = 1.2.3\nversion = \"0.9\"\n",
    "exitCode": 0,
    "stdout": "Warning: Deprecation warning: version numbers must now be of the form x.y.z\n{\"name\": \"exename\",\"depends\": [],\"modules\": [],\"version\": \"1.2.3\",\"executable\": \"my-exe\"}\n",
    "stderr": ""
  },
  {
    "name": "lower.ipkg",
    "text": "package lower\ndepends = base >= 0.1 && >= 0.2\n",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Dependency already has a lower bound.\n\n\"lower.ipkg\":3:1--3:2\n 1 | package lower\n 2 | depends = base >= 0.1 && >= 0.2\n     ^\n"
  },
  {
    "name": "ns.ipkg",
    "text": "package ns\nFoo.bar = 1\n",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Unrecognised property \"bar\".\n\n\"ns.ipkg\":2:1--2:8\n 1 | package ns\n 2 | Foo.bar = 1\n     ^^^^^^^\n"
  },
  {
    "name": "unterminated.ipkg",
    "text": "package u\nbrief = \"open\n",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Can't recognise token.\n\n\"unterminated.ipkg\":2:9--2:10\n 1 | package u\n 2 | brief = \"open\n             ^\n"
  },
  {
    "name": "dash.ipkg",
    "text": "package Foo-bar\n",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Can't recognise token.\n\n\"dash.ipkg\":1:12--1:13\n 1 | package Foo-bar\n                ^\n"
  },
  {
    "name": "chars.ipkg",
    "text": "package chars\n{- 'x' \"-}\" '\\n' '\\NUL' ' -}\nsourcedir = \"s\"\n",
    "exitCode": 0,
    "stdout": "{\"name\": \"chars\",\"depends\": [],\"modules\": [],\"sourcedir\": \"s\"}\n",
    "stderr": ""
  },
  {
    "name": "miss.ipkg",
    "text": "package miss\nmodules = Nope\n",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Module Nope not found\n\n\"miss.ipkg\":2:11--3:1\n\n"
  },
  {
    "name": "nosep.ipkg",
    "text": "package nosep\ndepends = contrib >= , base\n",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Expected end of file.\n\n\"nosep.ipkg\":2:19--2:21\n 1 | package nosep\n 2 | depends = contrib >= , base\n                       ^^\n"
  },
  {
    "name": "bom.ipkg",
    "text": "\uFEFFpackage bom\r\nsourcedir = \"src\"\r\n",
    "exitCode": 0,
    "stdout": "{\"name\": \"bom\",\"depends\": [],\"modules\": [],\"sourcedir\": \"src\"}\n",
    "stderr": ""
  },
  {
    "name": "bom2.ipkg",
    "text": "package bom2\n\uFEFFsourcedir = \"src\"\n",
    "exitCode": 0,
    "stdout": "{\"name\": \"bom2\",\"depends\": [],\"modules\": [],\"sourcedir\": \"src\"}\n",
    "stderr": ""
  },
  {
    "name": "bom3.ipkg",
    "text": "package bom3\nsourcedir = \uFEFF\"src\"\n",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Expected string.\n\n\"bom3.ipkg\":2:13--2:14\n 1 | package bom3\n 2 | sourcedir = \uFEFF\"src\"\n                 ^\n"
  },
  {
    "name": "nul.ipkg",
    "text": "package nul\n\u0000x\nsourcedir = \"s\"\n",
    "exitCode": 0,
    "stdout": "{\"name\": \"nul\",\"depends\": [],\"modules\": [],\"sourcedir\": \"s\"}\n",
    "stderr": ""
  },
  {
    "name": "nul2.ipkg",
    "text": "package nul2\nsourcedir = \"a\u0000junk\nb\"\n",
    "exitCode": 0,
    "stdout": "{\"name\": \"nul2\",\"depends\": [],\"modules\": [],\"sourcedir\": \"ab\"}\n",
    "stderr": ""
  },
  {
    "name": "late.ipkg",
    "text": "package late\n{-{-x{-x{-x\"",
    "exitCode": 1,
    "stdout": "",
    "stderr": "Error: Can't recognise token.\n\n\"late.ipkg\":2:1--2:2\n 1 | package late\n 2 | {-{-x{-x{-x\"\n     ^\n"
  }
];
