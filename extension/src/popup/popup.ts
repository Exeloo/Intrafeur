import browser from 'webextension-polyfill';
import {
  FACTIONS_ENABLED_KEY,
  FACTIONS_ENABLED_DEFAULT,
  EVAL_SHEET_ENABLED_KEY,
  EVAL_SHEET_ENABLED_DEFAULT,
  EVENT_INFO_ENABLED_KEY,
  EVENT_INFO_ENABLED_DEFAULT,
  UNIT_FILTERS_ENABLED_KEY,
  UNIT_FILTERS_ENABLED_DEFAULT,
} from '../types';

async function init(): Promise<void> {
  const checkbox = document.getElementById('factionsEnabled') as HTMLInputElement;

  const eventInfoCheckbox = document.getElementById('eventInfoEnabled') as HTMLInputElement;
  const evalCheckbox = document.getElementById('evalSheetEnabled') as HTMLInputElement;
  const unitFiltersCheckbox = document.getElementById('unitFiltersEnabled') as HTMLInputElement;

  const stored = await browser.storage.local.get({
    [FACTIONS_ENABLED_KEY]: FACTIONS_ENABLED_DEFAULT,
    [EVENT_INFO_ENABLED_KEY]: EVENT_INFO_ENABLED_DEFAULT,
    [EVAL_SHEET_ENABLED_KEY]: EVAL_SHEET_ENABLED_DEFAULT,
    [UNIT_FILTERS_ENABLED_KEY]: UNIT_FILTERS_ENABLED_DEFAULT,
  });
  checkbox.checked = stored[FACTIONS_ENABLED_KEY] !== false;
  eventInfoCheckbox.checked = stored[EVENT_INFO_ENABLED_KEY] !== false;
  evalCheckbox.checked = stored[EVAL_SHEET_ENABLED_KEY] === true;
  unitFiltersCheckbox.checked = stored[UNIT_FILTERS_ENABLED_KEY] !== false;

  checkbox.addEventListener('change', () => {
    browser.storage.local.set({ [FACTIONS_ENABLED_KEY]: checkbox.checked });
  });

  eventInfoCheckbox.addEventListener('change', () => {
    browser.storage.local.set({ [EVENT_INFO_ENABLED_KEY]: eventInfoCheckbox.checked });
  });

  unitFiltersCheckbox.addEventListener('change', () => {
    browser.storage.local.set({ [UNIT_FILTERS_ENABLED_KEY]: unitFiltersCheckbox.checked });
  });

  evalCheckbox.addEventListener('change', () => {
    browser.storage.local.set({ [EVAL_SHEET_ENABLED_KEY]: evalCheckbox.checked });
  });

  document.getElementById('openOptions')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    browser.runtime.openOptionsPage();
  });
}

init();
