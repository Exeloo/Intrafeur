// Planning board, isolated world: replaces the planning's week/day calendar
// grid with our own, plus a search bar in the page header (left of the site's
// filters button) and, in planning or Intrastek mode, a left panel (Intrastek staffing, selected
// event details and actions). Selecting events is only possible in those two
// modes; otherwise a click opens the event. Data comes from the MAIN-world feed
// (planning-feed.ts) — exactly the events the site's FullCalendar shows, so
// every site filter applies — and is re-validated here (sanitizeFeed): ids
// are positive integers, text only ever goes through textContent.
//
// The site's toolbar (prev/today/next, month/week/day) stays and keeps
// driving the hidden native calendar; month view falls back to the native one.
// The popup's feature toggle is the only way back to the native week/day grid.
//
// The site's planning mode is integrated: its sidebar (plannable activities,
// rooms) stays left of the board; on the board, dragging a card
// moves the event, dragging on empty slots opens the site's creation modal,
// and plannable activities dropped from the sidebar are planned. All of it
// goes through the site's own FullCalendar handlers (planning-feed.ts), which
// stage drafts for the site's review/publish bar.
//
// Intrastek mode (key saved; INTRASTEK_MODE_KEY, only the header button cloned from
// and next to the site's planning-mode button): staffing colours/badges on
// the cards, the left Staffing panel and the editors. Exclusive with the
// site's planning mode: turning ours on clicks theirs off, theirs turning on
// turns ours off.
//
// Rendering is state-driven, never mutation-driven: the shared observer only
// makes sure the board is mounted at the right place (ensure), and the grid /
// panel sections re-render only when their signature changed.
import browser from 'webextension-polyfill';
import { buildIconSvg } from '../dom-inject';
import { datasetAttr, watchDom } from '../shared/dom-watch';
import { getLocal, onLocalChange } from '../shared/ext-storage';
import { button, el, spinner, toast } from '../shared/ui';
import { currentLang, currentLocale, LANG_DATASET_KEY } from '../../i18n/core';
import { t } from '../../i18n/planning-board';
import { FLAGS, flagValue } from '../../settings';
import {
  cachedState,
  currentMe,
  fetchStatus,
  formatEventDate,
  groupView,
  loadMe,
  meErrorText,
  onCacheChange,
  setPlanningIndex,
  targetGroupId,
} from '../intrastek-client';
import { mountBulkEditor, mountEventEditor } from '../intrastek-ui';
import { INTRASTEK_API_KEY_KEY, INTRASTEK_API_URL_KEY, INTRASTEK_DEFAULT_GROUP_KEY } from '../../types';
import { layoutLanes, parisClock, parisToIso, timeToMinutes, viewDays } from './layout';
import {
  ACTIVE_DATASET_KEY,
  COMMAND_SOURCE,
  NATIVE_ATTR,
  sanitizeDrag,
  sanitizeFeed,
  sanitizeRoomsDone,
  type BoardEvent,
  type BoardView,
  type CommandMessage,
  type RoomChange,
} from './protocol';

const BOARD_VIEWS = new Set(['timeGridWeek', 'timeGridDay']);
const PX_PER_MIN = 1.1;
const MIN_CARD_PX = 22;
const SNAP_MIN = 15;
const DRAG_THRESHOLD_PX = 5;
const IK_BUTTON_ATTR = 'data-epitools-ik-mode';
const ID_ATTR = 'data-pb-id';
const DAY_ATTR = 'data-pb-day';
// The site's ActionIcon variables, filled / default (captured live 2026-11).
const AI_STYLE = {
  on: '--ai-size: calc(2.25rem * var(--mantine-scale)); --ai-radius: 0rem; --ai-bg: var(--mantine-color-blue-filled); --ai-hover: var(--mantine-color-blue-filled-hover); --ai-color: var(--mantine-color-blue-contrast); --ai-bd: calc(0.0625rem * var(--mantine-scale)) solid transparent;',
  off: '--ai-size: calc(2.25rem * var(--mantine-scale)); --ai-radius: 0rem; --ai-bg: var(--mantine-color-default); --ai-hover: var(--mantine-color-default-hover); --ai-color: var(--mantine-color-default-color); --ai-bd: calc(0.0625rem * var(--mantine-scale)) solid var(--mantine-color-default-border);',
};
// Tabler users / link / hourglass (emoji render as tofu without an emoji font).
const ICONS: Record<string, string[]> = {
  users: ['M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2', 'M16 3.13a4 4 0 0 1 0 7.75', 'M21 21v-2a4 4 0 0 0 -3 -3.85'],
  link: ['M9 15l6 -6', 'M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464', 'M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463'],
  search: ['M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6'],
  wait: ['M6.5 7h11', 'M6.5 17h11', 'M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z', 'M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z'],
};

type IkState = 'initialized' | 'proposed' | 'none' | 'linked';

// --- State ---
let enabled: boolean = FLAGS.planningBoard.default;
let keyPresent = false;
// Intrastek mode: staffing shown on the board. Exclusive with the site's
// planning mode.
// Intrastek mode: no settings row, only the header button (state kept in storage.local).
const INTRASTEK_MODE_KEY = 'intrastekModeEnabled';
let ikMode = false;
let wasPlanningMode = false;
let configuredGroupId = '';
let view: BoardView | null = null;
let events: BoardEvent[] = [];
let feedVersion = 0;
let ikVersion = 0;
let statusError = '';
let search = '';
const selected = new Set<number>();

// --- DOM ---
let root: HTMLElement | null = null;
let searchBar: HTMLElement;
let leftPanel: HTMLElement;
let grid: HTMLElement;
let summary: HTMLElement;
let secIk: Section;
let secSel: Section;
let searchInput: HTMLInputElement;
// Grid geometry of the last render, for drag hit-testing.
let geom: { minM: number; maxM: number } | null = null;
let gridSig = '';
let ikSig = '';
let selSig = '';
let destroyEditor: (() => void) | null = null;
// A `rooms` command is running in the feed (until its done message).
let roomsBusy = false;
let roomsBusyTimer: ReturnType<typeof setTimeout> | undefined;
let nowLine: { el: HTMLElement; day: string; minM: number; maxM: number } | null = null;
// Paris day the grid was rendered for (today's column, now-line).
let renderedDay = '';

// --- Helpers ---

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(e: BoardEvent, query: string): boolean {
  if (!query) return true;
  return fold([e.title, e.unitCode, e.unitName, ...e.rooms, ...e.instructors].join(' ')).includes(query);
}

function hhmm(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60, minutes));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function currentTarget(): string | null {
  const me = currentMe();
  return me ? targetGroupId(me, configuredGroupId) : null;
}

function ikOn(): boolean {
  return keyPresent && ikMode;
}

function ikOf(id: number): { state: IkState; count: number } | null {
  if (!ikOn() || !currentMe() || !isReal(id)) return null;
  const st = cachedState(id);
  if (!st) return null;
  const v = groupView(st, currentTarget());
  const count = v.nbUserAsk !== null && v.nbUserAsk > 0 ? v.nbUserAsk : 0;
  if (v.linkedTo !== null) return { state: 'linked', count };
  if (v.proposal) return { state: 'proposed', count };
  return { state: v.initialized ? 'initialized' : 'none', count };
}

function icon(name: string): SVGSVGElement {
  const svg = buildIconSvg(ICONS[name]);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

type Command = CommandMessage extends infer C ? (C extends { source: unknown } ? Omit<C, 'source'> : never) : never;

function send(cmd: Command): void {
  window.postMessage({ source: COMMAND_SOURCE, ...cmd }, location.origin);
}

// Ids <= 0 are unpublished drafts: no event page, no Intrastek.
function isReal(id: number): boolean {
  return id > 0;
}

function openEvent(id: number): void {
  if (!isReal(id)) return;
  send({ cmd: 'open', id });
}

function eventLink(id: number): string {
  return `${location.origin}/planning?eventId=${id}`;
}

function visibleEvents(): BoardEvent[] {
  const q = fold(search.trim());
  return events.filter((e) => matches(e, q));
}

function boardApplies(calendar: Element | null): boolean {
  return enabled && !!calendar && !!view && BOARD_VIEWS.has(view.type);
}


// The site's planning mode (verified live 2026-11): its header button holds
// svg.tabler-icon-calendar-cog and reports aria-pressed, the truth. The
// `.scheduler-calendar.planning-mode` class and the sidebar can linger while
// unpublished drafts are pending ("Resume planning"), so they aren't used.
function planningModeOn(): boolean {
  return sitePlanningButton()?.getAttribute('aria-pressed') === 'true';
}

function sitePlanningButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll('svg.tabler-icon-calendar-cog'))
      .map((svg) => svg.closest('button'))
      .find((b): b is HTMLButtonElement => !!b && !b.closest('.scheduler-calendar, [role=dialog]')) ?? null
  );
}

function setIkMode(on: boolean): void {
  if (ikMode === on) return;
  ikMode = on;
  void browser.storage.local.set({ [INTRASTEK_MODE_KEY]: on }).catch(() => undefined);
  ikVersion++;
  selSig = '';
  refreshStatus();
  schedule();
}

function toggleIkMode(): void {
  const turningOn = !ikMode;
  if (turningOn) {
    // Exclusive: turn the site's planning mode off (a UI toggle, no data written).
    const site = sitePlanningButton();
    if (site && planningModeOn()) {
      site.click();
      toast(t('ikPlanningOff'), 'info');
    }
  }
  setIkMode(turningOn);
}

// Intrastek mode button: a clone of the site's planning-mode ActionIcon,
// right after it in the page header. Shown when a key is saved and the board
// applies (also during planning mode, so it can take over).
function syncIkButton(calendar: Element | null): void {
  let btn = document.querySelector<HTMLButtonElement>(`[${IK_BUTTON_ATTR}]`);
  const site = sitePlanningButton();
  if (!keyPresent || !boardApplies(calendar) || !site) {
    btn?.remove();
    return;
  }
  if (!btn) {
    // cloneNode copies no React props/listeners: a plain lookalike.
    btn = site.cloneNode(true) as HTMLButtonElement;
    btn.setAttribute(IK_BUTTON_ATTR, '');
    btn.removeAttribute('id');
    const svg = icon('users');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    (btn.querySelector('.mantine-ActionIcon-icon') ?? btn).replaceChildren(svg);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleIkMode();
    });
  }
  if (site.nextElementSibling !== btn) site.after(btn);
  const label = ikMode ? t('ikModeOn') : t('ikModeOff');
  const want: Record<string, string> = {
    'aria-pressed': String(ikMode),
    'aria-label': label,
    title: label,
    'data-variant': ikMode ? 'filled' : 'default',
    style: ikMode ? AI_STYLE.on : AI_STYLE.off,
  };
  for (const [name, value] of Object.entries(want)) if (btn.getAttribute(name) !== value) btn.setAttribute(name, value);
}

let scheduled: ReturnType<typeof setTimeout> | undefined;
// Throttle (never restart-on-every-call), never rAF.
function schedule(): void {
  if (scheduled !== undefined) return;
  scheduled = setTimeout(() => {
    scheduled = undefined;
    ensure();
  }, 30);
}

// --- Mount ---

interface Section {
  section: HTMLElement;
  label: HTMLElement;
  body: HTMLElement;
}

function buildSection(): Section {
  const section = el('section', 'epitools-pb-section');
  const label = el('h3', 'epitools-pb-h');
  const body = el('div', 'epitools-pb-section-body');
  section.append(label, body);
  return { section, label, body };
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function buildRoot(): HTMLElement {
  const node = el('div', 'epitools-pb');
  grid = el('div', 'epitools-pb-grid');
  grid.setAttribute('role', 'grid');
  leftPanel = el('aside', 'epitools-pb-panel epitools-pb-left');

  // Header search bar: icon, input, event count (built once, placed by syncSearchBar).
  searchBar = el('div', 'epitools-pb-searchbar');
  searchInput = el('input', 'epitools-pb-search');
  searchInput.type = 'search';
  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    schedule();
  });
  searchInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' && searchInput.value) {
      ev.preventDefault();
      searchInput.value = '';
      search = '';
      schedule();
    }
  });
  summary = el('span', 'epitools-pb-searchcount');
  searchBar.append(icon('search'), searchInput, summary);
  secIk = buildSection();
  secSel = buildSection();
  leftPanel.append(secIk.section, secSel.section);
  // Our typing must not reach the site's keyboard shortcuts.
  for (const side of [searchBar, leftPanel]) side.addEventListener('keydown', (ev) => ev.stopPropagation());
  node.append(leftPanel, grid);

  grid.addEventListener('click', onGridClick);
  grid.addEventListener('dblclick', (ev) => {
    // Outside the selection modes the first click already opened it.
    if (!selectionAllowed()) return;
    const card = (ev.target as Element).closest<HTMLElement>(`[${ID_ATTR}]`);
    if (card) openEvent(Number(card.getAttribute(ID_ATTR)));
  });
  grid.addEventListener('keydown', onGridKey);
  grid.addEventListener('pointerdown', onGridPointerDown);
  return node;
}

function setActiveFlag(active: boolean): void {
  const html = document.documentElement;
  if (active && html.dataset[ACTIVE_DATASET_KEY] !== 'on') html.dataset[ACTIVE_DATASET_KEY] = 'on';
  else if (!active && html.dataset[ACTIVE_DATASET_KEY]) delete html.dataset[ACTIVE_DATASET_KEY];
}

// Cheap, run on every DOM wake: mount/place, then render what changed.
// The site's planning button flips aria-pressed in the same commit that adds
// or removes its sidebar column: re-place the panel right then (a
// MutationObserver runs before paint), not a throttled tick later, so the
// calendar never shows squeezed between the two layouts.
let modeObserver: MutationObserver | null = null;
let observedButton: Element | null = null;

function watchPlanningButton(): void {
  const site = sitePlanningButton();
  if (site === observedButton) return;
  modeObserver?.disconnect();
  observedButton = site;
  if (!site) return;
  modeObserver ??= new MutationObserver(() => ensure());
  modeObserver.observe(site, { attributes: true, attributeFilter: ['aria-pressed'] });
}

function ensure(): void {
  watchPlanningButton();
  const calendar = document.querySelector('.scheduler-calendar');
  // Planning mode just turned on: Intrastek mode goes off (exclusive).
  const planning = planningModeOn();
  if (planning && !wasPlanningMode && ikMode) {
    setIkMode(false);
    toast(t('ikModeOffByPlanning'), 'info');
  }
  wasPlanningMode = planning;
  syncIkButton(calendar);
  const active = boardApplies(calendar);
  setActiveFlag(active);
  if (!active || !calendar) {
    cancelDrag();
    if (root?.isConnected) root.remove();
    if (root && leftPanel.isConnected) leftPanel.remove();
    if (root && searchBar.isConnected) searchBar.remove();
    unhost();
    return;
  }
  if (!root) root = buildRoot();
  const native = calendar.querySelector(`:scope > [${NATIVE_ATTR}]`);
  if (native ? native.nextElementSibling !== root : root.parentElement !== calendar) {
    if (native) native.after(root);
    else calendar.appendChild(root);
  }
  placeLeft(calendar);
  syncSearchBar();
  if (!selectionAllowed() && selected.size) selected.clear();
  if (ikOn() && !currentMe() && !meErrorText()) void loadMe();
  try {
    render();
  } catch (err) {
    // Never leave the native calendar hidden behind a broken board.
    console.error('[Intrafeur] planning board:', err);
    enabled = false;
    setActiveFlag(false);
    root.remove();
    leftPanel.remove();
    unhost();
    searchBar.remove();
    syncIkButton(null);
  }
}

// The search bar goes first in the header's right-hand group, i.e. just left
// of the site's filters button (that group also holds the planning-mode one).
// Verified live 2026-11: Group > [div.mantine-visible-from-sm > filters
// ActionIcon (tabler-icon-adjustments-horizontal), div > Group > planning…].
function syncSearchBar(): void {
  let group: Element | null = sitePlanningButton();
  for (let i = 0; group && i < 5 && !group.querySelector('svg.tabler-icon-adjustments-horizontal'); i++) group = group.parentElement;
  if (!group?.querySelector('svg.tabler-icon-adjustments-horizontal')) {
    searchBar.remove();
    return;
  }
  if (group.firstElementChild !== searchBar) group.prepend(searchBar);
}

// Planning drags need both: the site's planning-mode button on (the truth)
// and FullCalendar editable (it can lag or linger, e.g. with pending drafts).
function canPlan(): boolean {
  return planningModeOn() && !!view?.editable;
}

// Selecting events only makes sense with something to do with them.
function selectionAllowed(): boolean {
  return ikOn() || planningModeOn();
}

// Left panel: left of the grid (Intrastek mode), or in planning mode on top
// of the site's planning sidebar, in its column (only when that column is laid
// out: it can linger hidden, see planningModeOn). React drops that column when
// planning mode ends, so this runs on every ensure().
// The site's calendar column (a Mantine Grid col whose only child is
// .scheduler-calendar, toolbar included) made two-wide in Intrastek mode.
const HOST_CLASS = 'epitools-pb-host--left';

function unhost(): void {
  for (const node of Array.from(document.querySelectorAll(`.${HOST_CLASS}`))) node.classList.remove(HOST_CLASS);
}

// Planning mode: on top of the site's planning sidebar, in its column.
// Intrastek mode: its own column beside the whole calendar (toolbar included),
// the same way. Both left of the Today button, not under it.
function placeLeft(calendar: Element): void {
  if (!root) return;
  leftPanel.hidden = !selectionAllowed();
  const sidebar = document.querySelector('.scheduler-planning-sidebar');
  const host = calendar.parentElement;
  if (planningModeOn()) {
    unhost();
    if (sidebar?.parentElement && sidebar.getBoundingClientRect().width > 0) {
      if (sidebar.previousElementSibling !== leftPanel) sidebar.before(leftPanel);
    } else {
      // The site's sidebar column isn't laid out yet (mode switch): wait for
      // it rather than flashing the panel somewhere else for a tick.
      leftPanel.hidden = true;
    }
  } else if (!leftPanel.hidden && host) {
    if (calendar.previousElementSibling !== leftPanel) calendar.before(leftPanel);
    if (!host.classList.contains(HOST_CLASS)) host.classList.add(HOST_CLASS);
  } else {
    unhost();
    if (leftPanel.isConnected) leftPanel.remove();
  }
  leftPanel.classList.add('epitools-pb-panel--sidebar');
}

// --- Render ---

function render(): void {
  setText(secIk.label, t('staffing'));
  const count = events.filter((e) => selected.has(e.id)).length;
  setText(secSel.label, count ? t('secSelectionN', { n: count }) : t('secSelection'));
  secIk.section.hidden = !ikOn();
  grid.classList.toggle('epitools-pb-grid--editable', canPlan());
  // Planning mode just ended mid-drag: drop it, nothing is sent.
  if (drag && !canPlan()) cancelDrag();
  const placeholder = t('searchPlaceholder');
  if (searchInput.placeholder !== placeholder) {
    searchInput.placeholder = placeholder;
    searchInput.setAttribute('aria-label', t('searchAria'));
  }
  const tip = selectionAllowed() ? t('hintOpenOnly') : `${t('hintOpenOnly')} ${t('hintSelectOff')}`;
  if (searchBar.title !== tip) searchBar.title = tip;
  const lang = currentLang();
  const target = currentTarget();
  const sel = Array.from(selected).join(',');
  const g = `${feedVersion}|${sel}|${search}|${ikVersion}|${target}|${lang}|${ikOn()}`;
  if (g !== gridSig) {
    gridSig = g;
    renderGrid();
    renderSummary();
  }
  const ik = `${feedVersion}|${ikVersion}|${target}|${lang}|${ikOn()}|${search}|${statusError}|${meErrorText()}`;
  if (ik !== ikSig) {
    ikSig = ik;
    renderIk();
  }
  // The selected events' own content, not feedVersion: an unrelated repost
  // (React Query refetch) must not remount the editor and drop typed input.
  const picked = JSON.stringify(events.filter((e) => selected.has(e.id)));
  const rooms = `${JSON.stringify(view?.roomPick ?? null)}|${view?.rooms.length ?? 0}|${roomsBusy}`;
  const s = `${sel}|${picked}|${lang}|${ikOn()}|${!!currentMe()}|${target}|${canPlan()}|${rooms}`;
  if (s !== selSig) {
    selSig = s;
    renderSelection();
  }
}

function renderSummary(): void {
  const shown = visibleEvents();
  const exams = events.filter((e) => e.isExam).length;
  // Compact count in the bar ("8/34"), the long form as its tooltip.
  summary.textContent = search.trim() ? `${shown.length}/${events.length}` : String(events.length);
  const parts = [search.trim() ? t('summaryFiltered', { shown: shown.length, n: events.length }) : t('summary', { n: events.length })];
  if (exams) parts.push(t('exams', { n: exams }));
  summary.title = parts.join(' · ');
}

function renderGrid(): void {
  if (!view) return;
  // Keep keyboard focus on the same card across re-renders.
  const focusedId = (document.activeElement as HTMLElement | null)?.closest?.(`.epitools-pb [${ID_ATTR}]`)?.getAttribute(ID_ATTR);
  const days = viewDays(view.start, view.end);
  const query = fold(search.trim());
  const today = parisClock(Date.now());

  type Placed = { e: BoardEvent; start: number; end: number };
  const byDay = new Map<string, Placed[]>(days.map((d) => [d, []]));
  let minM = timeToMinutes(view.slotMin);
  let maxM = Math.max(minM + 60, timeToMinutes(view.slotMax));
  for (const e of events) {
    const s = parisClock(Date.parse(e.start));
    const f = parisClock(Date.parse(e.end));
    const list = byDay.get(s.day);
    if (!list) continue;
    const start = s.minutes;
    const end = f.day === s.day ? Math.max(f.minutes, start + 15) : 24 * 60;
    list.push({ e, start, end });
    minM = Math.min(minM, Math.floor(start / 60) * 60);
    maxM = Math.max(maxM, Math.ceil(end / 60) * 60);
  }
  const height = (maxM - minM) * PX_PER_MIN;
  geom = { minM, maxM };
  // Column widths follow each day's overlap depth: a day with 6 parallel
  // events gets room for them, an empty one shrinks.
  const dayLanes = new Map(days.map((d) => [d, layoutLanes((byDay.get(d) ?? []).map((p) => ({ id: p.e.id, start: p.start, end: p.end })))]));
  const weights = days.map((d) => {
    const lanes = dayLanes.get(d) ?? new Map();
    if (!lanes.size) return 1;
    return Math.min(6, Math.max(1, ...Array.from(lanes.values(), (l) => l.lanes)));
  });
  grid.style.setProperty('--pb-cols', weights.map((w) => `minmax(0, ${w}fr)`).join(' '));
  grid.style.setProperty('--pb-hour', `${60 * PX_PER_MIN}px`);

  const head = el('div', 'epitools-pb-head');
  head.appendChild(el('div', 'epitools-pb-corner'));
  const dayFmt = new Intl.DateTimeFormat(currentLocale(), { weekday: 'short', timeZone: 'UTC' });
  for (const day of days) {
    const date = new Date(`${day}T12:00:00Z`);
    const cell = el('div', `epitools-pb-day${day === today.day ? ' epitools-pb-day--today' : ''}`);
    cell.setAttribute('role', 'columnheader');
    const count = byDay.get(day)?.length ?? 0;
    cell.append(el('span', 'epitools-pb-day-name', dayFmt.format(date)), el('span', 'epitools-pb-day-num', String(date.getUTCDate())));
    if (count) cell.appendChild(el('span', 'epitools-pb-day-count', String(count)));
    head.appendChild(cell);
  }

  const body = el('div', 'epitools-pb-body');
  body.style.height = `${height}px`;
  const gutter = el('div', 'epitools-pb-gutter');
  for (let m = minM; m < maxM; m += 60) {
    const label = el('div', 'epitools-pb-hour', hhmm(m));
    label.style.top = `${(m - minM) * PX_PER_MIN}px`;
    gutter.appendChild(label);
  }
  body.appendChild(gutter);

  nowLine = null;
  renderedDay = today.day;
  for (const day of days) {
    const col = el('div', `epitools-pb-col${day === today.day ? ' epitools-pb-col--today' : ''}`);
    col.setAttribute('role', 'gridcell');
    col.setAttribute(DAY_ATTR, day);
    const placed = byDay.get(day) ?? [];
    const lanes = dayLanes.get(day) ?? new Map<number, { lane: number; lanes: number }>();
    for (const p of placed) {
      const lane = lanes.get(p.e.id) ?? { lane: 0, lanes: 1 };
      const card = renderCard(p.e, p.start, p.end, !matches(p.e, query));
      card.style.top = `${(p.start - minM) * PX_PER_MIN}px`;
      card.style.height = `${Math.max((p.end - p.start) * PX_PER_MIN, MIN_CARD_PX) - 2}px`;
      card.style.left = `calc(${(lane.lane / lane.lanes) * 100}% + 1px)`;
      card.style.width = `calc(${100 / lane.lanes}% - 3px)`;
      col.appendChild(card);
    }
    if (day === today.day) {
      const line = el('div', 'epitools-pb-now');
      col.appendChild(line);
      nowLine = { el: line, day, minM, maxM };
    }
    body.appendChild(col);
  }

  const children: HTMLElement[] = [head, body];
  if (!events.length) children.push(el('div', 'epitools-pb-empty', t('noEvents')));
  grid.replaceChildren(...children);
  // After the line is in the DOM (placed and hidden outside the visible hours).
  placeNowLine();
  if (focusedId) grid.querySelector<HTMLElement>(`[${ID_ATTR}="${focusedId}"]`)?.focus({ preventScroll: true });
  if (drag?.active) drawGhost();
}

function placeNowLine(): void {
  if (!nowLine) return;
  const now = parisClock(Date.now());
  const visible = now.day === nowLine.day && now.minutes >= nowLine.minM && now.minutes <= nowLine.maxM;
  nowLine.el.hidden = !visible;
  nowLine.el.style.top = `${(now.minutes - nowLine.minM) * PX_PER_MIN}px`;
}

function renderCard(e: BoardEvent, start: number, end: number, dimmed: boolean): HTMLElement {
  const card = el('div', 'epitools-pb-card');
  card.setAttribute(ID_ATTR, String(e.id));
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  if (e.color) card.style.setProperty('--pb-color', e.color);
  if (selected.has(e.id)) {
    card.classList.add('epitools-pb-card--selected');
    card.setAttribute('aria-selected', 'true');
  }
  if (dimmed) card.classList.add('epitools-pb-card--dimmed');
  if (e.isExam) card.classList.add('epitools-pb-card--exam');
  if (e.draft) card.classList.add('epitools-pb-card--draft');
  // The site's room assignment (planning mode): its own classes, mirrored.
  if (e.outOfRoom) card.classList.add('epitools-pb-card--room-out');
  if (e.noRoom) card.classList.add('epitools-pb-card--no-room');
  const ikState = ikOf(e.id);
  if (ikState) card.classList.add(`epitools-pb-card--ik-${ikState.state}`);
  if (end - start <= 45) card.classList.add('epitools-pb-card--short');

  const time = `${hhmm(start)}–${hhmm(end)}`;
  const top = el('div', 'epitools-pb-card-top');
  top.appendChild(el('span', 'epitools-pb-card-time', time));
  if (e.draft) top.appendChild(el('span', 'epitools-pb-draft', t('draft')));
  const ik = ikOf(e.id);
  // "Not initialized" is the common case: the panel counts it, no badge.
  if (ik && ik.state !== 'none') top.appendChild(ikBadge(ik));
  const meta = [e.unitCode, e.rooms.join(', ')].filter(Boolean).join(' · ');
  const regs = e.registrations !== null ? (e.capacity ? `${e.registrations}/${e.capacity}` : String(e.registrations)) : '';
  card.append(top, el('div', 'epitools-pb-card-title', e.title || e.unitName || `#${e.id}`));
  if (meta) card.appendChild(el('div', 'epitools-pb-card-meta', meta));
  if (regs) {
    const foot = el('div', 'epitools-pb-card-foot');
    foot.append(icon('users'), document.createTextNode(regs));
    card.appendChild(foot);
  }
  card.title = [e.title, time, meta, regs && `${t('registrations')}: ${regs}`].filter(Boolean).join('\n');
  card.setAttribute('aria-label', card.title.replace(/\n/g, ', '));
  return card;
}

function ikBadge(ik: { state: IkState; count: number }): HTMLElement {
  const badge = el('span', `epitools-pb-ik epitools-pb-ik--${ik.state}`);
  if (ik.state === 'linked') badge.appendChild(icon('link'));
  if (ik.state === 'proposed') badge.appendChild(icon('wait'));
  if (ik.state === 'initialized' || (ik.state === 'linked' && ik.count)) {
    badge.append(icon('users'), document.createTextNode(ik.count ? String(ik.count) : '?'));
  }
  return badge;
}

// --- Panel: Intrastek ---

function renderIk(): void {
  const body = secIk.body;
  body.replaceChildren();
  if (!ikOn()) return;
  const legend = el('div', 'epitools-pb-legends');
  const legendItems: [IkState, string][] = [
    ['initialized', t('lgInitialized')],
    ['proposed', t('lgProposed')],
    ['none', t('lgNone')],
    ['linked', t('lgLinked')],
  ];
  for (const [state, label] of legendItems) {
    const item = el('span', 'epitools-pb-legend');
    item.append(el('span', `epitools-pb-swatch epitools-pb-swatch--${state}`), document.createTextNode(label));
    legend.appendChild(item);
  }
  body.appendChild(legend);
  const me = currentMe();
  if (!me) {
    const err = meErrorText();
    body.appendChild(err ? el('p', 'epitools-pb-error', err) : spinner(t('stLoading')));
    return;
  }
  if (!me.groups.length) {
    body.appendChild(el('p', 'epitools-pb-muted', t('noGroup')));
    return;
  }
  const target = currentTarget();
  if (me.groups.length > 1) {
    const select = el('select', 'epitools-pb-select');
    select.setAttribute('aria-label', t('group'));
    for (const g of me.groups) {
      const opt = el('option', undefined, g.name);
      opt.value = g.id;
      select.appendChild(opt);
    }
    select.value = target ?? '';
    // Same storage key as the options page's default group: both stay in sync.
    select.addEventListener('change', () => {
      configuredGroupId = select.value;
      schedule();
      void browser.storage.local.set({ [INTRASTEK_DEFAULT_GROUP_KEY]: select.value }).catch(() => undefined);
    });
    body.appendChild(select);
  } else {
    body.appendChild(el('p', 'epitools-pb-muted', me.groups[0].name));
  }

  const shown = visibleEvents();
  const buckets: Record<IkState, number[]> = { initialized: [], proposed: [], none: [], linked: [] };
  let aers = 0;
  let unknown = 0;
  for (const e of shown) {
    const ik = ikOf(e.id);
    if (!ik) {
      unknown++;
      continue;
    }
    buckets[ik.state].push(e.id);
    if (ik.state === 'initialized' || ik.state === 'proposed') aers += ik.count;
  }
  const chips = el('div', 'epitools-pb-chips');
  const labels: [IkState, string][] = [
    ['initialized', t('stInitialized')],
    ['proposed', t('stProposed')],
    ['none', t('stNone')],
    ['linked', t('stLinked')],
  ];
  for (const [state, label] of labels) {
    const ids = buckets[state];
    const chip = button('', `epitools-pb-chip epitools-pb-chip--${state}`);
    chip.append(el('strong', undefined, String(ids.length)), document.createTextNode(` ${label}`));
    chip.disabled = !ids.length;
    chip.addEventListener('click', () => {
      selected.clear();
      for (const id of ids) selected.add(id);
      schedule();
    });
    chips.appendChild(chip);
  }
  body.append(chips, el('p', 'epitools-pb-total', t('stTotal', { n: aers })));
  if (unknown && !statusError) body.appendChild(spinner(t('stLoading')));
  if (statusError) body.appendChild(el('p', 'epitools-pb-error', statusError));
  else body.appendChild(el('p', 'epitools-pb-muted', t('stSelectHint')));
}

// --- Panel: selection ---

function renderSelection(): void {
  destroyEditor?.();
  destroyEditor = null;
  const selSection = secSel.body;
  selSection.replaceChildren();
  const picked = events.filter((e) => selected.has(e.id));
  const pick = canPlan() ? view?.roomPick : null;
  if (pick) selSection.appendChild(el('p', 'epitools-pb-note', t(pick.add ? 'roomPickAdd' : 'roomPickReplace', { name: pick.name })));
  if (!picked.length) {
    const list = el('ul', 'epitools-pb-hints');
    const keys = canPlan()
      ? (['hintClick', 'hintMulti', 'hintOpen', 'hintPlanMove', 'hintPlanCreate', 'hintPlanDrop', 'hintPlanDrafts'] as const)
      : (['hintClick', 'hintMulti', 'hintOpen', 'hintKeys'] as const);
    for (const key of keys) list.appendChild(el('li', undefined, t(key)));
    selSection.appendChild(list);
    return;
  }
  const me = ikOn() ? currentMe() : null;
  if (picked.length === 1) {
    const e = picked[0];
    const head = el('div', 'epitools-pb-detail-head');
    if (e.color) head.style.setProperty('--pb-color', e.color);
    head.appendChild(el('h3', 'epitools-pb-detail-title', e.title || `#${e.id}`));
    const when = formatEventDate(e.start, e.end);
    if (when) head.appendChild(el('div', 'epitools-pb-muted', when));
    selSection.appendChild(head);

    const dl = el('dl', 'epitools-pb-facts');
    const fact = (label: string, value: string): void => {
      if (!value) return;
      dl.append(el('dt', undefined, label), el('dd', undefined, value));
    };
    fact(t('unit'), [e.unitCode, e.unitName].filter(Boolean).join(' – '));
    fact(t('rooms'), e.rooms.join(', '));
    fact(t('teachers'), e.instructors.join(', '));
    fact(t('registrations'), e.registrations === null ? '' : e.capacity ? `${e.registrations} / ${e.capacity}` : String(e.registrations));
    if (e.isExam) fact(t('exam'), '✓');
    if (e.draft) fact(t('draft'), t('draftUnpublished'));
    selSection.appendChild(dl);
    if (canPlan()) selSection.appendChild(roomsEditor(picked));

    const actions = el('div', 'epitools-pb-actions');
    const open = button(t('openEvent'), 'epitools-pb-btn epitools-pb-btn--primary');
    open.addEventListener('click', () => openEvent(e.id));
    const copy = button(t('copyLink'), 'epitools-pb-btn');
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(eventLink(e.id)).then(
        () => toast(t('linkCopied'), 'success'),
        () => toast(t('copyFailed'), 'error'),
      );
    });
    actions.append(open, copy);
    if (isReal(e.id)) selSection.appendChild(actions);

    if (me && isReal(e.id)) {
      selSection.appendChild(el('h3', 'epitools-pb-h', t('staffingOf')));
      destroyEditor = mountEventEditor(selSection, { id: e.id, title: e.title, start: e.start, end: e.end }, me, currentTarget());
    }
    return;
  }

  const head = el('div', 'epitools-pb-detail-head');
  head.appendChild(el('h3', 'epitools-pb-detail-title', t('selectedMany', { n: picked.length })));
  const clear = button(t('clear'), 'epitools-pb-btn');
  clear.addEventListener('click', clearSelection);
  head.appendChild(clear);
  selSection.appendChild(head);
  const list = el('ul', 'epitools-pb-picked');
  for (const e of picked.slice(0, 8)) {
    const item = el('li');
    const when = formatEventDate(e.start, e.end);
    item.append(el('span', 'epitools-pb-picked-title', e.title || `#${e.id}`), el('span', 'epitools-pb-muted', when));
    list.appendChild(item);
  }
  if (picked.length > 8) list.appendChild(el('li', 'epitools-pb-muted', t('andMore', { n: picked.length - 8 })));
  selSection.appendChild(list);
  if (canPlan()) selSection.appendChild(roomsEditor(picked));
  if (me) {
    selSection.appendChild(el('h3', 'epitools-pb-h', t('staffingOf')));
    destroyEditor = mountBulkEditor(
      selSection,
      picked.map((e) => e.id).filter(isReal),
      me,
      currentTarget(),
      (failedIds) => {
        selected.clear();
        for (const id of failedIds) selected.add(id);
        selSig = '';
        schedule();
      },
    );
  }
}

// --- Rooms of the selection (planning mode), as tags ---
// Edits are staged here (no site work per tag); Apply sends them all at once
// to the feed, which goes through the site's own room assignment (it picks
// each room in its panel and clicks the events): drafts, like a drag.

// After staging a room, the re-rendered input gets the focus back.
let refocusRoomInput = false;
// Staged edits, kept across re-renders of the same selection.
let roomsStaged: { sel: string; add: Map<number, string>; remove: Set<number> } = { sel: '', add: new Map(), remove: new Set() };

function stagedFor(picked: BoardEvent[]): typeof roomsStaged {
  const sel = picked.map((e) => e.id).join(',');
  if (roomsStaged.sel !== sel) roomsStaged = { sel, add: new Map(), remove: new Set() };
  return roomsStaged;
}

function applyRooms(picked: BoardEvent[]): void {
  const staged = stagedFor(picked);
  const changes: RoomChange[] = [];
  for (const rid of staged.remove) {
    const ids = picked.filter((e) => e.roomIds.includes(rid)).map((e) => e.id);
    if (ids.length) changes.push({ roomId: rid, op: 'remove', ids });
  }
  for (const rid of staged.add.keys()) {
    const ids = picked.filter((e) => !e.roomIds.includes(rid)).map((e) => e.id);
    if (ids.length) changes.push({ roomId: rid, op: 'add', ids });
  }
  roomsStaged = { sel: staged.sel, add: new Map(), remove: new Set() };
  if (!changes.length || roomsBusy) {
    selSig = '';
    schedule();
    return;
  }
  roomsBusy = true;
  // The feed always answers; this only unlocks the editor if it never does.
  clearTimeout(roomsBusyTimer);
  const clicks = changes.reduce((n, c) => n + c.ids.length, 0);
  roomsBusyTimer = setTimeout(() => {
    roomsBusy = false;
    schedule();
  }, 15_000 + clicks * 2000);
  send({ cmd: 'rooms', changes });
  selSig = '';
  schedule();
}

function roomsEditor(picked: BoardEvent[]): HTMLElement {
  const staged = stagedFor(picked);
  const rerender = (): void => {
    selSig = '';
    schedule();
  };
  const wrap = el('div', 'epitools-pb-rooms');
  wrap.appendChild(el('h3', 'epitools-pb-h', t('roomsH')));
  const rooms = view?.rooms ?? [];
  const known = new Map(rooms.map((r) => [r.id, r.name]));
  // Rooms of the selected events: id -> name, and how many events have it.
  const has = new Map<number, { name: string; n: number }>();
  for (const e of picked) {
    e.roomIds.forEach((rid, i) => {
      const entry = has.get(rid) ?? { name: known.get(rid) ?? e.rooms[i] ?? `#${rid}`, n: 0 };
      entry.n++;
      has.set(rid, entry);
    });
  }
  const tags = el('div', 'epitools-pb-tags');
  const tag = (rid: number, name: string, state: 'current' | 'add' | 'remove', n: number): void => {
    const node = el('span', `epitools-pb-tag epitools-pb-tag--${state}`);
    node.appendChild(el('span', undefined, name));
    if (state !== 'add' && picked.length > 1 && n < picked.length) node.appendChild(el('span', 'epitools-pb-tag-count', `${n}/${picked.length}`));
    const undo = state !== 'current';
    const x = button(undo ? '↺' : '×', 'epitools-pb-tag-x');
    const label = undo ? t('roomUndo', { name }) : t('roomRemove', { name });
    x.setAttribute('aria-label', label);
    x.title = label;
    x.disabled = roomsBusy;
    x.addEventListener('click', () => {
      if (state === 'add') staged.add.delete(rid);
      else if (state === 'remove') staged.remove.delete(rid);
      else staged.remove.add(rid);
      rerender();
    });
    node.appendChild(x);
    tags.appendChild(node);
  };
  for (const [rid, { name, n }] of Array.from(has).sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    tag(rid, name, staged.remove.has(rid) ? 'remove' : 'current', n);
  }
  for (const [rid, name] of staged.add) tag(rid, name, 'add', 0);
  if (!tags.children.length) tags.appendChild(el('span', 'epitools-pb-muted', t('roomsNone')));
  wrap.appendChild(tags);

  if (!rooms.length) {
    wrap.appendChild(el('p', 'epitools-pb-muted', t('roomsUnavailable')));
    return wrap;
  }
  const input = el('input', 'epitools-pb-input');
  input.type = 'text';
  input.placeholder = t('roomAdd');
  input.setAttribute('aria-label', t('roomAdd'));
  input.disabled = roomsBusy;
  const listId = 'epitools-pb-rooms-list';
  input.setAttribute('list', listId);
  const datalist = el('datalist');
  datalist.id = listId;
  for (const r of rooms) {
    const opt = el('option');
    opt.value = r.name;
    if (r.capacity !== null) opt.label = t('roomSeats', { n: r.capacity });
    datalist.appendChild(opt);
  }
  const add = (): void => {
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const room = rooms.find((r) => r.name.toLowerCase() === q);
    if (!room) {
      toast(t('roomUnknown', { name: input.value.trim() }), 'error');
      return;
    }
    input.value = '';
    // Re-adding a room staged for removal just cancels the removal.
    if (staged.remove.delete(room.id)) {
      rerender();
    } else if (picked.every((e) => e.roomIds.includes(room.id))) {
      toast(t('roomAlready', { name: room.name }), 'info');
      return;
    } else {
      staged.add.set(room.id, room.name);
      rerender();
    }
    // Keep typing the next one.
    refocusRoomInput = true;
  };
  // A datalist pick fires `change`; Enter adds what's typed.
  input.addEventListener('change', add);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      add();
    }
  });
  wrap.append(input, datalist);
  if (refocusRoomInput && !roomsBusy) {
    refocusRoomInput = false;
    setTimeout(() => input.isConnected && input.focus(), 0);
  }

  const pending = staged.add.size + staged.remove.size;
  if (pending && !roomsBusy) {
    const actions = el('div', 'epitools-pb-actions');
    const apply = button(t('roomsApply', { n: pending }), 'epitools-pb-btn epitools-pb-btn--primary');
    apply.addEventListener('click', () => applyRooms(picked));
    const cancel = button(t('roomsCancel'), 'epitools-pb-btn');
    cancel.addEventListener('click', () => {
      roomsStaged = { sel: staged.sel, add: new Map(), remove: new Set() };
      rerender();
    });
    actions.append(apply, cancel);
    wrap.appendChild(actions);
  }
  if (roomsBusy) wrap.appendChild(spinner(t('roomsBusy')));
  else wrap.appendChild(el('p', 'epitools-pb-muted', t('roomsHint')));
  return wrap;
}

// --- Interactions ---

function clearSelection(): void {
  if (!selected.size) return;
  selected.clear();
  schedule();
}

function onGridClick(ev: MouseEvent): void {
  if (Date.now() < suppressClickUntil) return;
  const card = (ev.target as Element).closest<HTMLElement>(`[${ID_ATTR}]`);
  if (!card) {
    // Click on the empty grid: deselect.
    if ((ev.target as Element).closest('.epitools-pb-col')) clearSelection();
    return;
  }
  const id = Number(card.getAttribute(ID_ATTR));
  // A room picked in the site's panel: the click assigns it (the site's own handler).
  if (canPlan() && view?.roomPick && !(ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
    send({ cmd: 'roomClick', id });
    return;
  }
  if (!selectionAllowed()) {
    openEvent(id);
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
    if (!selected.delete(id)) selected.add(id);
  } else if (!(selected.size === 1 && selected.has(id))) {
    selected.clear();
    selected.add(id);
  }
  schedule();
}

function onGridKey(ev: KeyboardEvent): void {
  const card = (ev.target as Element).closest<HTMLElement>(`[${ID_ATTR}]`);
  if (!card) return;
  const id = Number(card.getAttribute(ID_ATTR));
  if (ev.key === 'Enter') {
    ev.preventDefault();
    openEvent(id);
  } else if (ev.key === ' ' && selectionAllowed()) {
    ev.preventDefault();
    if (!selected.delete(id)) selected.add(id);
    schedule();
  }
}

// --- Planning mode drags (only while the feed says FullCalendar is editable) ---
// move: a card to another time/day; create: a range on empty slots (opens the
// site's creation modal); receive: a plannable activity from the site's
// sidebar (announced by the feed on pointerdown). All end in one command to
// the feed, which calls the site's handler (drafts, see planning-feed.ts).

interface Drag {
  kind: 'move' | 'create' | 'receive';
  x0: number;
  y0: number;
  active: boolean;
  /** move: event id */
  id: number;
  /** move: minutes between the event start and the grab point; create: anchor minute */
  offset: number;
  duration: number;
  anchorDay: string;
  title: string;
  color: string | null;
  target: { day: string; start: number; end: number } | null;
  ghost: HTMLElement | null;
}

let drag: Drag | null = null;
let suppressClickUntil = 0;

function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MIN) * SNAP_MIN;
}

function colAt(x: number, y: number): HTMLElement | null {
  for (const col of Array.from(grid.querySelectorAll<HTMLElement>(`.epitools-pb-col[${DAY_ATTR}]`))) {
    const r = col.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return col;
  }
  return null;
}

function minuteAt(col: HTMLElement, y: number): number {
  return (geom?.minM ?? 0) + (y - col.getBoundingClientRect().top) / PX_PER_MIN;
}

function newDrag(kind: Drag['kind'], x: number, y: number, init: Partial<Drag>): Drag {
  return { kind, x0: x, y0: y, active: false, id: 0, offset: 0, duration: 60, anchorDay: '', title: '', color: null, target: null, ghost: null, ...init };
}

function onGridPointerDown(ev: PointerEvent): void {
  if (!canPlan() || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey || drag) return;
  const target = ev.target as Element;
  const card = target.closest<HTMLElement>(`[${ID_ATTR}]`);
  const col = target.closest<HTMLElement>(`.epitools-pb-col[${DAY_ATTR}]`);
  if (!col) return;
  if (card) {
    const e = events.find((x) => x.id === Number(card.getAttribute(ID_ATTR)));
    if (!e) return;
    const start = parisClock(Date.parse(e.start)).minutes;
    const duration = Math.max(SNAP_MIN, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60_000));
    drag = newDrag('move', ev.clientX, ev.clientY, { id: e.id, offset: minuteAt(col, ev.clientY) - start, duration, title: e.title, color: e.color });
  } else {
    drag = newDrag('create', ev.clientX, ev.clientY, { offset: snap(minuteAt(col, ev.clientY)), anchorDay: col.getAttribute(DAY_ATTR) ?? '' });
  }
}

function startReceive(info: { title: string; duration: number; color: string | null }): void {
  if (!root?.isConnected || !canPlan()) return;
  cancelDrag();
  drag = newDrag('receive', 0, 0, { active: true, ...info });
}

function onPointerMove(ev: PointerEvent): void {
  if (!drag) return;
  if (!ev.buttons) {
    // Released outside the window (or a click on a sidebar card).
    cancelDrag();
    return;
  }
  if (!drag.active) {
    if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < DRAG_THRESHOLD_PX) return;
    drag.active = true;
    document.documentElement.classList.add('epitools-pb-dragging');
  }
  ev.preventDefault();
  const maxM = 24 * 60;
  const col = drag.kind === 'create' ? grid.querySelector<HTMLElement>(`.epitools-pb-col[${DAY_ATTR}="${drag.anchorDay}"]`) : colAt(ev.clientX, ev.clientY);
  if (!col || (drag.kind !== 'create' && !colAt(ev.clientX, ev.clientY))) {
    drag.target = null;
  } else {
    const day = col.getAttribute(DAY_ATTR) ?? '';
    const at = minuteAt(col, ev.clientY);
    if (drag.kind === 'create') {
      const cur = Math.min(maxM, Math.max(0, snap(at)));
      const start = Math.min(drag.offset, cur);
      drag.target = { day, start, end: Math.max(start + SNAP_MIN, Math.max(drag.offset, cur)) };
    } else {
      const start = Math.min(maxM - drag.duration, Math.max(0, snap(drag.kind === 'move' ? at - drag.offset : at)));
      drag.target = { day, start, end: start + drag.duration };
    }
  }
  drawGhost();
}

function drawGhost(): void {
  if (!drag) return;
  const col = drag.target && grid.querySelector<HTMLElement>(`.epitools-pb-col[${DAY_ATTR}="${drag.target.day}"]`);
  if (!drag.target || !col || !geom) {
    drag.ghost?.remove();
    return;
  }
  if (!drag.ghost) {
    drag.ghost = el('div', `epitools-pb-ghost epitools-pb-ghost--${drag.kind}`);
    if (drag.color) drag.ghost.style.setProperty('--pb-color', drag.color);
  }
  const { start, end } = drag.target;
  drag.ghost.style.top = `${(start - geom.minM) * PX_PER_MIN}px`;
  drag.ghost.style.height = `${Math.max((end - start) * PX_PER_MIN, MIN_CARD_PX) - 2}px`;
  setText(drag.ghost, [`${hhmm(start)}–${hhmm(end)}`, drag.title].filter(Boolean).join('  '));
  if (drag.ghost.parentElement !== col) col.appendChild(drag.ghost);
}

function onPointerUp(): void {
  const d = drag;
  if (!d) return;
  drag = null;
  d.ghost?.remove();
  document.documentElement.classList.remove('epitools-pb-dragging');
  if (!d.active) return;
  suppressClickUntil = Date.now() + 300;
  const target = d.target;
  if (!target) return;
  const start = parisToIso(target.day, target.start);
  const end = parisToIso(target.day, target.end);
  if (d.kind === 'move') {
    const e = events.find((x) => x.id === d.id);
    if (!e || Date.parse(e.start) === Date.parse(start)) return;
    send({ cmd: 'move', id: d.id, start, end });
  } else if (d.kind === 'create') {
    send({ cmd: 'create', start, end });
  } else {
    send({ cmd: 'receive', start });
  }
}

function cancelDrag(): void {
  if (!drag) return;
  if (drag.active) suppressClickUntil = Date.now() + 300;
  drag.ghost?.remove();
  drag = null;
  document.documentElement.classList.remove('epitools-pb-dragging');
}

// Window capture, observe only (no stopPropagation): the site's focused
// elements stop some keys from bubbling.
function onKey(ev: KeyboardEvent): void {
  if (!root?.isConnected || ev.defaultPrevented) return;
  if (drag && ev.key === 'Escape') {
    cancelDrag();
    return;
  }
  // A modal or menu owns the keyboard (the site's event modal is a section[role=dialog]).
  if (document.querySelector('section[role=dialog], .epitools-menu')) return;
  const typing = ev.target instanceof HTMLElement && (ev.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName));
  if (ev.key === 'Escape' && !typing) clearSelection();
  if (ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    searchInput.focus();
  }
}

// --- Feed / storage ---

function onMessage(ev: MessageEvent): void {
  if (ev.source !== window || ev.origin !== location.origin) return;
  const done = sanitizeRoomsDone(ev.data);
  if (done) {
    roomsBusy = false;
    clearTimeout(roomsBusyTimer);
    if (done.error) toast(t('roomsError'), 'error');
    else if (done.failed) toast(t('roomsFailed', { changed: done.changed, failed: done.failed }), 'error');
    else if (done.changed) toast(t('roomsChanged', { n: done.changed }), 'success');
    selSig = '';
    schedule();
    return;
  }
  const dragInfo = sanitizeDrag(ev.data);
  if (dragInfo) {
    startReceive(dragInfo);
    return;
  }
  const feed = sanitizeFeed(ev.data);
  if (!feed) return;
  view = feed.view;
  events = feed.events;
  feedVersion++;
  setPlanningIndex(events.filter((e) => isReal(e.id)));
  // A selection never outlives its view (no writes to events off screen).
  const ids = new Set(events.map((e) => e.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
  refreshStatus();
  schedule();
}

function refreshStatus(): void {
  if (!ikOn() || !events.length || document.visibilityState !== 'visible') return;
  fetchStatus(events.map((e) => e.id).filter(isReal)).then(
    (fetched) => {
      if (!fetched) return;
      statusError = '';
      ikVersion++;
      schedule();
    },
    (err: unknown) => {
      statusError = (err as Error)?.message || String(err);
      schedule();
    },
  );
}

export async function init(): Promise<void> {
  const stored = await getLocal({
    [FLAGS.planningBoard.key]: FLAGS.planningBoard.default,
    [INTRASTEK_MODE_KEY]: false,
    [INTRASTEK_API_KEY_KEY]: '',
    [INTRASTEK_DEFAULT_GROUP_KEY]: '',
  });
  if (!stored) return;
  enabled = flagValue(FLAGS.planningBoard, stored[FLAGS.planningBoard.key]);
  keyPresent = !!stored[INTRASTEK_API_KEY_KEY];
  ikMode = stored[INTRASTEK_MODE_KEY] === true;
  configuredGroupId = String(stored[INTRASTEK_DEFAULT_GROUP_KEY] || '');

  onLocalChange([FLAGS.planningBoard.key, INTRASTEK_MODE_KEY, INTRASTEK_API_KEY_KEY, INTRASTEK_API_URL_KEY, INTRASTEK_DEFAULT_GROUP_KEY], (v) => {
    if (FLAGS.planningBoard.key in v) enabled = flagValue(FLAGS.planningBoard, v[FLAGS.planningBoard.key]);
    if (INTRASTEK_API_KEY_KEY in v) keyPresent = !!v[INTRASTEK_API_KEY_KEY];
    // Another tab's header button: same exclusivity.
    if (INTRASTEK_MODE_KEY in v) {
      const on = v[INTRASTEK_MODE_KEY] === true;
      if (on !== ikMode) {
        if (on) toggleIkMode();
        else setIkMode(false);
      }
    }
    if (INTRASTEK_DEFAULT_GROUP_KEY in v) configuredGroupId = String(v[INTRASTEK_DEFAULT_GROUP_KEY] || '');
    // intrastek.ts resets the shared me/cache on key/URL changes.
    statusError = '';
    ikVersion++;
    selSig = '';
    refreshStatus();
    schedule();
  });
  onCacheChange(() => {
    ikVersion++;
    schedule();
  });
  window.addEventListener('message', onMessage);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', cancelDrag, true);
  document.addEventListener('visibilitychange', refreshStatus);
  setInterval(() => {
    // Midnight: today's column and the now-line move to the new day.
    if (renderedDay && parisClock(Date.now()).day !== renderedDay) {
      gridSig = '';
      schedule();
    } else {
      placeNowLine();
    }
  }, 30_000);
  // aria-pressed: the site's planning-mode button (planningModeOn).
  watchDom(ensure, { htmlAttributes: [datasetAttr(LANG_DATASET_KEY)], bodyAttributes: ['aria-pressed'] });
  // The feed may have posted before we listened.
  send({ cmd: 'hello' });
}
