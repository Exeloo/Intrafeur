// Single MAIN-world content script bundle ("world": "MAIN": reads React
// fibers; no browser.*, no polyfill). Each feature exports init().
import { init as eventInfo } from './event-info';
import { init as evalSheetPage } from './eval-sheet-page';
import { init as intrastekPage } from './intrastek-page';
import { init as absenceStatus } from './absence-status';
import { init as studentUnits } from './student-units';
import { init as attendancePresent } from './attendance-present';

const FEATURES: [string, () => unknown][] = [
  ['event-info', eventInfo],
  ['eval-sheet-page', evalSheetPage],
  ['intrastek-page', intrastekPage],
  ['absence-status', absenceStatus],
  ['student-units', studentUnits],
  ['attendance-present', attendancePresent],
];

for (const [name, init] of FEATURES) {
  try {
    void Promise.resolve(init()).catch((err) => console.error(`[Intrafeur] ${name}:`, err));
  } catch (err) {
    console.error(`[Intrafeur] ${name}:`, err);
  }
}
