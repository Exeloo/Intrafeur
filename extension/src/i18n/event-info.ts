// Planning event modal "Copy info" button (content/event-info.ts). The
// copied %%% block itself is a machine-read format and is never translated.
import { defineMessages } from './core';

export const t = defineMessages(
  {
    copyInfo: 'Copy info',
    copyTitle: 'Copy a standardized description of this event (module, project, links)',
    copied: 'Copied!',
    copyFailed: 'Copy failed',
  },
  {
    copyInfo: 'Copier les infos',
    copyTitle: "Copier une description standardisée de l'événement (module, projet, liens)",
    copied: 'Copié !',
    copyFailed: 'Échec de la copie',
  },
);
