// Single registry of the per-browser feature toggles (all storage.local).
// Used by the popup / options / setup pages to render the feature list, by
// content scripts to read their toggle, and by content/shared/mirror.ts to
// copy the MAIN-world ones onto <html data-…="on"> (the MAIN world can't
// read extension storage). Add a feature here, not as a loose constant.
import {
  ABSENCE_STATUS_ENABLED_DEFAULT,
  ABSENCE_STATUS_ENABLED_KEY,
  EVAL_SHEET_ENABLED_DEFAULT,
  EVAL_SHEET_ENABLED_KEY,
  EVENT_INFO_ENABLED_DEFAULT,
  EVENT_INFO_ENABLED_KEY,
  FACTIONS_ENABLED_DEFAULT,
  FACTIONS_ENABLED_KEY,
  INTRASTEK_MODE_KEY,
  UNIT_FILTERS_ENABLED_DEFAULT,
  UNIT_FILTERS_ENABLED_KEY,
} from './types';

export interface FlagDef {
  /** storage.local key */
  key: string;
  default: boolean;
  /** <html> dataset property mirrored for MAIN-world scripts ("on" when enabled). */
  mirror?: string;
}

export const FLAGS = {
  factions: { key: FACTIONS_ENABLED_KEY, default: FACTIONS_ENABLED_DEFAULT },
  unitFilters: { key: UNIT_FILTERS_ENABLED_KEY, default: UNIT_FILTERS_ENABLED_DEFAULT },
  eventInfo: { key: EVENT_INFO_ENABLED_KEY, default: EVENT_INFO_ENABLED_DEFAULT, mirror: 'epitoolsEventInfo' },
  evalSheet: { key: EVAL_SHEET_ENABLED_KEY, default: EVAL_SHEET_ENABLED_DEFAULT, mirror: 'epitoolsEvalSheet' },
  absenceStatus: {
    key: ABSENCE_STATUS_ENABLED_KEY,
    default: ABSENCE_STATUS_ENABLED_DEFAULT,
    mirror: 'epitoolsAbsenceStatus',
  },
  studentUnits: { key: 'studentUnitsEnabled', default: true, mirror: 'epitoolsStudentUnits' },
  attendancePresent: { key: 'attendancePresentEnabled', default: true, mirror: 'epitoolsAttendancePresent' },
  hideGrades: { key: 'hideGradesEnabled', default: true },
  intrastekMode: { key: INTRASTEK_MODE_KEY, default: false },
} satisfies Record<string, FlagDef>;

export type FlagId = keyof typeof FLAGS;

/** Stored value, falling back to the flag's default when missing / not a boolean. */
export function flagValue(flag: FlagDef, stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : flag.default;
}

/** `{ key: default }` for every flag, ready for `storage.local.get`. */
export function flagDefaults(flags: FlagDef[] = Object.values(FLAGS)): Record<string, boolean> {
  return Object.fromEntries(flags.map((f) => [f.key, f.default]));
}

/** MAIN world: is this mirrored flag on? */
export function mirroredFlagOn(flag: FlagDef): boolean {
  return !!flag.mirror && document.documentElement.dataset[flag.mirror] === 'on';
}
