// Pulls the underlying row data (email/firstname/lastname) that Mantine
// React Table holds in React state, straight off the DOM node. This is a
// defensive fallback only: the current page renders the email as plain text
// (see attendance.ts), but this covers a future redesign that removes that.
//
// React attaches an internal fiber to each DOM node under a key like
// "__reactFiber$<random>" (the random suffix changes per build/session), so
// we find it by prefix rather than by exact name. From there we walk up and
// down a few levels looking for a TanStack/MRT `row.original` object.

interface FiberNode {
  memoizedProps?: {
    row?: { original?: unknown };
    original?: unknown;
  };
  child?: FiberNode | null;
  return?: FiberNode | null;
}

export interface RowOriginal {
  login?: string;
  firstname?: string;
  lastname?: string;
  [key: string]: unknown;
}

function findFiberKey(domNode: Element): string | undefined {
  return Object.keys(domNode).find(
    (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
  );
}

export function extractRowOriginal(trElement: Element, maxDepth = 25): RowOriginal | null {
  const fiberKey = findFiberKey(trElement);
  if (!fiberKey) return null;

  const rootFiber = (trElement as unknown as Record<string, FiberNode>)[fiberKey];
  const visited = new Set<FiberNode>();
  let result: RowOriginal | null = null;

  function search(fiber: FiberNode | null | undefined, depth: number): void {
    if (!fiber || depth > maxDepth || result || visited.has(fiber)) return;
    visited.add(fiber);

    const props = fiber.memoizedProps;
    if (props && typeof props === 'object') {
      if (props.row && props.row.original) {
        result = props.row.original as RowOriginal;
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
// Only works from the page's MAIN world: an isolated-world content script
// can't see the "__reactFiber$..." expandos React sets on DOM nodes.
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

interface EventFiberNode {
  memoizedProps?: { event?: unknown } | null;
  return?: EventFiberNode | null;
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
  const fiberKey = findFiberKey(domNode);
  if (!fiberKey) return null;

  let fiber: EventFiberNode | null | undefined = (domNode as unknown as Record<string, EventFiberNode>)[fiberKey];
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const event = fiber.memoizedProps?.event;
    if (isPlanningEvent(event)) return event;
  }
  return null;
}

// --- Evaluation sheet helpers (MAIN world only, same reason as above) ---

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
// null when the student has no photo.
export interface ApiClientLike {
  unlabeled: {
    getAvatar: (login: string) => Promise<unknown>;
    getAvatarThumbnail: (login: string) => Promise<unknown>;
  };
}

export interface QueryClientLike {
  getQueryCache: () => {
    find: (filters: { queryKey: unknown[]; exact?: boolean }) => CachedQuery | undefined;
  };
}

interface ContextDependency {
  memoizedValue?: unknown;
  next?: ContextDependency | null;
}

interface GenericFiberNode {
  memoizedProps?: Record<string, unknown> | null;
  dependencies?: { firstContext?: ContextDependency | null } | null;
  return?: GenericFiberNode | null;
  child?: GenericFiberNode | null;
  sibling?: GenericFiberNode | null;
  stateNode?: unknown;
}

function fiberOf(domNode: Element): GenericFiberNode | null {
  const key = findFiberKey(domNode);
  return key ? (domNode as unknown as Record<string, GenericFiberNode>)[key] : null;
}

// Verified live: the QueryClientProvider (props.client) sits a few hundred
// fibers above the planning modal.
export function findQueryClient(domNode: Element, maxDepth = 1000): QueryClientLike | null {
  let fiber: GenericFiberNode | null | undefined = fiberOf(domNode);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    const client = fiber.memoizedProps?.client as { getQueryCache?: unknown } | undefined;
    if (client && typeof client.getQueryCache === 'function') return client as unknown as QueryClientLike;
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
  let fiber: GenericFiberNode | null | undefined = fiberOf(domNode);
  for (let depth = 0; fiber && depth <= maxDepth; depth++, fiber = fiber.return) {
    for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) {
      if (isApiClient(dep.memoizedValue)) return dep.memoizedValue;
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
  const stack: GenericFiberNode[] = [start];
  let visited = 0;
  while (stack.length && visited++ < maxNodes) {
    const fiber = stack.pop()!;
    const slots = fiber.memoizedProps?.slots;
    if (isEventSlotArray(slots)) {
      const hosts: Element[] = [];
      const hostStack: GenericFiberNode[] = fiber.child ? [fiber.child] : [];
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
