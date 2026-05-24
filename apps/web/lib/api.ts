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
    run: (id: string, inputs: Record<string, any>) =>
      fetchJson<import("./types").ActionResponse>(`/workers/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({ inputs, trigger_source: "manual" }),
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
    approve: (id: string) =>
      fetchJson<import("./types").ActionResponse>(`/runs/${id}/approve`, { method: "POST" }),
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
  },
};
