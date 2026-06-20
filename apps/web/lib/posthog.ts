"use client";

// Client-side PostHog wiring for the WorkerOS Cloud dashboard.
//
// Scope (Track B, Phase 2 + Phase 3 of the instrumentation spec):
//   - Phase 2: client INTENT events only. Run/worker/connection OUTCOMES are
//     emitted server-side (engine PRs #1715/#1718). The client must NEVER also
//     emit run_started / worker_created / connection_added or it double-counts.
//   - $groups.workspace on every event so client events are workspace-attributed
//     and join the server-side per-workspace funnels.
//   - Phase 3: session-replay privacy. Workers touch email/Slack/PII, so the
//     replay config is default-deny on payloads (mask all inputs, ph-no-capture
//     on payload elements, console limited to warn/error, /api/proxy bodies
//     dropped).
//
// Reads NEXT_PUBLIC_POSTHOG_KEY / NEXT_PUBLIC_POSTHOG_HOST. When the key is
// unset (local/dev, and prod until Vivek sets the env at deploy) every export
// here is a no-op, so importing it is always safe.

import posthog from "posthog-js";
import type { CurrentUser } from "@/lib/types";

const SCHEMA_VERSION = 1;
const DEFAULT_HOST = "https://us.i.posthog.com";

let initialized = false;
let identifiedUserId: string | null = null;
let groupedWorkspaceId: string | null = null;

// Elements that render run input/output, transcripts, tool results, secrets,
// connection tokens, or message bodies must carry this class so session replay
// masks them. maskAllInputs only covers <input>/<textarea>; rendered text is a
// separate vector (Codex C5) and is covered here.
export const PH_NO_CAPTURE_CLASS = "ph-no-capture";

// Dynamic-segment routes → templated path for the $pageview `route` property.
// Keeps UUIDs out of the URL dimension so funnels group by page, not by id.
const DYNAMIC_ROUTE_PATTERNS: Array<[RegExp, string]> = [
  [/^\/workers\/[^/]+/, "/workers/:id"],
  [/^\/runs\/[^/]+/, "/runs/:id"],
  [/^\/run\/[^/]+/, "/run/:id"],
  [/^\/w\/[^/]+/, "/w/:id"],
  [/^\/connections\/mcp\/[^/]+/, "/connections/mcp/:id"],
  [/^\/connections\/connect\/[^/]+/, "/connections/connect/:app"],
  [/^\/connections\/[^/]+/, "/connections/:id"],
  [/^\/contexts\/[^/]+\/files\/.+/, "/contexts/:name/files/:path"],
  [/^\/contexts\/[^/]+/, "/contexts/:name"],
  [/^\/review\/[^/]+/, "/review/:token"],
  [/^\/s\/[^/]+/, "/s/:token"],
  [/^\/auth\/magic\/[^/]+/, "/auth/magic/:token"],
];

export function templateRoute(pathname: string): string {
  for (const [pattern, template] of DYNAMIC_ROUTE_PATTERNS) {
    if (pattern.test(pathname)) return template;
  }
  return pathname;
}

export function initPostHog() {
  if (initialized || typeof window === "undefined") return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_HOST,
    // Autocapture stays ON for exploratory funnels; named intent events below
    // are explicit so they survive DOM refactors.
    autocapture: true,
    // Manual pageviews via PostHogPageView (App Router route changes are not
    // full page loads, so PostHog's automatic pageview would under-count).
    capture_pageview: false,
    capture_pageleave: true,
    // No anonymous person bloat: anonymous pre-login pageviews do not create
    // person profiles.
    person_profiles: "identified_only",

    // Console is a PII bypass of DOM masking (Codex C-r2 / R4): session replay
    // records console.* args verbatim, so any console.log of a transcript, tool
    // result, or message body leaks even when the DOM node is masked. posthog-js
    // exposes console-recording only as an on/off switch (no public per-level
    // filter), so we disable it entirely — the strongest closure of this vector.
    // App logs are still visible in the browser devtools; they are simply not
    // shipped into the recording. (A future warn/error-only level filter can be
    // set via PostHog remote replay config without a client change.)
    enable_recording_console_log: false,

    // Web vitals only (no full network-timing capture as a perf side channel).
    capture_performance: { web_vitals: true, network_timing: false },

    // -------- Phase 3: session replay privacy (workers touch email/Slack/PII) --------
    session_recording: {
      // Mask every <input>/<textarea> value by default.
      maskAllInputs: true,
      // Rendered payload text (transcripts, tool results, email/Slack bodies)
      // is masked by wrapping those elements in `ph-no-capture`. That class is
      // ALSO PostHog's default `blockClass`, so a wrapped element is both
      // text-masked and block-masked. maskTextSelector:"*" is intentionally NOT
      // used (too aggressive — it would hide nav/status chrome needed to read
      // the UX flow). Safe chrome (worker names, status badges, error_category
      // labels) stays visible.
      blockClass: PH_NO_CAPTURE_CLASS,
      maskTextSelector: `.${PH_NO_CAPTURE_CLASS}`,
      // Belt-and-suspenders: never record request/response headers or bodies at
      // the rrweb layer (auth tokens live in headers).
      recordHeaders: false,
      recordBody: false,
      // Drop request/response BODIES for the API proxy so PII payloads and auth
      // headers never enter the recording. The same-origin app proxy and auth
      // routes carry run payloads + tokens, so we drop those whole requests;
      // everything else keeps the URL/timing skeleton with bodies nulled.
      maskCapturedNetworkRequestFn: (request) => {
        try {
          const url = request.name || "";
          if (url.includes("/api/proxy/") || url.includes("/api/auth/")) {
            return null;
          }
        } catch {
          // If anything about the request is unreadable, fail closed (drop it).
          return null;
        }
        request.requestBody = null;
        request.responseBody = null;
        request.requestHeaders = undefined;
        request.responseHeaders = undefined;
        return request;
      },
    },
  });

  initialized = true;
}

export function postHogClient() {
  initPostHog();
  return initialized ? posthog : null;
}

export function identifyPostHogUser(user: CurrentUser | null | undefined) {
  if (!user?.user_id) return;
  if (identifiedUserId === user.user_id) return;
  const client = postHogClient();
  if (!client) return;
  client.identify(user.user_id, {
    email: user.email || undefined,
    name: user.display_name || undefined,
  });
  identifiedUserId = user.user_id;
}

export function resetPostHogUser() {
  const client = postHogClient();
  if (!client) return;
  client.reset();
  identifiedUserId = null;
  groupedWorkspaceId = null;
  // Clear the once-per-session login_completed guard (see PostHogIdentity) so a
  // subsequent login in the same browser session re-fires login_completed.
  try {
    sessionStorage.removeItem("workeros.posthog.loginFired");
  } catch {
    // sessionStorage may be unavailable; non-fatal.
  }
}

// Attach the active workspace as the PostHog `workspace` group so every
// subsequent client event carries $groups.workspace and joins the server-side
// per-workspace funnels. Server events use the SAME group key ("workspace").
export function groupPostHogWorkspace(
  workspaceId: string | null | undefined,
  properties: Record<string, unknown> = {}
) {
  if (!workspaceId) return;
  const client = postHogClient();
  if (!client) return;
  // Re-grouping with no new props on every navigation is wasteful; only call
  // group() when the workspace actually changed or we have fresh props.
  if (groupedWorkspaceId === workspaceId && Object.keys(properties).length === 0) {
    return;
  }
  client.group("workspace", workspaceId, properties);
  groupedWorkspaceId = workspaceId;
}

// Single capture entry point for client INTENT events. Stamps the mandated
// property convention (schema_version, emitter, workspace_id). Outcomes are
// server-only — never call this with run_started/worker_created/
// connection_added (the server owns those names).
export function capturePostHogEvent(
  eventName: string,
  properties: Record<string, unknown> = {}
) {
  const client = postHogClient();
  if (!client) return;
  client.capture(eventName, {
    schema_version: SCHEMA_VERSION,
    emitter: "client",
    ...properties,
  });
}
