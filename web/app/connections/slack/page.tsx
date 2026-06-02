"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Copy, ExternalLink, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";

import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function statusIcon(ok: boolean) {
  return ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-amber-600" />;
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
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [form, setForm] = useState<SetupForm>({
    client_id: "",
    client_secret: "",
    signing_secret: "",
    events_enabled: true,
  });

  const loadStatus = useCallback(async () => {
    setLoading(true);
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
      toast.error(error instanceof Error ? error.message : "Failed to load Slack setup");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const checklist = useMemo(() => {
    if (!status) return [];
    return [
      { label: "App credentials", ok: status.client_id_set && status.client_secret_set },
      { label: "Signing secret", ok: status.signing_secret_set },
      { label: "Events enabled", ok: status.events_enabled },
      { label: "Workspace installed", ok: status.installed_teams.length > 0 },
    ];
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

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal text-ink">Slack Agent</h1>
            <p className="mt-1 text-sm text-muted-foreground">Install Workeros into Slack and verify the workspace agent loop.</p>
          </div>
          <Button variant="outline" onClick={() => void loadStatus()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
        <ConnectionsTabs />
      </div>

      {loading && !status ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : status ? (
        <>
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" />
                  Setup
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {checklist.map((item) => (
                    <div key={item.label} className="flex h-11 items-center justify-between rounded-md border border-line px-3">
                      <span className="text-sm font-medium">{item.label}</span>
                      {statusIcon(item.ok)}
                    </div>
                  ))}
                </div>

                {status.missing.length > 0 ? (
                  <Alert>
                    <XCircle className="h-4 w-4" />
                    <AlertTitle>Configuration incomplete</AlertTitle>
                    <AlertDescription>{status.missing.join(", ")}</AlertDescription>
                  </Alert>
                ) : (
                  <Alert>
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertTitle>Ready</AlertTitle>
                    <AlertDescription>Slack install links can be generated.</AlertDescription>
                  </Alert>
                )}

                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="slack-client-id">Client ID</Label>
                    <Input
                      id="slack-client-id"
                      autoComplete="off"
                      placeholder={status.client_id_set ? "Configured" : "Slack client ID"}
                      value={form.client_id}
                      onChange={(event) => setForm((prev) => ({ ...prev, client_id: event.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="slack-client-secret">Client secret</Label>
                    <Input
                      id="slack-client-secret"
                      type="password"
                      autoComplete="off"
                      placeholder={status.client_secret_set ? "Configured" : "Slack client secret"}
                      value={form.client_secret}
                      onChange={(event) => setForm((prev) => ({ ...prev, client_secret: event.target.value }))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="slack-signing-secret">Signing secret</Label>
                    <Input
                      id="slack-signing-secret"
                      type="password"
                      autoComplete="off"
                      placeholder={status.signing_secret_set ? "Configured" : "Slack signing secret"}
                      value={form.signing_secret}
                      onChange={(event) => setForm((prev) => ({ ...prev, signing_secret: event.target.value }))}
                    />
                  </div>
                  <div className="flex h-11 items-center justify-between rounded-md border border-line px-3">
                    <Label htmlFor="slack-events-enabled" className="text-sm font-medium">Events</Label>
                    <Switch
                      id="slack-events-enabled"
                      checked={form.events_enabled}
                      onCheckedChange={(checked) => setForm((prev) => ({ ...prev, events_enabled: checked }))}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void saveConfig()} disabled={saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Save
                  </Button>
                  <Button onClick={() => void connectSlack()} disabled={!status.configured || connecting}>
                    {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                    Connect Slack
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ExternalLink className="h-4 w-4" />
                  URLs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
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
                      <Button variant="ghost" size="icon" onClick={() => void copy(value)}>
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}

                <div className="grid gap-1 pt-2">
                  <span className="text-xs font-medium uppercase text-muted-foreground">Allowed teams</span>
                  <div className="flex flex-wrap gap-2">
                    {status.allowed_team_ids.length > 0 ? (
                      status.allowed_team_ids.map((team) => <Badge key={team} variant="outline">{team}</Badge>)
                    ) : (
                      <span className="text-sm text-muted-foreground">None</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-ink">Installed workspaces</h2>
            {status.installed_teams.length === 0 ? (
              <div className="rounded-md border border-dashed border-line px-4 py-6 text-sm text-muted-foreground">
                No Slack workspace is installed yet.
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border border-line">
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
    </main>
  );
}
