import browser from 'webextension-polyfill';
import { extractRowOriginal, fallbackKeyFromText } from './fiber-extract';
import {
  UNASSIGNED,
  ensureFactionHeaderCell,
  setFactionHeaderSortIcon,
  setFactionHeaderFilterActive,
  enableFluidColumns,
  ensureRowCell,
  markRow,
  isRowMarked,
  applySortAndFilter,
  closeAnyOpenMenu,
  openChecklistMenu,
  type FactionKey,
  type ChecklistOption,
} from './dom-inject';
import type { Faction, RowMeta, AssignmentsMap, MessageType } from '../types';

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

function sendMessage<T>(type: MessageType, payload: unknown = {}): Promise<T> {
  return browser.runtime.sendMessage({ type, payload }) as Promise<T>;
}

// Other tables on this site also have a "Student" column (e.g. the plain
// Units registrations list), so require "Attendance" too to make sure we
// grab the Registrations modal's table specifically. This modal can be
// opened from several places (Planning, a Unit's activities, ...) without
// a distinguishing URL, so we look for the table shape rather than a route.
function findTable(): HTMLTableElement | undefined {
  const tables = Array.from(document.querySelectorAll('table'));
  return tables.find((t) => {
    const headers = Array.from(t.querySelectorAll('th')).map((th) => th.textContent?.trim());
    return headers.includes('Student') && headers.includes('Attendance');
  });
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
function buildRowMeta(tr: HTMLTableRowElement): { email: string | null; fullName: string } {
  const firstCell = tr.querySelector('td');
  const paragraphs = firstCell ? Array.from(firstCell.querySelectorAll('p')) : [];
  const emailParagraph = paragraphs.find((p) => p.textContent?.includes('@'));

  if (emailParagraph) {
    const email = emailParagraph.textContent!.trim();
    const fullName = (paragraphs[0] || emailParagraph).textContent!.trim();
    return { email, fullName };
  }

  const original = extractRowOriginal(tr);
  if (original?.login) {
    const fullName = [original.firstname, original.lastname].filter(Boolean).join(' ');
    return { email: original.login, fullName };
  }

  const email = fallbackKeyFromText(tr);
  const fullName = (firstCell?.textContent || '').trim();
  console.warn('[Epitools] falling back to name-derived key for a row; tagging may be less reliable.');
  return { email, fullName };
}

function refreshRowBadge(tr: HTMLTableRowElement, meta: RowMeta): void {
  const faction = factionById(meta.factionId);
  ensureRowCell(tr, meta.email, faction, state.factions, onAssign);
}

function processRows(table: HTMLTableElement): void {
  const theadRow = table.querySelector<HTMLTableRowElement>('thead tr');
  if (theadRow) {
    factionHeaderEl = ensureFactionHeaderCell(theadRow, {
      onSortClick: onFactionSortClick,
      onFilterClick: onFactionFilterClick,
    });
    setFactionHeaderSortIcon(factionHeaderEl, state.sortDir);
    setFactionHeaderFilterActive(factionHeaderEl, state.filterFactionIds.size > 0);
    enableFluidColumns(table);
  }

  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
    if (isRowMarked(tr) && state.rowsMeta.has(tr)) {
      // Already processed; just make sure the badge reflects current state
      // (covers the case where assignments changed elsewhere).
      refreshRowBadge(tr, state.rowsMeta.get(tr)!);
      continue;
    }

    const { email, fullName } = buildRowMeta(tr);
    if (!email) continue;

    markRow(tr, email);
    const factionId = state.assignments[email] ?? null;
    const meta: RowMeta = { email, fullName, factionId, factionName: factionById(factionId)?.name || '' };
    state.rowsMeta.set(tr, meta);
    refreshRowBadge(tr, meta);
  }
}

function onAssign(email: string, factionId: number | null): void {
  const previous = state.assignments[email] ?? null;
  if (factionId == null) delete state.assignments[email];
  else state.assignments[email] = factionId;

  for (const [tr, meta] of state.rowsMeta.entries()) {
    if (meta.email === email) {
      meta.factionId = factionId;
      meta.factionName = factionById(factionId)?.name || '';
      refreshRowBadge(tr, meta);
    }
  }
  reapplySortAndFilter();

  sendMessage('setAssignment', { email, factionId }).catch((err) => {
    console.error('[Epitools] failed to save assignment, reverting', err);
    if (previous == null) delete state.assignments[email];
    else state.assignments[email] = previous;
    for (const [tr, meta] of state.rowsMeta.entries()) {
      if (meta.email === email) {
        meta.factionId = previous;
        meta.factionName = factionById(previous)?.name || '';
        refreshRowBadge(tr, meta);
      }
    }
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

async function init(table: HTMLTableElement): Promise<void> {
  activeTable = table;
  state.rowsMeta = new Map();
  state.sortDir = null;
  state.filterFactionIds = new Set();

  const [factions, assignments] = await Promise.all([
    sendMessage<Faction[]>('getFactions').catch(() => []),
    sendMessage<AssignmentsMap>('getAssignments').catch(() => ({})),
  ]);
  state.factions = factions || [];
  state.assignments = assignments || {};

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

// The Registrations table lives inside a modal that can open and close
// repeatedly (for different events) without a page navigation, so this
// watches continuously rather than waiting for the table once.
function watchForTable(): void {
  const check = () => {
    const table = findTable();
    if (table && table !== activeTable) {
      init(table);
    } else if (!table && activeTable) {
      teardown();
    }
  };

  const bodyObserver = new MutationObserver(check);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  check();
}

watchForTable();
