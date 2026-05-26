"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { api } from "@/lib/api";

interface SystemInfo {
  api_version: string;
  workers_dir: string;
  db_path: string;
  artifacts_dir: string;
  run_count: number;
  worker_count: number;
}

interface PlatformSecret {
  name: string;
  status: string;
  required: boolean;
  default: string | null;
  description: string | null;
}

export default function SettingsPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [platformSecrets, setPlatformSecrets] = useState<PlatformSecret[]>([]);
  const [infraPaths, setInfraPaths] = useState<PlatformSecret[]>([]);
  const [reloading, setReloading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [infoRes, platformRes] = await Promise.all([
        api.system.info(),
        api.system.platformConfig(),
      ]);
      setInfo(infoRes as unknown as SystemInfo);
      setPlatformSecrets(platformRes.platform_secrets);
      setInfraPaths(platformRes.infra_paths ?? []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

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

  function platformSecretBadge(s: PlatformSecret) {
    if (s.status === "set") {
      return (
        <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 shrink-0 ml-2">
          set
        </Badge>
      );
    }
    if (!s.required) {
      const label = s.default ? `optional, default: ${s.default}` : "optional";
      return (
        <Badge variant="outline" className="text-[#888] border-[#ddd] bg-[#f7f7f7] shrink-0 ml-2">
          {label}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 shrink-0 ml-2">
        missing
      </Badge>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-[#666] text-sm mt-1">System configuration and maintenance.</p>
      </div>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">System Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {info ? (
            <>
              <div className="flex justify-between">
                <span className="text-[#666]">API version</span>
                <span className="font-medium font-mono">{info.api_version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#666]">Workers loaded</span>
                <span className="font-medium">{info.worker_count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#666]">Total runs</span>
                <span className="font-medium">{info.run_count}</span>
              </div>
              {/* Server filesystem paths (workers_dir / db_path / artifacts_dir)
                  are intentionally NOT rendered: audit 2026-05-26 flagged them
                  as a leak surface. They remain available on the platform
                  configuration card below for the operator if needed. */}
            </>
          ) : (
            <p className="text-[#999]">Loading...</p>
          )}
        </CardContent>
      </Card>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Platform configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-xs font-medium text-[#555] mb-2">Required secrets</p>
            <p className="text-xs text-[#999] mb-3">
              Credentials the platform needs to run. Set these as environment variables on the server.
            </p>
            <div className="space-y-2">
              {platformSecrets.length === 0 ? (
                <p className="text-sm text-[#999]">Loading...</p>
              ) : (
                platformSecrets.map((s) => (
                  <div key={s.name} className="flex items-center justify-between p-2 rounded-md bg-[#f4f4f5]">
                    <div className="min-w-0">
                      <span className="text-sm font-mono text-[#333]">{s.name}</span>
                      {s.description && (
                        <p className="text-xs text-[#999] mt-0.5">{s.description}</p>
                      )}
                    </div>
                    {platformSecretBadge(s)}
                  </div>
                ))
              )}
            </div>
          </div>
          {infraPaths.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-medium text-[#555] mb-2">Infrastructure paths</p>
                <p className="text-xs text-[#999] mb-3">
                  Filesystem and tuning config. Defaults work for most setups.
                </p>
                <div className="space-y-2">
                  {infraPaths.map((s) => (
                    <div key={s.name} className="flex items-center justify-between p-2 rounded-md bg-[#f4f4f5]">
                      <div className="min-w-0">
                        <span className="text-sm font-mono text-[#333]">{s.name}</span>
                        {s.description && (
                          <p className="text-xs text-[#999] mt-0.5">{s.description}</p>
                        )}
                      </div>
                      {platformSecretBadge(s)}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Workers</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[#666]">Reload workers from disk to pick up config changes.</p>
            <Button variant="outline" size="sm" onClick={handleReload} disabled={reloading}>
              {reloading ? "Reloading..." : "Reload workers"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-red-200 shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-red-800">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Clear run history</p>
              <p className="text-xs text-[#999] mt-0.5">
                Deletes all runs, logs, artifacts, and approvals. Cannot be undone.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className={
                confirmClear
                  ? "border-red-500 text-red-700 bg-red-50 hover:bg-red-100 shrink-0"
                  : "border-red-200 text-red-700 hover:bg-red-50 shrink-0"
              }
              onClick={handleClearRuns}
              disabled={clearing}
            >
              {clearing ? "Clearing..." : confirmClear ? "Confirm clear" : "Clear runs"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
