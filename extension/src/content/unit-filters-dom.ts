// DOM helpers for the "Current units" table's own column filter row on
// /units/my. Kept separate from dom-inject.ts, which is explicitly scoped
// to the Attendances page (see its own header comment) — this module knows
// nothing about factions/messaging, just how to read and drive this one
// table's native filter inputs.
import type { UnitFilterColumns } from '../types';
import { buildIconSvg } from './dom-inject';

export type ColumnKey = keyof UnitFilterColumns;

// Verified live: every column-filter input carries a stable
// aria-label="Filter by <Column>", present and queryable even while the
// filter row is toggled hidden (its containing element still has a real,
// non-zero layout box) — so reading/writing these never requires forcing
// the row open first. English only so far; the site is localized (French
// confirmed elsewhere in this extension) and these labels are unverified in
// French — same caveat this codebase already carries for
// REGISTRATION_DATE_LABELS/ATTENDANCE_LABELS in attendance.ts.
const COLUMN_FILTER_ARIA_LABELS: Record<ColumnKey, string[]> = {
  name: ['Filter by Name'],
  semester: ['Filter by Semester'],
  campus: ['Filter by Campus'],
  startDate: ['Filter by Start date'],
  endDate: ['Filter by End date'],
  registrations: ['Filter by Registrations'],
};

const SAVE_ICON_PATHS = [
  'M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2',
  'M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  'M14 4l0 4l-6 0l0 -4',
];

const RESET_ICON_PATHS = ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'];

// "Current units" is always the first .mrt-table-paper on this page — same
// anchor convention hijackExportButton already uses elsewhere
// (table.closest('.mrt-table-paper')). The independent "Past units" table
// below it is always [1] and must never be touched by this feature.
export function findCurrentUnitsPaper(): HTMLElement | undefined {
  return document.querySelectorAll<HTMLElement>('.mrt-table-paper')[0];
}

export function findColumnFilterInput(paper: HTMLElement, key: ColumnKey): HTMLInputElement | undefined {
  const labels = COLUMN_FILTER_ARIA_LABELS[key];
  return Array.from(paper.querySelectorAll<HTMLInputElement>('thead input')).find((input) =>
    labels.includes(input.getAttribute('aria-label') || ''),
  );
}

export function isComboboxInput(input: HTMLInputElement): boolean {
  return input.getAttribute('role') === 'combobox';
}

export function readColumnValue(input: HTMLInputElement): string {
  return input.value.trim();
}

// The verified React-controlled-input trick: bypasses React's own value
// tracking by going through the native property setter directly, then
// dispatches the same 'input' event React listens for. No-ops when already
// equal, so repeated calls (e.g. re-applying a preset on every remount)
// don't generate spurious events.
export function setNativeInputValue(input: HTMLInputElement, value: string): void {
  if (input.value === value) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// setTimeout, not requestAnimationFrame — confirmed live that rAF callbacks
// get throttled to a crawl (multi-second gaps between ticks) whenever this
// tab isn't the focused/foreground one, which stalled this exact polling
// for over 10 seconds on a single 2s-budgeted wait. A user who reloads the
// page and switches tabs while it loads would hit the same stall in real
// use, not just under automation.
export function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    function tick(): void {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (performance.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 30);
    }
    tick();
  });
}

// Semester/Campus look like multiselects but are confirmed single-select
// Mantine comboboxes (picking a second option replaces the first, verified
// live). Each has a sibling hidden input holding an opaque internal id
// (e.g. "83:2") that isn't safe to persist — not human-readable, not a
// stable public value — so the visible input's own label text (e.g.
// "BACH - S2") is what gets captured/matched here instead.
//
// The listbox MUST be resolved via this specific input's own aria-controls
// id, never a global `document.querySelector('[role="listbox"]')` —
// confirmed live that a global query can match a different, stray
// combobox's listbox that happens to be first in document order.
export async function setComboboxValue(input: HTMLInputElement, desiredLabel: string): Promise<boolean> {
  if (input.value.trim() === desiredLabel) return true;

  if (desiredLabel === '') {
    // No dedicated aria-label exists for the clear (x) button — verified
    // live it's identifiable only by this Mantine-internal class name, the
    // 4th button in the column's <th> alongside the filter/sort/menu ones.
    const clearBtn = input.closest('th')?.querySelector<HTMLButtonElement>('.mantine-InputClearButton-root');
    if (!clearBtn) {
      console.warn('[Epitools] could not find clear button for combobox filter — leaving current value');
      return false;
    }
    clearBtn.click();
    return true;
  }

  // Opening the dropdown is NOT triggered by focus/click on this
  // component (confirmed live: input.focus()+input.click(), even a full
  // pointerdown/mousedown/mouseup/click sequence, left aria-expanded
  // false) — it only opens in response to the input's own value actually
  // changing, the same native-setter + 'input' event trick used for the
  // plain text columns. Typing the desired label itself both opens the
  // list and pre-filters it to the matching option.
  //
  // Confirmed live that this can still be flaky — the value sets correctly
  // but aria-expanded sometimes never flips within a single attempt, for
  // reasons that didn't reproduce consistently even retesting the exact
  // same page. Retrying a few times (each with a fresh focus + value-reset
  // + re-dispatch) is cheap and turns an intermittent failure into a
  // reliable one instead of chasing the exact root cause further.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    if (attempt > 0) {
      setter?.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(() => true, 50);
    }
    input.focus();
    setter?.call(input, desiredLabel);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    opened = await waitFor(
      () => input.getAttribute('aria-expanded') === 'true' && !!input.getAttribute('aria-controls'),
      1000,
    );
  }
  if (!opened) return false;

  const listboxId = input.getAttribute('aria-controls')!;
  const listbox = document.getElementById(listboxId);
  if (!listbox) return false;

  const optionsReady = await waitFor(() => listbox.querySelectorAll('[role="option"]').length > 0, 2000);
  if (!optionsReady) return false;

  const options = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'));
  const match = options.find((opt) => opt.textContent?.trim() === desiredLabel);
  if (!match) {
    console.warn(`[Epitools] no exact option match for "${desiredLabel}" — leaving filter unchanged`);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  // A plain .click() reliably opened this element to view but never
  // committed a selection — confirmed live. Per spec, Element.click() only
  // fires a 'click' event, not the mousedown/mouseup pair a real click
  // produces; Mantine's option list appears to select on mousedown (likely
  // to win a race against the input's own blur closing the list first), so
  // the full sequence is required.
  const clickOpts = { bubbles: true, cancelable: true, view: window };
  match.dispatchEvent(new PointerEvent('pointerdown', clickOpts));
  match.dispatchEvent(new MouseEvent('mousedown', clickOpts));
  match.dispatchEvent(new PointerEvent('pointerup', clickOpts));
  match.dispatchEvent(new MouseEvent('mouseup', clickOpts));
  match.dispatchEvent(new MouseEvent('click', clickOpts));
  // The Select's own displayed value/open-state can update before MRT's
  // parent filter state (the thing that actually re-filters table rows)
  // catches up — confirmed live this can lag by a couple of seconds behind
  // the click. applyColumnsReliably (unit-filters.ts) is what actually
  // verifies the real outcome and retries if needed; this function's job
  // ends once the click has been dispatched.
  await waitFor(() => input.getAttribute('aria-expanded') !== 'true', 1000);
  return true;
}

export function isFilterRowToggledOn(paper: HTMLElement): boolean {
  const nameInput = findColumnFilterInput(paper, 'name');
  if (!nameInput) return false;
  // The input itself keeps a non-zero rect even when its row is visually
  // collapsed (verified live) — check the wrapper the row-collapse
  // animation actually shrinks instead.
  const wrapper = nameInput.closest('th > div > div') as HTMLElement | null;
  return (wrapper ?? nameInput).getBoundingClientRect().height > 0;
}

export function toggleFilterRow(paper: HTMLElement): void {
  const toolbar = paper.querySelector('[class*="ToolbarInternalButtons"]');
  const btn = Array.from(toolbar?.querySelectorAll('button') ?? []).find(
    (b) => b.getAttribute('aria-label') === 'Show/Hide filters',
  );
  btn?.click();
}

export interface UnitFiltersToolbarCallbacks {
  onSelect: (presetId: string) => void;
  onSave: () => void;
  onReset: () => void;
}

const TOOLBAR_CLASS = 'epitools-unit-filters-toolbar';

export function ensureUnitFiltersToolbar(
  paper: HTMLElement,
  callbacks: UnitFiltersToolbarCallbacks,
): HTMLElement | undefined {
  const existing = paper.querySelector<HTMLElement>(`.${TOOLBAR_CLASS}`);
  if (existing) return existing;

  const toolbar = paper.querySelector('[class*="ToolbarInternalButtons"]');
  if (!toolbar) {
    console.warn('[Epitools] could not find Current units toolbar to attach filter presets to');
    return undefined;
  }

  const wrap = document.createElement('div');
  wrap.className = TOOLBAR_CLASS;

  const select = document.createElement('select');
  select.className = 'epitools-unit-filters-select';
  select.addEventListener('change', () => callbacks.onSelect(select.value));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'epitools-unit-filters-save-btn';
  saveBtn.style.display = 'none';
  const iconWrap = document.createElement('span');
  iconWrap.className = 'epitools-unit-filters-save-icon';
  iconWrap.appendChild(buildIconSvg(SAVE_ICON_PATHS));
  saveBtn.appendChild(iconWrap);
  saveBtn.appendChild(document.createTextNode('Save filter'));
  saveBtn.addEventListener('click', () => callbacks.onSave());

  // Discards live, unsaved changes and re-drives the filters back to
  // whatever the selected preset itself holds — distinct from picking
  // "Default" (or another preset) from the select, which changes which
  // preset is selected; Reset keeps the current selection and just
  // reverts to it.
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'epitools-unit-filters-reset-btn';
  resetBtn.title = 'Reset filters to the selected preset';
  resetBtn.style.display = 'none';
  const resetIconWrap = document.createElement('span');
  resetIconWrap.className = 'epitools-unit-filters-reset-icon';
  resetIconWrap.appendChild(buildIconSvg(RESET_ICON_PATHS));
  resetBtn.appendChild(resetIconWrap);
  resetBtn.appendChild(document.createTextNode('Reset'));
  resetBtn.addEventListener('click', () => callbacks.onReset());

  wrap.appendChild(saveBtn);
  wrap.appendChild(resetBtn);
  wrap.appendChild(select);
  toolbar.insertBefore(wrap, toolbar.firstChild);

  return wrap;
}

const LOADER_CLASS = 'epitools-unit-filters-loader';

// Covers the table while a preset's filters are being driven onto it — the
// whole point is to stop the user from reading/acting on the table's
// pre-filter (or stale, mid-drive) contents, since applying a preset can
// take several seconds (combobox columns especially: opening the dropdown,
// waiting for options, retrying on the confirmed intermittent hydration
// race — see applyColumnsReliably). Positions relative to the given
// .mrt-table-paper, which the site's own CSS already establishes as the
// table's containing box.
export function showTableLoader(paper: HTMLElement): void {
  if (paper.querySelector(`.${LOADER_CLASS}`)) return;
  const prevPosition = paper.style.position;
  if (!prevPosition) paper.dataset.epitoolsLoaderRestorePosition = '1';
  paper.style.position = paper.style.position || 'relative';

  const overlay = document.createElement('div');
  overlay.className = LOADER_CLASS;
  const spinner = document.createElement('span');
  spinner.className = 'epitools-unit-filters-loader-spinner';
  overlay.appendChild(spinner);
  const label = document.createElement('span');
  label.textContent = 'Applying saved filter…';
  overlay.appendChild(label);
  paper.appendChild(overlay);
}

export function hideTableLoader(paper: HTMLElement): void {
  paper.querySelector(`.${LOADER_CLASS}`)?.remove();
  if (paper.dataset.epitoolsLoaderRestorePosition) {
    paper.style.position = '';
    delete paper.dataset.epitoolsLoaderRestorePosition;
  }
}

const CLEAR_WARNING_CLASS = 'epitools-unit-filters-clear-warning';

// The site's own Semester/Campus filter has a confirmed bug: clicking its
// native clear (x) button — the only way to unset a selected value — leaves
// its internal filter state desynced from what's displayed, in ways that
// vary (sometimes "No results found", sometimes the old filter silently
// stays applied) regardless of how the click is triggered (a genuine manual
// click reproduces it too). No in-place fix exists. Rather than silently
// leave the user looking at a stuck/wrong table, surface it explicitly so
// they know a plain page reload is what actually recovers it.
export function showClearFilterWarning(anchor: HTMLElement): void {
  document.querySelector(`.${CLEAR_WARNING_CLASS}`)?.remove();

  const toast = document.createElement('div');
  toast.className = CLEAR_WARNING_CLASS;
  toast.textContent =
    'This site has a known bug clearing Semester/Campus filters — if results look wrong, reload the page.';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'epitools-unit-filters-clear-warning-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => toast.remove());
  toast.appendChild(closeBtn);

  document.body.appendChild(toast);
  const rect = anchor.getBoundingClientRect();
  toast.style.top = `${window.scrollY + rect.bottom + 6}px`;
  toast.style.left = `${window.scrollX + rect.left}px`;

  setTimeout(() => toast.remove(), 8000);
}

export function rebuildPresetOptions(
  toolbar: HTMLElement,
  presets: { id: string; name: string }[],
  selectedId: string,
): void {
  const select = toolbar.querySelector<HTMLSelectElement>('.epitools-unit-filters-select');
  if (!select) return;
  select.replaceChildren();
  for (const preset of presets) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.name;
    select.appendChild(opt);
  }
  select.value = selectedId;
}

export function setSaveButtonVisible(toolbar: HTMLElement, visible: boolean): void {
  const btn = toolbar.querySelector<HTMLElement>('.epitools-unit-filters-save-btn');
  if (btn) btn.style.display = visible ? '' : 'none';
}

export function setResetButtonVisible(toolbar: HTMLElement, visible: boolean): void {
  const btn = toolbar.querySelector<HTMLElement>('.epitools-unit-filters-reset-btn');
  if (btn) btn.style.display = visible ? '' : 'none';
}

export function removeUnitFiltersToolbar(): void {
  document.querySelector(`.${TOOLBAR_CLASS}`)?.remove();
}
