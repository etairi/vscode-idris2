/**
 * The contract of **Idris 2: Show Keybindings** (`idris2.showKeybindings`, the Help group of the
 * Idris 2 menu; ROADMAP §5 M4; `keybindings.ts`). Types only; no runtime code.
 *
 * **Show Keybindings** opens a read-only plain-text virtual document that lists the keyboard
 * shortcuts that are on for the scheme `Config.keybindingScheme()` reads (`auto` resolved for this
 * platform: `chords` on macOS, `prefix` elsewhere), each with its command's title, generated from
 * the contributed keybindings of the extension's own manifest (`ExtensionContext.extension.packageJSON`)
 * so that the list and the bindings cannot drift apart; for `none`, or a value that turns every
 * binding off, it says so and how to choose a scheme. The document follows a change of the setting
 * (`Config.onDidChange('keybindings')`). Next Result's `n` and Generate Definition's `g` are listed
 * with their second use (the next definition, `features/editing/types.ts`, *Cycling*). Changes made in the user's
 * `keybindings.json` are not read, and the document says so.
 */
import type { Config } from '../../core/config';

/** What `registerShowKeybindings` (`keybindings.ts`) needs besides the `vscode` namespace. */
export interface ShowKeybindingsDeps {
  /** `keybindingScheme()` and its change event (`onDidChange('keybindings')`). */
  readonly config: Pick<Config, 'keybindingScheme' | 'onDidChange'>;
  /** The extension's `package.json` (`ExtensionContext.extension.packageJSON`): its `contributes.keybindings` and `commands`. */
  readonly manifest: unknown;
  /** `process.platform`: which key `auto` binds. */
  readonly platform: NodeJS.Platform;
}
