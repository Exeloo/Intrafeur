// Planning board, MAIN-world half: reads what the site's FullCalendar shows
// (its `events` prop and view, see findPlanningCalendar) and posts it to the
// isolated board (planning-board/board.ts), which renders everything. Also
// marks the FullCalendar root so CSS can hide it while the board is active,
// and opens an event's modal on request. No browser.*, no polyfill.
//
// The native calendar stays mounted (only hidden): it's the data source, and
// the site's own toolbar (prev/today/next, month/week/day) keeps driving it.
//
// Planning mode (the site's, verified live 2026-11): FullCalendar gets
// editable/selectable/droppable and the `events` prop becomes the site's
// draft view. Its handlers don't write: eventDrop -> changeEvent, select ->
// creation modal, eventReceive -> recordCreation all stage draft operations
// that the site's review bar publishes or discards. The board's drags call
// those same handlers (move / create / receive commands), each re-checked here.
//
// Room assignment (verified live 2026-11, Scheduler bundle): the sidebar's
// "Rooms assignement" panel component has props {rooms, selectedRoom,
// onRoomSelect(room|null), addMode, onAddModeChange(bool), …}; while a room is
// picked, FullCalendar's eventClick toggles it on the event (add mode) or
// replaces the event's rooms with it, via the planning's changeEvent (a
// draft); events get the classes `event-not-in-selected-room` /
// `event-without-room`. The panel's selection is reset when its accordion
// item closes. The rooms list is also the React Query ['rooms','byUser',…].

import {
  fiberOf,
  findPlanningCalendar,
  findQueryClient,
  findSidebarDraggable,
  type FcEventInput,
  type FcProps,
} from './fiber-extract';
import { datasetAttr, watchDom } from './shared/dom-watch';
import { FLAGS, mirroredFlagOn } from '../settings';
import {
  COMMAND_SOURCE,
  DRAG_SOURCE,
  FEED_SOURCE,
  NATIVE_ATTR,
  ROOMS_DONE_SOURCE,
  type BoardEvent,
  type BoardRoom,
  type BoardView,
  type DragMessage,
  type FeedMessage,
  type RoomChange,
  type RoomsDoneMessage,
} from './planning-board/protocol';

let lastPayload = '';
let current: { props: FcProps; events: FcEventInput[] } | null = null;
// The sidebar activity being dragged (one drop, short-lived).
let pendingDrop: { data: Record<string, unknown>; duration: number; at: number } | null = null;
const DROP_TTL_MS = 120_000;
const DAY_MS = 24 * 3600_000;

function names(list: unknown, pick: (x: Record<string, unknown>) => unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (x && typeof x === 'object' ? pick(x as Record<string, unknown>) : null))
    .filter((x): x is string => typeof x === 'string' && !!x);
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v : '';
}

function toBoardEvent(input: FcEventInput): BoardEvent | null {
  const ext = (input.extendedProps ?? {}) as Record<string, unknown>;
  const id = Number(ext.id ?? input.id);
  // Planning-mode drafts not published yet have temporary negative ids.
  if (!Number.isSafeInteger(id) || id === 0) return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const count = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    id,
    title: str(ext.fullTitle) || str(ext.activityName) || str(ext.title) || str(input.title),
    start: toIso(ext.startDate ?? input.start),
    end: toIso(ext.endDate ?? input.end),
    color: typeof input.color === 'string' ? input.color : null,
    unitCode: str(ext.unitCode),
    unitName: str(ext.unitName),
    rooms: names(ext.rooms, (r) => r.name),
    instructors: names(ext.instructors, (p) => [p.firstname, p.lastname].filter(Boolean).join(' ') || p.login),
    registrations: count(ext.registrationsCount),
    capacity: count(ext.capacity) ?? count(ext.maxRegistrations),
    activity: ext.activityInstanceId != null ? String(ext.activityInstanceId) : null,
    isExam: ext.isExam === true,
    // The site's draft classes (verified: event-draft-created / -modified).
    draft: /\bevent-draft-([a-z-]+)/.exec(className(input))?.[1] ?? null,
    roomIds: roomIdsOf(ext),
    noRoom: /\bevent-without-room\b/.test(className(input)),
    outOfRoom: /\bevent-not-in-selected-room\b/.test(className(input)),
  };
}

function className(input: FcEventInput): string {
  return typeof input.className === 'string' ? input.className : '';
}

// From the room objects (what the site displays), aligned with `rooms` names.
function roomIdsOf(ext: Record<string, unknown>): number[] {
  if (!Array.isArray(ext.rooms)) return [];
  return ext.rooms
    .map((r) => (r && typeof r === 'object' ? (r as { id?: unknown }).id : null))
    .filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0);
}

// --- Room assignment panel ---

interface RoomPanel {
  rooms: Record<string, unknown>[];
  selectedRoom: { id?: unknown; name?: unknown } | null;
  onRoomSelect: (room: unknown) => void;
  addMode: boolean;
  onAddModeChange: (on: boolean) => void;
}

// From its switches ("add to existing rooms"…), a few fibers below the panel.
function findRoomPanel(): RoomPanel | null {
  for (const input of Array.from(document.querySelectorAll('.scheduler-planning-sidebar input[type=checkbox]'))) {
    let fiber = fiberOf(input);
    for (let depth = 0; fiber && depth <= 25; depth++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (p && typeof p.onRoomSelect === 'function' && typeof p.onAddModeChange === 'function' && Array.isArray(p.rooms)) {
        return p as unknown as RoomPanel;
      }
    }
  }
  return null;
}

function roomList(panel: RoomPanel | null, calendar: Element): Record<string, unknown>[] {
  if (panel) return panel.rooms;
  const data = findQueryClient(calendar)?.getQueryCache().find({ queryKey: ['rooms', 'byUser'] })?.state.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function toBoardRooms(list: Record<string, unknown>[]): BoardRoom[] {
  const out: BoardRoom[] = [];
  for (const r of list) {
    if (typeof r.id === 'number' && typeof r.name === 'string') {
      out.push({ id: r.id, name: r.name, capacity: typeof r.capacity === 'number' ? r.capacity : null });
    }
  }
  return out;
}

function roomPickOf(panel: RoomPanel | null): BoardView['roomPick'] {
  const room = panel?.selectedRoom;
  if (!panel || !room || typeof room.id !== 'number') return null;
  return { id: room.id, name: typeof room.name === 'string' ? room.name : '', add: panel.addMode === true };
}

// [site toolbar, FullCalendar root, (our board)]: the child whose fibers lead
// to the FullCalendar component, never a guess by position.
function fcRootOf(calendar: Element): { root: Element; found: NonNullable<ReturnType<typeof findPlanningCalendar>> } | null {
  for (const child of Array.from(calendar.children)) {
    if (child.classList.contains('epitools-pb')) continue;
    const found = findPlanningCalendar(child);
    if (found) return { root: child, found };
  }
  return null;
}

function check(): void {
  const calendar = document.querySelector('.scheduler-calendar');
  const hit = mirroredFlagOn(FLAGS.planningBoard) && calendar ? fcRootOf(calendar) : null;
  for (const node of Array.from(document.querySelectorAll(`[${NATIVE_ATTR}]`))) {
    if (node !== hit?.root) node.removeAttribute(NATIVE_ATTR);
  }
  if (!hit) return;
  const { root, found } = hit;
  current = { props: found.props, events: found.events };
  if (!root.hasAttribute(NATIVE_ATTR)) root.setAttribute(NATIVE_ATTR, '');
  const { api } = found;
  let view: BoardView | null = null;
  const panel = planningModeOn() ? findRoomPanel() : null;
  if (api) {
    view = {
      type: api.view.type,
      start: api.view.activeStart.toISOString(),
      end: api.view.activeEnd.toISOString(),
      slotMin: String(api.getOption('slotMinTime') ?? '08:00:00'),
      slotMax: String(api.getOption('slotMaxTime') ?? '20:00:00'),
      editable: found.props.editable === true,
      rooms: planningModeOn() && calendar ? toBoardRooms(roomList(panel, calendar)) : [],
      roomPick: roomPickOf(panel),
    };
  }
  let events = found.events.map(toBoardEvent).filter((e): e is BoardEvent => !!e);
  const message: FeedMessage = { source: FEED_SOURCE, view, events };
  // Only on change: our own board's DOM writes wake this check too.
  const payload = JSON.stringify(message);
  if (payload === lastPayload) return;
  lastPayload = payload;
  window.postMessage(message, location.origin);
}

// Client-side navigation like the site's own <Link> (verified in
// absence-status.ts): `eventId` in the planning URL opens the event modal.
function openEvent(id: number): void {
  const url = new URL(location.href);
  url.searchParams.set('eventId', String(id));
  const idx = (history.state as { idx?: unknown } | null)?.idx;
  history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: typeof idx === 'number' ? idx + 1 : 0 }, '', url);
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}

// The site's planning-mode button (tabler calendar-cog in the page header):
// its aria-pressed is the truth; FullCalendar's flags alone can linger.
function planningModeOn(): boolean {
  return Array.from(document.querySelectorAll('svg.tabler-icon-calendar-cog')).some((svg) => {
    const b = svg.closest('button');
    return !!b && !b.closest('.scheduler-calendar, [role=dialog]') && b.getAttribute('aria-pressed') === 'true';
  });
}

function isoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function handler(name: string): ((arg: unknown) => void) | null {
  const fn = current?.props[name];
  return typeof fn === 'function' ? (fn as (arg: unknown) => void) : null;
}

// Board drag of an existing event -> the site's eventDrop (finds its record
// by Number(event.id); verified equal to extendedProps.id on live data).
function move(id: unknown, start: unknown, end: unknown): void {
  const s = isoMs(start);
  const e = isoMs(end);
  const drop = handler('eventDrop');
  if (!current || !planningModeOn() || current.props.editable !== true || !drop || typeof id !== 'number' || s === null || e === null) return;
  if (e <= s || e - s > DAY_MS) return;
  const input = current.events.find((x) => Number((x.extendedProps as { id?: unknown } | null)?.id ?? x.id) === id);
  if (!input) return;
  drop({ event: { id: String(input.id ?? id), start: new Date(s), end: new Date(e), extendedProps: input.extendedProps ?? {} }, revert() {} });
}

// Board drag on empty slots -> the site's select (opens its creation modal).
function create(start: unknown, end: unknown): void {
  const s = isoMs(start);
  const e = isoMs(end);
  const select = handler('select');
  if (!current || !planningModeOn() || current.props.selectable !== true || !select || s === null || e === null || e <= s || e - s > DAY_MS) return;
  select({ start: new Date(s), end: new Date(e), allDay: false, jsEvent: null, view: { calendar: { unselect() {} } } });
}

// Drop of the announced sidebar activity -> the site's eventReceive, with the
// Draggable's own eventData (never anything from the board but the start).
function receive(start: unknown): void {
  const s = isoMs(start);
  const recv = handler('eventReceive');
  const drop = pendingDrop;
  pendingDrop = null;
  if (!drop || Date.now() - drop.at > DROP_TTL_MS || !current || !planningModeOn() || current.props.droppable !== true || !recv || s === null) return;
  recv({
    event: {
      title: drop.data.title,
      start: new Date(s),
      end: new Date(s + drop.duration * 60_000),
      extendedProps: drop.data.extendedProps ?? {},
      remove() {},
    },
  });
}

// Room picked in the site's panel: the board's click = the site's own event
// click (assigns / toggles that room, a draft).
function roomClick(id: unknown): void {
  const click = handler('eventClick');
  if (!current || !planningModeOn() || !click || typeof id !== 'number' || !roomPickOf(findRoomPanel())) return;
  if (!current.events.some((x) => eventIdOf(x) === id)) return;
  click({ event: { id: String(id) } });
}

function eventIdOf(input: FcEventInput): number {
  return Number((input.extendedProps as { id?: unknown } | null)?.id ?? input.id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls (setTimeout, never rAF) until `test` returns a value or the time is up.
async function waitFor<T>(test: () => T | null | undefined | false, ms = 2000): Promise<T | null> {
  for (const until = Date.now() + ms; ; ) {
    const v = test();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(50);
  }
}

// Fresh FullCalendar props (each site render recreates eventClick with the
// current room selection in its closure).
function freshCalendar(): ReturnType<typeof findPlanningCalendar> {
  const calendar = document.querySelector('.scheduler-calendar');
  return calendar ? (fcRootOf(calendar)?.found ?? null) : null;
}

function roomIdsIn(found: ReturnType<typeof findPlanningCalendar>, id: number): string | null {
  const input = found?.events.find((x) => eventIdOf(x) === id);
  return input ? JSON.stringify(roomIdsOf((input.extendedProps ?? {}) as Record<string, unknown>)) : null;
}

// The rooms panel's accordion control (Mantine Accordion.Item value
// "room-assignment"; verified: aria-controls "…-panel-room-assignment"). The
// panel stays mounted while collapsed, but the site drops the picked room as
// long as that item is closed: it must be expanded.
function roomPanelControl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.scheduler-planning-sidebar .mantine-Accordion-control[aria-controls$="panel-room-assignment"]');
}

function roomPanelExpanded(): boolean {
  return roomPanelControl()?.getAttribute('aria-expanded') === 'true';
}

let roomsBusy = false;

function cleanChanges(raw: unknown): RoomChange[] {
  if (!Array.isArray(raw)) return [];
  const out: RoomChange[] = [];
  for (const c of raw.slice(0, 50)) {
    const x = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    if (!x || typeof x.roomId !== 'number' || (x.op !== 'add' && x.op !== 'remove') || !Array.isArray(x.ids)) continue;
    const ids = x.ids.filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v !== 0).slice(0, 200);
    if (ids.length) out.push({ roomId: x.roomId, op: x.op, ids });
  }
  return out;
}

// Add / remove rooms on events, through the site's own room assignment: for
// each room, pick it in its panel (add mode) and click each event that needs
// the change; then restore the panel as it was.
async function applyRooms(raw: unknown): Promise<void> {
  const changes = cleanChanges(raw);
  if (roomsBusy || !changes.length || !planningModeOn() || current?.props.editable !== true) return;
  roomsBusy = true;
  const result: RoomsDoneMessage = { source: ROOMS_DONE_SOURCE, changed: 0, failed: 0, error: false };
  let panel = findRoomPanel();
  const prev = panel ? { room: panel.selectedRoom, add: panel.addMode } : { room: null, add: false };
  const wasExpanded = roomPanelExpanded();
  try {
    if (!wasExpanded) {
      roomPanelControl()?.click();
      if (!(await waitFor(roomPanelExpanded))) {
        result.error = true;
        return;
      }
      panel = await waitFor(findRoomPanel);
    }
    for (const { roomId, op, ids: wanted } of changes) {
      panel = findRoomPanel();
      const room = panel?.rooms.find((r) => r.id === roomId);
      if (!panel || !room) {
        result.error = true;
        return;
      }
      panel.onRoomSelect(room);
      panel.onAddModeChange(true);
      const ready = await waitFor(() => {
        const p = findRoomPanel();
        return p && (p.selectedRoom as { id?: unknown } | null)?.id === roomId && p.addMode === true;
      });
      if (!ready) {
        result.error = true;
        return;
      }
      await sleep(50);
      for (const id of wanted) {
        const found = freshCalendar();
        const input = found?.events.find((x) => eventIdOf(x) === id);
        const click = found?.props.eventClick;
        if (!found || !input || typeof click !== 'function' || !planningModeOn()) {
          result.failed++;
          continue;
        }
        const has = roomIdsOf((input.extendedProps ?? {}) as Record<string, unknown>).includes(roomId);
        if (has === (op === 'add')) continue;
        const before = roomIdsIn(found, id);
        (click as (arg: unknown) => void)({ event: { id: String(id) } });
        // One change at a time: each click reads the events of the last render.
        const changed = await waitFor(() => {
          const now = roomIdsIn(freshCalendar(), id);
          return now !== null && now !== before;
        }, 1500);
        if (changed) result.changed++;
        else result.failed++;
      }
    }
  } finally {
    const p = findRoomPanel();
    if (p) {
      p.onRoomSelect(prev.room);
      p.onAddModeChange(prev.add);
    }
    // Collapse it again if we opened it.
    if (!wasExpanded && roomPanelExpanded()) roomPanelControl()?.click();
    roomsBusy = false;
    window.postMessage(result, location.origin);
  }
}

function minutesOf(duration: unknown): number {
  const m = typeof duration === 'string' ? /^(\d{1,2}):(\d{2})/.exec(duration) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : 60;
}

function onSidebarPointerDown(ev: PointerEvent): void {
  const card = (ev.target as Element | null)?.closest?.('.scheduler-planning-sidebar .fc-event');
  if (!card || ev.button !== 0) return;
  let data: unknown = null;
  try {
    data = findSidebarDraggable(card)?.eventData(card) ?? null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  const duration = minutesOf(d.duration);
  pendingDrop = { data: d, duration, at: Date.now() };
  const message: DragMessage = {
    source: DRAG_SOURCE,
    title: typeof d.title === 'string' ? d.title : '',
    duration,
    color: typeof d.color === 'string' ? d.color : null,
  };
  window.postMessage(message, location.origin);
}

export function init(): void {
  window.addEventListener('message', (ev) => {
    const data = ev.data as {
      source?: unknown;
      cmd?: unknown;
      id?: unknown;
      start?: unknown;
      end?: unknown;
      changes?: unknown;
      hidden?: unknown;
    } | null;
    if (ev.source !== window || !data || data.source !== COMMAND_SOURCE) return;
    if (data.cmd === 'hello') {
      lastPayload = '';
      check();
    } else if (data.cmd === 'open' && typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0) {
      openEvent(data.id);
    } else if (data.cmd === 'move') {
      move(data.id, data.start, data.end);
    } else if (data.cmd === 'create') {
      create(data.start, data.end);
    } else if (data.cmd === 'receive') {
      receive(data.start);
    } else if (data.cmd === 'roomClick') {
      roomClick(data.id);
    } else if (data.cmd === 'rooms') {
      void applyRooms(data.changes);
    }
  });
  document.addEventListener('pointerdown', onSidebarPointerDown, true);
  watchDom(check, { htmlAttributes: [datasetAttr(FLAGS.planningBoard.mirror)] });
}
