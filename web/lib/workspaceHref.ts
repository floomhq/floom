export type WorkspaceSearchParams =
  | URLSearchParams
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";

function browserWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search || "");
  const urlWorkspace = params.get("workspace_id") || params.get("ws");
  if (urlWorkspace) return urlWorkspace;
  try {
    return window.localStorage?.getItem(ACTIVE_WORKSPACE_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function workspaceIdFrom(searchParams: WorkspaceSearchParams): string | null {
  if (searchParams === undefined && typeof window !== "undefined") {
    return browserWorkspaceId();
  }
  if (!searchParams) return null;
  const getter = (searchParams as { get?: unknown }).get;
  if (typeof getter === "function") {
    const readable = searchParams as { get(name: string): string | null };
    return readable.get("workspace_id") || readable.get("ws");
  }
  const record = searchParams as Record<string, string | string[] | undefined>;
  const value = record.workspace_id ?? record.ws;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

export function withWorkspaceParam(href: string, searchParams?: WorkspaceSearchParams): string {
  const workspaceId = workspaceIdFrom(searchParams);
  if (workspaceId === null || !isInternalHref(href)) return href;
  return withWorkspaceIdParam(href, workspaceId);
}

export function withWorkspaceIdParam(href: string, workspaceId: string | null | undefined): string {
  if (!workspaceId || !isInternalHref(href)) return href;

  const hashIndex = href.indexOf("#");
  const hrefWithoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  const queryIndex = hrefWithoutHash.indexOf("?");
  const path = queryIndex === -1 ? hrefWithoutHash : hrefWithoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : hrefWithoutHash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  if (params.has("workspace_id") || params.has("ws")) return href;

  params.set("workspace_id", workspaceId);
  return `${path}?${params.toString()}${hash}`;
}
