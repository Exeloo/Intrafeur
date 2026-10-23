// Layout of the handwritten evaluation sheet ("Fiche d'évaluation"). Every
// string that ends up in the PDF is French on purpose — the sheet is printed
// and filled in by hand, independently of the intranet's UI language.
//
// Two layouts, picked in the options modal:
// - portrait: Photo | Étudiant | <fields> | [Commentaire], ~10-12 rows/page;
// - landscape: Étudiant (photo on top, name + email below) | <fields> |
//   [Commentaire], exactly 4 rows per page, for roomier handwriting.
import {
  PdfDocument,
  A4_PORTRAIT,
  A4_LANDSCAPE,
  fitText,
  textWidth,
  type JpegImage,
  type PdfPage,
  type PageSize,
} from './pdf';
import type { EvalSheet, EvalSheetLayout, EvalSheetNoteField } from '../types';

export interface SheetStudent {
  firstname: string;
  lastname: string;
  email: string;
  photo: JpegImage | null;
  slot?: { start: string; end: string };
}

type Rgb = [number, number, number];

const MARGIN = 40;
const HEADER_ROW_HEIGHT = 22;
const BOTTOM_MARGIN = 44;
const MIN_FIELD_WIDTH = 50;
const MAX_FIELDS = 8;
const LANDSCAPE_ROWS_PER_PAGE = 4;
// Leftmost column on whole-event sheets of slot-based events: the slot's
// time, written vertically, merged over that slot's rows.
const SLOT_COL = 22;

const GRAY_TEXT: Rgb = [0.4, 0.4, 0.4];
const BORDER: Rgb = [0.6, 0.6, 0.6];
const HEADER_FILL: Rgb = [0.9, 0.9, 0.9];
const PLACEHOLDER_FILL: Rgb = [0.85, 0.85, 0.85];

interface Geometry {
  size: PageSize;
  landscape: boolean;
  contentWidth: number;
  slotCol: number; // 0 unless the sheet groups students by slot
  tableLeft: number; // left edge of the per-student columns (after the slot column)
  photoCol: number; // 0 in landscape: the photo lives in the student column
  studentCol: number;
  fieldCol: number;
  commentCol: number; // 0 when the comment column is off
  rowHeight: number;
  photoSize: number;
  firstTableTop: number;
  otherTableTop: number;
}

// Fixed per-orientation base widths; what's left ("avail") is shared by the
// notation fields and the comment column.
function baseColumns(
  orientation: EvalSheetLayout['orientation'],
  withSlots: boolean,
): {
  size: PageSize;
  slotCol: number;
  photoCol: number;
  studentCol: number;
  avail: number;
} {
  const size = orientation === 'landscape' ? A4_LANDSCAPE : A4_PORTRAIT;
  const slotCol = withSlots ? SLOT_COL : 0;
  const photoCol = orientation === 'landscape' ? 0 : 58;
  const studentCol = orientation === 'landscape' ? 150 : 165;
  return { size, slotCol, photoCol, studentCol, avail: size.width - MARGIN * 2 - slotCol - photoCol - studentCol };
}

// Shared with the options modal so it can't offer a combination the layout
// can't draw: each field column needs at least MIN_FIELD_WIDTH, and the
// comment column keeps at least 40% of the free width.
export function maxFields(layout: Pick<EvalSheetLayout, 'orientation' | 'comment'>, withSlots = false): number {
  const { avail } = baseColumns(layout.orientation, withSlots);
  return Math.min(MAX_FIELDS, Math.floor(((layout.comment ? 0.6 : 1) * avail) / MIN_FIELD_WIDTH));
}

function geometry(layout: EvalSheetLayout, withSlots: boolean): Geometry {
  const base = baseColumns(layout.orientation, withSlots);
  const n = layout.fields.length;
  let studentCol = base.studentCol;
  let fieldCol = 0;
  let commentCol = 0;
  const landscape = layout.orientation === 'landscape';
  if (layout.comment) {
    // Landscape keeps score columns narrow so the comment area gets the room.
    fieldCol = n ? Math.min(landscape ? 64 : 80, (0.6 * base.avail) / n) : 0;
    commentCol = base.avail - n * fieldCol;
  } else {
    fieldCol = n ? Math.min(110, base.avail / n) : 0;
    studentCol += base.avail - n * fieldCol;
  }
  const firstTableTop = landscape ? (layout.minimalHeader ? 50 : 76) : layout.minimalHeader ? 84 : 195;
  return {
    size: base.size,
    landscape,
    contentWidth: base.size.width - MARGIN * 2,
    slotCol: base.slotCol,
    tableLeft: MARGIN + base.slotCol,
    photoCol: base.photoCol,
    studentCol,
    fieldCol,
    commentCol,
    // Landscape: 4 rows filling the first page below the header (the
    // minimal header leaves taller rows).
    rowHeight: landscape ? Math.floor((base.size.height - BOTTOM_MARGIN - firstTableTop - HEADER_ROW_HEIGHT) / 4) : 58,
    photoSize: landscape ? 56 : 46,
    firstTableTop,
    otherTableTop: landscape ? 46 : 62,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Browser time zone on purpose: it's what the planning modal shows.
export function formatDay(iso: string): string {
  const date = new Date(iso);
  return capitalize(
    new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date),
  );
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}h${String(date.getMinutes()).padStart(2, '0')}`;
}

export function sheetFileName(sheet: EvalSheet): string {
  const d = new Date(sheet.start);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const code = (sheet.unitCode || 'module').replace(/[^A-Za-z0-9_-]+/g, '-');
  return `fiche-evaluation_${code}_${day}_${formatTime(sheet.start)}.pdf`;
}

function labelValue(
  page: PdfPage,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
  size = 11,
  labelWidth = 118,
): void {
  page.text(label, x, y, { font: 'bold', size });
  page.text(fitText(value, 'regular', size, width - labelWidth), x + labelWidth, y, { size });
}

// Left edges of every column, relative to MARGIN.
function columnEdges(g: Geometry, fields: EvalSheetNoteField[]): {
  student: number;
  fields: number[];
  comment: number;
} {
  const student = g.photoCol;
  const firstField = student + g.studentCol;
  return {
    student,
    fields: fields.map((_, i) => firstField + i * g.fieldCol),
    comment: firstField + fields.length * g.fieldCol,
  };
}

function drawTableHeader(page: PdfPage, g: Geometry, layout: EvalSheetLayout, top: number): void {
  page.rect(MARGIN, top, g.contentWidth, HEADER_ROW_HEIGHT, { fill: HEADER_FILL, stroke: BORDER });
  if (g.slotCol) page.line(g.tableLeft, top, g.tableLeft, top + HEADER_ROW_HEIGHT, BORDER);
  const y = top + 15;
  const opts = { font: 'bold' as const, size: 10 };
  const edges = columnEdges(g, layout.fields);
  const left = g.tableLeft;
  if (g.photoCol) page.text('Photo', left + g.photoCol / 2, y, { ...opts, align: 'center' });
  if (g.landscape) {
    page.text('Étudiant', left + edges.student + g.studentCol / 2, y, { ...opts, align: 'center' });
  } else {
    page.text('Étudiant', left + edges.student + 8, y, opts);
  }
  // Narrow columns: shrink the labels (all together, so they match) before
  // resorting to an ellipsis.
  const width = g.fieldCol - 6;
  const size = layout.fields.every((f) => textWidth(f.label, 'bold', 10) <= width) ? 10 : 8;
  layout.fields.forEach((field, i) => {
    page.text(fitText(field.label, 'bold', size, width), left + edges.fields[i] + g.fieldCol / 2, y, {
      font: 'bold',
      size,
      align: 'center',
    });
  });
  if (g.commentCol) {
    page.text('Commentaire', left + edges.comment + g.commentCol / 2, y, { ...opts, align: 'center' });
  }
}

function initials(student: SheetStudent): string {
  const first = Array.from(student.firstname.trim())[0] || '';
  const last = Array.from(student.lastname.trim())[0] || '';
  return (first + last).toUpperCase() || '?';
}

function drawPhoto(page: PdfPage, student: SheetStudent, x: number, y: number, size: number): void {
  if (student.photo) {
    page.image(student.photo, x, y, size, size);
    return;
  }
  page.rect(x, y, size, size, { fill: PLACEHOLDER_FILL });
  const fontSize = size > 50 ? 18 : 14;
  page.text(initials(student), x + size / 2, y + size / 2 + fontSize * 0.35, {
    font: 'bold',
    size: fontSize,
    color: GRAY_TEXT,
    align: 'center',
  });
}

function drawScoreBox(page: PdfPage, g: Geometry, field: EvalSheetNoteField, cellLeft: number, rowTop: number): void {
  const boxWidth = Math.min(60, g.fieldCol - 12);
  const boxHeight = 30;
  const x = cellLeft + (g.fieldCol - boxWidth) / 2;
  const y = rowTop + (g.rowHeight - boxHeight) / 2;
  page.rect(x, y, boxWidth, boxHeight, { stroke: [0.2, 0.2, 0.2] });
  page.text(`/ ${field.max}`, x + boxWidth - 5, y + boxHeight / 2 + 4, { size: 11, align: 'right' });
}

function drawRow(page: PdfPage, g: Geometry, layout: EvalSheetLayout, student: SheetStudent, top: number): void {
  const edges = columnEdges(g, layout.fields);
  const left = g.tableLeft;
  page.rect(left, top, g.contentWidth - g.slotCol, g.rowHeight, { stroke: BORDER });
  const separators = [...(g.photoCol ? [g.photoCol] : []), ...edges.fields, ...(g.commentCol ? [edges.comment] : [])];
  for (const x of separators) page.line(left + x, top, left + x, top + g.rowHeight, BORDER);

  const name = `${student.firstname} ${student.lastname}`.trim() || student.email;
  if (g.landscape) {
    // Photo on top, name and email underneath, the block centered in the cell.
    const center = left + edges.student + g.studentCol / 2;
    const textWidth = g.studentCol - 12;
    const blockTop = top + (g.rowHeight - (g.photoSize + 38)) / 2;
    drawPhoto(page, student, center - g.photoSize / 2, blockTop, g.photoSize);
    page.text(fitText(name, 'bold', 10, textWidth), center, blockTop + g.photoSize + 14, {
      font: 'bold',
      size: 10,
      align: 'center',
    });
    page.text(fitText(student.email, 'regular', 8.5, textWidth), center, blockTop + g.photoSize + 27, {
      size: 8.5,
      color: GRAY_TEXT,
      align: 'center',
    });
  } else {
    drawPhoto(
      page,
      student,
      left + (g.photoCol - g.photoSize) / 2,
      top + (g.rowHeight - g.photoSize) / 2,
      g.photoSize,
    );
    const textX = left + edges.student + 8;
    const textWidth = g.studentCol - 16;
    page.text(fitText(name, 'bold', 11, textWidth), textX, top + 25, { font: 'bold', size: 11 });
    page.text(fitText(student.email, 'regular', 9, textWidth), textX, top + 40, { size: 9, color: GRAY_TEXT });
  }

  layout.fields.forEach((field, i) => drawScoreBox(page, g, field, left + edges.fields[i], top));
}

// One merged cell per run of consecutive rows from the same slot on a page,
// with the slot's time written bottom-to-top, centered. Falls back to the
// start time alone when the range doesn't fit the cell's height.
function drawSlotCell(page: PdfPage, slot: { start: string; end: string }, top: number, bottom: number): void {
  page.rect(MARGIN, top, SLOT_COL, bottom - top, { stroke: BORDER });
  const room = bottom - top - 6;
  const full = `${formatTime(slot.start)} – ${formatTime(slot.end)}`;
  let size = 8;
  let label = full;
  if (textWidth(full, 'bold', 8) > room) {
    if (textWidth(full, 'bold', 7) <= room) size = 7;
    else label = fitText(formatTime(slot.start), 'bold', size, room);
  }
  const width = textWidth(label, 'bold', size);
  page.text(label, MARGIN + SLOT_COL / 2 + size * 0.35, (top + bottom) / 2 + width / 2, {
    font: 'bold',
    size,
    rotate90: true,
  });
}

function drawPortraitHeader(page: PdfPage, g: Geometry, info: SheetInfo): void {
  const w = g.contentWidth;
  page.text("Fiche d'évaluation", MARGIN, 58, { font: 'bold', size: 20 });
  labelValue(page, 'Activité :', info.activity, MARGIN, 88, w);
  labelValue(page, 'Module :', info.module, MARGIN, 105, w);
  labelValue(page, 'Lieu :', info.location, MARGIN, 122, w);
  labelValue(page, 'Date :', info.day, MARGIN, 139, w);
  labelValue(page, 'Horaire :', info.hours, MARGIN, 156, w);
  labelValue(page, 'Étudiants inscrits :', info.count, MARGIN, 173, w);
}

// Compact header (small title, three 9pt columns of two lines) so the 4
// rows per page get as much height as possible for handwritten comments.
function drawLandscapeHeader(page: PdfPage, g: Geometry, info: SheetInfo): void {
  const size = 9;
  const third = g.contentWidth / 3;
  const width = third - 10;
  const cols = [MARGIN, MARGIN + third, MARGIN + third * 2];
  page.text("Fiche d'évaluation", MARGIN, 36, { font: 'bold', size: 14 });
  labelValue(page, 'Activité :', info.activity, cols[0], 54, width, size, 50);
  labelValue(page, 'Module :', info.module, cols[0], 66, width, size, 50);
  labelValue(page, 'Lieu :', info.location, cols[1], 54, width, size, 36);
  labelValue(page, 'Date :', info.day, cols[1], 66, width, size, 36);
  labelValue(page, 'Horaire :', info.hours, cols[2], 54, width, size, 88);
  labelValue(page, 'Étudiants inscrits :', info.count, cols[2], 66, width, size, 88);
}

// "Module" and "Date" only (date and time on one line), when the user picked
// the reduced header.
function drawMinimalHeader(page: PdfPage, g: Geometry, info: SheetInfo): void {
  const when = `${info.day}, ${info.hours}`;
  if (g.landscape) {
    const half = g.contentWidth / 2;
    labelValue(page, 'Module :', info.module, MARGIN, 38, half - 10, 9, 46);
    labelValue(page, 'Date :', when, MARGIN + half, 38, half - 10, 9, 34);
    return;
  }
  labelValue(page, 'Module :', info.module, MARGIN, 50, g.contentWidth, 11, 62);
  labelValue(page, 'Date :', when, MARGIN, 67, g.contentWidth, 11, 62);
}

interface SheetInfo {
  activity: string;
  module: string;
  location: string;
  day: string;
  hours: string;
  count: string;
}

export function buildEvalSheetPdf(
  sheet: EvalSheet,
  students: SheetStudent[],
  layout: EvalSheetLayout,
): Uint8Array<ArrayBuffer> {
  const g = geometry(
    layout,
    students.some((s) => s.slot),
  );
  const doc = new PdfDocument(g.size);
  const info: SheetInfo = {
    activity: sheet.activity,
    module: sheet.unitName ? `${sheet.unitCode} – ${sheet.unitName}` : sheet.unitCode,
    location: sheet.location || 'Non précisé',
    day: formatDay(sheet.start),
    hours: `${formatTime(sheet.start)} – ${formatTime(sheet.end)}`,
    count: String(students.length),
  };
  const bottomLimit = g.size.height - BOTTOM_MARGIN;

  let page = doc.addPage();
  if (layout.minimalHeader) drawMinimalHeader(page, g, info);
  else if (g.landscape) drawLandscapeHeader(page, g, info);
  else drawPortraitHeader(page, g, info);

  let top = g.firstTableTop;
  drawTableHeader(page, g, layout, top);
  top += HEADER_ROW_HEIGHT;
  let rowsOnPage = 0;
  // Current run of rows sharing a slot on this page (whole-event sheets).
  let run: { key: string; slot: { start: string; end: string }; top: number } | null = null;
  const flushRun = (): void => {
    if (run) drawSlotCell(page, run.slot, run.top, top);
    run = null;
  };

  const slotKeyOf = (s: SheetStudent): string => (s.slot ? `${s.slot.start}|${s.slot.end}` : '');
  // Size of the slot group starting at each index (students are sorted by
  // slot, so a group is a run of equal keys).
  const groupSizeAt = new Map<number, number>();
  for (let i = 0; i < students.length; ) {
    let j = i;
    while (j < students.length && slotKeyOf(students[j]) === slotKeyOf(students[i])) j++;
    groupSizeAt.set(i, j - i);
    i = j;
  }

  for (const [index, student] of students.entries()) {
    let pageFull = g.landscape ? rowsOnPage >= LANDSCAPE_ROWS_PER_PAGE : top + g.rowHeight > bottomLimit;
    // Landscape: don't split a slot across pages when it can fit whole on
    // the next one — start it on a fresh page instead.
    const groupSize = g.slotCol ? groupSizeAt.get(index) : undefined;
    if (
      g.landscape &&
      groupSize !== undefined &&
      rowsOnPage > 0 &&
      groupSize <= LANDSCAPE_ROWS_PER_PAGE &&
      rowsOnPage + groupSize > LANDSCAPE_ROWS_PER_PAGE
    ) {
      pageFull = true;
    }
    if (pageFull) {
      flushRun();
      page = doc.addPage();
      const running = `${layout.minimalHeader ? info.module : info.activity} – ${info.day}, ${info.hours}`;
      page.text(fitText(running, 'regular', 9, g.contentWidth), MARGIN, g.otherTableTop - 14, {
        size: 9,
        color: GRAY_TEXT,
      });
      top = g.otherTableTop;
      drawTableHeader(page, g, layout, top);
      top += HEADER_ROW_HEIGHT;
      rowsOnPage = 0;
    }
    if (g.slotCol) {
      const key = student.slot ? `${student.slot.start}|${student.slot.end}` : '';
      if (!run || run.key !== key) {
        flushRun();
        if (student.slot) run = { key, slot: student.slot, top };
      }
    }
    drawRow(page, g, layout, student, top);
    top += g.rowHeight;
    rowsOnPage++;
  }
  flushRun();

  if (students.length === 0) {
    page.text('Aucun étudiant inscrit.', MARGIN, top + 24, { size: 11, color: GRAY_TEXT });
  }

  const total = doc.pages.length;
  doc.pages.forEach((p, i) => {
    p.text(`Page ${i + 1} / ${total}`, g.size.width / 2, g.size.height - 24, {
      size: 8,
      color: GRAY_TEXT,
      align: 'center',
    });
  });

  return doc.build();
}
