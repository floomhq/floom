const API_BASE = "/api/proxy";

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    // PR S19 (I-6): surface SOMETHING actionable even when the upstream
    // returns no JSON body (Vercel 504 timeouts hand back empty HTML).
    let err = "";
    try {
      const body = await res.json();
      err = body.detail || JSON.stringify(body);
    } catch {
      err = "";
    }
    if (!err || err === "{}") {
      err =
        res.status === 504
          ? "Request timed out. The server took too long to respond."
          : res.statusText || `HTTP ${res.status}`;
    }
    throw new Error(err);
  }
  return res.json();
}

async function fetchRaw(path: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    let err = "";
    try {
      const body = await res.json();
      err = body.detail || JSON.stringify(body);
    } catch {
      err = res.statusText || `HTTP ${res.status}`;
    }
    throw new Error(err);
  }
  return res;
}

export const api = {
  workers: {
    // S44 Win 3: use list shape (~15 KB vs 47 KB full) for the web UI.
    // CLI consumers that call GET /workers directly get full payload (no ?shape=list).
    list: () => fetchJson<import("./types").WorkerSummary[]>("/workers?shape=list"),
    get: (id: string) => fetchJson<import("./types").WorkerDetail>(`/workers/${id}`),
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
      const res = await fetch(`${API_BASE}/workers/from-bundle`, { method: "POST", body: form });
      if (!res.ok) {
        let err: string;
        try {
          const body = await res.json();
          err = body.detail || JSON.stringify(body);
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
    updateFiles: (id: string, files: { path: string; content: string }[]) =>
      fetchJson<import("./types").WorkerDetail>(`/workers/${id}/files`, {
        method: "PUT",
        body: JSON.stringify({ files }),
      }),
    delete: (id: string) =>
      fetchJson<{ status: string }>(`/workers/${id}`, { method: "DELETE" }),
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
    replay: (workerId: string, runId: string) =>
      fetchJson<{ run_id: string }>(
        `/workers/${encodeURIComponent(workerId)}/runs/${encodeURIComponent(runId)}/replay`,
        { method: "POST" }
      ),
    downloadUrl: (id: string) => `${API_BASE}/runs/${encodeURIComponent(id)}/download`,
    artifactUrl: (id: string, artifactId: string) =>
      `${API_BASE}/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/download`,
    bundleUrl: (id: string, filename: string) =>
      `${API_BASE}/runs/${encodeURIComponent(id)}/bundle/${encodeURIComponent(filename)}`,
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
    readTextFile: async (name: string, path: string) => {
      const res = await fetchRaw(
        `/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`
      );
      return res.text();
    },
    upload: async (name: string, files: FileList | File[], options?: { createIfMissing?: boolean }) => {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append("files", file, file.name));
      if (options?.createIfMissing) form.append("create_if_missing", "true");
      const res = await fetch(`${API_BASE}/contexts/${encodeURIComponent(name)}/upload`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        let err = "";
        try {
          const body = await res.json();
          err = body.detail || JSON.stringify(body);
        } catch {
          err = res.statusText || `HTTP ${res.status}`;
        }
        if (/request body too large/i.test(err)) {
          err = "Brain upload is too large. Upload files up to 25 MB.";
        }
        throw new Error(err);
      }
      return res.json() as Promise<{ files: import("./types").ContextFileItem[]; total_size_bytes: number }>;
    },
    fileUrl: (name: string, path: string) =>
      `${API_BASE}/contexts/${encodeURIComponent(name)}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
  },
  system: {
    info: () => fetchJson<import("./types").SystemInfo>("/system/info"),
    platformConfig: () => fetchJson<import("./types").PlatformConfig>("/system/platform-config"),
    overview: () => fetchJson<import("./types").SystemOverview>("/system/overview"),
    metrics: () => fetchJson<import("./types").SystemMetrics>("/system/metrics"),
    clearRuns: () => fetchJson<import("./types").ActionResponse>("/runs/clear", { method: "POST" }),
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
      url: string;
      auth_secret?: string | null;
      allowed_tools?: string[];
    }) =>
      fetchJson<import("./types").ConnectionItem>("/connections/mcp", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    status: (id: string) =>
      fetchJson<import("./types").ConnectionItem>(`/connections/${id}/status`),
    delete: (id: string) =>
      fetchJson<{ status: string }>(`/connections/${id}`, { method: "DELETE" }),
    test: (id: string) =>
      fetchJson<import("./types").ConnectionTestResult>(`/connections/${id}/test`, {
        method: "POST",
      }),
  },
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
  },
};
