export interface Faction {
  id: number;
  name: string;
  color: string;
}

export interface Settings {
  apiBaseUrl: string;
  apiToken: string;
}

// storage.local (not .sync, deliberately) — a per-browser UI preference,
// not shared/synced faction data. Read directly by the content script and
// written directly by the popup; no background-script round-trip needed
// since both contexts already have the "storage" permission.
export const FACTIONS_ENABLED_KEY = 'factionsEnabled';
export const FACTIONS_ENABLED_DEFAULT = true;

// Evaluation sheet (PDF) toggle — same storage.local reasoning as above.
// Off by default.
export const EVAL_SHEET_ENABLED_KEY = 'evalSheetEnabled';
export const EVAL_SHEET_ENABLED_DEFAULT = false;

// Event "Copy info" button toggle — same storage.local reasoning. On by
// default (the feature needs no extra permission).
export const EVENT_INFO_ENABLED_KEY = 'eventInfoEnabled';
export const EVENT_INFO_ENABLED_DEFAULT = true;

// Units page filter presets toggle — same storage.local reasoning. On by
// default (purely local feature, no permission needed).
export const UNIT_FILTERS_ENABLED_KEY = 'unitFiltersEnabled';
export const UNIT_FILTERS_ENABLED_DEFAULT = true;

export type AssignmentsMap = Record<string, number>;

export interface RowMeta {
  email: string;
  fullName: string;
  factionId: number | null;
  factionName: string;
}

export type MessageType =
  | 'getFactions'
  | 'getAssignments'
  | 'setAssignment'
  | 'saveFaction'
  | 'updateFaction'
  | 'deleteFaction'
  | 'getSettings'
  | 'saveSettings';

export interface Message<P = unknown> {
  type: MessageType;
  payload?: P;
}

export interface SetAssignmentPayload {
  email: string;
  factionId: number | null;
}

export interface SaveFactionPayload {
  name: string;
  color: string;
}

export interface UpdateFactionPayload {
  id: number;
  name?: string;
  color?: string;
}

export interface DeleteFactionPayload {
  id: number;
}

// Evaluation sheet data, posted from the MAIN-world script (which can read
// React state) to the isolated-world one (which builds the PDF). Plain JSON so it survives postMessage cloning.
export interface EvalSheetStudent {
  firstname: string;
  lastname: string;
  email: string;
  photoUrl: string | null; // data:image/... URL, null when unknown
  // Set on whole-event sheets of slot-based events: the student's slot.
  slotStart?: string;
  slotEnd?: string;
}

export interface EvalSheet {
  activity: string;
  unitCode: string;
  unitName: string;
  location: string; // room name(s), '' when the event has none
  start: string; // ISO
  end: string; // ISO
  students: EvalSheetStudent[];
}

export const EVAL_SHEET_REQUEST = 'epitools-eval-sheet';
// Isolated script -> MAIN: "request received, the options modal is open".
// From then on progress/errors are shown in that modal, not on the button.
export const EVAL_SHEET_ACK = 'epitools-eval-sheet-ack';

// What the user picks in the options modal; saved as named presets in
// storage.local, same model as the units-page filter presets.
export interface EvalSheetNoteField {
  label: string;
  max: number;
}

export interface EvalSheetLayout {
  orientation: 'portrait' | 'landscape';
  comment: boolean;
  // true = header reduced to module + date/time (no title, activity,
  // location or student count).
  minimalHeader: boolean;
  fields: EvalSheetNoteField[];
}

export interface EvalSheetPreset {
  id: string;
  name: string;
  layout: EvalSheetLayout;
}

export const EVAL_SHEET_PRESETS_KEY = 'evalSheetPresets';
export const EVAL_SHEET_SELECTED_KEY = 'evalSheetSelectedPresetId';

// Synthesized, never stored — can't be overwritten or deleted by construction.
export const EVAL_SHEET_DEFAULT_PRESET_ID = '__default__';
export const EVAL_SHEET_DEFAULT_PRESET_NAME = 'Défaut';
export const EVAL_SHEET_DEFAULT_LAYOUT: EvalSheetLayout = {
  orientation: 'portrait',
  comment: true,
  minimalHeader: false,
  fields: [
    { label: 'Participation', max: 5 },
    { label: 'Acquisition', max: 5 },
  ],
};

// Units page ("/units/my") filter presets — storage.local, per-browser only,
// same reasoning as FACTIONS_ENABLED_KEY (no backend involvement at all).
// null on a column = "not managed by this preset" (left untouched on apply,
// excluded from the differs-from-selected diff); '' = "explicitly cleared";
// any other string = the captured raw value (typed text, or a combobox's
// exact visible label — see unit-filters-dom.ts for why the label and not
// the underlying option id is what gets persisted).
export interface UnitFilterColumns {
  name: string | null;
  semester: string | null;
  campus: string | null;
  startDate: string | null;
  endDate: string | null;
  registrations: string | null;
}

export interface UnitFilterPreset {
  id: string;
  name: string;
  columns: UnitFilterColumns;
}

export const UNIT_FILTER_PRESETS_KEY = 'unitFilterPresets';
export const UNIT_FILTER_SELECTED_KEY = 'unitFilterSelectedPresetId';

// Synthesized, never written to storage.local — makes "the Default preset
// can't be overridden" true by construction rather than a runtime check
// elsewhere that could regress.
export const UNIT_FILTER_DEFAULT_PRESET_ID = '__default__';
export const UNIT_FILTER_DEFAULT_PRESET_NAME = 'Default';
export const UNIT_FILTER_DEFAULT_COLUMNS: UnitFilterColumns = {
  name: '',
  semester: '',
  campus: '',
  startDate: '',
  endDate: '',
  registrations: '',
};
