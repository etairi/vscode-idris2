# Changelog

All notable changes to the "Idris 2" extension (`vscode-idris2`) are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/); the extension's version is
independent of Idris 2 releases (`docs/ROADMAP.md` §7.4).

## [Unreleased]

### Added

- Project skeleton, built to `docs/ARCHITECTURE.md` §2: manifest with the `idris2`, `lidr` and
  `ipkg` language contributions and their language configurations (no grammars yet), the
  `Idris 2: Show Output` command and the "Idris 2" log channel, the TypeScript 6 / esbuild /
  eslint / mocha / `@vscode/test-cli` harness with two unit test suites (`core/disposable`,
  `core/errors`) and one integration test suite, a
  GitHub Actions workflow (not yet executed), and the design documents under `docs/`.
