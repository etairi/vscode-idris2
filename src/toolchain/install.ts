/**
 * Guided installation (`toolchain/install.ts` in docs/ARCHITECTURE.md §2; ROADMAP M1, D22):
 * **Idris 2: Install Idris 2…**, **Idris 2: Install pack…** and **Idris 2: Install or Update
 * idris2-lsp with pack**. Each either opens a terminal with a command typed in — **never
 * executed**: `Terminal.sendText(text, false)` adds no line break, so nothing runs until the
 * user presses Enter (principle 8) — or opens installation instructions in the browser. Text
 * with a control character in it is never typed, nor on POSIX a pack path with a backslash
 * (`lspInstallAction`).
 *
 * Every install terminal starts in the home directory, never in the workspace folder (VS Code's
 * default): pack reads the `pack.toml` of the directory it runs in and of every parent directory
 * and merges them over its global configuration (`findInAllParentDirs`, idris2-pack `6baee7d`
 * `src/Pack/Config/Environment.idr` 482, `src/Pack/Core/IO.idr` 300–316 [src]), so in a project
 * directory `pack install-app idris2-lsp` would build the `idris2-lsp` that project's
 * `pack.toml` names, with the build-hook prompt switched off if that file says so
 * (`install.safety-prompt`), and pack's install script ends with `pack info` in the caller's
 * directory. The parents of a home directory are normally owned by root. Without a known home
 * directory (`usableHomeDirectory`) no terminal is opened and a warning shows the command.
 *
 * "Update" means the current collection's `idris2-lsp`: pack keys an installed application by
 * its commit, so `install-app` builds the commit pack's current collection names, and does
 * nothing for one already installed (`installApp`, `appStatus`, idris2-pack
 * `src/Pack/Runner/Install.idr` 414–441, `src/Pack/Runner/Database.idr` 240–253 [src]); a newer
 * commit comes with a newer collection (`pack switch latest`, pack's README [doc]).
 *
 * The commands and pages, checked on 2026-09-27:
 * - `brew install idris2`: Idris 2's INSTALL.md (line 26 on `main`) and the "Installing Using
 *   Homebrew" section of its tutorial (`docs/source/tutorial/starting.rst`) [doc].
 * - Idris 2's installation instructions for other systems: INSTALL.md on GitHub, which covers
 *   pack, Homebrew, Nix and building from source, with a note on MSYS2 for Windows; the URL
 *   answered HTTP 200 [doc].
 * - pack: `bash -c "$(curl -fsSL https://raw.githubusercontent.com/stefan-hoeck/idris2-pack/main/install.bash)"`,
 *   pack's README line 26 (F36), identical in the copy at 6baee7d and in the README on `main`
 *   that day; the script URL answered HTTP 200 [doc]. pack's INSTALL.md names no Windows
 *   route, so on Windows the command opens that page instead of a terminal.
 * - `pack install-app idris2-lsp`: pack's README ("Installing and removing applications") [doc].
 *
 * Only type imports from `vscode`: `extension.ts` passes the `vscode` namespace as `api`, so the
 * choice of action is unit-tested on plain Node.
 */
import type * as vscode from 'vscode';
import type { Config } from '../core/config';
import { DisposableStore, type IDisposable } from '../core/disposable';
import { plainText } from '../core/notificationText';
import type { PackState, ToolchainService } from './types';

export const INSTALL_IDRIS2_COMMAND = 'idris2.installIdris2';
export const INSTALL_PACK_COMMAND = 'idris2.installPack';
export const INSTALL_LSP_COMMAND = 'idris2.installIdris2Lsp';

export const IDRIS2_INSTALL_DOCS_URL = 'https://github.com/idris-lang/Idris2/blob/main/INSTALL.md';
export const PACK_INSTALL_DOCS_URL = 'https://github.com/stefan-hoeck/idris2-pack/blob/main/INSTALL.md';
export const BREW_INSTALL_IDRIS2 = 'brew install idris2';
export const PACK_INSTALL_COMMAND =
  'bash -c "$(curl -fsSL https://raw.githubusercontent.com/stefan-hoeck/idris2-pack/main/install.bash)"';

export type InstallAction =
  | {
      readonly kind: 'terminal';
      /** The terminal's name. */
      readonly name: string;
      /** Typed into the terminal without a line break. */
      readonly text: string;
      /** Pass `idris2.toolchain.env` to the terminal (pack reads `XDG_*` from it, as the search does). */
      readonly withToolchainEnv: boolean;
    }
  | { readonly kind: 'openUrl'; readonly url: string }
  /** Nothing can be typed; `reason` is shown instead. */
  | { readonly kind: 'refused'; readonly reason: string };

/** Install Idris 2…: Homebrew on macOS, the installation instructions elsewhere. */
export function idris2InstallAction(platform: NodeJS.Platform): InstallAction {
  return platform === 'darwin'
    ? { kind: 'terminal', name: 'Install Idris 2', text: BREW_INSTALL_IDRIS2, withToolchainEnv: false }
    : { kind: 'openUrl', url: IDRIS2_INSTALL_DOCS_URL };
}

/** Install pack…: pack's install script where a POSIX shell is the norm, its instructions on Windows. */
export function packInstallAction(platform: NodeJS.Platform): InstallAction {
  return platform === 'win32'
    ? { kind: 'openUrl', url: PACK_INSTALL_DOCS_URL }
    : { kind: 'terminal', name: 'Install pack', text: PACK_INSTALL_COMMAND, withToolchainEnv: true };
}

/**
 * `path` as one word of a command line. POSIX shells: bare when it has only characters no shell
 * treats specially, else single-quoted. Windows: VS Code's default terminal is PowerShell, where
 * a quoted command needs the call operator `&`. Inside single quotes PowerShell ends the string
 * at any of `'` and U+2018–U+201B (`IsSingleQuote`, PowerShell `src/System.Management.
 * Automation/engine/parser/CharTraits.cs` on `master`, read 2026-09-27 [src]), and a quote
 * written twice stands for itself (about_Quoting_Rules, "Including quote characters in a
 * string", with a doubled `‘‘` example [doc]), so each of them is doubled. Whether the user's
 * default terminal is PowerShell is not known [open].
 */
export function commandWord(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return /^[A-Za-z0-9_.:\\/-]+$/.test(path) ? path : `& '${path.replace(/['\u2018-\u201B]/g, (quote) => quote + quote)}'`;
  }
  return /^[A-Za-z0-9_.,:@%+=/-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Install or Update idris2-lsp with pack: `<pack> install-app idris2-lsp`, where `<pack>` is the
 * absolute path of the pack the scan found — the one Setup Information reports — rather than
 * the bare name, which the terminal's shell would resolve on its own `PATH` (pack's README asks
 * users to add `~/.local/bin` to it, which a fresh install may not have done yet). `undefined`
 * when pack was not found; `refused` when its path holds a control character, which the
 * terminal's shell would act on as it is typed (a line break or Ctrl-O runs the line in bash, a
 * tab completes), whatever the quoting, and on POSIX when it holds a backslash: `commandWord`'s
 * quoting is right for sh, bash and zsh, but fish reads `\'` and `\\` inside single quotes as
 * escapes ("The only meaningful escape sequences in single quotes are \' … and \\", fish manual,
 * "Quotes", fishshell.com/docs/current/language.html, read 2026-09-27 [doc]), so there a
 * backslash could end the quoted word early.
 */
export function lspInstallAction(pack: PackState | undefined, platform: NodeJS.Platform): InstallAction | undefined {
  if (pack?.status !== 'found') {
    return undefined;
  }
  const packPath = pack.info.location.path;
  // C0 controls, DEL and C1 controls.
  if (/[\u0000-\u001F\u007F-\u009F]/.test(packPath)) {
    return {
      kind: 'refused',
      reason: `pack's path ${JSON.stringify(packPath)} contains a control character, so the command is not typed into a terminal.`,
    };
  }
  if (platform !== 'win32' && packPath.includes('\\')) {
    return {
      kind: 'refused',
      reason: `pack's path ${JSON.stringify(packPath)} contains a backslash, which shells read differently inside quotes (fish), so the command is not typed into a terminal.`,
    };
  }
  return {
    kind: 'terminal',
    name: 'Install idris2-lsp',
    text: `${commandWord(packPath, platform)} install-app idris2-lsp`,
    withToolchainEnv: true,
  };
}

// -------------------------------------------------------------------------------------------
// The VS Code side
// -------------------------------------------------------------------------------------------

export type InstallApi = Pick<typeof vscode, 'commands' | 'window' | 'env' | 'Uri'>;

export interface InstallDeps {
  readonly toolchain: ToolchainService;
  readonly config: Pick<Config, 'toolchain'>;
  readonly platform: NodeJS.Platform;
  /** `usableHomeDirectory(os.homedir())`: the working directory of every install terminal. */
  readonly homeDir: string | undefined;
}

export function registerInstallCommands(api: InstallApi, deps: InstallDeps): IDisposable {
  const store = new DisposableStore();

  const perform = async (action: InstallAction): Promise<void> => {
    if (action.kind === 'openUrl') {
      await api.env.openExternal(api.Uri.parse(action.url));
      return;
    }
    if (action.kind === 'refused') {
      await api.window.showWarningMessage(plainText(`Idris 2: ${action.reason}`));
      return;
    }
    if (deps.homeDir === undefined) {
      // VS Code would start the shell in the workspace folder (see the module comment).
      await api.window.showWarningMessage(
        plainText(
          `Idris 2: the home directory is unknown, so no terminal is opened for "${action.text}" (a terminal would ` +
            "start in the workspace folder, whose pack.toml pack would read). Run it in a directory of your choice.",
        ),
      );
      return;
    }
    const env = action.withToolchainEnv ? deps.config.toolchain().env : {};
    const terminal = api.window.createTerminal({
      name: `Idris 2: ${action.name}`,
      cwd: deps.homeDir,
      ...(Object.keys(env).length > 0 ? { env: { ...env } } : {}),
    });
    terminal.show();
    terminal.sendText(action.text, false);
  };

  store.add(api.commands.registerCommand(INSTALL_IDRIS2_COMMAND, () => perform(idris2InstallAction(deps.platform))));
  store.add(api.commands.registerCommand(INSTALL_PACK_COMMAND, () => perform(packInstallAction(deps.platform))));
  store.add(
    api.commands.registerCommand(INSTALL_LSP_COMMAND, async () => {
      // Reachable without pack too: from the walkthrough, a keybinding or another extension.
      const snapshot = deps.toolchain.current ?? (await deps.toolchain.rescan('command'));
      const action = lspInstallAction(snapshot.pack, deps.platform);
      if (action !== undefined) {
        await perform(action);
        return;
      }
      const installPack = 'Install pack…';
      const choice = await api.window.showInformationMessage(
        plainText('idris2-lsp is installed with pack, and pack was not found. Install pack first, or set idris2.toolchain.packPath.'),
        installPack,
      );
      if (choice === installPack) {
        await api.commands.executeCommand(INSTALL_PACK_COMMAND);
      }
    }),
  );
  return store;
}
