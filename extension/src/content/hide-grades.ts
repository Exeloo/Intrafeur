// "Hide grades" toggle on a student's Competencies tab (#validations): marks
// every UE card's "Grade: X" badge and hides them via CSS while
// <html data-epitools-grades-hidden="on"> is set. The button is a deep clone
// of the site's "View skill details" button (classes only, no React fiber),
// inserted just left of it. The hidden state persists per browser in
// storage.local (`gradesHidden`); the whole feature is gated on FLAGS.hideGrades.
import browser from 'webextension-polyfill';
import { GRADES_HIDDEN_KEY } from '../types';
import { FLAGS } from '../settings';
import { t } from '../i18n/hide-grades';
import { watchDom } from './shared/dom-watch';
import { getLocal, onLocalChange, watchFlag } from './shared/ext-storage';

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
let enabled = false;
let stopDom: (() => void) | null = null;

// The CSS only hides while the feature is enabled too.
function render(): void {
  if (enabled && hidden) document.documentElement.dataset.epitoolsGradesHidden = 'on';
  else delete document.documentElement.dataset.epitoolsGradesHidden;
  document.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}] .mantine-Button-label`).forEach((l) => {
    l.textContent = hidden ? t('show') : t('hide');
  });
}

function setHidden(value: boolean): void {
  hidden = value;
  render();
}

function check(): void {
  let found = false;
  document.querySelectorAll<HTMLElement>('.mantine-Badge-label').forEach((label) => {
    if (!GRADE_LABEL.test(label.textContent ?? '') || !inUeCard(label)) return;
    const root = label.closest<HTMLElement>('.mantine-Badge-root');
    if (!root) return;
    found = true;
    if (!root.hasAttribute(GRADE_ATTR)) root.setAttribute(GRADE_ATTR, '');
  });

  const existing = document.querySelector(`[${BUTTON_ATTR}]`);
  if (!found) {
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
    render(); // sets the label
    return;
  }
}

function setEnabled(value: boolean): void {
  enabled = value;
  if (value) {
    // Throttled (see shared/dom-watch.ts); characterData: badge texts change in place.
    stopDom ??= watchDom(check, { delay: 200, characterData: true });
  } else {
    stopDom?.();
    stopDom = null;
    document.querySelector(`[${BUTTON_ATTR}]`)?.remove();
  }
  render();
}

export async function init(): Promise<void> {
  const stored = await getLocal({ [GRADES_HIDDEN_KEY]: false as unknown });
  if (!stored) return; // "Extension context invalidated" in a stale tab
  hidden = stored[GRADES_HIDDEN_KEY] === true;
  onLocalChange([GRADES_HIDDEN_KEY], (v) => setHidden(v[GRADES_HIDDEN_KEY] === true));
  await watchFlag(FLAGS.hideGrades, setEnabled);
}
