/**
 * Server-side API fetch helper.
 *
 * Calls the upstream API directly (bypassing the /api/proxy route) using
 * FLOOM_API_BASE + FLOOM_API_SECRET from env. Only valid in Server Components
 * and Route Handlers — never import this from client-side code.
 */

import { cookies } from "next/headers";

const API_BASE =
  process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";
const ACTIVE_WORKSPACE_COOKIE_KEY = "workeros.activeWorkspaceId";

export async function serverFetch<T>(
  path: string,
  options?: RequestInit & {
    next?: { revalidate?: number | false; tags?: string[] };
    includeWorkspace?: boolean;
  }
): Promise<T> {
  const { next, includeWorkspace = true, ...fetchOptions } = options ?? {};
  const cookieStore = await cookies();
  const workspaceCookie = cookieStore.get(ACTIVE_WORKSPACE_COOKIE_KEY)?.value || "";
  const backendSession = cookieStore.get("wos_session")?.value || "";
  const activeWorkspace = workspaceCookie ? decodeURIComponent(workspaceCookie) : "local-default";
  const headers = new Headers(fetchOptions.headers);
  headers.set("content-type", "application/json");
  headers.set("x-floom-secret", API_SECRET);
  if (includeWorkspace && activeWorkspace) {
    headers.set("x-workeros-workspace", activeWorkspace);
  }
  if (backendSession) {
    headers.set("cookie", `wos_session=${backendSession}`);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers,
    // next.js cache config — passed through as NextFetchRequestConfig
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
    throw new Error(`API error ${res.status}: ${err}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch worker list (trimmed list-shape, 30s cache). */
export async function fetchWorkerList() {
  return serverFetch<import("./types").WorkerSummary[]>("/workers?shape=list", {
    next: { revalidate: 30 },
  });
}

/** Fetch overview stats (10s cache — user-specific). */
export async function fetchOverview() {
  return serverFetch<import("./types").SystemOverview>("/system/overview", {
    next: { revalidate: 10 },
  });
}

/** Fetch recent runs (10s cache — user-specific). */
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
  return serverFetch<import("./types").RunSummary[]>(`/runs${query}`, {
    next: { revalidate: 10 },
  });
}

/** Fetch connections list (10s cache). */
export async function fetchConnections() {
  return serverFetch<import("./types").ConnectionItem[]>("/connections", {
    next: { revalidate: 10 },
  });
}

/**
 * Fetch the read-only public projection of a worker for a signed share link.
 * Authenticated by the HMAC `token` alone (no app login). Returns the
 * allow-listed PublicWorker — never secrets, source, or run history.
 */
export async function fetchPublicWorker(id: string, token: string) {
  return serverFetch<import("./types").PublicWorker>(
    `/workers/public/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`,
    { next: { revalidate: 30 }, includeWorkspace: false }
  );
}

/** Fetch a no-login standalone share payload for /s/<token>. */
export async function fetchStandaloneShare(token: string) {
  return serverFetch<import("./types").StandaloneShare>(
    `/s/${encodeURIComponent(token)}`,
    { next: { revalidate: false }, includeWorkspace: false }
  );
}
