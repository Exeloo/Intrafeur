import browser from 'webextension-polyfill';
import { initLang } from './i18n/load';
import { t } from './i18n/background';
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
import { INTRASTEK_API_KEY_KEY, INTRASTEK_API_URL_DEFAULT, INTRASTEK_API_URL_KEY } from './types';

// Error messages are localized; awaited before every handler because the
// service worker is usually woken up by the very message it must answer.
// (A callback is passed so later language changes are applied too: load.ts
// only calls setLang on change through `onChange?.(…)`.)
const langReady = initLang(() => undefined);

const DEFAULT_SETTINGS: Settings = { apiBaseUrl: '', apiToken: '' };

async function getSettings(): Promise<Settings> {
  const stored = (await browser.storage.sync.get(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  )) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

// --- Shared fetch core (faction backend + Intrastek) ---

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface FetchSpec {
  baseUrl: string; // no trailing slash
  headers: Record<string, string>;
  invalidUrl: (url: string) => string;
  notGranted: (origin: string) => string;
  unreachable: (origin: string, error: string) => string;
  failed: (status: number, body: string) => string;
}

async function fetchJson<T>(spec: FetchSpec, path: string, options: RequestInit = {}): Promise<T> {
  let origin: string;
  try {
    const url = new URL(spec.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
    origin = url.origin;
  } catch {
    throw new HttpError(0, spec.invalidUrl(spec.baseUrl));
  }
  if (!(await browser.permissions.contains({ origins: [`${origin}/*`] }))) {
    throw new HttpError(0, spec.notGranted(origin));
  }

  let response: Response;
  try {
    response = await fetch(`${spec.baseUrl}${path}`, {
      ...options,
      headers: {
        // Only with a body: Fastify (Intrastek) rejects an empty body declared
        // as JSON, and a bodiless GET then needs no CORS preflight.
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...spec.headers,
      },
    });
  } catch (err) {
    throw new HttpError(0, spec.unreachable(origin, (err as Error)?.message || String(err)));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(response.status, spec.failed(response.status, body));
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

// --- Best-effort read cache ---
// The Chrome service worker dies after ~30 s idle, so this only saves bursts
// (several tabs / re-renders). The promise is stored at call time, so
// concurrent callers share one request; clear() drops in-flight ones too, so
// a read racing a write can't repopulate the cache with pre-write data.
function readCache<T>(ttlMs: number) {
  const entries = new Map<string, { promise: Promise<T>; at: number }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
      const entry = { promise: load(), at: Date.now() };
      entries.set(key, entry);
      entry.promise.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return entry.promise;
    },
    clear: () => entries.clear(),
  };
}

// Shared with other staff: short TTLs.
const factionsCache = readCache<Faction[] | null>(60_000);
const assignmentsCache = readCache<AssignmentsMap | null>(30_000);
const meCache = readCache<IntrastekMe>(5 * 60_000);

function clearFactionCaches(): void {
  factionsCache.clear();
  assignmentsCache.clear();
}

// Registered synchronously so a woken-up service worker gets it too.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && ('apiBaseUrl' in changes || 'apiToken' in changes)) clearFactionCaches();
  if (area === 'local' && (INTRASTEK_API_URL_KEY in changes || INTRASTEK_API_KEY_KEY in changes)) meCache.clear();
});

// --- Faction backend ---

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T | null> {
  const { apiBaseUrl, apiToken } = await getSettings();
  if (!apiBaseUrl) throw new Error(t('notConfigured'));
  if (!apiToken) throw new Error(t('noToken'));
  return fetchJson<T | null>(
    {
      baseUrl: apiBaseUrl.replace(/\/$/, ''),
      headers: { Authorization: `Bearer ${apiToken}` },
      invalidUrl: (url) => t('invalidApiUrl', { url }),
      notGranted: (origin) => t('notGranted', { origin }),
      unreachable: (origin, error) => t('unreachable', { origin, error }),
      failed: (status, body) => t('requestFailed', { status, body }),
    },
    path,
    options,
  );
}

async function connectionKey(): Promise<string> {
  const { apiBaseUrl, apiToken } = await getSettings();
  return `${apiBaseUrl}\n${apiToken}`;
}

// Writes invalidate both caches (deleting a faction also unassigns its students).
function write<T>(run: Promise<T>): Promise<T> {
  return run.finally(clearFactionCaches);
}

// --- Intrastek ---
// Different settings (storage.local, never sync: the key is personal),
// X-Api-Key auth, and errors returned as an IntrastekResponse envelope
// instead of thrown, so the status survives the message passing.

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

function intrastekErrorMessage(status: number, text: string): string {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  const raw = (body as { message?: unknown } | null)?.message;
  const apiMessage = Array.isArray(raw) ? raw.map(String).join(', ') : typeof raw === 'string' ? raw : '';
  if (status === 401) return t('ikInvalidKey');
  if (status === 403 && /disabled/i.test(apiMessage)) return t('ikDisabled');
  if (status === 503) return t('ikNoIntranet');
  return apiMessage || t('ikRequestFailed', { status });
}

async function intrastekFetch<T>(path: string, options: RequestInit = {}, override?: IntrastekMePayload): Promise<T> {
  const { apiUrl, apiKey } = await intrastekSettings(override);
  if (!apiKey) throw new HttpError(0, t('ikNoKey'));
  return fetchJson<T>(
    {
      baseUrl: apiUrl,
      headers: { 'X-Api-Key': apiKey },
      invalidUrl: (url) => t('ikInvalidUrl', { url }),
      notGranted: (origin) => t('ikNotGranted', { origin }),
      unreachable: (origin, error) => t('ikUnreachable', { origin, error }),
      failed: intrastekErrorMessage,
    },
    path,
    options,
  );
}

async function intrastekCall<T>(run: () => Promise<T>): Promise<IntrastekResponse<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, status: err.status, message: err.message };
    return { ok: false, status: 0, message: (err as Error)?.message || String(err) };
  }
}

// Payloads come from content scripts that read ids off the intranet DOM:
// re-validated here before they reach a URL.
function eventIdOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(0, t('ikInvalidEventId'));
  }
  return value;
}

function idOf(value: unknown, invalidMessage: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new HttpError(0, invalidMessage);
  return encodeURIComponent(value);
}

async function intrastekStatus(eventIds: unknown): Promise<IntrastekEventState[]> {
  if (!Array.isArray(eventIds)) throw new HttpError(0, t('ikInvalidEventIds'));
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

async function intrastekMe(payload: unknown): Promise<IntrastekMe> {
  const { apiUrl, apiKey } = (payload || {}) as IntrastekMePayload;
  // Options page "Test connection": both or nothing (never send the stored
  // key to an unsaved URL), and never cached (it must hit the network).
  if (typeof apiUrl === 'string' && typeof apiKey === 'string') {
    return intrastekFetch<IntrastekMe>('/extension/me', {}, { apiUrl, apiKey });
  }
  const { apiUrl: url, apiKey: key } = await intrastekSettings();
  return meCache.get(`${url}\n${key}`, () => intrastekFetch<IntrastekMe>('/extension/me'));
}

const intrastekHandlers: Record<string, (payload: unknown) => Promise<unknown>> = {
  intrastekMe: (payload) => intrastekCall(() => intrastekMe(payload)),
  intrastekStatus: (payload) => intrastekCall(() => intrastekStatus((payload as IntrastekStatusPayload).eventIds)),
  intrastekSet: (payload) =>
    intrastekCall(() => {
      const { eventId, groupId, nbUserAsk } = payload as IntrastekSetPayload;
      if (typeof nbUserAsk !== 'number' || !Number.isSafeInteger(nbUserAsk) || nbUserAsk < 0) {
        throw new HttpError(0, t('ikInvalidAers'));
      }
      return intrastekFetch<IntrastekWriteResult>(`/extension/events/${eventIdOf(eventId)}`, {
        method: 'PUT',
        body: JSON.stringify({ groupId: decodeURIComponent(idOf(groupId, t('ikInvalidGroupId'))), nbUserAsk }),
      });
    }),
  intrastekRemove: (payload) =>
    intrastekCall(() => {
      const { eventId, groupId, force } = payload as IntrastekRemovePayload;
      // force only when true: a missing param is false under any query
      // parsing, while "false" can be read as truthy.
      const query = `groupId=${idOf(groupId, t('ikInvalidGroupId'))}${force === true ? '&force=true' : ''}`;
      return intrastekFetch<IntrastekWriteResult>(`/extension/events/${eventIdOf(eventId)}?${query}`, {
        method: 'DELETE',
      });
    }),
  intrastekApprove: (payload) =>
    intrastekCall(() => {
      const { proposalId, force } = payload as IntrastekProposalPayload;
      // same rule as intrastekRemove: send force only when true
      const query = force === true ? '?force=true' : '';
      return intrastekFetch<IntrastekWriteResult>(
        `/extension/proposals/${idOf(proposalId, t('ikInvalidProposalId'))}/approve${query}`,
        { method: 'POST' },
      );
    }),
  intrastekCancel: (payload) =>
    intrastekCall(() =>
      intrastekFetch<IntrastekWriteResult>(
        `/extension/proposals/${idOf((payload as IntrastekProposalPayload).proposalId, t('ikInvalidProposalId'))}`,
        { method: 'DELETE' },
      ),
    ),
};

const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
  // Keyed by connection too, so a settings change can't serve the old backend's data.
  getFactions: async () => factionsCache.get(await connectionKey(), () => apiFetch<Faction[]>('/factions')),
  getAssignments: async () =>
    assignmentsCache.get(await connectionKey(), () => apiFetch<AssignmentsMap>('/assignments')),
  setAssignment: (payload) => {
    const { email, factionId } = payload as SetAssignmentPayload;
    return write(
      apiFetch(`/assignments/${encodeURIComponent(email)}`, { method: 'PUT', body: JSON.stringify({ factionId }) }),
    );
  },
  saveFaction: (payload) => {
    const { name, color } = payload as SaveFactionPayload;
    return write(apiFetch('/factions', { method: 'POST', body: JSON.stringify({ name, color }) }));
  },
  updateFaction: (payload) => {
    const { id, name, color } = payload as UpdateFactionPayload;
    return write(apiFetch(`/factions/${id}`, { method: 'PATCH', body: JSON.stringify({ name, color }) }));
  },
  deleteFaction: (payload) => {
    const { id } = payload as DeleteFactionPayload;
    return write(apiFetch(`/factions/${id}`, { method: 'DELETE' }));
  },
  getSettings: () => getSettings(),
  saveSettings: async (payload) => {
    await browser.storage.sync.set(payload as Record<string, unknown>);
    clearFactionCaches();
    return true;
  },
  ...intrastekHandlers,
};

// webextension-polyfill lets a listener return a Promise directly (on both
// Chrome and Firefox) instead of juggling sendResponse + `return true`.
browser.runtime.onMessage.addListener((message: unknown) => {
  const { type, payload } = (message || {}) as Message;
  const handler = handlers[type];
  return langReady
    .catch(() => undefined)
    .then(() => {
      if (!handler) throw new Error(t('unknownMessage', { type: String(type) }));
      return handler(payload || {});
    });
});

// First install: open the quick setup page (language, connection keys, features).
browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void browser.tabs.create({ url: browser.runtime.getURL('setup/setup.html') });
});
