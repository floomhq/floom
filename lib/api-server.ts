import "server-only";
import { readSession } from "./session";
import { API_BASE } from "./api";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await readSession();
  const headers = new Headers(init.headers);
  if (session?.accessToken) {
    headers.set("Authorization", `Bearer ${session.accessToken}`);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
}

export async function apiGetJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
