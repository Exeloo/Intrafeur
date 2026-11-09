// "Units" tab on a student's page (/students/<login>): lists every unit
// instance of a school year the student is registered to, then the units of
// their semester (and campus) they're not registered to.
//
// The site has no per-student units endpoint, so this lists the year's unit
// instances (GET /units/instances, only those the staff member can see) and
// checks each one's registrations (GET /units/:year/:code/:instance/registrations;
// not /students, which lists every *eligible* student, verified live),
// through the site's own API client (bearer auth inside, found via fibers
// like absence-status.ts). Only fetched when the tab is opened, cached per
// student + year until reload.
//
// The tab is a deep clone of a native tab button (no React fiber/listeners).
// While it's open the site's tab content is hidden by CSS (never removed:
// React owns it) and our panel is shown after it; clicking any native tab
// closes it. MAIN world, so no browser.*; the toggle is mirrored onto
// <html data-epitools-student-units="on"> (FLAGS.studentUnits). Student data
// stays in memory only.
import { findApiClient, type ApiClientLike, type UnitInstance, type UnitStudent } from './fiber-extract';
import { cloneButton, setButtonLabel } from './shared/mantine';
import { el, errorText, spinner } from './shared/ui';
import { datasetAttr, watchDom } from './shared/dom-watch';
import { FLAGS, mirroredFlagOn } from '../settings';
import { currentLocale, LANG_DATASET_KEY } from '../i18n/core';
import { t } from '../i18n/student-units';

const TAB_ATTR = 'data-epitools-units-tab';
const PANEL_ATTR = 'data-epitools-units-panel';
const HIDDEN_ATTR = 'data-epitools-units-hidden';
const OPEN_ATTR = 'data-epitools-units-open';
const CONCURRENCY = 6;

// tabler "books" icon.
const ICON_PATHS = [
  'M5 4m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z',
  'M9 4m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z',
  'M5 8h4',
  'M9 16h4',
  'M13.803 4.56l2.184 -.53c.562 -.135 1.133 .19 1.282 .732l3.695 13.418a1.02 1.02 0 0 1 -.634 1.219l-.133 .041l-2.184 .53c-.562 .135 -1.133 -.19 -1.282 -.732l-3.695 -13.418a1.02 1.02 0 0 1 .634 -1.219l.133 -.041z',
  'M14 9l4 -1',
  'M16 16l3.923 -.98',
];

interface Result {
  registered: UnitInstance[];
  // Units of the student's semester (and campus) they're not registered to;
  // null when their semester is unknown (registered to nothing visible).
  missing: UnitInstance[] | null;
  semester: string;
  failed: number;
}

const cache = new Map<string, Promise<Result>>();
// Where an in-flight fetch reports its progress: the latest panel opened for
// that key (the tab can be closed and reopened while it runs).
const progressOf = new Map<string, (done: number, total: number) => void>();
let openLogin: string | null = null;
let year = defaultSchoolYear();

// School years start in September (a 2026 unit runs 2026-09 → 2027-08).
function defaultSchoolYear(): number {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

function pageLogin(): string | null {
  const match = /^\/students\/([^/]+)\/?$/.exec(location.pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
}

// The desktop tab bar: a container whose buttons include the active tab
// (aria-current), inside the student page header.
function findTabBar(): HTMLElement | null {
  const header = document.querySelector('[data-testid="section-page-header"]');
  const active = header?.querySelector(':scope .mantine-visible-from-sm > button[aria-current]');
  return (active?.parentElement as HTMLElement | null) ?? null;
}

// The site's tab content: the header's next sibling.
function findContent(): HTMLElement | null {
  const next = document.querySelector('[data-testid="section-page-header"]')?.nextElementSibling;
  return next instanceof HTMLElement && !next.hasAttribute(PANEL_ATTR) ? next : null;
}

// --- Data ---

function byStart(a: UnitInstance, b: UnitInstance): number {
  return (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.unitCode.localeCompare(b.unitCode);
}

async function fetchUnits(
  api: ApiClientLike,
  login: string,
  schoolYear: number,
  onProgress: (done: number, total: number) => void,
): Promise<Result> {
  const units = api.units!;
  const list = ((await units.getAllUnitInstances!.call(units, schoolYear, false))?.data ?? []).filter(
    (u) => u.schoolYear === schoolYear,
  );
  const candidates = list.filter((u) => (u.registrationsCount ?? 1) > 0);
  const registered = new Set<UnitInstance>();
  const unchecked = new Set<UnitInstance>();
  let student: UnitStudent | undefined;
  let done = 0;
  let next = 0;
  onProgress(0, candidates.length);
  const worker = async () => {
    while (next < candidates.length) {
      const unit = candidates[next++];
      try {
        const registrations = await units.getRegistrations!.call(units, unit.schoolYear, unit.unitCode, unit.code);
        const row = Array.isArray(registrations)
          ? registrations.find((r) => r?.student?.login?.toLowerCase() === login)?.student
          : undefined;
        if (row) {
          registered.add(unit);
          if (!student?.semester && row.semester) student = row;
        }
      } catch {
        unchecked.add(unit);
      }
      onProgress(++done, candidates.length);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const semester = student?.semester;
  const campus = student?.campus?.code;
  const missing = semester
    ? list.filter(
        (u) =>
          !registered.has(u) &&
          !unchecked.has(u) &&
          (u.semesters ?? []).some((s) => s.id === semester.id) &&
          (!u.campuses?.length || !campus || u.campuses.some((c) => c.code === campus)),
      )
    : null;
  return {
    registered: [...registered].sort(byStart),
    missing: missing?.sort(byStart) ?? null,
    semester: semester ? `${semester.cursus?.code ?? ''} ${semester.num ?? ''}`.trim() : '',
    failed: unchecked.size,
  };
}

// --- Panel (the site's Mantine markup, captured live) ---

function stack(gap: string): HTMLElement {
  const node = el('div', 'm_6d731127 mantine-Stack-root');
  node.setAttribute('style', `--stack-gap: var(--mantine-spacing-${gap}); --stack-align: stretch; --stack-justify: flex-start;`);
  return node;
}

// "UNITS_" page title / section titles: Anton, orange underscore.
function title(text: string, order: 2 | 4): HTMLElement {
  const node = el(`h${order}`, 'm_8a5d1357 mantine-Title-root', text.toUpperCase());
  node.dataset.order = String(order);
  node.setAttribute(
    'style',
    `--title-fw: var(--mantine-h${order}-font-weight); --title-lh: var(--mantine-h${order}-line-height); ` +
      `--title-fz: var(--mantine-h${order}-font-size); font-family: Anton, sans-serif; letter-spacing: 0.02em;` +
      (order === 2 ? ' font-size: calc(1.75rem * var(--mantine-scale)); font-weight: 900;' : ''),
  );
  const underscore = el('span', 'mantine-focus-auto m_b6d8b162 mantine-Text-root', '_');
  underscore.dataset.inherit = 'true';
  underscore.style.color = 'var(--mantine-color-orange-6)';
  node.appendChild(underscore);
  return node;
}

function text(content: string, dimmed = false): HTMLElement {
  const node = el('p', 'mantine-focus-auto m_b6d8b162 mantine-Text-root', content);
  node.dataset.size = 'sm';
  node.style.fontSize = 'var(--mantine-font-size-sm)';
  if (dimmed) node.style.color = 'var(--mantine-color-dimmed)';
  return node;
}

function codeBadge(code: string, color: string): HTMLElement {
  const badge = el('div', 'm_347db0ec mantine-Badge-root');
  badge.dataset.variant = 'light';
  badge.setAttribute(
    'style',
    'font-family: "Space Mono", monospace; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; ' +
      'text-transform: uppercase; white-space: nowrap; height: auto; padding: 3px 10px; --badge-radius: 0rem; ' +
      `--badge-bg: var(--mantine-color-${color}-light); --badge-color: var(--mantine-color-${color}-light-color); ` +
      '--badge-bd: calc(0.0625rem * var(--mantine-scale)) solid transparent;',
  );
  badge.appendChild(el('span', 'm_5add502a mantine-Badge-label', code));
  return badge;
}

function formatDate(iso?: string | null): string {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(currentLocale()) : '–';
}

function unitTable(units: UnitInstance[], color: string): HTMLElement {
  const paper = el('div', 'm_1b7284a3 mantine-Paper-root epitools-units-paper');
  paper.dataset.withBorder = 'true';
  paper.setAttribute('style', '--paper-radius: 0rem; --paper-shadow: var(--mantine-shadow-none); border: 1px solid var(--epitech-border);');
  const table = el('table', 'm_b23fa0ef mantine-Table-table epitools-units-table');
  table.setAttribute('style', '--table-horizontal-spacing: var(--mantine-spacing-xs); --table-vertical-spacing: var(--mantine-spacing-xs);');
  const row = (parent: HTMLTableSectionElement, index: number) => {
    const tr = parent.insertRow();
    tr.className = 'm_4e7aa4fd mantine-Table-tr';
    tr.dataset.withRowBorder = 'true';
    if (index >= 0) {
      tr.dataset.striped = 'odd';
      tr.dataset.hover = 'true';
    }
    return tr;
  };
  const thead = table.createTHead();
  thead.className = 'm_b242d975 mantine-Table-thead';
  const head = row(thead, -1);
  for (const label of ['colCode', 'colName', 'colInstance', 'colStart', 'colEnd', 'colStudents'] as const) {
    head.appendChild(el('th', 'm_4e7aa4f3 mantine-Table-th', t(label)));
  }
  const tbody = table.createTBody();
  tbody.className = 'm_b2404537 mantine-Table-tbody';
  units.forEach((unit, index) => {
    const tr = row(tbody, index);
    const cell = (child: Node | string) => {
      const td = tr.insertCell();
      td.className = 'm_4e7aa4ef mantine-Table-td';
      td.append(child);
      return td;
    };
    const link = el('a', 'mantine-focus-auto m_849cf0da m_b6d8b162 mantine-Text-root mantine-Anchor-root', unit.name || unit.unitCode);
    link.dataset.underline = 'hover';
    link.setAttribute('style', 'text-decoration: none; color: inherit; font-weight: 500;');
    link.href = `/units/${unit.schoolYear}/${encodeURIComponent(unit.unitCode)}/${encodeURIComponent(unit.code)}`;
    cell(codeBadge(unit.unitCode, color));
    cell(link);
    cell(text(unit.code));
    cell(text(formatDate(unit.startDate)));
    cell(text(formatDate(unit.endDate)));
    cell(text(String(unit.registrationsCount ?? '–')));
  });
  paper.appendChild(table);
  return paper;
}

function section(heading: string, units: UnitInstance[], empty: string, color: string): HTMLElement {
  const node = stack('sm');
  const header = el('div', 'epitools-units-section-header');
  header.append(title(heading, 4), codeBadge(String(units.length), color));
  node.append(header, units.length ? unitTable(units, color) : text(empty, true));
  return node;
}

function renderResult(body: HTMLElement, result: Result): void {
  body.replaceChildren();
  if (result.failed) {
    const warning = text(t('failed', { count: result.failed }));
    warning.style.color = 'var(--mantine-color-red-6)';
    body.appendChild(warning);
  }
  body.appendChild(section(t('registered'), result.registered, t('noRegistration'), 'blue'));
  body.appendChild(
    result.missing
      ? section(
          result.semester ? t('notRegisteredSemester', { semester: result.semester }) : t('notRegistered'),
          result.missing,
          t('allRegistered'),
          'orange',
        )
      : text(t('semesterUnknown'), true),
  );
}

function load(panel: HTMLElement, login: string): void {
  const body = panel.querySelector<HTMLElement>('[data-epitools-units-body]')!;
  const key = `${login}|${year}`;
  const loader = spinner(t('loading'));
  const progress = loader.querySelector('.epitools-loading-label')!;
  const status = text('', true);
  status.appendChild(loader);
  body.replaceChildren(status);
  progressOf.set(key, (done, total) => {
    if (progress.isConnected) progress.textContent = t('checking', { done, total });
  });
  let promise = cache.get(key);
  if (!promise) {
    const api = findApiClient(panel.previousElementSibling ?? panel);
    if (typeof api?.units?.getAllUnitInstances !== 'function' || typeof api.units.getRegistrations !== 'function') {
      status.textContent = t('noApi');
      return;
    }
    promise = fetchUnits(api, login, year, (done, total) => progressOf.get(key)?.(done, total));
    cache.set(key, promise);
    promise.catch(() => cache.delete(key)).finally(() => progressOf.delete(key));
  }
  promise.then(
    (result) => {
      // Ignore a stale answer (year switched, panel closed or replaced).
      if (body.isConnected && panel.dataset.epitoolsKey === key) renderResult(body, result);
    },
    (err) => {
      if (panel.dataset.epitoolsKey !== key) return;
      status.textContent = t('loadFailed', { error: errorText(err) });
    },
  );
}

function buildPanel(login: string): HTMLElement {
  const panel = stack('lg');
  panel.classList.add('epitools-units-panel');
  panel.setAttribute(PANEL_ATTR, login);
  const header = el('div', 'epitools-units-header');

  // Mantine NativeSelect markup.
  const wrapper = el('div', 'm_6c018570 mantine-Input-wrapper epitools-units-year');
  wrapper.dataset.variant = 'default';
  const select = el('select', 'm_8fb7ebe7 mantine-Input-input');
  select.dataset.variant = 'default';
  select.setAttribute('aria-label', t('schoolYear'));
  const current = defaultSchoolYear();
  for (let y = current + 1; y >= current - 5; y--) {
    const option = el('option', undefined, `${y}-${y + 1}`);
    option.value = String(y);
    option.selected = y === year;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    year = Number(select.value);
    panel.dataset.epitoolsKey = `${login}|${year}`;
    load(panel, login);
  });
  wrapper.appendChild(select);
  header.append(title(t('tab'), 2), wrapper);

  const body = stack('xl');
  body.setAttribute('data-epitools-units-body', '');
  panel.append(header, body);
  panel.dataset.epitoolsKey = `${login}|${year}`;
  return panel;
}

// --- Tab ---

function buildTab(template: HTMLElement): HTMLElement {
  const tab = cloneButton(template, TAB_ATTR, { paths: ICON_PATHS });
  tab.removeAttribute('aria-current');
  setButtonLabel(tab, t('tab'), 'span');
  tab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLogin = pageLogin();
    check();
  });
  return tab;
}

function close(): void {
  openLogin = null;
  document.querySelectorAll(`[${PANEL_ATTR}]`).forEach((p) => p.remove());
  document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((n) => n.removeAttribute(HIDDEN_ATTR));
  document.documentElement.removeAttribute(OPEN_ATTR);
}

function check(): void {
  const login = mirroredFlagOn(FLAGS.studentUnits) ? pageLogin() : null;
  const bar = login ? findTabBar() : null;
  if (!login || !bar) {
    document.querySelectorAll(`[${TAB_ATTR}]`).forEach((n) => n.remove());
    if (openLogin) close();
    return;
  }
  const tab = bar.querySelector<HTMLElement>(`:scope > [${TAB_ATTR}]`);
  // The tab can be built before the isolated bundle writes the language.
  if (tab) setButtonLabel(tab, t('tab'), 'span');
  else {
    const template = bar.querySelector<HTMLElement>(':scope > button:not([aria-current])');
    if (template) bar.appendChild(buildTab(template));
  }
  if (openLogin !== login) {
    if (openLogin) close();
    return;
  }

  const content = findContent();
  if (!content) return;
  let panel = document.querySelector<HTMLElement>(`[${PANEL_ATTR}]`);
  if (panel && (panel.getAttribute(PANEL_ATTR) !== login || panel.previousElementSibling !== content)) {
    panel.remove();
    panel = null;
  }
  if (!document.documentElement.hasAttribute(OPEN_ATTR)) document.documentElement.setAttribute(OPEN_ATTR, '');
  if (!content.hasAttribute(HIDDEN_ATTR)) content.setAttribute(HIDDEN_ATTR, '');
  if (!panel) {
    panel = buildPanel(login);
    content.after(panel);
    load(panel, login);
  }
}

export function init(): void {
  // A native tab (desktop bar or mobile section select) closes ours.
  document.addEventListener(
    'click',
    (e) => {
      if (!openLogin) return;
      const button = (e.target as Element | null)?.closest?.('button');
      if (button && !button.hasAttribute(TAB_ATTR) && button.parentElement === findTabBar()) close();
    },
    true,
  );
  window.addEventListener('hashchange', () => openLogin && close());
  // The popup toggle flips the mirrored attribute without any body mutation.
  watchDom(check, { htmlAttributes: [datasetAttr(FLAGS.studentUnits.mirror), datasetAttr(LANG_DATASET_KEY)] });
}
