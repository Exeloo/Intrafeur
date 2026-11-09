// Connection logic + forms shared by the options and setup pages: faction
// backend (storage.sync via the background) and Intrastek (storage.local only:
// the key is personal).
//
// Firefox drops the user gesture after any await, so `permissions.request`
// must be the first await of a Save/Test click: the exported connect/test/save
// functions compute the origin synchronously and await the request first, and
// the click handlers call them directly (withBusy runs them synchronously).
import browser from 'webextension-polyfill';
import type { Faction, IntrastekMe, IntrastekResponse, Settings } from '../types';
import {
  INTRASTEK_API_KEY_KEY,
  INTRASTEK_API_URL_DEFAULT,
  INTRASTEK_API_URL_KEY,
  INTRASTEK_DEFAULT_GROUP_KEY,
} from '../types';
import { t } from '../i18n/pages';
import { button, el, errorText, field, secretInput, send, setStatus, statusLine, textInput, withBusy } from './dom';

export type Fail = { ok: false; message: string };

function fail(message: string): Fail {
  return { ok: false, message };
}

export function trimUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Synchronous: the origin of an http(s) URL, or throws a translated Error. */
export function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(t('connInvalidUrl'));
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(t('connInvalidUrl'));
  return parsed.origin;
}

/** Validates the URL and asks for its host permission; `permissions.request` is its first await. */
export async function requestOrigin(url: string): Promise<{ ok: true } | Fail> {
  let origin: string;
  try {
    origin = originOf(url);
  } catch (err) {
    return fail(errorText(err));
  }
  try {
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    return granted ? { ok: true } : fail(t('connPermissionDenied', { origin }));
  } catch (err) {
    return fail(t('connPermissionError', { origin, message: errorText(err) }));
  }
}

// --- Faction backend ---

export async function loadFactionSettings(): Promise<Settings> {
  return send<Settings>('getSettings');
}

/** True when a backend URL and token are saved. */
export async function factionsConfigured(): Promise<boolean> {
  try {
    const s = await loadFactionSettings();
    return !!(s.apiBaseUrl && s.apiToken);
  } catch {
    return false;
  }
}

/** Permission → save → test (lists the factions; there is no dedicated test endpoint). */
export async function connectFactions(rawUrl: string, rawToken: string): Promise<{ ok: true; count: number } | Fail> {
  const apiBaseUrl = trimUrl(rawUrl);
  const apiToken = rawToken.trim();
  if (!apiBaseUrl) return fail(t('connUrlRequired'));
  if (!apiToken) return fail(t('connTokenRequired'));
  const perm = await requestOrigin(apiBaseUrl);
  if (!perm.ok) return perm;
  try {
    await send('saveSettings', { apiBaseUrl, apiToken } satisfies Settings);
  } catch (err) {
    return fail(t('connSaveFailed', { message: errorText(err) }));
  }
  try {
    const factions = await send<Faction[]>('getFactions');
    return { ok: true, count: factions.length };
  } catch (err) {
    return fail(t('connSavedTestFailed', { message: errorText(err) }));
  }
}

// --- Intrastek ---

export interface IntrastekForm {
  apiUrl: string;
  apiKey: string;
}

export interface IntrastekStored extends IntrastekForm {
  groupId: string;
}

export function normalizeIntrastekUrl(raw: string): string {
  return trimUrl(raw) || INTRASTEK_API_URL_DEFAULT;
}

export async function loadIntrastekSettings(): Promise<IntrastekStored> {
  const stored = await browser.storage.local.get({
    [INTRASTEK_API_URL_KEY]: INTRASTEK_API_URL_DEFAULT,
    [INTRASTEK_API_KEY_KEY]: '',
    [INTRASTEK_DEFAULT_GROUP_KEY]: '',
  });
  return {
    apiUrl: String(stored[INTRASTEK_API_URL_KEY] || INTRASTEK_API_URL_DEFAULT),
    apiKey: String(stored[INTRASTEK_API_KEY_KEY] || ''),
    groupId: String(stored[INTRASTEK_DEFAULT_GROUP_KEY] || ''),
  };
}

/** `/extension/me` with the stored settings (no permission request). */
export async function fetchIntrastekMe(): Promise<{ ok: true; me: IntrastekMe } | Fail> {
  try {
    const res = await send<IntrastekResponse<IntrastekMe>>('intrastekMe');
    return res.ok ? { ok: true, me: res.data } : fail(res.message);
  } catch (err) {
    return fail(errorText(err));
  }
}

/** Tests the typed values without saving them. */
export async function testIntrastek(form: IntrastekForm): Promise<{ ok: true; me: IntrastekMe } | Fail> {
  const apiUrl = normalizeIntrastekUrl(form.apiUrl);
  const apiKey = form.apiKey.trim();
  if (!apiKey) return fail(t('ikKeyFirst'));
  const perm = await requestOrigin(apiUrl);
  if (!perm.ok) return perm;
  try {
    const res = await send<IntrastekResponse<IntrastekMe>>('intrastekMe', { apiUrl, apiKey });
    return res.ok ? { ok: true, me: res.data } : fail(res.message);
  } catch (err) {
    return fail(errorText(err));
  }
}

/** Saves URL (+ group); an empty key removes the stored key (feature off). */
export async function saveIntrastek(
  form: IntrastekForm & { groupId?: string },
  opts: { skipPermission?: boolean } = {},
): Promise<{ ok: true; removed: boolean } | Fail> {
  const apiUrl = normalizeIntrastekUrl(form.apiUrl);
  const apiKey = form.apiKey.trim();
  if (apiKey && !opts.skipPermission) {
    const perm = await requestOrigin(apiUrl);
    if (!perm.ok) return perm;
  }
  try {
    const values: Record<string, unknown> = { [INTRASTEK_API_URL_KEY]: apiUrl };
    if (form.groupId) values[INTRASTEK_DEFAULT_GROUP_KEY] = form.groupId;
    if (apiKey) values[INTRASTEK_API_KEY_KEY] = apiKey;
    await browser.storage.local.set(values);
    if (!apiKey) await browser.storage.local.remove(INTRASTEK_API_KEY_KEY);
  } catch (err) {
    return fail(t('connSaveFailed', { message: errorText(err) }));
  }
  return { ok: true, removed: !apiKey };
}

// --- Forms ---

function actions(...buttons: HTMLButtonElement[]): HTMLElement {
  const row = el('div', 'actions');
  row.append(...buttons);
  return row;
}

function loadingNote(): HTMLElement {
  const note = statusLine();
  setStatus(note, t('loading'), 'loading');
  return note;
}

/** Faction backend URL + token with one "Save and test" button. */
export function factionConnectionForm(opts: { onConnected?: () => void } = {}): HTMLElement {
  const root = el('div', 'form');
  const url = textInput('url', 'https://intrafeur.example.com');
  const token = secretInput(t('show'), t('factionTokenPlaceholder'));
  const status = statusLine();
  const save = button(t('saveAndTest'), 'btn btn--primary');
  const loading = loadingNote();
  url.disabled = token.input.disabled = save.disabled = true;

  root.append(
    field({ label: t('factionUrlLabel'), control: url, hint: t('factionUrlHint') }),
    field({ label: t('factionTokenLabel'), control: token.wrap, hint: t('factionTokenHint') }),
    actions(save),
    status,
    loading,
  );

  loadFactionSettings()
    .then((s) => {
      url.value = s.apiBaseUrl || '';
      token.input.value = s.apiToken || '';
    })
    .catch((err) => setStatus(status, t('loadFailed', { message: errorText(err) }), 'error'))
    .finally(() => {
      loading.remove();
      url.disabled = token.input.disabled = save.disabled = false;
    });

  save.addEventListener('click', () =>
    withBusy(save, async () => {
      setStatus(status, t('testing'), 'loading');
      const res = await connectFactions(url.value, token.input.value);
      if (!res.ok) return setStatus(status, res.message, 'error');
      url.value = trimUrl(url.value);
      setStatus(status, t('factionConnected', { count: res.count }), 'success');
      opts.onConnected?.();
    }),
  );
  return root;
}

function renderMe(box: HTMLElement, me: IntrastekMe | null): void {
  box.replaceChildren();
  box.hidden = !me;
  if (!me) return;
  const line = (label: string, value: string): void => {
    const row = el('div', 'me-row');
    row.append(el('span', 'me-label', label), el('span', 'me-value', value));
    box.appendChild(row);
  };
  line(t('ikMeUser'), `${me.user.firstName} ${me.user.lastName} (${me.user.email})`);
  line(t('ikMeRole'), me.isAdmin ? t('ikRoleAdmin') : t('ikRoleTeacher'));
  line(t('ikMeScopes'), me.scopes.length ? me.scopes.join(', ') : t('none'));
  line(t('ikMeGroups'), me.groups.length ? me.groups.map((g) => g.name).join(', ') : t('none'));
}

function fillGroups(select: HTMLSelectElement, me: IntrastekMe | null, savedId: string): void {
  select.replaceChildren();
  if (!me || !me.groups.length) {
    select.appendChild(el('option', undefined, me ? t('ikNoGroup') : t('ikGroupsNeedTest')));
    select.options[0].value = '';
    select.disabled = true;
    return;
  }
  for (const group of me.groups) {
    const opt = el('option', undefined, group.id === me.defaultGroupId ? t('ikMyGroup', { name: group.name }) : group.name);
    opt.value = group.id;
    select.appendChild(opt);
  }
  const has = (id: string | null): id is string => !!id && me.groups.some((g) => g.id === id);
  select.value = has(savedId) ? savedId : has(me.defaultGroupId) ? me.defaultGroupId : me.groups[0].id;
  select.disabled = false;
}

/**
 * Intrastek URL (with default + reset), key, default group, "who am I" box.
 * `combined`: one "Test and save" button (setup) instead of Save + Test.
 * `advancedUrl`: the URL field is folded under an "Advanced" disclosure.
 */
export function intrastekConnectionForm(opts: { combined?: boolean; advancedUrl?: boolean } = {}): HTMLElement {
  const root = el('div', 'form');
  const url = textInput('url', INTRASTEK_API_URL_DEFAULT);
  const key = secretInput(t('show'), 'ik_…');
  const group = el('select', 'input');
  const status = statusLine();
  const me = el('div', 'me-box');
  me.hidden = true;
  const loading = loadingNote();
  let savedGroupId = '';
  fillGroups(group, null, '');

  const urlField = field({
    label: t('ikUrlLabel'),
    control: url,
    defaultHint: t('defaultValue', { value: INTRASTEK_API_URL_DEFAULT }),
    reset: { label: t('resetToDefault'), onReset: () => (url.value = INTRASTEK_API_URL_DEFAULT) },
  });
  const keyField = field({ label: t('ikKeyLabel'), control: key.wrap, hint: t('ikKeyHint') });
  const groupField = field({ label: t('ikGroupLabel'), control: group, defaultHint: t('ikGroupDefault') });

  if (opts.advancedUrl) {
    const details = el('details', 'advanced');
    details.append(el('summary', undefined, t('advanced')), urlField);
    root.append(keyField, groupField, details);
  } else {
    root.append(urlField, keyField, groupField);
  }

  const form = (): IntrastekForm & { groupId?: string } => ({
    apiUrl: url.value,
    apiKey: key.input.value,
    groupId: group.disabled ? undefined : group.value,
  });
  const showMe = (value: IntrastekMe | null): void => {
    renderMe(me, value);
    fillGroups(group, value, savedGroupId);
  };
  const afterSave = (removed: boolean): void => {
    url.value = normalizeIntrastekUrl(url.value);
    if (group.value && !group.disabled) savedGroupId = group.value;
    if (removed) showMe(null);
  };

  const buttons: HTMLButtonElement[] = [];
  if (opts.combined) {
    const testSave = button(t('testAndSave'), 'btn btn--primary');
    testSave.addEventListener('click', () =>
      withBusy(testSave, async () => {
        setStatus(status, t('testing'), 'loading');
        const res = await testIntrastek(form());
        if (!res.ok) {
          showMe(null);
          return setStatus(status, t('testFailed', { message: res.message }), 'error');
        }
        showMe(res.me);
        // Permission was just granted by the test.
        const saved = await saveIntrastek(form(), { skipPermission: true });
        if (!saved.ok) return setStatus(status, saved.message, 'error');
        afterSave(false);
        setStatus(status, t('ikConnectedSaved', { name: res.me.user.firstName }), 'success');
      }),
    );
    buttons.push(testSave);
  } else {
    const save = button(t('save'), 'btn btn--primary');
    const test = button(t('testConnection'), 'btn btn--secondary');
    save.addEventListener('click', () =>
      withBusy(save, async () => {
        setStatus(status, t('saving'), 'loading');
        const res = await saveIntrastek(form());
        if (!res.ok) return setStatus(status, res.message, 'error');
        afterSave(res.removed);
        setStatus(status, res.removed ? t('ikSavedNoKey') : t('saved'), 'success');
        if (!res.removed) {
          const meRes = await fetchIntrastekMe();
          if (meRes.ok) showMe(meRes.me);
        }
      }),
    );
    test.addEventListener('click', () =>
      withBusy(test, async () => {
        setStatus(status, t('testing'), 'loading');
        const res = await testIntrastek(form());
        if (!res.ok) {
          renderMe(me, null);
          return setStatus(status, t('testFailed', { message: res.message }), 'error');
        }
        showMe(res.me);
        setStatus(status, t('ikTestOk'), 'success');
      }),
    );
    buttons.push(save, test);
  }
  const controls = [url, key.input, ...buttons];
  for (const c of controls) c.disabled = true;
  root.append(actions(...buttons));
  if (!opts.combined) root.appendChild(el('p', 'hint', t('ikTestHint')));
  root.append(status, me, loading);

  loadIntrastekSettings()
    .then(async (stored) => {
      url.value = stored.apiUrl;
      key.input.value = stored.apiKey;
      savedGroupId = stored.groupId;
      if (!stored.apiKey) return;
      // Silent: fills the group select and "who am I"; errors show up on Test.
      setStatus(loading, t('ikLoadingMe'), 'loading');
      const res = await fetchIntrastekMe();
      if (res.ok) showMe(res.me);
    })
    .catch((err) => setStatus(status, t('loadFailed', { message: errorText(err) }), 'error'))
    .finally(() => {
      loading.remove();
      for (const c of controls) c.disabled = false;
    });
  return root;
}
