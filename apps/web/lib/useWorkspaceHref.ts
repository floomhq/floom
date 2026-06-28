"use client";

import { useCallback, useEffect, useState } from "react";
import { withWorkspaceParam } from "@/lib/workspaceHref";

export function useWorkspaceHref(): (href: string) => string {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return useCallback((href: string) => (mounted ? withWorkspaceParam(href) : href), [mounted]);
}
