import type { Metadata } from "next";
import Link from "next/link";
import { V3Shell } from "@/app/v3/V3Shell";
import { IntegrationsCatalog } from "./IntegrationsCatalog";
import catalog from "./catalog.json";

export const metadata: Metadata = {
  title: "Integrations — Floom",
  description:
    "Connect Floom to 1,000+ tools — Slack, Gmail, Google Calendar, Notion, HubSpot, Salesforce, GitHub, Linear, and hundreds more.",
};

export default function IntegrationsPage() {
  return (
    <V3Shell active="integrations">
      <section className="pb-12 pt-16 sm:pt-20">
        <div>
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center rounded-full bg-[var(--v3-sel)] px-3 py-1 text-[12px] font-medium text-[var(--v3-accent)]">
              Connects to your tools
            </div>
            <h1 className="text-balance text-[38px] font-semibold leading-[1.04] tracking-[-0.03em] sm:text-[58px]">
              Workers plug into the stack your team already uses.
            </h1>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-[var(--text-muted)]">
              Floom connects to 1,000+ tools so a worker can read the right
              context, produce the output, and ask for approval where your team
              already works.
            </p>
          </div>
        </div>
      </section>

      <section className="pb-20">
        <IntegrationsCatalog catalog={catalog} />
      </section>

      <section className="bg-card/60 py-14">
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-[24px] font-semibold tracking-[-0.02em]">
              Bring one job. Connect only what it needs.
            </h2>
            <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted-foreground">
              Each worker gets scoped tools and approval gates. You can expand
              access later from the connections page.
            </p>
          </div>
          <Link
            href="/templates"
            className="inline-flex h-11 w-fit items-center rounded-[10px] px-5 text-[14px] font-medium text-white transition hover:-translate-y-px"
            style={{ background: "var(--v3-accent)" }}
          >
            Browse workers
          </Link>
        </div>
      </section>
    </V3Shell>
  );
}
