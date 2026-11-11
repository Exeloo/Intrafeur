// React fiber access. React attaches an internal fiber to each DOM node
// under a key like "__reactFiber$<random>" (the suffix changes per
// build/session), so it's found by prefix. Everything but extractRowOriginal
// only works from the page's MAIN world: an isolated-world content script
// can't see those expandos.

/** The slice of a React fiber we read. */
export interface Fiber {
  key?: string | null;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: Hook | null;
  dependencies?: { firstContext?: ContextDependency | null } | null;
  return?: Fiber | null;
  child?: Fiber | null;
  sibling?: Fiber | null;
  stateNode?: unknown;
  /** The other copy of this fiber (React double-buffers: current / work-in-progress). */
  alternate?: Fiber | null;
}

/** A function component's hook list entry (fiber.memoizedState chain). */
export interface Hook {
  memoizedState?: unknown;
  next?: Hook | null;
}

interface ContextDependency {
  memoizedValue?: unknown;
  next?: ContextDependency | null;
}

export function findFiberKey(domNode: Element): string | undefined {
  return Object.keys(domNode).find(
    (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
  );
}

// Its chain of `return`s ends at the HostRoot that its FiberRoot calls current.
function inCurrentTree(fiber: Fiber): boolean {
  let top = fiber;
  for (let i = 0; top.return && i < 5000; i++) top = top.return;
  return (top.stateNode as { current?: unknown } | null | undefined)?.current === top;
}

/**
 * The DOM node's fiber, in the committed tree. The expando React leaves on a
 * DOM node can be the *alternate* (previous render) copy, whose props and
 * ancestors' props are a render behind (verified live 2026-11: the planning's
 * FullCalendar `events` read through it lagged after a room change / discard).
 */
export function fiberOf(domNode: Element): Fiber | null | undefined {
  const key = findFiberKey(domNode);
  const fiber = key ? (domNode as unknown as Record<string, Fiber>)[key] : null;
  if (fiber?.alternate && !inCurrentTree(fiber) && inCurrentTree(fiber.alternate)) return fiber.alternate;
  return fiber;
}

// Mantine React Table keeps the row data (email/firstname/lastname) in a
// TanStack/MRT `row.original`. Defensive fallback only: the current page
// renders the email as plain text (see attendance.ts), but this covers a
// future redesign that removes that. Walks up and down a few levels.
export interface RowOriginal {
  login?: string;
  firstname?: string;
  lastname?: string;
  [key: string]: unknown;
}

export function extractRowOriginal(trElement: Element, maxDepth = 25): RowOriginal | null {
  const rootFiber = fiberOf(trElement);
  if (!rootFiber) return null;
  const visited = new Set<Fiber>();
  let result: RowOriginal | null = null;

  function search(fiber: Fiber | null | undefined, depth: number): void {
    if (!fiber || depth > maxDepth || result || visited.has(fiber)) return;
    visited.add(fiber);

    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      const row = props.row as { original?: unknown } | null | undefined;
      if (row && row.original) {
        result = row.original as RowOriginal;
        return;
      }
      if (props.original && typeof props.original === 'object') {
        result = props.original as RowOriginal;
        return;
      }
    }

    search(fiber.child, depth + 1);
    if (result) return;
    search(fiber.return, depth + 1);
  }

  search(rootFiber, 0);
  return result;
}

// The planning page's event-details modal keeps the whole event record in
// the props of one of its React components (verified live: 16 fibers above
// the unit link in the modal header). It carries IDs the DOM never shows
// (e.g. projectInstanceId), so we walk up from any element inside the modal
// until we meet an `event` prop of the right shape.
//
export interface PlanningEvent {
  id: string | number;
  fullTitle?: string | null;
  activityName?: string | null;
  unitCode: string;
  projectInstanceId?: number | null;
  activityInstanceId: number | string;
  startDate?: string;
  endDate?: string;
  unitName?: string | null;
  activitySlotsEnabled?: boolean;
  rooms?: { name?: string | null }[] | null;
}

function isPlanningEvent(value: unknown): value is PlanningEvent {
  return (
    !!value &&
    typeof value === 'object' &&
    'activityInstanceId' in value &&
    'unitCode' in value &&
    'id' in value
  );
}

export function extractPlanningEvent(domNode: Element, maxDepth = 40): PlanningEvent | null {
  let fiber = fiberOf(domNode);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const event = fiber.memoizedProps?.event;
    if (isPlanningEvent(event)) return event;
  }
  return null;
}

// --- Site singletons: React Query client and API client ---

// Minimal slice of TanStack Query's QueryClient that we rely on. The site
// keeps most fetched resources in it (registrations, slots), so we read from
// it rather than re-calling the authenticated API ourselves.
export interface CachedQuery {
  queryKey: unknown[];
  state: { data: unknown; dataUpdatedAt: number };
  fetch: () => Promise<unknown>;
}

// Slice of the site's generated API client (bearer auth handled inside).
// getAvatar resolves to the full photo as a Blob (240x240 JPEG, verified
// live), getAvatarThumbnail to a 96x96 data: URL; both reject or resolve to
// null when the student has no photo. events.setAttendance is what the
// planning modal's Attendance menu calls (POST /events/:id/attendance/set).
export type AttendanceStatus = 'present' | 'absent' | 'justified';

export interface ApiClientLike {
  unlabeled: {
    getAvatar: (login: string) => Promise<unknown>;
    getAvatarThumbnail: (login: string) => Promise<unknown>;
  };
  events?: {
    setAttendance?: (
      eventId: number,
      dto: { records: { login: string; status: AttendanceStatus }[] },
    ) => Promise<void>;
    // GET /events/:id; a graded activity has a gradingScaleId (what the
    // project page's "View grading scale" button keys on).
    // GET /events with the planning's list-query params (verified live
    // 2026-11: {campus, promotion: ['PGE:2031'], startDate, endDate} -> the events).
    getAll?: (params: Record<string, unknown>) => Promise<unknown>;
    getById?: (eventId: number) => Promise<{
      activityInstance?: { gradingScaleId?: number | null; metadata?: { evaluationType?: string } | null } | null;
    }>;
  };
  // GET /units/instances and GET /units/:year/:code/:instance/registrations
  // (the actual registrations; /students lists every eligible student).
  units?: {
    getAllUnitInstances?: (schoolYear: number, expanded?: boolean) => Promise<{ data?: UnitInstance[] }>;
    getRegistrations?: (
      schoolYear: number,
      unitCode: string,
      instanceCode: string,
    ) => Promise<{ student?: UnitStudent | null }[]>;
  };
}

// Fields of a /units/instances item used by student-units.ts (verified live).
export interface UnitInstance {
  schoolYear: number;
  code: string;
  unitCode: string;
  name?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  registrationsCount?: number | null;
  semesters?: { id?: number | null }[] | null;
  campuses?: { code?: string | null }[] | null;
}

// A GET /units/:year/:code/:instance/registrations row's `student` (verified live).
export interface UnitStudent {
  login?: string;
  campus?: { code?: string | null } | null;
  semester?: { id?: number | null; num?: number | null; cursus?: { code?: string | null } | null } | null;
}

export interface QueryClientLike {
  getQueryCache: () => {
    find: (filters: { queryKey: unknown[]; exact?: boolean }) => CachedQuery | undefined;
    getAll?: () => CachedQuery[];
  };
}

// Both lookups walk up to 1000 fibers, and absence-status runs them from
// every card on every check: positive results are cached per start element
// (re-validated on use; misses aren't cached, the fiber may not be mounted yet).
const queryClients = new WeakMap<Element, QueryClientLike>();
const apiClients = new WeakMap<Element, ApiClientLike>();

function isQueryClient(value: unknown): value is QueryClientLike {
  return !!value && typeof (value as { getQueryCache?: unknown }).getQueryCache === 'function';
}

// Verified live: the QueryClientProvider (props.client) sits a few hundred
// fibers above the planning modal.
export function findQueryClient(domNode: Element, maxDepth = 1000): QueryClientLike | null {
  const cached = queryClients.get(domNode);
  if (isQueryClient(cached)) return cached;
  let fiber = fiberOf(domNode);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const client = fiber.memoizedProps?.client;
    if (isQueryClient(client)) {
      queryClients.set(domNode, client);
      return client;
    }
  }
  return null;
}

function isApiClient(value: unknown): value is ApiClientLike {
  try {
    const unlabeled = (value as { unlabeled?: Record<string, unknown> } | null)?.unlabeled;
    return typeof unlabeled?.getAvatar === 'function' && typeof unlabeled.getAvatarThumbnail === 'function';
  } catch {
    return false;
  }
}

// The API client is provided through a React context; components that use
// it list it in their fiber's context dependencies. Verified live: ~20
// fibers above the planning modal. The site doesn't load student avatars in
// that modal itself, so this is the only authenticated way to get them.
export function findApiClient(domNode: Element, maxDepth = 1000): ApiClientLike | null {
  const cached = apiClients.get(domNode);
  if (isApiClient(cached)) return cached;
  let fiber = fiberOf(domNode);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) {
      if (isApiClient(dep.memoizedValue)) {
        apiClients.set(domNode, dep.memoizedValue);
        return dep.memoizedValue;
      }
    }
  }
  return null;
}

export interface SlotStudent {
  login: string;
  firstname?: string | null;
  lastname?: string | null;
}

export interface EventSlot {
  id: number;
  startDate: string;
  endDate: string;
  registration?: {
    student?: SlotStudent | null;
    registeredStudents?: SlotStudent[] | null;
  } | null;
}

function isEventSlotArray(value: unknown): value is EventSlot[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((s) => !!s && typeof s === 'object' && 'startDate' in s && 'endDate' in s && 'id' in s)
  );
}

// The "Appointment slots" list component receives every slot of the event as
// a `slots` prop. Walks the fiber subtree under `root` (the modal) to find
// it; returns the slots plus the DOM elements rendered under that component
// (to look for the per-time-group cards in).
export function findSlotsList(root: Element, maxNodes = 20000): { slots: EventSlot[]; hosts: Element[] } | null {
  const start = fiberOf(root);
  if (!start) return null;
  const stack: Fiber[] = [start];
  let visited = 0;
  while (stack.length && visited++ < maxNodes) {
    const fiber = stack.pop()!;
    const slots = fiber.memoizedProps?.slots;
    if (isEventSlotArray(slots)) {
      const hosts: Element[] = [];
      const hostStack: Fiber[] = fiber.child ? [fiber.child] : [];
      while (hostStack.length) {
        const f = hostStack.pop()!;
        if (f.stateNode instanceof Element) {
          hosts.push(f.stateNode);
        } else if (f.child) {
          hostStack.push(f.child);
        }
        if (f.sibling) hostStack.push(f.sibling);
      }
      return { slots, hosts };
    }
    if (fiber.sibling && fiber !== start) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return null;
}

// --- Planning calendar blocks (old Intrastek mode tagging, native calendar) ---

// The planning calendar is FullCalendar: each block is a
// `div.scheduler-event[role=button]` whose fiber (verified live: depth 1)
// has `memoizedProps.renderProps.event`, a FullCalendar EventApi. Its `id`
// is the intranet event id as a string and `extendedProps` holds the
// intranet event record.
export interface SchedulerEvent {
  id: string;
  fullTitle: string | null;
  startDate: string | null;
  endDate: string | null;
  unitCode: string | null;
  rooms: { name?: string | null }[] | null;
  // Intranet activity of the event: back-to-back events of one activity are
  // merged into one Intrastek activity.
  activityInstanceId: string | null;
}

interface EventApiLike {
  id?: unknown;
  title?: unknown;
  start?: unknown;
  end?: unknown;
  extendedProps?: Record<string, unknown> | null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return asString(value);
}

export function extractSchedulerEvent(el: Element, maxDepth = 5): SchedulerEvent | null {
  let fiber = fiberOf(el);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const renderProps = fiber.memoizedProps?.renderProps as { event?: unknown } | null | undefined;
    const event = renderProps?.event as EventApiLike | undefined;
    if (!event || typeof event !== 'object') continue;
    const ext = event.extendedProps && typeof event.extendedProps === 'object' ? event.extendedProps : {};
    const id = asString(ext.id) ?? asString(event.id);
    if (!id) continue;
    return {
      id,
      fullTitle: asString(ext.fullTitle) ?? asString(event.title),
      startDate: asIso(ext.startDate) ?? asIso(event.start),
      endDate: asIso(ext.endDate) ?? asIso(event.end),
      unitCode: asString(ext.unitCode),
      activityInstanceId: asString(ext.activityInstanceId),
      rooms: Array.isArray(ext.rooms) ? (ext.rooms as { name?: string | null }[]) : null,
    };
  }
  return null;
}

// --- Planning calendar (planning board feed) ---

// The planning is FullCalendar React. The component 2 fibers above the
// FullCalendar root div (`.scheduler-calendar`'s child holding the grid,
// verified live 2026-11) has props `events` (exactly what's displayed, all
// filters applied: `{id, title, start, end, color, className, extendedProps}`,
// extendedProps = the intranet event record) and `ref` (the FullCalendar
// instance: getApi() gives the view type/range and slotMin/MaxTime).
export interface FcEventInput {
  id?: unknown;
  start?: unknown;
  end?: unknown;
  color?: unknown;
  title?: unknown;
  className?: unknown;
  extendedProps?: Record<string, unknown> | null;
}

export interface FcApiLike {
  view: { type: string; activeStart: Date; activeEnd: Date };
  getOption(name: string): unknown;
}

/** FullCalendar props of the planning (handlers used by the board in planning mode). */
export type FcProps = Record<string, unknown>;

export function findPlanningCalendar(fcRoot: Element, maxDepth = 8): { events: FcEventInput[]; api: FcApiLike | null; props: FcProps } | null {
  let fiber = fiberOf(fcRoot);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!props || !Array.isArray(props.events) || !('eventClick' in props)) continue;
    let api: FcApiLike | null = null;
    try {
      api = (props.ref as { current?: { getApi?: () => FcApiLike } } | null)?.current?.getApi?.() ?? null;
    } catch {
      api = null;
    }
    return { events: props.events as FcEventInput[], api, props };
  }
  return null;
}

/**
 * The FullCalendar `Draggable` of a plannable-activity card in the site's
 * planning sidebar (`.scheduler-planning-sidebar .fc-event`), kept in the
 * card component's state (verified live 2026-11: `new Draggable(el,
 * {itemSelector: '.fc-event', eventData})`, eventData ignoring its argument).
 */
export function findSidebarDraggable(card: Element, maxDepth = 8): { eventData: (el: Element) => unknown } | null {
  let fiber = fiberOf(card);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
    for (let i = 0; hook && typeof hook === 'object' && i < 50; i++) {
      const settings = (hook.memoizedState as { settings?: { eventData?: unknown } } | null)?.settings;
      if (settings && typeof settings.eventData === 'function') return { eventData: settings.eventData as (el: Element) => unknown };
      hook = hook.next as typeof hook;
    }
  }
  return null;
}

// --- Student page "Absences" tab ---

// Verified live on /students/<login>#absences ("By activities" view): each
// absence is a Card whose wrapper component (5 fibers above the
// .mantine-Card-root, the one with an `accentBorderSide` prop) is keyed
// `${eventId}-${startDate}`, and the list component above it has the
// student's `login` prop. The list only contains `absent` records (justified
// ones are left out), and its records carry no status field.
export interface AbsenceCard {
  eventId: number;
  startDate: string;
  login: string;
}

const ABSENCE_KEY = /^(\d+)-(\d{4}-\d\d-\d\dT\S+)$/;

export function extractAbsenceCard(card: Element, maxDepth = 25): AbsenceCard | null {
  let fiber = fiberOf(card);
  let match: RegExpExecArray | null = null;
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!match) {
      if (props && 'accentBorderSide' in props && fiber.key) match = ABSENCE_KEY.exec(fiber.key);
      continue;
    }
    const login = props?.login;
    if (typeof login === 'string' && login) {
      const eventId = Number(match[1]);
      return Number.isSafeInteger(eventId) && eventId > 0 ? { eventId, startDate: match[2], login } : null;
    }
  }
  return null;
}
