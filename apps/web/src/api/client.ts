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
  StudioActivityRun,
  StudioStats,
  UserSecretsList,
  SecretPolicy,
  SecretPoliciesResponse,
} from '../lib/types';
import { track } from '../lib/posthog';
import { serializeInputs } from './serialize-inputs';

// Re-export the file-input helpers so callers that need to show the
// "file too big" error can catch the typed exception without a second
// import path.
export {
  serializeInputs,
  FileInputTooLargeError,
  CsvRowCapExceededError,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_CSV_ROWS,
} from './serialize-inputs';

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
    let msg = '';
    let payload: unknown = null;
    try {
      // Floom routes return `{ error, code }`; Better Auth returns
      // `{ message, code }`. Accept both shapes so error UIs never have
      // to render raw JSON as a fallback.
      const j = JSON.parse(text) as {
        error?: string;
        message?: string;
        code?: string;
      };
      msg = j.error || j.message || '';
      code = j.code || null;
      payload = j;
    } catch {
      // non-JSON error: keep the raw text as the message
      msg = text;
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

/**
 * Sparkline source: 7-day (or N-day) daily run counts for one of the
 * caller's apps. Creator-only; non-owners get 403. Zero-filled so
 * `days.length === days_param`, oldest → newest. Drives the per-card
 * sparkline on /studio (v17 wireframe `studio-my-apps.html`).
 */
export function getAppRunsByDay(
  slug: string,
  days = 7,
): Promise<{ slug: string; days: Array<{ date: string; count: number }> }> {
  return request(`/api/hub/${slug}/runs-by-day?days=${days}`);
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

/**
 * localStorage key for the user's bring-your-own Gemini API key, used by
 * the 3 launch demo apps (lead-scorer / competitor-analyzer /
 * resume-screener) once the 5 free runs per 24h are exhausted. See
 * apps/server/src/lib/byok-gate.ts for the server-side rule.
 *
 * We never send this to analytics. `startRun` attaches it as
 * `X-User-Api-Key` only for the one request and the server injects it
 * per-call (perCallSecrets) without persisting.
 */
export const USER_GEMINI_KEY_STORAGE_KEY = 'floom_user_gemini_key';

/** Read the user's saved Gemini key, if any. SSR-safe and tolerant of
 * storage access failures (private mode, disabled storage, etc.). Returns
 * null for anything < 20 chars so obvious typos don't trigger a request
 * that's guaranteed to 401 downstream. */
export function readUserGeminiKey(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(USER_GEMINI_KEY_STORAGE_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length >= 20 ? trimmed : null;
  } catch {
    return null;
  }
}

export function writeUserGeminiKey(value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(USER_GEMINI_KEY_STORAGE_KEY, value.trim());
  } catch {
    // ignore — caller will just see the next request 429 again.
  }
}

export function clearUserGeminiKey(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(USER_GEMINI_KEY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Shape returned by GET /api/:slug/quota (apps/server/src/routes/run.ts).
 *
 * Two variants:
 *   - `gated: false` → this slug is NOT in BYOK_GATED_SLUGS; the UI should
 *     hide the free-runs strip entirely (no per-IP budget applies).
 *   - `gated: true`  → the 3 launch-demo slugs. Fields tell the UI how
 *     many free runs remain in the rolling 24h window for this caller.
 *     `has_user_key_hint` is a server-side echo of whether we saw a
 *     non-empty X-User-Api-Key header on the request; the authoritative
 *     "do I have a key saved" check still lives in the browser via
 *     readUserGeminiKey(), because the server never persists user keys.
 */
export interface AppQuota {
  gated: boolean;
  slug: string;
  usage?: number;
  limit?: number;
  remaining?: number;
  window_ms?: number;
  has_user_key_hint?: boolean;
}

/**
 * Read-only peek at the caller's BYOK free-run budget for an app.
 * Polling this endpoint does NOT record a run; the server guarantees
 * that only POST /api/run advances the counter. Safe to call from
 * useEffect / useSWR.
 *
 * Errors: resolves to `{ gated: false, slug }` on any HTTP or network
 * failure so the UI strip silently hides instead of showing a broken
 * loading state (the feature is an enhancement, not a hard requirement).
 */
export async function getAppQuota(slug: string): Promise<AppQuota> {
  try {
    const encoded = encodeURIComponent(slug);
    const headers: Record<string, string> = {};
    // Mirror startRun(): if the user has saved a key, send it so the
    // server echoes has_user_key_hint:true and the UI can skip the
    // "add your key" CTA for callers who already have one. The header
    // is a read-only hint in this request path — the server does NOT
    // record anything just because the header is present.
    const userKey = readUserGeminiKey();
    if (userKey) headers['X-User-Api-Key'] = userKey;
    const res = await request<AppQuota>(`/api/${encoded}/quota`, {
      method: 'GET',
      headers,
    });
    return res;
  } catch {
    return { gated: false, slug };
  }
}

export async function startRun(
  appSlug: string,
  inputs: Record<string, unknown>,
  threadId?: string,
  action?: string,
): Promise<{ run_id: string; status: string }> {
  // Analytics (launch-infra #4): fire run_triggered BEFORE the POST lands
  // so we capture even the runs that error out at submit time. The api
  // response shape is {run_id, status}; we don't need to wait for it to
  // classify the event.
  track('run_triggered', { app_slug: appSlug, action: action ?? null });
  // Walk inputs and replace any `File` with the runtime-agnostic
  // FileEnvelope (__file + content_b64). Without this, JSON.stringify
  // drops File to `{}` and the app never receives the bytes. Works for
  // both proxied and docker runtimes — see serialize-inputs.ts.
  const serialized = await serializeInputs(inputs);
  // BYOK (launch 2026-04-21): for the 3 demo slugs the server gates at 5
  // free runs per IP per 24h. If the user has saved a key, attach it so
  // the server uses it instead and bypasses the gate. We always send the
  // header when the key is present — the server ignores it for slugs it
  // doesn't gate, so there's no leakage risk.
  const userKey = readUserGeminiKey();
  const headers: Record<string, string> = {};
  if (userKey) headers['X-User-Api-Key'] = userKey;
  return request('/api/run', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      app_slug: appSlug,
      inputs: serialized,
      thread_id: threadId,
      action,
    }),
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

/**
 * Invite email(s) to collaborate on an app (see #640 / #637).
 *
 * The /api/apps/:slug/invite endpoint is currently a minimal stub that
 * returns `{ ok: true, invite_id: 'stub-<ts>' }` so the Notion-style
 * ShareModal can ship without blocking on the full invite pipeline.
 * Real persistence, email delivery, and accept/revoke flows are tracked
 * in #637.
 */
export type InvitePermission = 'run' | 'view';

export interface InviteRequest {
  emails: string[];
  permission: InvitePermission;
}

export interface InviteResponse {
  ok: boolean;
  invite_id: string;
}

export function inviteToApp(slug: string, body: InviteRequest): Promise<InviteResponse> {
  return request<InviteResponse>(`/api/apps/${encodeURIComponent(slug)}/invite`, {
    method: 'POST',
    body: JSON.stringify(body),
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
    // Analytics (launch-infra #4): classify the terminal state. `success`
    // → run_succeeded; anything else (error / timeout / aborted) →
    // run_failed, with the error_type forwarded when the server set one.
    if (run.status === 'success') {
      track('run_succeeded', { run_id: run.id, app_slug: run.app_slug ?? null });
    } else {
      track('run_failed', {
        run_id: run.id,
        app_slug: run.app_slug ?? null,
        status: run.status,
        error_type: run.error_type ?? null,
      });
    }
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

export async function startJob(
  appSlug: string,
  inputs: Record<string, unknown>,
  action?: string,
): Promise<StartJobResponse> {
  // Same File → FileEnvelope walk as startRun; the jobs path enqueues
  // the same inputs shape and the runner materializes files the same
  // way. See serialize-inputs.ts for the contract.
  const serialized = await serializeInputs(inputs);
  return request<StartJobResponse>(`/api/${appSlug}/jobs`, {
    method: 'POST',
    body: JSON.stringify({ action, inputs: serialized }),
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

// ---------- Deploy waitlist (launch 2026-04-27) ----------

/**
 * Submit an email to the deploy waitlist. `source` tells us which
 * surface the user clicked from — "hero", "studio-deploy",
 * "me-publish", "direct" (the /waitlist page), etc. It's persisted
 * alongside the email so we can slice the conversion funnel later.
 *
 * The server is idempotent: re-submitting the same email returns a
 * 200 `{ ok: true }` instead of a duplicate-key error, so UI code
 * doesn't need to special-case "already signed up".
 */
export function submitWaitlist(opts: {
  email: string;
  source?: string;
  deploy_repo_url?: string;
  deploy_intent?: string;
}): Promise<{ ok: true }> {
  const body: Record<string, string> = { email: opts.email };
  if (opts.source !== undefined) body.source = opts.source;
  if (opts.deploy_repo_url !== undefined && opts.deploy_repo_url.trim() !== '') {
    body.deploy_repo_url = opts.deploy_repo_url.trim();
  }
  if (opts.deploy_intent !== undefined && opts.deploy_intent.trim() !== '') {
    body.deploy_intent = opts.deploy_intent.trim();
  }
  return request<{ ok: true }>('/api/waitlist', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Switch the caller's active workspace. Server-side the pointer is stored
 * on the user row; the next /api/session/me will return the new
 * `active_workspace` and `workspaces` scope. After calling this, callers
 * should refresh workspace-scoped caches (session, apps, runs) so the UI
 * reflects the new scope.
 */
export function switchWorkspace(
  workspace_id: string,
): Promise<{ ok: true; active_workspace_id: string }> {
  return request<{ ok: true; active_workspace_id: string }>(
    '/api/session/switch-workspace',
    {
      method: 'POST',
      body: JSON.stringify({ workspace_id }),
    },
  );
}

export function createWorkspace(body: {
  name: string;
  slug?: string;
}): Promise<{ workspace: { id: string; slug: string; name: string } }> {
  return request('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(body),
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
  callbackURL?: string,
): Promise<unknown> {
  return request('/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, callbackURL }),
  });
}

export function sendVerificationEmail(
  email: string,
  callbackURL?: string,
): Promise<{ status: boolean }> {
  return request('/auth/send-verification-email', {
    method: 'POST',
    body: JSON.stringify({ email, callbackURL }),
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

// Social sign-in (P0 launch fix 2026-04-21): Better Auth's
// `/auth/sign-in/social` endpoint is POST-only. The earlier
// `window.location.assign('/auth/sign-in/social?...')` helper fired a
// GET, which Better Auth answers with 404 — that was the launch-blocking
// "OAuth 404" bug Vikas reported.
//
// The correct shape is: POST the provider payload, get `{ url, redirect }`
// back (the Google/GitHub consent URL + state cookie set by the server),
// then top-level-navigate to that URL. Better Auth's browser SDK does the
// same thing internally; we inline it here to avoid pulling the SDK for
// one call.
export async function signInWithSocial(
  provider: 'github' | 'google',
  callbackURL = '/me',
): Promise<void> {
  const absoluteURL = callbackURL.startsWith('http')
    ? callbackURL
    : typeof window !== 'undefined'
      ? `${window.location.origin}${callbackURL.startsWith('/') ? '' : '/'}${callbackURL}`
      : callbackURL;

  const res = await request<{ url?: string; redirect?: boolean }>(
    '/auth/sign-in/social',
    {
      method: 'POST',
      body: JSON.stringify({ provider, callbackURL: absoluteURL }),
    },
  );
  if (!res?.url) {
    throw new ApiError(
      'OAuth provider did not return a redirect URL',
      500,
      'oauth_no_url',
      res,
    );
  }
  // Top-level navigation so the provider's state cookie (set by the POST
  // above, scoped to the current host) is carried into the subsequent
  // redirect chain back to /auth/callback/<provider>.
  window.location.assign(res.url);
}

// Password reset (pre-launch P0): pair of helpers for the /forgot-password
// request step and the /reset-password confirmation step. Backed by Better
// Auth's built-in endpoints (password.mjs in better-auth@1.6.3):
//   POST /auth/request-password-reset  { email, redirectTo }
//   POST /auth/reset-password?token=…  { newPassword }
// `redirectTo` is the frontend URL Better Auth redirects to after the
// token-callback GET validates the token (it appends ?token=<token>).
export function requestPasswordReset(body: {
  email: string;
  redirectTo: string;
}): Promise<{ status: boolean; message?: string }> {
  return request('/auth/request-password-reset', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function resetPassword(body: {
  newPassword: string;
  token: string;
}): Promise<{ status: boolean }> {
  return request(
    `/auth/reset-password?token=${encodeURIComponent(body.token)}`,
    {
      method: 'POST',
      body: JSON.stringify({ newPassword: body.newPassword }),
    },
  );
}


// ---------- W4-minimal: runs history + detail ----------

export function getMyRuns(limit = 50): Promise<{ runs: MeRunSummary[] }> {
  return request<{ runs: MeRunSummary[] }>(`/api/me/runs?limit=${limit}`);
}

export function getMyRun(runId: string): Promise<MeRunDetail> {
  return request<MeRunDetail>(`/api/me/runs/${runId}`);
}

export function getStudioStats(): Promise<StudioStats> {
  return request<StudioStats>('/api/me/studio/stats');
}

export function getStudioActivity(
  limit = 5,
): Promise<{ runs: StudioActivityRun[] }> {
  return request<{ runs: StudioActivityRun[] }>(
    `/api/me/studio/activity?limit=${limit}`,
  );
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

// Proactive ingest recovery (MEMORY: feedback_ingestion_be_helpful.md).
// When detect fails, the UI calls fetchIngestHint with the URL the user
// pasted + the paths already tried, and renders the recovery block
// (paste direct URL, paste contents, generate-with-Claude prompt).
export interface IngestHint {
  status: 'spec_found' | 'repo_no_spec' | 'not_a_github_repo' | 'unreachable';
  input_url: string;
  repo: { owner: string; repo: string; canonical_url: string } | null;
  required_files: string[];
  required_shape: {
    openapi: string;
    info: { title: string; version: string };
    servers: Array<{ url: string }>;
    paths_example: string;
  };
  paths_tried: string[];
  ready_prompt: string;
  upload_url: string;
  detect_url: string;
  message: string;
}

export function fetchIngestHint(
  input_url: string,
  attempted?: string[],
): Promise<IngestHint> {
  return request('/api/hub/detect/hint', {
    method: 'POST',
    body: JSON.stringify({ input_url, attempted }),
  });
}

export function detectAppInline(
  openapi_spec: object | string,
  name?: string,
  slug?: string,
): Promise<DetectedApp> {
  return request('/api/hub/detect/inline', {
    method: 'POST',
    body: JSON.stringify({ openapi_spec, name, slug }),
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
  // Analytics (launch-infra #4): publish_succeeded fires on the resolved
  // 201 response. Failures propagate via the thrown ApiError and are not
  // double-counted as publish_failed (that event isn't in the tracked set).
  return request<{ slug: string; name: string; created: boolean }>('/api/hub/ingest', {
    method: 'POST',
    body: JSON.stringify(body),
  }).then((result) => {
    track('publish_succeeded', {
      slug: result.slug,
      created: result.created,
    });
    return result;
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
  return request(`/api/me/apps/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
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
  /** Set when the server is configured with FEEDBACK_GITHUB_TOKEN and the
   *  issue was created successfully. */
  issue_number?: number;
  issue_url?: string;
  /** Set when GitHub filing was attempted but failed. Feedback is still
   *  persisted in the DB. */
  issue_error?: string;
}> {
  return request('/api/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ---------- Personal API keys (Better Auth api-key plugin) ----------
//
// Used for headless integrations: Claude Code skill, CLI, scripts, MCP
// clients. Keys are shown once at create time, then hashed server-side —
// the list endpoint never returns the full value again. Sent as
// `Authorization: Bearer <key>` (or `x-api-key: <key>`) on subsequent
// calls; the server's custom getter (lib/better-auth.ts) strips the
// Bearer prefix and feeds the raw key to Better Auth.

/** Shape returned by `/auth/api-key/list` and `/auth/api-key/get`. The full
 *  `key` field is intentionally omitted — it's only returned on create. */
export interface ApiKeyRecord {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRequest: string | null;
  expiresAt: string | null;
}

/** Shape returned by `/auth/api-key/create`. `key` is the full cleartext
 *  value — we show it once in a copy-to-clipboard callout and never fetch
 *  it again. */
export interface CreatedApiKey extends ApiKeyRecord {
  key: string;
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  // Better Auth v1.6 wraps the list in { apiKeys, total }; older callers
  // (and some envs) returned a bare array. Handle both.
  const res = await request<
    ApiKeyRecord[] | { apiKeys: ApiKeyRecord[]; total?: number }
  >('/auth/api-key/list');
  if (Array.isArray(res)) return res;
  return res?.apiKeys ?? [];
}

export function createApiKey(name: string): Promise<CreatedApiKey> {
  return request<CreatedApiKey>('/auth/api-key/create', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function deleteApiKey(keyId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/auth/api-key/delete', {
    method: 'POST',
    body: JSON.stringify({ keyId }),
  });
}
