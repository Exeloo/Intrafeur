// Intrastek, MAIN-world half: only *tags* elements with the intranet event
// id (plus title/start/end for display) so the isolated half
// (intrastek.ts), which owns all the UI and the API key, can find them.
// React fibers are only visible from the page's MAIN world.
//
// Runs only while <html data-epitools-intrastek="on"> (set by intrastek.ts
// when an Intrastek key is saved). Must not use browser.* nor import the
// polyfill. Everything written here is readable (and forgeable) by the page,
// so the isolated half treats it as untrusted.
import { extractSchedulerEvent } from './fiber-extract';
import { dialogEvent, dialogs } from './shared/mantine';
import { datasetAttr, watchDom } from './shared/dom-watch';
import { FLAGS, mirroredFlagOn } from '../settings';

const ENABLED_ATTR = 'data-epitools-intrastek';

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
  return document.documentElement.getAttribute(ENABLED_ATTR) === 'on';
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

// Skips the clean-up query on every mutation while the feature is off.
let tagged = false;

function clearAll(): void {
  if (!tagged) return;
  tagged = false;
  for (const el of Array.from(document.querySelectorAll(`[${ID_ATTR}]`))) {
    for (const name of ATTRS) el.removeAttribute(name);
  }
}

function check(): void {
  if (!isEnabled()) {
    clearAll();
    return;
  }
  tagged = true;

  // Calendar blocks, for the old Intrastek mode (native calendar only: with the
  // new planning calendar on, the board has its own data). Re-read every time
  // (cheap, ~50-200 blocks): FullCalendar may reuse a block element for
  // another event after navigation.
  const blocks = mirroredFlagOn(FLAGS.planningBoard) ? [] : Array.from(document.querySelectorAll('.scheduler-event'));
  for (const block of blocks) {
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

  // Event-details modal, found via shared/mantine.ts dialogEvent (unit link in
  // a Mantine dialog, event record in its React props).
  for (const dialog of dialogs()) {
    const event = dialogEvent(dialog);
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

export function init(): void {
  watchDom(check, { htmlAttributes: [ENABLED_ATTR, datasetAttr(FLAGS.planningBoard.mirror)] });
}
