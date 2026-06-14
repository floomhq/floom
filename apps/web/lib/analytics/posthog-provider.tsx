"use client";

import { Suspense, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import type { PostHogConfig } from "posthog-js";
import { PostHogProvider as ReactPostHogProvider } from "posthog-js/react";

const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;
const PRODUCT = process.env.NEXT_PUBLIC_POSTHOG_PRODUCT || "workeros-oss";

let initialized = false;

type CurrentUser = {
  user_id?: string | null;
  workspace_id?: string | null;
};

function activeWorkspaceId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY) || "local-default";
}

function initPostHog() {
  if (typeof window === "undefined" || !POSTHOG_KEY || initialized) return false;

  const config: Partial<PostHogConfig> = {
    api_host: POSTHOG_HOST,
    person_profiles: "identified_only",
    autocapture: true,
    capture_pageview: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    session_recording: {
      maskAllInputs: true,
      maskInputOptions: {
        date: true,
        "datetime-local": true,
        email: true,
        month: true,
        number: true,
        password: true,
        range: true,
        search: true,
        select: true,
        tel: true,
        text: true,
        textarea: true,
        time: true,
        url: true,
        week: true,
      },
    },
  };

  posthog.init(POSTHOG_KEY, config);
  posthog.register({ product: PRODUCT });
  initialized = true;
  return true;
}

function AnalyticsIdentity() {
  const pathname = usePathname();
  const lastIdentity = useRef<string | null>(null);

  useEffect(() => {
    if (!initialized) return;
    let cancelled = false;
    const workspaceId = activeWorkspaceId();
    const headers = new Headers();
    if (workspaceId) headers.set("x-workeros-workspace", workspaceId);

    fetch("/api/me", {
      cache: "no-store",
      headers,
    })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          if (lastIdentity.current) {
            posthog.reset();
            lastIdentity.current = null;
          }
          return;
        }

        const user = (await response.json()) as CurrentUser;
        if (!user.user_id) {
          if (lastIdentity.current) {
            posthog.reset();
            lastIdentity.current = null;
          }
          return;
        }

        const resolvedWorkspaceId = user.workspace_id || workspaceId || undefined;
        const identityKey = `${user.user_id}:${resolvedWorkspaceId || ""}`;
        if (identityKey !== lastIdentity.current) {
          posthog.identify(user.user_id, { workspace_id: resolvedWorkspaceId });
          lastIdentity.current = identityKey;
        }
      })
      .catch(() => {
        if (!cancelled && lastIdentity.current) {
          posthog.reset();
          lastIdentity.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return null;
}

function RoutePageViews() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const firstRender = useRef(true);
  const search = searchParams.toString();

  useEffect(() => {
    if (!initialized) return;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    posthog.capture("$pageview", {
      $current_url: window.location.href,
      product: PRODUCT,
    });
  }, [pathname, search]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  if (!POSTHOG_KEY || typeof window === "undefined") {
    return <>{children}</>;
  }

  initPostHog();

  return (
    <ReactPostHogProvider client={posthog}>
      <AnalyticsIdentity />
      <Suspense fallback={null}>
        <RoutePageViews />
      </Suspense>
      {children}
    </ReactPostHogProvider>
  );
}

