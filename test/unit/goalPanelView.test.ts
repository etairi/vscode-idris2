// src/webview/view.ts: what the goal panel draws, on plain Node with a fake document (`DocumentLike`,
// the few members `draw` uses): the elements of a state, what each button sends, that all text
// goes in as text, and what survives a redraw.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { FromWebview, PanelState } from '../../src/webview/protocol';
import { draw, panelView, type DocumentLike, type ElementLike, type EventLike, type Ui } from '../../src/webview/view';
import { repoRoot } from '../fake-tools/paths';

class FakeElement implements ElementLike {
  id = '';
  className = '';
  title = '';
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
  placeholder?: string;
  private own: string | null = null;
  children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event: EventLike) => void>();
  focused = 0;
  constructor(readonly tag: string) {}
  get textContent(): string | null {
    return this.own ?? this.children.map((child) => child.textContent ?? '').join('');
  }
  set textContent(text: string | null) {
    this.own = text;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, listener: (event: EventLike) => void): void {
    this.listeners.set(type, listener);
  }
  appendChild(child: ElementLike): void {
    this.children.push(child as FakeElement);
  }
  replaceChildren(...children: ElementLike[]): void {
    this.children = children as FakeElement[];
  }
  focus(): void {
    this.focused++;
  }
  /** This element and everything below it. */
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

class FakeDom implements DocumentLike {
  activeElement: { readonly id?: string } | null = null;
  readonly root = new FakeElement('div');
  createElement(tag: string): ElementLike {
    return new FakeElement(tag);
  }
  getElementById(id: string): ElementLike | null {
    return this.root.all().find((e) => e.id === id) ?? null;
  }
}

const STATE: PanelState = {
  version: 7,
  file: 'Clean.idr',
  stale: false,
  goal: {
    label: '?vlen_rhs',
    qualifiedName: 'Clean.vlen_rhs',
    premises: [
      { name: 'a', text: '0 a : Type', canSplit: false, canJump: false },
      { name: 'xs', text: 'xs : Vect n a', canSplit: true, canJump: true },
    ],
    type: 'Nat',
  },
  holes: [{ label: '?vlen_rhs', type: 'Nat', place: 'Clean.idr:8', current: true }],
  moreHoles: 0,
  messages: [{ severity: 'error', line: 3, text: 'Undefined name x.' }],
  moreMessages: 0,
  options: { showImplicits: false, showMachineNames: true, fullNamespace: false },
  pinned: false,
  follow: true,
  cycle: false,
  caps: { editing: true, editingNext: true, intro: true, refine: true },
};

function drawn(state: Partial<PanelState> = {}, refine = ''): { dom: FakeDom; sent: FromWebview[]; ui: Ui; button(text: string): FakeElement; text(): string } {
  const dom = new FakeDom();
  const sent: FromWebview[] = [];
  const ui: Ui = { post: (message) => sent.push(message), refine };
  draw(dom, dom.root, panelView({ ...STATE, ...state }, ui));
  return {
    dom,
    sent,
    ui,
    button: (text) => {
      const found = dom.root.all().find((e) => e.tag === 'button' && e.textContent === text);
      assert.ok(found !== undefined, `no button ${text}`);
      return found;
    },
    text: () => dom.root.textContent ?? '',
  };
}

const click = (element: FakeElement): void => element.listeners.get('click')?.({});

suite('webview/view (the goal panel, as drawn)', () => {
  test('a goal: its name, premises and type, the buttons of the spec, and a tooltip with the qualified name', () => {
    const t = drawn();
    const text = t.text();
    for (const shown of ['?vlen_rhs', '0 a : Type', 'xs : Vect n a', 'Nat', 'All holes (1)', 'Messages (1)', 'Undefined name x.', 'error, line 3', 'Clean.idr:8']) {
      assert.ok(text.includes(shown), shown);
    }
    for (const name of ['Proof Search', 'Next', 'Intro', 'Make Lemma', 'Refine', 'Copy', 'Pin', 'Case Split', 'Jump']) {
      t.button(name);
    }
    assert.ok(t.dom.root.all().some((e) => e.tag === 'h2' && e.title === 'Clean.vlen_rhs'));
  });

  test('each button sends its message, naming only what the state shows', () => {
    const t = drawn({ cycle: true });
    for (const name of ['Proof Search', 'Next', 'Intro', 'Make Lemma', 'Case Split', 'Jump', 'Copy', 'Pin']) {
      click(t.button(name));
    }
    assert.deepStrictEqual(t.sent, [
      { type: 'action', action: 'proofSearch' },
      { type: 'action', action: 'nextResult' },
      { type: 'action', action: 'intro' },
      { type: 'action', action: 'makeLemma' },
      { type: 'premise', action: 'caseSplit', name: 'xs' },
      { type: 'premise', action: 'jump', name: 'xs' },
      { type: 'copy' },
      { type: 'toggle', option: 'pin' },
    ]);
  });

  test('a row sends its index and the state it belongs to', () => {
    const t = drawn();
    const rows = t.dom.root.all().filter((e) => e.className.startsWith('row'));
    assert.deepStrictEqual(rows.map((e) => e.className), ['row current', 'row error']);
    rows.forEach(click);
    assert.deepStrictEqual(t.sent, [{ type: 'hole', version: 7, index: 0 }, { type: 'message', version: 7, index: 0 }]);
  });

  test('what the backend or the state does not offer is disabled or absent', () => {
    const t = drawn({ cycle: false, caps: { editing: false, editingNext: true, intro: false, refine: false } });
    assert.strictEqual(t.button('Next').disabled, true, 'no cycle');
    assert.strictEqual(t.button('Proof Search').disabled, true);
    assert.strictEqual(t.button('Intro').disabled, true);
    assert.ok(!t.text().includes('Case Split'));
    assert.ok(!t.dom.root.all().some((e) => e.tag === 'input' && e.type === 'text'), 'no Refine input');
  });

  test('Refine: the input keeps what is typed; the button and Enter send it, and an empty one nothing', () => {
    const t = drawn();
    const input = t.dom.getElementById('refine-input') as FakeElement;
    assert.strictEqual(input.attributes.get('aria-label'), 'Expression to refine the hole with');
    click(t.button('Refine'));
    assert.deepStrictEqual(t.sent, []);
    input.listeners.get('input')?.({ target: { value: 'S' } });
    click(t.button('Refine'));
    input.listeners.get('input')?.({ target: { value: 'Z' } });
    let prevented = false;
    input.listeners.get('keydown')?.({ key: 'a' });
    input.listeners.get('keydown')?.({ key: 'Enter', preventDefault: () => (prevented = true) });
    assert.deepStrictEqual(t.sent, [{ type: 'refine', expression: 'S' }, { type: 'refine', expression: 'Z' }]);
    assert.strictEqual(prevented, true);
  });

  test('a redraw of the same hole keeps the typed text, a refused expression included, and gives the focus back; another hole clears it', () => {
    const dom = new FakeDom();
    const ui: Ui = { post: () => undefined, refine: '', refineFor: STATE.goal?.qualifiedName };
    draw(dom, dom.root, panelView(STATE, ui));
    (dom.getElementById('refine-input') as FakeElement).listeners.get('input')?.({ target: { value: 'S' } });
    dom.activeElement = dom.getElementById('refine-input');
    draw(dom, dom.root, panelView({ ...STATE, version: 8 }, ui));
    const input = dom.getElementById('refine-input') as FakeElement;
    assert.strictEqual(input.value, 'S');
    assert.strictEqual(input.focused, 1);
    dom.activeElement = null;
    const other = { ...(STATE.goal as NonNullable<PanelState['goal']>), qualifiedName: 'Clean.other' };
    draw(dom, dom.root, panelView({ ...STATE, version: 9, goal: other }, ui));
    assert.strictEqual((dom.getElementById('refine-input') as FakeElement).value, '');
  });

  test('without a goal: why, a ?name not checked yet, or a declaration with Generate Definition', () => {
    assert.match(drawn({ goal: undefined, file: undefined }).text(), /Open an Idris file/);
    assert.match(drawn({ goal: undefined }).text(), /Put the cursor on a hole/);
    assert.match(drawn({ goal: undefined, unknownHole: '?new' }).text(), /\?new has not been checked yet/);
    const t = drawn({ goal: undefined, declaration: { label: 'vlen', canGenerate: true } });
    click(t.button('Generate Definition'));
    assert.deepStrictEqual(t.sent, [{ type: 'action', action: 'generateDefinition' }]);
    assert.ok(!drawn({ goal: undefined, declaration: { label: 'f', canGenerate: false } }).text().includes('Generate Definition'));
  });

  test('the toggles show their state and send their option; pinned reads Unpin', () => {
    const t = drawn({ pinned: true });
    t.button('Unpin');
    const boxes = t.dom.root.all().filter((e) => e.tag === 'input' && e.type === 'checkbox');
    assert.deepStrictEqual(boxes.map((e) => e.checked), [false, true, false, true]);
    boxes.forEach((box) => box.listeners.get('change')?.({}));
    assert.deepStrictEqual(t.sent.map((m) => (m.type === 'toggle' ? m.option : m.type)), ['showImplicits', 'showMachineNames', 'fullNamespace', 'follow']);
  });

  test('the stale banner is always there, hidden unless stale, so that nothing moves; Save saves', () => {
    const fresh = drawn();
    assert.ok(fresh.dom.root.all().some((e) => e.className === 'stale hidden'));
    assert.strictEqual(fresh.button('Save').disabled, true);
    const stale = drawn({ stale: true });
    assert.ok(stale.dom.root.all().some((e) => e.className === 'stale'));
    click(stale.button('Save'));
    assert.deepStrictEqual(stale.sent, [{ type: 'save' }]);
  });

  test('choices: one button each, and Cancel', () => {
    const t = drawn({ choices: { prompt: 'What to put into the hole:', labels: ['0', 'S ?f_rhs_0'] } });
    assert.match(t.text(), /What to put into the hole:/);
    click(t.button('S ?f_rhs_0'));
    click(t.button('Cancel'));
    assert.deepStrictEqual(t.sent, [{ type: 'choose', index: 1 }, { type: 'choose' }]);
  });

  test('a list cut at its limit says how many more there are', () => {
    const t = drawn({ moreHoles: 3, moreMessages: 2 });
    assert.match(t.text(), /All holes \(4\)/);
    assert.match(t.text(), /and 3 more/);
    assert.match(t.text(), /Messages \(3\)/);
    assert.match(t.text(), /and 2 more/);
  });

  test('compiler text is set as text: markup in it stays text, and the sources build no HTML', () => {
    const markup = '<img src=x onerror=alert(1)>';
    const t = drawn({ goal: { ...(STATE.goal as NonNullable<PanelState['goal']>), type: markup } });
    assert.ok(t.text().includes(markup));
    assert.ok(t.dom.root.all().every((e) => e.tag !== 'img'));
    for (const file of ['view.ts', 'goalPanel.ts']) {
      const source = fs.readFileSync(path.join(repoRoot(), 'src', 'webview', file), 'utf8');
      assert.doesNotMatch(source.replace(/^\s*\*.*$/gm, ''), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, file);
    }
  });
});
