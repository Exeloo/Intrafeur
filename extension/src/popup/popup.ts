// Toolbar popup: the shared feature list (chrome://flags style) + links.
// Never requests permissions here: the browser prompt closes the popup.
import browser from 'webextension-polyfill';
import { initLang } from '../i18n/load';
import { popupEn, tPopup } from '../i18n/pages-popup';
import { applyI18n, openOptionsSection, requireEl } from '../ui/dom';
import { featureList } from '../ui/features';

function openAndClose(open: Promise<unknown>): void {
  void open.finally(() => window.close());
}

async function init(): Promise<void> {
  await initLang(() => location.reload());
  applyI18n(tPopup, popupEn);
  requireEl('version').textContent = `v${browser.runtime.getManifest().version}`;
  requireEl('features').appendChild(
    featureList({ language: true, openSection: (section) => openAndClose(openOptionsSection(section)) }),
  );
  requireEl('openSettings').addEventListener('click', () => openAndClose(browser.runtime.openOptionsPage()));
  requireEl('openSetup').addEventListener('click', () =>
    openAndClose(browser.tabs.create({ url: browser.runtime.getURL('setup/setup.html') })),
  );
}

void init();
