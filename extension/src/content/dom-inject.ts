// DOM injection helpers for the Attendances page. Kept free of any
// network/messaging concerns so it can be reused by future pages.
import type { Faction, RowMeta } from '../types';

const MARKER_ATTR = 'data-epitools-email';
const HEADER_MARKER_ATTR = 'data-epitools-header';
const FLUID_ATTR = 'data-epitools-fluid';
export const UNASSIGNED = '__unassigned__';
export type FactionKey = number | typeof UNASSIGNED;

// Same Tabler icons (sort arrows / vertical dots) the site's own column
// headers use, copied from the live DOM so ours blend in instead of
// showing plain ↕/⋮ text characters.
const SORT_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l4 -4l4 4m-4 -4v14"></path><path d="M21 15l-4 4l-4 -4m4 4v-14"></path></svg>';
const FILTER_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"></path><path d="M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"></path><path d="M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"></path></svg>';

export interface HeaderHandlers {
  onSortClick: () => void;
  onFilterClick: (anchor: HTMLElement) => void;
}

// Mirrors the native columns' own header chrome (label + sort arrow + a
// "..." menu button) instead of a separate toolbar, so Faction sort/filter
// lives in the same place the user already looks for Student/Promotion/etc.
export function ensureFactionHeaderCell(theadRow: HTMLTableRowElement, handlers: HeaderHandlers): HTMLTableCellElement {
  const existing = theadRow.querySelector<HTMLTableCellElement>(`th[${HEADER_MARKER_ATTR}]`);
  if (existing) return existing;

  const th = document.createElement('th');
  th.setAttribute(HEADER_MARKER_ATTR, '1');
  th.className = 'epitools-th';

  // Native column headers use a plain clickable <div> for the label, not a
  // <button> — this site applies global button styling (uppercase text,
  // font-weight 500) that overrode the th's own bold/normal-case text when
  // these were <button> elements. role="button" + tabIndex keeps them
  // keyboard-accessible without picking up that styling.
  const sortBtn = document.createElement('div');
  sortBtn.className = 'epitools-th-sort';
  sortBtn.setAttribute('role', 'button');
  sortBtn.tabIndex = 0;
  sortBtn.innerHTML = `<span class="epitools-th-label">Faction</span><span class="epitools-sort-icon">${SORT_ICON_SVG}</span>`;
  sortBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handlers.onSortClick();
  });
  sortBtn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      handlers.onSortClick();
    }
  });

  const filterBtn = document.createElement('div');
  filterBtn.className = 'epitools-th-filter';
  filterBtn.setAttribute('role', 'button');
  filterBtn.tabIndex = 0;
  filterBtn.innerHTML = FILTER_ICON_SVG;
  filterBtn.title = 'Filter by faction';
  filterBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handlers.onFilterClick(filterBtn);
  });
  filterBtn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      handlers.onFilterClick(filterBtn);
    }
  });

  th.appendChild(sortBtn);
  th.appendChild(filterBtn);
  theadRow.appendChild(th);
  return th;
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

function readableTextColor(hexColor: string): string {
  const hex = (hexColor || '#888888').replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
}

// Badge filled solid with the faction's own color, with text color picked
// for contrast against it rather than a fixed white/black.
function renderBadge(cell: HTMLElement, faction: Faction | null): HTMLButtonElement {
  cell.innerHTML = '';
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'epitools-badge';
  const color = faction ? faction.color : '#888888';
  badge.textContent = faction ? faction.name : 'Unassigned';
  badge.style.backgroundColor = color;
  badge.style.color = readableTextColor(color);
  cell.appendChild(badge);
  return badge;
}

export function closeAnyOpenMenu(): void {
  document.querySelector('.epitools-menu')?.remove();
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

  const menu = document.createElement('div');
  menu.className = 'epitools-menu';

  const noneItem = document.createElement('button');
  noneItem.type = 'button';
  noneItem.className = 'epitools-menu-item';
  noneItem.textContent = 'Unassigned';
  if (currentFactionId == null) noneItem.classList.add('epitools-menu-item-active');
  noneItem.addEventListener('click', () => {
    closeAnyOpenMenu();
    onPick(null);
  });
  menu.appendChild(noneItem);

  for (const faction of factions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'epitools-menu-item';
    const swatch = document.createElement('span');
    swatch.className = 'epitools-swatch';
    swatch.style.backgroundColor = faction.color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(faction.name));
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

  const menu = document.createElement('div');
  menu.className = 'epitools-menu';

  for (const option of options) {
    const item = document.createElement('label');
    item.className = 'epitools-menu-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checkedIds.has(option.id);
    checkbox.addEventListener('change', () => onToggle(option.id, checkbox.checked));
    item.appendChild(checkbox);
    const swatch = document.createElement('span');
    swatch.className = 'epitools-swatch';
    swatch.style.backgroundColor = option.color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(option.name));
    menu.appendChild(item);
  }

  positionMenu(menu, anchorEl);
  return menu;
}

export function ensureRowCell(
  tr: HTMLTableRowElement,
  email: string,
  faction: Faction | null,
  factions: Faction[],
  onAssign: (email: string, factionId: number | null) => void,
): HTMLTableCellElement {
  let td = tr.querySelector<HTMLTableCellElement>(`td[${HEADER_MARKER_ATTR}]`);
  if (!td) {
    td = document.createElement('td');
    td.setAttribute(HEADER_MARKER_ATTR, '1');
    td.className = 'epitools-td';
    tr.appendChild(td);
  }

  const badge = renderBadge(td, faction);
  badge.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openFactionMenu(badge, factions, faction ? faction.id : null, (factionId) => {
      onAssign(email, factionId);
    });
  });

  return td;
}

export function markRow(tr: HTMLTableRowElement, email: string): void {
  tr.setAttribute(MARKER_ATTR, email);
}

export function getRowEmail(tr: HTMLTableRowElement): string | null {
  return tr.getAttribute(MARKER_ATTR);
}

export function isRowMarked(tr: HTMLTableRowElement): boolean {
  return tr.hasAttribute(MARKER_ATTR);
}

export interface SortAndFilterOptions {
  sortDir: 'asc' | 'desc' | null;
  filterFactionIds: Set<FactionKey>;
}

// sortDir null | 'asc' | 'desc' — name-sort was dropped since the site's own
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
    tr.style.display = visible ? '' : 'none';
  }

  if (sortDir) {
    const sorted = rows.slice().sort((a, b) => {
      const ma = rowsMeta.get(a);
      const mb = rowsMeta.get(b);
      if (!ma || !mb) return 0;
      const cmp = (ma.factionName || '').localeCompare(mb.factionName || '');
      return sortDir === 'desc' ? -cmp : cmp;
    });

    for (const tr of sorted) {
      tbody.appendChild(tr);
    }
  }
}
