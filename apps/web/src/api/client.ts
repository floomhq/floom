// Tiny fetch wrapper around the Floom backend API.
import type {
  HubApp,
  AppDetail,
  PickResult,
  ParseResult,
  RunRecord,
  SessionMePayload,
  MeRunSummary,
  MeRunDetail,
  ReviewSummary,
  Review,
  ConnectionRecord,
  DetectedApp,
  CreatorApp,
  CreatorRun,
} from '../lib/types';

const API_BASE = '';

export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code: string | null = null;
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string; code?: string };
      msg = j.error || text;
      code = j.code || null;
    } catch {
      // non-JSON error
    }
    throw new ApiError(msg || `${res.status} ${res.statusText}`, res.status, code);
  }
  return (await res.json()) as T;
}

export function getHub(): Promise<HubApp[]> {
  return request<HubApp[]>('/api/hub');
}

export function getApp(slug: string): Promise<AppDetail> {
  return request<AppDetail>(`/api/hub/${slug}`);
}

export function pickApps(prompt: string, limit = 3): Promise<{ apps: PickResult[] }> {
  return request('/api/pick', {
    method: 'POST',
    body: JSON.stringify({ prompt, limit }),
  });
}

export function parsePrompt(
  prompt: string,
  appSlug: string,
  action?: string,
): Promise<ParseResult> {
  return request('/api/parse', {
    method: 'POST',
    body: JSON.stringify({ prompt, app_slug: appSlug, action }),
  });
}

export function startRun(
  appSlug: string,
  inputs: Record<string, unknown>,
  threadId?: string,
  action?: string,
): Promise<{ run_id: string; status: string }> {
  return request('/api/run', {
    method: 'POST',
    body: JSON.stringify({ app_slug: appSlug, inputs, thread_id: threadId, action }),
  });
}

export function getRun(runId: string): Promise<RunRecord> {
  return request<RunRecord>(`/api/run/${runId}`);
}

export interface RunStreamHandlers {
  onLog?: (line: { stream: 'stdout' | 'stderr'; text: string; ts: number }) => void;
  onStatus?: (run: RunRecord) => void;
  onError?: (err: Error) => void;
}

/**
 * Open an SSE connection to /api/run/:id/stream. Returns a cleanup function.
 *
 * The SSE stream can drop mid-run (mobile network switches, proxy timeouts,
 * ERR_NETWORK_CHANGED, etc.). When that happens we fall back to polling
 * /api/run/:id every 1500ms so the UI still advances to `done`.
 *
 * A belt-and-suspenders polling watchdog also runs for the first ~4 seconds
 * of every run: if no SSE event has been received by then, polling starts
 * regardless. This catches the "SSE never connects" failure mode that shows
 * up as a stuck "Starting container…" on clients that silently drop the
 * connection before it opens.
 */
export function streamRun(runId: string, handlers: RunStreamHandlers): () => void {
  const es = new EventSource(`/api/run/${runId}/stream`);
  let closed = false;
  let done = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let sawEvent = false;

  const markDone = (run: RunRecord) => {
    if (done) return;
    done = true;
    handlers.onStatus?.(run);
    close();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      es.close();
    } catch {
      // ignore
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  const startPolling = () => {
    if (pollTimer || done || closed) return;
    const poll = async () => {
      if (done || closed) return;
      try {
        const run = await getRun(runId);
        // Forward status updates even for pending/running states so the UI
        // can show progress hints when SSE is unavailable.
        if (!done && ['success', 'error', 'timeout'].includes(run.status)) {
          markDone(run);
        }
      } catch {
        // Transient network error, try again on the next tick.
      }
    };
    // Kick off an immediate poll so the UI doesn't have to wait 1.5s.
    void poll();
    pollTimer = setInterval(poll, 1500);
  };

  es.addEventListener('log', (evt) => {
    sawEvent = true;
    try {
      const data = JSON.parse((evt as MessageEvent).data);
      handlers.onLog?.(data);
    } catch {
      // ignore
    }
  });

  es.addEventListener('status', (evt) => {
    sawEvent = true;
    try {
      const data = JSON.parse((evt as MessageEvent).data) as RunRecord;
      if (['success', 'error', 'timeout'].includes(data.status)) {
        markDone(data);
      } else {
        handlers.onStatus?.(data);
      }
    } catch {
      // ignore
    }
  });

  es.onerror = () => {
    // Don't surface the error to the user yet. Start polling instead; if
    // the run is already finished we'll pick it up on the first poll.
    handlers.onError?.(new Error('Stream disconnected'));
    startPolling();
  };

  // Watchdog: if no SSE event fires within 4 seconds, assume the stream
  // silently failed to connect and start polling anyway.
  watchdog = setTimeout(() => {
    if (!sawEvent && !done && !closed) {
      startPolling();
    }
  }, 4000);

  return close;
}

export function createThread(): Promise<{ id: string }> {
  return request('/api/thread', { method: 'POST' });
}

export function saveTurn(
  threadId: string,
  kind: 'user' | 'assistant',
  payload: unknown,
): Promise<{ id: string; turn_index: number }> {
  return request(`/api/thread/${threadId}/turn`, {
    method: 'POST',
    body: JSON.stringify({ kind, payload }),
  });
}

// ---------- W4-minimal: session + auth ----------

export function getSessionMe(): Promise<SessionMePayload> {
  return request<SessionMePayload>('/api/session/me');
}

// Workspace switching UI is deferred — see docs/DEFERRED-UI.md and
// feature/ui-workspace-switcher. The backend /api/session/switch-workspace
// route stays live; the client wrapper is restored on that branch.

// Better Auth endpoints are mounted at /auth/* in cloud mode. The UI calls
// them directly; in OSS mode these 404, and the UI falls back to a
// "cloud-mode not enabled" error state on the /login page.
export function signInWithPassword(email: string, password: string): Promise<unknown> {
  return request('/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function signUpWithPassword(
  email: string,
  password: string,
  name?: string,
): Promise<unknown> {
  return request('/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });
}

export function sendMagicLink(email: string, callbackURL?: string): Promise<unknown> {
  return request('/auth/sign-in/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email, callbackURL: callbackURL || '/me' }),
  });
}

export function signOut(): Promise<unknown> {
  return request('/auth/sign-out', { method: 'POST', body: JSON.stringify({}) });
}

// W4-minimal gap close: wire /me/settings to the real Better Auth endpoints
// that ship in 1.6.3. `updateUser` supports name + image; `changePassword`
// verifies the current password server-side; `deleteUser` requires the
// current password to prevent hostile session takeovers.
export function updateAuthUser(body: {
  name?: string;
  image?: string | null;
}): Promise<{ status: boolean }> {
  return request('/auth/update-user', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function changeAuthPassword(body: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}): Promise<{ token: string | null; user: { id: string; email: string; name: string } }> {
  return request('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteAuthUser(body: {
  password?: string;
  callbackURL?: string;
}): Promise<{ success: boolean; message: string }> {
  return request('/auth/delete-user', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Social sign-in: Better Auth expects a redirect-mode GET, but the UI
// fires window.location. We expose the URL here for callers to read.
export function socialSignInUrl(provider: 'github' | 'google', callbackURL = '/me'): string {
  return `/auth/sign-in/social?provider=${provider}&callbackURL=${encodeURIComponent(callbackURL)}`;
}

// ---------- W4-minimal: runs history + detail ----------

export function getMyRuns(limit = 50): Promise<{ runs: MeRunSummary[] }> {
  return request<{ runs: MeRunSummary[] }>(`/api/me/runs?limit=${limit}`);
}

export function getMyRun(runId: string): Promise<MeRunDetail> {
  return request<MeRunDetail>(`/api/me/runs/${runId}`);
}

// ---------- W4-minimal: reviews ----------

export function getAppReviews(slug: string, limit = 20): Promise<{
  summary: ReviewSummary;
  reviews: Review[];
}> {
  return request(`/api/apps/${slug}/reviews?limit=${limit}`);
}

export function postReview(
  slug: string,
  body: { rating: number; title?: string; body?: string },
): Promise<{ review: Review }> {
  return request(`/api/apps/${slug}/reviews`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------- W4-minimal: connections ----------

export function listConnections(): Promise<{ connections: ConnectionRecord[] }> {
  return request('/api/connections');
}

export function initiateConnection(
  provider: string,
  callback_url?: string,
): Promise<{ auth_url: string; connection_id: string; provider: string; expires_at: string }> {
  return request('/api/connections/initiate', {
    method: 'POST',
    body: JSON.stringify({ provider, callback_url }),
  });
}

export function revokeConnectionApi(provider: string): Promise<{ ok: boolean }> {
  return request(`/api/connections/${provider}`, { method: 'DELETE' });
}

// ---------- W4-minimal: hub publish + creator ----------

export function detectApp(
  openapi_url: string,
  name?: string,
  slug?: string,
): Promise<DetectedApp> {
  return request('/api/hub/detect', {
    method: 'POST',
    body: JSON.stringify({ openapi_url, name, slug }),
  });
}

export function ingestApp(body: {
  openapi_url: string;
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
}): Promise<{ slug: string; name: string; created: boolean }> {
  return request('/api/hub/ingest', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function getMyApps(): Promise<{ apps: CreatorApp[] }> {
  return request('/api/hub/mine');
}

export function getAppRuns(
  slug: string,
  limit = 20,
): Promise<{ app: { slug: string; name: string; description: string; icon: string | null }; runs: CreatorRun[] }> {
  return request(`/api/hub/${slug}/runs?limit=${limit}`);
}

export function deleteApp(slug: string): Promise<{ ok: true }> {
  return request(`/api/hub/${slug}`, { method: 'DELETE' });
}

// ---------- W4-minimal: feedback ----------

export function postFeedback(body: { text: string; email?: string; url?: string }): Promise<{
  ok: true;
  id: string;
}> {
  return request('/api/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
