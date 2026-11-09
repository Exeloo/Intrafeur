// Isolated-world / extension-page storage helpers. Every browser.* call in a
// tab that wasn't refreshed after an extension reload throws "Extension
// context invalidated"; there's no recovery from that dead instance (the tab
// needs F5), so these swallow it instead of surfacing unhandled rejections.
import browser from 'webextension-polyfill';
import { flagDefaults, flagValue, type FlagDef } from '../../settings';

/** storage.local.get with defaults; null when the extension context is gone. */
export async function getLocal<T extends Record<string, unknown>>(defaults: T): Promise<T | null> {
  try {
    return (await browser.storage.local.get(defaults)) as T;
  } catch {
    return null;
  }
}

/** Calls `cb(newValues)` with the changed subset of `keys` (storage.local only). */
export function onLocalChange(keys: string[], cb: (newValues: Record<string, unknown>) => void): void {
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const hit = keys.filter((k) => k in changes);
      if (hit.length) cb(Object.fromEntries(hit.map((k) => [k, changes[k].newValue])));
    });
  } catch {
    // context invalidated
  }
}

/** Runs `apply(enabled)` with the flag's current value, then on every change. */
export async function watchFlag(flag: FlagDef, apply: (enabled: boolean) => void): Promise<void> {
  const stored = await getLocal(flagDefaults([flag]));
  if (!stored) return;
  apply(flagValue(flag, stored[flag.key]));
  onLocalChange([flag.key], (v) => apply(flagValue(flag, v[flag.key])));
}
