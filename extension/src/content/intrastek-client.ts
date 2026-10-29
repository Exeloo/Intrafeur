// Intrastek, isolated world: messaging with the background (which holds the
// API key and does the fetches), the per-event status cache, and small pure
// helpers shared by intrastek.ts and intrastek-ui.ts.
import browser from 'webextension-polyfill';
import type {
  IntrastekActivity,
  IntrastekEventState,
  IntrastekGroup,
  IntrastekMe,
  IntrastekProposal,
  IntrastekResponse,
  IntrastekWriteResult,
  MessageType,
} from '../types';

// Attributes written by the MAIN-world intrastek-page.ts. The page can forge
// them, so they're display-only except the id, which goes through
// parseEventId.
export const EVENT_ID_ATTR = 'data-epitools-event-id';
export const EVENT_TITLE_ATTR = 'data-epitools-event-title';
export const EVENT_START_ATTR = 'data-epitools-event-start';
export const EVENT_END_ATTR = 'data-epitools-event-end';
export const EVENT_ACTIVITY_ATTR = 'data-epitools-event-activity';

export class IntrastekError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(type: MessageType, payload: unknown): Promise<T> {
  let res: IntrastekResponse<T>;
  try {
    res = (await browser.runtime.sendMessage({ type, payload })) as IntrastekResponse<T>;
  } catch (err) {
    // "Extension context invalidated": the tab wasn't reloaded after an
    // extension reload.
    throw new IntrastekError(0, `Intrafeur error: ${(err as Error)?.message || err}. Reload the page.`);
  }
  if (!res || typeof res !== 'object') throw new IntrastekError(0, 'Unexpected answer from the extension');
  if (!res.ok) throw new IntrastekError(res.status, res.message);
  return res.data;
}

export const api = {
  me: () => call<IntrastekMe>('intrastekMe', {}),
  status: (eventIds: number[]) => call<IntrastekEventState[]>('intrastekStatus', { eventIds }),
  set: (eventId: number, groupId: string, nbUserAsk: number) =>
    call<IntrastekWriteResult>('intrastekSet', { eventId, groupId, nbUserAsk }),
  remove: (eventId: number, groupId: string, force = false) =>
    call<IntrastekWriteResult>('intrastekRemove', { eventId, groupId, force }),
  approve: (proposalId: string, force = false) =>
    call<IntrastekWriteResult>('intrastekApprove', { proposalId, force }),
  cancel: (proposalId: string) => call<IntrastekWriteResult>('intrastekCancel', { proposalId }),
};

// Untrusted DOM value -> positive integer id, or null.
export function parseEventId(value: string | null | undefined): number | null {
  if (!value || !/^[1-9]\d{0,14}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

// --- Status cache ---
// id -> last known state. Entries are kept after they go stale (or are
// invalidated) so the blocks don't flicker; `at` decides refetching.
const TTL_MS = 60_000;
const FAILURE_BACKOFF_MS = 30_000;
const cache = new Map<number, { state: IntrastekEventState; at: number }>();
const inflight = new Map<number, Promise<void>>();
const failedAt = new Map<number, number>();
let generation = 0;

const changeListeners = new Set<() => void>();
export function onCacheChange(listener: () => void): void {
  changeListeners.add(listener);
}
function notify(): void {
  for (const listener of changeListeners) listener();
}

export function cachedState(id: number): IntrastekEventState | null {
  return cache.get(id)?.state ?? null;
}

function needsFetch(id: number, now: number): boolean {
  const failed = failedAt.get(id);
  if (failed !== undefined && now - failed < FAILURE_BACKOFF_MS) return false;
  const entry = cache.get(id);
  return !entry || now - entry.at > TTL_MS;
}

// Fetches the ids that are missing or stale (all of them with force), and
// waits for requests already in flight for the others, so callers can read
// cachedState() once it resolves. Resolves true when something was fetched
// or awaited (callers re-render only then, so a no-op never retriggers a
// check loop).
export async function fetchStatus(ids: number[], force = false): Promise<boolean> {
  const now = Date.now();
  const unique = Array.from(new Set(ids));
  const pending = unique.map((id) => inflight.get(id)).filter((p): p is Promise<void> => !!p);
  const todo = unique.filter((id) => !inflight.has(id) && (force || needsFetch(id, now)));
  if (!todo.length && !pending.length) return false;

  if (todo.length) {
    const gen = generation;
    const request = api.status(todo).then(
      (states) => {
        if (gen !== generation) return;
        const at = Date.now();
        for (const state of states) {
          if (!state || !Number.isSafeInteger(state.eventId)) continue;
          cache.set(state.eventId, { state, at });
          failedAt.delete(state.eventId);
        }
      },
      (err: unknown) => {
        const at = Date.now();
        for (const id of todo) failedAt.set(id, at);
        throw err;
      },
    );
    const settled = request.finally(() => {
      for (const id of todo) if (inflight.get(id) === settled) inflight.delete(id);
    });
    // Waiters on another caller's request don't need its rejection.
    settled.catch(() => undefined);
    for (const id of todo) inflight.set(id, settled);
    pending.push(settled);
  }
  await Promise.all(pending);
  return true;
}

// After any write: every entry becomes stale (kept for display), then the
// write's own answer is stored as fresh.
export function invalidateAll(): void {
  generation++;
  for (const entry of cache.values()) entry.at = 0;
  failedAt.clear();
}

// Key/URL change: forget everything.
export function clearCache(): void {
  generation++;
  cache.clear();
  failedAt.clear();
}

export async function runWrite(write: () => Promise<IntrastekWriteResult>): Promise<IntrastekWriteResult> {
  const res = await write();
  invalidateAll();
  if (res?.state && Number.isSafeInteger(res.state.eventId)) {
    cache.set(res.state.eventId, { state: res.state, at: Date.now() });
  }
  notify();
  return res;
}

export function resultMessage(res: IntrastekWriteResult): string {
  return res.result === 'proposed' ? 'Proposal sent – waiting for admin approval' : 'Applied';
}

// --- Views over a state ---

export interface GroupView {
  activities: IntrastekActivity[];
  proposal: IntrastekProposal | null;
  initialized: boolean;
  // Max over the group's activities (an event split at its slots' pause has
  // two rows, normally with the same value); null when not initialized.
  nbUserAsk: number | null;
  // The first event when this one follows it (same intranet activity, back to
  // back): only that one can be set. From the API once the merge exists (or a
  // proposal on the first event spans this one), else guessed from the
  // calendar (display only, the API decides), and then only when that first
  // event is on Intrastek (activities or a pending proposal in the group).
  linkedTo: number | null;
}

function onIntrastek(eventId: number, groupId: string | null): boolean {
  const state = cachedState(eventId);
  if (!state) return false;
  return (
    state.activities.some((a) => groupId === null || a.groupId === groupId) ||
    state.proposals.some((p) => p.status === 'PENDING' && (groupId === null || p.groupId === groupId))
  );
}

// groupId null = all groups in the state.
export function groupView(state: IntrastekEventState, groupId: string | null): GroupView {
  const activities = state.activities.filter((a) => groupId === null || a.groupId === groupId);
  const proposal =
    state.proposals.find((p) => p.status === 'PENDING' && (groupId === null || p.groupId === groupId)) ?? null;
  return {
    activities,
    proposal,
    initialized: activities.length > 0,
    nbUserAsk: activities.length ? Math.max(...activities.map((a) => a.nbUserAsk)) : null,
    linkedTo: activities.length
      ? (activities.find((a) => a.headEventId !== state.eventId)?.headEventId ?? null)
      : proposal && proposal.eventId !== state.eventId
        ? proposal.eventId
        : guessedHead(state.eventId, groupId),
  };
}

// Same rule as the API (back-to-back = next start at most 15 min after the
// end so far, same Paris day, same intranet activity), over the tagged
// blocks on screen. The tags are forgeable: display only.
const MERGE_GAP_MS = 15 * 60_000;
const parisDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' });

function guessedHead(eventId: number, groupId: string | null): number | null {
  const head = guessHead(eventId);
  return head !== null && onIntrastek(head, groupId) ? head : null;
}

function guessHead(eventId: number): number | null {
  const byId = new Map<number, { activity: string; start: number; end: number }>();
  for (const el of Array.from(document.querySelectorAll(`[${EVENT_ID_ATTR}][${EVENT_ACTIVITY_ATTR}]`))) {
    const id = parseEventId(el.getAttribute(EVENT_ID_ATTR));
    const activity = el.getAttribute(EVENT_ACTIVITY_ATTR);
    const start = Date.parse(el.getAttribute(EVENT_START_ATTR) ?? '');
    const end = Date.parse(el.getAttribute(EVENT_END_ATTR) ?? '');
    if (id && activity && Number.isFinite(start) && Number.isFinite(end)) byId.set(id, { activity, start, end });
  }
  const self = byId.get(eventId);
  if (!self) return null;
  const day = parisDay.format(self.start);
  const same = Array.from(byId, ([id, e]) => ({ id, ...e }))
    .filter((e) => e.activity === self.activity && parisDay.format(e.start) === day)
    .sort((a, b) => a.start - b.start || a.id - b.id);
  let head = same[0];
  let end = -Infinity;
  for (const e of same) {
    if (e.start > end + MERGE_GAP_MS) head = e;
    end = Math.max(end, e.end);
    if (e.id === eventId) return head && head.id !== eventId ? head.id : null;
  }
  return null;
}

// Group the planning actions target: the configured default when the key
// may use it, else the user's own group, else the first one.
export function targetGroupId(me: IntrastekMe, configured: string): string | null {
  if (configured && me.groups.some((g) => g.id === configured)) return configured;
  if (me.defaultGroupId && me.groups.some((g) => g.id === me.defaultGroupId)) return me.defaultGroupId;
  return me.groups[0]?.id ?? null;
}

export function groupName(groups: IntrastekGroup[], id: string): string {
  return groups.find((g) => g.id === id)?.name ?? `group ${id.slice(0, 8)}`;
}

export function canWrite(me: IntrastekMe): boolean {
  return me.scopes.includes('INTRANET_WRITE');
}

export function personName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName} ${p.lastName}`.trim();
}

export function proposalSummary(p: IntrastekProposal): string {
  if (p.kind === 'REMOVE') return 'remove the activities';
  const value = p.nbUserAsk === null ? '?' : String(p.nbUserAsk);
  return p.kind === 'INIT' ? `initialize with ${value} AER(s)` : `set AERs needed to ${value}`;
}

// "Mon 27 Oct, 09:00–12:00" in Paris time; '' when the (untrusted) values
// aren't dates.
export function formatEventDate(start: string | null, end: string | null): string {
  const s = start ? new Date(start) : null;
  if (!s || Number.isNaN(s.getTime())) return '';
  const e = end ? new Date(end) : null;
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Paris',
  }).format(s);
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const range = e && !Number.isNaN(e.getTime()) ? `${time.format(s)}–${time.format(e)}` : time.format(s);
  return `${day}, ${range}`;
}
