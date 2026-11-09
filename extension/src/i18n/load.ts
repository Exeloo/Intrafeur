// Extension contexts only (imports the polyfill; never from the MAIN world).
import browser from 'webextension-polyfill';
import { LANGUAGE_DEFAULT, LANGUAGE_KEY, setLang, type Lang } from './core';

/** Reads the language preference, applies it, and re-applies it on change (`onChange` runs after). */
export async function initLang(onChange?: (lang: Lang) => void): Promise<Lang> {
  let pref: unknown = LANGUAGE_DEFAULT;
  try {
    pref = (await browser.storage.local.get({ [LANGUAGE_KEY]: LANGUAGE_DEFAULT }))[LANGUAGE_KEY];
  } catch {
    // "Extension context invalidated" in a stale tab: fall back to auto.
  }
  const lang = setLang(pref);
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(LANGUAGE_KEY in changes)) return;
      const next = setLang(changes[LANGUAGE_KEY].newValue);
      onChange?.(next);
    });
  } catch {
    // same as above
  }
  return lang;
}
