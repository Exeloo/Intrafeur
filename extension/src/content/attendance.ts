import browser from 'webextension-polyfill';
import { extractRowOriginal } from './fiber-extract';
import {
  UNASSIGNED,
  ensureFactionHeaderCell,
  setFactionHeaderSortIcon,
  setFactionHeaderFilterActive,
  enableFluidColumns,
  hijackExportButton,
  ensureRowCell,
  ensureMemberBadge,
  markRow,
  unmarkRow,
  isRowMarked,
  removeInjectedElements,
  applySortAndFilter,
  closeAnyOpenMenu,
  openChecklistMenu,
  type FactionKey,
  type ChecklistOption,
} from './dom-inject';
import type { Faction, RowMeta, AssignmentsMap, MessageType } from '../types';
import { FACTIONS_ENABLED_KEY, FACTIONS_ENABLED_DEFAULT } from '../types';

interface State {
  factions: Faction[];
  assignments: AssignmentsMap;
  rowsMeta: Map<HTMLTableRowElement, RowMeta>;
  sortDir: 'asc' | 'desc' | null; // cycles on the Faction header click
  filterFactionIds: Set<FactionKey>; // empty = show all
  applying: boolean;
}

const state: State = {
  factions: [],
  assignments: {},
  rowsMeta: new Map(),
  sortDir: null,
  filterFactionIds: new Set(),
  applying: false,
};

let activeTable: HTMLTableElement | null = null;
let tbodyObserver: MutationObserver | null = null;
let theadClickListener: ((ev: MouseEvent) => void) | null = null;
let factionHeaderEl: HTMLTableCellElement | null = null;

// Registered Groups (Projects pages) isn't a table — repeated <div> cards
// instead, one per member/leader row. Tracked separately from state.rowsMeta
// since there's no shared tbody/thead to hang the usual table logic off of.
const memberRowsMeta = new Map<HTMLElement, RowMeta>();

function sendMessage<T>(type: MessageType, payload: unknown = {}): Promise<T> {
  return browser.runtime.sendMessage({ type, payload }) as Promise<T>;
}

// Several table shapes on this site have a "Student" column with different
// companion columns depending on the kind of session/list — the Attendance
// modal (+ Promotion/Registration date/Attendance), a Unit's plain
// "Registrations" tab (+ Registered by/Registration date, email only, no
// name), and e.g. a Kick-off session's registrations modal (just +
// Promotion/Registration date, no Attendance tracking at all). Rather than
// hardcode every combination, match on the "Student" column alone — but by
// its *content* (an email-shaped <p> in the first cell, same signal
// buildRowMeta/findMemberContainers already use), not by the header text.
// The site's own UI is localized (e.g. French), which renders "Student" as
// something else entirely — matching header text broke the whole feature on
// non-English UIs; email addresses aren't translated. A page can have more
// than one such table in the DOM at once (a modal open over a Unit's own
// Registrations tab underneath) — prefer one that's actually inside an open
// modal, since that's what's in front of the user; Mantine portals modals to
// the end of the DOM, so plain document order isn't a reliable enough signal
// on its own.
// The Student cell isn't always the row's first <td> — some views (e.g. a
// registrations table where the viewer can select rows and unregister
// students) add a leading checkbox column and/or a trailing Actions column
// around it, depending on the viewer's permissions on that page. Scan every
// cell for the one holding an email-shaped <p> rather than assuming a fixed
// position.
function findStudentCell(tr: HTMLTableRowElement): HTMLTableCellElement | undefined {
  return Array.from(tr.querySelectorAll('td')).find((td) =>
    Array.from(td.querySelectorAll('p')).some((p) => /\S+@\S+\.\S+/.test(p.textContent || '')),
  );
}

function tableHasStudentRows(t: HTMLTableElement): boolean {
  return Array.from(t.querySelectorAll<HTMLTableRowElement>('tbody tr')).some((tr) => {
    if (tr.querySelector('td[colspan]')) return false; // placeholder row
    return findStudentCell(tr) !== undefined;
  });
}

function findTable(): HTMLTableElement | undefined {
  const tables = Array.from(document.querySelectorAll('table'));
  const candidates = tables.filter(tableHasStudentRows);
  return candidates.find((t) => t.closest('[class*="mantine-Modal"]')) ?? candidates[0];
}

// "adam.abdelmotalib@epitech.eu" -> "Adam Abdelmotalib", used when a row only
// has an email and no separate name paragraph (the Registrations tab shape).
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] || email;
  return local
    .split(/[.\-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// MRT renders an empty table's body as a single row with one <td colspan="N">
// ("No records to display") rather than omitting <tbody> entirely — that row
// still superficially looks like data (a <td> with a <p> of text), so it was
// getting picked up as a bogus "student" and tagged. Real rows always have
// one <td> per column, none of them spanning.
function isPlaceholderRow(tr: HTMLTableRowElement): boolean {
  return tr.querySelector('td[colspan]') !== null;
}

function factionById(id: number | null): Faction | null {
  if (id == null) return null;
  return state.factions.find((f) => f.id === id) || null;
}

// The Registrations table's first cell currently holds two <p> tags
// directly in the DOM: the student's full name, then their email. That's
// the primary, cheap extraction path. If a future redesign removes that
// (as happened once already — see plan revision notes), fall back to
// walking React internals, and failing that, a name-derived synthetic key.
// Returns null (rather than a low-confidence guessed key) when neither
// extraction path works — most often because the row's cell content hasn't
// finished rendering yet (React hydrates row-by-row after the initial DOM
// insert our MutationObserver reacts to). Returning null leaves the row
// unmarked, so it's simply retried on the next mutation pass instead of
// permanently locking in a synthetic key that would never match the
// student's real email used elsewhere (CSV export, other pages' tags, ...).
function buildRowMeta(
  tr: HTMLTableRowElement,
  precomputedStudentCell?: HTMLTableCellElement,
): { email: string; fullName: string } | null {
  const studentCell = precomputedStudentCell ?? findStudentCell(tr);
  const paragraphs = studentCell ? Array.from(studentCell.querySelectorAll('p')) : [];
  const emailParagraph = paragraphs.find((p) => p.textContent?.includes('@'));

  if (emailParagraph) {
    const email = emailParagraph.textContent!.trim();
    // Registrations-tab rows only have the one (email) paragraph — no name.
    const fullName = paragraphs.length > 1 ? paragraphs[0].textContent!.trim() : nameFromEmail(email);
    return { email, fullName };
  }

  const original = extractRowOriginal(tr);
  if (original?.login) {
    const fullName = [original.firstname, original.lastname].filter(Boolean).join(' ');
    return { email: original.login, fullName };
  }

  return null;
}

function refreshRowBadge(tr: HTMLTableRowElement, meta: RowMeta, insertAfter?: HTMLTableCellElement | null): void {
  const faction = factionById(meta.factionId);
  ensureRowCell(tr, meta.email, faction, state.factions, onAssign, insertAfter);
}

// Registered Groups cards (Projects pages): each leader/member row is a
// name+email pair rendered as two plain <p> tags, same shape as a table's
// Student cell, just not inside a <table>. Scoped to `!p.closest('table')`
// so it never double-processes an actual table row using the same shape.
function findMemberContainers(): HTMLElement[] {
  const emailParagraphs = Array.from(document.querySelectorAll('p')).filter(
    (p) => p.children.length === 0 && !p.closest('table') && /\S+@\S+\.\S+/.test(p.textContent || ''),
  );
  const containers: HTMLElement[] = [];
  for (const p of emailParagraphs) {
    const container = p.parentElement?.parentElement; // <p> -> name/email stack -> row (avatar + stack)
    if (container instanceof HTMLElement) containers.push(container);
  }
  return containers;
}

function refreshMemberBadge(container: HTMLElement, meta: RowMeta): void {
  const faction = factionById(meta.factionId);
  ensureMemberBadge(container, meta.email, faction, state.factions, onAssign);
}

function processMemberCards(): void {
  for (const container of findMemberContainers()) {
    // See the matching comment in processRows: don't re-render an
    // already-marked card's badge on every mutation, only when onAssign()
    // actually changes it — this call runs on every body-wide mutation, so
    // an unconditional re-render here is exactly the kind of self-triggering
    // loop that hung the tab.
    if (isRowMarked(container) && memberRowsMeta.has(container)) continue;

    const paragraphs = Array.from(container.querySelectorAll('p')).filter((p) => p.children.length === 0);
    const emailP = paragraphs.find((p) => p.textContent?.includes('@'));
    if (!emailP) continue;

    const email = emailP.textContent!.trim();
    const fullName = paragraphs.length > 1 ? paragraphs[0].textContent!.trim() : nameFromEmail(email);

    markRow(container, email);
    const factionId = state.assignments[email] ?? null;
    const meta: RowMeta = { email, fullName, factionId, factionName: factionById(factionId)?.name || '' };
    memberRowsMeta.set(container, meta);
    refreshMemberBadge(container, meta);
  }
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// The DOM only shows rendered/localized values (e.g. "PRESENT", "9/9/2026
// 12:03"), not the raw ones the native export uses ("present",
// "2026-09-09T10:03:17.481Z") — matching those exactly.
function formatAttendance(text: string): string {
  return text.trim().toLowerCase();
}

function formatRegistrationDate(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const parsed = new Date(trimmed);
  // Seconds/milliseconds aren't shown in the UI, so they can't be recovered
  // — this matches the native value down to the minute, not byte-for-byte.
  return isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}

// The site's UI is localized (verified live: French renders these headers as
// "Promotion" [same word], "Date d'inscription", "Présences") — each column
// is looked up by whichever translation is actually present, so this keeps
// working regardless of the site's current UI language.
const REGISTRATION_DATE_LABELS = ['Registration date', "Date d'inscription"];
const ATTENDANCE_LABELS = ['Attendance', 'Présences'];

// Matches the site's own native export (Downloads/registrations.csv):
// header "Student" holds the email itself (not a display name — the native
// export doesn't have a name column at all), followed by whichever of
// Promotion/Registration date/Attendance the table actually has. Faction is
// the one column native doesn't have. Column presence is read by header text
// (not fixed index) so it's robust to column order and to tables that don't
// have all of these (e.g. a Kick-off session's has no Attendance). Includes
// every row regardless of tr.style.display — that's the filter mechanism,
// deliberately ignored here per the user's ask — but keeps current DOM order
// (i.e. whatever sort, if any, is active), since only the filter was asked
// to be ignored.
function buildCsvRows(table: HTMLTableElement): string[][] {
  const headers = Array.from(table.querySelectorAll('thead th'));
  const colIndexFor = (labels: string[]): number | undefined => {
    const idx = headers.findIndex((th) => th !== factionHeaderEl && labels.includes(th.textContent?.trim() || ''));
    return idx === -1 ? undefined : idx;
  };
  const promotionIdx = colIndexFor(['Promotion']);
  const registrationIdx = colIndexFor(REGISTRATION_DATE_LABELS);
  const attendanceIdx = colIndexFor(ATTENDANCE_LABELS);

  const cellText = (tr: HTMLTableRowElement, idx: number | undefined): string => {
    if (idx == null) return '';
    return (tr.children[idx] as HTMLElement | undefined)?.textContent?.trim() || '';
  };

  const rows: string[][] = [['Student', 'Promotion', 'Registration date', 'Attendance', 'Faction']];
  const tbody = table.querySelector('tbody');
  if (!tbody) return rows;

  for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
    if (isPlaceholderRow(tr)) continue;
    const meta = state.rowsMeta.get(tr);
    rows.push([
      meta?.email || '',
      cellText(tr, promotionIdx),
      formatRegistrationDate(cellText(tr, registrationIdx)),
      formatAttendance(cellText(tr, attendanceIdx)),
      meta && meta.factionId != null ? meta.factionName : 'Unassigned',
    ]);
  }

  return rows;
}

function downloadCsv(rows: string[][]): void {
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  // UTF-8 BOM so Excel doesn't mangle accented names (Léa, Aimée, ...).
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Matches the native export's own filename convention exactly.
  a.download = 'registrations.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCsv(table: HTMLTableElement): void {
  downloadCsv(buildCsvRows(table));
}

// Placed right after the Student/Login column (wherever that lands — it
// isn't always index 0, e.g. a leading row-select checkbox column) rather
// than appended after every other column, since on wide tables (an
// Achievements tab can have 8+ task columns) an appended Faction column ends
// up far off to the right, easy to miss and awkward to use. The column's
// position is read fresh from the DOM on each pass — not cached — so it
// still tracks correctly if a column gets added/removed/reordered.
// Only applied to tables embedded directly in the page (e.g. Achievements) —
// the Attendance/Registrations modal explicitly keeps the original
// appended-at-the-end placement, per the user's own request to roll that
// one back while keeping the reposition for Achievements.
function studentColumnIndex(tbody: HTMLTableSectionElement): number | undefined {
  for (const tr of Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr'))) {
    if (isPlaceholderRow(tr)) continue;
    const cell = findStudentCell(tr);
    if (cell) return Array.from(tr.children).indexOf(cell);
  }
  return undefined;
}

function processRows(table: HTMLTableElement): void {
  const theadRow = table.querySelector<HTMLTableRowElement>('thead tr');
  const tbody = table.querySelector('tbody');
  const repositionNextToStudent = !table.closest('[class*="mantine-Modal"]');
  const studentIdx = repositionNextToStudent && tbody ? studentColumnIndex(tbody) : undefined;

  if (theadRow) {
    const headerInsertAfter =
      studentIdx != null ? (theadRow.children[studentIdx] as HTMLTableCellElement | undefined) : undefined;
    factionHeaderEl = ensureFactionHeaderCell(
      theadRow,
      {
        onSortClick: onFactionSortClick,
        onFilterClick: onFactionFilterClick,
      },
      headerInsertAfter,
    );
    setFactionHeaderSortIcon(factionHeaderEl, state.sortDir);
    setFactionHeaderFilterActive(factionHeaderEl, state.filterFactionIds.size > 0);
    enableFluidColumns(table);
    hijackExportButton(table, () => exportCsv(table));
  }

  if (!tbody) return;

  for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
    // Already processed — leave it alone. onAssign()/applyFactionToEmail()
    // already re-render a row's badge directly when its faction actually
    // changes; unconditionally re-rendering here on every single mutation
    // (including ones our own badge renders cause) turned into a self-
    // sustaining MutationObserver feedback loop that hung the tab.
    if (isRowMarked(tr) && state.rowsMeta.has(tr)) continue;
    if (isPlaceholderRow(tr)) continue;

    const studentCell = findStudentCell(tr);
    const rowMeta = buildRowMeta(tr, studentCell);
    if (!rowMeta) continue;
    const { email, fullName } = rowMeta;

    markRow(tr, email);
    const factionId = state.assignments[email] ?? null;
    const meta: RowMeta = { email, fullName, factionId, factionName: factionById(factionId)?.name || '' };
    state.rowsMeta.set(tr, meta);
    refreshRowBadge(tr, meta, repositionNextToStudent ? studentCell : undefined);
  }
}

function applyFactionToEmail(email: string, factionId: number | null): void {
  for (const [tr, meta] of state.rowsMeta.entries()) {
    if (meta.email === email) {
      meta.factionId = factionId;
      meta.factionName = factionById(factionId)?.name || '';
      refreshRowBadge(tr, meta);
    }
  }
  for (const [container, meta] of memberRowsMeta.entries()) {
    if (meta.email === email) {
      meta.factionId = factionId;
      meta.factionName = factionById(factionId)?.name || '';
      refreshMemberBadge(container, meta);
    }
  }
}

function onAssign(email: string, factionId: number | null): void {
  const previous = state.assignments[email] ?? null;
  if (factionId == null) delete state.assignments[email];
  else state.assignments[email] = factionId;

  applyFactionToEmail(email, factionId);
  reapplySortAndFilter();

  sendMessage('setAssignment', { email, factionId }).catch((err) => {
    console.error('[Epitools] failed to save assignment, reverting', err);
    if (previous == null) delete state.assignments[email];
    else state.assignments[email] = previous;
    applyFactionToEmail(email, previous);
    reapplySortAndFilter();
  });
}

function reapplySortAndFilter(): void {
  const tbody = activeTable?.querySelector<HTMLTableSectionElement>('tbody');
  if (!tbody) return;

  state.applying = true;
  applySortAndFilter(tbody, state.rowsMeta, {
    sortDir: state.sortDir,
    filterFactionIds: state.filterFactionIds,
  });
  queueMicrotask(() => {
    state.applying = false;
  });
}

// Faction sort cycles like a typical column: none -> asc -> desc -> none.
function onFactionSortClick(): void {
  state.sortDir = state.sortDir === null ? 'asc' : state.sortDir === 'asc' ? 'desc' : null;
  setFactionHeaderSortIcon(factionHeaderEl, state.sortDir);
  reapplySortAndFilter();
}

function onFactionFilterClick(anchorEl: HTMLElement): void {
  const options: ChecklistOption[] = [{ id: UNASSIGNED, name: 'Unassigned', color: '#888888' }, ...state.factions];
  openChecklistMenu(anchorEl, options, state.filterFactionIds, (id, checked) => {
    if (checked) state.filterFactionIds.add(id);
    else state.filterFactionIds.delete(id);
    setFactionHeaderFilterActive(factionHeaderEl, state.filterFactionIds.size > 0);
    reapplySortAndFilter();
  });
}

// Clicking any *other* column's own sort control should cede control back
// to the site's native sort — otherwise our tbody observer would just
// reapply the Faction sort on top and the native click would look like it
// did nothing. Filtering stays independent (it only hides rows) so it's
// left alone here.
function onTheadClick(ev: MouseEvent): void {
  const th = (ev.target as HTMLElement).closest('th');
  if (!th || th === factionHeaderEl) return;
  if (state.sortDir !== null) {
    state.sortDir = null;
    setFactionHeaderSortIcon(factionHeaderEl, null);
    reapplySortAndFilter();
  }
}

function observeRows(table: HTMLTableElement): MutationObserver | null {
  const tbody = table.querySelector('tbody');
  if (!tbody) return null;

  const observer = new MutationObserver(() => {
    if (state.applying) return;
    processRows(table);
    reapplySortAndFilter();
  });
  observer.observe(tbody, { childList: true, subtree: true, characterData: true });
  return observer;
}

async function loadSharedData(): Promise<void> {
  const [factions, assignments] = await Promise.all([
    sendMessage<Faction[]>('getFactions').catch(() => []),
    sendMessage<AssignmentsMap>('getAssignments').catch(() => ({})),
  ]);
  state.factions = factions || [];
  state.assignments = assignments || {};
}

async function init(table: HTMLTableElement): Promise<void> {
  activeTable = table;
  state.rowsMeta = new Map();
  state.sortDir = null;
  state.filterFactionIds = new Set();

  await loadSharedData();

  // The modal may have closed while we were awaiting the network calls.
  if (activeTable !== table || !document.contains(table)) return;

  processRows(table);
  reapplySortAndFilter();
  tbodyObserver = observeRows(table);

  const thead = table.querySelector('thead');
  if (thead) {
    theadClickListener = onTheadClick;
    thead.addEventListener('click', theadClickListener, true);
  }
}

function teardown(): void {
  if (tbodyObserver) {
    tbodyObserver.disconnect();
    tbodyObserver = null;
  }
  if (theadClickListener && activeTable) {
    const thead = activeTable.querySelector('thead');
    if (thead) thead.removeEventListener('click', theadClickListener, true);
    theadClickListener = null;
  }
  closeAnyOpenMenu();
  state.rowsMeta = new Map();
  activeTable = null;
  factionHeaderEl = null;
}

function check(): void {
  const table = findTable();
  if (table && table !== activeTable) {
    init(table);
  } else if (!table && activeTable) {
    teardown();
  }
  processMemberCards();
}

// Debounced: MutationObserver already batches synchronous mutations into one
// callback, but this observer spans the whole document (not scoped to one
// table's tbody), so separate bursts of unrelated page activity could still
// call check() far more often than needed. Coalescing into one scan per
// animation frame is a cheap safety margin on top of the idempotency fix in
// processRows/processMemberCards (what actually prevents a self-triggering
// mutation loop).
let scheduled = false;
function scheduleCheck(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    check();
  });
}

let bodyObserver: MutationObserver | null = null;

// The Registrations table/modal and the Registered Groups cards can each
// appear and disappear client-side (modal open/close, tab switches, SPA
// navigation) without a page load, so this watches continuously rather than
// waiting once. Pages with only cards (Projects) never hit the table branch,
// hence the independent initial loadSharedData() rather than relying on
// init() (which only fires once a table shows up) to have fetched anything.
// Split out from module init (rather than an unconditional top-level call)
// so the popup's "enable faction tagging" toggle can start/stop this live,
// without needing a page reload either way.
function startWatching(): void {
  if (bodyObserver) return; // already running
  bodyObserver = new MutationObserver(scheduleCheck);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  loadSharedData().then(check);
}

// Reverses startWatching(): stops observing, and actively strips whatever's
// currently injected (rather than just letting things be, since the whole
// point of the toggle is for the page to look untouched again immediately).
// The one thing this can't cleanly undo is the "Export to CSV" button's
// relabeled aria-label / capture listener from hijackExportButton — safe to
// leave as-is (a stale label at worst), a full reset needs a page refresh.
function stopWatching(): void {
  bodyObserver?.disconnect();
  bodyObserver = null;

  if (activeTable) {
    removeInjectedElements(activeTable);
    for (const tr of state.rowsMeta.keys()) unmarkRow(tr);
  }
  teardown();

  for (const container of memberRowsMeta.keys()) {
    removeInjectedElements(container);
    unmarkRow(container);
  }
  memberRowsMeta.clear();
}

async function initFeatureToggle(): Promise<void> {
  let stored: Record<string, unknown>;
  try {
    stored = await browser.storage.local.get({ [FACTIONS_ENABLED_KEY]: FACTIONS_ENABLED_DEFAULT });
  } catch {
    // Reloading the extension (chrome://extensions -> refresh) tears down
    // its old runtime while any tab that already had this content script
    // injected keeps running the old instance — every browser.* call it
    // makes from then on throws "Extension context invalidated". There's no
    // recovery from inside that dead instance; the tab just needs a refresh
    // to pick up the new one, same as any other extension reload. Bail out
    // quietly instead of surfacing an unhandled rejection in the console.
    return;
  }
  if (stored[FACTIONS_ENABLED_KEY] !== false) startWatching();

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(FACTIONS_ENABLED_KEY in changes)) return;
    const enabled = changes[FACTIONS_ENABLED_KEY].newValue !== false;
    if (enabled) startWatching();
    else stopWatching();
  });
}

initFeatureToggle();
