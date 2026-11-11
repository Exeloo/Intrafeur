// Intrastek, isolated world: the key gate and the event modal's "Intrastek"
// button. The planning staffing UI lives in the planning board's side panel
// (planning-board/). The MAIN-world intrastek-page.ts tags the event modal
// with data-epitools-event-*; those are untrusted (the page can forge them):
// the id goes through parseEventId, the rest is display-only.
//
// Gate: an Intrastek key saved in the options (storage.local). No key =
// nothing here runs, and <html data-epitools-intrastek> is removed so the MAIN
// half stops tagging. There's deliberately no popup toggle.
//
// Old Intrastek mode, only while the new planning calendar (FLAGS.planningBoard)
// is off, i.e. on the site's own calendar: a toggle button cloned next to the
// site's planning-mode button (intrastekModeEnabled, the same key as the
// board's button) colours the calendar blocks by state for the target group,
// adds a legend with counters, and: left-click = the site's event modal + our
// popup opened in it (Alt+click: the modal only), Ctrl/⌘+click = select blocks
// for bulk writes (selection bar), right-click = menu (intrastek-calendar-ui.ts).
import browser from 'webextension-polyfill';
import { buildIconSvg } from './dom-inject';
import { datasetAttr, watchDom } from './shared/dom-watch';
import { getLocal, onLocalChange } from './shared/ext-storage';
import { el, errorText, setBusy, spinner, toast } from './shared/ui';
import { currentLang, LANG_DATASET_KEY } from '../i18n/core';
import { t } from '../i18n/intrastek';
import { FLAGS, flagValue } from '../settings';
import { closeOurMenu, openBlockMenu, removeSelectionBar, syncSelectionBar } from './intrastek-calendar-ui';
import {
  cachedState,
  clearCache,
  currentMe,
  EVENT_END_ATTR,
  EVENT_ID_ATTR,
  EVENT_START_ATTR,
  EVENT_TITLE_ATTR,
  fetchStatus,
  groupView,
  isFirstLoad,
  loadMe,
  meErrorText,
  onCacheChange,
  parseEventId,
  resetMe,
  targetGroupId,
} from './intrastek-client';
import { closeEventPopup, isEventPopupOpenFor, openEventPopup, type EventInfo } from './intrastek-ui';
import { INTRASTEK_API_KEY_KEY, INTRASTEK_API_URL_KEY, INTRASTEK_DEFAULT_GROUP_KEY, type IntrastekEventState } from '../types';

const BUTTON_CLASS = 'epitools-ik-btn';
const DOT_CLASS = 'epitools-ik-dot';
// Not the board's data-epitools-ik-mode: both features react to the same flag change.
const MODE_BUTTON_ATTR = 'data-epitools-ik-mode-native';
const LEGEND_CLASS = 'epitools-ik-legend';
const LEGEND_BODY_CLASS = 'epitools-ik-legend-body';
const GROUP_SELECT_CLASS = 'epitools-ik-group-select';
const GROUP_SELECT_SIG_ATTR = 'data-epitools-ik-groups';
const BADGE_CLASS = 'epitools-ik-badge';
const BADGE_KEY_ATTR = 'data-epitools-ik-badge';
const SELECTED_CLASS = 'epitools-ik-selected';
const SIG_ATTR = 'data-epitools-ik-sig';
const POS_ATTR = 'data-epitools-ik-pos';
const LEGEND_SIG_ATTR = 'data-epitools-ik-legend';
const BLOCK_CLASSES = ['epitools-ik-initialized', 'epitools-ik-proposed', 'epitools-ik-none', 'epitools-ik-linked', SELECTED_CLASS];
const BLOCK_SELECTOR = '.scheduler-event';
const MODE_KEY = 'intrastekModeEnabled';
// Fallback only (the button is found by shape first); EN + FR (FR unverified).
const PLANNING_MODE_LABEL = /planning mode|mode planning|mode planification/i;
// Tabler "users" icon.
const MODE_ICON_PATHS = [
  'M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
  'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2',
  'M16 3.13a4 4 0 0 1 0 7.75',
  'M21 21v-2a4 4 0 0 0 -3 -3.85',
];
// Badge icons (tabler link / hourglass): emoji render as tofu without an emoji font.
const BADGE_ICONS: Record<string, string[]> = {
  users: MODE_ICON_PATHS,
  link: ['M9 15l6 -6', 'M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464', 'M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463'],
  wait: ['M6.5 7h11', 'M6.5 17h11', 'M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z', 'M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z'],
};
// Left-click opened the site's modal for this event: open our popup in it
// once it's tagged (a few throttle ticks later), unless it never comes.
const AUTO_OPEN_MS = 4000;

let configuredGroupId = '';
let unwatch: (() => void) | null = null;
let keyPresent = false;
// The new planning calendar is on: the old mode stays off (the board has its own).
let boardOn: boolean = FLAGS.planningBoard.default;
let modeOn = false;
let statusError = '';
// Visible ids whose first status fetch is running (legend spinner).
let statusLoading = false;
// Some block carries our classes/badge (skips the cleanup scan when not).
let decorated = false;
let autoOpen: { id: number; until: number } | null = null;
// Ctrl/⌘+clicked event ids (bulk writes); dropped when they leave the view.
const selected = new Set<number>();
let selectionView = '';
// Visible blocks per state (legend counters) and the AERs they need.
let counts = { initialized: 0, proposed: 0, none: 0, linked: 0, aers: 0 };

function oldModeOn(): boolean {
  return keyPresent && !boardOn && modeOn;
}

function currentTarget(): string | null {
  const me = currentMe();
  return me ? targetGroupId(me, configuredGroupId) : null;
}

function dialogEvent(dialog: Element): EventInfo | null {
  const id = parseEventId(dialog.getAttribute(EVENT_ID_ATTR));
  if (!id) return null;
  return {
    id,
    title: dialog.getAttribute(EVENT_TITLE_ATTR) || '',
    start: dialog.getAttribute(EVENT_START_ATTR),
    end: dialog.getAttribute(EVENT_END_ATTR),
  };
}

// Over every group the key can see (the popup shows them all).
function dotState(state: IntrastekEventState | null): string {
  if (!state) return 'unknown';
  if (state.proposals.some((p) => p.status === 'PENDING')) return 'proposed';
  return state.activities.length ? 'initialized' : 'none';
}

function dotTitle(state: string): string {
  if (state === 'proposed') return t('dotProposed');
  if (state === 'initialized') return t('dotInitialized');
  return state === 'none' ? t('dotNone') : t('dotUnknown');
}

function buildButton(): HTMLButtonElement {
  const btn = el('button', BUTTON_CLASS);
  btn.type = 'button';
  btn.append(el('span', `${DOT_CLASS} ${DOT_CLASS}--unknown`), document.createTextNode('Intrastek'));
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void onButtonClick(btn);
  });
  return btn;
}

async function onButtonClick(btn: HTMLButtonElement): Promise<void> {
  // Re-read on click: React may reuse the modal DOM for another event.
  const dialog = btn.closest('section[role=dialog]');
  const event = dialog ? dialogEvent(dialog) : null;
  if (!dialog || !event || btn.disabled) return;
  // First click of the page waits for /extension/me: show it.
  const restore = currentMe() ? null : setBusy(btn);
  const who = await loadMe();
  restore?.();
  if (!who) {
    toast(meErrorText() || t('unreachable'), 'error');
    return;
  }
  openEventPopup(dialog, event, who, targetGroupId(who, configuredGroupId));
}

function syncModalButtons(): void {
  for (const dialog of Array.from(document.querySelectorAll('section[role=dialog]'))) {
    const event = dialogEvent(dialog);
    let btn = dialog.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`);
    if (!event) {
      btn?.remove();
      continue;
    }
    // A popup left open for another event (modal reused) is stale.
    if (dialog.querySelector('.epitools-ik-backdrop') && !isEventPopupOpenFor(dialog, event.id)) closeEventPopup();
    if (!btn) {
      const closeButton = dialog.querySelector<HTMLElement>('.mantine-Modal-close');
      const header = closeButton?.parentElement;
      if (!closeButton || !header) continue;
      btn = buildButton();
      header.insertBefore(btn, closeButton);
    }
    const kind = dotState(cachedState(event.id));
    const wanted = `${DOT_CLASS} ${DOT_CLASS}--${kind}`;
    const dot = btn.querySelector(`.${DOT_CLASS}`);
    if (dot && dot.className !== wanted) dot.className = wanted;
    const title = dotTitle(kind);
    if (btn.title !== title) btn.title = title;
    if (autoOpen && Date.now() > autoOpen.until) autoOpen = null;
    if (autoOpen?.id === event.id && !dialog.querySelector('.epitools-ik-backdrop')) {
      autoOpen = null;
      void onButtonClick(btn);
    }
    // Resolves true only when something was fetched: no check loop.
    fetchStatus([event.id]).then(
      (fetched) => fetched && kick(),
      () => undefined,
    );
  }
}

// --- Intrastek mode toggle button (next to "Enable planning mode") ---

// The site's header Group: the first button with a left section whose
// parent is a Mantine Group sitting next to a title, outside the calendar
// and any dialog. Falls back to the localized label.
// The planning's FullCalendar root. FullCalendar's own classes are hashed
// (`fc-classic-…`, `fc-HH`), there is no plain `.fc` element (verified live).
const CALENDAR_SELECTOR = '.scheduler-calendar';

function findPlanningModeButton(): HTMLButtonElement | null {
  // Current UI (verified live 2026-11): an icon-only ActionIcon whose tabler
  // icon is `calendar-cog`, label only in aria-label.
  const byIcon = Array.from(document.querySelectorAll('svg.tabler-icon-calendar-cog'))
    .map((svg) => svg.closest<HTMLButtonElement>(`button:not([${MODE_BUTTON_ATTR}])`))
    .find((b) => !!b && !b.closest(`[role=dialog], ${CALENDAR_SELECTOR}`));
  if (byIcon) return byIcon;
  const labelled = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`button[aria-label]:not([${MODE_BUTTON_ATTR}])`),
  ).find((b) => PLANNING_MODE_LABEL.test(b.getAttribute('aria-label') || '') && !b.closest(`[role=dialog], ${CALENDAR_SELECTOR}`));
  if (labelled) return labelled;
  const candidates = Array.from(
    document.querySelectorAll<HTMLButtonElement>(`button[data-with-left-section]:not([${MODE_BUTTON_ATTR}])`),
  ).filter((b) => !b.closest(`[role=dialog], ${CALENDAR_SELECTOR}`));
  const byShape = candidates.find((b) => {
    const group = b.parentElement;
    if (!group || !group.classList.contains('mantine-Group-root')) return false;
    const row = group.parentElement;
    return !!row && Array.from(row.children).some(
      (c) => c !== group && (/^H[1-6]$/.test(c.tagName) || c.classList.contains('mantine-Title-root') || !!c.querySelector('h1, h2, h3, .mantine-Title-root')),
    );
  });
  return byShape ?? candidates.find((b) => PLANNING_MODE_LABEL.test(b.textContent || '')) ?? null;
}

function buildModeButton(site: HTMLButtonElement): HTMLButtonElement {
  // Deep clone for the native look; cloneNode copies no listeners nor React
  // fiber expandos, and our click handler stops propagation so React's root
  // listener never sees it. The site's own button is never touched.
  const btn = site.cloneNode(true) as HTMLButtonElement;
  for (const node of [btn, ...Array.from(btn.querySelectorAll('*'))]) {
    node.removeAttribute('id');
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('aria-') || attr.name === 'data-active' || attr.name === 'data-loading') {
        node.removeAttribute(attr.name);
      }
    }
  }
  btn.removeAttribute('disabled');
  btn.removeAttribute('data-disabled');
  btn.type = 'button';
  btn.setAttribute(MODE_BUTTON_ATTR, '1');
  btn.classList.add('epitools-ik-mode-btn');

  const label = btn.querySelector('.mantine-Button-label') ?? btn;
  const leftSection = btn.querySelector('[data-position="left"]');
  const iconOnly = btn.querySelector('.mantine-ActionIcon-icon');
  if (iconOnly) {
    // Icon-only ActionIcon: swap the icon, keep the size, label via aria.
    const siteSvg = iconOnly.querySelector('svg');
    const icon = buildIconSvg(MODE_ICON_PATHS);
    const size = siteSvg?.getAttribute('width');
    if (size) {
      icon.setAttribute('width', size);
      icon.setAttribute('height', siteSvg?.getAttribute('height') || size);
    }
    iconOnly.replaceChildren(icon);
    btn.setAttribute('aria-label', t('modeLabel'));
  } else if (leftSection) {
    const siteSvg = leftSection.querySelector('svg');
    const icon = buildIconSvg(MODE_ICON_PATHS);
    const size = siteSvg?.getAttribute('width');
    if (size) {
      icon.setAttribute('width', size);
      icon.setAttribute('height', siteSvg?.getAttribute('height') || size);
    }
    leftSection.replaceChildren(icon);
  }
  if (iconOnly) {
    // Nothing to relabel: the tooltip is the title set in syncModeButton.
  } else if (label === btn) {
    // No label span: keep the icon section, replace the rest.
    for (const child of Array.from(btn.childNodes)) if (child !== leftSection) child.remove();
    btn.appendChild(document.createTextNode(t('modeLabel')));
  } else {
    label.textContent = t('modeLabel');
  }

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void browser.storage.local.set({ [MODE_KEY]: !modeOn }).catch(() => undefined);
    setMode(!modeOn);
  });
  return btn;
}

function hasCalendar(): boolean {
  return !!document.querySelector(CALENDAR_SELECTOR);
}

function syncModeButton(): HTMLElement | null {
  let ours = document.querySelector<HTMLButtonElement>(`button[${MODE_BUTTON_ATTR}]`);
  if (boardOn || !hasCalendar()) {
    ours?.remove();
    return null;
  }
  const site = findPlanningModeButton();
  if (!ours) {
    if (!site?.parentElement) return null;
    ours = buildModeButton(site);
  }
  // Left of "Enable planning mode". React places its own children by their
  // fiber's DOM nodes, so a foreign sibling is tolerated; if a re-render
  // moved things around, put ours back (only then, to avoid mutation loops).
  if (site?.parentElement && site.previousElementSibling !== ours) {
    site.parentElement.insertBefore(ours, site);
  }
  const pressed = modeOn ? 'true' : 'false';
  if (ours.getAttribute('aria-pressed') !== pressed) {
    ours.setAttribute('aria-pressed', pressed);
    ours.classList.toggle('epitools-ik-mode-on', modeOn);
  }
  const title = modeOn ? t('modeOnTitle') : t('modeOffTitle');
  if (ours.title !== title) ours.title = title;
  return ours;
}

// --- Block decoration (mode on) ---

// badge: space-separated tokens, an icon name (BADGE_ICONS) or text.
function blockDecoration(id: number): { cls: string; badge: string; aers: number } {
  const state = cachedState(id);
  if (!state) return { cls: '', badge: '', aers: 0 };
  const view = groupView(state, currentTarget());
  const aers = view.nbUserAsk !== null && view.nbUserAsk > 0 ? view.nbUserAsk : 0;
  const count = aers ? String(aers) : '?';
  // Merged into the previous event: its count, set there.
  if (view.linkedTo !== null) {
    const badge = view.initialized ? `link users ${count}` : view.proposal ? 'link wait' : 'link';
    return { cls: 'epitools-ik-linked', badge, aers: 0 };
  }
  if (view.proposal) {
    return { cls: 'epitools-ik-proposed', badge: view.initialized ? `wait users ${count}` : 'wait', aers };
  }
  if (view.initialized) return { cls: 'epitools-ik-initialized', badge: `users ${count}`, aers };
  return { cls: 'epitools-ik-none', badge: '', aers: 0 };
}

function fillBadge(node: HTMLElement, badge: string): void {
  node.replaceChildren(
    ...badge.split(' ').map((token) => (BADGE_ICONS[token] ? buildIconSvg(BADGE_ICONS[token]) : document.createTextNode(token))),
  );
  node.setAttribute(BADGE_KEY_ATTR, badge);
}

function undecorate(block: HTMLElement): void {
  block.classList.remove(...BLOCK_CLASSES);
  block.querySelector(`:scope > .${BADGE_CLASS}`)?.remove();
  block.removeAttribute(SIG_ATTR);
  if (block.hasAttribute(POS_ATTR)) {
    block.style.position = '';
    block.removeAttribute(POS_ATTR);
  }
}

function decorateBlocks(): void {
  const ids: number[] = [];
  const seen = new Set<number>();
  counts = { initialized: 0, proposed: 0, none: 0, linked: 0, aers: 0 };
  for (const block of Array.from(document.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))) {
    const id = parseEventId(block.getAttribute(EVENT_ID_ATTR));
    if (!id) {
      if (block.hasAttribute(SIG_ATTR)) undecorate(block);
      continue;
    }
    ids.push(id);
    const { cls, badge, aers } = blockDecoration(id);
    // An event split over several blocks (month view) counts once.
    if (cls && !seen.has(id)) {
      counts[cls.slice('epitools-ik-'.length) as 'initialized' | 'proposed' | 'none' | 'linked']++;
      counts.aers += aers;
    }
    seen.add(id);
    const sel = selected.has(id);
    const sig = `${id}|${cls}|${badge}|${sel}`;
    const badgeEl = block.querySelector<HTMLElement>(`:scope > .${BADGE_CLASS}`);
    // Never re-render what's already right (mutation loop otherwise); the
    // class/badge checks catch React resetting className or children.
    if (
      block.getAttribute(SIG_ATTR) === sig &&
      (!cls || block.classList.contains(cls)) &&
      (!sel || block.classList.contains(SELECTED_CLASS)) &&
      (badge ? badgeEl?.getAttribute(BADGE_KEY_ATTR) === badge : !badgeEl)
    ) {
      continue;
    }
    decorated = true;
    block.classList.remove(...BLOCK_CLASSES);
    if (cls) block.classList.add(cls);
    if (sel) block.classList.add(SELECTED_CLASS);
    // Badge and selection overlay are absolutely positioned inside the block.
    if ((badge || sel) && !block.hasAttribute(POS_ATTR) && getComputedStyle(block).position === 'static') {
      block.style.position = 'relative';
      block.setAttribute(POS_ATTR, '1');
    }
    if (badge) {
      const node = badgeEl ?? document.createElement('span');
      node.className = BADGE_CLASS;
      if (node.getAttribute(BADGE_KEY_ATTR) !== badge) fillBadge(node, badge);
      if (!badgeEl) block.appendChild(node);
    } else {
      badgeEl?.remove();
    }
    block.setAttribute(SIG_ATTR, sig);
  }

  // A selection never outlives its view (no writes to events off screen).
  // Not while nothing is tagged: blocks re-mount untagged for a tick.
  let dropped = false;
  for (const id of seen.size ? selected : []) {
    if (!seen.has(id)) {
      selected.delete(id);
      dropped = true;
    }
  }
  if (dropped) kick();

  statusLoading = false;
  if (!ids.length) return;
  fetchStatus(ids).then(
    (fetched) => {
      if (!fetched) return;
      statusError = '';
      if (modeOn) kick();
    },
    (err: unknown) => {
      statusError = errorText(err);
      // Unconditional (clears the spinner); no loop: the failed ids are in
      // backoff, so the next check fetches nothing.
      if (modeOn) kick();
    },
  );
  // fetchStatus registers its requests synchronously.
  statusLoading = isFirstLoad(ids);
}

function undecorateAll(): void {
  if (!decorated) return;
  decorated = false;
  for (const block of Array.from(document.querySelectorAll<HTMLElement>(`[${SIG_ATTR}]`))) undecorate(block);
  for (const badge of Array.from(document.querySelectorAll(`.${BADGE_CLASS}`))) badge.remove();
}

// --- Legend ---

function legendError(): string {
  return meErrorText() || statusError;
}

function swatch(cls: string, text: string): HTMLElement {
  const item = el('span', 'epitools-ik-legend-item');
  item.append(el('span', `epitools-ik-swatch ${cls}`), document.createTextNode(text));
  return item;
}

// The view's group select, first in the legend: which group the block colours
// (and the right-click / popup actions) are about. It writes the same
// storage.local key as the options page's default group, so both stay in
// sync; storage.onChanged then re-renders the blocks.
function buildGroupSelect(): HTMLSelectElement {
  const select = el('select', GROUP_SELECT_CLASS);
  select.addEventListener('change', () => {
    configuredGroupId = select.value;
    kick();
    void browser.storage.local.set({ [INTRASTEK_DEFAULT_GROUP_KEY]: select.value }).catch(() => undefined);
  });
  return select;
}

function syncGroupSelect(select: HTMLSelectElement): void {
  const groups = currentMe()?.groups ?? [];
  const gid = currentTarget() ?? '';
  const sig = `${currentLang()}|${groups.map((g) => `${g.id}:${g.name}`).join('|')}`;
  if (select.getAttribute(GROUP_SELECT_SIG_ATTR) !== sig) {
    select.setAttribute(GROUP_SELECT_SIG_ATTR, sig);
    select.setAttribute('aria-label', t('groupSelectAria'));
    const options = groups.length ? groups.map((g) => ({ id: g.id, name: g.name })) : [{ id: '', name: currentMe() ? t('noGroup') : t('loadingOption') }];
    select.replaceChildren(
      ...options.map((g) => {
        const option = el('option', undefined, g.name);
        option.value = g.id;
        return option;
      }),
    );
  }
  // Never fight the user while the list is open.
  if (document.activeElement !== select && select.value !== gid) select.value = gid;
  const disabled = groups.length < 2;
  if (select.disabled !== disabled) select.disabled = disabled;
}

function syncLegend(modeButton: HTMLElement | null): void {
  let legend = document.querySelector<HTMLElement>(`.${LEGEND_CLASS}`);
  if (!legend) {
    // Under the toolbar row (the outermost Mantine Group around the mode
    // button; the button now sits in nested Groups inside a flex row), else
    // above the calendar.
    let row: Element | null = null;
    for (let el = modeButton?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.classList.contains('mantine-Group-root')) row = el;
    }
    const calendar = document.querySelector(CALENDAR_SELECTOR);
    if (!row && !calendar) return;
    legend = el('div', LEGEND_CLASS);
    const label = el('label', 'epitools-ik-legend-group');
    label.append(el('span', 'epitools-ik-legend-group-label'), buildGroupSelect());
    legend.append(label, el('span', LEGEND_BODY_CLASS));
    if (row) row.insertAdjacentElement('afterend', legend);
    else calendar?.insertAdjacentElement('beforebegin', legend);
  }
  const select = legend.querySelector<HTMLSelectElement>(`.${GROUP_SELECT_CLASS}`);
  if (select) syncGroupSelect(select);
  const body = legend.querySelector<HTMLElement>(`.${LEGEND_BODY_CLASS}`);
  if (!body) return;
  const error = legendError();
  // Waiting for /extension/me or the first status of the visible blocks.
  const loading = !error && (!currentMe() || statusLoading);
  const c = counts;
  const sig = `${currentLang()}|${loading}|${error}|${c.initialized},${c.proposed},${c.none},${c.linked},${c.aers}`;
  if (body.getAttribute(LEGEND_SIG_ATTR) === sig) return;
  body.setAttribute(LEGEND_SIG_ATTR, sig);
  const groupLabel = legend.querySelector('.epitools-ik-legend-group-label');
  if (groupLabel) groupLabel.textContent = t('legendGroup');
  body.replaceChildren(
    swatch('epitools-ik-swatch--initialized', `${t('legendInitialized')} · ${c.initialized}`),
    swatch('epitools-ik-swatch--proposed', `${t('legendProposed')} · ${c.proposed}`),
    swatch('epitools-ik-swatch--none', `${t('legendNone')} · ${c.none}`),
    swatch('epitools-ik-swatch--linked', `${t('legendLinked')} · ${c.linked}`),
    el('span', 'epitools-ik-legend-total', t('legendTotal', { n: c.aers })),
    el('span', 'epitools-ik-legend-hint', t('legendHint')),
  );
  if (loading) body.appendChild(spinner(t('loadingStatus')));
  if (error) body.appendChild(el('span', 'epitools-ik-legend-error', error));
}

function removeLegend(): void {
  document.querySelector(`.${LEGEND_CLASS}`)?.remove();
}

// --- Right-click (mode on only) ---

function onContextMenu(ev: MouseEvent): void {
  if (!oldModeOn() || !(ev.target instanceof Element)) return;
  const block = ev.target.closest<HTMLElement>(BLOCK_SELECTOR);
  if (!block) return;
  // Only here: suppress the browser's and the site's own context menu.
  ev.preventDefault();
  ev.stopPropagation();
  const id = parseEventId(block.getAttribute(EVENT_ID_ATTR));
  if (!id) {
    toast(t('noIdYet'), 'info');
    return;
  }
  const event: EventInfo = {
    id,
    title: block.getAttribute(EVENT_TITLE_ATTR) || '',
    start: block.getAttribute(EVENT_START_ATTR),
    end: block.getAttribute(EVENT_END_ATTR),
  };
  const x = ev.pageX;
  const y = ev.pageY;
  void loadMe().then((who) => {
    if (!who) {
      toast(meErrorText() || t('unreachable'), 'error');
      return;
    }
    openBlockMenu({
      x,
      y,
      event,
      me: who,
      groupId: targetGroupId(who, configuredGroupId),
      // The site's own left-click behaviour (opens the event modal).
      onOpenDetails: () => block.isConnected && block.click(),
    });
  });
}

// --- Left-click (mode on only) ---

function onClick(ev: MouseEvent): void {
  // isTrusted: "Open details" (block.click()) and page-forged clicks keep
  // the site's plain behaviour.
  if (!oldModeOn() || !ev.isTrusted || ev.button !== 0 || !(ev.target instanceof Element)) return;
  const block = ev.target.closest<HTMLElement>(BLOCK_SELECTOR);
  if (!block || ev.target.closest('[role=dialog]')) return;
  const id = parseEventId(block.getAttribute(EVENT_ID_ATTR));
  if (ev.ctrlKey || ev.metaKey) {
    // Natively the same as a plain click (verified): ours for selecting.
    ev.preventDefault();
    ev.stopPropagation();
    if (!id) {
      toast(t('noIdYet'), 'info');
      return;
    }
    if (!selected.delete(id)) selected.add(id);
    kick();
    return;
  }
  if (ev.altKey || ev.shiftKey || !id) return;
  autoOpen = { id, until: Date.now() + AUTO_OPEN_MS };
}

function clearSelection(): void {
  if (!selected.size) return;
  selected.clear();
  kick();
}

// --- Main loop ---

// Only runs while a key is saved (subscribed in setKeyPresent).
function check(): void {
  syncModalButtons();
  const modeButton = syncModeButton();
  if (!oldModeOn() || !hasCalendar()) {
    removeLegend();
    undecorateAll();
    selected.clear();
    removeSelectionBar();
    return;
  }
  const me = currentMe();
  if (!me) {
    syncLegend(modeButton);
    // After a failure, no automatic retry on every mutation: toggling the
    // mode (or the modal button) retries.
    if (meErrorText()) return;
    void loadMe().then(() => {
      if (oldModeOn()) kick();
    });
    return;
  }
  // Week/day navigation (the URL's start/end) ends the selection.
  const params = new URLSearchParams(location.search);
  const view = `${params.get('start')}|${params.get('end')}`;
  if (view !== selectionView) {
    selectionView = view;
    selected.clear();
  }
  decorateBlocks();
  syncLegend(modeButton);
  syncSelectionBar({
    ids: Array.from(selected),
    me,
    groupId: currentTarget(),
    onClear: clearSelection,
    onDone: (failedIds) => {
      selected.clear();
      for (const id of failedIds) selected.add(id);
      kick();
    },
  });
}

function removeOldMode(): void {
  document.querySelector(`button[${MODE_BUTTON_ATTR}]`)?.remove();
  removeLegend();
  undecorateAll();
  closeOurMenu();
  selected.clear();
  removeSelectionBar();
}

function setMode(on: boolean): void {
  if (modeOn === on) return;
  modeOn = on;
  statusError = '';
  if (!on) closeOurMenu();
  // A failed me is retried when the mode is turned on again.
  if (on && !currentMe() && meErrorText()) resetMe();
  kick();
}

let kickTimer: ReturnType<typeof setTimeout> | undefined;
// Re-check for non-DOM reasons (status fetched). Throttle, never rAF.
function kick(): void {
  if (kickTimer !== undefined || !unwatch) return;
  kickTimer = setTimeout(() => {
    kickTimer = undefined;
    if (unwatch) check();
  }, 200);
}

function setKeyPresent(present: boolean): void {
  keyPresent = present;
  if (present) document.documentElement.dataset.epitoolsIntrastek = 'on';
  else delete document.documentElement.dataset.epitoolsIntrastek;
  if (present && !unwatch) {
    // EVENT_ID_ATTR: the MAIN half tags the modal after React rendered it.
    // The language attribute re-renders the old mode's labels.
    unwatch = watchDom(check, {
      delay: 200,
      bodyAttributes: [EVENT_ID_ATTR],
      htmlAttributes: [datasetAttr(LANG_DATASET_KEY)],
    });
  } else if (!present && unwatch) {
    unwatch();
    unwatch = null;
    for (const node of Array.from(document.querySelectorAll(`.${BUTTON_CLASS}`))) node.remove();
    closeEventPopup();
    removeOldMode();
  }
}

export async function init(): Promise<void> {
  const stored = await getLocal({
    [INTRASTEK_API_KEY_KEY]: '',
    [INTRASTEK_DEFAULT_GROUP_KEY]: '',
    [MODE_KEY]: false,
    [FLAGS.planningBoard.key]: FLAGS.planningBoard.default,
  });
  // null: "Extension context invalidated" (tab not reloaded after an extension reload).
  if (!stored) return;
  configuredGroupId = String(stored[INTRASTEK_DEFAULT_GROUP_KEY] || '');
  modeOn = stored[MODE_KEY] === true;
  boardOn = flagValue(FLAGS.planningBoard, stored[FLAGS.planningBoard.key]);
  setKeyPresent(!!stored[INTRASTEK_API_KEY_KEY]);

  onLocalChange([INTRASTEK_API_KEY_KEY, INTRASTEK_API_URL_KEY, INTRASTEK_DEFAULT_GROUP_KEY, MODE_KEY, FLAGS.planningBoard.key], (v) => {
    if (INTRASTEK_API_KEY_KEY in v || INTRASTEK_API_URL_KEY in v) {
      resetMe();
      clearCache();
      closeEventPopup();
      closeOurMenu();
      undecorateAll();
      if (INTRASTEK_API_KEY_KEY in v) setKeyPresent(!!v[INTRASTEK_API_KEY_KEY]);
    }
    if (INTRASTEK_DEFAULT_GROUP_KEY in v) configuredGroupId = String(v[INTRASTEK_DEFAULT_GROUP_KEY] || '');
    if (FLAGS.planningBoard.key in v) {
      boardOn = flagValue(FLAGS.planningBoard, v[FLAGS.planningBoard.key]);
      if (boardOn) removeOldMode();
    }
    if (MODE_KEY in v) setMode(v[MODE_KEY] === true);
    kick();
  });
  onCacheChange(kick);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('click', onClick, true);
}
