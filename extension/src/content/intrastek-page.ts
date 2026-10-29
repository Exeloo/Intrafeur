// Intrastek, MAIN-world half: only *tags* elements with the intranet event
// id (plus title/start/end for display) so the isolated half
// (intrastek.ts), which owns all the UI and the API key, can find them.
// React fibers are only visible from the page's MAIN world.
//
// Runs only while <html data-epitools-intrastek="on"> (set by intrastek.ts
// when an Intrastek key is saved). Must not use browser.* nor import the
// polyfill. Everything written here is readable (and forgeable) by the page,
// so the isolated half treats it as untrusted.
import { extractPlanningEvent, extractSchedulerEvent } from './fiber-extract';

const ID_ATTR = 'data-epitools-event-id';
const TITLE_ATTR = 'data-epitools-event-title';
const START_ATTR = 'data-epitools-event-start';
const END_ATTR = 'data-epitools-event-end';
const ACTIVITY_ATTR = 'data-epitools-event-activity';
const ATTRS = [ID_ATTR, TITLE_ATTR, START_ATTR, END_ATTR, ACTIVITY_ATTR];

interface Tag {
  id: string;
  title: string | null;
  start: string | null;
  end: string | null;
  activity: string | null;
}

function isEnabled(): boolean {
  return document.documentElement.dataset.epitoolsIntrastek === 'on';
}

// Only writes what changed: setting an attribute to its current value would
// still fire attribute mutations in the isolated half.
function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

function applyTag(el: Element, tag: Tag | null): void {
  if (!tag || !/^\d+$/.test(tag.id)) {
    for (const name of ATTRS) setAttr(el, name, null);
    return;
  }
  setAttr(el, ID_ATTR, tag.id);
  setAttr(el, TITLE_ATTR, tag.title ? tag.title.slice(0, 300) : null);
  setAttr(el, START_ATTR, tag.start);
  setAttr(el, END_ATTR, tag.end);
  setAttr(el, ACTIVITY_ATTR, tag.activity && /^\d+$/.test(tag.activity) ? tag.activity : null);
}

function clearAll(): void {
  for (const el of Array.from(document.querySelectorAll(`[${ID_ATTR}]`))) {
    for (const name of ATTRS) el.removeAttribute(name);
  }
}

function check(): void {
  if (!isEnabled()) {
    clearAll();
    return;
  }

  // Calendar blocks. Re-read every time (cheap, ~50-200 blocks): FullCalendar
  // may reuse a block element for another event after navigation.
  for (const block of Array.from(document.querySelectorAll('.scheduler-event'))) {
    const event = extractSchedulerEvent(block);
    applyTag(
      block,
      event && {
        id: event.id,
        title: event.fullTitle,
        start: event.startDate,
        end: event.endDate,
        activity: event.activityInstanceId,
      },
    );
  }

  // Event-details modal, found the way event-info.ts finds it (unit link in
  // a Mantine dialog, event record in its React props).
  for (const dialog of Array.from(document.querySelectorAll('section[role=dialog]'))) {
    const unitLink = dialog.querySelector('a[href^="/units/"]');
    const event = unitLink ? extractPlanningEvent(unitLink) : null;
    applyTag(
      dialog,
      event && {
        id: String(event.id),
        title: event.fullTitle || event.activityName || null,
        start: event.startDate || null,
        end: event.endDate || null,
        activity: event.activityInstanceId != null ? String(event.activityInstanceId) : null,
      },
    );
  }
}

let debounceTimer: number | undefined;

// Throttled, not debounced: run 150 ms after the first mutation and ignore
// the next ones until then. The site rewrites its <style> tags every ~100 ms
// on some views (e.g. planning with several semesters selected), so a
// debounce that restarts on every mutation would starve check() forever.
function scheduleCheck(): void {
  if (debounceTimer !== undefined) return;
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    check();
  }, 150);
}

new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });
new MutationObserver(scheduleCheck).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-epitools-intrastek'],
});
check();
