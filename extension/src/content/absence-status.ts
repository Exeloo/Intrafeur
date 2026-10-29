// Attendance button on each absence of the student page's Absences tab
// (/students/<login>#absences, "By activities" view): replaces the static
// "Absent" badge with the same badge-button + menu (Mark present / Mark
// absent / Justify absence) as the planning event modal's Attendance column,
// and calls the same site API (events.setAttendance) with the same payload.
//
// Runs in the page's MAIN world: the absence's event id and the student's
// login only exist in React fibers (see extractAbsenceCard), and the API is
// called through the site's own generated client (bearer auth inside), found
// as a React context value like the eval sheet's avatars. So no browser.*
// APIs here; the popup toggle is mirrored onto
// <html data-epitools-absence-status="on"> by event-info-toggle.ts.
//
// The button and menu are hand-built copies of the site's Mantine markup
// (classes and CSS variables captured live from the planning modal), not
// React components: the native badge is only hidden (CSS, see
// absence-status.css), never removed, so React can keep reconciling it.
import {
  extractAbsenceCard,
  findApiClient,
  findQueryClient,
  type AbsenceCard,
  type ApiClientLike,
  type AttendanceStatus,
  type QueryClientLike,
} from './fiber-extract';

const BUTTON_ATTR = 'data-epitools-absence-btn';
const NATIVE_ATTR = 'data-epitools-absence-native';
const MENU_ATTR = 'data-epitools-absence-menu';
const ERROR_MS = 2500;

interface StatusOption {
  status: AttendanceStatus;
  label: string;
  action: string;
  color: string;
  textColor: string;
  icon: string;
  paths: string[];
}

// Same order, colours, icons (tabler) and labels as the planning menu.
const OPTIONS: StatusOption[] = [
  {
    status: 'present',
    label: 'Present',
    action: 'Mark present',
    color: 'green',
    textColor: 'black',
    icon: 'user-check',
    paths: ['M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0', 'M6 21v-2a4 4 0 0 1 4 -4h4', 'M15 19l2 2l4 -4'],
  },
  {
    status: 'absent',
    label: 'Absent',
    action: 'Mark absent',
    color: 'red',
    textColor: 'white',
    icon: 'user-off',
    paths: [
      'M8.18 8.189a4.01 4.01 0 0 0 2.616 2.627m3.507 -.545a4 4 0 1 0 -5.59 -5.552',
      'M6 21v-2a4 4 0 0 1 4 -4h4c.412 0 .81 .062 1.183 .178m2.633 2.618c.12 .38 .184 .785 .184 1.204v2',
      'M3 3l18 18',
    ],
  },
  {
    status: 'justified',
    label: 'Justified',
    action: 'Justify absence',
    color: 'yellow',
    textColor: 'black',
    icon: 'user-exclamation',
    paths: [
      'M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0',
      'M6 21v-2a4 4 0 0 1 4 -4h4c.348 0 .686 .045 1.008 .128',
      'M19 16v3',
      'M19 22v.01',
    ],
  },
];

// Status set through this page, by card. The list itself only holds absent
// records with no status field, and isn't refetched after a change, so a
// marked-present absence stays visible (and can be reverted) until reload.
const statuses = new Map<string, AttendanceStatus>();
const pending = new Set<string>();

function cardKey(card: AbsenceCard): string {
  return `${card.login}|${card.eventId}|${card.startDate}`;
}

// The fiber key shape alone isn't proof (other student tabs may key cards
// `${id}-${date}` too, and a click would then write to an unrelated event):
// only accept a card the site's own absences list query actually holds.
function isListedAbsence(qc: QueryClientLike | null, absence: AbsenceCard): boolean {
  const records = qc
    ?.getQueryCache()
    .find({ queryKey: ['attendanceActivities', 'students', absence.login], exact: true })?.state.data;
  return (
    Array.isArray(records) &&
    records.some(
      (r: { eventId?: unknown; startDate?: unknown } | null) =>
        r?.eventId === absence.eventId && r?.startDate === absence.startDate,
    )
  );
}

function isEnabled(): boolean {
  return document.documentElement.dataset.epitoolsAbsenceStatus === 'on';
}

function optionOf(status: AttendanceStatus): StatusOption {
  return OPTIONS.find((o) => o.status === status) ?? OPTIONS[1];
}

// --- Badge button (copy of the planning's Attendance cell) ---

function styleBadge(badge: HTMLElement, option: StatusOption, label: string): void {
  // Inline style copied from the planning badge (filled variant).
  badge.setAttribute(
    'style',
    'font-family: "Space Mono", monospace; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; ' +
      'text-transform: uppercase; white-space: nowrap; height: auto; padding: 3px 10px; ' +
      '--badge-radius: 0rem; ' +
      `--badge-bg: var(--mantine-color-${option.color}-filled); ` +
      `--badge-color: var(--mantine-color-${option.textColor}); ` +
      '--badge-bd: calc(0.0625rem * var(--mantine-scale)) solid transparent; ' +
      'cursor: pointer; min-width: calc(6rem * var(--mantine-scale));',
  );
  const span = badge.firstElementChild as HTMLElement;
  span.textContent = label;
}

function buildButton(key: string, nativeLabel: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mantine-focus-auto m_87cf2631 mantine-UnstyledButton-root';
  button.style.textTransform = 'none';
  button.setAttribute(BUTTON_ATTR, key);
  button.setAttribute('aria-label', 'Attendance');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.dataset.epitoolsNativeLabel = nativeLabel;

  const badge = document.createElement('div');
  badge.className = 'm_347db0ec mantine-Badge-root';
  badge.dataset.variant = 'filled';
  const span = document.createElement('span');
  span.className = 'm_5add502a mantine-Badge-label';
  badge.appendChild(span);
  button.appendChild(badge);

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (button.getAttribute('aria-expanded') === 'true') closeMenu();
    else openMenu(button);
  });
  return button;
}

function renderButton(button: HTMLButtonElement): void {
  // flashError's timer re-renders once the error has been shown.
  if (button.dataset.epitoolsError) return;
  const key = button.getAttribute(BUTTON_ATTR) ?? '';
  const status = statuses.get(key) ?? 'absent';
  const option = optionOf(status);
  // The site's own (possibly localized) "Absent" label while unchanged.
  const label = status === 'absent' ? button.dataset.epitoolsNativeLabel || option.label : option.label;
  const badge = button.firstElementChild as HTMLElement;
  const busy = pending.has(key);
  if (button.dataset.epitoolsRendered === `${status}|${busy}`) return;
  button.dataset.epitoolsRendered = `${status}|${busy}`;
  styleBadge(badge, option, label);
  button.disabled = busy;
  button.style.opacity = busy ? '0.6' : '';
}

function flashError(button: HTMLButtonElement, message: string): void {
  const badge = button.firstElementChild as HTMLElement;
  button.dataset.epitoolsError = 'on';
  button.title = message;
  (badge.firstElementChild as HTMLElement).textContent = 'Error';
  window.clearTimeout(Number(button.dataset.epitoolsTimer));
  button.dataset.epitoolsTimer = String(
    window.setTimeout(() => {
      delete button.dataset.epitoolsError;
      button.removeAttribute('title');
      delete button.dataset.epitoolsRendered;
      renderButton(button);
    }, ERROR_MS),
  );
}

// --- Menu (copy of the planning's Mantine Menu dropdown) ---

let openMenuEl: HTMLElement | null = null;
let openMenuButton: HTMLButtonElement | null = null;

function icon(option: StatusOption): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: `var(--mantine-color-${option.color}-6)`,
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: `tabler-icon tabler-icon-${option.icon}`,
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of option.paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function buildMenuItem(option: StatusOption, button: HTMLButtonElement): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'mantine-focus-auto m_99ac2aa1 mantine-Menu-item m_87cf2631 mantine-UnstyledButton-root';
  item.tabIndex = -1;
  item.setAttribute('role', 'menuitem');
  item.dataset.menuItem = 'true';

  const section = document.createElement('div');
  section.className = 'm_8b75e504 mantine-Menu-itemSection';
  section.dataset.position = 'left';
  section.appendChild(icon(option));
  const label = document.createElement('div');
  label.className = 'm_5476e0d3 mantine-Menu-itemLabel';
  label.dataset.menuItemLabel = 'true';
  label.textContent = option.action;
  item.append(section, label);

  // Mantine marks the hovered/focused item with data-hovered.
  const hover = (on: boolean) => (on ? item.setAttribute('data-hovered', 'true') : item.removeAttribute('data-hovered'));
  item.addEventListener('mouseenter', () => item.focus());
  item.addEventListener('focus', () => hover(true));
  item.addEventListener('blur', () => hover(false));
  item.addEventListener('mouseleave', () => hover(false));
  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    button.focus();
    void setStatus(button, option.status);
  });
  return item;
}

function openMenu(button: HTMLButtonElement): void {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'm_38a85659 mantine-Menu-dropdown m_dc9b7c9f';
  menu.setAttribute(MENU_ATTR, '');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-orientation', 'vertical');
  menu.dataset.menuDropdown = 'true';
  menu.dataset.position = 'bottom-start';
  // Mantine's bottom-start placement, 8px offset, absolute in page coords.
  const rect = button.getBoundingClientRect();
  menu.setAttribute(
    'style',
    '--popover-shadow: var(--mantine-shadow-md); opacity: 1; z-index: 300; width: max-content; ' +
      `top: ${rect.bottom + window.scrollY + 8}px; left: ${rect.left + window.scrollX}px;`,
  );
  for (const option of OPTIONS) menu.appendChild(buildMenuItem(option, button));
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role=menuitem]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  });

  document.body.appendChild(menu);
  openMenuEl = menu;
  openMenuButton = button;
  button.setAttribute('aria-expanded', 'true');
  (menu.firstElementChild as HTMLElement | null)?.focus();
}

function closeMenu(): void {
  openMenuEl?.remove();
  openMenuButton?.setAttribute('aria-expanded', 'false');
  openMenuEl = null;
  openMenuButton = null;
}

window.addEventListener(
  'pointerdown',
  (e) => {
    const target = e.target as Node;
    if (openMenuEl && !openMenuEl.contains(target) && !openMenuButton?.contains(target)) closeMenu();
  },
  true,
);
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !openMenuEl) return;
    e.stopPropagation();
    const button = openMenuButton;
    closeMenu();
    button?.focus();
  },
  true,
);

// --- API ---

async function setStatus(button: HTMLButtonElement, status: AttendanceStatus): Promise<void> {
  const key = button.getAttribute(BUTTON_ATTR) ?? '';
  const card = button.closest('.mantine-Card-root');
  const absence = card ? extractAbsenceCard(card) : null;
  const api = card ? findApiClient(card) : null;
  const setAttendance = api?.events?.setAttendance;
  if (
    !card ||
    !absence ||
    cardKey(absence) !== key ||
    !isListedAbsence(findQueryClient(card), absence) ||
    !api ||
    typeof setAttendance !== 'function'
  ) {
    flashError(button, 'Could not read this absence from the page');
    return;
  }
  if (pending.has(key) || (statuses.get(key) ?? 'absent') === status) return;

  pending.add(key);
  renderButton(button);
  try {
    await setAttendance.call(api.events, absence.eventId, { records: [{ login: absence.login, status }] });
    statuses.set(key, status);
  } catch (err) {
    pending.delete(key);
    renderButton(button);
    flashError(button, err instanceof Error && err.message ? err.message : 'Attendance update failed');
    return;
  }
  pending.delete(key);
  renderButton(button);
}

// --- Injection ---

function removeAll(): void {
  closeMenu();
  document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((b) => b.remove());
  document.querySelectorAll(`[${NATIVE_ATTR}]`).forEach((b) => b.removeAttribute(NATIVE_ATTR));
}

function hasSetAttendance(api: ApiClientLike | null): boolean {
  return typeof api?.events?.setAttendance === 'function';
}

function check(): void {
  if (!isEnabled()) {
    removeAll();
    return;
  }
  // Drop our menu if its button was unmounted (page change, tab switch).
  if (openMenuButton && !openMenuButton.isConnected) closeMenu();

  let apiChecked: boolean | null = null;
  let qc: QueryClientLike | null | undefined;
  for (const card of Array.from(document.querySelectorAll('.mantine-Card-root'))) {
    let absence = extractAbsenceCard(card);
    if (absence) {
      if (qc === undefined) qc = findQueryClient(card);
      if (!isListedAbsence(qc, absence)) absence = null;
    }
    const existing = card.querySelector<HTMLButtonElement>(`[${BUTTON_ATTR}]`);
    if (!absence) {
      existing?.remove();
      continue;
    }
    const key = cardKey(absence);
    // React may reuse a card's DOM for another absence (pagination, filters).
    if (existing && existing.getAttribute(BUTTON_ATTR) === key && existing.isConnected) {
      renderButton(existing);
      continue;
    }
    existing?.remove();

    const native = card.querySelector<HTMLElement>(`.mantine-Badge-root:not([${BUTTON_ATTR}] *)`);
    if (!native?.parentElement) continue;
    if (apiChecked === null) apiChecked = hasSetAttendance(findApiClient(card));
    if (!apiChecked) return;

    native.setAttribute(NATIVE_ATTR, '');
    const button = buildButton(key, native.textContent?.trim() ?? '');
    native.after(button);
    renderButton(button);
  }
}

let checkTimer: number | undefined;

// Throttled, not debounced (see event-info.ts).
function scheduleCheck(): void {
  if (checkTimer !== undefined) return;
  checkTimer = window.setTimeout(() => {
    checkTimer = undefined;
    check();
  }, 150);
}

new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });
new MutationObserver(scheduleCheck).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-epitools-absence-status'],
});
check();
