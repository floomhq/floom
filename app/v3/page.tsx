import type { Metadata } from "next";
import Image from "next/image";

import "./theme.css";

type Banner = {
  name: string;
  label: string;
  size: string;
  note: string;
  width: number;
  height: number;
};

const banners: Banner[] = [
  {
    name: "og-image-v3",
    label: "OG image",
    size: "1200 x 630",
    note: "Dark social card",
    width: 2400,
    height: 1260,
  },
  {
    name: "og-image-light-v3",
    label: "OG image light",
    size: "1200 x 630",
    note: "Light social card",
    width: 2400,
    height: 1260,
  },
  {
    name: "hero-banner-v3",
    label: "Hero banner",
    size: "1600 x 500",
    note: "Landing and README banner",
    width: 3200,
    height: 1000,
  },
  {
    name: "linkedin-banner-v3",
    label: "LinkedIn banner",
    size: "1584 x 396",
    note: "Personal cover",
    width: 3168,
    height: 792,
  },
  {
    name: "linkedin-company-v3",
    label: "LinkedIn company",
    size: "1128 x 191",
    note: "Company cover",
    width: 2256,
    height: 382,
  },
  {
    name: "time-is-life",
    label: "Time is life",
    size: "1584 x 396",
    note: "Personal cover",
    width: 3168,
    height: 792,
  },
];

export const metadata: Metadata = {
  title: "Floom marketing banners",
  description: "V3 marketing banners for Floom link previews, hero placements, and LinkedIn covers.",
};

export default function V3MarketingBannersPage() {
  return (
    <main className="theme-v3 min-h-screen bg-bg-app px-5 py-8 text-foreground sm:px-8 lg:px-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="flex flex-col gap-3 border-b border-border-default pb-7">
          <p className="text-sm text-muted-foreground">V3 marketing assets</p>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
                Floom marketing banners
              </h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
                Committed v3 PNG exports and SVG sources for link previews, hero placements, and
                LinkedIn surfaces.
              </p>
            </div>
            <a
              href="/marketing/og-image-v3.png"
              className="inline-flex h-10 w-fit items-center rounded-[var(--radius-button)] bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Open OG card
            </a>
          </div>
        </header>

        <section className="flex flex-col gap-10">
          {banners.map((banner) => {
            const pngPath = `/marketing/${banner.name}.png`;
            const svgPath = `/marketing/${banner.name}.svg`;

            return (
              <article key={banner.name} id={banner.name} className="scroll-mt-6 flex flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-base font-medium text-foreground">{banner.label}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {banner.name} - {banner.size} - {banner.note}
                    </p>
                  </div>
                  <div className="flex gap-3 text-sm">
                    <a className="text-[var(--v3-accent)] hover:underline" href={svgPath}>
                      SVG
                    </a>
                    <a className="text-[var(--v3-accent)] hover:underline" href={pngPath}>
                      PNG
                    </a>
                  </div>
                </div>
                <div className="overflow-hidden rounded-lg border border-border-default bg-card">
                  <Image
                    src={pngPath}
                    alt={`${banner.label} preview`}
                    width={banner.width}
                    height={banner.height}
                    sizes="(min-width: 1280px) 1184px, calc(100vw - 40px)"
                    loading="eager"
                    unoptimized
                    className="h-auto w-full"
                  />
                </div>
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}
