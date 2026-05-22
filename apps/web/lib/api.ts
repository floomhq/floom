const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || res.statusText);
  }
  return res.json();
}

export const api = {
  workers: {
    list: () => fetchJson<any[]>("/workers"),
    get: (id: string) => fetchJson<any>(`/workers/${id}`),
    reload: () => fetchJson<{ status: string; workers_loaded: number }>("/workers/reload", { method: "POST" }),
    run: (id: string, inputs: Record<string, any>) =>
      fetchJson<{ run_id: string; status: string }>(`/workers/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({ inputs, trigger_source: "manual" }),
      }),
  },
  runs: {
    list: (params?: { worker_id?: string; status?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.worker_id) qs.append("worker_id", params.worker_id);
      if (params?.status) qs.append("status", params.status);
      if (params?.limit) qs.append("limit", String(params.limit));
      return fetchJson<any[]>(`/runs?${qs.toString()}`);
    },
    get: (id: string) => fetchJson<any>(`/runs/${id}`),
    logs: (id: string) => fetchJson<any[]>(`/runs/${id}/logs`),
    approve: (id: string) => fetchJson<{ status: string }>(`/runs/${id}/approve`, { method: "POST" }),
    reject: (id: string, reason?: string) =>
      fetchJson<{ status: string }>(`/runs/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
  },
  approvals: {
    list: (status = "pending") => fetchJson<any[]>(`/approvals?status=${status}`),
  },
  secrets: {
    list: () => fetchJson<any[]>("/secrets"),
  },
};
