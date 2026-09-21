export interface Faction {
  id: number;
  name: string;
  color: string;
}

export interface Settings {
  apiBaseUrl: string;
  apiToken: string;
}

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
