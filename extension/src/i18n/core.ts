// Tiny i18n core shared by every bundle (both content-script worlds, the
// background, popup, options and setup pages). Each feature keeps its own
// dictionary next to it (`defineMessages(en, fr)`), so a bundle only ships
// the strings it uses. `fr` must have exactly the keys of `en` (typechecked).
//
// The language is resolved once per context:
// - extension contexts (isolated content scripts, pages, background) call
//   `initLang()` (src/i18n/load.ts), which reads the `language` preference
//   from storage.local and calls `setLang`;
// - the MAIN world can't read storage: the isolated mirror
//   (content/shared/mirror.ts) writes the resolved language onto
//   <html data-epitools-lang>, which `currentLang()` reads at call time.
export type Lang = 'en' | 'fr';
export type LanguagePref = 'auto' | Lang;

export const LANGUAGE_KEY = 'language'; // storage.local, LanguagePref
export const LANGUAGE_DEFAULT: LanguagePref = 'auto';
export const LANG_DATASET_KEY = 'epitoolsLang'; // <html data-epitools-lang>

let forced: Lang | null = null;

export function resolveLang(pref: unknown): Lang {
  if (pref === 'en' || pref === 'fr') return pref;
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function setLang(pref: unknown): Lang {
  forced = resolveLang(pref);
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset[LANG_DATASET_KEY] = forced;
  }
  return forced;
}

export function currentLang(): Lang {
  if (forced) return forced;
  const attr = typeof document !== 'undefined' ? document.documentElement?.dataset[LANG_DATASET_KEY] : undefined;
  return resolveLang(attr);
}

export type Vars = Record<string, string | number>;

function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/**
 * `const t = defineMessages({ save: 'Save', hello: 'Hi {name}' }, { save: 'Enregistrer', hello: 'Salut {name}' })`
 * then `t('hello', { name })`. Placeholders are `{name}`.
 */
export function defineMessages<K extends string>(en: Record<K, string>, fr: Record<K, string>) {
  return (key: K, vars?: Vars): string => format((currentLang() === 'fr' ? fr : en)[key] ?? en[key], vars);
}

/** Locale tag for Intl / toLocale*String calls. */
export function currentLocale(): string {
  return currentLang() === 'fr' ? 'fr-FR' : 'en-GB';
}
