// "Copy info" button in the planning's event-details modal: copies a
// standardized description of the event (module, project, type, intranet
// id + links) to the clipboard.
//
// Runs in the page's MAIN world (see the manifests' "world" key), not the
// usual isolated world: the project instance id only exists in React state,
// and React's fiber expandos on DOM nodes aren't visible from an isolated
// world. Consequently this script must not use browser.* APIs, and must not
// import webextension-polyfill. The per-browser toggle is mirrored onto
// <html data-epitools-event-info="on"> (FLAGS.eventInfo).
import { type PlanningEvent } from './fiber-extract';
import { dialogEvent, dialogs, findUnitLink, foldAccents, modalHeader } from './shared/mantine';
import { button as makeButton, flashLabel } from './shared/ui';
import { datasetAttr, watchDom } from './shared/dom-watch';
import { FLAGS, mirroredFlagOn } from '../settings';
import { t } from '../i18n/event-info';

const BUTTON_CLASS = 'epitools-copy-info-btn';

// Canonical event types, matched against the normalized (lowercased,
// non-alphanumerics stripped) segments of the event title. French aliases
// cover the localized titles we've seen elsewhere on the site.
const EVENT_TYPES: { type: string; prefixes: string[] }[] = [
  { type: 'bootstrap', prefixes: ['bootstrap'] },
  { type: 'follow-up', prefixes: ['followup', 'suivi'] },
  { type: 'kick-off', prefixes: ['kickoff'] },
  { type: 'defense', prefixes: ['defense', 'defence', 'soutenance'] },
  { type: 'review', prefixes: ['review'] },
  { type: 'keynote', prefixes: ['keynote'] },
  { type: 'stumper', prefixes: ['stumper'] },
  { type: 'permanence', prefixes: ['permanence'] },
];

function normalize(text: string): string {
  return foldAccents(text).replace(/[^a-z0-9]/g, '');
}

// "Kick-Off - C Pool Day 07" -> { type: 'kick-off', project: 'C Pool Day 07' }.
// Splits on " - " (with spaces) so hyphenated types like "Kick-Off" stay whole.
function parseTitle(title: string): { type: string; project: string } {
  const segments = title.split(' - ').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const norm = normalize(segments[i]);
    const match = EVENT_TYPES.find((e) => e.prefixes.some((p) => norm.startsWith(p)));
    if (match) {
      return { type: match.type, project: segments.filter((_, j) => j !== i).join(' - ') };
    }
  }
  return { type: '', project: title.trim() };
}

function buildDescription(event: PlanningEvent, unitPath: string): string {
  const { type, project } = parseTitle(event.fullTitle || event.activityName || '');
  const origin = location.origin;
  const modulePath = unitPath.split(/[?#]/)[0].replace(/\/+$/, '');

  const lines = [
    '%%%',
    'NB_ASTEKS=',
    `MODULE=${event.unitCode}`,
    `PROJECT=${project}`,
    `TYPE=${type}`,
    `INTRA=${event.id}`,
    '%%%',
    '',
    `Module: ${origin}${modulePath}`,
  ];
  if (event.projectInstanceId != null) {
    lines.push(`Project: ${origin}${modulePath}/projects/${event.projectInstanceId}`);
  }
  lines.push(`Activity: ${origin}/planning?eventId=${encodeURIComponent(String(event.id))}`);
  return `${lines.join('\n')}\n`;
}

function copyWithTextarea(text: string, container: Element): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  // Mantine's modal traps focus; appending inside the dialog keeps the
  // temporary textarea focusable.
  container.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

// execCommand first, synchronously inside the click handler (while the user
// gesture is still active): confirmed live that navigator.clipboard.writeText
// can stay pending forever (never resolving nor rejecting), which would leave
// the button stuck. The async API is only a fallback, and it's raced
// against a timeout.
async function copyText(text: string, container: Element): Promise<boolean> {
  if (copyWithTextarea(text, container)) return true;
  if (!navigator.clipboard) return false;
  const timeout = new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 1500));
  const write = navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
  return Promise.race([write, timeout]);
}

// Restarts from the base label so a double click can't make "Copied!" stick.
function feedback(button: HTMLButtonElement, text: string): void {
  button.textContent = t('copyInfo');
  flashLabel(button, text);
}

async function onCopyClick(button: HTMLButtonElement): Promise<void> {
  // Re-read on click rather than at injection time: React may reuse the same
  // modal DOM when the user opens another event.
  const dialog = button.closest('[role=dialog]');
  const unitLink = dialog ? findUnitLink(dialog) : null;
  const event = dialog ? dialogEvent(dialog) : null;
  if (!dialog || !unitLink || !event) {
    feedback(button, t('copyFailed'));
    return;
  }
  const ok = await copyText(buildDescription(event, unitLink.getAttribute('href') || ''), dialog);
  button.focus();
  feedback(button, ok ? t('copied') : t('copyFailed'));
}

function buildButton(): HTMLButtonElement {
  const button = makeButton(t('copyInfo'), BUTTON_CLASS);
  button.title = t('copyTitle');
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onCopyClick(button);
  });
  return button;
}

function check(): void {
  if (!mirroredFlagOn(FLAGS.eventInfo)) {
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((b) => b.remove());
    return;
  }
  for (const dialog of dialogs()) {
    const slot = modalHeader(dialog);
    if (!slot || slot.header.querySelector(`.${BUTTON_CLASS}`)) continue;
    if (!dialogEvent(dialog)) continue;
    slot.header.insertBefore(buildButton(), slot.close);
  }
}

export function init(): void {
  // The popup toggle flips the mirrored attribute without any body mutation.
  watchDom(check, { htmlAttributes: [datasetAttr(FLAGS.eventInfo.mirror)] });
}
