/**
 * The messages between the goal panel's host (`features/goalPanel/host.ts`) and its webview
 * (`goalPanel.ts`, `view.ts`): docs/ARCHITECTURE.md §9. Types only, so that the webview's bundle gets
 * nothing of the host's and the host nothing of the webview's.
 *
 * The webview is a pure view of the last `PanelState`. Everything it sends names something of that
 * state (a premise, a row) and never a place: the host keeps the documents and positions itself
 * (`features/goalPanel/state.ts` `PanelTargets`) and checks every message (`isFromWebview`), so that
 * text in the panel cannot make a message about anything else.
 *
 * Every text here is compiler text or the file's, made visible by the host (`core/untrustedText.ts`
 * `visible`), and the webview only ever sets it as text content (`view.ts`, *Untrusted text*).
 */

/** A local variable of a hole. */
export interface PremiseView {
  /** The name, as the message `premise` sends it back. */
  readonly name: string;
  /** `0 a : Type`, `1 x : a`, `xs : Vect n a`; an implicit in braces, when the backend says so. */
  readonly text: string;
  /** Case Split is offered: its clause is one the compiler splits (`PatternVariableTarget.offered`). */
  readonly canSplit: boolean;
  /** Jump is offered: a left-hand side around the hole binds it. */
  readonly canJump: boolean;
}

/** The hole the panel shows. */
export interface GoalView {
  /** `?vlen_rhs`. */
  readonly label: string;
  /** `Clean.vlen_rhs`. */
  readonly qualifiedName: string;
  readonly premises: readonly PremiseView[];
  /** The type the hole must have. */
  readonly type: string;
}

/** A type declaration at the cursor that has no clauses. */
export interface DeclarationView {
  /** `vlen`. */
  readonly label: string;
  /** Generate Definition is offered (`DeclarationTarget`: one name, no clauses, not foreign). */
  readonly canGenerate: boolean;
}

/** A line of **All holes**. */
export interface HoleRow {
  readonly label: string;
  readonly type: string;
  /** Where it is: `src/Clean.idr:8`. */
  readonly place: string;
  /** It is the hole shown (`GoalView`). */
  readonly current: boolean;
}

export type MessageSeverity = 'error' | 'warning' | 'information';

/** A line of **Messages**. */
export interface MessageRow {
  readonly severity: MessageSeverity;
  /** The 1-based line it is on. */
  readonly line: number;
  readonly text: string;
}

/** What the panel can ask the backend for (`Capabilities`). */
export interface PanelCapabilities {
  readonly editing: boolean;
  readonly editingNext: boolean;
  readonly intro: boolean;
  readonly refine: boolean;
}

/** The compiler's printing options (`core/config.ts` `DisplayOptions`). */
export interface PanelOptions {
  readonly showImplicits: boolean;
  readonly showMachineNames: boolean;
  readonly fullNamespace: boolean;
}

/** What to pick, when a command's answer leaves a choice (Intro, an ambiguous Refine). */
export interface ChoicesView {
  readonly prompt: string;
  readonly labels: readonly string[];
}

/** Everything the panel shows. */
export interface PanelState {
  /** Grows with every state: the webview ignores an older one, and acknowledges the ones it draws. */
  readonly version: number;
  /** The file the panel follows; absent when there is none. */
  readonly file?: string;
  /** The text changed since the compiler last read it: what is shown may be out of date. */
  readonly stale: boolean;
  readonly goal?: GoalView;
  /** A `?name` at the cursor that no check has reported yet. */
  readonly unknownHole?: string;
  readonly declaration?: DeclarationView;
  readonly choices?: ChoicesView;
  readonly holes: readonly HoleRow[];
  /** The holes not listed, past the limit of the list. */
  readonly moreHoles: number;
  readonly messages: readonly MessageRow[];
  /** The messages not listed, past the limit of the list. */
  readonly moreMessages: number;
  readonly options: PanelOptions;
  readonly pinned: boolean;
  /** `idris2.goalPanel.followCursor`. */
  readonly follow: boolean;
  /** A Proof Search or Generate Definition cycle runs in the file of the buttons: Next continues it. */
  readonly cycle: boolean;
  readonly caps: PanelCapabilities;
}

/** The host's only message: what to show. */
export interface ToWebview {
  readonly type: 'state';
  readonly state: PanelState;
}

/** The buttons of a hole or a declaration. */
export type GoalAction = 'proofSearch' | 'nextResult' | 'intro' | 'makeLemma' | 'generateDefinition';

/** The toggles of the panel. */
export type PanelToggle = keyof PanelOptions | 'pin' | 'follow';

export type FromWebview =
  /** The script runs: the host sends the state. */
  | { readonly type: 'ready' }
  /** `version` is drawn; `text` is what the panel shows (for the tests, which cannot read a webview). */
  | { readonly type: 'rendered'; readonly version: number; readonly text: string }
  | { readonly type: 'action'; readonly action: GoalAction }
  | { readonly type: 'refine'; readonly expression: string }
  /** About the premise of that name of the hole shown. */
  | { readonly type: 'premise'; readonly action: 'caseSplit' | 'jump'; readonly name: string }
  /** The row `index` of `PanelState.holes` of `version`. */
  | { readonly type: 'hole'; readonly version: number; readonly index: number }
  /** The row `index` of `PanelState.messages` of `version`. */
  | { readonly type: 'message'; readonly version: number; readonly index: number }
  /** The label `index` of `PanelState.choices`; without it, none. */
  | { readonly type: 'choose'; readonly index?: number }
  | { readonly type: 'toggle'; readonly option: PanelToggle }
  | { readonly type: 'copy' }
  | { readonly type: 'save' };
