"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plug, Plus, Trash2, RefreshCw, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { ConnectionItem, SupportedApp } from "@/lib/types";

// Hardcoded supported apps (matches backend SUPPORTED_APPS)
const SUPPORTED_APPS: SupportedApp[] = [
  { slug: "gmail", display_name: "Gmail" },
  { slug: "linkedin", display_name: "LinkedIn" },
  { slug: "hubspot", display_name: "HubSpot" },
  { slug: "slack", display_name: "Slack" },
  { slug: "notion", display_name: "Notion" },
  { slug: "googledrive", display_name: "Google Drive" },
  { slug: "apollo", display_name: "Apollo" },
];

function statusBadge(status: string) {
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="text-emerald-600 border-emerald-200 bg-emerald-50 text-xs"
      >
        Active
      </Badge>
    );
  }
  if (status === "initiated") {
    return (
      <Badge
        variant="outline"
        className="text-amber-600 border-amber-200 bg-amber-50 text-xs"
      >
        Connecting
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-red-600 border-red-200 bg-red-50 text-xs"
    >
      {status === "expired" ? "Expired" : status === "failed" ? "Failed" : "Inactive"}
    </Badge>
  );
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.connections.list();
      setConnections(list);
    } catch {
      toast.error("Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while any connection is in "initiated" state
  useEffect(() => {
    const hasInitiated = connections.some((c) => c.status === "initiated");
    if (hasInitiated && !pollIntervalRef.current) {
      pollIntervalRef.current = setInterval(() => {
        void refresh();
      }, 3000);
    } else if (!hasInitiated && pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [connections, refresh]);

  const connectedSlugs = new Set(connections.map((c) => c.app_name.toLowerCase()));

  async function handleConnect(slug: string) {
    setConnecting(slug);
    try {
      const result = await api.connections.initiate(slug);
      setConnectOpen(false);
      // Open Composio OAuth in new tab
      if (result.redirect_url) {
        window.open(result.redirect_url, "_blank");
        toast.success(`OAuth opened — authorize ${slug} in the new tab`);
      } else {
        toast.success(`Connection initiated for ${slug}`);
      }
      void refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : `Failed to connect ${slug}`);
    } finally {
      setConnecting(null);
    }
  }

  async function handleRefresh(conn: ConnectionItem) {
    setRefreshing(conn.id);
    try {
      const updated = await api.connections.status(conn.id);
      setConnections((prev) =>
        prev.map((c) => (c.id === conn.id ? updated : c))
      );
      if (updated.status === "active") {
        toast.success(`${conn.app_name} is now active`);
      } else {
        toast.info(`Status: ${updated.status}`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(null);
    }
  }

  async function handleDelete(conn: ConnectionItem) {
    setDeleting(conn.id);
    try {
      await api.connections.delete(conn.id);
      toast.success(`${conn.app_name} disconnected`);
      void refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="text-[#666] text-sm mt-1">
            Connect apps via OAuth so workers can read and write on your behalf.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConnectOpen(true)}
          className="gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Connect an app
        </Button>
      </div>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Active connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))
          ) : connections.length === 0 ? (
            <div className="py-8 text-center">
              <Plug className="w-8 h-8 text-[#d4d4d8] mx-auto mb-3" />
              <p className="text-sm text-[#999]">No connections yet.</p>
              <p className="text-xs text-[#bbb] mt-1">
                Connect Gmail, Slack, or other apps to use them in workers.
              </p>
            </div>
          ) : (
            connections.map((conn) => (
              <div
                key={conn.id}
                className="flex items-center justify-between p-3 rounded-md hover:bg-[#f4f4f5] transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Plug className="w-4 h-4 text-[#999] shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium capitalize">{conn.app_name}</p>
                    <p className="text-xs text-[#999] font-mono truncate max-w-[200px]">
                      {conn.composio_connection_id}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {statusBadge(conn.status)}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-[#666] hover:text-[#333]"
                    onClick={() => handleRefresh(conn)}
                    disabled={refreshing === conn.id}
                    title="Refresh status"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 mr-1 ${refreshing === conn.id ? "animate-spin" : ""}`}
                    />
                    {refreshing === conn.id ? "Checking..." : "Check"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-red-500 hover:text-red-700"
                    onClick={() => handleDelete(conn)}
                    disabled={deleting === conn.id}
                    title="Disconnect"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardContent className="p-5 text-sm text-[#666]">
          <p>
            Connections use OAuth — you authorize access in a new tab and Composio stores the token securely.
            Workers that declare a connection in their{" "}
            <code className="bg-[#f4f4f5] px-1 py-0.5 rounded text-xs">worker.yml</code>{" "}
            will fail immediately if the connection is missing or expired.
          </p>
        </CardContent>
      </Card>

      {/* Connect modal */}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect an app</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 mt-2">
            {SUPPORTED_APPS.map((app) => {
              const isConnected = connectedSlugs.has(app.slug);
              return (
                <div
                  key={app.slug}
                  className="flex items-center justify-between p-3 rounded-md border border-[#eaeaea] hover:bg-[#f9f9f9] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Plug className="w-4 h-4 text-[#999]" />
                    <span className="text-sm font-medium">{app.display_name}</span>
                    {isConnected && (
                      <Badge
                        variant="outline"
                        className="text-xs text-emerald-600 border-emerald-200 bg-emerald-50"
                      >
                        Connected
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={isConnected ? "outline" : "default"}
                    className="gap-1.5 text-xs h-7"
                    onClick={() => handleConnect(app.slug)}
                    disabled={connecting === app.slug}
                  >
                    <ExternalLink className="w-3 h-3" />
                    {connecting === app.slug
                      ? "Opening..."
                      : isConnected
                      ? "Reconnect"
                      : "Connect"}
                  </Button>
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
