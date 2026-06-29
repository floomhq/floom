export type WorkspaceSearchParams =
  | URLSearchParams
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function workspaceIdFrom(searchParams: WorkspaceSearchParams): string | null {
  if (searchParams === undefined && typeof window !== "undefined") {
    return new URLSearchParams(window.location.search).get("workspace_id");
  }
  if (!searchParams) return null;
  const getter = (searchParams as { get?: unknown }).get;
  if (typeof getter === "function") {
    return (searchParams as { get(name: string): string | null }).get("workspace_id");
  }
  const value = (searchParams as Record<string, string | string[] | undefined>).workspace_id;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

export function withWorkspaceParam(href: string, searchParams?: WorkspaceSearchParams): string {
  const workspaceId = workspaceIdFrom(searchParams);
  if (workspaceId === null || !isInternalHref(href)) return href;

  const hashIndex = href.indexOf("#");
  const hrefWithoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  const queryIndex = hrefWithoutHash.indexOf("?");
  const path = queryIndex === -1 ? hrefWithoutHash : hrefWithoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : hrefWithoutHash.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  if (params.has("workspace_id")) return href;

  params.set("workspace_id", workspaceId);
  return `${path}?${params.toString()}${hash}`;
}
