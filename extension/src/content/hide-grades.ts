// "Hide grades" toggle on a student's Competencies tab (#validations): marks
// every UE card's "Grade: X" badge and hides them via CSS while
// <html data-epitools-grades-hidden="on"> is set. The button is a deep clone
// of the site's "View skill details" button (classes only, no React fiber),
// inserted just left of it. State persists per browser in storage.local.
import browser from 'webextension-polyfill';
import { GRADES_HIDDEN_KEY } from '../types';

const GRADE_ATTR = 'data-epitools-grade';
const BUTTON_ATTR = 'data-epitools-grades-toggle';
// "Grade: C", or "in progress" in its place before grading. FR labels unverified (guessed).
const GRADE_LABEL = /^\s*((grade|note)\s*:|in progress\s*$|en cours\s*$)/i;
const CREDITS_LABEL = /^\s*\d+\s*cr[ée]dits?\s*$/i;

// Only badges inside a UE card (a button that also has a "N credits" badge).
function inUeCard(label: Element): boolean {
  const card = label.closest('button');
  return !!card && [...card.querySelectorAll('.mantine-Badge-label')].some((l) => CREDITS_LABEL.test(l.textContent ?? ''));
}

let hidden = false;

function setHidden(value: boolean): void {
  hidden = value;
  if (value) document.documentElement.dataset.epitoolsGradesHidden = 'on';
  else delete document.documentElement.dataset.epitoolsGradesHidden;
  document.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}] .mantine-Button-label`).forEach((l) => {
    l.textContent = value ? 'Show grades' : 'Hide grades';
  });
}

function check(): void {
  const badges: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>('.mantine-Badge-label').forEach((label) => {
    if (!GRADE_LABEL.test(label.textContent ?? '') || !inUeCard(label)) return;
    const root = label.closest<HTMLElement>('.mantine-Badge-root');
    if (!root) return;
    badges.push(root);
    if (!root.hasAttribute(GRADE_ATTR)) root.setAttribute(GRADE_ATTR, '');
  });

  const existing = document.querySelector(`[${BUTTON_ATTR}]`);
  if (badges.length === 0) {
    existing?.remove();
    return;
  }
  if (existing?.isConnected) return;

  // The tab header: an h2 Title next to a Group holding a subtle button + the semester Select.
  for (const title of document.querySelectorAll('h2.mantine-Title-root')) {
    const group = title.nextElementSibling;
    const native = group?.querySelector<HTMLButtonElement>(':scope > button[data-variant="subtle"]');
    if (!group || !native || !group.querySelector(':scope > .mantine-Select-root')) continue;
    const btn = native.cloneNode(true) as HTMLButtonElement;
    btn.setAttribute(BUTTON_ATTR, '');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      browser.storage.local.set({ [GRADES_HIDDEN_KEY]: !hidden }).catch(() => setHidden(!hidden));
    });
    group.insertBefore(btn, native);
    setHidden(hidden); // sets the label
    return;
  }
}

async function init(): Promise<void> {
  try {
    const stored = await browser.storage.local.get({ [GRADES_HIDDEN_KEY]: false });
    setHidden(stored[GRADES_HIDDEN_KEY] === true);
  } catch {
    return; // "Extension context invalidated" in a stale tab
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && GRADES_HIDDEN_KEY in changes) setHidden(changes[GRADES_HIDDEN_KEY].newValue === true);
  });

  // Throttle, not debounce: see CLAUDE.md (the site rewrites <style> tags constantly).
  let timer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      check();
    }, 200);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  check();
}

init();
