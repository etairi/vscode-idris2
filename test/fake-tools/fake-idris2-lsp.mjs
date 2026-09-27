// fake-idris2-lsp: a stand-in for the `idris2-lsp` binary in integration tests
// (test/fake-tools/README.md). M1 needs only `--version`; M5 adds the language server.
//
// Nothing here was recorded: no idris2-lsp is installed on the development machine (ROADMAP §9
// Q2). The output follows idris2-lsp 9a2f0ad's source [src]:
//
//   main (src/Server/Main.idr 211–218): the arguments after the program name are matched as
//     ["--version"] → printVersion; [] → the server; anything else → `putStrLn "Invalid
//     Arguments"` (stdout, exit 0).
//   printVersion (206–209): `Idris2 LSP: <show Server.Version.version>` and
//     `Idris2 API: <show Idris.Version.version>`, each with putStrLn.
//   show is the compiler's showVersion True: <major>.<minor>.<patch>, then `-<tag>` when the
//     build has a tag (Libraries/Data/Version.idr 26–38). The server's version is 0.1.0 with the
//     Makefile's VERSION_TAG, which defaults to `git rev-parse --short=9 HEAD` in an untagged
//     checkout (Makefile 8–20, 58); 9a2f0ad6a is that value for 9a2f0ad.
//
// Environment:
//   FAKE_IDRIS2_LSP_VERSION      the text after `Idris2 LSP: ` (default 0.1.0-9a2f0ad6a)
//   FAKE_IDRIS2_LSP_API_VERSION  the text after `Idris2 API: ` (default 0.8.0, the version the
//                                fake idris2 prints, so the default pair is textually compatible)
//   FAKE_IDRIS2_LSP_MODE, FAKE_IDRIS2_LSP_DELAY_MS  faults.mjs; `garbage` prints what the real
//                                server prints for arguments it does not know (`Invalid Arguments`)
import process from 'node:process';
import { applyFaults, notImplemented } from './faults.mjs';

const TOOL = 'fake-idris2-lsp';

function setting(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

async function main(argv) {
  const mode = await applyFaults(TOOL, 'FAKE_IDRIS2_LSP');
  if (argv.length === 0) {
    // The real binary would start the language server on stdio (M5).
    notImplemented(TOOL, argv);
  }
  if (mode === 'garbage' || argv.length !== 1 || argv[0] !== '--version') {
    process.stdout.write('Invalid Arguments\n');
    return;
  }
  const server = setting('FAKE_IDRIS2_LSP_VERSION', '0.1.0-9a2f0ad6a');
  const api = setting('FAKE_IDRIS2_LSP_API_VERSION', '0.8.0');
  process.stdout.write(`Idris2 LSP: ${server}\nIdris2 API: ${api}\n`);
}

await main(process.argv.slice(2));
