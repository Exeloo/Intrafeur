// "Mark remaining as present" button in the planning event modal's
// Attendances panel, placed right under the native "Mark remaining as
// absent": sets every student without a status (roll entry with no
// `status`, exactly the native button's filter) to present.
//
// Runs in the page's MAIN world: the roll and the site's own setAttendance
// mutation only exist in React fibers. We call that very mutation (a TanStack
// MutationObserver kept in the panel component's hooks), so the request and
// the refresh afterwards (roll + stats invalidation) are identical to the
// native button's. Verified live: the panel component has props
// {eventId, roll, isReadOnly, ...}, the native button's onClick opens a
// confirm whose i18n key is "mark remaining as absent".
//
// The button is a deep clone of the native one (classes/structure only;
// cloneNode carries no React fiber or listeners), recoloured green. A
// two-click confirm replaces the native Mantine confirm modal.
import { findFiberKey } from './fiber-extract';

const ATTR = 'data-epitools-mark-present';
const LABEL = 'Mark remaining as present';
const CONFIRM_MS = 4000;
const ERROR_MS = 2500;
// tabler user-check, same icon as the planning menu's "Mark present".
const ICON_PATHS = ['M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0', 'M6 21v-2a4 4 0 0 1 4 -4h4', 'M15 19l2 2l4 -4'];

interface Hook {
  memoizedState?: unknown;
  next?: Hook | null;
}

interface Fiber {
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: Hook | null;
  return?: Fiber | null;
}

interface SetAttendanceMutation {
  mutate: (variables: {
    eventId: number;
    dto: { records: { login: string; status: 'present' }[] };
  }) => Promise<unknown>;
}

interface Panel {
  eventId: number;
  remaining: string[];
  mutation: SetAttendanceMutation;
}

function fiberOf(el: Element): Fiber | null | undefined {
  const key = findFiberKey(el);
  return key ? (el as unknown as Record<string, Fiber>)[key] : null;
}

// Matched by the i18n key in its handler, which survives both minification
// and the French UI.
function isNativeButton(button: Element): boolean {
  let fiber = fiberOf(button);
  for (let depth = 0; fiber && depth < 5; depth++, fiber = fiber.return) {
    const onClick = fiber.memoizedProps?.onClick;
    if (typeof onClick === 'function') return String(onClick).includes('mark remaining as absent');
  }
  return false;
}

function findSetAttendance(fiber: Fiber): SetAttendanceMutation | null {
  for (let hook = fiber.memoizedState; hook; hook = hook.next) {
    const value = hook.memoizedState as { mutate?: unknown; options?: { mutationFn?: unknown } } | null;
    if (
      value &&
      typeof value === 'object' &&
      typeof value.mutate === 'function' &&
      String(value.options?.mutationFn).includes('setAttendance')
    ) {
      return value as SetAttendanceMutation;
    }
  }
  return null;
}

// Re-read on every use: the props are replaced on each render.
function readPanel(native: Element): Panel | null {
  let fiber = fiberOf(native);
  for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props && typeof props.eventId === 'number' && Array.isArray(props.roll)) {
      const mutation = findSetAttendance(fiber);
      if (!mutation) return null;
      const remaining = (props.roll as { login?: unknown; status?: unknown }[])
        .filter((e) => e && !e.status && typeof e.login === 'string')
        .map((e) => e.login as string);
      return { eventId: props.eventId, remaining, mutation };
    }
  }
  return null;
}

// --- Button ---

const armed = new WeakMap<HTMLButtonElement, number>();
const busy = new WeakSet<HTMLButtonElement>();
const errors = new WeakMap<HTMLButtonElement, string>();

function setLabel(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector('.mantine-Button-label');
  if (label && label.textContent !== text) label.textContent = text;
}

function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  if (button.disabled === disabled) return;
  button.disabled = disabled;
  if (disabled) button.setAttribute('data-disabled', 'true');
  else button.removeAttribute('data-disabled');
}

function render(button: HTMLButtonElement, native: Element): void {
  const panel = readPanel(native);
  const count = panel?.remaining.length ?? 0;
  const error = errors.get(button);
  if (error !== undefined) setLabel(button, 'Error');
  else if (busy.has(button)) setLabel(button, 'Marking…');
  else if (armed.has(button)) setLabel(button, `Confirm: mark ${count} as present`);
  else setLabel(button, LABEL);
  if (error !== undefined) button.title = error;
  else button.removeAttribute('title');
  setDisabled(button, busy.has(button) || count === 0);
}

function disarm(button: HTMLButtonElement): void {
  window.clearTimeout(armed.get(button));
  armed.delete(button);
}

async function onClick(button: HTMLButtonElement, native: Element): Promise<void> {
  if (busy.has(button)) return;
  const panel = readPanel(native);
  if (!panel || panel.remaining.length === 0) return;
  if (!armed.has(button)) {
    armed.set(
      button,
      window.setTimeout(() => {
        armed.delete(button);
        render(button, native);
      }, CONFIRM_MS),
    );
    render(button, native);
    return;
  }
  disarm(button);
  busy.add(button);
  render(button, native);
  try {
    await panel.mutation.mutate({
      eventId: panel.eventId,
      dto: { records: panel.remaining.map((login) => ({ login, status: 'present' })) },
    });
  } catch (err) {
    errors.set(button, err instanceof Error && err.message ? err.message : 'Attendance update failed');
    window.setTimeout(() => {
      errors.delete(button);
      render(button, native);
    }, ERROR_MS);
  }
  busy.delete(button);
  render(button, native);
}

function buildButton(native: HTMLButtonElement): HTMLButtonElement {
  const button = native.cloneNode(true) as HTMLButtonElement;
  button.setAttribute(ATTR, '');
  const style = button.getAttribute('style');
  if (style) button.setAttribute('style', style.replace(/--mantine-color-red-/g, '--mantine-color-green-'));
  const svg = button.querySelector('svg');
  if (svg) {
    svg.setAttribute('class', 'tabler-icon tabler-icon-user-check');
    svg.replaceChildren(
      ...ICON_PATHS.map((d) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        return path;
      }),
    );
  }
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    // The native button is read at click time: React may have replaced it.
    const current = button.previousElementSibling;
    if (current) void onClick(button, current);
  });
  return button;
}

function check(): void {
  // Orphans: React dropped the native button (e.g. read-only) but not ours.
  document.querySelectorAll<HTMLButtonElement>(`[${ATTR}]`).forEach((b) => {
    const prev = b.previousElementSibling;
    if (!prev || prev.hasAttribute(ATTR) || !isNativeButton(prev)) b.remove();
  });
  for (const native of Array.from(
    document.querySelectorAll<HTMLButtonElement>(`section[role=dialog] button.mantine-Button-root:not([${ATTR}])`),
  )) {
    if (!isNativeButton(native)) continue;
    let button = native.nextElementSibling as HTMLButtonElement | null;
    if (!button?.hasAttribute(ATTR)) {
      if (!readPanel(native)) continue;
      button = buildButton(native);
      native.after(button);
    }
    render(button, native);
  }
}

let checkTimer: number | undefined;

// Throttled, not debounced (see event-info.ts).
function scheduleCheck(): void {
  if (checkTimer !== undefined) return;
  checkTimer = window.setTimeout(() => {
    checkTimer = undefined;
    check();
  }, 150);
}

new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });
check();
