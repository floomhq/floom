"use client";

// Legacy file-viewer route. Brain now uses the shared Collection split pane.
// Old deep links redirect into /brain with the folder selected.
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function LegacyFileViewerRedirect() {
  const { name, path: pathParts } = useParams<{ name: string; path: string[] }>();
  const router = useRouter();

  useEffect(() => {
    const packName = decodeURIComponent(name);
    const filePath = Array.isArray(pathParts)
      ? pathParts.map(decodeURIComponent).join("/")
      : decodeURIComponent(pathParts);
    const params = new URLSearchParams();
    params.set("sel", packName);
    params.set("file", filePath);
    router.replace(`/brain?${params.toString()}`);
  }, [name, pathParts, router]);

  return null;
}
