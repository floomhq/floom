"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ART_CANDIDATES, type ArtKey } from "./art-candidates";

function isArtKey(s: string | null): s is ArtKey {
  return !!s && s in ART_CANDIDATES;
}

function ArtPickerInner() {
  const params = useSearchParams();
  const raw = params.get("bg");
  const current: ArtKey = isArtKey(raw) ? raw : "vg1";
  const keys = Object.keys(ART_CANDIDATES) as ArtKey[];

  return (
    <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-2xl border border-white/15 bg-black/55 px-2 py-2 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.5)] backdrop-blur-xl">
      <div className="mb-1.5 px-1 text-center text-[10px] uppercase tracking-[0.18em] text-white/55">
        Artwork
      </div>
      <div className="flex items-center gap-1.5">
        {keys.map((k) => {
          const art = ART_CANDIDATES[k];
          const active = k === current;
          return (
            <Link
              key={k}
              href={`/v4?bg=${k}`}
              title={`${art.label} · ${art.style}`}
              className={
                "relative h-12 w-16 overflow-hidden rounded-md border transition-all " +
                (active
                  ? "border-white ring-2 ring-white/30 scale-105"
                  : "border-white/20 opacity-70 hover:border-white/50 hover:opacity-100")
              }
            >
              <Image src={art.src} alt={art.label} fill sizes="64px" className="object-cover" />
            </Link>
          );
        })}
      </div>
      <div className="mt-1.5 px-1 text-center text-[10.5px] text-white/75">
        {ART_CANDIDATES[current].label}
        <span className="ml-1.5 text-white/40">· {ART_CANDIDATES[current].style}</span>
      </div>
    </div>
  );
}

export function ArtPicker() {
  return (
    <Suspense fallback={null}>
      <ArtPickerInner />
    </Suspense>
  );
}
