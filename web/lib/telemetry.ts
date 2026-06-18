"use client";

import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";
const SESSION_STORAGE_KEY = "workeros.telemetrySessionId";

type TelemetryProperties = Record<string, unknown>;

interface TelemetryEvent {
  event_name: string;
  event_version?: number;
  source?: "web";
  session_id?: string;
  properties?: TelemetryProperties;
  occurred_at?: string;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function telemetrySessionId(): string {
  const existing = safeStorageGet("session", SESSION_STORAGE_KEY);
  if (existing) return existing;
  const created = randomId();
  safeStorageSet("session", SESSION_STORAGE_KEY, created);
  return created;
}

function activeWorkspaceId(): string | null {
  const value = safeStorageGet("local", ACTIVE_WORKSPACE_STORAGE_KEY);
  return value && value !== "local-default" ? value : null;
}

function telemetryHeaders(): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const workspaceId = activeWorkspaceId();
  if (workspaceId) headers.set("x-workeros-workspace", workspaceId);
  return headers;
}

function eventPayload(event: TelemetryEvent): TelemetryEvent {
  return {
    event_version: 1,
    source: "web",
    session_id: telemetrySessionId(),
    occurred_at: new Date().toISOString(),
    ...event,
  };
}

export function trackTelemetry(eventName: string, properties: TelemetryProperties = {}) {
  if (typeof window === "undefined") return;
  const event = eventPayload({
    event_name: eventName,
    properties: {
      path: window.location.pathname,
      ...properties,
    },
  });
  fetch(`${API_BASE}/telemetry/events`, {
    method: "POST",
    headers: telemetryHeaders(),
    body: JSON.stringify({ events: [event] }),
    keepalive: true,
  }).catch(() => {
    // Telemetry never blocks product workflows.
  });
}

export function safeHrefPath(rawHref: string | null): string | null {
  if (!rawHref) return null;
  try {
    const url = new URL(rawHref, window.location.origin);
    if (url.origin !== window.location.origin) return "external";
    return url.pathname;
  } catch {
    return null;
  }
}
