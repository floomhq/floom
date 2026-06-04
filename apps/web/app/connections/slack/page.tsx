import { redirect } from "next/navigation";

// Slack is NOT a worker connection — it is the human interface for Floom
// Worker OS (DM the assistant, @mention it, handle approvals in Slack).
// It belongs in Settings, not Connections. This stub preserves any OAuth
// callback or old link targeting /connections/slack by forwarding to
// /settings#slack with the query string intact (slack_connected / slack_error
// / team_id).
export default async function LegacySlackConnectionsRedirect({
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
  redirect(`/settings${query ? `?${query}` : ""}#slack`);
}
