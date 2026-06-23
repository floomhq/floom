"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PostHogProvider as ReactPostHogProvider } from "posthog-js/react";

import { initPostHog, postHogClient, sanitizedCurrentUrl, templateRoute } from "@/lib/posthog";

function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const client = postHogClient();
    if (!client) return;

    client.capture("$pageview", {
      $current_url: sanitizedCurrentUrl(pathname),
      route: templateRoute(pathname),
    });
  }, [pathname, searchParams]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  initPostHog();
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
