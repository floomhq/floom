"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, ChevronDown, Copy, ExternalLink, Loader2, RefreshCw, Settings2, XCircle } from "lucide-react";
import { toast } from "sonner";

import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type { SlackSetupStatus } from "@/lib/types";

type SetupForm = {
  client_id: string;
  client_secret: string;
  signing_secret: string;
  events_enabled: boolean;
};

function readinessBadge(ok: boolean, label: string) {
  return (
    <Badge variant="outline" className={ok ? "emerald" : "amber"}>
      {ok ? <CheckCircle2 /> : <XCircle />}
      {label}
    </Badge>
  );
}

function shortDate(value?: string | null) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function SlackConnectionsPage() {
  const [status, setStatus] = useState<SlackSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [urlsOpen, setUrlsOpen] = useState(false);
  const [form, setForm] = useState<SetupForm>({
    client_id: "",
    client_secret: "",
    signing_secret: "",
    events_enabled: true,
  });

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.slack.setupStatus();
      setStatus(next);
      setForm((previous) => ({
        client_id: next.client_id_set ? "" : previous.client_id,
        client_secret: next.client_secret_set ? "" : previous.client_secret,
        signing_secret: next.signing_secret_set ? "" : previous.signing_secret,
        events_enabled: next.events_enabled,
      }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load Slack setup";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const credentialsReady = Boolean(status?.client_id_set && status?.client_secret_set);
  const signingReady = Boolean(status?.signing_secret_set);
  const workspaceReady = Boolean(status && status.installed_teams.length > 0);
  const visibleSetup = Boolean(status && (!credentialsReady || !signingReady));

  useEffect(() => {
    if (visibleSetup) setSetupOpen(true);
  }, [visibleSetup]);

  const workspaceSummary = useMemo(() => {
    if (!status || status.installed_teams.length === 0) return "No workspace connected";
    return status.installed_teams
      .map((team) => team.team_name || team.team_id)
      .join(", ");
  }, [status]);

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    toast.success("Copied");
  }

  async function saveConfig() {
    const payload: Record<string, string | boolean> = {
      events_enabled: form.events_enabled,
    };
    if (form.client_id.trim()) payload.client_id = form.client_id.trim();
    if (form.client_secret.trim()) payload.client_secret = form.client_secret.trim();
    if (form.signing_secret.trim()) payload.signing_secret = form.signing_secret.trim();

    setSaving(true);
    try {
      const result = await api.slack.updateSetupConfig(payload);
      setStatus(result.setup);
      setForm({
        client_id: "",
        client_secret: "",
        signing_secret: "",
        events_enabled: result.setup.events_enabled,
      });
      toast.success("Slack setup saved");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to save Slack setup");
    } finally {
      setSaving(false);
    }
  }

  async function connectSlack() {
    setConnecting(true);
    try {
      const result = await api.slack.installUrl("/connections/slack");
      window.location.href = result.install_url;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to start Slack install");
      setConnecting(false);
    }
  }

  function renderSetupFields(compact = false) {
    return (
      <div className={compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"}>
        {(compact || !status?.client_id_set) ? (
          <div className="grid gap-2">
            <Label htmlFor={compact ? "slack-client-id-advanced" : "slack-client-id"}>Client ID</Label>
            <Input
              id={compact ? "slack-client-id-advanced" : "slack-client-id"}
              autoComplete="off"
              placeholder={status?.client_id_set ? "Configured" : "Slack client ID"}
              value={form.client_id}
              onChange={(event) => setForm((prev) => ({ ...prev, client_id: event.target.value }))}
            />
          </div>
        ) : null}
        {(compact || !status?.client_secret_set) ? (
          <div className="grid gap-2">
            <Label htmlFor={compact ? "slack-client-secret-advanced" : "slack-client-secret"}>Client secret</Label>
            <Input
              id={compact ? "slack-client-secret-advanced" : "slack-client-secret"}
              type="password"
              autoComplete="off"
              placeholder={status?.client_secret_set ? "Configured" : "Slack client secret"}
              value={form.client_secret}
              onChange={(event) => setForm((prev) => ({ ...prev, client_secret: event.target.value }))}
            />
          </div>
        ) : null}
        {(compact || !status?.signing_secret_set) ? (
          <div className="grid gap-2">
            <Label htmlFor={compact ? "slack-signing-secret-advanced" : "slack-signing-secret"}>Signing secret</Label>
            <Input
              id={compact ? "slack-signing-secret-advanced" : "slack-signing-secret"}
              type="password"
              autoComplete="off"
              placeholder={status?.signing_secret_set ? "Configured" : "Slack signing secret"}
              value={form.signing_secret}
              onChange={(event) => setForm((prev) => ({ ...prev, signing_secret: event.target.value }))}
            />
          </div>
        ) : null}
        {compact ? (
          <div className="flex h-10 items-center justify-between rounded-md border border-line px-3">
            <Label htmlFor="slack-events-enabled-advanced" className="text-sm font-medium">
              Events
            </Label>
            <Switch
              id="slack-events-enabled-advanced"
              checked={form.events_enabled}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, events_enabled: checked }))}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">Connect a Slack workspace to Floom Workers.</p>
        </div>
        <Button data-testid="slack-refresh" variant="outline" size="sm" onClick={() => void loadStatus()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </header>
      <ConnectionsTabs />

      {loading && !status ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : loadError && !status ? (
        <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-12 text-center">
          <p className="text-sm font-medium text-ink">Could not load Slack setup</p>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">{loadError}</p>
          <Button className="mt-4" variant="outline" size="sm" onClick={() => void loadStatus()}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      ) : status ? (
        <>
          <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-medium text-ink">
                    {workspaceReady ? "Slack is connected" : status.configured ? "Ready to connect Slack" : "Finish Slack app setup"}
                  </h2>
                  {readinessBadge(credentialsReady, "App credentials")}
                  {readinessBadge(signingReady, "Signing secret")}
                </div>
                <p className="text-sm text-muted-foreground">{workspaceSummary}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {visibleSetup ? (
                  <Button onClick={() => void saveConfig()} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Save setup
                  </Button>
                ) : (
                  <Button onClick={() => void connectSlack()} disabled={!status.configured || connecting}>
                    {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                    {workspaceReady ? "Add workspace" : "Connect Slack"}
                  </Button>
                )}
              </div>
            </div>

            {visibleSetup ? (
              <div className="mt-4 border-t border-line pt-4">
                {renderSetupFields(false)}
              </div>
            ) : null}
          </section>

          <div className="space-y-2">
            {!visibleSetup ? (
              <Collapsible open={setupOpen} onOpenChange={setSetupOpen}>
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)]">
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
                    <span className="flex items-center gap-2 text-sm font-medium text-ink">
                      <Settings2 className="h-4 w-4 text-muted-foreground" />
                      Slack app setup
                    </span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform aria-expanded:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="space-y-4 border-t border-line px-4 py-4">
                      {renderSetupFields(true)}
                      <div className="flex justify-end">
                        <Button onClick={() => void saveConfig()} disabled={saving}>
                          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          Save setup
                        </Button>
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            ) : null}

            <Collapsible open={urlsOpen} onOpenChange={setUrlsOpen}>
              <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)]">
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    Slack dashboard URLs
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform aria-expanded:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="grid gap-3 border-t border-line px-4 py-4">
                    {[
                      ["OAuth callback", status.callback_url],
                      ["Events", status.events_url],
                      ["Slash command", status.command_url],
                      ["Interactivity", status.interactivity_url],
                    ].map(([label, value]) => (
                      <div key={label} className="grid gap-1">
                        <span className="text-xs font-medium uppercase text-muted-foreground">{label}</span>
                        <div className="flex min-w-0 items-center gap-2 rounded-md border border-line px-3 py-2">
                          <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
                          <Button variant="ghost" size="icon-sm" onClick={() => void copy(value)} title={`Copy ${label}`}>
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}

                    <div className="grid gap-1">
                      <span className="text-xs font-medium uppercase text-muted-foreground">Allowed teams</span>
                      <div className="flex flex-wrap gap-2">
                        {status.allowed_team_ids.length > 0 ? (
                          status.allowed_team_ids.map((team) => <Badge key={team} variant="outline">{team}</Badge>)
                        ) : (
                          <span className="text-sm text-muted-foreground">None</span>
                        )}
                      </div>
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-ink">Installed workspaces</h2>
            {status.installed_teams.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-6 text-sm text-muted-foreground">
                No Slack workspace is installed yet.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)]">
                {status.installed_teams.map((team) => (
                  <div key={team.team_id} className="grid gap-2 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{team.team_name || team.team_id}</span>
                        <Badge variant={team.status === "active" ? "default" : "outline"}>{team.status}</Badge>
                        {team.bot_token_set ? <Badge variant="outline">token set</Badge> : <Badge variant="outline">token missing</Badge>}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {team.team_id}
                        {team.bot_user_id ? ` · bot ${team.bot_user_id}` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">{shortDate(team.updated_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
