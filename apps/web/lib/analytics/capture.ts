type AnalyticsValue = string | number | boolean | null | undefined;

export type AnalyticsProperties = Record<string, AnalyticsValue>;

const PRODUCT = process.env.NEXT_PUBLIC_POSTHOG_PRODUCT || "workeros-oss";

function hasPostHogKey() {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);
}

export function capture(event: string, props: AnalyticsProperties = {}) {
  if (typeof window === "undefined" || !hasPostHogKey()) return;

  void import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.capture(event, { product: PRODUCT, ...props });
    })
    .catch(() => {
      // Analytics must never break product flows.
    });
}

