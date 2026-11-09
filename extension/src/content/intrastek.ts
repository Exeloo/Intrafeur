// Intrastek, isolated-world half: everything the user sees and every API
// call (through the background, which holds the key). The MAIN-world
// intrastek-page.ts only tags the planning's calendar blocks and event modal
// with data-epitools-event-* attributes; those are untrusted here (the page
// can forge them): ids go through parseEventId, the rest is display-only.
//
// Feature gate: an Intrastek key saved in the options (storage.local). No
// key = nothing here runs, and <html data-epitools-intrastek> is removed so
// the MAIN half stops tagging. There's deliberately no popup toggle.
//
// - Event modal: an "Intrastek" button before the ×, with a state dot,
//   opening a popup mounted inside the Mantine dialog (intrastek-ui.ts).
// - Intrastek mode (toggle button cloned next to the site's "Enable planning
//   mode" button, persisted in intrastekModeEnabled): colours the calendar
//   blocks by state for the target group, adds a legend, and a right-click
//   menu. Left-click keeps the site's behaviour.
import browser from 'webextension-polyfill';
import { buildIconSvg } from './dom-inject';
import { watchDom, datasetAttr } from './shared/dom-watch';
import { getLocal, onLocalChange } from './shared/ext-storage';
import { el, errorText, setBusy, spinner, toast } from './shared/ui';
import { currentLang, LANG_DATASET_KEY } from '../i18n/core';
import { t } from '../i18n/intrastek';
import { FLAGS, flagValue } from '../settings';
import {
  api,
  cachedState,
  clearCache,
  EVENT_END_ATTR,
  EVENT_ID_ATTR,
  EVENT_START_ATTR,
  EVENT_TITLE_ATTR,
  fetchStatus,
  groupView,
  isFirstLoad,
  onCacheChange,
  parseEventId,
  targetGroupId,
} from './intrastek-client';
import {
  closeEventPopup,
  closeOurMenu,
  isEventPopupOpenFor,
  openBlockMenu,
  openEventPopup,
  type EventInfo,
} from './intrastek-ui';
import {
  INTRASTEK_API_KEY_KEY,
  INTRASTEK_API_URL_KEY,
  INTRASTEK_DEFAULT_GROUP_KEY,
  type IntrastekEventState,
  type IntrastekMe,
} from '../types';

const MODAL_BUTTON_CLASS = 'epitools-ik-btn';
const DOT_CLASS = 'epitools-ik-dot';
const MODE_BUTTON_ATTR = 'data-epitools-ik-mode';
const LEGEND_CLASS = 'epitools-ik-legend';
const LEGEND_BODY_CLASS = 'epitools-ik-legend-body';
const GROUP_SELECT_CLASS = 'epitools-ik-group-select';
const GROUP_SELECT_SIG_ATTR = 'data-epitools-ik-groups';
const BADGE_CLASS = 'epitools-ik-badge';
const SIG_ATTR = 'data-epitools-ik-sig';
const POS_ATTR = 'data-epitools-ik-pos';
const LEGEND_SIG_ATTR = 'data-epitools-ik-legend';
const BLOCK_CLASSES = ['epitools-ik-initialized', 'epitools-ik-proposed', 'epitools-ik-none', 'epitools-ik-linked'];
const BLOCK_SELECTOR = '.scheduler-event';
const MODE_KEY = FLAGS.intrastekMode.key;
// Fallback only (the button is found by shape first); EN + FR (FR unverified).
const PLANNING_MODE_LABEL = /planning mode|mode planning|mode planification/i;
// Tabler "users" icon.
const MODE_ICON_PATHS = [
  'M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
  'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2',
  'M16 3.13a4 4 0 0 1 0 7.75',
  'M21 21v-2a4 4 0 0 0 -3 -3.85',
];

let keyPresent = false;
let modeOn = false;
let configuredGroupId = '';
let me: IntrastekMe | null = null;
let meError = '';
let mePromise: Promise<IntrastekMe | null> | null = null;
let statusError = '';
// Visible ids whose first status fetch is running (legend spinner).
let statusLoading = false;
// Some block carries our classes/badge (skips the cleanup scan when not).
let decorated = false;
let unwatch: (() => void) | null = null;

// --- me (who the key belongs to) ---

function loadMe(): Promise<IntrastekMe | null> {
  if (!mePromise) {
    mePromise = api.me().then(
      (result) => {
        me = result;
        meError = '';
        return result;
      },
      (err: unknown) => {
        me = null;
        meError = errorText(err);
        // Retried on the next explicit action (modal button, mode toggle).
        mePromise = null;
        return null;
      },
    );
  }
  return mePromise;
}

function resetMe(): void {
  me = null;
  meError = '';
  mePromise = null;
}

function currentTarget(): string | null {
  return me ? targetGroupId(me, configuredGroupId) : null;
}

// --- Event modal button ---

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

function buildModalButton(): HTMLButtonElement {
  const btn = el('button', MODAL_BUTTON_CLASS);
  btn.type = 'button';
  btn.append(el('span', `${DOT_CLASS} ${DOT_CLASS}--unknown`), document.createTextNode('Intrastek'));
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void onModalButtonClick(btn);
  });
  return btn;
}

async function onModalButtonClick(btn: HTMLButtonElement): Promise<void> {
  // Re-read on click: React may reuse the modal DOM for another event.
  const dialog = btn.closest('section[role=dialog]');
  const event = dialog ? dialogEvent(dialog) : null;
  if (!dialog || !event || btn.disabled) return;
  // First click of the page waits for /extension/me: show it.
  const restore = me ? null : setBusy(btn);
  const who = await loadMe();
  restore?.();
  if (!who) {
    toast(meError || t('unreachable'), 'error');
    return;
  }
  openEventPopup(dialog, event, who, currentTarget());
}

function syncModalButtons(): void {
  for (const dialog of Array.from(document.querySelectorAll('section[role=dialog]'))) {
    const event = dialogEvent(dialog);
    let btn = dialog.querySelector<HTMLButtonElement>(`.${MODAL_BUTTON_CLASS}`);
    if (!event) {
      btn?.remove();
      continue;
    }
    // A popup left open for another event (modal reused) is stale.
    const staleBackdrop = dialog.querySelector('.epitools-ik-backdrop');
    if (staleBackdrop && !isEventPopupOpenFor(dialog, event.id)) closeEventPopup();

    if (!btn) {
      const closeButton = dialog.querySelector<HTMLElement>('.mantine-Modal-close');
      const header = closeButton?.parentElement;
      if (!closeButton || !header) continue;
      btn = buildModalButton();
      header.insertBefore(btn, closeButton);
    }
    const dotKind = dotState(cachedState(event.id));
    const wanted = `${DOT_CLASS} ${DOT_CLASS}--${dotKind}`;
    const dot = btn.querySelector(`.${DOT_CLASS}`);
    const title = dotTitle(dotKind);
    if (dot && dot.className !== wanted) dot.className = wanted;
    if (btn.title !== title) btn.title = title;
    fetchStatus([event.id]).then(
      (fetched) => {
        if (fetched) kick();
      },
      () => {
        /* backoff in the cache; the dot stays "unknown" */
      },
    );
  }
}

function removeModalButtons(): void {
  for (const node of Array.from(document.querySelectorAll(`.${MODAL_BUTTON_CLASS}`))) node.remove();
  closeEventPopup();
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
  if (!hasCalendar()) {
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

function blockDecoration(id: number): { cls: string; badge: string } {
  const state = cachedState(id);
  if (!state) return { cls: '', badge: '' };
  const view = groupView(state, currentTarget());
  const count = view.nbUserAsk !== null && view.nbUserAsk > 0 ? String(view.nbUserAsk) : '?';
  // Merged into the previous event: its count, set there.
  if (view.linkedTo !== null) {
    const badge = view.initialized ? `🔗 👥 ${count}` : view.proposal ? '🔗 ⏳' : '🔗';
    return { cls: 'epitools-ik-linked', badge };
  }
  if (view.proposal) {
    return { cls: 'epitools-ik-proposed', badge: view.initialized ? `⏳ 👥 ${count}` : '⏳' };
  }
  if (view.initialized) return { cls: 'epitools-ik-initialized', badge: `👥 ${count}` };
  return { cls: 'epitools-ik-none', badge: '' };
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
  for (const block of Array.from(document.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))) {
    const id = parseEventId(block.getAttribute(EVENT_ID_ATTR));
    if (!id) {
      if (block.hasAttribute(SIG_ATTR)) undecorate(block);
      continue;
    }
    ids.push(id);
    const { cls, badge } = blockDecoration(id);
    const sig = `${id}|${cls}|${badge}`;
    const badgeEl = block.querySelector<HTMLElement>(`:scope > .${BADGE_CLASS}`);
    // Never re-render what's already right (mutation loop otherwise); the
    // class/badge checks catch React resetting className or children.
    if (
      block.getAttribute(SIG_ATTR) === sig &&
      (!cls || block.classList.contains(cls)) &&
      (badge ? badgeEl?.textContent === badge : !badgeEl)
    ) {
      continue;
    }
    decorated = true;
    block.classList.remove(...BLOCK_CLASSES);
    if (cls) block.classList.add(cls);
    if (badge) {
      const node = badgeEl ?? document.createElement('span');
      node.className = BADGE_CLASS;
      node.textContent = badge;
      if (!badgeEl) {
        if (getComputedStyle(block).position === 'static') {
          block.style.position = 'relative';
          block.setAttribute(POS_ATTR, '1');
        }
        block.appendChild(node);
      }
    } else {
      badgeEl?.remove();
    }
    block.setAttribute(SIG_ATTR, sig);
  }

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
  return meError || statusError;
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
  const groups = me?.groups ?? [];
  const gid = currentTarget() ?? '';
  const sig = `${currentLang()}|${groups.map((g) => `${g.id}:${g.name}`).join('|')}`;
  if (select.getAttribute(GROUP_SELECT_SIG_ATTR) !== sig) {
    select.setAttribute(GROUP_SELECT_SIG_ATTR, sig);
    select.setAttribute('aria-label', t('groupSelectAria'));
    const options = groups.length ? groups.map((g) => ({ id: g.id, name: g.name })) : [{ id: '', name: me ? t('noGroup') : t('loadingOption') }];
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
  const loading = !error && (!me || statusLoading);
  const sig = `${currentLang()}|${loading}|${error}`;
  if (body.getAttribute(LEGEND_SIG_ATTR) === sig) return;
  body.setAttribute(LEGEND_SIG_ATTR, sig);
  const groupLabel = legend.querySelector('.epitools-ik-legend-group-label');
  if (groupLabel) groupLabel.textContent = t('legendGroup');
  body.replaceChildren(
    swatch('epitools-ik-swatch--initialized', t('legendInitialized')),
    swatch('epitools-ik-swatch--proposed', t('legendProposed')),
    swatch('epitools-ik-swatch--none', t('legendNone')),
    swatch('epitools-ik-swatch--linked', t('legendLinked')),
    document.createTextNode(t('legendHint')),
  );
  if (loading) body.appendChild(spinner(t('loadingStatus')));
  if (error) body.appendChild(el('span', 'epitools-ik-legend-error', error));
}

function removeLegend(): void {
  document.querySelector(`.${LEGEND_CLASS}`)?.remove();
}

// --- Right-click (mode on only) ---

function onContextMenu(ev: MouseEvent): void {
  if (!keyPresent || !modeOn || !(ev.target instanceof Element)) return;
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
      toast(meError || t('unreachable'), 'error');
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

// --- Main loop ---

// Only runs while a key is saved (subscribed in setKeyPresent).
function check(): void {
  syncModalButtons();
  const modeButton = syncModeButton();
  if (!modeOn || !hasCalendar()) {
    removeLegend();
    undecorateAll();
    return;
  }
  if (!me) {
    syncLegend(modeButton);
    // After a failure, no automatic retry on every mutation: toggling the
    // mode (or the modal button) retries.
    if (meError) return;
    void loadMe().then(() => {
      if (modeOn) kick();
    });
    return;
  }
  decorateBlocks();
  syncLegend(modeButton);
}

let kickTimer: ReturnType<typeof setTimeout> | undefined;

// Re-check for non-DOM reasons (status fetched, storage/mode change), which
// the shared observer can't see. Same throttle rule as watchDom: never a
// restart-on-every-call debounce, never rAF.
function kick(): void {
  if (kickTimer !== undefined || !unwatch) return;
  kickTimer = setTimeout(() => {
    kickTimer = undefined;
    if (unwatch) check();
  }, 200);
}

function cleanup(): void {
  removeModalButtons();
  document.querySelector(`button[${MODE_BUTTON_ATTR}]`)?.remove();
  removeLegend();
  undecorateAll();
  closeOurMenu();
}

function setKeyPresent(present: boolean): void {
  keyPresent = present;
  if (present) document.documentElement.dataset.epitoolsIntrastek = 'on';
  else delete document.documentElement.dataset.epitoolsIntrastek;
  if (present && !unwatch) {
    // EVENT_ID_ATTR: the MAIN half tags blocks/modal after React rendered
    // them; the language attribute re-renders our labels.
    unwatch = watchDom(check, {
      delay: 200,
      bodyAttributes: [EVENT_ID_ATTR],
      htmlAttributes: [datasetAttr(LANG_DATASET_KEY)],
    });
  } else if (!present && unwatch) {
    // No key = nothing to watch (most users): one cleanup, then no work per mutation.
    unwatch();
    unwatch = null;
    cleanup();
  }
}

function setMode(on: boolean): void {
  if (modeOn === on) return;
  modeOn = on;
  statusError = '';
  if (!on) closeOurMenu();
  // A failed me is retried when the mode is turned on again.
  if (on && !me && meError) resetMe();
  kick();
}

export async function init(): Promise<void> {
  const stored = await getLocal({
    [INTRASTEK_API_KEY_KEY]: '',
    [INTRASTEK_DEFAULT_GROUP_KEY]: '',
    [MODE_KEY]: FLAGS.intrastekMode.default,
  });
  // null: "Extension context invalidated" (tab not reloaded after an extension reload).
  if (!stored) return;
  configuredGroupId = String(stored[INTRASTEK_DEFAULT_GROUP_KEY] || '');
  modeOn = flagValue(FLAGS.intrastekMode, stored[MODE_KEY]);
  setKeyPresent(!!stored[INTRASTEK_API_KEY_KEY]);

  onLocalChange([INTRASTEK_API_KEY_KEY, INTRASTEK_API_URL_KEY, INTRASTEK_DEFAULT_GROUP_KEY, MODE_KEY], (v) => {
    if (INTRASTEK_API_KEY_KEY in v || INTRASTEK_API_URL_KEY in v) {
      resetMe();
      clearCache();
      closeEventPopup();
      closeOurMenu();
      undecorateAll();
      if (INTRASTEK_API_KEY_KEY in v) setKeyPresent(!!v[INTRASTEK_API_KEY_KEY]);
      kick();
    }
    if (INTRASTEK_DEFAULT_GROUP_KEY in v) {
      configuredGroupId = String(v[INTRASTEK_DEFAULT_GROUP_KEY] || '');
      kick();
    }
    if (MODE_KEY in v) setMode(flagValue(FLAGS.intrastekMode, v[MODE_KEY]));
  });

  onCacheChange(kick);
  window.addEventListener('contextmenu', onContextMenu, true);
}
