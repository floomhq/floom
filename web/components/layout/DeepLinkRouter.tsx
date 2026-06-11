"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { deepLinkTarget } from "@/lib/deep-links";

// APP-UI-V4-SPEC §2: a recognized page hash (#workers, #runs, …) on load sets
// the initial page. Runs once on mount and on hashchange; unknown hashes are
// ignored so in-page hash state (SlackConnect, Emily anchors) is untouched.
export function DeepLinkRouter() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const apply = () => {
      const target = deepLinkTarget(pathname, window.location.hash);
      if (target) router.replace(target);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [pathname, router]);

  return null;
}
