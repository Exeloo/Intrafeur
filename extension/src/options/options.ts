// Settings page: one panel per hash route (#general, #features, #factions,
// #intrastek, #about). Connection forms and the feature list are shared with
// the setup page (src/ui).
import browser from 'webextension-polyfill';
import type { Faction } from '../types';
import { LANGUAGE_DEFAULT, LANGUAGE_KEY } from '../i18n/core';
import { initLang } from '../i18n/load';
import { t } from '../i18n/pages';
import { optionsEn, tOptions } from '../i18n/pages-options';
import { applyI18n, armable, button, el, errorText, field, requireEl, send, setStatus, withBusy } from '../ui/dom';
import { factionConnectionForm, factionsConfigured, intrastekConnectionForm } from '../ui/connections';
import { featureList, languageSelect } from '../ui/features';
import { getLocal } from '../content/shared/ext-storage';

const PANELS = ['general', 'features', 'factions', 'intrastek', 'about'];

function route(): void {
  const wanted = location.hash.slice(1);
  const current = PANELS.includes(wanted) ? wanted : PANELS[0];
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'))) {
    panel.hidden = panel.dataset.panel !== current;
  }
  for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('.nav a'))) {
    if (link.getAttribute('href') === `#${current}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderGeneral(): Promise<void> {
  const stored = await getLocal({ [LANGUAGE_KEY]: LANGUAGE_DEFAULT as string });
  const select = languageSelect(stored?.[LANGUAGE_KEY]);
  requireEl('generalBody').appendChild(
    field({
      label: tOptions('languageLabel'),
      control: select,
      defaultHint: t('defaultValue', { value: t('langAuto') }),
      hint: tOptions('languageHint'),
      // Removing the key reloads the page (initLang onChange).
      reset: { label: t('resetToDefault'), onReset: () => void browser.storage.local.remove(LANGUAGE_KEY) },
    }),
  );
}

// --- Faction list ---

async function loadFactions(): Promise<void> {
  const list = requireEl<HTMLUListElement>('factionList');
  const status = requireEl('factionStatus');
  const form = requireEl<HTMLFormElement>('factionForm');
  list.replaceChildren();
  setStatus(status, t('loading'), 'loading');
  if (!(await factionsConfigured())) {
    form.hidden = true;
    setStatus(status, tOptions('factionsNeedBackend'));
    return;
  }
  let factions: Faction[];
  try {
    factions = await send<Faction[]>('getFactions');
  } catch (err) {
    form.hidden = true;
    setStatus(status, tOptions('factionsLoadFailed', { message: errorText(err) }), 'error');
    return;
  }
  form.hidden = false;
  setStatus(status, factions.length ? '' : tOptions('factionsEmpty'));
  for (const faction of factions) {
    const row = el('li', 'faction-row');
    const swatch = el('span', 'faction-swatch');
    swatch.style.backgroundColor = faction.color;
    const del = button(tOptions('factionDelete'), 'btn btn--danger btn--small');
    del.title = tOptions('factionDeleteTitle');
    armable(
      del,
      () =>
        withBusy(del, async () => {
          try {
            await send('deleteFaction', { id: faction.id });
            await loadFactions();
          } catch (err) {
            setStatus(status, tOptions('factionDeleteFailed', { message: errorText(err) }), 'error');
          }
        }),
      { armedLabel: tOptions('factionDeleteConfirm') },
    );
    row.append(swatch, el('span', 'faction-name', faction.name), del);
    list.appendChild(row);
  }
}

function initFactionForm(): void {
  const form = requireEl<HTMLFormElement>('factionForm');
  const name = requireEl<HTMLInputElement>('factionName');
  const color = requireEl<HTMLInputElement>('factionColor');
  const add = requireEl<HTMLButtonElement>('factionAdd');
  form.hidden = true;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = name.value.trim();
    if (!value) return;
    withBusy(add, async () => {
      try {
        await send('saveFaction', { name: value, color: color.value });
        name.value = '';
        await loadFactions();
      } catch (err) {
        setStatus(requireEl('factionStatus'), tOptions('factionAddFailed', { message: errorText(err) }), 'error');
      }
    });
  });
}

async function init(): Promise<void> {
  await initLang(() => location.reload());
  applyI18n(tOptions, optionsEn);
  document.title = tOptions('optTitle');
  route();
  window.addEventListener('hashchange', route);

  void renderGeneral();
  requireEl('featuresBody').appendChild(
    featureList({ openSection: (section) => (location.hash = section) }),
  );
  requireEl('factionConn').appendChild(factionConnectionForm({ onConnected: () => void loadFactions() }));
  initFactionForm();
  void loadFactions();
  requireEl('intrastekBody').appendChild(intrastekConnectionForm());
  requireEl('aboutVersion').textContent = tOptions('aboutVersion', { version: browser.runtime.getManifest().version });
}

void init();
