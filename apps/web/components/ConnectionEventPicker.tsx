"use client";

/**
 * ConnectionEventPicker
 *
 * Two-step picker for "Connection event" trigger:
 *   1. Pick a connected app (from user's active connections).
 *   2. Pick an event/trigger from that app's catalog.
 *
 * Resolves the composio_connection_id automatically from the selected connection.
 * White-label: never shows "Composio" to the user.
 */

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectionItem, ComposioTriggerItem } from "@/lib/types";

function triggerEventId(item: ComposioTriggerItem): string {
  return item.event || item.slug || item.id || item.name || "";
}

function triggerLabel(item: ComposioTriggerItem): string {
  return item.display_name || item.name || triggerEventId(item);
}

function triggerAppSlug(item: ComposioTriggerItem): string {
  const loose = item as unknown as { toolkit_slug?: string; app_name?: string };
  return (
    item.toolkit?.slug ||
    item.app?.slug ||
    loose.toolkit_slug ||
    loose.app_name ||
    ""
  ).toLowerCase();
}

interface ConnectionEventPickerProps {
  /** Current composio event slug (controlled) */
  composioEvent: string;
  /** Current composio connection_id (controlled) */
  composioConnectionId: string;
  onEventChange: (event: string) => void;
  onConnectionIdChange: (id: string) => void;
  /** Pre-loaded connections (optional, will fetch if not provided) */
  initialConnections?: ConnectionItem[];
}

export function ConnectionEventPicker({
  composioEvent,
  composioConnectionId,
  onEventChange,
  onConnectionIdChange,
  initialConnections,
}: ConnectionEventPickerProps) {
  const [connections, setConnections] = useState<ConnectionItem[]>(initialConnections ?? []);
  const [triggers, setTriggers] = useState<ComposioTriggerItem[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(!initialConnections);
  const [loadingTriggers, setLoadingTriggers] = useState(false);

  // Derive selected app from composioEvent (if already set) or pick from connection
  // The selectedApp controls which connections and triggers are shown.
  const [selectedApp, setSelectedApp] = useState<string>(() => {
    // If composioEvent is already set, we will populate selectedApp after triggers load.
    // Start with empty; the effect below will set it once connections arrive.
    return "";
  });

  // Load connections if not pre-loaded
  useEffect(() => {
    if (initialConnections) return;
    setLoadingConnections(true);
    api.connections.list()
      .then((items) => setConnections(items))
      .catch(() => setConnections([]))
      .finally(() => setLoadingConnections(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeConnections = connections.filter((c) => c.status === "active");

  // Unique connected apps
  const connectedApps = Array.from(
    new Map(activeConnections.map((c) => [c.app_name.toLowerCase(), c])).values()
  );

  // If composioEvent was preset and we have connections, figure out the app
  useEffect(() => {
    if (composioEvent && composioConnectionId && !selectedApp && activeConnections.length > 0) {
      const conn = activeConnections.find(
        (c) => c.composio_connection_id === composioConnectionId
      );
      if (conn) setSelectedApp(conn.app_name.toLowerCase());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnections.length]);

  // Load triggers for the selected app
  useEffect(() => {
    if (!selectedApp) { setTriggers([]); return; }
    setLoadingTriggers(true);
    api.integrations.triggersForApp(selectedApp)
      .then((res) => setTriggers(res.items || []))
      .catch(() => setTriggers([]))
      .finally(() => setLoadingTriggers(false));
  }, [selectedApp]);

  // Connections matching the selected app
  const appConnections = activeConnections.filter(
    (c) => c.app_name.toLowerCase() === selectedApp
  );

  function handleAppChange(value: string | null) {
    const app = value ?? "";
    setSelectedApp(app);
    // Reset event + connection when app changes
    onEventChange("");
    onConnectionIdChange("");
    // Auto-select connection if only one exists for this app
    const appsConns = activeConnections.filter((c) => c.app_name.toLowerCase() === app);
    if (appsConns.length === 1) {
      onConnectionIdChange(appsConns[0].composio_connection_id);
    }
  }

  function handleEventChange(value: string | null) {
    const event = value ?? "";
    onEventChange(event);
    // Ensure connection is set
    if (!composioConnectionId && appConnections.length === 1) {
      onConnectionIdChange(appConnections[0].composio_connection_id);
    }
  }

  function appDisplayName(slug: string): string {
    const conn = activeConnections.find((c) => c.app_name.toLowerCase() === slug);
    return conn?.display_name || slug.charAt(0).toUpperCase() + slug.slice(1);
  }

  if (loadingConnections) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading connected apps...
      </div>
    );
  }

  if (connectedApps.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
        <p className="text-sm text-muted-foreground">No connected integrations yet.</p>
        <a href="/connections/browse" className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs hover:bg-muted">
          <Plus className="w-3 h-3" />
          Connect an integration
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Step 1: App */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground ">Integration</Label>
        <Select value={selectedApp} onValueChange={handleAppChange}>
          <SelectTrigger className="w-full border-border">
            <SelectValue placeholder="Pick a connected integration">
              {selectedApp ? appDisplayName(selectedApp) : null}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="z-50">
            {connectedApps.map((c) => {
              const slug = c.app_name.toLowerCase();
              return (
                <SelectItem key={slug} value={slug}>
                  {appDisplayName(slug)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <a
          href="/connections/browse"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-muted-foreground transition-colors"
        >
          Connect another integration
        </a>
      </div>

      {/* Step 2: Event (only after app is chosen) */}
      {selectedApp && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground ">Event</Label>
          {loadingTriggers ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading events...
            </div>
          ) : triggers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No events found for this integration.</p>
          ) : (
            <Select value={composioEvent} onValueChange={handleEventChange}>
              <SelectTrigger className="w-full border-border">
                <SelectValue placeholder="Select an event">
                  {composioEvent
                    ? (triggers.find((t) => triggerEventId(t) === composioEvent)
                        ? triggerLabel(triggers.find((t) => triggerEventId(t) === composioEvent)!)
                        : composioEvent)
                    : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="z-50">
                {triggers.map((item) => {
                  const eventId = triggerEventId(item);
                  return (
                    <SelectItem key={eventId} value={eventId}>
                      {triggerLabel(item)}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Step 3: Connection (only if multiple connections for the same app) */}
      {selectedApp && appConnections.length > 1 && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground ">Account</Label>
          <Select value={composioConnectionId} onValueChange={(v) => onConnectionIdChange(v ?? "")}>
            <SelectTrigger className="w-full border-border">
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent className="z-50">
              {appConnections.map((conn) => (
                <SelectItem key={conn.composio_connection_id} value={conn.composio_connection_id}>
                  {conn.account_label || conn.composio_connection_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
