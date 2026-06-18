"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { api } from "@/lib/api";
import { identifyPostHogUser } from "@/lib/posthog";
import { safeHrefPath, trackTelemetry } from "@/lib/telemetry";

function targetProperties(target: Element): Record<string, unknown> {
  const element = target.closest<HTMLElement>("button,a,[role='button'],[data-telemetry]");
  if (!element) return {};
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role");
  const telemetryId = element.getAttribute("data-telemetry");
  const ariaLabel = element.getAttribute("aria-label");
  const href = element instanceof HTMLAnchorElement ? safeHrefPath(element.href) : null;
  return {
    tag,
    role,
    telemetry_id: telemetryId,
    aria_label: ariaLabel,
    href,
    disabled:
      element.getAttribute("aria-disabled") === "true" ||
      (element instanceof HTMLButtonElement ? element.disabled : false),
  };
}

export function TelemetryProvider() {
  const pathname = usePathname();
  const telemetryDisabled = pathname === "/approvals/review" || pathname?.startsWith("/approvals/review/");
  const seenSession = useRef(false);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (telemetryDisabled) return;
    if (!seenSession.current) {
      seenSession.current = true;
      trackTelemetry("web.session_start", {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
      });
    }
  }, [telemetryDisabled]);

  useEffect(() => {
    if (telemetryDisabled) return;
    let active = true;
    api.me()
      .then((user) => {
        if (active) identifyPostHogUser(user);
      })
      // #1446: telemetry identify is background; log (no toast) so a failed
      // /me does not silently drop user attribution without a trace.
      .catch((err) => console.error("Telemetry identify failed", err));
    return () => {
      active = false;
    };
  }, [telemetryDisabled]);

  useEffect(() => {
    if (telemetryDisabled) return;
    const path = pathname || window.location.pathname;
    if (lastPath.current === path) return;
    lastPath.current = path;
    trackTelemetry("web.page_view", {
      page: path,
      referrer_path: safeHrefPath(document.referrer),
    });
  }, [pathname, telemetryDisabled]);

  useEffect(() => {
    if (telemetryDisabled) return;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const properties = targetProperties(event.target);
      if (!properties.tag) return;
      trackTelemetry("web.click", properties);
    };
    const onError = (event: ErrorEvent) => {
      trackTelemetry("web.error", {
        message: event.message,
        filename: safeHrefPath(event.filename),
      });
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      trackTelemetry("web.unhandled_rejection", {
        reason: event.reason instanceof Error ? event.reason.message : String(event.reason || "unknown"),
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        trackTelemetry("web.visibility_hidden");
      }
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [telemetryDisabled]);

  return null;
}
