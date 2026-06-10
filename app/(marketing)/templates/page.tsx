import type { Metadata } from "next";
import { TemplatesBrowser } from "@/components/landing-ref/TemplatesBrowser";
import { HeroPromptComposer } from "@/components/landing-ref/HeroPromptComposer";

export const metadata: Metadata = {
  title: "Templates — Workeros",
  description:
    "Browse ready-to-run AI workers by team. Pick one or describe a new one. Workeros hires the worker and runs the work.",
};

export default function TemplatesPage() {
  return (
    <main>
      {/* Header */}
      <section className="px-6 pt-16 pb-10 sm:pt-20">
        <div className="mx-auto max-w-6xl text-center">
          <div className="mb-3 inline-flex items-center justify-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-[#3a6ea5]">
            <span aria-hidden="true" className="h-px w-6 bg-[#3a6ea5]/30" />
            Templates
            <span aria-hidden="true" className="h-px w-6 bg-[#3a6ea5]/30" />
          </div>
          <h1 className="text-balance text-[32px] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[48px]">
            Pick a worker. Hire it. Done.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
            Ready-to-run workers for the recurring jobs your team already does. Each one connects
            to your tools and asks before anything ships.
          </p>
        </div>
      </section>

      {/* Browser */}
      <section className="px-6 pb-20">
        <div className="mx-auto max-w-6xl">
          <TemplatesBrowser />
        </div>
      </section>

      {/* Custom worker CTA */}
      <section className="border-t border-border/70 bg-secondary/40 px-6 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-3 inline-flex items-center justify-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-[#3a6ea5]">
            <span aria-hidden="true" className="h-px w-6 bg-[#3a6ea5]/30" />
            Don&apos;t see it?
            <span aria-hidden="true" className="h-px w-6 bg-[#3a6ea5]/30" />
          </div>
          <h2 className="text-balance text-[28px] font-semibold leading-[1.05] tracking-[-0.025em] text-foreground sm:text-[36px]">
            Describe a worker. Workeros builds it.
          </h2>
          <p className="mx-auto mt-4 max-w-md text-[15px] text-muted-foreground">
            If none of these fit, write the job the way you&apos;d brief a teammate.
          </p>
          <HeroPromptComposer />
        </div>
      </section>
    </main>
  );
}
