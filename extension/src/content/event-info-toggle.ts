// Isolated-world half of the event "Copy info" button: event-info.ts runs in
// the MAIN world and can't read extension storage, so this mirrors the
// per-browser toggle onto <html data-epitools-event-info="on"> for it.
import browser from 'webextension-polyfill';
import { EVENT_INFO_ENABLED_KEY, EVENT_INFO_ENABLED_DEFAULT } from '../types';

function setEnabledFlag(enabled: boolean): void {
  if (enabled) document.documentElement.dataset.epitoolsEventInfo = 'on';
  else delete document.documentElement.dataset.epitoolsEventInfo;
}

async function initFeatureToggle(): Promise<void> {
  let stored: Record<string, unknown>;
  try {
    stored = await browser.storage.local.get({ [EVENT_INFO_ENABLED_KEY]: EVENT_INFO_ENABLED_DEFAULT });
  } catch {
    // "Extension context invalidated" in a tab that wasn't refreshed after
    // an extension reload — see attendance.ts's initFeatureToggle.
    return;
  }
  setEnabledFlag(stored[EVENT_INFO_ENABLED_KEY] !== false);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(EVENT_INFO_ENABLED_KEY in changes)) return;
    setEnabledFlag(changes[EVENT_INFO_ENABLED_KEY].newValue !== false);
  });
}

initFeatureToggle();
