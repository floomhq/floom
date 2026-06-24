"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createWorkerHref } from "@/lib/create-worker-nav";

/**
 * Legacy redirect: old links used `/?create=1` (and `&prime=` / `&prompt=`) to
 * open worker creation. Forward them to /workers/new.
 */
export function useCreateWorkerLegacyRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const createParam = searchParams.get("create") === "1";

  useEffect(() => {
    if (!createParam) return;
    const prompt =
      searchParams.get("prime")?.trim() ||
      searchParams.get("prompt")?.trim() ||
      "";
    router.replace(createWorkerHref(prompt || undefined));
  }, [createParam, router, searchParams]);
}
