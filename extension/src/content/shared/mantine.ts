// MAIN-world helpers around the intranet's Mantine markup: the planning
// event dialog, cloned native buttons and tabler icons. No browser.* here.
import { extractPlanningEvent, type PlanningEvent } from '../fiber-extract';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Lowercase without diacritics ("Défense" -> "defense"). */
export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Every open Mantine modal (the planning event modal is one of them). */
export function dialogs(): Element[] {
  return Array.from(document.querySelectorAll('section[role=dialog]'));
}

export function findUnitLink(dialog: Element): HTMLAnchorElement | null {
  return dialog.querySelector<HTMLAnchorElement>('a[href^="/units/"]');
}

// The planning event modal is recognised by its unit link, whose fibers lead
// to the event record. Re-read each time: React may reuse the modal DOM for
// another event.
export function dialogEvent(dialog: Element): PlanningEvent | null {
  const unitLink = findUnitLink(dialog);
  return unitLink ? extractPlanningEvent(unitLink) : null;
}

/** The modal's × and the header row holding it (where our buttons go). */
export function modalHeader(dialog: Element): { close: HTMLElement; header: HTMLElement } | null {
  const close = dialog.querySelector<HTMLElement>('.mantine-Modal-close');
  const header = close?.parentElement;
  return close && header ? { close, header } : null;
}

/** Writes a cloned Mantine button's label, only when it changed (no self-triggered mutations). */
export function setButtonLabel(button: Element, text: string, selector = '.mantine-Button-label'): void {
  const label = button.querySelector(selector);
  if (label && label.textContent !== text) label.textContent = text;
}

function pathsOf(paths: string[]): SVGPathElement[] {
  return paths.map((d) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    return path;
  });
}

/** Swaps a (cloned) tabler icon's paths, and its class when `name` is given. */
export function setIcon(svg: Element, paths: string[], name?: string): void {
  if (name) svg.setAttribute('class', `tabler-icon tabler-icon-${name}`);
  svg.replaceChildren(...pathsOf(paths));
}

/** A 16px tabler icon. */
export function svgIcon(stroke: string, name: string, paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [attr, value] of Object.entries({
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke,
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: `tabler-icon tabler-icon-${name}`,
  })) {
    svg.setAttribute(attr, value);
  }
  svg.append(...pathsOf(paths));
  return svg;
}

/**
 * Deep clone of a native button (classes/structure only: cloneNode carries
 * no React fiber or listeners), marked with `attr`, its icon optionally
 * swapped. Callers set the label and their own listener.
 */
export function cloneButton<T extends HTMLElement>(
  native: T,
  attr: string,
  icon?: { paths: string[]; name?: string },
): T {
  const clone = native.cloneNode(true) as T;
  clone.setAttribute(attr, '');
  const svg = clone.querySelector('svg');
  if (icon && svg) setIcon(svg, icon.paths, icon.name);
  return clone;
}
