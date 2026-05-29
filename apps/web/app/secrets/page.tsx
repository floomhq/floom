import { redirect } from "next/navigation";

// P2-9 (audit 2026-05-29): Secrets moved under the /connections namespace so
// all four Connections tabs (Connected / Browse / MCP / Secrets) share a
// consistent /connections/* route prefix. This stub preserves old links
// (command palette, bookmarks, /secrets?prefill=...) by forwarding to the new
// location with the query string intact.
export default async function LegacySecretsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value) && value[0]) qs.set(key, value[0]);
  }
  const query = qs.toString();
  redirect(`/connections/secrets${query ? `?${query}` : ""}`);
}
