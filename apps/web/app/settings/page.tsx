"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { PlatformConfig, PersonalAccessToken, SystemInfo } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { settingsGroup, settingsCounts, groupLabel } from "@/lib/settings/nav-groups";
import { CliCommandPanel } from "@/components/CliCommandPanel";
import { GitWorkspacePanel } from "@/components/GitWorkspacePanel";
import { ThemeModeToggleGroup } from "@/components/ThemeModeToggleGroup";
import { SlackConnect } from "@/components/assistant/SlackConnect";
import { AlertTriangle, CheckCircle2, Copy, Mail, RotateCw, Trash2 } from "lucide-react";

export function PersonalAccessTokensPanel() {
  const [tokens, setTokens] = useState<PersonalAccessToken[] | null>(null);
  const [newTokenName, setNewTokenName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.tokens.list();
      setTokens(list);
    } catch {
      // /auth/tokens 404/401 means multi-member not active — hide silently
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (tokens === null) return null; // Not yet loaded or not available

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreatedToken(null);
    try {
      const result = await api.tokens.create(name);
      setCreatedToken(result.token);
      setNewTokenName("");
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string, name: string) {
    try {
      await api.tokens.revoke(id);
      toast.success(`Revoked "${name}"`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to revoke token");
    }
  }

  // #784: rotate — issue a new secret for the same token; old one stops working.
  async function handleRotate(id: string, name: string) {
    try {
      const result = await api.tokens.rotate(id);
      setCreatedToken(result.token);
      toast.success(`Rotated "${name}" — old token revoked`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to rotate token");
    }
  }

  async function copyToken(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Personal access tokens</h2>
      <p className="text-sm text-muted-foreground">
        Use tokens to authenticate API and MCP requests without a shared secret.
        Token values are shown once — store them securely.
      </p>

      {createdToken && (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertTitle>Token created</AlertTitle>
          <AlertDescription>
            <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-xs">
              <span className="flex-1 break-all">{createdToken}</span>
              <button
                type="button"
                onClick={() => void copyToken(createdToken)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              This value won&apos;t be shown again.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleCreate} className="flex gap-2">
        <Input
          placeholder="Token name (e.g. ci-pipeline)"
          value={newTokenName}
          onChange={(e) => setNewTokenName(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" size="sm" disabled={!newTokenName.trim() || creating}>
          {creating ? "Creating…" : "Create token"}
        </Button>
      </form>

      {tokens.length > 0 ? (
        <div className="space-y-1">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <span className="font-medium">{t.name}</span>
                {t.last_used_at && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    last used {new Date(t.last_used_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleRotate(t.id, t.name)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Rotate ${t.name}`}
                title="Rotate — issue a new secret, revoke the old one"
              >
                <RotateCw className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void handleRevoke(t.id, t.name)}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Revoke ${t.name}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No tokens yet.</p>
      )}
    </section>
  );
}

// S22f: Notifications tab is currently hidden. The TabKey type still includes
// it (plus the now-removed "assistant") so old URLs (?tab=assistant /
// #assistant) don't blow up; we silently fall back to "developer" for any tab
// not in VISIBLE_TAB_KEYS.
// Phase 2 (Slack→Settings): Slack is the human interface for Floom Worker OS
// (DM the assistant, @mention, approvals) — NOT a worker OAuth connection. It
// belongs in Settings, not Connections.
// S-dev: renamed "API access" tab to "Developer" (value "api" → "developer").
// The old ?tab=api / #api URLs are handled by the legacy fallback below.
// SPEC §12: "Channels" (Slack · WhatsApp · Agent-install) is a Settings tab —
// set-once, low-frequency config lives here (nav placement follows frequency).
// The old "slack" tab folds into Channels; #slack deep-links still resolve.
type TabKey =
  | "developer"
  | "system"
  | "git"
  | "channels"
  | "slack"
  | "assistant"
  | "notifications"
  | "appearance"
  | "danger";

const VISIBLE_TAB_KEYS: TabKey[] = ["developer", "system", "git", "channels", "appearance", "danger"];
const TAB_KEYS: TabKey[] = [
  "developer",
  "system",
  "git",
  "channels",
  "slack",
  "assistant",
  "notifications",
  "appearance",
  "danger",
];

// V4 §4: the tab strip renders TWO labeled groups (Workspace · / Account ·)
// from lib/settings/nav-groups — single source for keys, labels, scopes.

function isValidTab(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.includes(value as TabKey);
}

function visibleTabFromCandidate(value: string | null): TabKey | null {
  // Legacy aliases: #api → developer, #slack → channels.
  const candidate = value === "api" ? "developer" : value === "slack" ? "channels" : value;
  return isValidTab(candidate) && VISIBLE_TAB_KEYS.includes(candidate)
    ? candidate
    : null;
}

export default function SettingsPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="p-6 text-sm text-muted-foreground">Loading settings...</div>;
  }
  return <SettingsContent />;
}

function SettingsContent() {
  const [search, setSearch] = useState(() =>
    typeof window !== "undefined" ? window.location.search : ""
  );
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  // S28: tabs use URL hash now (#api, #danger, etc.). Fall back to legacy
  // ?tab= for old links.
  // S30: own the hash via the History API instead of router.replace. The App
  // Router treated a same-pathname `#hash` navigation as an append (clicking
  // System then Appearance produced `/settings#system#appearance`), so the tab
  // could only switch once per load. We are the single source of truth for the
  // hash now: state drives history.replaceState, and a hashchange listener
  // keeps deep-links + back/forward in sync.
  const initialTab = (() => {
    const fromHash =
      typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : null;
    const fromQuery = searchParams.get("tab");
    return visibleTabFromCandidate(fromHash || fromQuery) ?? "developer";
  })();
  const [tab, setTab] = useState<TabKey>(initialTab);

  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [reloading, setReloading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [claimedWhatsAppToken, setClaimedWhatsAppToken] = useState<string | null>(null);
  const [waClaimBanner, setWaClaimBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [claimedSlackToken, setClaimedSlackToken] = useState<string | null>(null);
  const [slackClaimBanner, setSlackClaimBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [fromInstallChannel, setFromInstallChannel] = useState<string | null>(null);
  // SPEC §6: the Danger zone is admin-only. Default to shown so single-tenant
  // (no role) and admins never lose it; hide once we learn the viewer is a member.
  const [isAdmin, setIsAdmin] = useState(true);
  useEffect(() => {
    api
      .me()
      .then((u) => {
        const who = u as { role?: string; is_admin?: boolean };
        setIsAdmin(who.is_admin ?? (who.role == null ? true : who.role === "admin" || who.role === "owner"));
      })
      .catch(() => {});
  }, []);
  // PR S19 (I-44): type-to-confirm text for the Clear runs button.
  const [clearConfirmText, setClearConfirmText] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [infoRes, platformRes] = await Promise.all([
        api.system.info(),
        api.system.platformConfig(),
      ]);
      setInfo(infoRes);
      setPlatformConfig(platformRes);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const token = (searchParams.get("whatsapp_claim") || "").trim();
    if (!token || token === claimedWhatsAppToken) return;
    setClaimedWhatsAppToken(token);
    void (async () => {
      try {
        await api.whatsapp.claim(token);
        toast.success("WhatsApp number linked to this workspace");
        setWaClaimBanner({ ok: true, message: "WhatsApp number linked to this workspace." });
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : "";
        const friendly =
          raw === "WhatsApp claim not found"
            ? "This link was not found or the number is already linked."
            : raw === "WhatsApp claim expired"
              ? "This link has expired. Text the WorkerOS number again to get a new one."
              : raw || "Failed to link WhatsApp.";
        toast.error(friendly);
        setWaClaimBanner({ ok: false, message: friendly });
      } finally {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("whatsapp_claim");
        const qs = params.size ? `?${params.toString()}` : "";
        const hash = typeof window !== "undefined" ? window.location.hash : "";
        const path = typeof window !== "undefined" ? window.location.pathname : "/settings";
        window.history.replaceState(null, "", `${path}${qs}${hash}`);
        setSearch(window.location.search);
      }
    })();
  }, [claimedWhatsAppToken, searchParams]);

  useEffect(() => {
    const token = (searchParams.get("slack_claim") || "").trim();
    if (!token || token === claimedSlackToken) return;
    setClaimedSlackToken(token);
    void (async () => {
      try {
        await api.slack.claim(token);
        toast.success("Slack identity linked to this workspace");
        setSlackClaimBanner({ ok: true, message: "Slack identity linked to this workspace." });
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : "";
        const friendly =
          raw === "Slack claim not found"
            ? "This link was not found or the identity is already linked."
            : raw === "Slack claim expired"
              ? "This link has expired. Send Emily a DM in Slack to get a new one."
              : raw || "Failed to link Slack identity.";
        toast.error(friendly);
        setSlackClaimBanner({ ok: false, message: friendly });
      } finally {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("slack_claim");
        const qs = params.size ? `?${params.toString()}` : "";
        const hash = typeof window !== "undefined" ? window.location.hash : "";
        const path = typeof window !== "undefined" ? window.location.pathname : "/settings";
        window.history.replaceState(null, "", `${path}${qs}${hash}`);
        setSearch(window.location.search);
      }
    })();
  }, [claimedSlackToken, searchParams]);

  // #552: consume ?from_install=<channel> placed by the login page after an
  // install-param sign-in, route to the relevant tab, show a banner.
  useEffect(() => {
    const channel = searchParams.get("from_install");
    if (!channel) return;
    setFromInstallChannel(channel);
    const tabMap: Record<string, TabKey> = { slack: "slack", cli: "developer" };
    const dest = tabMap[channel];
    if (dest && VISIBLE_TAB_KEYS.includes(dest)) setTab(dest);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("from_install");
    const qs = params.size ? `?${params.toString()}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${qs}${window.location.hash}`);
    setSearch(window.location.search);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep state in sync with the URL hash for deep-links and back/forward.
  useEffect(() => {
    function syncFromHash() {
      const raw = window.location.hash.replace(/^#/, "");
      const fromHash = visibleTabFromCandidate(raw);
      if (fromHash) {
        setTab((prev) => (prev === fromHash ? prev : fromHash));
      }
    }
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  function handleTabChange(value: string) {
    if (!isValidTab(value)) return;
    setTab(value);
    // S30: set the hash to exactly the clicked tab via the History API so it
    // REPLACES rather than appends. Drop the legacy ?tab= param if present.
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    const qs = params.size ? `?${params.toString()}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${qs}#${value}`);
    setSearch(window.location.search);
  }

  async function handleReload() {
    setReloading(true);
    try {
      const res = await api.workers.reload();
      toast.success(`Loaded ${res.workers_loaded} workers`);
      void loadData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to reload");
    } finally {
      setReloading(false);
    }
  }

  async function handleClearRuns() {
    if (clearConfirmText.trim() !== "DELETE ALL RUNS") return;
    setClearing(true);
    try {
      await api.system.clearRuns();
      toast.success("Run history cleared");
      setClearConfirmText("");
      void loadData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to clear runs");
    } finally {
      setClearing(false);
    }
  }

  async function copySecretName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      toast.success(`Copied ${name}`);
    } catch {
      toast.error("Could not copy name");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          System configuration and access. {settingsCounts()}.
        </p>
      </div>

      {waClaimBanner && (
        <Alert variant={waClaimBanner.ok ? "default" : "destructive"}>
          {waClaimBanner.ok ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
          <AlertTitle>{waClaimBanner.ok ? "WhatsApp linked" : "WhatsApp link failed"}</AlertTitle>
          <AlertDescription>{waClaimBanner.message}</AlertDescription>
        </Alert>
      )}

      {fromInstallChannel && (
        <Alert>
          <AlertTitle>
            {fromInstallChannel === "slack" ? "Connect Slack to continue" :
             fromInstallChannel === "cli" ? "Get your CLI access token below" :
             `Complete your ${fromInstallChannel} setup`}
          </AlertTitle>
          <AlertDescription>
            {fromInstallChannel === "slack"
              ? "You were sent here from Slack. Add your workspace below to start using the assistant."
              : "Complete the setup for your channel integration."}
            {" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:opacity-80"
              onClick={() => setFromInstallChannel(null)}
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* V4: top-bar tab strip, consistent with the rest of the app (e.g. the
          worker-detail page). Reverted from the prior left vertical nav.
          MOBILE-375: the tab bar is `inline-flex w-fit whitespace-nowrap` and
          cannot shrink below its content width, so we wrap it in a full-width
          horizontal scroll container — overflow stays inside the strip and never
          drives page width. Mirrors the worker-detail page exactly.
          S22f: Notifications stays hidden until outbound email ships. */}
      <Tabs value={tab} onValueChange={handleTabChange}>
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0">
          {/* V4 §4: two labeled groups — Workspace · {name} and Account · {user}. */}
          <div className="flex items-center gap-3">
            {(["workspace", "account"] as const).map((scope) => (
              <div key={scope} className="flex items-center gap-2">
                <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {groupLabel(scope)}
                </span>
                <TabsList>
                  {settingsGroup(scope)
                    .filter((item) => !item.adminOnly || isAdmin)
                    .map((item) => (
                      <TabsTrigger key={item.key} value={item.key}>
                        {item.label}
                      </TabsTrigger>
                    ))}
                </TabsList>
              </div>
            ))}
          </div>
        </div>

        <TabsContent value="developer" className="space-y-8 pt-6">
          <CliCommandPanel />
          <PersonalAccessTokensPanel />
        </TabsContent>

        <TabsContent value="system" className="space-y-8 pt-6">
          {/* S29s: dropped Card wrappers. Match sister tabs (Developer,
              Appearance) which also flat-section now. */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">System info</h2>
            <div className="space-y-3 text-sm">
              {info ? (
                <>
                  <Row label="Version" value={info.version} mono />
                  <Row label="Started at" value={info.started_at} mono />
                  <Row label="Python" value={info.python_version} mono />
                  <Row label="Runner" value={info.runner} />
                </>
              ) : (
                <div className="space-y-3">
                  {[120, 96, 80].map((w, i) => (
                    <div key={i} className="flex justify-between items-center">
                      <Skeleton className="h-4" style={{ width: 80 }} />
                      <Skeleton className="h-4" style={{ width: w }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Behaviour</h2>
            <BehaviourSettings />
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Model defaults &amp; limits</h2>
            <ModelDefaults />
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Platform configuration</h2>
            <div className="space-y-3">
              {!platformConfig ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-[var(--radius-card)] bg-muted p-3">
                    <span className="text-sm">Configured</span>
                    <span className="text-sm font-medium">
                      {platformConfig.set_count}/{platformConfig.required_count}
                    </span>
                  </div>
                  {platformConfig.all_required_set ? (
                    <Alert>
                      <CheckCircle2 className="size-4" />
                      <AlertTitle>All required secrets are set</AlertTitle>
                      <AlertDescription>
                        Workers can run with full platform configuration.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert variant="destructive">
                      <AlertTriangle className="size-4" />
                      <AlertTitle>
                        {platformConfig.missing.length} required{" "}
                        {platformConfig.missing.length === 1 ? "secret" : "secrets"} missing
                      </AlertTitle>
                      <AlertDescription>
                        <div className="mt-2 space-y-1.5">
                          {platformConfig.missing.map((name) => (
                            <div
                              key={name}
                              className="flex items-center justify-between gap-2"
                            >
                              <code className="text-xs">{name}</code>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void copySecretName(name)}
                              >
                                Copy name
                              </Button>
                            </div>
                          ))}
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="channels" className="space-y-8 pt-6">
          <ChannelsTab />
        </TabsContent>

        <TabsContent value="git" className="pt-6">
          <GitWorkspacePanel />
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4 pt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Email notifications</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <ToggleRow
                title="Email on run failure"
                description="Send an email when a worker run ends in error."
                disabled
              />
              <ToggleRow
                title="Email on connection expiry"
                description="Warn when a connected account is about to lose access."
                disabled
              />
              <p className="text-xs text-muted-foreground">
                Email delivery is not wired up yet. Toggles will activate once
                outbound email is configured.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appearance" className="space-y-3 pt-6">
          {/* S29z: explicit three-button toggle (System / Light / Dark)
              instead of a single cycling button. Sidebar keeps the
              compact cycle button; here we show all three at once. */}
          <h2 className="text-sm font-medium text-muted-foreground">Theme</h2>
          <p className="text-sm text-muted-foreground">
            Choose how WorkerOS looks. System follows your operating system.
          </p>
          <ThemeModeToggleGroup />
        </TabsContent>

        <TabsContent value="danger" className="space-y-4 pt-6">
          {isAdmin && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-destructive">Danger zone</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">Clear run history</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Deletes all runs, logs, artifacts, and approvals. Cannot be undone.
                  </p>
                </div>
                {/* PR S19 (I-44): type-to-confirm, same pattern as delete-worker.
                    Previous version was a single-click after a tap → click chain
                    which is too easy to fat-finger. */}
                <Label htmlFor="clear-runs-confirm" className="text-xs text-muted-foreground">
                  Type <code className="text-foreground">DELETE ALL RUNS</code> to confirm.
                </Label>
                <Input
                  id="clear-runs-confirm"
                  value={clearConfirmText}
                  onChange={(e) => setClearConfirmText(e.target.value)}
                  placeholder="DELETE ALL RUNS"
                  className="max-w-sm"
                />
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  onClick={handleClearRuns}
                  disabled={clearing || clearConfirmText.trim() !== "DELETE ALL RUNS"}
                >
                  {clearing ? "Clearing..." : "Delete all runs"}
                </Button>
              </div>
            </CardContent>
          </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  disabled,
  checked,
  onCheckedChange,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  checked?: boolean;
  onCheckedChange?: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch disabled={disabled} checked={checked} onCheckedChange={onCheckedChange} />
      {disabled ? (
        <Badge variant="outline" className="text-xs">
          Soon
        </Badge>
      ) : null}
    </div>
  );
}

// #794: workspace behaviour toggles, backed by the workspace-settings KV
// (admin-only writes — the server enforces #804). Members see them read-only.
const BEHAVIOUR_TOGGLES: { key: string; title: string; description: string }[] = [
  {
    key: "approval_default",
    title: "Require approval by default",
    description: "New workers pause for review before taking external actions.",
  },
  {
    key: "auto_pause",
    title: "Auto-pause on repeated failures",
    description: "Pause a worker automatically after consecutive failed runs.",
  },
  {
    key: "failure_emails",
    title: "Email me on run failures",
    description: "Send a notification when a run ends in error.",
  },
];

export function BehaviourSettings() {
  const [values, setValues] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    api.workspace
      .getSettings()
      .then(setValues)
      .catch(() => setValues({}));
  }, []);

  const toggle = (key: string, next: boolean) => {
    setValues((prev) => ({ ...(prev ?? {}), [key]: next ? "true" : "false" }));
    api.workspace.setSetting(key, next ? "true" : "false").catch((err) => {
      toast.error((err as Error).message || "Could not save setting");
      // Re-sync from the server on failure.
      api.workspace.getSettings().then(setValues).catch(() => {});
    });
  };

  if (values === null) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="space-y-4">
      {BEHAVIOUR_TOGGLES.map((t) => (
        <ToggleRow
          key={t.key}
          title={t.title}
          description={t.description}
          checked={values[t.key] === "true"}
          onCheckedChange={(v) => toggle(t.key, v)}
        />
      ))}
    </div>
  );
}

// #797: workspace model defaults & limits, persisted to the same workspace
// settings KV. Free-text/number inputs save on blur (admin-only writes; the
// server enforces #804).
const MODEL_DEFAULT_FIELDS: {
  key: string;
  label: string;
  placeholder: string;
  type: "text" | "number";
  hint: string;
}[] = [
  { key: "default_model", label: "Default model", placeholder: "e.g. claude-opus-4-8", type: "text", hint: "Used by new workers that don't pin a model." },
  { key: "max_output_tokens", label: "Max output tokens", placeholder: "e.g. 4096", type: "number", hint: "Per-run output ceiling." },
  { key: "spend_cap_usd", label: "Monthly spend cap (USD)", placeholder: "e.g. 100", type: "number", hint: "Soft cap for run costs this month." },
];

export function ModelDefaults() {
  const [values, setValues] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    api.workspace.getSettings().then(setValues).catch(() => setValues({}));
  }, []);

  const save = (key: string, value: string) => {
    api.workspace.setSetting(key, value).catch((err) => {
      toast.error((err as Error).message || "Could not save setting");
    });
  };

  if (values === null) return <Skeleton className="h-28 w-full" />;
  return (
    <div className="space-y-4">
      {MODEL_DEFAULT_FIELDS.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={`md-${f.key}`} className="text-sm">{f.label}</Label>
          <Input
            id={`md-${f.key}`}
            type={f.type}
            defaultValue={values[f.key] ?? ""}
            placeholder={f.placeholder}
            className="max-w-xs"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (values[f.key] ?? "")) {
                setValues((prev) => ({ ...(prev ?? {}), [f.key]: v }));
                save(f.key, v);
              }
            }}
          />
          <p className="text-xs text-muted-foreground">{f.hint}</p>
        </div>
      ))}
    </div>
  );
}

// SPEC §12: Channels — how you reach Emily/workers (inbound), set once.
// Slack (live), WhatsApp (coming), and "install in your agent" over MCP/CLI.
// ---------------------------------------------------------------------------
// WhatsApp QR — static inline SVG generated from the fixed wa.me deep-link.
// No external service, no npm dep. The QR data was generated offline with
// qrcode (Python) for https://wa.me/16503999709 at error-correction M.
// To regenerate: python3 -c "import qrcode; ..." (see git history for script).
// ---------------------------------------------------------------------------
const WA_BOT_NUMBER = "16503999709";
const WA_LINK = `https://wa.me/${WA_BOT_NUMBER}`;

// Pre-computed QR path for WA_LINK (29×29 modules, 2-module border).
const WA_QR_PATH =
  "M2,2h1v1h-1z M3,2h1v1h-1z M4,2h1v1h-1z M5,2h1v1h-1z M6,2h1v1h-1z M7,2h1v1h-1z M8,2h1v1h-1z M15,2h1v1h-1z M18,2h1v1h-1z M20,2h1v1h-1z M21,2h1v1h-1z M22,2h1v1h-1z M23,2h1v1h-1z M24,2h1v1h-1z M25,2h1v1h-1z M26,2h1v1h-1z M2,3h1v1h-1z M8,3h1v1h-1z M10,3h1v1h-1z M11,3h1v1h-1z M12,3h1v1h-1z M13,3h1v1h-1z M18,3h1v1h-1z M20,3h1v1h-1z M26,3h1v1h-1z M2,4h1v1h-1z M4,4h1v1h-1z M5,4h1v1h-1z M6,4h1v1h-1z M8,4h1v1h-1z M10,4h1v1h-1z M12,4h1v1h-1z M13,4h1v1h-1z M17,4h1v1h-1z M18,4h1v1h-1z M20,4h1v1h-1z M22,4h1v1h-1z M23,4h1v1h-1z M24,4h1v1h-1z M26,4h1v1h-1z M2,5h1v1h-1z M4,5h1v1h-1z M5,5h1v1h-1z M6,5h1v1h-1z M8,5h1v1h-1z M10,5h1v1h-1z M12,5h1v1h-1z M15,5h1v1h-1z M16,5h1v1h-1z M20,5h1v1h-1z M22,5h1v1h-1z M23,5h1v1h-1z M24,5h1v1h-1z M26,5h1v1h-1z M2,6h1v1h-1z M4,6h1v1h-1z M5,6h1v1h-1z M6,6h1v1h-1z M8,6h1v1h-1z M11,6h1v1h-1z M12,6h1v1h-1z M16,6h1v1h-1z M20,6h1v1h-1z M22,6h1v1h-1z M23,6h1v1h-1z M24,6h1v1h-1z M26,6h1v1h-1z M2,7h1v1h-1z M8,7h1v1h-1z M11,7h1v1h-1z M12,7h1v1h-1z M15,7h1v1h-1z M20,7h1v1h-1z M26,7h1v1h-1z M2,8h1v1h-1z M3,8h1v1h-1z M4,8h1v1h-1z M5,8h1v1h-1z M6,8h1v1h-1z M7,8h1v1h-1z M8,8h1v1h-1z M10,8h1v1h-1z M12,8h1v1h-1z M14,8h1v1h-1z M16,8h1v1h-1z M18,8h1v1h-1z M20,8h1v1h-1z M21,8h1v1h-1z M22,8h1v1h-1z M23,8h1v1h-1z M24,8h1v1h-1z M25,8h1v1h-1z M26,8h1v1h-1z M10,9h1v1h-1z M12,9h1v1h-1z M13,9h1v1h-1z M14,9h1v1h-1z M16,9h1v1h-1z M17,9h1v1h-1z M18,9h1v1h-1z M2,10h1v1h-1z M8,10h1v1h-1z M10,10h1v1h-1z M11,10h1v1h-1z M14,10h1v1h-1z M15,10h1v1h-1z M17,10h1v1h-1z M18,10h1v1h-1z M19,10h1v1h-1z M20,10h1v1h-1z M23,10h1v1h-1z M24,10h1v1h-1z M25,10h1v1h-1z M2,11h1v1h-1z M4,11h1v1h-1z M6,11h1v1h-1z M7,11h1v1h-1z M10,11h1v1h-1z M13,11h1v1h-1z M14,11h1v1h-1z M15,11h1v1h-1z M17,11h1v1h-1z M18,11h1v1h-1z M21,11h1v1h-1z M22,11h1v1h-1z M23,11h1v1h-1z M24,11h1v1h-1z M25,11h1v1h-1z M2,12h1v1h-1z M4,12h1v1h-1z M5,12h1v1h-1z M7,12h1v1h-1z M8,12h1v1h-1z M9,12h1v1h-1z M10,12h1v1h-1z M12,12h1v1h-1z M13,12h1v1h-1z M14,12h1v1h-1z M17,12h1v1h-1z M18,12h1v1h-1z M20,12h1v1h-1z M21,12h1v1h-1z M22,12h1v1h-1z M23,12h1v1h-1z M25,12h1v1h-1z M26,12h1v1h-1z M2,13h1v1h-1z M5,13h1v1h-1z M6,13h1v1h-1z M10,13h1v1h-1z M13,13h1v1h-1z M16,13h1v1h-1z M19,13h1v1h-1z M20,13h1v1h-1z M21,13h1v1h-1z M23,13h1v1h-1z M26,13h1v1h-1z M6,14h1v1h-1z M7,14h1v1h-1z M8,14h1v1h-1z M9,14h1v1h-1z M12,14h1v1h-1z M14,14h1v1h-1z M16,14h1v1h-1z M17,14h1v1h-1z M19,14h1v1h-1z M20,14h1v1h-1z M26,14h1v1h-1z M2,15h1v1h-1z M6,15h1v1h-1z M7,15h1v1h-1z M9,15h1v1h-1z M11,15h1v1h-1z M15,15h1v1h-1z M16,15h1v1h-1z M17,15h1v1h-1z M21,15h1v1h-1z M25,15h1v1h-1z M2,16h1v1h-1z M4,16h1v1h-1z M8,16h1v1h-1z M9,16h1v1h-1z M13,16h1v1h-1z M14,16h1v1h-1z M17,16h1v1h-1z M18,16h1v1h-1z M19,16h1v1h-1z M21,16h1v1h-1z M22,16h1v1h-1z M23,16h1v1h-1z M25,16h1v1h-1z M26,16h1v1h-1z M2,17h1v1h-1z M4,17h1v1h-1z M6,17h1v1h-1z M9,17h1v1h-1z M12,17h1v1h-1z M13,17h1v1h-1z M17,17h1v1h-1z M21,17h1v1h-1z M23,17h1v1h-1z M24,17h1v1h-1z M26,17h1v1h-1z M2,18h1v1h-1z M5,18h1v1h-1z M8,18h1v1h-1z M11,18h1v1h-1z M12,18h1v1h-1z M13,18h1v1h-1z M14,18h1v1h-1z M15,18h1v1h-1z M18,18h1v1h-1z M19,18h1v1h-1z M20,18h1v1h-1z M21,18h1v1h-1z M22,18h1v1h-1z M24,18h1v1h-1z M10,19h1v1h-1z M12,19h1v1h-1z M14,19h1v1h-1z M15,19h1v1h-1z M16,19h1v1h-1z M18,19h1v1h-1z M22,19h1v1h-1z M2,20h1v1h-1z M3,20h1v1h-1z M4,20h1v1h-1z M5,20h1v1h-1z M6,20h1v1h-1z M7,20h1v1h-1z M8,20h1v1h-1z M11,20h1v1h-1z M13,20h1v1h-1z M15,20h1v1h-1z M16,20h1v1h-1z M18,20h1v1h-1z M20,20h1v1h-1z M22,20h1v1h-1z M26,20h1v1h-1z M2,21h1v1h-1z M8,21h1v1h-1z M14,21h1v1h-1z M16,21h1v1h-1z M18,21h1v1h-1z M22,21h1v1h-1z M25,21h1v1h-1z M26,21h1v1h-1z M2,22h1v1h-1z M4,22h1v1h-1z M5,22h1v1h-1z M6,22h1v1h-1z M8,22h1v1h-1z M11,22h1v1h-1z M12,22h1v1h-1z M13,22h1v1h-1z M15,22h1v1h-1z M17,22h1v1h-1z M18,22h1v1h-1z M19,22h1v1h-1z M20,22h1v1h-1z M21,22h1v1h-1z M22,22h1v1h-1z M24,22h1v1h-1z M2,23h1v1h-1z M4,23h1v1h-1z M5,23h1v1h-1z M6,23h1v1h-1z M8,23h1v1h-1z M13,23h1v1h-1z M14,23h1v1h-1z M17,23h1v1h-1z M18,23h1v1h-1z M19,23h1v1h-1z M20,23h1v1h-1z M25,23h1v1h-1z M26,23h1v1h-1z M2,24h1v1h-1z M4,24h1v1h-1z M5,24h1v1h-1z M6,24h1v1h-1z M8,24h1v1h-1z M14,24h1v1h-1z M15,24h1v1h-1z M16,24h1v1h-1z M23,24h1v1h-1z M24,24h1v1h-1z M26,24h1v1h-1z M2,25h1v1h-1z M8,25h1v1h-1z M11,25h1v1h-1z M12,25h1v1h-1z M14,25h1v1h-1z M16,25h1v1h-1z M18,25h1v1h-1z M19,25h1v1h-1z M21,25h1v1h-1z M22,25h1v1h-1z M26,25h1v1h-1z M2,26h1v1h-1z M3,26h1v1h-1z M4,26h1v1h-1z M5,26h1v1h-1z M6,26h1v1h-1z M7,26h1v1h-1z M8,26h1v1h-1z M10,26h1v1h-1z M11,26h1v1h-1z M13,26h1v1h-1z M16,26h1v1h-1z M18,26h1v1h-1z M20,26h1v1h-1z M23,26h1v1h-1z M26,26h1v1h-1z";

function WhatsAppQR() {
  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 29 29"
        width={120}
        height={120}
        shapeRendering="crispEdges"
        aria-label="WhatsApp QR code"
        role="img"
        className="rounded-md border border-[var(--border-default)]"
      >
        <rect width="29" height="29" fill="white" />
        <path fill="black" d={WA_QR_PATH} />
      </svg>
      <a
        href={WA_LINK}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        +1 650-399-9709
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlackBindingStatus — per-user DM identity status + unlink
// ---------------------------------------------------------------------------
function SlackBindingStatus() {
  const [binding, setBinding] = useState<import("@/lib/types").SlackBindingMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    try {
      setBinding(await api.slack.bindingMe());
    } catch {
      // endpoint may not exist on older engines — fail silently
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleUnlink() {
    if (!confirm("Unlink your Slack identity from this account?")) return;
    setUnlinking(true);
    try {
      await api.slack.unlink();
      toast.success("Slack identity unlinked");
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to unlink Slack");
    } finally {
      setUnlinking(false);
    }
  }

  if (loading) return <Skeleton className="h-8 w-48" />;
  if (!binding) return null;
  if (!binding.linked) {
    return (
      <p className="text-xs text-muted-foreground">
        DM Emily in Slack to link your identity.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground truncate">
          {binding.profile_name
            ? `${binding.profile_name} (${binding.slack_user_id})`
            : binding.slack_user_id}
        </p>
        <p className="text-[11px] text-muted-foreground">Team {binding.slack_team_id}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => void handleUnlink()}
        disabled={unlinking}
      >
        {unlinking ? "Unlinking..." : "Unlink"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhatsAppBindingStatus — per-user binding status + unlink
// ---------------------------------------------------------------------------
function WhatsAppBindingStatus() {
  const [binding, setBinding] = useState<import("@/lib/types").WhatsAppBindingMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    try {
      setBinding(await api.whatsapp.bindingMe());
    } catch {
      // endpoint may not exist on older engines — fail silently
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleUnlink() {
    if (!confirm("Unlink your WhatsApp number from this account?")) return;
    setUnlinking(true);
    try {
      await api.whatsapp.unlink();
      toast.success("WhatsApp number unlinked");
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to unlink WhatsApp");
    } finally {
      setUnlinking(false);
    }
  }

  if (loading) return <Skeleton className="h-8 w-48" />;
  if (!binding) return null;
  if (!binding.linked) {
    return (
      <p className="text-xs text-muted-foreground">
        Scan the QR or text the number above, then tap the link Emily sends you.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground truncate">
          {binding.profile_name
            ? `${binding.profile_name} (${binding.wa_id_masked})`
            : binding.wa_id_masked}
        </p>
        <p className="text-[11px] text-muted-foreground">Linked to this account</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => void handleUnlink()}
        disabled={unlinking}
      >
        {unlinking ? "Unlinking..." : "Unlink"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChannelsTab — Slack + WhatsApp + Email + Agent install
// ---------------------------------------------------------------------------
export function ChannelsTab() {
  return (
    <>
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">Messaging</h2>
          <p className="text-xs text-muted-foreground">
            Where workers reach you and where Emily can be reached.
          </p>
        </div>

        {/* Slack card */}
        <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-card p-4">
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 256 256" className="size-5 shrink-0" aria-hidden="true" focusable="false">
              <path fill="#E01E5A" d="M53.8,161.3c0,14.8-12,26.8-26.8,26.8S0,176.2,0,161.3s12-26.8,26.8-26.8h26.8V161.3z M67.3,161.3 c0-14.8,12-26.8,26.8-26.8s26.8,12,26.8,26.8v67.1c0,14.8-12,26.8-26.8,26.8s-26.8-12-26.8-26.8V161.3z" />
              <path fill="#36C5F0" d="M94.1,53.6c-14.8,0-26.8-12-26.8-26.8S79.3,0,94.1,0s26.8,12,26.8,26.8v26.8H94.1z M94.1,67.3 c14.8,0,26.8,12,26.8,26.8s-12,26.8-26.8,26.8H26.8C12,120.9,0,108.9,0,94.1s12-26.8,26.8-26.8H94.1z" />
              <path fill="#2EB67D" d="M201.5,94.1c0-14.8,12-26.8,26.8-26.8s26.8,12,26.8,26.8s-12,26.8-26.8,26.8h-26.8V94.1z M188.1,94.1 c0,14.8-12,26.8-26.8,26.8s-26.8-12-26.8-26.8V26.8C134.4,12,146.4,0,161.3,0s26.8,12,26.8,26.8V94.1z" />
              <path fill="#ECB22E" d="M161.3,201.5c14.8,0,26.8,12,26.8,26.8s-12,26.8-26.8,26.8s-26.8-12-26.8-26.8v-26.8H161.3z M161.3,188.1 c-14.8,0-26.8-12-26.8-26.8s12-26.8,26.8-26.8h67.3c14.8,0,26.8,12,26.8,26.8s-12,26.8-26.8,26.8H161.3z" />
            </svg>
            <h3 className="text-sm font-medium">Slack</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Install Emily to your Slack workspace, then DM her to link your identity.
          </p>
          <SlackConnect />
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Your link status</p>
            <SlackBindingStatus />
          </div>
        </div>

        {/* WhatsApp card */}
        <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-card p-4">
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-[#25D366]" aria-hidden="true" focusable="false">
              <use href="#brand-whatsapp" />
            </svg>
            <h3 className="text-sm font-medium">WhatsApp</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Text Emily on WhatsApp. She&apos;ll reply with a link to bind your number to this account.
          </p>
          <div className="flex flex-wrap items-start gap-6">
            <WhatsAppQR />
            <div className="flex-1 min-w-[160px] space-y-3">
              <ol className="space-y-1.5 text-xs text-muted-foreground">
                <li>1. Scan the QR or text <span className="font-medium text-foreground">+1 650-399-9709</span>.</li>
                <li>2. Emily replies with a claim link — tap it.</li>
                <li>3. Your number is bound to this account.</li>
              </ol>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Your link status</p>
                <WhatsAppBindingStatus />
              </div>
            </div>
          </div>
        </div>

        {/* Email card — no email channel exists yet (#787/#799). Quiet "Not
            connected", never a fake "Connected" state. */}
        <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-card p-4">
          <div className="flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5">
              <Mail className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-sm font-medium">Email</h3>
            </div>
            <span className="rounded-full bg-[var(--bg-2)] px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
              Not connected
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Reaching workers over email isn&apos;t available yet. Use Slack or WhatsApp to message Emily today.
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">Agent install</h2>
          <p className="text-xs text-muted-foreground">
            Let an external AI agent operate your workers over MCP, or drive them from the CLI.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">MCP (Claude Desktop, Cursor, VS Code)</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-auto rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-2)] p-3 font-mono text-xs text-[var(--ink-soft)]">
{`{
  "mcpServers": {
    "workeros": { "command": "npx", "args": ["-y", "@floomhq/workeros", "mcp"] }
  }
}`}
            </pre>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">CLI</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-auto rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-2)] p-3 font-mono text-xs text-[var(--ink-soft)]">
{`npm i -g @floomhq/workeros
workeros login
workeros run <worker>`}
            </pre>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
