"use client";

// Legacy file-viewer route. The file viewer is now an in-place pane on the
// single-page /brain surface (no navigation). This route only exists so old
// deep links / shared "Copy link" URLs keep working: it redirects into
// /brain with the pack + file pre-selected.
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
    params.set("pack", packName);
    params.set("file", filePath);
    router.replace(`/brain?${params.toString()}`);
  }, [name, pathParts, router]);

  return null;
}
