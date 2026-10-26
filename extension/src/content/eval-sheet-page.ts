// Evaluation sheet ("Fiche d'évaluation") buttons in the planning's
// event-details modal, MAIN-world half. Regular events get one button next
// to the modal's ×; events with appointment slots get one button per time
// slot instead. A click gathers the event, the registered students and their
// photo data URLs from React state / the site's React Query cache and posts them
// to the isolated-world half (eval-sheet.ts), which builds the PDF.
//
// Runs in the page's MAIN world (see event-info.ts for why): no browser.*
// APIs and no webextension-polyfill here. The per-browser on/off toggle is
// mirrored by eval-sheet.ts onto <html data-epitools-eval-sheet="on">.
import {
  extractPlanningEvent,
  findApiClient,
  findQueryClient,
  findSlotsList,
  type ApiClientLike,
  type PlanningEvent,
  type QueryClientLike,
  type EventSlot,
  type SlotStudent,
} from './fiber-extract';
import { EVAL_SHEET_REQUEST, EVAL_SHEET_ACK, type EvalSheet, type EvalSheetStudent } from '../types';

const BUTTON_CLASS = 'epitools-eval-sheet-btn';
const SLOT_BUTTON_CLASS = 'epitools-eval-sheet-btn--slot';
const BUTTON_LABEL = "Fiche d'évaluation";
// Header button of a slot-based event: one sheet for every slot.
const WHOLE_EVENT_LABEL = 'Fiche (tous les créneaux)';
const FEEDBACK_MS = 2000;
// Only the hand-off is timed: once the isolated script acks, the options
// modal is open and the user may take as long as they like.
const ACK_TIMEOUT_MS = 5000;

interface SlotGroup {
  key: string;
  start: string;
  end: string;
  students: SlotStudent[];
}

function isEnabled(): boolean {
  return document.documentElement.dataset.epitoolsEvalSheet === 'on';
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function findUnitLink(dialog: Element): HTMLAnchorElement | null {
  return dialog.querySelector<HTMLAnchorElement>('a[href^="/units/"]');
}

function eventOf(dialog: Element): PlanningEvent | null {
  const unitLink = findUnitLink(dialog);
  return unitLink ? extractPlanningEvent(unitLink) : null;
}

// --- Data gathering -------------------------------------------------------

function slotStudents(slot: EventSlot): SlotStudent[] {
  const reg = slot.registration;
  if (!reg) return [];
  if (reg.registeredStudents && reg.registeredStudents.length) return reg.registeredStudents;
  return reg.student ? [reg.student] : [];
}

// Parallel slots (same start/end, "2/2 in parallel") render as one card.
function groupSlots(slots: EventSlot[]): SlotGroup[] {
  const groups = new Map<string, SlotGroup>();
  for (const slot of slots) {
    const key = `${slot.startDate}|${slot.endDate}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, start: slot.startDate, end: slot.endDate, students: [] };
      groups.set(key, group);
    }
    for (const student of slotStudents(slot)) {
      if (!group.students.some((s) => s.login === student.login)) group.students.push(student);
    }
  }
  return Array.from(groups.values());
}

function registrationStudents(qc: QueryClientLike, eventId: PlanningEvent['id']): SlotStudent[] | null {
  const query = qc.getQueryCache().find({ queryKey: ['events', 'detail', eventId, 'registrations'], exact: true });
  const data = query?.state.data;
  if (!Array.isArray(data)) return null;
  return data
    .map((r) => (r && typeof r === 'object' ? (r as { student?: SlotStudent }).student : undefined))
    .filter((s): s is SlotStudent => !!s && typeof s.login === 'string');
}

const PHOTO_CONCURRENCY = 6;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function asImageDataUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
}

// Photos come from GET /api/users/<login>/avatar (bearer-authed, so only
// reachable through the site's own API client). Prefer the full 240px photo;
// fall back to the 96px thumbnail, either from an ['avatar', login] query
// the site already loaded or fetched through the client. null -> initials.
async function photoUrl(api: ApiClientLike | null, qc: QueryClientLike, login: string): Promise<string | null> {
  if (api) {
    try {
      const blob = await api.unlabeled.getAvatar(login);
      if (blob instanceof Blob && blob.type.startsWith('image/')) return await blobToDataUrl(blob);
    } catch {
      // fall through to the thumbnail
    }
  }
  const cached = qc.getQueryCache().find({ queryKey: ['avatar', login], exact: true });
  const fromCache = asImageDataUrl(cached?.state.data);
  if (fromCache) return fromCache;
  try {
    if (api) return asImageDataUrl(await api.unlabeled.getAvatarThumbnail(login));
    return cached ? asImageDataUrl(await cached.fetch()) : null;
  } catch {
    return null;
  }
}

// Events can have 100+ students: bounded concurrency, not one burst.
async function photoUrls(api: ApiClientLike | null, qc: QueryClientLike, logins: string[]): Promise<(string | null)[]> {
  const results: (string | null)[] = new Array(logins.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < logins.length) {
      const i = next++;
      results[i] = await photoUrl(api, qc, logins[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, logins.length) }, worker));
  return results;
}

async function toSheetStudents(
  api: ApiClientLike | null,
  qc: QueryClientLike,
  students: SlotStudent[],
): Promise<EvalSheetStudent[]> {
  const photos = await photoUrls(api, qc, students.map((s) => s.login));
  return students.map((s, i) => ({
    firstname: s.firstname || '',
    lastname: s.lastname || '',
    email: s.login,
    photoUrl: photos[i],
  }));
}

// --- Bridge to the isolated world -----------------------------------------

const pending = new Map<string, (ok: boolean) => void>();

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data as { source?: unknown; requestId?: unknown; ok?: unknown } | null;
  if (!data || data.source !== EVAL_SHEET_ACK || typeof data.requestId !== 'string') return;
  const resolve = pending.get(data.requestId);
  if (resolve) {
    pending.delete(data.requestId);
    resolve(true);
  }
});

// Resolves true once the isolated script has opened the options modal.
// The request id is also set on the button so that script can mount the
// modal inside the same intranet dialog.
function requestPdf(button: HTMLButtonElement, sheet: EvalSheet): Promise<boolean> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  button.dataset.epitoolsRequestId = requestId;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    window.setTimeout(() => {
      if (pending.delete(requestId)) resolve(false);
    }, ACK_TIMEOUT_MS);
    window.postMessage({ source: EVAL_SHEET_REQUEST, requestId, sheet }, location.origin);
  });
}

// --- Buttons --------------------------------------------------------------

function setLabel(button: HTMLButtonElement, label: string, resetAfterMs?: number): void {
  button.textContent = label;
  window.clearTimeout(Number(button.dataset.epitoolsTimer));
  if (resetAfterMs) {
    button.dataset.epitoolsTimer = String(
      window.setTimeout(() => {
        button.textContent = button.dataset.label || BUTTON_LABEL;
      }, resetAfterMs),
    );
  }
}

// Re-reads everything on click rather than at injection time: React may
// reuse the same modal DOM when the user opens another event.
async function collectSheet(button: HTMLButtonElement): Promise<EvalSheet | null> {
  const dialog = button.closest('[role=dialog]');
  const event = dialog ? eventOf(dialog) : null;
  const qc = dialog ? findQueryClient(dialog) : null;
  if (!dialog || !event || !qc) return null;

  let start = event.startDate;
  let end = event.endDate;
  let students: SlotStudent[] | null;
  // login -> slot, for whole-event sheets of slot-based events.
  const slotOf = new Map<string, { start: string; end: string }>();
  const slotKey = button.dataset.slotKey;
  if (slotKey) {
    const list = findSlotsList(dialog);
    const group = list ? groupSlots(list.slots).find((g) => g.key === slotKey) : undefined;
    if (!group) return null;
    start = group.start;
    end = group.end;
    students = group.students;
  } else if (event.activitySlotsEnabled) {
    const list = findSlotsList(dialog);
    if (!list) return null;
    students = [];
    for (const group of groupSlots(list.slots)) {
      for (const student of group.students) {
        if (slotOf.has(student.login)) continue;
        slotOf.set(student.login, { start: group.start, end: group.end });
        students.push(student);
      }
    }
  } else {
    students = registrationStudents(qc, event.id);
  }
  if (!students || !start || !end) return null;

  const sheetStudents = await toSheetStudents(findApiClient(dialog), qc, students);
  for (const s of sheetStudents) {
    const slot = slotOf.get(s.email);
    if (slot) {
      s.slotStart = slot.start;
      s.slotEnd = slot.end;
    }
  }

  return {
    activity: event.fullTitle || event.activityName || '',
    unitCode: event.unitCode,
    unitName: event.unitName || '',
    location: (event.rooms || [])
      .map((room) => room?.name?.trim())
      .filter(Boolean)
      .join(', '),
    start,
    end,
    students: sheetStudents,
  };
}

async function onClick(button: HTMLButtonElement): Promise<void> {
  if (button.dataset.busy === '1') return;
  button.dataset.busy = '1';
  setLabel(button, 'Chargement…');
  let ok = false;
  try {
    const sheet = await collectSheet(button);
    ok = !!sheet && (await requestPdf(button, sheet));
  } catch {
    ok = false;
  }
  delete button.dataset.busy;
  if (ok) setLabel(button, button.dataset.label || BUTTON_LABEL);
  else setLabel(button, 'Échec', FEEDBACK_MS);
}

function buildButton(eventId: PlanningEvent['id'], slotKey?: string, label = BUTTON_LABEL): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = slotKey ? `${BUTTON_CLASS} ${SLOT_BUTTON_CLASS}` : BUTTON_CLASS;
  button.textContent = label;
  button.dataset.label = label;
  button.title = 'Télécharger la fiche d’évaluation (PDF)';
  button.dataset.eventId = String(eventId);
  if (slotKey) button.dataset.slotKey = slotKey;
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onClick(button);
  });
  return button;
}

// "10:00 AM - 10:20 AM" (English UI) or "10:00 - 10:20" style headers: we
// accept the 24h and the 12h form of the time.
function timeForms(iso: string): string[] {
  const d = new Date(iso);
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  const h12 = h % 12 || 12;
  return Array.from(new Set([`${h}:${mm}`, `${String(h).padStart(2, '0')}:${mm}`, `${h12}:${mm}`, `${h}h${mm}`]));
}

function containsTime(text: string, iso: string): boolean {
  return timeForms(iso).some((t) => new RegExp(`(^|[^0-9])${t}([^0-9]|$)`).test(text));
}

const TIME_RANGE = /\d{1,2}[:h]\d{2}.*\d{1,2}[:h]\d{2}/;

function isTimeHeader(group: Element): boolean {
  if (!TIME_RANGE.test(group.textContent || '')) return false;
  // Innermost only: an outer Group wrapping it would match too.
  return !Array.from(group.querySelectorAll('.mantine-Group-root')).some((g) => TIME_RANGE.test(g.textContent || ''));
}

// Each time slot renders a header row (a Mantine Group holding the time
// range and the "x/y in parallel" badge) followed by the student chips.
// Headers are found by shape, not label text, since the UI is localized.
// The card is the largest ancestor of the header that contains no other
// header (the header's direct parent only wraps the header row itself,
// verified live).
function findSlotCards(hosts: Element[]): { card: Element; header: Element }[] {
  const out: { card: Element; header: Element }[] = [];
  for (const host of hosts) {
    const headers = Array.from(host.querySelectorAll('.mantine-Group-root')).filter(isTimeHeader);
    for (const header of headers) {
      let card: Element = header;
      for (let parent = card.parentElement; parent && parent !== host; parent = parent.parentElement) {
        if (headers.filter((h) => parent!.contains(h)).length !== 1) break;
        card = parent;
      }
      out.push({ card, header });
    }
  }
  return out;
}

// Matches a card to its slot group by content, never by position (slot
// order can be descending, and a mismatch would put the wrong students on a
// grading sheet): the header must show the group's start and end times, the
// card must name every student of the group, and no student of another
// group. Returns null unless exactly one group fits.
function matchGroup(card: Element, header: Element, groups: SlotGroup[]): SlotGroup | null {
  const headerText = header.textContent || '';
  const cardText = normalize(card.textContent || '');
  const names = (s: SlotStudent): string => normalize(`${s.firstname || ''} ${s.lastname || ''}`);
  const matches = groups.filter((g) => {
    if (!g.students.length) return false;
    if (!containsTime(headerText, g.start) || !containsTime(headerText, g.end)) return false;
    if (!g.students.every((s) => cardText.includes(names(s)))) return false;
    const own = new Set(g.students.map((s) => s.login));
    return groups.every((other) =>
      other.students.every((s) => own.has(s.login) || !cardText.includes(names(s))),
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function injectSlotButtons(dialog: Element, event: PlanningEvent): void {
  const list = findSlotsList(dialog);
  if (!list) return;
  const groups = groupSlots(list.slots);
  for (const { card, header } of findSlotCards(list.hosts)) {
    const group = matchGroup(card, header, groups);
    const existing = header.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`);
    if (existing && existing.dataset.slotKey === group?.key && existing.dataset.eventId === String(event.id)) continue;
    existing?.remove();
    if (group) header.appendChild(buildButton(event.id, group.key));
  }
}

function injectHeaderButton(dialog: Element, event: PlanningEvent): void {
  const closeButton = dialog.querySelector<HTMLElement>('.mantine-Modal-close');
  const header = closeButton?.parentElement;
  if (!closeButton || !header) return;
  const label = event.activitySlotsEnabled ? WHOLE_EVENT_LABEL : BUTTON_LABEL;
  const existing = header.querySelector<HTMLButtonElement>(`:scope > .${BUTTON_CLASS}`);
  if (existing && existing.dataset.eventId === String(event.id) && existing.dataset.label === label) return;
  existing?.remove();
  header.insertBefore(buildButton(event.id, undefined, label), closeButton);
}

function removeButtons(root: ParentNode, selector = `.${BUTTON_CLASS}`): void {
  for (const el of Array.from(root.querySelectorAll(selector))) {
    if (!(el as HTMLElement).dataset.busy) el.remove();
  }
}

function check(): void {
  if (!isEnabled()) {
    removeButtons(document);
    return;
  }
  for (const dialog of Array.from(document.querySelectorAll('section[role=dialog]'))) {
    const event = eventOf(dialog);
    if (!event) continue;
    if (event.activitySlotsEnabled) {
      // Whole event (every slot, times in a left column) + one per slot.
      injectHeaderButton(dialog, event);
      injectSlotButtons(dialog, event);
    } else {
      removeButtons(dialog, `.${SLOT_BUTTON_CLASS}`);
      injectHeaderButton(dialog, event);
    }
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
// The popup toggle flips this attribute (via eval-sheet.ts) without any
// body mutation; watch it so enabling/disabling applies live.
new MutationObserver(scheduleCheck).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-epitools-eval-sheet'],
});
check();
