// DOM injection helpers for the Faction column/badges. Kept free of any
// network/messaging concerns.
import type { Faction, RowMeta } from '../types';
import { t } from '../i18n/factions';
import { button, el, setBusy, spinner, toast } from './shared/ui';

const MARKER_ATTR = 'data-epitools-email';
const HEADER_MARKER_ATTR = 'data-epitools-header';
const FLUID_ATTR = 'data-epitools-fluid';
const EXPORT_HIJACK_ATTR = 'data-epitools-export-hijacked';
export const UNASSIGNED = '__unassigned__';
export type FactionKey = number | typeof UNASSIGNED;

// Same Tabler icons (sort arrows / vertical dots) the site's own column
// headers use, copied from the live DOM so ours blend in instead of
// showing plain ↕/⋮ text characters. Built via createElementNS rather than
// innerHTML — the addons-linter (rightly) flags any innerHTML assignment of
// a non-literal string as a potential XSS vector, even when, as here, the
// content is a fixed developer-authored constant.
const SVG_NS = 'http://www.w3.org/2000/svg';
const SORT_ICON_PATHS = ['M3 9l4 -4l4 4m-4 -4v14', 'M21 15l-4 4l-4 -4m4 4v-14'];
const FILTER_ICON_PATHS = [
  'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
];

export function buildIconSvg(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export interface HeaderHandlers {
  onSortClick: () => void;
  onFilterClick: (anchor: HTMLElement) => void;
}

// Mirrors the native columns' own header chrome (label + sort arrow + a
// "..." menu button) instead of a separate toolbar, so Faction sort/filter
// lives in the same place the user already looks for Student/Promotion/etc.
export function ensureFactionHeaderCell(
  theadRow: HTMLTableRowElement,
  handlers: HeaderHandlers,
  insertAfter?: HTMLTableCellElement | null,
): HTMLTableCellElement {
  const existing = theadRow.querySelector<HTMLTableCellElement>(`th[${HEADER_MARKER_ATTR}]`);
  if (existing) return existing;

  const th = el('th', 'epitools-th');
  th.setAttribute(HEADER_MARKER_ATTR, '1');

  const sortBtn = divButton('epitools-th-sort', () => handlers.onSortClick());
  const sortIconWrap = el('span', 'epitools-sort-icon');
  sortIconWrap.appendChild(buildIconSvg(SORT_ICON_PATHS));
  sortBtn.append(el('span', 'epitools-th-label', t('faction')), sortIconWrap);

  const filterBtn = divButton('epitools-th-filter', () => handlers.onFilterClick(filterBtn));
  filterBtn.appendChild(buildIconSvg(FILTER_ICON_PATHS));
  filterBtn.title = t('filterByFaction');
  filterBtn.setAttribute('aria-label', t('filterByFaction'));

  th.appendChild(sortBtn);
  th.appendChild(filterBtn);
  if (insertAfter && insertAfter.parentElement === theadRow) {
    insertAfter.after(th);
  } else {
    theadRow.appendChild(th);
  }
  return th;
}

// Native column headers use a plain clickable <div> for the label, not a
// <button>: this site applies global button styling (uppercase text,
// font-weight 500) that overrode the th's own text. role="button" +
// tabIndex keeps them keyboard-accessible without picking up that styling.
function divButton(className: string, onActivate: () => void): HTMLDivElement {
  const node = el('div', className);
  node.setAttribute('role', 'button');
  node.tabIndex = 0;
  node.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onActivate();
  });
  node.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onActivate();
    }
  });
  return node;
}

export function setFactionHeaderSortIcon(th: HTMLElement | null, sortDir: 'asc' | 'desc' | null): void {
  const icon = th?.querySelector('.epitools-sort-icon');
  if (!icon) return;
  icon.classList.toggle('epitools-sort-icon-active', !!sortDir);
  icon.classList.toggle('epitools-sort-icon-desc', sortDir === 'desc');
}

export function setFactionHeaderFilterActive(th: HTMLElement | null, active: boolean): void {
  const filterBtn = th?.querySelector('.epitools-th-filter');
  if (filterBtn) filterBtn.classList.toggle('epitools-th-filter-active', !!active);
}

// table-layout:fixed on this site's table means an appended column with no
// declared width grabs all the table's leftover space while squeezing the
// native columns down arbitrarily (it was measured grabbing 736px next to
// a ~120px badge, truncating other headers' text). Rather than computing
// pixel widths ourselves, flip the table to table-layout:auto and clear
// every column's fixed width via a CSS rule (see attendance.css) keyed off
// this marker — the browser's own auto-layout then sizes every column,
// native and ours alike, to fit its content, and the container's existing
// overflow-x: auto only kicks in if that genuinely doesn't fit.
export function enableFluidColumns(table: HTMLTableElement): void {
  if (table.getAttribute(FLUID_ATTR) === '1') return;
  table.setAttribute(FLUID_ATTR, '1');
}

// The site's own "Export to CSV" button reads from MRT's internal column
// model, which never learned about our DOM-injected Faction column, so its
// CSV can't include it. Rather than add a second lookalike button, take over
// the existing one: a capture-phase listener runs before React's own
// bubble-phase delegated click handler ever sees the event (same technique
// already used in attendance.ts's thead click listener to cede/steal sort
// control from native columns), so stopping propagation here fully replaces
// the native export instead of running alongside it.
// The button's aria-label is localized by the site's own UI language
// (verified live: French renders it "Exporter en CSV") — matched against
// both so the hijack still finds it regardless of UI language.
const EXPORT_BUTTON_LABELS = ['Export to CSV', 'Exporter en CSV'];

export function hijackExportButton(table: HTMLTableElement, onExport: () => void): void {
  const container = table.closest('.mrt-table-paper')?.querySelector('[class*="ToolbarInternalButtons"]');
  const btn = container
    ? Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        EXPORT_BUTTON_LABELS.includes(b.getAttribute('aria-label') || ''),
      )
    : undefined;
  if (!btn || btn.getAttribute(EXPORT_HIJACK_ATTR) === '1') return;

  const originalLabel = btn.getAttribute('aria-label') || 'Export to CSV';
  btn.setAttribute(EXPORT_HIJACK_ATTR, '1');
  const label = t('exportLabel', { label: originalLabel });
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.addEventListener(
    'click',
    (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onExport();
    },
    true,
  );
}

function readableTextColor(hexColor: string): string {
  const hex = (hexColor || '#888888').replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
}

const UNASSIGNED_COLOR = '#888888';

// What a faction cell shows: a spinner while the shared data loads, an
// "Unavailable" badge (click = the error) when it failed, else the faction
// badge, busy while its assignment is being saved.
export interface BadgeView {
  status: 'loading' | 'error' | 'ready' | 'busy';
  error?: string;
  faction: Faction | null;
  factions: Faction[];
  onPick: (factionId: number | null) => void;
}

// Badge filled solid with the faction's own color, with text color picked
// for contrast against it rather than a fixed white/black. `preventDefault`:
// the member cards sit inside a clickable <button> that navigates elsewhere.
function renderBadge(cell: HTMLElement, view: BadgeView, preventDefault = false): void {
  if (view.status === 'loading') {
    const loader = spinner('');
    loader.title = t('loading');
    loader.setAttribute('aria-label', t('loading'));
    cell.replaceChildren(loader);
    return;
  }
  const failed = view.status === 'error';
  const faction = failed ? null : view.faction;
  const color = faction ? faction.color : UNASSIGNED_COLOR;
  const badge = button(failed ? t('unavailable') : faction ? faction.name : t('unassigned'), 'epitools-badge');
  badge.style.backgroundColor = color;
  badge.style.color = readableTextColor(color);
  if (failed) badge.title = view.error || '';
  if (view.status === 'busy') setBusy(badge);
  badge.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (preventDefault) ev.preventDefault();
    if (failed) toast(view.error || t('unavailable'), 'error');
    else openFactionMenu(badge, view.factions, faction ? faction.id : null, view.onPick);
  });
  cell.replaceChildren(badge);
}

export function closeAnyOpenMenu(): void {
  document.querySelector('.epitools-menu')?.remove();
}

function swatch(color: string): HTMLSpanElement {
  const node = el('span', 'epitools-swatch');
  node.style.backgroundColor = color;
  return node;
}

function positionMenu(menu: HTMLElement, anchorEl: HTMLElement): void {
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${window.scrollY + rect.bottom + 4}px`;
  menu.style.left = `${window.scrollX + rect.left}px`;

  setTimeout(() => {
    document.addEventListener('click', function handler(ev) {
      if (!menu.contains(ev.target as Node) && ev.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

function openFactionMenu(
  anchorEl: HTMLElement,
  factions: Faction[],
  currentFactionId: number | null,
  onPick: (factionId: number | null) => void,
): void {
  closeAnyOpenMenu();

  const menu = el('div', 'epitools-menu');

  const noneItem = button(t('unassigned'), 'epitools-menu-item');
  if (currentFactionId == null) noneItem.classList.add('epitools-menu-item-active');
  noneItem.addEventListener('click', () => {
    closeAnyOpenMenu();
    onPick(null);
  });
  menu.appendChild(noneItem);

  for (const faction of factions) {
    const item = button('', 'epitools-menu-item');
    item.append(swatch(faction.color), faction.name);
    if (faction.id === currentFactionId) item.classList.add('epitools-menu-item-active');
    item.addEventListener('click', () => {
      closeAnyOpenMenu();
      onPick(faction.id);
    });
    menu.appendChild(item);
  }

  positionMenu(menu, anchorEl);
}

export interface ChecklistOption {
  id: FactionKey;
  name: string;
  color: string;
}

// Generic checkbox-list popup, used for the Faction column's filter menu.
export function openChecklistMenu(
  anchorEl: HTMLElement,
  options: ChecklistOption[],
  checkedIds: Set<FactionKey>,
  onToggle: (id: FactionKey, checked: boolean) => void,
): HTMLElement {
  closeAnyOpenMenu();

  const menu = el('div', 'epitools-menu');

  for (const option of options) {
    const item = el('label', 'epitools-menu-item');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checkedIds.has(option.id);
    checkbox.addEventListener('change', () => onToggle(option.id, checkbox.checked));
    item.append(checkbox, swatch(option.color), option.name);
    menu.appendChild(item);
  }

  positionMenu(menu, anchorEl);
  return menu;
}

export function ensureRowCell(
  tr: HTMLTableRowElement,
  view: BadgeView,
  insertAfter?: HTMLTableCellElement | null,
): HTMLTableCellElement {
  let td = tr.querySelector<HTMLTableCellElement>(`td[${HEADER_MARKER_ATTR}]`);
  if (!td) {
    td = el('td', 'epitools-td');
    td.setAttribute(HEADER_MARKER_ATTR, '1');
    if (insertAfter && insertAfter.parentElement === tr) insertAfter.after(td);
    else tr.appendChild(td);
  }
  renderBadge(td, view);
  return td;
}

// Same badge, for a person row that isn't a table cell — the Registered
// Groups cards (Projects) are a repeated <div> layout (avatar + name/email
// stack), not a <table>. `container` is that row's own flex wrapper (avatar
// + name/email), so the badge lands as a third item alongside them.
export function ensureMemberBadge(container: HTMLElement, view: BadgeView): HTMLElement {
  let wrap = container.querySelector<HTMLElement>(`span[${HEADER_MARKER_ATTR}]`);
  if (!wrap) {
    wrap = el('span', 'epitools-member-badge-wrap');
    wrap.setAttribute(HEADER_MARKER_ATTR, '1');
    container.appendChild(wrap);
  }
  renderBadge(wrap, view, true);
  return wrap;
}

export function markRow(node: HTMLElement, email: string): void {
  node.setAttribute(MARKER_ATTR, email);
}

export function isRowMarked(node: HTMLElement): boolean {
  return node.hasAttribute(MARKER_ATTR);
}

// Used when the faction feature is turned off live (popup toggle) so an
// already-processed row/card is treated as fresh again if it's turned back
// on later, rather than staying permanently skipped.
export function unmarkRow(node: HTMLElement): void {
  node.removeAttribute(MARKER_ATTR);
}

// Strips every Faction th/td/badge-wrap we injected under `root` (a table or
// a member card container), used by the same live-toggle-off path.
export function removeInjectedElements(root: ParentNode): void {
  root.querySelectorAll(`[${HEADER_MARKER_ATTR}]`).forEach((node) => node.remove());
}

export interface SortAndFilterOptions {
  sortDir: 'asc' | 'desc' | null;
  filterFactionIds: Set<FactionKey>;
}

// Idempotent (no DOM write when nothing changes), so it can run on every
// check. sortDir null | 'asc' | 'desc' — name-sort was dropped since the site's own
// Student column already sorts natively; Faction is the only sort this
// extension still needs to provide.
export function applySortAndFilter(
  tbody: HTMLTableSectionElement,
  rowsMeta: Map<HTMLTableRowElement, RowMeta>,
  { sortDir, filterFactionIds }: SortAndFilterOptions,
): void {
  const rows = Array.from(tbody.querySelectorAll('tr'));

  for (const tr of rows) {
    const meta = rowsMeta.get(tr);
    if (!meta) {
      tr.style.display = '';
      continue;
    }
    const factionKey: FactionKey = meta.factionId == null ? UNASSIGNED : meta.factionId;
    const visible = !filterFactionIds || filterFactionIds.size === 0 || filterFactionIds.has(factionKey);
    const display = visible ? '' : 'none';
    if (tr.style.display !== display) tr.style.display = display;
  }

  if (sortDir) {
    const sorted = rows.slice().sort((a, b) => {
      const ma = rowsMeta.get(a);
      const mb = rowsMeta.get(b);
      if (!ma || !mb) return 0;
      const cmp = (ma.factionName || '').localeCompare(mb.factionName || '');
      return sortDir === 'desc' ? -cmp : cmp;
    });

    // Only move rows when the order is actually wrong: every move is a
    // mutation that wakes the shared observer, which calls this again.
    if (sorted.some((tr, i) => tr !== rows[i])) {
      for (const tr of sorted) tbody.appendChild(tr);
    }
  }
}
