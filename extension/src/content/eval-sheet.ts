// Evaluation sheet, isolated-world half. The MAIN-world half
// (eval-sheet-page.ts) injects the buttons and reads the event, students and
// photos (as data: URLs) out of React state, then hands them over with
// window.postMessage. This side owns everything that needs extension APIs:
// the per-browser toggle (mirrored onto <html data-epitools-eval-sheet> so
// the MAIN world can see it), and building/downloading the PDF.
import browser from 'webextension-polyfill';
import { buildEvalSheetPdf, sheetFileName, type SheetStudent } from './eval-sheet-pdf';
import { openEvalSheetModal } from './eval-sheet-modal';
import { loadPresets } from './eval-sheet-presets';
import type { JpegImage } from './pdf';
import {
  EVAL_SHEET_ENABLED_KEY,
  EVAL_SHEET_ENABLED_DEFAULT,
  EVAL_SHEET_REQUEST,
  EVAL_SHEET_ACK,
  type EvalSheet,
  type EvalSheetLayout,
  type EvalSheetStudent,
} from '../types';

const PHOTO_PIXELS = 160;
const PHOTO_CONCURRENCY = 6;

function setEnabledFlag(enabled: boolean): void {
  if (enabled) document.documentElement.dataset.epitoolsEvalSheet = 'on';
  else delete document.documentElement.dataset.epitoolsEvalSheet;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

// Re-encodes any photo format to a square, center-cropped JPEG (the only
// image format the PDF writer embeds). Decoding from a data: URL keeps the
// canvas untainted. White background first, so transparent PNGs don't
// export as black.
async function toJpeg(dataUrl: string): Promise<JpegImage | null> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_PIXELS;
  canvas.height = PHOTO_PIXELS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PHOTO_PIXELS, PHOTO_PIXELS);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) return null;
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, PHOTO_PIXELS, PHOTO_PIXELS);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: PHOTO_PIXELS, height: PHOTO_PIXELS };
}

// Only image data: URLs are accepted: the URL arrives via a window.postMessage
// that page scripts could forge, and this must never load a remote resource.
async function loadPhoto(url: string | null): Promise<JpegImage | null> {
  if (!url || !url.startsWith('data:image/')) return null;
  try {
    return await toJpeg(url);
  } catch {
    return null;
  }
}

async function loadPhotos(students: EvalSheetStudent[]): Promise<(JpegImage | null)[]> {
  const results: (JpegImage | null)[] = new Array(students.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < students.length) {
      const i = next++;
      results[i] = await loadPhoto(students[i].photoUrl);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, students.length) }, worker));
  return results;
}

function downloadPdf(bytes: Uint8Array<ArrayBuffer>, fileName: string): void {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred: Firefox can still be reading the blob right after click().
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function isEvalSheet(value: unknown): value is EvalSheet {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<EvalSheet>;
  return (
    typeof v.activity === 'string' &&
    typeof v.unitCode === 'string' &&
    (v.location === undefined || typeof v.location === 'string') &&
    typeof v.start === 'string' &&
    typeof v.end === 'string' &&
    Array.isArray(v.students)
  );
}

function sortStudents(students: EvalSheetStudent[]): EvalSheetStudent[] {
  const collator = new Intl.Collator('fr', { sensitivity: 'base' });
  return [...students].sort(
    // Whole-event sheets of slot-based events: grouped by slot (in time
    // order), then by email within a slot.
    (a, b) =>
      (a.slotStart && b.slotStart ? Date.parse(a.slotStart) - Date.parse(b.slotStart) : 0) ||
      (a.slotEnd && b.slotEnd ? Date.parse(a.slotEnd) - Date.parse(b.slotEnd) : 0) ||
      collator.compare(a.email, b.email) ||
      collator.compare(a.lastname, b.lastname) ||
      collator.compare(a.firstname, b.firstname),
  );
}

async function generate(
  sheet: EvalSheet,
  students: EvalSheetStudent[],
  photos: Promise<(JpegImage | null)[]>,
  layout: EvalSheetLayout,
): Promise<void> {
  const loaded = await photos;
  const rows: SheetStudent[] = students.map((s, i) => ({
    firstname: s.firstname,
    lastname: s.lastname,
    email: s.email,
    photo: loaded[i],
    slot: s.slotStart && s.slotEnd ? { start: s.slotStart, end: s.slotEnd } : undefined,
  }));
  downloadPdf(buildEvalSheetPdf(sheet, rows, layout), sheetFileName(sheet));
}

// The options modal goes inside the intranet dialog holding the clicked
// button (see eval-sheet-modal.ts for why), found via the request id the
// MAIN-world script put on that button.
function modalMountPoint(requestId: string): Element {
  const trigger = Array.from(document.querySelectorAll<HTMLElement>('[data-epitools-request-id]')).find(
    (node) => node.dataset.epitoolsRequestId === requestId,
  );
  return trigger?.closest('[role=dialog]') ?? document.body;
}

async function handleRequest(requestId: string, sheet: EvalSheet): Promise<void> {
  const students = sortStudents(sheet.students);
  // Started right away so photos are usually ready by the time the user has
  // gone through the options modal.
  const photos = loadPhotos(students);
  photos.catch(() => {});
  const presets = await loadPresets();
  const withSlots = students.some((s) => s.slotStart && s.slotEnd);
  openEvalSheetModal(modalMountPoint(requestId), presets, withSlots, (layout) =>
    generate(sheet, students, photos, layout),
  );
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data as { source?: unknown; requestId?: unknown; sheet?: unknown } | null;
  if (!data || data.source !== EVAL_SHEET_REQUEST || typeof data.requestId !== 'string') return;
  if (document.documentElement.dataset.epitoolsEvalSheet !== 'on') return;
  const { requestId, sheet } = data;
  if (!isEvalSheet(sheet)) return; // no ack: the button shows "Échec"
  handleRequest(requestId, sheet).then(
    () => window.postMessage({ source: EVAL_SHEET_ACK, requestId }, location.origin),
    () => {}, // context invalidated (stale tab): no ack, the button shows "Échec"
  );
});

async function initFeatureToggle(): Promise<void> {
  let stored: Record<string, unknown>;
  try {
    stored = await browser.storage.local.get({ [EVAL_SHEET_ENABLED_KEY]: EVAL_SHEET_ENABLED_DEFAULT });
  } catch {
    // "Extension context invalidated" in a tab that wasn't refreshed after
    // an extension reload — see attendance.ts's initFeatureToggle.
    return;
  }
  setEnabledFlag(stored[EVAL_SHEET_ENABLED_KEY] === true);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(EVAL_SHEET_ENABLED_KEY in changes)) return;
    setEnabledFlag(changes[EVAL_SHEET_ENABLED_KEY].newValue === true);
  });
}

initFeatureToggle();
