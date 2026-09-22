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
