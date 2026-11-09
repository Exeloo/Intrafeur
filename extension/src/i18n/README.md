# i18n

- `core.ts`: `defineMessages(en, fr)` → `t(key, vars?)`, `currentLang()`, `currentLocale()`.
  Works in every context (MAIN world included). Placeholders are `{name}`.
- `load.ts`: `initLang()` for extension contexts (reads `language` from storage.local).
- Each feature keeps its dictionary in `src/i18n/<feature>.ts`, exporting its `t`.
  `fr` must have exactly the keys of `en` (the typecheck enforces it).
- Manifest strings: `_locales/{en,fr}/messages.json` (`__MSG_…__`).
- Labels used to *detect* the site's own UI (e.g. `EXPORT_BUTTON_LABELS`) are not
  translations: keep both languages listed there.
