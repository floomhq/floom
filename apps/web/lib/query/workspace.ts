"use client";

import type { QueryClient } from "@tanstack/react-query";

export const WORKSPACE_SCOPED_QUERY_ROOTS = [
  "system",
  "workers",
  "runs",
  "contexts",
  "connections",
  "secrets",
  "approvals",
  "workspace",
] as const;

export function clearedWorkspaceQueryData(current: unknown): unknown {
  return Array.isArray(current) ? [] : null;
}

export async function refetchWorkspaceScopedQueries(queryClient: QueryClient): Promise<void> {
  for (const root of WORKSPACE_SCOPED_QUERY_ROOTS) {
    queryClient.removeQueries({ queryKey: [root], type: "inactive" });
  }
  for (const root of WORKSPACE_SCOPED_QUERY_ROOTS) {
    queryClient.setQueriesData({ queryKey: [root], type: "active" }, clearedWorkspaceQueryData);
  }

  await Promise.all(
    WORKSPACE_SCOPED_QUERY_ROOTS.map((root) =>
      queryClient.invalidateQueries({ queryKey: [root], refetchType: "none" }),
    ),
  );
  await Promise.all(
    WORKSPACE_SCOPED_QUERY_ROOTS.map((root) =>
      queryClient.refetchQueries({ queryKey: [root], type: "active" }),
    ),
  );
}
