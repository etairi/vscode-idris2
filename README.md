# Idris 2 for Visual Studio Code (`vscode-idris2`)

**Status: engineering skeleton. Nothing user-facing works yet.**

This repository is the starting point for a Visual Studio Code extension for
[Idris 2](https://www.idris-lang.org/). The design is complete and lives in `docs/`; the code is
the harness every later increment plugs into. Features arrive milestone by milestone as laid
out in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## What is here today

- A manifest that declares three languages — `idris2` (`.idr`), `lidr` (`.lidr`) and `ipkg`
  (`.ipkg`) — each with a language configuration: `--` line comments for all three; `{- -}`
  block comments for `idris2` and `ipkg` (the `.ipkg` parser skips them, checked with
  `idris2 --dump-ipkg-json` on 0.8.0); bracket and quote pairs for the two Idris languages.
  `lidr` deliberately has **no** block-comment entry: in a bird-track literate file `{- -}` is
  only meaningful inside a `> ` code line, and VS Code's Toggle Block Comment over a selection
  of such lines wraps it in `{-` … `-}`, which `idris2 --check` (0.8.0) rejects with "Not the
  end of a block entry" whether or not a space follows the tokens (`{-> x : Nat` / `> x = 3-}`
  and `{- > x : Nat` / `> x = 3 -}` were both checked); `--` line toggling merely turns the line
  into prose and is safe. There are **no TextMate
  grammars yet**, so files open with the right language id but without syntax highlighting;
  grammars are the first item of milestone M0.
- One command, **Idris 2: Show Output**, which opens the extension's "Idris 2" log channel. The
  extension logs its version there when it activates. That is all `activate()` does. Both come
  from milestone M0's scope (`docs/ROADMAP.md` M0: the output channel from its user-visible
  outcome, the command from its backend-free **Help** group) and were pulled into the skeleton
  as the smallest activation proof for the harness; M0 adds the group's other two commands.
- `extensionKind: ["workspace"]` in the manifest, as `docs/ARCHITECTURE.md` §13 fixes it for
  the whole project (the backends will spawn local processes). Nothing spawns a process yet.
- The build, lint and test harness: TypeScript 6 + esbuild bundle, eslint (typescript-eslint
  flat config), mocha unit tests on Node, `@vscode/test-cli` integration tests in the Extension
  Host, a GitHub Actions workflow (written, not yet executed).
- The design documents: [`docs/landscape.md`](docs/landscape.md) (survey of the existing
  extensions, the compiler's IDE protocol and `idris2-lsp`), [`docs/ROADMAP.md`](docs/ROADMAP.md)
  (milestones M0–M16 and the verified facts F1–F36) and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the technical design this code follows).
  [`src/README.md`](src/README.md) and [`test/README.md`](test/README.md) map the planned source
  and test trees to the milestones that create them.

Not here yet: grammars, snippets, settings, a status item, the Idris compiler backends, and
every language feature. `vscode-languageclient` is declared as a dependency for the LSP backend
(M5) but is not imported by any code.

## Licence and repository

- Licensed under the [MIT licence](LICENSE).
- Source: <https://github.com/etairi/vscode-idris2>.
- The `publisher` field is `etairi`, provisionally: it makes local `vsce package` builds possible.
  A Marketplace publisher with that id has not been created yet, so nothing has been published
  (`docs/ROADMAP.md` M15).

## Requirements

- Node.js 24 and npm (developed with Node v24.13.0, npm 11.11.0).
- Visual Studio Code ≥ 1.138 (`engines.vscode`).
- No Idris toolchain is needed to build or test the skeleton. The fixture
  `test/fixtures/workspaces/loose-file/Hello.idr` was validated with `idris2 --check`
  (Idris 2 0.8.0).

## Build, run, test

```sh
npm install
npm run compile      # tsc --noEmit, eslint, esbuild → dist/extension.js
npm run watch        # the default build task in VS Code (tsc + esbuild in watch mode)
npm run test:unit    # mocha on Node: test/unit/**, no VS Code involved
npm test             # @vscode/test-cli: downloads VS Code into .vscode-test/ and runs
                     # test/integration/** in an Extension Host on the loose-file fixture
npm run package      # production (minified) bundle
```

In VS Code, **Run Extension** (F5) launches an Extension Development Host with the bundle from
`dist/`; **Extension Tests** is wired to the `integration` suite of `.vscode-test.mjs` through
js-debug's `testConfiguration` setting (present in VS Code 1.139; this launch configuration has
not been exercised by an automated run). The recommended extensions in
`.vscode/extensions.json` provide the eslint integration, the esbuild problem matcher used by
the watch task, and the Test Explorer integration for `.vscode-test.mjs`.

The integration tests pass `--user-data-dir=<checkout>/.vscode-test/user-data` explicitly. That
is the same directory `@vscode/test-electron` uses by default, so the flag only documents the
constraint: the Electron IPC socket created there must have a path shorter than 103 characters,
so keep the checkout at a short path (F17 in `docs/ROADMAP.md` §0).

## Privacy

The extension makes no network requests and collects no telemetry. Network access happens only
at development time: `npm install` fetches the packages in `package-lock.json`, and `npm test`
downloads a VS Code build into `.vscode-test/` for the integration tests.
