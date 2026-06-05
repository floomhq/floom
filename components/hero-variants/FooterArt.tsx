import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { ART_CANDIDATES, type ArtKey } from "./art-candidates";
import { FooterArtPickerWrapper } from "./FooterArtPickerWrapper";

const DEFAULT_FOOTER_ART: ArtKey = "mj3";

/**
 * FooterArt — artwork band + footer links. Used as the apex landing's
 * footer. Renders with a fixed artwork by default. Wrap with the picker
 * wrapper from /footer-demo if you need ?bg= query-param switching.
 */
export function FooterArt({ artKey = DEFAULT_FOOTER_ART }: { artKey?: ArtKey }) {
  return <FooterArtBody artKey={artKey} />;
}

/** Picker-aware wrapper for the /footer-demo route */
export function FooterArtDynamic() {
  return (
    <Suspense fallback={<FooterArtBody artKey={DEFAULT_FOOTER_ART} />}>
      <FooterArtPickerWrapper />
    </Suspense>
  );
}

export function FooterArtBody({ artKey }: { artKey: ArtKey }) {
  const art = ART_CANDIDATES[artKey];

  return (
    <section className="relative isolate overflow-hidden">
      {/* Artwork band: subtle, framed footer treatment */}
      <div className="relative isolate min-h-[420px] overflow-hidden border-t border-border/40">
        <Image
          src={art.src}
          alt=""
          aria-hidden="true"
          fill
          sizes="100vw"
          priority
          className="-z-30 object-cover"
          style={{ objectPosition: "center 35%" }}
        />
        {/* Dark scrim for footer-link legibility — graduated so the artwork
            stays visible up top and the footer text reads clearly below. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-20"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.10) 35%, rgba(0,0,0,0.55) 75%, rgba(0,0,0,0.78) 100%)",
          }}
        />

        {/* Footer content overlaid on the artwork */}
        <footer className="relative z-10 px-6 pb-12 pt-48">
          <div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <div className="flex items-center gap-2">
                <svg
                  width={22}
                  height={22}
                  viewBox="0 0 100 100"
                  role="img"
                  aria-label="Floom"
                  style={{ borderRadius: "22%" }}
                >
                  <rect width="100" height="100" rx="22" fill="#FAFAF7" fillOpacity="0.95" />
                  <path
                    d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
                    fill="#1a1a1a"
                  />
                </svg>
                <div className="flex items-baseline gap-1.5 text-[15px] font-semibold text-white">
                  Workeros
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/65">
                    by Floom
                  </span>
                </div>
              </div>
              <p className="mt-2 text-[11.5px] text-white/65">© 2026 Floom</p>
            </div>
            <FooterCol
              title="Product"
              items={[
                { label: "Templates", href: "/templates" },
                { label: "Sign in", href: "/login" },
                { label: "Marketing", href: "/marketing" },
                { label: "Sales", href: "/sales" },
              ]}
            />
            <FooterCol
              title="Resources"
              items={[
                { label: "Docs", href: "https://github.com/floomhq/workeros", external: true },
                { label: "GitHub", href: "https://github.com/floomhq/workeros", external: true },
                { label: "Floom Skills", href: "https://skills.floom.dev", external: true },
                { label: "Floom", href: "https://floom.dev", external: true },
              ]}
            />
            <FooterCol
              title="Company"
              items={[
                { label: "LinkedIn", href: "https://www.linkedin.com/company/floomhq/", external: true },
                { label: "X", href: "https://x.com/floomhq", external: true },
                { label: "Terms", href: "/terms" },
                { label: "Privacy", href: "/privacy" },
              ]}
            />
          </div>
          <div className="mx-auto mt-8 max-w-6xl text-[10px] uppercase tracking-[0.18em] text-white/40">
            Artwork: {art.label} · {art.style}
          </div>
        </footer>
      </div>
    </section>
  );
}

function FooterCol({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; href: string; external?: boolean }>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/65">{title}</h3>
      {items.map((l) =>
        l.external ? (
          <a
            key={l.label}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-white/85 hover:text-white"
          >
            {l.label}
          </a>
        ) : (
          <Link
            key={l.label}
            href={l.href}
            className="text-[13px] text-white/85 hover:text-white"
          >
            {l.label}
          </Link>
        ),
      )}
    </div>
  );
}

