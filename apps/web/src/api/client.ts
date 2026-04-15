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
 */
export function streamRun(runId: string, handlers: RunStreamHandlers): () => void {
  const es = new EventSource(`/api/run/${runId}/stream`);

  es.addEventListener('log', (evt) => {
    try {
      const data = JSON.parse((evt as MessageEvent).data);
      handlers.onLog?.(data);
    } catch {
      // ignore
    }
  });

  es.addEventListener('status', (evt) => {
    try {
      const data = JSON.parse((evt as MessageEvent).data);
      handlers.onStatus?.(data);
      if (['success', 'error', 'timeout'].includes(data.status)) {
        es.close();
      }
    } catch {
      // ignore
    }
  });

  es.onerror = () => {
    handlers.onError?.(new Error('Stream disconnected'));
    es.close();
  };

  return () => es.close();
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

export function switchWorkspace(workspace_id: string): Promise<{ ok: true }> {
  return request('/api/session/switch-workspace', {
    method: 'POST',
    body: JSON.stringify({ workspace_id }),
  });
}

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
