// DOM helpers shared by every content feature (both worlds: no browser.*).
// Styles for the generic classes (spinner, toast) are in content/shared.css.
import { defineMessages } from '../../i18n/core';

const t = defineMessages(
  { confirm: 'Confirm?', close: 'Close', loading: 'Loading…' },
  { confirm: 'Confirmer ?', close: 'Fermer', loading: 'Chargement…' },
);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(text: string, className = ''): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
}

export function errorText(err: unknown): string {
  return (err as Error)?.message || String(err);
}

/**
 * Two-click confirm instead of a blocking confirm(): the first click swaps the
 * label to `armedLabel` for `ms`, a second click within that window runs.
 * Returns a `disarm()` that restores the label. `setLabel` lets callers whose
 * button has inner markup (cloned Mantine buttons) write the label themselves.
 */
export function armable(
  btn: HTMLButtonElement,
  run: () => void,
  opts: { armedLabel?: string; ms?: number; setLabel?: (text: string) => void } = {},
): () => void {
  const ms = opts.ms ?? 4000;
  const setLabel = opts.setLabel ?? ((text: string) => (btn.textContent = text));
  let label = btn.textContent || '';
  let armedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    if (!armedUntil) return;
    armedUntil = 0;
    clearTimeout(timer);
    btn.removeAttribute('data-epitools-armed');
    setLabel(label);
  };
  btn.addEventListener('click', () => {
    if (Date.now() > armedUntil) {
      label = btn.textContent || label;
      armedUntil = Date.now() + ms;
      btn.setAttribute('data-epitools-armed', '');
      setLabel(opts.armedLabel ?? t('confirm'));
      timer = setTimeout(disarm, ms);
      return;
    }
    disarm();
    run();
  });
  return disarm;
}

/** Temporarily shows `text` on a button, then restores its previous label. */
export function flashLabel(btn: HTMLElement, text: string, ms = 1500, setLabel?: (text: string) => void): void {
  const write = setLabel ?? ((value: string) => (btn.textContent = value));
  const previous = btn.textContent || '';
  write(text);
  setTimeout(() => write(previous), ms);
}

/**
 * Escape handler for our popups mounted inside the intranet's Mantine dialog.
 * The dialog closes on Escape from a window capture listener registered when
 * it opens, i.e. before ours, so stopPropagation can't stop it; its only
 * opt-out is `data-mantine-stop-propagation="true"` on the event target
 * (verified live 2026-11). So pass the popup's `root`: it is made focusable
 * and every element focused inside it gets that attribute. Our own window
 * capture listener then closes the popup. Returns the remover.
 */
export function captureEscape(onEscape: () => void, root?: HTMLElement): () => void {
  if (root) {
    const mark = (node: EventTarget | null): void => {
      if (node instanceof HTMLElement && root.contains(node)) node.setAttribute(MANTINE_STOP, 'true');
    };
    if (root.tabIndex < 0 && !root.hasAttribute('tabindex')) root.tabIndex = -1; // a click on a blank area focuses the root, not the dialog
    mark(root);
    mark(document.activeElement);
    root.addEventListener('focusin', (ev) => mark(ev.target), true);
  }
  const handler = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    ev.preventDefault();
    onEscape();
  };
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}

const MANTINE_STOP = 'data-mantine-stop-propagation';

/** Small inline spinner (`.epitools-spinner`), optionally followed by a label. */
export function spinner(label?: string): HTMLElement {
  const wrap = el('span', 'epitools-loading');
  wrap.setAttribute('role', 'status');
  wrap.appendChild(el('span', 'epitools-spinner'));
  wrap.appendChild(el('span', 'epitools-loading-label', label ?? t('loading')));
  return wrap;
}

/** Puts a button in a busy state (spinner + disabled) and returns the restore function. */
export function setBusy(btn: HTMLButtonElement): () => void {
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('epitools-busy');
  return () => {
    btn.disabled = wasDisabled;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('epitools-busy');
  };
}

const TOAST_CLASS = 'epitools-toast';

/** Bottom-right toast; one at a time. `action` adds a button (toast lasts 10 s instead of 5 s). */
export function toast(
  message: string,
  kind: 'success' | 'error' | 'info' = 'info',
  action?: { label: string; run: () => void },
): void {
  for (const old of Array.from(document.querySelectorAll(`.${TOAST_CLASS}`))) old.remove();
  const node = el('div', `${TOAST_CLASS} ${TOAST_CLASS}--${kind}`);
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.appendChild(el('span', undefined, message));
  if (action) {
    const actionBtn = button(action.label, `${TOAST_CLASS}-action`);
    actionBtn.addEventListener('click', () => {
      node.remove();
      action.run();
    });
    node.appendChild(actionBtn);
  }
  const closeBtn = button('×', `${TOAST_CLASS}-close`);
  closeBtn.setAttribute('aria-label', t('close'));
  closeBtn.addEventListener('click', () => node.remove());
  node.appendChild(closeBtn);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), action ? 10000 : 5000);
}
