"use client";

// Legacy pack-detail route. The brain surface is now a single-page,
// progressive miller-columns layout at /brain. This route only exists so
// old deep links (and the old folder ?path= query) keep working: it redirects
// into /brain with the pack (and folder) pre-selected.
import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";

export default function LegacyPackDetailRedirect() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("pack", decodeURIComponent(name));
    const path = searchParams.get("path");
    if (path) params.set("path", path);
    router.replace(`/brain?${params.toString()}`);
  }, [name, router, searchParams]);

  return null;
}
