import { cookies } from "next/headers";
import { resolveSessionPayload } from "@/lib/verify-session";
import type {
  ConnectionItem,
  ContextSummary,
  PublicWorker,
  RunSummary,
  StandaloneShare,
  SystemOverview,
  WorkerSummary,
} from "@/lib/types";

const API_BASE =
  process.env.WORKEROS_API_BASE || "https://workeros-api.floom.dev";
const SESSION_COOKIE = "workeros_cloud_session";
const ACTIVE_WORKSPACE_COOKIE = "workeros_active_workspace";

async function authHeaders(): Promise<Record<string, string>> {
  const cookieStore = await cookies();
  const rawSession = cookieStore.get(SESSION_COOKIE)?.value;
  if (!rawSession) {
    throw new Error("Cloud session cookie missing");
  }

  const session = await resolveSessionPayload(rawSession, `${SESSION_COOKIE}=${rawSession}`);
  const accessToken = session?.payload.access_token;
  if (!accessToken) {
    throw new Error("Cloud session access token missing");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  const activeWorkspace = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  if (activeWorkspace) {
    headers["x-workeros-workspace"] = activeWorkspace;
  }
  return headers;
}

export async function serverFetch<T>(
  path: string,
  options?: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } }
): Promise<T> {
  const { next, ...fetchOptions } = options ?? {};
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...fetchOptions,
    headers: {
      ...(await authHeaders()),
      ...fetchOptions?.headers,
    },
    ...(next ? { next } : {}),
  });

  if (!res.ok) {
    let err = "";
    try {
      const body = await res.json();
      err = body.detail || JSON.stringify(body);
    } catch {
      err = res.statusText || `HTTP ${res.status}`;
    }
    throw new Error(`Cloud API error ${res.status}: ${err}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchWorkerList() {
  return serverFetch<WorkerSummary[]>("/workers?shape=list", {
    next: { revalidate: 30 },
  });
}

export async function fetchOverview() {
  return serverFetch<SystemOverview>("/system/overview", {
    next: { revalidate: 10 },
  });
}

// perf-F2 mirror: the engine /library page now server-fetches brain folders.
// The cloud serverFetch prepends /api → /api/contexts, with the cloud session
// Bearer + workspace header. BrainCollection falls back to a client query on [].
export async function fetchBrainFolders() {
  return serverFetch<ContextSummary[]>("/contexts", {
    next: { revalidate: 30 },
  });
}

export async function fetchRuns(params?: {
  worker_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.worker_id) qs.append("worker_id", params.worker_id);
  if (params?.status) qs.append("status", params.status);
  if (params?.limit) qs.append("limit", String(params.limit));
  if (params?.offset) qs.append("offset", String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return serverFetch<RunSummary[]>(`/runs${query}`, {
    next: { revalidate: 10 },
  });
}

export async function fetchConnections() {
  return serverFetch<ConnectionItem[]>("/connections", {
    next: { revalidate: 10 },
  });
}

export async function fetchPublicWorker(id: string, token: string) {
  return serverFetch<PublicWorker>(
    `/workers/public/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`,
    { next: { revalidate: 30 } }
  );
}

export async function fetchStandaloneShare(token: string) {
  const res = await fetch(`${API_BASE}/api/s/${encodeURIComponent(token)}`, {
    headers: {
      "content-type": "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let err = "";
    try {
      const body = await res.json();
      err = body.detail || JSON.stringify(body);
    } catch {
      err = res.statusText || `HTTP ${res.status}`;
    }
    throw new Error(`Cloud public API error ${res.status}: ${err}`);
  }
  return res.json() as Promise<StandaloneShare>;
}
