import { redirect } from "next/navigation";

// Slack redesign Phase 1: the credential-paste UI and the Connections → Slack
// tab were removed. Slack app credentials are now platform env (not
// user-entered), and the assistant-Slack interface ("Add to Slack" +
// read-only installed-workspace status) lives on the Assistant page. This stub
// preserves old links and any OAuth callback that still targets
// /connections/slack by forwarding to /assistant with the query string intact
// (slack_connected / slack_error / team_id).
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
  redirect(`/assistant${query ? `?${query}` : ""}`);
}
