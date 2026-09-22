import browser from 'webextension-polyfill';
import { FACTIONS_ENABLED_KEY, FACTIONS_ENABLED_DEFAULT } from '../types';

async function init(): Promise<void> {
  const checkbox = document.getElementById('factionsEnabled') as HTMLInputElement;

  const stored = await browser.storage.local.get({ [FACTIONS_ENABLED_KEY]: FACTIONS_ENABLED_DEFAULT });
  checkbox.checked = stored[FACTIONS_ENABLED_KEY] !== false;

  checkbox.addEventListener('change', () => {
    browser.storage.local.set({ [FACTIONS_ENABLED_KEY]: checkbox.checked });
  });

  document.getElementById('openOptions')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    browser.runtime.openOptionsPage();
  });
}

init();
