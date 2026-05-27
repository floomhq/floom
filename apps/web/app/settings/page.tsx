"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { PlatformConfig, SystemInfo } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CliCommandPanel } from "@/components/CliCommandPanel";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

type TabKey = "api" | "system" | "notifications" | "appearance" | "danger";

const TAB_KEYS: TabKey[] = ["api", "system", "notifications", "appearance", "danger"];

function isValidTab(value: string | null): value is TabKey {
  return value !== null && TAB_KEYS.includes(value as TabKey);
}

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [tab, setTab] = useState<TabKey>(isValidTab(tabParam) ? tabParam : "api");

  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [reloading, setReloading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

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
    if (isValidTab(tabParam) && tabParam !== tab) setTab(tabParam);
  }, [tabParam, tab]);

  function handleTabChange(value: string) {
    if (!isValidTab(value)) return;
    setTab(value);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
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
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    try {
      await api.system.clearRuns();
      toast.success("Run history cleared");
      setConfirmClear(false);
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

      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="api">API access</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="danger">Danger zone</TabsTrigger>
        </TabsList>

        <TabsContent value="api" className="space-y-4">
          <CliCommandPanel />
        </TabsContent>

        <TabsContent value="system" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">System info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Platform configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!platformConfig ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-md bg-muted p-3">
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Workers</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">
                  Reload workers from disk to pick up config changes.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReload}
                  disabled={reloading}
                >
                  {reloading ? "Reloading..." : "Reload workers"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="space-y-4">
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

        <TabsContent value="appearance" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Theme</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Floom is light-only for now. System and dark themes land after v1.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="danger" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Danger zone</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Clear run history</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Deletes all runs, logs, artifacts, and approvals. Cannot be undone.
                  </p>
                </div>
                <Button
                  variant={confirmClear ? "destructive" : "outline"}
                  size="sm"
                  className="shrink-0"
                  onClick={handleClearRuns}
                  disabled={clearing}
                >
                  {clearing
                    ? "Clearing..."
                    : confirmClear
                    ? "Confirm clear"
                    : "Clear runs"}
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
