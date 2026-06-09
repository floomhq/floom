// Same-origin proxy base. Defaults to "/api/proxy" for the single-tenant OSS
// build. The Cloud build serves the dashboard under basePath "/app", where raw
// fetch() calls are NOT auto-prefixed by basePath, so Cloud sets
// NEXT_PUBLIC_API_PROXY_BASE="/app/api/proxy". Keeping this an env seam lets the
// Cloud wrapper consume this file unmodified (no fork).
export const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
const WEB_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";
const APP_API_BASE = API_BASE.endsWith("/api/proxy")
  ? API_BASE.slice(0, -"/api/proxy".length) + "/api"
  : "/api";
let loginRedirectStarted = false;

export function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  return value && value !== "local-default" ? value : null;
}

export function setActiveWorkspaceId(workspaceId: string | null) {
  if (typeof window === "undefined") return;
  if (!workspaceId || workspaceId === "local-default") {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } else {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
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
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
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
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    handleUnauthorizedResponse(res.status, path);
    throw new Error(await apiErrorFromResponse(res));
  }
  if (res.status === 204) return "";
  return res.text();
}

async function fetchRaw(path: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: withWorkspaceHeaders(options?.headers),
  });
  if (!res.ok) {
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
    const res = await fetch(`${APP_API_BASE}/me`, {
      cache: "no-store",
      headers: withWorkspaceHeaders(),
    });
    if (!res.ok) {
      handleUnauthorizedResponse(res.status, "/me");
      throw new Error(await apiErrorFromResponse(res));
    }
    return res.json() as Promise<import("./types").CurrentUser>;
  },
  whatsapp: {
    claim: (token: string) =>
      fetchJson<{ ok: boolean; wa_id: string; user_id: string }>("/whatsapp/bindings/claim", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
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
    archive: (id: string) => fetchJson<import("./types").WorkerDetail>(`/workers/${id}/archive`, { method: "POST" }),
    setVisibility: (id: string, visibility: import("./types").AssetVisibility) =>
      fetchJson<import("./types").WorkerDetail>(`/workers/${id}/visibility`, {
        method: "PUT",
        body: JSON.stringify({ visibility }),
      }),
    shareLink: (id: string) =>
      fetchJson<import("./types").StandaloneShareLink>(`/workers/${encodeURIComponent(id)}/share-link`, {
        method: "POST",
      }),
    importFromShare: (token: string) =>
      fetchJson<{ worker_id: string; url: string }>("/workers/import-from-share", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    reload: () =>
      fetchJson<import("./types").ReloadResponse>("/workers/reload", { method: "POST" }),
    run: (id: string, inputs: Record<string, unknown>) =>
      fetchJson<import("./types").ActionResponse>(`/workers/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({ inputs, trigger_source: "manual" }),
      }),
    create: (worker_yml: string, run_py: string, skill_md?: string) =>
      fetchJson<import("./types").WorkerDetail>("/workers", {
        method: "POST",
        body: JSON.stringify({ worker_yml, run_py, ...(skill_md !== undefined ? { skill_md } : {}) }),
      }),
    draftFromPrompt: (prompt: string) =>
      fetchJson<import("./types").DraftFromPromptResponse>("/workers/draft-from-prompt", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),
    draftAndCreate: (params: { prompt?: string; files?: { path: string; content: string }[] }) =>
      fetchJson<{ worker_id: string }>("/workers/draft-and-create", {
        method: "POST",
        body: JSON.stringify(params),
      }),
    newFromPrompt: (params: { prompt: string; mode?: "draft" | "create"; parent_worker_id?: string }) =>
      fetchJson<{ run_id: string; worker_id: string; status: string }>("/workers/new/from-prompt", {
        method: "POST",
        body: JSON.stringify(params),
      }),
    createFromBundle: async (zipBlob: Blob): Promise<import("./types").WorkerDetail> => {
      const form = new FormData();
      form.append("bundle", zipBlob, "bundle.zip");
      const res = await fetch(`${API_BASE}/workers/from-bundle`, {
        method: "POST",
        headers: withWorkspaceHeaders(),
        body: form,
      });
      if (!res.ok) {
        let err: string;
        try {
          const body = await res.json();
          err = extractApiErrorMessage(body);
        } catch {
          err = res.statusText;
        }
        throw new Error(err);
      }
      return res.json() as Promise<import("./types").WorkerDetail>;
    },
    update: (id: string, worker_yml: string, run_py: string, skill_md?: string) =>
      fetchJson<import("./types").WorkerDetail>(`/workers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ worker_yml, run_py, ...(skill_md !== undefined ? { skill_md } : {}) }),
      }),
    suggest: (id: string, newDescription: string) =>
      fetchJson<import("./types").WorkerSuggestResponse>(`/workers/${id}/suggest`, {
        method: "POST",
        body: JSON.stringify({ new_description: newDescription }),
      }),
    updateFiles: (id: string, files: { path: string; content: string }[]) =>
      fetchJson<import("./types").WorkerDetail>(`/workers/${id}/files`, {
        method: "PUT",
        body: JSON.stringify({ files }),
      }),
    delete: (id: string) =>
      fetchJson<{ status: string }>(`/workers/${id}`, { method: "DELETE" }),
    listVersions: (id: string, limit = 50) =>
      fetchJson<import("./types").VersionSummary[]>(`/workers/${id}/versions?limit=${limit}`),
    getVersion: (id: string, versionId: string) =>
      fetchJson<import("./types").VersionDetail>(`/workers/${id}/versions/${versionId}`),
    rollback: (id: string, versionId: string) =>
      fetchJson<import("./types").WorkerDetail>(`/workers/${id}/rollback/${versionId}`, { method: "POST" }),
  },
  runs: {
    list: (params?: {
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
      return fetchJson<import("./types").RunSummary[]>(`/runs?${qs.toString()}`);
    },
    get: (id: string) => fetchJson<import("./types").RunDetail>(`/runs/${id}`),
    logs: (id: string) => fetchJson<import("./types").LogEntry[]>(`/runs/${id}/logs`),
    cancel: (id: string) =>
      fetchJson<import("./types").ActionResponse>(`/runs/${id}/cancel`, {
        method: "POST",
      }),
    approve: (
      id: string,
      editedOutput?: Record<string, unknown>,
      annotations?: import("./types").ApprovalAnnotations | null
    ) =>
      fetchJson<import("./types").ActionResponse>(`/runs/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ edited_output: editedOutput ?? null, annotations: annotations ?? null }),
      }),
    reject: (
      id: string,
      reason?: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) =>
      fetchJson<import("./types").ActionResponse>(`/runs/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reason ?? null, annotations: annotations ?? null }),
      }),
    replay: (workerId: string, runId: string) =>
      fetchJson<{ run_id: string }>(
        `/workers/${encodeURIComponent(workerId)}/runs/${encodeURIComponent(runId)}/replay`,
        { method: "POST" }
      ),
    downloadUrl: (id: string) =>
      `${API_BASE}${withWorkspaceQuery(`/runs/${encodeURIComponent(id)}/download`)}`,
    artifactUrl: (id: string, artifactId: string) =>
      `${API_BASE}${withWorkspaceQuery(`/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/download`)}`,
    bundleUrl: (id: string, filename: string) =>
      `${API_BASE}${withWorkspaceQuery(`/runs/${encodeURIComponent(id)}/bundle/${encodeURIComponent(filename)}`)}`,
  },
  approvals: {
    list: (status?: string) => {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return fetchJson<import("./types").ApprovalRow[]>(`/approvals${qs}`);
    },
    count: () => fetchJson<{ pending: number }>("/approvals/count"),
    approveAction: (
      approvalId: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) =>
      fetchJson<{ status: string; executed: string; detail: string }>(
        `/approvals/${approvalId}/approve-action`,
        {
          method: "POST",
          body: JSON.stringify({ annotations: annotations ?? null }),
        }
      ),
    rejectAction: (
      approvalId: string,
      reason?: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) =>
      fetchJson<{ status: string; path: string; reason?: string }>(
        `/approvals/${approvalId}/reject-action`,
        {
          method: "POST",
          body: JSON.stringify({ reason, annotations: annotations ?? null }),
        }
      ),
    publicGet: (approvalId: string, token: string) =>
      fetchJson<import("./types").ApprovalRow>(
        `/approvals/public/${encodeURIComponent(approvalId)}?token=${encodeURIComponent(token)}`
      ),
    publicApprove: (
      approvalId: string,
      token: string,
      editedOutput?: Record<string, unknown>,
      annotations?: import("./types").ApprovalAnnotations | null
    ) =>
      fetchJson<import("./types").ActionResponse>(
        `/approvals/public/${encodeURIComponent(approvalId)}/approve?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          body: JSON.stringify({ edited_output: editedOutput ?? null, annotations: annotations ?? null }),
        }
      ),
    publicReject: (
      approvalId: string,
      token: string,
      reason?: string,
      annotations?: import("./types").ApprovalAnnotations | null
    ) =>
      fetchJson<import("./types").ActionResponse>(
        `/approvals/public/${encodeURIComponent(approvalId)}/reject?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          body: JSON.stringify({ reason: reason ?? null, annotations: annotations ?? null }),
        }
      ),
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
      const res = await fetch(
        `${API_BASE}/approvals/${encodeURIComponent(approvalId)}/uploads`,
        { method: "POST", headers: withWorkspaceHeaders(), body: form }
      );
      if (!res.ok) {
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
      const res = await fetch(
        `${API_BASE}/approvals/public/${encodeURIComponent(approvalId)}/uploads?token=${encodeURIComponent(token)}`,
        { method: "POST", body: form }
      );
      if (!res.ok) {
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
    create: (name: string, writeable = false) =>
      fetchJson<import("./types").ContextDetail>(`/contexts/${encodeURIComponent(name)}`, {
        method: "POST",
        body: JSON.stringify({ writeable }),
      }),
    // Members STEP 4: Private <-> Shared with workspace.
    setVisibility: (name: string, visibility: import("./types").AssetVisibility) =>
      fetchJson<import("./types").ContextDetail>(
        `/contexts/${encodeURIComponent(name)}/visibility`,
        { method: "PUT", body: JSON.stringify({ visibility }) }
      ),
    setSensitive: (name: string, sensitive: boolean) =>
      fetchJson<{ name: string; sensitive: boolean }>(
        `/contexts/${encodeURIComponent(name)}/sensitive`,
        { method: "PATCH", body: JSON.stringify({ sensitive }) }
      ),
    sharePackLink: (name: string) =>
      fetchJson<import("./types").StandaloneShareLink>(
        `/contexts/${encodeURIComponent(name)}/share-link`,
        { method: "POST" }
      ),
    delete: (name: string, force = false) =>
      fetchJson<{ status: string; referenced_by: string[] }>(
        `/contexts/${encodeURIComponent(name)}${force ? "?force=true" : ""}`,
        { method: "DELETE" }
      ),
    saveTextFile: (name: string, path: string, content: string) =>
      fetchJson<import("./types").ContextFileItem>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        { method: "PUT", body: JSON.stringify({ content }) }
      ),
    deleteFile: (name: string, path: string) =>
      fetchJson<import("./types").ContextDetail>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        { method: "DELETE" }
      ),
    shareFileLink: (name: string, path: string) =>
      fetchJson<import("./types").StandaloneShareLink>(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}/share-link`,
        { method: "POST" }
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
      const res = await fetch(`${API_BASE}/contexts/${encodeURIComponent(name)}/upload`, {
        method: "POST",
        headers: withWorkspaceHeaders(),
        body: form,
      });
      if (!res.ok) {
        let err = "";
        try {
          const body = await res.json();
          err = extractApiErrorMessage(body);
        } catch {
          err = res.statusText || `HTTP ${res.status}`;
        }
        throw new Error(err);
      }
      return res.json() as Promise<{ files: import("./types").ContextFileItem[]; total_size_bytes: number }>;
    },
    fetchFileBlob: async (name: string, path: string) => {
      const res = await fetch(
        `${API_BASE}/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: withWorkspaceHeaders() }
      );
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
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
    metrics: () => fetchJson<import("./types").SystemMetrics>("/system/metrics"),
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
    list: () => fetchJson<import("./types").ConnectionItem[]>("/connections"),
    initiate: (app_name: string) =>
      fetchJson<import("./types").ConnectionInitResponse>("/connections", {
        method: "POST",
        body: JSON.stringify({ app_name }),
      }),
    createMcp: (payload: {
      label: string;
      transport?: "streamable_http" | "sse" | "stdio";
      url?: string | null;
      command?: string | null;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string | null;
      auth_secret?: string | null;
      allowed_tools?: string[];
    }) =>
      fetchJson<import("./types").ConnectionItem>("/connections/mcp", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    byApp: (app_name: string) =>
      fetchJson<import("./types").AppConnectionState>(
        `/connections/by-app/${encodeURIComponent(app_name)}`,
        { cache: "no-store" }
      ),
    status: (id: string) =>
      fetchJson<import("./types").ConnectionItem>(`/connections/${id}/status`),
    delete: (id: string) =>
      fetchJson<{ status: string }>(`/connections/${id}`, { method: "DELETE" }),
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
    installUrl: (return_to = "/assistant") =>
      fetchJson<import("./types").SlackInstallUrlResponse>("/slack/oauth/install", {
        method: "POST",
        body: JSON.stringify({ return_to }),
      }),
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
      const res = await fetch(`${API_BASE}/workspace/import`, {
        method: "POST",
        headers: withWorkspaceHeaders(),
        body: form,
      });
      if (!res.ok) {
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
