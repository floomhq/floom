type AnalyticsPrimitive = string | number | boolean | null | undefined;
type AnalyticsValue = AnalyticsPrimitive | AnalyticsPrimitive[];

export type AnalyticsProperties = Record<string, AnalyticsValue>;

const PRODUCT = process.env.NEXT_PUBLIC_POSTHOG_PRODUCT || "workeros-oss";

function hasPostHogKey() {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);
}

type CaptureOptions = {
  setOnce?: AnalyticsProperties;
};

export function capture(event: string, props: AnalyticsProperties = {}, options?: CaptureOptions) {
  if (typeof window === "undefined" || !hasPostHogKey()) return;

  void import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.capture(event, {
        product: PRODUCT,
        ...props,
        ...(options?.setOnce ? { $set_once: options.setOnce } : {}),
      });
    })
    .catch(() => {
      // Analytics must never break product flows.
    });
}

export function captureException(error: unknown, props: AnalyticsProperties = {}) {
  if (typeof window === "undefined" || !hasPostHogKey()) return;

  void import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.captureException(error, { product: PRODUCT, ...props });
    })
    .catch(() => {
      // Analytics must never break product flows.
    });
}
