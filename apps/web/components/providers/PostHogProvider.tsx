"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PostHogProvider as ReactPostHogProvider } from "posthog-js/react";

import { initPostHog, postHogClient, templateRoute } from "@/lib/posthog";

// Manual pageview capture. We set `capture_pageview:false` in init because the
// App Router does client-side route transitions (not full page loads), so
// PostHog's automatic pageview would miss every in-app navigation. This effect
// fires on every pathname/searchParams change and sends one $pageview.
//
// Verified firing: `usePathname()` returns a NEW string reference on each route
// change and is in the dependency array, so the effect re-runs on every
// navigation (initial mount + every subsequent SPA transition). It is wrapped in
// <Suspense> because `useSearchParams()` opts the subtree into client-side
// rendering / Suspense per Next.js requirements.
function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const client = postHogClient();
    if (!client) return;
    if (!pathname) return;

    client.capture("$pageview", {
      $current_url: window.location.href,
      // Templated path (UUIDs masked → /runs/:id) so funnels group by page,
      // not by individual id.
      route: templateRoute(pathname),
      schema_version: 1,
      emitter: "client",
    });
    // searchParams is included so a query-only navigation (e.g. /runs?sel=x)
    // also records a pageview.
  }, [pathname, searchParams]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  // Idempotent: initPostHog no-ops if already initialized or if the key is
  // unset (local/dev, and prod until the env is set at deploy).
  useEffect(() => {
    initPostHog();
  }, []);

  const client = postHogClient();
  if (!client) return <>{children}</>;

  return (
    <ReactPostHogProvider client={client}>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      {children}
    </ReactPostHogProvider>
  );
}
