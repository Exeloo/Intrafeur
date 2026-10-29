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
  toast,
  type EventInfo,
} from './intrastek-ui';
import {
  INTRASTEK_API_KEY_KEY,
  INTRASTEK_API_URL_KEY,
  INTRASTEK_DEFAULT_GROUP_KEY,
  INTRASTEK_MODE_KEY,
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
        meError = (err as Error)?.message || String(err);
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

const DOT_TITLES: Record<string, string> = {
  unknown: 'Intrastek state unknown',
  proposed: 'Pending proposal',
  initialized: 'Initialized in Intrastek',
  none: 'Not in Intrastek',
};

function buildModalButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = MODAL_BUTTON_CLASS;
  const dot = document.createElement('span');
  dot.className = `${DOT_CLASS} ${DOT_CLASS}--unknown`;
  btn.append(dot, document.createTextNode('Intrastek'));
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
  if (!dialog || !event) return;
  const who = await loadMe();
  if (!who) {
    toast(meError || 'Intrastek is unreachable', 'error');
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
    const state = cachedState(event.id);
    const wanted = `${DOT_CLASS} ${DOT_CLASS}--${dotState(state)}`;
    const dot = btn.querySelector(`.${DOT_CLASS}`);
    if (dot && dot.className !== wanted) {
      dot.className = wanted;
      btn.title = DOT_TITLES[dotState(state)];
    }
    fetchStatus([event.id]).then(
      (fetched) => {
        if (fetched) scheduleCheck();
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
  if (leftSection) {
    const siteSvg = leftSection.querySelector('svg');
    const icon = buildIconSvg(MODE_ICON_PATHS);
    const size = siteSvg?.getAttribute('width');
    if (size) {
      icon.setAttribute('width', size);
      icon.setAttribute('height', siteSvg?.getAttribute('height') || size);
    }
    leftSection.replaceChildren(icon);
  }
  if (label === btn) {
    // No label span: keep the icon section, replace the rest.
    for (const child of Array.from(btn.childNodes)) if (child !== leftSection) child.remove();
    btn.appendChild(document.createTextNode('Intrastek mode'));
  } else {
    label.textContent = 'Intrastek mode';
  }

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void browser.storage.local.set({ [INTRASTEK_MODE_KEY]: !modeOn }).catch(() => undefined);
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
    ours.title = modeOn ? 'Intrastek mode is on (click to turn off)' : 'Show Intrastek staffing on the calendar';
  }
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

  if (!ids.length) return;
  fetchStatus(ids).then(
    (fetched) => {
      if (!fetched) return;
      statusError = '';
      if (modeOn) scheduleCheck();
    },
    (err: unknown) => {
      const message = (err as Error)?.message || String(err);
      if (message !== statusError) {
        statusError = message;
        if (modeOn) scheduleCheck();
      }
    },
  );
}

function undecorateAll(): void {
  for (const block of Array.from(document.querySelectorAll<HTMLElement>(`[${SIG_ATTR}]`))) undecorate(block);
  for (const badge of Array.from(document.querySelectorAll(`.${BADGE_CLASS}`))) badge.remove();
}

// --- Legend ---

function legendError(): string {
  return meError || statusError;
}

function swatch(cls: string, text: string): HTMLElement {
  const item = document.createElement('span');
  item.className = 'epitools-ik-legend-item';
  const box = document.createElement('span');
  box.className = `epitools-ik-swatch ${cls}`;
  item.append(box, document.createTextNode(text));
  return item;
}

// The view's group select, first in the legend: which group the block colours
// (and the right-click / popup actions) are about. It writes the same
// storage.local key as the options page's default group, so both stay in
// sync; storage.onChanged then re-renders the blocks.
function buildGroupSelect(): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = GROUP_SELECT_CLASS;
  select.setAttribute('aria-label', 'Intrastek group shown on the calendar');
  select.addEventListener('change', () => {
    configuredGroupId = select.value;
    scheduleCheck();
    void browser.storage.local.set({ [INTRASTEK_DEFAULT_GROUP_KEY]: select.value }).catch(() => undefined);
  });
  return select;
}

function syncGroupSelect(select: HTMLSelectElement): void {
  const groups = me?.groups ?? [];
  const gid = currentTarget() ?? '';
  const sig = groups.map((g) => `${g.id}:${g.name}`).join('|');
  if (select.getAttribute(GROUP_SELECT_SIG_ATTR) !== sig) {
    select.setAttribute(GROUP_SELECT_SIG_ATTR, sig);
    select.replaceChildren(
      ...(groups.length
        ? groups.map((g) => {
            const option = document.createElement('option');
            option.value = g.id;
            option.textContent = g.name;
            return option;
          })
        : [Object.assign(document.createElement('option'), { value: '', textContent: me ? 'no group' : 'loading…' })]),
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
    // Under the toolbar row that holds the header Group, else above the
    // calendar.
    const row = modeButton?.parentElement?.parentElement;
    const calendar = document.querySelector(CALENDAR_SELECTOR);
    if (!row && !calendar) return;
    legend = document.createElement('div');
    legend.className = LEGEND_CLASS;
    const label = document.createElement('label');
    label.className = 'epitools-ik-legend-group';
    label.append(document.createTextNode('Intrastek group: '), buildGroupSelect());
    const body = document.createElement('span');
    body.className = LEGEND_BODY_CLASS;
    legend.append(label, body);
    if (row) row.insertAdjacentElement('afterend', legend);
    else calendar?.insertAdjacentElement('beforebegin', legend);
  }
  const select = legend.querySelector<HTMLSelectElement>(`.${GROUP_SELECT_CLASS}`);
  if (select) syncGroupSelect(select);
  const body = legend.querySelector<HTMLElement>(`.${LEGEND_BODY_CLASS}`);
  if (!body) return;
  const error = legendError();
  if (body.getAttribute(LEGEND_SIG_ATTR) === error) return;
  body.setAttribute(LEGEND_SIG_ATTR, error);
  body.replaceChildren(
    swatch('epitools-ik-swatch--initialized', 'initialized (👥 AERs needed)'),
    swatch('epitools-ik-swatch--proposed', '⏳ proposal pending'),
    swatch('epitools-ik-swatch--none', 'not initialized'),
    swatch('epitools-ik-swatch--linked', '🔗 follows the previous event (set it there)'),
    document.createTextNode('Right-click a block for actions.'),
  );
  if (error) {
    const err = document.createElement('span');
    err.className = 'epitools-ik-legend-error';
    err.textContent = error;
    body.appendChild(err);
  }
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
    toast('This event has no intranet id yet, try again in a moment.', 'info');
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
      toast(meError || 'Intrastek is unreachable', 'error');
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

function check(): void {
  if (!keyPresent) {
    removeModalButtons();
    document.querySelector(`button[${MODE_BUTTON_ATTR}]`)?.remove();
    removeLegend();
    undecorateAll();
    closeOurMenu();
    return;
  }
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
    void loadMe().then((who) => {
      if (modeOn) {
        if (!who) syncLegend(document.querySelector(`button[${MODE_BUTTON_ATTR}]`));
        else scheduleCheck();
      }
    });
    return;
  }
  decorateBlocks();
  syncLegend(modeButton);
}

let debounceTimer: number | undefined;

// Throttled, not debounced: run 200 ms after the first mutation and ignore
// the next ones until then. The site rewrites its <style> tags every ~100 ms
// on some views (e.g. planning with several semesters selected), so a
// debounce that restarts on every mutation would starve check() forever.
function scheduleCheck(): void {
  if (debounceTimer !== undefined) return;
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    check();
  }, 200);
}

function setKeyPresent(present: boolean): void {
  keyPresent = present;
  if (present) document.documentElement.dataset.epitoolsIntrastek = 'on';
  else delete document.documentElement.dataset.epitoolsIntrastek;
  scheduleCheck();
}

function setMode(on: boolean): void {
  if (modeOn === on) return;
  modeOn = on;
  statusError = '';
  if (!on) closeOurMenu();
  // A failed me is retried when the mode is turned on again.
  if (on && !me && meError) resetMe();
  scheduleCheck();
}

async function init(): Promise<void> {
  let stored: Record<string, unknown>;
  try {
    stored = await browser.storage.local.get({
      [INTRASTEK_API_KEY_KEY]: '',
      [INTRASTEK_DEFAULT_GROUP_KEY]: '',
      [INTRASTEK_MODE_KEY]: false,
    });
  } catch {
    // "Extension context invalidated" in a tab not reloaded after an
    // extension reload — see attendance.ts's initFeatureToggle.
    return;
  }
  configuredGroupId = String(stored[INTRASTEK_DEFAULT_GROUP_KEY] || '');
  modeOn = stored[INTRASTEK_MODE_KEY] === true;
  setKeyPresent(!!stored[INTRASTEK_API_KEY_KEY]);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (INTRASTEK_API_KEY_KEY in changes || INTRASTEK_API_URL_KEY in changes) {
      resetMe();
      clearCache();
      closeEventPopup();
      closeOurMenu();
      undecorateAll();
      if (INTRASTEK_API_KEY_KEY in changes) setKeyPresent(!!changes[INTRASTEK_API_KEY_KEY].newValue);
      else scheduleCheck();
    }
    if (INTRASTEK_DEFAULT_GROUP_KEY in changes) {
      configuredGroupId = String(changes[INTRASTEK_DEFAULT_GROUP_KEY].newValue || '');
      scheduleCheck();
    }
    if (INTRASTEK_MODE_KEY in changes) setMode(changes[INTRASTEK_MODE_KEY].newValue === true);
  });

  onCacheChange(scheduleCheck);
  window.addEventListener('contextmenu', onContextMenu, true);
  new MutationObserver(scheduleCheck).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [EVENT_ID_ATTR],
  });
}

void init();
