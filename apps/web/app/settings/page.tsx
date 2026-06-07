"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { CliCommandPanel } from "@/components/CliCommandPanel";
import { ThemeModeToggleGroup } from "@/components/ThemeModeToggleGroup";
import { SlackConnect } from "@/components/assistant/SlackConnect";
import { AlertTriangle, CheckCircle2, Copy, Trash2 } from "lucide-react";

function PersonalAccessTokensPanel() {
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
type TabKey = "developer" | "system" | "slack" | "assistant" | "notifications" | "appearance" | "danger";

const VISIBLE_TAB_KEYS: TabKey[] = ["developer", "system", "slack", "appearance", "danger"];
const TAB_KEYS: TabKey[] = ["developer", "system", "slack", "assistant", "notifications", "appearance", "danger"];

const NAV_ITEMS: { key: TabKey; label: string }[] = [
  { key: "developer", label: "Developer" },
  { key: "system", label: "System" },
  { key: "slack", label: "Slack" },
  { key: "appearance", label: "Appearance" },
  { key: "danger", label: "Danger zone" },
];

function isValidTab(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.includes(value as TabKey);
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const searchParams = useSearchParams();
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
    const candidate = fromHash || fromQuery;
    // S22f / S-dev: hidden tab (e.g. notifications) or legacy #api URL falls
    // back to "developer". Legacy ?tab=api / #api deep-links land here too.
    if (candidate === "api") return "developer";
    return isValidTab(candidate) && VISIBLE_TAB_KEYS.includes(candidate)
      ? candidate
      : "developer";
  })();
  const [tab, setTab] = useState<TabKey>(initialTab);

  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [reloading, setReloading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [claimedWhatsAppToken, setClaimedWhatsAppToken] = useState<string | null>(null);
  const [waClaimBanner, setWaClaimBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [fromInstallChannel, setFromInstallChannel] = useState<string | null>(null);
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
              ? "This link has expired. Text the Workeros number again to get a new one."
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
      }
    })();
  }, [claimedWhatsAppToken, searchParams]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep state in sync with the URL hash for deep-links and back/forward.
  useEffect(() => {
    function syncFromHash() {
      const raw = window.location.hash.replace(/^#/, "");
      // legacy #api URLs redirect to developer tab
      const fromHash = raw === "api" ? "developer" : raw;
      if (isValidTab(fromHash) && VISIBLE_TAB_KEYS.includes(fromHash)) {
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
          System configuration and access.
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
          <TabsList>
            {NAV_ITEMS.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
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

        <TabsContent value="slack" className="pt-6">
          <SlackConnect />
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
            Choose how Workeros looks. System follows your operating system.
          </p>
          <ThemeModeToggleGroup />
        </TabsContent>

        <TabsContent value="danger" className="space-y-4 pt-6">
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
}: {
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch disabled={disabled} />
      {disabled ? (
        <Badge variant="outline" className="text-xs">
          Soon
        </Badge>
      ) : null}
    </div>
  );
}
