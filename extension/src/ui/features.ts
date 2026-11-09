// chrome://flags-like feature list shared by the popup, the options page
// (Features) and the setup page (step 4). Built on settings.ts FLAGS: every
// flag needs an entry in FEATURES (typechecked), plus the extra rows below
// (language, Intrastek status). A select set to "Default" removes the stored
// key, so the flag follows its default; "Reset all" removes them all.
import browser from 'webextension-polyfill';
import { FLAGS, type FlagDef, type FlagId } from '../settings';
import { INTRASTEK_API_KEY_KEY } from '../types';
import { LANGUAGE_KEY } from '../i18n/core';
import { t, type PageKey } from '../i18n/pages';
import { armable, button, el, errorText, nextId, setStatus, statusLine } from './dom';
import { factionsConfigured } from './connections';

export type Section = 'factions' | 'intrastek';

interface FeatureMeta {
  title: PageKey;
  desc: PageKey;
  configure?: Section;
}

export const FEATURES = {
  factions: { title: 'fFactions', desc: 'fFactionsDesc', configure: 'factions' },
  unitFilters: { title: 'fUnitFilters', desc: 'fUnitFiltersDesc' },
  eventInfo: { title: 'fEventInfo', desc: 'fEventInfoDesc' },
  evalSheet: { title: 'fEvalSheet', desc: 'fEvalSheetDesc' },
  absenceStatus: { title: 'fAbsenceStatus', desc: 'fAbsenceStatusDesc' },
  attendancePresent: { title: 'fAttendancePresent', desc: 'fAttendancePresentDesc' },
  studentUnits: { title: 'fStudentUnits', desc: 'fStudentUnitsDesc' },
  hideGrades: { title: 'fHideGrades', desc: 'fHideGradesDesc' },
  intrastekMode: { title: 'fIntrastekMode', desc: 'fIntrastekModeDesc', configure: 'intrastek' },
} satisfies Record<FlagId, FeatureMeta>;

const ORDER: FlagId[] = [
  'factions',
  'unitFilters',
  'eventInfo',
  'evalSheet',
  'absenceStatus',
  'attendancePresent',
  'studentUnits',
  'hideGrades',
];

interface State {
  raw: Record<string, unknown>;
  factionsOk: boolean;
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function select(options: [string, string][], value: string): HTMLSelectElement {
  const node = el('select', 'input input--compact');
  for (const [v, label] of options) {
    const opt = el('option', undefined, label);
    opt.value = v;
    node.appendChild(opt);
  }
  node.value = value;
  return node;
}

/** Enabled/Disabled select for a flag; "default" removes the key. */
function flagSelect(flag: FlagDef, raw: unknown): HTMLSelectElement {
  const node = select(
    [
      ['default', t('optDefault', { value: flag.default ? t('enabled') : t('disabled') })],
      ['on', t('enabled')],
      ['off', t('disabled')],
    ],
    typeof raw === 'boolean' ? (raw ? 'on' : 'off') : 'default',
  );
  node.addEventListener('change', () => {
    const v = node.value;
    void (v === 'default'
      ? browser.storage.local.remove(flag.key)
      : browser.storage.local.set({ [flag.key]: v === 'on' }));
  });
  return node;
}

/** Language select (Auto / English / Français); also used by the options General panel. */
export function languageSelect(raw: unknown): HTMLSelectElement {
  const node = select(
    [
      ['auto', t('optDefault', { value: t('langAuto') })],
      ['en', 'English'],
      ['fr', 'Français'],
    ],
    raw === 'en' || raw === 'fr' ? raw : 'auto',
  );
  node.addEventListener('change', () => {
    void (node.value === 'auto'
      ? browser.storage.local.remove(LANGUAGE_KEY)
      : browser.storage.local.set({ [LANGUAGE_KEY]: node.value }));
  });
  return node;
}

interface Row {
  id: string;
  title: string;
  desc: string;
  control?: HTMLElement;
  note?: { text: string; kind: 'ok' | 'off' | 'warn' };
  configure?: Section;
  modified?: boolean;
}

function rowsFor(state: State, opts: ListOptions): Row[] {
  const { raw } = state;
  const rows: Row[] = [];
  if (opts.language) {
    rows.push({
      id: 'language',
      title: t('fLanguage'),
      desc: t('fLanguageDesc'),
      control: languageSelect(raw[LANGUAGE_KEY]),
      modified: raw[LANGUAGE_KEY] === 'en' || raw[LANGUAGE_KEY] === 'fr',
    });
  }
  for (const id of ORDER) {
    const meta: FeatureMeta = FEATURES[id];
    const flag = FLAGS[id];
    const row: Row = {
      id,
      title: t(meta.title),
      desc: t(meta.desc),
      control: flagSelect(flag, raw[flag.key]),
      configure: meta.configure,
      modified: typeof raw[flag.key] === 'boolean',
    };
    if (id === 'factions' && !state.factionsOk) row.note = { text: t('factionsNotConfigured'), kind: 'warn' };
    rows.push(row);
  }
  const hasKey = !!raw[INTRASTEK_API_KEY_KEY];
  rows.push({
    id: 'intrastek',
    title: t('fIntrastek'),
    desc: t('fIntrastekDesc'),
    note: hasKey ? { text: t('ikOnKey'), kind: 'ok' } : { text: t('ikOffNoKey'), kind: 'off' },
    configure: 'intrastek',
  });
  if (hasKey) {
    const meta: FeatureMeta = FEATURES.intrastekMode;
    const flag = FLAGS.intrastekMode;
    rows.push({
      id: 'intrastekMode',
      title: t(meta.title),
      desc: t(meta.desc),
      control: flagSelect(flag, raw[flag.key]),
      modified: typeof raw[flag.key] === 'boolean',
    });
  }
  return rows;
}

function renderRow(row: Row, openSection: (s: Section) => void): HTMLElement {
  const item = el('li', `flag${row.modified ? ' flag--modified' : ''}`);
  item.dataset.rowId = row.id;
  item.dataset.search = fold(`${row.title} ${row.desc}`);
  const text = el('div', 'flag-text');
  const title = el('h3', 'flag-title', row.title);
  title.id = nextId('flag-title');
  const desc = el('p', 'flag-desc', row.desc);
  desc.id = nextId('flag-desc');
  text.append(title, desc);
  if (row.note) text.appendChild(el('p', `flag-note flag-note--${row.note.kind}`, row.note.text));

  const side = el('div', 'flag-side');
  if (row.control) {
    row.control.setAttribute('aria-labelledby', title.id);
    row.control.setAttribute('aria-describedby', desc.id);
    side.appendChild(row.control);
  }
  if (row.configure) {
    const section = row.configure;
    const link = button(t('configure'), 'link');
    link.setAttribute('aria-label', `${t('configure')} – ${row.title}`);
    link.addEventListener('click', () => openSection(section));
    side.appendChild(link);
  }
  item.append(text, side);
  return item;
}

export interface ListOptions {
  /** Include the Language row (popup). */
  language?: boolean;
  /** Search box (default true). */
  search?: boolean;
  openSection: (section: Section) => void;
}

/** Renders the list into a new element; it re-renders itself on storage changes. */
export function featureList(opts: ListOptions): HTMLElement {
  const root = el('div', 'flags');
  const toolbar = el('div', 'flags-toolbar');
  const search = el('input', 'input flags-search');
  search.type = 'search';
  search.placeholder = t('searchFeatures');
  search.setAttribute('aria-label', t('searchFeatures'));
  const reset = button(t('resetAll'), 'btn btn--ghost btn--small');
  if (opts.search !== false) toolbar.appendChild(search);
  toolbar.appendChild(reset);
  const list = el('ul', 'flag-list');
  const empty = el('p', 'empty', t('noMatch'));
  empty.hidden = true;
  const status = statusLine();
  setStatus(status, t('loading'), 'loading');
  root.append(toolbar, status, list, empty);

  const keys = [
    ...Object.values(FLAGS).map((f) => f.key),
    INTRASTEK_API_KEY_KEY,
    ...(opts.language ? [LANGUAGE_KEY] : []),
  ];

  const applyFilter = (): void => {
    const q = fold(search.value.trim());
    let shown = 0;
    for (const item of Array.from(list.children) as HTMLElement[]) {
      item.hidden = !!q && !(item.dataset.search || '').includes(q);
      if (!item.hidden) shown += 1;
    }
    empty.hidden = shown > 0 || !list.children.length;
  };
  search.addEventListener('input', applyFilter);

  let factionsOk = true;
  const render = async (): Promise<void> => {
    let raw: Record<string, unknown>;
    try {
      raw = await browser.storage.local.get(keys);
    } catch (err) {
      setStatus(status, t('loadFailed', { message: errorText(err) }), 'error');
      return;
    }
    // Keep keyboard focus on the same row across re-renders.
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.flag');
    const focusedId = focused && list.contains(focused) ? focused.dataset.rowId : undefined;
    list.replaceChildren(...rowsFor({ raw, factionsOk }, opts).map((r) => renderRow(r, opts.openSection)));
    setStatus(status, '');
    applyFilter();
    if (focusedId) list.querySelector<HTMLElement>(`[data-row-id="${focusedId}"] select, [data-row-id="${focusedId}"] button`)?.focus();
  };

  const refreshFactions = (): void => {
    void factionsConfigured().then((ok) => {
      factionsOk = ok;
      void render();
    });
  };
  refreshFactions();
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && keys.some((k) => k in changes)) void render();
      if (area === 'sync') refreshFactions();
    });
  } catch {
    // context invalidated
  }

  armable(
    reset,
    () => {
      const toRemove = Object.values(FLAGS).map((f) => f.key);
      if (opts.language) toRemove.push(LANGUAGE_KEY);
      void browser.storage.local.remove(toRemove);
    },
    { armedLabel: t('resetAllConfirm') },
  );
  return root;
}
