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
  DetectedApp,
  CreatorApp,
  CreatorRun,
  JobRecord,
  UserSecretsList,
  SecretPolicy,
  SecretPoliciesResponse,
} from '../lib/types';

const API_BASE = '';

export class ApiError extends Error {
  status: number;
  code: string | null;
  /**
   * Full parsed JSON body from the error response, when the server
   * returned structured data (e.g. `slug_taken` carries `suggestions[]`).
   * Null for plain-text errors or when JSON parsing failed.
   */
  payload: unknown;
  constructor(
    message: string,
    status: number,
    code: string | null = null,
    payload: unknown = null,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
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
    let payload: unknown = null;
    try {
      const j = JSON.parse(text) as { error?: string; code?: string };
      msg = j.error || text;
      code = j.code || null;
      payload = j;
    } catch {
      // non-JSON error
    }
    throw new ApiError(
      msg || `${res.status} ${res.statusText}`,
      res.status,
      code,
      payload,
    );
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

/**
 * Mark a run as publicly shareable and get back the permalink.
 *
 * Security (P0 2026-04-20): /api/run/:id is owner-only by default.
 * Before handing out a /r/:id URL, the creator must hit this endpoint so
 * the server flips `runs.is_public`. After that, anon callers can GET
 * the run via /api/run/:id and receive a redacted view (outputs only,
 * no inputs, no logs). Only the owner can call this; non-owners get 404.
 */
export interface ShareRunResponse {
  share_url: string;
  public_view_url: string;
  is_public: boolean;
  app_slug: string | null;
}

export function shareRun(runId: string): Promise<ShareRunResponse> {
  return request<ShareRunResponse>(`/api/run/${runId}/share`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
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

// ---------- v0.3.0 async job queue ----------

export interface StartJobResponse {
  job_id: string;
  status: 'queued';
  poll_url: string;
  cancel_url: string;
  webhook_url_template: string;
}

export function startJob(
  appSlug: string,
  inputs: Record<string, unknown>,
  action?: string,
): Promise<StartJobResponse> {
  return request<StartJobResponse>(`/api/${appSlug}/jobs`, {
    method: 'POST',
    body: JSON.stringify({ action, inputs }),
  });
}

export function getJob(appSlug: string, jobId: string): Promise<JobRecord> {
  return request<JobRecord>(`/api/${appSlug}/jobs/${jobId}`);
}

export function cancelJob(appSlug: string, jobId: string): Promise<JobRecord> {
  return request<JobRecord>(`/api/${appSlug}/jobs/${jobId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ---------- Triggers (unified schedule + webhook) ----------

export interface TriggerPublic {
  id: string;
  app_id: string;
  app_slug?: string;
  action: string;
  inputs: Record<string, unknown>;
  trigger_type: 'schedule' | 'webhook';
  cron_expression: string | null;
  tz: string | null;
  webhook_url_path: string | null;
  webhook_secret_set: boolean;
  next_run_at: number | null;
  last_fired_at: number | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateTriggerResponse {
  trigger: TriggerPublic;
  // Only present on webhook creates.
  webhook_url?: string;
  webhook_secret?: string;
  webhook_url_path?: string;
}

export function listMyTriggers(): Promise<{ triggers: TriggerPublic[] }> {
  return request<{ triggers: TriggerPublic[] }>('/api/me/triggers');
}

export function createScheduleTrigger(
  slug: string,
  body: {
    action: string;
    cron_expression: string;
    tz?: string;
    inputs?: Record<string, unknown>;
  },
): Promise<CreateTriggerResponse> {
  return request<CreateTriggerResponse>(`/api/hub/${slug}/triggers`, {
    method: 'POST',
    body: JSON.stringify({ trigger_type: 'schedule', ...body }),
  });
}

export function createWebhookTrigger(
  slug: string,
  body: { action: string; inputs?: Record<string, unknown> },
): Promise<CreateTriggerResponse> {
  return request<CreateTriggerResponse>(`/api/hub/${slug}/triggers`, {
    method: 'POST',
    body: JSON.stringify({ trigger_type: 'webhook', ...body }),
  });
}

export function updateTrigger(
  id: string,
  body: {
    enabled?: boolean;
    cron_expression?: string;
    tz?: string;
    inputs?: Record<string, unknown>;
    action?: string;
  },
): Promise<{ trigger: TriggerPublic }> {
  return request<{ trigger: TriggerPublic }>(`/api/me/triggers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteTrigger(id: string): Promise<{ ok: true; id: string }> {
  return request<{ ok: true; id: string }>(`/api/me/triggers/${id}`, {
    method: 'DELETE',
  });
}

/**
 * Poll an async job until it reaches a terminal state. Uses a gentle 1.5s
 * interval to mirror the run-stream polling fallback. Returns a cleanup
 * function that cancels the poll without aborting the job itself.
 */
export function pollJob(
  appSlug: string,
  jobId: string,
  handlers: {
    onUpdate: (job: JobRecord) => void;
    onDone: (job: JobRecord) => void;
    onError?: (err: Error) => void;
  },
  intervalMs = 1500,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const job = await getJob(appSlug, jobId);
      if (stopped) return;
      const terminal: JobRecord['status'][] = ['succeeded', 'failed', 'cancelled'];
      if (terminal.includes(job.status)) {
        handlers.onDone(job);
        stop();
      } else {
        handlers.onUpdate(job);
      }
    } catch (err) {
      handlers.onError?.(err as Error);
    }
  };

  void tick();
  timer = setInterval(tick, intervalMs);
  return stop;
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

// Magic link sign-in was removed 2026-04-17 (PR #5 dropped the UI; this
// branch disables the Better Auth plugin on the server so the endpoint
// returns 404). The exported helper is gone to prevent any future caller
// from reintroducing the surface. Use email+password or OAuth instead.

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

// Note: the previous `getMyTools` / `MeToolSummary` helper (v17) was
// removed when /me dropped the "Your tools" label. The MePage component
// now derives its "Your apps" list (apps the user has run) directly from
// `getMyRuns`, so this extra layer was dead code — and its "tools"
// vocabulary conflicted with the new IA where /me only speaks about
// "apps".

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

// Connections (Composio OAuth to 150+ tools) UI is deferred — see
// docs/DEFERRED-UI.md and feature/ui-composio-connections. The backend
// /api/connections routes stay live; the client wrappers are restored on
// that branch.

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
  visibility?: 'public' | 'private' | 'auth-required';
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

// Issue #129 (2026-04-19): owner can flip visibility between public and
// private after publish without re-ingesting. Used by /studio/:slug toggle.
export function updateAppVisibility(
  slug: string,
  visibility: 'public' | 'private' | 'auth-required',
): Promise<{ ok: true; slug: string; visibility: string }> {
  return request(`/api/hub/${slug}`, {
    method: 'PATCH',
    body: JSON.stringify({ visibility }),
  });
}

/**
 * Audit 2026-04-20 (Fix 3): owner can pin a "primary_action" so
 * multi-action apps default to the creator-chosen tab on /p/:slug.
 * Pass `null` to clear the pin (falls back to first action).
 */
export function updateAppPrimaryAction(
  slug: string,
  primaryAction: string | null,
): Promise<{ ok: true; slug: string; primary_action: string | null }> {
  return request(`/api/hub/${slug}`, {
    method: 'PATCH',
    body: JSON.stringify({ primary_action: primaryAction }),
  });
}

// ---------- W2.2 custom renderer upload ----------

export interface UploadRendererResponse {
  slug: string;
  bytes: number;
  source_hash: string;
  output_shape: string;
  compiled_at: string;
}

/**
 * Upload a creator's TSX renderer source. The backend writes it to a temp
 * file, compiles via esbuild (external react/react-dom), and serves the
 * bundle at GET /renderer/:slug/bundle.js. See
 * apps/server/src/services/renderer-bundler.ts for the compile pipeline.
 */
export function uploadRenderer(
  slug: string,
  source: string,
  outputShape?: string,
): Promise<UploadRendererResponse> {
  return request(`/api/hub/${slug}/renderer`, {
    method: 'POST',
    body: JSON.stringify({ source, output_shape: outputShape }),
  });
}

export function deleteRenderer(slug: string): Promise<{ ok: true; slug: string }> {
  return request(`/api/hub/${slug}/renderer`, { method: 'DELETE' });
}

// ---------- v15.2: per-user encrypted secrets vault ----------
//
// Thin wrappers around /api/secrets (masked-list, upsert, delete). The
// server never echoes plaintext back; the list endpoint returns
// { entries: [{ key, updated_at }] } so the UI can render "set" vs
// "not set" without exposing the value.

export function listSecrets(): Promise<UserSecretsList> {
  return request<UserSecretsList>('/api/secrets', { method: 'GET' });
}

export function setSecret(
  key: string,
  value: string,
): Promise<{ ok: true; key: string }> {
  return request('/api/secrets', {
    method: 'POST',
    body: JSON.stringify({ key, value }),
  });
}

export function deleteSecret(key: string): Promise<{ ok: true; removed: boolean }> {
  return request(`/api/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

// ---------- secrets-policy: per-app creator-override vs user-vault ----------
//
// Thin wrappers around /api/me/apps/:slug/secret-policies and
// /api/me/apps/:slug/creator-secrets/:key. The list endpoint is open to
// any authenticated viewer; the mutation endpoints require the caller
// to be the app's creator and the policy/key to be valid for the app.
// Plaintext values never flow back from the server — the list response
// only reports `creator_has_value: boolean`.

export function getSecretPolicies(slug: string): Promise<SecretPoliciesResponse> {
  return request<SecretPoliciesResponse>(
    `/api/me/apps/${encodeURIComponent(slug)}/secret-policies`,
  );
}

export function setSecretPolicy(
  slug: string,
  key: string,
  policy: SecretPolicy,
): Promise<{ ok: true; policy: SecretPolicy }> {
  return request(
    `/api/me/apps/${encodeURIComponent(slug)}/secret-policies/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ policy }),
    },
  );
}

export function setCreatorSecret(
  slug: string,
  key: string,
  value: string,
): Promise<{ ok: true; key: string }> {
  return request(
    `/api/me/apps/${encodeURIComponent(slug)}/creator-secrets/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ value }),
    },
  );
}

export function deleteCreatorSecret(
  slug: string,
  key: string,
): Promise<{ ok: true; removed: boolean }> {
  return request(
    `/api/me/apps/${encodeURIComponent(slug)}/creator-secrets/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );
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
