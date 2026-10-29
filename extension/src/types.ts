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

// Attendance button on the student page's Absences tab — same storage.local
// reasoning. On by default (it only calls the site's own API client).
export const ABSENCE_STATUS_ENABLED_KEY = 'absenceStatusEnabled';
export const ABSENCE_STATUS_ENABLED_DEFAULT = true;

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
  | 'saveSettings'
  | 'intrastekMe'
  | 'intrastekStatus'
  | 'intrastekSet'
  | 'intrastekRemove'
  | 'intrastekApprove'
  | 'intrastekCancel';

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

// --- Intrastek (AER activity staffing, https://intrastek.epistone.fr) ---
// All in storage.local: the API key is a personal secret and must never be
// synced across browsers (storage.sync) nor reach the page's MAIN world.
// No key saved = the whole feature is off (no popup toggle on purpose).
export const INTRASTEK_API_URL_KEY = 'intrastekApiUrl';
export const INTRASTEK_API_URL_DEFAULT = 'https://api.intrastek.epistone.fr';
export const INTRASTEK_API_KEY_KEY = 'intrastekApiKey';
// Group targeted by the planning actions; '' / missing = the user's own group.
export const INTRASTEK_DEFAULT_GROUP_KEY = 'intrastekDefaultGroupId';
// "Intrastek mode" on the planning (block colours + right-click menu).
export const INTRASTEK_MODE_KEY = 'intrastekModeEnabled';

// Contract with the Intrastek API's /extension/* routes (X-Api-Key auth).
export type IntrastekScope = 'INTRANET_READ' | 'INTRANET_WRITE';
export type IntrastekProposalKind = 'INIT' | 'UPDATE' | 'REMOVE';
export type IntrastekProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type IntrastekActivityStatus = 'DRAFT' | 'SUBSCRIPTION' | 'ASSIGNMENT' | 'VALIDATED';

export interface IntrastekGroup {
  id: string;
  name: string;
}

export interface IntrastekMe {
  user: { id: string; firstName: string; lastName: string; email: string };
  isAdmin: boolean;
  scopes: IntrastekScope[];
  groups: IntrastekGroup[];
  defaultGroupId: string | null;
}

export interface IntrastekActivity {
  id: string;
  groupId: string;
  duplicateId: number;
  nbUserAsk: number;
  status: IntrastekActivityStatus;
  start: string;
  end: string;
  assignedCount: number;
  // The event this activity belongs to: another one when the event is merged
  // into the previous one of the same intranet activity (only that one can be
  // set; the API answers 409 on the others).
  headEventId: number;
}

export interface IntrastekProposal {
  id: string;
  // The event it was made on: the first one when this event is merged into it.
  eventId: number;
  kind: IntrastekProposalKind;
  status: IntrastekProposalStatus;
  groupId: string;
  nbUserAsk: number | null;
  proposedBy: { id: string; firstName: string; lastName: string };
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntrastekEventState {
  eventId: number;
  activities: IntrastekActivity[];
  proposals: IntrastekProposal[];
}

export interface IntrastekWriteResult {
  result: 'applied' | 'proposed';
  state: IntrastekEventState;
}

// Intrastek handlers never throw across runtime.sendMessage (only an
// Error's message would survive): they resolve this envelope so the UI can
// branch on the status (e.g. 409 -> "Remove anyway").
export type IntrastekResponse<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export interface IntrastekMePayload {
  // Options page "Test connection": try the form values before saving them.
  apiUrl?: string;
  apiKey?: string;
}
export interface IntrastekStatusPayload {
  eventIds: number[];
}
export interface IntrastekSetPayload {
  eventId: number;
  groupId: string;
  nbUserAsk: number;
}
export interface IntrastekRemovePayload {
  eventId: number;
  groupId: string;
  force?: boolean;
}
export interface IntrastekProposalPayload {
  proposalId: string;
  /** Approve only: apply a REMOVE proposal even when AERs are assigned (the API's 409). */
  force?: boolean;
}
