"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { SlackSetupStatus } from "@/lib/types";

// Official Slack mark (4-colour) so the "Add to Slack" button matches Slack's
// brand guidelines without depending on an icon-set export.
function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 122.8 122.8" className={className} aria-hidden="true" focusable="false">
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  );
}

export function SlackConnect() {
  const [status, setStatus] = useState<SlackSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  // M17: track the team that was just connected so we can surface a prominent
  // "Open in Slack" CTA right after the OAuth round-trip lands the user back.
  const [justConnectedTeamId, setJustConnectedTeamId] = useState<string | null>(null);
  // #540: countdown to auto-redirect into Slack after a successful connect.
  const [slackRedirectCountdown, setSlackRedirectCountdown] = useState<number | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.slack.setupStatus());
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to load Slack status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // M17: detect the post-install redirect from the OAuth callback.
  // The backend appends ?slack_connected=1&team_id=<id> to the return_to URL.
  // We capture team_id so we can deep-link straight into that workspace,
  // then strip the query params so they don't persist on refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("slack_connected");
    const teamId = params.get("team_id");
    const slackError = params.get("slack_error");
    if (connected) {
      toast.success("Slack workspace connected");
      setJustConnectedTeamId(teamId || null);
      if (teamId) setSlackRedirectCountdown(3);
    } else if (slackError) {
      toast.error(`Slack connection failed: ${slackError}`);
    }
    if (connected || slackError) {
      params.delete("slack_connected");
      params.delete("slack_error");
      params.delete("team_id");
      const qs = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    }
  }, []);

  // #540: auto-redirect countdown — opens Slack when it hits zero.
  useEffect(() => {
    if (slackRedirectCountdown === null || !justConnectedTeamId) return;
    if (slackRedirectCountdown <= 0) {
      window.open(`https://app.slack.com/client/${justConnectedTeamId}`, "_blank", "noopener,noreferrer");
      setSlackRedirectCountdown(null);
      return;
    }
    const timer = setTimeout(() => setSlackRedirectCountdown((c) => (c !== null ? c - 1 : null)), 1000);
    return () => clearTimeout(timer);
  }, [slackRedirectCountdown, justConnectedTeamId]);

  const installedTeams = useMemo(() => status?.installed_teams ?? [], [status]);
  const connected = installedTeams.length > 0;
  const platformReady = Boolean(status?.configured);

  const workspaceSummary = useMemo(() => {
    if (installedTeams.length === 0) return null;
    return installedTeams.map((team) => team.team_name || team.team_id).join(", ");
  }, [installedTeams]);

  // M17: resolve the just-connected team from the status response so we have
  // the workspace name available for the CTA, not just the ID.
  const justConnectedTeam = useMemo(() => {
    if (!justConnectedTeamId) return null;
    return installedTeams.find((t) => t.team_id === justConnectedTeamId) ?? null;
  }, [justConnectedTeamId, installedTeams]);

  async function addToSlack() {
    setConnecting(true);
    try {
      const result = await api.slack.installUrl("/settings#slack");
      window.location.href = result.install_url;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to start Slack install");
      setConnecting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Connect to Slack</h2>
          {/* M41: Emily is a personal Chief-of-Staff, not a generic workspace bot. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            Your personal AI assistant — DM Emily or @mention her in a channel. She can run workers, surface approvals, and answer questions.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void loadStatus()}
          disabled={loading}
          title="Refresh Slack status"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
      </div>

      {loading && !status ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          {/* M17: prominent "Open in Slack" CTA shown immediately after the
              OAuth round-trip. Dismissed once the user navigates away or
              dismisses manually by clicking the link. */}
          {justConnectedTeam || (justConnectedTeamId && connected) ? (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-emerald-50 px-4 py-3 dark:bg-emerald-950/30">
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="min-w-0">
                  <span className="block text-sm font-medium text-emerald-800 dark:text-emerald-200 truncate">
                    {justConnectedTeam?.team_name
                      ? `${justConnectedTeam.team_name} connected`
                      : "Workspace connected"}
                  </span>
                  {slackRedirectCountdown !== null && (
                    <span className="text-xs text-emerald-700 dark:text-emerald-400">
                      Opening Slack in {slackRedirectCountdown}s…{" "}
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:opacity-80"
                        onClick={() => setSlackRedirectCountdown(null)}
                      >
                        Stay here
                      </button>
                    </span>
                  )}
                </div>
              </div>
              <a
                href={`https://app.slack.com/client/${justConnectedTeamId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => { setJustConnectedTeamId(null); setSlackRedirectCountdown(null); }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-btn)] bg-[#4A154B] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#3d1140]"
              >
                <SlackMark className="size-3.5" />
                Open{justConnectedTeam?.team_name ? ` ${justConnectedTeam.team_name}` : ""} in Slack
                <ExternalLink className="size-3" />
              </a>
            </div>
          ) : null}

          {/* M44: CTA first — visible without scrolling. Tutorial follows below. */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Official "Add to Slack" button styling (Slack Aubergine #4A154B). */}
            <button
              type="button"
              onClick={() => void addToSlack()}
              disabled={connecting}
              className="inline-flex h-11 items-center gap-2 rounded-[var(--radius-button)] [border:var(--bd-btn)] bg-[#4A154B] px-4 text-[15px] font-semibold text-white transition-colors hover:bg-[#3d1140] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60"
            >
              {connecting ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <SlackMark className="size-5" />
              )}
              {connected ? "Add another workspace" : "Add to Slack"}
            </button>

            {connected ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                Connected to {workspaceSummary}
              </span>
            ) : null}
          </div>

          {!platformReady && !connected ? (
            <p className="text-xs text-[var(--negative)]">
              Slack isn&apos;t fully configured on this workspace yet. The button may error until the
              platform Slack app is enabled.
            </p>
          ) : null}

          {/* M45: Step-by-step tutorial for non-technical users. */}
          <ol className="space-y-1.5 text-xs text-muted-foreground">
            <li>
              1. Click <span className="font-medium text-foreground">Add to Slack</span> and pick a
              workspace.
            </li>
            <li>2. Approve the requested permissions.</li>
            <li>
              3. <span className="font-medium text-foreground">DM Emily</span> or{" "}
              <span className="font-medium text-foreground">@mention her</span> in a channel — e.g.{" "}
              <span className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                show my pending approvals
              </span>
              .
            </li>
          </ol>

          {connected ? (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-[var(--radius-button)] [border:var(--bd-card)]">
                {installedTeams.map((team) => (
                  <div
                    key={team.team_id}
                    className="flex items-center justify-between gap-2 [border-bottom:var(--bd-div)] px-3 py-2 last:[border-bottom:0]"
                  >
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-foreground">
                        {team.team_name || team.team_id}
                      </span>
                      <p className="truncate text-[11px] text-muted-foreground">{team.team_id}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={team.status === "active" ? "default" : "outline"}>
                        {team.status}
                      </Badge>
                      <a
                        href={`https://app.slack.com/client/${team.team_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-btn)] bg-[#4A154B] px-2.5 text-xs font-medium text-white transition-colors hover:bg-[#3d1140]"
                      >
                        <SlackMark className="size-3.5" />
                        Open {team.team_name ?? "Slack"}
                      </a>
                    </div>
                  </div>
                ))}
              </div>
              {/* Primary CTA: get the user back into Slack where the work happens. */}
              {installedTeams[0] ? (
                <p className="text-xs text-muted-foreground">
                  You&apos;re connected — DM your assistant in Slack to get started.{" "}
                  <a
                    href={`https://app.slack.com/client/${installedTeams[0].team_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    Open {installedTeams[0].team_name ?? "Slack"} &rarr;
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
