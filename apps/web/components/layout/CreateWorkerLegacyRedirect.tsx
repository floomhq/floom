"use client";

import { useCreateWorkerLegacyRedirect } from "@/lib/use-create-worker-route";

/** Forwards legacy `/?create=1` deep links to /workers/new. */
export function CreateWorkerLegacyRedirect() {
  useCreateWorkerLegacyRedirect();
  return null;
}
