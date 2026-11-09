// Attendance button on the student Absences tab (content/absence-status.ts).
import { defineMessages } from './core';

export const t = defineMessages(
  {
    present: 'Present',
    absent: 'Absent',
    justified: 'Justified',
    markPresent: 'Mark present',
    markAbsent: 'Mark absent',
    justify: 'Justify absence',
    attendance: 'Attendance',
    graded: 'Graded activity: attendance cannot be changed here',
    gradedUnknown: 'Could not check whether this activity is graded',
    gradedChecking: 'Checking whether this activity is graded…',
    error: 'Error',
    unreadable: 'Could not read this absence from the page',
    updateFailed: 'Attendance update failed',
    viewOnPlanning: 'View on planning',
  },
  {
    present: 'Présent',
    absent: 'Absent',
    justified: 'Justifié',
    markPresent: 'Marquer présent',
    markAbsent: 'Marquer absent',
    justify: "Justifier l'absence",
    attendance: 'Présence',
    graded: 'Activité notée : la présence ne peut pas être modifiée ici',
    gradedUnknown: "Impossible de vérifier si cette activité est notée",
    gradedChecking: "Vérification de la notation de l'activité…",
    error: 'Erreur',
    unreadable: 'Impossible de lire cette absence sur la page',
    updateFailed: 'Échec de la mise à jour de la présence',
    viewOnPlanning: 'Voir dans le planning',
  },
);
