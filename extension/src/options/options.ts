import browser from 'webextension-polyfill';
import type { Faction, Settings, MessageType } from '../types';

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

requireEl<HTMLButtonElement>('saveSettings').addEventListener('click', saveSettings);
requireEl<HTMLFormElement>('factionForm').addEventListener('submit', addFaction);

loadSettings().then(loadFactions);
