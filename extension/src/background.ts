import browser from 'webextension-polyfill';
import type {
  Settings,
  Faction,
  AssignmentsMap,
  Message,
  SetAssignmentPayload,
  SaveFactionPayload,
  UpdateFactionPayload,
  DeleteFactionPayload,
} from './types';

const DEFAULT_SETTINGS: Settings = { apiBaseUrl: '', apiToken: '' };

async function getSettings(): Promise<Settings> {
  const stored = (await browser.storage.sync.get(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  )) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T | null> {
  const { apiBaseUrl, apiToken } = await getSettings();
  if (!apiBaseUrl) {
    throw new Error('Intrafeur Toolbox is not configured yet: open the extension options and set the API URL.');
  }
  if (!apiToken) {
    throw new Error(
      'Intrafeur Toolbox has no API token saved on this browser: open the extension options, paste the shared token in, and click Save.',
    );
  }

  const origin = new URL(apiBaseUrl).origin;
  const granted = await browser.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) {
    throw new Error(
      `This browser has not granted Intrafeur Toolbox access to ${origin}: open the extension options and click Save connection again to re-request it.`,
    );
  }

  const url = `${apiBaseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API request failed (${response.status}): ${body}`);
  }

  if (response.status === 204) return null;
  return response.json() as Promise<T>;
}

const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
  getFactions: () => apiFetch<Faction[]>('/factions'),
  getAssignments: () => apiFetch<AssignmentsMap>('/assignments'),
  setAssignment: (payload) => {
    const { email, factionId } = payload as SetAssignmentPayload;
    return apiFetch(`/assignments/${encodeURIComponent(email)}`, {
      method: 'PUT',
      body: JSON.stringify({ factionId }),
    });
  },
  saveFaction: (payload) => {
    const { name, color } = payload as SaveFactionPayload;
    return apiFetch('/factions', { method: 'POST', body: JSON.stringify({ name, color }) });
  },
  updateFaction: (payload) => {
    const { id, name, color } = payload as UpdateFactionPayload;
    return apiFetch(`/factions/${id}`, { method: 'PATCH', body: JSON.stringify({ name, color }) });
  },
  deleteFaction: (payload) => {
    const { id } = payload as DeleteFactionPayload;
    return apiFetch(`/factions/${id}`, { method: 'DELETE' });
  },
  getSettings: () => getSettings(),
  saveSettings: async (payload) => {
    await browser.storage.sync.set(payload as Record<string, unknown>);
    return true;
  },
};

// webextension-polyfill lets a listener return a Promise directly (on both
// Chrome and Firefox) instead of juggling sendResponse + `return true`.
browser.runtime.onMessage.addListener((message: unknown) => {
  const { type, payload } = (message || {}) as Message;
  const handler = handlers[type];
  if (!handler) {
    return Promise.reject(new Error(`Unknown message type: ${type}`));
  }
  return handler(payload || {});
});
