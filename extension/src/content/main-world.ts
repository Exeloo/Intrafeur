// Single MAIN-world content script bundle ("world": "MAIN": reads React
// fibers; no browser.*, no polyfill). Each feature exports init().
import { init as evalSheetPage } from './eval-sheet-page';
import { init as intrastekPage } from './intrastek-page';
import { init as absenceStatus } from './absence-status';
import { init as studentUnits } from './student-units';
import { init as attendancePresent } from './attendance-present';
import { init as planningFeed } from './planning-feed';
import { init as promotionTags } from './promotion-tags';

const FEATURES: [string, () => unknown][] = [
  ['eval-sheet-page', evalSheetPage],
  ['intrastek-page', intrastekPage],
  ['absence-status', absenceStatus],
  ['student-units', studentUnits],
  ['attendance-present', attendancePresent],
  ['planning-feed', planningFeed],
  ['promotion-tags', promotionTags],
];

for (const [name, init] of FEATURES) {
  try {
    void Promise.resolve(init()).catch((err) => console.error(`[Intrafeur] ${name}:`, err));
  } catch (err) {
    console.error(`[Intrafeur] ${name}:`, err);
  }
}
