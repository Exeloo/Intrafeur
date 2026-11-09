import { defineMessages } from './core';

export const t = defineMessages(
  {
    defaultPreset: 'Default',
    saveFilter: 'Save filter',
    reset: 'Reset',
    resetTitle: 'Reset filters to the selected preset',
    applying: 'Applying saved filter…',
    clearBug: 'This site has a known bug clearing Semester/Campus filters: if results look wrong, reload the page.',
    applyFailed: 'Could not apply the filter preset: {error}',
    saveFailed: 'Could not save the filter preset: {error}',
    createNew: 'Create new',
    filterName: 'Filter name',
    override: 'Override "{name}"',
    nameRequired: 'Enter a name for this filter.',
    cancel: 'Cancel',
    save: 'Save',
  },
  {
    defaultPreset: 'Par défaut',
    saveFilter: 'Enregistrer le filtre',
    reset: 'Réinitialiser',
    resetTitle: 'Revenir aux filtres du préréglage sélectionné',
    applying: 'Application du filtre enregistré…',
    clearBug:
      "Le site a un bug connu quand on efface les filtres Semestre/Campus : si les résultats semblent faux, rechargez la page.",
    applyFailed: "Impossible d'appliquer le préréglage : {error}",
    saveFailed: "Impossible d'enregistrer le préréglage : {error}",
    createNew: 'Créer un nouveau filtre',
    filterName: 'Nom du filtre',
    override: 'Remplacer « {name} »',
    nameRequired: 'Donnez un nom à ce filtre.',
    cancel: 'Annuler',
    save: 'Enregistrer',
  },
);
