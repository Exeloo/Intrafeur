// Single isolated-world content script bundle (one polyfill copy, one shared
// DOM observer). Each feature exports init(); one failing must not stop the others.
import { initLang } from '../i18n/load';
import { init as mirror } from './shared/mirror';
import { init as factions } from './attendance';
import { init as unitFilters } from './unit-filters';
import { init as evalSheet } from './eval-sheet';
import { init as intrastek } from './intrastek';
import { init as hideGrades } from './hide-grades';

const FEATURES: [string, () => unknown][] = [
  ['mirror', mirror],
  ['factions', factions],
  ['unit-filters', unitFilters],
  ['eval-sheet', evalSheet],
  ['intrastek', intrastek],
  ['hide-grades', hideGrades],
];

// Language first (also mirrored onto <html data-epitools-lang> for the MAIN world),
// so no feature renders in the wrong one.
void initLang().then(() => {
  for (const [name, init] of FEATURES) {
    try {
      void Promise.resolve(init()).catch((err) => console.error(`[Intrafeur] ${name}:`, err));
    } catch (err) {
      console.error(`[Intrafeur] ${name}:`, err);
    }
  }
});
