// Planning board: the messages between the MAIN-world feed
// (planning-feed.ts) and the isolated-world board (planning-board/board.ts).
// Both worlds import this file: no browser.* here.
//
// window.postMessage is forgeable by the page, so the board re-validates the
// feed (sanitizeFeed), and the feed re-validates every command against its own
// data. The planning-mode commands (move / create / receive) only call the
// site's own FullCalendar handlers, which stage drafts (published later from
// the site's review bar), so a forged one can't do more than a user drag.

export const FEED_SOURCE = 'epitools-pb-feed';
export const COMMAND_SOURCE = 'epitools-pb-cmd';
/** MAIN -> board: a plannable activity is being dragged from the site's sidebar. */
export const DRAG_SOURCE = 'epitools-pb-drag';
/** MAIN -> board: a `rooms` command finished. */
export const ROOMS_DONE_SOURCE = 'epitools-pb-rooms-done';
/** On the FullCalendar root the board replaces (hidden by CSS while the board shows). */
export const NATIVE_ATTR = 'data-epitools-pb-native';
/** <html data-epitools-pb-active="on">: the board is mounted for a week/day view. */
export const ACTIVE_DATASET_KEY = 'epitoolsPbActive';

export interface BoardEvent {
  id: number;
  title: string;
  start: string;
  end: string;
  /** Site colour of the block, `#rrggbb`-ish (validated). */
  color: string | null;
  unitCode: string;
  unitName: string;
  rooms: string[];
  instructors: string[];
  registrations: number | null;
  capacity: number | null;
  /** Intranet activity instance (merged-events guess). */
  activity: string | null;
  isExam: boolean;
  /** Planning-mode draft state (`created`, `modified`…): not published yet. */
  draft: string | null;
  /** Ids matching `rooms` (same order). */
  roomIds: number[];
  /** The site's room assignment: "highlight events without room" on and this one has none. */
  noRoom: boolean;
  /** The site's room assignment: a room is picked and this event isn't in it. */
  outOfRoom: boolean;
}

export interface BoardRoom {
  id: number;
  name: string;
  capacity: number | null;
}

export interface BoardView {
  /** FullCalendar view type: timeGridWeek, timeGridDay, dayGridMonth… */
  type: string;
  start: string;
  end: string;
  /** "08:00:00" */
  slotMin: string;
  slotMax: string;
  /** The site's planning mode: FullCalendar `editable` (drag to move) + `selectable` / `droppable`. */
  editable: boolean;
  /** Rooms the site offers for assignment (its rooms query), [] when unknown. */
  rooms: BoardRoom[];
  /** Room picked in the site's "Rooms assignement" panel: a click on an event assigns it. */
  roomPick: { id: number; name: string; add: boolean } | null;
}

export interface FeedMessage {
  source: typeof FEED_SOURCE;
  view: BoardView | null;
  events: BoardEvent[];
}

export type CommandMessage =
  | { source: typeof COMMAND_SOURCE; cmd: 'hello' }
  | { source: typeof COMMAND_SOURCE; cmd: 'open'; id: number }
  | { source: typeof COMMAND_SOURCE; cmd: 'move'; id: number; start: string; end: string }
  | { source: typeof COMMAND_SOURCE; cmd: 'create'; start: string; end: string }
  /** Drop of the activity announced by the last DRAG_SOURCE message; the feed computes the end. */
  | { source: typeof COMMAND_SOURCE; cmd: 'receive'; start: string }
  /** Planning mode with a room picked in the site's panel: the site's own event click (assigns it). */
  | { source: typeof COMMAND_SOURCE; cmd: 'roomClick'; id: number }
  /** Add / remove rooms on events, in one go (through the site's room assignment: drafts). */
  | { source: typeof COMMAND_SOURCE; cmd: 'rooms'; changes: RoomChange[] };

export interface RoomChange {
  roomId: number;
  op: 'add' | 'remove';
  ids: number[];
}

export interface RoomsDoneMessage {
  source: typeof ROOMS_DONE_SOURCE;
  changed: number;
  /** Events the site refused or that didn't change (read-only…). */
  failed: number;
  /** The site's room panel couldn't be reached. */
  error: boolean;
}

export interface DragMessage {
  source: typeof DRAG_SOURCE;
  title: string;
  /** Minutes */
  duration: number;
  color: string | null;
}

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;
const id = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

function sanitizeEvent(raw: unknown): BoardEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const eventId = e.id;
  const start = iso(e.start);
  const end = iso(e.end);
  // Negative = a planning-mode draft not published yet (temporary id): display only.
  if (typeof eventId !== 'number' || !Number.isSafeInteger(eventId) || eventId === 0 || !start || !end) return null;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x, 120)).filter(Boolean).slice(0, 20) : []);
  return {
    id: eventId,
    title: str(e.title),
    start,
    end,
    color: typeof e.color === 'string' && COLOR.test(e.color) ? e.color : null,
    unitCode: str(e.unitCode, 40),
    unitName: str(e.unitName, 200),
    rooms: list(e.rooms),
    instructors: list(e.instructors),
    registrations: num(e.registrations),
    capacity: num(e.capacity),
    activity: typeof e.activity === 'string' && /^\d{1,15}$/.test(e.activity) ? e.activity : null,
    isExam: e.isExam === true,
    draft: typeof e.draft === 'string' && /^[a-z-]{1,20}$/.test(e.draft) ? e.draft : null,
    roomIds: Array.isArray(e.roomIds) ? e.roomIds.map(id).filter((x): x is number => x !== null).slice(0, 20) : [],
    noRoom: e.noRoom === true,
    outOfRoom: e.outOfRoom === true,
  };
}

function sanitizeRooms(raw: unknown): BoardRoom[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardRoom[] = [];
  for (const r of raw.slice(0, 500)) {
    const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    const rid = id(x?.id);
    const name = str(x?.name, 120);
    if (rid !== null && name) out.push({ id: rid, name, capacity: num(x?.capacity) });
  }
  return out;
}

function sanitizePick(raw: unknown): BoardView['roomPick'] {
  const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const rid = id(x?.id);
  return x && rid !== null ? { id: rid, name: str(x.name, 120), add: x.add === true } : null;
}

/** Untrusted message data -> a clean feed, or null when it isn't one. */
export function sanitizeFeed(data: unknown): { view: BoardView | null; events: BoardEvent[] } | null {
  if (!data || typeof data !== 'object' || (data as { source?: unknown }).source !== FEED_SOURCE) return null;
  const d = data as Record<string, unknown>;
  let view: BoardView | null = null;
  const v = d.view as Record<string, unknown> | null;
  if (v && typeof v === 'object') {
    const start = iso(v.start);
    const end = iso(v.end);
    const slotMin = str(v.slotMin, 8);
    const slotMax = str(v.slotMax, 8);
    if (start && end) {
      view = {
        type: str(v.type, 40),
        start,
        end,
        slotMin: TIME.test(slotMin) ? slotMin : '08:00:00',
        slotMax: TIME.test(slotMax) ? slotMax : '20:00:00',
        editable: v.editable === true,
        rooms: sanitizeRooms(v.rooms),
        roomPick: sanitizePick(v.roomPick),
      };
    }
  }
  const events = Array.isArray(d.events) ? d.events.slice(0, 2000).map(sanitizeEvent).filter((e): e is BoardEvent => !!e) : [];
  return { view, events };
}

/** Untrusted rooms result -> clean, or null. */
export function sanitizeRoomsDone(data: unknown): Omit<RoomsDoneMessage, 'source'> | null {
  if (!data || typeof data !== 'object' || (data as { source?: unknown }).source !== ROOMS_DONE_SOURCE) return null;
  const d = data as Record<string, unknown>;
  return { changed: num(d.changed) ?? 0, failed: num(d.failed) ?? 0, error: d.error === true };
}

/** Untrusted drag notice -> clean, or null. */
export function sanitizeDrag(data: unknown): Omit<DragMessage, 'source'> | null {
  if (!data || typeof data !== 'object' || (data as { source?: unknown }).source !== DRAG_SOURCE) return null;
  const d = data as Record<string, unknown>;
  const duration = typeof d.duration === 'number' && Number.isFinite(d.duration) ? Math.round(d.duration) : 60;
  return {
    title: str(d.title, 200),
    duration: Math.min(24 * 60, Math.max(15, duration)),
    color: typeof d.color === 'string' && COLOR.test(d.color) ? d.color : null,
  };
}
