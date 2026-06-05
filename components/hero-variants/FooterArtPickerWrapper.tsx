"use client";

import { useSearchParams } from "next/navigation";
import { FooterArtBody } from "./FooterArt";
import { ART_CANDIDATES, type ArtKey } from "./art-candidates";

function isArtKey(s: string | null): s is ArtKey {
  return !!s && s in ART_CANDIDATES;
}

const DEFAULT_FOOTER_ART: ArtKey = "mj3";

export function FooterArtPickerWrapper() {
  const params = useSearchParams();
  const raw = params.get("bg");
  const artKey: ArtKey = isArtKey(raw) ? raw : DEFAULT_FOOTER_ART;
  return <FooterArtBody artKey={artKey} />;
}
