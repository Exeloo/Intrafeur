import browser from 'webextension-polyfill';
import type { Faction, Settings, MessageType, IntrastekMe, IntrastekResponse } from '../types';
import {
  INTRASTEK_API_KEY_KEY,
  INTRASTEK_API_URL_DEFAULT,
  INTRASTEK_API_URL_KEY,
  INTRASTEK_DEFAULT_GROUP_KEY,
} from '../types';

function send<T>(type: MessageType, payload?: unknown): Promise<T> {
  return browser.runtime.sendMessage({ type, payload }) as Promise<T>;
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

function setStatus(el: HTMLElement, message: string, kind?: 'error' | 'success' | ''): void {
  el.textContent = message;
  el.className = `status ${kind || ''}`;
}

async function loadSettings(): Promise<void> {
  try {
    const settings = await send<Settings>('getSettings');
    requireEl<HTMLInputElement>('apiBaseUrl').value = settings.apiBaseUrl || '';
    requireEl<HTMLInputElement>('apiToken').value = settings.apiToken || '';
  } catch (err) {
    console.error(err);
  }
}

async function saveSettings(): Promise<void> {
  const statusEl = requireEl<HTMLElement>('settingsStatus');
  const apiBaseUrl = requireEl<HTMLInputElement>('apiBaseUrl').value.trim().replace(/\/$/, '');
  const apiToken = requireEl<HTMLInputElement>('apiToken').value.trim();

  if (!apiBaseUrl) {
    setStatus(statusEl, 'API base URL is required.', 'error');
    return;
  }

  let origin: string;
  try {
    origin = new URL(apiBaseUrl).origin;
  } catch (err) {
    setStatus(statusEl, `Invalid URL: ${(err as Error).message}`, 'error');
    return;
  }

  try {
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      setStatus(
        statusEl,
        `Permission to contact ${origin} was not granted, so nothing was saved. Click Save connection again and accept the browser's permission prompt.`,
        'error',
      );
      return;
    }
  } catch (err) {
    setStatus(statusEl, `Could not request permission for ${origin}: ${(err as Error).message}`, 'error');
    return;
  }

  await send('saveSettings', { apiBaseUrl, apiToken } satisfies Settings);
  setStatus(statusEl, 'Saved.', 'success');
  await loadFactions();
}

async function loadFactions(): Promise<void> {
  const listEl = requireEl<HTMLElement>('factionList');
  const statusEl = requireEl<HTMLElement>('factionStatus');
  listEl.replaceChildren();

  let factions: Faction[];
  try {
    factions = await send<Faction[]>('getFactions');
  } catch (err) {
    setStatus(statusEl, `Could not load factions: ${(err as Error).message}`, 'error');
    return;
  }

  setStatus(statusEl, '', '');
  for (const faction of factions) {
    const row = document.createElement('div');
    row.className = 'faction-row';

    const swatch = document.createElement('span');
    swatch.className = 'faction-swatch';
    swatch.style.backgroundColor = faction.color;
    row.appendChild(swatch);

    const name = document.createElement('span');
    name.className = 'faction-name';
    name.textContent = faction.name;
    row.appendChild(name);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete faction "${faction.name}"? Students assigned to it become unassigned.`)) return;
      try {
        await send('deleteFaction', { id: faction.id });
        await loadFactions();
      } catch (err) {
        setStatus(statusEl, `Could not delete: ${(err as Error).message}`, 'error');
      }
    });
    row.appendChild(deleteBtn);

    listEl.appendChild(row);
  }
}

async function addFaction(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const statusEl = requireEl<HTMLElement>('factionStatus');
  const nameInput = requireEl<HTMLInputElement>('factionName');
  const colorInput = requireEl<HTMLInputElement>('factionColor');
  const name = nameInput.value.trim();
  const color = colorInput.value;

  if (!name) return;

  try {
    await send('saveFaction', { name, color });
    nameInput.value = '';
    await loadFactions();
  } catch (err) {
    setStatus(statusEl, `Could not add faction: ${(err as Error).message}`, 'error');
  }
}

// --- Intrastek ---
// Settings live in storage.local (never sync: the key is personal). The
// options page writes them directly; the background reads them per call.

function intrastekForm(): { apiUrl: string; apiKey: string } {
  return {
    apiUrl: requireEl<HTMLInputElement>('intrastekApiUrl').value.trim().replace(/\/+$/, '') || INTRASTEK_API_URL_DEFAULT,
    apiKey: requireEl<HTMLInputElement>('intrastekApiKey').value.trim(),
  };
}

// Synchronous so the permission request stays the first await of the click
// handler (Firefox drops the user gesture after any other await).
function originOf(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('the URL must start with https://');
  return url.origin;
}

async function requestOrigin(apiUrl: string, statusEl: HTMLElement): Promise<boolean> {
  let origin: string;
  try {
    origin = originOf(apiUrl);
  } catch (err) {
    setStatus(statusEl, `Invalid URL: ${(err as Error).message}`, 'error');
    return false;
  }
  try {
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      setStatus(statusEl, `Permission to contact ${origin} was not granted. Click again and accept the browser's prompt.`, 'error');
      return false;
    }
  } catch (err) {
    setStatus(statusEl, `Could not request permission for ${origin}: ${(err as Error).message}`, 'error');
    return false;
  }
  return true;
}

let savedDefaultGroupId = '';

function renderMe(me: IntrastekMe | null): void {
  const box = requireEl<HTMLElement>('intrastekMe');
  box.replaceChildren();
  box.hidden = !me;
  if (!me) return;
  const lines = [
    `Connected as ${me.user.firstName} ${me.user.lastName} (${me.user.email})`,
    `Role: ${me.isAdmin ? 'admin (applies changes directly)' : 'teacher (proposals, applied once an admin approves)'}`,
    `Scopes: ${me.scopes.length ? me.scopes.join(', ') : 'none'}`,
    `Groups: ${me.groups.length ? me.groups.map((g) => g.name).join(', ') : 'none'}`,
  ];
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    box.appendChild(div);
  }
}

function fillGroupSelect(me: IntrastekMe | null): void {
  const select = requireEl<HTMLSelectElement>('intrastekDefaultGroup');
  select.replaceChildren();
  if (!me || !me.groups.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = me ? 'No group available for this key' : 'Test the connection to load your groups';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  for (const group of me.groups) {
    const opt = document.createElement('option');
    opt.value = group.id;
    opt.textContent = group.id === me.defaultGroupId ? `${group.name} (my group)` : group.name;
    select.appendChild(opt);
  }
  const wanted = me.groups.some((g) => g.id === savedDefaultGroupId) ? savedDefaultGroupId : me.defaultGroupId;
  select.value = wanted && me.groups.some((g) => g.id === wanted) ? wanted : me.groups[0].id;
  select.disabled = false;
}

async function fetchMe(override?: { apiUrl: string; apiKey: string }): Promise<IntrastekResponse<IntrastekMe>> {
  return send<IntrastekResponse<IntrastekMe>>('intrastekMe', override);
}

async function loadIntrastek(): Promise<void> {
  const stored = await browser.storage.local.get({
    [INTRASTEK_API_URL_KEY]: INTRASTEK_API_URL_DEFAULT,
    [INTRASTEK_API_KEY_KEY]: '',
    [INTRASTEK_DEFAULT_GROUP_KEY]: '',
  });
  requireEl<HTMLInputElement>('intrastekApiUrl').value = String(stored[INTRASTEK_API_URL_KEY] || INTRASTEK_API_URL_DEFAULT);
  requireEl<HTMLInputElement>('intrastekApiKey').value = String(stored[INTRASTEK_API_KEY_KEY] || '');
  savedDefaultGroupId = String(stored[INTRASTEK_DEFAULT_GROUP_KEY] || '');
  if (!stored[INTRASTEK_API_KEY_KEY]) return;
  // Silent: only fills the group select; errors show up on Test connection.
  try {
    const res = await fetchMe();
    if (res.ok) {
      fillGroupSelect(res.data);
      renderMe(res.data);
    }
  } catch (err) {
    console.error(err);
  }
}

async function saveIntrastek(): Promise<void> {
  const statusEl = requireEl<HTMLElement>('intrastekStatus');
  const { apiUrl, apiKey } = intrastekForm();
  if (apiKey && !(await requestOrigin(apiUrl, statusEl))) return;
  const select = requireEl<HTMLSelectElement>('intrastekDefaultGroup');
  const values: Record<string, unknown> = { [INTRASTEK_API_URL_KEY]: apiUrl };
  if (!select.disabled && select.value) {
    values[INTRASTEK_DEFAULT_GROUP_KEY] = select.value;
    savedDefaultGroupId = select.value;
  }
  await browser.storage.local.set(values);
  if (apiKey) {
    await browser.storage.local.set({ [INTRASTEK_API_KEY_KEY]: apiKey });
    setStatus(statusEl, 'Saved.', 'success');
  } else {
    await browser.storage.local.remove(INTRASTEK_API_KEY_KEY);
    renderMe(null);
    fillGroupSelect(null);
    setStatus(statusEl, 'Saved without a key: the Intrastek feature is off.', 'success');
  }
}

async function testIntrastek(): Promise<void> {
  const statusEl = requireEl<HTMLElement>('intrastekStatus');
  const form = intrastekForm();
  if (!form.apiKey) {
    setStatus(statusEl, 'Paste your extension key first.', 'error');
    return;
  }
  if (!(await requestOrigin(form.apiUrl, statusEl))) return;
  setStatus(statusEl, 'Testing…', '');
  let res: IntrastekResponse<IntrastekMe>;
  try {
    res = await fetchMe(form);
  } catch (err) {
    setStatus(statusEl, `Test failed: ${(err as Error).message}`, 'error');
    return;
  }
  if (!res.ok) {
    renderMe(null);
    setStatus(statusEl, `Test failed: ${res.message}`, 'error');
    return;
  }
  renderMe(res.data);
  fillGroupSelect(res.data);
  setStatus(statusEl, 'Connection OK. Click Save to keep these settings.', 'success');
}

requireEl<HTMLInputElement>('intrastekShowKey').addEventListener('change', (ev) => {
  requireEl<HTMLInputElement>('intrastekApiKey').type = (ev.target as HTMLInputElement).checked ? 'text' : 'password';
});
requireEl<HTMLButtonElement>('intrastekSave').addEventListener('click', () => void saveIntrastek());
requireEl<HTMLButtonElement>('intrastekTest').addEventListener('click', () => void testIntrastek());
void loadIntrastek();

requireEl<HTMLButtonElement>('saveSettings').addEventListener('click', saveSettings);
requireEl<HTMLFormElement>('factionForm').addEventListener('submit', addFaction);

loadSettings().then(loadFactions);
