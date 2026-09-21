export interface Faction {
  id: number;
  name: string;
  color: string;
}

export interface AssignmentRow {
  student_email: string;
  faction_id: number | null;
}
