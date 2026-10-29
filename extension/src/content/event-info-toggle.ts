// Isolated-world half of the MAIN-world features that have a popup toggle
// (event "Copy info" button, absences-tab attendance button): event-info.ts
// and absence-status.ts run in the MAIN world and can't read extension
// storage, so this mirrors each per-browser toggle onto an <html> data
// attribute for them (data-epitools-event-info / -absence-status = "on").
import browser from 'webextension-polyfill';
import {
  ABSENCE_STATUS_ENABLED_DEFAULT,
  ABSENCE_STATUS_ENABLED_KEY,
  EVENT_INFO_ENABLED_KEY,
  EVENT_INFO_ENABLED_DEFAULT,
} from '../types';

// Storage key -> [dataset property, default].
const FLAGS: Record<string, [string, boolean]> = {
  [EVENT_INFO_ENABLED_KEY]: ['epitoolsEventInfo', EVENT_INFO_ENABLED_DEFAULT],
  [ABSENCE_STATUS_ENABLED_KEY]: ['epitoolsAbsenceStatus', ABSENCE_STATUS_ENABLED_DEFAULT],
};

function setEnabledFlag(datasetKey: string, enabled: boolean): void {
  if (enabled) document.documentElement.dataset[datasetKey] = 'on';
  else delete document.documentElement.dataset[datasetKey];
}

async function initFeatureToggle(): Promise<void> {
  let stored: Record<string, unknown>;
  try {
    stored = await browser.storage.local.get(
      Object.fromEntries(Object.entries(FLAGS).map(([key, [, def]]) => [key, def])),
    );
  } catch {
    // "Extension context invalidated" in a tab that wasn't refreshed after
    // an extension reload — see attendance.ts's initFeatureToggle.
    return;
  }
  for (const [key, [datasetKey]] of Object.entries(FLAGS)) setEnabledFlag(datasetKey, stored[key] !== false);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    for (const [key, [datasetKey]] of Object.entries(FLAGS)) {
      if (key in changes) setEnabledFlag(datasetKey, changes[key].newValue !== false);
    }
  });
}

initFeatureToggle();
