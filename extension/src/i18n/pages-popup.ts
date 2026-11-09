// Popup HTML strings (data-i18n). Shared strings are in pages.ts.
import { defineMessages } from './core';

export const popupEn = {
  popupTitle: 'Intrafeur',
  popupSubtitle: 'Features on this browser',
  popupSetup: 'Quick setup',
  popupSettings: 'All settings',
};

export const tPopup = defineMessages<keyof typeof popupEn>(popupEn, {
  popupTitle: 'Intrafeur',
  popupSubtitle: 'Fonctionnalités sur ce navigateur',
  popupSetup: 'Configuration rapide',
  popupSettings: 'Tous les réglages',
});
