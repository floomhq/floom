"use client";

// Legacy pack-detail route. Brain now uses the shared Collection split pane.
// Old deep links redirect into /brain with the folder selected.
import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";

export default function LegacyPackDetailRedirect() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("sel", decodeURIComponent(name));
    const path = searchParams.get("path");
    if (path) params.set("path", path);
    router.replace(`/brain?${params.toString()}`);
  }, [name, router, searchParams]);

  return null;
}
