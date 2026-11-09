// Error messages built by the background (shown by the content scripts and the options page).
import { defineMessages } from './core';

export const t = defineMessages(
  {
    notConfigured: 'Intrafeur is not configured yet: open the extension options and set the API URL.',
    noToken:
      'Intrafeur has no API token saved on this browser: open the extension options, paste the shared token in, and click Save.',
    invalidApiUrl: 'Invalid Intrafeur API URL: {url}',
    notGranted:
      'This browser has not granted Intrafeur access to {origin}: open the extension options and click Save connection again to re-request it.',
    unreachable: "Can't reach the Intrafeur backend at {origin}: {error}",
    requestFailed: 'API request failed ({status}): {body}',
    unknownMessage: 'Unknown message type: {type}',
    ikInvalidKey: 'Invalid or expired Intrastek key',
    ikDisabled: 'Intrastek extension feature is disabled by an admin',
    ikNoIntranet: "Intrastek can't reach the intranet",
    ikRequestFailed: 'Intrastek request failed ({status})',
    ikNoKey: 'No Intrastek key saved: open the extension options to set one.',
    ikInvalidUrl: 'Invalid Intrastek API URL: {url}',
    ikNotGranted:
      'This browser has not granted Intrafeur access to {origin}: open the extension options and click Save in the Intrastek section.',
    ikUnreachable: "Can't reach Intrastek at {origin}: {error}",
    ikInvalidEventId: 'Invalid intranet event id',
    ikInvalidEventIds: 'Invalid event ids',
    ikInvalidGroupId: 'Invalid group id',
    ikInvalidProposalId: 'Invalid proposal id',
    ikInvalidAers: 'AERs needed must be a whole number ≥ 0',
  },
  {
    notConfigured: "Intrafeur n'est pas encore configuré : ouvrez les options de l'extension et renseignez l'URL de l'API.",
    noToken:
      "Aucun jeton d'API Intrafeur n'est enregistré sur ce navigateur : ouvrez les options de l'extension, collez le jeton partagé puis cliquez sur Enregistrer.",
    invalidApiUrl: "URL de l'API Intrafeur invalide : {url}",
    notGranted:
      "Ce navigateur n'a pas autorisé Intrafeur à accéder à {origin} : ouvrez les options de l'extension et cliquez à nouveau sur Enregistrer la connexion pour redemander l'accès.",
    unreachable: 'Impossible de joindre le serveur Intrafeur ({origin}) : {error}',
    requestFailed: "Échec de la requête à l'API ({status}) : {body}",
    unknownMessage: 'Type de message inconnu : {type}',
    ikInvalidKey: 'Clé Intrastek invalide ou expirée',
    ikDisabled: "La fonctionnalité extension d'Intrastek a été désactivée par un admin",
    ikNoIntranet: "Intrastek n'arrive pas à joindre l'intranet",
    ikRequestFailed: 'Échec de la requête Intrastek ({status})',
    ikNoKey: "Aucune clé Intrastek enregistrée : ouvrez les options de l'extension pour en ajouter une.",
    ikInvalidUrl: "URL de l'API Intrastek invalide : {url}",
    ikNotGranted:
      "Ce navigateur n'a pas autorisé Intrafeur à accéder à {origin} : ouvrez les options de l'extension et cliquez sur Enregistrer dans la section Intrastek.",
    ikUnreachable: 'Impossible de joindre Intrastek ({origin}) : {error}',
    ikInvalidEventId: "Identifiant d'événement intranet invalide",
    ikInvalidEventIds: "Identifiants d'événements invalides",
    ikInvalidGroupId: 'Identifiant de groupe invalide',
    ikInvalidProposalId: 'Identifiant de proposition invalide',
    ikInvalidAers: "Le nombre d'AER nécessaires doit être un entier ≥ 0",
  },
);
