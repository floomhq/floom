"use client";

import Link from "next/link";

type VariantId =
  | "v1"
  | "v2"
  | "v3"
  | "v3-mixed"
  | "v3-wall"
  | "v3-marquee"
  | "v4"
  | "footer-demo";

const VARIANTS: Array<{ id: VariantId; label: string; description: string }> = [
  { id: "v1", label: "V1 Cinematic", description: "Almanac-style. CSS atmospheric." },
  { id: "v2", label: "V2 Editorial", description: "Split layout. Employee badge artwork." },
  { id: "v3", label: "V3 Collage", description: "Uniform rectangular floating cards (Federico's base)." },
  { id: "v3-mixed", label: "V3 Mixed", description: "Polaroid + disk + pill + sticky (the weird mix)." },
  { id: "v3-wall", label: "V3 Wall", description: "Uniform circular avatars in a grid." },
  { id: "v3-marquee", label: "V3 Marquee", description: "Infinite-scroll worker chips." },
  { id: "v4", label: "V4 Art", description: "Real Imagen + Van Gogh + Midjourney art picker." },
  { id: "footer-demo", label: "Footer art", description: "Artwork as a subtle footer band." },
];

export function VariantPicker({ current }: { current: VariantId }) {
  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-card/90 px-1.5 py-1.5 shadow-[0_12px_40px_-8px_rgba(20,20,20,0.25)] backdrop-blur-xl">
      <div className="flex items-center gap-1">
        {VARIANTS.map((v) => {
          const isActive = current === v.id;
          return (
            <Link
              key={v.id}
              href={`/${v.id}`}
              title={v.description}
              className={
                isActive
                  ? "rounded-full bg-foreground px-3 py-1.5 text-[12px] font-medium text-background"
                  : "rounded-full px-3 py-1.5 text-[12px] font-medium text-foreground/70 transition hover:border-foreground/30 hover:bg-secondary/60"
              }
            >
              {v.label}
            </Link>
          );
        })}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <Link
          href="/"
          className="rounded-full px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition hover:border-foreground/30 hover:bg-secondary/60"
        >
          Current live
        </Link>
      </div>
    </div>
  );
}
