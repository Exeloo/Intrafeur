// Isolated-world half of the MAIN-world features: those scripts can't read
// extension storage, so this mirrors every FLAGS entry that has a `mirror`
// onto <html data-…="on">. (The UI language reaches <html data-epitools-lang>
// through initLang() in isolated.ts, which runs before every feature.)
import { FLAGS, type FlagDef } from '../../settings';
import { watchFlag } from './ext-storage';

function setMirror(datasetKey: string, enabled: boolean): void {
  if (enabled) document.documentElement.dataset[datasetKey] = 'on';
  else delete document.documentElement.dataset[datasetKey];
}

export function init(): void {
  for (const flag of Object.values(FLAGS) as FlagDef[]) {
    const datasetKey = flag.mirror;
    if (datasetKey) void watchFlag(flag, (on) => setMirror(datasetKey, on));
  }
}
