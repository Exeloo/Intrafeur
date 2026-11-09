// Permanent, saveable filter presets for the "Current units" table on
// /units/my. Purely local (storage.local, no backend) and page-specific —
// unlike attendance.ts's DOM-shape detection (reused across many pages),
// this feature only makes sense on one exact route, so it explicitly gates
// on location.pathname rather than trying to detect "is this the units
// page" from DOM shape alone.
import browser from 'webextension-polyfill';
import {
  type ColumnKey,
  findCurrentUnitsPaper,
  findColumnFilterInput,
  isComboboxInput,
  readColumnValue,
  setNativeInputValue,
  setComboboxValue,
  isFilterRowToggledOn,
  toggleFilterRow,
  ensureUnitFiltersToolbar,
  rebuildPresetOptions,
  setSaveButtonVisible,
  setResetButtonVisible,
  removeUnitFiltersToolbar,
  waitFor,
  showTableLoader,
  hideTableLoader,
} from './unit-filters-dom';
import { openSaveFilterModal, closeSaveFilterModal, type SaveFilterChoice } from './modal';
import type { UnitFilterColumns, UnitFilterPreset } from '../types';
import {
  UNIT_FILTER_PRESETS_KEY,
  UNIT_FILTER_SELECTED_KEY,
  UNIT_FILTER_DEFAULT_PRESET_ID,
  UNIT_FILTER_DEFAULT_COLUMNS,
} from '../types';
import { FLAGS } from '../settings';
import { t } from '../i18n/unit-filters';
import { watchDom } from './shared/dom-watch';
import { getLocal, onLocalChange, watchFlag } from './shared/ext-storage';
import { errorText, toast } from './shared/ui';

const COLUMN_KEYS: ColumnKey[] = ['name', 'semester', 'campus', 'startDate', 'endDate', 'registrations'];

const state = {
  presets: [] as UnitFilterPreset[],
  selectedPresetId: UNIT_FILTER_DEFAULT_PRESET_ID as string,
};

let toolbarEl: HTMLElement | null = null;
let activePaper: HTMLElement | null = null;
let toolbarButtonsShown: boolean | null = null;

function allPresetsForDisplay(): { id: string; name: string }[] {
  return [
    { id: UNIT_FILTER_DEFAULT_PRESET_ID, name: t('defaultPreset') },
    ...state.presets.map((p) => ({ id: p.id, name: p.name })),
  ];
}

// The built-in Default is synthesized (never stored); its name is translated at display.
function getPresetById(id: string): UnitFilterPreset {
  const preset = id === UNIT_FILTER_DEFAULT_PRESET_ID ? undefined : state.presets.find((p) => p.id === id);
  return preset ?? { id, name: t('defaultPreset'), columns: UNIT_FILTER_DEFAULT_COLUMNS };
}

function rebuildToolbarOptions(): void {
  if (toolbarEl) rebuildPresetOptions(toolbarEl, allPresetsForDisplay(), state.selectedPresetId);
}

function captureCurrentState(): UnitFilterColumns | null {
  const paper = findCurrentUnitsPaper();
  if (!paper) return null;
  const columns = {} as UnitFilterColumns;
  for (const key of COLUMN_KEYS) {
    const input = findColumnFilterInput(paper, key);
    columns[key] = input ? readColumnValue(input) : null;
  }
  return columns;
}

function columnsEqual(a: string | null, b: string | null): boolean {
  return a === null || b === null ? true : a === b;
}

function statesEqual(a: UnitFilterColumns, b: UnitFilterColumns): boolean {
  return COLUMN_KEYS.every((key) => columnsEqual(a[key], b[key]));
}

// Driving 6 inputs one after another (some of them async, via
// setComboboxValue's open/poll/click sequence) takes long enough that the
// body MutationObserver reacts to the DOM changes mid-way and can schedule
// a second, overlapping call (e.g. if MRT swaps the table's DOM node during
// its own re-render, check() sees a "new" paper and reapplies the same
// preset again). Two concurrent runs fighting over the same clear/select
// buttons was confirmed live to leave the table stuck on stale filtered
// results ("No results found") even after every input's own displayed
// value had already gone back to blank — only a full page reload recovered
// from it. A simple in-flight lock prevents that: a call that arrives while
// one is already running just waits for it, then applies its own (possibly
// different) target state cleanly afterward instead of racing it.
let applyInFlight: Promise<void> = Promise.resolve();

async function applyColumnsOnly(columns: UnitFilterColumns): Promise<void> {
  const run = async (): Promise<void> => {
    const paper = findCurrentUnitsPaper();
    if (!paper) return;

    // The .mrt-table-paper container can mount before the <thead> filter
    // inputs inside it finish rendering (confirmed live: on a fresh load,
    // every findColumnFilterInput call came back undefined the instant this
    // ran) — wait for the Name input specifically (present on every variant
    // of this table) as a stand-in for "the filter row has actually
    // rendered" before reading/comparing any column, so a fresh-load
    // reapply doesn't silently see "nothing found" and treat that as
    // "already matches, nothing to do" (permanently skipping it, since this
    // only runs once per table mount).
    await waitFor(() => !!findColumnFilterInput(paper, 'name'), 3000);
    // The input *element* existing isn't the same as Mantine/React having
    // finished wiring its event handlers to it — confirmed live that
    // combobox columns (Semester/Campus) can still silently fail to open in
    // response to a synthetic input event dispatched right when the Name
    // input first appears, even with several open-attempt retries, in a way
    // that didn't reproduce on every run (a genuine hydration race, not a
    // deterministic bug). A short fixed settle delay before touching
    // anything gives React's post-mount effects time to finish attaching.
    await waitFor(() => false, 400);

    // Only collect columns that actually need a change — '' (explicit
    // clear) is a real target value, not "nothing to do", so a preset
    // whose columns are all '' (e.g. Default) must never be treated as
    // "has values to show" just because none of them are null. Comparing
    // against each input's current value up front means applying a preset
    // that already matches the live filters (the common case: reapplying
    // the selected preset on every table remount) touches nothing in the
    // DOM at all — no funnel toggle, no clicks — instead of unconditionally
    // opening the filter row (and potentially re-triggering the body
    // MutationObserver into a self-sustaining loop of repeated toggles).
    const pending: { input: HTMLInputElement; value: string }[] = [];
    let willHitClearBug = false;
    for (const key of COLUMN_KEYS) {
      const value = columns[key];
      if (value == null) continue;
      const input = findColumnFilterInput(paper, key);
      if (!input || input.value.trim() === value) continue;
      // Clearing a combobox that currently holds a value is exactly the
      // interaction confirmed to trigger the site's own clear-button bug
      // (see showClearFilterWarning) — setting/changing a value, or
      // clearing an already-blank one, doesn't hit it.
      if (isComboboxInput(input) && value === '' && input.value.trim() !== '') willHitClearBug = true;
      pending.push({ input, value });
    }
    if (pending.length === 0) return;

    if (willHitClearBug) toast(t('clearBug'), 'info');

    if (!isFilterRowToggledOn(paper)) toggleFilterRow(paper);

    for (const { input, value } of pending) {
      if (isComboboxInput(input)) {
        await setComboboxValue(input, value);
      } else {
        setNativeInputValue(input, value);
      }
    }
  };

  const next = applyInFlight.then(run, run);
  applyInFlight = next.catch(() => undefined);
  return next;
}

// Wraps applyColumnsOnly with a verify-and-retry loop. Confirmed live that
// a single pass can fail to stick for combobox columns specifically —
// Semester/Campus sometimes never actually open in response to the
// synthetic events, for reasons that didn't reproduce deterministically
// (a genuine, intermittent React/Mantine hydration race, not a fixed bug
// with one root cause left to find). Retrying the whole apply again after a
// short pause — checking what actually landed rather than assuming success
// — converges reliably even though any single attempt might not.
async function applyColumnsReliably(columns: UnitFilterColumns): Promise<void> {
  const paper = findCurrentUnitsPaper();
  if (paper) showTableLoader(paper);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await applyColumnsOnly(columns);
      const captured = captureCurrentState();
      if (captured && statesEqual(captured, columns)) return;
      await waitFor(() => false, 400 + attempt * 300);
    }
  } finally {
    if (paper) hideTableLoader(paper);
  }
}

// Never navigates — driving the 6 inputs in place is sufficient now that
// the top-3 page-level dropdowns are out of scope (an earlier draft of this
// feature needed a full page reload for those; dropping them removed that
// entire code path).
async function applyPreset(id: string): Promise<void> {
  state.selectedPresetId = id;
  await browser.storage.local.set({ [UNIT_FILTER_SELECTED_KEY]: id });
  await applyColumnsReliably(getPresetById(id).columns);
  rebuildToolbarOptions();
  recomputeSaveButtonVisibility();
}

function reportApplyError(err: unknown): void {
  console.error('[Intrafeur] failed to apply unit filter preset', err);
  toast(t('applyFailed', { error: errorText(err) }), 'error');
}

function onSelectPreset(id: string): void {
  applyPreset(id).catch(reportApplyError);
}

function onSaveButtonClick(): void {
  const selected = getPresetById(state.selectedPresetId);
  openSaveFilterModal({
    currentPresetName: selected.name,
    isDefaultSelected: state.selectedPresetId === UNIT_FILTER_DEFAULT_PRESET_ID,
    onConfirm: (choice) =>
      onSaveModalConfirm(choice).catch((err) => toast(t('saveFailed', { error: errorText(err) }), 'error')),
  });
}

async function onSaveModalConfirm(choice: SaveFilterChoice): Promise<void> {
  const captured = captureCurrentState();
  if (!captured) return;

  if (choice.mode === 'create') {
    const preset: UnitFilterPreset = { id: crypto.randomUUID(), name: choice.name, columns: captured };
    state.presets.push(preset);
    state.selectedPresetId = preset.id;
  } else {
    const target = state.presets.find((p) => p.id === state.selectedPresetId);
    if (target) target.columns = captured;
  }

  await browser.storage.local.set({
    [UNIT_FILTER_PRESETS_KEY]: state.presets,
    [UNIT_FILTER_SELECTED_KEY]: state.selectedPresetId,
  });

  rebuildToolbarOptions();
  recomputeSaveButtonVisibility();
}

// Save and Reset share the exact same "does the live state differ from the
// selected preset" condition — Save persists the live state onto the
// preset, Reset discards the live state and reverts to it.
function recomputeSaveButtonVisibility(): void {
  if (!toolbarEl) return;
  const captured = captureCurrentState();
  if (!captured) return;
  const selected = getPresetById(state.selectedPresetId);
  const shouldShow = !statesEqual(captured, selected.columns);
  if (shouldShow === toolbarButtonsShown) return;
  toolbarButtonsShown = shouldShow;
  setSaveButtonVisible(toolbarEl, shouldShow);
  setResetButtonVisible(toolbarEl, shouldShow);
}

function onResetButtonClick(): void {
  applyColumnsReliably(getPresetById(state.selectedPresetId).columns)
    .then(() => recomputeSaveButtonVisibility())
    .catch(reportApplyError);
}

function normalizedPathname(): string {
  return location.pathname.replace(/\/$/, '') || '/';
}

function teardown(): void {
  removeUnitFiltersToolbar();
  toolbarEl = null;
  activePaper = null;
  toolbarButtonsShown = null;
  closeSaveFilterModal();
}

function check(): void {
  if (normalizedPathname() !== '/units/my') {
    if (toolbarEl) teardown();
    return;
  }

  const paper = findCurrentUnitsPaper();
  if (!paper) {
    activePaper = null;
    return;
  }

  if (!toolbarEl) {
    toolbarEl =
      ensureUnitFiltersToolbar(paper, {
        onSelect: onSelectPreset,
        onSave: onSaveButtonClick,
        onReset: onResetButtonClick,
      }) ?? null;
    rebuildToolbarOptions();
  }

  if (paper !== activePaper) {
    activePaper = paper;
    // A fresh mount of the table (first load, or an SPA remount after
    // navigating away and back) resets MRT's own filter state — restore
    // whatever preset is currently selected so it doesn't silently drift
    // back to blank. Never triggers a navigation itself.
    applyColumnsReliably(getPresetById(state.selectedPresetId).columns).catch(reportApplyError);
  }

  recomputeSaveButtonVisibility();
}

let stopDom: (() => void) | null = null;

function startWatching(): void {
  if (stopDom) return;
  // delay 0: setTimeout, never rAF — rAF is throttled to a crawl in
  // unfocused tabs and stalled the reapply-on-remount flow for 10+ s.
  stopDom = watchDom(check, { delay: 0 });
  // Typing in the text filters and picking a combobox option don't reliably
  // surface through a body-level MutationObserver alone (React-controlled
  // value changes aren't always DOM mutations the observer sees) — these
  // two delegated listeners catch both cases. Cheap and idempotent.
  document.addEventListener('input', onDocumentInput, true);
  document.addEventListener('click', onDocumentClick, true);
}

function onDocumentInput(): void {
  recomputeSaveButtonVisibility();
}

function onDocumentClick(): void {
  setTimeout(() => recomputeSaveButtonVisibility(), 50);
}

// Leaves the table's current filter values as they are: they're the site's
// own state, and clearing Semester/Campus would hit the MRT desync bug.
function stopWatching(): void {
  stopDom?.();
  stopDom = null;
  document.removeEventListener('input', onDocumentInput, true);
  document.removeEventListener('click', onDocumentClick, true);
  teardown();
}

function readPresets(value: unknown): UnitFilterPreset[] {
  return Array.isArray(value) ? (value as UnitFilterPreset[]) : [];
}

function readSelected(value: unknown): string {
  return typeof value === 'string' && value ? value : UNIT_FILTER_DEFAULT_PRESET_ID;
}

export async function init(): Promise<void> {
  const stored = await getLocal({
    [UNIT_FILTER_PRESETS_KEY]: [] as unknown,
    [UNIT_FILTER_SELECTED_KEY]: UNIT_FILTER_DEFAULT_PRESET_ID as unknown,
  });
  if (!stored) return; // extension context invalidated (stale tab)
  state.presets = readPresets(stored[UNIT_FILTER_PRESETS_KEY]);
  state.selectedPresetId = readSelected(stored[UNIT_FILTER_SELECTED_KEY]);

  onLocalChange([UNIT_FILTER_PRESETS_KEY, UNIT_FILTER_SELECTED_KEY], (changed) => {
    if (UNIT_FILTER_PRESETS_KEY in changed) state.presets = readPresets(changed[UNIT_FILTER_PRESETS_KEY]);
    if (UNIT_FILTER_SELECTED_KEY in changed) state.selectedPresetId = readSelected(changed[UNIT_FILTER_SELECTED_KEY]);
    rebuildToolbarOptions();
    if (UNIT_FILTER_SELECTED_KEY in changed) recomputeSaveButtonVisibility();
  });

  await watchFlag(FLAGS.unitFilters, (enabled) => (enabled ? startWatching() : stopWatching()));
}
