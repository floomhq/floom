"use client";

import posthog from "posthog-js";
import type { CurrentUser } from "@/lib/types";

let initialized = false;
let identifiedUserId: string | null = null;

export function initPostHog() {
  if (initialized || typeof window === "undefined") return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    autocapture: true,
    capture_pageview: false,
    capture_pageleave: true,
    person_profiles: "identified_only",
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
}

export function capturePostHogEvent(eventName: string, properties: Record<string, unknown> = {}) {
  const client = postHogClient();
  if (!client) return;
  client.capture(eventName, properties);
}
