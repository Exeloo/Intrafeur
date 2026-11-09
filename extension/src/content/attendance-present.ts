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
// two-click confirm replaces the native Mantine confirm modal. Toggle
// mirrored onto <html data-epitools-attendance-present="on"> (FLAGS.attendancePresent).
import { fiberOf, type Fiber } from './fiber-extract';
import { cloneButton, dialogs, setButtonLabel } from './shared/mantine';
import { datasetAttr, watchDom } from './shared/dom-watch';
import { FLAGS, mirroredFlagOn } from '../settings';
import { t } from '../i18n/attendance-present';

const ATTR = 'data-epitools-mark-present';
// Own armed-state logic rather than ui.armable: render() rewrites the label
// on every check and the confirm label carries the live count.
const CONFIRM_MS = 4000;
const ERROR_MS = 2500;
// tabler user-check, same icon as the planning menu's "Mark present".
const ICON_PATHS = ['M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0', 'M6 21v-2a4 4 0 0 1 4 -4h4', 'M15 19l2 2l4 -4'];

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

// Stringifying every dialog button's handler on every check adds up: cache
// the verdict per handler function (a re-render with a new closure re-checks).
const nativeHandlers = new WeakMap<object, boolean>();

// Matched by the i18n key in its handler, which survives both minification
// and the French UI.
function isNativeButton(button: Element): boolean {
  let fiber = fiberOf(button);
  for (let depth = 0; fiber && depth < 5; depth++, fiber = fiber.return) {
    const onClick = fiber.memoizedProps?.onClick;
    if (typeof onClick !== 'function') continue;
    let verdict = nativeHandlers.get(onClick);
    if (verdict === undefined) {
      verdict = String(onClick).includes('mark remaining as absent');
      nativeHandlers.set(onClick, verdict);
    }
    return verdict;
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
  const isBusy = busy.has(button);
  if (error !== undefined) setButtonLabel(button, t('error'));
  else if (isBusy) setButtonLabel(button, t('marking'));
  else if (armed.has(button)) setButtonLabel(button, t('confirm', { count }));
  else setButtonLabel(button, t('label'));
  if (error !== undefined) {
    if (button.title !== error) button.title = error;
  } else if (button.hasAttribute('title')) button.removeAttribute('title');
  setDisabled(button, isBusy || count === 0);
  // Spinner while the mutation runs (shared.css).
  if (button.classList.contains('epitools-busy') !== isBusy) {
    button.classList.toggle('epitools-busy', isBusy);
    if (isBusy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }
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
    errors.set(button, err instanceof Error && err.message ? err.message : t('failed'));
    window.setTimeout(() => {
      errors.delete(button);
      render(button, native);
    }, ERROR_MS);
  }
  busy.delete(button);
  render(button, native);
}

function buildButton(native: HTMLButtonElement): HTMLButtonElement {
  const button = cloneButton(native, ATTR, { paths: ICON_PATHS, name: 'user-check' });
  const style = button.getAttribute('style');
  if (style) button.setAttribute('style', style.replace(/--mantine-color-red-/g, '--mantine-color-green-'));
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    // The native button is read at click time: React may have replaced it.
    const current = button.previousElementSibling;
    if (current) void onClick(button, current);
  });
  return button;
}

function removeAll(): void {
  document.querySelectorAll(`[${ATTR}]`).forEach((b) => b.remove());
}

function check(): void {
  if (!mirroredFlagOn(FLAGS.attendancePresent)) {
    removeAll();
    return;
  }
  // Orphans: React dropped the native button (e.g. read-only) but not ours.
  document.querySelectorAll<HTMLButtonElement>(`[${ATTR}]`).forEach((b) => {
    const prev = b.previousElementSibling;
    if (!prev || prev.hasAttribute(ATTR) || !isNativeButton(prev)) b.remove();
  });
  for (const dialog of dialogs()) {
    for (const native of Array.from(
      dialog.querySelectorAll<HTMLButtonElement>(`button.mantine-Button-root:not([${ATTR}])`),
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
}

export function init(): void {
  // The popup toggle flips the mirrored attribute without any body mutation.
  watchDom(check, { htmlAttributes: [datasetAttr(FLAGS.attendancePresent.mirror)] });
}
