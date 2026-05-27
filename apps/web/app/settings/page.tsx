"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { PlatformConfig, SystemInfo } from "@/lib/types";

export default function SettingsPage() {
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
                <span className="text-[#666]">Version</span>
                <span className="font-medium font-mono">{info.version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#666]">Started at</span>
                <span className="font-medium font-mono">{info.started_at}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#666]">Python</span>
                <span className="font-medium font-mono">{info.python_version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#666]">Runner</span>
                <span className="font-medium">{info.runner}</span>
              </div>
            </>
          ) : (
            // N8 fix: skeleton placeholders instead of "Loading..." text to
            // eliminate the 4-6s flash on first load.
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

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Platform configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-xs font-medium text-[#555] mb-2">Required secrets</p>
            <p className="text-xs text-[#999] mb-3">
              Configure required environment variables on the API host.
            </p>
            {!platformConfig ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-md bg-[#f4f4f5]">
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="h-8 w-20 rounded" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between p-2 rounded-md bg-[#f4f4f5]">
                  <span className="text-sm text-[#555]">Configured</span>
                  <span className="font-medium text-sm">
                    {platformConfig.set_count}/{platformConfig.required_count}
                  </span>
                </div>

                {platformConfig.all_required_set ? (
                  <div className="flex items-center justify-between p-2 rounded-md bg-emerald-50 border border-emerald-200">
                    <span className="text-sm text-emerald-700">All required secrets are configured.</span>
                    <Badge variant="outline" className="text-emerald-700 border-emerald-300 bg-emerald-100">
                      ready
                    </Badge>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {platformConfig.missing.map((name) => (
                      <div key={name} className="flex items-center justify-between p-2 rounded-md bg-[#fef2f2] border border-red-200">
                        <div className="min-w-0">
                          <span className="text-sm font-mono text-[#333]">{name}</span>
                          <p className="text-xs text-[#a33] mt-0.5">Missing</p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void copySecretName(name)}
                        >
                          Copy name
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
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
