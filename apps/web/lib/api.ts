// Same-origin proxy base. Defaults to "/api/proxy" for the single-tenant OSS
// build. The Cloud build serves the dashboard under basePath "/app", where raw
// fetch() calls are NOT auto-prefixed by basePath, so Cloud sets
// NEXT_PUBLIC_API_PROXY_BASE="/app/api/proxy". Keeping this an env seam lets the
// Downstream host consume this file unmodified (no fork).
import { capture, captureException, type AnalyticsProperties } from "@/lib/analytics/capture";

export const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
const WEB_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";
const ACTIVE_WORKSPACE_COOKIE_KEY = "workeros.activeWorkspaceId";
const APP_API_BASE = API_BASE.endsWith("/api/proxy")
  ? API_BASE.slice(0, -"/api/proxy".length) + "/api"
  : "/api";
let loginRedirectStarted = false;

export function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  return value || "local-default";
}

export function setActiveWorkspaceId(workspaceId: string | null) {
  if (typeof window === "undefined") return;
  if (!workspaceId) {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    window.document.cookie = `${ACTIVE_WORKSPACE_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
  } else {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
    window.document.cookie = `${ACTIVE_WORKSPACE_COOKIE_KEY}=${encodeURIComponent(workspaceId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
}

// Extract a human-readable string from a FastAPI error body. `detail` can be:
//   - a string ("Worker not found")
//   - an object ({ message, errors }) - our schema-validation 400s
//   - a Pydantic validation array ([{ loc, msg, type }, ...])
// `new Error(detail)` on a non-string coerces to "[object Object]", which is the
// useless toast the X5 clone-on-edit 400 surfaced. Always resolve to a string.
function extractApiErrorMessage(body: unknown): string {
  if (body == null || typeof body !== "object") {
    return typeof body === "string" ? body : "";
  }
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => (d && typeof d === "object" ? (d as { msg?: unknown }).msg : d))
        .filter((m): m is string => typeof m === "string" && m.length > 0);
      if (msgs.length) return msgs.join("; ");
    }
    return JSON.stringify(detail);
  }
  return JSON.stringify(body);
}

function withWorkspaceHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  const activeWorkspace = getActiveWorkspaceId();
  if (activeWorkspace) {
    merged.set("x-workeros-workspace", activeWorkspace);
  }
  return merged;
}

function withWorkspaceQuery(path: string): string {
  const activeWorkspace = getActiveWorkspaceId();
  if (!activeWorkspace) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}workspace_id=${encodeURIComponent(activeWorkspace)}`;
}

export function apiProxyPath(path: string, includeWorkspaceQuery = false): string {
  return `${API_BASE}${includeWorkspaceQuery ? withWorkspaceQuery(path) : path}`;
}

function apiRouteTemplate(path: string): string {
  const clean = path.split("?")[0] || "/";
  const segments = clean.split("/").filter(Boolean);
  const templated: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const previous = segments[i - 1];
    if (segment === "public") {
      templated.push(segment);
      continue;
    }
    if (previous === "files" || previous === "sqlite" || previous === "bundle") {
      templated.push(":path");
      break;
    }
    if (
      previous === "workers" ||
      previous === "runs" ||
      previous === "contexts" ||
      previous === "connections" ||
      previous === "approvals" ||
      previous === "workspaces" ||
      previous === "members" ||
      previous === "tokens" ||
      previous === "versions" ||
      previous === "artifacts" ||
      previous === "magic" ||
      previous === "secrets" ||
      previous === "users"
    ) {
      templated.push(":id");
      continue;
    }
    templated.push(segment);
  }
  return `/${templated.join("/")}`;
}

function captureApiError(path: string, status: number, errorType = "http") {
  capture("api_error", {
    route: apiRouteTemplate(path),
    status,
    error_type: errorType,
  });
}

async function fetchApi(path: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    captureApiError(path, 0, "network");
    captureException(error, { route: apiRouteTemplate(path), status: 0 });
    throw error;
  }
}

function workerTools(worker: import("./types").WorkerDetail | import("./types").WorkerSummary): string[] {
  const explicitConnections = "connections" in worker && Array.isArray(worker.connections)
    ? worker.connections
    : [];
  const configConnections = "config" in worker ? worker.config?.connections ?? [] : [];
  const tools = new Set<string>();
  for (const app of explicitConnections) tools.add(app);
  for (const item of configConnections) {
    if (typeof item === "string") tools.add(item);
    else if ("app" in item && typeof item.app === "string") tools.add(item.app);
    else if ("composio" in item && typeof item.composio.app === "string") tools.add(item.composio.app);
    else if ("mcp" in item) tools.add("mcp");
  }
  return Array.from(tools).sort();
}

function workerTriggerType(worker: Pick<import("./types").WorkerDetail, "trigger_type" | "config"> | import("./types").WorkerSummary): string {
  if ("config" in worker && worker.config?.trigger?.type) return worker.config.trigger.type;
  return worker.trigger_type || "unknown";
}

function captureOnce(key: string, event: string, props: AnalyticsProperties) {
  if (typeof window === "undefined") return;
  const storageKey = `workeros.analytics.${key}`;
  try {
    if (window.sessionStorage.getItem(storageKey)) return;
    window.sessionStorage.setItem(storageKey, "1");
  } catch {
    // Storage can be disabled; analytics must not block product flows.
  }
  capture(event, props);
}

function captureRunTerminal(run: import("./types").RunDetail | import("./types").RunSummary) {
  if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") return;
  const base = {
    run_id: run.id,
    worker_id: run.worker_id,
    status: run.status,
    duration_ms: run.duration_ms ?? null,
    tokens: "total_tokens" in run ? run.total_tokens ?? null : null,
    cost_usd: null,
  };
  if (run.status === "failed") {
    captureOnce(`run_failed.${run.id}`, "worker_run_failed", {
      ...base,
      error_type: run.error ? "worker_error" : "unknown",
    });
    return;
  }
  captureOnce(`run_completed.${run.id}`, "worker_run_completed", base);
}

function isSignedApprovalProxyPath(path: string): boolean {
  return path.startsWith("/approvals/public/");
}

function currentPathForLoginNext(): string {
  if (typeof window === "undefined") return "/";
  const path = `${window.location.pathname}${window.location.search || ""}`;
  return path || "/";
}

function redirectToLoginOnce(path: string): void {
  if (loginRedirectStarted || typeof window === "undefined") return;
  if (isSignedApprovalProxyPath(path)) return;
  loginRedirectStarted = true;
  const loginPath = `${WEB_BASE_PATH}/login`;
  const next = currentPathForLoginNext();
  const target =
    next && next !== "/" && next !== loginPath
      ? `${loginPath}?next=${encodeURIComponent(next)}`
      : loginPath;
  window.location.assign(target);
}

function handleUnauthorizedResponse(status: number, path: string): void {
  if (status === 401) redirectToLoginOnce(path);
}

async function apiErrorFromResponse(res: Response): Promise<string> {
  let err = "";
  try {
    const body = await res.json();
    err = extractApiErrorMessage(body);
  } catch {
    err = "";
  }
  if (!err || err === "{}") {
    err =
      res.status === 504
        ? "Request timed out. The server took too long to respond."
        : res.statusText || `HTTP ${res.status}`;
  }
  return err;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = withWorkspaceHeaders(options?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetchApi(path, `${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    captureApiError(path, res.status);
    handleUnauthorizedResponse(res.status, path);
    throw new Error(await apiErrorFromResponse(res));
  }
  // No-content responses (204, or any empty body) carry no JSON. Calling
  // res.json() on them throws ("Unexpected end of JSON input"), which used to
  // send no-content mutations (e.g. DELETE /workers/{id}, status 204) into the
  // caller's catch block even though the request succeeded. Return null in that
  // case so callers that don't read the body (delete) resolve cleanly.
  if (res.status === 204) {
    return null as T;
  }
  const text = await res.text();
  if (!text) {
    return null as T;
  }
  return JSON.parse(text) as T;
}

async function fetchText(path: string, options?: RequestInit): Promise<string> {
  const headers = withWorkspaceHeaders(options?.headers);
  const res = await fetchApi(path, `${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    captureApiError(path, res.status);
    handleUnauthorizedResponse(res.status, path);
    throw new Error(await apiErrorFromResponse(res));
  }
  if (res.status === 204) return "";
  return res.text();
}

async function fetchRaw(path: string, options?: RequestInit): Promise<Response> {
  const res = await fetchApi(path, `${API_BASE}${path}`, {
    ...options,
    headers: withWorkspaceHeaders(options?.headers),
  });
  if (!res.ok) {
    captureApiError(path, res.status);
    handleUnauthorizedResponse(res.status, path);
    throw new Error(await apiErrorFromResponse(res));
  }
  return res;
}

async function fetchWorkspaceBasePersona(): Promise<{ content: string; is_custom: boolean; default: string }> {
  try {
    return await fetchJson<{ content: string; is_custom: boolean; default: string }>("/workspace/base/state");
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "Not Found") {
      throw err;
    }
    const content = await fetchText("/workspace/base");
    return { content, is_custom: false, default: content };
  }
}

export const api = {
  auth: {
    issueMagicLink: () =>
      fetchJson<{ url: string; expires_in: number }>("/auth/magic-link", { method: "POST" }),
    consumeMagicLink: (token: string) =>
      fetchJson<{ ok: boolean; redirect_to: string }>(`/auth/magic/${encodeURIComponent(token)}`),
  },
  me: async () => {
    const res = await fetchApi("/me", `${APP_API_BASE}/me`, {
      cache: "no-store",
      headers: withWorkspaceHeaders(),
    });
    if (!res.ok) {
      captureApiError("/me", res.status);
      handleUnauthorizedResponse(res.status, "/me");
      throw new Error(await apiErrorFromResponse(res));
    }
    return res.json() as Promise<import("./types").CurrentUser>;
  },
  // #778: Emily chat attachments — upload to extract text for the next message.
  chat: {
    uploadAttachments: async (files: File[]): Promise<import("./types").ChatAttachment[]> => {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const uploadPath = withWorkspaceQuery("/chat/attachments");
      const res = await fetchApi("/chat/attachments", `${API_BASE}${uploadPath}`, {
        method: "POST",
        headers: withWorkspaceHeaders(), // no Content-Type — browser sets the multipart boundary
        body: fd,
      });
      if (!res.ok) {
        captureApiError("/chat/attachments", res.status);
        throw new Error(await apiErrorFromResponse(res));
      }
      return res.json();
    },
  },
  // #767/#768: specific-people share grants.
  share: {
    listGrants: (assetType: string, assetId: string) =>
      fetchJson<import("./types").ShareGrant[]>(
        `/share/grants?asset_type=${encodeURIComponent(assetType)}&asset_id=${encodeURIComponent(assetId)}`
      ),
    addGrant: (assetType: string, assetId: string, email: string) =>
      fetchJson<import("./types").ShareGrant>("/share/grants", {
        method: "POST",
        body: JSON.stringify({ asset_type: assetType, asset_id: assetId, email }),
      }),
    revokeGrant: (grantId: string) =>
      fetchJson<null>(`/share/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" }),
  },
  workers: {
    // S44 Win 3: use list shape (~15 KB vs 47 KB full) for the web UI.
    // CLI consumers that call GET /workers directly get full payload (no ?shape=list).
    list: (opts?: { include_archived?: boolean }) => {
      const qs = new URLSearchParams({ shape: "list" });
      if (opts?.include_archived) qs.set("include_archived", "true");
      return fetchJson<import("./types").WorkerSummary[]>(`/workers?${qs.toString()}`);
    },
    get: (id: string) => fetchJson<import("./types").WorkerDetail>(`/workers/${id}`),
    sampleInput: (id: string) => fetchJson<Record<string, unknown>>(`/workers/${id}/sample-input`),
    restore: (id: string) => fetchJson<import("./types").WorkerDetail>(`/workers/${id}/restore`, { method: "POST" }),
    archive: async (id: string) => {
      const worker = await fetchJson<import("./types").WorkerDetail>(`/workers/${id}/archive`, { method: "POST" });
      capture("worker_archived", {
        worker_id: id,
        trigger_type: workerTriggerType(worker),
        tools: workerTools(worker),
      });
      return worker;
    },
    setVisibility: async (id: string, visibility: import("./types").AssetVisibility) => {
      const worker = await fetchJson<import("./types").WorkerDetail>(`/workers/${id}/visibility`, {
        method: "PUT",
        body: JSON.stringify({ visibility }),
      });
      if (visibility === "workspace") {
        capture("worker_shared", {
          worker_id: id,
          share_type: "workspace",
        });
      }
      return worker;
    },
    shareLink: async (id: string) => {
      const link = await fetchJson<import("./types").StandaloneShareLink>(`/workers/${encodeURIComponent(id)}/share-link`, {
        method: "POST",
      });
      capture("worker_shared", { worker_id: id, share_type: "link" });
      return link;
    },
    importFromShare: (token: string) =>
      fetchJson<{ worker_id: string; url: string }>("/workers/import-from-share", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    reload: () =>
      fetchJson<import("./types").ReloadResponse>("/workers/reload", { method: "POST" }),
    run: async (id: string, inputs: Record<string, unknown>) => {
      const result = await fetchJson<import("./types").ActionResponse>(`/workers/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({ inputs, trigger_source: "manual" }),
      });
      capture("worker_run_started", {
        worker_id: id,
        run_id: result.run_id ?? null,
        trigger: "manual",
      });
      return result;
    },
    create: async (worker_yml: string, run_py: string, skill_md?: string) => {
      const worker = await fetchJson<import("./types").WorkerDetail>("/workers", {
        method: "POST",
        body: JSON.stringify({ worker_yml, run_py, ...(skill_md !== undefined ? { skill_md } : {}) }),
      });
      capture("worker_created", {
        worker_id: worker.id,
        source: "manual",
        trigger_type: workerTriggerType(worker),
        tools: workerTools(worker),
      }, {
        setOnce: { first_worker_created_at: new Date().toISOString() },
      });
      return worker;
    },
    draftFromPrompt: (prompt: string) =>
      fetchJson<import("./types").DraftFromPromptResponse>("/workers/draft-from-prompt", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),
    draftAndCreate: async (params: { prompt?: string; files?: { path: string; content: string }[] }) => {
      const result = await fetchJson<{ worker_id: string }>("/workers/draft-and-create", {
        method: "POST",
        body: JSON.stringify(params),
      });
      capture("worker_created", {
        worker_id: result.worker_id,
        source: "prompt",
      }, {
        setOnce: { first_worker_created_at: new Date().toISOString() },
      });
      capture("emily_worker_created_from_prompt", {
        worker_id: result.worker_id,
      });
      return result;
    },
    newFromPrompt: async (params: { prompt: string; mode?: "draft" | "create"; parent_worker_id?: string }) => {
      const result = await fetchJson<{ run_id: string; worker_id: string; status: string }>("/workers/new/from-prompt", {
        method: "POST",
        body: JSON.stringify(params),
      });
      if (params.mode === "create") {
        capture("worker_created", {
          worker_id: result.worker_id,
          run_id: result.run_id,
          source: "prompt",
        }, {
          setOnce: { first_worker_created_at: new Date().toISOString() },
        });
        capture("emily_worker_created_from_prompt", {
          worker_id: result.worker_id,
          run_id: result.run_id,
        });
      }
      return result;
    },
    createFromBundle: async (zipBlob: Blob): Promise<import("./types").WorkerDetail> => {
      const form = new FormData();
      form.append("bundle", zipBlob, "bundle.zip");
      const res = await fetchApi("/workers/from-bundle", `${API_BASE}/workers/from-bundle`, {
        method: "POST",
        headers: withWorkspaceHeaders(),
        body: form,
      });
      if (!res.ok) {
        captureApiError("/workers/from-bundle", res.status);
        let err: string;
        try {
          const body = await res.json();
          err = extractApiErrorMessage(body);
        } catch {
          err = res.statusText;
        }
        throw new Error(err);
      }
      const worker = await res.json() as import("./types").WorkerDetail;
      capture("worker_created", {
        worker_id: worker.id,
        source: "manual",
        import_type: "bundle",
        trigger_type: workerTriggerType(worker),
        tools: workerTools(worker),
      }, {
        setOnce: { first_worker_created_at: new Date().toISOString() },
      });
      return worker;
    },
    update: async (id: string, worker_yml: string, run_py: string, skill_md?: string) => {
      const worker = await fetchJson<import("./types").WorkerDetail>(`/workers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ worker_yml, run_py, ...(skill_md !== undefined ? { skill_md } : {}) }),
      });
      capture("worker_edited", {
        worker_id: id,
        edit_surface: "worker_update",
        trigger_type: workerTriggerType(worker),
        tools: workerTools(worker),
      });
      return worker;
    },
    suggest: (id: string, newDescription: string) =>
      fetchJson<import("./types").WorkerSuggestResponse>(`/workers/${id}/suggest`, {
        method: "POST",
        body: JSON.stringify({ new_description: newDescription }),
      }),
    updateFiles: async (id: string, files: { path: string; content: string }[]) => {
      const worker = await fetchJson<import("./types").WorkerDetail>(`/workers/${id}/files`, {
        method: "PUT",
        body: JSON.stringify({ files }),
      });
      capture("worker_edited", {
        worker_id: id,
        edit_surface: "files",
        file_count: files.length,
        trigger_type: workerTriggerType(worker),
        tools: workerTools(worker),
      });
      return worker;
    },
    delete: async (id: string) => {
      const result = await fetchJson<{ status: string }>(`/workers/${id}`, { method: "DELETE" });
      capture("worker_deleted", { worker_id: id });
      return result;
    },
    listVersions: (id: string, limit = 50) =>
      fetchJson<import("./types").VersionSummary[]>(`/workers/${id}/versions?limit=${limit}`),
    getVersion: (id: string, versionId: string) =>
      fetchJson<import("./types").VersionDetail>(`/workers/${id}/versions/${versionId}`),
    rollback: (id: string, versionId: string) =>
      fetchJson<import("./types").WorkerDetail>(`/workers/${id}/rollback/${versionId}`, { method: "POST" }),
    // Worker feedback (SPEC §12) — anyone who can see the worker can comment.
    feedback: {
      list: (id: string) =>
        fetchJson<import("./types").WorkerFeedback[]>(`/workers/${id}/feedback`),
      create: (id: string, content: string) =>
        fetchJson<import("./types").WorkerFeedback>(`/workers/${id}/feedback`, {
          method: "POST",
          body: JSON.stringify({ content }),
        }),
      remove: (id: string, feedbackId: string) =>
        fetchJson<void>(`/workers/${id}/feedback/${feedbackId}`, { method: "DELETE" }),
    },
  },
  runs: {
    list: async (params?: {
      worker_id?: string;
      status?: string;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params?.worker_id) qs.append("worker_id", params.worker_id);
      if (params?.status) qs.append("status", params.status);
      if (params?.since) qs.append("since", params.since);
      if (params?.until) qs.append("until", params.until);
      if (params?.limit) qs.append("limit", String(params.limit));
      if (params?.offset) qs.append("offset", String(params.offset));
      const rows = await fetchJson<import("./types").RunSummary[]>(`/runs?${qs.toString()}`);
      rows.forEach(captureRunTerminal);
      return rows;
    },
    get: async (id: string) => {
      const run = await fetchJson<import("./types").RunDetail>(`/runs/${id}`);
      captureRunTerminal(run);
      return run;
    },
    logs: (id: string) => fetchJson<import("./types").LogEntry[]>(`/runs/${id}/logs`),
    cancel: (id: string) =>
      fetchJson<import("./types").ActionResponse>(`/runs/${id}/cancel`, {
        method: "POST",
      }),
    approve: async (
      id: string,
      editedOutput?: Record<string, unknown>,
      annotations?: import("./types").ApprovalAnnotations | null
    ) => {
      const result = await fetchJson<import("./types").ActionResponse>(`/runs/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ edited_output: editedOutput ?? null, annotations: annotations ?? null }),
      });
      capture("approval_approved", {
        run_id: id,
        approval_type: "run",
        has_annotations: Boolean(annotations),
      });
      return result;
    },
    reject: async (
      id: string,
      reason?: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) => {
      const result = await fetchJson<import("./types").ActionResponse>(`/runs/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? null, annotations: annotations ?? null }),
      });
      capture("approval_rejected", {
        run_id: id,
        approval_type: "run",
        has_reason: Boolean(reason),
        has_annotations: Boolean(annotations),
      });
      return result;
    },
    replay: async (workerId: string, runId: string) => {
      const result = await fetchJson<{ run_id: string }>(
        `/workers/${encodeURIComponent(workerId)}/runs/${encodeURIComponent(runId)}/replay`,
        { method: "POST" }
      );
      capture("worker_run_started", {
        worker_id: workerId,
        run_id: result.run_id,
        trigger: "replay",
      });
      return result;
    },
    // #796: bulk-export the given runs as one ZIP blob.
    exportBundle: async (runIds: string[]): Promise<Blob> => {
      const exportPath = withWorkspaceQuery("/runs/export");
      const res = await fetchApi("/runs/export", `${API_BASE}${exportPath}`, {
        method: "POST",
        headers: { ...withWorkspaceHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ run_ids: runIds }),
      });
      if (!res.ok) {
        captureApiError("/runs/export", res.status);
        throw new Error(await apiErrorFromResponse(res));
      }
      return res.blob();
    },
    downloadUrl: (id: string) =>
      `${API_BASE}${withWorkspaceQuery(`/runs/${encodeURIComponent(id)}/download`)}`,
    artifactUrl: (id: string, artifactId: string) =>
      `${API_BASE}${withWorkspaceQuery(`/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/download`)}`,
    bundleUrl: (id: string, filename: string) =>
      `${API_BASE}${withWorkspaceQuery(`/runs/${encodeURIComponent(id)}/bundle/${encodeURIComponent(filename)}`)}`,
  },
  approvals: {
    list: async (status?: string) => {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      const rows = await fetchJson<import("./types").ApprovalRow[]>(`/approvals${qs}`);
      for (const approval of rows) {
        if (approval.status === "pending") {
          captureOnce(`approval_requested.${approval.id}`, "approval_requested", {
            approval_id: approval.id,
            run_id: approval.run_id,
            worker_id: approval.worker_id,
            approval_type: "pending",
          });
        }
      }
      return rows;
    },
    count: () => fetchJson<{ pending: number }>("/approvals/count"),
    approveAction: async (
      approvalId: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) => {
      const result = await fetchJson<{ status: string; executed: string; detail: string }>(
        `/approvals/${approvalId}/approve-action`,
        {
          method: "POST",
          body: JSON.stringify({ annotations: annotations ?? null }),
        }
      );
      capture("approval_approved", {
        approval_id: approvalId,
        approval_type: "destructive_delete",
        has_annotations: Boolean(annotations),
      });
      return result;
    },
    rejectAction: async (
      approvalId: string,
      reason?: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) => {
      const result = await fetchJson<{ status: string; path: string; reason?: string }>(
        `/approvals/${approvalId}/reject-action`,
        {
          method: "POST",
          body: JSON.stringify({ reason, annotations: annotations ?? null }),
        }
      );
      capture("approval_rejected", {
        approval_id: approvalId,
        approval_type: "destructive_delete",
        has_reason: Boolean(reason),
        has_annotations: Boolean(annotations),
      });
      return result;
    },
    approveAgentTool: async (approvalId: string, editedOutput?: Record<string, unknown>) => {
      const result = await fetchJson<import("./types").ActionResponse>(
        `/approvals/${approvalId}/approve`,
        {
          method: "POST",
          body: JSON.stringify({ edited_output: editedOutput ?? null }),
        }
      );
      capture("approval_approved", {
        approval_id: approvalId,
        approval_type: "agent_tool",
      });
      return result;
    },
    rejectAgentTool: async (approvalId: string, reason?: string) => {
      const result = await fetchJson<import("./types").ActionResponse>(
        `/approvals/${approvalId}/reject`,
        {
          method: "POST",
          body: JSON.stringify({ reason: reason ?? null }),
        }
      );
      capture("approval_rejected", {
        approval_id: approvalId,
        approval_type: "agent_tool",
        has_reason: Boolean(reason),
      });
      return result;
    },
    publicGet: (approvalId: string, token: string) =>
      fetchJson<import("./types").ApprovalRow>(
        `/approvals/public/${encodeURIComponent(approvalId)}?token=${encodeURIComponent(token)}`
      ),
    publicApprove: async (
      approvalId: string,
      token: string,
      editedOutput?: Record<string, unknown>,
      annotations?: import("./types").ApprovalAnnotations | null
    ) => {
      const result = await fetchJson<import("./types").ActionResponse>(
        `/approvals/public/${encodeURIComponent(approvalId)}/approve?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          body: JSON.stringify({ edited_output: editedOutput ?? null, annotations: annotations ?? null }),
        }
      );
      capture("approval_approved", {
        approval_id: approvalId,
        approval_type: "public",
        has_annotations: Boolean(annotations),
      });
      return result;
    },
    publicReject: async (
      approvalId: string,
      token: string,
      reason?: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) => {
      const result = await fetchJson<import("./types").ActionResponse>(
        `/approvals/public/${encodeURIComponent(approvalId)}/reject?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          body: JSON.stringify({ reason: reason ?? null, annotations: annotations ?? null }),
        }
      );
      capture("approval_rejected", {
        approval_id: approvalId,
        approval_type: "public",
        has_reason: Boolean(reason),
        has_annotations: Boolean(annotations),
      });
      return result;
    },
    publicArtifactUrl: (approvalId: string, artifactId: string, token: string) =>
      `${API_BASE}/approvals/public/${encodeURIComponent(approvalId)}/artifacts/${encodeURIComponent(artifactId)}/download?token=${encodeURIComponent(token)}`,
    // X4: upload a review screenshot. Authed owner path + signed-link public
    // reviewer path. Both return a content-addressed /uploads/<sha> ref to drop
    // into an image annotation.
    uploadScreenshot: async (
      approvalId: string,
      fileBlob: Blob,
      filename: string
    ): Promise<import("./types").ApprovalUploadResponse> => {
      const form = new FormData();
      form.append("file", fileBlob, filename);
      const uploadPath = `/approvals/${encodeURIComponent(approvalId)}/uploads`;
      const res = await fetchApi(
        uploadPath,
        `${API_BASE}/approvals/${encodeURIComponent(approvalId)}/uploads`,
        { method: "POST", headers: withWorkspaceHeaders(), body: form }
      );
      if (!res.ok) {
        captureApiError(uploadPath, res.status);
        handleUnauthorizedResponse(res.status, `/approvals/${approvalId}/uploads`);
        throw new Error(await apiErrorFromResponse(res));
      }
      return res.json() as Promise<import("./types").ApprovalUploadResponse>;
    },
    uploadScreenshotPublic: async (
      approvalId: string,
      token: string,
      fileBlob: Blob,
      filename: string
    ): Promise<import("./types").ApprovalUploadResponse> => {
      const form = new FormData();
      form.append("file", fileBlob, filename);
      const uploadPath = `/approvals/public/${encodeURIComponent(approvalId)}/uploads`;
      const res = await fetchApi(
        uploadPath,
        `${API_BASE}/approvals/public/${encodeURIComponent(approvalId)}/uploads?token=${encodeURIComponent(token)}`,
        { method: "POST", body: form }
      );
      if (!res.ok) {
        captureApiError(uploadPath, res.status);
        handleUnauthorizedResponse(res.status, `/approvals/public/${approvalId}/uploads`);
        throw new Error(await apiErrorFromResponse(res));
      }
      return res.json() as Promise<import("./types").ApprovalUploadResponse>;
    },
  },
  secrets: {
    list: () => fetchJson<import("./types").SecretItem[]>("/secrets"),
    upsert: (name: string, value: string) =>
      fetchJson<{ status: string; reason?: string }>(`/secrets/${name}`, {
        method: "POST",
        body: JSON.stringify({ value }),
      }),
    delete: (name: string) =>
      fetchJson<{ status: string; reason?: string }>(`/secrets/${name}`, {
        method: "DELETE",
      }),
    test: (name: string) =>
      fetchJson<{ status: string; reason?: string }>(`/secrets/${name}/test`, {
        method: "POST",
      }),
  },
  contexts: {
    list: () => fetchJson<import("./types").ContextSummary[]>("/contexts"),
    get: (name: string) =>
      fetchJson<import("./types").ContextDetail>(`/contexts/${encodeURIComponent(name)}`),
    create: async (name: string, writeable = false) => {
      const folder = await fetchJson<import("./types").ContextDetail>(`/contexts/${encodeURIComponent(name)}`, {
        method: "POST",
        body: JSON.stringify({ writeable }),
      });
      capture("brain_folder_created", {
        writeable,
      });
      return folder;
    },
    // Members STEP 4: Private <-> Shared with workspace.
    setVisibility: async (name: string, visibility: import("./types").AssetVisibility) => {
      const folder = await fetchJson<import("./types").ContextDetail>(
        `/contexts/${encodeURIComponent(name)}/visibility`,
        { method: "PUT", body: JSON.stringify({ visibility }) }
      );
      if (visibility === "workspace") {
        capture("brain_shared", {
          share_type: "workspace",
        });
      }
      return folder;
    },
    setSensitive: (name: string, sensitive: boolean) =>
      fetchJson<{ name: string; sensitive: boolean }>(
        `/contexts/${encodeURIComponent(name)}/sensitive`,
        { method: "PATCH", body: JSON.stringify({ sensitive }) }
      ),
    sharePackLink: async (name: string) => {
      const link = await fetchJson<import("./types").StandaloneShareLink>(
        `/contexts/${encodeURIComponent(name)}/share-link`,
        { method: "POST" }
      );
      capture("brain_shared", {
        share_type: "link",
      });
      return link;
    },
    delete: (name: string, force = false) =>
      fetchJson<{ status: string; referenced_by: string[] }>(
        `/contexts/${encodeURIComponent(name)}${force ? "?force=true" : ""}`,
        { method: "DELETE" }
      ),
    saveTextFile: async (name: string, path: string, content: string, tags?: string[]) => {
      const file = await fetchJson<import("./types").ContextFileItem>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        { method: "PUT", body: JSON.stringify(tags ? { content, tags } : { content }) } // #780
      );
      capture("brain_file_added", {
        file_type: path.split(".").pop()?.toLowerCase() || "unknown",
        tag_count: tags?.length ?? 0,
        size_bytes: content.length,
      }, {
        setOnce: { first_brain_file_added_at: new Date().toISOString() },
      });
      return file;
    },
    deleteFile: (name: string, path: string) =>
      fetchJson<import("./types").ContextDetail>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        { method: "DELETE" }
      ),
    shareFileLink: async (name: string, path: string) => {
      const link = await fetchJson<import("./types").StandaloneShareLink>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}/share-link`,
        { method: "POST" }
      );
      capture("brain_shared", {
        share_type: "file_link",
        file_type: path.split(".").pop()?.toLowerCase() || "unknown",
      });
      return link;
    },
    // #777: inspect a brain .db file — tables list, or a table's rows.
    sqlite: (name: string, path: string, table?: string) => {
      const qs = table ? `?table=${encodeURIComponent(table)}` : "";
      return fetchJson<import("./types").SqliteView>(
        `/contexts/${encodeURIComponent(name)}/sqlite/${path.split("/").map(encodeURIComponent).join("/")}${qs}`
      );
    },
    // #770: move/rename a brain file (matches the backend's {new_path} contract).
    moveFile: (name: string, path: string, newPath: string) =>
      fetchJson<import("./types").ContextFileItem>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}/move`,
        { method: "POST", body: JSON.stringify({ new_path: newPath }) }
      ),
    readTextFile: async (name: string, path: string) => {
      const res = await fetchRaw(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`
      );
      return res.text();
    },
    upload: async (
      name: string,
      files: FileList | File[],
      pathPrefix?: string,
      options?: { createIfMissing?: boolean }
    ) => {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append("files", file, file.name));
      if (pathPrefix) form.append("path_prefix", pathPrefix);
      if (options?.createIfMissing) form.append("create_if_missing", "true");
      const uploadPath = `/contexts/${encodeURIComponent(name)}/upload`;
      const res = await fetchApi(uploadPath, `${API_BASE}/contexts/${encodeURIComponent(name)}/upload`, {
        method: "POST",
        headers: withWorkspaceHeaders(),
        body: form,
      });
      if (!res.ok) {
        captureApiError(uploadPath, res.status);
        let err = "";
        try {
          const body = await res.json();
          err = extractApiErrorMessage(body);
        } catch {
          err = res.statusText || `HTTP ${res.status}`;
        }
        throw new Error(err);
      }
      const result = await res.json() as { files: import("./types").ContextFileItem[]; total_size_bytes: number };
      capture("brain_file_added", {
        file_count: result.files?.length ?? 0,
        size_bytes: result.total_size_bytes ?? 0,
        created_folder: Boolean(options?.createIfMissing),
      }, options?.createIfMissing ? {
        setOnce: { first_brain_file_added_at: new Date().toISOString() },
      } : undefined);
      return result;
    },
    fetchFileBlob: async (name: string, path: string) => {
      const filePath = `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
      const res = await fetchApi(
        filePath,
        `${API_BASE}/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: withWorkspaceHeaders() }
      );
      if (!res.ok) {
        captureApiError(filePath, res.status);
        throw new Error(`Download failed (${res.status})`);
      }
      return res.blob();
    },
    fileUrl: (name: string, path: string) =>
      `${API_BASE}${withWorkspaceQuery(`/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`)}`,
    // Audit a pack's CURRENT files for stored live credentials (masked findings
    // only). This is what catches secrets already sitting in a Brain pack.
    secretScan: (name: string) =>
      fetchJson<import("./types").ContextSecretScanResponse>(
        `/contexts/${encodeURIComponent(name)}/secret-scan`
      ),
    listVersions: (name: string, limit = 50) =>
      fetchJson<import("./types").VersionSummary[]>(`/contexts/${encodeURIComponent(name)}/versions?limit=${limit}`),
    getVersion: (name: string, versionId: string) =>
      fetchJson<import("./types").VersionDetail>(`/contexts/${encodeURIComponent(name)}/versions/${versionId}`),
    rollback: (name: string, versionId: string) =>
      fetchJson<import("./types").ContextDetail>(`/contexts/${encodeURIComponent(name)}/rollback/${versionId}`, {
        method: "POST",
      }),
    // Per-file version history. The backend snapshots each brain-pack file on
    // every save/delete/upload under the `brain_file` asset type, so these list
    // and read the revisions of ONE file (not the whole pack).
    listFileVersions: (name: string, path: string, limit = 50) =>
      fetchJson<import("./types").VersionSummary[]>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}/versions?limit=${limit}`
      ),
    getFileVersion: (name: string, path: string, versionId: string) =>
      fetchJson<import("./types").VersionFileDetail>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}/versions/${versionId}`
      ),
    restoreFileVersion: (name: string, path: string, sha: string) =>
      fetchJson<import("./types").ContextFileItem>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}/restore/${sha}`,
        { method: "POST" }
      ),
  },
  system: {
    info: () => fetchJson<import("./types").SystemInfo>("/system/info"),
    platformConfig: () => fetchJson<import("./types").PlatformConfig>("/system/platform-config"),
    overview: () => fetchJson<import("./types").SystemOverview>("/system/overview"),
    clearRuns: () => fetchJson<import("./types").ActionResponse>("/runs/clear", { method: "POST" }),
    workspaceAgent: () =>
      fetchJson<import("./types").WorkspaceAgentInfo>("/system/workspace-agent"),
    // Members STEP 5: assistant Private <-> Shared with workspace.
    setAssistantVisibility: (visibility: import("./types").AssetVisibility) =>
      fetchJson<import("./types").WorkspaceAgentInfo>(
        "/system/workspace-agent/visibility",
        { method: "PUT", body: JSON.stringify({ visibility }) }
      ),
    workspaceInstructions: () =>
      fetchText("/workspace"),
    updateWorkspaceInstructions: (content: string) =>
      fetchText("/workspace", {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: content,
      }),
    listWorkspaceVersions: (limit = 50) =>
      fetchJson<import("./types").VersionSummary[]>(`/workspace/versions?limit=${limit}`),
    getWorkspaceVersion: (versionId: string) =>
      fetchJson<{ content: string }>(`/workspace/versions/${encodeURIComponent(versionId)}`),
    rollbackWorkspaceInstructions: (versionId: string) =>
      fetchText(`/workspace/rollback/${versionId}`, { method: "POST" }),
    // Base instructions (the built-in Emily persona). This layer applies to ALL
    // conversations and is layered BEFORE workspace instructions. Editing it
    // saves an override; resetting removes the override and restores the
    // built-in engine default.
    workspaceBasePersona: fetchWorkspaceBasePersona,
    updateWorkspaceBasePersona: (content: string) =>
      fetchText("/workspace/base", {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: content,
      }),
    resetWorkspaceBasePersona: () =>
      fetchRaw("/workspace/base", { method: "DELETE" }).then(() => undefined),
    listWorkspaceBaseVersions: (limit = 50) =>
      fetchJson<import("./types").VersionSummary[]>(`/workspace/base/versions?limit=${limit}`),
    rollbackWorkspaceBasePersona: (versionId: string) =>
      fetchText(`/workspace/base/rollback/${versionId}`, { method: "POST" }),
    gitStatus: () =>
      fetchJson<import("./types").GitWorkspaceStatus>("/system/git"),
    gitConnect: (pat: string) =>
      fetchJson<{ username: string }>("/system/git/connect", {
        method: "POST",
        body: JSON.stringify({ pat }),
      }),
    gitListRepos: () =>
      fetchJson<import("./types").GitRepoItem[]>("/system/git/repos"),
    gitCreateRepo: (name: string) =>
      fetchJson<import("./types").GitRepoItem>("/system/git/repos", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    gitLink: (repo_full_name: string) =>
      fetchJson<import("./types").GitWorkspaceStatus>("/system/git/link", {
        method: "POST",
        body: JSON.stringify({ repo_full_name }),
      }),
    gitPush: () =>
      fetchJson<import("./types").GitWorkspaceStatus>("/system/git/push", { method: "POST" }),
    gitDisconnect: () =>
      fetchRaw("/system/git", { method: "DELETE" }).then(() => undefined),
  },
  connections: {
    list: async () => {
      const rows = await fetchJson<import("./types").ConnectionItem[]>("/connections");
      for (const connection of rows) {
        if (String(connection.status) === "reauth" || connection.status === "expired") {
          captureOnce(`connection_reauth.${connection.id}`, "connection_reauth", {
            connection_id: connection.id,
            app: connection.app_name,
          });
        }
      }
      return rows;
    },
    initiate: async (app_name: string) => {
      capture("channel_install_started", {
        channel: app_name,
      });
      try {
        const result = await fetchJson<import("./types").ConnectionInitResponse>("/connections", {
          method: "POST",
          body: JSON.stringify({ app_name }),
        });
        return result;
      } catch (error) {
        capture("channel_install_failed", {
          channel: app_name,
          error_type: error instanceof Error ? "api_error" : "unknown",
        });
        throw error;
      }
    },
    createMcp: async (payload: {
      label: string;
      transport?: "streamable_http" | "sse" | "stdio";
      url?: string | null;
      command?: string | null;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string | null;
      auth_secret?: string | null;
      allowed_tools?: string[];
    }) => {
      const connection = await fetchJson<import("./types").ConnectionItem>("/connections/mcp", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      capture("connection_added", {
        connection_id: connection.id,
        app: "mcp",
        connection_type: "mcp",
        tool_count: payload.allowed_tools?.length ?? 0,
      });
      return connection;
    },
    byApp: (app_name: string) =>
      fetchJson<import("./types").AppConnectionState>(
        `/connections/by-app/${encodeURIComponent(app_name)}`,
        { cache: "no-store" }
      ),
    status: (id: string) =>
      fetchJson<import("./types").ConnectionItem>(`/connections/${id}/status`),
    delete: async (id: string) => {
      const result = await fetchJson<{ status: string }>(`/connections/${id}`, { method: "DELETE" });
      capture("connection_removed", { connection_id: id });
      return result;
    },
    test: (id: string) =>
      fetchJson<import("./types").ConnectionTestResult>(`/connections/${id}/test`, {
        method: "POST",
      }),
    accountInfo: (id: string) =>
      fetchJson<import("./types").ConnectedAccountMetadata>(
        `/connections/${encodeURIComponent(id)}/account-info`,
        { cache: "no-store" }
      ),
    activity: (id: string, limit = 50) =>
      fetchJson<import("./types").RunSummary[]>(
        `/connections/${encodeURIComponent(id)}/activity?limit=${limit}`,
        { cache: "no-store" }
      ),
    peek: (id: string) =>
      fetchJson<{ emails: Array<{ subject: string; from_name: string; from_email: string; date: string }> }>(
        `/connections/${encodeURIComponent(id)}/peek`,
        { cache: "no-store" }
      ),
  },
  slack: {
    // Read-only status (configured: true/false + installed workspaces). Slack
    // app credentials are platform env, not user-entered; the only install path
    // is "Add to Slack" (one-app OAuth) surfaced on the Assistant page.
    setupStatus: () =>
      fetchJson<import("./types").SlackSetupStatus>("/slack/setup/status", {
        cache: "no-store",
      }),
    installUrl: async (return_to = "/settings#channels") => {
      capture("channel_install_started", { channel: "slack" });
      try {
        const result = await fetchJson<import("./types").SlackInstallUrlResponse>("/slack/oauth/install", {
          method: "POST",
          body: JSON.stringify({ return_to }),
        });
        return result;
      } catch (error) {
        capture("channel_install_failed", {
          channel: "slack",
          error_type: error instanceof Error ? "api_error" : "unknown",
        });
        throw error;
      }
    },
    // Consume a Slack claim token (from ?slack_claim=) and bind the Slack
    // sender identity to the authenticated Floom user.
    claim: async (token: string) => {
      try {
        const result = await fetchJson<{ ok: boolean; slack_team_id: string; slack_user_id: string; user_id: string }>(
          "/slack/bindings/claim",
          {
            method: "POST",
            body: JSON.stringify({ token }),
          }
        );
        capture("channel_installed", { channel: "slack" });
        return result;
      } catch (error) {
        capture("channel_install_failed", {
          channel: "slack",
          error_type: error instanceof Error ? "api_error" : "unknown",
        });
        throw error;
      }
    },
    // My binding status (linked as which Slack user) and unlink.
    bindingMe: () =>
      fetchJson<import("./types").SlackBindingMe>("/slack/bindings/me"),
    unlink: () =>
      fetchJson<{ ok: boolean; unlinked: number }>("/slack/bindings/me", { method: "DELETE" }),
  },
  // My WhatsApp binding status and unlink.
  whatsapp: {
    claim: async (token: string) => {
      try {
        const result = await fetchJson<{ ok: boolean; wa_id: string; user_id: string; workspace_id: string }>(
          "/whatsapp/bindings/claim",
          { method: "POST", body: JSON.stringify({ token }) }
        );
        capture("channel_installed", { channel: "whatsapp" });
        return result;
      } catch (error) {
        capture("channel_install_failed", {
          channel: "whatsapp",
          error_type: error instanceof Error ? "api_error" : "unknown",
        });
        throw error;
      }
    },
    bindingMe: () =>
      fetchJson<import("./types").WhatsAppBindingMe>("/whatsapp/bindings/me"),
    unlink: () =>
      fetchJson<{ ok: boolean; unlinked: number }>("/whatsapp/bindings/me", { method: "DELETE" }),
  },
  workspace: {
    // Download the whole workspace as a .zip template. Returns the Blob so the
    // caller can trigger a browser download. The proxy streams the binary body
    // and preserves content-disposition.
    exportTemplate: async (): Promise<{ blob: Blob; filename: string }> => {
      const res = await fetchRaw("/workspace/export");
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") || "";
      const match = /filename="?([^"]+)"?/.exec(cd);
      const filename = match?.[1] || "workeros-workspace-template.zip";
      return { blob, filename };
    },
    importTemplate: async (
      zipBlob: Blob
    ): Promise<import("./types").WorkspaceImportResult> => {
      const form = new FormData();
      form.append("bundle", zipBlob, "workspace-template.zip");
      const res = await fetchApi("/workspace/import", `${API_BASE}/workspace/import`, {
        method: "POST",
        headers: withWorkspaceHeaders(),
        body: form,
      });
      if (!res.ok) {
        captureApiError("/workspace/import", res.status);
        let err = "";
        try {
          const body = await res.json();
          err = extractApiErrorMessage(body);
        } catch {
          err = res.statusText || `HTTP ${res.status}`;
        }
        throw new Error(err);
      }
      return res.json() as Promise<import("./types").WorkspaceImportResult>;
    },
    list: () => fetchJson<import("./types").LocalWorkspaceListResponse>("/workspaces"),
    create: (name: string) =>
      fetchJson<import("./types").LocalWorkspace>("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    select: (id: string) =>
      fetchJson<import("./types").LocalWorkspace>(`/workspaces/${encodeURIComponent(id)}/select`, {
        method: "POST",
      }),
    // #794/#797: workspace behaviour toggles + model defaults (admin-only PUT).
    getSettings: () => fetchJson<Record<string, string>>("/workspace/settings"),
    setSetting: async (key: string, value: string) => {
      const result = await fetchJson<null>(`/workspace/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      capture("setting_changed", {
        key,
        value_type: value === "true" || value === "false" ? "boolean" : value === "" ? "empty" : "string",
      });
      return result;
    },
    rename: (id: string, name: string) => // #791
      fetchJson<import("./types").LocalWorkspace>(`/workspaces/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    // Duplicate a workspace into a new "<name> (copy)" sibling. On the
    // single-tenant OSS instance, workers/knowledge live in a shared pool, so
    // this mints a new workspace that surfaces the same pool (use Export/Import
    // to move workers between instances).
    duplicate: (id: string) =>
      fetchJson<import("./types").LocalWorkspace>(
        `/workspaces/${encodeURIComponent(id)}/duplicate`,
        { method: "POST" }
      ),
    // Mint a signed, login-free URL a recipient can open to download this
    // workspace as an importable template .zip (no secret values).
    shareLink: () =>
      fetchJson<import("./types").WorkspaceShareLink>("/workspace/share-link"),
    // Workspace tokens (prefix wst_): API access to workspace-shared workers
    // only — no private workers. Admin-only; value is returned once on create.
    tokens: {
      list: () => fetchJson<import("./types").WorkspaceToken[]>("/workspace/tokens"),
      create: (name: string, expiresAt?: string) =>
        fetchJson<import("./types").WorkspaceTokenCreate>("/workspace/tokens", {
          method: "POST",
          body: JSON.stringify({ name, expires_at: expiresAt }),
        }),
      revoke: (tokenId: string) =>
        fetchJson<null>(`/workspace/tokens/${encodeURIComponent(tokenId)}`, {
          method: "DELETE",
        }),
    },
  },
  // Workspace members (STEP 2). Engine-owned membership: the OSS engine is the
  // single-owner degenerate case (you = Owner); Cloud serves the same shape with
  // real members. The role matrix is enforced server-side; the UI only gates
  // affordances on `my_role`.
  members: {
    list: () =>
      fetchJson<import("./types").WorkspaceMembersResponse>("/workspace/members"),
    invite: (email: string, role: "admin" | "member") =>
      fetchJson<import("./types").WorkspaceMember>("/workspace/members", {
        method: "POST",
        body: JSON.stringify({ email, role }),
      }),
    setRole: (userId: string, role: "admin" | "member") =>
      fetchJson<import("./types").WorkspaceMember>(
        `/workspace/members/${encodeURIComponent(userId)}`,
        { method: "PATCH", body: JSON.stringify({ role }) }
      ),
    remove: (userId: string) =>
      fetchJson<null>(`/workspace/members/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    transferOwner: (newOwnerId: string) =>
      fetchJson<import("./types").WorkspaceMember>(
        "/workspace/members/transfer-owner",
        { method: "POST", body: JSON.stringify({ new_owner_id: newOwnerId }) }
      ),
  },
  conversations: {
    list: (limit = 50) =>
      fetchJson<import("./types").ConversationSummary[]>(`/conversations?limit=${limit}`),
    get: (id: string) =>
      fetchJson<import("./types").ConversationDetail>(`/conversations/${encodeURIComponent(id)}`),
  },
  // Multi-member: user management + personal access tokens
  users: {
    list: () => fetchJson<import("./types").OssUser[]>("/users"),
    create: (data: { username: string; password: string; display_name?: string; role?: string }) =>
      fetchJson<import("./types").OssUser>("/users", { method: "POST", body: JSON.stringify(data) }),
    update: (userId: string, data: Partial<{ display_name: string; role: string; disabled: boolean; password: string }>) =>
      fetchJson<import("./types").OssUser>(`/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    remove: (userId: string) =>
      fetchJson<null>(`/users/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  },
  tokens: {
    list: () => fetchJson<import("./types").PersonalAccessToken[]>("/auth/tokens"),
    create: (name: string, expiresAt?: string) =>
      fetchJson<import("./types").PersonalAccessTokenCreate>("/auth/tokens", {
        method: "POST",
        body: JSON.stringify({ name, expires_at: expiresAt }),
      }),
    revoke: (tokenId: string) =>
      fetchJson<null>(`/auth/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" }),
  },
  authMe: () => fetchJson<import("./types").AuthMe>("/auth/me"),
  integrations: {
    triggers: () =>
      fetchJson<{ items: import("./types").ComposioTriggerItem[] }>("/integrations/triggers"),
    triggersForApp: (app: string) =>
      fetchJson<{ items: import("./types").ComposioTriggerItem[] }>(
        `/integrations/triggers?app=${encodeURIComponent(app)}`
      ),
    catalog: (params?: { page?: number; limit?: number; search?: string; category?: string }) => {
      const qs = new URLSearchParams();
      qs.set("page", String(params?.page ?? 1));
      qs.set("limit", String(params?.limit ?? 30));
      if (params?.search) qs.set("search", params.search);
      if (params?.category) qs.set("category", params.category);
      return fetchJson<import("./types").IntegrationCatalogResponse>(
        `/integrations/catalog?${qs.toString()}`
      );
    },
    catalogTools: (slug: string, limit = 100) => {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit));
      return fetchJson<import("./types").CatalogToolItem[]>(
        `/integrations/catalog/${encodeURIComponent(slug)}/tools?${qs.toString()}`
      );
    },
  },
};
