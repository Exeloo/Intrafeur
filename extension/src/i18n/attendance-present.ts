// "Mark remaining as present" in the planning Attendances panel (content/attendance-present.ts).
import { defineMessages } from './core';

export const t = defineMessages(
  {
    label: 'Mark remaining as present',
    confirm: 'Confirm: mark {count} as present',
    marking: 'Marking…',
    error: 'Error',
    failed: 'Attendance update failed',
  },
  {
    label: 'Marquer les restants présents',
    confirm: 'Confirmer : marquer {count} présent(s)',
    marking: 'Enregistrement…',
    error: 'Erreur',
    failed: 'Échec de la mise à jour de la présence',
  },
);
