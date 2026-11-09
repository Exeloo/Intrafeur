// DOM helpers for the extension pages (popup, options, setup). The generic
// builders come from the content-script helpers (no browser.* in there).
import browser from 'webextension-polyfill';
import type { MessageType } from '../types';
import { currentLang } from '../i18n/core';
import { setBusy, el } from '../content/shared/ui';

export { el, button, errorText, armable, setBusy } from '../content/shared/ui';

export function send<T>(type: MessageType, payload?: unknown): Promise<T> {
  return browser.runtime.sendMessage({ type, payload }) as Promise<T>;
}

export function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export type StatusKind = 'error' | 'success' | 'loading' | '';

/** A live status line (`role=status`); fill it with `setStatus`. */
export function statusLine(): HTMLElement {
  const node = el('p', 'status');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  return node;
}

export function setStatus(node: HTMLElement, message: string, kind: StatusKind = ''): void {
  node.replaceChildren();
  node.className = `status${kind ? ` status--${kind}` : ''}`;
  if (kind === 'loading') node.appendChild(el('span', 'spinner'));
  if (message) node.appendChild(el('span', undefined, message));
}

/**
 * Runs `fn` with `btn` in a busy state. `fn` is called synchronously, so a
 * `permissions.request` at its start is still inside the user gesture.
 */
export function withBusy(btn: HTMLButtonElement, fn: () => Promise<unknown>): void {
  if (btn.disabled) return;
  const restore = setBusy(btn);
  fn()
    .catch((err) => console.error(err))
    .finally(restore);
}

type Translate = (key: never) => string;

/**
 * Fills `data-i18n` (textContent), `data-i18n-placeholder`, `-title` and
 * `-aria-label` from a dictionary, and sets `<html lang>`. `known` is the
 * dictionary's English object, used to warn about unknown keys.
 */
export function applyI18n(t: Translate, known: Record<string, string>, root: ParentNode = document): void {
  document.documentElement.lang = currentLang();
  const tr = (key: string): string | null => {
    if (!(key in known)) {
      console.warn(`[intrafeur] unknown i18n key: ${key}`);
      return null;
    }
    return (t as (k: string) => string)(key);
  };
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const text = tr(node.dataset.i18n || '');
    if (text !== null) node.textContent = text;
  }
  for (const [sel, data, attr] of [
    ['data-i18n-placeholder', 'i18nPlaceholder', 'placeholder'],
    ['data-i18n-title', 'i18nTitle', 'title'],
    ['data-i18n-aria-label', 'i18nAriaLabel', 'aria-label'],
  ] as const) {
    for (const node of Array.from(root.querySelectorAll<HTMLElement>(`[${sel}]`))) {
      const text = tr(node.dataset[data] || '');
      if (text !== null) node.setAttribute(attr, text);
    }
  }
}

let uid = 0;
/** Unique id for label/aria wiring. */
export function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Labelled form field: label, control, optional "Default: …" hint, optional
 * extra hint and an optional "Reset to default" button (`onReset`).
 */
export function field(opts: {
  label: string;
  control: HTMLElement;
  hint?: string | Node;
  defaultHint?: string;
  reset?: { label: string; onReset: () => void };
}): HTMLElement {
  const wrap = el('div', 'field');
  const id = opts.control.id || nextId('field');
  const target = opts.control.matches('input, select, textarea')
    ? opts.control
    : opts.control.querySelector<HTMLElement>('input, select, textarea');
  if (target && !target.id) target.id = id;
  const label = el('label', 'field-label', opts.label);
  if (target) label.htmlFor = target.id;
  wrap.appendChild(label);

  const row = el('div', 'field-row');
  row.appendChild(opts.control);
  if (opts.reset) {
    const resetBtn = el('button', 'btn btn--ghost btn--small', opts.reset.label);
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', opts.reset.onReset);
    row.appendChild(resetBtn);
  }
  wrap.appendChild(row);

  if (opts.defaultHint || opts.hint) {
    const hint = el('p', 'hint');
    hint.id = `${target?.id || id}-hint`;
    if (opts.defaultHint) hint.append(opts.defaultHint);
    if (opts.defaultHint && opts.hint) hint.append(' · ');
    if (opts.hint) hint.append(opts.hint);
    target?.setAttribute('aria-describedby', hint.id);
    wrap.appendChild(hint);
  }
  return wrap;
}

/** Password input with a "Show" checkbox next to it. */
export function secretInput(showLabel: string, placeholder = ''): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('div', 'secret');
  const input = el('input', 'input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = placeholder;
  const toggle = el('label', 'inline-check');
  const check = el('input');
  check.type = 'checkbox';
  check.addEventListener('change', () => (input.type = check.checked ? 'text' : 'password'));
  toggle.append(check, ` ${showLabel}`);
  wrap.append(input, toggle);
  return { wrap, input };
}

export function textInput(type: 'url' | 'text', placeholder = ''): HTMLInputElement {
  const input = el('input', 'input');
  input.type = type;
  input.placeholder = placeholder;
  input.spellcheck = false;
  return input;
}

/** Opens an options page sub-section in a new tab (openOptionsPage can't take a hash). */
export async function openOptionsSection(section: string): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(`options/options.html#${section}`) });
}
