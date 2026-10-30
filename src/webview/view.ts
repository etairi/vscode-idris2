/**
 * What the goal panel draws (docs/ARCHITECTURE.md §9): `panelView` makes the tree of elements of a
 * `PanelState`, and `draw` puts it into the document. No framework (ROADMAP §9 Q8) and no DOM types:
 * `draw` takes the few members it uses (`DocumentLike`), so that all of this runs in the unit tests
 * on plain Node.
 *
 * **Untrusted text.** Every text of a state is compiler text or the file's. It reaches the page only
 * through `textContent` and `title`, and nothing here builds HTML, so it is never read as markup; the
 * panel's Content-Security-Policy would refuse a script anyway (`features/goalPanel/html.ts`).
 *
 * **Drawing** replaces everything on each state: small enough not to matter (ROADMAP M7, *Risks*).
 * What the user is doing survives it: `Ui` keeps the Refine input's text, for as long as the same
 * hole is shown (so that a refused expression can be corrected), and `draw` gives the focus back to
 * the element that had it, by its id.
 */
import type { FromWebview, GoalAction, GoalView, PanelState, PanelToggle } from './protocol';

/** The parts of a DOM element `draw` uses. */
export interface ElementLike {
  id: string;
  className: string;
  textContent: string | null;
  title: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
  placeholder?: string;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: EventLike) => void): void;
  appendChild(child: ElementLike): unknown;
  replaceChildren(...children: ElementLike[]): void;
  focus(): void;
}

/** The parts of an event the panel reads. */
export interface EventLike {
  readonly key?: string;
  readonly target?: { readonly value?: string; readonly checked?: boolean } | null;
  preventDefault?(): void;
}

/** The parts of a DOM document `draw` uses. */
export interface DocumentLike {
  createElement(tag: string): ElementLike;
  getElementById(id: string): ElementLike | null;
  readonly activeElement: { readonly id?: string } | null;
}

/** An element to draw. */
export interface ElementSpec {
  readonly tag: string;
  readonly id?: string;
  readonly className?: string;
  readonly text?: string;
  readonly title?: string;
  readonly role?: string;
  readonly label?: string;
  readonly inputType?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly on?: Readonly<Record<string, (event: EventLike) => void>>;
  readonly children?: readonly ElementSpec[];
}

/** What the view does: send a message to the host, and remember what is being typed. */
export interface Ui {
  post(message: FromWebview): void;
  /** The text of the Refine input. */
  refine: string;
  /** The hole it was typed for (`GoalView.qualifiedName`). */
  refineFor?: string;
}

const REFINE_INPUT = 'refine-input';

const el = (tag: string, options: Omit<ElementSpec, 'tag' | 'children'> = {}, ...children: ElementSpec[]): ElementSpec => ({ tag, ...options, children });

const button = (text: string, onClick: () => void, options: Pick<ElementSpec, 'className' | 'title' | 'disabled'> = {}): ElementSpec =>
  el('button', { ...options, text, on: { click: onClick } });

/** A goal's button of `action`. */
const actionButton = (ui: Ui, text: string, action: GoalAction, enabled: boolean, title: string): ElementSpec =>
  button(text, () => ui.post({ type: 'action', action }), { disabled: !enabled, title });

/** A checkbox of the panel's bar. */
function toggle(ui: Ui, text: string, option: PanelToggle, checked: boolean, title: string): ElementSpec {
  return el(
    'label',
    { className: 'toggle', title },
    el('input', { inputType: 'checkbox', checked, on: { change: () => ui.post({ type: 'toggle', option }) } }),
    el('span', { text }),
  );
}

/** A heading with its count. */
const heading = (text: string, count: number): ElementSpec => el('h2', { text: `${text} (${count})` });

/** The line after a list cut at its limit. */
const andMore = (more: number): ElementSpec[] => (more > 0 ? [el('p', { className: 'muted', text: `and ${more} more` })] : []);

function refineInput(ui: Ui): ElementSpec {
  const refine = (): void => {
    if (ui.refine.trim() !== '') {
      ui.post({ type: 'refine', expression: ui.refine });
    }
  };
  return el(
    'div',
    { className: 'refine' },
    el('input', {
      id: REFINE_INPUT,
      inputType: 'text',
      value: ui.refine,
      placeholder: 'An expression, such as S or plus',
      label: 'Expression to refine the hole with',
      on: {
        input: (event) => {
          ui.refine = event.target?.value ?? '';
        },
        keydown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault?.();
            refine();
          }
        },
      },
    }),
    button('Refine', refine, { title: 'Replace the hole with this expression, which the compiler checks against its type' }),
  );
}

function goalSection(ui: Ui, state: PanelState, goal: GoalView): ElementSpec {
  const { caps } = state;
  const premises = goal.premises.map((premise) =>
    el(
      'div',
      { className: 'premise' },
      el('code', { text: premise.text }),
      ...(premise.canSplit && caps.editing ? [button('Case Split', () => ui.post({ type: 'premise', action: 'caseSplit', name: premise.name }), { title: `Split ${premise.name} into its cases` })] : []),
      ...(premise.canJump ? [button('Jump', () => ui.post({ type: 'premise', action: 'jump', name: premise.name }), { title: `Go to where ${premise.name} is bound` })] : []),
    ),
  );
  return el(
    'section',
    { className: 'goal' },
    el(
      'div',
      { className: 'title' },
      el('h2', { text: goal.label, title: goal.qualifiedName }),
      button(state.pinned ? 'Unpin' : 'Pin', () => ui.post({ type: 'toggle', option: 'pin' }), { title: 'Keep showing this hole wherever the cursor goes' }),
      button('Copy', () => ui.post({ type: 'copy' }), { title: 'Copy this goal as Markdown' }),
    ),
    ...premises,
    el('div', { className: 'rule', role: 'separator' }),
    el('code', { className: 'conclusion', text: goal.type }),
    el(
      'div',
      { className: 'actions' },
      actionButton(ui, 'Proof Search', 'proofSearch', caps.editing, 'Fill the hole with an expression the compiler finds'),
      actionButton(ui, 'Next', 'nextResult', caps.editingNext && state.cycle, 'Replace the last result of Proof Search or Generate Definition with the next one'),
      actionButton(ui, 'Intro', 'intro', caps.intro, 'Fill the hole with a constructor or a lambda of its type'),
      actionButton(ui, 'Make Lemma', 'makeLemma', caps.editing, 'Lift the hole into a top-level function'),
    ),
    ...(caps.refine ? [refineInput(ui)] : []),
  );
}

function choicesSection(ui: Ui, state: PanelState): ElementSpec[] {
  if (state.choices === undefined) {
    return [];
  }
  return [
    el(
      'section',
      { className: 'choices' },
      el('p', { text: state.choices.prompt }),
      ...state.choices.labels.map((label, index) => el('button', { className: 'choice', text: label, on: { click: () => ui.post({ type: 'choose', index }) } })),
      button('Cancel', () => ui.post({ type: 'choose' })),
    ),
  ];
}

/** What is shown in place of a goal. */
function noGoal(ui: Ui, state: PanelState): ElementSpec {
  if (state.unknownHole !== undefined) {
    return el('p', { className: 'muted', text: `${state.unknownHole} has not been checked yet.` });
  }
  if (state.declaration !== undefined) {
    const { label, canGenerate } = state.declaration;
    return el(
      'section',
      { className: 'declaration' },
      el('h2', { text: label }),
      ...(canGenerate ? [el('div', { className: 'actions' }, actionButton(ui, 'Generate Definition', 'generateDefinition', state.caps.editing, 'Write a definition of this declaration'))] : []),
    );
  }
  return el('p', { className: 'muted', text: state.file === undefined ? 'Open an Idris file to see its holes.' : 'Put the cursor on a hole (?name) to see its goal.' });
}

function bar(ui: Ui, state: PanelState): ElementSpec {
  const { options } = state;
  return el(
    'div',
    { className: 'bar' },
    toggle(ui, 'Implicits', 'showImplicits', options.showImplicits, 'Show implicit arguments'),
    toggle(ui, 'Machine names', 'showMachineNames', options.showMachineNames, 'Show the compiler\'s generated names'),
    toggle(ui, 'Namespaces', 'fullNamespace', options.fullNamespace, 'Show names with their namespaces'),
    toggle(ui, 'Follow cursor', 'follow', state.follow, 'Follow the active editor and its cursor'),
  );
}

/** Always there, hidden when not stale, so that the goal does not jump at every pause in typing. */
const staleBanner = (ui: Ui, state: PanelState): ElementSpec =>
  el(
    'div',
    { className: state.stale ? 'stale' : 'stale hidden' },
    el('span', { text: 'The file changed since the compiler last read it.' }),
    button('Save', () => ui.post({ type: 'save' }), { disabled: !state.stale, title: 'Save the file, which checks it' }),
  );

/** The tree of elements of `state`. */
export function panelView(state: PanelState, ui: Ui): ElementSpec {
  const { version } = state;
  if (ui.refineFor !== state.goal?.qualifiedName) {
    ui.refine = '';
    ui.refineFor = state.goal?.qualifiedName;
  }
  return el(
    'main',
    {},
    bar(ui, state),
    ...(state.file === undefined ? [] : [el('p', { className: 'file', text: state.file })]),
    staleBanner(ui, state),
    state.goal === undefined ? noGoal(ui, state) : goalSection(ui, state, state.goal),
    ...choicesSection(ui, state),
    el(
      'section',
      { className: 'holes' },
      heading('All holes', state.holes.length + state.moreHoles),
      ...state.holes.map((row, index) =>
        el(
          'button',
          { className: row.current ? 'row current' : 'row', title: row.place, on: { click: () => ui.post({ type: 'hole', version, index }) } },
          el('code', { text: `${row.label} : ${row.type}` }),
          el('span', { className: 'muted', text: row.place }),
        ),
      ),
      ...andMore(state.moreHoles),
    ),
    el(
      'section',
      { className: 'messages' },
      heading('Messages', state.messages.length + state.moreMessages),
      ...state.messages.map((row, index) =>
        el(
          'button',
          { className: `row ${row.severity}`, on: { click: () => ui.post({ type: 'message', version, index }) } },
          el('span', { className: 'muted', text: `${row.severity}, line ${row.line}` }),
          el('code', { className: 'message', text: row.text }),
        ),
      ),
      ...andMore(state.moreMessages),
    ),
  );
}

function create(document: DocumentLike, spec: ElementSpec): ElementLike {
  const element = document.createElement(spec.tag);
  element.id = spec.id ?? '';
  element.className = spec.className ?? '';
  if (spec.title !== undefined) {
    element.title = spec.title;
  }
  if (spec.text !== undefined) {
    element.textContent = spec.text;
  }
  if (spec.role !== undefined) {
    element.setAttribute('role', spec.role);
  }
  if (spec.label !== undefined) {
    element.setAttribute('aria-label', spec.label);
  }
  if (spec.inputType !== undefined) {
    element.type = spec.inputType;
  }
  if (spec.value !== undefined) {
    element.value = spec.value;
  }
  if (spec.placeholder !== undefined) {
    element.placeholder = spec.placeholder;
  }
  if (spec.checked !== undefined) {
    element.checked = spec.checked;
  }
  if (spec.disabled !== undefined) {
    element.disabled = spec.disabled;
  }
  for (const [type, listener] of Object.entries(spec.on ?? {})) {
    element.addEventListener(type, listener);
  }
  for (const child of spec.children ?? []) {
    element.appendChild(create(document, child));
  }
  return element;
}

/** Replaces what `root` shows with `spec`; the element with an id that had the focus gets it back. */
export function draw(document: DocumentLike, root: ElementLike, spec: ElementSpec): void {
  const focused = document.activeElement?.id;
  root.replaceChildren(create(document, spec));
  if (focused !== undefined && focused !== '') {
    document.getElementById(focused)?.focus();
  }
}
