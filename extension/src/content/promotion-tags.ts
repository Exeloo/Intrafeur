// "Improve promotion tags" (FLAGS.promotionTags, off by default): on the
// site's promotion selector (same component on dashboard, units, projects,
// planning…), sorts the tags and the dropdown options alphabetically, and adds
// an eye button to each tag that hides the promotion while keeping its tag.
//
// MAIN world: the selector is recognised from its fiber props
// {options:[{value,label}], selected, onChange(values)} whose option values
// are all promotion-shaped ("PGE:2031"), not from labels or URLs.
//
// Hiding really deselects the promotion through the selector's own onChange
// (verified live 2026-11: URL updated by replace, no history entry), so every
// page filters natively, even those that filter client-side (units). A
// "ghost" copy of its tag (built by us, never React's) stays in place, struck
// through, with an eye to select it again and a × to forget it.
//
// Shared between pages: the site keeps one selection per page section
// (scheduler-/unit-/project-/shared-filters); we keep one for all of them
// ({selected, hidden} in page localStorage: the MAIN world can't read
// extension storage). A selector seen for the first time (page load,
// navigation) takes the shared selection; every later change there is saved.
//
// Moving the tags/options among their siblings is safe (verified: React only
// removes them / inserts relative to a sibling); we re-sort on the next check.
import { fiberOf } from './fiber-extract';
import { svgIcon } from './shared/mantine';
import { datasetAttr, watchDom } from './shared/dom-watch';
import { FLAGS, mirroredFlagOn } from '../settings';
import { t } from '../i18n/promotion-tags';

const PROMO_VALUE = /^[A-Za-z][\w-]*:\d{4}$/;
const STORE_KEY = 'epitools-promotions';
const GHOST_ATTR = 'data-epitools-promo-ghost';
// Colour by position in *our* list (hidden copies included), applied by CSS
// !important: the site colours by position in its selection, so every tag
// after a hidden one would change colour. React never touches this attribute.
const COLOR_ATTR = 'data-epitools-promo-color';
const EYE_CLASS = 'epitools-promo-eye';
const CHIP_SELECTOR = ':scope > p.mantine-Text-root ~ button.mantine-UnstyledButton-root';
// Tabler eye / eye-off.
const EYE = ['M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6'];
const EYE_OFF = [
  'M10.585 10.587a2 2 0 0 0 2.829 2.828',
  'M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87',
  'M3 3l18 18',
];

interface Selector {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** The site's palette: (value, index) -> Mantine colour name (verified live 2026-11). */
  chipColor?: (value: string, index: number) => unknown;
}

function selectorOf(el: Element, maxDepth: number): Selector | null {
  let fiber = fiberOf(el);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const p = fiber.memoizedProps;
    if (p && Array.isArray(p.options) && Array.isArray(p.selected)) {
      const promo =
        p.options.length > 0 &&
        typeof p.onChange === 'function' &&
        p.options.every((o: { value?: unknown; label?: unknown } | null) => typeof o?.value === 'string' && PROMO_VALUE.test(o.value) && typeof o.label === 'string');
      return promo ? (p as unknown as Selector) : null;
    }
  }
  return null;
}

// --- Shared state (page localStorage) ---

interface State {
  /** Visible selection (null: never saved yet, the page keeps its own). */
  selected: string[] | null;
  hidden: string[];
}

function promoList(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && PROMO_VALUE.test(x)))].slice(0, 50) : [];
}

function load(): State {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as { selected?: unknown; hidden?: unknown } | null;
    return { selected: Array.isArray(raw?.selected) ? promoList(raw.selected) : null, hidden: promoList(raw?.hidden) };
  } catch {
    return { selected: null, hidden: [] };
  }
}

function save(patch: Partial<State>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...load(), ...patch }));
  } catch {
    // Storage blocked: the change only lasts until reload.
  }
}

const hiddenList = (): string[] => load().hidden;
const setHidden = (hidden: string[]): void => save({ hidden: [...new Set(hidden)] });

// --- Selection changes (one at a time per group, until React catches up) ---

const pending = new WeakMap<Element, { want: string; at: number }>();
// Per mounted group: the selection seen at the last check (absent = first sight).
const seen = new WeakMap<Element, string[]>();

// As a set: the site may keep its own order.
const setKey = (values: string[]) => [...values].sort().join('|');

function change(group: Element, sel: Selector, values: string[]): void {
  pending.set(group, { want: setKey(values), at: Date.now() });
  sel.onChange(values);
}

function busy(group: Element, sel: Selector): boolean {
  const p = pending.get(group);
  if (!p) return false;
  if (p.want === setKey(sel.selected) || Date.now() - p.at > 2000) {
    pending.delete(group);
    return false;
  }
  return true;
}

// --- DOM ---

function label(chip: Element): string {
  return chip.querySelector(':scope > p')?.textContent?.trim() ?? '';
}

// Reorders `items` (siblings) by label, only when out of order (a write wakes the observer).
function sortSiblings(items: HTMLElement[], text: (e: HTMLElement) => string): void {
  const cmp = (a: HTMLElement, b: HTMLElement) => text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' });
  if (items.length < 2 || items.every((e, i) => i === 0 || cmp(items[i - 1], e) <= 0)) return;
  const parent = items[0].parentElement;
  if (!parent) return;
  const anchor = items[items.length - 1].nextSibling;
  for (const e of [...items].sort(cmp)) parent.insertBefore(e, anchor);
}

function stop(ev: Event): void {
  ev.preventDefault();
  ev.stopPropagation();
}

// The site colours tags by position (a CSS variable on the label): the eye follows it.
function followColor(chip: Element): void {
  const btn = chip.querySelector<HTMLElement>(`:scope > .${EYE_CLASS}`);
  const color = chip.querySelector<HTMLElement>(':scope > p')?.style.color ?? '';
  if (btn && btn.style.color !== color) btn.style.color = color;
}

// Between the tag's label and its ×; same colour as the label. State written only on change.
function syncEye(chip: HTMLElement, hidden: boolean, onClick: () => void): void {
  const x = chip.querySelector<HTMLElement>(':scope > button.mantine-UnstyledButton-root');
  if (!x) return;
  let btn = chip.querySelector<HTMLButtonElement>(`:scope > .${EYE_CLASS}`);
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = EYE_CLASS;
    const size = x.querySelector('svg')?.getAttribute('width');
    if (size) btn.style.setProperty('--promo-eye-size', `${size}px`);
    // The tag (and the selector around it) must not see it.
    btn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
  }
  if (btn.nextElementSibling !== x) x.before(btn);
  followColor(chip);
  btn.onclick = (ev) => {
    stop(ev);
    onClick();
  };
  const state = `${hidden}|${document.documentElement.dataset.epitoolsLang ?? ''}`;
  if (btn.dataset.state === state) return;
  btn.dataset.state = state;
  btn.replaceChildren(svgIcon('currentColor', hidden ? 'eye-off' : 'eye', hidden ? EYE_OFF : EYE));
  const text = hidden ? t('show') : t('hide');
  btn.title = text;
  btn.setAttribute('aria-label', text);
  btn.setAttribute('aria-pressed', String(hidden));
}

// A copy of the site's tag (its markup, verified live 2026-11: Box > [Text, UnstyledButton × (tabler x 11px)]),
// built from scratch so it exists even when every promotion is hidden. Colour: COLOR_ATTR.
function buildGhost(value: string): HTMLElement {
  const ghost = document.createElement('div');
  ghost.setAttribute(GHOST_ATTR, value);
  ghost.setAttribute(
    'style',
    'align-items: center; gap: 6px; padding-left: calc(0.625rem * var(--mantine-scale)); padding-right: calc(0.375rem * var(--mantine-scale)); border: calc(0.0625rem * var(--mantine-scale)) solid var(--mantine-color-gray-outline); background: var(--mantine-color-gray-light); min-height: calc(2.25rem * var(--mantine-scale)); display: inline-flex;',
  );
  const p = document.createElement('p');
  p.className = 'mantine-focus-auto m_b6d8b162 mantine-Text-root';
  p.setAttribute('style', 'font-family: "Space Mono", monospace; font-size: calc(0.6875rem * var(--mantine-scale)); font-weight: 700;');
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'mantine-focus-auto m_87cf2631 mantine-UnstyledButton-root';
  x.style.display = 'flex';
  const icon = svgIcon('currentColor', 'x', ['M18 6l-12 12', 'M6 6l12 12']);
  icon.setAttribute('width', '11');
  icon.setAttribute('height', '11');
  icon.setAttribute('stroke-width', '2.4');
  x.append(icon);
  ghost.append(p, x);
  // Keep the selector out of it.
  for (const type of ['pointerdown', 'mousedown', 'click']) ghost.addEventListener(type, (ev) => ev.stopPropagation());
  return ghost;
}

function removeOurs(group: Element): void {
  group.querySelectorAll(`:scope > [${GHOST_ATTR}], :scope > * > .${EYE_CLASS}`).forEach((n) => n.remove());
  group.querySelectorAll(`:scope > [${COLOR_ATTR}]`).forEach((n) => n.removeAttribute(COLOR_ATTR));
}

function syncGhost(group: HTMLElement, ghost: HTMLElement, value: string, text: string): void {
  const p = ghost.querySelector(':scope > p');
  if (p && p.textContent !== text) p.textContent = text;
  const x = ghost.querySelector<HTMLElement>(':scope > button.mantine-UnstyledButton-root');
  if (x) {
    x.onclick = (ev) => {
      stop(ev);
      setHidden(hiddenList().filter((v) => v !== value));
      ghost.remove();
    };
    if (x.title !== t('forget')) x.title = t('forget');
  }
  syncEye(ghost, true, () => {
    const now = selectorOf(group, 16);
    if (!now) return;
    setHidden(hiddenList().filter((v) => v !== value));
    // The copy stays until the real tag is back (the next check removes it): no gap.
    if (!now.selected.includes(value)) {
      const next = [...now.selected, value];
      seen.set(group, next);
      change(group, now, next);
    } else {
      ghost.remove();
    }
  });
}

function syncGroup(group: HTMLElement, sel: Selector): void {
  const all = Array.from(group.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.querySelector(CHIP_SELECTOR));
  const real = all.filter((c) => !c.hasAttribute(GHOST_ATTR));
  const enabled = mirroredFlagOn(FLAGS.promotionTags);
  let hidden = hiddenList();
  const known = new Map(sel.options.map((o) => [o.value, o.label]));

  if (!enabled) {
    // Turned off: give the hidden promotions back to the selection, once.
    removeOurs(group);
    seen.delete(group);
    const back = hidden.filter((v) => known.has(v) && !sel.selected.includes(v));
    if (hidden.length) setHidden([]);
    if (back.length && !busy(group, sel)) change(group, sel, [...sel.selected, ...back]);
    return;
  }
  // Even while waiting for the site: it re-colours the tags as soon as one goes.
  for (const chip of all) followColor(chip);
  if (busy(group, sel)) return;

  const prev = seen.get(group);
  if (!prev) {
    // First sight (page load, navigation): this page takes the shared selection,
    // as long as it knows some of it (another school year may not).
    seen.set(group, sel.selected);
    const { selected } = load();
    if (selected && [...selected, ...hidden].some((v) => known.has(v))) {
      const want = selected.filter((v) => known.has(v) && !hidden.includes(v));
      if (setKey(want) !== setKey(sel.selected)) {
        change(group, sel, want);
        return;
      }
    }
  }

  // Hidden promotions found selected: on first sight deselect them; later,
  // the user picked them from the dropdown, so they're shown again.
  const picked = sel.selected.filter((v) => hidden.includes(v));
  if (picked.length) {
    const added = prev ? picked.filter((v) => !prev.includes(v)) : [];
    if (added.length) {
      hidden = hidden.filter((v) => !added.includes(v));
      setHidden(hidden);
    }
    const still = sel.selected.filter((v) => hidden.includes(v));
    if (still.length) {
      seen.set(group, sel.selected);
      change(group, sel, sel.selected.filter((v) => !still.includes(v)));
      return;
    }
  }
  seen.set(group, sel.selected);
  // Settled: this is the selection now, for every page (values this page doesn't know are kept).
  const saved = load().selected;
  const next = [...(saved ?? []).filter((v) => !known.has(v)), ...sel.selected];
  if (!saved || setKey(next) !== setKey(saved)) save({ selected: next });

  // Real tags: eye to hide.
  const byLabel = new Map(sel.options.map((o) => [o.label, o.value]));
  for (const chip of real) {
    const value = byLabel.get(label(chip));
    if (!value) continue;
    // Hiding the last one empties the selection: the site then shows every promotion (its own behaviour).
    syncEye(chip, false, () => {
      const now = selectorOf(group, 16);
      if (!now || !now.selected.includes(value)) return;
      // The copy takes the tag's place right away, with its colour.
      const ghost = buildGhost(value);
      const color = chip.getAttribute(COLOR_ATTR);
      if (color) ghost.setAttribute(COLOR_ATTR, color);
      chip.before(ghost);
      syncGhost(group, ghost, value, label(chip));
      setHidden([...hiddenList(), value]);
      seen.set(group, now.selected.filter((v) => v !== value));
      change(group, now, now.selected.filter((v) => v !== value));
    });
  }

  // Ghost tags: one per hidden promotion of this selector.
  const ghosts = new Map(all.filter((c) => c.hasAttribute(GHOST_ATTR)).map((c) => [c.getAttribute(GHOST_ATTR) || '', c]));
  const want = hidden.filter((v) => known.has(v) && !sel.selected.includes(v));
  for (const [v, ghost] of ghosts) if (!want.includes(v)) ghost.remove();
  for (const value of want) {
    let ghost = ghosts.get(value);
    if (!ghost) {
      ghost = buildGhost(value);
      group.insertBefore(ghost, all[all.length - 1]?.nextSibling ?? null);
    }
    syncGhost(group, ghost, value, known.get(value) ?? value);
  }

  const chips = Array.from(group.children).filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.querySelector(CHIP_SELECTOR));
  sortSiblings(chips, label);
  if (typeof sel.chipColor !== 'function') return;
  chips.sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true, sensitivity: 'base' }));
  chips.forEach((chip, i) => {
    const value = chip.getAttribute(GHOST_ATTR) || byLabel.get(label(chip)) || '';
    const color = sel.chipColor!(value, i);
    if (typeof color === 'string' && /^[a-z]+$/.test(color) && chip.getAttribute(COLOR_ATTR) !== color) chip.setAttribute(COLOR_ATTR, color);
  });
}

// Each tag row also gets its own observer: its callback runs before the next
// paint, so a tag React just added/removed is sorted, coloured and swapped
// with its copy without a visible frame (the shared watcher is throttled).
const watched = new WeakSet<Element>();

function watchGroup(group: HTMLElement): void {
  if (watched.has(group)) return;
  watched.add(group);
  new MutationObserver(() => {
    if (!group.isConnected) return;
    const sel = selectorOf(group, 16);
    if (sel) syncGroup(group, sel);
  }).observe(group, { childList: true });
}

function check(): void {
  const groups = new Set<HTMLElement>();
  for (const x of Array.from(document.querySelectorAll('p.mantine-Text-root ~ button.mantine-UnstyledButton-root'))) {
    const group = x.parentElement?.parentElement;
    if (group && !group.closest('[role=dialog]')) groups.add(group);
  }
  // Every promotion hidden: no tag left, the row is found by its "Add" combobox trigger.
  if (hiddenList().length) {
    for (const trigger of Array.from(document.querySelectorAll('.mantine-Group-root > button.mantine-UnstyledButton-root[aria-haspopup]'))) {
      const group = trigger.parentElement;
      if (group instanceof HTMLElement && !group.closest('[role=dialog]')) groups.add(group);
    }
  }
  for (const group of groups) {
    const sel = selectorOf(group, 16);
    if (!sel) continue;
    syncGroup(group, sel);
    watchGroup(group);
  }
  if (!mirroredFlagOn(FLAGS.promotionTags)) return;
  for (const box of Array.from(document.querySelectorAll('.mantine-Combobox-options'))) {
    const opts = Array.from(box.children).filter((o): o is HTMLElement => o instanceof HTMLElement && o.getAttribute('role') === 'option');
    if (opts.length > 1 && selectorOf(box, 24)) sortSiblings(opts, (o) => o.textContent?.trim() ?? '');
  }
}

export function init(): void {
  // Former per-page hidden lists (before the shared state).
  try {
    localStorage.removeItem('epitools-hidden-promotions');
  } catch {
    // Storage blocked.
  }
  // Short throttle: the tags re-colour as soon as one goes, the eyes must follow.
  watchDom(check, { delay: 50, htmlAttributes: [datasetAttr(FLAGS.promotionTags.mirror)] });
  // Another tab's eye button.
  window.addEventListener('storage', (ev) => {
    if (ev.key === STORE_KEY) check();
  });
}
