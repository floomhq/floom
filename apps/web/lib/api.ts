const API_BASE = "/api/proxy";

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
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
  return res.json();
}

export const api = {
  workers: {
    list: () => fetchJson<import("./types").WorkerSummary[]>("/workers"),
    get: (id: string) => fetchJson<import("./types").WorkerDetail>(`/workers/${id}`),
    reload: () =>
      fetchJson<import("./types").ReloadResponse>("/workers/reload", { method: "POST" }),
    run: (id: string, inputs: Record<string, unknown>) =>
      fetchJson<import("./types").ActionResponse>(`/workers/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({ inputs, trigger_source: "manual" }),
      }),
    pause: (id: string) =>
      fetchJson<import("./types").ActionResponse>(`/workers/${id}/pause`, { method: "POST" }),
    unpause: (id: string) =>
      fetchJson<import("./types").ActionResponse>(`/workers/${id}/unpause`, { method: "POST" }),
    create: (worker_yml: string, run_py: string) =>
      fetchJson<import("./types").WorkerDetail>("/workers", {
        method: "POST",
        body: JSON.stringify({ worker_yml, run_py }),
      }),
  },
  runs: {
    list: (params?: { worker_id?: string; status?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.worker_id) qs.append("worker_id", params.worker_id);
      if (params?.status) qs.append("status", params.status);
      if (params?.limit) qs.append("limit", String(params.limit));
      if (params?.offset) qs.append("offset", String(params.offset));
      return fetchJson<import("./types").RunSummary[]>(`/runs?${qs.toString()}`);
    },
    get: (id: string) => fetchJson<import("./types").RunDetail>(`/runs/${id}`),
    logs: (id: string) => fetchJson<import("./types").LogEntry[]>(`/runs/${id}/logs`),
    approve: (id: string, editedOutput?: string) =>
      fetchJson<import("./types").ActionResponse>(`/runs/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(editedOutput != null ? { edited_output: editedOutput } : {}),
      }),
    reject: (id: string, reason?: string) =>
      fetchJson<import("./types").ActionResponse>(`/runs/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
  },
  approvals: {
    list: (status = "pending") =>
      fetchJson<import("./types").ApprovalDetail[]>(`/approvals?status=${status}`),
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
  system: {
    info: () => fetchJson<Record<string, unknown>>("/system/info"),
    platformConfig: () => fetchJson<{ platform_secrets: { name: string; status: string }[] }>("/system/platform-config"),
    clearRuns: () => fetchJson<import("./types").ActionResponse>("/runs/clear", { method: "POST" }),
  },
  connections: {
    list: () => fetchJson<import("./types").ConnectionItem[]>("/connections"),
    initiate: (app_name: string) =>
      fetchJson<import("./types").ConnectionInitResponse>("/connections", {
        method: "POST",
        body: JSON.stringify({ app_name }),
      }),
    status: (id: string) =>
      fetchJson<import("./types").ConnectionItem>(`/connections/${id}/status`),
    delete: (id: string) =>
      fetchJson<{ status: string }>(`/connections/${id}`, { method: "DELETE" }),
  },
  integrations: {
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
