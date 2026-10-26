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
  IntrastekEventState,
  IntrastekMe,
  IntrastekMePayload,
  IntrastekProposalPayload,
  IntrastekRemovePayload,
  IntrastekResponse,
  IntrastekSetPayload,
  IntrastekStatusPayload,
  IntrastekWriteResult,
} from './types';
import {
  INTRASTEK_API_KEY_KEY,
  INTRASTEK_API_URL_DEFAULT,
  INTRASTEK_API_URL_KEY,
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
    throw new Error('Intrafeur is not configured yet: open the extension options and set the API URL.');
  }
  if (!apiToken) {
    throw new Error(
      'Intrafeur has no API token saved on this browser: open the extension options, paste the shared token in, and click Save.',
    );
  }

  const origin = new URL(apiBaseUrl).origin;
  const granted = await browser.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) {
    throw new Error(
      `This browser has not granted Intrafeur access to ${origin}: open the extension options and click Save connection again to re-request it.`,
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

// --- Intrastek ---
// Separate from apiFetch: different settings (storage.local, never sync),
// different auth header (X-Api-Key), and errors are returned as an
// IntrastekResponse envelope instead of thrown, so the status survives the
// message passing.
class IntrastekHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_CHUNK = 200;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

async function intrastekSettings(override?: IntrastekMePayload): Promise<{ apiUrl: string; apiKey: string }> {
  const stored = await browser.storage.local.get({
    [INTRASTEK_API_URL_KEY]: INTRASTEK_API_URL_DEFAULT,
    [INTRASTEK_API_KEY_KEY]: '',
  });
  const apiUrl = String(override?.apiUrl || stored[INTRASTEK_API_URL_KEY] || INTRASTEK_API_URL_DEFAULT).trim();
  const apiKey = String(override?.apiKey ?? stored[INTRASTEK_API_KEY_KEY] ?? '').trim();
  return { apiUrl: apiUrl.replace(/\/+$/, ''), apiKey };
}

function intrastekErrorMessage(status: number, body: unknown): string {
  const raw = (body as { message?: unknown } | null)?.message;
  const apiMessage = Array.isArray(raw) ? raw.map(String).join(', ') : typeof raw === 'string' ? raw : '';
  if (status === 401) return 'Invalid or expired Intrastek key';
  if (status === 403 && /disabled/i.test(apiMessage)) return 'Intrastek extension feature is disabled by an admin';
  if (status === 503) return "Intrastek can't reach the intranet";
  return apiMessage || `Intrastek request failed (${status})`;
}

async function intrastekFetch<T>(path: string, options: RequestInit = {}, override?: IntrastekMePayload): Promise<T> {
  const { apiUrl, apiKey } = await intrastekSettings(override);
  if (!apiKey) {
    throw new IntrastekHttpError(0, 'No Intrastek key saved: open the extension options to set one.');
  }
  let origin: string;
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
    origin = url.origin;
  } catch {
    throw new IntrastekHttpError(0, `Invalid Intrastek API URL: ${apiUrl}`);
  }
  const granted = await browser.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) {
    throw new IntrastekHttpError(
      0,
      `This browser has not granted Intrafeur access to ${origin}: open the extension options and click Save in the Intrastek section.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        // Only with a body: Fastify rejects an empty body declared as JSON
        // (approve / delete calls have none).
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        'X-Api-Key': apiKey,
      },
    });
  } catch (err) {
    throw new IntrastekHttpError(0, `Can't reach Intrastek at ${origin}: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new IntrastekHttpError(response.status, intrastekErrorMessage(response.status, body));
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

async function intrastekCall<T>(run: () => Promise<T>): Promise<IntrastekResponse<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (err) {
    if (err instanceof IntrastekHttpError) return { ok: false, status: err.status, message: err.message };
    return { ok: false, status: 0, message: (err as Error)?.message || String(err) };
  }
}

// Payloads come from content scripts that read ids off the intranet DOM:
// re-validated here before they reach a URL.
function eventIdOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new IntrastekHttpError(0, 'Invalid intranet event id');
  }
  return value;
}

function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new IntrastekHttpError(0, `Invalid ${what}`);
  return encodeURIComponent(value);
}

async function intrastekStatus(eventIds: unknown): Promise<IntrastekEventState[]> {
  if (!Array.isArray(eventIds)) throw new IntrastekHttpError(0, 'Invalid event ids');
  const ids = Array.from(new Set(eventIds.map(eventIdOf)));
  const states: IntrastekEventState[] = [];
  for (let i = 0; i < ids.length; i += STATUS_CHUNK) {
    const chunk = ids.slice(i, i + STATUS_CHUNK);
    states.push(
      ...(await intrastekFetch<IntrastekEventState[]>('/extension/events/status', {
        method: 'POST',
        body: JSON.stringify({ eventIds: chunk }),
      })),
    );
  }
  return states;
}

const intrastekHandlers: Record<string, (payload: unknown) => Promise<unknown>> = {
  intrastekMe: (payload) =>
    intrastekCall(() => {
      const { apiUrl, apiKey } = (payload || {}) as IntrastekMePayload;
      // Both or nothing: never send the stored key to an unsaved URL.
      const override = typeof apiUrl === 'string' && typeof apiKey === 'string' ? { apiUrl, apiKey } : undefined;
      return intrastekFetch<IntrastekMe>('/extension/me', {}, override);
    }),
  intrastekStatus: (payload) => intrastekCall(() => intrastekStatus((payload as IntrastekStatusPayload).eventIds)),
  intrastekSet: (payload) =>
    intrastekCall(() => {
      const { eventId, groupId, nbUserAsk } = payload as IntrastekSetPayload;
      if (typeof nbUserAsk !== 'number' || !Number.isSafeInteger(nbUserAsk) || nbUserAsk < 0) {
        throw new IntrastekHttpError(0, 'AERs needed must be a whole number ≥ 0');
      }
      return intrastekFetch<IntrastekWriteResult>(`/extension/events/${eventIdOf(eventId)}`, {
        method: 'PUT',
        body: JSON.stringify({ groupId: decodeURIComponent(idOf(groupId, 'group id')), nbUserAsk }),
      });
    }),
  intrastekRemove: (payload) =>
    intrastekCall(() => {
      const { eventId, groupId, force } = payload as IntrastekRemovePayload;
      // force only when true: a missing param is false under any query
      // parsing, while "false" can be read as truthy.
      const query = `groupId=${idOf(groupId, 'group id')}${force === true ? '&force=true' : ''}`;
      return intrastekFetch<IntrastekWriteResult>(`/extension/events/${eventIdOf(eventId)}?${query}`, {
        method: 'DELETE',
      });
    }),
  intrastekApprove: (payload) =>
    intrastekCall(() => {
      const { proposalId, force } = payload as IntrastekProposalPayload;
      // same rule as intrastekRemove: send force only when true
      const query = force === true ? '?force=true' : '';
      return intrastekFetch<IntrastekWriteResult>(`/extension/proposals/${idOf(proposalId, 'proposal id')}/approve${query}`, {
        method: 'POST',
      });
    }),
  intrastekCancel: (payload) =>
    intrastekCall(() =>
      intrastekFetch<IntrastekWriteResult>(
        `/extension/proposals/${idOf((payload as IntrastekProposalPayload).proposalId, 'proposal id')}`,
        { method: 'DELETE' },
      ),
    ),
};

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
  ...intrastekHandlers,
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
