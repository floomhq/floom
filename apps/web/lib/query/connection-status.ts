import type { QueryClient } from "@tanstack/react-query";

const CONNECTION_STATUS_QUERY_KEYS = [
  ["connections"],
  ["worker-detail"],
  ["system", "overview"],
] as const;

/**
 * Mark every connection-dependent query stale and refetch active and inactive
 * matches. Inactive matches include views restored from the persisted cache.
 */
export async function refetchConnectionReads(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    CONNECTION_STATUS_QUERY_KEYS.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, refetchType: "all" }),
    ),
  );
}
